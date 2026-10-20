# Trevra platform capabilities and positioning (for Dripify feature-parity comparison)

Scope: platform-level features of the Trevra codebase at `/home/pankaj/Projects/Trevra`, branch `main`, commit `a79cf55`, read as it sits on disk on 2026-10-20 (the working tree has uncommitted catalog regeneration only). Outreach execution internals (LinkedIn driver, sequences, sending, inbox, lead lists, rate limits) belong to another researcher and appear here only for context.

Method and evidence standard: everything here comes from static reads of source, migrations, docs and public HTML. No app, test or deployment was run. Citations are `repo-relative-path:Lstart-Lend`. Wiring status was decided by finding callers (route → service → UI or worker), not by definitions alone. Status labels: **WIRED** (end-to-end from a route or worker to a UI or an observable effect), **PARTIAL**, **STUBBED** (code exists with no production caller), **ABSENT**.

Four read-only explore agents did part of the reading. I re-read these load-bearing citations myself and they held:

- `app.ts:1323` session boundary, `app.ts:9088-9095` `ownerOnly`, `auth-service.ts:396-400` roles
- `agent-access.ts:6-15` scopes, `control-plane/execution.ts:24-30` action set, `control-plane/policy.ts:87-96` external-write default
- `billing-client.ts:87-99`, `BillingSettings.tsx:208-285`, entitlement grep
- `registry/service.ts:144-147` Ed25519, `sandbox/community-runtime.ts:131-143` docker flags, `secrets/crypto.ts:181-184` AES-256-GCM, `ledger-export.ts:224-231` "not a signature"
- the `listRecommendations` and `action-service` caller greps
- route tables in `route.ts:35-47` and `index.ts:75-88`
- the export, analytics, MCP and webhook route lines
- the HubSpot adapter and the `nango-integrations/index.ts` sync list
- all public copy, pricing, and the absence of LICENSE, RLS and 2FA

Other line numbers come from the agents' reads and were not each re-opened.

Repo-internal Dripify reference points (from Trevra's own docs, NOT verified against Dripify's site):

- `docs/competitive-landscape.md:81` records Dripify as "$39–79/user/mo", with "No public API" and "Outbound webhooks on Pro+, one trigger per webhook per campaign, lead data only".
- `DRIPIFY_PARITY.md:1-5` and `:86-98` (audited 2026-08-14, commit 83d092f) claim LinkedIn outreach parity, including Analytics DONE and Team / multi-account DONE.

## Overview: platform capability status matrix

### Takeaway

Trevra is a control plane and evidence ledger for agent-run go-to-market (GTM) work. It is not a seat-priced LinkedIn tool.

It beats Dripify on:

- an API, an MCP server and an agent-token surface
- deterministic policy, exact-payload approvals and an append-only event ledger
- inbound lead capture and multi-channel email
- self-hosting

It trails Dripify on:

- CRM sync: no Pipedrive or Salesforce, and HubSpot is notes-only
- outbound webhooks and Zapier/Make
- per-team-member analytics
- agency and client separation, and white-label
- seat pricing and free trial
- finished billing

### Cited Findings

| Capability                                                                                                 | Status                                                                                                                                 | Key evidence                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LinkedIn campaign analytics: invites, acceptance, replies, A/B variants, per-seat and per-campaign filters | WIRED                                                                                                                                  | `src/server/linkedin/action-ledger.ts:1034-1218`; `src/server/linkedin/managed-campaigns.ts:3954-4074`; `src/client/LinkedInManagerRead.tsx:3844-3935` |
| Per-team-member analytics rollup                                                                           | ABSENT                                                                                                                                 | no group-by-user anywhere. `queued_by_user_id` is stored but not aggregated (`src/server/linkedin/action-ledger.ts:190,211-217`)                       |
| CSV export                                                                                                 | PARTIAL: one per-campaign, lead-level CSV only                                                                                         | `src/server/app.ts:6222`; `src/server/linkedin/managed-campaigns.ts:3297-3363`                                                                         |
| Ledger export (NDJSON zip + sha256 manifest), workspace JSON export                                        | WIRED                                                                                                                                  | `src/server/ledger-export.ts:1-428`; `src/server/app.ts:3065-3124,3171`                                                                                |
| HubSpot / Attio                                                                                            | PARTIAL: approved note on an existing contact only, no sync shipped                                                                    | `src/server/crm/adapters/hubspot.ts:29-73`; `src/server/crm/activity.ts:157-300`                                                                       |
| Pipedrive, Salesforce, Close, Slack, Zapier, Make, n8n, Calendly, Clearbit                                 | ABSENT                                                                                                                                 | rg finds only test fixtures and doc tables                                                                                                             |
| Gmail, Microsoft 365, Zoho Mail (send + inbound sync)                                                      | WIRED                                                                                                                                  | `src/server/integration-service.ts:128-175,647,894-969,1061`; `nango-integrations/index.ts:1-3`                                                        |
| REST API (~305 routes in app.ts, session auth, first-party)                                                | WIRED, undocumented (no OpenAPI)                                                                                                       | `src/server/app.ts:1323`                                                                                                                               |
| Agent tokens + MCP server (Streamable HTTP + stdio bridge)                                                 | WIRED (read, run skill, start playbook; never approve or execute)                                                                      | `src/server/agent-access.ts:6-15`; `src/server/mcp-http.ts:23-82`; `src/server/app.ts:1165-1321`                                                       |
| Inbound webhooks: Stripe, Cal.com, signed lead intake, Nango                                               | WIRED                                                                                                                                  | `src/server/provider-webhooks/http.ts:232`; `src/server/lead-capture/http.ts:171`; `src/server/app.ts:797,813`                                         |
| Outbound webhooks to user URLs                                                                             | ABSENT                                                                                                                                 | `docs/integration-contracts.md:122` ("no arbitrary webhook action")                                                                                    |
| Team invites, owner/member roles, workspace switcher                                                       | WIRED (two roles only, no role-change UI)                                                                                              | `src/server/app.ts:1956-1978`; `src/server/auth-service.ts:396-400`; `src/client/TeamScreen.tsx`                                                       |
| Multiple LinkedIn accounts (seats) per workspace, assigned to members                                      | WIRED                                                                                                                                  | `migrations/045_linkedin_multi_seat.sql`; `migrations/089_linkedin_campaign_team_controls.sql:1-22`; `src/server/app.ts:5936-6035`                     |
| Agency client workspaces, white-label                                                                      | ABSENT (agency-shaped campaign management is an explicit cut in `docs/core-product.md:224-229`)                                        |                                                                                                                                                        |
| Billing (external "Olaryn Billing" service: plans, checkout, credits, entitlements)                        | PARTIAL: first-plan checkout only, entitlements display-only, no usage reported                                                        | `src/server/billing-client.ts:87-259`; `src/client/BillingSettings.tsx:208-285`                                                                        |
| Public pricing                                                                                             | Preview: Starter $49, Growth $149, Scale $399 per month, credit-based, not per seat                                                    | `public/pricing/index.html:101-171`                                                                                                                    |
| Free trial                                                                                                 | ABSENT (shared demo workspace only)                                                                                                    | `src/server/app.ts:935`                                                                                                                                |
| Control plane: domain events, payload hash, policy engine, approval-gated adapters, durable playbooks      | WIRED                                                                                                                                  | `src/server/control-plane/*`; `src/server/playbooks/engine.ts`                                                                                         |
| Proof packs                                                                                                | PARTIAL: written by the worker, no read path reaches the UI                                                                            | `src/server/recommendation-engine.ts:130,146-190`; `src/server/serializers.ts:9-80`                                                                    |
| Signed community module registry                                                                           | WIRED code path, 0 community modules published; sandbox PARTIAL (deployment gaps)                                                      | `src/server/registry/service.ts`; `src/server/sandbox/community-runtime.ts`                                                                            |
| Self-hosting (compose + scripts + docs) and GCP Terraform                                                  | WIRED                                                                                                                                  | `compose.selfhost.yml`; `infra/gcp/terraform/main.tf`; `docs/self-hosted-production.md`                                                                |
| Open-source license                                                                                        | ABSENT: no LICENSE file, `package.json` has no license field and `private: true`, CLI is `UNLICENSED`, yet the copy says "open source" | `git ls-files`; `package.json`; `packages/trevra-cli/package.json`                                                                                     |

### Inferences

- Trevra's competitive shape against Dripify (inference from the matrix): stronger on governance, auditability, developer and agent access, and multi-channel; weaker on the commercial and admin features that agencies and SDR teams buy Dripify for (CRM push, Zapier, team-member stats, client workspaces, white-label, per-seat plans).

### Gaps

- No runtime verification. Statuses are from static caller tracing only.
- Dripify's own feature list was not researched here. Dripify facts above come from Trevra's internal docs.

## Analytics and reporting: dashboards, outcome tracking, metrics, projections, exports

### Takeaway

LinkedIn campaign analytics are WIRED and broadly match Dripify's core metrics. There are funnel counts, invite acceptance rate, reply rate, A/B variant results, and per-seat, per-wave, per-step and per-campaign breakdowns, with 7/30/90/all-time windows.

What is missing:

- a per-team-member rollup
- a CSV of the aggregate stats
- a rendered daily chart (the series is computed but not rendered)

Trevra adds analytics Dripify lacks:

