import type { Db } from '../db.js';
import { campaignExecutionState } from './execution-state.js';
import { notifyLinkedInCampaignStalled } from '../notifications.js';
import { reviewLinkedInAction, type LinkedInActionReview } from './action-policy.js';

// Alerts are evidence-led, not guesses about a campaign merely being "running":
// an online Companion, an overdue claimable action, a live allowed safety gate,
// no recent worker sitting, and 30 minutes of sustained observation are needed.
const OVERDUE_MS = 90 * 60_000;
const OBSERVATION_MS = 30 * 60_000;
const NO_BATCH_MS = 30 * 60_000;
const SCAN_GAP_MS = 12 * 60_000;
const CLAIM_RETRY_MS = 10 * 60_000;
const REMINDER_MS = 24 * 60 * 60_000;
const MAX_CANDIDATES = 25;
const ISO_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function approvedForStallAlert(
  review: Pick<LinkedInActionReview, 'approved' | 'policy'> | null
): boolean {
  return Boolean(
    review &&
    review.policy.effect !== 'deny' &&
    (review.policy.effect !== 'require_approval' || review.approved)
  );
}

export interface CampaignStallCandidate {
  workspace_id: string;
  campaign_id: string;
  seat_key: string;
  due_count: number;
  oldest_due: string;
}

export interface CampaignStallResult {
  candidates: number;
  eligible: number;
  alerted: number;
}

export function eligibleStallFromExecution(
  state: Awaited<ReturnType<typeof campaignExecutionState>>,
  expectedSeat: string
): boolean {
  return (
    state.seatKey === expectedSeat &&
    state.dueNow > 0 &&
    !state.restingUntil &&
    !state.humanSendNext &&
    state.gate?.allowed === true
  );
}

/**
 * Read-only discovery first, then an idempotent durable alert claim.
 * Crucially, a failing monitor cannot stop the independent outreach loop.
 * A missing SMTP destination does NOT count as a delivered alert.
 */
