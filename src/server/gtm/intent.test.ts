import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import { upsertSeat } from '../linkedin/seats.js';
import { saveSenderIdentity } from '../compliance/sender-identity.js';
import { senderComplianceProvider } from '../compliance/provider.js';
import {
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from '../email/compliance.js';
import { compileGtmIntent, prepareGtmPlan } from './intent.js';

const WORKSPACE = 'ws_gtm_intent_test';
const USER = 'usr_gtm_intent_test';
const NOW = new Date('2026-08-21T09:00:00.000Z');
let db: Db;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Acme,maya-intent@example.com,https://www.linkedin.com/in/maya-intent/',
  'Jonas,Keller,Northstar,jonas-intent@example.com,https://www.linkedin.com/in/jonas-intent/'
].join('\n');

async function reset(): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'GTM Intent', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'founder@intent.test', 'Founder', NOW.toISOString());
}

async function peopleList(): Promise<{ id: string; seatKey: string }> {
  const seat = await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder', timezone: 'Europe/Zurich' },
    NOW
  );
  const list = await createLeadList(
    db,
    {
      workspaceId: WORKSPACE,
      seatKey: seat.seatKey,
      name: 'Swiss SaaS founders',
      sourceKind: 'csv',
      sourceRef: 'intent-test'
    },
    NOW
  );
  await importLeadCsv(
    db,
    { workspaceId: WORKSPACE, seatKey: seat.seatKey, listId: list.id, csv },
    NOW
  );
  return { id: list.id, seatKey: seat.seatKey };
}

beforeEach(async () => {
  registerEmailComplianceProvider(senderComplianceProvider);
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await reset();
});