- model-cost vs output
- inbound UTM / heard-about attribution
- product milestones
- content performance
- a hash-manifested ledger export

### Cited Findings

**Workspace LinkedIn funnel (`/loop` → "Performance and cost")**

- Server: `linkedinAnalytics`, `src/server/linkedin/action-ledger.ts:1034-1218`, route `GET /api/linkedin/analytics` at `src/server/app.ts:5910-5933`, query `days` 0-365 and optional `seatKey`.
- Counters: planned, held, exported, sent, accepted, replied, declined, skipped, withdrawn (`action-ledger.ts:652-684,928-941`).
- Invite metrics: `invitesSent`, `invitesAccepted`, `acceptanceRate` = accepted / invitesSent, and `acceptanceRateOfDecided` (`action-ledger.ts:708-731,952-978`).
- The server also returns `byCampaign[]` and a daily `series[]` (`action-ledger.ts:1095-1108,1148-1179`). Neither is rendered by any client component: `src/client/LinkedInAnalyticsScreen.tsx:14-16` says the per-campaign table "has since been removed".
- UI: `LinkedInFunnel`, `src/client/LinkedInAnalyticsScreen.tsx:124-240`, mounted at `src/client/views/LoopView.tsx:611-627`.
  - Tiles: "Invite acceptance", "Replies from accepted", "Declined", "Skipped".
  - Funnel bars: Planned, Sent, Accepted, Replied.
  - Window picker: 7/30/90/All (`LinkedInAnalyticsScreen.tsx:39-47,179-215`).
  - Rates show "not enough data" until the denominator reaches 20 (`src/client/analytics.ts:20-39`).

**Campaign results panel (`/outreach`)**

- Server: `managedAnalytics`, `src/server/linkedin/managed-campaigns.ts:3954-4074`, route `GET /api/linkedin/manager/analytics` at `src/server/app.ts:7098-7104`, filters `campaignId`, `seatKey`, `sinceDays`.
- Fields: invitesSent, messagesSent, profileViews, followsSent, invitesWithdrawn, withdrawalsPerformed, invitesAccepted, invitesAcceptedDetected, acceptanceRate, repliedLeads, contactedLeads, replyRate, and per-step/variant `variants[]` (`managed-campaigns.ts:3860-3952`).
- UI: `src/client/LinkedInManagerRead.tsx:3844-3935`, with Campaign / LinkedIn account / window filters.
  - Headline tiles: "Invites sent" and "Reply rate".
  - A/B "Message versions, side by side" at `:3930-3933`.

**Per-campaign operational analytics**

- Server: `campaignOperationalAnalytics`, `src/server/linkedin/managed-campaigns.ts:4228-4319,4375+`, route `GET /api/linkedin/manager/campaigns/:id/operational-analytics` at `src/server/app.ts:6266`.
- Contents:
  - audience funnel: pending, inSequence, invited, accepted, messaged, replied, completed, failed, excluded
  - per-wave acceptance, reply and failure rates and median time to first action
  - per-step SLA and overdue counts
  - per-variant rates with winner eligibility at 20 or more sends
  - per-sender (per-seat) invites, accepted, replied, safetyBlocks, acceptanceRate, replyRate, allocationShare
  - bottlenecks, channels (email, InMail, enrichment credits), and an admission forecast with a 95% CI
- UI: `src/client/LinkedInManagerRead.tsx:3451-3700`.

**Per-team-member analytics: ABSENT**

- No query groups by user. `linkedin_actions.queued_by_user_id` is only used to attribute a conversation message (`src/server/conversations.ts:212-216`).
- Seats and campaigns carry `owner_user_id` (`migrations/089_linkedin_campaign_team_controls.sql:1-22`), so the closest proxy is filtering by LinkedIn account.

**Exports**

- Campaign CSV, `GET /api/linkedin/manager/campaigns/:id/export.csv` at `src/server/app.ts:6221-6236`, builder `src/server/linkedin/managed-campaigns.ts:3297-3363`. One row per lead with columns:
  - first_name, last_name, company, email, phone, country, linkedin_url
  - status, workflow_step, wave, sender, admitted_at
  - actions_sent, invites_accepted, replies
  - exclusion_reason, failure_reason
  - UI button: `src/client/LinkedInManagerRead.tsx:2628-2644`.
- `csvCell` at `managed-campaigns.ts:3291-3294` does not neutralise leading `=`, `+`, `-` or `@`, so CSV formula injection is possible (agent-read).
- Ledger export: a ZIP of NDJSON with `manifest.json`, `src/server/ledger-export.ts:1-428`.
  - Sections: runs, steps, evidence, approvals, actions.
  - Window 1-365 days, 50,000-row cap per table, sha256 per file.
  - Stored once (`migrations/037_ledger_exports.sql`). Download is owner-only (`src/server/app.ts:3108-3124`). UI: `src/client/views/LedgerView.tsx:807+`.
  - The manifest itself says the digest "is not a signature" (`src/server/ledger-export.ts:224-231`), yet the UI copy says "a signed `manifest.json`" (`src/client/views/LedgerView.tsx:865`).
- Workspace JSON export: owner-only, `src/server/app.ts:3171-3190`.
- There is no CSV export of people, accounts, opportunities, inbound submissions or conversations.

**Other dashboards (all WIRED)**

- Today feed. A three-bucket attention feed (needsAttention, working, recentResults; 7-day recent window), not a metrics dashboard. `src/server/today.ts:12-33,134-156`, route `src/server/app.ts:3435-3442`, UI `src/client/views/LoopView.tsx:459-520`.
- Model cost, `/loop/cost`. Spend per model tagged HARD FACT vs REPORTED, budget state, sent actions, and accepted and replied outcomes, with an explicit no-causal-attribution caveat. `src/server/loop-cost.ts:23-30,54-247`, route `src/server/app.ts:3425-3433`, UI `LoopView.tsx:1532+`.
- Inbound attribution. 90-day per-`utm_source` and per-`heard_about` submissions, people and people-with-opportunity. `src/server/lead-capture/attribution.ts:4-83`, route `src/server/app.ts:1805-1811`, UI `src/client/inbound-attribution.tsx:84-122`.
- Product milestones. signed_up, activated, integration_connected, usage_threshold_crossed, paid, upgraded, cancelled. Amounts are never stored. `src/shared/milestones.ts:8-16`, `migrations/130_gtm_milestones_stripe.sql:33-77`, UI `src/client/inbound-milestones.tsx:33-86`.
- Opportunities. A stage list (new / qualified / meeting / proposal / won / lost) with first-touch UTM. No conversion or velocity metrics. `src/server/opportunities.ts:4-11`, `src/client/Opportunities.tsx:18-25,250-290`.
- Content performance. Per published LinkedIn post: impressions, reactions, comments, reposts, clicks, profile views, follows, velocity, and commercial outcomes (resolved people, qualified demand, verified replies, opportunities, won). Learning buckets need n of at least 3. `src/server/content/performance.ts:5-66,470+`, route `src/server/app.ts:3911-3921`, UI `src/client/views/ResearchView.tsx:1857-1900`.
- Public-module popularity (aggregate runs and installs). `src/server/registry/service.ts:113-136`, `migrations/010_atomic_module_metrics.sql`.

**Projections**

- `commercial_entity_events` / `_projections` are written by triggers (`migrations/007_registry_metrics_projections.sql:129-232`). No reader was found. STUBBED, write-only.
- The shared conversations projection (`migrations/103_shared_conversation_projection.sql`) backs the Messages view (`src/client/SharedConversations.tsx`).

**Window inconsistency**

- `/api/linkedin/analytics` windows on `COALESCE(recorded_at, planned_for, created_at)` in seat-timezone days (`action-ledger.ts:1046-1084`).
- `/api/linkedin/manager/analytics` windows on `recorded_at >= NOW() - N days` (`managed-campaigns.ts:3959-3977`).
- So the two screens can disagree for the same N.

### Inferences

- For a Dripify buyer, the campaign stats requirement (invites, acceptance, replies, per campaign, per account) is met. The "team member performance" requirement is not. Agencies and SDR managers would need per-user rollups.
- `docs/core-product.md:224-229` says to cut "A/B spintax, multi-variant campaign builders… analytics dashboards beyond the one funnel". The code nevertheless ships A/B variants and several dashboards, so product strategy and code disagree.

### Gaps

- Whether `src/server/linkedin/withdraw.ts` or other driver files contain additional CSV output was not checked.
- No measured data. Screens were not run.

## CRM and data integrations: providers, normalized records and actions, read vs write

### Takeaway

Nango is the credential and transport layer for Gmail, Microsoft 365, Zoho Mail, Google Calendar, HubSpot, Attio, Reddit, Buffer, GitHub and Exa.

The canonical inbound data model has only three record kinds (`message`, `opportunity`, `meeting`). There is no contact, company or deal-amount record.

CRM support is minimal compared with Dripify:

- HubSpot and Attio get a note on an existing contact, and only as a side effect of an approved community reply.
- No CRM read sync ships.
- Pipedrive and Salesforce are absent.

Email (send and inbound), calendar, booking, Stripe-milestone, GitHub-signal, Hunter-enrichment and Buffer-draft integrations go beyond Dripify.

### Cited Findings

**Catalog, connect flow and data model**

