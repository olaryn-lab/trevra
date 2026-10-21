import { createHash, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import { evaluatePolicy, type PolicyDecision } from '../control-plane/policy.js';
import { getPost, loadPostImages, type LinkedInPost } from './posts.js';
import { renderPostBody } from '../../shared/linkedin-post-format.js';

export interface LinkedInPostReview {
  postId: string;
  seatKey: string;
  body: string;
  scheduledAt: string | null;
  media: Array<{ id: string; name: string; mimeType: string; digest: string }>;
  contentHash: string;
  approved: boolean;
  policy: PolicyDecision;
}
function compareHash(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}
function snapshotHash(post: LinkedInPost, media: LinkedInPostReview['media']): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'trevra:linkedin-post:v1',
        post.workspaceId,
        post.id,
        post.seatKey,
        post.blocks,
        post.scheduledAt,
        media.map((item) => [item.id, item.name, item.mimeType, item.digest])
      ])
    )
    .digest('hex');
}
async function readReview(
  db: Db,
  workspaceId: string,
  postId: string
): Promise<LinkedInPostReview | null> {
  const post = await getPost(db, workspaceId, postId);
  if (!post || !['scheduled', 'publishing'].includes(post.status)) return null;
  const images = await loadPostImages(db, workspaceId, postId);
  const media = images.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    digest: createHash('sha256').update(item.buffer).digest('hex')
  }));
  const policy = await evaluatePolicy(db, {
    workspaceId,
    action: 'action:linkedin.post.publish',
    actorType: 'system',
    sideEffect: 'external-write',
    attributes: { recipients: 1 }
  });
  const contentHash = snapshotHash(post, media);
  const grant = await db
    .prepare('SELECT content_hash FROM linkedin_post_approvals WHERE workspace_id=? AND post_id=?')
    .get<{ content_hash: string }>(workspaceId, postId);
  return {
    postId: post.id,
    seatKey: post.seatKey,
    body: renderPostBody(post.blocks),
    scheduledAt: post.scheduledAt,
    media,
    contentHash,
    policy,
    approved: Boolean(grant && compareHash(grant.content_hash, contentHash))
  };
}
export const reviewLinkedInPost = readReview;

async function audit(
  db: Db,
  workspaceId: string,
  review: LinkedInPostReview,
  decision: 'approved' | 'allowed' | 'denied' | 'held' | 'changed',
  actorId: string | null = null,
  now = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_post_policy_events
     (id,workspace_id,post_id,content_hash,decision,policy_name,policy_effect,actor_id,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?::timestamptz) ON CONFLICT DO NOTHING`
    )
    .run(
      id('lippe'),
      workspaceId,
      review.postId,
      review.contentHash,
      decision,
      review.policy.policyName,
      review.policy.effect,
      actorId,
      now.toISOString()
    );
}
/** Durable, workspace-scoped explanation of why this queued post did or did not publish. */
export async function listLinkedInPostPolicyEvents(db: Db, workspaceId: string, postId: string) {
  const rows = await db
    .prepare(
      `SELECT decision,content_hash,policy_name,actor_id,occurred_at
     FROM linkedin_post_policy_events WHERE workspace_id=? AND post_id=?
     ORDER BY occurred_at,id`
    )
    .all<{
      decision: string;
      content_hash: string;
      policy_name: string;
      actor_id: string | null;
      occurred_at: string;
    }>(workspaceId, postId);
  return rows.map((row) => ({
    decision: row.decision,
    contentHash: row.content_hash,
    policyName: row.policy_name,
    actorId: row.actor_id,
    occurredAt: new Date(row.occurred_at).toISOString()
  }));
}
export async function approveLinkedInPost(
  db: Db,
  workspaceId: string,
  postId: string,
  hash: string,
  actorId: string,
  now = new Date()
): Promise<LinkedInPostReview> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        "SELECT id FROM linkedin_posts WHERE workspace_id=? AND id=? AND status='scheduled' FOR UPDATE"
      )
      .get<{ id: string }>(workspaceId, postId);
    if (!locked) throw new Error('The scheduled post is no longer awaiting review.');
    const review = await readReview(tx, workspaceId, postId);
    if (!review) throw new Error('Post is no longer reviewable.');
    if (!compareHash(hash, review.contentHash))
      throw new Error('Post content or media changed; refresh before approving.');
    if (review.policy.effect === 'deny')
      throw new Error('Workspace policy denies post publishing.');
    await tx
      .prepare(
        `INSERT INTO linkedin_post_approvals(workspace_id,post_id,content_hash,approved_by,approved_at)
       VALUES (?,?,?,?,?::timestamptz) ON CONFLICT (workspace_id,post_id)
       DO UPDATE SET content_hash=EXCLUDED.content_hash,
          approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at`
      )
      .run(workspaceId, postId, hash, actorId, now.toISOString());
    await audit(tx, workspaceId, review, 'approved', actorId, now);
    return { ...review, approved: true };
  });
}
export async function linkedInPostPolicyGate(
  db: Db,
  workspaceId: string,
  claimed: LinkedInPost
): Promise<{ allowed: boolean; reason: string }> {
  const review = await readReview(db, workspaceId, claimed.id);
  if (!review) return { allowed: false, reason: 'Post no longer current or scheduled.' };
  const current = await getPost(db, workspaceId, claimed.id);
  const currentHash = current ? snapshotHash(current, review.media) : '';
  const claimedDigest = snapshotHash(claimed, review.media);
  const decide = async (
    decision: 'allowed' | 'denied' | 'held' | 'changed',
    allowed: boolean,
    reason: string
  ) => {
    // Failing to record the decision refuses execution before any provider call.
    await audit(db, workspaceId, review, decision);
    return { allowed, reason };
  };
  if (!current || current.status !== 'publishing' || currentHash !== claimedDigest)
    return decide('changed', false, 'Claimed post no longer matches the current published draft.');
  if (review.policy.effect === 'deny')
    return decide(
      'denied',
      false,
      `Workspace policy denies post publishing: ${review.policy.policyName}`
    );
  if (review.policy.effect === 'require_approval' && !review.approved)
    return decide('held', false, 'Workspace owner must approve the exact post text and images.');
  return decide('allowed', true, 'Post approved under current workspace policy.');
}
