# Phase D: Email as a Governed Peer Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make email a peer channel to LinkedIn. SPF/DKIM/DMARC failures for the sending domain block email plans. Every outreach email carries RFC 8058 one-click unsubscribe. One designated inbound mailbox syncs mail from known People into Conversations. `prepare_outreach` with `channels: ['email']` prepares seatless, first-touch outreach email behind the existing exact-payload approval boundary.

**Architecture:** New code lives in `src/server/email/`:

- **DNS checks.** A pure DNS evaluator uses an injected `DnsResolver` and writes to a workspace-scoped cache table (`email_deliverability_checks`). Plan compilation and Today read from that cache.
- **Unsubscribe tokens.** Tokens are HMAC-signed with a key derived from `TREVRA_SECRETS_KEY`. They are minted inside `executeConnectedAction` from the stable `gtm_deliveries.id` of the claimed delivery. They are redeemed by a public `/u/:token` route: `GET` only renders a confirmation page, and `POST` suppresses.
- **Inbound mail.** Inbound mail arrives through a new Nango sync, `inbound-messages`, kept in `nango-integrations/`. Nango stores and paces it; Trevra never polls Gmail or Graph itself. The records reuse the existing sync webhook, `syncNangoRecords`, and `ingestCanonicalRecord`. A new branch drops strangers and mail from non-designated mailboxes before anything is written.
- **Email-only outreach.** It compiles in `src/server/gtm/intent.ts` and prepares one `gtm.email-outreach` playbook run per eligible person. Execution goes through the existing `email.send` adapter. The adapter is now bound to the approved mailbox.

**Tech Stack:** TypeScript ESM, Express, PostgreSQL (forward-only migration `133_*`), Vitest against a real PostgreSQL Testcontainer, `node:dns/promises`, `@nangohq/node` 0.71.2, Nango zero-YAML functions (`nango` CLI 0.71.2, `createSync`), React with `src/client/ui/primitives.tsx`.

**Spec:**

- `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md`, row D and shared contract 5 (Today kind `deliverability_blocked`).
- `AGENTS.md`.
- RFC 8058 (one-click unsubscribe) and RFC 2369 (`List-Unsubscribe`).
- RFC 7208 §4.6.4 (SPF ten-lookup limit).
- RFC 7489 §6.6.3 (DMARC organizational-domain fallback).

## Global Constraints

- PostgreSQL only; this phase owns migration `migrations/133_email_channel.sql` and nothing else in `migrations/`.
- Scope every commercial query by `workspace_id`. The single deliberate exception is `findUnsubscribeDelivery`, which looks up `gtm_deliveries` by primary key because the token is the only tenant evidence a recipient's mail client carries; the HMAC then binds workspace, delivery and recipient. It carries a comment saying so.
- Application SQL never contains a literal `?` other than a bind placeholder (`src/server/db.ts` rewrites every `?`). The jsonb `?` operator appears only in the migration.
- External writes stay behind the prepared-action / exact-payload approval boundary (`src/server/control-plane/execution.ts`). The new playbook's only external step is the existing closed `email.send` action. Nothing sends through a generic skill runner.
- Provider credentials stay in Nango. The unsubscribe signing key is derived from `TREVRA_SECRETS_KEY`/`TREVRA_SECRETS_KEY_PREVIOUS`; no new secret is stored.
- Do not rebuild sync storage, OAuth, token rotation or rate limiting: inbound mail is a Nango sync; Trevra only consumes its records.
- Tests never hit real DNS: `vitest.setup.ts` sets `TREVRA_DNS_DISABLED=true` (Task 3), and every DNS test injects a fake `DnsResolver`.
- No new navigation section and no new client route. UI lands on the existing `/setup/workspace` screen and the existing Today planner. `/u/:token` is a server-rendered public page registered in `createApp`; it is not an app route, so `APP_PATH_PATTERNS` and `src/client/ui/route.ts` do not change.
- Client UI uses `Button`, `Field`, `Select` from `src/client/ui/primitives.tsx`, `Panel` from `src/client/ui/layout.tsx`, and `--t-*` tokens only.
- Analytics carry no email bodies, and Phase D adds no analytics event.
- The only new domain events are the engine's own playbook and approval events for `gtm.email-outreach`. As for `gtm.conversation-email-reply` today, `playbook.run.started` carries the run input and `approval.requested` carries the exact approval payload, email body included.
- This departs from the roadmap rule that domain events carry no email bodies. Removing bodies means changing `src/server/playbooks/engine.ts` for every playbook, which is outside Phase D.
- Deliberate ceilings carry `lc-debt: <ceiling>; <upgrade path>` comments.
- New durable state ships with its closer:
  - `email_deliverability_checks`: workspace cascade, plus a 30-day prune in the worker.
  - `email_inbound_mailboxes`: workspace and connection cascade, the owner DELETE route, and `disconnectIntegration`.
  - `email_outreach_preparations`: workspace cascade.
- Focused test command: `npx tsx scripts/test-with-postgres.ts <test files>`. Final gate: `npm run check`.
- Every commit message is short and ends with the trailer `Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7` (passed as a second `-m`).

## Review Focus

1. **A link scanner unsubscribes someone by fetching the link.** `GET /u/:token` must render a confirmation only; only `POST` suppresses. Tested in Task 6 (`GET` leaves no suppression row).
2. **Token forgery or cross-tenant redemption.** A token must verify only against its own `gtm_deliveries` row's workspace and recipient, survive key rotation via `TREVRA_SECRETS_KEY_PREVIOUS`, and reject tampering. Tested in Task 4; cross-tenant mailto redemption is tested in Task 7.
3. **DNS failure treated as pass, or tests touching real DNS.**
   - A timeout or `SERVFAIL` must produce `unknown`, which blocks planning through `email_deliverability_unknown`.
   - It must never produce `pass`.
   - `TREVRA_DNS_DISABLED` makes the default resolver refuse to query.
   - Tested in Task 2. The planning blocker is tested in Task 12.
4. **The inbound sync stores strangers or another mailbox's mail.** Records from unknown senders, from a non-designated connection, or carrying a different `mailboxAddress` must write zero rows to `source_records`, `messages`, `contacts` and `conversation_messages`. Tested in Task 7.
5. **An approved email leaves from a different mailbox than the one approved.**
   - `executeConnectedAction` silently falls back to another connected mailbox.
   - The approval metadata's `connectionId`/`senderAddress` must therefore be enforced before the send.
   - Tested in Task 13: a disconnected or re-pointed mailbox gets 409 and no provider call.

## File Map

| File                                                                                                | Status | Responsibility                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/133_email_channel.sql`                                                                  | Create | `connections.mailbox_address`, `email_deliverability_checks`, `email_inbound_mailboxes`, `email_outreach_preparations`, two `playbook_runs` unique indexes |
| `src/server/email/types.ts`                                                                         | Create | Shared email-channel types (server and client `import type`)                                                                                               |
| `src/server/email/deliverability.ts`                                                                | Create | `DnsResolver`, SPF/DKIM/DMARC evaluation, provider/domain helpers                                                                                          |
| `src/server/email/sender-deliverability.ts`                                                         | Create | Cached per-workspace checks, outreach-intent marking, worker refresh/prune                                                                                 |
| `src/server/email/mailbox-address.ts`                                                               | Create | Sending-mailbox listing and provider-verified address resolution                                                                                           |
| `src/server/email/public-origin.ts`                                                                 | Create | Public recipient-reachable origin (moved from campaign-channels)                                                                                           |
| `src/server/email/unsubscribe.ts`                                                                   | Create | Token mint/verify, RFC 8058 headers, suppression, confirmation page                                                                                        |
| `src/server/email/inbound-mailbox.ts`                                                               | Create | Accept/ignore decision for inbound-mailbox records                                                                                                         |
| `src/server/email/channel.ts`                                                                       | Create | Email channel status, inbound designation, DNS re-check                                                                                                    |
| `src/server/email/outreach.ts`                                                                      | Create | Email-only plan readiness and `prepareEmailOutreach`                                                                                                       |
| `src/server/integration-service.ts`                                                                 | Modify | `buildMimeMessage`, unsubscribe headers in sends, inbound ingest branch, reconnect/disconnect closers                                                      |
| `src/server/conversations.ts`                                                                       | Modify | `projectCanonicalMessage` source type/outcome options and twin guard                                                                                       |
| `src/server/linkedin/campaign-channels.ts`                                                          | Modify | Use `publicEmailOrigin`                                                                                                                                    |
| `src/server/control-plane/execution.ts`                                                             | Modify | Bind `email.send` to the approved mailbox                                                                                                                  |
| `src/server/playbooks/registry.ts`                                                                  | Modify | `gtm.email-outreach` v1.0.0                                                                                                                                |
| `src/server/gtm/intent.ts`                                                                          | Modify | Email-only compile + prepare                                                                                                                               |
| `src/server/today.ts`                                                                               | Modify | `deliverability_blocked`, inbound-mailbox titles                                                                                                           |
| `src/server/app.ts`                                                                                 | Modify | `/u/:token`, `/api/email/*` routes                                                                                                                         |
| `src/worker/index.ts`                                                                               | Modify | `refreshDueEmailDeliverability` each cycle                                                                                                                 |
| `vitest.setup.ts`                                                                                   | Modify | `TREVRA_DNS_DISABLED=true`                                                                                                                                 |
| `nango-integrations/**`                                                                             | Create | `inbound-messages` sync for `trevra-gmail` and `trevra-microsoft`                                                                                          |
| `src/client/EmailChannelSummary.tsx`, `src/client/EmailChannelPanel.tsx`                            | Create | `/setup/workspace` email panel                                                                                                                             |
| `src/client/views/gtmPlanFormat.ts`                                                                 | Create | Email skip summary and plan-warning parsing for the planner                                                                                                |
| `src/client/api.ts`, `src/client/App.tsx`, `src/client/views/LoopView.tsx`, `src/client/styles.css` | Modify | API calls, panel mount, planner channel + warnings + email result, styles                                                                                  |
| `docs/integration-contracts.md`, `.env.example`, `.gitignore`                                       | Modify | Contracts, `TREVRA_DNS_DISABLED`, Nango build output                                                                                                       |

---

### Task 1: Migration 133

**Files:**

- Create: `migrations/133_email_channel.sql`
- Test: `src/server/email/migration-133.test.ts`

**Interfaces:**

- Consumes: existing tables `connections`, `workspaces`, `users`, `playbook_runs` (`input_json` is JSONB; precedent `migrations/104_conversation_email_reply_idempotency.sql`).
- Produces:
  - Column `connections.mailbox_address TEXT`.
  - Tables:
    - `email_deliverability_checks(workspace_id, domain, provider, status, spf_json, dkim_json, dmarc_json, blockers_json, warnings_json, checked_at, expires_at, outreach_requested_at)`.
    - `email_inbound_mailboxes(workspace_id, connection_id, address, sync_status, sync_error, designated_by_user_id, designated_at, last_record_at, updated_at)`.
    - `email_outreach_preparations(workspace_id, idempotency_key, plan_hash, actor_user_id, lead_list_id, connection_id, run_ids_json, result_json, created_at)`.
  - Indexes:
    - `idx_email_deliverability_checks_due`
    - `idx_email_inbound_mailboxes_connection`
    - `idx_playbook_runs_email_outreach_idempotency`
    - `idx_playbook_runs_email_outreach_open_person`

- [ ] **Step 1: Write the failing test**

Create `src/server/email/migration-133.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_email_migration_133';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Migration 133', NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

function checkViolation(work: Promise<unknown>) {
  return expect(work).rejects.toMatchObject({ code: '23514' });
}

describe('migration 133 email channel', () => {
  it('adds the email channel columns and tables', async () => {
    const columns = await db
      .prepare(
        `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
         WHERE table_schema='public' AND (
           (table_name='connections' AND column_name='mailbox_address') OR
           (table_name='email_deliverability_checks' AND column_name='outreach_requested_at') OR
           (table_name='email_inbound_mailboxes' AND column_name='sync_status') OR
           (table_name='email_outreach_preparations' AND column_name='result_json')
         )
         ORDER BY 1`
      )
      .all<{ name: string }>();
    expect(columns.map((row) => row.name)).toEqual([
      'connections.mailbox_address',
      'email_deliverability_checks.outreach_requested_at',
      'email_inbound_mailboxes.sync_status',
      'email_outreach_preparations.result_json'
    ]);

    const indexes = await db
      .prepare(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY(?::text[])
         ORDER BY indexname`
      )
      .all<{ indexname: string }>([
        'idx_email_deliverability_checks_due',
        'idx_email_inbound_mailboxes_connection',
        'idx_playbook_runs_email_outreach_idempotency',
        'idx_playbook_runs_email_outreach_open_person'
      ]);
    expect(indexes.map((row) => row.indexname)).toEqual([
      'idx_email_deliverability_checks_due',
      'idx_email_inbound_mailboxes_connection',
      'idx_playbook_runs_email_outreach_idempotency',
      'idx_playbook_runs_email_outreach_open_person'
    ]);
  });

  it('refuses non-normalized domains, addresses and sync states', async () => {
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_deliverability_checks
           (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
           VALUES (?,'Acme.test','google','pass','{}','{}','{}',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
    await db
      .prepare(
        `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_migration_133',?,'gmail','trevra-gmail','gmail-migration-133',NULL,'connected',0,?,?)`
      )
      .run(WORKSPACE, NOW, NOW);
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_inbound_mailboxes
           (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
           VALUES (?,'conn_migration_133','Hello@acme.test','syncing',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
    await checkViolation(
      db
        .prepare(
          `INSERT INTO email_inbound_mailboxes
           (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
           VALUES (?,'conn_migration_133','hello@acme.test','polling',?,?)`
        )
        .run(WORKSPACE, NOW, NOW)
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/migration-133.test.ts`
Expected: FAIL. The column list is missing the new columns, and the first insert reports `relation "email_deliverability_checks" does not exist`.

- [ ] **Step 3: Write the migration**

Create `migrations/133_email_channel.sql`:

```sql
-- Phase D: email as a governed peer channel.
--
-- connections.mailbox_address caches the provider-verified address of a
-- Gmail/Microsoft 365 connection (Gmail users/me/profile, Graph /me). It is
-- identity, not a credential, and is cleared whenever Nango re-authorizes the
-- connection so a different account can never inherit the old address.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS mailbox_address TEXT;

-- Cached SPF/DKIM/DMARC evaluation for one sending domain and mail provider.
-- status is pass, fail or unknown: a DNS timeout is unknown and never pass.
-- outreach_requested_at is set only when someone plans email outreach from
-- this domain; Today shows deliverability_blocked only for those rows.
CREATE TABLE IF NOT EXISTS email_deliverability_checks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = LOWER(domain) AND domain <> ''),
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  status TEXT NOT NULL CHECK (status IN ('pass','fail','unknown')),
  spf_json JSONB NOT NULL,
  dkim_json JSONB NOT NULL,
  dmarc_json JSONB NOT NULL,
  blockers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  outreach_requested_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, domain, provider)
);
CREATE INDEX IF NOT EXISTS idx_email_deliverability_checks_due
  ON email_deliverability_checks(expires_at);

-- The one mailbox per workspace whose inbox the Nango inbound-messages sync
-- reads. Records from any other connection or address are ignored.
CREATE TABLE IF NOT EXISTS email_inbound_mailboxes (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address = LOWER(address) AND POSITION('@' IN address) > 1),
  sync_status TEXT NOT NULL CHECK (sync_status IN ('starting','syncing','unavailable')),
  sync_error TEXT,
  designated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  designated_at TIMESTAMPTZ NOT NULL,
  last_record_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_inbound_mailboxes_connection
  ON email_inbound_mailboxes(connection_id);

-- Narrow idempotency receipt for email-only prepare_outreach. Not a job table:
-- it binds one prepare key to one plan hash and the playbook runs it created.
CREATE TABLE IF NOT EXISTS email_outreach_preparations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  lead_list_id TEXT NOT NULL,
  connection_id TEXT,
  run_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, idempotency_key)
);

-- One run per per-person preparation key, and at most one open approval per
-- Person, so a double click or two racing prepares cannot queue two emails.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_runs_email_outreach_idempotency
  ON playbook_runs(workspace_id,(input_json->>'idempotencyKey'))
  WHERE playbook_key='gtm.email-outreach' AND input_json ? 'idempotencyKey';
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_runs_email_outreach_open_person
  ON playbook_runs(workspace_id,(input_json->>'personId'))
  WHERE playbook_key='gtm.email-outreach'
    AND status IN ('queued','running','waiting_approval');

COMMENT ON COLUMN connections.mailbox_address IS
'Provider-verified mailbox address for Gmail/Microsoft 365 connections; cleared on re-authorization.';
COMMENT ON TABLE email_deliverability_checks IS
'Cached SPF/DKIM/DMARC evaluation per workspace sending domain; unknown never counts as pass. Pruned 30 days after the last check.';
COMMENT ON TABLE email_inbound_mailboxes IS
'The single designated inbound mailbox per workspace for the Nango inbound-messages sync.';
COMMENT ON TABLE email_outreach_preparations IS
'Idempotency receipt for email-only prepare_outreach; not a scheduler or universal GTM job.';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/migration-133.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/133_email_channel.sql src/server/email/migration-133.test.ts
git commit -m "feat(email): add migration 133 for the email channel" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 2: SPF/DKIM/DMARC evaluator with an injected resolver

**Files:**

- Create: `src/server/email/types.ts`
- Create: `src/server/email/deliverability.ts`
- Test: `src/server/email/deliverability.test.ts`

**Interfaces:**

- Consumes: `node:dns/promises` `Resolver` (only inside `defaultDnsResolver`).
- Produces:
  - `types.ts`: `MailProvider`, `EmailChannelIssue`, `DeliverabilityCheck`, `DeliverabilityStatus`, `DeliverabilityEvaluation`, `StoredDeliverability`, `EmailChannelMailbox`, `InboundSyncStatus`, `EmailInboundMailboxState`, `EmailChannelStatus`, `EmailOutreachSkipReason`, `PreparedEmailOutreachResult`.
  - `deliverability.ts`:
    - `interface DnsResolver { resolveTxt(name: string): Promise<string[][]> }`
    - `defaultDnsResolver(env?)`
    - `mailProviderFor(provider: string): MailProvider | null`
    - `emailDomainOf(address: string): string | null`
    - `evaluateDeliverability(input: { domain: string; provider: MailProvider }, resolver?: DnsResolver): Promise<DeliverabilityEvaluation>`

- [ ] **Step 1: Write the shared types**

Create `src/server/email/types.ts`:

```ts
/** Mail providers Trevra can send through, keyed by their DNS footprint. */
export type MailProvider = 'google' | 'microsoft';

/** One blocker or warning, shaped like a GTM plan blocker. */
export interface EmailChannelIssue {
  code: string;
  message: string;
  actionHref?: string;
}

export interface DeliverabilityCheck {
  status: 'pass' | 'fail' | 'unknown' | 'provider_managed';
  detail: string;
  record: string | null;
  selector?: string | null;
  lookups?: number;
}

export type DeliverabilityStatus = 'pass' | 'fail' | 'unknown';

export interface DeliverabilityEvaluation {
  domain: string;
  provider: MailProvider;
  status: DeliverabilityStatus;
  spf: DeliverabilityCheck;
  dkim: DeliverabilityCheck;
  dmarc: DeliverabilityCheck;
  blockers: EmailChannelIssue[];
  warnings: EmailChannelIssue[];
}

export interface StoredDeliverability extends DeliverabilityEvaluation {
  checkedAt: string;
  expiresAt: string;
}

export interface EmailChannelMailbox {
  connectionId: string;
  provider: string;
  providerKey: MailProvider;
  displayName: string | null;
  address: string | null;
}

export type InboundSyncStatus = 'starting' | 'syncing' | 'unavailable';

export interface EmailInboundMailboxState {
  connectionId: string;
  address: string;
  syncStatus: InboundSyncStatus;
  syncError: string | null;
  designatedAt: string;
  lastRecordAt: string | null;
  nango: { status: string; finishedAt: string | null } | null;
}

export interface EmailChannelStatus {
  unsubscribe: { oneClick: boolean; mailto: boolean; detail: string };
  mailboxes: Array<EmailChannelMailbox & { deliverability: StoredDeliverability | null }>;
  inbound: EmailInboundMailboxState | null;
}

export type EmailOutreachSkipReason =
  | 'no_email'
  | 'unresolved_person'
  | 'do_not_contact'
  | 'suppressed'
  | 'already_pending'
  | 'already_contacted';

export interface PreparedEmailOutreachResult {
  prepared: Array<{ contactId: string; personId: string; runId: string }>;
  skipped: Array<{ contactId: string; reason: EmailOutreachSkipReason }>;
  connectionId: string;
  senderAddress: string;
  /** True when the list had more members than one preparation reads. */
  truncated: boolean;
  duplicate: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/server/email/deliverability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  defaultDnsResolver,
  emailDomainOf,
  evaluateDeliverability,
  mailProviderFor,
  type DnsResolver
} from './deliverability.js';

function fakeResolver(
  records: Record<string, string[] | Error>
): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (value instanceof Error) throw value;
      if (!value)
        throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';
const GOOGLE_SPF = { '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'] };
const MICROSOFT_SPF = { 'spf.protection.outlook.com': ['v=spf1 ip4:198.51.100.0/24 -all'] };

function googleDomain(overrides: Record<string, string[] | Error> = {}) {
  return {
    ...GOOGLE_SPF,
    'acme.test': ['google-site-verification=abc123', 'v=spf1 include:_spf.google.com ~all'],
    'google._domainkey.acme.test': [DKIM],
    '_dmarc.acme.test': ['v=DMARC1; p=none; rua=mailto:dmarc@acme.test'],
    ...overrides
  };
}

describe('email deliverability evaluation', () => {
  it('passes a Google Workspace domain with SPF, DKIM and DMARC', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain())
    );
    expect(result.status).toBe('pass');
    expect(result.blockers).toEqual([]);
    expect(result.spf).toMatchObject({ status: 'pass', lookups: 1 });
    expect(result.dkim).toMatchObject({ status: 'pass', selector: 'google' });
    expect(result.dmarc).toMatchObject({ status: 'pass', detail: 'DMARC p=none.' });
  });

  it('blocks a domain that publishes none of the three records', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver({})
    );
    expect(result.status).toBe('fail');
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_missing',
      'email_dkim_missing',
      'email_dmarc_missing'
    ]);
    expect(result.blockers.every((blocker) => blocker.actionHref === '/setup/workspace')).toBe(
      true
    );
    expect(result.blockers[0]!.message).toContain('include:_spf.google.com');
  });

  it('blocks SPF that does not authorize the sending provider', async () => {
    const outlookOnly = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          ...MICROSOFT_SPF,
          'acme.test': ['v=spf1 include:spf.protection.outlook.com -all']
        })
      )
    );
    expect(outlookOnly.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);

    const failQualified = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 -include:_spf.google.com ~all'] }))
    );
    expect(failQualified.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);
  });

  it('treats more than ten SPF lookups as invalid', async () => {
    const nested = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`n${index}.acme.test`, ['v=spf1 ~all']])
    );
    const includes = Array.from({ length: 10 }, (_, index) => `include:n${index}.acme.test`);
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          ...nested,
          'acme.test': [`v=spf1 include:_spf.google.com ${includes.join(' ')} ~all`]
        })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
    expect(result.spf.detail).toContain('more than 10 DNS lookups');
  });

  it('treats two SPF records as invalid', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({ 'acme.test': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 -all'] })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
  });

  it('accepts an organizational DMARC record for a subdomain sender', async () => {
    const result = await evaluateDeliverability(
      { domain: 'mail.acme.test', provider: 'google' },
      fakeResolver({
        ...GOOGLE_SPF,
        'mail.acme.test': ['v=spf1 include:_spf.google.com ~all'],
        'google._domainkey.mail.acme.test': [DKIM],
        '_dmarc.acme.test': ['v=DMARC1; p=quarantine']
      })
    );
    expect(result.status).toBe('pass');
    expect(result.dmarc.detail).toBe('DMARC p=quarantine, inherited from acme.test.');
  });

  it('reports unknown, never pass, when DNS times out', async () => {
    const timeout = Object.assign(new Error('queryTxt ETIMEOUT acme.test'), { code: 'ETIMEOUT' });
    const resolver: DnsResolver = {
      async resolveTxt() {
        throw timeout;
      }
    };
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('unknown');
    expect(result.blockers).toEqual([]);
    expect([result.spf.status, result.dkim.status, result.dmarc.status]).toEqual([
      'unknown',
      'unknown',
      'unknown'
    ]);
  });

  it('checks both Microsoft 365 DKIM selectors', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'microsoft' },
      fakeResolver({
        ...MICROSOFT_SPF,
        'acme.test': ['v=spf1 include:spf.protection.outlook.com -all'],
        'selector2._domainkey.acme.test': [DKIM],
        '_dmarc.acme.test': ['v=DMARC1; p=reject']
      })
    );
    expect(result.status).toBe('pass');
    expect(result.dkim.selector).toBe('selector2');
  });

  it('does not query DNS for consumer mailboxes', async () => {
    const resolver = fakeResolver({});
    const result = await evaluateDeliverability(
      { domain: 'gmail.com', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('pass');
    expect(result.spf.status).toBe('provider_managed');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['email_consumer_mailbox']);
    expect(resolver.calls).toEqual([]);
  });

  it('refuses real DNS when TREVRA_DNS_DISABLED is true', async () => {
    const resolver = defaultDnsResolver({ TREVRA_DNS_DISABLED: 'true' } as NodeJS.ProcessEnv);
    await expect(resolver.resolveTxt('acme.test')).rejects.toMatchObject({ code: 'EDISABLED' });
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('unknown');
  });

  it('maps providers and domains conservatively', () => {
    expect(mailProviderFor('google-mail')).toBe('google');
    expect(mailProviderFor('outlook')).toBe('microsoft');
    expect(mailProviderFor('hubspot')).toBeNull();
    expect(emailDomainOf('Founder@Acme.TEST')).toBe('acme.test');
    expect(emailDomainOf('not-an-address')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/deliverability.test.ts`
Expected: FAIL with `Cannot find module './deliverability.js'`.

- [ ] **Step 4: Implement the evaluator**

Create `src/server/email/deliverability.ts`:

```ts
import { Resolver } from 'node:dns/promises';
import type {
  DeliverabilityCheck,
  DeliverabilityEvaluation,
  DeliverabilityStatus,
  EmailChannelIssue,
  MailProvider
} from './types.js';

/** The only DNS surface Trevra uses. Tests inject a fake; production uses node:dns. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

/**
 * Real DNS, unless TREVRA_DNS_DISABLED=true (set for every test by
 * vitest.setup.ts), in which case every query fails with EDISABLED and the
 * evaluation reports unknown -- never pass.
 */
export function defaultDnsResolver(env: NodeJS.ProcessEnv = process.env): DnsResolver {
  if (env.TREVRA_DNS_DISABLED === 'true') {
    return {
      async resolveTxt() {
        throw Object.assign(new Error('DNS lookups are disabled in this process.'), {
          code: 'EDISABLED'
        });
      }
    };
  }
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  return { resolveTxt: (name) => resolver.resolveTxt(name) };
}

export function mailProviderFor(provider: string): MailProvider | null {
  const value = provider.trim().toLowerCase();
  if (value === 'gmail' || value === 'google-mail') return 'google';
  if (value === 'microsoft' || value === 'outlook') return 'microsoft';
  return null;
}

export function emailDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

const SPF_LOOKUP_LIMIT = 10;
const SPF_LOOKUP_MECHANISMS = new Set(['include', 'a', 'mx', 'ptr', 'exists']);
const PROVIDER_SPF_INCLUDE: Record<MailProvider, string> = {
  google: '_spf.google.com',
  microsoft: 'spf.protection.outlook.com'
};
const PROVIDER_LABEL: Record<MailProvider, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365'
};
// lc-debt: default selectors only (Google "google", Microsoft 365 "selector1"/"selector2"); a custom DKIM selector reads as missing. Upgrade path: an owner-set selector stored per sending domain.
const DKIM_SELECTORS: Record<MailProvider, string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2']
};
const CONSUMER_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com'
]);

function issue(code: string, message: string): EmailChannelIssue {
  return { code, message, actionHref: '/setup/workspace' };
}

type TxtLookup =
  { kind: 'records'; records: string[] } | { kind: 'absent' } | { kind: 'unknown'; detail: string };

async function lookupTxt(resolver: DnsResolver, name: string): Promise<TxtLookup> {
  try {
    const chunks = await resolver.resolveTxt(name);
    return { kind: 'records', records: chunks.map((parts) => parts.join('')) };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    // NXDOMAIN and "no TXT records" are definite answers; anything else
    // (timeout, SERVFAIL, refused, disabled) is not an answer at all.
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { kind: 'absent' };
    return { kind: 'unknown', detail: code || 'DNS lookup failed' };
  }
}

type SpfWalk =
  | { result: 'ok'; authorized: boolean; record: string }
  | { result: 'missing' }
  | { result: 'invalid'; detail: string; record: string | null }
  | { result: 'unknown'; detail: string };

async function walkSpf(
  resolver: DnsResolver,
  domain: string,
  target: string,
  state: { lookups: number },
  ancestors: ReadonlySet<string>
): Promise<SpfWalk> {
  if (ancestors.has(domain)) {
    return { result: 'invalid', detail: `SPF include loop at ${domain}.`, record: null };
  }
  const lookup = await lookupTxt(resolver, domain);
  if (lookup.kind === 'unknown') {
    return { result: 'unknown', detail: `SPF lookup for ${domain} failed (${lookup.detail}).` };
  }
  const records =
    lookup.kind === 'records'
      ? lookup.records
          .map((value) => value.trim())
          .filter((value) => /^v=spf1(?:\s|$)/i.test(value))
      : [];
  if (records.length === 0) return { result: 'missing' };
  const record = records[0]!;
  if (records.length > 1) {
    return {
      result: 'invalid',
      detail: `${domain} publishes ${records.length} SPF records; receivers treat that as a permanent error.`,
      record
    };
  }
  const terms = record.split(/\s+/).slice(1);
  const hasAll = terms.some((term) => /^[+?~-]?all$/i.test(term));
  const path = new Set(ancestors).add(domain);
  let authorized = false;
  for (const term of terms) {
    const match = /^([+?~-]?)([a-z][a-z0-9.-]*)(?:[:=](.*))?$/i.exec(term);
    if (!match) continue;
    const qualifier = match[1] || '+';
    const mechanism = match[2]!.toLowerCase();
    const value = (match[3] ?? '').trim().toLowerCase().replace(/\.$/, '');
    const isRedirect = mechanism === 'redirect' && !hasAll;
    if (SPF_LOOKUP_MECHANISMS.has(mechanism) || isRedirect) {
      state.lookups += 1;
      if (state.lookups > SPF_LOOKUP_LIMIT) {
        return {
          result: 'invalid',
          detail: `SPF for ${domain} needs more than ${SPF_LOOKUP_LIMIT} DNS lookups; receivers stop evaluating it.`,
          record
        };
      }
    }
    if (mechanism !== 'include' && !isRedirect) continue;
    if (!value) {
      return {
        result: 'invalid',
        detail: `SPF ${mechanism} at ${domain} names no domain.`,
        record
      };
    }
    // Macro targets (%{...}) cannot be evaluated statically; they never count as authorizing.
    if (value.includes('%')) continue;
    const nested = await walkSpf(resolver, value, target, state, path);
    if (nested.result === 'unknown') return nested;
    if (nested.result === 'missing') {
      return {
        result: 'invalid',
        detail: `SPF for ${domain} includes ${value}, which publishes no SPF record.`,
        record
      };
    }
    if (nested.result === 'invalid') return { result: 'invalid', detail: nested.detail, record };
    if ((isRedirect || qualifier === '+') && (value === target || nested.authorized)) {
      authorized = true;
    }
  }
  return { result: 'ok', authorized, record };
}

type Evaluated = { check: DeliverabilityCheck; blocker: EmailChannelIssue | null };

async function evaluateSpf(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider
): Promise<Evaluated> {
  const target = PROVIDER_SPF_INCLUDE[provider];
  const label = PROVIDER_LABEL[provider];
  const state = { lookups: 0 };
  const walk = await walkSpf(resolver, domain, target, state, new Set());
  if (walk.result === 'unknown') {
    return {
      check: { status: 'unknown', detail: walk.detail, record: null, lookups: state.lookups },
      blocker: null
    };
  }
  if (walk.result === 'missing') {
    return {
      check: {
        status: 'fail',
        detail: `${domain} publishes no SPF record.`,
        record: null,
        lookups: 0
      },
      blocker: issue(
        'email_spf_missing',
        `${domain} publishes no SPF record. Add the TXT record "v=spf1 include:${target} ~all" so receivers accept mail sent through ${label}.`
      )
    };
  }
  if (walk.result === 'invalid') {
    return {
      check: { status: 'fail', detail: walk.detail, record: walk.record, lookups: state.lookups },
      blocker: issue('email_spf_invalid', walk.detail)
    };
  }
  if (!walk.authorized) {
    return {
      check: {
        status: 'fail',
        detail: `SPF does not authorize ${target}.`,
        record: walk.record,
        lookups: state.lookups
      },
      blocker: issue(
        'email_spf_provider_not_authorized',
        `The SPF record for ${domain} does not include ${target}, so mail sent through ${label} fails SPF. Add "include:${target}" before the final "all".`
      )
    };
  }
  return {
    check: {
      status: 'pass',
      detail: `SPF authorizes ${target} (${state.lookups} of ${SPF_LOOKUP_LIMIT} lookups).`,
      record: walk.record,
      lookups: state.lookups
    },
    blocker: null
  };
}

function hasDkimKey(record: string): boolean {
  const tags = new Map(
    record.split(';').map((part) => {
      const index = part.indexOf('=');
      return index < 0
        ? [part.trim().toLowerCase(), '']
        : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1)];
    })
  );
  const key = (tags.get('p') ?? '').replace(/\s+/g, '');
  return /^[A-Za-z0-9+/]{16,}={0,2}$/.test(key);
}

async function evaluateDkim(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider
): Promise<Evaluated> {
  const selectors = DKIM_SELECTORS[provider];
  let failure: string | null = null;
  for (const selector of selectors) {
    const lookup = await lookupTxt(resolver, `${selector}._domainkey.${domain}`);
    if (lookup.kind === 'unknown') {
      failure = lookup.detail;
      continue;
    }
    if (lookup.kind === 'absent') continue;
    const record = lookup.records.find(hasDkimKey);
    if (record) {
      return {
        check: {
          status: 'pass',
          detail: `DKIM key published at selector ${selector}.`,
          record,
          selector
        },
        blocker: null
      };
    }
  }
  if (failure) {
    return {
      check: {
        status: 'unknown',
        detail: `DKIM lookup failed (${failure}).`,
        record: null,
        selector: null
      },
      blocker: null
    };
  }
  return {
    check: {
      status: 'fail',
      detail: `No DKIM key at ${selectors.map((selector) => `${selector}._domainkey.${domain}`).join(' or ')}.`,
      record: null,
      selector: null
    },
    blocker: issue(
      'email_dkim_missing',
      `No DKIM key is published for ${domain} at selector ${selectors.join(' or ')}. Turn on DKIM signing in the ${PROVIDER_LABEL[provider]} admin console and publish the key it gives you.`
    )
  };
}

