# Better Auth 1.7 Security Upgrade — Release Qualification

**Scope:** Trevra identity only. Separate from the LinkedIn stall-alert owner fallback in PR #25.

## Reason and blocker

On 2026-10-27 GitHub CI began failing the dependency-audit gate on the pinned Better Auth 1.6.25 tree (high-severity GHSA-q84f-53jg-9ppm). The affected device-grant authorization UX was not demonstrated to be used by Trevra, but keeping a known high security advisory in the production dependency graph was not acceptable for launch qualification. **Never bypass npm audit to merge.**

## Migration

- Pin `better-auth` to stable 1.7.14, refresh its lockfile, and keep all Better Auth dependencies resolved together. `npm audit` and production `npm audit --omit=dev` report zero vulnerabilities in the local qualification.
- Generic OAuth is now a standard social provider: use `signIn.social` / `signInSocial` and remove `genericOAuthClient()`. Carry validated legacy Authward method hints via `additionalParams`, with state, PKCE, nonce, and redirect URI owned by Better Auth.
- The registered Authward callback URL remains `/api/auth/oauth2/callback/authward`. A same-origin **HTTP 307** compatibility route forwards code/state/issuer to 1.7's `/api/auth/callback/authward`; it cannot select an arbitrary redirect origin. Error callbacks still return directly to Trevra `/login`.
- Use OIDC discovery and verified ID tokens. The provider's verified `sub` remains the linked account ID. An isolated-realm local-user mapping must not mutate provider identity.
- Retain existing Authward client ID, confidential HTTP Basic token exchange, resource audience, callback registration and session cookies. No new user confirmation screen.

## Verification and unverified items

- TypeScript, 46 focused authentication/LinkedIn monitoring regressions, the hermetic browser's full login journey, 16 launch-acceptance checks, and the production build passed locally.
- New **signed OIDC provider-double test** covers real Better Auth social sign-in, callback state/PKCE and nonce, token exchange, verified RS256 ID token, session issuance, Better Auth user creation, and the exact persisted `account.accountId` link.
- Migration of local Better Auth tables and organization ownership is tested in ephemeral PostgreSQL; no real Authward credentials or user accounts were exercised.
- **Release gate:** full GitHub CI and immutable Oracle rollout must pass before this is marked deployed. Production sign-in smoke with an authorized session remains a separate live qualification; do not assert it from provider doubles.
- During release, confirm production app/worker health and the LinkedIn safety ledger remains untouched. Roll back rather than disable issuer, nonce, PKCE, auth callback, or dependency security checks to make a failed login pass.
