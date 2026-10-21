import { createHash, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import { evaluatePolicy, type PolicyDecision } from '../control-plane/policy.js';

/** The same database snapshot is reviewed, hashed, and checked again at execution. */
interface ActionRow {
  id: string;
  workspace_id: string;
  campaign_id: string | null;
  seat_key: string;
  kind: string;
  target_ref: string | null;
  subject: string | null;
  body: string | null;
  thread_urn: string | null;
  attachment_json: unknown;
  channel_metadata_json: unknown;
  status: string;
}
export interface LinkedInActionReview {
  actionId: string;
  campaignId: string | null;
  seatKey: string;
  kind: string;
  targetRef: string;
  subject: string | null;
  body: string | null;
  threadUrn: string | null;
  hasAttachments: boolean;
  contentHash: string;
  approved: boolean;
  policy: PolicyDecision;
}
const equal = (left: string, right: string) =>
  /^[a-f0-9]{64}$/.test(left) &&
  /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)])
    );
  if (typeof value === 'string') {
    try {
      return stable(JSON.parse(value) as unknown);
    } catch {
      return value;
    }
  }
  return value;
}
async function rowFor(db: Db, workspaceId: string, id: string): Promise<ActionRow | undefined> {
  return db
    .prepare(
      `SELECT id,workspace_id,campaign_id,seat_key,kind,target_ref,subject,body,
            thread_urn,attachment_json,channel_metadata_json,status
     FROM linkedin_actions WHERE workspace_id=? AND id=? AND status='planned'`
    )
    .get<ActionRow>(workspaceId, id);
}
export async function reviewLinkedInAction(
  db: Db,
  workspaceId: string,
  actionId: string
): Promise<LinkedInActionReview | null> {
  const row = await rowFor(db, workspaceId, actionId);
  if (!row || !row.target_ref) return null;
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify([
        'trevra:linkedin-action:v1',
        row.workspace_id,
        row.id,
        row.campaign_id,
        row.seat_key,
        row.kind,
        row.target_ref,
        row.subject,
        row.body,
        row.thread_urn,
        stable(row.attachment_json),
        stable(row.channel_metadata_json)
      ])
    )
    .digest('hex');
  const policy = await evaluatePolicy(db, {
    workspaceId,
    action: `action:linkedin.${row.kind}`,
    actorType: 'system',
    sideEffect: row.kind === 'profile_view' ? 'network-read' : 'external-write',
    attributes: { recipients: 1 }
  });
  const grant = await db
    .prepare(
      'SELECT content_hash FROM linkedin_action_approvals WHERE workspace_id=? AND action_id=?'
    )
    .get<{ content_hash: string }>(workspaceId, actionId);
  return {
    actionId: row.id,
    campaignId: row.campaign_id,
    seatKey: row.seat_key,
    kind: row.kind,
    targetRef: row.target_ref,
    subject: row.subject,
    body: row.body,
    threadUrn: row.thread_urn,
    hasAttachments:
      row.attachment_json != null &&
      JSON.stringify(row.attachment_json) !== '{}' &&
      JSON.stringify(row.attachment_json) !== '[]',
    contentHash,
    approved: Boolean(grant && equal(grant.content_hash, contentHash)),
    policy
  };
}
export async function listLinkedInActionReviews(
  db: Db,
  workspaceId: string,
  campaignId?: string
): Promise<LinkedInActionReview[]> {
  // Skip completed approvals but continue scanning until a full page of
  // pending reviews is found: the 501st cannot disappear behind 500 approvals.
  const result: LinkedInActionReview[] = [];
  const pageSize = 200;
  let offset = 0;
  while (result.length < 100) {
    const ids = await db
      .prepare(
        `SELECT a.id FROM linkedin_actions a
       WHERE a.workspace_id=? AND a.status='planned' AND a.target_ref IS NOT NULL
         AND a.kind<>'profile_view'
         AND (?::text IS NULL OR a.campaign_id=?)
       ORDER BY a.planned_for NULLS LAST,a.id LIMIT ? OFFSET ?`
      )
      .all<{ id: string }>(workspaceId, campaignId ?? null, campaignId ?? null, pageSize, offset);
    if (!ids.length) break;
    const previews = await Promise.all(
      ids.map((row) => reviewLinkedInAction(db, workspaceId, row.id))
    );
    for (const review of previews) {
      if (!review) continue;
      if (
        review.policy.effect === 'deny' ||
        (review.policy.effect === 'require_approval' && !review.approved)
      )
        result.push(review);
      if (result.length === 100) break;
    }
    offset += ids.length;
    if (ids.length < pageSize) break;
  }
  return result;
}
async function recordPolicyEvent(
  db: Db,
  workspaceId: string,
  review: LinkedInActionReview,
  decision: 'approved' | 'allowed' | 'denied' | 'held' | 'changed',
  actorId: string | null = null,
  now = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_action_policy_events(
      id,workspace_id,action_id,content_hash,decision,policy_name,
      policy_effect,actor_id,occurred_at
    ) VALUES (?,?,?,?,?,?,?,?,?::timestamptz)
    ON CONFLICT DO NOTHING`
    )
    .run(
      id('liape'),
      workspaceId,
      review.actionId,
      review.contentHash,
      decision,
      review.policy.policyName,
      review.policy.effect,
      actorId,
      now.toISOString()
    );
}
export async function listLinkedInActionPolicyEvents(
  db: Db,
  workspaceId: string,
  actionId: string
): Promise<
  Array<{
    decision: string;
    contentHash: string;
    policyName: string;
    actorId: string | null;
    occurredAt: string;
  }>
> {
  const entries = await db
    .prepare(
      `SELECT decision,content_hash,policy_name,actor_id,occurred_at
      FROM linkedin_action_policy_events
      WHERE workspace_id=? AND action_id=?
      ORDER BY occurred_at,id`
    )
    .all<{
      decision: string;
      content_hash: string;
      policy_name: string;
      actor_id: string | null;
      occurred_at: string;
    }>(workspaceId, actionId);
  return entries.map((row) => ({
    decision: row.decision,
    contentHash: row.content_hash,
    policyName: row.policy_name,
    actorId: row.actor_id,
    occurredAt: new Date(row.occurred_at).toISOString()
  }));
}
export async function approveLinkedInAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  contentHash: string,
  approvedBy: string,
  now = new Date()
): Promise<LinkedInActionReview> {
  return db.transaction(async (tx) => {
    await tx
      .prepare(
        "SELECT id FROM linkedin_actions WHERE workspace_id=? AND id=? AND status='planned' FOR UPDATE"
      )
      .get<{ id: string }>(workspaceId, actionId)
      .then((row) => {
        if (!row) throw new Error('This action is no longer awaiting review.');
      });
    const review = await reviewLinkedInAction(tx, workspaceId, actionId);
    if (!review) throw new Error('Action not found or not reviewable.');
    if (!equal(contentHash, review.contentHash))
      throw new Error('This action changed since review; refresh before approving.');
    if (review.policy.effect === 'deny') throw new Error('Workspace policy denies this action.');
    await tx
      .prepare(
        `INSERT INTO linkedin_action_approvals(workspace_id,action_id,content_hash,approved_by,approved_at)
       VALUES (?,?,?,?,?::timestamptz)
       ON CONFLICT (workspace_id,action_id)
       DO UPDATE SET content_hash=EXCLUDED.content_hash,approved_by=EXCLUDED.approved_by,
                     approved_at=EXCLUDED.approved_at`
      )
      .run(workspaceId, actionId, contentHash, approvedBy, now.toISOString());
    await recordPolicyEvent(tx, workspaceId, review, 'approved', approvedBy, now);
    return { ...review, approved: true };
  });
}
export async function linkedinActionPolicyGate(
  db: Db,
  workspaceId: string,
  actionId: string,
  expected?: {
    kind: string;
    seatKey: string;
    targetRef: string;
    body: string | null;
    subject?: string | null;
    threadUrn?: string | null;
    attachment?: unknown;
    channelMetadata?: unknown;
  }
): Promise<{ allowed: boolean; reason: string }> {
  const review = await reviewLinkedInAction(db, workspaceId, actionId);
  if (!review) return { allowed: false, reason: 'LinkedIn action no longer pending or current.' };
  const finish = async (
    decision: 'allowed' | 'denied' | 'held' | 'changed',
    allowed: boolean,
    reason: string
  ) => {
    // A permitted write without an audit is a refusal, never an exception.
    await recordPolicyEvent(db, workspaceId, review, decision);
    return { allowed, reason };
  };
  if (expected) {
    const row = await rowFor(db, workspaceId, actionId);
    if (
      !row ||
      row.kind !== expected.kind ||
      row.seat_key !== expected.seatKey ||
      row.target_ref !== expected.targetRef ||
      row.body !== expected.body ||
      row.subject !== (expected.subject ?? null) ||
      row.thread_urn !== (expected.threadUrn ?? null) ||
      JSON.stringify(stable(row.attachment_json)) !==
        JSON.stringify(stable(expected.attachment ?? null)) ||
      JSON.stringify(stable(row.channel_metadata_json)) !==
        JSON.stringify(stable(expected.channelMetadata ?? {}))
    )
      return finish(
        'changed',
        false,
        'The claimed LinkedIn action changed after it was read; nothing sent.'
      );
  }
  if (review.policy.effect === 'deny')
    return finish(
      'denied',
      false,
      `Workspace policy denies ${review.kind}: ${review.policy.policyName}`
    );
  if (review.policy.effect === 'require_approval' && !review.approved)
    return finish(
      'held',
      false,
      `Workspace owner must approve the exact ${review.kind} action before its browser write.`
    );
  return finish('allowed', true, 'Allowed by workspace policy and exact action review.');
}
