# Trevra outreach and execution capabilities (code inventory for Dripify parity)

Scope and method: this covers the code on disk at /home/pankaj/Projects/Trevra, branch `main`, commit `a79cf55`, read on 2026-10-20. The research was read-only. All paths are relative to the repo root. Sources are `path:Lx-Ly` code citations, not URLs.

Findings marked **(verified)** were re-read first-hand by the lead researcher. The rest come from four delegated read-only code sweeps that cited exact lines. Those were spot-checked, not re-read line by line.

Status labels:

- **WIRED**: works end to end, UI → `src/client/api.ts` → Express route in `src/server/app.ts` → server function → PostgreSQL → worker or driver.
- **PARTIAL**: works, but part of the chain is limited or missing.
- **STUB**: the code exists but is unreachable or inert.
- **ABSENT**: not found in the code.

Internal docs such as `DRIPIFY_PARITY.md` and `docs/core-product.md` are treated as claims. Where they disagree with code, the code wins and the drift is noted.

## 1. LinkedIn integration: mechanism, reads, writes

### Takeaway

Trevra has a deep, first-party LinkedIn automation engine. It does not use an official API, Unipile or Nango. Stock Playwright on the server drives a real Chrome over CDP.

That Chrome is either the member's own computer, via a paired "Companion" CLI and reverse tunnel, or an opt-in remote cloud browser that requires a per-seat proxy and a written consent. The server never launches a browser itself.

It can perform about 20 distinct LinkedIn write actions and the core reads: inbox, connections and acceptance, pending invites, profile degree and open-profile status, and own-post metrics. Search, Sales Navigator and post-engager scraping is built but hard-disabled at the route.

### Cited Findings

**Mechanism and where the browser runs**

- No Unipile or Nango in the LinkedIn code. `rg -il "unipile|nango" src/server/linkedin` returns nothing, and `docs/integration-contracts.md` has no LinkedIn mention (verified).
- Server-local browser launches are refused outright. `openSeatBrowser` returns `refused: 'Server-local browser launches are disabled. Pair a Companion device or configure a remote browser provider.'` unless the provider kind is `remote` — `src/server/browser/provider.ts:392-413`, `src/server/browser/local.ts:1-14` (verified).
- Worker enable gate (verified, `src/server/config.ts:124-147`):
  - `enabled: (remoteBrowser || companionBrowser) && parsed.TREVRA_LINKEDIN_LOCAL !== 'false'`.
  - `TREVRA_DEPLOYMENT_MODE` is `local|hosted` and must be explicit in production (`config.ts:62-77`).
- Companion is WIRED.
  - CLI `packages/trevra-cli/bin/trevra.js` (v0.2.2) pairs with a 10-minute one-time code that is SHA-256 hashed (`src/server/linkedin/companion.ts:119`; routes `app.ts:1091,1878,1896`).
  - It keeps a dedicated Chrome profile under `~/.trevra/linkedin-companion/<ws>/<seat>` (`trevra.js:492`).
  - It relays CDP over WebSocket (`src/server/linkedin/companion-relay.ts:125,311`).
  - Presence is a device heartbeat within 90s (`companion.ts:742-768`).
  - One device per workspace (migrations `077`, `078`).
- Companion background mode runs **headed-minimized Chrome** (`headlessBrowser: false, minimizedBrowser: true`) — `packages/trevra-cli/bin/trevra.js:1325-1334` (verified). This contradicts `docs/linkedin-companion.md:5`, which says "Normal background-service work runs headless" (verified).
- Remote cloud browser is PARTIAL: wired, but no evidence it has been run live.
  - Requires `TREVRA_BROWSER_PROVIDER=remote` plus `TREVRA_BROWSER_CDP_URL`.
  - Requires a per-seat proxy, and refuses without one (`browser/provider.ts:235,372,511-516`).
  - Requires a written per-workspace hosted-execution acknowledgement (migration `065`; `src/server/linkedin/hosted-execution.ts:231-258`; routes `app.ts:5401,5428,5461`).
  - Requires a sealed `storageState` session (`src/server/linkedin/session-state.ts:155,218`).
- `npm run linkedin:worker` (`src/cli/trevra-linkedin-worker.ts`) is dead. It exits at `if (!readiness.canLaunchHeaded) fail(...)` (`trevra-linkedin-worker.ts:115-116`), and `linkedInBrowserReadiness` returns `canLaunchHeaded: false` on every branch (`src/server/linkedin/local-worker.ts:3471-3504`) (verified).
- Human-send mode per seat is WIRED (migration `134` adds `linkedin_seats.send_mode` default `'automated'`).
  - `HUMAN_SEND_KINDS = ['invite','dm','reply','inmail','group_message','event_message']` are handed to the founder on the "Today" screen to send by hand. Passive kinds (views, follows, likes, endorsements) stay automated (`src/server/linkedin/seats.ts:66-82`; `src/server/linkedin/handoff.ts:19-38`) (verified).
  - lc-debt: one handoff per seat, 10 candidates (`handoff.ts:35-38`) (verified).

**Write actions (all executed by `execute()` in `local-worker.ts:866-1048`, an exhaustive switch)**

- Connection request with an optional note (≤300 chars) — WIRED. `sendInvite` `src/server/linkedin/driver.ts:1367`.
- Message / DM to a 1st-degree connection — WIRED. `sendDm` `driver.ts:1656`.
- Inbox reply — WIRED. `enqueueReply` `src/server/linkedin/inbox.ts:1206`, route `POST /api/linkedin/inbox/threads/:threadUrn/reply` `app.ts:7697`, driver `sendReply` `src/server/linkedin/driver-inbox.ts:1003`.
- InMail — WIRED. `sendInMail` `driver.ts:1767-1845`; gated by seat capability, a credit cap and `allowPaid`. Stale comments in `actions.ts:64-93`, `local-worker.ts:136-141` and `sequence.ts:540-554` wrongly say InMail is retired; `UNSUPPORTED_ACTION_KINDS = []` (`actions.ts:94`).
- Profile view — WIRED. `viewProfile` `driver.ts:1852`.
- Follow, unfollow, disconnect — WIRED. `src/server/linkedin/driver-engage.ts:294,380,437`. `disconnect` requires `acknowledgeDestructive`.
- Like a recent post — WIRED. `likeRecentPost` `driver-engage.ts:556`.
- Endorse skills — PARTIAL.
  - `DEFAULT_ENDORSE_LIMIT = 1; MAX_ENDORSE_LIMIT = 1` and `limit = Math.min(MAX_ENDORSE_LIMIT, ...)` (verified, `driver-engage.ts:186-187,655-665`).
  - So exactly one skill is endorsed per action, even though the workflow step accepts `maxSkills` 1-10, default 3 (`workflows.ts:268`).
