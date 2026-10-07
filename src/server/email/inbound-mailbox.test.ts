import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord, type CanonicalRecord } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { findSuppression } from '../suppressions.js';
import { unsubscribeToken } from './unsubscribe.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';

const WORKSPACE = 'ws_email_inbound_mailbox';
const OTHER = 'ws_email_inbound_mailbox_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let personId = '';

function message(overrides: Partial<Extract<CanonicalRecord, { kind: 'message' }>> = {}) {
  return {
    kind: 'message' as const,
    id: 'gmail-msg-1',
    personEmail: 'Lead@Example.test',
    personName: 'Lead Person',
    direction: 'inbound' as const,
    subject: 'Question about pricing',
    body: 'Can we talk on Friday?',
    occurredAt: '2026-10-06T08:30:00.000Z',
    externalUrl: 'https://mail.google.com/mail/u/0/#all/gmail-msg-1',
    mailboxAddress: 'inbound@acme.test',
    ...overrides
  };
}

async function countFor(table: string, workspaceId = WORKSPACE): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE workspace_id=?`)
    .get<{ total: number }>(workspaceId);
  return Number(row?.total ?? 0);
}

async function insertConnection(connectionId: string, workspaceId = WORKSPACE) {
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?)`
    )
    .run(
      connectionId,
      workspaceId,
      `${connectionId}-external`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function insertDelivery(input: {
  id: string;
  workspaceId?: string;
  sourceType?: string;
  internetMessageId?: string;
}) {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,internet_message_id,started_at)
       VALUES (?,?,'email',NULL,'outreach','lead@example.test',?,?,?,'sent',?,?::timestamptz)`
    )
    .run(
      input.id,
      input.workspaceId ?? WORKSPACE,
      input.sourceType ?? 'email_action',
      input.id,
      `key-${input.id}`,
      input.internetMessageId ?? null,
      NOW.toISOString()
    );
}

const FAKE_FOOTER = 'Acme Ltd, 1 Main Street. Click unsubscribe to stop these emails.';

beforeEach(async () => {
  registerEmailComplianceProvider({
    footer: async () => FAKE_FOOTER,
    blockers: async () => []
  });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await insertConnection('conn_inbound');
  await insertConnection('conn_other');
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,'conn_inbound','inbound@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  personId = (
    await resolveContact(db, WORKSPACE, { name: 'Lead Person', email: 'lead@example.test' }, NOW)
  ).contact.id;
});

afterEach(async () => {
  resetEmailComplianceProvider();
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('inbound mailbox ingestion', () => {
  it("stores a known Person's email as an inbound conversation message", async () => {
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', message());
    const row = await db
      .prepare(
        `SELECT cm.source_type,cm.outcome_kind,cm.direction,cm.external_ref,c.person_id
         FROM conversation_messages cm JOIN conversations c ON c.id=cm.conversation_id
         WHERE cm.workspace_id=?`
      )
      .get<Record<string, unknown>>(WORKSPACE);
    expect(row).toEqual({
      source_type: 'inbound_mailbox_message',
      outcome_kind: 'reply',
      direction: 'inbound',
      external_ref: 'gmail-msg-1',
      person_id: personId
    });
    const mailbox = await db
      .prepare('SELECT last_record_at FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get<{ last_record_at: string | null }>(WORKSPACE);
    expect(mailbox?.last_record_at).not.toBeNull();
  });

  it('drops strangers without writing a single row', async () => {
    const contactsBefore = await countFor('contacts');
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-stranger', personEmail: 'stranger@elsewhere.test' })
    );
    expect(await countFor('source_records')).toBe(0);
    expect(await countFor('messages')).toBe(0);
    expect(await countFor('conversation_messages')).toBe(0);
    expect(await countFor('contacts')).toBe(contactsBefore);
  });

  it('ignores records from another connection, another address or a disconnected mailbox', async () => {
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_other', message({ id: 'gmail-a' }));
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-b', mailboxAddress: 'someone-else@acme.test' })
    );
    await db.prepare("UPDATE connections SET status='disconnected' WHERE id='conn_inbound'").run();
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', message({ id: 'gmail-c' }));
    expect(await countFor('source_records')).toBe(0);
    expect(await countFor('conversation_messages')).toBe(0);
  });

  it("applies a mailto unsubscribe only for this workspace's own deliveries", async () => {
    await insertDelivery({ id: 'del_00000000000000f6', workspaceId: OTHER });
    const foreign = unsubscribeToken({
      workspaceId: OTHER,
      deliveryId: 'del_00000000000000f6',
      recipient: 'lead@example.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-unsub-foreign', subject: `unsubscribe ${foreign}`, body: '' })
    );
    expect(
      await findSuppression(db, OTHER, { channel: 'email', email: 'lead@example.test' })
    ).toBeNull();

    await insertDelivery({ id: 'del_00000000000000f7' });
    const own = unsubscribeToken({
      workspaceId: WORKSPACE,
      deliveryId: 'del_00000000000000f7',
      recipient: 'lead@example.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-unsub-own',
        personEmail: 'alias-of-lead@example.test',
        subject: `unsubscribe ${own}`,
        body: ''
      })
    );
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toMatchObject({ source: 'email_mailto_unsubscribe', sourceRef: 'del_00000000000000f7' });
    expect(await countFor('conversation_messages')).toBe(0);
  });

  it('leaves campaign threads to the campaign poller and honours a threaded unsubscribe reply', async () => {
    await insertDelivery({
      id: 'del_00000000000000a8',
      sourceType: 'campaign_email',
      internetMessageId: '<campaign@trevra.app>'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-campaign-reply', replyToMessageIds: ['<campaign@trevra.app>'] })
    );
    expect(await countFor('conversation_messages')).toBe(0);

    await insertDelivery({
      id: 'del_00000000000000a9',
      internetMessageId: '<outreach@trevra.app>'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-stop',
        subject: 'Re: Quick question',
        body: 'Please remove me from your list.',
        replyToMessageIds: ['<outreach@trevra.app>']
      })
    );
    const row = await db
      .prepare('SELECT outcome_kind FROM conversation_messages WHERE workspace_id=?')
      .get<{ outcome_kind: string }>(WORKSPACE);
    expect(row?.outcome_kind).toBe('unsubscribe');
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toMatchObject({ source: 'email_reply_unsubscribe', sourceRef: 'gmail-stop' });
  });

  it('does not project a message twice when the legacy sync already stored it', async () => {
    const { mailboxAddress: _omit, ...legacy } = message({ id: 'gmail-dup' });
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', legacy);
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-dup' })
    );
    const rows = await db
      .prepare(
        "SELECT source_type FROM conversation_messages WHERE workspace_id=? AND external_ref='gmail-dup'"
      )
      .all<{ source_type: string }>(WORKSPACE);
    expect(rows.map((row) => row.source_type)).toEqual(['legacy_message']);
  });

  describe('quoted outreach text is not intent', () => {
    async function seedThread() {
      await insertDelivery({ id: 'del_00000000000000b1', internetMessageId: '<q@trevra.app>' });
    }
    async function send(body: string, id = 'gmail-quote') {
      await seedThread();
      await ingestCanonicalRecord(
        db,
        WORKSPACE,
        'gmail',
        'conn_inbound',
        message({ id, subject: 'Re: Quick question', body, replyToMessageIds: ['<q@trevra.app>'] })
      );
      const row = await db
        .prepare('SELECT outcome_kind FROM conversation_messages WHERE workspace_id=?')
        .get<{ outcome_kind: string }>(WORKSPACE);
      const suppression = await findSuppression(db, WORKSPACE, {
        channel: 'email',
        email: 'lead@example.test'
      });
      return { outcome: row?.outcome_kind, suppression };
    }

    it('keeps a positive reply that quotes the opt-out sentence without > prefixes', async () => {
      const result = await send(
        `Sounds good, let's talk.\n\nHello there\n${OUTREACH_OPT_OUT_SENTENCE}`
      );
      expect(result.outcome).toBe('reply');
      expect(result.suppression).toBeNull();
    });

    it('keeps it when the quote is re-wrapped across lines', async () => {
      const wrapped = OUTREACH_OPT_OUT_SENTENCE.replace(
        'use the unsubscribe',
        'use the\n  unsubscribe'
      );
      expect(wrapped).not.toBe(OUTREACH_OPT_OUT_SENTENCE);
      const result = await send(`Yes please, send details.\n\nHello there\n${wrapped}`);
      expect(result.outcome).toBe('reply');
      expect(result.suppression).toBeNull();
    });

    it('keeps it when an unprefixed provider footer mentions unsubscribe', async () => {
      const result = await send(`Interested, thanks.\n\nHello there\n${FAKE_FOOTER}`);
      expect(result.outcome).toBe('reply');
      expect(result.suppression).toBeNull();
    });

    it('still honours a real unsubscribe that also quotes the sentence', async () => {
      const result = await send(
        `Please unsubscribe me.\n\nHello there\n${OUTREACH_OPT_OUT_SENTENCE}`
      );
      expect(result.outcome).toBe('unsubscribe');
      expect(result.suppression).toMatchObject({ source: 'email_reply_unsubscribe' });
    });
  });
});

