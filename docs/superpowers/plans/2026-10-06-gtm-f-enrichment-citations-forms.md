# GTM Phase F: Enrichment, AI-Answer Citations and Capture Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A founder can find verified contacts at named accounts through their own Hunter key, bounded by a monthly credit cap shown in the plan preview. Their AI-answer citation samples (from Beseam) appear as gained/lost brand-watch mentions. A site with no backend can post signed lead captures through a Cloudflare Worker template.

**Architecture:**

- **Enrichment** is a new GTM objective, `enrich_contacts`, in the existing compiler (`src/server/gtm/intent.ts`). Its plan carries a deterministic `cost` block (Hunter credit estimate, cap and month-to-date usage) and blockers.
- Preparing the approved plan only queues an `enrichment_runs` row under a per-workspace advisory lock that re-checks the cap. The standalone worker drains the queue through a `ContactEnrichmentProvider`, of which Hunter is the first implementation. Every paid call is charged to the append-only usage ledger immediately after each call, and verified, sourced emails are saved as People linked to their Account.
- **Citations** use the existing capture-source HMAC scheme on a second public endpoint. A brand watch binds to one capture source of kind `ai_citations`. Each content-free sample updates `ai_citation_samples`, and only gained/lost transitions become immutable `brand_watch_mentions` rows with platform `ai_answer`.
- **The Worker** is an example package that verifies Turnstile, signs the canonical body with Web Crypto and posts to `/api/intake/v1/submissions`. It imports no server code; a Vitest test verifies its signature with the server's own verifier (`src/server/lead-capture/signature.ts`, Task 2).

**Tech Stack:** TypeScript, Express, PostgreSQL (forward-only migrations), Zod, Vitest with a real PostgreSQL Testcontainer, React client, Cloudflare Workers (Web Crypto, Turnstile).

**Spec:** `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md` (Phase F row, Global Constraints, Shared contracts). Also `reports/LemonCrow and Beseam GTM needs.md` and `research_notes/LemonCrow and Beseam GTM needs/beseam.md` (AI-answer citation samples). External sources were read on 2026-10-06:

