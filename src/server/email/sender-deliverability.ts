import type { Db } from '../db.js';
import { readDkimSelector } from './dkim-selector.js';
import {
  defaultDnsResolver,
  evaluateDeliverability,
  normalizeSenderDomain,
  type DnsResolver
} from './deliverability.js';
import type {
  DeliverabilityCheck,
  DeliverabilityEvaluation,
  DeliverabilityStatus,
  EmailChannelIssue,
  MailProvider,
  StoredDeliverability
} from './types.js';

const MINUTE = 60_000;
/**
 * How long one answer is trusted. A failure is re-checked soon so a DNS fix
 * unblocks planning within minutes; a pass is re-checked daily so a broken
 * record is noticed the next morning.
 */
const TTL_MS: Record<DeliverabilityStatus, number> = {
  pass: 24 * 60 * MINUTE,
  fail: 10 * MINUTE,
  unknown: 5 * MINUTE
};
const OUTREACH_INTENT_WINDOW_MS = 30 * 24 * 60 * MINUTE;
const PRUNE_AFTER_MS = 30 * 24 * 60 * MINUTE;
// lc-debt: at most 25 stale domains refreshed per worker cycle; upgrade path: shard the refresh by workspace once more than 25 sending domains go stale inside one cycle.
const REFRESH_BATCH = 25;
/**
 * How long a request (GET /api/email/channel, plan compile) waits for DNS
 * before answering. A healthy evaluation is a few sequential round trips (SPF
 * include chain, at most ten lookups, while DKIM and DMARC run beside it), well
 * under a second; five seconds also absorbs one retried query of the default
 * resolver (2s timeout, 2 tries). Past it the request answers with the fresh
 * cached row or an `unknown` "rechecking" one, but the evaluation is NOT
 * abandoned: it keeps running until DELIVERABILITY_DOMAIN_DEADLINE_MS from its
 * start and stores its answer when it arrives, so a slow domain does not read
 * `unknown` on every request.
 */
export const DELIVERABILITY_REQUEST_DEADLINE_MS = 5_000;
/**
 * The worker's whole refresh sweep. Its own loop never overlaps itself, so this
 * bounds how long one tick holds that loop; a domain is only started when a full
 * DELIVERABILITY_DOMAIN_DEADLINE_MS still fits, and the rest stay due for the
 * next tick.
 */
export const DELIVERABILITY_REFRESH_DEADLINE_MS = 60_000;
/**
 * One evaluation, from the request path or the sweep. Long enough for a slow but
 * answering resolver (several 2s-timeout retries); short enough that one domain
 * whose DNS never answers cannot eat the sweep and starve the domains behind it.
 * When it fires the result is `unknown`.
 */
export const DELIVERABILITY_DOMAIN_DEADLINE_MS = 15_000;
/**
 * Session advisory lock (two-key form, namespace + key) that makes the sweep
 * one per deployment: a replica that cannot take it skips the tick.
 */
export const DELIVERABILITY_SWEEP_LOCK = ['trevra-email-deliverability', 'refresh'] as const;

const COLUMNS =
  'domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,checked_at,expires_at';

interface CheckRow {
  domain: string;
  provider: MailProvider;
  status: DeliverabilityStatus;
  spf_json: DeliverabilityCheck;
  dkim_json: DeliverabilityCheck;
  dmarc_json: DeliverabilityCheck;
  blockers_json: EmailChannelIssue[] | null;
  warnings_json: EmailChannelIssue[] | null;
  checked_at: string;
  expires_at: string;
}

