# Trevra email: late-suppression/provider-send acceptance

**Date:** 2026-10-21

**Decision:** **NO-GO for live-provider certification.** This note records local acceptance and defines the _authorized_ staging procedure; it does not approve live outreach or a deployment.

## Scope and implemented boundary

- All `executeConnectedAction` email paths now consult the workspace-wide suppression boundary immediately before provider dispatch, not only during initial preparation. This includes checking imported lead `do_not_contact` and linked LinkedIn Never Contact profile exclusions for **noncampaign/legacy/skill/reply email** even if no canonical suppression was separately materialized. For campaign email the same check revalidates claimed action/campaign/member cursor, the bound Person and unchanged recipient, Never Contact profile, current workspace policy and exact owner-review hash. Noncampaign sends recheck canonical email/domain suppression too.
- Gmail: check after asynchronous thread lookup and before `/messages/send`. Microsoft: check after draft creation and before each Graph `/send`; note the remote draft **may already exist**, but it has not been sent. Zoho: check after account lookup and sender validation, before the outbound message call.
- The check shares the transaction-scoped suppression advisory lock with opt-out writers. It **does not** hold the lock across remote I/O, nor can it recall an already-started provider request. A later opt-out overlapping a provider request must be recorded and reconciled, not asserted as a prevented send. An ambiguous provider response must never cause blind replay.
- Definite campaign pre-send refusals are classified as known failures in both the provider-delivery and campaign-channel ledgers. They do **not** prove anything about a provider request already in flight.

## Local evidence (no provider writes)

- PostgreSQL-backed Gmail race: opt-out commits while the prior-thread lookup is waiting; after lookup resumes, **zero** Nango send calls, delivery `failed`.
- PostgreSQL-backed Microsoft race: opt-out commits after draft API was invoked and before it returns; the Graph draft is the only provider call, **zero** `/send` calls, delivery `failed`.
- PostgreSQL-backed Zoho race: opt-out commits while reading the account identity; **zero** Nango send calls, delivery `failed`.
- PostgreSQL-backed noncampaign-email regressions: imported LinkedIn lead marked `do_not_contact` without a canonical suppression and separately a matching Never Contact profile without a canonical suppression each prevent a connected Gmail send. No provider calls are made.
- Positive provider-simulation tests and campaign/approval/branching regressions remain necessary: do not only run the three negative tests. Run `npx tsx scripts/test-with-postgres.ts src/server/integration-service.test.ts src/server/email/zoho-send.test.ts src/server/linkedin/campaign-channels.test.ts src/server/email/outreach-playbook.test.ts`, plus `npm run typecheck` and `npm run check`.
- Full `npm run check`: **exit 0** on 269/269 test files and 3,982/3,982 tests, TypeScript, Vite and server build. The standard build still swallows its known npm SBOM error; this is **not** release certification.
- The strict `npm run release:certify` remains fail-closed with **56** known release blockers at this revision. An additional `npm sbom --sbom-format cyclonedx --omit=dev` still reports `ESBOMPROBLEMS`; the existing package tree is not a verified fresh SBOM. Do not edit a tracked SBOM to make certification green.

## Authorized staging acceptance procedure (operator-controlled)

1. **Record authorization and isolation.** Identify an approved tenant, operator, sender accounts, and recipient mailboxes owned by the testing organization. Obtain provider/platform-terms, outreach consent, privacy/retention and legal sign-off before any real send. Do not use customer leads or paid probes for test convenience.
2. **Readiness.** Verify independently in staging: sender/tenant binding; OAuth/credential ownership and revocation; Gmail, Microsoft and Zoho Nango connectivity; inbound sync status; SPF, DKIM and DMARC; HTTPS unsubscribe origin and secrets; lawful-basis record; opt-out footer; tracking mode (off by default); mailbox caps and remaining quota. Capture redacted configuration evidence, not tokens.
3. **No-send negatives.** Use a staged send/campaign action with owner review. Before dispatch, apply email, Person/all-channel, domain, Never Contact and do-not-contact stops, campaign pause, approval revocation, sender change and policy deny. Verify no provider send event and that the delivery/campaign outcomes are **definite**; exercise each with a safely controlled test double where live provider timing cannot be influenced safely.
4. **Connected happy paths.** With explicit permission, send _one_ reviewed message to an owned test recipient per enabled provider. Verify the bound sender, actual rendered body/footer and one-click headers (where supported), provider message ID, recorded sent delivery, thread association, sent-only funnel attribution and retry idempotency. Zoho reply-to-unsubscribe is not equivalent to RFC8058 one-click: verify its reply-based policy separately.
5. **Reply and failure paths.** In owned mailboxes, verify real inbound reply, unsubscribe, hard bounce, delivery failure, webhook duplication/out-of-order delivery, missing permissions, reauthorization and transient provider outage. Confirm all affected campaign members/actions stop as required, no fabricated reply or funnel increment occurs, and unknown outcomes require an operator reconciliation before any resend.
6. **Concurrency and recovery.** Exercise two workers on an isolated tenant at the configured daily cap, opt-out during setup, and opt-out while a provider request is in flight (only with a controlled provider simulator). Verify reservation accounting, no duplicate send, no suppression bypass, and a documented ambiguity-resolution workflow. Do not assert that a live provider accepted/canceled a send based solely on a local test double.
7. **Sign-off artifacts.** Archive redacted request IDs, provider-side result IDs and timestamps, relevant DB delivery/action status rows, tenant and plan identity, tracking/consent evidence, inbox/event observations, operator names and UTC timestamps. Compare provider send history with `gtm_deliveries` and the campaign channel-action ledger; document every unpaired send, stale draft and uncertain record before approval.

## Remaining release prerequisites

- Owner-approved software distribution license and fresh, reproducible dependency inventory/SBOM.
- Authorized live provider acceptance for each supported mailbox and LinkedIn companion, including provider/platform-terms review, credential custody, rotation, secrets access and backup recovery.
- Full cross-adapter suppression/approval auditing (community writes, LinkedIn/browser clicks, cancellation between local check and remote effect), inbox/CRM/public API/team roles, real billing/trial/entitlement lifecycle, observability and infrastructure smoke/rollback.
- Complete 46-dimension Dripify capability evidence. Locally green tests do **not** change any registry item to `VERIFIED` without its full acceptance.

**Operator decision:** release remains **NO-GO** until the independent prerequisites and acceptance records are complete. No live charges, provider sends, deployments, merges or releases were performed in this milestone.
