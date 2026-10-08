import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_phase_f_schema';
const OTHER = 'ws_phase_f_schema_other';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;

async function seedWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, NOW);
}

async function seedWatch(workspaceId: string, watchId: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO brand_watches (id,workspace_id,name,keywords,platforms,cadence) VALUES (?,?,?,?,?,?)'
    )
    .run(watchId, workspaceId, `Watch ${watchId}`, ['trevra'], ['hackernews'], 'daily');
}

async function seedSource(workspaceId: string, sourceId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO capture_sources (id,workspace_id,name,key,kind,status,created_at,updated_at)
       VALUES (?,?,?,?,'ai_citations','active',?,?)`
    )
    .run(sourceId, workspaceId, 'AI answers', sourceId, NOW, NOW);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await seedWorkspace(WORKSPACE);
  await seedWorkspace(OTHER);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WORKSPACE, OTHER);
  await db?.close();
});

describe('phase F schema', () => {
  it('defaults enrichment to a zero cap and an unchecked key', async () => {
    await db.prepare('INSERT INTO enrichment_settings (workspace_id) VALUES (?)').run(WORKSPACE);
    const row = await db
      .prepare(
        'SELECT provider, monthly_credit_cap, key_status FROM enrichment_settings WHERE workspace_id=?'
      )
      .get<{ provider: string; monthly_credit_cap: number; key_status: string }>(WORKSPACE);
    // db.ts registers a NUMERIC (OID 1700) parser, so the cap arrives as a number.
    expect(row).toEqual({ provider: 'hunter', monthly_credit_cap: 0, key_status: 'unchecked' });
  });

  it('rejects a negative cap and an unknown provider', async () => {
    await expect(
      db
        .prepare('INSERT INTO enrichment_settings (workspace_id, monthly_credit_cap) VALUES (?,?)')
        .run(WORKSPACE, -1)
    ).rejects.toThrow();
    await expect(
      db
        .prepare('INSERT INTO enrichment_settings (workspace_id, provider) VALUES (?,?)')
        .run(WORKSPACE, 'apollo')
    ).rejects.toThrow();
  });

  it('bounds a run to 1..100 domains and 1..10 emails per domain', async () => {
    const insert = (domains: string[], perDomain: number) =>
      db
        .prepare(
          `INSERT INTO enrichment_runs
             (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,include_unverified,estimated_credits)
           VALUES (?,?,'hunter',?,?,?,?,false,?)`
        )
        .run(
          `enr_${perDomain}_${domains.length}`,
          WORKSPACE,
          `key-${perDomain}-${domains.length}`,
          'a'.repeat(64),
          domains,
          perDomain,
          1
        );
    await expect(insert([], 3)).rejects.toThrow();
    await expect(insert(['acme.com'], 11)).rejects.toThrow();
    await expect(insert(['acme.com'], 3)).resolves.toBeDefined();
  });

  it('deleting a watch removes its citation link and samples', async () => {
    await seedWatch(WORKSPACE, 'bw_schema_1');
    await seedSource(WORKSPACE, 'cap_schema_1');
    await db
      .prepare(
        'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
      )
      .run('bw_schema_1', WORKSPACE, 'cap_schema_1', ['trevra.com']);
    await db
      .prepare(
        `INSERT INTO ai_citation_samples
           (id,workspace_id,watch_id,capture_source_id,idempotency_key,payload_hash,sample_id,engine,prompt_ref,answered_at,brand_cited,change)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'acs_1',
        WORKSPACE,
        'bw_schema_1',
        'cap_schema_1',
        'sample-key-1',
        'b'.repeat(64),
        's1',
        'chatgpt',
        'id:pricing',
        NOW,
        true,
        'gained'
      );
    await db.prepare('DELETE FROM brand_watches WHERE id=?').run('bw_schema_1');
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM brand_watch_citation_sources WHERE workspace_id=?) AS links,
           (SELECT COUNT(*) FROM ai_citation_samples WHERE workspace_id=?) AS samples`
      )
      .get<{ links: string; samples: string }>(WORKSPACE, WORKSPACE);
    expect(Number(counts?.links)).toBe(0);
    expect(Number(counts?.samples)).toBe(0);
  });

  it('refuses a citation link to another workspace capture source', async () => {
    await seedWatch(WORKSPACE, 'bw_schema_2');
    await seedSource(OTHER, 'cap_schema_other');
    await expect(
      db
        .prepare(
          'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
        )
        .run('bw_schema_2', WORKSPACE, 'cap_schema_other', ['trevra.com'])
    ).rejects.toThrow();
  });

  async function seedLinked(watchId: string, sourceId: string): Promise<void> {
    await seedWatch(WORKSPACE, watchId);
    await seedSource(WORKSPACE, sourceId);
    await db
      .prepare(
        'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
      )
      .run(watchId, WORKSPACE, sourceId, ['trevra.com']);
  }

  const insertSample = (watchId: string, sourceId: string, mentionId: string | null = null) =>
    db
      .prepare(
        `INSERT INTO ai_citation_samples
           (id,workspace_id,watch_id,capture_source_id,idempotency_key,payload_hash,sample_id,engine,prompt_ref,answered_at,brand_cited,change,mention_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        `acs_${watchId}`,
        WORKSPACE,
        watchId,
        sourceId,
        `k-${watchId}`,
        'b'.repeat(64),
        `s-${watchId}`,
        'chatgpt',
        'id:pricing',
        NOW,
        true,
        'gained',
        mentionId
      );

  it('refuses a citation link whose watch belongs to another workspace', async () => {
    await seedWatch(OTHER, 'bw_schema_foreign');
    await seedSource(WORKSPACE, 'cap_schema_3');
    await expect(
      db
        .prepare(
          'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
        )
        .run('bw_schema_foreign', WORKSPACE, 'cap_schema_3', ['trevra.com'])
    ).rejects.toThrow();
  });

  it('refuses a sample whose source is not its watch linked source', async () => {
    await seedLinked('bw_schema_4', 'cap_schema_4');
    await seedSource(WORKSPACE, 'cap_schema_4b');
    await expect(insertSample('bw_schema_4', 'cap_schema_4b')).rejects.toThrow();
  });

  it('deleting a mention nulls the sample mention_id and keeps the workspace', async () => {
    await seedLinked('bw_schema_5', 'cap_schema_5');
    await db
      .prepare(
        `INSERT INTO brand_watch_mentions
           (id,workspace_id,watch_id,platform,external_id,url,sentiment_label,sentiment_score,sentiment_version,content_hash,first_seen_at,last_seen_at)
         VALUES (?,?,?,?,?,?,'neutral',0,1,?,?,?)`
      )
      .run(
        'bwm_schema_5',
        WORKSPACE,
        'bw_schema_5',
        'ai_answer',
        'x1',
        'https://trevra.com',
        'h',
        NOW,
        NOW
      );
    await insertSample('bw_schema_5', 'cap_schema_5', 'bwm_schema_5');
    await db.prepare('DELETE FROM brand_watch_mentions WHERE id=?').run('bwm_schema_5');
    const row = await db
      .prepare('SELECT workspace_id, mention_id FROM ai_citation_samples WHERE id=?')
      .get<{ workspace_id: string; mention_id: string | null }>('acs_bw_schema_5');
    expect(row).toEqual({ workspace_id: WORKSPACE, mention_id: null });
  });

  it('round-trips half credits in the ledger', async () => {
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits)
         VALUES (?,?,?,'hunter','email_verifier',?)`
      )
      .run('eul_1', WORKSPACE, 'enr_x', 0.5);
    const row = await db
      .prepare('SELECT credits FROM enrichment_usage_ledger WHERE id=?')
      .get<{ credits: number }>('eul_1');
    expect(Number(row?.credits)).toBe(0.5);
  });

  it('rejects a run with zero estimated credits', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO enrichment_runs
             (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits)
           VALUES (?,?,'hunter',?,?,?,?,?)`
        )
        .run('enr_zero', WORKSPACE, 'k-zero', 'a'.repeat(64), ['acme.com'], 3, 0)
    ).rejects.toThrow();
  });
});
