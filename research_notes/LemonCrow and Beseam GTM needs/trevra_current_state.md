> **Historical baseline (6 October 2026):** file references and claims below have not been revalidated against the latest Trevra `main`.

# Trevra current state: capability baseline for LemonCrow and Beseam GTM

Scope and method: main branch at `a2bcb0b` ("feat(gtm): prepare capture and watch plans, populate Today work/results", 2026-10-06). The repo has 454 commits since 2026-07-23 (`git rev-list --count HEAD`; `git log`). All paths are relative to `/home/pankaj/Projects/Trevra`, and every citation is a repo file (path:line).

Method: I read the docs directly. Then three parallel read-only code audits checked outreach, research/content and platform. I spot-checked their key claims myself: the LinkedIn limits table, the intent compiler, the Today item kinds, the integration catalog, where the content UI lives, the mailbox UI, and whether registry and skill-run have UI callers. Two audit claims were wrong and are corrected below:

- Content screens live on `/research`, not `/outreach/opportunities`.
- Mailbox settings do have a UI, in the campaign config screen.

"Shipped and wired" means three things hold:

- a server route exists in `src/server/app.ts`;
- a client screen or the worker calls that route;
- the code path is not a placeholder.

Size of the codebase:

- `src/server`: about 108k non-test lines of TypeScript (180k with tests).
- `src/client`: about 44k non-test lines.
- 186 test files and 123 SQL migrations (`find`/`wc`). The migrations run from `001_initial.sql` to `129_account_watch_preparations.sql`, with gaps in the numbering.
- `src/server/app.ts` alone is 10,416 lines and holds nearly every HTTP route (`wc -l`).

## Q1. What do PRODUCT.md, README.md, first-run, integration-contracts and the specs say Trevra does and intends to do?

### Takeaway

Trevra describes itself as an open-source "GTM operating system and control plane" for founders. Agents research, score, draft and prepare. Deterministic policy and exact-payload human approval govern every external write.

The docs deliberately exclude:

- post-sale work (projects, contracts, invoices, payments, accounting);
- CRM-object or revenue platforms;
- arbitrary event ingestion and generic webhook automation.

The two "canonical" design specs are marked _Proposed_. Several sub-specs are "approved, pending implementation", and a few docs are stale relative to the code.

### Cited Findings

- Purpose: "helps a workspace find and understand accounts and people, capture inbound demand, operate outreach, manage conversations, qualify opportunities, and learn from GTM outcomes." — [PRODUCT.md:15](PRODUCT.md)
- Trevra owns the state needed to run the loop safely: People, Accounts, Signals, Inbound Submissions, Conversations, Opportunity-lite, Campaigns, Playbooks, agent runs, evidence, policies, approvals, prepared actions, deliveries, and the GTM ledger. — [PRODUCT.md:17](PRODUCT.md)
- It deliberately does not own project delivery, contracts, scope, milestones, customer invoices, payments, accounting, arbitrary application events, generic webhooks, or a general automation platform. — [PRODUCT.md:19](PRODUCT.md); [README.md:5](README.md)
- Positioning promise: "Know who is worth pursuing and why now. Let agents do the research and preparation. Keep consequential GTM execution under human control." — [PRODUCT.md:29](PRODUCT.md)
- Founder loop: Find, then Reach, then Answer, then Qualify/Convert, then learn and find again. Primary navigation is limited to five places: Loop, Outreach, Ledger, Research and Setup. There is "no Money/post-sale destination". — [PRODUCT.md:42-59](PRODUCT.md); [docs/gtm-shell-shape.md:32-42](docs/gtm-shell-shape.md)
- Opportunity-lite stages are new, qualified, meeting, proposal, then won or lost. "No amount, forecast, quote, territory, or arbitrary CRM-object platform belongs in Trevra core." — [PRODUCT.md:81-87](PRODUCT.md)
- The approval invariant runs in this order:
  1. decision;
  2. prepared exact action;
  3. payload hash;
  4. policy evaluation;
  5. human approval when required;
  6. deterministic adapter;
  7. durable delivery and outcome.

  "No agent approves its own consequential work." Editing a prepared payload invalidates the approval. — [PRODUCT.md:89-105](PRODUCT.md)

- The founder-facing objectives are a bounded set: `find_accounts`, `research_accounts`, `prepare_outreach`, `watch_accounts`, `capture_inbound`. The interaction is "Goal -> deterministic Plan -> Prepare -> Result / decision". — [PRODUCT.md:107-121](PRODUCT.md)
- Integration admission rule: a connector must either observe GTM state or execute a named GTM action. Nango sync accepts only canonical `message` and `opportunity` records. — [docs/integration-contracts.md:14-50, 99-106](docs/integration-contracts.md)
- Prepared execution action types (doc): `email.send`, `community.reply`, `crm.log-activity`, `buffer.create-draft`. — [docs/integration-contracts.md:56-63](docs/integration-contracts.md). The code matches: `EXECUTION_ACTION_TYPES` holds the same four, per [src/server/control-plane/execution.ts:15-20](src/server/control-plane/execution.ts). README is stale here: it lists only the first three. — [README.md:36](README.md)
- The doc says these are "explicitly removed": projects, contracts, milestones, invoices, payments, accounting actions, customer Stripe webhooks, "generic `/api/events` ingestion", generic remote action adapters, and workflow `webhook`/`external_handoff` nodes. — [docs/integration-contracts.md:108-122](docs/integration-contracts.md). However, `POST /api/events` still exists as a route. It is guarded by `INGEST_API_KEY` and calls `ingestCanonicalRecord`, so it is narrowed to canonical records rather than generic. — [src/server/app.ts:4114](src/server/app.ts)
- README's "What is implemented" list:
  - target-account import, sourcing, enrichment and scoring;
  - LinkedIn accounts, lead lists, workflows, managed campaigns and inbox;
  - Gmail/M365 message sync and delivery through Nango;
  - public-community research and governed replies;
  - CRM reads plus `crm.log-activity`;
  - minimal opportunity state;
  - durable playbooks, approvals and policies;
  - export and erasure.

  — [README.md:21-32](README.md)

- Agents can be operated from Claude Code or Codex through a restricted agent API, a stdio MCP server and a hosted Streamable HTTP MCP endpoint. Agent tokens "cannot approve or execute consequential actions". — [README.md:55-77](README.md)
- Spec statuses as written in their headers:
  - agent-native GTM OS: "Proposed canonical product architecture" ([docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md));
  - ruthless-simplicity intent compiler: "Proposed canonical UX/product design" ([2026-08-21 spec](docs/superpowers/specs/2026-08-21-ruthless-simplicity-intent-compiler-design.md));
  - generic lead capture: "Implemented in Trevra core; live Beseam deployment cutover pending" ([2026-08-20-generic-lead-capture-design.md:4](docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md));
  - team-workspace access, outreach-inbox redesign, research hub: "approved, pending implementation plan";
  - research-thread triage: "designed, not built";
  - setup simplification: "approved design, not yet implemented";
  - brand/keyword watch: "approved, ready for implementation planning", although brand watches are now shipped in code (see Q2).

  Source for the statuses: the spec headers in `docs/superpowers/specs/*.md`, checked with grep.

- The canonical spec's own self-assessment (§18) lists these items as still open:
  - unsubscribe/OOO/unverified-reply classification and a channel-neutral Delivery object (partial);
  - "[ ] Durable Agent principal/team product model";
  - "bounded Find/Research preparation remains";
  - "[ ] Growth-service state migration and complete retirement".

  — [agent-native spec:829-849](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md). It contradicts itself: Phase 4 marks "[x] Add durable Agent principal records" and "[x] Add GTM team UI for human + agent actors" ([spec:916-922](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)), and `migrations/105_agent_principals.sql` exists.

