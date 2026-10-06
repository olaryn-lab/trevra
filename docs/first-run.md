# First run: get one evidence-backed GTM job working

**Status:** Current
**Product scope:** GTM only.

This document describes the shipped first-run contract. It must stay aligned with src/client/views/LoopView.tsx, src/client/views/activation.ts, docs/gtm-shell-shape.md, and the canonical GTM OS design.

The rule is simple:

> A new founder should reach one bounded GTM job without first learning Trevra's internal orchestration vocabulary.

No project, contract, invoice, payment, or accounting setup belongs in first run.

## 1. Sign in

Hosted and self-hosted deployments follow their configured authentication boundary, then land on **Loop**.

Authentication must not require a LinkedIn account, model key, campaign, lead list, CRM, or capture source up front.

## 2. Workspace activation

Loop derives activation from durable server state. There is no onboarding-completed flag.

The current activation sequence is:

1. **Connect an agent**
   - Claude Code, Codex, Trevra's hosted agent, or another supported MCP client.
   - Agent access is read/run only. It cannot approve or execute consequential actions.

2. **Connect a source**
   - A GTM data source or a LinkedIn sending identity.
   - Missing/unreadable provider state is unknown/not connected, never a factual zero.

3. **Set the approval boundary**
   - At least one enabled workspace policy establishes where human judgment is required.
   - Simplified UI may hide policy mechanics, but execution still evaluates policy.

4. **Plan the first job**
   - The founder chooses one bounded GTM objective.
   - Trevra shows the deterministic plan before preparing anything.

If Trevra cannot verify one of these states, it says so and offers retry instead of marking the step empty or complete.

## 3. Bounded first jobs

The current GTM intent vocabulary is:

    Find prospects
    Research accounts
    Prepare outreach
    Watch accounts
    Capture inbound

Internally these map to:

    find_accounts
    research_accounts
    prepare_outreach
    watch_accounts
    capture_inbound

The common interaction contract is:

    Goal
     -> inspect deterministic plan
     -> resolve blockers
     -> prepare only what the plan supports
     -> no consequential external write without its normal approval boundary

A natural-language adapter may eventually produce the same typed intent, but structured and natural-language requests must converge on the same server contract.

## 4. Prepare outreach

The currently executable generic prepare path is intentionally narrow:

    known People list
     -> resolve the LinkedIn sender
     -> apply the blessed default workflow
     -> create a draft managed campaign
     -> stop

Preparation sends nothing.

The founder must not separately create a workflow merely to get through the common first campaign path. Existing advanced workflow/campaign surfaces remain available for operators who need them.

If People or sender identity are missing, the plan names the exact blocker and links to the canonical surface that resolves it.

## 5. Find / research / watch Accounts

These objectives use the existing Account, Signal, scoring, source-provider, and observation systems.

The product contract is:

- preserve source-backed evidence and observation time;
- distinguish provider failure from no result;
- score only from durable components;
- do not invent an Account or Person to make a plan look complete;
- surface materially changed high-priority Accounts into Today.

Watch accounts is preparable when the founder supplies explicit domains. Preparation ensures those canonical Accounts exist, preserves any prior not-a-fit/archive decision instead of silently reactivating it, and leaves new active Accounts immediately due for Trevra’s existing paced observation sweep. Find prospects and Research accounts remain inspectable/direct-surface plans until a persistable source or bounded run primitive is explicit; the UI must not pretend those jobs started.

## 6. Capture inbound

Inbound capture is a GTM source contract, not generic application telemetry.

The canonical flow is:

    signed Capture Source
     -> immutable Inbound Submission
     -> deterministic Person resolution
     -> optional explicit Account association
     -> qualification / Conversation / Opportunity

A website/edge adapter owns its own public-edge validation and bot controls. Trevra owns GTM intake truth once the signed event reaches the capture boundary.

## 7. Returning use: Today

After activation, Loop should answer three different questions from durable state:

### Needs you

Examples:

- sending identity paused/challenged;
- verified reply that requires attention;
- ambiguous external delivery outcome;
- playbook waiting for approval;
- qualified demand / person-discovery decision;
- unreviewed inbound submission;
- newly hot account.

### Working

Examples:

- running Agent;
- queued/running durable Playbook;
- active managed Campaign.

This is what Trevra is currently doing without requiring a human decision.

### Recent results

Verified recent GTM outcomes, for example:

- sent email delivery;
- verified inbound reply;
- Opportunity closed won/lost.

These are outcomes, not model claims.

## 8. Outbound journey

A representative founder journey is:

    Account / People input
     -> source-backed research
     -> score / qualification
     -> draft Campaign or prepared reply
     -> policy / exact approval
     -> delivery
     -> verified reply
     -> Opportunity-lite
     -> outcome feeds future targeting

LinkedIn channel mechanics remain specialized underneath the shared GTM model. The local Companion/browser worker owns browser execution and channel-specific uncertainty/safety behavior.

## 9. Inbound journey

A representative inbound journey is:

    Capture Source
     -> Person + immutable Submission
     -> Account association when explicitly known
     -> qualified-demand recommendation
     -> prepared response/outreach
     -> verified conversation
     -> Opportunity-lite when justified

A Person never requires a fake Account.

## 10. Failure and recovery rules

- A loading request gets a bounded failure state and retry; no infinite spinner.
- A missing prerequisite names what is missing and links to the canonical fix.
- A safety refusal is a decision with a reason, not a generic error.
- prepared, approved, scheduled, claimed, sent, failed, and uncertain are not interchangeable.
- An ambiguous external side effect is not blindly retried.
- Repeating a prepare request with the same idempotency key cannot duplicate durable work or side effects.
- Hosted capabilities fail closed when their required provider/runtime is unavailable.
- Provider failure must not masquerade as an empty GTM result.

## 11. First-run acceptance test

A founder who does not know Trevra's implementation should be able to reach:

    I want to find / research / reach / watch / capture this GTM target.

    Trevra:
    Here is the bounded plan.
    Here is the evidence/source it will use.
    Here is anything missing.
    Nothing consequential will leave the workspace without the configured approval boundary.

    [Prepare]

The complexity remains in Trevra's durable identity, evidence, policy, orchestration, delivery, and ledger layers—not in the founder's onboarding checklist.
