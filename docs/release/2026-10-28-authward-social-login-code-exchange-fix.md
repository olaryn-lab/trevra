# Trevra production Google/Microsoft sign-in — October 28, 2026

## Incident and evidence

The Trevra sign-in screen showed a generic error after both Google and Microsoft authentication. Two production attempts at about 04:04 UTC reached the application's OAuth callback, then Better Auth reported `invalid_code` after Authward answered `invalid_grant` at `/api/auth/oauth2/token` (HTTP 400).

Verified read-only before the fix:

- `https://auth.olaryn.com/healthz` and discovery respond successfully; `trevra-web` advertises Google and Microsoft.
- The Authward `trevra-web` client is active, uses `client_secret_basic` and PKCE, and has `https://app.usetrevra.com/api/auth/oauth2/callback/authward` registered.
- The registered Authward client secret matches both Authward's runtime configuration and Trevra's deployed confidential-client secret. Rotating credentials is not indicated.
- The new Better Auth 1.7 generic OAuth handler calls the custom `getToken` callback with its **internal** `/api/auth/callback/authward` URI. Authorization generated using the configured **legacy** `/api/auth/oauth2/callback/authward` URI. The old Trevra code passed the internal callback as the token grant's `redirect_uri`. OAuth requires an exact match, and Authward's authorization-code validator rejects a mismatch with `invalid_grant` after consuming the code.

This establishes a concrete protocol mismatch for both providers. It does not prove every historical sign-in failure had the same cause.

## Repair

Both the authorization redirect and the token exchange use one server-derived `registeredAuthwardCallbackURI`. The external callback still forwards the code/state to Better Auth's internal handler, preserving the registered OAuth client and secure PKCE transaction. The internal handler URL is **never** substituted as the token grant's `redirect_uri`. No client secret, auth policy or issuer changes.

Focused tests assert that even when Better Auth passes its new internal callback URI, the token request sends the registered legacy callback URI, unchanged PKCE verifier, correct resource and Basic client authentication. Error surfaces continue to redact provider descriptions and secrets.

## Qualification boundary

Run the full repository `npm run check`, GitHub App quality and guarded deployment; verify exact production image SHA and public health. A true end-to-end sign-in completion still requires a fresh operator-owned Google and Microsoft authentication in a real browser: a passing mock token exchange or public discovery check is not evidence of login success. Never replay an already consumed authorization code.