- Integration catalog: `src/server/integration-service.ts:128-252`.
- Connect: `POST /api/integrations/connect-session` (`src/server/app.ts:4308`) opens `@nangohq/frontend` (`src/client/App.tsx:2334`). Disconnect: `src/server/app.ts:4343`.
- Nango webhook: `src/server/app.ts:796-810`, handled by `src/server/integration-service.ts:325-585`. The workspace is resolved from the stored connection, never from the payload (`:341-400,587-604`).
- Canonical record schema with three kinds: `src/server/integration-service.ts:52-83`, documented at `docs/integration-contracts.md:16-31,67-109`.
- Opportunity stages are bounded to new, qualified, meeting, proposal, won, lost. Opportunities hold no amount (`docs/integration-contracts.md:84`).
- Shipped Nango sync functions are only the three `inbound-messages` syncs (Gmail, Microsoft, Zoho) (`nango-integrations/index.ts:1-3`). The other sync names in `.env.example:156-171` (trevra-opportunities, trevra-messages, trevra-meetings and others) do not exist in the repo.

**Per provider**

- HubSpot: PARTIAL.
  - Write: `note on an existing contact` (`src/server/crm/adapters/hubspot.ts:29-73`). Contact search is by email (`POST /crm/v3/objects/contacts/search`), then `POST /crm/v3/objects/notes`. Scopes are `crm.objects.contacts.read` and `crm.objects.notes.write`. Contact creation is deliberately absent (`:16-20`).
  - Caller: `recordOutreachInCrm` in `src/server/control-plane/execution.ts:174-206`. It runs only after an approved `community.reply` (`:136-150`).
  - `email.send` does not log to the CRM (`execution.ts:51-134`).
  - No match means skipped. Dedup uses `crm_activities` (`migrations/014_crm_activities.sql`; `src/server/crm/activity.ts:157-300`).
  - The catalog copy says "Read your contacts, companies, and deals" (`integration-service.ts:181-182`), but no read sync ships.
- Attio: PARTIAL, same path. Writes `note on an existing person record` (`src/server/crm/adapters/attio.ts:30-66`).
- `crm.log-activity` as a standalone action is in the closed action set (`src/server/control-plane/execution.ts:24-30`), but no playbook prepares it. `src/server/playbooks/registry.ts` uses only `email.send`, `community.reply` and `buffer.create-draft`. STUBBED as a standalone action.
- Pipedrive, Salesforce, Close: ABSENT. They appear only in test fixtures (`src/server/skills/signal.test.ts`). `src/server/crm/registry.ts:14-16` says "A provider with no adapter here simply cannot be written to".
- Gmail: WIRED.
  - Send: `POST /gmail/v1/users/me/messages/send` (`src/server/integration-service.ts:1061`), only through the approved `email.send` path (`execution.ts:75-85`).
  - Read: thread reads at `integration-service.ts:1245-1290`, plus the inbound sync (`nango-integrations/trevra-gmail/syncs/inbound-messages.ts`).
  - Mailbox designation routes: `src/server/app.ts:4354,4364,4389`.
- Microsoft 365 / Outlook: WIRED for mail. Graph send and reply at `src/server/integration-service.ts:894-969`; inbound sync at `nango-integrations/trevra-microsoft/syncs/inbound-messages.ts`. Calendar events are not read (`.env.example:151-155`).
- Zoho Mail: WIRED. Plain-text send and inbound sync (`src/server/email/zoho-mail.ts:148-229`; `docs/integration-contracts.md:117,160-170`).
- Google Calendar: PARTIAL, read-only. Meetings attach only to existing People and Opportunities (`src/server/meetings/google-calendar.ts:1-60`; `docs/integration-contracts.md:104-107,135`). The sync function is not shipped (operator-deployed).
- Cal.com: WIRED, read-only. HMAC webhook handling BOOKING_CREATED, RESCHEDULED and CANCELLED (`src/server/provider-webhooks/calcom.ts:25-29,149`). Setup routes are owner-only (`src/server/app.ts:1633-1775`).
- Calendly: ABSENT.
- Stripe: WIRED, observe-only.
  - The SDK is used for signature verification only. No API key, no amounts stored (`src/server/provider-webhooks/stripe.ts:1-17,167-215,270`).
  - Five events (checkout completed, async payment succeeded, invoice.paid, subscription updated, subscription deleted) map to the milestones paid, upgraded and cancelled.
- GitHub: WIRED, read-only. Stars, forks and issues become account signals (`docs/integration-contracts.md:207-217`; `src/server/github/transport.ts:70-72`).
  - Routes: `src/server/app.ts:1568,1587,1608`. Worker poll: `src/server/automation-service.ts:80`.
  - Separately, an approved `community.reply` can post GitHub and Mastodon comments (`src/server/outreach/publish.ts:190-215`).
- Hunter (email finder and verifier): WIRED. Direct HTTP, BYOK key sealed in `workspace_secrets` (`src/server/enrichment/hunter.ts:34-35`; `src/server/enrichment/provider.ts:10`).
  - Routes: `src/server/app.ts:2668-2765`. Worker: `src/worker/index.ts:333`; `src/server/enrichment/runs.ts:413`.
  - UI: "Find contacts (Hunter)" at `src/client/views/LoopView.tsx:967`.
  - A per-campaign credit cap is enforced under row lock (`src/server/linkedin/campaign-channels.ts:363-390`).
- Apollo: deliberately ABSENT for Terms-of-Service reasons (`src/server/research/registry.ts:51-67`; `src/server/integration-service.ts:113-119`).
- Clearbit: ABSENT.
- Exa (search): PARTIAL. Env key, memory-only results (`src/server/research/providers/exa.ts:35-37`). The Nango card is cosmetic (`integration-service.ts:198-213`).
- Buffer: WIRED. Write `buffer.create-draft` (draft only, approval by exact payload) (`src/server/content/buffer.ts:20-75`; `execution.ts:153-157`).
  - Routes: `src/server/app.ts:3923,3935`. UI: `src/client/LinkedInPosts.tsx:669-744`.
- Reddit: WIRED for a read-only research corpus (`src/server/research/service.ts:47-118`). Posting is prepare-only (`src/server/channels/adapters/reddit.ts:45`).
- Slack, Zapier, Make, n8n: ABSENT. Slack is listed as a gap in `docs/swan-parity.md:166,330`.

**CSV and generic ingest**

- CSV import:
  - Accounts: `POST /api/accounts/import` (`src/server/app.ts:8346-8380`, accepts CSV, JSON or newline lists). UI: `src/client/AccountsScreen.tsx:721`.
  - LinkedIn lead lists: `src/server/app.ts:7108,7150`; parser `src/server/linkedin/lead-import.ts:5-13,537`.
- CSV export: only the campaign CSV (see Analytics).
- Generic inbound: `POST /api/intake/v1/submissions` with HMAC headers (`src/server/lead-capture/http.ts:170-171`; `src/server/lead-capture/signature.ts:7-30`; `docs/lead-capture.md:20-35`). It creates or matches a Person and stores an immutable submission. UI: `src/client/LeadCaptureSetup.tsx`.
- Legacy `POST /api/events`: still present, needs a session plus `INGEST_API_KEY` (`src/server/app.ts:4807-4830`). `docs/integration-contracts.md:240` lists it as removed.

### Inferences

- A Zapier or Make "Webhooks" step could push leads into `/api/intake/v1/submissions` if the customer implements HMAC signing. This is not packaged, documented or tested for Zapier.
- Per `docs/connector-vendors.md:53,79,83`, free self-hosted Nango lacks syncs and webhooks. Inbound mailbox sync, calendar and any CRM read sync therefore likely need a paid or enterprise Nango. Proxy-only writes (CRM notes, Gmail send, Buffer, GitHub) work without syncs.
- `docs/system-of-record.md:74-83` says a `workspace_policies` deny on `action:crm.log-activity` disables CRM write-back. The community-reply side-effect path makes no policy call, so the deny would not stop it (inference from code; not tested).

### Gaps

- The live Nango deployment's configured syncs are unknown. The repo ships only three.
- Doc and code mismatches recorded by the integrations reader:
  - `docs/linkedin-outreach-plan.md:435` claims "Native CRM write-back: yes (HubSpot/Attio)".
  - `src/server/integration-service.ts:100-104` says CRM is "READ / sync only".
  - Neither matches the notes-only reality.

## API surface: REST, webhooks, MCP, CLI, API keys

### Takeaway

Trevra has a large first-party REST API, about 305 literal routes in `app.ts`, all session-authenticated after `app.ts:1323`. It has no OpenAPI or public docs.

It also has a deliberately narrow agent-token API and a WIRED MCP server, both read, run-skill and start-playbook only, and several signed inbound webhooks. There are no outbound webhooks and no Zapier or Make app.

Per Trevra's own competitive notes, Dripify has no public API but does offer outbound webhooks on Pro+. So Trevra wins on API and MCP and loses on push webhooks.

### Cited Findings

**REST routes**