- Company and community actions — WIRED (`src/server/linkedin/driver-community.ts:162,187,318,335,352,446,464`).
  - Follow a company; like a company post.
  - Invite a connection to follow a company, to an event, or to a group.
  - Message a group member; message an event attendee.
- Withdraw a pending invite — WIRED. `withdrawInvite` `src/server/linkedin/driver-withdraw.ts:593`; batch `withdraw.ts:1336`; routes `app.ts:7733-7826`.
- Publish a LinkedIn post — PARTIAL. `publishPost` `src/server/linkedin/driver-post.ts:81`, ticked from `jobs.ts:1624-1735`. Selectors are marked UNVERIFIED-AGAINST-LIVE-DOM (`driver-post.ts:25,32`).
- Comment on a post — ABSENT as automation. `comment` is in `ACTION_KIND_VALUES` (`actions.ts:40-60`) but has no driver. Only the `manual_comment` human-task step exists.
- Voice-note messages — STUB. The server schema accepts `mediaKind: 'voice'` (`workflows.ts:104`, verified). The driver refuses it with `compose_unavailable` (`driver.ts:1581-1586`), and the client blocks it (`LinkedInManagerWorkflowConfig.tsx:546,586`).

**Reads**

- Inbox thread list and messages — WIRED. `listConversations` `driver-inbox.ts:689`, `readThread` `:881`, 2–7s paced gaps. Worker side task every 2h (`side-tasks.ts:60,82-96`).
- Recent connections and acceptance detection — WIRED. `listRecentConnections` `driver-withdraw.ts:838`, `syncAcceptedConnections` `withdraw.ts:1672`, `detectAcceptedInvites` `withdraw.ts:1765`.
- Pending invites — PARTIAL. `listPendingInvites` `driver-withdraw.ts:478`, synced every 12h or on operator request.
- Profile degree and open-profile status — WIRED. `readProfileDegree` `driver.ts:1934`, `readOpenProfile` `driver.ts:1735`.
- Own seat identity — WIRED. `readSeat` `driver.ts:2173`, `detectLinkedInSeat` `local-worker.ts:5601`.
- Own post metrics — WIRED. `readOwnPostMetrics` `driver-post-metrics.ts:124`, every 6h.
- People search, Sales Navigator, content search, post engagers and profile lists — STUB. Scrapers exist (`driver-scrape.ts:945,1032,1060,1267,1520`), but `POST /api/linkedin/lead-sources` always calls `assertLeadSourcingOn()`, which unconditionally `throw new LinkedInApiError(DISABLED_LINKEDIN_LEAD_SOURCING_REASON, 409)` (verified, `app.ts:7482-7489,9736-9745`). `GET` reports `enabled: false` (verified, `app.ts:7510-7526`).
- Engagers on a post Trevra itself published — PARTIAL. Only when `TREVRA_LINKEDIN_LEAD_SOURCING==='true'` (`jobs.ts:945-1004,1305-1318,1698-1713`).

### Inferences

- The LinkedIn action set is broader than Dripify's core list: connect±note, message, view, follow, like, endorse, InMail and withdraw, plus company, event and group actions and disconnect/unfollow. The real parity gaps are lead sourcing from LinkedIn search and Sales Navigator, which is deliberately disabled, and endorse depth.
- The only first-class execution path for a hosted customer is a Companion running on their own always-on computer. Dripify runs in the cloud with no local machine. This is a deliberate boundary: `DRIPIFY_PARITY.md:249` cites LinkedIn User Agreement §8.2. It is the largest UX difference.

### Gaps

- No evidence in the repo that the driver selectors were validated against live LinkedIn recently. Probe scripts exist (`scripts/linkedin-action-check.mts`, `scripts/linkedin-read-probe.mts`), but they were not run.
- Whether the remote cloud-browser path has ever run in production could not be determined from code.

## 2. Outreach sequences and campaigns (and how playbooks relate)

### Takeaway

The "managed campaign" system in `src/server/linkedin/` is a full drip-campaign builder and runtime, and it is the only live campaign path. Workflows are a graph of up to 100 steps drawn from 27 action types. They support:

- per-step delays in hours or days;
- conditions and monitors (connected, accepted, replied, open profile, email events);
- A/B variants (up to 4, weighted);
- stop-on-reply;
- start, pause, resume and stop;
- waves and admission control;
- multi-sender rotation;
- SLA and fairness scheduling;
- mixed LinkedIn and email steps.

Playbooks cannot model a cadence. They have only skill, approval and action steps, with no wait, branch or stop-on-reply.

### Cited Findings

**Workflow actions and graph**

- 27 workflow actions in the zod union `workflowStepsSchema` (verified list at `src/server/linkedin/workflows.ts:145-372`):
  - LinkedIn actions: `connection_request`, `withdraw_pending`, `profile_view`, `message`, `follow`, `unfollow`, `disconnect`, `inmail`, `like_post`, `endorse_skills`.
  - Company, event and group actions: `follow_company`, `like_company_post`, `invite_to_follow_company`, `invite_to_event`, `invite_to_group`, `group_message`, `event_message`.
  - Human-task steps: `manual_message`, `manual_comment`.
  - Flow control: `wait`, `condition`, `monitor`, `end`.
  - Email steps: `email`, `find_email`.
  - Tagging: `add_tag`, `remove_tag`.
- Every browser action maps to a ledger kind (`runner.ts:222-259`) and a driver method (`driver.ts:2641-2666`).
- Delays use `workflowDelaySchema`: `amount` int 0–2160, `unit` `'hours'|'days'`, on every step (verified, `workflows.ts:65-71`). They are applied in `transitionMember`/`advanceMember` (`runner.ts:2465-2519`).
- Conditions: `connected`, `accepted`, `replied`, `open_profile`, `email_available`, `email_opened`, `email_clicked`, `email_bounced`, `email_replied`, `email_found` (verified, `workflows.ts:109-121`).
  - `condition` is evaluated once. `monitor` polls every 5–1440 minutes (default 60) until a timeout, then takes No (`runner.ts:1686-1862`).
  - `connected` and `open_profile` file a real `profile_view` probe (`runner.ts:649-757`).
- Graph validation: forward-only edges, every step reachable, `withdraw_pending` must follow an invite, unsupported variables rejected (`workflows.ts:404-558`).
- Stop-on-reply is WIRED but not configurable.
  - `repliedProfiles` and the stop are at `runner.ts:506-527,1584-1617`.
  - An email reply or unsubscribe ends the member (verified, `campaign-channels.ts:950`).
  - Stale queued actions are retired before execution (`local-worker.ts:1215-1237`).
