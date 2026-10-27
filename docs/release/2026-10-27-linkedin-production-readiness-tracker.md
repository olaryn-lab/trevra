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

| ID                                 | Priority | Status                          | Acceptance / evidence                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R0 — Live baseline                 | P0       | **DONE**                        | Oracle API/worker and Companion verified; protected queues enumerated; 0 new sends in baseline                                                                                                                                                                                                         |
| R1 — Persistent tracker            | P0       | **DONE**                        | This tracker merged in [PR #17](https://github.com/olaryn-lab/trevra/pull/17)                                                                                                                                                                                                                          |
| R2 — Reply freshness               | P0       | **DEPLOYED, PARTIAL**           | Known recipient conversation refreshed before managed automated DMs/InMail/follow-ups; unknown threads fall back to bounded recent-inbox read; blocked/unreadable state refuses send; original safety/member checks rerun. **Unlinked conversations outside fallback window can still evade the scan** |
| R3 — Stalled execution             | P0       | **PARTIAL: UI CODE**            | LinkedIn account summary now reuses the authoritative per-campaign execution blocker and queue report, so a running but idle campaign is no longer automatically called Working. **Proactive stall alerts and delivery-SLO verification remain open**                                                  |
| R4 — Fault-tolerant reconciliation | P0       | **TODO**                        | Inject disconnect, process stop, lease expiry and unknown-send outcomes; confirm no duplicate sends, permanent claim loss or silent replay; quarantine legacy claim                                                                                                                                    |
| R5 — Real outbound proof           | P0       | **BLOCKED: APPROVED RECIPIENT** | Owner-approved test target and content; actual delivery, read-back, reply suppression and operator-visible outcome required                                                                                                                                                                            |
| R6 — Simple user UX                | P1       | **PARTIAL: UI CODE**            | Existing Working/Waiting/Needs attention/Paused account summary now incorporates claimable, executing and blocked campaign work. **Real authenticated mobile/browser acceptance remains open**                                                                                                         |
| R7 — Final release qualification   | P0       | **PARTIAL**                     | R2 gate passed, but overall customer-ready qualification awaits R3–R6 and a controlled real-send test                                                                                                                                                                                                  |

## R2 release evidence — October 27, 2026

- [PR #17](https://github.com/olaryn-lab/trevra/pull/17), merged commit `b0445939303d103a0fe830e78fa7371e314be06e`.
- [Successful Oracle release](https://github.com/olaryn-lab/trevra/actions/runs/40490115079), API and worker healthy on `sha-b0445939303d103a0fe830e78fa7371e314be06e`.
- 187 focused PostgreSQL/LinkedIn tests; 16 launch acceptance tests; TypeScript and production build; full GitHub CI green.
- Live production **read-only** targeted thread preflight: `blocked=false`, one nonfatal transcript warning, no message inserted, same-recipient preflight cached correctly (one read over two calls), ~28 seconds.
- Worker scheduler `healthy=true`, planning/outbound/maintenance completed, Companion connected. After rollout: 1 active seat, **0 running campaigns, 2 paused campaigns, 37 held actions, 1 unresolved outcome, 0 new batches and 0 sends**.
- No real approved outgoing invitation or message has been tested in this release.
- R3/R6 second increment: account status now pulls the authoritative per-campaign operations report and existing blocker ladder; local status tests include running-with-no-due-work, gate waits and failed report reads. Delivery-SLO alerting and live authenticated UI verification remain open.

## Precise continuation plan

1. **R3:** Complete delivery-SLO evidence and actionable stall notifications. UI account summary already uses `getLinkedInCampaignOperations` and the tested `campaignExecutionBlocker` ladder; verify real workspace response and no false warnings.
2. **R4:** Use the existing controlled-provider and Postgres harness to fault-inject around claim, pre-send check, browser click, outcome settlement and restart. Confirm the unknown-outcome action remains quarantined.
3. **R6:** Authenticated browser/mobile verification of account status and recovery guidance; status derivation has local tests but not a full live UI walkthrough.
4. **R7:** Re-run full tests, deployment and post-release health/queue checks after those changes.
5. **R5:** Only with an explicitly approved real recipient. Without that, label Trevra **engineering-qualified but not end-to-end outbound-certified**, not fully production-ready.

Keep work in small isolated worktrees and PRs. Do not broaden into email GTM, CRM, unrelated products or speculative redesigns. Update this scorecard and add exact links/hashes after each milestone.
