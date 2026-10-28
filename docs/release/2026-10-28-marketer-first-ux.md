# Trevra — marketer-first UX pass (October 28, 2026)

## Product principle

A marketer should understand the first screen without knowing "GTM", "agent", "ledger", "workflow", "source", "API", "run", or "skill". The default view answers: **What needs my attention? What do I do next? What happened?** Capabilities remain accessible, but implementation choices should not be required to start.

This pass changes the UI, not the campaign execution semantics or safety boundaries.

## Navigation

- Desktop everyday destinations: **Today**, **Campaigns**, **Messages**, **Ideas**.
- Infrequent destinations: **Activity**, **Settings**; on mobile both are available from a 44px **More** disclosure. Deep links for every route remain valid.
- **Settings** opens **Connections** by default; Lead capture, Billing, and Advanced are available in the setup tabs.
- Campaigns no longer repeats the entire app navigation. Its secondary options are **Campaigns**, **Deals**, and **More** (New leads, Social posts). Creating or reviewing a campaign hides the unrelated tab strip.
- Help and jump palette use the new vocabulary without deleting any underlying capabilities.

## First-use experience

- When there is no saved people list or campaign, Today offers one primary action: **Connect LinkedIn** or, for a configured seat, **Create a campaign**.
- The user is told the real sequence: connect LinkedIn, choose/upload people, review the draft and start. The app never claims that a configured seat is a verified logged-in session or that draft preparation sends actions.
- Claude/Codex and agent policy configuration is behind **Agent setup (advanced)** rather than required as the first visual step. This is presentation only; the real execution/policy checks still apply.
- Active Today hides empty duplicate Working/Recent Results cards and collapses detailed pacing metrics, funnel and custom agent planning behind explicit disclosures.
- Sign-in copy now describes the marketer's job instead of technical infrastructure.

## Campaigns, drafts and ideas

- Campaign list replaces a description of per-seat ledgers/workflows with plain status language. "Leads in a sequence" becomes "people in progress".
- First campaign states **Connect LinkedIn first** and links to the correct screen. Preparing a campaign is labeled **Create a campaign**, with explicit no-send and approval copy.
- The Ideas screen foregrounds **Ready-to-review ideas**. Market trends and post-performance detail are collapsed by default, never deleted. Discussion-platform filters now appear only in the discussion panel they actually affect, behind **Filter discussion sources**. Source evidence and the exact publication approval path remain unchanged.

## Regression and launch contract

- No changes to API routes, database migrations, quotas, credential storage, outbound worker, suppression, approvals, or uncertain-send handling.
- Phone and desktop links are real routes. More must provide access to Activity and Settings on mobile and must not obscure the main navigation when closed.
- Required browser acceptance: fresh signup → Today next action → Campaigns → create draft → Connections → paired-account UI; mobile More → Activity and Settings; Ideas with secondary panels closed; approval and Never Contact safety.
- Required code gates: TypeScript, UI contract tests, isolated PostgreSQL/Chromium E2E, full PostgreSQL suite, production build.
- **Not a live-send certification.** Existing paused campaigns, held messages and unknown outcomes must not be automatically resumed.
- Remaining future polish: user research with actual nontechnical operators, a complete route-by-route visual audit of every advanced settings screen, performance optimization for data-heavy Ideas and Activity views. Do not confuse these with blockers in the tested primary marketer journey.

## Results

- Targeted UX and routing tests passed (44 checks).
- Real Chromium/isolated PostgreSQL flow passed, including desktop, 390px mobile, More navigation, and the first campaign flow.
- Full `npm run check`: 294/294 test files, 4,148/4,148 tests; TypeScript, catalog generation and production bundle succeeded (existing large-chunk warning).
