# GTM Phase A: Milestones, Stripe and Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Product milestones (signup, activation, payment, upgrade, cancellation) arrive through the existing signed intake or an observe-only Stripe webhook. Each one becomes one private account signal, one forward-only Opportunity stage move and one Today item. Inbound people and Opportunities also show where a person came from (UTM source and a self-reported "heard about us" channel).

**Architecture:** One pure vocabulary module, `lead-capture/milestones.ts`, defines the milestone kinds. It maps each kind to an account-signal kind, a minimum Opportunity stage and a deterministic idempotency key.

The recorder, `lead-capture/milestone-recorder.ts`, is the only writer of milestones. It writes:

- one `product_milestones` row;
- one account signal, followed by a rescore;
- one call to `advanceOpportunityStage` (`opportunity-advance.ts`).

The signed intake and the Stripe verifier both call this same function.

A generic provider-webhook module (`provider-webhooks/`) handles all webhook deliveries. It verifies the exact raw bytes per endpoint, takes the workspace from the endpoint id in the URL (never from the payload), and dedupes redeliveries through `webhook_events`. Stripe is its first registered verifier; Phase B adds Cal.com.

**Tech Stack:**

- TypeScript 5.9 (ESM, NodeNext, `.js` import specifiers), Express 5, Zod 3.
- PostgreSQL (forward-only migrations), `stripe` (official Node SDK, signature verification only).
- Vitest with a real PostgreSQL container, React client.

**Spec:**

- `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md`: the Phase A row, Global Constraints, Shared contracts 1, 2, 3 and 5, and Review Focus.
- `reports/LemonCrow and Beseam GTM needs.md`: the "Prioritized gap list" and "Design principles" sections.

## Global Constraints

**Stack and database**

- PostgreSQL only. Migrations are forward-only in `migrations/`, one transaction per file. Never add a SQLite path.
- This phase reserves migration `130_*`. Before Task 1, run `ls migrations | tail -3`. If 130 is taken, use the next free number and update every `130` reference in this plan.

**Workspace scoping and safety**

- Scope every commercial query by `workspace_id`. A webhook endpoint decides the workspace. Never take the workspace from payload data.
- Multi-step writes run in one `db.transaction`. Competing work uses `pg_advisory_xact_lock(hashtextextended(?,0))` or row locks.
- Owner-only management APIs. Workspace scoping on every query. Idempotency on every write.

**Secrets and stored data**

- Signing secrets live only in Trevra secret custody (`src/server/secrets/crypto.ts`, gated by `secretsConfigured()`). Never store them in plaintext, never log them, never return them.
- Store only Stripe event and object ids as provenance. Never store amounts, line items or invoice details (AGENTS.md analytics rule).
- Domain-event payloads carry no client content, email bodies, document text, invoice details or IP addresses.
- Webhook redeliveries dedupe through `webhook_events` (migration 058 index `idx_webhook_events_tenant_idempotency`).
- Post-sale stays excluded. Stripe data is an _observed_ outcome only: Trevra makes no Stripe API call and holds no Stripe API key.

**Signals and Opportunities**

- New account-signal kinds go in `ACCOUNT_SIGNAL_KINDS` _and_ get a weight in `SIGNAL_WEIGHTS`. Unknown kinds score zero.
- Account signals are written only through `recordSignals` (`src/server/accounts/sweep.ts`), which drops signals without an `evidenceUrl`. Follow each write with `rescoreAccount`.
- Opportunity stages never move backwards automatically and are never set to `lost` automatically.

**UI and routing**

- No new navigation section. The surfaces are Today, Opportunities, `/setup/capture` and `/outreach/inbound`. Both paths already exist in `src/client/ui/route.ts` and `APP_PATH_PATTERNS` in `src/server/index.ts`, so no route changes are needed.
- Client UI uses `src/client/ui/primitives.tsx` controls and `--t-*` tokens. No inline reusable styles. Feature CSS owns layout only.

**Process**

- Focused test command: `npx tsx scripts/test-with-postgres.ts <test files>`. Final gate: `npm run check`. Run `npm audit --omit=dev` after adding a dependency.
- Deliberate ceilings get an `lc-debt: <ceiling>; <upgrade path>` comment.
- New durable state ships with its writer and its closer (removal path or workspace cascade).
- Commit messages are short and end with the trailer `Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7`.
- Cite Stripe docs where code depends on Stripe behaviour:
  - https://docs.stripe.com/webhooks/signature
  - https://docs.stripe.com/webhooks
  - https://docs.stripe.com/api/events/object
  - https://docs.stripe.com/billing/subscriptions/change-price
  - https://github.com/stripe/stripe-node#webhook-signing

## Roadmap contract deviations (deliberate, additive)

1. **`provider_webhook_endpoints` columns.** The table has `secret_ciphertext` as the contract says. It also has `secret_iv`, `secret_auth_tag`, `secret_key_version` and `secret_key_id`, because Trevra's AES-GCM envelope (`SealedSecret`) cannot be opened without them. Custody rotation (`secrets/custody.ts`) learns this prefixed column set.
2. **`createProviderWebhookEndpoint` input.** It takes an optional `endpointId`. Stripe only issues the `whsec_` secret after the endpoint URL exists, so the UI first drafts an id (`POST /api/setup/webhooks/draft`), shows the URL, and then saves with that id. `ProviderWebhookVerifier` gains an optional `secretPattern` so a mistyped secret fails at setup rather than on the first delivery.
3. **`advanceOpportunityStage` transactions.** It opens its own transaction, so callers must not call it inside one. A replay of the same `(sourceType, sourceId)` returns the Opportunity's current stage with `created: false, changed: false`. A creation returns `changed: true`.
4. **Route registry names.** AGENTS.md names `SHELL_PATHS` and `APP_PATH_HEADS`, but neither exists. The real names are `isAppPath` and `APP_PATH_PATTERNS`, and no route changes are needed in this phase.

## File map

| File                                                                                                                                                                                                                                  | Responsibility                                                                                      | Task     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- |
| `migrations/130_gtm_milestones_stripe.sql`                                                                                                                                                                                            | `provider_webhook_endpoints`, `product_milestones`, `opportunity_stage_observations`                | 1        |
| `src/shared/milestones.ts`                                                                                                                                                                                                            | Closed milestone vocabulary and labels (client and server)                                          | 1        |
| `src/server/lead-capture/milestones.ts`                                                                                                                                                                                               | Contract 3 exports plus pure mapping rules (signal kind, stage floor, key, evidence path, SQL list) | 1        |
| `src/server/accounts/types.ts`                                                                                                                                                                                                        | Seven first-party signal kinds; `FIRST_PARTY_SIGNAL_KINDS`; `UNCITABLE_SIGNAL_KINDS_SQL`            | 1, 2     |
| `src/server/accounts/score.ts`, `src/client/AccountsScreen.tsx`                                                                                                                                                                       | Weights and labels                                                                                  | 1        |
| `src/server/content/{opportunity-builder,pulse,index}.ts`, `src/server/demand/candidates.ts`, `src/server/observations/providers/http.ts`                                                                                             | Private kinds are never cited or accepted from outside                                              | 2        |
| `src/server/opportunity-advance.ts`                                                                                                                                                                                                   | Contract 1: `STAGE_RANK`, `advanceOpportunityStage`                                                 | 3        |
| `src/server/lead-capture/milestone-recorder.ts`                                                                                                                                                                                       | The only milestone writer; list view                                                                | 4        |
| `src/server/lead-capture/http.ts`                                                                                                                                                                                                     | Intake records milestone kinds                                                                      | 4        |
| `src/server/today.ts`, `src/client/views/LoopView.tsx`                                                                                                                                                                                | `milestone_reached`, `customer_cancelled`; inbound excludes milestones                              | 5        |
| `src/server/demand/candidates.ts`                                                                                                                                                                                                     | Inbound demand excludes milestone kinds                                                             | 5        |
| `src/server/provider-webhooks/{types,registry,store,http,index}.ts`                                                                                                                                                                   | Contract 2 module                                                                                   | 6        |
| `src/server/secrets/{crypto,custody}.ts`                                                                                                                                                                                              | Webhook secrets join key-rotation custody                                                           | 6        |
| `src/server/lead-capture/freemail.ts`                                                                                                                                                                                                 | Bounded freemail list                                                                               | 7        |
| `src/server/provider-webhooks/stripe.ts`                                                                                                                                                                                              | Stripe verifier and observe-only handler                                                            | 7        |
| `src/server/app.ts`                                                                                                                                                                                                                   | Route wiring and management API                                                                     | 7, 8, 11 |
| `src/client/api.ts`, `src/client/provider-webhook-view.tsx`, `src/client/ProviderWebhookSetup.tsx`, `src/client/LeadCaptureSetup.tsx`, `src/client/lead-capture.css`                                                                  | Stripe connect UI on `/setup/capture`                                                               | 9        |
| `src/shared/attribution.ts`, `src/server/lead-capture/types.ts`, `src/server/lead-capture/attribution.ts`, `src/server/opportunities.ts`, `src/shared/types.ts`, `src/client/inbound-attribution.tsx`, `src/client/Opportunities.tsx` | Self-reported attribution                                                                           | 10       |
| `src/client/inbound-milestones.tsx`, `src/client/InboundPeople.tsx`                                                                                                                                                                   | Milestone list, attribution table, heard-about chip                                                 | 11       |

## Review Focus

1. **Duplicate or out-of-order events.** A Stripe event delivered twice, or a payment that arrives before an activation, must produce one milestone, one signal and one forward stage move, never a regression or a second Opportunity. Tests are in Task 4 (recorder: paid then activated, plus duplicates) and Task 7 (Stripe redelivery).
2. **Cross-workspace data.** A webhook naming an email that also exists in another workspace must attach only to the endpoint's workspace. A Person id from another workspace is rejected. Tests are in Task 7 (same email in two workspaces) and Task 6 (an endpoint id reused across workspaces gets 409). Task 3 and Task 4 also reject foreign ids.
3. **Bad signatures and paused endpoints.** A bad signature or a paused endpoint is rejected and counted, with no handler call and no `webhook_events` row. The test is in Task 6.
4. **No sensitive data at rest.** Amounts, customer emails and line items never reach `domain_events`, `product_milestones`, `webhook_events`, `account_signals` or `account_scores`. The test is in Task 7.
5. **Milestones are not leads.** Milestone kinds never become `inbound_submission` attention items or qualified-demand evidence (test in Task 5). Private signal kinds never reach content queries or the external observation provider (test in Task 2).

---

### Task 1: Migration 130, milestone vocabulary and first-party signal kinds

**Files:**

- Create: `migrations/130_gtm_milestones_stripe.sql`
- Create: `src/shared/milestones.ts`
- Create: `src/server/lead-capture/milestones.ts`
- Modify: `src/server/accounts/types.ts:24-54`
- Modify: `src/server/accounts/score.ts:153-231`
- Modify: `src/client/AccountsScreen.tsx:96-124`
- Test: `src/server/lead-capture/milestones.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - Tables `provider_webhook_endpoints`, `product_milestones` and `opportunity_stage_observations` (columns as in the SQL below).
  - From `src/shared/milestones.ts`: `GTM_MILESTONE_KINDS`, `type GtmMilestoneKind`, `isMilestoneKind(kind: unknown): kind is GtmMilestoneKind` and `MILESTONE_LABELS: Record<GtmMilestoneKind, string>`.
  - From `src/server/lead-capture/milestones.ts`: re-exports of the four names above, plus:
    - `type MilestoneSourceType = 'inbound_submission' | 'stripe_event'`;
    - `MILESTONE_KINDS_SQL: string`;
    - `MILESTONE_SIGNAL_KIND: Record<GtmMilestoneKind, AccountSignalKind>`;
    - `MILESTONE_MINIMUM_STAGE: Record<GtmMilestoneKind, Exclude<OpportunityStage,'lost'> | null>`;
    - `ONE_TIME_MILESTONE_KINDS`;
    - `milestoneKey(input): string`;
    - `milestoneEvidencePath(id): string`.
  - From `src/server/accounts/types.ts`: `FIRST_PARTY_SIGNAL_KINDS`, and seven new members of `AccountSignalKind`.

- [ ] **Step 1: Write the failing test**

Create `src/server/lead-capture/milestones.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import {
  ACCOUNT_SIGNAL_KINDS,
  FIRST_PARTY_SIGNAL_KINDS,
  type AccountSignal
} from '../accounts/types.js';
import { HOT_SCORE, SIGNAL_WEIGHTS, scoreAccount } from '../accounts/score.js';
import {
  GTM_MILESTONE_KINDS,
  MILESTONE_KINDS_SQL,
  MILESTONE_MINIMUM_STAGE,
  MILESTONE_SIGNAL_KIND,
  isMilestoneKind,
  milestoneEvidencePath,
  milestoneKey
} from './milestones.js';

const WS = 'ws_milestone_vocabulary';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WS, WS, NOW.toISOString());
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db?.close();
});

describe('milestone vocabulary (roadmap contract 3)', () => {
  it('is the closed seven-kind list', () => {
    expect([...GTM_MILESTONE_KINDS]).toEqual([
      'signed_up',
      'activated',
      'integration_connected',
      'usage_threshold_crossed',
      'paid',
      'upgraded',
      'cancelled'
    ]);
    expect(isMilestoneKind('paid')).toBe(true);
    expect(isMilestoneKind('demo_request')).toBe(false);
    expect(isMilestoneKind(undefined)).toBe(false);
    expect(MILESTONE_KINDS_SQL).toBe(
      "('signed_up','activated','integration_connected','usage_threshold_crossed','paid','upgraded','cancelled')"
    );
  });

  it('maps each kind to its account-signal kind and minimum stage', () => {
    expect(MILESTONE_SIGNAL_KIND).toEqual({
      signed_up: 'product-signed-up',
      activated: 'product-activated',
      integration_connected: 'product-integration-connected',
      usage_threshold_crossed: 'product-usage-threshold',
      paid: 'customer-paid',
      upgraded: 'customer-upgraded',
      cancelled: 'customer-cancelled'
    });
    expect(MILESTONE_MINIMUM_STAGE).toEqual({
      signed_up: null,
      activated: 'qualified',
      integration_connected: 'qualified',
      usage_threshold_crossed: 'qualified',
      paid: 'won',
      upgraded: null,
      cancelled: null
    });
    expect(Object.values(MILESTONE_SIGNAL_KIND).sort()).toEqual(
      [...FIRST_PARTY_SIGNAL_KINDS].sort()
    );
    for (const kind of FIRST_PARTY_SIGNAL_KINDS) expect(ACCOUNT_SIGNAL_KINDS).toContain(kind);
  });

  it('keys one-time kinds per person, cancellations per object, the rest per source', () => {
    expect(
      milestoneKey({
        kind: 'paid',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_1',
        externalObjectId: 'in_1'
      })
    ).toBe('paid:contact:con_1');
    expect(
      milestoneKey({
        kind: 'signed_up',
        contactId: 'con_1',
        sourceType: 'inbound_submission',
        sourceId: 'sub_1'
      })
    ).toBe('signed_up:contact:con_1');
    expect(
      milestoneKey({
        kind: 'cancelled',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_2',
        externalObjectId: 'sub_9'
      })
    ).toBe('cancelled:object:sub_9');
    expect(
      milestoneKey({
        kind: 'cancelled',
        contactId: 'con_1',
        sourceType: 'inbound_submission',
        sourceId: 'sub_2'
      })
    ).toBe('cancelled:inbound_submission:sub_2');
    expect(
      milestoneKey({
        kind: 'upgraded',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_3',
        externalObjectId: 'sub_9'
      })
    ).toBe('upgraded:stripe_event:evt_3');
    expect(milestoneEvidencePath('pm_abc')).toBe('/outreach/inbound?milestone=pm_abc');
  });
});

describe('first-party signal weights', () => {
  function signal(kind: string): AccountSignal {
    const observedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
    return {
      id: `sig_${kind}`,
      workspaceId: WS,
      accountId: 'acc_weights',
      kind,
      detail: kind,
      previous: null,
      current: `milestone:${kind}`,
      evidenceUrl: milestoneEvidencePath(kind),
      observedAt,
      fingerprint: `fp_${kind}`,
      createdAt: observedAt
    };
  }

  it('never lets one milestone make an account hot, and treats cancellation as negative', () => {
    for (const kind of FIRST_PARTY_SIGNAL_KINDS) {
      expect(SIGNAL_WEIGHTS[kind]).toBeLessThan(HOT_SCORE);
      expect(scoreAccount([signal(kind)], { now: NOW, rejectedShapes: [] }).tier).not.toBe('hot');
    }
    expect(SIGNAL_WEIGHTS['customer-cancelled']).toBeLessThan(0);
    expect(SIGNAL_WEIGHTS['product-activated']).toBeGreaterThan(
      SIGNAL_WEIGHTS['product-signed-up']
    );
    // A payment is already a won Opportunity; it must not push the account
    // toward new-outreach recommendations.
    expect(SIGNAL_WEIGHTS['customer-paid']).toBeLessThan(SIGNAL_WEIGHTS['product-signed-up']);
  });
});

