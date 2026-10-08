import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

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

// Pass-through spy: the real engine runs, and the test can read the exact
// playbook version each run start asked for.
vi.mock('../playbooks/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../playbooks/engine.js')>();
  return { ...actual, startPlaybookRun: vi.fn(actual.startPlaybookRun) };
});

import { openDatabase, type Db } from '../db.js';
import {
  compileGtmIntent,
  prepareGtmPlan,
  type GtmPlan,
  type PreparedGtmPlanResult
} from '../gtm/intent.js';
import { createLeadList, importLeadCsv, updateLeadContact } from '../linkedin/lead-lists.js';
import { decidePlaybookApproval, startPlaybookRun } from '../playbooks/engine.js';
import { createSuppression } from '../suppressions.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';
import {
  EMAIL_OUTREACH_PLAYBOOK_VERSION,
  isOutreachRunConflict,
  prepareEmailOutreach
} from './outreach.js';
import type { PreparedEmailOutreachResult } from './types.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';

const WORKSPACE = 'ws_email_outreach_prepare';
const USER = 'usr_email_outreach_prepare';
const CONNECTION = 'conn_email_outreach_prepare';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
const FOOTER = `Acme Labs Ltd, 1 Market Street, London EC1A 1AA\n${OUTREACH_OPT_OUT_SENTENCE}`;
const ZOHO_FOOTER = `Acme Labs Ltd, 1 Market Street, London EC1A 1AA\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`;
let db: Db;
let listId: string;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-email-prepare/',
  'Ana,Silva,Globex,ana@globex.test,https://www.linkedin.com/in/ana-email-prepare/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-email-prepare/',
  'Lena,Frei,Initech,,https://www.linkedin.com/in/lena-email-prepare/',
  'Priya,Rao,Umbrella,priya@umbrella.test,https://www.linkedin.com/in/priya-email-prepare/',
  'Omar,Haddad,Hooli,omar@hooli.test,https://www.linkedin.com/in/omar-email-prepare/',
  'Ben,Okafor,Vandelay,ben@vandelay.test,https://www.linkedin.com/in/ben-email-prepare/'
].join('\n');

function emailIntent() {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function prepare(idempotencyKey: string): Promise<PreparedGtmPlanResult> {
  const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
  expect(plan.blockers).toEqual([]);
  return prepareGtmPlan(db, {
    workspaceId: WORKSPACE,
    actorType: 'user',
    actorUserId: USER,
    actorRole: 'owner',
    plan,
    planHash: plan.planHash,
    idempotencyKey
  });
}

/** prepareEmailOutreach's input for a compiled email plan, bypassing the plan re-check. */
function preparationInput(plan: GtmPlan, idempotencyKey: string) {
  return {
    workspaceId: WORKSPACE,
    actorType: 'user' as const,
    actorId: USER,
    idempotencyKey,
    planHash: plan.planHash,
    leadListId: listId,
    connectionId: String(plan.defaults.connectionId),
    senderAddress: String(plan.defaults.senderAddress)
  };
}

function emailResult(prepared: PreparedGtmPlanResult): PreparedEmailOutreachResult {
  if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') {
    throw new Error('Expected an email outreach preparation');
  }
  return prepared.result;
}

async function names(): Promise<Map<string, string>> {
  const rows = await db
    .prepare('SELECT id,first_name FROM linkedin_lead_contacts WHERE workspace_id=?')
    .all<{ id: string; first_name: string }>(WORKSPACE);
  return new Map(rows.map((row) => [row.id, row.first_name]));
}

async function outcome(result: PreparedEmailOutreachResult) {
  const byId = await names();
  return {
    prepared: result.prepared.map((item) => byId.get(item.contactId)).sort(),
    skipped: Object.fromEntries(
      result.skipped.map((item) => [byId.get(item.contactId), item.reason])
    )
  };
}

