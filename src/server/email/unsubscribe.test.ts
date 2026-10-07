import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { findSuppression } from '../suppressions.js';
import { publicEmailOrigin } from './public-origin.js';
import {
  UNSUBSCRIBE_SUBJECT_PATTERN,
  applyUnsubscribeToken,
  findUnsubscribeDelivery,
  listUnsubscribeHeaders,
  outreachUnsubscribeHeaders,
  renderUnsubscribePage,
  unsubscribeConfigured,
  unsubscribeToken
} from './unsubscribe.js';

const WORKSPACE = 'ws_email_unsubscribe';
const OTHER = 'ws_email_unsubscribe_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const DELIVERY = 'del_0123456789abcdef';
const ENV = {
  NODE_ENV: 'test',
  TREVRA_SECRETS_KEY: 'unsubscribe-test-key-a',
  TREVRA_PUBLIC_API_URL: 'https://api.trevra.test'
} as NodeJS.ProcessEnv;
let db: Db;

async function insertDelivery(input: {
  id: string;
  workspaceId?: string;
  purpose?: string;
  sourceType?: string;
  sourceId?: string;
}) {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,started_at)
       VALUES (?,?,'email',NULL,?,?,?,?,?,'sent',?::timestamptz)`
    )
    .run(
      input.id,
      input.workspaceId ?? WORKSPACE,
      input.purpose ?? 'outreach',
      'Lead@Example.test',
      input.sourceType ?? 'email_action',
      input.sourceId ?? input.id,
      `key-${input.id}`,
      NOW.toISOString()
    );
}

function token(workspaceId = WORKSPACE, deliveryId = DELIVERY, env = ENV): string {
  const value = unsubscribeToken({ workspaceId, deliveryId, recipient: 'lead@example.test' }, env);
  if (!value) throw new Error('token was not minted');
  return value;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await insertDelivery({ id: DELIVERY });
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('unsubscribe tokens', () => {
  it('round-trips a token bound to its workspace, delivery and recipient', async () => {
    const value = token();
    expect(value).toMatch(/^del_0123456789abcdef\.[A-Za-z0-9_-]{43}$/);
    expect(await findUnsubscribeDelivery(db, value, ENV)).toEqual({
      id: DELIVERY,
      workspaceId: WORKSPACE,
      recipient: 'Lead@Example.test',
      sourceType: 'email_action',
      sourceId: DELIVERY
    });
  });

  it('rejects tampered, foreign and non-outreach tokens', async () => {
    const value = token();
    const macStart = DELIVERY.length + 1;
    const flipped = value[macStart] === 'A' ? 'B' : 'A';
    const tampered = `${value.slice(0, macStart)}${flipped}${value.slice(macStart + 1)}`;
    expect(await findUnsubscribeDelivery(db, tampered, ENV)).toBeNull();

    // Same delivery id, MAC minted for another tenant: never verifies against this row.
    expect(await findUnsubscribeDelivery(db, token(OTHER), ENV)).toBeNull();

    await insertDelivery({ id: 'del_00000000000000b2', workspaceId: OTHER });
    expect(
      await findUnsubscribeDelivery(db, token(WORKSPACE, 'del_00000000000000b2'), ENV)
    ).toBeNull();

    await insertDelivery({ id: 'del_00000000000000c3', purpose: 'reply' });
    expect(
      await findUnsubscribeDelivery(db, token(WORKSPACE, 'del_00000000000000c3'), ENV)
    ).toBeNull();

    expect(await findUnsubscribeDelivery(db, 'nope', ENV)).toBeNull();
    expect(await findUnsubscribeDelivery(db, DELIVERY, ENV)).toBeNull();
    expect(await findUnsubscribeDelivery(db, value.slice(0, -1), ENV)).toBeNull();
    expect(await findUnsubscribeDelivery(db, `${value}A`, ENV)).toBeNull();
  });

  it('binds the recipient', async () => {
    const other = unsubscribeToken(
      { workspaceId: WORKSPACE, deliveryId: DELIVERY, recipient: 'other@example.test' },
      ENV
    );
    expect(other).not.toBeNull();
    expect(await findUnsubscribeDelivery(db, other!, ENV)).toBeNull();
  });

  it('signs with a key derived from the secret, never the raw secret', () => {
    const input = JSON.stringify(['v1', WORKSPACE, DELIVERY, 'lead@example.test']);
    const derived = createHmac('sha256', 'unsubscribe-test-key-a')
      .update('trevra-email-unsubscribe-v1')
      .digest();
    const expected = createHmac('sha256', derived).update(input).digest('base64url');
    const raw = createHmac('sha256', 'unsubscribe-test-key-a').update(input).digest('base64url');
    const mac = token().slice(DELIVERY.length + 1);
    expect(mac).toBe(expected);
    expect(mac).not.toBe(raw);
  });

  it('verifies links minted before a key rotation', async () => {
    const value = token();
    const rotated = {
      ...ENV,
      TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b',
      TREVRA_SECRETS_KEY_PREVIOUS: 'unsubscribe-test-key-a'
    } as NodeJS.ProcessEnv;
    expect((await findUnsubscribeDelivery(db, value, rotated))?.id).toBe(DELIVERY);
    const retired = { ...ENV, TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b' } as NodeJS.ProcessEnv;
    expect(await findUnsubscribeDelivery(db, value, retired)).toBeNull();
  });

  it('never signs with the previous key', async () => {
    const rotated = {
      ...ENV,
      TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b',
      TREVRA_SECRETS_KEY_PREVIOUS: 'unsubscribe-test-key-a'
    } as NodeJS.ProcessEnv;
    const value = token(WORKSPACE, DELIVERY, rotated);
    const onlyB = { ...ENV, TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b' } as NodeJS.ProcessEnv;
    const onlyA = { ...ENV, TREVRA_SECRETS_KEY: 'unsubscribe-test-key-a' } as NodeJS.ProcessEnv;
    expect((await findUnsubscribeDelivery(db, value, onlyB))?.id).toBe(DELIVERY);
    expect(await findUnsubscribeDelivery(db, value, onlyA)).toBeNull();
  });
});

describe('applying an unsubscribe', () => {
  it('suppresses the recipient from the token alone, once, in the right workspace', async () => {
    const value = token();
    expect(
      await applyUnsubscribeToken(
        db,
        value,
        { source: 'email_mailto_unsubscribe', workspaceId: OTHER },
        NOW,
        ENV
      )
    ).toEqual({ applied: false, workspaceId: null });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toBeNull();

    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV);

    const suppression = await findSuppression(db, WORKSPACE, {
      channel: 'email',
      email: 'lead@example.test'
    });
    expect(suppression).toMatchObject({
      source: 'email_one_click_unsubscribe',
      sourceRef: DELIVERY
    });
    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM suppressions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(count?.total).toBe(1);
  });

  it('still suppresses a campaign delivery whose campaign row is gone', async () => {
    await insertDelivery({
      id: 'del_00000000000000d4',
      sourceType: 'campaign_email',
      sourceId: 'lcca_missing'
    });
    const value = token(WORKSPACE, 'del_00000000000000d4');
    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).not.toBeNull();
  });
});

describe('unsubscribing the Person an outreach email was approved for', () => {
  const RUN_KEY = 'eo_unsubscribe_person_0001';

  async function insertPerson(id: string, email: string) {
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(id, WORKSPACE, id, email, email, NOW.toISOString(), NOW.toISOString());
  }

  async function insertOutreachRun(personId: string) {
    await db
      .prepare(
        `INSERT INTO playbook_runs
         (id,workspace_id,playbook_key,playbook_version,status,actor_type,actor_id,input_json,correlation_id)
         VALUES ('pbr_unsubscribe_person',?,'gtm.email-outreach','1.0.0','completed','user',NULL,?::jsonb,'corr_unsub')`
      )
      .run(WORKSPACE, JSON.stringify({ idempotencyKey: RUN_KEY, personId }));
  }

  async function suppressionPerson(): Promise<string | null | undefined> {
    const row = await db
      .prepare('SELECT person_id FROM suppressions WHERE workspace_id=?')
      .get<{ person_id: string | null }>(WORKSPACE);
    return row?.person_id;
  }

  beforeEach(async () => {
    await insertDelivery({
      id: 'del_00000000000000e5',
      sourceType: 'email_outreach',
      sourceId: RUN_KEY
    });
  });

  it("suppresses the run's Person, not just the address", async () => {
    // The Person's canonical email differs from the address the lead was mailed at.
    await insertPerson('con_unsub_person', 'lead.person@elsewhere.test');
    await insertOutreachRun('con_unsub_person');

    const value = token(WORKSPACE, 'del_00000000000000e5');
    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });

    expect(await suppressionPerson()).toBe('con_unsub_person');
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', personId: 'con_unsub_person' })
    ).toMatchObject({ email: 'lead@example.test', sourceRef: 'del_00000000000000e5' });
  });

  it('falls back to the address alone when the run is gone', async () => {
    const value = token(WORKSPACE, 'del_00000000000000e5');
    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    expect(await suppressionPerson()).toBeNull();
  });

  it('falls back to the address alone, without throwing, when the address is another Person', async () => {
    await insertPerson('con_unsub_person', 'lead.person@elsewhere.test');
    await insertPerson('con_unsub_owner', 'lead@example.test');
    await insertOutreachRun('con_unsub_person');

    const value = token(WORKSPACE, 'del_00000000000000e5');
    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    // createSuppression attributes the address to the Person who owns it.
    expect(await suppressionPerson()).toBe('con_unsub_owner');
  });
});

describe('RFC 8058 headers', () => {
  it('needs a key and an HTTPS public origin', () => {
    expect(unsubscribeConfigured(ENV)).toBe(true);
    expect(unsubscribeConfigured({ ...ENV, TREVRA_PUBLIC_API_URL: 'http://localhost:43173' })).toBe(
      false
    );
    expect(unsubscribeConfigured({ ...ENV, TREVRA_SECRETS_KEY: '' })).toBe(false);
    expect(
      publicEmailOrigin({
        NODE_ENV: 'production',
        TREVRA_PUBLIC_API_URL: 'http://localhost:3000'
      } as NodeJS.ProcessEnv)
    ).toBeNull();
    expect(
      publicEmailOrigin({
        TREVRA_PUBLIC_API_URL: 'https://api.trevra.test/path'
      } as NodeJS.ProcessEnv)
    ).toBe('https://api.trevra.test');
    expect(
      listUnsubscribeHeaders({ token: 'del_x.y', origin: 'https://api.trevra.test', mailbox: null })
    ).toEqual([
      'List-Unsubscribe: <https://api.trevra.test/u/del_x.y>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ]);
  });

  it('adds a mailto target only while the inbound mailbox is syncing', async () => {
    const input = { workspaceId: WORKSPACE, deliveryId: DELIVERY, recipient: 'lead@example.test' };
    const oneClick = await outreachUnsubscribeHeaders(db, input, ENV);
    expect(oneClick).toEqual([
      `List-Unsubscribe: <https://api.trevra.test/u/${token()}>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ]);

    await db
      .prepare(
        `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_unsub_inbound',?,'gmail','trevra-gmail','gmail-unsub-inbound',NULL,'connected',0,?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
         VALUES (?,'conn_unsub_inbound','inbound@acme.test','starting',?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    expect(await outreachUnsubscribeHeaders(db, input, ENV)).toEqual(oneClick);

    await db
      .prepare("UPDATE email_inbound_mailboxes SET sync_status='syncing' WHERE workspace_id=?")
      .run(WORKSPACE);
    const withMailto = await outreachUnsubscribeHeaders(db, input, ENV);
    expect(withMailto[0]).toBe(
      `List-Unsubscribe: <https://api.trevra.test/u/${token()}>, <mailto:inbound@acme.test?subject=unsubscribe%20${token()}>`
    );
    expect(UNSUBSCRIBE_SUBJECT_PATTERN.exec(`Re: unsubscribe ${token()}`)?.[1]).toBe(token());

    expect(await outreachUnsubscribeHeaders(db, input, { ...ENV, TREVRA_SECRETS_KEY: '' })).toEqual(
      []
    );
  });

  it('renders a confirmation page that a GET cannot act on', () => {
    const value = token();
    const confirm = renderUnsubscribePage('confirm', value);
    expect(confirm).toContain(`<form method="post" action="/u/${value}">`);
    expect(confirm).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(confirm).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(confirm).not.toContain('<script');
    expect(renderUnsubscribePage('invalid')).not.toContain('<form');
    expect(renderUnsubscribePage('confirm', 'not-a-token')).not.toContain('<form');
    expect(renderUnsubscribePage('confirm', `${value}"><script>`)).not.toContain('<script');
    expect(renderUnsubscribePage('invalid')).toContain('the word &quot;unsubscribe&quot;');
  });
});