describe('migration 130', () => {
  it('creates the three Phase A tables with their columns', async () => {
    const rows = await db
      .prepare(
        `SELECT table_name,column_name FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name IN ('provider_webhook_endpoints','product_milestones','opportunity_stage_observations')`
      )
      .all<{ table_name: string; column_name: string }>();
    const columns = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const column of [
      'provider_webhook_endpoints.provider',
      'provider_webhook_endpoints.status',
      'provider_webhook_endpoints.secret_ciphertext',
      'provider_webhook_endpoints.secret_iv',
      'provider_webhook_endpoints.secret_auth_tag',
      'provider_webhook_endpoints.secret_key_version',
      'provider_webhook_endpoints.secret_key_id',
      'provider_webhook_endpoints.accepted_count',
      'provider_webhook_endpoints.rejected_count',
      'provider_webhook_endpoints.last_seen_at',
      'product_milestones.kind',
      'product_milestones.contact_id',
      'product_milestones.account_id',
      'product_milestones.source_type',
      'product_milestones.source_id',
      'product_milestones.external_object_id',
      'product_milestones.milestone_key',
      'product_milestones.occurred_at',
      'opportunity_stage_observations.opportunity_id',
      'opportunity_stage_observations.previous_stage',
      'opportunity_stage_observations.stage'
    ])
      expect(columns.has(column), column).toBe(true);
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    const contactId = id('con');
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        contactId,
        WS,
        'Vocabulary',
        'vocab@example.test',
        'vocab@example.test',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await expect(
      db
        .prepare(
          `INSERT INTO product_milestones
           (id,workspace_id,kind,contact_id,source_type,source_id,milestone_key,occurred_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          id('pm'),
          WS,
          'demo_request',
          contactId,
          'inbound_submission',
          'sub_vocab',
          'demo_request:vocab',
          NOW.toISOString()
        )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/milestones.test.ts`
Expected: FAIL with `Cannot find module './milestones.js'` (and `FIRST_PARTY_SIGNAL_KINDS` undefined).

- [ ] **Step 3: Write the implementation**

Create `migrations/130_gtm_milestones_stripe.sql`:

```sql
-- GTM Phase A: product milestones, observe-only provider webhooks, and the
-- forward-only Opportunity stage ledger.
-- Plan: docs/superpowers/plans/2026-10-06-gtm-a-milestones-stripe-attribution.md
--
-- None of these tables stores provider content. A Stripe event is reduced to
-- its event id and object id before it reaches a row, and the signing secret is
-- sealed by Trevra secret custody (src/server/secrets/crypto.ts).

CREATE TABLE IF NOT EXISTS provider_webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe','calcom')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_auth_tag BYTEA NOT NULL,
  secret_key_version INTEGER NOT NULL,
  secret_key_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  accepted_count BIGINT NOT NULL DEFAULT 0,
  rejected_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_endpoints_workspace
  ON provider_webhook_endpoints(workspace_id, provider, status);

COMMENT ON TABLE provider_webhook_endpoints IS
'One observe-only inbound webhook per row. The URL id decides the workspace; the sealed signing secret verifies the exact raw bytes. Closed by owner removal or workspace cascade.';

CREATE TABLE IF NOT EXISTS product_milestones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'signed_up','activated','integration_connected','usage_threshold_crossed',
    'paid','upgraded','cancelled'
  )),
  contact_id TEXT NOT NULL,
  account_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('inbound_submission','stripe_event')),
  source_id TEXT NOT NULL,
  provider_endpoint_id TEXT REFERENCES provider_webhook_endpoints(id) ON DELETE SET NULL,
  external_object_id TEXT,
  milestone_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, milestone_key),
  UNIQUE (workspace_id, source_type, source_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX IF NOT EXISTS idx_product_milestones_recent
  ON product_milestones(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_milestones_contact
  ON product_milestones(workspace_id, contact_id);

COMMENT ON TABLE product_milestones IS
'First-party product/billing outcomes. Provenance is ids only (submission id or Stripe event/object id); never amounts, line items or invoice details.';

CREATE TABLE IF NOT EXISTS opportunity_stage_observations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  previous_stage TEXT,
  stage TEXT NOT NULL,
  created BOOLEAN NOT NULL,
  changed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_stage_observations_opportunity
  ON opportunity_stage_observations(opportunity_id);

COMMENT ON TABLE opportunity_stage_observations IS
'Idempotency ledger for advanceOpportunityStage: one row per observed source. Closed with its Opportunity or workspace.';
```

Create `src/shared/milestones.ts`:

```ts
/**
 * The closed product-milestone vocabulary (GTM roadmap contract 3).
 *
 * Shared so the inbound screen recognises a milestone submission without a
 * server round trip. `src/server/lead-capture/milestones.ts` re-exports these
 * names and owns the server-side rules.
 */
export const GTM_MILESTONE_KINDS = [
  'signed_up',
  'activated',
  'integration_connected',
  'usage_threshold_crossed',
  'paid',
  'upgraded',
  'cancelled'
] as const;

export type GtmMilestoneKind = (typeof GTM_MILESTONE_KINDS)[number];

const KINDS = new Set<string>(GTM_MILESTONE_KINDS);

export function isMilestoneKind(kind: unknown): kind is GtmMilestoneKind {
  return typeof kind === 'string' && KINDS.has(kind);
}

/** Past-tense verb phrase: "Acme activated", "A person at this account paid." */
export const MILESTONE_LABELS: Record<GtmMilestoneKind, string> = {
  signed_up: 'signed up',
  activated: 'activated',
  integration_connected: 'connected an integration',
  usage_threshold_crossed: 'crossed a usage threshold',
  paid: 'paid',
  upgraded: 'upgraded',
  cancelled: 'cancelled'
};
```

Create `src/server/lead-capture/milestones.ts`:

```ts
/**
 * Product and billing milestones: the deterministic rules that turn one into
 * an account signal, an Opportunity stage floor and an idempotency key.
 *
 * Pure: no I/O, and only type imports beyond the shared vocabulary, so Today,
 * demand, the recorder and the client agree on one list.
 */
import type { AccountSignalKind } from '../accounts/types.js';
import type { OpportunityStage } from '../opportunities.js';
import { GTM_MILESTONE_KINDS, type GtmMilestoneKind } from '../../shared/milestones.js';

export {
  GTM_MILESTONE_KINDS,
  MILESTONE_LABELS,
  isMilestoneKind,
  type GtmMilestoneKind
} from '../../shared/milestones.js';

export type MilestoneSourceType = 'inbound_submission' | 'stripe_event';

/**
 * `('signed_up',...)` for `kind NOT IN ${MILESTONE_KINDS_SQL}`. Built only from
 * the closed tuple above, never from input, so interpolation is safe.
 */
export const MILESTONE_KINDS_SQL = `(${GTM_MILESTONE_KINDS.map((kind) => `'${kind}'`).join(',')})`;

export const MILESTONE_SIGNAL_KIND: Record<GtmMilestoneKind, AccountSignalKind> = {
  signed_up: 'product-signed-up',
  activated: 'product-activated',
  integration_connected: 'product-integration-connected',
  usage_threshold_crossed: 'product-usage-threshold',
  paid: 'customer-paid',
  upgraded: 'customer-upgraded',
  cancelled: 'customer-cancelled'
};

/**
 * The stage an observed milestone guarantees. Adoption proves a qualified
 * conversation is warranted; a payment is a win. A signup, an upgrade and a
 * cancellation move nothing: Opportunities never move backwards and are never
 * closed as lost automatically.
 */
export const MILESTONE_MINIMUM_STAGE: Record<
  GtmMilestoneKind,
  Exclude<OpportunityStage, 'lost'> | null
> = {
  signed_up: null,
  activated: 'qualified',
  integration_connected: 'qualified',
  usage_threshold_crossed: 'qualified',
  paid: 'won',
  upgraded: null,
  cancelled: null
};

/** Kinds that can happen once per Person, whatever source reports them. */
export const ONE_TIME_MILESTONE_KINDS: ReadonlySet<GtmMilestoneKind> = new Set<GtmMilestoneKind>([
  'signed_up',
  'activated',
  'paid'
]);

/**
 * The deterministic idempotency key, unique per workspace.
 *
 * - One-time kinds collapse per Person, so the intake and Stripe reporting the
 *   same payment converge on one milestone.
 * - A cancellation collapses per subscription when the source names it.
 * - Everything else is one milestone per source event.
 */
export function milestoneKey(input: {
  kind: GtmMilestoneKind;
  contactId: string;
  sourceType: MilestoneSourceType;
  sourceId: string;
  externalObjectId?: string | null;
}): string {
  if (ONE_TIME_MILESTONE_KINDS.has(input.kind)) return `${input.kind}:contact:${input.contactId}`;
  if (input.kind === 'cancelled' && input.externalObjectId)
    return `cancelled:object:${input.externalObjectId}`;
  return `${input.kind}:${input.sourceType}:${input.sourceId}`;
}

/** The in-app page that proves a milestone signal: the Inbound screen, anchored. */
export function milestoneEvidencePath(milestoneId: string): string {
  return `/outreach/inbound?milestone=${encodeURIComponent(milestoneId)}`;
}
```

In `src/server/accounts/types.ts`, replace the end of `ACCOUNT_SIGNAL_KINDS` (lines 51-52):

```ts
  'thread-mention'
] as const;
```

with:

```ts
  'thread-mention',
  // First-party product and billing milestones (lead-capture/milestones.ts).
  'product-signed-up',
  'product-activated',
  'product-integration-connected',
  'product-usage-threshold',
  'customer-paid',
  'customer-upgraded',
  'customer-cancelled'
] as const;
```

Then, directly after line 54 (`export type AccountSignalKind = ...`), add:

```ts
/**
 * Kinds observed in the founder's own product or billing system. Private
 * evidence: they score an account, but they are never cited outside the
 * workspace and never accepted from an external observation provider.
 */
export const FIRST_PARTY_SIGNAL_KINDS = [
  'product-signed-up',
  'product-activated',
  'product-integration-connected',
  'product-usage-threshold',
  'customer-paid',
  'customer-upgraded',
  'customer-cancelled'
] as const satisfies readonly AccountSignalKind[];
```

In `src/server/accounts/score.ts`, replace the end of `SIGNAL_WEIGHTS` (lines 188-191):

```ts
  // A shrinking team is weak negative evidence. A closed role can also mean it
  // was filled, so contraction never outweighs corroborating positive movement.
  'hiring-down': -4
};
```

with:

```ts
  // A shrinking team is weak negative evidence. A closed role can also mean it
  // was filled, so contraction never outweighs corroborating positive movement.
  'hiring-down': -4,

  // First-party product and billing milestones (lead-capture/milestones.ts).
  // Observed in the founder's own product, so adoption is strong evidence, but
  // none alone reaches HOT_SCORE. A payment is deliberately weak here: it is
  // already a won Opportunity, and it must not push a customer toward new
  // outreach. A cancellation is strong negative evidence about the account now.
  'product-activated': 30,
  'product-usage-threshold': 28,
  'customer-upgraded': 26,
  'product-integration-connected': 24,
  'product-signed-up': 20,
  'customer-paid': 12,
  'customer-cancelled': -20
};
```

In the same file, replace the last `KIND_LABELS` entry (line 230-231):

```ts
  'thread-mention': 'a public thread'
};
```

with:

```ts
  'thread-mention': 'a public thread',
  'product-signed-up': 'a product signup',
  'product-activated': 'product activation',
  'product-integration-connected': 'a connected integration',
  'product-usage-threshold': 'usage crossing a threshold',
  'customer-paid': 'a payment',
  'customer-upgraded': 'a plan upgrade',
  'customer-cancelled': 'a cancellation'
};
```

In `src/client/AccountsScreen.tsx`, replace line 123-124:

```ts
  'thread-mention': 'Mentioned in a public thread'
};
```

with:

```ts
  'thread-mention': 'Mentioned in a public thread',
  'product-signed-up': 'Someone signed up for your product',
  'product-activated': 'Activated in your product',
  'product-integration-connected': 'Connected an integration in your product',
  'product-usage-threshold': 'Crossed a usage threshold in your product',
  'customer-paid': 'Became a paying customer',
  'customer-upgraded': 'Upgraded their plan',
  'customer-cancelled': 'Cancelled their subscription'
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/milestones.test.ts src/server/accounts/score.test.ts`
Expected: PASS. The existing `score.test.ts` weight-table test still passes, because every new kind has a weight.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/130_gtm_milestones_stripe.sql src/shared/milestones.ts src/server/lead-capture/milestones.ts src/server/lead-capture/milestones.test.ts src/server/accounts/types.ts src/server/accounts/score.ts src/client/AccountsScreen.tsx
git commit -m "feat(gtm): add milestone vocabulary and migration 130" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 2: Private signal kinds are never cited or accepted from outside

**Files:**

- Modify: `src/server/accounts/types.ts` (append after `FIRST_PARTY_SIGNAL_KINDS`)
- Modify: `src/server/content/opportunity-builder.ts:2,39`
- Modify: `src/server/content/pulse.ts:2,106,124`
- Modify: `src/server/content/index.ts:1,100,116`
- Modify: `src/server/demand/candidates.ts:1,157`
- Modify: `src/server/observations/providers/http.ts:2,16`
- Test: `src/server/accounts/uncitable-signals.test.ts`

**Interfaces:**

- Consumes: `FIRST_PARTY_SIGNAL_KINDS` (Task 1).
- Produces: `UNCITABLE_SIGNAL_KINDS` and `UNCITABLE_SIGNAL_KINDS_SQL: string` from `src/server/accounts/types.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/server/accounts/uncitable-signals.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { UNCITABLE_SIGNAL_KINDS_SQL } from './types.js';
import { recordSignals } from './sweep.js';
import { buildDemandCandidates } from '../demand/candidates.js';
import { httpObservationProvider } from '../observations/providers/http.js';

const WS = 'ws_uncitable_signals';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const CITING_FILES = [
  'src/server/content/opportunity-builder.ts',
  'src/server/content/pulse.ts',
  'src/server/content/index.ts',
  'src/server/demand/candidates.ts'
];

describe('uncitable signal kinds', () => {
  it('lists the baseline and every first-party kind', () => {
    expect(UNCITABLE_SIGNAL_KINDS_SQL).toBe(
      "('first-capture','product-signed-up','product-activated','product-integration-connected','product-usage-threshold','customer-paid','customer-upgraded','customer-cancelled')"
    );
  });

  it('is the exclusion every evidence query uses', () => {
    for (const file of CITING_FILES) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toContain("kind<>'first-capture'");
      expect(source, file).toContain('NOT IN ${UNCITABLE_SIGNAL_KINDS_SQL}');
    }
  });

  it('refuses a first-party kind from an external observation provider', async () => {
    const provider = httpObservationProvider({
      key: 'commerce-observer',
      name: 'Commerce observation plane',
      endpoint: 'https://observer.example/observe',
      tokenEnv: null,
      docsUrl: 'https://observer.example/docs',
      surfaces: ['site']
    });
    const result = await provider.observe('shop.example', {
      credentials: { get: () => undefined },
      now: NOW,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            observations: [
              {
                kind: 'customer-paid',
                detail: 'Forged payment.',
                previous: null,
                current: 'paid',
                evidenceUrl: 'https://shop.example/',
                observedAt: '2026-10-06T08:00:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    });
    expect(result.observations).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.includes("unknown signal kind 'customer-paid'"))
    ).toBe(true);
  });
});

describe('demand evidence', () => {
  let db: Db;
  let milestoneAccountId = '';
  let controlAccountId = '';

  async function seedHotDormantAccount(
    label: string,
    signal: { kind: string; evidenceUrl: string }
  ): Promise<string> {
    const personId = id('con');
    const accountId = id('acc');
    const at = NOW.toISOString();
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        personId,
        WS,
        `${label} Person`,
        `${label}@uncitable.test`,
        `${label}@uncitable.test`,
        at,
        at
      );
    await db
      .prepare(
        "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
      )
      .run(accountId, WS, `${label} Co`, `${label}.uncitable.test`, at, at);
    await db
      .prepare(
        `INSERT INTO opportunities (id,workspace_id,person_id,account_id,title,stage,owner_type,created_at,updated_at)
         VALUES (?,?,?,?,?,'qualified','system',?,?)`
      )
      .run(id('opp'), WS, personId, accountId, `${label} pilot`, old, old);
    await db
      .prepare(
        `INSERT INTO account_scores (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,computed_at)
         VALUES (?,?,90,'hot',2,?,?)`
      )
      .run(WS, accountId, new Date(NOW.getTime() - 3_600_000).toISOString(), at);
    await recordSignals(
      db,
      WS,
      accountId,
      [
        {
          kind: signal.kind,
          detail: `${label} moved.`,
          previous: null,
          current: `${label}:now`,
          evidenceUrl: signal.evidenceUrl,
          observedAt: new Date(NOW.getTime() - 3_600_000)
        }
      ],
      NOW
    );
    return accountId;
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WS, WS, NOW.toISOString());
    milestoneAccountId = await seedHotDormantAccount('milestone', {
      kind: 'product-activated',
      evidenceUrl: '/outreach/inbound?milestone=pm_uncitable'
    });
    controlAccountId = await seedHotDormantAccount('control', {
      kind: 'pricing-changed',
      evidenceUrl: 'https://control.uncitable.test/pricing'
    });
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
    await db?.close();
  });

  it('never builds a demand recommendation from first-party milestones alone', async () => {
    const candidates = await buildDemandCandidates(db, WS, NOW);
    // Positive control: the same setup with a public signal does produce one.
    expect(candidates.some((candidate) => candidate.accountId === controlAccountId)).toBe(true);
    expect(candidates.filter((candidate) => candidate.accountId === milestoneAccountId)).toEqual(
      []
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/accounts/uncitable-signals.test.ts`
Expected: FAIL. `UNCITABLE_SIGNAL_KINDS_SQL` is undefined, the source files still contain `kind<>'first-capture'`, the provider accepts `customer-paid`, and a milestone-only candidate is returned.

- [ ] **Step 3: Write the implementation**

In `src/server/accounts/types.ts`, directly after the `FIRST_PARTY_SIGNAL_KINDS` declaration from Task 1, add:

```ts
/**
 * Kinds that are never cited as evidence outside the workspace: in content
 * drafts, market pulse, demand recommendations, or from an external provider.
 * `first-capture` is a baseline, not news; the first-party kinds are the
 * founder's own product and billing data.
 */
export const UNCITABLE_SIGNAL_KINDS = ['first-capture', ...FIRST_PARTY_SIGNAL_KINDS] as const;

/** `('first-capture',...)` for `kind NOT IN ${...}`. Built from the closed tuple only. */
export const UNCITABLE_SIGNAL_KINDS_SQL = `(${UNCITABLE_SIGNAL_KINDS.map((kind) => `'${kind}'`).join(',')})`;
```

Replace the six `kind<>'first-capture'` clauses. All of them sit inside template literals, so interpolation works:

```bash
sed -i "s/kind<>'first-capture'/kind NOT IN \${UNCITABLE_SIGNAL_KINDS_SQL}/g" \
  src/server/content/opportunity-builder.ts \
  src/server/content/pulse.ts \
  src/server/content/index.ts \
  src/server/demand/candidates.ts
grep -n "UNCITABLE_SIGNAL_KINDS_SQL" src/server/content/opportunity-builder.ts src/server/content/pulse.ts src/server/content/index.ts src/server/demand/candidates.ts
```

Expected grep: 1 hit in `opportunity-builder.ts` (`kind NOT IN ${UNCITABLE_SIGNAL_KINDS_SQL}`), 2 in `pulse.ts` and 2 in `index.ts` (`s.kind NOT IN ...`), and 1 in `candidates.ts`.

Add the import to each of the four files, directly after its `import type { Db } from '../db.js';` line:

```ts
import { UNCITABLE_SIGNAL_KINDS_SQL } from '../accounts/types.js';
```

In `src/server/observations/providers/http.ts`, replace line 2:

```ts
import { ACCOUNT_SIGNAL_KINDS } from '../../accounts/types.js';
```

with:

```ts
import { ACCOUNT_SIGNAL_KINDS, FIRST_PARTY_SIGNAL_KINDS } from '../../accounts/types.js';
```

and replace line 16:

```ts
const KNOWN_SIGNAL_KINDS = new Set<string>(ACCOUNT_SIGNAL_KINDS);
```

with:

```ts
// First-party kinds are observed in the founder's own product and billing. An
// external provider claiming one is confused or forging, so it is "unknown".
const FIRST_PARTY_KINDS = new Set<string>(FIRST_PARTY_SIGNAL_KINDS);
const KNOWN_SIGNAL_KINDS = new Set<string>(
  ACCOUNT_SIGNAL_KINDS.filter((kind) => !FIRST_PARTY_KINDS.has(kind))
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/accounts/uncitable-signals.test.ts src/server/observations/providers/http.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/accounts/types.ts src/server/accounts/uncitable-signals.test.ts src/server/content/opportunity-builder.ts src/server/content/pulse.ts src/server/content/index.ts src/server/demand/candidates.ts src/server/observations/providers/http.ts
git commit -m "feat(gtm): keep first-party signals out of cited evidence" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 3: Forward-only Opportunity stage advance (contract 1)

**Files:**

- Create: `src/server/opportunity-advance.ts`
- Test: `src/server/opportunity-advance.test.ts`

**Interfaces:**

- Consumes: table `opportunity_stage_observations` (Task 1); `OpportunityStage` from `src/server/opportunities.ts`; `appendDomainEvent` from `src/server/control-plane/events.ts`.
- Produces (consumed by this phase's Task 4 and by Phases B and C):

```ts
export const STAGE_RANK: Record<OpportunityStage, number>; // new 1 … won 5, lost 6
export interface AdvanceOpportunityInput {
  workspaceId: string;
  personId: string | null;
  accountId: string | null;
  minimumStage: Exclude<OpportunityStage, 'lost'>;
  title: string;
  reason: string;
  sourceType: string;
  sourceId: string;
}
export interface AdvanceOpportunityResult {
  opportunityId: string;
  previousStage: OpportunityStage | null;
  stage: OpportunityStage;
  created: boolean;
  changed: boolean;
}
export class OpportunityAdvanceError extends Error {
  status: number;
}
// Opens its own transaction: never call inside db.transaction.
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityInput,
  now?: Date
): Promise<AdvanceOpportunityResult>;
```

- [ ] **Step 1: Write the failing test**

Create `src/server/opportunity-advance.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from './db.js';
import {
  OpportunityAdvanceError,
  STAGE_RANK,
  advanceOpportunityStage,
  type AdvanceOpportunityInput
} from './opportunity-advance.js';

const WS = 'ws_opportunity_advance';
const OTHER = 'ws_opportunity_advance_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let personId = '';
let accountId = '';
let foreignPersonId = '';

async function seedPerson(workspaceId: string, email: string): Promise<string> {
  const personRow = id('con');
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(personRow, workspaceId, email, email, email, NOW.toISOString(), NOW.toISOString());
  return personRow;
}

async function opportunityRows() {
  return db
    .prepare(
      'SELECT id,stage,closed_at FROM opportunities WHERE workspace_id=? ORDER BY created_at,id'
    )
    .all<{ id: string; stage: string; closed_at: string | null }>(WS);
}

async function eventCount(eventType: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM domain_events
       WHERE workspace_id=? AND stream_type='opportunity' AND event_type=?`
    )
    .get<{ n: number }>(WS, eventType);
  return Number(row?.n ?? 0);
}

function input(overrides: Partial<AdvanceOpportunityInput> = {}): AdvanceOpportunityInput {
  return {
    workspaceId: WS,
    personId,
    accountId,
    minimumStage: 'qualified',
    title: 'Acme: product adoption',
    reason: 'milestone:activated',
    sourceType: 'product_milestone',
    sourceId: 'pm_one',
    ...overrides
  };
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  for (const workspaceId of [WS, OTHER])
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  personId = await seedPerson(WS, 'maya@acme-advance.test');
  foreignPersonId = await seedPerson(OTHER, 'maya@acme-advance.test');
  accountId = id('acc');
  await db
    .prepare(
      "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
    )
    .run(accountId, WS, 'Acme', 'acme-advance.test', NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  await db?.close();
});

describe('advanceOpportunityStage', () => {
  it('ranks stages new < qualified < meeting < proposal < won < lost', () => {
    expect(STAGE_RANK).toEqual({ new: 1, qualified: 2, meeting: 3, proposal: 4, won: 5, lost: 6 });
  });

  it('creates an Opportunity at the minimum stage once per source', async () => {
    const first = await advanceOpportunityStage(db, input(), NOW);
    expect(first).toMatchObject({
      previousStage: null,
      stage: 'qualified',
      created: true,
      changed: true
    });
    const replay = await advanceOpportunityStage(db, input(), NOW);
    expect(replay).toEqual({
      opportunityId: first.opportunityId,
      previousStage: 'qualified',
      stage: 'qualified',
      created: false,
      changed: false
    });
    expect(await opportunityRows()).toHaveLength(1);
    expect(await eventCount('opportunity.created_from_observation')).toBe(1);
  });

  it('raises an open Opportunity but never lowers one', async () => {
    const created = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'new', sourceId: 'pm_new' }),
      NOW
    );
    const raised = await advanceOpportunityStage(db, input({ sourceId: 'pm_raise' }), NOW);
    expect(raised).toMatchObject({
      opportunityId: created.opportunityId,
      previousStage: 'new',
      stage: 'qualified',
      created: false,
      changed: true
    });
    await db
      .prepare("UPDATE opportunities SET stage='proposal' WHERE id=?")
      .run(created.opportunityId);
    const held = await advanceOpportunityStage(db, input({ sourceId: 'pm_hold' }), NOW);
    expect(held).toMatchObject({
      opportunityId: created.opportunityId,
      previousStage: 'proposal',
      stage: 'proposal',
      changed: false
    });
    expect(await eventCount('opportunity.stage_advanced')).toBe(1);
  });

  it('closes as won with closed_at, and never reopens a closed row', async () => {
    const qualified = await advanceOpportunityStage(db, input(), NOW);
    const won = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'won', sourceId: 'pm_paid' }),
      NOW
    );
    expect(won).toMatchObject({
      opportunityId: qualified.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
    expect((await opportunityRows())[0].closed_at).not.toBeNull();

    const wonAgain = await advanceOpportunityStage(
      db,
      input({ minimumStage: 'won', sourceId: 'pm_paid_again' }),
      NOW
    );
    expect(wonAgain).toMatchObject({
      opportunityId: qualified.opportunityId,
      stage: 'won',
      created: false,
      changed: false
    });

    const fresh = await advanceOpportunityStage(db, input({ sourceId: 'pm_expansion' }), NOW);
    expect(fresh).toMatchObject({ stage: 'qualified', created: true });
    expect(fresh.opportunityId).not.toBe(qualified.opportunityId);
    expect(await opportunityRows()).toHaveLength(2);
  });

  it('falls back to the Account when the Person has no open Opportunity', async () => {
    const colleague = await seedPerson(WS, 'sam@acme-advance.test');
    const viaAccount = await advanceOpportunityStage(
      db,
      input({ personId: null, sourceId: 'pm_account' }),
      NOW
    );
    const matched = await advanceOpportunityStage(
      db,
      input({ personId: colleague, minimumStage: 'won', sourceId: 'pm_colleague' }),
      NOW
    );
    expect(matched).toMatchObject({
      opportunityId: viaAccount.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
  });

  it('rejects a Person from another workspace and refuses to close as lost', async () => {
    await expect(
      advanceOpportunityStage(db, input({ personId: foreignPersonId, sourceId: 'pm_foreign' }), NOW)
    ).rejects.toBeInstanceOf(OpportunityAdvanceError);
    await expect(
      advanceOpportunityStage(
        db,
        input({ minimumStage: 'lost' as never, sourceId: 'pm_lost' }),
        NOW
      )
    ).rejects.toThrow('never close');
    expect(await opportunityRows()).toHaveLength(0);
  });

  it('serialises concurrent observations into one Opportunity', async () => {
    const results = await Promise.all([
      advanceOpportunityStage(db, input({ sourceId: 'pm_a' }), NOW),
      advanceOpportunityStage(db, input({ sourceId: 'pm_b' }), NOW)
    ]);
    expect(new Set(results.map((result) => result.opportunityId)).size).toBe(1);
    expect(await opportunityRows()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/opportunity-advance.test.ts`
Expected: FAIL with `Cannot find module './opportunity-advance.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/opportunity-advance.ts`:

```ts
import { id, type Db } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import type { OpportunityStage } from './opportunities.js';

/**
 * Forward-only Opportunity stage moves from observed facts (GTM roadmap
 * contract 1). A product milestone, a payment or a meeting can raise a stage;
 * nothing observed ever lowers one, reopens a closed row, or closes as lost.
 */
export const STAGE_RANK: Record<OpportunityStage, number> = {
  new: 1,
  qualified: 2,
  meeting: 3,
  proposal: 4,
  won: 5,
  lost: 6
};

export interface AdvanceOpportunityInput {
  workspaceId: string;
  personId: string | null;
  accountId: string | null;
  minimumStage: Exclude<OpportunityStage, 'lost'>;
  /** Used only when a new Opportunity is created. */
  title: string;
  /** Short and content-free; stored in the domain event. */
  reason: string;
  /** e.g. 'product_milestone' | 'meeting'. The pair is the idempotency key. */
  sourceType: string;
  sourceId: string;
}

export interface AdvanceOpportunityResult {
  opportunityId: string;
  previousStage: OpportunityStage | null;
  stage: OpportunityStage;
  created: boolean;
  changed: boolean;
}

export class OpportunityAdvanceError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

type StageRow = { id: string; stage: OpportunityStage };

async function latestOpportunity(
  tx: Db,
  workspaceId: string,
  column: 'person_id' | 'account_id',
  value: string,
  open: boolean
): Promise<StageRow | null> {
  // `column` comes from a closed two-member union, never from input.
  const row = await tx
    .prepare(
      `SELECT id,stage FROM opportunities
       WHERE workspace_id=? AND ${column}=?
         AND stage ${open ? "NOT IN ('won','lost')" : "IN ('won','lost')"}
       ORDER BY updated_at DESC,id DESC
       LIMIT 1${open ? ' FOR UPDATE' : ''}`
    )
    .get<StageRow>(workspaceId, value);
  return row ?? null;
}

/**
 * Raise (or create) the Opportunity an observation belongs to.
 *
 * Opens its own transaction: callers must not call it inside one.
 *
 * 1. A source already recorded returns the Opportunity's current stage with
 *    `created: false, changed: false`.
 * 2. The most recently updated open Opportunity for the Person, else the
 *    Account, is raised only if its stage ranks below `minimumStage`.
 * 3. With only closed matches, `won` returns the latest closed row unchanged;
 *    any lower floor creates a fresh row.
 * 4. With no match, a system-owned row is created at `minimumStage`.
 */
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityInput,
  now: Date = new Date()
): Promise<AdvanceOpportunityResult> {
  const personId = input.personId?.trim() || null;
  const accountId = input.accountId?.trim() || null;
  const sourceType = input.sourceType.trim();
  const sourceId = input.sourceId.trim();
  const minimumStage = input.minimumStage;
  if (!personId && !accountId)
    throw new OpportunityAdvanceError('A stage advance requires a Person or Account.');
  if (!sourceType || !sourceId)
    throw new OpportunityAdvanceError('A stage advance requires a source.');
  if ((minimumStage as string) === 'lost' || !(minimumStage in STAGE_RANK))
    throw new OpportunityAdvanceError('Observations never close an Opportunity as lost.');
  const title = input.title.trim().slice(0, 200) || 'Opportunity';
  const reason = input.reason.trim().slice(0, 120);
  const at = now.toISOString();
  const workspaceId = input.workspaceId;

  return db.transaction(async (tx) => {
    // lc-debt: one advisory lock per workspace serialises every observed stage
    // move in it; upgrade path is a per-person/per-account lock pair once
    // observation volume turns this into a queue.
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${workspaceId}\u001fopportunity-advance`);

    const recorded = await tx
      .prepare(
        `SELECT o.id,o.stage
         FROM opportunity_stage_observations x
         JOIN opportunities o ON o.workspace_id=x.workspace_id AND o.id=x.opportunity_id
         WHERE x.workspace_id=? AND x.source_type=? AND x.source_id=?`
      )
      .get<StageRow>(workspaceId, sourceType, sourceId);
    if (recorded)
      return {
        opportunityId: recorded.id,
        previousStage: recorded.stage,
        stage: recorded.stage,
        created: false,
        changed: false
      };

    if (personId) {
      const person = await tx
        .prepare('SELECT 1 AS present FROM contacts WHERE workspace_id=? AND id=?')
        .get(workspaceId, personId);
      if (!person) throw new OpportunityAdvanceError('Person not found in this workspace.');
    }
    if (accountId) {
      const account = await tx
        .prepare('SELECT 1 AS present FROM accounts WHERE workspace_id=? AND id=?')
        .get(workspaceId, accountId);
      if (!account) throw new OpportunityAdvanceError('Account not found in this workspace.');
    }

    let result: AdvanceOpportunityResult;
    const open =
      (personId ? await latestOpportunity(tx, workspaceId, 'person_id', personId, true) : null) ??
      (accountId ? await latestOpportunity(tx, workspaceId, 'account_id', accountId, true) : null);

    if (open) {
      const raise = STAGE_RANK[open.stage] < STAGE_RANK[minimumStage];
      if (raise) {
        await tx
          .prepare(
            'UPDATE opportunities SET stage=?,closed_at=?,updated_at=? WHERE workspace_id=? AND id=?'
          )
          .run(minimumStage, minimumStage === 'won' ? at : null, at, workspaceId, open.id);
        await appendDomainEvent(tx, {
          workspaceId,
          streamType: 'opportunity',
          streamId: open.id,
          eventType: 'opportunity.stage_advanced',
          actorType: 'system',
          correlationId: sourceId,
          payload: { from: open.stage, to: minimumStage, reason, sourceType, sourceId },
          occurredAt: now
        });
      }
      result = {
        opportunityId: open.id,
        previousStage: open.stage,
        stage: raise ? minimumStage : open.stage,
        created: false,
        changed: raise
      };
    } else {
      const closed =
        (personId
          ? await latestOpportunity(tx, workspaceId, 'person_id', personId, false)
          : null) ??
        (accountId
          ? await latestOpportunity(tx, workspaceId, 'account_id', accountId, false)
          : null);
      if (closed && minimumStage === 'won') {
        result = {
          opportunityId: closed.id,
          previousStage: closed.stage,
          stage: closed.stage,
          created: false,
          changed: false
        };
      } else {
        const opportunityId = id('opp');
        await tx
          .prepare(
            `INSERT INTO opportunities (
               id,workspace_id,person_id,account_id,title,stage,owner_type,owner_id,
               next_action,next_action_at,created_at,updated_at,closed_at
             ) VALUES (?,?,?,?,?,?,'system',NULL,NULL,NULL,?,?,?)`
          )
          .run(
            opportunityId,
            workspaceId,
            personId,
            accountId,
            title,
            minimumStage,
            at,
            at,
            minimumStage === 'won' ? at : null
          );
        await appendDomainEvent(tx, {
          workspaceId,
          streamType: 'opportunity',
          streamId: opportunityId,
          eventType: 'opportunity.created_from_observation',
          actorType: 'system',
          correlationId: sourceId,
          payload: { stage: minimumStage, reason, sourceType, sourceId },
          occurredAt: now
        });
        result = {
          opportunityId,
          previousStage: null,
          stage: minimumStage,
          created: true,
          changed: true
        };
      }
    }

    await tx
      .prepare(
        `INSERT INTO opportunity_stage_observations
         (workspace_id,source_type,source_id,opportunity_id,previous_stage,stage,created,changed,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        sourceType,
        sourceId,
        result.opportunityId,
        result.previousStage,
        result.stage,
        result.created,
        result.changed,
        at
      );
    return result;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/opportunity-advance.test.ts src/server/opportunities.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/opportunity-advance.ts src/server/opportunity-advance.test.ts
git commit -m "feat(gtm): add forward-only opportunity stage advance" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 4: Milestone recorder and signed-intake wiring

**Files:**

- Create: `src/server/lead-capture/milestone-recorder.ts`
- Modify: `src/server/lead-capture/http.ts:1-12,85`
- Test: `src/server/lead-capture/milestone-recorder.test.ts`

**Interfaces:**

- Consumes:
  - `advanceOpportunityStage`, `AdvanceOpportunityResult` (Task 3).
  - `MILESTONE_*`, `milestoneKey`, `milestoneEvidencePath`, `GtmMilestoneKind`, `MilestoneSourceType`, `isMilestoneKind` (Task 1).
  - `recordSignals(db, ws, accountId, IncomingSignal[], now)` from `src/server/accounts/sweep.ts`; `rescoreAccount(db, ws, accountId, { now })` from `src/server/accounts/score.ts`; `accountForPerson(db, ws, personId)` from `src/server/person-identities.ts`.
- Produces (used by Tasks 5, 7 and 11):

```ts
export interface ProductMilestone {
  id: string;
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId: string | null;
  externalObjectId: string | null;
  occurredAt: string;
  createdAt: string;
}
export interface ProductMilestoneView extends ProductMilestone {
  label: string;
  personName: string | null;
  personEmail: string | null;
  accountName: string | null;
}
export interface RecordProductMilestoneInput {
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId?: string | null;
  externalObjectId?: string | null;
  occurredAt: Date;
}
export interface RecordProductMilestoneResult {
  milestone: ProductMilestone;
  created: boolean;
  signalsWritten: number;
  opportunity: AdvanceOpportunityResult | null;
}
export async function recordProductMilestone(
  db: Db,
  input: RecordProductMilestoneInput,
  now?: Date
): Promise<RecordProductMilestoneResult>;
export async function listProductMilestones(
  db: Db,
  workspaceId: string,
  limit?: number
): Promise<ProductMilestoneView[]>;
```

- [ ] **Step 1: Write the failing test**

Create `src/server/lead-capture/milestone-recorder.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { registerLeadCaptureIntake } from './http.js';
import { createCaptureSource } from './sources.js';
import { LeadCaptureError } from './types.js';
import {
  listProductMilestones,
  recordProductMilestone,
  type RecordProductMilestoneInput
} from './milestone-recorder.js';

const WS = 'ws_milestone_recorder';
const OTHER = 'ws_milestone_recorder_other';
const USER = 'usr_milestone_recorder';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let app: Express;
let sourceId = '';
let sourceSecret = '';
let contactId = '';
let accountId = '';
let foreignContactId = '';

async function seedContact(workspaceId: string, email: string): Promise<string> {
  const contact = id('con');
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(contact, workspaceId, 'Ada Lovelace', email, email, NOW.toISOString(), NOW.toISOString());
  return contact;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>(...params);
  return Number(row?.n ?? 0);
}

function milestone(overrides: Partial<RecordProductMilestoneInput>): RecordProductMilestoneInput {
  return {
    workspaceId: WS,
    kind: 'activated',
    contactId,
    accountId,
    sourceType: 'inbound_submission',
    sourceId: 'sub_default',
    occurredAt: NOW,
    ...overrides
  };
}

function intake(key: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', sourceSecret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`, 'utf8'), Buffer.from(raw, 'utf8')]))
    .digest('hex');
  return request(app)
    .post('/api/intake/v1/submissions')
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', sourceId)
    .set('X-Trevra-Timestamp', String(timestamp))
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${signature}`)
    .send(raw);
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = express();
  registerLeadCaptureIntake(app, db);
});

beforeEach(async () => {
  for (const workspaceId of [WS, OTHER]) {
    // inbound_submissions RESTRICTs deleting its Person; remove it first.
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'owner@milestones.test', 'Owner', NOW.toISOString());
  contactId = await seedContact(WS, 'ada@acme-milestone.test');
  foreignContactId = await seedContact(OTHER, 'ada@acme-milestone.test');
  accountId = id('acc');
  await db
    .prepare(
      "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
    )
    .run(
      accountId,
      WS,
      'Acme Milestone',
      'acme-milestone.test',
      NOW.toISOString(),
      NOW.toISOString()
    );
  const created = await createCaptureSource(db, {
    workspaceId: WS,
    actorUserId: USER,
    name: 'Product',
    kind: 'signup'
  });
  sourceId = created.source.id;
  sourceSecret = created.secret;
});

afterAll(async () => {
  for (const workspaceId of [WS, OTHER]) {
    await db?.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('recordProductMilestone', () => {
  it('records paid before activated, and duplicates, as one payment and one forward move', async () => {
    const paid = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_1',
        externalObjectId: 'in_1'
      }),
      NOW
    );
    expect(paid).toMatchObject({
      created: true,
      signalsWritten: 1,
      opportunity: { stage: 'won', created: true }
    });

    const late = await recordProductMilestone(
      db,
      milestone({ kind: 'activated', sourceId: 'sub_late_activation' }),
      NOW
    );
    expect(late.created).toBe(true);
    expect(late.opportunity).toBeNull();

    const again = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_2',
        externalObjectId: 'in_2'
      }),
      NOW
    );
    expect(again).toMatchObject({
      created: false,
      signalsWritten: 0,
      opportunity: { changed: false }
    });
    expect(again.milestone.id).toBe(paid.milestone.id);

    const replay = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_1',
        externalObjectId: 'in_1'
      }),
      NOW
    );
    expect(replay.milestone.id).toBe(paid.milestone.id);

    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND kind='paid'",
        WS
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals WHERE workspace_id=? AND kind='customer-paid'",
        WS
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='won' AND closed_at IS NOT NULL",
        WS
      )
    ).toBe(1);
  });

  it('moves activation to qualified, then payment to won, on the same Opportunity', async () => {
    const activated = await recordProductMilestone(
      db,
      milestone({ sourceId: 'sub_activation' }),
      NOW
    );
    expect(activated.opportunity).toMatchObject({ stage: 'qualified', created: true });
    const paid = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid',
        externalObjectId: 'cs_1'
      }),
      NOW
    );
    expect(paid.opportunity).toMatchObject({
      opportunityId: activated.opportunity!.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(1);
  });

  it('records a cancellation without moving the stage, once per subscription', async () => {
    const first = await recordProductMilestone(
      db,
      milestone({
        kind: 'cancelled',
        sourceType: 'stripe_event',
        sourceId: 'evt_cancel_1',
        externalObjectId: 'sub_123'
      }),
      NOW
    );
    const second = await recordProductMilestone(
      db,
      milestone({
        kind: 'cancelled',
        sourceType: 'stripe_event',
        sourceId: 'evt_cancel_2',
        externalObjectId: 'sub_123'
      }),
      NOW
    );
    expect(first).toMatchObject({ created: true, signalsWritten: 1, opportunity: null });
    expect(second).toMatchObject({ created: false, signalsWritten: 0, opportunity: null });
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals WHERE workspace_id=? AND kind='customer-cancelled'",
        WS
      )
    ).toBe(1);
  });

  it('writes the signal with an in-app evidence link and rescores the account', async () => {
    const recorded = await recordProductMilestone(
      db,
      milestone({ kind: 'signed_up', sourceId: 'sub_signup' }),
      NOW
    );
    const signal = await db
      .prepare(
        'SELECT kind,detail,current,evidence_url FROM account_signals WHERE workspace_id=? AND account_id=?'
      )
      .get<Record<string, string>>(WS, accountId);
    expect(signal).toEqual({
      kind: 'product-signed-up',
      detail: 'A person at this account signed up.',
      current: `milestone:${recorded.milestone.id}`,
      evidence_url: `/outreach/inbound?milestone=${recorded.milestone.id}`
    });
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM account_scores WHERE workspace_id=? AND account_id=?',
        WS,
        accountId
      )
    ).toBe(1);
    expect(recorded.opportunity).toBeNull();
  });

  it('refuses a Person from another workspace', async () => {
    await expect(
      recordProductMilestone(
        db,
        milestone({ contactId: foreignContactId, sourceId: 'sub_foreign' }),
        NOW
      )
    ).rejects.toBeInstanceOf(LeadCaptureError);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id IN (?,?)',
        WS,
        OTHER
      )
    ).toBe(0);
  });
});

describe('signed intake', () => {
  it('records a milestone kind and keeps the submission as provenance', async () => {
    const occurredAt = new Date(Date.now() - 86_400_000).toISOString();
    const body = {
      kind: 'activated',
      occurredAt,
      person: { email: 'ada@acme-milestone.test' },
      company: { domain: 'acme-milestone.test' }
    };
    const first = await intake('milestone-activated-0001', body).expect(202);
    const second = await intake('milestone-activated-0001', body).expect(200);
    expect(second.body.duplicate).toBe(true);

    const rows = await listProductMilestones(db, WS, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'activated',
      sourceType: 'inbound_submission',
      sourceId: first.body.submissionId,
      contactId,
      accountId,
      occurredAt,
      label: 'activated',
      accountName: 'Acme Milestone'
    });
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='qualified'",
        WS
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM inbound_submissions WHERE workspace_id=?', WS)
    ).toBe(1);
  });

  it('leaves an ordinary inbound kind alone', async () => {
    await intake('milestone-demo-0001', {
      kind: 'demo_request',
      person: { email: 'ada@acme-milestone.test' }
    }).expect(202);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS)
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/milestone-recorder.test.ts`
Expected: FAIL with `Cannot find module './milestone-recorder.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/lead-capture/milestone-recorder.ts`:

```ts
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { recordSignals } from '../accounts/sweep.js';
import { rescoreAccount } from '../accounts/score.js';
import { advanceOpportunityStage, type AdvanceOpportunityResult } from '../opportunity-advance.js';
import { LeadCaptureError } from './types.js';
import {
  MILESTONE_LABELS,
  MILESTONE_MINIMUM_STAGE,
  MILESTONE_SIGNAL_KIND,
  milestoneEvidencePath,
  milestoneKey,
  type GtmMilestoneKind,
  type MilestoneSourceType
} from './milestones.js';

export interface ProductMilestone {
  id: string;
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId: string | null;
  externalObjectId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface ProductMilestoneView extends ProductMilestone {
  label: string;
  personName: string | null;
  personEmail: string | null;
  accountName: string | null;
}

export interface RecordProductMilestoneInput {
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId?: string | null;
  externalObjectId?: string | null;
  occurredAt: Date;
}

export interface RecordProductMilestoneResult {
  milestone: ProductMilestone;
  created: boolean;
  signalsWritten: number;
  opportunity: AdvanceOpportunityResult | null;
}

function toMilestone(row: Record<string, unknown>): ProductMilestone {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as GtmMilestoneKind,
    contactId: String(row.contact_id),
    accountId: row.account_id ? String(row.account_id) : null,
    sourceType: String(row.source_type) as MilestoneSourceType,
    sourceId: String(row.source_id),
    providerEndpointId: row.provider_endpoint_id ? String(row.provider_endpoint_id) : null,
    externalObjectId: row.external_object_id ? String(row.external_object_id) : null,
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

/** A person who already paid, or whose Opportunity is won, is a customer. */
async function isCustomer(db: Db, workspaceId: string, contactId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
       WHERE EXISTS (SELECT 1 FROM product_milestones WHERE workspace_id=? AND contact_id=? AND kind='paid')
          OR EXISTS (SELECT 1 FROM opportunities WHERE workspace_id=? AND person_id=? AND stage='won')`
    )
    .get<{ present: number }>(workspaceId, contactId, workspaceId, contactId);
  return Boolean(row);
}

async function opportunityTitle(
  db: Db,
  workspaceId: string,
  contactId: string,
  accountId: string | null,
  kind: GtmMilestoneKind
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT p.name AS person_name,a.name AS account_name
       FROM contacts p
       LEFT JOIN accounts a ON a.workspace_id=p.workspace_id AND a.id=?
       WHERE p.workspace_id=? AND p.id=?`
    )
    .get<Record<string, unknown>>(accountId, workspaceId, contactId);
  const who =
    String(row?.account_name ?? '').trim() || String(row?.person_name ?? '').trim() || 'Customer';
  return `${who}: ${kind === 'paid' ? 'paying customer' : 'product adoption'}`;
}

/**
 * THE ONLY WRITER OF PRODUCT MILESTONES. The signed intake and the Stripe
 * webhook both call it, so the two sources converge on one record.
 *
 * 1. One `product_milestones` row per deterministic key (`milestoneKey`), under
 *    an advisory lock, plus one `product_milestone.recorded` event.
 * 2. One private account signal (deduped by `milestone:<id>`), then a rescore.
 * 3. One forward-only stage move keyed by the milestone id. Adoption is skipped
 *    once the person is already a customer, so a late `activated` never opens
 *    a fresh qualified Opportunity beside a won one.
 *
 * Steps 2 and 3 run on every call, including duplicates, so a retry after a
 * crash between writes converges instead of leaving a half-recorded milestone.
 */
export async function recordProductMilestone(
  db: Db,
  input: RecordProductMilestoneInput,
  now: Date = new Date()
): Promise<RecordProductMilestoneResult> {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new LeadCaptureError('A milestone needs a source id.', 400);
  const occurredAt =
    !Number.isFinite(input.occurredAt.getTime()) || input.occurredAt.getTime() > now.getTime()
      ? now
      : input.occurredAt;
  const externalObjectId = input.externalObjectId?.trim() || null;
  const key = milestoneKey({
    kind: input.kind,
    contactId: input.contactId,
    sourceType: input.sourceType,
    sourceId,
    externalObjectId
  });

  const { milestone, created } = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${input.workspaceId}\u001fmilestone\u001f${key}`);
    const contact = await tx
      .prepare('SELECT 1 AS present FROM contacts WHERE workspace_id=? AND id=?')
      .get(input.workspaceId, input.contactId);
    if (!contact) throw new LeadCaptureError('Person not found in this workspace.', 400);
    if (input.accountId) {
      const account = await tx
        .prepare('SELECT 1 AS present FROM accounts WHERE workspace_id=? AND id=?')
        .get(input.workspaceId, input.accountId);
      if (!account) throw new LeadCaptureError('Account not found in this workspace.', 400);
    }

    const findExisting = () =>
      tx
        .prepare(
          `SELECT * FROM product_milestones
           WHERE workspace_id=? AND ((source_type=? AND source_id=?) OR milestone_key=?)
           ORDER BY created_at ASC,id ASC LIMIT 1`
        )
        .get<Record<string, unknown>>(input.workspaceId, input.sourceType, sourceId, key);
    const existing = await findExisting();
    if (existing) return { milestone: toMilestone(existing), created: false };

    const milestoneId = id('pm');
    const row = await tx
      .prepare(
        `INSERT INTO product_milestones (
           id,workspace_id,kind,contact_id,account_id,source_type,source_id,
           provider_endpoint_id,external_object_id,milestone_key,occurred_at,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO NOTHING
         RETURNING *`
      )
      .get<Record<string, unknown>>(
        milestoneId,
        input.workspaceId,
        input.kind,
        input.contactId,
        input.accountId,
        input.sourceType,
        sourceId,
        input.providerEndpointId ?? null,
        externalObjectId,
        key,
        occurredAt.toISOString(),
        now.toISOString()
      );
    if (!row) {
      const winner = await findExisting();
      if (!winner) throw new Error('Product milestone could not be recorded');
      return { milestone: toMilestone(winner), created: false };
    }
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: input.contactId,
      eventType: 'product_milestone.recorded',
      actorType: 'system',
      actorId: input.providerEndpointId ?? null,
      correlationId: milestoneId,
      payload: { kind: input.kind, sourceType: input.sourceType, milestoneId },
      occurredAt: now
    });
    return { milestone: toMilestone(row), created: true };
  });

  let signalsWritten = 0;
  const accountId = input.accountId ?? milestone.accountId;
  if (accountId) {
    const written = await recordSignals(
      db,
      input.workspaceId,
      accountId,
      [
        {
          kind: MILESTONE_SIGNAL_KIND[milestone.kind],
          detail: `A person at this account ${MILESTONE_LABELS[milestone.kind]}.`,
          previous: null,
          current: `milestone:${milestone.id}`,
          evidenceUrl: milestoneEvidencePath(milestone.id),
          observedAt: new Date(milestone.occurredAt)
        }
      ],
      now
    );
    signalsWritten = written.length;
    await rescoreAccount(db, input.workspaceId, accountId, { now });
  }

  let opportunity: AdvanceOpportunityResult | null = null;
  const minimumStage = MILESTONE_MINIMUM_STAGE[milestone.kind];
  const skipAdoption =
    minimumStage !== null &&
    minimumStage !== 'won' &&
    (await isCustomer(db, input.workspaceId, milestone.contactId));
  if (minimumStage && !skipAdoption) {
    opportunity = await advanceOpportunityStage(
      db,
      {
        workspaceId: input.workspaceId,
        personId: milestone.contactId,
        accountId,
        minimumStage,
        title: await opportunityTitle(
          db,
          input.workspaceId,
          milestone.contactId,
          accountId,
          milestone.kind
        ),
        reason: `milestone:${milestone.kind}`,
        sourceType: 'product_milestone',
        sourceId: milestone.id
      },
      now
    );
  }

  return { milestone, created, signalsWritten, opportunity };
}

