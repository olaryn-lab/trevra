import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { getToday } from './today.js';
import { buildDemandCandidates } from './demand/candidates.js';
import { createCaptureSource } from './lead-capture/sources.js';
import { acceptInboundSubmission } from './lead-capture/submissions.js';
import { recordProductMilestone } from './lead-capture/milestone-recorder.js';
import { isMilestoneKind } from './lead-capture/milestones.js';
import { HOT_SCORE } from './accounts/score.js';
import type { CaptureSourceRecord } from './lead-capture/types.js';

const WS = 'ws_today_milestones';
const USER = 'usr_today_milestones';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let source: CaptureSourceRecord;

async function clearWorkspace(): Promise<void> {
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(WS);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
}

async function submit(kind: string, email: string, key: string): Promise<string> {
  const accepted = await acceptInboundSubmission(db, {
    source,
    idempotencyKey: key,
    body: {
      kind,
      person: { name: 'Ada Lovelace', email },
      company: { domain: 'acme-today.io', name: 'Acme Today' }
    },
    payloadHash: `hash-${key}`,
    receivedAt: NOW
  });
  if (isMilestoneKind(kind))
    await recordProductMilestone(
      db,
      {
        workspaceId: WS,
        kind,
        contactId: accepted.contactId,
        accountId: accepted.accountId,
        sourceType: 'inbound_submission',
        sourceId: accepted.submission.id,
        occurredAt: NOW
      },
      NOW
    );
  return accepted.submission.id;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace();
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WS, 'Today Milestones', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'owner@today-milestones.test', 'Owner', NOW.toISOString());
  source = (
    await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Product',
      kind: 'signup'
    })
  ).source;
});

afterEach(async () => {
  if (db) await clearWorkspace();
  await db?.close();
});

describe('Today and demand treat milestones as outcomes', () => {
  it('reports milestones as results and cancellations as attention, never as inbound', async () => {
    const activated = await submit('activated', 'ada@acme-today.test', 'today-milestone-activated');
    const cancelled = await submit('cancelled', 'ada@acme-today.test', 'today-milestone-cancelled');
    const demo = await submit('demo_request', 'grace@acme-today.test', 'today-milestone-demo');

    const today = await getToday(db, WS, NOW);
    const inbound = today.needsAttention
      .filter((item) => item.kind === 'inbound_submission')
      .map((item) => item.reference.id);
    expect(inbound).toContain(demo);
    expect(inbound).not.toContain(activated);
    expect(inbound).not.toContain(cancelled);

    const result = today.recentResults.find((item) => item.kind === 'milestone_reached');
    expect(result).toMatchObject({
      title: 'Acme Today activated',
      priority: 25,
      reference: { type: 'product_milestone' }
    });
    expect(result?.href).toMatch(/^\/outreach\/inbound\?milestone=pm_[a-f0-9]{16}$/);

    const attention = today.needsAttention.find((item) => item.kind === 'customer_cancelled');
    expect(attention).toMatchObject({
      title: 'Acme Today cancelled',
      priority: 55,
      reference: { type: 'product_milestone' }
    });
  });

  it('never turns a milestone submission into demand evidence', async () => {
    const activated = await submit(
      'activated',
      'ada@acme-today.test',
      'demand-milestone-activated'
    );
    const paid = await submit('paid', 'ada@acme-today.test', 'demand-milestone-paid');
    // Make the account hot with a citable signal so the ONLY thing keeping the
    // milestone submissions out of demand is the milestone exclusion.
    const accountId = String(
      (
        await db
          .prepare('SELECT account_id FROM inbound_submissions WHERE id=? AND workspace_id=?')
          .get<{ account_id: string }>(activated, WS)
      )?.account_id
    );
    await db
      .prepare(
        `INSERT INTO account_signals (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        'sig_today_milestones',
        WS,
        accountId,
        'hiring-up',
        'Acme Today is hiring.',
        'https://acme-today.io/careers',
        NOW.toISOString(),
        'fp-today-milestones'
      );
    await db
      .prepare(
        `INSERT INTO account_scores (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,computed_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (workspace_id,account_id) DO UPDATE SET score=EXCLUDED.score,tier=EXCLUDED.tier,
           distinct_kinds=EXCLUDED.distinct_kinds,newest_signal_at=EXCLUDED.newest_signal_at`
      )
      .run(WS, accountId, HOT_SCORE, 'hot', 2, NOW.toISOString(), NOW.toISOString());
    const candidates = await buildDemandCandidates(db, WS, NOW);
    const evidenceIds = candidates
      .flatMap((candidate) => candidate.evidence)
      .filter((evidence) => evidence.sourceType === 'inbound_submission')
      .map((evidence) => evidence.sourceId);
    expect(evidenceIds).not.toContain(activated);
    expect(evidenceIds).not.toContain(paid);
  });
});
