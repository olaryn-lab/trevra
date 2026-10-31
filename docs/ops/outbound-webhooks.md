# Outbound merchant webhooks — operational qualification

**Status:** code foundation and TRV-052 hardening (egress controls, secret rotation, dead-letter replay, delivery visibility) implemented; **TRV-052 remains IN PROGRESS, not production-certified.** No staging or production migration, live delivery, or network destination was used in qualification.

## Durable contract

- Workspace owners manage subscriptions through the owner-only, tenant-scoped API below. Every response is `Cache-Control: no-store`.
  - `GET /api/outbound-webhooks`, `POST /api/outbound-webhooks`, `DELETE /api/outbound-webhooks/:id` (deactivate).
  - `PATCH /api/outbound-webhooks/:id` with any of `{ url, eventTypes, active }`. `active:false` pauses and moves queued deliveries to `dead`; `active:true` resumes and clears the failure streak.
  - `POST /api/outbound-webhooks/:id/rotate-secret` with `{ overlapHours: 0..168 }` (default 24).
  - `GET /api/outbound-webhooks/:id/health?limit=25` and `GET /api/outbound-webhooks/:id/deliveries?limit=50`.
  - `POST /api/outbound-webhooks/:id/replay` with optional `{ limit: 1..500 }`, and `POST /api/outbound-webhooks/:id/deliveries/:deliveryId/replay`.
- `POST` accepts `{ "url": "https://hooks.example.org/trevra", "eventTypes": ["linkedin_campaign.started"] }` and returns `signingSecret` **exactly once**. Secrets are stored as AES-GCM ciphertext bound to tenant+subscription identity; the read API never returns them.
- Events currently supported: `linkedin_campaign.started`, `linkedin_campaign.stopped`, `linkedin_campaign.paused`, `playbook.run.completed`, `playbook.run.failed`. The payload contains only the event id/type/time and stream type/id/version, never message bodies, lead data or unrestricted domain-event `payload_json`. Campaign control audit events are bridged into the domain stream with metadata omitted; the campaign transition may commit before its audit write.
- The append and the matching outbox entries share a PostgreSQL transaction. A delivery claim is `FOR UPDATE SKIP LOCKED`; a one-minute lease and lease token fence stale worker settlements. Delivery is **at least once**: a lost HTTP response is an unknown outcome and a retry can POST again.

## Consumer headers and signature