export async function listProductMilestones(
  db: Db,
  workspaceId: string,
  limit = 50
): Promise<ProductMilestoneView[]> {
  const rows = await db
    .prepare(
      `SELECT m.*,p.name AS person_name,p.email AS person_email,a.name AS account_name
       FROM product_milestones m
       JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.contact_id
       LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
       WHERE m.workspace_id=?
       ORDER BY m.occurred_at DESC,m.id DESC
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(limit, 200)));
  return rows.map((row) => {
    const milestone = toMilestone(row);
    return {
      ...milestone,
      label: MILESTONE_LABELS[milestone.kind],
      personName: row.person_name ? String(row.person_name) : null,
      personEmail: row.person_email ? String(row.person_email) : null,
      accountName: row.account_name ? String(row.account_name) : null
    };
  });
}
```

In `src/server/lead-capture/http.ts`, add these imports after line 12 (`import { acceptInboundSubmission, payloadHash } from './submissions.js';`):

```ts
import { accountForPerson } from '../person-identities.js';
import { isMilestoneKind } from './milestones.js';
import { recordProductMilestone } from './milestone-recorder.js';
```

Replace line 85:

```ts
await recordCaptureSourceAccepted(db, source.id);
```

with:

```ts
await recordCaptureSourceAccepted(db, source.id);
const kind = result.submission.kind;
if (isMilestoneKind(kind)) {
  // A milestone is an outcome, not inbound to qualify. The submission row
  // stays as provenance and the milestone is recorded against it. This also
  // runs on a duplicate, so a retry heals a crash between the two writes.
  await recordProductMilestone(db, {
    workspaceId: source.workspaceId,
    kind,
    contactId: result.contactId,
    accountId:
      result.accountId ?? (await accountForPerson(db, source.workspaceId, result.contactId)),
    sourceType: 'inbound_submission',
    sourceId: result.submission.id,
    occurredAt: new Date(result.submission.occurredAt ?? result.submission.receivedAt)
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/milestone-recorder.test.ts src/server/lead-capture/lead-capture.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/lead-capture/milestone-recorder.ts src/server/lead-capture/milestone-recorder.test.ts src/server/lead-capture/http.ts
git commit -m "feat(gtm): record product milestones from signed intake" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 5: Today items, and milestones excluded from inbound and demand

**Files:**

- Modify: `src/server/today.ts:1-20,191,746`
- Modify: `src/server/demand/candidates.ts:2,477`
- Modify: `src/client/views/LoopView.tsx:750`
- Test: `src/server/today-milestones.test.ts`

**Interfaces:**

- Consumes:
  - `MILESTONE_KINDS_SQL`, `MILESTONE_LABELS`, `isMilestoneKind`, `milestoneEvidencePath` (Task 1).
  - `recordProductMilestone` (Task 4, used by the test).
  - `acceptInboundSubmission(db, { source, idempotencyKey, body, payloadHash, receivedAt })` and `createCaptureSource` (existing).
- Produces: `TodayItemKind` gains `'milestone_reached'` (`recentResults`, priority 25) and `'customer_cancelled'` (`needsAttention`, priority 55). Both carry `reference: { type: 'product_milestone', id }` and `href: '/outreach/inbound?milestone=<id>'`.

- [ ] **Step 1: Write the failing test**

Create `src/server/today-milestones.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { getToday } from './today.js';
import { buildDemandCandidates } from './demand/candidates.js';
import { createCaptureSource } from './lead-capture/sources.js';
import { acceptInboundSubmission } from './lead-capture/submissions.js';
import { recordProductMilestone } from './lead-capture/milestone-recorder.js';
import { isMilestoneKind } from './lead-capture/milestones.js';
import type { CaptureSourceRecord } from './lead-capture/types.js';

const WS = 'ws_today_milestones';
const USER = 'usr_today_milestones';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let source: CaptureSourceRecord;

async function clearWorkspace(): Promise<void> {
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(WS);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
}

async function submit(kind: string, email: string, key: string): Promise<string> {
  const accepted = await acceptInboundSubmission(db, {
    source,
    idempotencyKey: key,
    body: {
      kind,
      person: { name: 'Ada Lovelace', email },
      company: { domain: 'acme-today.test', name: 'Acme Today' }
    },
    payloadHash: `hash-${key}`,
    receivedAt: NOW
  });
  if (isMilestoneKind(kind))
    await recordProductMilestone(
      db,
      {
        workspaceId: WS,
        kind,
        contactId: accepted.contactId,
        accountId: accepted.accountId,
        sourceType: 'inbound_submission',
        sourceId: accepted.submission.id,
        occurredAt: NOW
      },
      NOW
    );
  return accepted.submission.id;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace();
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WS, 'Today Milestones', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'owner@today-milestones.test', 'Owner', NOW.toISOString());
  source = (
    await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Product',
      kind: 'signup'
    })
  ).source;
});

afterEach(async () => {
  if (db) await clearWorkspace();
  await db?.close();
});

