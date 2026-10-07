# Phase C: GitHub Repo-Traction Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn stars, forks and issues on the founder's own public GitHub repositories (for example `lemoncrow-lab/lemoncrow`) into evidence-backed account signals on real companies, so a company that is visibly using the product shows up as a ranked account and, when it is hot, as the existing Today item `high_priority_account`.

**Architecture:** GitHub is a read-only Nango connection (provider `github`, no scopes). The owner names up to 10 repositories on Setup -> Workspace. The automation cycle polls each due repository through the Nango proxy at most hourly, using per-kind cursors and ETags stored in `watched_repositories`. Each new star, fork or outside issue is resolved to a company domain from public profile data only, attached to an existing account or used to create a capped, tagged new account, written through `recordSignals`, and rescored. Revoked authorization and rate-limit exhaustion are stored as repository/connection states that the Setup card shows, never as zero activity.

**Tech Stack:** TypeScript, Express, PostgreSQL (forward-only migration `132_*`), Nango proxy (`@nangohq/node` `get`), GitHub REST API 2022-11-28, Zod, Vitest with a real PostgreSQL container, React (`renderToStaticMarkup` tests).

**Spec:** `reports/LemonCrow and Beseam GTM needs.md` ("Prioritized gap list" P1 row "GitHub repo-traction signals (stars, forks, release downloads, issues by org) resolved to Accounts", and "Design principles"), bound by `docs/superpowers/plans/2026-10-06-gtm-integration-roadmap.md` (Phase C row, Global Constraints, Shared contracts 4 and 5).

External facts used (checked 2026-10-06):

- Nango ships a `github` provider (OAuth App) and a `github-app` provider: https://nango.dev/docs/api-integrations/github and https://nango.dev/docs/api-integrations/github-app
- Nango proxy retries 429/5xx with exponential backoff (3 s doubling, capped at 10 min) and honours provider rate-limit headers when `retries` > 0, which would hold a workspace's automation lease; this plan passes `retries: 0` and reschedules instead: https://nango.dev/docs/reference/functions and https://nango.dev/docs/reference/api/proxy/get
- `GET /repos/{owner}/{repo}/stargazers` returns `starred_at` only with `Accept: application/vnd.github.star+json`; `per_page` max 100: https://docs.github.com/en/rest/activity/starring#list-stargazers
- `GET /repos/{owner}/{repo}/forks?sort=newest`: https://docs.github.com/en/rest/repos/forks#list-forks
- `GET /repos/{owner}/{repo}/issues` includes pull requests (they carry a `pull_request` key); `since` filters by last _update_; `sort=created`: https://docs.github.com/en/rest/issues/issues#list-repository-issues
- `GET /users/{username}` (`type`, `company`, `blog`, public `email`, `html_url`) and `GET /orgs/{org}` (`name`, `blog`): https://docs.github.com/en/rest/users/users#get-a-user and https://docs.github.com/en/rest/orgs/orgs#get-an-organization
- Rate limits: `x-ratelimit-remaining`, `x-ratelimit-reset` (epoch seconds), `retry-after` on secondary limits; exhausted limits answer 403 or 429: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Conditional requests (`If-None-Match` -> 304) do not count against the primary rate limit when authorized: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Upgrade path webhooks `star`, `fork`, `issues`: https://docs.github.com/en/webhooks/webhook-events-and-payloads

Stargazer ordering is not documented; the poller does not depend on it beyond page selection (every item is filtered by `starred_at > cursor`), and the page walk is bounded by `MAX_STAR_PAGES`.

Out of scope (named so nobody adds it silently): release download counts from the P1 row (aggregate numbers with no actor, so they cannot resolve to an Account), private repositories (need the `repo` scope), GitHub App webhooks (recorded as `lc-debt`), and any new Today item kind (Shared contract 5: "C none (uses `high_priority_account`)").

## Global Constraints

Copied verbatim from the roadmap; every task implicitly includes them.

- PostgreSQL only; forward-only migrations in `migrations/`; never add a SQLite path.
- Scope every commercial query by `workspace_id`. A provider connection or webhook endpoint determines the workspace; never take the workspace from payload data.
- Multi-step writes run in one `db.transaction`; competing work uses `pg_advisory_xact_lock(hashtextextended(...))` or row locks, as `src/server/lead-capture/submissions.ts` does.
- Provider credentials and signing secrets live in Nango or Trevra secret custody (`src/server/secrets/crypto.ts`, gated by `secretsConfigured()`), never plaintext in tables or source.
- External writes require deterministic idempotency keys and go through the existing prepared-action/approval/execution boundary (`src/server/control-plane/execution.ts`). Never execute an external write through the generic skill or playbook runner.
- Webhook redeliveries dedupe through `webhook_events` (migration 058 index `idx_webhook_events_tenant_idempotency`).
- Analytics and domain-event payloads carry no client content, email bodies, document text, invoice details or IP addresses.
- Do not rebuild OAuth, token rotation, rate-limit handling or sync storage; use Nango or the provider's official SDK.
- Post-sale stays excluded (migrations 095, 106, 107): Stripe and other billing data are _observed_ outcomes only; no quotes, invoices, VAT or subscription management in Trevra.
- Closed vocabularies: new account-signal kinds are added to `ACCOUNT_SIGNAL_KINDS` (`src/server/accounts/types.ts`) _and_ given a weight in `weightFor` (`src/server/accounts/score.ts`); unknown kinds score zero by design.
- Account signals are written only through `recordSignals` (`src/server/accounts/sweep.ts`), which drops signals without an `evidenceUrl`; follow with `rescoreAccount` (`src/server/accounts/score.ts`) when rows were written.
- Opportunity stages never move backwards automatically and are never set to `lost` automatically.
- No new navigation section. Surfaces are Today (`src/server/today.ts`), Opportunities, existing `/setup/*` screens, plan blockers in the intent compiler, and approval cards. New routes, if any, are added in `SECTIONS`/`SUB_ROUTES`/`SHELL_PATHS` (`src/client/ui/route.ts`) and `APP_PATH_HEADS` (`src/server/index.ts`); never `#/` routes.
- Client UI uses `src/client/ui/primitives.tsx` controls and `--t-*` tokens; no inline reusable styles.
- Tests use a real PostgreSQL container: `npx tsx scripts/test-with-postgres.ts <test files>` for a focused run; `npm run check` before every commit. Run `npm audit --omit=dev` when a dependency is added.
- Deliberate ceilings get an `lc-debt: <ceiling>; <upgrade path>` comment.
- New durable state ships with its writer and its closer (retention, workspace cascade, or removal path).

Phase C contract (from the roadmap and the phase brief):

- Owned account-signal kinds: `repo-starred`, `repo-forked`, `repo-issue-opened`. No Today item kinds; hot accounts surface as `high_priority_account`.
- Migration `132_*`. At execution time run `ls migrations | tail -3`; if `132_` is taken, use the next free number and update every reference in this plan before Task 1.
- No dependency on Phase A or Phase B code. If they ran first, `ACCOUNT_SIGNAL_KINDS`, `SIGNAL_WEIGHTS`, both `KIND_LABELS` maps and `App.tsx` contain their additions; every edit below is anchored on text that exists either way.
- At most 10 watched repositories per workspace, written as `owner/name`.
- Resolution uses public GitHub data only: organization website from a `@org` handle in `company`, public email domain (freemail skipped), profile `blog` domain (personal platforms skipped). A plain-text company name never becomes a company.
- New accounts only from a resolved non-freemail domain, at most 5 per poll run, `source = 'github'`, tag `github-traction`. `not_a_fit` and `archived` accounts are never reactivated or given signals.
- Unresolved people are counted on the repository, never stored. Resolved people store login and profile URL only, and both are in workspace export and erasure.
- Signal `evidenceUrl` is the GitHub profile URL (star, fork) or the issue URL (issue); `detail` is content-free (`starred lemoncrow-lab/lemoncrow`).

## Review Focus

- A GitHub authorization revoked between polls (a 401, or Nango reporting the connection unusable) must flip the connection to "needs reconnecting" and say so on the Setup card, never render "0 new stars" -> Task 5 test "marks the connection for reconnecting when GitHub rejects the token", Task 8 test "says GitHub is not connected instead of showing zero activity".
- Rate-limit exhaustion halfway through a run must keep everything already processed, resume at GitHub's reset time, and show that time -> Task 4 test "stops before the budget runs out and names the reset time", Task 5 test "stops at the rate limit, keeps what it processed, and resumes at the reset time", Task 8 test "names the reset time when GitHub pauses the watch".
- The same star seen again (a re-poll, overlapping pages, or an unstar and restar) must stay exactly one signal and cost no second profile lookup -> Task 5 test "records the same star once however often it is seen".
- A company the founder marked `not_a_fit` or `archived` must never be reactivated, given a new signal, or rescored, whether it is matched by domain or through a remembered login -> Task 5 test "never reactivates or feeds a company the founder rejected".
- One founder watching the same repository from two workspaces (LemonCrow and Beseam) must get two independent sets of accounts and remembered logins, with nothing attached across workspaces -> Task 5 test "keeps each workspace to its own accounts when two workspaces watch the same repository".

---

### Task 1: Signal vocabulary and weights

**Files:**

- Modify: `src/server/accounts/types.ts:11` (`AccountSource`), `src/server/accounts/types.ts:15-52` (doc comment and `ACCOUNT_SIGNAL_KINDS`)
- Modify: `src/server/accounts/score.ts:153-192` (`SIGNAL_WEIGHTS`), `src/server/accounts/score.ts:203-231` (`KIND_LABELS`)
- Test: `src/server/accounts/score.test.ts` (new `describe` block inserted before `describe('decay', () => {`, currently line 151)

**Interfaces:**

- Consumes: nothing new.
- Produces: `AccountSource` gains `'github'`; `ACCOUNT_SIGNAL_KINDS` gains `'repo-starred'`, `'repo-forked'`, `'repo-issue-opened'`; `SIGNAL_WEIGHTS['repo-issue-opened'] === 26`, `SIGNAL_WEIGHTS['repo-forked'] === 18`, `SIGNAL_WEIGHTS['repo-starred'] === 10`; `weightFor(kind)` returns those values.

- [ ] **Step 1: Write the failing test**

Insert this block in `src/server/accounts/score.test.ts` immediately before the line `describe('decay', () => {`. Every name it uses (`SIGNAL_WEIGHTS`, `SINGLE_KIND_CAP`, `weightFor`, `ACCOUNT_SIGNAL_KINDS`, `score`, `sig`) is already imported or defined at the top of the file.

```ts
describe('repository traction from GitHub', () => {
  const REPO_KINDS = ['repo-starred', 'repo-forked', 'repo-issue-opened'] as const;

  it('weighs an outside issue above a fork above a star, and none of them is worth a meeting alone', () => {
    for (const kind of REPO_KINDS) {
      expect(ACCOUNT_SIGNAL_KINDS).toContain(kind);
      expect(SIGNAL_WEIGHTS[kind]).toBeLessThan(SINGLE_KIND_CAP);
    }
    expect(SIGNAL_WEIGHTS['repo-issue-opened']).toBe(26);
    expect(SIGNAL_WEIGHTS['repo-forked']).toBe(18);
    expect(SIGNAL_WEIGHTS['repo-starred']).toBe(10);
    expect(weightFor('repo-starred')).toBe(10);
  });

  it('keeps a lone star cold, makes a star and a fork warm, and needs all three to be hot', () => {
    expect(score([sig('repo-starred', 1, 'starred lemoncrow-lab/lemoncrow')]).tier).toBe('cold');
    expect(score([sig('repo-starred', 1), sig('repo-forked', 1)]).tier).toBe('warm');
    const layered = score([
      sig('repo-starred', 1),
      sig('repo-forked', 1),
      sig('repo-issue-opened', 1)
    ]);
    expect(layered.tier).toBe('hot');
    expect(layered.distinctKinds).toBe(3);
  });

  it('cannot be bought with stars: forty colleagues starring is still one kind', () => {
    const result = score(Array.from({ length: 40 }, () => sig('repo-starred', 1)));
    expect(result.tier).not.toBe('hot');
    expect(result.score).toBeLessThanOrEqual(SINGLE_KIND_CAP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/accounts/score.test.ts`
Expected: FAIL. "repository traction from GitHub" fails with `expected [ 'first-capture', ... ] to include 'repo-starred'`; the existing weight-table tests still pass.

- [ ] **Step 3: Write minimal implementation**

In `src/server/accounts/types.ts` replace line 11:

```ts
export type AccountSource = 'csv' | 'sourced' | 'linkedin' | 'manual' | 'github';
```

In the doc comment above `ACCOUNT_SIGNAL_KINDS`, replace the sentence that begins "`thread-mention` is the public-commentary signal" with:

```ts
 * Site diffs are `gtm.watch-signal`'s own `SignalKind` values, carried across
 * unchanged so there is no translation table to drift. `thread-mention` is the
 * public-commentary signal from `gtm.scout-threads`. The `repo-*` kinds are
 * first-party developer traction on the workspace's own GitHub repositories
 * (`src/server/github/poll.ts`). Anything not in this union
 * is stored but scored at zero -- an unknown signal must never silently vanish
 * and must never silently count.
```

In the `ACCOUNT_SIGNAL_KINDS` array, add these three entries as the last entries, immediately before `] as const;` (put a comma after the entry that is currently last):

```ts
('repo-starred', 'repo-forked', 'repo-issue-opened');
```

In `src/server/accounts/score.ts`, inside `SIGNAL_WEIGHTS`, insert directly after the line `'thread-mention': 34,`:

```ts

  // First-party developer traction on the founder's own repositories
  // (src/server/github/poll.ts). An outside issue is someone using the product
  // hard enough to hit an edge; a fork is someone building on it; a star is a
  // bookmark, and most stargazers are not buyers. None makes an account hot
  // alone, and a star stays below every measured site movement.
  'repo-issue-opened': 26,
  'repo-forked': 18,
  'repo-starred': 10,
```

In `KIND_LABELS` in the same file, add these as the last entries before the closing `};` (comma after the entry that is currently last):

```ts
  'repo-starred': 'a star on your GitHub repo',
  'repo-forked': 'a fork of your GitHub repo',
  'repo-issue-opened': 'an issue opened on your GitHub repo'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/accounts/score.test.ts && npm run typecheck`
Expected: PASS, and `tsc --noEmit` exits 0 (it fails if `KIND_LABELS` misses a kind, because the map is `Record<AccountSignalKind, string>`).

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/accounts/types.ts src/server/accounts/score.ts src/server/accounts/score.test.ts
git commit -m "feat(accounts): add GitHub repo-traction signal kinds and weights" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 2: GitHub in the Nango catalog

**Files:**

- Modify: `src/server/integration-service.ts:170-193` (append to `catalog`, add `githubProviderConfigKey` after `defaultConnectSessionIntegrations`)
- Modify: `.env.example:131-133` (after `NANGO_EXA_INTEGRATION=trevra-exa`)
- Modify: `docs/integration-contracts.md` (new section before `## Provider admission rule`)
- Test: `src/server/integration-service.test.ts` (`managedEnv` at line 55, dynamic import at line 32, new tests inside `describe('integration catalog')`)

**Interfaces:**

- Consumes: nothing new.
- Produces: `export function githubProviderConfigKey(): string` in `src/server/integration-service.ts` (returns `process.env.NANGO_GITHUB_INTEGRATION ?? 'trevra-github'`); a catalog row `{ key: 'trevra-github', provider: 'github', name: 'GitHub', category: 'data', mode: 'oauth' }` in `listAvailableIntegrations`.

- [ ] **Step 1: Write the failing test**

In `src/server/integration-service.test.ts`:

1. Add `githubProviderConfigKey,` to the destructured names of the `await import('./integration-service.js')` block (after `executeConnectedAction,`).
2. Add `'NANGO_GITHUB_INTEGRATION'` as the last element of `managedEnv` (comma after `'NANGO_BUFFER_INTEGRATION'`).
3. Insert these tests inside `describe('integration catalog', () => {`, directly after the test `'never exposes a credential on a catalog row'`:

```ts
it('offers GitHub as a read-only OAuth data source', async () => {
  const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
  expect(integrations.find((item) => item.provider === 'github')).toMatchObject({
    key: 'trevra-github',
    name: 'GitHub',
    category: 'data',
    mode: 'oauth',
    connected: false
  });
  expect(defaultConnectSessionIntegrations()).toContain('trevra-github');
});

it('resolves the GitHub integration id from NANGO_GITHUB_INTEGRATION', () => {
  expect(githubProviderConfigKey()).toBe('trevra-github');
  process.env.NANGO_GITHUB_INTEGRATION = 'acme-github';
  expect(githubProviderConfigKey()).toBe('acme-github');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/integration-service.test.ts`
Expected: FAIL. "offers GitHub as a read-only OAuth data source" fails with `expected undefined to match object`, and "resolves the GitHub integration id" fails with `githubProviderConfigKey is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/integration-service.ts`, add this element as the last entry of `catalog` (after the `buffer` object, before `] as const;`):

```ts
  // Read-only and public: stars, forks and issues on repositories the owner
  // names in Setup, plus the public profiles of the people behind them. No
  // OAuth scopes are requested -- the token exists so polls spend the
  // connection's own rate limit instead of the 60/hour anonymous one. Trevra
  // never writes to GitHub. See src/server/github/poll.ts.
  {
    key: 'github',
    provider: 'github',
    name: 'GitHub',
    category: 'data',
    description:
      'Watch stars, forks and issues on your public repositories and match them to companies. Read-only — Trevra never writes to GitHub.',
    mode: 'oauth',
    env: 'NANGO_GITHUB_INTEGRATION',
    fallback: 'trevra-github'
  }
```

Directly after the `defaultConnectSessionIntegrations` function, add:

```ts
/** The Nango integration id GitHub connections are stored under. */
export function githubProviderConfigKey(): string {
  const entry = catalog.find((item) => item.key === 'github');
  if (!entry) throw new Error('GitHub is missing from the integration catalog');
  return providerConfigKeyFor(entry);
}
```

In `.env.example`, directly after the line `NANGO_EXA_INTEGRATION=trevra-exa`, add:

```bash
# GitHub repository traction (Setup -> Workspace -> GitHub repositories). Create a Nango integration
# on the `github` provider (OAuth App) with NO scopes: Trevra only reads public stars, forks, issues
# and profiles, and the token exists so polling uses the connection's own rate limit.
NANGO_GITHUB_INTEGRATION=trevra-github
```

In `docs/integration-contracts.md`, insert this section directly before `## Provider admission rule`:

```markdown
## GitHub repository traction (proxy reads)

GitHub is an observe-only connection: Nango provider `github`, integration id `NANGO_GITHUB_INTEGRATION` (default `trevra-github`), no OAuth scopes. There is no Nango sync and no canonical record kind; the worker reads through the Nango proxy, at most hourly per watched repository, and writes account signals.

- **Watched repositories:** the workspace owner lists up to 10 public `owner/name` repositories under Setup -> Workspace. Stored in `watched_repositories` with per-kind cursors and ETags, never credentials.
- **Reads:** `GET /repos/{owner}/{repo}` (ETag), `/stargazers` with `Accept: application/vnd.github.star+json` (for `starred_at`), `/forks?sort=newest`, `/issues?state=all&sort=created&since=...` (ETag; pull requests and `OWNER`/`MEMBER`/`COLLABORATOR` authors skipped), `/users/{login}`, `/orgs/{org}`.
- **Resolution:** public data only. A `@org` handle in the profile `company` whose organization lists a website; else the public email domain (freemail skipped); else the profile `blog` domain (personal platforms such as `github.io` or `medium.com` skipped). A plain-text company name is never turned into a company.
- **Writes:** `repo-starred`, `repo-forked` and `repo-issue-opened` account signals through `recordSignals`; evidence is the GitHub profile URL or the issue URL. Existing accounts are attached by domain; new accounts (`source = 'github'`, tag `github-traction`) are created at most 5 per poll run; `not_a_fit` and `archived` accounts are never reactivated. Resolved logins are kept in `github_repo_actors` (login, profile URL); unresolved people are counted on the repository and never stored.
- **Honest state:** a 401 or a Nango authorization failure flips the connection to `needs_reauth`; an exhausted rate limit pauses polling until GitHub's reset time; both show on the Setup card instead of zero activity.
- **Upgrade path:** GitHub App webhooks (`star`, `fork`, `issues`) through Nango's `github-app` provider replace polling.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/integration-service.test.ts`
Expected: PASS (all tests, including "does not offer Apollo" and "never exposes a credential on a catalog row").

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/integration-service.ts src/server/integration-service.test.ts .env.example docs/integration-contracts.md
git commit -m "feat(integrations): add read-only GitHub connection to the Nango catalog" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 3: Watched repositories table and store

