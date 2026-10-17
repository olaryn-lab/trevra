# Explicit Authward account migration

This change is off by default. Legacy Authward remains the default authority;
`AUTHWARD_ACCOUNT_MIGRATION_ENABLED=true` independently enables the authenticated
Setup → Workspace “Connect isolated account” control. It does not switch login.
No deployment, service restart, production database, or live issuer operation was
performed during implementation.

## Configuration and registration

Keep `AUTHWARD_ISOLATED_ENABLED=false` during the migration enrollment phase.
Keep the existing `AUTHWARD_ISSUER`, `AUTHWARD_CLIENT_ID`, and
`AUTHWARD_CLIENT_SECRET`. Configure the separate isolated secret, registered
resource scopes, hosted-login readiness gate, and hosted deployment mode required
by `authward-config.ts`; the migration flag fails startup if these are incomplete.
The isolated issuer/client are pinned by that module, not supplied by the browser.
The legacy secret must differ from the isolated secret. Secrets belong in the
existing deployment secret system; do not place them in this document or SQL.

Register exactly `<BETTER_AUTH_URL origin>/api/auth/isolated-link/finish` as an
additional isolated-client redirect URI. It must be the same public origin as the
UI. The existing generic sign-in callback is a separate redirect registration.
The dedicated flow requests `openid` only (no refresh token or product access scope) **with the exact `https://api.usetrevra.com` resource parameter required by the isolated authorization server**. The client is confidential and uses S256 PKCE.
Keep migrations forward-only; migration 138 creates two application tables and
never updates commercial data. Better Auth creates its existing auth schema as
before. Enabling isolated default login is a separate, manually controlled rollout.
Isolated generic signup is disabled: only previously linked identities can use
that login. Supporting new isolated users needs a separately reviewed enrollment
path; there is no automatic adoption of legacy accounts.

## Security boundary

POST `/api/auth/isolated-link/begin` requires the exact public Origin and a live
Better Auth session with a legacy Authward account. GET
`/api/auth/isolated-link/status` supplies authenticated UI state. GET
`/api/auth/isolated-link/finish` accepts only a random, five-minute, single-use
attempt bound to the same user and exact session ID. Starting again invalidates
that session's previous attempt. Changing sessions, logout, expiry, wrong state,
and missing authentication fail closed. The callback consumes state before
network I/O, so failures require a fresh start.

The protocol implementation uses oauth4webapi (already present transitively,
now declared directly). It uses code + S256 PKCE, a fresh nonce, prompt=login,
max_age=0, confidential HTTP Basic client authentication, exact metadata issuer,
HTTPS endpoints restricted to that issuer's origin, and EdDSA ID-token signature
verification through issuer JWKS. Issuer, audience/authorized party, timestamps,
nonce, subject, and fresh auth_time are checked before database writes. See the
[upstream protocol API reference](https://github.com/panva/oauth4webapi/blob/main/docs/README.md).
An issuer that omits auth_time or cannot satisfy fresh login is rejected.

The final transaction locks/revalidates the old session and existing user,
inserts a unique issuer/subject → existing Better Auth user ledger entry, and
inserts the matching issuer-qualified `authward` account mapping. User uniqueness
prevents a second isolated identity for the same user; issuer/subject uniqueness
prevents two users claiming one identity. Preexisting conflicting auth mappings
are refused. No user merge, email comparison, email rewrite, workspace switch,
membership change, credit transfer, or session replacement happens. Provider
tokens are discarded. Pending verifier/nonce values expire after five minutes;
expired attempts are removed on subsequent starts.

Implicit linking and Better Auth's generic linking/unlinking HTTP endpoints are
disabled; they cannot serve as an alternate route around the proof boundary.
The installed generic callback was inspected: its linking branch uses the user
recorded in OAuth state without rechecking the initiating live session. That is
why this implementation does not wrap `/oauth2/link`.

## Validation and remaining acceptance blockers

Completed locally: TypeScript; Vite client build; server TypeScript compile;
31 config/JWT/PostgreSQL linking tests including real Ed25519 verification and negative claims/signature
cases. Mechanical UI detector reported no findings. No feature CSS was added;
the control inherits shared primitives and existing panel composition.

Required before acceptance:

- Run `npm run check` and the new `src/server/authward-link.test.ts` PostgreSQL
  suite in an environment with Docker and local sockets. This sandbox denies
  both Docker access and the tsx IPC socket. The new DB/HTTP fixture covers actual
  Better Auth cookies, unchanged workspace/user/membership rows, successful
  linking with a different email, session swaps, revocation, expiry, CSRF,
  token rejection, conflicting subject ownership, rollback, and concurrent replay.
  The targeted PostgreSQL/HTTP suite completed successfully on disposable local PostgreSQL; production browser flows remain unverified.
- Execute live staging acceptance with two distinct issuer identities, checking
  fresh hosted passkey/social/magic-link challenges, S256 support, EdDSA JWKS,
  nonce/auth_time behavior, exact redirect registration, identity-only scope,
  and callback cookies on the real browser origin. Verify subsequent isolated
  sign-in returns the exact existing Trevra user, tenants and credit balances,
  with all old sessions still valid. Do not infer these facts from matching email.
- Check success, cancel, expired/logout, conflict, retry, and disabled UI in light
  and dark themes at desktop and narrow widths. Browser execution is forbidden
  by this repository's test setup and unavailable in this sandbox; visual
  acceptance remains open.
- Run online `npm audit --omit=dev` outside this network-restricted environment;
  its advisory endpoint failed DNS here. Offline audit reported zero but is not
  a current security assessment. Terraform validation in `infra/gcp` passed.
  Compose validation passed with a local dummy encryption-key value; no live
  secrets were used. Base `npm ci` also encounters a preexisting missing
  `@emnapi/runtime` lock entry; installed dependencies were copied read-only
  from an existing checkout into this worktree to permit static validation.

No claim of production or live issuer acceptance is made.
