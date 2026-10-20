import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import { emailComplianceProvider } from '../email/compliance.js';
import { evaluatePolicy, type PolicyDecision } from '../control-plane/policy.js';

interface Candidate {
  id: string;
  campaign_id: string;
  contact_id: string;
  connection_id: string | null;
  payload_json: unknown;
  mailbox_address: string | null;
  status: string;
}
export interface CampaignEmailReview {
  actionId: string;
  campaignId: string;
  recipient: string;
  subject: string;
  body: string;
  footer: string;
  sender: string | null;
  connectionId: string | null;
  tracking: string;
  threaded: boolean;
  contentHash: string;
  approved: boolean;
  policy: PolicyDecision;
}

function payloadObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function boundHash(parts: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['trevra:campaign-email:v1', ...parts]))
    .digest('hex');
}
const equalHash = (a: string, b: string): boolean =>
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

async function candidate(
  db: Db,
  workspaceId: string,
  actionId: string
): Promise<Candidate | undefined> {
  return db
    .prepare(
      `SELECT a.id,a.campaign_id,a.contact_id,a.connection_id,a.payload_json,a.status,
      cn.mailbox_address
    FROM linkedin_campaign_channel_actions a
    JOIN linkedin_campaigns c ON c.id=a.campaign_id AND c.workspace_id=a.workspace_id
    LEFT JOIN connections cn ON cn.id=a.connection_id AND cn.workspace_id=a.workspace_id
    WHERE a.workspace_id=? AND a.id=? AND a.kind='email' AND c.status='running'`
    )
    .get<Candidate>(workspaceId, actionId);
}

/** This same server-produced preview is what the operator reviews and what the
 * worker checks immediately before creating tracking tokens/provider side effects. */
export async function previewCampaignEmail(
  db: Db,
  workspaceId: string,
  actionId: string
): Promise<CampaignEmailReview | null> {
  const row = await candidate(db, workspaceId, actionId);
  if (!row || !['planned', 'claimed'].includes(row.status)) return null;
  const p = payloadObject(row.payload_json);
  const recipient = String(p.recipient ?? '').trim();
  const subject = String(p.subject ?? '').trim();
  const body = String(p.body ?? '').trim();
  const tracking = p.tracking === 'opens' || p.tracking === 'opens_clicks' ? p.tracking : 'off';
  const threaded = p.threaded === true;
  const sender = row.mailbox_address?.trim().toLowerCase() ?? null;
  const footer = (await emailComplianceProvider().footer(db, workspaceId))?.trim() ?? '';
  const contentHash = boundHash([
    workspaceId,
    row.id,
    row.campaign_id,
    row.contact_id,
    row.connection_id,
    sender,
    recipient,
    subject,
    body,
    footer,
    tracking,
    threaded
  ]);
  const policy = await evaluatePolicy(db, {
    workspaceId,
    action: 'action:email.send',
    actorType: 'system',
    sideEffect: 'external-write',
    attributes: { recipients: 1 }
  });
  const previous = await db
    .prepare(
      'SELECT content_hash FROM linkedin_campaign_email_approvals WHERE workspace_id=? AND action_id=?'
    )
    .get<{ content_hash: string }>(workspaceId, row.id);
  return {
    actionId: row.id,
    campaignId: row.campaign_id,
    recipient,
    subject,
    body,
    footer,
    sender,
    connectionId: row.connection_id,
    tracking,
    threaded,
    contentHash,
    approved: Boolean(previous && equalHash(previous.content_hash, contentHash)),
    policy
  };
}

export async function listCampaignEmailReviews(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<CampaignEmailReview[]> {
  const actionRows = await db
    .prepare(
      `SELECT a.id FROM linkedin_campaign_channel_actions a
     JOIN linkedin_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id
     WHERE a.workspace_id=? AND a.campaign_id=? AND a.kind='email'
       AND a.status IN ('planned','claimed') AND c.status='running'
     ORDER BY a.planned_for,a.id LIMIT 100`
    )
    .all<{ id: string }>(workspaceId, campaignId);
  const reviews = await Promise.all(
    actionRows.map((row) => previewCampaignEmail(db, workspaceId, row.id))
  );
  return reviews.filter((r): r is CampaignEmailReview => r !== null);
}

/** The owner approves only the digest they just saw. An edit to content, sender,
 * footer or tracking changes the digest and makes the approval unusable. */
export async function approveCampaignEmail(
  db: Db,
  workspaceId: string,
  actionId: string,
  hash: string,
  approvedBy: string,
  now: Date = new Date()
): Promise<CampaignEmailReview> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        "SELECT id FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=? AND kind='email' AND status='planned' FOR UPDATE"
      )
      .get<{ id: string }>(workspaceId, actionId);
    if (!locked) throw new Error('This email is not awaiting approval.');
    const review = await previewCampaignEmail(tx, workspaceId, actionId);
    if (
      !review ||
      !review.sender ||
      !review.recipient ||
      !review.subject ||
      !review.body ||
      !review.footer
    )
      throw new Error(
        'This email has incomplete content or sender details; it cannot be approved.'
      );
    if (!equalHash(hash, review.contentHash))
      throw new Error('The email changed since review; refresh before approving.');
    if (review.policy.effect === 'deny') throw new Error('Workspace policy denies this email.');
    await tx
      .prepare(
        `INSERT INTO linkedin_campaign_email_approvals(workspace_id,action_id,content_hash,approved_by,approved_at)
       VALUES (?,?,?,?,?::timestamptz)
       ON CONFLICT(workspace_id,action_id)
       DO UPDATE SET content_hash=EXCLUDED.content_hash,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at`
      )
      .run(workspaceId, actionId, hash, approvedBy, now.toISOString());
    // The next worker tick can re-check this email without waiting for an old hold.
    await tx
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET planned_for=?::timestamptz,last_error=NULL,updated_at=?::timestamptz WHERE workspace_id=? AND id=? AND status='planned'"
      )
      .run(now.toISOString(), now.toISOString(), workspaceId, actionId);
    return { ...review, approved: true };
  });
}

/** Called at the last safe pre-tracking step; default policy requires a human. */
export async function campaignEmailPolicyGate(
  db: Db,
  workspaceId: string,
  actionId: string
): Promise<{ allowed: boolean; reason: string; review: CampaignEmailReview | null }> {
  const review = await previewCampaignEmail(db, workspaceId, actionId);
  if (!review)
    return { allowed: false, reason: 'The email action is no longer current.', review: null };
  if (review.policy.effect === 'deny')
    return {
      allowed: false,
      reason: `Workspace policy denies campaign email: ${review.policy.policyName}.`,
      review
    };
  if (review.policy.effect === 'require_approval' && !review.approved)
    return {
      allowed: false,
      reason:
        'Review and approve the exact recipient, sender, message and tracking settings before campaign email can run.',
      review
    };
  return {
    allowed: true,
    reason: 'Allowed by current workspace policy and exact-message review.',
    review
  };
}
