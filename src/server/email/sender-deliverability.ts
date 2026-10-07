import type { Db } from '../db.js';
import { defaultDnsResolver, evaluateDeliverability, type DnsResolver } from './deliverability.js';
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
 * The longest a request (GET /api/email/channel, plan compile) waits for DNS.
 * A healthy evaluation is a few sequential round trips (SPF include chain, at
 * most ten lookups, while DKIM and DMARC run beside it), well under a second;
 * five seconds also absorbs one retried query of the default resolver (2s
 * timeout, 2 tries). Past it the caller gets an `unknown`, rechecking answer.
 */
export const DELIVERABILITY_REQUEST_DEADLINE_MS = 5_000;
/**
 * The worker's whole refresh sweep. Its own loop never overlaps itself, so this
 * bounds how long one tick holds that loop and a drain waits on it; domains not
 * reached by then are still due and wait for the next tick.
 */
export const DELIVERABILITY_REFRESH_DEADLINE_MS = 60_000;
/**
 * One domain inside the worker sweep. Long enough for a slow but answering
 * resolver (several 2s-timeout retries); short enough that one domain whose DNS
 * never answers cannot eat the sweep and starve the domains behind it.
 */
export const DELIVERABILITY_DOMAIN_DEADLINE_MS = 15_000;

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

/** Evaluates within `deadlineMs`; past it, an unknown "rechecking" evaluation. */
async function evaluateWithin(
  input: { domain: string; provider: MailProvider },
  resolver: DnsResolver,
  deadlineMs: number
): Promise<{ evaluation: DeliverabilityEvaluation; timedOut: boolean }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadlineMs));
    timer.unref();
  });
  try {
    const evaluation = await Promise.race([
      evaluateDeliverability(input, boundedResolver(resolver, controller.signal)),
      timeout
    ]);
    return evaluation
      ? { evaluation, timedOut: false }
      : { evaluation: recheckingEvaluation(input, deadlineMs), timedOut: true };
  } finally {
    clearTimeout(timer);
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
    .get<CheckRow>(workspaceId, domain.trim().toLowerCase(), provider);
  return row ? fromRow(row) : null;
}

async function storeEvaluation(
  db: Db,
  workspaceId: string,
  evaluation: DeliverabilityEvaluation,
  now: Date,
  markOutreach: boolean
): Promise<StoredDeliverability> {
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
       RETURNING ${COLUMNS}`
    )
    .get<CheckRow>(
      workspaceId,
      evaluation.domain,
      evaluation.provider,
      evaluation.status,
      JSON.stringify(evaluation.spf),
      JSON.stringify(evaluation.dkim),
      JSON.stringify(evaluation.dmarc),
      JSON.stringify(evaluation.blockers),
      JSON.stringify(evaluation.warnings),
      now.toISOString(),
      new Date(now.getTime() + TTL_MS[evaluation.status]).toISOString(),
      markOutreach ? now.toISOString() : null
    );
  if (!row) throw new Error('Email deliverability result could not be stored.');
  return fromRow(row);
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
      `UPDATE email_deliverability_checks SET outreach_requested_at=?::timestamptz
       WHERE workspace_id=? AND domain=? AND provider=?`
    )
    .run(now.toISOString(), workspaceId, domain, provider);
}

/**
 * The deliverability of one sending domain, from cache while it is fresh.
 * `markOutreach` records that someone planned email outreach from this domain,
 * which is what makes the worker keep it fresh and Today surface a failure.
 *
 * Never waits on DNS longer than `deadlineMs`. On timeout a still-fresh cached
 * answer (a forced re-check) is returned unchanged; otherwise the answer is an
 * `unknown` "rechecking" result, stored like any DNS timeout so the worker
 * re-checks it.
 */
export async function getSenderDeliverability(
  db: Db,
  workspaceId: string,
  input: { domain: string; provider: MailProvider; markOutreach?: boolean; force?: boolean },
  options: DeliverabilityOptions = {}
): Promise<StoredDeliverability> {
  const now = options.now ?? new Date();
  const domain = input.domain.trim().toLowerCase();
  const cached = await readSenderDeliverability(db, workspaceId, domain, input.provider);
  const fresh = cached !== null && Date.parse(cached.expiresAt) > now.getTime();
  if (fresh && !input.force) {
    if (input.markOutreach) await markOutreachIntent(db, workspaceId, domain, input.provider, now);
    return cached;
  }
  const { evaluation, timedOut } = await evaluateWithin(
    { domain, provider: input.provider },
    options.resolver ?? defaultDnsResolver(),
    options.deadlineMs ?? DELIVERABILITY_REQUEST_DEADLINE_MS
  );
  if (timedOut && fresh) {
    if (input.markOutreach) await markOutreachIntent(db, workspaceId, domain, input.provider, now);
    return cached;
  }
  return storeEvaluation(db, workspaceId, evaluation, now, input.markOutreach === true);
}

/**
 * Worker sweep: prune checks nobody has looked at for 30 days, then re-check
 * expired domains that someone planned outreach from in the last 30 days.
 * Cross-workspace by design (it is the worker); every write is keyed by the
 * row's own workspace_id.
 *
 * Bounded twice: each domain gets at most `domainDeadlineMs` (past it the row
 * is stored `unknown`, which re-queues it behind fresher work), and the sweep
 * stops starting domains once `deadlineMs` has passed -- those stay due and are
 * picked up on the next tick.
 */
export async function refreshDueEmailDeliverability(
  db: Db,
  options: Omit<DeliverabilityOptions, 'deadlineMs'> & {
    deadlineMs?: number;
    domainDeadlineMs?: number;
  } = {}
): Promise<{ refreshed: number; pruned: number }> {
  const sweepDeadline = Date.now() + (options.deadlineMs ?? DELIVERABILITY_REFRESH_DEADLINE_MS);
  const domainDeadlineMs = options.domainDeadlineMs ?? DELIVERABILITY_DOMAIN_DEADLINE_MS;
  const now = options.now ?? new Date();
  const resolver = options.resolver ?? defaultDnsResolver();
  const pruned = await db
    .prepare('DELETE FROM email_deliverability_checks WHERE checked_at < ?::timestamptz')
    .run(new Date(now.getTime() - PRUNE_AFTER_MS).toISOString());
  const due = await db
    .prepare(
      `SELECT workspace_id,domain,provider FROM email_deliverability_checks
       WHERE expires_at <= ?::timestamptz AND outreach_requested_at >= ?::timestamptz
       ORDER BY expires_at ASC LIMIT ?`
    )
    .all<{ workspace_id: string; domain: string; provider: MailProvider }>(
      now.toISOString(),
      new Date(now.getTime() - OUTREACH_INTENT_WINDOW_MS).toISOString(),
      REFRESH_BATCH
    );
  let refreshed = 0;
  for (const row of due) {
    const remaining = sweepDeadline - Date.now();
    if (remaining <= 0) break;
    try {
      const { evaluation } = await evaluateWithin(
        { domain: row.domain, provider: row.provider },
        resolver,
        Math.min(domainDeadlineMs, remaining)
      );
      await storeEvaluation(db, row.workspace_id, evaluation, now, false);
      refreshed += 1;
    } catch (error) {
      console.error(
        'Email deliverability refresh failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { refreshed, pruned: pruned.changes };
}
