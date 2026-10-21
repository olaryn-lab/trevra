import { createHash, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import { evaluatePolicy, type PolicyDecision } from '../control-plane/policy.js';
import { threadUrlFor, type RedditDriverResult } from './driver.js';

export type RedditCommentStatus = 'prepared' | 'executing' | 'posted' | 'failed' | 'unknown';
interface CommentRow {
  id: string;
  workspace_id: string;
  thread_url: string;
  body: string;
  content_hash: string;
  status: RedditCommentStatus;
  approved_by: string | null;
  approved_at: string | null;
  external_ref: string | null;
  failure_kind: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}
export interface RedditCommentReview {
  id: string;
  threadUrl: string;
  body: string;
  contentHash: string;
  status: RedditCommentStatus;
  approved: boolean;
  approvedBy: string | null;
  externalRef: string | null;
  failureKind: string | null;
  detail: string | null;
  policy: PolicyDecision;
}
const hashFor = (workspaceId: string, threadUrl: string, body: string) =>
  createHash('sha256')
    .update(JSON.stringify(['trevra:reddit-comment:v1', workspaceId, threadUrl, body]))
    .digest('hex');
const equal = (left: string, right: string) =>
  /^[0-9a-f]{64}$/.test(left) &&
  /^[0-9a-f]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
async function rowFor(db: Db, workspaceId: string, commentId: string) {
  return db
    .prepare('SELECT * FROM reddit_comment_actions WHERE workspace_id=? AND id=?')
    .get<CommentRow>(workspaceId, commentId);
}
async function decision(db: Db, workspaceId: string) {
  return evaluatePolicy(db, {
    workspaceId,
    action: 'action:reddit.comment',
    actorType: 'system',
    sideEffect: 'external-write',
    attributes: { recipients: 1 }
  });
}
function reviewRow(row: CommentRow, policy: PolicyDecision): RedditCommentReview {
  return {
    id: row.id,
    threadUrl: row.thread_url,
    body: row.body,
    contentHash: row.content_hash,
    status: row.status,
    approved: Boolean(row.approved_by && row.approved_at),
    approvedBy: row.approved_by,
    externalRef: row.external_ref,
    failureKind: row.failure_kind,
    detail: row.detail,
    policy
  };
}
async function audit(
  db: Db,
  workspaceId: string,
  review: RedditCommentReview,
  event: 'approved' | 'allowed' | 'denied' | 'held',
  actorId: string | null = null,
  now = new Date()
) {
  await db
    .prepare(
      `INSERT INTO reddit_comment_policy_events
    (id,workspace_id,comment_id,content_hash,decision,policy_name,
     policy_effect,actor_id,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?::timestamptz) ON CONFLICT DO NOTHING`
    )
    .run(
      id('rcpev'),
      workspaceId,
      review.id,
      review.contentHash,
      event,
      review.policy.policyName,
      review.policy.effect,
      actorId,
      now.toISOString()
    );
}
export async function prepareRedditComment(
  db: Db,
  workspaceId: string,
  input: { url: string; body: string },
  now = new Date()
): Promise<RedditCommentReview> {
  const url = threadUrlFor(input.url);
  const body = input.body.trim();
  if (!url) throw new Error('A canonical reddit.com comment thread URL is required.');
  if (!body || body.length > 10000)
    throw new Error('Comment body must be between 1 and 10,000 characters.');
  const contentHash = hashFor(workspaceId, url, body);
  // The unique exact-payload index also prevents concurrent double submissions.
  const written = await db
    .prepare(
      `INSERT INTO reddit_comment_actions
     (id,workspace_id,thread_url,body,content_hash,created_at,updated_at)
     VALUES (?,?,?,?,?,?::timestamptz,?::timestamptz)
     ON CONFLICT (workspace_id,content_hash) DO NOTHING RETURNING id`
    )
    .get<{ id: string }>(
      id('rca'),
      workspaceId,
      url,
      body,
      contentHash,
      now.toISOString(),
      now.toISOString()
    );
  const row = written
    ? await rowFor(db, workspaceId, written.id)
    : await db
        .prepare('SELECT * FROM reddit_comment_actions WHERE workspace_id=? AND content_hash=?')
        .get<CommentRow>(workspaceId, contentHash);
  if (!row) throw new Error('Unable to store the prepared Reddit comment.');
  return reviewRow(row, await decision(db, workspaceId));
}
export async function getRedditCommentReview(db: Db, workspaceId: string, commentId: string) {
  const row = await rowFor(db, workspaceId, commentId);
  return row ? reviewRow(row, await decision(db, workspaceId)) : null;
}
export async function listRedditComments(db: Db, workspaceId: string) {
  const rows = await db
    .prepare(
      `SELECT * FROM reddit_comment_actions WHERE workspace_id=?
       AND status IN ('prepared','executing','unknown','failed')
       ORDER BY created_at DESC,id DESC LIMIT 100`
    )
    .all<CommentRow>(workspaceId);
  const policy = await decision(db, workspaceId);
  return rows.map((row) => reviewRow(row, policy));
}
export async function approveRedditComment(
  db: Db,
  workspaceId: string,
  commentId: string,
  contentHash: string,
  actorId: string,
  now = new Date()
) {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(`SELECT * FROM reddit_comment_actions WHERE workspace_id=? AND id=? FOR UPDATE`)
      .get<CommentRow>(workspaceId, commentId);
    if (!row) return null;
    if (row.status !== 'prepared') throw new Error('The comment is no longer awaiting approval.');
    if (!equal(row.content_hash, contentHash))
      throw new Error('The comment changed; refresh and review the exact payload.');
    const policy = await decision(tx, workspaceId);
    if (policy.effect === 'deny') throw new Error('Workspace policy denies Reddit comments.');
    await tx
      .prepare(
        `UPDATE reddit_comment_actions SET approved_by=?,approved_at=?::timestamptz,
        updated_at=?::timestamptz WHERE workspace_id=? AND id=?`
      )
      .run(actorId, now.toISOString(), now.toISOString(), workspaceId, commentId);
    const review = reviewRow(
      { ...row, approved_by: actorId, approved_at: now.toISOString() },
      policy
    );
    await audit(tx, workspaceId, review, 'approved', actorId, now);
    return review;
  });
}
export async function listRedditCommentEvents(db: Db, workspaceId: string, commentId: string) {
  return db
    .prepare(
      `SELECT decision,content_hash,policy_name,policy_effect,actor_id,occurred_at
    FROM reddit_comment_policy_events WHERE workspace_id=? AND comment_id=?
    ORDER BY occurred_at,id`
    )
    .all<{
      decision: string;
      content_hash: string;
      policy_name: string;
      policy_effect: string;
      actor_id: string | null;
      occurred_at: string;
    }>(workspaceId, commentId);
}
export type RedditSendResult =
  | { ok: true; result: RedditDriverResult }
  | { ok: false; blocked: string; result?: RedditDriverResult };
