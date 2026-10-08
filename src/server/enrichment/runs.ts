import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { resolveContact, resolveExplicitAccount } from '../lead-capture/people.js';
import { LeadCaptureError } from '../lead-capture/types.js';
import { readWorkspaceSecretPlaintext, workspaceSecretSeal } from '../secrets/store.js';
import { findSuppression } from '../suppressions.js';
import { createHunterProvider } from './hunter.js';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  roundCredits,
  type ContactEnrichmentProvider,
  type DomainSearchResult,
  type EnrichmentProviderId
} from './provider.js';
import {
  EnrichmentError,
  enrichmentUsage,
  getEnrichmentSettings,
  setEnrichmentKeyStatus
} from './settings.js';

/**
 * Approved enrichment runs: the only code that spends a workspace's Hunter
 * credits, and the only reader of the 'hunter_api_key' plaintext.
 *
 * Two invariants, both enforced here and nowhere else:
 *  1. CAP. A run is queued only under the `${workspaceId}:enrichment-cap`
 *     advisory lock, after re-checking that this month's charges plus every
 *     open run's unspent estimate plus this estimate fit the cap. Concurrent
 *     or duplicate approvals therefore cannot both reserve the same credits.
 *     Before every paid call the cap is re-read, and the call's MAXIMUM price
 *     must fit under `cap - charged this month - other open runs' reservations`,
 *     so lowering the cap stops queued and running runs.
 *  2. ESTIMATE. Before every paid call the run checks that its own ledger
 *     total plus that call's maximum price stays within the approved estimate,
 *     so a run never starts a call its plan did not pay for. A provider that
 *     over-delivers is still charged in full and the run stops before its next
 *     paid call.
 * Every paid call is charged to the append-only usage ledger immediately after
 * each call, with the credits the provider reported (never clamped), at the
 * wall-clock time of the charge (so a run crossing midnight UTC on the 1st
 * books later calls to the new month). Every paid call is also preceded by a
 * lease heartbeat fenced on `attempts`: a replica that re-claimed the run after
 * an expired lease bumped `attempts`, so the older copy stops instead of
 * spending twice. Before every paid call the run also checks that the key it
 * read is still the stored one; a removed or replaced key stops it.
 *
 * RESUME. A charged Domain Search's usable candidates are checkpointed in
 * `progress_json.pending` with the next candidate index, so a run released by
 * a drain or a rate limit resumes mid-domain without paying for the search
 * again. `pending` is cleared at the domain checkpoint and when the run
 * finishes, so no contact data lingers in the run row.
 */
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60 * 1000;
const RETENTION_MONTHS = 13;

export interface EnrichmentRunSummary {
  id: string;
  provider: EnrichmentProviderId;
  status: 'queued' | 'running' | 'completed' | 'failed';
  domainCount: number;
  emailsPerDomain: number;
  includeUnverified: boolean;
  estimatedCredits: number;
  createdAt: string;
}

interface RunRow {
  id: string;
  workspace_id: string;
  plan_hash: string;
  domains: string[];
  emails_per_domain: number;
  include_unverified: boolean;
  estimated_credits: string;
  status: string;
  attempts: number;
  progress_json: unknown;
  created_at: string;
}

/** Only what saving needs: sourced, on-domain candidates of a charged search. */
interface PendingCandidate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  sourceUri: string;
}

interface PendingDomain {
  domainIndex: number;
  next: number;
  candidates: PendingCandidate[];
}

interface RunProgress {
  doneDomains: number;
  saved: number;
  skipped: number;
  /** Companies Hunter refused to search (a 400 for that domain); uncharged, not retried. */
  skippedDomains?: number;
  pending?: PendingDomain;
}

/** Content-free reason codes recorded on `enrichment_run.failed` events. */
type FailureReason =
  | 'estimate_reached'
  | 'cap_reached'
  | 'key_removed'
  | 'key_invalid'
  | 'quota_exhausted'
  | 'rejected';

