# Simple surface, complete depth: patterns for agent-operated GTM (as of Oct 2026)

Evidence tiers: PRIMARY = fetched and read from the originator; SEARCH-ONLY = seen only in search snippets, UNVERIFIED against the page; VENDOR = comparison/blog content with commercial bias.

## Q1. Products praised for simplicity despite breadth, and the patterns

### Takeaway

The best-documented pattern is opinionated defaults plus a small set of universal primitives, with customization pushed to the edges. Linear states this explicitly (primary source). Evidence for Superhuman, Raycast, Stripe, Notion, Arc, Folk and Close is thin: I fetched no primary design write-ups for them.

### Cited Findings

- Linear: "We design it so that there's one really good way of doing things... Flexible software lets everyone invent their own workflows, which eventually creates chaos as teams scale." (Jori Lallo, co-founder) — [Figma Blog, 29 May 2024](https://www.figma.com/blog/the-linear-method-opinionated-software/) PRIMARY (interview)
- Linear avoids jargon: uses universal units (projects, teams); goal that "you shouldn't need a handbook to start"; "there may not be one right way... but there is a default way." — same source
- Linear is most opinionated at the atomic level (issue properties like labels, due dates) and takes more cues from customer feedback higher up the stack (projects), since companies are structured differently. — same source
- Linear knowingly accepted "product debt" in Settings (only ever added to it for 5 years) because display options/favorites "don't generally make or break" the experience; i.e. protect the core flow, tolerate mess in the periphery. — same source
- NN/g on progressive disclosure: defers secondary options to a subsidiary screen so users focus on the primary options shown by default; improves learnability, efficiency of use, error rate (3 of 5 usability components). Example: macOS print dialog "Show Details". — [NN/g Progressive Disclosure](https://www.nngroup.com/videos/progressive-disclosure/) (SEARCH-ONLY snippet; classic Nielsen 2006 principle)
- Superhuman: product-market-fit score started at 22% ("very disappointed" survey), reached 58% within a year by splitting the roadmap between reinforcing what fans love and fixing what holds fence-sitters back. This is a method for choosing what to build/not build, not UI. — [Superhuman blog](https://blog.superhuman.com/how-superhuman-built-an-engine-to-find-product-market-fit/) (SEARCH-ONLY snippet)
- Raycast: keyboard-first, launches in <50ms, breadth delivered via an extension store with templates and low barrier to entry. — [blakecrosley.com design write-up](https://blakecrosley.com/guides/design/raycast) and [Raycast vs Alfred](https://raycast.com/raycast-vs-alfred) (SEARCH-ONLY, secondary opinion)
- Stripe Dashboard: described as calm/high-stakes clarity, focus on key indicators. — [925studios](https://www.925studios.co/blog/stripe-dashboard-design-breakdown) (SEARCH-ONLY, tertiary opinion); Stripe's own surface for breadth is Apps with a design system: [Stripe Apps design](https://docs.stripe.com/stripe-apps/design) (not read)
- Attio: custom objects/attributes/records, "Notion-like" navigation; median setup 12 days vs 6-8 weeks for HubSpot (claim from vendor comparison, no methodology). Also criticised: Notion-like navigation unfamiliar to traditional CRM users; automation setup 2+ hours to master. — [Softr comparison](https://v2.softr.io/blog/attio-vs-hubspot) (VENDOR, SEARCH-ONLY)
- Lightfield (AI-native CRM, a16z Series A $47M): no custom fields, no implementation project; connect mail, calendar, data warehouse, call recorder (or CSV import) and the record is assembled from interactions; opportunities auto-created from emails/calls. — [SaaStr](https://www.saastr.com/lightfield-just-assembled-a-working-crm-live-on-stage-then-unstuck-a-stalled-deal-in-3-minutes/) and [Crypto Briefing](https://cryptobriefing.com/lightfield-raises-47m-a16z-ai-crm/) (SEARCH-ONLY; demo claims, not independent measurement)

### Inferences

- INFERRED: "Atoms opinionated, aggregates configurable" maps to Trevra: fixed small verbs (capture, watch, prepare, approve) and plan hash are the "atoms"; module/playbook variety is the configurable layer.
- INFERRED: Lightfield shows the market direction: "setup" replaced by "connect sources and let the system infer structure". Trevra's evidence ledger fits that, but the claim of zero setup is demo-grade evidence.

### Gaps

- No primary sources fetched for Notion, Arc, Folk, Close, Superhuman command palette, or Stripe design rationale. Arc is also widely reported as discontinued/maintenance mode by its maker (The Browser Company) — not verified here; do not cite Arc as a success without checking.
- No quantitative study linking "opinionated defaults" to retention.

## Q2. GTM tools criticised as too complex, and causes

### Takeaway

Complaints cluster on: admin/consultant dependency and setup-before-value (Salesforce), association/object model bottlenecks and tier pricing (HubSpot), and build-and-maintain workflow burden plus dual credit accounting (Clay). Sources are mostly vendor/competitor content; treat as directional.

### Cited Findings

- Salesforce: setup/administration "extremely complex" even for day-to-day config; SMBs often need a consultant; admin salary ~$85k/yr cited from Glassdoor (secondhand). — [Apptivo (competitor)](https://apptivo.com/compare-crm/salesforce-alternative), [Clevyr](https://clevyr.com/blog/post/how-complex-is-salesforce) VENDOR/SEARCH-ONLY
- HubSpot: generally simpler, but steep learning curve with feature breadth, prohibitive pricing for small businesses, and associations between contacts/companies/leads/tasks becoming a bottleneck as sales complexity grows. — [Clevyr](https://clevyr.com/blog/post/salesforce-vs-hubspot-smb), [Gartner Peer Insights review](https://external.pi.gpi.aws.gartner.com/reviews/review/view/6263918) VENDOR/SEARCH-ONLY
- HubSpot 6-8 weeks to full productivity vs Attio 12 days median (vendor comparison, unverified methodology). — [Softr](https://v2.softr.io/blog/attio-vs-hubspot)
- Clay: G2 4.7/5 (~189 reviews) but steep learning curve "consistently flagged"; March 2026 pricing overhaul introduced a dual-credit model (Data Credits + Actions); waterfall enrichment can burn several credits per row (example: 4 credits if first three providers fail); "you are still paying for a tool that requires you to build and maintain workflows"; poor fit for non-technical teams. — [enrich.so review](https://enrich.so/blog/clay-review), [Tomba](https://tomba.io/blog/clay-pricing) (VENDOR competitors, SEARCH-ONLY)
- Generic: "The gap between 'powerful platform' and 'team that can actually use it' kills more CRM implementations than any other factor." — Clevyr (consultancy opinion, no data)

### Inferences

- INFERRED causes: (1) configuration surface the buyer must design before value; (2) object-model/association complexity; (3) metered credits that make cost unpredictable per action; (4) breadth that requires a dedicated operator role. Trevra should avoid each: no schema design step, plan previews that show consequences (cost included), no operator role.
- INFERRED: Trevra's plan blockers/consequences could surface credit/cost per plan before approval, directly answering the Clay complaint.

### Gaps

- No Reddit/HN/G2 primary threads fetched; Outreach not covered. Complaints sourced from competitors; no independent measurement of admin cost or setup time.

## Q3. Presenting agent work: trust, autonomy, approvals

### Takeaway

Research and practice converge on: show what the agent will do and why before consequential actions, keep perceived control, keep audit/undo, and avoid approval fatigue by tiering approvals by risk. Anthropic's own data shows blanket per-action prompts degrade into rubber-stamping.

### Cited Findings

- Anthropic (Mar 25, 2026): "Claude Code users approve 93% of permission prompts"; manual prompts lead to "approval fatigue, where people stop paying close attention." Their answer is tiering: safe read-only allowlist, in-project edits auto-allowed (reviewable via version control), only risky actions reach a classifier; block categories include destroy/exfiltrate, cross trust boundaries, affect others. — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode) PRIMARY
- Same source: classifier false-negative rate 17% on real "overeager" actions (n=52, small sample), FPR 0.4% on 10,000 real calls; "It is not a drop-in replacement for careful human review on high-stakes infrastructure." After 3 consecutive or 20 total denials the system stops and escalates to the human. — same source PRIMARY
- Same source: "overeager" examples relevant to GTM: vague request ("clean up old branches") + irreversible action should be blocked; agent-inferred parameters (picking a "closest match" target) should be blocked; "everything the agent chooses on its own is unauthorized until the user says otherwise." — same source PRIMARY
- Microsoft Guidelines for Human-AI Interaction (CHI 2019, Honorable Mention): 18 guidelines in four phases (initially, during interaction, when wrong, over time); validated with 49 practitioners testing 20 AI products. Initial guidelines: make clear what the system can do, and how well. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/) PRIMARY (2019; pre-agent, so predates LLM agents)
- Google PAIR People + AI Guidebook (May 2019): automate tasks that are difficult/unpleasant/need scale; augment tasks people enjoy or that carry social capital; set mental models by explaining what it can/can't do and how it may change; people prefer to remain in control of which tasks execute. — [PAIR](https://pair.withgoogle.com/) summarised via search snippet (SEARCH-ONLY, 2019)
- UXmatters (Dec 15, 2025; practitioner article, not empirical): users want "perceived control", not constant control; design interruptibility, adjustable autonomy settings, previews for high-risk execution, visible emergency stops; intent design should capture outcomes, risk level, constraints, forbidden actions, and conditions where permissions change; checkpoints ("approvals, status check-ins") keep humans in the loop; audit logs create accountability; reversibility before consequences become permanent. — [UXmatters](https://www.uxmatters.com/mt/archives/2025/12/designing-for-autonomy-ux-principles-for-agentic-ai.php) OPINION
- NN/g State of UX 2026: people spend less time navigating UI and more time delegating to a layer on top; trust is a major design problem needing transparency, control, consistency, and support when the system fails; 2026 described as a year of AI fatigue. — [NN/g](https://www.nngroup.com/articles/state-of-ux-2026/) (SEARCH-ONLY summary)
- Automation bias: a 2025 systematic review of 35 peer-reviewed studies found agreement with incorrect AI recommendations the most consistent behavioral outcome; clinical decision-support studies report 6-11% acceptance of bad advice (secondhand). Approval fatigue named among Google DeepMind "AI agent traps" (2025). — [tianpan.co, Jun 2026](https://tianpan.co/blog/2026-06-25-approval-fatigue-how-human-in-the-loop-gates-decay-into-rubber-stamps) (SEARCH-ONLY, blog citing studies; underlying studies not verified)
- Attio's hosted MCP (GA Feb 2026): reads auto-approved, writes request user confirmation; schema writes and webhooks absent from MCP. — [Scalekit, Jun 23 2026](https://www.scalekit.com/blog/attio-mcp-vs-api) (secondary, by a vendor; cites Attio docs docs.attio.com/mcp/overview, not read)

### Inferences

- INFERRED: Trevra's single approval boundary for all external writes risks becoming the 93% rubber stamp if every low-risk write needs a click. Evidence supports tiered autonomy: auto for reversible/internal, approve for external writes, always-approve for scope changes (matches AGENTS.md "Scope changes always require manual approval").
- INFERRED: The plan hash + consequences preview is a stronger consent artifact than per-action prompts; Anthropic's miss analysis ("approval-shaped evidence" not covering the action's blast radius) argues for approval bound to exact payload hash (already in Trevra).
- INFERRED: Make approval cards decision-ready: the diff of what leaves the system, evidence links, reversibility flag; escalate/stop rule after repeated denials.
- INFERRED: notifications: batch into the Today queue; interrupt only for blocked/failed/needs-approval states (no direct study found).

### Gaps

- No NN/g primary article specifically on agent delegation/approval found; no OpenAI agent UX writing fetched; PAIR chapters on Feedback+Control not read directly; HAX guidelines text (18 items) not read, only abstract.
- No empirical study of intent-entry vs forms for GTM tasks.

## Q4. Onboarding and time-to-first-value

### Takeaway

Benchmarks exist but are averages across heterogeneous products. The strongest design lead is "connect sources -> value without data entry".

### Cited Findings

- Userpilot 2025 benchmark (62 B2B SaaS cos.): average time-to-value 1 day 12 h 23 min; average activation 37.5% (median 37.04%); onboarding checklist completion 19.2% (188 cos.); 1-month retention 46.9%; core feature adoption 24.5%. Caveat: averages mix very different product complexities. — [Userpilot](https://userpilot.com/saas-product-metrics/) and [Tandem](https://usetandem.ai/blog/what-activation-rates-are-normal-by-product-type-and-job-complexity) (SEARCH-ONLY; vendor benchmark, methodology not checked)
- Lightfield onboarding: connect inbox/calendar/CSV and the CRM populates in "less than five minutes" (vendor claim). — [SaaStr](https://www.saastr.com/lightfield-just-assembled-a-working-crm-live-on-stage-then-unstuck-a-stalled-deal-in-3-minutes/) (SEARCH-ONLY)
- Checklist completion at 19.2% suggests checklists are weak as the sole activation mechanism. — Userpilot figure; the interpretation is INFERRED.

### Inferences

- INFERRED: define Trevra's activation event as "first approved plan executed with a result in Today", measured as time from signup; sample data/demo plan before connecting inbox may shorten first-value.
- INFERRED: import-from-existing-tool (CSV/HubSpot/Attio) and inbox connect are the proven shortcuts; LinkedIn connect carries platform-policy risk (not researched).

### Gaps

- No founder-specific onboarding study; no primary data on sample-data effects, one-click first campaign, or LinkedIn connect.

## Q5. Breadth via extensibility

### Takeaway

Leaders add breadth via APIs/MCP/app SDKs/marketplaces, keeping the core UI small. The key caveat: MCP is not a full substitute for the API, and extensions need a governed write path.

### Cited Findings

- Attio developer platform: App SDK (TypeScript/React inside Attio), REST API with webhooks, MCP server. — [Attio developers](https://attio.com/developers) (SEARCH-ONLY)
- Attio MCP: 37 tools across 9 categories; no webhook or schema-write tools; OAuth-interactive only (unsuitable for headless agents); rate limits 100 reads/s, 25 writes/s, 300 searches/min; best practice "MCP for interactive features, the API for background work". — [Scalekit](https://www.scalekit.com/blog/attio-mcp-vs-api) (VENDOR secondary, Jun 2026)
- Raycast: extension store with templates and low barrier; extensions follow shared design language/keyboard model. — [blakecrosley.com](https://blakecrosley.com/guides/design/raycast) (SEARCH-ONLY, opinion)
- Stripe Apps ship with design guidance to keep extensions consistent. — [Stripe Apps design](https://docs.stripe.com/stripe-apps/design) (not read; title/URL only)
- NN/g: as services are exposed via agent-compatible APIs, design for human and agent users will separate. — [NN/g AI Agents as Users](https://www.nngroup.com/articles/ai-agents-as-users/) (SEARCH-ONLY)

### Inferences

- INFERRED: Trevra's registry/playbooks equal the "extension" layer; the UI contract should be that extensions render into existing surfaces (Today, plan preview, approval), not new screens, mirroring Raycast/Stripe Apps consistency rules. Matches AGENTS.md rule that external-write skills need dedicated prepared-action adapters.
- INFERRED: expose Trevra itself via MCP read tools plus approval-gated writes; offer both interactive and headless auth.

### Gaps

- No primary read of Attio, Notion, Stripe or Raycast docs; no marketplace quality-control evidence (failure modes of marketplaces/plug-in sprawl not researched).

## Cross-cutting gap

Failures of "everything" products (e.g., HubSpot sprawl, Salesforce) are evidenced only by competitor/vendor content; no independent usability study found. Trevra-specific implications above are INFERRED, not sourced.
