import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { BillingServiceError, type BillingApi } from '../billing-client.js';

/**
 * TRV-057 metered usage, reported to Olaryn Billing idempotently.
 *
 * WHAT BILLING METERS. Exactly one thing: credits. A product reports usage by
 * reserving an amount (`POST .../reservations`, unique per customer by
 * `idempotency_key`) and settling the reservation (`.../settle`, idempotent per
 * reservation; Billing forwards it to OpenMeter under the event id
 * `reservation:<id>`). There is no other usage endpoint, so this module
 * creates no meter of its own.
 *
 * WHAT TREVRA CHARGES. Executed external actions, one credit each: LinkedIn
 * actions this deployment performed and approved prepared actions that
 * executed (`action.executed` domain events).
 * lc-debt: preview per-action credit costs (1 each) mirror Billing's
 * "preview pricing" catalog; replace USAGE_OPERATIONS with the finalized
 * commercial cost table once Trevra pricing is decided.
 *
 * HOW IT STAYS EXACTLY-ONCE.
 *  1. Usage is derived from the durable ledgers by a sweep, so no hot write
 *     path changes. Each source row maps to the deterministic event id
 *     sha256(workspace_id|meter|source_type|source_id), which is the outbox
 *     primary key: enqueueing twice is a no-op.
 *  2. The reservation idempotency key is derived from that id, so a retried
 *     report reuses the same Billing reservation, and settling an already
 *     settled reservation is a no-op in Billing.
 *  3. Only an EXPIRED reservation (never settled, so never counted) gets a
 *     new generation key.
 */

export const USAGE_METER = 'credits';
export const USAGE_OPERATIONS = {
  linkedin_action: { credits: 1 },
  approved_action: { credits: 1 }
} as const;

/** How far back the sweep looks. Far below the 90-day outbox retention. */
export const USAGE_LOOKBACK_MS = 48 * 60 * 60_000;
const USAGE_RETENTION_MS = 90 * 24 * 60 * 60_000;
const RESERVATION_TTL_SECONDS = 3600;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 20;

export function usageEventId(
  workspaceId: string,
  meter: string,
  sourceType: string,
  sourceId: string
): string {
  return createHash('sha256')
    .update(`${workspaceId}|${meter}|${sourceType}|${sourceId}`, 'utf8')
    .digest('hex');
}

export function usageReservationKey(eventId: string, generation: number): string {
  return generation > 0 ? `trv-usage:${eventId}:g${generation}` : `trv-usage:${eventId}`;
}

// The same formula as usageEventId, in SQL, so the sweep stays one set-based
// statement per source. A test pins the two together.
const SQL_EVENT_ID = (workspace: string, sourceType: string, sourceId: string) =>
  `encode(sha256(convert_to(${workspace} || '|${USAGE_METER}|${sourceType}|' || ${sourceId}, 'UTF8')), 'hex')`;

/**
 * Copies billable ledger rows into the outbox. Only workspaces with a Billing
 * snapshot are metered, and only work recorded after metering started for
 * them, so enabling Billing never back-bills history.
 * lc-debt: per-workspace range scans of linkedin_actions/domain_events without
 * a (workspace_id, recorded_at|occurred_at) index; add those indexes
 * CONCURRENTLY or a per-workspace cursor if ledger volume makes the sweep slow.
 */
export async function enqueueBillableUsage(db: Db, options: { now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - USAGE_LOOKBACK_MS).toISOString();
  const until = now.toISOString();
  const linkedin = await db
    .prepare(
      `INSERT INTO billing_usage_outbox
         (id,workspace_id,meter,operation,source_type,source_id,amount,occurred_at,next_attempt_at)
       SELECT ${SQL_EVENT_ID('a.workspace_id', 'linkedin_action', 'a.id')},
              a.workspace_id,'${USAGE_METER}','linkedin_action','linkedin_action',a.id,?::numeric,a.recorded_at,
              ?::timestamptz
       FROM billing_workspace_state s
       JOIN linkedin_actions a ON a.workspace_id=s.workspace_id
       WHERE a.recorded_at >= GREATEST(?::timestamptz, s.metering_started_at)
         AND a.recorded_at <= ?::timestamptz
         AND a.status IN ('sent','accepted','replied','declined','withdrawn')
         AND a.source NOT IN ('manual','export')
       ON CONFLICT DO NOTHING`
    )
    .run(String(USAGE_OPERATIONS.linkedin_action.credits), until, cutoff, until);
  const approved = await db
    .prepare(
      `INSERT INTO billing_usage_outbox
         (id,workspace_id,meter,operation,source_type,source_id,amount,occurred_at,next_attempt_at)
       SELECT ${SQL_EVENT_ID('e.workspace_id', 'domain_event', 'e.id')},
              e.workspace_id,'${USAGE_METER}','approved_action','domain_event',e.id,?::numeric,e.occurred_at,
              ?::timestamptz
       FROM billing_workspace_state s
       JOIN domain_events e ON e.workspace_id=s.workspace_id
       WHERE e.event_type='action.executed'
         AND e.occurred_at >= GREATEST(?::timestamptz, s.metering_started_at)
         AND e.occurred_at <= ?::timestamptz
       ON CONFLICT DO NOTHING`
    )
    .run(String(USAGE_OPERATIONS.approved_action.credits), until, cutoff, until);
  return linkedin.changes + approved.changes;
}