class BudgetReached extends Error {
  constructor(readonly reason: 'estimate_reached' | 'cap_reached') {
    super(reason);
  }
}
/** Another replica re-claimed this run, or the row vanished; stop without writing. */
class LeaseLost extends Error {}
/** The worker is draining; hand the run back to the queue. */
class Draining extends Error {}
/** The key this run read was deleted or replaced. */
class KeyChanged extends Error {
  constructor(readonly removed: boolean) {
    super(removed ? 'key_removed' : 'key_replaced');
  }
}

/**
 * Every `last_error` the runner writes, keyed by what happened. Fixed,
 * plain-language strings only: never a provider message, response body or key.
 * The runs list shows a stored error only when it is one of these
 * (enrichmentRunErrorMessage).
 */
export const RUN_ERROR_MESSAGES = {
  estimate_reached: 'Stopped before exceeding the approved credit estimate.',
  cap_reached: "Stopped at this month's Hunter credit cap.",
  key_removed: 'The Hunter key was removed before this run finished.',
  key_replaced: 'The Hunter key was replaced before this run finished. Re-plan to use the new key.',
  key_invalid: 'Hunter rejected the saved key. Replace it and re-plan.',
  quota_exhausted: 'The Hunter account has no credits left this period.',
  rejected: 'Hunter refused a request this run needed. Re-plan to try again.',
  attempts_exhausted: `Stopped after ${MAX_ATTEMPTS} attempts.`,
  rate_limited: 'Paused by a Hunter rate limit; it resumes automatically.',
  unavailable: 'Paused because Hunter could not be reached; it resumes automatically.',
  drained: 'Paused while the worker restarted; it resumes automatically.',
  unexpected: 'Unexpected error; the run will be retried.'
} as const;

/** Shown for a stored error that is not one of RUN_ERROR_MESSAGES. */
export const UNKNOWN_RUN_ERROR = 'The run stopped on an unexpected error.';

const KNOWN_RUN_ERRORS: ReadonlySet<string> = new Set(Object.values(RUN_ERROR_MESSAGES));

/** The one mapping from a run's stored `last_error` to what a person is shown. */
export function enrichmentRunErrorMessage(lastError: string | null): string | null {
  if (!lastError) return null;
  return KNOWN_RUN_ERRORS.has(lastError) ? lastError : UNKNOWN_RUN_ERROR;
}

const BUDGET_MESSAGES: Record<BudgetReached['reason'], string> = {
  estimate_reached: RUN_ERROR_MESSAGES.estimate_reached,
  cap_reached: RUN_ERROR_MESSAGES.cap_reached
};

