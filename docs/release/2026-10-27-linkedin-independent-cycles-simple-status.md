# LinkedIn execution reliability and simpler status

## What changed

- Three independent worker cycles: database-only campaign planning, outbound action execution, and maintenance (session checks, inbox/reply sync, scheduled posts).
- The Companion remains the execution endpoint and uses one FIFO browser lane across outbound and maintenance. No second CDP client can manipulate the same Companion profile while another worker task uses it. Cloud-provider execution retains its existing concurrency.
- Each cycle has its own single-flight guard, progress timestamps, sanitized error state, and graceful-shutdown participation. The worker health endpoint exposes cycle and browser-lane state without client-specific data.
- LinkedIn Accounts leads with one truthful status: Checking, Connect, Needs attention, Paused, Waiting for a campaign, or Working. Source-of-truth reads are existing workspace campaign, account, worker and Companion endpoints, not duplicate server counters.
- Connected does not imply sending. The Companion diagnostics panel collapses when healthy and opens for attention.

## Semantics and safety

- Existing PostgreSQL claim, lease, reaper, unknown-outcome protection, approval, suppression, per-seat posture and safety gates are unchanged.
- No old queue is replayed; coming online still triggers no missed timer replay.
- Planning is not blocked by browser navigation or action cooldown. Browser operations remain serialized across the paired computer. An in-progress long outbound sitting can still delay the actual maintenance **browser read**, but no longer pauses its scheduling or the planner. This is deliberate: concurrently controlling the same persistent Chrome profile risks conflicting navigations and mistaken send outcomes.
- The UI only calls a campaign Working when an associated campaign is running, and explicitly says sends occur when actions are approved and eligible. It does **not** claim a message was delivered.
- No campaign pause/resume, daily limits, send mode, or consent was changed by this release.

## Evidence and checks

- Unit tests verify FIFO browser exclusivity, failure recovery, independent cycle progress and plain-language status priority.
- The focused LinkedIn/PostgreSQL suite exercises the existing claim/runner and browser-job boundaries; launch acceptance covers approvals, unknown outcomes and reply handling.
- Real sending is not part of this release qualification and must be verified separately with an approved recipient.

## Next improvements

- Add durable tenant-facing execution delivery-SLO events and proactive stuck-campaign alerts.
- Allow a long outbound sitting to yield between safe action boundaries so maintenance can read incoming replies sooner without allowing simultaneous access to one Chrome profile.
- Replace the unrestricted CDP tunnel with a versioned, capability-scoped Companion command protocol for a stronger remote-control boundary.
