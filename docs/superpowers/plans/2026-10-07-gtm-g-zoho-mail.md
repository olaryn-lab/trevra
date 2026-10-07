# Phase G: Zoho Mail as a Third Mailbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zoho Mail becomes a third sending and inbound mailbox next to Gmail and Microsoft 365. A founder connects it through self-hosted Nango's built-in `zoho-mail` OAuth2 provider. Approved outreach leaves through the Zoho Mail REST send API, under a deterministic low daily cap. Replies are read by a Nango sync into the existing inbound-mailbox pipeline. The sending domain's SPF and DKIM are checked against Zoho, using a DKIM selector the owner sets per domain.

**Architecture:**

- **Pure Zoho adapter.** A new module, `src/server/email/zoho-mail.ts`, holds account and folder selection, header parsing, send and Message-ID read-back. It takes a structural Nango client, so it never imports `integration-service.ts`.
- **The one unsubscribe exception.** `src/server/email/unsubscribe-policy.ts` holds the reviewer-visible policy. Gmail and Microsoft 365 outreach still require RFC 8058 `List-Unsubscribe`. Zoho outreach alone goes out without it, and its footer's opt-out line asks for a reply. `executeConnectedAction` enforces the policy before any delivery row exists.
- **Versioned outreach approval.** A new `gtm.email-outreach@1.1.0` carries `unsubscribeMode` and `requireListUnsubscribe` inside the hashed approval payload. `1.0.0` stays registered so in-flight runs resume unchanged.
- **Inbound mail.** It arrives through `nango-integrations/trevra-zoho-mail/syncs/inbound-messages.ts`, which emits the same `InboundEmailMessage` model as the Gmail and Microsoft syncs.
- **Unthreaded opt-out.** Zoho cannot thread a reply by `In-Reply-To`, and its Message-ID read-back can fail. So an unsubscribe reply that is unthreaded still suppresses the Person when the same mailbox sent them Zoho outreach.

**Tech Stack:** TypeScript ESM, Express, PostgreSQL (forward-only migration `136_*`), Vitest against a real PostgreSQL Testcontainer, `@nangohq/node` 0.71.2 proxy (`get`/`post`), Nango zero-YAML functions (`nango` CLI 0.71.2, `createSync`), React with `src/client/ui/primitives.tsx`.

**Spec:**

- The Phase G founder brief, whose decisions are reproduced verbatim under Global Constraints.
- `docs/superpowers/plans/2026-10-06-gtm-d-email-channel.md` (the email channel this extends).
- `.superpowers/sdd/2026-10-06-gtm-e-consent-and-linkedin-safety/overrides.md` (the post-E interfaces this is written against).
- `AGENTS.md`.
- Zoho Mail API (`/api/accounts`, `/api/accounts/{accountId}/messages`, `/messages/view`, `/folders`, `/folders/{folderId}/messages/{messageId}/header`, `/messages/{messageId}/originalmessage`).
- Nango `providers.yaml` entry `zoho-mail` (alias `zoho`, `proxy.base_url: https://mail.zoho.${connectionConfig.extension}`, `connection_config.extension` enum com|eu|in|com.au|com.cn|jp).

## Global Constraints

- **Phase order.** Phase G runs after Phase E. Every place this plan leans on E's final shape carries a marker `[E-A1]`…`[E-A8]`, and Task 1 Step 9 greps each one before any code is written.
- **Migrations.** PostgreSQL only. This phase owns `migrations/136_zoho_mail.sql` and nothing else in `migrations/`. If Task 1 Step 9 finds `136_*` taken, use the next free number everywhere this plan says `136`.
- **Connection.** Connect through self-hosted Nango's built-in `zoho-mail` provider: OAuth2, with connection config `extension` ∈ `com|eu|in|com.au|com.cn|jp`. Never store a password. There is no SMTP path anywhere.
- **Credentials.** Provider credentials stay in Nango. No token, password, or Zoho `accountId` is written to an application table. The `accountId` is re-read from `GET /api/accounts` at send time and never persisted.
- **Outreach sending.** Zoho outreach goes through the Zoho REST send API without RFC 8058 `List-Unsubscribe` headers. The visible footer opt-out line plus "reply to unsubscribe" carries the opt-out.
- **`requireListUnsubscribe` is provider-aware.** Zoho is allowed without the header only through the explicit, tested branch in `unsubscribe-policy.ts`. Gmail and Microsoft 365 keep requiring it.
- **Daily cap.** `ZOHO_OUTREACH_DAILY_CAP = 50` per Zoho mailbox per rolling 24 hours, far under Zoho's roughly 5,000/day bulk threshold. It is enforced at prepare time (`prepareEmailOutreach`) and at send time (`assertEmailDeliveryCapacity`). The operator's `linkedin_campaign_mailbox_settings.daily_limit` can lower it but never raise it.
- **Replies.** Read replies only through the Zoho REST API, via a Nango sync, into `ingestInboundMailboxMessage`/`decideInboundMailboxRecord`. Trevra never polls Zoho itself.
- **Hard-coded provider lists.** Every one gets `zoho-mail` added, or is left out with the reason stated in a code comment or in this plan's Task 13 table.
- **Invariants kept.**
  - The exact approved payload, mailbox binding (`require_connection_id`) and compliance footer are unchanged.
  - The send-time suppression, `do_not_contact` and replies-synced rechecks are unchanged.
  - Deterministic idempotency keys (`payload_hash` → `gtm_deliveries.idempotency_key`) are unchanged.
  - Every commercial query is scoped by `workspace_id`.
  - Client routes stay path-based (no new route; UI lands in the existing Email panel on `/setup/workspace`).
  - UI primitives and `--t-*` tokens only.
- **SQL placeholders.** Application SQL never contains a literal `?` other than a bind placeholder (`src/server/db.ts` rewrites every `?`).
- **External writes.** Only the existing closed `email.send` action writes externally. Nothing sends through a generic skill or playbook runner.
- **Analytics.** No analytics event is added. No email body, footer or address enters analytics.
- **Durable state ships with its closer.** `email_dkim_selectors` is removed by the workspace cascade, and the owner removes a row by saving an empty selector. It is an owner fact about a domain, not about a connection, so disconnecting a mailbox keeps it.
- **Debt markers.** Deliberate ceilings carry `lc-debt: <ceiling>; <upgrade path>` comments.
- **Tests and gates.**
  - Tests never hit real DNS or Zoho; `@nangohq/node` is mocked with a hoisted `nangoMock` in every server test that reaches Nango.
  - Focused test command: `npx tsx scripts/test-with-postgres.ts <test files>`.
  - Final gate: `npm run check`, plus `npm run check:nango` for the Nango function.
- **Commits.** Every commit message is short and ends with the trailer `Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7`, passed as a second `-m`.

## Review Focus

1. **A Zoho outreach email leaves with no working opt-out, or a Gmail/Microsoft email leaves without its header.**
   - Two ways this happens: a body ends with the header-mode footer on a Zoho send, or a Gmail send is approved in `footer_and_reply` mode.
   - Either must be refused with 409 before any `gtm_deliveries` row or provider call.
   - Tested in Task 5 (policy table), Task 7 (`executeConnectedAction` refusals) and Task 9 (footer per mode at execution).
2. **A recipient replies "unsubscribe" but the reply does not thread.** Zoho's Message-ID read-back failed, or the client dropped `In-Reply-To`. The Person must still be suppressed when this mailbox sent them Zoho outreach, and only then. Tested in Task 11.
3. **The 51st Zoho email of the day leaves.**
   - It can come from two preparations on the same day, a crash-retried preparation, or an operator `daily_limit` of 200.
   - Preparation skips the excess as `daily_cap`, and the send refuses with 429 before the provider call.
   - Tested in Task 8 (send) and Task 10 (prepare, across two preparations).
4. **The Zoho connection was re-authorized as a different account, or the token sees two Zoho accounts.** The send must refuse with 409, with no send `POST` and a retryable `failed` delivery. The mailbox address must not be cached from an ambiguous account list. Tested in Task 6 (identity) and Task 7 (send).
5. **The owner types a bad DKIM selector.** Examples: `zmail._domainkey`, `Z Mail`, `../x`, a 300-character string, or a selector for another workspace's mailbox. Each is rejected (400/404) with nothing stored. A good selector is stored lowercase and forces a fresh DNS check that queries `<selector>._domainkey.<domain>` first. Tested in Task 4.

---

## File Map

| Path                                                                            | Action                          | Task           |
| ------------------------------------------------------------------------------- | ------------------------------- | -------------- |
| `.superpowers/sdd/2026-10-07-gtm-g-zoho-mail/smoke-results.md`                  | Create (not committed to `src`) | 1              |
| `migrations/136_zoho_mail.sql`                                                  | Create                          | 2              |
| `src/server/email/migration-136.test.ts`                                        | Create                          | 2              |
| `src/server/email/types.ts`                                                     | Modify                          | 3, 4, 5, 6, 10 |
| `src/server/email/deliverability.ts`                                            | Modify                          | 3              |
| `src/server/email/deliverability.test.ts`                                       | Modify                          | 3              |
| `src/server/email/dkim-selector.ts`                                             | Create                          | 4              |
| `src/server/email/dkim-selector.test.ts`                                        | Create                          | 4              |
| `src/server/email/sender-deliverability.ts`                                     | Modify                          | 4              |
| `src/server/email/channel.ts`                                                   | Modify                          | 4, 6           |
| `src/server/app.ts`                                                             | Modify                          | 4              |
| `src/server/email/channel-api.test.ts`                                          | Modify                          | 4              |
| `src/server/email/zoho-mail.ts`                                                 | Create                          | 5              |
| `src/server/email/zoho-mail.test.ts`                                            | Create                          | 5              |
| `src/server/email/unsubscribe-policy.ts`                                        | Create                          | 5              |
| `src/server/email/unsubscribe-policy.test.ts`                                   | Create                          | 5              |
| `src/server/email/mailbox-address.ts`                                           | Modify                          | 6              |
| `src/server/integration-service.ts`                                             | Modify                          | 6, 7           |
| `src/server/email/zoho-mailbox.test.ts`                                         | Create                          | 6              |
| `src/server/email/zoho-send.test.ts`                                            | Create                          | 7              |
| `src/server/email-deliveries.ts`                                                | Modify                          | 8              |
| `src/server/email-deliveries.test.ts`                                           | Modify                          | 8              |
| `src/server/playbooks/registry.ts`                                              | Modify                          | 9              |
| `src/server/control-plane/execution.ts`                                         | Modify                          | 9              |
| `src/server/email/outreach.ts`                                                  | Modify                          | 9, 10          |
| `src/server/email/outreach-playbook.test.ts`                                    | Modify                          | 9              |
| `src/server/gtm/intent.ts`                                                      | Modify                          | 10             |
| `src/server/email/outreach-plan.test.ts`                                        | Modify                          | 10             |
| `src/server/email/zoho-outreach.test.ts`                                        | Create                          | 10             |
| `src/server/conversations.ts`                                                   | Modify                          | 11             |
| `src/server/email/inbound-mailbox.ts`                                           | Modify                          | 11             |
| `src/server/email/zoho-inbound.test.ts`                                         | Create                          | 11             |
| `nango-integrations/shared/zoho-mail.ts`                                        | Create                          | 12             |
| `nango-integrations/trevra-zoho-mail/syncs/inbound-messages.ts`                 | Create                          | 12             |
| `nango-integrations/index.ts`                                                   | Modify                          | 12             |
| `src/server/email/zoho-sync-helpers.test.ts`                                    | Create                          | 12             |
| `src/server/email/inbound-sync-helpers.test.ts`                                 | Modify                          | 12             |
| `src/server/today.ts`, `src/server/today.test.ts`                               | Modify                          | 13             |
| `src/server/email.ts`                                                           | Modify                          | 13             |
| `src/server/conversation-replies.ts`, `src/server/conversation-replies.test.ts` | Modify                          | 13             |
| `src/client/api.ts`                                                             | Modify                          | 14             |
| `src/client/EmailChannelSummary.tsx`, `src/client/EmailChannelSummary.test.tsx` | Modify                          | 4, 6, 14       |
| `src/client/EmailChannelPanel.tsx`                                              | Modify                          | 14             |
| `src/client/views/gtmPlanFormat.ts`, `src/client/views/gtmPlanFormat.test.ts`   | Modify                          | 14             |
| `src/client/styles.css`                                                         | Modify                          | 14             |
| `docs/integration-contracts.md`                                                 | Modify                          | 15             |
| `.env.example`                                                                  | Modify                          | 15             |

---

### Task 1: Live smoke-test gate (no code)

Everything below marked UNVERIFIED is a fact this plan relies on that nobody has observed against the pinned deployment. This task observes each one against a real Zoho Mail test account through the self-hosted Nango, and records the answers. **Stop and escalate to the founder** where a step says STOP. Do not start Task 2 until every step has a recorded answer.

**Files:**