function summarize(row: RunRow): EnrichmentRunSummary {
  return {
    id: row.id,
    provider: 'hunter',
    status: row.status as EnrichmentRunSummary['status'],
    domainCount: row.domains.length,
    emailsPerDomain: Number(row.emails_per_domain),
    includeUnverified: Boolean(row.include_unverified),
    estimatedCredits: Number(row.estimated_credits),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function readPending(value: unknown): PendingDomain | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PendingDomain>;
  if (!Array.isArray(raw.candidates)) return undefined;
  const text = (field: unknown) => (typeof field === 'string' && field ? field : null);
  const candidates: PendingCandidate[] = [];
  for (const item of raw.candidates as unknown as Array<Record<string, unknown>>) {
    const email = text(item?.email);
    const sourceUri = text(item?.sourceUri);
    if (!email || !sourceUri) continue;
    candidates.push({
      email,
      firstName: text(item.firstName),
      lastName: text(item.lastName),
      position: text(item.position),
      sourceUri
    });
  }
  return {
    domainIndex: Number(raw.domainIndex ?? -1),
    next: Number(raw.next ?? 0) || 0,
    candidates
  };
}

function readProgress(value: unknown): RunProgress {
  const raw = (
    typeof value === 'string' ? JSON.parse(value) : value
  ) as Partial<RunProgress> | null;
  const pending = readPending(raw?.pending);
  const skippedDomains = Number(raw?.skippedDomains ?? 0) || 0;
  return {
    doneDomains: Number(raw?.doneDomains ?? 0) || 0,
    saved: Number(raw?.saved ?? 0) || 0,
    skipped: Number(raw?.skipped ?? 0) || 0,
    ...(skippedDomains > 0 ? { skippedDomains } : {}),
    ...(pending ? { pending } : {})
  };
}

/** The counts a finished run keeps; never the pending candidates. */
function finishedProgress(progress: RunProgress): RunProgress {
  return {
    doneDomains: progress.doneDomains,
    saved: progress.saved,
    skipped: progress.skipped,
    ...(progress.skippedDomains ? { skippedDomains: progress.skippedDomains } : {})
  };
}

/** What the Contact enrichment panel shows for one run: counts and spend only. */
export interface EnrichmentRunView {
  id: string;
  status: EnrichmentRunSummary['status'];
  /** Plain language from RUN_ERROR_MESSAGES, never raw provider text. */
  error: string | null;
  domainsDone: number;
  domainCount: number;
  contactsSaved: number;
  creditsSpent: number;
  estimatedCredits: number;
  createdAt: string;
  finishedAt: string | null;
}

/** The workspace's most recent runs, newest first, with each run's ledger spend. */
export async function listEnrichmentRuns(
  db: Db,
  workspaceId: string,
  limit = 10
): Promise<EnrichmentRunView[]> {
  // lc-debt: no (workspace_id, created_at) index on enrichment_runs, so this
  // scans the workspace's rows (bounded by 13-month retention); add the index
  // in a migration if a workspace accumulates thousands of runs.
  const rows = await db
    .prepare(
      `SELECT r.id, r.status, r.last_error, cardinality(r.domains) AS domain_count,
              r.estimated_credits, r.progress_json, r.created_at, r.finished_at,
              COALESCE(spent.total, 0) AS spent
       FROM enrichment_runs r
       LEFT JOIN LATERAL (
         SELECT SUM(l.credits) AS total FROM enrichment_usage_ledger l
         WHERE l.workspace_id=r.workspace_id AND l.run_id=r.id
       ) spent ON TRUE
       WHERE r.workspace_id=?
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`
    )
    .all<{
      id: string;
      status: string;
      last_error: string | null;
      domain_count: number;
      estimated_credits: string;
      progress_json: unknown;
      created_at: string;
      finished_at: string | null;
      spent: string;
    }>(workspaceId, Math.max(1, Math.min(limit, 50)));
  return rows.map((row) => {
    const progress = readProgress(row.progress_json);
    return {
      id: row.id,
      status: row.status as EnrichmentRunView['status'],
      error: enrichmentRunErrorMessage(row.last_error),
      domainsDone: progress.doneDomains,
      domainCount: Number(row.domain_count),
      contactsSaved: progress.saved,
      creditsSpent: roundCredits(Number(row.spent)),
      estimatedCredits: Number(row.estimated_credits),
      createdAt: new Date(String(row.created_at)).toISOString(),
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null
    };
  });
}

export async function findEnrichmentRunByKey(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<{ run: EnrichmentRunSummary; planHash: string } | null> {
  const row = await db
    .prepare('SELECT * FROM enrichment_runs WHERE workspace_id=? AND idempotency_key=?')
    .get<RunRow>(workspaceId, idempotencyKey);
  return row ? { run: summarize(row), planHash: row.plan_hash } : null;
}

export async function queueEnrichmentRun(
  db: Db,
  input: {
    workspaceId: string;
    /** The approver's real actor type, recorded on the approval event. */
    actorType: 'user' | 'agent';
    actorUserId: string;
    idempotencyKey: string;
    planHash: string;
    domains: string[];
    emailsPerDomain: number;
    includeUnverified: boolean;
    estimatedCredits: number;
  },
  now: Date = new Date()
): Promise<{ run: EnrichmentRunSummary; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    // Serialises every approval in this workspace: the cap re-check below and
    // the insert that reserves the estimate commit together.
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
      .get(`${input.workspaceId}:enrichment-cap`);
    const existing = await tx
      .prepare('SELECT * FROM enrichment_runs WHERE workspace_id=? AND idempotency_key=?')
      .get<RunRow>(input.workspaceId, input.idempotencyKey);
    if (existing) {
      if (existing.plan_hash !== input.planHash) {
        throw new EnrichmentError(
          'This idempotency key was already used for a different enrichment plan.',
          409
        );
      }
      return { run: summarize(existing), duplicate: true };
    }
    const settings = await getEnrichmentSettings(tx, input.workspaceId);
    const usage = await enrichmentUsage(tx, input.workspaceId, now);
    if (
      settings.monthlyCreditCap <= 0 ||
      roundCredits(settings.monthlyCreditCap - usage.usedCredits) < input.estimatedCredits
    ) {
      throw new EnrichmentError(
        "This plan no longer fits under this month's Hunter credit cap. Re-plan to see what remains.",
        409
      );
    }
    const row = await tx
      .prepare(
        `INSERT INTO enrichment_runs
           (id,workspace_id,provider,idempotency_key,plan_hash,actor_user_id,domains,
            emails_per_domain,include_unverified,estimated_credits,status,created_at)
         VALUES (?,?,'hunter',?,?,?,?,?,?,?,'queued',?)
         RETURNING *`
      )
      .get<RunRow>(
        id('enr'),
        input.workspaceId,
        input.idempotencyKey,
        input.planHash,
        input.actorUserId,
        input.domains,
        input.emailsPerDomain,
        input.includeUnverified,
        input.estimatedCredits,
        now.toISOString()
      );
    if (!row) throw new Error('Enrichment run could not be queued');
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'enrichment_run',
      streamId: row.id,
      eventType: 'enrichment_run.approved',
      actorType: input.actorType,
      actorId: input.actorUserId,
      payload: {
        provider: 'hunter',
        domains: input.domains.length,
        emailsPerDomain: input.emailsPerDomain,
        includeUnverified: input.includeUnverified,
        estimatedCredits: input.estimatedCredits
      },
      occurredAt: now
    });
    return { run: summarize(row), duplicate: false };
  });
}

