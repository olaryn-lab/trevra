# Trevra launch MVP — L1/L2/L5/L7 readiness and full-suite diagnosis

Date: 2026-10-21
Source launch gate: docs/release/2026-10-21-trevra-launch-mvp-scope.md
Prior qualification: docs/release/2026-10-21-trevra-launch-mvp-qualification.md
Base: c0251dd757016db3aa5f852c38f8741a06de1b49
Branch: feat/launch-mvp-staging-readiness-20261021
Worktree: /home/pankaj/Projects/Trevra-worktrees/launch-mvp-staging-readiness-20261021

## Decision: NO-GO for the first real customer (not an engineering test failure)

The isolated application/test baseline is now GREEN. Missing **authorized staging
and real connected-provider acceptance** prevents declaring the first-customer
path ready, and there is no documented, separately identified staging runtime
for this audit. This pass made no deployments, production migration, live
outreach, provider writes, server starts/restarts, or modifications outside
this worktree.

## 1. Outbound-webhook test regression: exact cause and correction

Before change: npm test -- src/server/outbound-webhooks.test.ts
FAILED: 5 failed / 4 passed in 1 test file. Four dispatcher tests expected
one delivery to be claimed but returned zero. The concurrent-claim test hung
awaiting a provider-double call and timed out at 60 seconds.

Cause: tests fixed NOW to 2026-10-21 13:00:00 UTC and dispatched at NOW,
but migrations/147_outbound_webhook_outbox.sql defines
next_attempt_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP. Inserting the test
event at the database's actual current time creates an event NOT due at the
older simulated dispatch timestamp. The zero-claim and timeout behavior is
correct; the fixture was chronologically inconsistent. Vitest runs against
dedicated isolated PostgreSQL instances via scripts/test-with-postgres.ts;
no stale production/staging rows were involved. No cross-test ordering is
necessary to reproduce the failure.

Baseline comparison: the webhook test, implementation and migration have
no changes between 5decf60 and c0251dd (git diff of these files was empty).
The fixed-clock defect therefore existed in the requested old baseline too.
A separate full baseline test execution was not necessary to establish this
source-level conclusion.

Change: after appendDomainEvent in the isolated test helper, explicitly
set next_attempt_at to NOW for THAT event's freshly enqueued outbox rows,
scoped by workspace and event ID. Keep the production DEFAULT, dispatch
claim SQL, retries, signatures, and policy unchanged; future retry scheduling
remains tested at the simulated clock.

After change: isolated webhook test **9/9 PASSED**.
Entire npm run check **exit 0**: **272/272 files, 4003/4003 tests**,
catalog build, frontend TypeScript, Vite and server TypeScript PASS. Build
warns on an oversized client bundle. npm SBOM inventory still reports
ESBOMPROBLEMS from incompatible @types/node requirements and was explicitly
NOT published; the standard development build tolerates that, but release
certification remains fail-closed. Do not claim SBOM or full parity.

## 2. Read-only runtime and deployment observations

Observed HTTP GET checks:

- https://app.usetrevra.com/api/health: **200**, ok=true,
  service=trevra-api, database=postgresql, integrations=true.
  This checks an API/database query and integration-key presence, NOT
  webhook delivery, live OAuth, provider connectivity or worker health.
- https://app.usetrevra.com/api/public-config: **200**,
  authwardAuthEnabled=true, socialAuthProviders=[google,microsoft],
  magicLinkAuthEnabled=true, password login disabled.
- https://auth.olaryn.com/.well-known/openid-configuration: **200**.
  Issuer discovery responds; registered callback correctness and successful
  token exchange have NOT been established.
- No separately named, authorized Trevra staging origin was located in
  repository deployment documentation. The public app is not an
  interchangeable staging instance. Local candidate 127.0.0.1:43173/api/health
  returned HTTP 502; another expected local web port was unreachable.
  No existing servers were started or restarted.

Static deployment evidence (configuration, not live verification):

- docs/deployment.md defines hosted one-shot migration job followed by
  schema verification on API/worker boot. Latest repository migration:
  migrations/147_outbound_webhook_outbox.sql. Live schema_migrations version
  was NOT inspected; no staging DB access was available.
- infra/oracle/README.md documents a single E2 VM with API, worker,
  PostgreSQL, Cloudflare Tunnel, custom-format pre-migration backups under
  /mnt/data/backups, 14-day local retention and pinned-tag rollback.
  Those scripts exist but actual backup timestamps, off-machine copy,
  restore drill, free capacity, latest image digest and worker liveness
  were NOT verified. One-box operation has no HA.
- Hosted server configuration enforces coordinated Authward issuer/client
  credentials; secure cookies, custody encryption, signed Nango integration,
  an HTTPS public origin, SMTP operational alerts and an advertised
  Companion release version where Companion is configured.
  Config validation proves only that code is present, not that a real
  deployment meets the values or that alerts are delivered.
- Companion documented flow pairs a single operator-owned device using a
  one-time code, verifies the LinkedIn session, then uses its browser relay.
  Reconnect/checkpoint and alert facilities are documented, but neither
  an approved device nor a live worker cycle was observed.
- Gmail/Microsoft mailbox connection uses Nango. A public integrations
  boolean does not prove OAuth grants, verified sender/domain, webhook
  signatures, inbound sync, authorization freshness, or deliverability.

## 3. Playwright browser acceptance (strictly read-only)

