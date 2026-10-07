# GTM Phase B — Meetings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make meetings a first-class, evidence-backed fact in Trevra. Google Calendar sync stores meetings instead of dropping them. A signed Cal.com webhook records bookings. A meeting moves the matching Opportunity forward to `meeting`. Sequences can merge a workspace booking link. Today shows upcoming and recently held meetings.

**Architecture:** A new `meetings` table (migration 131) holds one row per provider event or booking id. Each row carries only a time, a status, one matched Person and an optional Account; it stores no title, description or guest list. Both sources write through one canonical `meeting` record kind in `ingestCanonicalRecord` (`src/server/integration-service.ts`):

- Calendar meetings are _observations_: they attach only to a Person who is already in the workspace, and they only raise an Opportunity that already exists.
- Cal.com bookings are _intent_: they may create the Person and an Opportunity.

Stage changes go only through Phase A's `advanceOpportunityStage`. The booking link is a nullable `workspace_settings.booking_url`, and the closed LinkedIn manager merge-field set gains `booking_link`. Rendering that field blank throws, so a sequence that uses it cannot send it empty. Setup lives on the existing `/setup/capture` screen.

**Tech Stack:** TypeScript, Express 5, PostgreSQL 17 (forward-only SQL migrations), zod 3, Vitest with a PostgreSQL Testcontainer, supertest, React and `src/client/ui/primitives.tsx`.

**Spec:** `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md` (Phase B row, Global Constraints, Shared contracts 1, 2 and 5) and `reports/LemonCrow and Beseam GTM needs.md` (gap row 18 "Meetings", the design note at line 84, and P1 row 143).

**Depends on Phase A (must be merged first).** This phase CONSUMES two contracts that Phase A PRODUCES and does not redefine either one:

1. `src/server/opportunity-advance.ts`: `STAGE_RANK` and `advanceOpportunityStage(db, input, now?)`, exactly as in roadmap Shared contract 1.
2. The `provider_webhook_endpoints` table (migration 130), and `src/server/provider-webhooks/` exporting `WebhookProvider`, `ProviderWebhookVerifier`, `ProviderWebhookEndpoint`, `registerProviderVerifier`, `registerProviderWebhookRoutes` and `createProviderWebhookEndpoint`. The route is `POST /api/hooks/v1/:provider/:endpointId`, exactly as in roadmap Shared contract 2.

Task 0 proves that both contracts exist before any code is written.

## Global Constraints

The roadmap's Global Constraints are binding. Repeated here:

- PostgreSQL only. Migrations are forward-only, in `migrations/`. Never add a SQLite path.
- Scope every commercial query by `workspace_id`. A provider connection or webhook endpoint determines the workspace; never take the workspace from payload data.
- Multi-step writes run in one `db.transaction`. Competing work uses `pg_advisory_xact_lock(hashtextextended(...))` or row locks.
- Provider credentials and signing secrets live in Nango or Trevra secret custody (`src/server/secrets/crypto.ts`, gated by `secretsConfigured()`), never as plaintext in tables or source.
- External writes require deterministic idempotency keys and go through the existing prepared-action, approval and execution boundary. This phase adds no external write.
- Webhook redeliveries dedupe through `webhook_events`. Phase A's route does this; this phase supplies a stable `eventId`.
- Analytics and domain-event payloads carry no client content. The `reason` passed to `advanceOpportunityStage` is the fixed string `meeting_booked` or `meeting_on_calendar`.
- Do not rebuild OAuth, token rotation, rate limiting or sync storage. Google Calendar arrives through the existing Nango connection.
- Opportunity stages never move backwards automatically and are never set to `lost` automatically. A cancelled meeting never calls `advanceOpportunityStage`.
- No new navigation section and no new route. Setup goes on `/setup/capture`; attention goes on Today.
- Client UI uses `primitives.tsx` controls and existing classes (`page-panel`, `section-heading`, `capture-*`, `status-pill`, `li-hint`). No inline reusable styles and no new colours.
- Tests use a real PostgreSQL container: `npx tsx scripts/test-with-postgres.ts <test files>`. Run `npm run check` before every commit.
- Deliberate ceilings get an `lc-debt: <ceiling>; <upgrade path>` comment.
- New durable state ships with its writer and its closer:
  - `meetings` rows close through the workspace cascade and the Person cascade.
  - `workspace_settings.booking_url` closes when it is cleared, and through the workspace cascade.

Phase-specific constraints:

- A meeting stores a time, a status, one matched Person, an optional Account and source provenance. It never stores a title, description, location, conference link, or any attendee other than the matched Person, in `meetings` or in `source_records.payload_json`.
- Meetings are not projected into `conversation_messages`. That table's `channel` is `linkedin`/`email` and its `body` is required (migration 103).
- Stage advance uses `advanceOpportunityStage` with `minimumStage: 'meeting'`, `sourceType: 'meeting'`, and `sourceId` set to the `meetings.id`.
- Commit messages are short and end with `Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7`.

## Review Focus

- **Duplicate or out-of-order Cal.com deliveries** (a redelivered create, a reschedule before its create, a create after a cancel) leave one correct meeting state and at most one forward stage move.
  - Task 1, `store.test.ts`: "keeps a cancellation when the original booking arrives late" and "handles a reschedule that arrives before the original booking".
  - Task 4, `calcom.test.ts`: "creates once, reschedules, cancels, and never moves the stage back".
- **The endpoint decides the workspace.** An attendee whose email exists in another workspace never attaches there.
  - Task 4, `calcom.test.ts`: "attaches the attendee only inside the endpoint's workspace".
- **A calendar event stays an observation.** Internal, personal and all-day events create no Person, meeting or source record. Unknown attendees are ignored. Unreadable events are counted as skipped. A calendar event never creates an Opportunity.
  - Task 3, `integration-service.test.ts`: "stores meetings with known people, ignores internal and personal events, and counts unreadable ones".
  - Task 2, `ingest.test.ts`: "a calendar meeting only raises an Opportunity that already exists".
- **`{{booking_link}}` is never sent blank.** Start is refused with 409, the runner blocks a member when the link is removed after start, and the preview warns.
  - Task 5, `runner.test.ts`: "refuses to start, and blocks instead of sending blank, when the booking link is missing".
- **No silent zero.** A Calendar connection that is not connected or reported an error, a Cal.com webhook that never received anything, and a server without `TREVRA_SECRETS_KEY` each show explicit text. Every write is owner-only.
  - Task 6, `api.test.ts`: "says so when the server cannot keep a signing secret" and "reports the Google Calendar connection as it is, including its last error".

---

## Task 0: Phase A pre-flight (no code, no commit)

**Files:** none.

**Interfaces:**

- Consumes: Phase A contracts 1 and 2.
- Produces: confirmation that every name this plan imports exists.

- [ ] **Step 1: Confirm contract 1.**

```bash
grep -n "export const STAGE_RANK\|export async function advanceOpportunityStage" src/server/opportunity-advance.ts
```

Expected: two matching lines. If the file or either export is missing, stop. Phase A has not landed, and nothing below can compile.

- [ ] **Step 2: Confirm contract 2 and where its names live.**

```bash
ls src/server/provider-webhooks/
grep -n "export type WebhookProvider\|export interface ProviderWebhookVerifier\|export interface ProviderWebhookEndpoint\|export type ProviderWebhookEndpoint\|export function registerProviderVerifier\|export function registerProviderWebhookRoutes\|export async function createProviderWebhookEndpoint" src/server/provider-webhooks/*.ts
```

Expected: all six names are exported from `src/server/provider-webhooks/index.ts`, directly or as re-exports. This plan imports them from `'../provider-webhooks/index.js'` (Tasks 2, 4 and 6) and `'./index.js'` (Task 4). If they live in another file of that folder, use that file's path in those imports.

- [ ] **Step 3: Confirm the endpoint shape and table columns used below.**

```bash
grep -n "workspaceId\|  id:" src/server/provider-webhooks/*.ts | head -20
grep -n "id \|workspace_id\|provider\|status\|last_seen_at\|accepted_count\|rejected_count\|created_at\|updated_at" migrations/130_*.sql
```

Expected:

- `ProviderWebhookEndpoint` has `id: string` and `workspaceId: string`.
- Migration 130 declares `last_seen_at`, `created_at` and `updated_at` as `TIMESTAMPTZ`, has `accepted_count`/`rejected_count` integers, and its `provider` CHECK allows `'calcom'`.
- If a column name differs, use the real name in `src/server/meetings/setup.ts` (Task 6).

- [ ] **Step 4: Confirm how verifiers are registered and how `handle` is called.**

```bash
grep -rn "registerProviderVerifier(\|registerProviderWebhookRoutes(" src/server --include=*.ts | grep -v test
grep -n "\.handle(\|transaction" src/server/provider-webhooks/*.ts src/server/opportunity-advance.ts
```

Expected:

- Stripe registers with a module-scope `registerProviderVerifier(...)` call in a module that `app.ts` imports. Task 4 registers Cal.com the same way.
- If Phase A instead registers inside a function, add `registerProviderVerifier(calcomVerifier);` next to the Stripe call there, and drop the module-scope call in Task 4.
- The store in Task 1 works whether `handle` receives the pooled `db` or a transaction handle.

- [ ] **Step 5: Confirm migration 131 is free.**

```bash
ls migrations | tail -3
```

Expected: `130_*.sql` is the newest migration. If 131 is taken, use the next free number and change every `131_meetings.sql` reference below.

---

## Task 1: `meetings` table, booking-link column and meeting store

**Files:**

- Create: `migrations/131_meetings.sql`
- Create: `src/server/meetings/types.ts`
- Create: `src/server/meetings/store.ts`
- Test: `src/server/meetings/store.test.ts`

**Interfaces:**

- Consumes: `id`, `Db` (`src/server/db.ts`); `contacts`, `accounts`, `source_records`, `workspace_settings` tables.
- Produces:
  - table `meetings`;
  - column `workspace_settings.booking_url`;
  - from `types.ts`: `MEETING_STATUSES`, `MeetingStatus`, `MEETING_ORIGINS`, `MeetingOrigin`, `canonicalMeetingSchema`, `CanonicalMeeting`, `activeMeetingSchema`;
  - from `store.ts`: `recordMeeting(db, input, now?)`, `RecordMeetingInput`, `RecordMeetingResult`, `meetingKnown(db, input)`.

- [ ] **Step 1: Write the failing test.**

Create `src/server/meetings/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/store.test.ts`
Expected: FAIL, with `Failed to load url ./store.js` (or `Cannot find module './store.js'`).

- [ ] **Step 3: Write the migration.**

Create `migrations/131_meetings.sql`:

```sql
-- Meetings: a time and one matched Person, from Google Calendar or a Cal.com booking.
--
-- Deliberately narrow. No title, description, location, conference link or guest
-- list is stored here or in the meeting's source record: Today renders the Person
-- and Account names, and source_records.external_url is the way back to the event.
--
-- One row per provider event or booking id. A Cal.com reschedule mints a new uid;
-- the old row is cancelled and the new row names it in previous_external_id, which
-- is also how a late delivery for the old uid is recognised and ignored.
--
-- Closers: the workspace cascade, and the Person cascade below.
-- lc-debt: a meeting's source_records row (which holds the matched email) survives
-- deletion of its Person, exactly as message source rows do today; delete it in the
-- person-erasure path once one exists.

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  previous_external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'rescheduled', 'cancelled')),
  origin TEXT NOT NULL CHECK (origin IN ('calendar', 'booking')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  person_id TEXT NOT NULL,
  account_id TEXT,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (ends_at >= starts_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  UNIQUE (workspace_id, provider, external_id),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_starts
  ON meetings(workspace_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_ends
  ON meetings(workspace_id, ends_at);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_person
  ON meetings(workspace_id, person_id);

CREATE INDEX IF NOT EXISTS idx_meetings_previous_external
  ON meetings(workspace_id, provider, previous_external_id)
  WHERE previous_external_id IS NOT NULL;

-- The workspace booking link merged into outreach as {{booking_link}}. Cleared by
-- setting it to NULL; removed with the workspace.
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS booking_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_settings_booking_url_https') THEN
    ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_booking_url_https
      CHECK (
        booking_url IS NULL
        OR (booking_url ~ '^https://[^[:space:]]+$' AND char_length(booking_url) <= 500)
      );
  END IF;
END $$;
```

- [ ] **Step 4: Write the meeting types.**

Create `src/server/meetings/types.ts`:

```ts
import { z } from 'zod';

export const MEETING_STATUSES = ['scheduled', 'rescheduled', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * `calendar` is an observation (Google Calendar): it attaches only to a Person
 * already in the workspace and only raises an Opportunity that already exists.
 * `booking` is intent (Cal.com): it may create the Person and an Opportunity.
 */
export const MEETING_ORIGINS = ['calendar', 'booking'] as const;
export type MeetingOrigin = (typeof MEETING_ORIGINS)[number];

/**
 * The canonical `meeting` record. A plain object schema because it is a member
 * of `canonicalRecordSchema`'s discriminated union; the "a live meeting needs a
 * person and both times" rule is `activeMeetingSchema`, applied at ingestion.
 * There is no title, description or attendee list on purpose.
 */
export const canonicalMeetingSchema = z.object({
  kind: z.literal('meeting'),
  id: z.string().min(1).max(1024),
  previousId: z.string().min(1).max(1024).optional(),
  accountName: z.string().optional(),
  personName: z.string().optional(),
  personEmail: z.string().email().optional(),
  status: z.enum(MEETING_STATUSES).default('scheduled'),
  origin: z.enum(MEETING_ORIGINS).default('calendar'),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  externalUrl: z.string().url().optional()
});

export type CanonicalMeeting = z.infer<typeof canonicalMeetingSchema>;

export const activeMeetingSchema = z
  .object({
    personEmail: z.string().email(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true })
  })
  .refine((meeting) => Date.parse(meeting.endAt) >= Date.parse(meeting.startAt), {
    message: 'endAt must not be before startAt',
    path: ['endAt']
  });
```

