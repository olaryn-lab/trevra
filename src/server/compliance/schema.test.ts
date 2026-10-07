import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from '../linkedin/seats.js';

const WORKSPACE = 'ws_compliance_schema_test';
const NOW = '2026-08-21T09:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Compliance schema', NOW);
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES ('con_schema_1',?,'Maya','maya@northwind.example','maya@northwind.example',?,?)`
    )
    .run(WORKSPACE, NOW, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('migration 134: consent and LinkedIn safety', () => {
  it('stores one sender identity per workspace and refuses a non-https privacy URL', async () => {
    await db
      .prepare(
        `INSERT INTO workspace_sender_identities (workspace_id,legal_name,postal_address,privacy_policy_url)
         VALUES (?,?,?,?)`
      )
      .run(
        WORKSPACE,
        'Northwind GmbH',
        'Bahnhofstrasse 1, 8001 Zurich, Switzerland',
        'https://northwind.example/privacy'
      );
    await expect(
      db
        .prepare(
          `UPDATE workspace_sender_identities SET privacy_policy_url='http://northwind.example/privacy' WHERE workspace_id=?`
        )
        .run(WORKSPACE)
    ).rejects.toThrow();
  });

  it('accepts only ISO alpha-2 country codes on people and accounts', async () => {
    await db.prepare(`UPDATE contacts SET country_code='DE' WHERE id='con_schema_1'`).run();
    await expect(
      db.prepare(`UPDATE contacts SET country_code='Germany' WHERE id='con_schema_1'`).run()
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO accounts (id,workspace_id,name,domain,country_code) VALUES ('acc_schema_1',?,'Northwind','northwind.example','CH')`
      )
      .run(WORKSPACE);
    await expect(
      db.prepare(`UPDATE accounts SET country_code='ch' WHERE id='acc_schema_1'`).run()
    ).rejects.toThrow();
  });

  it('keeps one active lawful basis per person, channel, basis, source and reference', async () => {
    const insert = (rowId: string) =>
      db
        .prepare(
          `INSERT INTO contact_lawful_bases (id,workspace_id,person_id,channel,basis,source,source_ref,recorded_at)
           VALUES (?,?,'con_schema_1','email','consent','inbound_capture','sub_1',?)`
        )
        .run(rowId, WORKSPACE, NOW);
    await insert('clb_schema_1');
    await expect(insert('clb_schema_2')).rejects.toThrow();
    await db
      .prepare(`UPDATE contact_lawful_bases SET withdrawn_at=? WHERE id='clb_schema_1'`)
      .run(NOW);
    await insert('clb_schema_3');
    await expect(
      db
        .prepare(
          `INSERT INTO contact_lawful_bases (id,workspace_id,person_id,channel,basis,source,recorded_at)
           VALUES ('clb_schema_4',?,'con_schema_1','email','opt_in','operator',?)`
        )
        .run(WORKSPACE, NOW)
    ).rejects.toThrow();
  });

  it('links a seat to one LinkedIn member and defaults every seat to automated sending', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'UTC' }, new Date(NOW));
    const seat = await db
      .prepare(`SELECT send_mode FROM linkedin_seats WHERE workspace_id=? AND seat_key='owner'`)
      .get<{ send_mode: string }>(WORKSPACE);
    expect(seat?.send_mode).toBe('automated');
    await expect(
      db.prepare(`UPDATE linkedin_seats SET send_mode='robot' WHERE workspace_id=?`).run(WORKSPACE)
    ).rejects.toThrow();

    await db
      .prepare(
        `INSERT INTO linkedin_seat_identities (workspace_id,seat_key,identity_key,confirmed_at)
         VALUES (?,'owner','https://www.linkedin.com/in/shared-founder',?)`
      )
      .run(WORKSPACE, NOW);
    await db
      .prepare(`DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key='owner'`)
      .run(WORKSPACE);
    const left = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_seat_identities WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(left?.total).toBe(0);
  });
});
