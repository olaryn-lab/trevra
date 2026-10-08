import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    await expect(
      compileGtmIntent(db, WORKSPACE, intent(['acme.com'], { emailsPerDomain: 11 }))
    ).rejects.toThrow();
    const capture = await compileGtmIntent(db, WORKSPACE, { objective: 'capture_inbound' });
    expect('cost' in capture).toBe(false);
  });
});