- Hunter Terms of Service, last updated May 23, 2024 (https://hunter.io/terms-of-service):
  - Section 4: "Any use of the Hunter application programming interface (the “API”), including use of the API through a third-party product that accesses the Services, must comply with this Agreement". So a customer may use their own key through Trevra.
  - Section 1: "You must not share your account with others". So Trevra never holds a shared key.
  - Section 8: no competing service built on Hunter.
  - Section 11: the customer is an independent Controller of the personal data.
- Hunter pricing FAQ (https://hunter.io/pricing):
  - "In the Domain Search, 1 credit is used for each email found... If no emails are found, no credits are used."
  - "0.5 credit is counted per verified email. If we fail to verify, no credit is counted"
  - "Same email searches or verifications are counted once per billing period."
  - Free plan: 50 credits a month.
- Hunter API v2 (https://hunter.io/api-documentation/v2):
  - `X-API-KEY` header.
  - `GET /v2/domain-search` (`limit` max 100, `type=personal`).
  - `GET /v2/email-verifier` (202 while still running, status `valid|invalid|accept_all|webmail|disposable|unknown`; 222 when the remote SMTP server failed, retry later; 451 when the address owner asked Hunter to stop processing it).
  - `GET /v2/account` is free.
  - Errors: 401 invalid key, 403 rate limit, 429 usage limit.
- Nango provider catalogue `packages/providers/providers.yaml` (https://github.com/NangoHQ/nango, main branch, 2026-10-06) has no `hunter` entry. So the key uses Trevra secret custody.
- Cloudflare Turnstile server-side validation (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/):
  - `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response` and optional `remoteip`.
  - Tokens are at most 2048 characters, valid for 300 s and single use.
- Turnstile testing (https://developers.cloudflare.com/turnstile/troubleshooting/testing/): the always-pass secret is `1x0000000000000000000000000000000AA` and the always-fail secret is `2x0000000000000000000000000000000AA`.
- Tally webhooks (https://tally.so/help/webhooks): `Tally-Signature` is a base64 HMAC-SHA256 of the payload with Tally's own secret.
- Formbricks webhooks (https://formbricks.com/docs/xm-and-surveys/core-features/integrations/webhooks): Standard Webhooks `webhook-signature: v1,<base64>` with a `whsec_` secret. Neither can produce Trevra's `X-Trevra-Signature` over `<timestamp>.<idempotency-key>.<raw body>` or Trevra's canonical body.

## Global Constraints

- **Binding roadmap constraints:**
  - PostgreSQL only, with forward-only migrations.
  - Every commercial query is workspace-scoped. On public endpoints the capture source decides the workspace, never the body.
  - Multi-step writes use `db.transaction` and `pg_advisory_xact_lock(hashtextextended(?::text, 0))`.
  - Credentials stay in Nango or Trevra secret custody, gated by `secretsConfigured()`.
  - Domain events and analytics are content-free.
  - No new navigation section. UI uses `src/client/ui/primitives.tsx` and `--t-*` tokens.
  - Tests run against real PostgreSQL.
  - Known ceilings carry `lc-debt: <ceiling>; <upgrade path>` comments.
  - New durable state ships with both a writer and a closer.
- **Phase F contract:** F owns no account-signal kinds (citations are brand-watch mentions), adds no Today kinds, uses migration `135_*`, and depends on no Phase A–E artifact.
- **Migration number is a reservation.** Run `ls migrations | tail -3` before Task 1. If `135_*` exists, use the next free number and replace `135_enrichment_and_ai_citations.sql` everywhere in this plan.
- **Line numbers are from commit `a2bcb0b`.** Phases A–E may shift them, so anchor every edit on the quoted code, not the number. If an earlier phase already changed `handleIntake` in `src/server/lead-capture/http.ts`, keep its additions and apply this plan's change around them.
- **Enrichment:**
  - The Hunter key is the workspace's own key, never a Trevra-owned key (Hunter ToS Section 1).
  - The plaintext is read in exactly one place, `src/server/enrichment/runs.ts`, at the moment of a Hunter call.
  - Enrichment never runs through the generic skill or playbook runner. It is a dedicated approved-plan path. It makes no external write, only paid reads.
  - Unverified (`accept_all`/`unknown`) emails are saved only when the plan opts in, labelled `inferred`. This matches the "NEVER GUESS SILENTLY" rule in `src/server/skills/contact.ts`. Emails without a published source URI are never saved, matching its "SOURCED" rule.
- **Citations:** No answer text is stored anywhere. Cited URLs must be on the founder's own declared domains. Mention rows hold only engine, prompt reference, position, sample id and the sanitized cited URL.
- **Commits:** Run `npm run check` before every commit, as the roadmap requires. Each task's last step runs the gate then commits. Every commit message ends with a blank line followed by `Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7`.
- **Test command:** `npx tsx scripts/test-with-postgres.ts <test files>`. Final gate: `npm run check`.

## Review Focus

1. Concurrent or duplicate approvals that together exceed the monthly cap. Pinned in Task 6 by `runs.test.ts` "two concurrent approvals cannot both reserve past the cap".
2. A cited URL on a foreign or lookalike domain, or any answer text, reaching storage. Pinned in Task 8 by `citations.test.ts` "rejects lookalike and foreign cited URLs" and in Task 9 by `citation-intake.test.ts` "rejects unknown fields such as answer text".
3. Out-of-order or retried samples flipping gained/lost incorrectly. Pinned in Task 8 by `citations.test.ts` "an older sample arriving late is stale and creates no mention".
4. A Hunter key revoked or deleted mid-run. Pinned in Task 6 by `runs.test.ts` "a revoked key fails the run and marks the key invalid".
5. A secret for one capture endpoint accepted by the other. Pinned in Task 2 by `api.test.ts` "a citation source secret cannot post lead submissions" and in Task 9 by `citation-intake.test.ts` "a lead source secret cannot post citation samples".
6. Two worker replicas spending on the same run after a lease expires. Every paid call, checkpoint, finish and release is fenced on `status='running' AND attempts=<claimed attempts>`. Pinned in Task 6 by `runs.test.ts` "a copy whose lease another replica took over stops before its next paid call".

## File Map

| File                                                                                                | Change | Task     |
| --------------------------------------------------------------------------------------------------- | ------ | -------- |
| `migrations/135_enrichment_and_ai_citations.sql`                                                    | Create | 1        |
| `src/server/enrichment/schema.test.ts`                                                              | Create | 1        |
| `src/server/lead-capture/signature.ts`, `signature.test.ts`                                         | Create | 2        |
| `src/server/lead-capture/http.ts`, `types.ts`, `sources.ts`, `api.test.ts`                          | Modify | 2        |
| `src/server/enrichment/provider.ts`, `hunter.ts`, `hunter.test.ts`                                  | Create | 3        |
| `src/server/enrichment/settings.ts`, `settings.test.ts`, `api.test.ts`                              | Create | 4        |
| `src/server/secrets/store.ts`, `src/server/integration-service.ts`                                  | Modify | 4        |
| `src/server/gtm/intent.ts`                                                                          | Modify | 5, 6     |
| `src/server/enrichment/plan.test.ts`                                                                | Create | 5        |
| `src/server/enrichment/runs.ts`, `runs.test.ts`                                                     | Create | 6        |
| `src/server/lead-capture/people.ts`, `src/worker/index.ts`                                          | Modify | 6, 9     |
| `src/client/api.ts`, `src/client/views/LoopView.tsx`, `src/client/App.tsx`, `src/client/styles.css` | Modify | 6, 7, 10 |
| `src/client/views/planCost.ts`, `planCost.test.ts`, `src/client/EnrichmentSetup.tsx`                | Create | 7        |
| `src/server/watch/citations.ts`, `citations.test.ts`                                                | Create | 8        |
| `src/server/watch/citation-intake.ts`, `citation-intake.test.ts`                                    | Create | 9        |
| `src/server/app.ts`                                                                                 | Modify | 4, 9     |
| `src/client/views/researchFormat.ts`, `researchFormat.test.ts`, `ResearchView.tsx`                  | Modify | 10       |
| `src/client/views/CitationSourceSetup.tsx`                                                          | Create | 10       |
| `examples/capture-worker/**`                                                                        | Create | 11       |
| `tsconfig.json`, `docs/lead-capture.md`                                                             | Modify | 2, 9, 11 |

---

### Task 1: Migration for enrichment and citation state

**Files:**

- Create: `migrations/135_enrichment_and_ai_citations.sql`
- Test: `src/server/enrichment/schema.test.ts`

**Interfaces:**

- Consumes: `workspaces(id)`, `users(id)`, `brand_watches(id)`, `brand_watch_mentions(id)`, `capture_sources(workspace_id, id)` (migrations 001, 098, 112).
- Produces the tables `enrichment_settings`, `enrichment_runs`, `enrichment_usage_ledger`, `brand_watch_citation_sources` and `ai_citation_samples`, with the exact columns below. Every table carries `workspace_id`, so `workspaceScopedTables` in `src/server/app.ts` exports and erases them with no list edit.

- [ ] **Step 0: Confirm the migration number is free**

Run: `ls migrations | tail -3`
Expected: the last numbered file is below `135_`. If `135_*` exists, pick the next free number and rename it throughout this plan.

- [ ] **Step 1: Write the failing schema test**

Create `src/server/enrichment/schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_phase_f_schema';
const OTHER = 'ws_phase_f_schema_other';
const NOW = '2026-10-06T09:00:00.000Z';
let db: Db;

async function seedWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, NOW);
}

async function seedWatch(workspaceId: string, watchId: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO brand_watches (id,workspace_id,name,keywords,platforms,cadence) VALUES (?,?,?,?,?,?)'
    )
    .run(watchId, workspaceId, `Watch ${watchId}`, ['trevra'], ['hackernews'], 'daily');
}

async function seedSource(workspaceId: string, sourceId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO capture_sources (id,workspace_id,name,key,kind,status,created_at,updated_at)
       VALUES (?,?,?,?,'ai_citations','active',?,?)`
    )
    .run(sourceId, workspaceId, 'AI answers', sourceId, NOW, NOW);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await seedWorkspace(WORKSPACE);
  await seedWorkspace(OTHER);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WORKSPACE, OTHER);
  await db?.close();
});

describe('phase F schema', () => {
  it('defaults enrichment to a zero cap and an unchecked key', async () => {
    await db.prepare('INSERT INTO enrichment_settings (workspace_id) VALUES (?)').run(WORKSPACE);
    const row = await db
      .prepare(
        'SELECT provider, monthly_credit_cap, key_status FROM enrichment_settings WHERE workspace_id=?'
      )
      .get<{ provider: string; monthly_credit_cap: number; key_status: string }>(WORKSPACE);
    // db.ts registers a NUMERIC (OID 1700) parser, so the cap arrives as a number.
    expect(row).toEqual({ provider: 'hunter', monthly_credit_cap: 0, key_status: 'unchecked' });
  });

  it('rejects a negative cap and an unknown provider', async () => {
    await expect(
      db
        .prepare('INSERT INTO enrichment_settings (workspace_id, monthly_credit_cap) VALUES (?,?)')
        .run(WORKSPACE, -1)
    ).rejects.toThrow();
    await expect(
      db
        .prepare('INSERT INTO enrichment_settings (workspace_id, provider) VALUES (?,?)')
        .run(WORKSPACE, 'apollo')
    ).rejects.toThrow();
  });

  it('bounds a run to 1..100 domains and 1..10 emails per domain', async () => {
    const insert = (domains: string[], perDomain: number) =>
      db
        .prepare(
          `INSERT INTO enrichment_runs
             (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,include_unverified,estimated_credits)
           VALUES (?,?,'hunter',?,?,?,?,false,?)`
        )
        .run(
          `enr_${perDomain}_${domains.length}`,
          WORKSPACE,
          `key-${perDomain}-${domains.length}`,
          'a'.repeat(64),
          domains,
          perDomain,
          1
        );
    await expect(insert([], 3)).rejects.toThrow();
    await expect(insert(['acme.com'], 11)).rejects.toThrow();
    await expect(insert(['acme.com'], 3)).resolves.toBeDefined();
  });

  it('deleting a watch removes its citation link and samples', async () => {
    await seedWatch(WORKSPACE, 'bw_schema_1');
    await seedSource(WORKSPACE, 'cap_schema_1');
    await db
      .prepare(
        'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
      )
      .run('bw_schema_1', WORKSPACE, 'cap_schema_1', ['trevra.com']);
    await db
      .prepare(
        `INSERT INTO ai_citation_samples
           (id,workspace_id,watch_id,capture_source_id,idempotency_key,payload_hash,sample_id,engine,prompt_ref,answered_at,brand_cited,change)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'acs_1',
        WORKSPACE,
        'bw_schema_1',
        'cap_schema_1',
        'sample-key-1',
        'b'.repeat(64),
        's1',
        'chatgpt',
        'id:pricing',
        NOW,
        true,
        'gained'
      );
    await db.prepare('DELETE FROM brand_watches WHERE id=?').run('bw_schema_1');
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM brand_watch_citation_sources WHERE workspace_id=?) AS links,
           (SELECT COUNT(*) FROM ai_citation_samples WHERE workspace_id=?) AS samples`
      )
      .get<{ links: string; samples: string }>(WORKSPACE, WORKSPACE);
    expect(Number(counts?.links)).toBe(0);
    expect(Number(counts?.samples)).toBe(0);
  });

  it('refuses a citation link to another workspace capture source', async () => {
    await seedWatch(WORKSPACE, 'bw_schema_2');
    await seedSource(OTHER, 'cap_schema_other');
    await expect(
      db
        .prepare(
          'INSERT INTO brand_watch_citation_sources (watch_id,workspace_id,capture_source_id,owned_domains) VALUES (?,?,?,?)'
        )
        .run('bw_schema_2', WORKSPACE, 'cap_schema_other', ['trevra.com'])
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/schema.test.ts`
Expected: FAIL with `relation "enrichment_settings" does not exist`.

- [ ] **Step 3: Write the migration**

Create `migrations/135_enrichment_and_ai_citations.sql`:

```sql
-- Phase F: bring-your-own-key contact enrichment and AI-answer citation samples.
--
-- The Hunter API key is NOT stored here. It is sealed in workspace_secrets
-- (kind 'hunter_api_key') like every other workspace credential.

-- One row per workspace. A missing row means "cap 0, key unchecked": enrichment
-- is off until an owner sets a cap, and every plan is blocked until then.
CREATE TABLE IF NOT EXISTS enrichment_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'hunter' CHECK (provider IN ('hunter')),
  monthly_credit_cap NUMERIC(10,1) NOT NULL DEFAULT 0
    CHECK (monthly_credit_cap >= 0 AND monthly_credit_cap <= 100000),
  key_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (key_status IN ('unchecked', 'valid', 'invalid')),
  key_checked_at TIMESTAMPTZ,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per approved enrich_contacts plan. Queued and running rows reserve
-- their unspent estimate against the monthly cap.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('hunter')),
  idempotency_key TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  domains TEXT[] NOT NULL CHECK (cardinality(domains) BETWEEN 1 AND 100),
  emails_per_domain INTEGER NOT NULL CHECK (emails_per_domain BETWEEN 1 AND 10),
  include_unverified BOOLEAN NOT NULL DEFAULT FALSE,
  estimated_credits NUMERIC(10,1) NOT NULL CHECK (estimated_credits > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS enrichment_runs_open_idx
  ON enrichment_runs(created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS enrichment_runs_finished_idx
  ON enrichment_runs(finished_at) WHERE finished_at IS NOT NULL;

-- Append-only: one row per paid provider call, written before the result is
-- used. run_id has no FK so the ledger outlives a pruned run row until its own
-- 13-month retention.
CREATE TABLE IF NOT EXISTS enrichment_usage_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('hunter')),
  operation TEXT NOT NULL CHECK (operation IN ('domain_search', 'email_verifier')),
  credits NUMERIC(10,1) NOT NULL CHECK (credits >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_month_idx
  ON enrichment_usage_ledger(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_run_idx
  ON enrichment_usage_ledger(workspace_id, run_id);
-- The worker prunes across workspaces on every enrichment tick.
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_occurred_idx
  ON enrichment_usage_ledger(occurred_at);

-- One signed AI-answer citation source per brand watch. The capture source is
-- an ordinary capture_sources row of kind 'ai_citations', so it reuses the
-- sealed secret, rotation and disable machinery unchanged.
CREATE TABLE IF NOT EXISTS brand_watch_citation_sources (
  watch_id TEXT PRIMARY KEY REFERENCES brand_watches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capture_source_id TEXT NOT NULL UNIQUE,
  owned_domains TEXT[] NOT NULL CHECK (cardinality(owned_domains) BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);

-- Content-free sample state. No answer text, no prompt text: prompt_ref is a
-- stable id or a sha256 of the prompt. change records what this sample did
-- relative to the latest earlier sample for the same engine and prompt.
CREATE TABLE IF NOT EXISTS ai_citation_samples (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  watch_id TEXT NOT NULL REFERENCES brand_watches(id) ON DELETE CASCADE,
  capture_source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_ref TEXT NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL,
  brand_cited BOOLEAN NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('gained', 'lost', 'kept', 'absent', 'stale')),
  mention_id TEXT REFERENCES brand_watch_mentions(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (capture_source_id, idempotency_key),
  UNIQUE (watch_id, sample_id),
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_citation_samples_latest_idx
  ON ai_citation_samples(watch_id, engine, prompt_ref, answered_at DESC);
CREATE INDEX IF NOT EXISTS ai_citation_samples_received_idx
  ON ai_citation_samples(received_at);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add migrations/135_enrichment_and_ai_citations.sql src/server/enrichment/schema.test.ts
git commit -m "feat(enrichment): add phase F schema

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 2: Shared capture signature verifier and the citation-kind gate

**Files:**

- Create: `src/server/lead-capture/signature.ts`
- Modify: `src/server/lead-capture/http.ts` (whole file, 138 lines at `a2bcb0b`)
- Modify: `src/server/lead-capture/types.ts:3-10` and `:129-141`
- Modify: `src/server/lead-capture/sources.ts:10`, `:35`, `:123`, `:226-234`
- Modify: `docs/lead-capture.md` section 6 status table
- Test: `src/server/lead-capture/signature.test.ts` (create), `src/server/lead-capture/api.test.ts` (append one test)

**Interfaces:**

- Consumes: `readCaptureSourceSigningSecrets`, `getCaptureSourceById`, `recordCaptureSourceRejected`, `recordCaptureSourceAccepted` (`sources.ts`).
- Produces:
  - `signature.ts` exports `MAX_CAPTURE_BODY_BYTES`, `MAX_CLOCK_SKEW_SECONDS`, `IDEMPOTENCY_RE`, `CaptureHeaders`, `readCaptureHeaders(headers)`, `CaptureProblem`, `captureHeaderProblem(headers, nowSeconds)`, `captureSignatureHex(secret, timestampRaw, idempotencyKey, rawBody)`, `captureSignatureMatches(secrets, headers, rawBody)` and `rawCaptureBody(body)`.
  - `http.ts` adds the exports `createCaptureSourceLimiter()` and `isEntityTooLarge(error)`.
  - `types.ts` exports `CITATION_SOURCE_KIND = 'ai_citations'` and `CaptureSourceRecordKind`.
  - `createCaptureSource` accepts `kind: CaptureSourceRecordKind`.
  - `listCaptureSources` never returns `ai_citations` sources.

- [ ] **Step 1: Write the failing verifier test**

Create `src/server/lead-capture/signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureHeaderProblem,
  captureSignatureHex,
  captureSignatureMatches,
  rawCaptureBody,
  readCaptureHeaders
} from './signature.js';

const BODY = Buffer.from('{"kind":"demo_request","person":{"email":"a@acme.com"}}');

describe('capture signature', () => {
  it('signs timestamp.idempotencyKey.rawBody exactly like the documented recipe', () => {
    const expected = createHmac('sha256', 'trv_capture_test')
      .update(`1760000000.form-key-0001.${BODY.toString('utf8')}`)
      .digest('hex');
    expect(captureSignatureHex('trv_capture_test', '1760000000', 'form-key-0001', BODY)).toBe(
      expected
    );
  });

  it('reads headers case-insensitively and strips the sha256= prefix', () => {
    const headers = readCaptureHeaders({
      'x-trevra-source': ' cap_1 ',
      'x-trevra-timestamp': '1760000000',
      'x-trevra-idempotency-key': 'form-key-0001',
      'x-trevra-signature': 'SHA256=abc123'
    });
    expect(headers).toEqual({
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature: 'abc123'
    });
  });

  it('accepts the active or previous secret and rejects anything else', () => {
    const signature = captureSignatureHex('previous', '1760000000', 'form-key-0001', BODY);
    const headers = {
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature
    };
    expect(captureSignatureMatches(['active', 'previous'], headers, BODY)).toBe(true);
    expect(captureSignatureMatches(['active'], headers, BODY)).toBe(false);
    expect(captureSignatureMatches(['previous'], { ...headers, signature: 'zz' }, BODY)).toBe(
      false
    );
  });

  it('reports header problems in the order intake has always applied them', () => {
    const base = {
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature: ''
    };
    expect(captureHeaderProblem({ ...base, idempotencyKey: 'short' }, 1760000000)).toEqual({
      status: 400,
      error: 'A valid X-Trevra-Idempotency-Key is required'
    });
    expect(captureHeaderProblem({ ...base, timestampRaw: '17.5' }, 1760000000)).toEqual({
      status: 401,
      error: 'Invalid capture timestamp'
    });
    expect(captureHeaderProblem(base, 1760000301)).toEqual({
      status: 401,
      error: 'Capture timestamp is outside the replay window'
    });
    expect(captureHeaderProblem(base, 1760000300)).toBeNull();
  });

  it('treats a non-buffer body as UTF-8 text', () => {
    expect(rawCaptureBody(undefined).length).toBe(0);
    expect(rawCaptureBody('{}').toString('utf8')).toBe('{}');
    expect(rawCaptureBody(BODY)).toBe(BODY);
  });
});
```

- [ ] **Step 2: Append the failing cross-endpoint test to `api.test.ts`**

In `src/server/lead-capture/api.test.ts`, add these imports after line 7 (`import { openDatabase, type Db } from '../db.js';`):

```ts
import { createCaptureSource } from './sources.js';
import { CITATION_SOURCE_KIND } from './types.js';
```

Then add this test as the last `it` inside `describe('lead capture API surface', ...)`, after "returns 413 for an oversized public capture payload rather than a generic 500":

```ts
it('a citation source secret cannot post lead submissions', async () => {
  const { source, secret } = await createCaptureSource(db, {
    workspaceId: WORKSPACE_ID,
    actorUserId: USER_ID,
    name: 'AI answers',
    kind: CITATION_SOURCE_KIND
  });
  const raw = JSON.stringify({
    kind: 'demo_request',
    person: { email: 'citation-probe@capture-api.test' }
  });
  const response = await signedRequest(source.id, secret, 'api-citation-probe-001', raw).expect(
    403
  );
  expect(response.body.error).toBe('This capture source only accepts AI-answer citation samples');
  const contact = await db
    .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?')
    .get(WORKSPACE_ID, 'citation-probe@capture-api.test');
  expect(contact).toBeUndefined();
  const listed = await authed().get('/api/capture-sources').expect(200);
  expect(listed.body.sources.map((entry: { id: string }) => entry.id)).not.toContain(source.id);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/signature.test.ts src/server/lead-capture/api.test.ts`
Expected: FAIL. `signature.test.ts` fails with `Cannot find module './signature.js'`, and `api.test.ts` fails with `CITATION_SOURCE_KIND` undefined or a 202 where 403 was expected.

- [ ] **Step 4: Create `src/server/lead-capture/signature.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The one implementation of Trevra's capture-source HMAC scheme.
 *
 * Signed bytes: `<X-Trevra-Timestamp>.<X-Trevra-Idempotency-Key>.<exact raw body>`,
 * HMAC-SHA256 with the source's active or (during rotation overlap) previous
 * secret, sent as `X-Trevra-Signature: sha256=<hex>`. Both public endpoints
 * (`/api/intake/v1/submissions` and `/api/intake/v1/citations`) and the
 * Cloudflare Worker test verify through this module, so the scheme cannot
 * drift between them.
 */
export const MAX_CAPTURE_BODY_BYTES = 128 * 1024;
export const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export interface CaptureHeaders {
  sourceId: string;
  timestampRaw: string;
  idempotencyKey: string;
  signature: string;
}

export function readCaptureHeaders(headers: IncomingHttpHeaders): CaptureHeaders {
  return {
    sourceId: String(headers['x-trevra-source'] ?? '').trim(),
    timestampRaw: String(headers['x-trevra-timestamp'] ?? '').trim(),
    idempotencyKey: String(headers['x-trevra-idempotency-key'] ?? '').trim(),
    signature: String(headers['x-trevra-signature'] ?? '')
      .trim()
      .replace(/^sha256=/i, '')
  };
}

export interface CaptureProblem {
  status: 400 | 401;
  error: string;
}

/** Checks that need no secret, in the order intake has always applied them. */
export function captureHeaderProblem(
  headers: CaptureHeaders,
  nowSeconds: number
): CaptureProblem | null {
  if (!IDEMPOTENCY_RE.test(headers.idempotencyKey))
    return { status: 400, error: 'A valid X-Trevra-Idempotency-Key is required' };
  const timestamp = Number(headers.timestampRaw);
  if (!Number.isInteger(timestamp)) return { status: 401, error: 'Invalid capture timestamp' };
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS)
    return { status: 401, error: 'Capture timestamp is outside the replay window' };
  return null;
}

export function captureSignatureHex(
  secret: string,
  timestampRaw: string,
  idempotencyKey: string,
  rawBody: Buffer
): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestampRaw}.${idempotencyKey}.`, 'utf8'), rawBody]))
    .digest('hex');
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function captureSignatureMatches(
  secrets: readonly string[],
  headers: CaptureHeaders,
  rawBody: Buffer
): boolean {
  return secrets.some((secret) =>
    equalHex(
      headers.signature,
      captureSignatureHex(secret, headers.timestampRaw, headers.idempotencyKey, rawBody)
    )
  );
}

export function rawCaptureBody(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
}
```

- [ ] **Step 5: Add the citation kind to `types.ts`**

In `src/server/lead-capture/types.ts`, after line 10 (`export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];`) insert:

```ts
/**
 * Server-created only, never offered by `captureSourceCreateSchema`: one per
 * brand watch, created by `connectCitationSource` (watch/citations.ts). Its
 * secret signs AI-answer citation samples and is refused by lead intake.
 */
export const CITATION_SOURCE_KIND = 'ai_citations' as const;
export type CaptureSourceRecordKind = CaptureSourceKind | typeof CITATION_SOURCE_KIND;
```

In `interface CaptureSourceRecord`, replace `  kind: CaptureSourceKind;` with:

```ts
kind: CaptureSourceRecordKind;
```

- [ ] **Step 6: Let `sources.ts` create and hide citation sources**

In `src/server/lead-capture/sources.ts`:

Replace line 10, `import type { CaptureSourceKind, CaptureSourceRecord } from './types.js';`, with:

```ts
import type { CaptureSourceRecord, CaptureSourceRecordKind } from './types.js';
import { CITATION_SOURCE_KIND } from './types.js';
```

In `toSource`, replace `    kind: String(row.kind) as CaptureSourceKind,` with:

```ts
    kind: String(row.kind) as CaptureSourceRecordKind,
```

In `createCaptureSource`'s input type, replace `    kind: CaptureSourceKind;` with:

```ts
kind: CaptureSourceRecordKind;
```

Replace the whole `listCaptureSources` function with:

```ts
export async function listCaptureSources(
  db: Db,
  workspaceId: string
): Promise<CaptureSourceRecord[]> {
  // Citation sources belong to a brand watch and are managed from Research;
  // listing them here would offer a lead-capture recipe for a secret that
  // lead intake refuses.
  const rows = await db
    .prepare(
      'SELECT * FROM capture_sources WHERE workspace_id=? AND kind <> ? ORDER BY created_at DESC'
    )
    .all<Record<string, unknown>>(workspaceId, CITATION_SOURCE_KIND);
  return rows.map(toSource);
}
```

- [ ] **Step 7: Rewrite `src/server/lead-capture/http.ts` on the shared verifier**

Replace the whole file with:

```ts
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Db } from '../db.js';
import { CITATION_SOURCE_KIND, inboundSubmissionSchema, LeadCaptureError } from './types.js';
import {
  getCaptureSourceById,
  readCaptureSourceSigningSecrets,
  recordCaptureSourceAccepted,
  recordCaptureSourceRejected
} from './sources.js';
import { acceptInboundSubmission, payloadHash } from './submissions.js';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  MAX_CAPTURE_BODY_BYTES,
  rawCaptureBody,
  readCaptureHeaders
} from './signature.js';

async function handleIntake(db: Db, req: Request, res: Response): Promise<void> {
  const headers = readCaptureHeaders(req.headers);
  const source = headers.sourceId ? await getCaptureSourceById(db, headers.sourceId) : null;
  if (!source) {
    res.status(404).json({ error: 'Capture source not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordCaptureSourceRejected(db, source.id);
    res.status(status).json({ error: message });
  };
  if (source.status !== 'active') return void (await reject(401, 'Capture source is disabled'));
  const problem = captureHeaderProblem(headers, Math.floor(Date.now() / 1000));
  if (problem) return void (await reject(problem.status, problem.error));

  const rawBody = rawCaptureBody(req.body);
  const secrets = await readCaptureSourceSigningSecrets(db, source);
  if (secrets.length === 0) return void (await reject(401, 'Capture source has no usable secret'));
  if (!captureSignatureMatches(secrets, headers, rawBody))
    return void (await reject(401, 'Invalid capture signature'));
  // Checked after the signature, so an unsigned probe cannot learn a source's
  // kind. A citation secret proves who signed; it does not make this the
  // endpoint the secret was issued for.
  if (source.kind === CITATION_SOURCE_KIND)
    return void (await reject(403, 'This capture source only accepts AI-answer citation samples'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return void (await reject(400, 'Invalid JSON body'));
  }
  const validated = inboundSubmissionSchema.safeParse(parsed);
  if (!validated.success)
    return void (await reject(
      400,
      validated.error.issues.map((issue) => issue.message).join('; ')
    ));

  try {
    const result = await acceptInboundSubmission(db, {
      source,
      idempotencyKey: headers.idempotencyKey,
      body: validated.data,
      payloadHash: payloadHash(rawBody)
    });
    await recordCaptureSourceAccepted(db, source.id);
    res.status(result.duplicate ? 200 : 202).json({
      submissionId: result.submission.id,
      personId: result.contactId,
      accountId: result.accountId,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof LeadCaptureError) {
      await recordCaptureSourceRejected(db, source.id);
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export function createCaptureSourceLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // Unknown/missing sources intentionally share one bucket. Once a source ID
    // is present it becomes the quota key, so IPv6 address normalisation never
    // enters this limiter and one source cannot spend another source's quota.
    keyGenerator: (req) => String(req.headers['x-trevra-source'] ?? 'unknown'),
    message: {
      error: 'Capture source has made too many requests. Retry with the same idempotency key.'
    }
  });
}

export function isEntityTooLarge(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.too.large'
  );
}

export function registerLeadCaptureIntake(app: Express, db: Db): void {
  app.post(
    '/api/intake/v1/submissions',
    createCaptureSourceLimiter(),
    express.raw({ type: 'application/json', limit: MAX_CAPTURE_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleIntake(db, req, res);
      } catch (error) {
        if (isEntityTooLarge(error)) {
          res.status(413).json({ error: 'Capture payload is too large' });
          return;
        }
        next(error);
      }
    }
  );
}
```

- [ ] **Step 8: Document the new status**

In `docs/lead-capture.md` section 6, insert this row between the `401` row and the `404` row:

```md
| `403` | source is an AI-answer citation source |
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/signature.test.ts src/server/lead-capture/api.test.ts`
Expected: PASS. Every pre-existing `api.test.ts` case still passes unchanged, which proves the refactor kept the status codes and messages.

- [ ] **Step 10: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/lead-capture/signature.ts src/server/lead-capture/signature.test.ts src/server/lead-capture/http.ts src/server/lead-capture/types.ts src/server/lead-capture/sources.ts src/server/lead-capture/api.test.ts docs/lead-capture.md
git commit -m "feat(lead-capture): share capture signature verifier

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 3: Contact enrichment provider interface and Hunter adapter

**Files:**

- Create: `src/server/enrichment/provider.ts`
- Create: `src/server/enrichment/hunter.ts`
- Test: `src/server/enrichment/hunter.test.ts`

**Interfaces:**

- Consumes: global `fetch`, `zod`.
- Produces:
  - `provider.ts`: `ENRICHMENT_PROVIDERS`, `EnrichmentProviderId`, `EmailVerificationStatus`, `EnrichmentCandidate`, `DomainSearchResult`, `EmailVerificationResult`, `EnrichmentProviderErrorCode`, `EnrichmentProviderError`, `ContactEnrichmentProvider`, `HUNTER_PRICING_URL`, `HUNTER_CREDIT_PRICE`, `ENRICHMENT_MAX_DOMAINS`, `ENRICHMENT_MAX_EMAILS_PER_DOMAIN`, `roundCredits(value)`, `estimateEnrichmentCredits({domains, emailsPerDomain})`.
  - `hunter.ts`: `createHunterProvider(apiKey, {fetchImpl?, sleep?})` returning a `ContactEnrichmentProvider`.

- [ ] **Step 1: Write the failing adapter test**

Create `src/server/enrichment/hunter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHunterProvider } from './hunter.js';
import { EnrichmentProviderError, estimateEnrichmentCredits } from './provider.js';

const KEY = 'hunter-test-key-0001';

function stubFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('unexpected Hunter call');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('Hunter adapter', () => {
  it('checks the key against the free account endpoint with the key in a header', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { data: { email: 'f@x.com' } } }]);
    await createHunterProvider(KEY, { fetchImpl }).checkKey();
    expect(calls[0]!.url).toBe('https://api.hunter.io/v2/account');
    expect(calls[0]!.headers['X-API-KEY']).toBe(KEY);
  });

  it('maps a domain search to sourced, lower-cased candidates and counts one credit per email', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: {
          data: {
            emails: [
              {
                value: 'Maya@Acme.com',
                confidence: 94,
                first_name: 'Maya',
                last_name: 'Chen',
                position: 'CEO',
                sources: [{ uri: 'ftp://old' }, { uri: 'https://acme.com/team' }]
              },
              { value: 'jonas@acme.com', confidence: 60, sources: [] }
            ]
          }
        }
      }
    ]);
    const result = await createHunterProvider(KEY, { fetchImpl }).domainSearch('acme.com', {
      limit: 3
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v2/domain-search');
    expect(url.searchParams.get('domain')).toBe('acme.com');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('type')).toBe('personal');
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(result.credits).toBe(2);
    expect(result.candidates).toEqual([
      {
        email: 'maya@acme.com',
        firstName: 'Maya',
        lastName: 'Chen',
        position: 'CEO',
        sourceUri: 'https://acme.com/team',
        providerConfidence: 94
      },
      {
        email: 'jonas@acme.com',
        firstName: null,
        lastName: null,
        position: null,
        sourceUri: null,
        providerConfidence: 60
      }
    ]);
  });

  it('charges nothing when a domain search finds no email', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { data: { emails: [] } } }]);
    const result = await createHunterProvider(KEY, { fetchImpl }).domainSearch('empty.com', {
      limit: 3
    });
    expect(result).toEqual({ candidates: [], credits: 0 });
  });

  it('polls a 202 verification and charges half a credit for a definite answer', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([
      { status: 202, body: {} },
      { status: 200, body: { data: { status: 'valid' } } }
    ]);
    const result = await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail(
      'maya@acme.com'
    );
    expect(result).toEqual({ status: 'valid', credits: 0.5 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('charges nothing for unknown or disposable results', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { data: { status: 'unknown' } } },
      { status: 200, body: { data: { status: 'disposable' } } }
    ]);
    const provider = createHunterProvider(KEY, { fetchImpl });
    expect(await provider.verifyEmail('a@acme.com')).toEqual({ status: 'unknown', credits: 0 });
    expect(await provider.verifyEmail('b@acme.com')).toEqual({ status: 'disposable', credits: 0 });
  });

  it('treats a 222 SMTP failure as unknown and a 451 claimed email as claimed, free and non-fatal', async () => {
    const { fetchImpl } = stubFetch([{ status: 222 }, { status: 451 }]);
    const provider = createHunterProvider(KEY, { fetchImpl });
    expect(await provider.verifyEmail('a@acme.com')).toEqual({ status: 'unknown', credits: 0 });
    expect(await provider.verifyEmail('b@acme.com')).toEqual({ status: 'claimed', credits: 0 });
  });

  it('assumes a charge when verification is still running after the last poll', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([{ status: 202 }, { status: 202 }, { status: 202 }]);
    const result = await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail('a@acme.com');
    expect(result).toEqual({ status: 'unknown', credits: 0.5 });
  });

  it('maps provider failures to stable codes without echoing the key', async () => {
    const cases: Array<[{ status: number } | Error, string]> = [
      [{ status: 401 }, 'key_invalid'],
      [{ status: 403 }, 'rate_limited'],
      [{ status: 429 }, 'quota_exhausted'],
      [{ status: 400 }, 'rejected'],
      [{ status: 503 }, 'unavailable'],
      [new TypeError('fetch failed'), 'unavailable']
    ];
    for (const [response, code] of cases) {
      const { fetchImpl } = stubFetch([response]);
      const error = await createHunterProvider(KEY, { fetchImpl })
        .checkKey()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EnrichmentProviderError);
      expect((error as EnrichmentProviderError).code).toBe(code);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('estimates the worst case: one credit per email plus half a credit to verify it', () => {
    expect(estimateEnrichmentCredits({ domains: 2, emailsPerDomain: 3 })).toEqual({
      searchCredits: 6,
      verificationCredits: 3,
      estimatedCredits: 9
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/hunter.test.ts`
Expected: FAIL with `Cannot find module './hunter.js'`.

- [ ] **Step 3: Create `src/server/enrichment/provider.ts`**

```ts
/**
 * Contact enrichment behind one interface, so a second provider is a new
 * adapter and not a change to plans, runs, the cap or the ledger.
 *
 * A provider only READS (domain search, email verification). Nothing here
 * writes to a third party, so it needs no prepared-action adapter. It spends
 * the customer's money, though, so it only ever runs from an approved
 * `enrich_contacts` plan (gtm/intent.ts) under the workspace credit cap
 * (enrichment/runs.ts).
 */
export const ENRICHMENT_PROVIDERS = ['hunter'] as const;
export type EnrichmentProviderId = (typeof ENRICHMENT_PROVIDERS)[number];

/**
 * 'claimed' is Hunter's 451: the address owner asked Hunter to stop processing
 * it. It is never saved, under any opt-in.
 */
export type EmailVerificationStatus =
  'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown' | 'claimed';

export interface EnrichmentCandidate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  /** First public http(s) page the provider saw the address on. Null means unsourced: never saved. */
  sourceUri: string | null;
  providerConfidence: number | null;
}

export interface DomainSearchResult {
  candidates: EnrichmentCandidate[];
  credits: number;
}

export interface EmailVerificationResult {
  status: EmailVerificationStatus;
  credits: number;
}

export type EnrichmentProviderErrorCode =
  'key_invalid' | 'rate_limited' | 'quota_exhausted' | 'rejected' | 'unavailable';

/** Messages are fixed strings: a provider error must never quote the key or a response body. */
export class EnrichmentProviderError extends Error {
  constructor(
    message: string,
    public readonly code: EnrichmentProviderErrorCode
  ) {
    super(message);
    this.name = 'EnrichmentProviderError';
  }
}

export interface ContactEnrichmentProvider {
  readonly id: EnrichmentProviderId;
  /** Free call that proves the key works. Throws EnrichmentProviderError. */
  checkKey(): Promise<void>;
  domainSearch(domain: string, options: { limit: number }): Promise<DomainSearchResult>;
  verifyEmail(email: string): Promise<EmailVerificationResult>;
}

/**
 * Hunter pricing FAQ, read 2026-10-06 (https://hunter.io/pricing):
 * "In the Domain Search, 1 credit is used for each email found... If no
 * emails are found, no credits are used." and "0.5 credit is counted per
 * verified email. If we fail to verify, no credit is counted".
 */
export const HUNTER_PRICING_URL = 'https://hunter.io/pricing';
export const HUNTER_CREDIT_PRICE = { perEmailFound: 1, perVerification: 0.5 } as const;
export const ENRICHMENT_MAX_DOMAINS = 100;
export const ENRICHMENT_MAX_EMAILS_PER_DOMAIN = 10;

export function roundCredits(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Upper bound, never an average: every domain returns `emailsPerDomain`
 * emails and every one is verified. Hunter may charge less (repeat searches
 * in a billing period are counted once), never more, because the run stops
 * before any call that could cross this number.
 */
export function estimateEnrichmentCredits(input: { domains: number; emailsPerDomain: number }): {
  searchCredits: number;
  verificationCredits: number;
  estimatedCredits: number;
} {
  const emails = input.domains * input.emailsPerDomain;
  const searchCredits = roundCredits(emails * HUNTER_CREDIT_PRICE.perEmailFound);
  const verificationCredits = roundCredits(emails * HUNTER_CREDIT_PRICE.perVerification);
  return {
    searchCredits,
    verificationCredits,
    estimatedCredits: roundCredits(searchCredits + verificationCredits)
  };
}
```

- [ ] **Step 4: Create `src/server/enrichment/hunter.ts`**

```ts
import { z } from 'zod';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  type ContactEnrichmentProvider,
  type EmailVerificationStatus
} from './provider.js';

/**
 * Hunter.io, bring-your-own-key.
 *
 * Terms (https://hunter.io/terms-of-service, last updated May 23, 2024, read
 * 2026-10-06): Section 4 permits "use of the API through a third-party
 * product that accesses the Services" under the customer's own agreement;
 * Section 1 says "You must not share your account with others", so Trevra
 * never holds one shared key, only each workspace's own; Section 11 makes the
 * customer an independent Controller of what they look up.
 *
 * Custody: Nango's provider catalogue (packages/providers/providers.yaml, read
 * 2026-10-06) has no `hunter` entry, so the key is sealed in workspace_secrets
 * as kind 'hunter_api_key' and read only in enrichment/runs.ts.
 *
 * API: https://hunter.io/api-documentation/v2. The key travels in the
 * X-API-KEY header, never the query string, so it cannot land in a proxy
 * access log. The email verifier answers 222 when the remote SMTP server
 * failed (not charged, retry later) and 451 when the address owner asked
 * Hunter to stop processing it (must not be processed); both are per-address
 * answers, never run failures.
 */
const HUNTER_API_BASE = 'https://api.hunter.io/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const VERIFY_POLLS = 3;
const VERIFY_POLL_DELAY_MS = 5_000;
const VERIFICATION_STATUSES: readonly EmailVerificationStatus[] = [
  'valid',
  'invalid',
  'accept_all',
  'webmail',
  'disposable',
  'unknown'
];

const hunterEmailSchema = z
  .object({
    value: z.string().min(3),
    confidence: z.number().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    sources: z
      .array(z.object({ uri: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional()
  })
  .passthrough();
const domainSearchSchema = z
  .object({ data: z.object({ emails: z.array(hunterEmailSchema) }).passthrough() })
  .passthrough();
const verifierSchema = z
  .object({ data: z.object({ status: z.string().nullable().optional() }).passthrough() })
  .passthrough();

export interface HunterProviderOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createHunterProvider(
  apiKey: string,
  options: HunterProviderOptions = {}
): ContactEnrichmentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(
    path: string,
    params: Record<string, string>,
    passThrough: readonly number[] = []
  ): Promise<{ status: number; body: unknown }> {
    const query = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetchImpl(`${HUNTER_API_BASE}${path}${query ? `?${query}` : ''}`, {
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new EnrichmentProviderError('Hunter could not be reached.', 'unavailable');
    }
    if (passThrough.includes(response.status)) return { status: response.status, body: null };
    if (response.status === 401)
      throw new EnrichmentProviderError('Hunter rejected the API key.', 'key_invalid');
    if (response.status === 403)
      throw new EnrichmentProviderError('Hunter rate limit reached.', 'rate_limited');
    if (response.status === 429)
      throw new EnrichmentProviderError(
        'The Hunter account has no credits left this period.',
        'quota_exhausted'
      );
    if (response.status >= 500)
      throw new EnrichmentProviderError(`Hunter returned ${response.status}.`, 'unavailable');
    if (response.status !== 200 && response.status !== 202)
      throw new EnrichmentProviderError(
        `Hunter refused the request (${response.status}).`,
        'rejected'
      );
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  return {
    id: 'hunter',

    async checkKey() {
      await call('/account', {});
    },

    async domainSearch(domain, { limit }) {
      const { body } = await call('/domain-search', {
        domain,
        limit: String(Math.max(1, Math.min(Math.trunc(limit), 100))),
        type: 'personal'
      });
      const parsed = domainSearchSchema.safeParse(body);
      // 'rejected', not 'unavailable': a retry would pay again for a body we
      // still could not read.
      if (!parsed.success)
        throw new EnrichmentProviderError(
          'Hunter returned an unreadable domain search.',
          'rejected'
        );
      const emails = parsed.data.data.emails;
      return {
        credits: emails.length * HUNTER_CREDIT_PRICE.perEmailFound,
        candidates: emails.map((entry) => ({
          email: entry.value.trim().toLowerCase(),
          firstName: entry.first_name?.trim() || null,
          lastName: entry.last_name?.trim() || null,
          position: entry.position?.trim() || null,
          sourceUri:
            (entry.sources ?? [])
              .map((source) => source.uri ?? '')
              .find((uri) => /^https?:\/\//i.test(uri)) ?? null,
          providerConfidence: entry.confidence ?? null
        }))
      };
    },

    async verifyEmail(email) {
      for (let attempt = 0; attempt < VERIFY_POLLS; attempt += 1) {
        const { status, body } = await call('/email-verifier', { email }, [222, 451]);
        if (status === 202) {
          await sleep(VERIFY_POLL_DELAY_MS);
          continue;
        }
        if (status === 451) return { status: 'claimed', credits: 0 };
        if (status === 222) return { status: 'unknown', credits: 0 };
        const parsed = verifierSchema.safeParse(body);
        const raw = parsed.success ? parsed.data.data.status : null;
        const result: EmailVerificationStatus = VERIFICATION_STATUSES.includes(
          raw as EmailVerificationStatus
        )
          ? (raw as EmailVerificationStatus)
          : 'unknown';
        return {
          status: result,
          credits:
            result === 'unknown' || result === 'disposable'
              ? 0
              : HUNTER_CREDIT_PRICE.perVerification
        };
      }
      // Hunter counts a verification once even when it completes after we
      // stop polling, so the ledger assumes the charge rather than miss it.
      return { status: 'unknown', credits: HUNTER_CREDIT_PRICE.perVerification };
    }
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/hunter.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/enrichment/provider.ts src/server/enrichment/hunter.ts src/server/enrichment/hunter.test.ts
git commit -m "feat(enrichment): add provider interface and Hunter adapter

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 4: Hunter key custody, monthly cap, usage and settings routes

**Files:**

- Modify: `src/server/secrets/store.ts:55-71` (kind union and its comment), `:90-121` (`KIND_DISPLAY`)
- Create: `src/server/enrichment/settings.ts`
- Modify: `src/server/app.ts` (imports and four routes after `app.delete('/api/agent-setup/key', ...)`)
- Modify: `src/server/integration-service.ts:78-85` (catalogue comment)
- Test: `src/server/enrichment/settings.test.ts` (create), `src/server/enrichment/api.test.ts` (create)

**Interfaces:**

- Consumes: `putWorkspaceSecret`, `describeWorkspaceSecret`, `deleteWorkspaceSecret` (`secrets/store.ts`); `secretsConfigured` (`secrets/crypto.ts`); `appendDomainEvent`; `createHunterProvider`, `EnrichmentProviderError`, `roundCredits` (Task 3); tables from Task 1.
- Produces:
  - The `WorkspaceSecretKind` member `'hunter_api_key'`.
  - `settings.ts` exports `EnrichmentKeyStatus`, `EnrichmentSettings`, `EnrichmentUsage`, `EnrichmentError`, `MAX_MONTHLY_CREDIT_CAP`, `monthStartUtc(now)`, `getEnrichmentSettings(db, workspaceId)`, `setEnrichmentCap(db, workspaceId, cap, actorUserId, now?)`, `setEnrichmentKeyStatus(db, workspaceId, status, now?)` and `enrichmentUsage(db, workspaceId, now?)`.
  - Routes: `GET /api/enrichment` returns `{settings, usage}`. `PUT /api/enrichment/key` and `DELETE /api/enrichment/key` return `{settings}`. `PUT /api/enrichment/cap` returns `{settings, usage}`.

- [ ] **Step 1: Write the failing settings test**

Create `src/server/enrichment/settings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { putWorkspaceSecret } from '../secrets/store.js';
import {
  enrichmentUsage,
  getEnrichmentSettings,
  monthStartUtc,
  setEnrichmentCap,
  setEnrichmentKeyStatus
} from './settings.js';

const WORKSPACE = 'ws_enrichment_settings';
const USER = 'usr_enrichment_settings';
const NOW = new Date('2026-10-15T12:00:00.000Z');
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment settings', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-settings@trevra.test', 'Founder', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

async function ledger(runId: string, credits: number, at: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
       VALUES (?,?,?,'hunter','domain_search',?,?)`
    )
    .run(`enl_${runId}_${at}`, WORKSPACE, runId, credits, at);
}

async function run(runId: string, status: string, estimate: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_runs
         (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits,status)
       VALUES (?,?,'hunter',?,?,?,3,?,?)`
    )
    .run(runId, WORKSPACE, `key-${runId}`, 'c'.repeat(64), ['acme.com'], estimate, status);
}

describe('enrichment settings', () => {
  it('starts off: no key, zero cap', async () => {
    expect(await getEnrichmentSettings(db, WORKSPACE)).toEqual({
      provider: 'hunter',
      monthlyCreditCap: 0,
      keyStatus: 'missing',
      keyCheckedAt: null,
      key: null
    });
  });

  it('reports a stored key as unchecked until a check marks it valid, and never shows a fragment', async () => {
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-settings-key-0001',
      actorUserId: USER
    });
    expect((await getEnrichmentSettings(db, WORKSPACE)).keyStatus).toBe('unchecked');
    await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
    const settings = await getEnrichmentSettings(db, WORKSPACE);
    expect(settings.keyStatus).toBe('valid');
    expect(settings.keyCheckedAt).toBe(NOW.toISOString());
    expect(settings.key?.kind).toBe('hunter_api_key');
    // 'opaque' kinds store an empty last4 (secrets/store.ts deriveLast4).
    expect(settings.key?.last4).toBe('');
  });

  it('accepts caps in half-credit steps from 0 to 100000 only', async () => {
    await expect(setEnrichmentCap(db, WORKSPACE, 0.3, USER, NOW)).rejects.toThrow(/steps of 0.5/);
    await expect(setEnrichmentCap(db, WORKSPACE, -1, USER, NOW)).rejects.toThrow();
    await expect(setEnrichmentCap(db, WORKSPACE, 100_001, USER, NOW)).rejects.toThrow();
    expect((await setEnrichmentCap(db, WORKSPACE, 25.5, USER, NOW)).monthlyCreditCap).toBe(25.5);
  });

  it('counts this UTC month of charges plus the unspent estimate of open runs', async () => {
    await run('enr_open', 'queued', 9);
    await run('enr_done', 'completed', 9);
    await ledger('enr_done', 3, '2026-10-02T08:00:00.000Z');
    await ledger('enr_old', 5, '2026-09-30T23:59:00.000Z');
    await ledger('enr_open', 2, '2026-10-14T08:00:00.000Z');
    expect(monthStartUtc(NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(await enrichmentUsage(db, WORKSPACE, NOW)).toEqual({
      monthStart: '2026-10-01T00:00:00.000Z',
      chargedCredits: 5,
      reservedCredits: 7,
      usedCredits: 12
    });
  });
});
```

- [ ] **Step 2: Write the failing route test**

Create `src/server/enrichment/api.test.ts`. Its session and owner/member helpers are copied from `src/server/lead-capture/api.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE_ID = 'ws_enrichment_api';
const USER_ID = 'usr_enrichment_api';
const KEY = 'hunter-api-test-key-0001';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Enrichment API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'enrichment-api@trevra.test', 'Enrichment API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function authed() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@enrichment-api.test`;
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
  const owner = await signUp('enrichment-owner');
  const member = await signUp('enrichment-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  return { owner, member };
}

function hunterAnswers(status: number) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => new Response('{"data":{}}', { status }));
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
});

beforeEach(async () => {
  await db
    .prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'")
    .run(WORKSPACE_ID);
  await db.prepare('DELETE FROM enrichment_settings WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('enrichment API', () => {
  it('keeps the Hunter key and the cap owner-only', async () => {
    const { member } = await ownerAndMember();
    await member.agent.get('/api/enrichment').expect(200);
    await member.agent.put('/api/enrichment/key').send({ apiKey: KEY }).expect(403);
    await member.agent.delete('/api/enrichment/key').expect(403);
    await member.agent.put('/api/enrichment/cap').send({ monthlyCreditCap: 10 }).expect(403);
  });

  it('checks the key with Hunter before sealing it and never returns it', async () => {
    const spy = hunterAnswers(200);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(200);
    expect(String(spy.mock.calls[0]![0])).toBe('https://api.hunter.io/v2/account');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.settings.keyStatus).toBe('valid');
    expect(JSON.stringify(response.body)).not.toContain(KEY);
    const sealed = await db
      .prepare(
        "SELECT ciphertext FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'"
      )
      .get<{ ciphertext: Buffer }>(WORKSPACE_ID);
    expect(Buffer.from(sealed!.ciphertext).toString('utf8')).not.toContain(KEY);
  });

  it('refuses a key Hunter rejects and saves nothing', async () => {
    hunterAnswers(401);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(400);
    expect(response.body.error).toBe('Hunter rejected this API key. Nothing was saved.');
    const stored = await db
      .prepare("SELECT id FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'")
      .get(WORKSPACE_ID);
    expect(stored).toBeUndefined();
  });

  it('removes the key and reports it missing', async () => {
    hunterAnswers(200);
    await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(200);
    const removed = await authed().delete('/api/enrichment/key').expect(200);
    expect(removed.body.settings.keyStatus).toBe('missing');
  });

  it('sets the monthly cap in half-credit steps', async () => {
    const saved = await authed()
      .put('/api/enrichment/cap')
      .send({ monthlyCreditCap: 25.5 })
      .expect(200);
    expect(saved.body.settings.monthlyCreditCap).toBe(25.5);
    expect(saved.body.usage.usedCredits).toBe(0);
    await authed().put('/api/enrichment/cap').send({ monthlyCreditCap: 0.3 }).expect(400);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/settings.test.ts src/server/enrichment/api.test.ts`
Expected: FAIL with `Cannot find module './settings.js'`, and 404 for `/api/enrichment`.

- [ ] **Step 4: Add the secret kind**

In `src/server/secrets/store.ts`, in the doc comment above `export type WorkspaceSecretKind`, replace the closing lines:

```ts
 * `workspace_cli_agent_config.risk_accepted_at` (migration 042), not here.
 */
```

with:

```ts
 * `workspace_cli_agent_config.risk_accepted_at` (migration 042), not here.
 *
 * `hunter_api_key` is a FOURTH widening, deliberate and once: the workspace's
 * own Hunter.io key for contact enrichment. Hunter's terms forbid sharing an
 * account (Section 1), so the key is per workspace, never Trevra's, and
 * Nango has no Hunter provider to hold it instead. Its single plaintext read
 * is in `enrichment/runs.ts`, at the moment a Hunter request is built, and it
 * travels only as the X-API-KEY header. Rule 1 above therefore reads "a model
 * or Hunter request" for this kind.
 */
```

Replace the union:

```ts
export type WorkspaceSecretKind =
  | 'model_api_key'
  | 'cli_oauth_token'
  | 'linkedin.email'
  | 'linkedin.password'
  | 'reddit.username'
  | 'reddit.password';
```

with:

```ts
export type WorkspaceSecretKind =
  | 'model_api_key'
  | 'cli_oauth_token'
  | 'linkedin.email'
  | 'linkedin.password'
  | 'reddit.username'
  | 'reddit.password'
  | 'hunter_api_key';
```

In `KIND_DISPLAY`, replace `  'reddit.password': 'opaque'\n};` with:

```ts
  'reddit.password': 'opaque',
  // 'opaque' for the cli_oauth_token reason above: one per workspace, never
  // compared with another, so last4 would buy nothing and cost four
  // characters of a paid credential in every backup.
  hunter_api_key: 'opaque'
};
```

- [ ] **Step 5: Create `src/server/enrichment/settings.ts`**

```ts
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { describeWorkspaceSecret, type WorkspaceSecretSummary } from '../secrets/store.js';
import { roundCredits, type EnrichmentProviderId } from './provider.js';

export type EnrichmentKeyStatus = 'missing' | 'unchecked' | 'valid' | 'invalid';
export const MAX_MONTHLY_CREDIT_CAP = 100_000;

export interface EnrichmentSettings {
  provider: EnrichmentProviderId;
  monthlyCreditCap: number;
  keyStatus: EnrichmentKeyStatus;
  keyCheckedAt: string | null;
  key: WorkspaceSecretSummary | null;
}

export interface EnrichmentUsage {
  monthStart: string;
  /** Credits written to the ledger since monthStart. */
  chargedCredits: number;
  /** Unspent estimate of every queued or running run. */
  reservedCredits: number;
  usedCredits: number;
}

export class EnrichmentError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

// lc-debt: the cap month is the UTC calendar month, not Hunter's own billing
// reset_date (GET /v2/account). The cap is Trevra's spending guard, not a
// mirror of the Hunter invoice; upgrade by storing reset_date from checkKey
// and keying monthStartUtc on it.
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getEnrichmentSettings(
  db: Db,
  workspaceId: string
): Promise<EnrichmentSettings> {
  const row = await db
    .prepare(
      'SELECT monthly_credit_cap, key_status, key_checked_at FROM enrichment_settings WHERE workspace_id=?'
    )
    .get<{ monthly_credit_cap: string; key_status: string; key_checked_at: string | null }>(
      workspaceId
    );
  const key = await describeWorkspaceSecret(db, workspaceId, 'hunter_api_key');
  const stored = (row?.key_status ?? 'unchecked') as Exclude<EnrichmentKeyStatus, 'missing'>;
  return {
    provider: 'hunter',
    monthlyCreditCap: Number(row?.monthly_credit_cap ?? 0),
    keyStatus: key ? stored : 'missing',
    keyCheckedAt:
      key && row?.key_checked_at ? new Date(String(row.key_checked_at)).toISOString() : null,
    key
  };
}

export async function setEnrichmentCap(
  db: Db,
  workspaceId: string,
  cap: number,
  actorUserId: string,
  now: Date = new Date()
): Promise<EnrichmentSettings> {
  if (
    !Number.isFinite(cap) ||
    cap < 0 ||
    cap > MAX_MONTHLY_CREDIT_CAP ||
    !Number.isInteger(cap * 2)
  )
    throw new EnrichmentError(
      `The monthly cap must be between 0 and ${MAX_MONTHLY_CREDIT_CAP} credits, in steps of 0.5.`
    );
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO enrichment_settings (workspace_id, monthly_credit_cap, updated_by_user_id, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           monthly_credit_cap=excluded.monthly_credit_cap,
           updated_by_user_id=excluded.updated_by_user_id,
           updated_at=excluded.updated_at`
      )
      .run(workspaceId, cap, actorUserId, now.toISOString());
    await appendDomainEvent(tx, {
      workspaceId,
      streamType: 'enrichment_settings',
      streamId: workspaceId,
      eventType: 'enrichment.cap_set',
      actorType: 'human',
      actorId: actorUserId,
      payload: { monthlyCreditCap: cap },
      occurredAt: now
    });
  });
  return getEnrichmentSettings(db, workspaceId);
}

export async function setEnrichmentKeyStatus(
  db: Db,
  workspaceId: string,
  status: Exclude<EnrichmentKeyStatus, 'missing'>,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO enrichment_settings (workspace_id, key_status, key_checked_at, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         key_status=excluded.key_status,
         key_checked_at=excluded.key_checked_at,
         updated_at=excluded.updated_at`
    )
    .run(workspaceId, status, status === 'unchecked' ? null : now.toISOString(), now.toISOString());
}

export async function enrichmentUsage(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<EnrichmentUsage> {
  const monthStart = monthStartUtc(now).toISOString();
  const row = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(credits) FROM enrichment_usage_ledger
                   WHERE workspace_id=? AND occurred_at >= ?::timestamptz), 0) AS charged,
         COALESCE((SELECT SUM(GREATEST(r.estimated_credits - COALESCE(spent.total, 0), 0))
                   FROM enrichment_runs r
                   LEFT JOIN LATERAL (
                     SELECT SUM(l.credits) AS total FROM enrichment_usage_ledger l
                     WHERE l.workspace_id=r.workspace_id AND l.run_id=r.id
                   ) spent ON TRUE
                   WHERE r.workspace_id=? AND r.status IN ('queued','running')), 0) AS reserved`
    )
    .get<{ charged: string; reserved: string }>(workspaceId, monthStart, workspaceId);
  const chargedCredits = roundCredits(Number(row?.charged ?? 0));
  const reservedCredits = roundCredits(Number(row?.reserved ?? 0));
  return {
    monthStart,
    chargedCredits,
    reservedCredits,
    usedCredits: roundCredits(chargedCredits + reservedCredits)
  };
}
```

- [ ] **Step 6: Add the routes to `src/server/app.ts`**

Add these imports next to the other `./watch/` and `./lead-capture/` imports near the top of the file:

```ts
import { createHunterProvider } from './enrichment/hunter.js';
import { EnrichmentProviderError } from './enrichment/provider.js';
import {
  EnrichmentError,
  enrichmentUsage,
  getEnrichmentSettings,
  MAX_MONTHLY_CREDIT_CAP,
  setEnrichmentCap,
  setEnrichmentKeyStatus
} from './enrichment/settings.js';
```

Insert this block after the closing `});` of `app.delete('/api/agent-setup/key', ...)` and before the comment that starts `// The third way to run the hosted agent`:

```ts
// Hunter bring-your-own-key enrichment (terms and custody: enrichment/hunter.ts).
// Same disciplines as the model key above: owner-only writes, a write-only
// key, no reveal route, Cache-Control: no-store. The key is checked against
// Hunter's free /account endpoint BEFORE it is sealed, so a typo never sits
// in custody looking valid.
app.get('/api/enrichment', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      settings: await getEnrichmentSettings(db, req.auth!.workspaceId),
      usage: await enrichmentUsage(db, req.auth!.workspaceId, new Date())
    });
  } catch (error) {
    next(error);
  }
});

app.put(
  '/api/enrichment/key',
  authLimiter,
  ownerOnly("store this workspace's Hunter API key"),
  async (req: AuthedRequest, res, next) => {
    try {
      if (!secretsConfigured()) {
        return res.status(400).json({
          error:
            'This server has no TREVRA_SECRETS_KEY configured, so it cannot encrypt a Hunter key. ' +
            'Generate one with `openssl rand -base64 32`, set it in the environment, and restart.'
        });
      }
      const input = z
        .object({
          apiKey: z.string().trim().min(8).max(200),
          label: z.string().trim().max(80).optional()
        })
        .strict()
        .parse(req.body ?? {});
      try {
        await createHunterProvider(input.apiKey).checkKey();
      } catch (error) {
        if (error instanceof EnrichmentProviderError && error.code === 'key_invalid') {
          return res
            .status(400)
            .json({ error: 'Hunter rejected this API key. Nothing was saved.' });
        }
        if (error instanceof EnrichmentProviderError) {
          return res.status(502).json({
            error:
              'Hunter could not confirm this key right now. Nothing was saved; try again shortly.'
          });
        }
        throw error;
      }
      await putWorkspaceSecret(db, {
        workspaceId: req.auth!.workspaceId,
        kind: 'hunter_api_key',
        plaintext: input.apiKey,
        label: input.label,
        actorUserId: req.auth!.userId
      });
      await setEnrichmentKeyStatus(db, req.auth!.workspaceId, 'valid', new Date());
      res.setHeader('Cache-Control', 'no-store');
      res.json({ settings: await getEnrichmentSettings(db, req.auth!.workspaceId) });
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  '/api/enrichment/key',
  ownerOnly("remove this workspace's Hunter API key"),
  async (req: AuthedRequest, res, next) => {
    try {
      await deleteWorkspaceSecret(db, req.auth!.workspaceId, 'hunter_api_key', req.auth!.userId);
      await setEnrichmentKeyStatus(db, req.auth!.workspaceId, 'unchecked', new Date());
      res.setHeader('Cache-Control', 'no-store');
      res.json({ settings: await getEnrichmentSettings(db, req.auth!.workspaceId) });
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  '/api/enrichment/cap',
  ownerOnly('change the enrichment credit cap'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({
          monthlyCreditCap: z.number().min(0).max(MAX_MONTHLY_CREDIT_CAP).multipleOf(0.5)
        })
        .strict()
        .parse(req.body ?? {});
      const settings = await setEnrichmentCap(
        db,
        req.auth!.workspaceId,
        input.monthlyCreditCap,
        req.auth!.userId,
        new Date()
      );
      res.json({ settings, usage: await enrichmentUsage(db, req.auth!.workspaceId, new Date()) });
    } catch (error) {
      if (error instanceof EnrichmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);
```

`secretsConfigured`, `putWorkspaceSecret`, `deleteWorkspaceSecret`, `z`, `authLimiter` and `ownerOnly` already exist in `app.ts`. The global error middleware maps `ZodError` to 400.

- [ ] **Step 7: Record the Hunter decision in the integration catalogue comment**

In `src/server/integration-service.ts`, replace:

```ts
 * an Apollo connection is exactly what it prohibits, whether Trevra is self-hosted or hosted.
 */
```

with:

```ts
 * an Apollo connection is exactly what it prohibits, whether Trevra is self-hosted or hosted.
 *
 * HUNTER IS NOT A ROW HERE EITHER, for a different reason. Its Terms of Service
 * (https://hunter.io/terms-of-service, last updated May 23, 2024, read 2026-10-06) allow "use of
 * the API through a third-party product that accesses the Services" (Section 4) but say "You must
 * not share your account with others" (Section 1), so it is bring-your-own-key per workspace, and
 * Nango's provider catalogue has no `hunter` entry. The key is sealed in workspace_secrets as
 * 'hunter_api_key'; the integration lives in src/server/enrichment/.
 */
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/settings.test.ts src/server/enrichment/api.test.ts src/server/secrets/store.test.ts`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/secrets/store.ts src/server/enrichment/settings.ts src/server/enrichment/settings.test.ts src/server/enrichment/api.test.ts src/server/app.ts src/server/integration-service.ts
git commit -m "feat(enrichment): Hunter key custody and monthly credit cap

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 5: The `enrich_contacts` objective with a priced plan preview

**Files:**

- Modify: `src/server/gtm/intent.ts` (imports at lines 3 and 13, `GTM_OBJECTIVES` 20-26, schemas 55-74, `GtmPlan` 91-108, `suppliedPlanSchema` 310-328, a new `enrichContactsPlan` after `captureInboundPlan` 699-758, `compileGtmIntent` 760-776, and the blocker status at 805)
- Test: `src/server/enrichment/plan.test.ts`

**Interfaces:**

- Consumes: `normalizeAccountDomain` (`accounts/store.ts`); `estimateEnrichmentCredits`, `roundCredits`, `HUNTER_PRICING_URL`, `ENRICHMENT_MAX_DOMAINS`, `ENRICHMENT_MAX_EMAILS_PER_DOMAIN` (Task 3); `getEnrichmentSettings`, `enrichmentUsage` (Task 4).
- Produces:
  - The `GtmObjective` member `'enrich_contacts'`.
  - `GtmIntent.enrichment?: {emailsPerDomain?: number; includeUnverified?: boolean}`.
  - The exported interface `GtmPlanCost`, and `GtmPlan.cost?: GtmPlanCost`, present only for `enrich_contacts`.
  - Blocker codes: `enrichment_owner_required`, `enrichment_domains_required`, `enrichment_too_many_domains`, `enrichment_invalid_domains`, `enrichment_secrets_unavailable`, `enrichment_key_missing`, `enrichment_key_invalid`, `enrichment_cap_missing`, `enrichment_cap_exceeded`.

- [ ] **Step 1: Write the failing plan test**

Create `src/server/enrichment/plan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, GtmPlanError, prepareGtmPlan } from '../gtm/intent.js';
import { putWorkspaceSecret } from '../secrets/store.js';
import { setEnrichmentCap, setEnrichmentKeyStatus } from './settings.js';

const WORKSPACE = 'ws_enrichment_plan';
const USER = 'usr_enrichment_plan';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

async function readyToEnrich(cap: number): Promise<void> {
  await putWorkspaceSecret(db, {
    workspaceId: WORKSPACE,
    kind: 'hunter_api_key',
    plaintext: 'hunter-plan-key-0001',
    actorUserId: USER
  });
  await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
  await setEnrichmentCap(db, WORKSPACE, cap, USER, NOW);
}

const intent = (domains: string[], enrichment?: Record<string, unknown>) => ({
  objective: 'enrich_contacts',
  audience: { domains },
  ...(enrichment ? { enrichment } : {})
});

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment plan', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-plan@trevra.test', 'Founder', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('enrich_contacts plan', () => {
  it('prices the worst case and shows it against the monthly cap', async () => {
    await readyToEnrich(20);
    const plan = await compileGtmIntent(
      db,
      WORKSPACE,
      intent(['https://www.Acme.com/about', 'northstar.ai'])
    );
    expect(plan.intent.audience?.domains).toEqual(['acme.com', 'northstar.ai']);
    expect(plan.blockers).toEqual([]);
    expect(plan.cost).toEqual({
      provider: 'hunter',
      unit: 'credits',
      domains: 2,
      emailsPerDomain: 3,
      searchCredits: 6,
      verificationCredits: 3,
      estimatedCredits: 9,
      monthlyCap: 20,
      usedThisMonth: 0,
      remainingAfter: 11,
      pricingUrl: 'https://hunter.io/pricing'
    });
    expect(plan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });
    expect(plan.defaults).toMatchObject({ prepareSupported: true, includeUnverified: false });
  });

  it('blocks a plan the remaining cap cannot cover', async () => {
    await readyToEnrich(5);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com', 'northstar.ai']));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['enrichment_cap_exceeded']);
    expect(plan.cost?.remainingAfter).toBe(-4);
    expect(plan.defaults.prepareSupported).toBe(false);
  });

  it('blocks without a key or a cap', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']));
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      'enrichment_key_missing',
      'enrichment_cap_missing'
    ]);
  });

  it('rejects entries that are not public company domains', async () => {
    await readyToEnrich(100);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['localhost', 'acme.com']));
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('enrichment_invalid_domains');
  });

  it('lets only the owner prepare paid enrichment', async () => {
    await readyToEnrich(100);
    const plan = await compileGtmIntent(db, WORKSPACE, intent(['acme.com']), {
      actorRole: 'member'
    });
    expect(plan.blockers[0]?.code).toBe('enrichment_owner_required');
    const error = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      actorRole: 'member',
      plan,
      planHash: plan.planHash,
      idempotencyKey: 'enrich-member-0001'
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GtmPlanError);
    expect((error as GtmPlanError).status).toBe(403);
  });

  it('bounds emails per domain and leaves other objectives without a cost', async () => {
    await expect(
      compileGtmIntent(db, WORKSPACE, intent(['acme.com'], { emailsPerDomain: 11 }))
    ).rejects.toThrow();
    const capture = await compileGtmIntent(db, WORKSPACE, { objective: 'capture_inbound' });
    expect('cost' in capture).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/plan.test.ts`
Expected: FAIL with a ZodError `Invalid enum value ... 'enrich_contacts'`.

- [ ] **Step 3: Extend the intent schema and plan types**

In `src/server/gtm/intent.ts`:

Replace line 3, `import { importAccounts } from '../accounts/store.js';`, with:

```ts
import { importAccounts, normalizeAccountDomain } from '../accounts/store.js';
```

After `import { secretsConfigured } from '../secrets/crypto.js';` add:

```ts
import {
  ENRICHMENT_MAX_DOMAINS,
  ENRICHMENT_MAX_EMAILS_PER_DOMAIN,
  estimateEnrichmentCredits,
  HUNTER_PRICING_URL,
  roundCredits
} from '../enrichment/provider.js';
import { enrichmentUsage, getEnrichmentSettings } from '../enrichment/settings.js';
```

Replace `GTM_OBJECTIVES` with:

```ts
export const GTM_OBJECTIVES = [
  'find_accounts',
  'research_accounts',
  'prepare_outreach',
  'watch_accounts',
  'capture_inbound',
  'enrich_contacts'
] as const;
```

After the `captureSchema` declaration (ends `.strict();` before `export const gtmIntentSchema`) add:

```ts
const DEFAULT_EMAILS_PER_DOMAIN = 3;

const enrichmentSchema = z
  .object({
    emailsPerDomain: z.number().int().min(1).max(ENRICHMENT_MAX_EMAILS_PER_DOMAIN).optional(),
    includeUnverified: z.boolean().optional()
  })
  .strict();
```

In `gtmIntentSchema`, after `    capture: captureSchema.optional(),` add:

```ts
    enrichment: enrichmentSchema.optional(),
```

Immediately before `export interface GtmPlan {` add:

```ts
/** Present only on enrich_contacts plans; part of the hashed plan, so a changed price is a stale plan. */
export interface GtmPlanCost {
  provider: 'hunter';
  unit: 'credits';
  domains: number;
  emailsPerDomain: number;
  searchCredits: number;
  verificationCredits: number;
  estimatedCredits: number;
  monthlyCap: number;
  usedThisMonth: number;
  remainingAfter: number;
  pricingUrl: string;
}
```

In `interface GtmPlan`, between the `next: {...};` member and `planHash: string;` add:

```ts
  cost?: GtmPlanCost;
```

Immediately before `const suppliedPlanSchema = z` add:

```ts
const planCostSchema = z
  .object({
    provider: z.literal('hunter'),
    unit: z.literal('credits'),
    domains: z.number(),
    emailsPerDomain: z.number(),
    searchCredits: z.number(),
    verificationCredits: z.number(),
    estimatedCredits: z.number(),
    monthlyCap: z.number(),
    usedThisMonth: z.number(),
    remainingAfter: z.number(),
    pricingUrl: z.string()
  })
  .strict();
```

In `suppliedPlanSchema`, after `    next: z.object({ kind: z.string().min(1), href: z.string().min(1) }).strict(),` add:

```ts
    cost: planCostSchema.optional(),
```

- [ ] **Step 4: Add `enrichContactsPlan`**

Insert after the closing `}` of `captureInboundPlan`:

```ts
async function enrichContactsPlan(
  db: Db,
  workspaceId: string,
  intent: GtmIntent,
  actorRole: 'owner' | 'member'
): Promise<GtmPlan> {
  const domains = intent.audience?.domains ?? [];
  const emailsPerDomain = intent.enrichment?.emailsPerDomain ?? DEFAULT_EMAILS_PER_DOMAIN;
  const includeUnverified = intent.enrichment?.includeUnverified ?? false;
  const blockers: GtmPlanBlocker[] = [];
  if (actorRole !== 'owner') {
    blockers.push({
      code: 'enrichment_owner_required',
      message: 'Only workspace owners can approve paid contact enrichment.',
      actionHref: '/setup/workspace'
    });
  }
  if (domains.length === 0) {
    blockers.push({
      code: 'enrichment_domains_required',
      message: 'Name the company domains to search for contacts.'
    });
  }
  if (domains.length > ENRICHMENT_MAX_DOMAINS) {
    blockers.push({
      code: 'enrichment_too_many_domains',
      message: `One enrichment run searches at most ${ENRICHMENT_MAX_DOMAINS} domains.`
    });
  }
  const invalid = domains.filter((domain) => normalizeAccountDomain(domain) !== domain);
  if (invalid.length > 0) {
    blockers.push({
      code: 'enrichment_invalid_domains',
      message: `${invalid.length === 1 ? 'This entry is' : 'These entries are'} not a public company domain: ${invalid.slice(0, 3).join(', ')}.`
    });
  }

  const settings = await getEnrichmentSettings(db, workspaceId);
  if (!secretsConfigured()) {
    blockers.push({
      code: 'enrichment_secrets_unavailable',
      message: 'This deployment cannot hold a Hunter key until secret encryption is configured.',
      actionHref: '/setup/workspace'
    });
  } else if (settings.keyStatus === 'missing') {
    blockers.push({
      code: 'enrichment_key_missing',
      message: 'Add your own Hunter API key before enriching contacts.',
      actionHref: '/setup/workspace'
    });
  } else if (settings.keyStatus === 'invalid') {
    blockers.push({
      code: 'enrichment_key_invalid',
      message: 'Hunter rejected the saved key. Replace it before enriching contacts.',
      actionHref: '/setup/workspace'
    });
  }

  const usage = await enrichmentUsage(db, workspaceId, new Date());
  const estimate = estimateEnrichmentCredits({ domains: domains.length, emailsPerDomain });
  const remainingAfter = roundCredits(
    settings.monthlyCreditCap - usage.usedCredits - estimate.estimatedCredits
  );
  if (settings.monthlyCreditCap <= 0) {
    blockers.push({
      code: 'enrichment_cap_missing',
      message: 'Set a monthly Hunter credit cap before enriching contacts.',
      actionHref: '/setup/workspace'
    });
  } else if (domains.length > 0 && remainingAfter < 0) {
    blockers.push({
      code: 'enrichment_cap_exceeded',
      message: `This plan could use up to ${estimate.estimatedCredits} credits, but ${Math.max(0, roundCredits(settings.monthlyCreditCap - usage.usedCredits))} remain under this month's cap.`,
      actionHref: '/setup/workspace'
    });
  }

  const companies = `${domains.length} ${domains.length === 1 ? 'company' : 'companies'}`;
  return finalizePlan({
    objective: 'enrich_contacts',
    intent,
    summary: `Find up to ${emailsPerDomain} verified ${emailsPerDomain === 1 ? 'contact' : 'contacts'} at each of ${companies} with your Hunter key`,
    steps: [
      {
        kind: 'domain_search',
        title: 'Domain search',
        detail: `Ask Hunter for up to ${emailsPerDomain} personal emails per domain (1 credit per email found).`,
        externalEffect: false
      },
      {
        kind: 'verify',
        title: 'Verify',
        detail:
          'Verify each sourced email before saving it (0.5 credit per completed verification).',
        externalEffect: false
      },
      {
        kind: 'person',
        title: 'People',
        detail: includeUnverified
          ? 'Save verified emails, plus accept-all or unknown ones marked unverified, as People on their Account.'
          : 'Save only verified emails with a published source as People on their Account.',
        externalEffect: false
      }
    ],
    blockers,
    defaults: {
      prepareSupported: blockers.length === 0,
      provider: 'hunter',
      emailsPerDomain,
      includeUnverified,
      verify: true
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    },
    next: { kind: 'review_accounts', href: '/outreach' },
    cost: {
      provider: 'hunter',
      unit: 'credits',
      domains: domains.length,
      emailsPerDomain,
      searchCredits: estimate.searchCredits,
      verificationCredits: estimate.verificationCredits,
      estimatedCredits: estimate.estimatedCredits,
      monthlyCap: settings.monthlyCreditCap,
      usedThisMonth: usage.usedCredits,
      remainingAfter,
      pricingUrl: HUNTER_PRICING_URL
    }
  });
}
```

The `cost` key is set only here. `canonicalPayloadHash` hashes an `undefined` member as `null` (`control-plane/payload.ts` `stableJson`). Adding `cost: undefined` to other objectives would therefore change every existing plan hash.

- [ ] **Step 5: Dispatch and map the owner blocker to 403**

In `compileGtmIntent`, replace:

```ts
return captureInboundPlan(intent, context.actorRole ?? 'owner');
```

with:

```ts
if (intent.objective === 'enrich_contacts') {
  return enrichContactsPlan(db, workspaceId, intent, context.actorRole ?? 'owner');
}
return captureInboundPlan(intent, context.actorRole ?? 'owner');
```

In `prepareGtmPlan`, replace:

```ts
throw new GtmPlanError(first.message, first.code === 'capture_owner_required' ? 403 : 409);
```

with:

```ts
throw new GtmPlanError(
  first.message,
  first.code === 'capture_owner_required' || first.code === 'enrichment_owner_required' ? 403 : 409
);
```

Until Task 6, an unblocked `enrich_contacts` plan reaches the existing "inspectable but is not yet composed" 409.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/plan.test.ts src/server/gtm/intent.test.ts`
Expected: PASS. The existing `intent.test.ts` hashes are unchanged.

- [ ] **Step 7: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/gtm/intent.ts src/server/enrichment/plan.test.ts
git commit -m "feat(gtm): price enrich_contacts plans against the credit cap

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 6: Approval queues a run; the worker spends within the estimate and the cap

**Files:**

- Create: `src/server/enrichment/runs.ts`
- Modify: `src/server/lead-capture/people.ts:246-298` (`resolveExplicitAccount`)
- Modify: `src/server/gtm/intent.ts` (result type 110-149, `prepareGtmPlan` 778-873)
- Modify: `src/worker/index.ts:34` and `:123-129`
- Modify: `src/client/views/LoopView.tsx:26` and `:1347-1376` (prepared result branch)
- Test: `src/server/enrichment/runs.test.ts`

**Interfaces:**

- Consumes:
  - `readWorkspaceSecretPlaintext` (`secrets/store.ts`), the only plaintext read for `hunter_api_key`.
  - `resolveContact`, `resolveExplicitAccount` (`lead-capture/people.ts`).
  - `createHunterProvider` and the provider types (Task 3).
  - `getEnrichmentSettings`, `enrichmentUsage`, `setEnrichmentKeyStatus`, `EnrichmentError` (Task 4).
  - `GtmPlan.cost` and `defaults` (Task 5).
- Produces:
  - `runs.ts` exports `EnrichmentRunSummary`, `findEnrichmentRunByKey(db, workspaceId, idempotencyKey)`, `queueEnrichmentRun(db, input, now?)`, `runQueuedEnrichmentRuns(db, {now?, providerFor?, limit?})` and `pruneEnrichmentHistory(db, now?)`.
  - `PreparedEnrichmentGtmPlanResult` joins the `PreparedGtmPlanResult` union.
  - `resolveExplicitAccount` input gains `source: 'enrichment'` and `confidence?: 'explicit' | 'verified' | 'inferred'`.

- [ ] **Step 1: Write the failing run test**

Create `src/server/enrichment/runs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, GtmPlanError, prepareGtmPlan } from '../gtm/intent.js';
import { deleteWorkspaceSecret, putWorkspaceSecret } from '../secrets/store.js';
import {
  EnrichmentProviderError,
  estimateEnrichmentCredits,
  type ContactEnrichmentProvider,
  type EmailVerificationStatus,
  type EnrichmentCandidate,
  type EnrichmentProviderErrorCode
} from './provider.js';
import { pruneEnrichmentHistory, queueEnrichmentRun, runQueuedEnrichmentRuns } from './runs.js';
import {
  EnrichmentError,
  enrichmentUsage,
  getEnrichmentSettings,
  setEnrichmentCap,
  setEnrichmentKeyStatus
} from './settings.js';

const WORKSPACE = 'ws_enrichment_runs';
const USER = 'usr_enrichment_runs';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

function candidate(
  email: string,
  sourceUri: string | null = 'https://acme.com/team'
): EnrichmentCandidate {
  return {
    email,
    firstName: 'Maya',
    lastName: 'Chen',
    position: 'CEO',
    sourceUri,
    providerConfidence: 90
  };
}

function fakeHunter(script: {
  search?: Record<string, EnrichmentCandidate[]>;
  verify?: Record<string, EmailVerificationStatus>;
  failVerifyWith?: EnrichmentProviderErrorCode;
}) {
  const calls: string[] = [];
  const provider: ContactEnrichmentProvider = {
    id: 'hunter',
    async checkKey() {},
    async domainSearch(domain, { limit }) {
      calls.push(`search:${domain}:${limit}`);
      const candidates = script.search?.[domain] ?? [];
      return { candidates, credits: candidates.length };
    },
    async verifyEmail(email) {
      calls.push(`verify:${email}`);
      if (script.failVerifyWith) throw new EnrichmentProviderError('fake', script.failVerifyWith);
      const status = script.verify?.[email] ?? 'valid';
      return { status, credits: status === 'unknown' ? 0 : 0.5 };
    }
  };
  return { calls, providerFor: () => provider };
}

async function queue(
  key: string,
  domains: string[],
  options: { emailsPerDomain?: number; includeUnverified?: boolean } = {}
) {
  const emailsPerDomain = options.emailsPerDomain ?? 3;
  return queueEnrichmentRun(
    db,
    {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      idempotencyKey: key,
      planHash: 'd'.repeat(64),
      domains,
      emailsPerDomain,
      includeUnverified: options.includeUnverified ?? false,
      estimatedCredits: estimateEnrichmentCredits({ domains: domains.length, emailsPerDomain })
        .estimatedCredits
    },
    NOW
  );
}

async function runRow(runId: string) {
  return db
    .prepare('SELECT status, attempts, last_error, progress_json FROM enrichment_runs WHERE id=?')
    .get<{ status: string; attempts: number; last_error: string | null; progress_json: unknown }>(
      runId
    );
}

async function ledgerTotal(runId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(credits),0) AS total FROM enrichment_usage_ledger WHERE run_id=?')
    .get<{ total: string }>(runId);
  return Number(row?.total ?? 0);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment runs', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-runs@trevra.test', 'Founder', NOW.toISOString());
  await putWorkspaceSecret(db, {
    workspaceId: WORKSPACE,
    kind: 'hunter_api_key',
    plaintext: 'hunter-runs-key-0001',
    actorUserId: USER
  });
  await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
  await setEnrichmentCap(db, WORKSPACE, 50, USER, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('enrichment runs', () => {
  it('queues an approved run once and records a content-free approval event', async () => {
    const first = await queue('enrich-key-0001', ['acme.com']);
    expect(first.duplicate).toBe(false);
    expect(first.run).toMatchObject({ status: 'queued', domainCount: 1, estimatedCredits: 4.5 });
    const again = await queue('enrich-key-0001', ['acme.com']);
    expect(again).toMatchObject({ duplicate: true, run: { id: first.run.id } });
    const conflict = await queueEnrichmentRun(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        idempotencyKey: 'enrich-key-0001',
        planHash: 'e'.repeat(64),
        domains: ['acme.com'],
        emailsPerDomain: 3,
        includeUnverified: false,
        estimatedCredits: 4.5
      },
      NOW
    ).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(EnrichmentError);
    expect((conflict as EnrichmentError).status).toBe(409);
    const events = await db
      .prepare(
        "SELECT payload_json FROM domain_events WHERE workspace_id=? AND event_type='enrichment_run.approved'"
      )
      .all<{ payload_json: unknown }>(WORKSPACE);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload_json)).not.toContain('acme.com');
  });

  it('two concurrent approvals cannot both reserve past the cap', async () => {
    await setEnrichmentCap(db, WORKSPACE, 10, USER, NOW);
    const results = await Promise.allSettled([
      queue('enrich-race-a001', ['acme.com', 'northstar.ai']),
      queue('enrich-race-b001', ['beta.io', 'gamma.io'])
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EnrichmentError);
    expect((rejected.reason as EnrichmentError).status).toBe(409);
    expect((await enrichmentUsage(db, WORKSPACE, NOW)).reservedCredits).toBe(9);
  });

  it('saves only sourced, verified emails on the searched domain and charges every call', async () => {
    const { run } = await queue('enrich-save-0001', ['acme.com'], { emailsPerDomain: 4 });
    const hunter = fakeHunter({
      search: {
        'acme.com': [
          candidate('maya@acme.com'),
          candidate('joe@acme.com'),
          candidate('anon@acme.com', null),
          candidate('x@other.com')
        ]
      },
      verify: { 'maya@acme.com': 'valid', 'joe@acme.com': 'accept_all' }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual([
      'search:acme.com:4',
      'verify:maya@acme.com',
      'verify:joe@acme.com'
    ]);
    expect((await runRow(run.id))?.status).toBe('completed');
    expect(await ledgerTotal(run.id)).toBe(5);
    const links = await db
      .prepare(
        `SELECT c.email_normalized, ac.source, ac.confidence, ac.source_detail
         FROM account_contacts ac JOIN contacts c ON c.id=ac.contact_id
         WHERE ac.workspace_id=? ORDER BY c.email_normalized`
      )
      .all(WORKSPACE);
    expect(links).toEqual([
      {
        email_normalized: 'maya@acme.com',
        source: 'enrichment',
        confidence: 'verified',
        source_detail: 'hunter https://acme.com/team'
      }
    ]);
  });

  it('saves accept-all emails as inferred only when the plan opts in', async () => {
    await queue('enrich-loose-0001', ['acme.com'], { emailsPerDomain: 1, includeUnverified: true });
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('joe@acme.com')] },
      verify: { 'joe@acme.com': 'accept_all' }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    const link = await db
      .prepare('SELECT confidence FROM account_contacts WHERE workspace_id=?')
      .get<{ confidence: string }>(WORKSPACE);
    expect(link?.confidence).toBe('inferred');
  });

  it('a revoked key fails the run and marks the key invalid', async () => {
    const { run } = await queue('enrich-revoked-01', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      failVerifyWith: 'key_invalid'
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3', 'verify:maya@acme.com']);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Hunter rejected the saved key. Replace it and re-plan.'
    });
    expect(await ledgerTotal(run.id)).toBe(1);
    expect((await getEnrichmentSettings(db, WORKSPACE)).keyStatus).toBe('invalid');
    const replan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['acme.com'] }
    });
    expect(replan.blockers.map((blocker) => blocker.code)).toContain('enrichment_key_invalid');
  });

  it('a key deleted before the run starts fails it without calling Hunter', async () => {
    const { run } = await queue('enrich-deleted-01', ['acme.com']);
    await deleteWorkspaceSecret(db, WORKSPACE, 'hunter_api_key', USER);
    const hunter = fakeHunter({});
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual([]);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'The Hunter key was removed before this run finished.'
    });
  });

  it('stops before spending past the approved estimate when the provider over-delivers', async () => {
    const { run } = await queue('enrich-over-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: {
        'acme.com': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((local) =>
          candidate(`${local}@acme.com`)
        )
      }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Stopped before exceeding the approved credit estimate.'
    });
  });

  it('releases a rate-limited run and fails it after three attempts', async () => {
    const { run } = await queue('enrich-limit-0001', ['acme.com']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      failVerifyWith: 'rate_limited'
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(await runRow(run.id)).toMatchObject({ status: 'queued', attempts: 1 });
    await db.prepare('UPDATE enrichment_runs SET attempts=3 WHERE id=?').run(run.id);
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Stopped after 3 attempts.'
    });
  });

  it('a copy whose lease another replica took over stops before its next paid call', async () => {
    const { run } = await queue('enrich-lease-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({});
    const providerFor = (): ContactEnrichmentProvider => {
      const inner = hunter.providerFor();
      return {
        ...inner,
        async domainSearch(domain, options) {
          // Another replica re-claims the run (claimRun bumps attempts) while
          // this call is in flight.
          await db.prepare('UPDATE enrichment_runs SET attempts=attempts+1 WHERE id=?').run(run.id);
          return inner.domainSearch(domain, options);
        }
      };
    };
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    // Left to the replica that holds it now: not finished, not released.
    expect(await runRow(run.id)).toMatchObject({
      status: 'running',
      attempts: 2,
      last_error: null
    });
  });

  it('prepares an approved plan into one queued run, and a retry replays it', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['acme.com'] }
    });
    const prepare = (actorRole: 'owner' | 'member' = 'owner') =>
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        actorRole,
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'enrich-prepare-01'
      });
    const first = await prepare();
    expect(first).toMatchObject({
      status: 'prepared',
      objective: 'enrich_contacts',
      next: { kind: 'review_accounts', href: '/outreach' }
    });
    // The queued run now reserves credits, so a re-compiled plan differs;
    // the retry must replay by key instead of reporting the plan as stale.
    const retry = await prepare();
    expect(retry.artifacts).toEqual(first.artifacts);
    expect(retry).toMatchObject({ result: { duplicate: true } });
    // A member cannot read the queued run back through the owner's key.
    const asMember = await prepare('member').catch((caught: unknown) => caught);
    expect(asMember).toBeInstanceOf(GtmPlanError);
    expect((asMember as GtmPlanError).status).toBe(403);
  });

  it('prunes ledger rows and finished runs older than 13 months', async () => {
    await db
      .prepare(
        `INSERT INTO enrichment_runs
           (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits,status,finished_at)
         VALUES ('enr_old',?,'hunter','old-key-000001',?,?,3,4.5,'completed','2025-08-01T00:00:00Z')`
      )
      .run(WORKSPACE, 'f'.repeat(64), ['acme.com']);
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
         VALUES ('enl_old',?,'enr_old','hunter','domain_search',3,'2025-08-01T00:00:00Z'),
                ('enl_new',?,'enr_new','hunter','domain_search',3,'2026-10-01T00:00:00Z')`
      )
      .run(WORKSPACE, WORKSPACE);
    await pruneEnrichmentHistory(db, NOW);
    const left = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM enrichment_runs WHERE id='enr_old') AS runs,
                (SELECT string_agg(id, ',') FROM enrichment_usage_ledger WHERE workspace_id=?) AS ledger`
      )
      .get<{ runs: string; ledger: string }>(WORKSPACE);
    expect(Number(left?.runs)).toBe(0);
    expect(left?.ledger).toBe('enl_new');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/runs.test.ts`
Expected: FAIL with `Cannot find module './runs.js'`.

- [ ] **Step 3: Let `resolveExplicitAccount` record enrichment confidence**

In `src/server/lead-capture/people.ts`, in `resolveExplicitAccount`'s input type, replace:

```ts
    source?: 'capture' | 'import' | 'manual';
    sourceDetail?: string | null;
```

with:

```ts
    source?: 'capture' | 'import' | 'manual' | 'enrichment';
    sourceDetail?: string | null;
    /** Defaults to 'explicit'. Enrichment writes 'verified' or, when opted in, 'inferred'. */
    confidence?: 'explicit' | 'verified' | 'inferred';
```

Replace the insert statement and its arguments:

```ts
      ) VALUES (?,?,?,?,?,?,'explicit',?,?,?)
      ON CONFLICT (workspace_id,account_id,contact_id) DO NOTHING
    `
    )
    .run(
      id('acp'),
      workspaceId,
      row.id,
      contactId,
      input.role?.trim() || null,
      input.source ?? 'capture',
      input.sourceDetail?.trim() || null,
      at,
      at
    );
```

with:

```ts
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (workspace_id,account_id,contact_id) DO NOTHING
    `
    )
    .run(
      id('acp'),
      workspaceId,
      row.id,
      contactId,
      input.role?.trim() || null,
      input.source ?? 'capture',
      input.confidence ?? 'explicit',
      input.sourceDetail?.trim() || null,
      at,
      at
    );
```

The existing callers (`submissions.ts:120`, `import.ts:71`) pass no `confidence`, so they keep writing `'explicit'`.

- [ ] **Step 4: Create `src/server/enrichment/runs.ts`**

```ts
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { resolveContact, resolveExplicitAccount } from '../lead-capture/people.js';
import { LeadCaptureError } from '../lead-capture/types.js';
import { readWorkspaceSecretPlaintext } from '../secrets/store.js';
import { createHunterProvider } from './hunter.js';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  roundCredits,
  type ContactEnrichmentProvider,
  type EnrichmentCandidate,
  type EnrichmentProviderId
} from './provider.js';
import {
  EnrichmentError,
  enrichmentUsage,
  getEnrichmentSettings,
  setEnrichmentKeyStatus
} from './settings.js';

/**
 * Approved enrichment runs: the only code that spends a workspace's Hunter
 * credits, and the only reader of the 'hunter_api_key' plaintext.
 *
 * Two invariants, both enforced here and nowhere else:
 *  1. CAP. A run is queued only under the `${workspaceId}:enrichment-cap`
 *     advisory lock, after re-checking that this month's charges plus every
 *     open run's unspent estimate plus this estimate fit the cap. Concurrent
 *     or duplicate approvals therefore cannot both reserve the same credits.
 *  2. ESTIMATE. Before every paid call the run checks that its own ledger
 *     total plus that call's worst-case price stays within the approved
 *     estimate, so a run can never spend credits its plan did not show.
 * Every paid call is written to enrichment_usage_ledger before its result
 * is used. Every paid call is also preceded by a lease heartbeat fenced on
 * `attempts`: a replica that re-claimed the run after an expired lease bumped
 * `attempts`, so the older copy stops instead of spending twice.
 */
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60 * 1000;
const RETENTION_MONTHS = 13;

export interface EnrichmentRunSummary {
  id: string;
  provider: EnrichmentProviderId;
  status: 'queued' | 'running' | 'completed' | 'failed';
  domainCount: number;
  emailsPerDomain: number;
  includeUnverified: boolean;
  estimatedCredits: number;
  createdAt: string;
}

interface RunRow {
  id: string;
  workspace_id: string;
  plan_hash: string;
  domains: string[];
  emails_per_domain: number;
  include_unverified: boolean;
  estimated_credits: string;
  status: string;
  attempts: number;
  progress_json: unknown;
  created_at: string;
}

interface RunProgress {
  doneDomains: number;
  saved: number;
  skipped: number;
}

class EstimateReached extends Error {}
/** Another replica re-claimed this run after its lease expired; stop without writing. */
class LeaseLost extends Error {}

function summarize(row: RunRow): EnrichmentRunSummary {
  return {
    id: row.id,
    provider: 'hunter',
    status: row.status as EnrichmentRunSummary['status'],
    domainCount: row.domains.length,
    emailsPerDomain: Number(row.emails_per_domain),
    includeUnverified: Boolean(row.include_unverified),
    estimatedCredits: Number(row.estimated_credits),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function readProgress(value: unknown): RunProgress {
  const raw = (
    typeof value === 'string' ? JSON.parse(value) : value
  ) as Partial<RunProgress> | null;
  return {
    doneDomains: Number(raw?.doneDomains ?? 0) || 0,
    saved: Number(raw?.saved ?? 0) || 0,
    skipped: Number(raw?.skipped ?? 0) || 0
  };
}

export async function findEnrichmentRunByKey(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<{ run: EnrichmentRunSummary; planHash: string } | null> {
  const row = await db
    .prepare('SELECT * FROM enrichment_runs WHERE workspace_id=? AND idempotency_key=?')
    .get<RunRow>(workspaceId, idempotencyKey);
  return row ? { run: summarize(row), planHash: row.plan_hash } : null;
}

export async function queueEnrichmentRun(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    idempotencyKey: string;
    planHash: string;
    domains: string[];
    emailsPerDomain: number;
    includeUnverified: boolean;
    estimatedCredits: number;
  },
  now: Date = new Date()
): Promise<{ run: EnrichmentRunSummary; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
      .get(`${input.workspaceId}:enrichment-cap`);
    const existing = await tx
      .prepare('SELECT * FROM enrichment_runs WHERE workspace_id=? AND idempotency_key=?')
      .get<RunRow>(input.workspaceId, input.idempotencyKey);
    if (existing) {
      if (existing.plan_hash !== input.planHash) {
        throw new EnrichmentError(
          'This idempotency key was already used for a different enrichment plan.',
          409
        );
      }
      return { run: summarize(existing), duplicate: true };
    }
    const settings = await getEnrichmentSettings(tx, input.workspaceId);
    const usage = await enrichmentUsage(tx, input.workspaceId, now);
    if (
      settings.monthlyCreditCap <= 0 ||
      roundCredits(usage.usedCredits + input.estimatedCredits) > settings.monthlyCreditCap
    ) {
      throw new EnrichmentError(
        "This plan no longer fits under this month's Hunter credit cap. Re-plan to see what remains.",
        409
      );
    }
    const row = await tx
      .prepare(
        `INSERT INTO enrichment_runs
           (id,workspace_id,provider,idempotency_key,plan_hash,actor_user_id,domains,
            emails_per_domain,include_unverified,estimated_credits,status,created_at)
         VALUES (?,?,'hunter',?,?,?,?,?,?,?,'queued',?)
         RETURNING *`
      )
      .get<RunRow>(
        id('enr'),
        input.workspaceId,
        input.idempotencyKey,
        input.planHash,
        input.actorUserId,
        input.domains,
        input.emailsPerDomain,
        input.includeUnverified,
        input.estimatedCredits,
        now.toISOString()
      );
    if (!row) throw new Error('Enrichment run could not be queued');
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'enrichment_run',
      streamId: row.id,
      eventType: 'enrichment_run.approved',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: {
        provider: 'hunter',
        domains: input.domains.length,
        emailsPerDomain: input.emailsPerDomain,
        includeUnverified: input.includeUnverified,
        estimatedCredits: input.estimatedCredits
      },
      occurredAt: now
    });
    return { run: summarize(row), duplicate: false };
  });
}

export interface RunQueuedEnrichmentOptions {
  now?: Date;
  providerFor?: (apiKey: string) => ContactEnrichmentProvider;
  limit?: number;
}

export async function runQueuedEnrichmentRuns(
  db: Db,
  options: RunQueuedEnrichmentOptions = {}
): Promise<{ processed: number }> {
  const now = options.now ?? new Date();
  const providerFor = options.providerFor ?? ((apiKey: string) => createHunterProvider(apiKey));
  await pruneEnrichmentHistory(db, now);
  await failExhaustedRuns(db, now);
  let processed = 0;
  // lc-debt: one run per tick per replica, on the worker's own enrichment
  // loop (src/worker/index.ts), so a long run never holds the control-plane
  // cycle. A deep queue drains slowly; raise `limit` or move runs to a
  // Temporal activity when queues form.
  for (let index = 0; index < (options.limit ?? 1); index += 1) {
    const run = await claimRun(db, now);
    if (!run) break;
    await executeRun(db, run, providerFor, now);
    processed += 1;
  }
  return { processed };
}

async function claimRun(db: Db, now: Date): Promise<RunRow | null> {
  const row = await db
    .prepare(
      `UPDATE enrichment_runs
         SET status='running', attempts=attempts+1, lease_until=?::timestamptz,
             started_at=COALESCE(started_at, ?::timestamptz)
       WHERE id = (
         SELECT id FROM enrichment_runs
         WHERE attempts < ?
           AND (status='queued' OR (status='running' AND lease_until < ?::timestamptz))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    )
    .get<RunRow>(
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      MAX_ATTEMPTS,
      now.toISOString()
    );
  return row ?? null;
}

async function failExhaustedRuns(db: Db, now: Date): Promise<void> {
  const rows = await db
    .prepare(
      `UPDATE enrichment_runs
         SET status='failed', last_error='Stopped after 3 attempts.', finished_at=?::timestamptz,
             lease_until=NULL
       WHERE attempts >= ?
         AND (status='queued' OR (status='running' AND lease_until < ?::timestamptz))
       RETURNING id, workspace_id`
    )
    .all<{ id: string; workspace_id: string }>(now.toISOString(), MAX_ATTEMPTS, now.toISOString());
  for (const row of rows) {
    await appendDomainEvent(db, {
      workspaceId: row.workspace_id,
      streamType: 'enrichment_run',
      streamId: row.id,
      eventType: 'enrichment_run.failed',
      actorType: 'system',
      payload: { reason: 'attempts_exhausted' },
      occurredAt: now
    });
  }
}

async function spentOnRun(db: Db, workspaceId: string, runId: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(SUM(credits),0) AS total FROM enrichment_usage_ledger WHERE workspace_id=? AND run_id=?'
    )
    .get<{ total: string }>(workspaceId, runId);
  return roundCredits(Number(row?.total ?? 0));
}

function emailOnDomain(email: string, domain: string): boolean {
  const host = email.split('@')[1] ?? '';
  return host === domain || host.endsWith(`.${domain}`);
}

async function saveCandidate(
  db: Db,
  workspaceId: string,
  domain: string,
  candidate: EnrichmentCandidate,
  confidence: 'verified' | 'inferred',
  now: Date
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const resolved = await resolveContact(
        tx,
        workspaceId,
        {
          name: [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || null,
          email: candidate.email,
          role: candidate.position
        },
        now
      );
      const linked = await resolveExplicitAccount(
        tx,
        workspaceId,
        resolved.contact.id,
        {
          domain,
          role: candidate.position,
          source: 'enrichment',
          confidence,
          sourceDetail: `hunter ${candidate.sourceUri ?? ''}`.slice(0, 600)
        },
        now
      );
      return linked !== null;
    });
  } catch (error) {
    // Two existing People claim this identity: leave it for review, never merge.
    if (error instanceof LeadCaptureError) return false;
    throw error;
  }
}