- Withdraw-if-unaccepted-after-X-days is WIRED (`runner.ts:1942-1968,2619-2659` → `withdraw.ts`).

**A/B, variables, templates**

- A/B testing is WIRED.
  - `MESSAGE_VARIANT_MAX = 4`; weights int 1–100, default 50 (verified, `workflows.ts:95-107`).
  - Variants are available on connection_request, message, inmail, group/event message and email.
  - Assignment is seeded: sha256 of `member.id:step.id` (`workflows.ts:900-918`). The choice is persisted in `assigned_variants` and as `variant_id` on `linkedin_actions` (`runner.ts:2244-2276`).
  - Per-variant results show reply rate with a 20-send minimum before a leader is named (`LinkedInManagerRead.tsx:126,1901-2042`). There is no significance test and no auto-promotion of a winner.
- Merge variables: `first_name`, `last_name`, `company`, `email`, `phone`, `country`, `booking_link`, plus camelCase aliases and `{{custom.field}}` from unmapped CSV columns (`workflows.ts:25-57`; `lead-import.ts:405-437`). Rendering is in `renderWorkflowTemplate` (`workflows.ts:864-886`).
- Starter workflows in the UI: warm-connect-followup, connect-first, warm-human, multichannel-fallback (`LinkedInManagerWorkflowConfig.tsx:777-1175`).
- The server default sequence is view → invite → wait 3d → message → wait 7d → follow-up → end (`src/server/outreach/prepare.ts:23-90`). It is created as a DRAFT by `POST /api/outreach/prepare` (verified route at `app.ts:4248`).

**Campaign lifecycle**

- Create, start/resume, pause and stop are WIRED (verified routes `app.ts:6147`, `:6500`, `:6542`, `:6581`).
  - Pause parks unclaimed planned rows as `held`, and resume restores them (migration `051`; `managed-campaigns.ts:1616-1639`).
  - Stop marks members `removed` and planned/held actions `skipped` (`managed-campaigns.ts:1641-1683`).
  - Start is behind a `ConfirmDrawer` (`LinkedInManagerRead.tsx:3940`).
- Per-member operations are WIRED (`app.ts:6609-6903`): pause and resume, skip, end, move between campaigns, re-run a condition, resume at a step, retry failures, duplicate campaign.
- Lead-in-one-campaign exclusivity is DB-enforced. Partial unique index `idx_linkedin_campaign_members_one_active` on `(workspace_id, contact_id)` while the member is live (`migrations/046_linkedin_outreach_manager.sql:77-79`).
- Newly imported contacts auto-enrol into running campaigns every tick (`managed-campaigns.ts:1191-1236`, from `runner.ts:1288-1303`).
- Workflow snapshot semantics: a campaign runs the snapshot taken at create, plus a per-member snapshot at admission (migration `088`; `managed-campaigns.ts:834-839,1450-1451`). "Apply latest workflow" is explicit (`managed-campaigns.ts:2932-2974`).
- Waves and admission are WIRED. Policy fields: `maxNewLeadsPerDay`, `maxWaveSize` (hard cap 250), `minWaveIntervalMinutes`, `maxInSequence`, outcome throttle (`admission.ts:1-255`; migration `086`).
- Multi-sender rotation: `sender_keys_json` rotates sending seats, capacity-weighted, with a sticky `assigned_seat_key` (`managed-campaigns.ts:1353-1486`).
- Fairness across campaigns sharing a seat (`allocateCampaignCapacity` `runner.ts:897-942`; migration `092`). Step SLA with priority boost (`runner.ts:795-837`; migration `091`).
- Team controls: campaign owner, seat owner, workspace vs personal workflows (migration `089`; `app.ts:9097-9188`).
- "Run now" — PARTIAL. The route `POST /api/linkedin/manager/tick` exists (verified, `app.ts:7089`), but `tickLinkedInManagedCampaigns` (`src/client/api.ts:2938`) has no UI caller (verified by `rg`).

**Analytics**

- Per-campaign counters (`managedAnalytics` `managed-campaigns.ts:3860-4074`; route verified `app.ts:7099`): invites sent, accepted, acceptance rate, messages, views, follows, withdrawals, replied, reply rate, variants. Filters: campaign, seat, `sinceDays`.
- Operational analytics: funnel, waves, step SLA and latency, sender share, bottlenecks (`managed-campaigns.ts:4228-4739`).
- Defect: email replies never counted (verified). Analytics SQL filters `ee.event_kind='replied'` (`managed-campaigns.ts:4410,4546`), but the writer stores `'reply'` (`campaign-channels.ts:950`; route enum `app.ts:7020`).
- Defect: email sends never count as "messaged" (verified). The funnel filters `ca.status='completed'` (`managed-campaigns.ts:4404`), but channel actions settle as `status='sent'` (`campaign-channels.ts:580`).
- Defect: email reply/bounce conditions never fire (verified). The executor writes branch state `external:email_${eventKind}` (`campaign-channels.ts:919-921`), producing `external:email_reply` and `external:email_bounce`. The evaluator reads `branchState[\`external:${condition.kind}\`]` (`runner.ts:753`), i.e. `external:email_replied`/`external:email_bounced`.
  - So an `email_bounced` or `email_replied` condition never resolves Yes; a monitor times out to No.
  - `email_opened` and `email_clicked` match.

**Playbooks and legacy paths**

- Playbook step types are only `skill | approval | action` (verified, `src/server/playbooks/types.ts:12-39`). `needs` is a static DAG, and the only time element is the retry `delaySeconds` (`engine.ts:644-702`).
- Playbooks are 8 built-ins, all GTM (`playbooks/registry.ts:11-707`):
  - `gtm.audit-led-outreach@1.0.0` (registered, no caller — STUB);
  - `gtm.community-outreach`, `gtm.thread-reply`;
  - `gtm.qualified-demand-email`, `gtm.conversation-email-reply`;
  - `gtm.email-outreach@1.0.0/1.1.0`;
  - `gtm.buffer-draft`.
    None executes LinkedIn actions.
- The legacy LinkedIn "sequence → approve → export to Dripify/HeyReach CSV" path was removed.
  - `docs/core-product.md:210` says: "Dripify/HeyReach/Expandi CSV export — **removed**".
  - `templates.ts` and some `app.ts:372-376,416` imports are dead leftovers.
  - The current campaign CSV export is a results export (`managed-campaigns.ts:3297-3362`).

### Inferences

