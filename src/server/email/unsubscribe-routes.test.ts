import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { unsubscribeToken } from './unsubscribe.js';

const WORKSPACE = 'ws_email_unsubscribe_routes';
const DELIVERY = 'del_00000000000000e5';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;
let app: Express;

function token(): string {
  const value = unsubscribeToken({
    workspaceId: WORKSPACE,
    deliveryId: DELIVERY,
    recipient: 'lead@example.test'
  });
  if (!value) throw new Error('TREVRA_SECRETS_KEY is not set for tests');
  return value;
}

async function suppressionCount(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM suppressions WHERE workspace_id=?')
    .get<{ total: number }>(WORKSPACE);
  return Number(row?.total ?? 0);
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

beforeEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Unsubscribe routes', NOW);
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,started_at)
       VALUES (?,?,'email',NULL,'outreach','lead@example.test','email_action',?,?,'sent',?::timestamptz)`
    )
    .run(DELIVERY, WORKSPACE, DELIVERY, `key-${DELIVERY}`, NOW);
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
  await closeAuthDatabase();
});

describe('/u/:token', () => {
  it('renders a confirmation on GET and never unsubscribes', async () => {
    const response = await request(app).get(`/u/${token()}`).expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.text).toContain(`<form method="post" action="/u/${token()}">`);
    await request(app).get(`/u/${token()}`).expect(200);
    expect(await suppressionCount()).toBe(0);
  });

  it('unsubscribes on an RFC 8058 one-click POST', async () => {
    const response = await request(app)
      .post(`/u/${token()}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click')
      .expect(200);
    expect(response.text).toContain('You are unsubscribed');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(await suppressionCount()).toBe(1);
    await request(app).post(`/u/${token()}`).send('List-Unsubscribe=One-Click').expect(200);
    expect(await suppressionCount()).toBe(1);
  });

  it('answers 404 to a forged token on both methods', async () => {
    const forged = `${DELIVERY}.${'A'.repeat(43)}`;
    await request(app).get(`/u/${forged}`).expect(404);
    await request(app).post(`/u/${forged}`).send('List-Unsubscribe=One-Click').expect(404);
    await request(app).get('/u/not-a-token').expect(404);
    expect(await suppressionCount()).toBe(0);
  });
});

describe('/u/:token bodies and limits', () => {
  it('unsubscribes on a POST with no body or a JSON body', async () => {
    await request(app).post(`/u/${token()}`).expect(200);
    expect(await suppressionCount()).toBe(1);
    await db.prepare('DELETE FROM suppressions WHERE workspace_id=?').run(WORKSPACE);
    await request(app).post(`/u/${token()}`).send({ anything: true }).expect(200);
    expect(await suppressionCount()).toBe(1);
  });

  it('answers a rate-limited POST with the no-store error page, not plain text', async () => {
    const limited = createApp(db);
    const forged = `${DELIVERY}.${'A'.repeat(43)}`;
    let last = await request(limited).post(`/u/${forged}`);
    for (let sent = 1; sent < 600 && last.status !== 429; sent += 1) {
      last = await request(limited).post(`/u/${forged}`);
    }
    expect(last.status).toBe(404);
    last = await request(limited).post(`/u/${forged}`);
    expect(last.status).toBe(429);
    expect(last.headers['content-type']).toContain('text/html');
    expect(last.headers['cache-control']).toBe('no-store');
    expect(last.text).toContain('Your request was not recorded');
  });
});

describe('/u/:token failures', () => {
  // A Db whose matching statements throw, standing in for any failure inside
  // applyUnsubscribeToken (a DB outage, createSuppression refusing, ...).
  function failingApp(failOn: RegExp): Express {
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string) => {
          if (failOn.test(sql)) throw new Error('forced failure at /var/secret/stack.ts');
          return target.prepare(sql);
        };
      }
    }) as Db;
    return createApp(broken);
  }

  it('renders the error page, not a stack, when the unsubscribe throws', async () => {
    const response = await request(failingApp(/INSERT INTO suppressions/))
      .post(`/u/${token()}`)
      .send('List-Unsubscribe=One-Click')
      .expect(500);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Your request was not recorded');
    expect(response.text).not.toContain('forced failure');
    expect(response.text).not.toContain('stack.ts');
    expect(await suppressionCount()).toBe(0);
  });

  it('renders the error page, not a stack, when the GET lookup throws', async () => {
    const response = await request(failingApp(/FROM gtm_deliveries/))
      .get(`/u/${token()}`)
      .expect(500);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Your request was not recorded');
    expect(response.text).not.toContain('forced failure');
  });
});