- About 305 literal-path routes in `src/server/app.ts` (GET 118, POST 125, PUT 22, PATCH 15, DELETE 25; agent count via multiline rg).
- Largest prefix: `/api/linkedin` with 110 routes, 57 of them under `manager/*`.
- Other prefixes: content 26, agent 12, watches 10, agent-setup 10, accounts 10, and many smaller ones.
- Auth boundary: public and special-credential routes at `app.ts:708-1140`, agent-token routes at `app.ts:1165-1321`, then `app.use('/api', requireSession(...))` at `src/server/app.ts:1323`.
- Per-workspace limit is 1,200 requests/min (`app.ts:594`); unattributed traffic gets 300/min per IP (`app.ts:1063-1068`).
- Better Auth is mounted at `/api/auth/*splat` (`app.ts:1014`).
- Public routes outside app.ts: `/api/public/modules*` and `/api/public/module-popularity` (`src/server/public-site.ts:297-330`), discovery files (`public-site.ts:350-390`), and `POST /api/marketing/events` (`public-site.ts:404`).

**Agent tokens**

- Format and storage: `trv_live_` prefix, stored hashed with a pepper (`src/server/agent-access.ts:58,271-272`). Table: `migrations/005_agent_tokens.sql:1-20`. Tokens bind to durable agent principals (`migrations/105_agent_principals.sql:8-56`).
- Scopes: `skills:read`, `skills:run`, `runs:read`, `workspace:read`, `playbooks:read`, `playbooks:run`, `workflows:read` (`src/server/agent-access.ts:6-15`). There is no approve, execute, billing or integration-admin scope (`docs/agent-operation.md:8-22`).
- Management: `src/server/app.ts:2384-2522`. Any member may mint a token; only the owner may revoke one (`:2507`).
- UI: `src/client/App.tsx:1115-1170` prints ready-made `claude mcp add` and `codex mcp add` commands.
- Agent routes (`requireAgentScope`, `src/server/app.ts:8992-9005`):
  - `/api/agent/mcp`
  - `/api/agent/skills`, `/skills/:id/run`
  - `/runs`, `/runs/:id`
  - `/playbooks`, `/playbooks/:id/runs`, `/playbook-runs*`
  - `/events` (`app.ts:1165-1321`)

**MCP server: WIRED**

- Hosted: stateless Streamable HTTP via `@modelcontextprotocol/sdk`, `src/server/mcp-http.ts:23-82`. A stdio bridge lives at `src/mcp/server.ts:1-50`.
- 13 built-in tools plus one per enabled skill (`src/server/agent/tools.ts:78-370,479-482`). Examples: list_people, list_accounts, list_opportunities, list_conversations, list_deliveries, start_playbook, list_events.
- The tool set may never approve, execute or send; this is asserted at `tools.ts:12-27` and in `tools.test.ts`.
- Client library: `src/agent/client.ts:89-200`.

**CLIs**

- Published npm `trevra@0.2.2` (`packages/trevra-cli/package.json:2-7`; bin at `package.json:6`). It is the LinkedIn companion installer and service only: `linkedin setup|install|status|logs|reconnect|start|stop|restart|uninstall` (`packages/trevra-cli/bin/trevra.js:59`).
- `npm run agent` runs a repo-only agent CLI (`src/cli/trevra-agent.ts`) wrapping `TrevraAgentClient`.
- `src/server/agent/cli.ts` drives a hosted agent through `claude -p` / `codex exec` (`docs/cli-agent-and-hosted.md`). It is not an API CLI.

**Webhooks**

- Inbound, WIRED:
  - `/api/hooks/v1/:provider/:endpointId` for Stripe and Cal.com (`src/server/provider-webhooks/http.ts:213-243`; `src/server/provider-webhooks/types.ts:4`). Management is owner-only (`src/server/app.ts:1633-1761`), UI `src/client/ProviderWebhookSetup.tsx`, deduplicated via `webhook_events`.
  - `/api/intake/v1/submissions` and `/api/intake/v1/citations` (`src/server/watch/citation-intake.ts:17`).
  - `/api/webhooks/nango` (`app.ts:797`) and `/api/webhooks/linkedin-campaign-email` (`app.ts:813`, HMAC).
- Outbound to user URLs: ABSENT. There is no subscription table and no sender. `docs/integration-contracts.md:122` says "There is no generic remote-action adapter and no arbitrary webhook action". README.md:5 says Trevra is "deliberately not… arbitrary webhook automation". The nearest substitutes are pull-based: polling `GET /api/agent/events` or a ledger export.
- API documentation: no OpenAPI or Swagger anywhere (rg). Skills self-describe through zod-derived JSON Schema (`src/server/skill-api.ts:20-70`). The API-adjacent docs are `docs/agent-operation.md`, `docs/lead-capture.md` and `docs/integration-contracts.md`.

### Inferences

- The agent and MCP surface is a real differentiator for founders who work in Claude Code or Codex. For agency and SDR stacks built on Zapier, the missing outbound webhooks and Zapier app is a parity gap.

### Gaps

- Not verified: whether the agent API is reachable on the hosted production deployment (usetrevra.com), and whether rate limits differ there.

## Teams and workspaces: members, roles, invitations, multi-account, agency, white-label

### Takeaway

Workspaces map 1:1 to Better Auth organizations, with email invitations and two roles (`owner` and `member`). The roles are WIRED and enforced by about 63 owner-only guards. A user can belong to and switch between several workspaces.

Several LinkedIn accounts (seats) and several mailboxes per workspace are WIRED, and seats and campaigns can be assigned to members.

What is missing:

- granular roles and a role-change UI
- a UI to create additional workspaces
- an agency/client hierarchy or cross-client dashboard
- white-label

### Cited Findings

**Identity and roles**

- Identity: Better Auth with the `organization` plugin (`src/server/auth-service.ts:7,394-480`). Authward is the OIDC provider in hosted mode (`auth-service.ts:45-56,156-195`; `src/server/authward-token.ts:10-51`).
- Workspace = organization (`auth-service.ts:213-300,425-498`). The `member`, `invitation` and `organization` tables are created by Better Auth migrations at runtime (`auth-service.ts:586-599`).
- Roles: "Default roles only (owner / admin / member)… This workspace uses exactly two of the three: 'owner' (the credential-management carve-out) and 'member' (everyone else, full data parity)" (`src/server/auth-service.ts:396-399`).
- Anything that is not `owner` resolves to `member` (`src/server/app.ts:9489-9527`).
- Last-owner protection: `assertOwnerChangeAllowed` (`auth-service.ts:328-341,556-563`).

**Owner-only enforcement**

- Helpers: `ownerOnly(act)` (`src/server/app.ts:9088-9095`, verified) and `assertWorkspaceOwner` (`app.ts:9097-9100`). There are 47 plus 16 call sites.
- Owner-only acts:
  - team invites, plan change
  - lead-capture sources, webhooks, policies
  - registry publish and install, agent setup, BYOK keys
  - LinkedIn credentials and seat creation
  - ledger and workspace export, erasure
  - sender identity, lead delete
- Per-resource member gates: `assertCanUseLinkedInSeats`, `assertCanManageManagedCampaign` and `assertCanManageWorkflow` (`app.ts:9135-9174`). A member may operate a seat or campaign only if they are its `owner_user_id`.

**Invitations: WIRED**

- Server: `POST /api/team/members` (`src/server/app.ts:1956-1978`) calls `betterAuth.api.createInvitation`. The email is sent only when SMTP is configured, otherwise a copy-link is shown (`auth-service.ts:401-421`). Accept and removal notification emails are at `auth-service.ts:524-555`.
- UI: `src/client/TeamScreen.tsx:638-1043` covers the invite form, member list, pending invites and the accept page. Route `/setup/team/:id` is at `src/client/ui/route.ts:46`.
- No role-change UI: `updateMemberRole` is never called from `src/client`.

**Multiple workspaces: PARTIAL**

- Switching works through `WorkspaceSwitcher` (`src/client/App.tsx:3108-3152`). No create-workspace UI was found.
- Design: `docs/superpowers/specs/2026-08-13-team-workspace-access-design.md:48-64` describes membership as additive, with no granular permissions.

**Multiple accounts: WIRED**

- LinkedIn seats: `linkedin_seats` has PK `(workspace_id, seat_key)` with per-seat hours and caps (`migrations/045_linkedin_multi_seat.sql:1-40`). `owner_user_id` on seats, campaigns and workflows, plus personal vs workspace workflow scope, comes from `migrations/089_linkedin_campaign_team_controls.sql:1-22`.
- Seat routes: `src/server/app.ts:5936-6035`. UI: `src/client/LinkedInAccounts.tsx`.
- One active companion device per workspace (`migrations/078_single_linkedin_companion_device.sql`). Hosted execution is the alternative (`migrations/065_linkedin_hosted_execution.sql`).
- Mailboxes: `listCampaignMailboxes` returns every connected mailbox with per-mailbox limits (`src/server/linkedin/campaign-channels.ts:1168-1215`), routes at `src/server/app.ts:6037-6044`.

**Agency, client separation and white-label: ABSENT**

- Agency-shaped features: the only hits are a "team/agency" comment in `migrations/089` and the explicit cut "agency-shaped campaign management" in `docs/core-product.md:224-229`.
- No client workspace hierarchy, client read-only portal, cross-client dashboard or parent/child billing exists.
- White-label: no per-workspace logo, domain, colours or branded reports. Per-workspace sender identity exists for CAN-SPAM footers, not branding (`src/server/app.ts:8465-8500`).

**Data control**

