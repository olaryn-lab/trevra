import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord, type CanonicalRecord } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { findSuppression } from '../suppressions.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';

const WORKSPACE = 'ws_email_zoho_inbound';
const ZOHO = 'conn_zoho_inbound';
const GMAIL = 'conn_zoho_inbound_gmail';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ADDRESS_LINE = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
let db: Db;
let personId = '';

function message(overrides: Partial<Extract<CanonicalRecord, { kind: 'message' }>> = {}) {
  return {
    kind: 'message' as const,
    id: 'zoho-msg-1',
    personEmail: 'maya@northwind.test',
    personName: 'Maya Chen',
    direction: 'inbound' as const,
    subject: 'Re: Quick question, Maya',
    body: 'Please unsubscribe me.',
    occurredAt: '2026-10-07T08:30:00.000Z',
    mailboxAddress: 'founder@acme.test',
    ...overrides
  };
}

async function insertConnection(id: string, provider: 'zoho-mail' | 'gmail'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(
      id,
      WORKSPACE,
      provider,
      `trevra-${provider}`,
      `${id}-external`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function sentOutreach(input: {
  id: string;
  connectionId: string;
  provider: string;
  recipient: string;
  status?: string;
}) {
  const status = input.status ?? 'sent';
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at)
       VALUES (?,?,'email',?,'outreach',?,'email_outreach',?,?,?,?,?,?::timestamptz,?::timestamptz)`
    )
    .run(
      input.id,
      WORKSPACE,
      input.connectionId,
      input.recipient,
      input.id,
      `key-${input.id}`,
      status,
      input.provider,
      `ref-${input.id}`,
      NOW.toISOString(),
      status === 'sent' ? NOW.toISOString() : null
    );
}

async function outcomeKind(id: string): Promise<string | undefined> {
  const row = await db
    .prepare(
      'SELECT outcome_kind FROM conversation_messages WHERE workspace_id=? AND external_ref=?'
    )
    .get<{ outcome_kind: string }>(WORKSPACE, id);
  return row?.outcome_kind;
}

function suppressed(email: string) {
  return findSuppression(db, WORKSPACE, { channel: 'email', email });
}

beforeEach(async () => {
  registerEmailComplianceProvider({
    footer: async () => `${ADDRESS_LINE}\n${OUTREACH_OPT_OUT_SENTENCE}`,
    blockers: async () => []
  });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho inbound', NOW.toISOString());
  await insertConnection(ZOHO, 'zoho-mail');
  await insertConnection(GMAIL, 'gmail');
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, ZOHO, NOW.toISOString(), NOW.toISOString());
  personId = (
    await resolveContact(db, WORKSPACE, { name: 'Maya Chen', email: 'maya@northwind.test' }, NOW)
  ).contact.id;
});

afterEach(async () => {
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail inbound replies', () => {
  it('stores a known Person reply from the Zoho inbound mailbox in Conversations', async () => {
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-reply', body: 'Friday works.' })
    );
    expect(await outcomeKind('zoho-reply')).toBe('reply');
  });

  it('suppresses an unthreaded unsubscribe reply to Zoho outreach from this mailbox', async () => {
    await sentOutreach({
      id: 'del_00000000000000a1',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(db, WORKSPACE, 'zoho-mail', ZOHO, message());
    expect(await outcomeKind('zoho-msg-1')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toMatchObject({
      source: 'email_reply_unsubscribe',
      sourceRef: 'zoho-msg-1'
    });
  });

  it('suppresses when the unthreaded opt-out comes from another address of the same Person', async () => {
    await db
      .prepare(
        `INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
         VALUES ('pid_zoho_alias',?,?,'zoho-mail','email','maya.chen@northwind.test','maya.chen@northwind.test',?)`
      )
      .run(WORKSPACE, personId, NOW.toISOString());
    await sentOutreach({
      id: 'del_00000000000000a2',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-alias', personEmail: 'maya.chen@northwind.test' })
    );
    expect(await suppressed('maya.chen@northwind.test')).toMatchObject({
      source: 'email_reply_unsubscribe'
    });
  });

  it('does not suppress an unthreaded unsubscribe without Zoho outreach from this mailbox', async () => {
    // Gmail outreach keeps Phase D's rule: only a threaded reply counts.
    await sentOutreach({
      id: 'del_00000000000000a3',
      connectionId: GMAIL,
      provider: 'gmail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-no-outreach' })
    );
    expect(await outcomeKind('zoho-no-outreach')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });

  it('does not suppress on a Zoho delivery that was not sent', async () => {
    await sentOutreach({
      id: 'del_00000000000000a5',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test',
      status: 'failed'
    });
    await ingestCanonicalRecord(db, WORKSPACE, 'zoho-mail', ZOHO, message({ id: 'zoho-failed' }));
    expect(await outcomeKind('zoho-failed')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });

  it('does not suppress when the Zoho outreach went to a different Person', async () => {
    await resolveContact(db, WORKSPACE, { name: 'Other', email: 'other@northwind.test' }, NOW);
    await sentOutreach({
      id: 'del_00000000000000a6',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'other@northwind.test'
    });
    await ingestCanonicalRecord(db, WORKSPACE, 'zoho-mail', ZOHO, message({ id: 'zoho-other' }));
    expect(await outcomeKind('zoho-other')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });

  it('does not read a quoted reply-to-unsubscribe footer as an opt-out', async () => {
    await sentOutreach({
      id: 'del_00000000000000a4',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({
        id: 'zoho-quoted',
        body: `Friday works for me.\n\n${ADDRESS_LINE}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`
      })
    );
    expect(await outcomeKind('zoho-quoted')).toBe('reply');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });
});
