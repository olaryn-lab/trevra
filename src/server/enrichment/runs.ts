import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { resolveContact, resolveExplicitAccount } from '../lead-capture/people.js';
import { LeadCaptureError } from '../lead-capture/types.js';
import { readWorkspaceSecretPlaintext } from '../secrets/store.js';
import { findSuppression } from '../suppressions.js';
import { createHunterProvider } from './hunter.js';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  roundCredits,
  type ContactEnrichmentProvider,
  type EnrichmentCandidate,
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
 * each call, with the credits the provider reported (never clamped). Every
 * paid call is also preceded by a lease heartbeat fenced on `attempts`: a
 * replica that re-claimed the run after an expired lease bumped `attempts`, so
 * the older copy stops instead of spending twice.
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

interface RunProgress {
  doneDomains: number;
  saved: number;
  skipped: number;
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

const BUDGET_MESSAGES: Record<BudgetReached['reason'], string> = {
  estimate_reached: 'Stopped before exceeding the approved credit estimate.',
  cap_reached: "Stopped at this month's Hunter credit cap."
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

function readProgress(value: unknown): RunProgress {
  const raw = (
    typeof value === 'string' ? JSON.parse(value) : value
  ) as Partial<RunProgress> | null;
  return {
    doneDomains: Number(raw?.doneDomains ?? 0) || 0,
    saved: Number(raw?.saved ?? 0) || 0,
    skipped: Number(raw?.skipped ?? 0) || 0
  };
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
    await executeRun(db, run, providerFor, shouldStop, now);
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
  const rows = await db
    .prepare(
      `UPDATE enrichment_runs
         SET status='failed', last_error='Stopped after 3 attempts.', finished_at=?::timestamptz,
             lease_until=NULL
       WHERE attempts >= ?
         AND (status='queued' OR (status='running' AND lease_until < ?::timestamptz))
       RETURNING id, workspace_id`
    )
    .all<{ id: string; workspace_id: string }>(now.toISOString(), MAX_ATTEMPTS, now.toISOString());
  for (const row of rows) {
    await appendDomainEvent(db, {
      workspaceId: row.workspace_id,
      streamType: 'enrichment_run',
      streamId: row.id,
      eventType: 'enrichment_run.failed',
      actorType: 'system',
      payload: { reason: 'attempts_exhausted' },
      occurredAt: now
    });
  }
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

/**
 * Identifies the exact sealing of the stored key without opening it: the GCM
 * nonce is random per write (migration 015) and is not secret. A replaced key
 * has a new nonce, so a key-invalid answer for the old key can be fenced on it.
 */
async function keySeal(db: Db, workspaceId: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT encode(iv,'hex') AS seal FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'"
    )
    .get<{ seal: string }>(workspaceId);
  return row?.seal ?? null;
}

/** Marks the key invalid only while the key this run used is still the stored one. */
async function markKeyInvalid(db: Db, workspaceId: string, seal: string, now: Date) {
  await db.transaction(async (tx) => {
    // FOR SHARE waits out a concurrent replacement and re-checks the new row,
    // so a key sealed meanwhile (and marked valid in its own transaction) wins.
    const current = await tx
      .prepare(
        `SELECT id FROM workspace_secrets
         WHERE workspace_id=? AND kind='hunter_api_key' AND iv=decode(?,'hex')
         FOR SHARE`
      )
      .get<{ id: string }>(workspaceId, seal);
    if (current) await setEnrichmentKeyStatus(tx, workspaceId, 'invalid', now);
  });
}

function emailOnDomain(email: string, domain: string): boolean {
  const host = email.split('@')[1] ?? '';
  return host === domain || host.endsWith(`.${domain}`);
}

async function saveCandidate(
  db: Db,
  workspaceId: string,
  domain: string,
  candidate: EnrichmentCandidate,
  confidence: 'verified' | 'inferred',
  now: Date
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
        now
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
          sourceDetail: `hunter ${candidate.sourceUri ?? ''}`.slice(0, 600)
        },
        now
      );
      return linked !== null;
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
  now: Date
): Promise<void> {
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
        now.toISOString(),
        JSON.stringify(outcome.progress),
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
        domainsDone: outcome.progress.doneDomains,
        saved: outcome.progress.saved,
        skipped: outcome.progress.skipped,
        creditsSpent: outcome.spent
      },
      occurredAt: now
    });
  });
}

