import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { compileGtmIntent, GtmPlanError, prepareGtmPlan } from '../gtm/intent.js';
import { deleteWorkspaceSecret, putWorkspaceSecret } from '../secrets/store.js';
import { createSuppression } from '../suppressions.js';
import {
  EnrichmentProviderError,
  estimateEnrichmentCredits,
  type ContactEnrichmentProvider,
  type EmailVerificationStatus,
  type EnrichmentCandidate,
  type EnrichmentProviderErrorCode
} from './provider.js';
import { pruneEnrichmentHistory, queueEnrichmentRun, runQueuedEnrichmentRuns } from './runs.js';
import {
  EnrichmentError,
  enrichmentUsage,
  getEnrichmentSettings,
  setEnrichmentCap,
  setEnrichmentKeyStatus
} from './settings.js';

const WORKSPACE = 'ws_enrichment_runs';
const USER = 'usr_enrichment_runs';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

function candidate(
  email: string,
  sourceUri: string | null = 'https://acme.com/team'
): EnrichmentCandidate {
  return {
    email,
    firstName: 'Maya',
    lastName: 'Chen',
    position: 'CEO',
    sourceUri,
    providerConfidence: 90
  };
}

function fakeHunter(script: {
  search?: Record<string, EnrichmentCandidate[]>;
  verify?: Record<string, EmailVerificationStatus>;
  failVerifyWith?: EnrichmentProviderErrorCode;
  /** Runs inside domainSearch, while the paid call is in flight. */
  duringSearch?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const provider: ContactEnrichmentProvider = {
    id: 'hunter',
    async checkKey() {},
    async domainSearch(domain, { limit }) {
      calls.push(`search:${domain}:${limit}`);
      await script.duringSearch?.();
      const candidates = script.search?.[domain] ?? [];
      return { candidates, credits: candidates.length };
    },
    async verifyEmail(email) {
      calls.push(`verify:${email}`);
      if (script.failVerifyWith) throw new EnrichmentProviderError('fake', script.failVerifyWith);
      // Hunter charges every terminal verification (provider.ts).
      return { status: script.verify?.[email] ?? 'valid', credits: 0.5 };
    }
  };
  return { calls, providerFor: () => provider };
}

async function queue(
  key: string,
  domains: string[],
  options: { emailsPerDomain?: number; includeUnverified?: boolean; estimatedCredits?: number } = {}
) {
  const emailsPerDomain = options.emailsPerDomain ?? 3;
  return queueEnrichmentRun(
    db,
    {
      workspaceId: WORKSPACE,
      actorType: 'user',
      actorUserId: USER,
      idempotencyKey: key,
      planHash: 'd'.repeat(64),
      domains,
      emailsPerDomain,
      includeUnverified: options.includeUnverified ?? false,
      estimatedCredits:
        options.estimatedCredits ??
        estimateEnrichmentCredits({ domains: domains.length, emailsPerDomain }).estimatedCredits
    },
    NOW
  );
}

async function runRow(runId: string) {
  return db
    .prepare(
      'SELECT status, attempts, last_error, lease_until, progress_json FROM enrichment_runs WHERE id=?'
    )
    .get<{
      status: string;
      attempts: number;
      last_error: string | null;
      lease_until: string | null;
      progress_json: unknown;
    }>(runId);
}

async function ledgerTotal(runId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(credits),0) AS total FROM enrichment_usage_ledger WHERE run_id=?')
    .get<{ total: string }>(runId);
  return Number(row?.total ?? 0);
}

/**
 * Holds the workspace's cap lock from another session, so the test can prove
 * that concurrent approvals queue up behind it before reading the cap.
 */
