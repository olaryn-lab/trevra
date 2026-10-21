# Trevra MVP launch acceptance — 21 October 2026

## Handover

Repository: @LC-Trerva
Base: c49fc1427869f37b2f3c671af7af63e862367d62
Branch: feat/launch-mvp-acceptance-l5-l7-20261021
Worktree: /home/pankaj/Projects/Trevra-worktrees/launch-mvp-acceptance-l5-l7-20261021

This qualification is **launch-critical MVP only**, not Dripify parity or release certification.

## One-command reproduction

    npm run launch:acceptance

No previously running service is touched. The wrapper runs two phases in sequence:

1. The real React UI in Chromium using a temporary loopback Express/Vite listener, Better Auth and a fresh disposable PostgreSQL 17 container.
2. Real tenant-scoped SQL, HTTP routes, worker/job logic, recovery logic and safety boundaries with in-process LinkedIn and Nango/email provider doubles and a second disposable PostgreSQL test database.

Provider credentials are scrubbed from inherited environment for both phases. All contacts are synthetic example.test entries. No actual provider is authenticated, contacted for sends, or given account permissions. No production/staging datastore, deployment, or worker is changed.

**Final observed command: exit 0, LOCAL_ACCEPTANCE_PASS.**

| Phase                                                  | Verified result                             |
| ------------------------------------------------------ | ------------------------------------------- |
| Chromium + real app/browser journey                    | **39/39 checks PASS**                       |
| Focused controlled provider/migration-integrated tests | **16/16 PASS; 4/4 files**                   |
| TypeScript                                             | PASS                                        |
| Client and server build                                | PASS; development-only SBOM warning remains |

### Concrete evidence (local, kept private)

Report: /tmp/trevra-launch-acceptance/2026-10-21T15-40-47-000Z/report.json

The same report directory contains browser.log, controlled-providers.log, browser-trace.zip, and browser-final.png. The trace and screenshot are never pushed or uploaded automatically; a trace may include synthetic login cookies and must still be treated as sensitive.

Browser evidence includes: new owner signup/session and unauthenticated denial, independent workspaces, authenticated Outreach navigation, missing sender recovery link, CSV import/deduplication (3 rows → 2 members), draft creation, review-before-start, start/pause/resume/stop state transitions, planned personalized LinkedIn message preview, content-hash tampering denied, blocked unapproved driver execution, real owner approval click/HTTP persistence, one fake successful driver call with zero duplicate on retry, Never Contact persistence and tenant-specific denial of private campaign/approval/suppression access.

Focused tests (src/server/linkedin/launch-mvp.acceptance.test.ts, companion-recovery.test.ts, companion-api.test.ts and src/server/app-session-cookie.test.ts) additionally exercise real API/DB + controlled provider boundaries for reply and duplicate webhook outcomes, hard bounce/unsubscribe, suppression-before-send, unknown-send quarantine without retry, Companion checkpoint alert/reconnect and pairing controls. This is **not evidence of a live provider send**.

### Genuine launch-blocking defect fixed

The full browser journey reproduced HTTP 429 on the approval screen with RateLimit-Policy 300;w=60 **despite a valid Better Auth login**. Trevra's rate-limit classifier recognized the legacy session cookie or cookies containing better-auth, while the configured Better Auth cookie prefix is trevra, producing trevra.session_token.

The isolated fix in src/server/app.ts recognizes trevra.session_token and __Secure-trevra.session_token explicitly, retaining the existing legacy allowance. Authenticated requests now use the 1200/minute tenant bucket; forged/expired claims still require session validation and receive anonymous-IP metering. The dedicated five tests plus live browser assertions verify positive and negative cases. No rate limit was disabled or inflated.

### L1–L8 evidence status

| Gate | Status  | What this command proves / does not prove                                                                                                 |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| L1   | PARTIAL | Local real browser signup, owner role, two-tenant isolation and anonymous denial PASS; hosted Authward and staging callback unverified    |
| L2   | PARTIAL | Disposable PostgreSQL migration + real API/UI PASS; deployed image, worker heartbeat, staging schema, alert and backup restore unverified |
| L3   | PARTIAL | Controlled local driver/Companion recovery PASS; no authorized real LinkedIn connection or delivery                                       |
| L4   | PARTIAL | Controlled email Nango double and reply/bounce path PASS; no real mailbox OAuth, SPF/DKIM/DMARC or inbound delivery                       |
| L5   | PARTIAL | Local actual browser CSV, draft, approvals and lifecycle PASS; live permitted execution and full staging operator journey unverified      |
| L6   | PARTIAL | Tamper, tenant denial, no-approval/no-replay, unknown and suppression tests PASS; live consent/platform/legal authorization pending       |
| L7   | PARTIAL | Mocked Companion checkpoint and unknown-send fail-closed tests PASS; no delivered production alert, actual disconnect or restore drill    |
| L8   | BLOCKED | Founder/commercial and legal/privacy terms not signed off                                                                                 |

**Launch decision: NO-GO for unsupervised first paying customer.** This is a repeatable local acceptance gate, not production or staging certification. Next evidence must come from a separately authorized staging runtime and permitted real-provider checks. No push, PR, merge, deploy, service restart, production migration or outreach occurred.

## Known build limitation

npm run build exits 0 with TypeScript and Vite green but npm sbom reports ESBOMPROBLEMS involving conflicting @types/node requirements. Release certification remains fail-closed. The client also reports a large bundle advisory.