**Files:**

- Create: `migrations/132_github_repo_signals.sql`
- Create: `src/server/github/repos.ts`
- Test: `src/server/github/repos.test.ts`

**Interfaces:**

- Consumes: `githubProviderConfigKey(): string` (Task 2).
- Produces (all from `src/server/github/repos.ts`):
  - `const MAX_WATCHED_REPOSITORIES = 10`, `const POLL_LEASE_MINUTES = 15`
  - `type WatchedRepositoryStatus = 'pending' | 'ok' | 'not_found' | 'rate_limited' | 'needs_reauth' | 'not_connected' | 'error'`
  - `interface PollSummary { stars: number; forks: number; issues: number; attached: number; created: number; unresolved: number; ignoredRejected: number; deferred: number; burstTruncated: boolean }` and `emptyPollSummary(): PollSummary`
  - `interface WatchedRepository { id; workspaceId; owner; name; fullName; url; status: WatchedRepositoryStatus; lastError: string | null; starsCursor: string | null; forksCursor: string | null; issuesCursor: string | null; repoEtag: string | null; issuesEtag: string | null; rateLimitedUntil: string | null; nextPollAt: string; lastPolledAt: string | null; lastSummary: PollSummary | null; unresolvedTotal: number; createdAt: string }` (timestamps are ISO strings)
  - `class GitHubRepoError extends Error { readonly status: number }`
  - `parseRepoFullName(raw: string): { owner: string; name: string } | null`
  - `listWatchedRepositories(db: Db, workspaceId: string): Promise<WatchedRepository[]>`
  - `watchRepository(db: Db, input: { workspaceId: string; actorUserId: string | null; fullName: string }, now?: Date): Promise<{ repo: WatchedRepository; created: boolean }>`
  - `unwatchRepository(db: Db, workspaceId: string, repoId: string): Promise<boolean>`
  - `type GitHubConnectionState = 'connected' | 'needs_reauth' | 'not_connected'`; `interface GitHubConnection { state; localConnectionId: string | null; providerConfigKey: string; externalConnectionId: string | null; lastError: string | null }`
  - `readGitHubConnection(db: Db, workspaceId: string): Promise<GitHubConnection>`
  - `markConnectionNeedsReauth(db: Db, workspaceId: string, localConnectionId: string, message: string, now?: Date): Promise<void>`
  - `hasDueRepositories(db: Db, workspaceId: string, now: Date): Promise<boolean>`
  - `claimDueRepositories(db: Db, workspaceId: string, now: Date, limit: number): Promise<WatchedRepository[]>`
  - `interface RepositoryPatch { status?; lastError?: string | null; starsCursor?: Date; forksCursor?: Date; issuesCursor?: Date; repoEtag?: string | null; issuesEtag?: string | null; rateLimitedUntil?: Date | null; nextPollAt?: Date; lastPolledAt?: Date; lastSummary?: PollSummary; addUnresolved?: number }`
  - `updateRepository(db: Db, workspaceId: string, repoId: string, patch: RepositoryPatch, now?: Date): Promise<void>` (always releases the claim lease)
  - Tables `watched_repositories` and `github_repo_actors` (columns below).

- [ ] **Step 0: Confirm the migration number**

Run: `ls migrations | tail -3`
Expected: no file starting `132_`. If one exists, use the next free number for the file created in Step 3 and in Task 9's sweep command.

- [ ] **Step 1: Write the failing test**

Create `src/server/github/repos.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import {
  GitHubRepoError,
  MAX_WATCHED_REPOSITORIES,
  POLL_LEASE_MINUTES,
  claimDueRepositories,
  emptyPollSummary,
  hasDueRepositories,
  listWatchedRepositories,
  markConnectionNeedsReauth,
  parseRepoFullName,
  readGitHubConnection,
  unwatchRepository,
  updateRepository,
  watchRepository
} from './repos.js';

let db: Db;

const WS = 'ws_github_repos_test';
const OTHER_WS = 'ws_github_repos_other';
const T0 = new Date('2026-10-06T09:00:00.000Z');
const MINUTE = 60_000;

async function resetWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, T0.toISOString());
}

async function addConnection(
  workspaceId: string,
  status: string,
  isDemo: number,
  externalId: string,
  at: Date = T0
): Promise<string> {
  const connectionId = id('conn');
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      connectionId,
      workspaceId,
      'github',
      'trevra-github',
      externalId,
      'GitHub',
      status,
      isDemo,
      at.toISOString(),
      at.toISOString()
    );
  return connectionId;
}

function watch(fullName: string, workspaceId = WS, now = T0) {
  return watchRepository(db, { workspaceId, actorUserId: null, fullName }, now);
}

beforeEach(async () => {
  delete process.env.NANGO_GITHUB_INTEGRATION;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetWorkspace(WS);
  await resetWorkspace(OTHER_WS);
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id = ANY(?::text[])').run([WS, OTHER_WS]);
  await db.close();
});

describe('parseRepoFullName', () => {
  it('accepts owner/name and github.com links, and nothing else', () => {
    const lemoncrow = { owner: 'lemoncrow-lab', name: 'lemoncrow' };
    expect(parseRepoFullName('lemoncrow-lab/lemoncrow')).toEqual(lemoncrow);
    expect(parseRepoFullName(' https://github.com/lemoncrow-lab/lemoncrow/ ')).toEqual(lemoncrow);
    expect(parseRepoFullName('github.com/lemoncrow-lab/lemoncrow.git')).toEqual(lemoncrow);
    expect(
      parseRepoFullName('https://www.github.com/lemoncrow-lab/lemoncrow/tree/main?tab=readme')
    ).toEqual(lemoncrow);
    expect(parseRepoFullName('lemoncrow')).toBeNull();
    expect(parseRepoFullName('a/b/c')).toBeNull();
    expect(parseRepoFullName('-bad/name')).toBeNull();
    expect(parseRepoFullName('owner/..')).toBeNull();
    expect(parseRepoFullName('https://gitlab.com/owner/name')).toBeNull();
  });
});

describe('watchRepository', () => {
  it('watches a repository once per workspace, whatever the casing', async () => {
    const first = await watch('lemoncrow-lab/lemoncrow');
    expect(first.created).toBe(true);
    expect(first.repo).toMatchObject({
      workspaceId: WS,
      fullName: 'lemoncrow-lab/lemoncrow',
      url: 'https://github.com/lemoncrow-lab/lemoncrow',
      status: 'pending',
      lastSummary: null,
      unresolvedTotal: 0,
      nextPollAt: T0.toISOString()
    });

    const again = await watch('https://github.com/LemonCrow-Lab/LemonCrow');
    expect(again.created).toBe(false);
    expect(again.repo.id).toBe(first.repo.id);

    // Another workspace watching the same repository is its own row.
    const other = await watch('lemoncrow-lab/lemoncrow', OTHER_WS);
    expect(other.created).toBe(true);
    expect(other.repo.id).not.toBe(first.repo.id);
  });

  it('refuses a malformed name with 400 and an eleventh repository with 409', async () => {
    await expect(watch('not a repo')).rejects.toMatchObject({ status: 400 });
    for (let index = 0; index < MAX_WATCHED_REPOSITORIES; index += 1) {
      await watch(`lemoncrow-lab/repo-${index}`);
    }
    const refused = await watch('lemoncrow-lab/one-too-many').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitHubRepoError);
    expect((refused as GitHubRepoError).status).toBe(409);
    // Re-adding one already watched is still fine at the cap.
    await expect(watch('lemoncrow-lab/repo-0')).resolves.toMatchObject({ created: false });
  });

  it('removes a repository only from its own workspace', async () => {
    const { repo } = await watch('lemoncrow-lab/lemoncrow');
    expect(await unwatchRepository(db, OTHER_WS, repo.id)).toBe(false);
    expect(await unwatchRepository(db, WS, repo.id)).toBe(true);
    expect(await listWatchedRepositories(db, WS)).toEqual([]);
  });
});

describe('readGitHubConnection', () => {
  it('tells connected, needs-reconnect and not-connected apart, and ignores demo rows', async () => {
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'not_connected',
      externalConnectionId: null
    });
    await addConnection(WS, 'connected', 1, 'demo');
    expect((await readGitHubConnection(db, WS)).state).toBe('not_connected');
    await addConnection(WS, 'disconnected', 0, 'gone');
    expect((await readGitHubConnection(db, WS)).state).toBe('not_connected');
    await addConnection(WS, 'needs_reauth', 0, 'stale');
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'needs_reauth',
      externalConnectionId: 'stale'
    });
    const liveId = await addConnection(WS, 'connected', 0, 'live');
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'connected',
      localConnectionId: liveId,
      externalConnectionId: 'live',
      providerConfigKey: 'trevra-github',
      lastError: null
    });

    // Another workspace's connection is invisible here.
    expect((await readGitHubConnection(db, OTHER_WS)).state).toBe('not_connected');

    await markConnectionNeedsReauth(
      db,
      WS,
      liveId,
      'GitHub rejected the token',
      new Date(T0.getTime() + MINUTE)
    );
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'needs_reauth',
      localConnectionId: liveId,
      lastError: 'GitHub rejected the token'
    });
  });
});

describe('claiming due repositories', () => {
  it('claims a due repository once per lease and releases it on update', async () => {
    const { repo } = await watch('lemoncrow-lab/lemoncrow');
    expect(await hasDueRepositories(db, WS, T0)).toBe(true);

    const [claimed] = await claimDueRepositories(db, WS, T0, 10);
    expect(claimed.id).toBe(repo.id);
    // A second worker inside the lease gets nothing.
    expect(await claimDueRepositories(db, WS, T0, 10)).toEqual([]);
    expect(await hasDueRepositories(db, WS, T0)).toBe(false);

    // An abandoned lease expires.
    const afterLease = new Date(T0.getTime() + (POLL_LEASE_MINUTES + 1) * MINUTE);
    expect(await claimDueRepositories(db, WS, afterLease, 10)).toHaveLength(1);

    // Finishing a poll releases the lease and schedules the next one.
    const next = new Date(afterLease.getTime() + 60 * MINUTE);
    await updateRepository(
      db,
      WS,
      repo.id,
      {
        status: 'ok',
        nextPollAt: next,
        lastPolledAt: afterLease,
        starsCursor: new Date('2026-10-05T11:00:00.000Z'),
        repoEtag: '"v1"',
        lastSummary: { ...emptyPollSummary(), stars: 3, unresolved: 1 },
        addUnresolved: 1
      },
      afterLease
    );
    expect(await claimDueRepositories(db, WS, afterLease, 10)).toEqual([]);

    const [stored] = await listWatchedRepositories(db, WS);
    expect(stored).toMatchObject({
      status: 'ok',
      starsCursor: '2026-10-05T11:00:00.000Z',
      repoEtag: '"v1"',
      unresolvedTotal: 1,
      nextPollAt: next.toISOString(),
      lastPolledAt: afterLease.toISOString(),
      lastSummary: { stars: 3, unresolved: 1, forks: 0, burstTruncated: false }
    });
    expect(await claimDueRepositories(db, WS, next, 10)).toHaveLength(1);
  });

  it('never claims a repository from another workspace', async () => {
    await watch('lemoncrow-lab/lemoncrow', OTHER_WS);
    expect(await hasDueRepositories(db, WS, T0)).toBe(false);
    expect(await claimDueRepositories(db, WS, T0, 10)).toEqual([]);
  });
});

describe('export and erasure', () => {
  it('are found by the workspace catalogue and removed with the workspace', async () => {
    // The same catalogue query app.ts uses for export and erasure.
    const tables = await db
      .prepare(
        `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
           AND t.table_type = 'BASE TABLE'
           AND c.table_name IN ('watched_repositories', 'github_repo_actors')
         ORDER BY c.table_name`
      )
      .all<{ table_name: string }>();
    expect(tables.map((row) => row.table_name)).toEqual([
      'github_repo_actors',
      'watched_repositories'
    ]);

    const tempWs = id('ws');
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(tempWs, 'Erasure probe', T0.toISOString());
    await watch('lemoncrow-lab/lemoncrow', tempWs);
    const accountId = id('acc');
    await db
      .prepare(
        `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?::text[],'active',?,?)`
      )
      .run(
        accountId,
        tempWs,
        'Buyer Co',
        'buyer.io',
        'github',
        ['github-traction'],
        T0.toISOString(),
        T0.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO github_repo_actors
         (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('ghact'),
        tempWs,
        'maya',
        'https://github.com/maya',
        accountId,
        'buyer.io',
        'org_website',
        T0.toISOString(),
        T0.toISOString()
      );

    await db.prepare('DELETE FROM workspaces WHERE id=?').run(tempWs);

    for (const table of ['watched_repositories', 'github_repo_actors']) {
      const row = await db
        .prepare(`SELECT COUNT(*)::int AS count FROM ${table} WHERE workspace_id=?`)
        .get<{ count: number }>(tempWs);
      expect(row?.count).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/repos.test.ts`
Expected: FAIL with `Failed to load url ./repos.js` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `migrations/132_github_repo_signals.sql`:

```sql
-- GitHub repository traction (Phase C).
--
-- Both tables carry workspace_id with ON DELETE CASCADE, so the workspace
-- export and erasure catalogue in app.ts finds them without being told.
--
-- watched_repositories: the founder's own public repositories Trevra polls,
-- plus the bookkeeping that keeps the poll cheap (per-kind cursors, ETags) and
-- honest (a status the Setup card shows). Never credentials: the GitHub token
-- lives in Nango.
CREATE TABLE IF NOT EXISTS watched_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ok','not_found','rate_limited','needs_reauth','not_connected','error')),
  last_error TEXT,
  stars_cursor TIMESTAMPTZ,
  forks_cursor TIMESTAMPTZ,
  issues_cursor TIMESTAMPTZ,
  repo_etag TEXT,
  issues_etag TEXT,
  rate_limited_until TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  -- Counts only (PollSummary in src/server/github/repos.ts). No names, no content.
  last_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- People whose public profile ties them to no company. Counted, never stored.
  unresolved_total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_repositories_name
  ON watched_repositories (workspace_id, LOWER(owner), LOWER(name));
CREATE INDEX IF NOT EXISTS idx_watched_repositories_due
  ON watched_repositories (workspace_id, next_poll_at);

-- github_repo_actors: only GitHub people Trevra RESOLVED to an account, so the
-- next star from the same login skips the profile lookup. Minimal personal
-- data: the public login and profile URL. No email column, on purpose. Closed
-- by the account (cascade) and by the workspace (cascade).
CREATE TABLE IF NOT EXISTS github_repo_actors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  resolved_domain TEXT NOT NULL,
  resolved_via TEXT NOT NULL CHECK (resolved_via IN ('org_website','email_domain','blog')),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_repo_actors_login
  ON github_repo_actors (workspace_id, LOWER(login));
CREATE INDEX IF NOT EXISTS idx_github_repo_actors_account
  ON github_repo_actors (workspace_id, account_id);

COMMENT ON TABLE watched_repositories IS
'Public GitHub repositories a workspace watches for stars, forks and outside issues; polling state only.';
COMMENT ON TABLE github_repo_actors IS
'GitHub logins resolved to an account from public profile data; login and profile URL only.';
```

Create `src/server/github/repos.ts`:

```ts
import { id, type Db } from '../db.js';
import { githubProviderConfigKey } from '../integration-service.js';

/**
 * Which of the founder's own public GitHub repositories Trevra watches, and
 * the polling bookkeeping that keeps the watch cheap and honest.
 *
 * CHEAP: per-kind cursors so a poll reads only what is new, and ETags so an
 * unchanged repository costs a 304 that GitHub does not count against the
 * rate limit.
 *
 * HONEST: a status the Setup card reads. "Not connected", "needs
 * reconnecting" and "rate limited until 13:00" are states, never a quiet zero.
 *
 * Credentials are not here: the GitHub token lives in Nango.
 */

/**
 * lc-debt: 10 repositories per workspace keeps one poll run to roughly 70
 * GitHub requests plus profile lookups; upgrade path is GitHub App webhooks
 * (see poll.ts), after which the cap only bounds the Setup list.
 */
export const MAX_WATCHED_REPOSITORIES = 10;

/** How long a claimed repository is held before another worker may take it. */
export const POLL_LEASE_MINUTES = 15;

export type WatchedRepositoryStatus =
  'pending' | 'ok' | 'not_found' | 'rate_limited' | 'needs_reauth' | 'not_connected' | 'error';

/** What one poll of one repository found. Counts only: no names, no content. */
export interface PollSummary {
  /** New stars read this run (bots excluded). */
  stars: number;
  forks: number;
  /** New issues opened by people outside the repository's own team. */
  issues: number;
  /** Events attached to an account that already existed. */
  attached: number;
  /** Accounts created from a resolved company domain. */
  created: number;
  /** Events from people no public data ties to a company. Counted, never stored. */
  unresolved: number;
  /** Events from a company the founder marked not a fit or archived. */
  ignoredRejected: number;
  /** Events left for the next run because a per-run cap was reached. */
  deferred: number;
  /** More new stars arrived than one run reads; the oldest of them were skipped. */
  burstTruncated: boolean;
}

export function emptyPollSummary(): PollSummary {
  return {
    stars: 0,
    forks: 0,
    issues: 0,
    attached: 0,
    created: 0,
    unresolved: 0,
    ignoredRejected: 0,
    deferred: 0,
    burstTruncated: false
  };
}

export interface WatchedRepository {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  /** `owner/name`, as the founder typed it. */
  fullName: string;
  url: string;
  status: WatchedRepositoryStatus;
  lastError: string | null;
  starsCursor: string | null;
  forksCursor: string | null;
  issuesCursor: string | null;
  repoEtag: string | null;
  issuesEtag: string | null;
  rateLimitedUntil: string | null;
  nextPollAt: string;
  lastPolledAt: string | null;
  lastSummary: PollSummary | null;
  unresolvedTotal: number;
  createdAt: string;
}

export class GitHubRepoError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubRepoError';
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;

/** `owner/name`, or a github.com link to the repository (any deeper path is ignored). */
export function parseRepoFullName(raw: string): { owner: string; name: string } | null {
  const trimmed = raw.trim();
  const fromUrl = GITHUB_URL_PREFIX.test(trimmed);
  const path = trimmed.replace(GITHUB_URL_PREFIX, '').split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = fromUrl ? path.split('/').slice(0, 2) : path.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return null;
  if (name === '.' || name === '..') return null;
  return { owner, name };
}

interface RepoRow {
  id: string;
  workspace_id: string;
  owner: string;
  name: string;
  status: string;
  last_error: string | null;
  stars_cursor: string | Date | null;
  forks_cursor: string | Date | null;
  issues_cursor: string | Date | null;
  repo_etag: string | null;
  issues_etag: string | null;
  rate_limited_until: string | Date | null;
  next_poll_at: string | Date;
  last_polled_at: string | Date | null;
  last_summary_json: Partial<PollSummary> | null;
  unresolved_total: number | string;
  created_at: string | Date;
}

const REPO_COLUMNS = `id, workspace_id, owner, name, status, last_error, stars_cursor, forks_cursor,
  issues_cursor, repo_etag, issues_etag, rate_limited_until, next_poll_at, last_polled_at,
  last_summary_json, unresolved_total, created_at`;

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toRepository(row: RepoRow): WatchedRepository {
  const stored = row.last_summary_json ?? {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    name: row.name,
    fullName: `${row.owner}/${row.name}`,
    url: `https://github.com/${row.owner}/${row.name}`,
    status: row.status as WatchedRepositoryStatus,
    lastError: row.last_error,
    starsCursor: isoOrNull(row.stars_cursor),
    forksCursor: isoOrNull(row.forks_cursor),
    issuesCursor: isoOrNull(row.issues_cursor),
    repoEtag: row.repo_etag,
    issuesEtag: row.issues_etag,
    rateLimitedUntil: isoOrNull(row.rate_limited_until),
    nextPollAt: new Date(row.next_poll_at).toISOString(),
    lastPolledAt: isoOrNull(row.last_polled_at),
    lastSummary: Object.keys(stored).length > 0 ? { ...emptyPollSummary(), ...stored } : null,
    unresolvedTotal: Number(row.unresolved_total),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function listWatchedRepositories(
  db: Db,
  workspaceId: string
): Promise<WatchedRepository[]> {
  const rows = await db
    .prepare(
      `SELECT ${REPO_COLUMNS} FROM watched_repositories WHERE workspace_id=? ORDER BY created_at ASC, id ASC`
    )
    .all<RepoRow>(workspaceId);
  return rows.map(toRepository);
}

