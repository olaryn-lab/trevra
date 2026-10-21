# Trevra launch L1/L5 isolated real-browser acceptance

Date: 2026-10-21
Base: d4470ea1a03a464c08deef6c85e2781c392504bc
Branch: feat/launch-mvp-gate-l1-l5-20261021
Worktree: /home/pankaj/Projects/Trevra-worktrees/launch-mvp-gate-l1-l5-20261021

## Reproduce

    npx tsx scripts/launch-mvp-hermetic-browser.ts

**21/21 checks PASS** using a real Playwright Chromium instance, actual
React UI, real Express/API/Better Auth handlers and disposable PostgreSQL 17.
No existing application services were restarted. The script creates a
temporary loopback-only test listener and fresh PostgreSQL container; the
finally cleanup removes both, closes the database and exits the browser.

This is LOCAL test-mode identity rather than hosted Authward. All test
people belong to a synthetic example.test CSV; the manually inserted
sender row is an intentionally unpaired provider double. No provider
connection, worker, email or LinkedIn send is attempted. Live credential
keys are cleared from the script environment before imports.

## L1 acceptance observed through the actual browser

- A new browser sees login and creates an owner through the signup UI.
- Real authenticated session response returns the new workspace/owner.
- UI leaves the signup panel.
- Second independent user signs up in a second browser context and receives
  a DISTINCT workspace, while the first still belongs to the original.
- Third, unauthenticated context sees HTTP 401 for session access.
- No uncaught page errors in the first user's browser journey.

Not proved: hosted Authward registration/callback, session expiry and
staging deployment identity.

## L5 acceptance observed through actual browser and persistent API

- Fresh owner loads Outreach and navigates to New campaign.
- Without a sending account, the workflow gives actionable missing-config
  feedback and links to the actual Workspace setup screen.
- After adding only a disposable database sender fixture, actual browser
  CSV upload prepares a DRAFT via the real API.
- Three original CSV rows collapse to TWO persisted campaign members.
- Start presents an explicit confirmation before mutation.
- Start, Pause, Resume and Stop controls all work in the actual UI; API
  readback verifies running / paused / running / stopped respectively.
- No background worker or external provider is started; these are
  state-transition checks only, not delivery claims.

Not proved: real companion or Nango mailbox UI pairing, individualized
action-message approval and preview, worker outcome, reply/bounce/unknown
outcome recovery and first-customer staging UX. An exploratory planner
run with the safe default sequence did not yield an approval row at the
specific clock instant; no production defect or safety bypass was inferred
from that incomplete observation.

## L1–L8 gate status (actual launch, not local test status)

| Gate | Status  | Remaining evidence                                                                      |
| ---- | ------- | --------------------------------------------------------------------------------------- |
| L1   | PARTIAL | Local UI/signup/isolation PASS; staging Authward callback/expiry absent                 |
| L2   | PARTIAL | Disposable DB/runtime PASS; deployed schema/worker/backup restore absent                |
| L3   | PARTIAL | Prior controlled tests PASS; real permitted Companion absent                            |
| L4   | PARTIAL | Prior email doubles PASS; real OAuth mailbox/DNS/reply absent                           |
| L5   | PARTIAL | Local CSV/draft/lifecycle UI PASS; review/results/recovery browser evidence absent      |
| L6   | PARTIAL | Prior negative tests PASS; external approval/consent and provider-boundary smoke absent |
| L7   | PARTIAL | Prior reconnect tests PASS; actual alert delivery and incident drill absent             |
| L8   | BLOCKED | Founder/legal/commercial sign-off absent                                                |

## Next evidence required for first customer

An isolated authorized staging deployment and Authward test user are
required to verify hosted L1. A staging worker/DB operator must demonstrate
migration head, worker cycle, backup restore and delivered alert (L2/L7).
Complete browser approvals/reply/recovery using controlled provider doubles
first (L5). Any later real provider action requires explicit owner consent,
LinkedIn platform-terms/legal review, owned test accounts and recipient,
verified email DNS, and redacted provider-side result reconciliation.

**NO-GO** for unsupervised first paying customer until hosted and external
gates are demonstrated. No push, PR, merge, deployment, existing-service
restart, live migration or external outreach was performed.
