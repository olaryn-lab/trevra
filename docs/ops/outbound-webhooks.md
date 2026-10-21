# Outbound merchant webhooks — operational qualification (2026-10-21)

**Status:** code foundation implemented; **TRV-052 remains IN PROGRESS, not production-certified.** No staging or production migration, live delivery, or network destination was used in qualification.

## Durable contract

- Workspace owners manage subscriptions through `GET /api/outbound-webhooks`, `POST /api/outbound-webhooks` and `DELETE /api/outbound-webhooks/:id`. Per-subscription outcomes can be read at `GET /api/outbound-webhooks/:id/deliveries?limit=50`. Owner session is required and all queries are tenant-scoped.
- `POST` accepts `{ "url": "https://hooks.example.org/trevra", "eventTypes": ["linkedin_campaign.started"] }`. On success it returns `signingSecret` **exactly once**. It is thereafter stored as AES-GCM ciphertext bound to tenant+subscription identity. Operators must save it securely; the read API never returns it.
- Existing campaign control audit events (`start`, `pause`, `stop`) are bridged into the canonical domain event stream at audit time, with metadata deliberately omitted. The campaign state transition itself may commit earlier than its audit write; final end-to-end completeness still needs acceptance. Events currently supported: `linkedin_campaign.started`, `linkedin_campaign.stopped`, `linkedin_campaign.paused`, `playbook.run.completed`, `playbook.run.failed`. Other domain events (including source secrets, email addresses and unrestricted event metadata) are **not published**. The payload contains only the event id/type/time and stream type/id/version, never unrestricted domain-event `payload_json`.
- The append and the matching outbox entries share a PostgreSQL transaction. Duplicate `(subscription_id,event_id)` entries are disallowed. A delivery claim is `FOR UPDATE SKIP LOCKED`; a one-minute lease and lease token fence stale worker settlements. A lost HTTP response is an **unknown outcome**, and retry can cause another HTTP POST. Consumers **must deduplicate** by `X-Trevra-Event-Id` or `X-Trevra-Delivery-Id`.
- `X-Trevra-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>` signs `"<unix-seconds>.<raw-UTF8-body>"` using `signingSecret`; consumers must compare in constant time and reject old timestamps according to their own replay window. Other headers: `X-Trevra-Event-Id`, `X-Trevra-Delivery-Id`. Ids remain stable across retries; signatures have a fresh timestamp.
- 2xx is delivered; non-2xx and transport failures retry (1, 2, 4, 8, 16, 32 minutes, capped at 60), up to six attempts, then remain in `dead` state for operator inspection. No automatic dead-letter replay is available. Deactivation cancels queued or leased deliveries but **cannot recall an already running HTTP request**.

## Destination safety and activation

1. Explicitly approve **exact** allowed hostnames with `TREVRA_OUTBOUND_WEBHOOK_HOSTS=hooks.example.org,events.partner.com`. There is no wildcard or default host. Without this setting, creation is refused and the worker will not claim work for dispatch.
2. The server rejects HTTP, IP literals, arbitrary ports, userinfo, query strings, fragments and hosts outside the allowlist. It issues HTTPS POSTs with a 5-second timeout and redirects disabled.
3. **Not a complete SSRF guarantee:** a DNS record for an allowed hostname could resolve to a private/internal address or change after inspection. Production egress firewall/DNS policy must restrict private, link-local, metadata-service and other internal destinations. Do not configure arbitrary customer-controlled wildcard/hostname values without validated egress isolation. Deployment security review is required before enabling.
4. The existing worker calls `dispatchOutboundWebhookDeliveries` in its own minute-cadence loop with an in-flight guard; it does not block the main automation/campaign loop. With no host allowlist it is inert. No worker or application server was started for this qualification.

## Readiness still missing

- Live HTTPS destination acceptance (valid signature, retries, outage, unknown outcome, key custody/rotation, support recovery), operational metrics and paging on dead letters.
- Delivery latency/SLO under load, fair scheduling across busy tenants and explicit subscription limits/pricing, privacy/legal approval of payload scopes and any future events.
- DNS rebinding protection verified against deployed network controls; review of who may administer `TREVRA_OUTBOUND_WEBHOOK_HOSTS`.
- Migration `147_outbound_webhook_outbox.sql` qualified on disposable PostgreSQL only. **No production database migration was applied.**

## Local reproducibility

`npx tsx scripts/test-with-postgres.ts src/server/outbound-webhooks.test.ts src/server/outbound-webhooks.api.test.ts`

Use `npm run check` for the development gate; `npm run release:certify` must stay red while the broader parity/license/SBOM/provider/ops blockers remain unresolved.
