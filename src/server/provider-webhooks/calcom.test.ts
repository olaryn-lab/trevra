import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { calcomVerifier } from './calcom.js';
import { createProviderWebhookEndpoint } from './index.js';

const SECRET = 'calcom-test-signing-secret-at-least-32-chars';
const WORKSPACE = 'ws_calcom_hooks_a';
const OTHER = 'ws_calcom_hooks_b';
const OWNER = 'usr_calcom_hooks_owner';
const OWNER_EMAIL = 'founder@calcom-hooks.example';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function envelope(
  trigger: string,
  payload: Record<string, unknown>,
  createdAt = '2026-10-06T08:00:00.000Z'
): string {
  return JSON.stringify({ triggerEvent: trigger, createdAt, payload });
}

function bookingPayload(
  uid: string,
  startTime: string,
  endTime: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    uid,
    title: 'Intro call',
    description: 'Agenda nobody should store',
    startTime,
    endTime,
    status: 'ACCEPTED',
    organizer: { email: OWNER_EMAIL, name: 'Founder', timeZone: 'Europe/Zurich' },
    attendees: [
      {
        email: 'maya@acme.example',
        name: 'Maya Patel',
        timeZone: 'Europe/Zurich',
        language: { locale: 'en' }
      }
    ],
    ...extra
  };
}

describe('Cal.com verifier', () => {
  const body = envelope(
    'BOOKING_CREATED',
    bookingPayload('bk-1', '2026-10-08T09:00:00.000Z', '2026-10-08T09:30:00.000Z')
  );

  it('accepts the hex HMAC-SHA256 of the raw body in X-Cal-Signature-256, in any header case', () => {
    expect(
      calcomVerifier.verify(
        Buffer.from(body),
        { 'X-Cal-Signature-256': sign(body) },
        SECRET,
        new Date()
      )
    ).toEqual({
      ok: true,
      eventId: createHash('sha256')
        .update('BOOKING_CREATED\nbk-1\n2026-10-06T08:00:00.000Z')
        .digest('hex'),
      eventType: 'BOOKING_CREATED',
      payload: JSON.parse(body).payload
    });
  });

  it('refuses an unsigned webhook, a wrong secret and a non-hex signature with 401', () => {
    for (const signature of [
      undefined,
      'no-secret-provided',
      sign(body, 'another-secret'),
      'sha256=abc'
    ]) {
      expect(
        calcomVerifier.verify(
          Buffer.from(body),
          { 'x-cal-signature-256': signature },
          SECRET,
          new Date()
        )
      ).toMatchObject({ ok: false, status: 401 });
    }
  });

  it('reads an array-valued signature header', () => {
    expect(
      calcomVerifier.verify(
        Buffer.from(body),
        { 'x-cal-signature-256': [sign(body), 'ignored'] },
        SECRET,
        new Date()
      )
    ).toMatchObject({ ok: true });
  });

  it('refuses a custom payload template with a message that says how to fix it', () => {
    const custom = JSON.stringify({ booking: 'custom' });
    expect(
      calcomVerifier.verify(
        Buffer.from(custom),
        { 'x-cal-signature-256': sign(custom) },
        SECRET,
        new Date()
      )
    ).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/payload template/) });
  });
});

