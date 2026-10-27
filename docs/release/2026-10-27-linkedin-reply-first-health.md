# LinkedIn first-maintenance ordering and scheduler health

## Problem

The independent-cycles rollout started maintenance first, but immediately started outbound too. Because the maintenance pass releases the Companion browser lock between session detection and inbox sync, an outbound sitting could take its turn **before a recent reply had been ingested**. Send-time checks already retire actions when a reply is recorded, but the order increased the chance that those checks would inspect stale reply data.

The old worker health endpoint also returned 200 even when one individual LinkedIn cycle stopped progressing or reported a failure. "Healthy container" was not a reliable indication of "healthy LinkedIn automation."

## Change

1. An explicit startup coordinator runs the initial full maintenance pass before initiating outbound. Database-only planning starts independently and is not awaited. The outbound timer respects the initial-maintenance gate.
2. Expose `linkedin.scheduler` from the existing worker health endpoint, with healthy/starting/degraded/disabled state and sanitized reasons. Detect stale non-running loops, a stuck planning loop and action-discovery failures. Do not return 503 for LinkedIn-specific degradation because the worker serves unrelated product subsystems.
3. Preserve the separate recurring clocks, Companion exclusive browser lane, approvals, PostgreSQL claims/leases, unresolved-outcome holds and account pacing. No new LinkedIn send is attempted as part of this change.

## Scope of guarantee

This ordering improves first-pass reply freshness, but **does not assert replies are re-read before every send**: subsequent outbound sittings can still occur between bounded inbox visits, and LinkedIn can fail to render a conversation. The send-time database preflight continues to refuse follow-ups after an ingested reply. A stronger per-recipient freshness guarantee requires a separate explicit product decision about additional browsing and refusal policy.

## Verification

- Unit tests: planning independence, reply-first startup ordering, tick gate and error release; scheduler healthy/stalled/failure/startup cases.
- Focused worker and LinkedIn integration tests plus production build, followed by normal CI/release gates.
- Production read-only verification of worker health and the unchanged paused campaign/held-action state.