async function updateLead(sql: string, email: string): Promise<void> {
  await db.prepare(sql).run(NOW.toISOString(), WORKSPACE, email);
}

/** Turn the sending mailbox into a Zoho Mail connection that answers as founder@acme.test. */
async function useZohoMailbox(): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET provider='zoho-mail',provider_config_key='trevra-zoho-mail'
       WHERE workspace_id=? AND id=?`
    )
    .run(WORKSPACE, CONNECTION);
  (nangoMock.get as unknown as Mock).mockImplementation(
    async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === '/api/accounts') {
        return {
          data: {
            data: [
              {
                accountId: '1000000001',
                type: 'ZOHO_ACCOUNT',
                primaryEmailAddress: 'founder@acme.test'
              }
            ]
          },
          headers: {}
        };
      }
      if (endpoint === '/api/accounts/1000000001/folders') {
        return {
          data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] },
          headers: {}
        };
      }
      return {
        data: { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } },
        headers: {}
      };
    }
  );
  (nangoMock.post as unknown as Mock).mockResolvedValue({
    data: { status: { code: 200 }, data: { messageId: '1777' } },
    headers: {}
  });
}

/** prepareEmailOutreach's input for the seeded mailbox, without compiling a plan. */
function directInput(idempotencyKey: string) {
  return {
    workspaceId: WORKSPACE,
    actorType: 'user' as const,
    actorId: USER,
    idempotencyKey,
    planHash: `plan-${idempotencyKey}`,
    leadListId: listId,
    connectionId: CONNECTION,
    senderAddress: 'founder@acme.test'
  };
}

interface OutreachRunInput {
  id: string;
  playbook_version: string;
  recipient: string;
  body: string;
  unsubscribe_mode: string | null;
  require_list_unsubscribe: string | null;
}

async function outreachRunInputs(): Promise<OutreachRunInput[]> {
  return db
    .prepare(
      `SELECT id,playbook_version,input_json->>'recipient' AS recipient,input_json->>'body' AS body,
              input_json->>'unsubscribeMode' AS unsubscribe_mode,
              input_json->>'requireListUnsubscribe' AS require_list_unsubscribe
       FROM playbook_runs WHERE workspace_id=? AND playbook_key='gtm.email-outreach'
       ORDER BY input_json->>'recipient'`
    )
    .all<OutreachRunInput>(WORKSPACE);
}

async function count(table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE workspace_id=?`)
    .get<{ total: number }>(WORKSPACE);
  return row?.total ?? 0;
}

