import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} })),
  post: vi.fn(async (_config: Record<string, unknown>) => ({
    data: { id: 'gmail-outreach-1' },
    headers: {}
  }))
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { executePreparedPlaybookAction } from '../control-plane/execution.js';
import { ensureConversationForPerson } from '../conversations.js';
import { openDatabase, type Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { createSuppression } from '../suppressions.js';
import {
  decidePlaybookApproval,
  startPlaybookRun,
  updatePlaybookApprovalBody
} from '../playbooks/engine.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';

const WORKSPACE = 'ws_email_outreach_playbook';
const USER = 'usr_email_outreach_playbook';
const CONNECTION = 'conn_email_outreach_playbook';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const KEY = 'eo_playbook_test_0001';
const FOOTER = `Acme Labs Ltd, 1 Market Street, London EC1A 1AA\n${OUTREACH_OPT_OUT_SENTENCE}`;
const BODY = `Hi Maya,\n\nWould you be open to a short conversation?\n\n${FOOTER}`;
let db: Db;

async function seedMailbox(id: string, address: string, updatedAt: Date = NOW): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?,?)`
    )
    .run(id, WORKSPACE, `${id}-external`, address, NOW.toISOString(), updatedAt.toISOString());
}

async function prepareRun(overrides: { idempotencyKey?: string; prepared?: boolean } = {}) {
  const person = await resolveContact(
    db,
    WORKSPACE,
    { name: 'Maya Chen', email: 'maya@northwind.test' },
    NOW
  );
  const conversationId = await ensureConversationForPerson(db, WORKSPACE, person.contact.id, NOW);
  const run = await startPlaybookRun(db, {
    workspaceId: WORKSPACE,
    playbookId: 'gtm.email-outreach',
    payload: {
      idempotencyKey: overrides.idempotencyKey ?? KEY,
      conversationId,
      personId: person.contact.id,
      contactId: 'lilc_playbook_test',
      leadListId: 'lilst_playbook_test',
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      recipient: 'maya@northwind.test',
      subject: 'Quick question, Maya',
      body: BODY
    },
    actorType: 'user',
    actorId: USER,
    prepared: overrides.prepared ?? true
  });
  return { run, personId: person.contact.id, conversationId };
}

function approve(runId: string) {
  return decidePlaybookApproval(db, {
    workspaceId: WORKSPACE,
    runId,
    stepId: 'approve-outreach',
    userId: USER,
    decision: 'approve'
  });
}

function reject(runId: string) {
  return decidePlaybookApproval(db, {
    workspaceId: WORKSPACE,
    runId,
    stepId: 'approve-outreach',
    userId: USER,
    decision: 'reject'
  });
}

async function deliveries(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
    .get<{ total: number }>(WORKSPACE);
  return row?.total ?? 0;
}

async function outreachRuns(): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*)::int AS total FROM playbook_runs WHERE workspace_id=? AND playbook_key='gtm.email-outreach'"
    )
    .get<{ total: number }>(WORKSPACE);
  return row?.total ?? 0;
}

async function sendAttempts(runId: string): Promise<Array<{ status: string; attempt: number }>> {
  return db
    .prepare(
      `SELECT status,attempt FROM playbook_step_runs
       WHERE workspace_id=? AND playbook_run_id=? AND step_id='send-outreach' ORDER BY attempt`
    )
    .all<{ status: string; attempt: number }>(WORKSPACE, runId);
}

beforeEach(async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockClear();
  nangoMock.post.mockClear();
  registerEmailComplianceProvider({
    footer: async () => FOOTER,
    blockers: async () => []
  });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach playbook', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@email-outreach-playbook.test', 'Founder', NOW.toISOString());
  await seedMailbox(CONNECTION, 'founder@acme.test');
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
       (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO linkedin_lead_contacts
       (id,workspace_id,list_id,first_name,last_name,company,email,dedupe_key,created_at,updated_at)
       VALUES ('lilc_playbook_test',?,NULL,'Maya','Chen','Northwind','maya@northwind.test',
               'maya-chen-northwind-playbook',?,?)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('gtm.email-outreach', () => {
  it('waits for approval of the exact email, then sends it from the approved mailbox', async () => {
    const { run, personId, conversationId } = await prepareRun();

    expect(run.status).toBe('waiting_approval');
    expect(run.steps.find((step) => step.stepId === 'approve-outreach')?.input).toEqual({
      recipient: 'maya@northwind.test',
      subject: 'Quick question, Maya',
      body: BODY,
      metadata: {
        conversationId,
        personId,
        contactId: 'lilc_playbook_test',
        leadListId: 'lilst_playbook_test',
        connectionId: CONNECTION,
        senderAddress: 'founder@acme.test',
        requireListUnsubscribe: true,
        deliveryPurpose: 'outreach',
        deliverySourceType: 'email_outreach',
        deliverySourceId: KEY,
        conversationSourceType: 'email_outreach',
        conversationSourceId: KEY,
        intent: 'email-outreach'
      }
    });
    expect(nangoMock.post).not.toHaveBeenCalled();

    const done = await approve(run.id);

    expect(done.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    const send = nangoMock.post.mock.calls[0]![0] as {
      endpoint?: string;
      connectionId?: string;
      data?: { raw?: string };
    };
    expect(send.endpoint).toBe('/gmail/v1/users/me/messages/send');
    expect(send.connectionId).toBe(`${CONNECTION}-external`);
    const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
    expect(mime).toContain('To: maya@northwind.test');
    expect(mime).toContain('List-Unsubscribe: <https://api.trevra.test/u/del_');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');

    expect(
      await db
        .prepare(
          'SELECT connection_id,purpose,source_type,source_id,status FROM gtm_deliveries WHERE workspace_id=?'
        )
        .get(WORKSPACE)
    ).toEqual({
      connection_id: CONNECTION,
      purpose: 'outreach',
      source_type: 'email_outreach',
      source_id: KEY,
      status: 'sent'
    });
    expect(
      await db
        .prepare(
          `SELECT direction,source_type,source_id,body FROM conversation_messages
           WHERE workspace_id=? AND conversation_id=?`
        )
        .all(WORKSPACE, conversationId)
    ).toEqual([
      { direction: 'outbound', source_type: 'email_outreach', source_id: KEY, body: BODY }
    ]);
  });

  it('refuses to send when the approved mailbox now answers as someone else', async () => {
    const { run } = await prepareRun();
    await db
      .prepare('UPDATE connections SET mailbox_address=? WHERE workspace_id=? AND id=?')
      .run('sales@acme.test', WORKSPACE, CONNECTION);

    const failed = await approve(run.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer matches the approved sender founder@acme\.test/);
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('starts only from a prepared outreach plan', async () => {
    await expect(prepareRun({ prepared: false })).rejects.toMatchObject({
      status: 409,
      message: 'Email outreach starts only from a prepared outreach plan.'
    });
    expect(await outreachRuns()).toBe(0);
  });

  it('refuses, and says so, when the approved mailbox address cannot be confirmed', async () => {
    const { run } = await prepareRun();
    // Re-authorization cleared the cached address; the provider names no mailbox.
    await db
      .prepare('UPDATE connections SET mailbox_address=NULL WHERE workspace_id=? AND id=?')
      .run(WORKSPACE, CONNECTION);

    const failed = await approve(run.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(
      'Trevra could not confirm the address of the approved sending mailbox right now; nothing was sent. Prepare this email again.'
    );
    expect(nangoMock.get).toHaveBeenCalled();
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('sends from the approved mailbox even when a newer mailbox is connected', async () => {
    await seedMailbox(
      'conn_email_outreach_playbook_newer',
      'sales@acme.test',
      new Date(NOW.getTime() + 60_000)
    );
    const { run } = await prepareRun();

    const done = await approve(run.id);

    expect(done.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    const send = nangoMock.post.mock.calls[0]![0] as { connectionId?: string };
    expect(send.connectionId).toBe(`${CONNECTION}-external`);
    expect(
      await db
        .prepare('SELECT connection_id FROM gtm_deliveries WHERE workspace_id=?')
        .all(WORKSPACE)
    ).toEqual([{ connection_id: CONNECTION }]);
  });

  it('refuses outreach approved without a sending mailbox instead of using the newest one', async () => {
    await expect(
      executePreparedPlaybookAction(db, {
        workspaceId: WORKSPACE,
        actionType: 'email.send',
        payload: {
          recipient: 'maya@northwind.test',
          subject: 'Quick question, Maya',
          body: BODY,
          metadata: { intent: 'email-outreach', deliveryPurpose: 'outreach' }
        },
        payloadHash: 'unbound-outreach-key'
      })
    ).rejects.toMatchObject({
      status: 409,
      message: 'This outreach email was approved without a sending mailbox; nothing was sent.'
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('refuses a required connection whose verified address was cleared by re-authorization', async () => {
    await db
      .prepare('UPDATE connections SET mailbox_address=NULL WHERE workspace_id=? AND id=?')
      .run(WORKSPACE, CONNECTION);

    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: CONNECTION,
        require_connection_id: true,
        recipient: 'maya@northwind.test',
        subject: 'Hello',
        body: 'Hi',
        structured_payload_json: '{}',
        payload_hash: 'cleared-address-key'
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('never falls back to another connected mailbox, even one with the same address', async () => {
    const { run } = await prepareRun();
    await db
      .prepare("UPDATE connections SET status='disconnected' WHERE workspace_id=? AND id=?")
      .run(WORKSPACE, CONNECTION);
    await seedMailbox('conn_email_outreach_playbook_2', 'founder@acme.test');

    const failed = await approve(run.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer connected/);
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('answers 409 for a half-bound approval or a required connection that is gone', async () => {
    await expect(
      executePreparedPlaybookAction(db, {
        workspaceId: WORKSPACE,
        actionType: 'email.send',
        payload: {
          recipient: 'maya@northwind.test',
          subject: 'Hello',
          body: 'Hi',
          metadata: { connectionId: CONNECTION }
        },
        payloadHash: 'half-bound-approval-key'
      })
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_gone',
        require_connection_id: true,
        recipient: 'maya@northwind.test',
        subject: 'Hello',
        body: 'Hi',
        structured_payload_json: '{}',
        payload_hash: 'required-connection-key'
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  describe('send-time recheck', () => {
    it('sends nothing to a Person suppressed on every channel after preparation', async () => {
      const { run, personId } = await prepareRun();
      // The Person's canonical email moved on, so only the Person id still links
      // the suppression to the approved recipient.
      await db
        .prepare(
          `UPDATE contacts SET email='maya.chen@elsewhere.test',email_normalized='maya.chen@elsewhere.test'
           WHERE workspace_id=? AND id=?`
        )
        .run(WORKSPACE, personId);
      await createSuppression(db, {
        workspaceId: WORKSPACE,
        channel: 'all',
        personId,
        reason: 'Asked to stop everywhere',
        source: 'test'
      });

      const failed = await approve(run.id);

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe(
        'This Person is suppressed for email (Asked to stop everywhere); nothing was sent.'
      );
      expect(nangoMock.post).not.toHaveBeenCalled();
      expect(await deliveries()).toBe(0);
    });

    it('answers 409 and sends nothing while replies to the sending mailbox are not synced', async () => {
      const { run } = await prepareRun();
      await db
        .prepare(
          "UPDATE email_inbound_mailboxes SET sync_status='unavailable' WHERE workspace_id=?"
        )
        .run(WORKSPACE);

      await expect(
        executePreparedPlaybookAction(db, {
          workspaceId: WORKSPACE,
          actionType: 'email.send',
          payload: run.steps.find((step) => step.stepId === 'approve-outreach')?.input,
          payloadHash: 'inbound-unavailable-key'
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/not being read into Conversations.*nothing was sent/)
      });

      // Syncing, but a different mailbox is the inbound one.
      await seedMailbox('conn_email_outreach_playbook_inbound', 'inbox@acme.test');
      await db
        .prepare(
          "UPDATE email_inbound_mailboxes SET connection_id=?,sync_status='syncing' WHERE workspace_id=?"
        )
        .run('conn_email_outreach_playbook_inbound', WORKSPACE);
      const failed = await approve(run.id);

      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/not being read into Conversations.*nothing was sent/);
      expect(nangoMock.post).not.toHaveBeenCalled();
      expect(await deliveries()).toBe(0);
    });
  });

  describe('compliance footer', () => {
    it('refuses with 409 and sends nothing while no compliance footer is available', async () => {
      const { run } = await prepareRun();
      resetEmailComplianceProvider();

      await expect(
        executePreparedPlaybookAction(db, {
          workspaceId: WORKSPACE,
          actionType: 'email.send',
          payload: run.steps.find((step) => step.stepId === 'approve-outreach')?.input,
          payloadHash: 'footer-unavailable-key'
        })
      ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing was sent/) });

      // Through the playbook: one attempt, recorded as a failed run with the reason.
      const failed = await approve(run.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/compliance footer.*nothing was sent/);
      expect(await sendAttempts(run.id)).toEqual([{ status: 'failed', attempt: 1 }]);
      expect(nangoMock.post).not.toHaveBeenCalled();
      expect(await deliveries()).toBe(0);
    });

    it('refuses a blank footer the same way', async () => {
      const { run } = await prepareRun();
      registerEmailComplianceProvider({ footer: async () => '  \n ', blockers: async () => [] });

      const failed = await approve(run.id);

      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/compliance footer.*nothing was sent/);
      expect(nangoMock.post).not.toHaveBeenCalled();
      expect(await deliveries()).toBe(0);
    });

    it('refuses an approved body that was edited to drop the footer', async () => {
      const { run } = await prepareRun();
      await updatePlaybookApprovalBody(db, {
        workspaceId: WORKSPACE,
        runId: run.id,
        stepId: 'approve-outreach',
        userId: USER,
        body: 'Hi Maya,\n\nWould you be open to a short conversation?'
      });

      const failed = await approve(run.id);

      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/does not end with.*compliance footer.*nothing was sent/);
      expect(await sendAttempts(run.id)).toEqual([{ status: 'failed', attempt: 1 }]);
      expect(nangoMock.post).not.toHaveBeenCalled();
      expect(await deliveries()).toBe(0);
    });

    it('sends an edited body once it still ends with the footer', async () => {
      const { run } = await prepareRun();
      await updatePlaybookApprovalBody(db, {
        workspaceId: WORKSPACE,
        runId: run.id,
        stepId: 'approve-outreach',
        userId: USER,
        body: `Hi Maya, quick one.\n\n${FOOTER}\n`
      });

      const done = await approve(run.id);

      expect(done.status).toBe('completed');
      expect(nangoMock.post).toHaveBeenCalledTimes(1);
      expect(await deliveries()).toBe(1);
    });
  });

  describe('run uniqueness (migration 133 indexes)', () => {
    it('never creates a second run for the same idempotency key, even after the first ended', async () => {
      const { run } = await prepareRun();
      await reject(run.id);

      // The engine does not dedupe: the partial unique index raises a raw 23505
      // and the transaction rolls back. Callers map it (prepareEmailOutreach).
      await expect(prepareRun()).rejects.toMatchObject({ code: '23505' });
      expect(await outreachRuns()).toBe(1);
    });

    it('refuses a second open run for the same Person, and frees the Person once it ends', async () => {
      const { run } = await prepareRun();

      await expect(prepareRun({ idempotencyKey: 'eo_playbook_test_0002' })).rejects.toMatchObject({
        code: '23505'
      });
      expect(await outreachRuns()).toBe(1);

      await reject(run.id);
      const next = await prepareRun({ idempotencyKey: 'eo_playbook_test_0003' });
      expect(next.run.status).toBe('waiting_approval');
      expect(await outreachRuns()).toBe(2);
    });
  });
});
