import { createHmac } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { registerLeadCaptureIntake } from './http.js';
import { createCaptureSource } from './sources.js';
import { LeadCaptureError } from './types.js';
import {
  listProductMilestones,
  recordProductMilestone,
  type RecordProductMilestoneInput
} from './milestone-recorder.js';

vi.mock('./milestone-recorder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./milestone-recorder.js')>();
  return { ...actual, recordProductMilestone: vi.fn(actual.recordProductMilestone) };
});

const WS = 'ws_milestone_recorder';
const OTHER = 'ws_milestone_recorder_other';
const USER = 'usr_milestone_recorder';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let app: Express;
let sourceId = '';
let sourceSecret = '';
let contactId = '';
let accountId = '';
let foreignContactId = '';

async function seedContact(workspaceId: string, email: string): Promise<string> {
  const contact = id('con');
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(contact, workspaceId, 'Ada Lovelace', email, email, NOW.toISOString(), NOW.toISOString());
  return contact;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>(...params);
  return Number(row?.n ?? 0);
}

function milestone(overrides: Partial<RecordProductMilestoneInput>): RecordProductMilestoneInput {
  return {
    workspaceId: WS,
    kind: 'activated',
    contactId,
    accountId,
    sourceType: 'inbound_submission',
    sourceId: 'sub_default',
    occurredAt: NOW,
    ...overrides
  };
}