- Create: `.superpowers/sdd/2026-10-07-gtm-g-zoho-mail/smoke-results.md` (the executor's evidence log; it is not product code and is not referenced by `src`)

**Interfaces:**

- Consumes: a running self-hosted Nango (`compose.dev.yml` service `nango-server`, image `nangohq/nango-server:${NANGO_IMAGE_TAG:-hosted}`), `NANGO_HOST`, `NANGO_API_KEY`, a Zoho Mail test mailbox on a domain whose DNS you can read.
- Produces: recorded values that later tasks read:
  - **S2** fixes the auth header strategy (Task 6, Task 7).
  - **S3** fixes `sendZohoMessage`'s response field (Task 5).
  - **S4/S7** fix the folder and header parsers (Task 5, Task 12).
  - **S5** fixes the list parameters (Task 12).
  - **S6** fixes `ZOHO_SPF_INCLUDES` (Task 3).
  - **S8** fixes `ZOHO_MAX_MESSAGES_PER_RUN` (Task 12).

- [ ] **Step 1: S1, the pinned Nango build ships `zoho-mail` (UNVERIFIED)**

Run:

```bash
docker compose -f /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations/compose.dev.yml exec nango-server sh -c 'f=$(grep -rl "^zoho-mail:" / --include=providers.yaml 2>/dev/null | head -1); echo "$f"; grep -n "^zoho-mail:" -A 30 "$f"'
```

Expected: a `providers.yaml` path and a `zoho-mail:` block with `alias: zoho` and `proxy.base_url: https://mail.zoho.${connectionConfig.extension}`. Then, in the Nango dashboard, create an integration with provider **Zoho Mail** and unique key `trevra-zoho-mail`. Add scopes `ZohoMail.accounts.READ,ZohoMail.messages.CREATE,ZohoMail.messages.READ,ZohoMail.folders.READ`. Start a connection and confirm the Connect UI asks for the data-centre `extension`. Record the image digest (`docker compose ... images nango-server`), the YAML block, and whether `extension` was asked. **STOP** if there is no `zoho-mail` block. The options for the founder are (A) bump `NANGO_IMAGE_TAG` to a build that has it, or (B) defer Phase G.

- [ ] **Step 2: S1b, the auth webhook names the provider `zoho-mail` (UNVERIFIED)**

Complete the Connect flow for the test mailbox with Trevra's dev server receiving Nango webhooks. Then run:

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations && psql "$DATABASE_URL" -c "SELECT provider,provider_config_key,status FROM connections WHERE provider_config_key='trevra-zoho-mail'"
```

Expected: `provider = zoho-mail`, `provider_config_key = trevra-zoho-mail`. Record the value. If `provider` is `zoho`, record it, add `'zoho'` everywhere this plan adds `'zoho-mail'` to a provider list, and map it in `mailProviderFor` (Task 3).

- [ ] **Step 3: S2, the proxy's Authorization header works (UNVERIFIED)**

Zoho documents `Authorization: Zoho-oauthtoken <token>`; the Nango proxy sends its default OAuth2 header. Run:

```bash
curl -sS "$NANGO_HOST/proxy/api/accounts" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" | head -c 2000
```

Expected: HTTP 200 with `data[]` containing an entry with `accountId`, `primaryEmailAddress`, `type: "ZOHO_ACCOUNT"`, `sendMailDetails`. Record the redacted body shape: keys only, no addresses. **STOP** on 401/`INVALID_OAUTHTOKEN`, and escalate to the founder with two options:

- (A) Per call, read the token with `nango.getToken(providerConfigKey, connectionId)` and pass `headers: { Authorization: 'Zoho-oauthtoken ' + token }` through the proxy. The token is held in memory only and never logged or stored.
- (B) A Nango provider override (`proxy.headers.authorization: Zoho-oauthtoken ${accessToken}`) in the self-hosted deployment.

Tasks 5–7 and 12 assume the default proxy header works.

- [ ] **Step 4: S3, the send response shape (UNVERIFIED)**

With `accountId` from Step 3 and `<you>` = the test mailbox, send one message to an address you own:

```bash
curl -sS -X POST "$NANGO_HOST/proxy/api/accounts/$ZOHO_ACCOUNT_ID/messages" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" -H 'Content-Type: application/json' -d '{"fromAddress":"<you>","toAddress":"<your other address>","subject":"Trevra smoke S3","content":"Line one\n\nLine two","mailFormat":"plaintext","encoding":"UTF-8"}'
```

Expected: 200 with `data.messageId`. Record the exact key path of the message id, and whether `\n` line breaks arrived intact in the received mail. If the id lives elsewhere (for example `data.mailId`), Task 5's `sendZohoMessage` reads that path instead.

- [ ] **Step 5: S4 and S7, the folders, header and original-message shapes (UNVERIFIED)**

```bash
curl -sS "$NANGO_HOST/proxy/api/accounts/$ZOHO_ACCOUNT_ID/folders" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" | head -c 3000
curl -sS "$NANGO_HOST/proxy/api/accounts/$ZOHO_ACCOUNT_ID/folders/$SENT_FOLDER_ID/messages/$S3_MESSAGE_ID/header" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" | head -c 3000
curl -sS "$NANGO_HOST/proxy/api/accounts/$ZOHO_ACCOUNT_ID/messages/$INBOX_MESSAGE_ID/originalmessage" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" | head -c 3000
```

Expected:

- The folder entries carry `folderId`, `folderName` and `folderType`, with values like `Inbox` and `Sent`.
- The header response is `data.headerContent` (a raw block), or a name→value object.
- The original message is the raw MIME, either as a string body or under `data.content`.

Record all three shapes with addresses redacted. Task 5's `parseZohoHeaders` and `pickZohoFolderId`, and Task 12's `mimeFromOriginalMessage`, accept every shape listed here. If you observe another shape, add it to their fixtures and parsers in those tasks.

- [ ] **Step 6: S5, list order and fields (UNVERIFIED)**

```bash
curl -sS "$NANGO_HOST/proxy/api/accounts/$ZOHO_ACCOUNT_ID/messages/view?folderId=$INBOX_FOLDER_ID&start=1&limit=5&sortBy=date&sortorder=false" -H "Authorization: Bearer $NANGO_API_KEY" -H 'Provider-Config-Key: trevra-zoho-mail' -H "Connection-Id: $ZOHO_CONNECTION_ID" | head -c 3000
```

Expected: `data[]` newest first, each entry with `messageId`, `folderId`, `receivedTime` (epoch milliseconds as a string or number), `fromAddress`, `subject` and `summary`. Record whether `sortorder=false` means newest-first. If newest-first needs another value, Task 12's `ZOHO_LIST_NEWEST_FIRST` param uses it.

- [ ] **Step 7: S6, the per-data-centre SPF includes (UNVERIFIED)**

For each data centre the founder will support, read Zoho's published SPF instruction in that data centre's admin console (Mail Admin → Domains → Email configuration → SPF). Then run:

```bash
for d in zohomail.com one.zoho.com zohomail.eu zoho.eu zohomail.in zoho.in zohomail.com.au zoho.com.au zoho.jp zohomail.jp zoho.com.cn; do printf '%s: ' "$d"; dig +short TXT "$d" | grep -i spf1 | head -1; echo; done
```

Record, for each data centre, the include the admin console asks for and whether that name publishes `v=spf1`. Task 3 starts `ZOHO_SPF_INCLUDES` at `['zohomail.com', 'one.zoho.com']`. Add every include recorded here that publishes `v=spf1`, and only those.

- [ ] **Step 8: S8, rate limits (UNVERIFIED)**

Read the Zoho Mail API limits page for the test org's plan. In the Step 6 response, record any rate-limit response headers (`X-RateLimit-*` or similar). Record the per-minute and per-day API call limits. Task 12 reads up to `ZOHO_MAX_MESSAGES_PER_RUN` messages per 15-minute run at 2 calls each, plus the list pages. Lower `ZOHO_MAX_MESSAGES_PER_RUN` (default 100) so that `2 × ZOHO_MAX_MESSAGES_PER_RUN + 12` fits inside a 15-minute share of the recorded limit.

- [ ] **Step 9: Phase E pre-flight grep (each line must match, or the dependent step is rewritten to E's actual shape before execution)**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
# [E-A1] blockers return issue objects; the message map is gone
grep -n "blockers(db: Db, workspaceId: string, listId: string | null): Promise<" src/server/email/compliance.ts
grep -c "COMPLIANCE_BLOCKER_MESSAGES" src/server/gtm/intent.ts   # expect 0
# [E-A2] the real provider is registered at process entry
grep -n "registerEmailComplianceProvider" src/server/index.ts src/worker/index.ts
# [E-A3] the footer owns the opt-out line; firstTouchEmail no longer appends it
grep -n "OUTREACH_OPT_OUT_SENTENCE" src/server/email/*.ts | grep -v test
# [E-A4] the drift message in assertOutreachFooter
grep -n "The sender details changed after this email was prepared; nothing was sent. Prepare it again." src/server/control-plane/execution.ts
# [E-A5] the outreach branch order: suppression/do-not-contact, replies synced, lawful basis, footer
grep -n "assertOutreach\|assertReplies\|LawfulBasis\|lawfulBasis" src/server/control-plane/execution.ts
# [E-A6] migrations 134 and 135 exist; 136 is free
ls migrations | tail -4
# [E-A7] emailOutreachPlan dedupes the footer-unavailable blocker by code
grep -n "email_compliance_footer_unavailable" src/server/gtm/intent.ts
# [E-A8] the footer fails closed to null on timeout
grep -n "TIMEOUT_MS\|return null" src/server/email/compliance*.ts src/server/compliance/*.ts 2>/dev/null | head
```

Record each output. Each `[E-A*]` marker in later tasks names the assumption it depends on.

- [ ] **Step 10: Record and stop**

Write every answer (S1–S8, E-A1–E-A8) into `.superpowers/sdd/2026-10-07-gtm-g-zoho-mail/smoke-results.md`, with no tokens, addresses or message bodies. Where an answer changes a constant or parser named above, apply it in the owning task when you reach it. This task has no commit; the controller commits the evidence log with the plan's progress files.

---

### Task 2: Migration 136, the DKIM selector table and the `zoho` deliverability provider

**Files:**

- Create: `migrations/136_zoho_mail.sql`
- Test: `src/server/email/migration-136.test.ts`

**Interfaces:**

- Consumes: `email_deliverability_checks` from migration 133 (auto-named constraint `email_deliverability_checks_provider_check`).
- Produces:
  - table `email_dkim_selectors(workspace_id, domain, selector, updated_by_user_id, updated_at)` with PK `(workspace_id, domain)`.
  - `email_deliverability_checks.provider` now also accepts `'zoho'`.

- [ ] **Step 1: Write the failing test**

Create `src/server/email/migration-136.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_email_migration_136';
const NOW = '2026-10-07T09:00:00.000Z';
const CHECK = JSON.stringify({ status: 'pass', detail: 'ok', record: null });
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Migration 136', NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

function checkViolation(work: Promise<unknown>) {
  return expect(work).rejects.toMatchObject({ code: '23514' });
}

function insertCheck(provider: string) {
  return db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,checked_at,expires_at)
       VALUES (?,'acme.test',?,'pass',?::jsonb,?::jsonb,?::jsonb,?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, provider, CHECK, CHECK, CHECK, NOW, NOW);
}

function insertSelector(domain: string, selector: string) {
  return db
    .prepare(
      `INSERT INTO email_dkim_selectors (workspace_id,domain,selector,updated_at)
       VALUES (?,?,?,?::timestamptz)`
    )
    .run(WORKSPACE, domain, selector, NOW);
}

describe('migration 136 zoho mail', () => {
  it('accepts zoho deliverability checks and still rejects unknown providers', async () => {
    await insertCheck('zoho');
    await checkViolation(insertCheck('yahoo'));
    const constraint = await db
      .prepare(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid='email_deliverability_checks'::regclass
           AND conname='email_deliverability_checks_provider_check'`
      )
      .get<{ def: string }>();
    expect(constraint?.def).toContain("'zoho'");
  });

  it('stores one lowercase DKIM selector per workspace and domain', async () => {
    await insertSelector('acme.test', 'zmail');
    await expect(insertSelector('acme.test', 'other')).rejects.toMatchObject({ code: '23505' });
    await checkViolation(insertSelector('Acme.test', 'zmail2'));
    await checkViolation(insertSelector('beta.test', 'ZMail'));
    await checkViolation(insertSelector('gamma.test', 'zmail._domainkey'));
    await checkViolation(insertSelector('delta.test', ''));
  });

  it('removes selectors with the workspace', async () => {
    await insertSelector('acme.test', 'zmail');
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    const left = await db
      .prepare('SELECT COUNT(*)::int AS total FROM email_dkim_selectors WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(left?.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/migration-136.test.ts`
Expected: FAIL. The `zoho` insert hits `23514`, and `email_dkim_selectors` does not exist.

- [ ] **Step 3: Write the migration**

Create `migrations/136_zoho_mail.sql`:

```sql
-- Phase G: Zoho Mail as a third mailbox provider.
--
-- 1. DNS checks for a Zoho sending domain are cached under provider 'zoho'.
-- 2. The owner names the DKIM selector their provider signs with, per sending
--    domain. Zoho has no default selector; Google and Microsoft 365 defaults
--    are still tried after the owner's selector.
-- No credential, token or Zoho account id is stored: Nango holds the OAuth
-- connection and Trevra re-reads the account id at send time.

ALTER TABLE email_deliverability_checks
  DROP CONSTRAINT IF EXISTS email_deliverability_checks_provider_check;
ALTER TABLE email_deliverability_checks
  ADD CONSTRAINT email_deliverability_checks_provider_check
  CHECK (provider IN ('google','microsoft','zoho'));

CREATE TABLE IF NOT EXISTS email_dkim_selectors (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = LOWER(domain) AND domain <> ''),
  -- One or more DNS labels, lowercase; the part before ._domainkey.
  selector TEXT NOT NULL CHECK (
    char_length(selector) BETWEEN 1 AND 200
    AND selector ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
  ),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, domain)
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/migration-136.test.ts src/server/email/migration-133.test.ts`
Expected: PASS (both files; 133's tests still pass).

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add migrations/136_zoho_mail.sql src/server/email/migration-136.test.ts
git commit -m "feat(email): migration 136 for Zoho DNS checks and DKIM selectors" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 3: `zoho` mail provider, Zoho SPF includes, and an owner DKIM selector in the evaluator

**Files:**

- Modify: `src/server/email/types.ts` (`MailProvider`)
- Modify: `src/server/email/deliverability.ts` (`mailProviderFor`, provider constants, `walkSpf`, `evaluateSpf`, `evaluateDkim`, `evaluateDeliverability`, consumer domains)
- Test: `src/server/email/deliverability.test.ts`

**Interfaces:**

- Consumes: Task 1 S6 (the recorded SPF includes).
- Produces:
  - `type MailProvider = 'google' | 'microsoft' | 'zoho'`
  - `mailProviderFor('zoho-mail') === 'zoho'`
  - `export const ZOHO_SPF_INCLUDES: readonly string[]`
  - `evaluateDeliverability(input: { domain: string; provider: MailProvider; dkimSelector?: string | null }, resolver?)`
  - the new blocker code `email_dkim_selector_missing`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('email deliverability evaluation', …)` in `src/server/email/deliverability.test.ts`:

```ts
const ZOHO_SPF = {
  'zohomail.com': ['v=spf1 ip4:204.141.32.0/23 ~all'],
  'one.zoho.com': ['v=spf1 ip4:136.143.188.0/24 ~all']
};

it('passes a Zoho Mail domain with include:zohomail.com and the owner selector', async () => {
  const resolver = fakeResolver({
    ...ZOHO_SPF,
    'acme.test': ['v=spf1 include:zohomail.com ~all'],
    'zmail._domainkey.acme.test': [DKIM],
    '_dmarc.acme.test': ['v=DMARC1; p=quarantine']
  });
  const result = await evaluateDeliverability(
    { domain: 'acme.test', provider: 'zoho', dkimSelector: 'zmail' },
    resolver
  );
  expect(result.status).toBe('pass');
  expect(result.provider).toBe('zoho');
  expect(result.dkim).toMatchObject({ status: 'pass', selector: 'zmail' });
  expect(result.spf.detail).toContain('zohomail.com');
});

it('accepts include:one.zoho.com for Zoho and names both includes when neither is present', async () => {
  const passing = await evaluateDeliverability(
    { domain: 'acme.test', provider: 'zoho', dkimSelector: 'zmail' },
    fakeResolver({
      ...ZOHO_SPF,
      'acme.test': ['v=spf1 include:one.zoho.com -all'],
      'zmail._domainkey.acme.test': [DKIM],
      '_dmarc.acme.test': ['v=DMARC1; p=none']
    })
  );
  expect(passing.status).toBe('pass');

  const failing = await evaluateDeliverability(
    { domain: 'acme.test', provider: 'zoho', dkimSelector: 'zmail' },
    fakeResolver({
      ...GOOGLE_SPF,
      'acme.test': ['v=spf1 include:_spf.google.com ~all'],
      'zmail._domainkey.acme.test': [DKIM],
      '_dmarc.acme.test': ['v=DMARC1; p=none']
    })
  );
  expect(failing.blockers.map((blocker) => blocker.code)).toEqual([
    'email_spf_provider_not_authorized'
  ]);
  expect(failing.blockers[0]!.message).toContain('zohomail.com or one.zoho.com');
  expect(failing.blockers[0]!.message).toContain('include:zohomail.com');
});

it('blocks a Zoho domain with no owner selector without guessing selectors', async () => {
  const resolver = fakeResolver({
    ...ZOHO_SPF,
    'acme.test': ['v=spf1 include:zohomail.com ~all'],
    '_dmarc.acme.test': ['v=DMARC1; p=none']
  });
  const result = await evaluateDeliverability({ domain: 'acme.test', provider: 'zoho' }, resolver);
  expect(result.status).toBe('fail');
  expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_dkim_selector_missing']);
  expect(result.dkim).toMatchObject({ status: 'fail', selector: null });
  expect(resolver.calls.some((name) => name.includes('._domainkey.'))).toBe(false);
});

it('tries the owner selector before the provider defaults', async () => {
  const resolver = fakeResolver(
    googleDomain({
      'google._domainkey.acme.test': new Error('should not be needed'),
      'custom2026._domainkey.acme.test': [DKIM]
    })
  );
  const result = await evaluateDeliverability(
    { domain: 'acme.test', provider: 'google', dkimSelector: 'custom2026' },
    resolver
  );
  expect(result.dkim).toMatchObject({ status: 'pass', selector: 'custom2026' });
  expect(resolver.calls.filter((name) => name.includes('._domainkey.'))).toEqual([
    'custom2026._domainkey.acme.test'
  ]);
});

it('treats Zoho free mailboxes as consumer mailboxes', async () => {
  const resolver = fakeResolver({});
  const result = await evaluateDeliverability(
    { domain: 'zohomail.com', provider: 'zoho' },
    resolver
  );
  expect(result.spf.status).toBe('provider_managed');
  expect(resolver.calls).toEqual([]);
});

it('maps zoho-mail and nothing else to zoho', () => {
  expect(mailProviderFor('zoho-mail')).toBe('zoho');
  expect(mailProviderFor('Zoho-Mail ')).toBe('zoho');
  expect(mailProviderFor('zoho')).toBeNull();
  expect(mailProviderFor('zoho-crm')).toBeNull();
});
```

(If Task 1 Step 2 recorded the webhook provider as `zoho`, change the third expectation to `toBe('zoho')` and add `if (value === 'zoho') return 'zoho';` in Step 3.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/deliverability.test.ts`
Expected: FAIL. TypeScript rejects `provider: 'zoho'`, and `mailProviderFor('zoho-mail')` is `null`.

- [ ] **Step 3: Implement**

In `src/server/email/types.ts` replace the first two lines with:

```ts
/** Mail providers Trevra can send through, keyed by their DNS footprint. */
export type MailProvider = 'google' | 'microsoft' | 'zoho';
```

In `src/server/email/deliverability.ts`, replace `mailProviderFor` with:

```ts
export function mailProviderFor(provider: string): MailProvider | null {
  const value = provider.trim().toLowerCase();
  if (value === 'gmail' || value === 'google-mail') return 'google';
  if (value === 'microsoft' || value === 'outlook') return 'microsoft';
  // Nango's built-in Zoho Mail provider; `zoho` alone is the generic Zoho
  // OAuth provider (CRM, Books, ...) and is not a mailbox.
  if (value === 'zoho-mail') return 'zoho';
  return null;
}
```

Replace the block from `const PROVIDER_SPF_INCLUDE` through the end of `DKIM_SELECTORS` (including the `lc-debt` comment above `DKIM_SELECTORS`, which this task resolves) with:

```ts
/**
 * Zoho documents two SPF includes: zohomail.com (Zoho Mail) and one.zoho.com
 * (Zoho One / Workplace bundles). Either authorizes Zoho's outbound servers.
 * Extended only from the per-data-centre evidence recorded by the Phase G
 * smoke test (Task 1, S6) -- never from guesses.
 */
export const ZOHO_SPF_INCLUDES: readonly string[] = ['zohomail.com', 'one.zoho.com'];
const PROVIDER_SPF_INCLUDES: Record<MailProvider, readonly string[]> = {
  google: ['_spf.google.com'],
  microsoft: ['spf.protection.outlook.com'],
  zoho: ZOHO_SPF_INCLUDES
};
const PROVIDER_LABEL: Record<MailProvider, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  zoho: 'Zoho Mail'
};
/**
 * Provider default selectors, tried after the owner-set selector stored in
 * email_dkim_selectors. Zoho has none: its admin console asks the founder to
 * name the selector, so without the owner's answer there is nothing to check.
 */
const DKIM_SELECTORS: Record<MailProvider, readonly string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2'],
  zoho: []
};
```

Add `'zoho.com'` and `'zohomail.com'` to `CONSUMER_MAILBOX_DOMAINS`, after `'msn.com'`. These are Zoho's free personal mailbox domains; `src/server/lead-capture/freemail.ts` already treats `zoho.com` as freemail.

In `walkSpf`, change the parameter `target: string` to `targets: ReadonlySet<string>`. Pass `targets` in the recursive call (`walkSpf(resolver, value, targets, state, path)`), and change the authorization test to:

```ts
    if ((isRedirect || qualifier === '+') && (targets.has(value) || nested.authorized)) {
```

In `evaluateSpf`, replace `const target = PROVIDER_SPF_INCLUDE[provider];` and the `walkSpf` call with:

```ts
const includes = PROVIDER_SPF_INCLUDES[provider];
// The include Trevra tells the founder to add; any listed include authorizes.
const target = includes[0]!;
const named = includes.join(' or ');
const label = PROVIDER_LABEL[provider];
const state = { lookups: 0, voids: 0 };
const walk = await walkSpf(resolver, domain, new Set(includes), state, new Set());
```

(Delete the existing `const label = …` and `const state = …` lines that this block now replaces.) In the `!walk.authorized` branch, use `detail: \`SPF does not authorize ${named}.\`` and this blocker message:

```ts
`The SPF record for ${domain} does not include ${named}, so mail sent through ${label} fails SPF. Add "include:${target}" before the final "all".`;
```

In the pass branch, use `detail: \`SPF authorizes ${named} (${state.lookups} of ${SPF_LOOKUP_LIMIT} lookups).\``. For Google and Microsoft `named === target`, so every existing message is byte-identical.

Replace the head of `evaluateDkim` with:

```ts
async function evaluateDkim(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider,
  ownerSelector: string | null
): Promise<Evaluated> {
  const selectors = [
    ...new Set([ownerSelector, ...DKIM_SELECTORS[provider]].filter((value): value is string =>
      Boolean(value)
    ))
  ];
  if (selectors.length === 0) {
    return {
      check: {
        status: 'fail',
        detail: 'No DKIM selector is set for this sending domain.',
        record: null,
        selector: null
      },
      blocker: issue(
        'email_dkim_selector_missing',
        `${PROVIDER_LABEL[provider]} signs mail with a DKIM selector you named when you turned DKIM on. Enter that selector for ${domain} under Email in Workspace settings so Trevra can check it.`
      )
    };
  }
  let failure: string | null = null;
```

(The `for (const selector of selectors)` loop and the rest of the function are unchanged.)

In `evaluateDeliverability`, change the input type to `input: { domain: string; provider: MailProvider; dkimSelector?: string | null }` and the DKIM call to `evaluateDkim(resolver, domain, input.provider, input.dkimSelector ?? null)`.

- [ ] **Step 4: Find every other exhaustive use of `MailProvider`**

Run: `cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations && grep -rn "Record<MailProvider\|providerKey === '\|MailProvider" src --include=*.ts --include=*.tsx | grep -v "\.test\."`
Expected: only `deliverability.ts` (updated above), `types.ts`, `sender-deliverability.ts`, `outreach.ts` and `mailbox-address.ts`, which carry the type through. `mailbox-address.ts` treats any non-`google` key as Microsoft until Task 6, which adds the `zoho` branch before any Zoho connection can be listed. Task 6 also adds `zoho-mail` to the listing SQL, so Task 3 cannot route Zoho there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/deliverability.test.ts src/server/email/sender-deliverability.test.ts`
Expected: PASS, all existing Google/Microsoft tests unchanged.

- [ ] **Step 6: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email/types.ts src/server/email/deliverability.ts src/server/email/deliverability.test.ts
git commit -m "feat(email): Zoho SPF includes and owner-set DKIM selector in the evaluator" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 4: Owner-set DKIM selector, stored per sending domain

**Files:**

- Create: `src/server/email/dkim-selector.ts`
- Modify: `src/server/email/sender-deliverability.ts` (`evaluateWithin` input, `getSenderDeliverability`, `refreshDueEmailDeliverability`)
- Modify: `src/server/email/channel.ts` (new `setMailboxDkimSelector`; status rows gain `dkimSelector`)
- Modify: `src/server/email/types.ts` (`EmailChannelStatus` mailbox rows)
- Modify: `src/server/app.ts` (route `PUT /api/email/dkim-selector`)
- Modify: `src/client/EmailChannelSummary.test.tsx` (fixture gains `dkimSelector: null`; the UI comes in Task 14)
- Test: `src/server/email/dkim-selector.test.ts`, `src/server/email/channel-api.test.ts`

**Interfaces:**

- Consumes:
  - From Task 2: table `email_dkim_selectors`.
  - From Task 3: `evaluateDeliverability({ domain, provider, dkimSelector })` and `normalizeSenderDomain`.
- Produces:
  - `dkimSelectorSchema: z.ZodType<string>` (trim, lowercase, DNS labels).
  - `readDkimSelector(db: Db, workspaceId: string, domain: string): Promise<string | null>`
  - `writeDkimSelector(db: Db, input: { workspaceId: string; domain: string; selector: string | null; actorUserId: string | null }, now?: Date): Promise<string | null>`
  - `setMailboxDkimSelector(db: Db, input: { workspaceId: string; connectionId: string; selector: string | null; actorUserId: string }, options?: EmailChannelOptions): Promise<void>`. It throws `EmailChannelError` 400/404/409.
  - `EmailChannelStatus['mailboxes'][number].dkimSelector: string | null`
  - `PUT /api/email/dkim-selector` (owner only): body `{ connectionId: string, selector: string | null }`, responds `{ channel }`.

- [ ] **Step 1: Write the failing unit tests**

Create `src/server/email/dkim-selector.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { EmailChannelError, setMailboxDkimSelector } from './channel.js';
import type { DnsResolver } from './deliverability.js';
import { dkimSelectorSchema, readDkimSelector, writeDkimSelector } from './dkim-selector.js';

const WORKSPACE = 'ws_email_dkim_selector';
const OTHER = 'ws_email_dkim_selector_other';
const USER = 'usr_email_dkim_selector';
const CONNECTION = 'conn_email_dkim_selector';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';
let db: Db;

function recordingResolver(): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  const records: Record<string, string[]> = {
    'acme.test': ['v=spf1 include:_spf.google.com ~all'],
    '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'],
    'zmail._domainkey.acme.test': [DKIM],
    '_dmarc.acme.test': ['v=DMARC1; p=none']
  };
  return {
    calls,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (!value) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@acme.test', 'Owner', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('DKIM selector store', () => {
  it('accepts DNS-label selectors, lowercased and trimmed, and rejects everything else', () => {
    expect(dkimSelectorSchema.parse('  ZMail ')).toBe('zmail');
    expect(dkimSelectorSchema.parse('s1.mail-2026')).toBe('s1.mail-2026');
    for (const bad of [
      '',
      'zmail._domainkey',
      'z mail',
      '../x',
      '-zmail',
      'zmail-',
      'a'.repeat(201),
      'z_mail'
    ]) {
      expect(dkimSelectorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('writes, replaces and clears one selector per workspace and domain', async () => {
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'Acme.Test.', selector: 'zmail', actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail');
    expect(await readDkimSelector(db, OTHER, 'acme.test')).toBeNull();
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: 'zmail2', actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail2');
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: null, actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBeNull();
  });
});

describe('setMailboxDkimSelector', () => {
  it("stores the mailbox domain's selector and re-checks DNS with it first", async () => {
    const resolver = recordingResolver();
    await setMailboxDkimSelector(
      db,
      { workspaceId: WORKSPACE, connectionId: CONNECTION, selector: 'ZMAIL', actorUserId: USER },
      { resolver, now: NOW }
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail');
    expect(resolver.calls.filter((name) => name.includes('._domainkey.'))[0]).toBe(
      'zmail._domainkey.acme.test'
    );
    const stored = await db
      .prepare(
        `SELECT dkim_json->>'selector' AS selector FROM email_deliverability_checks
         WHERE workspace_id=? AND domain='acme.test' AND provider='google'`
      )
      .get<{ selector: string }>(WORKSPACE);
    expect(stored?.selector).toBe('zmail');
  });

  it('refuses a bad selector or another workspace mailbox and stores nothing', async () => {
    await expect(
      setMailboxDkimSelector(db, {
        workspaceId: WORKSPACE,
        connectionId: CONNECTION,
        selector: 'zmail._domainkey',
        actorUserId: USER
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setMailboxDkimSelector(db, {
        workspaceId: OTHER,
        connectionId: CONNECTION,
        selector: 'zmail',
        actorUserId: USER
      })
    ).rejects.toBeInstanceOf(EmailChannelError);
    const rows = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM email_dkim_selectors WHERE workspace_id IN (?,?)'
      )
      .get<{ total: number }>(WORKSPACE, OTHER);
    expect(rows?.total).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing route tests**

Append to `src/server/email/channel-api.test.ts`, inside its top-level `describe` (next to `'re-checks DNS on request'`):

```ts
it('lets only the owner set the DKIM selector for a connected mailbox domain', async () => {
  const { owner, connectionId } = await ownerWithMailbox();
  const member = await signUp('email-dkim-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  await member.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId, selector: 'zmail' })
    .expect(403);

  const saved = await owner.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId, selector: ' ZMail ' })
    .expect(200);
  expect(saved.headers['cache-control']).toBe('no-store');
  expect(saved.body.channel.mailboxes[0].dkimSelector).toBe('zmail');

  await owner.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId, selector: 'zmail._domainkey' })
    .expect(400);
  await owner.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId: 'conn_not_here', selector: 'zmail' })
    .expect(404);
  await owner.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId, selector: 'zmail', extra: true })
    .expect(400);

  const cleared = await owner.agent
    .put('/api/email/dkim-selector')
    .send({ connectionId, selector: null })
    .expect(200);
  expect(cleared.body.channel.mailboxes[0].dkimSelector).toBeNull();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/dkim-selector.test.ts src/server/email/channel-api.test.ts`
Expected: FAIL. `./dkim-selector.js` does not exist, and the route returns 404.

- [ ] **Step 4: Implement the store**

Create `src/server/email/dkim-selector.ts`:

```ts
import { z } from 'zod';
import type { Db } from '../db.js';
import { normalizeSenderDomain } from './deliverability.js';

/** One or more lowercase DNS labels: the part of a DKIM record name before ._domainkey. */
export const DKIM_SELECTOR_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const dkimSelectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter the DKIM selector, or clear it.')
  .max(200, 'A DKIM selector is at most 200 characters.')
  .regex(
    DKIM_SELECTOR_PATTERN,
    'Enter the DKIM selector exactly as your mail provider shows it, for example zmail: the part before ._domainkey.'
  );

/** The owner-set selector for one sending domain in this workspace, or null. */
export async function readDkimSelector(
  db: Db,
  workspaceId: string,
  domain: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT selector FROM email_dkim_selectors WHERE workspace_id=? AND domain=?')
    .get<{ selector: string }>(workspaceId, normalizeSenderDomain(domain));
  return row?.selector ?? null;
}

/** Set (or, with null or blank, clear) the owner's selector. Returns what is stored. */
export async function writeDkimSelector(
  db: Db,
  input: {
    workspaceId: string;
    domain: string;
    selector: string | null;
    actorUserId: string | null;
  },
  now: Date = new Date()
): Promise<string | null> {
  const domain = normalizeSenderDomain(input.domain);
  if (input.selector === null || input.selector.trim() === '') {
    await db
      .prepare('DELETE FROM email_dkim_selectors WHERE workspace_id=? AND domain=?')
      .run(input.workspaceId, domain);
    return null;
  }
  const selector = dkimSelectorSchema.parse(input.selector);
  await db
    .prepare(
      `INSERT INTO email_dkim_selectors (workspace_id,domain,selector,updated_by_user_id,updated_at)
       VALUES (?,?,?,?,?::timestamptz)
       ON CONFLICT (workspace_id,domain) DO UPDATE SET
         selector=excluded.selector,updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`
    )
    .run(input.workspaceId, domain, selector, input.actorUserId, now.toISOString());
  return selector;
}
```

- [ ] **Step 5: Read the selector wherever DNS is evaluated**

In `src/server/email/sender-deliverability.ts`:

- Add `import { readDkimSelector } from './dkim-selector.js';`.
- Change `evaluateWithin`'s input type to `{ domain: string; provider: MailProvider; dkimSelector?: string | null }`. `evaluateDeliverability(input, …)` already passes it through.
- In `getSenderDeliverability`, just before `const running = evaluateWithin(`, add `const dkimSelector = await readDkimSelector(db, workspaceId, domain);`, and pass `{ domain, provider: input.provider, dkimSelector }` as the first argument.
- In `refreshDueEmailDeliverability`'s loop, just before `const { evaluation, timedOut } = await evaluateWithin(`, add `const dkimSelector = await readDkimSelector(db, row.workspace_id, row.domain);`, and pass `{ domain: row.domain, provider: row.provider, dkimSelector }`.

`recheckingEvaluation` keeps taking `{ domain, provider }`, and the cache key stays `(workspace_id, domain, provider)`. A changed selector reaches the cache because `setMailboxDkimSelector` forces a re-check.

- [ ] **Step 6: Implement the channel setter and the status field**

In `src/server/email/types.ts`, change the `mailboxes` line of `EmailChannelStatus` to:

```ts
mailboxes: Array<
  EmailChannelMailbox & {
    deliverability: StoredDeliverability | null;
    /** The owner-set DKIM selector for this mailbox's sending domain. */
    dkimSelector: string | null;
  }
>;
```

In `src/server/email/channel.ts`, add `import { dkimSelectorSchema, readDkimSelector, writeDkimSelector } from './dkim-selector.js';`. In `getEmailChannelStatus`'s row mapper, add `dkimSelector: domain ? await readDkimSelector(db, workspaceId, domain) : null,` after `deliverability`. Then add, after `recheckEmailDeliverability`:

```ts
/**
 * The owner names the DKIM selector their provider signs this mailbox's domain
 * with. The domain comes from the provider-verified mailbox address, never
 * from the request, so a selector can only be set for a domain this workspace
 * sends from. Saving forces a fresh DNS check that tries the selector first.
 */
export async function setMailboxDkimSelector(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    selector: string | null;
    actorUserId: string;
  },
  options: EmailChannelOptions = {}
): Promise<void> {
  const mailbox = (await listSendingMailboxes(db, input.workspaceId)).find(
    (candidate) => candidate.connectionId === input.connectionId
  );
  if (!mailbox) {
    throw new EmailChannelError(
      'Connect this mailbox before setting the DKIM selector for its domain.',
      404
    );
  }
  let selector: string | null = null;
  if (input.selector !== null && input.selector.trim() !== '') {
    const parsed = dkimSelectorSchema.safeParse(input.selector);
    if (!parsed.success) {
      throw new EmailChannelError(
        parsed.error.issues[0]?.message ?? 'That is not a DKIM selector.',
        400
      );
    }
    selector = parsed.data;
  }
  const address = await resolveMailboxAddress(db, input.workspaceId, mailbox, {
    deadlineMs: options.deadlineMs
  });
  const domain = address ? emailDomainOf(address) : null;
  if (!domain) {
    throw new EmailChannelError(
      'Trevra could not read the address of this mailbox, so it does not know which domain the selector is for. Reconnect it and try again.',
      409
    );
  }
  await writeDkimSelector(
    db,
    { workspaceId: input.workspaceId, domain, selector, actorUserId: input.actorUserId },
    options.now
  );
  await getSenderDeliverability(
    db,
    input.workspaceId,
    { domain, provider: mailbox.providerKey, force: true },
    { resolver: options.resolver, now: options.now, deadlineMs: options.deadlineMs }
  );
}
```

- [ ] **Step 7: Add the route**

In `src/server/app.ts`, import `setMailboxDkimSelector` with the other `./email/channel.js` imports. Then add, directly after the `app.post('/api/email/deliverability/recheck', …)` handler:

```ts
app.put(
  '/api/email/dkim-selector',
  ownerOnly('set the DKIM selector'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({
          connectionId: z.string().trim().min(1).max(200),
          selector: z.string().max(300).nullable()
        })
        .strict()
        .parse(req.body ?? {});
      await setMailboxDkimSelector(db, {
        workspaceId: req.auth!.workspaceId,
        connectionId: input.connectionId,
        selector: input.selector,
        actorUserId: req.auth!.userId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ channel: await getEmailChannelStatus(db, req.auth!.workspaceId) });
    } catch (error) {
      if (error instanceof EmailChannelError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);
```

(A `ZodError` from the body schema falls through to the app error handler, which already answers 400.)

In `src/client/EmailChannelSummary.test.tsx`, add `dkimSelector: null,` to the `MAILBOX` fixture after `deliverability: deliverability()`, so the client build type-checks.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/dkim-selector.test.ts src/server/email/channel-api.test.ts src/server/email/sender-deliverability.test.ts src/client/EmailChannelSummary.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email/dkim-selector.ts src/server/email/dkim-selector.test.ts src/server/email/sender-deliverability.ts src/server/email/channel.ts src/server/email/types.ts src/server/app.ts src/server/email/channel-api.test.ts src/client/EmailChannelSummary.test.tsx
git commit -m "feat(email): owner-set DKIM selector per sending domain" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 5: Pure modules, the Zoho Mail adapter and the provider-aware unsubscribe policy

**Files:**

- Modify: `src/server/email/types.ts` (add `OutreachUnsubscribeMode`)
- Create: `src/server/email/unsubscribe-policy.ts`
- Create: `src/server/email/zoho-mail.ts`
- Test: `src/server/email/unsubscribe-policy.test.ts`, `src/server/email/zoho-mail.test.ts`

**Interfaces:**

- Consumes:
  - From Task 3: `mailProviderFor` and `MailProvider`.
  - From `compliance.ts`: `OUTREACH_OPT_OUT_SENTENCE` [E-A3: after Phase E the compliance footer contains this sentence exactly once].
  - Task 1 S2/S3/S4/S7 (response shapes).
- Produces (`types.ts`):
  - `type OutreachUnsubscribeMode = 'list_unsubscribe_headers' | 'footer_and_reply'`
- Produces (`unsubscribe-policy.ts`):
  - `OUTREACH_UNSUBSCRIBE_MODES: readonly ['list_unsubscribe_headers', 'footer_and_reply']`
  - `outreachUnsubscribeModeFor(provider: MailProvider): OutreachUnsubscribeMode`
  - `parseOutreachUnsubscribeMode(value: unknown): OutreachUnsubscribeMode | null`
  - `OUTREACH_REPLY_OPT_OUT_SENTENCE: string`
  - `footerForUnsubscribeMode(footer: string, mode: OutreachUnsubscribeMode): string | null`
  - `class UnsubscribePolicyError extends Error { status: 409 }`
  - `assertUnsubscribeModeAllowed(input: { provider: string; purpose: 'outreach' | 'reply' | 'other'; requireListUnsubscribe: boolean; unsubscribeMode: OutreachUnsubscribeMode | null }): void`
- Produces (`zoho-mail.ts`):
  - `ZOHO_MAIL_PROVIDER = 'zoho-mail'`, `ZOHO_OUTREACH_DAILY_CAP = 50`, `ZOHO_MESSAGE_ID_READ_TIMEOUT_MS = 5_000`
  - `type ZohoNango = Pick<Nango, 'get' | 'post'>`
  - `interface ZohoConnection { providerConfigKey: string; connectionId: string }`
  - `interface ZohoAccount { accountId: string; address: string }`
  - `type ZohoHeader = { name: string; value: string }`
  - `class ZohoMailError extends Error { status: number }` (default 409)
  - Pure parsers:
    - `pickZohoAccount(body: unknown): ZohoAccount | null`
    - `pickZohoFolderId(body: unknown, kind: 'inbox' | 'sent'): string | null`
    - `parseZohoHeaders(body: unknown): ZohoHeader[]`
    - `zohoHeaderValue(headers: readonly ZohoHeader[], name: string): string | null`
    - `zohoMessageId(headers: readonly ZohoHeader[]): string | null`
  - Calls:
    - `readZohoAccount(nango: ZohoNango, connection: ZohoConnection): Promise<ZohoAccount>`. It throws `ZohoMailError` unless exactly one account.
    - `sendZohoMessage(nango, connection, input: { accountId; fromAddress; toAddress; subject; content }): Promise<{ messageId: string | null }>`
    - `readZohoSentMessageId(nango, connection, input: { accountId; messageId }, timeoutMs?): Promise<string | null>`. It never throws.

- [ ] **Step 1: Write the failing policy tests**

Create `src/server/email/unsubscribe-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OUTREACH_OPT_OUT_SENTENCE } from './compliance.js';
import {
  OUTREACH_REPLY_OPT_OUT_SENTENCE,
  UnsubscribePolicyError,
  assertUnsubscribeModeAllowed,
  footerForUnsubscribeMode,
  outreachUnsubscribeModeFor,
  parseOutreachUnsubscribeMode
} from './unsubscribe-policy.js';
import type { OutreachUnsubscribeMode } from './types.js';

const ADDRESS = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
const FOOTER = `${ADDRESS}\n${OUTREACH_OPT_OUT_SENTENCE}`;

describe('outreach unsubscribe policy', () => {
  it('keeps one-click headers for Google and Microsoft and allows reply-only for Zoho alone', () => {
    expect(outreachUnsubscribeModeFor('google')).toBe('list_unsubscribe_headers');
    expect(outreachUnsubscribeModeFor('microsoft')).toBe('list_unsubscribe_headers');
    expect(outreachUnsubscribeModeFor('zoho')).toBe('footer_and_reply');
  });

  it('parses only the two known modes', () => {
    expect(parseOutreachUnsubscribeMode('footer_and_reply')).toBe('footer_and_reply');
    expect(parseOutreachUnsubscribeMode('list_unsubscribe_headers')).toBe(
      'list_unsubscribe_headers'
    );
    for (const value of [undefined, null, '', 'FOOTER_AND_REPLY', 'none', 1, {}]) {
      expect(parseOutreachUnsubscribeMode(value)).toBeNull();
    }
  });

  it('swaps the opt-out sentence for the reply sentence only when it appears exactly once', () => {
    expect(footerForUnsubscribeMode(FOOTER, 'list_unsubscribe_headers')).toBe(FOOTER);
    expect(footerForUnsubscribeMode(FOOTER, 'footer_and_reply')).toBe(
      `${ADDRESS}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`
    );
    expect(OUTREACH_REPLY_OPT_OUT_SENTENCE.toLowerCase()).toContain('reply');
    expect(OUTREACH_REPLY_OPT_OUT_SENTENCE.toLowerCase()).toContain('unsubscribe');
    expect(footerForUnsubscribeMode(ADDRESS, 'footer_and_reply')).toBeNull();
    expect(
      footerForUnsubscribeMode(`${FOOTER}\n${OUTREACH_OPT_OUT_SENTENCE}`, 'footer_and_reply')
    ).toBeNull();
  });

  const cases: Array<
    [string, 'outreach' | 'reply' | 'other', boolean, OutreachUnsubscribeMode | null, RegExp | null]
  > = [
    // Gmail and Microsoft 365: unchanged, the header stays required for Phase D outreach.
    ['gmail', 'outreach', true, 'list_unsubscribe_headers', null],
    ['gmail', 'outreach', true, null, null], // a gtm.email-outreach@1.0.0 run
    ['gmail', 'outreach', false, null, null], // campaign and legacy sends
    ['microsoft', 'outreach', true, 'list_unsubscribe_headers', null],
    ['gmail', 'outreach', false, 'footer_and_reply', /only for Zoho Mail/],
    ['microsoft', 'outreach', true, 'footer_and_reply', /only for Zoho Mail/],
    ['gmail', 'outreach', false, 'list_unsubscribe_headers', /was not approved with it/],
    // Zoho Mail: the one exception, and only for outreach approved in footer_and_reply.
    ['zoho-mail', 'outreach', false, 'footer_and_reply', null],
    ['zoho-mail', 'outreach', true, 'list_unsubscribe_headers', /cannot send the one-click/],
    ['zoho-mail', 'outreach', true, 'footer_and_reply', /cannot send the one-click/],
    ['zoho-mail', 'outreach', false, null, /not approved for Zoho Mail/],
    ['zoho-mail', 'outreach', false, 'list_unsubscribe_headers', /not approved for Zoho Mail/],
    ['zoho-mail', 'reply', false, null, /only approved outreach/],
    ['zoho-mail', 'other', false, 'footer_and_reply', /only approved outreach/]
  ];

  it.each(cases)(
    '%s %s requireListUnsubscribe=%s mode=%s',
    (provider, purpose, requireListUnsubscribe, unsubscribeMode, refusal) => {
      const check = () =>
        assertUnsubscribeModeAllowed({
          provider,
          purpose,
          requireListUnsubscribe,
          unsubscribeMode
        });
      if (!refusal) {
        expect(check).not.toThrow();
        return;
      }
      expect(check).toThrow(refusal);
      try {
        check();
      } catch (error) {
        expect(error).toBeInstanceOf(UnsubscribePolicyError);
        expect((error as UnsubscribePolicyError).status).toBe(409);
        expect((error as Error).message).toContain('nothing was sent');
      }
    }
  );
});
```

- [ ] **Step 2: Write the failing adapter tests**

Create `src/server/email/zoho-mail.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  ZohoMailError,
  parseZohoHeaders,
  pickZohoAccount,
  pickZohoFolderId,
  readZohoAccount,
  readZohoSentMessageId,
  sendZohoMessage,
  zohoHeaderValue,
  zohoMessageId,
  type ZohoNango
} from './zoho-mail.js';

const CONNECTION = { providerConfigKey: 'trevra-zoho-mail', connectionId: 'zoho-external' };
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'Founder@Acme.test'
};

function fakeNango(
  get: (config: { endpoint: string }) => Promise<unknown>,
  post: (config: { endpoint: string }) => Promise<unknown> = async () => ({ data: {} })
) {
  const nango = { get: vi.fn(get), post: vi.fn(post) };
  return { nango, client: nango as unknown as ZohoNango };
}

describe('Zoho Mail response parsing', () => {
  it('picks exactly one Zoho account and lowercases its address', () => {
    expect(pickZohoAccount({ data: [ACCOUNT] })).toEqual({
      accountId: '1000000001',
      address: 'founder@acme.test'
    });
    expect(pickZohoAccount({ data: [{ ...ACCOUNT, accountId: 1000000001 }] })?.accountId).toBe(
      '1000000001'
    );
    expect(
      pickZohoAccount({
        data: [{ ...ACCOUNT, primaryEmailAddress: undefined, mailboxAddress: 'a@acme.test' }]
      })
    ).toEqual({ accountId: '1000000001', address: 'a@acme.test' });
  });

  it('refuses an ambiguous, empty or foreign account list', () => {
    expect(pickZohoAccount({ data: [ACCOUNT, { ...ACCOUNT, accountId: '2' }] })).toBeNull();
    expect(pickZohoAccount({ data: [] })).toBeNull();
    expect(pickZohoAccount({})).toBeNull();
    expect(pickZohoAccount({ data: [{ ...ACCOUNT, type: 'POP_ACCOUNT' }] })).toBeNull();
    expect(
      pickZohoAccount({ data: [{ ...ACCOUNT, primaryEmailAddress: 'not-an-address' }] })
    ).toBeNull();
    // A POP account beside the Zoho account does not make it ambiguous.
    expect(
      pickZohoAccount({ data: [ACCOUNT, { ...ACCOUNT, accountId: '3', type: 'POP_ACCOUNT' }] })
    ).toEqual({ accountId: '1000000001', address: 'founder@acme.test' });
  });

  it('finds the inbox or sent folder by type before name', () => {
    const folders = {
      data: [
        { folderId: '11', folderName: 'Sent', folderType: 'Inbox' },
        { folderId: '12', folderName: 'Inbox', folderType: 'Sent' },
        { folderId: '13', folderName: 'Drafts', folderType: 'Drafts' }
      ]
    };
    expect(pickZohoFolderId(folders, 'inbox')).toBe('11');
    expect(pickZohoFolderId(folders, 'sent')).toBe('12');
    expect(pickZohoFolderId({ data: [{ folderId: 21, folderName: 'Sent' }] }, 'sent')).toBe('21');
    expect(pickZohoFolderId({ data: [] }, 'inbox')).toBeNull();
    expect(pickZohoFolderId('nope', 'inbox')).toBeNull();
  });

  it('parses a raw header block, a headerContent block and a name-to-value map', () => {
    const block =
      'Message-ID: <abc@mx.zoho.test>\r\nSubject: Long\r\n subject line\r\nFrom: Ada <ada@prospect.test>';
    const fromString = parseZohoHeaders({ data: block });
    expect(zohoHeaderValue(fromString, 'subject')).toBe('Long subject line');
    expect(zohoMessageId(fromString)).toBe('<abc@mx.zoho.test>');

    const fromContent = parseZohoHeaders({ data: { headerContent: block } });
    expect(zohoHeaderValue(fromContent, 'FROM')).toBe('Ada <ada@prospect.test>');

    const fromMap = parseZohoHeaders({
      data: { 'Message-Id': ['<def@mx.zoho.test>'], Subject: 'Hi', Ignored: 7 }
    });
    expect(zohoMessageId(fromMap)).toBe('<def@mx.zoho.test>');
    expect(zohoHeaderValue(fromMap, 'ignored')).toBeNull();

    expect(parseZohoHeaders({})).toEqual([]);
    expect(zohoMessageId([{ name: 'Message-ID', value: 'no brackets' }])).toBeNull();
  });
});

describe('Zoho Mail calls', () => {
  it('reads the one account through the proxy', async () => {
    const { nango, client } = fakeNango(async () => ({ data: { data: [ACCOUNT] } }));
    await expect(readZohoAccount(client, CONNECTION)).resolves.toEqual({
      accountId: '1000000001',
      address: 'founder@acme.test'
    });
    expect(nango.get).toHaveBeenCalledWith({
      endpoint: '/api/accounts',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-external',
      retries: 3
    });
  });

  it('refuses to name a sender when the token sees two Zoho accounts', async () => {
    const { client } = fakeNango(async () => ({
      data: { data: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'b@acme.test' }] }
    }));
    await expect(readZohoAccount(client, CONNECTION)).rejects.toBeInstanceOf(ZohoMailError);
  });

  it('sends plain text once, with no retry, and returns the message id', async () => {
    const { nango, client } = fakeNango(
      async () => ({ data: {} }),
      async () => ({ data: { status: { code: 200 }, data: { messageId: 1777 } } })
    );
    await expect(
      sendZohoMessage(client, CONNECTION, {
        accountId: '1000000001',
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: 'Hi Maya,\n\nWould you be open to a short conversation?'
      })
    ).resolves.toEqual({ messageId: '1777' });
    expect(nango.post).toHaveBeenCalledWith({
      endpoint: '/api/accounts/1000000001/messages',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-external',
      retries: 0,
      data: {
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: 'Hi Maya,\n\nWould you be open to a short conversation?',
        mailFormat: 'plaintext',
        encoding: 'UTF-8'
      }
    });

    const { client: silent } = fakeNango(
      async () => ({ data: {} }),
      async () => ({ data: { status: { code: 200 } } })
    );
    await expect(
      sendZohoMessage(silent, CONNECTION, {
        accountId: '1',
        fromAddress: 'a@acme.test',
        toAddress: 'b@prospect.test',
        subject: 's',
        content: 'c'
      })
    ).resolves.toEqual({ messageId: null });
  });

  it('reads the sent Message-ID back from the Sent folder header', async () => {
    const { nango, client } = fakeNango(async ({ endpoint }) => {
      if (endpoint === '/api/accounts/1000000001/folders') {
        return { data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] } };
      }
      if (endpoint === '/api/accounts/1000000001/folders/9/messages/1777/header') {
        return { data: { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } } };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    await expect(
      readZohoSentMessageId(client, CONNECTION, { accountId: '1000000001', messageId: '1777' })
    ).resolves.toBe('<zoho-1777@mx.zoho.test>');
    expect(nango.get).toHaveBeenCalledTimes(2);
  });

  it('returns null, never throws, when the read-back fails, finds no folder or never answers', async () => {
    const failing = fakeNango(async () => {
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    });
    await expect(
      readZohoSentMessageId(failing.client, CONNECTION, { accountId: '1', messageId: '2' })
    ).resolves.toBeNull();

    const noFolder = fakeNango(async () => ({ data: { data: [] } }));
    await expect(
      readZohoSentMessageId(noFolder.client, CONNECTION, { accountId: '1', messageId: '2' })
    ).resolves.toBeNull();

    const hanging = fakeNango(() => new Promise(() => undefined));
    await expect(
      readZohoSentMessageId(hanging.client, CONNECTION, { accountId: '1', messageId: '2' }, 10)
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe-policy.test.ts src/server/email/zoho-mail.test.ts`
Expected: FAIL, because `./unsubscribe-policy.js` and `./zoho-mail.js` do not exist.

- [ ] **Step 4: Implement the type and the policy**

Append to `src/server/email/types.ts`:

```ts
/**
 * How an outreach email carries its opt-out. See src/server/email/unsubscribe-policy.ts:
 * Gmail and Microsoft 365 always use RFC 8058 headers; Zoho Mail alone uses the
 * footer's reply-to-unsubscribe line.
 */
export type OutreachUnsubscribeMode = 'list_unsubscribe_headers' | 'footer_and_reply';
```

Create `src/server/email/unsubscribe-policy.ts`:

```ts
import { OUTREACH_OPT_OUT_SENTENCE } from './compliance.js';
import { mailProviderFor } from './deliverability.js';
import type { MailProvider, OutreachUnsubscribeMode } from './types.js';

/*
 * POLICY (Phase G, founder decision): how outreach email carries its opt-out.
 *
 * - Gmail and Microsoft 365 outreach MUST carry RFC 8058 List-Unsubscribe and
 *   List-Unsubscribe-Post headers (requireListUnsubscribe). Unchanged since Phase D.
 * - Zoho Mail outreach is the one exception. Zoho's REST send API cannot set
 *   those headers, and Trevra adds no SMTP path. Zoho outreach therefore carries
 *   its opt-out in the visible compliance footer, whose opt-out sentence is
 *   swapped for a reply-to-unsubscribe sentence. Inbound replies saying
 *   "unsubscribe" suppress the Person (src/server/email/inbound-mailbox.ts).
 *
 * The mode is chosen at prepare time from the sending connection's provider,
 * stored in the hashed approval payload, and enforced again here at send time,
 * before any delivery row or provider call. Nothing else may relax it.
 */

export const OUTREACH_UNSUBSCRIBE_MODES = [
  'list_unsubscribe_headers',
  'footer_and_reply'
] as const satisfies readonly OutreachUnsubscribeMode[];

/** The footer opt-out line Zoho outreach carries instead of the header-mode sentence. */
export const OUTREACH_REPLY_OPT_OUT_SENTENCE =
  'If you would rather not hear from me again, reply with "unsubscribe" and I will not email you again.';

export function outreachUnsubscribeModeFor(provider: MailProvider): OutreachUnsubscribeMode {
  return provider === 'zoho' ? 'footer_and_reply' : 'list_unsubscribe_headers';
}

export function parseOutreachUnsubscribeMode(value: unknown): OutreachUnsubscribeMode | null {
  return (OUTREACH_UNSUBSCRIBE_MODES as readonly unknown[]).includes(value)
    ? (value as OutreachUnsubscribeMode)
    : null;
}

/**
 * The compliance footer an outreach body must end with in this mode. In
 * footer_and_reply the header-mode opt-out sentence is replaced by the reply
 * sentence. It must appear exactly once [E-A3], or there is no safe footer and
 * the caller refuses (null).
 */
export function footerForUnsubscribeMode(
  footer: string,
  mode: OutreachUnsubscribeMode
): string | null {
  if (mode === 'list_unsubscribe_headers') return footer;
  const parts = footer.split(OUTREACH_OPT_OUT_SENTENCE);
  if (parts.length !== 2) return null;
  return parts.join(OUTREACH_REPLY_OPT_OUT_SENTENCE);
}

export class UnsubscribePolicyError extends Error {
  readonly status = 409;
}

/** Enforce the POLICY above for one send. Throws before any delivery row exists. */
export function assertUnsubscribeModeAllowed(input: {
  provider: string;
  purpose: 'outreach' | 'reply' | 'other';
  requireListUnsubscribe: boolean;
  unsubscribeMode: OutreachUnsubscribeMode | null;
}): void {
  if (mailProviderFor(input.provider) === 'zoho') {
    if (input.requireListUnsubscribe) {
      throw new UnsubscribePolicyError(
        'Zoho Mail cannot send the one-click unsubscribe header this email was approved with; nothing was sent.'
      );
    }
    if (input.purpose !== 'outreach') {
      throw new UnsubscribePolicyError(
        'Trevra sends only approved outreach email through Zoho Mail; nothing was sent.'
      );
    }
    if (input.unsubscribeMode !== 'footer_and_reply') {
      throw new UnsubscribePolicyError(
        'This outreach email was not approved for Zoho Mail, whose opt-out is the reply-to-unsubscribe footer; nothing was sent. Prepare it again.'
      );
    }
    return;
  }
  if (input.unsubscribeMode === 'footer_and_reply') {
    throw new UnsubscribePolicyError(
      'Reply-to-unsubscribe is allowed only for Zoho Mail; Gmail and Microsoft 365 outreach must carry the one-click unsubscribe header; nothing was sent.'
    );
  }
  if (input.unsubscribeMode === 'list_unsubscribe_headers' && !input.requireListUnsubscribe) {
    throw new UnsubscribePolicyError(
      'This outreach email names one-click unsubscribe but was not approved with it; nothing was sent.'
    );
  }
}
```

- [ ] **Step 5: Implement the Zoho Mail adapter**

Create `src/server/email/zoho-mail.ts`. Field names and paths are those Task 1 recorded. If S3/S4/S7 differ, change the parsers and the fixtures in Step 2 together.

```ts
import type { Nango } from '@nangohq/node';

/*
 * Zoho Mail through Nango's built-in `zoho-mail` provider (OAuth2; the
 * connection's `extension` picks the data centre: mail.zoho.<extension>).
 * Nango holds the token. The Zoho accountId is re-read per send and never
 * stored. Must not import integration-service.ts, which imports this module;
 * callers pass their Nango client.
 *
 * Response shapes are the ones recorded by the Phase G smoke test
 * (.superpowers/sdd/2026-10-07-gtm-g-zoho-mail/smoke-results.md).
 * nango-integrations/shared/zoho-mail.ts carries a copy of the pure parsers for
 * the sync; src/server/email/zoho-sync-helpers.test.ts keeps them equal.
 */

export const ZOHO_MAIL_PROVIDER = 'zoho-mail';

/**
 * Outreach emails one Zoho mailbox may send in a rolling 24 hours. Zoho
 * treats roughly 5,000 a day as bulk, so this stays at about 1% of that. The
 * operator's per-mailbox daily_limit can lower it, never raise it.
 */
export const ZOHO_OUTREACH_DAILY_CAP = 50;

/** Upper bound on the post-send Message-ID read; the send has already happened. */
export const ZOHO_MESSAGE_ID_READ_TIMEOUT_MS = 5_000;

export type ZohoNango = Pick<Nango, 'get' | 'post'>;
export interface ZohoConnection {
  providerConfigKey: string;
  connectionId: string;
}
export interface ZohoAccount {
  accountId: string;
  address: string;
}
export type ZohoHeader = { name: string; value: string };

export class ZohoMailError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function dataOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : undefined;
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** The one ZOHO_ACCOUNT the token can send from, or null when there is not exactly one. */
export function pickZohoAccount(body: unknown): ZohoAccount | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const accounts = list.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'ZOHO_ACCOUNT'
  );
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  const accountId = idText(account.accountId);
  const raw = account.primaryEmailAddress ?? account.mailboxAddress;
  const address = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!accountId || !ADDRESS.test(address)) return null;
  return { accountId, address };
}

/** The id of the account's Inbox or Sent folder; folderType wins over folderName. */
export function pickZohoFolderId(body: unknown, kind: 'inbox' | 'sent'): string | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const folders = list.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
  );
  const named = (field: 'folderType' | 'folderName') =>
    folders.find(
      (folder) =>
        String(folder[field] ?? '')
          .trim()
          .toLowerCase() === kind
    );
  return idText((named('folderType') ?? named('folderName'))?.folderId);
}

function headerBlock(block: string): ZohoHeader[] {
  const headers: ZohoHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

/** Zoho's header endpoint: a raw block, { headerContent: block }, or a name-to-value map. */
export function parseZohoHeaders(body: unknown): ZohoHeader[] {
  const data = dataOf(body);
  if (typeof data === 'string') return headerBlock(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const content = (data as { headerContent?: unknown }).headerContent;
  if (typeof content === 'string') return headerBlock(content);
  const map = content && typeof content === 'object' && !Array.isArray(content) ? content : data;
  const headers: ZohoHeader[] = [];
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') headers.push({ name, value: item.trim() });
    }
  }
  return headers;
}

export function zohoHeaderValue(headers: readonly ZohoHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === wanted)?.value ?? null;
}

/** The RFC 5322 msg-id, bounded exactly as the inbound sync bounds In-Reply-To ids. */
export function zohoMessageId(headers: readonly ZohoHeader[]): string | null {
  const match = /<[^<>\s]+>/.exec(zohoHeaderValue(headers, 'Message-ID') ?? '');
  return match ? match[0].slice(0, 998) : null;
}

function accountPath(accountId: string): string {
  return `/api/accounts/${encodeURIComponent(accountId)}`;
}

/** The account this connection sends from. Exactly one, or ZohoMailError. */
export async function readZohoAccount(
  nango: ZohoNango,
  connection: ZohoConnection
): Promise<ZohoAccount> {
  const response = await nango.get<unknown>({
    endpoint: '/api/accounts',
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.connectionId,
    retries: 3
  });
  const account = pickZohoAccount(response.data);
  if (!account) {
    throw new ZohoMailError(
      'This Zoho Mail connection does not resolve to exactly one Zoho mail account, so Trevra cannot tell which address it sends as. Reconnect the mailbox you send outreach from.'
    );
  }
  return account;
}

/**
 * One plain-text send. retries: 0, because Zoho's send API takes no
 * idempotency key; the gtm_deliveries claim is the only dedupe, and a send
 * that fails without a 4xx is recorded as uncertain and never resent.
 */
export async function sendZohoMessage(
  nango: ZohoNango,
  connection: ZohoConnection,
  input: {
    accountId: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    content: string;
  }
): Promise<{ messageId: string | null }> {
  const response = await nango.post<unknown>({
    endpoint: `${accountPath(input.accountId)}/messages`,
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.connectionId,
    retries: 0,
    data: {
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      subject: input.subject,
      content: input.content,
      mailFormat: 'plaintext',
      encoding: 'UTF-8'
    }
  });
  const data = dataOf(response.data);
  const messageId =
    data && typeof data === 'object' ? idText((data as { messageId?: unknown }).messageId) : null;
  return { messageId };
}

/**
 * The Message-ID Zoho actually sent, so a reply's In-Reply-To threads to it.
 * Any failure, a missing Sent folder, or the timeout returns null; the email
 * has already left, so this must never fail or retry the send.
 *
 * lc-debt: a timed-out read is abandoned, not aborted (the Nango SDK proxy takes no AbortSignal); upgrade path is passing an AbortSignal once the SDK accepts one.
 */
export async function readZohoSentMessageId(
  nango: ZohoNango,
  connection: ZohoConnection,
  input: { accountId: string; messageId: string },
  timeoutMs: number = ZOHO_MESSAGE_ID_READ_TIMEOUT_MS
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const read = (async () => {
      const folders = await nango.get<unknown>({
        endpoint: `${accountPath(input.accountId)}/folders`,
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.connectionId,
        retries: 0
      });
      const sentFolderId = pickZohoFolderId(folders.data, 'sent');
      if (!sentFolderId) return null;
      const header = await nango.get<unknown>({
        endpoint: `${accountPath(input.accountId)}/folders/${encodeURIComponent(sentFolderId)}/messages/${encodeURIComponent(input.messageId)}/header`,
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.connectionId,
        retries: 0
      });
      return zohoMessageId(parseZohoHeaders(header.data));
    })().catch(() => null);
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/unsubscribe-policy.test.ts src/server/email/zoho-mail.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email/types.ts src/server/email/unsubscribe-policy.ts src/server/email/unsubscribe-policy.test.ts src/server/email/zoho-mail.ts src/server/email/zoho-mail.test.ts
git commit -m "feat(email): Zoho Mail adapter and provider-aware unsubscribe policy" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 6: Zoho mailbox identity, catalog entry and listing

**Files:**

- Modify: `src/server/email/mailbox-address.ts` (`listSendingMailboxes` SQL, `readProviderAddress`)
- Modify: `src/server/integration-service.ts` (catalog entry; `requiredMailbox` SQL; a comment on the unbound fallback)
- Modify: `src/server/email/channel.ts` (status rows gain `unsubscribeMode` and `dailyCap`; designate copy)
- Modify: `src/server/email/types.ts` (`EmailChannelStatus` mailbox rows)
- Modify: `src/client/EmailChannelSummary.test.tsx` (fixture fields)
- Test: `src/server/email/zoho-mailbox.test.ts`

**Interfaces:**

- Consumes:
  - From Task 5: `readZohoAccount`, `ZOHO_OUTREACH_DAILY_CAP` and `outreachUnsubscribeModeFor`.
  - From Task 3: `mailProviderFor('zoho-mail') === 'zoho'`.
- Produces:
  - `listSendingMailboxes` returns Zoho rows with `providerKey: 'zoho'`.
  - The catalog key `zoho-mail` → integration id `NANGO_ZOHO_MAIL_INTEGRATION` or `trevra-zoho-mail`.
  - `EmailChannelStatus['mailboxes'][number]` gains `unsubscribeMode: OutreachUnsubscribeMode` and `dailyCap: number | null`.
  - A bound send (`require_connection_id: true`) may resolve a Zoho connection.

- [ ] **Step 1: Write the failing tests**

Create `src/server/email/zoho-mailbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {} as unknown, headers: {} }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
  }
}));

import { openDatabase, type Db } from '../db.js';
import {
  defaultConnectSessionIntegrations,
  listAvailableIntegrations
} from '../integration-service.js';
import { getEmailChannelStatus } from './channel.js';
import type { DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';

const WORKSPACE = 'ws_email_zoho_mailbox';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'Founder@Acme.test'
};
const noDns: DnsResolver = {
  async resolveTxt(name: string) {
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  }
};
let db: Db;

async function insertConnection(
  id: string,
  provider: 'zoho-mail' | 'gmail',
  address: string | null,
  updatedAt = NOW
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,'connected',0,?,?,?)`
    )
    .run(
      id,
      WORKSPACE,
      provider,
      `trevra-${provider}`,
      `${id}-external`,
      address,
      NOW.toISOString(),
      updatedAt.toISOString()
    );
}

async function cachedAddress(id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT mailbox_address FROM connections WHERE workspace_id=? AND id=?')
    .get<{ mailbox_address: string | null }>(WORKSPACE, id);
  return row?.mailbox_address ?? null;
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho mailbox', NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail mailbox identity', () => {
  it('lists a connected Zoho Mail connection as a zoho sending mailbox', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    expect(await listSendingMailboxes(db, WORKSPACE)).toEqual([
      {
        connectionId: 'conn_zoho',
        provider: 'zoho-mail',
        providerKey: 'zoho',
        displayName: null,
        address: null,
        providerConfigKey: 'trevra-zoho-mail',
        externalConnectionId: 'conn_zoho-external'
      }
    ]);
  });

  it('reads the one Zoho account address through Nango and caches it lowercase', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    nangoMock.get.mockResolvedValueOnce({ data: { data: [ACCOUNT] }, headers: {} });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBe('founder@acme.test');
    expect(nangoMock.get).toHaveBeenCalledWith({
      endpoint: '/api/accounts',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'conn_zoho-external',
      retries: 3
    });
    expect(await cachedAddress('conn_zoho')).toBe('founder@acme.test');
  });

  it('caches no address when the token sees two Zoho accounts', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    nangoMock.get.mockResolvedValueOnce({
      data: {
        data: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'other@acme.test' }]
      },
      headers: {}
    });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    expect(await cachedAddress('conn_zoho')).toBeNull();
  });

  it('offers Zoho Mail in the catalog and in the Connect allow-list', async () => {
    const integrations = await listAvailableIntegrations(db, WORKSPACE);
    expect(integrations.find((item) => item.provider === 'zoho-mail')).toMatchObject({
      key: 'trevra-zoho-mail',
      name: 'Zoho Mail',
      category: 'communication',
      mode: 'oauth'
    });
    expect(defaultConnectSessionIntegrations()).toContain('trevra-zoho-mail');
    vi.stubEnv('NANGO_ZOHO_MAIL_INTEGRATION', 'zoho-mail-eu');
    expect(defaultConnectSessionIntegrations()).toContain('zoho-mail-eu');
  });

  it('reports the reply-only unsubscribe and the daily cap on Zoho rows only', async () => {
    await insertConnection(
      'conn_zoho',
      'zoho-mail',
      'founder@acme.test',
      new Date(NOW.getTime() + 1000)
    );
    await insertConnection('conn_gmail', 'gmail', 'founder@beta.test');
    const status = await getEmailChannelStatus(db, WORKSPACE, { resolver: noDns, now: NOW });
    expect(
      status.mailboxes.map(({ connectionId, unsubscribeMode, dailyCap }) => ({
        connectionId,
        unsubscribeMode,
        dailyCap
      }))
    ).toEqual([
      {
        connectionId: 'conn_zoho',
        unsubscribeMode: 'footer_and_reply',
        dailyCap: ZOHO_OUTREACH_DAILY_CAP
      },
      { connectionId: 'conn_gmail', unsubscribeMode: 'list_unsubscribe_headers', dailyCap: null }
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-mailbox.test.ts`
Expected: FAIL. `listSendingMailboxes` returns `[]` for `zoho-mail`, the catalog has no Zoho entry, and the rows lack `unsubscribeMode`.

- [ ] **Step 3: Implement identity and listing**

In `src/server/email/mailbox-address.ts`:

- Add `import { readZohoAccount } from './zoho-mail.js';`.
- Change the `listSendingMailboxes` doc comment to `/** Live (non-demo) connected Gmail / Microsoft 365 / Zoho Mail mailboxes, newest first. */`.
- Change its provider filter to `AND provider IN ('gmail','google-mail','microsoft','outlook','zoho-mail')`.
- Add this branch at the top of `readProviderAddress`, after `const nango = getNango();`:

```ts
if (mailbox.providerKey === 'zoho') {
  // Exactly one Zoho account, or no address: readZohoAccount throws on an
  // ambiguous list and resolveMailboxAddress then caches nothing.
  const account = await readZohoAccount(nango, {
    providerConfigKey: mailbox.providerConfigKey,
    connectionId: mailbox.externalConnectionId
  });
  return account.address;
}
```

In the doc comment of `resolveMailboxAddress`, change `(Gmail users/me/profile, Graph /me)` to `(Gmail users/me/profile, Graph /me, Zoho /api/accounts)`.

- [ ] **Step 4: Implement the catalog entry and the bound-mailbox query**

In `src/server/integration-service.ts`, insert this entry directly after the `microsoft` catalog entry:

```ts
  // Nango's built-in zoho-mail provider (OAuth2; the Connect UI asks for the
  // data-centre extension). Outreach only, from the approved mailbox, with the
  // reply-to-unsubscribe footer (src/server/email/unsubscribe-policy.ts).
  {
    key: 'zoho-mail',
    provider: 'zoho-mail',
    name: 'Zoho Mail',
    category: 'communication',
    description:
      'Send approved outreach email from Zoho Mail and read replies into Conversations.',
    mode: 'oauth',
    env: 'NANGO_ZOHO_MAIL_INTEGRATION',
    fallback: 'trevra-zoho-mail'
  },
```

In `executeConnectedAction`, change the `requiredMailbox` string's provider list to `provider IN ('gmail','google-mail','microsoft','outlook','zoho-mail')`. Directly above the unbound fallback query (`"SELECT * FROM connections WHERE workspace_id=? AND status='connected' AND provider IN ('gmail','google-mail','microsoft','outlook') ORDER BY is_demo ASC,updated_at DESC LIMIT 1"`), add this comment and leave the query unchanged:

```ts
// Zoho Mail is deliberately absent: it sends only outreach bound to it by
// approval (require_connection_id), never as the newest-mailbox fallback
// for campaign, skill or legacy sends that expect List-Unsubscribe or threading.
```

- [ ] **Step 5: Implement the channel status fields and copy**

In `src/server/email/types.ts`, extend the mailbox row type (from Task 4) to:

```ts
mailboxes: Array<
  EmailChannelMailbox & {
    deliverability: StoredDeliverability | null;
    /** The owner-set DKIM selector for this mailbox's sending domain. */
    dkimSelector: string | null;
    /** How outreach from this mailbox carries its opt-out. */
    unsubscribeMode: OutreachUnsubscribeMode;
    /** Outreach emails per rolling 24 hours this provider allows at most, or null for the operator setting alone. */
    dailyCap: number | null;
  }
>;
```

In `src/server/email/channel.ts`, add `import { outreachUnsubscribeModeFor } from './unsubscribe-policy.js';` and `import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';`. In `getEmailChannelStatus`'s row object, add these two lines after `dkimSelector`:

```ts
        unsubscribeMode: outreachUnsubscribeModeFor(mailbox.providerKey),
        dailyCap: mailbox.providerKey === 'zoho' ? ZOHO_OUTREACH_DAILY_CAP : null,
```

In `designateInboundMailbox`, change the 404 message to `'Connect this Gmail, Microsoft 365 or Zoho Mail mailbox before using it for inbound mail.'`.

In `src/client/EmailChannelSummary.test.tsx`, add `unsubscribeMode: 'list_unsubscribe_headers',` and `dailyCap: null,` to `MAILBOX` after `dkimSelector: null,`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-mailbox.test.ts src/server/email/channel-api.test.ts src/server/integration-service.test.ts src/client/EmailChannelSummary.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email/mailbox-address.ts src/server/integration-service.ts src/server/email/channel.ts src/server/email/types.ts src/client/EmailChannelSummary.test.tsx src/server/email/zoho-mailbox.test.ts
git commit -m "feat(email): list and identify Zoho Mail mailboxes" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 7: Send approved outreach through Zoho Mail in `executeConnectedAction`

**Files:**

- Modify: `src/server/integration-service.ts` (`executeConnectedAction`: the policy check before the claim; the Zoho branch)
- Test: `src/server/email/zoho-send.test.ts`

**Interfaces:**

- Consumes:
  - From Task 5: `assertUnsubscribeModeAllowed`, `parseOutreachUnsubscribeMode`, `readZohoAccount`, `sendZohoMessage`, `readZohoSentMessageId`, `ZohoMailError` and `ZOHO_MAIL_PROVIDER`.
  - From Task 3: `mailProviderFor`.
  - From Task 6: the bound-mailbox query includes `zoho-mail`.
- Produces:
  - For `connection.provider = 'zoho-mail'`: one `POST /api/accounts/{accountId}/messages`, then `gtm_deliveries` set to `status='sent'`, `provider='zoho-mail'`, `external_ref=<Zoho messageId>`, and `internet_message_id=<read-back or NULL>`.
  - The return value is `{ provider: 'zoho-mail', externalRef }`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/email/zoho-send.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: { endpoint: string }): Promise<unknown> => ({
    data: {},
    headers: {}
  })),
  post: vi.fn(async (_config: { endpoint: string }): Promise<unknown> => ({
    data: {},
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';

const WORKSPACE = 'ws_email_zoho_send';
const ZOHO = 'conn_email_zoho_send';
const GMAIL = 'conn_email_zoho_send_gmail';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'founder@acme.test'
};
const ZOHO_OUTREACH = {
  deliveryPurpose: 'outreach',
  deliverySourceType: 'email_outreach',
  deliverySourceId: 'eo_zoho_send_1',
  unsubscribeMode: 'footer_and_reply',
  requireListUnsubscribe: false
};
let db: Db;

function zohoProvider(
  options: { accounts?: unknown[]; header?: unknown; send?: () => Promise<unknown> } = {}
) {
  nangoMock.get.mockImplementation(async ({ endpoint }) => {
    if (endpoint === '/api/accounts')
      return { data: { data: options.accounts ?? [ACCOUNT] }, headers: {} };
    if (endpoint === '/api/accounts/1000000001/folders') {
      return {
        data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] },
        headers: {}
      };
    }
    if (endpoint === '/api/accounts/1000000001/folders/9/messages/1777/header') {
      if (options.header instanceof Error) throw options.header;
      return {
        data: options.header ?? { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } },
        headers: {}
      };
    }
    throw new Error(`unexpected GET ${endpoint}`);
  });
  nangoMock.post.mockImplementation(
    options.send ??
      (async () => ({ data: { status: { code: 200 }, data: { messageId: '1777' } }, headers: {} }))
  );
}

function send(
  overrides: { connectionId?: string; payload?: Record<string, unknown>; key?: string } = {}
) {
  return executeConnectedAction(db, WORKSPACE, {
    type: 'email_draft',
    connection_id: overrides.connectionId ?? ZOHO,
    require_connection_id: true,
    recipient: 'maya@prospect.test',
    subject: 'Quick question, Maya',
    body: 'Hi Maya,\n\nWould you be open to a short conversation?',
    structured_payload_json: JSON.stringify(overrides.payload ?? ZOHO_OUTREACH),
    payload_hash: overrides.key ?? 'zoho-send-key-0001'
  });
}

async function deliveries() {
  return db
    .prepare(
      `SELECT status,provider,external_ref,internet_message_id,connection_id FROM gtm_deliveries
       WHERE workspace_id=? ORDER BY created_at`
    )
    .all<Record<string, unknown>>(WORKSPACE);
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockReset();
  nangoMock.post.mockReset();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho send', NOW.toISOString());
  for (const [id, provider] of [
    [ZOHO, 'zoho-mail'],
    [GMAIL, 'gmail']
  ] as const) {
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
          mailbox_address,created_at,updated_at)
         VALUES (?,?,?,?,?,NULL,'connected',0,'founder@acme.test',?,?)`
      )
      .run(
        id,
        WORKSPACE,
        provider,
        `trevra-${provider}`,
        `${provider}-external`,
        NOW.toISOString(),
        NOW.toISOString()
      );
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail outreach send', () => {
  it('sends the exact approved text once from the approved address and records the delivery', async () => {
    zohoProvider();
    await expect(send()).resolves.toEqual({ provider: 'zoho-mail', externalRef: '1777' });
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    expect(nangoMock.post.mock.calls[0]![0]).toEqual({
      endpoint: '/api/accounts/1000000001/messages',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-mail-external',
      retries: 0,
      data: {
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: 'Hi Maya,\n\nWould you be open to a short conversation?',
        mailFormat: 'plaintext',
        encoding: 'UTF-8'
      }
    });
    expect(JSON.stringify(nangoMock.post.mock.calls)).not.toContain('List-Unsubscribe');
    expect(await deliveries()).toEqual([
      {
        status: 'sent',
        provider: 'zoho-mail',
        external_ref: '1777',
        internet_message_id: '<zoho-1777@mx.zoho.test>',
        connection_id: ZOHO
      }
    ]);
    // A replay of the same approval never sends again.
    await expect(send()).resolves.toEqual({ provider: 'zoho-mail', externalRef: '1777' });
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the sent delivery with no Message-ID when the read-back fails', async () => {
    zohoProvider({ header: Object.assign(new Error('HTTP 500'), { status: 500 }) });
    await send();
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'sent', external_ref: '1777', internet_message_id: null })
    ]);
  });

  it('refuses Zoho outreach approved with List-Unsubscribe or without reply mode, before any delivery row', async () => {
    zohoProvider();
    await expect(
      send({
        payload: {
          ...ZOHO_OUTREACH,
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers'
        }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/cannot send the one-click/)
    });
    await expect(
      send({
        payload: {
          deliveryPurpose: 'outreach',
          deliverySourceType: 'email_outreach',
          deliverySourceId: 'x'
        }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/not approved for Zoho Mail/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('refuses Gmail outreach approved in reply-only mode, before any delivery row', async () => {
    await expect(send({ connectionId: GMAIL })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/only for Zoho Mail/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('sends nothing when the Zoho token now answers as another account or as two accounts', async () => {
    zohoProvider({ accounts: [{ ...ACCOUNT, primaryEmailAddress: 'someone@else.test' }] });
    await expect(send()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/sends as a different address/)
    });
    zohoProvider({
      accounts: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'b@acme.test' }]
    });
    await expect(
      send({
        key: 'zoho-send-key-0002',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_2' }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/exactly one Zoho mail account/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    // Nothing left Zoho, so both deliveries stay retryable.
    expect((await deliveries()).map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('marks a rejected send failed and an ambiguous one uncertain', async () => {
    zohoProvider({
      send: async () => Promise.reject(Object.assign(new Error('HTTP 400'), { status: 400 }))
    });
    await expect(send()).rejects.toThrow('HTTP 400');
    zohoProvider({ send: async () => Promise.reject(new Error('socket hang up')) });
    await expect(
      send({
        key: 'zoho-send-key-0003',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_3' }
      })
    ).rejects.toThrow('socket hang up');
    expect((await deliveries()).map((row) => String(row.status)).sort()).toEqual([
      'failed',
      'uncertain'
    ]);
  });

  it('refuses a threaded or HTML Zoho send without calling the send endpoint', async () => {
    zohoProvider();
    await expect(
      send({ payload: { ...ZOHO_OUTREACH, threaded: true, threadExternalRef: 'zoho-earlier' } })
    ).rejects.toMatchObject({ status: 409 });
    expect(nangoMock.post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-send.test.ts`
Expected: FAIL. Zoho sends throw `Provider zoho-mail cannot execute email_draft`, and the Gmail reply-only send goes out.

- [ ] **Step 3: Enforce the policy before the claim**

In `src/server/integration-service.ts`, add these imports:

```ts
import { mailProviderFor } from './email/deliverability.js';
import {
  assertUnsubscribeModeAllowed,
  parseOutreachUnsubscribeMode
} from './email/unsubscribe-policy.js';
import {
  ZOHO_MAIL_PROVIDER,
  ZohoMailError,
  readZohoAccount,
  readZohoSentMessageId,
  sendZohoMessage
} from './email/zoho-mail.js';
```

In `executeConnectedAction`, insert directly before `const localConnectionId = String(connection.id);`:

```ts
const requireListUnsubscribe = structuredPayload.requireListUnsubscribe === true;
// The one provider-aware unsubscribe decision (src/server/email/unsubscribe-policy.ts),
// enforced before any delivery row so a refusal leaves nothing to retry.
assertUnsubscribeModeAllowed({
  provider,
  purpose,
  requireListUnsubscribe,
  unsubscribeMode: parseOutreachUnsubscribeMode(structuredPayload.unsubscribeMode)
});
```

Delete the later line `const requireListUnsubscribe = structuredPayload.requireListUnsubscribe === true;`, which follows the RFC 8058 comment block. Keep the comment block. The variable is now declared above, and every later use is unchanged.

- [ ] **Step 4: Add the Zoho branch**

Inside the `try {` that holds the provider calls, directly before `if (!['gmail', 'google-mail'].includes(provider))`, insert:

```ts
if (mailProviderFor(provider) === 'zoho') {
  // Zoho sends only plain first-touch outreach approved in footer_and_reply
  // mode (checked above). No threading: its Message-ID cannot be set and a
  // follow-up could not thread reliably.
  if (threadExternalRef || threadIdempotencyKey || htmlBody) {
    throw new ZohoMailError(
      'Zoho Mail sends only plain first-touch outreach from Trevra; this email asks for threading or HTML, so nothing was sent.'
    );
  }
  const zohoConnection = { providerConfigKey, connectionId };
  let account: Awaited<ReturnType<typeof readZohoAccount>>;
  try {
    account = await readZohoAccount(nango, zohoConnection);
  } catch (error) {
    // Nothing has been sent yet, so this is a definite, retryable failure.
    throw error instanceof ZohoMailError
      ? error
      : new ZohoMailError(
          `Trevra could not confirm which Zoho Mail account this connection sends as; nothing was sent. ${error instanceof Error ? error.message : String(error)}`
        );
  }
  const approvedAddress = String(connection.mailbox_address ?? '')
    .trim()
    .toLowerCase();
  if (!approvedAddress || account.address !== approvedAddress) {
    throw new ZohoMailError(
      'This Zoho Mail connection now sends as a different address than the approved mailbox; nothing was sent. Reconnect it and prepare the email again.'
    );
  }
  const sent = await sendZohoMessage(nango, zohoConnection, {
    accountId: account.accountId,
    fromAddress: approvedAddress,
    toAddress: recipient,
    subject: String(action.subject),
    content: String(action.body)
  });
  const outcome = {
    provider: ZOHO_MAIL_PROVIDER,
    externalRef: sent.messageId ?? id('zoho'),
    // Zoho writes its own Message-ID. Without the read-back there is no id
    // to thread on, and an unthreaded opt-out reply still suppresses
    // (src/server/email/inbound-mailbox.ts).
    internetMessageId: sent.messageId
      ? await readZohoSentMessageId(nango, zohoConnection, {
          accountId: account.accountId,
          messageId: sent.messageId
        })
      : null
  };
  await markEmailDeliverySent(db, deliveryId, outcome);
  return { provider: outcome.provider, externalRef: outcome.externalRef };
}
```

(`recipient`, `connection`, `providerConfigKey`, `connectionId`, `nango`, `deliveryId`, `threadExternalRef`, `threadIdempotencyKey` and `htmlBody` are the existing locals of `executeConnectedAction`. The surrounding `catch` already calls `markEmailDeliveryFailure`. A `ZohoMailError` (409) and a 4xx `status` become `failed`; anything else becomes `uncertain`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-send.test.ts src/server/integration-service.test.ts src/server/email/outreach-playbook.test.ts`
Expected: PASS. Every existing Gmail and Microsoft test is unchanged, because `unsubscribeMode` is absent from their payloads.

- [ ] **Step 6: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/integration-service.ts src/server/email/zoho-send.test.ts
git commit -m "feat(email): send approved outreach through Zoho Mail" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 8: Send-time Zoho daily cap

**Files:**

- Modify: `src/server/email-deliveries.ts` (`assertEmailDeliveryCapacity`; new `outreachDailyCap`, `sentOutreachInLastDay`)
- Test: `src/server/email-deliveries.test.ts`

**Interfaces:**

- Consumes:
  - From Task 5: `ZOHO_OUTREACH_DAILY_CAP`.
  - From Task 3: `mailProviderFor`.
- Produces:
  - `DEFAULT_OUTREACH_DAILY_CAP = 50`
  - `outreachDailyCap(db: Db, input: { workspaceId: string; connectionId: string | null }): Promise<number>`
  - `sentOutreachInLastDay(db: Db, input: { workspaceId: string; connectionId: string | null }, now?: Date): Promise<number>`
  - `assertEmailDeliveryCapacity` keeps its signature and its message, and now applies the Zoho ceiling.

- [ ] **Step 1: Write the failing tests**

In `src/server/email-deliveries.test.ts`, add `outreachDailyCap` and `sentOutreachInLastDay` to the `./email-deliveries.js` import, add `import { ZOHO_OUTREACH_DAILY_CAP } from './email/zoho-mail.js';`, and append inside the capacity `describe` (next to `'enforces the configured outreach cap while never consuming it for replies'`):

```ts
async function zohoMailbox(dailyLimit: number | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,status,is_demo,created_at,updated_at)
         VALUES ('conn_zoho_cap',?,'zoho-mail','trevra-zoho-mail','zoho-cap-mailbox','connected',0,?,?)`
    )
    .run(WORKSPACE, now, now);
  if (dailyLimit !== null) {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings
           (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
           VALUES (?,'conn_zoho_cap',?,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)`
      )
      .run(WORKSPACE, dailyLimit, now, now);
  }
}

async function seedSent(count: number, sentAt: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
         (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
          status,provider,external_ref,started_at,sent_at)
         SELECT 'gdel_zoho_cap_' || n, ?, 'email', 'conn_zoho_cap', 'outreach',
                'seed' || n || '@prospect.test', 'test', 'zoho-cap-' || n, 'zoho-cap-' || n,
                'sent', 'zoho-mail', 'zoho-' || n, ?::timestamptz, ?::timestamptz
         FROM generate_series(1, ?::int) AS n`
    )
    .run(WORKSPACE, sentAt.toISOString(), sentAt.toISOString(), count);
}

it('caps a Zoho mailbox at the Zoho ceiling even when the operator allows more', async () => {
  const now = new Date();
  await zohoMailbox(200);
  expect(
    await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' })
  ).toBe(ZOHO_OUTREACH_DAILY_CAP);
  await seedSent(ZOHO_OUTREACH_DAILY_CAP - 1, now);
  const capacity = {
    workspaceId: WORKSPACE,
    connectionId: 'conn_zoho_cap',
    purpose: 'outreach' as const
  };
  await expect(assertEmailDeliveryCapacity(db, capacity, now)).resolves.toBeUndefined();
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
         (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
          status,provider,external_ref,started_at,sent_at)
         VALUES ('gdel_zoho_cap_last',?,'email','conn_zoho_cap','outreach','last@prospect.test','test',
                 'zoho-cap-last','zoho-cap-last','sent','zoho-mail','zoho-last',?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, now.toISOString(), now.toISOString());
  expect(
    await sentOutreachInLastDay(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' }, now)
  ).toBe(ZOHO_OUTREACH_DAILY_CAP);
  await expect(assertEmailDeliveryCapacity(db, capacity, now)).rejects.toThrow(
    `Outbound email daily cap reached for this mailbox (${ZOHO_OUTREACH_DAILY_CAP}); no provider call was attempted.`
  );
  // Replies never consume or hit the outreach cap.
  await expect(
    assertEmailDeliveryCapacity(db, { ...capacity, purpose: 'reply' }, now)
  ).resolves.toBeUndefined();
});

it('lets the operator set a Zoho mailbox lower than the Zoho ceiling, and frees it after a day', async () => {
  const now = new Date();
  await zohoMailbox(5);
  expect(
    await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' })
  ).toBe(5);
  await seedSent(5, new Date(now.getTime() - 86_400_000 - 60_000));
  expect(
    await sentOutreachInLastDay(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' }, now)
  ).toBe(0);
  await expect(
    assertEmailDeliveryCapacity(
      db,
      { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap', purpose: 'outreach' },
      now
    )
  ).resolves.toBeUndefined();
});

it('keeps the default cap for a mailbox with no setting', async () => {
  expect(await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: null })).toBe(50);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email-deliveries.test.ts`
Expected: FAIL, because `outreachDailyCap` is not exported.

- [ ] **Step 3: Implement**

In `src/server/email-deliveries.ts`, add `import { mailProviderFor } from './email/deliverability.js';` and `import { ZOHO_OUTREACH_DAILY_CAP } from './email/zoho-mail.js';`. Then replace `assertEmailDeliveryCapacity` with:

```ts
/** Cold outreach has a safety ceiling even before the operator customizes a mailbox. */
export const DEFAULT_OUTREACH_DAILY_CAP = 50;

/**
 * Outreach emails this mailbox may send in a rolling 24 hours: the operator's
 * per-mailbox daily_limit (1-500, default 50), and never more than the
 * provider's own ceiling (Zoho Mail: ZOHO_OUTREACH_DAILY_CAP).
 */
export async function outreachDailyCap(
  db: Db,
  input: { workspaceId: string; connectionId: string | null }
): Promise<number> {
  if (!input.connectionId) return DEFAULT_OUTREACH_DAILY_CAP;
  const setting = await db
    .prepare(
      `SELECT daily_limit FROM linkedin_campaign_mailbox_settings
       WHERE workspace_id=? AND connection_id=?`
    )
    .get<{ daily_limit: number }>(input.workspaceId, input.connectionId);
  const cap = Math.max(
    1,
    Math.min(500, Number(setting?.daily_limit ?? DEFAULT_OUTREACH_DAILY_CAP))
  );
  const connection = await db
    .prepare('SELECT provider FROM connections WHERE workspace_id=? AND id=?')
    .get<{ provider: string }>(input.workspaceId, input.connectionId);
  return connection && mailProviderFor(connection.provider) === 'zoho'
    ? Math.min(cap, ZOHO_OUTREACH_DAILY_CAP)
    : cap;
}

/** Outreach emails this mailbox sent in the 24 hours before `now`. */
export async function sentOutreachInLastDay(
  db: Db,
  input: { workspaceId: string; connectionId: string | null },
  now = new Date()
): Promise<number> {
  const used = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM gtm_deliveries
       WHERE workspace_id=? AND purpose='outreach' AND status='sent'
         AND connection_id IS NOT DISTINCT FROM ?
         AND sent_at>=?::timestamptz`
    )
    .get<{ total: number }>(
      input.workspaceId,
      input.connectionId,
      new Date(now.getTime() - 86_400_000).toISOString()
    );
  return Number(used?.total ?? 0);
}

export async function assertEmailDeliveryCapacity(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string | null;
    purpose: EmailDeliveryPurpose;
  },
  now = new Date()
): Promise<void> {
  // Conversation replies declare purpose='reply' and never consume the cap.
  if (input.purpose !== 'outreach') return;
  const cap = await outreachDailyCap(db, input);
  if ((await sentOutreachInLastDay(db, input, now)) >= cap) {
    throw new EmailDeliveryCapacityError(
      `Outbound email daily cap reached for this mailbox (${cap}); no provider call was attempted.`
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email-deliveries.test.ts src/server/email/zoho-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email-deliveries.ts src/server/email-deliveries.test.ts
git commit -m "feat(email): Zoho Mail daily cap at send time" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 9: `gtm.email-outreach@1.1.0`, with the opt-out mode in the approved payload

**Files:**

- Modify: `src/server/playbooks/registry.ts` (new `emailOutreachPlaybookV1_1`; register it; `1.0.0` untouched)
- Modify: `src/server/email/outreach.ts` (`EMAIL_OUTREACH_PLAYBOOK_VERSION`; `startOutreachRun` pins it and passes the mode; `prepareEmailOutreach` derives the mode and the footer)
- Modify: `src/server/control-plane/execution.ts` (`assertOutreachFooter` checks the footer for the approved mode)
- Test: `src/server/email/outreach-playbook.test.ts`

**Interfaces:**

- Consumes:
  - From Task 5: `OUTREACH_UNSUBSCRIBE_MODES`, `outreachUnsubscribeModeFor`, `footerForUnsubscribeMode`, `parseOutreachUnsubscribeMode` and `OUTREACH_REPLY_OPT_OUT_SENTENCE`.
  - From Task 7: the Zoho send branch.
  - Phase E's `assertOutreachFooter` drift message [E-A4] and branch order [E-A5].
- Produces:
  - Playbook `gtm.email-outreach@1.1.0` adds two input fields, `unsubscribeMode: OutreachUnsubscribeMode` and `requireListUnsubscribe: boolean`. They must agree: `requireListUnsubscribe === (unsubscribeMode === 'list_unsubscribe_headers')`. Approval metadata carries both.
  - `EMAIL_OUTREACH_PLAYBOOK_VERSION = '1.1.0'`
  - `prepareEmailOutreach` starts `1.1.0` runs. A Zoho sender's bodies end with `footerForUnsubscribeMode(footer, 'footer_and_reply')`.
  - At send, an outreach body must end with the footer for its approved mode. A `1.0.0` approval counts as `list_unsubscribe_headers`.

- [ ] **Step 1: Update the existing playbook test helpers and expectation**

In `src/server/email/outreach-playbook.test.ts`:

- Add `import type { Mock } from 'vitest';`.
- Add `import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';`.
- Add `import type { OutreachUnsubscribeMode } from './types.js';`.

Below `const BODY = …`, add:

```ts
const ZOHO_FOOTER = `Acme Labs Ltd, 1 Market Street, London EC1A 1AA\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`;
const ZOHO_BODY = `Hi Maya,\n\nWould you be open to a short conversation?\n\n${ZOHO_FOOTER}`;
```

Change `prepareRun`'s parameter type to:

```ts
async function prepareRun(
  overrides: {
    idempotencyKey?: string;
    prepared?: boolean;
    version?: '1.0.0' | '1.1.0';
    unsubscribeMode?: OutreachUnsubscribeMode;
    requireListUnsubscribe?: boolean;
    body?: string;
  } = {}
) {
```

In its `startPlaybookRun` call:

- Add `...(overrides.version ? { version: overrides.version } : {}),` after `playbookId`.
- Change `body: BODY` to `body: overrides.body ?? BODY`.
- Append to the payload object, after `body`:

```ts
      ...(overrides.version === '1.0.0'
        ? {}
        : {
            unsubscribeMode: overrides.unsubscribeMode ?? 'list_unsubscribe_headers',
            requireListUnsubscribe:
              overrides.requireListUnsubscribe ??
              (overrides.unsubscribeMode ?? 'list_unsubscribe_headers') === 'list_unsubscribe_headers'
          })
```

In the first test, `'waits for approval of the exact email, then sends it from the approved mailbox'`, add `unsubscribeMode: 'list_unsubscribe_headers',` to the expected `metadata`, after `requireListUnsubscribe: true,`.

In `afterEach`, before `resetEmailComplianceProvider();`, add these lines so a Zoho implementation never leaks into the next test:

```ts
nangoMock.get.mockReset();
nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
nangoMock.post.mockReset();
nangoMock.post.mockResolvedValue({ data: { id: 'gmail-outreach-1' }, headers: {} });
```

Add this helper below `sendAttempts`:

```ts
/** Turn the test mailbox into a Zoho Mail connection that answers as founder@acme.test. */
async function useZohoMailbox(): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET provider='zoho-mail',provider_config_key='trevra-zoho-mail'
       WHERE workspace_id=? AND id=?`
    )
    .run(WORKSPACE, CONNECTION);
  (nangoMock.get as unknown as Mock).mockImplementation(
    async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === '/api/accounts') {
        return {
          data: {
            data: [
              {
                accountId: '1000000001',
                type: 'ZOHO_ACCOUNT',
                primaryEmailAddress: 'founder@acme.test'
              }
            ]
          },
          headers: {}
        };
      }
      if (endpoint === '/api/accounts/1000000001/folders') {
        return {
          data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] },
          headers: {}
        };
      }
      return {
        data: { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } },
        headers: {}
      };
    }
  );
  (nangoMock.post as unknown as Mock).mockResolvedValue({
    data: { status: { code: 200 }, data: { messageId: '1777' } },
    headers: {}
  });
}
```

- [ ] **Step 2: Write the failing tests**

Append inside `describe('gtm.email-outreach', …)`:

```ts
it('pins new runs to 1.1.0 and still resumes a 1.0.0 run with one-click headers', async () => {
  const { run: current } = await prepareRun({ idempotencyKey: 'eo_playbook_test_1_1_0' });
  // One open outreach run per Person (migration 133): end it before the 1.0.0 run.
  await reject(current.id);
  const { run: earlier } = await prepareRun({ version: '1.0.0' });
  const versions = await db
    .prepare(
      'SELECT id,playbook_version FROM playbook_runs WHERE workspace_id=? ORDER BY created_at'
    )
    .all<{ id: string; playbook_version: string }>(WORKSPACE);
  expect(Object.fromEntries(versions.map((row) => [row.id, row.playbook_version]))).toEqual({
    [current.id]: '1.1.0',
    [earlier.id]: '1.0.0'
  });
  expect(earlier.steps.find((step) => step.stepId === 'approve-outreach')?.input).toMatchObject({
    metadata: { requireListUnsubscribe: true }
  });
  expect(
    (
      earlier.steps.find((step) => step.stepId === 'approve-outreach')?.input as {
        metadata: Record<string, unknown>;
      }
    ).metadata
  ).not.toHaveProperty('unsubscribeMode');

  const done = await approve(earlier.id);
  expect(done.status).toBe('completed');
  const send = nangoMock.post.mock.calls[0]![0] as { data?: { raw?: string } };
  const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
  expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
});

