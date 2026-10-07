# GTM Integration Roadmap (LemonCrow + Beseam coverage)

> **For agentic workers:** This is the index. Each phase below has its own executable plan. REQUIRED SUB-SKILL for every phase plan: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Execute phases in the order listed; each phase plan is self-contained and ends with `npm run check` green.

**Goal:** Close the GTM gaps from the LemonCrow/Beseam research by connecting free, cheap or open-source services through Trevra's existing primitives (Signal, Objective, Prepared action, Outcome), without adding a navigation section or owning post-sale state.

**Architecture:** Outside services only _feed_ Trevra (webhooks, Nango syncs, the existing signed intake) or are _called_ through the existing approval/execution boundary. Every new input lands as an account signal, an inbound submission, a conversation entry, or an Opportunity stage change, and surfaces in Today. Provider-specific shapes stop at a normalizer; tables hold Trevra's canonical shape so any provider can be swapped.

**Tech Stack:** TypeScript, Express, PostgreSQL (forward-only migrations), Nango, Zod, Vitest with a real PostgreSQL container, React client.

**Spec:** `reports/LemonCrow and Beseam GTM needs.md` (research report, "Prioritized gap list" and "Design principles" sections) plus the integration shortlist agreed in session on 2026-10-06 (Cal.com, Stripe webhooks, GitHub API, signed intake for milestones, Cloudflare Worker / Formbricks / Tally forms, Hunter BYO key, Beseam citation samples, UTM + self-reported attribution, Gmail/M365 inbound sync, DNS deliverability checks, List-Unsubscribe; in-house: jurisdiction consent, founder-level LinkedIn budget, human-send mode).

## Phases

| Phase | Plan file                                           | Scope                                                                                                                                                                                             | Migration |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A     | `2026-10-06-gtm-a-milestones-stripe-attribution.md` | Closed product-milestone vocabulary on the signed intake; Stripe observe-only webhook; shared provider-webhook endpoint module; forward-only Opportunity stage advance; self-reported attribution | `130_*`   |
| B     | `2026-10-06-gtm-b-meetings.md`                      | Canonical `meeting` record; Google Calendar sync stops dropping meetings; Cal.com webhook; meeting moves Opportunity to `meeting`; booking-link merge field; Today items                          | `131_*`   |
| C     | `2026-10-06-gtm-c-github-signals.md`                | GitHub via Nango; watched repos; stars/forks/issues resolved to Accounts as signals; scorer weights; Today                                                                                        | `132_*`   |
| D     | `2026-10-06-gtm-d-email-channel.md`                 | SPF/DKIM/DMARC checks as plan blockers; RFC 8058 List-Unsubscribe + one-click endpoint; named inbound mailbox sync into Conversations; email-only `prepare_outreach`                              | `133_*`   |
| E     | `2026-10-06-gtm-e-consent-and-linkedin-safety.md`   | Sender identity record; recipient jurisdiction + lawful-basis policy condition; founder-level LinkedIn budget across workspaces; human-send mode                                                  | `134_*`   |
| F     | `2026-10-06-gtm-f-enrichment-citations-forms.md`    | Hunter BYO-key enrichment behind a provider interface with a credit cap in the plan preview; AI-answer citations as brand-watch mentions; Cloudflare Worker capture template                      | `135_*`   |

Migration numbers are reservations. At execution time run `ls migrations | tail -3`; if the reserved number is taken, use the next free number and update every reference in that phase plan before Task 1.

## Global Constraints

Copied from `AGENTS.md` and the research report; every task in every phase implicitly includes these.

