import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { notifyAnnualRenewalUpcoming } from '../notifications.js';
import { BILLING_GRACE_MS, type StoredBillingSnapshot } from './entitlements.js';

/**
 * TRV-057 annual renewal notice: the owners of an annual subscription get one
 * e-mail 30 days before it renews. Billing emits no events to products, so the
 * worker reads the cached Billing snapshots (refreshed by the maintenance
 * loop) and only trusts ones inside the 72h grace window.
 *
 * Exactly once per renewal date: billing_renewal_notices is keyed by
 * (workspace_id, renewal_on). A worker claims the row with a token, sends,
 * then marks it notified; a failed send releases the claim for a later pass,
 * and a crashed sender's claim expires after CLAIM_TTL_MS.
 */

export const RENEWAL_NOTICE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const CLAIM_TTL_MS = 15 * 60_000;
const RENEWAL_RETENTION_MS = 400 * DAY_MS;

export function isAnnualPlan(planCode: string | null | undefined): boolean {
  return Boolean(planCode && /_yearly(_|$)/.test(planCode));
}

export function planLabel(planCode: string | null | undefined): string {
  if (!planCode) return 'No plan';
  const [tier = planCode, interval] = planCode.split('_');
  const name = tier.charAt(0).toUpperCase() + tier.slice(1);
  return interval === 'yearly'
    ? `${name} (annual)`
    : interval === 'monthly'
      ? `${name} (monthly)`
      : name;
}

/** The renewal a snapshot announces, if it is an active annual plan that will renew. */
export function upcomingAnnualRenewal(
  snapshot: StoredBillingSnapshot,
  now: Date
): { renewalOn: string; renewsAt: Date } | null {
  const subscription = snapshot.subscription;
  if (subscription.status !== 'active' || subscription.cancel_at_period_end) return null;
  if (!isAnnualPlan(subscription.plan_code)) return null;
  const end = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
  if (!end || Number.isNaN(end.getTime())) return null;
  return { renewalOn: end.toISOString().slice(0, 10), renewsAt: end };
}

type Candidate = { workspace_id: string; snapshot_json: StoredBillingSnapshot };

export async function sendAnnualRenewalNotices(
  db: Db,
  options: { now?: Date; limit?: number } = {}
): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + RENEWAL_NOTICE_DAYS * DAY_MS);
  // Pre-filter in SQL on the cached snapshot; upcomingAnnualRenewal re-checks.
  const candidates = await db
    .prepare(
      `SELECT s.workspace_id, s.snapshot_json
       FROM billing_workspace_state s
       WHERE s.fetched_at >= ?
         AND s.snapshot_json->'subscription'->>'status' = 'active'
         AND s.snapshot_json->'subscription'->>'plan_code' LIKE '%\\_yearly%'
         AND (s.snapshot_json->'subscription'->>'current_period_end')::timestamptz > ?
         AND (s.snapshot_json->'subscription'->>'current_period_end')::timestamptz <= ?
         AND NOT EXISTS (
           SELECT 1 FROM billing_renewal_notices n
           WHERE n.workspace_id=s.workspace_id
             AND n.renewal_on=((s.snapshot_json->'subscription'->>'current_period_end')::timestamptz AT TIME ZONE 'UTC')::date
             AND n.notified_at IS NOT NULL)
       ORDER BY s.workspace_id
       LIMIT ?`
    )
    .all<Candidate>(
      new Date(now.getTime() - BILLING_GRACE_MS).toISOString(),
      now.toISOString(),
      horizon.toISOString(),
      options.limit ?? 50
    );
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const renewal = upcomingAnnualRenewal(candidate.snapshot_json, now);
    if (!renewal || renewal.renewsAt <= now || renewal.renewsAt > horizon) {
      skipped += 1;
      continue;
    }
    const token = randomUUID();
    const claimed = await db
      .prepare(
        `INSERT INTO billing_renewal_notices (workspace_id,renewal_on,plan_code,claimed_at,claim_token)
         VALUES (?,?::date,?,?,?)
         ON CONFLICT (workspace_id,renewal_on) DO UPDATE
           SET claimed_at=excluded.claimed_at, claim_token=excluded.claim_token, plan_code=excluded.plan_code
         WHERE billing_renewal_notices.notified_at IS NULL
           AND (billing_renewal_notices.claimed_at IS NULL OR billing_renewal_notices.claimed_at < ?)
         RETURNING claim_token`
      )
      .get<{ claim_token: string }>(
        candidate.workspace_id,
        renewal.renewalOn,
        candidate.snapshot_json.subscription.plan_code,
        now.toISOString(),
        token,
        new Date(now.getTime() - CLAIM_TTL_MS).toISOString()
      );
    if (claimed?.claim_token !== token) {
      skipped += 1;
      continue;
    }
    const release = () =>
      db
        .prepare(
          `UPDATE billing_renewal_notices SET claimed_at=NULL, claim_token=NULL
           WHERE workspace_id=? AND renewal_on=?::date AND claim_token=?`
        )
        .run(candidate.workspace_id, renewal.renewalOn, token);
    try {
      const delivered = await notifyAnnualRenewalUpcoming(db, {
        workspaceId: candidate.workspace_id,
        planLabel: planLabel(candidate.snapshot_json.subscription.plan_code),
        renewalOn: renewal.renewalOn,
        daysBefore: Math.max(1, Math.ceil((renewal.renewsAt.getTime() - now.getTime()) / DAY_MS))
      });
      if (!delivered) {
        await release();
        skipped += 1;
        continue;
      }
      await db
        .prepare(
          `UPDATE billing_renewal_notices SET notified_at=?, claimed_at=NULL, claim_token=NULL
           WHERE workspace_id=? AND renewal_on=?::date AND claim_token=?`
        )
        .run(now.toISOString(), candidate.workspace_id, renewal.renewalOn, token);
      sent += 1;
    } catch {
      // Delivery failed for at least one owner: release so a later pass
      // retries. The other workspaces in this batch are unaffected.
      await release();
      failed += 1;
    }
  }
  return { sent, skipped, failed };
}

/** Closer for billing_renewal_notices: dedupe rows outlive their renewal by 400 days. */
export async function pruneRenewalNotices(db: Db, now: Date = new Date()): Promise<number> {
  const result = await db
    .prepare('DELETE FROM billing_renewal_notices WHERE renewal_on < ?::date')
    .run(new Date(now.getTime() - RENEWAL_RETENTION_MS).toISOString().slice(0, 10));
  return result.changes;
}
