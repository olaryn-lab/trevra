import { id, type Db } from '../db.js';
import type { MeetingOrigin, MeetingStatus } from './types.js';

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface RecordMeetingInput {
  workspaceId: string;
  provider: string;
  externalId: string;
  /** Cal.com `rescheduleUid`: the booking this one replaces. */
  previousExternalId: string | null;
  status: MeetingStatus;
  origin: MeetingOrigin;
  startsAt: string | null;
  endsAt: string | null;
  personId: string | null;
  accountId: string | null;
  sourceRecordId: string | null;
}

export interface RecordMeetingResult {
  meetingId: string | null;
  status: MeetingStatus | null;
  personId: string | null;
  accountId: string | null;
  endsAt: string | null;
  created: boolean;
  changed: boolean;
  /** The event names a booking that a later reschedule already replaced. */
  superseded: boolean;
}

interface MeetingRow {
  id: string;
  status: MeetingStatus;
  person_id: string;
  account_id: string | null;
  ends_at: string;
  same_time: boolean;
}

function nothing(): RecordMeetingResult {
  return {
    meetingId: null,
    status: null,
    personId: null,
    accountId: null,
    endsAt: null,
    created: false,
    changed: false,
    superseded: false
  };
}

/**
 * Run `work` in a transaction, or inside the caller's when there already is one.
 * A provider webhook may hand this module a transaction handle; `Db.transaction`
 * refuses to nest, and `getPool()` throwing is the only signal a handle gives.
 */
async function inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  try {
    db.getPool();
  } catch {
    return work(db);
  }
  return db.transaction(work);
}

