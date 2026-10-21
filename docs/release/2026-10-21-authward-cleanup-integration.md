# Trevra Authward cleanup integration — 21 October 2026

Base: fe7b07fadf8c048f1d62f7c01b8983a34b5f5277
Integration branch: integration/authward-cleanup-20261021
Contributing branches: fix/authward-global-sso-logout; integration/authward-realm-release-20261017

## Integrated / reconciled

- Back-channel Authward logout, verified Ed25519 JWT with issuer, audience, event, subject, session id, jti, iat, and no nonce; missing/invalid tokens return 400.
- Public endpoint throttled before signature/JWKS work; no browser-cookie authentication shortcut.
- Replay window bounded: reject old/future-dated logout tokens; delete sessions only if created at/before event issue time, and do not clear freshly updated Authward tokens.
- JWKS URI read from issuer-relative OpenID Connect discovery, checked for exact issuer, HTTPS and same origin. No guessed realm-relative JWKS route; redirects disabled.
- Preserved explicit account-link guard (implicit linking disabled) and already integrated Authward isolated authority/account migration code.
- The sole merge conflict duplicated onAPIError. Preserved the existing mainline redirect and did not add a second field.
- oauth4webapi declared as direct runtime dependency because its import already exists in the integrated account-link flow.
- No migration renamed, edited or reapplied. Both existing 138_authward_explicit_link.sql and 138_linkedin_inbox_search.sql remain unchanged, with full filenames tracked independently.

## Local evidence

- Fresh npm ci --ignore-scripts: PASS (597 installed packages)
- Focused Authward tests: 65/65, six files, real disposable PostgreSQL plus local synthetic Ed25519 signing keys
- npm run launch:acceptance: PASS, 39/39 real Chromium/browser checks and 16/16 controlled-provider integration cases
- npm run check: PASS, 4,057/4,057 tests across 280 files; production TypeScript/Vite build PASS (Vite 8.3.4)
- CycloneDX inventory freshly generated; this is not independent release certification
- Existing large client-bundle advisory remains

Evidence logs (local only):

- /tmp/trevra-auth-final-focused.log
- /tmp/trevra-auth-clean-launch.log
- /tmp/trevra-auth-final-fullcheck.log

## Remaining release / identity verification

**Not a claim of real Authward logout readiness.** Validate hosted issuer discovery, JWKS rotation, signed backchannel JWT delivery, passkey/social/magic-link callbacks, production cookies, global logout propagation, rollback and account migration with authorized test identities in staging before activation. No network calls to the live IdP, deployment, secrets inspection, production migration or live provider action were performed.

No shared-design-system or SaaS-shell branch merged; visual changes must be separately evaluated against the newer square/rounded control contract.