- On sequence-building features, Trevra meets or exceeds Dripify: graph branching, monitors, waves, multi-sender rotation, SLA, per-member snapshots. The gaps are A/B statistics, configurable stop-on-reply, and the email-event bugs above.
- Calling it a "playbook" in comparisons would be misleading. The cadence engine is the LinkedIn workflow runner, not `src/server/playbooks`.

### Gaps

- The consumption of `linkedin_lead_signals` (migration `090`) by the runner was not traced.
- The tests may not cover the email key mismatches. No test was found by the sweep, but that is not exhaustive.

## 3. Email outreach

### Takeaway

There are two separate email paths.

The first is a single-touch "email outreach" first touch. It is approval-gated per recipient through the playbook engine, and it has:

- deliverability gates (SPF, DKIM, DMARC);
- a compliance footer;
- RFC 8058 List-Unsubscribe;
- a lawful-basis check.

The second is an `email` step inside a LinkedIn campaign workflow. It is multi-step, A/B, with open and click tracking and reply/bounce polling. It is gated only by campaign start, and it skips the deliverability gate, the List-Unsubscribe header and the footer.

Providers are Gmail, Microsoft 365 and Zoho Mail via Nango. There is no email warm-up.

### Cited Findings

- Providers are Gmail API, Microsoft Graph and Zoho Mail, through Nango in `executeConnectedAction` (`src/server/integration-service.ts:647-1085`; `src/server/email/zoho-mail.ts`). SMTP (`src/server/email.ts`) is system mail only. No Resend, SendGrid or Mailgun.
- First-touch path, WIRED:
  - Flow: `POST /api/gtm/plan` → `POST /api/gtm/prepare` (`app.ts:4087,4107`) → `prepareEmailOutreach` (`src/server/email/outreach.ts:436-643`) → one `gtm.email-outreach@1.1.0` run per person (`playbooks/registry.ts:571-647`) → approval in `/ledger` → `email.send` adapter.
  - The body is a fixed template plus the footer (`outreach.ts:289-305,595`).
  - It is single-touch, and already-contacted recipients are skipped (`outreach.ts:410-420,566-580`).
  - Exactly one connected mailbox; max 200 runs per preparation (lc-debt, `outreach.ts:119-127,229-230`).
- Campaign `email` step, WIRED:
  - Schema: subject, variants, threading, tracking `off|opens|opens_clicks` (`workflows.ts:329-342`).
  - Planned into `linkedin_campaign_channel_actions` with idempotency key sha256(ws:campaign:member:step) (`runner.ts:1997-2149`).
  - Executed by `executeEmail` (`campaign-channels.ts:290-361`) from the campaign tick (`runner.ts:593`).
  - Mailbox timezone, working days and daily limit (`campaign-channels.ts:217-288`).
  - Gmail and Outlook only; Zoho excluded (`campaign-channels.ts:1191`).
- Open and click tracking are WIRED for campaign email only (verified).
  - Pixel `<img src="${origin}/t/e/${token}/open.gif" ...>` is injected (`campaign-channels.ts:163`), and links are rewritten to `/t/e/:token/c/:linkToken` (`campaign-channels.ts:149`).
  - Served at `app.ts:707-731`. Requires a public HTTPS origin (`campaign-channels.ts:93-99`).
  - UI copy contradicts the code. `LinkedInManagerWorkflowConfig.tsx:2929-2933` says "Trevra does not inject a tracking pixel or rewrite links here" (verified).
- Reply and bounce detection:
  - Campaign email: polls provider threads every 10 minutes for 30 days (`campaign-channels.ts:1056-1166`). A signed webhook `POST /api/webhooks/linkedin-campaign-email` (verified, `app.ts:813`) also accepts events.
  - First-touch path: one designated inbound mailbox via Nango sync `inbound-messages` (`src/server/email/inbound-mailbox.ts:90-232`; `nango-integrations/*/syncs/inbound-messages.ts`).
- Reply classification is regex, not AI: reply / unsubscribe / bounce / delivery_failure / out_of_office / auto_reply / unknown (`src/server/email-outcomes.ts:34-85`).
- Unsubscribe is WIRED for the first-touch path. RFC 8058 List-Unsubscribe plus Post, with an HMAC token (`src/server/email/unsubscribe.ts:1-90`). `GET /u/:token` confirms and `POST` suppresses (`app.ts:761-797`). Zoho uses a reply-"unsubscribe" footer instead (`email/unsubscribe-policy.ts:6-95`).
- Campaign sends get no List-Unsubscribe header (verified). `integration-service.ts:815-818` reads "Every other send, campaign and legacy outreach included, keeps its pre-Phase-D path: no List-Unsubscribe header".
- SPF/DKIM/DMARC checks are WIRED for the first-touch path only (`email/deliverability.ts:567`; migration `133`; worker recheck `worker/index.ts:305-322`; blockers `outreach.ts:146-173`).
- Caps:
  - Default 50 sends per 24h; per-mailbox 1–500; Zoho hard 50 (`email-deliveries.ts:189-220`; `zoho-mail.ts:23`).
  - Replies are exempt (`email-deliveries.ts:263-264`).
  - Email warm-up ramp is ABSENT (no warm-up code in `src/server/email*`).
- Idempotency: `gtm_deliveries` is unique on `(workspace_id, idempotency_key)` and `(workspace_id, source_type, source_id)` (migration `108:28-29`; `email-deliveries.ts:70-130`). An unknown outcome is held for a human (`campaign-channels.ts:753-825`).
- `find_email` workflow step — STUB in a stock deployment. Without `TREVRA_EMAIL_ENRICHMENT_URL` it returns `externalRef: 'email:not-found'` (verified, `campaign-channels.ts:424-431`). Hunter is not wired to it.

### Inferences

- For a Dripify comparison, the relevant path is the campaign `email` step: multichannel LinkedIn → email fallback is WIRED. It carries compliance gaps the first-touch path does not have: no footer, no List-Unsubscribe, no deliverability gate. Its email-event analytics and conditions are buggy (section 2).

### Gaps

- Real-world deliverability or tracking accuracy cannot be judged from code.

## 4. Inbox

### Takeaway

`/outreach/inbox` is WIRED and has two tabs:

- a per-seat **LinkedIn inbox**: synced threads, a reply composer with queue state, and manual-task items;
- a cross-channel **Conversations** view: a person-centric transcript over LinkedIn and email.

Replies from the tool are possible on both channels. LinkedIn replies are queued and paced; email replies are approval-gated.

There are no labels, tags, notes, assignment, or AI/sentiment classification, and search is client-side only.

### Cited Findings

