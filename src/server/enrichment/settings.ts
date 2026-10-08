import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { describeWorkspaceSecret, type WorkspaceSecretSummary } from '../secrets/store.js';
import { roundCredits, type EnrichmentProviderId } from './provider.js';

export type EnrichmentKeyStatus = 'missing' | 'unchecked' | 'valid' | 'invalid';
export const MAX_MONTHLY_CREDIT_CAP = 100_000;

export interface EnrichmentSettings {
  provider: EnrichmentProviderId;
  monthlyCreditCap: number;
  keyStatus: EnrichmentKeyStatus;
  keyCheckedAt: string | null;
  key: WorkspaceSecretSummary | null;
}

export interface EnrichmentUsage {
  monthStart: string;
  /** Credits written to the ledger since monthStart. */
  chargedCredits: number;
  /** Unspent estimate of every queued or running run. */
  reservedCredits: number;
  usedCredits: number;
}

export class EnrichmentError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

// lc-debt: the cap month is the UTC calendar month, not Hunter's own billing
// reset_date (GET /v2/account). The cap is Trevra's spending guard, not a
// mirror of the Hunter invoice; upgrade by storing reset_date from checkKey
// and keying monthStartUtc on it.
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getEnrichmentSettings(
  db: Db,
  workspaceId: string
): Promise<EnrichmentSettings> {
  const row = await db
    .prepare(
      'SELECT monthly_credit_cap, key_status, key_checked_at FROM enrichment_settings WHERE workspace_id=?'
    )
    .get<{ monthly_credit_cap: string; key_status: string; key_checked_at: string | null }>(
      workspaceId
    );
  const key = await describeWorkspaceSecret(db, workspaceId, 'hunter_api_key');
  const stored = (row?.key_status ?? 'unchecked') as Exclude<EnrichmentKeyStatus, 'missing'>;
  return {
    provider: 'hunter',
    monthlyCreditCap: Number(row?.monthly_credit_cap ?? 0),
    keyStatus: key ? stored : 'missing',
    keyCheckedAt:
      key && row?.key_checked_at ? new Date(String(row.key_checked_at)).toISOString() : null,
    key
  };
}

export async function setEnrichmentCap(
  db: Db,
  workspaceId: string,
  cap: number,
  actorUserId: string,
  now: Date = new Date()
): Promise<EnrichmentSettings> {
  if (
    !Number.isFinite(cap) ||
    cap < 0 ||
    cap > MAX_MONTHLY_CREDIT_CAP ||
    !Number.isInteger(cap * 2)
  )
    throw new EnrichmentError(
      `The monthly cap must be between 0 and ${MAX_MONTHLY_CREDIT_CAP} credits, in steps of 0.5.`
    );
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO enrichment_settings (workspace_id, monthly_credit_cap, updated_by_user_id, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           monthly_credit_cap=excluded.monthly_credit_cap,
           updated_by_user_id=excluded.updated_by_user_id,
           updated_at=excluded.updated_at`
      )
      .run(workspaceId, cap, actorUserId, now.toISOString());
    await appendDomainEvent(tx, {
      workspaceId,
      streamType: 'enrichment_settings',
      streamId: workspaceId,
      eventType: 'enrichment.cap_set',
      actorType: 'user',
      actorId: actorUserId,
      payload: { monthlyCreditCap: cap },
      occurredAt: now
    });
  });
  return getEnrichmentSettings(db, workspaceId);
}

export async function setEnrichmentKeyStatus(
  db: Db,
  workspaceId: string,
  status: Exclude<EnrichmentKeyStatus, 'missing'>,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_settings (workspace_id, key_status, key_checked_at, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         key_status=excluded.key_status,
         key_checked_at=excluded.key_checked_at,
         updated_at=excluded.updated_at`
    )
    .run(workspaceId, status, status === 'unchecked' ? null : now.toISOString(), now.toISOString());
}

export async function enrichmentUsage(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<EnrichmentUsage> {
  const monthStart = monthStartUtc(now).toISOString();
  const row = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(credits) FROM enrichment_usage_ledger
                   WHERE workspace_id=? AND occurred_at >= ?::timestamptz), 0) AS charged,
         COALESCE((SELECT SUM(GREATEST(r.estimated_credits - COALESCE(spent.total, 0), 0))
                   FROM enrichment_runs r
                   LEFT JOIN LATERAL (
                     SELECT SUM(l.credits) AS total FROM enrichment_usage_ledger l
                     WHERE l.workspace_id=r.workspace_id AND l.run_id=r.id
                   ) spent ON TRUE
                   WHERE r.workspace_id=? AND r.status IN ('queued','running')), 0) AS reserved`
    )
    .get<{ charged: string; reserved: string }>(workspaceId, monthStart, workspaceId);
  const chargedCredits = roundCredits(Number(row?.charged ?? 0));
  const reservedCredits = roundCredits(Number(row?.reserved ?? 0));
  return {
    monthStart,
    chargedCredits,
    reservedCredits,
    usedCredits: roundCredits(chargedCredits + reservedCredits)
  };
}