- [ ] **Step 5: Write the store.**

Create `src/server/meetings/store.ts`:

```ts
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
             WHERE id=?`
          )
          .run(nowIso, input.sourceRecordId, nowIso, existing.id);
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
             WHERE id=?`
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
```

- [ ] **Step 6: Run the test to verify it passes.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/store.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit.**

```bash
npm run check
git add migrations/131_meetings.sql src/server/meetings/types.ts src/server/meetings/store.ts src/server/meetings/store.test.ts
git commit -m "feat(meetings): add meetings table and order-safe store" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 2: Canonical `meeting` record kind and the stage advance

**Files:**

- Create: `src/server/meetings/ingest.ts`
- Modify: `src/server/integration-service.ts` (imports; `canonicalRecordSchema`; `ingestCanonicalRecord`; new private `ingestMeeting`)
- Modify: `docs/integration-contracts.md` (Meeting record)
- Test: `src/server/meetings/ingest.test.ts`

**Interfaces:**

- Consumes:
  - `advanceOpportunityStage` (Phase A contract 1);
  - `recordMeeting`, `meetingKnown`, `activeMeetingSchema`, `canonicalMeetingSchema`, `CanonicalMeeting` (Task 1);
  - `normalizeContactEmail` (`src/server/lead-capture/people.ts`) and `accountForPerson` (`src/server/person-identities.ts`).
- Produces:
  - from `ingest.ts`: `findMeetingPerson(db, workspaceId, email)`, `workspaceUserEmails(db, workspaceId)`, `applyMeetingRecord(db, input, now?)`, `MeetingPerson`, `ApplyMeetingInput`, `ApplyMeetingResult`;
  - `IngestOutcome { stored: boolean }`, which `ingestCanonicalRecord` now returns;
  - `CanonicalRecord` now includes `kind: 'meeting'`.

- [ ] **Step 1: Write the failing test.**

Create `src/server/meetings/ingest.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord } from '../integration-service.js';

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
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking)).toEqual({
      stored: true
    });
    expect(await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking)).toEqual({
      stored: true
    });
    expect(await count('contacts')).toBe(1);
    expect(await count('meetings')).toBe(1);
    expect((await opportunities()).map((row) => row.stage)).toEqual(['meeting']);
  });

  it('a booking never moves a later-stage Opportunity backwards', async () => {
    await seedPerson();
    await seedOpportunity('opp_ingest_proposal', 'proposal');
    await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, {
      ...booking,
      personEmail: 'maya@acme.example'
    });
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
    await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, { ...booking, status: 'cancelled' });
    await ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, booking);
    const [meeting] = await db
      .prepare('SELECT status FROM meetings WHERE workspace_id=?')
      .all<{ status: string }>(WORKSPACE);
    expect(meeting.status).toBe('cancelled');
    expect(await opportunities()).toEqual([]);
  });

  it('rejects a live meeting without a person or both times', async () => {
    await expect(
      ingestCanonicalRecord(db, WORKSPACE, 'calcom', null, {
        kind: 'meeting',
        id: 'bk-incomplete',
        personEmail: 'nia@prospect.example',
        status: 'scheduled',
        origin: 'booking'
      })
    ).rejects.toBeInstanceOf(ZodError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/ingest.test.ts`
Expected: FAIL. `ingestCanonicalRecord` rejects `kind: 'meeting'` with a ZodError (`Invalid discriminator value`), and it returns `undefined` rather than `{ stored: true }`.

- [ ] **Step 3: Write `ingest.ts`.**

Create `src/server/meetings/ingest.ts`:

```ts
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

async function openOpportunityBefore(
  db: Db,
  workspaceId: string,
  personId: string,
  accountId: string | null,
  endsAt: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM opportunities
       WHERE workspace_id=? AND stage NOT IN ('won','lost')
         AND (person_id=? OR (?::text IS NOT NULL AND account_id=?::text))
         AND created_at<=?::timestamptz
       LIMIT 1`
    )
    .get(workspaceId, personId, accountId, accountId, endsAt);
  return Boolean(row);
}

/**
 * Record the meeting, then move the Opportunity forward.
 *
 * The advance runs on every application, not only when the row changed:
 * `advanceOpportunityStage` is idempotent per (sourceType, sourceId), so a
 * redelivery after a failed advance completes it instead of losing it.
 * Cancelled and superseded meetings never advance anything.
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
  // A calendar event is evidence about an Opportunity, never the reason one exists,
  // and a meeting from before the Opportunity existed is not evidence about it.
  if (
    record.origin === 'calendar' &&
    !(await openOpportunityBefore(
      db,
      input.workspaceId,
      recorded.personId,
      recorded.accountId,
      recorded.endsAt
    ))
  ) {
    return { ...recorded, stageAdvanced: false };
  }
  const advanced = await advanceOpportunityStage(
    db,
    {
      workspaceId: input.workspaceId,
      personId: recorded.personId,
      accountId: recorded.accountId,
      minimumStage: 'meeting',
      title: `Meeting with ${record.accountName?.trim() || record.personName?.trim() || record.personEmail || 'a contact'}`,
      reason: record.origin === 'booking' ? 'meeting_booked' : 'meeting_on_calendar',
      sourceType: 'meeting',
      sourceId: recorded.meetingId
    },
    now
  );
  return { ...recorded, stageAdvanced: advanced.created || advanced.changed };
}
```

- [ ] **Step 4: Add the record kind and the ingestion branch to `integration-service.ts`.**

4a. After the line `import { projectCanonicalMessage } from './conversations.js';`, add:

```ts
import { applyMeetingRecord, findMeetingPerson } from './meetings/ingest.js';
import { meetingKnown } from './meetings/store.js';
import {
  activeMeetingSchema,
  canonicalMeetingSchema,
  type CanonicalMeeting
} from './meetings/types.js';
```

4b. Replace the closing lines of `canonicalRecordSchema`:

```ts
    externalUrl: z.string().url().optional()
  })
]);
```

(the end of the `opportunity` member) with:

```ts
    externalUrl: z.string().url().optional()
  }),
  canonicalMeetingSchema
]);
```

4c. Replace the head of `ingestCanonicalRecord`, from `export async function ingestCanonicalRecord(` through `const now = new Date().toISOString();`, with:

```ts
/** Whether a canonical record was kept. A calendar meeting with nobody Trevra knows is not. */
export interface IngestOutcome {
  stored: boolean;
}

export async function ingestCanonicalRecord(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  input: CanonicalRecord
): Promise<IngestOutcome> {
  const record = canonicalRecordSchema.parse(input);
  const now = new Date().toISOString();
  if (record.kind === 'meeting')
    return ingestMeeting(db, workspaceId, provider, connectionId, record, now);
```

4d. At the end of `ingestCanonicalRecord`, replace the switch's closing lines:

```ts
      break;
    }
  }
}

export function getNango(): Nango {
```

with:

```ts
      break;
    }
  }
  return { stored: true };
}

/**
 * A meeting is a time and one matched Person.
 *
 * Identity differs by origin. A Cal.com booking resolves (and may create) the
 * Person, because somebody chose to book. A calendar event attaches only to a
 * Person who already exists, so a dentist appointment or a family dinner never
 * becomes a contact. Nothing is written for a meeting that will not be kept, so
 * an ignored event leaves no source record either.
 */
async function ingestMeeting(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  record: CanonicalMeeting,
  now: string
): Promise<IngestOutcome> {
  if (record.status !== 'cancelled') activeMeetingSchema.parse(record);
  const identity = !record.personEmail
    ? { personId: null, accountId: null }
    : record.origin === 'booking'
      ? await resolveCanonicalRecordIdentity(
          db,
          workspaceId,
          provider,
          record.personName,
          record.personEmail,
          now
        )
      : await findMeetingPerson(db, workspaceId, record.personEmail);
  if (record.status !== 'cancelled' && !identity.personId) return { stored: false };
  if (
    record.status === 'cancelled' &&
    !(await meetingKnown(db, { workspaceId, provider, externalId: record.id })) &&
    (!identity.personId || !record.startAt || !record.endAt)
  ) {
    return { stored: false };
  }
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    record.startAt ?? now
  );
  const applied = await applyMeetingRecord(
    db,
    {
      workspaceId,
      provider,
      sourceRecordId: sourceId,
      personId: identity.personId,
      accountId: identity.accountId,
      record
    },
    new Date(now)
  );
  return { stored: applied.meetingId !== null };
}

export function getNango(): Nango {
```

- [ ] **Step 5: Document the record kind.**

In `docs/integration-contracts.md`, insert this block immediately before `## Explicit GTM execution actions`:

````markdown
### Meeting

```json
{
  "kind": "meeting",
  "id": "provider-event-or-booking-id",
  "previousId": "booking-id-this-one-replaces",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "status": "scheduled",
  "origin": "calendar",
  "startAt": "2026-08-20T09:00:00+02:00",
  "endAt": "2026-08-20T09:30:00+02:00",
  "externalUrl": "https://www.google.com/calendar/event?eid=abc"
}
```

A meeting is a time and one matched Person. Trevra never stores its title, description, location, conference link or guest list. `status` is `scheduled`, `rescheduled` or `cancelled`. A meeting that is not cancelled needs `personEmail`, `startAt` and `endAt`, with a UTC offset.

`origin` sets how much the meeting is allowed to do:

- `calendar` is an observation. It attaches only to a Person already in the workspace, and only raises an Opportunity that already existed when the meeting ended.
- `booking` is intent. It may create the Person, and an Opportunity at `meeting`.

Stages only move forward. Cancelling a meeting never lowers one. Meetings are deleted with their Person and with the workspace.
````

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/ingest.test.ts src/server/integration-service.test.ts src/server/conversations.test.ts`
Expected: PASS. The message and opportunity paths are unchanged, so their existing tests still pass.

- [ ] **Step 7: Commit.**

```bash
npm run check
git add src/server/meetings/ingest.ts src/server/meetings/ingest.test.ts src/server/integration-service.ts docs/integration-contracts.md
git commit -m "feat(meetings): canonical meeting record advances the opportunity" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 3: Google Calendar sync stores meetings instead of dropping them

**Files:**

- Create: `src/server/meetings/google-calendar.ts`
- Modify: `src/server/integration-service.ts`:
  - the `google-calendar` catalog entry;
  - `handleNangoWebhook`'s sync branch;
  - `syncNangoRecords` and `NangoSyncResult`;
  - `normalizeNangoRecord`;
  - a new `canonicalKindForModel` and `normalizeSyncedRecord`.
- Modify: `.env.example` (the KNOWN GAP comment)
- Modify: `docs/integration-contracts.md` (Nango sync behaviour)
- Test: `src/server/meetings/google-calendar.test.ts`
- Test: `src/server/integration-service.test.ts` (new `describe`)

**Interfaces:**

- Consumes: `CanonicalMeeting` (Task 1); `workspaceUserEmails` and `ingestCanonicalRecord` returning `IngestOutcome` (Task 2).
- Produces:
  - from `google-calendar.ts`: `nangoRecordDeleted(raw)`, `readCalendarEvent(raw, ownEmails)`, `meetingFromCalendarEvent(db, workspaceId, raw, ownEmails)`, `CalendarCandidate`, `CalendarEventReading`, `CalendarMeetingOutcome`;
  - `NangoSyncResult.ignored`.

Sources for the field names used here:

- Google Calendar Events resource: https://developers.google.com/calendar/api/v3/reference/events (`id`, `status`, `htmlLink`, `start.dateTime|date`, `attendees[].email|displayName|self|resource|responseStatus`).
- Nango record metadata: https://docs.nango.dev/reference/api/sync/records-list (`_nango_metadata.last_action` `'ADDED'|'UPDATED'|'DELETED'`, `deleted_at`).

- [ ] **Step 1: Write the failing unit test.**

Create `src/server/meetings/google-calendar.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { meetingFromCalendarEvent, readCalendarEvent } from './google-calendar.js';

const OWN = new Set(['founder@lemoncrow.example', 'cofounder@lemoncrow.example']);
const WORKSPACE = 'ws_meetings_gcal_test';

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
```

- [ ] **Step 2: Write the failing sync test.**

In `src/server/integration-service.test.ts`, append this `describe` at the end of the file:

```ts
describe('Nango calendar sync', () => {
  it('stores meetings with known people, ignores internal and personal events, and counts unreadable ones', async () => {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';
    const tenant = await seedTenant(database);
    const now = new Date().toISOString();
    const founder = `founder-${tenant.workspaceId}@lemoncrow.example`;
    const teammate = `teammate-${tenant.workspaceId}@lemoncrow.example`;
    for (const [userId, email] of [
      [id('usr'), founder],
      [id('usr'), teammate]
    ]) {
      await database
        .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
        .run(userId, tenant.workspaceId, email, 'Team', now);
    }
    await database
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        id('con'),
        tenant.workspaceId,
        'Maya Patel',
        'maya@acme.example',
        'maya@acme.example',
        now,
        now
      );
    const providerConfigKey = 'trevra-google-calendar';
    const externalConnectionId = `gcal-${id('conn')}`;
    await database
      .prepare(
        'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id('conn'),
        tenant.workspaceId,
        'google-calendar',
        providerConfigKey,
        externalConnectionId,
        null,
        'connected',
        0,
        now,
        now
      );

    const times = {
      start: { dateTime: '2026-11-03T10:00:00+01:00' },
      end: { dateTime: '2026-11-03T10:30:00+01:00' }
    };
    const self = { email: founder, self: true, responseStatus: 'accepted' };
    nangoMock.listRecords.mockResolvedValueOnce({
      records: [
        {
          id: 'evt-known',
          status: 'confirmed',
          summary: 'Acme intro',
          description: 'Agenda nobody should store',
          ...times,
          attendees: [self, { email: 'maya@acme.example', displayName: 'Maya Patel' }],
          _nango_metadata: { last_action: 'ADDED', deleted_at: null }
        },
        { id: 'evt-internal', ...times, attendees: [self, { email: teammate }] },
        {
          id: 'evt-all-day',
          start: { date: '2026-11-04' },
          end: { date: '2026-11-05' },
          attendees: [self]
        },
        { id: 'evt-stranger', ...times, attendees: [self, { email: 'stranger@else.example' }] },
        {
          id: 'graph-1',
          start: { dateTime: '2026-11-03T10:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-03T10:30:00.0000000', timeZone: 'UTC' },
          attendees: [{ emailAddress: { address: 'maya@acme.example' } }]
        }
      ],
      next_cursor: null
    });

    const result = await handleNangoWebhook(
      database,
      JSON.stringify({
        id: `nango_${id('evt')}`,
        type: 'sync',
        success: true,
        providerConfigKey,
        connectionId: externalConnectionId,
        model: 'GoogleCalendarEvent'
      }),
      {}
    );
    expect(result).toEqual({ duplicate: false, processed: 'synced-1-skipped-1-ignored-3' });

    const meetings = await database
      .prepare('SELECT external_id,status,origin FROM meetings WHERE workspace_id=?')
      .all(tenant.workspaceId);
    expect(meetings).toEqual([
      { external_id: 'evt-known', status: 'scheduled', origin: 'calendar' }
    ]);
    const contacts = await database
      .prepare('SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=?')
      .get<{ n: number }>(tenant.workspaceId);
    expect(contacts?.n).toBe(1);
    const sources = await database
      .prepare('SELECT payload_json::text AS payload FROM source_records WHERE workspace_id=?')
      .all<{ payload: string }>(tenant.workspaceId);
    expect(sources).toHaveLength(1);
    expect(sources[0].payload).not.toMatch(/Acme intro|Agenda|stranger|teammate/);
    const connection = await database
      .prepare('SELECT last_error FROM connections WHERE workspace_id=?')
      .get<{ last_error: string | null }>(tenant.workspaceId);
    expect(connection?.last_error).toBe(
      "1 record from 'GoogleCalendarEvent' could not be read and was not stored."
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/google-calendar.test.ts src/server/integration-service.test.ts`
Expected: FAIL. `google-calendar.js` cannot be loaded. The sync test gets `processed: 'synced-0-skipped-5'`, because `GoogleCalendarEvent` has no alias today.

- [ ] **Step 4: Write the calendar normaliser.**

Create `src/server/meetings/google-calendar.ts`:

```ts
import { z } from 'zod';
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
  const cancelled = nangoRecordDeleted(raw) || event.status === 'cancelled';
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
```

- [ ] **Step 5: Wire the sync.**

5a. In `src/server/integration-service.ts`, replace the import added in Task 2:

```ts
import { applyMeetingRecord, findMeetingPerson } from './meetings/ingest.js';
```

with:

```ts
import { meetingFromCalendarEvent, nangoRecordDeleted } from './meetings/google-calendar.js';
import { applyMeetingRecord, findMeetingPerson, workspaceUserEmails } from './meetings/ingest.js';
```

5b. Replace the catalog comment and entry:

```ts
  // Meetings have no canonical record kind, so everything this sync returns is
  // counted and dropped rather than stored (see `syncNangoRecords`). The
  // description says so instead of promising what the connection cannot do.
  {
    key: 'google-calendar',
    provider: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description:
      'Not ready yet — Trevra has nowhere to put meetings, so connecting this brings nothing in.',
```

with:

```ts
  // Events become canonical meetings (src/server/meetings/google-calendar.ts).
  // Only events with someone already in the workspace are kept; internal,
  // personal and all-day events are counted as ignored, unreadable ones as skipped.
  {
    key: 'google-calendar',
    provider: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description:
      'Brings in meetings with people already in Trevra and moves their open Opportunity to Meeting. Internal, personal and all-day events are left out.',
```

5c. In `handleNangoWebhook`'s sync branch, replace:

```ts
const dropped =
  synced.skipped > 0
    ? `${synced.skipped} record${synced.skipped === 1 ? '' : 's'} from '${String(payload.model)}' could not be stored: Trevra has no place to put this kind of record yet.`
    : null;
```

with:

```ts
const dropped =
  synced.skipped > 0
    ? `${synced.skipped} record${synced.skipped === 1 ? '' : 's'} from '${String(payload.model)}' could not be read and ${synced.skipped === 1 ? 'was' : 'were'} not stored.`
    : null;
```

Then replace:

```ts
processed: `synced-${synced.ingested}${synced.skipped > 0 ? `-skipped-${synced.skipped}` : ''}`;
```

with:

```ts
processed: `synced-${synced.ingested}${synced.skipped > 0 ? `-skipped-${synced.skipped}` : ''}${synced.ignored > 0 ? `-ignored-${synced.ignored}` : ''}`;
```

5d. Replace the whole of `syncNangoRecords` and `NangoSyncResult`, from `export async function syncNangoRecords(` through the closing `}` of `export interface NangoSyncResult`, with:

```ts
export async function syncNangoRecords(
  db: Db,
  input: {
    workspaceId: string;
    localConnectionId: string;
    provider: string;
    providerConfigKey: string;
    externalConnectionId: string;
    model: string;
    modifiedAfter?: string;
  }
): Promise<NangoSyncResult> {
  const nango = getNango();
  // Who "we" are in this workspace, so a meeting between colleagues is never
  // read as a meeting with a prospect.
  const ownEmails = await workspaceUserEmails(db, input.workspaceId);
  let cursor: string | null = null;
  let ingested = 0;
  let skipped = 0;
  let ignored = 0;
  do {
    const result: { records: Array<Record<string, unknown>>; next_cursor: string | null } =
      await nango.listRecords<Record<string, unknown>>({
        providerConfigKey: input.providerConfigKey,
        connectionId: input.externalConnectionId,
        model: input.model,
        modifiedAfter: cursor ? undefined : input.modifiedAfter,
        cursor,
        limit: 100
      });
    for (const raw of result.records) {
      const outcome = await normalizeSyncedRecord(
        db,
        input.workspaceId,
        input.model,
        raw as Record<string, unknown>,
        ownEmails
      );
      if (outcome.kind === 'skipped') {
        // COUNTED, NOT SWALLOWED. A record no canonical kind can read -- a model
        // with no alias, or a calendar event in a shape this build does not
        // parse -- is reported on the connection. Dropping it silently made a
        // connection that stores nothing look identical to one with nothing new.
        skipped += 1;
        continue;
      }
      if (outcome.kind === 'ignored') {
        // Read and deliberately left out: internal, personal or all-day events,
        // and meetings with nobody already in the workspace.
        ignored += 1;
        continue;
      }
      const stored = await ingestCanonicalRecord(
        db,
        input.workspaceId,
        input.provider,
        input.localConnectionId,
        outcome.record
      );
      if (stored.stored) ingested += 1;
      else ignored += 1;
    }
    cursor = result.next_cursor;
  } while (cursor);
  return { ingested, skipped, ignored };
}

/**
 * What one sync actually did.
 *
 * Three numbers rather than one, because "nothing arrived", "what arrived was
 * deliberately left out" and "what arrived could not be read" are different
 * facts, and only the last is a problem the operator can act on.
 */
export interface NangoSyncResult {
  ingested: number;
  skipped: number;
  ignored: number;
}
```

5e. Replace the whole of `normalizeNangoRecord`, from `function normalizeNangoRecord(` through its closing `}`, with:

```ts
const MODEL_ALIASES: Record<string, CanonicalRecord['kind']> = {
  trevramessage: 'message',
  trevra_message: 'message',
  messages: 'message',
  trevraopportunity: 'opportunity',
  trevra_opportunity: 'opportunity',
  opportunities: 'opportunity',
  trevrameeting: 'meeting',
  trevrameetings: 'meeting',
  meeting: 'meeting',
  meetings: 'meeting',
  googlecalendarevent: 'meeting',
  calendarevent: 'meeting',
  events: 'meeting'
};

function canonicalKindForModel(model: string): CanonicalRecord['kind'] | null {
  const kind = model.toLowerCase().replaceAll('-', '_');
  return MODEL_ALIASES[kind.replaceAll('_', '')] ?? MODEL_ALIASES[kind] ?? null;
}

function normalizeNangoRecord(model: string, raw: Record<string, unknown>): CanonicalRecord | null {
  const deleted = nangoRecordDeleted(raw);
  const payload = { ...raw } as Record<string, unknown>;
  delete payload._nango_metadata;
  const resolved = payload.kind ? null : canonicalKindForModel(model);
  if (!payload.kind && !resolved) return null;
  const record = canonicalRecordSchema.parse(
    payload.kind ? payload : { ...payload, kind: resolved }
  );
  // A meeting Nango reports as deleted is a cancelled meeting, never a live one.
  return record.kind === 'meeting' && deleted ? { ...record, status: 'cancelled' } : record;
}

type SyncedRecord =
  { kind: 'record'; record: CanonicalRecord } | { kind: 'skipped' } | { kind: 'ignored' };

/**
 * A synced record, read for this workspace.
 *
 * Meeting models that are not already canonical are read as Google Calendar
 * events; everything else takes the canonical alias path unchanged.
 */
async function normalizeSyncedRecord(
  db: Db,
  workspaceId: string,
  model: string,
  raw: Record<string, unknown>,
  ownEmails: ReadonlySet<string>
): Promise<SyncedRecord> {
  if (!raw.kind && canonicalKindForModel(model) === 'meeting') {
    const meeting = await meetingFromCalendarEvent(db, workspaceId, raw, ownEmails);
    if (meeting.ok) return { kind: 'record', record: meeting.record };
    return meeting.reason === 'unrecognized' ? { kind: 'skipped' } : { kind: 'ignored' };
  }
  const normalized = normalizeNangoRecord(model, raw);
  return normalized ? { kind: 'record', record: normalized } : { kind: 'skipped' };
}
```

- [ ] **Step 6: Correct the environment comment.**

In `.env.example`, replace:

```
# Comma-separated Nango sync function names for each provider.
# KNOWN GAP: there is no canonical 'meeting' record kind, so every record a 'trevra-meetings'
# sync returns is counted and dropped rather than stored. The sync now reports the count on the
# connection instead of failing silently; leave these empty unless you are building that kind.
```

with:

```
# Comma-separated Nango sync function names for each provider.
# 'trevra-meetings' on Google Calendar returns Calendar API events; Trevra keeps only meetings
# with people already in the workspace (src/server/meetings/google-calendar.ts). Microsoft 365
# events are not read yet: they are counted as skipped and reported on the connection.
```

- [ ] **Step 7: Correct the sync contract text.**

In `docs/integration-contracts.md`, under `## Nango sync behavior`, replace:

```
1. removes Nango transport metadata;
```

with:

```
1. reads Nango's deletion marker (`_nango_metadata.last_action`/`deleted_at`), then removes Nango transport metadata;
```

Then replace:

```
6. records provider identity evidence and upserts the GTM message or Opportunity-lite state.

Unsupported models are counted as skipped rather than silently treated as a successful empty sync.
```

with:

```
6. records provider identity evidence and upserts the GTM message, Opportunity-lite or meeting state.

Records that cannot be read (an unsupported model, or a calendar event in a shape this build does not parse) are counted as skipped and reported on the connection, rather than silently treated as a successful empty sync. Readable records that Trevra deliberately leaves out are counted as ignored. These are internal, personal and all-day calendar events, and meetings with nobody already in the workspace. Google Calendar events are read in the Calendar API `Event` shape (https://developers.google.com/calendar/api/v3/reference/events). Only the time, the link, and the one attendee who matches an existing Person are kept.
```

- [ ] **Step 8: Run the tests to verify they pass.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/google-calendar.test.ts src/server/integration-service.test.ts src/server/meetings/ingest.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
npm run check
git add src/server/meetings/google-calendar.ts src/server/meetings/google-calendar.test.ts src/server/integration-service.ts src/server/integration-service.test.ts .env.example docs/integration-contracts.md
git commit -m "feat(meetings): Google Calendar sync stores meetings with known people" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 4: Cal.com webhook verifier

**Files:**

- Create: `src/server/provider-webhooks/calcom.ts`
- Modify: `src/server/app.ts` (side-effect import that registers the verifier)
- Modify: `docs/integration-contracts.md` (Cal.com section)
- Test: `src/server/provider-webhooks/calcom.test.ts`

**Interfaces:**

- Consumes:
  - Phase A contract 2: `registerProviderVerifier`, `ProviderWebhookVerifier`, `ProviderWebhookEndpoint`, `createProviderWebhookEndpoint`, route `POST /api/hooks/v1/:provider/:endpointId`;
  - `ingestCanonicalRecord` (Task 2);
  - `workspaceUserEmails` (Task 2).
- Produces: `calcomVerifier: ProviderWebhookVerifier` and `CALCOM_HANDLED_TRIGGERS`. Cal.com is registered once per process.

These facts were checked against the provider's own sources:

- Cal.com signs with header `X-Cal-Signature-256`. The value is `createHmac('sha256', secret).update(body).digest('hex')`, or the literal `no-secret-provided` when the webhook has no secret. Sources: https://cal.com/docs/developing/guides/automation/webhooks and `createWebhookSignature` in https://github.com/calcom/cal.com/blob/main/packages/features/webhooks/lib/sendPayload.ts.
- The default body is `{ triggerEvent, createdAt, payload }`. A custom payload template replaces that body.
- There is no timestamp header and no event-id header.
- `BOOKING_RESCHEDULED` carries the new `uid` and `rescheduleUid`.
- `BOOKING_CANCELLED` carries `status: 'CANCELLED'`.

- [ ] **Step 1: Write the failing test.**

Create `src/server/provider-webhooks/calcom.test.ts`:

```ts
import { createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { calcomVerifier } from './calcom.js';
import { createProviderWebhookEndpoint } from './index.js';

const SECRET = 'calcom-test-signing-secret';
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
      eventId: 'BOOKING_CREATED:bk-1:2026-10-06T08:00:00.000Z',
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
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/calcom.test.ts`
Expected: FAIL, with `Failed to load url ./calcom.js`.

- [ ] **Step 3: Write the verifier.**

Create `src/server/provider-webhooks/calcom.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ingestCanonicalRecord } from '../integration-service.js';
import { workspaceUserEmails } from '../meetings/ingest.js';
import { registerProviderVerifier, type ProviderWebhookVerifier } from './index.js';

/**
 * Cal.com booking webhooks.
 *
 * Signature: `X-Cal-Signature-256` is the hex HMAC-SHA256 of the raw body keyed
 * with the webhook's secret, or the literal `no-secret-provided` when the webhook
 * has no secret (https://cal.com/docs/developing/guides/automation/webhooks;
 * `createWebhookSignature` in
 * https://github.com/calcom/cal.com/blob/main/packages/features/webhooks/lib/sendPayload.ts).
 * Body: `{ triggerEvent, createdAt, payload }`. A custom payload template
 * replaces that body, so it is refused rather than guessed at.
 *
 * NO TIMESTAMP HEADER EXISTS, so there is no freshness window. A replayed body
 * dedupes on its event id in `webhook_events`, and a replayed booking state is a
 * no-op in `recordMeeting`.
 */

export const CALCOM_HANDLED_TRIGGERS = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED'
] as const;

const envelopeSchema = z.object({
  triggerEvent: z.string().min(1),
  createdAt: z.string().optional(),
  payload: z.record(z.unknown()).optional()
});

const bookingSchema = z.object({
  uid: z.string().min(1).max(1024),
  rescheduleUid: z.string().min(1).max(1024).nullish(),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  organizer: z.object({ email: z.string().optional() }).optional(),
  attendees: z
    .array(z.object({ email: z.string().optional(), name: z.string().optional() }))
    .default([])
});

const emailSchema = z.string().email();

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const found =
    headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const value = Array.isArray(found) ? found[0] : found;
  return (value ?? '').trim();
}

export const calcomVerifier: ProviderWebhookVerifier = {
  provider: 'calcom',

  verify(rawBody, headers, secret) {
    const signature = header(headers, 'x-cal-signature-256');
    if (!signature || signature === 'no-secret-provided') {
      return {
        ok: false,
        status: 401,
        error:
          'Cal.com sent this webhook without a signature. Paste the signing secret Trevra showed you into the Secret field of the Cal.com webhook.'
      };
    }
    if (!/^[0-9a-f]{64}$/i.test(signature)) {
      return {
        ok: false,
        status: 401,
        error: 'The Cal.com signature is not a SHA-256 hex digest.'
      };
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
      return {
        ok: false,
        status: 401,
        error: "The Cal.com signature does not match this endpoint's signing secret."
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'Cal.com sent a body that is not JSON.' };
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      return {
        ok: false,
        status: 400,
        error:
          'Cal.com sent a body without triggerEvent. Clear the custom payload template on this Cal.com webhook so Trevra receives the default body.'
      };
    }
    const payload = envelope.data.payload ?? {};
    const uid = typeof payload.uid === 'string' ? payload.uid : 'none';
    return {
      ok: true,
      eventId: `${envelope.data.triggerEvent}:${uid}:${envelope.data.createdAt ?? ''}`,
      eventType: envelope.data.triggerEvent,
      payload
    };
  },

  async handle(db, endpoint, event) {
    if (!(CALCOM_HANDLED_TRIGGERS as readonly string[]).includes(event.eventType)) {
      return { handled: false };
    }
    const booking = bookingSchema.parse(event.payload);
    const organizer = booking.organizer?.email?.trim().toLowerCase() ?? '';
    const own = await workspaceUserEmails(db, endpoint.workspaceId);
    // Cal.com lists the booker first; skip the host and anyone who is "us".
    const attendee = booking.attendees.find((candidate) => {
      const email = candidate.email?.trim().toLowerCase() ?? '';
      return (
        email !== '' &&
        email !== organizer &&
        !own.has(email) &&
        emailSchema.safeParse(email).success
      );
    });
    if (!attendee?.email) return { handled: false };
    const rescheduled = event.eventType === 'BOOKING_RESCHEDULED';
    const outcome = await ingestCanonicalRecord(db, endpoint.workspaceId, 'calcom', null, {
      kind: 'meeting',
      id: booking.uid,
      ...(rescheduled && booking.rescheduleUid ? { previousId: booking.rescheduleUid } : {}),
      personEmail: attendee.email.trim().toLowerCase(),
      ...(attendee.name?.trim() ? { personName: attendee.name.trim() } : {}),
      status:
        event.eventType === 'BOOKING_CANCELLED'
          ? 'cancelled'
          : rescheduled
            ? 'rescheduled'
            : 'scheduled',
      origin: 'booking',
      startAt: booking.startTime,
      endAt: booking.endTime
    });
    return { handled: outcome.stored };
  }
};

// Registered once per process: `app.ts` imports this module for this side effect.
registerProviderVerifier(calcomVerifier);
```

- [ ] **Step 4: Register it.**

In `src/server/app.ts`, after the line `import { persistImportedPeople } from './lead-capture/import.js';`, add:

```ts
// Side effect: registers the Cal.com verifier with the provider webhook route.
import './provider-webhooks/calcom.js';
```

- [ ] **Step 5: Document it.**

In `docs/integration-contracts.md`, insert this block immediately before `## CRM integrations`:

```markdown
## Cal.com booking webhooks

An owner creates a Cal.com endpoint on `/setup/capture`. Trevra shows the subscriber URL (`/api/hooks/v1/calcom/<endpoint id>`) and a signing secret, once. The endpoint, not the payload, decides the workspace.

- Signature: `X-Cal-Signature-256` is the hex HMAC-SHA256 of the raw body. The literal `no-secret-provided` is refused with 401.
- Body: the default `{ triggerEvent, createdAt, payload }`. A custom payload template is refused with 400.
- Event id: `<triggerEvent>:<payload.uid>:<createdAt>`, which dedupes redeliveries in `webhook_events`.
- Handled triggers:
  - `BOOKING_CREATED` becomes `scheduled`.
  - `BOOKING_RESCHEDULED` becomes `rescheduled`, with `previousId` set from `rescheduleUid`; the replaced booking is cancelled.
  - `BOOKING_CANCELLED` becomes `cancelled`.
- Every other trigger, `PING` included, is accepted and ignored.
- The attendee is the first one who is not the organizer and not a workspace user. The booking's title, description, notes and other guests are not stored.
```

- [ ] **Step 6: Run the test to verify it passes.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/calcom.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit.**

```bash
npm run check
git add src/server/provider-webhooks/calcom.ts src/server/provider-webhooks/calcom.test.ts src/server/app.ts docs/integration-contracts.md
git commit -m "feat(meetings): verify Cal.com booking webhooks" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 5: Booking link setting and the `{{booking_link}}` merge field

**Files:**

- Create: `src/server/meetings/booking-link.ts`
- Modify: `src/server/linkedin/workflows.ts`
- Modify: `src/server/linkedin/runner.ts`
- Modify: `src/server/linkedin/managed-campaigns.ts`
- Modify: `src/client/LinkedInManagerWorkflowConfig.tsx`
- Test: `src/server/meetings/booking-link.test.ts`
- Test: `src/server/linkedin/workflows.test.ts`
- Test: `src/server/linkedin/runner.test.ts`

**Interfaces:**

- Consumes: `workspace_settings.booking_url` (Task 1); `LinkedInApiError` (`src/server/linkedin/errors.ts`).
- Produces:
  - from `booking-link.ts`: `normalizeBookingUrl(value)`, `getBookingUrl(db, workspaceId)`, `setBookingUrl(db, workspaceId, value, now?)`, `BookingUrlError`, `BOOKING_URL_MAX_LENGTH`;
  - from `workflows.ts`: `'booking_link'` in `MANAGER_VARIABLES`, `WorkflowMergeLead.bookingLink`, `BOOKING_LINK_MISSING_MESSAGE`, `BOOKING_LINK_PREVIEW_PLACEHOLDER`, `BookingLinkMissingError` (a `LinkedInApiError` with status 409), `stepUsesBookingLink(step)`, `workflowUsesBookingLink(steps)`;
  - the new `WorkflowDiagnostic` code `'missing_booking_link'`.

- [ ] **Step 1: Write the failing tests.**

1a. Create `src/server/meetings/booking-link.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  BookingUrlError,
  getBookingUrl,
  normalizeBookingUrl,
  setBookingUrl
} from './booking-link.js';

const WORKSPACE = 'ws_booking_link_test';

describe('normalizeBookingUrl', () => {
  it('trims an https link and treats blank as no link', () => {
    expect(normalizeBookingUrl('  https://cal.com/founder/intro ')).toBe(
      'https://cal.com/founder/intro'
    );
    expect(normalizeBookingUrl('   ')).toBeNull();
    expect(normalizeBookingUrl(null)).toBeNull();
  });

  it('refuses http, credentials, whitespace and overlong links', () => {
    for (const value of [
      'http://cal.com/founder',
      'cal.com/founder',
      'https://user:pass@cal.com/founder',
      'https://cal.com/a b',
      `https://cal.com/${'x'.repeat(500)}`
    ]) {
      expect(() => normalizeBookingUrl(value)).toThrow(BookingUrlError);
    }
  });
});

describe('booking link storage', () => {
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE, 'Booking link', '2026-08-01T00:00:00.000Z');
  });

  afterEach(async () => {
    if (db) await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db?.close();
  });

  it('creates the settings row when missing, and clears the link', async () => {
    expect(await getBookingUrl(db, WORKSPACE)).toBeNull();
    expect(await setBookingUrl(db, WORKSPACE, 'https://cal.com/founder/intro')).toBe(
      'https://cal.com/founder/intro'
    );
    expect(await getBookingUrl(db, WORKSPACE)).toBe('https://cal.com/founder/intro');
    expect(await setBookingUrl(db, WORKSPACE, '')).toBeNull();
    expect(await getBookingUrl(db, WORKSPACE)).toBeNull();
  });
});
```

1b. In `src/server/linkedin/workflows.test.ts`, replace the import block at the top:

```ts
import {
  MESSAGE_VARIANT_MAX,
  chooseMessageVariant,
  delayMilliseconds,
  diagnoseWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  unsupportedVariables,
  workflowStepsSchema
} from './workflows.js';
```

with:

```ts
import {
  BOOKING_LINK_MISSING_MESSAGE,
  BookingLinkMissingError,
  MESSAGE_VARIANT_MAX,
  chooseMessageVariant,
  delayMilliseconds,
  diagnoseWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  stepUsesBookingLink,
  unsupportedVariables,
  workflowStepsSchema,
  workflowUsesBookingLink
} from './workflows.js';
```

Then append at the end of the file:

```ts
describe('booking link merge field', () => {
  const lead = { firstName: 'Maya', lastName: 'Smith', company: 'Acme' };

  it('renders the workspace booking link', () => {
    expect(
      renderWorkflowTemplate('Pick a time: {{booking_link}}', {
        ...lead,
        bookingLink: 'https://cal.com/founder/intro'
      })
    ).toBe('Pick a time: https://cal.com/founder/intro');
  });

  it('refuses to render it blank', () => {
    expect(() =>
      renderWorkflowTemplate('Pick a time: {{booking_link}}', { ...lead, bookingLink: '  ' })
    ).toThrow(BookingLinkMissingError);
    expect(() => renderWorkflowTemplate('Pick a time: {{booking_link}}', lead)).toThrow(
      BOOKING_LINK_MISSING_MESSAGE
    );
    // A template that does not use it still renders without a link.
    expect(renderWorkflowTemplate('Hi {{first_name}}', lead)).toBe('Hi Maya');
  });

  it('is accepted at save time and reports which steps use it', () => {
    expect(unsupportedVariables('Pick a time: {{booking_link}}')).toEqual([]);
    const steps = workflowStepsSchema.parse([
      { id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} },
      {
        id: 'ask',
        action: 'manual_message',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { suggestedTemplate: 'Pick a time: {{ booking_link }}' }
      }
    ]);
    expect(workflowUsesBookingLink(steps)).toBe(true);
    expect(steps.filter(stepUsesBookingLink).map((step) => step.id)).toEqual(['ask']);
  });
});
```

1c. In `src/server/linkedin/runner.test.ts`, replace:

```ts
import { getWorkflow, saveWorkflow } from './workflows.js';
```

with:

```ts
import { BOOKING_LINK_MISSING_MESSAGE, getWorkflow, saveWorkflow } from './workflows.js';
import { setBookingUrl } from '../meetings/booking-link.js';
```

Then, directly after the test `it('preserves manual comment task type and post destination', ...)` (it ends with `suggestedBody: 'Thoughtful note for Maya'` followed by `});` and `});`), insert:

```ts
it('merges the workspace booking link into a manual task', async () => {
  await setBookingUrl(db, WORKSPACE, 'https://cal.com/founder/intro', NOW);
  try {
    const listId = await seededList('Booking link', [
      { first: 'Maya', last: 'Book', company: 'Acme', slug: 'maya-book' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Booking link task',
          steps: [
            {
              id: 'invite-call',
              action: 'manual_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { suggestedTemplate: 'Hi {{first_name}}, grab a slot: {{booking_link}}' }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Booking link');
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).manualTasksCreated).toBe(1);
    const task = (await listManualTasks(db, WORKSPACE)).find(
      (row) => row.campaignId === campaignId
    );
    expect(task?.suggestedBody).toBe('Hi Maya, grab a slot: https://cal.com/founder/intro');
  } finally {
    await setBookingUrl(db, WORKSPACE, null, NOW);
  }
});

it('refuses to start, and blocks instead of sending blank, when the booking link is missing', async () => {
  await setBookingUrl(db, WORKSPACE, null, NOW);
  const listId = await seededList('Booking link missing', [
    { first: 'Lea', last: 'Book', company: 'Acme', slug: 'lea-book' }
  ]);
  const workflowId = (
    await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Booking link missing',
        steps: [
          {
            id: 'invite-call',
            action: 'manual_message',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { suggestedTemplate: 'Hi {{first_name}}, grab a slot: {{booking_link}}' }
          }
        ]
      },
      NOW
    )
  ).id;
  const made = await createManagedCampaign(
    db,
    { workspaceId: WORKSPACE, name: 'Booking link missing', leadListId: listId, workflowId },
    NOW
  );
  await expect(startManagedCampaign(db, WORKSPACE, made.campaign.id, NOW)).rejects.toThrow(
    BOOKING_LINK_MISSING_MESSAGE
  );
  expect(await campaignStatus(made.campaign.id)).not.toBe('running');

  await setBookingUrl(db, WORKSPACE, 'https://cal.com/founder/intro', NOW);
  await startManagedCampaign(db, WORKSPACE, made.campaign.id, NOW);
  // Removed after the campaign started: the runner must hold, not send blank.
  await setBookingUrl(db, WORKSPACE, null, NOW);

  const tick = await runManagedCampaigns(db, WORKSPACE, NOW);
  expect(tick.manualTasksCreated).toBe(0);
  expect(tick.membersBlocked).toBe(1);
  const blocked = await db
    .prepare(
      `SELECT status,branch_state_json->'blocked:invite-call'->>'reason' AS reason
         FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?`
    )
    .all<{ status: string; reason: string | null }>(WORKSPACE, made.campaign.id);
  expect(blocked).toEqual([{ status: 'waiting', reason: BOOKING_LINK_MISSING_MESSAGE }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/booking-link.test.ts src/server/linkedin/workflows.test.ts src/server/linkedin/runner.test.ts`
Expected: FAIL. `booking-link.js` cannot be loaded, and `BOOKING_LINK_MISSING_MESSAGE` is not exported by `./workflows.js`.

- [ ] **Step 3: Write the setting.**

Create `src/server/meetings/booking-link.ts`:

```ts
import type { Db } from '../db.js';

export const BOOKING_URL_MAX_LENGTH = 500;

export class BookingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingUrlError';
  }
}

const NOT_HTTPS =
  'The booking link must be a full https:// address, for example https://cal.com/you/intro.';

/** The operator's exact link, trimmed; blank means "no link". */
export function normalizeBookingUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length > BOOKING_URL_MAX_LENGTH) {
    throw new BookingUrlError(
      `The booking link must be ${BOOKING_URL_MAX_LENGTH} characters or fewer.`
    );
  }
  if (/\s/.test(trimmed)) throw new BookingUrlError(NOT_HTTPS);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BookingUrlError(NOT_HTTPS);
  }
  if (url.protocol !== 'https:' || !url.hostname) throw new BookingUrlError(NOT_HTTPS);
  if (url.username || url.password) {
    throw new BookingUrlError('The booking link must not contain a username or password.');
  }
  return trimmed;
}