/**
 * Start watching a repository. Idempotent on the name (case-insensitive, as
 * GitHub is): adding one already watched returns it unchanged.
 *
 * The cap check and the insert run under one per-workspace advisory lock, so
 * two simultaneous adds cannot both pass the count and land an eleventh row.
 */
export async function watchRepository(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; fullName: string },
  now: Date = new Date()
): Promise<{ repo: WatchedRepository; created: boolean }> {
  const parsed = parseRepoFullName(input.fullName);
  if (!parsed) {
    throw new GitHubRepoError(
      `'${input.fullName.slice(0, 200)}' is not a GitHub repository. Use owner/name, for example lemoncrow-lab/lemoncrow.`,
      400
    );
  }
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`github-watch\u001f${input.workspaceId}`);
    const existing = await tx
      .prepare(
        `SELECT ${REPO_COLUMNS} FROM watched_repositories
         WHERE workspace_id=? AND LOWER(owner)=LOWER(?) AND LOWER(name)=LOWER(?)`
      )
      .get<RepoRow>(input.workspaceId, parsed.owner, parsed.name);
    if (existing) return { repo: toRepository(existing), created: false };

    const counted = await tx
      .prepare('SELECT COUNT(*)::int AS count FROM watched_repositories WHERE workspace_id=?')
      .get<{ count: number }>(input.workspaceId);
    if ((counted?.count ?? 0) >= MAX_WATCHED_REPOSITORIES) {
      throw new GitHubRepoError(
        `A workspace can watch at most ${MAX_WATCHED_REPOSITORIES} repositories. Remove one first.`,
        409
      );
    }

    const iso = now.toISOString();
    const row = await tx
      .prepare(
        `INSERT INTO watched_repositories
           (id, workspace_id, owner, name, created_by_user_id, status, next_poll_at, created_at, updated_at)
         VALUES (?,?,?,?,?,'pending',?::timestamptz,?::timestamptz,?::timestamptz)
         RETURNING ${REPO_COLUMNS}`
      )
      .get<RepoRow>(
        id('ghrepo'),
        input.workspaceId,
        parsed.owner,
        parsed.name,
        input.actorUserId,
        iso,
        iso,
        iso
      );
    if (!row) throw new Error('Watching the repository returned no row');
    return { repo: toRepository(row), created: true };
  });
}

/** Stop watching. Signals and accounts already written stay: they are evidence. */
export async function unwatchRepository(
  db: Db,
  workspaceId: string,
  repoId: string
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM watched_repositories WHERE workspace_id=? AND id=?')
    .run(workspaceId, repoId);
  return result.changes > 0;
}

export type GitHubConnectionState = 'connected' | 'needs_reauth' | 'not_connected';

export interface GitHubConnection {
  state: GitHubConnectionState;
  localConnectionId: string | null;
  providerConfigKey: string;
  externalConnectionId: string | null;
  lastError: string | null;
}

/**
 * This workspace's GitHub connection, as the poller and the Setup card see it.
 * The connection row decides the workspace; nothing GitHub returns ever does.
 * Demo rows and disconnected rows do not count as a connection.
 */
export async function readGitHubConnection(db: Db, workspaceId: string): Promise<GitHubConnection> {
  const providerConfigKey = githubProviderConfigKey();
  const row = await db
    .prepare(
      `SELECT id, external_connection_id, status, last_error
       FROM connections
       WHERE workspace_id=? AND provider_config_key=? AND is_demo=0 AND status <> 'disconnected'
       ORDER BY (status = 'connected') DESC, updated_at DESC, id DESC
       LIMIT 1`
    )
    .get<{
      id: string;
      external_connection_id: string;
      status: string;
      last_error: string | null;
    }>(workspaceId, providerConfigKey);
  if (!row) {
    return {
      state: 'not_connected',
      localConnectionId: null,
      providerConfigKey,
      externalConnectionId: null,
      lastError: null
    };
  }
  const connected = row.status === 'connected';
  return {
    state: connected ? 'connected' : 'needs_reauth',
    localConnectionId: row.id,
    providerConfigKey,
    externalConnectionId: row.external_connection_id,
    lastError: connected ? null : row.last_error
  };
}

/** GitHub refused the stored authorization. The existing Reconnect button fixes it. */
export async function markConnectionNeedsReauth(
  db: Db,
  workspaceId: string,
  localConnectionId: string,
  message: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET status='needs_reauth', last_error=?, updated_at=?::timestamptz
       WHERE id=? AND workspace_id=?`
    )
    .run(message.slice(0, 500), now.toISOString(), localConnectionId, workspaceId);
}

/** One indexed read, so the automation cycle can skip the poller for almost every workspace. */
export async function hasDueRepositories(db: Db, workspaceId: string, now: Date): Promise<boolean> {
  const iso = now.toISOString();
  const row = await db
    .prepare(
      `SELECT id FROM watched_repositories
       WHERE workspace_id=? AND next_poll_at <= ?::timestamptz
         AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
       LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, iso, iso);
  return row !== undefined;
}

/**
 * Take the due repositories for one run. Row locks with SKIP LOCKED plus a
 * lease, the house claim pattern: two workers never poll the same repository,
 * and a worker that dies mid-run frees it after POLL_LEASE_MINUTES.
 */
export async function claimDueRepositories(
  db: Db,
  workspaceId: string,
  now: Date,
  limit: number
): Promise<WatchedRepository[]> {
  const iso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + POLL_LEASE_MINUTES * 60_000).toISOString();
  const rows = await db
    .prepare(
      `UPDATE watched_repositories SET lease_until=?::timestamptz
       WHERE workspace_id=? AND id IN (
         SELECT id FROM watched_repositories
         WHERE workspace_id=? AND next_poll_at <= ?::timestamptz
           AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
         ORDER BY next_poll_at ASC, id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${REPO_COLUMNS}`
    )
    .all<RepoRow>(leaseUntil, workspaceId, workspaceId, iso, iso, Math.max(1, Math.trunc(limit)));
  return rows
    .map(toRepository)
    .sort(
      (left, right) =>
        left.nextPollAt.localeCompare(right.nextPollAt) || left.id.localeCompare(right.id)
    );
}

export interface RepositoryPatch {
  status?: WatchedRepositoryStatus;
  lastError?: string | null;
  starsCursor?: Date;
  forksCursor?: Date;
  issuesCursor?: Date;
  repoEtag?: string | null;
  issuesEtag?: string | null;
  rateLimitedUntil?: Date | null;
  nextPollAt?: Date;
  lastPolledAt?: Date;
  lastSummary?: PollSummary;
  addUnresolved?: number;
}

/** Write what a run learned about one repository, and release its lease. */
export async function updateRepository(
  db: Db,
  workspaceId: string,
  repoId: string,
  patch: RepositoryPatch,
  now: Date = new Date()
): Promise<void> {
  const sets: string[] = ['updated_at=?::timestamptz', 'lease_until=NULL'];
  const params: unknown[] = [now.toISOString()];
  const put = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column}=?${cast}`);
    params.push(value);
  };
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.lastError !== undefined) put('last_error', patch.lastError);
  if (patch.starsCursor) put('stars_cursor', patch.starsCursor.toISOString(), '::timestamptz');
  if (patch.forksCursor) put('forks_cursor', patch.forksCursor.toISOString(), '::timestamptz');
  if (patch.issuesCursor) put('issues_cursor', patch.issuesCursor.toISOString(), '::timestamptz');
  if (patch.repoEtag !== undefined) put('repo_etag', patch.repoEtag);
  if (patch.issuesEtag !== undefined) put('issues_etag', patch.issuesEtag);
  if (patch.rateLimitedUntil !== undefined) {
    put(
      'rate_limited_until',
      patch.rateLimitedUntil ? patch.rateLimitedUntil.toISOString() : null,
      '::timestamptz'
    );
  }
  if (patch.nextPollAt) put('next_poll_at', patch.nextPollAt.toISOString(), '::timestamptz');
  if (patch.lastPolledAt) put('last_polled_at', patch.lastPolledAt.toISOString(), '::timestamptz');
  if (patch.lastSummary) put('last_summary_json', JSON.stringify(patch.lastSummary), '::jsonb');
  if (patch.addUnresolved) {
    sets.push('unresolved_total = unresolved_total + ?::int');
    params.push(patch.addUnresolved);
  }
  params.push(repoId, workspaceId);
  await db
    .prepare(`UPDATE watched_repositories SET ${sets.join(', ')} WHERE id=? AND workspace_id=?`)
    .run(...params);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/repos.test.ts`
Expected: PASS (8 tests). Migration 132 is applied automatically by `openDatabase`.

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add migrations/132_github_repo_signals.sql src/server/github/repos.ts src/server/github/repos.test.ts
git commit -m "feat(github): watched repositories table and store" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 4: Nango transport, rate-limit budget and public-data resolution

**Files:**

- Create: `src/server/github/transport.ts`
- Create: `src/server/github/public-domains.ts`
- Create: `src/server/github/resolve.ts`
- Test: `src/server/github/transport.test.ts`
- Test: `src/server/github/resolve.test.ts`

**Interfaces:**

- Consumes: `getNango(): Nango` from `src/server/integration-service.ts`; `normalizeAccountDomain(raw: string): string | null` from `src/server/accounts/store.ts`.
- Produces:
  - `src/server/github/transport.ts`: `interface GitHubRequest { params?: Record<string, string | number>; headers?: Record<string, string> }`; `interface GitHubResponse { status: number; data: unknown; headers: Record<string, string> }` (header names lower-cased); `interface GitHubTransport { get(endpoint: string, request?: GitHubRequest): Promise<GitHubResponse> }` (never throws on an HTTP status); `const GITHUB_ACCEPT = 'application/vnd.github+json'`, `const GITHUB_STAR_ACCEPT = 'application/vnd.github.star+json'`, `const GITHUB_API_VERSION = '2022-11-28'`, `const RATE_LIMIT_RESERVE = 50`; `nangoGitHubTransport(connection: { providerConfigKey: string; connectionId: string }, nango?: NangoProxyLike): GitHubTransport`; `rateLimitFrom(headers: Record<string, string>, now: Date): { remaining: number | null; resetAt: Date | null }`; `class GitHubClient { constructor(transport: GitHubTransport, now: Date); get(endpoint: string, request?: GitHubRequest): Promise<GitHubResponse> }` (returns only 2xx and 304); error classes `GitHubRateLimitedError { resetAt: Date }`, `GitHubConnectionRevokedError`, `GitHubNotFoundError { endpoint: string }`, `GitHubRequestError { status: number }`.
  - `src/server/github/public-domains.ts`: `isFreemailDomain(domain: string): boolean`, `isPersonalPlatformHost(host: string): boolean`.
  - `src/server/github/resolve.ts`: `type ResolvedVia = 'org_website' | 'email_domain' | 'blog'`; `interface DomainCandidate { domain: string; via: ResolvedVia; name: string | null }`; `interface ResolvedActor { login: string; profileUrl: string; type: 'User' | 'Organization' | 'Bot'; candidates: DomainCandidate[] }`; `companyDomainFromUrl(raw: unknown): string | null`; `companyDomainFromEmail(raw: unknown): string | null`; `orgHandleFromCompany(raw: unknown): string | null`; `resolveGitHubActor(client: GitHubClient, login: string): Promise<ResolvedActor | null>` (null when the account no longer exists).

- [ ] **Step 1: Write the failing tests**

Create `src/server/github/transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_API_VERSION,
  GitHubClient,
  GitHubConnectionRevokedError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubRequestError,
  RATE_LIMIT_RESERVE,
  nangoGitHubTransport,
  rateLimitFrom,
  type GitHubResponse,
  type GitHubTransport
} from './transport.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const RESET_EPOCH = Math.floor(Date.parse('2026-10-06T12:40:00.000Z') / 1000);

function scripted(...responses: GitHubResponse[]): GitHubTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(endpoint: string) {
      calls.push(endpoint);
      const next = responses.shift();
      if (!next) throw new Error('no scripted response left');
      return next;
    }
  };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('nangoGitHubTransport', () => {
  it('asks Nango for the versioned GitHub API, with the caller headers and no Nango-side retries', async () => {
    const get = vi.fn(async (_config: Record<string, unknown>) => ({
      status: 200,
      data: [{ id: 1 }],
      headers: { ETag: '"abc"', 'X-RateLimit-Remaining': '4999' }
    }));
    const transport = nangoGitHubTransport(
      { providerConfigKey: 'trevra-github', connectionId: 'conn-1' },
      { get }
    );
    const response = await transport.get('/repos/lemoncrow-lab/lemoncrow/stargazers', {
      params: { per_page: 100, page: 1 },
      headers: { Accept: 'application/vnd.github.star+json' }
    });
    expect(response).toEqual({
      status: 200,
      data: [{ id: 1 }],
      headers: { etag: '"abc"', 'x-ratelimit-remaining': '4999' }
    });
    expect(get).toHaveBeenCalledWith({
      endpoint: '/repos/lemoncrow-lab/lemoncrow/stargazers',
      providerConfigKey: 'trevra-github',
      connectionId: 'conn-1',
      params: { per_page: 100, page: 1 },
      headers: {
        Accept: 'application/vnd.github.star+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      retries: 0
    });
  });

  it('returns a non-2xx answer instead of throwing it, and rethrows a network failure', async () => {
    const notModified = Object.assign(new Error('Request failed with status code 304'), {
      response: { status: 304, data: '', headers: { etag: '"abc"' } }
    });
    const transport = nangoGitHubTransport(
      { providerConfigKey: 'k', connectionId: 'c' },
      {
        get: vi.fn(async (_config: Record<string, unknown>) => {
          throw notModified;
        })
      }
    );
    await expect(transport.get('/repos/a/b')).resolves.toEqual({
      status: 304,
      data: '',
      headers: { etag: '"abc"' }
    });

    const offline = nangoGitHubTransport(
      { providerConfigKey: 'k', connectionId: 'c' },
      {
        get: vi.fn(async (_config: Record<string, unknown>) => {
          throw new Error('ECONNRESET');
        })
      }
    );
    await expect(offline.get('/repos/a/b')).rejects.toThrow('ECONNRESET');
  });
});

describe('rateLimitFrom', () => {
  it('prefers retry-after, then the reset epoch, and says null when GitHub said nothing', () => {
    expect(rateLimitFrom({ 'retry-after': '120', 'x-ratelimit-remaining': '0' }, NOW)).toEqual({
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 120_000)
    });
    expect(
      rateLimitFrom(
        { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(RESET_EPOCH) },
        NOW
      )
    ).toEqual({ remaining: 12, resetAt: new Date(RESET_EPOCH * 1000) });
    expect(rateLimitFrom({}, NOW)).toEqual({ remaining: null, resetAt: null });
  });
});

describe('GitHubClient', () => {
  it('stops before the budget runs out and names the reset time', async () => {
    const transport = scripted({
      status: 200,
      data: {},
      headers: {
        'x-ratelimit-remaining': String(RATE_LIMIT_RESERVE - 1),
        'x-ratelimit-reset': String(RESET_EPOCH)
      }
    });
    const client = new GitHubClient(transport, NOW);
    await client.get('/repos/a/b');
    const error = await failureOf(client.get('/repos/a/b/stargazers'));
    expect(error).toBeInstanceOf(GitHubRateLimitedError);
    expect((error as GitHubRateLimitedError).resetAt.toISOString()).toBe(
      new Date(RESET_EPOCH * 1000).toISOString()
    );
    expect(transport.calls).toEqual(['/repos/a/b']);
  });

  it('reads an exhausted primary limit, a secondary limit and a 429 as rate limiting', async () => {
    const primary = new GitHubClient(
      scripted({
        status: 403,
        data: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
      }),
      NOW
    );
    expect(await failureOf(primary.get('/users/maya'))).toBeInstanceOf(GitHubRateLimitedError);

    const secondary = new GitHubClient(
      scripted({
        status: 403,
        data: { message: 'secondary rate limit' },
        headers: { 'retry-after': '120' }
      }),
      NOW
    );
    const secondaryError = (await failureOf(
      secondary.get('/users/maya')
    )) as GitHubRateLimitedError;
    expect(secondaryError.resetAt.toISOString()).toBe(
      new Date(NOW.getTime() + 120_000).toISOString()
    );

    const tooMany = new GitHubClient(scripted({ status: 429, data: {}, headers: {} }), NOW);
    const tooManyError = (await failureOf(tooMany.get('/users/maya'))) as GitHubRateLimitedError;
    expect(tooManyError.resetAt.toISOString()).toBe(
      new Date(NOW.getTime() + 3_600_000).toISOString()
    );
  });

  it('treats a 401 or a Nango authorization failure as a revoked connection, not as an empty answer', async () => {
    const unauthorized = new GitHubClient(
      scripted({ status: 401, data: { message: 'Bad credentials' }, headers: {} }),
      NOW
    );
    expect(await failureOf(unauthorized.get('/repos/a/b'))).toBeInstanceOf(
      GitHubConnectionRevokedError
    );
    const nangoRefused = new GitHubClient(
      scripted({
        status: 404,
        data: { error: { code: 'unknown_connection', message: 'No connection' } },
        headers: {}
      }),
      NOW
    );
    expect(await failureOf(nangoRefused.get('/repos/a/b'))).toBeInstanceOf(
      GitHubConnectionRevokedError
    );
  });

  it('separates a missing resource from any other failure, and lets a 304 through', async () => {
    const missing = (await failureOf(
      new GitHubClient(
        scripted({ status: 404, data: { message: 'Not Found' }, headers: {} }),
        NOW
      ).get('/repos/a/b')
    )) as GitHubNotFoundError;
    expect(missing).toBeInstanceOf(GitHubNotFoundError);
    expect(missing.endpoint).toBe('/repos/a/b');

    expect(
      await failureOf(
        new GitHubClient(scripted({ status: 502, data: {}, headers: {} }), NOW).get('/repos/a/b')
      )
    ).toBeInstanceOf(GitHubRequestError);

    await expect(
      new GitHubClient(scripted({ status: 304, data: '', headers: {} }), NOW).get('/repos/a/b')
    ).resolves.toMatchObject({ status: 304 });
  });
});
```