it('refuses a 1.1.0 run whose opt-out mode and header flag disagree', async () => {
  await expect(
    prepareRun({ unsubscribeMode: 'footer_and_reply', requireListUnsubscribe: true })
  ).rejects.toThrow(/requireListUnsubscribe must be true exactly when/);
  await expect(
    prepareRun({ unsubscribeMode: 'list_unsubscribe_headers', requireListUnsubscribe: false })
  ).rejects.toThrow(/requireListUnsubscribe must be true exactly when/);
  expect(await outreachRuns()).toBe(0);
});

it('sends approved Zoho outreach with the reply-to-unsubscribe footer and no header', async () => {
  await useZohoMailbox();
  const { run } = await prepareRun({ unsubscribeMode: 'footer_and_reply', body: ZOHO_BODY });
  expect(run.steps.find((step) => step.stepId === 'approve-outreach')?.input).toMatchObject({
    body: ZOHO_BODY,
    metadata: { unsubscribeMode: 'footer_and_reply', requireListUnsubscribe: false }
  });

  const done = await approve(run.id);

  expect(done.status).toBe('completed');
  expect(nangoMock.post).toHaveBeenCalledTimes(1);
  expect(nangoMock.post.mock.calls[0]![0]).toMatchObject({
    endpoint: '/api/accounts/1000000001/messages',
    providerConfigKey: 'trevra-zoho-mail',
    connectionId: `${CONNECTION}-external`,
    retries: 0,
    data: { fromAddress: 'founder@acme.test', content: ZOHO_BODY, mailFormat: 'plaintext' }
  });
  expect(JSON.stringify(nangoMock.post.mock.calls)).not.toContain('List-Unsubscribe');
  expect(
    await db
      .prepare(
        'SELECT provider,status,internet_message_id FROM gtm_deliveries WHERE workspace_id=?'
      )
      .get(WORKSPACE)
  ).toEqual({
    provider: 'zoho-mail',
    status: 'sent',
    internet_message_id: '<zoho-1777@mx.zoho.test>'
  });
});

