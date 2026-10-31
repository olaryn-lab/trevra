import type { Db } from '../db.js';
import {
  applyDecision,
  assertCredits,
  assertEntitlement,
  can,
  countEntitlementUsage,
  gateActive,
  lockEntitlement,
  type EntitlementView
} from './entitlements.js';

/**
 * The deterministic write boundaries the TRV-057 entitlement gate guards.
 * Each function runs INSIDE the transaction that performs the write, after
 * the entitlement's advisory lock, so the count it judges is the count the
 * write commits against. The view itself is loaded before the transaction
 * (it may call Billing); these functions do no network I/O.
 *
 * Only new expansion is guarded: activating a campaign, connecting a new
 * LinkedIn account, raising an account's daily volume, adding a teammate.
 * Pausing, stopping, editing, reading and already-approved work never pass
 * through here.
 *
 * Whether a denial blocks follows the rollout mode (see `applyDecision`):
 * only `enforce` throws; `observe` records it and the write proceeds.
 */

/**
 * A campaign is about to move into `running` from draft or paused. The limit
 * is on campaigns RUNNING at once and a paused campaign is not running, so
 * resuming is judged exactly like any start: it fits when the running count
 * plus this one is within the limit. Pausing frees the slot; resuming retakes
 * it unless another campaign was started into it meanwhile. Re-starting a
 * campaign that is already running never reaches this check.
 */
export async function assertCampaignActivation(
  tx: Db,
  view: EntitlementView,
  workspaceId: string
): Promise<void> {
  if (!gateActive(view)) return;
  await assertCredits(tx, view, workspaceId, 1);
  await assertEntitlement(tx, view, workspaceId, 'campaigns', { adding: 1 });
}

const SEAT_VOLUME_FIELDS = [
  ['dailyInviteLimit', 'daily_invite_limit'],
  ['dailyMessageLimit', 'daily_message_limit'],
  ['dailyProfileViewLimit', 'daily_profile_view_limit'],
  ['dailyFollowLimit', 'daily_follow_limit']
] as const;

export type SeatVolumePatch = Partial<
  Record<(typeof SEAT_VOLUME_FIELDS)[number][0], number | undefined>
>;

/**
 * A seat write: a new seat key consumes one `outreach_prepare` unit; raising
 * any daily ceiling of an existing seat is a volume expansion and needs the
 * workspace to be within its seat limit and to have credits. Lowering limits,
 * hours or labels is never blocked.
 */
export async function assertSeatWrite(
  tx: Db,
  view: EntitlementView,
  workspaceId: string,
  seatKey: string,
  patch: SeatVolumePatch
): Promise<void> {
  if (!gateActive(view)) return;
  await lockEntitlement(tx, workspaceId, 'outreach_prepare');
  const existing = await tx
    .prepare(
      `SELECT daily_invite_limit,daily_message_limit,daily_profile_view_limit,daily_follow_limit
       FROM linkedin_seats WHERE workspace_id=? AND seat_key=?`
    )
    .get<Record<(typeof SEAT_VOLUME_FIELDS)[number][1], number>>(workspaceId, seatKey);
  const seats = await countEntitlementUsage(tx, workspaceId, 'outreach_prepare');
  if (!existing) {
    await applyDecision(tx, view, workspaceId, can(view, 'outreach_prepare', seats + 1), seats);
    return;
  }
  const raises = SEAT_VOLUME_FIELDS.some(([field, column]) => {
    const next = patch[field];
    return typeof next === 'number' && next > Number(existing[column]);
  });
  if (!raises) return;
  await applyDecision(tx, view, workspaceId, can(view, 'outreach_prepare', seats), seats);
  await assertCredits(tx, view, workspaceId, 1);
}

/**
 * LinkedIn account detection for a seat key that does not exist yet. The seat
 * row is written later by the worker's detection job, outside any request
 * transaction, so this is a pre-check rather than count-under-lock: two
 * concurrent detections of two new keys could both pass. The locked check in
 * assertSeatWrite still guards every seat create and limit change.
 */
export async function assertNewSeatPrecheck(
  db: Db,
  view: EntitlementView,
  workspaceId: string,
  seatKey: string
): Promise<void> {
  if (!gateActive(view)) return;
  const existing = await db
    .prepare('SELECT 1 AS present FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
    .get<{ present: number }>(workspaceId, seatKey);
  if (existing) return;
  const seats = await countEntitlementUsage(db, workspaceId, 'outreach_prepare');
  await applyDecision(db, view, workspaceId, can(view, 'outreach_prepare', seats + 1), seats);
}

/**
 * A new invitation. Members plus unexpired pending invitations plus this one
 * must fit the `team` limit. `lock:false` is for the Better Auth hook, which
 * runs on its own connection; Trevra's own route takes the lock.
 *
 * Known gap: Better Auth 1.7 calls `beforeCreateInvitation` and then inserts
 * the invitation outside any transaction the hook can join, so two direct
 * Better Auth invites racing at the limit are not serialized. Trevra's own
 * POST /api/team/members holds the lock across the insert.
 */
export async function assertTeamInvite(
  db: Db,
  view: EntitlementView,
  workspaceId: string,
  options: { lock: boolean }
): Promise<void> {
  await assertEntitlement(db, view, workspaceId, 'team', { adding: 1, lock: options.lock });
}

/**
 * A member joining (invitation accepted, or a direct add). The invitation's
 * place was counted when it was created, so only current members count here;
 * this still refuses a join after a downgrade left the workspace over limit.
 */
export async function assertTeamJoin(
  db: Db,
  view: EntitlementView,
  workspaceId: string
): Promise<void> {
  await assertEntitlement(db, view, workspaceId, 'team', {
    adding: 1,
    lock: false,
    pendingInvitations: false
  });
}