type DmarcLookup =
  | { kind: 'record'; record: string; policy: string }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string; record: string }
  | { kind: 'unknown'; detail: string };

async function dmarcAt(resolver: DnsResolver, name: string): Promise<DmarcLookup> {
  const lookup = await lookupTxt(resolver, name);
  if (lookup.kind === 'unknown') {
    return { kind: 'unknown', detail: `DMARC lookup for ${name} failed (${lookup.detail}).` };
  }
  if (lookup.kind === 'absent') return { kind: 'absent' };
  const records = lookup.records
    .map((value) => value.trim())
    .filter((value) => /^v=DMARC1\s*(?:;|$)/i.test(value));
  if (records.length === 0) return { kind: 'absent' };
  if (records.length > 1) {
    return {
      kind: 'invalid',
      detail: `${name} publishes ${records.length} DMARC records; receivers ignore all of them.`,
      record: records[0]!
    };
  }
  const policy =
    /(?:^|;)\s*p\s*=\s*([a-z]+)\s*(?:;|$)/i.exec(records[0]!)?.[1]?.toLowerCase() ?? '';
  if (!['none', 'quarantine', 'reject'].includes(policy)) {
    return {
      kind: 'invalid',
      detail: `${name} has no valid DMARC policy (p=none, quarantine or reject).`,
      record: records[0]!
    };
  }
  return { kind: 'record', record: records[0]!, policy };
}

function organizationalDomain(domain: string): string {
  // lc-debt: last-two-labels heuristic, wrong for multi-label public suffixes such as co.uk (it then checks _dmarc.co.uk, finds nothing and blocks, which fails safe); upgrade path: a Public Suffix List lookup.
  return domain.split('.').slice(-2).join('.');
}

async function evaluateDmarc(resolver: DnsResolver, domain: string): Promise<Evaluated> {
  let found = await dmarcAt(resolver, `_dmarc.${domain}`);
  let inheritedFrom: string | null = null;
  if (found.kind === 'absent') {
    const org = organizationalDomain(domain);
    if (org !== domain) {
      found = await dmarcAt(resolver, `_dmarc.${org}`);
      inheritedFrom = org;
    }
  }
  if (found.kind === 'unknown') {
    return { check: { status: 'unknown', detail: found.detail, record: null }, blocker: null };
  }
  if (found.kind === 'invalid') {
    return {
      check: { status: 'fail', detail: found.detail, record: found.record },
      blocker: issue('email_dmarc_invalid', found.detail)
    };
  }
  if (found.kind === 'absent') {
    return {
      check: { status: 'fail', detail: `${domain} publishes no DMARC record.`, record: null },
      blocker: issue(
        'email_dmarc_missing',
        `${domain} publishes no DMARC record. Add a TXT record at _dmarc.${domain}, for example "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".`
      )
    };
  }
  return {
    check: {
      status: 'pass',
      detail: inheritedFrom
        ? `DMARC p=${found.policy}, inherited from ${inheritedFrom}.`
        : `DMARC p=${found.policy}.`,
      record: found.record
    },
    blocker: null
  };
}

export async function evaluateDeliverability(
  input: { domain: string; provider: MailProvider },
  resolver: DnsResolver = defaultDnsResolver()
): Promise<DeliverabilityEvaluation> {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, '');
  if (CONSUMER_MAILBOX_DOMAINS.has(domain)) {
    const managed: DeliverabilityCheck = {
      status: 'provider_managed',
      detail: `${domain} is a consumer mailbox; its provider manages SPF, DKIM and DMARC.`,
      record: null
    };
    return {
      domain,
      provider: input.provider,
      status: 'pass',
      spf: managed,
      dkim: managed,
      dmarc: managed,
      blockers: [],
      warnings: [
        issue(
          'email_consumer_mailbox',
          `${domain} is a consumer mailbox: you cannot publish your own SPF, DKIM or DMARC and daily sending limits are low. Use a mailbox on your own domain for outreach.`
        )
      ]
    };
  }
  const [spf, dkim, dmarc] = await Promise.all([
    evaluateSpf(resolver, domain, input.provider),
    evaluateDkim(resolver, domain, input.provider),
    evaluateDmarc(resolver, domain)
  ]);
  const blockers = [spf.blocker, dkim.blocker, dmarc.blocker].filter(
    (blocker): blocker is EmailChannelIssue => blocker !== null
  );
  const status: DeliverabilityStatus =
    blockers.length > 0
      ? 'fail'
      : [spf.check, dkim.check, dmarc.check].some((check) => check.status === 'unknown')
        ? 'unknown'
        : 'pass';
  return {
    domain,
    provider: input.provider,
    status,
    spf: spf.check,
    dkim: dkim.check,
    dmarc: dmarc.check,
    blockers,
    warnings: []
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/deliverability.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/email/types.ts src/server/email/deliverability.ts src/server/email/deliverability.test.ts
git commit -m "feat(email): evaluate SPF, DKIM and DMARC with an injected resolver" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 3: Cached sender deliverability, mailbox identity, worker refresh

**Files:**

- Create: `src/server/email/sender-deliverability.ts`
- Create: `src/server/email/mailbox-address.ts`
- Modify: `src/server/integration-service.ts` (auth upsert, ~L324-325)
- Modify: `src/worker/index.ts` (imports ~L34, `cycle()` ~L123-129)
- Modify: `vitest.setup.ts`
- Test: `src/server/email/sender-deliverability.test.ts`, `src/server/integration-service.test.ts`

**Interfaces:**

- Consumes:
  - `evaluateDeliverability`, `defaultDnsResolver`, `mailProviderFor` (Task 2);
  - `email_deliverability_checks`, `connections.mailbox_address` (Task 1);
  - `getNango()` (`src/server/integration-service.ts:1178`).
- Produces:
  - `getSenderDeliverability(db, workspaceId, { domain, provider, markOutreach?, force? }, { resolver?, now? }): Promise<StoredDeliverability>`
  - `readSenderDeliverability(db, workspaceId, domain, provider): Promise<StoredDeliverability | null>`
  - `refreshDueEmailDeliverability(db, { resolver?, now? }?): Promise<{ refreshed: number; pruned: number }>`
  - `interface SendingMailbox extends EmailChannelMailbox { providerConfigKey; externalConnectionId }`
  - `listSendingMailboxes(db, workspaceId): Promise<SendingMailbox[]>`
  - `resolveMailboxAddress(db, workspaceId, mailbox): Promise<string | null>`

- [ ] **Step 1: Stop every test process from reaching real DNS**

Append to `vitest.setup.ts`:

```ts
/**
 * NO TEST MAY RESOLVE REAL DNS. Email deliverability checks read SPF, DKIM and
 * DMARC TXT records; `defaultDnsResolver` refuses every query while this is set,
 * so a test that forgets to inject a fake resolver sees `unknown`, never the
 * network. Tests that exercise evaluation pass an explicit fake `DnsResolver`.
 */
process.env.TREVRA_DNS_DISABLED = 'true';
```

- [ ] **Step 2: Write the failing tests**

Create `src/server/email/sender-deliverability.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsResolver } from './deliverability.js';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({
    data: {} as Record<string, unknown>,
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
  }
}));

const { openDatabase } = await import('../db.js');
const { getSenderDeliverability, readSenderDeliverability, refreshDueEmailDeliverability } =
  await import('./sender-deliverability.js');
const { listSendingMailboxes, resolveMailboxAddress } = await import('./mailbox-address.js');

type Db = Awaited<ReturnType<typeof openDatabase>>;
const WORKSPACE = 'ws_email_sender_deliverability';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const MINUTE = 60_000;
let db: Db;

const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';

function resolverFor(records: Record<string, string[]>): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (!value) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

function passingRecords(domain: string): Record<string, string[]> {
  return {
    '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'],
    [domain]: ['v=spf1 include:_spf.google.com ~all'],
    [`google._domainkey.${domain}`]: [DKIM],
    [`_dmarc.${domain}`]: ['v=DMARC1; p=none']
  };
}

async function insertConnection(input: {
  id: string;
  provider: string;
  status?: string;
  isDemo?: number;
  updatedAt?: string;
}) {
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      WORKSPACE,
      input.provider,
      `trevra-${input.provider}`,
      `${input.id}-external`,
      'owner@example.test',
      input.status ?? 'connected',
      input.isDemo ?? 0,
      NOW.toISOString(),
      input.updatedAt ?? NOW.toISOString()
    );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Sender deliverability', NOW.toISOString());
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('cached sender deliverability', () => {
  it('trusts a passing answer for a day and re-checks on demand', async () => {
    const resolver = resolverFor(passingRecords('acme.test'));
    const first = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'Acme.test', provider: 'google' },
      { resolver, now: NOW }
    );
    expect(first).toMatchObject({ domain: 'acme.test', status: 'pass' });
    expect(first.expiresAt).toBe(new Date(NOW.getTime() + 24 * 60 * MINUTE).toISOString());
    const lookups = resolver.calls.length;
    expect(lookups).toBeGreaterThan(0);

    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver, now: new Date(NOW.getTime() + 60 * MINUTE) }
    );
    expect(resolver.calls.length).toBe(lookups);

    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', force: true },
      { resolver, now: new Date(NOW.getTime() + 60 * MINUTE) }
    );
    expect(resolver.calls.length).toBeGreaterThan(lookups);
  });

  it('re-checks a failing domain after ten minutes and keeps outreach intent', async () => {
    const failing = resolverFor({});
    const failed = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: failing, now: NOW }
    );
    expect(failed.status).toBe('fail');
    expect(failed.expiresAt).toBe(new Date(NOW.getTime() + 10 * MINUTE).toISOString());

    const fixed = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      {
        resolver: resolverFor(passingRecords('acme.test')),
        now: new Date(NOW.getTime() + 11 * MINUTE)
      }
    );
    expect(fixed.status).toBe('pass');
    const row = await db
      .prepare(
        'SELECT outreach_requested_at FROM email_deliverability_checks WHERE workspace_id=? AND domain=?'
      )
      .get<{ outreach_requested_at: string | null }>(WORKSPACE, 'acme.test');
    expect(new Date(String(row?.outreach_requested_at)).toISOString()).toBe(NOW.toISOString());
  });

  it('refreshes stale domains someone plans to send from and prunes abandoned ones', async () => {
    const failing = resolverFor({});
    const hourAgo = new Date(NOW.getTime() - 60 * MINUTE);
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'a.acme.test', provider: 'google', markOutreach: true },
      { resolver: failing, now: hourAgo }
    );
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'b.acme.test', provider: 'google' },
      { resolver: failing, now: hourAgo }
    );
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'c.acme.test', provider: 'google' },
      { resolver: failing, now: new Date(NOW.getTime() - 31 * 24 * 60 * MINUTE) }
    );

    const result = await refreshDueEmailDeliverability(db, {
      resolver: resolverFor(passingRecords('a.acme.test')),
      now: NOW
    });
    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect((await readSenderDeliverability(db, WORKSPACE, 'a.acme.test', 'google'))?.status).toBe(
      'pass'
    );
    const untouched = await readSenderDeliverability(db, WORKSPACE, 'b.acme.test', 'google');
    expect(untouched?.status).toBe('fail');
    expect(untouched?.checkedAt).toBe(hourAgo.toISOString());
    expect(await readSenderDeliverability(db, WORKSPACE, 'c.acme.test', 'google')).toBeNull();
  });
});

describe('sending mailbox identity', () => {
  it('lists live mailboxes and caches the provider-verified address', async () => {
    await insertConnection({ id: 'conn_gmail_live', provider: 'gmail' });
    await insertConnection({
      id: 'conn_ms_live',
      provider: 'microsoft',
      updatedAt: new Date(NOW.getTime() - MINUTE).toISOString()
    });
    await insertConnection({ id: 'conn_demo', provider: 'gmail', isDemo: 1 });
    await insertConnection({ id: 'conn_gone', provider: 'gmail', status: 'disconnected' });

    const mailboxes = await listSendingMailboxes(db, WORKSPACE);
    expect(mailboxes.map((mailbox) => [mailbox.connectionId, mailbox.providerKey])).toEqual([
      ['conn_gmail_live', 'google'],
      ['conn_ms_live', 'microsoft']
    ]);
    expect(mailboxes.every((mailbox) => mailbox.address === null)).toBe(true);

    nangoMock.get.mockResolvedValueOnce({
      data: { emailAddress: 'Founder@Acme.test' },
      headers: {}
    });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailboxes[0]!)).toBe('founder@acme.test');
    expect(nangoMock.get.mock.calls[0]?.[0]).toMatchObject({
      endpoint: '/gmail/v1/users/me/profile',
      providerConfigKey: 'trevra-gmail',
      connectionId: 'conn_gmail_live-external'
    });

    nangoMock.get.mockResolvedValueOnce({
      data: { mail: null, userPrincipalName: 'ops@acme.test' },
      headers: {}
    });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailboxes[1]!)).toBe('ops@acme.test');
    expect(nangoMock.get.mock.calls[1]?.[0]).toMatchObject({
      endpoint: '/v1.0/me',
      params: { $select: 'mail,userPrincipalName' }
    });

    const cached = await listSendingMailboxes(db, WORKSPACE);
    expect(cached.map((mailbox) => mailbox.address)).toEqual([
      'founder@acme.test',
      'ops@acme.test'
    ]);
    expect(await resolveMailboxAddress(db, WORKSPACE, cached[0]!)).toBe('founder@acme.test');
    expect(nangoMock.get).toHaveBeenCalledTimes(2);
  });

  it('stores nothing when the provider answer is not an address', async () => {
    await insertConnection({ id: 'conn_gmail_odd', provider: 'gmail' });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    nangoMock.get.mockResolvedValueOnce({ data: { emailAddress: 'not an address' }, headers: {} });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    nangoMock.get.mockRejectedValueOnce(Object.assign(new Error('HTTP 401'), { status: 401 }));
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    const row = await db
      .prepare('SELECT mailbox_address FROM connections WHERE id=?')
      .get<{ mailbox_address: string | null }>('conn_gmail_odd');
    expect(row?.mailbox_address).toBeNull();
  });
});
```

Append to `src/server/integration-service.test.ts`:

```ts
describe('mailbox identity on re-authorization', () => {
  it('clears the cached mailbox address whenever Nango re-authorizes the connection', async () => {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';
    const tenant = await seedTenant(database);
    const connectionId = `gmail-${id('conn')}`;
    const authEvent = (eventId: string) =>
      JSON.stringify({
        id: eventId,
        type: 'auth',
        success: true,
        provider: 'gmail',
        providerConfigKey: 'trevra-gmail',
        connectionId,
        tags: { organization_id: tenant.workspaceId, end_user_email: 'owner@example.test' }
      });

    await handleNangoWebhook(database, authEvent(`evt-${id('auth')}`), {});
    await database
      .prepare(
        "UPDATE connections SET mailbox_address='old-owner@acme.test' WHERE workspace_id=? AND external_connection_id=?"
      )
      .run(tenant.workspaceId, connectionId);
    await handleNangoWebhook(database, authEvent(`evt-${id('auth')}`), {});

    const row = await database
      .prepare(
        'SELECT mailbox_address FROM connections WHERE workspace_id=? AND external_connection_id=?'
      )
      .get<{ mailbox_address: string | null }>(tenant.workspaceId, connectionId);
    expect(row?.mailbox_address).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/sender-deliverability.test.ts src/server/integration-service.test.ts`
Expected: FAIL. `sender-deliverability.test.ts` reports `Cannot find module './sender-deliverability.js'`, and the re-authorization test gets `mailbox_address` `'old-owner@acme.test'` where it expects `null`.

- [ ] **Step 4: Implement the cache**

Create `src/server/email/sender-deliverability.ts`:

```ts
import type { Db } from '../db.js';
import { defaultDnsResolver, evaluateDeliverability, type DnsResolver } from './deliverability.js';
import type {
  DeliverabilityCheck,
  DeliverabilityEvaluation,
  DeliverabilityStatus,
  EmailChannelIssue,
  MailProvider,
  StoredDeliverability
} from './types.js';

const MINUTE = 60_000;
/**
 * How long one answer is trusted. A failure is re-checked soon so a DNS fix
 * unblocks planning within minutes; a pass is re-checked daily so a broken
 * record is noticed the next morning.
 */
const TTL_MS: Record<DeliverabilityStatus, number> = {
  pass: 24 * 60 * MINUTE,
  fail: 10 * MINUTE,
  unknown: 5 * MINUTE
};
const OUTREACH_INTENT_WINDOW_MS = 30 * 24 * 60 * MINUTE;
const PRUNE_AFTER_MS = 30 * 24 * 60 * MINUTE;
// lc-debt: at most 25 stale domains refreshed per worker cycle; upgrade path: shard the refresh by workspace once more than 25 sending domains go stale inside one cycle.
const REFRESH_BATCH = 25;

const COLUMNS =
  'domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,checked_at,expires_at';

interface CheckRow {
  domain: string;
  provider: MailProvider;
  status: DeliverabilityStatus;
  spf_json: DeliverabilityCheck;
  dkim_json: DeliverabilityCheck;
  dmarc_json: DeliverabilityCheck;
  blockers_json: EmailChannelIssue[] | null;
  warnings_json: EmailChannelIssue[] | null;
  checked_at: string;
  expires_at: string;
}

function fromRow(row: CheckRow): StoredDeliverability {
  return {
    domain: row.domain,
    provider: row.provider,
    status: row.status,
    spf: row.spf_json,
    dkim: row.dkim_json,
    dmarc: row.dmarc_json,
    blockers: row.blockers_json ?? [],
    warnings: row.warnings_json ?? [],
    checkedAt: new Date(row.checked_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

export interface DeliverabilityOptions {
  resolver?: DnsResolver;
  now?: Date;
}

export async function readSenderDeliverability(
  db: Db,
  workspaceId: string,
  domain: string,
  provider: MailProvider
): Promise<StoredDeliverability | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM email_deliverability_checks
       WHERE workspace_id=? AND domain=? AND provider=?`
    )
    .get<CheckRow>(workspaceId, domain.trim().toLowerCase(), provider);
  return row ? fromRow(row) : null;
}

async function storeEvaluation(
  db: Db,
  workspaceId: string,
  evaluation: DeliverabilityEvaluation,
  now: Date,
  markOutreach: boolean
): Promise<StoredDeliverability> {
  const row = await db
    .prepare(
      `INSERT INTO email_deliverability_checks
         (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
          checked_at,expires_at,outreach_requested_at)
       VALUES (?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::timestamptz,?::timestamptz,?::timestamptz)
       ON CONFLICT (workspace_id,domain,provider) DO UPDATE SET
         status=excluded.status,spf_json=excluded.spf_json,dkim_json=excluded.dkim_json,
         dmarc_json=excluded.dmarc_json,blockers_json=excluded.blockers_json,
         warnings_json=excluded.warnings_json,checked_at=excluded.checked_at,
         expires_at=excluded.expires_at,
         outreach_requested_at=COALESCE(excluded.outreach_requested_at,email_deliverability_checks.outreach_requested_at)
       RETURNING ${COLUMNS}`
    )
    .get<CheckRow>(
      workspaceId,
      evaluation.domain,
      evaluation.provider,
      evaluation.status,
      JSON.stringify(evaluation.spf),
      JSON.stringify(evaluation.dkim),
      JSON.stringify(evaluation.dmarc),
      JSON.stringify(evaluation.blockers),
      JSON.stringify(evaluation.warnings),
      now.toISOString(),
      new Date(now.getTime() + TTL_MS[evaluation.status]).toISOString(),
      markOutreach ? now.toISOString() : null
    );
  if (!row) throw new Error('Email deliverability result could not be stored.');
  return fromRow(row);
}

/**
 * The deliverability of one sending domain, from cache while it is fresh.
 * `markOutreach` records that someone planned email outreach from this domain,
 * which is what makes the worker keep it fresh and Today surface a failure.
 */
export async function getSenderDeliverability(
  db: Db,
  workspaceId: string,
  input: { domain: string; provider: MailProvider; markOutreach?: boolean; force?: boolean },
  options: DeliverabilityOptions = {}
): Promise<StoredDeliverability> {
  const now = options.now ?? new Date();
  const domain = input.domain.trim().toLowerCase();
  if (!input.force) {
    const cached = await readSenderDeliverability(db, workspaceId, domain, input.provider);
    if (cached && Date.parse(cached.expiresAt) > now.getTime()) {
      if (input.markOutreach) {
        await db
          .prepare(
            `UPDATE email_deliverability_checks SET outreach_requested_at=?::timestamptz
             WHERE workspace_id=? AND domain=? AND provider=?`
          )
          .run(now.toISOString(), workspaceId, domain, input.provider);
      }
      return cached;
    }
  }
  const evaluation = await evaluateDeliverability(
    { domain, provider: input.provider },
    options.resolver ?? defaultDnsResolver()
  );
  return storeEvaluation(db, workspaceId, evaluation, now, input.markOutreach === true);
}

/**
 * Worker sweep: prune checks nobody has looked at for 30 days, then re-check
 * expired domains that someone planned outreach from in the last 30 days.
 * Cross-workspace by design (it is the worker); every write is keyed by the
 * row's own workspace_id.
 */
