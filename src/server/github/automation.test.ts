import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { runAutomationCycle } from '../automation-service.js';
import { listWatchedRepositories, watchRepository } from './repos.js';

let db: Db;
const WORKSPACE_ID = 'ws_github_automation_test';

beforeEach(async () => {
  delete process.env.NANGO_API_KEY;
  delete process.env.NANGO_GITHUB_INTEGRATION;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE_ID, 'GitHub automation', new Date().toISOString());
  await watchRepository(
    db,
    { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: 'lemoncrow-lab/lemoncrow' },
    new Date(Date.now() - 60_000)
  );
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db.close();
});

describe('GitHub polling in the automation cycle', () => {
  it('records an honest not-connected state for a due repository without calling GitHub', async () => {
    await runAutomationCycle(db, WORKSPACE_ID);
    const [repo] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(repo.status).toBe('not_connected');
    expect(Date.parse(repo.nextPollAt)).toBeGreaterThan(Date.now());
  });

  it('builds the Nango transport for a connected workspace and reports a missing Nango key as an error', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES (?,?,'github','trevra-github','gh-live','GitHub','connected',0,?,?)`
      )
      .run(id('conn'), WORKSPACE_ID, now, now);
    await runAutomationCycle(db, WORKSPACE_ID);
    const [repo] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(repo.status).toBe('error');
    expect(repo.lastError).toBe('NANGO_API_KEY is not configured');
  });
});