async function finishRun(
  db: Db,
  run: RunRow,
  outcome: {
    status: 'completed' | 'failed';
    error: string | null;
    progress: RunProgress;
    spent: number;
  },
  now: Date
): Promise<void> {
  await db.transaction(async (tx) => {
    // Fenced like the heartbeat: a copy that lost its lease finishes nothing.
    const finished = await tx
      .prepare(
        `UPDATE enrichment_runs
           SET status=?, last_error=?, finished_at=?::timestamptz, lease_until=NULL, progress_json=?::jsonb
         WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
         RETURNING id`
      )
      .get<{ id: string }>(
        outcome.status,
        outcome.error,
        now.toISOString(),
        JSON.stringify(outcome.progress),
        run.id,
        run.workspace_id,
        run.attempts
      );
    if (!finished) return;
    await appendDomainEvent(tx, {
      workspaceId: run.workspace_id,
      streamType: 'enrichment_run',
      streamId: run.id,
      eventType: `enrichment_run.${outcome.status}`,
      actorType: 'system',
      payload: {
        domainsDone: outcome.progress.doneDomains,
        saved: outcome.progress.saved,
        skipped: outcome.progress.skipped,
        creditsSpent: outcome.spent
      },
      occurredAt: now
    });
  });
}

async function releaseRun(db: Db, run: RunRow, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE enrichment_runs SET status='queued', lease_until=NULL, last_error=?
       WHERE id=? AND workspace_id=? AND status='running' AND attempts=?`
    )
    .run(reason, run.id, run.workspace_id, run.attempts);
}

async function executeRun(
  db: Db,
  run: RunRow,
  providerFor: (apiKey: string) => ContactEnrichmentProvider,
  now: Date
): Promise<void> {
  const workspaceId = run.workspace_id;
  const progress = readProgress(run.progress_json);
  let spent = await spentOnRun(db, workspaceId, run.id);
  // The ONE plaintext read of 'hunter_api_key' (secrets/store.ts module comment).
  const apiKey = await readWorkspaceSecretPlaintext(db, workspaceId, 'hunter_api_key');
  if (!apiKey) {
    return finishRun(
      db,
      run,
      {
        status: 'failed',
        error: 'The Hunter key was removed before this run finished.',
        progress,
        spent
      },
      now
    );
  }
  const provider = providerFor(apiKey);
  const estimate = Number(run.estimated_credits);
  const ensureBudget = (worstCase: number) => {
    if (roundCredits(spent + worstCase) > estimate) throw new EstimateReached();
  };
  // Lease time advances with the wall clock from the injected `now`, so tests
  // that pin `now` stay deterministic and a long run keeps extending its lease.
  const startedWall = Date.now();
  const leaseUntil = () =>
    new Date(now.getTime() + (Date.now() - startedWall) + LEASE_MS).toISOString();
  // Before every paid call. claimRun bumps `attempts`, so if another replica
  // re-claimed this run after an expired lease, this copy's fence fails and it
  // stops before spending.
  const heartbeat = async () => {
    const held = await db
      .prepare(
        `UPDATE enrichment_runs SET lease_until=?::timestamptz
         WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
         RETURNING id`
      )
      .get<{ id: string }>(leaseUntil(), run.id, workspaceId, run.attempts);
    if (!held) throw new LeaseLost();
  };
  const charge = async (operation: 'domain_search' | 'email_verifier', credits: number) => {
    if (credits <= 0) return;
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
         VALUES (?,?,?,'hunter',?,?,?::timestamptz)`
      )
      .run(id('enl'), workspaceId, run.id, operation, credits, now.toISOString());
    spent = roundCredits(spent + credits);
  };

  try {
    for (let index = progress.doneDomains; index < run.domains.length; index += 1) {
      const domain = run.domains[index]!;
      const limit = Number(run.emails_per_domain);
      ensureBudget(limit * HUNTER_CREDIT_PRICE.perEmailFound);
      await heartbeat();
      const search = await provider.domainSearch(domain, { limit });
      await charge('domain_search', search.credits);
      for (const candidate of search.candidates.slice(0, limit)) {
        // contact.ts rule 3 (SOURCED): an address with no public page is never saved.
        if (!candidate.sourceUri || !emailOnDomain(candidate.email, domain)) {
          progress.skipped += 1;
          continue;
        }
        ensureBudget(HUNTER_CREDIT_PRICE.perVerification);
        await heartbeat();
        const verification = await provider.verifyEmail(candidate.email);
        await charge('email_verifier', verification.credits);
        // contact.ts rule 4 (NEVER GUESS SILENTLY): unverified only on opt-in, labelled.
        const confidence =
          verification.status === 'valid'
            ? 'verified'
            : run.include_unverified &&
                (verification.status === 'accept_all' || verification.status === 'unknown')
              ? 'inferred'
              : null;
        if (!confidence) {
          progress.skipped += 1;
          continue;
        }
        if (await saveCandidate(db, workspaceId, domain, candidate, confidence, now)) {
          progress.saved += 1;
        } else {
          progress.skipped += 1;
        }
      }
      progress.doneDomains = index + 1;
      const checkpointed = await db
        .prepare(
          `UPDATE enrichment_runs SET progress_json=?::jsonb, lease_until=?::timestamptz
           WHERE id=? AND workspace_id=? AND status='running' AND attempts=?
           RETURNING id`
        )
        .get<{ id: string }>(
          JSON.stringify(progress),
          leaseUntil(),
          run.id,
          workspaceId,
          run.attempts
        );
      if (!checkpointed) throw new LeaseLost();
    }
    await finishRun(db, run, { status: 'completed', error: null, progress, spent }, now);
  } catch (error) {
    if (error instanceof LeaseLost) return;
    if (error instanceof EstimateReached) {
      return finishRun(
        db,
        run,
        {
          status: 'failed',
          error: 'Stopped before exceeding the approved credit estimate.',
          progress,
          spent
        },
        now
      );
    }
    if (error instanceof EnrichmentProviderError) {
      if (error.code === 'key_invalid') {
        await setEnrichmentKeyStatus(db, workspaceId, 'invalid', now);
        return finishRun(
          db,
          run,
          {
            status: 'failed',
            error: 'Hunter rejected the saved key. Replace it and re-plan.',
            progress,
            spent
          },
          now
        );
      }
      if (error.code === 'rate_limited' || error.code === 'unavailable') {
        // lc-debt: a retry repeats the unfinished domain, and the ledger
        // charges its search again although Hunter counts a repeat search once
        // per billing period. This overstates usage, so the cap errs safe;
        // upgrade by checkpointing per candidate.
        return releaseRun(db, run, error.message);
      }
      return finishRun(db, run, { status: 'failed', error: error.message, progress, spent }, now);
    }
    await releaseRun(db, run, 'Unexpected error; the run will be retried.');
    throw error;
  }
}

