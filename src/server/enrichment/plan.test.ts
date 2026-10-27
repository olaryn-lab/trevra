import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod/v3';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, GtmPlanError, prepareGtmPlan } from '../gtm/intent.js';
import { putWorkspaceSecret } from '../secrets/store.js';
import { setEnrichmentCap, setEnrichmentKeyStatus } from './settings.js';

const WORKSPACE = 'ws_enrichment_plan';
const USER = 'usr_enrichment_plan';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

async function readyToEnrich(cap: number): Promise<void> {
  await putWorkspaceSecret(db, {
    workspaceId: WORKSPACE,
    kind: 'hunter_api_key',
    plaintext: 'hunter-plan-key-0001',
    actorUserId: USER
  });
  await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
  await setEnrichmentCap(db, WORKSPACE, cap, USER, NOW);
}

const intent = (domains: string[], enrichment?: Record<string, unknown>) => ({
  objective: 'enrich_contacts',
  audience: { domains },
  ...(enrichment ? { enrichment } : {})
});

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment plan', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-plan@trevra.test', 'Founder', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('enrich_contacts plan', () => {
  it('prices the worst case and shows it against the monthly cap', async () => {
    await readyToEnrich(20);
    const plan = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['https://www.Acme.com/about', 'northstar.ai'])
    );
    expect(plan.intent.audience?.domains).toEqual(['acme.com', 'northstar.ai']);
    expect(plan.blockers).toEqual([]);
    expect(plan.cost).toEqual({
      provider: 'hunter',
      unit: 'credits',
      domains: 2,
      emailsPerDomain: 3,
      searchCredits: 6,
      verificationCredits: 3,
      estimatedCredits: 9,
      monthlyCap: 20,
      usedThisMonth: 0,
      remainingAfter: 11,
      pricingUrl: 'https://hunter.io/pricing'
    });
    expect(plan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });
    expect(plan.defaults).toMatchObject({ prepareSupported: true, includeUnverified: false });
    // Where a run's outcome is visible: the Contact enrichment panel.
    expect(plan.next).toEqual({ kind: 'review_enrichment_runs', href: '/setup/workspace' });
  });

  it('blocks a plan the remaining cap cannot cover', async () => {
    await readyToEnrich(5);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com', 'northstar.ai']));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['enrichment_cap_exceeded']);
    expect(plan.cost?.remainingAfter).toBe(-4);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('blocks without a key or a cap', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      'enrichment_key_missing',
      'enrichment_cap_missing'
    ]);
  });

  it('rejects entries that are not public company domains', async () => {
    await readyToEnrich(100);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['localhost', 'acme.com']));
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('enrichment_invalid_domains');
  });

  it('lets only the owner prepare paid enrichment', async () => {
    await readyToEnrich(100);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']), {
      actorRole: 'member'
    });
    expect(plan.blockers[0]?.code).toBe('enrichment_owner_required');
    const error = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      actorRole: 'member',
      plan,
      planHash: plan.planHash,
      idempotencyKey: 'enrich-member-0001'
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GtmPlanError);
    expect((error as GtmPlanError).status).toBe(403);
  });

  it('bounds emails per domain and leaves other objectives without a cost', async () => {
    for (const emailsPerDomain of [0, 11, 2.5]) {
      const error = await compileGtmIntent(
        db,
        WORKSPACE,
        intent(['acme.com'], { emailsPerDomain })
      ).catch((caught: unknown) => caught);
      expect(error, `emailsPerDomain=${emailsPerDomain}`).toBeInstanceOf(ZodError);
      expect(
        (error as ZodError).issues.some((issue) => issue.path.includes('emailsPerDomain')),
        `emailsPerDomain=${emailsPerDomain}`
      ).toBe(true);
    }
    const capture = await compileGtmIntent(db, WORKSPACE, { objective: 'capture_inbound' });
    expect('cost' in capture).toBe(false);
  });

  it('counts this month charges and open runs unspent estimates against the cap', async () => {
    await readyToEnrich(20);
    const thisMonth = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO enrichment_runs
           (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits,status)
         VALUES (?,?,'hunter',?,?,?,1,?,'queued')`
      )
      .run('enr_plan_open', WORKSPACE, 'enrich-open-0001', 'c'.repeat(64), ['acme.com'], 4.5);
    const ledger = db.prepare(
      `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
       VALUES (?,?,?,'hunter',?,?,?)`
    );
    // A finished run's charge this month, and 1 credit already spent by the open run.
    await ledger.run('enl_plan_done', WORKSPACE, 'enr_plan_done', 'domain_search', 2.5, thisMonth);
    await ledger.run('enl_plan_open', WORKSPACE, 'enr_plan_open', 'domain_search', 1, thisMonth);

    // used = charged (2.5 + 1) + open run's unspent estimate (4.5 - 1) = 7
    const one = await compileGtmIntent(db, WORKSPACE, intent(['northstar.ai']));
    expect(one.blockers).toEqual([]);
    expect(one.cost).toMatchObject({
      estimatedCredits: 4.5,
      usedThisMonth: 7,
      remainingAfter: 8.5
    });

    const three = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['northstar.ai', 'orbit.io', 'zenith.co'])
    );
    expect(three.cost).toMatchObject({
      estimatedCredits: 13.5,
      usedThisMonth: 7,
      remainingAfter: -0.5
    });
    expect(three.blockers).toEqual([
      expect.objectContaining({
        code: 'enrichment_cap_exceeded',
        message: "This plan could use up to 13.5 credits, but 13 remain under this month's cap."
      })
    ]);
  });

  it('requires at least one domain', async () => {
    await readyToEnrich(100);
    const plan = await compileGtmIntent(db, WORKSPACE, intent([]));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['enrichment_domains_required']);
    expect(plan.cost?.domains).toBe(0);
  });

  it('blocks more domains than one run may search', async () => {
    await readyToEnrich(1000);
    const domains = Array.from({ length: 101 }, (_, index) => `company${index}.com`);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(domains));
    expect(plan.cost?.domains).toBe(101);
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['enrichment_too_many_domains']);
  });

  it('blocks a key Hunter rejected', async () => {
    await readyToEnrich(100);
    await setEnrichmentKeyStatus(db, WORKSPACE, 'invalid', NOW);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['enrichment_key_invalid']);
  });

  it('canonicalises each domain so one company is searched and charged once', async () => {
    await readyToEnrich(100);
    const duplicate = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['acme.com', 'https://www.acme.com/x'])
    );
    expect(duplicate.intent.audience?.domains).toEqual(['acme.com']);
    expect(duplicate.cost?.domains).toBe(1);

    const variants = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['https://acme.com?utm=x', 'acme.com.', 'acme.com:443', 'ACME.com'])
    );
    expect(variants.intent.audience?.domains).toEqual(['acme.com']);
    expect(variants.blockers).toEqual([]);
    expect(variants.cost?.domains).toBe(1);
    expect(variants.planHash).toBe(duplicate.planHash);

    const rejected = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['acme.com:443', 'http://localhost:3000'])
    );
    expect(rejected.intent.audience?.domains).toEqual(['acme.com', 'localhost:3000']);
    expect(rejected.blockers.map((blocker) => blocker.code)).toEqual([
      'enrichment_invalid_domains'
    ]);
  });

  it('hashes the choices that change what is charged and saved', async () => {
    await readyToEnrich(100);
    const base = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']));
    const unverified = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['acme.com'], { includeUnverified: true })
    );
    const more = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['acme.com'], { emailsPerDomain: 4 })
    );
    expect(new Set([base.planHash, unverified.planHash, more.planHash]).size).toBe(3);
  });
});
