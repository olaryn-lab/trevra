import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { meetingKnown, recordMeeting, type RecordMeetingInput } from './store.js';

const WORKSPACE = 'ws_meetings_store_test';
const OTHER = 'ws_meetings_store_other';
const PERSON = 'con_meetings_store_maya';
const NOW = new Date('2026-08-21T08:00:00.000Z');
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
let db: Db;

function input(overrides: Partial<RecordMeetingInput> = {}): RecordMeetingInput {
  return {
    workspaceId: WORKSPACE,
    provider: 'calcom',
    externalId: 'booking-a',
    previousExternalId: null,
    status: 'scheduled',
    origin: 'booking',
    startsAt: '2026-08-22T09:00:00.000Z',
    endsAt: '2026-08-22T09:30:00.000Z',
    personId: PERSON,
    accountId: null,
    sourceRecordId: null,
    ...overrides
  };
}

async function rows() {
  return db
    .prepare(
      `SELECT external_id,previous_external_id,status,
              TO_CHAR(starts_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS starts_at,
              (cancelled_at IS NOT NULL) AS has_cancelled_at
       FROM meetings WHERE workspace_id=? ORDER BY external_id`
    )
    .all<{
      external_id: string;
      previous_external_id: string | null;
      status: string;
      starts_at: string;
      has_cancelled_at: boolean;
    }>(WORKSPACE);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      PERSON,
      WORKSPACE,
      'Maya Patel',
      'maya@acme.example',
      'maya@acme.example',
      NOW.toISOString(),
      NOW.toISOString()
    );
});

afterEach(async () => {
  if (db) {
    for (const workspaceId of [WORKSPACE, OTHER]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
  }
  await db?.close();
});

describe('meeting store', () => {
  it('records one row per provider booking and is idempotent on redelivery', async () => {
    const first = await recordMeeting(db, input(), NOW);
    const again = await recordMeeting(db, input(), NOW);
    expect(first).toMatchObject({
      created: true,
      changed: true,
      superseded: false,
      status: 'scheduled'
    });
    expect(again).toMatchObject({
      meetingId: first.meetingId,
      created: false,
      changed: false,
      status: 'scheduled'
    });
    expect(await rows()).toEqual([
      {
        external_id: 'booking-a',
        previous_external_id: null,
        status: 'scheduled',
        starts_at: '2026-08-22T09:00:00.000Z',
        has_cancelled_at: false
      }
    ]);
  });

  it('treats a moved start time on the same event as a reschedule of that row', async () => {
    await recordMeeting(db, input({ provider: 'google-calendar', origin: 'calendar' }), NOW);
    const moved = await recordMeeting(
      db,
      input({
        provider: 'google-calendar',
        origin: 'calendar',
        startsAt: '2026-08-23T09:00:00+02:00',
        endsAt: '2026-08-23T09:30:00+02:00'
      }),
      NOW
    );
    expect(moved).toMatchObject({ created: false, changed: true, status: 'rescheduled' });
    const [row] = await db
      .prepare(
        `SELECT status,TO_CHAR(starts_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS starts_at FROM meetings WHERE workspace_id=?`
      )
      .all<{ status: string; starts_at: string }>(WORKSPACE);
    expect(row).toEqual({ status: 'rescheduled', starts_at: '2026-08-23T07:00:00.000Z' });
  });

  it('keeps a cancellation when the original booking arrives late', async () => {
    const cancelled = await recordMeeting(db, input({ status: 'cancelled' }), NOW);
    expect(cancelled).toMatchObject({ created: true, status: 'cancelled' });
    const late = await recordMeeting(db, input(), NOW);
    expect(late).toMatchObject({ created: false, changed: false, status: 'cancelled' });
    expect((await rows()).map((row) => [row.status, row.has_cancelled_at])).toEqual([
      ['cancelled', true]
    ]);
  });

  it('cancels the old booking and ignores it afterwards when a reschedule mints a new uid', async () => {
    await recordMeeting(db, input(), NOW);
    const moved = await recordMeeting(
      db,
      input({
        externalId: 'booking-b',
        previousExternalId: 'booking-a',
        status: 'rescheduled',
        startsAt: '2026-08-24T09:00:00.000Z',
        endsAt: '2026-08-24T09:30:00.000Z'
      }),
      NOW
    );
    expect(moved).toMatchObject({ created: true, status: 'rescheduled' });
    const late = await recordMeeting(db, input(), NOW);
    expect(late).toMatchObject({ superseded: true, meetingId: moved.meetingId, changed: false });
    expect(
      (await rows()).map((row) => [row.external_id, row.previous_external_id, row.status])
    ).toEqual([
      ['booking-a', null, 'cancelled'],
      ['booking-b', 'booking-a', 'rescheduled']
    ]);
  });

  it('handles a reschedule that arrives before the original booking', async () => {
    await recordMeeting(
      db,
      input({
        externalId: 'booking-b',
        previousExternalId: 'booking-a',
        status: 'rescheduled',
        startsAt: '2026-08-24T09:00:00.000Z',
        endsAt: '2026-08-24T09:30:00.000Z'
      }),
      NOW
    );
    const late = await recordMeeting(db, input(), NOW);
    expect(late.superseded).toBe(true);
    expect((await rows()).map((row) => row.external_id)).toEqual(['booking-b']);
    expect(
      await meetingKnown(db, {
        workspaceId: WORKSPACE,
        provider: 'calcom',
        externalId: 'booking-a'
      })
    ).toBe(true);
  });

  it('ignores a cancellation for a meeting it has never seen when it has no person or time', async () => {
    const result = await recordMeeting(
      db,
      input({ status: 'cancelled', personId: null, startsAt: null, endsAt: null }),
      NOW
    );
    expect(result.meetingId).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('requires a person, a start and an end for a meeting that is not cancelled', async () => {
    await expect(recordMeeting(db, input({ personId: null }), NOW)).rejects.toThrow(
      /needs a person/
    );
  });

  it('refuses a person from another workspace and deletes meetings with their person', async () => {
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        'con_meetings_store_other',
        OTHER,
        'Other',
        'o@other.example',
        'o@other.example',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await expect(
      recordMeeting(db, input({ personId: 'con_meetings_store_other' }), NOW)
    ).rejects.toThrow();

    await recordMeeting(db, input(), NOW);
    await db.prepare('DELETE FROM contacts WHERE workspace_id=? AND id=?').run(WORKSPACE, PERSON);
    expect(await rows()).toEqual([]);
  });

  it('accepts only an https booking link in workspace settings', async () => {
    await expect(
      db
        .prepare(
          'INSERT INTO workspace_settings (workspace_id,booking_url,created_at,updated_at) VALUES (?,?,?,?)'
        )
        .run(WORKSPACE, 'http://cal.com/founder', NOW.toISOString(), NOW.toISOString())
    ).rejects.toThrow(/workspace_settings_booking_url_https/);
  });
});
