# Trevra OpenBao production source — live 2026-10-29

**Status:** API and worker consuming 14 operator-managed runtime keys sourced
from OpenBao KV v2; live OCI host, same immutable Trevra image, live health
verified. Do not confuse platform secrets with workspace-owned BYOK/Nango
refresh tokens: those remain scoped to their respective existing stores.

## Security boundary and actual hosting

- Runtime: existing Oracle Cloud E2.1.Micro at `/opt/trevra`,
  `ghcr.io/olaryn-lab/trevra:sha-350e54b5f36eb7d1e19dd8435dd9474f2a2e154e`,
  separate healthy API, worker, PostgreSQL and Cloudflare Tunnel.
- Vault: existing shared Google Cloud OpenBao backed by Cloud SQL with
  KMS auto-unseal; **no new VM, database, DNS name or custom secrets UI**.
- Namespace `kv/data/production/trevra/runtime/<ENV_NAME>`, envelope
  `{encoding:"base64",source_kind:"trevra-oracle-host",env_key,value_b64}`.
  Existing values are copied, never regenerated or logged.
- Identity: `production-trevra-reader` AppRole, exact KV data read plus
  lookup/revoke-self only, 5-minute tokens (20-minute maximum), no
  `default` policy or policy/auth/production-other-app writes.
  One role ID and 90-day bounded secret ID in protected
  `/opt/trevra/.openbao-approle.json`, mode 0600. This file is **not**
  passed into containers, builds or browser environments.
- Network: OCI host `152.67.95.138/32` is an exact allowed peer in
  existing Nginx origin `geo $realip_remote_addr`, in addition to
  Cloudflare's edge ranges. The host-only Python client connects directly
  to the existing GCE origin IP `34.76.184.174` for Vault API requests,
  **verifying the normal `secrets.olaryn.com` TLS hostname**, without DNS
  mutation, `/etc/hosts` change or public port 8200. Cloudflare continues
  to front browser UI; no alternate public service hostname exists.
- `infra/oracle/openbao-env.py` performs exact policy login,
  value provenance/encoding/size validation, collects all values before
  any write, revokes its short-lived token, then atomically updates the
  OCI's original chmod-0600 `/opt/trevra/.env.oracle`. Its first cutover
  saved `/opt/trevra/.env.oracle.pre-openbao` (0600) for rollback.
  Existing Docker Compose reads the familiar env file; no new database
  integration, secret store or code path inside user-scoped providers.

## Enabled credentials

Fourteen environment keys were copied and verified as of the live canary:
`AUTHWARD_CLIENT_SECRET`, `BETTER_AUTH_SECRET`,
`TREVRA_AGENT_TOKEN_PEPPER`, `TREVRA_SECRETS_KEY`,
`MARKETING_HASH_SALT`, `TRACTION_ADMIN_TOKEN`, `INDEXNOW_KEY`,
`NANGO_API_KEY`, `NANGO_WEBHOOK_SIGNING_KEY`,
`SMTP_USERNAME`, `SMTP_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`,
`TREVRA_DB_PASSWORD`, `INGEST_API_KEY`.

These are byte-for-byte **the original credentials**, not a rotation;
the signing, database encryption, OAuth, SMTP and API integrations
therefore retain continuity. Optional absent variables have not been
created artificially. Customer BYOK, LinkedIn seats, Nango provider refresh
tokens and workspace-scoped credentials were deliberately not centralized.

## Qualification evidence

- Existing production OCI source read securely over SSH in operator memory,
  14/14 recorded in KV v2 with CAS-first write and exact readback.
- Exact AppRole-only canary from OCI succeeded through trusted HTTPS,
  read all 14 without outputting values. Cross-app, cross-env, KV mutation
  and `sys/auth` returned HTTP 403. Short-lived token revocation was
  enabled explicitly for the Trevra reader (no broad policy grant).
- `openbao-env.py --check`: 14 runtime key values match.
  `openbao-env.py --apply`: 14 values refreshed, 0600 backup preserved.
- API and worker were force-recreated using the **same immutable image tag**.
  Local host inspected both live container environments and verified all
  14 imported entries equal the OpenBao-refreshed host env **without logging
  any value**. Trevra API and worker, plus PostgreSQL, were healthy.
  External `https://app.usetrevra.com/api/health` returned HTTP 200.
- Synthetic Python unit suite tests full envelope/provenance validation,
  duplicate and permission rejection, fail-closed network behavior, atomic
  env replacement, immutability of protected rollback, and file mode 0600.

## Ongoing deployments and rollback

A protected `/opt/trevra/.openbao-enabled` file (mode 0600) activates
the hook in `deploy-single-micro.sh`, `deploy-micro.sh`, and `deploy.sh`.
Each releaser transfers the current reviewed Python client, fetches and
validates the full scoped secret set, and only then proceeds to service
migration/recreation. Vault unreachable, invalid/expired AppRole, missing
value, source-encoding drift or a changed policy makes the deploy **fail
closed**; currently running API/worker are left healthy and untouched.

Emergency rollback to former protected host env, after operator review:

1. Stop new deployments, remove only the `.openbao-enabled` activation
   marker, and atomically restore the `.env.oracle.pre-openbao` backup to
   `.env.oracle` mode 0600.
2. Recreate API and worker with the same currently running immutable tag;
   preserve database volumes. Verify both health endpoints and public login.
3. Keep the Vault copies for investigation; do **not** delete version history,
   alter tokens, reset provider keys, or destroy Nango/tenant custody.
4. Re-enable the marker only after real OCI HTTPS requalification succeeds.

The AppRole **SecretID expires after 90 days** (from enrollment on
2026-10-29). Before expiration, a GPG-authorized operator should replace
it on the Oracle host using the protected OpenBao administrator workflow,
verify fresh token+KV read, and revoke the old SecretID. Do not put
long-lived root or owner TOTP credentials on the OCI host. The read-only
role is never empowered to generate its own SecretIDs.

## Status

- [x] 14/14 actual production Trevra server secrets copied and exact readback
- [x] Machine AppRole scoped to Trevra production KV reads
- [x] OCI HTTPS canary and negative authorization probes
- [x] Atomic host injection, protected source backup and rollback route
- [x] Real API/worker restart with original immutable image
- [x] Live environment match and API/worker/Postgres health
- [x] Reusable fail-closed hook in all Oracle deployment modes
- [ ] Scheduled AppRole SecretID renewal before 2027-01-27
- [ ] Any additional optional credentials provisioned after today's inventory

**This is the production secret-source cutover for Trevra, not a
migration of tenant-owned BYOK or external Nango OAuth refresh tokens.**
