import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord } from '../integration-service.js';
import { getToday } from '../today.js';
import { meetingFromCalendarEvent } from './google-calendar.js';

const BOOKING = { meetingOrigin: 'booking' } as const;
const WORKSPACE = 'ws_meetings_ingest_test';
const NOW = '2026-08-21T08:00:00.000Z';
let db: Db;

const booking = {
  kind: 'meeting' as const,
  id: 'bk-1',
  personEmail: 'nia@prospect.example',
  personName: 'Nia Prospect',
  status: 'scheduled' as const,
  origin: 'booking' as const,
  startAt: '2026-08-22T09:00:00+02:00',
  endAt: '2026-08-22T09:30:00+02:00'
};

const calendar = {
  kind: 'meeting' as const,
  id: 'evt-1',
  personEmail: 'maya@acme.example',
  status: 'scheduled' as const,
  origin: 'calendar' as const,
  startAt: '2026-08-22T10:00:00Z',
  endAt: '2026-08-22T10:30:00Z'
};

async function seedPerson(): Promise<void> {
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      'con_ingest_maya',
      WORKSPACE,
      'Maya Patel',
      'maya@acme.example',
      'maya@acme.example',
      NOW,
      NOW
    );
}

async function seedOpportunity(id: string, stage: string, createdAt = NOW): Promise<void> {
  await db
    .prepare(
      'INSERT INTO opportunities (id,workspace_id,person_id,account_id,title,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, WORKSPACE, 'con_ingest_maya', null, 'Pilot', stage, createdAt, createdAt);
}

async function opportunities() {
  return db
    .prepare('SELECT id,stage FROM opportunities WHERE workspace_id=? ORDER BY created_at,id')
    .all<{ id: string; stage: string }>(WORKSPACE);
}

async function count(table: 'contacts' | 'meetings' | 'source_records'): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id=?`)
    .get<{ n: number }>(WORKSPACE);
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Meetings Ingest', NOW);
});

afterEach(async () => {
  if (db) await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('canonical meeting ingestion', () => {
  it('a booking creates the Person, the meeting and an Opportunity at meeting, once', async () => {
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking, BOOKING)).toEqual({
      stored: true
    });
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking, BOOKING)).toEqual({
      stored: true
    });
    expect(await count('contacts')).toBe(1);
    expect(await count('meetings')).toBe(1);
    expect((await opportunities()).map((row) => row.stage)).toEqual(['meeting']);
  });

  it('a booking never moves a later-stage Opportunity backwards', async () => {
    await seedPerson();
    await seedOpportunity('opp_ingest_proposal', 'proposal');
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'calcom',
      null,
      {
        ...booking,
        personEmail: 'maya@acme.example'
      },
      BOOKING
    );
    expect(await opportunities()).toEqual([{ id: 'opp_ingest_proposal', stage: 'proposal' }]);
  });

  it('a calendar meeting only raises an Opportunity that already exists', async () => {
    await seedPerson();
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'google-calendar', null, calendar)).toEqual({
      stored: true
    });
    expect(await opportunities()).toEqual([]);

    // The next sync of the same event, after an Opportunity exists, raises it.
    await seedOpportunity('opp_ingest_new', 'new', '2026-08-01T00:00:00.000Z');
    await ingestCanonicalRecord(db, WORKSPACE, 'google-calendar', null, calendar);
    expect(await opportunities()).toEqual([{ id: 'opp_ingest_new', stage: 'meeting' }]);
  });

  it('a calendar meeting with nobody Trevra knows stores nothing at all', async () => {
    expect(
      await ingestCanonicalRecord(db, WORKSPACE, 'google-calendar', null, {
        ...calendar,
        personEmail: 'friend@personal.example'
      })
    ).toEqual({ stored: false });
    expect(await count('contacts')).toBe(0);
    expect(await count('meetings')).toBe(0);
    expect(await count('source_records')).toBe(0);
  });

  it('a cancellation never advances the stage, even when the booking arrives after it', async () => {
    // A cancellation never creates a Person, so the tombstone needs one that exists.
    await seedPerson();
    const known = { ...booking, personEmail: 'maya@acme.example' };
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'calcom',
      null,
      { ...known, status: 'cancelled' },
      BOOKING
    );
    await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, known, BOOKING);
    const [meeting] = await db
      .prepare('SELECT status FROM meetings WHERE workspace_id=?')
      .all<{ status: string }>(WORKSPACE);
    expect(meeting.status).toBe('cancelled');
    expect(await opportunities()).toEqual([]);
  });

  it('rejects a live meeting without a person or both times', async () => {
    await expect(
      ingestCanonicalRecord(
        db,
        WORKSPACE,
        'calcom',
        null,
        {
          kind: 'meeting',
          id: 'bk-incomplete',
          personEmail: 'nia@prospect.example',
          status: 'scheduled',
          origin: 'booking'
        },
        BOOKING
      )
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('ignores a booking origin in the record when the ingress did not assert it', async () => {
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking)).toEqual({
      stored: false
    });
    expect(await count('contacts')).toBe(0);
    expect(await count('meetings')).toBe(0);
    expect(await opportunities()).toEqual([]);
  });

  it('a calendar meeting does not raise an Opportunity created after it ended', async () => {
    await seedPerson();
    await seedOpportunity('opp_ingest_later', 'new', '2026-08-23T00:00:00.000Z');
    await ingestCanonicalRecord(db, WORKSPACE, 'google-calendar', null, calendar);
    expect(await opportunities()).toEqual([{ id: 'opp_ingest_later', stage: 'new' }]);
  });

  it('a booking cancelled before its reschedule arrives stays cancelled and advances nothing', async () => {
    const original = { ...booking, id: 'bk-a' };
    const moved = {
      ...booking,
      id: 'bk-b',
      startAt: '2026-08-22T11:00:00+02:00',
      endAt: '2026-08-22T11:30:00+02:00'
    };
    // Cal.com: booked A, rescheduled A -> B, then cancelled B. Delivered: A, cancel B, reschedule.
    await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, original, BOOKING);
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'calcom',
      null,
      { ...moved, status: 'cancelled' },
      BOOKING
    );
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'calcom',
      null,
      { ...moved, previousId: 'bk-a', status: 'rescheduled' },
      BOOKING
    );
    const meetings = await db
      .prepare(
        'SELECT id,external_id,status FROM meetings WHERE workspace_id=? ORDER BY external_id'
      )
      .all<{ id: string; external_id: string; status: string }>(WORKSPACE);
    expect(meetings.map((row) => [row.external_id, row.status])).toEqual([
      ['bk-a', 'cancelled'],
      ['bk-b', 'cancelled']
    ]);
    const advancedByB = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM opportunity_stage_observations
         WHERE workspace_id=? AND source_type='meeting' AND source_id=?`
      )
      .get<{ n: number }>(WORKSPACE, meetings[1].id);
    expect(advancedByB?.n).toBe(0);
    const today = await getToday(db, WORKSPACE, new Date(NOW));
    expect(today.needsAttention.filter((item) => item.kind === 'meeting_upcoming')).toEqual([]);
  });

  it('a calendar meeting declined and then accepted again is back on Today', async () => {
    await seedPerson();
    const own = new Set<string>();
    const observe = async (responseStatus: string) => {
      const outcome = await meetingFromCalendarEvent(
        db,
        WORKSPACE,
        {
          kind: 'calendar#event',
          id: 'evt-rsvp',
          status: 'confirmed',
          start: { dateTime: calendar.startAt },
          end: { dateTime: calendar.endAt },
          attendees: [{ email: 'maya@acme.example', responseStatus }]
        },
        own
      );
      if (!outcome.ok) throw new Error(outcome.reason);
      await ingestCanonicalRecord(db, WORKSPACE, 'google-calendar', null, outcome.record);
    };
    await observe('needsAction');
    await observe('declined');
    await observe('accepted');
    const [meeting] = await db
      .prepare('SELECT status,cancelled_at FROM meetings WHERE workspace_id=?')
      .all<{ status: string; cancelled_at: string | null }>(WORKSPACE);
    expect(meeting).toEqual({ status: 'scheduled', cancelled_at: null });
    const today = await getToday(db, WORKSPACE, new Date(NOW));
    expect(today.needsAttention.filter((item) => item.kind === 'meeting_upcoming')).toHaveLength(1);
  });

  it('an unknown booking cancellation with times stores a tombstone for its booker', async () => {
    expect(
      await ingestCanonicalRecord(
        db,
        WORKSPACE,
        'calcom',
        null,
        {
          ...booking,
          id: 'bk-unknown',
          personEmail: 'fresh@prospect.example',
          status: 'cancelled'
        },
        BOOKING
      )
    ).toEqual({ stored: true });
    expect(await count('contacts')).toBe(1);
    const [meeting] = await db
      .prepare('SELECT status FROM meetings WHERE workspace_id=?')
      .all<{ status: string }>(WORKSPACE);
    expect(meeting.status).toBe('cancelled');
    expect(await opportunities()).toEqual([]);
  });

  it('an unknown booking cancellation without times creates no contact', async () => {
    expect(
      await ingestCanonicalRecord(
        db,
        WORKSPACE,
        'calcom',
        null,
        {
          kind: 'meeting',
          id: 'bk-ghost',
          personEmail: 'ghost@prospect.example',
          status: 'cancelled',
          origin: 'booking'
        },
        BOOKING
      )
    ).toEqual({ stored: false });
    expect(await count('contacts')).toBe(0);
    expect(await count('source_records')).toBe(0);
  });
});
