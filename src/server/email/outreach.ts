import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureConversationForPerson } from '../conversations.js';
import type { Db } from '../db.js';
import { LEAD_CONTACT_READ_LIMIT } from '../linkedin/lead-lists.js';
import { startPlaybookRun } from '../playbooks/engine.js';
import { findSuppression } from '../suppressions.js';
import { emailComplianceProvider, OUTREACH_OPT_OUT_SENTENCE } from './compliance.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import type {
  EmailChannelIssue,
  EmailOutreachSkipReason,
  MailProvider,
  PreparedEmailOutreachResult
} from './types.js';
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
  return { blockers, warnings, listName, recipientCount, sender };
}

export class EmailOutreachError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

export const EMAIL_OUTREACH_PLAYBOOK_ID = 'gtm.email-outreach';

// lc-debt: one preparation starts at most 200 approval runs and reads at most LEAD_CONTACT_READ_LIMIT list members; upgrade path: prepare in pages with a cursor stored on email_outreach_preparations once founders approve more than 200 first-touch emails at a time.
const MAX_PREPARED_PER_CALL = 200;

const recipientSchema = z.string().email();

interface MemberRow {
  contact_id: string;
  person_id: string | null;
  do_not_contact: boolean;
  first_name: string | null;
  company: string | null;
  recipient: string | null;
}

interface OutreachRunRow {
  id: string;
  person_id: string;
  idempotency_key: string;
}

interface ReceiptRow {
  plan_hash: string;
  result_json: Omit<PreparedEmailOutreachResult, 'duplicate'>;
}

interface PrepareInput {
  workspaceId: string;
  actorUserId: string;
  idempotencyKey: string;
  planHash: string;
  leadListId: string;
  connectionId: string;
  senderAddress: string;
}

