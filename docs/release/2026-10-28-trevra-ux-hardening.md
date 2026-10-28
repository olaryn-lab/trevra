# Trevra UX hardening — 2026-10-28

Scope: founder-assisted Trevra's primary setup → campaign → approvals experience. This is a UI-only pass; no changed campaign execution, quotas, approval policy, suppression, or provider writes. It is not a full Dripify-parity or production-send certificate.

## Changes

- **Setup → Workspace:** essential connections and sending first. Account/team and safety/advanced settings are labeled native disclosures instead of ten unrelated cards in one grid. LinkedIn account management stays in the existing Connections drawer; nothing is deleted or bypassed.
- **Campaign list:** one creation CTA in the empty state, a separate single CTA in the populated header; start/resume and emergency stop remain visible. Retry of known-safe failures and workflow-version updates move to the existing accessible actions menu. A customized campaign's action is explicitly named **Replace custom steps**, rather than implying it is a harmless refresh. Existing send/approval guardrails remain in place.
- **Campaign preparation:** uses the shared Button, Field and Input primitives for ordinary controls, with exactly one primary preparation action.
- **Approvals:** LinkedIn action and invitation-withdrawal review cards use the same Panel/Button vocabulary, show recipient/account/payload before approval, keep per-action exact-hash controls, and put technical identifiers behind native details. Failures remain visible with alert semantics.
- **Identity:** passkey settings use the same panel and action components, announce success or failure accessibly. Corrected Billing title and removed an unverified licensing statement from sign-in copy.
- **Responsive:** disclosures use the existing design tokens and touch target, a 1px keyboard focus indication and reduced-motion handling. Mobile review buttons expand to available width.

## Evidence and release boundaries

- `npm run build`: TypeScript and production bundle succeeded (with the existing chunk-size warning).
- `npx vitest run src/client/ui/saas-shell.contract.test.ts src/client/LinkedInManagerRead.test.ts src/client/LinkedInManagerWorkflowConfig.test.ts`: 32/32 passing after the approval UI changes.
- `npx tsx scripts/launch-mvp-hermetic-browser.ts`: isolated PostgreSQL, actual React/Chromium navigation, desktop + 390px mobile, first-campaign CTA and Workspace disclosure checks all passed. No live LinkedIn actions were sent.
- Full `npm run check`: 294/294 test files, 4,146/4,146 tests, typecheck, catalog generation and production bundle passed. Expected negative-path provider/schema error logs appeared during tests; suite exit 0.

Live sending R5, live owner email receipt and recovery under a real send are separate release blockers in `2026-10-27-linkedin-production-readiness-tracker.md`; do not relabel them as complete because UX tests pass. Other product areas remain on the incremental UX backlog; this is the highest-traffic workflow, not a claim that every route was visually audited.
