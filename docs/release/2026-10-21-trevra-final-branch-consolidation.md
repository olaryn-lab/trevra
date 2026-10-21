# Trevra final branch consolidation — 2026-10-21

Base: d682d59fa9e3ca0a8d66f923668d23ce17c9b1b9
Integration: integration/trevra-final-branches-20261021

## Backported from feat/auth-ux-passkeys-local

- Conservative Authward capability type and /api/public-config.passkeyAuthEnabled with no entitlement guessed from the local environment. Fail closed when no provider capability is returned.
- The optional passkey login button appears only if the legacy hosted Authward authority advertises passkey support. Isolated-realm authority still owns all sign-in method selection (passes only resource to its authorization endpoint).
- Continue Better Auth's existing OAuth sign-in with state, PKCE and callback/error URLs. Method hint `auth_method=passkey` with `prompt=login` is only added for that supported legacy flow. No browser WebAuthn credential handling is added locally.
- Explicit negative tests for unsupported mode, unknown upstream providers, and zero-capability local mode. Added Playwright checks for hidden/default state and a mocked capability controlling passkey action; the synthetic OAuth endpoint is intercepted, never an actual IdP.
- Do not merge the old branch wholesale: it predates the isolated-realm migration, current Authward global logout and the current login UI.

## LinkedIn inbox WIP assessment

Branch: wip/linkedin-inbox-checkpoint (6baf238). **Defer a wholesale merge.**

- The branch's line-break parser is already superseded by a stronger current implementation in `driver-inbox.ts`, which uses `innerText` with safe fallback and an existing dedicated multiline regression.
- Current `main` already has more capable server-backed inbox search/pagination and the modern `LinkedInActiveAccount`/timing primitives; restoring the old inbox and builder UI would discard newer work.
- The branch also defaults the conversation rail to campaign-only, hiding organic DMs; its `canSeeAllMessages` toggle is admitted by that branch as a presentation hint, **not a tenant or owner authorization boundary**. A product/permission decision and dedicated UX qualification are required before adopting that behavior. Existing data-reading permissions were not widened here.
- The branch reference is preserved, not labeled as folded, for a separate feature decision. No WIP LinkedIn UI, builder or provider integration is silently merged.

## Remaining historical refs and recommendation

| Branch                               | Patch state                                                                         | Decision                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| authward-interaction-expired         | patch-equivalent to main                                                            | archive; do not merge                         |
| feat/centered-login-parity-20261020  | patch-equivalent                                                                    | archive                                       |
| fix/authward-confidential-live       | patch-equivalent                                                                    | archive                                       |
| feat/authward-realm-focused-20261017 | realm behavior already integrated, branch contains older variants                   | superseded                                    |
| feat/saas-shell-alignment-20261021   | current shell selectively integrated; old pill controls                             | superseded                                    |
| saas-shell-redesign                  | old large shell UI, newer main supersedes                                           | superseded                                    |
| feat/shared-design-system            | 3 unique commits; changes public fonts/tokens/marketing and corners across products | defer coordinated Olaryn design-system review |
| feat/auth-ux-passkeys-local          | 6 unique historical commits                                                         | selectively backported, no wholesale merge    |
| wip/linkedin-inbox-checkpoint        | 1 unfinished WIP commit                                                             | deferred for product/security and UI review   |

All branch refs are retained for audit until explicit branch-pruning approval. The sole still-active separate GTM worktree remains untouched.

## Qualification and safety

Run `npm run launch:acceptance` (44 browser checks plus 16 controlled-provider tests) and `npm run check` on the integration branch. All UI/provider assertions use synthetic credentials and disposable local PostgreSQL. Tests do not establish live Authward passkey enrollment, browser WebAuthn user verification or real mailbox/LinkedIn delivery.

Main worktree has pre-existing dirty reports/catalogs and a private local database file; do not overwrite, delete or stage them. No staging/production deploy, migrations, service restarts or credential access.