function fromRow(row: CheckRow): StoredDeliverability {
  return {
    domain: row.domain,
    provider: row.provider,
    status: row.status,
    spf: row.spf_json,
    dkim: row.dkim_json,
    dmarc: row.dmarc_json,
    blockers: row.blockers_json ?? [],
    warnings: row.warnings_json ?? [],
    checkedAt: new Date(row.checked_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

export interface DeliverabilityOptions {
  resolver?: DnsResolver;
  now?: Date;
  /** Overrides DELIVERABILITY_REQUEST_DEADLINE_MS (tests use a short one). */
  deadlineMs?: number;
  /** Overrides DELIVERABILITY_DOMAIN_DEADLINE_MS (tests use a short one). */
  domainDeadlineMs?: number;
}

/** The normalised domain, or a thrown error before an empty one reaches SQL. */
function requireDomain(domain: string): string {
  const normalized = normalizeSenderDomain(domain);
  if (!normalized) throw new Error('A sending domain is required.');
  return normalized;
}

function deadlineError(): Error {
  return Object.assign(new Error('The deliverability check ran out of time.'), {
    code: 'ETIMEOUT'
  });
}

/**
 * Refuses every query issued after `signal` aborts, so an evaluation that lost
 * its race stops walking DNS at its next lookup instead of finishing unseen.
 */
function boundedResolver(resolver: DnsResolver, signal: AbortSignal): DnsResolver {
  const guard =
    <T>(run: (name: string) => Promise<T>) =>
    async (name: string): Promise<T> => {
      if (signal.aborted) throw deadlineError();
      return run(name);
    };
  return {
    resolveTxt: guard((name) => resolver.resolveTxt(name)),
    ...(resolver.resolveA ? { resolveA: guard((name) => resolver.resolveA!(name)) } : {}),
    ...(resolver.resolveAaaa ? { resolveAaaa: guard((name) => resolver.resolveAaaa!(name)) } : {}),
    ...(resolver.resolveMx ? { resolveMx: guard((name) => resolver.resolveMx!(name)) } : {})
  };
}

/** What a check that ran out of time reports: unknown, which blocks and never passes. */
function recheckingEvaluation(
  input: { domain: string; provider: MailProvider },
  deadlineMs: number
): DeliverabilityEvaluation {
  const check: DeliverabilityCheck = {
    status: 'unknown',
    detail: `DNS did not answer within ${Math.max(1, Math.round(deadlineMs / 1000))}s; rechecking.`,
    record: null
  };
  return {
    domain: input.domain,
    provider: input.provider,
    status: 'unknown',
    spf: check,
    dkim: check,
    dmarc: check,
    blockers: [],
    warnings: []
  };
}

/** Resolves to null after `ms`; the timer never holds the process open. */
function sleepToNull(ms: number): { promise: Promise<null>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Evaluates within `deadlineMs`; past it, an unknown "rechecking" evaluation. */
async function evaluateWithin(
  input: { domain: string; provider: MailProvider; dkimSelector?: string | null },
  resolver: DnsResolver,
  deadlineMs: number
): Promise<{ evaluation: DeliverabilityEvaluation; timedOut: boolean }> {
  const controller = new AbortController();
  const timeout = sleepToNull(deadlineMs);
  try {
    const evaluation = await Promise.race([
      evaluateDeliverability(input, boundedResolver(resolver, controller.signal)),
      timeout.promise
    ]);
    return evaluation
      ? { evaluation, timedOut: false }
      : { evaluation: recheckingEvaluation(input, deadlineMs), timedOut: true };
  } finally {
    timeout.cancel();
    controller.abort();
  }
}

export async function readSenderDeliverability(
  db: Db,
  workspaceId: string,
  domain: string,
  provider: MailProvider
): Promise<StoredDeliverability | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM email_deliverability_checks
       WHERE workspace_id=? AND domain=? AND provider=?`
    )
    .get<CheckRow>(workspaceId, requireDomain(domain), provider);
  return row ? fromRow(row) : null;
}

async function markOutreachIntent(
  db: Db,
  workspaceId: string,
  domain: string,
  provider: MailProvider,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_deliverability_checks
       SET outreach_requested_at=GREATEST(COALESCE(outreach_requested_at,?::timestamptz),?::timestamptz)
       WHERE workspace_id=? AND domain=? AND provider=?`
    )
    .run(now.toISOString(), now.toISOString(), workspaceId, domain, provider);
}

/**
 * Stores one answer, checked at `checkedAt`, unless the row already holds a
 * newer one: checked_at never moves backwards, and a timed-out (unknown,
 * rechecking) answer never replaces a row that is still fresh at `checkedAt`.
 * When the row wins, it is returned as it stands (with outreach intent still
 * recorded), so a racing writer never turns into an error.
 */
async function storeEvaluation(
  db: Db,
  workspaceId: string,
  evaluation: DeliverabilityEvaluation,
  checkedAt: Date,
  options: { markOutreach: boolean; timedOut: boolean }
): Promise<StoredDeliverability> {
  const domain = requireDomain(evaluation.domain);
  const row = await db
    .prepare(
      `INSERT INTO email_deliverability_checks
         (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
          checked_at,expires_at,outreach_requested_at)
       VALUES (?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::timestamptz,?::timestamptz,?::timestamptz)
       ON CONFLICT (workspace_id,domain,provider) DO UPDATE SET
         status=excluded.status,spf_json=excluded.spf_json,dkim_json=excluded.dkim_json,
         dmarc_json=excluded.dmarc_json,blockers_json=excluded.blockers_json,
         warnings_json=excluded.warnings_json,checked_at=excluded.checked_at,
         expires_at=excluded.expires_at,
         outreach_requested_at=COALESCE(excluded.outreach_requested_at,email_deliverability_checks.outreach_requested_at)
       WHERE email_deliverability_checks.checked_at <= excluded.checked_at
         AND (NOT ?::boolean OR email_deliverability_checks.expires_at <= excluded.checked_at)
       RETURNING ${COLUMNS}`
    )
    .get<CheckRow>(
      workspaceId,
      domain,
      evaluation.provider,
      evaluation.status,
      JSON.stringify(evaluation.spf),
      JSON.stringify(evaluation.dkim),
      JSON.stringify(evaluation.dmarc),
      JSON.stringify(evaluation.blockers),
      JSON.stringify(evaluation.warnings),
      checkedAt.toISOString(),
      new Date(checkedAt.getTime() + TTL_MS[evaluation.status]).toISOString(),
      options.markOutreach ? checkedAt.toISOString() : null,
      options.timedOut
    );
  if (row) return fromRow(row);
  if (options.markOutreach)
    await markOutreachIntent(db, workspaceId, domain, evaluation.provider, checkedAt);
  const current = await readSenderDeliverability(db, workspaceId, domain, evaluation.provider);
  if (!current) throw new Error('Email deliverability result could not be stored.');
  return current;
}

/**
 * The deliverability of one sending domain, from cache while it is fresh.
 * `markOutreach` records that someone planned email outreach from this domain,
 * which is what makes the worker keep it fresh and Today surface a failure.
 *
 * Waits on DNS at most `deadlineMs`. Past it the answer is the fresh cached row
 * (a forced re-check) or an `unknown` "rechecking" row, and the evaluation goes
 * on in the background up to `domainDeadlineMs` from its start, storing its
 * answer if it arrives in time.
 */
export async function getSenderDeliverability(
  db: Db,
  workspaceId: string,
  input: { domain: string; provider: MailProvider; markOutreach?: boolean; force?: boolean },
  options: DeliverabilityOptions = {}
): Promise<StoredDeliverability> {
  const now = options.now ?? new Date();
  const domain = requireDomain(input.domain);
  const markOutreach = input.markOutreach === true;
  if (!input.force) {
    const cached = await readSenderDeliverability(db, workspaceId, domain, input.provider);
    if (cached && Date.parse(cached.expiresAt) > now.getTime()) {
      if (markOutreach) await markOutreachIntent(db, workspaceId, domain, input.provider, now);
      return cached;
    }
  }
  const requestDeadlineMs = options.deadlineMs ?? DELIVERABILITY_REQUEST_DEADLINE_MS;
  const dkimSelector = await readDkimSelector(db, workspaceId, domain);
  const running = evaluateWithin(
    { domain, provider: input.provider, dkimSelector },
    options.resolver ?? defaultDnsResolver(),
    options.domainDeadlineMs ?? DELIVERABILITY_DOMAIN_DEADLINE_MS
  );
  const wait = sleepToNull(requestDeadlineMs);
  const settled = await Promise.race([running, wait.promise]);
  wait.cancel();
  if (settled) {
    return storeEvaluation(db, workspaceId, settled.evaluation, now, {
      markOutreach,
      timedOut: settled.timedOut
    });
  }
  // The request stops waiting; the evaluation does not. Its answer lands
  // through the same conditional upsert, stamped with this request's start.
  void running
    .then(({ evaluation, timedOut }) =>
      timedOut
        ? undefined
        : storeEvaluation(db, workspaceId, evaluation, now, { markOutreach: false, timedOut })
    )
    .catch((error: unknown) =>
      console.error(
        'Background email deliverability check failed',
        error instanceof Error ? error.message : String(error)
      )
    );
  return storeEvaluation(
    db,
    workspaceId,
    recheckingEvaluation({ domain, provider: input.provider }, requestDeadlineMs),
    now,
    { markOutreach, timedOut: true }
  );
}

export interface RefreshOptions {
  resolver?: DnsResolver;
  /** A fixed clock (tests); otherwise `clock`, otherwise the wall clock. */
  now?: Date;
  clock?: () => Date;
  /** Overrides DELIVERABILITY_REFRESH_DEADLINE_MS. */
  deadlineMs?: number;
  /** Overrides DELIVERABILITY_DOMAIN_DEADLINE_MS. */
  domainDeadlineMs?: number;
  /** Checked before each domain and before each write; true means drain now. */
  shouldStop?: () => boolean;
}

/**
 * Worker sweep: prune checks nobody has looked at for 30 days, then re-check
 * expired domains that someone planned outreach from in the last 30 days.
 * Cross-workspace by design (it is the worker); every write is keyed by the
 * row's own workspace_id.
 *
 * One sweep per deployment (DELIVERABILITY_SWEEP_LOCK, try-lock: a replica that
 * misses it returns at once). Rows are not leased by moving expires_at, which
 * would make them read as fresh to the request path. A domain is started only
 * when a whole domain deadline still fits in the sweep budget; one whose own
 * deadline fires is stored `unknown` (re-queued behind fresher work). Each
 * domain is stamped with the clock at its own start.
 */
export async function refreshDueEmailDeliverability(
  db: Db,
  options: RefreshOptions = {}
): Promise<{ refreshed: number; pruned: number }> {
  const sweepDeadline = Date.now() + (options.deadlineMs ?? DELIVERABILITY_REFRESH_DEADLINE_MS);
  const domainDeadlineMs = options.domainDeadlineMs ?? DELIVERABILITY_DOMAIN_DEADLINE_MS;
  const fixed = options.now;
  const clock = fixed ? () => fixed : (options.clock ?? (() => new Date()));
  const resolver = options.resolver ?? defaultDnsResolver();
  const shouldStop = options.shouldStop ?? (() => false);
  const [namespace, key] = DELIVERABILITY_SWEEP_LOCK;
  return db.withConnection(
    'email-deliverability-sweep',
    async (lease) => {
      const claimed = await lease.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
        [namespace, key]
      );
      if (!claimed.rows[0]?.locked) return { refreshed: 0, pruned: 0 };
      try {
        const start = clock();
        const pruned = await db
          .prepare('DELETE FROM email_deliverability_checks WHERE checked_at < ?::timestamptz')
          .run(new Date(start.getTime() - PRUNE_AFTER_MS).toISOString());
        const due = await db
          .prepare(
            `SELECT workspace_id,domain,provider FROM email_deliverability_checks
             WHERE expires_at <= ?::timestamptz AND outreach_requested_at >= ?::timestamptz
             ORDER BY expires_at ASC LIMIT ?`
          )
          .all<{ workspace_id: string; domain: string; provider: MailProvider }>(
            start.toISOString(),
            new Date(start.getTime() - OUTREACH_INTENT_WINDOW_MS).toISOString(),
            REFRESH_BATCH
          );
        let refreshed = 0;
        for (const row of due) {
          if (shouldStop()) break;
          // Not started unless a whole domain deadline fits: a domain cut off by
          // the sweep budget would be stored `unknown` for no reason of its own.
          if (sweepDeadline - Date.now() < domainDeadlineMs) break;
          const checkedAt = clock();
          try {
            const dkimSelector = await readDkimSelector(db, row.workspace_id, row.domain);
            const { evaluation, timedOut } = await evaluateWithin(
              { domain: row.domain, provider: row.provider, dkimSelector },
              resolver,
              domainDeadlineMs
            );
            if (shouldStop()) break;
            await storeEvaluation(db, row.workspace_id, evaluation, checkedAt, {
              markOutreach: false,
              timedOut
            });
            refreshed += 1;
          } catch (error) {
            console.error(
              'Email deliverability refresh failed',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
        return { refreshed, pruned: pruned.changes };
      } finally {
        await lease
          .query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [namespace, key])
          .catch(() => undefined);
      }
    },
    (options.deadlineMs ?? DELIVERABILITY_REFRESH_DEADLINE_MS) + 5_000
  );
}