Create `src/server/github/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isFreemailDomain, isPersonalPlatformHost } from './public-domains.js';
import {
  companyDomainFromEmail,
  companyDomainFromUrl,
  orgHandleFromCompany,
  resolveGitHubActor
} from './resolve.js';
import { GitHubClient, type GitHubTransport } from './transport.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

function github(routes: Record<string, unknown>): GitHubTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(endpoint: string) {
      calls.push(endpoint);
      return endpoint in routes
        ? { status: 200, data: routes[endpoint], headers: {} }
        : { status: 404, data: { message: 'Not Found' }, headers: {} };
    }
  };
}

const client = (transport: GitHubTransport) => new GitHubClient(transport, NOW);

describe('public domain rules', () => {
  it('never treats a mailbox provider or a personal publishing platform as a company', () => {
    for (const domain of [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'proton.me',
      'icloud.com',
      'users.noreply.github.com'
    ]) {
      expect(isFreemailDomain(domain)).toBe(true);
    }
    expect(isFreemailDomain('buyer.io')).toBe(false);
    for (const host of [
      'jane.github.io',
      'github.com',
      'medium.com',
      'jane.substack.com',
      'dev.to',
      'linktr.ee',
      'jane.vercel.app'
    ]) {
      expect(isPersonalPlatformHost(host)).toBe(true);
    }
    expect(isPersonalPlatformHost('acmegithub.io')).toBe(false);
  });

  it('reads a company domain out of a URL or an email and nothing else', () => {
    expect(companyDomainFromUrl('https://www.Buyer.io/about')).toBe('buyer.io');
    expect(companyDomainFromUrl('buyer.io')).toBe('buyer.io');
    expect(companyDomainFromUrl('https://medium.com/@maya')).toBeNull();
    expect(companyDomainFromUrl('http://localhost:3000')).toBeNull();
    expect(companyDomainFromUrl('')).toBeNull();
    expect(companyDomainFromUrl(null)).toBeNull();
    expect(companyDomainFromEmail('sam@newco.dev')).toBe('newco.dev');
    expect(companyDomainFromEmail('lee@gmail.com')).toBeNull();
    expect(companyDomainFromEmail('not-an-email')).toBeNull();
  });

  it('reads an organization handle only from an @mention in the company field', () => {
    expect(orgHandleFromCompany('@lemoncrow-lab')).toBe('lemoncrow-lab');
    expect(orgHandleFromCompany(' @buyerco, ex-@oldco')).toBe('buyerco');
    expect(orgHandleFromCompany('Buyer Co')).toBeNull();
    expect(orgHandleFromCompany('@')).toBeNull();
    expect(orgHandleFromCompany(null)).toBeNull();
  });
});

describe('resolveGitHubActor', () => {
  it('prefers the organization website, then the public email domain, then the blog', async () => {
    const transport = github({
      '/users/maya': {
        login: 'maya',
        type: 'User',
        html_url: 'https://github.com/maya',
        company: '@buyerco',
        email: 'maya@buyer-mail.com',
        blog: 'maya.dev'
      },
      '/orgs/buyerco': { login: 'buyerco', name: 'Buyer Co', blog: 'https://www.buyer.io' }
    });
    expect(await resolveGitHubActor(client(transport), 'maya')).toEqual({
      login: 'maya',
      profileUrl: 'https://github.com/maya',
      type: 'User',
      candidates: [
        { domain: 'buyer.io', via: 'org_website', name: 'Buyer Co' },
        { domain: 'buyer-mail.com', via: 'email_domain', name: null },
        { domain: 'maya.dev', via: 'blog', name: null }
      ]
    });
  });

  it('invents nothing from a plain-text company, a freemail address or a platform blog', async () => {
    const transport = github({
      '/users/lee': {
        login: 'lee',
        type: 'User',
        html_url: 'https://github.com/lee',
        company: 'Freelance Consulting',
        email: 'lee@gmail.com',
        blog: 'https://lee.github.io'
      }
    });
    expect(await resolveGitHubActor(client(transport), 'lee')).toMatchObject({
      login: 'lee',
      candidates: []
    });
    expect(transport.calls).toEqual(['/users/lee']);
  });

  it('falls through an @handle that is a person or an organization without a website', async () => {
    const noSite = github({
      '/users/kim': {
        login: 'kim',
        type: 'User',
        html_url: 'https://github.com/kim',
        company: '@nosite',
        email: 'kim@kimco.dev',
        blog: null
      },
      '/orgs/nosite': { login: 'nosite', name: 'No Site', blog: '' }
    });
    expect((await resolveGitHubActor(client(noSite), 'kim'))?.candidates).toEqual([
      { domain: 'kimco.dev', via: 'email_domain', name: null }
    ]);

    const person = github({
      '/users/ann': {
        login: 'ann',
        type: 'User',
        html_url: 'https://github.com/ann',
        company: '@bob',
        email: null,
        blog: null
      }
    });
    expect((await resolveGitHubActor(client(person), 'ann'))?.candidates).toEqual([]);
  });

  it('resolves an organization that forked the repository through its own website', async () => {
    const transport = github({
      '/users/buyerco': {
        login: 'buyerco',
        type: 'Organization',
        html_url: 'https://github.com/buyerco',
        name: 'Buyer Co',
        blog: 'buyer.io'
      }
    });
    expect((await resolveGitHubActor(client(transport), 'buyerco'))?.candidates).toEqual([
      { domain: 'buyer.io', via: 'org_website', name: 'Buyer Co' }
    ]);
  });

  it('returns null for a deleted account and no company for a bot', async () => {
    expect(await resolveGitHubActor(client(github({})), 'ghost')).toBeNull();
    const bot = github({
      '/users/renovate': {
        login: 'renovate',
        type: 'Bot',
        html_url: 'https://github.com/apps/renovate',
        blog: 'https://renovatebot.com'
      }
    });
    expect((await resolveGitHubActor(client(bot), 'renovate'))?.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/transport.test.ts src/server/github/resolve.test.ts`
Expected: FAIL with `Failed to load url ./transport.js` and `Failed to load url ./public-domains.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/github/transport.ts`:

```ts
import { getNango } from '../integration-service.js';

/**
 * GitHub over the Nango proxy. Nango holds the token and refreshes it; this
 * file only shapes requests and reads GitHub's answers.
 *
 * NO NANGO-SIDE RETRIES. With `retries` above zero Nango backs off on a 429
 * and honours GitHub's reset header -- up to ten minutes per call -- which
 * would hold the workspace's automation lease for the duration. A rate limit
 * is a schedule, not an error: `GitHubClient` turns it into a reset time and
 * the poller simply comes back then. That is not a rebuilt rate limiter; it
 * reads the limit GitHub states and waits for it.
 */

export interface GitHubRequest {
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
}

export interface GitHubResponse {
  status: number;
  data: unknown;
  /** Header names lower-cased. */
  headers: Record<string, string>;
}

/** Never throws on an HTTP status: a 304, a 404 or a 403 is an answer, not an exception. */
export interface GitHubTransport {
  get(endpoint: string, request?: GitHubRequest): Promise<GitHubResponse>;
}

export const GITHUB_ACCEPT = 'application/vnd.github+json';
/** Adds `starred_at` to each stargazer. */
export const GITHUB_STAR_ACCEPT = 'application/vnd.github.star+json';
export const GITHUB_API_VERSION = '2022-11-28';
/** Requests left untouched in the hour, so a poll never drains the founder's whole budget. */
export const RATE_LIMIT_RESERVE = 50;
const DEFAULT_RESET_MS = 60 * 60_000;

/** The slice of `Nango` this file uses; tests pass a fake. */
export interface NangoProxyLike {
  get(config: {
    endpoint: string;
    providerConfigKey: string;
    connectionId: string;
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
    retries?: number;
  }): Promise<{ status: number; data: unknown; headers: unknown }>;
}

export function lowerCaseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

export function nangoGitHubTransport(
  connection: { providerConfigKey: string; connectionId: string },
  nango: NangoProxyLike = getNango()
): GitHubTransport {
  return {
    async get(endpoint: string, request: GitHubRequest = {}): Promise<GitHubResponse> {
      try {
        const response = await nango.get({
          endpoint,
          providerConfigKey: connection.providerConfigKey,
          connectionId: connection.connectionId,
          params: request.params,
          headers: {
            Accept: GITHUB_ACCEPT,
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            ...request.headers
          },
          retries: 0
        });
        return {
          status: response.status,
          data: response.data,
          headers: lowerCaseHeaders(response.headers)
        };
      } catch (error) {
        // The SDK is axios underneath: any non-2xx (304 included) rejects with
        // the answer attached. Hand the answer back; rethrow only when there
        // was no answer at all.
        const response = (
          error as { response?: { status?: unknown; data?: unknown; headers?: unknown } }
        ).response;
        if (response && typeof response.status === 'number') {
          return {
            status: response.status,
            data: response.data,
            headers: lowerCaseHeaders(response.headers)
          };
        }
        throw error;
      }
    }
  };
}

export class GitHubRateLimitedError extends Error {
  constructor(readonly resetAt: Date) {
    super(`GitHub rate limit reached; polling resumes at ${resetAt.toISOString()}`);
    this.name = 'GitHubRateLimitedError';
  }
}

export class GitHubConnectionRevokedError extends Error {
  constructor(message = 'GitHub rejected the stored authorization. Reconnect GitHub.') {
    super(message);
    this.name = 'GitHubConnectionRevokedError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(readonly endpoint: string) {
    super(`GitHub has nothing at ${endpoint}`);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    endpoint: string
  ) {
    super(`GitHub answered ${status} for ${endpoint}`);
    this.name = 'GitHubRequestError';
  }
}

function headerNumber(headers: Record<string, string>, name: string): number | null {
  const raw = headers[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** What GitHub said about the budget: `retry-after` wins, then the reset epoch. */
export function rateLimitFrom(
  headers: Record<string, string>,
  now: Date
): { remaining: number | null; resetAt: Date | null } {
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const retryAfter = headerNumber(headers, 'retry-after');
  const resetEpoch = headerNumber(headers, 'x-ratelimit-reset');
  const resetAt =
    retryAfter !== null
      ? new Date(now.getTime() + retryAfter * 1000)
      : resetEpoch !== null
        ? new Date(resetEpoch * 1000)
        : null;
  return { remaining, resetAt };
}

/** Nango's own error body: `{ error: { code, message } }`. GitHub never answers in that shape. */
function nangoErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * One poll run's view of GitHub. Tracks the rate-limit budget across calls and
 * turns every non-answer into a typed error the poller can act on.
 */
export class GitHubClient {
  private remaining: number | null = null;
  private resetAt: Date | null = null;

  constructor(
    private readonly transport: GitHubTransport,
    private readonly now: Date
  ) {}

  async get(endpoint: string, request: GitHubRequest = {}): Promise<GitHubResponse> {
    if (this.remaining !== null && this.remaining < RATE_LIMIT_RESERVE) {
      throw new GitHubRateLimitedError(this.resetAt ?? this.fallbackReset());
    }
    const response = await this.transport.get(endpoint, request);
    const limit = rateLimitFrom(response.headers, this.now);
    if (limit.remaining !== null) {
      this.remaining = limit.remaining;
      this.resetAt = limit.resetAt;
    }

    const nangoCode =
      response.status >= 400 && response.status < 500 ? nangoErrorCode(response.data) : null;
    if (nangoCode) {
      throw new GitHubConnectionRevokedError(
        `Nango could not use the GitHub connection (${nangoCode}). Reconnect GitHub.`
      );
    }
    if (response.status === 401) throw new GitHubConnectionRevokedError();
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (limit.remaining === 0 || response.headers['retry-after'] !== undefined))
    ) {
      throw new GitHubRateLimitedError(limit.resetAt ?? this.fallbackReset());
    }
    if (response.status === 404) throw new GitHubNotFoundError(endpoint);
    if (response.status === 304 || (response.status >= 200 && response.status < 300)) {
      return response;
    }
    throw new GitHubRequestError(response.status, endpoint);
  }

  private fallbackReset(): Date {
    return new Date(this.now.getTime() + DEFAULT_RESET_MS);
  }
}
```

Create `src/server/github/public-domains.ts`:

```ts
/**
 * Domains that say nothing about which company a person works for.
 *
 * A GitHub profile's email or blog is only evidence of a COMPANY when the
 * domain belongs to one. A mailbox provider or a personal publishing platform
 * would merge every unrelated person who uses it into one fake "account", so
 * both lists are refusals, matched exactly (freemail) or by suffix (platforms).
 */

const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.de',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'live.com',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.fr',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'web.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'tuta.io',
  'duck.com',
  'hushmail.com',
  'posteo.de',
  'mailbox.org',
  'rediffmail.com',
  'naver.com',
  'seznam.cz',
  'orange.fr',
  'free.fr',
  'libero.it',
  't-online.de',
  'btinternet.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'wp.pl',
  'o2.pl',
  'inbox.com',
  'users.noreply.github.com'
]);

const PERSONAL_PLATFORM_SUFFIXES: readonly string[] = [
  'github.com',
  'github.io',
  'githubusercontent.com',
  'gitlab.com',
  'gitlab.io',
  'bitbucket.org',
  'medium.com',
  'substack.com',
  'dev.to',
  'hashnode.dev',
  'hashnode.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'bsky.app',
  'bsky.social',
  'mastodon.social',
  'threads.net',
  'instagram.com',
  'facebook.com',
  'youtube.com',
  'twitch.tv',
  'linktr.ee',
  'about.me',
  'bio.link',
  'carrd.co',
  'read.cv',
  'polywork.com',
  'peerlist.io',
  'keybase.io',
  'gravatar.com',
  'stackoverflow.com',
  'kaggle.com',
  'huggingface.co',
  'sites.google.com',
  'notion.site',
  'notion.so',
  'wordpress.com',
  'blogspot.com',
  'wixsite.com',
  'squarespace.com',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'herokuapp.com',
  'fly.dev',
  'onrender.com',
  'replit.app',
  'repl.co',
  'glitch.me',
  'surge.sh',
  'firebaseapp.com',
  'web.app',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  't.me',
  'discord.gg',
  'discord.com',
  'reddit.com',
  'ko-fi.com',
  'buymeacoffee.com',
  'patreon.com'
];

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

export function isPersonalPlatformHost(host: string): boolean {
  const lowered = host.toLowerCase();
  return PERSONAL_PLATFORM_SUFFIXES.some(
    (suffix) => lowered === suffix || lowered.endsWith(`.${suffix}`)
  );
}
```

Create `src/server/github/resolve.ts`:

```ts
import { normalizeAccountDomain } from '../accounts/store.js';
import { isFreemailDomain, isPersonalPlatformHost } from './public-domains.js';
import { GitHubNotFoundError, type GitHubClient } from './transport.js';

/**
 * Who is behind a GitHub login, in company terms, from PUBLIC data only.
 *
 * Strongest first: an `@org` handle in the profile's company field whose
 * organization lists a website; then the public email's domain; then the
 * profile blog's domain. A plain-text company ("Acme Inc") is never turned
 * into a domain -- guessing `acme.com` from a name is inventing a company.
 * No candidate means unresolved: the person is counted, never stored.
 */

export type ResolvedVia = 'org_website' | 'email_domain' | 'blog';

export interface DomainCandidate {
  domain: string;
  via: ResolvedVia;
  /** The organization's own display name, when GitHub states one. */
  name: string | null;
}

export interface ResolvedActor {
  login: string;
  profileUrl: string;
  type: 'User' | 'Organization' | 'Bot';
  candidates: DomainCandidate[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function companyDomainFromUrl(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const domain = normalizeAccountDomain(value);
  if (!domain) return null;
  if (isFreemailDomain(domain) || isPersonalPlatformHost(domain)) return null;
  return domain;
}

export function companyDomainFromEmail(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return companyDomainFromUrl(value.slice(at + 1));
}

const ORG_HANDLE = /^@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/;

export function orgHandleFromCompany(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const match = ORG_HANDLE.exec(value);
  return match ? match[1] : null;
}

interface ProfileFields {
  login?: unknown;
  html_url?: unknown;
  type?: unknown;
  name?: unknown;
  company?: unknown;
  blog?: unknown;
  email?: unknown;
}

async function readProfile(client: GitHubClient, endpoint: string): Promise<ProfileFields | null> {
  try {
    const response = await client.get(endpoint);
    return response.data && typeof response.data === 'object'
      ? (response.data as ProfileFields)
      : null;
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

export async function resolveGitHubActor(
  client: GitHubClient,
  login: string
): Promise<ResolvedActor | null> {
  const profile = await readProfile(client, `/users/${encodeURIComponent(login)}`);
  if (!profile) return null;
  const actualLogin = text(profile.login) ?? login;
  const profileUrl = text(profile.html_url) ?? `https://github.com/${actualLogin}`;
  const type =
    profile.type === 'Organization' ? 'Organization' : profile.type === 'Bot' ? 'Bot' : 'User';
  const candidates: DomainCandidate[] = [];

  if (type === 'Organization') {
    const domain = companyDomainFromUrl(profile.blog);
    if (domain)
      candidates.push({ domain, via: 'org_website', name: text(profile.name) ?? actualLogin });
  } else if (type === 'User') {
    const handle = orgHandleFromCompany(profile.company);
    if (handle) {
      const org = await readProfile(client, `/orgs/${encodeURIComponent(handle)}`);
      const domain = org ? companyDomainFromUrl(org.blog) : null;
      if (domain && org)
        candidates.push({ domain, via: 'org_website', name: text(org.name) ?? handle });
    }
    const emailDomain = companyDomainFromEmail(profile.email);
    if (emailDomain) candidates.push({ domain: emailDomain, via: 'email_domain', name: null });
    const blogDomain = companyDomainFromUrl(profile.blog);
    if (blogDomain) candidates.push({ domain: blogDomain, via: 'blog', name: null });
  }

  const unique: DomainCandidate[] = [];
  for (const candidate of candidates) {
    if (!unique.some((kept) => kept.domain === candidate.domain)) unique.push(candidate);
  }
  return { login: actualLogin, profileUrl, type, candidates: unique };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/transport.test.ts src/server/github/resolve.test.ts && npm run typecheck`
Expected: PASS, and `tsc --noEmit` exits 0 (this also proves `Nango` from `getNango()` is assignable to `NangoProxyLike`).

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/github/transport.ts src/server/github/public-domains.ts src/server/github/resolve.ts src/server/github/transport.test.ts src/server/github/resolve.test.ts
git commit -m "feat(github): Nango transport, rate-limit budget and public-data resolution" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 5: The poller

**Files:**

- Create: `src/server/github/poll.ts`
- Test: `src/server/github/poll.test.ts`

**Interfaces:**

- Consumes: everything Task 3 and Task 4 produce; `createAccount(db, workspaceId, input: AccountInput, now)` and `rejectedSignalShapes(db, workspaceId)` from `src/server/accounts/store.ts`; `recordSignals(db, workspaceId, accountId, incoming: IncomingSignal[], now): Promise<AccountSignal[]>` from `src/server/accounts/sweep.ts`; `rescoreAccounts(db, workspaceId, accountIds, { rejectedShapes, now })` and `DEFAULT_WINDOW_DAYS` from `src/server/accounts/score.ts`; `getToday(db, workspaceId, now)` from `src/server/today.ts` (test only).
- Produces (from `src/server/github/poll.ts`):
  - Constants `POLL_INTERVAL_MINUTES = 60`, `NOT_CONNECTED_RETRY_MINUTES = 15`, `NOT_FOUND_RETRY_HOURS = 24`, `ERROR_RETRY_MINUTES = 60`, `BACKFILL_DAYS = DEFAULT_WINDOW_DAYS`, `MAX_STAR_PAGES = 3`, `MAX_PROFILE_LOOKUPS_PER_RUN = 40`, `MAX_NEW_ACCOUNTS_PER_RUN = 5`, `MAX_REPOSITORIES_PER_RUN = 10`, `GITHUB_ACCOUNT_TAG = 'github-traction'`.
  - `interface PollDeps { transport?: GitHubTransport; now?: Date }`, `interface PollOptions { maxRepositories?: number }`, `interface WorkspacePollResult { connection: GitHubConnectionState; polled: number; accountIds: string[]; rateLimitedUntil: string | null }`.
  - `pollWorkspaceRepositories(db: Db, workspaceId: string, deps?: PollDeps, opts?: PollOptions): Promise<WorkspacePollResult>` -- never throws for GitHub conditions; records them on the repository row.

- [ ] **Step 1: Write the failing test**

Create `src/server/github/poll.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { getToday } from '../today.js';
import {
  MAX_NEW_ACCOUNTS_PER_RUN,
  MAX_STAR_PAGES,
  NOT_FOUND_RETRY_HOURS,
  POLL_INTERVAL_MINUTES,
  pollWorkspaceRepositories
} from './poll.js';
import { listWatchedRepositories, watchRepository, type WatchedRepository } from './repos.js';
import type { GitHubRequest, GitHubResponse, GitHubTransport } from './transport.js';

/**
 * NO NETWORK, NO CLOCK. GitHub is a table of hand-written answers keyed by
 * endpoint, and every `now` is injected. What is proved here is the phase's
 * promise: real companies from public data only, one signal per real event,
 * rejected companies stay rejected, and a revoked token or an exhausted rate
 * limit is a recorded state rather than a quiet zero.
 */

let db: Db;

const WORKSPACE_ID = 'ws_github_poll_test';
const OTHER_WORKSPACE_ID = 'ws_github_poll_other';
const REPO = 'lemoncrow-lab/lemoncrow';
const REPO_PATH = '/repos/lemoncrow-lab/lemoncrow';
const T0 = new Date('2026-10-06T12:00:00.000Z');
const HOUR = 3_600_000;
const RESET_EPOCH = Math.floor(Date.parse('2026-10-06T13:00:00.000Z') / 1000);

interface Call {
  endpoint: string;
  params: Record<string, string | number>;
  headers: Record<string, string>;
}
type Handler = (call: Call) => GitHubResponse;

function ok(data: unknown, headers: Record<string, string> = {}): GitHubResponse {
  return {
    status: 200,
    data,
    headers: {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(RESET_EPOCH),
      ...headers
    }
  };
}

function fakeGitHub(routes: Record<string, Handler>): GitHubTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get(endpoint: string, request: GitHubRequest = {}) {
      const call = { endpoint, params: request.params ?? {}, headers: request.headers ?? {} };
      calls.push(call);
      const handler = routes[endpoint];
      return handler ? handler(call) : { status: 404, data: { message: 'Not Found' }, headers: {} };
    }
  };
}

