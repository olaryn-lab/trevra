import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent } from '../gtm/intent.js';
import { registerEmailComplianceProvider, resetEmailComplianceProvider } from './compliance.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';

const WORKSPACE = 'ws_email_outreach_plan';
const CONNECTION = 'conn_email_outreach_plan';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
let db: Db;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-email-plan/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-email-plan/',
  'Lena,Frei,Globex,,https://www.linkedin.com/in/lena-email-plan/'
].join('\n');

async function seedMailbox(id = CONNECTION, address = 'founder@acme.test'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?,?)`
    )
    .run(id, WORKSPACE, `${id}-external`, address, NOW.toISOString(), NOW.toISOString());
}

async function seedInbound(
  status: 'starting' | 'syncing' | 'unavailable' = 'syncing',
  connectionId = CONNECTION
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
       (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test',?,?,?)`
    )
    .run(WORKSPACE, connectionId, status, NOW.toISOString(), NOW.toISOString());
}

async function seedCheck(status: 'pass' | 'fail', blockers: unknown[] = []): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
        checked_at,expires_at)
       VALUES (?,'acme.test','google',?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,
               ?::timestamptz,'2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, status, PASSING, PASSING, PASSING, JSON.stringify(blockers), NOW.toISOString());
}

async function peopleList(rows = csv, name = 'Email founders'): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name }, NOW);
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv: rows }, NOW);
  return list.id;
}

function emailIntent(listId: string) {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function codes(intent: unknown): Promise<string[]> {
  return (await compileGtmIntent(db, WORKSPACE, intent)).blockers.map((blocker) => blocker.code);
}

beforeEach(async () => {
  registerEmailComplianceProvider({ footer: async () => null, blockers: async () => [] });
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach plan', NOW.toISOString());
});

afterEach(async () => {
  resetEmailComplianceProvider();
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('email-only prepare_outreach plans', () => {
  it('compiles a deterministic email plan from one passing sender', async () => {
    await seedMailbox();
    await seedInbound();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    const again = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));

    expect(again.planHash).toBe(plan.planHash);
    expect(plan.blockers).toEqual([]);
    expect(plan.summary).toBe('Email 2 People in Email founders from founder@acme.test');
    expect(plan.defaults).toEqual({
      channel: 'email',
      leadListId: listId,
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      recipientCount: 2,
      warnings: [],
      prepareSupported: true
    });
    expect(plan.steps.map((step) => [step.kind, step.externalEffect])).toEqual([
      ['people', false],
      ['sender', false],
      ['approval', false],
      ['send', true]
    ]);
    expect(plan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });
    expect(plan.next).toEqual({ kind: 'review_email_approvals', href: '/ledger' });

    const marked = await db
      .prepare('SELECT outreach_requested_at FROM email_deliverability_checks WHERE workspace_id=?')
      .get<{ outreach_requested_at: string | null }>(WORKSPACE);
    expect(marked?.outreach_requested_at).not.toBeNull();
  });

  it('carries no warnings and supports preparing once replies sync', async () => {
    await seedMailbox();
    await seedInbound();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers).toEqual([]);
    expect(plan.defaults.warnings).toEqual([]);
    expect(plan.defaults.prepareSupported).toBe(true);
  });

  it('blocks with the default compliance provider until Phase E registers one', async () => {
    resetEmailComplianceProvider();
    await seedMailbox();
    await seedInbound();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers).toEqual([
      {
        code: 'email_compliance_footer_unavailable',
        message:
          'Outreach email needs a compliance footer (legal name, postal address, opt-out). Complete sender compliance in Workspace settings.',
        actionHref: '/setup/workspace'
      }
    ]);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('blocks when no inbound mailbox is designated', async () => {
    await seedMailbox();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers).toEqual([
      {
        code: 'email_replies_not_synced',
        message:
          'Replies to founder@acme.test are not read into Conversations. Choose it as the inbound mailbox in Workspace settings.',
        actionHref: '/setup/workspace'
      }
    ]);
    expect(plan.defaults.warnings).toEqual([]);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('blocks while the inbound mailbox is unavailable or still starting', async () => {
    await seedMailbox();
    await seedInbound('unavailable');
    await seedCheck('pass');
    const listId = await peopleList();
    expect(await codes(emailIntent(listId))).toEqual(['email_replies_not_synced']);

    await db
      .prepare("UPDATE email_inbound_mailboxes SET sync_status='starting' WHERE workspace_id=?")
      .run(WORKSPACE);
    expect(await codes(emailIntent(listId))).toEqual(['email_replies_not_synced']);
  });

  it('blocks when the inbound mailbox is designated on a different connection', async () => {
    await seedMailbox();
    await seedMailbox('conn_email_outreach_plan_other', 'other@acme.test');
    await seedInbound('syncing', 'conn_email_outreach_plan_other');
    await db
      .prepare('UPDATE connections SET status=? WHERE workspace_id=? AND id=?')
      .run('disconnected', WORKSPACE, 'conn_email_outreach_plan_other');
    await seedCheck('pass');
    const listId = await peopleList();

    expect(await codes(emailIntent(listId))).toEqual(['email_replies_not_synced']);
  });

  it('blocks without a one-click unsubscribe origin', async () => {
    vi.stubEnv('TREVRA_PUBLIC_API_URL', '');
    await seedMailbox();
    await seedInbound();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['email_unsubscribe_unavailable']);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('turns SPF, DKIM and DMARC failures into plan blockers', async () => {
    await seedMailbox();
    await seedInbound();
    const dkim = {
      code: 'email_dkim_missing',
      message: 'No DKIM key is published for acme.test at google._domainkey.',
      actionHref: '/setup/workspace'
    };
    await seedCheck('fail', [dkim]);
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers).toEqual([dkim]);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('treats a DNS answer it could not get as a blocker, never a pass', async () => {
    await seedMailbox();
    await seedInbound();
    const listId = await peopleList();

    expect(await codes(emailIntent(listId))).toEqual(['email_deliverability_unknown']);
    const stored = await db
      .prepare('SELECT status FROM email_deliverability_checks WHERE workspace_id=?')
      .get<{ status: string }>(WORKSPACE);
    expect(stored?.status).toBe('unknown');
  });

  it('names the missing, ambiguous or unusable piece', async () => {
    await seedCheck('pass');
    const listId = await peopleList();
    expect(await codes(emailIntent(listId))).toEqual(['email_sender_missing']);

    await seedMailbox();
    await seedMailbox('conn_email_outreach_plan_2', 'sales@acme.test');
    expect(await codes(emailIntent(listId))).toEqual(['email_sender_ambiguous']);

    await db
      .prepare('DELETE FROM connections WHERE workspace_id=? AND id=?')
      .run(WORKSPACE, 'conn_email_outreach_plan_2');
    const withoutEmail = await peopleList(
      [
        'First Name,Last Name,Company,Email,LinkedIn URL',
        'Ida,Brun,Initech,,https://www.linkedin.com/in/ida-email-plan/'
      ].join('\n'),
      'Email without addresses'
    );
    await seedInbound();
    expect(await codes(emailIntent(withoutEmail))).toEqual(['email_recipients_missing']);
    expect(await codes(emailIntent('lilst_missing'))).toEqual(['lead_list_not_found']);
    expect(
      await codes({ ...emailIntent(listId), people: { uploadedInputRef: 'upload://people.csv' } })
    ).toEqual(['uploaded_input_not_materialized']);
    expect(
      await codes({
        ...emailIntent(listId),
        channels: ['email', 'linkedin'] as Array<'linkedin' | 'email' | 'community'>
      })
    ).toContain('prepare_outreach_single_channel');
  });
});