- Route `outreach: ['', 'new', 'campaign', 'workflow', 'inbound', 'inbox', 'opportunities', 'posts']` (verified, `src/client/ui/route.ts:42`). Rendered by `OutreachView` (`src/client/views/OutreachView.tsx:141,231-258`): "Conversations" = `SharedConversations.tsx`, "LinkedIn inbox" = `LinkedInInbox.tsx`.
- LinkedIn threads are stored per seat (migration `031`), linked to campaigns by matching `profile_url` (`inbox.ts`).
- The worker syncs 3 threads / 10 messages per pass, widening to 10 / 20 after a gap over 3 days (`jobs.ts:1410-1431`; `worker/index.ts:226-232`).
- Manual sync: `POST /api/linkedin/inbox/sync` (verified, `app.ts:7651`). It returns 409 when no browser is available.
- LinkedIn reply flow, WIRED:
  - `LinkedInInbox.tsx:757` → `api.ts:3312` → `POST /api/linkedin/inbox/threads/:threadUrn/reply` (`app.ts:7697`) → `enqueueReply` (`inbox.ts:1206+`).
  - `enqueueReply` runs the Never-contact check (`inbox.ts:1245`) and the safety gate.
  - The composer shows Waiting / Sending / Delivered / Held, supports scheduling, and can edit or skip a queued message (`LinkedInInbox.tsx:119-135,837,857`).
- Email reply flow, WIRED, approval-gated: `SharedConversations.tsx:151-210` → `POST /api/conversations/:id/replies/prepare` (`app.ts:4223-4246`) → `gtm.conversation-email-reply` playbook (`playbooks/registry.ts:436-496`). Zoho is refused (`conversation-replies.ts:176-181`).
- Manual-message tasks from campaign steps are WIRED in the inbox: composer, "queue this message" vs "mark as sent" (`LinkedInInbox.tsx:362-383,792-796` → `GET/POST /api/linkedin/manager/tasks`, verified `app.ts:7065`).
- Classification: LinkedIn replies get none, only `hasReply` / `unread` flags (`inbox.ts:76-96`). Email gets the regex classes above.
- Labels, tags, notes and assignment are ABSENT. There are no columns in migrations `031`/`103`, no routes and no UI. Lead tags exist only via the `add_tag`/`remove_tag` workflow steps (`runner.ts:1970-1995`), and the inbox does not show them.
- Filters:
  - LinkedIn tab, server side: unread, hasReply, campaign, seat (`inbox.ts:932-987`). Search is client-side over a loaded page: 100 per page, 500 max, no total (`LinkedInInbox.tsx:83-117,395-396`).
  - Conversations tab: newest 100 with a "Needs reply" pill (`conversations.ts:624`).

### Inferences

- Dripify's unified inbox is matched on read and reply. Trevra lacks Dripify-style CRM affordances in the inbox: labels, notes, assignment, and full-history search.

### Gaps

- None material.

## 5. Lead and prospect management

### Takeaway

WIRED lead intake paths:

- CSV import with a column mapper, auto-match and a name scrubber;
- pasted LinkedIn profile URLs (up to 10,000 per call);
- signed inbound lead-capture webhooks;
- account/company import.

Dedup is workspace-wide. Suppressions are enforced on every send path.

The Dripify-signature sources (LinkedIn search, Sales Navigator, arbitrary post engagers) are hard-disabled. Email enrichment is Hunter domain search only and does not flow into lead lists. Lead-list deletion has a route but no button. The LinkedIn "Never contact" list is not read by campaign enrolment.

### Cited Findings

- CSV import is WIRED. Flow: `LinkedInManagerLeadConfig.tsx:63-73,476` → `POST /api/linkedin/manager/lead-lists/preview` and `/:id/import` (verified, `app.ts:7108,7150`) → `parseLeadCsv` (`lead-import.ts:537-583`) → `importLeadCsv` (`lead-lists.ts:718-769`).
  - Auto-match with exact or guessed confidence (`lead-import.ts:139-237`), with a UI override.
  - Unmapped columns become custom variables (`lead-import.ts:405-437`). 2 MB client cap.
  - First name, last name and company are required (`lead-import.ts:451-456`).
- Pasted profile URLs are WIRED (`importLeadProfileUrls` `lead-lists.ts:654-716`). They are stored with empty name and company fields, so merge fields render blank (inference).
- Name scrubber is WIRED: titles, degrees and emoji by whole token, and it never scrubs a name to empty (`lead-import.ts:296-364`).
- Dedup is WIRED.
  - Workspace-wide unique `LOWER(profile_url)` (migration `048:213-215`) and `dedupe_key` (migration `052:166-167`).
  - A many-to-many list membership table (migration `052`).
  - A canonical Person spine with unique email, phone and LinkedIn URL (migrations `098`, `099`).
- Lead lists:
  - Create, read and contact edit/delete are WIRED (`app.ts:7188-7209,6073-6112,7326-7356`).
  - Rename is ABSENT.
  - Delete is PARTIAL. The route is owner-only and refuses while a running campaign uses the list (`app.ts:7302-7324`; `lead-lists.ts:1200-1296`). `deleteLeadList` (`src/client/api.ts:2032`) has no UI caller (verified by `rg`).
- Daily lead cap for scraping: `DEFAULT_DAILY_LEAD_CAP = 25`, `MAX_DAILY_LEAD_CAP = 100` (verified, `leads.ts:734-735`). The UI accepts 0–1000 (`LinkedInLeads.tsx:420-426`), so 101–1000 fails server-side. This contradicts `DRIPIFY_PARITY.md:98` ("default 100, 0–1000"). It is moot while scraping is disabled.
- Suppressions are WIRED for enforcement.
  - Scope: person, email, email domain, LinkedIn URL; channel `all|email|linkedin|community` (migration `101:7-56`).
  - Enforced by the LinkedIn guard `suppression` check (`guard.ts:488-501`), every email send (`integration-service.ts:661`), and campaign eligibility (`managed-campaigns.ts:969-979`).
  - Auto-created from unsubscribes, hard bounces and do-not-contact.
  - The only UI is a per-person "Not a lead" control (`InboundPeople.tsx:322-352`). There is no UI to add a domain, email or URL suppression (PARTIAL).
- Per-campaign exclusion policy is WIRED: suppressed companies and email domains, excluded lists, contacted-lookback days, existing conversation, known connection (`managed-campaigns.ts:124-135,933-1110`).
- The "Never contact" list (`linkedin_exclusions`) is PARTIAL (verified).
  - Readers are only `leads.ts:932` (harvest), `inbox.ts:1245` (reply) and `app.ts:7903` (manual engagement).
  - It is not read by `managed-campaigns.ts`, `runner.ts` or `local-worker.ts`.
  - It is add-only, one LinkedIn URL per row (`exclusions.ts:25-29,70-73`).
