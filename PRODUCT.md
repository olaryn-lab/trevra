# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Founders and small GTM teams running a focused account/people pipeline with human and agent operators. They want agents to research, source, score, draft, and prepare work while consequential external actions remain behind deterministic policy and explicit approval.

## Product Purpose

Trevra is an open-source GTM operating system and control plane. It helps a workspace find and understand accounts and people, capture inbound demand, operate outreach, manage conversations, qualify opportunities, and learn from GTM outcomes.

Trevra owns the operational truth required to run that loop safely: People, Accounts, Signals, Inbound Submissions, Conversations, Opportunity-lite, Campaigns, Playbooks, agent runs, evidence, policies, approvals, prepared actions, deliveries, and the GTM ledger.

Trevra deliberately does **not** own project delivery, contracts, scope, milestones, customer invoices, payments, accounting, arbitrary application events, generic webhooks, or a general-purpose automation/backend platform.

Canonical boundary: docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md.
Current shell: docs/gtm-shell-shape.md.
Current journeys: docs/product-journeys-and-autonomous-work.md.

## Competitive product priority (October 2026)

Trevra must match and then **exceed Dripify's complete day-to-day experience** for LinkedIn and email outreach. Lead acquisition, import and enrichment, multichannel sequencing, inbox productivity, sender management, integrations, analytics, subscriptions and AI personalization are core product requirements—not optional extensions of a narrower GTM-control-plane concept. Track gaps and implementation evidence in `docs/planning/2026-10-20-dripify-parity-execution-plan.md`. Features unavailable because of platform authorization, privacy or execution constraints remain explicit parity gaps; never claim a capability works merely because some code exists. Preserve deterministic policy, approval, credential custody and idempotent outcomes while closing those gaps.

## Positioning

The product promise is outcome-first:

> Know who is worth pursuing and why now. Let agents do the research and preparation. Keep consequential GTM execution under human control.

Trevra combines:

- source-backed account/person research and composite GTM signals;
- one shared Person/Account/Conversation spine across inbound, LinkedIn, email, and CRM context;
- durable agent/playbook execution with inspectable evidence;
- exact-payload approval for consequential external actions;
- explicit delivery semantics including uncertain outcomes that are never blindly retried;
- a deterministic Today projection that separates what needs a human, what is currently working, and verified recent results.

## Operating Context

The recurring founder loop is:

    Find
     -> Reach
     -> Answer
     -> Qualify / Convert
     -> learn from results
     -> Find again

Primary navigation is intentionally limited to:

- **Loop** — what needs attention, what is working, and what changed;
- **Outreach** — targets, campaigns, conversations, replies, opportunities, and channel safety;
- **Ledger** — agent/skill/playbook runs, evidence, approvals, and action history;
- **Research** — source-backed market/account/community evidence and signals;
- **Setup** — access, providers, GTM capture sources, policies, limits, team, and agent configuration.

There is no Money/post-sale destination.

## Core Data Contracts

### Person and Account

A Person can exist without an Account. Identity resolution is deterministic: email, E.164 phone, LinkedIn profile, provider identity, or explicit source identity. Fuzzy names and guessed company associations are not identity keys.

An Account is a GTM organization with evidence-backed signals and score state. Account-Person association preserves provenance/confidence.

### Signal and evidence

Every meaningful finding preserves source/provenance and observation time. Provider failure is not silently represented as “no result.”

A single trigger is not automatically treated as intent. Composite independent evidence is preferred for account prioritization.

### Conversation and delivery

Founder-facing Conversations converge supported channels around one Person while channel-specific tables remain authoritative for provider mechanics and safety.

Outbound email delivery has explicit sending / sent / failed / uncertain state. An ambiguous provider outcome is never retried as though it definitely failed.

### Opportunity-lite

Trevra stores only the GTM progression it needs:

    new -> qualified -> meeting -> proposal -> won | lost

No amount, forecast, quote, territory, or arbitrary CRM-object platform belongs in Trevra core.

## Agent and Approval Boundary

Agents are durable workspace principals. They may read workspace state, run assigned skills, start playbooks, research, score, draft, and prepare work.

**No agent approves its own consequential work.**

The invariant is:

    decision
     -> prepared exact action
     -> payload hash
     -> policy evaluation
     -> human approval when required
     -> deterministic adapter
     -> durable delivery/outcome

Editing a prepared payload invalidates the old approval. Generic agent tools and generic skill execution do not gain direct send/execute capabilities.

## GTM Intent Surface

The bounded founder-facing objectives are:

- find_accounts
- research_accounts
- prepare_outreach
- watch_accounts
- capture_inbound

The target interaction is:

    Goal -> deterministic Plan -> Prepare -> Result / decision

The plan must say what Trevra will create, what evidence it requires, whether an external effect exists, and where approval will stop execution.

## Integrations

A connection belongs in Trevra only when it:

1. observes GTM state/evidence; or
2. executes a named GTM action.

Current product examples include LinkedIn, Gmail/Microsoft 365, CRM context/activity write-back, public/community research, account observation providers, and signed website lead capture.

Provider credentials remain in the provider-appropriate custody layer and are never stored on Agent principals.

## Product Principles

1. **Evidence before confidence.** A score or summary must remain explainable from durable evidence.
2. **No invented identity.** Missing or conflicting Person/Account identity stays unresolved.
3. **No invented outcomes.** Prepared, approved, sent, failed, and uncertain remain different states.
4. **Agents prepare; policy governs; humans approve consequences.**
5. **Today is deterministic.** A model does not decide which safety exception outranks another.
6. **Do not rebuild a CRM.** Trevra owns only the GTM state required to operate safely with or without one.
7. **Do not rebuild post-sale operations.** Project, contract, invoice, payment, and accounting state stay outside core.
8. **The common path uses founder language.** Internal ids, leases, provider refs, and orchestration mechanics remain inspectable but secondary.

## Evidence on Hand

Do not fabricate customer logos, testimonials, benchmarks, or case studies. Product claims must be supported by shipped behavior or real measured data.
