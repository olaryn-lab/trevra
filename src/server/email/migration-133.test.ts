import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_email_migration_133';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Migration 133', NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

function checkViolation(work: Promise<unknown>) {
  return expect(work).rejects.toMatchObject({ code: '23514' });
}

describe('migration 133 email channel', () => {
  it('adds the email channel columns and tables', async () => {
    const columns = await db
      .prepare(
        `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
         WHERE table_schema='public' AND (
           (table_name='connections' AND column_name='mailbox_address') OR
           (table_name='email_deliverability_checks' AND column_name='outreach_requested_at') OR
           (table_name='email_inbound_mailboxes' AND column_name='sync_status') OR
           (table_name='email_outreach_preparations' AND column_name='result_json')
         )
         ORDER BY 1`
      )
      .all<{ name: string }>();
    expect(columns.map((row) => row.name)).toEqual([
      'connections.mailbox_address',
      'email_deliverability_checks.outreach_requested_at',
      'email_inbound_mailboxes.sync_status',
      'email_outreach_preparations.result_json'
    ]);

    const indexes = await db
      .prepare(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY(?::text[])
         ORDER BY indexname`
      )
      .all<{ indexname: string }>([
        'idx_email_deliverability_checks_due',
        'idx_email_inbound_mailboxes_connection',
        'idx_playbook_runs_email_outreach_idempotency',
        'idx_playbook_runs_email_outreach_open_person'
      ]);
    expect(indexes.map((row) => row.indexname)).toEqual([
      'idx_email_deliverability_checks_due',
      'idx_email_inbound_mailboxes_connection',
      'idx_playbook_runs_email_outreach_idempotency',
      'idx_playbook_runs_email_outreach_open_person'
    ]);
  });

  it('refuses non-normalized domains, addresses and sync states', async () => {
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_deliverability_checks
           (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
           VALUES (?,'Acme.test','google','pass','{}','{}','{}',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
    await db
      .prepare(
        `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_migration_133',?,'gmail','trevra-gmail','gmail-migration-133',NULL,'connected',0,?,?)`
      )
      .run(WORKSPACE, NOW, NOW);
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_inbound_mailboxes
           (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
           VALUES (?,'conn_migration_133','Owner@Acme.test','syncing',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_inbound_mailboxes
           (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
           VALUES (?,'conn_migration_133','owner@acme.test','polling',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
  });
});