- Enrichment is PARTIAL.
  - Hunter, bring-your-own key, is the only provider (`enrichment/provider.ts:11`). It runs domain search plus verification, with a credit ledger (migration `137`).
  - Run from the planner objective "Find contacts (Hunter)" → approval → worker (`worker/index.ts:323-342`; `enrichment/runs.ts:784-855`).
  - Results become People linked to Accounts and are not added to lead lists (`runs.ts:538-543`).
  - There is no per-person name+company finder.
- Inbound lead capture is WIRED: HMAC-signed `POST /api/intake/v1/submissions`, idempotency keys, 120/min rate limit, consent capture (`lead-capture/http.ts:143-186`; `submissions.ts:73-272`).
- Accounts (companies) are WIRED: paste or CSV import, provider sourcing (seed, directory, exa; Apollo withheld by decision) (`app.ts:8243-8398`; `research/registry.ts:35-60`).
- Consent and lawful basis are PARTIAL: tracked per person and channel (migration `134:49-72`), enforced on campaign email (`campaign-channels.ts:301-316`) and in the playbook policy (`policy.ts:43-57`). There is no client UI to record or inspect it.

### Inferences

- Lead sourcing is Trevra's biggest functional gap versus Dripify. Dripify's core onboarding is "paste a LinkedIn or Sales Navigator search URL". Trevra has the scraper but refuses the action by product decision (see `DISABLED_LINKEDIN_LEAD_SOURCING_REASON`, `app.ts:9737-9738`).

### Gaps

- Whether CSV, URL-paste and capture imports are subject to any daily cap was not confirmed. The sweep found none (`importLeadCsv` has no cap check).

## 6. Personalization and AI

### Takeaway

No LLM writes any outreach copy in product code. LinkedIn messages, first-touch email and community replies are deterministic templates with merge variables. A deterministic "anti-slop" critic reports problems but does not block. The only outreach-adjacent LLM code (campaign-brief suggestion) has no production caller. Reply classification is regex.

### Cited Findings

- `suggestBriefFields` (`src/server/linkedin/brief-suggest.ts:97`) has no non-test caller (verified). `rg "brief-suggest|suggestBriefFields"` outside tests finds only the definition.
  - Agent sweeps disagreed here: one called it WIRED; the code shows it unreachable.
  - It would suggest ICP and offer fields, not message copy, via a BYOK model or a CLI fallback (`brief-suggest.ts:100-130`).
- The `gtm.outreach-draft` skill has an LLM `drafter` hook that no caller supplies, so its generator is always `'template'` (`src/server/skills/draft.ts:154-239,296`).
- `buildSequence` is deterministic (`src/server/linkedin/sequence.ts:490`). Default campaign copy is static `{{first_name}}`/`{{company}}` templates (`src/server/outreach/prepare.ts:42-77`).
- Copy critic `src/server/skills/voice.ts`: banned phrases, a substitution test, about a 90-word ceiling. It is used by the LinkedIn sequence (`sequence.ts:3,23-28`) and by replies. A failure is reported, not blocked.
- The BYOK hosted agent is WIRED but cannot send.
  - It uses an OpenAI-compatible endpoint (`src/server/agent/provider.ts:20,68-92`) and a `generateText` loop (`agent/loop.ts:34,262`).
  - It can start approval-gated playbooks. It has no approve, execute or send tool (`agent/tools.ts:11-28,221-251`).
- The internal plan defers "AI-assisted personalization draft at setup" (`docs/superpowers/plans/2026-08-20-linkedin-campaign-waves-market-parity.md:905`).

### Inferences

- Dripify's AI message writer has no Trevra equivalent today. Personalization is variable substitution plus custom CSV columns, which Dripify's built-in tokens do not offer per `docs/core-product.md:111` (internal claim, unverified externally).

### Gaps

- Not established whether research or brand-watch code calls an LLM. It is believed network-read only; not opened.

## 7. Safety and control: limits, policy, approvals, idempotency, execution adapters

### Takeaway

**LinkedIn safety.** LinkedIn has its own deterministic 16-check safety gate. It re-runs before every send and enforces:

- researched per-kind daily and weekly bands;
- account warm-up and a 20/40/60/80/100% campaign ramp;
- rolling 24h/7d/30d windows and a day-over-day delta cap;
- an acceptance-rate floor and a pending-invite backlog cap;
- working hours and weekends;
- duplicate-target and suppression checks.

Around the gate:

- seeded pacing;
- seat leases;
- checkpoint and limit-wall cooldown;
- an idempotent action ledger.

There is deliberately no typing, mouse or dwell humanisation, and no per-seat user-agent fingerprint. LinkedIn actions do not go through the control-plane payload-hash approval. Approval is campaign start, plus optional human-send mode.

**Control plane.** The control-plane adapters are a closed set of four: `email.send`, `community.reply`, `crm.log-activity`, `buffer.create-draft`.

### Cited Findings

**LinkedIn gate and limits**

- Gate checks, `LINKEDIN_CHECK_NAMES` (verified, `src/server/linkedin/guard.ts:57-93`): `seat-configured`, `seat-paused`, `suppression`, `warmup-ceiling`, `campaign-warmup`, `rolling-24h`, `rolling-7d`, `rolling-30d`, `day-over-day-delta`, `acceptance-rate`, `business-hours`, `weekend`, `inmail-monthly-quota`, `pending-invite-backlog`, `duplicate-target`, `linked-identity`.
- `evaluateLinkedInSafety` is at `guard.ts:616-1100`. Callers: the send re-gate (`local-worker.ts:1294-1334`), the planner, `enqueueReply` and the withdraw gate.
- Default bands, `LINKEDIN_LIMITS` (verified, `src/server/linkedin/limits.ts:164-188`), warmup → steady:
  - invite: 10/day, 20/week → 18/day, 90/week
  - dm: 4/10 → 12/60
  - reply: 2/10 → 12/60
  - inmail: 1 → 3 per day, 50/month
  - profile_view: 30 → 45
  - follow / unfollow / disconnect / company_follow: 16 → 20
  - like / company_like: 10 → 30
  - endorse: 3 → 8
  - group/event invites mirror invite; group/event messages mirror dm
- Other constants (`limits.ts:211-426`):
  - `MAX_OUTSTANDING_INVITES=100`
  - `MAX_DAY_OVER_DAY_DELTA=0.35`
  - `MIN_ACCEPTANCE_RATE=0.3`
  - business hours 8–18
  - `ACTION_GAP_SECONDS` 120–180
  - `WEEKEND_FACTOR=0`
