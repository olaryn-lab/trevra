# Trevra-native passkeys — cross-service handover (22 October 2026)

## Scope / security design

New first-party WebAuthn RP: **`app.usetrevra.com`** / Authward managed client `trevra-web`.
No existing `auth.olaryn.com`, Beseam or Billing keys are migrated or accepted.
The Authward native passkey service verifies challenge, origin, RP ID, UV and signature,
checks credential counter and current user/client, and signs a 60-second audience-bound
`product-passkey-grant`. The Trevra backend validates its issuer/JWKS, audience, age,
nonce, RP, origin, UV assurance and original linked subject. An HttpOnly + Secure +
SameSite=Strict nonce cookie, PostgreSQL one-use verification record and Better Auth's
native session adapter/cookie writer establish a product session without any
browser navigation to Authward. Unknown subjects fail closed rather than creating
or linking an account. Central logout still revokes local sessions by Authward subject.

The enabled capability is **OFF by default**. To enable in hosted Trevra production,
set `TREVRA_NATIVE_PASSKEY_ENABLED=true` only AFTER the updated Authward native
endpoint is deployed and confirmed to permit the exact `Origin: https://app.usetrevra.com`.
Do not enable on local/self-hosted or isolated-realm deployments. The login screen
shows the native option only while the feature flag is enabled. Other sign-in methods
(Google, Microsoft and email) remain independent. The main browser's CSP allows
only the exact `https://auth.olaryn.com` WebAuthn JSON endpoints when enabled.

New credential enrollment is in **Setup → Workspace → Passkeys** after a recent
Google/email Authward login; its server proxy looks up the authenticated user's
stored, recent OIDC ID token without exposing it to JavaScript. Authward requires
an `auth_time` no older than five minutes, a verified identity and a single-use
registration challenge bound to the ID token. This follows Beseam/Billing's
existing product-RP implementation; no hidden OAuth WebAuthn fallback remains.

## Verified locally

- Authward TypeScript build; product-RP test 6/6; full Authward suite 944/944
  passing (31 skipped, test environment dependent).
- Trevra 46/46 Playwright app/browser checks and 16/16 controlled-provider tests.
- Standalone native grant tests, browser JSON-only request-flow tests, token custody checks and strict same-domain constraints.
- Full Trevra `npm run check`: 285/285 test files, 4,073/4,073 tests PASS, plus TypeScript/Vite/server build exit 0. `npm sbom` still reports ESBOMPROBLEMS from the local dependency tree; strict release certification remains separate and fail-closed.
- **Real disposable PostgreSQL + Better Auth**: verified first-party start nonce;
  unknown subject rejected and challenge consumed; existing linked user gets a
  genuine signed Better Auth secure session cookie; second redemption denied;
  session lookup returns the expected user. No production accounts were touched.

## Rollout order and blockers

1. Review the Authward `product-rp-passkeys.ts` addition and deploy Authward to
   staging/test environment. Verify exact Trevra CORS preflight gives HTTP 204;
   wrong origins and Beseam/Billing cross-use give 403.
2. Deploy the Trevra code with `TREVRA_NATIVE_PASSKEY_ENABLED` absent/false.
   Verify Google/Microsoft/email are unchanged and native passkey not advertised.
3. Run controlled HTTPS/browser tests with a dedicated Trevra test identity.
   Use Google/email to sign in, immediately enroll a new passkey on Trevra,
   then sign out and sign back in on the same host. Verify Android and desktop.
4. Enable Trevra flag on the hosted app, roll the app through the standard
   guarded deployment workflow; verify login URL remains Trevra during biometric
   prompt and there is no Olaryn-hosted passkey page.
5. Verify recovery on no passkey, revoked account, passkey cancellation, expiry,
   repeat and cross-device replay. Keep normal fallback sign-in enabled.

**Not yet proven:** actual device/biometric flow against deployed Authward,
self-service native credential listing/removal and recovery/revocation policy,
or staging/prod operation. Revocation/retention should receive an explicit
product policy before broad customer rollout. Do not claim production readiness
from mocked challenge tests. No server restarts, production keys or customer
traffic were touched during the local changes.