describe('Today and demand treat milestones as outcomes', () => {
  it('reports milestones as results and cancellations as attention, never as inbound', async () => {
    const activated = await submit('activated', 'ada@acme-today.test', 'today-milestone-activated');
    const cancelled = await submit('cancelled', 'ada@acme-today.test', 'today-milestone-cancelled');
    const demo = await submit('demo_request', 'grace@acme-today.test', 'today-milestone-demo');

    const today = await getToday(db, WS, NOW);
    const inbound = today.needsAttention
      .filter((item) => item.kind === 'inbound_submission')
      .map((item) => item.reference.id);
    expect(inbound).toContain(demo);
    expect(inbound).not.toContain(activated);
    expect(inbound).not.toContain(cancelled);

    const result = today.recentResults.find((item) => item.kind === 'milestone_reached');
    expect(result).toMatchObject({
      title: 'Acme Today activated',
      priority: 25,
      reference: { type: 'product_milestone' }
    });
    expect(result?.href).toMatch(/^\/outreach\/inbound\?milestone=pm_[a-f0-9]{16}$/);

    const attention = today.needsAttention.find((item) => item.kind === 'customer_cancelled');
    expect(attention).toMatchObject({
      title: 'Acme Today cancelled',
      priority: 55,
      reference: { type: 'product_milestone' }
    });
  });

  it('never turns a milestone submission into demand evidence', async () => {
    const activated = await submit(
      'activated',
      'ada@acme-today.test',
      'demand-milestone-activated'
    );
    const paid = await submit('paid', 'ada@acme-today.test', 'demand-milestone-paid');
    const candidates = await buildDemandCandidates(db, WS, NOW);
    const evidenceIds = candidates
      .flatMap((candidate) => candidate.evidence)
      .filter((evidence) => evidence.sourceType === 'inbound_submission')
      .map((evidence) => evidence.sourceId);
    expect(evidenceIds).not.toContain(activated);
    expect(evidenceIds).not.toContain(paid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today-milestones.test.ts`
Expected: FAIL. `inbound` contains the `activated` submission id, and no `milestone_reached` item exists.

- [ ] **Step 3: Write the implementation**

In `src/server/today.ts`, add after line 3 (`import type { LinkedInCheckName } from './linkedin/guard.js';`):

```ts
import {
  MILESTONE_KINDS_SQL,
  MILESTONE_LABELS,
  isMilestoneKind,
  milestoneEvidencePath
} from './lead-capture/milestones.js';
```

Replace lines 19-20:

```ts
  | 'verified_reply_result'
  | 'opportunity_closed';
```

with:

```ts
  | 'verified_reply_result'
  | 'opportunity_closed'
  | 'milestone_reached'
  | 'customer_cancelled';
```

In the `inboundRows` query, replace line 191:

```ts
         WHERE i.workspace_id=? AND i.received_at>=?::timestamptz
```

with:

```ts
         WHERE i.workspace_id=? AND i.received_at>=?::timestamptz
           AND i.kind NOT IN ${MILESTONE_KINDS_SQL}
```

Immediately before the final `return {` of `getToday` (line 746), insert:

```ts
// Product milestones are first-party outcomes, not inbound to qualify: the
// NOT IN above keeps them out of the inbound class. A cancellation needs a
// human before any outreach; everything else is a result.
const milestoneRows = await db
  .prepare(
    `SELECT m.id,m.kind,m.contact_id,m.account_id,m.source_type,m.occurred_at,m.created_at,
              p.name AS person_name,p.email AS person_email,a.name AS account_name
       FROM product_milestones m
       JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.contact_id
       LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
       WHERE m.workspace_id=? AND m.created_at>=?::timestamptz
       ORDER BY m.created_at DESC,m.id DESC LIMIT 50`
  )
  .all<Record<string, unknown>>(workspaceId, recentSince);

for (const row of milestoneRows) {
  const kind = String(row.kind);
  if (!isMilestoneKind(kind)) continue;
  const who =
    String(row.account_name ?? '').trim() ||
    String(row.person_name ?? '').trim() ||
    String(row.person_email ?? '').trim() ||
    'A customer';
  const fromStripe = String(row.source_type) === 'stripe_event';
  const shared = {
    href: milestoneEvidencePath(String(row.id)),
    observedAt: iso(row.occurred_at ?? row.created_at, now),
    reference: { type: 'product_milestone', id: String(row.id) },
    metadata: {
      milestoneKind: kind,
      sourceType: String(row.source_type ?? ''),
      personId: String(row.contact_id ?? ''),
      accountId: row.account_id ? String(row.account_id) : null
    }
  };
  if (kind === 'cancelled') {
    items.push({
      id: `customer-cancelled:${String(row.id)}`,
      kind: 'customer_cancelled',
      priority: 55,
      title: `${who} cancelled`,
      detail: fromStripe
        ? 'Stripe reported the subscription ended. Review the account before any outreach.'
        : 'Your product reported a cancellation. Review the account before any outreach.',
      ...shared
    });
  } else {
    recentResults.push({
      id: `milestone:${String(row.id)}`,
      kind: 'milestone_reached',
      priority: 25,
      title: `${who} ${MILESTONE_LABELS[kind]}`,
      detail: fromStripe ? 'Observed from Stripe.' : 'Reported by your product.',
      ...shared
    });
  }
}
```

In `src/server/demand/candidates.ts`, add after line 2 (`import { isHighIntentInboundKind } from './opportunities.js';`):

```ts
import { MILESTONE_KINDS_SQL } from '../lead-capture/milestones.js';
```

In `buildDemandCandidates`, replace:

```ts
      WHERE s.workspace_id=?
        AND s.account_id IS NOT NULL
        AND s.received_at>=?::timestamptz
```

with:

```ts
      WHERE s.workspace_id=?
        AND s.account_id IS NOT NULL
        AND s.received_at>=?::timestamptz
        AND s.kind NOT IN ${MILESTONE_KINDS_SQL}
```

In `src/client/views/LoopView.tsx`, after line 750 (`if (item.kind === 'inbound_submission') return 'Review inbound';`), add:

```ts
if (item.kind === 'customer_cancelled') return 'Review customer';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today-milestones.test.ts src/server/today.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/today.ts src/server/today-milestones.test.ts src/server/demand/candidates.ts src/client/views/LoopView.tsx
git commit -m "feat(gtm): surface milestones in Today, not as inbound" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 6: Generic provider-webhook module and secret custody (contract 2)

**Files:**

- Create: `src/server/provider-webhooks/types.ts`
- Create: `src/server/provider-webhooks/registry.ts`
- Create: `src/server/provider-webhooks/store.ts`
- Create: `src/server/provider-webhooks/http.ts`
- Create: `src/server/provider-webhooks/index.ts`
- Modify: `src/server/secrets/crypto.ts:222-227`
- Modify: `src/server/secrets/custody.ts:156-161,316-336,338-385,387-451`
- Test: `src/server/provider-webhooks/provider-webhooks.test.ts`

**Interfaces:**

- Consumes: table `provider_webhook_endpoints` (Task 1); `sealSecret`, `openSecret`, `secretsConfigured`, `SecretContext` from `src/server/secrets/crypto.ts`; `appendDomainEvent`; the `webhook_events` table (migrations 001 and 058).
- Produces (all re-exported from `src/server/provider-webhooks/index.ts`; Phase B registers a Cal.com verifier against these):

```ts
export const WEBHOOK_PROVIDERS: readonly ['stripe', 'calcom'];
export type WebhookProvider = 'stripe' | 'calcom';
export function isWebhookProvider(value: unknown): value is WebhookProvider;
export interface ProviderWebhookEndpoint {
  id: string;
  workspaceId: string;
  provider: WebhookProvider;
  status: 'active' | 'disabled';
  createdByUserId: string | null;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}
export type WebhookHeaders = Record<string, string | string[] | undefined>;
export type ProviderWebhookVerification =
  | { ok: true; eventId: string; eventType: string; payload: unknown }
  | { ok: false; status: number; error: string };
export interface ProviderWebhookEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
}
export interface ProviderWebhookVerifier {
  provider: WebhookProvider;
  secretPattern?: RegExp;
  verify(
    rawBody: Buffer,
    headers: WebhookHeaders,
    secret: string,
    now: Date
  ): ProviderWebhookVerification;
  handle(
    db: Db,
    endpoint: ProviderWebhookEndpoint,
    event: ProviderWebhookEvent,
    now: Date
  ): Promise<{ handled: boolean }>;
}
export class ProviderWebhookError extends Error {
  status: number;
}
export function registerProviderVerifier(verifier: ProviderWebhookVerifier): void;
export function getProviderVerifier(provider: string): ProviderWebhookVerifier | null;
export function registeredWebhookProviders(): WebhookProvider[];
export function draftProviderWebhookEndpointId(): string; // 'pwh_' + 24 hex
export function isProviderWebhookEndpointId(value: string): boolean;
export function providerWebhookPath(provider: WebhookProvider, endpointId: string): string; // /api/hooks/v1/:provider/:endpointId
export function withProviderWebhookPath(
  endpoint: ProviderWebhookEndpoint
): ProviderWebhookEndpoint & { path: string };
export async function createProviderWebhookEndpoint(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string | null;
    provider: WebhookProvider;
    signingSecret: string;
    endpointId?: string;
  },
  now?: Date
): Promise<ProviderWebhookEndpoint>;
export async function getProviderWebhookEndpointById(
  db: Db,
  endpointId: string
): Promise<ProviderWebhookEndpoint | null>;
export async function listProviderWebhookEndpoints(
  db: Db,
  workspaceId: string
): Promise<ProviderWebhookEndpoint[]>;
export async function setProviderWebhookEndpointStatus(
  db: Db,
  input: {
    workspaceId: string;
    endpointId: string;
    status: 'active' | 'disabled';
    actorUserId: string | null;
  },
  now?: Date
): Promise<ProviderWebhookEndpoint | null>;
export async function deleteProviderWebhookEndpoint(
  db: Db,
  input: { workspaceId: string; endpointId: string; actorUserId: string | null }
): Promise<boolean>;
export async function readProviderWebhookSecret(
  db: Db,
  endpoint: Pick<ProviderWebhookEndpoint, 'id' | 'workspaceId' | 'provider'>
): Promise<string | null>;
export function registerProviderWebhookRoutes(
  app: Express,
  db: Db,
  options?: { now?: () => Date }
): void;
```

- [ ] **Step 1: Write the failing test**

Create `src/server/provider-webhooks/provider-webhooks.test.ts`:

```ts
import { createHmac, randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { resealSecrets, secretsCustodyReport } from '../secrets/custody.js';
import {
  ProviderWebhookError,
  createProviderWebhookEndpoint,
  draftProviderWebhookEndpointId,
  getProviderWebhookEndpointById,
  registerProviderVerifier,
  registerProviderWebhookRoutes,
  setProviderWebhookEndpointStatus,
  type ProviderWebhookEndpoint,
  type ProviderWebhookVerifier
} from './index.js';

const WS = 'ws_provider_hooks';
const OTHER = 'ws_provider_hooks_other';
const USER = 'usr_provider_hooks';
const OTHER_USER = 'usr_provider_hooks_other';
const SECRET = `test_${randomBytes(16).toString('hex')}`;
const handled: string[] = [];

// A stand-in verifier on the 'calcom' slot: HMAC of the raw body.
const fakeVerifier: ProviderWebhookVerifier = {
  provider: 'calcom',
  verify(rawBody, headers, secret) {
    const signature = String(headers['x-test-signature'] ?? '');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (signature !== expected) return { ok: false, status: 400, error: 'Invalid test signature' };
    const payload = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string };
    return { ok: true, eventId: payload.id, eventType: payload.type, payload };
  },
  async handle(_db, _endpoint, event) {
    handled.push(event.eventId);
    if (event.eventType === 'boom') throw new Error('handler exploded');
    return { handled: event.eventType !== 'ignored' };
  }
};

let db: Db;
let app: Express;
let endpoint: ProviderWebhookEndpoint;

function deliver(
  endpointId: string,
  body: { id: string; type: string },
  secret = SECRET,
  provider = 'calcom'
) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(`/api/hooks/v1/${provider}/${endpointId}`)
    .set('Content-Type', 'application/json')
    .set('X-Test-Signature', createHmac('sha256', secret).update(raw).digest('hex'))
    .send(raw);
}

async function counts(endpointId: string) {
  const row = await getProviderWebhookEndpointById(db, endpointId);
  return { accepted: row!.acceptedCount, rejected: row!.rejectedCount };
}

async function eventStatus(eventId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT status FROM webhook_events
       WHERE workspace_id=? AND provider='hook:calcom' AND external_event_id=?`
    )
    .get<{ status: string }>(WS, `${endpoint.id}:${eventId}`);
  return row?.status ?? null;
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const [workspaceId, userId] of [
    [WS, USER],
    [OTHER, OTHER_USER]
  ]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, new Date().toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@hooks.test`, userId, new Date().toISOString());
  }
  registerProviderVerifier(fakeVerifier);
  endpoint = await createProviderWebhookEndpoint(db, {
    workspaceId: WS,
    actorUserId: USER,
    provider: 'calcom',
    signingSecret: SECRET
  });
  app = express();
  registerProviderWebhookRoutes(app, db);
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });
});

beforeEach(() => {
  handled.length = 0;
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  await db?.close();
});

describe('provider webhook endpoint route', () => {
  it('verifies, handles once, and answers a redelivery as a duplicate', async () => {
    const first = await deliver(endpoint.id, { id: 'evt_ok_1', type: 'ok' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, handled: true });
    const again = await deliver(endpoint.id, { id: 'evt_ok_1', type: 'ok' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(handled).toEqual(['evt_ok_1']);
    expect(await eventStatus('evt_ok_1')).toBe('processed');

    const ignored = await deliver(endpoint.id, { id: 'evt_ignored_1', type: 'ignored' });
    expect(ignored.body).toEqual({ received: true, handled: false });
    expect(await eventStatus('evt_ignored_1')).toBe('ignored');
  });

  it('rejects a bad signature and a paused endpoint, counts both, and writes nothing', async () => {
    const before = await counts(endpoint.id);
    const forged = await deliver(endpoint.id, { id: 'evt_forged', type: 'ok' }, 'wrong-secret');
    expect(forged.status).toBe(400);

    await setProviderWebhookEndpointStatus(db, {
      workspaceId: WS,
      endpointId: endpoint.id,
      status: 'disabled',
      actorUserId: USER
    });
    const paused = await deliver(endpoint.id, { id: 'evt_paused', type: 'ok' });
    expect(paused.status).toBe(403);
    await setProviderWebhookEndpointStatus(db, {
      workspaceId: WS,
      endpointId: endpoint.id,
      status: 'active',
      actorUserId: USER
    });

    expect(await counts(endpoint.id)).toEqual({
      accepted: before.accepted,
      rejected: before.rejected + 2
    });
    expect(handled).toEqual([]);
    expect(await eventStatus('evt_forged')).toBeNull();
    expect(await eventStatus('evt_paused')).toBeNull();
  });

  it('marks a handler failure failed and lets the provider retry it', async () => {
    const failed = await deliver(endpoint.id, { id: 'evt_boom', type: 'boom' });
    expect(failed.status).toBe(500);
    expect(await eventStatus('evt_boom')).toBe('failed');
    const error = await db
      .prepare(`SELECT error FROM webhook_events WHERE workspace_id=? AND external_event_id=?`)
      .get<{ error: string }>(WS, `${endpoint.id}:evt_boom`);
    expect(error?.error).toBe('Error');
    const retried = await deliver(endpoint.id, { id: 'evt_boom', type: 'boom' });
    expect(retried.status).toBe(500);
    expect(handled).toEqual(['evt_boom', 'evt_boom']);
  });

  it('answers 404 for an unknown endpoint or a provider that does not match', async () => {
    expect(
      (await deliver(draftProviderWebhookEndpointId(), { id: 'evt_x', type: 'ok' })).status
    ).toBe(404);
    expect((await deliver('not-an-endpoint', { id: 'evt_x', type: 'ok' })).status).toBe(404);
    expect((await deliver(endpoint.id, { id: 'evt_x', type: 'ok' }, SECRET, 'stripe')).status).toBe(
      404
    );
    expect(handled).toEqual([]);
  });
});

describe('provider webhook endpoint store', () => {
  it('creates endpoints idempotently and never across workspaces', async () => {
    const endpointId = draftProviderWebhookEndpointId();
    const created = await createProviderWebhookEndpoint(db, {
      workspaceId: WS,
      actorUserId: USER,
      provider: 'calcom',
      signingSecret: SECRET,
      endpointId
    });
    const repeated = await createProviderWebhookEndpoint(db, {
      workspaceId: WS,
      actorUserId: USER,
      provider: 'calcom',
      signingSecret: SECRET,
      endpointId
    });
    expect(repeated.id).toBe(created.id);
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: WS,
        actorUserId: USER,
        provider: 'calcom',
        signingSecret: `${SECRET}-different`,
        endpointId
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: OTHER,
        actorUserId: OTHER_USER,
        provider: 'calcom',
        signingSecret: SECRET,
        endpointId
      })
    ).rejects.toBeInstanceOf(ProviderWebhookError);
    expect((await getProviderWebhookEndpointById(db, endpointId))?.workspaceId).toBe(WS);
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: WS,
        actorUserId: USER,
        provider: 'calcom',
        signingSecret: SECRET,
        endpointId: 'pwh_not-valid'
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to store a secret without secret custody', async () => {
    const saved = process.env.TREVRA_SECRETS_KEY;
    delete process.env.TREVRA_SECRETS_KEY;
    try {
      await expect(
        createProviderWebhookEndpoint(db, {
          workspaceId: WS,
          actorUserId: USER,
          provider: 'calcom',
          signingSecret: SECRET
        })
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      process.env.TREVRA_SECRETS_KEY = saved;
    }
  });

  // Keep last: it re-seals every endpoint secret under a new deployment key.
  it('includes webhook signing secrets in key-rotation custody', async () => {
    const oldKey = process.env.TREVRA_SECRETS_KEY!;
    const nextKey = randomBytes(32).toString('base64');
    const env = {
      ...process.env,
      TREVRA_SECRETS_KEY: nextKey,
      TREVRA_SECRETS_KEY_PREVIOUS: oldKey
    };
    const before = await secretsCustodyReport(db, env, { workspaceId: WS });
    expect(before.outstanding.some((row) => row.store === 'provider_webhook_endpoints')).toBe(true);
    const resealed = await resealSecrets(db, { env, workspaceId: WS });
    expect(resealed.resealed).toBeGreaterThan(0);
    expect((await secretsCustodyReport(db, env, { workspaceId: WS })).complete).toBe(true);
    process.env.TREVRA_SECRETS_KEY = nextKey;
    try {
      const delivered = await deliver(endpoint.id, { id: 'evt_after_rotation', type: 'ok' });
      expect(delivered.status).toBe(200);
    } finally {
      process.env.TREVRA_SECRETS_KEY = oldKey;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/provider-webhooks.test.ts`
Expected: FAIL with `Cannot find module './index.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/provider-webhooks/types.ts`:

```ts
import type { Db } from '../db.js';

/** Providers with an observe-only inbound webhook. Migration 130 CHECKs this list. */
export const WEBHOOK_PROVIDERS = ['stripe', 'calcom'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && (WEBHOOK_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderWebhookEndpoint {
  id: string;
  workspaceId: string;
  provider: WebhookProvider;
  status: 'active' | 'disabled';
  createdByUserId: string | null;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type ProviderWebhookVerification =
  | { ok: true; eventId: string; eventType: string; payload: unknown }
  | { ok: false; status: number; error: string };

export interface ProviderWebhookEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
}

/**
 * One provider's half of an inbound webhook. `verify` sees the exact raw bytes
 * and must not touch the database; `handle` runs only after verification and
 * after the event was claimed in `webhook_events`, and must be idempotent.
 */
export interface ProviderWebhookVerifier {
  provider: WebhookProvider;
  /** Shape check for the secret an owner pastes, so a typo fails at setup. */
  secretPattern?: RegExp;
  verify(
    rawBody: Buffer,
    headers: WebhookHeaders,
    secret: string,
    now: Date
  ): ProviderWebhookVerification;
  handle(
    db: Db,
    endpoint: ProviderWebhookEndpoint,
    event: ProviderWebhookEvent,
    now: Date
  ): Promise<{ handled: boolean }>;
}

export class ProviderWebhookError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}
```

Create `src/server/provider-webhooks/registry.ts`:

```ts
import { isWebhookProvider, type ProviderWebhookVerifier, type WebhookProvider } from './types.js';

// Process-wide registry. `createApp` registers each verifier once at boot;
// registering the same provider again replaces it (tests rely on this).
const verifiers = new Map<WebhookProvider, ProviderWebhookVerifier>();

export function registerProviderVerifier(verifier: ProviderWebhookVerifier): void {
  verifiers.set(verifier.provider, verifier);
}

export function getProviderVerifier(provider: string): ProviderWebhookVerifier | null {
  return isWebhookProvider(provider) ? (verifiers.get(provider) ?? null) : null;
}

export function registeredWebhookProviders(): WebhookProvider[] {
  return [...verifiers.keys()].sort();
}
```

Create `src/server/provider-webhooks/store.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import {
  openSecret,
  sealSecret,
  secretsConfigured,
  type SecretContext
} from '../secrets/crypto.js';
import { getProviderVerifier } from './registry.js';
import {
  ProviderWebhookError,
  isWebhookProvider,
  type ProviderWebhookEndpoint,
  type WebhookProvider
} from './types.js';

const ENDPOINT_ID_RE = /^pwh_[a-f0-9]{24}$/;
const MAX_SECRET_LENGTH = 500;
const COLUMNS =
  'id,workspace_id,provider,status,created_by_user_id,last_seen_at,accepted_count,rejected_count,created_at,updated_at';

/** Unguessable, but not the credential: the sealed signing secret is. */
export function draftProviderWebhookEndpointId(): string {
  return `pwh_${randomBytes(12).toString('hex')}`;
}

export function isProviderWebhookEndpointId(value: string): boolean {
  return ENDPOINT_ID_RE.test(value);
}

export function providerWebhookPath(provider: WebhookProvider, endpointId: string): string {
  return `/api/hooks/v1/${provider}/${endpointId}`;
}

export function withProviderWebhookPath(
  endpoint: ProviderWebhookEndpoint
): ProviderWebhookEndpoint & { path: string } {
  return { ...endpoint, path: providerWebhookPath(endpoint.provider, endpoint.id) };
}

export function providerWebhookSecretContext(
  workspaceId: string,
  endpointId: string,
  provider: WebhookProvider
): SecretContext {
  return { store: 'provider_webhook_endpoints', workspaceId, seatKey: endpointId, kind: provider };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(String(value)).toISOString();
}

function toEndpoint(row: Record<string, unknown>): ProviderWebhookEndpoint {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: String(row.provider) as WebhookProvider,
    status: String(row.status) === 'active' ? 'active' : 'disabled',
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    lastSeenAt: iso(row.last_seen_at),
    acceptedCount: Number(row.accepted_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export async function readProviderWebhookSecret(
  db: Db,
  endpoint: Pick<ProviderWebhookEndpoint, 'id' | 'workspaceId' | 'provider'>
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT secret_ciphertext,secret_iv,secret_auth_tag,secret_key_version,secret_key_id
       FROM provider_webhook_endpoints WHERE workspace_id=? AND id=?`
    )
    .get<Record<string, unknown>>(endpoint.workspaceId, endpoint.id);
  if (!row) return null;
  return openSecret(
    {
      ciphertext: Buffer.from(row.secret_ciphertext as Buffer),
      iv: Buffer.from(row.secret_iv as Buffer),
      authTag: Buffer.from(row.secret_auth_tag as Buffer),
      keyVersion: Number(row.secret_key_version),
      keyId: row.secret_key_id ? String(row.secret_key_id) : null
    },
    providerWebhookSecretContext(endpoint.workspaceId, endpoint.id, endpoint.provider)
  );
}

/**
 * Store an endpoint and its sealed signing secret. Idempotent on `endpointId`:
 * the same workspace, provider and secret returns the existing endpoint; any
 * other combination is a 409, so an id can never be claimed across workspaces.
 */
export async function createProviderWebhookEndpoint(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string | null;
    provider: WebhookProvider;
    signingSecret: string;
    endpointId?: string;
  },
  now: Date = new Date()
): Promise<ProviderWebhookEndpoint> {
  if (!secretsConfigured())
    throw new ProviderWebhookError(
      'Webhook signing secrets need TREVRA_SECRETS_KEY on this deployment. Configure secret custody first.',
      409
    );
  if (!isWebhookProvider(input.provider))
    throw new ProviderWebhookError('Unknown webhook provider.', 400);
  const verifier = getProviderVerifier(input.provider);
  if (!verifier)
    throw new ProviderWebhookError(
      `${input.provider} webhooks are not available on this deployment.`,
      400
    );
  const secret = input.signingSecret.trim();
  if (!secret || secret.length > MAX_SECRET_LENGTH)
    throw new ProviderWebhookError('A signing secret is required.', 400);
  if (verifier.secretPattern && !verifier.secretPattern.test(secret))
    throw new ProviderWebhookError("That does not look like this provider's signing secret.", 400);
  const endpointId = input.endpointId?.trim() || draftProviderWebhookEndpointId();
  if (!isProviderWebhookEndpointId(endpointId))
    throw new ProviderWebhookError('Invalid webhook endpoint id.', 400);

  const sealed = sealSecret(
    secret,
    providerWebhookSecretContext(input.workspaceId, endpointId, input.provider)
  );
  const at = now.toISOString();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .prepare(
        `INSERT INTO provider_webhook_endpoints (
           id,workspace_id,provider,status,secret_ciphertext,secret_iv,secret_auth_tag,
           secret_key_version,secret_key_id,created_by_user_id,created_at,updated_at
         ) VALUES (?,?,?,'active',?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLUMNS}`
      )
      .get<Record<string, unknown>>(
        endpointId,
        input.workspaceId,
        input.provider,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.keyVersion,
        sealed.keyId,
        input.actorUserId,
        at,
        at
      );
    if (inserted) {
      await appendDomainEvent(tx, {
        workspaceId: input.workspaceId,
        streamType: 'provider_webhook_endpoint',
        streamId: endpointId,
        eventType: 'provider_webhook_endpoint.created',
        actorType: 'human',
        actorId: input.actorUserId,
        payload: { provider: input.provider }
      });
      return toEndpoint(inserted);
    }
    const existing = await tx
      .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE id=?`)
      .get<Record<string, unknown>>(endpointId);
    if (
      !existing ||
      String(existing.workspace_id) !== input.workspaceId ||
      String(existing.provider) !== input.provider
    )
      throw new ProviderWebhookError('This webhook endpoint id is already in use.', 409);
    const endpoint = toEndpoint(existing);
    if ((await readProviderWebhookSecret(tx, endpoint)) !== secret)
      throw new ProviderWebhookError(
        'This endpoint already has a different signing secret. Remove it and connect again.',
        409
      );
    return endpoint;
  });
}

/** Global lookup by URL id: only the inbound route uses it, to decide the workspace. */
export async function getProviderWebhookEndpointById(
  db: Db,
  endpointId: string
): Promise<ProviderWebhookEndpoint | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE id=?`)
    .get<Record<string, unknown>>(endpointId);
  return row ? toEndpoint(row) : null;
}

export async function listProviderWebhookEndpoints(
  db: Db,
  workspaceId: string
): Promise<ProviderWebhookEndpoint[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM provider_webhook_endpoints
       WHERE workspace_id=? ORDER BY created_at DESC,id DESC`
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(toEndpoint);
}

export async function setProviderWebhookEndpointStatus(
  db: Db,
  input: {
    workspaceId: string;
    endpointId: string;
    status: 'active' | 'disabled';
    actorUserId: string | null;
  },
  now: Date = new Date()
): Promise<ProviderWebhookEndpoint | null> {
  return db.transaction(async (tx) => {
    const changed = await tx
      .prepare(
        `UPDATE provider_webhook_endpoints SET status=?,updated_at=?
         WHERE workspace_id=? AND id=? AND status<>?
         RETURNING ${COLUMNS}`
      )
      .get<Record<string, unknown>>(
        input.status,
        now.toISOString(),
        input.workspaceId,
        input.endpointId,
        input.status
      );
    if (changed) {
      await appendDomainEvent(tx, {
        workspaceId: input.workspaceId,
        streamType: 'provider_webhook_endpoint',
        streamId: input.endpointId,
        eventType: 'provider_webhook_endpoint.status_changed',
        actorType: 'human',
        actorId: input.actorUserId,
        payload: { status: input.status }
      });
      return toEndpoint(changed);
    }
    const current = await tx
      .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE workspace_id=? AND id=?`)
      .get<Record<string, unknown>>(input.workspaceId, input.endpointId);
    return current ? toEndpoint(current) : null;
  });
}

