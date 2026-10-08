import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { putWorkspaceSecret } from '../secrets/store.js';
import {
  enrichmentUsage,
  getEnrichmentSettings,
  monthStartUtc,
  setEnrichmentCap,
  setEnrichmentKeyStatus
} from './settings.js';

const WORKSPACE = 'ws_enrichment_settings';
const USER = 'usr_enrichment_settings';
const NOW = new Date('2026-10-15T12:00:00.000Z');
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment settings', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-settings@trevra.test', 'Founder', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

async function ledger(runId: string, credits: number, at: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
       VALUES (?,?,?,'hunter','domain_search',?,?)`
    )
    .run(`enl_${runId}_${at}`, WORKSPACE, runId, credits, at);
}

async function run(runId: string, status: string, estimate: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_runs
         (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits,status)
       VALUES (?,?,'hunter',?,?,?,3,?,?)`
    )
    .run(runId, WORKSPACE, `key-${runId}`, 'c'.repeat(64), ['acme.com'], estimate, status);
}

describe('enrichment settings', () => {
  it('starts off: no key, zero cap', async () => {
    expect(await getEnrichmentSettings(db, WORKSPACE)).toEqual({
      provider: 'hunter',
      monthlyCreditCap: 0,
      keyStatus: 'missing',
      keyCheckedAt: null,
      key: null
    });
  });

  it('reports a stored key as unchecked until a check marks it valid, and never shows a fragment', async () => {
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-settings-key-0001',
      actorUserId: USER
    });
    expect((await getEnrichmentSettings(db, WORKSPACE)).keyStatus).toBe('unchecked');
    await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
    const settings = await getEnrichmentSettings(db, WORKSPACE);
    expect(settings.keyStatus).toBe('valid');
    expect(settings.keyCheckedAt).toBe(NOW.toISOString());
    expect(settings.key?.kind).toBe('hunter_api_key');
    // 'opaque' kinds store an empty last4 (secrets/store.ts deriveLast4).
    expect(settings.key?.last4).toBe('');
  });

  it('accepts caps in half-credit steps from 0 to 100000 only', async () => {
    await expect(setEnrichmentCap(db, WORKSPACE, 0.3, USER, NOW)).rejects.toThrow(/steps of 0.5/);
    await expect(setEnrichmentCap(db, WORKSPACE, -1, USER, NOW)).rejects.toThrow();
    await expect(setEnrichmentCap(db, WORKSPACE, 100_001, USER, NOW)).rejects.toThrow();
    expect((await setEnrichmentCap(db, WORKSPACE, 25.5, USER, NOW)).monthlyCreditCap).toBe(25.5);
    const events = await db
      .prepare(
        "SELECT actor_type, actor_id, payload_json FROM domain_events WHERE workspace_id=? AND event_type='enrichment.cap_set'"
      )
      .all<{ actor_type: string; actor_id: string; payload_json: unknown }>(WORKSPACE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'user', actor_id: USER });
    const payload =
      typeof events[0]!.payload_json === 'string'
        ? JSON.parse(events[0]!.payload_json)
        : events[0]!.payload_json;
    expect(payload).toEqual({ monthlyCreditCap: 25.5 });
  });

  it('counts this UTC month of charges plus the unspent estimate of open runs', async () => {
    await run('enr_open', 'queued', 9);
    await run('enr_done', 'completed', 9);
    await ledger('enr_done', 3, '2026-10-02T08:00:00.000Z');
    await ledger('enr_old', 5, '2026-09-30T23:59:00.000Z');
    await ledger('enr_open', 2, '2026-10-14T08:00:00.000Z');
    expect(monthStartUtc(NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(await enrichmentUsage(db, WORKSPACE, NOW)).toEqual({
      monthStart: '2026-10-01T00:00:00.000Z',
      chargedCredits: 5,
      reservedCredits: 7,
      usedCredits: 12
    });
  });
});
