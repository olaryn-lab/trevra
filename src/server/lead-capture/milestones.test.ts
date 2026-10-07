import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import {
  ACCOUNT_SIGNAL_KINDS,
  FIRST_PARTY_SIGNAL_KINDS,
  type AccountSignal
} from '../accounts/types.js';
import { HOT_SCORE, SIGNAL_WEIGHTS, scoreAccount } from '../accounts/score.js';
import {
  GTM_MILESTONE_KINDS,
  MILESTONE_KINDS_SQL,
  MILESTONE_MINIMUM_STAGE,
  MILESTONE_SIGNAL_KIND,
  isMilestoneKind,
  milestoneEvidencePath,
  milestoneKey
} from './milestones.js';

const WS = 'ws_milestone_vocabulary';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WS, WS, NOW.toISOString());
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db?.close();
});

describe('milestone vocabulary (roadmap contract 3)', () => {
  it('is the closed seven-kind list', () => {
    expect([...GTM_MILESTONE_KINDS]).toEqual([
      'signed_up',
      'activated',
      'integration_connected',
      'usage_threshold_crossed',
      'paid',
      'upgraded',
      'cancelled'
    ]);
    expect(isMilestoneKind('paid')).toBe(true);
    expect(isMilestoneKind('demo_request')).toBe(false);
    expect(isMilestoneKind(undefined)).toBe(false);
    expect(MILESTONE_KINDS_SQL).toBe(
      "('signed_up','activated','integration_connected','usage_threshold_crossed','paid','upgraded','cancelled')"
    );
  });

  it('maps each kind to its account-signal kind and minimum stage', () => {
    expect(MILESTONE_SIGNAL_KIND).toEqual({
      signed_up: 'product-signed-up',
      activated: 'product-activated',
      integration_connected: 'product-integration-connected',
      usage_threshold_crossed: 'product-usage-threshold',
      paid: 'customer-paid',
      upgraded: 'customer-upgraded',
      cancelled: 'customer-cancelled'
    });
    expect(MILESTONE_MINIMUM_STAGE).toEqual({
      signed_up: null,
      activated: 'qualified',
      integration_connected: 'qualified',
      usage_threshold_crossed: 'qualified',
      paid: 'won',
      upgraded: null,
      cancelled: null
    });
    expect(Object.values(MILESTONE_SIGNAL_KIND).sort()).toEqual(
      [...FIRST_PARTY_SIGNAL_KINDS].sort()
    );
    for (const kind of FIRST_PARTY_SIGNAL_KINDS) expect(ACCOUNT_SIGNAL_KINDS).toContain(kind);
  });

  it('keys one-time kinds per person, cancellations per object, the rest per source', () => {
    expect(
      milestoneKey({
        kind: 'paid',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_1',
        externalObjectId: 'in_1'
      })
    ).toBe('paid:contact:con_1');
    expect(
      milestoneKey({
        kind: 'signed_up',
        contactId: 'con_1',
        sourceType: 'inbound_submission',
        sourceId: 'sub_1'
      })
    ).toBe('signed_up:contact:con_1');
    expect(
      milestoneKey({
        kind: 'cancelled',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_2',
        externalObjectId: 'sub_9'
      })
    ).toBe('cancelled:object:sub_9');
    expect(
      milestoneKey({
        kind: 'cancelled',
        contactId: 'con_1',
        sourceType: 'inbound_submission',
        sourceId: 'sub_2'
      })
    ).toBe('cancelled:inbound_submission:sub_2');
    expect(
      milestoneKey({
        kind: 'upgraded',
        contactId: 'con_1',
        sourceType: 'stripe_event',
        sourceId: 'evt_3',
        externalObjectId: 'sub_9'
      })
    ).toBe('upgraded:stripe_event:evt_3');
    expect(milestoneEvidencePath('pm_abc')).toBe('/outreach/inbound?milestone=pm_abc');
  });
});

describe('first-party signal weights', () => {
  function signal(kind: string): AccountSignal {
    const observedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
    return {
      id: `sig_${kind}`,
      workspaceId: WS,
      accountId: 'acc_weights',
      kind,
      detail: kind,
      previous: null,
      current: `milestone:${kind}`,
      evidenceUrl: milestoneEvidencePath(kind),
      observedAt,
      fingerprint: `fp_${kind}`,
      createdAt: observedAt
    };
  }

  it('never lets one milestone make an account hot, and treats cancellation as negative', () => {
    for (const kind of FIRST_PARTY_SIGNAL_KINDS) {
      expect(SIGNAL_WEIGHTS[kind]).toBeLessThan(HOT_SCORE);
      expect(scoreAccount([signal(kind)], { now: NOW, rejectedShapes: [] }).tier).not.toBe('hot');
    }
    expect(SIGNAL_WEIGHTS['customer-cancelled']).toBeLessThan(0);
    expect(SIGNAL_WEIGHTS['product-activated']).toBeGreaterThan(
      SIGNAL_WEIGHTS['product-signed-up']
    );
    // A payment is already a won Opportunity; it must not push the account
    // toward new-outreach recommendations.
    expect(SIGNAL_WEIGHTS['customer-paid']).toBeLessThan(SIGNAL_WEIGHTS['product-signed-up']);
  });
});

describe('migration 130', () => {
  it('creates the three Phase A tables with their columns', async () => {
    const rows = await db
      .prepare(
        `SELECT table_name,column_name FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name IN ('provider_webhook_endpoints','product_milestones','opportunity_stage_observations')`
      )
      .all<{ table_name: string; column_name: string }>();
    const columns = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const column of [
      'provider_webhook_endpoints.provider',
      'provider_webhook_endpoints.status',
      'provider_webhook_endpoints.secret_ciphertext',
      'provider_webhook_endpoints.secret_iv',
      'provider_webhook_endpoints.secret_auth_tag',
      'provider_webhook_endpoints.secret_key_version',
      'provider_webhook_endpoints.secret_key_id',
      'provider_webhook_endpoints.accepted_count',
      'provider_webhook_endpoints.rejected_count',
      'provider_webhook_endpoints.last_seen_at',
      'product_milestones.kind',
      'product_milestones.contact_id',
      'product_milestones.account_id',
      'product_milestones.source_type',
      'product_milestones.source_id',
      'product_milestones.external_object_id',
      'product_milestones.milestone_key',
      'product_milestones.occurred_at',
      'opportunity_stage_observations.opportunity_id',
      'opportunity_stage_observations.previous_stage',
      'opportunity_stage_observations.stage'
    ])
      expect(columns.has(column), column).toBe(true);
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    const contactId = id('con');
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        contactId,
        WS,
        'Vocabulary',
        'vocab@example.test',
        'vocab@example.test',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await expect(
      db
        .prepare(
          `INSERT INTO product_milestones
           (id,workspace_id,kind,contact_id,source_type,source_id,milestone_key,occurred_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          id('pm'),
          WS,
          'demo_request',
          contactId,
          'inbound_submission',
          'sub_vocab',
          'demo_request:vocab',
          NOW.toISOString()
        )
    ).rejects.toThrow();
  });
});
