import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { campaignExecutionState } from './execution-state.js';
import { reviewLinkedInAction } from './action-policy.js';
import { getManagedCampaign, seatWindowOpenNow } from './managed-campaigns.js';
import { getSeat } from './seats.js';
import { notifyLinkedInCampaignStalled } from '../notifications.js';

/** Do not call a quiet campaign stalled until approved work was due for two
 * actual hours and the safety gate was open both then and now. A single
 * timestamp in the past could be last night's or last weekend's slot. */
export const STALL_AGE_MS = 2 * 60 * 60_000;
const NOTIFICATION_INTERVAL_MS = 24 * 60 * 60_000;
const NOTIFICATION_LEASE_MS = 10 * 60_000;

export type StalledCampaign = {
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  seatKey: string;
  oldestDue: string;
  approvedDue: number;
};

/**
 * An approval row is not enough: approved copy can be edited after sign-off.
 * The runner recomputes the content hash before every send, so the watcher
 * must do the same or it will falsely alert about a row the executor cannot
 * legally run. Read-only: never creates action-policy audit events.
 *
 * Bounded to eight previously approved rows per campaign per scan. Returning
 * zero means "not enough evidence for a stall", not proof the queue is empty.
 */
export async function exactlyApprovedOverdueActions(
  db: Db,
  input: {
    workspaceId: string;
    campaignId: string;
    seatKey: string;
    cutoff: Date;
  }
): Promise<{ count: number; oldestDue: string | null }> {
  const rows = await db
    .prepare(
      `SELECT a.id,a.planned_for
     FROM linkedin_actions a JOIN linkedin_action_approvals approval
       ON approval.workspace_id=a.workspace_id AND approval.action_id=a.id
     WHERE a.workspace_id=? AND a.campaign_id=? AND a.seat_key=?
       AND a.status='planned' AND a.claimed_at IS NULL
       AND a.settlement_hold_at IS NULL AND a.target_ref IS NOT NULL
       AND a.planned_for IS NOT NULL AND a.planned_for<=?::timestamptz
     ORDER BY a.planned_for ASC, a.id ASC LIMIT 8`
    )
    .all<{ id: string; planned_for: Date | string }>(
      input.workspaceId,
      input.campaignId,
      input.seatKey,
      input.cutoff.toISOString()
    );
  const reviewed = await Promise.all(
    rows.map(async (row) => {
      const review = await reviewLinkedInAction(db, input.workspaceId, row.id);
      return review?.approved && review.policy.effect !== 'deny' ? row : null;
    })
  );
  const current = reviewed.filter((row): row is NonNullable<typeof row> => row !== null);
  return {
    count: current.length,
    oldestDue: current.length ? new Date(current[0]!.planned_for).toISOString() : null
  };
}

export async function findStalledLinkedInCampaigns(
  db: Db,
  now = new Date(),
  limit = 30
): Promise<StalledCampaign[]> {
  const cutoff = new Date(now.getTime() - STALL_AGE_MS).toISOString();
  const onlineCutoff = new Date(now.getTime() - 90_000).toISOString();
  const rows = await db
    .prepare(
      `
    SELECT a.workspace_id, a.campaign_id, c.name AS campaign_name,
           a.seat_key, MIN(a.planned_for) AS oldest_due,
           COUNT(DISTINCT a.id)::int AS approved_due
      FROM linkedin_actions a
      JOIN linkedin_campaigns c
        ON c.id=a.campaign_id AND c.workspace_id=a.workspace_id
      JOIN linkedin_seats s
        ON s.workspace_id=a.workspace_id AND s.seat_key=a.seat_key
      JOIN linkedin_action_approvals approval
        ON approval.workspace_id=a.workspace_id AND approval.action_id=a.id
     WHERE c.status='running' AND c.stop_requested_at IS NULL
       AND a.status='planned' AND a.claimed_at IS NULL
       AND a.settlement_hold_at IS NULL
       AND a.planned_for IS NOT NULL AND a.planned_for<=?::timestamptz
       AND a.target_ref IS NOT NULL
       AND s.posture NOT IN ('paused','cooldown') AND s.send_mode='automated'
       AND EXISTS (
         SELECT 1 FROM linkedin_companion_devices d
          WHERE d.workspace_id=a.workspace_id AND d.revoked_at IS NULL
            AND d.last_seen_at>=?::timestamptz
       )
       AND NOT EXISTS (
         SELECT 1 FROM linkedin_actions done
          WHERE done.workspace_id=a.workspace_id AND done.campaign_id=a.campaign_id
            AND done.status IN ('sent','accepted','replied')
            AND done.recorded_at>=?::timestamptz
       )
     GROUP BY a.workspace_id,a.campaign_id,c.name,a.seat_key
     ORDER BY MIN(a.planned_for),a.workspace_id,a.campaign_id
     LIMIT ?::int
  `
    )
    .all<{
      workspace_id: string;
      campaign_id: string;
      campaign_name: string;
      seat_key: string;
      oldest_due: string;
      approved_due: number;
    }>(cutoff, onlineCutoff, cutoff, Math.min(100, Math.max(1, Math.trunc(limit))));

  const stalled: StalledCampaign[] = [];
  for (const row of rows) {
    // Use the SAME safety gate used by the campaign details screen, at BOTH
    // ends of the two-hour interval. No notification for normal capacity,
    // account cooldowns, missing approvals, quiet hours or weekends.
    const [campaign, seat] = await Promise.all([
      getManagedCampaign(db, row.workspace_id, row.campaign_id),
      getSeat(db, row.workspace_id, row.seat_key)
    ]);
    if (
      !campaign ||
      !seat ||
      !seatWindowOpenNow(seat, campaign, now) ||
      !seatWindowOpenNow(seat, campaign, new Date(now.getTime() - STALL_AGE_MS))
    )
      continue;
    const [current, earlier] = await Promise.all([
      campaignExecutionState(db, row.workspace_id, row.campaign_id, now),
      campaignExecutionState(
        db,
        row.workspace_id,
        row.campaign_id,
        new Date(now.getTime() - STALL_AGE_MS)
      )
    ]);
    if (current.seatKey !== row.seat_key || earlier.seatKey !== row.seat_key) continue;
    if (current.humanSendNext || earlier.humanSendNext) continue;
    if (current.restingUntil || earlier.restingUntil) continue;
    if (!current.gate?.allowed || !earlier.gate?.allowed) continue;
    const exact = await exactlyApprovedOverdueActions(db, {
      workspaceId: row.workspace_id,
      campaignId: row.campaign_id,
      seatKey: row.seat_key,
      cutoff: new Date(now.getTime() - STALL_AGE_MS)
    });
    if (exact.count === 0 || !exact.oldestDue) continue;
    stalled.push({
      workspaceId: row.workspace_id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      seatKey: row.seat_key,
      oldestDue: exact.oldestDue,
      // Deliberately only the re-verified rows in this bounded sample; the
      // raw SQL join may include stale approvals or altered message bodies.
      approvedDue: exact.count
    });
  }
  return stalled;
}