- Erasure and export: owner-only `DELETE /api/workspace`, which requires typing the workspace name and cascades, writing a counts-only `workspace_erasures` record (`src/server/app.ts:3280-3414`; `migrations/057_workspace_erasure_log.sql:1-40`).
- Tenant isolation: application-level `WHERE workspace_id` plus composite foreign-key hardening (`migrations/058_tenant_isolation_hardening.sql`). No RLS (`rg "ROW LEVEL SECURITY|CREATE POLICY"` returns nothing).

### Inferences

- An agency could run one workspace per client and switch between them, since multi-membership works. It would get no cross-client view, no client-facing access and no consolidated billing.
- The repo's `DRIPIFY_PARITY.md:90-94` says "Team / multi-account — DONE" for LinkedIn seats. That is accurate for multi-seat, not for team analytics or agency management.
- `docs/linkedin-outreach-plan.md:551`, `docs/swan-parity.md:169,443` and `migrations/022_linkedin_seats.sql:13` still call multi-seat or agency "deferred". The code from migration 045 onward contradicts them, so treat those docs as stale.

### Gaps

- Whether one paired companion computer can drive several seats' browser profiles at once was not verified.
- Whether Better Auth's auto-mounted `/api/auth/organization/create` lets any user create workspaces was inferred from config, not tested.

## Billing and plans: tiers, billing code, metering, limits, trial, public pricing copy

### Takeaway

Public pricing is an explicitly provisional preview: three credit-based tiers (Starter $49, Growth $149, Scale $399 per month; annual equals 10 months), not per seat.

In-app billing is a PARTIAL proxy to an external shared "Olaryn Billing" service (Stripe and OpenMeter behind it):

- Plan catalog, first-plan checkout and a read-only snapshot are WIRED.
- Nothing enforces entitlements.
- No usage is reported.
- There are no plan changes, cancel, portal or invoices.
- There is no free trial.

Internal metering (LLM spend budget, enrichment credit cap, LinkedIn safety caps) is WIRED but not connected to billing.

### Cited Findings

**Public pricing page**

- `public/pricing/index.html:101-106`: "Preview pricing while Trevra's commercial model is finalized. The plans below exercise the real Billing, Stripe, credit, and entitlement flow, but the numbers are provisional… change before launch is expected."
- Starter, $49/month, 5,000 credits/month (`:111-126`): "For one founder or operator running focused account research". Includes continuous account research, evidence-backed ranking, "LinkedIn and email preparation" and the human approval gate. Annual is $490/year.
- Growth, $149/month, 20,000 credits (`:131-146`): adds campaign and workflow automation, shared team workflows and priority email support. Annual is $1,490.
- Scale, $399/month, 75,000 credits (`:151-166`): adds higher automation capacity, advanced workspace controls and priority support. Annual is $3,990.
- "Credits measure usage across research and agent actions. Hosted plan selection and checkout happen inside the workspace" (`:171`).
- CTAs deep-link to `https://app.usetrevra.com/setup/billing?plan=starter_monthly_usd` (`:125`).
- Marketing home: "Hosted access is opening in batches." When no hosted URL is set, the CTA is a mailto to the founder (`src/client/MarketingScreen.tsx:71-73,343-370`).
- `llms.txt` describes the pricing page as "Preview hosted Trevra plans and credit allowances" (`src/shared/site-metadata.ts:186`).

**Billing client and routes**

- Billing client: `src/server/billing-client.ts:87-99` (verified). It needs `BILLING_BASE_URL`, `AUTHWARD_ISSUER` and `BILLING_CLIENT_SECRET`. Default audience is `https://billing.olaryn.com`. Auth is OAuth2 client-credentials (`:136-176`).
- Methods (`billing-client.ts:207-259`):
  - `plans()` → `GET /v1/trevra/catalog/plans`
  - `startPlan()` → `POST /v1/trevra/customers/{workspaceId}/subscription`
  - `ensureWorkspaceCustomer()`
  - `workspaceSnapshot()`: customer, subscription, credits, entitlements
- Routes:
  - `GET /api/billing` returns `{enabled:false}` when unconfigured (`src/server/app.ts:1330-1356`).
  - `GET /api/billing/plans` (`:1358-1371`).
  - `POST /api/billing/checkout`, owner-only and idempotency-keyed (`:1373-1425`).

**Billing UI**

- Panel copy: "Preview pricing" / "Temporary Trevra pricing to exercise the complete catalog, checkout, subscription, credit, and entitlement loop" (`src/client/BillingSettings.tsx:211-214`).
- Once a plan exists, every button reads "Plan changes coming soon" and is disabled (`BillingSettings.tsx:253-263`).
- "These prices are deliberately provisional… the commercial numbers are placeholders" (`:281-284`).
- Tiers are ranked starter / growth / scale (`:34-36`).

**Gaps in the wiring**

- Entitlements are display-only: `rg entitlement src` hits only `src/server/billing-client.ts`, `src/client/BillingSettings.tsx` and `src/client/api.ts` (verified). No server gate exists.
- No billing webhook handler. `provider-webhooks/stripe.ts` is customer-milestone observation, not Trevra's own billing.
- No usage or ingest method in `billing-client.ts`.

**Seats and trial**

- Seats: no seat counting or membership limits (no `membershipLimit` or `organizationLimit` in `auth-service.ts`). In Trevra code, "seat" means a LinkedIn account.
- Free trial: ABSENT. The only adjacent feature is a shared demo workspace (`POST /api/auth/demo`, `src/server/app.ts:935`; `POST /api/demo/reset`).

**Internal metering and limits: WIRED**

- LLM spend budget: `workspace_agent_budget`, default cap 2,000 cents/month, opt-in (`migrations/016_agent_budget.sql:8-50`). `assertAgentBudgetAvailable` is called from `src/server/agent/loop.ts:132,284`, `src/server/agent/cli.ts:888` and `src/server/app.ts:2958-2964`. The workspace brings its own model key, so this is a spend cap, not revenue metering.
- Enrichment credits: per-campaign cap (`migrations/094_linkedin_enrichment_credits.sql`; `src/server/linkedin/campaign-channels.ts:363-390`) and a workspace cap route (`src/server/app.ts:2763`).
- LinkedIn caps: per-seat daily caps (`migrations/045`) and a workspace daily lead ceiling (`src/server/app.ts:7550`).

### Inferences

- Trevra's pricing unit (workspace plan with credits) differs structurally from Dripify's per-user/month model (Dripify range taken from `docs/competitive-landscape.md:81`). Growth and Scale bundle team use without a per-user charge, but none of the tier differences ("Shared team workflows", "Advanced workspace controls", "Higher automation capacity") is enforced in code, because entitlements are not checked.

### Gaps

- The live catalog (plan codes, credit costs per action) lives in the external billing service and is not in the repo.
- How credits are consumed per action is undefined in Trevra code.

## Public positioning: canonical copy, FAQ, llms.txt, audience, mentions of LinkedIn and competitors

### Takeaway

Trevra positions itself as "Agent-Run GTM With Human Approval": an open-source ledger and control plane that lets Claude Code or Codex research and prepare GTM work, with consequential actions locked behind exact-payload human approval.

Audience: founders and small GTM teams. The public copy is anti-volume ("instead of blasting hundreds of cold emails"). It barely mentions LinkedIn (one pricing bullet) and names no competitors.

That contrasts sharply with Dripify's volume-automation pitch, and with the extensive LinkedIn automation code inside the product.

### Cited Findings

**Canonical copy**

- Canonical copy lives in `src/shared/site-metadata.ts`, imported by `src/server/public-site.ts:118-131`.
- Title: "Trevra — Agent-Run GTM With Human Approval" (`site-metadata.ts:9`).
- Description: "Trevra lets Claude Code and Codex research and prepare GTM work. You approve consequential actions before they execute, and every outcome is recorded." (`site-metadata.ts:10-11`). It is mirrored in `index.html:6-9`.
- Public paths: `/`, `/pricing`, `/how-it-works`, `/security`, `/privacy`, `/terms` (`site-metadata.ts:20-27`).

**FAQ** (`site-metadata.ts:34-63`; rendered on the home page at `src/client/MarketingScreen.tsx:395-401` and as JSON-LD at `site-metadata.ts:130-137`)

- "What is Trevra?": "researches potential customers, connects buying signals to evidence, and helps your agent prepare focused outreach."
- "What can my agent do?": "research companies and people, score evidence, prioritize opportunities, and prepare outreach or CRM updates. The agent cannot approve or execute consequential actions."
- "Can it send outreach without me?": "No… A human must approve it before a named execution adapter can run."
- "Do I need a CRM?": "No. Trevra can be your sales research workspace or work alongside an existing CRM."
- "What gets recorded?": "Sources, inputs, policy decisions, approvals, execution attempts, and outcomes stay in the ledger."
- "Can I self-host?": "Yes. Trevra is open source, PostgreSQL-only…"

**JSON-LD featureList** (`site-metadata.ts:116-127`)

- ledger and deterministic control plane
- MCP tools for Claude Code and Codex
- account and people research with source provenance
- "Outreach campaigns, inbox work, and opportunity state"
- durable playbooks
- workspace policy evaluation
- exact-payload approval with cryptographic hashing
- named idempotent execution adapters
- append-only events
- open source and self-hostable

**Hero and home page**