- PostgreSQL only; forward-only migrations in `migrations/`; never add a SQLite path.
- Scope every commercial query by `workspace_id`. A provider connection or webhook endpoint determines the workspace; never take the workspace from payload data.
- Multi-step writes run in one `db.transaction`; competing work uses `pg_advisory_xact_lock(hashtextextended(...))` or row locks, as `src/server/lead-capture/submissions.ts` does.
- Provider credentials and signing secrets live in Nango or Trevra secret custody (`src/server/secrets/crypto.ts`, gated by `secretsConfigured()`), never plaintext in tables or source.
- External writes require deterministic idempotency keys and go through the existing prepared-action/approval/execution boundary (`src/server/control-plane/execution.ts`). Never execute an external write through the generic skill or playbook runner.
- Webhook redeliveries dedupe through `webhook_events` (migration 058 index `idx_webhook_events_tenant_idempotency`).
- Analytics and domain-event payloads carry no client content, email bodies, document text, invoice details or IP addresses.
- Do not rebuild OAuth, token rotation, rate-limit handling or sync storage; use Nango or the provider's official SDK.
- Post-sale stays excluded (migrations 095, 106, 107): Stripe and other billing data are _observed_ outcomes only; no quotes, invoices, VAT or subscription management in Trevra.
- Closed vocabularies: new account-signal kinds are added to `ACCOUNT_SIGNAL_KINDS` (`src/server/accounts/types.ts`) _and_ given a weight in `weightFor` (`src/server/accounts/score.ts`); unknown kinds score zero by design.
- Account signals are written only through `recordSignals` (`src/server/accounts/sweep.ts`), which drops signals without an `evidenceUrl`; follow with `rescoreAccount` (`src/server/accounts/score.ts`) when rows were written.
- Opportunity stages never move backwards automatically and are never set to `lost` automatically.
- No new navigation section. Surfaces are Today (`src/server/today.ts`), Opportunities, existing `/setup/*` screens, plan blockers in the intent compiler, and approval cards. New routes, if any, are added in `SECTIONS`/`SUB_ROUTES`/`isAppPath` (`src/client/ui/route.ts`) and `APP_PATH_PATTERNS` (`src/server/index.ts`); never `#/` routes. (AGENTS.md still names the older `SHELL_PATHS`/`APP_PATH_HEADS`; those identifiers no longer exist.)
- Client UI uses `src/client/ui/primitives.tsx` controls and `--t-*` tokens; no inline reusable styles.
- Tests use a real PostgreSQL container: `npx tsx scripts/test-with-postgres.ts <test files>` for a focused run; `npm run check` before every commit. Run `npm audit --omit=dev` when a dependency is added.
- Deliberate ceilings get an `lc-debt: <ceiling>; <upgrade path>` comment.
- New durable state ships with its writer and its closer (retention, workspace cascade, or removal path).

## Shared contracts between phases

These names are fixed so phases written in parallel agree. A phase that _produces_ a contract must export exactly these names; a phase that _consumes_ one imports them.

1. **Forward-only stage advance** (produced by A, consumed by B and C):
   `src/server/opportunity-advance.ts`

   ```ts
   export const STAGE_RANK: Record<OpportunityStage, number>; // new 1, qualified 2, meeting 3, proposal 4, won 5, lost 6
   export async function advanceOpportunityStage(
     db: Db,
     input: {
       workspaceId: string;
       personId: string | null;
       accountId: string | null;
       minimumStage: Exclude<OpportunityStage, 'lost'>;
       title: string; // used only when a new Opportunity is created
       reason: string; // short, content-free, stored in the domain event
       sourceType: string; // e.g. 'inbound_submission' | 'stripe_event' | 'meeting'
       sourceId: string;
     },
     now?: Date
   ): Promise<{
     opportunityId: string;
     previousStage: OpportunityStage | null;
     stage: OpportunityStage;
     created: boolean;
     changed: boolean;
   }>;
   ```

   Rules: finds the most recently updated open Opportunity for the Person (else Account) in the workspace; creates one at `minimumStage` if none; raises the stage only if `STAGE_RANK[current] < STAGE_RANK[minimumStage]`; never touches `won`/`lost` rows except creating a fresh one when the only matches are closed and `minimumStage` is not `won`; appends `opportunity.stage_advanced` or `opportunity.created_from_observation` via `appendDomainEvent`; idempotent per `(sourceType, sourceId)`.

2. **Provider webhook endpoints** (produced by A, consumed by B):
   Table `provider_webhook_endpoints` (migration 130): `id`, `workspace_id` (FK, cascade), `provider` (`'stripe' | 'calcom'`), `secret_ciphertext`, `status` (`'active' | 'disabled'`), `created_by_user_id`, `last_seen_at`, `accepted_count`, `rejected_count`, timestamps.
   Module `src/server/provider-webhooks/`:

   ```ts
   export type WebhookProvider = 'stripe' | 'calcom';
   export interface ProviderWebhookVerifier {
     provider: WebhookProvider;
     verify(
       rawBody: Buffer,
       headers: Record<string, string | string[] | undefined>,
       secret: string,
       now: Date
     ):
       | { ok: true; eventId: string; eventType: string; payload: unknown }
       | { ok: false; status: number; error: string };
     handle(
       db: Db,
       endpoint: ProviderWebhookEndpoint,
       event: { eventId: string; eventType: string; payload: unknown },
       now: Date
     ): Promise<{ handled: boolean }>;
   }
   export function registerProviderVerifier(verifier: ProviderWebhookVerifier): void;
   export function registerProviderWebhookRoutes(app: Express, db: Db): void; // POST /api/hooks/v1/:provider/:endpointId, express.raw
   export async function createProviderWebhookEndpoint(
     db,
     { workspaceId, actorUserId, provider, signingSecret }
   ): Promise<ProviderWebhookEndpoint>;
   ```

   Owner-only management API under `/api/setup/webhooks`; UI lives on the existing `/setup/capture` screen.