async function holdCapLock() {
  const key = `${WORKSPACE}:enrichment-cap`;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))').get(key);
    locked();
    await released;
  });
  await isLocked;
  const waiters = async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM pg_locks
         WHERE locktype='advisory' AND NOT granted
           AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(?::text, 0)`
      )
      .get<{ n: string }>(key);
    return Number(row?.n ?? 0);
  };
  return {
    async waitForWaiters(count: number): Promise<number> {
      let seen = await waiters();
      for (let tries = 0; tries < 100 && seen < count; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen = await waiters();
      }
      return seen;
    },
    async release() {
      release();
      await holder;
    }
  };
}

async function savedEmails(): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT c.email_normalized FROM account_contacts ac JOIN contacts c ON c.id=ac.contact_id
       WHERE ac.workspace_id=? ORDER BY c.email_normalized`
    )
    .all<{ email_normalized: string }>(WORKSPACE);
  return rows.map((row) => row.email_normalized);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Enrichment runs', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'enrichment-runs@trevra.test', 'Founder', NOW.toISOString());
  await putWorkspaceSecret(db, {
    workspaceId: WORKSPACE,
    kind: 'hunter_api_key',
    plaintext: 'hunter-runs-key-0001',
    actorUserId: USER
  });
  await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
  await setEnrichmentCap(db, WORKSPACE, 50, USER, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('enrichment runs', () => {
  it('queues an approved run once and records a content-free approval event', async () => {
    const first = await queue('enrich-key-0001', ['acme.com']);
    expect(first.duplicate).toBe(false);
    expect(first.run).toMatchObject({ status: 'queued', domainCount: 1, estimatedCredits: 4.5 });
    const again = await queue('enrich-key-0001', ['acme.com']);
    expect(again).toMatchObject({ duplicate: true, run: { id: first.run.id } });
    const conflict = await queueEnrichmentRun(
      db,
      {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        idempotencyKey: 'enrich-key-0001',
        planHash: 'e'.repeat(64),
        domains: ['acme.com'],
        emailsPerDomain: 3,
        includeUnverified: false,
        estimatedCredits: 4.5
      },
      NOW
    ).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(EnrichmentError);
    expect((conflict as EnrichmentError).status).toBe(409);
    const events = await db
      .prepare(
        "SELECT actor_type, payload_json FROM domain_events WHERE workspace_id=? AND event_type='enrichment_run.approved'"
      )
      .all<{ actor_type: string; payload_json: unknown }>(WORKSPACE);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_type).toBe('user');
    expect(JSON.stringify(events[0]!.payload_json)).not.toContain('acme.com');
  });

  it('two concurrent approvals cannot both reserve past the cap', async () => {
    await setEnrichmentCap(db, WORKSPACE, 10, USER, NOW);
    const lock = await holdCapLock();
    let racing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof queue>>>[]>;
    try {
      racing = Promise.allSettled([
        queue('enrich-race-a001', ['acme.com', 'northstar.ai']),
        queue('enrich-race-b001', ['beta.io', 'gamma.io'])
      ]);
      // Both approvals wait on the workspace lock before reading the cap.
      expect(await lock.waitForWaiters(2)).toBe(2);
    } finally {
      await lock.release();
    }
    const results = await racing;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EnrichmentError);
    expect((rejected.reason as EnrichmentError).status).toBe(409);
    expect((await enrichmentUsage(db, WORKSPACE, NOW)).reservedCredits).toBe(9);
  });

  it('two concurrent prepares whose estimates exceed the cap: exactly one succeeds', async () => {
    await setEnrichmentCap(db, WORKSPACE, 10, USER, NOW);
    const planA = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['acme.com', 'northstar.ai'] }
    });
    const planB = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['beta.io', 'gamma.io'] }
    });
    expect(planA.blockers).toEqual([]);
    expect(planB.blockers).toEqual([]);
    const results = await Promise.allSettled(
      [planA, planB].map((plan, index) =>
        prepareGtmPlan(db, {
          workspaceId: WORKSPACE,
          actorType: 'user',
          actorUserId: USER,
          actorRole: 'owner',
          plan,
          planHash: plan.planHash,
          idempotencyKey: `enrich-prep-race-${index}`
        })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(GtmPlanError);
    expect((rejected.reason as GtmPlanError).status).toBe(409);
    expect((await enrichmentUsage(db, WORKSPACE, new Date())).reservedCredits).toBe(9);
  });

  it('saves only sourced, verified emails on the searched domain and charges every call', async () => {
    const { run } = await queue('enrich-save-0001', ['acme.com'], { emailsPerDomain: 4 });
    const hunter = fakeHunter({
      search: {
        'acme.com': [
          candidate('maya@acme.com'),
          candidate('sam@acme.com'),
          candidate('ghost@acme.com', null),
          candidate('other@elsewhere.com')
        ]
      },
      verify: { 'maya@acme.com': 'valid', 'sam@acme.com': 'accept_all' }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual([
      'search:acme.com:4',
      'verify:maya@acme.com',
      'verify:sam@acme.com'
    ]);
    expect((await runRow(run.id))?.status).toBe('completed');
    expect(await ledgerTotal(run.id)).toBe(5);
    const links = await db
      .prepare(
        `SELECT c.email_normalized, ac.source, ac.confidence, ac.source_detail
         FROM account_contacts ac JOIN contacts c ON c.id=ac.contact_id
         WHERE ac.workspace_id=? ORDER BY c.email_normalized`
      )
      .all(WORKSPACE);
    expect(links).toEqual([
      {
        email_normalized: 'maya@acme.com',
        source: 'enrichment',
        confidence: 'verified',
        source_detail: 'hunter https://acme.com/team'
      }
    ]);
    // A saved Person has no lawful basis until the founder records one.
    const bases = await db
      .prepare('SELECT COUNT(*) AS n FROM contact_lawful_bases WHERE workspace_id=?')
      .get<{ n: string }>(WORKSPACE);
    expect(Number(bases?.n)).toBe(0);
  });

  it('saves accept-all emails as inferred only when the plan opts in', async () => {
    await queue('enrich-loose-0001', ['acme.com'], { emailsPerDomain: 1, includeUnverified: true });
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      verify: { 'maya@acme.com': 'accept_all' }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    const link = await db
      .prepare('SELECT confidence FROM account_contacts WHERE workspace_id=?')
      .get<{ confidence: string }>(WORKSPACE);
    expect(link?.confidence).toBe('inferred');
  });

  it('a suppressed domain costs nothing and a suppressed email is never verified or saved', async () => {
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'all',
        domain: 'acme.com',
        reason: 'Asked not to be contacted',
        source: 'manual'
      },
      NOW
    );
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'email',
        email: 'nora@northstar.ai',
        reason: 'Unsubscribed',
        source: 'manual'
      },
      NOW
    );
    const { run } = await queue('enrich-suppr-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: {
        'acme.com': [candidate('maya@acme.com')],
        'northstar.ai': [
          candidate('nora@northstar.ai', 'https://northstar.ai/team'),
          candidate('ben@northstar.ai', 'https://northstar.ai/team')
        ]
      }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:northstar.ai:3', 'verify:ben@northstar.ai']);
    expect(await ledgerTotal(run.id)).toBe(2.5);
    expect(await savedEmails()).toEqual(['ben@northstar.ai']);
    expect(await runRow(run.id)).toMatchObject({ status: 'completed' });
    const progress = (await runRow(run.id))?.progress_json as { skipped: number; saved: number };
    expect(progress).toMatchObject({ doneDomains: 2, saved: 1, skipped: 1 });
  });

  it('a revoked key fails the run and marks the key invalid', async () => {
    const { run } = await queue('enrich-revoked-01', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      failVerifyWith: 'key_invalid'
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3', 'verify:maya@acme.com']);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Hunter rejected the saved key. Replace it and re-plan.'
    });
    expect(await ledgerTotal(run.id)).toBe(1);
    expect((await getEnrichmentSettings(db, WORKSPACE)).keyStatus).toBe('invalid');
    const replan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['acme.com'] }
    });
    expect(replan.blockers.map((blocker) => blocker.code)).toContain('enrichment_key_invalid');
  });

  it('a key the owner replaced mid-run is not marked invalid by the old key failing', async () => {
    const { run } = await queue('enrich-replace-01', ['acme.com']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      failVerifyWith: 'key_invalid',
      async duringSearch() {
        await putWorkspaceSecret(db, {
          workspaceId: WORKSPACE,
          kind: 'hunter_api_key',
          plaintext: 'hunter-runs-key-0002',
          actorUserId: USER
        });
        await setEnrichmentKeyStatus(db, WORKSPACE, 'valid', NOW);
      }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Hunter rejected the saved key. Replace it and re-plan.'
    });
    expect((await getEnrichmentSettings(db, WORKSPACE)).keyStatus).toBe('valid');
  });

  it('a key deleted before the run starts fails it without calling Hunter', async () => {
    const { run } = await queue('enrich-deleted-01', ['acme.com']);
    await deleteWorkspaceSecret(db, WORKSPACE, 'hunter_api_key', USER);
    const hunter = fakeHunter({});
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual([]);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'The Hunter key was removed before this run finished.'
    });
  });

  it('stops before spending past the approved estimate when the provider over-delivers', async () => {
    const { run } = await queue('enrich-over-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: {
        'acme.com': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((local) =>
          candidate(`${local}@acme.com`)
        )
      }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    // The ledger records what the provider reported, never a clamped figure.
    expect(await ledgerTotal(run.id)).toBe(10);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Stopped before exceeding the approved credit estimate.'
    });
  });

  it('a run approved at the whole cap does not count its own reservation against it', async () => {
    await setEnrichmentCap(db, WORKSPACE, 10, USER, NOW);
    const { run } = await queue('enrich-whole-0001', ['acme.com', 'northstar.ai'], {
      estimatedCredits: 10
    });
    const team = (domain: string) =>
      ['a', 'b', 'c'].map((local) => candidate(`${local}@${domain}`, `https://${domain}/team`));
    const hunter = fakeHunter({
      search: { 'acme.com': team('acme.com'), 'northstar.ai': team('northstar.ai') }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toHaveLength(8);
    expect(await ledgerTotal(run.id)).toBe(9);
    expect(await runRow(run.id)).toMatchObject({ status: 'completed', last_error: null });
    expect(await savedEmails()).toHaveLength(6);
  });

  it('lowering the cap after approval stops a queued run before any call', async () => {
    const { run } = await queue('enrich-lower-0001', ['acme.com']);
    await setEnrichmentCap(db, WORKSPACE, 2, USER, NOW);
    const hunter = fakeHunter({ search: { 'acme.com': [candidate('maya@acme.com')] } });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual([]);
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: "Stopped at this month's Hunter credit cap."
    });
    const failed = await db
      .prepare(
        "SELECT payload_json FROM domain_events WHERE workspace_id=? AND event_type='enrichment_run.failed'"
      )
      .get<{ payload_json: unknown }>(WORKSPACE);
    expect(failed?.payload_json).toMatchObject({ reason: 'cap_reached', creditsSpent: 0 });
  });

  it('releases a rate-limited run and fails it after three attempts', async () => {
    const { run } = await queue('enrich-limit-0001', ['acme.com']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      failVerifyWith: 'rate_limited'
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(await runRow(run.id)).toMatchObject({ status: 'queued', attempts: 1 });
    await db.prepare('UPDATE enrichment_runs SET attempts=3 WHERE id=?').run(run.id);
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(await runRow(run.id)).toMatchObject({
      status: 'failed',
      last_error: 'Stopped after 3 attempts.'
    });
  });

  it('a draining worker releases its run before the next paid call', async () => {
    const { run } = await queue('enrich-drain-0001', ['acme.com']);
    let draining = false;
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      async duringSearch() {
        draining = true;
      }
    });
    await runQueuedEnrichmentRuns(db, {
      now: NOW,
      providerFor: hunter.providerFor,
      shouldStop: () => draining
    });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    expect(await ledgerTotal(run.id)).toBe(1);
    expect(await runRow(run.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lease_until: null
    });
    // Still draining: nothing new is claimed.
    expect(
      await runQueuedEnrichmentRuns(db, {
        now: NOW,
        providerFor: hunter.providerFor,
        shouldStop: () => true
      })
    ).toEqual({ processed: 0 });
    expect((await runRow(run.id))?.status).toBe('queued');
  });

  it('a copy whose lease another replica took over stops before its next paid call', async () => {
    const { run } = await queue('enrich-lease-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      // Another replica re-claims the run (claimRun bumps attempts) while
      // this call is in flight.
      async duringSearch() {
        await db.prepare('UPDATE enrichment_runs SET attempts=attempts+1 WHERE id=?').run(run.id);
      }
    });
    await runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    // Left to the replica that holds it now: not finished, not released.
    expect(await runRow(run.id)).toMatchObject({
      status: 'running',
      attempts: 2,
      last_error: null
    });
  });

  it('a run row deleted mid-run is a clean stop with no further paid call', async () => {
    const { run } = await queue('enrich-gone-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      async duringSearch() {
        await db.prepare('DELETE FROM enrichment_runs WHERE id=?').run(run.id);
      }
    });
    await expect(
      runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor })
    ).resolves.toEqual({ processed: 1 });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
    expect(await runRow(run.id)).toBeUndefined();
  });

  it('a workspace erased mid-run is a clean stop, not a worker error', async () => {
    await queue('enrich-erase-0001', ['acme.com', 'northstar.ai']);
    const hunter = fakeHunter({
      search: { 'acme.com': [candidate('maya@acme.com')] },
      async duringSearch() {
        await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
      }
    });
    await expect(
      runQueuedEnrichmentRuns(db, { now: NOW, providerFor: hunter.providerFor })
    ).resolves.toEqual({ processed: 1 });
    expect(hunter.calls).toEqual(['search:acme.com:3']);
  });

  it('prepares an approved plan into one queued run, and a retry replays it', async () => {
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'enrich_contacts',
      audience: { domains: ['acme.com'] }
    });
    const prepare = (actorRole: 'owner' | 'member' = 'owner') =>
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: USER,
        actorRole,
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'enrich-prepare-01'
      });
    const first = await prepare();
    expect(first).toMatchObject({
      status: 'prepared',
      objective: 'enrich_contacts',
      next: { kind: 'review_accounts', href: '/outreach' },
      result: { duplicate: false, run: { status: 'queued', domainCount: 1, estimatedCredits: 4.5 } }
    });
    // The queued run now reserves credits, so a re-compiled plan differs;
    // the retry must replay by key instead of reporting the plan as stale.
    const retry = await prepare();
    expect(retry.artifacts).toEqual(first.artifacts);
    expect(retry).toMatchObject({ result: { duplicate: true } });
    // A member cannot read the queued run back through the owner's key.
    const asMember = await prepare('member').catch((caught: unknown) => caught);
    expect(asMember).toBeInstanceOf(GtmPlanError);
    expect((asMember as GtmPlanError).status).toBe(403);
  });

  it('prunes ledger rows and finished runs older than 13 months', async () => {
    await db
      .prepare(
        `INSERT INTO enrichment_runs
           (id,workspace_id,provider,idempotency_key,plan_hash,domains,emails_per_domain,estimated_credits,status,finished_at)
         VALUES ('enr_old',?,'hunter','old-key-000001',?,?,3,4.5,'completed','2025-08-01T00:00:00Z')`
      )
      .run(WORKSPACE, 'f'.repeat(64), ['acme.com']);
    await db
      .prepare(
        `INSERT INTO enrichment_usage_ledger (id,workspace_id,run_id,provider,operation,credits,occurred_at)
         VALUES ('enl_old',?,'enr_old','hunter','domain_search',3,'2025-08-01T00:00:00Z'),
                ('enl_new',?,'enr_new','hunter','domain_search',3,'2026-10-01T00:00:00Z')`
      )
      .run(WORKSPACE, WORKSPACE);
    await pruneEnrichmentHistory(db, NOW);
    const left = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM enrichment_runs WHERE id='enr_old') AS runs,
                (SELECT string_agg(id, ',') FROM enrichment_usage_ledger WHERE workspace_id=?) AS ledger`
      )
      .get<{ runs: string; ledger: string }>(WORKSPACE);
    expect(Number(left?.runs)).toBe(0);
    expect(left?.ledger).toBe('enl_new');
  });
});