beforeEach(async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockClear();
  nangoMock.post.mockClear();
  vi.mocked(startPlaybookRun).mockClear();
  registerEmailComplianceProvider({ footer: async () => FOOTER, blockers: async () => [] });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach prepare', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@email-outreach-prepare.test', 'Founder', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
       (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
       VALUES (?,'acme.test','google','pass',?::jsonb,?::jsonb,?::jsonb,?::timestamptz,
               '2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, PASSING, PASSING, PASSING, NOW.toISOString());

  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Email founders' }, NOW);
  listId = list.id;
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId, csv }, NOW);
  await updateLead(
    `UPDATE linkedin_lead_contacts SET do_not_contact=TRUE,updated_at=?
     WHERE workspace_id=? AND LOWER(email)=?`,
    'omar@hooli.test'
  );
  await updateLead(
    `UPDATE linkedin_lead_contacts SET person_id=NULL,person_resolution_status='conflict',updated_at=?
     WHERE workspace_id=? AND LOWER(email)=?`,
    'ben@vandelay.test'
  );
  await createSuppression(db, {
    workspaceId: WORKSPACE,
    channel: 'email',
    email: 'priya@umbrella.test',
    reason: 'Unsubscribed',
    source: 'test'
  });
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at,created_at,updated_at)
       VALUES ('gdel_jonas_earlier',?,'email',?,'outreach','jonas@northstar.test','test','jonas-earlier',
               'jonas-earlier','sent','gmail','gmail-jonas-1',?,?,?,?)`
    )
    .run(
      WORKSPACE,
      CONNECTION,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString()
    );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // A Zoho implementation must never leak into the next test.
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  nangoMock.post.mockReset();
  nangoMock.post.mockResolvedValue({ data: { id: 'gmail-outreach-1' }, headers: {} });
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('prepareEmailOutreach', () => {
  it('prepares one approval per eligible Person, sends nothing, and replays by key', async () => {
    const prepared = await prepare('email-prepare-0001');
    const result = emailResult(prepared);

    expect(prepared).toMatchObject({
      status: 'prepared',
      objective: 'prepare_outreach',
      channel: 'email',
      next: { kind: 'review_email_approvals', href: '/ledger' }
    });
    expect(await outcome(result)).toEqual({
      prepared: ['Ana', 'Maya'],
      skipped: {
        Jonas: 'already_contacted',
        Lena: 'no_email',
        Priya: 'suppressed',
        Omar: 'do_not_contact',
        Ben: 'unresolved_person'
      }
    });
    expect(result).toMatchObject({
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      truncated: false,
      duplicate: false
    });
    if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') return;
    expect(prepared.artifacts.runIds).toEqual(result.prepared.map((item) => item.runId));

    const runs = await db
      .prepare(
        `SELECT status,input_json->>'recipient' AS recipient,input_json->>'subject' AS subject,
                input_json->>'body' AS body
         FROM playbook_runs WHERE workspace_id=? AND playbook_key='gtm.email-outreach'
         ORDER BY input_json->>'recipient'`
      )
      .all<{ status: string; recipient: string; subject: string; body: string }>(WORKSPACE);
    expect(runs.map(({ status, recipient, subject }) => ({ status, recipient, subject }))).toEqual([
      { status: 'waiting_approval', recipient: 'ana@globex.test', subject: 'Quick question, Ana' },
      {
        status: 'waiting_approval',
        recipient: 'maya@northwind.test',
        subject: 'Quick question, Maya'
      }
    ]);
    expect(runs[1]!.body).toContain('Hi Maya,');
    expect(runs[1]!.body).toContain('Northwind');
    expect(nangoMock.post).not.toHaveBeenCalled();
    const sent = await db
      .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(sent?.total).toBe(1);

    const replay = emailResult(await prepare('email-prepare-0001'));
    expect(replay.duplicate).toBe(true);
    expect(replay.prepared).toEqual(result.prepared);
  });

  it('ends every body with the compliance footer, which carries the only opt-out sentence', async () => {
    emailResult(await prepare('email-prepare-0001'));

    const bodies = await db
      .prepare(
        `SELECT input_json->>'body' AS body FROM playbook_runs
         WHERE workspace_id=? AND playbook_key='gtm.email-outreach'`
      )
      .all<{ body: string }>(WORKSPACE);
    expect(bodies).toHaveLength(2);
    for (const { body } of bodies) {
      expect(body).toContain(`?\n\n${FOOTER}`);
      expect(body.endsWith(`\n\n${FOOTER}`)).toBe(true);
      expect(body.split(OUTREACH_OPT_OUT_SENTENCE)).toHaveLength(2);
    }
  });

  it('refuses to prepare, writing nothing, while no compliance footer is available', async () => {
    // The plan itself blocks without a footer.
    registerEmailComplianceProvider({ footer: async () => null, blockers: async () => [] });
    const blocked = await compileGtmIntent(db, WORKSPACE, emailIntent());
    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan: blocked,
        planHash: blocked.planHash,
        idempotencyKey: 'email-prepare-no-footer'
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/compliance footer/) });

    // A footer that disappears between planning and preparing still refuses.
    registerEmailComplianceProvider({ footer: async () => FOOTER, blockers: async () => [] });
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers).toEqual([]);
    for (const footer of [null, '  \n ']) {
      registerEmailComplianceProvider({ footer: async () => footer, blockers: async () => [] });
      await expect(
        prepareEmailOutreach(db, preparationInput(plan, 'email-prepare-no-footer'))
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/compliance footer/)
      });
    }
    expect(await count('playbook_runs')).toBe(0);
    expect(await count('email_outreach_preparations')).toBe(0);
    expect(await count('conversations')).toBe(0);
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('replays an existing receipt even after the footer becomes unavailable', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    const first = emailResult(
      await prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'email-prepare-0001'
      })
    );
    registerEmailComplianceProvider({ footer: async () => null, blockers: async () => [] });

    const replay = await prepareEmailOutreach(db, preparationInput(plan, 'email-prepare-0001'));

    expect(replay.duplicate).toBe(true);
    expect(replay.prepared).toEqual(first.prepared);
  });

  it('never lists a run that already ended as prepared when a crashed preparation is retried', async () => {
    const first = emailResult(await prepare('email-prepare-0001'));
    const byId = await names();
    const maya = first.prepared.find((item) => byId.get(item.contactId) === 'Maya')!;
    // Crash before the receipt was written: the runs exist, the receipt does not.
    await db.prepare('DELETE FROM email_outreach_preparations WHERE workspace_id=?').run(WORKSPACE);
    const rejected = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya.runId,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'reject'
    });
    expect(rejected.status).not.toBe('waiting_approval');

    const retry = emailResult(await prepare('email-prepare-0001'));

    expect(retry.duplicate).toBe(false);
    expect(retry.prepared.map((item) => item.runId)).not.toContain(maya.runId);
    expect(await outcome(retry)).toMatchObject({
      prepared: ['Ana'],
      skipped: { Maya: 'already_pending' }
    });
    expect(await count('playbook_runs')).toBe(2);
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('maps only unique violations on the two outreach-run indexes', () => {
    expect(
      isOutreachRunConflict({
        code: '23505',
        constraint: 'idx_playbook_runs_email_outreach_idempotency'
      })
    ).toBe(true);
    expect(
      isOutreachRunConflict({
        code: '23505',
        constraint: 'idx_playbook_runs_email_outreach_open_person'
      })
    ).toBe(true);
    expect(isOutreachRunConflict({ code: '23505', constraint: 'playbook_runs_pkey' })).toBe(false);
    expect(isOutreachRunConflict({ code: '23505' })).toBe(false);
    expect(
      isOutreachRunConflict({
        code: '23503',
        constraint: 'idx_playbook_runs_email_outreach_idempotency'
      })
    ).toBe(false);
    expect(isOutreachRunConflict(null)).toBe(false);
  });

  it('refuses a reused key for another plan and never queues a second email per Person', async () => {
    emailResult(await prepare('email-prepare-0001'));
    await updateLead(
      `UPDATE linkedin_lead_contacts SET do_not_contact=TRUE,updated_at=?
       WHERE workspace_id=? AND LOWER(email)=?`,
      'jonas@northstar.test'
    );

    const changed = await compileGtmIntent(db, WORKSPACE, emailIntent());
    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan: changed,
        planHash: changed.planHash,
        idempotencyKey: 'email-prepare-0001'
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/different email plan/)
    });

    const again = emailResult(await prepare('email-prepare-0002'));
    expect(await outcome(again)).toEqual({
      prepared: [],
      skipped: {
        Maya: 'already_pending',
        Ana: 'already_pending',
        Jonas: 'do_not_contact',
        Lena: 'no_email',
        Priya: 'suppressed',
        Omar: 'do_not_contact',
        Ben: 'unresolved_person'
      }
    });
    const runs = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM playbook_runs
         WHERE workspace_id=? AND playbook_key='gtm.email-outreach'`
      )
      .get<{ total: number }>(WORKSPACE);
    expect(runs?.total).toBe(2);
  });

  it('records the real actor on every run and receipt it prepares', async () => {
    async function actors(key: string) {
      const receipt = await db
        .prepare(
          'SELECT actor_user_id,run_ids_json FROM email_outreach_preparations WHERE workspace_id=? AND idempotency_key=?'
        )
        .get<{ actor_user_id: string | null; run_ids_json: string[] }>(WORKSPACE, key);
      const runs = await db
        .prepare(
          `SELECT DISTINCT actor_type,actor_id FROM playbook_runs
           WHERE workspace_id=? AND id = ANY(?::text[])`
        )
        .all<{ actor_type: string; actor_id: string | null }>(WORKSPACE, receipt!.run_ids_json);
      return { receiptUser: receipt!.actor_user_id, runs };
    }

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'agent',
      actorUserId: 'agt_outreach',
      actorRole: 'owner',
      plan,
      planHash: plan.planHash,
      idempotencyKey: 'email-prepare-agent'
    });
    expect(await actors('email-prepare-agent')).toEqual({
      receiptUser: null,
      runs: [{ actor_type: 'agent', actor_id: 'agt_outreach' }]
    });

    // Free the People again, then prepare through the user route's entry point.
    await db
      .prepare("UPDATE playbook_runs SET status='cancelled' WHERE workspace_id=?")
      .run(WORKSPACE);
    await prepare('email-prepare-user');
    expect(await actors('email-prepare-user')).toEqual({
      receiptUser: USER,
      runs: [{ actor_type: 'user', actor_id: USER }]
    });
  });

  it('sends nothing to a lead marked do-not-contact after the email was prepared', async () => {
    const result = emailResult(await prepare('email-prepare-0001'));
    const byId = await names();
    const maya = result.prepared.find((item) => byId.get(item.contactId) === 'Maya')!;
    await updateLeadContact(
      db,
      {
        workspaceId: WORKSPACE,
        contactId: maya.contactId,
        firstName: 'Maya',
        lastName: 'Chen',
        company: 'Northwind',
        email: 'maya@northwind.test',
        profileUrl: 'https://www.linkedin.com/in/maya-email-prepare/',
        doNotContact: true
      },
      NOW
    );

    const failed = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya.runId,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'approve'
    });

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(
      'This Person was marked do-not-contact after the email was prepared; nothing was sent.'
    );
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await count('gtm_deliveries')).toBe(1);
  });

  it('counts a Person as already emailed once their approved email is sent', async () => {
    emailResult(await prepare('email-prepare-0001'));
    const maya = await db
      .prepare(
        `SELECT id,input_json->>'conversationId' AS conversation_id FROM playbook_runs
         WHERE workspace_id=? AND playbook_key='gtm.email-outreach'
           AND input_json->>'recipient'='maya@northwind.test'`
      )
      .get<{ id: string; conversation_id: string }>(WORKSPACE);

    const sent = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya!.id,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'approve'
    });
    expect(sent.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);

    const next = emailResult(await prepare('email-prepare-0003'));
    expect((await outcome(next)).skipped).toMatchObject({
      Maya: 'already_contacted',
      Ana: 'already_pending'
    });
    expect(
      await db
        .prepare(
          `SELECT direction,source_type FROM conversation_messages
           WHERE workspace_id=? AND conversation_id=?`
        )
        .all(WORKSPACE, maya!.conversation_id)
    ).toEqual([{ direction: 'outbound', source_type: 'email_outreach' }]);
  });
});