export interface RunQueuedEnrichmentOptions {
  now?: Date;
  /**
   * The time of each charge and cap check. Defaults to `now` advanced by the
   * wall clock, so tests that pin `now` stay deterministic while a long run's
   * charges still land in the month they happened.
   */
  clock?: () => Date;
  providerFor?: (apiKey: string) => ContactEnrichmentProvider;
  limit?: number;
  /** Checked before every claim and every paid call; true hands the run back to the queue. */
  shouldStop?: () => boolean;
}

export async function runQueuedEnrichmentRuns(
  db: Db,
  options: RunQueuedEnrichmentOptions = {}
): Promise<{ processed: number }> {
  const now = options.now ?? new Date();
  const startedWall = Date.now();
  const clock = options.clock ?? (() => new Date(now.getTime() + (Date.now() - startedWall)));
  const providerFor = options.providerFor ?? ((apiKey: string) => createHunterProvider(apiKey));
  const shouldStop = options.shouldStop ?? (() => false);
  await pruneEnrichmentHistory(db, now);
  await failExhaustedRuns(db, now);
  let processed = 0;
  // lc-debt: one run per tick per replica, on the worker's own enrichment
  // loop (src/worker/index.ts), so a long run never holds the control-plane
  // cycle. A deep queue drains slowly; raise `limit` or move runs to a
  // Temporal activity when queues form.
  for (let index = 0; index < (options.limit ?? 1); index += 1) {
    if (shouldStop()) break;
    const run = await claimRun(db, now);
    if (!run) break;
    await executeRun(db, run, providerFor, shouldStop, clock);
    processed += 1;
  }
  return { processed };
}