export async function executeRedditComment(
  db: Db,
  workspaceId: string,
  commentId: string,
  send: (payload: { threadUrl: string; body: string }) => Promise<RedditSendResult>,
  now = new Date()
): Promise<{
  status: RedditCommentStatus;
  posted: boolean;
  externalRef: string | null;
  reason: string | null;
}> {
  const claim = await db.transaction(async (tx) => {
    const row = await tx
      .prepare('SELECT * FROM reddit_comment_actions WHERE workspace_id=? AND id=? FOR UPDATE')
      .get<CommentRow>(workspaceId, commentId);
    if (!row) return { kind: 'missing' as const };
    if (row.status === 'posted') return { kind: 'posted' as const, externalRef: row.external_ref };
    if (row.status !== 'prepared') return { kind: 'stopped' as const, status: row.status };
    const policy = await decision(tx, workspaceId);
    const review = reviewRow(row, policy);
    if (policy.effect === 'deny') {
      await audit(tx, workspaceId, review, 'denied');
      return { kind: 'blocked' as const, reason: 'Workspace policy denies Reddit comments.' };
    }
    if (policy.effect === 'require_approval' && !review.approved) {
      await audit(tx, workspaceId, review, 'held');
      return {
        kind: 'blocked' as const,
        reason: 'Owner must approve this exact comment before posting.'
      };
    }
    await audit(tx, workspaceId, review, 'allowed');
    await tx
      .prepare(
        `UPDATE reddit_comment_actions SET status='executing',updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status='prepared'`
      )
      .run(now.toISOString(), workspaceId, commentId);
    return { kind: 'execute' as const, threadUrl: row.thread_url, body: row.body };
  });
  if (claim.kind === 'missing') throw new Error('Reddit comment not found in this workspace.');
  if (claim.kind === 'posted')
    return { status: 'posted', posted: true, externalRef: claim.externalRef, reason: null };
  if (claim.kind === 'stopped')
    return {
      status: claim.status,
      posted: false,
      externalRef: null,
      reason: 'Comment already attempted; reconcile the result manually rather than retrying.'
    };
  if (claim.kind === 'blocked')
    return { status: 'prepared', posted: false, externalRef: null, reason: claim.reason };
  // Once claimed, ANY uncertainty must not retry externally. A crash leaves
  // 'executing', while ambiguous driver answers persist as 'unknown'.
  let result: RedditSendResult;
  try {
    result = await send({ threadUrl: claim.threadUrl, body: claim.body });
  } catch {
    result = {
      ok: false,
      blocked: 'Browser outcome unknown. Check the thread before retrying.',
      result: { ok: false, failureKind: 'unknown' }
    };
  }
  const status: RedditCommentStatus = result.ok
    ? 'posted'
    : result.result?.failureKind === 'unknown'
      ? 'unknown'
      : 'failed';
  const externalRef = result.ok ? (result.result.externalRef ?? claim.threadUrl) : null;
  const reason = result.ok ? null : result.blocked;
  await db
    .prepare(
      `UPDATE reddit_comment_actions
     SET status=?,external_ref=?,failure_kind=?,detail=?,updated_at=?::timestamptz
     WHERE workspace_id=? AND id=? AND status='executing'`
    )
    .run(
      status,
      externalRef,
      result.ok ? null : (result.result?.failureKind ?? 'not_sent'),
      reason,
      now.toISOString(),
      workspaceId,
      commentId
    );
  return { status, posted: result.ok, externalRef, reason };
}