Playwright Chromium headless loaded https://app.usetrevra.com/ HTTP 200
in a fresh context. Document title was
"Trevra — Sign in or open your workspace". The login surface showed
Google, Microsoft, and email routes and linked Terms and Privacy Notice.
Selecting "Continue with email" displayed an email input and
"Email me a sign-in link" control. No email was entered, no magic link
sent, no social OAuth flow completed and no workspace was created.
An earlier transient Chromium ERR_NETWORK_CHANGED was resolved on retry.
Browser environment used the PUBLIC production login, not staging.

Step-by-step acceptance:

| Customer step                     | Browser result                                    | Evidence still required                                                        |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. Fresh sign-in/onboarding       | PARTIAL: public login and email selection visible | Authorized test user, actual Authward callback, initial tenant, session expiry |
| 2. LinkedIn account               | BLOCKED: login required                           | Paired permitted companion and read-only session check                         |
| 3. Email mailbox                  | BLOCKED: login required                           | Consented OAuth test mailbox, DNS/status/sync                                  |
| 4. CSV normalization/dedup        | BLOCKED in browser                                | Authenticated staging UI; PostgreSQL API integration previously passed         |
| 5. Campaign/preview               | BLOCKED in browser                                | Test tenant, selected sender, staged leads                                     |
| 6. Approval                       | BLOCKED in browser                                | Owner session and exact-message review UI                                      |
| 7. Start/pause/stop               | BLOCKED in browser                                | Authenticated safe campaign UI; no live sends                                  |
| 8. Results/failure/reply/recovery | BLOCKED in browser                                | Staging inbox fixtures, worker outcomes and owner support drill                |

The existing c0251dd integration suite separately covers L3-L6 API/planner/
worker/email boundaries with provider doubles, but those are not substituted
for Playwright acceptance or actual operator-owned external accounts.

## 4. Remaining L1–L8 launch gate

| Gate                          | Status  | Evidence / missing requirement                                                                                          |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| L1 Hosted identity/onboarding | PARTIAL | Public login and Authward discovery reachability; no completed fresh-user callback/tenant session                       |
| L2 Runtime/schema/worker      | PARTIAL | Public API+Postgres health, local 4003-test build; no identified staging, schema version, worker cycle or restore       |
| L3 LinkedIn companion         | PARTIAL | Controlled worker tests green; live permitted pairing, provider terms, checkpoints and action not verified              |
| L4 Email                      | PARTIAL | Controlled Nango/send/stop tests green, public integration flag; real OAuth/DNS/inbound not verified                    |
| L5 Core user browser journey  | BLOCKED | Only anonymous login UI was observed; protected journey unavailable without staging test identity                       |
| L6 Suppression/consent        | PARTIAL | Negative PostgreSQL safety tests green; live boundary proof and source/legal approval absent                            |
| L7 Operator recovery          | PARTIAL | SMTP/config checks and documented reconnect/manual resolution; no actual alert or failover/recovery drill               |
| L8 Public claims/commercial   | BLOCKED | Founder/legal acceptance of terms/privacy, accurate feature claims and approved manual payment/onboarding plan required |

### Blockers by ownership

Engineering/infrastructure evidence: identify isolated staging origin, image
digest/revision, schema_migrations head, worker heartbeat, queue backlog,
alert delivery, actual backup and isolated restore, callback validation and
browser action states. Full check is GREEN, but a fresh reproducible SBOM
dependency graph is NOT certified.

Configuration: staging-safe Authward issuer/client/callback, authorized
first-user test tenant, secure cookie/origin settings, signed Nango and
reachable Connect UI, provider webhook route, Companion release and relay,
operational SMTP, verified email DNS, bounded mailbox limits, observation
dashboard and off-instance backup custody. Current actual values/availability
were not exposed for this pass.

External authorization: provider/platform-terms review for permitted LinkedIn
operation; owned Companion browser and verified Gmail or Microsoft test
mailbox; a consenting owned destination account; lawful-basis/source/retention
sign-off; owner authorization before even one real send; support and
founder-commercial approval. This pass did not request or use credentials.

## Exact prerequisites for controlled real-provider acceptance

1. Name and grant read-only access to a dedicated staging runtime and
   its redacted release/schema/worker monitoring; prohibit any production
   fixture mutations.
2. Provision a fresh Authward test identity and dedicated staging tenant
   with explicit callback allowlist, owner role and recovery channel.
3. Pair an owner-controlled LinkedIn Companion session using a supported
   released version; validate permission/terms and stop/reconnect, then
   request separate explicit authorization for one test action.
4. Connect an owner-controlled Gmail or Microsoft mailbox through authorized
   Nango OAuth, verify SPF/DKIM/DMARC, footer/unsubscribe, inbound sync,
   immutable sender binding and configured quotas.
5. Stage only consenting test leads; prove complete Playwright CSV/import,
   approval, pause/stop and outcome UX. Provider doubles are acceptable
   for the unsafe/error-path variants.
6. Only after legal and owner approval, perform a single real
   provider-controlled send to an owned address, capture redacted provider
   IDs, sent/reply/suppression rows, and reconcile unknown outcomes without
   retry. Drill one alert and backup restore before launch sign-off.

**Recommendation: NO-GO for first paying customer today.** The fixed suite
removes the known engineering-test blocker, but the essential authenticated
browser workflow, staging worker, real account connectivity, recovery and
external authorizations have not been demonstrated. Next task should be an
owner-assisted, read-only staging inventory and fresh-user Playwright
acceptance, followed by separately authorized controlled-provider tests.

No push, PR, merge, deployment, live database migration, server restart,
webhook expansion or real provider send was performed.
