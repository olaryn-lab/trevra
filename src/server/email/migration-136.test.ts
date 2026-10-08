import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_email_migration_136';
const NOW = '2026-10-07T09:00:00.000Z';
const CHECK = JSON.stringify({ status: 'pass', detail: 'ok', record: null });
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Migration 136', NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

function checkViolation(work: Promise<unknown>) {
  return expect(work).rejects.toMatchObject({ code: '23514' });
}

function insertCheck(provider: string) {
  return db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
       VALUES (?,'acme.test',?,'pass',?::jsonb,?::jsonb,?::jsonb,?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, provider, CHECK, CHECK, CHECK, NOW, NOW);
}

function insertSelector(domain: string, selector: string) {
  return db
    .prepare(
      `INSERT INTO email_dkim_selectors (workspace_id,domain,selector,updated_at)
       VALUES (?,?,?,?::timestamptz)`
    )
    .run(WORKSPACE, domain, selector, NOW);
}

describe('migration 136 zoho mail', () => {
  it('accepts zoho deliverability checks and still rejects unknown providers', async () => {
    await insertCheck('zoho');
    await checkViolation(insertCheck('yahoo'));
    const constraint = await db
      .prepare(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid='email_deliverability_checks'::regclass
           AND conname='email_deliverability_checks_provider_check'`
      )
      .get<{ def: string }>();
    expect(constraint?.def).toContain("'zoho'");
  });

  it('stores one lowercase DKIM selector per workspace and domain', async () => {
    await insertSelector('acme.test', 'zmail');
    await expect(insertSelector('acme.test', 'other')).rejects.toMatchObject({ code: '23505' });
    await checkViolation(insertSelector('Acme.test', 'zmail2'));
    await checkViolation(insertSelector('beta.test', 'ZMail'));
    await checkViolation(insertSelector('gamma.test', 'zmail._domainkey'));
    await checkViolation(insertSelector('delta.test', ''));
  });

  it('removes selectors with the workspace', async () => {
    await insertSelector('acme.test', 'zmail');
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    const left = await db
      .prepare('SELECT COUNT(*)::int AS total FROM email_dkim_selectors WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(left?.total).toBe(0);
  });
});
