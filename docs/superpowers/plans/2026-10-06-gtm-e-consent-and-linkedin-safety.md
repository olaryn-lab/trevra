# Phase E — Consent and LinkedIn Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every workspace gets a sender identity, and email outreach cannot be planned without one. Each person carries a per-channel lawful basis, and cold email is refused deterministically wherever a conservative jurisdiction rule needs one. One LinkedIn member gets one budget across every workspace seat signed in as that member. A founder can choose to send LinkedIn invites and messages by hand while Trevra drafts, gates and counts them.

**Architecture:** Four deterministic additions on the existing boundary. Models decide nothing here.

1. `workspace_sender_identities` plus `senderIdentityBlockers()` in the GTM compiler.
2. Per-person lawful basis:
   - storage: `contact_lawful_bases`, plus `contacts.country_code` and `accounts.country_code`;
   - a static rule table and `evaluateEmailLawfulBases()`;
   - enforcement: a built-in deny in `evaluatePolicy()` (playbook email), a refusal in `executeEmail()` (campaign email) and a GTM lead-list plan blocker.
3. `linkedin_seat_identities`, written only by `detectLinkedInSeat()`. `seatLedgerFacts()` counts across every seat with the same identity key. Only integers cross the workspace boundary.
4. Human-send mode:
   - `linkedin_seats.send_mode`; the worker never claims invites or messages on a `human` seat;
   - `src/server/linkedin/handoff.ts` lists the next gated row per human seat as a `linkedin_handoff_waiting` Today item;
   - "Mark sent" reports through the existing `ingestOutcome()`, so the guard counts it.

**Tech Stack:** TypeScript, Express 5, PostgreSQL (forward-only migrations), Zod 3, Vitest 4 with Testcontainers PostgreSQL, supertest, React 19 (`renderToStaticMarkup` tests).

**Spec:** Phase E of `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md`.

- Roadmap contracts honoured:
  - Today kind `linkedin_handoff_waiting` (needsAttention) and migration reservation `134_*`;
  - no dependency on Phases A–D;
  - no new nav section and no new client route.
- Human-send mode is per seat, one of the two shapes the roadmap allows.

## Global Constraints

- **Migration number.** `134` is a reservation. Before Task 2 run `ls /home/pankaj/Projects/Trevra/migrations | tail -3`. If `134_*` exists, use the next free number and rename every `134_consent_and_linkedin_safety` reference in this plan (only Task 2 names the file). Migrations contain no `BEGIN`/`COMMIT`; the runner wraps each file.
- **Workspace isolation.** Every query is scoped by `workspace_id`. The founder-budget link is the only cross-workspace read, and it may return integers only: window counts, the pending-invite count and the linked-seat count. No target, body, label, workspace id or seat key from another workspace may reach a verdict, a seat view, an event or a log line. Duplicate-target, campaign and suppression checks stay per seat.
- **Deterministic enforcement only.** Lawful basis and sender identity are enforced in three places, and no model or skill output may decide them:
  - a built-in `evaluatePolicy()` rule;
  - a refusal in `executeEmail()`;
  - GTM plan blockers.
- **The jurisdiction rule table is not legal advice.** The source file, every deny reason and the plan text carry `Not legal advice; verify with counsel.`
- **The approval/execution boundary is unchanged.** Human-send never executes anything. "Mark sent" is a report, through `ingestOutcome()` (`via: 'outcome-ingest'`), exactly like `POST /api/linkedin/actions/outcome`.
- **No PII in events.** Events carry ids, kinds, field names and ISO country codes, never email addresses or bodies. No analytics are added.
- **UI.**
  - Use `Button`, `Field`, `Input`, `Textarea` and `SwitchField` from `src/client/ui/primitives.tsx`, `Panel` from `src/client/ui/layout.tsx`, and `FormGrid`/`ActionRow` from `src/client/ui/forms.tsx`.
  - No new hex colors, radii or font sizes; reuse the existing classes (`today-item-expanded`, `today-action-review*`, `status-pill`, `li-hint`, `error-banner`, `secondary-button`).
  - Each local task has one primary action.
  - No `#/` routes and no `location.hash`.
  - Asserted client strings contain no apostrophes, because HTML escaping breaks them.
- **Test emails.** Use RFC 2606/6761 reserved names (`example.com`, `*.example`, `*.test`) except where a test needs a real ccTLD to exercise a rule. Those use invented companies (`acme-gmbh.de`, `northwind-gmbh.de`), never real people.
- **Tests:** `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts <test files>`. Final gate: `npm run check`.
- **Commits:** short message, then the trailer, for example `git commit -m "feat(linkedin): share one member's budget across workspaces" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"`.
- **AGENTS.md is stale on routing names.** The real identifiers are `SECTIONS`/`SUB_ROUTES`/`isAppPath` (`src/client/ui/route.ts`) and `APP_PATH_PATTERNS` (`src/server/index.ts`). This phase adds no client path, so neither changes.
- **Rebase risk with Phase D.** Phase D also touches `src/server/today.ts`, `src/server/gtm/intent.ts` and `executeEmail()` in `src/server/linkedin/campaign-channels.ts`. Re-read those anchors before editing; every edit below names its anchor text, not only a line number.

## Review Focus

1. **Two workspaces, one LinkedIn member: counts are shared, nothing else leaks.** Test: `guard.test.ts` › "one LinkedIn member across workspaces" › "lets only counts cross the workspace boundary" (Task 3).
2. **A human-send seat never auto-claims an invite or message, and passive kinds still run.** Test: `local-worker.test.ts` › "NEVER CLAIMS AN INVITE OR MESSAGE FROM A HUMAN-SEND SEAT" (Task 4).
3. **"Mark sent" is recorded exactly once, and a skipped handoff can never become sent.** Tests: `handoff.test.ts` › "marks a handoff sent exactly once, and the guard counts it" and "refuses to mark a skipped handoff sent" (Task 5).
4. **An unknown-country recipient with no basis is denied even when a workspace allow policy matches.** Test: `engine.test.ts` › "denies cold email with no recorded lawful basis despite an allow policy" (Task 10).
5. **Withdrawing consent blocks cold email again.** Test: `lawful-basis.test.ts` › "blocks again once the consent is withdrawn" (Task 8).

## File Map

| File                                                         | Task       | Responsibility                                                                                     |
| ------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------- |
| `migrations/134_consent_and_linkedin_safety.sql`             | 2          | Four schema additions: sender identity, country codes, lawful bases, seat identities + `send_mode` |
| `src/server/compliance/schema.test.ts`                       | 2          | Constraint tests for the migration                                                                 |
| `src/server/linkedin/identity.ts` (+ `.test.ts`)             | 3          | `seatIdentityKey()`, `recordSeatIdentity()`                                                        |
| `src/server/linkedin/guard.ts`                               | 3          | Linked-seat counting, the `linked-identity` check                                                  |
| `src/server/linkedin/seats.ts`                               | 3, 4       | `identityConfirmedAt`, `linkedSeatCount`, `sendMode`, `HUMAN_SEND_KINDS`                           |
| `src/server/linkedin/local-worker.ts`                        | 3, 4, 5    | Records the identity on detect; excludes human-send rows; exports the member-advance helper        |
| `src/server/linkedin/execution-state.ts`                     | 4, 5       | `humanSendNext`; exports `gateVerdict`/`NextDueRow`                                                |
| `src/server/linkedin/handoff.ts` (+ `.test.ts`)              | 5          | List and resolve human-send handoffs                                                               |
| `src/server/linkedin/action-ledger.ts`                       | 5          | Comment only: the second outcome-ingest route                                                      |
| `src/server/today.ts`                                        | 5          | `linkedin_handoff_waiting` items                                                                   |
| `src/server/app.ts`                                          | 4, 5, 7, 8 | Seat schema `sendMode`; handoff, sender-identity and compliance routes; `ComplianceError` mapping  |
| `src/client/views/LinkedInHandoffCard.tsx` (+ `.test.tsx`)   | 6          | Today card: copy, Mark sent, Skip                                                                  |
| `src/client/views/LoopView.tsx`                              | 6          | Renders the handoff card                                                                           |
| `src/client/LinkedInAccountForm.tsx`                         | 6          | Human-send switch and identity hint                                                                |
| `src/client/LinkedInExecutionBlocker.ts`                     | 6          | `human-send` rung                                                                                  |
| `src/client/api.ts`                                          | 6, 7       | `resolveLinkedInHandoff()`, `getSenderIdentity()`, `saveSenderIdentity()`                          |
| `src/server/compliance/sender-identity.ts` (+ `.test.ts`)    | 7          | Sender identity store and GTM blockers                                                             |
| `src/client/SenderIdentityPanel.tsx` (+ `.test.tsx`)         | 7          | Owner-editable panel on `/setup/workspace`                                                         |
| `src/client/App.tsx`                                         | 7          | Mounts the panel                                                                                   |
| `src/server/gtm/intent.ts`                                   | 7, 11      | Sender-identity and lead-list lawful-basis blockers                                                |
| `src/server/compliance/errors.ts`                            | 8          | `ComplianceError`                                                                                  |
| `src/server/compliance/jurisdiction-rules.ts` (+ `.test.ts`) | 8          | Rule table, country resolution, pure decision                                                      |
| `src/server/compliance/lawful-basis.ts` (+ `.test.ts`)       | 8          | Store, batched evaluation, policy attributes, lead-list count                                      |
| `src/server/compliance/api.test.ts`                          | 7, 8       | Route tests: owner/member, cross-workspace                                                         |
| `src/server/lead-capture/submissions.ts`                     | 9          | Consent capture → lawful basis                                                                     |
| `src/server/control-plane/policy.ts`                         | 10         | Built-in lawful-basis deny                                                                         |
| `src/server/playbooks/engine.ts`                             | 10         | Passes lawful-basis attributes for `email.send`                                                    |
| `src/server/linkedin/campaign-channels.ts`                   | 11         | Refuses campaign cold email without a basis                                                        |
| `src/server/gtm/intent.test.ts`                              | 7, 11      | Sender-identity and lead-list lawful-basis blocker tests                                           |
| `src/server/lead-capture/lead-capture.test.ts`               | 9          | Consent capture test                                                                               |
| `src/server/control-plane/policy.test.ts`                    | 10         | Built-in deny precedes workspace policies                                                          |
| `src/server/playbooks/engine.test.ts`                        | 10         | Engine denies and allows by recorded basis                                                         |
| `src/server/linkedin/campaign-channels.test.ts`              | 11         | Campaign refusal before tracking tokens exist                                                      |

## Task 1: Verify that no guard already shares LinkedIn budgets across workspaces

This verification ran while the plan was written (2026-10-07). The executor re-runs it, because a later change may have landed in between.

**Files:** none modified.

- [ ] **Step 1: Re-run the three probes**

```bash
cd /home/pankaj/Projects/Trevra
grep -n "workspace_id=? AND seat_key=?" src/server/linkedin/guard.ts
grep -n -i "identity" migrations/022_linkedin_seats.sql migrations/045_linkedin_multi_seat.sql
grep -rln "identity_key\|linkedin_seat_identities\|founder_budget\|cross_workspace" src migrations
```

Expected: guard.ts lines 429, 447 and 452 (or nearby). The second and third commands print nothing.

- [ ] **Step 2: Record the finding (already established while planning)**

**Finding: no cross-workspace LinkedIn budget exists. The founder-budget build (Task 3) proceeds.**

- In `seatLedgerFacts()` (`src/server/linkedin/guard.ts`), every rolling-window count filters `workspace_id=? AND seat_key=?`. That covers 24h, 7d, 30d, the message pool, the day-over-day buckets and the acceptance rate (the `windowed` CTE, about line 429), the pending-invite backlog (about line 447) and the duplicate target (about line 452).
- The `actions.ts` counters (about lines 336, 369, 420, 459 and 532) use the same per-seat filter.
- No table or column maps a seat to the LinkedIn member it signs in as. `linkedin_seats.profile_url` is per workspace and operator-editable, so it is not confirmed identity.
- So a founder whose one LinkedIn profile is connected to two workspaces gets two full budgets today.

If the third probe in Step 1 prints any file, stop: a cross-workspace guard has landed. Drop Task 3 and report that instead of building it.

- [ ] **Step 3: Check the migration reservation**

```bash
ls /home/pankaj/Projects/Trevra/migrations | tail -3
```

Expected: `128_capture_source_preparation_idempotency.sql`, `129_account_watch_preparations.sql`, `README.md`, or later files below 134. If `134_*` exists, pick the next free number (see Global Constraints).

No commit; this task changes no file.

## Task 2: Migration — sender identity, country codes, lawful bases, seat identities, send mode

**Files:**

- Create: `migrations/134_consent_and_linkedin_safety.sql`
- Create: `src/server/compliance/schema.test.ts`

**Interfaces:**

- Consumes: existing tables `workspaces`, `users`, `contacts` (UNIQUE `(workspace_id, id)`), `accounts` (unique index `idx_accounts_workspace_id (workspace_id, id)`), and `linkedin_seats` (PK `(workspace_id, seat_key)`).
- Produces:
  - `workspace_sender_identities(workspace_id PK, legal_name, postal_address, privacy_policy_url, updated_by_user_id, created_at, updated_at)`
  - `contacts.country_code`, `accounts.country_code`
  - `contact_lawful_bases(id, workspace_id, person_id, channel, basis, source, source_ref, recorded_at, recorded_by_user_id, withdrawn_at, withdrawn_by_user_id, created_at)` with unique active index `idx_contact_lawful_bases_active_unique`
  - `linkedin_seat_identities(workspace_id, seat_key, identity_key, confirmed_at)`
  - `linkedin_seats.send_mode`

- [ ] **Step 1: Write the failing schema test**