- Operator overrides, per seat, off by default (migrations `050`, `109`, `127`; `limits.ts:468,509`; `seats.ts:836-1000`):
  - `safetyBandOverride` makes the operator's own limits bind. Ranges: invites 0–100, messages up to 75, views up to 150, follows up to 50.
  - `warmupOverride` turns off the account warm-up.
- Campaign warm-up ramp: days 1..5 → 0.2..1.0 (`managed-campaigns.ts:624-640`; gate `guard.ts:818-837`).
- Pacing: mulberry32 seeded PRNG, with no `Math.random()` (`pacing.ts:379-404`).
  - Day-shape jitter (`pacing.ts:309-334`).
  - Session action budgets and 3–8 minute breaks (`local-worker.ts:12-20,711-718`).
  - The send-time gap is `actionGapSeconds` (`local-worker.ts:837`).
  - The planner slot gap is a fixed 120–180s (`runner.ts:414-433`).
- Humanisation is ABSENT by design. `human.ts` states "they do not add synthetic mouse movement, typing cadence, or random dwell time". `typeLike` is one `locator.fill` (verified, `src/server/linkedin/human.ts:1-68`).
- Fingerprint is ABSENT. `seatContextFingerprint` returns `userAgent: null, locale: null, viewport: null` and only a timezone (verified, `local-worker.ts:3839-3851`).
  - The Companion relies on the member's real Chrome instead.
  - `docs/linkedin-unusual-activity-2026-08-14.md:60-72` attributes an earlier LinkedIn flag to a headless-shell UA/Client-Hints mismatch.
- Checkpoint and limit-wall handling: the seat goes to `cooldown` (`local-worker.ts:1503-1513,2578`).
  - Session-lost handling (`local-worker.ts:1551-1573`).
  - Selector-drift halt threshold (`local-worker.ts:674,1627-1689`).
  - An unknown outcome holds the claim with no auto-retry (`local-worker.ts:1691-1697`).
- Credentials: AES-256-GCM, per-workspace HKDF, with AAD bound to the seat (`src/server/secrets/crypto.ts`; `src/server/secrets/linkedin.ts`; `linkedin_seat_credentials` migration `028`). Login, OTP and challenge flow: `local-worker.ts:4572-4815`, route `app.ts:5506`.
- Multi-account seats are WIRED with per-seat limits, hours, proxy, session, cooldown and leases (`seats.ts`; `local-worker.ts:3005,3361`; migrations `022`, `045`, `054`). No per-workspace seat-count cap was found in code.
- Idempotency on LinkedIn: a unique partial index on `(workspace, seat, kind, target_ref, replay_scope)` where `status<>'skipped'` (migration `047`). Claims use `FOR UPDATE SKIP LOCKED` with leases (`local-worker.ts:2138-2216`).
- Gap: there is no live check before a send that the signed-in LinkedIn identity matches the seat. `linked-identity` is a ledger fact (inference from `local-worker.ts:1294-1366`).

**Control-plane execution adapters**

- `EXECUTION_ACTION_TYPES = ['email.send','community.reply','crm.log-activity','buffer.create-draft']`, and arbitrary names are rejected (verified, `src/server/control-plane/execution.ts:20-31`).
  - `email.send` writes to Gmail, Graph or Zoho via Nango. Idempotency key is the payload hash. Re-checks at send: mailbox, footer, suppression, inbound sync (`execution.ts:51-134,223-371`).
  - `community.reply` auto-posts only to the GitHub issue-comments API and Mastodon. Other platforms create a `manual_handoff` (`src/server/outreach/publish.ts:190-232,338-355`).
  - `buffer.create-draft` writes a Buffer draft, single attempt (`execution.ts:153-157`; `content/buffer.ts:203`).
  - `crm.log-activity` writes to HubSpot or Attio. No playbook uses it directly; it runs only as a mirror after `community.reply` (`execution.ts:159-206`).
- Payload hashing is sha256 over key-sorted JSON (`control-plane/payload.ts:3-16`).
  - It is re-checked at execute time: the approval step's hash and a `playbook_approvals` approve row must both match (`playbooks/engine.ts:567-601`).
  - The approver can edit the body before approval, which re-hashes it (`engine.ts:351-428`; `app.ts:2118-2135`).
- Policy (`control-plane/policy.ts:43-225`):
  - A lawful-basis deny is evaluated first.
  - Then workspace rules: glob `action_pattern`, conditions on actor/side-effect/playbook/skill/env/minConfidence/maxRecipients.
  - Default `require_approval` for external writes.
  - It has no send caps or time windows.
  - It is evaluated only in the playbook engine, not for LinkedIn runner actions or campaign email (`rg evaluatePolicy(`).
- External writes that bypass the 4-adapter boundary:
  - LinkedIn actions run through their own worker and gate.
  - Campaign email calls `executeConnectedAction` directly (`campaign-channels.ts:290-361`).
  - `POST /api/reddit/comment` is self-hosted, operator-initiated, with no approval and no cap; its comment reads "NO QUEUE AND NO APPROVAL STEP" (`app.ts:8184-8224`).
- `src/server/action-service.ts` (legacy prepare/approve/execute) is dead code. No non-test importer exists; it is cited only in comments.

### Inferences

- **Conflict with AGENTS.md wording.** LinkedIn sends and campaign emails are external writes executed without a per-action prepared payload hash. The boundary they keep is deterministic gating plus campaign-level human start. This is arguably consistent with "deterministic software controls ... external execution", because no model is in the loop. It does not match the stricter "prepared-action adapter and approval/execution boundary" pattern used for `email.send`. A parity report should state this precisely rather than claim uniform per-message approval.
- Trevra's default LinkedIn ceilings (18 invites/day steady, 90/week) are stricter than Dripify-style defaults. Raising them needs the explicit per-seat override.

### Gaps

- Live effectiveness of the safety gate (ban rates) is not knowable from code.

## 8. Automation and scheduling

### Takeaway

One standalone worker (`src/worker/index.ts`) ticks every `AUTOMATION_INTERVAL_MS` (default 60s). On each tick it:

- runs the LinkedIn send queue;
- runs per-seat side tasks (inbox sync, withdrawals);
- runs the per-workspace campaign planner, including campaign email and its reply/bounce polling;
- advances playbooks;
- runs agent schedules;
- refreshes deliverability rechecks;
- drains enrichment.

Temporal is optional and used only to advance playbooks. The default is PostgreSQL with advisory locks and leases.