/** Has this provider id ever been seen, as a meeting or as the booking a reschedule replaced? */
export async function meetingKnown(
  db: Db,
  input: { workspaceId: string; provider: string; externalId: string }
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS known FROM meetings
       WHERE workspace_id=? AND provider=? AND (external_id=? OR previous_external_id=?)
       LIMIT 1`
    )
    .get(input.workspaceId, input.provider, input.externalId, input.externalId);
  return Boolean(row);
}

/**
 * Converge one provider observation onto the `meetings` table.
 *
 * Order-independent by construction, because Cal.com and Nango deliver in any order:
 * - an event for an id that a later reschedule replaced is ignored (`superseded`);
 * - a reschedule cancels the row it replaces, if that row exists yet;
 * - a cancellation sticks against a late "scheduled" observation with the same time;
 * - a different time, or an explicit reschedule, makes the row `rescheduled`.
 */
export async function recordMeeting(
  db: Db,
  input: RecordMeetingInput,
  now: Date = new Date()
): Promise<RecordMeetingResult> {
  if (input.status !== 'cancelled' && (!input.personId || !input.startsAt || !input.endsAt)) {
    throw new Error(
      'A meeting that is not cancelled needs a person, a start time and an end time.'
    );
  }
  const startsAt = input.startsAt ? new Date(input.startsAt).toISOString() : null;
  const endsAt = input.endsAt ? new Date(input.endsAt).toISOString() : null;
  const nowIso = now.toISOString();

  return inTransaction(db, async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`meeting\u001f${input.workspaceId}\u001f${input.provider}`);

    const successor = await tx
      .prepare(
        `SELECT id,status,person_id,account_id,TO_CHAR(ends_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS ends_at
         FROM meetings WHERE workspace_id=? AND provider=? AND previous_external_id=?
         ORDER BY created_at DESC,id ASC LIMIT 1`
      )
      .get<Omit<MeetingRow, 'same_time'>>(input.workspaceId, input.provider, input.externalId);
    if (successor) {
      return {
        meetingId: successor.id,
        status: successor.status,
        personId: successor.person_id,
        accountId: successor.account_id,
        endsAt: successor.ends_at,
        created: false,
        changed: false,
        superseded: true
      };
    }

    if (input.previousExternalId) {
      await tx
        .prepare(
          `UPDATE meetings SET status='cancelled',cancelled_at=?,updated_at=?
           WHERE workspace_id=? AND provider=? AND external_id=? AND status<>'cancelled'`
        )
        .run(nowIso, nowIso, input.workspaceId, input.provider, input.previousExternalId);
    }

    const existing = await tx
      .prepare(
        `SELECT id,status,person_id,account_id,
                TO_CHAR(ends_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS ends_at,
                (starts_at = ?::timestamptz AND ends_at = ?::timestamptz) IS TRUE AS same_time
         FROM meetings WHERE workspace_id=? AND provider=? AND external_id=?
         FOR UPDATE`
      )
      .get<MeetingRow>(startsAt, endsAt, input.workspaceId, input.provider, input.externalId);

    if (existing && input.status === 'cancelled') {
      const result = {
        meetingId: existing.id,
        status: 'cancelled' as const,
        personId: existing.person_id,
        accountId: existing.account_id,
        endsAt: existing.ends_at,
        created: false,
        changed: existing.status !== 'cancelled',
        superseded: false
      };
      if (result.changed) {
        await tx
          .prepare(
            `UPDATE meetings SET status='cancelled',cancelled_at=?,
               source_record_id=COALESCE(?,source_record_id),updated_at=?
             WHERE workspace_id=? AND id=?`
          )
          .run(nowIso, input.sourceRecordId, nowIso, input.workspaceId, existing.id);
      }
      return result;
    }

    if (existing) {
      let status: MeetingStatus;
      if (existing.status === 'cancelled' && existing.same_time && input.status === 'scheduled')
        status = 'cancelled';
      else if (input.status === 'rescheduled' || input.previousExternalId || !existing.same_time)
        status = 'rescheduled';
      else status = existing.status;
      const changed =
        status !== existing.status ||
        !existing.same_time ||
        existing.person_id !== input.personId ||
        existing.account_id !== input.accountId;
      if (changed) {
        await tx
          .prepare(
            `UPDATE meetings SET status=?,starts_at=?,ends_at=?,person_id=?,account_id=?,
               previous_external_id=COALESCE(?,previous_external_id),
               source_record_id=COALESCE(?,source_record_id),
               cancelled_at=CASE WHEN ?::text='cancelled' THEN COALESCE(cancelled_at,?::timestamptz) ELSE NULL END,
               updated_at=?
             WHERE workspace_id=? AND id=?`
          )
          .run(
            status,
            startsAt,
            endsAt,
            input.personId,
            input.accountId,
            input.previousExternalId,
            input.sourceRecordId,
            status,
            nowIso,
            nowIso,
            input.workspaceId,
            existing.id
          );
      }
      return {
        meetingId: existing.id,
        status,
        personId: input.personId,
        accountId: input.accountId,
        endsAt,
        created: false,
        changed,
        superseded: false
      };
    }

    // A cancellation for something never seen can only leave a tombstone when it
    // knows who and when; without both there is nothing truthful to store.
    if (!input.personId || !startsAt || !endsAt) return nothing();

    const meetingId = id('mtg');
    const status: MeetingStatus =
      input.status === 'cancelled'
        ? 'cancelled'
        : input.previousExternalId
          ? 'rescheduled'
          : input.status;
    await tx
      .prepare(
        `INSERT INTO meetings (
           id,workspace_id,provider,external_id,previous_external_id,status,origin,
           starts_at,ends_at,person_id,account_id,source_record_id,cancelled_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        meetingId,
        input.workspaceId,
        input.provider,
        input.externalId,
        input.previousExternalId,
        status,
        input.origin,
        startsAt,
        endsAt,
        input.personId,
        input.accountId,
        input.sourceRecordId,
        status === 'cancelled' ? nowIso : null,
        nowIso,
        nowIso
      );
    return {
      meetingId,
      status,
      personId: input.personId,
      accountId: input.accountId,
      endsAt,
      created: true,
      changed: true,
      superseded: false
    };
  });
}
