import { z } from 'zod';
import type { Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { listSendingMailboxes, resolveMailboxAddress } from '../email/mailbox-address.js';
import { emailComplianceProvider } from '../email/compliance.js';
import { projectPreparedConversationEmail } from '../conversations.js';
import { communityReplyPayloadSchema, publishCommunityReply } from '../outreach/publish.js';
import { crmActivityPayloadSchema, logCrmActivity } from '../crm/activity.js';
import { bufferDraftPayloadSchema, createBufferDraft } from '../content/buffer.js';
/**
 * External execution is intentionally a closed GTM action set.
 *
 * Trevra is not a generic webhook/action runtime. Adding a new action here means
 * adding a named GTM capability with its own payload schema, approval semantics,
 * execution adapter, and tests. Arbitrary action names are rejected.
 */
export const EXECUTION_ACTION_TYPES = [
  'email.send',
  'community.reply',
  'crm.log-activity',
  'buffer.create-draft'
] as const;
export type ExecutionActionType = (typeof EXECUTION_ACTION_TYPES)[number];
const actionTypeSchema = z.enum(EXECUTION_ACTION_TYPES);

const emailPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional()
});

export async function executePreparedPlaybookAction(
  db: Db,
  input: {
    workspaceId: string;
    actionType: ExecutionActionType | string;
    payload: unknown;
    payloadHash: string;
  }
): Promise<{ provider: string; externalRef: string; actionType: ExecutionActionType }> {
  const actionType = actionTypeSchema.parse(input.actionType);

  if (actionType === 'email.send') {
    const payload = emailPayloadSchema.parse(input.payload);
    const metadata = payload.metadata ?? {};
    const approvedConnectionId = await approvedMailboxConnection(db, input.workspaceId, metadata);
    if (metadata.intent === 'email-outreach') {
      // Outreach never falls through to the newest-mailbox fallback.
      if (!approvedConnectionId) {
        throw mailboxBindingError(
          'This outreach email was approved without a sending mailbox; nothing was sent.'
        );
      }
      await assertOutreachFooter(db, input.workspaceId, payload.body);
    }
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      ...(approvedConnectionId
        ? { connection_id: approvedConnectionId, require_connection_id: true }
        : {}),
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify(metadata),
      payload_hash: input.payloadHash
    });
    const conversationId =
      typeof metadata.conversationId === 'string' ? metadata.conversationId : '';
    const personId = typeof metadata.personId === 'string' ? metadata.personId : '';
    const recommendationId =
      typeof metadata.recommendationId === 'string' ? metadata.recommendationId.trim() : '';
    if (conversationId && personId) {
      // The provider write has already succeeded. Shared Conversation is a
      // projection, so a projection failure must never turn this into a retry
      // of an external email side effect.
      try {
        await projectPreparedConversationEmail(db, {
          workspaceId: input.workspaceId,
          conversationId,
          personId,
          provider: delivery.provider,
          externalRef: delivery.externalRef,
          recipient: payload.recipient,
          subject: payload.subject,
          body: payload.body,
          payloadHash: input.payloadHash,
          actorType: 'system',
          sourceType:
            recommendationId && metadata.conversationSourceType === 'conversation_reply'
              ? 'qualified_demand_reply'
              : typeof metadata.conversationSourceType === 'string'
                ? metadata.conversationSourceType
                : null,
          sourceId:
            recommendationId && metadata.conversationSourceType === 'conversation_reply'
              ? recommendationId
              : typeof metadata.conversationSourceId === 'string'
                ? metadata.conversationSourceId
                : null
        });
      } catch {
        /* idempotent derived-state projection can be reconciled later */
      }
    }
    if (recommendationId) {
      // Approval is permission, not an outcome. Close the recommendation only
      // after the provider confirms the external write.
      await db
        .prepare(
          "UPDATE recommendations SET status='completed',updated_at=? WHERE workspace_id=? AND id=? AND type='qualified_demand'"
        )
        .run(new Date().toISOString(), input.workspaceId, recommendationId);
    }
    return { ...delivery, actionType };
  }

  if (actionType === 'community.reply') {
    const payload = communityReplyPayloadSchema.parse(input.payload);
    const now = new Date();
    const outcome = await publishCommunityReply(
      db,
      input.workspaceId,
      payload,
      input.payloadHash,
      now
    );

    // CRM mirroring happens after the public reply. It is best-effort so a CRM
    // outage can never cause Trevra to retry an external write that already happened.
    await recordOutreachInCrm(db, input.workspaceId, payload, outcome, now);
    return { provider: outcome.provider, externalRef: outcome.externalRef, actionType };
  }

  if (actionType === 'buffer.create-draft') {
    const payload = bufferDraftPayloadSchema.parse(input.payload);
    const result = await createBufferDraft(db, input.workspaceId, payload, input.payloadHash);
    return { provider: result.provider, externalRef: result.externalRef, actionType };
  }

  const payload = crmActivityPayloadSchema.parse(input.payload);
  const result = await logCrmActivity(db, input.workspaceId, payload, new Date());
  if (result.status === 'failed') throw new Error(result.reason ?? 'CRM activity write failed');
  return {
    provider: result.provider ?? 'none',
    externalRef: result.externalRef ?? `skipped:${result.reason ?? 'no CRM contact'}`,
    actionType
  };
}