/** The closer for this state. Idempotent: removing a missing endpoint is a no-op. */
export async function deleteProviderWebhookEndpoint(
  db: Db,
  input: { workspaceId: string; endpointId: string; actorUserId: string | null }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .prepare(
        'DELETE FROM provider_webhook_endpoints WHERE workspace_id=? AND id=? RETURNING id,provider'
      )
      .get<{ id: string; provider: string }>(input.workspaceId, input.endpointId);
    if (!removed) return false;
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'provider_webhook_endpoint',
      streamId: input.endpointId,
      eventType: 'provider_webhook_endpoint.removed',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: { provider: removed.provider }
    });
    return true;
  });
}

export async function recordProviderWebhookAccepted(
  db: Db,
  endpointId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE provider_webhook_endpoints SET accepted_count=accepted_count+1,last_seen_at=? WHERE id=?'
    )
    .run(now.toISOString(), endpointId);
}

export async function recordProviderWebhookRejected(
  db: Db,
  endpointId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE provider_webhook_endpoints SET rejected_count=rejected_count+1,last_seen_at=? WHERE id=?'
    )
    .run(now.toISOString(), endpointId);
}
```

Create `src/server/provider-webhooks/http.ts`:

```ts
import { createHash } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { id, type Db } from '../db.js';
import { getProviderVerifier } from './registry.js';
import {
  getProviderWebhookEndpointById,
  isProviderWebhookEndpointId,
  readProviderWebhookSecret,
  recordProviderWebhookAccepted,
  recordProviderWebhookRejected
} from './store.js';
import type { ProviderWebhookEndpoint } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Claim the event in `webhook_events` (migration 058 index). A row already
 * processed or ignored is a duplicate; a row left `received` or `failed` is
 * re-run, which is safe because every handler is idempotent.
 */
async function claimWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  rawBody: Buffer,
  now: Date
): Promise<'claimed' | 'done'> {
  const provider = `hook:${endpoint.provider}`;
  const externalEventId = `${endpoint.id}:${eventId}`;
  const inserted = await db
    .prepare(
      `INSERT INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at)
       VALUES (?,?,?,?,?,'received',?)
       ON CONFLICT (COALESCE(workspace_id,'@unresolved'),provider,external_event_id) DO NOTHING`
    )
    .run(
      id('webhook'),
      provider,
      externalEventId,
      endpoint.workspaceId,
      createHash('sha256').update(rawBody).digest('hex'),
      now.toISOString()
    );
  if (inserted.changes > 0) return 'claimed';
  const prior = await db
    .prepare(
      'SELECT status FROM webhook_events WHERE workspace_id=? AND provider=? AND external_event_id=?'
    )
    .get<{ status: string }>(endpoint.workspaceId, provider, externalEventId);
  return prior && (prior.status === 'processed' || prior.status === 'ignored') ? 'done' : 'claimed';
}

async function finishWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  error: string | null,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_events SET status=?,error=?,processed_at=?
       WHERE workspace_id=? AND provider=? AND external_event_id=?`
    )
    .run(
      status,
      error,
      now.toISOString(),
      endpoint.workspaceId,
      `hook:${endpoint.provider}`,
      `${endpoint.id}:${eventId}`
    );
}

async function handleDelivery(db: Db, req: Request, res: Response, now: Date): Promise<void> {
  const provider = String(req.params.provider ?? '');
  const endpointId = String(req.params.endpointId ?? '');
  const verifier = getProviderVerifier(provider);
  const endpoint =
    verifier && isProviderWebhookEndpointId(endpointId)
      ? await getProviderWebhookEndpointById(db, endpointId)
      : null;
  if (!verifier || !endpoint || endpoint.provider !== provider) {
    res.status(404).json({ error: 'Webhook endpoint not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordProviderWebhookRejected(db, endpoint.id, now);
    res.status(status).json({ error: message });
  };
  if (endpoint.status !== 'active') return void (await reject(403, 'Webhook endpoint is paused'));

  let secret: string | null = null;
  try {
    secret = await readProviderWebhookSecret(db, endpoint);
  } catch {
    secret = null;
  }
  if (!secret) return void (await reject(503, 'Webhook endpoint secret is unavailable'));

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const verified = verifier.verify(rawBody, req.headers, secret, now);
  if (!verified.ok) return void (await reject(verified.status, verified.error));
  if (!EVENT_ID_RE.test(verified.eventId))
    return void (await reject(400, 'Webhook event id is invalid'));
  await recordProviderWebhookAccepted(db, endpoint.id, now);

  if ((await claimWebhookEvent(db, endpoint, verified.eventId, rawBody, now)) === 'done') {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }
  try {
    const outcome = await verifier.handle(
      db,
      endpoint,
      { eventId: verified.eventId, eventType: verified.eventType, payload: verified.payload },
      now
    );
    await finishWebhookEvent(
      db,
      endpoint,
      verified.eventId,
      outcome.handled ? 'processed' : 'ignored',
      null,
      now
    );
    res.status(200).json({ received: true, handled: outcome.handled });
  } catch (error) {
    // Only the error class is stored: messages can carry identifiers or content.
    await finishWebhookEvent(
      db,
      endpoint,
      verified.eventId,
      'failed',
      error instanceof Error ? error.name.slice(0, 120) : 'Error',
      now
    );
    throw error;
  }
}

/**
 * POST /api/hooks/v1/:provider/:endpointId
 *
 * Register BEFORE the global JSON parser: verifiers sign the exact raw bytes.
 * The endpoint id in the URL decides the workspace; nothing in the payload can.
 * A 5xx makes the provider retry; every handler is idempotent.
 */
export function registerProviderWebhookRoutes(
  app: Express,
  db: Db,
  options: { now?: () => Date } = {}
): void {
  const clock = options.now ?? (() => new Date());
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    // Keyed by endpoint, never by IP: providers deliver from shared address
    // pools, and one endpoint must never spend another endpoint's quota.
    keyGenerator: (req) =>
      `${String(req.params.provider ?? '')}:${String(req.params.endpointId ?? '')}`,
    message: { error: 'Too many webhook deliveries. The provider will retry.' }
  });

  app.post(
    '/api/hooks/v1/:provider/:endpointId',
    limiter,
    express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleDelivery(db, req, res, clock());
      } catch (error) {
        next(error);
      }
    }
  );
}
```

Create `src/server/provider-webhooks/index.ts`:

```ts
export * from './types.js';
export {
  getProviderVerifier,
  registerProviderVerifier,
  registeredWebhookProviders
} from './registry.js';
export {
  createProviderWebhookEndpoint,
  deleteProviderWebhookEndpoint,
  draftProviderWebhookEndpointId,
  getProviderWebhookEndpointById,
  isProviderWebhookEndpointId,
  listProviderWebhookEndpoints,
  providerWebhookPath,
  providerWebhookSecretContext,
  readProviderWebhookSecret,
  setProviderWebhookEndpointStatus,
  withProviderWebhookPath
} from './store.js';
export { registerProviderWebhookRoutes } from './http.js';
```

In `src/server/secrets/crypto.ts`, replace lines 226-227:

```ts
  | 'linkedin_seat_proxy_secrets'
  | 'capture_source_secrets';
```

with:

```ts
  | 'linkedin_seat_proxy_secrets'
  | 'capture_source_secrets'
  | 'provider_webhook_endpoints';
```

In `src/server/secrets/custody.ts`:

1. After the `CAPTURE_SOURCE_SECRET_ROWS` constant (ends line 161), add:

```ts
const PROVIDER_WEBHOOK_SECRET_ROWS = `
  SELECT id, workspace_id, id AS seat_key, provider AS kind,
         secret_key_version AS key_version, secret_key_id AS key_id
  FROM provider_webhook_endpoints
  WHERE (?::text IS NULL OR workspace_id = ?::text)
  ORDER BY workspace_id, id
`;
```

2. In `contextFor`, before the final `return seatCredentialContext(`, add:

```ts
if (row.store === 'provider_webhook_endpoints') {
  return {
    store: 'provider_webhook_endpoints',
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    kind: row.kind
  };
}
```

3. In `loadCustodyRows`, change the destructuring line
   `const [workspaceRows, seatRows, proxyRows, captureRows] = await Promise.all([`
   to
   `const [workspaceRows, seatRows, proxyRows, captureRows, webhookRows] = await Promise.all([`.

   Then replace the closing of the capture query and the `Promise.all` array:

```ts
    db.prepare(CAPTURE_SOURCE_SECRET_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope)
  ]);
```

with:

```ts
    db.prepare(CAPTURE_SOURCE_SECRET_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope),
    db.prepare(PROVIDER_WEBHOOK_SECRET_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope)
  ]);
```

and replace

```ts
    ...captureRows.map((row) => ({ store: 'capture_source_secrets' as const, ...row }))
  ];
```

with:

```ts
    ...captureRows.map((row) => ({ store: 'capture_source_secrets' as const, ...row })),
    ...webhookRows.map((row) => ({ store: 'provider_webhook_endpoints' as const, ...row }))
  ];
```

4. Replace the whole `readSealed` and `writeSealed` functions (lines 387-427) with:

```ts
/**
 * Sealed-envelope column names. `provider_webhook_endpoints` prefixes them with
 * `secret_` because that row IS the endpoint, not a secret slot. The prefix comes
 * from the closed `SecretStore` union, never from input.
 */
function sealedColumns(store: SecretStore) {
  const prefix = store === 'provider_webhook_endpoints' ? 'secret_' : '';
  return {
    ciphertext: `${prefix}ciphertext`,
    iv: `${prefix}iv`,
    authTag: `${prefix}auth_tag`,
    keyVersion: `${prefix}key_version`,
    keyId: `${prefix}key_id`
  };
}

async function readSealed(db: Db, row: CustodyRowData) {
  const c = sealedColumns(row.store);
  const stored = await db
    .prepare(
      `SELECT ${c.ciphertext} AS ciphertext, ${c.iv} AS iv, ${c.authTag} AS auth_tag,
              ${c.keyVersion} AS key_version, ${c.keyId} AS key_id
       FROM ${table(row.store)} WHERE id=?`
    )
    .get<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      key_version: number;
      key_id: string | null;
    }>(row.id);
  if (!stored) return null;
  return {
    ciphertext: stored.ciphertext,
    iv: stored.iv,
    authTag: stored.auth_tag,
    keyVersion: Number(stored.key_version),
    keyId: stored.key_id == null ? null : String(stored.key_id)
  };
}

async function writeSealed(
  db: Db,
  row: CustodyRowData,
  sealed: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
    keyId: string | null;
  }
): Promise<void> {
  // `updated_at` is deliberately NOT touched: it means "when did the operator
  // last change this secret", and a maintenance pass did not.
  const c = sealedColumns(row.store);
  await db
    .prepare(
      `UPDATE ${table(row.store)} SET ${c.ciphertext}=?, ${c.iv}=?, ${c.authTag}=?, ${c.keyVersion}=?, ${c.keyId}=? WHERE id=?`
    )
    .run(sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, sealed.keyId, row.id);
}
```

5. In `table(store)`, before `return 'linkedin_seat_credentials';`, add:

```ts
if (store === 'provider_webhook_endpoints') return 'provider_webhook_endpoints';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/provider-webhooks.test.ts src/server/lead-capture/lead-capture.test.ts`
Expected: PASS. The existing capture-source custody test still passes with the new row source.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/provider-webhooks src/server/secrets/crypto.ts src/server/secrets/custody.ts
git commit -m "feat(gtm): add generic provider webhook endpoints" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 7: Stripe observe-only verifier

**Files:**

- Modify: `package.json`, `package-lock.json` (add `stripe`)
- Create: `src/server/lead-capture/freemail.ts`
- Create: `src/server/provider-webhooks/stripe.ts`
- Modify: `src/server/app.ts:483,882`
- Test: `src/server/provider-webhooks/stripe.test.ts`

**Interfaces:**

- Consumes:
  - Task 6 module.
  - `recordProductMilestone` (Task 4).
  - `resolveContact(db, ws, { email, name }, now)` and `resolveExplicitAccount(db, ws, contactId, { domain, source, sourceDetail }, now)` from `src/server/lead-capture/people.ts`.
  - `resolvePersonByIdentity`, `upsertPersonIdentity` and `accountForPerson` from `src/server/person-identities.ts`.
- Produces:
  - `stripeVerifier: ProviderWebhookVerifier`.
  - `mapStripeEvent(envelope, now): MappedStripeEvent | null`.
  - `monthlyRunRate(items)` and `isSubscriptionUpgrade(current, previous): boolean`.
  - `STRIPE_OBSERVED_EVENTS` and `STRIPE_SIGNATURE_TOLERANCE_SECONDS`.
  - From `freemail.ts`: `emailDomain`, `isFreemailDomain` and `companyDomainFromEmail`.
  - `createApp` registers the Stripe verifier and the provider-webhook route.

- [ ] **Step 1: Write the failing test**

Create `src/server/provider-webhooks/stripe.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { resolveContact } from '../lead-capture/people.js';
import { companyDomainFromEmail } from '../lead-capture/freemail.js';
import {
  createProviderWebhookEndpoint,
  registerProviderVerifier,
  registerProviderWebhookRoutes,
  type ProviderWebhookEndpoint
} from './index.js';
import {
  isSubscriptionUpgrade,
  mapStripeEvent,
  stripeVerifier,
  type StripeEventEnvelope
} from './stripe.js';

const WS_A = 'ws_stripe_hooks_a';
const WS_B = 'ws_stripe_hooks_b';
const USER_A = 'usr_stripe_hooks_a';
const USER_B = 'usr_stripe_hooks_b';
const SECRET = `whsec_${randomBytes(24).toString('hex')}`;
const EMAIL = 'ada@acme-stripe.test';
const CUSTOMER = 'cus_TestAda001';
const AMOUNT = 987654;
const NOW = new Date('2026-10-06T09:00:00.000Z');

let db: Db;
let app: Express;
let endpoint: ProviderWebhookEndpoint;

function price(unitAmount: number | null, interval: string, currency = 'usd', intervalCount = 1) {
  return {
    unit_amount: unitAmount,
    currency,
    recurring: { interval, interval_count: intervalCount }
  };
}

function envelope(
  type: string,
  object: Record<string, unknown>,
  previous: Record<string, unknown> | null = null,
  eventId = 'evt_unit'
): StripeEventEnvelope {
  return {
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000) - 5,
    livemode: true,
    data: { object, previous_attributes: previous }
  };
}

function deliver(event: StripeEventEnvelope, secret = SECRET) {
  const payload = JSON.stringify({ object: 'event', api_version: '2026-09-30', ...event });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request(app)
    .post(`/api/hooks/v1/stripe/${endpoint.id}`)
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>(...params);
  return Number(row?.n ?? 0);
}

const checkout = (eventId: string) =>
  envelope(
    'checkout.session.completed',
    {
      id: 'cs_test_001',
      object: 'checkout.session',
      customer: CUSTOMER,
      customer_details: { email: EMAIL, name: 'Ada Lovelace' },
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: AMOUNT,
      line_items: { data: [{ description: 'Secret Pro Plan', amount_total: AMOUNT }] }
    },
    null,
    eventId
  );

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const [workspaceId, userId] of [
    [WS_A, USER_A],
    [WS_B, USER_B]
  ]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, new Date().toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@stripe.test`, userId, new Date().toISOString());
  }
  // Workspace B already knows the same person: a Stripe event for A must never touch it.
  await resolveContact(db, WS_B, { email: EMAIL, name: 'Ada in B' });
  registerProviderVerifier(stripeVerifier);
  endpoint = await createProviderWebhookEndpoint(db, {
    workspaceId: WS_A,
    actorUserId: USER_A,
    provider: 'stripe',
    signingSecret: SECRET
  });
  app = express();
  registerProviderWebhookRoutes(app, db);
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS_A, WS_B);
  await db?.close();
});

describe('Stripe event mapping (content-free)', () => {
  it('maps only paid checkouts and non-zero invoices to paid', () => {
    expect(mapStripeEvent(checkout('evt_1'), NOW)).toMatchObject({
      kind: 'paid',
      objectId: 'cs_test_001',
      customerId: CUSTOMER,
      email: EMAIL
    });
    expect(
      mapStripeEvent(
        envelope('checkout.session.completed', {
          id: 'cs_unpaid',
          mode: 'payment',
          payment_status: 'unpaid'
        }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('checkout.session.completed', {
          id: 'cs_setup',
          mode: 'setup',
          payment_status: 'paid'
        }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('invoice.paid', { id: 'in_zero', customer: CUSTOMER, amount_paid: 0 }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('invoice.paid', {
          id: 'in_1',
          customer: CUSTOMER,
          customer_email: EMAIL,
          amount_paid: AMOUNT
        }),
        NOW
      )
    ).toMatchObject({ kind: 'paid', objectId: 'in_1' });
    expect(mapStripeEvent(envelope('charge.refunded', { id: 'ch_1' }), NOW)).toBeNull();
  });

  it('calls a subscription change an upgrade only when the monthly run rate rises', () => {
    const items = (...prices: Array<ReturnType<typeof price>>) =>
      prices.map((p) => ({ price: p, quantity: 1 }));
    expect(isSubscriptionUpgrade(items(price(2500, 'month')), items(price(1000, 'month')))).toBe(
      true
    );
    expect(isSubscriptionUpgrade(items(price(1000, 'month')), items(price(2500, 'month')))).toBe(
      false
    );
    // 9000/month is below 120000/year (10000/month).
    expect(isSubscriptionUpgrade(items(price(9000, 'month')), items(price(120000, 'year')))).toBe(
      false
    );
    expect(
      isSubscriptionUpgrade(
        [{ price: price(1000, 'month'), quantity: 3 }],
        [{ price: price(1000, 'month'), quantity: 2 }]
      )
    ).toBe(true);
    expect(
      isSubscriptionUpgrade(items(price(5000, 'month', 'eur')), items(price(1000, 'month')))
    ).toBe(false);
    expect(isSubscriptionUpgrade(items(price(null, 'month')), items(price(1000, 'month')))).toBe(
      false
    );

    const upgraded = envelope(
      'customer.subscription.updated',
      { id: 'sub_1', customer: CUSTOMER, items: { data: items(price(2500, 'month')) } },
      { items: { data: items(price(1000, 'month')) } }
    );
    expect(mapStripeEvent(upgraded, NOW)).toMatchObject({ kind: 'upgraded', objectId: 'sub_1' });
    const metadataOnly = envelope(
      'customer.subscription.updated',
      { id: 'sub_1', customer: CUSTOMER, items: { data: items(price(2500, 'month')) } },
      { metadata: { plan: 'x' } }
    );
    expect(mapStripeEvent(metadataOnly, NOW)).toBeNull();
    expect(
      mapStripeEvent(
        envelope('customer.subscription.deleted', { id: 'sub_1', customer: CUSTOMER }),
        NOW
      )
    ).toMatchObject({ kind: 'cancelled', objectId: 'sub_1' });
  });

  it('creates Accounts only from company domains', () => {
    expect(companyDomainFromEmail('ada@acme.com')).toBe('acme.com');
    expect(companyDomainFromEmail('ada@gmail.com')).toBeNull();
    expect(companyDomainFromEmail('ada@yahoo.co.uk')).toBeNull();
    expect(companyDomainFromEmail('not-an-email')).toBeNull();
  });
});

describe('Stripe webhook delivery', () => {
  it('records payment, upgrade and cancellation once each, however often Stripe retries', async () => {
    const first = await deliver(checkout('evt_checkout_1'));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, handled: true });
    expect((await deliver(checkout('evt_checkout_1'))).body).toEqual({
      received: true,
      duplicate: true
    });
    await deliver(
      envelope(
        'invoice.paid',
        {
          id: 'in_test_001',
          customer: CUSTOMER,
          customer_email: EMAIL,
          amount_paid: AMOUNT,
          lines: { data: [{ description: 'Secret Pro Plan', amount: AMOUNT }] }
        },
        null,
        'evt_invoice_1'
      )
    ).expect(200);
    const items = (amount: number) => [{ price: price(amount, 'month'), quantity: 1 }];
    await deliver(
      envelope(
        'customer.subscription.updated',
        { id: 'sub_test_001', customer: CUSTOMER, items: { data: items(4900) } },
        { items: { data: items(1900) } },
        'evt_sub_up_1'
      )
    ).expect(200);
    for (const eventId of ['evt_sub_del_1', 'evt_sub_del_2'])
      await deliver(
        envelope(
          'customer.subscription.deleted',
          { id: 'sub_test_001', customer: CUSTOMER },
          null,
          eventId
        )
      ).expect(200);

    for (const [kind, expected] of [
      ['paid', 1],
      ['upgraded', 1],
      ['cancelled', 1]
    ] as const)
      expect(
        await count(
          'SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND kind=?',
          WS_A,
          kind
        ),
        kind
      ).toBe(expected);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='won'",
        WS_A
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS_A)
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals s JOIN accounts a ON a.id=s.account_id WHERE s.workspace_id=? AND a.domain='acme-stripe.test' AND s.kind='customer-paid'",
        WS_A
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM person_identities WHERE workspace_id=? AND provider='stripe' AND identity_type='customer' AND normalized_value=?",
        WS_A,
        CUSTOMER
      )
    ).toBe(1);
  });

  it('attaches only to the endpoint workspace, even when another workspace knows the email', async () => {
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS_B)
    ).toBe(0);
    const owners = await db
      .prepare(
        `SELECT DISTINCT p.workspace_id FROM product_milestones m
         JOIN contacts p ON p.id=m.contact_id
         WHERE m.provider_endpoint_id=?`
      )
      .all<{ workspace_id: string }>(endpoint.id);
    expect(owners).toEqual([{ workspace_id: WS_A }]);
  });

  it('stores ids only: no amount, email, description or line items at rest', async () => {
    const stored = JSON.stringify(
      await Promise.all([
        db
          .prepare(
            'SELECT payload_json::text AS a, metadata_json::text AS b FROM domain_events WHERE workspace_id=?'
          )
          .all(WS_A),
        db
          .prepare(
            'SELECT row_to_json(m)::text AS a FROM product_milestones m WHERE workspace_id=?'
          )
          .all(WS_A),
        db
          .prepare('SELECT row_to_json(w)::text AS a FROM webhook_events w WHERE workspace_id=?')
          .all(WS_A),
        db
          .prepare(
            "SELECT detail AS a, COALESCE(previous,'') AS b, COALESCE(current,'') AS c FROM account_signals WHERE workspace_id=?"
          )
          .all(WS_A),
        db.prepare('SELECT rationale_json AS a FROM account_scores WHERE workspace_id=?').all(WS_A)
      ])
    );
    expect(stored).not.toContain(String(AMOUNT));
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain('Secret Pro Plan');
    expect(stored).not.toContain('line_items');
  });

  it('ignores test-mode events, unknown customers, and bad signatures', async () => {
    const testMode = { ...checkout('evt_test_mode'), livemode: false };
    expect((await deliver(testMode)).body).toEqual({ received: true, handled: false });
    const stranger = envelope(
      'customer.subscription.deleted',
      { id: 'sub_stranger', customer: 'cus_Stranger999' },
      null,
      'evt_stranger'
    );
    expect((await deliver(stranger)).body).toEqual({ received: true, handled: false });
    const forged = await deliver(
      checkout('evt_forged'),
      `whsec_${randomBytes(24).toString('hex')}`
    );
    expect(forged.status).toBe(400);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND source_id IN ('evt_test_mode','evt_stranger','evt_forged')",
        WS_A
      )
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/stripe.test.ts`
Expected: FAIL with `Cannot find package 'stripe'` (or `Cannot find module './stripe.js'`).

- [ ] **Step 3: Write the implementation**

Add the official SDK, used only for signature verification (https://github.com/stripe/stripe-node#webhook-signing):

```bash
npm install stripe@^22.6.2
npm audit --omit=dev
```

Expected: `package.json` gains `"stripe": "^22.6.2"` in `dependencies`. `npm audit --omit=dev` reports `found 0 vulnerabilities`, or only advisories that predate this change; record any new advisory in the commit body.

Create `src/server/lead-capture/freemail.ts`:

```ts
/**
 * Personal mailbox providers. A payer on one of these tells us WHO paid, not
 * which company did, so no Account is created from the domain.
 *
 * lc-debt: a fixed list of the largest consumer providers, not exhaustive;
 * upgrade path is a maintained freemail dataset behind `isFreemailDomain`.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'tuta.io'
]);

/** Regional variants of the largest providers: yahoo.co.uk, hotmail.fr, outlook.de, ... */
const FREEMAIL_FAMILIES = ['yahoo.', 'hotmail.', 'outlook.', 'live.', 'gmx.', 'yandex.'];

export function emailDomain(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? '';
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

export function isFreemailDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase();
  return (
    FREEMAIL_DOMAINS.has(value) || FREEMAIL_FAMILIES.some((prefix) => value.startsWith(prefix))
  );
}

export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const domain = emailDomain(email);
  return domain && !isFreemailDomain(domain) ? domain : null;
}
```

Create `src/server/provider-webhooks/stripe.ts`:

```ts
/**
 * Stripe, observed only.
 *
 * Trevra holds no Stripe API key and makes no Stripe API call. The founder adds
 * a per-workspace endpoint in the Stripe Dashboard; each delivery is verified
 * with Stripe's own library over the exact raw bytes
 * (https://docs.stripe.com/webhooks/signature,
 * https://github.com/stripe/stripe-node#webhook-signing), reduced to a closed
 * milestone, and recorded through the same function as the signed intake.
 *
 * STORED: the Stripe event id (milestone source) and object id (cs_/in_/sub_),
 * plus the customer id as a person identity. NEVER STORED: amounts, prices,
 * line items, invoice details or descriptions. Prices are read in memory only,
 * to decide whether a subscription change is an upgrade.
 */