/** One deterministic run key per workspace, preparation key and lead-list contact. */
export function emailOutreachRunKey(
  workspaceId: string,
  idempotencyKey: string,
  contactId: string
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}:${idempotencyKey}:${contactId}`)
    .digest('hex');
  return `eo_${digest.slice(0, 40)}`;
}

function oneLine(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The first-touch email Trevra prepares. It is short and plain on purpose: the
 * founder approves its exact text before anything is sent, and the
 * List-Unsubscribe header carries the one-click opt-out. The sender's
 * compliance footer is appended by prepareEmailOutreach.
 */
export function firstTouchEmail(input: { firstName: string | null; company: string | null }): {
  subject: string;
  body: string;
} {
  const firstName = oneLine(input.firstName, 80);
  const company = oneLine(input.company, 120);
  return {
    subject: firstName ? `Quick question, ${firstName}` : 'Quick question',
    body: [
      firstName ? `Hi ${firstName},` : 'Hi,',
      '',
      company
        ? `I am reaching out because of the work you do at ${company}. Would you be open to a short conversation about it?`
        : 'Would you be open to a short conversation?',
      '',
      OUTREACH_OPT_OUT_SENTENCE
    ].join('\n')
  };
}

async function readReceipt(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<ReceiptRow | undefined> {
  return db
    .prepare(
      'SELECT plan_hash,result_json FROM email_outreach_preparations WHERE workspace_id=? AND idempotency_key=?'
    )
    .get<ReceiptRow>(workspaceId, idempotencyKey);
}

function replayReceipt(receipt: ReceiptRow, planHash: string): PreparedEmailOutreachResult {
  if (receipt.plan_hash !== planHash) {
    throw new EmailOutreachError(
      'This preparation key was already used for a different email plan. Plan again before preparing.'
    );
  }
  return { ...receipt.result_json, duplicate: true };
}

/** The migration-133 unique indexes a racing or retried preparation can hit. */
const OUTREACH_RUN_INDEXES = new Set([
  'idx_playbook_runs_email_outreach_idempotency',
  'idx_playbook_runs_email_outreach_open_person'
]);

/** Run statuses idx_playbook_runs_email_outreach_open_person treats as open. */
const OPEN_RUN_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

/** True only for a unique violation on one of the two outreach-run indexes. */
export function isOutreachRunConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return (
    String(code) === '23505' &&
    typeof constraint === 'string' &&
    OUTREACH_RUN_INDEXES.has(constraint)
  );
}

/**
 * Start one approval run, or find the run that beat it to the unique indexes.
 * Returns the run id while this run key's run is still open. Otherwise it
 * returns the skip reason: `already_contacted` when an outreach delivery to the
 * recipient exists, else `already_pending` (an open run for the Person under
 * another key, or this key's run already ended without a delivery).
 */
async function startOutreachRun(
  db: Db,
  input: PrepareInput,
  run: {
    runKey: string;
    conversationId: string;
    personId: string;
    contactId: string;
    recipient: string;
    subject: string;
    body: string;
  }
): Promise<{ runId: string } | { skip: EmailOutreachSkipReason }> {
  try {
    const started = await startPlaybookRun(db, {
      workspaceId: input.workspaceId,
      playbookId: EMAIL_OUTREACH_PLAYBOOK_ID,
      payload: {
        idempotencyKey: run.runKey,
        conversationId: run.conversationId,
        personId: run.personId,
        contactId: run.contactId,
        leadListId: input.leadListId,
        connectionId: input.connectionId,
        senderAddress: input.senderAddress,
        recipient: run.recipient,
        subject: run.subject,
        body: run.body
      },
      actorType: 'user',
      actorId: input.actorUserId,
      prepared: true
    });
    return { runId: started.id };
  } catch (error) {
    if (!isOutreachRunConflict(error)) throw error;
    const raced = await db
      .prepare(
        `SELECT id,status,input_json->>'personId' AS person_id,
                input_json->>'idempotencyKey' AS idempotency_key
         FROM playbook_runs
         WHERE workspace_id=? AND playbook_key=?
           AND (input_json->>'idempotencyKey'=?
                OR (input_json->>'personId'=? AND status IN ('queued','running','waiting_approval')))
         ORDER BY CASE WHEN input_json->>'idempotencyKey'=? THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`
      )
      .get<OutreachRunRow & { status: string }>(
        input.workspaceId,
        EMAIL_OUTREACH_PLAYBOOK_ID,
        run.runKey,
        run.personId,
        run.runKey
      );
    if (raced && raced.idempotency_key === run.runKey && OPEN_RUN_STATUSES.has(raced.status)) {
      return { runId: raced.id };
    }
    const delivered = await db
      .prepare(
        `SELECT 1 AS hit FROM gtm_deliveries
         WHERE workspace_id=? AND channel='email' AND purpose='outreach'
           AND LOWER(recipient)=? AND status IN ('sending','sent','uncertain')
         LIMIT 1`
      )
      .get<{ hit: number }>(input.workspaceId, run.recipient);
    return { skip: delivered ? 'already_contacted' : 'already_pending' };
  }
}

/**
 * Prepare first-touch outreach email for a People list: one gtm.email-outreach
 * run per eligible Person, each waiting for approval of its exact text. Nothing
 * is sent here. The caller has already re-compiled the plan and checked that it
 * has no blockers, so the sender passed DNS and unsubscribe checks. Every body
 * ends with the sender's compliance footer, so the footer is inside the
 * approved and hashed payload; without a footer nothing is prepared.
 */
export async function prepareEmailOutreach(
  db: Db,
  input: PrepareInput,
  now: Date = new Date()
): Promise<PreparedEmailOutreachResult> {
  const earlier = await readReceipt(db, input.workspaceId, input.idempotencyKey);
  if (earlier) return replayReceipt(earlier, input.planHash);

  const footer = (await emailComplianceProvider().footer(db, input.workspaceId))?.trim() ?? '';
  if (!footer) {
    throw new EmailOutreachError(
      'No compliance footer (legal name, postal address, opt-out line) is available for this workspace. Complete sender compliance in Workspace settings before preparing outreach email.'
    );
  }

  const rows = await db
    .prepare(
      `SELECT lc.id AS contact_id,lc.person_id,lc.do_not_contact,lc.first_name,lc.company,
              ${RECIPIENT_SQL} AS recipient
       FROM linkedin_lead_list_members m
       JOIN linkedin_lead_contacts lc ON lc.workspace_id=m.workspace_id AND lc.id=m.contact_id
       LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
       WHERE m.workspace_id=? AND m.list_id=?
       ORDER BY m.created_at ASC,lc.id ASC
       LIMIT ?`
    )
    .all<MemberRow>(input.workspaceId, input.leadListId, LEAD_CONTACT_READ_LIMIT + 1);
  let truncated = rows.length > LEAD_CONTACT_READ_LIMIT;

  const contacted = new Set(
    (
      await db
        .prepare(
          `SELECT DISTINCT LOWER(recipient) AS recipient FROM gtm_deliveries
           WHERE workspace_id=? AND channel='email' AND purpose='outreach'
             AND status IN ('sending','sent','uncertain')`
        )
        .all<{ recipient: string }>(input.workspaceId)
    ).map((row) => row.recipient)
  );
  const openRuns = new Map<string, OutreachRunRow>();
  const open = await db
    .prepare(
      `SELECT id,input_json->>'personId' AS person_id,input_json->>'idempotencyKey' AS idempotency_key
       FROM playbook_runs
       WHERE workspace_id=? AND playbook_key=? AND status IN ('queued','running','waiting_approval')`
    )
    .all<OutreachRunRow>(input.workspaceId, EMAIL_OUTREACH_PLAYBOOK_ID);
  for (const run of open) openRuns.set(run.person_id, run);

  const prepared: PreparedEmailOutreachResult['prepared'] = [];
  const skipped: PreparedEmailOutreachResult['skipped'] = [];
  const batchRecipients = new Set<string>();
  const skip = (contactId: string, reason: EmailOutreachSkipReason) => {
    skipped.push({ contactId, reason });
  };

  for (const member of rows.slice(0, LEAD_CONTACT_READ_LIMIT)) {
    if (prepared.length >= MAX_PREPARED_PER_CALL) {
      truncated = true;
      break;
    }
    const recipient =
      member.recipient && recipientSchema.safeParse(member.recipient).success
        ? member.recipient
        : null;
    if (!recipient) {
      skip(member.contact_id, 'no_email');
      continue;
    }
    const personId = member.person_id;
    if (!personId) {
      skip(member.contact_id, 'unresolved_person');
      continue;
    }
    const runKey = emailOutreachRunKey(input.workspaceId, input.idempotencyKey, member.contact_id);
    const openRun = openRuns.get(personId);
    if (openRun && openRun.idempotency_key === runKey) {
      // A retry of this same preparation after a crash: the run is already ours.
      prepared.push({ contactId: member.contact_id, personId, runId: openRun.id });
      batchRecipients.add(recipient);
      continue;
    }
    if (member.do_not_contact) {
      skip(member.contact_id, 'do_not_contact');
      continue;
    }
    if (
      await findSuppression(db, input.workspaceId, { channel: 'email', personId, email: recipient })
    ) {
      skip(member.contact_id, 'suppressed');
      continue;
    }
    if (contacted.has(recipient)) {
      skip(member.contact_id, 'already_contacted');
      continue;
    }
    if (openRun || batchRecipients.has(recipient)) {
      skip(member.contact_id, 'already_pending');
      continue;
    }

    const email = firstTouchEmail({ firstName: member.first_name, company: member.company });
    const conversationId = await ensureConversationForPerson(db, input.workspaceId, personId, now);
    const started = await startOutreachRun(db, input, {
      runKey,
      conversationId,
      personId,
      contactId: member.contact_id,
      recipient,
      subject: email.subject,
      body: `${email.body}\n\n${footer}`
    });
    if ('skip' in started) {
      skip(member.contact_id, started.skip);
      continue;
    }
    const runId = started.runId;
    prepared.push({ contactId: member.contact_id, personId, runId });
    openRuns.set(personId, { id: runId, person_id: personId, idempotency_key: runKey });
    batchRecipients.add(recipient);
  }

  const result: Omit<PreparedEmailOutreachResult, 'duplicate'> = {
    prepared,
    skipped,
    connectionId: input.connectionId,
    senderAddress: input.senderAddress,
    truncated
  };
  const written = await db
    .prepare(
      `INSERT INTO email_outreach_preparations
       (workspace_id,idempotency_key,plan_hash,actor_user_id,lead_list_id,connection_id,run_ids_json,
        result_json,created_at)
       VALUES (?,?,?,?,?,?,?::jsonb,?::jsonb,?)
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING`
    )
    .run(
      input.workspaceId,
      input.idempotencyKey,
      input.planHash,
      input.actorUserId,
      input.leadListId,
      input.connectionId,
      JSON.stringify(prepared.map((item) => item.runId)),
      JSON.stringify(result),
      now.toISOString()
    );
  if (written.changes === 0) {
    // A concurrent request with the same key wrote its receipt first. Its runs
    // are these runs (same run keys), so answer as the replay it is.
    const raced = await readReceipt(db, input.workspaceId, input.idempotencyKey);
    if (raced) return replayReceipt(raced, input.planHash);
  }
  return { ...result, duplicate: false };
}
