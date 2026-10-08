import type { Db } from '../db.js';
import {
  classifyVerifiedInboundEmail,
  stripQuotedReply,
  type VerifiedEmailOutcome
} from '../email-outcomes.js';
import { createSuppression } from '../suppressions.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  SKILL_DRAFT_UNSUBSCRIBE_LINE,
  emailComplianceProvider
} from './compliance.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE, footerForUnsubscribeMode } from './unsubscribe-policy.js';
import { UNSUBSCRIBE_SUBJECT_PATTERN, applyUnsubscribeToken } from './unsubscribe.js';

/*
 * What to do with one record from the designated inbound mailbox's Nango sync.
 * Must not import integration-service.ts, which calls it.
 */

/** The Nango model the inbound-messages sync emits. Its records may only enter through the designated mailbox. */
export const INBOUND_EMAIL_MESSAGE_MODEL = 'InboundEmailMessage';

/** The Nango sync in nango-integrations/<integration>/syncs/inbound-messages.ts. */
export const INBOUND_SYNC_NAME = 'inbound-messages';
/** Fixed and content-free: stored as sync_error when Nango reports the sync failed. */
export const INBOUND_SYNC_FAILED_ERROR = 'Nango reported that the inbound-messages sync failed.';

export interface InboundMailboxRecord {
  id: string;
  personEmail?: string;
  direction: 'inbound' | 'outbound';
  subject: string;
  body: string;
  mailboxAddress?: string;
  replyToMessageIds?: string[];
  autoSubmitted?: string | null;
}

export type InboundMailboxIgnoreReason =
  | 'not_designated'
  | 'mailbox_mismatch'
  | 'not_inbound'
  | 'no_sender'
  | 'own_address'
  | 'unsubscribe_applied'
  | 'unsubscribe_rejected'
  | 'campaign_thread'
  | 'unknown_sender';

export type InboundMailboxDecision =
  | { action: 'ignore'; reason: InboundMailboxIgnoreReason }
  | {
      action: 'accept';
      personId: string;
      outcomeKind: VerifiedEmailOutcome;
      threadedDeliveryId: string | null;
    };

