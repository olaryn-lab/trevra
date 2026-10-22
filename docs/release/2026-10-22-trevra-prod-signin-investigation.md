# Trevra production sign-in investigation — 2026-10-22

Scope: production v0.1.63 / main `9602cd5`; screenshots show two green primary login buttons, a Trevra passkey click showing `auth.olaryn.com`, and a generic login failure. This patch remains local and is not production-deployed.

## Confirmed

- The client marks BOTH the passkey and the first social provider as `ol-auth-primary`. Fixed: social primary is conditional on absence of passkey, with a browser assertion.
- `signInWithPasskey()` intentionally invokes `startAuthwardSignIn(undefined, 'passkey')`, a Better Auth OAuth2 redirect. Authward's current WebAuthn RP ID is `auth.olaryn.com`, and its native product-domain passkey service is allowlisted only for the demo client. **The existing Trevra button is not local/native WebAuthn.** Keeping it in this patch preserves functioning login while the no-redirect requirement remains open.
- Public checks: `https://app.usetrevra.com/api/health` 200, Authward `/capabilities?client_id=trevra-web` advertises passkey+magicLink, and `https://auth.olaryn.com/.well-known/webauthn` currently 404. Configuration is not proof of actual email delivery or successful live callback.
- The `oauth_code_verification_failed` callback may be caused by an email link opened in a different browser without Trevra's original PKCE state cookie. Trevra now makes **at most one** normal, fresh OAuth sign-in attempt in that tab and otherwise shows an actionable message. It never bypasses state, PKCE or authorization. This is a candidate recovery, **not** a verified diagnosis of the screenshot or proof that all magic-link failures are fixed.

## Native passkey work required — separate security-reviewed implementation

1. Choose and document whether existing `auth.olaryn.com` RP credentials must be reused. To reuse them on `app.usetrevra.com`, use WebAuthn Related Origin Requests (a correct `/.well-known/webauthn` on the RP origin with a tight origin allowlist) and verify support across target browsers.
2. Implement Trevra-origin `navigator.credentials.get()` with Authward challenge generation and **server-side verification against exact RP ID, allowed origin, challenge, signature, user verification, credential counter and subject/admission policy**. Never expose a reusable Authward control-plane token or accept claimed email/sub from the client.
3. Bridge the verified result through a one-time, audience-bound, replay-safe authorization flow into a Trevra session, preserving existing account linking, Authward backchannel logout and tenant roles. Test expired challenges, cross-origin abuse, replay, device cancellation, revocation, and mobile login.
4. Only then replace the redirecting passkey CTA; do not claim that cosmetic branding or an automatic redirect is native passkey login.

## Manual live evidence still required

- With an operator-approved test mailbox, establish whether the initial Trevra email POST succeeds, whether Authward SMTP delivers, whether the email opens in the same browser or a different one, the callback code (redacted), and whether the newly initiated OIDC session finishes successfully.
- Test Google/Microsoft and passkey with authorized test identities. Do not collect or publish private tokens, cookies or credentials.
- Verify release dependency inventory independently: the local shared node_modules install emitted `ESBOMPROBLEMS` (nodemailer version conflict) while the TypeScript and Vite build completed. A development build is not strict release certification.

## Local qualification

- 46/46 synthetic Playwright browser acceptance assertions PASS.
- 16/16 controlled-provider PostgreSQL-backed tests PASS.
- 13/13 focused auth/unit/contract tests PASS.
- `npm run typecheck` PASS; `npm run build` exits 0, SBOM warning remains.
- No real provider messages, push, merge, deployment, production migration or live auth mutation performed.