export async function getBookingUrl(db: Db, workspaceId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT booking_url FROM workspace_settings WHERE workspace_id=?')
    .get<{ booking_url: string | null }>(workspaceId);
  return row?.booking_url ?? null;
}

/** Upsert: an older workspace may have no settings row; every other column has a default. */
export async function setBookingUrl(
  db: Db,
  workspaceId: string,
  value: string | null,
  now: Date = new Date()
): Promise<string | null> {
  const bookingUrl = normalizeBookingUrl(value);
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id,booking_url,created_at,updated_at) VALUES (?,?,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET booking_url=excluded.booking_url,updated_at=excluded.updated_at`
    )
    .run(workspaceId, bookingUrl, at, at);
  return bookingUrl;
}
```

- [ ] **Step 4: Add the merge field to `workflows.ts`.**

4a. After `import type { LinkedInActionKind } from './actions.js';`, add:

```ts
import { LinkedInApiError } from './errors.js';
```

4b. Replace:

```ts
export const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country'
] as const;
```

with:

```ts
export const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country',
  // Workspace-level, not a contact column: `workspace_settings.booking_url`.
  // Rendering it blank throws (`BookingLinkMissingError`) instead of sending a gap.
  'booking_link'
] as const;
```

4c. Replace the `WorkflowDiagnostic` code union:

```ts
    | 'missing_invite_cleanup'
    | 'missing_variable_coverage';
```

with:

```ts
    | 'missing_invite_cleanup'
    | 'missing_variable_coverage'
    | 'missing_booking_link';
```

4d. Directly after the closing `}` of `export function unsupportedVariables(`, add:

```ts
/** What a refused start, a blocked member and the launch preview tell the operator. */
export const BOOKING_LINK_MISSING_MESSAGE =
  'This sequence uses {{booking_link}}, but this workspace has no booking link yet. Add one under Setup → Lead capture → Meetings, then try again.';

/** What a launch preview shows in place of a link that is not set. Never sent. */
export const BOOKING_LINK_PREVIEW_PLACEHOLDER = '[booking link not set]';

/**
 * A template asked for the booking link and the workspace has none.
 * A LinkedInApiError, so the manager routes already answer 409 with the message.
 */
export class BookingLinkMissingError extends LinkedInApiError {
  constructor() {
    super(BOOKING_LINK_MISSING_MESSAGE, 409);
    this.name = 'BookingLinkMissingError';
  }
}

export function stepUsesBookingLink(step: WorkflowStep): boolean {
  return templatesOf(step).some((template) =>
    [...template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g)].some(
      (match) => resolveManagerVariable(match[1]) === 'booking_link'
    )
  );
}

export function workflowUsesBookingLink(steps: readonly WorkflowStep[]): boolean {
  return steps.some(stepUsesBookingLink);
}
```

4e. In `export interface WorkflowMergeLead`, after `country?: string | null;`, add:

```ts
  /** The workspace booking link (`workspace_settings.booking_url`), shared by every lead. */
  bookingLink?: string | null;
```

4f. In `renderWorkflowTemplate`, replace:

```ts
    country: lead.country ?? ''
  };
```

with:

```ts
    country: lead.country ?? '',
    booking_link: lead.bookingLink?.trim() ?? ''
  };
```

Then replace:

```ts
const canonical = resolveManagerVariable(name);
// Saved workflows reject unknown tokens; fail closed here too rather than sending raw {{tokens}}.
return canonical === null ? '' : values[canonical];
```

with:

```ts
const canonical = resolveManagerVariable(name);
// A blank booking link is the one field that must never render as a gap:
// "grab a slot: " with nothing after it is worse than not sending.
if (canonical === 'booking_link' && !values.booking_link) throw new BookingLinkMissingError();
// Saved workflows reject unknown tokens; fail closed here too rather than sending raw {{tokens}}.
return canonical === null ? '' : values[canonical];
```

- [ ] **Step 5: Make the runner hold instead of sending blank.**

5a. In `src/server/linkedin/runner.ts`, replace:

```ts
import {
  chooseMessageVariant,
  delayMilliseconds,
  getWorkflow,
  renderWorkflowTemplate,
  type WorkflowStep
} from './workflows.js';
```

with:

```ts
import {
  BOOKING_LINK_MISSING_MESSAGE,
  chooseMessageVariant,
  delayMilliseconds,
  getWorkflow,
  renderWorkflowTemplate,
  stepUsesBookingLink,
  type WorkflowStep
} from './workflows.js';
import { getBookingUrl } from '../meetings/booking-link.js';
```

5b. In `planManagedCampaigns`, replace:

```ts
    .all<CampaignRow>(workspaceId);
  if (campaigns.length === 0) return result;
```

with:

```ts
    .all<CampaignRow>(workspaceId);
  if (campaigns.length === 0) return result;
  // Read once per tick: every member of every campaign in this workspace shares it.
  const bookingLink = await getBookingUrl(db, workspaceId);
```

5c. In the member loop, replace:

```ts
          country: member.country,
          customFields: parseJsonObject(member.custom_fields_json) as Record<
```

with:

```ts
          country: member.country,
          bookingLink,
          customFields: parseJsonObject(member.custom_fields_json) as Record<
```

5d. Immediately before the line `        if (step.action === 'wait') {` (the first statement after the `hasReply` block), insert:

```ts
// The link was removed after start (start itself refuses without one).
// Hold the member and say why; never render the step with a blank link.
if (!bookingLink && stepUsesBookingLink(step)) {
  memberWrites.set(
    member.id,
    stayOnStep(
      stepIndex,
      step.id,
      completedStepIds,
      new Date(now.getTime() + 3_600_000),
      now,
      branchStatePatch(`blocked:${step.id}`, {
        reason: BOOKING_LINK_MISSING_MESSAGE,
        at: nowIso
      })
    )
  );
  result.membersBlocked += 1;
  continue;
}
```

- [ ] **Step 6: Refuse the start and warn in the preview.**

6a. In `src/server/linkedin/managed-campaigns.ts`, replace:

```ts
import {
  delayMilliseconds,
  diagnoseWorkflow,
  getWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  workflowMergeVariables,
  workflowStepsSchema,
  type WorkflowDiagnostic,
  type WorkflowMergeLead,
  type WorkflowStep,
  type WorkflowVariableCoverage
} from './workflows.js';
```

with:

```ts
import {
  BOOKING_LINK_MISSING_MESSAGE,
  BOOKING_LINK_PREVIEW_PLACEHOLDER,
  BookingLinkMissingError,
  delayMilliseconds,
  diagnoseWorkflow,
  getWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  stepUsesBookingLink,
  workflowMergeVariables,
  workflowStepsSchema,
  workflowUsesBookingLink,
  type WorkflowDiagnostic,
  type WorkflowMergeLead,
  type WorkflowStep,
  type WorkflowVariableCoverage
} from './workflows.js';
import { getBookingUrl } from '../meetings/booking-link.js';
```

6b. In `startManagedCampaign`, replace:

```ts
const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
if (!workflow) throw new Error('Campaign workflow no longer exists.');
const timestamp = now.toISOString();
```

with:

```ts
const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
if (!workflow) throw new Error('Campaign workflow no longer exists.');
// Refuse before anything moves. The runner re-checks per member, because the
// link can be removed after this point.
if (workflowUsesBookingLink(workflow.steps) && !(await getBookingUrl(db, workspaceId))) {
  throw new BookingLinkMissingError();
}
const timestamp = now.toISOString();
```

6c. In `previewManagedCampaignLaunch`, replace:

```ts
const diagnostics = diagnoseWorkflow(workflow.steps, variableCoverage);
```

with:

```ts
const diagnostics = diagnoseWorkflow(workflow.steps, variableCoverage);
const bookingLink = await getBookingUrl(db, input.workspaceId);
if (!bookingLink && workflowUsesBookingLink(workflow.steps)) {
  diagnostics.push({
    code: 'missing_booking_link',
    severity: 'warning',
    message: BOOKING_LINK_MISSING_MESSAGE,
    stepIds: workflow.steps.filter(stepUsesBookingLink).map((step) => step.id)
  });
}
```

Then, in the same function, replace:

```ts
      country: row.country,
      customFields: parseJsonObject(row.custom_fields_json) as Record<
```

with:

```ts
      country: row.country,
      bookingLink: bookingLink ?? BOOKING_LINK_PREVIEW_PLACEHOLDER,
      customFields: parseJsonObject(row.custom_fields_json) as Record<
```

- [ ] **Step 7: Mirror the variable in the workflow builder.**

In `src/client/LinkedInManagerWorkflowConfig.tsx`, replace:

```ts
const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country'
] as const;
```

with:

```ts
const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country',
  'booking_link'
] as const;
```

Then replace:

```ts
  country: 'United Kingdom'
};
```

with:

```ts
  country: 'United Kingdom',
  booking_link: 'https://cal.com/you/intro'
};
```

- [ ] **Step 8: Run the tests to verify they pass.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/booking-link.test.ts src/server/linkedin/workflows.test.ts src/server/linkedin/runner.test.ts`
Expected: PASS. This includes the existing runner suite, which has no `{{booking_link}}` and therefore never reads the link.

- [ ] **Step 9: Commit.**

```bash
npm run check
git add src/server/meetings/booking-link.ts src/server/meetings/booking-link.test.ts src/server/linkedin/workflows.ts src/server/linkedin/workflows.test.ts src/server/linkedin/runner.ts src/server/linkedin/runner.test.ts src/server/linkedin/managed-campaigns.ts src/client/LinkedInManagerWorkflowConfig.tsx
git commit -m "feat(meetings): booking link merge field that never sends blank" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 6: Owner-only meetings setup on `/setup/capture`

**Files:**

- Create: `src/server/meetings/setup.ts`
- Modify: `src/server/app.ts` (four routes)
- Modify: `src/client/api.ts` (types and four calls)
- Create: `src/client/MeetingsSetup.tsx`
- Modify: `src/client/App.tsx` (render on the capture tab)
- Test: `src/server/meetings/api.test.ts`

**Interfaces:**

- Consumes:
  - `createProviderWebhookEndpoint` and the `provider_webhook_endpoints` columns (Phase A contract 2);
  - `getBookingUrl`, `setBookingUrl`, `BookingUrlError` (Task 5);
  - `secretsConfigured` (`src/server/secrets/crypto.ts`);
  - the `connections` table.
- Produces:
  - from `setup.ts`: `readMeetingsSetup`, `listCalcomEndpoints`, `createCalcomEndpoint`, `setCalcomEndpointStatus`, `calcomEndpointPath`, `CALCOM_SECRETS_MISSING`, `MeetingsSetup`, `CalcomEndpointSummary`;
  - routes:
    - `GET /api/setup/meetings` (workspace-visible);
    - `PUT /api/setup/meetings/booking-link` (owner);
    - `POST /api/setup/meetings/calcom` (owner);
    - `PATCH /api/setup/meetings/calcom/:id/status` (owner);
  - client: `getMeetingsSetup`, `saveBookingLink`, `createCalcomWebhook`, `setCalcomWebhookStatus`, `MeetingsSetupState`, `CalcomWebhookSummary`, and the `MeetingsSetup` component.

- [ ] **Step 1: Write the failing test.**

Create `src/server/meetings/api.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let signUpSeq = 0;
const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@meetings-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'meetings-api-pass-1', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('meetings-owner');
  const member = await signUp('meetings-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  return { owner, member };
}

beforeAll(async () => {
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  await db?.close();
  await closeAuthDatabase();
});

describe('meetings setup API', () => {
  it('requires a session and keeps every write owner-only', async () => {
    await request(app).get('/api/setup/meetings').expect(401);
    const { owner, member } = await ownerAndMember();
    await member.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: 'https://cal.com/member/intro' })
      .expect(403);
    await member.agent.post('/api/setup/meetings/calcom').send({}).expect(403);
    const initial = await owner.agent.get('/api/setup/meetings').expect(200);
    expect(initial.body).toEqual({
      bookingUrl: null,
      secretsConfigured: true,
      googleCalendar: { connected: false, status: null, lastSyncedAt: null, lastError: null },
      calcom: []
    });
  });

  it('stores an https booking link, refuses anything else, and clears it', async () => {
    const { owner, member } = await ownerAndMember();
    const refused = await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: 'http://cal.com/founder/intro' })
      .expect(400);
    expect(refused.body.error).toMatch(/https:\/\//);
    await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: '  https://cal.com/founder/intro ' })
      .expect(200, { bookingUrl: 'https://cal.com/founder/intro' });
    expect((await member.agent.get('/api/setup/meetings').expect(200)).body.bookingUrl).toBe(
      'https://cal.com/founder/intro'
    );
    await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: null })
      .expect(200, { bookingUrl: null });
  });

  it('mints a Cal.com endpoint, shows the secret only at creation, and can disable it', async () => {
    const { owner } = await ownerAndMember();
    const created = await owner.agent.post('/api/setup/meetings/calcom').send({}).expect(201);
    expect(created.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.endpoint).toMatchObject({
      status: 'active',
      path: `/api/hooks/v1/calcom/${created.body.endpoint.id}`,
      lastSeenAt: null,
      acceptedCount: 0,
      rejectedCount: 0
    });
    const listed = await owner.agent.get('/api/setup/meetings').expect(200);
    expect(listed.body.calcom).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    const disabled = await owner.agent
      .patch(`/api/setup/meetings/calcom/${created.body.endpoint.id}/status`)
      .send({ status: 'disabled' })
      .expect(200);
    expect(disabled.body.endpoint.status).toBe('disabled');
    await owner.agent
      .patch('/api/setup/meetings/calcom/pwe_missing/status')
      .send({ status: 'disabled' })
      .expect(404);
  });

  it('says so when the server cannot keep a signing secret', async () => {
    const { owner } = await ownerAndMember();
    const key = process.env.TREVRA_SECRETS_KEY;
    delete process.env.TREVRA_SECRETS_KEY;
    try {
      const refused = await owner.agent.post('/api/setup/meetings/calcom').send({}).expect(409);
      expect(refused.body.error).toMatch(/TREVRA_SECRETS_KEY/);
      expect(
        (await owner.agent.get('/api/setup/meetings').expect(200)).body.secretsConfigured
      ).toBe(false);
    } finally {
      process.env.TREVRA_SECRETS_KEY = key;
    }
  });

  it('reports the Google Calendar connection as it is, including its last error', async () => {
    const { owner } = await ownerAndMember();
    const workspaceId = owner.auth.workspaceId;
    const now = new Date().toISOString();
    const lastError = "1 record from 'GoogleCalendarEvent' could not be read and was not stored.";
    await db
      .prepare(
        'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        `conn_gcal_${workspaceId}`,
        workspaceId,
        'google-calendar',
        'trevra-google-calendar',
        `gcal-${workspaceId}`,
        'Founder calendar',
        'connected',
        0,
        now,
        lastError,
        now,
        now
      );
    const body = (await owner.agent.get('/api/setup/meetings').expect(200)).body;
    expect(body.googleCalendar).toEqual({
      connected: true,
      status: 'connected',
      lastSyncedAt: now,
      lastError
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/api.test.ts`
Expected: FAIL. `GET /api/setup/meetings` answers 404 `API route not found`.

- [ ] **Step 3: Write the setup module.**

Create `src/server/meetings/setup.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { createProviderWebhookEndpoint } from '../provider-webhooks/index.js';
import { secretsConfigured } from '../secrets/crypto.js';
import { getBookingUrl } from './booking-link.js';

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export const CALCOM_SECRETS_MISSING =
  'This server has no TREVRA_SECRETS_KEY configured, so it cannot keep a Cal.com signing secret. Generate one with `openssl rand -base64 32`, set it in the environment, and restart.';

export interface CalcomEndpointSummary {
  id: string;
  status: 'active' | 'disabled';
  /** Path only; the client prefixes its public API base URL. */
  path: string;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
}

export interface MeetingsSetup {
  bookingUrl: string | null;
  secretsConfigured: boolean;
  googleCalendar: {
    connected: boolean;
    status: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  };
  calcom: CalcomEndpointSummary[];
}

export function calcomEndpointPath(endpointId: string): string {
  return `/api/hooks/v1/calcom/${encodeURIComponent(endpointId)}`;
}

export async function listCalcomEndpoints(
  db: Db,
  workspaceId: string
): Promise<CalcomEndpointSummary[]> {
  const rows = await db
    .prepare(
      `SELECT id,status,accepted_count,rejected_count,
              TO_CHAR(last_seen_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS last_seen_at,
              TO_CHAR(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at
       FROM provider_webhook_endpoints
       WHERE workspace_id=? AND provider='calcom'
       ORDER BY created_at DESC,id ASC`
    )
    .all<{
      id: string;
      status: 'active' | 'disabled';
      accepted_count: number;
      rejected_count: number;
      last_seen_at: string | null;
      created_at: string;
    }>(workspaceId);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    path: calcomEndpointPath(row.id),
    lastSeenAt: row.last_seen_at,
    acceptedCount: Number(row.accepted_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    createdAt: row.created_at
  }));
}

/** Everything the setup panel shows; secrets are never part of it. */
export async function readMeetingsSetup(db: Db, workspaceId: string): Promise<MeetingsSetup> {
  const [bookingUrl, calcom, connection] = await Promise.all([
    getBookingUrl(db, workspaceId),
    listCalcomEndpoints(db, workspaceId),
    db
      .prepare(
        `SELECT status,TO_CHAR(last_synced_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS last_synced_at,last_error
         FROM connections WHERE workspace_id=? AND provider='google-calendar'
         ORDER BY updated_at DESC,id ASC LIMIT 1`
      )
      .get<{ status: string; last_synced_at: string | null; last_error: string | null }>(
        workspaceId
      )
  ]);
  return {
    bookingUrl,
    secretsConfigured: secretsConfigured(),
    googleCalendar: {
      connected: connection?.status === 'connected',
      status: connection?.status ?? null,
      lastSyncedAt: connection?.last_synced_at ?? null,
      lastError: connection?.last_error ?? null
    },
    calcom
  };
}

/** The secret is returned exactly once, here; Phase A's custody seals it. */
export async function createCalcomEndpoint(
  db: Db,
  input: { workspaceId: string; actorUserId: string }
): Promise<{ endpoint: CalcomEndpointSummary; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  const created = await createProviderWebhookEndpoint(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    provider: 'calcom',
    signingSecret: secret
  });
  const endpoint = (await listCalcomEndpoints(db, input.workspaceId)).find(
    (candidate) => candidate.id === created.id
  );
  if (!endpoint) throw new Error('The Cal.com endpoint was created but could not be read back.');
  return { endpoint, secret };
}

export async function setCalcomEndpointStatus(
  db: Db,
  input: { workspaceId: string; endpointId: string; status: 'active' | 'disabled' },
  now: Date = new Date()
): Promise<CalcomEndpointSummary | null> {
  const updated = await db
    .prepare(
      `UPDATE provider_webhook_endpoints SET status=?,updated_at=?
       WHERE workspace_id=? AND id=? AND provider='calcom'`
    )
    .run(input.status, now.toISOString(), input.workspaceId, input.endpointId);
  if (updated.changes === 0) return null;
  return (
    (await listCalcomEndpoints(db, input.workspaceId)).find(
      (candidate) => candidate.id === input.endpointId
    ) ?? null
  );
}
```

- [ ] **Step 4: Add the routes.**

4a. In `src/server/app.ts`, after the side-effect import added in Task 4 (`import './provider-webhooks/calcom.js';`), add:

```ts
import { BookingUrlError, setBookingUrl } from './meetings/booking-link.js';
import {
  CALCOM_SECRETS_MISSING,
  createCalcomEndpoint,
  readMeetingsSetup,
  setCalcomEndpointStatus
} from './meetings/setup.js';
```

4b. Immediately before the comment block that starts `  // Generic GTM lead capture management. Reads are workspace-visible; source` (and its leading `// ----` line), insert:

```ts
// ---------------------------------------------------------------------
// Meetings setup: the workspace booking link and the Cal.com webhook.
// Reads are workspace-visible; changing outbound copy or minting a signing
// secret is owner-only.
// ---------------------------------------------------------------------
app.get('/api/setup/meetings', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readMeetingsSetup(db, req.auth!.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.put(
  '/api/setup/meetings/booking-link',
  ownerOnly('change the booking link'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({ bookingUrl: z.string().max(2000).nullable() })
        .strict()
        .parse(req.body ?? {});
      const bookingUrl = await setBookingUrl(
        db,
        req.auth!.workspaceId,
        input.bookingUrl,
        new Date()
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ bookingUrl });
    } catch (error) {
      if (error instanceof BookingUrlError) return res.status(400).json({ error: error.message });
      next(error);
    }
  }
);

app.post(
  '/api/setup/meetings/calcom',
  ownerOnly('connect Cal.com'),
  async (req: AuthedRequest, res, next) => {
    try {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      if (!secretsConfigured()) return res.status(409).json({ error: CALCOM_SECRETS_MISSING });
      const created = await createCalcomEndpoint(db, {
        workspaceId: req.auth!.workspaceId,
        actorUserId: req.auth!.userId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  }
);

app.patch(
  '/api/setup/meetings/calcom/:id/status',
  ownerOnly('change the Cal.com webhook'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({ status: z.enum(['active', 'disabled']) })
        .strict()
        .parse(req.body ?? {});
      const endpoint = await setCalcomEndpointStatus(db, {
        workspaceId: req.auth!.workspaceId,
        endpointId: String(req.params.id),
        status: input.status
      });
      if (!endpoint) return res.status(404).json({ error: 'Cal.com webhook not found' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ endpoint });
    } catch (error) {
      next(error);
    }
  }
);
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/meetings/api.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the client calls.**

Append to the end of `src/client/api.ts`:

```ts
export interface CalcomWebhookSummary {
  id: string;
  status: 'active' | 'disabled';
  path: string;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
}

export interface MeetingsSetupState {
  bookingUrl: string | null;
  secretsConfigured: boolean;
  googleCalendar: {
    connected: boolean;
    status: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  };
  calcom: CalcomWebhookSummary[];
}

export async function getMeetingsSetup(): Promise<MeetingsSetupState> {
  return request<MeetingsSetupState>('/api/setup/meetings');
}

export async function saveBookingLink(
  bookingUrl: string | null
): Promise<{ bookingUrl: string | null }> {
  return request('/api/setup/meetings/booking-link', {
    method: 'PUT',
    body: JSON.stringify({ bookingUrl })
  });
}

export async function createCalcomWebhook(): Promise<{
  endpoint: CalcomWebhookSummary;
  secret: string;
}> {
  return request('/api/setup/meetings/calcom', { method: 'POST', body: JSON.stringify({}) });
}

export async function setCalcomWebhookStatus(
  id: string,
  status: 'active' | 'disabled'
): Promise<{ endpoint: CalcomWebhookSummary }> {
  return request(`/api/setup/meetings/calcom/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });
}
```

- [ ] **Step 7: Write the panel.**

Create `src/client/MeetingsSetup.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { CalendarClock, Copy, KeyRound, LoaderCircle } from 'lucide-react';
import {
  createCalcomWebhook,
  getMeetingsSetup,
  getPublicConfig,
  saveBookingLink,
  setCalcomWebhookStatus,
  type CalcomWebhookSummary,
  type MeetingsSetupState
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { Button, Field, Input } from './ui/primitives';
import './lead-capture.css';

/** One sentence about the calendar connection, never a silent zero. */
function calendarStatusText(calendar: MeetingsSetupState['googleCalendar']): string {
  if (!calendar.status)
    return 'Not connected. Connect Google Calendar under Setup → Workspace to bring in meetings with people already in Trevra.';
  if (!calendar.connected)
    return `Connection status: ${calendar.status}. Reconnect it under Setup → Workspace; no meetings arrive until then.`;
  if (calendar.lastError) return `Connected. The last sync reported: ${calendar.lastError}`;
  return calendar.lastSyncedAt
    ? `Connected. Last sync ${relativeTime(calendar.lastSyncedAt)}.`
    : 'Connected. No sync has finished yet.';
}

export function MeetingsSetup({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [setup, setSetup] = useState<MeetingsSetupState | null>(null);
  const [draft, setDraft] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [revealed, setRevealed] = useState<{ endpointId: string; secret: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  const load = async () => {
    const [next, config] = await Promise.all([getMeetingsSetup(), getPublicConfig()]);
    setSetup(next);
    setDraft(next.bookingUrl ?? '');
    setApiBaseUrl(config.apiBaseUrl || window.location.origin);
  };

  useEffect(() => {
    void load().catch((error) => setProblem(errorMessage(error, 'Unable to load meetings setup.')));
  }, []);

  const saveLink = async (value: string | null) => {
    setBusy('link');
    setProblem('');
    try {
      const saved = await saveBookingLink(value);
      setSetup((current) => (current ? { ...current, bookingUrl: saved.bookingUrl } : current));
      setDraft(saved.bookingUrl ?? '');
      setToast(saved.bookingUrl ? 'Booking link saved.' : 'Booking link removed.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to save the booking link.'));
    } finally {
      setBusy('');
    }
  };

  const connectCalcom = async () => {
    setBusy('calcom');
    setProblem('');
    try {
      const created = await createCalcomWebhook();
      setSetup((current) =>
        current ? { ...current, calcom: [created.endpoint, ...current.calcom] } : current
      );
      setRevealed({ endpointId: created.endpoint.id, secret: created.secret });
      setToast('Cal.com webhook created. Copy the signing secret now.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to create the Cal.com webhook.'));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (endpoint: CalcomWebhookSummary) => {
    setBusy(endpoint.id);
    setProblem('');
    try {
      const next = await setCalcomWebhookStatus(
        endpoint.id,
        endpoint.status === 'active' ? 'disabled' : 'active'
      );
      setSetup((current) =>
        current
          ? {
              ...current,
              calcom: current.calcom.map((item) =>
                item.id === next.endpoint.id ? next.endpoint : item
              )
            }
          : current
      );
      setToast(
        next.endpoint.status === 'active' ? 'Cal.com webhook enabled.' : 'Cal.com webhook disabled.'
      );
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to change the Cal.com webhook.'));
    } finally {
      setBusy('');
    }
  };

  const copy = (text: string, done: string) => {
    void navigator.clipboard.writeText(text).then(() => setToast(done));
  };
  const base = (apiBaseUrl || window.location.origin).replace(/\/$/, '');
  const savedLink = setup?.bookingUrl ?? '';

  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Meetings</h3>
          <p>
            Booked and calendar meetings move the matching Opportunity to Meeting and appear on
            Today.
          </p>
        </div>
        <CalendarClock size={20} />
      </div>
      {problem && <div className="error-box">{problem}</div>}

      <h4>Booking link</h4>
      <p className="li-hint">
        Sequences insert it with {'{{booking_link}}'}. A sequence that uses it will not start, and
        holds instead of sending, while this is empty.
      </p>
      {isOwner ? (
        <div className="capture-create-row">
          <Field
            label="Booking link"
            hint="A full https:// address, for example https://cal.com/you/intro."
          >
            <Input
              type="url"
              value={draft}
              maxLength={500}
              placeholder="https://cal.com/you/intro"
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy === 'link' || draft.trim() === savedLink}
            onClick={() => void saveLink(draft.trim() || null)}
          >
            {busy === 'link' && <LoaderCircle className="spin" size={15} />}
            Save link
          </Button>
          {savedLink && (
            <Button variant="ghost" disabled={busy === 'link'} onClick={() => void saveLink(null)}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <p>{savedLink || 'No booking link yet. The workspace owner can add one here.'}</p>
      )}

      <h4>Google Calendar</h4>
      <p className="li-hint">{setup ? calendarStatusText(setup.googleCalendar) : 'Loading…'}</p>

      <h4>Cal.com</h4>
      <p className="li-hint">
        In Cal.com, open Settings → Developer → Webhooks and add a webhook with the subscriber URL
        and secret below. Tick Booking Created, Booking Rescheduled and Booking Cancelled, and leave
        the payload template empty.
      </p>
      {setup && !setup.secretsConfigured && (
        <p className="li-hint">
          This server has no TREVRA_SECRETS_KEY, so it cannot keep a Cal.com signing secret yet.
        </p>
      )}
      {setup && setup.calcom.length === 0 && (
        <p className="li-hint">No Cal.com webhook yet, so no bookings arrive.</p>
      )}
      {setup?.calcom.map((endpoint) => {
        const url = `${base}${endpoint.path}`;
        const secret = revealed?.endpointId === endpoint.id ? revealed.secret : '';
        return (
          <div key={endpoint.id} className="capture-source-detail">
            <div className="section-heading">
              <div>
                <h4>Cal.com webhook</h4>
                <p>{endpoint.id}</p>
              </div>
              <span className={`status-pill ${endpoint.status === 'active' ? 'ok' : ''}`}>
                {endpoint.status}
              </span>
            </div>
            <div className="capture-metrics">
              <span>
                <strong>{endpoint.acceptedCount}</strong>
                <small>Accepted</small>
              </span>
              <span>
                <strong>{endpoint.rejectedCount}</strong>
                <small>Rejected</small>
              </span>
              <span>
                <strong>{endpoint.lastSeenAt ? relativeTime(endpoint.lastSeenAt) : 'Never'}</strong>
                <small>Last received</small>
              </span>
            </div>
            <div className="capture-secret">
              <strong>Subscriber URL</strong>
              <code>{url}</code>
              {secret ? (
                <>
                  <strong>Signing secret — shown only now</strong>
                  <code>{secret}</code>
                </>
              ) : null}
              <div className="capture-actions">
                <Button onClick={() => copy(url, 'Subscriber URL copied.')}>
                  <Copy size={14} /> Copy URL
                </Button>
                {secret && (
                  <Button onClick={() => copy(secret, 'Secret copied.')}>
                    <Copy size={14} /> Copy secret
                  </Button>
                )}
                {isOwner && (
                  <Button
                    variant="ghost"
                    disabled={busy === endpoint.id}
                    onClick={() => void toggle(endpoint)}
                  >
                    {endpoint.status === 'active' ? 'Disable' : 'Enable'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {isOwner && setup?.secretsConfigured && (
        <div className="capture-actions">
          <Button disabled={busy === 'calcom'} onClick={() => void connectCalcom()}>
            {busy === 'calcom' ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <KeyRound size={15} />
            )}
            {setup.calcom.length === 0 ? 'Create Cal.com webhook' : 'Create another webhook'}
          </Button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 8: Render it on the capture tab.**

In `src/client/App.tsx`, after `import { LeadCaptureSetup } from './LeadCaptureSetup';`, add:

```tsx
import { MeetingsSetup } from './MeetingsSetup';
```

Then replace:

```tsx
      {onCapture ? (
        <LeadCaptureSetup setToast={setToast} />
      ) : onBilling ? (
```

with:

```tsx
      {onCapture ? (
        <>
          <LeadCaptureSetup setToast={setToast} />
          <MeetingsSetup setToast={setToast} />
        </>
      ) : onBilling ? (
```

Phase A may already have wrapped this branch in a fragment for its webhook panel. If so, add only `<MeetingsSetup setToast={setToast} />`, as the fragment's last child.

- [ ] **Step 9: Check the UI by hand.**

Run `npm run dev`, sign in as an owner, and open `/setup/capture`. Check each of these:

- Light and dark theme.
- A 375px-wide viewport, with no horizontal scroll.
- Keyboard focus is visible on every control.
- "Save link" is the only primary button in the panel.
- A member sees the link as text, with no controls.

- [ ] **Step 10: Commit.**

```bash
npm run check
git add src/server/meetings/setup.ts src/server/meetings/api.test.ts src/server/app.ts src/client/api.ts src/client/MeetingsSetup.tsx src/client/App.tsx
git commit -m "feat(meetings): owner setup for booking link and Cal.com" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 7: Today items `meeting_upcoming` and `meeting_held`

**Files:**

- Modify: `src/server/today.ts`
- Modify: `src/client/views/LoopView.tsx`
- Test: `src/server/today.test.ts`

**Interfaces:**

- Consumes: the `meetings` table (Task 1); `workspace_settings.timezone`.
- Produces:
  - `TodayItemKind` gains `'meeting_upcoming'` (needsAttention, priority 25, next 48 hours) and `'meeting_held'` (recentResults, priority 25, ended within the existing 7-day window);
  - `reference: { type: 'meeting', id }`;
  - `metadata: { meetingId, provider, personId, accountId, startsAt, endsAt }`.

- [ ] **Step 1: Write the failing test.**

In `src/server/today.test.ts`, add this test inside the same `describe` that holds `it('projects live GTM work and recent outcomes from durable state', ...)`, directly after that test:

```ts
it('projects upcoming and recently held meetings, never cancelled or distant ones', async () => {
  const account = await createAccount(
    db,
    WORKSPACE,
    { domain: 'meet.example', name: 'Meet AG', source: 'manual' },
    new Date('2026-08-20T09:00:00.000Z')
  );
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      'con_today_meet',
      WORKSPACE,
      'Nora Meier',
      'nora@meet.example',
      'nora@meet.example',
      '2026-08-20T08:00:00.000Z',
      '2026-08-20T08:00:00.000Z'
    );
  const meeting = (
    id: string,
    status: string,
    startsAt: string,
    endsAt: string,
    accountId: string | null
  ) =>
    db
      .prepare(
        `INSERT INTO meetings
           (id,workspace_id,provider,external_id,status,origin,starts_at,ends_at,person_id,account_id,cancelled_at,created_at,updated_at)
           VALUES (?,?,'calcom',?,?,'booking',?,?,?,?,?,?,?)`
      )
      .run(
        id,
        WORKSPACE,
        id,
        status,
        startsAt,
        endsAt,
        'con_today_meet',
        accountId,
        status === 'cancelled' ? '2026-08-21T07:00:00.000Z' : null,
        '2026-08-20T08:00:00.000Z',
        '2026-08-20T08:00:00.000Z'
      );
  await meeting(
    'mtg_today_soon',
    'scheduled',
    '2026-08-21T11:00:00.000Z',
    '2026-08-21T11:30:00.000Z',
    account.id
  );
  await meeting(
    'mtg_today_far',
    'scheduled',
    '2026-08-24T11:00:00.000Z',
    '2026-08-24T11:30:00.000Z',
    null
  );
  await meeting(
    'mtg_today_cancelled',
    'cancelled',
    '2026-08-21T12:00:00.000Z',
    '2026-08-21T12:30:00.000Z',
    null
  );
  await meeting(
    'mtg_today_held',
    'rescheduled',
    '2026-08-20T10:00:00.000Z',
    '2026-08-20T10:30:00.000Z',
    null
  );
  await meeting(
    'mtg_today_old',
    'scheduled',
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:30:00.000Z',
    null
  );

  const today = await getToday(db, WORKSPACE, NOW);

  const upcoming = today.needsAttention.filter((item) => item.kind === 'meeting_upcoming');
  expect(upcoming).toHaveLength(1);
  expect(upcoming[0]).toMatchObject({
    id: 'meeting-upcoming:mtg_today_soon',
    priority: 25,
    title: 'Meeting with Nora Meier (Meet AG)',
    href: '/research',
    observedAt: '2026-08-21T11:00:00.000Z',
    reference: { type: 'meeting', id: 'mtg_today_soon' },
    metadata: { meetingId: 'mtg_today_soon', provider: 'calcom', accountId: account.id }
  });
  expect(upcoming[0].detail).toMatch(/^Starts .+ \(UTC\)\.$/);

  const held = today.recentResults.filter((item) => item.kind === 'meeting_held');
  expect(held.map((item) => item.id)).toEqual(['meeting-held:mtg_today_held']);
  expect(held[0]).toMatchObject({
    priority: 25,
    title: 'Met Nora Meier',
    href: '/outreach/opportunities',
    observedAt: '2026-08-20T10:30:00.000Z'
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts`
Expected: FAIL. `upcoming` has length 0.

- [ ] **Step 3: Implement the projection.**

3a. In `src/server/today.ts`, add the two members at the end of the `TodayItemKind` union, before its terminating `;`. After Phase A, the union ends with Phase A's kinds; append after whichever member is last. For example, `  | 'opportunity_closed';` becomes:

```ts
  | 'opportunity_closed'
  | 'meeting_upcoming'
  | 'meeting_held';
```

3b. Directly after the `iso` function, add:

```ts
function validTimeZone(zone: unknown): string {
  const candidate = typeof zone === 'string' ? zone.trim() : '';
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

function meetingTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(value));
}
```

3c. Immediately before the final `return {` of `getToday` (the one returning `needsAttention: sortAttention(items)`), insert:

```ts
// Meetings (migration 131), read last and on their own so the queries above are
// untouched. Upcoming: the next 48 hours. Held: ended inside the same seven-day
// window every other result uses. In-progress meetings are neither.
// lc-debt: 50 meetings per projection; page it if a workspace books more than
// that in a 9-day window.
const meetingHorizon = new Date(now.getTime() + 48 * 3_600_000).toISOString();
const nowIso = now.toISOString();
const [meetingRows, meetingSettings] = await Promise.all([
  db
    .prepare(
      `SELECT m.id,m.provider,m.person_id,m.account_id,
                TO_CHAR(m.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS starts_at,
                TO_CHAR(m.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends_at,
                p.name AS person_name,p.email AS person_email,a.name AS account_name
         FROM meetings m
         JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.person_id
         LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
         WHERE m.workspace_id=? AND m.status<>'cancelled'
           AND ((m.starts_at>?::timestamptz AND m.starts_at<=?::timestamptz)
             OR (m.ends_at>=?::timestamptz AND m.ends_at<=?::timestamptz))
         ORDER BY m.starts_at ASC,m.id ASC
         LIMIT 50`
    )
    .all<Record<string, unknown>>(workspaceId, nowIso, meetingHorizon, recentSince, nowIso),
  db
    .prepare('SELECT timezone FROM workspace_settings WHERE workspace_id=?')
    .get<{ timezone: string | null }>(workspaceId)
]);
const meetingZone = validTimeZone(meetingSettings?.timezone);
for (const row of meetingRows) {
  const meetingId = String(row.id);
  const startsAt = String(row.starts_at);
  const endsAt = String(row.ends_at);
  const who =
    String(row.person_name ?? '').trim() || String(row.person_email ?? '').trim() || 'a contact';
  const accountName = String(row.account_name ?? '').trim();
  const label = accountName ? `${who} (${accountName})` : who;
  const metadata = {
    meetingId,
    provider: String(row.provider ?? ''),
    personId: String(row.person_id ?? ''),
    accountId: row.account_id ? String(row.account_id) : null,
    startsAt,
    endsAt
  };
  if (startsAt > nowIso) {
    items.push({
      id: `meeting-upcoming:${meetingId}`,
      kind: 'meeting_upcoming',
      priority: 25,
      title: `Meeting with ${label}`,
      detail: `Starts ${meetingTime(startsAt, meetingZone)} (${meetingZone}).`,
      // The account's research is the prep brief; without an account, the Opportunity.
      href: row.account_id ? '/research' : '/outreach/opportunities',
      observedAt: startsAt,
      reference: { type: 'meeting', id: meetingId },
      metadata
    });
  } else if (endsAt <= nowIso) {
    recentResults.push({
      id: `meeting-held:${meetingId}`,
      kind: 'meeting_held',
      priority: 25,
      title: `Met ${label}`,
      detail: `Ended ${meetingTime(endsAt, meetingZone)} (${meetingZone}).`,
      href: '/outreach/opportunities',
      observedAt: endsAt,
      reference: { type: 'meeting', id: meetingId },
      metadata
    });
  }
}
```

If `nowIso` is already declared in `getToday`'s scope (Phase A may add one), reuse it and drop this declaration.

- [ ] **Step 4: Label the action on the Loop screen.**

In `src/client/views/LoopView.tsx`, in `todayActionLabel`, after:

```ts
if (item.kind === 'high_priority_account') return 'Review account';
```

add:

```ts
if (item.kind === 'meeting_upcoming') return 'Prepare';
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts`
Expected: PASS. The existing `recentResults` assertion in "projects live GTM work and recent outcomes from durable state" is unchanged, because that fixture has no meetings.

- [ ] **Step 6: Commit.**

```bash
npm run check
git add src/server/today.ts src/server/today.test.ts src/client/views/LoopView.tsx
git commit -m "feat(meetings): upcoming and held meetings on Today" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Task 8: Phase sweep and final gate

**Files:** none are created. Fix anything the sweep finds in the file it names.

**Interfaces:**

- Consumes: everything above.
- Produces: a green `npm run check`.

- [ ] **Step 1: Check for stale copy and leaked content.**

```bash
grep -rn "Not ready yet\|nowhere to put meetings\|KNOWN GAP: there is no canonical 'meeting'\|no place to put this kind of record" src .env.example docs
grep -rn "summary\|description" src/server/meetings/*.ts src/server/provider-webhooks/calcom.ts | grep -v "test\|^\s*//\|\* "
```

Expected:

- The first command prints nothing.
- The second prints only comment lines, or nothing. No code path reads `summary` or `description` into a stored record.

- [ ] **Step 2: Check routing and discoverability are untouched.**

```bash
git diff --stat main -- src/client/ui/route.ts src/server/index.ts src/server/public-site.ts index.html
```

Expected: no changes. There is no new route, no `#/` literal and no public page.

- [ ] **Step 3: Run the full gate.**

Run: `npm run check`
Expected: every test file passes, `tsc --noEmit` is clean, and the vite and server builds succeed.

- [ ] **Step 4: Confirm the tree.**

```bash
git status --short
```

Expected: clean. Every change was committed in Tasks 1–7, and there are no scratch files.

---

## Self-review

**Spec coverage.**

| Requirement                                                                                                                                        | Where                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical `meeting` record kind                                                                                                                    | Task 1 (`canonicalMeetingSchema`), Task 2 (union member, `ingestMeeting`), docs in Task 2                                                      |
| `meetings` table: workspace-scoped, unique per provider external id, scheduled/rescheduled/cancelled, start/end, person/account, source provenance | Task 1 migration (`UNIQUE (workspace_id, provider, external_id)`, `source_record_id`)                                                          |
| Title only if needed; never descriptions, notes or attendees beyond the matched person                                                             | No title column (Today uses Person/Account names); the normaliser and the Cal.com handler emit one Person; asserted in Task 3 and Task 4 tests |
| Retention: workspace cascade and person erasure                                                                                                    | Task 1 FKs; cascade asserted in `store.test.ts`; source-record residue recorded as `lc-debt`                                                   |
| Google Calendar sync ingests meetings with honest card copy                                                                                        | Task 3 (aliases, `meetingFromCalendarEvent`, catalog copy, `.env.example`, connection `last_error`)                                            |
| Cal.com verifier `calcom`, header and scheme cited                                                                                                 | Task 4 (`X-Cal-Signature-256`, hex HMAC-SHA256, `no-secret-provided`; two source URLs)                                                         |
| Attendee email resolves the Person                                                                                                                 | Task 4 handler → `ingestCanonicalRecord` → `resolveCanonicalRecordIdentity` (booking origin)                                                   |
| Created/rescheduled call `advanceOpportunityStage` with minimum `meeting`; cancellation updates the meeting only                                   | Task 2 `applyMeetingRecord`; Task 4 test asserts stage stays `meeting` after cancel                                                            |
| Workspace booking URL setting and `{{booking_link}}`; blocked with a clear message when unset                                                      | Task 5 (start refusal 409, runner block, preview diagnostic, render throws); Task 6 setting UI/API                                             |
| Owner-only setup on existing screens, no new nav                                                                                                   | Task 6 on `/setup/capture`; `ownerOnly`; Task 8 Step 2                                                                                         |
| Today `meeting_upcoming` (needsAttention, 48h, research/prep link) and `meeting_held` (recentResults)                                              | Task 7                                                                                                                                         |
| Migration `131_*`                                                                                                                                  | Task 1                                                                                                                                         |

**Placeholder scan.** No TBD, TODO, "similar to", or "add appropriate handling" remains. Three steps adapt to Phase A's exact layout, and each names its expected state and its single alternative:

- the provider-webhooks import path (Task 0, Step 2);
- the Phase A fragment in `App.tsx` (Task 6, Step 8);
- a possible `nowIso` collision in `getToday` (Task 7, Step 3c).

**Type consistency.**

- Names used across tasks match their definitions:
  - `RecordMeetingInput`, `RecordMeetingResult`, `recordMeeting` and `meetingKnown` (Task 1);
  - `CanonicalMeeting`, `canonicalMeetingSchema` and `activeMeetingSchema` (Task 1);
  - `applyMeetingRecord`, `findMeetingPerson`, `workspaceUserEmails` and `IngestOutcome` (Task 2);
  - `meetingFromCalendarEvent`, `readCalendarEvent`, `nangoRecordDeleted` and `NangoSyncResult.ignored` (Task 3);
  - `calcomVerifier` (Task 4);
  - `getBookingUrl`, `setBookingUrl`, `BookingUrlError`, `BOOKING_LINK_MISSING_MESSAGE`, `BOOKING_LINK_PREVIEW_PLACEHOLDER`, `BookingLinkMissingError`, `stepUsesBookingLink` and `workflowUsesBookingLink` (Task 5);
  - `readMeetingsSetup`, `createCalcomEndpoint`, `setCalcomEndpointStatus`, `CALCOM_SECRETS_MISSING`, `MeetingsSetupState` and `CalcomWebhookSummary` (Task 6).
- `advanceOpportunityStage` is called with exactly the contract's input fields. `ProviderWebhookVerifier` is implemented with the contract's `verify` and `handle` signatures.
- Status values are `scheduled|rescheduled|cancelled` in the migration CHECK, in `MEETING_STATUSES` and in every test.
- Origins are `calendar|booking` in the migration CHECK, in `MEETING_ORIGINS`, and in the Cal.com handler (`booking`) and Google normaliser (`calendar`).

**Review Focus mapping.** Each of the five lines names a test, and each test belongs to the task that adds it: Task 1 and Task 4 for ordering, Task 4 for cross-workspace, Tasks 2 and 3 for calendar observation, Task 5 for the blank link, and Task 6 for honest state.

**Contracts.**

- Phase A contracts 1 and 2 are consumed exactly as specified.
- Migration 131 is used.
- Today kinds are exactly `meeting_upcoming` and `meeting_held`.
- One deliberate addition: Cal.com endpoints are minted through `POST /api/setup/meetings/calcom`, rather than through Phase A's `/api/setup/webhooks` request shape, which the roadmap does not fix. The route calls only the contract function `createProviderWebhookEndpoint` and reads only contract columns.
