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
import { UNSUBSCRIBE_SUBJECT_PATTERN, applyUnsubscribeToken } from './unsubscribe.js';

/*
 * What to do with one record from the designated inbound mailbox's Nango sync.
 * Must not import integration-service.ts, which calls it.
 */

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
  const known = [OUTREACH_OPT_OUT_SENTENCE, SKILL_DRAFT_UNSUBSCRIBE_LINE, footer]
    .map((text) => collapse(text ?? ''))
    .filter(Boolean);
  let text = collapse(stripQuotedReply(body));
  for (const phrase of known) {
    const needle = phrase.toLowerCase();
    let lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    while (at !== -1) {
      text = `${text.slice(0, at)} ${text.slice(at + needle.length)}`;
      lower = text.toLowerCase();
      at = lower.indexOf(needle);
    }
  }
  return collapse(text);
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
            `SELECT id,source_type FROM gtm_deliveries
             WHERE workspace_id=? AND channel='email' AND internet_message_id = ANY(?::text[])
             ORDER BY started_at DESC LIMIT 1`
          )
          .get<{ id: string; source_type: string }>(workspaceId, replyTo)
      : undefined;
  // Campaign replies belong to the campaign reply poller
  // (readConnectedEmailThreadEvents), which also moves the campaign member;
  // projecting them here as well would show every campaign reply twice.
  if (threaded?.source_type === 'campaign_email') return ignore('campaign_thread');

  // Strangers are never stored. A Person must already exist, by primary email
  // or by a recorded email identity, before their mail enters the ledger.
  const person = await db
    .prepare(
      `SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?
       UNION ALL
       SELECT person_id AS id FROM person_identities
       WHERE workspace_id=? AND identity_type='email' AND normalized_value=?
       LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, sender, workspaceId, sender);
  if (!person) return ignore('unknown_sender');

  let outcomeKind = classifyVerifiedInboundEmail({
    subject: record.subject,
    body: record.body,
    autoSubmitted: record.autoSubmitted ?? null
  });
  if (outcomeKind === 'unsubscribe') {
    // Trevra's own opt-out wording and footer say "unsubscribe"; a client that
    // quotes them without '>' prefixes must not turn a normal reply into one.
    outcomeKind = classifyVerifiedInboundEmail({
      subject: record.subject,
      body: await withoutKnownOptOutText(db, workspaceId, record.body),
      autoSubmitted: record.autoSubmitted ?? null
    });
  }
  if (outcomeKind === 'unsubscribe' && threaded) {
    // Only a reply that threads to Trevra's own email counts as verified intent.
    await createSuppression(
      db,
      {
        workspaceId,
        channel: 'email',
        email: sender,
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
