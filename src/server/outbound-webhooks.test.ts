import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { openDatabase, type Db } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import { recordManagedCampaignAudit } from './linkedin/managed-campaigns.js';
import {
  createOutboundWebhookSubscription,
  deactivateOutboundWebhookSubscription,
  dispatchOutboundWebhookDeliveries,
  listOutboundWebhookSubscriptions,
  validateWebhookTarget
} from './outbound-webhooks.js';
import type {
  WebhookEgressPolicy,
  WebhookResolver,
  WebhookTransport,
  WebhookTransportRequest
} from './outbound-webhook-egress.js';

const WS_A = 'ws_out_webhook_qa_a';
const WS_B = 'ws_out_webhook_qa_b';
const NOW = new Date('2026-10-21T13:00:00.000Z');
const HOSTS = ['hooks.partner.example'];
const POLICY: WebhookEgressPolicy = { allowedHosts: HOSTS, allowedPorts: [], allowHttp: false };
const resolver: WebhookResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const EGRESS = { policy: POLICY, resolver };
let db: Db;

/** Stub transport: records what would have been sent; `respond` decides the status. */
function stubTransport(
  respond: (request: WebhookTransportRequest) => number | Promise<number> = () => 204
): { transport: WebhookTransport; calls: WebhookTransportRequest[] } {
  const calls: WebhookTransportRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return { status: await respond(request) };
    }
  };
}

async function createEvent(workspaceId: string, eventType = 'linkedin_campaign.started') {
  const event = await appendDomainEvent(db, {
    workspaceId,
    streamType: 'linkedin_campaign',
    streamId: `campaign-${workspaceId}`,
    eventType,
    actorType: 'human',
    actorId: 'operator',
    payload: { sensitiveEmail: 'someone@example.test', apiKey: 'do-not-publish' },
    occurredAt: NOW
  });
  // The outbox's production DEFAULT CURRENT_TIMESTAMP is intentionally based on
  // the database clock. These tests dispatch at a fixed simulated instant; make
  // the test event due at that instant instead of assuming DB time equals NOW.
  // This changes only isolated fixture rows, not production delivery semantics.
  await db
    .prepare(
      'UPDATE outbound_webhook_deliveries SET next_attempt_at=?::timestamptz WHERE workspace_id=? AND event_id=?'
    )
    .run(NOW.toISOString(), workspaceId, event.id);
  return event;
}
async function rowsFor(workspaceId: string) {
  return db
    .prepare(
      `SELECT d.id,d.status,d.attempts,d.last_http_status,d.payload_json,d.last_error
    FROM outbound_webhook_deliveries d WHERE d.workspace_id=? ORDER BY d.id`
    )
    .all<{
      id: string;
      status: string;
      attempts: number;
      last_http_status: number | null;
      payload_json: Record<string, unknown>;
      last_error: string | null;
    }>(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  // The dispatcher under test claims due deliveries across ALL workspaces (it
  // is the worker), so leftovers from an earlier file on this worker's database
  // would be claimed here. Files on one worker run sequentially.
  await db.prepare('DELETE FROM outbound_webhook_deliveries').run();
  for (const workspaceId of [WS_A, WS_B]) {
    await db
      .prepare(
        'INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING'
      )
      .run(workspaceId, workspaceId, NOW.toISOString());
    await db
      .prepare('DELETE FROM outbound_webhook_subscriptions WHERE workspace_id=?')
      .run(workspaceId);
    await db.prepare('DELETE FROM domain_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM event_streams WHERE workspace_id=?').run(workspaceId);
  }
});
afterEach(async () => {
  await db?.close();
});

