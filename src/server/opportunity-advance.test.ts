import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from './db.js';
import {
  OpportunityAdvanceError,
  STAGE_RANK,
  advanceOpportunityStage,
  type AdvanceOpportunityInput
} from './opportunity-advance.js';

const WS = 'ws_opportunity_advance';
const OTHER = 'ws_opportunity_advance_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let personId = '';
let accountId = '';
let foreignPersonId = '';

async function seedPerson(workspaceId: string, email: string): Promise<string> {
  const personRow = id('con');
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(personRow, workspaceId, email, email, email, NOW.toISOString(), NOW.toISOString());
  return personRow;
}

async function opportunityRows() {
  return db
    .prepare(
      'SELECT id,stage,closed_at FROM opportunities WHERE workspace_id=? ORDER BY created_at,id'
    )
    .all<{ id: string; stage: string; closed_at: string | null }>(WS);
}

async function eventCount(eventType: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM domain_events
       WHERE workspace_id=? AND stream_type='opportunity' AND event_type=?`
    )
    .get<{ n: number }>(WS, eventType);
  return Number(row?.n ?? 0);
}

function input(overrides: Partial<AdvanceOpportunityInput> = {}): AdvanceOpportunityInput {
  return {
    workspaceId: WS,
    personId,
    accountId,
    minimumStage: 'qualified',
    title: 'Acme: product adoption',
    reason: 'milestone:activated',
    sourceType: 'product_milestone',
    sourceId: 'pm_one',
    ...overrides
  };
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  for (const workspaceId of [WS, OTHER])
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  personId = await seedPerson(WS, 'maya@acme-advance.test');
  foreignPersonId = await seedPerson(OTHER, 'maya@acme-advance.test');
  accountId = id('acc');
  await db
    .prepare(
      "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
    )
    .run(accountId, WS, 'Acme', 'acme-advance.test', NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  await db?.close();
});

describe('advanceOpportunityStage', () => {
  it('ranks stages new < qualified < meeting < proposal < won < lost', () => {
    expect(STAGE_RANK).toEqual({ new: 1, qualified: 2, meeting: 3, proposal: 4, won: 5, lost: 6 });
  });

  it('creates an Opportunity at the minimum stage once per source', async () => {
    const first = await advanceOpportunityStage(db, input(), NOW);
    expect(first).toMatchObject({
      previousStage: null,
      stage: 'qualified',
      created: true,
      changed: true
    });
    const replay = await advanceOpportunityStage(db, input(), NOW);
    expect(replay).toEqual({
      opportunityId: first.opportunityId,
      previousStage: 'qualified',
      stage: 'qualified',
      created: false,
      changed: false
    });
    expect(await opportunityRows()).toHaveLength(1);
    expect(await eventCount('opportunity.created_from_observation')).toBe(1);
  });

  it('raises an open Opportunity but never lowers one', async () => {
    const created = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'new', sourceId: 'pm_new' }),
      NOW
    );
    const raised = await advanceOpportunityStage(db, input({ sourceId: 'pm_raise' }), NOW);
    expect(raised).toMatchObject({
      opportunityId: created.opportunityId,
      previousStage: 'new',
      stage: 'qualified',
      created: false,
      changed: true
    });
    await db
      .prepare("UPDATE opportunities SET stage='proposal' WHERE id=?")
      .run(created.opportunityId);
    const held = await advanceOpportunityStage(db, input({ sourceId: 'pm_hold' }), NOW);
    expect(held).toMatchObject({
      opportunityId: created.opportunityId,
      previousStage: 'proposal',
      stage: 'proposal',
      changed: false
    });
    expect(await eventCount('opportunity.stage_advanced')).toBe(1);
  });

  it('closes as won with closed_at, and never reopens a closed row', async () => {
    const qualified = await advanceOpportunityStage(db, input(), NOW);
    const won = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'won', sourceId: 'pm_paid' }),
      NOW
    );
    expect(won).toMatchObject({
      opportunityId: qualified.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
    expect((await opportunityRows())[0].closed_at).not.toBeNull();

    const wonAgain = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'won', sourceId: 'pm_paid_again' }),
      NOW
    );
    expect(wonAgain).toMatchObject({
      opportunityId: qualified.opportunityId,
      stage: 'won',
      created: false,
      changed: false
    });

    const fresh = await advanceOpportunityStage(db, input({ sourceId: 'pm_expansion' }), NOW);
    expect(fresh).toMatchObject({ stage: 'qualified', created: true });
    expect(fresh.opportunityId).not.toBe(qualified.opportunityId);
    expect(await opportunityRows()).toHaveLength(2);
  });

  it('falls back to the Account when the Person has no open Opportunity', async () => {
    const colleague = await seedPerson(WS, 'sam@acme-advance.test');
    const viaAccount = await advanceOpportunityStage(
      db,
      input({ personId: null, sourceId: 'pm_account' }),
      NOW
    );
    const matched = await advanceOpportunityStage(
      db,
      input({ personId: colleague, minimumStage: 'won', sourceId: 'pm_colleague' }),
      NOW
    );
    expect(matched).toMatchObject({
      opportunityId: viaAccount.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
  });

  it('rejects a Person from another workspace and refuses to close as lost', async () => {
    await expect(
      advanceOpportunityStage(db, input({ personId: foreignPersonId, sourceId: 'pm_foreign' }), NOW)
    ).rejects.toBeInstanceOf(OpportunityAdvanceError);
    await expect(
      advanceOpportunityStage(
        db,
        input({ minimumStage: 'lost' as never, sourceId: 'pm_lost' }),
        NOW
      )
    ).rejects.toThrow('never close');
    expect(await opportunityRows()).toHaveLength(0);
  });

  it('serialises concurrent observations into one Opportunity', async () => {
    const results = await Promise.all([
      advanceOpportunityStage(db, input({ sourceId: 'pm_a' }), NOW),
      advanceOpportunityStage(db, input({ sourceId: 'pm_b' }), NOW)
    ]);
    expect(new Set(results.map((result) => result.opportunityId)).size).toBe(1);
    expect(await opportunityRows()).toHaveLength(1);
  });
});