const user = (login: string, type = 'User') => ({
  login,
  type,
  html_url: `https://github.com/${login}`
});
const star = (login: string, at: string, type = 'User') => ({
  starred_at: at,
  user: user(login, type)
});

/**
 * The LemonCrow repository and the people around it:
 * - maya works at @buyerco, whose org site is buyer.io (an existing account);
 * - sam has a public company email at newco.dev (no account yet);
 * - lee has only a gmail address, a github.io blog and a plain-text company;
 * - rejectco is an organization the founder already marked not a fit;
 * - old-timer starred long before the backfill window.
 */
function lemoncrowRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [REPO_PATH]: () =>
      ok({ full_name: REPO, stargazers_count: 4, forks_count: 1 }, { etag: '"repo-v1"' }),
    [`${REPO_PATH}/stargazers`]: () =>
      ok([
        star('old-timer', '2026-07-01T00:00:00Z'),
        star('maya', '2026-10-05T09:00:00Z'),
        star('sam', '2026-10-05T10:00:00Z'),
        star('lee', '2026-10-05T11:00:00Z')
      ]),
    [`${REPO_PATH}/forks`]: () =>
      ok([{ created_at: '2026-10-05T12:00:00Z', owner: user('rejectco', 'Organization') }]),
    [`${REPO_PATH}/issues`]: () =>
      ok(
        [
          {
            number: 10,
            html_url: `https://github.com/${REPO}/issues/10`,
            created_at: '2026-10-05T13:30:00Z',
            author_association: 'NONE',
            user: user('dependabot[bot]', 'Bot')
          },
          {
            number: 9,
            html_url: `https://github.com/${REPO}/pull/9`,
            created_at: '2026-10-05T13:20:00Z',
            author_association: 'NONE',
            user: user('sam'),
            pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/9` }
          },
          {
            number: 8,
            html_url: `https://github.com/${REPO}/issues/8`,
            created_at: '2026-10-05T13:10:00Z',
            author_association: 'MEMBER',
            user: user('teammate')
          },
          {
            number: 7,
            html_url: `https://github.com/${REPO}/issues/7`,
            created_at: '2026-10-05T13:00:00Z',
            author_association: 'NONE',
            user: user('maya')
          }
        ],
        { etag: '"issues-v1"' }
      ),
    '/users/maya': () =>
      ok({ ...user('maya'), name: 'Maya', company: '@buyerco', blog: '', email: null }),
    '/orgs/buyerco': () =>
      ok({
        login: 'buyerco',
        name: 'Buyer Co',
        blog: 'https://www.buyer.io',
        html_url: 'https://github.com/buyerco'
      }),
    '/users/sam': () =>
      ok({ ...user('sam'), name: 'Sam', company: 'NewCo', blog: '', email: 'sam@newco.dev' }),
    '/users/lee': () =>
      ok({
        ...user('lee'),
        name: 'Lee',
        company: 'Freelance',
        blog: 'https://lee.github.io',
        email: 'lee@gmail.com'
      }),
    '/users/rejectco': () =>
      ok({ ...user('rejectco', 'Organization'), name: 'Reject Co', blog: 'https://rejectco.com' }),
    ...overrides
  };
}

async function resetWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, T0.toISOString());
}

async function connectGitHub(workspaceId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'github','trevra-github',?,'GitHub','connected',0,?,?)`
    )
    .run(id('conn'), workspaceId, `gh-${workspaceId}`, T0.toISOString(), T0.toISOString());
}

async function makeAccount(workspaceId: string, domain: string, status: string): Promise<string> {
  const accountId = id('acc');
  await db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
       VALUES (?,?,?,?,'csv',?::text[],?,?,?)`
    )
    .run(accountId, workspaceId, domain, domain, [], status, T0.toISOString(), T0.toISOString());
  return accountId;
}

async function accountByDomain(workspaceId: string, domain: string) {
  return db
    .prepare(
      'SELECT id, name, status, source, tags FROM accounts WHERE workspace_id=? AND LOWER(domain)=?'
    )
    .get<{ id: string; name: string; status: string; source: string; tags: string[] }>(
      workspaceId,
      domain
    );
}

async function signalRows(workspaceId: string, accountId: string) {
  return db
    .prepare(
      `SELECT kind, detail, evidence_url FROM account_signals
       WHERE workspace_id=? AND account_id=? ORDER BY observed_at ASC, id ASC`
    )
    .all<{ kind: string; detail: string; evidence_url: string }>(workspaceId, accountId);
}

async function repoRow(workspaceId = WORKSPACE_ID): Promise<WatchedRepository> {
  const [repo] = await listWatchedRepositories(db, workspaceId);
  return repo;
}

function poll(transport: GitHubTransport, now = T0, workspaceId = WORKSPACE_ID) {
  return pollWorkspaceRepositories(db, workspaceId, { transport, now });
}

beforeEach(async () => {
  delete process.env.NANGO_GITHUB_INTEGRATION;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetWorkspace(WORKSPACE_ID);
  await resetWorkspace(OTHER_WORKSPACE_ID);
  await connectGitHub(WORKSPACE_ID);
  await makeAccount(WORKSPACE_ID, 'buyer.io', 'active');
  await makeAccount(WORKSPACE_ID, 'rejectco.com', 'not_a_fit');
  await watchRepository(
    db,
    { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: REPO },
    new Date(T0.getTime() - 60_000)
  );
});

afterEach(async () => {
  await db
    .prepare('DELETE FROM workspaces WHERE id = ANY(?::text[])')
    .run([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
  await db.close();
});

describe('pollWorkspaceRepositories', () => {
  it('attaches a star to an existing company, creates an account for a new one, and only counts a person it cannot trace', async () => {
    const github = fakeGitHub(lemoncrowRoutes());
    const result = await poll(github);
    expect(result).toMatchObject({ connection: 'connected', polled: 1, rateLimitedUntil: null });

    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toEqual([
      {
        kind: 'repo-starred',
        detail: 'starred lemoncrow-lab/lemoncrow',
        evidence_url: 'https://github.com/maya'
      },
      {
        kind: 'repo-issue-opened',
        detail: 'opened an issue on lemoncrow-lab/lemoncrow',
        evidence_url: 'https://github.com/lemoncrow-lab/lemoncrow/issues/7'
      }
    ]);

    const newco = await accountByDomain(WORKSPACE_ID, 'newco.dev');
    expect(newco).toMatchObject({
      status: 'active',
      source: 'github',
      name: 'newco.dev',
      tags: ['github-traction']
    });
    expect((await signalRows(WORKSPACE_ID, newco!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
    expect(result.accountIds.sort()).toEqual([buyer!.id, newco!.id].sort());

    // lee: freemail, a github.io blog and a plain-text company. Counted, never stored.
    expect(await accountByDomain(WORKSPACE_ID, 'gmail.com')).toBeUndefined();
    expect(await accountByDomain(WORKSPACE_ID, 'lee.github.io')).toBeUndefined();
    const actors = await db
      .prepare(
        'SELECT login, profile_url, resolved_domain, resolved_via FROM github_repo_actors WHERE workspace_id=? ORDER BY login'
      )
      .all(WORKSPACE_ID);
    expect(actors).toEqual([
      {
        login: 'maya',
        profile_url: 'https://github.com/maya',
        resolved_domain: 'buyer.io',
        resolved_via: 'org_website'
      },
      {
        login: 'sam',
        profile_url: 'https://github.com/sam',
        resolved_domain: 'newco.dev',
        resolved_via: 'email_domain'
      }
    ]);

    // Outside the backfill window, inside the team, a pull request or a bot:
    // none of them is a buying signal, so none costs a profile lookup.
    const looked = github.calls
      .map((call) => call.endpoint)
      .filter((endpoint) => endpoint.startsWith('/users/'));
    expect(looked.sort()).toEqual(['/users/lee', '/users/maya', '/users/rejectco', '/users/sam']);

    // The stargazer request asked for starred_at.
    const starCall = github.calls.find((call) => call.endpoint.endsWith('/stargazers'));
    expect(starCall?.headers.Accept).toBe('application/vnd.github.star+json');

    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: '2026-10-05T11:00:00.000Z',
      forksCursor: '2026-10-05T12:00:00.000Z',
      issuesCursor: '2026-10-05T13:30:00.000Z',
      repoEtag: '"repo-v1"',
      issuesEtag: '"issues-v1"',
      unresolvedTotal: 1,
      lastPolledAt: T0.toISOString(),
      nextPollAt: new Date(T0.getTime() + POLL_INTERVAL_MINUTES * 60_000).toISOString(),
      lastSummary: {
        stars: 3,
        forks: 1,
        issues: 1,
        attached: 2,
        created: 1,
        unresolved: 1,
        ignoredRejected: 1,
        deferred: 0,
        burstTruncated: false
      }
    });

    // Two kinds from one company, fresh: warm, and scored in the same run.
    const score = await db
      .prepare('SELECT tier FROM account_scores WHERE workspace_id=? AND account_id=?')
      .get<{ tier: string }>(WORKSPACE_ID, buyer!.id);
    expect(score?.tier).toBe('warm');
  });

  it('never reactivates or feeds a company the founder rejected', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    const rejected = await accountByDomain(WORKSPACE_ID, 'rejectco.com');
    expect(rejected?.status).toBe('not_a_fit');
    expect(await signalRows(WORKSPACE_ID, rejected!.id)).toEqual([]);
    expect(
      await db.prepare('SELECT 1 AS one FROM account_scores WHERE account_id=?').get(rejected!.id)
    ).toBeUndefined();

    // Archived after the first run: a remembered login must not bring it back.
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    await db.prepare("UPDATE accounts SET status='archived' WHERE id=?").run(buyer!.id);
    const later = new Date(T0.getTime() + 2 * HOUR);
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/issues`]: () =>
            ok([
              {
                number: 11,
                html_url: `https://github.com/${REPO}/issues/11`,
                created_at: '2026-10-06T13:00:00Z',
                author_association: 'NONE',
                user: user('maya')
              }
            ])
        })
      ),
      later
    );
    expect((await accountByDomain(WORKSPACE_ID, 'buyer.io'))?.status).toBe('archived');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toHaveLength(2);
    expect((await repoRow()).lastSummary).toMatchObject({
      issues: 1,
      ignoredRejected: 1,
      attached: 0
    });
  });

  it('records the same star once however often it is seen', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    // Maya unstars and stars again: the next poll sees her with a newer starred_at.
    const restar = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: 4, forks_count: 1 }, { etag: '"repo-v2"' }),
        [`${REPO_PATH}/stargazers`]: () =>
          ok([
            star('sam', '2026-10-05T10:00:00Z'),
            star('lee', '2026-10-05T11:00:00Z'),
            star('maya', '2026-10-06T13:30:00Z')
          ])
      })
    );
    await poll(restar, new Date(T0.getTime() + 2 * HOUR));

    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const stars = (await signalRows(WORKSPACE_ID, buyer!.id)).filter(
      (row) => row.kind === 'repo-starred'
    );
    expect(stars).toHaveLength(1);
    // A remembered person costs no second profile lookup.
    expect(restar.calls.some((call) => call.endpoint === '/users/maya')).toBe(false);
  });

  it('sends ETags back and skips stars and forks when the repository has not changed', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    const unchanged = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: (call) =>
          call.headers['If-None-Match'] === '"repo-v1"'
            ? { status: 304, data: '', headers: {} }
            : ok({ stargazers_count: 4, forks_count: 1 }),
        [`${REPO_PATH}/issues`]: (call) =>
          call.headers['If-None-Match'] === '"issues-v1"'
            ? { status: 304, data: '', headers: {} }
            : ok([])
      })
    );
    await poll(unchanged, new Date(T0.getTime() + 2 * HOUR));
    expect(unchanged.calls.map((call) => call.endpoint)).toEqual([
      REPO_PATH,
      `${REPO_PATH}/issues`
    ]);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      repoEtag: '"repo-v1"',
      issuesEtag: '"issues-v1"',
      lastSummary: { stars: 0, forks: 0, issues: 0 }
    });
  });

  it('creates at most MAX_NEW_ACCOUNTS_PER_RUN accounts per run and picks up the rest next run', async () => {
    const people = Array.from(
      { length: MAX_NEW_ACCOUNTS_PER_RUN + 2 },
      (_, index) => `person${index + 1}`
    );
    const routes = lemoncrowRoutes({
      [REPO_PATH]: () =>
        ok({ stargazers_count: people.length, forks_count: 0 }, { etag: '"repo-burst"' }),
      [`${REPO_PATH}/stargazers`]: () =>
        ok(people.map((login, index) => star(login, `2026-10-05T0${index + 1}:00:00Z`))),
      [`${REPO_PATH}/forks`]: () => ok([]),
      [`${REPO_PATH}/issues`]: () => ok([])
    });
    people.forEach((login, index) => {
      routes[`/users/${login}`] = () =>
        ok({
          ...user(login),
          email: `${login}@company${index + 1}.dev`,
          company: null,
          blog: null
        });
    });
    const createdDomains = async () =>
      (
        await db
          .prepare(
            "SELECT domain FROM accounts WHERE workspace_id=? AND source='github' ORDER BY domain"
          )
          .all<{ domain: string }>(WORKSPACE_ID)
      ).map((row) => row.domain);

    await poll(fakeGitHub(routes));
    expect(await createdDomains()).toEqual([
      'company1.dev',
      'company2.dev',
      'company3.dev',
      'company4.dev',
      'company5.dev'
    ]);
    const repo = await repoRow();
    expect(repo.lastSummary).toMatchObject({ created: 5, deferred: 2 });
    expect(repo.starsCursor).toBe('2026-10-05T05:00:00.000Z');
    // Cleared so the next run reads the stars again instead of getting a 304.
    expect(repo.repoEtag).toBeNull();

    await poll(fakeGitHub(routes), new Date(T0.getTime() + 2 * HOUR));
    expect(await createdDomains()).toHaveLength(7);
  });

  it('stops at the rate limit, keeps what it processed, and resumes at the reset time', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        '/users/sam': () => ({
          status: 403,
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
        })
      })
    );
    const result = await poll(github);
    const resetAt = new Date(RESET_EPOCH * 1000).toISOString();
    expect(result.rateLimitedUntil).toBe(resetAt);
    expect(await repoRow()).toMatchObject({
      status: 'rate_limited',
      rateLimitedUntil: resetAt,
      nextPollAt: resetAt,
      starsCursor: '2026-10-05T09:00:00.000Z',
      repoEtag: null
    });
    // Maya was processed before the limit and keeps her signal.
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect((await signalRows(WORKSPACE_ID, buyer!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
    // Nothing after the limit was requested.
    expect(github.calls.some((call) => call.endpoint.endsWith('/forks'))).toBe(false);
  });

  it('marks the connection for reconnecting when GitHub rejects the token', async () => {
    const github = fakeGitHub({
      [REPO_PATH]: () => ({ status: 401, data: { message: 'Bad credentials' }, headers: {} })
    });
    const result = await poll(github);
    expect(result.connection).toBe('needs_reauth');
    const connection = await db
      .prepare('SELECT status, last_error FROM connections WHERE workspace_id=?')
      .get<{ status: string; last_error: string | null }>(WORKSPACE_ID);
    expect(connection?.status).toBe('needs_reauth');
    expect(connection?.last_error).toContain('Reconnect GitHub');
    expect(await repoRow()).toMatchObject({ status: 'needs_reauth', lastSummary: null });
    const signals = await db
      .prepare('SELECT COUNT(*)::int AS count FROM account_signals WHERE workspace_id=?')
      .get<{ count: number }>(WORKSPACE_ID);
    expect(signals?.count).toBe(0);
  });

  it('does not touch GitHub when the workspace has no GitHub connection', async () => {
    await db.prepare('DELETE FROM connections WHERE workspace_id=?').run(WORKSPACE_ID);
    const github = fakeGitHub(lemoncrowRoutes());
    const result = await poll(github);
    expect(result.connection).toBe('not_connected');
    expect(github.calls).toEqual([]);
    expect(await repoRow()).toMatchObject({ status: 'not_connected', lastSummary: null });
  });

  it('reports a repository GitHub cannot find as not found', async () => {
    await poll(fakeGitHub({}));
    expect(await repoRow()).toMatchObject({
      status: 'not_found',
      nextPollAt: new Date(T0.getTime() + NOT_FOUND_RETRY_HOURS * HOUR).toISOString()
    });
  });

  it('keeps each workspace to its own accounts when two workspaces watch the same repository', async () => {
    await connectGitHub(OTHER_WORKSPACE_ID);
    await watchRepository(
      db,
      { workspaceId: OTHER_WORKSPACE_ID, actorUserId: null, fullName: REPO },
      new Date(T0.getTime() - 60_000)
    );
    await poll(fakeGitHub(lemoncrowRoutes()));
    await poll(fakeGitHub(lemoncrowRoutes()), T0, OTHER_WORKSPACE_ID);

    const mine = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const theirs = await accountByDomain(OTHER_WORKSPACE_ID, 'buyer.io');
    expect(mine).toMatchObject({ source: 'csv' });
    expect(theirs).toMatchObject({ source: 'github', name: 'Buyer Co' });
    expect(theirs!.id).not.toBe(mine!.id);
    expect(await signalRows(WORKSPACE_ID, mine!.id)).toHaveLength(2);
    const theirActors = await db
      .prepare('SELECT account_id FROM github_repo_actors WHERE workspace_id=?')
      .all<{ account_id: string }>(OTHER_WORKSPACE_ID);
    expect(theirActors.length).toBeGreaterThan(0);
    expect(theirActors.every((row) => row.account_id !== mine!.id)).toBe(true);
  });

  it('reads at most MAX_STAR_PAGES pages of new stars and says so when a burst is larger', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: (MAX_STAR_PAGES + 2) * 100, forks_count: 0 }),
        [`${REPO_PATH}/stargazers`]: (call) => {
          const page = Number(call.params.page);
          return ok(
            Array.from({ length: 100 }, (_, index) =>
              star(
                `bot-${page}-${index}`,
                new Date(
                  Date.parse('2026-10-01T00:00:00Z') + (page * 100 + index) * 60_000
                ).toISOString(),
                'Bot'
              )
            )
          );
        }
      })
    );
    await poll(github);
    const pages = github.calls
      .filter((call) => call.endpoint.endsWith('/stargazers'))
      .map((call) => call.params.page);
    expect(pages).toEqual([5, 4, 3]);
    expect((await repoRow()).lastSummary).toMatchObject({ burstTruncated: true, stars: 0 });
  });

  it('surfaces a company that starred, forked and opened an issue as a high-priority account in Today', async () => {
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/forks`]: () =>
            ok([{ created_at: '2026-10-05T12:00:00Z', owner: user('buyerco', 'Organization') }]),
          '/users/buyerco': () =>
            ok({
              ...user('buyerco', 'Organization'),
              name: 'Buyer Co',
              blog: 'https://www.buyer.io'
            })
        })
      )
    );
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const score = await db
      .prepare(
        'SELECT tier, distinct_kinds FROM account_scores WHERE workspace_id=? AND account_id=?'
      )
      .get<{ tier: string; distinct_kinds: number }>(WORKSPACE_ID, buyer!.id);
    expect(score).toEqual({ tier: 'hot', distinct_kinds: 3 });

    const today = await getToday(db, WORKSPACE_ID, T0);
    expect(today.needsAttention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'high_priority_account',
          reference: { type: 'account', id: buyer!.id }
        })
      ])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/poll.test.ts`
Expected: FAIL with `Failed to load url ./poll.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/github/poll.ts`:

```ts
import { id, type Db } from '../db.js';
import { DEFAULT_WINDOW_DAYS, rescoreAccounts } from '../accounts/score.js';
import { createAccount, rejectedSignalShapes } from '../accounts/store.js';
import { recordSignals, type IncomingSignal } from '../accounts/sweep.js';
import {
  MAX_WATCHED_REPOSITORIES,
  claimDueRepositories,
  emptyPollSummary,
  markConnectionNeedsReauth,
  readGitHubConnection,
  updateRepository,
  type GitHubConnectionState,
  type PollSummary,
  type RepositoryPatch,
  type WatchedRepository
} from './repos.js';
import { resolveGitHubActor, type DomainCandidate, type ResolvedActor } from './resolve.js';
import {
  GITHUB_STAR_ACCEPT,
  GitHubClient,
  GitHubConnectionRevokedError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  nangoGitHubTransport,
  type GitHubTransport
} from './transport.js';

/**
 * GitHub repository traction: who starred, forked or opened an issue on the
 * founder's own public repositories, resolved to companies from public data,
 * written as account signals and rescored in the same run.
 *
 * lc-debt: polling through the Nango proxy, at most hourly per repository and
 * inside the shared automation cycle; upgrade path is GitHub App webhooks
 * (`star`, `fork`, `issues`) through Nango's `github-app` provider, deduped by
 * `webhook_events`, which makes every read below unnecessary.
 */

export const POLL_INTERVAL_MINUTES = 60;
export const NOT_CONNECTED_RETRY_MINUTES = 15;
export const NOT_FOUND_RETRY_HOURS = 24;
export const ERROR_RETRY_MINUTES = 60;
/** A first poll reaches back exactly as far as the scorer counts. */
export const BACKFILL_DAYS = DEFAULT_WINDOW_DAYS;
/**
 * lc-debt: at most 300 new stars are read between two polls; a bigger burst
 * keeps the newest 300 and says so (`burstTruncated`); upgrade path is the
 * `star` webhook, or a page cursor carried across runs.
 */
export const MAX_STAR_PAGES = 3;
/** Distinct GitHub people looked up per workspace run. Remembered people cost nothing. */
export const MAX_PROFILE_LOOKUPS_PER_RUN = 40;
/**
 * New accounts one run may create. A popular repository must not turn into a
 * thousand-row account list overnight; what is left waits for the next run.
 */
export const MAX_NEW_ACCOUNTS_PER_RUN = 5;
export const MAX_REPOSITORIES_PER_RUN = MAX_WATCHED_REPOSITORIES;
/** Tag on every account this module creates, so the founder can find and review them. */
export const GITHUB_ACCOUNT_TAG = 'github-traction';

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
/** Issue authors who are the repository's own team. Their issues are not demand. */
const INSIDER_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface PollDeps {
  transport?: GitHubTransport;
  now?: Date;
}

export interface PollOptions {
  maxRepositories?: number;
}

export interface WorkspacePollResult {
  connection: GitHubConnectionState;
  polled: number;
  accountIds: string[];
  rateLimitedUntil: string | null;
}

type TractionKind = 'repo-starred' | 'repo-forked' | 'repo-issue-opened';
type ActorType = 'User' | 'Organization' | 'Bot';

interface TractionEvent {
  kind: TractionKind;
  login: string;
  at: Date;
  issueNumber: number | null;
  issueUrl: string | null;
}

interface Listing {
  events: TractionEvent[];
  /** Newest timestamp among everything read past the cursor, skipped items included. */
  newest: Date | null;
  truncated: boolean;
  etag: string | null;
  notModified: boolean;
}

interface RunState {
  lookups: number;
  created: number;
  touched: Set<string>;
  resolved: Map<string, ResolvedActor | null>;
}

type AttachOutcome =
  | { kind: 'defer' }
  | { kind: 'rejected' }
  | { kind: 'created' | 'attached'; accountId: string; written: number };

function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function actorTypeOf(value: unknown): ActorType {
  return value === 'Organization' ? 'Organization' : value === 'Bot' ? 'Bot' : 'User';
}

function byTime(left: TractionEvent, right: TractionEvent): number {
  return left.at.getTime() - right.at.getTime() || left.login.localeCompare(right.login);
}

function repoPath(repo: WatchedRepository): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Read from the cursor, never further back than the scorer's window. */
function sinceFor(cursor: string | null, now: Date): Date {
  const floor = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  if (!cursor) return floor;
  const at = new Date(cursor);
  return at > floor ? at : floor;
}

function items(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function later(current: Date | null, candidate: Date): Date {
  return current && current >= candidate ? current : candidate;
}

/**
 * New stars, newest pages first. The stargazer list is paged in the order
 * people starred, so the newest stars are on the last page: start there and
 * walk back until a page reaches the cursor.
 */
async function listNewStars(
  client: GitHubClient,
  repo: WatchedRepository,
  stargazersCount: number,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  if (stargazersCount <= 0) return listing;
  let pagesRead = 0;
  for (let page = Math.ceil(stargazersCount / PAGE_SIZE); page >= 1; page -= 1) {
    if (pagesRead >= MAX_STAR_PAGES) {
      listing.truncated = true;
      break;
    }
    pagesRead += 1;
    const response = await client.get(`${repoPath(repo)}/stargazers`, {
      params: { per_page: PAGE_SIZE, page },
      headers: { Accept: GITHUB_STAR_ACCEPT }
    });
    const rows = items(response.data);
    let reachedCursor = rows.length === 0;
    for (const row of rows) {
      const at = parseTime(row.starred_at);
      const actor = row.user as Record<string, unknown> | undefined;
      if (!at || !actor || typeof actor.login !== 'string') continue;
      if (at <= since) {
        reachedCursor = true;
        continue;
      }
      listing.newest = later(listing.newest, at);
      if (actorTypeOf(actor.type) === 'Bot') continue;
      listing.events.push({
        kind: 'repo-starred',
        login: actor.login,
        at,
        issueNumber: null,
        issueUrl: null
      });
    }
    if (reachedCursor) break;
  }
  listing.events.sort(byTime);
  return listing;
}

async function listNewForks(
  client: GitHubClient,
  repo: WatchedRepository,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  const response = await client.get(`${repoPath(repo)}/forks`, {
    params: { sort: 'newest', per_page: PAGE_SIZE }
  });
  const rows = items(response.data);
  for (const row of rows) {
    const at = parseTime(row.created_at);
    const owner = row.owner as Record<string, unknown> | undefined;
    if (!at || !owner || typeof owner.login !== 'string' || at <= since) continue;
    listing.newest = later(listing.newest, at);
    if (actorTypeOf(owner.type) === 'Bot') continue;
    listing.events.push({
      kind: 'repo-forked',
      login: owner.login,
      at,
      issueNumber: null,
      issueUrl: null
    });
  }
  listing.truncated = rows.length === PAGE_SIZE && listing.events.length === PAGE_SIZE;
  listing.events.sort(byTime);
  return listing;
}

async function listNewIssues(
  client: GitHubClient,
  repo: WatchedRepository,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  const response = await client.get(`${repoPath(repo)}/issues`, {
    params: {
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: PAGE_SIZE,
      since: since.toISOString()
    },
    headers: repo.issuesEtag ? { 'If-None-Match': repo.issuesEtag } : {}
  });
  if (response.status === 304) {
    return { ...listing, etag: repo.issuesEtag, notModified: true };
  }
  for (const row of items(response.data)) {
    const at = parseTime(row.created_at);
    if (!at || at <= since) continue;
    listing.newest = later(listing.newest, at);
    const author = row.user as Record<string, unknown> | undefined;
    if (row.pull_request !== undefined && row.pull_request !== null) continue;
    if (INSIDER_ASSOCIATIONS.has(String(row.author_association))) continue;
    if (!author || typeof author.login !== 'string' || actorTypeOf(author.type) === 'Bot') continue;
    if (typeof row.number !== 'number' || typeof row.html_url !== 'string') continue;
    listing.events.push({
      kind: 'repo-issue-opened',
      login: author.login,
      at,
      issueNumber: row.number,
      issueUrl: row.html_url
    });
  }
  listing.etag = response.headers.etag ?? null;
  listing.events.sort(byTime);
  return listing;
}

/** Content-free detail; the fingerprint input makes the same event one row forever. */
function signalFor(
  repo: WatchedRepository,
  event: TractionEvent,
  profileUrl: string
): IncomingSignal {
  const repoKey = repo.fullName.toLowerCase();
  if (event.kind === 'repo-issue-opened') {
    return {
      kind: event.kind,
      detail: `opened an issue on ${repo.fullName}`,
      previous: null,
      current: `${repoKey}#${event.issueNumber}`,
      evidenceUrl: event.issueUrl ?? profileUrl,
      observedAt: event.at
    };
  }
  return {
    kind: event.kind,
    detail: `${event.kind === 'repo-starred' ? 'starred' : 'forked'} ${repo.fullName}`,
    previous: null,
    current: `${repoKey}@${event.login.toLowerCase()}`,
    evidenceUrl: profileUrl,
    observedAt: event.at
  };
}