3. **Milestone vocabulary** (produced by A, read by D/E only for display): `src/server/lead-capture/milestones.ts` exports `GTM_MILESTONE_KINDS = ['signed_up','activated','integration_connected','usage_threshold_crossed','paid','upgraded','cancelled'] as const` and `isMilestoneKind(kind)`. Matching account-signal kinds: `product-signed-up`, `product-activated`, `product-integration-connected`, `product-usage-threshold`, `customer-paid`, `customer-upgraded`, `customer-cancelled`.

4. **Other new account-signal kinds** (one owner each): C owns `repo-starred`, `repo-forked`, `repo-issue-opened`. F owns no account-signal kinds (citations are brand-watch mentions).

5. **Today item kinds** (each owner appends to `TodayItemKind`): A `milestone_reached` (recentResults), `customer_cancelled` (needsAttention); B `meeting_upcoming` (needsAttention, next 48h), `meeting_held` (recentResults); C none (uses `high_priority_account`); D `deliverability_blocked` (needsAttention); E `linkedin_handoff_waiting` (needsAttention).

## Cross-phase amendments (override the phase plans)

The phase plans were written in parallel. Where they disagree, these amendments win. Apply each one before starting the task it names.

1. **Cal.com setup reuses Phase A's webhook API (Phase B, Task 6).** Do not add `POST /api/setup/meetings/calcom` or `PATCH /api/setup/meetings/calcom/:id/status`. Instead:
   - Phase A's `POST /api/setup/webhooks` makes `signingSecret` optional.
   - `ProviderWebhookVerifier` gains `secretSource: 'provider' | 'trevra'`. Stripe is `'provider'`, because Stripe issues the `whsec_` secret. Cal.com is `'trevra'`: when the secret is omitted, the server generates 32 random bytes, stores them through secret custody, and returns the secret once in the `201` body.
   - Status changes use `PATCH /api/setup/webhooks/:id/status`.
   - B keeps `GET /api/setup/meetings` and `PUT /api/setup/meetings/booking-link`. Its `MeetingsSetup` component calls A's webhook client functions.
2. **Compliance footer (Phase E, Task 7).** No phase currently adds the CAN-SPAM postal address or a visible opt-out to the email body, and Phase D's List-Unsubscribe header alone is not a visible opt-out.
   - Phase E adds the footer when the draft is built in Phase D's `gtm.email-outreach` preparation (D Task 14), so it is inside the approved and hashed payload. It is never appended at send time.
   - The footer holds the legal name and postal address from `workspace_sender_identities`, plus an opt-out line.
   - D's `unsubscribeToken` is keyed by `deliveryId`, which does not exist until send time. The opt-out line therefore points to the recipient's mail-client unsubscribe and to replying "unsubscribe". D's inbound sync records such a reply as a suppression. A body link would need a token derived from the preparation key and is deferred.
   - The send step refuses a payload that has no footer.
   - Phase D runs before Phase E, so D Task 14 ships behind E's blocker. Do not enable `gtm.email-outreach` for a real workspace until Phase E Task 7 is merged.
3. **Shared files across D, E and B.**
   - D and E both edit `src/server/today.ts`, `src/server/gtm/intent.ts` and `executeEmail()` in `src/server/linkedin/campaign-channels.ts`.
   - D and B both edit `src/server/integration-service.ts`.
   - Run the phases one after another, never at the same time. Find each edit by its anchor text, because line numbers will have moved.
4. **Email bodies in domain events.** The playbook engine already writes the run input to `playbook.run.started` and the exact approval payload, email body included, to `approval.requested`. Phase D's `gtm.email-outreach` inherits this, as `gtm.conversation-email-reply` does today.
   - This is a known exception to the domain-event rule above, kept because approvals bind to the exact payload. It does not extend to analytics.
   - No new event may carry a body. Removing bodies from engine events is a separate follow-up.
5. **Sender identity.** Phase E's `sender_postal_address_missing` and `sender_privacy_url_missing` blockers also gate the email-only `prepare_outreach` plan from Phase D Task 12.

## Review Focus (whole roadmap)

- The same provider event delivered twice, or out of order (Stripe `paid` before `signed_up`), must produce one signal and one forward stage move, never a regression.
- A webhook or intake event naming a person or account from another workspace must never attach to it; the endpoint/source decides the workspace.
- A provider outage or a revoked key must show as an honest "not connected" state, never as zero activity.
- One founder running two workspaces (LemonCrow and Beseam) must not double LinkedIn volume or see the other workspace's data.
- No new path may send an external write without an approval bound to the exact payload hash.