- "Know who's worth selling to before you reach out." / "…so you focus on a few high-potential customers instead of blasting hundreds of cold emails." (`src/client/MarketingScreen.tsx:127-131`).
- Loop: Research → Verify → Rank → Act → Learn (`MarketingScreen.tsx:213-242`).
- "Start hosted. Self-host if you prefer." (`:335-379`).

**How it works** (`public/how-it-works/index.html:121-191`)

- Agents call typed, versioned modules "versioned on GitHub".
- "held for your approval by default".
- The approved payload is "cryptographically hashed".
- "The catalog is public and synced from GitHub".
- Tagline: "The open-source runtime, ledger and approval gate for agent-run go-to-market."

**llms.txt and llms-full.txt** (`site-metadata.ts:185-216`)

- Product boundary: "focused on go-to-market operations: research, outreach, conversations, opportunity state… It is not an accounting, project-management, billing, or generic automation system."
- Integrations: "delegated to Nango or official provider SDKs for GTM systems such as Gmail, Microsoft 365, CRM providers, public communities, and research sources."
- These files are served at `/llms.txt` and `/llms-full.txt` (`src/server/public-site.ts:362-372`).

**LinkedIn and competitor mentions**

- LinkedIn: `rg -i linkedin` across the public pages, MarketingScreen, site-metadata and public-site finds exactly one hit, the pricing bullet "LinkedIn and email preparation" (`public/pricing/index.html:119`).
- Competitors: no public file names Dripify, Waalaxy, Expandi, HeyReach, lemlist, Clay or Apollo.

**Internal positioning**

- README.md:3-5: "open-source ledger and control plane for agent-operated go-to-market. Founders and agents use it to find and qualify accounts/people, capture inbound demand, operate outreach…" and "deliberately not… arbitrary webhook automation".
- PRODUCT.md:11: "Founders and small GTM teams running a focused account/people pipeline with human and agent operators."
- `docs/core-product.md:224-232` cuts "agency-shaped campaign management" and "Enrichment waterfalls, contact discovery, lookalikes".

### Inferences

- Public copy undersells the shipped LinkedIn campaign engine (multi-seat campaigns, sequences, Sales Navigator scraping per `DRIPIFY_PARITY.md:42-48`). A Dripify-style buyer would not learn from the website that Trevra does LinkedIn automation.
- The "open source" claim on the site (`site-metadata.ts:61,126`, `MarketingScreen.tsx:379`, `how-it-works:175,191`) is not backed by a license file (see Security).

### Gaps

- `public/privacy/index.html`, `public/terms/index.html` and `public/security/index.html` were not read line by line for claims.
- Whether the GitHub repo `leanchain/trevra` linked from the footer is public is unknown.

## Registry, skills and sandbox: modules, signing, popularity, installation, isolation, GTM relevance

### Takeaway

The catalog holds 21 built-in modules, all unsigned built-ins by publisher `trevra`, with 0 community modules. 20 of the 21 are sales/GTM skills: prospecting, scoring, enrichment, contact finding, outreach drafting and guards, and three pure-compute LinkedIn planners.

The signed community registry is WIRED in code:

- Ed25519 publisher signatures, re-verified at execution
- operator-verified publishers
- trigger-maintained public popularity and reputation
- per-workspace pinned installs

Sandboxed execution is wired into every skill-run path. Deployment is PARTIAL:

- no gateway is provisioned by Terraform or compose
- the in-process docker fallback cannot run in the shipped image
- the documented Kubernetes gateway lacks the `DATABASE_URL` its code needs

External-write skills are blocked from generic runners at five points.

### Cited Findings

**Catalog**

- `public/catalog/modules.json` and `src/generated/public-modules.json` are identical, with 21 modules (`jq '.modules | length'` = 21).
- Ids:
  - gtm.channel-plan, gtm.channel-prepare, gtm.copy-critique, gtm.draft-reply
  - gtm.enrich-company, gtm.find-contact, gtm.lead-status
  - gtm.linkedin-guard, gtm.linkedin-pace, gtm.linkedin-sequence
  - gtm.outreach-draft, gtm.outreach-guard
  - gtm.research-brief, gtm.score-lead, gtm.score-threads, gtm.scout-threads, gtm.source-leads
  - gtm.visibility-audit, gtm.watch-mentions, gtm.watch-signal
  - net.validate-host
- The uncommitted diff only changes `generatedAt`, `sourceRevision` and formatting.
- Built-ins are registered in `src/server/skills/registry.ts:98-122`.

**GTM relevance of the modules**

- Prospecting: `gtm.source-leads` (ICP or directory → candidate domains, via Exa), `gtm.score-lead`, `gtm.lead-status`, `gtm.research-brief`, `gtm.visibility-audit`.
- Enrichment and signals: `gtm.enrich-company`, `gtm.watch-signal`.
- Email finding: `gtm.find-contact`, which crawls a domain's own pages for published contacts and respects robots.
- Outreach: `gtm.outreach-draft` (approval required), `gtm.outreach-guard`, `gtm.draft-reply`, `gtm.scout-threads`, `gtm.score-threads`, `gtm.watch-mentions`, `gtm.channel-plan`, `gtm.channel-prepare`, `gtm.copy-critique`.
- LinkedIn: `gtm.linkedin-guard`, `gtm.linkedin-pace`, `gtm.linkedin-sequence`. These are planning and guard computations; the browser execution lives outside the registry.
- No built-in module is `external-write`.

**Playbooks**

- 7 ids in 8 definitions (`src/server/playbooks/registry.ts:12,141,269,366,437,500,572,650`): gtm.audit-led-outreach, gtm.community-outreach, gtm.thread-reply, gtm.qualified-demand-email, gtm.conversation-email-reply, gtm.email-outreach (v1.0.0 and v1.1.0), gtm.buffer-draft.
- Seeded by `seedPlaybooks` (`registry.ts:731+`).

**Signing**

- Ed25519 only (`src/server/registry/service.ts:144-147`, verified). The publisher generates the key locally with `npm run module -- keygen` (`src/cli/trevra-module.ts:8-30`). The server stores only the public key and fingerprint (`migrations/007_registry_metrics_projections.sql:3-15`).
- Signed bytes: `stableJson({schemaVersion, manifest, sbomDigest})`. The manifest pins the artifact sha256, permissions, resources, repo, commit and license (`service.ts:65-96,172-178`).
- Verified at publish (`service.ts:209-214`) and again at execution (`service.ts:386-406`).
- Releases land as `draft` unless the publisher is operator-verified (`service.ts:224`). Only `verified` releases can be installed or run (`:269,379`).
- Operator verification: `POST /api/admin/registry/publishers/:id/verification`, gated by `TRACTION_ADMIN_TOKEN` (`src/server/app.ts:1140-1158`).
- No key rotation or revocation. No code writes `module_releases.status` to `blocked` or `deprecated`.

**Popularity and reputation: WIRED**

- Triggers on `skill_runs` and installs maintain the global `module_usage_metrics` and per-workspace usage (`migrations/010_atomic_module_metrics.sql:2-73`).
- Public DENSE_RANK by runs, then installs (`src/server/registry/service.ts:113-136`). Routes: `src/server/public-site.ts:297-330`.
- Publisher reputation is a 0-100 score from verified status, verified releases, log(runs), success rate and installs (`migrations/011_publisher_reputation.sql:1-63`).

**Install**

- Owner-only `POST/DELETE /api/registry/modules/:id/install` (`src/server/app.ts:2343-2382`), pinned per `(workspace_id, module_id)` with explicit `grantedSecrets` (`src/server/registry/service.ts:260-309,408-413`).
- Built-ins are auto-enabled per workspace (`src/server/skill-api.ts:239-247`). No code disables them.

**Sandbox backends** (`src/server/sandbox/community-runtime.ts:71-180`)

- Gateway path: an HTTPS POST to `TREVRA_SANDBOX_GATEWAY_URL` (`:91-113`). The gateway reloads the release from the DB (`src/sandbox-gateway/index.ts:72-105`).
- Kubernetes Job on gVisor: non-root, read-only rootfs, caps dropped, seccomp, default-deny NetworkPolicy, secrets refused (`src/sandbox-gateway/kubernetes.ts:5-99`; `infra/sandbox/kubernetes.yaml:18-24`).
- Local OCI: `docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --user 65532:65532 --memory --cpus --tmpfs /tmp…` (`community-runtime.ts:131-143`, verified).
- Local WASI: `wasmtime` with a digest check (`:145-154`).
- Remote HTTPS: allow-listed host only (`:115-129`).
- Manifest limits: timeout 1-300 s, memory 32-2048 MB, CPU ≤ 4, output 1 KB-10 MB (`src/server/registry/service.ts:83-88`).
- Secret values are never injected into modules.

**Sandbox call chain and deployment gaps**

- Callers: `executeWorkspaceSkill` (`src/server/skill-api.ts:87,130`) is reached from the agent route (`app.ts:1209`), the UI route (`app.ts:1990`), `app.ts:8282`, the agent tools (`src/server/agent/tools.ts:497`) and the playbook engine (`src/server/playbooks/engine.ts:786`).
- Without a gateway, the local fallback runs with `isolated:false` (`community-runtime.ts:41`).
- The shipped `Dockerfile:19-24` installs no docker CLI or wasmtime.
- Terraform only passes through the gateway URL and token (`infra/gcp/terraform/main.tf:40-41,397-398,527`).
- `docs/sandbox-execution.md:14` says the gateway "has no Trevra database credentials", yet the gateway calls `openDatabase()` (`src/sandbox-gateway/index.ts:104-105`).