describe('durable outbound lifecycle webhook outbox', () => {
  it('denies unapproved, private and ambiguous destinations before storing credentials', async () => {
    const bad = [
      'http://hooks.partner.example/webhook',
      'https://localhost/api',
      'https://127.0.0.1/hook',
      'https://hooks.partner.example.evil.invalid/',
      'https://hooks.partner.example:8443/hook',
      'https://user:pass@hooks.partner.example/hook',
      'https://hooks.partner.example/hook?token=private',
      'https://hooks.partner.example/hook#secret',
      'https://[::1]/hook'
    ];
    for (const url of bad) {
      expect(() => validateWebhookTarget(url, HOSTS)).toThrow(/Webhook/);
    }
    await expect(
      createOutboundWebhookSubscription(
        db,
        {
          workspaceId: WS_A,
          url: 'https://hooks.partner.example/notify',
          eventTypes: ['arbitrary.private.event']
        },
        EGRESS
      )
    ).rejects.toThrow(/supported lifecycle events/);
    expect(await listOutboundWebhookSubscriptions(db, WS_A)).toEqual([]);
  });

  it('keeps secrets tenant-bound and out of read responses; enqueues only allowlisted events', async () => {
    const a = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started', 'playbook.run.completed']
      },
      EGRESS
    );
    const b = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_B,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    expect(a.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(b.signingSecret).not.toBe(a.signingSecret);
    expect(JSON.stringify(await listOutboundWebhookSubscriptions(db, WS_A))).not.toContain(
      'whsec_'
    );
    expect(await listOutboundWebhookSubscriptions(db, WS_B)).toHaveLength(1);
    expect(await rowsFor(WS_A)).toHaveLength(0);
    await createEvent(WS_A);
    await createEvent(WS_B);
    await createEvent(WS_A, 'lawful_basis.recorded');
    expect(await rowsFor(WS_A)).toHaveLength(1);
    expect(await rowsFor(WS_B)).toHaveLength(1);
    const envelope = (await rowsFor(WS_A))[0].payload_json;
    expect(envelope).toMatchObject({
      type: 'linkedin_campaign.started',
      data: { streamType: 'linkedin_campaign', streamId: `campaign-${WS_A}` }
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /sensitiveEmail|someone@example|apiKey|do-not-publish/
    );
    expect(envelope).not.toHaveProperty('workspaceId');
    expect(await deactivateOutboundWebhookSubscription(db, WS_B, a.subscription.id)).toBe(false);
    expect(await listOutboundWebhookSubscriptions(db, WS_A)).toHaveLength(1);
  });

  it('bridges real audited LinkedIn campaign controls into the signed lifecycle stream', async () => {
    await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: [
          'linkedin_campaign.started',
          'linkedin_campaign.paused',
          'linkedin_campaign.stopped'
        ]
      },
      EGRESS
    );
    for (const eventType of [
      'linkedin_campaign.started',
      'linkedin_campaign.paused',
      'linkedin_campaign.stopped'
    ]) {
      await recordManagedCampaignAudit(
        db,
        {
          workspaceId: WS_A,
          actorId: 'owner',
          eventType,
          entityType: 'linkedin_campaign',
          entityId: 'campaign-real-audit',
          metadata: { privateNote: 'must-not-leak' }
        },
        NOW
      );
    }
    const rows = await rowsFor(WS_A);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => (row.payload_json as { type: string }).type).sort()).toEqual([
      'linkedin_campaign.paused',
      'linkedin_campaign.started',
      'linkedin_campaign.stopped'
    ]);
    expect(JSON.stringify(rows)).not.toContain('must-not-leak');
    const events = await db
      .prepare(
        `SELECT COUNT(*)::int AS count FROM domain_events
      WHERE workspace_id=? AND stream_id='campaign-real-audit'`
      )
      .get<{ count: number }>(WS_A);
    expect(events?.count).toBe(3);
  });

  it('queues event and outbox in the same transaction and rolls both back', async () => {
    await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    await expect(
      db.transaction(async (tx) => {
        await appendDomainEvent(tx, {
          workspaceId: WS_A,
          streamType: 'linkedin_campaign',
          streamId: 'tx-test',
          eventType: 'linkedin_campaign.started',
          actorType: 'human'
        });
        throw new Error('abort entire domain transaction');
      })
    ).rejects.toThrow(/abort entire domain transaction/);
    const count = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM domain_events
      WHERE workspace_id=? AND stream_id='tx-test'`
      )
      .get<{ total: number }>(WS_A);
    expect(count?.total).toBe(0);
    expect(await rowsFor(WS_A)).toHaveLength(0);
  });

  it('signs an immutable minimal body, pins the vetted address and is idempotent on successful delivery', async () => {
    const created = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    await createEvent(WS_A);
    const { transport, calls } = stubTransport();
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 1, delivered: 1, retried: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe('https://hooks.partner.example/notify');
    expect(calls[0]).toMatchObject({
      address: '93.184.216.34',
      family: 4,
      connectTimeoutMs: 3_000,
      totalTimeoutMs: 10_000,
      maxResponseBytes: 64 * 1024
    });
    const headers = calls[0].headers;
    const body = calls[0].body;
    const signature = createHmac('sha256', created.signingSecret)
      .update(`${Math.floor(NOW.getTime() / 1000)}.${body}`)
      .digest('hex');
    // Unchanged single-signature header outside a rotation overlap.
    expect(headers['X-Trevra-Signature']).toBe(
      `t=${Math.floor(NOW.getTime() / 1000)},v1=${signature}`
    );
    expect(headers['X-Trevra-Event-Id']).toBeTruthy();
    expect(headers['X-Trevra-Delivery-Id']).toBeTruthy();
    expect(headers['X-Trevra-Attempt-Series']).toBe('0');
    expect(headers['X-Trevra-Attempt']).toBe('1');
    expect(await rowsFor(WS_A)).toMatchObject([{ status: 'delivered', attempts: 1 }]);
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('retries a failed write later with the SAME stable event and delivery IDs', async () => {
    await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    await createEvent(WS_A);
    const { transport, calls } = stubTransport(() => (calls.length === 1 ? 503 : 204));
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 1, retried: 1 });
    expect(await rowsFor(WS_A)).toMatchObject([
      { status: 'pending', attempts: 1, last_http_status: 503 }
    ]);
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 0 });
    const later = new Date(NOW.getTime() + 65_000);
    expect(
      await dispatchOutboundWebhookDeliveries(db, {
        now: later,
        policy: POLICY,
        resolver,
        transport
      })
    ).toMatchObject({ claimed: 1, delivered: 1 });
    const ids = calls.map((call) => call.headers['X-Trevra-Delivery-Id']);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('only one worker claims the same event when dispatchers race', async () => {
    await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    await createEvent(WS_A);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { transport, calls } = stubTransport(async () => {
      started();
      await gate;
      return 204;
    });
    const first = dispatchOutboundWebhookDeliveries(db, {
      now: NOW,
      policy: POLICY,
      resolver,
      transport
    });
    await firstStarted;
    try {
      expect(
        await dispatchOutboundWebhookDeliveries(db, {
          now: NOW,
          policy: POLICY,
          resolver,
          transport
        })
      ).toMatchObject({ claimed: 0 });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ claimed: 1, delivered: 1 });
    expect(calls).toHaveLength(1);
    expect(await rowsFor(WS_A)).toMatchObject([{ status: 'delivered', attempts: 1 }]);
  });

  it('refuses to open a signing secret transplanted into another tenant', async () => {
    await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    const target = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_B,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    const original = await db
      .prepare(
        `SELECT ciphertext,iv,auth_tag,key_version,key_id
      FROM outbound_webhook_subscriptions WHERE workspace_id=?`
      )
      .get<Record<string, unknown>>(WS_A);
    expect(original).toBeTruthy();
    await db
      .prepare(
        `UPDATE outbound_webhook_subscriptions SET ciphertext=?,iv=?,auth_tag=?,
      key_version=?,key_id=? WHERE workspace_id=? AND id=?`
      )
      .run(
        original!.ciphertext,
        original!.iv,
        original!.auth_tag,
        original!.key_version,
        original!.key_id,
        WS_B,
        target.subscription.id
      );
    await createEvent(WS_B);
    const { transport, calls } = stubTransport();
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 1, delivered: 0, retried: 1 });
    expect(calls).toHaveLength(0);
    expect(await rowsFor(WS_B)).toMatchObject([{ status: 'pending', attempts: 1 }]);
  });

  it('deactivation permanently cancels queued writes, including other tenants isolation', async () => {
    const a = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_A,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    const b = await createOutboundWebhookSubscription(
      db,
      {
        workspaceId: WS_B,
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      },
      EGRESS
    );
    await createEvent(WS_A);
    await createEvent(WS_B);
    expect(await deactivateOutboundWebhookSubscription(db, WS_A, a.subscription.id)).toBe(true);
    expect(await rowsFor(WS_A)).toMatchObject([{ status: 'dead' }]);
    const { transport, calls } = stubTransport();
    expect(
      await dispatchOutboundWebhookDeliveries(db, { now: NOW, policy: POLICY, resolver, transport })
    ).toMatchObject({ claimed: 1, delivered: 1 });
    expect(calls).toHaveLength(1);
    expect(await rowsFor(WS_B)).toMatchObject([{ status: 'delivered' }]);
    expect(b.subscription.id).not.toBe(a.subscription.id);
  });
});