/** Closer for the ledger and finished runs: 13 months, so a full year compares to the same month last year. */
export async function pruneEnrichmentHistory(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, now.getUTCDate())
  ).toISOString();
  try {
    await db
      .prepare('DELETE FROM enrichment_usage_ledger WHERE occurred_at < ?::timestamptz')
      .run(cutoff);
    await db
      .prepare(
        "DELETE FROM enrichment_runs WHERE status IN ('completed','failed') AND finished_at < ?::timestamptz"
      )
      .run(cutoff);
  } catch (error) {
    console.error('Enrichment history prune failed', error);
  }
}
```

- [ ] **Step 5: Compose `enrich_contacts` through `prepareGtmPlan`**

In `src/server/gtm/intent.ts`, replace the Task 5 import line `import { enrichmentUsage, getEnrichmentSettings } from '../enrichment/settings.js';` with:

```ts
import {
  findEnrichmentRunByKey,
  queueEnrichmentRun,
  type EnrichmentRunSummary
} from '../enrichment/runs.js';
import { EnrichmentError, enrichmentUsage, getEnrichmentSettings } from '../enrichment/settings.js';
```

Replace:

```ts
export type PreparedGtmPlanResult =
  PreparedOutreachGtmPlanResult | PreparedCaptureGtmPlanResult | PreparedWatchGtmPlanResult;