/** Claims are durable across processes and shards. Failure to email releases
 * the lease so an outage doesn't get recorded as a successful alert. */
export async function notifyStalledLinkedInCampaigns(
  db: Db,
  options: {
    now?: Date;
    limit?: number;
    notify?: typeof notifyLinkedInCampaignStalled;
    find?: typeof findStalledLinkedInCampaigns;
  } = {}
): Promise<{ detected: number; notified: number; failed: number }> {
  const now = options.now ?? new Date();
  const notify = options.notify ?? notifyLinkedInCampaignStalled;
  const stalled = await (options.find ?? findStalledLinkedInCampaigns)(
    db,
    now,
    options.limit ?? 30
  );
  let notified = 0;
  let failed = 0;
  for (const campaign of stalled) {
    const token = randomUUID();
    const claimed = await db
      .prepare(
        `
      INSERT INTO linkedin_campaign_stall_notifications
        (workspace_id,campaign_id,claimed_at,claim_token)
      VALUES (?,?,?::timestamptz,?)
      ON CONFLICT (workspace_id,campaign_id) DO UPDATE
        SET claimed_at=excluded.claimed_at,claim_token=excluded.claim_token
      WHERE (linkedin_campaign_stall_notifications.last_notified_at IS NULL
             OR linkedin_campaign_stall_notifications.last_notified_at<?::timestamptz)
        AND (linkedin_campaign_stall_notifications.claimed_at IS NULL
             OR linkedin_campaign_stall_notifications.claimed_at<?::timestamptz)
      RETURNING campaign_id
    `
      )
      .get<{ campaign_id: string }>(
        campaign.workspaceId,
        campaign.campaignId,
        now.toISOString(),
        token,
        new Date(now.getTime() - NOTIFICATION_INTERVAL_MS).toISOString(),
        new Date(now.getTime() - NOTIFICATION_LEASE_MS).toISOString()
      );
    if (!claimed) continue;
    try {
      const delivered = await notify(db, {
        workspaceId: campaign.workspaceId,
        campaignName: campaign.campaignName,
        oldestDue: campaign.oldestDue,
        approvedDue: campaign.approvedDue
      });
      if (delivered) {
        await db
          .prepare(
            `UPDATE linkedin_campaign_stall_notifications
           SET last_notified_at=?::timestamptz,claimed_at=NULL,claim_token=NULL
           WHERE workspace_id=? AND campaign_id=? AND claim_token=?`
          )
          .run(now.toISOString(), campaign.workspaceId, campaign.campaignId, token);
        notified++;
      } else {
        await db
          .prepare(
            `UPDATE linkedin_campaign_stall_notifications
           SET claimed_at=NULL,claim_token=NULL
           WHERE workspace_id=? AND campaign_id=? AND claim_token=?`
          )
          .run(campaign.workspaceId, campaign.campaignId, token);
      }
    } catch (error) {
      failed++;
      await db
        .prepare(
          `UPDATE linkedin_campaign_stall_notifications
         SET claimed_at=NULL,claim_token=NULL
         WHERE workspace_id=? AND campaign_id=? AND claim_token=?`
        )
        .run(campaign.workspaceId, campaign.campaignId, token);
      console.error('LinkedIn campaign stall notification failed', error);
    }
  }
  return { detected: stalled.length, notified, failed };
}
