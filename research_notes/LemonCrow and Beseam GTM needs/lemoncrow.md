# LemonCrow GTM profile (as of 2026-10-06)

Entity: lemoncrow.com = LemonCrow, GitHub org lemoncrow-lab. Confidence high (site, repo and plugin skills all match; the repo links lemoncrow.com). Not the same as unrelated "Lemon"/"Lemonx" products on Product Hunt.

## Product (verified, primary)

- Tagline: "Get more from every agent." Improves context/execution/evidence/human judgment around AI agents; model-agnostic. https://lemoncrow.com
- Two products: Runtime (cut context waste, turns, cache misses, spend; local session stats/replay) https://lemoncrow.com/runtime ; Review (review agent-written diffs with impact, provenance, verification evidence; review state survives revisions; hosted demo api.lemoncrow.com/r/demo) https://lemoncrow.com/review
- Repo README is review-first: "~30% lower cost, ~25% faster"; SWE-bench Verified 29.5% cheaper, 23.7% faster, 92.8% vs 80.8% resolved; published includes a Lite regression (-2pp). Tools: code_search, read, edit, bash, web_fetch. https://github.com/lemoncrow-lab/lemoncrow
- Hosts: Claude Code, Codex CLI, Cursor, opencode, LemonCode (own opencode fork), Pi, Copilot, Copilot CLI, Hermes Agent, Antigravity; also LangChain/OpenAI SDK/Gemini ADK/MCP (pricing FAQ). Pricing FAQ says Cursor install is not recommended.
- Founder voice in README: solo-sounding ("I built LemonCrow"), ex-Google perf/cost background. Do not infer more.

## Packaging and pricing

- Local runtime: $0, Apache-2.0, no account, seats or cap. No paid plans; former Pro subscriptions retired, checkout closed (account page for existing subs). https://lemoncrow.com/pricing
- Hosted: "in development", "Not built yet", scoping with early teams; contact legal@lemoncrow.com (pricing) / contact@lemoncrow.com (enterprise). Planned: shared team workspaces, shared memory, SSO, org dashboards, retention/audit export, managed.
- Enterprise page: customer-VPC/on-prem, dedicated managed, existing Coder/K8s/SSH/VM estates; SSO/RBAC, budgets, chargeback. Fleet controls "not all generally available yet". https://lemoncrow.com/enterprise
- Revenue today: effectively none from product (inference from "no paid plans"). Prior Stripe Pro subscribers exist (privacy policy, updated 2026-07-11).

## Distribution

- curl install script (lemoncrow.com/install.sh), GitHub Releases (hosted.sh), host plugins/skills (a lemoncrow plugin exists in Claude Code per this session's skill list). Hosted auth via Authward device flow.
- PyPI/npm/marketplace listings: NOT verified (fetches failed). Gap.

## Traction (verified numbers only)

- GitHub lemoncrow-lab/lemoncrow: 72 stars, 5 forks, 0 issues, 0 PRs, 993 commits, updated 2026-09-24. Org has no public members. Other repos: benchmarks, acss, lemoncode (fork), local-llm-\* (3 stars each). https://github.com/lemoncrow-lab
- Homepage shows a live "time saved" metric from anonymous telemetry; /savings page is JS-loaded, numbers not retrievable.
- Web search found no Hacker News, Product Hunt, Reddit, X or press coverage of LemonCrow (search tool is weak; absence UNVERIFIED but likely low external footprint).
- Telemetry is on by default (hashed installs): a real PQL/usage source, with privacy constraints.

## ICP (INFERRED from product copy)

- Now: individual power users of Claude Code/Codex/opencode who care about token cost and reviewing agent diffs; Linux/macOS (Windows partial per README).
- Next: eng leaders/platform/security at orgs with many agent users wanting spend governance, audit, VPC deployment. Roles: staff/principal eng, eng managers, platform eng, DevEx, CISO/procurement for enterprise.

## Stage and motion (INFERRED)

Early, pre-revenue, OSS-led PLG with a hosted/enterprise product unbuilt; enterprise via design-partner pilots by email. Pivoted from paid Pro to fully free (date unknown) and from cost-savings to review-first positioning.

## GTM jobs LemonCrow needs (each tied to evidence)

1. Install and activation funnel instrumentation: curl installs, `lc init`, first `lc review`; telemetry exists but opt-out and privacy-bound. Define activation = first review or session stats.
2. GitHub signal capture: stars/forks/watchers, issues, release downloads, who stars (enrich to company/role). 72 stars is the main visible signal.
3. Design-partner pipeline for Hosted/Enterprise: the only monetization path; contact@ mailbox is the entire funnel. Need lead intake, qualification, pilot tracking, evidence/proof pack.
4. Outbound to eng leaders/platform teams with heavy agent spend; use benchmark proof as hook. Needs enrichment, compliance (GDPR/CAN-SPAM; no LinkedIn scraping), approval before send.
5. Content/social publishing: benchmark posts (include the regression; honesty is the brand), review-state explainers, demo links; X, LinkedIn, Reddit (r/ClaudeAI, r/LocalLLaMA), HN Show HN.
6. Launch planning: Show HN, Product Hunt, host-specific communities (Claude Code, Codex, opencode); none found so far.
7. Plugin/marketplace presence: Claude Code plugin marketplaces, MCP registries, PyPI listing, awesome lists; verify current state.
8. AI-search visibility: llms.txt/agents.md, docs-site, benchmark pages cited by LLMs; track citations for "reduce Claude Code cost", "review AI-generated code".
9. Benchmark/leaderboard credibility: SWE-bench, Terminal-Bench submissions, reproducibility repo; schedule re-runs on new models (Opus 4.8 etc.).
10. Docs/changelog/release notes with distribution (993 commits, frequent releases -> weekly changelog digest).
11. Community: Discord/GitHub Discussions (none found), issue triage, contributor CLA (CLA.md exists).
12. Partnerships/integrations: host vendors (Anthropic, OpenAI, opencode, Coder, K8s), co-marketing, agent-framework docs (LangChain, Google ADK).
13. Pricing/billing: cleanup of retired Pro subscribers (Stripe), future hosted pricing design; billing remains an approval-gated money action.
14. Feedback loops: telemetry-derived usage, benchmark-failure reports, interview design partners; feed roadmap Review vs Runtime.
15. Analytics/attribution: site (Cloudflare), GitHub referrers, install source, no client content/IPs; consent for telemetry.
16. Compliance/trust: privacy policy updates (it still mentions Pro/Stripe), telemetry-on-by-default disclosure, security.txt/SOC2 path for enterprise, contact addresses inconsistent (legal@ vs contact@).
17. Retention/expansion for existing users: re-engagement on new releases, team workspaces (`lc team`) -> hosted upsell.

## Comparables (UNVERIFIED, general knowledge; not fetched this session)

PostHog (open-source, transparent content, product-led), Supabase (launch weeks, GitHub/community), Cline/Aider/Continue (OSS plus community Discord, benchmarks/leaderboards for Aider), Sourcegraph (OSS to enterprise sales), Cursor (PLG bottom-up to team seats), Warp. Applicable: launch-week cadence, public benchmarks, GitHub-star-to-lead enrichment, bottom-up to enterprise motion. Primary sources not retrieved.

## Gaps

- PyPI/npm/marketplace pages, docs-site, X/LinkedIn/Discord, HN/PH/Reddit: not retrievable (fetch errors "Bad file descriptor", search returned nothing). Social following unknown.
- Comparable-company GTM claims not verified from primary sources.
- Hosted release date, funding, team size unknown.