Create `src/server/compliance/schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from '../linkedin/seats.js';

const WORKSPACE = 'ws_compliance_schema_test';
const NOW = '2026-08-21T09:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Compliance schema', NOW);
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES ('con_schema_1',?,'Maya','maya@northwind.example','maya@northwind.example',?,?)`
    )
    .run(WORKSPACE, NOW, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('migration 134: consent and LinkedIn safety', () => {
  it('stores one sender identity per workspace and refuses a non-https privacy URL', async () => {
    await db
      .prepare(
        `INSERT INTO workspace_sender_identities (workspace_id,legal_name,postal_address,privacy_policy_url)
         VALUES (?,?,?,?)`
      )
      .run(
        WORKSPACE,
        'Northwind GmbH',
        'Bahnhofstrasse 1, 8001 Zurich, Switzerland',
        'https://northwind.example/privacy'
      );
    await expect(
      db
        .prepare(
          `UPDATE workspace_sender_identities SET privacy_policy_url='http://northwind.example/privacy' WHERE workspace_id=?`
        )
        .run(WORKSPACE)
    ).rejects.toThrow();
  });

  it('accepts only ISO alpha-2 country codes on people and accounts', async () => {
    await db.prepare(`UPDATE contacts SET country_code='DE' WHERE id='con_schema_1'`).run();
    await expect(
      db.prepare(`UPDATE contacts SET country_code='Germany' WHERE id='con_schema_1'`).run()
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO accounts (id,workspace_id,name,domain,country_code) VALUES ('acc_schema_1',?,'Northwind','northwind.example','CH')`
      )
      .run(WORKSPACE);
    await expect(
      db.prepare(`UPDATE accounts SET country_code='ch' WHERE id='acc_schema_1'`).run()
    ).rejects.toThrow();
  });

  it('keeps one active lawful basis per person, channel, basis, source and reference', async () => {
    const insert = (rowId: string) =>
      db
        .prepare(
          `INSERT INTO contact_lawful_bases (id,workspace_id,person_id,channel,basis,source,source_ref,recorded_at)
           VALUES (?,?,'con_schema_1','email','consent','inbound_capture','sub_1',?)`
        )
        .run(rowId, WORKSPACE, NOW);
    await insert('clb_schema_1');
    await expect(insert('clb_schema_2')).rejects.toThrow();
    await db
      .prepare(`UPDATE contact_lawful_bases SET withdrawn_at=? WHERE id='clb_schema_1'`)
      .run(NOW);
    await insert('clb_schema_3');
    await expect(
      db
        .prepare(
          `INSERT INTO contact_lawful_bases (id,workspace_id,person_id,channel,basis,source,recorded_at)
           VALUES ('clb_schema_4',?,'con_schema_1','email','opt_in','operator',?)`
        )
        .run(WORKSPACE, NOW)
    ).rejects.toThrow();
  });

  it('links a seat to one LinkedIn member and defaults every seat to automated sending', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'UTC' }, new Date(NOW));
    const seat = await db
      .prepare(`SELECT send_mode FROM linkedin_seats WHERE workspace_id=? AND seat_key='owner'`)
      .get<{ send_mode: string }>(WORKSPACE);
    expect(seat?.send_mode).toBe('automated');
    await expect(
      db.prepare(`UPDATE linkedin_seats SET send_mode='robot' WHERE workspace_id=?`).run(WORKSPACE)
    ).rejects.toThrow();

    await db
      .prepare(
        `INSERT INTO linkedin_seat_identities (workspace_id,seat_key,identity_key,confirmed_at)
         VALUES (?,'owner','https://www.linkedin.com/in/shared-founder',?)`
      )
      .run(WORKSPACE, NOW);
    await db
      .prepare(`DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key='owner'`)
      .run(WORKSPACE);
    const left = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_seat_identities WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(left?.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/schema.test.ts`
Expected: FAIL. The first test fails on `relation "workspace_sender_identities" does not exist`, and the others fail on the missing `country_code`, `contact_lawful_bases` and `send_mode`.

- [ ] **Step 3: Write the migration**

Create `migrations/134_consent_and_linkedin_safety.sql`:

```sql
-- Phase E: consent and LinkedIn safety.
--
-- Four deterministic facts the control plane enforces without a model:
--   1. who a workspace's commercial email says it is from (CAN-SPAM needs a
--      postal address; Trevra also asks for a privacy policy URL);
--   2. a per-person, per-channel lawful basis for cold email, with its source;
--   3. which LinkedIn member a seat signs in as, so one person's limits are
--      counted once across every workspace that connected them;
--   4. whether a seat's invites and messages are sent by the founder by hand.
-- Not legal advice; verify with counsel.

CREATE TABLE IF NOT EXISTS workspace_sender_identities (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  legal_name TEXT CHECK (legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 200),
  postal_address TEXT CHECK (postal_address IS NULL OR char_length(postal_address) BETWEEN 1 AND 500),
  privacy_policy_url TEXT CHECK (
    privacy_policy_url IS NULL
    OR (privacy_policy_url ~ '^https://' AND char_length(privacy_policy_url) <= 2048)
  ),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE workspace_sender_identities IS
  'Who this workspace''s commercial email says it is from. Email outreach plans are blocked until postal_address and privacy_policy_url are set.';

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_country_code_check' AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_country_code_check
      CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_country_code_check' AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_country_code_check
      CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$') NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contact_lawful_bases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  basis TEXT NOT NULL CHECK (basis IN ('consent', 'existing_customer', 'legitimate_interest')),
  source TEXT NOT NULL CHECK (source IN ('inbound_capture', 'operator')),
  source_ref TEXT CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at TIMESTAMPTZ,
  withdrawn_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, person_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_lawful_bases_active
  ON contact_lawful_bases (workspace_id, person_id, channel)
  WHERE withdrawn_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_lawful_bases_active_unique
  ON contact_lawful_bases (workspace_id, person_id, channel, basis, source, (COALESCE(source_ref, '')))
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE contact_lawful_bases IS
  'Per person and channel: why Trevra may send cold outreach, where that came from, and when it was withdrawn. Rows are withdrawn, never deleted. Not legal advice; verify with counsel.';

CREATE TABLE IF NOT EXISTS linkedin_seat_identities (
  workspace_id TEXT NOT NULL,
  seat_key TEXT NOT NULL,
  identity_key TEXT NOT NULL CHECK (char_length(identity_key) BETWEEN 1 AND 300),
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, seat_key),
  FOREIGN KEY (workspace_id, seat_key)
    REFERENCES linkedin_seats(workspace_id, seat_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_linkedin_seat_identities_identity
  ON linkedin_seat_identities (identity_key);

COMMENT ON TABLE linkedin_seat_identities IS
  'The LinkedIn member a seat signed in as, read by the companion from its own signed-in profile. Seats sharing identity_key share one safety budget; only counts cross the workspace boundary.';

ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'automated';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'linkedin_seats_send_mode_check' AND conrelid = 'linkedin_seats'::regclass
  ) THEN
    ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_send_mode_check
      CHECK (send_mode IN ('automated', 'human')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN linkedin_seats.send_mode IS
  'automated: the browser worker sends. human: invites and messages are drafted and gated, then handed to the founder in Today; passive kinds still run.';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add migrations/134_consent_and_linkedin_safety.sql src/server/compliance/schema.test.ts
git commit -m "feat(compliance): add consent and LinkedIn safety schema" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 3: One LinkedIn member, one budget across workspaces

**Files:**

- Create: `src/server/linkedin/identity.ts`, `src/server/linkedin/identity.test.ts`
- Modify: `src/server/linkedin/seats.ts` (`LinkedInSeat`, `SeatRow`, `SEAT_COLUMNS`, `toSeat`)
- Modify: `src/server/linkedin/guard.ts` (`LinkedInCheckName`, `LINKEDIN_CHECK_NAMES`, `SeatLedgerFacts`, `seatLedgerFacts()`, `evaluateLinkedInSafety()`)
- Modify: `src/server/linkedin/local-worker.ts` (`detectLinkedInSeat()`)
- Modify: `src/server/linkedin/guard.test.ts`, `src/server/linkedin/credentials.test.ts`

**Interfaces:**

- Consumes:
  - `normalisedProfileUrl(raw: string): string | null` from `src/server/linkedin/driver.ts`
  - `linkedin_seat_identities` (Task 2)
  - `recordAction()` from `src/server/linkedin/actions.ts`
- Produces:
  - `seatIdentityKey(profileUrl: string | null | undefined): string | null`
  - `recordSeatIdentity(db: Db, workspaceId: string, seatKey: string, profileUrl: string | null | undefined, now: Date): Promise<string | null>`
  - `LinkedInSeat.identityConfirmedAt: string | null` and `LinkedInSeat.linkedSeatCount: number`
  - guard check `'linked-identity'`, always passing and informational
  - `SeatLedgerFacts.linkedSeats: number` and `SeatLedgerFacts.identityKnown: boolean`

**Design:**

- The identity key is the canonical profile URL the companion read from its own signed-in page. Only `detectLinkedInSeat()` writes it; an operator-typed `profileUrl` never links budgets.
- The rolling windows (24h, 7d, 30d, message pool, day-over-day buckets, acceptance) and the pending-invite backlog count every seat in the `linked` set.
- Duplicate-target, campaign and suppression checks stay per seat, so no other workspace's target can change a verdict detail.
- An unknown identity keeps today's per-seat behaviour, and `linked-identity` says so in words.

- [ ] **Step 1: Write the failing identity tests**

Create `src/server/linkedin/identity.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordSeatIdentity, seatIdentityKey } from './identity.js';
import { getSeat, upsertSeat } from './seats.js';

describe('seatIdentityKey', () => {
  it('folds every rendering of one profile into one key', () => {
    const key = 'https://www.linkedin.com/in/shared-founder';
    expect(seatIdentityKey('https://www.linkedin.com/in/shared-founder/')).toBe(key);
    expect(seatIdentityKey('https://linkedin.com/in/Shared-Founder?trk=nav')).toBe(key);
    expect(seatIdentityKey('https://www.linkedin.com/in/shared-founder/#about')).toBe(key);
  });

  it('refuses anything that is not a LinkedIn member profile', () => {
    expect(seatIdentityKey(null)).toBeNull();
    expect(seatIdentityKey('')).toBeNull();
    expect(seatIdentityKey('https://evil.example/in/shared-founder/')).toBeNull();
    expect(seatIdentityKey('https://www.linkedin.com/company/trevra/')).toBeNull();
  });
});

describe('recordSeatIdentity', () => {
  const A = 'ws_linkedin_identity_a';
  const B = 'ws_linkedin_identity_b';
  const NOW = new Date('2026-08-06T09:00:00.000Z');
  const PROFILE = 'https://www.linkedin.com/in/shared-founder/';
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    for (const workspaceId of [A, B]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db
        .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, workspaceId, NOW.toISOString());
      await upsertSeat(db, workspaceId, { label: `Seat ${workspaceId}`, timezone: 'UTC' }, NOW);
    }
  });

  afterEach(async () => {
    for (const workspaceId of [A, B])
      await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  it('links seats in two workspaces signed in as one member and shows each side only a count', async () => {
    expect(await recordSeatIdentity(db, A, 'owner', PROFILE, NOW)).toBe(
      'https://www.linkedin.com/in/shared-founder'
    );
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);

    await recordSeatIdentity(db, B, 'owner', 'https://linkedin.com/in/Shared-Founder', NOW);
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.identityConfirmedAt).toBe(NOW.toISOString());
    expect(seatA?.linkedSeatCount).toBe(1);
    expect(JSON.stringify(seatA)).not.toContain(B);
    expect(JSON.stringify(seatA)).not.toContain(`Seat ${B}`);
  });

  it('forgets the link when the signed-in profile cannot be read as a member', async () => {
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW);
    expect(await recordSeatIdentity(db, A, 'owner', null, NOW)).toBeNull();
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.identityConfirmedAt).toBeNull();
    expect(seatA?.linkedSeatCount).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing guard tests**

In `src/server/linkedin/guard.test.ts`, add one import after `import { upsertSeat } from './seats.js';`:

```ts
import { recordSeatIdentity } from './identity.js';
```

Append at the end of the file:

```ts
describe('one LinkedIn member across workspaces', () => {
  const OTHER = 'ws_linkedin_guard_neighbour';
  const PROFILE = 'https://www.linkedin.com/in/shared-founder/';

  beforeEach(async () => {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(OTHER);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(OTHER, 'Neighbour', NOW.toISOString());
    await upsertSeat(
      db,
      OTHER,
      { label: 'Other workspace seat', timezone: 'UTC' },
      new Date('2026-01-01T09:00:00.000Z')
    );
    for (let index = 0; index < 18; index += 1)
      await recordAction(
        db,
        {
          workspaceId: OTHER,
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/other-target-${index}/`,
          status: 'sent',
          source: 'export'
        },
        new Date(NOW.getTime() - 3_600_000)
      );
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(OTHER);
  });

  it("counts the neighbouring workspace's invites once both seats are confirmed as the same member", async () => {
    await seat('2026-01-01');
    const before = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(before, 'rolling-24h').passed).toBe(true);
    expect(check(before, 'linked-identity').passed).toBe(true);
    expect(check(before, 'linked-identity').detail).toContain('has not confirmed');

    await recordSeatIdentity(db, WORKSPACE_ID, 'owner', PROFILE, NOW);
    await recordSeatIdentity(db, OTHER, 'owner', PROFILE, NOW);
    const after = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(after, 'rolling-24h').passed).toBe(false);
    expect(check(after, 'rolling-24h').detail).toContain('18 of 18');
    expect(check(after, 'linked-identity').passed).toBe(true);
    expect(check(after, 'linked-identity').detail).toContain('1 other seat');
  });

  it('lets only counts cross the workspace boundary', async () => {
    await seat('2026-01-01');
    await recordSeatIdentity(db, WORKSPACE_ID, 'owner', PROFILE, NOW);
    await recordSeatIdentity(db, OTHER, 'owner', PROFILE, NOW);

    const verdict = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    const serialised = JSON.stringify(verdict);
    expect(serialised).not.toContain(OTHER);
    expect(serialised).not.toContain('other-target');
    expect(serialised).not.toContain('Other workspace seat');

    // The neighbour already invited this person; that is THEIR ledger. The
    // replay guard stays per seat, so it neither refuses nor names it here.
    const sameTarget = await guard(
      { targetRef: 'https://www.linkedin.com/in/other-target-0/' },
      { dayShape: FLAT_DAY_SHAPE }
    );
    expect(check(sameTarget, 'duplicate-target').passed).toBe(true);
  });

  it('keeps two different LinkedIn members on separate budgets', async () => {
    await seat('2026-01-01');
    await recordSeatIdentity(db, WORKSPACE_ID, 'owner', PROFILE, NOW);
    await recordSeatIdentity(db, OTHER, 'owner', 'https://www.linkedin.com/in/someone-else/', NOW);
    const verdict = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'rolling-24h').passed).toBe(true);
    expect(check(verdict, 'linked-identity').detail).toContain('No other workspace seat');
  });
});
```

- [ ] **Step 3: Write the failing detection test**

In `src/server/linkedin/credentials.test.ts`, inside `describe('detectLinkedInSeat on an account change', () => {`, add after the `'does not reset anything when the same account re-detects'` test:

```ts
it('confirms which LinkedIn member a seat signs in as, and links it across workspaces by count only', async () => {
  const { driver } = fakeDriver({ loggedIn: true });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID])
    await detectLinkedInSeat(db, config, {
      workspaceId,
      timezone: 'Europe/Zurich',
      now: NOW,
      driver,
      page,
      log: () => {}
    });

  const result = await detectLinkedInSeat(db, config, {
    workspaceId: WORKSPACE_ID,
    timezone: 'Europe/Zurich',
    now: NOW,
    driver,
    page,
    log: () => {}
  });
  expect(result.seat?.identityConfirmedAt).toBe(NOW.toISOString());
  expect(result.seat?.linkedSeatCount).toBe(1);

  const rows = await db
    .prepare(
      `SELECT workspace_id, identity_key FROM linkedin_seat_identities
         WHERE workspace_id = ANY(?::text[]) ORDER BY workspace_id`
    )
    .all<{ workspace_id: string; identity_key: string }>([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
  expect(rows).toEqual([
    { workspace_id: WORKSPACE_ID, identity_key: 'https://www.linkedin.com/in/pankaj' },
    { workspace_id: OTHER_WORKSPACE_ID, identity_key: 'https://www.linkedin.com/in/pankaj' }
  ]);
});
```

(`fakeDriver().readSeat` returns `profileUrl: 'https://www.linkedin.com/in/pankaj/'`. Do not assert `not.toContain(WORKSPACE_ID)` in this file: `OTHER_WORKSPACE_ID` contains `WORKSPACE_ID` as a substring.)

- [ ] **Step 4: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/identity.test.ts src/server/linkedin/guard.test.ts src/server/linkedin/credentials.test.ts`
Expected: FAIL.

- `identity.test.ts`: cannot resolve `./identity.js`.
- `guard.test.ts`: the new describe fails the same way.
- `credentials.test.ts`: `identityConfirmedAt` is `undefined`.

- [ ] **Step 5: Create `src/server/linkedin/identity.ts`**

```ts
import type { Db } from '../db.js';
import { normalisedProfileUrl } from './driver.js';

/**
 * WHICH LINKEDIN MEMBER A SEAT IS.
 *
 * LinkedIn limits a PERSON, not a Trevra workspace. A founder who connects the
 * same profile to two workspaces must get one budget, not two. The key is the
 * canonical profile URL the companion read off its OWN signed-in page during
 * detection -- never a URL an operator typed, which would let anyone attach
 * their seat to somebody else's budget.
 *
 * Lowercased and without the trailing slash, so every rendering of one handle
 * is one key. Null for anything that is not a `/in/<handle>` member profile.
 */
export function seatIdentityKey(profileUrl: string | null | undefined): string | null {
  if (!profileUrl) return null;
  const normalised = normalisedProfileUrl(profileUrl);
  if (!normalised) return null;
  const key = normalised.toLowerCase().replace(/\/+$/, '');
  return key.length > 0 && key.length <= 300 ? key : null;
}

/**
 * Record (or forget) the member this seat signed in as.
 *
 * Called only from `detectLinkedInSeat` after a successful `readSeat`, so the
 * fact written here was observed, not asserted. An unreadable profile removes
 * the link: a seat Trevra cannot identify falls back to its own per-seat
 * budget rather than keeping a stale claim to somebody else's.
 */
export async function recordSeatIdentity(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrl: string | null | undefined,
  now: Date
): Promise<string | null> {
  const key = seatIdentityKey(profileUrl);
  if (!key) {
    await db
      .prepare('DELETE FROM linkedin_seat_identities WHERE workspace_id=? AND seat_key=?')
      .run(workspaceId, seatKey);
    return null;
  }
  await db
    .prepare(
      `INSERT INTO linkedin_seat_identities (workspace_id, seat_key, identity_key, confirmed_at)
       VALUES (?,?,?,?::timestamptz)
       ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
         identity_key = excluded.identity_key,
         confirmed_at = excluded.confirmed_at`
    )
    .run(workspaceId, seatKey, key, now.toISOString());
  return key;
}
```

- [ ] **Step 6: Expose the identity on the seat (`src/server/linkedin/seats.ts`)**

1. In `export interface LinkedInSeat`, add directly before `proxy: SeatProxyView | null;`:

```ts
/**
 * When the companion last confirmed which LinkedIn member this seat signs in
 * as (`linkedin_seat_identities`). Null when never: the safety gate then
 * counts this seat alone.
 */
identityConfirmedAt: string | null;
/**
 * How many OTHER seats, in any workspace, signed in as the same member. Their
 * sends count against this seat's limits. A count only -- never which seats.
 */
linkedSeatCount: number;
```

2. In `interface SeatRow`, add after `proxy_has_password: boolean;`:

```ts
identity_confirmed_at: string | null;
linked_seat_count: number | null;
```

3. In `const SEAT_COLUMNS`, replace the final line `  proxy_has_password` with:

```ts
  proxy_has_password,
  (SELECT TO_CHAR(i.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     FROM linkedin_seat_identities i
    WHERE i.workspace_id = linkedin_seats.workspace_id AND i.seat_key = linkedin_seats.seat_key) AS identity_confirmed_at,
  (SELECT COUNT(*)::int
     FROM linkedin_seat_identities mine
     JOIN linkedin_seat_identities other ON other.identity_key = mine.identity_key
    WHERE mine.workspace_id = linkedin_seats.workspace_id AND mine.seat_key = linkedin_seats.seat_key
      AND NOT (other.workspace_id = mine.workspace_id AND other.seat_key = mine.seat_key)) AS linked_seat_count
```

(Every use of `SEAT_COLUMNS` reads from the unaliased `linkedin_seats`, as the existing `owner_name` subquery already relies on. That covers the `SELECT ... FROM linkedin_seats` reads and the `RETURNING` lists.)

4. In `function toSeat`, add directly before the `proxy:` property:

```ts
    identityConfirmedAt: row.identity_confirmed_at ?? null,
    linkedSeatCount: Number(row.linked_seat_count ?? 0),
```

- [ ] **Step 7: Count across linked seats in the guard (`src/server/linkedin/guard.ts`)**

1. In `export type LinkedInCheckName`, replace `  | 'duplicate-target';` with:

```ts
  | 'duplicate-target'
  | 'linked-identity';
```

2. In `export const LINKEDIN_CHECK_NAMES`, replace `  'duplicate-target'\n] as const` with `  'duplicate-target',\n  'linked-identity'\n] as const`.

3. In `interface SeatLedgerFacts`, add after `suppressionReason: string | null;`:

```ts
/** Seats counted in the windows above: this one plus every seat confirmed as the same member. */
linkedSeats: number;
/** Whether the companion ever confirmed which member this seat signs in as. */
identityKnown: boolean;
```

4. In `seatLedgerFacts()`, replace the opening of the SQL from `WITH windowed AS (` through the end of the `windowed` CTE:

```sql
      WITH windowed AS (
        SELECT kind, status, recorded_at FROM linkedin_actions
        WHERE workspace_id=? AND seat_key=? AND kind = ANY(?::text[]) AND recorded_at > ?::timestamptz
      ),
```

with:

```sql
      WITH linked AS (
        -- THIS seat, plus every seat (any workspace) the companion confirmed
        -- as the same LinkedIn member. Only aggregates over this set leave
        -- the statement; no row, target or label of another workspace does.
        SELECT ?::text AS workspace_id, ?::text AS seat_key
        UNION
        SELECT other.workspace_id, other.seat_key
        FROM linkedin_seat_identities mine
        JOIN linkedin_seat_identities other ON other.identity_key = mine.identity_key
        WHERE mine.workspace_id=? AND mine.seat_key=?
      ),
      windowed AS (
        SELECT kind, status, recorded_at FROM linkedin_actions
        WHERE (workspace_id, seat_key) IN (SELECT workspace_id, seat_key FROM linked)
          AND kind = ANY(?::text[]) AND recorded_at > ?::timestamptz
      ),
```

5. In the same SQL, replace the pending-invite subquery:

```sql
        (SELECT COUNT(*)::int FROM linkedin_actions
           WHERE workspace_id=? AND seat_key=? AND kind='invite' AND status IN ('sent', 'exported')) AS pending_invites,
```

with:

```sql
        (SELECT COUNT(*)::int FROM linkedin_actions
           WHERE (workspace_id, seat_key) IN (SELECT workspace_id, seat_key FROM linked)
             AND kind='invite' AND status IN ('sent', 'exported')) AS pending_invites,
        (SELECT COUNT(*)::int FROM linked) AS linked_seats,
        EXISTS (SELECT 1 FROM linkedin_seat_identities
           WHERE workspace_id=? AND seat_key=?) AS identity_known,
```

6. In the `.get<{ ... }>` type, add `linked_seats: number; identity_known: boolean;` after `pending_invites: number;`.

7. In the parameter list, replace the first two arguments `seat.workspaceId,\n      seat.seatKey,\n      scanKinds,` with:

```ts
      seat.workspaceId,
      seat.seatKey,
      seat.workspaceId,
      seat.seatKey,
      scanKinds,
```

Leave the pair `seat.workspaceId,\n      seat.seatKey,` that follows `sinceAcceptance,\n      sinceAcceptance,` unchanged. It used to bind the pending-invite subquery, which now binds nothing, and it now binds `identity_known`, the next placeholder pair in statement order. The count is unchanged.

8. In the `return {` of `seatLedgerFacts()`, replace the line `    suppressionReason: row?.suppression_reason ?? null` with:

```ts
    suppressionReason: row?.suppression_reason ?? null,
    linkedSeats: Number(row?.linked_seats ?? 1),
    identityKnown: row?.identity_known === true
```

9. In `evaluateLinkedInSafety()`, insert directly before `  const failed = checks.find((entry) => !entry.passed);`:

```ts
// ONE LINKEDIN MEMBER, ONE BUDGET. Informational and always passing: every
// window above already counted each seat confirmed as this member, so any
// refusal belongs to those checks. This line only says whose sends were in
// the count -- as an integer, never as a name, target or workspace.
// lc-debt: `planPacing` (pacing.ts) still spreads each seat's own ceiling; the
// gate is the authority across linked seats. Upgrade path: feed linked-seat
// usage into planPacing so slots are not planned that the gate will refuse.
const otherLinkedSeats = Math.max(0, ledger.linkedSeats - 1);
checks.push({
  check: 'linked-identity',
  passed: true,
  detail: !ledger.identityKnown
    ? 'Trevra has not confirmed which LinkedIn member this seat signs in as, so the limits above count this seat only. Detect the account once to share one budget with any other workspace seat signed in as the same member.'
    : otherLinkedSeats > 0
      ? `Counts include ${otherLinkedSeats} other seat${otherLinkedSeats === 1 ? '' : 's'} signed in as the same LinkedIn member. Only counts are shared; no targets, messages or names cross the workspace boundary.`
      : 'No other workspace seat signs in as this LinkedIn member, so limits count this seat alone.'
});
```

- [ ] **Step 8: Record the identity on detection (`src/server/linkedin/local-worker.ts`)**

`local-worker.ts` is detected as binary by grep; read it with `sed -n` or `grep -a`.

1. Add the import after the `} from './seats.js';` import block:

```ts
import { recordSeatIdentity } from './identity.js';
```

2. In `detectLinkedInSeat()`, find `  const seat = await upsertSeat(` and the call's closing `    now,\n    seatKey\n  );`. Directly after that closing line, insert:

```ts
// WHICH MEMBER THIS SEAT IS. The profile just read is the companion's own
// signed-in page, so it is the one fact that may link this seat's limits to
// another workspace's seat signed in as the same person (guard.ts).
await recordSeatIdentity(db, options.workspaceId, seatKey, read.profileUrl, now);
```

3. In the `return {` that follows, replace the line `    seat,` with:

```ts
    seat: (await getSeat(db, options.workspaceId, seatKey)) ?? seat,
```

(`getSeat` is already imported from `./seats.js` in this file.)

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/identity.test.ts src/server/linkedin/guard.test.ts src/server/linkedin/credentials.test.ts src/server/linkedin/api.test.ts src/server/linkedin/local-worker.test.ts`
Expected: PASS. `api.test.ts` and `guard.test.ts` compare against `[...LINKEDIN_CHECK_NAMES]`, so they pick up `'linked-identity'` automatically.

- [ ] **Step 10: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/linkedin/identity.ts src/server/linkedin/identity.test.ts src/server/linkedin/seats.ts src/server/linkedin/guard.ts src/server/linkedin/guard.test.ts src/server/linkedin/local-worker.ts src/server/linkedin/credentials.test.ts
git commit -m "feat(linkedin): share one member's budget across workspaces" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 4: Human-send mode on a seat; the worker never claims those rows

**Files:**

- Modify: `src/server/linkedin/seats.ts` (`HUMAN_SEND_KINDS`, `isHumanSendKind`, `SeatSendMode`, `LinkedInSeat.sendMode`, `SeatPatch.sendMode`, `SeatRow`, `SEAT_COLUMNS`, `toSeat`, `upsertSeat`)
- Modify: `src/server/linkedin/local-worker.ts` (claim, `dueManualWork`, `dueSeatsForWorker`, `detectLinkedInSeat`)
- Modify: `src/server/linkedin/execution-state.ts` (`LinkedInCampaignExecution.humanSendNext`)
- Modify: `src/server/app.ts` (`linkedinSeatSchema`)
- Modify: `src/client/LinkedInExecutionBlocker.test.ts` (fixture gains `humanSendNext: false`)
- Test: `src/server/linkedin/local-worker.test.ts`, `src/server/linkedin/execution-state.test.ts`, `src/server/linkedin/manager-api.test.ts`, `src/server/linkedin/credentials.test.ts`

**Interfaces:**

- Produces:
  - `export const HUMAN_SEND_KINDS = ['invite', 'dm', 'reply', 'inmail', 'group_message', 'event_message'] as const;`
  - `export type HumanSendKind`, `export function isHumanSendKind(kind: string): kind is HumanSendKind`
  - `export type SeatSendMode = 'automated' | 'human'`
  - `LinkedInSeat.sendMode: SeatSendMode`, `SeatPatch.sendMode?: SeatSendMode`
  - `LinkedInCampaignExecution.humanSendNext: boolean`
  - the PATCH `/api/linkedin/manager/seats/:seatKey` body accepts `sendMode`
- Kinds deliberately NOT handed to a human: `profile_view`, `follow`, `unfollow`, `disconnect`, `like`, `endorse`, `company_*`, `event_invite`, `group_invite`. They stay automated on a human seat. This matches the switch copy shown in Task 6.

- [ ] **Step 1: Write the failing worker test**

In `src/server/linkedin/local-worker.test.ts`, inside `describe.skipIf(!databaseUrl)('multi-seat draining', () => {`, add after the `"claims only its own seat's rows, never the neighbouring account's"` test:

```ts
it('NEVER CLAIMS AN INVITE OR MESSAGE FROM A HUMAN-SEND SEAT, but still claims its profile views', async () => {
  await upsertSeat(db, WORKSPACE_ID, { sendMode: 'human' }, LONG_AGO, 'sales');
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
         VALUES ('lact_human_dm',?,'sales','dm','https://www.linkedin.com/in/human-dm/','planned',?,'manual','Hello by hand',?),
                ('lact_human_invite',?,'sales','invite','https://www.linkedin.com/in/human-invite/','planned',?,'export',NULL,?)`
    )
    .run(
      WORKSPACE_ID,
      NOW.toISOString(),
      NOW.toISOString(),
      WORKSPACE_ID,
      NOW.toISOString(),
      NOW.toISOString()
    );
  await plan('sales', 'lact_human_view', 'https://www.linkedin.com/in/human-view/');

  const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'sales');
  const batchId = await store.openBatch(NOW);
  expect((await store.claimNextDueAction(batchId, NOW))?.id).toBe('lact_human_view');
  expect(await store.claimNextDueAction(batchId, NOW)).toBeNull();
  // A manual DM would normally wake the browser outside working hours.
  expect(await dueManualWork(db, WORKSPACE_ID, 'sales', NOW)).toBe(false);
  // Nothing left that a browser may take, so discovery does not list the seat.
  expect(
    (await seatsWithDueActions(db, NOW)).filter((seat) => seat.workspaceId === WORKSPACE_ID)
  ).toEqual([]);

  // Switching back hands the same rows straight back to the worker.
  await upsertSeat(db, WORKSPACE_ID, { sendMode: 'automated' }, NOW, 'sales');
  const claimed = await store.claimNextDueAction(batchId, NOW);
  expect(['lact_human_dm', 'lact_human_invite']).toContain(claimed?.id);
});
```

- [ ] **Step 2: Write the failing execution-state test**

In `src/server/linkedin/execution-state.test.ts`, inside `describe('campaign execution state', () => {`, add as the first test:

```ts
it('says the next due row waits for a person when the seat sends invites and messages by hand', async () => {
  await insertAction({ id: 'lact_exec_human', kind: 'invite', handle: 'human-next' });
  expect((await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW)).humanSendNext).toBe(false);

  await upsertSeat(db, WORKSPACE, { sendMode: 'human' }, NOW, SEAT);
  expect((await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW)).humanSendNext).toBe(true);
});
```

- [ ] **Step 3: Write the failing API and detection tests**

In `src/server/linkedin/manager-api.test.ts`, add after `'round-trips the account warm-up override through the manager seat PATCH API'`:

```ts
it('round-trips human-send mode through the manager seat PATCH API', async () => {
  const updated = (
    await as(tokenA)
      .patch('/api/linkedin/manager/seats/owner')
      .send({ sendMode: 'human' })
      .expect(200)
  ).body.seat as { sendMode: string };
  expect(updated.sendMode).toBe('human');
  await as(tokenA)
    .patch('/api/linkedin/manager/seats/owner')
    .send({ sendMode: 'robot' })
    .expect(400);
  const listed = (await as(tokenB).get('/api/linkedin/manager/seats').expect(200)).body.seats as {
    sendMode: string;
  }[];
  expect(listed.map((seat) => seat.sendMode)).toEqual(['automated']);
});
```

In `src/server/linkedin/credentials.test.ts`, inside `describe('detectLinkedInSeat on an account change', () => {`, add:

```ts
it('keeps human-send mode across an account change', async () => {
  await upsertSeat(
    db,
    WORKSPACE_ID,
    {
      label: 'Pankaj (founder)',
      timezone: 'Europe/Zurich',
      profileUrl: PREVIOUS_PROFILE,
      sendMode: 'human'
    },
    NOW
  );
  const { driver } = fakeDriver({ loggedIn: true });
  driver.readSeat = async () => ({
    ok: true,
    profileUrl: NEW_PROFILE,
    name: 'Daryna Radiichuk',
    connectionsCount: 512,
    degraded: []
  });
  const result = await detectLinkedInSeat(db, config, {
    workspaceId: WORKSPACE_ID,
    timezone: 'Europe/Zurich',
    now: new Date(NOW.getTime() + 86_400_000),
    driver,
    page,
    log: () => {}
  });
  expect(result.seat?.profileUrl).toBe(NEW_PROFILE);
  expect(result.seat?.sendMode).toBe('human');
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/local-worker.test.ts src/server/linkedin/execution-state.test.ts src/server/linkedin/manager-api.test.ts src/server/linkedin/credentials.test.ts`
Expected: FAIL.

- The worker test claims `lact_human_dm` or `lact_human_invite` second, so the `toBeNull()` assertion fails.
- `humanSendNext` is `undefined`.
- PATCH `{sendMode}` is 400 (`.strict()` schema).
- `sendMode` is `undefined` after detection.

- [ ] **Step 5: Add `sendMode` to the seat (`src/server/linkedin/seats.ts`)**

1. Directly after `export const OWNER_SEAT_KEY = 'owner';` (line ~64), add:

```ts
/**
 * The kinds a founder in human-send mode sends by hand: everything that puts
 * words or an invitation in front of a person. Passive kinds (views, follows,
 * likes, endorsements, company/event/group invitations) stay automated.
 */
export const HUMAN_SEND_KINDS = [
  'invite',
  'dm',
  'reply',
  'inmail',
  'group_message',
  'event_message'
] as const;
export type HumanSendKind = (typeof HUMAN_SEND_KINDS)[number];
export function isHumanSendKind(kind: string): kind is HumanSendKind {
  return (HUMAN_SEND_KINDS as readonly string[]).includes(kind);
}

/** `automated`: the browser worker sends. `human`: Today hands invites and messages to the founder. */
export type SeatSendMode = 'automated' | 'human';
```

2. In `export interface LinkedInSeat`, add after `warmupOverride: boolean;`:

```ts
/** Who sends this seat's invites and messages. See `HUMAN_SEND_KINDS`. */
sendMode: SeatSendMode;
```

3. In `export interface SeatPatch`, add before `proxyUrl?: string | null;`:

```ts
  /** Absent means unchanged. */
  sendMode?: SeatSendMode;
```

4. In `interface SeatRow`, add after `proxy_has_password: boolean;`: `  send_mode: string | null;`

5. In `const SEAT_COLUMNS`, replace `  warmup_override,` with `  warmup_override,\n  send_mode,`.

6. In `function toSeat`, add after `warmupOverride: row.warmup_override === true,`:

```ts
    sendMode: row.send_mode === 'human' ? 'human' : 'automated',
```

7. In `upsertSeat()`:
   - After `const warmupOverride = patch.warmupOverride ?? existing?.warmupOverride ?? false;`, add `  const sendMode: SeatSendMode = patch.sendMode ?? existing?.sendMode ?? 'automated';`.
   - In the INSERT column list, replace `safety_band_override, warmup_override, created_at, updated_at` with `safety_band_override, warmup_override, send_mode, created_at, updated_at`.
   - In `VALUES (...)`, add one more `?` before the final two (there are 25 placeholders after the change). The tail `?,?,?,?,?,?,?,?)` becomes `?,?,?,?,?,?,?,?,?)`.
   - In `ON CONFLICT ... DO UPDATE SET`, replace `      warmup_override = excluded.warmup_override,` with `      warmup_override = excluded.warmup_override,\n      send_mode = excluded.send_mode,`.
   - In `.run(...)`, replace `      warmupOverride,\n      timestamp,\n      timestamp` with `      warmupOverride,\n      sendMode,\n      timestamp,\n      timestamp`.

- [ ] **Step 6: Exclude human-send rows from the worker (`src/server/linkedin/local-worker.ts`)**

1. In the `import { ... } from './seats.js';` block, add `  HUMAN_SEND_KINDS,` after `  OWNER_SEAT_KEY,`.

2. Directly after `const BODY_REQUIRED_LIST = KINDS_REQUIRING_BODY.map((kind) => \`'${kind}'\`).join(', ');`, add:

```ts
const HUMAN_SEND_KIND_LIST = HUMAN_SEND_KINDS.map((kind) => `'${kind}'`).join(', ');
/**
 * A row the founder sends by hand: an invite or message on a seat in
 * human-send mode. No browser may claim it, wake for it, or list its seat as
 * having work -- `handoff.ts` puts it in Today instead. `table` is the alias
 * (or bare table name) the surrounding statement uses for linkedin_actions.
 */
function humanSendHandoffPredicate(table: string): string {
  return `(${table}.kind IN (${HUMAN_SEND_KIND_LIST}) AND EXISTS (
    SELECT 1 FROM linkedin_seats hs
    WHERE hs.workspace_id = ${table}.workspace_id AND hs.seat_key = ${table}.seat_key
      AND hs.send_mode = 'human'))`;
}
```

3. In `dueManualWork()`, replace:

```sql
        AND (source = 'manual' OR (kind = 'reply' AND reply_to_inbound = true))
```

with:

```sql
        AND (source = 'manual' OR (kind = 'reply' AND reply_to_inbound = true))
        AND NOT ${humanSendHandoffPredicate('linkedin_actions')}
```

4. In `claimNextDueAction` (inside `postgresLocalWorkerStore`), in the inner `SELECT id FROM linkedin_actions WHERE ...`, replace `            AND target_ref IS NOT NULL` with:

```sql
            AND target_ref IS NOT NULL
            -- Human-send mode: the founder sends these by hand from Today.
            AND NOT ${humanSendHandoffPredicate('linkedin_actions')}
```

5. In `dueSeatsForWorker()` there are two `AND a.kind IN (${EXECUTABLE_KIND_LIST})` lines: the `CROSS JOIN LATERAL` discovery (~2692) and the `WITH candidate AS` orphan scan (~2742). Replace each with:

```sql
          AND a.kind IN (${EXECUTABLE_KIND_LIST})
          AND NOT ${humanSendHandoffPredicate('a')}
```

6. In `detectLinkedInSeat()`, inside the `upsertSeat(` patch object, replace the last property line `      sessionValidAt: now.toISOString()` with:

```ts
      sessionValidAt: now.toISOString(),
      // How the founder chose to work survives an account change, like the
      // label: it describes this workspace's seat, not the LinkedIn account.
      ...(existing ? { sendMode: existing.sendMode } : {})
```

(`existing` is captured before `deleteSeat()` runs on an account change, so the value survives the reset.)

- [ ] **Step 7: Expose `humanSendNext` (`src/server/linkedin/execution-state.ts`)**

1. Replace `import { getSeat, OWNER_SEAT_KEY } from './seats.js';` with `import { getSeat, isHumanSendKind, OWNER_SEAT_KEY } from './seats.js';`.

2. In `export interface LinkedInCampaignExecution`, add after `gate: LinkedInCampaignExecutionGate | null;`:

```ts
/**
 * The next due row is an invite or message on a human-send seat: nothing is
 * broken, the founder sends it by hand from Today.
 */
humanSendNext: boolean;
```

3. In `campaignExecutionState()`'s `return {`, replace the last property `    gate: dueRow ? await gateVerdict(db, workspaceId, dueRow, now) : null` with:

```ts
    gate: dueRow ? await gateVerdict(db, workspaceId, dueRow, now) : null,
    humanSendNext: seat?.sendMode === 'human' && Boolean(dueRow) && isHumanSendKind(dueRow!.kind)
```

4. In `src/client/LinkedInExecutionBlocker.test.ts`, in `function execution(...)`, add `    humanSendNext: false,` before `    ...patch`.

- [ ] **Step 8: Accept `sendMode` in the seat PATCH schema (`src/server/app.ts`)**

In `const linkedinSeatSchema` (~line 9096), add after `    warmupOverride: z.boolean().optional(),`:

```ts
    sendMode: z.enum(['automated', 'human']).optional(),
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/local-worker.test.ts src/server/linkedin/execution-state.test.ts src/server/linkedin/manager-api.test.ts src/server/linkedin/credentials.test.ts src/client/LinkedInExecutionBlocker.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/linkedin/seats.ts src/server/linkedin/local-worker.ts src/server/linkedin/execution-state.ts src/server/app.ts src/server/linkedin/local-worker.test.ts src/server/linkedin/execution-state.test.ts src/server/linkedin/manager-api.test.ts src/server/linkedin/credentials.test.ts src/client/LinkedInExecutionBlocker.test.ts
git commit -m "feat(linkedin): add per-seat human-send mode" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 5: Handoffs — list, resolve, and surface them in Today

**Files:**

- Create: `src/server/linkedin/handoff.ts`, `src/server/linkedin/handoff.test.ts`
- Modify: `src/server/linkedin/execution-state.ts` (export `gateVerdict` and `NextDueRow`; `options` parameter)
- Modify: `src/server/linkedin/local-worker.ts` (export `advanceManagedMemberAfterSettledLinkedInAction`)
- Modify: `src/server/linkedin/action-ledger.ts` (invariant comment names the second reporting route)
- Modify: `src/server/today.ts`, `src/server/app.ts`
- Test: `src/server/today.test.ts`, `src/server/linkedin/manager-api.test.ts`

**Interfaces:**

- Consumes:
  - `ingestOutcome(db, OutcomeIngest, now)` and `skipAction(db, workspaceId, actionId, now)` from `action-ledger.ts`
  - `postgresLocalWorkerStore(db, workspaceId, seatKey)`, with `.actionExecutionState(action)` and `.branchDecision(action, now)`
  - `KINDS_REQUIRING_BODY`, `DueLinkedInAction` and `ExecutableKind` from `local-worker.ts`
  - `profileUrlFor(target)` from `driver.ts`
  - `appendDomainEvent()` from `control-plane/events.ts`
  - `HUMAN_SEND_KINDS` and `isHumanSendKind` (Task 4)
- Produces:
  - `interface LinkedInHandoff { actionId; seatKey; seatLabel; kind: HumanSendKind; targetRef; targetUrl: string | null; copyText: string | null; subject: string | null; plannedFor; campaignId: string | null; campaignName: string | null }`
  - `listLinkedInHandoffs(db, workspaceId, now, options?: Pick<LinkedInSafetyOptions, 'dayShape'>): Promise<LinkedInHandoff[]>`, with at most one handoff per human seat
  - `handoffTitle(kind: string, seatLabel: string): string`
  - `handoffResolutionSchema` (`{ resolution: 'sent' | 'skip' }`, strict)
  - `resolveLinkedInHandoff(db, { workspaceId, actionId, resolution, actorUserId }, now): Promise<{ actionId: string; status: 'sent' | 'skipped' }>`
  - Today item `kind: 'linkedin_handoff_waiting'`, `priority: 42`, `reference: { type: 'linkedin_action', id }`, with `metadata: { actionId, actionKind, seatKey, copyText, subject, targetUrl, campaignName, channel: 'linkedin' }`
  - `POST /api/linkedin/handoffs/:id/resolve` → `{ handoff: { actionId, status } }`; any workspace member may call it

**Design:**

- A handoff is the row the worker would claim next on that seat:
  - it uses the claim's predicates and order (`execution-state.ts` `NextDueRow` SQL), restricted to `HUMAN_SEND_KINDS` on `send_mode='human'` seats;
  - it must pass the worker's own `actionExecutionState` and `branchDecision`;
  - it must pass `evaluateLinkedInSafety` (via `gateVerdict`).
- The founder is never handed a send the account limits refuse.
- "Mark sent" uses `ingestOutcome`, which stamps `recorded_at`, so every window counts it. Then it advances the campaign member exactly as `settleSent` does. "Skip" uses `skipAction`, then advances like `settleBranchSkipped`.
- The handoff list query is bounded: ten candidates per seat (`CANDIDATES_PER_SEAT`, lc-debt).

- [ ] **Step 1: Write the failing handoff tests**

Create `src/server/linkedin/handoff.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { evaluateLinkedInSafety } from './guard.js';
import { handoffTitle, listLinkedInHandoffs, resolveLinkedInHandoff } from './handoff.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { upsertSeat } from './seats.js';

const WORKSPACE = 'ws_linkedin_handoff_test';
const OTHER = 'ws_linkedin_handoff_other';
// A Tuesday, 10:00 UTC: inside the default 09:00-17:00 working window.
const NOW = new Date('2026-08-04T10:00:00.000Z');
const SATURDAY = new Date('2026-08-08T10:00:00.000Z');
const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
let db: Db;

async function plan(
  actionId: string,
  kind: string,
  target: string,
  body: string | null,
  workspaceId = WORKSPACE
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
       VALUES (?,?,'owner',?,?,'planned',?,'export',?,?)`
    )
    .run(
      actionId,
      workspaceId,
      kind,
      target,
      new Date(NOW.getTime() - 60_000).toISOString(),
      body,
      NOW.toISOString()
    );
}

function resolve(actionId: string, resolution: 'sent' | 'skip', workspaceId = WORKSPACE) {
  return resolveLinkedInHandoff(db, { workspaceId, actionId, resolution, actorUserId: null }, NOW);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder', timezone: 'UTC', sendMode: 'human' },
    LONG_AGO
  );
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});

describe('LinkedIn human-send handoffs', () => {
  it('lists the next gated invite or message for a human-send seat with its approved copy', async () => {
    await plan(
      'lact_handoff_dm',
      'dm',
      'https://www.linkedin.com/in/maya-handoff/',
      'Hi Maya, thanks for connecting.'
    );
    await plan(
      'lact_handoff_view',
      'profile_view',
      'https://www.linkedin.com/in/view-handoff/',
      null
    );

    const handoffs = await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(handoffs).toEqual([
      expect.objectContaining({
        actionId: 'lact_handoff_dm',
        kind: 'dm',
        seatKey: 'owner',
        seatLabel: 'Founder',
        copyText: 'Hi Maya, thanks for connecting.',
        targetUrl: 'https://www.linkedin.com/in/maya-handoff/'
      })
    ]);
    expect(handoffTitle('dm', 'Founder')).toBe('Send a LinkedIn message from Founder');
    expect(handoffTitle('invite', 'Founder')).toBe('Send a LinkedIn invite from Founder');
  });

  it('lists nothing for an automated seat', async () => {
    await upsertSeat(db, WORKSPACE, { sendMode: 'automated' }, NOW);
    await plan('lact_handoff_auto', 'dm', 'https://www.linkedin.com/in/auto-handoff/', 'Hello');
    expect(await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE })).toEqual(
      []
    );
  });

  it('holds back a handoff the account limits would refuse', async () => {
    await plan('lact_handoff_weekend', 'dm', 'https://www.linkedin.com/in/weekend/', 'Hello');
    expect(
      await listLinkedInHandoffs(db, WORKSPACE, SATURDAY, { dayShape: FLAT_DAY_SHAPE })
    ).toEqual([]);
  });

  it('marks a handoff sent exactly once, and the guard counts it', async () => {
    await plan('lact_handoff_invite', 'invite', 'https://www.linkedin.com/in/jonas-handoff/', null);

    const first = await resolve('lact_handoff_invite', 'sent');
    const second = await resolve('lact_handoff_invite', 'sent');
    expect(first).toEqual({ actionId: 'lact_handoff_invite', status: 'sent' });
    expect(second).toEqual(first);

    const row = await db
      .prepare('SELECT status, recorded_at FROM linkedin_actions WHERE id=?')
      .get<{ status: string; recorded_at: unknown }>('lact_handoff_invite');
    expect(row?.status).toBe('sent');
    expect(row?.recorded_at).not.toBeNull();

    const events = await listDomainEvents(db, WORKSPACE, {
      streamType: 'linkedin_action',
      streamId: 'lact_handoff_invite'
    });
    expect(
      events.filter((event) => event.eventType === 'linkedin.handoff.marked_sent')
    ).toHaveLength(1);

    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/jonas-handoff/',
        plannedFor: NOW.toISOString()
      },
      NOW,
      { dayShape: FLAT_DAY_SHAPE }
    );
    expect(verdict.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(false);
    expect(verdict.checks.find((entry) => entry.check === 'rolling-24h')?.detail).toContain('1 of');
  });

  it('refuses to mark a skipped handoff sent', async () => {
    await plan('lact_handoff_skip', 'dm', 'https://www.linkedin.com/in/skip-handoff/', 'Hello');
    expect(await resolve('lact_handoff_skip', 'skip')).toEqual({
      actionId: 'lact_handoff_skip',
      status: 'skipped'
    });
    await expect(resolve('lact_handoff_skip', 'sent')).rejects.toMatchObject({ status: 409 });
    const row = await db
      .prepare('SELECT status FROM linkedin_actions WHERE id=?')
      .get<{ status: string }>('lact_handoff_skip');
    expect(row?.status).toBe('skipped');
  });

  it('never resolves another workspace action, nor a row on an automated seat', async () => {
    await upsertSeat(db, OTHER, { label: 'Other', timezone: 'UTC', sendMode: 'human' }, LONG_AGO);
    await plan(
      'lact_handoff_other',
      'dm',
      'https://www.linkedin.com/in/other-handoff/',
      'Hello',
      OTHER
    );
    await expect(resolve('lact_handoff_other', 'sent')).rejects.toMatchObject({ status: 404 });

    await upsertSeat(db, WORKSPACE, { sendMode: 'automated' }, NOW);
    await plan('lact_handoff_robot', 'dm', 'https://www.linkedin.com/in/robot-handoff/', 'Hello');
    await expect(resolve('lact_handoff_robot', 'sent')).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Write the failing Today and route tests**

In `src/server/today.test.ts`:

- Replace `import { pauseSeat, upsertSeat } from './linkedin/seats.js';` with `import { pauseSeat, upsertSeat } from './linkedin/seats.js';\nimport { resolveLinkedInHandoff } from './linkedin/handoff.js';`.
- Inside `describe('getToday', () => {`, add before `'never leaks another workspace into the projection'`:

```ts
it('hands a gated invite on a human-send seat to the founder, and drops it once marked sent', async () => {
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder LinkedIn', timezone: 'Europe/Zurich', sendMode: 'human' },
    new Date('2026-01-05T09:00:00.000Z')
  );
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
         VALUES ('lact_today_handoff',?,'owner','invite','https://www.linkedin.com/in/today-handoff/','planned',?,'export','Hi, glad to connect.',?)`
    )
    .run(WORKSPACE, '2026-08-21T07:30:00.000Z', '2026-08-21T07:00:00.000Z');

  const today = await getToday(db, WORKSPACE, NOW);
  const handoff = today.needsAttention.find((item) => item.kind === 'linkedin_handoff_waiting');
  expect(handoff).toMatchObject({
    id: 'linkedin_handoff:lact_today_handoff',
    priority: 42,
    title: 'Send a LinkedIn invite from Founder LinkedIn',
    href: '/outreach',
    reference: { type: 'linkedin_action', id: 'lact_today_handoff' },
    metadata: {
      actionId: 'lact_today_handoff',
      actionKind: 'invite',
      seatKey: 'owner',
      copyText: 'Hi, glad to connect.',
      targetUrl: 'https://www.linkedin.com/in/today-handoff/',
      channel: 'linkedin'
    }
  });

  await resolveLinkedInHandoff(
    db,
    {
      workspaceId: WORKSPACE,
      actionId: 'lact_today_handoff',
      resolution: 'sent',
      actorUserId: null
    },
    NOW
  );
  const after = await getToday(db, WORKSPACE, NOW);
  expect(after.needsAttention.filter((item) => item.kind === 'linkedin_handoff_waiting')).toEqual(
    []
  );
});
```

(`NOW` here is `2026-08-21T08:00:00.000Z`, which is 10:00 on a Friday in Europe/Zurich. The seat is past warm-up, has no history, and gets the real day shape. That is the same footing as the existing `capacity_block` tests in this file, where a first action is allowed.)

In `src/server/linkedin/manager-api.test.ts`, add after the human-send PATCH test from Task 4:

```ts
it('lets the workspace resolve its own handoff and nobody else', async () => {
  await upsertSeat(db, A, { sendMode: 'human' }, NOW);
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
         VALUES ('lact_manager_handoff',?,'owner','dm','https://www.linkedin.com/in/handoff-api/','planned',?,'export','Hello',?)`
    )
    .run(A, NOW.toISOString(), NOW.toISOString());

  await as(tokenB)
    .post('/api/linkedin/handoffs/lact_manager_handoff/resolve')
    .send({ resolution: 'sent' })
    .expect(404);
  await as(tokenA)
    .post('/api/linkedin/handoffs/lact_manager_handoff/resolve')
    .send({ resolution: 'later' })
    .expect(400);
  const done = await as(tokenA)
    .post('/api/linkedin/handoffs/lact_manager_handoff/resolve')
    .send({ resolution: 'sent' })
    .expect(200);
  expect(done.body.handoff).toEqual({ actionId: 'lact_manager_handoff', status: 'sent' });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/handoff.test.ts src/server/today.test.ts src/server/linkedin/manager-api.test.ts`
Expected: FAIL.

- `handoff.test.ts` and `today.test.ts`: cannot resolve `./handoff.js`.
- The route test gets 404 `API route not found` for tenant A as well.

- [ ] **Step 4: Export what the handoff reuses**

In `src/server/linkedin/execution-state.ts`:

1. Replace `import { evaluateLinkedInSafety, type LinkedInCheckName } from './guard.js';` with `import { evaluateLinkedInSafety, type LinkedInCheckName, type LinkedInSafetyOptions } from './guard.js';`.
2. Replace `interface NextDueRow {` with `export interface NextDueRow {`.
3. Replace the `gateVerdict` signature and its options argument:

```ts
export async function gateVerdict(
  db: Db,
  workspaceId: string,
  row: NextDueRow,
  now: Date,
  options: Pick<LinkedInSafetyOptions, 'dayShape'> = {}
): Promise<LinkedInCampaignExecutionGate | null> {
```

and, inside it, replace `      { excludeActionId: row.id }` with `      { ...options, excludeActionId: row.id }`.

In `src/server/linkedin/local-worker.ts`, replace `async function advanceManagedMemberAfterSettledLinkedInAction(` with `export async function advanceManagedMemberAfterSettledLinkedInAction(`.

- [ ] **Step 5: Create `src/server/linkedin/handoff.ts`**

```ts
import { z } from 'zod';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { ingestOutcome, skipAction } from './action-ledger.js';
import { profileUrlFor } from './driver.js';
import { LinkedInApiError } from './errors.js';
import { gateVerdict, type NextDueRow } from './execution-state.js';
import type { LinkedInSafetyOptions } from './guard.js';
import {
  KINDS_REQUIRING_BODY,
  advanceManagedMemberAfterSettledLinkedInAction,
  postgresLocalWorkerStore,
  type DueLinkedInAction,
  type ExecutableKind,
  type LocalWorkerStore
} from './local-worker.js';
import { HUMAN_SEND_KINDS, isHumanSendKind, type HumanSendKind } from './seats.js';

/* ---------------------------------------------------------------------------
 * HUMAN-SEND HANDOFFS.
 *
 * A seat in human-send mode keeps its invites and messages out of the browser
 * worker (local-worker.ts). They are still drafted, approved and gated exactly
 * like automated ones; this module hands the founder the ONE row the worker
 * would have taken next, and only once the safety gate would let it go. The
 * founder sends it on LinkedIn and reports back. Nothing here ever sends.
 * ------------------------------------------------------------------------ */

// lc-debt: ceiling of ten candidate rows per human seat per Today read, and
// one handoff per seat; upgrade path is a cursor over the claim order if a
// founder ever needs more than one queued send at a time.
const CANDIDATES_PER_SEAT = 10;
const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const HUMAN_SEND_KIND_LIST = HUMAN_SEND_KINDS.map((kind) => `'${kind}'`).join(', ');
const BODY_REQUIRED_LIST = KINDS_REQUIRING_BODY.map((kind) => `'${kind}'`).join(', ');

export interface LinkedInHandoff {
  actionId: string;
  seatKey: string;
  seatLabel: string;
  kind: HumanSendKind;
  targetRef: string;
  /** A LinkedIn URL the founder can open, or null when the target is not one. */
  targetUrl: string | null;
  /** The approved bytes to paste. Null for an invite sent without a note. */
  copyText: string | null;
  subject: string | null;
  plannedFor: string;
  campaignId: string | null;
  campaignName: string | null;
}

interface HandoffRow extends NextDueRow {
  body: string | null;
  subject: string | null;
  thread_urn: string | null;
  workflow_step_id: string | null;
  seat_label: string;
  campaign_name: string | null;
}

function dueActionOf(workspaceId: string, row: HandoffRow): DueLinkedInAction {
  return {
    id: row.id,
    workspaceId,
    seatKey: row.seat_key,
    kind: row.kind as ExecutableKind,
    targetRef: row.target_ref,
    plannedFor: row.planned_for,
    body: row.body,
    subject: row.subject,
    threadUrn: row.thread_urn,
    campaignId: row.campaign_id,
    workflowStepId: row.workflow_step_id,
    replayScope: row.replay_scope ?? 'legacy',
    overrideWarmupCeiling: row.override_warmup_ceiling === true,
    replyToInbound: row.reply_to_inbound === true,
    manual: row.source === 'manual'
  };
}

export function handoffTitle(kind: string, seatLabel: string): string {
  if (kind === 'invite') return `Send a LinkedIn invite from ${seatLabel}`;
  if (kind === 'reply') return `Send a LinkedIn reply from ${seatLabel}`;
  if (kind === 'inmail') return `Send an InMail from ${seatLabel}`;
  return `Send a LinkedIn message from ${seatLabel}`;
}

/**
 * The next send per human-send seat that the worker would take and the gate
 * would allow. Same predicates and order as the claim (`claimNextDueAction`)
 * and the campaign preview (`execution-state.ts`), restricted to the kinds a
 * founder sends by hand.
 */
export async function listLinkedInHandoffs(
  db: Db,
  workspaceId: string,
  now: Date,
  options: Pick<LinkedInSafetyOptions, 'dayShape'> = {}
): Promise<LinkedInHandoff[]> {
  const nowIso = now.toISOString();
  const rows = await db
    .prepare(
      `
      SELECT * FROM (
        SELECT a.id, a.seat_key, a.kind, a.target_ref,
               TO_CHAR(a.planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
               a.campaign_id, a.replay_scope, a.override_warmup_ceiling, a.reply_to_inbound, a.source,
               a.body, a.subject, a.thread_urn, a.workflow_step_id,
               s.label AS seat_label, c.name AS campaign_name,
               ROW_NUMBER() OVER (
                 PARTITION BY a.seat_key
                 ORDER BY
                   (CASE WHEN a.sla_deadline_at IS NOT NULL AND a.sla_deadline_at <= ?::timestamptz THEN 1 ELSE 0 END) DESC,
                   a.queue_priority DESC,
                   a.planned_for ASC,
                   a.id ASC
               ) AS seat_rank
        FROM linkedin_actions a
        JOIN linkedin_seats s
          ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key AND s.send_mode = 'human'
        LEFT JOIN linkedin_campaigns c
          ON c.workspace_id = a.workspace_id AND c.id = a.campaign_id
        WHERE a.workspace_id = ? AND a.status = 'planned' AND a.claimed_at IS NULL
          AND a.settlement_hold_at IS NULL
          AND a.planned_for IS NOT NULL AND a.planned_for <= ?::timestamptz
          AND a.kind IN (${HUMAN_SEND_KIND_LIST})
          AND a.target_ref IS NOT NULL
          AND (a.kind NOT IN (${BODY_REQUIRED_LIST}) OR (a.body IS NOT NULL AND a.body <> ''))
          AND (a.kind <> 'reply' OR (a.thread_urn IS NOT NULL AND a.thread_urn <> ''))
      ) ranked
      WHERE ranked.seat_rank <= ?::int
      ORDER BY ranked.seat_key ASC, ranked.seat_rank ASC
    `
    )
    .all<HandoffRow>(nowIso, workspaceId, nowIso, CANDIDATES_PER_SEAT);

  const stores = new Map<string, LocalWorkerStore>();
  const handed = new Set<string>();
  const handoffs: LinkedInHandoff[] = [];
  for (const row of rows) {
    if (handed.has(row.seat_key) || !isHumanSendKind(row.kind)) continue;
    let store = stores.get(row.seat_key);
    if (!store) {
      store = postgresLocalWorkerStore(db, workspaceId, row.seat_key);
      stores.set(row.seat_key, store);
    }
    const action = dueActionOf(workspaceId, row);
    // The worker's own pre-send questions, so a handoff is never a row the
    // worker would have retired, deferred or branch-skipped.
    if ((await store.actionExecutionState(action)) !== 'execute') continue;
    const branch = await store.branchDecision(action, now);
    if (branch && branch.outcome !== 'due') continue;
    const gate = await gateVerdict(db, workspaceId, row, now, options);
    if (!gate?.allowed) continue;
    handed.add(row.seat_key);
    handoffs.push({
      actionId: row.id,
      seatKey: row.seat_key,
      seatLabel: row.seat_label,
      kind: row.kind,
      targetRef: row.target_ref,
      targetUrl: profileUrlFor(row.target_ref),
      copyText: row.body && row.body.trim() ? row.body : null,
      subject: row.subject && row.subject.trim() ? row.subject : null,
      plannedFor: row.planned_for,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name
    });
  }
  return handoffs;
}

export const handoffResolutionSchema = z.object({ resolution: z.enum(['sent', 'skip']) }).strict();

/**
 * The founder's report on one handoff. 'sent' is an OUTCOME REPORT through
 * `ingestOutcome` -- the same sanctioned path as POST /api/linkedin/actions/
 * outcome -- so `recorded_at` is stamped and every safety window counts it.
 * Idempotent per target status; anything that is no longer a waiting handoff
 * is refused rather than overwritten.
 */
export async function resolveLinkedInHandoff(
  db: Db,
  input: {
    workspaceId: string;
    actionId: string;
    resolution: 'sent' | 'skip';
    actorUserId: string | null;
  },
  now: Date
): Promise<{ actionId: string; status: 'sent' | 'skipped' }> {
  const target = input.resolution === 'sent' ? 'sent' : 'skipped';
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `SELECT a.id, a.kind, a.status, a.claimed_at, a.settlement_hold_at,
                (a.planned_for IS NOT NULL AND a.planned_for <= ?::timestamptz) AS due,
                s.send_mode
         FROM linkedin_actions a
         LEFT JOIN linkedin_seats s ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key
         WHERE a.workspace_id = ? AND a.id = ?
         FOR UPDATE OF a`
      )
      .get<{
        id: string;
        kind: string;
        status: string;
        claimed_at: unknown;
        settlement_hold_at: unknown;
        due: boolean;
        send_mode: string | null;
      }>(now.toISOString(), input.workspaceId, input.actionId);
    if (!row) throw new LinkedInApiError('LinkedIn action not found', 404);
    if (row.status === target) return { actionId: row.id, status: target };
    if (row.send_mode !== 'human' || !isHumanSendKind(row.kind))
      throw new LinkedInApiError(
        'Only an invite or message waiting on a human-send LinkedIn account can be resolved here.',
        409
      );
    if (
      row.status !== 'planned' ||
      row.claimed_at !== null ||
      row.settlement_hold_at !== null ||
      row.due !== true
    )
      throw new LinkedInApiError(
        `This ${row.kind} is not waiting for you (it is '${row.status}'), so it cannot be marked ${target}.`,
        409
      );

    if (target === 'sent')
      await ingestOutcome(
        tx,
        { workspaceId: input.workspaceId, actionId: row.id, outcome: 'sent' },
        now
      );
    else await skipAction(tx, input.workspaceId, row.id, now);
    // Exactly what the worker does after settleSent / settleBranchSkipped, so
    // a managed campaign member moves on whichever way the founder answered.
    await advanceManagedMemberAfterSettledLinkedInAction(tx, input.workspaceId, row.id, now);
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_action',
      streamId: row.id,
      eventType: target === 'sent' ? 'linkedin.handoff.marked_sent' : 'linkedin.handoff.skipped',
      actorType: 'user',
      actorId: input.actorUserId,
      payload: { kind: row.kind },
      occurredAt: now
    });
    return { actionId: row.id, status: target };
  });
}
```

If `LocalWorkerStore` is not exported from `local-worker.ts`, replace that import with `type LocalWorkerStore = ReturnType<typeof postgresLocalWorkerStore>;`. `local-worker.test.ts` already imports `type LocalWorkerStore` from it, so it is exported today.

- [ ] **Step 6: Name the second reporting route in the ledger invariant (`src/server/linkedin/action-ledger.ts`)**

In the file header, replace these three lines:

```
 * itself 'outcome-ingest', and exactly one route in `app.ts` passes that
 * value. A future route that wants to mark something sent has to either go
 * through the outcome endpoint or edit this line -- and editing this line is a
```

with:

```
 * itself 'outcome-ingest', and only `ingestOutcome` passes that value, reached
 * from exactly two routes in `app.ts`: POST /api/linkedin/actions/outcome and
 * the human-send report POST /api/linkedin/handoffs/:id/resolve (handoff.ts).
 * A future route that wants to mark something sent has to either go through
 * `ingestOutcome` or edit this line -- and editing this line is a
```

Then replace ` * 'outcome-ingest' is POST /api/linkedin/actions/outcome, and nothing else.` with:

```
 * 'outcome-ingest' is POST /api/linkedin/actions/outcome and the human-send
 * report in handoff.ts, both through `ingestOutcome`, and nothing else.
```

- [ ] **Step 7: Add the route (`src/server/app.ts`)**

1. Add the import directly after `import { campaignExecutionState } from './linkedin/execution-state.js';`:

```ts
import { handoffResolutionSchema, resolveLinkedInHandoff } from './linkedin/handoff.js';
```

2. Replace the comment above `'/api/linkedin/actions/outcome'`:

```ts
// The ONLY route that may move an action to sent/accepted/replied, and it is
// a REPORT rather than an instruction: the operator is telling Trevra what
```

with:

```ts
// One of the TWO routes that may move an action to sent (the other is the
// human-send handoff below), and both are REPORTS rather than instructions
// through `ingestOutcome`: the operator is telling Trevra what
```

3. Directly after the closing `  );` of that `app.post('/api/linkedin/actions/outcome', ...)` call, insert:

```ts
// HUMAN-SEND REPORT. The founder sent (or skipped) the invite or message
// Trevra handed them in Today. Any workspace member may report it: it is the
// same kind of report as the outcome route above, never an instruction.
app.post(
  '/api/linkedin/handoffs/:id/resolve',
  linkedinRoute(async (req, res) => {
    const input = handoffResolutionSchema.parse(req.body ?? {});
    const handoff = await resolveLinkedInHandoff(
      db,
      {
        workspaceId: req.auth!.workspaceId,
        actionId: String(req.params.id),
        resolution: input.resolution,
        actorUserId: req.auth!.userId
      },
      new Date()
    );
    res.json({ handoff });
  })
);
```

(A `ZodError` is passed to `next()` by `linkedinRoute` and becomes 400 `Invalid request` in the global handler.)

- [ ] **Step 8: Project handoffs into Today (`src/server/today.ts`)**

1. Add the import after `import { campaignExecutionState } from './linkedin/execution-state.js';`:

```ts
import { handoffTitle, listLinkedInHandoffs } from './linkedin/handoff.js';
```

2. In `export type TodayItemKind`, replace `  | 'opportunity_closed';` with `  | 'opportunity_closed'\n  | 'linkedin_handoff_waiting';`.

3. Directly before `  for (const row of agentRows) {`, insert:

```ts
// HUMAN-SEND: the next gated invite or message per human-send seat. A read
// that cannot list them must not take Today down with it.
const handoffs = await listLinkedInHandoffs(db, workspaceId, now).catch(() => []);
for (const handoff of handoffs) {
  items.push({
    id: `linkedin_handoff:${handoff.actionId}`,
    kind: 'linkedin_handoff_waiting',
    priority: 42,
    title: handoffTitle(handoff.kind, handoff.seatLabel),
    detail:
      `${handoff.campaignName ? `${handoff.campaignName}: ` : ''}` +
      'Trevra checked this against the account limits. Send it on LinkedIn yourself, then mark it sent so the limits count it.',
    href: '/outreach',
    observedAt: handoff.plannedFor,
    reference: { type: 'linkedin_action', id: handoff.actionId },
    metadata: {
      actionId: handoff.actionId,
      actionKind: handoff.kind,
      seatKey: handoff.seatKey,
      copyText: handoff.copyText,
      subject: handoff.subject,
      targetUrl: handoff.targetUrl,
      campaignName: handoff.campaignName,
      channel: 'linkedin'
    }
  });
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/handoff.test.ts src/server/today.test.ts src/server/linkedin/manager-api.test.ts src/server/linkedin/execution-state.test.ts src/server/linkedin/action-ledger.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/linkedin/handoff.ts src/server/linkedin/handoff.test.ts src/server/linkedin/execution-state.ts src/server/linkedin/local-worker.ts src/server/linkedin/action-ledger.ts src/server/today.ts src/server/today.test.ts src/server/app.ts src/server/linkedin/manager-api.test.ts
git commit -m "feat(linkedin): hand human-send invites and messages to Today" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 6: Client — the handoff card, the human-send switch, the blocker rung

**Files:**

- Create: `src/client/views/LinkedInHandoffCard.tsx`, `src/client/views/LinkedInHandoffCard.test.tsx`
- Modify: `src/client/views/LoopView.tsx`, `src/client/api.ts`, `src/client/LinkedInAccountForm.tsx`, `src/client/LinkedInExecutionBlocker.ts`
- Test: `src/client/api-linkedin-manager.test.ts`, `src/client/LinkedInAccountForm.test.tsx`, `src/client/LinkedInExecutionBlocker.test.ts`

**Interfaces:**

- Consumes:
  - `POST /api/linkedin/handoffs/:id/resolve` and the `linkedin_handoff_waiting` Today item (Task 5)
  - `LinkedInSeat.sendMode` (Task 4), `LinkedInSeat.identityConfirmedAt` and `LinkedInSeat.linkedSeatCount` (Task 3)
  - `LinkedInCampaignExecution.humanSendNext` (Task 4)
- Produces:
  - `resolveLinkedInHandoff(id: string, resolution: 'sent' | 'skip'): Promise<{ actionId: string; status: 'sent' | 'skipped' }>` in `api.ts`
  - `LinkedInHandoffCard({ item, onResolved })`, `handoffFromItem(item)` and `handoffCopyLabel(kind)`
  - `AccountDraft.humanSend: boolean`; `draftToPatch()` returns `sendMode`
  - `identityHint(identity)` exported from `LinkedInAccountForm.tsx`
  - `CampaignExecutionBlockerKind` gains `'human-send'`

- [ ] **Step 1: Write the failing client tests**

Create `src/client/views/LinkedInHandoffCard.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TodayItem } from '../../server/today';
import { LinkedInHandoffCard, handoffCopyLabel, handoffFromItem } from './LinkedInHandoffCard';

function item(metadata: Record<string, unknown>): TodayItem {
  return {
    id: 'linkedin_handoff:lact_card',
    kind: 'linkedin_handoff_waiting',
    priority: 42,
    title: 'Send a LinkedIn message from Founder',
    detail: 'Trevra checked this against the account limits.',
    href: '/outreach',
    observedAt: '2026-08-04T09:59:00.000Z',
    reference: { type: 'linkedin_action', id: 'lact_card' },
    metadata: {
      actionId: 'lact_card',
      actionKind: 'dm',
      seatKey: 'owner',
      copyText: 'Hi Maya, thanks for connecting.',
      subject: null,
      targetUrl: 'https://www.linkedin.com/in/maya-card/',
      campaignName: null,
      channel: 'linkedin',
      ...metadata
    }
  };
}

describe('LinkedIn handoff card', () => {
  it('shows the approved copy, the profile link and the two answers', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard item={item({})} onResolved={() => undefined} />
    );
    expect(html).toContain('Send a LinkedIn message from Founder');
    expect(html).toContain('Hi Maya, thanks for connecting.');
    expect(html).toContain('href="https://www.linkedin.com/in/maya-card/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Copy message');
    expect(html).toContain('Mark sent');
    expect(html).toContain('Skip');
    expect(html).toContain('Nothing goes out from Trevra.');
  });

  it('says an invite goes without a note when it has none, and offers nothing to copy', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard
        item={item({ actionKind: 'invite', copyText: null })}
        onResolved={() => undefined}
      />
    );
    expect(html).toContain('No note: send the invite without one.');
    expect(html).not.toContain('Copy note');
    expect(handoffCopyLabel('invite')).toBe('Copy note');
  });

  it('reads only handoff items', () => {
    expect(handoffFromItem({ ...item({}), kind: 'verified_reply' })).toBeNull();
    expect(handoffFromItem(item({ actionId: '' }))).toBeNull();
    expect(handoffFromItem(item({}))).toMatchObject({ actionId: 'lact_card', actionKind: 'dm' });
  });
});
```

In `src/client/api-linkedin-manager.test.ts`:

- Replace `import { updateLinkedInManagerSeat, updateLinkedInSeatCapabilities } from './api';` with `import {\n  resolveLinkedInHandoff,\n  updateLinkedInManagerSeat,\n  updateLinkedInSeatCapabilities\n} from './api';`.
- Add inside the `describe`:

```ts
it('reports a handoff resolution to its own route', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ handoff: { actionId: 'lact_1', status: 'sent' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
  vi.stubGlobal('fetch', fetchMock);

  expect(await resolveLinkedInHandoff('lact_1', 'sent')).toEqual({
    actionId: 'lact_1',
    status: 'sent'
  });
  const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/api/linkedin/handoffs/lact_1/resolve');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ resolution: 'sent' });
});
```

In `src/client/LinkedInAccountForm.test.tsx`:

1. Replace the import block from `'./LinkedInAccountForm'` with:

```ts
import {
  ScheduleFields,
  capabilityDraftToPatch,
  capabilityPatchChanged,
  draftToPatch,
  identityHint,
  type AccountDraft
} from './LinkedInAccountForm';
```

2. In `const draft = (warmupOverride = false): AccountDraft => ({`, replace `  warmupOverride,` with `  warmupOverride,\n  humanSend: false,`.
3. Append:

```tsx
describe('LinkedIn human-send and identity controls', () => {
  it('serializes the human-send switch into the account PATCH', () => {
    expect(draftToPatch({ ...draft(), humanSend: true }, null)).toMatchObject({
      sendMode: 'human'
    });
    expect(draftToPatch(draft(), null)).toMatchObject({ sendMode: 'automated' });
  });

  it('offers the switch and the identity hint on an existing account', () => {
    const html = renderToStaticMarkup(
      <ScheduleFields
        draft={{ ...draft(), humanSend: true }}
        onChange={() => undefined}
        idPrefix="test"
        safety={safety}
        bandOverride
        identity={{ identityConfirmedAt: '2026-08-20T09:00:00.000Z', linkedSeatCount: 1 }}
      />
    );
    expect(html).toContain('I send invites and messages myself');
    expect(html).toContain('hands each one to you in Today');
    expect(html).toContain('also connected in 1 other workspace account');
  });

  it('says plainly when the member is unconfirmed, and when it is alone', () => {
    expect(identityHint({ identityConfirmedAt: null, linkedSeatCount: 0 })).toContain(
      'count this account alone'
    );
    expect(
      identityHint({ identityConfirmedAt: '2026-08-20T09:00:00.000Z', linkedSeatCount: 0 })
    ).toContain('No other workspace account signs in as this LinkedIn member');
    expect(
      identityHint({ identityConfirmedAt: '2026-08-20T09:00:00.000Z', linkedSeatCount: 2 })
    ).toContain('also connected in 2 other workspace accounts');
  });
});
```

In `src/client/LinkedInExecutionBlocker.test.ts`, add inside `describe('campaign execution blocker', () => {` after `'reports an unreadable executor before blaming the queue'`:

```ts
it('hands a human-send seat to the founder ahead of every browser rung', () => {
  const result = blocker({
    companionStatus: companion({ devices: [] }),
    execution: execution({
      humanSendNext: true,
      restingUntil: null,
      gate: { kind: 'invite', allowed: true, check: null, detail: null }
    })
  });
  expect(result?.kind).toBe('human-send');
  expect(result?.severity).toBe('attention');
  expect(result?.title).toBe('Waiting for you to send on LinkedIn');
  expect(result?.detail).toContain('next invite');
});

it('still names a refusing gate on a human-send seat', () => {
  const result = blocker({
    execution: execution({ humanSendNext: true, restingUntil: null })
  });
  expect(result?.kind).toBe('safety-gate');
  expect(result?.title).toBe('Profile-view safety ceiling reached');
});
```

- [ ] **Step 2: Run the client tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/client/views/LinkedInHandoffCard.test.tsx src/client/api-linkedin-manager.test.ts src/client/LinkedInAccountForm.test.tsx src/client/LinkedInExecutionBlocker.test.ts`
Expected: FAIL.

- Cannot resolve `./LinkedInHandoffCard`.
- `resolveLinkedInHandoff` and `identityHint` are not exported.
- The blocker returns `companion-offline`.

- [ ] **Step 3: Add the API call (`src/client/api.ts`)**

Directly after the closing `}` of `export async function skipLinkedInAction(`, insert:

```ts
/**
 * The founder's answer to a human-send handoff in Today: they sent it on
 * LinkedIn themselves, or they are skipping it. A report, never a send.
 */
export async function resolveLinkedInHandoff(
  id: string,
  resolution: 'sent' | 'skip'
): Promise<{ actionId: string; status: 'sent' | 'skipped' }> {
  const result = await request<{ handoff: { actionId: string; status: 'sent' | 'skipped' } }>(
    `/api/linkedin/handoffs/${encodeURIComponent(id)}/resolve`,
    { method: 'POST', body: JSON.stringify({ resolution }) }
  );
  return result.handoff;
}
```

- [ ] **Step 4: Create `src/client/views/LinkedInHandoffCard.tsx`**

```tsx
import { useState } from 'react';
import { Send } from 'lucide-react';
import type { TodayItem } from '../../server/today';
import { resolveLinkedInHandoff } from '../api';
import { errorMessage } from '../LinkedInSafety';
import { Button } from '../ui/primitives';

export interface LinkedInHandoffView {
  actionId: string;
  actionKind: string;
  copyText: string | null;
  subject: string | null;
  targetUrl: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The handoff off a Today item, or null when the item is not one. */
export function handoffFromItem(item: TodayItem): LinkedInHandoffView | null {
  if (item.kind !== 'linkedin_handoff_waiting') return null;
  const actionId = text(item.metadata.actionId);
  if (!actionId) return null;
  return {
    actionId,
    actionKind: text(item.metadata.actionKind) ?? 'dm',
    copyText: text(item.metadata.copyText),
    subject: text(item.metadata.subject),
    targetUrl: text(item.metadata.targetUrl)
  };
}

export function handoffCopyLabel(kind: string): string {
  return kind === 'invite' ? 'Copy note' : 'Copy message';
}

/**
 * One human-send handoff in Today. Trevra drafted it, the approval covered
 * these exact bytes, and the safety gate passed it; the founder sends it on
 * LinkedIn and reports back. "Mark sent" is the one primary action.
 */
export function LinkedInHandoffCard({
  item,
  onResolved
}: {
  item: TodayItem;
  onResolved: () => void;
}) {
  const handoff = handoffFromItem(item);
  const [busy, setBusy] = useState<'sent' | 'skip' | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  if (!handoff) return null;

  const copy = async () => {
    if (!handoff.copyText) return;
    setProblem('');
    try {
      await navigator.clipboard.writeText(handoff.copyText);
      setCopied(true);
    } catch {
      setProblem('The browser blocked copying. Select the text above and copy it yourself.');
    }
  };

  const resolve = async (resolution: 'sent' | 'skip') => {
    setBusy(resolution);
    setProblem('');
    try {
      await resolveLinkedInHandoff(handoff.actionId, resolution);
      onResolved();
    } catch (error) {
      setProblem(
        errorMessage(
          error,
          resolution === 'sent'
            ? 'Trevra could not record this as sent, so the limits do not count it yet. Try again.'
            : 'Trevra could not skip this. It is still waiting for you.'
        )
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="today-item-expanded">
      <Send size={19} />
      <div>
        <strong>{item.title}</strong>
        <small>{item.detail}</small>
      </div>
      <span className="status-pill">You send</span>
      <div className="today-action-review">
        <div className="today-action-review-head">
          <div>
            <strong>{handoff.actionKind === 'invite' ? 'Invite note' : 'Message'}</strong>
            <small>
              Nothing goes out from Trevra. You send this on LinkedIn, then tell Trevra.
            </small>
          </div>
          {handoff.targetUrl && (
            <a
              className="ui-button secondary-button"
              href={handoff.targetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open profile
            </a>
          )}
        </div>
        {handoff.subject && (
          <dl>
            <div>
              <dt>Subject</dt>
              <dd>{handoff.subject}</dd>
            </div>
          </dl>
        )}
        {handoff.copyText ? (
          <pre>{handoff.copyText}</pre>
        ) : (
          <p className="li-hint">No note: send the invite without one.</p>
        )}
        {problem && (
          <div className="error-banner" role="alert">
            {problem}
          </div>
        )}
        <div className="today-action-review-actions">
          {handoff.copyText && (
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : handoffCopyLabel(handoff.actionKind)}
            </Button>
          )}
          <Button variant="secondary" disabled={busy !== null} onClick={() => void resolve('skip')}>
            {busy === 'skip' ? 'Skipping…' : 'Skip'}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void resolve('sent')}>
            {busy === 'sent' ? 'Recording…' : 'Mark sent'}
          </Button>
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 5: Render it in Today (`src/client/views/LoopView.tsx`)**

1. Add after `import { ACTIVATION_STEPS, nextActivationStep, type ActivationSignals } from './activation';`:

```ts
import { LinkedInHandoffCard } from './LinkedInHandoffCard';
```

2. In `TodayAttention`, replace:

```tsx
          {items.map((item) => {
            const entry = prepared[item.id];
```

with:

```tsx
          {items.map((item) => {
            if (item.kind === 'linkedin_handoff_waiting')
              return <LinkedInHandoffCard key={item.id} item={item} onResolved={onRefresh} />;
            const entry = prepared[item.id];
```

- [ ] **Step 6: The human-send switch and the identity hint (`src/client/LinkedInAccountForm.tsx`)**

1. Replace `import { Select } from './ui/primitives';` with:

```ts
import { plural } from './ui/plural';
import { Select, SwitchField } from './ui/primitives';
```

2. In `export interface AccountDraft {`, replace `  warmupOverride: boolean;` with:

```ts
warmupOverride: boolean;
/** The founder sends this account's invites and messages by hand (`send_mode='human'`). */
humanSend: boolean;
```

3. In `const emptyDraft = ...`, replace `  warmupOverride: false,\n  proxyUrl: '',` with `  warmupOverride: false,\n  humanSend: false,\n  proxyUrl: '',`.

4. In `const draftOf = ...`, replace `  warmupOverride: account.warmupOverride,` with `  warmupOverride: account.warmupOverride,\n  humanSend: account.sendMode === 'human',`.

5. In `draftToPatch`'s returned object, replace `    warmupOverride: draft.warmupOverride,` with:

```ts
    warmupOverride: draft.warmupOverride,
    sendMode: (draft.humanSend ? 'human' : 'automated') as LinkedInSeat['sendMode'],
```

6. Directly before `export function ScheduleFields({`, insert:

```tsx
/**
 * Which LinkedIn member this account is, as far as the safety limits go. A
 * count only: the server never says which other workspaces or accounts.
 */
export function identityHint(
  identity: Pick<LinkedInSeat, 'identityConfirmedAt' | 'linkedSeatCount'>
): string {
  if (!identity.identityConfirmedAt)
    return 'Trevra has not confirmed which LinkedIn member this account signs in as yet, so its limits count this account alone. Connecting it through the Trevra companion confirms it.';
  if (identity.linkedSeatCount <= 0)
    return 'No other workspace account signs in as this LinkedIn member, so these limits cover all of its activity Trevra knows about.';
  return `This LinkedIn member is also connected in ${plural(identity.linkedSeatCount, 'other workspace account')}. Sends from there count against these limits too, so one person stays inside one budget.`;
}
```

7. In `ScheduleFields`'s destructured props, replace `  activatedAt = null\n}: {` with `  activatedAt = null,\n  identity = null\n}: {`. In its prop types, replace `  activatedAt?: string | null;\n}) {` with:

```ts
  activatedAt?: string | null;
  /** Which LinkedIn member this account is. Null for an account that does not exist yet. */
  identity?: Pick<LinkedInSeat, 'identityConfirmedAt' | 'linkedSeatCount'> | null;
}) {
```

8. Inside the `{bandOverride && (` block, replace:

```tsx
                : 'Account warm-up is currently enabled.'}
          </p>
        </>
      )}
```

with:

```tsx
                : 'Account warm-up is currently enabled.'}
          </p>

          <h4 className="li-subhead" aria-level={3}>
            Sending
          </h4>
          <SwitchField
            label="I send invites and messages myself"
            description="Trevra still drafts, approves, paces and checks every invite and message on this account, then hands each one to you in Today instead of sending it. Profile views and follows keep running on their own."
            checked={draft.humanSend}
            onChange={(event) => onChange({ humanSend: event.target.checked })}
          />
          {identity && <p className="li-hint">{identityHint(identity)}</p>}
        </>
      )}
```

9. In `EditAccountForm`, replace `                activatedAt={account.activatedAt}\n              />` with `                activatedAt={account.activatedAt}\n                identity={account}\n              />`.

- [ ] **Step 7: The `human-send` rung (`src/client/LinkedInExecutionBlocker.ts`)**

1. In `export type CampaignExecutionBlockerKind =`, replace `  | 'unclaimed';` with `  | 'unclaimed'\n  | 'human-send';`.

2. Directly before `/**\n * The single true reason this campaign is not executing, or null when it is.`, insert:

```ts
function safetyGateBlocker(
  gate: NonNullable<LinkedInCampaignExecution['gate']>,
  due: number
): CampaignExecutionBlocker {
  return {
    kind: 'safety-gate',
    severity: CLOCK_GATE_CHECKS.has(gate.check ?? '') ? 'waiting' : 'attention',
    title: gateTitle(gate.check, gate.kind),
    detail: `${plural(due, 'planned action')} ${are(due)} due, but the safety gate refuses the next one${
      gate.check ? ` (${gate.check})` : ''
    }: ${gate.detail ?? 'the safety gate refused it.'} The queue resumes by itself once that stops binding.`
  };
}
```

3. Replace rung (4)'s body:

```ts
if (execution?.gate && !execution.gate.allowed)
  return {
    kind: 'safety-gate',
    severity: CLOCK_GATE_CHECKS.has(execution.gate.check ?? '') ? 'waiting' : 'attention',
    title: gateTitle(execution.gate.check, execution.gate.kind),
    detail: `${plural(due, 'planned action')} ${are(due)} due, but the safety gate refuses the next one${
      execution.gate.check ? ` (${execution.gate.check})` : ''
    }: ${execution.gate.detail ?? 'the safety gate refused it.'} The queue resumes by itself once that stops binding.`
  };
```

with:

```ts
if (execution?.gate && !execution.gate.allowed) return safetyGateBlocker(execution.gate, due);
```

4. Directly before `  // (1) No browser exists.`, insert:

```ts
// (0) HUMAN-SEND. The next due row is an invite or message the founder sends
// by hand, so no browser, companion or worker is involved and none of the
// rungs below can be the reason. A refusing gate is still the honest
// headline: the handoff stays out of Today until the gate passes.
if (execution?.humanSendNext && due > 0) {
  if (execution.gate && !execution.gate.allowed) return safetyGateBlocker(execution.gate, due);
  return {
    kind: 'human-send',
    severity: 'attention',
    title: 'Waiting for you to send on LinkedIn',
    detail: `${plural(due, 'planned action')} ${are(due)} due. ${seatLabel} is set to send invites and messages by hand, so Trevra hands the next ${noun(execution.gate?.kind ?? null)} to you in Today instead of opening a browser.`
  };
}
```

- [ ] **Step 8: Run the client tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/client/views/LinkedInHandoffCard.test.tsx src/client/api-linkedin-manager.test.ts src/client/LinkedInAccountForm.test.tsx src/client/LinkedInExecutionBlocker.test.ts`
Expected: PASS.

- [ ] **Step 9: Look at it**

Run `npm run dev`. Sign in, set an account to "I send invites and messages myself" in Outreach › Accounts › Safety, and queue a DM.

- Check the Today card in the light and dark themes, and at a 375px-wide viewport.
- At 375px the buttons stack (`.today-action-review-actions` already switches to a column under 680px).
- Every button is at least `--t-tap` high, and the keyboard focus ring is visible on Copy, Skip, Mark sent and Open profile.

- [ ] **Step 10: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/client/views/LinkedInHandoffCard.tsx src/client/views/LinkedInHandoffCard.test.tsx src/client/views/LoopView.tsx src/client/api.ts src/client/api-linkedin-manager.test.ts src/client/LinkedInAccountForm.tsx src/client/LinkedInAccountForm.test.tsx src/client/LinkedInExecutionBlocker.ts src/client/LinkedInExecutionBlocker.test.ts
git commit -m "feat(linkedin): human-send handoff card and account switch" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 7: Workspace sender identity

**Files:**

- Create: `src/server/compliance/sender-identity.ts`, `src/server/compliance/sender-identity.test.ts`, `src/server/compliance/api.test.ts`
- Create: `src/client/SenderIdentityPanel.tsx`, `src/client/SenderIdentityPanel.test.tsx`
- Modify: `src/server/app.ts`, `src/server/gtm/intent.ts`, `src/client/api.ts`, `src/client/App.tsx`
- Test: `src/server/gtm/intent.test.ts`

**Interfaces:**

- Consumes: `workspace_sender_identities` (Task 2), `appendDomainEvent()`, `ownerOnly()` in `app.ts`, `GtmPlanBlocker` in `gtm/intent.ts`
- Produces:
  - `FTC_CAN_SPAM_GUIDE_URL`
  - `interface SenderIdentity { legalName: string | null; postalAddress: string | null; privacyPolicyUrl: string | null; updatedAt: string | null }`
  - `senderIdentitySchema` (strict; absent = unchanged, blank = clear, `https://` only)
  - `getSenderIdentity(db, workspaceId): Promise<SenderIdentity>`
  - `saveSenderIdentity(db, { workspaceId, actorUserId, input }, now): Promise<SenderIdentity>`
  - `senderIdentityBlockers(db, workspaceId): Promise<Array<{ code; message; actionHref }>>`, with codes `sender_postal_address_missing` and `sender_privacy_url_missing`
  - `GET /api/workspace/sender-identity` (any member) and `PUT /api/workspace/sender-identity` (owner), both returning `{ senderIdentity }`
  - event `sender_identity.updated` on stream `('workspace', workspaceId)` with payload `{ fields: string[] }` (field names only)
  - client: `getSenderIdentity()`, `saveSenderIdentity(input)`, and `SenderIdentityPanel` on `/setup/workspace`

**Why both fields block:** the FTC CAN-SPAM guide requires a valid physical postal address in every commercial email (https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business). The privacy policy URL is Trevra's own conservative requirement: every non-US rule in Task 8 assumes the recipient can find out who processes their data. The footer itself is not appended here; see the Self-Review risks.

- [ ] **Step 1: Write the failing store tests**

Create `src/server/compliance/sender-identity.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import {
  FTC_CAN_SPAM_GUIDE_URL,
  getSenderIdentity,
  saveSenderIdentity,
  senderIdentityBlockers
} from './sender-identity.js';

const WORKSPACE = 'ws_sender_identity_test';
const NOW = new Date('2026-08-21T09:00:00.000Z');
const ADDRESS = 'Bahnhofstrasse 1, 8001 Zurich, Switzerland';
let db: Db;

const save = (input: unknown) =>
  saveSenderIdentity(db, { workspaceId: WORKSPACE, actorUserId: null, input }, NOW);

async function updates() {
  return (
    await listDomainEvents(db, WORKSPACE, { streamType: 'workspace', streamId: WORKSPACE })
  ).filter((event) => event.eventType === 'sender_identity.updated');
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Sender identity', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('workspace sender identity', () => {
  it('starts empty and blocks email outreach for both missing fields, citing the FTC guide', async () => {
    expect(await getSenderIdentity(db, WORKSPACE)).toEqual({
      legalName: null,
      postalAddress: null,
      privacyPolicyUrl: null,
      updatedAt: null
    });
    const blockers = await senderIdentityBlockers(db, WORKSPACE);
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      'sender_postal_address_missing',
      'sender_privacy_url_missing'
    ]);
    expect(blockers[0]!.message).toContain(FTC_CAN_SPAM_GUIDE_URL);
    expect(blockers.every((blocker) => blocker.actionHref === '/setup/workspace')).toBe(true);
  });

  it('records which fields changed, never their values, and only when something changed', async () => {
    await save({ legalName: 'Northwind GmbH', postalAddress: ADDRESS });
    expect((await senderIdentityBlockers(db, WORKSPACE)).map((blocker) => blocker.code)).toEqual([
      'sender_privacy_url_missing'
    ]);

    const saved = await save({ privacyPolicyUrl: 'https://northwind.example/privacy' });
    expect(saved).toMatchObject({
      legalName: 'Northwind GmbH',
      postalAddress: ADDRESS,
      privacyPolicyUrl: 'https://northwind.example/privacy',
      updatedAt: NOW.toISOString()
    });
    expect(await senderIdentityBlockers(db, WORKSPACE)).toEqual([]);

    await save({ privacyPolicyUrl: 'https://northwind.example/privacy' });
    const events = await updates();
    expect(events.map((event) => event.payload)).toEqual([
      { fields: ['legalName', 'postalAddress'] },
      { fields: ['privacyPolicyUrl'] }
    ]);
    expect(JSON.stringify(events)).not.toContain('Bahnhofstrasse');
  });

  it('treats an absent field as unchanged and a blank one as cleared', async () => {
    await save({
      legalName: 'Northwind GmbH',
      postalAddress: ADDRESS,
      privacyPolicyUrl: 'https://northwind.example/privacy'
    });
    await save({ postalAddress: '   ' });
    expect(await getSenderIdentity(db, WORKSPACE)).toMatchObject({
      legalName: 'Northwind GmbH',
      postalAddress: null
    });
    expect((await senderIdentityBlockers(db, WORKSPACE)).map((blocker) => blocker.code)).toEqual([
      'sender_postal_address_missing'
    ]);
  });

  it('refuses a privacy policy URL that is not https, and unknown fields', async () => {
    await expect(
      save({ privacyPolicyUrl: 'http://northwind.example/privacy' })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(save({ footer: 'x' })).rejects.toBeInstanceOf(ZodError);
    expect(await updates()).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing route and plan tests**

Create `src/server/compliance/api.test.ts`:

```ts
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@compliance-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('compliance-owner');
  const member = await signUp('compliance-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  const memberAuth = (await member.agent.get('/api/auth/session').expect(200)).body.auth as {
    workspaceId: string;
    role: 'owner' | 'member';
  };
  expect(memberAuth.workspaceId).toBe(owner.auth.workspaceId);
  expect(memberAuth.role).toBe('member');
  return { owner, member };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('sender identity API', () => {
  it('lets every member read it, only the owner change it, and no other workspace see it', async () => {
    await request(app).get('/api/workspace/sender-identity').expect(401);
    const { owner, member } = await ownerAndMember();
    const outsider = await signUp('compliance-outsider');

    const empty = await member.agent.get('/api/workspace/sender-identity').expect(200);
    expect(empty.body.senderIdentity).toMatchObject({
      legalName: null,
      postalAddress: null,
      privacyPolicyUrl: null
    });
    await member.agent
      .put('/api/workspace/sender-identity')
      .send({ legalName: 'Member Ltd' })
      .expect(403);
    await owner.agent
      .put('/api/workspace/sender-identity')
      .send({ privacyPolicyUrl: 'http://compliance.example/privacy' })
      .expect(400);

    const saved = await owner.agent
      .put('/api/workspace/sender-identity')
      .send({
        legalName: 'Compliance Test GmbH',
        postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
        privacyPolicyUrl: 'https://compliance.example/privacy'
      })
      .expect(200);
    expect(saved.body.senderIdentity).toMatchObject({
      legalName: 'Compliance Test GmbH',
      postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
      privacyPolicyUrl: 'https://compliance.example/privacy'
    });
    const seen = await member.agent.get('/api/workspace/sender-identity').expect(200);
    expect(seen.body.senderIdentity.postalAddress).toBe('Bahnhofstrasse 1, 8001 Zurich');
    const other = await outsider.agent.get('/api/workspace/sender-identity').expect(200);
    expect(other.body.senderIdentity.postalAddress).toBeNull();
  });
});
```

In `src/server/gtm/intent.test.ts`:

- Add `import { saveSenderIdentity } from '../compliance/sender-identity.js';` after `import { upsertSeat } from '../linkedin/seats.js';`.
- Add inside `describe('bounded GTM intent compiler', () => {`, after `'shows precise blockers instead of pretending uploaded input references are already materialized'`:

```ts
it('blocks email outreach until the workspace has a postal address and a privacy policy URL', async () => {
  const list = await peopleList();
  const intent = {
    objective: 'prepare_outreach',
    people: { existingListId: list.id },
    channels: ['email']
  };
  const codes = async (raw: unknown) =>
    (await compileGtmIntent(db, WORKSPACE, raw)).blockers.map((blocker) => blocker.code);

  expect(await codes(intent)).toEqual(
    expect.arrayContaining(['sender_postal_address_missing', 'sender_privacy_url_missing'])
  );
  expect(await codes({ ...intent, channels: ['linkedin'] })).not.toContain(
    'sender_postal_address_missing'
  );

  await saveSenderIdentity(
    db,
    {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      input: {
        legalName: 'Intent Test GmbH',
        postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
        privacyPolicyUrl: 'https://intent.example/privacy'
      }
    },
    NOW
  );
  const after = await codes(intent);
  expect(after).not.toContain('sender_postal_address_missing');
  expect(after).not.toContain('sender_privacy_url_missing');
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/sender-identity.test.ts src/server/compliance/api.test.ts src/server/gtm/intent.test.ts`
Expected: FAIL.

- `sender-identity.test.ts` and `intent.test.ts`: cannot resolve `./sender-identity.js` / `../compliance/sender-identity.js`.
- `api.test.ts`: 404 `API route not found` where 200 is expected.

- [ ] **Step 4: Create `src/server/compliance/sender-identity.ts`**

```ts
import { z } from 'zod';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';

/* ---------------------------------------------------------------------------
 * WHO THIS WORKSPACE'S COMMERCIAL EMAIL SAYS IT IS FROM.
 *
 * Deterministic plan blockers, never a model's judgement: an email outreach
 * plan cannot be prepared while the postal address or the privacy policy URL
 * is missing. Not legal advice; verify with counsel.
 * ------------------------------------------------------------------------ */

export const FTC_CAN_SPAM_GUIDE_URL =
  'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business';

const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface SenderIdentity {
  legalName: string | null;
  postalAddress: string | null;
  privacyPolicyUrl: string | null;
  /** Null until the workspace first saves one. */
  updatedAt: string | null;
}

export interface SenderIdentityBlocker {
  code: 'sender_postal_address_missing' | 'sender_privacy_url_missing';
  message: string;
  actionHref: string;
}

/** Trimmed; a blank string clears the field. */
function blankToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Absent = unchanged, null or blank = cleared. */
export const senderIdentitySchema = z
  .object({
    legalName: z.preprocess(blankToNull, z.string().max(200).nullable()).optional(),
    postalAddress: z.preprocess(blankToNull, z.string().max(500).nullable()).optional(),
    privacyPolicyUrl: z
      .preprocess(
        blankToNull,
        z
          .string()
          .max(2048)
          .url()
          .refine((value) => value.startsWith('https://'), {
            message: 'The privacy policy URL must start with https://'
          })
          .nullable()
      )
      .optional()
  })
  .strict();

interface SenderIdentityRow {
  legal_name: string | null;
  postal_address: string | null;
  privacy_policy_url: string | null;
  updated_at: string;
}

export async function getSenderIdentity(db: Db, workspaceId: string): Promise<SenderIdentity> {
  const row = await db
    .prepare(
      `SELECT legal_name, postal_address, privacy_policy_url,
              TO_CHAR(updated_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS updated_at
       FROM workspace_sender_identities WHERE workspace_id=?`
    )
    .get<SenderIdentityRow>(workspaceId);
  return {
    legalName: row?.legal_name ?? null,
    postalAddress: row?.postal_address ?? null,
    privacyPolicyUrl: row?.privacy_policy_url ?? null,
    updatedAt: row?.updated_at ?? null
  };
}

const FIELDS = [
  ['legalName', 'legal_name'],
  ['postalAddress', 'postal_address'],
  ['privacyPolicyUrl', 'privacy_policy_url']
] as const;

export async function saveSenderIdentity(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; input: unknown },
  now: Date
): Promise<SenderIdentity> {
  const patch = senderIdentitySchema.parse(input.input);
  return db.transaction(async (tx) => {
    const current = await tx
      .prepare(
        `SELECT legal_name, postal_address, privacy_policy_url
         FROM workspace_sender_identities WHERE workspace_id=? FOR UPDATE`
      )
      .get<Omit<SenderIdentityRow, 'updated_at'>>(input.workspaceId);
    const next = {
      legal_name: current?.legal_name ?? null,
      postal_address: current?.postal_address ?? null,
      privacy_policy_url: current?.privacy_policy_url ?? null
    };
    const changed: string[] = [];
    for (const [field, column] of FIELDS) {
      const value = patch[field];
      if (value === undefined || value === next[column]) continue;
      next[column] = value;
      changed.push(field);
    }
    if (changed.length === 0) return getSenderIdentity(tx, input.workspaceId);

    await tx
      .prepare(
        `INSERT INTO workspace_sender_identities
           (workspace_id, legal_name, postal_address, privacy_policy_url, updated_by_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           legal_name=EXCLUDED.legal_name,
           postal_address=EXCLUDED.postal_address,
           privacy_policy_url=EXCLUDED.privacy_policy_url,
           updated_by_user_id=EXCLUDED.updated_by_user_id,
           updated_at=EXCLUDED.updated_at`
      )
      .run(
        input.workspaceId,
        next.legal_name,
        next.postal_address,
        next.privacy_policy_url,
        input.actorUserId,
        now.toISOString(),
        now.toISOString()
      );
    // Field NAMES only: an address is the workspace's own data, not an event's.
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'workspace',
      streamId: input.workspaceId,
      eventType: 'sender_identity.updated',
      actorType: input.actorUserId ? 'user' : 'system',
      actorId: input.actorUserId,
      payload: { fields: changed },
      occurredAt: now
    });
    return getSenderIdentity(tx, input.workspaceId);
  });
}

/** GTM plan blockers for any plan that would send commercial email. */
export async function senderIdentityBlockers(
  db: Db,
  workspaceId: string
): Promise<SenderIdentityBlocker[]> {
  const identity = await getSenderIdentity(db, workspaceId);
  const blockers: SenderIdentityBlocker[] = [];
  if (!identity.postalAddress)
    blockers.push({
      code: 'sender_postal_address_missing',
      message: `Add this workspace's postal address before Trevra plans email outreach. Commercial email must carry a valid physical postal address (FTC CAN-SPAM guide: ${FTC_CAN_SPAM_GUIDE_URL}).`,
      actionHref: '/setup/workspace'
    });
  if (!identity.privacyPolicyUrl)
    blockers.push({
      code: 'sender_privacy_url_missing',
      message:
        "Add this workspace's privacy policy URL before Trevra plans email outreach, so every recipient can see who handles their data.",
      actionHref: '/setup/workspace'
    });
  return blockers;
}
```

- [ ] **Step 5: Add the routes (`src/server/app.ts`)**

1. Add after `import { handoffResolutionSchema, resolveLinkedInHandoff } from './linkedin/handoff.js';` (Task 5):

```ts
import { getSenderIdentity, saveSenderIdentity } from './compliance/sender-identity.js';
```

2. Directly before `  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));`, insert:

```ts
// SENDER IDENTITY. Every member can read it, because every member plans
// outreach; only the owner changes what the workspace's email says it is.
app.get('/api/workspace/sender-identity', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ senderIdentity: await getSenderIdentity(db, req.auth!.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.put(
  '/api/workspace/sender-identity',
  ownerOnly('change the sender identity'),
  async (req: AuthedRequest, res, next) => {
    try {
      const senderIdentity = await saveSenderIdentity(
        db,
        {
          workspaceId: req.auth!.workspaceId,
          actorUserId: req.auth!.userId,
          input: req.body ?? {}
        },
        new Date()
      );
      res.json({ senderIdentity });
    } catch (error) {
      next(error);
    }
  }
);
```

- [ ] **Step 6: Block email outreach plans (`src/server/gtm/intent.ts`)**

1. Add after `import { listSeats } from '../linkedin/seats.js';`:

```ts
import { senderIdentityBlockers } from '../compliance/sender-identity.js';
```

2. In `prepareOutreachPlan`, directly after the closing `}` of the `if (requestedChannels.length !== 1 || requestedChannels[0] !== 'linkedin') {` block, insert:

```ts
// Deterministic, and independent of which compiler prepares the email: a
// plan that would send commercial email needs the sender identity first.
if (requestedChannels.includes('email'))
  blockers.push(...(await senderIdentityBlockers(db, workspaceId)));
```

- [ ] **Step 7: Run the server tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/sender-identity.test.ts src/server/compliance/api.test.ts src/server/gtm/intent.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing panel test**

Create `src/client/SenderIdentityPanel.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SenderIdentityForm,
  draftFromIdentity,
  draftToSenderIdentityInput,
  senderIdentityGaps
} from './SenderIdentityPanel';

const EMPTY = { legalName: null, postalAddress: null, privacyPolicyUrl: null, updatedAt: null };

describe('sender identity panel', () => {
  it('names what blocks email outreach', () => {
    expect(senderIdentityGaps(EMPTY)).toEqual(['postal address', 'privacy policy URL']);
    expect(
      senderIdentityGaps({
        ...EMPTY,
        postalAddress: 'Bahnhofstrasse 1',
        privacyPolicyUrl: 'https://northwind.example/privacy'
      })
    ).toEqual([]);
  });

  it('sends blanks as cleared fields', () => {
    expect(
      draftToSenderIdentityInput({
        legalName: ' Northwind GmbH ',
        postalAddress: '',
        privacyPolicyUrl: '  '
      })
    ).toEqual({ legalName: 'Northwind GmbH', postalAddress: null, privacyPolicyUrl: null });
  });

  it('gives the owner one primary save and shows the block', () => {
    const html = renderToStaticMarkup(
      <SenderIdentityForm
        draft={draftFromIdentity(EMPTY)}
        onChange={() => undefined}
        onSave={() => undefined}
        busy={false}
        isOwner
        error=""
        gaps={senderIdentityGaps(EMPTY)}
      />
    );
    expect(html).toContain('Sender identity');
    expect(html).toContain('Email outreach blocked');
    expect(html).toContain('Missing: postal address and privacy policy URL.');
    expect(html).toContain('Postal address');
    expect(html).toContain('Privacy policy URL');
    expect(html).toContain('Save sender identity');
    expect(html.match(/primary-button/g)).toHaveLength(1);
  });

  it('shows a member the values but no save', () => {
    const html = renderToStaticMarkup(
      <SenderIdentityForm
        draft={draftFromIdentity({ ...EMPTY, legalName: 'Northwind GmbH' })}
        onChange={() => undefined}
        onSave={() => undefined}
        busy={false}
        isOwner={false}
        error=""
        gaps={[]}
      />
    );
    expect(html).toContain('Northwind GmbH');
    expect(html).toContain('Complete');
    expect(html).toContain('Only the workspace owner can change the sender identity.');
    expect(html).not.toContain('Save sender identity');
  });
});
```

- [ ] **Step 9: Run it and watch it fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/client/SenderIdentityPanel.test.tsx`
Expected: FAIL, cannot resolve `./SenderIdentityPanel`.

- [ ] **Step 10: Client API (`src/client/api.ts`)**

1. Add after `import type { TodayPayload } from '../server/today';`:

```ts
import type { SenderIdentity } from '../server/compliance/sender-identity';
```

2. Directly after the closing `}` of `export async function getToday(): Promise<TodayPayload> {`, insert:

```ts
export async function getSenderIdentity(): Promise<SenderIdentity> {
  return (await request<{ senderIdentity: SenderIdentity }>('/api/workspace/sender-identity'))
    .senderIdentity;
}

export async function saveSenderIdentity(input: {
  legalName: string | null;
  postalAddress: string | null;
  privacyPolicyUrl: string | null;
}): Promise<SenderIdentity> {
  return (
    await request<{ senderIdentity: SenderIdentity }>('/api/workspace/sender-identity', {
      method: 'PUT',
      body: JSON.stringify(input)
    })
  ).senderIdentity;
}
```

- [ ] **Step 11: Create `src/client/SenderIdentityPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import type { SenderIdentity } from '../server/compliance/sender-identity';
import { getSenderIdentity, saveSenderIdentity } from './api';
import { errorMessage } from './LinkedInSafety';
import { ActionRow, FormGrid } from './ui/forms';
import { Panel } from './ui/layout';
import { Button, Field, Input, Textarea } from './ui/primitives';

export interface SenderIdentityDraft {
  legalName: string;
  postalAddress: string;
  privacyPolicyUrl: string;
}

export function draftFromIdentity(identity: SenderIdentity): SenderIdentityDraft {
  return {
    legalName: identity.legalName ?? '',
    postalAddress: identity.postalAddress ?? '',
    privacyPolicyUrl: identity.privacyPolicyUrl ?? ''
  };
}

/** What blocks email outreach right now, from the SAVED identity. */
export function senderIdentityGaps(identity: SenderIdentity): string[] {
  return [
    identity.postalAddress ? null : 'postal address',
    identity.privacyPolicyUrl ? null : 'privacy policy URL'
  ].filter((gap): gap is string => gap !== null);
}

export function draftToSenderIdentityInput(draft: SenderIdentityDraft) {
  const value = (text: string) => (text.trim() ? text.trim() : null);
  return {
    legalName: value(draft.legalName),
    postalAddress: value(draft.postalAddress),
    privacyPolicyUrl: value(draft.privacyPolicyUrl)
  };
}

export function SenderIdentityForm({
  draft,
  onChange,
  onSave,
  busy,
  isOwner,
  error,
  gaps
}: {
  draft: SenderIdentityDraft;
  onChange: (patch: Partial<SenderIdentityDraft>) => void;
  onSave: () => void;
  busy: boolean;
  isOwner: boolean;
  error: string;
  gaps: string[];
}) {
  return (
    <Panel
      title="Sender identity"
      description="Who your outreach email says it is from. Email outreach stays blocked until the postal address and privacy policy URL are set."
      icon={<Mail size={18} />}
      actions={
        <span className="status-pill">
          {gaps.length > 0 ? 'Email outreach blocked' : 'Complete'}
        </span>
      }
    >
      {gaps.length > 0 && <p className="li-hint">Missing: {gaps.join(' and ')}.</p>}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <FormGrid>
        <Field label="Legal name">
          <Input
            value={draft.legalName}
            disabled={!isOwner || busy}
            maxLength={200}
            onChange={(event) => onChange({ legalName: event.target.value })}
          />
        </Field>
        <Field label="Postal address" hint="A street address or a registered post office box.">
          <Textarea
            rows={3}
            value={draft.postalAddress}
            disabled={!isOwner || busy}
            maxLength={500}
            onChange={(event) => onChange({ postalAddress: event.target.value })}
          />
        </Field>
        <Field label="Privacy policy URL">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://"
            value={draft.privacyPolicyUrl}
            disabled={!isOwner || busy}
            maxLength={2048}
            onChange={(event) => onChange({ privacyPolicyUrl: event.target.value })}
          />
        </Field>
      </FormGrid>
      {isOwner ? (
        <ActionRow>
          <Button variant="primary" disabled={busy} onClick={onSave}>
            {busy ? 'Saving…' : 'Save sender identity'}
          </Button>
        </ActionRow>
      ) : (
        <p className="li-hint">Only the workspace owner can change the sender identity.</p>
      )}
    </Panel>
  );
}

export function SenderIdentityPanel({
  setToast,
  isOwner
}: {
  setToast: (message: string) => void;
  isOwner: boolean;
}) {
  const [saved, setSaved] = useState<SenderIdentity | null>(null);
  const [draft, setDraft] = useState<SenderIdentityDraft>({
    legalName: '',
    postalAddress: '',
    privacyPolicyUrl: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getSenderIdentity()
      .then((identity) => {
        if (!live) return;
        setSaved(identity);
        setDraft(draftFromIdentity(identity));
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause, 'Unable to read the sender identity.'));
      });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const identity = await saveSenderIdentity(draftToSenderIdentityInput(draft));
      setSaved(identity);
      setDraft(draftFromIdentity(identity));
      setToast('Sender identity saved.');
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to save the sender identity.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SenderIdentityForm
      draft={draft}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onSave={() => void save()}
      busy={busy || saved === null}
      isOwner={isOwner}
      error={error}
      gaps={saved ? senderIdentityGaps(saved) : []}
    />
  );
}
```

- [ ] **Step 12: Mount it on `/setup/workspace` (`src/client/App.tsx`)**

1. Add after `import { LinkedInExclusions, relativeTime } from './LinkedInScreen';`:

```ts
import { SenderIdentityPanel } from './SenderIdentityPanel';
```

2. Replace `          <LimitsView setToast={setToast} />` with:

```tsx
          <SenderIdentityPanel setToast={setToast} isOwner={isOwner} />
          <LimitsView setToast={setToast} />
```

- [ ] **Step 13: Run every Task 7 test and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/sender-identity.test.ts src/server/compliance/api.test.ts src/server/gtm/intent.test.ts src/client/SenderIdentityPanel.test.tsx`
Expected: PASS.

Then run `npm run dev` and open `/setup/workspace` as the owner and as a member.

- Check the light and dark themes and a 375px viewport.
- The member sees disabled fields and no button.
- Saving an `http://` URL shows the server's 400 in the `error-banner`.

- [ ] **Step 14: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/compliance/sender-identity.ts src/server/compliance/sender-identity.test.ts src/server/compliance/api.test.ts src/server/app.ts src/server/gtm/intent.ts src/server/gtm/intent.test.ts src/client/api.ts src/client/SenderIdentityPanel.tsx src/client/SenderIdentityPanel.test.tsx src/client/App.tsx
git commit -m "feat(compliance): workspace sender identity blocks email plans" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 8: Jurisdiction rules, lawful basis and country

**Files:**

- Create: `src/server/compliance/errors.ts`, `src/server/compliance/jurisdiction-rules.ts`, `src/server/compliance/jurisdiction-rules.test.ts`, `src/server/compliance/lawful-basis.ts`, `src/server/compliance/lawful-basis.test.ts`
- Modify: `src/server/app.ts` (routes; `ComplianceError` in the global error handler)
- Test: `src/server/compliance/api.test.ts`

**Interfaces:**

- Consumes:
  - `contact_lawful_bases`, `contacts.country_code`, `accounts.country_code` (Task 2)
  - `contacts`, `accounts`, `account_contacts`, `conversations`, `conversation_messages`, `inbound_submissions`, `linkedin_lead_contacts`, `linkedin_lead_list_members`
- Produces (`jurisdiction-rules.ts`, pure):
  - `JURISDICTION_RULES_DISCLAIMER = 'Not legal advice; verify with counsel.'`
  - `LAWFUL_BASES`, `type LawfulBasis`, `type ColdEmailRegime = 'consent_required' | 'basis_required' | 'opt_out'`
  - `COLD_EMAIL_RULES` (DE, AT, CH, CA, FR, GB, US), `UNKNOWN_RULE`, `ruleFor(country)`
  - `normalizeCountryCode(value)`, `countryFromDomain(domain)`, `isReservedEmailDomain(domain)`
  - `type CountrySource = 'contact' | 'lead_list' | 'account' | 'account_domain' | 'unknown'`, `resolveRecipientCountry(input)`
  - `type EmailPurpose = 'outreach' | 'reply' | 'qualified_demand'`
  - `interface LawfulBasisDecision { status: 'not_required' | 'satisfied' | 'missing'; country; countrySource; basis; reason }`, `decideEmailLawfulBasis(input)`
- Produces (`lawful-basis.ts`):
  - `recordLawfulBasis(db, input, now): Promise<{ record; created }>` (joins the caller's transaction; never opens one)
  - `withdrawLawfulBasis(db, { workspaceId, lawfulBasisId, actorUserId }, now)`, `listLawfulBases(db, workspaceId, personId)`
  - `setContactCountry(...)`, `setAccountCountry(...)`, `countryInputSchema`, `lawfulBasisInputSchema`
  - `evaluateEmailLawfulBases(db, workspaceId, inputs)` (one statement for any number of recipients), `evaluateEmailLawfulBasis(db, workspaceId, input)`
  - `emailLawfulBasisAttributes(db, workspaceId, payload): Promise<Record<string, unknown>>`, returning `{ lawfulBasisStatus: 'missing' | 'covered', lawfulBasisReason, recipientsMissingBasis }` or `{}` when the payload has no recipient
  - `countLeadListMissingEmailBasis(db, workspaceId, listId): Promise<{ checked; missing; truncated }>`
  - `personComplianceView(db, workspaceId, personId)`
- Produces (routes):
  - `GET /api/compliance/people/:personId` (any member)
  - `PUT /api/compliance/people/:personId/country` (owner)
  - `PUT /api/compliance/accounts/:accountId/country` (owner)
  - `POST /api/compliance/people/:personId/lawful-bases` (owner; 201 when created, 200 when it already existed)
  - `POST /api/compliance/lawful-bases/:id/withdraw` (any member)
- Events: `lawful_basis.recorded`, `lawful_basis.withdrawn`, `contact.country_set`, `account.country_set`, carrying ids, channel, basis, source and ISO codes only.

**The rule table.** Not legal advice; verify with counsel. It is conservative on purpose, and every rule cites a primary source.

| Country               | Regime           | Accepted recorded bases                          | Primary source                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DE                    | consent required | consent, existing customer                       | UWG §7 https://www.gesetze-im-internet.de/uwg_2004/__7.html                                                                                                                                                                                                                                         |
| AT                    | consent required | consent, existing customer                       | TKG 2021 §174 https://www.ris.bka.gv.at/eli/bgbl/i/2021/190/P174/NOR40238632                                                                                                                                                                                                                        |
| CH                    | consent required | consent, existing customer                       | UWG Art. 3 para. 1 lit. o https://www.fedlex.admin.ch/eli/cc/1988/223_223_223/de                                                                                                                                                                                                                    |
| CA                    | consent required | consent, existing customer (implied consent)     | CASL https://laws-lois.justice.gc.ca/eng/acts/E-1.6/ and CRTC https://crtc.gc.ca/eng/com500/guide.htm                                                                                                                                                                                               |
| FR                    | basis required   | consent, existing customer, legitimate interest  | CNIL https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel                                                                                                                                                                                         |
| GB                    | basis required   | consent, existing customer, legitimate interest  | PECR reg. 22 https://www.legislation.gov.uk/uksi/2003/2426/regulation/22 and ICO https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/ |
| US                    | opt-out          | none needed (postal address and opt-out instead) | FTC CAN-SPAM guide https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business                                                                                                                                                                                           |
| any other, or unknown | basis required   | consent, existing customer, legitimate interest  | none: Trevra's conservative default                                                                                                                                                                                                                                                                 |

The decision is deterministic, and these exemptions are checked in this order:

1. A reserved domain (RFC 2606/6761) is `not_required`, because no mail can reach it.
2. A `reply` to a person with an inbound email in their conversation is `not_required`: they wrote first.
3. A `qualified_demand` email to a person with an inbound capture submission is `not_required`: they asked.
4. A US recipient is `not_required` (opt-out regime).

Otherwise it is `satisfied` when an active recorded basis is in the rule's accepted list, and `missing` when none is.

Country resolution:

1. the person's explicit `contacts.country_code`;
2. the lead list's `linkedin_lead_contacts.country`;
3. the account's explicit `accounts.country_code`;
4. the account domain's ccTLD;
5. otherwise unknown.

The recipient's own email domain is never used.

- [ ] **Step 1: Write the failing pure tests**

Create `src/server/compliance/jurisdiction-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  COLD_EMAIL_RULES,
  JURISDICTION_RULES_DISCLAIMER,
  countryFromDomain,
  decideEmailLawfulBasis,
  isReservedEmailDomain,
  normalizeCountryCode,
  resolveRecipientCountry
} from './jurisdiction-rules.js';

function decide(
  country: string | null,
  bases: string[] = [],
  extra: Partial<Parameters<typeof decideEmailLawfulBasis>[0]> = {}
) {
  return decideEmailLawfulBasis({
    email: 'buyer@acme-gmbh.de',
    country,
    countrySource: country ? 'contact' : 'unknown',
    bases,
    purpose: 'outreach',
    hasInboundEmail: false,
    hasInboundRequest: false,
    ...extra
  });
}

describe('jurisdiction rules', () => {
  it('cites a primary source for every country it names and says it is not legal advice', () => {
    expect(JURISDICTION_RULES_DISCLAIMER).toBe('Not legal advice; verify with counsel.');
    expect(Object.keys(COLD_EMAIL_RULES).sort()).toEqual([
      'AT',
      'CA',
      'CH',
      'DE',
      'FR',
      'GB',
      'US'
    ]);
    for (const rule of Object.values(COLD_EMAIL_RULES)) {
      expect(rule.sources.length).toBeGreaterThan(0);
      expect(rule.sources.every((source) => source.startsWith('https://'))).toBe(true);
    }
  });

  it('reads country names and codes, and refuses what it cannot read', () => {
    expect(normalizeCountryCode('Germany')).toBe('DE');
    expect(normalizeCountryCode(' deutschland ')).toBe('DE');
    expect(normalizeCountryCode('uk')).toBe('GB');
    expect(normalizeCountryCode('United States')).toBe('US');
    expect(normalizeCountryCode('ch')).toBe('CH');
    expect(normalizeCountryCode('Atlantis')).toBeNull();
    expect(normalizeCountryCode('')).toBeNull();
    expect(normalizeCountryCode(42)).toBeNull();
  });

  it('takes a country from a ccTLD only, never from a generic or regional one', () => {
    expect(countryFromDomain('acme-gmbh.de')).toBe('DE');
    expect(countryFromDomain('acme.co.uk')).toBe('GB');
    expect(countryFromDomain('acme.ch')).toBe('CH');
    expect(countryFromDomain('acme.io')).toBeNull();
    expect(countryFromDomain('acme.com')).toBeNull();
    expect(countryFromDomain('acme.eu')).toBeNull();
    expect(countryFromDomain(null)).toBeNull();
  });

  it('knows the reserved test domains', () => {
    expect(isReservedEmailDomain('example.com')).toBe(true);
    expect(isReservedEmailDomain('mail.example.org')).toBe(true);
    expect(isReservedEmailDomain('people.test')).toBe(true);
    expect(isReservedEmailDomain('acme-gmbh.de')).toBe(false);
  });

  it('resolves the country from the person first, the account domain last', () => {
    const all = {
      contactCountry: 'FR',
      leadCountry: 'Germany',
      accountCountry: 'CH',
      accountDomain: 'acme.at'
    };
    expect(resolveRecipientCountry(all)).toEqual({ country: 'FR', source: 'contact' });
    expect(resolveRecipientCountry({ ...all, contactCountry: null })).toEqual({
      country: 'DE',
      source: 'lead_list'
    });
    expect(resolveRecipientCountry({ ...all, contactCountry: null, leadCountry: null })).toEqual({
      country: 'CH',
      source: 'account'
    });
    expect(
      resolveRecipientCountry({
        contactCountry: null,
        leadCountry: null,
        accountCountry: null,
        accountDomain: 'acme.at'
      })
    ).toEqual({ country: 'AT', source: 'account_domain' });
    expect(
      resolveRecipientCountry({
        contactCountry: null,
        leadCountry: 'Atlantis',
        accountCountry: null,
        accountDomain: 'acme.io'
      })
    ).toEqual({ country: null, source: 'unknown' });
  });

  it('denies cold email to Germany without consent or a customer relationship, without naming the address', () => {
    const decision = decide('DE', ['legitimate_interest']);
    expect(decision.status).toBe('missing');
    expect(decision.reason).toBe(
      'Cold email to a recipient in DE needs recorded consent or an existing-customer relationship; none is recorded for this person.'
    );
    expect(decision.reason).not.toContain('acme-gmbh');
    expect(decide('DE', ['consent'])).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('accepts a recorded legitimate interest in FR and GB, and needs nothing recorded in the US', () => {
    expect(decide('FR', ['legitimate_interest'])).toMatchObject({
      status: 'satisfied',
      basis: 'legitimate_interest'
    });
    expect(decide('GB', [])).toMatchObject({ status: 'missing' });
    expect(decide('US', [])).toMatchObject({ status: 'not_required', basis: null });
  });

  it('requires an explicit basis for an unknown country and for a country with no rule', () => {
    expect(decide(null).reason).toBe(
      'Cold email to a recipient in an unknown country needs recorded consent, an existing-customer relationship, or a recorded legitimate interest; none is recorded for this person.'
    );
    expect(decide(null)).toMatchObject({ status: 'missing', countrySource: 'unknown' });
    expect(decide('JP')).toMatchObject({ status: 'missing' });
    expect(decide('JP', ['legitimate_interest'])).toMatchObject({ status: 'satisfied' });
  });

  it('exempts only what is not cold: reserved domains, replies to inbound email, answers to an inbound request', () => {
    expect(decide('DE', [], { email: 'lead@example.com' }).status).toBe('not_required');
    expect(decide('DE', [], { purpose: 'reply', hasInboundEmail: true }).status).toBe(
      'not_required'
    );
    expect(decide('DE', [], { purpose: 'reply', hasInboundEmail: false }).status).toBe('missing');
    expect(decide('DE', [], { purpose: 'qualified_demand', hasInboundRequest: true }).status).toBe(
      'not_required'
    );
    expect(decide('DE', [], { purpose: 'outreach', hasInboundRequest: true }).status).toBe(
      'missing'
    );
  });
});
```

- [ ] **Step 2: Write the failing store tests**

Create `src/server/compliance/lawful-basis.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import {
  emailLawfulBasisAttributes,
  evaluateEmailLawfulBasis,
  listLawfulBases,
  recordLawfulBasis,
  setAccountCountry,
  setContactCountry,
  withdrawLawfulBasis
} from './lawful-basis.js';

const WORKSPACE = 'ws_lawful_basis_test';
const OTHER = 'ws_lawful_basis_other';
const NOW = new Date('2026-08-21T09:00:00.000Z');
const LATER = new Date('2026-08-22T09:00:00.000Z');
const MAYA = 'con_lb_maya';
const EMAIL = 'maya@acme-gmbh.de';
let db: Db;

const evaluate = (workspaceId = WORKSPACE) =>
  evaluateEmailLawfulBasis(db, workspaceId, { email: EMAIL });

const consent = (workspaceId = WORKSPACE, sourceRef: string | null = 'signed-form') =>
  recordLawfulBasis(
    db,
    {
      workspaceId,
      personId: MAYA,
      channel: 'email',
      basis: 'consent',
      source: 'operator',
      sourceRef,
      actorUserId: null
    },
    NOW
  );

async function events(type: string) {
  return (await listDomainEvents(db, WORKSPACE, { streamType: 'contact', streamId: MAYA })).filter(
    (event) => event.eventType === type
  );
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
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES (?,?,'Maya',?,?,?,?)`
    )
    .run(MAYA, WORKSPACE, EMAIL, EMAIL, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO accounts (id,workspace_id,name,domain,created_at,updated_at)
       VALUES ('acc_lb_acme',?,'Acme GmbH','acme-gmbh.de',?,?)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO account_contacts (id,workspace_id,account_id,contact_id,source,confidence,created_at,updated_at)
       VALUES ('acon_lb_acme',?,'acc_lb_acme',?,'test','explicit',?,?)`
    )
    .run(WORKSPACE, MAYA, NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});

describe('lawful basis for cold email', () => {
  it('derives Germany from the account domain and denies cold email without a basis', async () => {
    const decision = await evaluate();
    expect(decision).toMatchObject({
      status: 'missing',
      country: 'DE',
      countrySource: 'account_domain',
      basis: null
    });
    expect(decision.reason).not.toContain(EMAIL);
  });

  it('lets an explicit country override the account, and refuses one it cannot read', async () => {
    expect(
      await setContactCountry(
        db,
        { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'United States', actorUserId: null },
        NOW
      )
    ).toEqual({ countryCode: 'US' });
    expect(await evaluate()).toMatchObject({ status: 'not_required', countrySource: 'contact' });

    await expect(
      setContactCountry(
        db,
        { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'Atlantis', actorUserId: null },
        NOW
      )
    ).rejects.toMatchObject({ status: 400 });

    await setContactCountry(
      db,
      { workspaceId: WORKSPACE, personId: MAYA, countryCode: null, actorUserId: null },
      NOW
    );
    await setAccountCountry(
      db,
      { workspaceId: WORKSPACE, accountId: 'acc_lb_acme', countryCode: 'CH', actorUserId: null },
      NOW
    );
    expect(await evaluate()).toMatchObject({ country: 'CH', countrySource: 'account' });
  });

  it('records a basis once, with its source, and lets it cover cold email', async () => {
    const first = await consent();
    const second = await consent();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(first.record).toMatchObject({
      personId: MAYA,
      channel: 'email',
      basis: 'consent',
      source: 'operator',
      sourceRef: 'signed-form',
      recordedAt: NOW.toISOString(),
      withdrawnAt: null
    });
    const recorded = await events('lawful_basis.recorded');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(EMAIL);
    expect(await evaluate()).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('blocks again once the consent is withdrawn', async () => {
    const { record } = await consent();
    const withdrawn = await withdrawLawfulBasis(
      db,
      { workspaceId: WORKSPACE, lawfulBasisId: record.id, actorUserId: null },
      LATER
    );
    expect(withdrawn.withdrawnAt).toBe(LATER.toISOString());
    await withdrawLawfulBasis(
      db,
      { workspaceId: WORKSPACE, lawfulBasisId: record.id, actorUserId: null },
      LATER
    );
    expect(await events('lawful_basis.withdrawn')).toHaveLength(1);
    expect(await evaluate()).toMatchObject({ status: 'missing', country: 'DE' });

    const again = await consent();
    expect(again.created).toBe(true);
    expect(await listLawfulBases(db, WORKSPACE, MAYA)).toHaveLength(2);
  });

  it('does not count a basis the country rule does not accept', async () => {
    await recordLawfulBasis(
      db,
      {
        workspaceId: WORKSPACE,
        personId: MAYA,
        channel: 'email',
        basis: 'legitimate_interest',
        source: 'operator',
        actorUserId: null
      },
      NOW
    );
    expect((await evaluate()).status).toBe('missing');
    await setContactCountry(
      db,
      { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'FR', actorUserId: null },
      NOW
    );
    expect(await evaluate()).toMatchObject({ status: 'satisfied', basis: 'legitimate_interest' });
  });

  it('never reads or writes another workspace people', async () => {
    await consent();
    await expect(consent(OTHER)).rejects.toMatchObject({ status: 404 });
    await expect(
      withdrawLawfulBasis(
        db,
        {
          workspaceId: OTHER,
          lawfulBasisId: (await listLawfulBases(db, WORKSPACE, MAYA))[0]!.id,
          actorUserId: null
        },
        NOW
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(await listLawfulBases(db, OTHER, MAYA)).toEqual([]);
    expect(await evaluate(OTHER)).toMatchObject({
      status: 'missing',
      country: null,
      countrySource: 'unknown'
    });
    expect(await evaluate()).toMatchObject({ status: 'satisfied' });
  });

  it('derives policy attributes from the payload recipients, never from fields the payload claims', async () => {
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, {
        recipient: EMAIL,
        lawfulBasisStatus: 'covered',
        metadata: { deliveryPurpose: 'outreach' }
      })
    ).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, { recipients: [EMAIL, 'lead@example.com'] })
    ).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, { recipient: 'lead@example.com' })
    ).toMatchObject({ lawfulBasisStatus: 'covered', recipientsMissingBasis: 0 });
    expect(await emailLawfulBasisAttributes(db, WORKSPACE, { subject: 'No recipient' })).toEqual(
      {}
    );
  });
});
```

Append to `src/server/compliance/api.test.ts`:

```ts
describe('lawful basis API', () => {
  it('lets only the owner unblock, lets any member block, and stays inside the workspace', async () => {
    const { owner, member } = await ownerAndMember();
    const outsider = await signUp('compliance-lb-outsider');
    const now = new Date().toISOString();
    const suffix = `${Date.now()}_${signUpSeq}`;
    const personId = `con_compliance_api_${suffix}`;
    const accountId = `acc_compliance_api_${suffix}`;
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,'Maya','maya@acme-gmbh.de','maya@acme-gmbh.de',?,?)`
      )
      .run(personId, owner.auth.workspaceId, now, now);
    await db
      .prepare(
        `INSERT INTO accounts (id,workspace_id,name,domain,created_at,updated_at)
         VALUES (?,?,'Acme GmbH','acme-gmbh.de',?,?)`
      )
      .run(accountId, owner.auth.workspaceId, now, now);

    await outsider.agent.get(`/api/compliance/people/${personId}`).expect(404);
    const before = await member.agent.get(`/api/compliance/people/${personId}`).expect(200);
    expect(before.body.person.emailDecision).toMatchObject({ status: 'missing' });
    expect(before.body.person.disclaimer).toBe('Not legal advice; verify with counsel.');

    await member.agent
      .put(`/api/compliance/people/${personId}/country`)
      .send({ countryCode: 'DE' })
      .expect(403);
    await owner.agent
      .put(`/api/compliance/people/${personId}/country`)
      .send({ countryCode: 'Atlantis' })
      .expect(400);
    const country = await owner.agent
      .put(`/api/compliance/people/${personId}/country`)
      .send({ countryCode: 'Germany' })
      .expect(200);
    expect(country.body).toEqual({ countryCode: 'DE' });
    await outsider.agent
      .put(`/api/compliance/accounts/${accountId}/country`)
      .send({ countryCode: 'CH' })
      .expect(404);
    await owner.agent
      .put(`/api/compliance/accounts/${accountId}/country`)
      .send({ countryCode: 'CH' })
      .expect(200);

    await member.agent
      .post(`/api/compliance/people/${personId}/lawful-bases`)
      .send({ channel: 'email', basis: 'consent' })
      .expect(403);
    await owner.agent
      .post(`/api/compliance/people/${personId}/lawful-bases`)
      .send({ channel: 'email', basis: 'consented' })
      .expect(400);
    const created = await owner.agent
      .post(`/api/compliance/people/${personId}/lawful-bases`)
      .send({ channel: 'email', basis: 'consent', sourceRef: 'signed-form-2026-08' })
      .expect(201);
    await owner.agent
      .post(`/api/compliance/people/${personId}/lawful-bases`)
      .send({ channel: 'email', basis: 'consent', sourceRef: 'signed-form-2026-08' })
      .expect(200);
    const covered = await member.agent.get(`/api/compliance/people/${personId}`).expect(200);
    expect(covered.body.person.emailDecision).toMatchObject({
      status: 'satisfied',
      country: 'DE',
      basis: 'consent'
    });

    const lawfulBasisId = created.body.lawfulBasis.id as string;
    await outsider.agent.post(`/api/compliance/lawful-bases/${lawfulBasisId}/withdraw`).expect(404);
    const withdrawn = await member.agent
      .post(`/api/compliance/lawful-bases/${lawfulBasisId}/withdraw`)
      .expect(200);
    expect(withdrawn.body.lawfulBasis.withdrawnAt).not.toBeNull();
    const after = await member.agent.get(`/api/compliance/people/${personId}`).expect(200);
    expect(after.body.person.emailDecision).toMatchObject({ status: 'missing' });
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/jurisdiction-rules.test.ts src/server/compliance/lawful-basis.test.ts src/server/compliance/api.test.ts`
Expected: FAIL.

- `jurisdiction-rules.test.ts` and `lawful-basis.test.ts`: cannot resolve `./jurisdiction-rules.js` / `./lawful-basis.js`.
- `api.test.ts` › "lawful basis API": 404 where 200 is expected.

- [ ] **Step 4: Create `src/server/compliance/errors.ts`**

```ts
/** A refusal from the compliance store, carried to the HTTP status it means. */
export class ComplianceError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'ComplianceError';
  }
}
```

- [ ] **Step 5: Create `src/server/compliance/jurisdiction-rules.ts`**

```ts
/* ---------------------------------------------------------------------------
 * COLD EMAIL BY RECIPIENT COUNTRY: a deliberately conservative, static table.
 *
 * NOT LEGAL ADVICE; VERIFY WITH COUNSEL. Every rule names its primary source.
 * Where a country allows B2B email on a legitimate interest, Trevra still
 * requires that interest to be RECORDED for the person, and a country with no
 * rule here -- or no known country at all -- requires an explicit recorded
 * basis. Pure functions only: the store is lawful-basis.ts, and no model
 * output reaches any of this.
 * ------------------------------------------------------------------------ */

export const JURISDICTION_RULES_DISCLAIMER = 'Not legal advice; verify with counsel.';

export const LAWFUL_BASES = ['consent', 'existing_customer', 'legitimate_interest'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export type ColdEmailRegime = 'consent_required' | 'basis_required' | 'opt_out';

export interface ColdEmailRule {
  country: string | null;
  regime: ColdEmailRegime;
  accepts: readonly LawfulBasis[];
  summary: string;
  sources: readonly string[];
}

const SOURCES = {
  ftc: 'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business',
  uwgDe: 'https://www.gesetze-im-internet.de/uwg_2004/__7.html',
  uwgCh: 'https://www.fedlex.admin.ch/eli/cc/1988/223_223_223/de',
  tkgAt: 'https://www.ris.bka.gv.at/eli/bgbl/i/2021/190/P174/NOR40238632',
  cnil: 'https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel',
  pecr: 'https://www.legislation.gov.uk/uksi/2003/2426/regulation/22',
  ico: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/',
  casl: 'https://laws-lois.justice.gc.ca/eng/acts/E-1.6/',
  crtc: 'https://crtc.gc.ca/eng/com500/guide.htm'
} as const;

const CONSENT_OR_CUSTOMER: readonly LawfulBasis[] = ['consent', 'existing_customer'];

export const COLD_EMAIL_RULES: Readonly<Record<string, ColdEmailRule>> = {
  DE: {
    country: 'DE',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Germany: advertising email needs prior express consent, with a narrow existing-customer exception (UWG section 7).',
    sources: [SOURCES.uwgDe]
  },
  AT: {
    country: 'AT',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Austria: direct-marketing email needs prior consent, with a narrow existing-customer exception (TKG 2021 section 174).',
    sources: [SOURCES.tkgAt]
  },
  CH: {
    country: 'CH',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Switzerland: mass advertising by email needs prior consent unless the recipient is an existing customer (UWG Art. 3 para. 1 lit. o).',
    sources: [SOURCES.uwgCh]
  },
  CA: {
    country: 'CA',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Canada: commercial electronic messages need express or implied consent; an existing business relationship is implied consent (CASL).',
    sources: [SOURCES.casl, SOURCES.crtc]
  },
  FR: {
    country: 'FR',
    regime: 'basis_required',
    accepts: LAWFUL_BASES,
    summary:
      'France: email to individuals needs consent; email to a professional about their job may rely on a legitimate interest (CNIL).',
    sources: [SOURCES.cnil]
  },
  GB: {
    country: 'GB',
    regime: 'basis_required',
    accepts: LAWFUL_BASES,
    summary:
      'United Kingdom: email to individual subscribers needs consent or the soft opt-in; corporate subscribers are outside regulation 22 but still need a lawful basis (PECR, ICO).',
    sources: [SOURCES.pecr, SOURCES.ico]
  },
  US: {
    country: 'US',
    regime: 'opt_out',
    accepts: LAWFUL_BASES,
    summary:
      'United States: commercial email needs no prior consent but must carry a postal address, a working opt-out and honest headers (CAN-SPAM).',
    sources: [SOURCES.ftc]
  }
};

export const UNKNOWN_RULE: ColdEmailRule = {
  country: null,
  regime: 'basis_required',
  accepts: LAWFUL_BASES,
  summary: 'Country unknown: Trevra requires an explicit recorded basis before cold email.',
  sources: []
};

export function ruleFor(country: string | null): ColdEmailRule {
  if (!country) return UNKNOWN_RULE;
  return (
    COLD_EMAIL_RULES[country] ?? {
      country,
      regime: 'basis_required',
      accepts: LAWFUL_BASES,
      summary: `No rule is recorded for ${country}: Trevra requires an explicit recorded basis before cold email.`,
      sources: []
    }
  );
}

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  germany: 'DE',
  deutschland: 'DE',
  austria: 'AT',
  österreich: 'AT',
  oesterreich: 'AT',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  svizzera: 'CH',
  france: 'FR',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  canada: 'CA'
};

/** An ISO 3166-1 alpha-2 code, or null when the value is not one Trevra can read. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  const named = COUNTRY_NAMES[key];
  if (named) return named;
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}

// Two-letter TLDs sold as generic names; they say nothing about a country.
const GENERIC_COUNTRY_TLDS = new Set([
  'ai',
  'cc',
  'co',
  'fm',
  'gg',
  'io',
  'ly',
  'me',
  'sh',
  'so',
  'to',
  'tv',
  'vc',
  'ws'
]);

function hostOf(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]!
    .replace(/\.+$/, '');
}

/** The country of a ccTLD (`uk` -> GB), or null for a generic or regional TLD. */
export function countryFromDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const tld = hostOf(domain).split('.').pop() ?? '';
  if (!/^[a-z]{2}$/.test(tld) || tld === 'eu' || GENERIC_COUNTRY_TLDS.has(tld)) return null;
  return tld === 'uk' ? 'GB' : tld.toUpperCase();
}

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** RFC 2606 / RFC 6761 names: no mail can ever be delivered there. */
export function isReservedEmailDomain(domain: string): boolean {
  const host = hostOf(domain);
  const tld = host.split('.').pop() ?? '';
  return (
    RESERVED_TLDS.has(tld) ||
    RESERVED_DOMAINS.some((reserved) => host === reserved || host.endsWith(`.${reserved}`))
  );
}

export type CountrySource = 'contact' | 'lead_list' | 'account' | 'account_domain' | 'unknown';

/** Explicit beats derived, the person beats the company, and nothing is guessed. */
export function resolveRecipientCountry(input: {
  contactCountry: string | null;
  leadCountry: string | null;
  accountCountry: string | null;
  accountDomain: string | null;
}): { country: string | null; source: CountrySource } {
  const contact = normalizeCountryCode(input.contactCountry);
  if (contact) return { country: contact, source: 'contact' };
  const lead = normalizeCountryCode(input.leadCountry);
  if (lead) return { country: lead, source: 'lead_list' };
  const account = normalizeCountryCode(input.accountCountry);
  if (account) return { country: account, source: 'account' };
  const fromDomain = countryFromDomain(input.accountDomain);
  if (fromDomain) return { country: fromDomain, source: 'account_domain' };
  return { country: null, source: 'unknown' };
}

export type EmailPurpose = 'outreach' | 'reply' | 'qualified_demand';

export interface LawfulBasisDecision {
  status: 'not_required' | 'satisfied' | 'missing';
  country: string | null;
  countrySource: CountrySource;
  basis: LawfulBasis | null;
  /** Country code and basis labels only: never an address, a name or a body. */
  reason: string;
}

const BASIS_LABEL: Record<LawfulBasis, string> = {
  consent: 'recorded consent',
  existing_customer: 'an existing-customer relationship',
  legitimate_interest: 'a recorded legitimate interest'
};

function orList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

export function decideEmailLawfulBasis(input: {
  email: string;
  country: string | null;
  countrySource: CountrySource;
  bases: readonly string[];
  purpose: EmailPurpose;
  hasInboundEmail: boolean;
  hasInboundRequest: boolean;
}): LawfulBasisDecision {
  const where = { country: input.country, countrySource: input.countrySource };
  const domain = input.email.includes('@')
    ? input.email.slice(input.email.lastIndexOf('@') + 1)
    : '';
  if (domain && isReservedEmailDomain(domain))
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'Reserved test domain: no mail can reach it.'
    };
  if (input.purpose === 'reply' && input.hasInboundEmail)
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'A reply to a person who emailed first is not cold email.'
    };
  if (input.purpose === 'qualified_demand' && input.hasInboundRequest)
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'An answer to a request this person submitted is not cold email.'
    };

  const rule = ruleFor(input.country);
  if (rule.regime === 'opt_out')
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: `${input.country} allows commercial email without prior consent when it carries a postal address and an opt-out.`
    };

  const basis = rule.accepts.find((accepted) => input.bases.includes(accepted)) ?? null;
  const place = input.country ?? 'an unknown country';
  if (basis)
    return {
      ...where,
      status: 'satisfied',
      basis,
      reason: `${BASIS_LABEL[basis].charAt(0).toUpperCase()}${BASIS_LABEL[basis].slice(1)} covers cold email to a recipient in ${place}.`
    };
  return {
    ...where,
    status: 'missing',
    basis: null,
    reason: `Cold email to a recipient in ${place} needs ${orList(
      rule.accepts.map((accepted) => BASIS_LABEL[accepted])
    )}; none is recorded for this person.`
  };
}
```

- [ ] **Step 6: Create `src/server/compliance/lawful-basis.ts`**

```ts
import { z } from 'zod';
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { ComplianceError } from './errors.js';
import {
  JURISDICTION_RULES_DISCLAIMER,
  LAWFUL_BASES,
  decideEmailLawfulBasis,
  normalizeCountryCode,
  resolveRecipientCountry,
  type EmailPurpose,
  type LawfulBasis,
  type LawfulBasisDecision
} from './jurisdiction-rules.js';

/* ---------------------------------------------------------------------------
 * PER-PERSON, PER-CHANNEL LAWFUL BASIS, with its source and timestamp.
 *
 * Rows are withdrawn, never deleted, so "why did Trevra send this" keeps an
 * answer. Every query is scoped by workspace. Recording a basis can unblock
 * cold email, so the routes keep it owner-only; a withdrawal only ever blocks.
 * Not legal advice; verify with counsel.
 * ------------------------------------------------------------------------ */

export const LAWFUL_BASIS_CHANNELS = ['email', 'linkedin'] as const;
export type LawfulBasisChannel = (typeof LAWFUL_BASIS_CHANNELS)[number];
export type LawfulBasisSource = 'inbound_capture' | 'operator';

// lc-debt: ceiling of 500 people checked per lead-list plan; upgrade path is a
// set-based count once the rule table is mirrored in SQL.
export const LEAD_LIST_BASIS_CHECK_LIMIT = 500;

const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const RECORD_COLUMNS = `id, person_id, channel, basis, source, source_ref,
  TO_CHAR(recorded_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS recorded_at,
  TO_CHAR(withdrawn_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS withdrawn_at`;

export interface LawfulBasisRecord {
  id: string;
  personId: string;
  channel: LawfulBasisChannel;
  basis: LawfulBasis;
  source: LawfulBasisSource;
  sourceRef: string | null;
  recordedAt: string;
  withdrawnAt: string | null;
}

interface LawfulBasisRow {
  id: string;
  person_id: string;
  channel: LawfulBasisChannel;
  basis: LawfulBasis;
  source: LawfulBasisSource;
  source_ref: string | null;
  recorded_at: string;
  withdrawn_at: string | null;
}

function toRecord(row: LawfulBasisRow): LawfulBasisRecord {
  return {
    id: row.id,
    personId: row.person_id,
    channel: row.channel,
    basis: row.basis,
    source: row.source,
    sourceRef: row.source_ref,
    recordedAt: row.recorded_at,
    withdrawnAt: row.withdrawn_at
  };
}

export const lawfulBasisInputSchema = z
  .object({
    channel: z.enum(LAWFUL_BASIS_CHANNELS),
    basis: z.enum(LAWFUL_BASES),
    sourceRef: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const countryInputSchema = z.object({ countryCode: z.string().max(60).nullable() }).strict();

function actorTypeOf(actorUserId: string | null | undefined): 'user' | 'system' {
  return actorUserId ? 'user' : 'system';
}

export async function recordLawfulBasis(
  db: Db,
  input: {
    workspaceId: string;
    personId: string;
    channel: LawfulBasisChannel;
    basis: LawfulBasis;
    source: LawfulBasisSource;
    sourceRef?: string | null;
    /** When the basis came into being. Defaults to `now`. */
    recordedAt?: string;
    actorUserId?: string | null;
  },
  now: Date
): Promise<{ record: LawfulBasisRecord; created: boolean }> {
  const person = await db
    .prepare('SELECT id FROM contacts WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(input.workspaceId, input.personId);
  if (!person) throw new ComplianceError('Person not found', 404);

  const sourceRef = input.sourceRef ?? null;
  const inserted = await db
    .prepare(
      `INSERT INTO contact_lawful_bases
         (id, workspace_id, person_id, channel, basis, source, source_ref, recorded_at, recorded_by_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?::timestamptz,?,?::timestamptz)
       ON CONFLICT (workspace_id, person_id, channel, basis, source, (COALESCE(source_ref, '')))
         WHERE withdrawn_at IS NULL DO NOTHING
       RETURNING id`
    )
    .get<{ id: string }>(
      id('clb'),
      input.workspaceId,
      input.personId,
      input.channel,
      input.basis,
      input.source,
      sourceRef,
      input.recordedAt ?? now.toISOString(),
      input.actorUserId ?? null,
      now.toISOString()
    );
  const row = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases
       WHERE workspace_id=? AND person_id=? AND channel=? AND basis=? AND source=?
         AND COALESCE(source_ref, '')=? AND withdrawn_at IS NULL`
    )
    .get<LawfulBasisRow>(
      input.workspaceId,
      input.personId,
      input.channel,
      input.basis,
      input.source,
      sourceRef ?? ''
    );
  if (!row) throw new Error('Lawful basis could not be recorded');
  if (inserted)
    await appendDomainEvent(db, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: input.personId,
      eventType: 'lawful_basis.recorded',
      actorType: actorTypeOf(input.actorUserId),
      actorId: input.actorUserId ?? null,
      payload: {
        lawfulBasisId: row.id,
        channel: input.channel,
        basis: input.basis,
        source: input.source
      },
      occurredAt: now
    });
  return { record: toRecord(row), created: Boolean(inserted) };
}

/** Idempotent: withdrawing a withdrawn basis returns it unchanged. */
export async function withdrawLawfulBasis(
  db: Db,
  input: { workspaceId: string; lawfulBasisId: string; actorUserId: string | null },
  now: Date
): Promise<LawfulBasisRecord> {
  const updated = await db
    .prepare(
      `UPDATE contact_lawful_bases SET withdrawn_at=?::timestamptz, withdrawn_by_user_id=?
       WHERE workspace_id=? AND id=? AND withdrawn_at IS NULL
       RETURNING id`
    )
    .get<{ id: string }>(
      now.toISOString(),
      input.actorUserId,
      input.workspaceId,
      input.lawfulBasisId
    );
  const row = await db
    .prepare(`SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases WHERE workspace_id=? AND id=?`)
    .get<LawfulBasisRow>(input.workspaceId, input.lawfulBasisId);
  if (!row) throw new ComplianceError('Lawful basis not found', 404);
  if (updated)
    await appendDomainEvent(db, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: row.person_id,
      eventType: 'lawful_basis.withdrawn',
      actorType: actorTypeOf(input.actorUserId),
      actorId: input.actorUserId,
      payload: { lawfulBasisId: row.id, channel: row.channel, basis: row.basis },
      occurredAt: now
    });
  return toRecord(row);
}

export async function listLawfulBases(
  db: Db,
  workspaceId: string,
  personId: string
): Promise<LawfulBasisRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases
       WHERE workspace_id=? AND person_id=?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all<LawfulBasisRow>(workspaceId, personId);
  return rows.map(toRecord);
}

function countryOrRefuse(countryCode: string | null): string | null {
  if (countryCode === null || countryCode.trim() === '') return null;
  const code = normalizeCountryCode(countryCode);
  if (!code)
    throw new ComplianceError(
      'Use a two-letter ISO country code such as DE or US, or leave the country empty.',
      400
    );
  return code;
}

export async function setContactCountry(
  db: Db,
  input: {
    workspaceId: string;
    personId: string;
    countryCode: string | null;
    actorUserId: string | null;
  },
  now: Date
): Promise<{ countryCode: string | null }> {
  const countryCode = countryOrRefuse(input.countryCode);
  const row = await db
    .prepare(
      `UPDATE contacts SET country_code=?, updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? RETURNING id`
    )
    .get<{ id: string }>(countryCode, now.toISOString(), input.workspaceId, input.personId);
  if (!row) throw new ComplianceError('Person not found', 404);
  await appendDomainEvent(db, {
    workspaceId: input.workspaceId,
    streamType: 'contact',
    streamId: input.personId,
    eventType: 'contact.country_set',
    actorType: actorTypeOf(input.actorUserId),
    actorId: input.actorUserId,
    payload: { countryCode },
    occurredAt: now
  });
  return { countryCode };
}

export async function setAccountCountry(
  db: Db,
  input: {
    workspaceId: string;
    accountId: string;
    countryCode: string | null;
    actorUserId: string | null;
  },
  now: Date
): Promise<{ countryCode: string | null }> {
  const countryCode = countryOrRefuse(input.countryCode);
  const row = await db
    .prepare(
      `UPDATE accounts SET country_code=?, updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? RETURNING id`
    )
    .get<{ id: string }>(countryCode, now.toISOString(), input.workspaceId, input.accountId);
  if (!row) throw new ComplianceError('Account not found', 404);
  await appendDomainEvent(db, {
    workspaceId: input.workspaceId,
    streamType: 'account',
    streamId: input.accountId,
    eventType: 'account.country_set',
    actorType: actorTypeOf(input.actorUserId),
    actorId: input.actorUserId,
    payload: { countryCode },
    occurredAt: now
  });
  return { countryCode };
}

export interface EmailRecipientInput {
  email: string;
  /** The canonical person, when the caller knows it; otherwise matched by email. */
  personId?: string | null;
  /** `linkedin_lead_contacts.country`, as imported. */
  leadCountry?: string | null;
  purpose?: EmailPurpose;
}

interface RecipientFactsRow {
  ord: number;
  contact_country: string | null;
  account_country: string | null;
  account_domain: string | null;
  bases: unknown;
  has_inbound_email: boolean | null;
  has_inbound_request: boolean | null;
}

/**
 * One decision per input, in input order, from ONE statement. Every table is
 * read inside `workspaceId`; an unmatched address is an unknown person in an
 * unknown country, which the rule table treats as needing a basis.
 */
export async function evaluateEmailLawfulBases(
  db: Db,
  workspaceId: string,
  inputs: readonly EmailRecipientInput[]
): Promise<LawfulBasisDecision[]> {
  if (inputs.length === 0) return [];
  const rows = await db
    .prepare(
      `
      WITH input AS (
        SELECT ord::int AS ord, LOWER(TRIM(email)) AS email, NULLIF(person_id, '') AS person_id
        FROM unnest(?::text[], ?::text[]) WITH ORDINALITY AS t(email, person_id, ord)
      )
      SELECT i.ord,
             c.country_code AS contact_country,
             acct.country_code AS account_country,
             acct.domain AS account_domain,
             COALESCE((
               SELECT jsonb_agg(DISTINCT b.basis) FROM contact_lawful_bases b
               WHERE b.workspace_id=? AND b.person_id=c.id AND b.channel='email' AND b.withdrawn_at IS NULL
             ), '[]'::jsonb) AS bases,
             EXISTS (
               SELECT 1 FROM conversation_messages m
               JOIN conversations cv ON cv.id=m.conversation_id AND cv.workspace_id=m.workspace_id
               WHERE cv.workspace_id=? AND cv.person_id=c.id AND m.channel='email' AND m.direction='inbound'
             ) AS has_inbound_email,
             EXISTS (
               SELECT 1 FROM inbound_submissions s WHERE s.workspace_id=? AND s.contact_id=c.id
             ) AS has_inbound_request
      FROM input i
      LEFT JOIN contacts c
        ON c.workspace_id=?
       AND ((i.person_id IS NOT NULL AND c.id=i.person_id)
         OR (i.person_id IS NULL AND c.email_normalized=i.email))
      LEFT JOIN LATERAL (
        SELECT a.country_code, a.domain
        FROM account_contacts ac
        JOIN accounts a ON a.workspace_id=ac.workspace_id AND a.id=ac.account_id
        WHERE ac.workspace_id=? AND ac.contact_id=c.id
        ORDER BY CASE ac.confidence WHEN 'explicit' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END,
                 a.updated_at DESC, a.id ASC
        LIMIT 1
      ) acct ON TRUE
      ORDER BY i.ord
    `
    )
    .all<RecipientFactsRow>(
      inputs.map((input) => input.email),
      inputs.map((input) => input.personId ?? null),
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId
    );
  const byOrd = new Map(rows.map((row) => [Number(row.ord), row]));
  return inputs.map((input, index) => {
    const row = byOrd.get(index + 1);
    const resolved = resolveRecipientCountry({
      contactCountry: row?.contact_country ?? null,
      leadCountry: input.leadCountry ?? null,
      accountCountry: row?.account_country ?? null,
      accountDomain: row?.account_domain ?? null
    });
    return decideEmailLawfulBasis({
      email: input.email.trim().toLowerCase(),
      country: resolved.country,
      countrySource: resolved.source,
      bases: Array.isArray(row?.bases) ? row.bases.map(String) : [],
      purpose: input.purpose ?? 'outreach',
      hasInboundEmail: row?.has_inbound_email === true,
      hasInboundRequest: row?.has_inbound_request === true
    });
  });
}

export async function evaluateEmailLawfulBasis(
  db: Db,
  workspaceId: string,
  input: EmailRecipientInput
): Promise<LawfulBasisDecision> {
  return (await evaluateEmailLawfulBases(db, workspaceId, [input]))[0]!;
}

function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The same keys, in the same order, that `policyAttributesFrom` counts. */
function recipientsOf(source: Record<string, unknown>): string[] {
  for (const key of ['recipients', 'to', 'recipient']) {
    const value = source[key];
    if (Array.isArray(value))
      return value.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== ''
      );
    if (typeof value === 'string' && value.trim() !== '') return [value];
  }
  return [];
}

/**
 * Policy attributes for an `email.send` payload. Computed from the database
 * for the payload's RECIPIENTS; a status the payload claims for itself is
 * never read. Returns `{}` when there is nobody to send to.
 */
export async function emailLawfulBasisAttributes(
  db: Db,
  workspaceId: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  const source = plainObject(payload);
  const recipients = recipientsOf(source);
  if (recipients.length === 0) return {};
  const metadata = plainObject(source.metadata);
  const purpose: EmailPurpose =
    metadata.deliveryPurpose === 'reply'
      ? 'reply'
      : metadata.deliverySourceType === 'qualified_demand'
        ? 'qualified_demand'
        : 'outreach';
  const personId =
    recipients.length === 1 && typeof metadata.personId === 'string' && metadata.personId.trim()
      ? metadata.personId.trim()
      : null;
  const decisions = await evaluateEmailLawfulBases(
    db,
    workspaceId,
    recipients.map((email) => ({ email, personId, purpose }))
  );
  const missing = decisions.filter((decision) => decision.status === 'missing');
  return {
    lawfulBasisStatus: missing.length > 0 ? 'missing' : 'covered',
    lawfulBasisReason: missing[0]?.reason ?? null,
    recipientsMissingBasis: missing.length
  };
}

/** How many people with an email in this list lack a basis for cold email. */
export async function countLeadListMissingEmailBasis(
  db: Db,
  workspaceId: string,
  listId: string
): Promise<{ checked: number; missing: number; truncated: boolean }> {
  const rows = await db
    .prepare(
      `SELECT c.email, c.person_id, c.country
       FROM linkedin_lead_contacts c
       JOIN linkedin_lead_list_members m ON m.contact_id=c.id AND m.workspace_id=c.workspace_id
       WHERE m.workspace_id=? AND m.list_id=? AND c.email IS NOT NULL AND TRIM(c.email) <> ''
       ORDER BY m.created_at ASC, c.id ASC
       LIMIT ?::int`
    )
    .all<{ email: string; person_id: string | null; country: string | null }>(
      workspaceId,
      listId,
      LEAD_LIST_BASIS_CHECK_LIMIT + 1
    );
  const checked = rows.slice(0, LEAD_LIST_BASIS_CHECK_LIMIT);
  const decisions = await evaluateEmailLawfulBases(
    db,
    workspaceId,
    checked.map((row) => ({
      email: row.email,
      personId: row.person_id,
      leadCountry: row.country,
      purpose: 'outreach' as const
    }))
  );
  return {
    checked: checked.length,
    missing: decisions.filter((decision) => decision.status === 'missing').length,
    truncated: rows.length > LEAD_LIST_BASIS_CHECK_LIMIT
  };
}

export async function personComplianceView(db: Db, workspaceId: string, personId: string) {
  const person = await db
    .prepare('SELECT id, email, country_code FROM contacts WHERE workspace_id=? AND id=?')
    .get<{ id: string; email: string | null; country_code: string | null }>(workspaceId, personId);
  if (!person) throw new ComplianceError('Person not found', 404);
  return {
    personId: person.id,
    countryCode: person.country_code,
    emailDecision: person.email
      ? await evaluateEmailLawfulBasis(db, workspaceId, {
          email: person.email,
          personId: person.id
        })
      : null,
    lawfulBases: await listLawfulBases(db, workspaceId, person.id),
    disclaimer: JURISDICTION_RULES_DISCLAIMER
  };
}
```

- [ ] **Step 7: Routes and the error mapping (`src/server/app.ts`)**

1. Add after `import { getSenderIdentity, saveSenderIdentity } from './compliance/sender-identity.js';` (Task 7):

```ts
import { ComplianceError } from './compliance/errors.js';
import {
  countryInputSchema,
  lawfulBasisInputSchema,
  personComplianceView,
  recordLawfulBasis,
  setAccountCountry,
  setContactCountry,
  withdrawLawfulBasis
} from './compliance/lawful-basis.js';
```

2. In the global error handler, replace:

```ts
error instanceof SkillApiError ||
  error instanceof PlaybookError ||
  error instanceof LeadCaptureError;
```

with:

```ts
error instanceof SkillApiError ||
  error instanceof PlaybookError ||
  error instanceof LeadCaptureError ||
  error instanceof ComplianceError;
```

3. Directly before `  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));`, after the Task 7 sender-identity routes, insert:

```ts
// LAWFUL BASIS AND COUNTRY. Recording a basis or a country can UNBLOCK cold
// email, so only the owner may; a withdrawal only ever blocks, so any member
// may. Not legal advice; verify with counsel.
app.get('/api/compliance/people/:personId', async (req: AuthedRequest, res, next) => {
  try {
    res.json({
      person: await personComplianceView(db, req.auth!.workspaceId, String(req.params.personId))
    });
  } catch (error) {
    next(error);
  }
});

app.put(
  '/api/compliance/people/:personId/country',
  ownerOnly('set a person country'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = countryInputSchema.parse(req.body ?? {});
      res.json(
        await setContactCountry(
          db,
          {
            workspaceId: req.auth!.workspaceId,
            personId: String(req.params.personId),
            countryCode: input.countryCode,
            actorUserId: req.auth!.userId
          },
          new Date()
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  '/api/compliance/accounts/:accountId/country',
  ownerOnly('set an account country'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = countryInputSchema.parse(req.body ?? {});
      res.json(
        await setAccountCountry(
          db,
          {
            workspaceId: req.auth!.workspaceId,
            accountId: String(req.params.accountId),
            countryCode: input.countryCode,
            actorUserId: req.auth!.userId
          },
          new Date()
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/compliance/people/:personId/lawful-bases',
  ownerOnly('record a lawful basis'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = lawfulBasisInputSchema.parse(req.body ?? {});
      const { record, created } = await recordLawfulBasis(
        db,
        {
          workspaceId: req.auth!.workspaceId,
          personId: String(req.params.personId),
          channel: input.channel,
          basis: input.basis,
          source: 'operator',
          sourceRef: input.sourceRef ?? null,
          actorUserId: req.auth!.userId
        },
        new Date()
      );
      res.status(created ? 201 : 200).json({ lawfulBasis: record });
    } catch (error) {
      next(error);
    }
  }
);

app.post('/api/compliance/lawful-bases/:id/withdraw', async (req: AuthedRequest, res, next) => {
  try {
    res.json({
      lawfulBasis: await withdrawLawfulBasis(
        db,
        {
          workspaceId: req.auth!.workspaceId,
          lawfulBasisId: String(req.params.id),
          actorUserId: req.auth!.userId
        },
        new Date()
      )
    });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/compliance/jurisdiction-rules.test.ts src/server/compliance/lawful-basis.test.ts src/server/compliance/api.test.ts src/server/compliance/schema.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/compliance/errors.ts src/server/compliance/jurisdiction-rules.ts src/server/compliance/jurisdiction-rules.test.ts src/server/compliance/lawful-basis.ts src/server/compliance/lawful-basis.test.ts src/server/compliance/api.test.ts src/server/app.ts
git commit -m "feat(compliance): per-person lawful basis and cold-email rule table" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 9: An inbound capture with marketing-email consent records a lawful basis

**Files:**

- Modify: `src/server/lead-capture/submissions.ts`
- Test: `src/server/lead-capture/lead-capture.test.ts`

**Interfaces:**

- Consumes:
  - `recordLawfulBasis()` (Task 8), called with the capture transaction `tx`, so the consent row commits or rolls back with the submission;
  - `consentSchema.marketingEmail` / `capturedAt` (`src/server/lead-capture/types.ts`).
- Produces: one `contact_lawful_bases` row per accepted submission with `consent.marketingEmail === true` and a person email:
  - `channel='email'`, `basis='consent'`, `source='inbound_capture'`;
  - `source_ref` = the submission id;
  - `recorded_at` = `consent.capturedAt` when it is not later than receipt, otherwise the receipt time.
- A duplicate delivery returns before this code runs, so it adds no row.

- [ ] **Step 1: Write the failing test**

In `src/server/lead-capture/lead-capture.test.ts`, add inside `describe('generic lead capture', () => {`, directly after the `'returns 409 when an idempotency key is reused for a different payload'` test:

```ts
it('records marketing-email consent from a capture once, dated when the person gave it', async () => {
  const body = {
    kind: 'demo_request',
    person: { name: 'Lena', email: 'lena@consent.example' },
    consent: {
      marketingEmail: true,
      privacyAccepted: true,
      capturedAt: '2026-01-05T09:00:00.000Z'
    }
  };
  const first = await intake(sourceSecret, 'idem-consent-001', body).expect(202);
  await intake(sourceSecret, 'idem-consent-001', body).expect(200);

  const rows = await db
    .prepare(
      `SELECT channel,basis,source,source_ref,
           TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
         FROM contact_lawful_bases WHERE workspace_id=? AND person_id=?`
    )
    .all<Record<string, unknown>>(WORKSPACE_A, first.body.personId);
  expect(rows).toEqual([
    {
      channel: 'email',
      basis: 'consent',
      source: 'inbound_capture',
      source_ref: first.body.submissionId,
      recorded_at: '2026-01-05T09:00:00.000Z'
    }
  ]);

  const declined = await intake(sourceSecret, 'idem-consent-002', {
    kind: 'demo_request',
    person: { email: 'nils@consent.example' },
    consent: { marketingEmail: false, privacyAccepted: true }
  }).expect(202);
  const none = await db
    .prepare('SELECT id FROM contact_lawful_bases WHERE workspace_id=? AND person_id=?')
    .all<{ id: string }>(WORKSPACE_A, declined.body.personId);
  expect(none).toEqual([]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/lead-capture/lead-capture.test.ts`
Expected: FAIL in "records marketing-email consent from a capture once": `expected [] to deeply equal [ { channel: 'email', ... } ]`.

- [ ] **Step 3: Record the basis inside the capture transaction**

In `src/server/lead-capture/submissions.ts`:

1. Add after `import { resolveContact, resolveExplicitAccount } from './people.js';`:

```ts
import { recordLawfulBasis } from '../compliance/lawful-basis.js';
```

2. In `acceptInboundSubmission`, directly before:

```ts
    return {
      submission: toSubmission(row),
```

insert:

```ts
// An explicit marketing-email opt-in is a lawful basis for cold email to
// this person, with the submission as its evidence. Recorded in the same
// transaction, so it exists exactly when the submission does. A consent
// timestamp in the future is never trusted; receipt time is used instead.
if (input.body.consent?.marketingEmail === true && input.body.person.email) {
  const capturedAt = input.body.consent.capturedAt;
  await recordLawfulBasis(
    tx,
    {
      workspaceId: input.source.workspaceId,
      personId: resolved.contact.id,
      channel: 'email',
      basis: 'consent',
      source: 'inbound_capture',
      sourceRef: submissionId,
      recordedAt:
        capturedAt && Date.parse(capturedAt) <= receivedAt.getTime()
          ? capturedAt
          : receivedAt.toISOString(),
      actorUserId: null
    },
    receivedAt
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/lead-capture/lead-capture.test.ts src/server/compliance/lawful-basis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/lead-capture/submissions.ts src/server/lead-capture/lead-capture.test.ts
git commit -m "feat(compliance): record capture consent as a lawful basis" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 10: The policy engine denies playbook email without a lawful basis

**Files:**

- Modify: `src/server/control-plane/policy.ts`, `src/server/playbooks/engine.ts`
- Test: `src/server/control-plane/policy.test.ts`, `src/server/playbooks/engine.test.ts`

**Interfaces:**

- Consumes: `emailLawfulBasisAttributes()` and `JURISDICTION_RULES_DISCLAIMER` (Task 8).
- Produces:
  - `export const LAWFUL_BASIS_POLICY_NAME = 'Built-in recipient lawful-basis rule'` in `policy.ts`.
  - `evaluatePolicy()` returns `{ effect: 'deny', policyId: null, policyName: LAWFUL_BASIS_POLICY_NAME, reason: '<decision reason> Not legal advice; verify with counsel.' }` whenever `context.attributes.lawfulBasisStatus === 'missing'`. This runs BEFORE every workspace policy, so no allow rule can override it.
  - `runActionStep()` merges the lawful-basis attributes for `email.send` only, after `policyAttributesFrom(payload)`.
- The engine's existing deny branch (`failStep`) does the rest: the send step and the run become `failed`, and the decision is stored in `policy_decision_json`.
- Every production email path is covered by this task or Task 11:
  - playbook email: `engine.ts` → `executePreparedPlaybookAction()` (its only caller);
  - campaign email: `executeEmail()`.
  - `action-service.ts` `executeAction()` also reaches `executeConnectedAction()`, but no production module imports it. Verified with `grep -rn "action-service" src/server src/worker --include=*.ts | grep import | grep -v test`, which prints nothing.

- [ ] **Step 1: Write the failing policy test**

In `src/server/control-plane/policy.test.ts`:

1. Replace:

```ts
import { evaluatePolicy, policyAttributesFrom, type PolicyEffect } from './policy.js';
```

with:

```ts
import {
  LAWFUL_BASIS_POLICY_NAME,
  evaluatePolicy,
  policyAttributesFrom,
  type PolicyEffect
} from './policy.js';
```

2. Append at the end of the file:

```ts
describe('built-in lawful-basis rule', () => {
  it('denies a missing lawful basis before any workspace allow policy, and changes nothing else', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Allow all email',
      actionPattern: 'action:email.send',
      effect: 'allow',
      conditions: {}
    });
    const reason =
      'Cold email to a recipient in DE needs recorded consent or an existing-customer relationship; none is recorded for this person.';

    const denied = await evaluate(database, {
      recipients: 1,
      lawfulBasisStatus: 'missing',
      lawfulBasisReason: reason
    });
    expect(denied).toMatchObject({
      effect: 'deny',
      policyId: null,
      policyName: LAWFUL_BASIS_POLICY_NAME
    });
    expect(denied.reason).toBe(`${reason} Not legal advice; verify with counsel.`);

    expect(
      (await evaluate(database, { recipients: 1, lawfulBasisStatus: 'covered' })).policyName
    ).toBe('Allow all email');
    expect((await evaluate(database, { recipients: 1 })).policyName).toBe('Allow all email');
  });
});
```

- [ ] **Step 2: Write the failing engine tests**

In `src/server/playbooks/engine.test.ts`:

1. Add after `import { listDomainEvents } from '../control-plane/events.js';`:

```ts
import { LAWFUL_BASIS_POLICY_NAME } from '../control-plane/policy.js';
import { recordLawfulBasis, setContactCountry } from '../compliance/lawful-basis.js';
```

2. Replace the whole `async function runEmail(database: Db) { ... }` helper inside `describe('GTM-only prepared action boundary', () => {` with:

```ts
async function emailSendStep(database: Db, recipient = 'buyer@example.com') {
  const run = await startPlaybookRun(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    playbookId: 'test.email-action-playbook',
    payload: {
      recipient,
      subject: 'Audit result',
      body: 'The audit is ready.'
    },
    actorType: 'user',
    actorId: DEMO_USER_ID
  });
  const completed = await decidePlaybookApproval(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    runId: run.id,
    stepId: 'approve-email',
    userId: DEMO_USER_ID,
    decision: 'approve'
  });
  return completed.steps.find((step) => step.stepId === 'send-email');
}

async function runEmail(database: Db, recipient = 'buyer@example.com') {
  return (await emailSendStep(database, recipient))?.policyDecision;
}
```

3. Add after the `'keeps the built-in approval boundary when no auto-send policy matches'` test, inside the same `describe`:

```ts
it('denies cold email with no recorded lawful basis despite an allow policy', async () => {
  const database = await openTestDb();
  await insertPolicy(database, 'Small sends only', 'allow', { maxRecipients: 3 });
  const step = await emailSendStep(database, 'buyer@acme-gmbh.de');
  expect(step?.status).toBe('failed');
  expect(step?.policyDecision).toMatchObject({
    effect: 'deny',
    policyId: null,
    policyName: LAWFUL_BASIS_POLICY_NAME
  });
  const decision = JSON.stringify(step?.policyDecision);
  expect(decision).toContain('recipient in an unknown country');
  expect(decision).toContain('Not legal advice; verify with counsel.');
  expect(decision).not.toContain('acme-gmbh');
});

it('lets the workspace policy decide once consent is recorded for the person', async () => {
  const database = await openTestDb();
  await insertPolicy(database, 'Small sends only', 'allow', { maxRecipients: 3 });
  const now = new Date();
  await database
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_engine_consented',?,'Consented buyer','consented@acme-gmbh.de','consented@acme-gmbh.de',?,?)`
    )
    .run(DEMO_WORKSPACE_ID, now.toISOString(), now.toISOString());
  await setContactCountry(
    database,
    {
      workspaceId: DEMO_WORKSPACE_ID,
      personId: 'con_engine_consented',
      countryCode: 'DE',
      actorUserId: null
    },
    now
  );
  await recordLawfulBasis(
    database,
    {
      workspaceId: DEMO_WORKSPACE_ID,
      personId: 'con_engine_consented',
      channel: 'email',
      basis: 'consent',
      source: 'operator',
      actorUserId: null
    },
    now
  );
  expect(await runEmail(database, 'consented@acme-gmbh.de')).toMatchObject({
    effect: 'allow',
    policyName: 'Small sends only'
  });
});
```

`resetDemoData()` deletes and reseeds the demo workspace, so `con_engine_consented` never survives into the next test.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/control-plane/policy.test.ts src/server/playbooks/engine.test.ts`
Expected: FAIL in two tests.

- `policy.test.ts` › "denies a missing lawful basis before any workspace allow policy": expected `effect: 'deny'`, received `'allow'`.
- `engine.test.ts` › "denies cold email with no recorded lawful basis despite an allow policy": expected `'failed'`, received `'completed'`.

"lets the workspace policy decide once consent is recorded" already passes. It guards against over-blocking.

- [ ] **Step 4: Add the built-in rule (`src/server/control-plane/policy.ts`)**

1. Add after `import type { Db } from '../db.js';`:

```ts
import { JURISDICTION_RULES_DISCLAIMER } from '../compliance/jurisdiction-rules.js';
```

2. Directly before `export async function evaluatePolicy(db: Db, context: PolicyContext): Promise<PolicyDecision> {`, insert:

```ts
export const LAWFUL_BASIS_POLICY_NAME = 'Built-in recipient lawful-basis rule';

/**
 * Evaluated BEFORE every workspace policy: no allow rule can buy its way past a
 * recipient with no lawful basis for cold email. `lawfulBasisStatus` is set by
 * the engine from the database (compliance/lawful-basis.ts) and never from the
 * payload or a model. Not legal advice; verify with counsel.
 */
function lawfulBasisDenial(context: PolicyContext): PolicyDecision | null {
  const attributes = context.attributes ?? {};
  if (attributes.lawfulBasisStatus !== 'missing') return null;
  const reason =
    typeof attributes.lawfulBasisReason === 'string' && attributes.lawfulBasisReason.trim()
      ? attributes.lawfulBasisReason.trim()
      : 'No lawful basis is recorded for cold email to this recipient.';
  return {
    effect: 'deny',
    policyId: null,
    policyName: LAWFUL_BASIS_POLICY_NAME,
    reason: `${reason} ${JURISDICTION_RULES_DISCLAIMER}`,
    evaluatedAt: new Date().toISOString()
  };
}
```

3. Make the first statement of `evaluatePolicy` the rule. Replace:

```ts
export async function evaluatePolicy(db: Db, context: PolicyContext): Promise<PolicyDecision> {
  const rows = await db
```

with:

```ts
export async function evaluatePolicy(db: Db, context: PolicyContext): Promise<PolicyDecision> {
  const lawfulBasis = lawfulBasisDenial(context);
  if (lawfulBasis) return lawfulBasis;

  const rows = await db
```

- [ ] **Step 5: Pass the attributes from the engine (`src/server/playbooks/engine.ts`)**

1. Add after `import { canonicalPayloadHash } from '../control-plane/payload.js';`:

```ts
import { emailLawfulBasisAttributes } from '../compliance/lawful-basis.js';
```

2. In `runActionStep`, replace:

```ts
// Without these, every amount/confidence/recipient condition a founder set
// is unevaluable and the rule is resolved by its effect alone.
attributes: policyAttributesFrom(payload);
```

with:

```ts
    // Without these, every amount/confidence/recipient condition a founder set
    // is unevaluable and the rule is resolved by its effect alone. Lawful-basis
    // attributes are read from the database for email only, and spread LAST,
    // so a payload can never claim its own basis.
    attributes: {
      ...policyAttributesFrom(payload),
      ...(step.actionType === 'email.send'
        ? await emailLawfulBasisAttributes(db, run.workspaceId, payload)
        : {})
    }
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/control-plane/policy.test.ts src/server/playbooks/engine.test.ts src/server/conversation-replies.test.ts src/server/demand/actions.test.ts src/server/control-plane/execution.test.ts`
Expected: PASS.

The last three files send through the same engine to reserved-domain recipients only (`example.com`, `example.test`). They prove that a reply, a qualified-demand send and the execution adapter are not over-blocked.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/control-plane/policy.ts src/server/control-plane/policy.test.ts src/server/playbooks/engine.ts src/server/playbooks/engine.test.ts
git commit -m "feat(policy): deny email without a recorded lawful basis" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 11: Campaign email refusal and the lead-list plan blocker

**Files:**

- Modify: `src/server/linkedin/campaign-channels.ts`, `src/server/gtm/intent.ts`
- Test: `src/server/linkedin/campaign-channels.test.ts`, `src/server/gtm/intent.test.ts`

**Interfaces:**

- Consumes:
  - `evaluateEmailLawfulBasis()`, `countLeadListMissingEmailBasis()` and `LEAD_LIST_BASIS_CHECK_LIMIT` (Task 8);
  - `JURISDICTION_RULES_DISCLAIMER`;
  - `linkedin_lead_contacts.person_id` and `.country`.
- Produces:
  - `executeEmail()` throws `Lawful basis missing for cold email: <reason> Not legal advice; verify with counsel.` BEFORE `trackedHtmlBody()`, so a refused send creates no tracking token or link.
  - `definiteFailure()` treats that message as a known failure. The row becomes `failed`, never `unknown`, and the member advances on its failure branch exactly like any other definite failure.
  - A GTM plan blocker `{ code: 'recipient_lawful_basis_missing', message, actionHref: '/outreach/new' }` when an email plan names a lead list with people who lack a basis. It carries counts only, never names or addresses.

- [ ] **Step 1: Write the failing campaign test**

In `src/server/linkedin/campaign-channels.test.ts`, add inside `describe('campaign channel executor', () => {`, directly after the `'builds opaque tracking tokens and click mappings before an opted-in email is sent'` test:

```ts
it('refuses campaign cold email with no recorded lawful basis before any tracking exists', async () => {
  const campaignId = await campaignFor(
    [
      {
        id: 'wait',
        action: 'wait',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { duration: { amount: 1, unit: 'days' } }
      },
      {
        id: 'end',
        action: 'end',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { outcome: 'completed' }
      }
    ],
    'First Name,Last Name,Company,Email,LinkedIn URL,Country\nMaya,Huber,Acme GmbH,maya@acme-gmbh.de,https://linkedin.com/in/maya-lawful-basis,Germany\n'
  );
  await runManagedCampaigns(db, WORKSPACE, NOW);
  const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
  await db
    .prepare(
      `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_demo_basis',?,'gmail','trevra-gmail','demo-basis','demo@example.com','connected',1,?::timestamptz,?::timestamptz)
         ON CONFLICT (id) DO NOTHING`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-live',step_index=0,next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
    )
    .run(NOW.toISOString(), WORKSPACE, member.id);
  await db
    .prepare(
      `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
         VALUES ('licha_basis_send',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'basis-send-key',?::timestamptz,?::timestamptz)`
    )
    .run(
      WORKSPACE,
      campaignId,
      member.id,
      member.contactId,
      'email-live',
      NOW.toISOString(),
      JSON.stringify({
        recipient: 'maya@acme-gmbh.de',
        subject: 'Tracked email',
        body: 'See https://example.com/demo for details',
        tracking: 'opens_clicks',
        threaded: false
      }),
      NOW.toISOString(),
      NOW.toISOString()
    );

  const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
  expect(run).toMatchObject({ sent: 0, failed: 1, unknown: 0 });
  const action = await db
    .prepare(
      `SELECT status,last_error,tracking_token FROM linkedin_campaign_channel_actions WHERE id='licha_basis_send'`
    )
    .get<{ status: string; last_error: string | null; tracking_token: string | null }>();
  expect(action?.status).toBe('failed');
  expect(action?.last_error).toContain('Lawful basis missing for cold email');
  expect(action?.last_error).toContain('recipient in DE');
  expect(action?.last_error).toContain('Not legal advice; verify with counsel.');
  expect(action?.last_error).not.toContain('acme-gmbh');
  expect(action?.tracking_token).toBeNull();
  const links = await db
    .prepare(
      `SELECT token FROM linkedin_campaign_email_tracking_links WHERE workspace_id=? AND channel_action_id='licha_basis_send'`
    )
    .all<{ token: string }>(WORKSPACE);
  expect(links).toEqual([]);
});
```

- [ ] **Step 2: Write the failing intent test**

In `src/server/gtm/intent.test.ts`, add inside `describe('bounded GTM intent compiler', () => {`, directly after the Task 7 test `'blocks email outreach until the workspace has a postal address and a privacy policy URL'`:

```ts
it('counts the people in an email plan who have no recorded lawful basis, without naming them', async () => {
  const seat = await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder', timezone: 'Europe/Zurich' },
    NOW
  );
  const list = await createLeadList(
    db,
    {
      workspaceId: WORKSPACE,
      seatKey: seat.seatKey,
      name: 'DACH founders',
      sourceKind: 'csv',
      sourceRef: 'intent-lawful-basis'
    },
    NOW
  );
  await importLeadCsv(
    db,
    {
      workspaceId: WORKSPACE,
      seatKey: seat.seatKey,
      listId: list.id,
      csv: [
        'First Name,Last Name,Company,Email,LinkedIn URL,Country',
        'Maya,Huber,Northwind,maya@northwind-gmbh.de,https://www.linkedin.com/in/maya-lawful-basis/,Germany',
        'Jonas,Keller,Northstar,jonas-lawful-basis@example.com,https://www.linkedin.com/in/jonas-lawful-basis/,Germany'
      ].join('\n')
    },
    NOW
  );
  const intent = {
    objective: 'prepare_outreach',
    people: { existingListId: list.id },
    channels: ['email']
  };

  const plan = await compileGtmIntent(db, WORKSPACE, intent);
  const blocker = plan.blockers.find(
    (candidate) => candidate.code === 'recipient_lawful_basis_missing'
  );
  expect(blocker).toMatchObject({ actionHref: '/outreach/new' });
  expect(blocker?.message).toContain(
    '1 of 2 people with an email in this list have no recorded lawful basis'
  );
  expect(blocker?.message).toContain('Not legal advice; verify with counsel.');
  expect(blocker?.message).not.toContain('northwind');
  expect(blocker?.message).not.toContain('Maya');

  const linkedin = await compileGtmIntent(db, WORKSPACE, { ...intent, channels: ['linkedin'] });
  expect(linkedin.blockers.map((candidate) => candidate.code)).not.toContain(
    'recipient_lawful_basis_missing'
  );
});
```

Jonas uses a reserved domain, so he is `not_required`. Maya is in Germany by the list's Country column and has no basis.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/campaign-channels.test.ts src/server/gtm/intent.test.ts`
Expected: FAIL.

- `campaign-channels.test.ts` › "refuses campaign cold email with no recorded lawful basis": the demo mailbox sends it, so `sent` is 1 where 0 is expected.
- `intent.test.ts` › "counts the people in an email plan": `expected undefined to match object { actionHref: '/outreach/new' }`.

- [ ] **Step 4: Refuse in `executeEmail()` (`src/server/linkedin/campaign-channels.ts`)**

1. Add after `import { executeConnectedAction, readConnectedEmailThreadEvents } from '../integration-service.js';`:

```ts
import { evaluateEmailLawfulBasis } from '../compliance/lawful-basis.js';
import { JURISDICTION_RULES_DISCLAIMER } from '../compliance/jurisdiction-rules.js';
```

2. In `executeEmail`, directly after:

```ts
if (!recipient || !subject || !body)
  throw new Error('Email action requires recipient, subject, and body.');
```

insert:

```ts
// Cold campaign email needs a recorded lawful basis wherever the recipient's
// country requires one. Checked BEFORE tracking tokens exist, so a refused
// send leaves nothing behind. Not legal advice; verify with counsel.
const lead = await db
  .prepare('SELECT person_id, country FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
  .get<{ person_id: string | null; country: string | null }>(row.workspace_id, row.contact_id);
const lawfulBasis = await evaluateEmailLawfulBasis(db, row.workspace_id, {
  email: recipient,
  personId: lead?.person_id ?? null,
  leadCountry: lead?.country ?? null,
  purpose: 'outreach'
});
if (lawfulBasis.status === 'missing')
  throw new Error(
    `Lawful basis missing for cold email: ${lawfulBasis.reason} ${JURISDICTION_RULES_DISCLAIMER}`
  );
```

3. In `definiteFailure`, replace:

```ts
  return /HTTP 4\d\d|requires recipient|no longer exists|Connect Gmail|Connect Microsoft|enrichment credit cap reached/i.test(
```

with:

```ts
  return /HTTP 4\d\d|requires recipient|no longer exists|Connect Gmail|Connect Microsoft|enrichment credit cap reached|lawful basis missing/i.test(
```

- [ ] **Step 5: Add the lead-list blocker (`src/server/gtm/intent.ts`)**

1. Add after the Task 7 import `import { senderIdentityBlockers } from '../compliance/sender-identity.js';`:

```ts
import {
  LEAD_LIST_BASIS_CHECK_LIMIT,
  countLeadListMissingEmailBasis
} from '../compliance/lawful-basis.js';
import { JURISDICTION_RULES_DISCLAIMER } from '../compliance/jurisdiction-rules.js';
```

2. In `prepareOutreachPlan`, replace:

```ts
listName = list.name;
senderKey = list.seat_key;
```

with:

```ts
listName = list.name;
senderKey = list.seat_key;
if (requestedChannels.includes('email')) {
  // Counts only: the plan names how many, never who.
  const basis = await countLeadListMissingEmailBasis(db, workspaceId, list.id);
  if (basis.missing > 0)
    blockers.push({
      code: 'recipient_lawful_basis_missing',
      message: `${basis.missing} of ${basis.checked} people with an email in this list have no recorded lawful basis for cold email in their country${
        basis.truncated ? ` (only the first ${LEAD_LIST_BASIS_CHECK_LIMIT} were checked)` : ''
      }. ${JURISDICTION_RULES_DISCLAIMER}`,
      actionHref: '/outreach/new'
    });
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd /home/pankaj/Projects/Trevra && npx tsx scripts/test-with-postgres.ts src/server/linkedin/campaign-channels.test.ts src/server/gtm/intent.test.ts src/server/linkedin/managed-campaigns.test.ts`
Expected: PASS.

The existing campaign tests send only to `example.com`, so they are unaffected.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra
git add src/server/linkedin/campaign-channels.ts src/server/linkedin/campaign-channels.test.ts src/server/gtm/intent.ts src/server/gtm/intent.test.ts
git commit -m "feat(compliance): refuse campaign email and block plans without a lawful basis" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

## Task 12: Phase sweep and final gate

**Files:** none created. Fix only what this sweep finds, inside the files this plan already touched.

- [ ] **Step 1: Sweep the phase diff once**

```bash
cd /home/pankaj/Projects/Trevra
git diff --stat HEAD~10 -- . ':(exclude)docs'
grep -rn "#/\|location\.hash" src/client/views/LinkedInHandoffCard.tsx src/client/SenderIdentityPanel.tsx src/client/LinkedInAccountForm.tsx src/client/LinkedInExecutionBlocker.ts
grep -rn "TODO\|FIXME\|XXX" src/server/compliance src/server/linkedin/handoff.ts src/server/linkedin/identity.ts migrations/134_consent_and_linkedin_safety.sql
grep -rn "Not legal advice; verify with counsel" src/server/compliance/jurisdiction-rules.ts src/server/control-plane/policy.ts src/server/linkedin/campaign-channels.ts src/server/gtm/intent.ts
```

Expected:

- The diff stat lists only the files in the File Map, plus the Task 1 to 11 test files.
- The two `grep -rn "#/...` and `TODO` commands print nothing.
- The disclaimer grep prints at least one line per file. In `policy.ts`, `campaign-channels.ts` and `intent.ts` it comes through `JURISDICTION_RULES_DISCLAIMER`, so for those three files grep for the constant name instead: `grep -n "JURISDICTION_RULES_DISCLAIMER" src/server/control-plane/policy.ts src/server/linkedin/campaign-channels.ts src/server/gtm/intent.ts`.

Also check by reading the diff:

- Every new SQL statement filters on `workspace_id`, except the Task 3 linked-identity count, which returns integers only.
- No event payload carries an email address, a body or another workspace's id.
- No feature stylesheet in the diff redefines a button, input, select or textarea skin.

- [ ] **Step 2: Formatting**

Run: `cd /home/pankaj/Projects/Trevra && npx prettier --check $(git diff --name-only HEAD~10 -- 'src/**/*.ts' 'src/**/*.tsx')`
Expected: `All matched files use Prettier code style!`. If it lists files, run `npx prettier --write` on exactly those files and re-check.

- [ ] **Step 3: Final gate**

Run: `cd /home/pankaj/Projects/Trevra && npm run check`
Expected: every test file passes, then `catalog:build`, `typecheck`, `vite build` and `tsc -p tsconfig.server.json` exit 0.

This phase changes no dependency or infrastructure file, so `npm audit --omit=dev`, `docker compose config` and `terraform validate` are not required.

- [ ] **Step 4: Manual UI check (light, dark, 390px wide)**

Run `npm run dev` and sign in as a workspace owner.

- On `/setup/workspace`:
  - the Sender identity panel shows "Email outreach blocked" until a postal address and an https privacy URL are saved;
  - a member account sees the fields read-only.
- With a seat switched to "I send invites and messages myself", Today shows one "You send" card per seat with a due row:
  - Copy puts the note on the clipboard;
  - Mark sent removes the card and the guard count rises by one;
  - Skip removes it without counting.
- Keyboard focus stays visible on every new control, and nothing scrolls horizontally at 390px.

- [ ] **Step 5: Commit only if the sweep changed a file**

```bash
cd /home/pankaj/Projects/Trevra
git status --short
git add -u src migrations
git commit -m "chore(compliance): phase E sweep fixes" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

Skip this step when `git status --short` lists nothing under `src/` or `migrations/`.

## Self-Review

**Spec coverage.**

| Requirement                                                                                                        | Task                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Verify whether a guard already shares LinkedIn budgets across workspaces                                           | 1. None exists, so Task 3 proceeds.                                                                                  |
| Sender identity: legal name, postal address, privacy URL, owner-editable on `/setup/workspace`                     | 2, 7                                                                                                                 |
| Email outreach plans blocked without a postal address and a privacy URL, citing the FTC CAN-SPAM guide             | 7 (`sender_postal_address_missing` message carries `FTC_CAN_SPAM_GUIDE_URL`)                                         |
| Lawful basis per contact and channel (consent / existing_customer / legitimate_interest) with source and timestamp | 2, 8                                                                                                                 |
| Inbound capture with `consent.marketingEmail === true` writes a consent row                                        | 9                                                                                                                    |
| Deterministic country: explicit contact/account country, else the account-domain ccTLD, else unknown               | 8 (`resolveRecipientCountry`). An imported lead-list Country column counts as explicit, between contact and account. |
| Conservative rule table for DE, AT, CH, FR, UK, US and CA with primary sources, marked not legal advice            | 8 (`COLD_EMAIL_RULES`; UK is ISO `GB`)                                                                               |
| Unknown country requires an explicit basis                                                                         | 8 (`UNKNOWN_RULE`, and `ruleFor()` for unlisted countries)                                                           |
| Enforced as a policy condition or plan blocker, never by a model                                                   | 7, 10, 11                                                                                                            |
| A stable identity key links seats across workspaces; the guard counts across linked seats; only counts cross       | 3                                                                                                                    |
| Unknown identity keeps per-seat behaviour plus a warning                                                           | 3 (`linked-identity` warn check)                                                                                     |
| Human-send mode: drafted and gated, never executed                                                                 | 4                                                                                                                    |
| `linkedin_handoff_waiting` Today items with Copy, Mark sent and Skip                                               | 5, 6                                                                                                                 |
| Mark sent records the action so the guard counts it                                                                | 5 (`ingestOutcome()`)                                                                                                |
| Migration `134_*`; no new nav or routes; no dependency on A–D                                                      | 2; Global Constraints                                                                                                |

**Placeholder scan.** No step says "TBD", "similar to" or "add error handling". Every code step carries the full code, and every command has its expected FAIL or PASS.

**Name consistency (checked across tasks).**

- Compliance: `recordLawfulBasis`, `withdrawLawfulBasis({ lawfulBasisId })`, `evaluateEmailLawfulBasis(es)`, `emailLawfulBasisAttributes`, `countLeadListMissingEmailBasis`, `LEAD_LIST_BASIS_CHECK_LIMIT`, `JURISDICTION_RULES_DISCLAIMER`, `LAWFUL_BASIS_POLICY_NAME`, `ComplianceError`, `senderIdentityBlockers`.
- LinkedIn: `HUMAN_SEND_KINDS`, `isHumanSendKind`, `listLinkedInHandoffs`, `resolveLinkedInHandoff`.
- Today kind: `linkedin_handoff_waiting`.
- Every table and column used by Tasks 8 to 11 either exists in `migrations/` (`contacts.email_normalized`, `account_contacts.confidence`, `conversation_messages.direction`/`channel`, `inbound_submissions.contact_id`, `linkedin_lead_contacts.person_id`/`country`, `linkedin_lead_list_members.created_at`) or is created by Task 2 (`contact_lawful_bases.*`, `contacts.country_code`, `accounts.country_code`).

**Deliberate limits (lc-debt).**

- `planPacing` stays per seat; only the guard's counts are shared across linked seats.
- One handoff per human seat, chosen from at most 10 candidates per seat.
- A human-send row skipped by a branch decision stays `planned` until the member moves on, as automated rows do today.
- Lawful bases and countries are managed through the API only (Task 8 routes). No client screen edits them in this phase.
- The lead-list blocker checks at most 500 people (`LEAD_LIST_BASIS_CHECK_LIMIT`) and says so when it truncates.
- A `linkedin` lawful basis can be recorded, but nothing enforces it yet. LinkedIn invites stay governed by the guard.

**Risks.**

- **Phase D rebase.** Phase D also edits `today.ts`, `gtm/intent.ts` and `executeEmail()`. Every edit here names its anchor text.
- **No CAN-SPAM footer.** This phase does not append the postal address or an opt-out footer to outgoing email. Changing the body after approval would break the exact-payload hash. The footer belongs in the drafting step (Phase D or a follow-up).
- **Unknown-country recipients are blocked by default.** Generic domains (`.com`, `.io`) with no explicit country are unknown, so they are denied until an owner records a basis or a country. The demo seed contact at `northstar.studio` is one of them, so a demo outreach run now ends in a lawful-basis deny.
- **Companion profile URL.** Identity linking trusts the profile URL that the paired companion reports. A spoofed URL could link to another founder's seat and reveal aggregate counts, never content.
- **Duplicate-target detection stays per seat.** Two linked workspaces can still invite the same person once each.
- **Purpose `other`.** A `deliveryPurpose: 'other'` email is treated as outreach, which is the stricter reading.
- **Today test.** The Task 5 Today test runs on the real default day shape at 10:00 on a Friday in Zurich. A later change to that default could make the guard refuse, and the test would then need a fixed `dayShape`.