async function claimRun(db: Db, now: Date): Promise<RunRow | null> {
  const row = await db
    .prepare(
      `UPDATE enrichment_runs
         SET status='running', attempts=attempts+1, lease_until=?::timestamptz,
             started_at=COALESCE(started_at, ?::timestamptz)
       WHERE id = (
         SELECT id FROM enrichment_runs
         WHERE attempts < ?
           AND (status='queued' OR (status='running' AND lease_until < ?::timestamptz))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    )
    .get<RunRow>(
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      MAX_ATTEMPTS,
      now.toISOString()
    );
  return row ?? null;
}

async function failExhaustedRuns(db: Db, now: Date): Promise<void> {
  // One transaction: a failed row and its event commit together.
  await db.transaction(async (tx) => {
    const rows = await tx
      .prepare(
        `UPDATE enrichment_runs
           SET status='failed', last_error=?, finished_at=?::timestamptz,
               lease_until=NULL, progress_json=progress_json - 'pending'
         WHERE attempts >= ?
           AND (status='queued' OR (status='running' AND lease_until < ?::timestamptz))
         RETURNING id, workspace_id`
      )
      .all<{ id: string; workspace_id: string }>(
        RUN_ERROR_MESSAGES.attempts_exhausted,
        now.toISOString(),
        MAX_ATTEMPTS,
        now.toISOString()
      );
    for (const row of rows) {
      await appendDomainEvent(tx, {
        workspaceId: row.workspace_id,
        streamType: 'enrichment_run',
        streamId: row.id,
        eventType: 'enrichment_run.failed',
        actorType: 'system',
        payload: { reason: 'attempts_exhausted' },
        occurredAt: now
      });
    }
  });
}

async function spentOnRun(db: Db, workspaceId: string, runId: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(SUM(credits),0) AS total FROM enrichment_usage_ledger WHERE workspace_id=? AND run_id=?'
    )
    .get<{ total: string }>(workspaceId, runId);
  return roundCredits(Number(row?.total ?? 0));
}

async function runStillExists(db: Db, run: RunRow): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM enrichment_runs WHERE id=? AND workspace_id=?')
    .get<{ id: string }>(run.id, run.workspace_id);
  return Boolean(row);
}

/** Marks the key invalid only while the key this run used is still the stored one. */
async function markKeyInvalid(db: Db, workspaceId: string, seal: string, at: Date) {
  await db.transaction(async (tx) => {
    // FOR SHARE waits out a concurrent replacement and returns the new sealing,
    // so a key sealed meanwhile (and marked valid in its own transaction) wins.
    const current = await workspaceSecretSeal(tx, workspaceId, 'hunter_api_key', {
      lock: 'share'
    });
    if (current === seal) await setEnrichmentKeyStatus(tx, workspaceId, 'invalid', at);
  });
}

function emailOnDomain(email: string, domain: string): boolean {
  const host = email.split('@')[1] ?? '';
  return host === domain || host.endsWith(`.${domain}`);
}

/** True only when this call created the Person or linked it to the Account. */
async function saveCandidate(
  db: Db,
  workspaceId: string,
  domain: string,
  candidate: PendingCandidate,
  confidence: 'verified' | 'inferred',
  at: Date
): Promise<boolean> {
  // An inferred address stays in contacts.email, labelled only by
  // account_contacts.confidence='inferred'. That is safe because outreach reads
  // recipients only from lead-list members, and an enrichment-created Person has
  // no LinkedIn or phone identity, so it reaches a lead list only through an
  // import that supplies this same address explicitly. No lawful basis is
  // written: the founder records one.
  try {
    return await db.transaction(async (tx) => {
      const resolved = await resolveContact(
        tx,
        workspaceId,
        {
          name: [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || null,
          email: candidate.email,
          role: candidate.position
        },
        at
      );
      const linked = await resolveExplicitAccount(
        tx,
        workspaceId,
        resolved.contact.id,
        {
          domain,
          role: candidate.position,
          source: 'enrichment',
          confidence,
          sourceDetail: `hunter ${candidate.sourceUri}`.slice(0, 600)
        },
        at
      );
      // An inferred link upgraded to verified is a newly verified contact.
      return linked?.linked === true || linked?.upgraded === true || resolved.created;
    });
  } catch (error) {
    // Two existing People claim this identity: leave it for review, never merge.
    if (error instanceof LeadCaptureError) return false;
    throw error;
  }
}

async function finishRun(
  db: Db,
  run: RunRow,
  outcome: {
    status: 'completed' | 'failed';
    error: string | null;
    reason?: FailureReason;
    progress: RunProgress;
    spent: number;
  },
  at: Date
): Promise<void> {
  const progress = finishedProgress(outcome.progress);
  await db.transaction(async (tx) => {
    // Fenced like the heartbeat: a copy that lost its lease, or whose row was
    // erased, finishes nothing.
    const finished = await tx
      .prepare(
        `UPDATE enrichment_runs
           SET status=?, last_error=?, finished_at=?::timestamptz, lease_until=NULL, progress_json=?::jsonb
         WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
         RETURNING id`
      )
      .get<{ id: string }>(
        outcome.status,
        outcome.error,
        at.toISOString(),
        JSON.stringify(progress),
        run.id,
        run.workspace_id,
        run.attempts
      );
    if (!finished) return;
    await appendDomainEvent(tx, {
      workspaceId: run.workspace_id,
      streamType: 'enrichment_run',
      streamId: run.id,
      eventType: `enrichment_run.${outcome.status}`,
      actorType: 'system',
      payload: {
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        domainsDone: progress.doneDomains,
        saved: progress.saved,
        skipped: progress.skipped,
        skippedDomains: progress.skippedDomains ?? 0,
        creditsSpent: outcome.spent
      },
      occurredAt: at
    });
  });
}

/**
 * Back to the queue after a rate limit or an unexpected error; the attempt
 * counts. Fenced so a stale copy cannot release a run another replica holds.
 */
async function releaseRun(
  db: Db,
  run: RunRow,
  reason: (typeof RUN_ERROR_MESSAGES)[keyof typeof RUN_ERROR_MESSAGES]
): Promise<void> {
  await db
    .prepare(
      `UPDATE enrichment_runs SET status='queued', lease_until=NULL, last_error=?
       WHERE id=? AND workspace_id=? AND status='running' AND attempts=?`
    )
    .run(reason, run.id, run.workspace_id, run.attempts);
}

/**
 * Back to the queue on a worker drain, returning the attempt: a deploy is not
 * the run's fault. The fence still holds. Only the copy holding `attempts=N`
 * can lower it to N-1, and it stops right after. The next claim raises it to N
 * again, so no older copy (which holds a value below N) can match a running
 * row afterwards.
 */
async function releaseDrainedRun(db: Db, run: RunRow): Promise<void> {
  await db
    .prepare(
      `UPDATE enrichment_runs
         SET status='queued', lease_until=NULL, attempts=attempts-1, last_error=?
       WHERE id=? AND workspace_id=? AND status='running' AND attempts=?`
    )
    .run(RUN_ERROR_MESSAGES.drained, run.id, run.workspace_id, run.attempts);
}

/**
 * A content-free stand-in for an unexpected error: a database error's message
 * or detail can quote a contact's email. It keeps the error name, the pg
 * code/constraint/table/routine (schema names only) and the stack frames.
 */
function contentFreeError(run: RunRow, error: unknown): Error {
  const fields = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const parts = [`code ${typeof fields.code === 'string' ? fields.code : 'none'}`];
  for (const name of ['constraint', 'table', 'routine'] as const) {
    const value = fields[name];
    if (typeof value === 'string' && value) parts.push(`${name} ${value}`);
  }
  const message = `Enrichment run ${run.id} stopped on an unexpected ${
    error instanceof Error ? error.name : 'error'
  } (${parts.join(', ')}); it will be retried.`;
  const wrapped = new Error(message);
  // Frames only: the first stack line(s) repeat the original message.
  const frames =
    error instanceof Error && error.stack
      ? error.stack.split('\n').filter((line) => /^\s+at /.test(line))
      : [];
  if (frames.length > 0) wrapped.stack = [`Error: ${message}`, ...frames].join('\n');
  return wrapped;
}

async function executeRun(
  db: Db,
  run: RunRow,
  providerFor: (apiKey: string) => ContactEnrichmentProvider,
  shouldStop: () => boolean,
  clock: () => Date
): Promise<void> {
  const workspaceId = run.workspace_id;
  const progress = readProgress(run.progress_json);
  const estimate = Number(run.estimated_credits);
  const limit = Number(run.emails_per_domain);
  let spent = 0;
  let seal: string | null = null;
  const leaseUntil = () => new Date(clock().getTime() + LEASE_MS).toISOString();
  // Before every paid call. claimRun bumps `attempts`, so if another replica
  // re-claimed this run after an expired lease, this copy's fence fails and it
  // stops before spending. A row erased with its workspace fails it too.
  const heartbeat = async () => {
    const held = await db
      .prepare(
        `UPDATE enrichment_runs SET lease_until=?::timestamptz
         WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
         RETURNING id`
      )
      .get<{ id: string }>(leaseUntil(), run.id, workspaceId, run.attempts);
    if (!held) throw new LeaseLost();
  };
  // Persists progress (including the pending candidates), fenced the same way.
  const checkpoint = async () => {
    const saved = await db
      .prepare(
        `UPDATE enrichment_runs SET progress_json=?::jsonb, lease_until=?::timestamptz
         WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
         RETURNING id`
      )
      .get<{ id: string }>(
        JSON.stringify(progress),
        leaseUntil(),
        run.id,
        workspaceId,
        run.attempts
      );
    if (!saved) throw new LeaseLost();
  };
  // Both budgets must cover the call's MAXIMUM price, re-read from the DB
  // every time so a lowered cap stops the run before its next call.
  const beforePaidCall = async (maxCredits: number) => {
    if (shouldStop()) throw new Draining();
    const current = await workspaceSecretSeal(db, workspaceId, 'hunter_api_key');
    if (current !== seal) throw new KeyChanged(current === null);
    // Re-read, not the running total: a stalled copy's late charge for this run
    // (written after this copy claimed it) must count against the estimate.
    spent = await spentOnRun(db, workspaceId, run.id);
    if (roundCredits(estimate - spent) < maxCredits) throw new BudgetReached('estimate_reached');
    const settings = await getEnrichmentSettings(db, workspaceId);
    const usage = await enrichmentUsage(db, workspaceId, clock(), { excludeRunId: run.id });
    if (roundCredits(settings.monthlyCreditCap - usage.usedCredits) < maxCredits) {
      throw new BudgetReached('cap_reached');
    }
    await heartbeat();
  };
  // lc-debt: charged immediately after each call, so a hard kill between
  // Hunter's response and this insert loses that one call's charge (and a kill
  // before the next checkpoint repeats that call on resume); upgrade to
  // reserve-then-settle ledger rows written before the call.
  const charge = async (operation: 'domain_search' | 'email_verifier', credits: number) => {
    if (credits <= 0) return;
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
         VALUES (?,?,?,'hunter',?,?,?::timestamptz)`
      )
      .run(id('enl'), workspaceId, run.id, operation, credits, clock().toISOString());
    spent = roundCredits(spent + credits);
  };
  const fail = (error: string, reason: FailureReason) =>
    finishRun(db, run, { status: 'failed', error, reason, progress, spent }, clock());

  try {
    spent = await spentOnRun(db, workspaceId, run.id);
    // Read the seal BEFORE the plaintext: if the key is replaced in between,
    // the fence mismatches and the run stops before its first paid call.
    seal = await workspaceSecretSeal(db, workspaceId, 'hunter_api_key');
    if (!seal) return await fail(RUN_ERROR_MESSAGES.key_removed, 'key_removed');
    // A key Hunter already rejected fails the run at claim, before any provider
    // call. Saving a new key marks it valid in the same transaction.
    if ((await getEnrichmentSettings(db, workspaceId)).keyStatus === 'invalid') {
      return await fail(RUN_ERROR_MESSAGES.key_invalid, 'key_invalid');
    }
    // The ONE plaintext read of 'hunter_api_key' (secrets/store.ts module comment).
    const apiKey = await readWorkspaceSecretPlaintext(db, workspaceId, 'hunter_api_key');
    if (!apiKey) return await fail(RUN_ERROR_MESSAGES.key_removed, 'key_removed');
    const provider = providerFor(apiKey);

    for (let index = progress.doneDomains; index < run.domains.length; index += 1) {
      const domain = run.domains[index]!;
      let pending = progress.pending?.domainIndex === index ? progress.pending : undefined;
      // A suppressed company is skipped before it costs anything.
      if (!pending && !(await findSuppression(db, workspaceId, { channel: 'email', domain }))) {
        await beforePaidCall(limit * HUNTER_CREDIT_PRICE.perEmailFound);
        let search: DomainSearchResult | null = null;
        try {
          search = await provider.domainSearch(domain, { limit });
        } catch (error) {
          // Hunter refusing one company (a 400 for that domain) skips it, uncharged,
          // and the run moves on. Every other provider error ends or releases the run.
          if (!(error instanceof EnrichmentProviderError && error.code === 'rejected')) throw error;
          progress.skippedDomains = (progress.skippedDomains ?? 0) + 1;
        }
        if (search) {
          await charge('domain_search', search.credits);
          const candidates: PendingCandidate[] = [];
          for (const candidate of search.candidates.slice(0, limit)) {
            // contact.ts rule 3 (SOURCED): an address with no public page is never saved.
            if (!candidate.sourceUri || !emailOnDomain(candidate.email, domain)) {
              progress.skipped += 1;
              continue;
            }
            candidates.push({
              email: candidate.email,
              firstName: candidate.firstName,
              lastName: candidate.lastName,
              position: candidate.position,
              sourceUri: candidate.sourceUri
            });
          }
          pending = { domainIndex: index, next: 0, candidates };
          progress.pending = pending;
          // The search is paid for: keep its result so a resumed run never buys it twice.
          await checkpoint();
        }
      }
      for (let at = pending?.next ?? 0; pending && at < pending.candidates.length; at += 1) {
        const candidate = pending.candidates[at]!;
        // A suppressed address is never verified (no credit) and never saved.
        if (await findSuppression(db, workspaceId, { channel: 'email', email: candidate.email })) {
          progress.skipped += 1;
        } else {
          await beforePaidCall(HUNTER_CREDIT_PRICE.perVerification);
          const verification = await provider.verifyEmail(candidate.email);
          await charge('email_verifier', verification.credits);
          // contact.ts rule 4 (NEVER GUESS SILENTLY): unverified only on opt-in, labelled.
          const confidence =
            verification.status === 'valid'
              ? 'verified'
              : run.include_unverified &&
                  (verification.status === 'accept_all' || verification.status === 'unknown')
                ? 'inferred'
                : null;
          if (
            confidence &&
            (await saveCandidate(db, workspaceId, domain, candidate, confidence, clock()))
          ) {
            progress.saved += 1;
          } else {
            progress.skipped += 1;
          }
        }
        pending.next = at + 1;
        await checkpoint();
      }
      delete progress.pending;
      progress.doneDomains = index + 1;
      await checkpoint();
    }
    await finishRun(db, run, { status: 'completed', error: null, progress, spent }, clock());
  } catch (error) {
    if (error instanceof LeaseLost) return;
    if (error instanceof Draining) return releaseDrainedRun(db, run);
    if (error instanceof KeyChanged) {
      return fail(
        error.removed ? RUN_ERROR_MESSAGES.key_removed : RUN_ERROR_MESSAGES.key_replaced,
        'key_removed'
      );
    }
    if (error instanceof BudgetReached) return fail(BUDGET_MESSAGES[error.reason], error.reason);
    if (error instanceof EnrichmentProviderError) {
      if (error.code === 'key_invalid') {
        if (seal) await markKeyInvalid(db, workspaceId, seal, clock());
        return fail(RUN_ERROR_MESSAGES.key_invalid, 'key_invalid');
      }
      if (error.code === 'rate_limited' || error.code === 'unavailable') {
        // Resumes from the pending checkpoint: the domain is not searched again.
        return releaseRun(db, run, RUN_ERROR_MESSAGES[error.code]);
      }
      return fail(RUN_ERROR_MESSAGES[error.code], error.code);
    }
    // Workspace erasure deletes the run row mid-run: a clean stop, not a
    // worker error (its remaining writes fail on the erased workspace).
    if (!(await runStillExists(db, run))) return;
    await releaseRun(db, run, RUN_ERROR_MESSAGES.unexpected);
    throw contentFreeError(run, error);
  }
}

/** Closer for the ledger and finished runs: 13 months, so a full year compares to the same month last year. */
export async function pruneEnrichmentHistory(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, now.getUTCDate())
  ).toISOString();
  try {
    await db
      .prepare('DELETE FROM enrichment_usage_ledger WHERE occurred_at < ?::timestamptz')
      .run(cutoff);
    await db
      .prepare(
        "DELETE FROM enrichment_runs WHERE status IN ('completed','failed') AND finished_at < ?::timestamptz"
      )
      .run(cutoff);
  } catch (error) {
    console.error('Enrichment history prune failed', error);
  }
}
