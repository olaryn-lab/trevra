# GTM Taxonomy for Early-Stage B2B Software Founders (as of Oct 2026)

Note on method: ~12 tool calls. Primary sources fetched in full: Google sender guidelines, LinkedIn User Agreement. Everything else is search-snippet level (secondary / vendor / SEO blogs); marked UNVERIFIED where load-bearing. The taxonomy itself (Section 1-3) is INFERRED synthesis from practitioner convention, not a cited claim. FTC.gov fetch failed; CAN-SPAM figures are secondary.

## Q1. GTM functions, jobs, MVP vs scaled, tools (taxonomy)

### Takeaway

Everything GTM partitions into 6 stages (Strategy, Demand, Convert, Close, Retain/Grow, Govern/Measure), 28 functions. Each function = jobs that read/write shared objects. A founder at 1-20 people needs the MVP column; the scaled column is where agents add leverage. (INFERRED structure.)

### Cited Findings (supporting facts for the taxonomy)

- HubSpot's CRM object model covers contacts, companies, deals, tickets plus calls, communications, emails, invoices, leads, marketing events, meetings, notes, orders, payments, products, quotes, subscriptions, tasks; records are linked through associations; invoices associate to contacts, companies, deals, quotes, line items, payments, discounts, fees, taxes — [HubSpot dev docs via search](https://developers.hubspot.com/docs/guides/crm) (snippet-level; not fetched in full, UNVERIFIED in detail).
- 35-45% of B2B research queries reportedly start in AI assistants; AI-referred traffic converts 14.2% vs 2.8% Google — [ThriveStack/Gracker via search](https://www.thrivestack.ai/research/ai-visibility-benchmarks-2026) (vendor, UNVERIFIED).
- Only 12% of URLs cited by ChatGPT/Perplexity/Copilot rank in Google top 10 (2025) — [dupple summary](https://www.dupple.com/learn/ai-search-visibility-chatgpt-perplexity) (UNVERIFIED).
- Listicles drive 21.9% of citation share vs 16.7% standard articles and 13.7% product pages — same sources (UNVERIFIED).
- GitHub stars: only ~1-3% are actual buyers per OSS growth vendors; revenue model (hosted / open core / hybrid) is claimed more predictive than raw stars — [Clarm](https://www.clarm.com/blog/articles/convert-github-stars-to-revenue), [pext OSS economics](https://scour.ing/p/https://www.pext.org/research/oss-economics) (UNVERIFIED).

### Inferences (the taxonomy)

Legend: Agent = A (reliable), A+H (agent drafts, human approves), H (human needed). Risk = L (legal) / R (reputational) / P (platform ban).

**STAGE 1 STRATEGY**

1. Market & ICP research. Jobs: market sizing, competitor teardown, customer-interview synthesis, ICP/persona definition, trigger-event list. In: interviews, CRM won/lost, G2/Reddit/HN, job posts. Out: ICP doc, account scoring rubric. Objects: account, person, signal. Metric: ICP-fit % of pipeline; # interviews/week. MVP: 15-20 founder interviews + 1-page ICP. Scaled: continuous win/loss analysis. Tools: Perplexity/Deep Research, Gong/Granola transcripts, Dovetail, Notion. Agents: A+H (synthesis good; interview and judgment H).
2. Positioning & messaging. Jobs: category/alternatives, value prop, proof points, message map per persona, landing copy, objection handling. Out: positioning doc, message house. Metric: win rate, landing CVR, message-tested reply rate. MVP: April Dunford-style one pager. Tools: Docs, Notion. Agents: A+H; R: claims must be evidence-backed (hallucinated claims).
3. Pricing & packaging. Jobs: value metric, tiers, free/trial policy, discount rules, price tests. Objects: plan, price, quote, subscription. Metric: ARPA, win rate vs discount, expansion %. MVP: 2-3 tiers + annual discount. Tools: Stripe, Orb/Metronome (usage), Paddle. Agents: A for analysis, H for decision.

**STAGE 2 DEMAND (find and create)** 4. Account & contact sourcing. Jobs: build TAM list, find buyers/champions, lookalikes. Tools: Apollo, Clay, ZoomInfo, Sales Nav, Crunchbase, GitHub APIs. Objects: account, person. Metric: valid-email %, ICP match %. Agents: A. Risk L/P (scraping LinkedIn). 5. Enrichment & data hygiene. Jobs: firmographic/technographic enrich, dedupe, email verification, job-change refresh, source provenance. Tools: Clay, Apollo, Clearbit/HubSpot Breeze Intelligence, ZeroBounce/NeverBounce. Metric: bounce <2-3% (UNVERIFIED rule of thumb), dedupe rate. Agents: A (but data errors common; keep provenance). Risk L (GDPR sourcing/notice). 6. Buying signals & intent. Signals: web visits (RB2B, Clearbit Reveal), job changes, funding, hiring, product usage, GitHub stars/forks/issues, community mentions, tech-stack changes, competitor review activity. Tools: Clay, Common Room, Koala, Pocus, Keyplay, Warmly, Octolens, Reo.dev. Objects: signal -> account/person. Metric: signal-to-meeting rate. Agents: A for detection/scoring; H for deciding outreach. Risk L: de-anonymizing visitors in EU. 7. Outbound email. Jobs: copy, sequencing, sending infra (domains, mailboxes), warm-up, bounce/reply handling, unsubscribe. Tools: Instantly, Smartlead, Apollo, Outreach, Salesloft, lemlist. Metric: positive reply rate, meetings/100 prospects, spam rate <0.1%. A+H. Risk L/R/P. 8. LinkedIn & social outreach. Connection/DM, comments, content. Tools: Sales Navigator, Expandi/HeyReach (risky), manual. Agents: A for research and drafts; send by human recommended. Risk P (bans). 9. Calls / phone. Cold calling, voice agents. Mostly H; AI dialers exist; Risk L (TCPA/telemarketing laws, call-recording consent) — INFERRED, not researched. 10. Inbound capture, routing & qualification. Forms, chat, speed-to-lead, lead scoring, routing, scheduling. Tools: HubSpot, Calendly/Chili Piper, Intercom/Drift, Default. Metric: speed-to-lead (minutes), MQL->SQL. Agents: A (qualification chat) with escalation. 11. Content & social publishing. Blog, docs, changelog, LinkedIn/X, video, newsletters. Tools: Webflow/Framer, Buffer, Typefully. Metric: organic signups, share of voice. A+H; R: generic AI slop. 12. SEO & AI-search (GEO/AEO). Jobs: keyword/intent, comparison and "alternatives" pages, schema, llms.txt, third-party mentions (Reddit, G2, listicles), AI-citation tracking. Tools: Ahrefs/Semrush, Profound, Peec, Otterly. Metric: AI citation share, referral signups. A+H. Measurement still immature (all stats vendor). 13. Community & DevRel. Discord/Slack, GitHub issues, OSS maintenance, tutorials, talks, Show HN/Product Hunt, Reddit. Tools: Common Room, Orbit/Crowd.dev, Discord. Metric: activated developers, contributors, community-sourced pipeline. Mostly H (authenticity); A for triage/summaries. R: astroturfing/bot posts are banned by community rules (INFERRED). 14. Paid acquisition. Google Ads, LinkedIn Ads, Reddit/X, retargeting, sponsorships/newsletters. Metric: CPL, CAC, payback. A+H (budget approvals deterministic). Not an MVP priority below ~$10k ACV (INFERRED). 15. Events & webinars. Own webinars, meetups, conferences, hackathons. Tools: Luma, Zoom, Riverside. H-heavy; A for follow-up. Risk L: attendee consent. 16. Partnerships, integrations & marketplaces. Integration listings, AWS/Azure/GCP marketplaces, agencies, resellers, co-marketing, directories. Metric: partner-sourced pipeline. H-heavy. 17. PLG: signup, activation, PQL, upgrade. Jobs: onboarding flow, activation event, usage tracking, PQL scoring, in-app upgrade, trials. Tools: PostHog, Segment, Mixpanel, June, Pocus, Stripe. Metric below. A for scoring/nudges.

**STAGE 3 CONVERT** 18. Meetings & calls: booking, prep briefs, recording/notes, follow-up, CRM update. Tools: Calendly, Gong, Fathom, Granola, Fireflies. A (notes/summaries are the most reliable agent job); Risk L: call-recording consent. 19. CRM, pipeline & forecasting. Stages, next steps, hygiene, forecast. Tools: HubSpot, Attio, Pipedrive, Salesforce, Folk. A for hygiene, H for stage calls.

**STAGE 4 CLOSE & COLLECT** 20. Proposals, quotes, contracts, e-sign. Tools: PandaDoc, DocuSign, Stripe quotes, Dropbox Sign. A+H; legal terms H. Risk L: must be human-approved; quote hash/approval matches Trevra boundary. 21. Billing, invoicing, payments & collections. Tools: Stripe Billing, Chargebee, QuickBooks, Paddle (MoR for VAT). A for dunning reminders; H for refunds/credits/write-offs. Risk L: tax/VAT, money movement.

**STAGE 5 RETAIN & GROW** 22. Onboarding & customer success. Kickoff, implementation, health score, support triage. Tools: Intercom, Pylon, Vitally, Planhat. A+H. 23. Retention, renewals, expansion. Renewal dates, churn risk, upsell triggers, price increase. Metric: NRR, GRR, logo churn. A for signals; H for negotiation. 24. Referrals, case studies, reviews. Ask timing, G2/Capterra reviews, testimonials, referral program. A drafts; H approval; Risk L/R: FTC rules on fake/incentivized reviews (not researched; UNVERIFIED), customer consent for logos/quotes.

**STAGE 6 MEASURE & GOVERN** 25. Reporting, attribution & revenue analytics. Funnel, CAC, payback, pipeline coverage, self-reported attribution ("how did you hear"). Tools: HubSpot, Metabase, Dreamdata, PostHog. A (queries/reports), H (interpretation). 26. Compliance & consent. Consent/suppression ledger, lawful basis per contact, unsubscribe, DSAR, platform-ToS rules, sender authentication. A for enforcement checks (deterministic rules), H for policy. 27. Data/ops infrastructure: domains, DNS, mailboxes, identity, integrations (Nango), audit log. (Trevra-native.) 28. Team/agent governance: approvals, budgets, rate limits, kill switches, audit trail. (Trevra-native control plane.)

Minimum viable GTM for a 1-3 person team (INFERRED): functions 1,2,3(light),4-5(small list),7,10,11(docs+1 post/wk),13 (devtool),17 (devtool/PLG),18,19,20,21,23(light),25(5 numbers),26. Defer: paid, events, partnerships, marketplaces until a repeatable motion shows a >=3-5 customers pattern.

### Gaps

- Tool lists are from general knowledge for 2025-2026, not verified by fetch; confirm pricing/availability before recommending.
- No fetched primary source for pricing/packaging, partnerships, events, or customer success practices.

## Q2. Standard data objects

### Takeaway

A shared spine: Account <-> Person (many-to-many via role), Signal/Activity/Conversation attach to either, Opportunity/Deal -> Quote -> Subscription -> Invoice -> Payment, Campaign and Content Asset attribute to them.

### Cited Findings

- HubSpot standard objects and association model (contacts, companies, deals, tickets, quotes, products, line items, invoices, subscriptions, payments, meetings, calls, emails, notes, tasks) — [HubSpot dev docs](https://developers.hubspot.com/docs/guides/crm), snippet only.
- Invoices associate to contacts, companies, deals, quotes, line items, payments — same source; Subscriptions are created via payment links and quotes.
- Attio/Salesforce object docs were not fetched.

### Inferences (relationships)

- account 1—N person (via account_role: buyer/champion/user/blocker); person N—M account over time (job change = new role, not new person).
- signal N—1 account, optional person; source + timestamp + confidence + evidence URL (provenance).
- activity (email, call, meeting, DM, page view, task) N—1 person, optional account/opportunity/campaign. conversation = thread of activities (channel-specific) with consent and sentiment state.
- opportunity N—1 account, N—M person; deal = won opportunity (or merge: opportunity pre-close, deal post-close). opportunity 1—N quote; accepted quote -> subscription (1—N line items/plan/price) -> invoice N -> payment N.
- campaign 1—N activities/sequences, touches content_asset N—M. content_asset (page, post, doc, video, case study) has channel, URL, canonical claims, citation/visit/lead counts.
- Cross-cutting: consent_record (person, channel, basis, source, time, withdrawal), suppression, approval (payload hash, approver), event (append-only).

### Gaps

- Salesforce/Attio schemas not fetched.

## Q3. Agent-operated GTM in 2026: reliable, approval-needed, failure modes

### Takeaway

Agents reliably do research, enrichment, drafting, summarizing, hygiene and monitoring. Autonomous outbound at volume has a poor record; hybrid human-approved models work better. Money, contracts, scope and external sends should stay behind deterministic approvals.

### Cited Findings

- Reported: outbound touches rose 6.4x while positive reply rates fell to 1.3% versus 2.1% human baseline; about half of pilots shut within 90 days; claimed 50-70% churn before renewal — [Kwanzoo](https://www.kwanzoo.com/blog/why-first-gen-ai-sdrs-failed), [Kapex](https://getkapex.ai/blog/ai-sdr-market-churn-memory-gap-2026) (vendor blogs; UNVERIFIED).
- Documented failure types: invented product capabilities, fabricated security certifications, invented case studies, no cross-session memory, emailing existing customers, pitching competitors, same pitch to CTO and CFO of one account, cheery email to a recently laid-off prospect — [Kwanzoo/Aceverse summaries](https://www.aceverse.co/en/blog/ai-sdr-bdr-2026) (UNVERIFIED anecdotes).
- Platform enforcement: LinkedIn reportedly removed Apollo and Seamless.AI company pages in early 2025 — [Zeliq summary](https://www.zeliq.com/blog/linkedin-automation-2026) (secondary, UNVERIFIED).
- LinkedIn User Agreement (effective 3 Nov 2025) prohibits: "Develop, support or use software, devices, scripts, robots or any other means ... to scrape or copy the Services, including profiles and other data"; and "Use bots or other unauthorized automated methods to access the Services, add or download contacts, send or redirect messages, create, comment on, like, share, or re-share posts, or otherwise drive inauthentic engagement"; LinkedIn may limit contact ability and restrict/terminate accounts (s.3.4) — [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) PRIMARY.
- LinkedIn's own generative AI notice: generated content "might be inaccurate ... Please review and edit such content before sharing" — same PRIMARY source s.3.6.
- Google: don't purchase email addresses; don't mail people who didn't sign up; ramp volume slowly; avoid bursts — [Google sender guidelines](https://support.google.com/mail/answer/81126) PRIMARY.
- Google: "Don't use emojis ... don't send subject lines starting with Re: or Fwd: unless actual replies" — same PRIMARY (anti fake-personalization/threading tricks).

### Inferences

- Reliable (A): list building, enrichment, signal detection, call notes, CRM updates, report generation, FAQ/qualification chat, dunning reminders, content drafts, competitor monitoring.
- Needs approval (A+H): first-touch outbound, anything with claims about product/security/customers, LinkedIn sends, quotes/contracts, discounts, refunds, case-study publishing, scope changes, public community posts.
- H: positioning calls, pricing decisions, discovery/closing conversations, partnership negotiation, DevRel credibility, legal terms.
- Failure-mode controls Trevra can enforce deterministically: claim-to-evidence linking, suppression/customer/competitor exclusion lists, per-account one-thread rule, send caps and warm-up ramp, kill switch on spam/bounce thresholds, idempotency keys, consent ledger check before every send.

### Gaps

- No independent (non-vendor) study of AI SDR performance found.

## Q4. Compliance and platform rules

### Takeaway

Rules differ sharply by jurisdiction: US opt-out; Canada implied-consent B2B conditions; EU national opt-in variants (Germany strictest); Switzerland GDPR-like data law; plus mailbox-provider and platform rules that bite earlier than law.

### Cited Findings

- Gmail (from 1 Feb 2024): all senders to Gmail need SPF or DKIM, valid PTR, TLS, spam rate under 0.3%; >5,000 msgs/day senders need SPF+DKIM+DMARC with From alignment and one-click unsubscribe (List-Unsubscribe and List-Unsubscribe-Post headers, RFC 8058); recommend spam rate under 0.10% — [Google](https://support.google.com/mail/answer/81126) PRIMARY. Unsubscribe processed within 2 days is reported by secondary [Close](https://help.close.com/docs/requirements-for-bulk-email-senders), UNVERIFIED here.
- CAN-SPAM covers all commercial email including B2B; seven requirements (accurate headers, honest subjects, ad identification, physical address, opt-out, honor within 10 business days, monitor third parties); max civil penalty reported $53,088 per email (2025 inflation adjustment); Verkada paid $2.95M in 2024 — [Prospeo](https://prospeo.io/s/can-spam-penalties), [FTC guide mirror](https://sbdc.fgcu.edu/wp-content/uploads/2024/08/the-can-spam-act-a-compliance-guide-for-business.pdf). FTC.gov page fetch failed; amounts UNVERIFIED vs primary.
- CASL applies to B2B; implied consent via conspicuous publication needs: address conspicuously published, no "no unsolicited messages" statement, message relevant to recipient's role; CRTC (Blackstone) held this is a higher bar than mere public availability — [Osler](https://develop.osler.com/en/insights/updates/casl-s-first-compliance-and-enforcement-decision/?pdf=1), [Substance Law](https://substancelaw.ca/casl-compliance/) (secondary).
- EU: ePrivacy is a directive implemented nationally; Germany (UWG s.7) reportedly requires prior consent even B2B; France allows B2B with relevant-role message plus opt-out; Italy reportedly stricter — [Overloop](https://overloop.com/blog/b2b-cold-email-germany-gdpr-compliance), [Prospeo](https://prospeo.io/s/gdpr-cold-email-b2b) (vendor blogs; UNVERIFIED, verify with counsel).
- EDPB Guidelines 1/2024 (draft Oct 2024): Recital 47 does not mean direct marketing is automatically a legitimate interest; right to object (Art. 21) is important — [Morgan Lewis](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2024/10/gdpr-when-can-data-controllers-rely-on-legitimate-interests-for-data-processing-new-guidelines-from-the-edpb) (secondary; final-version status not confirmed).
- Swiss nFADP in force 1 Sep 2023; right to object incl. direct marketing — [SME portal](https://www.kmu.admin.ch/en/new-federal-act-on-data-protection-nfadp). Swiss unsolicited-mass-advertising rules sit in the unfair competition act (UWG) — INFERRED from memory; NOT confirmed by any fetched source.

### Inferences

- Trevra implication: per-recipient jurisdiction + channel + lawful basis check before send; suppression list shared across tools; sender-domain SPF/DKIM/DMARC check; List-Unsubscribe header; no LinkedIn bot automation (human-in-the-loop only).
- Beseam is presumably Swiss-adjacent (user's Google locale .ch in page) — INFERRED, not verified; confirm target geographies.

### Gaps

- FTC primary page, CRTC primary guidance, EDPB final guideline, FDPIC and Swiss UWG text, UK PECR not fetched.
- US state laws, TCPA/phone, SMS not covered.
- Whether Google/Yahoo thresholds changed in 2025-26 not checked beyond 2024 requirements text (Microsoft/Outlook 2025 requirements not researched).

## Q5. Benchmarks

### Takeaway

Cold email positive reply rates are low single digits and methodology varies up to ~7.6x; founder-led deals win more than average; seed-stage CAC payback under 18 months is acceptable; PLG freemium converts low single digits to ~5%. Nearly all figures are vendor-sourced; use as ranges.

### Cited Findings

- Average cold email reply rate ~3.43% (2026), published range 0.45%-3.7%; top quartile ~5.5%, elite 10%+; another source claims 1.4% average, down from 3.5% in 2018; SaaS-to-SaaS under 1.5%; sequences of 4-7 steps average 8.3% vs 4.1% with no follow-ups (vendor claims) — [Boomerang](https://www.getboomerang.ai/glossaries/cold-email-reply-rate-benchmarks-2026), [lemlist](https://lemlist.com/blog/cold-email-response-rate), [Mailshake](https://mailshake.com/blog/cold-email-benchmarks-2026/) (UNVERIFIED).
- AI SDR positive reply 1.3% vs 2.1% human baseline — [Kwanzoo](https://www.kwanzoo.com/blog/why-first-gen-ai-sdrs-failed) (UNVERIFIED).
- Founder-led sales win rates 30-50% in right conditions vs ~20-21% B2B average — [mean.ceo](https://blog.mean.ceo/?p=10269) (UNVERIFIED, low authority).
- Sales cycle: SMB (<$15K ACV) 14-30 days; mid-market ($15-100K) 30-90 days; enterprise 90-180+ days — [Prospeo/Boomerang](https://getboomerang.ai/glossaries/b2b-sales-cycle-benchmarks-2026); another source: ~75 / 115 / 180 days by ACV tiers — conflict in tiers; avg B2B tech cycle ~6.5 months (2025) per [Kondo](https://www.trykondo.com/blog/2025-b2b-sales-trends) (UNVERIFIED).
- Win rate by ACV: <$10K 28-35%; $10-50K 20-28%; $50-100K 15-22%; >$100K 12-18% — [Prospeo](https://prospeo.io/s/saas-sales-conversion-rates) (UNVERIFIED).
- CAC payback: seed investors generally accept under 18 months (12 targeted); Series A 8-14 months typical; KeyBanc 2025 survey of 104 private SaaS cos median 20 months; SMB <12, mid-market <18, enterprise <24 — [Causo](https://hub.causo.ai/guides/cac-payback-seed-saas), [Rework](https://resources.rework.com/libraries/growth-frameworks/cac-payback-optimization) (secondary; KeyBanc primary not fetched).
- PLG: visitor-to-signup ~6% freemium vs 3-4% trial (OpenView); free-to-paid: freemium ~5% of signups vs 17% free trial (OpenView, older, ~2022-23); trial without card 4-6%, with card 25-35%; activation 20-40% normal — [OpenView](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/) (primary but dated; snippet only), [GTM8020](https://www.gtm8020.com/blog/product-led-growth-statistics) (secondary).
- Elite PLG companies: 30-50% of new ARR from expansion vs 10-20% traditional — attributed to Kyle Poyar, [snippet via search](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/) (UNVERIFIED).
- Spam complaint thresholds: <0.10% target, never 0.30% — [Google](https://support.google.com/mail/answer/81126) PRIMARY.

### Inferences

- Realistic seed targets for a founder doing outbound: positive reply 1-3%; meeting booked 0.5-1.5% of contacts; first 10 customers mostly from founder network + founder outbound + community; sales cycle for sub-$15K ACV 2-6 weeks. These are INFERRED from the ranges above, not cited.
- For a dev tool (LemonCrow): leading metrics = activated installs/weekly active developers, signup-to-activation, stars-to-signup; for beseam: depends on offering (not researched).

### Gaps

- No authoritative (KeyBanc, Bessemer, ICONIQ, Pavilion, Winning by Design primary) reports fetched; no benchmark specific to 1-20 person founder-led B2B with date-stamped methodology. Founder-led win-rate source is weak.
- No benchmarks for LinkedIn reply rates, webinar conversion, partnerships, paid CAC by channel, DevRel.
- Pavilion, a16z, First Round, YC, Lenny's frameworks not fetched.
