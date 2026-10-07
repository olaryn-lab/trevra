import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { meetingFromCalendarEvent, readCalendarEvent } from './google-calendar.js';

const OWN = new Set(['founder@lemoncrow.example', 'cofounder@lemoncrow.example']);
const WORKSPACE = 'ws_meetings_gcal_test';

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'calendar#event',
    id: 'evt-1',
    status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=abc',
    summary: 'Acme intro',
    description: 'Agenda nobody should store',
    start: { dateTime: '2026-11-03T10:00:00+01:00', timeZone: 'Europe/Zurich' },
    end: { dateTime: '2026-11-03T10:30:00+01:00', timeZone: 'Europe/Zurich' },
    attendees: [
      { email: 'founder@lemoncrow.example', self: true, responseStatus: 'accepted' },
      { email: 'room-1@resource.calendar.google.com', resource: true },
      { email: 'cofounder@lemoncrow.example', responseStatus: 'accepted' },
      { email: 'Maya@Acme.example', displayName: 'Maya Patel', responseStatus: 'needsAction' }
    ],
    _nango_metadata: { last_action: 'ADDED', deleted_at: null, cursor: 'c1' },
    ...overrides
  };
}

describe('readCalendarEvent', () => {
  it('keeps a time and the external attendees, never the summary or description', () => {
    const reading = readCalendarEvent(event(), OWN);
    expect(reading).toEqual({
      ok: true,
      externalId: 'evt-1',
      cancelled: false,
      startAt: '2026-11-03T10:00:00+01:00',
      endAt: '2026-11-03T10:30:00+01:00',
      externalUrl: 'https://www.google.com/calendar/event?eid=abc',
      candidates: [{ email: 'maya@acme.example', name: 'Maya Patel', declined: false }]
    });
    expect(JSON.stringify(reading)).not.toMatch(/Acme intro|Agenda/);
  });

  it('leaves out all-day, internal-only and attendee-less events', () => {
    expect(
      readCalendarEvent(event({ start: { date: '2026-11-04' }, end: { date: '2026-11-05' } }), OWN)
    ).toEqual({ ok: false, reason: 'not_prospect' });
    expect(
      readCalendarEvent(
        event({
          attendees: [
            { email: 'founder@lemoncrow.example', self: true },
            { email: 'cofounder@lemoncrow.example' }
          ]
        }),
        OWN
      )
    ).toEqual({ ok: false, reason: 'not_prospect' });
    expect(readCalendarEvent(event({ attendees: undefined }), OWN)).toEqual({
      ok: false,
      reason: 'not_prospect'
    });
  });

  it('reports a shape it cannot read instead of guessing', () => {
    // Microsoft Graph: no offset on dateTime, and attendees carry emailAddress.
    expect(
      readCalendarEvent(
        {
          id: 'graph-1',
          start: { dateTime: '2026-11-03T10:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-03T10:30:00.0000000', timeZone: 'UTC' },
          attendees: [{ emailAddress: { address: 'maya@acme.example' } }]
        },
        OWN
      )
    ).toEqual({ ok: false, reason: 'unrecognized' });
    expect(readCalendarEvent({ summary: 'no id' }, OWN)).toEqual({
      ok: false,
      reason: 'unrecognized'
    });
  });

  it('reads a Google cancellation and a Nango deletion as cancelled', () => {
    expect(readCalendarEvent({ id: 'evt-gone', status: 'cancelled' }, OWN)).toMatchObject({
      ok: true,
      cancelled: true,
      startAt: null,
      candidates: []
    });
    expect(
      readCalendarEvent(
        event({ _nango_metadata: { last_action: 'DELETED', deleted_at: '2026-11-01T00:00:00Z' } }),
        OWN
      )
    ).toMatchObject({ ok: true, cancelled: true });
  });

  it('reads an event the calendar owner declined as cancelled', () => {
    expect(
      readCalendarEvent(
        event({
          attendees: [
            { email: 'founder@lemoncrow.example', self: true, responseStatus: 'declined' },
            { email: 'maya@acme.example', responseStatus: 'accepted' }
          ]
        }),
        OWN
      )
    ).toMatchObject({ ok: true, cancelled: true });
  });
});

describe('meetingFromCalendarEvent', () => {
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE, 'Calendar', '2026-08-01T00:00:00.000Z');
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        'con_gcal_maya',
        WORKSPACE,
        'Maya Patel',
        'maya@acme.example',
        'maya@acme.example',
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      );
  });

  afterEach(async () => {
    if (db) await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db?.close();
  });

  it('matches the first known attendee and carries only that person', async () => {
    const outcome = await meetingFromCalendarEvent(
      db,
      WORKSPACE,
      event({
        attendees: [
          { email: 'stranger@else.example', responseStatus: 'accepted' },
          { email: 'maya@acme.example', displayName: 'Maya Patel', responseStatus: 'accepted' }
        ]
      }),
      OWN
    );
    expect(outcome).toEqual({
      ok: true,
      record: {
        kind: 'meeting',
        id: 'evt-1',
        status: 'scheduled',
        origin: 'calendar',
        startAt: '2026-11-03T10:00:00+01:00',
        endAt: '2026-11-03T10:30:00+01:00',
        personEmail: 'maya@acme.example',
        personName: 'Maya Patel',
        externalUrl: 'https://www.google.com/calendar/event?eid=abc'
      }
    });
  });

  it('reads a meeting the matched person declined as cancelled', async () => {
    const outcome = await meetingFromCalendarEvent(
      db,
      WORKSPACE,
      event({ attendees: [{ email: 'maya@acme.example', responseStatus: 'declined' }] }),
      OWN
    );
    expect(outcome).toMatchObject({ ok: true, record: { status: 'cancelled' } });
  });

  it('ignores a meeting with nobody already in the workspace', async () => {
    expect(
      await meetingFromCalendarEvent(
        db,
        WORKSPACE,
        event({ attendees: [{ email: 'stranger@else.example' }] }),
        OWN
      )
    ).toEqual({ ok: false, reason: 'unknown_person' });
  });
});
