# Trevra GTM integration contracts

**Status:** Current  
**Product boundary:** Trevra is a GTM operating system. Integrations may observe GTM state or execute an explicit GTM action. They do not turn Trevra into an accounting system, application backend, generic event bus, or arbitrary webhook runtime.

## Connection identity

Live provider connections are workspace scoped. Trevra stores provider/config connection references; provider credentials remain in the configured credential provider (normally Nango or Trevra secret custody).

A provider connection must never choose a workspace from payload data. The authenticated connection/source determines the workspace.

## Synced canonical records

The Nango canonical sync surface is intentionally narrow. It accepts only GTM records that map onto Trevra's canonical Person, Account, Conversation, and Opportunity-lite state.

### Message

```json
{
  "kind": "message",
  "id": "provider-message-id",
  "accountName": "Acme Labs",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "direction": "inbound",
  "subject": "Re: proposal",
  "body": "Can we talk on Thursday?",
  "occurredAt": "2026-08-20T09:00:00.000Z",
  "externalUrl": "https://provider.example/message/123"
}
```

### Opportunity

```json
{
  "kind": "opportunity",
  "id": "provider-opportunity-id",
  "accountName": "Acme Labs",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "title": "Expansion conversation",
  "status": "proposal",
  "proposalSentAt": "2026-08-18T09:00:00.000Z",
  "expectedResponseAt": "2026-08-25T09:00:00.000Z",
  "externalUrl": "https://provider.example/opportunity/123"
}
```

Opportunity is minimal GTM progression state. Its bounded stages are `new`, `qualified`, `meeting`, `proposal`, `won`, and `lost`; it does not own amount, forecast, accounting currency, delivery milestones, contracts, projects, or payment state.

### Meeting

```json
{
  "kind": "meeting",
  "id": "provider-event-or-booking-id",
  "previousId": "booking-id-this-one-replaces",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "status": "scheduled",
  "startAt": "2026-08-20T09:00:00+02:00",
  "endAt": "2026-08-20T09:30:00+02:00",
  "externalUrl": "https://www.google.com/calendar/event?eid=abc"
}
```

A meeting is a time and one matched Person. Trevra never stores its title, description, location, conference link or guest list. `status` is `scheduled`, `rescheduled` or `cancelled`. A meeting that is not cancelled needs `personEmail`, `startAt` and `endAt`, with a UTC offset.

`origin` is never part of the record. The ingress path sets it: the Cal.com webhook is `booking`, calendar sync (and every other caller) is `calendar`, and `/api/events` does not accept meetings. It sets how much the meeting is allowed to do:

- `calendar` is an observation. It attaches only to a Person already in the workspace, and only raises an Opportunity that already existed when the meeting ended.
- `booking` is intent. It may create the Person, and an Opportunity at `meeting`.

Stages only move forward. Cancelling a meeting never lowers one. Meetings are deleted with their Person and with the workspace.

## Explicit GTM execution actions

External writes use Trevra's prepared-action / exact-payload approval boundary. The execution registry is closed, not user-programmable.

Current prepared execution action types are:

- `email.send` — send through a connected Gmail or Microsoft 365 mailbox.
- `community.reply` — publish a governed reply through a supported GTM community channel.
- `crm.log-activity` — append a GTM activity to a connected CRM record.
- `buffer.create-draft` — create an unscheduled Buffer draft only after exact-payload founder approval. The mutation always uses Buffer's draft mode and never supplies a publish time.

There is no generic remote-action adapter and no arbitrary webhook action. A new external write requires a named GTM action, a bounded payload schema, policy/approval semantics, a dedicated adapter, and tests.

## Nango sync behavior

A Nango sync is resolved from the registered provider configuration and external connection identity to exactly one Trevra workspace. Ambiguous connection ownership is refused.

1. reads Nango's deletion marker (`_nango_metadata.last_action`/`deleted_at`), then removes Nango transport metadata;
2. maps only a supported GTM model alias;
3. validates the bounded canonical schema;
4. stores source evidence with workspace/provider identity;
5. deterministically resolves a canonical Person and optional Account identity;
6. records provider identity evidence and upserts the GTM message, Opportunity-lite or meeting state.

