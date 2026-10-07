import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';
import { createCaptureSource } from './sources.js';
import { acceptInboundSubmission } from './submissions.js';
import { inboundSubmissionSchema } from './types.js';
import { recordProductMilestone } from './milestone-recorder.js';

let db: Db;
let app: Express;
let session = '';
const WS = 'ws_inbound_reads';
const OTHER = 'ws_inbound_reads_other';
const USER = 'usr_inbound_reads';

async function seedContact(workspaceId: string, email: string): Promise<string> {
  const contactId = id('con');
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(contactId, workspaceId, 'Read Person', email, email, now, now);
  return contactId;
}

async function clear(): Promise<void> {
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await clear();
  const now = new Date().toISOString();
  for (const workspaceId of [WS, OTHER])
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, now);
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'reads@trevra.test', 'Reads', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  session = token;
});

afterAll(async () => {
  await clear();
  await db?.close();
  await closeAuthDatabase();
});

describe('inbound reads', () => {
  it('lists this workspace milestones only', async () => {
    const mine = await seedContact(WS, 'mine@reads.test');
    const theirs = await seedContact(OTHER, 'theirs@reads.test');
    const recorded = await recordProductMilestone(db, {
      workspaceId: WS,
      kind: 'paid',
      contactId: mine,
      accountId: null,
      sourceType: 'inbound_submission',
      sourceId: 'sub_reads_mine',
      occurredAt: new Date()
    });
    await recordProductMilestone(db, {
      workspaceId: OTHER,
      kind: 'paid',
      contactId: theirs,
      accountId: null,
      sourceType: 'inbound_submission',
      sourceId: 'sub_reads_theirs',
      occurredAt: new Date()
    });
    const response = await request(app)
      .get('/api/inbound/milestones?limit=20')
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    expect(response.body.milestones).toHaveLength(1);
    expect(response.body.milestones[0]).toMatchObject({
      id: recorded.milestone.id,
      kind: 'paid',
      label: 'paid',
      personEmail: 'mine@reads.test'
    });
  });

  it('rejects a non-numeric or fractional limit before it reaches SQL', async () => {
    for (const bad of ['abc', '1.5', '0', '201'])
      await request(app)
        .get(`/api/inbound/milestones?limit=${bad}`)
        .set('Cookie', `trevra_session=${session}`)
        .expect((res) => {
          if (res.status < 400 || res.status >= 500)
            throw new Error(`limit=${bad} -> ${res.status}`);
        });
  });

  it('returns the 90-day attribution summary', async () => {
    const { source } = await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Site',
      kind: 'website'
    });
    await acceptInboundSubmission(db, {
      source,
      idempotencyKey: 'reads-attr-0001',
      body: inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'attr@reads.test' },
        attribution: { utm_source: 'newsletter', heard_about: 'podcast' }
      }),
      payloadHash: 'reads-attr-0001'
    });
    const response = await request(app)
      .get('/api/inbound/attribution')
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    expect(response.body).toMatchObject({
      days: 90,
      byUtmSource: [{ value: 'newsletter', submissions: 1, people: 1 }],
      byHeardAbout: [{ value: 'podcast', submissions: 1, people: 1 }]
    });
  });

  it('keeps an older lead in the inbound list however many milestones arrive after it', async () => {
    const { source } = await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Product',
      kind: 'signup'
    });
    const demo = await acceptInboundSubmission(db, {
      source,
      idempotencyKey: 'reads-crowd-demo',
      body: inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'crowd@reads.test' }
      }),
      payloadHash: 'reads-crowd-demo',
      receivedAt: new Date(Date.now() - 3_600_000)
    });
    // 201 milestone submissions, every one newer than the demo request.
    await db
      .prepare(
        `INSERT INTO inbound_submissions
           (id,workspace_id,capture_source_id,contact_id,idempotency_key,kind,payload_hash,received_at,created_at)
         SELECT 'sub_crowd_' || n, workspace_id, capture_source_id, contact_id, 'reads-crowd-' || n,
                'signed_up', 'reads-crowd-' || n, received_at + n * interval '1 second', created_at
         FROM inbound_submissions, generate_series(1,201) AS n
         WHERE workspace_id=? AND id=?`
      )
      .run(WS, demo.submission.id);

    const response = await request(app)
      .get('/api/inbound/submissions?limit=200')
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    const listed = response.body.submissions as Array<{ id: string; kind: string }>;
    expect(listed.map((submission) => submission.id)).toContain(demo.submission.id);
    expect(listed.filter((submission) => submission.kind === 'signed_up')).toEqual([]);
  });
});