import Stripe from 'stripe';
import type { Db } from '../db.js';
import { resolveContact, resolveExplicitAccount } from '../lead-capture/people.js';
import { recordProductMilestone } from '../lead-capture/milestone-recorder.js';
import type { GtmMilestoneKind } from '../lead-capture/milestones.js';
import { companyDomainFromEmail } from '../lead-capture/freemail.js';
import {
  accountForPerson,
  resolvePersonByIdentity,
  upsertPersonIdentity
} from '../person-identities.js';
import type {
  ProviderWebhookEndpoint,
  ProviderWebhookEvent,
  ProviderWebhookVerification,
  ProviderWebhookVerifier,
  WebhookHeaders
} from './types.js';

/** Stripe's documented default; bounds replay of a captured delivery. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** What the founder selects in the Stripe Dashboard (https://docs.stripe.com/webhooks). */
export const STRIPE_OBSERVED_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted'
] as const;

/** The event envelope (https://docs.stripe.com/api/events/object), loosely typed. */
export interface StripeEventEnvelope {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: Record<string, unknown>;
    previous_attributes?: Record<string, unknown> | null;
  };
}

export interface StripeItemLike {
  price?: {
    unit_amount?: unknown;
    currency?: unknown;
    recurring?: { interval?: unknown; interval_count?: unknown } | null;
  } | null;
  quantity?: unknown;
}

export interface MappedStripeEvent {
  kind: GtmMilestoneKind;
  objectId: string;
  customerId: string | null;
  email: string | null;
  name: string | null;
  occurredAt: Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function itemList(value: unknown): StripeItemLike[] | null {
  const data = record(value)?.data;
  return Array.isArray(data) ? (data as StripeItemLike[]) : null;
}

function customerIdOf(value: unknown): string | null {
  if (typeof value === 'string') return /^cus_[A-Za-z0-9]+$/.test(value) ? value : null;
  const nested = record(value);
  return nested ? customerIdOf(nested.id) : null;
}

const INTERVALS_PER_MONTH: Record<string, number> = {
  day: 365 / 12,
  week: 52 / 12,
  month: 1,
  year: 1 / 12
};

/**
 * Monthly run rate of a subscription's items, in minor units, in memory only.
 * Null when it cannot be compared honestly: mixed currencies, a price without
 * a fixed `unit_amount` (tiered or metered), or an unknown interval.
 */
export function monthlyRunRate(
  items: readonly StripeItemLike[]
): { currency: string; minorUnitsPerMonth: number } | null {
  if (items.length === 0) return null;
  let currency: string | null = null;
  let total = 0;
  for (const item of items) {
    const price = item?.price;
    const unitAmount = price?.unit_amount;
    const itemCurrency = typeof price?.currency === 'string' ? price.currency.toLowerCase() : null;
    const interval = typeof price?.recurring?.interval === 'string' ? price.recurring.interval : '';
    const perMonth = INTERVALS_PER_MONTH[interval];
    if (
      typeof unitAmount !== 'number' ||
      !Number.isFinite(unitAmount) ||
      !itemCurrency ||
      perMonth === undefined
    )
      return null;
    if (currency && currency !== itemCurrency) return null;
    currency = itemCurrency;
    const rawCount = price?.recurring?.interval_count;
    const count = typeof rawCount === 'number' && rawCount >= 1 ? Math.trunc(rawCount) : 1;
    const quantity = typeof item.quantity === 'number' && item.quantity >= 0 ? item.quantity : 1;
    total += (unitAmount * quantity * perMonth) / count;
  }
  return currency ? { currency, minorUnitsPerMonth: total } : null;
}

/**
 * THE UPGRADE RULE (content-free): a `customer.subscription.updated` event is an
 * upgrade when `data.previous_attributes.items` is present (the items changed;
 * https://docs.stripe.com/api/events/object, https://docs.stripe.com/billing/subscriptions/change-price)
 * and the monthly run rate of the new items is strictly higher than the old,
 * in the same currency. Anything not comparable is not an upgrade.
 */
export function isSubscriptionUpgrade(
  current: readonly StripeItemLike[],
  previous: readonly StripeItemLike[]
): boolean {
  const after = monthlyRunRate(current);
  const before = monthlyRunRate(previous);
  return Boolean(
    after &&
    before &&
    after.currency === before.currency &&
    after.minorUnitsPerMonth > before.minorUnitsPerMonth
  );
}

export function mapStripeEvent(envelope: StripeEventEnvelope, now: Date): MappedStripeEvent | null {
  const object = record(envelope.data?.object);
  const objectId = text(object?.id, 255);
  if (!object || !objectId) return null;
  const created =
    typeof envelope.created === 'number' && Number.isFinite(envelope.created)
      ? new Date(Math.min(envelope.created * 1000, now.getTime()))
      : now;
  const customerId = customerIdOf(object.customer);
  switch (envelope.type) {
    case 'checkout.session.completed': {
      if (object.mode === 'setup' || object.payment_status !== 'paid') return null;
      const details = record(object.customer_details);
      return {
        kind: 'paid',
        objectId,
        customerId,
        email: text(details?.email, 320) ?? text(object.customer_email, 320),
        name: text(details?.name, 200),
        occurredAt: created
      };
    }
    case 'invoice.paid': {
      if (!(typeof object.amount_paid === 'number' && object.amount_paid > 0)) return null;
      return {
        kind: 'paid',
        objectId,
        customerId,
        email: text(object.customer_email, 320),
        name: text(object.customer_name, 200),
        occurredAt: created
      };
    }
    case 'customer.subscription.updated': {
      if (!customerId) return null;
      const before = itemList(record(envelope.data?.previous_attributes)?.items);
      const after = itemList(object.items);
      if (!before || !after || !isSubscriptionUpgrade(after, before)) return null;
      return {
        kind: 'upgraded',
        objectId,
        customerId,
        email: null,
        name: null,
        occurredAt: created
      };
    }
    case 'customer.subscription.deleted':
      if (!customerId) return null;
      return {
        kind: 'cancelled',
        objectId,
        customerId,
        email: null,
        name: null,
        occurredAt: created
      };
    default:
      return null;
  }
}

export function verifyStripeSignature(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
  now: Date
): ProviderWebhookVerification {
  const header = headers['stripe-signature'];
  const signature = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (!signature) return { ok: false, status: 400, error: 'Missing Stripe-Signature header' };
  let event: { id?: unknown; type?: unknown };
  try {
    // receivedAt is in milliseconds; the library rejects deliveries older than
    // the tolerance (https://docs.stripe.com/webhooks/signature).
    event = Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
      STRIPE_SIGNATURE_TOLERANCE_SECONDS,
      undefined,
      now.getTime()
    );
  } catch {
    return { ok: false, status: 400, error: 'Invalid Stripe signature' };
  }
  if (typeof event.id !== 'string' || typeof event.type !== 'string')
    return { ok: false, status: 400, error: 'Stripe event is missing its id or type' };
  return { ok: true, eventId: event.id, eventType: event.type, payload: event };
}

export async function handleStripeEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  event: ProviderWebhookEvent,
  now: Date
): Promise<{ handled: boolean }> {
  const envelope = event.payload as StripeEventEnvelope;
  // Test-mode deliveries verify (and count as accepted) but never become
  // commercial outcomes.
  if (envelope.livemode !== true) return { handled: false };
  const mapped = mapStripeEvent(envelope, now);
  if (!mapped) return { handled: false };
  const workspaceId = endpoint.workspaceId;

  let personId: string | null = null;
  if (mapped.customerId) {
    const known = await resolvePersonByIdentity(db, {
      workspaceId,
      provider: 'stripe',
      identityType: 'customer',
      identityValue: mapped.customerId
    });
    personId = known?.id ?? null;
  }
  if (!personId && mapped.email) {
    const resolved = await resolveContact(
      db,
      workspaceId,
      { email: mapped.email, name: mapped.name },
      now
    );
    personId = resolved.contact.id;
  }
  // lc-debt: a subscription event for a customer Trevra never saw pay is
  // ignored, because observe-only means no API key to look the customer up;
  // upgrade path is an optional restricted read key in Nango.
  if (!personId) return { handled: false };
  if (mapped.customerId)
    await upsertPersonIdentity(
      db,
      {
        workspaceId,
        personId,
        provider: 'stripe',
        identityType: 'customer',
        identityValue: mapped.customerId
      },
      now
    );

  let accountId: string | null = null;
  const domain = companyDomainFromEmail(mapped.email);
  if (domain) {
    const account = await resolveExplicitAccount(
      db,
      workspaceId,
      personId,
      { domain, name: null, source: 'capture', sourceDetail: `stripe:${endpoint.id}` },
      now
    );
    accountId = account?.accountId ?? null;
  }
  if (!accountId) accountId = await accountForPerson(db, workspaceId, personId);

  await recordProductMilestone(
    db,
    {
      workspaceId,
      kind: mapped.kind,
      contactId: personId,
      accountId,
      sourceType: 'stripe_event',
      sourceId: event.eventId,
      providerEndpointId: endpoint.id,
      externalObjectId: mapped.objectId,
      occurredAt: mapped.occurredAt
    },
    now
  );
  return { handled: true };
}

export const stripeVerifier: ProviderWebhookVerifier = {
  provider: 'stripe',
  secretPattern: /^whsec_\S{16,200}$/,
  verify: verifyStripeSignature,
  handle: handleStripeEvent
};
```

In `src/server/app.ts`, add after line 483 (`import { registerLeadCaptureIntake } from './lead-capture/http.js';`):

```ts
import {
  registerProviderVerifier,
  registerProviderWebhookRoutes
} from './provider-webhooks/index.js';
import { stripeVerifier } from './provider-webhooks/stripe.js';
```

Replace line 882:

```ts
registerLeadCaptureIntake(app, db);
```

with:

```ts
registerLeadCaptureIntake(app, db);

// Observed provider webhooks (Stripe now; Cal.com in Phase B) verify exact
// raw bytes too, so they register before the JSON parser. The URL's endpoint
// id decides the workspace; nothing in the payload can.
registerProviderVerifier(stripeVerifier);
registerProviderWebhookRoutes(app, db);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/stripe.test.ts src/server/provider-webhooks/provider-webhooks.test.ts src/server/lead-capture/api.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm audit --omit=dev`
Expected: typecheck exit 0. The audit introduces no new advisory.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/server/lead-capture/freemail.ts src/server/provider-webhooks/stripe.ts src/server/provider-webhooks/stripe.test.ts src/server/app.ts
git commit -m "feat(gtm): observe Stripe payments through a signed webhook" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 8: Owner-only webhook management API

**Files:**

- Modify: `src/server/app.ts` (imports from Task 7, routes after line 1377, error handler at line 7712-7716)
- Test: `src/server/provider-webhooks/api.test.ts`

**Interfaces:**

- Consumes: Task 6 store functions; `ownerOnly(act)` (private helper in `app.ts`); `secretsConfigured`.
- Produces (consumed by Task 9's client; every route is owner-only):
  - `GET /api/setup/webhooks` → `{ endpoints: Array<ProviderWebhookEndpoint & { path }>, providers: WebhookProvider[], secretsConfigured: boolean }`
  - `POST /api/setup/webhooks/draft` `{ provider }` → `{ endpointId, path }`
  - `POST /api/setup/webhooks` `{ provider, endpointId, signingSecret }` → `201 { endpoint }`
  - `PATCH /api/setup/webhooks/:id/status` `{ status }` → `{ endpoint }` or 404
  - `DELETE /api/setup/webhooks/:id` → 204

- [ ] **Step 1: Write the failing test**

Create `src/server/provider-webhooks/api.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE_ID = 'ws_webhook_api';
const USER_ID = 'usr_webhook_api';
const SECRET = `whsec_${randomBytes(24).toString('hex')}`;

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Webhook API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'webhook-api@trevra.test', 'Webhook API', now);
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

function owner() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

let signUpSeq = 0;
async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@webhook-api.test`;
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

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  session = await seedSession();
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
  await closeAuthDatabase();
});

describe('/api/setup/webhooks', () => {
  it('lets the owner draft, connect, pause and remove a Stripe endpoint', async () => {
    const empty = await owner().get('/api/setup/webhooks').expect(200);
    expect(empty.body).toMatchObject({ endpoints: [], secretsConfigured: true });
    expect(empty.body.providers).toContain('stripe');

    const draft = await owner()
      .post('/api/setup/webhooks/draft')
      .send({ provider: 'stripe' })
      .expect(200);
    expect(draft.body.endpointId).toMatch(/^pwh_[a-f0-9]{24}$/);
    expect(draft.body.path).toBe(`/api/hooks/v1/stripe/${draft.body.endpointId}`);

    await owner()
      .post('/api/setup/webhooks')
      .send({
        provider: 'stripe',
        endpointId: draft.body.endpointId,
        signingSecret: 'sk_live_wrong'
      })
      .expect(400);

    const created = await owner()
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId: draft.body.endpointId, signingSecret: SECRET })
      .expect(201);
    expect(created.body.endpoint).toMatchObject({
      id: draft.body.endpointId,
      provider: 'stripe',
      status: 'active',
      path: draft.body.path
    });
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    const repeated = await owner()
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId: draft.body.endpointId, signingSecret: SECRET })
      .expect(201);
    expect(repeated.body.endpoint.id).toBe(draft.body.endpointId);

    const paused = await owner()
      .patch(`/api/setup/webhooks/${draft.body.endpointId}/status`)
      .send({ status: 'disabled' })
      .expect(200);
    expect(paused.body.endpoint.status).toBe('disabled');
    const listed = await owner().get('/api/setup/webhooks').expect(200);
    expect(listed.body.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);

    await owner().delete(`/api/setup/webhooks/${draft.body.endpointId}`).expect(204);
    await owner().delete(`/api/setup/webhooks/${draft.body.endpointId}`).expect(204);
    await owner()
      .patch(`/api/setup/webhooks/${draft.body.endpointId}/status`)
      .send({ status: 'active' })
      .expect(404);
    expect((await owner().get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual([]);
  });

  it('refuses every webhook management route to a non-owner member', async () => {
    const ownerUser = await signUp('webhook-owner');
    const member = await signUp('webhook-member');
    await betterAuth.api.addMember({
      body: {
        userId: member.userId,
        organizationId: ownerUser.auth.workspaceId,
        role: 'member'
      }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerUser.auth.workspaceId })
      .expect(200);
    await member.agent.get('/api/setup/webhooks').expect(403);
    await member.agent.post('/api/setup/webhooks/draft').send({ provider: 'stripe' }).expect(403);
    await member.agent
      .post('/api/setup/webhooks')
      .send({
        provider: 'stripe',
        endpointId: `pwh_${'a'.repeat(24)}`,
        signingSecret: SECRET
      })
      .expect(403);
    await member.agent
      .patch(`/api/setup/webhooks/pwh_${'a'.repeat(24)}/status`)
      .send({ status: 'disabled' })
      .expect(403);
    await member.agent.delete(`/api/setup/webhooks/pwh_${'a'.repeat(24)}`).expect(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/api.test.ts`
Expected: FAIL. `GET /api/setup/webhooks` returns 404 `API route not found`.

- [ ] **Step 3: Write the implementation**

In `src/server/app.ts`, replace the Task 7 import block

```ts
import {
  registerProviderVerifier,
  registerProviderWebhookRoutes
} from './provider-webhooks/index.js';
```

with:

```ts
import {
  ProviderWebhookError,
  WEBHOOK_PROVIDERS,
  createProviderWebhookEndpoint,
  deleteProviderWebhookEndpoint,
  draftProviderWebhookEndpointId,
  getProviderVerifier,
  listProviderWebhookEndpoints,
  providerWebhookPath,
  registerProviderVerifier,
  registerProviderWebhookRoutes,
  registeredWebhookProviders,
  setProviderWebhookEndpointStatus,
  withProviderWebhookPath
} from './provider-webhooks/index.js';
```

After the `/api/capture-sources/:id/rotate` route (the `);` that closes it at line 1377), add:

```ts
// ---------------------------------------------------------------------
// Observed provider webhooks (Stripe now; Cal.com in Phase B). Every route
// here exposes or changes an endpoint that receives a signing secret, so all
// of them -- reads included -- are owner-only. Secrets are never returned.
// ---------------------------------------------------------------------
const webhookEndpointIdSchema = z
  .string()
  .trim()
  .regex(/^pwh_[a-f0-9]{24}$/);

app.get(
  '/api/setup/webhooks',
  ownerOnly('manage provider webhooks'),
  async (req: AuthedRequest, res, next) => {
    try {
      const endpoints = await listProviderWebhookEndpoints(db, req.auth!.workspaceId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        endpoints: endpoints.map(withProviderWebhookPath),
        providers: registeredWebhookProviders(),
        secretsConfigured: secretsConfigured()
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/setup/webhooks/draft',
  ownerOnly('manage provider webhooks'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({ provider: z.enum(WEBHOOK_PROVIDERS) })
        .strict()
        .parse(req.body ?? {});
      if (!getProviderVerifier(input.provider))
        throw new ProviderWebhookError(
          `${input.provider} webhooks are not available on this deployment.`,
          400
        );
      const endpointId = draftProviderWebhookEndpointId();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ endpointId, path: providerWebhookPath(input.provider, endpointId) });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/setup/webhooks',
  ownerOnly('manage provider webhooks'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({
          provider: z.enum(WEBHOOK_PROVIDERS),
          endpointId: webhookEndpointIdSchema,
          signingSecret: z.string().trim().min(1).max(500)
        })
        .strict()
        .parse(req.body ?? {});
      const endpoint = await createProviderWebhookEndpoint(db, {
        workspaceId: req.auth!.workspaceId,
        actorUserId: req.auth!.userId,
        provider: input.provider,
        signingSecret: input.signingSecret,
        endpointId: input.endpointId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ endpoint: withProviderWebhookPath(endpoint) });
    } catch (error) {
      next(error);
    }
  }
);

app.patch(
  '/api/setup/webhooks/:id/status',
  ownerOnly('manage provider webhooks'),
  async (req: AuthedRequest, res, next) => {
    try {
      const endpointId = webhookEndpointIdSchema.parse(String(req.params.id));
      const input = z
        .object({ status: z.enum(['active', 'disabled']) })
        .strict()
        .parse(req.body ?? {});
      const endpoint = await setProviderWebhookEndpointStatus(db, {
        workspaceId: req.auth!.workspaceId,
        endpointId,
        status: input.status,
        actorUserId: req.auth!.userId
      });
      if (!endpoint) return res.status(404).json({ error: 'Webhook endpoint not found' });
      res.json({ endpoint: withProviderWebhookPath(endpoint) });
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  '/api/setup/webhooks/:id',
  ownerOnly('manage provider webhooks'),
  async (req: AuthedRequest, res, next) => {
    try {
      const endpointId = webhookEndpointIdSchema.parse(String(req.params.id));
      await deleteProviderWebhookEndpoint(db, {
        workspaceId: req.auth!.workspaceId,
        endpointId,
        actorUserId: req.auth!.userId
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
);
```

In the global error handler, replace:

```ts
    if (
      error instanceof SkillApiError ||
      error instanceof PlaybookError ||
      error instanceof LeadCaptureError
    )
```

with:

```ts
    if (
      error instanceof SkillApiError ||
      error instanceof PlaybookError ||
      error instanceof LeadCaptureError ||
      error instanceof ProviderWebhookError
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/provider-webhooks/api.test.ts src/server/lead-capture/api.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/provider-webhooks/api.test.ts
git commit -m "feat(gtm): add owner-only webhook management API" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 9: Connect Stripe on `/setup/capture`

**Files:**

- Modify: `src/client/api.ts` (after `rotateCaptureSourceSecret`, line 3536)
- Create: `src/client/provider-webhook-view.tsx`
- Create: `src/client/ProviderWebhookSetup.tsx`
- Modify: `src/client/LeadCaptureSetup.tsx:1-23,396-399`
- Modify: `src/client/lead-capture.css` (append; extend the 780px media query)
- Test: `src/client/provider-webhook-view.test.tsx`

**Interfaces:**

- Consumes: the Task 8 API; `getPublicConfig()` (`apiBaseUrl`); `Button`, `Field`, `Input` from `./ui/primitives`; `ConfirmDrawer` from `./ui/dialog`; `errorMessage` from `./LinkedInSafety`; `relativeTime` from `./LinkedInScreen`.
- Produces:
  - `ProviderWebhookEndpointSummary`, `getProviderWebhooks`, `draftProviderWebhook`, `createProviderWebhook`, `setProviderWebhookStatus` and `removeProviderWebhook` in `api.ts`.
  - `STRIPE_WEBHOOK_EVENTS`, `providerWebhookUrl(apiBaseUrl, path)` and `WebhookEndpointRow` in `provider-webhook-view.tsx`.
  - `ProviderWebhookSetup({ setToast })`.

- [ ] **Step 1: Write the failing test**

Create `src/client/provider-webhook-view.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderWebhookEndpointSummary } from './api';
import {
  STRIPE_WEBHOOK_EVENTS,
  WebhookEndpointRow,
  providerWebhookUrl
} from './provider-webhook-view';

const endpoint: ProviderWebhookEndpointSummary = {
  id: 'pwh_0123456789abcdef01234567',
  workspaceId: 'ws_1',
  provider: 'stripe',
  status: 'active',
  createdByUserId: 'usr_1',
  lastSeenAt: null,
  acceptedCount: 4,
  rejectedCount: 1,
  createdAt: '2026-10-06T09:00:00.000Z',
  updatedAt: '2026-10-06T09:00:00.000Z',
  path: '/api/hooks/v1/stripe/pwh_0123456789abcdef01234567'
};