function intake(key: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', sourceSecret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`, 'utf8'), Buffer.from(raw, 'utf8')]))
    .digest('hex');
  return request(app)
    .post('/api/intake/v1/submissions')
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', sourceId)
    .set('X-Trevra-Timestamp', String(timestamp))
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${signature}`)
    .send(raw);
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = express();
  registerLeadCaptureIntake(app, db);
});

beforeEach(async () => {
  for (const workspaceId of [WS, OTHER]) {
    // inbound_submissions RESTRICTs deleting its Person; remove it first.
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'owner@milestones.test', 'Owner', NOW.toISOString());
  contactId = await seedContact(WS, 'ada@acme-milestone.example');
  foreignContactId = await seedContact(OTHER, 'ada@acme-milestone.example');
  accountId = id('acc');
  await db
    .prepare(
      "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
    )
    .run(
      accountId,
      WS,
      'Acme Milestone',
      'acme-milestone.example',
      NOW.toISOString(),
      NOW.toISOString()
    );
  const created = await createCaptureSource(db, {
    workspaceId: WS,
    actorUserId: USER,
    name: 'Product',
    kind: 'signup'
  });
  sourceId = created.source.id;
  sourceSecret = created.secret;
});

afterAll(async () => {
  for (const workspaceId of [WS, OTHER]) {
    await db?.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('recordProductMilestone', () => {
  it('records paid before activated, and duplicates, as one payment and one forward move', async () => {
    const paid = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_1',
        externalObjectId: 'in_1'
      }),
      NOW
    );
    expect(paid).toMatchObject({
      created: true,
      signalsWritten: 1,
      opportunity: { stage: 'won', created: true }
    });

    const late = await recordProductMilestone(
      db,
      milestone({ kind: 'activated', sourceId: 'sub_late_activation' }),
      NOW
    );
    expect(late.created).toBe(true);
    expect(late.opportunity).toBeNull();

    const again = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_2',
        externalObjectId: 'in_2'
      }),
      NOW
    );
    expect(again).toMatchObject({
      created: false,
      signalsWritten: 0,
      opportunity: { changed: false }
    });
    expect(again.milestone.id).toBe(paid.milestone.id);

    const replay = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid_1',
        externalObjectId: 'in_1'
      }),
      NOW
    );
    expect(replay.milestone.id).toBe(paid.milestone.id);

    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND kind='paid'",
        WS
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals WHERE workspace_id=? AND kind='customer-paid'",
        WS
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='won' AND closed_at IS NOT NULL",
        WS
      )
    ).toBe(1);
  });

  it('moves activation to qualified, then payment to won, on the same Opportunity', async () => {
    const activated = await recordProductMilestone(
      db,
      milestone({ sourceId: 'sub_activation' }),
      NOW
    );
    expect(activated.opportunity).toMatchObject({ stage: 'qualified', created: true });
    const paid = await recordProductMilestone(
      db,
      milestone({
        kind: 'paid',
        sourceType: 'stripe_event',
        sourceId: 'evt_paid',
        externalObjectId: 'cs_1'
      }),
      NOW
    );
    expect(paid.opportunity).toMatchObject({
      opportunityId: activated.opportunity!.opportunityId,
      previousStage: 'qualified',
      stage: 'won',
      changed: true
    });
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(1);
  });

  it('records a cancellation without moving the stage, once per subscription', async () => {
    const first = await recordProductMilestone(
      db,
      milestone({
        kind: 'cancelled',
        sourceType: 'stripe_event',
        sourceId: 'evt_cancel_1',
        externalObjectId: 'sub_123'
      }),
      NOW
    );
    const second = await recordProductMilestone(
      db,
      milestone({
        kind: 'cancelled',
        sourceType: 'stripe_event',
        sourceId: 'evt_cancel_2',
        externalObjectId: 'sub_123'
      }),
      NOW
    );
    expect(first).toMatchObject({ created: true, signalsWritten: 1, opportunity: null });
    expect(second).toMatchObject({ created: false, signalsWritten: 0, opportunity: null });
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS)
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals WHERE workspace_id=? AND kind='customer-cancelled'",
        WS
      )
    ).toBe(1);
  });

  it('writes the signal with an in-app evidence link and rescores the account', async () => {
    const recorded = await recordProductMilestone(
      db,
      milestone({ kind: 'signed_up', sourceId: 'sub_signup' }),
      NOW
    );
    const signal = await db
      .prepare(
        'SELECT kind,detail,current,evidence_url FROM account_signals WHERE workspace_id=? AND account_id=?'
      )
      .get<Record<string, string>>(WS, accountId);
    expect(signal).toEqual({
      kind: 'product-signed-up',
      detail: 'A person at this account signed up.',
      current: `milestone:${recorded.milestone.id}`,
      evidence_url: `/outreach/inbound?milestone=${recorded.milestone.id}`
    });
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM account_scores WHERE workspace_id=? AND account_id=?',
        WS,
        accountId
      )
    ).toBe(1);
    expect(recorded.opportunity).toBeNull();
  });

  it('refuses a Person from another workspace', async () => {
    await expect(
      recordProductMilestone(
        db,
        milestone({ contactId: foreignContactId, sourceId: 'sub_foreign' }),
        NOW
      )
    ).rejects.toBeInstanceOf(LeadCaptureError);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id IN (?,?)',
        WS,
        OTHER
      )
    ).toBe(0);
  });
});

describe('signed intake', () => {
  it('records a milestone kind and keeps the submission as provenance', async () => {
    const occurredAt = new Date(Date.now() - 86_400_000).toISOString();
    const body = {
      kind: 'activated',
      occurredAt,
      person: { email: 'ada@acme-milestone.example' },
      company: { domain: 'acme-milestone.example' }
    };
    const first = await intake('milestone-activated-0001', body).expect(202);
    const second = await intake('milestone-activated-0001', body).expect(200);
    expect(second.body.duplicate).toBe(true);

    const rows = await listProductMilestones(db, WS, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'activated',
      sourceType: 'inbound_submission',
      sourceId: first.body.submissionId,
      contactId,
      accountId,
      occurredAt,
      label: 'activated',
      accountName: 'Acme Milestone'
    });
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='qualified'",
        WS
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM inbound_submissions WHERE workspace_id=?', WS)
    ).toBe(1);
  });

  it('answers 5xx without counting a rejection when the recorder fails, then heals on replay', async () => {
    const body = {
      kind: 'activated',
      person: { email: 'ada@acme-milestone.example' },
      company: { domain: 'acme-milestone.example' }
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(recordProductMilestone).mockRejectedValueOnce(new Error('boom'));
    const failed = await intake('milestone-retry-0001', body);
    expect(failed.status).toBe(503);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS)
    ).toBe(0);
    expect(
      await count('SELECT rejected_count AS n FROM capture_sources WHERE id=?', sourceId)
    ).toBe(0);

    const replay = await intake('milestone-retry-0001', body).expect(200);
    expect(replay.body.duplicate).toBe(true);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS)
    ).toBe(1);
  });

  it('leaves an ordinary inbound kind alone', async () => {
    await intake('milestone-demo-0001', {
      kind: 'demo_request',
      person: { email: 'ada@acme-milestone.example' }
    }).expect(202);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS)
    ).toBe(0);
  });
});