/** Back to the queue, fenced so a stale copy cannot release a run another replica holds. */
async function releaseRun(db: Db, run: RunRow, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE enrichment_runs SET status='queued', lease_until=NULL, last_error=?
       WHERE id=? AND workspace_id=? AND status='running' AND attempts=?`
    )
    .run(reason, run.id, run.workspace_id, run.attempts);
}

async function executeRun(
  db: Db,
  run: RunRow,
  providerFor: (apiKey: string) => ContactEnrichmentProvider,
  shouldStop: () => boolean,
  now: Date
): Promise<void> {
  const workspaceId = run.workspace_id;
  const progress = readProgress(run.progress_json);
  const estimate = Number(run.estimated_credits);
  let spent = 0;
  // Lease time advances with the wall clock from the injected `now`, so tests
  // that pin `now` stay deterministic and a long run keeps extending its lease.
  const startedWall = Date.now();
  const leaseUntil = () =>
    new Date(now.getTime() + (Date.now() - startedWall) + LEASE_MS).toISOString();
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
  // Both budgets must cover the call's MAXIMUM price, re-read from the DB
  // every time so a lowered cap stops the run before its next call.
  const beforePaidCall = async (maxCredits: number) => {
    if (shouldStop()) throw new Draining();
    if (roundCredits(estimate - spent) < maxCredits) throw new BudgetReached('estimate_reached');
    const settings = await getEnrichmentSettings(db, workspaceId);
    const usage = await enrichmentUsage(db, workspaceId, now, { excludeRunId: run.id });
    if (roundCredits(settings.monthlyCreditCap - usage.usedCredits) < maxCredits) {
      throw new BudgetReached('cap_reached');
    }
    await heartbeat();
  };
  // lc-debt: charged immediately after each call, so a hard kill between
  // Hunter's response and this insert loses that one call's charge; upgrade
  // to reserve-then-settle ledger rows written before the call.
  const charge = async (operation: 'domain_search' | 'email_verifier', credits: number) => {
    if (credits <= 0) return;
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
         VALUES (?,?,?,'hunter',?,?,?::timestamptz)`
      )
      .run(id('enl'), workspaceId, run.id, operation, credits, now.toISOString());
    spent = roundCredits(spent + credits);
  };
  const fail = (error: string, reason: FailureReason) =>
    finishRun(db, run, { status: 'failed', error, reason, progress, spent }, now);

  let seal: string | null = null;
  try {
    spent = await spentOnRun(db, workspaceId, run.id);
    // Read the seal BEFORE the plaintext: if the key is replaced in between,
    // the fence mismatches and a key-invalid answer marks nothing.
    seal = await keySeal(db, workspaceId);
    // The ONE plaintext read of 'hunter_api_key' (secrets/store.ts module comment).
    const apiKey = seal
      ? await readWorkspaceSecretPlaintext(db, workspaceId, 'hunter_api_key')
      : null;
    if (!apiKey) {
      return await fail('The Hunter key was removed before this run finished.', 'key_removed');
    }
    const provider = providerFor(apiKey);

    for (let index = progress.doneDomains; index < run.domains.length; index += 1) {
      const domain = run.domains[index]!;
      const limit = Number(run.emails_per_domain);
      // A suppressed company is skipped before it costs anything.
      const domainSuppressed = await findSuppression(db, workspaceId, { channel: 'email', domain });
      if (!domainSuppressed) {
        await beforePaidCall(limit * HUNTER_CREDIT_PRICE.perEmailFound);
        const search = await provider.domainSearch(domain, { limit });
        await charge('domain_search', search.credits);
        for (const candidate of search.candidates.slice(0, limit)) {
          // contact.ts rule 3 (SOURCED): an address with no public page is never saved.
          if (!candidate.sourceUri || !emailOnDomain(candidate.email, domain)) {
            progress.skipped += 1;
            continue;
          }
          // A suppressed address is never verified (no credit) and never saved.
          if (
            await findSuppression(db, workspaceId, { channel: 'email', email: candidate.email })
          ) {
            progress.skipped += 1;
            continue;
          }
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
          if (!confidence) {
            progress.skipped += 1;
            continue;
          }
          if (await saveCandidate(db, workspaceId, domain, candidate, confidence, now)) {
            progress.saved += 1;
          } else {
            progress.skipped += 1;
          }
        }
      }
      progress.doneDomains = index + 1;
      const checkpointed = await db
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
      if (!checkpointed) throw new LeaseLost();
    }
    await finishRun(db, run, { status: 'completed', error: null, progress, spent }, now);
  } catch (error) {
    if (error instanceof LeaseLost) return;
    if (error instanceof Draining) {
      // lc-debt: the unfinished domain is searched (and charged) again on
      // resume; see the rate-limit note below.
      return releaseRun(db, run, 'Paused while the worker restarted; it resumes automatically.');
    }
    if (error instanceof BudgetReached) return fail(BUDGET_MESSAGES[error.reason], error.reason);
    if (error instanceof EnrichmentProviderError) {
      if (error.code === 'key_invalid') {
        if (seal) await markKeyInvalid(db, workspaceId, seal, now);
        return fail('Hunter rejected the saved key. Replace it and re-plan.', 'key_invalid');
      }
      if (error.code === 'rate_limited' || error.code === 'unavailable') {
        // lc-debt: a retry repeats the unfinished domain, and the ledger
        // charges its search again although Hunter counts a repeat search once
        // per billing period. This overstates usage, so the cap errs safe;
        // upgrade by checkpointing per candidate.
        return releaseRun(db, run, error.message);
      }
      return fail(error.message, error.code);
    }
    // Workspace erasure deletes the run row mid-run: a clean stop, not a
    // worker error (its remaining writes fail on the erased workspace).
    if (!(await runStillExists(db, run))) return;
    await releaseRun(db, run, 'Unexpected error; the run will be retried.');
    // Content-free: a database error's detail can quote a contact's email.
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'none';
    throw new Error(
      `Enrichment run ${run.id} stopped on an unexpected ${error instanceof Error ? error.name : 'error'} (code ${code}); it will be retried.`
    );
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