describe('Stripe webhook setup view', () => {
  it('builds the URL the founder pastes into Stripe', () => {
    expect(providerWebhookUrl('https://app.trevra.example/', endpoint.path)).toBe(
      'https://app.trevra.example/api/hooks/v1/stripe/pwh_0123456789abcdef01234567'
    );
    expect([...STRIPE_WEBHOOK_EVENTS]).toEqual([
      'checkout.session.completed',
      'invoice.paid',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    ]);
  });

  it('shows the URL, honest counts and labelled actions, never a secret', () => {
    const html = renderToStaticMarkup(
      <WebhookEndpointRow
        endpoint={endpoint}
        url={`https://app.trevra.example${endpoint.path}`}
        lastDelivery="None yet"
        busy={false}
        onToggle={() => undefined}
        onRemove={() => undefined}
      />
    );
    expect(html).toContain(`https://app.trevra.example${endpoint.path}`);
    expect(html).toContain('Listening');
    expect(html).toContain('Verified deliveries');
    expect(html).toContain('Rejected deliveries');
    expect(html).toContain('None yet');
    expect(html).toContain('Pause');
    expect(html).toContain('Remove');
    expect(html).not.toContain('whsec_');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/client/provider-webhook-view.test.tsx`
Expected: FAIL with `Cannot find module './provider-webhook-view'`.

- [ ] **Step 3: Write the implementation**

In `src/client/api.ts`, after `rotateCaptureSourceSecret` (ends line 3536), add:

```ts
export type WebhookProvider = 'stripe' | 'calcom';

export interface ProviderWebhookEndpointSummary {
  id: string;
  workspaceId: string;
  provider: WebhookProvider;
  status: 'active' | 'disabled';
  createdByUserId: string | null;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
  path: string;
}

export async function getProviderWebhooks(): Promise<{
  endpoints: ProviderWebhookEndpointSummary[];
  providers: WebhookProvider[];
  secretsConfigured: boolean;
}> {
  return request('/api/setup/webhooks');
}

export async function draftProviderWebhook(
  provider: WebhookProvider
): Promise<{ endpointId: string; path: string }> {
  return request('/api/setup/webhooks/draft', {
    method: 'POST',
    body: JSON.stringify({ provider })
  });
}

export async function createProviderWebhook(input: {
  provider: WebhookProvider;
  endpointId: string;
  signingSecret: string;
}): Promise<ProviderWebhookEndpointSummary> {
  const result = await request<{ endpoint: ProviderWebhookEndpointSummary }>(
    '/api/setup/webhooks',
    { method: 'POST', body: JSON.stringify(input) }
  );
  return result.endpoint;
}

export async function setProviderWebhookStatus(
  id: string,
  status: ProviderWebhookEndpointSummary['status']
): Promise<ProviderWebhookEndpointSummary> {
  const result = await request<{ endpoint: ProviderWebhookEndpointSummary }>(
    `/api/setup/webhooks/${encodeURIComponent(id)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status }) }
  );
  return result.endpoint;
}

export async function removeProviderWebhook(id: string): Promise<void> {
  await request<void>(`/api/setup/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
```

Create `src/client/provider-webhook-view.tsx`:

```tsx
import { PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import type { ProviderWebhookEndpointSummary } from './api';
import { Button } from './ui/primitives';

/** The events the founder selects in Stripe (server: STRIPE_OBSERVED_EVENTS). */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted'
] as const;

export function providerWebhookUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${path}`;
}

export function WebhookEndpointRow({
  endpoint,
  url,
  lastDelivery,
  busy,
  onToggle,
  onRemove
}: {
  endpoint: ProviderWebhookEndpointSummary;
  url: string;
  lastDelivery: string;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const active = endpoint.status === 'active';
  return (
    <article className="capture-webhook-endpoint">
      <header>
        <strong>Stripe endpoint</strong>
        <span className={active ? 'status-pill ok' : 'status-pill'}>
          {active ? 'Listening' : 'Paused'}
        </span>
      </header>
      <div className="capture-secret">
        <strong>Endpoint URL in Stripe</strong>
        <code>{url}</code>
      </div>
      <div className="capture-metrics">
        <span>
          <strong>{endpoint.acceptedCount}</strong>
          <small>Verified deliveries</small>
        </span>
        <span>
          <strong>{endpoint.rejectedCount}</strong>
          <small>Rejected deliveries</small>
        </span>
        <span>
          <strong>{lastDelivery}</strong>
          <small>Last delivery</small>
        </span>
      </div>
      <div className="capture-actions">
        <Button disabled={busy} onClick={onToggle}>
          {active ? <PauseCircle size={15} aria-hidden /> : <PlayCircle size={15} aria-hidden />}
          {active ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="danger" disabled={busy} onClick={onRemove}>
          <Trash2 size={15} aria-hidden /> Remove
        </Button>
      </div>
    </article>
  );
}
```

Create `src/client/ProviderWebhookSetup.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Copy, CreditCard, LoaderCircle } from 'lucide-react';
import {
  createProviderWebhook,
  draftProviderWebhook,
  getProviderWebhooks,
  getPublicConfig,
  removeProviderWebhook,
  setProviderWebhookStatus,
  type ProviderWebhookEndpointSummary
} from './api';
import { Button, Field, Input } from './ui/primitives';
import { ConfirmDrawer } from './ui/dialog';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import {
  STRIPE_WEBHOOK_EVENTS,
  WebhookEndpointRow,
  providerWebhookUrl
} from './provider-webhook-view';

const WHSEC_RE = /^whsec_\S{16,200}$/;

/**
 * Observe-only Stripe connection. The owner adds an endpoint in the Stripe
 * Dashboard with the URL shown here, then pastes the `whsec_` signing secret
 * Stripe shows for it. Trevra stores it sealed and never shows it again.
 */
export function ProviderWebhookSetup({ setToast }: { setToast: (message: string) => void }) {
  const [endpoints, setEndpoints] = useState<ProviderWebhookEndpointSummary[]>([]);
  const [available, setAvailable] = useState(false);
  const [custody, setCustody] = useState(true);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [draft, setDraft] = useState<{ endpointId: string; path: string } | null>(null);
  const [signingSecret, setSigningSecret] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<ProviderWebhookEndpointSummary | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void Promise.all([getProviderWebhooks(), getPublicConfig()])
      .then(([result, config]) => {
        setEndpoints(result.endpoints.filter((endpoint) => endpoint.provider === 'stripe'));
        setAvailable(result.providers.includes('stripe'));
        setCustody(result.secretsConfigured);
        setApiBaseUrl(config.apiBaseUrl || window.location.origin);
      })
      .catch((error) => setProblem(errorMessage(error, 'Unable to load Stripe payments.')));
  }, []);

  const base = apiBaseUrl || window.location.origin;

  const start = async () => {
    setBusy('draft');
    setProblem('');
    try {
      setDraft(await draftProviderWebhook('stripe'));
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to prepare a Stripe endpoint.'));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setProblem('');
    try {
      const endpoint = await createProviderWebhook({
        provider: 'stripe',
        endpointId: draft.endpointId,
        signingSecret: signingSecret.trim()
      });
      setEndpoints((current) => [endpoint, ...current.filter((item) => item.id !== endpoint.id)]);
      setDraft(null);
      setSigningSecret('');
      setToast('Stripe connected. Trevra now listens for payments.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to save the Stripe signing secret.'));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (endpoint: ProviderWebhookEndpointSummary) => {
    setBusy(endpoint.id);
    setProblem('');
    try {
      const next = await setProviderWebhookStatus(
        endpoint.id,
        endpoint.status === 'active' ? 'disabled' : 'active'
      );
      setEndpoints((current) => current.map((item) => (item.id === next.id ? next : item)));
      setToast(next.status === 'active' ? 'Stripe endpoint resumed.' : 'Stripe endpoint paused.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to change the Stripe endpoint.'));
    } finally {
      setBusy('');
    }
  };

  const remove = async (endpoint: ProviderWebhookEndpointSummary) => {
    setBusy(endpoint.id);
    setProblem('');
    try {
      await removeProviderWebhook(endpoint.id);
      setEndpoints((current) => current.filter((item) => item.id !== endpoint.id));
      setConfirmRemove(null);
      setToast('Stripe endpoint removed. Delete it in Stripe too.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to remove the Stripe endpoint.'));
    } finally {
      setBusy('');
    }
  };

  const copyUrl = (url: string) =>
    void navigator.clipboard.writeText(url).then(() => setToast('Endpoint URL copied.'));

  if (!available) return null;

  return (
    <section className="page-panel" id="stripe-payments">
      <div className="section-heading">
        <div>
          <h3>Stripe payments</h3>
          <p>
            Observe paid, upgraded and cancelled customers. Trevra only listens; it never changes
            anything in Stripe and never stores amounts.
          </p>
        </div>
        <CreditCard size={20} aria-hidden />
      </div>
      {problem && <div className="error-box">{problem}</div>}
      {!custody && (
        <div className="error-box">
          Secret custody is not configured on this deployment, so a signing secret cannot be stored.
        </div>
      )}

      {endpoints.map((endpoint) => (
        <WebhookEndpointRow
          key={endpoint.id}
          endpoint={endpoint}
          url={providerWebhookUrl(base, endpoint.path)}
          lastDelivery={endpoint.lastSeenAt ? relativeTime(endpoint.lastSeenAt) : 'None yet'}
          busy={busy === endpoint.id}
          onToggle={() => void toggle(endpoint)}
          onRemove={() => setConfirmRemove(endpoint)}
        />
      ))}

      {endpoints.length === 0 && !draft && (
        <div className="capture-actions">
          <Button
            variant="primary"
            disabled={!custody || busy === 'draft'}
            onClick={() => void start()}
          >
            {busy === 'draft' ? (
              <LoaderCircle className="spin" size={15} aria-hidden />
            ) : (
              <CreditCard size={15} aria-hidden />
            )}
            Connect Stripe
          </Button>
        </div>
      )}

      {draft && (
        <div className="capture-webhook-connect">
          <ol className="capture-webhook-steps">
            <li>In Stripe, open Developers → Webhooks and add an endpoint with this URL.</li>
            <li>Select only these events.</li>
            <li>Reveal the endpoint's signing secret and paste it below.</li>
          </ol>
          <div className="capture-secret">
            <strong>Endpoint URL</strong>
            <code>{providerWebhookUrl(base, draft.path)}</code>
            <Button onClick={() => copyUrl(providerWebhookUrl(base, draft.path))}>
              <Copy size={14} aria-hidden /> Copy URL
            </Button>
          </div>
          <div className="capture-webhook-events">
            {STRIPE_WEBHOOK_EVENTS.map((name) => (
              <code key={name}>{name}</code>
            ))}
          </div>
          <div className="capture-webhook-form">
            <Field
              label="Signing secret"
              hint="Starts with whsec_. Stored encrypted and never shown again."
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={signingSecret}
                placeholder="whsec_…"
                onChange={(event) => setSigningSecret(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              disabled={!WHSEC_RE.test(signingSecret.trim()) || busy === 'save'}
              onClick={() => void save()}
            >
              {busy === 'save' && <LoaderCircle className="spin" size={15} aria-hidden />}
              Save and listen
            </Button>
          </div>
          <div className="capture-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setSigningSecret('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDrawer
          title="Stop listening to Stripe?"
          tone="danger"
          body={
            <p>
              Trevra will reject Stripe deliveries to this URL and forget its signing secret.
              Milestones already recorded stay. Delete the endpoint in Stripe as well.
            </p>
          }
          confirmLabel="Remove Stripe endpoint"
          busy={busy === confirmRemove.id}
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </section>
  );
}
```

In `src/client/LeadCaptureSetup.tsx`, add after line 22 (`import { relativeTime } from './LinkedInScreen';`):

```ts
import { ProviderWebhookSetup } from './ProviderWebhookSetup';
```

and replace the closing lines 397-399:

```tsx
      </section>
    </div>
  );
```

with:

```tsx
      </section>
      {isOwner && <ProviderWebhookSetup setToast={setToast} />}
    </div>
  );
```

Append to `src/client/lead-capture.css`, before the `@media (max-width: 780px)` block:

```css
.capture-webhook-endpoint,
.capture-webhook-connect {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.capture-webhook-endpoint header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.capture-webhook-steps {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
}

.capture-webhook-events {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.capture-webhook-form {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 12px;
  align-items: end;
}
```

and inside the existing `@media (max-width: 780px)` block, change the first selector list to:

```css
.capture-create-row,
.capture-source-grid,
.capture-metrics,
.capture-webhook-form {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/client/provider-webhook-view.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

Manual check: run `npm run dev` and sign in as the owner, then open `/setup/capture`. Confirm the "Stripe payments" panel:

- shows Connect Stripe;
- shows the full URL and the four events;
- keeps Save disabled until a `whsec_…` value is typed;
- after saving, shows Listening with counts.

Check it in light and dark themes and at 375px width. The form must stack to one column. Confirm a member account does not see the panel.

- [ ] **Step 5: Commit**

```bash
git add src/client/api.ts src/client/provider-webhook-view.tsx src/client/provider-webhook-view.test.tsx src/client/ProviderWebhookSetup.tsx src/client/LeadCaptureSetup.tsx src/client/lead-capture.css
git commit -m "feat(gtm): connect Stripe from lead capture setup" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 10: Self-reported attribution and first-touch source on Opportunities

**Files:**

- Create: `src/shared/attribution.ts`
- Modify: `src/server/lead-capture/types.ts:1,45-54`
- Create: `src/server/lead-capture/attribution.ts`
- Modify: `src/server/opportunities.ts:1,14-35,46-57,65-90,153-154,179-180`
- Modify: `src/shared/types.ts:289`
- Create: `src/client/inbound-attribution.tsx`
- Modify: `src/client/Opportunities.tsx:13,270-272`
- Test: `src/server/lead-capture/attribution.test.ts`
- Test: `src/client/inbound-attribution.test.ts`

**Interfaces:**

- Consumes: `MILESTONE_KINDS_SQL` (Task 1); `acceptInboundSubmission`, `createCaptureSource`, `createOpportunity` and `listOpportunities` (existing).
- Produces:
  - From `src/shared/attribution.ts`: `HEARD_ABOUT_CHOICES`, `HeardAbout`, `HEARD_ABOUT_LABELS`, `normalizeHeardAbout(value): HeardAbout` and `heardAboutLabel(value): string | null`.
  - `attributionSchema` accepts `heard_about`.
  - From `src/server/lead-capture/attribution.ts`:
    - `ATTRIBUTION_WINDOW_DAYS = 90`;
    - `interface AttributionCount { value; submissions; people; peopleWithOpportunity }`;
    - `interface InboundAttributionSummary { since; days; byUtmSource; byHeardAbout }`;
    - `inboundAttributionSummary(db, workspaceId, now?)`.
  - `OpportunityRecord` (server and shared) gains `sourceUtmSource: string | null` and `sourceHeardAbout: string | null`.
  - From `src/client/inbound-attribution.tsx`: `attributionChips(attribution)` and `opportunitySourceLine(o)`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/lead-capture/attribution.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createOpportunity, listOpportunities } from '../opportunities.js';
import { createCaptureSource } from './sources.js';
import { acceptInboundSubmission } from './submissions.js';
import { inboundSubmissionSchema, type CaptureSourceRecord } from './types.js';
import { inboundAttributionSummary } from './attribution.js';

const WS = 'ws_inbound_attribution';
const OTHER = 'ws_inbound_attribution_other';
const USER = 'usr_inbound_attribution';
const OTHER_USER = 'usr_inbound_attribution_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let source: CaptureSourceRecord;
let otherSource: CaptureSourceRecord;

async function submit(
  from: CaptureSourceRecord,
  key: string,
  kind: string,
  email: string,
  attribution: Record<string, string>,
  receivedAt = NOW
) {
  return acceptInboundSubmission(db, {
    source: from,
    idempotencyKey: key,
    body: inboundSubmissionSchema.parse({ kind, person: { email }, attribution }),
    payloadHash: `hash-${key}`,
    receivedAt
  });
}

async function clear(): Promise<void> {
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

beforeEach(async () => {
  await clear();
  for (const [workspaceId, userId] of [
    [WS, USER],
    [OTHER, OTHER_USER]
  ]) {
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@attr.test`, userId, NOW.toISOString());
  }
  source = (
    await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Site',
      kind: 'website'
    })
  ).source;
  otherSource = (
    await createCaptureSource(db, {
      workspaceId: OTHER,
      actorUserId: OTHER_USER,
      name: 'Site',
      kind: 'website'
    })
  ).source;
});

afterAll(async () => {
  await clear();
  await db?.close();
});

describe('self-reported attribution', () => {
  it('normalises heard_about to the bounded list and drops free text', () => {
    const parse = (heard: unknown) =>
      inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'a@b.test' },
        attribution: { heard_about: heard }
      }).attribution?.heard_about;
    expect(parse('Podcast')).toBe('podcast');
    expect(parse(' AI assistant ')).toBe('ai_assistant');
    expect(parse('ai-assistant')).toBe('ai_assistant');
    expect(parse('my cousin told me')).toBe('other');
    expect(() => parse('x'.repeat(121))).toThrow();
    expect(() =>
      inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'a@b.test' },
        attribution: { referrer_note: 'x' }
      })
    ).toThrow();
  });

  it('counts 90 days by utm_source and heard_about, without milestones or other workspaces', async () => {
    const ada = await submit(source, 'attr-ada-001', 'demo_request', 'ada@attr.test', {
      utm_source: 'Newsletter',
      heard_about: 'Podcast'
    });
    await submit(source, 'attr-ada-002', 'pricing_request', 'ada@attr.test', {
      utm_source: 'newsletter'
    });
    await submit(source, 'attr-bob-001', 'contact_message', 'bob@attr.test', {
      utm_source: 'newsletter'
    });
    await submit(source, 'attr-cy-001', 'contact_message', 'cy@attr.test', {
      heard_about: 'github'
    });
    await submit(source, 'attr-dee-001', 'signed_up', 'dee@attr.test', {
      utm_source: 'newsletter',
      heard_about: 'podcast'
    });
    await submit(
      source,
      'attr-old-001',
      'demo_request',
      'old@attr.test',
      { utm_source: 'newsletter' },
      new Date(NOW.getTime() - 100 * 86_400_000)
    );
    await submit(otherSource, 'attr-other-001', 'demo_request', 'ada@attr.test', {
      utm_source: 'newsletter'
    });
    await createOpportunity(db, { workspaceId: WS, personId: ada.contactId, title: 'Ada' }, NOW);

    const summary = await inboundAttributionSummary(db, WS, NOW);
    expect(summary.days).toBe(90);
    expect(summary.byUtmSource).toEqual([
      { value: 'newsletter', submissions: 3, people: 2, peopleWithOpportunity: 1 }
    ]);
    expect(summary.byHeardAbout).toEqual([
      { value: 'github', submissions: 1, people: 1, peopleWithOpportunity: 0 },
      { value: 'podcast', submissions: 1, people: 1, peopleWithOpportunity: 1 }
    ]);
  });

  it('shows first-touch attribution on the Opportunity', async () => {
    const first = await submit(
      source,
      'attr-src-001',
      'demo_request',
      'eve@attr.test',
      { utm_source: 'linkedin', heard_about: 'Social' },
      new Date(NOW.getTime() - 2 * 86_400_000)
    );
    await submit(source, 'attr-src-002', 'pricing_request', 'eve@attr.test', {
      utm_source: 'google'
    });
    const opportunity = await createOpportunity(
      db,
      { workspaceId: WS, personId: first.contactId, title: 'Eve' },
      NOW
    );
    expect(opportunity).toMatchObject({ sourceUtmSource: 'linkedin', sourceHeardAbout: 'social' });
    const [listed] = await listOpportunities(db, WS);
    expect(listed).toMatchObject({ sourceUtmSource: 'linkedin', sourceHeardAbout: 'social' });
  });
});
```

Create `src/client/inbound-attribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { attributionChips, opportunitySourceLine } from './inbound-attribution';

describe('inbound attribution display', () => {
  it('splits the self-reported channel from the UTM chips', () => {
    expect(
      attributionChips({ utm_source: 'newsletter', heard_about: 'podcast', utm_medium: '' })
    ).toEqual({ heardAbout: 'Podcast', utm: [['utm_source', 'newsletter']] });
    expect(attributionChips({})).toEqual({ heardAbout: null, utm: [] });
  });

  it('describes where an Opportunity came from', () => {
    expect(
      opportunitySourceLine({ sourceHeardAbout: 'ai_assistant', sourceUtmSource: 'chatgpt.com' })
    ).toBe('Source: heard about us via AI assistant · utm_source=chatgpt.com');
    expect(opportunitySourceLine({ sourceHeardAbout: null, sourceUtmSource: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/attribution.test.ts src/client/inbound-attribution.test.ts`
Expected: FAIL with `Cannot find module './attribution.js'` and `Cannot find module './inbound-attribution'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/attribution.ts`:

```ts
/**
 * Self-reported "how did you hear about us", bounded. The form may send free
 * text; only one of these choices is ever stored, and anything else becomes
 * 'other'. That keeps the answer countable and content-free.
 */
export const HEARD_ABOUT_CHOICES = [
  'search',
  'ai_assistant',
  'social',
  'community',
  'github',
  'newsletter',
  'podcast',
  'event',
  'referral',
  'partner',
  'other'
] as const;

export type HeardAbout = (typeof HEARD_ABOUT_CHOICES)[number];

export const HEARD_ABOUT_LABELS: Record<HeardAbout, string> = {
  search: 'Search engine',
  ai_assistant: 'AI assistant',
  social: 'Social media',
  community: 'Community or forum',
  github: 'GitHub',
  newsletter: 'Newsletter',
  podcast: 'Podcast',
  event: 'Event',
  referral: 'Referral',
  partner: 'Partner',
  other: 'Other'
};

const CHOICES = new Set<string>(HEARD_ABOUT_CHOICES);

export function normalizeHeardAbout(value: string): HeardAbout {
  const key = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CHOICES.has(key) ? (key as HeardAbout) : 'other';
}

export function heardAboutLabel(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return HEARD_ABOUT_LABELS[normalizeHeardAbout(value)];
}
```

In `src/server/lead-capture/types.ts`, add after line 1 (`import { z } from 'zod';`):

```ts
import { normalizeHeardAbout } from '../../shared/attribution.js';
```

and replace the `attributionSchema` (lines 45-54) with:

```ts
export const attributionSchema = z
  .object({
    utm_source: boundedString(200).optional(),
    utm_medium: boundedString(200).optional(),
    utm_campaign: boundedString(300).optional(),
    utm_term: boundedString(300).optional(),
    utm_content: boundedString(300).optional(),
    // Self-reported channel; stored only as one of HEARD_ABOUT_CHOICES.
    heard_about: z.string().trim().min(1).max(120).transform(normalizeHeardAbout).optional()
  })
  .strict()
  .default({});
```

Create `src/server/lead-capture/attribution.ts`:

```ts
import type { Db } from '../db.js';
import { MILESTONE_KINDS_SQL } from './milestones.js';

export const ATTRIBUTION_WINDOW_DAYS = 90;

export interface AttributionCount {
  value: string;
  submissions: number;
  people: number;
  peopleWithOpportunity: number;
}

export interface InboundAttributionSummary {
  since: string;
  days: number;
  byUtmSource: AttributionCount[];
  byHeardAbout: AttributionCount[];
}

const ATTRIBUTION_FIELDS = ['utm_source', 'heard_about'] as const;
type AttributionField = (typeof ATTRIBUTION_FIELDS)[number];

async function countBy(
  db: Db,
  workspaceId: string,
  since: string,
  field: AttributionField
): Promise<AttributionCount[]> {
  // `field` comes from the closed tuple above, never from input.
  const rows = await db
    .prepare(
      `WITH recent AS (
         SELECT s.contact_id,
                NULLIF(LOWER(BTRIM(s.attribution_json->>'${field}')),'') AS value
         FROM inbound_submissions s
         WHERE s.workspace_id=? AND s.received_at>=?::timestamptz
           AND s.kind NOT IN ${MILESTONE_KINDS_SQL}
       ),
       opportunity_people AS (
         SELECT DISTINCT person_id FROM opportunities
         WHERE workspace_id=? AND person_id IS NOT NULL
       )
       SELECT r.value,
              COUNT(*)::int AS submissions,
              COUNT(DISTINCT r.contact_id)::int AS people,
              COUNT(DISTINCT op.person_id)::int AS people_with_opportunity
       FROM recent r
       LEFT JOIN opportunity_people op ON op.person_id=r.contact_id
       WHERE r.value IS NOT NULL
       GROUP BY r.value
       ORDER BY people DESC, r.value ASC
       LIMIT 12`
    )
    .all<{
      value: string;
      submissions: number;
      people: number;
      people_with_opportunity: number;
    }>(workspaceId, since, workspaceId);
  return rows.map((row) => ({
    value: String(row.value),
    submissions: Number(row.submissions),
    people: Number(row.people),
    peopleWithOpportunity: Number(row.people_with_opportunity)
  }));
}

/**
 * A deliberately small read model: where inbound people came from over the
 * last 90 days. Counts only; no person, message or page content.
 */
export async function inboundAttributionSummary(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<InboundAttributionSummary> {
  const since = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
  const [byUtmSource, byHeardAbout] = await Promise.all([
    countBy(db, workspaceId, since, 'utm_source'),
    countBy(db, workspaceId, since, 'heard_about')
  ]);
  return { since, days: ATTRIBUTION_WINDOW_DAYS, byUtmSource, byHeardAbout };
}
```

In `src/server/opportunities.ts`:

1. Replace line 1 with:

```ts
import { id, type Db } from './db.js';
import { MILESTONE_KINDS_SQL } from './lead-capture/milestones.js';
```

2. In `interface OpportunityRecord`, replace `  closedAt: string | null;\n}` (lines 34-35) with:

```ts
  closedAt: string | null;
  /** First-touch `utm_source` from the Person's earliest attributed inbound submission. */
  sourceUtmSource: string | null;
  /** First-touch self-reported channel (one of HEARD_ABOUT_CHOICES). */
  sourceHeardAbout: string | null;
}
```

3. Replace the end of the `SELECT` constant (lines 56-57):

```ts
  o.created_at,o.updated_at,o.closed_at
`;
```

with:

```ts
  o.created_at,o.updated_at,o.closed_at,
  src.utm_source AS source_utm_source,src.heard_about AS source_heard_about
`;

// First touch: the Person's earliest non-milestone inbound submission that
// carried a UTM source or a self-reported channel.
const SOURCE_JOIN = `
    LEFT JOIN LATERAL (
      SELECT NULLIF(BTRIM(s.attribution_json->>'utm_source'),'') AS utm_source,
             NULLIF(BTRIM(s.attribution_json->>'heard_about'),'') AS heard_about
      FROM inbound_submissions s
      WHERE s.workspace_id=o.workspace_id AND s.contact_id=o.person_id
        AND s.kind NOT IN ${MILESTONE_KINDS_SQL}
        AND (NULLIF(BTRIM(s.attribution_json->>'utm_source'),'') IS NOT NULL
          OR NULLIF(BTRIM(s.attribution_json->>'heard_about'),'') IS NOT NULL)
      ORDER BY s.received_at ASC,s.id ASC
      LIMIT 1
    ) src ON TRUE`;
```

4. In `serialize`, replace `    closedAt: iso(row.closed_at)\n  };` with:

```ts
    closedAt: iso(row.closed_at),
    sourceUtmSource: row.source_utm_source ? String(row.source_utm_source) : null,
    sourceHeardAbout: row.source_heard_about ? String(row.source_heard_about) : null
  };
```

5. In both `listOpportunities` (line 154) and `getOpportunity` (line 180), replace the line

```ts
    LEFT JOIN agents ag ON o.owner_type='agent' AND ag.workspace_id=o.workspace_id AND ag.id=o.owner_id
```

with:

```ts
    LEFT JOIN agents ag ON o.owner_type='agent' AND ag.workspace_id=o.workspace_id AND ag.id=o.owner_id
    ${SOURCE_JOIN}
```

In `src/shared/types.ts`, replace line 289-290 (`  closedAt: string | null;\n}` inside `OpportunityRecord`) with:

```ts
  closedAt: string | null;
  sourceUtmSource: string | null;
  sourceHeardAbout: string | null;
}
```

Create `src/client/inbound-attribution.tsx`:

```tsx
import { heardAboutLabel } from '../shared/attribution';
import type { OpportunityRecord } from '../shared/types';

/** The self-reported channel as its own chip; UTM keys as `key=value` chips. */
export function attributionChips(attribution: Record<string, unknown>): {
  heardAbout: string | null;
  utm: Array<[string, string]>;
} {
  const heard = attribution.heard_about;
  const heardAbout = typeof heard === 'string' ? heardAboutLabel(heard) : null;
  const utm = Object.entries(attribution)
    .filter(
      ([key, value]) =>
        key !== 'heard_about' && value !== undefined && value !== null && String(value).trim()
    )
    .map(([key, value]) => [key, String(value)] as [string, string]);
  return { heardAbout, utm };
}

export function opportunitySourceLine(
  opportunity: Pick<OpportunityRecord, 'sourceHeardAbout' | 'sourceUtmSource'>
): string | null {
  const heard = heardAboutLabel(opportunity.sourceHeardAbout);
  const parts = [
    heard ? `heard about us via ${heard}` : null,
    opportunity.sourceUtmSource ? `utm_source=${opportunity.sourceUtmSource}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `Source: ${parts.join(' · ')}` : null;
}
```

In `src/client/Opportunities.tsx`, add after line 13 (`import { errorMessage } from './LinkedInSafety';`):

```ts
import { opportunitySourceLine } from './inbound-attribution';
```

and replace lines 270-272:

```tsx
{
  opportunity.originRecommendationId && <small>Created from qualified first-party demand</small>;
}
```

with:

```tsx
{
  opportunity.originRecommendationId && <small>Created from qualified first-party demand</small>;
}
{
  opportunitySourceLine(opportunity) && <small>{opportunitySourceLine(opportunity)}</small>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/attribution.test.ts src/client/inbound-attribution.test.ts src/server/opportunities.test.ts src/server/lead-capture/lead-capture.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/attribution.ts src/server/lead-capture/types.ts src/server/lead-capture/attribution.ts src/server/lead-capture/attribution.test.ts src/server/opportunities.ts src/shared/types.ts src/client/inbound-attribution.tsx src/client/inbound-attribution.test.ts src/client/Opportunities.tsx
git commit -m "feat(gtm): add self-reported attribution and opportunity source" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 11: Inbound milestones and attribution on `/outreach/inbound`, then the final gate

**Files:**

- Modify: `src/server/app.ts` (imports; routes after `/api/inbound/submissions`, line 1395)
- Modify: `src/client/api.ts` (after `getInboundSubmissions`, line 3574)
- Create: `src/client/inbound-milestones.tsx`
- Modify: `src/client/inbound-attribution.tsx` (add `AttributionTables`)
- Modify: `src/client/InboundPeople.tsx:1-37,126-169,303-543`
- Modify: `src/client/lead-capture.css` (append)
- Test: `src/server/lead-capture/inbound-reads.test.ts`
- Test: `src/client/inbound-milestones.test.tsx`

**Interfaces:**

- Consumes: `listProductMilestones` and `ProductMilestoneView` (Task 4); `inboundAttributionSummary` and `InboundAttributionSummary` (Task 10); `attributionChips` (Task 10); `isMilestoneKind` and `GTM_MILESTONE_KINDS` from `src/shared/milestones.ts`; `scrollToId` from `./ui/scrollToId`.
- Produces:
  - Workspace-visible reads (scoped to `req.auth.workspaceId`): `GET /api/inbound/milestones?limit=` returns `{ milestones: ProductMilestoneView[] }`, and `GET /api/inbound/attribution` returns `InboundAttributionSummary`.
  - In the client: `InboundMilestone`, `getInboundMilestones`, `InboundAttributionSummary` and `getInboundAttribution`; `MilestoneSection`; `AttributionTables`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/lead-capture/inbound-reads.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';
import { createCaptureSource } from './sources.js';
import { acceptInboundSubmission } from './submissions.js';
import { inboundSubmissionSchema } from './types.js';
import { recordProductMilestone } from './milestone-recorder.js';

let db: Db;
let app: Express;
let session = '';
const WS = 'ws_inbound_reads';
const OTHER = 'ws_inbound_reads_other';
const USER = 'usr_inbound_reads';

async function seedContact(workspaceId: string, email: string): Promise<string> {
  const contactId = id('con');
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(contactId, workspaceId, 'Read Person', email, email, now, now);
  return contactId;
}

async function clear(): Promise<void> {
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await clear();
  const now = new Date().toISOString();
  for (const workspaceId of [WS, OTHER])
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, now);
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'reads@trevra.test', 'Reads', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  session = token;
});

afterAll(async () => {
  await clear();
  await db?.close();
  await closeAuthDatabase();
});

describe('inbound reads', () => {
  it('lists this workspace milestones only', async () => {
    const mine = await seedContact(WS, 'mine@reads.test');
    const theirs = await seedContact(OTHER, 'theirs@reads.test');
    const recorded = await recordProductMilestone(db, {
      workspaceId: WS,
      kind: 'paid',
      contactId: mine,
      accountId: null,
      sourceType: 'inbound_submission',
      sourceId: 'sub_reads_mine',
      occurredAt: new Date()
    });
    await recordProductMilestone(db, {
      workspaceId: OTHER,
      kind: 'paid',
      contactId: theirs,
      accountId: null,
      sourceType: 'inbound_submission',
      sourceId: 'sub_reads_theirs',
      occurredAt: new Date()
    });
    const response = await request(app)
      .get('/api/inbound/milestones?limit=20')
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    expect(response.body.milestones).toHaveLength(1);
    expect(response.body.milestones[0]).toMatchObject({
      id: recorded.milestone.id,
      kind: 'paid',
      label: 'paid',
      personEmail: 'mine@reads.test'
    });
  });

  it('returns the 90-day attribution summary', async () => {
    const { source } = await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Site',
      kind: 'website'
    });
    await acceptInboundSubmission(db, {
      source,
      idempotencyKey: 'reads-attr-0001',
      body: inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'attr@reads.test' },
        attribution: { utm_source: 'newsletter', heard_about: 'podcast' }
      }),
      payloadHash: 'reads-attr-0001'
    });
    const response = await request(app)
      .get('/api/inbound/attribution')
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    expect(response.body).toMatchObject({
      days: 90,
      byUtmSource: [{ value: 'newsletter', submissions: 1, people: 1 }],
      byHeardAbout: [{ value: 'podcast', submissions: 1, people: 1 }]
    });
  });
});
```

Create `src/client/inbound-milestones.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboundMilestone } from './api';
import { MilestoneSection } from './inbound-milestones';
import { AttributionTables } from './inbound-attribution';

const milestone: InboundMilestone = {
  id: 'pm_0123456789abcdef',
  workspaceId: 'ws_1',
  kind: 'paid',
  contactId: 'con_1',
  accountId: 'acc_1',
  sourceType: 'stripe_event',
  sourceId: 'evt_1',
  providerEndpointId: 'pwh_0123456789abcdef01234567',
  externalObjectId: 'cs_1',
  occurredAt: '2026-10-06T09:00:00.000Z',
  createdAt: '2026-10-06T09:00:00.000Z',
  label: 'paid',
  personName: 'Ada Lovelace',
  personEmail: 'ada@acme.test',
  accountName: 'Acme'
};

describe('inbound milestones and attribution', () => {
  it('anchors each milestone for the Today link', () => {
    const html = renderToStaticMarkup(<MilestoneSection milestones={[milestone]} />);
    expect(html).toContain('id="milestone-pm_0123456789abcdef"');
    expect(html).toContain('Acme');
    expect(html).toContain('paid');
    expect(html).toContain('Stripe');
    expect(html).toContain('2026-10-06');
  });

  it('explains how to send milestones when there are none', () => {
    const html = renderToStaticMarkup(<MilestoneSection milestones={[]} />);
    expect(html).toContain('No milestones yet');
    expect(html).toContain('usage_threshold_crossed');
  });

  it('renders both 90-day attribution tables with readable channel names', () => {
    const html = renderToStaticMarkup(
      <AttributionTables
        summary={{
          since: '2026-07-08T09:00:00.000Z',
          days: 90,
          byUtmSource: [
            { value: 'newsletter', submissions: 3, people: 2, peopleWithOpportunity: 1 }
          ],
          byHeardAbout: [{ value: 'podcast', submissions: 1, people: 1, peopleWithOpportunity: 1 }]
        }}
      />
    );
    expect(html).toContain('Where inbound came from (90 days)');
    expect(html).toContain('newsletter');
    expect(html).toContain('Podcast');
    expect(html).toContain('With opportunity');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/inbound-reads.test.ts src/client/inbound-milestones.test.tsx`
Expected: FAIL. `/api/inbound/milestones` returns 404, and `./inbound-milestones` cannot be found.

- [ ] **Step 3: Write the implementation**

In `src/server/app.ts`, add after line 492 (`import { listInboundSubmissions } from './lead-capture/submissions.js';`):

```ts
import { listProductMilestones } from './lead-capture/milestone-recorder.js';
import { inboundAttributionSummary } from './lead-capture/attribution.js';
```

After the `/api/inbound/submissions` route (closes at line 1395), add:

```ts
app.get('/api/inbound/milestones', async (req: AuthedRequest, res, next) => {
  try {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    res.json({ milestones: await listProductMilestones(db, req.auth!.workspaceId, limit) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inbound/attribution', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await inboundAttributionSummary(db, req.auth!.workspaceId));
  } catch (error) {
    next(error);
  }
});
```

In `src/client/api.ts`, add at the top with the other type imports:

```ts
import type { GtmMilestoneKind } from '../shared/milestones';
```

and after `getInboundSubmissions` (ends line 3574), add:

```ts
export interface InboundMilestone {
  id: string;
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: 'inbound_submission' | 'stripe_event';
  sourceId: string;
  providerEndpointId: string | null;
  externalObjectId: string | null;
  occurredAt: string;
  createdAt: string;
  label: string;
  personName: string | null;
  personEmail: string | null;
  accountName: string | null;
}

export async function getInboundMilestones(limit = 50): Promise<InboundMilestone[]> {
  const result = await request<{ milestones: InboundMilestone[] }>(
    `/api/inbound/milestones?limit=${limit}`
  );
  return result.milestones;
}

export interface InboundAttributionCount {
  value: string;
  submissions: number;
  people: number;
  peopleWithOpportunity: number;
}

export interface InboundAttributionSummary {
  since: string;
  days: number;
  byUtmSource: InboundAttributionCount[];
  byHeardAbout: InboundAttributionCount[];
}

export async function getInboundAttribution(): Promise<InboundAttributionSummary> {
  return request('/api/inbound/attribution');
}
```

Create `src/client/inbound-milestones.tsx`:

```tsx
import type { InboundMilestone } from './api';
import { GTM_MILESTONE_KINDS } from '../shared/milestones';

/**
 * Product milestones are outcomes, not leads: they are listed here as
 * evidence (each anchored for the Today link and the account signal's
 * evidence URL), never as decision cards.
 */
export function MilestoneSection({ milestones }: { milestones: InboundMilestone[] }) {
  return (
    <section className="page-panel" aria-labelledby="inbound-milestones-title">
      <div className="section-heading">
        <div>
          <h3 id="inbound-milestones-title">Product milestones</h3>
          <p>Signups, activation, payments and cancellations reported by your product or Stripe.</p>
        </div>
      </div>
      {milestones.length === 0 ? (
        <div className="empty-state">
          <h4>No milestones yet</h4>
          <p>
            Send one of{' '}
            {GTM_MILESTONE_KINDS.map((kind, index) => (
              <span key={kind}>
                {index > 0 && ', '}
                <code>{kind}</code>
              </span>
            ))}{' '}
            as the <code>kind</code> through a capture source, or connect Stripe in Setup → Lead
            capture.
          </p>
        </div>
      ) : (
        <ul className="capture-milestone-list">
          {milestones.map((milestone) => (
            <li key={milestone.id} id={`milestone-${milestone.id}`}>
              <strong>
                {milestone.accountName ||
                  milestone.personName ||
                  milestone.personEmail ||
                  'A customer'}
              </strong>
              <span>{milestone.label}</span>
              <small>
                {milestone.sourceType === 'stripe_event' ? 'Stripe' : 'Your product'} ·{' '}
                <time dateTime={milestone.occurredAt}>{milestone.occurredAt.slice(0, 10)}</time>
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

In `src/client/inbound-attribution.tsx`, add this import after line 2 (`import type { OpportunityRecord } from '../shared/types';`):

```ts
import type { InboundAttributionCount, InboundAttributionSummary } from './api';
```

Then append to the end of the same file:

```tsx
function AttributionTable({
  caption,
  rows,
  label
}: {
  caption: string;
  rows: InboundAttributionCount[];
  label: (value: string) => string;
}) {
  return (
    <div className="li-table-scroll">
      <table className="li-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Channel</th>
            <th scope="col" className="li-num">
              People
            </th>
            <th scope="col" className="li-num">
              Submissions
            </th>
            <th scope="col" className="li-num">
              With opportunity
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="li-hint">
                Nothing reported yet.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.value}>
                <td>{label(row.value)}</td>
                <td className="li-num">{row.people}</td>
                <td className="li-num">{row.submissions}</td>
                <td className="li-num">{row.peopleWithOpportunity}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function AttributionTables({ summary }: { summary: InboundAttributionSummary }) {
  return (
    <section className="page-panel" aria-labelledby="inbound-attribution-title">
      <div className="section-heading">
        <div>
          <h3 id="inbound-attribution-title">Where inbound came from ({summary.days} days)</h3>
          <p>UTM source and the channel people said they heard about you from.</p>
        </div>
      </div>
      <div className="capture-attribution">
        <AttributionTable
          caption="Heard about us"
          rows={summary.byHeardAbout}
          label={(value) => heardAboutLabel(value) ?? value}
        />
        <AttributionTable
          caption="utm_source"
          rows={summary.byUtmSource}
          label={(value) => value}
        />
      </div>
    </section>
  );
}
```

In `src/client/InboundPeople.tsx`:

1. Extend the `./api` import (lines 13-31) with `getInboundAttribution`, `getInboundMilestones`, `type InboundAttributionSummary` and `type InboundMilestone`. Then add after line 37 (`import './lead-capture.css';`):

```ts
import { isMilestoneKind } from '../shared/milestones';
import { scrollToId } from './ui/scrollToId';
import { AttributionTables, attributionChips } from './inbound-attribution';
import { MilestoneSection } from './inbound-milestones';
```

2. After line 136 (`const [problem, setProblem] = useState('');`), add:

```ts
const [milestones, setMilestones] = useState<InboundMilestone[]>([]);
const [attribution, setAttribution] = useState<InboundAttributionSummary | null>(null);
```

3. Replace the non-strict batch (lines 150-155) with:

```ts
const [
  nextOpportunities,
  nextSuppressions,
  nextLists,
  nextAccounts,
  nextMilestones,
  nextAttribution
] = await Promise.all([
  getOpportunities().catch(() => [] as OpportunityRecord[]),
  getSuppressions().catch(() => [] as SuppressionSummary[]),
  getLinkedInManagerLeadLists().catch(() => [] as LinkedInLeadList[]),
  getRankedAccounts({ limit: 500 }).catch(() => [] as RankedAccount[]),
  getInboundMilestones().catch(() => [] as InboundMilestone[]),
  getInboundAttribution().catch(() => null)
]);
```

and after `setAccounts(nextAccounts);` add:

```ts
setMilestones(nextMilestones);
setAttribution(nextAttribution);
```

4. After the `useEffect(() => { void load(); }, [load]);` block (lines 171-173), add:

```ts
// Milestones are outcomes, not decisions: their submissions stay as
// provenance but never render as qualify/pursue cards.
const decisionSubmissions = useMemo(
  () => submissions.filter((submission) => !isMilestoneKind(submission.kind)),
  [submissions]
);

// `/outreach/inbound?milestone=<id>` is the evidence link on the account
// signal and the Today item: scroll to that row once the list has loaded.
useEffect(() => {
  if (loading) return;
  const target = new URLSearchParams(window.location.search).get('milestone');
  if (!target) return;
  return scrollToId(`milestone-${target}`);
}, [loading]);
```

5. In the render, replace `{!loading && submissions.length === 0 && (` with `{!loading && decisionSubmissions.length === 0 && (`. Replace `{submissions.length > 0 && (` with `{decisionSubmissions.length > 0 && (`. Replace `{submissions.map((submission) => {` with `{decisionSubmissions.map((submission) => {`.

6. Replace lines 338-340:

```tsx
const utm = Object.entries(submission.attribution).filter(
  ([, value]) => value !== undefined && value !== null && String(value)
);
```

with:

```tsx
const { heardAbout, utm } = attributionChips(submission.attribution);
```

and replace lines 385-393:

```tsx
{
  utm.length > 0 && (
    <div className="capture-tags">
      {utm.map(([key, value]) => (
        <span key={key}>
          {key}={String(value)}
        </span>
      ))}
    </div>
  );
}
```

with:

```tsx
{
  (utm.length > 0 || heardAbout) && (
    <div className="capture-tags">
      {heardAbout && <span>Heard about us: {heardAbout}</span>}
      {utm.map(([key, value]) => (
        <span key={key}>
          {key}={value}
        </span>
      ))}
    </div>
  );
}
```

7. Replace the closing lines 540-542:

```tsx
      </section>
    </div>
  );
```

with:

```tsx
      </section>
      <MilestoneSection milestones={milestones} />
      {attribution && <AttributionTables summary={attribution} />}
    </div>
  );
```

Append to `src/client/lead-capture.css`, before the `@media (max-width: 780px)` block:

```css
.capture-milestone-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capture-milestone-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.capture-milestone-list small {
  color: var(--t-muted);
  font-size: var(--t-text-xs);
}

.capture-attribution {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
```

- [ ] **Step 4: Run tests and the full gate**

Run: `npx tsx scripts/test-with-postgres.ts src/server/lead-capture/inbound-reads.test.ts src/client/inbound-milestones.test.tsx src/client/inbound-attribution.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: every test passes, the build succeeds, exit 0. `src/client/ui/route.test.ts` passes, because no `#/` literal or `location.hash` was added.

Run: `npm audit --omit=dev`
Expected: no advisory introduced by this phase.

Manual check: run `npm run dev`, then send a signed `activated` submission from the Setup → Lead capture test recipe with `"kind":"activated"`. Confirm:

- Today shows "<Account> activated" under recent results;
- its link opens `/outreach/inbound?milestone=pm_…` and scrolls to the row;
- no decision card appears for that submission;
- the attribution tables render.

Check it in light and dark themes and at 375px width.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/lead-capture/inbound-reads.test.ts src/client/api.ts src/client/inbound-milestones.tsx src/client/inbound-milestones.test.tsx src/client/inbound-attribution.tsx src/client/InboundPeople.tsx src/client/lead-capture.css
git commit -m "feat(gtm): show milestones and attribution on inbound" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Self-review

**1. Spec coverage**

| Requirement                                                                                                                      | Task                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Contract 1: `STAGE_RANK`, `advanceOpportunityStage`, forward-only, idempotent per source, events                                 | 3                                                                                                             |
| Contract 2: table `provider_webhook_endpoints`                                                                                   | 1                                                                                                             |
| Contract 2: the module's exports, `POST /api/hooks/v1/:provider/:endpointId` with `express.raw`, `createProviderWebhookEndpoint` | 6                                                                                                             |
| Contract 2: generic registry, so Phase B adds Cal.com via `registerProviderVerifier`                                             | 6                                                                                                             |
| Contract 2: owner-only `/api/setup/webhooks`                                                                                     | 8                                                                                                             |
| Contract 2: UI on `/setup/capture`                                                                                               | 9                                                                                                             |
| Contract 3: `GTM_MILESTONE_KINDS`, `isMilestoneKind` and the seven signal kinds with weights                                     | 1                                                                                                             |
| Contract 5: `milestone_reached` in recentResults, `customer_cancelled` in needsAttention                                         | 5                                                                                                             |
| Migration `130_*`                                                                                                                | 1                                                                                                             |
| Intake milestones: kept as `inbound_submissions` provenance, signal with an in-app `evidenceUrl`, rescore, stage moves per kind  | 4                                                                                                             |
| Intake milestones: out-of-order and duplicate safety                                                                             | 4 (test), 7 (Stripe test)                                                                                     |
| Milestones are never `inbound_submission` attention or qualified demand                                                          | 5 (Today, inbound demand path), 2 (hot-account evidence path)                                                 |
| Stripe: per-workspace endpoint, URL shown, `whsec_` sealed, `constructEvent`, `npm audit`                                        | 6, 7, 8, 9                                                                                                    |
| Stripe: event mapping and the documented upgrade rule                                                                            | 7                                                                                                             |
| Stripe: Person by email, Account by non-freemail domain                                                                          | 7                                                                                                             |
| Stripe: ids only, the same recorder as intake                                                                                    | 7                                                                                                             |
| Attribution: bounded `heard_about`, shown on inbound people and Opportunity sources                                              | 10, 11                                                                                                        |
| Attribution: 90-day grouped count on an existing screen                                                                          | 10 (query), 11 (route and UI)                                                                                 |
| Owner-only management, workspace scoping, idempotent writes                                                                      | 6, 8 (all writes are keyed: milestone key, source ledger, endpoint id, `webhook_events`)                      |
| Durable state has a closer                                                                                                       | Endpoints: DELETE plus cascade. Milestones: contact/workspace cascade. Ledger: Opportunity/workspace cascade. |

**2. Placeholder scan**

No "TBD", "TODO", "implement later" or "similar to Task N" appears. Every code step has complete code, and every run step has an exact command and expected result. The only commands that are not self-verifying are the `npm audit` result and the manual UI checks; their expected outcomes are stated.

**3. Type consistency**

The following names and types were checked across tasks:

- `RecordProductMilestoneInput` and `recordProductMilestone(db, input, now?)`: Task 4 defines them; Tasks 5, 7 and 11 call them with `{ workspaceId, kind, contactId, accountId, sourceType, sourceId, providerEndpointId?, externalObjectId?, occurredAt }`.
- `AdvanceOpportunityResult`: Task 3 defines it; Task 4 returns it.
- `ProviderWebhookVerifier.verify(rawBody, headers, secret, now)` and `handle(db, endpoint, event, now)`: identical in the Task 6 types, Task 6's fake verifier and Task 7's `stripeVerifier`.
- `withProviderWebhookPath` and `providerWebhookPath`: Task 6 defines them; Task 8 uses them.
- The client `ProviderWebhookEndpointSummary` matches the server endpoint plus `path`.
- `InboundMilestone` mirrors `ProductMilestoneView`.
- `InboundAttributionSummary` mirrors the server summary.
- `OpportunityRecord.sourceUtmSource` and `sourceHeardAbout` are added to both `src/server/opportunities.ts` and `src/shared/types.ts`.
- `UNCITABLE_SIGNAL_KINDS_SQL` (Task 2) and `MILESTONE_KINDS_SQL` (Task 1) are distinct names with distinct contents.

**4. Review Focus**

All five items have a test in their owning task:

1. Task 4 ("paid before activated, and duplicates") and Task 7 ("however often Stripe retries").
2. Task 7 ("only to the endpoint workspace") and Task 6 ("never across workspaces"). Tasks 3 and 4 also reject foreign ids.
3. Task 6 ("rejects a bad signature and a paused endpoint").
4. Task 7 ("stores ids only").
5. Task 5 ("never as inbound", "never turns a milestone submission into demand evidence") and Task 2 ("refuses a first-party kind", "is the exclusion every evidence query uses", "never builds a demand recommendation from first-party milestones alone").

**Execution order note**

Tasks are sequential:

- Task 5 needs Task 4.
- Task 7 needs Tasks 4 and 6.
- Task 8 needs Task 7, because `createApp` must register the Stripe verifier for `providers` to include `'stripe'`.
- Task 11 needs Tasks 4 and 10.

**Open questions for the founder**

These do not block execution; the plan's defaults are stated.

1. Pin `stripe@^22.6.2` (the plan's choice) or take the 23.x major that shipped 2026-10-01?
2. Should Stripe test-mode events stay ignored? They are counted as verified deliveries but never become milestones.
3. Should subscription events for a customer Trevra never saw pay stay ignored? Observe-only means there is no API key to look the customer up.
4. If a person's only Opportunity is `lost` and they then pay, contract 1 leaves the lost row unchanged and creates nothing. Should a payment create a fresh `won` Opportunity instead?
5. Are the `heard_about` choices, and the weights (activation 30 down to a cancellation at −20), right for LemonCrow and Beseam?