describe('prepareEmailOutreach opt-out mode (gtm.email-outreach@1.1.0)', () => {
  it('pins every new run to 1.1.0 explicitly, never to whatever version is latest', async () => {
    emailResult(await prepare('email-prepare-0001'));

    expect(EMAIL_OUTREACH_PLAYBOOK_VERSION).toBe('1.1.0');
    const starts = vi.mocked(startPlaybookRun).mock.calls.map(([, input]) => input);
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start).toMatchObject({ playbookId: 'gtm.email-outreach', version: '1.1.0' });
    }
    expect((await outreachRunInputs()).map((run) => run.playbook_version)).toEqual([
      '1.1.0',
      '1.1.0'
    ]);
  });

  it('prepares Gmail outreach in header mode, and the approved email carries one-click unsubscribe', async () => {
    emailResult(await prepare('email-prepare-0001'));
    const runs = await outreachRunInputs();
    for (const run of runs) {
      expect(run).toMatchObject({
        playbook_version: '1.1.0',
        unsubscribe_mode: 'list_unsubscribe_headers',
        require_list_unsubscribe: 'true'
      });
      expect(run.body.endsWith(`\n\n${FOOTER}`)).toBe(true);
    }
    const maya = runs.find((run) => run.recipient === 'maya@northwind.test')!;

    const sent = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya.id,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'approve'
    });

    expect(sent.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    const send = nangoMock.post.mock.calls[0]![0] as { endpoint?: string; data?: { raw?: string } };
    expect(send.endpoint).toBe('/gmail/v1/users/me/messages/send');
    const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
    expect(mime).toContain('List-Unsubscribe: <https://api.trevra.test/u/del_');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('prepares Zoho outreach with the reply-to-unsubscribe footer, which then sends through Zoho', async () => {
    await useZohoMailbox();

    const result = await prepareEmailOutreach(db, directInput('email-prepare-zoho'));

    expect((await outcome(result)).prepared).toEqual(['Ana', 'Maya']);
    const runs = await outreachRunInputs();
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toMatchObject({
        playbook_version: '1.1.0',
        unsubscribe_mode: 'footer_and_reply',
        require_list_unsubscribe: 'false'
      });
      expect(run.body.endsWith(`?\n\n${ZOHO_FOOTER}`)).toBe(true);
      expect(run.body.trimEnd().endsWith(OUTREACH_REPLY_OPT_OUT_SENTENCE)).toBe(true);
      expect(run.body).not.toContain(OUTREACH_OPT_OUT_SENTENCE);
    }
    expect(nangoMock.post).not.toHaveBeenCalled();
    const maya = runs.find((run) => run.recipient === 'maya@northwind.test')!;

    const sent = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya.id,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'approve'
    });

    expect(sent.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    expect(nangoMock.post.mock.calls[0]![0]).toMatchObject({
      endpoint: '/api/accounts/1000000001/messages',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: `${CONNECTION}-external`,
      data: { fromAddress: 'founder@acme.test', content: maya.body, mailFormat: 'plaintext' }
    });
    expect(JSON.stringify(nangoMock.post.mock.calls)).not.toContain('List-Unsubscribe');
    expect(
      await db
        .prepare(
          `SELECT provider,status,recipient FROM gtm_deliveries
           WHERE workspace_id=? AND source_type='email_outreach'`
        )
        .all(WORKSPACE)
    ).toEqual([{ provider: 'zoho-mail', status: 'sent', recipient: 'maya@northwind.test' }]);
  });

  it('refuses to prepare Zoho outreach, writing nothing, without one opt-out line or a connected mailbox', async () => {
    await useZohoMailbox();
    registerEmailComplianceProvider({
      footer: async () => 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA',
      blockers: async () => []
    });
    await expect(
      prepareEmailOutreach(db, directInput('email-prepare-zoho-no-line'))
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/needs its opt-out line exactly once/)
    });

    registerEmailComplianceProvider({ footer: async () => FOOTER, blockers: async () => [] });
    await db
      .prepare("UPDATE connections SET status='disconnected' WHERE workspace_id=? AND id=?")
      .run(WORKSPACE, CONNECTION);
    await expect(
      prepareEmailOutreach(db, directInput('email-prepare-zoho-gone'))
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/no longer connected/)
    });

    expect(await count('playbook_runs')).toBe(0);
    expect(await count('email_outreach_preparations')).toBe(0);
  });
});