**External-write blocking: WIRED, five enforcement points**

- `src/server/skill-api.ts:111,128,249-254` (409)
- `src/server/playbooks/engine.ts:722-742` ("External-write skill… cannot run through the generic playbook skill runner")
- `src/server/registry/service.ts:414-416`
- `src/server/sandbox/community-runtime.ts:180`

### Inferences

- The registry is a differentiator in architecture rather than in content today. The only modules are first-party, so "signed community skill registry" is a capability with no community supply yet.
- In practice community OCI/WASI modules would fail on the stock hosted image unless a gateway is deployed (inference; not run).

### Gaps

- Whether any community module exists in production was not determined. The live `/api/public/modules` was not queried.
- Whether the shipped Kubernetes gateway manifest boots was not tested.

## Security and compliance posture: credentials, analytics redaction, audit, retention, deployment, self-hosting

### Takeaway

Provider OAuth goes through Nango. BYOK and LinkedIn/Reddit credentials are sealed with AES-256-GCM, using per-workspace HKDF keys and row-bound AAD from one env master key (Secret Manager on GCP).

Marketing analytics are privacy-minimised: closed event list, DNT and GPC honoured, hashed session id, no IP column.

Audit and domain events are append-only by application convention only. There are no DB triggers and no RLS.

Owner-only workspace erasure and export are WIRED, though erasure does not delete Nango-held data. Retention jobs exist for only three tables. There is no MFA.

Self-hosting (compose, scripts, docs) and GCP Terraform are complete. There is no license file despite the "open source" claims.

### Cited Findings

**Credential encryption**

- AES-256-GCM, 96-bit IV (`src/server/secrets/crypto.ts:181-184`, verified).
- Per-workspace key: HKDF-SHA256 of the master key with info `workspace:<id>` (`crypto.ts:201-202,494-497`).
- AAD binds the ciphertext to store, workspace, seat and kind (`crypto.ts:478-488`).
- Master key: `TREVRA_SECRETS_KEY`, with a read-only `_PREVIOUS` key for rotation (`crypto.ts:120-132,538-548`).
- The code itself states it is "not per-tenant key custody" and that the upgrade path is KMS or HSM (`crypto.ts:96-110`).
- GCP: the key is a Terraform `random_id` stored in Secret Manager (`infra/gcp/terraform/main.tf:140-142,206-230`). It is also present in Terraform state (`docs/deployment.md:78-82`). No CMEK or KMS.
- Sealed kinds: model API key, CLI OAuth token, LinkedIn and Reddit username/password, Hunter key (`src/server/secrets/store.ts:73-80`). There is no reveal endpoint (`store.ts:7-22`).
- Hosted mode refuses to open LinkedIn or Reddit credentials (`src/server/secrets/custody.ts:304-321`).
- Agent tokens are peppered SHA-256 (`src/server/agent-access.ts:271-272`).

**Analytics redaction**

- Client: closed event union, DNT and GPC honoured, per-tab sessionStorage UUID, pathname only (`src/client/analytics.ts:41-145`).
- Server: event allow-list, `sec-fetch-site` check, 32 KB limit, salted SHA-256 visitor id, referrer reduced to hostname (`src/server/public-site.ts:83-116,404-461,788-795`).
- Table: `marketing_events` has no IP, user-agent or body column (`migrations/002_marketing_events.sql:1-14`).
- Weaknesses:
  - The metadata values are free-form, with no key allow-list (`public-site.ts:115`).
  - The salt falls back to `development-marketing-salt` (`:456-458`).
  - Better Auth sessions record IP and user agent by default, since `disableIpTracking` is not set (agent-read).

**Audit and events**

- `audit_events` (`migrations/001_initial.sql:351-361`) and `domain_events` (`migrations/006_control_plane.sql:1-35`).
- No UPDATE or DELETE code paths and no immutability triggers, so append-only is application-level.

**Retention and erasure**

- Erasure: `src/server/app.ts:3280-3414`, which contains no Nango `deleteConnection` call.
- Prune jobs exist only for:
  - AI citation samples, 13 months (`src/server/watch/citations.ts:60,515-537`)
  - LinkedIn seat events, 45 days (`src/server/linkedin/seat-events.ts:94,158-166`)
  - enrichment history, 13 months (`src/server/enrichment/runs.ts:57,886-904`)
- Licensed provider payloads can be skipped with `retention:'none'` (`src/server/skills/runner.ts:56-62`).

**Authentication and web hardening**

- Better Auth email/password, 7-day sessions, organization plugin (`src/server/auth-service.ts:368-480`).
- Hosted mode uses Authward OIDC at `https://auth.olaryn.com` (`docs/deployment.md:49`). Hosted mode disables local password login (`auth-service.ts:21-24`).
- No `twoFactor` plugin (rg, verified).
- Helmet CSP (`src/server/app.ts:647-648`).

**security.txt**

- Served at `/.well-known/security.txt` (`src/server/public-site.ts:384-390`). `Expires` is recomputed as now + 365 days on every request (`:386`).

**Deployment**

- Self-host:
  - `compose.selfhost.yml:1-96` (read-only rootfs, `cap_drop ALL`, bound to 127.0.0.1)
  - `scripts/selfhost-init.sh`, `scripts/selfhost-deploy.sh`, `scripts/selfhost-backup.sh`
  - `docs/self-hosted-production.md`
  - README.md:127, which says FOSS mode uses built-in Better Auth
- GCP: Cloud Run API plus an internal-only worker, Cloud SQL PG16 with HA, PITR and 14 backups, Secret Manager, and monitoring (`infra/gcp/terraform/main.tf:144-191,232-237,452-457,591-695`). Scripts: `infra/gcp/bootstrap.sh`, `infra/gcp/deploy.sh`.
- Self-hosted Nango: `compose.nango.production.yml`.
- Marketing site on Cloudflare Pages: `wrangler.toml:1-4`.
- Other: an Oracle micro-VM recipe (`infra/oracle/README.md`). CI workflows are in `.github/workflows/`.
- `Dockerfile` uses a digest-pinned `node:24-bookworm-slim` base image and runs as non-root (`:30`).

**License**

- No tracked LICENSE, COPYING or NOTICE (`git ls-files`, verified).
- `package.json` has no license field and `"private": true`. `packages/trevra-cli/package.json` is `"license": "UNLICENSED"` (verified).
- `docs/founder-skills.md:143-153` merely recommends AGPLv3 for the server and MIT for skills.

### Inferences

- Against Dripify, which is a SaaS-only product (repo docs do not claim otherwise), Trevra's self-hosting and data-custody story is a strong differentiator for privacy-sensitive buyers.
- The missing license undercuts the "open source" claim legally (all rights reserved by default).
- Hosted Trevra depends on the separate Olaryn family of services (Authward auth, Olaryn Billing). Only self-host is fully self-contained.

### Gaps

- Privacy-page claims were not compared with actual Better Auth IP logging.
- No SOC 2, GDPR DPA or similar compliance attestations were found in the repo (not searched exhaustively).

## Differentiators: what Trevra does that Dripify does not

### Takeaway

Trevra's distinct value is governance and evidence around agent-run GTM:

- deterministic policy evaluation
- exact-payload, hash-locked human approval before a closed set of idempotent execution adapters
- durable, resumable playbooks (Temporal or Postgres)
- an append-only domain event stream with a hash-manifested ledger export
- evidence and confidence tagging (HARD FACT vs REPORTED)
- global suppressions and lawful-basis checks
- an MCP and agent-token surface
- a signed module registry with sandboxing
- self-hosting

Some of these are only partly delivered:

- proof packs never reach the UI
- append-only is convention, not DB-enforced
- the legacy delegated-approval service has no production caller

### Cited Findings

**Append-only domain events: WIRED, convention-enforced**

- `appendDomainEvent` writes per-stream versioned events with actor, causation and correlation ids (`src/server/control-plane/events.ts:35-74`), backed by `UNIQUE(workspace_id, stream_type, stream_id, stream_version)` (`migrations/006_control_plane.sql:1-35`).
- Read at `GET /api/control-plane/events` (`src/server/app.ts:2157-2162`) and by the agent API (`app.ts:1316`).
- Writers include the playbook engine, lead capture, provider webhooks, compliance, enrichment, LinkedIn handoff and skill-api.
- No triggers prevent UPDATE or DELETE.

**Exact payload hashing: WIRED**

- `canonicalPayloadHash` is sha256 of key-sorted `stableJson` (`src/server/control-plane/payload.ts:1-16`), used at `src/server/playbooks/engine.ts:381,568,944`.

**Deterministic policy engine: WIRED**

- Evaluation order (`src/server/control-plane/policy.ts:43-106`):
  1. A non-overridable lawful-basis deny.
  2. Workspace policies by priority, with glob patterns and conditions (actorTypes, sideEffects, playbookIds, skillIds, environments, minConfidence, maxRecipients).
  3. A built-in `require_approval` for `external-write` (`:87-96`, verified).
  4. Otherwise allow.