it('refuses a Zoho email whose body still ends with the one-click footer', async () => {
  await useZohoMailbox();
  const { run } = await prepareRun({ unsubscribeMode: 'footer_and_reply', body: BODY });

  const failed = await approve(run.id);

  expect(failed.status).toBe('failed');
  // [E-A4] Phase E's drift message.
  expect(failed.error).toMatch(
    /The sender details changed after this email was prepared; nothing was sent/
  );
  expect(nangoMock.post).not.toHaveBeenCalled();
  expect(await deliveries()).toBe(0);
});

it('refuses Gmail outreach approved in reply-only mode before any delivery', async () => {
  const { run } = await prepareRun({ unsubscribeMode: 'footer_and_reply', body: ZOHO_BODY });

  const failed = await approve(run.id);

  expect(failed.status).toBe('failed');
  expect(failed.error).toMatch(/Reply-to-unsubscribe is allowed only for Zoho Mail/);
  expect(nangoMock.post).not.toHaveBeenCalled();
  expect(await deliveries()).toBe(0);
});
```

(The test file's post-E `beforeEach` already seeds whatever E's send-time lawful-basis check needs [E-A5]. These tests add no seeding of their own.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-playbook.test.ts`
Expected: FAIL. Without `1.1.0`, the `.strict()` 1.0.0 schema rejects `unsubscribeMode`, and `assertOutreachFooter` rejects `ZOHO_BODY`.