type ClaimedUsage = {
  id: string;
  workspace_id: string;
  operation: string;
  source_type: string;
  source_id: string;
  amount: string;
  reservation_id: string | null;
  reservation_generation: number;
  attempts: number;
};

export type UsageReportResult = {
  claimed: number;
  reported: number;
  rejected: number;
  retried: number;
  dead: number;
};

function errorStatus(error: unknown): number | null {
  return error instanceof BillingServiceError ? error.status : null;
}

function shortError(error: unknown): string {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : 'Billing request failed';
  return `${status ?? 'network'}: ${message}`.slice(0, 240);
}

/**
 * Reports a leased batch of pending usage. Safe to run from several worker
 * replicas: rows are claimed with SKIP LOCKED plus a lease token, and every
 * write back is fenced by that token.
 */
export async function reportPendingUsage(
  db: Db,
  options: { client: BillingApi; now?: Date; limit?: number }
): Promise<UsageReportResult> {
  const now = options.now ?? new Date();
  const token = randomUUID();
  const rows = await db
    .prepare(
      `UPDATE billing_usage_outbox o
       SET lease_token=?, leased_until=?, attempts=o.attempts+1, updated_at=?
       WHERE o.id IN (
         SELECT id FROM billing_usage_outbox
         WHERE status='pending' AND next_attempt_at <= ?
           AND (leased_until IS NULL OR leased_until < ?)
         ORDER BY next_attempt_at, id
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       RETURNING o.id,o.workspace_id,o.operation,o.source_type,o.source_id,o.amount::text AS amount,
                 o.reservation_id,o.reservation_generation,o.attempts`
    )
    .all<ClaimedUsage>(
      token,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      options.limit ?? 50
    );
  const result: UsageReportResult = {
    claimed: rows.length,
    reported: 0,
    rejected: 0,
    retried: 0,
    dead: 0
  };
  const stamp = now.toISOString();
  const finish = (id: string, status: 'reported' | 'rejected' | 'dead', error: string | null) =>
    db
      .prepare(
        `UPDATE billing_usage_outbox
         SET status=?, last_error=?, finished_at=?, lease_token=NULL, leased_until=NULL, updated_at=?
         WHERE id=? AND lease_token=?`
      )
      .run(status, error, stamp, stamp, id, token);

  for (const row of rows) {
    let stage: 'reserve' | 'settle' = 'reserve';
    try {
      let reservationId = row.reservation_id;
      if (!reservationId) {
        const reservation = await options.client.reserveCredits({
          workspaceId: row.workspace_id,
          amount: row.amount,
          operation: row.operation,
          idempotencyKey: usageReservationKey(row.id, row.reservation_generation),
          ttlSeconds: RESERVATION_TTL_SECONDS,
          resourceType: row.source_type,
          resourceId: row.source_id
        });
        reservationId = reservation.id;
        await db
          .prepare(
            'UPDATE billing_usage_outbox SET reservation_id=?, updated_at=? WHERE id=? AND lease_token=?'
          )
          .run(reservationId, stamp, row.id, token);
      }
      stage = 'settle';
      await options.client.settleReservation({ workspaceId: row.workspace_id, reservationId });
      await finish(row.id, 'reported', null);
      result.reported += 1;
    } catch (error) {
      const status = errorStatus(error);
      const message = error instanceof Error ? error.message : '';
      if (stage === 'settle' && status === 409 && /expired/i.test(message)) {
        // The hold lapsed before settlement: it was never counted. Retry at
        // once under the next generation key.
        await db
          .prepare(
            `UPDATE billing_usage_outbox
             SET reservation_id=NULL, reservation_generation=reservation_generation+1,
                 next_attempt_at=?, last_error=?, lease_token=NULL, leased_until=NULL, updated_at=?
             WHERE id=? AND lease_token=?`
          )
          .run(stamp, shortError(error), stamp, row.id, token);
        result.retried += 1;
      } else if (status !== null && [400, 409, 422].includes(status)) {
        // Billing refused this usage (for example insufficient credits, or a
        // financial-authority hold). Kept for reconciliation, never retried
        // under a new key -- that could charge it twice.
        await finish(row.id, 'rejected', shortError(error));
        result.rejected += 1;
      } else if (row.attempts >= MAX_ATTEMPTS) {
        await finish(row.id, 'dead', shortError(error));
        result.dead += 1;
      } else {
        const backoffMs = Math.min(2 ** row.attempts * 60_000, 6 * 60 * 60_000);
        await db
          .prepare(
            `UPDATE billing_usage_outbox
             SET next_attempt_at=?, last_error=?, lease_token=NULL, leased_until=NULL, updated_at=?
             WHERE id=? AND lease_token=?`
          )
          .run(
            new Date(now.getTime() + backoffMs).toISOString(),
            shortError(error),
            stamp,
            row.id,
            token
          );
        result.retried += 1;
      }
    }
  }
  return result;
}

/** Closer for the outbox: finished rows are kept 90 days for reconciliation. */
export async function pruneBillingUsage(db: Db, now: Date = new Date()): Promise<number> {
  const result = await db
    .prepare("DELETE FROM billing_usage_outbox WHERE status<>'pending' AND finished_at < ?")
    .run(new Date(now.getTime() - USAGE_RETENTION_MS).toISOString());
  return result.changes;
}