### Cited Findings

- `linkedinCycle` runs only `if (... runtime.linkedinLocalWorker.enabled)`. Steps in order (verified, `src/worker/index.ts:179-272`):
  1. `runPendingSeatDetectRequests`
  2. `runDueLinkedInActions`
  3. `runLinkedInSideTasks` per seat, rotated
  4. `runLinkedInCampaignTick` and `runLinkedInPostTick` per workspace, up to 50 per tick, behind the hosted `allowSeat` filter
     It runs once at boot and then on `setInterval(..., runtime.automationIntervalMs)`.
- The campaign tick (`linkedin/jobs.ts:1757-1771` → `runner.ts:556-595`):
  - `syncCampaignEmailProviderEvents`;
  - advisory-locked `planManagedCampaigns`;
  - `runCampaignChannelActions` (email, find_email).
- The general `cycle()` (`worker/index.ts:124-150`):
  - `runAllAutomationCycles` (`automation-service.ts:232-312`);
  - `runReadyPlaybooks`;
  - `runDueAgentSchedules`;
  - `runDueResearchSources`;
  - `runDueBrandWatches`.
    Plus `emailDeliverabilityCycle` (`:305-322`) and `enrichmentCycle` (`:328-342`).
- Orchestrator selection: `TREVRA_ORCHESTRATOR` is `postgres` (default) or `temporal` (`src/server/orchestration/client.ts:6-8`).
  - The Temporal workflow `playbookOrchestratorWorkflow` loops `advancePlaybook` and waits for a `resumePlaybook` signal on approval (`orchestration/workflows.ts:21-34`).
  - The playbook lease is 60s, with stale-step recovery (`engine.ts:29,998-1008`).
- Agent schedules: opt-in (`enabled` defaults false), 15–10,080 minute intervals, atomic claim (`agent/schedule.ts:49-82,210-311`).
- Market Pulse content schedules create LinkedIn post drafts only (`content/pulse-schedule.ts:60,185`).
- There is no timer for first-touch email. It sends inline on approval or on retry via `runReadyPlaybooks` (`engine.ts:348`).

### Inferences

- Execution throughput for LinkedIn depends on worker uptime and, for Companion users, on the member's computer being online. Companion presence gates eligibility (`hosted-execution.ts:298-318`).

### Gaps

- None material.

## 9. Internal docs on outreach: reliability vs code, and overall status map

### Takeaway

`DRIPIFY_PARITY.md` (commit `83d092f`, "Audited 2026-08-14") claims full Dripify parity across 10 areas. Most of its sequence and limit claims match code. Several claims are now wrong:

- lead sourcing from search and Sales Navigator is now disabled;
- per-account UA/locale fingerprint and human-cadence typing were removed;
- the daily lead cap numbers differ.

`docs/core-product.md` §3.5 is stale. It predates the managed runner.

### Cited Findings

- `DRIPIFY_PARITY.md:46-47` claims search links and Sales Navigator links are DONE. The current route always returns 409 (section 1, verified).
- `DRIPIFY_PARITY.md:22` claims a "deterministic per-account userAgent/locale/timezone (`seatContextFingerprint`)" and "human-cadence credential typing". Current code returns null UA and locale, and `human.ts` disclaims typing cadence (verified).
- `DRIPIFY_PARITY.md:98` claims a daily lead cap of "default 100, 0–1000". Code has default 25, max 100 (verified).
- `DRIPIFY_PARITY.md:254` says "Deleting a lead LIST has no route". A route now exists (`app.ts:7302-7324`, from migration `053`), but there is still no UI button.
- `DRIPIFY_PARITY.md:249` says replies execute "on the operator's own machine via the local worker" as a deliberate position. This still holds in substance via the Companion, though the in-repo `npm run linkedin:worker` CLI is now dead (section 1).
- `docs/core-product.md:101-150` says "No API path queues an invite or a DM as `planned`". This is false today: `runner.ts` plans them. It also states the decision "**replace Dripify**" and names selector rot and §8.2 ToS exposure as the honest costs (`core-product.md:145-150`).
- `docs/linkedin-companion.md:5` says "headless", but the code runs headed-minimized (verified, section 1). `docs/hosted-execution.md` (~27-28) still references a "signed-in Trevra tab".
- `docs/control-plane-architecture.md:20-62` lists invoice/change_order/revenue playbooks that do not exist (`playbooks/registry.ts:8`: GTM-only).

### Status map, Dripify feature area → Trevra (code as of a79cf55)

- Cloud-run LinkedIn automation, no local machine: **PARTIAL**. Companion on the member's computer is WIRED. The remote cloud browser is opt-in, needs consent and a proxy, and is unproven. The server never launches a browser.
- Connect ± note, message, view profile, follow, like, InMail, withdraw: **WIRED**.
- Endorse skills: **PARTIAL** (1 skill per action).
- Comment automation: **ABSENT** (manual task only).
- Voice messages: **STUB**.
- Email step in campaign: **WIRED**, with compliance gaps.
- Find email in campaign: **STUB** without a deployment-specific endpoint.
- Delays, if/else (connected/accepted/replied/open profile), stop on reply, start/pause/stop, one-campaign-per-lead: **WIRED**.
- Email-reply/bounce conditions: **broken** (key mismatch).
- A/B: **WIRED** assignment, **PARTIAL** stats.
- Lead import from LinkedIn search, Sales Navigator, post engagers: **STUB** (hard-disabled).
- CSV with mapping, profile-URL paste, dedup, scrubber: **WIRED**.
- Lead-list rename and delete UI: **ABSENT**.
- Blacklist: **PARTIAL**. Never-contact is not used by campaigns; suppressions have no domain-entry UI.
- Email finder/enrichment: **PARTIAL** (Hunter domain search, not into lists).
- Unified inbox and reply-from-tool: **WIRED**.
- Inbox labels, notes, assignment, AI classification: **ABSENT**.
- Safety limits, working hours, warm-up, randomised pacing: **WIRED**, stricter defaults than Dripify; override available.
- Humanised typing and fingerprint: **ABSENT** by design.
- Multiple LinkedIn accounts and sender rotation: **WIRED**.
- Campaign analytics: **WIRED** for LinkedIn. Email-reply and email-messaged counters are buggy.
- AI message writing: **ABSENT**.

### Inferences

- Internal parity docs overstate current parity on lead sourcing and anti-detection. A comparison should cite code, not `DRIPIFY_PARITY.md`.

### Gaps

- No runtime verification: no tests, app or live LinkedIn were run. Every WIRED label is static code-path tracing, not observed behaviour.