/**
 * Mirror a delivered community reply into the CRM, if one is connected and the
 * thread author is somebody it already knows. Trevra never creates a contact
 * merely to have somewhere to write an activity.
 */
async function recordOutreachInCrm(
  db: Db,
  workspaceId: string,
  payload: z.infer<typeof communityReplyPayloadSchema>,
  outcome: { status: string; postId: string },
  now: Date
): Promise<void> {
  try {
    const metadata = payload.metadata ?? {};
    const author = typeof metadata.threadAuthor === 'string' ? metadata.threadAuthor : null;
    const threadTitle =
      typeof metadata.threadTitle === 'string' ? metadata.threadTitle : payload.threadUrl;
    const verb = outcome.status === 'posted' ? 'Replied' : 'Reply prepared';

    await logCrmActivity(
      db,
      workspaceId,
      {
        contact: { handle: author, handleProvider: payload.platform, email: null, domain: null },
        activityType: 'community_reply',
        subject: `${verb} on ${payload.platform}: ${threadTitle}`.slice(0, 300),
        body: payload.body,
        url: payload.threadUrl,
        occurredAt: now.toISOString(),
        sourceType: 'outreach_post',
        sourceId: outcome.postId
      },
      now
    );
  } catch {
    // Swallowed on purpose. The external reply has already happened.
  }
}

function mailboxBindingError(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The local connection an approved email must leave from, or null when the
 * approval named no sender (conversation replies and the older email playbooks
 * keep their existing mailbox resolution). The approval bound both the
 * connection and the address it sends as. If either no longer holds, nothing is
 * sent: a re-authorized connection may now be a different account.
 */
async function approvedMailboxConnection(
  db: Db,
  workspaceId: string,
  metadata: Record<string, unknown>
): Promise<string | null> {
  if (absent(metadata.connectionId) && absent(metadata.senderAddress)) return null;
  const connectionId =
    typeof metadata.connectionId === 'string' ? metadata.connectionId.trim() : '';
  const senderAddress =
    typeof metadata.senderAddress === 'string' ? metadata.senderAddress.trim().toLowerCase() : '';
  if (!connectionId || !senderAddress) {
    throw mailboxBindingError(
      'This email was approved without a complete sending mailbox; nothing was sent.'
    );
  }
  const mailbox = (await listSendingMailboxes(db, workspaceId)).find(
    (candidate) => candidate.connectionId === connectionId
  );
  if (!mailbox) {
    throw mailboxBindingError(
      `The mailbox this email was approved to send from (${senderAddress}) is no longer connected; nothing was sent.`
    );
  }
  const address = await resolveMailboxAddress(db, workspaceId, mailbox);
  if (address === null) {
    throw mailboxBindingError(
      'Trevra could not confirm the address of the approved sending mailbox right now; nothing was sent. Prepare this email again.'
    );
  }
  if (address !== senderAddress) {
    throw mailboxBindingError(
      `The connected mailbox no longer matches the approved sender ${senderAddress}; nothing was sent.`
    );
  }
  return mailbox.connectionId;
}

/**
 * Outreach email leaves only with the sender's compliance footer (legal name,
 * postal address, opt-out line) as its last text. The footer is re-read at send
 * time, not trusted from drafting: the approval flow can edit the body, and this
 * is the check that makes the footer non-removable. Runs before any delivery
 * row or provider call.
 */
async function assertOutreachFooter(db: Db, workspaceId: string, body: string): Promise<void> {
  const footer = (await emailComplianceProvider().footer(db, workspaceId))?.trim() ?? '';
  if (!footer) {
    throw mailboxBindingError(
      'No compliance footer (legal name, postal address, opt-out line) is available for this workspace; nothing was sent.'
    );
  }
  if (!body.trimEnd().endsWith(footer)) {
    throw mailboxBindingError(
      'This email does not end with the workspace compliance footer; nothing was sent.'
    );
  }
}
