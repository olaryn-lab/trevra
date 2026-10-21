# Trevra MVP — browser/operator follow-up (2026-10-21)

## Provenance and restrictions

Starting commit: a575a1b8c793cbcff869b7b822dd5721a929c01b.
Branch: feat/launch-mvp-browser-operator-20261021.
Worktree: /home/pankaj/Projects/Trevra-worktrees/launch-mvp-browser-operator-20261021.
Scope: L1, L2, L5 and essential L7 only; L3/L4/L6 are evidence carried
forward from the prior controlled-PostgreSQL qualification.

All public and local runtime interactions were read-only HTTP GET/HEAD
and anonymous browser navigation. Browser interception **blocked**
non-GET/HEAD requests. No authentication callback exchange, magic-link
email delivery, live LinkedIn pairing, mailbox connection, campaign
mutation, provider send, deployment, existing-service start/restart,
production/staging migration or push was performed.

## New repeatable smoke

Run:

- node scripts/launch-mvp-readonly-smoke.mjs --origin https://app.usetrevra.com --issuer https://auth.olaryn.com
- node scripts/launch-mvp-readonly-smoke.mjs --origin http://127.0.0.1:43173 --issuer http://127.0.0.1:43100

The program requires an explicit origin and never assumes production
is staging. It probes API/DB health, public Authward config,
optional issuer discovery and optional worker /health; opens a fresh
Playwright Chromium context, verifies anonymous login options, shows the
email-address field without submitting it, and verifies friendly
callback-error UI while detecting raw provider-description leaks.
Only permitted HTTP methods leave the browser; no credentials or
private customer information are requested.

### Live read-only observations

| Surface                 | HTTP / result                                                                     | Scope limits                                                       |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Public Trevra API       | /api/health 200, ok, PostgreSQL                                                   | SQL SELECT 1; not worker/queue proof                               |
| Public integration flag | true                                                                              | Presence of config only, not verified provider                     |
| Public config           | Authward enabled, Google, Microsoft, magic link                                   | Not successful callback                                            |
| Authward OIDC discovery | 200, issuer https://auth.olaryn.com                                               | Not token exchange or redirect allowlist validation                |
| Public browser entry    | 200, login/email choices + Terms/Privacy visible                                  | Unauthenticated                                                    |
| Public callback errors  | 4/4 friendly alert messages; no raw provider description or query string retained | Simulated inbound GET query, not actual OAuth                      |
| Local dev API           | /api/health 502; /api/public-config 502                                           | API container process unavailable                                  |
| Local dev browser       | 200 marketing UI; /login has no working email/login controls                      | Unusable for authenticated acceptance                              |
| Local dev Authward      | discovery 200                                                                     | Shared development identity, not an approved staging test identity |

The browser reported three intercepted non-GET requests during
the public anonymous smoke (likely telemetry or other page traffic;
their exact effect was not established). This non-write smoke cannot
prove behavior of those calls, and the result must not be described
as a completed sign-in.

### Local development blocker: confirmed from current logs

The long-running trevra-dev-trevra-1 container has the frontend
up but no listening application API at the Vite proxy target.
Container log evidence:

- Hosted/worker initialization aborts:
  AUTHWARD_ISSUER, AUTHWARD_CLIENT_ID and AUTHWARD_CLIENT_SECRET
  must be configured together.
- API startup fails to resolve the declared stripe dependency:
  ERR_MODULE_NOT_FOUND package 'stripe' imported from
  src/server/provider-webhooks/stripe.ts.
- Vite returns 502 because port 8787 is refused.

Issuer and client-id environment keys exist in this container;
client-secret key is not present. The source package.json declares
stripe, so this is installed-runtime/dependency drift, not evidence
that the checked-in dependency declaration is missing.

**Do not fix by changing product authorization policy or disabling
hosted safeguards.** An authorized operator should validate the
correct nonproduction Authward confidential client, supply matched
environment keys, rebuild/install pinned lockfile dependencies,
then perform a separately approved deployment/restart. This audit
deliberately left running containers and persistent volumes untouched.

The local stack is a _development_ stack, not proof of staging.

### Staging inventory blocker

Repository documentation names a public Oracle single-E2 deployment
and Cloudflare Tunnel, but no distinct Trevra staging hostname.
The current gcloud project config is not a confirmed Trevra staging
project; its Cloud Run service listing exposed no applicable Trevra
service. OCI CLI/config and an operator SSH target were not available
for this run. Do not infer deployed revision, worker heartbeat,
schema_migrations latest head, SMTP alert delivery, off-host backup
presence or restore health. Source deploy scripts document migration,
backup and rollback steps only.

The latest repo migration is 147_outbound_webhook_outbox.sql.
No live/staging DB was queried or changed. Fresh temporary PostgreSQL
test instances were used for all test-backed qualification.

## Local tests and acceptance matrix

Prior base: npm run check 4003/4003 tests, build and TypeScript green,
with a separate SBOM inventory warning (not release certification).

Follow-up focused suite:

- src/server/auth-service.test.ts
- src/server/authward-token.test.ts
- src/server/linkedin/companion-api.test.ts
- src/server/linkedin/companion-recovery.test.ts
- src/server/linkedin/companion.test.ts
- src/server/linkedin/launch-mvp.acceptance.test.ts

