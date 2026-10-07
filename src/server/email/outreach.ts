import type { Db } from '../db.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import type { EmailChannelIssue, MailProvider } from './types.js';
import { unsubscribeConfigured } from './unsubscribe.js';

export interface EmailOutreachOptions {
  resolver?: DnsResolver;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface EmailOutreachSender {
  connectionId: string;
  address: string;
  provider: MailProvider;
}

export interface EmailOutreachReadiness {
  blockers: EmailChannelIssue[];
  warnings: EmailChannelIssue[];
  listName: string | null;
  recipientCount: number;
  sender: EmailOutreachSender | null;
}

const SETUP_HREF = '/setup/workspace';
const PEOPLE_HREF = '/outreach/new';

/**
 * A lead-list member's address, for a query that joins linkedin_lead_contacts
 * as `lc` and LEFT JOINs contacts as `p`: the canonical Person's email when it
 * has one, else the address imported with the lead. Lower-cased so suppression,
 * already-emailed and recipient comparisons all see one spelling.
 */
export const RECIPIENT_SQL = `LOWER(COALESCE(NULLIF(BTRIM(p.email),''),NULLIF(BTRIM(lc.email),'')))`;

/**
 * Everything that must be true before Trevra prepares outreach email. Every
 * answer here is deterministic for a given workspace state, because it ends up
 * inside the plan hash.
 */
export async function emailOutreachReadiness(
  db: Db,
  workspaceId: string,
  input: { leadListId: string | null },
  options: EmailOutreachOptions = {}
): Promise<EmailOutreachReadiness> {
  const env = options.env ?? process.env;
  const blockers: EmailChannelIssue[] = [];
  const warnings: EmailChannelIssue[] = [];

  let listName: string | null = null;
  let recipientCount = 0;
  if (input.leadListId) {
    const list = await db
      .prepare('SELECT id,name FROM linkedin_lead_lists WHERE workspace_id=? AND id=? LIMIT 1')
      .get<{ id: string; name: string }>(workspaceId, input.leadListId);
    if (!list) {
      blockers.push({
        code: 'lead_list_not_found',
        message: 'The selected People list no longer exists in this workspace.',
        actionHref: PEOPLE_HREF
      });
    } else {
      listName = list.name;
      const counted = await db
        .prepare(
          `SELECT COUNT(*)::int AS total
           FROM linkedin_lead_list_members m
           JOIN linkedin_lead_contacts lc ON lc.workspace_id=m.workspace_id AND lc.id=m.contact_id
           LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
           WHERE m.workspace_id=? AND m.list_id=? AND lc.do_not_contact=FALSE
             AND ${RECIPIENT_SQL} IS NOT NULL`
        )
        .get<{ total: number }>(workspaceId, list.id);
      recipientCount = counted?.total ?? 0;
      if (recipientCount === 0) {
        blockers.push({
          code: 'email_recipients_missing',
          message: `Nobody in ${list.name} has an email address Trevra may write to.`,
          actionHref: PEOPLE_HREF
        });
      }
    }
  }

  if (!unsubscribeConfigured(env)) {
    blockers.push({
      code: 'email_unsubscribe_unavailable',
      message:
        'One-click unsubscribe needs an HTTPS TREVRA_PUBLIC_API_URL and TREVRA_SECRETS_KEY on the server. Trevra will not prepare outreach email without it.',
      actionHref: SETUP_HREF
    });
  }

  const mailboxes = await listSendingMailboxes(db, workspaceId);
  let sender: EmailOutreachSender | null = null;
  if (mailboxes.length === 0) {
    blockers.push({
      code: 'email_sender_missing',
      message: 'Connect the Gmail or Microsoft 365 mailbox you want to send outreach from.',
      actionHref: SETUP_HREF
    });
  } else if (mailboxes.length > 1) {
    // lc-debt: email outreach requires exactly one connected sending mailbox; upgrade path: add an explicit sender connection to the GTM intent and plan defaults once founders send from more than one mailbox.
    blockers.push({
      code: 'email_sender_ambiguous',
      message:
        'More than one mailbox is connected. Disconnect the ones you do not send outreach from; choosing a sender per plan is not supported yet.',
      actionHref: SETUP_HREF
    });
  } else {
    const mailbox = mailboxes[0]!;
    const address = await resolveMailboxAddress(db, workspaceId, mailbox);
    const domain = address ? emailDomainOf(address) : null;
    if (!address || !domain) {
      blockers.push({
        code: 'email_sender_address_unknown',
        message:
          'Trevra could not read the address of your connected mailbox. Reconnect it and plan again.',
        actionHref: SETUP_HREF
      });
    } else {
      sender = { connectionId: mailbox.connectionId, address, provider: mailbox.providerKey };
      const deliverability = await getSenderDeliverability(
        db,
        workspaceId,
        { domain, provider: mailbox.providerKey, markOutreach: true },
        { resolver: options.resolver, now: options.now }
      );
      if (deliverability.status === 'fail') {
        // Fail closed: a failing check with no stored blocker must still block.
        if (deliverability.blockers.length > 0) blockers.push(...deliverability.blockers);
        else
          blockers.push({
            code: 'email_deliverability_failed',
            message: `Email from ${domain} fails SPF, DKIM or DMARC checks. Fix DNS and re-check.`,
            actionHref: SETUP_HREF
          });
      }
      if (deliverability.status === 'unknown') {
        const unanswered = [deliverability.spf, deliverability.dkim, deliverability.dmarc].find(
          (check) => check.status === 'unknown'
        );
        blockers.push({
          code: 'email_deliverability_unknown',
          message: `Trevra could not confirm SPF, DKIM and DMARC for ${domain}${
            unanswered ? `: ${unanswered.detail}` : '.'
          } Re-check DNS once it answers.`,
          actionHref: SETUP_HREF
        });
      }
      warnings.push(...deliverability.warnings);

      const inbound = await db
        .prepare(
          'SELECT connection_id,sync_status FROM email_inbound_mailboxes WHERE workspace_id=?'
        )
        .get<{ connection_id: string; sync_status: string }>(workspaceId);
      if (
        !inbound ||
        inbound.sync_status !== 'syncing' ||
        inbound.connection_id !== mailbox.connectionId
      ) {
        blockers.push({
          code: 'email_replies_not_synced',
          message: `Replies to ${address} are not read into Conversations. Choose it as the inbound mailbox in Workspace settings.`,
          actionHref: SETUP_HREF
        });
      }
    }
  }

  return { blockers, warnings, listName, recipientCount, sender };
}