export async function refreshDueEmailDeliverability(
  db: Db,
  options: DeliverabilityOptions = {}
): Promise<{ refreshed: number; pruned: number }> {
  const now = options.now ?? new Date();
  const resolver = options.resolver ?? defaultDnsResolver();
  const pruned = await db
    .prepare('DELETE FROM email_deliverability_checks WHERE checked_at < ?::timestamptz')
    .run(new Date(now.getTime() - PRUNE_AFTER_MS).toISOString());
  const due = await db
    .prepare(
      `SELECT workspace_id,domain,provider FROM email_deliverability_checks
       WHERE expires_at <= ?::timestamptz AND outreach_requested_at >= ?::timestamptz
       ORDER BY expires_at ASC LIMIT ?`
    )
    .all<{ workspace_id: string; domain: string; provider: MailProvider }>(
      now.toISOString(),
      new Date(now.getTime() - OUTREACH_INTENT_WINDOW_MS).toISOString(),
      REFRESH_BATCH
    );
  let refreshed = 0;
  for (const row of due) {
    try {
      const evaluation = await evaluateDeliverability(
        { domain: row.domain, provider: row.provider },
        resolver
      );
      await storeEvaluation(db, row.workspace_id, evaluation, now, false);
      refreshed += 1;
    } catch (error) {
      console.error(
        'Email deliverability refresh failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { refreshed, pruned: pruned.changes };
}
```

- [ ] **Step 5: Implement mailbox identity**

Create `src/server/email/mailbox-address.ts`:

```ts
import { z } from 'zod';
import type { Db } from '../db.js';
import { getNango } from '../integration-service.js';
import { mailProviderFor } from './deliverability.js';
import type { EmailChannelMailbox } from './types.js';

export interface SendingMailbox extends EmailChannelMailbox {
  providerConfigKey: string;
  externalConnectionId: string;
}

interface ConnectionRow {
  id: string;
  provider: string;
  provider_config_key: string;
  external_connection_id: string;
  display_name: string | null;
  mailbox_address: string | null;
}

const addressSchema = z.string().email();

/** Live (non-demo) connected Gmail / Microsoft 365 mailboxes, newest first. */
export async function listSendingMailboxes(db: Db, workspaceId: string): Promise<SendingMailbox[]> {
  const rows = await db
    .prepare(
      `SELECT id,provider,provider_config_key,external_connection_id,display_name,mailbox_address
       FROM connections
       WHERE workspace_id=? AND status='connected' AND is_demo=0
         AND provider IN ('gmail','google-mail','microsoft','outlook')
       ORDER BY updated_at DESC,id ASC`
    )
    .all<ConnectionRow>(workspaceId);
  return rows.flatMap((row) => {
    const providerKey = mailProviderFor(row.provider);
    if (!providerKey) return [];
    return [
      {
        connectionId: row.id,
        provider: row.provider,
        providerKey,
        displayName: row.display_name,
        address: row.mailbox_address,
        providerConfigKey: row.provider_config_key,
        externalConnectionId: row.external_connection_id
      }
    ];
  });
}

/**
 * The address this mailbox actually sends as, read from the provider (Gmail
 * users/me/profile, Graph /me) and cached on the connection. The auth webhook's
 * end_user_email tag is the Trevra user, not the mailbox, so it is never used.
 * Returns null when the provider cannot be asked or answers with no address.
 */
export async function resolveMailboxAddress(
  db: Db,
  workspaceId: string,
  mailbox: SendingMailbox
): Promise<string | null> {
  if (mailbox.address) return mailbox.address;
  let raw = '';
  try {
    const nango = getNango();
    if (mailbox.providerKey === 'google') {
      const profile = await nango.get<{ emailAddress?: string }>({
        endpoint: '/gmail/v1/users/me/profile',
        providerConfigKey: mailbox.providerConfigKey,
        connectionId: mailbox.externalConnectionId,
        retries: 3
      });
      raw = String(profile.data.emailAddress ?? '');
    } else {
      const me = await nango.get<{ mail?: string | null; userPrincipalName?: string | null }>({
        endpoint: '/v1.0/me',
        providerConfigKey: mailbox.providerConfigKey,
        connectionId: mailbox.externalConnectionId,
        retries: 3,
        params: { $select: 'mail,userPrincipalName' }
      });
      raw = String(me.data.mail || me.data.userPrincipalName || '');
    }
  } catch (error) {
    console.error(
      'Could not read the mailbox address from the provider',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
  const parsed = addressSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) return null;
  // An identity cache, not a user-visible change: updated_at stays put so the
  // connection's place in "newest mailbox first" ordering does not move.
  await db
    .prepare('UPDATE connections SET mailbox_address=? WHERE id=? AND workspace_id=?')
    .run(parsed.data, mailbox.connectionId, workspaceId);
  return parsed.data;
}
```

- [ ] **Step 6: Clear the cached address on re-authorization**

In `src/server/integration-service.ts`, replace the auth upsert's conflict clause (~L324-325):

```sql
        ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO UPDATE SET
          provider=excluded.provider,display_name=excluded.display_name,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at
```

with:

```sql
        ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO UPDATE SET
          provider=excluded.provider,display_name=excluded.display_name,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at,
          mailbox_address=NULL
```

The new row's `mailbox_address` is NULL by default, so the INSERT column list does not change.

- [ ] **Step 7: Refresh in the worker**

In `src/worker/index.ts`, add after `import { runDueBrandWatches } from '../server/watch/service.js';`:

```ts
import { refreshDueEmailDeliverability } from '../server/email/sender-deliverability.js';
```

and replace the `Promise.all` in `cycle()`:

```ts
await Promise.all([
  runAllAutomationCycles(db),
  runReadyPlaybooks(db),
  runDueAgentSchedules(db),
  runDueResearchSources(db),
  runDueBrandWatches(db)
]);
```

with:

```ts
await Promise.all([
  runAllAutomationCycles(db),
  runReadyPlaybooks(db),
  runDueAgentSchedules(db),
  runDueResearchSources(db),
  runDueBrandWatches(db),
  refreshDueEmailDeliverability(db)
]);
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/sender-deliverability.test.ts src/server/integration-service.test.ts src/server/email/deliverability.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add vitest.setup.ts src/server/email/sender-deliverability.ts src/server/email/mailbox-address.ts src/server/email/sender-deliverability.test.ts src/server/integration-service.ts src/server/integration-service.test.ts src/worker/index.ts
git commit -m "feat(email): cache sender deliverability and mailbox identity" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 4: Public email origin and unsubscribe tokens

**Files:**

- Create: `src/server/email/public-origin.ts`
- Create: `src/server/email/unsubscribe.ts`
- Modify: `src/server/linkedin/campaign-channels.ts` (imports L1-8, delete `trackingOrigin` L57-77, call site L113)
- Test: `src/server/email/unsubscribe.test.ts`

**Interfaces:**

- Consumes:
  - `gtm_deliveries` (`migrations/108_shared_email_delivery_and_inbound_outcomes.sql`).
  - `email_inbound_mailboxes` (Task 1).
  - `createSuppression` (`src/server/suppressions.ts:140`).
  - `recordCampaignEmailEvent` (`src/server/linkedin/campaign-channels.ts:839`). It is loaded with a dynamic import, because `campaign-channels.ts` imports `integration-service.ts`, which will import this module in Task 5.
- Produces:
  - `publicEmailOrigin(env?)`.
  - `UNSUBSCRIBE_SUBJECT_PATTERN` and `type UnsubscribeSource`.
  - `unsubscribeOrigin(env?)` and `unsubscribeConfigured(env?)`.
  - `unsubscribeToken({ workspaceId, deliveryId, recipient }, env?)`.
  - `listUnsubscribeHeaders({ token, origin, mailbox })`.
  - `outreachUnsubscribeHeaders(db, { workspaceId, deliveryId, recipient }, env?)`.
  - `interface UnsubscribeDelivery` and `findUnsubscribeDelivery(db, token, env?)`.
  - `applyUnsubscribeToken(db, token, { source, workspaceId? }, now?, env?)`.
  - `renderUnsubscribePage(state, token?)`.

- [ ] **Step 1: Write the failing test**

Create `src/server/email/unsubscribe.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { findSuppression } from '../suppressions.js';
import { publicEmailOrigin } from './public-origin.js';
import {
  UNSUBSCRIBE_SUBJECT_PATTERN,
  applyUnsubscribeToken,
  findUnsubscribeDelivery,
  listUnsubscribeHeaders,
  outreachUnsubscribeHeaders,
  renderUnsubscribePage,
  unsubscribeConfigured,
  unsubscribeToken
} from './unsubscribe.js';

const WORKSPACE = 'ws_email_unsubscribe';
const OTHER = 'ws_email_unsubscribe_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const DELIVERY = 'del_0123456789abcdef';
const ENV = {
  NODE_ENV: 'test',
  TREVRA_SECRETS_KEY: 'unsubscribe-test-key-a',
  TREVRA_PUBLIC_API_URL: 'https://api.trevra.test'
} as NodeJS.ProcessEnv;
let db: Db;

async function insertDelivery(input: {
  id: string;
  workspaceId?: string;
  purpose?: string;
  sourceType?: string;
  sourceId?: string;
}) {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,started_at)
       VALUES (?,?,'email',NULL,?,?,?,?,?,'sent',?::timestamptz)`
    )
    .run(
      input.id,
      input.workspaceId ?? WORKSPACE,
      input.purpose ?? 'outreach',
      'Lead@Example.test',
      input.sourceType ?? 'email_action',
      input.sourceId ?? input.id,
      `key-${input.id}`,
      NOW.toISOString()
    );
}

function token(workspaceId = WORKSPACE, deliveryId = DELIVERY, env = ENV): string {
  const value = unsubscribeToken({ workspaceId, deliveryId, recipient: 'lead@example.test' }, env);
  if (!value) throw new Error('token was not minted');
  return value;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await insertDelivery({ id: DELIVERY });
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('unsubscribe tokens', () => {
  it('round-trips a token bound to its workspace, delivery and recipient', async () => {
    const value = token();
    expect(value).toMatch(/^del_0123456789abcdef\.[A-Za-z0-9_-]{43}$/);
    expect(await findUnsubscribeDelivery(db, value, ENV)).toEqual({
      id: DELIVERY,
      workspaceId: WORKSPACE,
      recipient: 'Lead@Example.test',
      sourceType: 'email_action',
      sourceId: DELIVERY
    });
  });

  it('rejects tampered, foreign and non-outreach tokens', async () => {
    const value = token();
    const macStart = DELIVERY.length + 1;
    const flipped = value[macStart] === 'A' ? 'B' : 'A';
    const tampered = `${value.slice(0, macStart)}${flipped}${value.slice(macStart + 1)}`;
    expect(await findUnsubscribeDelivery(db, tampered, ENV)).toBeNull();

    // Same delivery id, MAC minted for another tenant: never verifies against this row.
    expect(await findUnsubscribeDelivery(db, token(OTHER), ENV)).toBeNull();

    await insertDelivery({ id: 'del_00000000000000b2', workspaceId: OTHER });
    expect(
      await findUnsubscribeDelivery(db, token(WORKSPACE, 'del_00000000000000b2'), ENV)
    ).toBeNull();

    await insertDelivery({ id: 'del_00000000000000c3', purpose: 'reply' });
    expect(
      await findUnsubscribeDelivery(db, token(WORKSPACE, 'del_00000000000000c3'), ENV)
    ).toBeNull();

    expect(await findUnsubscribeDelivery(db, 'nope', ENV)).toBeNull();
    expect(await findUnsubscribeDelivery(db, DELIVERY, ENV)).toBeNull();
  });

  it('verifies links minted before a key rotation', async () => {
    const value = token();
    const rotated = {
      ...ENV,
      TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b',
      TREVRA_SECRETS_KEY_PREVIOUS: 'unsubscribe-test-key-a'
    } as NodeJS.ProcessEnv;
    expect((await findUnsubscribeDelivery(db, value, rotated))?.id).toBe(DELIVERY);
    const retired = { ...ENV, TREVRA_SECRETS_KEY: 'unsubscribe-test-key-b' } as NodeJS.ProcessEnv;
    expect(await findUnsubscribeDelivery(db, value, retired)).toBeNull();
  });
});

describe('applying an unsubscribe', () => {
  it('suppresses the recipient from the token alone, once, in the right workspace', async () => {
    const value = token();
    expect(
      await applyUnsubscribeToken(
        db,
        value,
        { source: 'email_mailto_unsubscribe', workspaceId: OTHER },
        NOW,
        ENV
      )
    ).toEqual({ applied: false, workspaceId: null });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toBeNull();

    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV);

    const suppression = await findSuppression(db, WORKSPACE, {
      channel: 'email',
      email: 'lead@example.test'
    });
    expect(suppression).toMatchObject({
      source: 'email_one_click_unsubscribe',
      sourceRef: DELIVERY
    });
    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM suppressions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(count?.total).toBe(1);
  });

  it('still suppresses a campaign delivery whose campaign row is gone', async () => {
    await insertDelivery({
      id: 'del_00000000000000d4',
      sourceType: 'campaign_email',
      sourceId: 'lcca_missing'
    });
    const value = token(WORKSPACE, 'del_00000000000000d4');
    expect(
      await applyUnsubscribeToken(db, value, { source: 'email_one_click_unsubscribe' }, NOW, ENV)
    ).toEqual({ applied: true, workspaceId: WORKSPACE });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).not.toBeNull();
  });
});

describe('RFC 8058 headers', () => {
  it('needs a key and an HTTPS public origin', () => {
    expect(unsubscribeConfigured(ENV)).toBe(true);
    expect(unsubscribeConfigured({ ...ENV, TREVRA_PUBLIC_API_URL: 'http://localhost:43173' })).toBe(
      false
    );
    expect(unsubscribeConfigured({ ...ENV, TREVRA_SECRETS_KEY: '' })).toBe(false);
    expect(
      publicEmailOrigin({
        NODE_ENV: 'production',
        TREVRA_PUBLIC_API_URL: 'http://localhost:3000'
      } as NodeJS.ProcessEnv)
    ).toBeNull();
    expect(
      publicEmailOrigin({
        TREVRA_PUBLIC_API_URL: 'https://api.trevra.test/path'
      } as NodeJS.ProcessEnv)
    ).toBe('https://api.trevra.test');
    expect(
      listUnsubscribeHeaders({ token: 'del_x.y', origin: 'https://api.trevra.test', mailbox: null })
    ).toEqual([
      'List-Unsubscribe: <https://api.trevra.test/u/del_x.y>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ]);
  });

  it('adds a mailto target only while the inbound mailbox is syncing', async () => {
    const input = { workspaceId: WORKSPACE, deliveryId: DELIVERY, recipient: 'lead@example.test' };
    const oneClick = await outreachUnsubscribeHeaders(db, input, ENV);
    expect(oneClick).toEqual([
      `List-Unsubscribe: <https://api.trevra.test/u/${token()}>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ]);

    await db
      .prepare(
        `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_unsub_inbound',?,'gmail','trevra-gmail','gmail-unsub-inbound',NULL,'connected',0,?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
         VALUES (?,'conn_unsub_inbound','inbound@acme.test','starting',?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    expect(await outreachUnsubscribeHeaders(db, input, ENV)).toEqual(oneClick);

    await db
      .prepare("UPDATE email_inbound_mailboxes SET sync_status='syncing' WHERE workspace_id=?")
      .run(WORKSPACE);
    const withMailto = await outreachUnsubscribeHeaders(db, input, ENV);
    expect(withMailto[0]).toBe(
      `List-Unsubscribe: <https://api.trevra.test/u/${token()}>, <mailto:inbound@acme.test?subject=unsubscribe%20${token()}>`
    );
    expect(UNSUBSCRIBE_SUBJECT_PATTERN.exec(`Re: unsubscribe ${token()}`)?.[1]).toBe(token());

    expect(await outreachUnsubscribeHeaders(db, input, { ...ENV, TREVRA_SECRETS_KEY: '' })).toEqual(
      []
    );
  });

  it('renders a confirmation page that a GET cannot act on', () => {
    const value = token();
    const confirm = renderUnsubscribePage('confirm', value);
    expect(confirm).toContain(`<form method="post" action="/u/${value}">`);
    expect(confirm).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(confirm).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(confirm).not.toContain('<script');
    expect(renderUnsubscribePage('invalid')).not.toContain('<form');
    expect(renderUnsubscribePage('confirm', 'not-a-token')).not.toContain('<form');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe.test.ts`
Expected: FAIL with `Cannot find module './public-origin.js'`.

- [ ] **Step 3: Move the public origin out of the campaign module**

Create `src/server/email/public-origin.ts`:

```ts
/**
 * The origin a recipient's mail client can reach. Campaign tracking pixels and
 * click redirects (linkedin/campaign-channels.ts) and RFC 8058 unsubscribe links
 * (email/unsubscribe.ts) all point here. Production requires HTTPS on a
 * non-loopback host. Null means no recipient-reachable origin is configured.
 */
export function publicEmailOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.TREVRA_PUBLIC_API_URL ??
    env.BETTER_AUTH_URL ??
    env.APP_ORIGIN?.split(',')[0]?.trim() ??
    env.PUBLIC_SITE_URL ??
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (
      env.NODE_ENV === 'production' &&
      (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
```

In `src/server/linkedin/campaign-channels.ts`:

- Delete the whole `function trackingOrigin(env: NodeJS.ProcessEnv = process.env): string | null { ... }` block (L57-77).
- Add `import { publicEmailOrigin } from '../email/public-origin.js';` after `import { delayMilliseconds } from './workflows.js';`.
- In `trackedHtmlBody`, replace `const origin = trackingOrigin();` with `const origin = publicEmailOrigin();`.

- [ ] **Step 4: Implement tokens, headers and the page**

Create `src/server/email/unsubscribe.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import { createSuppression } from '../suppressions.js';
import { publicEmailOrigin } from './public-origin.js';

/*
 * RFC 8058 one-click unsubscribe for outreach email.
 *
 * A token is `<gtm_deliveries.id>.<mac>`. The HMAC binds workspace, delivery
 * and recipient, so a token can never be redeemed against another tenant's row
 * or another recipient. The key is derived from TREVRA_SECRETS_KEY, so there is
 * no new secret to store. TREVRA_SECRETS_KEY_PREVIOUS keeps links in sent mail
 * working through a rotation.
 *
 * This module must not import integration-service.ts: integration-service
 * imports it to stamp the headers onto outgoing mail.
 */
// lc-debt: completing a TREVRA_SECRETS_KEY rotation (removing _PREVIOUS) retires the one-click links in mail already sent; upgrade path: a dedicated long-lived unsubscribe key with its own previous-key list.

const KEY_INFO = 'trevra-email-unsubscribe-v1';
const DELIVERY_ID_PATTERN = /^del_[0-9a-f]{16}$/;
const TOKEN_PATTERN = /^(del_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

/** Finds a Trevra unsubscribe token in a mailto subject, wherever the client put it. */
export const UNSUBSCRIBE_SUBJECT_PATTERN =
  /\bunsubscribe\s+(del_[0-9a-f]{16}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i;

export type UnsubscribeSource = 'email_one_click_unsubscribe' | 'email_mailto_unsubscribe';

function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_INFO).digest();
}

function unsubscribeKeys(env: NodeJS.ProcessEnv): Buffer[] {
  return [env.TREVRA_SECRETS_KEY, env.TREVRA_SECRETS_KEY_PREVIOUS]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .map(deriveKey);
}

function tokenMac(key: Buffer, workspaceId: string, deliveryId: string, recipient: string): string {
  return createHmac('sha256', key)
    .update(`v1:${workspaceId}:${deliveryId}:${recipient.trim().toLowerCase()}`)
    .digest('base64url');
}

/** RFC 8058 requires the one-click target to be HTTPS. */
export function unsubscribeOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const origin = publicEmailOrigin(env);
  return origin?.startsWith('https://') ? origin : null;
}

export function unsubscribeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TREVRA_SECRETS_KEY?.trim()) && unsubscribeOrigin(env) !== null;
}

export function unsubscribeToken(
  input: { workspaceId: string; deliveryId: string; recipient: string },
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const secret = env.TREVRA_SECRETS_KEY?.trim();
  if (!secret || !DELIVERY_ID_PATTERN.test(input.deliveryId)) return null;
  return `${input.deliveryId}.${tokenMac(deriveKey(secret), input.workspaceId, input.deliveryId, input.recipient)}`;
}

export function listUnsubscribeHeaders(input: {
  token: string;
  origin: string;
  mailbox: string | null;
}): string[] {
  const targets = [`<${input.origin}/u/${input.token}>`];
  if (input.mailbox) {
    targets.push(
      `<mailto:${input.mailbox}?subject=${encodeURIComponent(`unsubscribe ${input.token}`)}>`
    );
  }
  return [
    `List-Unsubscribe: ${targets.join(', ')}`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
  ];
}

/**
 * Headers for one outreach delivery, or [] when unsubscribe is not configured.
 * The mailto target is offered only while the designated inbound mailbox is
 * really being read; otherwise a mailto unsubscribe would land in an inbox
 * nothing processes.
 */
export async function outreachUnsubscribeHeaders(
  db: Db,
  input: { workspaceId: string; deliveryId: string; recipient: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const origin = unsubscribeOrigin(env);
  const token = origin ? unsubscribeToken(input, env) : null;
  if (!origin || !token) return [];
  const inbound = await db
    .prepare(
      `SELECT m.address FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=? AND m.sync_status='syncing' AND c.status='connected'`
    )
    .get<{ address: string }>(input.workspaceId);
  return listUnsubscribeHeaders({ token, origin, mailbox: inbound?.address ?? null });
}

export interface UnsubscribeDelivery {
  id: string;
  workspaceId: string;
  recipient: string;
  sourceType: string;
  sourceId: string;
}

export async function findUnsubscribeDelivery(
  db: Db,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<UnsubscribeDelivery | null> {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  const deliveryId = match[1]!;
  const presented = Buffer.from(match[2]!, 'utf8');
  // Deliberately not scoped by workspace: the token is the only tenant evidence
  // a recipient's mail client carries. The HMAC check below binds this row's
  // own workspace, id and recipient, so a valid token cannot name another
  // tenant's delivery.
  const row = await db
    .prepare(
      `SELECT id,workspace_id,recipient,source_type,source_id FROM gtm_deliveries
       WHERE id=? AND channel='email' AND purpose='outreach'`
    )
    .get<{
      id: string;
      workspace_id: string;
      recipient: string;
      source_type: string;
      source_id: string;
    }>(deliveryId);
  if (!row) return null;
  for (const key of unsubscribeKeys(env)) {
    const expected = Buffer.from(tokenMac(key, row.workspace_id, row.id, row.recipient), 'utf8');
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        recipient: row.recipient,
        sourceType: row.source_type,
        sourceId: row.source_id
      };
    }
  }
  return null;
}

/**
 * Suppress the delivery's recipient for email in the delivery's workspace.
 * `workspaceId`, when given (the mailto path knows which inbox received the
 * request), must match the token's workspace or nothing happens. Repeating it
 * is harmless: suppressions and campaign events are idempotent.
 */
export async function applyUnsubscribeToken(
  db: Db,
  token: string,
  input: { source: UnsubscribeSource; workspaceId?: string },
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<{ applied: boolean; workspaceId: string | null }> {
  const delivery = await findUnsubscribeDelivery(db, token, env);
  if (!delivery) return { applied: false, workspaceId: null };
  if (input.workspaceId && input.workspaceId !== delivery.workspaceId) {
    return { applied: false, workspaceId: null };
  }
  await createSuppression(
    db,
    {
      workspaceId: delivery.workspaceId,
      channel: 'email',
      email: delivery.recipient,
      reason: 'Recipient unsubscribed from email',
      source: input.source,
      sourceRef: delivery.id,
      actorType: 'system'
    },
    now
  );
  if (delivery.sourceType === 'campaign_email') {
    // Dynamic: campaign-channels imports integration-service, which imports this module.
    const { recordCampaignEmailEvent } = await import('../linkedin/campaign-channels.js');
    await recordCampaignEmailEvent(
      db,
      delivery.workspaceId,
      {
        channelActionId: delivery.sourceId,
        eventKind: 'unsubscribe',
        providerEventId: `unsubscribe:${delivery.id}`,
        metadata: { source: input.source }
      },
      now
    );
  }
  return { applied: true, workspaceId: delivery.workspaceId };
}

export type UnsubscribePageState = 'confirm' | 'done' | 'invalid' | 'error';

const PAGE_COPY: Record<UnsubscribePageState, { title: string; body: string }> = {
  confirm: {
    title: 'Unsubscribe from these emails',
    body: 'Confirm, and this address will not receive further outreach email from this sender.'
  },
  done: {
    title: 'You are unsubscribed',
    body: 'This address will not receive further outreach email from this sender. You can close this page.'
  },
  invalid: {
    title: 'This unsubscribe link is not valid',
    body: 'It may have been copied incompletely. Reply to the email with the word "unsubscribe" and the sender will stop.'
  },
  error: {
    title: 'Your request was not recorded',
    body: 'Something went wrong on our side. Please try again in a minute.'
  }
};

/**
 * A page with no script, so a link scanner that fetches it can do nothing. Only
 * the explicit POST (the button, or a mail client's RFC 8058 one-click POST)
 * unsubscribes.
 */
export function renderUnsubscribePage(state: UnsubscribePageState, token?: string): string {
  const copy = PAGE_COPY[state];
  const form =
    state === 'confirm' && token && TOKEN_PATTERN.test(token)
      ? `<form method="post" action="/u/${token}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`
      : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${copy.title}</title>`,
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}',
    'main{max-width:32rem;margin:15vh auto 0;padding:0 16px}',
    'h1{font-size:1.375rem;line-height:1.3;margin:0 0 .5rem}',
    'p{margin:0 0 1.25rem}',
    'button{min-height:44px;padding:0 1.25rem;font:inherit;border-radius:6px;border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer}',
    'button:focus-visible{outline:2px solid Highlight;outline-offset:2px}',
    '</style></head>',
    `<body><main><h1>${copy.title}</h1><p>${copy.body}</p>${form}</main></body></html>`
  ].join('\n');
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe.test.ts src/server/linkedin/campaign-channels.test.ts`
Expected: PASS. The campaign-channels suite still passes, because its tracking origin is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/email/public-origin.ts src/server/email/unsubscribe.ts src/server/email/unsubscribe.test.ts src/server/linkedin/campaign-channels.ts
git commit -m "feat(email): sign RFC 8058 unsubscribe tokens" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 5: Stamp unsubscribe headers on outreach sends

**Files:**

- Modify: `src/server/integration-service.ts`:
  - imports (L1-21);
  - `executeConnectedAction` (L503-735);
  - `createMimeMessage` (L1382-1429).
- Test: `src/server/integration-service.test.ts`

**Interfaces:**

- Consumes: `outreachUnsubscribeHeaders` (Task 4); `claimEmailDelivery`'s stable `del_` id (`src/server/email-deliveries.ts:68`); `markEmailDeliveryFailure` / `definiteEmailFailure` (a 4xx `status` means a definite failure, so the delivery stays retryable).
- Produces:
  - `export function buildMimeMessage(input: { recipient; subject; body; idempotencyKey; inReplyTo?; htmlBody?; extraHeaders? }): string`. It returns raw MIME text, and throws `{ status: 400 }` on CR/LF in any header value. It replaces the private `createMimeMessage`.
  - The structured payload flag `requireListUnsubscribe: true`. When unsubscribe headers cannot be produced, the send refuses with 409 before any provider call.
  - Microsoft outreach is sent as MIME whenever unsubscribe headers exist. Graph's JSON API accepts only `x-` custom headers.

- [ ] **Step 1: Write the failing tests**

In `src/server/integration-service.test.ts`:

- Add `buildMimeMessage` to the destructured `await import('./integration-service.js')` list.
- Add after `const { createSuppression } = await import('./suppressions.js');`:

```ts
const { findUnsubscribeDelivery } = await import('./email/unsubscribe.js');
```

- Make `vi.unstubAllEnvs();` the first statement of the top-level `afterEach`.
- Insert the following tests inside `describe('connected mailbox threading', ...)`, immediately after the test `'threads Microsoft follow-ups through Graph reply drafts'`:

```ts
it('adds RFC 8058 one-click unsubscribe headers to Gmail outreach', async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  const { database, workspaceId, connectionId } = await mailbox('gmail');
  nangoMock.post.mockResolvedValueOnce({ data: { id: 'gmail-outreach' }, headers: {} });
  await executeConnectedAction(database, workspaceId, {
    type: 'email_draft',
    connection_id: connectionId,
    recipient: 'lead@example.test',
    subject: 'Hello',
    body: 'Hi there',
    structured_payload_json: '{}',
    payload_hash: 'outreach-unsubscribe-key'
  });
  const send = nangoMock.post.mock.calls[0]?.[0] as { data?: { raw?: string } };
  const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
  const token = /List-Unsubscribe: <https:\/\/api\.trevra\.test\/u\/([^>]+)>/.exec(mime)?.[1];
  expect(token).toBeTruthy();
  expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  expect(mime.indexOf('List-Unsubscribe:')).toBeLessThan(mime.indexOf('MIME-Version: 1.0'));
  expect(await findUnsubscribeDelivery(database, token!)).toMatchObject({
    workspaceId,
    recipient: 'lead@example.test'
  });
});

it('keeps unsubscribe headers out of conversation replies', async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  const { database, workspaceId, connectionId } = await mailbox('gmail');
  nangoMock.post.mockResolvedValueOnce({ data: { id: 'gmail-reply-only' }, headers: {} });
  await executeConnectedAction(database, workspaceId, {
    type: 'email_draft',
    connection_id: connectionId,
    recipient: 'lead@example.test',
    subject: 'Re: Hello',
    body: 'Thanks!',
    structured_payload_json: JSON.stringify({ deliveryPurpose: 'reply' }),
    payload_hash: 'reply-no-unsubscribe-key'
  });
  const send = nangoMock.post.mock.calls[0]?.[0] as { data?: { raw?: string } };
  const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
  expect(mime).not.toContain('List-Unsubscribe');
});

it('sends Microsoft outreach as MIME so the unsubscribe headers survive', async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  const { database, workspaceId, connectionId } = await mailbox('microsoft');
  nangoMock.post
    .mockResolvedValueOnce({
      data: { id: 'ms-mime-first', internetMessageId: '<first@outlook.test>' },
      headers: {}
    })
    .mockResolvedValueOnce({ data: {}, headers: {} })
    .mockResolvedValueOnce({ data: { id: 'ms-mime-second' }, headers: {} })
    .mockResolvedValueOnce({ data: {}, headers: {} });

  await executeConnectedAction(database, workspaceId, {
    type: 'email_draft',
    connection_id: connectionId,
    recipient: 'lead@example.test',
    subject: 'Same subject',
    body: 'First body',
    structured_payload_json: JSON.stringify({ threaded: true }),
    payload_hash: 'ms-mime-first-key'
  });
  const draft = nangoMock.post.mock.calls[0]?.[0] as {
    endpoint?: string;
    headers?: Record<string, string>;
    data?: unknown;
  };
  expect(draft.endpoint).toBe('/v1.0/me/messages');
  expect(draft.headers).toEqual({ 'Content-Type': 'text/plain' });
  const mime = Buffer.from(String(draft.data), 'base64').toString('utf8');
  expect(mime).toContain('List-Unsubscribe: <https://api.trevra.test/u/del_');
  expect(nangoMock.post.mock.calls[1]?.[0]).toMatchObject({
    endpoint: '/v1.0/me/messages/ms-mime-first/send'
  });

  await executeConnectedAction(database, workspaceId, {
    type: 'email_draft',
    connection_id: connectionId,
    recipient: 'lead@example.test',
    subject: 'Same subject',
    body: 'Second body',
    structured_payload_json: JSON.stringify({
      threaded: true,
      threadExternalRef: 'ms-mime-first',
      threadIdempotencyKey: 'ms-mime-first-key'
    }),
    payload_hash: 'ms-mime-second-key'
  });
  const followUp = nangoMock.post.mock.calls[2]?.[0] as { endpoint?: string; data?: unknown };
  expect(followUp.endpoint).toBe('/v1.0/me/messages');
  expect(Buffer.from(String(followUp.data), 'base64').toString('utf8')).toContain(
    'In-Reply-To: <first@outlook.test>'
  );
});

it('refuses an email approved with unsubscribe when unsubscribe is not configured', async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', '');
  const { database, workspaceId, connectionId } = await mailbox('gmail');
  await expect(
    executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Hello',
      body: 'Hi',
      structured_payload_json: JSON.stringify({ requireListUnsubscribe: true }),
      payload_hash: 'require-unsubscribe-key'
    })
  ).rejects.toMatchObject({ status: 409 });
  expect(nangoMock.post).not.toHaveBeenCalled();
  const row = await database
    .prepare('SELECT status FROM gtm_deliveries WHERE workspace_id=? AND idempotency_key=?')
    .get<{ status: string }>(workspaceId, 'require-unsubscribe-key');
  expect(row?.status).toBe('failed');
});

it('rejects header injection before contacting the provider', async () => {
  expect(() =>
    buildMimeMessage({
      recipient: 'lead@example.test\r\nBcc: spy@example.test',
      subject: 'x',
      body: 'y',
      idempotencyKey: 'k'
    })
  ).toThrow(/line breaks/);
  const { database, workspaceId, connectionId } = await mailbox('gmail');
  await expect(
    executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test\nBcc: spy@example.test',
      subject: 'Hello',
      body: 'Hi',
      structured_payload_json: '{}',
      payload_hash: 'injection-key'
    })
  ).rejects.toMatchObject({ status: 400 });
  expect(nangoMock.post).not.toHaveBeenCalled();
  const row = await database
    .prepare('SELECT status FROM gtm_deliveries WHERE workspace_id=? AND idempotency_key=?')
    .get<{ status: string }>(workspaceId, 'injection-key');
  expect(row?.status).toBe('failed');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/integration-service.test.ts`
Expected: FAIL. `buildMimeMessage` is not a function, and no `List-Unsubscribe` header is present.

- [ ] **Step 3: Replace `createMimeMessage` with `buildMimeMessage`**

In `src/server/integration-service.ts`, replace the whole `function createMimeMessage(...) { ... }` (L1382-1429) with:

```ts
/**
 * One RFC 5322 message as raw MIME text: Gmail wants it base64url, Graph's MIME
 * send wants standard base64. Header values are checked for CR/LF so a
 * recipient or extra header can never smuggle in another header; the 400 makes
 * that a definite failure (no provider call happened).
 */
export function buildMimeMessage(input: {
  recipient: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  inReplyTo?: string | null;
  htmlBody?: string | null;
  extraHeaders?: string[];
}): string {
  const extraHeaders = input.extraHeaders ?? [];
  if (
    [input.recipient, input.idempotencyKey, input.inReplyTo ?? '', ...extraHeaders].some((value) =>
      /[\r\n]/.test(value)
    )
  ) {
    throw Object.assign(new Error('Email header values cannot contain line breaks.'), {
      status: 400
    });
  }
  const encodedSubject = `=?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`;
  const headers = [
    `To: ${input.recipient}`,
    `Subject: ${encodedSubject}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    `Message-ID: <${input.idempotencyKey}@trevra.app>`,
    `X-Trevra-Idempotency-Key: ${input.idempotencyKey}`,
    ...extraHeaders,
    'MIME-Version: 1.0'
  ];
  if (input.htmlBody) {
    const boundary = `trevra-${sha(input.idempotencyKey).slice(0, 24)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.htmlBody,
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }
  return [
    ...headers,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body
  ].join('\r\n');
}
```

- [ ] **Step 4: Compute the headers once per delivery**

Add to the imports of `src/server/integration-service.ts`, after the `./email-outcomes.js` import:

```ts
import { outreachUnsubscribeHeaders } from './email/unsubscribe.js';
```

Inside `executeConnectedAction`, find the `const nango = getNango();` line that directly precedes `const threadExternalRef =` (~L611). Insert this block immediately before it, after the demo branch:

```ts
// RFC 8058 one-click unsubscribe on every outreach email. The token is bound
// to this delivery's stable id, so a retry of a failed delivery carries the
// same link. Anything going wrong here happens before any provider call, so it
// is reported as a definite (4xx) failure and the delivery stays retryable.
let unsubscribeHeaders: string[] = [];
if (purpose === 'outreach') {
  try {
    unsubscribeHeaders = await outreachUnsubscribeHeaders(db, {
      workspaceId,
      deliveryId,
      recipient
    });
  } catch (error) {
    const wrapped = Object.assign(
      new Error(
        `Unsubscribe headers could not be prepared: ${error instanceof Error ? error.message : String(error)}`
      ),
      { status: 400 }
    );
    await markEmailDeliveryFailure(db, deliveryId, wrapped);
    throw wrapped;
  }
}
if (structuredPayload.requireListUnsubscribe === true && unsubscribeHeaders.length === 0) {
  const error = Object.assign(
    new Error(
      'This email was approved with a one-click unsubscribe link, but this deployment has no HTTPS public origin (TREVRA_PUBLIC_API_URL) or TREVRA_SECRETS_KEY; nothing was sent.'
    ),
    { status: 409 }
  );
  await markEmailDeliveryFailure(db, deliveryId, error);
  throw error;
}
```

- [ ] **Step 5: Send Microsoft outreach as MIME when headers exist**

In the provider `try`, replace:

```ts
    if (provider === 'microsoft' || provider === 'outlook') {
      if (threadExternalRef) {
```

with:

```ts
    if (provider === 'microsoft' || provider === 'outlook') {
      if (unsubscribeHeaders.length > 0) {
        // Graph's JSON message API accepts only x- custom headers, so the RFC
        // 8058 List-Unsubscribe headers need Graph's MIME send. A follow-up
        // threads by In-Reply-To/References to the prior delivery's recorded
        // Message-ID instead of createReply.
        let inReplyTo: string | null = null;
        if (threadIdempotencyKey) {
          const prior = await db
            .prepare(
              'SELECT internet_message_id FROM gtm_deliveries WHERE workspace_id=? AND idempotency_key=?'
            )
            .get<{ internet_message_id: string | null }>(workspaceId, threadIdempotencyKey);
          inReplyTo = prior?.internet_message_id?.trim() || `<${threadIdempotencyKey}@trevra.app>`;
        }
        const mime = buildMimeMessage({
          recipient,
          subject: String(action.subject),
          body: String(action.body),
          idempotencyKey,
          inReplyTo,
          htmlBody: htmlBody || null,
          extraHeaders: unsubscribeHeaders
        });
        const mimeDraft = await nango.post<{ id?: string; internetMessageId?: string }>({
          endpoint: '/v1.0/me/messages',
          providerConfigKey,
          connectionId,
          retries: 0,
          headers: { 'Content-Type': 'text/plain' },
          data: Buffer.from(mime).toString('base64')
        });
        const mimeDraftId = String(mimeDraft.data.id ?? '').trim();
        if (!mimeDraftId) throw new Error('Microsoft MIME draft returned no message id.');
        await nango.post({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(mimeDraftId)}/send`,
          providerConfigKey,
          connectionId,
          retries: 0
        });
        const outcome = {
          provider: 'microsoft',
          externalRef: mimeDraftId,
          internetMessageId: mimeDraft.data.internetMessageId ?? `<${idempotencyKey}@trevra.app>`
        };
        await markEmailDeliverySent(db, deliveryId, outcome);
        return { provider: outcome.provider, externalRef: outcome.externalRef };
      }
      if (threadExternalRef) {
```

- [ ] **Step 6: Pass the headers to Gmail**

Replace:

```ts
const raw = createMimeMessage(
  String(action.recipient),
  String(action.subject),
  String(action.body),
  String(action.payload_hash),
  threadIdempotencyKey || null,
  htmlBody || null
);
```

with:

```ts
const raw = Buffer.from(
  buildMimeMessage({
    recipient,
    subject: String(action.subject),
    body: String(action.body),
    idempotencyKey,
    inReplyTo: threadIdempotencyKey ? `<${threadIdempotencyKey}@trevra.app>` : null,
    htmlBody: htmlBody || null,
    extraHeaders: unsubscribeHeaders
  })
).toString('base64url');
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/integration-service.test.ts src/server/linkedin/campaign-channels.test.ts src/server/control-plane`
Expected: PASS. The existing Gmail and Microsoft threading tests are unchanged. `scripts/test-with-postgres.ts` sets `BETTER_AUTH_URL=http://localhost:43173`, and that is not HTTPS, so no headers are added unless a test stubs an HTTPS `TREVRA_PUBLIC_API_URL`.

- [ ] **Step 8: Commit**

```bash
git add src/server/integration-service.ts src/server/integration-service.test.ts
git commit -m "feat(email): add one-click unsubscribe headers to outreach sends" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 6: Public `/u/:token` unsubscribe routes

**Files:**

- Modify: `src/server/app.ts`. The imports go near the other email imports. The routes go after the `/t/e/:token/c/:linkToken` route (~L657) and before `app.post('/api/webhooks/nango', ...)`.
- Test: `src/server/email/unsubscribe-routes.test.ts`

**Interfaces:**

- Consumes: `findUnsubscribeDelivery`, `applyUnsubscribeToken`, `renderUnsubscribePage` (Task 4); `rateLimit` (already imported in `app.ts` L9).
- Produces:
  - `GET /u/:token`: 200 confirmation page or 404. It never writes.
  - `POST /u/:token`: 200 "unsubscribed", 404 invalid, or 500. It accepts any body up to 8 kB; RFC 8058 clients send `List-Unsubscribe=One-Click`.

- [ ] **Step 1: Write the failing test**

Create `src/server/email/unsubscribe-routes.test.ts`:

```ts
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { unsubscribeToken } from './unsubscribe.js';

const WORKSPACE = 'ws_email_unsubscribe_routes';
const DELIVERY = 'del_00000000000000e5';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;
let app: Express;

function token(): string {
  const value = unsubscribeToken({
    workspaceId: WORKSPACE,
    deliveryId: DELIVERY,
    recipient: 'lead@example.test'
  });
  if (!value) throw new Error('TREVRA_SECRETS_KEY is not set for tests');
  return value;
}

async function suppressionCount(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM suppressions WHERE workspace_id=?')
    .get<{ total: number }>(WORKSPACE);
  return Number(row?.total ?? 0);
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

beforeEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Unsubscribe routes', NOW);
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,started_at)
       VALUES (?,?,'email',NULL,'outreach','lead@example.test','email_action',?,?,'sent',?::timestamptz)`
    )
    .run(DELIVERY, WORKSPACE, DELIVERY, `key-${DELIVERY}`, NOW);
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
  await closeAuthDatabase();
});

describe('/u/:token', () => {
  it('renders a confirmation on GET and never unsubscribes', async () => {
    const response = await request(app).get(`/u/${token()}`).expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.text).toContain(`<form method="post" action="/u/${token()}">`);
    await request(app).get(`/u/${token()}`).expect(200);
    expect(await suppressionCount()).toBe(0);
  });

  it('unsubscribes on an RFC 8058 one-click POST', async () => {
    const response = await request(app)
      .post(`/u/${token()}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click')
      .expect(200);
    expect(response.text).toContain('You are unsubscribed');
    expect(await suppressionCount()).toBe(1);
    await request(app).post(`/u/${token()}`).send('List-Unsubscribe=One-Click').expect(200);
    expect(await suppressionCount()).toBe(1);
  });

  it('answers 404 to a forged token on both methods', async () => {
    const forged = `${DELIVERY}.${'A'.repeat(43)}`;
    await request(app).get(`/u/${forged}`).expect(404);
    await request(app).post(`/u/${forged}`).send('List-Unsubscribe=One-Click').expect(404);
    await request(app).get('/u/not-a-token').expect(404);
    expect(await suppressionCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe-routes.test.ts`
Expected: FAIL. The GET returns 404 or the SPA fallback instead of the confirmation page.

- [ ] **Step 3: Register the routes**

In `src/server/app.ts`, add to the imports:

```ts
import {
  applyUnsubscribeToken,
  findUnsubscribeDelivery,
  renderUnsubscribePage
} from './email/unsubscribe.js';
```

Insert after the closing `});` of `app.get('/t/e/:token/c/:linkToken', ...)` and before `app.post(\n    '/api/webhooks/nango',`:

```ts
// RFC 8058 one-click unsubscribe. GET only renders a confirmation page: mail
// security scanners fetch every link in a message, and a GET that
// unsubscribed would let a scanner opt the recipient out. Only POST -- the
// page's button or a mail client's one-click POST -- suppresses.
const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const unsubscribePageHeaders = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html');
};
app.get('/u/:token', unsubscribeLimiter, async (req, res) => {
  unsubscribePageHeaders(res);
  const token = String(req.params.token);
  try {
    const delivery = await findUnsubscribeDelivery(db, token);
    res
      .status(delivery ? 200 : 404)
      .send(renderUnsubscribePage(delivery ? 'confirm' : 'invalid', token));
  } catch (error) {
    console.error(
      'Unsubscribe page failed',
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).send(renderUnsubscribePage('error'));
  }
});
app.post(
  '/u/:token',
  unsubscribeLimiter,
  express.raw({ type: () => true, limit: '8kb' }),
  async (req, res) => {
    unsubscribePageHeaders(res);
    try {
      const result = await applyUnsubscribeToken(db, String(req.params.token), {
        source: 'email_one_click_unsubscribe'
      });
      res
        .status(result.applied ? 200 : 404)
        .send(renderUnsubscribePage(result.applied ? 'done' : 'invalid'));
    } catch (error) {
      console.error(
        'One-click unsubscribe failed',
        error instanceof Error ? error.message : String(error)
      );
      res.status(500).send(renderUnsubscribePage('error'));
    }
  }
);
```

No client route is added. This is a server-rendered public page outside the app shell, so `APP_PATH_PATTERNS` and `src/client/ui/route.ts` stay as they are.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe-routes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/email/unsubscribe-routes.test.ts
git commit -m "feat(email): serve the one-click unsubscribe endpoint" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 7: Inbound mailbox records become Conversations, strangers never do

**Files:**

- Create: `src/server/email/inbound-mailbox.ts`
- Modify: `src/server/integration-service.ts`:
  - the `canonicalRecordSchema` message variant (L24-35);
  - `ingestCanonicalRecord` (L1062);
  - a new private `ingestInboundMailboxMessage`.
- Modify: `src/server/conversations.ts`: `projectCanonicalMessage` (L255-314) and its imports.
- Test: `src/server/email/inbound-mailbox.test.ts`

**Interfaces:**

- Consumes:
  - `email_inbound_mailboxes` (Task 1).
  - `applyUnsubscribeToken` and `UNSUBSCRIBE_SUBJECT_PATTERN` (Task 4).
  - `classifyVerifiedInboundEmail` (`src/server/email-outcomes.ts:36`).
  - `createSuppression`.
  - `accountForPerson` (`src/server/person-identities.ts:104`).
  - `gtm_deliveries.internet_message_id`.
- Produces:
  - `interface InboundMailboxRecord`.
  - `type InboundMailboxDecision`.
  - `decideInboundMailboxRecord(db, workspaceId, connectionId, record, now?)`.
  - Canonical message fields: `mailboxAddress`, `internetMessageId`, `replyToMessageIds`, `autoSubmitted`.
  - `projectCanonicalMessage(db, workspaceId, messageId, now?, { sourceType?, outcomeKind? })`.
  - Conversation messages with `source_type='inbound_mailbox_message'`.
  - Suppressions with the sources `email_mailto_unsubscribe` and `email_reply_unsubscribe`.

- [ ] **Step 1: Write the failing test**

Create `src/server/email/inbound-mailbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord, type CanonicalRecord } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { findSuppression } from '../suppressions.js';
import { unsubscribeToken } from './unsubscribe.js';

const WORKSPACE = 'ws_email_inbound_mailbox';
const OTHER = 'ws_email_inbound_mailbox_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let personId = '';

function message(overrides: Partial<Extract<CanonicalRecord, { kind: 'message' }>> = {}) {
  return {
    kind: 'message' as const,
    id: 'gmail-msg-1',
    personEmail: 'Lead@Example.test',
    personName: 'Lead Person',
    direction: 'inbound' as const,
    subject: 'Question about pricing',
    body: 'Can we talk on Friday?',
    occurredAt: '2026-10-06T08:30:00.000Z',
    externalUrl: 'https://mail.google.com/mail/u/0/#all/gmail-msg-1',
    mailboxAddress: 'inbound@acme.test',
    ...overrides
  };
}

async function countFor(table: string, workspaceId = WORKSPACE): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE workspace_id=?`)
    .get<{ total: number }>(workspaceId);
  return Number(row?.total ?? 0);
}

async function insertConnection(connectionId: string, workspaceId = WORKSPACE) {
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?)`
    )
    .run(
      connectionId,
      workspaceId,
      `${connectionId}-external`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function insertDelivery(input: {
  id: string;
  workspaceId?: string;
  sourceType?: string;
  internetMessageId?: string;
}) {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,internet_message_id,started_at)
       VALUES (?,?,'email',NULL,'outreach','lead@example.test',?,?,?,'sent',?,?::timestamptz)`
    )
    .run(
      input.id,
      input.workspaceId ?? WORKSPACE,
      input.sourceType ?? 'email_action',
      input.id,
      `key-${input.id}`,
      input.internetMessageId ?? null,
      NOW.toISOString()
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
  await insertConnection('conn_inbound');
  await insertConnection('conn_other');
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,'conn_inbound','inbound@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  personId = (
    await resolveContact(db, WORKSPACE, { name: 'Lead Person', email: 'lead@example.test' }, NOW)
  ).contact.id;
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('inbound mailbox ingestion', () => {
  it("stores a known Person's email as an inbound conversation message", async () => {
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', message());
    const row = await db
      .prepare(
        `SELECT cm.source_type,cm.outcome_kind,cm.direction,cm.external_ref,c.person_id
         FROM conversation_messages cm JOIN conversations c ON c.id=cm.conversation_id
         WHERE cm.workspace_id=?`
      )
      .get<Record<string, unknown>>(WORKSPACE);
    expect(row).toEqual({
      source_type: 'inbound_mailbox_message',
      outcome_kind: 'reply',
      direction: 'inbound',
      external_ref: 'gmail-msg-1',
      person_id: personId
    });
    const mailbox = await db
      .prepare('SELECT last_record_at FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get<{ last_record_at: string | null }>(WORKSPACE);
    expect(mailbox?.last_record_at).not.toBeNull();
  });

  it('drops strangers without writing a single row', async () => {
    const contactsBefore = await countFor('contacts');
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-stranger', personEmail: 'stranger@elsewhere.test' })
    );
    expect(await countFor('source_records')).toBe(0);
    expect(await countFor('messages')).toBe(0);
    expect(await countFor('conversation_messages')).toBe(0);
    expect(await countFor('contacts')).toBe(contactsBefore);
  });

  it('ignores records from another connection, another address or a disconnected mailbox', async () => {
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_other', message({ id: 'gmail-a' }));
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-b', mailboxAddress: 'someone-else@acme.test' })
    );
    await db.prepare("UPDATE connections SET status='disconnected' WHERE id='conn_inbound'").run();
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', message({ id: 'gmail-c' }));
    expect(await countFor('source_records')).toBe(0);
    expect(await countFor('conversation_messages')).toBe(0);
  });

  it("applies a mailto unsubscribe only for this workspace's own deliveries", async () => {
    await insertDelivery({ id: 'del_00000000000000f6', workspaceId: OTHER });
    const foreign = unsubscribeToken({
      workspaceId: OTHER,
      deliveryId: 'del_00000000000000f6',
      recipient: 'lead@example.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-unsub-foreign', subject: `unsubscribe ${foreign}`, body: '' })
    );
    expect(
      await findSuppression(db, OTHER, { channel: 'email', email: 'lead@example.test' })
    ).toBeNull();

    await insertDelivery({ id: 'del_00000000000000f7' });
    const own = unsubscribeToken({
      workspaceId: WORKSPACE,
      deliveryId: 'del_00000000000000f7',
      recipient: 'lead@example.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-unsub-own',
        personEmail: 'alias-of-lead@example.test',
        subject: `unsubscribe ${own}`,
        body: ''
      })
    );
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toMatchObject({ source: 'email_mailto_unsubscribe', sourceRef: 'del_00000000000000f7' });
    expect(await countFor('conversation_messages')).toBe(0);
  });

  it('leaves campaign threads to the campaign poller and honours a threaded unsubscribe reply', async () => {
    await insertDelivery({
      id: 'del_00000000000000a8',
      sourceType: 'campaign_email',
      internetMessageId: '<campaign@trevra.app>'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-campaign-reply', replyToMessageIds: ['<campaign@trevra.app>'] })
    );
    expect(await countFor('conversation_messages')).toBe(0);

    await insertDelivery({
      id: 'del_00000000000000a9',
      internetMessageId: '<outreach@trevra.app>'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({
        id: 'gmail-stop',
        subject: 'Re: Quick question',
        body: 'Please remove me from your list.',
        replyToMessageIds: ['<outreach@trevra.app>']
      })
    );
    const row = await db
      .prepare('SELECT outcome_kind FROM conversation_messages WHERE workspace_id=?')
      .get<{ outcome_kind: string }>(WORKSPACE);
    expect(row?.outcome_kind).toBe('unsubscribe');
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'lead@example.test' })
    ).toMatchObject({ source: 'email_reply_unsubscribe', sourceRef: 'gmail-stop' });
  });

  it('does not project a message twice when the legacy sync already stored it', async () => {
    const { mailboxAddress: _omit, ...legacy } = message({ id: 'gmail-dup' });
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', 'conn_inbound', legacy);
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'gmail',
      'conn_inbound',
      message({ id: 'gmail-dup' })
    );
    const rows = await db
      .prepare(
        "SELECT source_type FROM conversation_messages WHERE workspace_id=? AND external_ref='gmail-dup'"
      )
      .all<{ source_type: string }>(WORKSPACE);
    expect(rows.map((row) => row.source_type)).toEqual(['legacy_message']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/inbound-mailbox.test.ts`
Expected: FAIL. The schema strips `mailboxAddress`, so the stranger becomes a new Person, and `source_type` is `legacy_message`.

- [ ] **Step 3: Implement the decision**

Create `src/server/email/inbound-mailbox.ts`:

```ts
import type { Db } from '../db.js';
import { classifyVerifiedInboundEmail, type VerifiedEmailOutcome } from '../email-outcomes.js';
import { createSuppression } from '../suppressions.js';
import { UNSUBSCRIBE_SUBJECT_PATTERN, applyUnsubscribeToken } from './unsubscribe.js';

/*
 * What to do with one record from the designated inbound mailbox's Nango sync.
 * Must not import integration-service.ts, which calls it.
 */

export interface InboundMailboxRecord {
  id: string;
  personEmail?: string;
  direction: 'inbound' | 'outbound';
  subject: string;
  body: string;
  mailboxAddress?: string;
  replyToMessageIds?: string[];
  autoSubmitted?: string | null;
}

export type InboundMailboxIgnoreReason =
  | 'not_designated'
  | 'mailbox_mismatch'
  | 'not_inbound'
  | 'no_sender'
  | 'own_address'
  | 'unsubscribe_applied'
  | 'unsubscribe_rejected'
  | 'campaign_thread'
  | 'unknown_sender';

export type InboundMailboxDecision =
  | { action: 'ignore'; reason: InboundMailboxIgnoreReason }
  | {
      action: 'accept';
      personId: string;
      outcomeKind: VerifiedEmailOutcome;
      threadedDeliveryId: string | null;
    };

function ignore(reason: InboundMailboxIgnoreReason): InboundMailboxDecision {
  return { action: 'ignore', reason };
}

export async function decideInboundMailboxRecord(
  db: Db,
  workspaceId: string,
  connectionId: string | null,
  record: InboundMailboxRecord,
  now: Date = new Date()
): Promise<InboundMailboxDecision> {
  const mailbox = await db
    .prepare(
      `SELECT m.connection_id,m.address FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=? AND c.status='connected'`
    )
    .get<{ connection_id: string; address: string }>(workspaceId);
  if (!mailbox || !connectionId || mailbox.connection_id !== connectionId) {
    return ignore('not_designated');
  }
  // The sync stamps the address it verified against the provider profile; a
  // mismatch means the connection now belongs to a different account.
  if ((record.mailboxAddress ?? '').trim().toLowerCase() !== mailbox.address) {
    return ignore('mailbox_mismatch');
  }
  await db
    .prepare(
      'UPDATE email_inbound_mailboxes SET last_record_at=?::timestamptz WHERE workspace_id=?'
    )
    .run(now.toISOString(), workspaceId);
  if (record.direction !== 'inbound') return ignore('not_inbound');
  const sender = (record.personEmail ?? '').trim().toLowerCase();
  if (!sender) return ignore('no_sender');
  if (sender === mailbox.address) return ignore('own_address');

  // A mail client's RFC 8058 mailto unsubscribe. The token, not the sender,
  // is the authority (aliases and forwarding change the From address), and it
  // must belong to this workspace. It is a request, not a conversation.
  const token = UNSUBSCRIBE_SUBJECT_PATTERN.exec(record.subject)?.[1];
  if (token) {
    const result = await applyUnsubscribeToken(
      db,
      token,
      { source: 'email_mailto_unsubscribe', workspaceId },
      now
    );
    return ignore(result.applied ? 'unsubscribe_applied' : 'unsubscribe_rejected');
  }

  const replyTo = (record.replyToMessageIds ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  const threaded =
    replyTo.length > 0
      ? await db
          .prepare(
            `SELECT id,source_type FROM gtm_deliveries
             WHERE workspace_id=? AND channel='email' AND internet_message_id = ANY(?::text[])
             ORDER BY started_at DESC LIMIT 1`
          )
          .get<{ id: string; source_type: string }>(workspaceId, replyTo)
      : undefined;
  // Campaign replies belong to the campaign reply poller
  // (readConnectedEmailThreadEvents), which also moves the campaign member;
  // projecting them here as well would show every campaign reply twice.
  if (threaded?.source_type === 'campaign_email') return ignore('campaign_thread');

  // Strangers are never stored. A Person must already exist, by primary email
  // or by a recorded email identity, before their mail enters the ledger.
  const person = await db
    .prepare(
      `SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?
       UNION ALL
       SELECT person_id AS id FROM person_identities
       WHERE workspace_id=? AND identity_type='email' AND normalized_value=?
       LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, sender, workspaceId, sender);
  if (!person) return ignore('unknown_sender');

  const outcomeKind = classifyVerifiedInboundEmail({
    subject: record.subject,
    body: record.body,
    autoSubmitted: record.autoSubmitted ?? null
  });
  if (outcomeKind === 'unsubscribe' && threaded) {
    // Only a reply that threads to Trevra's own email counts as verified intent.
    await createSuppression(
      db,
      {
        workspaceId,
        channel: 'email',
        email: sender,
        reason: 'Recipient asked to stop in a reply',
        source: 'email_reply_unsubscribe',
        sourceRef: record.id,
        actorType: 'system'
      },
      now
    );
  }
  return {
    action: 'accept',
    personId: person.id,
    outcomeKind,
    threadedDeliveryId: threaded?.id ?? null
  };
}
```

- [ ] **Step 4: Extend the canonical record and branch the ingest**

In `src/server/integration-service.ts`, inside the `kind: z.literal('message')` object of `canonicalRecordSchema`, replace:

```ts
    occurredAt: z.string().datetime(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('opportunity'),
```

with:

```ts
    occurredAt: z.string().datetime(),
    externalUrl: z.string().url().optional(),
    // Set only by the inbound-messages sync (nango-integrations/*/syncs/inbound-messages.ts).
    mailboxAddress: z.string().email().optional(),
    internetMessageId: z.string().max(998).optional(),
    replyToMessageIds: z.array(z.string().max(998)).max(50).optional(),
    autoSubmitted: z.string().max(200).nullable().optional()
  }),
  z.object({
    kind: z.literal('opportunity'),
```

Add to the imports:

```ts
import { decideInboundMailboxRecord } from './email/inbound-mailbox.js';
```

Insert immediately above `export async function ingestCanonicalRecord(`:

```ts
/**
 * A record from the designated inbound mailbox's Nango sync. Unlike the legacy
 * message path it never creates a Person: mail that is not from a known Person,
 * or did not arrive through the designated mailbox, is dropped before a single
 * row is written.
 */
async function ingestInboundMailboxMessage(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  record: Extract<CanonicalRecord, { kind: 'message' }>
): Promise<void> {
  const now = new Date();
  const decision = await decideInboundMailboxRecord(db, workspaceId, connectionId, record, now);
  if (decision.action === 'ignore') return;
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    record.occurredAt
  );
  const accountId = await accountForPerson(db, workspaceId, decision.personId);
  const existing = await db
    .prepare('SELECT id FROM messages WHERE workspace_id=? AND source_record_id=?')
    .get<{ id: string }>(workspaceId, sourceId);
  const messageId = existing?.id ?? id('msg');
  if (existing) {
    await db
      .prepare(
        'UPDATE messages SET person_id=?,account_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=? AND workspace_id=?'
      )
      .run(
        decision.personId,
        accountId,
        'inbound',
        record.subject,
        record.body,
        record.occurredAt,
        messageId,
        workspaceId
      );
  } else {
    await db
      .prepare(
        'INSERT INTO messages (id,workspace_id,person_id,account_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        messageId,
        workspaceId,
        decision.personId,
        accountId,
        'inbound',
        record.subject,
        record.body,
        record.occurredAt,
        sourceId,
        now.toISOString()
      );
  }
  await projectCanonicalMessage(db, workspaceId, messageId, now, {
    sourceType: 'inbound_mailbox_message',
    outcomeKind: decision.outcomeKind
  });
}
```

In `ingestCanonicalRecord`, replace:

```ts
const record = canonicalRecordSchema.parse(input);
const now = new Date().toISOString();
```

with:

```ts
const record = canonicalRecordSchema.parse(input);
if (record.kind === 'message' && record.mailboxAddress) {
  await ingestInboundMailboxMessage(db, workspaceId, provider, connectionId, record);
  return;
}
const now = new Date().toISOString();
```

- [ ] **Step 5: Let the projection carry its source type and outcome**

In `src/server/conversations.ts`, add after `import { resolveContact } from './lead-capture/people.js';`:

```ts
import type { VerifiedEmailOutcome } from './email-outcomes.js';
```

Replace the whole `projectCanonicalMessage` function (L254-314, including its doc comment) with:

```ts
/**
 * Project an existing canonical connected-email message into the shared view.
 * `inbound_mailbox_message` marks mail read through the designated inbound
 * mailbox; its outcome comes from the verified classifier instead of always
 * being 'reply'.
 */
export async function projectCanonicalMessage(
  db: Db,
  workspaceId: string,
  messageId: string,
  now: Date = new Date(),
  options: {
    sourceType?: 'legacy_message' | 'inbound_mailbox_message';
    outcomeKind?: VerifiedEmailOutcome;
  } = {}
): Promise<string | null> {
  const sourceType = options.sourceType ?? 'legacy_message';
  const message = await db
    .prepare(
      `
      SELECT m.id,m.person_id,m.direction,m.subject,m.body,m.occurred_at,m.created_at,
             s.provider,s.external_id
      FROM messages m
      LEFT JOIN source_records s ON s.id=m.source_record_id AND s.workspace_id=m.workspace_id
      WHERE m.workspace_id=? AND m.id=?
    `
    )
    .get<Record<string, unknown>>(workspaceId, messageId);
  if (!message?.person_id) return null;
  const provider = String(message.provider ?? '').toLowerCase();
  if (!['gmail', 'google-mail', 'microsoft', 'outlook'].includes(provider)) return null;
  const externalRef = message.external_id ? String(message.external_id) : null;
  if (externalRef) {
    // lc-debt: a provider message reached through both a NANGO_SYNCS_* message sync and the inbound mailbox sync is projected once, by whichever path stored it first; upgrade path: retire the legacy message syncs once every workspace reads mail through the inbound mailbox.
    const twin = await db
      .prepare(
        `SELECT conversation_id FROM conversation_messages
         WHERE workspace_id=? AND channel='email' AND provider=? AND external_ref=?
           AND source_type IN ('legacy_message','inbound_mailbox_message') AND source_type<>?
         LIMIT 1`
      )
      .get<{ conversation_id: string }>(workspaceId, provider, externalRef, sourceType);
    if (twin) return twin.conversation_id;
  }
  const occurredAt = iso(message.occurred_at) ?? now.toISOString();
  const conversation = await ensureConversation(
    db,
    workspaceId,
    String(message.person_id),
    occurredAt,
    now
  );
  await db
    .prepare(
      `
      INSERT INTO conversation_messages (
        id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
        source_type,source_id,outcome_kind,verification_status,occurred_at,created_at
      ) VALUES (?,?,?,'email',?,?,?,?,?,?,?,?,'verified',?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        conversation_id=EXCLUDED.conversation_id,
        subject=EXCLUDED.subject,
        body=EXCLUDED.body,
        outcome_kind=EXCLUDED.outcome_kind,
        verification_status='verified',
        occurred_at=EXCLUDED.occurred_at
    `
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversation.id,
      provider,
      message.direction === 'inbound' ? 'inbound' : 'outbound',
      message.subject ? String(message.subject) : null,
      String(message.body ?? ''),
      externalRef,
      sourceType,
      String(message.id),
      message.direction === 'inbound' ? (options.outcomeKind ?? 'reply') : null,
      occurredAt,
      String(message.created_at ?? now.toISOString())
    );
  return conversation.id;
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/inbound-mailbox.test.ts src/server/integration-service.test.ts src/server/conversations.test.ts`
Expected: PASS. The existing canonical-record tests do not send `mailboxAddress`, so they keep the legacy path.

- [ ] **Step 7: Commit**

```bash
git add src/server/email/inbound-mailbox.ts src/server/email/inbound-mailbox.test.ts src/server/integration-service.ts src/server/conversations.ts
git commit -m "feat(email): ingest the designated inbound mailbox, never strangers" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 8: Email channel status, inbound designation and DNS re-check

**Files:**

- Create: `src/server/email/channel.ts`
- Modify: `src/server/app.ts`. Add the imports, and put the routes after `app.delete('/api/integrations/:id', ...)` (~L3782-3791).
- Modify: `src/server/integration-service.ts`: `disconnectIntegration` (L484-501).
- Test: `src/server/email/channel-api.test.ts`

**Interfaces:**

- Consumes:
  - `listSendingMailboxes` and `resolveMailboxAddress` (Task 3).
  - `getSenderDeliverability` (Task 3).
  - `emailDomainOf` (Task 2).
  - `unsubscribeConfigured` (Task 4).
  - `getNango()`.
  - The Nango Node SDK calls `updateMetadata(providerConfigKey, connectionId, metadata)`, `startSync(providerConfigKey, syncs, connectionId)` (which also runs the sync once immediately), `pauseSync(...)`, and `syncStatus(...)`, which returns `{ syncs: [{ status, finishedAt }] }`.
  - `ownerOnly` (`src/server/app.ts:8179`).
- Produces:
  - Exports:
    - `INBOUND_SYNC_NAME = 'inbound-messages'`
    - `INBOUND_ADDRESS_METADATA_KEY = 'trevraInboundAddress'`
    - `class EmailChannelError(message, status)`
    - `getEmailChannelStatus(db, workspaceId, { resolver?, now?, env? }?)`
    - `designateInboundMailbox(db, { workspaceId, connectionId, actorUserId }, now?)`
    - `clearInboundMailbox(db, workspaceId)`
    - `recheckEmailDeliverability(db, workspaceId, { resolver?, now? }?)`
  - Routes, each returning `{ channel: EmailChannelStatus }`:
    - `GET /api/email/channel`
    - `PUT /api/email/inbound-mailbox` (owner only)
    - `DELETE /api/email/inbound-mailbox` (owner only)
    - `POST /api/email/deliverability/recheck`

- [ ] **Step 1: Write the failing test**

Create `src/server/email/channel-api.test.ts`:

```ts
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (config: Record<string, unknown>) =>
    config.endpoint === '/gmail/v1/users/me/profile'
      ? { data: { emailAddress: 'Founder@Acme.test' }, headers: {} }
      : { data: {}, headers: {} }
  ),
  updateMetadata: vi.fn(async () => ({ data: {} })),
  startSync: vi.fn(async () => undefined),
  pauseSync: vi.fn(async () => undefined),
  syncStatus: vi.fn(async () => ({
    syncs: [{ status: 'SUCCESS', finishedAt: '2026-10-06T09:05:00.000Z' }]
  })),
  deleteConnection: vi.fn(async () => ({ data: undefined }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    updateMetadata = nangoMock.updateMetadata;
    startSync = nangoMock.startSync;
    pauseSync = nangoMock.pauseSync;
    syncStatus = nangoMock.syncStatus;
    deleteConnection = nangoMock.deleteConnection;
  }
}));

import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@email-channel.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerWithMailbox() {
  const owner = await signUp('email-owner');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?)`
    )
    .run(
      `conn_${owner.auth.workspaceId}`,
      owner.auth.workspaceId,
      `gmail-${owner.auth.workspaceId}`,
      now,
      now
    );
  return {
    owner,
    connectionId: `conn_${owner.auth.workspaceId}`,
    external: `gmail-${owner.auth.workspaceId}`
  };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

beforeEach(() => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('email channel API', () => {
  it('shows mailboxes with their DNS state without touching real DNS', async () => {
    const { owner, connectionId } = await ownerWithMailbox();
    const response = await owner.agent.get('/api/email/channel').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.channel.mailboxes).toEqual([
      expect.objectContaining({
        connectionId,
        providerKey: 'google',
        address: 'founder@acme.test',
        deliverability: expect.objectContaining({ domain: 'acme.test', status: 'unknown' })
      })
    ]);
    expect(response.body.channel.mailboxes[0].providerConfigKey).toBeUndefined();
    expect(response.body.channel.unsubscribe).toMatchObject({ oneClick: false, mailto: false });
    expect(response.body.channel.inbound).toBeNull();
  });

  it('lets only the owner choose the inbound mailbox and starts the Nango sync', async () => {
    const { owner, connectionId, external } = await ownerWithMailbox();
    const member = await signUp('email-member');
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: owner.auth.workspaceId })
      .expect(200);
    await member.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(403);

    const response = await owner.agent
      .put('/api/email/inbound-mailbox')
      .send({ connectionId })
      .expect(200);
    expect(response.body.channel.inbound).toMatchObject({
      connectionId,
      address: 'founder@acme.test',
      syncStatus: 'syncing',
      syncError: null,
      nango: { status: 'SUCCESS', finishedAt: '2026-10-06T09:05:00.000Z' }
    });
    expect(nangoMock.updateMetadata).toHaveBeenCalledWith('trevra-gmail', external, {
      trevraInboundAddress: 'founder@acme.test'
    });
    expect(nangoMock.startSync).toHaveBeenCalledWith(
      'trevra-gmail',
      ['inbound-messages'],
      external
    );
  });

  it('records an unavailable sync instead of pretending it runs', async () => {
    const { owner, connectionId } = await ownerWithMailbox();
    nangoMock.startSync.mockRejectedValueOnce(new Error('Sync inbound-messages not found'));
    const response = await owner.agent
      .put('/api/email/inbound-mailbox')
      .send({ connectionId })
      .expect(200);
    expect(response.body.channel.inbound.syncStatus).toBe('unavailable');
    expect(response.body.channel.inbound.syncError).toContain('not found');
    expect(response.body.channel.unsubscribe.mailto).toBe(false);
  });

  it('stops reading the mailbox when cleared or disconnected', async () => {
    const { owner, connectionId, external } = await ownerWithMailbox();
    await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
    const cleared = await owner.agent.delete('/api/email/inbound-mailbox').expect(200);
    expect(cleared.body.channel.inbound).toBeNull();
    expect(nangoMock.pauseSync).toHaveBeenCalledWith(
      'trevra-gmail',
      ['inbound-messages'],
      external
    );

    await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
    await owner.agent.delete(`/api/integrations/${connectionId}`).expect(200);
    const row = await db
      .prepare('SELECT 1 AS present FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get(owner.auth.workspaceId);
    expect(row).toBeUndefined();
  });

  it("refuses another workspace's connection", async () => {
    const { connectionId } = await ownerWithMailbox();
    const stranger = await signUp('email-stranger');
    await stranger.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(404);
  });

  it('re-checks DNS on request', async () => {
    const { owner } = await ownerWithMailbox();
    const response = await owner.agent.post('/api/email/deliverability/recheck').expect(200);
    expect(response.body.channel.mailboxes[0].deliverability.status).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/channel-api.test.ts`
Expected: FAIL. `GET /api/email/channel` returns 404.

- [ ] **Step 3: Implement the channel service**

Create `src/server/email/channel.ts`:

```ts
import type { Db } from '../db.js';
import { getNango } from '../integration-service.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import { unsubscribeConfigured } from './unsubscribe.js';
import type {
  EmailChannelStatus,
  EmailInboundMailboxState,
  InboundSyncStatus,
  StoredDeliverability
} from './types.js';

/** The Nango sync in nango-integrations/<integration>/syncs/inbound-messages.ts. */
export const INBOUND_SYNC_NAME = 'inbound-messages';
/** Connection metadata the sync verifies the provider profile against. */
export const INBOUND_ADDRESS_METADATA_KEY = 'trevraInboundAddress';

export class EmailChannelError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'EmailChannelError';
  }
}

export interface EmailChannelOptions {
  resolver?: DnsResolver;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

interface InboundRow {
  connection_id: string;
  address: string;
  sync_status: InboundSyncStatus;
  sync_error: string | null;
  designated_at: string;
  last_record_at: string | null;
  provider_config_key: string;
  external_connection_id: string;
}

async function readInbound(db: Db, workspaceId: string): Promise<InboundRow | undefined> {
  return db
    .prepare(
      `SELECT m.connection_id,m.address,m.sync_status,m.sync_error,m.designated_at,m.last_record_at,
              c.provider_config_key,c.external_connection_id
       FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=?`
    )
    .get<InboundRow>(workspaceId);
}

async function nangoSyncState(row: InboundRow): Promise<EmailInboundMailboxState['nango']> {
  try {
    const response = await getNango().syncStatus(
      row.provider_config_key,
      [INBOUND_SYNC_NAME],
      row.external_connection_id
    );
    const sync = response.syncs[0];
    return sync ? { status: sync.status, finishedAt: sync.finishedAt ?? null } : null;
  } catch {
    return null;
  }
}

async function pauseInboundSync(row: InboundRow): Promise<void> {
  try {
    await getNango().pauseSync(
      row.provider_config_key,
      [INBOUND_SYNC_NAME],
      row.external_connection_id
    );
  } catch (error) {
    // Best effort: the ingest path also ignores records from a mailbox that is
    // no longer designated, so a sync that keeps running stores nothing.
    console.error(
      'Could not pause the inbound mailbox sync',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function isoOrNull(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function getEmailChannelStatus(
  db: Db,
  workspaceId: string,
  options: EmailChannelOptions = {}
): Promise<EmailChannelStatus> {
  const env = options.env ?? process.env;
  const mailboxes = await listSendingMailboxes(db, workspaceId);
  const rows: EmailChannelStatus['mailboxes'] = [];
  for (const mailbox of mailboxes) {
    const address = await resolveMailboxAddress(db, workspaceId, mailbox);
    const domain = address ? emailDomainOf(address) : null;
    const deliverability: StoredDeliverability | null = domain
      ? await getSenderDeliverability(
          db,
          workspaceId,
          { domain, provider: mailbox.providerKey },
          { resolver: options.resolver, now: options.now }
        )
      : null;
    // Deliberately field by field: provider config keys and Nango connection
    // ids never reach the browser.
    rows.push({
      connectionId: mailbox.connectionId,
      provider: mailbox.provider,
      providerKey: mailbox.providerKey,
      displayName: mailbox.displayName,
      address,
      deliverability
    });
  }
  const row = await readInbound(db, workspaceId);
  const inbound: EmailInboundMailboxState | null = row
    ? {
        connectionId: row.connection_id,
        address: row.address,
        syncStatus: row.sync_status,
        syncError: row.sync_error,
        designatedAt: new Date(row.designated_at).toISOString(),
        lastRecordAt: isoOrNull(row.last_record_at),
        nango: row.sync_status === 'unavailable' ? null : await nangoSyncState(row)
      }
    : null;
  const oneClick = unsubscribeConfigured(env);
  const mailto =
    oneClick &&
    inbound?.syncStatus === 'syncing' &&
    mailboxes.some((mailbox) => mailbox.connectionId === inbound.connectionId);
  return {
    unsubscribe: {
      oneClick,
      mailto,
      detail: !oneClick
        ? 'One-click unsubscribe needs an HTTPS TREVRA_PUBLIC_API_URL and TREVRA_SECRETS_KEY on the server. Email outreach stays blocked until both are set.'
        : mailto
          ? `Every outreach email offers one-click unsubscribe and mailto:${inbound!.address}.`
          : 'Every outreach email offers one-click unsubscribe.'
    },
    mailboxes: rows,
    inbound
  };
}

/**
 * Make one connected mailbox the workspace's inbound mailbox. The address comes
 * from the provider and is written into Nango connection metadata; the sync
 * refuses to emit anything if the mailbox's profile no longer matches it.
 */
export async function designateInboundMailbox(
  db: Db,
  input: { workspaceId: string; connectionId: string; actorUserId: string },
  now: Date = new Date()
): Promise<InboundSyncStatus> {
  const mailbox = (await listSendingMailboxes(db, input.workspaceId)).find(
    (candidate) => candidate.connectionId === input.connectionId
  );
  if (!mailbox) {
    throw new EmailChannelError(
      'Connect this Gmail or Microsoft 365 mailbox before using it for inbound mail.',
      404
    );
  }
  const address = await resolveMailboxAddress(db, input.workspaceId, mailbox);
  if (!address) {
    throw new EmailChannelError(
      'Trevra could not read this mailbox address from the provider. Reconnect the mailbox and try again.',
      409
    );
  }
  const previous = await readInbound(db, input.workspaceId);
  if (previous && previous.connection_id !== mailbox.connectionId) await pauseInboundSync(previous);
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
         (workspace_id,connection_id,address,sync_status,sync_error,designated_by_user_id,designated_at,last_record_at,updated_at)
       VALUES (?,?,?,'starting',NULL,?,?::timestamptz,NULL,?::timestamptz)
       ON CONFLICT (workspace_id) DO UPDATE SET
         connection_id=excluded.connection_id,address=excluded.address,sync_status='starting',sync_error=NULL,
         designated_by_user_id=excluded.designated_by_user_id,designated_at=excluded.designated_at,
         last_record_at=CASE
           WHEN email_inbound_mailboxes.connection_id=excluded.connection_id
            AND email_inbound_mailboxes.address=excluded.address
           THEN email_inbound_mailboxes.last_record_at ELSE NULL END,
         updated_at=excluded.updated_at`
    )
    .run(input.workspaceId, mailbox.connectionId, address, input.actorUserId, at, at);

  let status: InboundSyncStatus = 'syncing';
  let syncError: string | null = null;
  try {
    const nango = getNango();
    await nango.updateMetadata(mailbox.providerConfigKey, mailbox.externalConnectionId, {
      [INBOUND_ADDRESS_METADATA_KEY]: address
    });
    await nango.startSync(
      mailbox.providerConfigKey,
      [INBOUND_SYNC_NAME],
      mailbox.externalConnectionId
    );
  } catch (error) {
    // Free self-hosted Nango has no syncs, and a deployment may not have pushed
    // nango-integrations/ yet. Say so instead of claiming the inbox is read.
    status = 'unavailable';
    syncError =
      `Nango could not start the ${INBOUND_SYNC_NAME} sync: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        500
      );
  }
  await db
    .prepare(
      `UPDATE email_inbound_mailboxes SET sync_status=?,sync_error=?,updated_at=?::timestamptz
       WHERE workspace_id=? AND connection_id=?`
    )
    .run(status, syncError, new Date().toISOString(), input.workspaceId, mailbox.connectionId);
  return status;
}

export async function clearInboundMailbox(db: Db, workspaceId: string): Promise<boolean> {
  const row = await readInbound(db, workspaceId);
  const deleted = await db
    .prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=?')
    .run(workspaceId);
  if (row) await pauseInboundSync(row);
  return deleted.changes > 0;
}

/** Force a fresh DNS evaluation for every sending mailbox's domain. */
export async function recheckEmailDeliverability(
  db: Db,
  workspaceId: string,
  options: { resolver?: DnsResolver; now?: Date } = {}
): Promise<void> {
  for (const mailbox of await listSendingMailboxes(db, workspaceId)) {
    const address = await resolveMailboxAddress(db, workspaceId, mailbox);
    const domain = address ? emailDomainOf(address) : null;
    if (!domain) continue;
    await getSenderDeliverability(
      db,
      workspaceId,
      { domain, provider: mailbox.providerKey, force: true },
      options
    );
  }
}
```

- [ ] **Step 4: Close the designation when the mailbox is disconnected**

In `src/server/integration-service.ts` `disconnectIntegration`, replace:

```ts
  await db
    .prepare("UPDATE connections SET status='disconnected',updated_at=? WHERE id=?")
    .run(new Date().toISOString(), localConnectionId);
}
```

with:

```ts
  await db
    .prepare("UPDATE connections SET status='disconnected',updated_at=? WHERE id=?")
    .run(new Date().toISOString(), localConnectionId);
  // A disconnected mailbox cannot be read; Nango deleted its syncs with the connection.
  await db
    .prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=? AND connection_id=?')
    .run(workspaceId, localConnectionId);
}
```

- [ ] **Step 5: Register the routes**

In `src/server/app.ts`, add to the imports:

```ts
import {
  EmailChannelError,
  clearInboundMailbox,
  designateInboundMailbox,
  getEmailChannelStatus,
  recheckEmailDeliverability
} from './email/channel.js';
```

Insert after the closing `});` of `app.delete('/api/integrations/:id', ...)`:

```ts
app.get('/api/email/channel', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ channel: await getEmailChannelStatus(db, req.auth!.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.put(
  '/api/email/inbound-mailbox',
  ownerOnly('choose the inbound mailbox'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({ connectionId: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body ?? {});
      await designateInboundMailbox(db, {
        workspaceId: req.auth!.workspaceId,
        connectionId: input.connectionId,
        actorUserId: req.auth!.userId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ channel: await getEmailChannelStatus(db, req.auth!.workspaceId) });
    } catch (error) {
      if (error instanceof EmailChannelError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

app.delete(
  '/api/email/inbound-mailbox',
  ownerOnly('stop reading the inbound mailbox'),
  async (req: AuthedRequest, res, next) => {
    try {
      await clearInboundMailbox(db, req.auth!.workspaceId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ channel: await getEmailChannelStatus(db, req.auth!.workspaceId) });
    } catch (error) {
      next(error);
    }
  }
);

app.post('/api/email/deliverability/recheck', async (req: AuthedRequest, res, next) => {
  try {
    await recheckEmailDeliverability(db, req.auth!.workspaceId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ channel: await getEmailChannelStatus(db, req.auth!.workspaceId) });
  } catch (error) {
    next(error);
  }
});
```

The stranger test expects 404, which works because `designateInboundMailbox` only looks up connections in the caller's own workspace. A freshly signed-up stranger is the owner of their own workspace, so `ownerOnly` passes.

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/channel-api.test.ts src/server/integration-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/email/channel.ts src/server/email/channel-api.test.ts src/server/app.ts src/server/integration-service.ts
git commit -m "feat(email): designate the inbound mailbox and report channel status" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 9: Nango `inbound-messages` syncs in the repo

The repo has no Nango functions folder today. The `NANGO_SYNCS_*` message syncs live outside it. This task adds `nango-integrations/` in Nango's zero-YAML format (CLI `nango@0.71.2`): one folder per integration id, `syncs/<name>.ts` files that export `createSync(...)` by default, and `index.ts` importing each sync.

The integration folder names must equal the Nango integration ids (`trevra-gmail`, `trevra-microsoft`, the `.env.example` defaults).

The syncs only read. They emit records that are already shaped as Trevra canonical `message` records (`kind: 'message'`), so `normalizeNangoRecord` parses them without a model alias, and `ingestCanonicalRecord` routes them to the inbound mailbox path (Task 7) because `mailboxAddress` is set.

**Files:**

- Create:
  - `nango-integrations/package.json`
  - `nango-integrations/tsconfig.json`
  - `nango-integrations/index.ts`
  - `nango-integrations/.env.example`
  - `nango-integrations/.nango/.gitkeep`
  - `nango-integrations/shared/inbound-email.ts`
  - `nango-integrations/shared/inbound-model.ts`
  - `nango-integrations/trevra-gmail/syncs/inbound-messages.ts`
  - `nango-integrations/trevra-microsoft/syncs/inbound-messages.ts`
- Modify: `.gitignore`
- Test: `src/server/email/inbound-sync-helpers.test.ts`

**Interfaces:**

- Consumes:
  - Nango runtime: `createSync`, `nango.getMetadata()`, `nango.getCheckpoint()`, `nango.saveCheckpoint()`, `nango.get()`, `nango.paginate()`, `nango.batchSave()`, `nango.log()`.
  - `UNSUBSCRIBE_SUBJECT_PATTERN` (Task 4), used only for the parity test.
  - Metadata key `trevraInboundAddress` (Task 8).
  - The canonical message fields added in Task 7.
- Produces:
  - Sync `inbound-messages` on both integrations, with model `InboundEmailMessage`. It runs every 15 minutes, has `autoStart: false`, and is started by `designateInboundMailbox`.
  - `nango-integrations/shared/inbound-email.ts` exports these constants and type:
    - `BACKFILL_MS`, `OVERLAP_MS`, `MAX_MESSAGES_PER_RUN`, `MAX_BODY_CHARS`, `MAX_REPLY_TO_IDS`
    - `UNSUBSCRIBE_SUBJECT_PATTERN`
    - `type MailHeader`, `type InboundEmailRecord`
  - and these functions:
    - `normalizeAddress`
    - `decodeMimeWords`
    - `parseAddress`
    - `parseMessageIds`
    - `replyToMessageIds`
    - `headerValue`
    - `isBulkMail`
    - `htmlToText`
    - `buildInboundRecord`

Nango runs functions in a `vm` sandbox with only these globals: `Buffer`, `URL`, `URLSearchParams`, `setTimeout`, `Error`, and the JS built-ins. Imports are limited to `nango`, `zod`, `crypto`, `url` and relative files, which esbuild bundles.

`shared/inbound-email.ts` therefore has no imports. It uses only `Buffer` and built-ins, so it can also be type-checked and tested by the Trevra repo.

`shared/inbound-model.ts` holds the zod schemas. It is imported only by the Nango functions, which use zod 4.3.6 (the version the 0.71.2 CLI pins). The Trevra repo is on zod 3.25.76 and never imports it.

- [ ] **Step 1: Write the failing helper test**

Create `src/server/email/inbound-sync-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_BODY_CHARS,
  MAX_REPLY_TO_IDS,
  UNSUBSCRIBE_SUBJECT_PATTERN as SYNC_UNSUBSCRIBE_PATTERN,
  buildInboundRecord,
  decodeMimeWords,
  isBulkMail,
  normalizeAddress,
  parseAddress,
  replyToMessageIds
} from '../../../nango-integrations/shared/inbound-email.js';
import { UNSUBSCRIBE_SUBJECT_PATTERN } from './unsubscribe.js';

const header = (name: string, value: string) => ({ name, value });
const TOKEN = `del_0123456789abcdef.${'A'.repeat(43)}`;

const base = {
  id: 'msg-1',
  mailboxAddress: 'Founder@Acme.test',
  from: 'Ada Lovelace <Ada@Client.test>',
  subject: 'Re: proposal',
  body: 'x'.repeat(MAX_BODY_CHARS + 10),
  occurredAt: 1791277500000,
  externalUrl: 'https://mail.google.com/mail/?authuser=founder%40acme.test#all/msg-1',
  internetMessageId: '<reply-1@client.test>',
  headers: [
    header('In-Reply-To', '<del-1@trevra.app>'),
    header('References', '<a@x.test> <del-1@trevra.app> <b@x.test>'),
    header('Auto-Submitted', 'no')
  ]
};

describe('inbound-messages sync helpers', () => {
  it('mirror the server unsubscribe pattern and email check exactly', () => {
    expect(SYNC_UNSUBSCRIBE_PATTERN.source).toBe(UNSUBSCRIBE_SUBJECT_PATTERN.source);
    expect(SYNC_UNSUBSCRIBE_PATTERN.flags).toBe(UNSUBSCRIBE_SUBJECT_PATTERN.flags);
    for (const sample of [
      'ada@example.test',
      'a.b+c@sub.example.co',
      "o'neil@example.test",
      '.ada@example.test',
      'ada..b@example.test',
      'ada@localhost',
      'ada@exa_mple.test',
      'not an address'
    ]) {
      expect(normalizeAddress(sample) !== null).toBe(z.string().email().safeParse(sample).success);
    }
  });

  it('decodes RFC 2047 names and subjects', () => {
    expect(decodeMimeWords('=?UTF-8?B?SMOpbMOobmU=?=')).toBe('Hélène');
    expect(decodeMimeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeMimeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?= c')).toBe('ab c');
    expect(decodeMimeWords('=?KOI8-R?B?AAAA?=')).toBe('=?KOI8-R?B?AAAA?=');
    expect(parseAddress('"=?UTF-8?B?SMOpbMOobmU=?=" <Helene@Example.TEST>')).toEqual({
      address: 'helene@example.test',
      name: 'Hélène'
    });
    expect(parseAddress('bob@example.test')).toEqual({ address: 'bob@example.test', name: null });
    expect(parseAddress('undisclosed-recipients:;').address).toBeNull();
  });

  it('skips list mail unless it carries a Trevra unsubscribe token', () => {
    expect(isBulkMail([header('List-Unsubscribe', '<mailto:x@y.test>')], 'Weekly digest')).toBe(
      true
    );
    expect(isBulkMail([header('Precedence', 'Bulk')], 'Hi')).toBe(true);
    expect(isBulkMail([header('List-Id', '<x.y.test>')], `unsubscribe ${TOKEN}`)).toBe(false);
    expect(isBulkMail([header('Precedence', 'first-class')], 'Re: proposal')).toBe(false);
  });

  it('builds a canonical inbound message record', () => {
    const record = buildInboundRecord(base);
    expect(record).toMatchObject({
      id: 'msg-1',
      kind: 'message',
      direction: 'inbound',
      mailboxAddress: 'founder@acme.test',
      personEmail: 'ada@client.test',
      personName: 'Ada Lovelace',
      subject: 'Re: proposal',
      occurredAt: '2026-10-06T09:05:00.000Z',
      externalUrl: base.externalUrl,
      internetMessageId: '<reply-1@client.test>',
      replyToMessageIds: ['<del-1@trevra.app>', '<b@x.test>', '<a@x.test>'],
      autoSubmitted: 'no'
    });
    expect(record!.body).toHaveLength(MAX_BODY_CHARS);
    expect(z.string().datetime().safeParse(record!.occurredAt).success).toBe(true);
    expect(z.string().url().safeParse(record!.externalUrl).success).toBe(true);
  });

  it('drops self-sent, senderless, list and undated mail', () => {
    expect(buildInboundRecord({ ...base, from: 'Founder <founder@acme.test>' })).toBeNull();
    expect(buildInboundRecord({ ...base, from: null })).toBeNull();
    expect(buildInboundRecord({ ...base, from: 'not an address' })).toBeNull();
    expect(
      buildInboundRecord({ ...base, headers: [header('List-Id', '<news.client.test>')] })
    ).toBeNull();
    expect(buildInboundRecord({ ...base, occurredAt: 'yesterday-ish' })).toBeNull();
    expect(buildInboundRecord({ ...base, occurredAt: null })).toBeNull();
  });

  it('caps the reply-to ids it forwards', () => {
    const references = Array.from({ length: 80 }, (_, index) => `<r${index}@x.test>`).join(' ');
    const ids = replyToMessageIds('<first@x.test>', references);
    expect(ids).toHaveLength(MAX_REPLY_TO_IDS);
    expect(ids[0]).toBe('<first@x.test>');
    expect(ids[1]).toBe('<r79@x.test>');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/inbound-sync-helpers.test.ts`
Expected: FAIL. `Failed to load url ../../../nango-integrations/shared/inbound-email.js`.

- [ ] **Step 3: Write the pure helpers**

Create `nango-integrations/shared/inbound-email.ts`:

```ts
/*
 * Pure helpers shared by the trevra-gmail and trevra-microsoft inbound-messages
 * syncs. No imports on purpose: Nango bundles this file into each function,
 * and the Trevra repo type-checks and tests it
 * (src/server/email/inbound-sync-helpers.test.ts). Only `Buffer` and JS
 * built-ins are available inside Nango's sandbox.
 */

/** The first run reads this far back. */
export const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000;
/** Each completed run re-reads this much before its start, for late-indexed mail. */
export const OVERLAP_MS = 5 * 60 * 1000;
/** At most this many messages per run; the checkpoint resumes the rest. */
export const MAX_MESSAGES_PER_RUN = 500;
export const MAX_BODY_CHARS = 20_000;
export const MAX_REPLY_TO_IDS = 50;

/**
 * Mirror of zod 3.25's `z.string().email()` pattern. Trevra validates
 * personEmail with it, and one invalid record would fail the whole webhook
 * batch, so the sync only emits addresses this accepts.
 */
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

/** Mirror of UNSUBSCRIBE_SUBJECT_PATTERN in src/server/email/unsubscribe.ts. */
export const UNSUBSCRIBE_SUBJECT_PATTERN =
  /\bunsubscribe\s+(del_[0-9a-f]{16}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i;

export type MailHeader = { name: string; value: string };

/** A Trevra canonical `message` record from the designated inbound mailbox. */
export type InboundEmailRecord = {
  id: string;
  kind: 'message';
  direction: 'inbound';
  mailboxAddress: string;
  personEmail: string;
  personName?: string;
  subject: string;
  body: string;
  occurredAt: string;
  externalUrl?: string;
  internetMessageId?: string;
  replyToMessageIds: string[];
  autoSubmitted: string | null;
};

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(address) ? address : null;
}

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function nodeCharset(charset: string): 'utf8' | 'latin1' | null {
  const name = (charset.toLowerCase().split('*')[0] ?? '').trim();
  if (name === 'utf-8' || name === 'utf8') return 'utf8';
  if (name === 'iso-8859-1' || name === 'latin1' || name === 'us-ascii' || name === 'ascii') {
    return 'latin1';
  }
  return null;
}

/** RFC 2047 encoded words in UTF-8, Latin-1 or ASCII; other charsets stay as sent. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1')
    .replace(ENCODED_WORD, (word: string, charset: string, encoding: string, text: string) => {
      const target = nodeCharset(charset);
      if (!target) return word;
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_match: string, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16))
                ),
              'latin1'
            );
      return bytes.toString(target);
    });
}

export function parseAddress(header: string | null): {
  address: string | null;
  name: string | null;
} {
  if (!header) return { address: null, name: null };
  const decoded = decodeMimeWords(header).trim();
  const angle = /<([^<>\s]+)>\s*$/.exec(decoded);
  const address = normalizeAddress(angle ? angle[1] : decoded);
  const name = angle
    ? decoded
        .slice(0, angle.index)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
    : '';
  return { address, name: name ? name.slice(0, 200) : null };
}

export function parseMessageIds(value: string | null): string[] {
  return value ? (value.match(/<[^<>\s]+>/g) ?? []) : [];
}

/** In-Reply-To first, then References newest-first, de-duplicated and capped. */
export function replyToMessageIds(inReplyTo: string | null, references: string | null): string[] {
  const ids: string[] = [];
  for (const id of [...parseMessageIds(inReplyTo), ...parseMessageIds(references).reverse()]) {
    const bounded = id.slice(0, 998);
    if (!ids.includes(bounded)) ids.push(bounded);
    if (ids.length === MAX_REPLY_TO_IDS) break;
  }
  return ids;
}

export function headerValue(headers: readonly MailHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = headers.find((candidate) => candidate.name.toLowerCase() === wanted);
  return found ? found.value : null;
}

/**
 * Mailing-list and bulk mail is not a conversation. A mailto unsubscribe that
 * carries a Trevra token always passes, whatever headers the client added.
 */
export function isBulkMail(headers: readonly MailHeader[], subject: string): boolean {
  if (UNSUBSCRIBE_SUBJECT_PATTERN.test(subject)) return false;
  if (headerValue(headers, 'List-Id') !== null) return true;
  if (headerValue(headers, 'List-Unsubscribe') !== null) return true;
  const precedence = (headerValue(headers, 'Precedence') ?? '').trim().toLowerCase();
  return precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One provider message as a canonical record, or null when it is not a
 * person-to-person message to this mailbox. Trevra still re-checks everything
 * server-side (decideInboundMailboxRecord); this only avoids shipping noise.
 */
export function buildInboundRecord(input: {
  id: string;
  mailboxAddress: string;
  from: string | null;
  subject: string | null;
  body: string;
  occurredAt: string | number | null;
  externalUrl: string | null;
  internetMessageId: string | null;
  headers: readonly MailHeader[];
}): InboundEmailRecord | null {
  const mailbox = normalizeAddress(input.mailboxAddress);
  if (!mailbox) return null;
  const sender = parseAddress(input.from);
  if (!sender.address || sender.address === mailbox) return null;
  const subject = decodeMimeWords(input.subject ?? '')
    .trim()
    .slice(0, 998);
  if (isBulkMail(input.headers, subject)) return null;
  const occurred = input.occurredAt === null ? Number.NaN : new Date(input.occurredAt).getTime();
  if (!Number.isFinite(occurred)) return null;
  const messageId = parseMessageIds(input.internetMessageId)[0];
  const autoSubmitted = headerValue(input.headers, 'Auto-Submitted');
  return {
    id: input.id,
    kind: 'message',
    direction: 'inbound',
    mailboxAddress: mailbox,
    personEmail: sender.address,
    ...(sender.name ? { personName: sender.name } : {}),
    subject,
    body: input.body.slice(0, MAX_BODY_CHARS),
    occurredAt: new Date(occurred).toISOString(),
    ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
    ...(messageId ? { internetMessageId: messageId.slice(0, 998) } : {}),
    replyToMessageIds: replyToMessageIds(
      headerValue(input.headers, 'In-Reply-To'),
      headerValue(input.headers, 'References')
    ),
    autoSubmitted: autoSubmitted ? autoSubmitted.trim().slice(0, 200) : null
  };
}
```

- [ ] **Step 4: Run the helper test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/inbound-sync-helpers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Scaffold the Nango project by hand**

The folder is written by hand instead of with `nango init`, which would copy a demo GitHub integration. The CLI treats a folder as zero-YAML only when it contains both `.nango/` and `index.ts`.

Create `nango-integrations/package.json`:

```json
{
  "name": "trevra-nango-integrations",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "compile": "nango compile",
    "dev": "nango dev"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "nango": "0.71.2",
    "zod": "4.3.6"
  }
}
```

`nango` and `zod` are pinned to exactly the versions the 0.71.2 CLI checks for. Any other value makes `nango compile` rewrite `package.json` and reinstall.

Create `nango-integrations/tsconfig.json`. It is Nango's managed configuration, verbatim from `nango@0.71.2/example/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "$comment": "This file is managed by Nango, do not edit it manually.",
  "include": ["index.ts", "**/*.ts"],
  "exclude": ["node_modules", "dist", "build", ".nango"],
  "compilerOptions": {
    "module": "node16",
    "target": "esnext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node16",
    "allowUnusedLabels": false,
    "allowUnreachableCode": false,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "declaration": false,
    "sourceMap": true,
    "composite": false,
    "checkJs": false,
    "noEmit": true
  }
}
```

Create `nango-integrations/index.ts`:

```ts
import './trevra-gmail/syncs/inbound-messages.js';
import './trevra-microsoft/syncs/inbound-messages.js';
```

Create `nango-integrations/.env.example`:

```bash
# Nango CLI credentials for `nango deploy`. Copy to .env (git-ignored).
# Secret keys come from the Nango dashboard's Environment Settings.
NANGO_SECRET_KEY_DEV=
NANGO_SECRET_KEY_PROD=
# Self-hosted Nango: the server URL (the same host as NANGO_HOST in Trevra's .env).
# NANGO_HOSTPORT=http://localhost:43003
NANGO_CLI_UPGRADE_MODE=ignore
NANGO_DEPLOY_AUTO_CONFIRM=false
```

Create an empty `nango-integrations/.nango/.gitkeep`.

Append to `.gitignore`:

```gitignore
nango-integrations/build/
nango-integrations/.nango/*
!nango-integrations/.nango/.gitkeep
```

The root `.gitignore` already ignores `node_modules/` and `.env` at every depth.

- [ ] **Step 6: Write the model**

Create `nango-integrations/shared/inbound-model.ts`:

```ts
import * as z from 'zod';

/**
 * Field-for-field the InboundEmailRecord type in ./inbound-email.ts, which is
 * itself Trevra's canonical `message` record plus the inbound mailbox fields.
 */
export const InboundEmailMessage = z.object({
  id: z.string(),
  kind: z.literal('message'),
  direction: z.literal('inbound'),
  mailboxAddress: z.string(),
  personEmail: z.string(),
  personName: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  occurredAt: z.string(),
  externalUrl: z.string().optional(),
  internetMessageId: z.string().optional(),
  replyToMessageIds: z.array(z.string()),
  autoSubmitted: z.string().nullable()
});

/** Written by Trevra (designateInboundMailbox) before it starts the sync. */
export const InboundSyncMetadata = z.object({
  trevraInboundAddress: z.string()
});
```

- [ ] **Step 7: Write the Gmail sync**

Create `nango-integrations/trevra-gmail/syncs/inbound-messages.ts`:

```ts
import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  MAX_MESSAGES_PER_RUN,
  OVERLAP_MS,
  buildInboundRecord,
  headerValue,
  htmlToText,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';

/** Message ids listed per run before the oldest-first read. */
const LIST_CEILING = 2000;
const SAVE_BATCH = 50;

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: MailHeader[];
};

type GmailMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

function partText(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) {
    const found = partText(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function messageBody(message: GmailMessage): string {
  const plain = partText(message.payload, 'text/plain');
  if (plain !== null) return plain.trim();
  const html = partText(message.payload, 'text/html');
  if (html !== null) return htmlToText(html);
  return (message.snippet ?? '').trim();
}

export default createSync({
  description:
    'Reads the Gmail inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
  version: '1.0.0',
  frequency: 'every 15 minutes',
  autoStart: false,
  models: { InboundEmailMessage },
  metadata: InboundSyncMetadata,
  checkpoint: z.object({ sinceMs: z.number() }),
  exec: async (nango) => {
    const metadata = await nango.getMetadata();
    const expected = normalizeAddress(metadata?.trevraInboundAddress);
    if (!expected) {
      throw new Error('trevraInboundAddress metadata is missing. Designate the mailbox in Trevra.');
    }
    const profile = await nango.get<{ emailAddress?: string }>({
      endpoint: '/gmail/v1/users/me/profile',
      retries: 3
    });
    if (normalizeAddress(profile.data.emailAddress) !== expected) {
      throw new Error(
        'This Gmail connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }

    const startedAt = Date.now();
    const checkpoint = await nango.getCheckpoint();
    const sinceMs = checkpoint?.sinceMs ?? startedAt - BACKFILL_MS;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await nango.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>({
        endpoint: '/gmail/v1/users/me/messages',
        params: {
          q: `in:inbox -category:promotions -category:social after:${Math.floor(sinceMs / 1000)}`,
          maxResults: 100,
          ...(pageToken ? { pageToken } : {})
        },
        retries: 3
      });
      for (const message of page.data.messages ?? []) ids.push(message.id);
      pageToken = page.data.nextPageToken;
    } while (pageToken && ids.length < LIST_CEILING);
    if (pageToken) {
      // lc-debt: more than LIST_CEILING inbox messages in one window reads only the newest LIST_CEILING of them; upgrade path: list by bounded after:/before: date windows.
      await nango.log(
        `More than ${LIST_CEILING} inbox messages since the last run; reading the newest ${LIST_CEILING}.`,
        {
          level: 'warn'
        }
      );
    }

    // Gmail lists newest first; read oldest first so the checkpoint can resume.
    const queue = ids.reverse().slice(0, MAX_MESSAGES_PER_RUN);
    let batch: InboundEmailRecord[] = [];
    let lastMs = sinceMs;
    for (const id of queue) {
      const response = await nango.get<GmailMessage>({
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
        params: { format: 'full' },
        retries: 3
      });
      const message = response.data;
      const headers = message.payload?.headers ?? [];
      const occurredMs = Number(message.internalDate ?? Number.NaN);
      const record = buildInboundRecord({
        id: message.id,
        mailboxAddress: expected,
        from: headerValue(headers, 'From'),
        subject: headerValue(headers, 'Subject'),
        body: messageBody(message),
        occurredAt: Number.isFinite(occurredMs) ? occurredMs : null,
        externalUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(expected)}#all/${encodeURIComponent(message.id)}`,
        internetMessageId: headerValue(headers, 'Message-ID'),
        headers
      });
      if (record) batch.push(record);
      if (Number.isFinite(occurredMs)) lastMs = Math.max(lastMs, occurredMs);
      if (batch.length >= SAVE_BATCH) {
        await nango.batchSave(batch, 'InboundEmailMessage');
        batch = [];
        await nango.saveCheckpoint({ sinceMs: lastMs - 1000 });
      }
    }
    if (batch.length > 0) await nango.batchSave(batch, 'InboundEmailMessage');
    const finished = queue.length === ids.length && !pageToken;
    await nango.saveCheckpoint({
      sinceMs: finished ? Math.max(sinceMs, startedAt - OVERLAP_MS) : lastMs - 1000
    });
  }
});
```

- [ ] **Step 8: Write the Microsoft 365 sync**

Create `nango-integrations/trevra-microsoft/syncs/inbound-messages.ts`:

```ts
import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  MAX_MESSAGES_PER_RUN,
  buildInboundRecord,
  headerValue,
  htmlToText,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  subject?: string | null;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  webLink?: string;
  internetMessageHeaders?: MailHeader[];
};

function fromHeader(message: GraphMessage): string | null {
  const address = message.from?.emailAddress?.address;
  if (!address) return null;
  const name = (message.from?.emailAddress?.name ?? '').replace(/["<>]/g, '').trim();
  return name ? `"${name}" <${address}>` : address;
}

function graphBody(message: GraphMessage): string {
  const content = message.body?.content ?? '';
  return message.body?.contentType === 'html' ? htmlToText(content) : content.trim();
}

export default createSync({
  description:
    'Reads the Microsoft 365 inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
  version: '1.0.0',
  frequency: 'every 15 minutes',
  autoStart: false,
  models: { InboundEmailMessage },
  metadata: InboundSyncMetadata,
  checkpoint: z.object({ since: z.string() }),
  exec: async (nango) => {
    const metadata = await nango.getMetadata();
    const expected = normalizeAddress(metadata?.trevraInboundAddress);
    if (!expected) {
      throw new Error('trevraInboundAddress metadata is missing. Designate the mailbox in Trevra.');
    }
    const me = await nango.get<{ mail?: string | null; userPrincipalName?: string | null }>({
      endpoint: '/v1.0/me',
      params: { $select: 'mail,userPrincipalName' },
      retries: 3
    });
    if (normalizeAddress(me.data.mail || me.data.userPrincipalName) !== expected) {
      throw new Error(
        'This Microsoft 365 connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }

    const checkpoint = await nango.getCheckpoint();
    const since = checkpoint?.since ?? new Date(Date.now() - BACKFILL_MS).toISOString();
    let latestMs = Date.parse(since);
    let read = 0;
    for await (const page of nango.paginate<GraphMessage>({
      endpoint: '/v1.0/me/mailFolders/inbox/messages',
      // Immutable ids keep a record's id stable when the user files the message.
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
      params: {
        $filter: `receivedDateTime ge ${since}`,
        $orderby: 'receivedDateTime asc',
        $select:
          'id,internetMessageId,subject,body,from,receivedDateTime,webLink,internetMessageHeaders'
      },
      paginate: {
        type: 'link',
        link_path_in_response_body: '@odata.nextLink',
        response_path: 'value',
        limit_name_in_request: '$top',
        limit: 50
      },
      retries: 3
    })) {
      const records: InboundEmailRecord[] = [];
      for (const message of page) {
        const record = buildInboundRecord({
          id: message.id,
          mailboxAddress: expected,
          from: fromHeader(message),
          subject: message.subject ?? '',
          body: graphBody(message),
          occurredAt: message.receivedDateTime ?? null,
          externalUrl: message.webLink ?? null,
          internetMessageId: message.internetMessageId ?? null,
          headers: message.internetMessageHeaders ?? []
        });
        if (record) records.push(record);
        const receivedMs = Date.parse(message.receivedDateTime ?? '');
        if (Number.isFinite(receivedMs)) latestMs = Math.max(latestMs, receivedMs);
      }
      if (records.length > 0) await nango.batchSave(records, 'InboundEmailMessage');
      // `ge` re-reads the boundary message next run; record ids make that idempotent.
      await nango.saveCheckpoint({ since: new Date(latestMs).toISOString() });
      read += page.length;
      if (read >= MAX_MESSAGES_PER_RUN) break;
    }
  }
});
```

Graph returns the sender as a structured `emailAddress`. `fromHeader` turns it into the same quoted `"Name" <address>` text a Gmail `From` header carries, so both providers go through the one `parseAddress` path.

- [ ] **Step 9: Install and compile**

Run:

```bash
cd nango-integrations && npm install && NANGO_CLI_UPGRADE_MODE=ignore npx nango compile --no-interactive
```

Expected:

- `npm install` creates `nango-integrations/package-lock.json`.
- The compile prints `Typechecking`, `Building 2 file(s)`, `Generating artifacts` and `Compiled`, with no `Found N errors` line.
- `nango-integrations/build/` and `nango-integrations/.nango/nango.json` appear, and both are git-ignored.

If compile reports `Function ... contains console statements`, a helper used `console`. Replace it with `nango.log`.

Run: `git status --short nango-integrations .gitignore`

Expected: exactly these paths, and nothing under `build/`, `node_modules/` or `.nango/` other than `.gitkeep`:

- `.gitignore`
- `nango-integrations/.env.example`
- `nango-integrations/.nango/.gitkeep`
- `nango-integrations/index.ts`
- `nango-integrations/package-lock.json`
- `nango-integrations/package.json`
- `nango-integrations/shared/`
- `nango-integrations/trevra-gmail/`
- `nango-integrations/trevra-microsoft/`
- `nango-integrations/tsconfig.json`

- [ ] **Step 10: Confirm the repo gate ignores the Nango project**

Run: `npx tsc --noEmit`
Expected: exit 0. The root `tsconfig.json` includes only `src`, `scripts` and `vite.config.ts`. It reaches `nango-integrations/shared/inbound-email.ts` only through the helper test's import, and that file has no imports.

- [ ] **Step 11: Commit**

```bash
git add .gitignore nango-integrations/package.json nango-integrations/package-lock.json nango-integrations/tsconfig.json nango-integrations/index.ts nango-integrations/.env.example nango-integrations/.nango/.gitkeep nango-integrations/shared nango-integrations/trevra-gmail nango-integrations/trevra-microsoft src/server/email/inbound-sync-helpers.test.ts
git commit -m "feat(email): Nango inbound-messages syncs for Gmail and Microsoft 365" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

Deploying the syncs is an operator step (Task 16 documents it): `cd nango-integrations && npx nango deploy prod`. Until it runs, designation reports `unavailable`.

---

### Task 10: Today `deliverability_blocked`, and labelled inbound mail

**Files:**

- Modify: `src/server/today.ts`
  - `TodayItemKind` union (L5-20)
  - `emailReplyRows` query (L319-337)
  - email reply loop (L422-445)
  - one new query and loop
- Modify: `src/client/views/LoopView.tsx`: `todayActionLabel` (L741-753).
- Test: `src/server/today.test.ts`

**Interfaces:**

- Consumes:
  - `email_deliverability_checks`, written by `getSenderDeliverability` (Task 3). `outreach_requested_at` is set by `markOutreach` in Task 12.
  - `connections.mailbox_address` (Task 1, filled in by Task 3).
  - `conversation_messages.source_type = 'inbound_mailbox_message'` (Task 7).
- Produces:
  - Today kind `'deliverability_blocked'`:
    - priority 25, title `Email from <domain> is blocked`
    - href `/setup/workspace`, reference `{ type: 'email_domain', id: domain }`
    - metadata `{ provider, blockerCodes }`
  - Inbound mailbox mail titled `New email from <name>`, with `metadata.inboundMailbox: true`.

A failing domain only needs attention while it is in use. Someone must have planned email outreach from it in the last 30 days, and a live connected mailbox must still send from it. Without that, a stale check for a mailbox the founder never sends from would sit in Today forever.

- [ ] **Step 1: Write the failing tests**

In `src/server/today.test.ts`, add inside the top-level `describe` (after the test `'surfaces a latest verified inbound email reply as human attention'`):

```ts
async function seedMailbox(options: { status?: string; workspaceId?: string } = {}) {
  const workspaceId = options.workspaceId ?? WORKSPACE;
  await db
    .prepare(
      `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
          mailbox_address,created_at,updated_at)
         VALUES (?,?,'gmail','trevra-gmail',?,NULL,?,0,'founder@acme.test',?,?)`
    )
    .run(
      `conn_today_mail_${workspaceId}`,
      workspaceId,
      `gmail-today-${workspaceId}`,
      options.status ?? 'connected',
      '2026-08-20T08:00:00.000Z',
      '2026-08-20T08:00:00.000Z'
    );
}

async function seedCheck(
  status: 'pass' | 'fail',
  outreachRequestedAt: string | null,
  workspaceId = WORKSPACE
) {
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
         (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
          checked_at,expires_at,outreach_requested_at)
         VALUES (?,'acme.test','google',?,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,?::jsonb,'[]'::jsonb,
                 ?::timestamptz,?::timestamptz,?::timestamptz)`
    )
    .run(
      workspaceId,
      status,
      JSON.stringify(
        status === 'fail'
          ? [
              {
                code: 'email_dkim_missing',
                message: 'No DKIM key is published for acme.test at google._domainkey.',
                actionHref: '/setup/workspace'
              }
            ]
          : []
      ),
      '2026-08-21T07:30:00.000Z',
      '2026-08-21T07:40:00.000Z',
      outreachRequestedAt
    );
}

it('surfaces a failing sending domain someone planned outreach from', async () => {
  await seedMailbox();
  await seedCheck('fail', '2026-08-21T07:30:00.000Z');

  const today = await getToday(db, WORKSPACE, NOW);

  expect(today.needsAttention).toEqual([
    {
      id: 'deliverability:acme.test:google',
      kind: 'deliverability_blocked',
      priority: 25,
      title: 'Email from acme.test is blocked',
      detail: 'No DKIM key is published for acme.test at google._domainkey.',
      href: '/setup/workspace',
      observedAt: '2026-08-21T07:30:00.000Z',
      reference: { type: 'email_domain', id: 'acme.test' },
      metadata: { provider: 'google', blockerCodes: ['email_dkim_missing'] }
    }
  ]);
});

it('stays quiet about domains nobody is about to send from', async () => {
  await seedMailbox();
  await seedCheck('fail', null);
  expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await seedCheck('fail', '2026-07-01T07:30:00.000Z');
  expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await seedCheck('pass', '2026-08-21T07:30:00.000Z');
  expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await db
    .prepare("UPDATE connections SET status='disconnected' WHERE workspace_id=?")
    .run(WORKSPACE);
  await seedCheck('fail', '2026-08-21T07:30:00.000Z');
  expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);
});

it('labels mail read from the inbound mailbox as new email', async () => {
  await db
    .prepare(
      `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_today_inbound_mail',?,'Nora Frei','nora@client.test','nora@client.test',?,?)`
    )
    .run(WORKSPACE, '2026-08-21T07:00:00.000Z', '2026-08-21T07:45:00.000Z');
  await db
    .prepare(
      `INSERT INTO conversations
         (id,workspace_id,person_id,status,last_activity_at,created_at,updated_at)
         VALUES ('conv_today_inbound_mail',?,'con_today_inbound_mail','open',?,?,?)`
    )
    .run(
      WORKSPACE,
      '2026-08-21T07:45:00.000Z',
      '2026-08-21T07:00:00.000Z',
      '2026-08-21T07:45:00.000Z'
    );
  await db
    .prepare(
      `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          outcome_kind,verification_status,occurred_at,created_at)
         VALUES ('cmsg_today_inbound_mail',?,'conv_today_inbound_mail','email','gmail','inbound',
                 'Saw your note, are you free Thursday?','inbound_mailbox_message','msg_today_inbound',
                 'reply','verified','2026-08-21T07:45:00.000Z','2026-08-21T07:45:00.000Z')`
    )
    .run(WORKSPACE);

  const today = await getToday(db, WORKSPACE, NOW);

  expect(today.needsAttention).toEqual([
    expect.objectContaining({
      kind: 'verified_reply',
      title: 'New email from Nora Frei',
      metadata: expect.objectContaining({ channel: 'email', inboundMailbox: true })
    })
  ]);
});
```

In the `'never leaks another workspace into the projection'` test, which already asserts that `WORKSPACE` sees none of `other`'s rows, replace:

```ts
await pauseSeat(db, other, 'Other workspace pause', NOW);
```

with:

```ts
await pauseSeat(db, other, 'Other workspace pause', NOW);
await seedMailbox({ workspaceId: other });
await seedCheck('fail', '2026-08-21T07:30:00.000Z', other);
```

`clearWorkspace(other)` cascades both rows away.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts`
Expected: FAIL. The deliverability test gets `[]`, and the inbound test gets the title `Reply from Nora Frei`.

- [ ] **Step 3: Implement**

In `src/server/today.ts`, replace:

```ts
  | 'safety_block'
  | 'verified_reply'
```

with:

```ts
  | 'safety_block'
  | 'verified_reply'
  | 'deliverability_blocked'
```

In the `emailReplyRows` query, replace:

```ts
      `SELECT c.id AS conversation_id,m.id AS message_id,m.body,m.occurred_at,
              p.id AS person_id,p.name AS person_name,p.email AS person_email
```

with:

```ts
      `SELECT c.id AS conversation_id,m.id AS message_id,m.body,m.occurred_at,m.source_type,
              p.id AS person_id,p.name AS person_name,p.email AS person_email
```

and replace:

```ts
         SELECT cm.id,cm.body,cm.occurred_at,cm.channel,cm.direction,
                cm.verification_status,cm.outcome_kind
```

with:

```ts
         SELECT cm.id,cm.body,cm.occurred_at,cm.channel,cm.direction,
                cm.verification_status,cm.outcome_kind,cm.source_type
```

Directly after the `emailReplyRows` statement (before the capacity comment), add:

```ts
// A failing sending domain needs a human only while it is in use: someone
// planned email outreach from it in the last 30 days and a live connected
// mailbox still sends from it.
const deliverabilityRows = await db
  .prepare(
    `SELECT d.domain,d.provider,d.blockers_json,d.checked_at
       FROM email_deliverability_checks d
       WHERE d.workspace_id=? AND d.status='fail'
         AND d.outreach_requested_at IS NOT NULL
         AND d.outreach_requested_at>=?::timestamptz
         AND EXISTS (
           SELECT 1 FROM connections c
           WHERE c.workspace_id=d.workspace_id AND c.status='connected' AND c.is_demo=0
             AND c.mailbox_address IS NOT NULL
             AND SPLIT_PART(c.mailbox_address,'@',2)=d.domain
             AND CASE
                   WHEN c.provider IN ('gmail','google-mail') THEN 'google'
                   WHEN c.provider IN ('microsoft','outlook') THEN 'microsoft'
                 END=d.provider
         )
       ORDER BY d.domain ASC,d.provider ASC LIMIT 10`
  )
  .all<Record<string, unknown>>(
    workspaceId,
    new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  );
```

In the email reply loop, replace:

```ts
    items.push({
      id: `email-reply:${String(row.message_id)}`,
      kind: 'verified_reply',
      priority: 20,
      title: `Reply from ${name}`,
```

with:

```ts
    const inboundMailbox = row.source_type === 'inbound_mailbox_message';
    items.push({
      id: `email-reply:${String(row.message_id)}`,
      kind: 'verified_reply',
      priority: 20,
      title: inboundMailbox ? `New email from ${name}` : `Reply from ${name}`,
```

and in the same `items.push`, replace:

```ts
      metadata: {
        conversationId: String(row.conversation_id),
        personId: String(row.person_id),
        channel: 'email'
      }
```

with:

```ts
      metadata: {
        conversationId: String(row.conversation_id),
        personId: String(row.person_id),
        channel: 'email',
        inboundMailbox
      }
```

Directly after the email reply loop's closing `}`, add:

```ts
for (const row of deliverabilityRows) {
  const domain = String(row.domain);
  const blockers = Array.isArray(row.blockers_json)
    ? (row.blockers_json as Array<{ code?: unknown; message?: unknown }>)
    : [];
  items.push({
    id: `deliverability:${domain}:${String(row.provider)}`,
    kind: 'deliverability_blocked',
    priority: 25,
    title: `Email from ${domain} is blocked`,
    detail:
      String(blockers[0]?.message ?? '').trim() ||
      `SPF, DKIM or DMARC for ${domain} does not pass, so Trevra will not plan email outreach from it.`,
    href: '/setup/workspace',
    observedAt: iso(row.checked_at, now),
    reference: { type: 'email_domain', id: domain },
    metadata: {
      provider: String(row.provider),
      blockerCodes: blockers.map((blocker) => String(blocker.code ?? '')).filter(Boolean)
    }
  });
}
```

In `src/client/views/LoopView.tsx` `todayActionLabel`, replace:

```ts
if (item.kind === 'verified_reply') return 'Reply';
```

with:

```ts
if (item.kind === 'verified_reply') return 'Reply';
if (item.kind === 'deliverability_blocked') return 'Fix DNS';
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/today.ts src/server/today.test.ts src/client/views/LoopView.tsx
git commit -m "feat(today): surface blocked sending domains and label inbound mail" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 11: Email panel on `/setup/workspace`

**Files:**

- Create: `src/client/EmailChannelSummary.tsx`
- Create: `src/client/EmailChannelPanel.tsx`
- Modify: `src/client/api.ts`: the type imports (after L69) and four functions after `prepareCompiledGtmPlan` (L554-562).
- Modify: `src/client/App.tsx`: one import (after L81) and the workspace grid (L591-599).
- Modify: `src/client/styles.css`: a layout block before `/* Opportunity-lite: fixed GTM stages, not a configurable CRM pipeline. */` (~L12798).
- Test: `src/client/EmailChannelSummary.test.tsx`

**Interfaces:**

- Consumes:
  - The Task 8 routes `GET /api/email/channel`, `PUT /api/email/inbound-mailbox`, `DELETE /api/email/inbound-mailbox` and `POST /api/email/deliverability/recheck`. Each returns `{ channel: EmailChannelStatus }`.
  - `EmailChannelStatus`, `StoredDeliverability` (Task 2).
  - `Button` (`src/client/ui/primitives.tsx:32`), `Panel` (`src/client/ui/layout.tsx:35`), `prettyProvider` (`src/client/views/format.ts:72`), `useIsWorkspaceOwner` (`src/client/auth-client.ts:36`).
- Produces:
  - `src/client/api.ts`: `getEmailChannel()`, `chooseInboundMailbox(connectionId)`, `stopInboundMailbox()`, `recheckEmailDns()`, each resolving to `EmailChannelStatus`.
  - `EmailChannelSummary` (pure render) and `type EmailChannelBusy`.
  - `EmailChannelPanel({ setToast })`.

The summary is a pure render of `EmailChannelStatus`, so it is tested with `renderToStaticMarkup` the way `src/client/views/approval-proof.test.tsx` tests the approval proof. The panel only fetches and holds state. Members see the state and can re-check DNS; only the owner sees the inbound controls, matching the `ownerOnly` routes.

- [ ] **Step 1: Write the failing test**

Create `src/client/EmailChannelSummary.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EmailChannelStatus, StoredDeliverability } from '../server/email/types';
import { EmailChannelSummary, type EmailChannelBusy } from './EmailChannelSummary';

const noop = () => undefined;

function deliverability(overrides: Partial<StoredDeliverability> = {}): StoredDeliverability {
  const check = { status: 'pass' as const, detail: 'Published.', record: null };
  return {
    domain: 'acme.test',
    provider: 'google',
    status: 'pass',
    spf: check,
    dkim: check,
    dmarc: check,
    blockers: [],
    warnings: [],
    checkedAt: '2026-10-06T09:00:00.000Z',
    expiresAt: '2026-10-07T09:00:00.000Z',
    ...overrides
  };
}

const MAILBOX: EmailChannelStatus['mailboxes'][number] = {
  connectionId: 'conn_mail_1',
  provider: 'gmail',
  providerKey: 'google',
  displayName: null,
  address: 'founder@acme.test',
  deliverability: deliverability()
};

function channel(overrides: Partial<EmailChannelStatus> = {}): EmailChannelStatus {
  return {
    unsubscribe: {
      oneClick: true,
      mailto: false,
      detail: 'Every outreach email offers one-click unsubscribe.'
    },
    mailboxes: [MAILBOX],
    inbound: null,
    ...overrides
  };
}

function inbound(
  syncStatus: 'starting' | 'syncing' | 'unavailable',
  syncError: string | null = null
): NonNullable<EmailChannelStatus['inbound']> {
  return {
    connectionId: 'conn_mail_1',
    address: 'founder@acme.test',
    syncStatus,
    syncError,
    designatedAt: '2026-10-06T09:00:00.000Z',
    lastRecordAt: null,
    nango: null
  };
}

function render(
  status: EmailChannelStatus,
  options: { isOwner?: boolean; busy?: EmailChannelBusy } = {}
): string {
  return renderToStaticMarkup(
    <EmailChannelSummary
      channel={status}
      isOwner={options.isOwner ?? true}
      busy={options.busy ?? null}
      onUseForInbound={noop}
      onStopInbound={noop}
      onRecheck={noop}
    />
  );
}

describe('EmailChannelSummary', () => {
  it('shows a passing sender and offers it to the owner as the inbound mailbox', () => {
    const markup = render(channel());
    expect(markup).toContain('founder@acme.test');
    expect(markup).toContain('SPF, DKIM and DMARC pass');
    expect(markup).toContain('Use for inbound mail');
    expect(markup).toContain('No mailbox is read.');
    expect(markup).toContain('Every outreach email offers one-click unsubscribe.');
    expect(markup).toContain('Re-check DNS');
  });

  it('spells out every DNS blocker instead of only showing a badge', () => {
    const markup = render(
      channel({
        mailboxes: [
          {
            ...MAILBOX,
            deliverability: deliverability({
              status: 'fail',
              blockers: [
                {
                  code: 'email_dkim_missing',
                  message: 'No DKIM key is published for acme.test at google._domainkey.',
                  actionHref: '/setup/workspace'
                }
              ]
            })
          }
        ]
      })
    );
    expect(markup).toContain('Sending blocked');
    expect(markup).toContain('No DKIM key is published for acme.test at google._domainkey.');
  });

  it('says plainly when the inbound sync cannot run', () => {
    const markup = render(
      channel({
        inbound: inbound(
          'unavailable',
          'Nango could not start the inbound-messages sync: sync not found'
        )
      })
    );
    expect(markup).toContain('Trevra cannot read founder@acme.test.');
    expect(markup).toContain('sync not found');
    expect(markup).not.toContain('Use for inbound mail');
    expect(markup).toContain('Stop reading mail');
  });

  it('shows members the state without the owner-only controls', () => {
    const markup = render(channel({ inbound: inbound('syncing') }), { isOwner: false });
    expect(markup).toContain('Reading founder@acme.test.');
    expect(markup).not.toContain('Use for inbound mail');
    expect(markup).not.toContain('Stop reading mail');
    expect(markup).toContain('Re-check DNS');
  });

  it('tells a workspace without a mailbox how to start and disables the DNS check', () => {
    const markup = render(channel({ mailboxes: [] }));
    expect(markup).toContain('Connect Gmail or Microsoft 365');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS<\/button>/);
  });

  it('shows progress on the control that is busy', () => {
    expect(render(channel(), { busy: 'recheck' })).toContain('Checking…');
    expect(render(channel(), { busy: 'inbound:conn_mail_1' })).toContain('Starting…');
  });
});
```

No asserted string contains an apostrophe, because `renderToStaticMarkup` escapes it to `&#x27;`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/client/EmailChannelSummary.test.tsx`
Expected: FAIL with `Failed to resolve import "./EmailChannelSummary"`.

- [ ] **Step 3: Write the summary component**

Create `src/client/EmailChannelSummary.tsx`:

```tsx
import type { EmailChannelStatus, StoredDeliverability } from '../server/email/types';
import { Button } from './ui/primitives';
import { prettyProvider } from './views/format';

/** Which control is waiting on the server; every control is disabled meanwhile. */
export type EmailChannelBusy = 'recheck' | 'stop' | `inbound:${string}` | null;

function deliverabilityBadge(deliverability: StoredDeliverability | null): {
  label: string;
  tone: 'pass' | 'fail' | 'unknown';
} {
  if (!deliverability) return { label: 'Address unknown', tone: 'unknown' };
  if (deliverability.status === 'pass') return { label: 'SPF, DKIM and DMARC pass', tone: 'pass' };
  if (deliverability.status === 'fail') return { label: 'Sending blocked', tone: 'fail' };
  return { label: 'DNS not confirmed', tone: 'unknown' };
}

function inboundSentence(inbound: EmailChannelStatus['inbound']): string {
  if (!inbound) {
    return 'No mailbox is read. Replies to outreach email stay in your inbox and never reach Conversations.';
  }
  if (inbound.syncStatus === 'syncing') {
    return `Reading ${inbound.address}. Only mail from People already in Trevra is kept; everything else is ignored.`;
  }
  if (inbound.syncStatus === 'starting') return `Starting to read ${inbound.address}.`;
  return `Trevra cannot read ${inbound.address}. ${
    inbound.syncError ?? 'The inbound-messages sync is not available on this Nango deployment.'
  }`;
}

export function EmailChannelSummary({
  channel,
  isOwner,
  busy,
  onUseForInbound,
  onStopInbound,
  onRecheck
}: {
  channel: EmailChannelStatus;
  isOwner: boolean;
  busy: EmailChannelBusy;
  onUseForInbound: (connectionId: string) => void;
  onStopInbound: () => void;
  onRecheck: () => void;
}) {
  return (
    <div className="email-channel">
      {channel.mailboxes.length === 0 ? (
        <p className="empty-copy">
          Connect Gmail or Microsoft 365 above to send outreach email and read replies.
        </p>
      ) : (
        <ul className="email-channel-mailboxes">
          {channel.mailboxes.map((mailbox) => {
            const badge = deliverabilityBadge(mailbox.deliverability);
            const isInbound = channel.inbound?.connectionId === mailbox.connectionId;
            const issues = [
              ...(mailbox.deliverability?.blockers ?? []),
              ...(mailbox.deliverability?.warnings ?? [])
            ];
            return (
              <li key={mailbox.connectionId}>
                <div className="email-channel-mailbox-head">
                  <div>
                    <strong>
                      {mailbox.address ?? mailbox.displayName ?? prettyProvider(mailbox.provider)}
                    </strong>
                    <span>
                      {prettyProvider(mailbox.provider)}
                      {isInbound ? ' · inbound mailbox' : ''}
                    </span>
                  </div>
                  <span className={`status-pill email-channel-pill-${badge.tone}`}>
                    {badge.label}
                  </span>
                </div>
                {issues.length > 0 && (
                  <ul className="email-channel-issues">
                    {issues.map((issue, index) => (
                      <li key={`${issue.code}:${index}`}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {isOwner && !isInbound && (
                  <Button
                    disabled={busy !== null}
                    onClick={() => onUseForInbound(mailbox.connectionId)}
                  >
                    {busy === `inbound:${mailbox.connectionId}`
                      ? 'Starting…'
                      : 'Use for inbound mail'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <dl className="email-channel-facts">
        <div>
          <dt>Inbound mail</dt>
          <dd>{inboundSentence(channel.inbound)}</dd>
        </div>
        <div>
          <dt>Unsubscribe</dt>
          <dd>{channel.unsubscribe.detail}</dd>
        </div>
      </dl>
      <div className="email-channel-actions">
        <Button disabled={busy !== null || channel.mailboxes.length === 0} onClick={onRecheck}>
          {busy === 'recheck' ? 'Checking…' : 'Re-check DNS'}
        </Button>
        {isOwner && channel.inbound && (
          <Button variant="ghost" disabled={busy !== null} onClick={onStopInbound}>
            {busy === 'stop' ? 'Stopping…' : 'Stop reading mail'}
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/client/EmailChannelSummary.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the API calls**

In `src/client/api.ts`, replace:

```ts
import type { GtmIntent, GtmPlan, PreparedGtmPlanResult } from '../server/gtm/intent';
```

with:

```ts
import type { GtmIntent, GtmPlan, PreparedGtmPlanResult } from '../server/gtm/intent';
import type { EmailChannelStatus } from '../server/email/types';
```

Directly after the closing `}` of `prepareCompiledGtmPlan` (L562), add:

```ts
export async function getEmailChannel(): Promise<EmailChannelStatus> {
  const result = await request<{ channel: EmailChannelStatus }>('/api/email/channel');
  return result.channel;
}

export async function chooseInboundMailbox(connectionId: string): Promise<EmailChannelStatus> {
  const result = await request<{ channel: EmailChannelStatus }>('/api/email/inbound-mailbox', {
    method: 'PUT',
    body: JSON.stringify({ connectionId })
  });
  return result.channel;
}

export async function stopInboundMailbox(): Promise<EmailChannelStatus> {
  const result = await request<{ channel: EmailChannelStatus }>('/api/email/inbound-mailbox', {
    method: 'DELETE'
  });
  return result.channel;
}

export async function recheckEmailDns(): Promise<EmailChannelStatus> {
  const result = await request<{ channel: EmailChannelStatus }>(
    '/api/email/deliverability/recheck',
    { method: 'POST' }
  );
  return result.channel;
}
```

- [ ] **Step 6: Write the stateful panel**

Create `src/client/EmailChannelPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import type { EmailChannelStatus } from '../server/email/types';
import { chooseInboundMailbox, getEmailChannel, recheckEmailDns, stopInboundMailbox } from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { EmailChannelSummary, type EmailChannelBusy } from './EmailChannelSummary';
import { Panel } from './ui/layout';

function problemText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function EmailChannelPanel({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [channel, setChannel] = useState<EmailChannelStatus | null>(null);
  const [busy, setBusy] = useState<EmailChannelBusy>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    getEmailChannel()
      .then((next) => {
        if (!cancelled) setChannel(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(problemText(error, 'The email channel could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (next: EmailChannelBusy, work: () => Promise<EmailChannelStatus>, done: string) => {
      setBusy(next);
      setProblem('');
      try {
        setChannel(await work());
        setToast(done);
      } catch (error) {
        setProblem(problemText(error, 'Nothing was changed.'));
      } finally {
        setBusy(null);
      }
    },
    [setToast]
  );

  return (
    <Panel
      title="Email"
      icon={<Mail size={18} />}
      description="Sending-domain checks, one-click unsubscribe, and the one mailbox Trevra reads."
    >
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {channel ? (
        <EmailChannelSummary
          channel={channel}
          isOwner={isOwner}
          busy={busy}
          onUseForInbound={(connectionId) =>
            void run(
              `inbound:${connectionId}`,
              () => chooseInboundMailbox(connectionId),
              'Inbound mailbox updated'
            )
          }
          onStopInbound={() =>
            void run('stop', stopInboundMailbox, 'Trevra stopped reading the mailbox')
          }
          onRecheck={() => void run('recheck', recheckEmailDns, 'DNS checked again')}
        />
      ) : problem ? null : (
        <p className="empty-copy">Checking your mailboxes…</p>
      )}
    </Panel>
  );
}
```

- [ ] **Step 7: Mount it next to the connections**

In `src/client/App.tsx`, replace:

```ts
import { TeamSettingsView } from './TeamScreen';
```

with:

```ts
import { TeamSettingsView } from './TeamScreen';
import { EmailChannelPanel } from './EmailChannelPanel';
```

and replace:

```tsx
          <ConnectionsView
            data={data}
            reload={reload}
            setToast={setToast}
            busyId={busyId}
            setBusyId={setBusyId}
          />
          <LimitsView setToast={setToast} />
```

with:

```tsx
          <ConnectionsView
            data={data}
            reload={reload}
            setToast={setToast}
            busyId={busyId}
            setBusyId={setBusyId}
          />
          <EmailChannelPanel setToast={setToast} />
          <LimitsView setToast={setToast} />
```

- [ ] **Step 8: Add layout-only styles**

In `src/client/styles.css`, replace:

```css
/* Opportunity-lite: fixed GTM stages, not a configurable CRM pipeline. */
```

with:

```css
/* Email channel (/setup/workspace): layout only; controls come from ui/primitives. */
.email-channel {
  display: grid;
  gap: 14px;
}
.email-channel-mailboxes {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.email-channel-mailboxes > li {
  display: grid;
  gap: 8px;
  justify-items: start;
  padding: 10px 12px;
  border: 1px solid var(--t-line-soft);
  border-radius: var(--t-r-md);
  background: var(--panel);
}
.email-channel-mailbox-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.email-channel-mailbox-head > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.email-channel-mailbox-head strong {
  overflow-wrap: anywhere;
}
.email-channel-mailbox-head > div > span,
.email-channel-issues,
.email-channel-facts dd {
  color: var(--muted);
  font-size: var(--t-text-xs);
}
.status-pill.email-channel-pill-fail {
  background: var(--t-red-bg);
  color: var(--t-red);
}
.status-pill.email-channel-pill-unknown {
  background: var(--t-amber-bg);
  color: var(--t-amber);
}
.email-channel-issues {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
}
.email-channel-facts {
  display: grid;
  gap: 10px;
  margin: 0;
}
.email-channel-facts dt {
  font-size: var(--t-text-sm);
  font-weight: var(--t-w-strong);
}
.email-channel-facts dd {
  margin: 2px 0 0;
}
.email-channel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* Opportunity-lite: fixed GTM stages, not a configurable CRM pipeline. */
```

The two status-pill modifiers reuse the red/amber tokens that `src/client/styles.css` already redefines for the dark theme. Buttons keep their shared skin and `--t-tap` height.

- [ ] **Step 9: Typecheck and look at it**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run `npm run dev`, open `/setup/workspace` as the owner, and check four things:

1. The Email panel renders beside Connections in the light and dark themes.
2. At a 390 px wide viewport the address wraps and nothing scrolls sideways.
3. Keyboard focus is visible on Use for inbound mail, Re-check DNS and Stop reading mail.
4. Signed in as a member, the inbound buttons are absent.

- [ ] **Step 10: Commit**

```bash
git add src/client/EmailChannelSummary.tsx src/client/EmailChannelSummary.test.tsx src/client/EmailChannelPanel.tsx src/client/api.ts src/client/App.tsx src/client/styles.css
git commit -m "feat(email): email channel panel on workspace settings" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 12: Email-only `prepare_outreach` compiles behind DNS and unsubscribe blockers

**Files:**

- Create: `src/server/email/outreach.ts` (readiness half; Task 14 adds preparation)
- Modify: `src/server/gtm/intent.ts`:
  - imports (L13);
  - `prepareOutreachPlan` (L415-453), plus a new `peopleBlockers` and `emailOutreachPlan`;
  - `prepareGtmPlan` (before L849).
- Test: `src/server/email/outreach-plan.test.ts`

**Interfaces:**

- Consumes:
  - `listSendingMailboxes`, `resolveMailboxAddress`, `getSenderDeliverability` with `markOutreach` (Task 3).
  - `emailDomainOf` (Task 2), `unsubscribeConfigured` (Task 4).
  - `email_inbound_mailboxes` (Task 1).
  - Lead-list tables: `linkedin_lead_lists(id, workspace_id, name)`, `linkedin_lead_list_members(workspace_id, list_id, contact_id)` (`migrations/052_linkedin_lead_list_membership.sql`), `linkedin_lead_contacts(email, do_not_contact, person_id)` (migrations 086 and 099), `contacts(email)`.
- Produces:
  - `src/server/email/outreach.ts`:
    - `interface EmailOutreachOptions { resolver?; now?; env? }`
    - `interface EmailOutreachSender { connectionId; address; provider }`
    - `interface EmailOutreachReadiness { blockers; warnings; listName; recipientCount; sender }`
    - `RECIPIENT_SQL` (shared with Task 14)
    - `emailOutreachReadiness(db, workspaceId, { leadListId }, options?)`
  - Plan blocker codes: `email_unsubscribe_unavailable`, `email_recipients_missing`, `email_sender_missing`, `email_sender_ambiguous`, `email_sender_address_unknown`, `email_deliverability_unknown`, plus the Task 2 DNS codes (`email_spf_*`, `email_dkim_missing`, `email_dmarc_*`).
  - The LinkedIn-only blocker `prepare_outreach_linkedin_only` becomes `prepare_outreach_single_channel`. It fires only when more than one channel, or `community`, is requested.
  - Warning code `email_replies_not_synced`, carried in `plan.defaults.warnings`.
  - Email plan `defaults`: `{ channel: 'email', leadListId, connectionId, senderAddress, recipientCount, warnings, prepareSupported }`. `next` is `{ kind: 'review_email_approvals', href: '/ledger' }`.

`defaults` is part of `planHash`, so it holds nothing time-dependent. Warnings come from the cached DNS row and the inbound designation, both stable between Show plan and Prepare.

Compiling an email plan calls `getSenderDeliverability` with `markOutreach: true`. That records the outreach intent which keeps the domain fresh in the worker and makes a failure eligible for Today (Task 10).

- [ ] **Step 1: Write the failing test**

Create `src/server/email/outreach-plan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent } from '../gtm/intent.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';

const WORKSPACE = 'ws_email_outreach_plan';
const CONNECTION = 'conn_email_outreach_plan';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
let db: Db;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-email-plan/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-email-plan/',
  'Lena,Frei,Globex,,https://www.linkedin.com/in/lena-email-plan/'
].join('\n');

async function seedMailbox(id = CONNECTION, address = 'founder@acme.test'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?,?)`
    )
    .run(id, WORKSPACE, `${id}-external`, address, NOW.toISOString(), NOW.toISOString());
}

async function seedCheck(status: 'pass' | 'fail', blockers: unknown[] = []): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
        checked_at,expires_at)
       VALUES (?,'acme.test','google',?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,
               ?::timestamptz,'2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, status, PASSING, PASSING, PASSING, JSON.stringify(blockers), NOW.toISOString());
}

async function peopleList(rows = csv): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Email founders' }, NOW);
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv: rows }, NOW);
  return list.id;
}

function emailIntent(listId: string) {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function codes(intent: unknown): Promise<string[]> {
  return (await compileGtmIntent(db, WORKSPACE, intent)).blockers.map((blocker) => blocker.code);
}

beforeEach(async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach plan', NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('email-only prepare_outreach plans', () => {
  it('compiles a deterministic email plan from one passing sender', async () => {
    await seedMailbox();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    const again = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));

    expect(again.planHash).toBe(plan.planHash);
    expect(plan.blockers).toEqual([]);
    expect(plan.summary).toBe('Email 2 People in Email founders from founder@acme.test');
    expect(plan.defaults).toEqual({
      channel: 'email',
      leadListId: listId,
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      recipientCount: 2,
      warnings: [
        {
          code: 'email_replies_not_synced',
          message:
            'Replies to founder@acme.test are not read into Conversations. Choose it as the inbound mailbox in Workspace settings.',
          actionHref: '/setup/workspace'
        }
      ],
      prepareSupported: true
    });
    expect(plan.steps.map((step) => [step.kind, step.externalEffect])).toEqual([
      ['people', false],
      ['sender', false],
      ['approval', false],
      ['send', true]
    ]);
    expect(plan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });
    expect(plan.next).toEqual({ kind: 'review_email_approvals', href: '/ledger' });

    const marked = await db
      .prepare('SELECT outreach_requested_at FROM email_deliverability_checks WHERE workspace_id=?')
      .get<{ outreach_requested_at: string | null }>(WORKSPACE);
    expect(marked?.outreach_requested_at).not.toBeNull();
  });

  it('drops the replies warning once the sender is the syncing inbound mailbox', async () => {
    await seedMailbox();
    await seedCheck('pass');
    const listId = await peopleList();
    await db
      .prepare(
        `INSERT INTO email_inbound_mailboxes
         (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
         VALUES (?,?,'founder@acme.test','syncing',?,?)`
      )
      .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.defaults.warnings).toEqual([]);
    expect(plan.defaults.prepareSupported).toBe(true);
  });

  it('blocks without a one-click unsubscribe origin', async () => {
    vi.stubEnv('TREVRA_PUBLIC_API_URL', '');
    await seedMailbox();
    await seedCheck('pass');
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['email_unsubscribe_unavailable']);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('turns SPF, DKIM and DMARC failures into plan blockers', async () => {
    await seedMailbox();
    const dkim = {
      code: 'email_dkim_missing',
      message: 'No DKIM key is published for acme.test at google._domainkey.',
      actionHref: '/setup/workspace'
    };
    await seedCheck('fail', [dkim]);
    const listId = await peopleList();

    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent(listId));
    expect(plan.blockers).toEqual([dkim]);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('treats a DNS answer it could not get as a blocker, never a pass', async () => {
    await seedMailbox();
    const listId = await peopleList();

    expect(await codes(emailIntent(listId))).toEqual(['email_deliverability_unknown']);
    const stored = await db
      .prepare('SELECT status FROM email_deliverability_checks WHERE workspace_id=?')
      .get<{ status: string }>(WORKSPACE);
    expect(stored?.status).toBe('unknown');
  });

  it('names the missing, ambiguous or unusable piece', async () => {
    await seedCheck('pass');
    const listId = await peopleList();
    expect(await codes(emailIntent(listId))).toEqual(['email_sender_missing']);

    await seedMailbox();
    await seedMailbox('conn_email_outreach_plan_2', 'sales@acme.test');
    expect(await codes(emailIntent(listId))).toEqual(['email_sender_ambiguous']);

    await db
      .prepare('DELETE FROM connections WHERE workspace_id=? AND id=?')
      .run(WORKSPACE, 'conn_email_outreach_plan_2');
    const withoutEmail = await peopleList(
      [
        'First Name,Last Name,Company,Email,LinkedIn URL',
        'Ida,Brun,Initech,,https://www.linkedin.com/in/ida-email-plan/'
      ].join('\n')
    );
    expect(await codes(emailIntent(withoutEmail))).toEqual(['email_recipients_missing']);
    expect(await codes(emailIntent('lilst_missing'))).toEqual(['lead_list_not_found']);
    expect(
      await codes({ ...emailIntent(listId), people: { uploadedInputRef: 'upload://people.csv' } })
    ).toEqual(['uploaded_input_not_materialized']);
    expect(
      await codes({
        ...emailIntent(listId),
        channels: ['email', 'linkedin'] as Array<'linkedin' | 'email' | 'community'>
      })
    ).toContain('prepare_outreach_single_channel');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-plan.test.ts`
Expected: FAIL. Every email intent still compiles through the LinkedIn path, so the blockers start with `prepare_outreach_linkedin_only` and the defaults say `channel: 'linkedin'`.

- [ ] **Step 3: Write the readiness module**

Create `src/server/email/outreach.ts`:

```ts
import type { Db } from '../db.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import type { EmailChannelIssue, MailProvider } from './types.js';
import { unsubscribeConfigured } from './unsubscribe.js';

export interface EmailOutreachOptions {
  resolver?: DnsResolver;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface EmailOutreachSender {
  connectionId: string;
  address: string;
  provider: MailProvider;
}

export interface EmailOutreachReadiness {
  blockers: EmailChannelIssue[];
  warnings: EmailChannelIssue[];
  listName: string | null;
  recipientCount: number;
  sender: EmailOutreachSender | null;
}

const SETUP_HREF = '/setup/workspace';
const PEOPLE_HREF = '/outreach/new';

/**
 * A lead-list member's address, for a query that joins linkedin_lead_contacts
 * as `lc` and LEFT JOINs contacts as `p`: the canonical Person's email when it
 * has one, else the address imported with the lead. Lower-cased so suppression,
 * already-emailed and recipient comparisons all see one spelling.
 */
export const RECIPIENT_SQL = `LOWER(COALESCE(NULLIF(BTRIM(p.email),''),NULLIF(BTRIM(lc.email),'')))`;

/**
 * Everything that must be true before Trevra prepares outreach email. Every
 * answer here is deterministic for a given workspace state, because it ends up
 * inside the plan hash.
 */
export async function emailOutreachReadiness(
  db: Db,
  workspaceId: string,
  input: { leadListId: string | null },
  options: EmailOutreachOptions = {}
): Promise<EmailOutreachReadiness> {
  const env = options.env ?? process.env;
  const blockers: EmailChannelIssue[] = [];
  const warnings: EmailChannelIssue[] = [];

  let listName: string | null = null;
  let recipientCount = 0;
  if (input.leadListId) {
    const list = await db
      .prepare('SELECT id,name FROM linkedin_lead_lists WHERE workspace_id=? AND id=? LIMIT 1')
      .get<{ id: string; name: string }>(workspaceId, input.leadListId);
    if (!list) {
      blockers.push({
        code: 'lead_list_not_found',
        message: 'The selected People list no longer exists in this workspace.',
        actionHref: PEOPLE_HREF
      });
    } else {
      listName = list.name;
      const counted = await db
        .prepare(
          `SELECT COUNT(*)::int AS total
           FROM linkedin_lead_list_members m
           JOIN linkedin_lead_contacts lc ON lc.workspace_id=m.workspace_id AND lc.id=m.contact_id
           LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
           WHERE m.workspace_id=? AND m.list_id=? AND lc.do_not_contact=FALSE
             AND ${RECIPIENT_SQL} IS NOT NULL`
        )
        .get<{ total: number }>(workspaceId, list.id);
      recipientCount = counted?.total ?? 0;
      if (recipientCount === 0) {
        blockers.push({
          code: 'email_recipients_missing',
          message: `Nobody in ${list.name} has an email address Trevra may write to.`,
          actionHref: PEOPLE_HREF
        });
      }
    }
  }

  if (!unsubscribeConfigured(env)) {
    blockers.push({
      code: 'email_unsubscribe_unavailable',
      message:
        'One-click unsubscribe needs an HTTPS TREVRA_PUBLIC_API_URL and TREVRA_SECRETS_KEY on the server. Trevra will not prepare outreach email without it.',
      actionHref: SETUP_HREF
    });
  }

  const mailboxes = await listSendingMailboxes(db, workspaceId);
  let sender: EmailOutreachSender | null = null;
  if (mailboxes.length === 0) {
    blockers.push({
      code: 'email_sender_missing',
      message: 'Connect the Gmail or Microsoft 365 mailbox you want to send outreach from.',
      actionHref: SETUP_HREF
    });
  } else if (mailboxes.length > 1) {
    // lc-debt: email outreach requires exactly one connected sending mailbox; upgrade path: add an explicit sender connection to the GTM intent and plan defaults once founders send from more than one mailbox.
    blockers.push({
      code: 'email_sender_ambiguous',
      message:
        'More than one mailbox is connected. Disconnect the ones you do not send outreach from; choosing a sender per plan is not supported yet.',
      actionHref: SETUP_HREF
    });
  } else {
    const mailbox = mailboxes[0]!;
    const address = await resolveMailboxAddress(db, workspaceId, mailbox);
    const domain = address ? emailDomainOf(address) : null;
    if (!address || !domain) {
      blockers.push({
        code: 'email_sender_address_unknown',
        message:
          'Trevra could not read the address of your connected mailbox. Reconnect it and plan again.',
        actionHref: SETUP_HREF
      });
    } else {
      sender = { connectionId: mailbox.connectionId, address, provider: mailbox.providerKey };
      const deliverability = await getSenderDeliverability(
        db,
        workspaceId,
        { domain, provider: mailbox.providerKey, markOutreach: true },
        { resolver: options.resolver, now: options.now }
      );
      if (deliverability.status === 'fail') blockers.push(...deliverability.blockers);
      if (deliverability.status === 'unknown') {
        const unanswered = [deliverability.spf, deliverability.dkim, deliverability.dmarc].find(
          (check) => check.status === 'unknown'
        );
        blockers.push({
          code: 'email_deliverability_unknown',
          message: `Trevra could not confirm SPF, DKIM and DMARC for ${domain}${
            unanswered ? `: ${unanswered.detail}` : '.'
          } Re-check DNS once it answers.`,
          actionHref: SETUP_HREF
        });
      }
      warnings.push(...deliverability.warnings);

      const inbound = await db
        .prepare(
          'SELECT connection_id,sync_status FROM email_inbound_mailboxes WHERE workspace_id=?'
        )
        .get<{ connection_id: string; sync_status: string }>(workspaceId);
      if (
        !inbound ||
        inbound.sync_status !== 'syncing' ||
        inbound.connection_id !== mailbox.connectionId
      ) {
        warnings.push({
          code: 'email_replies_not_synced',
          message: `Replies to ${address} are not read into Conversations. Choose it as the inbound mailbox in Workspace settings.`,
          actionHref: SETUP_HREF
        });
      }
    }
  }

  return { blockers, warnings, listName, recipientCount, sender };
}
```

- [ ] **Step 4: Route email-only intents to the email plan**

In `src/server/gtm/intent.ts`, replace:

```ts
import { secretsConfigured } from '../secrets/crypto.js';
```

with:

```ts
import { secretsConfigured } from '../secrets/crypto.js';
import { emailOutreachReadiness } from '../email/outreach.js';
```

Then replace the start of `prepareOutreachPlan`:

```ts
async function prepareOutreachPlan(
  db: Db,
  workspaceId: string,
  intent: GtmIntent
): Promise<GtmPlan> {
  const blockers: GtmPlanBlocker[] = [];
  const requestedChannels = intent.channels?.length ? intent.channels : ['linkedin'];
  if (requestedChannels.length !== 1 || requestedChannels[0] !== 'linkedin') {
    blockers.push({
      code: 'prepare_outreach_linkedin_only',
      message: 'The generic preparation compiler currently prepares LinkedIn outreach only.',
      actionHref: '/outreach/new'
    });
  }

  const existingListId = intent.people?.existingListId ?? null;
  const uploadedInputRef = intent.people?.uploadedInputRef ?? null;
  if (!existingListId && !uploadedInputRef) {
    blockers.push({
      code: 'people_required',
      message: 'Choose known People before Trevra can prepare outreach.',
      actionHref: '/outreach/new'
    });
  }
  if (existingListId && uploadedInputRef) {
    blockers.push({
      code: 'people_source_ambiguous',
      message: 'Choose one People source, not both an existing list and an uploaded input.',
      actionHref: '/outreach/new'
    });
  }
  if (uploadedInputRef) {
    blockers.push({
      code: 'uploaded_input_not_materialized',
      message:
        'The generic compiler does not materialize uploaded-input references yet. Use Prepare outreach for CSV input.',
      actionHref: '/outreach/new'
    });
  }
```

with:

```ts
/** People-source blockers shared by the LinkedIn and email outreach plans. */
function peopleBlockers(intent: GtmIntent): GtmPlanBlocker[] {
  const blockers: GtmPlanBlocker[] = [];
  const existingListId = intent.people?.existingListId ?? null;
  const uploadedInputRef = intent.people?.uploadedInputRef ?? null;
  if (!existingListId && !uploadedInputRef) {
    blockers.push({
      code: 'people_required',
      message: 'Choose known People before Trevra can prepare outreach.',
      actionHref: '/outreach/new'
    });
  }
  if (existingListId && uploadedInputRef) {
    blockers.push({
      code: 'people_source_ambiguous',
      message: 'Choose one People source, not both an existing list and an uploaded input.',
      actionHref: '/outreach/new'
    });
  }
  if (uploadedInputRef) {
    blockers.push({
      code: 'uploaded_input_not_materialized',
      message:
        'The generic compiler does not materialize uploaded-input references yet. Use Prepare outreach for CSV input.',
      actionHref: '/outreach/new'
    });
  }
  return blockers;
}

async function prepareOutreachPlan(
  db: Db,
  workspaceId: string,
  intent: GtmIntent
): Promise<GtmPlan> {
  const requestedChannels = intent.channels?.length ? intent.channels : ['linkedin'];
  if (requestedChannels.length === 1 && requestedChannels[0] === 'email') {
    return emailOutreachPlan(db, workspaceId, intent);
  }
  const blockers: GtmPlanBlocker[] = [];
  if (requestedChannels.length !== 1 || requestedChannels[0] !== 'linkedin') {
    blockers.push({
      code: 'prepare_outreach_single_channel',
      message: 'Prepare outreach for one channel at a time: LinkedIn or email.',
      actionHref: '/outreach/new'
    });
  }
  blockers.push(...peopleBlockers(intent));

  const existingListId = intent.people?.existingListId ?? null;
```

The rest of `prepareOutreachPlan` only reads `existingListId`, so it is unchanged. A LinkedIn plan keeps its blocker order and therefore its plan hash.

Directly after the closing `}` of `prepareOutreachPlan` (before `async function accountPlan`), add:

```ts
async function emailOutreachPlan(db: Db, workspaceId: string, intent: GtmIntent): Promise<GtmPlan> {
  const blockers = peopleBlockers(intent);
  const existingListId = intent.people?.existingListId ?? null;
  const readiness = await emailOutreachReadiness(db, workspaceId, { leadListId: existingListId });
  blockers.push(...readiness.blockers);
  const sender = readiness.sender;
  const listLabel = readiness.listName ?? 'the selected People list';
  return finalizePlan({
    objective: 'prepare_outreach',
    intent,
    summary: existingListId
      ? `Email ${readiness.recipientCount} People in ${listLabel}${sender ? ` from ${sender.address}` : ''}`
      : 'Prepare outreach email from known People',
    steps: [
      {
        kind: 'people',
        title: 'People',
        detail: existingListId
          ? `Write only to People in ${listLabel} who have an email address and are not marked do-not-contact. Suppressed, already-emailed and already-pending People are skipped.`
          : 'Resolve the supplied People input without inventing identities.',
        externalEffect: false
      },
      {
        kind: 'sender',
        title: 'Sender',
        detail: sender
          ? `Send from ${sender.address}. SPF, DKIM and DMARC for its domain must pass.`
          : 'Connect exactly one Gmail or Microsoft 365 mailbox to send from.',
        externalEffect: false
      },
      {
        kind: 'approval',
        title: 'Emails ready for review',
        detail:
          'Prepare one first-touch email per Person. Each waits for your approval of its exact text. Preparing sends nothing.',
        externalEffect: false
      },
      {
        kind: 'send',
        title: 'Send after approval',
        detail:
          'Each approved email leaves from the approved mailbox with a one-click unsubscribe link.',
        externalEffect: true
      }
    ],
    blockers,
    defaults: {
      channel: 'email',
      leadListId: existingListId,
      connectionId: sender?.connectionId ?? null,
      senderAddress: sender?.address ?? null,
      recipientCount: readiness.recipientCount,
      warnings: readiness.warnings,
      prepareSupported: blockers.length === 0 && Boolean(existingListId && sender)
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    },
    next: { kind: 'review_email_approvals', href: '/ledger' }
  });
}
```

In `prepareGtmPlan`, replace:

```ts
  const existingLeadListId = current.intent.people?.existingListId;
  const senderKey =
```

with:

```ts
  if (current.defaults.channel === 'email') {
    throw new GtmPlanError('Email outreach preparation is not available yet.', 409);
  }

  const existingLeadListId = current.intent.people?.existingListId;
  const senderKey =
```

This guard keeps an email plan from falling into the LinkedIn preparation path. Task 14 replaces it with the real preparation.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-plan.test.ts src/server/gtm/intent.test.ts`
Expected: PASS. The existing LinkedIn intent tests are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/email/outreach.ts src/server/email/outreach-plan.test.ts src/server/gtm/intent.ts
git commit -m "feat(gtm): compile email-only outreach plans behind DNS and unsubscribe blockers" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 13: `gtm.email-outreach` playbook, bound to the approved mailbox

**Files:**

- Modify: `src/server/playbooks/registry.ts`: a new definition before `export const bufferDraftPlaybook` (L495), and its registration (L550).
- Modify: `src/server/control-plane/execution.ts`: imports (L1-7) and the `email.send` branch (L42-52).
- Modify: `src/server/integration-service.ts`: the connection fallback in `executeConnectedAction` (L524-530).
- Test: `src/server/email/outreach-playbook.test.ts`

**Interfaces:**

- Consumes:
  - `PlaybookDefinition` (`src/server/playbooks/types.ts:41`), `registerPlaybook`.
  - `startPlaybookRun` and `decidePlaybookApproval` (`src/server/playbooks/engine.ts:39`, `:224`).
  - `listSendingMailboxes` and `resolveMailboxAddress` (Task 3).
  - The `requireListUnsubscribe` flag (Task 5).
  - `projectPreparedConversationEmail` (`src/server/conversations.ts:455`), which only projects when the Person's email equals the recipient.
- Produces:
  - Playbook `gtm.email-outreach` v1.0.0, exported as `emailOutreachPlaybook`. Its input is `{ idempotencyKey, conversationId, personId, contactId, leadListId, connectionId, senderAddress, recipient, subject, body }`, all strings.
  - Steps `approve-outreach` (approval) and `send-outreach` (`email.send`, one attempt).
  - Approval metadata:
    - `connectionId`, `senderAddress`, `requireListUnsubscribe: true`
    - `deliveryPurpose: 'outreach'`, `deliverySourceType: 'email_outreach'`, `deliverySourceId: idempotencyKey`
    - `conversationSourceType: 'email_outreach'`, `conversationSourceId: idempotencyKey`, `intent: 'email-outreach'`
    - plus `conversationId`, `personId`, `contactId`, `leadListId`.
  - `executeConnectedAction` honours `require_connection_id: true`: it answers 409 instead of falling back to another mailbox.
  - `email.send` with `metadata.connectionId` or `metadata.senderAddress` answers 409 before any provider call in two cases: the connection is not a live sending mailbox, or its provider-verified address differs from `senderAddress`.

The playbook runs through the existing closed `email.send` action and exact-payload approval. Nothing new can write externally.

Without the binding, `executeConnectedAction` silently falls back to the newest connected mailbox (L524-530). An email approved as `founder@acme.test` could then leave from a mailbox connected later. The binding applies only when the approval names a sender, so conversation replies and the qualified-demand playbook keep their current mailbox resolution.

- [ ] **Step 1: Write the failing test**

Create `src/server/email/outreach-playbook.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} })),
  post: vi.fn(async (_config: Record<string, unknown>) => ({
    data: { id: 'gmail-outreach-1' },
    headers: {}
  }))
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { executePreparedPlaybookAction } from '../control-plane/execution.js';
import { ensureConversationForPerson } from '../conversations.js';
import { openDatabase, type Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { decidePlaybookApproval, startPlaybookRun } from '../playbooks/engine.js';

const WORKSPACE = 'ws_email_outreach_playbook';
const USER = 'usr_email_outreach_playbook';
const CONNECTION = 'conn_email_outreach_playbook';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const KEY = 'eo_playbook_test_0001';
const BODY = 'Hi Maya,\n\nWould you be open to a short conversation?';
let db: Db;

async function seedMailbox(id: string, address: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?,?)`
    )
    .run(id, WORKSPACE, `${id}-external`, address, NOW.toISOString(), NOW.toISOString());
}

async function prepareRun() {
  const person = await resolveContact(
    db,
    WORKSPACE,
    { name: 'Maya Chen', email: 'maya@northwind.test' },
    NOW
  );
  const conversationId = await ensureConversationForPerson(db, WORKSPACE, person.contact.id, NOW);
  const run = await startPlaybookRun(db, {
    workspaceId: WORKSPACE,
    playbookId: 'gtm.email-outreach',
    payload: {
      idempotencyKey: KEY,
      conversationId,
      personId: person.contact.id,
      contactId: 'lilc_playbook_test',
      leadListId: 'lilst_playbook_test',
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      recipient: 'maya@northwind.test',
      subject: 'Quick question, Maya',
      body: BODY
    },
    actorType: 'user',
    actorId: USER
  });
  return { run, personId: person.contact.id, conversationId };
}

function approve(runId: string) {
  return decidePlaybookApproval(db, {
    workspaceId: WORKSPACE,
    runId,
    stepId: 'approve-outreach',
    userId: USER,
    decision: 'approve'
  });
}

async function deliveries(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
    .get<{ total: number }>(WORKSPACE);
  return row?.total ?? 0;
}

beforeEach(async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockClear();
  nangoMock.post.mockClear();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach playbook', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@email-outreach-playbook.test', 'Founder', NOW.toISOString());
  await seedMailbox(CONNECTION, 'founder@acme.test');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('gtm.email-outreach', () => {
  it('waits for approval of the exact email, then sends it from the approved mailbox', async () => {
    const { run, personId, conversationId } = await prepareRun();

    expect(run.status).toBe('waiting_approval');
    expect(run.steps.find((step) => step.stepId === 'approve-outreach')?.input).toEqual({
      recipient: 'maya@northwind.test',
      subject: 'Quick question, Maya',
      body: BODY,
      metadata: {
        conversationId,
        personId,
        contactId: 'lilc_playbook_test',
        leadListId: 'lilst_playbook_test',
        connectionId: CONNECTION,
        senderAddress: 'founder@acme.test',
        requireListUnsubscribe: true,
        deliveryPurpose: 'outreach',
        deliverySourceType: 'email_outreach',
        deliverySourceId: KEY,
        conversationSourceType: 'email_outreach',
        conversationSourceId: KEY,
        intent: 'email-outreach'
      }
    });
    expect(nangoMock.post).not.toHaveBeenCalled();

    const done = await approve(run.id);

    expect(done.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    const send = nangoMock.post.mock.calls[0]![0] as {
      endpoint?: string;
      connectionId?: string;
      data?: { raw?: string };
    };
    expect(send.endpoint).toBe('/gmail/v1/users/me/messages/send');
    expect(send.connectionId).toBe(`${CONNECTION}-external`);
    const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
    expect(mime).toContain('To: maya@northwind.test');
    expect(mime).toContain('List-Unsubscribe: <https://api.trevra.test/u/del_');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');

    expect(
      await db
        .prepare(
          'SELECT connection_id,purpose,source_type,source_id,status FROM gtm_deliveries WHERE workspace_id=?'
        )
        .get(WORKSPACE)
    ).toEqual({
      connection_id: CONNECTION,
      purpose: 'outreach',
      source_type: 'email_outreach',
      source_id: KEY,
      status: 'sent'
    });
    expect(
      await db
        .prepare(
          `SELECT direction,source_type,source_id,body FROM conversation_messages
           WHERE workspace_id=? AND conversation_id=?`
        )
        .all(WORKSPACE, conversationId)
    ).toEqual([
      { direction: 'outbound', source_type: 'email_outreach', source_id: KEY, body: BODY }
    ]);
  });

  it('refuses to send when the approved mailbox now answers as someone else', async () => {
    const { run } = await prepareRun();
    await db
      .prepare('UPDATE connections SET mailbox_address=? WHERE workspace_id=? AND id=?')
      .run('sales@acme.test', WORKSPACE, CONNECTION);

    const failed = await approve(run.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer matches the approved sender founder@acme\.test/);
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('never falls back to another connected mailbox, even one with the same address', async () => {
    const { run } = await prepareRun();
    await db
      .prepare("UPDATE connections SET status='disconnected' WHERE workspace_id=? AND id=?")
      .run(WORKSPACE, CONNECTION);
    await seedMailbox('conn_email_outreach_playbook_2', 'founder@acme.test');

    const failed = await approve(run.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer connected/);
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it('answers 409 for a half-bound approval or a required connection that is gone', async () => {
    await expect(
      executePreparedPlaybookAction(db, {
        workspaceId: WORKSPACE,
        actionType: 'email.send',
        payload: {
          recipient: 'maya@northwind.test',
          subject: 'Hello',
          body: 'Hi',
          metadata: { connectionId: CONNECTION }
        },
        payloadHash: 'half-bound-approval-key'
      })
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_gone',
        require_connection_id: true,
        recipient: 'maya@northwind.test',
        subject: 'Hello',
        body: 'Hi',
        structured_payload_json: '{}',
        payload_hash: 'required-connection-key'
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-playbook.test.ts`
Expected: FAIL. `startPlaybookRun` throws `Unknown playbook: gtm.email-outreach`, and the 409 test sees the fallback mailbox send.

- [ ] **Step 3: Define the playbook**

In `src/server/playbooks/registry.ts`, insert directly before `export const bufferDraftPlaybook: PlaybookDefinition = {`:

```ts
export const emailOutreachPlaybook: PlaybookDefinition = {
  id: 'gtm.email-outreach',
  version: '1.0.0',
  name: 'Outreach email',
  description:
    'Prepare one first-touch outreach email to a known Person from the approved mailbox, with RFC 8058 one-click unsubscribe, and require approval of the exact bytes before provider execution.',
  inputSchema: z
    .object({
      idempotencyKey: z.string().trim().min(8).max(200),
      conversationId: z.string().trim().min(1).max(160),
      personId: z.string().trim().min(1).max(160),
      contactId: z.string().trim().min(1).max(160),
      leadListId: z.string().trim().min(1).max(160),
      connectionId: z.string().trim().min(1).max(160),
      senderAddress: z.string().email(),
      recipient: z.string().email(),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000)
    })
    .strict(),
  steps: [
    {
      id: 'approve-outreach',
      type: 'approval',
      title: 'Approve outreach email',
      payload: {
        recipient: { $ref: '$.input.recipient' },
        subject: { $ref: '$.input.subject' },
        body: { $ref: '$.input.body' },
        metadata: {
          conversationId: { $ref: '$.input.conversationId' },
          personId: { $ref: '$.input.personId' },
          contactId: { $ref: '$.input.contactId' },
          leadListId: { $ref: '$.input.leadListId' },
          connectionId: { $ref: '$.input.connectionId' },
          senderAddress: { $ref: '$.input.senderAddress' },
          requireListUnsubscribe: true,
          deliveryPurpose: 'outreach',
          deliverySourceType: 'email_outreach',
          deliverySourceId: { $ref: '$.input.idempotencyKey' },
          conversationSourceType: 'email_outreach',
          conversationSourceId: { $ref: '$.input.idempotencyKey' },
          intent: 'email-outreach'
        }
      }
    },
    {
      id: 'send-outreach',
      type: 'action',
      actionType: 'email.send',
      approvalStepId: 'approve-outreach',
      needs: ['approve-outreach'],
      payload: { $ref: '$.steps.approve-outreach.input' },
      retry: { maxAttempts: 1, delaySeconds: 0 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-outreach.output.approved' },
    delivery: { $ref: '$.steps.send-outreach.output' },
    personId: { $ref: '$.input.personId' }
  },
  source: { type: 'builtin' }
};
```

and replace:

```ts
registerPlaybook(conversationEmailReplyPlaybook);
```

with:

```ts
registerPlaybook(conversationEmailReplyPlaybook);
registerPlaybook(emailOutreachPlaybook);
```

`openDatabase` seeds every registered playbook, and workspaces have builtins enabled by default (`COALESCE(wp.enabled,TRUE)`), so no migration row is needed.

- [ ] **Step 4: Refuse the silent mailbox fallback when a connection is required**

In `src/server/integration-service.ts` `executeConnectedAction`, replace:

```ts
  if (!connection) {
    connection = (await db
```

with:

```ts
  if (!connection && action.require_connection_id === true) {
    // An approval bound to one mailbox never falls back to another one.
    throw Object.assign(
      new Error('The mailbox this email was approved to send from is not connected; nothing was sent.'),
      { status: 409 }
    );
  }
  if (!connection) {
    connection = (await db
```

This throws before `claimEmailDelivery`, so no delivery row exists and nothing turns `uncertain`.

- [ ] **Step 5: Bind `email.send` to the approved mailbox**

In `src/server/control-plane/execution.ts`, replace:

```ts
import { executeConnectedAction } from '../integration-service.js';
```

with:

```ts
import { executeConnectedAction } from '../integration-service.js';
import { listSendingMailboxes, resolveMailboxAddress } from '../email/mailbox-address.js';
```

Replace:

```ts
    const payload = emailPayloadSchema.parse(input.payload);
    const metadata = payload.metadata ?? {};
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      recipient: payload.recipient,
```

with:

```ts
    const payload = emailPayloadSchema.parse(input.payload);
    const metadata = payload.metadata ?? {};
    const approvedConnectionId = await approvedMailboxConnection(db, input.workspaceId, metadata);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      ...(approvedConnectionId
        ? { connection_id: approvedConnectionId, require_connection_id: true }
        : {}),
      recipient: payload.recipient,
```

At the end of the file, add:

```ts
function mailboxBindingError(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The local connection an approved email must leave from, or null when the
 * approval named no sender (conversation replies and the older email playbooks
 * keep their existing mailbox resolution). The approval bound both the
 * connection and the address it sends as. If either no longer holds, nothing is
 * sent: a re-authorized connection may now be a different account.
 */
async function approvedMailboxConnection(
  db: Db,
  workspaceId: string,
  metadata: Record<string, unknown>
): Promise<string | null> {
  if (absent(metadata.connectionId) && absent(metadata.senderAddress)) return null;
  const connectionId =
    typeof metadata.connectionId === 'string' ? metadata.connectionId.trim() : '';
  const senderAddress =
    typeof metadata.senderAddress === 'string' ? metadata.senderAddress.trim().toLowerCase() : '';
  if (!connectionId || !senderAddress) {
    throw mailboxBindingError(
      'This email was approved without a complete sending mailbox; nothing was sent.'
    );
  }
  const mailbox = (await listSendingMailboxes(db, workspaceId)).find(
    (candidate) => candidate.connectionId === connectionId
  );
  if (!mailbox) {
    throw mailboxBindingError(
      `The mailbox this email was approved to send from (${senderAddress}) is no longer connected; nothing was sent.`
    );
  }
  const address = await resolveMailboxAddress(db, workspaceId, mailbox);
  if (address !== senderAddress) {
    throw mailboxBindingError(
      `The connected mailbox no longer matches the approved sender ${senderAddress}; nothing was sent.`
    );
  }
  return mailbox.connectionId;
}
```

`mailbox-address.ts` already imports `integration-service.ts`, which `execution.ts` imports too. Nothing imports `execution.ts` back from either, so no import cycle is introduced.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-playbook.test.ts src/server/conversation-replies.test.ts src/server/integration-service.test.ts src/server/playbooks/engine.test.ts`
Expected: PASS. The existing reply and engine tests show the unbound paths are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/server/playbooks/registry.ts src/server/control-plane/execution.ts src/server/integration-service.ts src/server/email/outreach-playbook.test.ts
git commit -m "feat(email): outreach playbook bound to the approved mailbox" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 14: Prepare email-only outreach: one approval per eligible Person

**Files:**

- Modify: `src/server/email/outreach.ts`: imports, plus the preparation half.
- Modify: `src/server/gtm/intent.ts`:
  - the Task 12 import;
  - `PreparedOutreachGtmPlanResult` (L110-116) and the `PreparedGtmPlanResult` union (L148-149);
  - the Task 12 guard in `prepareGtmPlan`;
  - the LinkedIn return (L866-872).
- Modify: `src/server/gtm/intent.test.ts`: the narrowing at L338 and L357.
- Create: `src/client/views/gtmPlanFormat.ts`
- Modify: `src/client/views/LoopView.tsx`: imports (L26) and the prepared-result branch (L1361-1374).
- Test: `src/server/email/outreach.test.ts`, `src/client/views/gtmPlanFormat.test.ts`

**Interfaces:**

- Consumes:
  - `RECIPIENT_SQL`, `emailOutreachReadiness` (Task 12).
  - `gtm.email-outreach` and the mailbox binding (Task 13).
  - `email_outreach_preparations` and the two `playbook_runs` unique indexes (Task 1).
  - `EmailOutreachSkipReason` and `PreparedEmailOutreachResult` (Task 2).
  - `ensureConversationForPerson` (`src/server/conversations.ts:104`), `startPlaybookRun` (`src/server/playbooks/engine.ts:39`), `findSuppression` (`src/server/suppressions.ts:83`).
  - `LEAD_CONTACT_READ_LIMIT` (`src/server/linkedin/lead-lists.ts:35`).
- Produces:
  - In `src/server/email/outreach.ts`:
    - `class EmailOutreachError(message, status = 409)`
    - `EMAIL_OUTREACH_PLAYBOOK_ID`
    - `emailOutreachRunKey(workspaceId, idempotencyKey, contactId)`
    - `firstTouchEmail({ firstName, company })`
    - `prepareEmailOutreach(db, { workspaceId, actorUserId, idempotencyKey, planHash, leadListId, connectionId, senderAddress }, now?)`
  - In `src/server/gtm/intent.ts`:
    - `PreparedOutreachGtmPlanResult` gains `channel: 'linkedin'`.
    - New `PreparedEmailOutreachGtmPlanResult { status: 'prepared'; objective: 'prepare_outreach'; channel: 'email'; artifacts: { runIds }; next: { kind: 'review_email_approvals'; href: '/ledger' }; result: PreparedEmailOutreachResult }`.
  - `emailSkipSummary(skipped)` in `src/client/views/gtmPlanFormat.ts`.

Preparation never sends. It creates one `gtm.email-outreach` run per eligible Person, each waiting for approval of its exact email.

All three guarantees below hold without one wrapping transaction (`startPlaybookRun` opens its own):

- **One request.** A repeated prepare key with the same plan hash replays the receipt. With a different plan hash it answers 409.
- **One run per Person per key.** The run key is derived from the prepare key and the lead contact. The unique index on it makes two racing prepares with one key converge on the same runs.
- **One open email per Person.** The open-person unique index refuses a second pending email for a Person. The race loser reports `already_pending`.

Each eligible member is checked in this order, and the first matching reason wins:

| Check                                                                                      | Result                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| No valid address                                                                           | `no_email`                                 |
| No resolved Person                                                                         | `unresolved_person`                        |
| Open run already exists under this run's own key                                           | Reused as prepared (a retry after a crash) |
| `do_not_contact`                                                                           | `do_not_contact`                           |
| Email suppression for the Person or address                                                | `suppressed`                               |
| An outreach delivery to that address is `sending`, `sent` or `uncertain`                   | `already_contacted`                        |
| An open run for the Person under another key, or an address already prepared in this batch | `already_pending`                          |

The already-handled sets are loaded once, so members that were already prepared or emailed do not count toward the 200-run cap. The next prepare therefore moves on to new People.

- [ ] **Step 1: Write the failing server test**

Create `src/server/email/outreach.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} })),
  post: vi.fn(async (_config: Record<string, unknown>) => ({
    data: { id: 'gmail-outreach-1' },
    headers: {}
  }))
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, prepareGtmPlan, type PreparedGtmPlanResult } from '../gtm/intent.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import { decidePlaybookApproval } from '../playbooks/engine.js';
import { createSuppression } from '../suppressions.js';
import type { PreparedEmailOutreachResult } from './types.js';

const WORKSPACE = 'ws_email_outreach_prepare';
const USER = 'usr_email_outreach_prepare';
const CONNECTION = 'conn_email_outreach_prepare';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
let db: Db;
let listId: string;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-email-prepare/',
  'Ana,Silva,Globex,ana@globex.test,https://www.linkedin.com/in/ana-email-prepare/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-email-prepare/',
  'Lena,Frei,Initech,,https://www.linkedin.com/in/lena-email-prepare/',
  'Priya,Rao,Umbrella,priya@umbrella.test,https://www.linkedin.com/in/priya-email-prepare/',
  'Omar,Haddad,Hooli,omar@hooli.test,https://www.linkedin.com/in/omar-email-prepare/',
  'Ben,Okafor,Vandelay,ben@vandelay.test,https://www.linkedin.com/in/ben-email-prepare/'
].join('\n');

function emailIntent() {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function prepare(idempotencyKey: string): Promise<PreparedGtmPlanResult> {
  const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
  expect(plan.blockers).toEqual([]);
  return prepareGtmPlan(db, {
    workspaceId: WORKSPACE,
    actorUserId: USER,
    actorRole: 'owner',
    plan,
    planHash: plan.planHash,
    idempotencyKey
  });
}

function emailResult(prepared: PreparedGtmPlanResult): PreparedEmailOutreachResult {
  if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') {
    throw new Error('Expected an email outreach preparation');
  }
  return prepared.result;
}

async function names(): Promise<Map<string, string>> {
  const rows = await db
    .prepare('SELECT id,first_name FROM linkedin_lead_contacts WHERE workspace_id=?')
    .all<{ id: string; first_name: string }>(WORKSPACE);
  return new Map(rows.map((row) => [row.id, row.first_name]));
}

async function outcome(result: PreparedEmailOutreachResult) {
  const byId = await names();
  return {
    prepared: result.prepared.map((item) => byId.get(item.contactId)).sort(),
    skipped: Object.fromEntries(
      result.skipped.map((item) => [byId.get(item.contactId), item.reason])
    )
  };
}

async function updateLead(sql: string, email: string): Promise<void> {
  await db.prepare(sql).run(NOW.toISOString(), WORKSPACE, email);
}

beforeEach(async () => {
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockClear();
  nangoMock.post.mockClear();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Email outreach prepare', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@email-outreach-prepare.test', 'Founder', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
       VALUES (?,'acme.test','google','pass',?::jsonb,?::jsonb,?::jsonb,?::timestamptz,
               '2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, PASSING, PASSING, PASSING, NOW.toISOString());

  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Email founders' }, NOW);
  listId = list.id;
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId, csv }, NOW);
  await updateLead(
    `UPDATE linkedin_lead_contacts SET do_not_contact=TRUE,updated_at=?
     WHERE workspace_id=? AND LOWER(email)=?`,
    'omar@hooli.test'
  );
  await updateLead(
    `UPDATE linkedin_lead_contacts SET person_id=NULL,person_resolution_status='conflict',updated_at=?
     WHERE workspace_id=? AND LOWER(email)=?`,
    'ben@vandelay.test'
  );
  await createSuppression(db, {
    workspaceId: WORKSPACE,
    channel: 'email',
    email: 'priya@umbrella.test',
    reason: 'Unsubscribed',
    source: 'test'
  });
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at,created_at,updated_at)
       VALUES ('gdel_jonas_earlier',?,'email',?,'outreach','jonas@northstar.test','test','jonas-earlier',
               'jonas-earlier','sent','gmail','gmail-jonas-1',?,?,?,?)`
    )
    .run(
      WORKSPACE,
      CONNECTION,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString()
    );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('prepareEmailOutreach', () => {
  it('prepares one approval per eligible Person, sends nothing, and replays by key', async () => {
    const prepared = await prepare('email-prepare-0001');
    const result = emailResult(prepared);

    expect(prepared).toMatchObject({
      status: 'prepared',
      objective: 'prepare_outreach',
      channel: 'email',
      next: { kind: 'review_email_approvals', href: '/ledger' }
    });
    expect(await outcome(result)).toEqual({
      prepared: ['Ana', 'Maya'],
      skipped: {
        Jonas: 'already_contacted',
        Lena: 'no_email',
        Priya: 'suppressed',
        Omar: 'do_not_contact',
        Ben: 'unresolved_person'
      }
    });
    expect(result).toMatchObject({
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      truncated: false,
      duplicate: false
    });
    if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') return;
    expect(prepared.artifacts.runIds).toEqual(result.prepared.map((item) => item.runId));

    const runs = await db
      .prepare(
        `SELECT status,input_json->>'recipient' AS recipient,input_json->>'subject' AS subject,
                input_json->>'body' AS body
         FROM playbook_runs WHERE workspace_id=? AND playbook_key='gtm.email-outreach'
         ORDER BY input_json->>'recipient'`
      )
      .all<{ status: string; recipient: string; subject: string; body: string }>(WORKSPACE);
    expect(runs.map(({ status, recipient, subject }) => ({ status, recipient, subject }))).toEqual([
      { status: 'waiting_approval', recipient: 'ana@globex.test', subject: 'Quick question, Ana' },
      {
        status: 'waiting_approval',
        recipient: 'maya@northwind.test',
        subject: 'Quick question, Maya'
      }
    ]);
    expect(runs[1]!.body).toContain('Hi Maya,');
    expect(runs[1]!.body).toContain('Northwind');
    expect(nangoMock.post).not.toHaveBeenCalled();
    const sent = await db
      .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(sent?.total).toBe(1);

    const replay = emailResult(await prepare('email-prepare-0001'));
    expect(replay.duplicate).toBe(true);
    expect(replay.prepared).toEqual(result.prepared);
  });

  it('refuses a reused key for another plan and never queues a second email per Person', async () => {
    emailResult(await prepare('email-prepare-0001'));
    await updateLead(
      `UPDATE linkedin_lead_contacts SET do_not_contact=TRUE,updated_at=?
       WHERE workspace_id=? AND LOWER(email)=?`,
      'jonas@northstar.test'
    );

    const changed = await compileGtmIntent(db, WORKSPACE, emailIntent());
    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        actorRole: 'owner',
        plan: changed,
        planHash: changed.planHash,
        idempotencyKey: 'email-prepare-0001'
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/different email plan/)
    });

    const again = emailResult(await prepare('email-prepare-0002'));
    expect(await outcome(again)).toEqual({
      prepared: [],
      skipped: {
        Maya: 'already_pending',
        Ana: 'already_pending',
        Jonas: 'do_not_contact',
        Lena: 'no_email',
        Priya: 'suppressed',
        Omar: 'do_not_contact',
        Ben: 'unresolved_person'
      }
    });
    const runs = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM playbook_runs
         WHERE workspace_id=? AND playbook_key='gtm.email-outreach'`
      )
      .get<{ total: number }>(WORKSPACE);
    expect(runs?.total).toBe(2);
  });

  it('counts a Person as already emailed once their approved email is sent', async () => {
    emailResult(await prepare('email-prepare-0001'));
    const maya = await db
      .prepare(
        `SELECT id,input_json->>'conversationId' AS conversation_id FROM playbook_runs
         WHERE workspace_id=? AND playbook_key='gtm.email-outreach'
           AND input_json->>'recipient'='maya@northwind.test'`
      )
      .get<{ id: string; conversation_id: string }>(WORKSPACE);

    const sent = await decidePlaybookApproval(db, {
      workspaceId: WORKSPACE,
      runId: maya!.id,
      stepId: 'approve-outreach',
      userId: USER,
      decision: 'approve'
    });
    expect(sent.status).toBe('completed');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);

    const next = emailResult(await prepare('email-prepare-0003'));
    expect((await outcome(next)).skipped).toMatchObject({
      Maya: 'already_contacted',
      Ana: 'already_pending'
    });
    expect(
      await db
        .prepare(
          `SELECT direction,source_type FROM conversation_messages
           WHERE workspace_id=? AND conversation_id=?`
        )
        .all(WORKSPACE, maya!.conversation_id)
    ).toEqual([{ direction: 'outbound', source_type: 'email_outreach' }]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach.test.ts`
Expected: FAIL. `prepareGtmPlan` throws `Email outreach preparation is not available yet.` (the Task 12 guard).

- [ ] **Step 3: Add the preparation half of `outreach.ts`**

In `src/server/email/outreach.ts`, replace the import block:

```ts
import type { Db } from '../db.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import type { EmailChannelIssue, MailProvider } from './types.js';
import { unsubscribeConfigured } from './unsubscribe.js';
```

with:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureConversationForPerson } from '../conversations.js';
import type { Db } from '../db.js';
import { LEAD_CONTACT_READ_LIMIT } from '../linkedin/lead-lists.js';
import { startPlaybookRun } from '../playbooks/engine.js';
import { findSuppression } from '../suppressions.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import type {
  EmailChannelIssue,
  EmailOutreachSkipReason,
  MailProvider,
  PreparedEmailOutreachResult
} from './types.js';
import { unsubscribeConfigured } from './unsubscribe.js';
```

Then append to the end of the file:

```ts
export class EmailOutreachError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

export const EMAIL_OUTREACH_PLAYBOOK_ID = 'gtm.email-outreach';

// lc-debt: one preparation starts at most 200 approval runs and reads at most LEAD_CONTACT_READ_LIMIT list members; upgrade path: prepare in pages with a cursor stored on email_outreach_preparations once founders approve more than 200 first-touch emails at a time.
const MAX_PREPARED_PER_CALL = 200;

const recipientSchema = z.string().email();

interface MemberRow {
  contact_id: string;
  person_id: string | null;
  do_not_contact: boolean;
  first_name: string | null;
  company: string | null;
  recipient: string | null;
}

interface OutreachRunRow {
  id: string;
  person_id: string;
  idempotency_key: string;
}

interface ReceiptRow {
  plan_hash: string;
  result_json: Omit<PreparedEmailOutreachResult, 'duplicate'>;
}

interface PrepareInput {
  workspaceId: string;
  actorUserId: string;
  idempotencyKey: string;
  planHash: string;
  leadListId: string;
  connectionId: string;
  senderAddress: string;
}

/** One deterministic run key per workspace, preparation key and lead-list contact. */
export function emailOutreachRunKey(
  workspaceId: string,
  idempotencyKey: string,
  contactId: string
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}:${idempotencyKey}:${contactId}`)
    .digest('hex');
  return `eo_${digest.slice(0, 40)}`;
}

function oneLine(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The first-touch email Trevra prepares. It is short and plain on purpose: the
 * founder approves its exact text before anything is sent, and the
 * List-Unsubscribe header carries the one-click opt-out.
 */
export function firstTouchEmail(input: { firstName: string | null; company: string | null }): {
  subject: string;
  body: string;
} {
  const firstName = oneLine(input.firstName, 80);
  const company = oneLine(input.company, 120);
  return {
    subject: firstName ? `Quick question, ${firstName}` : 'Quick question',
    body: [
      firstName ? `Hi ${firstName},` : 'Hi,',
      '',
      company
        ? `I am reaching out because of the work you do at ${company}. Would you be open to a short conversation about it?`
        : 'Would you be open to a short conversation?',
      '',
      'If you would rather not hear from me, use the unsubscribe option your mail app shows for this email, or reply and say so.'
    ].join('\n')
  };
}

async function readReceipt(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<ReceiptRow | undefined> {
  return db
    .prepare(
      'SELECT plan_hash,result_json FROM email_outreach_preparations WHERE workspace_id=? AND idempotency_key=?'
    )
    .get<ReceiptRow>(workspaceId, idempotencyKey);
}

function replayReceipt(receipt: ReceiptRow, planHash: string): PreparedEmailOutreachResult {
  if (receipt.plan_hash !== planHash) {
    throw new EmailOutreachError(
      'This preparation key was already used for a different email plan. Plan again before preparing.'
    );
  }
  return { ...receipt.result_json, duplicate: true };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

/**
 * Start one approval run, or find the run that beat it to the unique indexes.
 * Returns the run id for this run key, or null when the Person already has an
 * open outreach email under another key.
 */
async function startOutreachRun(
  db: Db,
  input: PrepareInput,
  run: {
    runKey: string;
    conversationId: string;
    personId: string;
    contactId: string;
    recipient: string;
    subject: string;
    body: string;
  }
): Promise<string | null> {
  try {
    const started = await startPlaybookRun(db, {
      workspaceId: input.workspaceId,
      playbookId: EMAIL_OUTREACH_PLAYBOOK_ID,
      payload: {
        idempotencyKey: run.runKey,
        conversationId: run.conversationId,
        personId: run.personId,
        contactId: run.contactId,
        leadListId: input.leadListId,
        connectionId: input.connectionId,
        senderAddress: input.senderAddress,
        recipient: run.recipient,
        subject: run.subject,
        body: run.body
      },
      actorType: 'user',
      actorId: input.actorUserId
    });
    return started.id;
  } catch (error) {
    if (errorCode(error) !== '23505') throw error;
    const raced = await db
      .prepare(
        `SELECT id,input_json->>'personId' AS person_id,input_json->>'idempotencyKey' AS idempotency_key
         FROM playbook_runs
         WHERE workspace_id=? AND playbook_key=?
           AND (input_json->>'idempotencyKey'=?
                OR (input_json->>'personId'=? AND status IN ('queued','running','waiting_approval')))
         ORDER BY CASE WHEN input_json->>'idempotencyKey'=? THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`
      )
      .get<OutreachRunRow>(
        input.workspaceId,
        EMAIL_OUTREACH_PLAYBOOK_ID,
        run.runKey,
        run.personId,
        run.runKey
      );
    return raced && raced.idempotency_key === run.runKey ? raced.id : null;
  }
}

/**
 * Prepare first-touch outreach email for a People list: one gtm.email-outreach
 * run per eligible Person, each waiting for approval of its exact text. Nothing
 * is sent here. The caller has already re-compiled the plan and checked that it
 * has no blockers, so the sender passed DNS and unsubscribe checks.
 */
export async function prepareEmailOutreach(
  db: Db,
  input: PrepareInput,
  now: Date = new Date()
): Promise<PreparedEmailOutreachResult> {
  const earlier = await readReceipt(db, input.workspaceId, input.idempotencyKey);
  if (earlier) return replayReceipt(earlier, input.planHash);

  const rows = await db
    .prepare(
      `SELECT lc.id AS contact_id,lc.person_id,lc.do_not_contact,lc.first_name,lc.company,
              ${RECIPIENT_SQL} AS recipient
       FROM linkedin_lead_list_members m
       JOIN linkedin_lead_contacts lc ON lc.workspace_id=m.workspace_id AND lc.id=m.contact_id
       LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
       WHERE m.workspace_id=? AND m.list_id=?
       ORDER BY m.created_at ASC,lc.id ASC
       LIMIT ?`
    )
    .all<MemberRow>(input.workspaceId, input.leadListId, LEAD_CONTACT_READ_LIMIT + 1);
  let truncated = rows.length > LEAD_CONTACT_READ_LIMIT;

  const contacted = new Set(
    (
      await db
        .prepare(
          `SELECT DISTINCT LOWER(recipient) AS recipient FROM gtm_deliveries
           WHERE workspace_id=? AND channel='email' AND purpose='outreach'
             AND status IN ('sending','sent','uncertain')`
        )
        .all<{ recipient: string }>(input.workspaceId)
    ).map((row) => row.recipient)
  );
  const openRuns = new Map<string, OutreachRunRow>();
  const open = await db
    .prepare(
      `SELECT id,input_json->>'personId' AS person_id,input_json->>'idempotencyKey' AS idempotency_key
       FROM playbook_runs
       WHERE workspace_id=? AND playbook_key=? AND status IN ('queued','running','waiting_approval')`
    )
    .all<OutreachRunRow>(input.workspaceId, EMAIL_OUTREACH_PLAYBOOK_ID);
  for (const run of open) openRuns.set(run.person_id, run);

  const prepared: PreparedEmailOutreachResult['prepared'] = [];
  const skipped: PreparedEmailOutreachResult['skipped'] = [];
  const batchRecipients = new Set<string>();
  const skip = (contactId: string, reason: EmailOutreachSkipReason) => {
    skipped.push({ contactId, reason });
  };

  for (const member of rows.slice(0, LEAD_CONTACT_READ_LIMIT)) {
    if (prepared.length >= MAX_PREPARED_PER_CALL) {
      truncated = true;
      break;
    }
    const recipient =
      member.recipient && recipientSchema.safeParse(member.recipient).success
        ? member.recipient
        : null;
    if (!recipient) {
      skip(member.contact_id, 'no_email');
      continue;
    }
    const personId = member.person_id;
    if (!personId) {
      skip(member.contact_id, 'unresolved_person');
      continue;
    }
    const runKey = emailOutreachRunKey(input.workspaceId, input.idempotencyKey, member.contact_id);
    const openRun = openRuns.get(personId);
    if (openRun && openRun.idempotency_key === runKey) {
      // A retry of this same preparation after a crash: the run is already ours.
      prepared.push({ contactId: member.contact_id, personId, runId: openRun.id });
      batchRecipients.add(recipient);
      continue;
    }
    if (member.do_not_contact) {
      skip(member.contact_id, 'do_not_contact');
      continue;
    }
    if (
      await findSuppression(db, input.workspaceId, { channel: 'email', personId, email: recipient })
    ) {
      skip(member.contact_id, 'suppressed');
      continue;
    }
    if (contacted.has(recipient)) {
      skip(member.contact_id, 'already_contacted');
      continue;
    }
    if (openRun || batchRecipients.has(recipient)) {
      skip(member.contact_id, 'already_pending');
      continue;
    }

    const email = firstTouchEmail({ firstName: member.first_name, company: member.company });
    const conversationId = await ensureConversationForPerson(db, input.workspaceId, personId, now);
    const runId = await startOutreachRun(db, input, {
      runKey,
      conversationId,
      personId,
      contactId: member.contact_id,
      recipient,
      subject: email.subject,
      body: email.body
    });
    if (!runId) {
      skip(member.contact_id, 'already_pending');
      continue;
    }
    prepared.push({ contactId: member.contact_id, personId, runId });
    openRuns.set(personId, { id: runId, person_id: personId, idempotency_key: runKey });
    batchRecipients.add(recipient);
  }

  const result: Omit<PreparedEmailOutreachResult, 'duplicate'> = {
    prepared,
    skipped,
    connectionId: input.connectionId,
    senderAddress: input.senderAddress,
    truncated
  };
  const written = await db
    .prepare(
      `INSERT INTO email_outreach_preparations
       (workspace_id,idempotency_key,plan_hash,actor_user_id,lead_list_id,connection_id,run_ids_json,
        result_json,created_at)
       VALUES (?,?,?,?,?,?,?::jsonb,?::jsonb,?)
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING`
    )
    .run(
      input.workspaceId,
      input.idempotencyKey,
      input.planHash,
      input.actorUserId,
      input.leadListId,
      input.connectionId,
      JSON.stringify(prepared.map((item) => item.runId)),
      JSON.stringify(result),
      now.toISOString()
    );
  if (written.changes === 0) {
    // A concurrent request with the same key wrote its receipt first. Its runs
    // are these runs (same run keys), so answer as the replay it is.
    const raced = await readReceipt(db, input.workspaceId, input.idempotencyKey);
    if (raced) return replayReceipt(raced, input.planHash);
  }
  return { ...result, duplicate: false };
}
```

Import cycles: `outreach.ts` now imports `playbooks/engine.ts` and, through it, `control-plane/execution.ts` and `integration-service.ts`. None of those import `gtm/intent.ts` or `email/outreach.ts`. `intent.ts` stays the only importer of `outreach.ts`.

- [ ] **Step 4: Return email preparations from `prepareGtmPlan`**

In `src/server/gtm/intent.ts`, replace the Task 12 import:

```ts
import { emailOutreachReadiness } from '../email/outreach.js';
```

with:

```ts
import {
  EmailOutreachError,
  emailOutreachReadiness,
  prepareEmailOutreach
} from '../email/outreach.js';
import type { PreparedEmailOutreachResult } from '../email/types.js';
```

Replace:

```ts
export interface PreparedOutreachGtmPlanResult {
  status: 'prepared';
  objective: 'prepare_outreach';
  artifacts: PreparedOutreachResult['artifacts'];
```

with:

```ts
export interface PreparedOutreachGtmPlanResult {
  status: 'prepared';
  objective: 'prepare_outreach';
  channel: 'linkedin';
  artifacts: PreparedOutreachResult['artifacts'];
```

Replace:

```ts
export type PreparedGtmPlanResult =
  PreparedOutreachGtmPlanResult | PreparedCaptureGtmPlanResult | PreparedWatchGtmPlanResult;
```

with:

```ts
export interface PreparedEmailOutreachGtmPlanResult {
  status: 'prepared';
  objective: 'prepare_outreach';
  channel: 'email';
  artifacts: { runIds: string[] };
  next: { kind: 'review_email_approvals'; href: '/ledger' };
  result: PreparedEmailOutreachResult;
}

export type PreparedGtmPlanResult =
  | PreparedOutreachGtmPlanResult
  | PreparedEmailOutreachGtmPlanResult
  | PreparedCaptureGtmPlanResult
  | PreparedWatchGtmPlanResult;
```

Replace the Task 12 guard:

```ts
if (current.defaults.channel === 'email') {
  throw new GtmPlanError('Email outreach preparation is not available yet.', 409);
}
```

with:

```ts
if (current.defaults.channel === 'email') {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const leadListId = text(current.defaults.leadListId);
  const connectionId = text(current.defaults.connectionId);
  const senderAddress = text(current.defaults.senderAddress);
  if (!leadListId || !connectionId || !senderAddress) {
    throw new GtmPlanError('This email plan is missing a People list or sending mailbox.', 409);
  }
  try {
    const result = await prepareEmailOutreach(db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      planHash: current.planHash,
      leadListId,
      connectionId,
      senderAddress
    });
    return {
      status: 'prepared',
      objective: 'prepare_outreach',
      channel: 'email',
      artifacts: { runIds: result.prepared.map((item) => item.runId) },
      next: { kind: 'review_email_approvals', href: '/ledger' },
      result
    };
  } catch (error) {
    if (error instanceof EmailOutreachError) throw new GtmPlanError(error.message, error.status);
    throw error;
  }
}
```

Replace the LinkedIn return:

```ts
    objective: 'prepare_outreach',
    artifacts: result.artifacts,
```

with:

```ts
    objective: 'prepare_outreach',
    channel: 'linkedin',
    artifacts: result.artifacts,
```

In `src/server/gtm/intent.test.ts`, replace:

```ts
if (prepared.objective !== 'prepare_outreach') throw new Error('Expected outreach preparation');
```

with:

```ts
if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'linkedin')
  throw new Error('Expected outreach preparation');
```

and replace:

```ts
if (replay.objective !== 'prepare_outreach') throw new Error('Expected outreach replay');
```

with:

```ts
if (replay.objective !== 'prepare_outreach' || replay.channel !== 'linkedin')
  throw new Error('Expected outreach replay');
```

- [ ] **Step 5: Run the server tests and watch them pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach.test.ts src/server/email/outreach-plan.test.ts src/server/email/outreach-playbook.test.ts src/server/gtm/intent.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing client formatter test**

Create `src/client/views/gtmPlanFormat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emailSkipSummary } from './gtmPlanFormat';

describe('emailSkipSummary', () => {
  it('says nothing when nobody was skipped', () => {
    expect(emailSkipSummary([])).toBe('');
  });

  it('counts skipped People by reason in a fixed order', () => {
    expect(
      emailSkipSummary([
        { contactId: 'a', reason: 'already_contacted' },
        { contactId: 'b', reason: 'no_email' },
        { contactId: 'c', reason: 'no_email' },
        { contactId: 'd', reason: 'suppressed' }
      ])
    ).toBe(
      'Skipped 4: 2 without an email address, 1 unsubscribed or suppressed, 1 already emailed.'
    );
  });
});
```

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/gtmPlanFormat.test.ts`
Expected: FAIL, because `./gtmPlanFormat` does not exist yet.

- [ ] **Step 7: Write the formatter and show the email result**

Create `src/client/views/gtmPlanFormat.ts`:

```ts
import type {
  EmailOutreachSkipReason,
  PreparedEmailOutreachResult
} from '../../server/email/types';

const SKIP_LABELS: Array<[EmailOutreachSkipReason, string]> = [
  ['no_email', 'without an email address'],
  ['unresolved_person', 'not yet matched to one Person'],
  ['do_not_contact', 'marked do-not-contact'],
  ['suppressed', 'unsubscribed or suppressed'],
  ['already_contacted', 'already emailed'],
  ['already_pending', 'already waiting for approval']
];

/** One sentence that accounts for every Person an email preparation skipped. */
export function emailSkipSummary(skipped: PreparedEmailOutreachResult['skipped']): string {
  if (skipped.length === 0) return '';
  const parts = SKIP_LABELS.flatMap(([reason, label]) => {
    const count = skipped.filter((item) => item.reason === reason).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  return `Skipped ${skipped.length}: ${parts.join(', ')}.`;
}
```

In `src/client/views/LoopView.tsx`, replace:

```ts
import { Select } from '../ui/primitives';
```

with:

```ts
import { Button, Select } from '../ui/primitives';
import { emailSkipSummary } from './gtmPlanFormat';
```

In the prepared result, replace:

```tsx
                  ) : (
                    <>
                      <span>
                        {prepared.result.campaign.enrolled} people · campaign remains{' '}
```

with:

```tsx
                  ) : prepared.channel === 'email' ? (
                    <>
                      <span>
                        {prepared.result.prepared.length}{' '}
                        {prepared.result.prepared.length === 1 ? 'email waits' : 'emails wait'} for
                        your approval. Nothing is sent before you approve.
                        {emailSkipSummary(prepared.result.skipped)
                          ? ` ${emailSkipSummary(prepared.result.skipped)}`
                          : ''}
                        {prepared.result.truncated
                          ? ' This list is larger than one preparation; prepare again for the rest.'
                          : ''}
                      </span>
                      <Button variant="primary" onClick={() => onNavigate(prepared.next.href)}>
                        Review approvals <ChevronRight size={15} />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span>
                        {prepared.result.campaign.enrolled} people · campaign remains{' '}
```

The last branch keeps the LinkedIn campaign result. TypeScript narrows it by `channel`, so `prepared.result.campaign` still type-checks.

- [ ] **Step 8: Run the tests and the type check**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/gtmPlanFormat.test.ts src/server/email/outreach.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0. This proves `LoopView.tsx` handles both outreach result shapes.

- [ ] **Step 9: Commit**

```bash
git add src/server/email/outreach.ts src/server/email/outreach.test.ts src/server/gtm/intent.ts src/server/gtm/intent.test.ts src/client/views/gtmPlanFormat.ts src/client/views/gtmPlanFormat.test.ts src/client/views/LoopView.tsx
git commit -m "feat(gtm): prepare email-only outreach as per-Person approvals" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 15: Planner channel choice and plan warnings

**Files:**

- Modify: `src/client/views/gtmPlanFormat.ts`, `src/client/views/gtmPlanFormat.test.ts` (Task 14).
- Modify: `src/client/views/LoopView.tsx`:
  - the `gtmPlanFormat` import (Task 14);
  - `PlanWork` state (L990), `compile` (L1036) and the outreach form branch (L1129-1146);
  - `prepareSupported` (L1088) and the end of the blockers block (L1271-1293).
- Modify: `src/client/styles.css`: the `.gtm-plan-*` rules (L12748-12797) and the 760 px media query (L12884-12897).

**Interfaces:**

- Consumes:
  - Email plan `defaults.warnings` (Task 12) and `emailSkipSummary` (Task 14).
  - `Select` and `Button` from `src/client/ui/primitives.tsx`.
- Produces:
  - `planIssues(value)`, which returns `PlanIssue[]` (`{ code, message, actionHref? }`).
  - A Channel select (LinkedIn or Email) beside People when the goal is Prepare outreach.
  - A "Worth knowing" list of plan warnings.

Channel defaults to LinkedIn, so the existing flow is unchanged until someone picks Email. Warnings never block a plan. They point at Workspace settings, where the email panel (Task 11) fixes them.

- [ ] **Step 1: Write the failing test**

In `src/client/views/gtmPlanFormat.test.ts`, replace:

```ts
import { emailSkipSummary } from './gtmPlanFormat';
```

with:

```ts
import { emailSkipSummary, planIssues } from './gtmPlanFormat';
```

and append:

```ts
describe('planIssues', () => {
  it('keeps only well-formed issues with in-app links', () => {
    expect(
      planIssues([
        {
          code: 'email_replies_not_synced',
          message: 'Replies are not read.',
          actionHref: '/setup/workspace'
        },
        { code: 'email_dmarc_monitoring_only', message: 'DMARC is p=none.' },
        { code: 'offsite', message: 'Leaves the app.', actionHref: '//evil.test/x' },
        { code: 'no_message' },
        'not an issue',
        null
      ])
    ).toEqual([
      {
        code: 'email_replies_not_synced',
        message: 'Replies are not read.',
        actionHref: '/setup/workspace'
      },
      { code: 'email_dmarc_monitoring_only', message: 'DMARC is p=none.' },
      { code: 'offsite', message: 'Leaves the app.' }
    ]);
  });

  it('reads a missing or malformed value as no warnings', () => {
    expect(planIssues(undefined)).toEqual([]);
    expect(planIssues({ code: 'x', message: 'y' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/gtmPlanFormat.test.ts`
Expected: FAIL. `planIssues` is not exported yet, so both new tests throw a `TypeError` (`... is not a function`).

- [ ] **Step 3: Write `planIssues`**

Append to `src/client/views/gtmPlanFormat.ts`:

```ts
export interface PlanIssue {
  code: string;
  message: string;
  actionHref?: string;
}

/**
 * Plan defaults are untyped JSON. Keep only well-formed issues, and keep a link
 * only when it stays inside the app.
 */
export function planIssues(value: unknown): PlanIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PlanIssue[] => {
    if (!item || typeof item !== 'object') return [];
    const { code, message, actionHref } = item as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return [];
    const inApp =
      typeof actionHref === 'string' && actionHref.startsWith('/') && !actionHref.startsWith('//');
    return [{ code, message, ...(inApp ? { actionHref } : {}) }];
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/gtmPlanFormat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the channel choice and warnings to the planner**

In `src/client/views/LoopView.tsx`, replace:

```ts
import { emailSkipSummary } from './gtmPlanFormat';
```

with:

```ts
import { emailSkipSummary, planIssues } from './gtmPlanFormat';
```

Replace:

```ts
const [leadListId, setLeadListId] = useState('');
```

with:

```ts
const [leadListId, setLeadListId] = useState('');
const [outreachChannel, setOutreachChannel] = useState<'linkedin' | 'email'>('linkedin');
```

Replace:

```ts
              channels: ['linkedin'] as Array<'linkedin' | 'email' | 'community'>,
```

with:

```ts
              channels: [outreachChannel] as Array<'linkedin' | 'email' | 'community'>,
```

Replace the outreach form branch:

```tsx
            {objective === 'prepare_outreach' ? (
              <label>
                People
                <Select
                  value={leadListId}
                  onChange={(event) => {
                    setLeadListId(event.target.value);
                    resetPlan();
                  }}
                >
                  <option value="">Choose a People list</option>
                  {leadLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} · {list.leadCount} people
                    </option>
                  ))}
                </Select>
              </label>
            ) : objective === 'capture_inbound' ? (
```

with:

```tsx
            {objective === 'prepare_outreach' ? (
              <>
                <label>
                  People
                  <Select
                    value={leadListId}
                    onChange={(event) => {
                      setLeadListId(event.target.value);
                      resetPlan();
                    }}
                  >
                    <option value="">Choose a People list</option>
                    {leadLists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name} · {list.leadCount} people
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Channel
                  <Select
                    value={outreachChannel}
                    onChange={(event) => {
                      setOutreachChannel(event.target.value === 'email' ? 'email' : 'linkedin');
                      resetPlan();
                    }}
                  >
                    <option value="linkedin">LinkedIn</option>
                    <option value="email">Email</option>
                  </Select>
                </label>
              </>
            ) : objective === 'capture_inbound' ? (
```

People keeps the wide second grid column and Channel takes the narrow third one, so the row still has four cells: Goal, People, Channel, Show plan.

Replace:

```ts
const prepareSupported = plan?.defaults.prepareSupported === true && plan.blockers.length === 0;
```

with:

```ts
const prepareSupported = plan?.defaults.prepareSupported === true && plan.blockers.length === 0;
const planWarnings = planIssues(plan?.defaults.warnings);
```

Replace the end of the blockers block:

```tsx
              )}

              <div className="gtm-plan-actions">
                {prepareSupported ? (
```

with:

```tsx
              )}

              {planWarnings.length > 0 && (
                <div className="gtm-plan-warnings">
                  <strong>Worth knowing</strong>
                  {planWarnings.map((warning) => (
                    <div key={warning.code}>
                      <span>{warning.message}</span>
                      {warning.actionHref && (
                        <Button onClick={() => onNavigate(warning.actionHref!)}>
                          Open <ChevronRight size={15} />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="gtm-plan-actions">
                {prepareSupported ? (
```

- [ ] **Step 6: Style the warnings like the blockers, in a neutral tone**

In `src/client/styles.css`, replace:

```css
.gtm-plan-result,
.gtm-plan-blockers > div {
```

with:

```css
.gtm-plan-result,
.gtm-plan-blockers > div,
.gtm-plan-warnings > div {
```

Replace:

```css
.gtm-plan-steps span,
.gtm-plan-blockers span {
```

with:

```css
.gtm-plan-steps span,
.gtm-plan-blockers span,
.gtm-plan-warnings span {
```

Replace:

```css
.gtm-plan-result {
  padding-top: 12px;
```

with:

```css
.gtm-plan-warnings {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--t-r-md);
  background: var(--t-surface-2);
}
.gtm-plan-result {
  padding-top: 12px;
```

In the `@media (max-width: 760px)` block, replace:

```css
  .gtm-plan-result,
  .gtm-plan-blockers > div {
    align-items: flex-start;
```

with:

```css
  .gtm-plan-result,
  .gtm-plan-blockers > div,
  .gtm-plan-warnings > div {
    align-items: flex-start;
```

`--line` and `--t-surface-2` are already redefined for the dark theme, so this needs no dark-mode rule of its own. On a phone, a warning stacks its Open button under the text, the same way blockers do.

- [ ] **Step 7: Typecheck and look at it**

Run: `npm run typecheck`
Expected: exit 0.

Run `npm run dev` and open `/loop` as the owner, with one Gmail mailbox connected and a People list that has email addresses. Then:

1. Choose Plan work, then Prepare outreach. Channel shows LinkedIn, and Show plan gives the same LinkedIn plan as before this task.
2. Switch Channel to Email and choose Show plan. The plan reads "Email N People in … from …". Any blocker shows under "Things to resolve", and the replies warning shows under "Worth knowing" with an Open button that goes to `/setup/workspace`.
3. Check the result in the light and dark themes, and at a 390 px wide viewport. The form wraps to two columns and nothing scrolls sideways.
4. Tab through Goal, People, Channel and Show plan. Focus stays visible on each.

- [ ] **Step 8: Commit**

```bash
git add src/client/views/gtmPlanFormat.ts src/client/views/gtmPlanFormat.test.ts src/client/views/LoopView.tsx src/client/styles.css
git commit -m "feat(gtm): choose email in the planner and show plan warnings" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 16: Contracts, configuration and the final gate

**Files:**

- Modify: `docs/integration-contracts.md`: `### Message` (L16-31), `email.send` (L58) and `## Nango sync behavior` (L65-76).
- Modify: `.env.example`: after `TREVRA_SECRETS_KEY_PREVIOUS=` (L65).

**Interfaces:**

- Consumes: everything from Tasks 1-15.
- Produces: operator documentation for the inbound sync deploy, the canonical inbound message fields and the `email.send` mailbox binding. Also the `TREVRA_PUBLIC_API_URL` and `TREVRA_DNS_DISABLED` entries in `.env.example`.

- [ ] **Step 1: Document the inbound mailbox message**

In `docs/integration-contracts.md`, replace:

```md
### Opportunity
```

with:

````md
### Inbound mailbox message

The `inbound-messages` syncs in `nango-integrations/` emit `message` records with four extra fields. Only those syncs set them.

```json
{
  "kind": "message",
  "id": "gmail-message-id",
  "direction": "inbound",
  "mailboxAddress": "founder@acme.example",
  "personEmail": "maya@northwind.example",
  "personName": "Maya Chen",
  "subject": "Re: Quick question, Maya",
  "body": "Happy to talk on Thursday.",
  "occurredAt": "2026-10-06T09:00:00.000Z",
  "internetMessageId": "<CAF123@mail.gmail.com>",
  "replyToMessageIds": ["<eo_0123456789abcdef@trevra.app>"],
  "autoSubmitted": null
}
```

A record that carries `mailboxAddress` is kept only when all three of these hold:

- its connection is the workspace's designated inbound mailbox;
- `mailboxAddress` equals that mailbox's address;
- `personEmail` belongs to a Person already in the workspace.

Anything else is dropped before Trevra writes source evidence, a message, a Person or a Conversation entry.

The sync skips bulk and mailing-list mail. Unsubscribe requests that arrive as mail suppress the sender, with the sources `email_mailto_unsubscribe` and `email_reply_unsubscribe`.

### Opportunity
````

- [ ] **Step 2: Document the `email.send` mailbox binding**

Replace:

```md
- `email.send` — send through a connected Gmail or Microsoft 365 mailbox.
```

with:

```md
- `email.send` — send through a connected Gmail or Microsoft 365 mailbox. When the approved metadata names `connectionId` and `senderAddress`, the email leaves only from that connection. It must also still verify as that address with the provider; otherwise nothing is sent and the action answers 409. Outreach email approved with `requireListUnsubscribe: true` carries RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers, or it is not sent.
```

- [ ] **Step 3: Document the Trevra-owned Nango functions**

Replace:

```md
Unsupported models are counted as skipped rather than silently treated as a successful empty sync.
```

with:

````md
Unsupported models are counted as skipped rather than silently treated as a successful empty sync.

### Trevra-owned Nango functions

The inbound-mailbox syncs are Trevra code in `nango-integrations/`, in Nango's zero-YAML layout. Each folder name equals a Nango integration id (`trevra-gmail`, `trevra-microsoft`). If `NANGO_GMAIL_INTEGRATION` or `NANGO_MICROSOFT_INTEGRATION` names a different integration, rename the folder to match.

Deploy them to each Nango environment, and again whenever they change:

```bash
cd nango-integrations
cp .env.example .env   # set NANGO_SECRET_KEY_PROD, and NANGO_HOSTPORT when self-hosting
npm install
npx nango deploy prod
```

The syncs do not start on their own. Trevra starts the sync for one mailbox when an owner chooses it as the inbound mailbox in Workspace settings. It pauses that sync when the owner stops reading mail.

If Nango cannot start the sync, Workspace settings shows the mailbox as unavailable and nothing is read. That happens when the syncs are not deployed, or on a Nango plan without syncs.
````

- [ ] **Step 4: Add the two settings to `.env.example`**

Replace:

```bash
TREVRA_SECRETS_KEY_PREVIOUS=
```

with:

```bash
TREVRA_SECRETS_KEY_PREVIOUS=
# Outreach email. One-click unsubscribe links (RFC 8058) are signed with a key derived
# from TREVRA_SECRETS_KEY and point at <TREVRA_PUBLIC_API_URL>/u/<token>. That origin must
# be HTTPS and reachable by recipients' mail providers; without it Trevra refuses to
# prepare outreach email. Unset, it falls back to BETTER_AUTH_URL. Leave the line
# commented rather than empty: an empty value counts as set and disables the fallback.
# TREVRA_PUBLIC_API_URL=https://app.example.com
# Tests set this to true so no test queries real DNS for SPF, DKIM or DMARC. With it set,
# every sending domain reads as unconfirmed and email outreach stays blocked.
TREVRA_DNS_DISABLED=false
```

- [ ] **Step 5: Sweep the whole phase before the gate**

Run each command and expect no output:

```bash
grep -rn "Email outreach preparation is not available yet" src
grep -rn "prepare_outreach_linkedin_only" src
grep -rnE "location\.hash|#/" src/client/EmailChannelSummary.tsx src/client/EmailChannelPanel.tsx src/client/views/gtmPlanFormat.ts
grep -rnE "style=\{\{" src/client/EmailChannelSummary.tsx src/client/EmailChannelPanel.tsx
BASE="$(git log --format=%H -n 1 --grep='add migration 133 for the email channel')~1"
git diff --name-only "$BASE" -- migrations | grep -v "migrations/133_email_channel.sql"
```

Then read the full phase diff once: `git diff --stat "$BASE"` and `git diff "$BASE" -- src/server/integration-service.ts src/server/control-plane/execution.ts src/server/gtm/intent.ts`. `BASE` is the commit just before Task 1. Confirm the following:

- every new SQL statement filters by `workspace_id`, except `findUnsubscribeDelivery`, which says why;
- no SQL string outside the migration contains a `?` that is not a bind placeholder;
- every `lc-debt:` comment names its upgrade path.

- [ ] **Step 6: Run the gate**

Run: `npm run check`
Expected: every test passes, then the build passes (catalog, `tsc --noEmit`, `vite build`, and the server `tsc`).

Run: `npm audit --omit=dev`
Expected: no new advisories. Phase D adds no root dependency.

Run: `cd nango-integrations && npm audit --omit=dev`
Expected: `found 0 vulnerabilities`. The Nango project has only dev dependencies.

Phase D does not touch `infra/` or `docker-compose.yml`, so `docker compose config` and `terraform validate` are not required.

- [ ] **Step 7: Check the whole flow by hand**

Run `npm run dev` with an HTTPS `TREVRA_PUBLIC_API_URL` (a tunnel works). Connect one Gmail mailbox on a domain whose DNS you control, and import a People list that includes your own second address. Then:

1. On `/setup/workspace`, the Email panel shows the mailbox and its SPF, DKIM and DMARC result. Re-check DNS updates it.
2. With DKIM removed from DNS, Re-check DNS and plan Email outreach on `/loop`. The plan is blocked with the DKIM message. Today shows one `deliverability_blocked` item. Restore DKIM, re-check, and both clear.
3. Prepare the plan. `/ledger` shows one approval per Person, and nothing was sent.
4. Approve the email to your second address. It arrives from the approved mailbox, and the mail app offers Unsubscribe.
5. Copy the `https` link from the message's `List-Unsubscribe` header (Gmail: Show original) and open it in a browser. The page asks for confirmation, and no suppression exists yet. Confirm it, and the suppression appears.
6. Choose the mailbox for inbound mail and reply from the second address. The reply shows in that Person's Conversation within one sync interval. Mail from an address that is not a Person never shows up.
7. Repeat steps 1 and 3 in the dark theme and at a 390 px wide viewport.

- [ ] **Step 8: Commit**

```bash
git add docs/integration-contracts.md .env.example
git commit -m "docs(email): inbound sync deploy, email.send binding and email settings" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Self-Review

**Spec coverage (roadmap row D and shared contract 5):**

| Requirement                                      | Tasks                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| SPF, DKIM and DMARC failures block email plans   | 2 (evaluator, injected resolver), 3 (cache, worker refresh), 12 (plan blockers, `unknown` blocks)           |
| Today kind `deliverability_blocked`              | 10                                                                                                          |
| RFC 8058 `List-Unsubscribe` on outreach sends    | 4 (tokens, headers), 5 (stamped in `executeConnectedAction`; `requireListUnsubscribe` refuses without them) |
| One-click endpoint; `GET` never unsubscribes     | 6                                                                                                           |
| Named inbound mailbox syncing into Conversations | 7 (ingest rules), 8 (designation API), 9 (Nango syncs in the repo), 11 (UI)                                 |
| Email-only `prepare_outreach`                    | 12 (compile), 13 (playbook and mailbox binding), 14 (prepare), 15 (planner UI)                              |
| Migration `133_*` only                           | 1                                                                                                           |
| Tests never hit real DNS                         | 2 (fake resolver), 3 (`TREVRA_DNS_DISABLED` in `vitest.setup.ts`)                                           |
| No polling of Gmail or Graph by Trevra           | 9: Nango syncs, with storage and pacing in Nango                                                            |

**Placeholder scan:** there is no "TBD", "TODO" or "similar to Task N". Every code step shows complete code, and every run step gives the exact command and the expected result.

**Order dependencies:**

- Task 12 adds a temporary guard so an email plan cannot fall into the LinkedIn preparation path. Task 14 replaces it.
- Task 13 lands the playbook and the mailbox binding before Task 14 creates runs that use them.
- Task 14 adds the `channel` discriminant and the LoopView branch in the same commit, so the client still type-checks.

**Name consistency:**

- Blocker and warning codes are spelled the same in Tasks 2, 10, 12 and 15.
- `RECIPIENT_SQL`, `EMAIL_OUTREACH_PLAYBOOK_ID` / `gtm.email-outreach`, `approve-outreach` and `send-outreach` match in Tasks 12, 13 and 14.
- `deliverySourceType` / `conversationSourceType` `email_outreach` match in Task 13 and the Task 14 assertions.
- `PreparedEmailOutreachResult`, including `truncated` (Task 2), is the shape Task 14 returns and stores.
- `chooseInboundMailbox`, `stopInboundMailbox` and `recheckEmailDns` (Task 11) call the Task 8 routes.

**Existence:** the Interfaces block of each task cites the existing path and line, or the earlier task, for every function, table and column the task uses. Line numbers were read on 2026-10-07 at `a2bcb0b`. If another phase lands first, anchor on the quoted code, not the line number.

**SQL placeholders:** the only literal `?` outside bind placeholders is the jsonb `?` operator in `migrations/133_email_channel.sql`. Migrations do not go through the `src/server/db.ts` rewrite.

**Known limits, each marked `lc-debt` in code:**

- DKIM is checked only at the default selectors (Task 2). A custom selector reads as missing and blocks.
- The DMARC organizational domain uses a last-two-labels heuristic (Task 2). It fails safe on suffixes such as `co.uk`.
- The worker refreshes at most 25 stale domains per cycle (Task 3).
- Finishing a `TREVRA_SECRETS_KEY` rotation retires the unsubscribe links in mail already sent (Task 4).
- A message reached by both a legacy message sync and the inbound sync is projected once, by whichever path stored it first (Task 7).
- The Gmail inbound sync lists at most `LIST_CEILING` messages per window (Task 9).
- Email outreach needs exactly one connected sending mailbox (`email_sender_ambiguous`, Task 12).
- One preparation starts at most 200 approval runs (Task 14). Already prepared or emailed People do not count toward the cap, so the next preparation continues with new People.