function countKind(summary: PollSummary, kind: TractionKind): void {
  if (kind === 'repo-starred') summary.stars += 1;
  else if (kind === 'repo-forked') summary.forks += 1;
  else summary.issues += 1;
}

async function knownActor(
  db: Db,
  workspaceId: string,
  login: string
): Promise<{ id: string; accountId: string; profileUrl: string; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT ga.id, ga.account_id, ga.profile_url, a.status
       FROM github_repo_actors ga
       JOIN accounts a ON a.id = ga.account_id AND a.workspace_id = ga.workspace_id
       WHERE ga.workspace_id=? AND LOWER(ga.login)=LOWER(?)`
    )
    .get<{ id: string; account_id: string; profile_url: string; status: string }>(
      workspaceId,
      login
    );
  return row
    ? { id: row.id, accountId: row.account_id, profileUrl: row.profile_url, status: row.status }
    : null;
}

/**
 * One event, written atomically: the account (found or created), the
 * remembered login and the signal land together or not at all.
 */
async function processEvent(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  event: TractionEvent,
  client: GitHubClient,
  run: RunState,
  summary: PollSummary,
  now: Date
): Promise<'done' | 'defer'> {
  const known = await knownActor(db, workspaceId, event.login);
  if (known) {
    // A rejected or archived company stays exactly as the founder left it.
    if (known.status !== 'active') {
      summary.ignoredRejected += 1;
      return 'done';
    }
    const written = await db.transaction(async (tx) => {
      await tx
        .prepare(
          'UPDATE github_repo_actors SET last_seen_at=?::timestamptz WHERE id=? AND workspace_id=?'
        )
        .run(now.toISOString(), known.id, workspaceId);
      return recordSignals(
        tx,
        workspaceId,
        known.accountId,
        [signalFor(repo, event, known.profileUrl)],
        now
      );
    });
    summary.attached += 1;
    if (written.length > 0) run.touched.add(known.accountId);
    return 'done';
  }

  const key = event.login.toLowerCase();
  let resolved = run.resolved.get(key);
  if (resolved === undefined) {
    if (run.lookups >= MAX_PROFILE_LOOKUPS_PER_RUN) return 'defer';
    run.lookups += 1;
    resolved = await resolveGitHubActor(client, event.login);
    run.resolved.set(key, resolved);
  }
  if (!resolved || resolved.candidates.length === 0) {
    summary.unresolved += 1;
    return 'done';
  }
  const actor = resolved;

  const outcome = await db.transaction(async (tx): Promise<AttachOutcome> => {
    let match: { id: string; status: string } | undefined;
    let chosen: DomainCandidate = actor.candidates[0];
    for (const candidate of actor.candidates) {
      match = await tx
        .prepare(
          'SELECT id, status FROM accounts WHERE workspace_id=? AND LOWER(domain)=? FOR UPDATE'
        )
        .get<{ id: string; status: string }>(workspaceId, candidate.domain);
      if (match) {
        chosen = candidate;
        break;
      }
    }
    let created = false;
    if (!match) {
      if (run.created >= MAX_NEW_ACCOUNTS_PER_RUN) return { kind: 'defer' };
      // createAccount is idempotent on the domain and returns an existing row
      // unchanged, so a race can never reactivate a rejected company.
      const account = await createAccount(
        tx,
        workspaceId,
        {
          name: chosen.name ?? chosen.domain,
          domain: chosen.domain,
          source: 'github',
          tags: [GITHUB_ACCOUNT_TAG]
        },
        now
      );
      match = { id: account.id, status: account.status };
      created = true;
    }
    if (match.status !== 'active') return { kind: 'rejected' };

    await tx
      .prepare(
        `INSERT INTO github_repo_actors
           (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?::timestamptz,?::timestamptz)
         ON CONFLICT (workspace_id, LOWER(login)) DO UPDATE SET
           account_id=EXCLUDED.account_id, profile_url=EXCLUDED.profile_url,
           resolved_domain=EXCLUDED.resolved_domain, resolved_via=EXCLUDED.resolved_via,
           last_seen_at=EXCLUDED.last_seen_at`
      )
      .run(
        id('ghact'),
        workspaceId,
        actor.login,
        actor.profileUrl,
        match.id,
        chosen.domain,
        chosen.via,
        now.toISOString(),
        now.toISOString()
      );
    const written = await recordSignals(
      tx,
      workspaceId,
      match.id,
      [signalFor(repo, event, actor.profileUrl)],
      now
    );
    return { kind: created ? 'created' : 'attached', accountId: match.id, written: written.length };
  });

  if (outcome.kind === 'defer') return 'defer';
  if (outcome.kind === 'rejected') {
    summary.ignoredRejected += 1;
    return 'done';
  }
  if (outcome.kind === 'created') {
    run.created += 1;
    summary.created += 1;
  } else {
    summary.attached += 1;
  }
  if (outcome.written > 0) run.touched.add(outcome.accountId);
  return 'done';
}

/**
 * Events oldest first. `advance` moves the cursor after each one, so an
 * exception (rate limit, revoked token) keeps everything already written.
 * Returns false when a per-run cap deferred the rest.
 */
async function processListing(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  listing: Listing,
  client: GitHubClient,
  run: RunState,
  summary: PollSummary,
  now: Date,
  advance: (at: Date) => void
): Promise<boolean> {
  for (let index = 0; index < listing.events.length; index += 1) {
    const event = listing.events[index];
    const outcome = await processEvent(db, workspaceId, repo, event, client, run, summary, now);
    if (outcome === 'defer') {
      summary.deferred += listing.events.length - index;
      return false;
    }
    countKind(summary, event.kind);
    advance(event.at);
  }
  if (listing.newest) advance(listing.newest);
  return true;
}

async function pollRepository(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  client: GitHubClient,
  run: RunState,
  now: Date,
  progress: RepositoryPatch,
  summary: PollSummary
): Promise<void> {
  const meta = await client.get(repoPath(repo), {
    headers: repo.repoEtag ? { 'If-None-Match': repo.repoEtag } : {}
  });
  if (meta.status !== 304) {
    // Until stars and forks are fully processed the old ETag must not survive:
    // a 304 next run would skip whatever this run did not finish.
    progress.repoEtag = null;
    const data = (meta.data ?? {}) as { stargazers_count?: unknown };
    const stargazers = Number(data.stargazers_count ?? 0);
    const stars = await listNewStars(
      client,
      repo,
      Number.isFinite(stargazers) ? stargazers : 0,
      sinceFor(repo.starsCursor, now)
    );
    summary.burstTruncated = stars.truncated;
    const starsDone = await processListing(
      db,
      workspaceId,
      repo,
      stars,
      client,
      run,
      summary,
      now,
      (at) => {
        progress.starsCursor = at;
      }
    );
    const forks = await listNewForks(client, repo, sinceFor(repo.forksCursor, now));
    summary.burstTruncated = summary.burstTruncated || forks.truncated;
    const forksDone = await processListing(
      db,
      workspaceId,
      repo,
      forks,
      client,
      run,
      summary,
      now,
      (at) => {
        progress.forksCursor = at;
      }
    );
    if (starsDone && forksDone) progress.repoEtag = meta.headers.etag ?? null;
  }

  const issues = await listNewIssues(client, repo, sinceFor(repo.issuesCursor, now));
  if (issues.notModified) return;
  progress.issuesEtag = null;
  const issuesDone = await processListing(
    db,
    workspaceId,
    repo,
    issues,
    client,
    run,
    summary,
    now,
    (at) => {
      progress.issuesCursor = at;
    }
  );
  if (issuesDone) progress.issuesEtag = issues.etag;
}

/**
 * Poll every due repository of one workspace.
 *
 * NEVER THROWS FOR A GITHUB CONDITION. Not connected, needs reconnecting,
 * rate limited, not found and any other failure are written to the
 * repository row (and, for a revoked token, to the connection row), because
 * the Setup card must show them instead of a quiet zero. Only a database
 * failure escapes, and the claim lease then frees the rows within
 * POLL_LEASE_MINUTES.
 */
export async function pollWorkspaceRepositories(
  db: Db,
  workspaceId: string,
  deps: PollDeps = {},
  opts: PollOptions = {}
): Promise<WorkspacePollResult> {
  const now = deps.now ?? new Date();
  const connection = await readGitHubConnection(db, workspaceId);
  const result: WorkspacePollResult = {
    connection: connection.state,
    polled: 0,
    accountIds: [],
    rateLimitedUntil: null
  };
  const repos = await claimDueRepositories(
    db,
    workspaceId,
    now,
    opts.maxRepositories ?? MAX_REPOSITORIES_PER_RUN
  );
  if (repos.length === 0) return result;

  if (connection.state !== 'connected' || !connection.externalConnectionId) {
    const status = connection.state === 'needs_reauth' ? 'needs_reauth' : 'not_connected';
    for (const repo of repos) {
      await updateRepository(
        db,
        workspaceId,
        repo.id,
        { status, lastError: null, nextPollAt: minutesFrom(now, NOT_CONNECTED_RETRY_MINUTES) },
        now
      );
    }
    return result;
  }

  let transport: GitHubTransport;
  try {
    transport =
      deps.transport ??
      nangoGitHubTransport({
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.externalConnectionId
      });
  } catch (error) {
    for (const repo of repos) {
      await updateRepository(
        db,
        workspaceId,
        repo.id,
        {
          status: 'error',
          lastError: messageOf(error),
          nextPollAt: minutesFrom(now, ERROR_RETRY_MINUTES)
        },
        now
      );
    }
    return result;
  }

  const client = new GitHubClient(transport, now);
  const run: RunState = { lookups: 0, created: 0, touched: new Set(), resolved: new Map() };

  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    const progress: RepositoryPatch = {};
    const summary = emptyPollSummary();
    try {
      await pollRepository(db, workspaceId, repo, client, run, now, progress, summary);
      await updateRepository(
        db,
        workspaceId,
        repo.id,
        {
          ...progress,
          status: 'ok',
          lastError: null,
          rateLimitedUntil: null,
          lastPolledAt: now,
          lastSummary: summary,
          addUnresolved: summary.unresolved,
          nextPollAt: minutesFrom(now, POLL_INTERVAL_MINUTES)
        },
        now
      );
      result.polled += 1;
    } catch (error) {
      if (error instanceof GitHubRateLimitedError) {
        result.rateLimitedUntil = error.resetAt.toISOString();
        await updateRepository(
          db,
          workspaceId,
          repo.id,
          {
            ...progress,
            status: 'rate_limited',
            lastError: null,
            rateLimitedUntil: error.resetAt,
            nextPollAt: error.resetAt,
            lastPolledAt: now,
            lastSummary: summary,
            addUnresolved: summary.unresolved
          },
          now
        );
        for (const rest of repos.slice(index + 1)) {
          await updateRepository(
            db,
            workspaceId,
            rest.id,
            {
              status: 'rate_limited',
              lastError: null,
              rateLimitedUntil: error.resetAt,
              nextPollAt: error.resetAt
            },
            now
          );
        }
        break;
      }
      if (error instanceof GitHubConnectionRevokedError) {
        result.connection = 'needs_reauth';
        if (connection.localConnectionId) {
          await markConnectionNeedsReauth(
            db,
            workspaceId,
            connection.localConnectionId,
            error.message,
            now
          );
        }
        for (const affected of repos.slice(index)) {
          await updateRepository(
            db,
            workspaceId,
            affected.id,
            {
              ...(affected.id === repo.id
                ? { ...progress, addUnresolved: summary.unresolved }
                : {}),
              status: 'needs_reauth',
              lastError: null,
              nextPollAt: minutesFrom(now, NOT_CONNECTED_RETRY_MINUTES)
            },
            now
          );
        }
        break;
      }
      if (error instanceof GitHubNotFoundError && error.endpoint === repoPath(repo)) {
        await updateRepository(
          db,
          workspaceId,
          repo.id,
          {
            status: 'not_found',
            lastError: null,
            lastPolledAt: now,
            nextPollAt: minutesFrom(now, NOT_FOUND_RETRY_HOURS * 60)
          },
          now
        );
        continue;
      }
      await updateRepository(
        db,
        workspaceId,
        repo.id,
        {
          ...progress,
          status: 'error',
          lastError: messageOf(error),
          lastPolledAt: now,
          addUnresolved: summary.unresolved,
          nextPollAt: minutesFrom(now, ERROR_RETRY_MINUTES)
        },
        now
      );
    }
  }

  // Scoring follows the writes in the same turn, over the accounts touched.
  result.accountIds = [...run.touched];
  if (result.accountIds.length > 0) {
    const rejectedShapes = await rejectedSignalShapes(db, workspaceId);
    await rescoreAccounts(db, workspaceId, result.accountIds, { rejectedShapes, now });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/poll.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/github/poll.ts src/server/github/poll.test.ts
git commit -m "feat(github): poll stars, forks and issues into account signals" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 6: Run the poller from the automation cycle

**Files:**

- Modify: `src/server/automation-service.ts:1-9` (imports), `src/server/automation-service.ts:67-69` (new block after the account-sweep `if (sweepable) { ... }` block, before the "Recommendations are a projection" comment)
- Test: `src/server/github/automation.test.ts`

**Interfaces:**

- Consumes: `hasDueRepositories(db, workspaceId, now)` (Task 3), `pollWorkspaceRepositories(db, workspaceId)` (Task 5).
- Produces: `runAutomationCycle(db, workspaceId)` polls due watched repositories once per cycle; a thrown database error increments `result.failed` and never stops the rest of the cycle.

- [ ] **Step 1: Write the failing test**

Create `src/server/github/automation.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { runAutomationCycle } from '../automation-service.js';
import { listWatchedRepositories, watchRepository } from './repos.js';

let db: Db;
const WORKSPACE_ID = 'ws_github_automation_test';

beforeEach(async () => {
  delete process.env.NANGO_API_KEY;
  delete process.env.NANGO_GITHUB_INTEGRATION;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE_ID, 'GitHub automation', new Date().toISOString());
  await watchRepository(
    db,
    { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: 'lemoncrow-lab/lemoncrow' },
    new Date(Date.now() - 60_000)
  );
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db.close();
});