Result: **53/53 tests passed in six files** on isolated PostgreSQL.
Tests cover real HTTP first-user workspace creation, cross-workspace
denial, expired/auth failures, owner/member permissions, Companion
pair/revoke/reconnect and controlled CSV→approval→worker→stop outcomes.
They are NOT browser or live-provider proof.

Additional migration/config suite: src/server/db.test.ts and
src/server/config.test.ts: **36/36 tests passed (2/2 files)** against
isolated PostgreSQL. This covers migration apply/resume/no-op and
hosted-boot schema refusal, not the actual deployed schema.
New script: node --check PASS, Prettier PASS; public read-only Playwright
smoke exit 0 with 4/4 callback-error states, localhost smoke exit 1
(expected due unavailable local API/login controls).

Full npm run check was run twice in this worktree:

- First run: 271/272 files, 4002/4003 tests, exit 1. The one failure
  was src/server/accounts/sweep.test.ts:864 (expected swept=2, got 3).
  This test and its production implementation were not modified.
- Isolated src/server/accounts/sweep.test.ts rerun: **31/31 PASS**.
- Second full run: **272/272 files, 4003/4003 tests, exit 0**;
  TypeScript, Vite and server build passed. The original failure is
  intermittent/unexplained, not a demonstrated fixed regression. Do not
  suppress that history or claim the full suite is deterministic.
- SBOM dependency inventory still unavailable (npm ESBOMPROBLEMS,
  conflicting @types/node); development build exits 0, release
  certification remains fail-closed. Full Dripify parity is not in scope.

| Browser customer journey                              | Result                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Anonymous hosted login UI                             | PASS                                                             |
| Email login choice, without sending link              | PASS                                                             |
| Friendly error on invalid/expired/callback failure    | PASS for 4 synthetic GET variants                                |
| Fresh authorized user, callback and tenant onboarding | BLOCKED (no staging test credentials / healthy staging)          |
| LinkedIn connection/Companion                         | BLOCKED in browser                                               |
| Gmail/Microsoft mailbox Connect                       | BLOCKED in browser                                               |
| CSV normalization/dedup                               | BLOCKED in browser; earlier PostgreSQL API tests pass            |
| Campaign and personalized preview                     | BLOCKED in browser; earlier PostgreSQL API tests pass            |
| Exact-message approval                                | BLOCKED in browser; earlier PostgreSQL tests pass                |
| Start, pause, stop; results and replies               | BLOCKED in browser; earlier PostgreSQL tests pass                |
| Missing config / startup feedback                     | BLOCKED local API; explicit errors diagnosed from logs           |
| Operator reconnect and unknown outcome                | PASS in controlled PostgreSQL tests; real incident drill BLOCKED |

## Gate status (not a launch declaration)

| Gate | Status  | What remains                                                                                                |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------- |
| L1   | PARTIAL | Anonymous login and callback errors verified; no completed staging Authward session or tenant onboarding    |
| L2   | PARTIAL | Source config/migrations and public DB health; no staged worker, schema inventory, backup/restore or alerts |
| L3   | PARTIAL | Controlled companion tests; permitted real pairing, checkpoints and terms review absent                     |
| L4   | PARTIAL | Controlled Nango/email actions; real verified mailbox, DNS, inbound absent                                  |
| L5   | BLOCKED | Protected campaign browser workflow unavailable without dedicated working test tenant                       |
| L6   | PARTIAL | Isolated negative safety tests; real boundary/consent authorization absent                                  |
| L7   | PARTIAL | Tested reconnect/alert logic; actual SMTP/alert and unknown-outcome recovery drill absent                   |
| L8   | BLOCKED | Founder/legal review and truthful first-customer commercial terms not signed off                            |

### Exact operator prerequisites

1. Supply a **dedicated authorized staging** origin, current image
   digest, worker health origin or console, read-only logs/metrics
   and schema-migration/backup evidence; no live migrations.
2. Fix the nonproduction API startup prerequisites via an owner-approved
   runtime rollout: matching Authward issuer/client/secret and lockfile
   dependencies. Do not reboot this shared dev stack merely for testing.
3. Supply a fresh staging Authward test user and owner tenant, with
   callback URL allowlist and scoped cookie configuration. Browser
   approval remains subject to that identity.
4. Use controlled synthetic leads and provider doubles for campaign
   journey, loading/error states, disconnection and safe pause/stop;
   assert saved state through tenant-scoped API reads.
5. For any **later** real-provider acceptance, secure explicit founder,
   legal, LinkedIn-platform and email-provider authorization; owned
   Companion, Nango OAuth mailbox, verified SPF/DKIM/DMARC and consented
   test recipient. Capture redacted provider IDs, no duplicate send,
   reply/opt-out and unknown-state reconciliation under supervision.
6. Demonstrate a worker cycle, operator alert receipt, incident response,
   off-host backup and an isolated restore with UTC timestamps and
   accountable operator sign-off.

### Decision

**NO-GO for the first real customer today.** The public anonymous
front door and negative callback messages work, and local isolated
tests cover the core flow. A working authorized staging runtime and
authenticated end-to-end browser evidence are still absent. Never
label public reachability or a mock-provider test as live acceptance.
