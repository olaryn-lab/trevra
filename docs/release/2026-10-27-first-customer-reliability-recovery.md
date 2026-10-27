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
6. **New approvals could remain invisible on an already-open Outreach screen.**
   The review panel previously read the held-action queue only on mount and on
   in-app refresh events. Background worker planning cannot emit a browser
   event, so the owner could see no review panel despite pending work. The
   screen now refreshes its read-only approval list every 30 seconds while
   visible and immediately when the tab becomes visible again. Responses are
   sequence-fenced to prevent stale reads from undoing newer approval state.
   Browser acceptance now plans after the page is already open, then asserts
   a visibility refresh exposes the new approval without a navigation or send.

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

## Integration with newer main (2026-10-27)

Merged the October 23 inbox-message-window change and browser-harness stability
fixes from `main` at `1f7a090`, retaining the stronger post-signup `/loop` route
assertion. The initial integrated acceptance exposed intermittent cold-page
rendering in the review and synthetic OAuth flows. The isolated browser harness
now retries only read-only page prerequisites, never a POST, approval, or send;
it also captures page exceptions from its OAuth probe tabs. The combined
Chromium/PostgreSQL acceptance then passed **48/48 browser assertions and
16/16 controlled-provider tests**. These browser fixtures remain synthetic,
not a live-provider qualification. A merged full-suite run passed 4,083/4,084
tests but the 5,001-contact fixture exceeded its 20-second timeout under
host load; that file then passed 37/37 independently with the large fixture
completing, and its timeout was raised to 60 seconds without changing its
assertions. The final full-suite rerun was deliberately stopped at the
operator's instruction to prioritize **manual live integration evidence**.

## Manual live integration: 27 October 2026

This was an **operator-facing integration investigation**, not another
mock-provider or unit-test pass. No campaign mutation, customer-account login,
LinkedIn send, mailbox send, production migration, live service restart, or
production browser-profile modification was performed.

| Observed surface                                                                                   | Direct result                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Public `https://app.usetrevra.com/api/health`                                                      | HTTP 200; API and PostgreSQL healthy                                                                                                       |
| Live anonymous Chromium login                                                                      | Login/email options rendered; no page exceptions; sign-in not completed                                                                    |
| Public Companion WebSocket without credentials                                                     | HTTP 401; denied                                                                                                                           |
| Deployed worker to API                                                                             | HTTP 200 over private Compose network                                                                                                      |
| Worker to private browser relay with valid server credential and _nonexistent synthetic workspace_ | HTTP 503; correctly refuses absent Companion                                                                                               |
| Deployed worker `/health`                                                                          | HTTP 200; queue discovery marked healthy, no recent discovery errors                                                                       |
| Production image                                                                                   | `sha-a52a125...` in both API and worker; latest `main` not deployed                                                                        |
| Production DB migration                                                                            | Latest `147_outbound_webhook_outbox.sql`; new `148` not applied                                                                            |
| Live production queue                                                                              | 38 **overdue** planned LinkedIn actions, 2 campaigns still `running`; 181 total historical `sent` ledger rows, none created in past 7 days |
| LinkedIn action batches                                                                            | Last recorded batch on **2026-09-16**                                                                                                      |
| Recent background visits                                                                           | 68 `background_run` events in 7 days; **all 68 blocked** on browser open                                                                   |
| Server-side browser failure                                                                        | 40 recent `browserType.connectOverCDP` "Target page, context or browser has been closed" messages                                          |
| Local paired Companion                                                                             | Version **0.2.11**, active background systemd service, device heartbeat present                                                            |
| Local Companion errors                                                                             | Chrome opened in `minimizing` (graphical) mode and exited with code 1; no DevTools endpoint                                                |
| Active Companion service environment                                                               | Neither `DISPLAY` nor `XAUTHORITY` present, although interactive graphical session has both                                                |
| Manually reproduced Chrome launch                                                                  | Fresh profile + no `DISPLAY`, graphical launch exited 1: "Missing X server or $DISPLAY"                                                    |
| Manual alternative launch                                                                          | Fresh profile + no `DISPLAY`, headless Chrome created a live DevTools endpoint                                                             |
| **Patched Companion → local relay → actual Chrome → CDP**                                          | **PASS** using disposable HOME/profile, a synthetic local WebSocket relay, and a real `Browser.getVersion` round trip                      |
| Shared local Trevra development app                                                                | HTTP 502 at `/api/health` and `/api/public-config`; no authenticated journey possible there                                                |
| Latest GitHub release gate                                                                         | Container-image and CI jobs failed `npm audit`: 3 high and 1 moderate dependency advisory, so `main` has not released                      |

### Corrective change grounded in the incident

An unattended Companion relay sends `minimized: true` and `headless: false`
even when the Linux systemd service started without an X11 `DISPLAY`.
A "minimized" Chrome is still headed and fails at startup. The Companion now
converts unattended `minimized` mode to headless on Linux _only when no
`DISPLAY` exists_, and records `browser_headless_fallback`. Explicit
interactive login and `linkedin reconnect` stay headed and do not silently
fall back. This change was verified with a **real Chrome and a full synthetic
CDP transport exchange**, without real customer credentials or sends.

The stale Chromium Singleton links were **not** accepted as the root cause:
a disposable profile with those links still launched successfully. Display
absence was independently reproduced, matching the actual Companion's
configuration and exit code.

**Deployment is intentionally blocked.** A new Companion release may
immediately resume the 38 overdue production actions. The patch is prepared
for a separate versioned Companion release but has not been installed over the
active `0.2.11` service. Before activating it, explicitly hold production
outreach, verify ownership/consent of the recipient set, use an authorized
test account and recipient to prove a live connection and one deliberate
send, then re-enable any intended campaigns in a controlled sequence.
There is currently **no evidence of successful live send or reply completion
after the fix**.

The `oauth_code_verification_failed` anonymous public smoke scenario did not
pass its friendly-error expectation, but that smoke intentionally blocks
the POST that starts the fresh OAuth recovery transaction. Treat this
scenario as **inconclusive** until verified with an authorized login, not as
proof of a provider callback defect.

## Operational follow-up before another customer trial

Collect the customer's actual failures (screens/time, campaign IDs, disconnect
history and why Dripify was preferable); reconcile against sanitized server,
worker and companion logs without exposing tokens or message bodies. Perform an
owner-authorized staging deployment only after migration review. Verify actual
companion pairing, authenticated WebSocket continuity across idle gaps,
disconnect/reconnect notification delivery and retries, campaign approval,
a permitted test action, reply/suppression/unknown outcome, and pause/stop.
Repeat over multiple scheduled working days with clear support and recovery
ownership before a return invitation. Pushing directly to `main` triggers the
repository's container-image and production release workflows, so this branch
must not be pushed to `main` until the owner authorizes a live release.

The eight launch gates in
`docs/release/2026-10-21-trevra-launch-mvp-scope.md` remain **unverified**.
Do not declare launch readiness from passing simulated-provider tests.
