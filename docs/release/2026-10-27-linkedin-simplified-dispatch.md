# Trevra LinkedIn dispatch: simpler policy (2026-10-27)

## Actual incident and boundary

The October 27 production queue had **two paused campaigns, a paused LinkedIn seat, 37 held actions, and one historical claimed action**. These are an intentional operational hold from the previous reliability recovery. A software pacing change does **not** automatically resume them or send those actions.

## Decision: one seat budget, not stacked campaign penalties

- A managed campaign may use the seat's existing per-kind daily capacity **from day one**. The runner still fair-shares that budget among concurrent campaigns, subtracts work already planned, and applies the account's rolling limits. The old separate five-day **20/40/60/80/100% campaign ramp** is removed; campaign launch preview and execution use the same rule.
- Low LinkedIn invite acceptance is shown as an **advisory**, not an across-the-board stop or an additional 50% throughput reduction. This metric can be noisy or sparse, especially for new campaigns. It does not replace consent, suppression, or reply-based stop rules.
- A pending invitation consumes the **outstanding-invite capacity** but is **not** also charged again as a newly sent invite against the rolling seven-day quota. The planner reserves space under the existing outstanding cap without double counting.
- Keep the account's single warm-up policy for recently activated seats, its configured daily and rolling 7-day limits, InMail quota, scheduled working window and short session breaks. An explicitly established seat may use its established-account override.
- Never bypass seat/campaign pause, linked-account restrictions, platform challenge/restriction handling, target exclusions, opt-outs, suppression, permission/approvals, duplicate/replay protection, uncertain-send quarantine, or other outcome-based stop rules.

## Implementation

- `src/server/linkedin/managed-campaigns.ts`: `campaignActionLimit` and launch preview
- `src/server/linkedin/runner.ts`: shared-seat fair-share and planned ledger budgets
- `src/server/linkedin/guard.ts`: acceptance advisory, seat-level enforcement and no extra campaign ramp
- `src/server/linkedin/pacing.ts`: no acceptance multiplier, weekly-sends-vs-outstanding distinction

## Validation and activation

Compare on a disposable PostgreSQL dataset with the same approved workflow: a 5-lead, new managed campaign now plans all 5 when the account budget admits them, instead of 2 from the extra campaign ramp. Test that re-running the tick does not duplicate anything, pauses still park work, and suppression still prevents sends. Use the real UI and production relay in **read-only mode** after release; a live provider send requires an authorized test account and recipient.

Do not resume the 37 held production actions or clear the 42-day-old claimed action automatically. Reconcile recipients, consent, outcomes and intended campaigns separately before any release of that backlog.