- [ ] **Step 4: Add the playbook version**

In `src/server/playbooks/registry.ts`, add `import { OUTREACH_UNSUBSCRIBE_MODES } from '../email/unsubscribe-policy.js';`. Insert this definition directly after `emailOutreachPlaybook`, leaving `emailOutreachPlaybook` (1.0.0) byte-identical:

```ts
/**
 * 1.1.0 puts how the email carries its opt-out inside the hashed approval
 * payload (src/server/email/unsubscribe-policy.ts): one-click List-Unsubscribe
 * headers (Gmail, Microsoft 365) or the reply-to-unsubscribe footer (Zoho
 * Mail). 1.0.0 stays registered so runs prepared before it resume and send
 * exactly as approved; runs, indexes and unsubscribe lookups key on playbook_key.
 */
export const emailOutreachPlaybookV1_1: PlaybookDefinition = {
  id: 'gtm.email-outreach',
  version: '1.1.0',
  name: 'Outreach email',
  description:
    'Prepare one first-touch outreach email to a known Person from the approved mailbox, with one-click unsubscribe (Gmail, Microsoft 365) or a reply-to-unsubscribe footer (Zoho Mail), and require approval of the exact bytes before provider execution.',
  inputSchema: z
    .object({
      idempotencyKey: z.string().trim().min(8).max(200),
      conversationId: z.string().trim().min(1).max(160),
      personId: z.string().trim().min(1).max(160),
      contactId: z.string().trim().min(1).max(160),
      leadListId: z.string().trim().min(1).max(160),
      connectionId: z.string().trim().min(1).max(160),
      senderAddress: z.string().email(),
      recipient: z.string().email(),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000),
      unsubscribeMode: z.enum(OUTREACH_UNSUBSCRIBE_MODES),
      requireListUnsubscribe: z.boolean()
    })
    .strict()
    .superRefine((input, ctx) => {
      if (input.requireListUnsubscribe !== (input.unsubscribeMode === 'list_unsubscribe_headers')) {
        ctx.addIssue({
          code: 'custom',
          path: ['requireListUnsubscribe'],
          message:
            'requireListUnsubscribe must be true exactly when unsubscribeMode is list_unsubscribe_headers.'
        });
      }
    }),
  steps: [
    {
      id: 'approve-outreach',
      type: 'approval',
      title: 'Approve outreach email',
      payload: {
        recipient: { $ref: '$.input.recipient' },
        subject: { $ref: '$.input.subject' },
        body: { $ref: '$.input.body' },
        metadata: {
          conversationId: { $ref: '$.input.conversationId' },
          personId: { $ref: '$.input.personId' },
          contactId: { $ref: '$.input.contactId' },
          leadListId: { $ref: '$.input.leadListId' },
          connectionId: { $ref: '$.input.connectionId' },
          senderAddress: { $ref: '$.input.senderAddress' },
          requireListUnsubscribe: { $ref: '$.input.requireListUnsubscribe' },
          unsubscribeMode: { $ref: '$.input.unsubscribeMode' },
          deliveryPurpose: 'outreach',
          deliverySourceType: 'email_outreach',
          deliverySourceId: { $ref: '$.input.idempotencyKey' },
          conversationSourceType: 'email_outreach',
          conversationSourceId: { $ref: '$.input.idempotencyKey' },
          intent: 'email-outreach'
        }
      }
    },
    {
      id: 'send-outreach',
      type: 'action',
      actionType: 'email.send',
      approvalStepId: 'approve-outreach',
      needs: ['approve-outreach'],
      payload: { $ref: '$.steps.approve-outreach.input' },
      retry: { maxAttempts: 1, delaySeconds: 0 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-outreach.output.approved' },
    delivery: { $ref: '$.steps.send-outreach.output' },
    personId: { $ref: '$.input.personId' }
  },
  source: { type: 'builtin' },
  preparedOnly: true
};
```

Directly after `registerPlaybook(emailOutreachPlaybook);`, add `registerPlaybook(emailOutreachPlaybookV1_1);`.

- [ ] **Step 5: Check the footer for the approved mode at send time**

In `src/server/control-plane/execution.ts`, add:

```ts
import type { OutreachUnsubscribeMode } from '../email/types.js';
import {
  footerForUnsubscribeMode,
  parseOutreachUnsubscribeMode
} from '../email/unsubscribe-policy.js';
```

Change the outreach branch's footer call to:

```ts
await assertOutreachFooter(
  db,
  input.workspaceId,
  payload.body,
  // A 1.0.0 approval carries no mode; it was prepared for one-click headers.
  parseOutreachUnsubscribeMode(metadata.unsubscribeMode) ?? 'list_unsubscribe_headers'
);
```

Replace `assertOutreachFooter` with the version below. Keep the two messages exactly as Phase E left them [E-A4]: the footer-unavailable text and the drift text.

```ts
async function assertOutreachFooter(
  db: Db,
  workspaceId: string,
  body: string,
  mode: OutreachUnsubscribeMode
): Promise<void> {
  const footer = (await emailComplianceProvider().footer(db, workspaceId))?.trim() ?? '';
  if (!footer) {
    throw mailboxBindingError(
      'No compliance footer (legal name, postal address, opt-out line) is available for this workspace; nothing was sent.'
    );
  }
  // Zoho outreach (footer_and_reply) ends with the same footer, its opt-out
  // sentence swapped for reply-to-unsubscribe (src/server/email/unsubscribe-policy.ts).
  const expected = footerForUnsubscribeMode(footer, mode);
  if (!expected || !body.trimEnd().endsWith(expected)) {
    throw mailboxBindingError(
      'The sender details changed after this email was prepared; nothing was sent. Prepare it again.'
    );
  }
}
```

- [ ] **Step 6: Prepare 1.1.0 runs with the sender's mode**

In `src/server/email/outreach.ts`:

- Add `import { mailProviderFor } from './deliverability.js';`. Merge it into the existing `./deliverability.js` import, which already brings `emailDomainOf` and `DnsResolver`.
- Add `import { footerForUnsubscribeMode, outreachUnsubscribeModeFor } from './unsubscribe-policy.js';`.
- Add `OutreachUnsubscribeMode` to the `./types.js` type import.

Below `export const EMAIL_OUTREACH_PLAYBOOK_ID = 'gtm.email-outreach';`, add:

```ts
/** Every new run pins this version; 1.0.0 runs keep resuming as approved. */
export const EMAIL_OUTREACH_PLAYBOOK_VERSION = '1.1.0';
```

In `startOutreachRun`:

- Add `unsubscribeMode: OutreachUnsubscribeMode;` to the `run` parameter type.
- In the `startPlaybookRun` call, add `version: EMAIL_OUTREACH_PLAYBOOK_VERSION,` after `playbookId`.
- Append to the payload, after `body: run.body`:

```ts
        unsubscribeMode: run.unsubscribeMode,
        requireListUnsubscribe: run.unsubscribeMode === 'list_unsubscribe_headers'
```

In `prepareEmailOutreach`, directly after the `if (!footer) { … }` block, add:

```ts
// The opt-out mode comes from the sending connection itself, never from the
// plan: Zoho Mail cannot carry List-Unsubscribe (unsubscribe-policy.ts).
const sending = await db
  .prepare(
    `SELECT provider FROM connections
       WHERE workspace_id=? AND id=? AND status='connected' AND is_demo=0`
  )
  .get<{ provider: string }>(input.workspaceId, input.connectionId);
const providerKey = sending ? mailProviderFor(sending.provider) : null;
if (!providerKey) {
  throw new EmailOutreachError(
    'The mailbox this plan sends from is no longer connected. Plan again before preparing.'
  );
}
const unsubscribeMode = outreachUnsubscribeModeFor(providerKey);
const sentFooter = footerForUnsubscribeMode(footer, unsubscribeMode);
if (!sentFooter) {
  throw new EmailOutreachError(
    'Your compliance footer needs its opt-out line exactly once so Trevra can turn it into "reply unsubscribe" for Zoho Mail. Complete sender compliance in Workspace settings before preparing outreach email.'
  );
}
```

In the loop's `startOutreachRun` call, change `body: \`${email.body}\n\n${footer}\``to`body: \`${email.body}\n\n${sentFooter}\``, and add `unsubscribeMode,` after it.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/outreach-playbook.test.ts src/server/email/outreach.test.ts src/server/email/unsubscribe.test.ts src/server/email/unsubscribe-routes.test.ts src/server/playbooks/engine.test.ts`
Expected: PASS. `findUnsubscribeDelivery` still keys on `playbook_key`, so the `1.1.0` runs it finds are unchanged.

- [ ] **Step 8: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/playbooks/registry.ts src/server/email/outreach.ts src/server/control-plane/execution.ts src/server/email/outreach-playbook.test.ts
git commit -m "feat(email): outreach playbook 1.1.0 carries the opt-out mode" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 10: Zoho readiness, plan copy, and the prepare-time daily cap

**Files:**

- Modify: `src/server/email/types.ts` (`EmailOutreachSkipReason` gains `'daily_cap'`)
- Modify: `src/server/email/outreach.ts` (`EmailOutreachSender.unsubscribeMode`; readiness for Zoho; the prepare-time cap)
- Modify: `src/server/gtm/intent.ts` (`emailOutreachPlan` blocker, copy and defaults)
- Modify: `src/server/email/outreach-plan.test.ts` (defaults expectation)
- Test: `src/server/email/zoho-outreach.test.ts`

**Interfaces:**

- Consumes:
  - From Task 8: `outreachDailyCap` and `sentOutreachInLastDay`.
  - From Task 5: `ZOHO_OUTREACH_DAILY_CAP`, `outreachUnsubscribeModeFor` and `footerForUnsubscribeMode`.
  - From Task 9: `prepareEmailOutreach`'s `providerKey`.
  - Phase E's issue-object blockers and the `footer` variable in `emailOutreachPlan` [E-A1, E-A7].
- Produces:
  - `EmailOutreachSender { connectionId; address; provider: MailProvider; unsubscribeMode: OutreachUnsubscribeMode }`
  - Plan `defaults.unsubscribeMode: OutreachUnsubscribeMode | null`
  - Warning codes `email_reply_only_unsubscribe` and `email_zoho_daily_cap`, and blocker code `email_opt_out_line_missing`.
  - Skip reason `'daily_cap'`.
  - `email_unsubscribe_unavailable` is no longer raised when the one sending mailbox is Zoho.

- [ ] **Step 1: Write the failing tests**

Create `src/server/email/zoho-outreach.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>): Promise<unknown> => ({
    data: {},
    headers: {}
  })),
  post: vi.fn(async (_config: Record<string, unknown>): Promise<unknown> => ({
    data: {},
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, prepareGtmPlan, type PreparedGtmPlanResult } from '../gtm/intent.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';
import type { PreparedEmailOutreachResult } from './types.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';
import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';

const WORKSPACE = 'ws_email_zoho_outreach';
const USER = 'usr_email_zoho_outreach';
const CONNECTION = 'conn_email_zoho_outreach';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const PASSING = JSON.stringify({ status: 'pass', detail: 'Published.', record: null });
const ADDRESS_LINE = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
const FOOTER = `${ADDRESS_LINE}\n${OUTREACH_OPT_OUT_SENTENCE}`;
const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Northwind,maya@northwind.test,https://www.linkedin.com/in/maya-zoho-outreach/',
  'Ana,Silva,Globex,ana@globex.test,https://www.linkedin.com/in/ana-zoho-outreach/',
  'Jonas,Keller,Northstar,jonas@northstar.test,https://www.linkedin.com/in/jonas-zoho-outreach/'
].join('\n');
let db: Db;
let listId: string;

function emailIntent() {
  return {
    objective: 'prepare_outreach' as const,
    people: { existingListId: listId },
    channels: ['email'] as Array<'linkedin' | 'email' | 'community'>,
    autonomy: 'approval_required' as const
  };
}

async function prepare(idempotencyKey: string): Promise<PreparedEmailOutreachResult> {
  const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
  expect(plan.blockers).toEqual([]);
  const prepared: PreparedGtmPlanResult = await prepareGtmPlan(db, {
    workspaceId: WORKSPACE,
    actorType: 'user',
    actorUserId: USER,
    actorRole: 'owner',
    plan,
    planHash: plan.planHash,
    idempotencyKey
  });
  if (prepared.objective !== 'prepare_outreach' || prepared.channel !== 'email') {
    throw new Error('Expected an email outreach preparation');
  }
  return prepared.result;
}

async function seedSent(count: number): Promise<void> {
  const sentAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at)
       SELECT 'gdel_zoho_outreach_' || n, ?, 'email', ?, 'outreach', 'seed' || n || '@elsewhere.test',
              'test', 'zoho-outreach-' || n, 'zoho-outreach-' || n, 'sent', 'zoho-mail', 'zoho-' || n,
              ?::timestamptz, ?::timestamptz
       FROM generate_series(1, ?::int) AS n`
    )
    .run(WORKSPACE, CONNECTION, sentAt, sentAt, count);
}

async function seedCheck(provider: 'zoho' | 'google'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
       (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
        checked_at,expires_at)
       VALUES (?,'acme.test',?,'pass',?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,'[]'::jsonb,?::timestamptz,
               '2099-01-01T00:00:00.000Z'::timestamptz)`
    )
    .run(WORKSPACE, provider, PASSING, PASSING, PASSING, NOW.toISOString());
}

beforeEach(async () => {
  // No one-click origin on purpose: Zoho outreach must not need it.
  vi.stubEnv('TREVRA_PUBLIC_API_URL', '');
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  registerEmailComplianceProvider({ footer: async () => FOOTER, blockers: async () => [] });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho outreach', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'founder@acme.test', 'Founder', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'zoho-mail','trevra-zoho-mail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
       (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
  await seedCheck('zoho');
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Zoho founders' }, NOW);
  listId = list.id;
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId, csv }, NOW);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail outreach plans', () => {
  it('plans Zoho outreach without one-click unsubscribe and says how the opt-out works', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers).toEqual([]);
    expect(plan.defaults).toMatchObject({
      connectionId: CONNECTION,
      senderAddress: 'founder@acme.test',
      unsubscribeMode: 'footer_and_reply',
      prepareSupported: true
    });
    const warningCodes = (plan.defaults.warnings as Array<{ code: string }>).map(
      (warning) => warning.code
    );
    expect(warningCodes).toEqual(
      expect.arrayContaining(['email_reply_only_unsubscribe', 'email_zoho_daily_cap'])
    );
    expect(warningCodes).not.toContain('email_unsubscribe_unavailable');
    const send = plan.steps.find((step) => step.kind === 'send');
    expect(send?.detail).toContain('reply "unsubscribe"');
    expect(send?.detail).toContain(String(ZOHO_OUTREACH_DAILY_CAP));
  });

  it('still requires one-click unsubscribe for a Gmail sender', async () => {
    await db
      .prepare(
        `UPDATE connections SET provider='gmail',provider_config_key='trevra-gmail'
         WHERE workspace_id=? AND id=?`
      )
      .run(WORKSPACE, CONNECTION);
    await seedCheck('google');
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('email_unsubscribe_unavailable');
    expect(plan.defaults.unsubscribeMode).toBe('list_unsubscribe_headers');
  });

  it('blocks Zoho outreach when the footer has no single opt-out line to turn into a reply line', async () => {
    registerEmailComplianceProvider({ footer: async () => ADDRESS_LINE, blockers: async () => [] });
    const plan = await compileGtmIntent(db, WORKSPACE, emailIntent());
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('email_opt_out_line_missing');
  });

  it('prepares 1.1.0 approvals that end with the reply-to-unsubscribe footer', async () => {
    const result = await prepare('zoho-prepare-0001');
    expect(result.prepared).toHaveLength(3);
    const runs = await db
      .prepare(
        `SELECT playbook_version,input_json->>'unsubscribeMode' AS mode,
                input_json->>'requireListUnsubscribe' AS require_header,input_json->>'body' AS body
         FROM playbook_runs WHERE workspace_id=?`
      )
      .all<{ playbook_version: string; mode: string; require_header: string; body: string }>(
        WORKSPACE
      );
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run).toMatchObject({
        playbook_version: '1.1.0',
        mode: 'footer_and_reply',
        require_header: 'false'
      });
      expect(run.body.endsWith(`${ADDRESS_LINE}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`)).toBe(true);
      // [E-A3] the first-touch text no longer carries the one-click sentence itself.
      expect(run.body).not.toContain(OUTREACH_OPT_OUT_SENTENCE);
    }
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('never prepares past the Zoho daily cap, across preparations and despite a higher operator limit', async () => {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings
         (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
         VALUES (?,?,200,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)`
      )
      .run(WORKSPACE, CONNECTION, NOW.toISOString(), NOW.toISOString());
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 2);

    const first = await prepare('zoho-prepare-cap-1');
    expect(first.prepared).toHaveLength(2);
    expect(first.skipped.map((item) => item.reason)).toEqual(['daily_cap']);

    // The two waiting approvals count against today's cap: nothing more is prepared.
    const second = await prepare('zoho-prepare-cap-2');
    expect(second.prepared).toEqual([]);
    expect(second.skipped.map((item) => item.reason).sort()).toEqual([
      'already_pending',
      'already_pending',
      'daily_cap'
    ]);
  });
});
```

In `src/server/email/outreach-plan.test.ts`, in `'compiles a deterministic email plan from one passing sender'`, add `unsubscribeMode: 'list_unsubscribe_headers',` to the expected `plan.defaults` after `senderAddress`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-outreach.test.ts src/server/email/outreach-plan.test.ts`
Expected: FAIL. The Zoho plan has `email_unsubscribe_unavailable`, `defaults.unsubscribeMode` is missing, and there is no `daily_cap` skip.

- [ ] **Step 3: Implement readiness**

In `src/server/email/types.ts`, add `| 'daily_cap'` to `EmailOutreachSkipReason`.

In `src/server/email/outreach.ts`:

- Add `import { outreachDailyCap, sentOutreachInLastDay } from '../email-deliveries.js';`.
- Add `import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';`.
- Extend the existing `./unsubscribe-policy.js` import (from Task 9) with `outreachUnsubscribeModeFor`.
- Add `unsubscribeMode: OutreachUnsubscribeMode;` to `EmailOutreachSender`.

In `emailOutreachReadiness`, move `const mailboxes = await listSendingMailboxes(db, workspaceId);` to just above the `if (!unsubscribeConfigured(env))` check, and change that check to:

```ts
  // Zoho Mail outreach carries no List-Unsubscribe header (unsubscribe-policy.ts),
  // so a deployment without the one-click origin can still send from it.
  const onlyZoho = mailboxes.length === 1 && mailboxes[0]!.providerKey === 'zoho';
  if (!onlyZoho && !unsubscribeConfigured(env)) {
```

(The blocker pushed inside is unchanged, so blocker order is unchanged.) Change the `email_sender_missing` message to `'Connect the Gmail, Microsoft 365 or Zoho Mail mailbox you want to send outreach from.'`. Change the sender assignment to:

```ts
sender = {
  connectionId: mailbox.connectionId,
  address,
  provider: mailbox.providerKey,
  unsubscribeMode: outreachUnsubscribeModeFor(mailbox.providerKey)
};
```

Directly after `warnings.push(...deliverability.warnings);`, add:

```ts
if (mailbox.providerKey === 'zoho') {
  warnings.push(
    {
      code: 'email_reply_only_unsubscribe',
      message: `Zoho Mail cannot add a one-click unsubscribe link. Each email from ${address} ends with your footer asking the recipient to reply "unsubscribe", and such a reply stops all email to them.`,
      actionHref: SETUP_HREF
    },
    {
      code: 'email_zoho_daily_cap',
      message: `Zoho Mail sends at most ${ZOHO_OUTREACH_DAILY_CAP} outreach emails a day from ${address}. People beyond that are skipped; prepare them again the next day.`,
      actionHref: SETUP_HREF
    }
  );
}
```

- [ ] **Step 4: Implement the prepare-time cap**

In `prepareEmailOutreach`, directly after the `sentFooter` block from Task 9, add:

```ts
// Zoho Mail: prepare no more than today's remaining sends for this mailbox.
// Approvals still waiting on this connection count as spent, so two
// preparations on one day cannot together pass the cap. A race between two
// concurrent preparations is still stopped at send time by
// assertEmailDeliveryCapacity.
let remaining = Number.POSITIVE_INFINITY;
if (providerKey === 'zoho') {
  const mailbox = { workspaceId: input.workspaceId, connectionId: input.connectionId };
  const waiting = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM playbook_runs
         WHERE workspace_id=? AND playbook_key=? AND status IN ('queued','running','waiting_approval')
           AND input_json->>'connectionId'=?`
    )
    .get<{ total: number }>(input.workspaceId, EMAIL_OUTREACH_PLAYBOOK_ID, input.connectionId);
  remaining = Math.max(
    0,
    (await outreachDailyCap(db, mailbox)) -
      (await sentOutreachInLastDay(db, mailbox, now)) -
      Number(waiting?.total ?? 0)
  );
}
```

In the member loop, directly after the `already_pending` check (`if (openRun || batchRecipients.has(recipient)) { … }`), add:

```ts
if (remaining <= 0) {
  skip(member.contact_id, 'daily_cap');
  continue;
}
```

After `const runId = started.runId;`, add `remaining -= 1;`. (A crash-retried run of this same key takes the `openRun.idempotency_key === runKey` branch above. It is already counted in `waiting`, so it does not decrement again.)

- [ ] **Step 5: Implement the plan blocker, copy and defaults**

In `src/server/gtm/intent.ts`, add `import { footerForUnsubscribeMode } from '../email/unsubscribe-policy.js';` and `import { ZOHO_OUTREACH_DAILY_CAP } from '../email/zoho-mail.js';`. In `emailOutreachPlan`, after the statement that pushes the compliance blockers [E-A1, E-A7], add:

```ts
// Zoho outreach swaps the footer's opt-out sentence for reply-to-unsubscribe;
// without exactly one such sentence preparing would refuse.
if (
  footer &&
  readiness.sender?.unsubscribeMode === 'footer_and_reply' &&
  !footerForUnsubscribeMode(footer, 'footer_and_reply')
) {
  blockers.push({
    code: 'email_opt_out_line_missing',
    message:
      'Your compliance footer needs its opt-out line exactly once so Trevra can turn it into "reply unsubscribe" for Zoho Mail. Complete sender compliance in Workspace settings.',
    actionHref: '/setup/workspace'
  });
}
```

In the `sender` step, change the no-sender text to `'Connect exactly one Gmail, Microsoft 365 or Zoho Mail mailbox to send from.'`. Change the `send` step's `detail` to:

```ts
        detail:
          sender?.unsubscribeMode === 'footer_and_reply'
            ? `Each approved email leaves from ${sender.address} through Zoho Mail, at most ${ZOHO_OUTREACH_DAILY_CAP} a day, and ends with your footer asking the recipient to reply "unsubscribe" to opt out.`
            : 'Each approved email leaves from the approved mailbox with a one-click unsubscribe link.',
```

In `defaults`, add `unsubscribeMode: sender?.unsubscribeMode ?? null,` after `senderAddress`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-outreach.test.ts src/server/email/outreach-plan.test.ts src/server/email/outreach.test.ts src/server/email/outreach-playbook.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/email/types.ts src/server/email/outreach.ts src/server/gtm/intent.ts src/server/email/outreach-plan.test.ts src/server/email/zoho-outreach.test.ts
git commit -m "feat(email): plan and prepare Zoho Mail outreach under its daily cap" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 11: Inbound Zoho replies, including an unthreaded "unsubscribe"

**Files:**

- Modify: `src/server/conversations.ts:285` (provider list)
- Modify: `src/server/email/inbound-mailbox.ts` (`withoutKnownOptOutText`; the unthreaded Zoho opt-out)
- Test: `src/server/email/zoho-inbound.test.ts`

**Interfaces:**

- Consumes:
  - From Task 5: `OUTREACH_REPLY_OPT_OUT_SENTENCE` and `footerForUnsubscribeMode`.
  - From Task 7: Zoho deliveries have `provider='zoho-mail'`.
  - `ingestCanonicalRecord(db, workspaceId, provider, localConnectionId, record)`.
- Produces:
  - Zoho inbound records are projected into Conversations.
  - An unsubscribe reply with no threaded delivery suppresses the Person when a `sent` Zoho outreach delivery exists from the same connection to any of that Person's addresses.
  - `threadedDeliveryId` semantics are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/server/email/zoho-inbound.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ingestCanonicalRecord, type CanonicalRecord } from '../integration-service.js';
import { resolveContact } from '../lead-capture/people.js';
import { findSuppression } from '../suppressions.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';

const WORKSPACE = 'ws_email_zoho_inbound';
const ZOHO = 'conn_zoho_inbound';
const GMAIL = 'conn_zoho_inbound_gmail';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ADDRESS_LINE = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
let db: Db;
let personId = '';

function message(overrides: Partial<Extract<CanonicalRecord, { kind: 'message' }>> = {}) {
  return {
    kind: 'message' as const,
    id: 'zoho-msg-1',
    personEmail: 'maya@northwind.test',
    personName: 'Maya Chen',
    direction: 'inbound' as const,
    subject: 'Re: Quick question, Maya',
    body: 'Please unsubscribe me.',
    occurredAt: '2026-10-07T08:30:00.000Z',
    mailboxAddress: 'founder@acme.test',
    ...overrides
  };
}

async function insertConnection(id: string, provider: 'zoho-mail' | 'gmail'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(
      id,
      WORKSPACE,
      provider,
      `trevra-${provider}`,
      `${id}-external`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function sentOutreach(input: {
  id: string;
  connectionId: string;
  provider: string;
  recipient: string;
}) {
  await db
    .prepare(
      `INSERT INTO gtm_deliveries
       (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
        status,provider,external_ref,started_at,sent_at)
       VALUES (?,?,'email',?,'outreach',?,'email_outreach',?,?,'sent',?,?,?::timestamptz,?::timestamptz)`
    )
    .run(
      input.id,
      WORKSPACE,
      input.connectionId,
      input.recipient,
      input.id,
      `key-${input.id}`,
      input.provider,
      `ref-${input.id}`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function outcomeKind(id: string): Promise<string | undefined> {
  const row = await db
    .prepare(
      'SELECT outcome_kind FROM conversation_messages WHERE workspace_id=? AND external_ref=?'
    )
    .get<{ outcome_kind: string }>(WORKSPACE, id);
  return row?.outcome_kind;
}

function suppressed(email: string) {
  return findSuppression(db, WORKSPACE, { channel: 'email', email });
}

beforeEach(async () => {
  registerEmailComplianceProvider({
    footer: async () => `${ADDRESS_LINE}\n${OUTREACH_OPT_OUT_SENTENCE}`,
    blockers: async () => []
  });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho inbound', NOW.toISOString());
  await insertConnection(ZOHO, 'zoho-mail');
  await insertConnection(GMAIL, 'gmail');
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
       VALUES (?,?,'founder@acme.test','syncing',?,?)`
    )
    .run(WORKSPACE, ZOHO, NOW.toISOString(), NOW.toISOString());
  personId = (
    await resolveContact(db, WORKSPACE, { name: 'Maya Chen', email: 'maya@northwind.test' }, NOW)
  ).contact.id;
});