- `X-Trevra-Event-Id` is the immutable occurrence id (also `id` in the body).
- `X-Trevra-Delivery-Id` is stable per (subscription, event) across retries **and owner replays**. Consumers must deduplicate on it.
- `X-Trevra-Attempt-Series` is `0` for the original delivery and increments on every owner replay. `X-Trevra-Attempt` counts attempts within the series, starting at 1.
- `X-Trevra-Signature: t=<unix-seconds>,v1=<hex>[,v1=<hex>]`. Each `v1` is HMAC-SHA256 of `"<t>.<raw-UTF8-body>"`. Outside a rotation overlap there is exactly one `v1`, as before. During an overlap the new secret's signature comes first and the previous secret's second. Accept the request when **any** `v1` matches your secret, compare in constant time, and reject timestamps outside your replay window (Trevra's reference verifier uses 300 seconds).

## Secret rotation

1. The owner rotates; the response shows the new secret once.
2. For the chosen overlap (0 to 7 days, default 24 hours) every delivery carries both signatures, so the consumer can deploy the new secret without dropping events. Rotating again inside an overlap drops the older previous secret: at most two are ever live.
3. The old secret stops signing as soon as the overlap ends (checked at signing time), and the worker physically clears it each cycle. `overlapHours: 0` revokes it immediately.
4. Each rotation appends an `outbound_webhook.secret_rotated` domain event with the actor and overlap, never the secret.

## Retries, dead letters and replay

- 2xx is delivered. A non-2xx status, a transport failure or an egress refusal retries after 1, 2, 4, 8 and 16 minutes, up to six attempts, then the delivery is `dead`. 3xx is a failure (`redirect_not_followed`); redirects are never followed.
- Replay re-queues dead deliveries with the **same** event id, delivery id and body, resets the attempt counter and increments the attempt series. Bulk replay takes the oldest dead deliveries. With more than 500 dead deliveries and no `limit`, the request fails with HTTP 400 `replay_cap_exceeded` rather than silently truncating; pass `limit` (max 500) to replay in batches.
- Replay is refused with 404 for an unknown subscription or delivery, and with 409 when the subscription is paused, auto-paused or deactivated (`subscription_inactive`) or the delivery is not dead (`not_dead`). Each replay appends an `outbound_webhook.deliveries_replayed` domain event with the mode, count and delivery ids.
- Events emitted while a subscription is inactive are not queued, so they cannot be replayed later.
- **Auto-pause:** a subscription with at least 30 consecutive failed attempts whose failure streak is older than 24 hours is paused with `disabledReason: "consecutive_failures"`, and its queued deliveries move to `dead`. The owner fixes the endpoint, resumes it, then replays.

## Visibility

- `GET /:id/health` returns delivered, failed attempts, pending and dead counts for the last 24 hours and 7 days, the consecutive-failure count, last failure code and time, last success time, and the most recent attempts (status, HTTP code, latency, reason code, attempt series and number). Response bodies are never read into storage.
- Every attempt is recorded in `outbound_webhook_delivery_attempts` with a reason code. The worker deletes attempt rows older than 30 days in bounded batches.
- Reason codes: egress policy `invalid_url`, `scheme_not_allowed`, `credentials_in_url`, `query_or_fragment_not_allowed`, `port_not_allowed`, `ip_literal_not_allowed`, `host_not_allowed`, `host_not_allowlisted`, `dns_resolution_failed`, `address_not_public` (recorded as `blocked`); transport `connect_timeout`, `timeout`, `tls_failed`, `connection_failed`, `response_too_large`, `redirect_not_followed`, `http_error`; state `subscription_inactive`, `secret_unavailable`.

## Destination safety and activation

1. Explicitly approve **exact** hostnames with `TREVRA_OUTBOUND_WEBHOOK_HOSTS=hooks.example.org,events.partner.com`. There is no wildcard or default host. Without it, creation is refused and the worker claims no work.
2. The same policy runs at create, at update or resume, and again on every delivery attempt:
   - HTTPS only. `TREVRA_OUTBOUND_WEBHOOK_ALLOW_HTTP=true` permits HTTP for local development and tests, and is ignored when `NODE_ENV=production`.
   - No credentials, query string or fragment in the URL.
   - Default port only, unless listed in `TREVRA_OUTBOUND_WEBHOOK_ALLOWED_PORTS=8443,...`.
   - No IP literals in any spelling (decimal, octal, hex, bracketed IPv6), and no `localhost`, `*.local`, `*.internal`, metadata or single-label hostnames.
   - Every DNS answer for the host must be public: loopback, private, link-local, CGNAT, multicast, reserved, documentation, metadata and IPv4-mapped or NAT64 forms of those are refused.
3. **DNS pinning:** each attempt resolves the hostname once, then connects to that exact address (TLS SNI and `Host` still use the hostname). A record that changes between the check and the connection cannot redirect the socket.
4. Limits per attempt: 3-second connect timeout, 10-second total timeout and a 64 KiB response cap (declared or streamed); larger responses fail as `response_too_large`.
5. The worker's minute-cadence loop expires overlapping secrets, dispatches up to 10 deliveries and prunes old attempt rows, with an in-flight guard. With no host allowlist it is inert.

## Readiness still missing

- Live HTTPS destination acceptance (valid signature during and after rotation, retries, outage, replay, unknown outcome, support recovery), operational metrics and paging on dead letters or auto-pause.
- Deployed egress firewall review. Application-level pinning is in place, but a network-layer deny for private and metadata ranges remains defense in depth.
- Custody rekey coverage for outbound subscription secrets, including the previous-secret columns.
- Delivery latency/SLO under load, fair scheduling across busy tenants, subscription limits/pricing, tunable auto-pause thresholds, privacy/legal approval of payload scopes and any future events.
- Migrations `147_outbound_webhook_outbox.sql` and `162_outbound_webhook_hardening.sql` qualified on disposable PostgreSQL only. **No production database migration was applied.**

## Local reproducibility

`npx tsx scripts/test-with-postgres.ts src/server/outbound-webhook-egress.test.ts src/server/outbound-webhooks.test.ts src/server/outbound-webhooks.hardening.test.ts src/server/outbound-webhooks.api.test.ts`

Use `npm run check` for the development gate; `npm run release:certify` must stay red while the broader parity/license/SBOM/provider/ops blockers remain unresolved.