```

with:

```ts
export interface PreparedEnrichmentGtmPlanResult {
  status: 'prepared';
  objective: 'enrich_contacts';
  artifacts: { enrichmentRunId: string };
  next: { kind: 'review_accounts'; href: '/outreach' };
  result: { run: EnrichmentRunSummary; duplicate: boolean };
}

export type PreparedGtmPlanResult =
  | PreparedOutreachGtmPlanResult
  | PreparedCaptureGtmPlanResult
  | PreparedWatchGtmPlanResult
  | PreparedEnrichmentGtmPlanResult;

function preparedEnrichment(
  run: EnrichmentRunSummary,
  duplicate: boolean
): PreparedEnrichmentGtmPlanResult {
  return {
    status: 'prepared',
    objective: 'enrich_contacts',
    artifacts: { enrichmentRunId: run.id },
    next: { kind: 'review_accounts', href: '/outreach' },
    result: { run, duplicate }
  };
}
```

In `prepareGtmPlan`, replace:

```ts
const current = await compileGtmIntent(db, input.workspaceId, supplied.intent, {
  actorRole: input.actorRole
});
```

with:

```ts
if (supplied.objective === 'enrich_contacts') {
  // The owner gate runs before the replay too, so a member cannot read a
  // queued run's summary back through someone else's idempotency key.
  if (input.actorRole !== 'owner') {
    throw new GtmPlanError('Only workspace owners can approve paid contact enrichment.', 403);
  }
  // Replay BEFORE re-compiling: a queued run reserves credits, which moves
  // cost.usedThisMonth, so a retried prepare would otherwise call its own
  // run's plan stale.
  const replay = await findEnrichmentRunByKey(db, input.workspaceId, input.idempotencyKey);
  if (replay) {
    if (replay.planHash !== supplied.planHash) {
      throw new GtmPlanError(
        'This idempotency key was already used for a different enrichment plan.',
        409
      );
    }
    return preparedEnrichment(replay.run, true);
  }
}

const current = await compileGtmIntent(db, input.workspaceId, supplied.intent, {
  actorRole: input.actorRole
});
```

Insert before `  if (current.objective !== 'prepare_outreach') {`:

```ts
if (current.objective === 'enrich_contacts') {
  try {
    const queued = await queueEnrichmentRun(db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      planHash: current.planHash,
      domains: current.intent.audience?.domains ?? [],
      emailsPerDomain: Number(current.defaults.emailsPerDomain),
      includeUnverified: current.defaults.includeUnverified === true,
      estimatedCredits: current.cost?.estimatedCredits ?? 0
    });
    return preparedEnrichment(queued.run, queued.duplicate);
  } catch (error) {
    if (error instanceof EnrichmentError) throw new GtmPlanError(error.message, error.status);
    throw error;
  }
}
```

- [ ] **Step 6: Drain the queue from the worker**

In `src/worker/index.ts`, after `import { runDueBrandWatches } from '../server/watch/service.js';` add:

```ts
import { runQueuedEnrichmentRuns } from '../server/enrichment/runs.js';
```

A run can take minutes at Hunter's rate limit, so it gets its own loop and in-flight flag, like the LinkedIn and companion-presence loops; inside `cycle()` it would hold the automation sweep behind it.

After `companionPresenceTimer.unref();` add:

```ts
// Contact enrichment gets its own loop for the same reason as LinkedIn: one
// run makes paced paid calls for minutes, and inside `cycle()` it would hold
// the automation sweep behind it. The drain does not wait for it; a run cut
// off mid-way keeps its per-domain checkpoint, and once its lease expires the
// next claim resumes it under a new `attempts` fence.
let enrichmentRunning = false;
async function enrichmentCycle(): Promise<void> {
  if (enrichmentRunning || draining) return;
  enrichmentRunning = true;
  try {
    await runQueuedEnrichmentRuns(db);
  } catch (error) {
    console.error('Worker enrichment cycle failed', error);
  } finally {
    enrichmentRunning = false;
  }
}
void enrichmentCycle();
const enrichmentTimer = setInterval(() => void enrichmentCycle(), runtime.automationIntervalMs);
enrichmentTimer.unref();
```

In `shutdown`, after `clearInterval(companionPresenceTimer);` add:

```ts
clearInterval(enrichmentTimer);
```

- [ ] **Step 7: Show the prepared enrichment result in the planner**

Widening `PreparedGtmPlanResult` breaks the planner's final `else` branch at typecheck, because that branch reads `prepared.result.campaign`.

In `src/client/views/LoopView.tsx`, replace line 26, `import { Select } from '../ui/primitives';`, with:

```ts
import { Button, Select } from '../ui/primitives';
```

In the prepared-result ternary, replace the opening of the final branch:

```tsx
                  ) : (
                    <>
                      <span>
                        {prepared.result.campaign.enrolled} people · campaign remains{' '}
```

with:

```tsx
                  ) : prepared.objective === 'enrich_contacts' ? (
                    <>
                      <span>
                        Approved. Hunter enrichment for {prepared.result.run.domainCount}{' '}
                        {prepared.result.run.domainCount === 1 ? 'company' : 'companies'} is
                        queued and stops at {prepared.result.run.estimatedCredits} credits. Saved
                        contacts appear on their Account.
                      </span>
                      <Button variant="primary" onClick={() => onNavigate(prepared.next.href)}>
                        Review accounts <ChevronRight size={15} />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span>
                        {prepared.result.campaign.enrolled} people · campaign remains{' '}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/enrichment/runs.test.ts src/server/enrichment/plan.test.ts src/server/gtm/intent.test.ts src/server/lead-capture/api.test.ts`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run: `npm run check`
Expected: exit 0. The typecheck covers the LoopView union branch.

```bash
git add src/server/enrichment/runs.ts src/server/enrichment/runs.test.ts src/server/lead-capture/people.ts src/server/gtm/intent.ts src/worker/index.ts src/client/views/LoopView.tsx
git commit -m "feat(enrichment): queue approved runs and spend within the cap

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 7: Enrichment setup panel and the priced planner preview

**Files:**

- Modify: `src/client/api.ts` (type imports near line 69, functions after `prepareCompiledGtmPlan` at 554-562)
- Create: `src/client/views/planCost.ts`
- Test: `src/client/views/planCost.test.ts`
- Create: `src/client/EnrichmentSetup.tsx`
- Modify: `src/client/App.tsx:82` (import) and `:599` (render after `<LimitsView setToast={setToast} />`)
- Modify: `src/client/views/LoopView.tsx` (`PlannerObjective` 945-954, state 978-998, `compile` 1031-1062, form 1129-1236, preview 1262-1302)
- Modify: `src/client/styles.css` (after the `.gtm-plan-result { padding-top: 12px; ... }` rule, about line 12794)

**Interfaces:**

- Consumes: `GtmPlanCost` (Task 5); `EnrichmentSettings`, `EnrichmentUsage` (Task 4); the `/api/enrichment*` routes (Task 4).
- Produces:
  - `api.ts` exports the types `GtmPlanCost`, `EnrichmentSettings`, `EnrichmentUsage` and the functions `getEnrichment()`, `saveHunterKey(apiKey)`, `deleteHunterKey()`, `saveEnrichmentCap(monthlyCreditCap)`.
  - `planCost.ts` exports `formatCredits`, `planCostLines`, `approveLabel`, `keyStatusLine` and `usageLine`.
  - `EnrichmentSetup` component.

- [ ] **Step 1: Write the failing formatter test**

Create `src/client/views/planCost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EnrichmentSettings, GtmPlanCost } from '../api';
import { approveLabel, formatCredits, keyStatusLine, planCostLines, usageLine } from './planCost';

const cost: GtmPlanCost = {
  provider: 'hunter',
  unit: 'credits',
  domains: 2,
  emailsPerDomain: 3,
  searchCredits: 6,
  verificationCredits: 3,
  estimatedCredits: 9,
  monthlyCap: 20,
  usedThisMonth: 4.5,
  remainingAfter: 6.5,
  pricingUrl: 'https://hunter.io/pricing'
};

const settings: EnrichmentSettings = {
  provider: 'hunter',
  monthlyCreditCap: 20,
  keyStatus: 'valid',
  keyCheckedAt: '2026-10-06T09:00:00.000Z',
  key: null
};

describe('plan cost copy', () => {
  it('formats whole and half credits with the right noun', () => {
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(4.5)).toBe('4.5 credits');
    expect(formatCredits(0)).toBe('0 credits');
  });

  it('states the worst case, the month so far and what remains', () => {
    expect(planCostLines(cost)).toEqual([
      'Up to 9 credits: 6 credits to search 2 domains (3 per domain) and 3 credits to verify.',
      'This month: 4.5 credits used or reserved of a 20 credits cap.',
      '6.5 credits would remain under the cap.'
    ]);
    expect(planCostLines({ ...cost, remainingAfter: -4 })[2]).toBe(
      'This exceeds the cap by 4 credits.'
    );
  });

  it('puts the credit ceiling on the approve button', () => {
    expect(approveLabel(cost, false)).toBe('Approve · up to 9 credits');
    expect(approveLabel(undefined, false)).toBe('Prepare this');
    expect(approveLabel(cost, true)).toBe('Preparing…');
  });

  it('describes key and usage state', () => {
    expect(keyStatusLine(settings)).toBe('Hunter key saved and accepted on 2026-10-06.');
    expect(keyStatusLine({ ...settings, keyStatus: 'missing' })).toBe('No Hunter key saved.');
    expect(
      usageLine(settings, {
        monthStart: '2026-10-01T00:00:00.000Z',
        chargedCredits: 3,
        reservedCredits: 1.5,
        usedCredits: 4.5
      })
    ).toBe('4.5 credits of 20 credits used or reserved since 2026-10-01.');
    expect(
      usageLine(
        { ...settings, monthlyCreditCap: 0 },
        {
          monthStart: '2026-10-01T00:00:00.000Z',
          chargedCredits: 0,
          reservedCredits: 0,
          usedCredits: 0
        }
      )
    ).toBe('Enrichment is off until you set a monthly credit cap.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/planCost.test.ts`
Expected: FAIL with `Cannot find module './planCost'`.

- [ ] **Step 3: Add the client API**

In `src/client/api.ts`, after line 69, `import type { GtmIntent, GtmPlan, PreparedGtmPlanResult } from '../server/gtm/intent';`, add:

```ts
import type { EnrichmentSettings, EnrichmentUsage } from '../server/enrichment/settings';
export type { GtmPlanCost } from '../server/gtm/intent';
export type { EnrichmentSettings, EnrichmentUsage } from '../server/enrichment/settings';
```

After the closing `}` of `prepareCompiledGtmPlan`, add:

```ts
export async function getEnrichment(): Promise<{
  settings: EnrichmentSettings;
  usage: EnrichmentUsage;
}> {
  return request('/api/enrichment');
}

export async function saveHunterKey(apiKey: string): Promise<EnrichmentSettings> {
  const result = await request<{ settings: EnrichmentSettings }>('/api/enrichment/key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey })
  });
  return result.settings;
}

export async function deleteHunterKey(): Promise<EnrichmentSettings> {
  const result = await request<{ settings: EnrichmentSettings }>('/api/enrichment/key', {
    method: 'DELETE'
  });
  return result.settings;
}

export async function saveEnrichmentCap(
  monthlyCreditCap: number
): Promise<{ settings: EnrichmentSettings; usage: EnrichmentUsage }> {
  return request('/api/enrichment/cap', {
    method: 'PUT',
    body: JSON.stringify({ monthlyCreditCap })
  });
}
```

- [ ] **Step 4: Create `src/client/views/planCost.ts`**

```ts
import type { EnrichmentSettings, EnrichmentUsage, GtmPlanCost } from '../api';

export function formatCredits(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'credit' : 'credits'}`;
}

export function planCostLines(cost: GtmPlanCost): string[] {
  const domains = `${cost.domains} ${cost.domains === 1 ? 'domain' : 'domains'}`;
  return [
    `Up to ${formatCredits(cost.estimatedCredits)}: ${formatCredits(cost.searchCredits)} to search ${domains} (${cost.emailsPerDomain} per domain) and ${formatCredits(cost.verificationCredits)} to verify.`,
    `This month: ${formatCredits(cost.usedThisMonth)} used or reserved of a ${formatCredits(cost.monthlyCap)} cap.`,
    cost.remainingAfter >= 0
      ? `${formatCredits(cost.remainingAfter)} would remain under the cap.`
      : `This exceeds the cap by ${formatCredits(-cost.remainingAfter)}.`
  ];
}

export function approveLabel(cost: GtmPlanCost | undefined, preparing: boolean): string {
  if (preparing) return 'Preparing…';
  return cost ? `Approve · up to ${formatCredits(cost.estimatedCredits)}` : 'Prepare this';
}

export function keyStatusLine(settings: EnrichmentSettings): string {
  switch (settings.keyStatus) {
    case 'missing':
      return 'No Hunter key saved.';
    case 'unchecked':
      return 'Hunter key saved, not yet checked.';
    case 'valid':
      return settings.keyCheckedAt
        ? `Hunter key saved and accepted on ${settings.keyCheckedAt.slice(0, 10)}.`
        : 'Hunter key saved and accepted.';
    case 'invalid':
      return 'Hunter rejected the saved key. Replace it to enrich again.';
  }
}

export function usageLine(settings: EnrichmentSettings, usage: EnrichmentUsage): string {
  if (settings.monthlyCreditCap <= 0)
    return 'Enrichment is off until you set a monthly credit cap.';
  return `${formatCredits(usage.usedCredits)} of ${formatCredits(settings.monthlyCreditCap)} used or reserved since ${usage.monthStart.slice(0, 10)}.`;
}
```

- [ ] **Step 5: Create `src/client/EnrichmentSetup.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  deleteHunterKey,
  getEnrichment,
  saveEnrichmentCap,
  saveHunterKey,
  type EnrichmentSettings,
  type EnrichmentUsage
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { Panel } from './ui/layout';
import { Button, Field, Input } from './ui/primitives';
import { keyStatusLine, usageLine } from './views/planCost';