afterEach(async () => {
  resetEmailComplianceProvider();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail inbound replies', () => {
  it('stores a known Person reply from the Zoho inbound mailbox in Conversations', async () => {
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-reply', body: 'Friday works.' })
    );
    expect(await outcomeKind('zoho-reply')).toBe('reply');
  });

  it('suppresses an unthreaded unsubscribe reply to Zoho outreach from this mailbox', async () => {
    await sentOutreach({
      id: 'del_00000000000000a1',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(db, WORKSPACE, 'zoho-mail', ZOHO, message());
    expect(await outcomeKind('zoho-msg-1')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toMatchObject({
      source: 'email_reply_unsubscribe',
      sourceRef: 'zoho-msg-1'
    });
  });

  it('suppresses when the unthreaded opt-out comes from another address of the same Person', async () => {
    await db
      .prepare(
        `INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
         VALUES ('pid_zoho_alias',?,?,'zoho-mail','email','maya.chen@northwind.test','maya.chen@northwind.test',?)`
      )
      .run(WORKSPACE, personId, NOW.toISOString());
    await sentOutreach({
      id: 'del_00000000000000a2',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-alias', personEmail: 'maya.chen@northwind.test' })
    );
    expect(await suppressed('maya.chen@northwind.test')).toMatchObject({
      source: 'email_reply_unsubscribe'
    });
  });

  it('does not suppress an unthreaded unsubscribe without Zoho outreach from this mailbox', async () => {
    // Gmail outreach keeps Phase D's rule: only a threaded reply counts.
    await sentOutreach({
      id: 'del_00000000000000a3',
      connectionId: GMAIL,
      provider: 'gmail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({ id: 'zoho-no-outreach' })
    );
    expect(await outcomeKind('zoho-no-outreach')).toBe('unsubscribe');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });

  it('does not read a quoted reply-to-unsubscribe footer as an opt-out', async () => {
    await sentOutreach({
      id: 'del_00000000000000a4',
      connectionId: ZOHO,
      provider: 'zoho-mail',
      recipient: 'maya@northwind.test'
    });
    await ingestCanonicalRecord(
      db,
      WORKSPACE,
      'zoho-mail',
      ZOHO,
      message({
        id: 'zoho-quoted',
        body: `Friday works for me.\n\n${ADDRESS_LINE}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`
      })
    );
    expect(await outcomeKind('zoho-quoted')).toBe('reply');
    expect(await suppressed('maya@northwind.test')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-inbound.test.ts`
Expected: FAIL. The `zoho-mail` message is not projected (`conversations.ts` returns null), and nothing is suppressed.

- [ ] **Step 3: Implement**

In `src/server/conversations.ts`, change line 285 to:

```ts
if (!['gmail', 'google-mail', 'microsoft', 'outlook', 'zoho-mail'].includes(provider)) return null;
```

In `src/server/email/inbound-mailbox.ts`, add `import { OUTREACH_REPLY_OPT_OUT_SENTENCE, footerForUnsubscribeMode } from './unsubscribe-policy.js';`. Change the `known` list in `withoutKnownOptOutText` to:

```ts
const known = [
  OUTREACH_OPT_OUT_SENTENCE,
  OUTREACH_REPLY_OPT_OUT_SENTENCE,
  SKILL_DRAFT_UNSUBSCRIBE_LINE,
  footer,
  // The footer Zoho outreach ends with (unsubscribe-policy.ts).
  footer ? footerForUnsubscribeMode(footer, 'footer_and_reply') : null
];
```

(The `.map(…).filter(Boolean).sort(…)` chain is unchanged.) Replace the block `if (outcomeKind === 'unsubscribe' && threaded) {` through its closing `}` with:

```ts
// A reply that threads to Trevra's own email is verified intent. Zoho Mail
// outreach cannot always be threaded (its Message-ID read-back may fail and
// clients drop In-Reply-To), and its only opt-out is "reply unsubscribe", so
// an unthreaded unsubscribe also counts when this same mailbox sent the
// Person Zoho outreach (unsubscribe-policy.ts).
const optOutDelivery =
  outcomeKind === 'unsubscribe' && !threaded
    ? await db
        .prepare(
          `SELECT d.id FROM gtm_deliveries d
             WHERE d.workspace_id=? AND d.channel='email' AND d.purpose='outreach' AND d.status='sent'
               AND d.provider='zoho-mail' AND d.connection_id=?
               AND LOWER(d.recipient) IN (
                 SELECT email_normalized FROM contacts
                 WHERE workspace_id=? AND id=? AND email_normalized IS NOT NULL
                 UNION
                 SELECT normalized_value FROM person_identities
                 WHERE workspace_id=? AND person_id=? AND identity_type='email'
                 UNION
                 SELECT ?::text
               )
             ORDER BY d.sent_at DESC LIMIT 1`
        )
        .get<{ id: string }>(
          workspaceId,
          connectionId,
          workspaceId,
          person.id,
          workspaceId,
          person.id,
          sender
        )
    : undefined;
if (outcomeKind === 'unsubscribe' && (threaded || optOutDelivery)) {
  await createSuppression(
    db,
    {
      workspaceId,
      channel: 'email',
      email: sender,
      personId: person.id,
      reason: 'Recipient asked to stop in a reply',
      source: 'email_reply_unsubscribe',
      sourceRef: record.id,
      actorType: 'system'
    },
    now
  );
}
```

(`connectionId` here is the function's local connection id, already checked equal to the designated inbound mailbox. The return value is unchanged: `threadedDeliveryId: threaded?.id ?? null`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-inbound.test.ts src/server/email/inbound-mailbox.test.ts src/server/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/conversations.ts src/server/email/inbound-mailbox.ts src/server/email/zoho-inbound.test.ts
git commit -m "feat(email): read Zoho replies and honour an unthreaded unsubscribe" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 12: The `trevra-zoho-mail` inbound-messages Nango sync

**Files:**

- Create: `nango-integrations/shared/zoho-mail.ts`
- Create: `nango-integrations/trevra-zoho-mail/syncs/inbound-messages.ts`
- Modify: `nango-integrations/index.ts`
- Modify: `src/server/email/inbound-sync-helpers.test.ts` (the per-integration source loop)
- Test: `src/server/email/zoho-sync-helpers.test.ts`

**Interfaces:**

- Consumes:
  - From `nango-integrations/shared/inbound-email.ts`: `BACKFILL_MS`, `OVERLAP_MS`, `INBOUND_ADDRESS_METADATA_KEY`, `INBOUND_EMAIL_MESSAGE_MODEL`, `buildInboundRecord`, `headerValue`, `htmlToText`, `normalizeAddress`, `MailHeader` and `InboundEmailRecord`.
  - From `nango-integrations/shared/inbound-model.ts`: `InboundEmailMessage` and `InboundSyncMetadata`.
  - From Task 5: the behaviour of `pickZohoAccount`, `pickZohoFolderId` and `parseZohoHeaders` in `src/server/email/zoho-mail.ts`. These are copied here, and the parity test holds the copies identical.
  - From Task 1: S4, S5, S7 and S8.
- Produces:
  - `nango-integrations/shared/zoho-mail.ts`:
    - `ZOHO_LIST_PAGE_SIZE = 100`, `ZOHO_LIST_CEILING = 1000`, `ZOHO_MAX_MESSAGES_PER_RUN = 100` and `ZOHO_LIST_NEWEST_FIRST = 'false'`;
    - `ZohoListEntry { messageId: string; receivedMs: number; fromAddress: string | null; subject: string | null; summary: string }`;
    - `zohoListEntries(body: unknown): ZohoListEntry[]`;
    - `mimeFromOriginalMessage(body: unknown): string | null`;
    - `parseMimeMessage(raw: string): { headers: MailHeader[]; text: string }`;
    - copies of `pickZohoAccount`, `pickZohoFolderId` and `parseZohoHeaders`.
  - The sync `inbound-messages` on integration `trevra-zoho-mail`, model `InboundEmailMessage`, every 15 minutes, `autoStart: false`. It emits records with `mailboxAddress` set and `externalUrl: null`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/email/zoho-sync-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { headerValue } from '../../../nango-integrations/shared/inbound-email.js';
import {
  ZOHO_LIST_CEILING,
  ZOHO_LIST_PAGE_SIZE,
  ZOHO_MAX_MESSAGES_PER_RUN,
  mimeFromOriginalMessage,
  parseMimeMessage,
  parseZohoHeaders as syncParseZohoHeaders,
  pickZohoAccount as syncPickZohoAccount,
  pickZohoFolderId as syncPickZohoFolderId,
  zohoListEntries
} from '../../../nango-integrations/shared/zoho-mail.js';
import { parseZohoHeaders, pickZohoAccount, pickZohoFolderId } from './zoho-mail.js';

const ACCOUNTS: unknown[] = [
  {
    data: [
      { accountId: 1000000001, type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'Founder@Acme.test' }
    ]
  },
  { data: [{ accountId: '1', type: 'ZOHO_ACCOUNT', mailboxAddress: 'founder@acme.test' }] },
  {
    data: [
      { accountId: '1', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'founder@acme.test' },
      { accountId: '2', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'other@acme.test' }
    ]
  },
  { data: [{ accountId: '3', type: 'POP_ACCOUNT', primaryEmailAddress: 'pop@acme.test' }] },
  { data: [{ accountId: '4', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'not-an-address' }] },
  { data: [] },
  {},
  'nope',
  null
];
const FOLDERS: unknown[] = [
  {
    data: [
      { folderId: '11', folderName: 'Inbox', folderType: 'Inbox' },
      { folderId: '12', folderName: 'Sent', folderType: 'Sent' }
    ]
  },
  {
    data: [
      { folderId: 21, folderName: 'Sent' },
      { folderId: 22, folderName: 'Posteingang', folderType: 'Inbox' }
    ]
  },
  { data: [] },
  'nope'
];
const HEADERS: unknown[] = [
  { data: 'Subject: Long\r\n subject line\r\nFrom: Ada <ada@northwind.test>' },
  { data: { headerContent: 'Message-ID: <a1@mx.test>\nIn-Reply-To: <b2@mx.test>' } },
  { data: { From: ['Ada <ada@northwind.test>'], Subject: 'Hello' } },
  {}
];

const ALTERNATIVE = [
  'From: Ada Lovelace <ada@northwind.test>',
  'Subject: Re: Quick question',
  'Message-ID: <reply-1@mx.northwind.test>',
  'In-Reply-To: <zoho-1777@mx.zoho.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  'This is a multi-part message in MIME format.',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Friday at the caf=C3=A9 works for a long=',
  ' chat.',
  '--b1',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>HTML must lose to plain text.</p>',
  '--b1--',
  ''
].join('\r\n');

const MIXED = [
  'From: ana@globex.test',
  'Subject: Re: Olá',
  'Content-Type: multipart/mixed; boundary=outer',
  '',
  '--outer',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  '',
  'attachment text that must not be read',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/html; charset=ISO-8859-1',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<p>Olá, sexta serve.</p>', 'latin1').toString('base64'),
  '--inner--',
  '--outer--'
].join('\n');

function nestedMultipart(levels: number): string {
  let entity = 'Content-Type: text/plain\n\ndeep text';
  for (let level = 0; level < levels; level += 1) {
    entity = `Content-Type: multipart/mixed; boundary="l${level}"\n\n--l${level}\n${entity}\n--l${level}--`;
  }
  return `From: deep@northwind.test\n${entity}`;
}

describe('Zoho Mail sync helpers', () => {
  it('keeps the sync copies identical to the server parsers', () => {
    for (const body of ACCOUNTS) expect(syncPickZohoAccount(body)).toEqual(pickZohoAccount(body));
    for (const body of FOLDERS) {
      for (const kind of ['inbox', 'sent'] as const) {
        expect(syncPickZohoFolderId(body, kind)).toEqual(pickZohoFolderId(body, kind));
      }
    }
    for (const body of HEADERS) expect(syncParseZohoHeaders(body)).toEqual(parseZohoHeaders(body));
  });

  it('bounds one run so it fits inside the Zoho API limits', () => {
    expect(ZOHO_LIST_PAGE_SIZE).toBeLessThanOrEqual(200);
    expect(ZOHO_LIST_CEILING % ZOHO_LIST_PAGE_SIZE).toBe(0);
    expect(ZOHO_MAX_MESSAGES_PER_RUN).toBeLessThanOrEqual(ZOHO_LIST_CEILING);
  });

  it('reads list entries and drops ones without an id or a received time', () => {
    expect(
      zohoListEntries({
        data: [
          {
            messageId: '1777',
            receivedTime: '1791363600000',
            fromAddress: 'ada@northwind.test',
            subject: 'Re: Hi',
            summary: ' Friday works. '
          },
          { messageId: 1778, receivedTime: 1791363700000 },
          { messageId: '', receivedTime: '1791363800000' },
          { messageId: '1779', receivedTime: 'soon' },
          { messageId: '1780', receivedTime: '' },
          'nope'
        ]
      })
    ).toEqual([
      {
        messageId: '1777',
        receivedMs: 1791363600000,
        fromAddress: 'ada@northwind.test',
        subject: 'Re: Hi',
        summary: 'Friday works.'
      },
      {
        messageId: '1778',
        receivedMs: 1791363700000,
        fromAddress: null,
        subject: null,
        summary: ''
      }
    ]);
    expect(zohoListEntries({})).toEqual([]);
  });

  it('finds the raw MIME in every original-message shape', () => {
    expect(mimeFromOriginalMessage('From: a@b.test\n\nHi')).toBe('From: a@b.test\n\nHi');
    expect(mimeFromOriginalMessage({ data: 'From: a@b.test\n\nHi' })).toBe('From: a@b.test\n\nHi');
    expect(mimeFromOriginalMessage({ data: { content: 'From: a@b.test\n\nHi' } })).toBe(
      'From: a@b.test\n\nHi'
    );
    expect(mimeFromOriginalMessage({ data: { content: '   ' } })).toBeNull();
    expect(mimeFromOriginalMessage({})).toBeNull();
    expect(mimeFromOriginalMessage(null)).toBeNull();
  });

  it('prefers decoded plain text and keeps the reply headers', () => {
    const parsed = parseMimeMessage(ALTERNATIVE);
    expect(parsed.text).toBe('Friday at the café works for a long chat.');
    expect(headerValue(parsed.headers, 'Message-ID')).toBe('<reply-1@mx.northwind.test>');
    expect(headerValue(parsed.headers, 'In-Reply-To')).toBe('<zoho-1777@mx.zoho.test>');
  });

  it('skips attachments and falls back to latin1 base64 HTML', () => {
    const parsed = parseMimeMessage(MIXED);
    expect(parsed.text).toBe('Olá, sexta serve.');
    expect(parsed.text).not.toContain('attachment text');
    expect(headerValue(parsed.headers, 'From')).toBe('ana@globex.test');
  });

  it('reads a single-part message and stops at a bounded nesting depth', () => {
    expect(parseMimeMessage('From: x@northwind.test\r\n\r\nHello there.\r\n').text).toBe(
      'Hello there.'
    );
    expect(parseMimeMessage(nestedMultipart(3)).text).toBe('deep text');
    expect(parseMimeMessage(nestedMultipart(7)).text).toBe('');
    expect(parseMimeMessage('Content-Type: multipart/mixed\n\n--x\n\nno boundary').text).toBe('');
  });
});
```

In `src/server/email/inbound-sync-helpers.test.ts`, change the loop in `'has a sync file per integration that uses the shared constants and model'` to:

```ts
    for (const integration of ['trevra-gmail', 'trevra-microsoft', 'trevra-zoho-mail']) {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-sync-helpers.test.ts src/server/email/inbound-sync-helpers.test.ts`
Expected: FAIL. `nango-integrations/shared/zoho-mail.js` and `trevra-zoho-mail/syncs/inbound-messages.ts` do not exist.

- [ ] **Step 3: Create the shared helpers**

Create `nango-integrations/shared/zoho-mail.ts`. Copy `ADDRESS`, `dataOf`, `idText`, `pickZohoAccount`, `pickZohoFolderId`, `headerBlock` and `parseZohoHeaders` byte for byte from Task 5's `src/server/email/zoho-mail.ts`, with `ZohoHeader` replaced by `MailHeader`:

```ts
/**
 * Pure helpers for the trevra-zoho-mail inbound-messages sync. Nango compiles
 * this folder on its own and cannot import src/server, so pickZohoAccount,
 * pickZohoFolderId and parseZohoHeaders are copies of
 * src/server/email/zoho-mail.ts; src/server/email/zoho-sync-helpers.test.ts
 * holds the copies identical.
 */
import { headerValue, htmlToText, type MailHeader } from './inbound-email.js';

export const ZOHO_LIST_PAGE_SIZE = 100;
/** Inbox entries listed per run before the oldest-first read. */
export const ZOHO_LIST_CEILING = 1000;
/**
 * Each message costs up to two API calls (original message, then header
 * fallback). Sized against Zoho's API limits in the plan's smoke step S8.
 */
export const ZOHO_MAX_MESSAGES_PER_RUN = 100;
/** The messages/view `sortorder` value that lists newest first (smoke step S5). */
export const ZOHO_LIST_NEWEST_FIRST = 'false';
const MIME_MAX_DEPTH = 5;

export type ZohoAccount = { accountId: string; address: string };
export type ZohoListEntry = {
  messageId: string;
  receivedMs: number;
  fromAddress: string | null;
  subject: string | null;
  summary: string;
};

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function dataOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : undefined;
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** The one ZOHO_ACCOUNT the token can read, or null when there is not exactly one. */
export function pickZohoAccount(body: unknown): ZohoAccount | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const accounts = list.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'ZOHO_ACCOUNT'
  );
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  const accountId = idText(account.accountId);
  const raw = account.primaryEmailAddress ?? account.mailboxAddress;
  const address = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!accountId || !ADDRESS.test(address)) return null;
  return { accountId, address };
}

/** The id of the account's Inbox or Sent folder; folderType wins over folderName. */
export function pickZohoFolderId(body: unknown, kind: 'inbox' | 'sent'): string | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const folders = list.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
  );
  const named = (field: 'folderType' | 'folderName') =>
    folders.find(
      (folder) =>
        String(folder[field] ?? '')
          .trim()
          .toLowerCase() === kind
    );
  return idText((named('folderType') ?? named('folderName'))?.folderId);
}

function headerBlock(block: string): MailHeader[] {
  const headers: MailHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

/** Zoho's header endpoint: a raw block, { headerContent: block }, or a name-to-value map. */
export function parseZohoHeaders(body: unknown): MailHeader[] {
  const data = dataOf(body);
  if (typeof data === 'string') return headerBlock(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const content = (data as { headerContent?: unknown }).headerContent;
  if (typeof content === 'string') return headerBlock(content);
  const map = content && typeof content === 'object' && !Array.isArray(content) ? content : data;
  const headers: MailHeader[] = [];
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') headers.push({ name, value: item.trim() });
    }
  }
  return headers;
}

/** messages/view entries that carry an id and a received time (epoch ms). */
export function zohoListEntries(body: unknown): ZohoListEntry[] {
  const list = dataOf(body);
  if (!Array.isArray(list)) return [];
  const entries: ZohoListEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const messageId = idText(entry.messageId);
    const receivedMs = Number(entry.receivedTime);
    if (!messageId || !Number.isFinite(receivedMs) || receivedMs <= 0) continue;
    entries.push({
      messageId,
      receivedMs,
      fromAddress:
        typeof entry.fromAddress === 'string' && entry.fromAddress.trim()
          ? entry.fromAddress.trim()
          : null,
      subject: typeof entry.subject === 'string' ? entry.subject : null,
      summary: typeof entry.summary === 'string' ? entry.summary.trim() : ''
    });
  }
  return entries;
}

/** The raw RFC 5322 message from originalmessage: a string body, data, or data.content. */
export function mimeFromOriginalMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() ? body : null;
  const data = dataOf(body);
  if (typeof data === 'string') return data.trim() ? data : null;
  const content =
    data && typeof data === 'object' ? (data as { content?: unknown }).content : undefined;
  return typeof content === 'string' && content.trim() ? content : null;
}

function splitEntity(entity: string): { headers: MailHeader[]; body: string } {
  const text = entity.replace(/\r\n/g, '\n');
  if (text.startsWith('\n')) return { headers: [], body: text.slice(1) };
  const gap = text.indexOf('\n\n');
  return gap === -1
    ? { headers: headerBlock(text), body: '' }
    : { headers: headerBlock(text.slice(0, gap)), body: text.slice(gap + 2) };
}

function quotedPrintableBytes(text: string): Buffer {
  const joined = text.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const hex = joined.slice(index + 1, index + 3);
    if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(joined[index]!, 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

/** Undo the part's transfer encoding; honour a latin1-family charset, else utf8. */
function decodeBody(body: string, headers: readonly MailHeader[]): string {
  const encoding = (headerValue(headers, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase();
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(
    headerValue(headers, 'Content-Type') ?? ''
  )?.[1];
  const latin1 = charset ? /^(iso-8859-1|latin1|windows-1252)$/i.test(charset) : false;
  if (encoding === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(latin1 ? 'latin1' : 'utf8');
  }
  if (encoding === 'quoted-printable') {
    return quotedPrintableBytes(body).toString(latin1 ? 'latin1' : 'utf8');
  }
  return body;
}

function findPart(
  entity: string,
  mimeType: 'text/plain' | 'text/html',
  depth: number
): string | null {
  const { headers, body } = splitEntity(entity);
  const contentType = headerValue(headers, 'Content-Type') ?? 'text/plain';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    if (depth >= MIME_MAX_DEPTH) return null;
    const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim();
    if (!boundary) return null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      const found = findPart(part.replace(/^[ \t]*\n/, ''), mimeType, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (/^\s*attachment/i.test(headerValue(headers, 'Content-Disposition') ?? '')) return null;
  return type === mimeType ? decodeBody(body, headers) : null;
}

/** Top-level headers plus the first inline text/plain part, else the first HTML part as text. */
export function parseMimeMessage(raw: string): { headers: MailHeader[]; text: string } {
  const { headers } = splitEntity(raw);
  const plain = findPart(raw, 'text/plain', 0);
  if (plain !== null) return { headers, text: plain.trim() };
  const html = findPart(raw, 'text/html', 0);
  return { headers, text: html !== null ? htmlToText(html) : '' };
}
```

- [ ] **Step 4: Create the sync**

Create `nango-integrations/trevra-zoho-mail/syncs/inbound-messages.ts`:

```ts
import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  INBOUND_ADDRESS_METADATA_KEY,
  INBOUND_EMAIL_MESSAGE_MODEL,
  OVERLAP_MS,
  buildInboundRecord,
  headerValue,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';
import {
  ZOHO_LIST_CEILING,
  ZOHO_LIST_NEWEST_FIRST,
  ZOHO_LIST_PAGE_SIZE,
  ZOHO_MAX_MESSAGES_PER_RUN,
  mimeFromOriginalMessage,
  parseMimeMessage,
  parseZohoHeaders,
  pickZohoAccount,
  pickZohoFolderId,
  zohoListEntries,
  type ZohoListEntry
} from '../../shared/zoho-mail.js';

const SAVE_BATCH = 50;

export default createSync({
  description:
    'Reads the Zoho Mail inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
  version: '1.0.0',
  frequency: 'every 15 minutes',
  autoStart: false,
  models: { InboundEmailMessage },
  metadata: InboundSyncMetadata,
  checkpoint: z.object({ sinceMs: z.number() }),
  exec: async (nango) => {
    const metadata = await nango.getMetadata();
    const expected = normalizeAddress(metadata?.[INBOUND_ADDRESS_METADATA_KEY]);
    if (!expected) {
      throw new Error('trevraInboundAddress metadata is missing. Designate the mailbox in Trevra.');
    }
    const accounts = await nango.get<unknown>({ endpoint: '/api/accounts', retries: 3 });
    const account = pickZohoAccount(accounts.data);
    if (!account || account.address !== expected) {
      throw new Error(
        'This Zoho Mail connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }
    const base = `/api/accounts/${encodeURIComponent(account.accountId)}`;
    const folders = await nango.get<unknown>({ endpoint: `${base}/folders`, retries: 3 });
    const inboxId = pickZohoFolderId(folders.data, 'inbox');
    if (!inboxId) throw new Error('Trevra could not find the Inbox of this Zoho Mail account.');

    const startedAt = Date.now();
    const checkpoint = await nango.getCheckpoint();
    const sinceMs = checkpoint?.sinceMs ?? startedAt - BACKFILL_MS;
    const listed: ZohoListEntry[] = [];
    let start = 1;
    let more = true;
    while (more && listed.length < ZOHO_LIST_CEILING) {
      // lc-debt: reads only the Inbox, as the Gmail and Microsoft syncs do; a reply filtered out of the Inbox before the next 15-minute run is never read.
      const page = await nango.get<unknown>({
        endpoint: `${base}/messages/view`,
        params: {
          folderId: inboxId,
          start,
          limit: ZOHO_LIST_PAGE_SIZE,
          sortBy: 'date',
          sortorder: ZOHO_LIST_NEWEST_FIRST
        },
        retries: 3
      });
      const entries = zohoListEntries(page.data);
      for (const entry of entries) {
        // Newest first: everything after the first older entry is older too.
        if (entry.receivedMs < sinceMs) {
          more = false;
          break;
        }
        listed.push(entry);
      }
      if (entries.length < ZOHO_LIST_PAGE_SIZE) more = false;
      start += ZOHO_LIST_PAGE_SIZE;
    }
    if (more) {
      // lc-debt: more than ZOHO_LIST_CEILING inbox messages in one window reads only the newest of them, as the Gmail sync does.
      await nango.log(
        `More than ${ZOHO_LIST_CEILING} inbox messages since the last run; reading the newest ${ZOHO_LIST_CEILING}.`,
        { level: 'warn' }
      );
    }

    // Read oldest first so the checkpoint can resume.
    const queue = [...listed]
      .sort((left, right) => left.receivedMs - right.receivedMs)
      .slice(0, ZOHO_MAX_MESSAGES_PER_RUN);
    let batch: InboundEmailRecord[] = [];
    let lastMs = sinceMs;
    for (const entry of queue) {
      const messageId = encodeURIComponent(entry.messageId);
      let headers: MailHeader[] = [];
      let body = entry.summary;
      try {
        const original = await nango.get<unknown>({
          endpoint: `${base}/messages/${messageId}/originalmessage`,
          retries: 3
        });
        const raw = mimeFromOriginalMessage(original.data);
        if (raw) {
          const parsed = parseMimeMessage(raw);
          headers = parsed.headers;
          if (parsed.text) body = parsed.text;
        }
      } catch {
        await nango.log(
          `Zoho Mail did not return message ${entry.messageId} in full; reading its headers and summary.`,
          { level: 'warn' }
        );
      }
      if (headers.length === 0) {
        const header = await nango.get<unknown>({
          endpoint: `${base}/folders/${encodeURIComponent(inboxId)}/messages/${messageId}/header`,
          retries: 3
        });
        headers = parseZohoHeaders(header.data);
      }
      // lc-debt: emits the body of every person-to-person message, as the Gmail sync does; Trevra keeps only known senders server-side.
      const record = buildInboundRecord({
        id: entry.messageId,
        mailboxAddress: expected,
        from: headerValue(headers, 'From') ?? entry.fromAddress,
        subject: headerValue(headers, 'Subject') ?? entry.subject,
        body,
        occurredAt: entry.receivedMs,
        externalUrl: null,
        internetMessageId: headerValue(headers, 'Message-ID'),
        headers
      });
      if (record) batch.push(record);
      lastMs = Math.max(lastMs, entry.receivedMs);
      if (batch.length >= SAVE_BATCH) {
        await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
        batch = [];
        await nango.saveCheckpoint({ sinceMs: lastMs - 1000 });
      }
    }
    if (batch.length > 0) await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
    const finished = queue.length === listed.length && !more;
    await nango.saveCheckpoint({
      sinceMs: finished ? Math.max(sinceMs, startedAt - OVERLAP_MS) : lastMs - 1000
    });
  }
});
```

In `nango-integrations/index.ts`, append:

```ts
import './trevra-zoho-mail/syncs/inbound-messages.js';
```

(The folder name must equal the Nango integration id, as for Gmail and Microsoft. Task 6's catalog default is `trevra-zoho-mail`.)

- [ ] **Step 5: Run the tests and the Nango compile to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/email/zoho-sync-helpers.test.ts src/server/email/inbound-sync-helpers.test.ts`
Expected: PASS.

Run: `npm run check:nango`
Expected: PASS. The compile lists `trevra-zoho-mail` `inbound-messages` beside the Gmail and Microsoft syncs. A type error on `params` means Nango's proxy param type rejects a value; pass it as a string (`String(start)`).

- [ ] **Step 6: Live dry run against the S1 test connection (UNVERIFIED shapes S4, S5, S7)**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations/nango-integrations
npx nango dryrun inbound-messages "$ZOHO_CONNECTION_ID" --integration-id trevra-zoho-mail --metadata '{"trevraInboundAddress":"<the test mailbox>"}'
```

Expected: the run lists the test inbox and saves `InboundEmailMessage` records. Each has `mailboxAddress` set and a non-empty `body`, and the S3 reply carries `replyToMessageIds` that contain the S3 Message-ID. Record the outcome in the smoke-results file, with no bodies or addresses. If a shape differs, fix the parser and add the observed shape to Step 1's fixtures before committing.

- [ ] **Step 7: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add nango-integrations/shared/zoho-mail.ts nango-integrations/trevra-zoho-mail/syncs/inbound-messages.ts nango-integrations/index.ts src/server/email/zoho-sync-helpers.test.ts src/server/email/inbound-sync-helpers.test.ts
git commit -m "feat(email): Zoho Mail inbound-messages sync" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 13: The remaining provider lists

**Files:**

- Modify: `src/server/today.ts:411-414`, `src/server/today.test.ts`
- Modify: `src/server/email.ts:325-333` (`humanProvider`)
- Modify: `src/server/conversation-replies.ts`, `src/server/conversation-replies.test.ts`

**Interfaces:**

- Consumes:
  - From Task 2: `email_deliverability_checks.provider = 'zoho'` is allowed.
  - From Task 3: `mailProviderFor`.
  - From Task 7: a Zoho send refuses a thread.
- Produces:
  - Today's `deliverability_blocked` matches a `zoho-mail` mailbox to a `zoho` check.
  - The reconnect email names "Zoho Mail".
  - `prepareConversationEmailReply` refuses a Zoho thread with a 409 before any run is created.

Every hard-coded mailbox provider list in `src/` either gains `zoho-mail` in this plan or is left out for the reason below:

| List                                                                                                         | Decision                       | Reason                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/email/deliverability.ts` `mailProviderFor`                                                       | Added (Task 3)                 |                                                                                                                                         |
| `src/server/email/mailbox-address.ts` `listSendingMailboxes`, `readProviderAddress`                          | Added (Task 6)                 |                                                                                                                                         |
| `src/server/integration-service.ts` catalog, `requiredMailbox` (L633)                                        | Added (Task 6)                 |                                                                                                                                         |
| `src/server/integration-service.ts` Gmail guard (L908)                                                       | Zoho branch before it (Task 7) |                                                                                                                                         |
| `src/server/conversations.ts:285`                                                                            | Added (Task 11)                |                                                                                                                                         |
| `src/server/today.ts:411-414`, `src/server/email.ts` `humanProvider`                                         | Added (this task)              |                                                                                                                                         |
| `src/server/conversation-replies.ts`                                                                         | Explicit refusal (this task)   | Zoho's send API takes no `In-Reply-To`/`References`, so a "reply" would be a new email pretending to be one.                            |
| `src/server/integration-service.ts:654` unbound fallback                                                     | Left out (comment, Task 6)     | Only a send bound to an approved `connectionId` may use Zoho. An unbound send has no approved opt-out mode.                             |
| `src/server/integration-service.ts:1139` `readConnectedEmailThreadEvents`                                    | Left out                       | Zoho has no thread API Trevra uses. It returns `[]` for Zoho, and Zoho replies arrive through the inbound sync (Tasks 11 and 12).       |
| `src/server/linkedin/campaign-channels.ts:201,1169,1237`, `src/client/LinkedInManagerCampaignConfig.tsx:595` | Left out                       | Campaign email steps thread follow-ups and poll thread events. Zoho can do neither, and campaign mail has no reply-to-unsubscribe mode. |
| `src/server/action-service.ts:65`                                                                            | Left out                       | It creates legacy `email_draft` actions through the Gmail and Microsoft draft APIs. Zoho has no draft path in this phase.               |
| `src/server/db.ts:756`                                                                                       | Left out                       | Demo seed data only.                                                                                                                    |
| `src/client/views/format.ts` `prettyProvider`                                                                | Unchanged                      | It already renders `zoho-mail` as "Zoho Mail".                                                                                          |

- [ ] **Step 1: Write the failing tests**

In `src/server/today.test.ts`, directly after `it('matches the mailbox provider to the failing check provider', …)`, add:

```ts
it('matches a Zoho Mail mailbox to a failing zoho check', async () => {
  await seedMailbox({ provider: 'zoho-mail' });
  await seedCheck('fail', '2026-08-21T07:30:00.000Z', WORKSPACE, 'google');
  expect(
    (await getToday(db, WORKSPACE, NOW)).needsAttention.filter(
      (item) => item.kind === 'deliverability_blocked'
    )
  ).toEqual([]);

  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await seedCheck('fail', '2026-08-21T07:30:00.000Z', WORKSPACE, 'zoho');
  const items = (await getToday(db, WORKSPACE, NOW)).needsAttention.filter(
    (item) => item.kind === 'deliverability_blocked'
  );
  expect(items).toHaveLength(1);
  expect(items[0]?.metadata).toEqual(expect.objectContaining({ provider: 'zoho' }));
});
```

In `src/server/conversation-replies.test.ts`, append inside `describe('conversation email reply preparation', …)`:

```ts
it('refuses to prepare a reply through Zoho Mail, which cannot thread one', async () => {
  const database = await openTestDb();
  const person = await resolveContact(database, DEMO_WORKSPACE_ID, {
    name: 'Zoho Thread',
    email: 'zoho.thread@northwind.test'
  });
  const conversationId = id('conv');
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
    )
    .run(conversationId, DEMO_WORKSPACE_ID, person.contact.id, now, now, now);
  await database
    .prepare(
      `INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
          source_type,source_id,occurred_at,created_at
        ) VALUES (?,?,?,'email','zoho-mail','inbound','Re: Hello','Friday works.','zoho-mail:1777',
          'email_inbound','zoho-mail:1777',?,?)`
    )
    .run(id('cmsg'), DEMO_WORKSPACE_ID, conversationId, now, now);
  const runsBefore = await database
    .prepare('SELECT COUNT(*)::int AS total FROM playbook_runs WHERE workspace_id=?')
    .get<{ total: number }>(DEMO_WORKSPACE_ID);

  await expect(
    prepareConversationEmailReply(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      actorUserId: DEMO_USER_ID,
      conversationId,
      idempotencyKey: 'reply-idempotency-zoho-01',
      subject: 'Re: Hello',
      body: 'Great, Friday it is.'
    })
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('Zoho Mail')
  });
  const runsAfter = await database
    .prepare('SELECT COUNT(*)::int AS total FROM playbook_runs WHERE workspace_id=?')
    .get<{ total: number }>(DEMO_WORKSPACE_ID);
  expect(runsAfter?.total).toBe(runsBefore?.total);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts src/server/conversation-replies.test.ts`
Expected: FAIL. Today has no item for the `zoho` check, and the Zoho reply is prepared (`waiting_approval`) instead of refused.

- [ ] **Step 3: Implement**

In `src/server/today.ts`, change the `CASE` to:

```sql
             AND CASE
                   WHEN c.provider IN ('gmail','google-mail') THEN 'google'
                   WHEN c.provider IN ('microsoft','outlook') THEN 'microsoft'
                   WHEN c.provider='zoho-mail' THEN 'zoho'
                 END=d.provider
```

In `src/server/email.ts` `humanProvider`, add after the Microsoft line:

```ts
if (key === 'zoho-mail') return 'Zoho Mail';
```

In `src/server/conversation-replies.ts`, add `import { mailProviderFor } from './email/deliverability.js';`. Directly after the `if (!thread) { … }` block, add:

```ts
// Zoho Mail's send API takes no In-Reply-To or References, so Trevra cannot
// thread a reply there (src/server/email/zoho-mail.ts). Refuse rather than
// send a new email that pretends to be a reply.
if (mailProviderFor(thread.provider) === 'zoho') {
  throw new ConversationReplyError(
    'Trevra cannot send replies through Zoho Mail yet. Reply from Zoho Mail directly.',
    409
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/today.test.ts src/server/conversation-replies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/server/today.ts src/server/today.test.ts src/server/email.ts src/server/conversation-replies.ts src/server/conversation-replies.test.ts
git commit -m "feat(email): name Zoho Mail in Today and refuse unthreadable Zoho replies" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 14: Client, with the DKIM selector form, the Zoho note and the cap skip label

**Files:**

- Modify: `src/client/api.ts` (`saveDkimSelector`)
- Modify: `src/client/EmailChannelSummary.tsx`, `src/client/EmailChannelSummary.test.tsx`
- Modify: `src/client/EmailChannelPanel.tsx`
- Modify: `src/client/views/gtmPlanFormat.ts`, `src/client/views/gtmPlanFormat.test.ts`
- Modify: `src/client/styles.css` (after `.email-channel-actions`)

**Interfaces:**

- Consumes:
  - From Task 4: `PUT /api/email/dkim-selector` `{ connectionId, selector: string | null }` → `{ channel }`, and `mailboxes[].dkimSelector`.
  - From Task 6: `mailboxes[].unsubscribeMode` and `mailboxes[].dailyCap`.
  - From Task 3: the blocker code `email_dkim_selector_missing`.
  - From Task 10: the skip reason `'daily_cap'`.
- Produces:
  - `saveDkimSelector(connectionId: string, selector: string | null): Promise<EmailChannelStatus>`
  - `EmailChannelBusy` gains `` `dkim:${string}` ``.
  - The `EmailChannelSummary` prop `onSaveDkimSelector: (connectionId: string, selector: string | null) => void`.

- [ ] **Step 1: Write the failing tests**

In `src/client/EmailChannelSummary.test.tsx`, add `onSaveDkimSelector={noop}` to the `render` helper's `<EmailChannelSummary …/>`. In `'tells a workspace without a mailbox how to start and disables the DNS check'`, change `expect(markup).toContain('Connect Gmail or Microsoft 365');` to:

```ts
expect(markup).toContain('Connect Gmail, Microsoft 365 or Zoho Mail');
```

Then append inside `describe('EmailChannelSummary', …)`:

```tsx
const ZOHO: EmailChannelStatus['mailboxes'][number] = {
  ...MAILBOX,
  connectionId: 'conn_zoho',
  provider: 'zoho-mail',
  providerKey: 'zoho',
  unsubscribeMode: 'footer_and_reply',
  dailyCap: 50,
  deliverability: deliverability({
    provider: 'zoho',
    status: 'fail',
    dkim: { status: 'fail', detail: 'No DKIM selector is set for this domain.', record: null },
    blockers: [
      {
        code: 'email_dkim_selector_missing',
        message: 'Enter the DKIM selector from your Zoho Mail admin console.',
        actionHref: '/setup/workspace'
      }
    ]
  })
};

it('explains reply-to-unsubscribe and the daily cap for a Zoho Mail sender', () => {
  const markup = render(channel({ mailboxes: [ZOHO] }));
  expect(markup).toContain('Zoho Mail');
  expect(markup).toContain('Zoho Mail cannot add one-click unsubscribe.');
  expect(markup).toContain('at most 50 a day');
  expect(render(channel())).not.toContain('Zoho Mail cannot add one-click unsubscribe.');
});

it('opens the DKIM selector form when the check needs one, for the owner only', () => {
  const owner = render(channel({ mailboxes: [ZOHO] }));
  expect(owner).toContain('<details class="email-channel-dkim" open="">');
  expect(owner).toContain('<span class="ui-field-label">DKIM selector</span>');
  expect(owner).toMatch(/<input[^>]*name="dkimSelector"/);
  expect(owner).toMatch(/<button[^>]*type="submit"[^>]*>Save selector<\/button>/);
  expect(render(channel({ mailboxes: [ZOHO] }), { isOwner: false })).not.toContain('dkimSelector');
});

it('keeps the DKIM selector form closed when DKIM passes and shows the stored selector', () => {
  const markup = render(channel({ mailboxes: [{ ...MAILBOX, dkimSelector: 'custom2026' }] }));
  expect(markup).toContain('<details class="email-channel-dkim">');
  expect(markup).toContain('DKIM selector: custom2026');
  expect(markup).toContain('value="custom2026"');
});

it('shows progress while a DKIM selector saves and disables the other controls', () => {
  const markup = render(channel(), { busy: 'dkim:conn_mail_1' });
  expect(markup).toContain('Saving…');
  expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS/);
  expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use for inbound mail/);
});
```

In `src/client/views/gtmPlanFormat.test.ts`, append inside `describe('emailSkipSummary', …)`:

```ts
it('names the Zoho Mail daily cap', () => {
  expect(
    emailSkipSummary([
      { contactId: 'a', reason: 'daily_cap' },
      { contactId: 'b', reason: 'already_pending' },
      { contactId: 'c', reason: 'daily_cap' }
    ])
  ).toBe("Skipped 3: 1 already waiting for approval, 2 over today's Zoho Mail sending limit.");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/client/EmailChannelSummary.test.tsx src/client/views/gtmPlanFormat.test.ts`
Expected: FAIL. There is no DKIM form and no Zoho note, the empty copy is the old one, and `daily_cap` is not counted.

- [ ] **Step 3: Implement the API call and the skip label**

In `src/client/api.ts`, add after `recheckEmailDns`:

```ts
export async function saveDkimSelector(
  connectionId: string,
  selector: string | null
): Promise<EmailChannelStatus> {
  const result = await request<{ channel: EmailChannelStatus }>('/api/email/dkim-selector', {
    method: 'PUT',
    body: JSON.stringify({ connectionId, selector })
  });
  return result.channel;
}
```

In `src/client/views/gtmPlanFormat.ts`, append to `SKIP_LABELS` after `already_pending`:

```ts
['daily_cap', "over today's Zoho Mail sending limit"];
```

- [ ] **Step 4: Implement the summary**

In `src/client/EmailChannelSummary.tsx`:

- Add `import type { FormEvent } from 'react';`.
- Change the primitives import to `import { Button, Field, Input } from './ui/primitives';`.
- Change the busy type to:

```ts
export type EmailChannelBusy = 'recheck' | 'stop' | `inbound:${string}` | `dkim:${string}` | null;
```

Add `onSaveDkimSelector` to the destructured props and to the prop type, as `onSaveDkimSelector: (connectionId: string, selector: string | null) => void;`. Inside the component, before `return`, add:

```tsx
function saveSelector(event: FormEvent<HTMLFormElement>, connectionId: string) {
  event.preventDefault();
  const value = String(new FormData(event.currentTarget).get('dkimSelector') ?? '').trim();
  // Empty clears the selector and returns to the provider's standard ones.
  onSaveDkimSelector(connectionId, value || null);
}
```

Change the empty copy to `Connect Gmail, Microsoft 365 or Zoho Mail above to send outreach email and read replies.`

In the mailbox `map`, after `const pendingDetail = …;`, add:

```tsx
const domain = mailbox.address?.split('@')[1] ?? null;
const needsSelector = (mailbox.deliverability?.blockers ?? []).some(
  (issue) => issue.code === 'email_dkim_selector_missing'
);
```

Directly after `{pendingDetail && <p className="email-channel-pending">{pendingDetail}</p>}`, add:

```tsx
{
  mailbox.unsubscribeMode === 'footer_and_reply' && (
    <p className="email-channel-note">
      Zoho Mail cannot add one-click unsubscribe. Outreach from this mailbox ends with your footer
      asking people to reply “unsubscribe”
      {mailbox.dailyCap !== null ? `, and sends at most ${mailbox.dailyCap} a day` : ''}.
    </p>
  );
}
{
  isOwner && domain && (
    <details className="email-channel-dkim" open={needsSelector}>
      <summary>
        {mailbox.dkimSelector ? `DKIM selector: ${mailbox.dkimSelector}` : 'DKIM selector'}
      </summary>
      <form
        className="email-channel-dkim-form"
        onSubmit={(event) => saveSelector(event, mailbox.connectionId)}
      >
        <Field
          label="DKIM selector"
          hint={`From your mail provider's DKIM settings. Trevra checks <selector>._domainkey.${domain}. Leave empty to use the provider's standard selectors.`}
        >
          <Input
            name="dkimSelector"
            defaultValue={mailbox.dkimSelector ?? ''}
            placeholder="zmail"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            disabled={busy !== null}
          />
        </Field>
        <Button type="submit" disabled={busy !== null}>
          {busy === `dkim:${mailbox.connectionId}` ? 'Saving…' : 'Save selector'}
        </Button>
      </form>
    </details>
  );
}
```

- [ ] **Step 5: Wire the panel and style the new parts**

In `src/client/EmailChannelPanel.tsx`:

- Add `saveDkimSelector` to the `./api` import.
- Change the `Panel` description to `"Sending-domain checks, unsubscribe, and the one mailbox Trevra reads."`.
- Add this prop to `<EmailChannelSummary …/>`, after `onRecheck`:

```tsx
          onSaveDkimSelector={(connectionId, selector) =>
            void run(
              `dkim:${connectionId}`,
              () => saveDkimSelector(connectionId, selector),
              selector ? 'DKIM selector saved and DNS checked again' : 'DKIM selector cleared'
            )
          }
```

In `src/client/styles.css`, directly after the `.email-channel-actions { … }` rule, add these layout-only rules. They use existing tokens, and the input and button keep the shared `ui-control` and `ui-button` skins:

```css
.email-channel-note {
  margin: 0;
  color: var(--muted);
  font-size: var(--t-text-xs);
}
.email-channel-dkim {
  width: 100%;
}
.email-channel-dkim > summary {
  display: inline-flex;
  align-items: center;
  min-height: var(--t-tap);
  color: var(--muted);
  font-size: var(--t-text-xs);
  font-weight: var(--t-w-strong);
  cursor: pointer;
}
.email-channel-dkim-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}
.email-channel-dkim-form .ui-field {
  flex: 1 1 220px;
  min-width: 0;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/client/EmailChannelSummary.test.tsx src/client/views/gtmPlanFormat.test.ts src/client/ui/route.test.ts`
Expected: PASS.

- [ ] **Step 7: Check it by eye**

Run `npm run dev` and open `/setup/workspace` with a Zoho mailbox whose check reports `email_dkim_selector_missing`. Check light and dark themes at 1280px and at 360px wide. The DKIM details is open, the input and button are at least `--t-tap` high, the focus ring is visible on the summary, input and button, and nothing scrolls sideways. Save `zmail`: the toast reads "DKIM selector saved and DNS checked again", and the summary shows `DKIM selector: zmail`.

- [ ] **Step 8: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add src/client/api.ts src/client/EmailChannelSummary.tsx src/client/EmailChannelSummary.test.tsx src/client/EmailChannelPanel.tsx src/client/views/gtmPlanFormat.ts src/client/views/gtmPlanFormat.test.ts src/client/styles.css
git commit -m "feat(client): DKIM selector form and Zoho Mail notes in the email panel" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 15: Contracts, environment, phase sweep and the final gate

**Files:**

- Modify: `docs/integration-contracts.md`
- Modify: `.env.example`

**Interfaces:**

- Consumes: everything above.
- Produces: the documented Zoho Mail contract, and a green `npm run check` and `npm run check:nango`.

- [ ] **Step 1: Document the contract**

In `docs/integration-contracts.md`, replace the `email.send` bullet under "Explicit GTM execution actions" with:

```markdown
- `email.send` — send through a connected Gmail, Microsoft 365 or Zoho Mail mailbox. When the approved metadata names `connectionId` and `senderAddress`, the email leaves only from that connection. It must also still verify as that address with the provider; otherwise nothing is sent and the action answers 409. Outreach email approved with `requireListUnsubscribe: true` carries RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers, or it is not sent. Outreach email is also refused (409) when it carries no mailbox binding, or does not end with the workspace compliance footer for its approved `unsubscribeMode`. Zoho Mail sends only bound, approved outreach whose `unsubscribeMode` is `footer_and_reply`, as plain text with no thread, at most 50 a day per mailbox (429 beyond that); Gmail and Microsoft 365 refuse `footer_and_reply`.
```

In "Trevra-owned Nango functions", change the integration list sentence to:

```markdown
The inbound-mailbox syncs are Trevra code in `nango-integrations/`, in Nango's zero-YAML layout. Each folder name equals a Nango integration id (`trevra-gmail`, `trevra-microsoft`, `trevra-zoho-mail`). If `NANGO_GMAIL_INTEGRATION`, `NANGO_MICROSOFT_INTEGRATION` or `NANGO_ZOHO_MAIL_INTEGRATION` names a different integration, rename the folder to match.
```

In "Inbound mailbox sync (`inbound-messages`)", change "runs on the `trevra-gmail` and `trevra-microsoft` integrations" to "runs on the `trevra-gmail`, `trevra-microsoft` and `trevra-zoho-mail` integrations".

Then add this section directly before `## Inbound website lead capture`:

```markdown
## Zoho Mail

Zoho Mail connects through Nango's built-in `zoho-mail` provider (OAuth2). The connection's `extension` (`com`, `eu`, `in`, `com.au`, `com.cn` or `jp`) picks the data centre. Trevra stores no password and has no SMTP path. Create the Nango integration `trevra-zoho-mail` (or set `NANGO_ZOHO_MAIL_INTEGRATION`) with exactly these scopes: `ZohoMail.accounts.READ,ZohoMail.messages.CREATE,ZohoMail.messages.READ,ZohoMail.folders.READ`.

- **Identity.** `GET /api/accounts` must list exactly one `ZOHO_ACCOUNT`. Its `primaryEmailAddress` (else `mailboxAddress`) is the mailbox address. Two accounts, or none, is refused rather than guessed.
- **Send.** `POST /api/accounts/{accountId}/messages` with `{fromAddress, toAddress, subject, content, mailFormat: 'plaintext', encoding: 'UTF-8'}` and no proxy retries. Trevra re-reads the account before every send and refuses (409) when it no longer matches the approved `senderAddress`. Afterwards it reads the sent message's `Message-ID` from the Sent folder header, best effort and bounded, so a reply can thread to the delivery.
- **Opt-out.** Zoho's API cannot set `List-Unsubscribe`. Zoho outreach is approved with `unsubscribeMode: 'footer_and_reply'` and ends with the compliance footer, whose opt-out sentence is replaced by a "reply unsubscribe" sentence. A reply classified as unsubscribe suppresses the Person when it threads to the delivery, or, unthreaded, when this same Zoho mailbox sent that Person outreach.
- **Daily cap.** At most 50 outreach emails per Zoho mailbox in any 24 hours, the lower of that and the mailbox's `daily_limit`. Preparation skips the excess as `daily_cap`, counting waiting approvals. The send refuses with 429.
- **DNS.** SPF must include Zoho's sender (`zohomail.com` or `one.zoho.com`, plus the data-centre includes recorded at rollout). DKIM has no standard Zoho selector: the owner enters the selector from the Zoho Mail admin console in Workspace settings, stored per sending domain in `email_dkim_selectors`.
- **Inbound.** The `inbound-messages` sync lists the Inbox (`/messages/view`, newest first), then reads each new message oldest first through `/messages/{id}/originalmessage`, falling back to the folder header and list summary. Records have no `externalUrl`.
- **Not supported.** Replies from Conversations through Zoho (refused with 409), HTML outreach, campaign email steps, and drafts.
```

- [ ] **Step 2: Environment**

In `.env.example`, directly after `NANGO_MICROSOFT_INTEGRATION=trevra-microsoft`, add:

```
NANGO_ZOHO_MAIL_INTEGRATION=trevra-zoho-mail
```

- [ ] **Step 3: Phase sweep (read the whole diff once before the gate)**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git diff main --stat
# Every hard-coded mailbox list either has zoho-mail or is in Task 13's table.
grep -rn "'gmail','google-mail','microsoft','outlook'\|'gmail', 'google-mail', 'microsoft', 'outlook'" src --include=*.ts --include=*.tsx | grep -v "\.test\."
# No SMTP, no stored secret, no password.
git diff main -- src migrations nango-integrations | grep -in "smtp\|password\|refresh_token\|access_token" || echo "none"
# Zoho never sends List-Unsubscribe.
grep -n "List-Unsubscribe" src/server/email/zoho-mail.ts || echo "none"
# No hash routes, no inline styles, no raw colours in the new client code.
git diff main -- src/client | grep -n "location.hash\|#/\|style={{\|#[0-9a-fA-F]\{3,6\}\b" || echo "none"
# Workspace scoping on every new query.
git diff main -- src/server | grep -n "FROM gtm_deliveries\|FROM connections\|FROM playbook_runs\|FROM email_dkim_selectors\|FROM person_identities\|FROM contacts"
```

Expected:

- The first grep lists only `integration-service.ts:654`, `action-service.ts:65` and `linkedin/campaign-channels.ts` (201, 1169, 1237), all in Task 13's table.
- The SMTP/secret grep, the `List-Unsubscribe` grep and the client grep print `none`.
- Every query line from the last grep is followed in its statement by `workspace_id=?`. Open each hit that does not show it on the same line, and confirm it.
- `ZOHO_OUTREACH_DAILY_CAP` appears in `zoho-mail.ts`, `email-deliveries.ts`, `outreach.ts`, `intent.ts` and `channel.ts`, and nowhere as a bare `50` outside `ZOHO_OUTREACH_DAILY_CAP` and `DEFAULT_OUTREACH_DAILY_CAP`.
- `git diff main -- src/server/playbooks/registry.ts` shows `emailOutreachPlaybook` (1.0.0) unchanged.

Fix every miss in the task that owns it before continuing.

- [ ] **Step 4: Run the authoritative gate**

Run: `npm run check`
Expected: PASS (lint, types, build, and the full PostgreSQL Testcontainer suite).

Run: `npm run check:nango`
Expected: PASS, with three `inbound-messages` syncs compiled.

Run: `npm audit --omit=dev`
Expected: no new advisories. This phase adds no dependencies.

- [ ] **Step 5: Commit**

```bash
cd /home/pankaj/Projects/Trevra/.claude/worktrees/gtm-integrations
git add docs/integration-contracts.md .env.example
git commit -m "docs(email): Zoho Mail contract and integration env" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

- [ ] **Step 6: Deployment note for the controller (no code)**

Before the Zoho option is offered in production:

- Create the `trevra-zoho-mail` integration in each self-hosted Nango environment with the scopes above.
- Deploy the syncs (`cd nango-integrations && npx nango deploy prod`).
- Confirm S1 against the pinned Nango image, not only the dev one.
- Replay the S3–S7 smoke steps once against production Nango with a founder-owned test mailbox.
