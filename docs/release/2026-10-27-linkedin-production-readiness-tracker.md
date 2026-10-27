# Trevra LinkedIn — production readiness tracker

**Owner:** Trevra. **Started:** 2026-10-27. **Canonical branch:** `main`. Update this file with each qualified milestone. Do not confuse a healthy browser, passing tests or a read-only provider check with successful real outreach.

## Goal and release standard

An explicitly approved LinkedIn campaign should execute reliably with a paired Companion, stop further follow-ups when a prospect replies, recover from disconnections without duplicates, and explain what it is waiting for. Full production-ready status requires **R0–R7 acceptance**, including an owner-approved real-send verification. A read-only rollout alone does not satisfy it.

## Non-negotiable safety

- Two historical campaigns are intentionally paused. Preserve 37 held actions and one claimed unknown-outcome action until deliberate operator reconciliation.
- Do not send to an arbitrary person. Real tests require an explicitly approved recipient and message.
- Never bypass approvals, opt-outs, limits, seat ownership or working windows to make tests pass.
- LinkedIn browser automation faces platform-policy and account-continuity risks even when technically reliable.

## Milestone scorecard

| ID                                 | Priority | Status                                         | Acceptance / evidence                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | -------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 — Live baseline                 | P0       | **DONE**                                       | Oracle API/worker and Companion verified; protected queues enumerated; 0 new sends in baseline                                                                                                                                                                                                                                                                                                           |
| R1 — Persistent tracker            | P0       | **DONE**                                       | This tracker merged in [PR #17](https://github.com/olaryn-lab/trevra/pull/17)                                                                                                                                                                                                                                                                                                                            |
| R2 — Reply freshness               | P0       | **DEPLOYED, PARTIAL**                          | Known recipient conversation refreshed before managed automated DMs/InMail/follow-ups; unknown threads fall back to bounded recent-inbox read; blocked/unreadable state refuses send; original safety/member checks rerun. **Unlinked conversations outside fallback window can still evade the scan**                                                                                                   |
| R3 — Stalled execution             | P0       | **DEPLOYED; APPROVAL-PARITY FOLLOW-UP TESTED** | PR #20 (`27266bb`) deployed: independent five-minute monitor checks approved overdue actions, business windows, online Companion and send-time gate before durable owner email. New bounded content-hash revalidation avoids false stalled alerts when approval no longer matches edited copy. Seven PostgreSQL tests pass locally. Real owner-email receipt from an active campaign remains unverified. |
| R4 — Fault-tolerant reconciliation | P0       | **LIVE IDLE RESTART PASS; SEND CRASH PENDING** | PR #19 durable marker deployed. On 2026-10-27 manually restarted systemd Companion 0.2.14 and proved Oracle Playwright could open authenticated LinkedIn feed in 6.8s. 0 new sends; 37 held and 1 unknown unchanged. Live crash during actual send remains untested.                                                                                                                                     |     |
| R5 — Real outbound proof           | P0       | **BLOCKED: APPROVED RECIPIENT**                | Owner-approved test target and content; actual delivery, read-back, reply suppression and operator-visible outcome required                                                                                                                                                                                                                                                                              |
| R6 — Simple user UX                | P1       | **PARTIAL: UI CODE**                           | Existing Working/Waiting/Needs attention/Paused account summary now incorporates claimable, executing and blocked campaign work. **Real authenticated mobile/browser acceptance remains open**                                                                                                                                                                                                           |
| R7 — Final release qualification   | P0       | **PARTIAL**                                    | R2 gate passed, but overall customer-ready qualification awaits R3–R6 and a controlled real-send test                                                                                                                                                                                                                                                                                                    |

## R2 release evidence — October 27, 2026

- [PR #17](https://github.com/olaryn-lab/trevra/pull/17), merged commit `b0445939303d103a0fe830e78fa7371e314be06e`.
- [Successful Oracle release](https://github.com/olaryn-lab/trevra/actions/runs/40490115079), API and worker healthy on `sha-b0445939303d103a0fe830e78fa7371e314be06e`.
- 187 focused PostgreSQL/LinkedIn tests; 16 launch acceptance tests; TypeScript and production build; full GitHub CI green.
- Live production **read-only** targeted thread preflight: `blocked=false`, one nonfatal transcript warning, no message inserted, same-recipient preflight cached correctly (one read over two calls), ~28 seconds.
- Worker scheduler `healthy=true`, planning/outbound/maintenance completed, Companion connected. After rollout: 1 active seat, **0 running campaigns, 2 paused campaigns, 37 held actions, 1 unresolved outcome, 0 new batches and 0 sends**.
- No real approved outgoing invitation or message has been tested in this release.
- R3/R6 second increment: account status now pulls the authoritative per-campaign operations report and existing blocker ladder; local status tests include running-with-no-due-work, gate waits and failed report reads. Merged as PR #18. Delivery-SLO alerting and live authenticated UI verification remain open.
- R4: Durable `settlement_hold_at` marker is set atomically by the current claim owner before the browser action. Reaper refuses crash-after-click retry, definite settlement clears the temporary marker, and uncertain session loss holds for manual reconciliation. 159 focused PostgreSQL tests passed, PR #19 deployed `28bb701`. On 2026-10-27 restarted the local Companion and confirmed Oracle-to-Chrome read-only Playwright loaded signed-in LinkedIn feed in 6.8s; no held action changed.
- R3: Owner stall notifications from PR #20 deployed to Oracle as `27266bb`; worker health `stallMonitor={detected:0,notified:0,failed:0}` against 0 running/2 paused historical campaigns. Approval-parity follow-up now rehashes approved copy before alerting and tests edit-after-approval invalidation. Pending separate CI/release.

## Precise continuation plan

1. **R3:** Release approval-parity fix after CI. Existing campaign monitor is deployed, with durable deduplication and safety/window checks. Validate that owner email arrives during an eligible real stall when a supervised running test campaign exists; do not wake archived campaigns.
2. **R4:** Durable send effect marker has been deployed and PostgreSQL fault injection passes; real idle Companion service restart and end-to-end read-only LinkedIn login recovery passed. Only approved controlled-recipient send + unknown-outcome reconciliation remains; preserve older unknown claim.
3. **R6:** Authenticated browser/mobile verification of account status and recovery guidance; status derivation has local tests but not a full live UI walkthrough.
4. **R7:** Re-run full tests, deployment and post-release health/queue checks after those changes.
5. **R5:** Only with an explicitly approved real recipient. Without that, label Trevra **engineering-qualified but not end-to-end outbound-certified**, not fully production-ready.

Keep work in small isolated worktrees and PRs. Do not broaden into email GTM, CRM, unrelated products or speculative redesigns. Update this scorecard and add exact links/hashes after each milestone.

- 2026-10-27 R3 validation: a production read-only check of the deployed PR #20 returned healthy worker, `detected=0`, `notified=0`, `failed=0`, with the two old campaigns still paused. New regression: action body edited after approval is rejected from stall evidence; reapproving the matching hash restores eligibility.
