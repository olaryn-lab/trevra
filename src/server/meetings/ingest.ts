import type { Db } from '../db.js';
import { normalizeContactEmail } from '../lead-capture/people.js';
import { advanceOpportunityStage } from '../opportunity-advance.js';
import { accountForPerson } from '../person-identities.js';
import { recordMeeting, type RecordMeetingResult } from './store.js';
import type { CanonicalMeeting } from './types.js';

export interface MeetingPerson {
  personId: string | null;
  accountId: string | null;
}

/** An EXISTING Person by email. Never creates one: calendar events are observations. */
export async function findMeetingPerson(
  db: Db,
  workspaceId: string,
  email: string
): Promise<MeetingPerson> {
  const normalized = normalizeContactEmail(email);
  if (!normalized) return { personId: null, accountId: null };
  const row = await db
    .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?')
    .get<{ id: string }>(workspaceId, normalized);
  if (!row) return { personId: null, accountId: null };
  return { personId: row.id, accountId: await accountForPerson(db, workspaceId, row.id) };
}

/**
 * Emails that are "us" in this workspace, so a meeting between colleagues is
 * never read as a meeting with a prospect.
 */
export async function workspaceUserEmails(db: Db, workspaceId: string): Promise<Set<string>> {
  // lc-debt: only `users` whose home workspace is this one; a teammate who joined
  // through better-auth membership keeps their own home workspace and is not
  // excluded here; read the better-auth `member` table once Trevra migrations own it.
  const rows = await db
    .prepare('SELECT LOWER(BTRIM(email)) AS email FROM users WHERE workspace_id=?')
    .all<{ email: string }>(workspaceId);
  return new Set(rows.map((row) => row.email).filter(Boolean));
}

export interface ApplyMeetingInput {
  workspaceId: string;
  provider: string;
  sourceRecordId: string | null;
  personId: string | null;
  accountId: string | null;
  record: CanonicalMeeting;
}

export interface ApplyMeetingResult extends RecordMeetingResult {
  stageAdvanced: boolean;
}

/**
 * Record the meeting, then move the Opportunity forward.
 *
 * The advance runs on every application, not only when the row changed:
 * `advanceOpportunityStage` is idempotent per (sourceType, sourceId), so a
 * redelivery after a failed advance completes it instead of losing it.
 * Cancelled and superseded meetings never advance anything.
 *
 * `record.origin` must already be the trusted, ingress-assigned origin.
 */
export async function applyMeetingRecord(
  db: Db,
  input: ApplyMeetingInput,
  now: Date = new Date()
): Promise<ApplyMeetingResult> {
  const { record } = input;
  const recorded = await recordMeeting(
    db,
    {
      workspaceId: input.workspaceId,
      provider: input.provider,
      externalId: record.id,
      previousExternalId: record.previousId ?? null,
      status: record.status,
      origin: record.origin,
      startsAt: record.startAt ?? null,
      endsAt: record.endAt ?? null,
      personId: input.personId,
      accountId: input.accountId,
      sourceRecordId: input.sourceRecordId
    },
    now
  );
  if (
    !recorded.meetingId ||
    recorded.superseded ||
    recorded.status === 'cancelled' ||
    !recorded.personId ||
    !recorded.endsAt
  ) {
    return { ...recorded, stageAdvanced: false };
  }
  const advance = {
    workspaceId: input.workspaceId,
    personId: recorded.personId,
    accountId: recorded.accountId,
    minimumStage: 'meeting' as const,
    title: `Meeting with ${record.accountName?.trim() || record.personName?.trim() || record.personEmail || 'a contact'}`,
    reason: record.origin === 'booking' ? 'meeting_booked' : 'meeting_on_calendar',
    sourceType: 'meeting',
    sourceId: recorded.meetingId
  };
  // A calendar event is evidence about an Opportunity, never the reason one exists,
  // and a meeting from before the Opportunity existed is not evidence about it.
  const advanced =
    record.origin === 'calendar'
      ? await advanceOpportunityStage(
          db,
          { ...advance, createIfMissing: false as const, openedAtOrBefore: recorded.endsAt },
          now
        )
      : await advanceOpportunityStage(db, advance, now);
  return {
    ...recorded,
    stageAdvanced: Boolean(advanced && (advanced.created || advanced.changed))
  };
}
