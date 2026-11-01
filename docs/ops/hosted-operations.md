# Hosted operations requirements (TRV-056)

Owner decision, 2026-11-01: **hosted only.** The Oracle-hosted service is the
supported way to run Trevra. The self-host material (`docs/self-hosted-production.md`,
`compose.selfhost.yml`, `scripts/selfhost-*.sh`) stays in the repository as an
**unsupported preview**. It carries no support and no upgrade guarantee, and it
grants no deployment rights; see `LICENSE`. Public copy says the same thing.

## Supported topology

The source of truth is `infra/oracle/README.md`:

- one Oracle E2.1.Micro running the API, the worker and PostgreSQL;
- a 50 GB block volume for PostgreSQL data and backups;
- Cloudflare Tunnel ingress, so no HTTP port is open;
- the marketing site on Cloudflare Pages;
- LinkedIn execution through a paired Companion, because Chrome never runs in
  the server containers;
- server runtime secrets from OpenBao (`infra/oracle/OPENBAO.md`), and
  workspace secrets as described in `docs/ops/credential-custody.md`.

## Release requirements

- `main` is protected. A release is an exact commit that passed CI (dependency
  audit, the full PostgreSQL suite, the production build) and was published as
  an immutable `sha-` image tag.
- Deploy only with `infra/oracle/deploy-single-micro.sh <ip> <sha-tag>`. It
  checks prerequisites, takes and validates a backup, runs the migration job,
  refuses unsafe tenant-isolation states, and only then restarts the API and
  worker and waits for health.
- Migrations are forward-only. Read each new migration's header for manual
  steps. Migration 166, for example, builds its index inline only while
  `linkedin_actions` is under 64 MB; above that it logs the
  `CREATE INDEX CONCURRENTLY` statement to run by hand.
- To roll back, deploy the previous `sha-` tag. A schema change is never rolled
  back; the next release fixes forward.

## Operating requirements

- **Backups.** Every deploy takes a validated `pg_dump -Fc` backup, kept 14
  days. Access is owner-only.
- **Credentials.** Follow `docs/ops/credential-custody.md`, including the
  90-day server-key rotation.
- **Billing.** `TREVRA_BILLING_ENFORCEMENT` stays `observe` until the first
  paying customer (`docs/ops/billing-enforcement.md`).
- **Health.** `/api/health` on the API and the worker's health check must be
  green after every deploy. Verify public sign-in too.
- **Production data.** Never disturb held, unknown-outcome or paused LinkedIn
  work to make a release pass (see
  `docs/release/2026-10-27-linkedin-production-readiness-tracker.md`).

## Known gaps

These are accepted for the founder-first launch. They must be closed before
promising an uptime or recovery target:

- One machine with no high availability. Oracle may reclaim idle Always Free
  instances.
- Backups exist only per deploy. There is no scheduled daily backup, no
  off-host copy and no restore drill.
- No alerting is wired to the health endpoints.