export async function scanStalledLinkedInCampaigns(
  db: Db,
  options: {
    now?: Date;
    notify?: typeof notifyLinkedInCampaignStalled;
  } = {}
): Promise<CampaignStallResult> {
  const now = options.now ?? new Date();
  const notify = options.notify ?? notifyLinkedInCampaignStalled;
  const nowIso = now.toISOString();
  const observedCutoff = new Date(now.getTime() - OBSERVATION_MS).toISOString();
  const scanGapCutoff = new Date(now.getTime() - SCAN_GAP_MS).toISOString();
  const batchCutoff = new Date(now.getTime() - NO_BATCH_MS).toISOString();
  const overdueCutoff = new Date(now.getTime() - OVERDUE_MS).toISOString();
  const claimCutoff = new Date(now.getTime() - CLAIM_RETRY_MS).toISOString();
  const reminderCutoff = new Date(now.getTime() - REMINDER_MS).toISOString();
  const companionCutoff = new Date(now.getTime() - 90_000).toISOString();

  const candidates = await db
    .prepare(
      `SELECT a.workspace_id,a.campaign_id,a.seat_key,
            COUNT(*)::int AS due_count,
            TO_CHAR(MIN(a.planned_for) AT TIME ZONE 'UTC', ${ISO_SQL}) AS oldest_due
     FROM linkedin_actions a
     JOIN linkedin_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id
     JOIN linkedin_seats s ON s.workspace_id=a.workspace_id AND s.seat_key=a.seat_key
     WHERE c.status='running' AND s.posture NOT IN ('paused','cooldown')
       AND a.status='planned' AND a.claimed_at IS NULL
       AND a.settlement_hold_at IS NULL
       AND a.planned_for IS NOT NULL AND a.planned_for<=?::timestamptz
       AND EXISTS (SELECT 1 FROM linkedin_companion_devices d
                   WHERE d.workspace_id=a.workspace_id AND d.revoked_at IS NULL
                     AND d.last_seen_at>=?::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM linkedin_batches b
                       WHERE b.workspace_id=a.workspace_id AND b.seat_key=a.seat_key
                         AND b.started_at>=?::timestamptz)
     GROUP BY a.workspace_id,a.campaign_id,a.seat_key
     ORDER BY MIN(a.planned_for),a.workspace_id,a.campaign_id
     LIMIT ${MAX_CANDIDATES}`
    )
    .all<CampaignStallCandidate>(overdueCutoff, companionCutoff, batchCutoff);

  let eligible = 0;
  let alerted = 0;
  for (const candidate of candidates) {
    try {
      const execution = await campaignExecutionState(
        db,
        candidate.workspace_id,
        candidate.campaign_id,
        now
      );
      if (!eligibleStallFromExecution(execution, candidate.seat_key)) continue;
      // The safety gate is not an approval grant. Re-read the actual
      // owner-approved content policy, without writing an execution audit
      // (the send-time authorizeAction hook is the mutating one). Otherwise a
      // campaign waiting for its owner's approval would be falsely escalated
      // as a stuck sender.
      const next = await db
        .prepare(
          `SELECT id FROM linkedin_actions
         WHERE workspace_id=? AND campaign_id=? AND seat_key=? AND status='planned'
           AND claimed_at IS NULL AND settlement_hold_at IS NULL
           AND planned_for<=?::timestamptz AND target_ref IS NOT NULL
         ORDER BY (CASE WHEN sla_deadline_at IS NOT NULL AND sla_deadline_at<=?::timestamptz
                        THEN 1 ELSE 0 END) DESC,
                  queue_priority DESC, planned_for ASC
         LIMIT 1`
        )
        .get<{ id: string }>(
          candidate.workspace_id,
          candidate.campaign_id,
          candidate.seat_key,
          nowIso,
          nowIso
        );
      if (!next) continue;
      const review = await reviewLinkedInAction(db, candidate.workspace_id, next.id);
      if (!approvedForStallAlert(review)) continue;
      eligible++;
      // Gaps invalidate continuity. The 30-minute dwell prevents a false
      // incident as a working window opens on Monday or after a daily break.
      const state = await db
        .prepare(
          `INSERT INTO linkedin_campaign_stall_alerts
           (workspace_id,campaign_id,seat_key,first_detected_at,last_detected_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT (workspace_id,campaign_id,seat_key) DO UPDATE
         SET first_detected_at=CASE
               WHEN linkedin_campaign_stall_alerts.last_detected_at<?::timestamptz
                 THEN EXCLUDED.first_detected_at
               ELSE linkedin_campaign_stall_alerts.first_detected_at
             END,
             last_detected_at=EXCLUDED.last_detected_at
         RETURNING first_detected_at`
        )
        .get<{ first_detected_at: Date | string }>(
          candidate.workspace_id,
          candidate.campaign_id,
          candidate.seat_key,
          nowIso,
          nowIso,
          scanGapCutoff
        );
      if (!state || new Date(state.first_detected_at).getTime() > Date.parse(observedCutoff))
        continue;

      const claimed = await db
        .prepare(
          `UPDATE linkedin_campaign_stall_alerts
         SET claimed_at=?::timestamptz
         WHERE workspace_id=? AND campaign_id=? AND seat_key=?
           AND (claimed_at IS NULL OR claimed_at<?::timestamptz)
           AND (last_notified_at IS NULL OR last_notified_at<?::timestamptz)
         RETURNING workspace_id`
        )
        .get<{ workspace_id: string }>(
          nowIso,
          candidate.workspace_id,
          candidate.campaign_id,
          candidate.seat_key,
          claimCutoff,
          reminderCutoff
        );
      if (!claimed) continue;
      try {
        const delivered = await notify(db, {
          workspaceId: candidate.workspace_id,
          campaignId: candidate.campaign_id,
          seatKey: candidate.seat_key,
          overdueCount: Number(candidate.due_count)
        });
        if (delivered) {
          await db
            .prepare(
              `UPDATE linkedin_campaign_stall_alerts SET last_notified_at=?::timestamptz,
                   claimed_at=NULL
             WHERE workspace_id=? AND campaign_id=? AND seat_key=? AND claimed_at=?::timestamptz`
            )
            .run(nowIso, candidate.workspace_id, candidate.campaign_id, candidate.seat_key, nowIso);
          alerted++;
        }
      } finally {
        // SMTP unavailable/failed: remain eligible for a later retry.
        await db
          .prepare(
            `UPDATE linkedin_campaign_stall_alerts SET claimed_at=NULL
           WHERE workspace_id=? AND campaign_id=? AND seat_key=?
             AND claimed_at=?::timestamptz`
          )
          .run(candidate.workspace_id, candidate.campaign_id, candidate.seat_key, nowIso);
      }
    } catch (error) {
      console.error('LinkedIn campaign stall monitoring failed for a campaign', error);
    }
  }
  return { candidates: candidates.length, eligible, alerted };
}