describe('inbound mailbox ingestion, edge cases', () => {
  async function outcomes(): Promise<string[]> {
    const rows = await db
      .prepare('SELECT outcome_kind FROM conversation_messages WHERE workspace_id=?')
      .all<{ outcome_kind: string }>(WORKSPACE);
    return rows.map((row) => row.outcome_kind);
  }
  const suppressionFor = (email: string) =>
    findSuppression(db, WORKSPACE, { channel: 'email', email });

  it('suppresses the Person when a threaded unsubscribe comes from an alias', async () => {
    await db
      .prepare(
        `INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
         VALUES ('pid_alias',?,?,'gmail','email','lead.alt@example.test','lead.alt@example.test',?)`
      )
      .run(WORKSPACE, personId, NOW.toISOString());
    await insertDelivery({ id: 'del_00000000000000c1', internetMessageId: '<alias@trevra.app>' });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-alias',
        personEmail: 'lead.alt@example.test',
        body: 'Please unsubscribe me.',
        replyToMessageIds: ['<alias@trevra.app>']
      })
    );
    expect(await suppressionFor('lead@example.test')).toMatchObject({
      source: 'email_reply_unsubscribe'
    });
  });

  it("resolves an address that is A's primary email and B's identity to A", async () => {
    const other = (
      await resolveContact(
        db,
        WORKSPACE,
        { name: 'Other Person', email: 'other@example.test' },
        NOW
      )
    ).contact.id;
    await db
      .prepare(
        `INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
         VALUES ('pid_clash',?,?,'gmail','email','lead@example.test','lead@example.test',?)`
      )
      .run(WORKSPACE, other, NOW.toISOString());
    await insertDelivery({ id: 'del_00000000000000c2', internetMessageId: '<clash@trevra.app>' });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-clash',
        body: 'Please unsubscribe me.',
        replyToMessageIds: ['<clash@trevra.app>']
      })
    );
    const row = await db
      .prepare(
        `SELECT c.person_id FROM conversation_messages cm JOIN conversations c ON c.id=cm.conversation_id
         WHERE cm.workspace_id=?`
      )
      .get<{ person_id: string }>(WORKSPACE);
    expect(row?.person_id).toBe(personId);
    expect(await suppressionFor('lead@example.test')).not.toBeNull();
  });

  it('classifies but does not suppress an unsubscribe reply that is not threaded', async () => {
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-unthreaded', body: 'Please remove me' })
    );
    expect(await outcomes()).toEqual(['unsubscribe']);
    expect(await suppressionFor('lead@example.test')).toBeNull();
  });

  it("does not count a thread that matches only another workspace's delivery", async () => {
    await insertDelivery({
      id: 'del_00000000000000c3',
      workspaceId: OTHER,
      internetMessageId: '<foreign@trevra.app>'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-foreign-thread',
        body: 'Please remove me',
        replyToMessageIds: ['<foreign@trevra.app>']
      })
    );
    expect(await suppressionFor('lead@example.test')).toBeNull();
  });

  it('keeps a footer that embeds the opt-out sentence and its own unsubscribe link from counting', async () => {
    registerEmailComplianceProvider({
      footer: async () =>
        `Acme Ltd\n${OUTREACH_OPT_OUT_SENTENCE}\nManage preferences or unsubscribe at example.test`,
      blockers: async () => []
    });
    await insertDelivery({ id: 'del_00000000000000c4', internetMessageId: '<foot@trevra.app>' });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-footer',
        body: `Great, let's talk.\n\nAcme Ltd\n${OUTREACH_OPT_OUT_SENTENCE}\nManage preferences or unsubscribe at example.test`,
        replyToMessageIds: ['<foot@trevra.app>']
      })
    );
    expect(await outcomes()).toEqual(['reply']);
    expect(await suppressionFor('lead@example.test')).toBeNull();
  });

  it('refreshes the legacy twin outcome instead of leaving it a plain reply', async () => {
    const { mailboxAddress: _omit, ...legacy } = message({
      id: 'gmail-twin',
      body: 'Please remove me'
    });
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', legacy);
    expect(await outcomes()).toEqual(['reply']);
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-twin', body: 'Please remove me' })
    );
    expect(await outcomes()).toEqual(['unsubscribe']);
  });

  it('ignores mail from the mailbox itself and outbound mail', async () => {
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-own', personEmail: 'inbound@acme.test' })
    );
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-out', direction: 'outbound' })
    );
    expect(await countFor('conversation_messages')).toBe(0);
    expect(await countFor('source_records')).toBe(0);
  });

  it('applies the same mailto unsubscribe twice with one suppression and no message', async () => {
    await insertDelivery({ id: 'del_00000000000000c5' });
    const token = unsubscribeToken({
      workspaceId: WORKSPACE,
      deliveryId: 'del_00000000000000c5',
      recipient: 'lead@example.test'
    });
    const record = message({ id: 'gmail-twice', subject: `unsubscribe ${token}`, body: '' });
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', record);
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', record);
    expect(await countFor('suppressions')).toBe(1);
    expect(await countFor('conversation_messages')).toBe(0);
  });

  it('leaves last_record_at NULL for a mismatched or undesignated record', async () => {
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-mismatch', mailboxAddress: 'someone-else@acme.test' })
    );
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_other',
      message({ id: 'gmail-other' })
    );
    const mailbox = await db
      .prepare('SELECT last_record_at FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get<{ last_record_at: string | null }>(WORKSPACE);
    expect(mailbox?.last_record_at).toBeNull();
  });
});
