import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>): Promise<unknown> => ({
    data: {},
    headers: {}
  })),
  post: vi.fn(async (_config: Record<string, unknown>): Promise<unknown> => ({
    data: {},
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, prepareGtmPlan, type PreparedGtmPlanResult } from '../gtm/intent.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';
import type { PreparedEmailOutreachResult } from './types.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';
import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';

const WORKSPACE = 'ws_email_zoho_outreach';
const USER = 'usr_email_zoho_outreach';
const CONNECTION = 'conn_email_zoho_outreach';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
const ADDRESS_LINE = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
const FOOTER = `${ADDRESS_LINE}\n${OUTREACH_OPT_OUT_SENTENCE}`;
const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-zoho-outreach/',
  'Ana,Silva,Globex,ana@globex.test,https://www.linkedin.com/in/ana-zoho-outreach/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-zoho-outreach/'
].join('\n');
let db: Db;
let listId: string;

function emailIntent() {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function prepare(idempotencyKey: string): Promise<PreparedEmailOutreachResult> {
  const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
  expect(plan.blockers).toEqual([]);
  const prepared: PreparedGtmPlanResult = await prepareGtmPlan(db, {
    workspaceId: WORKSPACE,
    actorType: 'user',
    actorUserId: USER,
    actorRole: 'owner',
    plan,
    planHash: plan.planHash,
    idempotencyKey
  });
  if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') {
    throw new Error('Expected an email outreach preparation');
  }
  return prepared.result;
}

async function seedSent(count: number): Promise<void> {
  const sentAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at)
       SELECT 'gdel_zoho_outreach_' || n, ?, 'email', ?, 'outreach', 'seed' || n || '@elsewhere.test',
              'test', 'zoho-outreach-' || n, 'zoho-outreach-' || n, 'sent', 'zoho-mail', 'zoho-' || n,
              ?::timestamptz, ?::timestamptz
       FROM generate_series(1, ?::int) AS n`
    )
    .run(WORKSPACE, CONNECTION, sentAt, sentAt, count);
}

async function seedCheck(provider: 'zoho' | 'google'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
        checked_at,expires_at)
       VALUES (?,'acme.test',?,'pass',?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,'[]'::jsonb,?::timestamptz,
               '2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, provider, PASSING, PASSING, PASSING, NOW.toISOString());
}

beforeEach(async () => {
  // No one-click origin on purpose: Zoho outreach must not need it.
  vi.stubEnv('TREVRA_PUBLIC_API_URL', '');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  registerEmailComplianceProvider({ footer: async () => FOOTER, blockers: async () => [] });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho outreach', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'founder@acme.test', 'Founder', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'zoho-mail','trevra-zoho-mail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
       (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
  await seedCheck('zoho');
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Zoho founders' }, NOW);
  listId = list.id;
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId, csv }, NOW);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail outreach plans', () => {
  it('plans Zoho outreach without one-click unsubscribe and says how the opt-out works', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers).toEqual([]);
    expect(plan.defaults).toMatchObject({
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      unsubscribeMode: 'footer_and_reply',
      prepareSupported: true
    });
    const warningCodes = (plan.defaults.warnings as Array<{ code: string }>).map(
      (warning) => warning.code
    );
    expect(warningCodes).toEqual(
      expect.arrayContaining(['email_reply_only_unsubscribe', 'email_zoho_daily_cap'])
    );
    // email_unsubscribe_unavailable is a blocker, not a warning.
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain(
      'email_unsubscribe_unavailable'
    );
    const send = plan.steps.find((step) => step.kind === 'send');
    expect(send?.detail).toContain('reply "unsubscribe"');
    expect(send?.detail).toContain(`at most ${ZOHO_OUTREACH_DAILY_CAP} a day`);
  });

  it('plans with the effective daily cap when the operator limit is lower', async () => {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings (workspace_id,connection_id,daily_limit)
         VALUES (?,?,5)`
      )
      .run(WORKSPACE, CONNECTION);
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    const send = plan.steps.find((step) => step.kind === 'send');
    expect(send?.detail).toContain('at most 5 a day');
    const capWarning = (plan.defaults.warnings as Array<{ code: string; message: string }>).find(
      (warning) => warning.code === 'email_zoho_daily_cap'
    );
    expect(capWarning?.message).toContain('at most 5 outreach emails a day');
  });

  it('still requires one-click unsubscribe for a Gmail sender', async () => {
    await db
      .prepare(
        `UPDATE connections SET provider='gmail',provider_config_key='trevra-gmail'
         WHERE workspace_id=? AND id=?`
      )
      .run(WORKSPACE, CONNECTION);
    await seedCheck('google');
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('email_unsubscribe_unavailable');
    expect(plan.defaults.unsubscribeMode).toBe('list_unsubscribe_headers');
  });

  it('blocks Zoho outreach when the footer has no single opt-out line to turn into a reply line', async () => {
    registerEmailComplianceProvider({ footer: async () => ADDRESS_LINE, blockers: async () => [] });
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('email_opt_out_line_missing');
  });

  it('prepares 1.1.0 approvals that end with the reply-to-unsubscribe footer', async () => {
    const result = await prepare('zoho-prepare-0001');
    expect(result.prepared).toHaveLength(3);
    const runs = await db
      .prepare(
        `SELECT playbook_version,input_json->>'unsubscribeMode' AS mode,
                input_json->>'requireListUnsubscribe' AS require_header,input_json->>'body' AS body
         FROM playbook_runs WHERE workspace_id=?`
      )
      .all<{ playbook_version: string; mode: string; require_header: string; body: string }>(
        WORKSPACE
      );
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run).toMatchObject({
        playbook_version: '1.1.0',
        mode: 'footer_and_reply',
        require_header: 'false'
      });
      expect(run.body.endsWith(`${ADDRESS_LINE}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`)).toBe(true);
      // [E-A3] the first-touch text no longer carries the one-click sentence itself.
      expect(run.body).not.toContain(OUTREACH_OPT_OUT_SENTENCE);
    }
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('never prepares past the Zoho daily cap, across preparations and despite a higher operator limit', async () => {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings
         (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
         VALUES (?,?,200,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)`
      )
      .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 2);

    const first = await prepare('zoho-prepare-cap-1');
    expect(first.prepared).toHaveLength(2);
    expect(first.skipped.map((item) => item.reason)).toEqual(['daily_cap']);

    // The two waiting approvals count against today's cap: nothing more is prepared.
    const second = await prepare('zoho-prepare-cap-2');
    expect(second.prepared).toEqual([]);
    expect(second.skipped.map((item) => item.reason).sort()).toEqual([
      'already_pending',
      'already_pending',
      'daily_cap'
    ]);
  });
});
