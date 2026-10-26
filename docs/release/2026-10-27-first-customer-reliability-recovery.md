# First real-customer pilot: Trevra reliability recovery

Date: 2026-10-27
Status: **NO-GO for unattended production outreach**

## Trigger and evidence boundary

The first actual customer trial did not retain the customer: they reported too many
problems with LinkedIn Outreach and returned to Dripify. There is not yet a
customer-provided list of timestamps, affected campaigns, screenshots, or
provider failures. **Do not interpret any code fix below as a demonstrated
root cause of that customer's experience.**

Prior acceptance (2026-10-21) used a real browser and disposable PostgreSQL,
but LinkedIn and email send operations were controlled doubles, not real provider
calls. These checks cannot establish live reliability.

## Corrected code defects (candidate reliability improvements)

1. **Companion control reconnect could wait for outbound SMTP.** The WebSocket
   authentication path used to send the "back online" email synchronously;
   a delayed SMTP request could defer an otherwise healthy control connection.
   Socket authentication now updates durable heartbeat/recovery state and
   returns without sending email. The independent once-per-minute worker scan
   delivers matching recovery email.
2. **Concurrent scans could send the same outage email twice.** Email was sent
   before `disconnect_notified_at` was recorded. Migration
   `148_companion_notification_claim.sql` adds an atomic in-flight claim
   `disconnect_claimed_at`; workers recheck a stale heartbeat and acquire this
   claim before attempting SMTP. Failed claims are released, and abandoned
   claims expire after ten minutes. An SMTP send whose outcome is lost after a
   process crash may still be repeated: this is intentionally **at-least-once**.
3. **A reconnect during a disconnect SMTP request could miss its recovery
   notification.** The worker now reconciles online companions with outstanding
   disconnect markers. Delivery remains retryable if the mailer or owner
   recipient is unavailable.
4. **Misleading startup guidance.** The worker log previously claimed that
   a signed-in Trevra browser tab was required in companion mode, contradicting
   the documented service design. It now states that the paired computer is
   required but an open Trevra tab is not.
5. **Successful signup remained on `/login`.** The authenticated React shell was
   displayed without replacing the URL; the historical acceptance check missed
   it by only inspecting the disappearing form button. The app now routes a
   successfully authenticated `/login` to `/loop`, preserving app deep links.
   The browser check now requires the actual route and authenticated navigation.

These changes only affect operational notifications and companion startup
messages; they do not bypass action approval, compliance, pacing, LinkedIn
authorization or unknown-send quarantine.

## Verification

- TypeScript: pass.
- Focused PostgreSQL suites: companion, reverse-CDP relay, recovery (30/30).
- Added negative tests cover duplicate concurrent scans, reconnect during SMTP,
  failure/retry, claim expiry, and online heartbeat refusal.
- Full suite: 285/285 test files, 4,079/4,079 tests; TypeScript/client/server
  build exits 0 (before the final login-route change; final typecheck passes).
- Chromium/PostgreSQL launch acceptance after the login fix: 48/48 browser
  checks and 16/16 controlled-provider tests, exit 0. The signup URL assertion
  now confirms `/loop` rather than `/login`.
- **Not verified:** real LinkedIn actions, real sender-provider messages, production
  WebSocket topology, email delivery from deployed SMTP, live worker cadence,
  staging DB migration and restore.

## Remote branch preservation audit (2026-10-27)

Reviewed against `main` at `1f7a090` without merging historical branches.
`git cherry` reports distinct _patches_, not proof of missing product behavior.

| Remote branch                          |                           Distinct patches | Finding / action                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | -----------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/dripify-outreach-manager`        |                                         53 | August 13 fork; historical manager bootstrap. Current main has a later independently assembled manager (lead import, campaigns, workflow/approval, reporting) and October bug fixes. The old branch changes 37 files from its fork, but replacing current main's tree would revert hundreds of later files. Keep as historical reference, **do not merge or bulk cherry-pick**. |
| `feat/auth-ux-passkeys`                |                                          6 | October 1 capability advertisement and UI order, later consolidated through `9602cd5` and updated with native passkey/email callback changes. Do not reapply old auth UX; confirm live provider login in staging.                                                                                                                                                               |
| `feat/shared-design-system`            |                                          3 | October 7 historical stylesheet/font work. Newer shell/control refinements exist on main; mass CSS import would regress. Review only if a specific visual defect is reported.                                                                                                                                                                                                   |
| `feat/authward-realm-focused-20261017` | 1 patch not equivalent, 3 patch-equivalent | Historical explicit linking experiment. Current main contains migration 138, Authward-link source/tests, and guarded deploy integration by different commits, so no evident missing feature from file inventory. Do not activate realm migration without real security proof.                                                                                                   |
| `authward-interaction-expired`         |                           0 non-equivalent | Recovery already incorporated. No action.                                                                                                                                                                                                                                                                                                                                       |

Keep the active `feat/gtm-integrations` worktree undisturbed. Branch comparison is
static code/commit evidence, not a live behavioral parity test.

## Operational follow-up before another customer trial

Collect the customer's actual failures (screens/time, campaign IDs, disconnect
history and why Dripify was preferable); reconcile against sanitized server,
worker and companion logs without exposing tokens or message bodies. Perform an
owner-authorized staging deployment only after migration review. Verify actual
companion pairing, authenticated WebSocket continuity across idle gaps,
disconnect/reconnect notification delivery and retries, campaign approval,
a permitted test action, reply/suppression/unknown outcome, and pause/stop.
Repeat over multiple scheduled working days with clear support and recovery
ownership before a return invitation.

The eight launch gates in
`docs/release/2026-10-21-trevra-launch-mvp-scope.md` remain **unverified**.
Do not declare launch readiness from passing simulated-provider tests.