export function EnrichmentSetup({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [settings, setSettings] = useState<EnrichmentSettings | null>(null);
  const [usage, setUsage] = useState<EnrichmentUsage | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState<'' | 'key' | 'remove' | 'cap'>('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getEnrichment()
      .then((result) => {
        if (cancelled) return;
        setSettings(result.settings);
        setUsage(result.usage);
        setCap(String(result.settings.monthlyCreditCap));
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(errorMessage(error, 'Enrichment settings could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    setBusy('key');
    setProblem('');
    try {
      setSettings(await saveHunterKey(apiKey.trim()));
      setApiKey('');
      setToast('Hunter key checked and saved.');
    } catch (error) {
      setProblem(errorMessage(error, 'The Hunter key could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  const removeKey = async () => {
    setBusy('remove');
    setProblem('');
    try {
      setSettings(await deleteHunterKey());
      setToast('Hunter key removed.');
    } catch (error) {
      setProblem(errorMessage(error, 'The Hunter key could not be removed.'));
    } finally {
      setBusy('');
    }
  };

  const saveCap = async () => {
    const value = Number(cap);
    if (!Number.isFinite(value)) {
      setProblem('Enter a number of credits.');
      return;
    }
    setBusy('cap');
    setProblem('');
    try {
      const result = await saveEnrichmentCap(value);
      setSettings(result.settings);
      setUsage(result.usage);
      setToast('Monthly credit cap saved.');
    } catch (error) {
      setProblem(errorMessage(error, 'The credit cap could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Panel
      title="Contact enrichment"
      description="Find verified contacts at named accounts with your own Hunter key. Each run is approved in a plan and stops at the credits that plan showed."
      icon={<KeyRound size={18} />}
    >
      {problem && <div className="error-banner">{problem}</div>}
      {settings && usage ? (
        <div className="enrichment-setup">
          <p className="enrichment-setup-status">
            {keyStatusLine(settings)} {usageLine(settings, usage)}
          </p>
          {isOwner ? (
            <>
              <div className="enrichment-setup-row">
                <Field label="Hunter API key" hint="Stored encrypted. Trevra never shows it again.">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      settings.keyStatus === 'missing'
                        ? 'Paste your key'
                        : 'Paste a new key to replace it'
                    }
                  />
                </Field>
                <Button
                  variant="primary"
                  disabled={busy !== '' || apiKey.trim().length < 8}
                  onClick={() => void saveKey()}
                >
                  {busy === 'key' ? 'Checking…' : 'Save key'}
                </Button>
                {settings.keyStatus !== 'missing' && (
                  <Button variant="danger" disabled={busy !== ''} onClick={() => void removeKey()}>
                    {busy === 'remove' ? 'Removing…' : 'Remove key'}
                  </Button>
                )}
              </div>
              <div className="enrichment-setup-row">
                <Field
                  label="Monthly credit cap"
                  hint="0 turns enrichment off. Hunter's free plan includes 50 credits a month."
                >
                  <Input
                    type="number"
                    min={0}
                    max={100000}
                    step={0.5}
                    inputMode="decimal"
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                </Field>
                <Button
                  disabled={busy !== '' || cap === String(settings.monthlyCreditCap)}
                  onClick={() => void saveCap()}
                >
                  {busy === 'cap' ? 'Saving…' : 'Save cap'}
                </Button>
              </div>
            </>
          ) : (
            <p className="enrichment-setup-status">
              Only the workspace owner can change the key or the cap.
            </p>
          )}
        </div>
      ) : !problem ? (
        <p className="enrichment-setup-status">Loading…</p>
      ) : null}
    </Panel>
  );
}
```

- [ ] **Step 6: Render it in workspace setup**

In `src/client/App.tsx`, after line 82, `import { LeadCaptureSetup } from './LeadCaptureSetup';`, add:

```ts
import { EnrichmentSetup } from './EnrichmentSetup';
```

In the `onWorkspace` grid, replace:

```tsx
<LimitsView setToast={setToast} />
```

with:

```tsx
          <LimitsView setToast={setToast} />
          <EnrichmentSetup setToast={setToast} />
```

This is the existing `/setup/workspace` page. No route or navigation change is needed.

- [ ] **Step 7: Add the objective to the planner**

In `src/client/views/LoopView.tsx`:

Replace the Task 6 import `import { Button, Select } from '../ui/primitives';` with:

```ts
import { Button, Field, Input, Select, SwitchField, Textarea } from '../ui/primitives';
import { approveLabel, planCostLines } from './planCost';
```

Replace the `PlannerObjective` type and `PLANNER_OBJECTIVES`:

```ts
type PlannerObjective =
  'find_accounts' | 'research_accounts' | 'prepare_outreach' | 'watch_accounts' | 'capture_inbound';

const PLANNER_OBJECTIVES: ReadonlyArray<{ value: PlannerObjective; label: string }> = [
  { value: 'find_accounts', label: 'Find prospects' },
  { value: 'research_accounts', label: 'Research accounts' },
  { value: 'prepare_outreach', label: 'Prepare outreach' },
  { value: 'watch_accounts', label: 'Watch accounts' },
  { value: 'capture_inbound', label: 'Capture inbound' }
];
```

with:

```ts
type PlannerObjective =
  | 'find_accounts'
  | 'research_accounts'
  | 'prepare_outreach'
  | 'watch_accounts'
  | 'capture_inbound'
  | 'enrich_contacts';

const PLANNER_OBJECTIVES: ReadonlyArray<{ value: PlannerObjective; label: string }> = [
  { value: 'find_accounts', label: 'Find prospects' },
  { value: 'research_accounts', label: 'Research accounts' },
  { value: 'prepare_outreach', label: 'Prepare outreach' },
  { value: 'watch_accounts', label: 'Watch accounts' },
  { value: 'capture_inbound', label: 'Capture inbound' },
  { value: 'enrich_contacts', label: 'Find contacts (Hunter)' }
];
```

In `PlanWork`, after `  const [accountDomains, setAccountDomains] = useState('');` add:

```ts
const [emailsPerDomain, setEmailsPerDomain] = useState(3);
const [includeUnverified, setIncludeUnverified] = useState(false);
```

In `compile`, replace the start of the last branch of the intent ternary:

```ts
              : {
                  objective,
                  audience: {
                    ...(audience.trim() ? { description: audience.trim() } : {}),
                    quantity
                  }
                };
```

with:

```ts
              : objective === 'enrich_contacts'
                ? {
                    objective,
                    audience: { domains: plannerDomains(accountDomains) },
                    enrichment: { emailsPerDomain, includeUnverified }
                  }
                : {
                    objective,
                    audience: {
                      ...(audience.trim() ? { description: audience.trim() } : {}),
                      quantity
                    }
                  };
```

In the form, replace the start of the final branch:

```tsx
            ) : (
              <>
                <label>
                  Audience
```

with:

```tsx
            ) : objective === 'enrich_contacts' ? (
              <>
                <Field label="Company domains" hint="One per line. Up to 100 per run.">
                  <Textarea
                    value={accountDomains}
                    onChange={(event) => {
                      setAccountDomains(event.target.value);
                      resetPlan();
                    }}
                    placeholder={'acme.com\nnorthstar.ai'}
                    rows={4}
                  />
                </Field>
                <Field label="Contacts per company" hint="Each one found costs up to 1.5 Hunter credits.">
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={emailsPerDomain}
                    onChange={(event) => {
                      setEmailsPerDomain(Math.max(1, Math.min(10, Number(event.target.value) || 1)));
                      resetPlan();
                    }}
                  />
                </Field>
                <SwitchField
                  label="Also save unverified emails"
                  description="Off by default. Accept-all or unknown addresses are saved marked unverified."
                  checked={includeUnverified}
                  onChange={(event) => {
                    setIncludeUnverified(event.target.checked);
                    resetPlan();
                  }}
                />
              </>
            ) : (
              <>
                <label>
                  Audience
```

In the preview, replace:

```tsx
              </ol>

              {plan.blockers.length > 0 && (
```

with:

```tsx
              </ol>

              {plan.cost && (
                <div className="gtm-plan-cost">
                  <strong>Hunter credits</strong>
                  {planCostLines(plan.cost).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                  <a href={plan.cost.pricingUrl} target="_blank" rel="noreferrer">
                    Hunter pricing
                  </a>
                </div>
              )}

              {plan.blockers.length > 0 && (
```

Replace the prepare button label `{preparing ? 'Preparing…' : 'Prepare this'}` with:

```tsx
{
  approveLabel(plan.cost, preparing);
}
```

- [ ] **Step 8: Add layout CSS**

In `src/client/styles.css`, after the rule:

```css
.gtm-plan-result {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
```

add:

```css
.gtm-plan-cost {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-r-md);
  background: var(--t-surface-2);
}
.gtm-plan-cost span,
.gtm-plan-cost a {
  font-size: var(--t-text-xs);
}
.gtm-plan-cost span {
  color: var(--t-muted);
}
.enrichment-setup {
  display: grid;
  gap: 14px;
}
.enrichment-setup-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 10px;
}
.enrichment-setup-status {
  margin: 0;
  color: var(--t-muted);
  font-size: var(--t-text-xs);
}
@media (max-width: 640px) {
  .enrichment-setup-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

These rules own layout only. Controls keep the shared primitive skin.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/planCost.test.ts src/client/ui/route.test.ts`
Expected: PASS.

- [ ] **Step 10: Check the screens by hand**

Run: `npm run dev`. Open `/setup/workspace` and `/loop` (planner "Plan work", goal "Find contacts (Hunter)") in light and dark themes, at desktop width and at 375 px.

Expected:

- The key, cap and approve controls are at least `--t-tap` high with visible focus.
- The cost block reads correctly.
- The setup rows stack on mobile.
- A member sees the read-only line.

- [ ] **Step 11: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/client/api.ts src/client/views/planCost.ts src/client/views/planCost.test.ts src/client/EnrichmentSetup.tsx src/client/App.tsx src/client/views/LoopView.tsx src/client/styles.css
git commit -m "feat(enrichment): setup panel and priced plan preview

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 8: Content-free AI-answer citation samples as brand-watch mentions

**Files:**

- Create: `src/server/watch/citations.ts`
- Test: `src/server/watch/citations.test.ts`

**Interfaces:**

- Consumes:
  - `createCaptureSource`, `getWorkspaceCaptureSource`, `listCaptureSources` (`lead-capture/sources.ts`); `CITATION_SOURCE_KIND`, `LeadCaptureError`, `CaptureSourceRecord` (Task 2).
  - `normalizeAccountDomain`; `SENTIMENT_VERSION` (`watch/sentiment.ts`).
  - `getWatchMention`, `BrandWatch`, `WatchMention` (`watch/store.ts`).
  - Tables from Task 1.
- Produces:
  - Constants and types: `AI_ANSWER_PLATFORM`, `AI_ANSWER_ENGINES`, `AI_ANSWER_ENGINE_LABELS`, `citationSampleSchema`, `CitationSample`, `CitationChange`, `CitationSourceLink`, `CitationSourceView`.
  - URL and domain helpers: `normalizeOwnedDomains`, `citedUrlWithinOwnedDomains`, `sanitizeCitedUrl`.
  - Link lookups: `citationSourceView`, `getCitationLinkForWatch`, `getCitationLinkForSource`.
  - `connectCitationSource(db, {workspaceId, actorUserId, watch, ownedDomains}, now?)` returns `{link, source, secret, created}`.
  - `recordCitationSample(db, {link, idempotencyKey, payloadHash, sample}, now?)` returns `{change, mention, duplicate}`.
  - `pruneCitationSamples(db, now?)`.

Sample contract (the JSON body Beseam or any sampler posts):

- `sampleId`: a stable id.
- `engine`: one of `chatgpt`, `google_ai_mode`, `gemini`, `perplexity`, `copilot`, `claude`, `google_search` (the engines listed in `research_notes/LemonCrow and Beseam GTM needs/beseam.md`).
- `promptRef`: `id:<label>` or `sha256:<hex of the prompt text>`.
- `answeredAt`: ISO-8601 UTC.
- `brandCited`: boolean.
- `citedUrls`: at most 20 URLs on the watch's own domains.
- `position`: 1-100 or null.

The schema is strict, so an answer text field is rejected.

- [ ] **Step 1: Write the failing store test**

Create `src/server/watch/citations.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listCaptureSources } from '../lead-capture/sources.js';
import { LeadCaptureError } from '../lead-capture/types.js';
import {
  citationSampleSchema,
  connectCitationSource,
  pruneCitationSamples,
  recordCitationSample,
  type CitationSample,
  type CitationSourceLink
} from './citations.js';
import { createWatch, listWatchMentions, type BrandWatch } from './store.js';

const WORKSPACE = 'ws_ai_citations';
const USER = 'usr_ai_citations';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let watch: BrandWatch;
let link: CitationSourceLink;

function sample(overrides: Partial<CitationSample> = {}): CitationSample {
  return citationSampleSchema.parse({
    sampleId: 'beseam-0001',
    engine: 'chatgpt',
    promptRef: 'id:best-gtm-ledger',
    answeredAt: '2026-10-02T08:00:00.000Z',
    brandCited: true,
    citedUrls: ['https://trevra.com/pricing?utm_source=chatgpt#plans'],
    position: 2,
    ...overrides
  });
}

async function record(value: CitationSample, key = `sample-${value.sampleId}`) {
  return recordCitationSample(
    db,
    {
      link,
      idempotencyKey: key,
      payloadHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      sample: value
    },
    NOW
  );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'AI citations', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'ai-citations@trevra.test', 'Founder', NOW.toISOString());
  watch = await createWatch(
    db,
    WORKSPACE,
    { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
    NOW
  );
  ({ link } = await connectCitationSource(
    db,
    {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      watch,
      ownedDomains: ['https://www.Trevra.com/', 'docs.trevra.dev']
    },
    NOW
  ));
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('AI-answer citations', () => {
  it('connects one hidden signed source per watch and reveals its secret once', async () => {
    expect(link.ownedDomains).toEqual(['docs.trevra.dev', 'trevra.com']);
    const again = await connectCitationSource(
      db,
      { workspaceId: WORKSPACE, actorUserId: USER, watch, ownedDomains: ['trevra.com'] },
      NOW
    );
    expect(again).toMatchObject({ created: false, secret: null });
    expect(again.link.captureSourceId).toBe(link.captureSourceId);
    expect(again.link.ownedDomains).toEqual(['trevra.com']);
    const listed = await listCaptureSources(db, WORKSPACE);
    expect(listed.map((source) => source.id)).not.toContain(link.captureSourceId);
  });

  it('records a first citation as gained, a repeat as kept and a drop as lost', async () => {
    const gained = await record(sample());
    expect(gained.change).toBe('gained');
    expect(gained.mention).toMatchObject({
      platform: 'ai_answer',
      url: 'https://trevra.com/pricing',
      content: '',
      title: 'Cited by ChatGPT for prompt “best-gtm-ledger”',
      sentimentLabel: 'neutral'
    });
    expect(gained.mention?.metadata).toMatchObject({
      source: 'ai_answer',
      change: 'gained',
      engine: 'chatgpt',
      engineLabel: 'ChatGPT',
      position: 2,
      citedUrls: ['https://trevra.com/pricing']
    });
    const kept = await record(
      sample({ sampleId: 'beseam-0002', answeredAt: '2026-10-03T08:00:00.000Z' })
    );
    expect(kept).toMatchObject({ change: 'kept', mention: null });
    const lost = await record(
      sample({
        sampleId: 'beseam-0003',
        answeredAt: '2026-10-04T08:00:00.000Z',
        brandCited: false,
        citedUrls: [],
        position: null
      })
    );
    expect(lost.change).toBe('lost');
    expect(lost.mention?.title).toBe('No longer cited by ChatGPT for prompt “best-gtm-ledger”');
    const mentions = await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' });
    expect(mentions).toHaveLength(2);
  });

  it('an older sample arriving late is stale and creates no mention', async () => {
    await record(sample({ answeredAt: '2026-10-03T08:00:00.000Z' }));
    const late = await record(
      sample({
        sampleId: 'beseam-late',
        answeredAt: '2026-10-01T08:00:00.000Z',
        brandCited: false,
        citedUrls: [],
        position: null
      })
    );
    expect(late).toMatchObject({ change: 'stale', mention: null });
    const next = await record(
      sample({ sampleId: 'beseam-0004', answeredAt: '2026-10-04T08:00:00.000Z' })
    );
    expect(next.change).toBe('kept');
    expect(
      await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' })
    ).toHaveLength(1);
  });

  it('replays a retried sample and refuses changed content under the same sample id', async () => {
    const first = await record(sample());
    const retry = await record(sample());
    expect(retry).toMatchObject({ duplicate: true, change: 'gained' });
    expect(retry.mention?.id).toBe(first.mention?.id);
    const changed = await record(sample({ position: 5 }), 'sample-other-key').catch(
      (caught: unknown) => caught
    );
    expect(changed).toBeInstanceOf(LeadCaptureError);
    expect((changed as LeadCaptureError).status).toBe(409);
  });

  it('rejects lookalike and foreign cited URLs', async () => {
    for (const url of [
      'https://trevra.com.evil.io/pricing',
      'https://eviltrevra.com/',
      'https://user:pw@trevra.com/',
      'ftp://trevra.com/file'
    ]) {
      const error = await record(sample({ sampleId: 'beseam-bad', citedUrls: [url] })).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(LeadCaptureError);
      expect((error as LeadCaptureError).status).toBe(400);
    }
    const rows = await db
      .prepare('SELECT COUNT(*) AS count FROM ai_citation_samples WHERE watch_id=?')
      .get<{ count: string }>(watch.id);
    expect(Number(rows?.count)).toBe(0);
    const subdomain = await record(
      sample({ sampleId: 'beseam-sub', citedUrls: ['https://api.docs.trevra.dev/x'] })
    );
    expect(subdomain.change).toBe('gained');
  });

  it('accepts no answer text and no URLs on a sample that did not cite the brand', () => {
    const base = {
      sampleId: 'beseam-0001',
      engine: 'gemini',
      promptRef: `sha256:${'a'.repeat(64)}`,
      answeredAt: '2026-10-02T08:00:00.000Z',
      brandCited: false
    };
    expect(citationSampleSchema.safeParse(base).success).toBe(true);
    expect(citationSampleSchema.safeParse({ ...base, answerText: 'Trevra is...' }).success).toBe(
      false
    );
    expect(
      citationSampleSchema.safeParse({ ...base, citedUrls: ['https://trevra.com/'] }).success
    ).toBe(false);
    expect(citationSampleSchema.safeParse({ ...base, promptRef: 'best crm?' }).success).toBe(false);
  });

  it('prunes samples after 13 months and closes orphaned citation sources', async () => {
    await record(sample());
    await record(sample({ sampleId: 'beseam-0002', answeredAt: '2026-10-03T08:00:00.000Z' }));
    await db
      .prepare(
        "UPDATE ai_citation_samples SET received_at='2025-08-01T00:00:00Z' WHERE watch_id=? AND sample_id=?"
      )
      .run(watch.id, 'beseam-0001');
    await pruneCitationSamples(db, NOW);
    const kept = await db
      .prepare('SELECT sample_id FROM ai_citation_samples WHERE watch_id=?')
      .all<{ sample_id: string }>(watch.id);
    expect(kept.map((row) => row.sample_id)).toEqual(['beseam-0002']);
    const linked = await db
      .prepare('SELECT COUNT(*) AS count FROM capture_sources WHERE id=?')
      .get<{ count: string }>(link.captureSourceId);
    expect(Number(linked?.count)).toBe(1);
    await db.prepare('DELETE FROM brand_watches WHERE id=?').run(watch.id);
    await db
      .prepare("UPDATE capture_sources SET created_at='2026-10-01T00:00:00Z' WHERE id=?")
      .run(link.captureSourceId);
    await pruneCitationSamples(db, NOW);
    const left = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ai_citation_samples WHERE workspace_id=?) AS samples,
                (SELECT COUNT(*) FROM capture_sources WHERE id=?) AS sources`
      )
      .get<{ samples: string; sources: string }>(WORKSPACE, link.captureSourceId);
    expect(Number(left?.samples)).toBe(0);
    expect(Number(left?.sources)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/watch/citations.test.ts`
Expected: FAIL with `Cannot find module './citations.js'`.

- [ ] **Step 3: Implement the citation store**

Create `src/server/watch/citations.ts`:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeAccountDomain } from '../accounts/store.js';
import { id, type Db } from '../db.js';
import { createCaptureSource, getWorkspaceCaptureSource } from '../lead-capture/sources.js';
import {
  CITATION_SOURCE_KIND,
  LeadCaptureError,
  type CaptureSourceRecord
} from '../lead-capture/types.js';
import { SENTIMENT_VERSION } from './sentiment.js';
import { getWatchMention, type BrandWatch, type WatchMention } from './store.js';

/**
 * AI-answer citations: content-free samples of whether an AI engine cited the
 * founder's own site for a tracked prompt. A sampler (Beseam, or anything that
 * can sign) posts one sample per engine, prompt and run.
 *
 * Only TRANSITIONS become brand-watch mentions: a first citation or a regained
 * one is `gained`, a drop is `lost`. A repeat (`kept`) or a run that never
 * cited the brand (`absent`) is state, not news, and only updates
 * `ai_citation_samples`. These mentions are written here rather than through
 * `recordWatchMentions`, so they never touch the sentiment trend: a citation
 * is not a sentiment.
 *
 * Nothing here stores answer text or prompt text. `citationSampleSchema` is
 * strict, so a body carrying either is refused before it reaches storage.
 */

export const AI_ANSWER_PLATFORM = 'ai_answer';
export const AI_ANSWER_ENGINES = [
  'chatgpt',
  'google_ai_mode',
  'gemini',
  'perplexity',
  'copilot',
  'claude',
  'google_search'
] as const;
export type AiAnswerEngine = (typeof AI_ANSWER_ENGINES)[number];
export const AI_ANSWER_ENGINE_LABELS: Record<AiAnswerEngine, string> = {
  chatgpt: 'ChatGPT',
  google_ai_mode: 'Google AI Mode',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  copilot: 'Copilot',
  claude: 'Claude',
  google_search: 'Google Search'
};

const MAX_OWNED_DOMAINS = 20;
const MAX_CITED_URLS = 20;
const FUTURE_SKEW_MS = 5 * 60_000;
const RETENTION_MONTHS = 13;
// A citation source whose watch is gone is closed after this grace period. The
// grace covers the gap between createCaptureSource committing and the link row
// being written; a retry inside it reuses the source through its
// preparation key.
const ORPHAN_GRACE_MS = 60 * 60_000;

export const citationSampleSchema = z
  .object({
    sampleId: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
        'sampleId must be 1-120 letters, digits, dots, underscores, colons or hyphens'
      ),
    engine: z.enum(AI_ANSWER_ENGINES),
    promptRef: z
      .string()
      .regex(
        /^(id:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}|sha256:[a-f0-9]{64})$/,
        'promptRef must be id:<label> or sha256:<64 lowercase hex characters>'
      ),
    answeredAt: z.string().datetime({ offset: true }),
    brandCited: z.boolean(),
    citedUrls: z.array(z.string().trim().min(1).max(2048)).max(MAX_CITED_URLS).default([]),
    position: z.number().int().min(1).max(100).nullable().default(null)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.brandCited && (value.citedUrls.length > 0 || value.position !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['brandCited'],
        message: 'A sample that did not cite the brand carries no cited URLs or position'
      });
    }
  });
export type CitationSample = z.infer<typeof citationSampleSchema>;

export type CitationChange = 'gained' | 'lost' | 'kept' | 'absent' | 'stale';

export interface CitationSourceLink {
  watchId: string;
  workspaceId: string;
  captureSourceId: string;
  ownedDomains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CitationSourceView {
  watchId: string;
  sourceId: string;
  status: 'active' | 'disabled';
  ownedDomains: string[];
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  latestAnsweredAt: string | null;
}

interface LinkRow {
  watch_id: string;
  workspace_id: string;
  capture_source_id: string;
  owned_domains: string[];
  created_at: string;
  updated_at: string;
}

function toLink(row: LinkRow): CitationSourceLink {
  return {
    watchId: row.watch_id,
    workspaceId: row.workspace_id,
    captureSourceId: row.capture_source_id,
    ownedDomains: row.owned_domains ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeOwnedDomains(raw: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const entry of raw) {
    const domain = normalizeAccountDomain(entry);
    if (!domain)
      throw new LeadCaptureError(`"${String(entry).slice(0, 80)}" is not a domain.`, 400);
    domains.add(domain);
  }
  if (domains.size === 0 || domains.size > MAX_OWNED_DOMAINS)
    throw new LeadCaptureError(`List between 1 and ${MAX_OWNED_DOMAINS} domains you own.`, 400);
  return [...domains].sort();
}

/**
 * Exact host or a true subdomain of an owned domain. `trevra.com.evil.io` and
 * `eviltrevra.com` both fail: the match is on a label boundary, never on a
 * substring. Userinfo is refused because `https://trevra.com@evil.io/` reads
 * as Trevra to a person and as evil.io to the parser.
 */
export function citedUrlWithinOwnedDomains(url: string, ownedDomains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  return ownedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Origin and path only: query strings and fragments carry tracking ids, not citations. */
export function sanitizeCitedUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export async function getCitationLinkForWatch(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<CitationSourceLink | null> {
  const row = await db
    .prepare('SELECT * FROM brand_watch_citation_sources WHERE workspace_id=? AND watch_id=?')
    .get<LinkRow>(workspaceId, watchId);
  return row ? toLink(row) : null;
}

export async function getCitationLinkForSource(
  db: Db,
  source: CaptureSourceRecord
): Promise<CitationSourceLink | null> {
  const row = await db
    .prepare(
      'SELECT * FROM brand_watch_citation_sources WHERE workspace_id=? AND capture_source_id=?'
    )
    .get<LinkRow>(source.workspaceId, source.id);
  return row ? toLink(row) : null;
}

export async function citationSourceView(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<CitationSourceView | null> {
  const link = await getCitationLinkForWatch(db, workspaceId, watchId);
  if (!link) return null;
  const source = await getWorkspaceCaptureSource(db, workspaceId, link.captureSourceId);
  if (!source) return null;
  const latest = await db
    .prepare(
      `SELECT TO_CHAR(MAX(answered_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest
       FROM ai_citation_samples WHERE workspace_id=? AND watch_id=?`
    )
    .get<{ latest: string | null }>(workspaceId, watchId);
  return {
    watchId,
    sourceId: source.id,
    status: source.status,
    ownedDomains: link.ownedDomains,
    lastSeenAt: source.lastSeenAt,
    acceptedCount: source.acceptedCount,
    rejectedCount: source.rejectedCount,
    latestAnsweredAt: latest?.latest ?? null
  };
}

/**
 * Bind a watch to its own signed citation source, or update its owned domains.
 * The secret is returned only when the link row is created by this call, so a
 * second connect (or a concurrent one that lost the race) never re-reveals it;
 * rotation goes through the existing capture-source rotate route.
 *
 * Two steps, not one transaction: createCaptureSource opens its own
 * transaction and `Db` does not nest them. A crash between the two leaves an
 * unlinked source that a retry reuses (same preparation key) and that
 * `pruneCitationSamples` closes after ORPHAN_GRACE_MS.
 */
export async function connectCitationSource(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    watch: BrandWatch;
    ownedDomains: readonly string[];
  },
  now: Date = new Date()
): Promise<{
  link: CitationSourceLink;
  source: CaptureSourceRecord;
  secret: string | null;
  created: boolean;
}> {
  if (input.watch.workspaceId !== input.workspaceId)
    throw new LeadCaptureError('Watch not found', 404);
  const ownedDomains = normalizeOwnedDomains(input.ownedDomains);
  const at = now.toISOString();

  const updateExisting = async (): Promise<CitationSourceLink | null> => {
    const row = await db
      .prepare(
        `UPDATE brand_watch_citation_sources SET owned_domains=?, updated_at=?
         WHERE workspace_id=? AND watch_id=? RETURNING *`
      )
      .get<LinkRow>(ownedDomains, at, input.workspaceId, input.watch.id);
    return row ? toLink(row) : null;
  };
  const withSource = async (link: CitationSourceLink) => {
    const source = await getWorkspaceCaptureSource(db, input.workspaceId, link.captureSourceId);
    if (!source) throw new Error('Citation source link points at a missing capture source');
    return { link, source, secret: null, created: false };
  };

  const existing = await updateExisting();
  if (existing) return withSource(existing);

  const created = await createCaptureSource(
    db,
    {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      name: `AI answers · ${input.watch.name}`.slice(0, 120),
      kind: CITATION_SOURCE_KIND,
      preparationKey: `citations:${input.watch.id}`,
      preparationHash: sha256(input.watch.id)
    },
    now
  );
  const inserted = await db
    .prepare(
      `INSERT INTO brand_watch_citation_sources
         (watch_id, workspace_id, capture_source_id, owned_domains, created_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (watch_id) DO NOTHING
       RETURNING *`
    )
    .get<LinkRow>(input.watch.id, input.workspaceId, created.source.id, ownedDomains, at, at);
  if (!inserted) {
    const raced = await updateExisting();
    if (!raced) throw new Error('Citation source link vanished during connect');
    return withSource(raced);
  }
  return { link: toLink(inserted), source: created.source, secret: created.secret, created: true };
}

function decideChange(previouslyCited: boolean | null, cited: boolean): CitationChange {
  if (previouslyCited === null) return cited ? 'gained' : 'absent';
  if (previouslyCited) return cited ? 'kept' : 'lost';
  return cited ? 'gained' : 'absent';
}

function promptLabel(promptRef: string): string {
  return promptRef.startsWith('id:')
    ? `“${promptRef.slice(3)}”`
    : `#${promptRef.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

/**
 * Record one sample and, for a gained/lost transition, one immutable mention.
 *
 * The comparison is against the LATEST earlier non-stale sample for the same
 * engine and prompt. A sample answered at or before that latest one is
 * `stale`: it is stored for replay and audit but changes nothing.
 *
 * lc-debt: a late sample never rewrites history. If samplers deliver out of
 * order, the transition it would have marked is lost rather than re-derived;
 * the upgrade path is recomputing `change` for the (engine, prompt) series
 * after any out-of-order insert, which also means retracting mentions.
 */
export async function recordCitationSample(
  db: Db,
  input: {
    link: CitationSourceLink;
    idempotencyKey: string;
    payloadHash: string;
    sample: CitationSample;
  },
  now: Date = new Date()
): Promise<{ change: CitationChange; mention: WatchMention | null; duplicate: boolean }> {
  const { link, sample } = input;
  if (new Date(sample.answeredAt).getTime() > now.getTime() + FUTURE_SKEW_MS)
    throw new LeadCaptureError('answeredAt is in the future', 400);
  if (sample.citedUrls.some((url) => !citedUrlWithinOwnedDomains(url, link.ownedDomains)))
    throw new LeadCaptureError(
      'citedUrls may only contain http(s) URLs on the domains connected to this watch',
      400
    );
  const citedUrls = [...new Set(sample.citedUrls.map(sanitizeCitedUrl))];
  const at = now.toISOString();

  const outcome = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
      .get(`${link.workspaceId}:citations:${link.watchId}`);
    const replay = await tx
      .prepare(
        `SELECT payload_hash, change, mention_id FROM ai_citation_samples
         WHERE workspace_id=?
           AND ((capture_source_id=? AND idempotency_key=?) OR (watch_id=? AND sample_id=?))
         LIMIT 1`
      )
      .get<{ payload_hash: string; change: CitationChange; mention_id: string | null }>(
        link.workspaceId,
        link.captureSourceId,
        input.idempotencyKey,
        link.watchId,
        sample.sampleId
      );
    if (replay) {
      if (replay.payload_hash !== input.payloadHash)
        throw new LeadCaptureError(
          'This idempotency key or sampleId was already used for a different sample.',
          409
        );
      return { change: replay.change, mentionId: replay.mention_id, duplicate: true };
    }

    const latest = await tx
      .prepare(
        `SELECT brand_cited, (answered_at >= ?::timestamptz) AS not_older
         FROM ai_citation_samples
         WHERE workspace_id=? AND watch_id=? AND engine=? AND prompt_ref=? AND change <> 'stale'
         ORDER BY answered_at DESC
         LIMIT 1`
      )
      .get<{ brand_cited: boolean; not_older: boolean }>(
        sample.answeredAt,
        link.workspaceId,
        link.watchId,
        sample.engine,
        sample.promptRef
      );
    const change: CitationChange = latest?.not_older
      ? 'stale'
      : decideChange(latest ? latest.brand_cited : null, sample.brandCited);

    let mentionId: string | null = null;
    if (change === 'gained' || change === 'lost') {
      const engineLabel = AI_ANSWER_ENGINE_LABELS[sample.engine];
      const prompt = promptLabel(sample.promptRef);
      const externalId = `${sample.engine}:${sample.promptRef}:${sample.sampleId}`;
      const metadata = {
        source: AI_ANSWER_PLATFORM,
        change,
        engine: sample.engine,
        engineLabel,
        promptRef: sample.promptRef,
        brandCited: sample.brandCited,
        position: sample.position,
        citedUrls,
        answeredAt: sample.answeredAt,
        sampleId: sample.sampleId
      };
      const row = await tx
        .prepare(
          `INSERT INTO brand_watch_mentions (
             id, workspace_id, watch_id, platform, external_id, url, title, content,
             sentiment_label, sentiment_score, sentiment_span, sentiment_version, content_hash,
             metadata_json, mention_created_at, first_seen_at, last_seen_at
           ) VALUES (?,?,?,?,?,?,?,'','neutral',0,'',?,?,?::jsonb,?,?,?)
           ON CONFLICT (watch_id, platform, external_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at
           RETURNING id`
        )
        .get<{ id: string }>(
          id('bwm'),
          link.workspaceId,
          link.watchId,
          AI_ANSWER_PLATFORM,
          externalId,
          citedUrls[0] ?? `https://${link.ownedDomains[0]}/`,
          change === 'gained'
            ? `Cited by ${engineLabel} for prompt ${prompt}`
            : `No longer cited by ${engineLabel} for prompt ${prompt}`,
          SENTIMENT_VERSION,
          sha256(`${AI_ANSWER_PLATFORM}:${externalId}`),
          JSON.stringify(metadata),
          sample.answeredAt,
          at,
          at
        );
      mentionId = row?.id ?? null;
    }

    await tx
      .prepare(
        `INSERT INTO ai_citation_samples (
           id, workspace_id, watch_id, capture_source_id, idempotency_key, payload_hash,
           sample_id, engine, prompt_ref, answered_at, brand_cited, change, mention_id, received_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('acs'),
        link.workspaceId,
        link.watchId,
        link.captureSourceId,
        input.idempotencyKey,
        input.payloadHash,
        sample.sampleId,
        sample.engine,
        sample.promptRef,
        sample.answeredAt,
        sample.brandCited,
        change,
        mentionId,
        at
      );
    return { change, mentionId, duplicate: false };
  });

  const mention = outcome.mentionId
    ? await getWatchMention(db, link.workspaceId, outcome.mentionId)
    : null;
  return { change: outcome.change, mention, duplicate: outcome.duplicate };
}

/**
 * Retention and the orphan closer, run from the worker cycle. Samples are kept
 * 13 months by receipt time. A citation source whose watch was deleted (the
 * link row cascades away, the capture source does not) is deleted once it is
 * older than ORPHAN_GRACE_MS, which also removes its sealed secrets through
 * the capture_source_secrets cascade.
 */
export async function pruneCitationSamples(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, now.getUTCDate())
  ).toISOString();
  const orphanCutoff = new Date(now.getTime() - ORPHAN_GRACE_MS).toISOString();
  try {
    await db
      .prepare('DELETE FROM ai_citation_samples WHERE received_at < ?::timestamptz')
      .run(cutoff);
    await db
      .prepare(
        `DELETE FROM capture_sources s
         WHERE s.kind = ? AND s.created_at < ?::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM brand_watch_citation_sources l
             WHERE l.workspace_id = s.workspace_id AND l.capture_source_id = s.id
           )`
      )
      .run(CITATION_SOURCE_KIND, orphanCutoff);
  } catch (error) {
    console.error('AI-answer citation prune failed', error);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/watch/citations.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/watch/citations.ts src/server/watch/citations.test.ts
git commit -m "feat(watch): record AI-answer citation samples

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 9: Signed citation intake, watch routes and the worker closer

**Files:**

- Create: `src/server/watch/citation-intake.ts`
- Modify: `src/server/app.ts:65-79` (imports), `:882` (intake registration), after `:4008` (two routes), `:4029-4032` (reply guard)
- Modify: `src/worker/index.ts` (import and `cycle()` list, after the Task 6 edit)
- Modify: `docs/lead-capture.md` (append section 9)
- Test: `src/server/watch/citation-intake.test.ts`

**Interfaces:**

- Consumes:
  - From Task 2: `createCaptureSourceLimiter` and `isEntityTooLarge` (`lead-capture/http.ts`), plus all of `lead-capture/signature.ts`.
  - `getCaptureSourceById`, `readCaptureSourceSigningSecrets`, `recordCaptureSourceAccepted`, `recordCaptureSourceRejected` (`lead-capture/sources.ts`).
  - `payloadHash` (`lead-capture/submissions.ts`).
  - From Task 8: `citationSampleSchema`, `getCitationLinkForSource`, `recordCitationSample`, `citationSourceView`, `connectCitationSource`, `AI_ANSWER_PLATFORM`, `pruneCitationSamples`.
- Produces:
  - `registerCitationIntake(app, db)` and `CITATION_INTAKE_PATH = '/api/intake/v1/citations'`.
  - `GET /api/watches/:id/citation-source` returns `{citationSource: CitationSourceView | null}`.
  - `PUT /api/watches/:id/citation-source` (owner only) takes `{ownedDomains: string[]}` and returns `201|200 {citationSource, secret: string | null}`.
  - The reply route answers `409` for an `ai_answer` mention.

- [ ] **Step 1: Write the failing endpoint test**

Create `src/server/watch/citation-intake.test.ts`. The session and signing helpers are copied from `src/server/lead-capture/api.test.ts:15-62`, with the path made a parameter:

```ts
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { createCaptureSource } from '../lead-capture/sources.js';
import { CITATION_SOURCE_KIND } from '../lead-capture/types.js';
import { createWatch, type BrandWatch } from './store.js';

let db: Db;
let app: Express;
let session = '';
let watch: BrandWatch;
const WORKSPACE_ID = 'ws_citation_api';
const USER_ID = 'usr_citation_api';
const CITATIONS = '/api/intake/v1/citations';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Citation API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'citation-api@trevra.test', 'Citation API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function authed() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie)
  };
}

function signedRequest(path: string, sourceId: string, secret: string, key: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`), Buffer.from(body)]))
    .digest('hex');
  return request(app)
    .post(path)
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', sourceId)
    .set('X-Trevra-Timestamp', timestamp)
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${signature}`)
    .send(body);
}

const ANSWERED_AT = new Date(Date.now() - 3_600_000).toISOString();

function sampleBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sampleId: 'beseam-api-0001',
    engine: 'perplexity',
    promptRef: 'id:founder-ledger',
    answeredAt: ANSWERED_AT,
    brandCited: true,
    citedUrls: ['https://trevra.com/docs'],
    position: 1,
    ...overrides
  });
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
  await db.prepare('DELETE FROM brand_watches WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM capture_sources WHERE workspace_id=?').run(WORKSPACE_ID);
  watch = await createWatch(
    db,
    WORKSPACE_ID,
    { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
    new Date()
  );
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('AI-answer citation intake', () => {
  let sourceId = '';
  let secret = '';

  it('connects a watch once and accepts a signed sample as a gained citation', async () => {
    const connected = await authed()
      .put(`/api/watches/${watch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com'] })
      .expect(201);
    expect(connected.body.secret).toMatch(/^trv_capture_/);
    sourceId = connected.body.citationSource.sourceId;
    secret = connected.body.secret;
    const again = await authed()
      .put(`/api/watches/${watch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com', 'docs.trevra.com'] })
      .expect(200);
    expect(again.body.secret).toBeNull();
    expect(again.body.citationSource.ownedDomains).toEqual(['docs.trevra.com', 'trevra.com']);

    const accepted = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-0001',
      sampleBody()
    ).expect(202);
    expect(accepted.body).toMatchObject({
      sampleId: 'beseam-api-0001',
      change: 'gained',
      duplicate: false
    });
    const retried = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-0001',
      sampleBody()
    ).expect(200);
    expect(retried.body).toMatchObject({ mentionId: accepted.body.mentionId, duplicate: true });

    const mentions = await authed()
      .get(`/api/watches/${watch.id}/mentions?platform=ai_answer`)
      .expect(200);
    expect(mentions.body.mentions).toHaveLength(1);
    expect(mentions.body.mentions[0]).toMatchObject({
      content: '',
      url: 'https://trevra.com/docs'
    });
    const view = await authed().get(`/api/watches/${watch.id}/citation-source`).expect(200);
    expect(view.body.citationSource).toMatchObject({ sourceId, acceptedCount: 2 });
    expect(view.body.citationSource.latestAnsweredAt).toBe(ANSWERED_AT);

    const reply = await authed()
      .post(`/api/watches/${watch.id}/mentions/${accepted.body.mentionId}/reply`)
      .send({ product: {} })
      .expect(409);
    expect(reply.body.error).toBe('AI-answer citations are tracked, not replied to.');
  });

  it('rejects unknown fields such as answer text', async () => {
    const response = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-text',
      sampleBody({ sampleId: 'beseam-api-text', answerText: 'Trevra is the best ledger.' })
    ).expect(400);
    expect(response.body.error).toMatch(/answerText/);
    const stored = await db
      .prepare('SELECT COUNT(*) AS count FROM ai_citation_samples WHERE sample_id=?')
      .get<{ count: string }>('beseam-api-text');
    expect(Number(stored?.count)).toBe(0);
  });

  it('rejects a foreign cited URL with 400', async () => {
    await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-foreign',
      sampleBody({ sampleId: 'beseam-api-foreign', citedUrls: ['https://trevra.com.evil.io/'] })
    ).expect(400);
  });

  it('a lead source secret cannot post citation samples', async () => {
    const lead = await createCaptureSource(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      name: 'Website form',
      kind: 'website'
    });
    const response = await signedRequest(
      CITATIONS,
      lead.source.id,
      lead.secret,
      'citation-api-lead',
      sampleBody({ sampleId: 'beseam-api-lead' })
    ).expect(403);
    expect(response.body.error).toBe(
      'This capture source does not accept AI-answer citation samples'
    );
  });

  it('refuses an unlinked citation source, a bad signature and an unknown source', async () => {
    const unlinked = await createCaptureSource(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      name: 'Unlinked AI answers',
      kind: CITATION_SOURCE_KIND
    });
    await signedRequest(
      CITATIONS,
      unlinked.source.id,
      unlinked.secret,
      'citation-api-unlinked',
      sampleBody({ sampleId: 'beseam-api-unlinked' })
    ).expect(409);
    await signedRequest(
      CITATIONS,
      sourceId,
      'trv_capture_wrong',
      'citation-api-badsig',
      sampleBody()
    ).expect(401);
    await signedRequest(
      CITATIONS,
      'cap_missing',
      secret,
      'citation-api-missing',
      sampleBody()
    ).expect(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/watch/citation-intake.test.ts`
Expected: FAIL. The PUT returns `404 API route not found`.

- [ ] **Step 3: Implement the intake route**

Create `src/server/watch/citation-intake.ts`:

```ts
import express, { type Express, type Request, type Response } from 'express';
import type { Db } from '../db.js';
import { createCaptureSourceLimiter, isEntityTooLarge } from '../lead-capture/http.js';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  MAX_CAPTURE_BODY_BYTES,
  rawCaptureBody,
  readCaptureHeaders
} from '../lead-capture/signature.js';
import {
  getCaptureSourceById,
  readCaptureSourceSigningSecrets,
  recordCaptureSourceAccepted,
  recordCaptureSourceRejected
} from '../lead-capture/sources.js';
import { payloadHash } from '../lead-capture/submissions.js';
import { CITATION_SOURCE_KIND, LeadCaptureError } from '../lead-capture/types.js';
import {
  citationSampleSchema,
  getCitationLinkForSource,
  recordCitationSample
} from './citations.js';

export const CITATION_INTAKE_PATH = '/api/intake/v1/citations';

/**
 * The AI-answer twin of lead intake. Same headers, same signing recipe, same
 * check order up to the signature; then the source must be a citation source
 * linked to a brand watch. The workspace and the watch both come from the
 * authenticated source, never from the body.
 */
async function handleCitation(db: Db, req: Request, res: Response): Promise<void> {
  const headers = readCaptureHeaders(req.headers);
  const source = headers.sourceId ? await getCaptureSourceById(db, headers.sourceId) : null;
  if (!source) {
    res.status(404).json({ error: 'Capture source not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordCaptureSourceRejected(db, source.id);
    res.status(status).json({ error: message });
  };
  if (source.status !== 'active') return void (await reject(401, 'Capture source is disabled'));
  const problem = captureHeaderProblem(headers, Math.floor(Date.now() / 1000));
  if (problem) return void (await reject(problem.status, problem.error));

  const rawBody = rawCaptureBody(req.body);
  const secrets = await readCaptureSourceSigningSecrets(db, source);
  if (secrets.length === 0) return void (await reject(401, 'Capture source has no usable secret'));
  if (!captureSignatureMatches(secrets, headers, rawBody))
    return void (await reject(401, 'Invalid capture signature'));
  if (source.kind !== CITATION_SOURCE_KIND)
    return void (await reject(
      403,
      'This capture source does not accept AI-answer citation samples'
    ));
  const link = await getCitationLinkForSource(db, source);
  if (!link)
    return void (await reject(409, 'This citation source is not connected to a brand watch'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return void (await reject(400, 'Invalid JSON body'));
  }
  const validated = citationSampleSchema.safeParse(parsed);
  if (!validated.success)
    return void (await reject(
      400,
      validated.error.issues
        .map((issue) =>
          issue.code === 'unrecognized_keys'
            ? `Unknown fields: ${issue.keys.join(', ')}`
            : `${issue.path.join('.') || 'body'}: ${issue.message}`
        )
        .join('; ')
    ));

  try {
    const result = await recordCitationSample(db, {
      link,
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(rawBody),
      sample: validated.data
    });
    await recordCaptureSourceAccepted(db, source.id);
    res.status(result.duplicate ? 200 : 202).json({
      sampleId: validated.data.sampleId,
      change: result.change,
      mentionId: result.mention?.id ?? null,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof LeadCaptureError) return void (await reject(error.status, error.message));
    throw error;
  }
}

export function registerCitationIntake(app: Express, db: Db): void {
  app.post(
    CITATION_INTAKE_PATH,
    createCaptureSourceLimiter(),
    express.raw({ type: 'application/json', limit: MAX_CAPTURE_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleCitation(db, req, res);
      } catch (error) {
        if (isEntityTooLarge(error)) {
          res.status(413).json({ error: 'Capture payload is too large' });
          return;
        }
        next(error);
      }
    }
  );
}
```

- [ ] **Step 4: Register the intake and the watch routes in `app.ts`**

In `src/server/app.ts`, after line 79 (`import { unsupportedWatchPlatformReason } from './watch/skill.js';`) add:

```ts
import { registerCitationIntake } from './watch/citation-intake.js';
import {
  AI_ANSWER_PLATFORM,
  citationSourceView,
  connectCitationSource
} from './watch/citations.js';
```

Replace line 882, `  registerLeadCaptureIntake(app, db);`, with:

```ts
registerLeadCaptureIntake(app, db);
// Same raw-body rule: the citation sampler signs exact bytes.
registerCitationIntake(app, db);
```

After the `app.get('/api/watches/:id/trend', ...)` route (it ends at line 4008), insert:

```ts
app.get('/api/watches/:id/citation-source', async (req: AuthedRequest, res, next) => {
  try {
    const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!watch) return res.status(404).json({ error: 'Watch not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ citationSource: await citationSourceView(db, req.auth!.workspaceId, watch.id) });
  } catch (error) {
    next(error);
  }
});

// Owner-only: connecting creates a signing secret, like any capture source.
app.put(
  '/api/watches/:id/citation-source',
  ownerOnly('connect AI-answer citation samples'),
  async (req: AuthedRequest, res, next) => {
    try {
      const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
      if (!watch) return res.status(404).json({ error: 'Watch not found' });
      const input = z
        .object({ ownedDomains: z.array(z.string().trim().min(1).max(253)).min(1).max(20) })
        .strict()
        .parse(req.body ?? {});
      const connected = await connectCitationSource(db, {
        workspaceId: req.auth!.workspaceId,
        actorUserId: req.auth!.userId,
        watch,
        ownedDomains: input.ownedDomains
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(connected.created ? 201 : 200).json({
        citationSource: await citationSourceView(db, req.auth!.workspaceId, watch.id),
        secret: connected.secret
      });
    } catch (error) {
      next(error);
    }
  }
);
```

In the reply route, after the block that ends at line 4032:

```ts
if (!mention || mention.watchId !== watch.id) {
  res.status(404).json({ error: 'Mention not found' });
  return;
}
```

insert:

```ts
// A citation sample has no thread to answer and no text to draft from.
if (mention.platform === AI_ANSWER_PLATFORM) {
  res.status(409).json({ error: 'AI-answer citations are tracked, not replied to.' });
  return;
}
```

- [ ] **Step 5: Run the closer from the worker**

In `src/worker/index.ts`, after the Task 6 line `import { runQueuedEnrichmentRuns } from '../server/enrichment/runs.js';` add:

```ts
import { pruneCitationSamples } from '../server/watch/citations.js';
```

The prune is a short bounded delete, so it belongs in `cycle()`. In `cycle()`, replace:

```ts
      runDueResearchSources(db),
      runDueBrandWatches(db)
    ]);
```

with:

```ts
      runDueResearchSources(db),
      runDueBrandWatches(db),
      pruneCitationSamples(db)
    ]);
```

- [ ] **Step 6: Document the citation contract**

Append to `docs/lead-capture.md`:

````md
## 9. AI-answer citation samples

A brand watch can receive content-free samples of whether AI engines cite your own site. In **Research**, open a watch, expand **AI-answer citations**, list the domains you own and copy the one-time secret. Connecting creates a capture source of kind `ai_citations` that is bound to that watch. It does not appear under **Setup → Lead capture**, and lead intake refuses its secret with `403`.

```text
POST /api/intake/v1/citations
```

The headers and the signature recipe are identical to sections 2 and 4. The body is strict JSON. Unknown fields, including any answer or prompt text, are rejected with `400`:

```json
{
  "sampleId": "beseam-2026-10-06-chatgpt-0007",
  "engine": "chatgpt",
  "promptRef": "id:best-gtm-ledger",
  "answeredAt": "2026-10-06T08:00:00.000Z",
  "brandCited": true,
  "citedUrls": ["https://trevra.com/pricing"],
  "position": 2
}
```

- `engine` is one of `chatgpt`, `google_ai_mode`, `gemini`, `perplexity`, `copilot`, `claude` or `google_search`.
- `promptRef` is `id:<your label>` or `sha256:<hex of the prompt text>`. Trevra never receives the prompt itself.
- `citedUrls` may only name the domains you connected, or their subdomains. Query strings and fragments are dropped before storage.
- A sample with `brandCited: false` carries no `citedUrls` and no `position`.

Trevra compares each sample with the latest earlier sample for the same engine and prompt. A first or regained citation appears in the watch as **Citation gained**, and a drop appears as **Citation lost**. A repeat or a continued absence changes no mention. A sample older than one already recorded is stored as `stale` and changes nothing.

| Status | Meaning                                                                   |
| ------ | ------------------------------------------------------------------------- |
| `200`  | identical retry already recorded                                          |
| `202`  | new sample recorded                                                       |
| `400`  | invalid sample, unknown field or a URL outside your domains               |
| `401`  | invalid/stale signature or disabled source                                |
| `403`  | the source is a lead-capture source, not a citation source                |
| `404`  | capture source not found                                                  |
| `409`  | key or `sampleId` reused with different bytes, or the source has no watch |
| `413`  | request body too large                                                    |
| `429`  | source rate limit reached                                                 |

Samples are kept for 13 months. Deleting the watch deletes its samples, and its citation source is removed within the hour.
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/watch/citation-intake.test.ts src/server/watch/citations.test.ts src/server/lead-capture/api.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

Run: `npm run check`
Expected: exit 0. `npm run check` does not run Prettier, so first run `npx prettier --write src/server/watch/citation-intake.ts src/server/watch/citation-intake.test.ts docs/lead-capture.md` to rewrap the long lines in the test and the docs table.

```bash
git add src/server/watch/citation-intake.ts src/server/watch/citation-intake.test.ts src/server/app.ts src/worker/index.ts docs/lead-capture.md
git commit -m "feat(watch): accept signed AI-answer citation samples

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 10: Citations where brand mentions already appear

**Files:**

- Modify: `src/client/views/researchFormat.ts:3-12` (platform label) and append two functions
- Test: `src/client/views/researchFormat.test.ts:3` (import) and append two `describe` blocks
- Modify: `src/client/api.ts` (one type import after the Task 7 lines, two functions after `getWatchTrend` at 991-996)
- Create: `src/client/views/CitationSourceSetup.tsx`
- Modify: `src/client/views/ResearchView.tsx:71-78` (import), `:2211-2212` (render the setup), `:2216` (chip), `:2232-2238` (action)
- Modify: `src/client/styles.css` (after the `.research-mention-panel { min-width: 0; }` rule at 1496-1498)

**Interfaces:**

- Consumes: `CitationSourceView` (Task 8, type only); `GET` and `PUT /api/watches/:id/citation-source` (Task 9); `rotateCaptureSourceSecret` (`api.ts:3532`); `useIsWorkspaceOwner` (`auth-client.ts:36`); `errorMessage` (`LinkedInSafety.tsx:101`).
- Produces:
  - `researchFormat.ts` exports `citationChip(mention)` and `citationSourceStatus(source, now)`.
  - `api.ts` exports `CitationSourceSummary`, `getCitationSource(watchId)` and `connectCitationSource(watchId, ownedDomains)`.
  - The `CitationSourceSetup` component.

- [ ] **Step 1: Write the failing formatter tests**

In `src/client/views/researchFormat.test.ts`, replace line 3:

```ts
import { ageLabel, chipPoints, factsLine, sentimentChip, whyChips } from './researchFormat';
```

with:

```ts
import {
  ageLabel,
  chipPoints,
  citationChip,
  citationSourceStatus,
  factsLine,
  platformLabel,
  sentimentChip,
  whyChips
} from './researchFormat';
```

Append at the end of the file:

```ts
describe('citationChip', () => {
  it('labels gained and lost AI-answer citations and leaves other platforms to sentiment', () => {
    expect(
      citationChip({
        platform: 'ai_answer',
        metadata: { change: 'gained', engineLabel: 'ChatGPT', position: 2 }
      })
    ).toEqual({ tone: 'is-positive', text: 'Citation gained · ChatGPT · position 2' });
    expect(
      citationChip({
        platform: 'ai_answer',
        metadata: { change: 'lost', engineLabel: 'Perplexity', position: null }
      })
    ).toEqual({ tone: 'is-negative', text: 'Citation lost · Perplexity' });
    expect(citationChip({ platform: 'ai_answer', metadata: {} })).toEqual({
      tone: 'is-neutral',
      text: 'AI answer · an AI engine'
    });
    expect(citationChip({ platform: 'hackernews', metadata: { change: 'gained' } })).toBeNull();
    expect(platformLabel('ai_answer')).toBe('AI answer');
  });
});

describe('citationSourceStatus', () => {
  it('says plainly when no sample has arrived, when one did, and when the source is off', () => {
    const base = { status: 'active', latestAnsweredAt: null, acceptedCount: 0 };
    expect(citationSourceStatus(base, NOW)).toBe('Connected. No sample received yet.');
    expect(
      citationSourceStatus(
        { ...base, latestAnsweredAt: '2026-08-19T09:00:00.000Z', acceptedCount: 4 },
        NOW
      )
    ).toBe('Latest sample answered 3h ago · 4 accepted.');
    expect(citationSourceStatus({ ...base, status: 'disabled' }, NOW)).toBe(
      'Disabled. New samples are refused.'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/researchFormat.test.ts`
Expected: FAIL with `citationChip is not a function`.

- [ ] **Step 3: Add the formatters**

In `src/client/views/researchFormat.ts`, replace line 11, `  stackoverflow: 'Stack Overflow'`, with:

```ts
  stackoverflow: 'Stack Overflow',
  ai_answer: 'AI answer'
```

Append at the end of the file:

```ts
/**
 * The chip for an AI-answer citation mention, or null for every other
 * platform so the caller falls back to `sentimentChip`. A citation has no
 * sentiment; what matters is whether the engine started or stopped citing
 * the founder's site.
 */
export function citationChip(mention: {
  platform: string;
  metadata: Record<string, unknown>;
}): { tone: string; text: string } | null {
  if (mention.platform !== 'ai_answer') return null;
  const engine =
    typeof mention.metadata.engineLabel === 'string'
      ? mention.metadata.engineLabel
      : 'an AI engine';
  if (mention.metadata.change === 'gained') {
    const position =
      typeof mention.metadata.position === 'number'
        ? ` · position ${mention.metadata.position}`
        : '';
    return { tone: 'is-positive', text: `Citation gained · ${engine}${position}` };
  }
  if (mention.metadata.change === 'lost') {
    return { tone: 'is-negative', text: `Citation lost · ${engine}` };
  }
  return { tone: 'is-neutral', text: `AI answer · ${engine}` };
}

/** One line under the citation setup: is anything arriving? */
export function citationSourceStatus(
  source: { status: string; latestAnsweredAt: string | null; acceptedCount: number },
  now: Date
): string {
  if (source.status !== 'active') return 'Disabled. New samples are refused.';
  if (!source.latestAnsweredAt) return 'Connected. No sample received yet.';
  return `Latest sample answered ${elapsed(source.latestAnsweredAt, now)} ago · ${source.acceptedCount} accepted.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/researchFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the client API**

In `src/client/api.ts`, after the Task 7 line `export type { EnrichmentSettings, EnrichmentUsage } from '../server/enrichment/settings';` add:

```ts
import type { CitationSourceView } from '../server/watch/citations';
export type CitationSourceSummary = CitationSourceView;
```

After the closing `}` of `getWatchTrend` (line 996), add:

```ts
export async function getCitationSource(watchId: string): Promise<CitationSourceSummary | null> {
  const result = await request<{ citationSource: CitationSourceSummary | null }>(
    `/api/watches/${encodeURIComponent(watchId)}/citation-source`
  );
  return result.citationSource;
}

export async function connectCitationSource(
  watchId: string,
  ownedDomains: string[]
): Promise<{ citationSource: CitationSourceSummary | null; secret: string | null }> {
  return request(`/api/watches/${encodeURIComponent(watchId)}/citation-source`, {
    method: 'PUT',
    body: JSON.stringify({ ownedDomains })
  });
}
```

- [ ] **Step 6: Create `src/client/views/CitationSourceSetup.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import {
  connectCitationSource,
  getCitationSource,
  rotateCaptureSourceSecret,
  type CitationSourceSummary
} from '../api';
import { useIsWorkspaceOwner } from '../auth-client';
import { errorMessage } from '../LinkedInSafety';
import { Button, Field, Input, Textarea } from '../ui/primitives';
import { citationSourceStatus } from './researchFormat';

/**
 * Progressive disclosure for one watch's AI-answer citation source. Closed by
 * default: most founders never open it, and the mention list stays the focus.
 */
export function CitationSourceSetup({
  watchId,
  setToast
}: {
  watchId: string;
  setToast: (message: string) => void;
}) {
  const isOwner = useIsWorkspaceOwner();
  const [source, setSource] = useState<CitationSourceSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [domains, setDomains] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'' | 'connect' | 'rotate'>('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setSource(null);
    setSecret('');
    setProblem('');
    void getCitationSource(watchId)
      .then((next) => {
        if (cancelled) return;
        setSource(next);
        setDomains(next?.ownedDomains.join('\n') ?? '');
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProblem(errorMessage(error, 'AI-answer citations could not be loaded.'));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [watchId]);

  const ownedDomains = domains
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter(Boolean);

  const connect = async () => {
    setBusy('connect');
    setProblem('');
    try {
      const result = await connectCitationSource(watchId, ownedDomains);
      setSource(result.citationSource);
      if (result.secret) {
        setSecret(result.secret);
        setCopied(false);
      }
      setToast(
        result.secret
          ? 'Citation source connected. Copy the signing secret now.'
          : 'Owned domains saved.'
      );
    } catch (error) {
      setProblem(errorMessage(error, 'The citation source could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  const rotate = async () => {
    if (!source) return;
    setBusy('rotate');
    setProblem('');
    try {
      const rotated = await rotateCaptureSourceSecret(source.sourceId);
      setSecret(rotated.secret);
      setCopied(false);
      setToast('Signing secret rotated. The previous secret remains valid briefly.');
    } catch (error) {
      setProblem(errorMessage(error, 'The signing secret could not be rotated.'));
    } finally {
      setBusy('');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setProblem('Copy failed. Select the secret and copy it by hand.');
    }
  };

  return (
    <details className="research-citation-setup">
      <summary>AI-answer citations</summary>
      <p className="research-citation-status">
        {source
          ? citationSourceStatus(source, new Date())
          : 'Not connected. Beseam, or any sampler that can sign requests, posts content-free samples of whether AI answers cite your site.'}
      </p>
      {problem && <div className="error-banner">{problem}</div>}
      {isOwner ? (
        <div className="research-citation-form">
          <Field
            label="Domains you own"
            hint="One per line. Only citations of these domains and their subdomains are accepted."
          >
            <Textarea
              rows={3}
              value={domains}
              placeholder="example.com"
              onChange={(event) => setDomains(event.target.value)}
            />
          </Field>
          <div className="research-citation-actions">
            <Button
              variant="primary"
              disabled={
                !loaded || busy !== '' || ownedDomains.length === 0 || ownedDomains.length > 20
              }
              onClick={() => void connect()}
            >
              {busy === 'connect' ? 'Saving…' : source ? 'Save domains' : 'Connect'}
            </Button>
            {source && (
              <Button disabled={busy !== ''} onClick={() => void rotate()}>
                <RefreshCw size={15} />
                {busy === 'rotate' ? 'Rotating…' : 'Rotate secret'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="research-citation-status">
          Only the workspace owner can connect a citation source.
        </p>
      )}
      {source && (
        <dl className="research-citation-facts">
          <dt>Source ID</dt>
          <dd>
            <code>{source.sourceId}</code>
          </dd>
          <dt>Endpoint</dt>
          <dd>
            <code>POST /api/intake/v1/citations</code>
          </dd>
        </dl>
      )}
      {secret && (
        <div className="research-citation-secret">
          <Field
            label="Signing secret"
            hint="Shown once. Keep it in the sampler's server-side secrets."
          >
            <Input readOnly value={secret} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <Button aria-label="Copy signing secret" onClick={() => void copy()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
      )}
    </details>
  );
}
```

- [ ] **Step 7: Render citations in the mention panel**

In `src/client/views/ResearchView.tsx`:

Replace the `./researchFormat` import (lines 71-78) with:

```ts
import {
  chipPoints,
  citationChip,
  factsLine,
  platformLabel,
  sentimentChip,
  trendHeadline,
  whyChips
} from './researchFormat';
import { CitationSourceSetup } from './CitationSourceSetup';
```

In the mention panel, between the closing `</div>` of `section-heading` (line 2211) and `<div className="client-table">` (line 2212), insert:

```tsx
<CitationSourceSetup watchId={selectedWatch} setToast={setToast} />
```

`selectedWatch` is narrowed to `string` here by the enclosing `selectedWatch !== null &&`.

Replace line 2216, `                  const chip = sentimentChip(mention);`, with:

```tsx
const chip = citationChip(mention) ?? sentimentChip(mention);
```

Replace lines 2232-2238:

```tsx
{
  mention.promotedRunId ? (
    <span className="client-status">Promoted to a reply run</span>
  ) : (
    <button type="button" onClick={() => setDraftingMention(mention)}>
      Draft reply
    </button>
  );
}
```

with:

```tsx
{
  mention.platform === 'ai_answer' ? (
    <span className="client-status">Tracked, not replied to</span>
  ) : mention.promotedRunId ? (
    <span className="client-status">Promoted to a reply run</span>
  ) : (
    <button type="button" onClick={() => setDraftingMention(mention)}>
      Draft reply
    </button>
  );
}
```

- [ ] **Step 8: Add layout CSS**

In `src/client/styles.css`, after:

```css
.research-mention-panel {
  min-width: 0;
}
```

add:

```css
.research-citation-setup {
  display: grid;
  gap: 10px;
  margin: 0 0 12px;
  padding: 0 10px 10px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-r-md);
  background: var(--t-surface-2);
}
.research-citation-setup:not([open]) {
  padding-bottom: 0;
}
.research-citation-setup summary {
  display: flex;
  align-items: center;
  min-height: var(--t-tap);
  cursor: pointer;
  font-size: var(--t-text-xs);
}
.research-citation-status {
  margin: 0;
  color: var(--t-muted);
  font-size: var(--t-text-xs);
}
.research-citation-form {
  display: grid;
  gap: 10px;
}
.research-citation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.research-citation-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  font-size: var(--t-text-xs);
}
.research-citation-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.research-citation-secret {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
```

These rules own layout only. The textarea, input and buttons keep the shared primitive skin.

- [ ] **Step 9: Run the tests**

Run: `npx tsx scripts/test-with-postgres.ts src/client/views/researchFormat.test.ts src/client/ui/route.test.ts`
Expected: PASS.

- [ ] **Step 10: Check the screen by hand**

Run: `npm run dev`. Open `/research`, select a watch, expand **AI-answer citations** and connect `example.com`. Post one signed sample with the body from `docs/lead-capture.md` section 9 (with `citedUrls` on `example.com`), signed as in section 4. Check light and dark themes at desktop width and at 375 px.

Expected:

- The summary row and the buttons are at least `--t-tap` high with visible focus.
- The secret appears once, and the copy button has an accessible name.
- The sample shows as "Citation gained · …" with a "Tracked, not replied to" status and no Draft reply button.
- A member sees the read-only line.

- [ ] **Step 11: Gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/client/views/researchFormat.ts src/client/views/researchFormat.test.ts src/client/api.ts src/client/views/CitationSourceSetup.tsx src/client/views/ResearchView.tsx src/client/styles.css
git commit -m "feat(research): show AI-answer citations on brand watches

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

### Task 11: Cloudflare Worker capture template for sites without a backend

**Files:**

- Create: `examples/capture-worker/src/sign.ts`, `examples/capture-worker/src/turnstile.ts`, `examples/capture-worker/src/index.ts`
- Create: `examples/capture-worker/wrangler.toml`, `examples/capture-worker/README.md`
- Test: `examples/capture-worker/test/worker.test.ts`
- Modify: `tsconfig.json` (`include`)
- Modify: `docs/lead-capture.md` (append section 10)

**Interfaces:**

- Consumes (test only): `readCaptureHeaders`, `captureHeaderProblem`, `captureSignatureMatches` (Task 2, `src/server/lead-capture/signature.ts`); `inboundSubmissionSchema` (`src/server/lead-capture/types.ts:87`).
- Produces:
  - `sign.ts` exports `SignedCaptureHeaders`, `signCaptureRequest({secret, sourceId, idempotencyKey, body, nowSeconds})` and `idempotencyKeyForToken(token)`.
  - `turnstile.ts` exports `SITEVERIFY_URL`, `TurnstileResult` and `verifyTurnstile({secret, token, remoteIp, expectedHostnames, fetchImpl})`.
  - `index.ts` exports `Env`, `CaptureDeps`, `buildSubmission(form, env, pageUrl)`, `handleCapture(request, env, deps?)` and a default `{ fetch }` handler.

The Worker uses only Web APIs (`crypto.subtle`, `fetch`, `FormData`, `Request`, `Response`), so it runs unchanged on Cloudflare and under Node 24 in Vitest. It does not import server code; the test proves its bytes verify with the server's own verifier.

- [ ] **Step 1: Write the failing Worker test**

Create `examples/capture-worker/test/worker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  readCaptureHeaders
} from '../../../src/server/lead-capture/signature';
import { inboundSubmissionSchema } from '../../../src/server/lead-capture/types';
import { handleCapture, type Env } from '../src/index';
import { idempotencyKeyForToken, signCaptureRequest } from '../src/sign';
import { SITEVERIFY_URL, type FetchLike } from '../src/turnstile';

// Cloudflare's documented Turnstile test secrets: always pass, always fail.
const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const NOW = 1_791_280_000;
const ENDPOINT = 'https://trevra.example.test/api/intake/v1/submissions';

const env: Env = {
  TREVRA_API_BASE_URL: 'https://trevra.example.test/',
  TREVRA_CAPTURE_SOURCE_ID: 'cap_worker_test',
  TREVRA_CAPTURE_SECRET: 'trv_capture_worker_test_secret',
  TURNSTILE_SECRET_KEY: PASS_SECRET,
  ALLOWED_ORIGIN: 'https://acme.test',
  TURNSTILE_HOSTNAMES: 'acme.test'
};

function stubFetch(trevraStatuses: number[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const statuses = [...trevraStatuses];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === SITEVERIFY_URL) {
      const form = init.body as FormData;
      const ok = form.get('secret') === PASS_SECRET && form.get('response') === TOKEN;
      return new Response(
        JSON.stringify(
          ok
            ? { success: true, hostname: 'acme.test', 'error-codes': [] }
            : { success: false, 'error-codes': ['invalid-input-secret'] }
        ),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: statuses.shift() ?? 500 });
  };
  return { calls, fetchImpl };
}

function formRequest(fields: Record<string, string>, origin = 'https://acme.test') {
  return new Request('https://capture.acme.test/', {
    method: 'POST',
    headers: {
      origin,
      referer: 'https://acme.test/demo?utm_source=ignored#form',
      'cf-connecting-ip': '203.0.113.7',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields)
  });
}

const deps = (fetchImpl: FetchLike) => ({ fetch: fetchImpl, nowSeconds: () => NOW });

describe('capture worker', () => {
  it('signs exactly what the server verifies', async () => {
    const body = JSON.stringify({ kind: 'demo_request', person: { email: 'ada@acme.test' } });
    const headers = await signCaptureRequest({
      secret: env.TREVRA_CAPTURE_SECRET,
      sourceId: env.TREVRA_CAPTURE_SOURCE_ID,
      idempotencyKey: await idempotencyKeyForToken(TOKEN),
      body,
      nowSeconds: NOW
    });
    const parsed = readCaptureHeaders(headers);
    expect(parsed.sourceId).toBe('cap_worker_test');
    expect(captureHeaderProblem(parsed, NOW)).toBeNull();
    expect(captureSignatureMatches([env.TREVRA_CAPTURE_SECRET], parsed, Buffer.from(body))).toBe(
      true
    );
    expect(captureSignatureMatches(['trv_capture_other'], parsed, Buffer.from(body))).toBe(false);
  });

  it('verifies Turnstile, then posts a signed canonical submission', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({
        email: 'ada@acme.test',
        name: 'Ada Lovelace',
        company_domain: 'acme.test',
        message: 'Demo please',
        utm_source: 'newsletter',
        'cf-turnstile-response': TOKEN
      }),
      env,
      deps(fetchImpl)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([SITEVERIFY_URL, ENDPOINT]);
    expect((calls[0].init.body as FormData).get('remoteip')).toBe('203.0.113.7');

    const raw = String(calls[1].init.body);
    const headers = readCaptureHeaders(calls[1].init.headers as Record<string, string>);
    expect(captureSignatureMatches([env.TREVRA_CAPTURE_SECRET], headers, Buffer.from(raw))).toBe(
      true
    );
    expect(headers.idempotencyKey).toBe(await idempotencyKeyForToken(TOKEN));
    expect(inboundSubmissionSchema.parse(JSON.parse(raw))).toMatchObject({
      kind: 'demo_request',
      person: { email: 'ada@acme.test', name: 'Ada Lovelace' },
      company: { domain: 'acme.test' },
      page: { url: 'https://acme.test/demo' },
      message: 'Demo please',
      attribution: { utm_source: 'newsletter' }
    });
  });

  it('refuses a failed Turnstile check without calling Trevra', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      { ...env, TURNSTILE_SECRET_KEY: FAIL_SECRET },
      deps(fetchImpl)
    );
    expect(response.status).toBe(403);
    expect(calls.map((call) => call.url)).toEqual([SITEVERIFY_URL]);
  });

  it('retries once with the same key and bytes, then reports 502', async () => {
    const failing = stubFetch([503, 503]);
    const failed = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      env,
      deps(failing.fetchImpl)
    );
    expect(failed.status).toBe(502);
    const posts = failing.calls.filter((call) => call.url === ENDPOINT);
    expect(posts).toHaveLength(2);
    expect(posts[0].init.body).toBe(posts[1].init.body);
    const keys = posts.map(
      (call) => readCaptureHeaders(call.init.headers as Record<string, string>).idempotencyKey
    );
    expect(keys[0]).toBe(keys[1]);

    const recovering = stubFetch([503, 202]);
    const recovered = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      env,
      deps(recovering.fetchImpl)
    );
    expect(recovered.status).toBe(200);
  });

  it('maps a rejected payload to 400 and a misconfigured source to 502 without retrying', async () => {
    const invalid = stubFetch([400]);
    const rejected = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      env,
      deps(invalid.fetchImpl)
    );
    expect(rejected.status).toBe(400);
    const misconfigured = stubFetch([401]);
    const unsigned = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      env,
      deps(misconfigured.fetchImpl)
    );
    expect(unsigned.status).toBe(502);
    expect(misconfigured.calls.filter((call) => call.url === ENDPOINT)).toHaveLength(1);
  });

  it('drops honeypot posts silently and refuses foreign origins, bad emails and other methods', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const trapped = await handleCapture(
      formRequest({
        email: 'bot@spam.test',
        website: 'https://spam.test',
        'cf-turnstile-response': TOKEN
      }),
      env,
      deps(fetchImpl)
    );
    expect(trapped.status).toBe(200);
    expect(calls).toHaveLength(0);
    const foreign = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }, 'https://evil.test'),
      env,
      deps(fetchImpl)
    );
    expect(foreign.status).toBe(403);
    const badEmail = await handleCapture(
      formRequest({ email: 'not-an-email', 'cf-turnstile-response': TOKEN }),
      env,
      deps(fetchImpl)
    );
    expect(badEmail.status).toBe(400);
    const get = await handleCapture(
      new Request('https://capture.acme.test/'),
      env,
      deps(fetchImpl)
    );
    expect(get.status).toBe(405);
    const preflight = await handleCapture(
      new Request('https://capture.acme.test/', { method: 'OPTIONS' }),
      env,
      deps(fetchImpl)
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://acme.test');
  });

  it('redirects to a thank-you page when one is configured', async () => {
    const { fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({ email: 'ada@acme.test', 'cf-turnstile-response': TOKEN }),
      { ...env, REDIRECT_URL: 'https://acme.test/thanks' },
      deps(fetchImpl)
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://acme.test/thanks');
  });
});
```

The bad-email case calls siteverify before refusing, because the email is read after the bot check; `calls` is shared, so the test asserts `toHaveLength(0)` only right after the honeypot post.

- [ ] **Step 2: Include the example in typecheck and run the test to verify it fails**

In `tsconfig.json`, replace:

```json
  "include": ["src", "scripts", "vite.config.ts"]
```

with:

```json
  "include": ["src", "scripts", "vite.config.ts", "examples/capture-worker"]
```

`tsconfig.server.json` keeps its own `include`, so the server build never compiles the example.

Run: `npx tsx scripts/test-with-postgres.ts examples/capture-worker/test/worker.test.ts`
Expected: FAIL with `Cannot find module '../src/index'`.

- [ ] **Step 3: Write the signer**

Create `examples/capture-worker/src/sign.ts`:

```ts
/**
 * Trevra capture signing with Web Crypto only, so it runs in a Cloudflare
 * Worker. The signed input is `<timestamp>.<idempotency-key>.<exact body>`,
 * HMAC-SHA256, hex, sent as `sha256=<hex>` (docs/lead-capture.md section 4).
 */
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A type alias, not an interface: an alias gets an implicit index signature,
// so these headers are assignable to Node's IncomingHttpHeaders in the test.
export type SignedCaptureHeaders = {
  'content-type': 'application/json';
  'x-trevra-source': string;
  'x-trevra-timestamp': string;
  'x-trevra-idempotency-key': string;
  'x-trevra-signature': string;
};

export async function signCaptureRequest(input: {
  secret: string;
  sourceId: string;
  idempotencyKey: string;
  body: string;
  nowSeconds: number;
}): Promise<SignedCaptureHeaders> {
  const timestamp = String(Math.floor(input.nowSeconds));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${input.idempotencyKey}.${input.body}`)
  );
  return {
    'content-type': 'application/json',
    'x-trevra-source': input.sourceId,
    'x-trevra-timestamp': timestamp,
    'x-trevra-idempotency-key': input.idempotencyKey,
    'x-trevra-signature': `sha256=${hex(signature)}`
  };
}

/**
 * One logical submission per Turnstile token. A token is single-use, so a
 * browser double-submit fails the bot check rather than creating a second
 * person, and the Worker's own retry reuses this key with the same bytes.
 */
export async function idempotencyKeyForToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return `turnstile:${hex(digest).slice(0, 48)}`;
}
```

- [ ] **Step 4: Write the Turnstile check**

Create `examples/capture-worker/src/turnstile.ts`:

```ts
/** https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

/** The one fetch shape the Worker uses; tests pass a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  hostname: string | null;
}

export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  remoteIp: string | null;
  expectedHostnames: readonly string[];
  fetchImpl: FetchLike;
}): Promise<TurnstileResult> {
  if (!input.token || input.token.length > MAX_TOKEN_LENGTH)
    return { success: false, errorCodes: ['missing-input-response'], hostname: null };
  const form = new FormData();
  form.append('secret', input.secret);
  form.append('response', input.token);
  if (input.remoteIp) form.append('remoteip', input.remoteIp);

  let outcome: { success?: unknown; hostname?: unknown; 'error-codes'?: unknown };
  try {
    const response = await input.fetchImpl(SITEVERIFY_URL, { method: 'POST', body: form });
    outcome = (await response.json()) as typeof outcome;
  } catch {
    return { success: false, errorCodes: ['siteverify-unreachable'], hostname: null };
  }
  const hostname = typeof outcome.hostname === 'string' ? outcome.hostname : null;
  const errorCodes = Array.isArray(outcome['error-codes'])
    ? outcome['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];
  if (outcome.success !== true) return { success: false, errorCodes, hostname };
  // A token minted on another site that uses the same site key must not pass.
  if (
    input.expectedHostnames.length > 0 &&
    (!hostname || !input.expectedHostnames.includes(hostname))
  )
    return { success: false, errorCodes: ['hostname-mismatch'], hostname };
  return { success: true, errorCodes: [], hostname };
}
```

- [ ] **Step 5: Write the Worker**

Create `examples/capture-worker/src/index.ts`:

```ts
import { idempotencyKeyForToken, signCaptureRequest } from './sign';
import { verifyTurnstile, type FetchLike } from './turnstile';

export interface Env {
  /** Your Trevra API base URL, as shown in Setup → Lead capture recipes. */
  TREVRA_API_BASE_URL: string;
  TREVRA_CAPTURE_SOURCE_ID: string;
  /** Worker secret: `npx wrangler secret put TREVRA_CAPTURE_SECRET`. */
  TREVRA_CAPTURE_SECRET: string;
  /** Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`. */
  TURNSTILE_SECRET_KEY: string;
  /** The one site origin allowed to post, e.g. `https://www.example.com`. */
  ALLOWED_ORIGIN: string;
  /** Comma-separated hostnames a Turnstile token must have been issued on. */
  TURNSTILE_HOSTNAMES?: string;
  SUBMISSION_KIND?: string;
  REDIRECT_URL?: string;
}

export interface CaptureDeps {
  fetch: FetchLike;
  nowSeconds: () => number;
}

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTEMPTS = 2;

function field(form: FormData, name: string, max: number): string | undefined {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Origin and path only: a query string can carry tokens the founder never meant to store. */
function pageUrlFrom(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return null;
  }
}

/** The canonical Trevra body (docs/lead-capture.md section 3), or null without a usable email. */
export function buildSubmission(
  form: FormData,
  env: Env,
  pageUrl: string | null
): Record<string, unknown> | null {
  const email = field(form, 'email', 320);
  if (!email || !EMAIL.test(email)) return null;
  const name = field(form, 'name', 200);
  const domain = field(form, 'company_domain', 500);
  const message = field(form, 'message', 20_000);
  const attribution: Record<string, string> = {};
  for (const key of UTM_FIELDS) {
    const value = field(form, key, 200);
    if (value) attribution[key] = value;
  }
  return {
    kind: env.SUBMISSION_KIND || 'demo_request',
    person: name ? { email, name } : { email },
    ...(domain ? { company: { domain } } : {}),
    ...(pageUrl ? { page: { url: pageUrl } } : {}),
    ...(message ? { message } : {}),
    ...(Object.keys(attribution).length > 0 ? { attribution } : {})
  };
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };
}

function reply(env: Env, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env) }
  });
}

function accepted(env: Env): Response {
  if (env.REDIRECT_URL)
    return new Response(null, {
      status: 303,
      headers: { location: env.REDIRECT_URL, ...corsHeaders(env) }
    });
  return reply(env, 200, { ok: true });
}

export async function handleCapture(
  request: Request,
  env: Env,
  deps: CaptureDeps = {
    fetch: (input, init) => fetch(input, init),
    nowSeconds: () => Date.now() / 1000
  }
): Promise<Response> {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method !== 'POST') return reply(env, 405, { ok: false, error: 'Use POST.' });
  if (request.headers.get('origin') !== env.ALLOWED_ORIGIN)
    return reply(env, 403, { ok: false, error: 'This form does not accept posts from that site.' });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(env, 415, { ok: false, error: 'Send the form as form data.' });
  }
  // Honeypot: a person never fills a field they cannot see. Answer as if it
  // worked so the bot learns nothing.
  if (field(form, 'website', 200)) return accepted(env);

  const tokenValue = form.get('cf-turnstile-response');
  const token = typeof tokenValue === 'string' ? tokenValue : '';
  const turnstile = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET_KEY,
    token,
    remoteIp: request.headers.get('cf-connecting-ip'),
    expectedHostnames: (env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    fetchImpl: deps.fetch
  });
  if (!turnstile.success)
    return reply(env, 403, {
      ok: false,
      error: 'The bot check failed. Reload the page and try again.'
    });

  const submission = buildSubmission(form, env, pageUrlFrom(request.headers.get('referer')));
  if (!submission)
    return reply(env, 400, { ok: false, error: 'A valid email address is required.' });

  // Built once: every attempt sends these exact bytes under this exact key.
  const body = JSON.stringify(submission);
  const idempotencyKey = await idempotencyKeyForToken(token);
  const endpoint = `${env.TREVRA_API_BASE_URL.replace(/\/+$/, '')}/api/intake/v1/submissions`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const headers = await signCaptureRequest({
      secret: env.TREVRA_CAPTURE_SECRET,
      sourceId: env.TREVRA_CAPTURE_SOURCE_ID,
      idempotencyKey,
      body,
      nowSeconds: deps.nowSeconds()
    });
    let status = 0;
    try {
      status = (await deps.fetch(endpoint, { method: 'POST', headers: { ...headers }, body }))
        .status;
    } catch {
      status = 0;
    }
    if (status === 200 || status === 202) return accepted(env);
    if (status === 400 || status === 413)
      return reply(env, 400, { ok: false, error: 'The submission was not accepted.' });
    // Only a network failure, 429 or 5xx is worth one more try. 401/403/404/409
    // mean the Worker's source id or secret is wrong: retrying cannot fix that,
    // and the visitor cannot either.
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable) break;
  }
  return reply(env, 502, {
    ok: false,
    error: 'The form could not be delivered. Try again shortly.'
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleCapture(request, env);
  }
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts examples/capture-worker/test/worker.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Add the Wrangler config**

Create `examples/capture-worker/wrangler.toml`:

```toml
# Trevra lead capture for a site with no backend.
# Replace every value under [vars] with your own, then add the two secrets:
#   npx wrangler secret put TREVRA_CAPTURE_SECRET
#   npx wrangler secret put TURNSTILE_SECRET_KEY
name = "trevra-capture"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[vars]
# Setup -> Lead capture shows this base URL in every recipe.
TREVRA_API_BASE_URL = "https://trevra.example.com"
# The source ID is not secret; the signing secret is.
TREVRA_CAPTURE_SOURCE_ID = "cap_replace_me"
# The one origin your form is served from, scheme included.
ALLOWED_ORIGIN = "https://www.example.com"
# Hostnames a Turnstile token must be issued on, comma-separated.
TURNSTILE_HOSTNAMES = "www.example.com"
SUBMISSION_KIND = "demo_request"
# Uncomment to send visitors to a thank-you page instead of a JSON reply.
# REDIRECT_URL = "https://www.example.com/thanks"
```

- [ ] **Step 8: Write the README**

Create `examples/capture-worker/README.md`:

````md
# Trevra capture Worker

A Cloudflare Worker for a site with no backend: a static landing page posts its form here, the Worker checks Cloudflare Turnstile, signs the submission with your Trevra capture secret and delivers it to `POST /api/intake/v1/submissions`. The secret lives only in the Worker, never in page JavaScript.

## 1. Create the pieces

1. In Trevra, open **Setup → Lead capture**, add a source and copy its ID and one-time secret.
2. In the Cloudflare dashboard, add a Turnstile widget for your site's hostname and copy its site key and secret key.

## 2. Deploy

```bash
cd examples/capture-worker
# edit wrangler.toml: TREVRA_API_BASE_URL, TREVRA_CAPTURE_SOURCE_ID, ALLOWED_ORIGIN, TURNSTILE_HOSTNAMES
npx wrangler secret put TREVRA_CAPTURE_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler deploy
```

## 3. Point your form at it

```html
<form action="https://trevra-capture.<your-subdomain>.workers.dev/" method="POST">
  <label>Work email <input name="email" type="email" required /></label>
  <label>Name <input name="name" /></label>
  <label>Company website <input name="company_domain" placeholder="example.com" /></label>
  <label>What do you need? <textarea name="message"></textarea></label>
  <!-- Honeypot: hidden from people, filled by bots. Keep the name "website". -->
  <input
    name="website"
    tabindex="-1"
    autocomplete="off"
    aria-hidden="true"
    style="position:absolute;left:-10000px"
  />
  <input type="hidden" name="utm_source" />
  <input type="hidden" name="utm_medium" />
  <input type="hidden" name="utm_campaign" />
  <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
  <button type="submit">Request a demo</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
  // Carry the landing page's UTM parameters into the form.
  const params = new URLSearchParams(location.search);
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const input = document.querySelector(`input[name="${name}"]`);
    if (input && params.get(name)) input.value = params.get(name);
  }
</script>
```

The Turnstile widget adds the `cf-turnstile-response` field that the Worker verifies.

## What the Worker does

| Step                                                                                                                                                          | On failure                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Only `POST` from `ALLOWED_ORIGIN`                                                                                                                             | `405` or `403`                  |
| Honeypot `website` filled                                                                                                                                     | pretends success, sends nothing |
| Turnstile siteverify, with the visitor IP from `CF-Connecting-IP` and the hostname checked                                                                    | `403`                           |
| Builds the canonical body: `person.email` (required), `person.name`, `company.domain`, `page.url` (origin and path of the referring page), `message`, `utm_*` | `400` without a valid email     |
| Signs `<timestamp>.<key>.<body>` and posts; the key is derived from the single-use Turnstile token                                                            |                                 |
| Retries once on a network error, `429` or `5xx`, with the same key and bytes                                                                                  | `502`                           |
| Trevra answers `400`/`413`                                                                                                                                    | `400`                           |
| Trevra answers `401`/`403`/`404`/`409`: wrong source ID or secret                                                                                             | `502`, no retry                 |

On success it returns `{"ok":true}`, or a `303` to `REDIRECT_URL` when set.

## Testing

Cloudflare's test secret `1x0000000000000000000000000000000AA` always passes and `2x0000000000000000000000000000000AA` always fails. In this repository, `npx tsx scripts/test-with-postgres.ts examples/capture-worker/test/worker.test.ts` checks the Worker's signature with Trevra's own verifier.
````

- [ ] **Step 9: Document the Worker and the form-builder question**

Append to `docs/lead-capture.md`:

```md
## 10. Sites without a backend

A static page cannot hold the capture secret. Deploy the Cloudflare Worker in `examples/capture-worker/` and point the form's `action` at it. The Worker verifies Cloudflare Turnstile, signs the canonical body with the secret stored as a Worker secret, and posts to `/api/intake/v1/submissions`. Its README has the form markup, and its test proves the signature verifies with Trevra's own verifier.

Hosted form builders are not a substitute. Tally signs its webhooks with its own `Tally-Signature` header (base64 HMAC of Tally's payload with a Tally-issued secret), and Formbricks uses Standard Webhooks (`webhook-signature: v1,<base64>` with a `whsec_` secret). Neither can sign `<timestamp>.<idempotency-key>.<raw body>` with a Trevra capture secret, and neither sends Trevra's canonical body, so neither can call this endpoint directly. To use one, put the Worker or another small server in between to verify the builder's own signature, map its fields and re-sign.
```

- [ ] **Step 10: Run the Phase F tests and the gate**

Run: `npx tsx scripts/test-with-postgres.ts examples/capture-worker/test/worker.test.ts src/server/lead-capture src/server/watch src/server/enrichment src/client/views/researchFormat.test.ts src/client/views/planCost.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: exit 0. The `tsc --noEmit` step now also typechecks `examples/capture-worker`.

Run: `grep -rn "readWorkspaceSecretPlaintext(.*'hunter_api_key'" src --include=*.ts`
Expected: exactly one line, in `src/server/enrichment/runs.ts`.

Run: `grep -rln "enrichment/" src/server/skills src/server/playbooks`
Expected: no output. Enrichment is reachable only through the approved `enrich_contacts` plan path, never through the generic skill or playbook runner.

Run: `grep -rn "answer_text\|answerText" src/server/watch src/server/lead-capture migrations/135_enrichment_and_ai_citations.sql`
Expected: only the `citations.test.ts` and `citation-intake.test.ts` lines that prove such a field is rejected.

- [ ] **Step 11: Commit**

```bash
git add examples/capture-worker tsconfig.json docs/lead-capture.md
git commit -m "feat(capture): Cloudflare Worker template with Turnstile

Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Self-Review

### Spec coverage

| Requirement (roadmap Phase F row and Global Constraints)                | Where                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hunter bring-your-own-key enrichment behind a provider interface        | Task 3 (`ContactEnrichmentProvider`, Hunter adapter), Task 4 (workspace-owned key in secret custody, checked against the free `/account` endpoint)                                                                                                                                                                                |
| Credit cap shown in the plan preview                                    | Task 4 (monthly cap, month-to-date usage), Task 5 (`cost` block and cap blockers in `enrich_contacts`), Task 7 (preview lines and approve label)                                                                                                                                                                                  |
| Spend only after approval, never past the cap or the estimate           | Task 6 (queue under an advisory lock that re-checks the cap, ledger before use, per-call estimate check, lease fencing)                                                                                                                                                                                                           |
| Saved contacts are sourced and verified, or labelled inferred on opt-in | Task 6 (`resolveExplicitAccount` confidence, rules 3 and 4 of `skills/contact.ts`)                                                                                                                                                                                                                                                |
| The founder's own AI-answer citations as brand-watch mentions           | Task 8 (content-free samples, gained/lost mentions), Task 9 (signed intake and watch routes), Task 10 (Research surface)                                                                                                                                                                                                          |
| One capture secret cannot post to the other endpoint                    | Task 2 (kind gate on lead intake), Task 9 (kind gate on citation intake)                                                                                                                                                                                                                                                          |
| Cloudflare Worker capture template for sites without a backend          | Task 11                                                                                                                                                                                                                                                                                                                           |
| Migration `135_*`, PostgreSQL only, forward-only                        | Task 1                                                                                                                                                                                                                                                                                                                            |
| Writer and closer for new durable state                                 | `enrichment_runs` and `enrichment_usage_ledger`: `pruneEnrichmentHistory` (13 months, Task 6). `ai_citation_samples` and orphan `ai_citations` sources: `pruneCitationSamples` (13 months and 1 hour, Tasks 8 and 9). `enrichment_settings` and `brand_watch_citation_sources` cascade with the workspace and the watch (Task 1). |
| Known ceilings carry `lc-debt`                                          | `runs.ts`: one run per tick per replica; a retried domain is charged again in the ledger                                                                                                                                                                                                                                          |

### Deliberate deviations from the roadmap

1. **Key custody.** The Hunter key lives in Trevra secret custody (`workspace_secrets` kind `hunter_api_key`), not Nango, because Nango's catalogue has no `hunter` provider. The roadmap allows either.
2. **Citation dedupe.** Citation retries dedupe through `ai_citation_samples` unique keys `(capture_source_id, idempotency_key)` and `(watch_id, sample_id)`, not `webhook_events`. The intake is Trevra's own signed capture scheme, which already dedupes in its own table, not a provider webhook.
3. **No Today surfacing.** The Phase F contract adds no Today kinds. Citations appear in Research, where brand mentions already appear. Enrichment results land as People under their Accounts in `/outreach`.
4. **The estimate is an upper bound.** It assumes every searched email is found and verified. The ledger records actual charges, and the run stops before any call that could cross the approved estimate.

### Placeholder scan

No `TBD`, `TODO` or elided code remains. The only values left for a person to fill are deliberate deployment settings in the Worker template: `TREVRA_API_BASE_URL`, `TREVRA_CAPTURE_SOURCE_ID` (`cap_replace_me`), `ALLOWED_ORIGIN`, `TURNSTILE_HOSTNAMES` and the commented `REDIRECT_URL` in `wrangler.toml`, and `<your-subdomain>` in the README form markup. Secrets are set with `wrangler secret put`, never written in files. `example.com` values in UI placeholders and the manual check are intentional.

### Type consistency

- `EmailVerificationStatus` gains `'claimed'` (Hunter 451) in Task 3. `runs.ts` saves only `valid` as `verified` and `accept_all`/`unknown` as `inferred` on opt-in, so `claimed` is always skipped.
- `RunRow.attempts` is read from `claimRun`'s `RETURNING *` and used as the fence in the heartbeat, the checkpoint, `finishRun` and `releaseRun`.
- `PreparedEnrichmentGtmPlanResult` joins `PreparedGtmPlanResult` in Task 6, and Task 6 Step 7 updates the planner's final branch that the wider union breaks.
- `CITATION_SOURCE_KIND` (Task 2) is the kind `connectCitationSource` creates (Task 8) and the kind both intake gates check (Tasks 2 and 9).
- `AI_ANSWER_PLATFORM` (Task 8) is the platform the reply route refuses (Task 9) and the client labels (Task 10).

### Review Focus pins

All eight test names cited in Review Focus appear exactly once in this plan as `it('<name>'`.

### Verification performed while writing

Every created file and every edit was applied to a scratch copy of commit `a2bcb0b` outside the repository and run there. The repository itself was not changed.

- Full `npm test` on the scratch copy: 3030 tests passed. `tsc --noEmit`, `vite build` and `tsc -p tsconfig.server.json` passed.
- After the final fixes (lease fencing, Hunter 222/451, the member replay gate, the separate enrichment loop and the ledger prune index), the Task 11 Step 10 test command was re-run: 19 files, 172 tests passed. `tsc --noEmit` and `tsc -p tsconfig.server.json --noEmit` passed again.
- Mutation check: with the lease fence turned into a no-op, "a copy whose lease another replica took over stops before its next paid call" fails, and it passes with the fence.
- Missing-module and missing-export failures were checked against Vitest's real messages (`Cannot find module '...'`, `X is not a function`), matching each "Run the test to verify it fails" step.