- Intended but not built as a dedicated surface: an "Agent team" view with Scout, Researcher, Outreach and Inbox agents. Each would show purpose, permissions, active goal, recent runs, pending approvals and blockers. — [agent-native spec:763-806](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- Beseam intent:
  - Beseam's `ecom-clean-lp` landing page uses a Cloudflare Worker. The Worker posts `/api/lead` to Trevra intake and keeps edge validation, honeypot and product proxies. It gives up GTM ownership: "no SendPulse-as-source-of-truth". — [agent-native spec:515-546](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md); [generic-lead-capture spec:863-890](docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md)
  - Live cutover status: "live Capture Source provisioning/verification is pending", and "[ ] Remove SendPulse/local website lead state" is unchecked. — [agent-native spec:899-900](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- LemonCrow intent: community outreach is designed to "Find threads where people are complaining about what an AI coding agent costs them, and reply with something useful — under an approval gate". It was ported from `tools/outreach/` in the `lemoncrow-dev` tree. — [docs/community-outreach.md:3-8](docs/community-outreach.md)
- Stale strategy doc: `docs/founder-skills.md` still says "Close — proposal, agreement, scope, change order | exists: Trevra commercial graph" and "Collect — milestone, invoice, payment, dunning | exists". — [docs/founder-skills.md:64-65](docs/founder-skills.md). These were later removed: see `migrations/095_remove_post_sale_revenue_domain.sql`, `106_opportunity_lite_and_legacy_client_removal.sql` and `107_drop_generic_commercial_projections.sql`. They are also forbidden by [PRODUCT.md:142](PRODUCT.md).

### Inferences

- The product direction narrowed sharply around 2026-08-20. It started as a "growth + CRM + delivery/billing" idea (founder-skills.md) and became a pure GTM OS. Post-sale code was deleted, not hidden. Any expansion into proposals, invoicing or CRM objects would reverse an explicit product decision, not fill an oversight.
- Several docs (README action list, founder-skills.md, brand-watch spec status, the simplicity-audit route names) lag the code. Anyone comparing against the market should trust code citations over doc claims.

### Gaps

- I did not read the 1,061-line agent-native spec or the 1,313-line intent-compiler spec in full. I read only §4–6, §10, and §17–21.
- I did not read `docs/app-spec.md`, `docs/core-product.md`, `docs/swan-parity.md` or `docs/competitive-landscape.md`.

## Q2. Which GTM functions are actually implemented, and how mature is each?

### Takeaway

LinkedIn outreach is by far the deepest piece. It has about 100 manager routes, Dripify-parity campaign features and code-owned safety bands.

Around it sit shipped, wired subsystems:

- account sourcing, signals and scoring;
- brand/keyword watch;
- evidence-backed content drafting;
- signed inbound capture;
- Opportunity-lite;
- the Today attention projection;
- durable playbooks with exact-payload approvals;
- an MCP and agent API.

Email outreach, unified conversations, people enrichment, the intent compiler, attribution and CRM sync are partial. The module registry and skill execution have server code but no UI. Billing is wired but off by default.

### Summary table (maturity as verified in code)

| GTM function                                               | Maturity                                  | Founder-facing UI                                                                                                      | Key code / routes                                                                                 | External dependencies                                                                       |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Account sourcing, research, scoring                        | Shipped and wired                         | `/outreach` "Target accounts" fold; `/research` "Company research"                                                     | `src/server/accounts/*`, `/api/accounts*` (app.ts:7486-7683), `/api/research*` (app.ts:3793-3827) | Free seed and directory sources; Exa needs `EXA_API_KEY`; Apollo deliberately absent        |
| Signals and watch sweeps                                   | Shipped and wired (worker)                | `/research`, Today `high_priority_account`                                                                             | `accounts/sweep.ts`, `skills/signal.ts`, `observations/*`                                         | Public web crawl; YouTube, Facebook, Instagram and Meta Ad Library env tokens               |
| People, contacts, enrichment                               | Partial                                   | `/outreach/inbound`, lead lists                                                                                        | `person-identities.ts`, `skills/enrich.ts`, `skills/contact.ts`                                   | No paid enrichment; `find_email` uses an unset-by-default generic HTTP hook                 |
| LinkedIn outreach (campaigns, seats, safety, inbox, posts) | Shipped and wired; most mature            | `/outreach`, `/outreach/new`, `/outreach/campaign/:id`, `/outreach/workflow/...`, `/outreach/inbox`, `/outreach/posts` | `src/server/linkedin/*` (about 45 files), `/api/linkedin/*`                                       | `trevra` Companion CLI driving Chrome on the founder's computer                             |
| Email outreach and deliverability                          | Partial                                   | Campaign email steps; mailbox settings inside campaign config; reply from Messages                                     | `email-deliveries.ts`, `linkedin/campaign-channels.ts`, `email.send` adapter                      | Gmail or Microsoft 365 via Nango; no warmup, rotation or DNS checks                         |
| Inbound lead capture                                       | Shipped and wired (server-to-server only) | `/setup/capture`, `/outreach/inbound`                                                                                  | `src/server/lead-capture/*`, `POST /api/intake/v1/submissions`                                    | HMAC-signed requests from the founder's backend; no embeddable form                         |
| Conversations / unified inbox                              | Partial                                   | `/outreach/inbox` (Conversations or LinkedIn inbox toggle)                                                             | `conversations.ts`, `/api/conversations*`                                                         | LinkedIn and email only                                                                     |
| Opportunities / pipeline                                   | Shipped (lite)                            | `/outreach/opportunities`                                                                                              | `opportunities.ts`, `demand/*`                                                                    | No CRM deal push                                                                            |
| Content and social posting                                 | Shipped, but draft and handoff first      | `/research` (Market pulse, Market stories, Distribution outcomes); `/outreach/posts`                                   | `src/server/content/*`, `channels/*`, `linkedin/posts.ts`                                         | LinkedIn posts via Companion; Buffer draft-only; most channels prepare-only                 |
| Brand/keyword watch and community listening                | Shipped and wired                         | `/research` (Mentions, Discovered threads)                                                                             | `src/server/watch/*`, `outreach/scouts/*`, `/api/watches*`                                        | HN, Stack Overflow, Lobsters, GitHub, Reddit (OAuth), Mastodon (token)                      |
| Today / attention                                          | Shipped and wired                         | `/loop`                                                                                                                | `today.ts`, `GET /api/today`                                                                      | none                                                                                        |
| GTM intent compiler                                        | Partial (3 of 5 objectives preparable)    | `/loop` plan form                                                                                                      | `gtm/intent.ts`, `/api/gtm/plan`, `/api/gtm/prepare`                                              | none                                                                                        |
| Playbooks and approvals                                    | Shipped and wired                         | `/ledger`, `/ledger/run/:id`; policies in `/setup/workspace`                                                           | `playbooks/*`, `control-plane/*`, `action-service.ts`                                             | none                                                                                        |
| Agents and automation, MCP/API                             | Shipped                                   | `/setup` (Access tab)                                                                                                  | `agents.ts`, `agent/*`, `mcp-http.ts`, `src/worker/index.ts`                                      | BYOK OpenAI-compatible model; self-host CLI (`claude -p` / `codex exec`); Temporal optional |
| Billing and plans                                          | Wired, off by default                     | `/setup/billing`                                                                                                       | `billing-client.ts`, `/api/billing*`                                                              | External Olaryn billing service plus Authward                                               |
| Module registry and sandbox                                | Server-only, no UI                        | none                                                                                                                   | `registry/service.ts`, `sandbox/community-runtime.ts`                                             | Separate sandbox gateway                                                                    |
| Integrations via Nango                                     | Shipped                                   | `/setup/workspace` connections                                                                                         | `integration-service.ts`                                                                          | Nango (self-hosted or hosted)                                                               |
| Public discovery                                           | Shipped                                   | Marketing site, `/signals/:slug`                                                                                       | `public-site.ts`                                                                                  | Cloudflare Pages for the static site                                                        |
| Analytics / attribution                                    | Partial                                   | `/loop/cost`, `/research` "Distribution outcomes"                                                                      | `loop-cost.ts`, `content/performance.ts`, `marketing_events`                                      | none                                                                                        |
| Team and workspace                                         | Shipped (owner/member)                    | `/setup/workspace`, `/setup/team/:id`                                                                                  | Better Auth organization plugin, `/api/team/members`, `/api/workspace/*`                          | SMTP for invitation mail                                                                    |
| Reddit account automation                                  | Partial, self-host only                   | Collapsed disclosure inside `/research`                                                                                | `src/server/reddit/*`                                                                             | Playwright on a local worker                                                                |
| SEO / AI-search visibility                                 | Partial (prospect audit skill only)       | none                                                                                                                   | `skills/audit.ts`                                                                                 | none                                                                                        |

### Cited Findings

**Account research and scoring (shipped and wired)**

- How accounts are created:
  - provider sourcing: `POST /api/accounts/source` (app.ts:7521);
  - CSV/file import: `POST /api/accounts/import` (app.ts:7589);
  - the `watch_accounts` prepare path.

  `AccountsScreen` is mounted as the "Target accounts" fold on `/outreach`. — [src/client/views/OutreachView.tsx:297-312](src/client/views/OutreachView.tsx); [src/server/app.ts:7486-7683](src/server/app.ts)

- Source providers:
  - `seed`: a pasted domain list; free and the default.
  - `directory`: crawls a directory page.
  - `exa`: needs `EXA_API_KEY`. Results are held in memory only, never persisted, because of Exa's ToS.
  - Deployment-owned HTTP adapters.
  - Apollo is deliberately withheld because of its ToS.

  — [src/server/research/registry.ts:30-62](src/server/research/registry.ts); [src/server/research/providers/exa.ts:38, 79-85](src/server/research/providers/exa.ts); [src/server/integration-service.ts:78-84](src/server/integration-service.ts)

- The Exa card on the integrations screen is cosmetic. "connecting here does not switch it on yet", because research reads the key from the server environment instead. — [src/server/integration-service.ts:143-158](src/server/integration-service.ts)
- The score is an additive, time-decayed _signal_ model, not an ICP-fit model:
  - Largest weights: `thread-mention` 34, `meta-ads-rising` 32, `meta-ads-started` 30, `hiring-up` 30, `product-launch` 29, `pricing-changed` 28.
  - 60-day window and 21-day half-life.
  - Combination bonuses (for example, ads rising plus a product launch).
  - A single-kind cap of 45.
  - A -40 "rejected shape" penalty learned from "not a fit" feedback.
  - Tiers: "hot" needs a score of 70 or more and at least two distinct signal kinds; "warm" needs 25 or more.

  — [src/server/accounts/score.ts:81-192, 334-460](src/server/accounts/score.ts)

- ICP is only a free-text `icp_note` column, and the scorer does not read it. — [src/server/accounts/store.ts:71, 165](src/server/accounts/store.ts) (audit grep of `icpNote`)

**Signals and sweeps (shipped and wired)**

- The worker runs `runAllAutomationCycles` on an interval. Each cycle does a paced per-account public-website sweep, then a rescore, then the recommendation engine, then demand-reply promotion, then market-pulse schedules. — [src/worker/index.ts:121-129, 246](src/worker/index.ts); [src/server/automation-service.ts:30-113](src/server/automation-service.ts)
- Sweep throughput is low: `SWEEP_ACCOUNTS_PER_CYCLE = 2`, a 20–90 s gap between accounts, a daily re-sweep with jitter, and a 2h/6h/24h backoff. — [src/server/automation-service.ts:22](src/server/automation-service.ts); [src/server/accounts/sweep.ts:180-197](src/server/accounts/sweep.ts)
- Signal kinds:
  - hiring up/down, pricing changed, headline changed, tech added/removed, product launch, release notes changed;
  - integration added/removed, customer proof added/removed;
  - storefront rebuild, commerce app added/removed;
  - newsletter signup/started/silent, social profile/growth/cadence;
  - Meta ads started/rising, and thread mention.

  There are no funding or news signals. — [src/server/accounts/types.ts:24-53](src/server/accounts/types.ts)

- Observation providers:
  - free public feeds: Substack, Beehiiv, generic newsletter;
  - YouTube Data API (`TREVRA_YOUTUBE_API_KEY`);
  - Facebook page (`TREVRA_FACEBOOK_PAGE_ACCESS_TOKEN`);
  - Instagram business discovery (`TREVRA_META_GRAPH_ACCESS_TOKEN`);
  - Meta Ad Library (`TREVRA_META_AD_LIBRARY_ACCESS_TOKEN`).

  These are configured by deployment env vars, not per workspace. — [src/server/observations/health.ts:177-189](src/server/observations/health.ts); [src/server/observations/providers/](src/server/observations/providers/)

- The shared crawler (`TrevraCrawler/1.0`) has an SSRF guard, respects robots.txt, and caps response size at 8 MB. The storefront crawler detects Shopify or WooCommerce and reads public catalogs. These are the ecommerce-flavoured signals that matter for Beseam. — [src/server/crawl/public-web.ts:1-16](src/server/crawl/public-web.ts); [src/server/storefront/crawler.ts:100, 326](src/server/storefront/crawler.ts); [docs/ecommerce-observation-plane.md](docs/ecommerce-observation-plane.md)

**People, contacts, enrichment (partial)**

- `gtm.enrich-company` reads firmographics only from the company's own site (JSON-LD, Open Graph, scripts, headers). It is "zero credentials by design" and does not infer headcount, revenue or funding. — [src/server/skills/enrich.ts:16-31, 688](src/server/skills/enrich.ts)
- `gtm.find-contact` crawls same-origin pages (`/contact`, `/about`, `/team`, `/imprint`) for published `mailto:` addresses and social links. Guessed addresses are off by default. — [src/server/skills/contact.ts:41, 274](src/server/skills/contact.ts)
- Identity resolution is deterministic: email, E.164 phone, LinkedIn URL, or provider identity. "Fuzzy names ... are not identity keys." — [PRODUCT.md:65](PRODUCT.md)
- The LinkedIn-campaign `find_email` step is capped by `enrichment_credit_cap`. It calls a generic `TREVRA_EMAIL_ENRICHMENT_URL`; if that is unset it returns `email:not-found`. No vendor is bundled and there is no credit purchase flow. — [src/server/linkedin/campaign-channels.ts:367-435](src/server/linkedin/campaign-channels.ts); [migrations/094_linkedin_enrichment_credits.sql](migrations/094_linkedin_enrichment_credits.sql)
- No email-finder or phone-enrichment vendor (Apollo, Clearbit, Hunter, ZoomInfo, Lusha, PDL) appears in `src/`. The only hits are comments explaining why Apollo is absent. (Audit grep, plus my own grep of `src/server`, `src/client` and `src/worker`.)

**LinkedIn outreach (shipped and wired, the deepest subsystem)**

- The route surface covers:
  - seats;
  - managed campaigns: CRUD, start/pause/stop, waves, queue, owner, duplicate, retry, move members, per-member timeline/skip/resume;
  - workflows with validation;
  - lead lists (preview, import, profile URLs, signals);
  - lead sources;
  - inbox (threads, sync, reply);
  - withdrawals;
  - scheduled posts;
  - analytics.

  — `/api/linkedin/manager/*` and `/api/linkedin/*` in [src/server/app.ts:4173-7069](src/server/app.ts) (my route extraction; roughly 100 manager routes)

- A Dripify-parity audit marked these as built and wired end to end:
  - all 6 workflow actions;
  - A/B messages (now up to 4 arms);
  - hour/day delays;
  - merge variables;
  - import from search URL, Sales Navigator and CSV with a name scrubber;
  - leads from post commenters;
  - per-seat proxy;
  - automatic acceptance detection.

  — [BRIEF_GAP_CHECK.md:5-42](BRIEF_GAP_CHECK.md)

- Code-owned safety bands (warm-up vs steady, per day / per week):
  - invite 10/20 vs 18/90;
  - DM 4/10 vs 12/60;
  - profile view 30 vs 45 per day;
  - InMail 50 per month.

  — [src/server/linkedin/limits.ts:164-185](src/server/linkedin/limits.ts) (verified)

- The guard runs 15 named checks: seat paused, suppression, warm-up ceiling, rolling 24h/7d/30d windows, day-over-day delta, acceptance rate, business hours, weekend, InMail quota, pending-invite backlog, duplicate target, and others. — [src/server/linkedin/guard.ts:75-91](src/server/linkedin/guard.ts)
- Lead source kinds: search, post, sales_navigator, content, recruiter, group_members, event_attendees, company_employees. A cloud browser is refused for sourcing. — [src/server/linkedin/leads.ts:105-169](src/server/linkedin/leads.ts)
- Execution needs the founder's computer:
  - The "Companion" is the `trevra` npm CLI in `packages/trevra-cli`. It installs an OS service and drives a dedicated Chrome profile over CDP, relayed to hosted Trevra by an outbound WebSocket.
  - "A signed-in Trevra tab must still remain open when work should run; if the laptop companion or website disappears, due work stays queued."
  - Only one companion device is allowed per workspace.

  — [README.md:79-93](README.md); [docs/linkedin-companion.md](docs/linkedin-companion.md)

- A hosted cloud-browser path exists behind a consent acknowledgement, but it is "verified against fakes only — no real cloud-browser key, no real LinkedIn login". — [BRIEF_GAP_CHECK.md:32, 46](BRIEF_GAP_CHECK.md); [src/server/linkedin/hosted-execution.ts:231](src/server/linkedin/hosted-execution.ts)
- LinkedIn engagement (follow, like, endorse) via `/api/linkedin/engagement` and the hosted-execution acknowledgement have no client caller. They are reachable only through the API or an agent. — [src/server/app.ts:7129, 4681-4741](src/server/app.ts) (confirmed with grep of `src/client`)
- Scheduled LinkedIn posts: CRUD, media (up to 9 images of 10 MB each), and `publish-now`. `publish-now` only sets `status:'scheduled', scheduledAt: now`, so the worker or Companion publishes the post. — [src/server/app.ts:5115-5140](src/server/app.ts); [src/server/linkedin/posts.ts:18-19](src/server/linkedin/posts.ts); [src/server/linkedin/jobs.ts:1651-1691](src/server/linkedin/jobs.ts)

**Email outreach and deliverability (partial)**

- Email steps (`email`, `find_email`) run _inside_ LinkedIn-managed campaigns. Branch conditions include available, opened, clicked, bounced, replied and found. Open and click tracking uses `/t/e/:token/open.gif` and `/t/e/:token/c/:linkToken`. — [src/server/linkedin/workflows.ts:110-115, 328, 342](src/server/linkedin/workflows.ts); [src/server/app.ts:630-642](src/server/app.ts); [migrations/097_linkedin_campaign_email_tracking.sql](migrations/097_linkedin_campaign_email_tracking.sql)
- Sending goes through Gmail (`/gmail/v1/users/me/messages/send`) or Microsoft Graph via Nango. — [src/server/integration-service.ts:628-718](src/server/integration-service.ts)
- Delivery claims are idempotent on the payload hash, with states sending, sent, failed and uncertain. The default cold-email cap is 50 per day per mailbox (clamped 1–500), and replies are exempt. — [src/server/email-deliveries.ts:68, 188-226](src/server/email-deliveries.ts)
- Mailbox settings (daily limit, timezone, working days, hours) are editable in the campaign config UI. — [src/client/LinkedInManagerCampaignConfig.tsx:624, 1028](src/client/LinkedInManagerCampaignConfig.tsx); [src/server/app.ts:5281-5316](src/server/app.ts)
- Bounce and unsubscribe handling is real. Provider threads are polled. A bounce or an unsubscribe creates a suppression. Regex classifiers separate reply, out-of-office, auto-reply, bounce and delivery failure. — [src/server/linkedin/campaign-channels.ts:925-941, 1055-1144](src/server/linkedin/campaign-channels.ts); [src/server/email-outcomes.ts:36-95](src/server/email-outcomes.ts)
- There is no inbox rotation: the most recently updated connected mailbox is used. There is also no domain warm-up and no SPF/DKIM/DMARC check. — [src/server/linkedin/campaign-channels.ts:218-236](src/server/linkedin/campaign-channels.ts) (audit grep)
- The generic intent compiler prepares LinkedIn outreach only. It refuses other channels (`prepare_outreach_linkedin_only`) and blocks when no LinkedIn sender is connected. — [src/server/gtm/intent.ts:421-428, 481-486](src/server/gtm/intent.ts) (verified)

**Inbound lead capture (shipped and wired, server-to-server only)**

- Intake endpoint: `POST /api/intake/v1/submissions`. Requests carry `X-Trevra-Source`, `X-Trevra-Timestamp`, `X-Trevra-Idempotency-Key` and an HMAC `X-Trevra-Signature`. Limits: 128 KB body, 5-minute clock skew, and a per-source rate limit. — [src/server/lead-capture/http.ts:14-15, 102-120](src/server/lead-capture/http.ts); [docs/lead-capture.md](docs/lead-capture.md)
- The setup screen at `/setup/capture` creates a source and shows a one-time secret. It offers generated recipes for a Cloudflare Worker, Next.js/Vercel and raw HTTP, plus a test submission. — [src/client/LeadCaptureSetup.tsx:33-45, 158, 360-391](src/client/LeadCaptureSetup.tsx); [src/client/App.tsx:586-587](src/client/App.tsx)
- The secret must never be placed in browser JavaScript, so a founder needs a trusted backend or edge function. There is no embeddable form widget. — [docs/lead-capture.md](docs/lead-capture.md) §1, §8
- Each submission creates a Person and an immutable submission. An Account is created only when a domain is supplied explicitly. Submissions are reviewed at `/outreach/inbound`. — [src/client/views/OutreachView.tsx:231](src/client/views/OutreachView.tsx); [docs/first-run.md:102-114](docs/first-run.md)

**Conversations and unified inbox (partial)**

- `ConversationChannel = 'linkedin' | 'email'`. Reddit and community threads are not part of the conversation model. — [src/server/conversations.ts:4](src/server/conversations.ts)
- `/outreach/inbox` toggles between "Conversations" (shared, Person-centric) and "LinkedIn inbox". — [src/client/views/OutreachView.tsx:232-257](src/client/views/OutreachView.tsx)
- Email replies are prepared as approval-backed playbooks (`gtm.conversation-email-reply`), then executed via `email.send`. — [src/server/app.ts:3662](src/server/app.ts); [src/server/conversation-replies.ts:123](src/server/conversation-replies.ts)
- Inbound email is captured only by polling threads of emails Trevra sent. Unsolicited inbound mail is not synced as conversations. — [src/server/linkedin/campaign-channels.ts:1055](src/server/linkedin/campaign-channels.ts) (audit finding; Nango `message` record ingestion exists separately, per [src/server/integration-service.ts:998-1062](src/server/integration-service.ts))

**Opportunities and pipeline (shipped, lite)**

- There are six fixed stages and no amount or forecast. The screen offers manual create and a per-stage list. — [src/server/opportunities.ts:3-10](src/server/opportunities.ts); [src/client/Opportunities.tsx](src/client/Opportunities.tsx)
- Opportunities are created automatically in two cases:
  - from high-intent inbound kinds (demo_request, pilot_request, pricing_request and similar);
  - from a provider-verified reply to a recommendation-attributed outbound message.

  — [src/server/demand/opportunities.ts:12-20, 49, 181](src/server/demand/opportunities.ts); [src/server/automation-service.ts:84](src/server/automation-service.ts)

- The CRM boundary: HubSpot and Attio adapters only `findContact` and `logActivity` (a note). HubSpot scopes deliberately exclude `contacts.write`. No deal or opportunity push exists. — [src/server/crm/adapters/hubspot.ts:16-17](src/server/crm/adapters/hubspot.ts); [src/server/crm/registry.ts:36](src/server/crm/registry.ts); [src/server/integration-service.ts:65-76](src/server/integration-service.ts)

**Content and social posting (shipped; draft and handoff first)**

- The content UI lives on `/research`, in sections titled "Market pulse", "Market stories" (drafts with "Proof checks" and an "Evidence map") and "Distribution outcomes". — [src/client/views/ResearchView.tsx:1372, 1612, 1732, 1750, 1855](src/client/views/ResearchView.tsx) (verified)
- Server features:
  - content opportunities derived from account signals;
  - a deterministic proof critic;
  - carousel and evidence-card drafts;
  - format cloning;
  - per-channel variants ("never publishes");
  - a strategy learned from the workspace's own outcomes;
  - a market pulse with schedules;
  - an account momentum index.

  — [src/server/content/](src/server/content/); routes at [src/server/app.ts:2885-3425](src/server/app.ts)

- Channel adapter modes:
  - `api-publish`: Bluesky, dev.to, GitHub, Mastodon;
  - `prepare-only`: Beehiiv, Hacker News, Hashnode, Indie Hackers, Instagram, LinkedIn, Lobsters, Medium, Product Hunt, Reddit, X.

  The channel registry itself holds no publish path. — [src/server/channels/adapters/\*.ts](src/server/channels/adapters/); [src/server/channels/registry.ts:35-48](src/server/channels/registry.ts)

- Buffer is draft-only (`mode: 'draft_only'`) and runs behind the `gtm.buffer-draft` approval playbook. — [src/server/content/buffer.ts:27](src/server/content/buffer.ts); [src/server/playbooks/registry.ts:496-527](src/server/playbooks/registry.ts)
- Public reports at `/signals/:slug` are indexable snapshots of a market pulse or index built from tracked accounts. Visits are recorded as marketing events. — [src/server/public-site.ts:333, 418](src/server/public-site.ts); [src/server/content/public-reports.ts:5-40](src/server/content/public-reports.ts)

**Brand/keyword watch and community listening (shipped and wired)**

- Platforms: hackernews, stackoverflow, lobsters, github, reddit, mastodon. LinkedIn and dev.to are excluded. Sentiment is a deterministic lexicon, not an LLM. Watches run daily or weekly from the worker. — [src/server/app.ts:7746-7763](src/server/app.ts); [src/server/watch/sentiment.ts:2-20](src/server/watch/sentiment.ts); [src/server/watch/service.ts:172](src/server/watch/service.ts); [src/worker/index.ts:128](src/worker/index.ts)
- Replying to a mention starts `gtm.thread-reply`: guard, draft, approve, post. Automatic posting exists only for GitHub and Mastodon; everything else becomes a manual handoff. Reddit is prepare-only. — [src/server/playbooks/registry.ts:265-342](src/server/playbooks/registry.ts); [src/server/outreach/publish.ts:190-280](src/server/outreach/publish.ts)
- The community-outreach scout config hard-codes keywords for "AI coding agent cost" threads. Per-platform caps include Reddit 5/day with a 48h cooldown and Hacker News 3/day, and the self-promotion ratio is capped at 0.1. — [src/server/outreach/config.ts:131-148](src/server/outreach/config.ts); [docs/community-outreach.md:3-8](docs/community-outreach.md)

**Today / attention (shipped and wired)**

- Item kinds by group:
  - needs you: `safety_block`, `verified_reply`, `delivery_unknown`, `approval_waiting`, `qualification_decision`, `inbound_submission`, `high_priority_account`, `capacity_block`, `agent_blocked`;
  - working: `agent_working`, `playbook_working`, `campaign_working`;
  - recent results: `delivery_sent`, `verified_reply_result`, `opportunity_closed`.

  — [src/server/today.ts:392-731](src/server/today.ts) (verified)

**GTM intent compiler (partial)**

- Status per objective:
  - `prepare_outreach`: needs an existing People list and exactly one LinkedIn sender; prepares a draft campaign and sends nothing.
  - `capture_inbound`: owner-only; creates a signed capture source.
  - `watch_accounts`: needs explicit domains; creates active Accounts that are due for a sweep.
  - `find_accounts` and `research_accounts` are plan-only. Prepare throws "This objective is inspectable but is not yet composed through the generic prepare boundary."

  — [src/server/gtm/intent.ts:415-538, 542-700, 778-873](src/server/gtm/intent.ts) (verified)

- The only client caller is the plan form on `/loop`. — [src/client/api.ts:547-560](src/client/api.ts); [src/client/views/LoopView.tsx](src/client/views/LoopView.tsx)

**Playbooks, approvals, policy (shipped and wired)**

- Six playbooks are registered, each with an approval step:
  - `gtm.audit-led-outreach`;
  - `gtm.community-outreach`;
  - `gtm.thread-reply`;
  - `gtm.qualified-demand-email`;
  - `gtm.conversation-email-reply`;
  - `gtm.buffer-draft`.

  — [src/server/playbooks/registry.ts:11-527](src/server/playbooks/registry.ts)

- Policy effects are allow, deny and require_approval. Conditions cover actor types, side effects, playbook/skill ids, environment, min confidence and max recipients. External writes default to `require_approval`. Policy writes are owner-only. — [src/server/control-plane/policy.ts:3-66](src/server/control-plane/policy.ts); [src/server/app.ts:1750-1835](src/server/app.ts)
- The approval body can be edited (`PATCH .../approval-body`). Approve and reject go through `POST .../decision`. — [src/server/app.ts:1702-1721](src/server/app.ts)

**Agents, automation, MCP/API (shipped)**

- Agent token scopes: `skills:read, skills:run, runs:read, workspace:read, playbooks:read, playbooks:run, workflows:read`. There is no approve or execute scope. — [src/server/agent-access.ts:7-15](src/server/agent-access.ts)
- MCP is mounted at `POST /api/agent/mcp` with bearer-token auth. It exposes 13 built-in tools: `trevra_list_skills`, `trevra_list_people`, `trevra_list_accounts`, `trevra_list_opportunities`, `trevra_list_conversations`, `trevra_list_deliveries`, `trevra_list_playbooks`, `trevra_start_playbook`, `trevra_list_playbook_runs`, `trevra_get_playbook_run`, `trevra_list_events`, `trevra_list_runs`, `trevra_get_run`. Skill tools are added dynamically. — [src/server/mcp-http.ts](src/server/mcp-http.ts); [src/server/agent/tools.ts](src/server/agent/tools.ts)
- The hosted agent loop is BYOK through an OpenAI-compatible provider (base URL and model). A self-host-only CLI backend runs `claude -p` or `codex exec`, and it is forbidden in hosted mode. The agent schedule runs every 15 to 10,080 minutes (default 1,440). — [src/server/agent/provider.ts:20, 75-91](src/server/agent/provider.ts); [src/server/config.ts:313-315](src/server/config.ts); [src/server/agent/schedule.ts:60-62](src/server/agent/schedule.ts)
- Temporal is optional. It is used only when `TREVRA_ORCHESTRATOR=temporal`; otherwise PostgreSQL orchestration is the default. — [src/server/orchestration/client.ts:6-8](src/server/orchestration/client.ts)

**Billing (wired, off by default)**

- Billing is enabled only when `BILLING_BASE_URL` and `BILLING_CLIENT_SECRET` (plus `AUTHWARD_ISSUER`) are set. It is a client of an external Olaryn billing service. No plan tiers or prices exist in the repo. The UI says "Plan changes coming soon". — [src/server/billing-client.ts:87-103, 207-246](src/server/billing-client.ts); [src/server/config.ts:300-303](src/server/config.ts); [src/client/BillingSettings.tsx:261](src/client/BillingSettings.tsx)

**Module registry and sandbox (server-only)**

- The routes publish, release, install and uninstall modules, and verify publishers. Public popularity routes exist. There is no client UI: grep of `src/client` for registry calls returns nothing. — [src/server/app.ts:994, 1851-1950](src/server/app.ts); [src/server/public-site.ts:297-321](src/server/public-site.ts)
- `public/catalog/modules.json` lists 21 first-party modules: 20 `gtm.*` skills plus `net.validate-host`. Examples are `gtm.scout-threads`, `gtm.visibility-audit`, `gtm.enrich-company` and `gtm.linkedin-guard`. Community code runs only in a separate sandbox gateway (`TREVRA_SANDBOX_GATEWAY_URL`). — [public/catalog/modules.json](public/catalog/modules.json); [docs/sandbox-execution.md](docs/sandbox-execution.md)
- Skills can be run through `POST /api/skills/:id/run`, MCP or playbooks. No UI button runs a skill. — [src/server/app.ts:1572](src/server/app.ts) (grep of `src/client` for skill-run calls returns nothing)

**Integrations via Nango (shipped)**

- The catalog has eight entries:
  - Gmail;
  - Google Calendar ("Not ready yet — Trevra has nowhere to put meetings, so connecting this brings nothing in.");
  - Microsoft 365;
  - HubSpot and Attio ("Read your contacts, companies, and deals. Trevra adds a note when you approve work — it never creates or edits records.");
  - Exa;
  - Reddit;
  - Buffer.

  — [src/server/integration-service.ts:86-181](src/server/integration-service.ts) (verified)

- The Nango sync scripts for HubSpot and Attio are not in this repo. Trevra normalizes whatever records Nango delivers. — [src/server/integration-service.ts:998, 1062](src/server/integration-service.ts) (audit: no nango-integrations folder found)

**Analytics and attribution (partial)**

- Trevra's own marketing analytics write `marketing_events` with UTM fields, a visitor hash and the referrer domain. — [src/server/public-site.ts:453](src/server/public-site.ts); [src/client/analytics.ts:54-64, 131-147](src/client/analytics.ts); [migrations/002_marketing_events.sql](migrations/002_marketing_events.sql)
- `/loop/cost` joins model spend, LinkedIn action volume and outcomes, and explicitly states that nothing is attributed (`LOOP_COST_NO_ATTRIBUTION`). — [src/server/loop-cost.ts:22-27](src/server/loop-cost.ts)
- Narrow lineage attribution exists for evidence-backed LinkedIn posts only. The chain is post, then engagers, then qualified-demand recommendation, then verified reply, then opportunity, then won. "No Person/Account coincidence is treated as attribution". It shows as "Distribution outcomes" on `/research`. — [src/server/content/performance.ts:207-300](src/server/content/performance.ts) (verified). Commits also add acquisition and conversion attribution for public reports (`git log`: "attribute public report acquisition", "attribute customer report conversions").

**Team, workspace, auth (shipped)**

- There are only two roles, owner and member. Invitations go through Better Auth with an accept link at `/setup/team/:id`. Owners can export the workspace and erase it with a confirmation string. Ledger exports are available as zip files. — [src/server/app.ts:1536-1562, 2506-2722](src/server/app.ts); [src/client/TeamScreen.tsx](src/client/TeamScreen.tsx)
- Self-host uses Better Auth email and password. Hosted mode requires Authward OIDC (issuer, client id, and a client secret of 32 characters or more). — [src/server/auth-service.ts:20, 53-93, 371](src/server/auth-service.ts); [src/server/config.ts:132, 272-294](src/server/config.ts)

**SEO / AI-search visibility (partial)**

- `gtm.visibility-audit` probes a _prospect_ domain for `llms_txt`, meta quality, products feed, `robots_ai_bots`, sitemap and structured data. It targets AI shopping assistants and answer engines (Beseam-style ecommerce), and it is used to ground `gtm.audit-led-outreach`. — [src/server/skills/audit.ts:163, 426](src/server/skills/audit.ts); [src/server/playbooks/registry.ts:50](src/server/playbooks/registry.ts)
- Trevra's own public site serves robots, sitemap, `llms.txt`, `llms-full.txt`, `agents.md`, `humans.txt`, `security.txt`, IndexNow and JSON-LD. — [src/server/public-site.ts:268-393](src/server/public-site.ts); [README.md:7-9](README.md)

### Inferences

- Trevra's centre of gravity is LinkedIn outbound plus evidence-backed account signals. Email is a secondary channel inside LinkedIn-rooted campaigns. A founder who does not want LinkedIn automation, or cannot keep a laptop and browser tab online, gets much less value.
- For LemonCrow (a developer tool, AI-coding-agent cost), the most aligned shipped pieces are:
  - developer-community listening on HN, Stack Overflow, Lobsters, GitHub, Reddit and Mastodon;
  - the community-outreach scout config, which is literally LemonCrow's keywords;
  - approved replies;
  - content drafts.
- For Beseam (ecommerce), the most aligned shipped pieces are:
  - storefront, commerce-app and Meta-ads signals;
  - the visibility audit;
  - signed lead capture from the existing Cloudflare Worker, though the live cutover is still pending.
- Many surfaces are built for an operator who wants a lot of control (about 100 LinkedIn manager routes). The simple path (intent compiler) covers only part of it.

### Gaps

- Not traced:
  - the exact LinkedIn post delivery code beyond the `jobs.ts` claim;
  - whether a campaign can be email-only without a LinkedIn seat (the campaign tables are `linkedin_*` and the compiler refuses non-LinkedIn channels, but the manager builder was not tested);
  - the content of `outreach/scouts/linkedin.ts` (documented as a disabled scout).
- No runtime test. All findings are static reading. Live behaviour, for example whether the hosted cloud browser works, is reported only as the repo's own docs describe it.

## Q3. UI routes and wiring: which functions have a screen, and which are server-only?

### Takeaway

The app has 5 sections and 18 addressable screens: loop 2, outreach 8, ledger 2, research 1, setup 5. Outreach and Research are dense, multi-purpose pages. Several shipped server capabilities have no UI at all and are reachable only through the API or MCP: the module registry, direct skill runs, LinkedIn engagement and the hosted-execution acknowledgement.

### Cited Findings

- Sections and sub-routes:
  - `loop`: `''`, `cost`;
  - `outreach`: `''`, `new`, `campaign`, `workflow`, `inbound`, `inbox`, `opportunities`, `posts`;
  - `ledger`: `''`, `run`;
  - `research`: `''`;
  - `setup`: `''`, `workspace`, `capture`, `billing`, `team`.

  — [src/client/ui/route.ts:35-47](src/client/ui/route.ts)

- Outreach tabs: Campaigns, Messages and Opportunities are main tabs; Inbound and Posts sit under "More". The Campaigns root (`/outreach`) stacks the campaign reader plus collapsed "Find people" and "Target accounts" folds. — [src/client/views/OutreachView.tsx:133-149, 277-313](src/client/views/OutreachView.tsx)
- Setup tabs:
  - Access (`/setup`): agent access plus hosted agent panel.
  - Workspace: Connections, Limits/policies, LinkedIn exclusions, Team, and owner-only data export/erasure.
  - Lead capture.
  - Billing.

  — [src/client/App.tsx:531-622](src/client/App.tsx)

- `/research` stacks these sections:
  - Market pulse;
  - Market stories;
  - Distribution outcomes;
  - Discovered threads;
  - Mentions;
  - Company research;
  - a collapsed "Reddit research corpus".

  — [src/client/views/ResearchView.tsx:1346-2330](src/client/views/ResearchView.tsx)

- LinkedIn analytics (`LinkedInFunnel`) is rendered on `/loop`, not under Outreach. — [src/client/views/LoopView.tsx:24](src/client/views/LoopView.tsx)
- Largest client screens by line count:
  - `LinkedInManagerRead.tsx` 4,055;
  - `LinkedInManagerWorkflowConfig.tsx` 3,462;
  - `App.tsx` 3,157;
  - `ResearchView.tsx` 2,375;
  - `LinkedInAccounts.tsx` 2,092;
  - `LinkedInInbox.tsx` 1,822;
  - `LoopView.tsx` 1,632;
  - `AccountsScreen.tsx` 1,529.

  — `wc -l src/client/*.tsx src/client/views/*.tsx`

- No client caller exists for: registry routes, `POST /api/skills/:id/run`, `/api/linkedin/engagement`, `/api/linkedin/hosted-execution`. — grep of `src/client` (verified)
- To add a route, a developer must change three places that must agree: `SECTIONS`/`SUB_ROUTES` and `SHELL_PATHS` in `route.ts`, and `APP_PATH_HEADS` in `src/server/index.ts`. — [AGENTS.md](AGENTS.md) "Client routing"

### Inferences

- The navigation is nominally five sections, but Research alone carries content marketing, brand monitoring, community engagement and account research. That raises cognitive load for a founder who comes to do one of those jobs.

### Gaps

- I did not render the app, so the visual density claims rest on code structure and the August simplicity audit, not on screenshots.

## Q4. Which GTM functions are missing entirely?

### Takeaway

Some omissions are deliberate under the product boundary: proposals, quotes, contracts, invoicing, revenue dashboards, product-event ingestion and CRM-object ownership.

Others are not excluded by any doc but are simply absent:

- meeting booking and calendar;
- call notes;
- email deliverability tooling;
- contact-data enrichment;
- outbound CRM deal sync;
- Salesforce and Pipedrive;
- PLG/product-usage signals;
- GitHub repo-traction signals;
- SEO/AI-answer rank tracking;
- paid-ads management;
- events and webinars;
- referrals and case-study capture;
- multi-touch or campaign attribution;
- an embeddable website form;
- X/Twitter publishing.

### Cited Findings

- **Meeting booking and calendar: missing.** The Google Calendar card says "Not ready yet — Trevra has nowhere to put meetings", and calendar sync records are "counted and dropped". The `meeting` stage exists only as an Opportunity stage set by hand or by CRM sync. — [src/server/integration-service.ts:97-110, 1028-1029, 1216-1221](src/server/integration-service.ts)
- **Call notes and recording (Gong, Fireflies, Otter): missing.** Grep finds no integration; hits are only LinkedIn message "transcript" naming. — repo grep of `src/server`, `src/client`, `src/worker`
- **Proposals, quotes, contracts, invoices for the founder's own customers: deliberately excluded.** — [PRODUCT.md:19, 87, 142](PRODUCT.md); [docs/integration-contracts.md:108-122](docs/integration-contracts.md); [migrations/095_remove_post_sale_revenue_domain.sql](migrations/095_remove_post_sale_revenue_domain.sql)
- **CRM sync: partial.**
  - HubSpot and Attio are read-only through Nango, plus approved note write-back.
  - There are no Salesforce or Pipedrive adapters (grep returns 0 files).
  - No deal or contact creation in the CRM.
  - The Nango sync definitions live outside the repo.

  — [src/server/crm/registry.ts:36](src/server/crm/registry.ts); [src/server/integration-service.ts:65-76, 121-142](src/server/integration-service.ts)

- **PLG and product-usage signals: missing, and excluded as "arbitrary product-event ingestion".** The canonical spec lists "arbitrary product-event ingestion" under "What not to build". — [agent-native spec:936-950](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- **GitHub and community signals: partial.**
  - GitHub is a scout, watch and reply channel for issues and discussions.
  - There are no repo-traction signals (stars, forks, contributors, dependents). Grep for `stargazer` returns 0.
  - `thread-mention` is the only community-derived account signal.

  — [src/server/outreach/scouts/github.ts](src/server/outreach/scouts/github.ts); [src/server/accounts/score.ts:153-192](src/server/accounts/score.ts)

- **SEO and AI-search visibility: partial.** There is a one-shot prospect audit skill with no UI. Nothing tracks the founder's own rankings or AI-answer citations, and there is no SERP or keyword data source. — [src/server/skills/audit.ts](src/server/skills/audit.ts); [docs/superpowers/specs/2026-08-20-seo-geo-hardening-design.md](docs/superpowers/specs/2026-08-20-seo-geo-hardening-design.md) (which concerns only Trevra's own site)
- **Paid ads: missing.** Meta Ad Library is used only to observe prospects' ads as a buying signal. There is no ad creation, budgeting or ad-platform reporting. — [src/server/observations/providers/meta-ads.ts](src/server/observations/providers/meta-ads.ts); [src/server/observations/measurements.ts:169-179](src/server/observations/measurements.ts)
- **Events and webinars: missing as a GTM function.** Only LinkedIn worker action kinds `event_invite` and `event_message`, plus an `event_attendees` lead source, exist. — [src/server/linkedin/limits.ts:182-185](src/server/linkedin/limits.ts); [src/server/linkedin/leads.ts:161-169](src/server/linkedin/leads.ts)
- **Referrals, testimonials, case studies: missing.** Product rules forbid fabricating them. "Customer proof" exists only as a _prospect_ website signal. — [PRODUCT.md:145-147](PRODUCT.md); [src/server/accounts/types.ts:24-53](src/server/accounts/types.ts)
- **Attribution reporting: narrow.** Only content-post lineage and public-report attribution exist. Loop cost states "no attribution", and there is no campaign-to-opportunity or channel-mix report. — [src/server/content/performance.ts:207-215](src/server/content/performance.ts); [src/server/loop-cost.ts:22-27](src/server/loop-cost.ts)
- **Email deliverability (warm-up, inbox rotation, SPF/DKIM/DMARC checks, sending-domain setup): missing.** — [src/server/linkedin/campaign-channels.ts:218-236](src/server/linkedin/campaign-channels.ts) (audit grep)
- **Contact enrichment vendor: missing.** Apollo is excluded by its ToS, and nothing replaces it. — [src/server/integration-service.ts:78-84](src/server/integration-service.ts); [src/server/linkedin/campaign-channels.ts:414-435](src/server/linkedin/campaign-channels.ts)
- **Embeddable website form or JS snippet: missing.** Capture needs a signed backend call. — [docs/lead-capture.md](docs/lead-capture.md)
- **X/Twitter, LinkedIn-company-page, Product Hunt, Hacker News publishing: prepare-only or handoff.** — [src/server/channels/adapters/](src/server/channels/adapters/)
- **"Who viewed my profile" (LinkedIn inbound intent): not built.** — [BRIEF_GAP_CHECK.md:50](BRIEF_GAP_CHECK.md)
- **Agent team view (Scout, Researcher, Outreach, Inbox agents with status): designed, not built.** — [agent-native spec:763-806, 847](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- **Retention and expansion (post-sale customer success): excluded.** — [PRODUCT.md:142](PRODUCT.md)

### Inferences

- Meeting booking is the most conspicuous gap that the product's own model implies. `meeting` is an Opportunity stage and the Calendar connector exists, but there is nowhere to store a meeting.
- For LemonCrow, the missing GitHub repo-traction and PLG/product-usage signals are probably the largest unmet needs. Developer-tool GTM typically keys off installs, usage and repo activity. Tracking the founder's own AI-search and SEO visibility is another candidate for both companies.
- For Beseam, the missing embeddable form and the pending live cutover matter more than new features. The existing Worker integration is designed but not yet live.

### Gaps

- I did not check whether Nango-side sync scripts for Gmail or Microsoft also ingest unsolicited inbound mail into canonical `message` records in a deployed environment. That code is outside this repo.

## Q5. Where is Trevra complex for a new founder? What is the first-run path?

### Takeaway

The documented first run is four activation steps, then one bounded "job":

1. Connect an agent.
2. Connect a source.
3. Set the approval boundary.
4. Plan the first job.

Only the job step works in place; the others link to Setup. Real first value still depends on heavy prerequisites:

- a LinkedIn seat paired through a terminal-installed Companion, plus an open browser tab;
- Nango-connected Gmail or M365 for email;
- a founder-owned backend that signs requests, for inbound capture;
- for self-hosting, Docker with 6 GB or more for Trevra, Postgres and Nango.

The repo's own simplicity audit found that "screens default to showing everything at once".

### Cited Findings

- First-run steps:
  1. Sign in and land on Loop. No LinkedIn account, model key, campaign, lead list, CRM or capture source is required up front.
  2. Activation is derived from durable state: connect an agent (Claude Code, Codex, the hosted agent, or MCP), connect a source (a GTM data source or a LinkedIn sending identity), set the approval boundary (at least one enabled policy), plan the first job.
  3. Choose one of five bounded jobs (Find prospects, Research accounts, Prepare outreach, Watch accounts, Capture inbound), inspect the deterministic plan, resolve blockers, then prepare. Nothing is sent without approval.

  — [docs/first-run.md:14-70](docs/first-run.md)

- The client activation checklist matches the doc's four steps: `agent` ("Connect an agent", links to `/setup`), `source` ("Connect a source", `/setup/workspace`), `policy` ("Set the approval boundary", `/setup/workspace`), and `work` ("Plan the first job", in place on `/loop`). — [src/client/views/activation.ts:19-47](src/client/views/activation.ts) (verified)
- The executable prepare path is "intentionally narrow": a known People list, then resolve the LinkedIn sender, then apply the blessed default workflow, then create a draft managed campaign, then stop. Find and Research "remain inspectable/direct-surface plans". — [docs/first-run.md:72-100](docs/first-run.md); [src/server/gtm/intent.ts:842-847](src/server/gtm/intent.ts)
- The ruthless-simplicity spec recorded that the earlier first run was an implementation-object checklist: "Add a LinkedIn account / Build one lead list / Build one workflow / Create your first campaign". It proposed founder jobs plus an optional natural-language box that must work without an LLM. — [docs/superpowers/specs/2026-08-21-ruthless-simplicity-intent-compiler-design.md:139-224](docs/superpowers/specs/2026-08-21-ruthless-simplicity-intent-compiler-design.md)
- LinkedIn setup requires several steps:
  1. Pair a computer with a generated terminal command.
  2. Sign in to LinkedIn in the opened Chrome profile.
  3. Run "Check this account".
  4. Optionally set a timezone and work window per seat.

  The service starts at login, but "A signed-in Trevra tab must still remain open when work should run". — [README.md:79-93](README.md); [docs/linkedin-companion.md](docs/linkedin-companion.md)

- The local self-host start needs Docker Compose v2 with "at least 6 GB of free Docker memory for the complete Trevra + Nango stack", plus `npm run dev:setup`. The production self-host compose runs postgres, migrate, app and worker. Nango is optional, but email, CRM and Buffer connections need it. — [README.md:95-120](README.md); [compose.selfhost.yml](compose.selfhost.yml)
- Form-control density, by count of input/select/textarea elements per screen (audit grep): campaign config about 26, workflow config about 42, lead config about 15, LinkedIn account form about 19. My own count: `App.tsx` 22, `AccountsScreen` 15, `ResearchView` 10, `TeamScreen` 9, `LoopView` 8.
- The simple campaign builder at `/outreach/new` is 4 inputs plus a CSV dropzone. It auto-creates the lead list, workflow and draft campaign via `POST /api/outreach/prepare`. — [src/client/LinkedInManagerBuilder.tsx](src/client/LinkedInManagerBuilder.tsx); [src/server/outreach/prepare.ts:14-23, 86-131](src/server/outreach/prepare.ts)
- The simplicity audit (2026-08-19) found that progressive disclosure is "the exception, not the rule" in 7 of 8 page clusters. It also found:
  - built capabilities with no reachable UI;
  - missing smart defaults;
  - a safety-critical exclusion-matching bug;
  - duplicated or conflicting metrics on Loop;
  - disabled controls that don't explain themselves.

  — [docs/superpowers/specs/2026-08-19-app-wide-simplicity-audit.md:5-24](docs/superpowers/specs/2026-08-19-app-wide-simplicity-audit.md). It references routes (`/setup/agent`, `/setup/limits`, `/outreach/manager`) that are no longer in `route.ts`, so the shell has been consolidated since. Which individual findings are fixed is not verified.

- The setup-simplification spec is still "approved design, not yet implemented". — [docs/superpowers/specs/2026-08-19-setup-simplification-design.md](docs/superpowers/specs/2026-08-19-setup-simplification-design.md)
- Inbound capture needs developer work. The founder must copy a one-time secret and implement HMAC signing on a backend or edge function. Recipes are provided. — [src/client/LeadCaptureSetup.tsx:33-45, 360-391](src/client/LeadCaptureSetup.tsx)
- Several data providers are switched on by deployment env vars, not by founder UI: Exa, YouTube, Meta, the email-enrichment URL, Mastodon and the Reddit OAuth variables. On hosted Trevra the founder depends on the operator having configured them. — [src/server/integration-service.ts:143-158](src/server/integration-service.ts); [src/server/observations/health.ts:177-189](src/server/observations/health.ts); [src/server/linkedin/campaign-channels.ts:414-435](src/server/linkedin/campaign-channels.ts)
- The UI copy enforces "not connected, never zero": a missing integration is shown as `not connected`, never as a zero result. — [docs/gtm-shell-shape.md:54](docs/gtm-shell-shape.md)

### Inferences

- Time to first _external_ value (a message actually sent) for a LinkedIn-first founder needs at least these steps:
  1. Account sign-in.
  2. Companion install and pairing.
  3. LinkedIn login in Chrome.
  4. People CSV upload.
  5. A draft campaign.
  6. A start click.
  7. Approvals where policies require them.

  This is roughly 6 to 8 steps across 3 surfaces (`/loop`, `/setup/workspace`, `/outreach/new`) plus a terminal. Email-first and inbound-first paths each need a third-party connection (Nango) or developer work.

- The "agent" activation step comes first even though a founder can get value without an agent. It may front-load an unfamiliar concept (MCP tokens) before any GTM result.
- The internal complexity (policies, playbooks, ledger, seats, waves, bands) is real and mostly hidden behind folds, but the dense screens (4k-line campaign reader, 3.5k-line workflow editor) show the advanced surface is large.

### Gaps

- There is no usability data (time-to-value or activation metrics) in the repo, and I did not run the app.

## Q6. What architectural strengths should any expansion preserve?

### Takeaway

The architecture has unusually rigorous invariants for a GTM tool, and the docs treat them as non-negotiable:

- every external write goes through a prepared action, a payload hash, policy and approval, then a dedicated adapter;
- delivery has explicit sending, sent, failed and uncertain states and never blindly retries;
- identity resolution is deterministic;
- all evidence carries provenance and observation time;
- "not connected" is distinct from zero;
- everything is workspace-scoped and lives in PostgreSQL only;
- the execution registry is closed;
- provider credentials stay in Nango or secret custody.

Any new GTM capability (meetings, CRM push, ads, PLG signals) would need to fit these.

### Cited Findings

- 16 architectural invariants: workspace scoping; distinct human, agent and system principals; every mutation has an actor; a Person does not require an Account; no fuzzy association; immutable submissions; signals must have GTM meaning; credentials belong to connections, never agents; external writes go through a dedicated prepared-action boundary; approval binds the exact payload; suppression cannot be bypassed by models; ambiguous outcomes are not retried; no silent second CRM writer; an append-only ledger. — [agent-native spec:954-971](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- The payload hash is sha256 over a recursively key-sorted stable JSON. GTM plans are hashed as well, and a prepare rejects a stale plan whose hash changed. — [src/server/control-plane/payload.ts](src/server/control-plane/payload.ts); [src/server/gtm/intent.ts:411-413, 789-802](src/server/gtm/intent.ts)
- The execution registry is closed: "arbitrary action names are rejected", and new writes need a named action, a schema, policy, an adapter and tests. — [src/server/control-plane/execution.ts:10-20](src/server/control-plane/execution.ts); [docs/integration-contracts.md:54-63](docs/integration-contracts.md)
- External-write skills never run through the generic skill or playbook runner. — [AGENTS.md](AGENTS.md) "Architecture"
- Delivery claims are idempotent per payload. Ambiguous provider outcomes are terminal for automatic resend, and blind POST retries are disabled. — [src/server/email-deliveries.ts:68](src/server/email-deliveries.ts); [agent-native spec:909](docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md)
- The data-safety rules: scope every query by workspace; use transactions plus row locks for competing executions; keep provider credentials only in Nango or Secret Manager; use deterministic idempotency keys for external writes; never put client content or IPs in analytics. — [AGENTS.md](AGENTS.md) "Data safety"
- Storage is PostgreSQL-only. Migrations take an advisory lock, and tests run against real PostgreSQL. — [README.md:11-19](README.md). There are 186 test files in `src`.
- Append-only domain events cover `action.*`, `approval.*`, `playbook.*`, `capture_source.*`, `inbound_submission.created`, `opportunity.created_from_*` and `linkedin_campaign.*`. — [src/server/control-plane/events.ts](src/server/control-plane/events.ts) (audit list of callers)
- Provider ToS compliance is enforced in code: Exa results are not persisted, Apollo is excluded, and the crawler follows robots.txt with an SSRF guard. — [src/server/research/providers/exa.ts:79-85](src/server/research/providers/exa.ts); [src/server/integration-service.ts:78-84](src/server/integration-service.ts); [src/server/crawl/public-web.ts:1-16](src/server/crawl/public-web.ts)
- LinkedIn safety is code-owned. Researched bands bind by default, with an explicit per-seat override; there are 15 guard checks and a global suppression authority across email and LinkedIn. — [src/server/linkedin/limits.ts](src/server/linkedin/limits.ts); [src/server/linkedin/guard.ts:75-91](src/server/linkedin/guard.ts); [migrations/101_global_gtm_suppressions.sql](migrations/101_global_gtm_suppressions.sql)
- The Today projection is deterministic: "A model does not decide which safety exception outranks another." — [PRODUCT.md:140](PRODUCT.md); [src/server/today.ts:45-60](src/server/today.ts)
- The agent boundary: agent tokens have no approve or execute scope, and MCP mirrors the read/run tool list. — [src/server/agent-access.ts:7-15](src/server/agent-access.ts); [README.md:57](README.md)

### Inferences

- These invariants are Trevra's differentiator against "AI SDR" tools. They also explain why some features look missing: adding meeting booking or CRM deal push requires a named prepared action plus approval UX, not just an API call. Expansion work should budget for that boundary on every new external write.
- The "draft and handoff" posture (Buffer draft-only, most channels prepare-only) is a consequence of these invariants. It keeps the product safe but limits automation for founders who want hands-off publishing.

### Gaps

- I did not test the invariants for correctness (for example race conditions under load). `HOSTED_READINESS.md`, a tenant-isolation and scale audit dated 2026-08-14, was not read in detail.
