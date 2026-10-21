# Trevra launch MVP qualification — L3–L6 (2026-10-21)

Source scope: 2026-10-21-trevra-launch-mvp-scope.md
Base: 5decf60070e3e9b01bd5bbab8b2e9efb03cfb9b3
Branch: feat/launch-mvp-acceptance-20261021
Worktree: /home/pankaj/Projects/Trevra-worktrees/launch-mvp-acceptance-20261021

## Evidence and limitations

The four new tests in src/server/linkedin/launch-mvp.acceptance.test.ts use actual
Express/session endpoints, an isolated PostgreSQL database, the campaign planner,
PostgreSQL LinkedIn worker store, approval policy and channel executor. A
deterministic LinkedIn driver and mocked Nango/email provider replace external
side effects. The worker's safety verdict is injected in the acceptance scenario;
independent local-worker/guard tests cover the full safety gate. This is NOT a
live LinkedIn, companion, Gmail, DNS, browser UI or staging acceptance.

Reproduce:
npx tsx scripts/test-with-postgres.ts src/server/linkedin/launch-mvp.acceptance.test.ts src/server/linkedin/manager-api.test.ts src/server/linkedin/campaign-channels.test.ts src/server/linkedin/runner.test.ts src/server/linkedin/local-worker.test.ts src/server/linkedin/lead-lists.test.ts

Focused result: **293/293 passed, 6/6 files**; new acceptance **4/4 passed**.
Server TypeScript: tsc --noEmit -p tsconfig.server.json — PASS.
npm run build — PASS; frontend/server TS and Vite passed. Build warns about a
large client chunk. Its SBOM step did not publish a manifest: npm sbom reported
ESBOMPROBLEMS, conflicting @types/node dependencies. Do not advertise SBOM proof.
npm run check — FAILED during test stage: 3998 passed, 5 failed (272 files);
all five failed cases were in src/server/outbound-webhooks.test.ts (deferred
from this MVP). No webhook source was edited. A separate base-branch
qualification is required to establish if those are pre-existing; do not
misclassify them as caused by or independent of this change without evidence.
The npm run check build subcommand therefore did not execute; it was run
separately and passed. Strict release:certify/full-parity gate remains unchanged.

## Customer workflow: exact reproducible boundary evidence

1. A LinkedIn owner seat and connected Gmail mailbox are persisted as test
   fixtures, not authenticated against providers. A campaign requires explicit
   mailbox assignment per sender; absence leaves email safely unapprovable.
2. Multipart CSV preview/import deduplicates the same LinkedIn profile,
   normalizes the email and retains two distinct leads. API list reads are
   tenant-scoped. Other-tenant and unauthenticated reads fail.
3. Authenticated APIs create mixed connection-invite/email workflow and
   draft campaign, assign mailbox, start and plan a real queued action.
4. Exact first-name/company substitutions appear in message reviews;
   incorrect content hash cannot be approved and other tenants cannot approve.
   No action reaches the provider double before owner approval.
5. PostgreSQL worker claims and checks planned/current content/approval, invokes
   controlled LinkedIn driver, persists a sent result. Subsequent batch
   does not resend that action. Browser pairing, selectors, pacing in a real
   browser and provider acceptance remain untested here.
6. Actual email executor holds unapproved sends, calls the Nango boundary only
   for approved messages and records known sent state with no duplicate send.
7. Simulated inbound reply stops downstream outreach. Separate unsubscribe and
   hard bounce tests persist unique events and email suppression, mark members
   excluded and retire already queued LinkedIn invitations. Replayed events
   are ignored; deliberate Never Contact before send prevents provider call.
8. A definite mocked HTTP 400 becomes failed/known; an ambiguous provider
   connection failure becomes unknown/not-known and is never auto-retried.
   Fabricated replies for unsent failures are ignored.
9. Campaign pause, resume through the existing /start route and stop are
   exercised through authenticated APIs; readbacks show persisted
   paused/running/stopped states. Browser-rendered UI feedback not verified.
10. Normal capacity-based waves admit contacts gradually; the test advances
    deterministic simulated days rather than weakening pacing limits.

**Production bug fixes: none.** Initial test-only errors were omitted required
sender mailbox assignment and an incorrect /resume route assumption; both
fixtures were corrected to follow the existing product/UI contract. No
production source, privacy guard, policy, migration, or other subsystem changed.

## Remaining L1–L8 launch gates, ranked

| Gate                    | Priority | Outstanding evidence                                                                                                                 | Required access/decision                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| L1 sign-in/onboarding   | **P0**   | Fresh-browser hosted auth/callback/expiry, tenant onboarding and UI                                                                  | Staging identity config and founder                            |
| L2 runtime              | **P0**   | Immutable staging build, schema upgrade, API/worker smoke, rollback and restore                                                      | Staging operator/database                                      |
| L3 LinkedIn             | **P0**   | Real permitted companion pairing, approved controlled action, reconnect/checkpoint, pacing, loss-of-authorization stop               | LinkedIn account, terms/permission review, owner-approved send |
| L4 email                | **P0**   | Real supported OAuth mailbox, SPF/DKIM/DMARC, compliant approved send, inbound reply, bounce, unsubscribe and unknown reconciliation | Provider login, DNS, consensual test recipient                 |
| L5 core browser journey | **P0**   | Actual browser CSV/preview/sender assignment/approval/sent-state/pause-stop and useful failure feedback                              | Staging browser, first-customer/founder acceptance             |
| L6 safety               | **P0**   | Approved lead provenance/lawful basis, policy sign-off, provider-boundary suppression race and controlled live smoke                 | Owner/legal review and specific outbound authorization         |
| L7 support              | **P1**   | Real alert/reconnect/unknown drill, support runbook and recovery owner                                                               | Operator access                                                |
| L8 honest launch        | **P0**   | Public claims, hosted privacy/terms, founder-assisted onboarding and approved manual commercial terms                                | Founder/commercial/legal sign-off                              |

Additional release hygiene: npm run check is red due to 5 out-of-scope webhook
tests and must be reconciled before claiming a green full engineering gate.
SBOM provenance is unavailable. These issues must not be solved by weakening
the full-parity release gate or broadening this narrow launch qualification.
Full Dripify parity, CRM, outbound webhooks, public API, AI composing,
white-label and automated billing stay deferred.

## Next task

**L1/L2 staging and supervised L3–L6 acceptance.** Use a fresh nonproduction
tenant, approved companion account and one verified mailbox; first validate
auth/connection/recovery and browser UI without outbound sends. After explicit
provider-terms and owner approval, send only to a consenting test recipient,
observe a genuine provider ID/reply and stop, then verify pause/reconnect and
unknown-result behavior. Preserve separate redacted live vs mock evidence.
Do not claim launch approval until all L1–L8 conditions are actually observed.