Records that cannot be read (an unsupported model, or a calendar event in a shape this build does not parse) are counted as skipped and reported on the connection, rather than silently treated as a successful empty sync. Readable records that Trevra deliberately leaves out are counted as ignored. These are internal, personal and all-day calendar events, and meetings with nobody already in the workspace. Google Calendar events are read in the Calendar API `Event` shape (https://developers.google.com/calendar/api/v3/reference/events). Only the time, the link, and the one attendee who matches an existing Person are kept.

## Inbound mailbox sync (`inbound-messages`)

The read-only `inbound-messages` sync (model `InboundEmailMessage`) runs on the `trevra-gmail` and `trevra-microsoft` integrations from `nango-integrations/`. Trevra starts it when a workspace designates its inbound mailbox, and it emits canonical `message` records with `mailboxAddress` set. A record with that model but no `mailboxAddress` is skipped, never ingested. The sync drops list and bulk mail and mail sent from the mailbox itself; Trevra re-checks every record server-side and keeps only senders it already knows.

Nango's self-hosted record store retains synced message records until the connection is deleted. Trevra's own tables never store strangers' mail.

## Inbound website lead capture

Website/form ingestion is **not** the old generic `/api/events` route. It is a GTM-specific capture source contract described in `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`; the operator/integrator runbook is `docs/lead-capture.md`.

The intended resource model is:

```text
Workspace
  -> GTM/Capture Source
  -> Person
  -> Inbound Submission
  -> optional Account association
  -> Signal / Opportunity / Conversation / Playbook
```

The request never supplies the destination workspace. The authenticated GTM source determines it.

## Cal.com booking webhooks

An owner creates a Cal.com endpoint on `/setup/capture`. Trevra shows the subscriber URL (`/api/hooks/v1/calcom/<endpoint id>`) and a signing secret, once. The endpoint, not the payload, decides the workspace.

- Signature: `X-Cal-Signature-256` is the hex HMAC-SHA256 of the raw body. The literal `no-secret-provided` is refused with 401.
- Body: the default `{ triggerEvent, createdAt, payload }`. A custom payload template is refused with 400.
- Event id: the SHA-256 hex of `<triggerEvent>\n<payload.uid>\n<createdAt>`, which dedupes redeliveries in `webhook_events`.
- Handled triggers:
  - `BOOKING_CREATED` becomes `scheduled`.
  - `BOOKING_RESCHEDULED` becomes `rescheduled`, with `previousId` set from `rescheduleUid`; the replaced booking is cancelled.
  - `BOOKING_CANCELLED` becomes `cancelled`.
- Every other trigger, `PING` and the flat `MEETING_STARTED`/`MEETING_ENDED` included, is accepted and ignored. A signed booking Trevra cannot read is recorded as ignored, not retried.
- The attendee is the first one who is not the organizer and not a workspace user. The booking's title, description, notes and other guests are not stored.

## CRM integrations

HubSpot and Attio may observe GTM records. CRM activity write-back is a dedicated `crm.log-activity` action behind Trevra's approval/execution boundary. Do not add ungated record mutation to the sync path.

## GitHub repository traction (proxy reads)

GitHub is an observe-only connection: Nango provider `github`, integration id `NANGO_GITHUB_INTEGRATION` (default `trevra-github`), no OAuth scopes. There is no Nango sync and no canonical record kind; the worker reads through the Nango proxy, at most hourly per watched repository, and writes account signals.

- **Watched repositories:** the workspace owner lists up to 10 public `owner/name` repositories under Setup -> Workspace. Stored in `watched_repositories` with per-kind cursors and ETags, never credentials.
- **Reads:** `GET /repos/{owner}/{repo}` (ETag), `/stargazers` with `Accept: application/vnd.github.star+json` (for `starred_at`), `/forks?sort=newest`, `/issues?state=all&sort=created&since=...` (ETag; pull requests and `OWNER`/`MEMBER`/`COLLABORATOR` authors skipped), `/users/{login}`, `/orgs/{org}`.
- **Resolution:** public data only. A `@org` handle in the profile `company` whose organization lists a website; else the public email domain (freemail skipped); else the profile `blog` domain (personal platforms such as `github.io` or `medium.com` skipped). A plain-text company name is never turned into a company.
- **Writes:** `repo-starred`, `repo-forked` and `repo-issue-opened` account signals through `recordSignals`; evidence is the GitHub profile URL or the issue URL. Existing accounts are attached by domain; new accounts (`source = 'github'`, tag `github-traction`) are created at most 5 per poll run; `not_a_fit` and `archived` accounts are never reactivated. Resolved logins are kept in `github_repo_actors` (login, profile URL); unresolved people are counted on the repository and never stored.
- **Very large repositories:** GitHub is believed to refuse stargazer pages past 400, so a repository with more than 40,000 stars (`MAX_STARGAZERS_LISTABLE`) skips the star listing and still reports forks and issues; the GraphQL `stargazers(orderBy: STARRED_AT DESC)` connection is the upgrade path.
- **Honest state:** a 401 or a Nango authorization failure flips the connection to `needs_reauth`; an exhausted rate limit pauses polling until GitHub's reset time; both show on the Setup card instead of zero activity.
- **Upgrade path:** GitHub App webhooks (`star`, `fork`, `issues`) through Nango's `github-app` provider replace polling.

## Provider admission rule

A connector belongs in Trevra only when it does at least one of these:

1. **Observe GTM state** — People, Accounts, Conversations, GTM signals, Opportunities, and campaign/reply outcomes.
2. **Execute a GTM action** — a bounded founder-approved outreach or CRM action.

Do not add providers whose primary purpose is customer accounting, invoicing, project delivery, contract administration, arbitrary application telemetry, generic storage, or arbitrary webhook automation.

## Explicitly removed / unsupported

Trevra does not expose or own customer-business:

- projects;
- contracts / clauses;
- scope items / commitments / deliverables;
- milestones;
- invoices;
- payments;
- accounting-provider actions;
- customer Stripe payment webhooks;
- generic `/api/events` ingestion;
- generic remote action adapters;
- campaign workflow `webhook` or `external_handoff` primitives.

Trevra's own future SaaS subscription billing is a separate platform concern and must not recreate these customer-business entities.
