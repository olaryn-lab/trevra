# Authward isolated authority readiness

Status: preparation only; migration is NOT complete. No deployment or data migration is included.

## Selection and rollback

Keep AUTHWARD_ISSUER=https://auth.olaryn.com, AUTHWARD_CLIENT_ID=trevra-web and its existing confidential secret unchanged. The default remains that configured legacy authority. Do not replace legacy environment variables with realm values. Existing environment validation still requires the legacy configuration, including for billing.

Stage these server-only variables separately:

- AUTHWARD_ISOLATED_ENABLED=true (absent/false selects legacy)
- AUTHWARD_ISOLATED_CLIENT_SECRET: confidential isolated-trevra-web secret, at least 32 characters
- AUTHWARD_ISOLATED_RESOURCE_SCOPES: space-separated registered trevra resource scopes, confirmed with Authward; no new grant names are assumed
- AUTHWARD_ISOLATED_HOSTED_LOGIN_READY=true only after verifying the realm's hosted passkey, social and magic-link product UI. Missing confirmation prevents startup.

The isolated issuer is fixed to https://auth.olaryn.com/api/realms/trevra/auth. Discovery is issuer-relative at that path plus /.well-known/openid-configuration. Register the exact Trevra callback <BETTER_AUTH_URL>/api/auth/oauth2/callback/authward and post-logout URI <BETTER_AUTH_URL>/. The genericOAuth provider uses Basic confidential authentication, PKCE, issuer validation and resource=https://api.usetrevra.com on authorization and token requests. Its callback route is unchanged; /loop is the application destination, not the OIDC redirect URI. Callback errors return to /login.

The existing frontend renders “Continue with Authward” through its provider button path. For isolated mode the server strips legacy upstream-provider and magic-link hints: Authward's hosted authorization page owns all authentication methods. Trevra's server-dispatched legacy magic-link shortcut is rejected in isolated mode. No passkey/social/magic-link endpoint parity is assumed. Logout uses the isolated discovery end_session_endpoint, with exact issuer and HTTPS same-origin checks.

Rollback selects the legacy environment with AUTHWARD_ISOLATED_ENABLED=false. Do not switch authority during in-flight login/link attempts: the provider callback path is shared, so those attempts must be restarted after a switch.

## Identity continuity

Legacy account identifiers are preserved. Isolated account identifiers encode [issuer, sub], requiring an actual nonempty sub rather than email or a profile id. Implicit email linking is disabled, including for verified emails. An existing email without a matching account must fail rather than acquire that user's workspace.

Better Auth's existing POST /api/auth/oauth2/link endpoint requires an authenticated Trevra session and records that session's user in OAuth state. Completing the isolated OAuth callback supplies proof of the second identity; an account already attached elsewhere is rejected. Do not import account mappings by matching email. Do not rewrite legacy accountId values.

Residual blocker: there is no dedicated account-linking product UI or proven two-session continuity flow in this change. A legacy session must remain available while initiating the isolated link, and same-email linking currently follows Better Auth's default email equality restriction. Validate session freshness, CSRF/state, replay rejection, different-user rejection, email collisions and changed-email policy before enabling migration. This endpoint alone is not a claim of completed migration.

## Required release evidence

Verify real isolated discovery issuer, JWKS/signature/nonce validation, token client authentication and resource grants; run real browser authorization/code/PKCE callbacks with passkeys, every configured social provider and magic links. Prove existing legacy users retain their exact user/workspace after explicit linking and cannot link by email alone. Verify legacy login/logout after rollback. Test both UI themes and mobile. None of these live flows were exercised here; no authority credentials were provided.

Local validation (2026-10-17): TypeScript typecheck passed after assembling a worktree-local dependency tree, with the missing `stripe@22.6.2` package installed only in disposable validation storage. A targeted suite of 20 tests passed (`authward-config.test.ts` and `auth-service.test.ts`) using a disposable PostgreSQL URL. This does not qualify the entire Trevra test suite, hosted browser flow, real OIDC callbacks or existing-user migration. Keep isolated mode disabled; do not deploy or cut over on this evidence. The package-lock and full integration-harness issues require independent release qualification.