describe('Cal.com booking webhooks', () => {
  let db: Db;
  let app: Express;
  let path = '';
  const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

  beforeAll(async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    await migrateAuthDatabase();
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    app = createApp(db);
    const now = new Date().toISOString();
    for (const workspaceId of [WORKSPACE, OTHER]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db
        .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, workspaceId, now);
    }
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(OWNER, WORKSPACE, OWNER_EMAIL, 'Founder', now);
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        'con_calcom_other_maya',
        OTHER,
        'Maya elsewhere',
        'maya@acme.example',
        'maya@acme.example',
        now,
        now
      );
    const endpoint = await createProviderWebhookEndpoint(db, {
      workspaceId: WORKSPACE,
      actorUserId: OWNER,
      provider: 'calcom',
      signingSecret: SECRET
    });
    path = `/api/hooks/v1/calcom/${endpoint.id}`;
  });

  afterAll(async () => {
    if (db) {
      for (const workspaceId of [WORKSPACE, OTHER]) {
        await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      }
    }
    if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
    else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
    await db?.close();
    await closeAuthDatabase();
  });

  function deliver(body: string, signature = sign(body)) {
    return request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('X-Cal-Signature-256', signature)
      .send(body);
  }

  async function meetings(workspaceId: string) {
    return db
      .prepare(
        'SELECT external_id,previous_external_id,status FROM meetings WHERE workspace_id=? ORDER BY external_id'
      )
      .all<{ external_id: string; previous_external_id: string | null; status: string }>(
        workspaceId
      );
  }

  async function stages(): Promise<string[]> {
    const rows = await db
      .prepare('SELECT stage FROM opportunities WHERE workspace_id=?')
      .all<{ stage: string }>(WORKSPACE);
    return rows.map((row) => row.stage);
  }

  it('creates once, reschedules, cancels, and never moves the stage back', async () => {
    const created = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-1', '2026-10-08T09:00:00.000Z', '2026-10-08T09:30:00.000Z')
    );
    expect((await deliver(created)).status).toBeLessThan(300);
    expect((await deliver(created)).status).toBeLessThan(300);
    expect(await meetings(WORKSPACE)).toEqual([
      { external_id: 'bk-1', previous_external_id: null, status: 'scheduled' }
    ]);
    expect(await stages()).toEqual(['meeting']);

    const rescheduled = envelope(
      'BOOKING_RESCHEDULED',
      bookingPayload('bk-2', '2026-10-09T09:00:00.000Z', '2026-10-09T09:30:00.000Z', {
        rescheduleUid: 'bk-1',
        rescheduleStartTime: '2026-10-08T09:00:00.000Z',
        rescheduleEndTime: '2026-10-08T09:30:00.000Z'
      }),
      '2026-10-06T09:00:00.000Z'
    );
    expect((await deliver(rescheduled)).status).toBeLessThan(300);
    // A late redelivery of the original booking must not bring it back.
    const late = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-1', '2026-10-08T09:00:00.000Z', '2026-10-08T09:30:00.000Z'),
      '2026-10-06T09:05:00.000Z'
    );
    expect((await deliver(late)).status).toBeLessThan(300);
    expect(await meetings(WORKSPACE)).toEqual([
      { external_id: 'bk-1', previous_external_id: null, status: 'cancelled' },
      { external_id: 'bk-2', previous_external_id: 'bk-1', status: 'rescheduled' }
    ]);

    const cancelled = envelope(
      'BOOKING_CANCELLED',
      bookingPayload('bk-2', '2026-10-09T09:00:00.000Z', '2026-10-09T09:30:00.000Z', {
        status: 'CANCELLED'
      }),
      '2026-10-06T10:00:00.000Z'
    );
    expect((await deliver(cancelled)).status).toBeLessThan(300);
    expect((await meetings(WORKSPACE)).map((row) => row.status)).toEqual([
      'cancelled',
      'cancelled'
    ]);
    expect(await stages()).toEqual(['meeting']);

    const sources = await db
      .prepare(
        "SELECT payload_json::text AS payload FROM source_records WHERE workspace_id=? AND provider='calcom'"
      )
      .all<{ payload: string }>(WORKSPACE);
    expect(sources.length).toBeGreaterThan(0);
    for (const row of sources) expect(row.payload).not.toMatch(/Agenda|Intro call/);
  });

  it("attaches the attendee only inside the endpoint's workspace", async () => {
    const body = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-cross', '2026-10-10T09:00:00.000Z', '2026-10-10T09:30:00.000Z'),
      '2026-10-06T11:00:00.000Z'
    );
    expect((await deliver(body)).status).toBeLessThan(300);
    expect(await meetings(OTHER)).toEqual([]);
    const other = await db
      .prepare('SELECT id,name FROM contacts WHERE workspace_id=?')
      .all<{ id: string; name: string }>(OTHER);
    expect(other).toEqual([{ id: 'con_calcom_other_maya', name: 'Maya elsewhere' }]);
    const owners = await db
      .prepare(
        `SELECT p.workspace_id FROM meetings m
         JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.person_id
         WHERE m.workspace_id=? AND m.external_id='bk-cross'`
      )
      .all<{ workspace_id: string }>(WORKSPACE);
    expect(owners).toEqual([{ workspace_id: WORKSPACE }]);
  });

  it('refuses a forged signature and ignores PING without storing anything', async () => {
    const before = (await meetings(WORKSPACE)).length;
    const forged = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-forged', '2026-10-11T09:00:00.000Z', '2026-10-11T09:30:00.000Z')
    );
    expect((await deliver(forged, sign(forged, 'wrong-secret'))).status).toBe(401);
    const ping = JSON.stringify({
      triggerEvent: 'PING',
      createdAt: '2026-10-06T12:00:00.000Z',
      payload: {}
    });
    expect((await deliver(ping)).status).toBeLessThan(300);
    expect((await meetings(WORKSPACE)).length).toBe(before);
  });
  it('accepts a signed delivery whose 1024-char uid has characters outside the event-id class, and dedupes a redelivery', async () => {
    const uid = 'é/ #'.repeat(256);
    expect(uid).toHaveLength(1024);
    const body = envelope(
      'BOOKING_CREATED',
      bookingPayload(uid, '2026-10-12T09:00:00.000Z', '2026-10-12T09:30:00.000Z'),
      '2026-10-06T13:00:00.000Z'
    );
    const first = await deliver(body);
    expect(first.status).toBeLessThan(300);
    const second = await deliver(body);
    expect(second.status).toBeLessThan(300);
    expect(second.body).toMatchObject({ duplicate: true });
  });

  it('accepts flat MEETING_STARTED and ignores a malformed booking without failing', async () => {
    const before = (await meetings(WORKSPACE)).length;
    const flat = JSON.stringify({
      triggerEvent: 'MEETING_STARTED',
      createdAt: '2026-10-06T14:00:00.000Z',
      title: 'flat'
    });
    expect((await deliver(flat)).status).toBeLessThan(300);
    const malformed = envelope('BOOKING_CREATED', { uid: 'bk-bad' }, '2026-10-06T14:05:00.000Z');
    expect((await deliver(malformed)).status).toBeLessThan(300);
    // 'ignored' settlement (not 'failed') means a redelivery is a duplicate.
    expect((await deliver(malformed)).body).toMatchObject({ duplicate: true });
    const backwards = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-back', '2026-10-13T10:00:00.000Z', '2026-10-13T09:00:00.000Z'),
      '2026-10-06T14:10:00.000Z'
    );
    const backwardsResponse = await deliver(backwards);
    expect(backwardsResponse.status).toBe(200);
    expect((await deliver(backwards)).body).toMatchObject({ duplicate: true });
    expect((await meetings(WORKSPACE)).length).toBe(before);
  });

  it('stores a booking whose fields irrelevant to the trigger are empty or null', async () => {
    const body = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-sparse', '2026-10-14T09:00:00.000Z', '2026-10-14T09:30:00.000Z', {
        rescheduleUid: '',
        organizer: null
      }),
      '2026-10-06T15:00:00.000Z'
    );
    expect((await deliver(body)).status).toBeLessThan(300);
    expect((await meetings(WORKSPACE)).map((row) => row.external_id)).toContain('bk-sparse');
    const noAttendees = envelope(
      'BOOKING_CREATED',
      bookingPayload('bk-none', '2026-10-15T09:00:00.000Z', '2026-10-15T09:30:00.000Z', {
        attendees: null
      }),
      '2026-10-06T15:05:00.000Z'
    );
    const response = await deliver(noAttendees);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ handled: false });
    expect((await meetings(WORKSPACE)).map((row) => row.external_id)).not.toContain('bk-none');
  });

  it('does not let a reschedule that points at itself cancel its own row', async () => {
    const body = envelope(
      'BOOKING_RESCHEDULED',
      bookingPayload('bk-self', '2026-10-16T09:00:00.000Z', '2026-10-16T09:30:00.000Z', {
        rescheduleUid: 'bk-self'
      }),
      '2026-10-06T16:00:00.000Z'
    );
    expect((await deliver(body)).status).toBeLessThan(300);
    expect((await meetings(WORKSPACE)).find((row) => row.external_id === 'bk-self')).toEqual({
      external_id: 'bk-self',
      previous_external_id: null,
      status: 'rescheduled'
    });
  });
});