- Missing data fails closed (`:193-225`).
- Callers: `engine.ts:536,723,743`. CRUD: `/api/policies` (`app.ts:2166+`, owner-only writes). UI: `LimitsView` (`src/client/App.tsx:2711+`).

**Approvals: WIRED**

- `decidePlaybookApproval` locks the step `FOR UPDATE` and rejects hash drift (`src/server/playbooks/engine.ts:230-270`). Edits recompute the hash (`:351-411`).
- `runActionStep` (`:528-601`):
  1. Resolves the payload.
  2. Evaluates policy.
  3. Requires a completed approval with a matching hash.
  4. Writes `action.execution_started`.
  5. Runs the adapter with the hash as the idempotency token.
  6. Writes `action.executed`.
- Approve and reject UI: `src/client/views/LedgerView.tsx:412-439`.

**Closed execution adapters: WIRED**

- The set is `email.send`, `community.reply`, `crm.log-activity`, `buffer.create-draft` (`src/server/control-plane/execution.ts:24-30`, verified).
- `email.send` re-checks four things at send time (`execution.ts:55-74,223-371`): the mailbox binding, the compliance footer, suppression and do-not-contact, and that replies are still synced.
- LinkedIn actions are not in this set; they run through the LinkedIn engine (other researcher).

**Durable playbooks: WIRED**

- Lease-claimed steps, stale-lease recovery, and retries (3 attempts, 30 s) (`src/server/playbooks/engine.ts:644-700,968-1007`).
- Temporal mode (`TREVRA_ORCHESTRATOR=temporal`) runs `playbookOrchestratorWorkflow` with a `resumePlaybook` signal (`src/server/orchestration/client.ts:6-24`; `src/server/orchestration/workflows.ts:21-34`). Postgres mode polls in the worker (`src/worker/index.ts:139`).
- The mode is chosen at deployment; there is no automatic failover.

**Suppressions: WIRED**

- Table `migrations/101_global_gtm_suppressions.sql:7-40` targets a person, email, domain or LinkedIn URL. Lifted rows are kept, not deleted.
- Enforced in email send, enrichment, the LinkedIn guard and campaigns: `src/server/suppressions.ts:83-301`; `src/server/control-plane/execution.ts:340`; `src/server/linkedin/guard.ts:60,486-495`; `src/server/linkedin/managed-campaigns.ts:969`.

**Consent and compliance: WIRED for email, no LinkedIn enforcement found**

- Lawful basis per person and channel (`migrations/134_consent_and_linkedin_safety.sql:49-73`; `src/server/compliance/lawful-basis.ts:89-434`).
- Jurisdiction rules carry a "Not legal advice" disclaimer (`src/server/compliance/jurisdiction-rules.ts:12-41`).
- Sender identity and footer: `src/server/compliance/sender-identity.ts:68-170`.
- A lawful-basis check on LinkedIn sends was not found.

**LinkedIn safety guard: WIRED** (detail belongs to the other researcher)

- 16 named checks (warm-up, rolling windows, acceptance rate, business hours, InMail quota, pending-invite backlog, duplicate target, linked identity) at `src/server/linkedin/guard.ts:57-93`.
- Confidence tags HARD FACT / REPORTED are shown in the UI (`src/client/LinkedInViz.tsx:30-54`).

**Proof packs: PARTIAL**

- `upsertProofPack` writes `proof_packs` and `proof_pack_items` (category, excerpt, source, URL, observed_at) from the worker's recommendation cycle (`src/server/recommendation-engine.ts:130,146-190`; `src/server/automation-service.ts:91`).
- No UI reads them:
  - `listRecommendations` (`src/server/serializers.ts:9-80`) has no caller (verified).
  - `src/client` has no `proofPack` reference (verified).
- The evidence the user sees comes from `recommendation_evidence` (`src/server/today.ts:197-215`) and approval cards (`src/client/views/inspector.tsx:746+`).

**Legacy delegated approvals: STUBBED**

- `src/server/action-service.ts` (`prepareAction`, `approveActionByRule`, `executeAction`) is imported only by its test (verified).

**Registry, sandbox, MCP and self-host**

- See the earlier sections.

### Inferences

- For a Dripify comparison, the differentiators group into three themes:
  1. Safety and accountability: approval gate, policy, suppressions, lawful basis, LinkedIn guard.
  2. Evidence and audit: ledger export, domain events, evidence tagging.
  3. Openness and extensibility: MCP, agent API, module registry, self-host.
- Dripify (per repo docs) offers none of these.
- Against that, Trevra lacks the commercial plumbing Dripify sells to agencies: CRM push, Zapier, team analytics, client workspaces, white-label, seats.

### Gaps

- Not verified against Dripify's current product whether it offers any approval, audit or export features. The comparison above relies on Trevra's internal `docs/competitive-landscape.md:81`.

## Client screens: SECTIONS / SUB_ROUTES / SHELL_PATHS mapped to what each screen does

### Takeaway

The app has five path-routed sections: Loop, Outreach, Ledger, Research and Setup.

The names `SHELL_PATHS` and `APP_PATH_HEADS` cited in AGENTS.md no longer exist. The real names are `isAppPath` on the client and `APP_PATH_PATTERNS` on the server.

The two route tables mostly agree. One server-only path (`/outreach/settings`) and one broken in-app link (`/outreach/safety`) are mismatches.

### Cited Findings

**Router**

- `SECTIONS = ['loop','outreach','ledger','research','setup']` (`src/client/ui/route.ts:35-37`, verified).
- `SUB_ROUTES` (`route.ts:40-47`, verified):
  - loop: '', cost
  - outreach: '', new, campaign, workflow, inbound, inbox, opportunities, posts
  - ledger: '', run
  - research: ''
  - setup: '', workspace, capture, billing, team
- Shell mount: `src/client/App.tsx:404-437`.

**Screen map**

- `/loop` → `LoopView`. Founder home: onboarding, Today feed (needs you / working / recent results), "Going out" and "Waiting on a reply" cards, planner, and a collapsed "Performance and cost" funnel (`src/client/views/LoopView.tsx`).
- `/loop/cost` → `LoopCostView`. Model spend vs work and results (`LoopView.tsx:1532+`).
- `/outreach` → `OutreachManagerRead`, with "Find people" (`OutreachLeads`) and "Target accounts" (`AccountsScreen`) folds (`src/client/views/OutreachView.tsx:277-313`). Shows the campaign list, results panel and CSV export.
  - Outreach tab bar: Campaigns / Inbound / Messages / Opportunities / Posts (`OutreachView.tsx:133-149`).
- `/outreach/new` → campaign builder (`OutreachView.tsx:261`).
- `/outreach/campaign/:id` → a single campaign (`:262-268`).
- `/outreach/workflow/:workflowId[/:campaignId]` → step and workflow editor (`:35-131,269-276`).
- `/outreach/inbound` → `InboundPeople`: submissions, milestones, attribution.
- `/outreach/inbox` → `SharedConversations` (cross-channel) or the LinkedIn inbox (`:232-258`).
- `/outreach/opportunities` → `Opportunities` stage list.
- `/outreach/posts` → `LinkedInPosts`, scheduled posts with Buffer draft.
- `/ledger` and `/ledger/run/:id` → `LedgerView`: playbook and agent runs, inline approve and reject, filters, ledger export, and a run inspector (`src/client/views/LedgerView.tsx:443-460`; `src/client/views/inspector.tsx`).
- `/research` → `ResearchView`: market pulse, stories, distribution outcomes, discovered threads, mentions, company research (`src/client/views/ResearchView.tsx:1348-2276`).
- `/setup` → Access tab: `AgentAccessPanel` (agent tokens and MCP commands) and `HostedAgentPanel` (`src/client/App.tsx:625-631`).
- `/setup/workspace` → Connections (Nango), GitHub repos, email channel, sender identity, policies (`LimitsView`), enrichment (Hunter), LinkedIn exclusions, team, and owner-only data export and erasure (`App.tsx:598-622`).
- `/setup/capture` → `LeadCaptureSetup`, capture sources and Stripe/Cal.com webhook setup (`App.tsx:593-594`).
- `/setup/billing` → `BillingSettings` (`App.tsx:595-596`).
- `/setup/team/:invitationId` → the accept-invitation screen (`App.tsx:557-572`).
- `/login` → `AuthScreen` (`route.ts:77`).

**Server allow-list and mismatches**

- Server `APP_PATH_PATTERNS` is at `src/server/index.ts:75-88` (verified).
  - It includes `/outreach/settings`, which is absent from client `SUB_ROUTES`. `route.test.ts:64,165` treats it as a removed alias.
- `rg "SHELL_PATHS|APP_PATH_HEADS" src` returns nothing (verified). They appear only in AGENTS.md and older docs.
- `src/client/LinkedInAnalyticsScreen.tsx:228` links to `/outreach/safety`, which is neither a client route nor a server pattern, so a click results in a 404.

### Inferences

- The navigation is founder-oriented (Loop, Ledger, Research). Dripify-style concepts (Campaigns, Leads, Inbox, Analytics) are folded into the Outreach section rather than being top-level.
- There is no dedicated Analytics screen; campaign stats live inside Outreach and the Loop "Performance and cost" fold.

### Gaps

- Screens were not rendered. One-line descriptions come from component reads, not observed UI.
