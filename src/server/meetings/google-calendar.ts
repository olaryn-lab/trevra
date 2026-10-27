import { z } from 'zod/v3';
import type { Db } from '../db.js';
import type { CanonicalMeeting } from './types.js';

/**
 * Google Calendar event -> canonical meeting.
 *
 * Field names: https://developers.google.com/calendar/api/v3/reference/events
 * Nango deletion metadata: https://docs.nango.dev/reference/api/sync/records-list
 *
 * Only a TIME and ONE matched Person leave this module. The summary, description,
 * location, conference data and the rest of the guest list never do.
 */

const attendeeSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
  responseStatus: z.string().optional()
});

const boundarySchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional()
});

const googleEventSchema = z.object({
  id: z.string().min(1).max(1024),
  status: z.string().optional(),
  htmlLink: z.string().url().optional(),
  start: boundarySchema.optional(),
  end: boundarySchema.optional(),
  attendees: z.array(attendeeSchema).optional()
});

const offsetDateTime = z.string().datetime({ offset: true });
const emailSchema = z.string().email();

export interface CalendarCandidate {
  email: string;
  name: string | null;
  declined: boolean;
}

export type CalendarEventReading =
  | {
      ok: true;
      externalId: string;
      cancelled: boolean;
      startAt: string | null;
      endAt: string | null;
      externalUrl: string | null;
      candidates: CalendarCandidate[];
    }
  | { ok: false; reason: 'not_prospect' | 'unrecognized' };

export type CalendarMeetingOutcome =
  | { ok: true; record: CanonicalMeeting }
  | { ok: false; reason: 'not_prospect' | 'unrecognized' | 'unknown_person' };

/** Nango keeps a deleted record's last payload and marks it in `_nango_metadata`. */
export function nangoRecordDeleted(raw: Record<string, unknown>): boolean {
  const meta = raw._nango_metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const fields = meta as Record<string, unknown>;
  return fields.last_action === 'DELETED' || Boolean(fields.deleted_at);
}

/**
 * Pure read of one event.
 *
 * `not_prospect`: readable, and deliberately not a meeting (all-day, or nobody
 * outside the workspace). `unrecognized`: a shape this build cannot read (for
 * example Microsoft Graph's offset-less `dateTime`), counted as skipped so the
 * connection says so.
 */
export function readCalendarEvent(
  raw: Record<string, unknown>,
  ownEmails: ReadonlySet<string>
): CalendarEventReading {
  const parsed = googleEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'unrecognized' };
  const event = parsed.data;
  // The calendar owner declining is the founder saying they will not be there.
  const ownerDeclined = (event.attendees ?? []).some(
    (attendee) => attendee.self === true && attendee.responseStatus === 'declined'
  );
  const cancelled = nangoRecordDeleted(raw) || event.status === 'cancelled' || ownerDeclined;
  const startRaw = event.start?.dateTime;
  const endRaw = event.end?.dateTime;
  if (!startRaw && !endRaw && (event.start?.date || event.end?.date)) {
    return { ok: false, reason: 'not_prospect' };
  }
  const startAt = startRaw && offsetDateTime.safeParse(startRaw).success ? startRaw : null;
  const endAt = endRaw && offsetDateTime.safeParse(endRaw).success ? endRaw : null;
  if (!cancelled && (!startAt || !endAt)) return { ok: false, reason: 'unrecognized' };
  if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) {
    return { ok: false, reason: 'unrecognized' };
  }
  const candidates: CalendarCandidate[] = [];
  for (const attendee of event.attendees ?? []) {
    const email = attendee.email?.trim().toLowerCase() ?? '';
    if (!email || attendee.self || attendee.resource || ownEmails.has(email)) continue;
    if (!emailSchema.safeParse(email).success) continue;
    if (candidates.some((candidate) => candidate.email === email)) continue;
    candidates.push({
      email,
      name: attendee.displayName?.trim() || null,
      declined: attendee.responseStatus === 'declined'
    });
  }
  if (candidates.length === 0 && !cancelled) return { ok: false, reason: 'not_prospect' };
  return {
    ok: true,
    externalId: event.id,
    cancelled,
    startAt,
    endAt,
    externalUrl: event.htmlLink ?? null,
    candidates
  };
}

/**
 * One event, one matched Person.
 *
 * The Person must already exist in the workspace: a calendar is full of people
 * who are not prospects, and creating contacts from it would turn every lunch
 * into a lead. A matched Person who declined makes the meeting cancelled.
 */
export async function meetingFromCalendarEvent(
  db: Db,
  workspaceId: string,
  raw: Record<string, unknown>,
  ownEmails: ReadonlySet<string>
): Promise<CalendarMeetingOutcome> {
  const reading = readCalendarEvent(raw, ownEmails);
  if (!reading.ok) return reading;
  const emails = reading.candidates.map((candidate) => candidate.email);
  const knownRows =
    emails.length === 0
      ? []
      : await db
          .prepare(
            'SELECT email_normalized FROM contacts WHERE workspace_id=? AND email_normalized = ANY(?::text[])'
          )
          .all<{ email_normalized: string }>(workspaceId, emails);
  const known = new Set(knownRows.map((row) => row.email_normalized));
  const matches = reading.candidates.filter((candidate) => known.has(candidate.email));
  const match = matches.find((candidate) => !candidate.declined) ?? matches[0] ?? null;
  if (!match && !reading.cancelled) return { ok: false, reason: 'unknown_person' };
  const record: CanonicalMeeting = {
    kind: 'meeting',
    id: reading.externalId,
    status: reading.cancelled || match?.declined ? 'cancelled' : 'scheduled',
    origin: 'calendar',
    ...(reading.startAt ? { startAt: reading.startAt } : {}),
    ...(reading.endAt ? { endAt: reading.endAt } : {}),
    ...(match ? { personEmail: match.email } : {}),
    ...(match?.name ? { personName: match.name } : {}),
    ...(reading.externalUrl ? { externalUrl: reading.externalUrl } : {})
  };
  return { ok: true, record };
}