afterEach(async () => {
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('bounded GTM intent compiler', () => {
  it('plans every account objective without turning the compiler into an execution engine', async () => {
    const objectives = ['find_accounts', 'research_accounts', 'watch_accounts'] as const;

    for (const objective of objectives) {
      const plan = await compileGtmIntent(db, WORKSPACE, {
        objective,
        audience: { description: 'Swiss B2B SaaS companies', quantity: 30 }
      });
      expect(plan.objective).toBe(objective);
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.consequences.externalWrites).toBe(false);
      expect(plan.steps.every((step) => step.externalEffect === false)).toBe(true);
      expect(plan.defaults.prepareSupported).toBe(false);
    }
  });

  it('prepares signed inbound capture idempotently and keeps credential creation owner-only', async () => {
    const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;
    process.env.TREVRA_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const plan = await compileGtmIntent(db, WORKSPACE, {
        objective: 'capture_inbound',
        capture: { name: 'Demo requests', kind: 'form' }
      });

      expect(plan.blockers).toEqual([]);
      expect(plan.defaults).toMatchObject({
        prepareSupported: true,
        sourceName: 'Demo requests',
        sourceKind: 'form'
      });

      const memberPlan = await compileGtmIntent(
        db,
        WORKSPACE,
        {
          objective: 'capture_inbound',
          capture: { name: 'Demo requests', kind: 'form' }
        },
        { actorRole: 'member' }
      );
      expect(memberPlan.defaults.prepareSupported).toBe(false);
      expect(memberPlan.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'capture_owner_required' })])
      );
      await expect(
        prepareGtmPlan(db, {
          workspaceId: WORKSPACE,
          actorType: 'user',
          actorUserId: USER,
          actorRole: 'member',
          plan: memberPlan,
          planHash: memberPlan.planHash,
          idempotencyKey: 'gtm-capture-member-0001'
        })
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(/owners/i)
      });
      const prepared = await prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'gtm-capture-owner-0001'
      });
      expect(prepared.objective).toBe('capture_inbound');
      if (prepared.objective !== 'capture_inbound') throw new Error('Expected capture preparation');
      expect(prepared.result).toMatchObject({
        duplicate: false,
        source: { name: 'Demo requests', kind: 'form', status: 'active' }
      });
      expect(prepared.result.secret).toMatch(/^trv_capture_/);

      const replay = await prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'gtm-capture-owner-0001'
      });
      expect(replay.objective).toBe('capture_inbound');
      if (replay.objective !== 'capture_inbound') throw new Error('Expected capture replay');
      expect(replay.result.duplicate).toBe(true);
      expect(replay.artifacts.captureSourceId).toBe(prepared.artifacts.captureSourceId);
      expect(replay.result.secret).toBe(prepared.result.secret);

      const differentCapturePlan = await compileGtmIntent(db, WORKSPACE, {
        objective: 'capture_inbound',
        capture: { name: 'Partner leads', kind: 'partner' }
      });
      await expect(
        prepareGtmPlan(db, {
          workspaceId: WORKSPACE,
          actorType: 'user',
          actorUserId: USER,
          actorRole: 'owner',
          plan: differentCapturePlan,
          planHash: differentCapturePlan.planHash,
          idempotencyKey: 'gtm-capture-owner-0001'
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/idempotency key/i)
      });

      const count = await db
        .prepare(
          'SELECT COUNT(*)::int AS total FROM capture_sources WHERE workspace_id=? AND preparation_key=?'
        )
        .get<{ total: number }>(WORKSPACE, 'gtm-capture-owner-0001');
      expect(count?.total).toBe(1);
    } finally {
      if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
      else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
    }
  });

  it('prepares explicit watch domains into active accounts that are due for the paced sweep', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'watch_accounts',
      audience: {
        description: 'Priority infrastructure accounts',
        domains: ['https://Watch-One.com/pricing', 'watch-two.com']
      },
      timing: { recurring: true }
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.intent.audience?.domains).toEqual(['watch-one.com', 'watch-two.com']);
    expect(plan.defaults).toMatchObject({
      prepareSupported: true,
      recurring: true,
      inactiveDomains: []
    });

    const prepared = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      actorRole: 'owner',
      plan,
      planHash: plan.planHash,
      idempotencyKey: 'gtm-watch-prepare-0001'
    });
    expect(prepared.objective).toBe('watch_accounts');
    if (prepared.objective !== 'watch_accounts') throw new Error('Expected watch preparation');
    expect(prepared.result.accounts.map((account) => account.domain)).toEqual([
      'watch-one.com',
      'watch-two.com'
    ]);
    expect(prepared.result.accounts.every((account) => account.status === 'active')).toBe(true);
    expect(prepared.result.accounts.every((account) => account.nextSweepAt !== null)).toBe(true);

    const replay = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      actorRole: 'owner',
      plan,
      planHash: plan.planHash,
      idempotencyKey: 'gtm-watch-prepare-0001'
    });
    expect(replay.objective).toBe('watch_accounts');
    if (replay.objective !== 'watch_accounts') throw new Error('Expected watch replay');
    expect(replay.artifacts).toEqual(prepared.artifacts);

    const differentWatchPlan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'watch_accounts',
      audience: { domains: ['different-watch.com'] }
    });
    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan: differentWatchPlan,
        planHash: differentWatchPlan.planHash,
        idempotencyKey: 'gtm-watch-prepare-0001'
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/idempotency key/i)
    });
    const unexpected = await db
      .prepare("SELECT id FROM accounts WHERE workspace_id=? AND domain='different-watch.com'")
      .get<{ id: string }>(WORKSPACE);
    expect(unexpected).toBeUndefined();

    const count = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM accounts WHERE workspace_id=? AND domain IN ('watch-one.com','watch-two.com')"
      )
      .get<{ total: number }>(WORKSPACE);
    expect(count?.total).toBe(2);
  });

  it('does not silently reactivate an excluded account when preparing a watch', async () => {
    await db
      .prepare(
        `INSERT INTO accounts
         (id,workspace_id,name,domain,source,status,created_at,updated_at)
         VALUES ('acct_watch_archived',?,'Archived Co','archived-watch.com','manual','archived',?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());

    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'watch_accounts',
      audience: { domains: ['archived-watch.com'] }
    });

    expect(plan.defaults.prepareSupported).toBe(false);
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'watch_inactive_accounts',
          actionHref: '/research'
        })
      ])
    );
    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'gtm-watch-archived-0001'
      })
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .prepare("SELECT status FROM accounts WHERE workspace_id=? AND domain='archived-watch.com'")
      .get<{ status: string }>(WORKSPACE);
    expect(row?.status).toBe('archived');
  });

  it('compiles an existing People list into an inspectable LinkedIn plan and prepares only a draft campaign', async () => {
    const list = await peopleList();
    const intent = {
      objective: 'prepare_outreach' as const,
      people: { existingListId: list.id },
      channels: ['linkedin'] as const,
      autonomy: 'approval_required' as const
    };

    const firstPlan = await compileGtmIntent(db, WORKSPACE, intent);
    const secondPlan = await compileGtmIntent(db, WORKSPACE, intent);
    expect(secondPlan.planHash).toBe(firstPlan.planHash);
    expect(firstPlan.blockers).toEqual([]);
    expect(firstPlan.defaults).toMatchObject({
      channel: 'linkedin',
      senderKey: list.seatKey,
      leadListId: list.id,
      prepareSupported: true
    });
    expect(firstPlan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });

    const prepared = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      actorRole: 'owner',
      plan: firstPlan,
      planHash: firstPlan.planHash,
      idempotencyKey: 'gtm-plan-prepare-0001'
    });
    expect(prepared).toMatchObject({
      status: 'prepared',
      objective: 'prepare_outreach',
      result: { campaign: { status: 'draft', enrolled: 2 } }
    });
    if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'linkedin')
      throw new Error('Expected outreach preparation');
    const campaign = await db
      .prepare('SELECT status,started_at FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
      .get<{ status: string; started_at: string | null }>(WORKSPACE, prepared.artifacts.campaignId);
    expect(campaign).toEqual({ status: 'draft', started_at: null });
    const externalActions = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(externalActions?.total).toBe(0);

    const replay = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      actorRole: 'owner',
      plan: firstPlan,
      planHash: firstPlan.planHash,
      idempotencyKey: 'gtm-plan-prepare-0001'
    });
    expect(replay.objective).toBe('prepare_outreach');
    if (replay.objective !== 'prepare_outreach' || replay.channel !== 'linkedin')
      throw new Error('Expected outreach replay');
    expect(replay.artifacts).toEqual(prepared.artifacts);
    expect(replay.result.duplicate).toBe(true);
  });

  it('rejects a stale plan when workspace-sensitive sender state changes', async () => {
    const list = await peopleList();
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'prepare_outreach',
      people: { existingListId: list.id },
      channels: ['linkedin']
    });
    expect(plan.blockers).toEqual([]);

    await db
      .prepare('DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
      .run(WORKSPACE, list.seatKey);

    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole: 'owner',
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'gtm-plan-prepare-0002'
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/stale/i) });

    const preparations = await db
      .prepare('SELECT COUNT(*)::int AS total FROM outreach_preparations WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(preparations?.total).toBe(0);
  });

  it('shows precise blockers instead of pretending uploaded input references are already materialized', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'Europe/Zurich' }, NOW);
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'prepare_outreach',
      people: { uploadedInputRef: 'upload://people.csv' },
      channels: ['linkedin']
    });

    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'uploaded_input_not_materialized',
          actionHref: '/outreach/new'
        })
      ])
    );
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('blocks email outreach until the workspace has a postal address and a privacy policy URL', async () => {
    const list = await peopleList();
    const intent = {
      objective: 'prepare_outreach',
      people: { existingListId: list.id },
      channels: ['email']
    };
    const codes = async (raw: unknown) =>
      (await compileGtmIntent(db, WORKSPACE, raw)).blockers.map((blocker) => blocker.code);

    // Exactly the two named causes: no redundant generic footer blocker beside them.
    const compliance = (all: string[]) =>
      all.filter((code) => code.startsWith('sender_') || code.startsWith('email_compliance_'));
    expect(compliance(await codes(intent))).toEqual([
      'sender_postal_address_missing',
      'sender_privacy_url_missing'
    ]);
    expect(await codes({ ...intent, channels: ['linkedin'] })).not.toContain(
      'sender_postal_address_missing'
    );

    await saveSenderIdentity(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        input: {
          legalName: 'Intent Test GmbH',
          postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
          privacyPolicyUrl: 'https://intent.example/privacy'
        }
      },
      NOW
    );
    const after = await codes(intent);
    expect(after).not.toContain('sender_postal_address_missing');
    expect(after).not.toContain('sender_privacy_url_missing');
    // The footer is built from the same identity, so it is available too.
    expect(after).not.toContain('email_compliance_footer_unavailable');
  });

  it('counts the people in an email plan who have no recorded lawful basis, without naming them', async () => {
    await saveSenderIdentity(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        input: {
          legalName: 'Intent Test GmbH',
          postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
          privacyPolicyUrl: 'https://intent.example/privacy'
        }
      },
      NOW
    );
    const seat = await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Founder', timezone: 'Europe/Zurich' },
      NOW
    );
    const list = await createLeadList(
      db,
      {
        workspaceId: WORKSPACE,
        seatKey: seat.seatKey,
        name: 'DACH founders',
        sourceKind: 'csv',
        sourceRef: 'intent-lawful-basis'
      },
      NOW
    );
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        seatKey: seat.seatKey,
        listId: list.id,
        csv: [
          'First Name,Last Name,Company,Email,LinkedIn URL,Country',
          'Maya,Huber,Northwind,maya@northwind-gmbh.de,https://www.linkedin.com/in/maya-lawful-basis/,Germany',
          'Jonas,Keller,Northstar,jonas-lawful-basis@example.com,https://www.linkedin.com/in/jonas-lawful-basis/,Germany'
        ].join('\n')
      },
      NOW
    );
    const intent = {
      objective: 'prepare_outreach',
      people: { existingListId: list.id },
      channels: ['email']
    };

    const plan = await compileGtmIntent(db, WORKSPACE, intent);
    const codes = plan.blockers.map((candidate) => candidate.code);
    // The identity is complete, so no sender blocker competes with the list one.
    expect(codes).toContain('recipient_lawful_basis_missing');
    expect(codes.filter((code) => code.startsWith('sender_'))).toEqual([]);
    const blocker = plan.blockers.find(
      (candidate) => candidate.code === 'recipient_lawful_basis_missing'
    );
    expect(blocker).toMatchObject({ actionHref: '/outreach/new' });
    expect(blocker?.message).toContain(
      '1 of 2 people with an email in this list have no recorded lawful basis'
    );
    expect(blocker?.message).toContain('Not legal advice; verify with counsel.');
    expect(blocker?.message).not.toContain('northwind');
    expect(blocker?.message).not.toContain('Maya');

    const linkedin = await compileGtmIntent(db, WORKSPACE, { ...intent, channels: ['linkedin'] });
    expect(linkedin.blockers.map((candidate) => candidate.code)).not.toContain(
      'recipient_lawful_basis_missing'
    );
  });
});