describe('GitHub polling in the automation cycle', () => {
  it('records an honest not-connected state for a due repository without calling GitHub', async () => {
    await runAutomationCycle(db, WORKSPACE_ID);
    const [repo] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(repo.status).toBe('not_connected');
    expect(Date.parse(repo.nextPollAt)).toBeGreaterThan(Date.now());
  });

  it('builds the Nango transport for a connected workspace and reports a missing Nango key as an error', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES (?,?,'github','trevra-github','gh-live','GitHub','connected',0,?,?)`
      )
      .run(id('conn'), WORKSPACE_ID, now, now);
    await runAutomationCycle(db, WORKSPACE_ID);
    const [repo] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(repo.status).toBe('error');
    expect(repo.lastError).toBe('NANGO_API_KEY is not configured');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/automation.test.ts`
Expected: FAIL with `expected 'pending' to be 'not_connected'` and `expected 'pending' to be 'error'` (nothing polls yet).

- [ ] **Step 3: Write minimal implementation**

In `src/server/automation-service.ts`, add after the line `import { rejectedSignalShapes } from './accounts/store.js';`:

```ts
import { hasDueRepositories } from './github/repos.js';
import { pollWorkspaceRepositories } from './github/poll.js';
```

Insert this block directly after the closing `}` of `if (sweepable) { ... }` and before the comment that starts `// Recommendations are a projection over durable GTM evidence.`:

```ts
// GitHub repository traction. Guarded by one indexed existence check, like
// the sweep, because almost no workspace watches a repository. The poll
// writes account signals and rescores what it touched itself, BEFORE the
// recommendation refresh below so a newly hot account is seen this turn.
// GitHub conditions (not connected, needs reconnecting, rate limited) are
// recorded on the repository row, not thrown; this catch is for a database
// failure, and it must not cost the rest of the cycle its turn.
try {
  if (await hasDueRepositories(db, workspaceId, new Date())) {
    await pollWorkspaceRepositories(db, workspaceId);
  }
} catch {
  result.failed += 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/automation.test.ts src/server/automation-service.test.ts`
Expected: PASS (2 new tests; the existing sweep tests are unchanged).

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/automation-service.ts src/server/github/automation.test.ts
git commit -m "feat(github): poll watched repositories in the automation cycle" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 7: Watched-repository API and the accounts source filter

**Files:**

- Modify: `src/server/app.ts:19` (import), `src/server/app.ts:1377-1378` (routes after the `/api/capture-sources/:id/rotate` route, before `app.get('/api/inbound/people'`), `src/server/app.ts:9802-9806` (`accountListSchema`)
- Modify: `src/server/accounts/store.ts:1240-1247` (`RankedAccountsOptions`), `src/server/accounts/store.ts:1289-1302` (`listRankedAccounts` SQL and parameters)
- Test: `src/server/github/api.test.ts`

**Interfaces:**

- Consumes: `MAX_WATCHED_REPOSITORIES`, `GitHubRepoError`, `listWatchedRepositories`, `readGitHubConnection`, `watchRepository`, `unwatchRepository` (Task 3); `AccountSource` incl. `'github'` (Task 1).
- Produces:
  - `GET /api/github/repos` -> `200 { connection: { state: 'connected' | 'needs_reauth' | 'not_connected'; lastError: string | null }, repos: WatchedRepository[], limit: 10 }` (any workspace member).
  - `POST /api/github/repos` body `{ fullName: string }` -> `201 { repo }` new, `200 { repo }` already watched, `400` malformed, `409` at the cap, `403 { error: 'Only the workspace owner can watch a GitHub repository' }` for members.
  - `DELETE /api/github/repos/:id` -> `200 { removed: true }`, `404` when not in this workspace, `403` for members.
  - `GET /api/accounts?source=github` filters by `accounts.source`; `RankedAccountsOptions.source?: AccountSource`.

- [ ] **Step 1: Write the failing test**

Create `src/server/github/api.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';

let db: Db;
let app: ReturnType<typeof createApp>;
let signUpSeq = 0;

beforeAll(async () => {
  delete process.env.NANGO_GITHUB_INTEGRATION;
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

/** A real better-auth user, so owner and member roles are genuine (see app.test.ts). */
async function signUpAgent(label: string) {
  signUpSeq += 1;
  const email = `${label}-${Date.now()}-${signUpSeq}@example.test`;
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  return { agent, userId: (res.body as { user: { id: string } }).user.id };
}

async function sessionAuth(agent: ReturnType<typeof request.agent>) {
  const res = await agent.get('/api/auth/session').expect(200);
  return (res.body as { auth: { userId: string; workspaceId: string; role: 'owner' | 'member' } })
    .auth;
}

async function ownerAndMember() {
  const owner = await signUpAgent('gh-owner');
  const ownerAuth = await sessionAuth(owner.agent);
  const member = await signUpAgent('gh-mate');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: ownerAuth.workspaceId })
    .expect(200);
  expect((await sessionAuth(member.agent)).role).toBe('member');
  return { owner, member };
}

async function insertAccount(workspaceId: string, domain: string, source: string): Promise<string> {
  const accountId = id('acc');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?::text[],'active',?,?)`
    )
    .run(accountId, workspaceId, domain, domain, source, [], now, now);
  return accountId;
}

describe('GitHub watched-repository API', () => {
  it('lets the owner watch a repository by name or link, idempotently, and shows the connection state', async () => {
    const { agent } = await signUpAgent('gh-watch');
    const first = await agent
      .post('/api/github/repos')
      .send({ fullName: 'https://github.com/lemoncrow-lab/lemoncrow' })
      .expect(201);
    expect(first.body.repo).toMatchObject({
      fullName: 'lemoncrow-lab/lemoncrow',
      url: 'https://github.com/lemoncrow-lab/lemoncrow',
      status: 'pending'
    });
    const again = await agent
      .post('/api/github/repos')
      .send({ fullName: 'LemonCrow-Lab/LemonCrow' })
      .expect(200);
    expect(again.body.repo.id).toBe(first.body.repo.id);

    const listed = await agent.get('/api/github/repos').expect(200);
    expect(listed.body).toMatchObject({ connection: { state: 'not_connected' }, limit: 10 });
    expect(listed.body.repos).toHaveLength(1);
  });

  it('refuses a name that is not a repository and an eleventh repository', async () => {
    const { agent } = await signUpAgent('gh-cap');
    const malformed = await agent
      .post('/api/github/repos')
      .send({ fullName: 'not a repo' })
      .expect(400);
    expect(malformed.body.error).toContain('is not a GitHub repository');
    for (let index = 0; index < 10; index += 1) {
      await agent
        .post('/api/github/repos')
        .send({ fullName: `lemoncrow-lab/repo-${index}` })
        .expect(201);
    }
    const refused = await agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/one-too-many' })
      .expect(409);
    expect(refused.body.error).toContain('at most 10');
  });

  it('lets a member read but not change the watch list', async () => {
    const { owner, member } = await ownerAndMember();
    const created = await owner.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/lemoncrow' })
      .expect(201);
    const read = await member.agent.get('/api/github/repos').expect(200);
    expect(read.body.repos).toHaveLength(1);
    const refusedAdd = await member.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/other' })
      .expect(403);
    expect(refusedAdd.body.error).toBe('Only the workspace owner can watch a GitHub repository');
    await member.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(403);
  });

  it('removes a repository only from its own workspace', async () => {
    const a = await signUpAgent('gh-a');
    const b = await signUpAgent('gh-b');
    const created = await a.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/lemoncrow' })
      .expect(201);
    await b.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(404);
    const removed = await a.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(200);
    expect(removed.body).toEqual({ removed: true });
    expect((await a.agent.get('/api/github/repos').expect(200)).body.repos).toEqual([]);
  });

  it('includes watched repositories and resolved GitHub logins in the workspace export', async () => {
    const { agent } = await signUpAgent('gh-export');
    const { workspaceId } = await sessionAuth(agent);
    await agent.post('/api/github/repos').send({ fullName: 'lemoncrow-lab/lemoncrow' }).expect(201);
    const accountId = await insertAccount(workspaceId, 'buyer.io', 'github');
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO github_repo_actors
         (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('ghact'),
        workspaceId,
        'maya',
        'https://github.com/maya',
        accountId,
        'buyer.io',
        'org_website',
        now,
        now
      );

    const bundle = (await agent.get('/api/workspace/export').expect(200)).body as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(bundle.tables.watched_repositories.map((row) => `${row.owner}/${row.name}`)).toEqual([
      'lemoncrow-lab/lemoncrow'
    ]);
    expect(bundle.tables.github_repo_actors).toEqual([
      expect.objectContaining({ login: 'maya', profile_url: 'https://github.com/maya' })
    ]);
  });
});

describe('accounts source filter', () => {
  it('filters ranked accounts to the ones GitHub activity created', async () => {
    const { agent } = await signUpAgent('gh-filter');
    const { workspaceId } = await sessionAuth(agent);
    await insertAccount(workspaceId, 'acme.com', 'csv');
    await insertAccount(workspaceId, 'buyer.io', 'github');

    const fromGitHub = await agent.get('/api/accounts?source=github').expect(200);
    expect(
      fromGitHub.body.accounts.map((row: { account: { domain: string } }) => row.account.domain)
    ).toEqual(['buyer.io']);
    expect((await agent.get('/api/accounts').expect(200)).body.accounts).toHaveLength(2);
    await agent.get('/api/accounts?source=nowhere').expect(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/api.test.ts`
Expected: FAIL. The GitHub tests get `404 "API route not found"` instead of `201`; the filter test gets 2 accounts instead of `['buyer.io']`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/app.ts`, after the line `import { listConnections } from './serializers.js';` add:

```ts
import {
  GitHubRepoError,
  MAX_WATCHED_REPOSITORIES,
  listWatchedRepositories,
  readGitHubConnection,
  unwatchRepository,
  watchRepository
} from './github/repos.js';
```

Insert these routes directly after the `app.post('/api/capture-sources/:id/rotate', ...)` route and before `app.get('/api/inbound/people', ...)`:

```ts
// ---------------------------------------------------------------------
// GitHub repository traction. Reads are workspace-visible; choosing which
// repositories to watch is owner-only. The connection itself is managed by
// the existing Connections card (Nango).
// ---------------------------------------------------------------------
app.get('/api/github/repos', async (req: AuthedRequest, res, next) => {
  try {
    const workspaceId = req.auth!.workspaceId;
    const [connection, repos] = await Promise.all([
      readGitHubConnection(db, workspaceId),
      listWatchedRepositories(db, workspaceId)
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      connection: { state: connection.state, lastError: connection.lastError },
      repos,
      limit: MAX_WATCHED_REPOSITORIES
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/github/repos',
  ownerOnly('watch a GitHub repository'),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = z
        .object({ fullName: z.string().trim().min(1).max(300) })
        .strict()
        .parse(req.body ?? {});
      const { repo, created } = await watchRepository(db, {
        workspaceId: req.auth!.workspaceId,
        actorUserId: req.auth!.userId,
        fullName: input.fullName
      });
      res.status(created ? 201 : 200).json({ repo });
    } catch (error) {
      if (error instanceof GitHubRepoError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

app.delete(
  '/api/github/repos/:id',
  ownerOnly('stop watching a GitHub repository'),
  async (req: AuthedRequest, res, next) => {
    try {
      const removed = await unwatchRepository(db, req.auth!.workspaceId, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'Watched repository not found' });
      res.json({ removed: true });
    } catch (error) {
      next(error);
    }
  }
);
```

Replace `accountListSchema` (currently lines 9802-9806) with:

```ts
const accountListSchema = z.object({
  tier: z.enum(['hot', 'warm', 'cold']).optional(),
  source: z.enum(['csv', 'sourced', 'linkedin', 'manual', 'github']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  signalLimit: z.coerce.number().int().min(1).max(50).default(6)
});
```

In `src/server/accounts/store.ts`, add to `RankedAccountsOptions` (after `tier?: AccountTier;`):

```ts
  /** Only accounts whose first door was this source, e.g. 'github' for ones GitHub activity created. */
  source?: AccountSource;
```

In `listRankedAccounts`, replace the `WHERE` clause through the `.all<AccountRow & ScoreRow>(...)` call (currently lines 1289-1302) with:

```ts
    WHERE a.workspace_id=?
      AND (?::text IS NULL OR s.tier = ?)
      AND (?::text IS NULL OR a.source = ?)
      AND (?::bool IS TRUE OR a.status = 'active')
    ORDER BY s.score DESC NULLS LAST, a.created_at DESC, a.id DESC
    LIMIT ?
  `
    )
    .all<AccountRow & ScoreRow>(
      workspaceId,
      opts.tier ?? null,
      opts.tier ?? null,
      opts.source ?? null,
      opts.source ?? null,
      opts.includeRejected ?? false,
      limit
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/server/github/api.test.ts src/server/accounts/store.test.ts`
Expected: PASS (6 new tests; existing store tests unchanged).

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/server/app.ts src/server/accounts/store.ts src/server/github/api.test.ts
git commit -m "feat(github): watched-repository API and accounts source filter" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 8: Setup card and accounts filter in the client

**Files:**

- Modify: `src/client/api.ts:3410-3421` (`getRankedAccounts`) and append GitHub types and calls after it
- Create: `src/client/GitHubReposView.tsx` (presentational, no auth-client import, so it renders in a node test)
- Create: `src/client/GitHubReposPanel.tsx` (container)
- Create: `src/client/github-repos.css` (layout only)
- Modify: `src/client/App.tsx:82-83` (import), `src/client/App.tsx:592-598` (render after `<ConnectionsView ... />` in the Workspace grid)
- Modify: `src/client/AccountsScreen.tsx:96-124` (`KIND_LABELS`), `:188` (state), `:190-205` (`load`), `:419-464` (ranked section), `:519` (add-more branch)
- Modify: `src/client/styles.css:8888-8890` (one rule after `.acc-heading-actions button`)
- Test: `src/client/GitHubReposView.test.tsx`

**Interfaces:**

- Consumes: HTTP contract from Task 7.
- Produces (from `src/client/api.ts`): `type GitHubConnectionState`, `type GitHubRepoStatus`, `interface GitHubPollSummary`, `interface GitHubRepoWatch { id; fullName; url; status; lastError; rateLimitedUntil; nextPollAt; lastPolledAt; lastSummary: GitHubPollSummary | null; unresolvedTotal; createdAt }`, `interface GitHubReposState { connection: { state; lastError }; repos: GitHubRepoWatch[]; limit: number }`, `getGitHubRepos(): Promise<GitHubReposState>`, `watchGitHubRepo(fullName: string): Promise<GitHubRepoWatch>`, `unwatchGitHubRepo(repoId: string): Promise<void>`, `getRankedAccounts(filters: { tier?; limit?; source?: AccountSource })`. From `src/client/GitHubReposView.tsx`: `GitHubReposView(props: GitHubReposViewProps)`, `connectionNotice(state)`, `repoStatusCopy(repo, formatTime)`. From `src/client/GitHubReposPanel.tsx`: `GitHubReposPanel({ setToast })`.

- [ ] **Step 1: Write the failing test**

Create `src/client/GitHubReposView.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitHubRepoWatch, GitHubReposState } from './api';
import { GitHubReposView, repoStatusCopy } from './GitHubReposView';

const formatTime = (iso: string) => `at ${iso}`;

function repo(overrides: Partial<GitHubRepoWatch> = {}): GitHubRepoWatch {
  return {
    id: 'ghrepo_1',
    fullName: 'lemoncrow-lab/lemoncrow',
    url: 'https://github.com/lemoncrow-lab/lemoncrow',
    status: 'ok',
    lastError: null,
    rateLimitedUntil: null,
    nextPollAt: '2026-10-06T10:00:00.000Z',
    lastPolledAt: '2026-10-06T09:00:00.000Z',
    lastSummary: null,
    unresolvedTotal: 0,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides
  };
}

function state(
  repos: GitHubRepoWatch[],
  connection: GitHubReposState['connection']['state'] = 'connected'
): GitHubReposState {
  return { connection: { state: connection, lastError: null }, repos, limit: 10 };
}

function render(value: GitHubReposState | null, isOwner = true): string {
  return renderToStaticMarkup(
    <GitHubReposView
      state={value}
      error=""
      isOwner={isOwner}
      draft=""
      busy={null}
      formatTime={formatTime}
      onDraftChange={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  );
}

describe('GitHubReposView', () => {
  it('says GitHub is not connected instead of showing zero activity', () => {
    const html = render(state([repo({ status: 'not_connected' })], 'not_connected'));
    expect(html).toContain('GitHub is not connected.');
    expect(html).toContain('Not checked: GitHub is not connected.');
    expect(html).not.toContain('0 new stars');

    const revoked = render(state([repo({ status: 'needs_reauth' })], 'needs_reauth'));
    expect(revoked).toContain('GitHub needs reconnecting.');
    expect(revoked).not.toContain('Nothing new since the previous check');
  });

  it('names the reset time when GitHub pauses the watch', () => {
    const html = render(
      state([repo({ status: 'rate_limited', rateLimitedUntil: '2026-10-06T13:00:00.000Z' })])
    );
    expect(html).toContain('Paused by the GitHub rate limit until at 2026-10-06T13:00:00.000Z.');
  });

  it('summarises a check that matched companies, and counts people it could not trace', () => {
    const checked = repo({
      lastSummary: {
        stars: 3,
        forks: 1,
        issues: 1,
        attached: 2,
        created: 1,
        unresolved: 1,
        ignoredRejected: 1,
        deferred: 0,
        burstTruncated: false
      },
      unresolvedTotal: 4
    });
    expect(repoStatusCopy(checked, formatTime)).toBe(
      'Checked at 2026-10-06T09:00:00.000Z: 3 new stars, 1 new fork, 1 new issue. 3 matched to a company (1 new account); 1 not traceable to a company; 1 from companies marked not a fit.'
    );
    expect(render(state([checked]))).toContain(
      '4 people so far not traceable to a company. Counted, not stored.'
    );
  });

  it('lets only the owner add or remove repositories', () => {
    const owner = render(state([repo()]));
    expect(owner).toContain('aria-label="Stop watching lemoncrow-lab/lemoncrow"');
    expect(owner).toContain('Watch repository');

    const member = render(state([repo()]), false);
    expect(member).not.toContain('Stop watching');
    expect(member).not.toContain('Watch repository');
    expect(render(state([]), false)).toContain(
      'The workspace owner chooses which repositories to watch.'
    );
  });

  it('disables adding at the repository limit', () => {
    const full = Array.from({ length: 10 }, (_, index) =>
      repo({ id: `ghrepo_${index}`, fullName: `lemoncrow-lab/repo-${index}` })
    );
    const html = render(state(full));
    expect(html).toContain('You are watching the maximum of 10. Remove one to add another.');
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/client/GitHubReposView.test.tsx`
Expected: FAIL with `Failed to load url ./GitHubReposView`.

- [ ] **Step 3: Write minimal implementation**

In `src/client/api.ts`, replace `getRankedAccounts` (currently lines 3410-3421) with the version below, and append the GitHub types and calls directly after it:

```ts
export async function getRankedAccounts(
  filters: { tier?: AccountTier; limit?: number; source?: AccountSource } = {}
): Promise<RankedAccount[]> {
  const query = new URLSearchParams();
  if (filters.tier) query.set('tier', filters.tier);
  if (filters.limit) query.set('limit', String(filters.limit));
  if (filters.source) query.set('source', filters.source);
  const suffix = query.toString();
  const result = await request<{ accounts?: RankedAccount[] }>(
    `/api/accounts${suffix ? `?${suffix}` : ''}`
  );
  return Array.isArray(result.accounts) ? result.accounts : [];
}

export type GitHubConnectionState = 'connected' | 'needs_reauth' | 'not_connected';
export type GitHubRepoStatus =
  'pending' | 'ok' | 'not_found' | 'rate_limited' | 'needs_reauth' | 'not_connected' | 'error';

export interface GitHubPollSummary {
  stars: number;
  forks: number;
  issues: number;
  attached: number;
  created: number;
  unresolved: number;
  ignoredRejected: number;
  deferred: number;
  burstTruncated: boolean;
}

export interface GitHubRepoWatch {
  id: string;
  fullName: string;
  url: string;
  status: GitHubRepoStatus;
  lastError: string | null;
  rateLimitedUntil: string | null;
  nextPollAt: string;
  lastPolledAt: string | null;
  lastSummary: GitHubPollSummary | null;
  unresolvedTotal: number;
  createdAt: string;
}

export interface GitHubReposState {
  connection: { state: GitHubConnectionState; lastError: string | null };
  repos: GitHubRepoWatch[];
  limit: number;
}

export async function getGitHubRepos(): Promise<GitHubReposState> {
  return request<GitHubReposState>('/api/github/repos');
}

export async function watchGitHubRepo(fullName: string): Promise<GitHubRepoWatch> {
  const result = await request<{ repo: GitHubRepoWatch }>('/api/github/repos', {
    method: 'POST',
    body: JSON.stringify({ fullName })
  });
  return result.repo;
}

export async function unwatchGitHubRepo(repoId: string): Promise<void> {
  await request<{ removed: boolean }>(`/api/github/repos/${encodeURIComponent(repoId)}`, {
    method: 'DELETE'
  });
}
```

Create `src/client/GitHubReposView.tsx`:

```tsx
import { ExternalLink, Github, Trash2 } from 'lucide-react';
import type {
  GitHubConnectionState,
  GitHubRepoStatus,
  GitHubRepoWatch,
  GitHubReposState
} from './api';
import { EmptyState, Panel } from './ui/layout';
import { plural } from './ui/plural';
import { Button, Field, Input } from './ui/primitives';

const STATUS_LABELS: Record<GitHubRepoStatus, string> = {
  pending: 'Waiting',
  ok: 'Watching',
  not_found: 'Not found',
  rate_limited: 'Rate limited',
  needs_reauth: 'Needs reconnect',
  not_connected: 'Not connected',
  error: 'Check failed'
};

/** Reuses the shared `.connection-status` pill: `connected` is green, `error` is red. */
function statusClass(status: GitHubRepoStatus): string {
  if (status === 'ok') return 'connection-status connected';
  if (status === 'needs_reauth' || status === 'error' || status === 'not_found') {
    return 'connection-status error';
  }
  return 'connection-status';
}

/** What the card says about the connection itself. Null when there is nothing to say. */
export function connectionNotice(state: GitHubConnectionState): string | null {
  if (state === 'connected') return null;
  if (state === 'needs_reauth') {
    return 'GitHub needs reconnecting. Nothing is read until you reconnect it under Connections.';
  }
  return 'GitHub is not connected. Add it under Connections; until then no stars, forks or issues are read.';
}

function checkedCopy(repo: GitHubRepoWatch, formatTime: (iso: string) => string): string {
  const when = repo.lastPolledAt ? formatTime(repo.lastPolledAt) : 'recently';
  const summary = repo.lastSummary;
  if (!summary || summary.stars + summary.forks + summary.issues === 0) {
    return `Checked ${when}. Nothing new since the previous check.`;
  }
  const seen = [
    plural(summary.stars, 'new star'),
    plural(summary.forks, 'new fork'),
    plural(summary.issues, 'new issue')
  ].join(', ');
  const notes = [
    `${summary.attached + summary.created} matched to a company (${plural(summary.created, 'new account')})`,
    summary.unresolved > 0 ? `${summary.unresolved} not traceable to a company` : null,
    summary.ignoredRejected > 0
      ? `${summary.ignoredRejected} from companies marked not a fit`
      : null,
    summary.deferred > 0 ? `${summary.deferred} left for the next check` : null,
    summary.burstTruncated
      ? 'more stars arrived than one check reads, so the oldest were skipped'
      : null
  ].filter((note): note is string => note !== null);
  return `Checked ${when}: ${seen}. ${notes.join('; ')}.`;
}

export function repoStatusCopy(repo: GitHubRepoWatch, formatTime: (iso: string) => string): string {
  switch (repo.status) {
    case 'pending':
      return 'Waiting for the first check.';
    case 'not_connected':
      return 'Not checked: GitHub is not connected.';
    case 'needs_reauth':
      return 'Not checked: GitHub needs reconnecting.';
    case 'rate_limited':
      return `Paused by the GitHub rate limit until ${
        repo.rateLimitedUntil ? formatTime(repo.rateLimitedUntil) : 'it resets'
      }. Nothing is lost; checking resumes then.`;
    case 'not_found':
      return 'GitHub cannot find this repository, or it is private. Only public repositories can be watched.';
    case 'error':
      return `The last check failed (${repo.lastError ?? 'unknown error'}). Trevra tries again within the hour.`;
    case 'ok':
      return checkedCopy(repo, formatTime);
  }
}

export interface GitHubReposViewProps {
  state: GitHubReposState | null;
  error: string;
  isOwner: boolean;
  draft: string;
  /** 'add' while adding, a repository id while removing it, otherwise null. */
  busy: string | null;
  formatTime: (iso: string) => string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (repo: GitHubRepoWatch) => void;
}

export function GitHubReposView({
  state,
  error,
  isOwner,
  draft,
  busy,
  formatTime,
  onDraftChange,
  onAdd,
  onRemove
}: GitHubReposViewProps) {
  const notice = state ? connectionNotice(state.connection.state) : null;
  const atLimit = state !== null && state.repos.length >= state.limit;
  return (
    <Panel
      id="github-repos"
      title="GitHub repositories"
      description="Stars, forks and issues on your public repositories, matched to companies from public profile data. Read-only."
      icon={<Github size={16} aria-hidden="true" />}
    >
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="gh-repos-notice" role="status">
          {notice}
        </p>
      ) : null}
      {state === null ? (
        <p className="gh-repos-quiet">Loading watched repositories.</p>
      ) : state.repos.length === 0 ? (
        <EmptyState
          title="No repositories watched"
          description={
            isOwner
              ? 'Add a public repository you own, for example lemoncrow-lab/lemoncrow.'
              : 'The workspace owner chooses which repositories to watch.'
          }
        />
      ) : (
        <ul className="gh-repos-list">
          {state.repos.map((repo) => (
            <li className="gh-repos-row" key={repo.id}>
              <div className="gh-repos-main">
                <a href={repo.url} target="_blank" rel="noreferrer">
                  {repo.fullName} <ExternalLink size={12} aria-hidden="true" />
                </a>
                <span className={statusClass(repo.status)}>{STATUS_LABELS[repo.status]}</span>
                <p>{repoStatusCopy(repo, formatTime)}</p>
                {repo.unresolvedTotal > 0 ? (
                  <p>
                    {plural(repo.unresolvedTotal, 'person', 'people')} so far not traceable to a
                    company. Counted, not stored.
                  </p>
                ) : null}
              </div>
              {isOwner ? (
                <Button
                  variant="ghost"
                  aria-label={`Stop watching ${repo.fullName}`}
                  disabled={busy === repo.id}
                  onClick={() => onRemove(repo)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isOwner && state ? (
        <form
          className="gh-repos-add"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <Field
            label="Repository"
            hint={
              atLimit
                ? `You are watching the maximum of ${state.limit}. Remove one to add another.`
                : 'owner/name or a github.com link. Public repositories only.'
            }
          >
            <Input
              value={draft}
              placeholder="lemoncrow-lab/lemoncrow"
              autoComplete="off"
              spellCheck={false}
              disabled={atLimit || busy === 'add'}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            type="submit"
            disabled={atLimit || busy === 'add' || draft.trim() === ''}
          >
            Watch repository
          </Button>
        </form>
      ) : null}
    </Panel>
  );
}
```

The JSX text `{plural(...)} so far not traceable to a company. Counted, not stored.` renders as one string in the static markup only if it is on one logical line; if Prettier wraps it as above, React still renders the words joined by single spaces, which is what the test asserts.

Create `src/client/GitHubReposPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { getGitHubRepos, unwatchGitHubRepo, watchGitHubRepo, type GitHubReposState } from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { GitHubReposView } from './GitHubReposView';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import './github-repos.css';

/** Setup -> Workspace: which public repositories feed GitHub traction signals. */
export function GitHubReposPanel({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [state, setState] = useState<GitHubReposState | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await getGitHubRepos());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to load watched repositories.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const fullName = draft.trim();
    if (!fullName) return;
    setBusy('add');
    try {
      const repo = await watchGitHubRepo(fullName);
      setDraft('');
      setToast(`Watching ${repo.fullName}.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to watch that repository.'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (repoId: string, fullName: string) => {
    setBusy(repoId);
    try {
      await unwatchGitHubRepo(repoId);
      setToast(`Stopped watching ${fullName}.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to stop watching that repository.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <GitHubReposView
      state={state}
      error={error}
      isOwner={isOwner}
      draft={draft}
      busy={busy}
      formatTime={relativeTime}
      onDraftChange={setDraft}
      onAdd={() => void add()}
      onRemove={(repo) => void remove(repo.id, repo.fullName)}
    />
  );
}
```

Create `src/client/github-repos.css`:

```css
/* Setup -> Workspace -> GitHub repositories. Composition only: controls come
   from ui/primitives and the status pill is the shared .connection-status. */
.gh-repos-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.gh-repos-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--t-line-soft);
}

.gh-repos-row:last-child {
  border-bottom: 0;
}

.gh-repos-main {
  display: grid;
  justify-items: start;
  gap: 4px;
  min-width: 0;
}

.gh-repos-main a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: var(--t-w-strong);
  overflow-wrap: anywhere;
}

.gh-repos-main p,
.gh-repos-quiet {
  margin: 0;
  color: var(--t-muted);
  font-size: var(--t-text-sm);
}

.gh-repos-notice {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--t-amber-line);
  border-radius: var(--t-r-md);
  background: var(--t-amber-bg);
  color: var(--t-amber-ink);
  font-size: var(--t-text-sm);
}

.gh-repos-add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
  margin-top: 16px;
}

@media (max-width: 640px) {
  .gh-repos-add {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

In `src/client/App.tsx`, after the line `import { BillingSettings } from './BillingSettings';` add:

```tsx
import { GitHubReposPanel } from './GitHubReposPanel';
```

In `SetupView`, inside `<PageGrid columns={2} className="workspace-reference-grid">`, insert directly after the self-closing `<ConnectionsView ... />` element:

```tsx
<GitHubReposPanel setToast={setToast} />
```

In `src/client/AccountsScreen.tsx`:

1. Add to `KIND_LABELS` as the last entries before `};` (comma after the entry that is currently last):

```ts
  'repo-starred': 'Starred your GitHub repo',
  'repo-forked': 'Forked your GitHub repo',
  'repo-issue-opened': 'Opened an issue on your GitHub repo'
```

2. After `const [showAddMore, setShowAddMore] = useState(false);` add:

```ts
/** '' shows every account; 'github' only the ones GitHub activity created. */
const [originFilter, setOriginFilter] = useState<'' | 'github'>('');
```

3. In `load`, change the call to `getRankedAccounts({ limit: 200, source: originFilter || undefined })` and the dependency array from `[]` to `[originFilter]`.

4. Change the ranked section's opening condition from `{accounts.length > 0 && (` to `{(accounts.length > 0 || originFilter !== '') && (`, and make the first child of `<div className="acc-heading-actions">` this filter:

```tsx
<Select
  aria-label="Which accounts to show"
  value={originFilter}
  onChange={(event) => setOriginFilter(event.target.value === 'github' ? 'github' : '')}
>
  <option value="">All accounts</option>
  <option value="github">Created from GitHub activity</option>
</Select>
```

5. Directly after the closing `</div>` of `<div className="acc-list">`, inside the same `<section>`, add:

```tsx
{
  accounts.length === 0 && (
    <p className="acc-filter-empty">No accounts have been created from GitHub activity yet.</p>
  );
}
```

6. Change the "Add more accounts" branch condition from `{accounts.length > 0 ? (` to `{accounts.length > 0 || originFilter !== '' ? (`, so an empty filter result never drops the founder into the first-run import screen.

In `src/client/styles.css`, directly after the `.acc-heading-actions button { ... }` rule, add:

```css
.acc-filter-empty {
  margin: 0;
  padding: 16px 0;
  color: var(--t-muted);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-with-postgres.ts src/client/GitHubReposView.test.tsx src/client/ui/route.test.ts && npm run typecheck`
Expected: PASS (5 new tests; the route test still finds no `#/` literal or `location.hash`), and `tsc --noEmit` exits 0.

Then check the screen by hand: `npm run dev`, open `/setup/workspace` as the owner in light and dark themes and at 375 px width. Expected: the GitHub card sits after Connections, shows "GitHub is not connected" in the amber notice, the add form stacks to one column on mobile, the remove button has a visible focus ring and is at least `--t-tap` high. On `/research` (Accounts), the "Which accounts to show" select filters to GitHub-created accounts and an empty result shows the one-line message, not the import screen.

- [ ] **Step 5: Commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/client/api.ts src/client/GitHubReposView.tsx src/client/GitHubReposPanel.tsx src/client/github-repos.css src/client/GitHubReposView.test.tsx src/client/App.tsx src/client/AccountsScreen.tsx src/client/styles.css
git commit -m "feat(github): Setup card for watched repositories and accounts origin filter" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

### Task 9: Phase sweep and gate

**Files:**

- Modify only what the sweep below finds missing (no new behaviour).
- Test: the whole suite via `npm run check`.

**Interfaces:**

- Consumes: everything above.
- Produces: a green `npm run check` on the phase.

- [ ] **Step 1: Sweep the phase diff for omissions**

Run:

```bash
git diff --stat main...HEAD
git grep -n "repo-starred\|repo-forked\|repo-issue-opened" -- src docs
git grep -n "github-traction\|NANGO_GITHUB_INTEGRATION" -- src docs .env.example
git grep -n "#/\|location.hash" -- src/client/GitHubReposView.tsx src/client/GitHubReposPanel.tsx
ls migrations | grep github_repo_signals
```

Expected:

- The three kinds appear in `src/server/accounts/types.ts`, `src/server/accounts/score.ts` (weights and labels), `src/server/accounts/score.test.ts`, `src/server/github/poll.ts`, `src/client/AccountsScreen.tsx` and `docs/integration-contracts.md`.
- `github-traction` appears in `src/server/github/poll.ts` and `docs/integration-contracts.md`; `NANGO_GITHUB_INTEGRATION` in `src/server/integration-service.ts`, its test, `.env.example` and the docs.
- No `#/` or `location.hash` in the new client files.
- Exactly one `132_github_repo_signals.sql` (or the renumbered file from Task 3 Step 0).
- No file outside the lists in Tasks 1-8 changed, and no new dependency in `package.json` (so `npm audit --omit=dev` is not required; no `infra/` change, so `terraform validate` and `docker compose config` are not required).

If anything is missing, fix it in the owning file before Step 2.

- [ ] **Step 2: Run the gate**

Run: `npm run check`
Expected: exit 0 (full Vitest suite on PostgreSQL, catalog build, typecheck, Vite build and server `tsc`).

- [ ] **Step 3: Commit (only if Step 1 changed something)**

```bash
git add -A src docs .env.example migrations
git commit -m "chore(github): phase C sweep" -m "Claude-Session: https://claude.ai/code/session_01Y4HrhqeSUkRAmdUP5FAWU7"
```

---

## Self-Review

**1. Spec coverage**

| Requirement (phase brief / roadmap)                                                                | Task                                                                                   |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Connect GitHub through Nango, catalog entry, provider key cited                                    | Task 2 (provider `github`, citations in header)                                        |
| Owner lists watched repos `owner/name`, max 10, on an existing setup screen                        | Task 3 (store, cap, 409), Task 7 (owner-only API), Task 8 (card on `/setup/workspace`) |
| Poll via Nango proxy: stargazers with `star+json`, forks, issues by non-members                    | Task 4 (transport), Task 5 (listings, insider/PR/bot filtering)                        |
| Per-repo cursors and ETags in `watched_repositories`                                               | Task 3 (columns), Task 5 (cursor advance, ETag reuse and clearing)                     |
| Respect rate limits                                                                                | Task 4 (`RATE_LIMIT_RESERVE`, 403/429/retry-after), Task 5 (reschedule to reset)       |
| `lc-debt` on polling with webhook upgrade path                                                     | Task 5 (`poll.ts` header, `MAX_STAR_PAGES`), Task 3 (`MAX_WATCHED_REPOSITORIES`)       |
| Resolve via blog domain, public email (skip freemail), `@org` with website; never invent           | Task 4 (`resolve.ts`, `public-domains.ts`)                                             |
| Attach on domain match; create only from resolved non-freemail domain, capped, distinct source/tag | Task 5 (`MAX_NEW_ACCOUNTS_PER_RUN`, `source 'github'`, tag), Task 7/8 (filter)         |
| Respect `not_a_fit` / `archived`, never reactivate                                                 | Task 5 (domain and remembered-login paths)                                             |
| Unresolved counted, not stored                                                                     | Task 3 (`unresolved_total`), Task 5, Task 8 (copy)                                     |
| evidenceUrl = profile or issue URL; content-free detail                                            | Task 5 (`signalFor`)                                                                   |
| Minimal personal data in export and erasure                                                        | Task 3 (cascade + catalogue test), Task 7 (export test)                                |
| Honest state for revoked connection and rate-limit exhaustion                                      | Task 3 (`readGitHubConnection`, statuses), Task 5, Task 6, Task 8                      |
| Kinds in `ACCOUNT_SIGNAL_KINDS` and `weightFor`; via `recordSignals` then rescore                  | Task 1, Task 5                                                                         |
| No Today kinds; strong accounts as `high_priority_account`                                         | Task 5 (Today test)                                                                    |
| Migration `132_*` with number check                                                                | Task 3 Step 0                                                                          |
| Release downloads (P1 row)                                                                         | Out of scope by phase brief; named in the header                                       |

**2. Placeholder scan:** every code step carries complete code; no "TBD", "add error handling" or "similar to Task N". Edits to existing files name an exact anchor line that exists whether or not Phases A and B ran first.

**3. Type consistency:** `WatchedRepository`, `PollSummary`, `RepositoryPatch`, `GitHubConnectionState` (Task 3) are used unchanged in Tasks 5-7; the client mirrors them as `GitHubRepoWatch`, `GitHubPollSummary`, `GitHubConnectionState` (Task 8) with the same field names. `GitHubClient(transport, now)` and its error classes (Task 4) match their use in `resolve.ts` and `poll.ts`. `pollWorkspaceRepositories(db, workspaceId, deps?, opts?)` matches Task 6. `RankedAccountsOptions.source?: AccountSource` matches the Zod enum and the client's `getRankedAccounts`.

**4. Review Focus:** each of the five lines has its test in the owning task (Tasks 4, 5 and 8 as named in the Review Focus section). Other implied inputs already covered by task tests: freemail and platform domains (Task 4, Task 5), member/owner permissions (Task 7), cross-workspace removal (Task 3, Task 7), backfill window and members' issues/PRs/bots (Task 5), burst larger than three pages (Task 5), missing Nango key (Task 6), unknown or private repository (Task 5).