function ignore(reason: InboundMailboxIgnoreReason): InboundMailboxDecision {
  return { action: 'ignore', reason };
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Remove, case-insensitively and whitespace-insensitively, text Trevra itself put in outbound mail. */
async function withoutKnownOptOutText(db: Db, workspaceId: string, body: string): Promise<string> {
  const footer = await emailComplianceProvider().footer(db, workspaceId);
  // Longest first, so a footer that embeds the shorter sentences is removed whole.
  const known = [
    OUTREACH_OPT_OUT_SENTENCE,
    OUTREACH_REPLY_OPT_OUT_SENTENCE,
    SKILL_DRAFT_UNSUBSCRIBE_LINE,
    footer,
    // The footer Zoho outreach ends with (unsubscribe-policy.ts).
    footer ? footerForUnsubscribeMode(footer, 'footer_and_reply') : null
  ]
    .map((text) => collapse(text ?? '').toLowerCase())
    .filter(Boolean)
    .sort((x, y) => y.length - x.length);
  // Everything below works on the lowercased, collapsed copy only: the
  // classifier is case-insensitive, so the original casing is not needed.
  let text = collapse(stripQuotedReply(body)).toLowerCase();
  for (const phrase of known) text = collapse(text.split(phrase).join(' '));
  return text;
}

export async function decideInboundMailboxRecord(
  db: Db,
  workspaceId: string,
  connectionId: string | null,
  record: InboundMailboxRecord,
  now: Date = new Date()
): Promise<InboundMailboxDecision> {
  const mailbox = await db
    .prepare(
      `SELECT m.connection_id,m.address FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=? AND c.status='connected'`
    )
    .get<{ connection_id: string; address: string }>(workspaceId);
  if (!mailbox || !connectionId || mailbox.connection_id !== connectionId) {
    return ignore('not_designated');
  }
  // The sync stamps the address it verified against the provider profile; a
  // mismatch means the connection now belongs to a different account.
  if ((record.mailboxAddress ?? '').trim().toLowerCase() !== mailbox.address) {
    return ignore('mailbox_mismatch');
  }
  await db
    .prepare(
      'UPDATE email_inbound_mailboxes SET last_record_at=?::timestamptz WHERE workspace_id=?'
    )
    .run(now.toISOString(), workspaceId);
  if (record.direction !== 'inbound') return ignore('not_inbound');
  const sender = (record.personEmail ?? '').trim().toLowerCase();
  if (!sender) return ignore('no_sender');
  if (sender === mailbox.address) return ignore('own_address');

  // A mail client's RFC 8058 mailto unsubscribe. The token, not the sender,
  // is the authority (aliases and forwarding change the From address), and it
  // must belong to this workspace. It is a request, not a conversation.
  const token = UNSUBSCRIBE_SUBJECT_PATTERN.exec(record.subject)?.[1];
  if (token) {
    const result = await applyUnsubscribeToken(
      db,
      token,
      { source: 'email_mailto_unsubscribe', workspaceId },
      now
    );
    return ignore(result.applied ? 'unsubscribe_applied' : 'unsubscribe_rejected');
  }

  const replyTo = (record.replyToMessageIds ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  const threaded =
    replyTo.length > 0
      ? await db
          .prepare(
            `SELECT id,source_type,recipient FROM gtm_deliveries
             WHERE workspace_id=? AND channel='email' AND internet_message_id = ANY(?::text[])
             ORDER BY started_at DESC LIMIT 1`
          )
          .get<{ id: string; source_type: string; recipient: string | null }>(workspaceId, replyTo)
      : undefined;
  // Campaign replies belong to the campaign reply poller
  // (readConnectedEmailThreadEvents), which also moves the campaign member;
  // projecting them here as well would show every campaign reply twice.
  if (threaded?.source_type === 'campaign_email') return ignore('campaign_thread');

  // Strangers are never stored. A Person must already exist, by primary email
  // or by a recorded email identity, before their mail enters the ledger.
  const person = await db
    .prepare(
      // The contact owning the address wins: createSuppression resolves the
      // same contact by email and refuses when the Person differs.
      `SELECT id FROM (
         SELECT id,0 AS precedence FROM contacts WHERE workspace_id=? AND email_normalized=?
         UNION ALL
         SELECT person_id AS id,1 AS precedence FROM person_identities
         WHERE workspace_id=? AND identity_type='email' AND normalized_value=?
       ) found ORDER BY precedence LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, sender, workspaceId, sender);
  if (!person) {
    // An alias, forwarding or shared address replying to Trevra's own email.
    // Its content is never stored, but an opt-out still stops mail to the
    // address the threaded delivery went to (Zoho's only opt-out is a reply).
    const recipient = threaded?.recipient?.trim().toLowerCase();
    if (recipient && (await classifyReply(db, workspaceId, record)) === 'unsubscribe') {
      await createSuppression(
        db,
        {
          workspaceId,
          channel: 'email',
          email: recipient,
          reason: 'Recipient asked to stop in a reply',
          source: 'email_reply_unsubscribe',
          sourceRef: record.id,
          actorType: 'system'
        },
        now
      );
      return ignore('unsubscribe_applied');
    }
    return ignore('unknown_sender');
  }

  const outcomeKind = await classifyReply(db, workspaceId, record);
  // A reply that threads to Trevra's own email is verified intent. Zoho Mail
  // outreach cannot always be threaded (its Message-ID read-back may fail and
  // clients drop In-Reply-To), and its only opt-out is "reply unsubscribe", so
  // an unthreaded unsubscribe also counts when this mailbox address sent the
  // Person Zoho outreach (unsubscribe-policy.ts) — over any connection that
  // held the address, and including sends whose provider result is uncertain.
  const optOutDelivery =
    outcomeKind === 'unsubscribe' && !threaded
      ? await db
          .prepare(
            `SELECT d.id FROM gtm_deliveries d
             WHERE d.workspace_id=? AND d.channel='email' AND d.purpose='outreach'
               AND d.status IN ('sent','uncertain') AND d.provider='zoho-mail'
               AND d.connection_id IN (
                 SELECT c.id FROM connections c
                 WHERE c.workspace_id=? AND c.provider='zoho-mail' AND LOWER(c.mailbox_address)=?
               )
               AND LOWER(d.recipient) IN (
                 SELECT email_normalized FROM contacts
                 WHERE workspace_id=? AND id=? AND email_normalized IS NOT NULL
                 UNION
                 SELECT normalized_value FROM person_identities
                 WHERE workspace_id=? AND person_id=? AND identity_type='email'
                 UNION
                 SELECT ?::text
               )
             ORDER BY COALESCE(d.sent_at,d.started_at) DESC LIMIT 1`
          )
          .get<{ id: string }>(
            workspaceId,
            workspaceId,
            mailbox.address,
            workspaceId,
            person.id,
            workspaceId,
            person.id,
            sender
          )
      : undefined;
  if (outcomeKind === 'unsubscribe' && (threaded || optOutDelivery)) {
    await createSuppression(
      db,
      {
        workspaceId,
        channel: 'email',
        email: sender,
        personId: person.id,
        reason: 'Recipient asked to stop in a reply',
        source: 'email_reply_unsubscribe',
        sourceRef: record.id,
        actorType: 'system'
      },
      now
    );
  }
  return {
    action: 'accept',
    personId: person.id,
    outcomeKind,
    threadedDeliveryId: threaded?.id ?? null
  };
}

async function classifyReply(
  db: Db,
  workspaceId: string,
  record: InboundMailboxRecord
): Promise<VerifiedEmailOutcome> {
  const outcomeKind = classifyVerifiedInboundEmail({
    subject: record.subject,
    body: record.body,
    autoSubmitted: record.autoSubmitted ?? null
  });
  if (outcomeKind !== 'unsubscribe') return outcomeKind;
  // Trevra's own opt-out wording and footer say "unsubscribe"; a client that
  // quotes them without '>' prefixes must not turn a normal reply into one.
  return classifyVerifiedInboundEmail({
    subject: record.subject,
    body: await withoutKnownOptOutText(db, workspaceId, record.body),
    autoSubmitted: record.autoSubmitted ?? null
  });
}
