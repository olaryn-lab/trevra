import { createHash, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import { evaluatePolicy, type PolicyDecision } from '../control-plane/policy.js';
import type { ClaimedWithdrawal } from './withdraw.js';

interface Row {
  id: string;
  workspace_id: string;
  seat_key: string;
  action_id: string;
  target_ref: string;
  pending_days: number | null;
  claimed_at: string | null;
  status: string;
  invite_status: string | null;
  invite_target: string | null;
}
export interface WithdrawalReview {
  withdrawalId: string;
  seatKey: string;
  actionId: string;
  targetRef: string;
  pendingDays: number | null;
  contentHash: string;
  approved: boolean;
  policy: PolicyDecision;
}
const equal = (a: string, b: string): boolean =>
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

async function current(
  db: Db,
  workspaceId: string,
  withdrawalId: string
): Promise<Row | undefined> {
  return db
    .prepare(
      `SELECT w.id,w.workspace_id,w.seat_key,w.action_id,w.target_ref,
            w.pending_days,w.claimed_at,w.status,a.status AS invite_status,
            a.target_ref AS invite_target
     FROM linkedin_withdrawals w
     LEFT JOIN linkedin_actions a ON a.id=w.action_id
       AND a.workspace_id=w.workspace_id AND a.seat_key=w.seat_key
       AND a.kind='invite'
     WHERE w.workspace_id=? AND w.id=? AND w.status='queued'`
    )
    .get<Row>(workspaceId, withdrawalId);
}
export async function reviewWithdrawal(
  db: Db,
  workspaceId: string,
  withdrawalId: string
): Promise<WithdrawalReview | null> {
  const row = await current(db, workspaceId, withdrawalId);
  if (
    !row ||
    !row.invite_status ||
    !['sent', 'exported'].includes(row.invite_status) ||
    !row.invite_target ||
    row.invite_target !== row.target_ref
  )
    return null;
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify([
        'trevra:linkedin-withdrawal:v1',
        row.workspace_id,
        row.id,
        row.seat_key,
        row.action_id,
        row.target_ref,
        row.pending_days,
        row.invite_status,
        row.invite_target
      ])
    )
    .digest('hex');
  const policy = await evaluatePolicy(db, {
    workspaceId,
    action: 'action:linkedin.withdraw',
    actorType: 'system',
    sideEffect: 'external-write',
    attributes: { recipients: 1 }
  });
  const grant = await db
    .prepare(
      'SELECT content_hash FROM linkedin_withdrawal_approvals WHERE workspace_id=? AND withdrawal_id=?'
    )
    .get<{ content_hash: string }>(workspaceId, withdrawalId);
  return {
    withdrawalId: row.id,
    seatKey: row.seat_key,
    actionId: row.action_id,
    targetRef: row.target_ref,
    pendingDays: row.pending_days,
    contentHash,
    policy,
    approved: Boolean(grant && equal(grant.content_hash, contentHash))
  };
}
async function audit(
  db: Db,
  workspaceId: string,
  review: WithdrawalReview,
  decision: 'approved' | 'allowed' | 'denied' | 'held' | 'changed',
  actor: string | null = null,
  now = new Date()
) {
  await db
    .prepare(
      `INSERT INTO linkedin_withdrawal_policy_events
     (id,workspace_id,withdrawal_id,content_hash,decision,policy_name,policy_effect,actor_id,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?::timestamptz) ON CONFLICT DO NOTHING`
    )
    .run(
      id('liwpe'),
      workspaceId,
      review.withdrawalId,
      review.contentHash,
      decision,
      review.policy.policyName,
      review.policy.effect,
      actor,
      now.toISOString()
    );
}
export async function listWithdrawalPolicyEvents(
  db: Db,
  workspaceId: string,
  withdrawalId: string
): Promise<
  Array<{
    decision: string;
    contentHash: string;
    policyName: string;
    actorId: string | null;
    occurredAt: string;
  }>
> {
  const rows = await db
    .prepare(
      `SELECT decision,content_hash,policy_name,actor_id,occurred_at
      FROM linkedin_withdrawal_policy_events
      WHERE workspace_id=? AND withdrawal_id=? ORDER BY occurred_at,id`
    )
    .all<{
      decision: string;
      content_hash: string;
      policy_name: string;
      actor_id: string | null;
      occurred_at: string;
    }>(workspaceId, withdrawalId);
  return rows.map((row) => ({
    decision: row.decision,
    contentHash: row.content_hash,
    policyName: row.policy_name,
    actorId: row.actor_id,
    occurredAt: new Date(row.occurred_at).toISOString()
  }));
}
export async function approveWithdrawal(
  db: Db,
  workspaceId: string,
  withdrawalId: string,
  contentHash: string,
  actorId: string,
  now = new Date()
): Promise<WithdrawalReview> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        `SELECT id FROM linkedin_withdrawals
       WHERE workspace_id=? AND id=? AND status='queued' AND claimed_at IS NULL FOR UPDATE`
      )
      .get<{ id: string }>(workspaceId, withdrawalId);
    if (!locked) throw new Error('This withdrawal is no longer awaiting review.');
    const review = await reviewWithdrawal(tx, workspaceId, withdrawalId);
    if (!review) throw new Error('The invite is no longer pending.');
    if (!equal(contentHash, review.contentHash))
      throw new Error('The invite or withdrawal changed; refresh before approving.');
    if (review.policy.effect === 'deny') throw new Error('Workspace policy denies withdrawals.');
    await tx
      .prepare(
        `INSERT INTO linkedin_withdrawal_approvals(workspace_id,withdrawal_id,content_hash,approved_by,approved_at)
       VALUES (?,?,?,?,?::timestamptz)
       ON CONFLICT (workspace_id,withdrawal_id)
       DO UPDATE SET content_hash=EXCLUDED.content_hash,
                     approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at`
      )
      .run(workspaceId, withdrawalId, contentHash, actorId, now.toISOString());
    await audit(tx, workspaceId, review, 'approved', actorId, now);
    return { ...review, approved: true };
  });
}
export async function listPendingWithdrawalReviews(
  db: Db,
  workspaceId: string
): Promise<WithdrawalReview[]> {
  const result: WithdrawalReview[] = [];
  const pageSize = 200;
  let offset = 0;
  while (result.length < 100) {
    const page = await db
      .prepare(
        `SELECT id FROM linkedin_withdrawals WHERE workspace_id=? AND status='queued'
         ORDER BY queued_at DESC,id DESC LIMIT ? OFFSET ?`
      )
      .all<{ id: string }>(workspaceId, pageSize, offset);
    if (!page.length) break;
    const reviews = await Promise.all(page.map((row) => reviewWithdrawal(db, workspaceId, row.id)));
    for (const review of reviews) {
      if (!review) continue;
      if (
        review.policy.effect === 'deny' ||
        (review.policy.effect === 'require_approval' && !review.approved)
      )
        result.push(review);
      if (result.length === 100) break;
    }
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return result;
}
export async function withdrawalPolicyGate(
  db: Db,
  workspaceId: string,
  claimed: ClaimedWithdrawal
): Promise<{ allowed: boolean; reason: string }> {
  const review = await reviewWithdrawal(db, workspaceId, claimed.id);
  if (!review)
    return { allowed: false, reason: 'Withdrawal no longer matches an outstanding invite.' };
  const row = await current(db, workspaceId, claimed.id);
  const decide = async (
    decision: 'allowed' | 'denied' | 'held' | 'changed',
    allowed: boolean,
    reason: string
  ) => {
    await audit(db, workspaceId, review, decision);
    return { allowed, reason };
  };
  if (
    !row ||
    row.claimed_at === null ||
    row.seat_key !== claimed.seatKey ||
    row.action_id !== claimed.actionId ||
    row.target_ref !== claimed.targetRef ||
    row.pending_days !== claimed.pendingDays
  )
    return decide('changed', false, 'Claimed withdrawal does not match the queued action.');
  if (review.policy.effect === 'deny')
    return decide(
      'denied',
      false,
      `Workspace policy denies withdrawals: ${review.policy.policyName}`
    );
  if (review.policy.effect === 'require_approval' && !review.approved)
    return decide('held', false, 'Owner approval required for this exact invite withdrawal.');
  return decide('allowed', true, 'Current workspace policy allows this exact withdrawal.');
}
