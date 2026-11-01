import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import {
  OutboundWebhookError,
  createOutboundWebhookSubscription,
  deactivateOutboundWebhookSubscription,
  dispatchOutboundWebhookDeliveries,
  expireOutboundWebhookSecrets,
  getOutboundWebhookStats,
  listOutboundWebhookAttempts,
  listOutboundWebhookDeliveries,
  listOutboundWebhookSubscriptions,
  pruneOutboundWebhookAttempts,
  replayOutboundWebhookDeliveries,
  rotateOutboundWebhookSecret,
  updateOutboundWebhookSubscription,
  verifyWebhookSignature
} from './outbound-webhooks.js';
import {
  WebhookEgressError,
  type WebhookEgressPolicy,
  type WebhookResolver,
  type WebhookTransport,
  type WebhookTransportRequest
} from './outbound-webhook-egress.js';

const WS_A = 'ws_owh_hardening_a';
const WS_B = 'ws_owh_hardening_b';
const NOW = new Date('2026-10-21T13:00:00.000Z');
const HOUR = 3_600_000;
const URL_A = 'https://hooks.partner.example/notify';
const POLICY: WebhookEgressPolicy = {
  allowedHosts: ['hooks.partner.example'],
  allowedPorts: [],
  allowHttp: false
};
const PUBLIC_IP = '93.184.216.34';
const publicResolver: WebhookResolver = async () => [{ address: PUBLIC_IP, family: 4 }];
const privateResolver: WebhookResolver = async () => [{ address: '10.0.0.5', family: 4 }];
const EGRESS = { policy: POLICY, resolver: publicResolver };
let db: Db;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

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

async function errorOf(work: Promise<unknown>): Promise<OutboundWebhookError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof OutboundWebhookError) return error;
    throw error;
  }
  throw new Error('expected an OutboundWebhookError');
}

async function subscribe(workspaceId: string) {
  return createOutboundWebhookSubscription(
    db,
    { workspaceId, url: URL_A, eventTypes: ['linkedin_campaign.started'] },
    EGRESS
  );
}

async function createEvent(workspaceId: string, due: Date = NOW) {
  const event = await appendDomainEvent(db, {
    workspaceId,
    streamType: 'linkedin_campaign',
    streamId: `campaign-${workspaceId}`,
    eventType: 'linkedin_campaign.started',
    actorType: 'human',
    actorId: 'operator',
    payload: { privateNote: 'must-not-leak' },
    occurredAt: NOW
  });
  await db
    .prepare(
      `UPDATE outbound_webhook_deliveries SET next_attempt_at=?::timestamptz,created_at=?::timestamptz
      WHERE workspace_id=? AND event_id=?`
    )
    .run(due.toISOString(), at(-HOUR).toISOString(), workspaceId, event.id);
  return event;
}

async function dispatch(now: Date, transport: WebhookTransport, resolver = publicResolver) {
  return dispatchOutboundWebhookDeliveries(db, { now, policy: POLICY, resolver, transport });
}

/** Six failed attempts, an hour apart (backoff tops out at 32 minutes), dead-letter a delivery. */
async function exhaust(start: Date = NOW): Promise<Date> {
  const { transport } = stubTransport(() => 503);
  let now = start;
  for (let attempt = 0; attempt < 6; attempt++) {
    now = new Date(start.getTime() + attempt * HOUR);
    await dispatch(now, transport);
  }
  return now;
}

async function deliveryRow(deliveryId: string) {
  return db
    .prepare(
      `SELECT status,attempts,attempt_series,last_reason_code,last_http_status,dead_at
      FROM outbound_webhook_deliveries WHERE id=?`
    )
    .get<{
      status: string;
      attempts: number;
      attempt_series: number;
      last_reason_code: string | null;
      last_http_status: number | null;
      dead_at: string | null;
    }>(deliveryId);
}

async function attemptRows(workspaceId: string) {
  return db
    .prepare(
      `SELECT attempt_series,attempt_number,outcome,http_status,latency_ms,reason_code
      FROM outbound_webhook_delivery_attempts WHERE workspace_id=?
      ORDER BY attempted_at,attempt_series,attempt_number`
    )
    .all<{
      attempt_series: number;
      attempt_number: number;
      outcome: string;
      http_status: number | null;
      latency_ms: number | null;
      reason_code: string | null;
    }>(workspaceId);
}

/** Insert `count` dead-lettered deliveries for a subscription directly. */
async function insertDead(workspaceId: string, subscriptionId: string, tag: string, count: number) {
  await db
    .prepare(
      `WITH ev AS (
        INSERT INTO domain_events
          (id,workspace_id,stream_type,stream_id,stream_version,event_type,actor_type,occurred_at)
        SELECT 'evt_dead_' || ?::text || '_' || g,?::text,'dead_fixture',
          'dead-' || ?::text || '-' || g,1,'linkedin_campaign.started','system',?::timestamptz
        FROM generate_series(1,?::int) g RETURNING id
      )
      INSERT INTO outbound_webhook_deliveries
        (id,workspace_id,subscription_id,event_id,payload_json,status,attempts,dead_at,created_at)
      SELECT 'owhd_' || md5(?::text || ':' || ev.id),?::text,?::text,ev.id,
        jsonb_build_object('id',ev.id),'dead',6,?::timestamptz,?::timestamptz
      FROM ev`
    )
    .run(
      tag,
      workspaceId,
      tag,
      NOW.toISOString(),
      count,
      subscriptionId,
      workspaceId,
      subscriptionId,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function deadCount(subscriptionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM outbound_webhook_deliveries
      WHERE subscription_id=? AND status='dead'`
    )
    .get<{ total: number }>(subscriptionId);
  return Number(row?.total ?? 0);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  // The dispatcher claims due deliveries across ALL workspaces, so start from
  // an empty outbox; files on one worker's database run sequentially.
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
    await db.prepare('DELETE FROM event_streams WHERE workspace_id=?').run(workspaceId);
  }
});
afterEach(async () => {
  await db?.close();
});

describe('egress controls at create, update and delivery time', () => {
  it('refuses a destination resolving to private space before storing anything', async () => {
    const error = await errorOf(
      createOutboundWebhookSubscription(
        db,
        { workspaceId: WS_A, url: URL_A, eventTypes: ['linkedin_campaign.started'] },
        { policy: POLICY, resolver: privateResolver }
      )
    );
    expect(error).toMatchObject({ status: 400, code: 'address_not_public' });
    const literal = await errorOf(
      createOutboundWebhookSubscription(
        db,
        {
          workspaceId: WS_A,
          url: 'https://[::ffff:169.254.169.254]/latest',
          eventTypes: ['linkedin_campaign.started']
        },
        EGRESS
      )
    );
    expect(literal).toMatchObject({ status: 400, code: 'ip_literal_not_allowed' });
    expect(await listOutboundWebhookSubscriptions(db, WS_A)).toEqual([]);
  });

  it('re-vets on URL change and on re-enable, keeping the stored row unchanged on refusal', async () => {
    const { subscription } = await subscribe(WS_A);
    const update = (input: { url?: string; active?: boolean }, resolver = publicResolver) =>
      updateOutboundWebhookSubscription(
        db,
        { workspaceId: WS_A, subscriptionId: subscription.id, ...input },
        { policy: POLICY, resolver }
      );
    expect(
      await errorOf(update({ url: 'https://metadata.google.internal/computeMetadata/v1/' }))
    ).toMatchObject({ status: 400, code: 'host_not_allowed' });
    expect(
      await errorOf(update({ url: 'https://hooks.partner.example/v2' }, privateResolver))
    ).toMatchObject({
      status: 400,
      code: 'address_not_public'
    });
    expect((await listOutboundWebhookSubscriptions(db, WS_A))[0].url).toBe(URL_A);
    expect(await update({ url: 'https://hooks.partner.example/v2' })).toMatchObject({
      url: 'https://hooks.partner.example/v2'
    });
    expect(await update({ active: false })).toMatchObject({
      active: false,
      disabledReason: 'owner'
    });
    expect(await errorOf(update({ active: true }, privateResolver))).toMatchObject({
      code: 'address_not_public'
    });
    expect((await listOutboundWebhookSubscriptions(db, WS_A))[0].active).toBe(false);
    expect(await update({ active: true })).toMatchObject({ active: true, disabledReason: null });
  });

  it('DNS rebinding: connects only to the address vetted in the same attempt, then refuses the private answer', async () => {
    await subscribe(WS_A);
    const event = await createEvent(WS_A);
    let lookups = 0;
    // First answer public, every later answer private.
    const rebinding: WebhookResolver = async () => {
      lookups++;
      return [{ address: lookups === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
    };
    const { transport, calls } = stubTransport(() => 503);
    expect(await dispatch(NOW, transport, rebinding)).toMatchObject({ claimed: 1, retried: 1 });
    expect(lookups).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(PUBLIC_IP);
    expect(calls[0].url.hostname).toBe('hooks.partner.example');
    // The retry resolves again, sees the private answer and never opens a socket.
    expect(await dispatch(at(5 * 60_000), transport, rebinding)).toMatchObject({
      claimed: 1,
      retried: 1
    });
    expect(lookups).toBe(2);
    expect(calls).toHaveLength(1);
    expect(await attemptRows(WS_A)).toMatchObject([
      { attempt_number: 1, outcome: 'failed', http_status: 503, reason_code: 'http_error' },
      {
        attempt_number: 2,
        outcome: 'blocked',
        http_status: null,
        latency_ms: null,
        reason_code: 'address_not_public'
      }
    ]);
    const [delivery] = (await listOutboundWebhookDeliveries(
      db,
      WS_A,
      (await listOutboundWebhookSubscriptions(db, WS_A))[0].id
    ))!;
    expect(delivery).toMatchObject({ eventId: event.id, lastReasonCode: 'address_not_public' });
  });

  it('re-checks the stored URL against the current policy at delivery time', async () => {
    await subscribe(WS_A);
    await createEvent(WS_A);
    const { transport, calls } = stubTransport();
    await dispatchOutboundWebhookDeliveries(db, {
      now: NOW,
      policy: { ...POLICY, allowedHosts: ['someone-else.example'] },
      resolver: publicResolver,
      transport
    });
    expect(calls).toHaveLength(0);
    expect(await attemptRows(WS_A)).toMatchObject([
      { outcome: 'blocked', reason_code: 'host_not_allowlisted' }
    ]);
  });

  it('never follows a redirect and records the status and reason', async () => {
    const { subscription } = await subscribe(WS_A);
    await createEvent(WS_A);
    const { transport, calls } = stubTransport(() => 302);
    expect(await dispatch(NOW, transport)).toMatchObject({ claimed: 1, retried: 1 });
    expect(calls).toHaveLength(1);
    expect(await attemptRows(WS_A)).toMatchObject([
      { outcome: 'failed', http_status: 302, reason_code: 'redirect_not_followed' }
    ]);
    expect((await listOutboundWebhookDeliveries(db, WS_A, subscription.id))![0]).toMatchObject({
      status: 'pending',
      lastHttpStatus: 302,
      lastReasonCode: 'redirect_not_followed'
    });
  });

  it('records timeout and response-size-cap failures with their reason codes', async () => {
    await subscribe(WS_A);
    await createEvent(WS_A);
    let call = 0;
    const transport: WebhookTransport = async () => {
      call++;
      if (call === 1)
        throw new WebhookEgressError('timeout', 'Webhook endpoint did not respond in time.');
      throw new WebhookEgressError(
        'response_too_large',
        'Webhook response exceeded the size limit.',
        200
      );
    };
    await dispatch(NOW, transport);
    await dispatch(at(5 * 60_000), transport);
    const rows = await attemptRows(WS_A);
    expect(rows).toMatchObject([
      { attempt_number: 1, outcome: 'failed', http_status: null, reason_code: 'timeout' },
      { attempt_number: 2, outcome: 'failed', http_status: 200, reason_code: 'response_too_large' }
    ]);
    expect(rows.every((row) => row.latency_ms !== null && row.latency_ms >= 0)).toBe(true);
  });
});

describe('signing secret rotation', () => {
  it('signs with both secrets during the overlap and only the new one after expiry', async () => {
    const created = await subscribe(WS_A);
    const oldSecret = created.signingSecret;
    const rotated = await rotateOutboundWebhookSecret(db, {
      workspaceId: WS_A,
      subscriptionId: created.subscription.id,
      actorId: 'owner',
      now: NOW
    });
    expect(rotated).not.toBeNull();
    const newSecret = rotated!.signingSecret;
    expect(newSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(newSecret).not.toBe(oldSecret);
    expect(rotated!.subscription.previousSecretExpiresAt).toBe(at(24 * HOUR).toISOString());
    const listed = await listOutboundWebhookSubscriptions(db, WS_A, at(HOUR));
    expect(listed[0]).toMatchObject({
      secretRotatedAt: NOW.toISOString(),
      previousSecretExpiresAt: at(24 * HOUR).toISOString()
    });
    expect(JSON.stringify(listed)).not.toContain('whsec_');

    // Inside the overlap: new signature first, previous second; either verifies.
    await createEvent(WS_A, at(HOUR));
    const overlap = stubTransport();
    await dispatch(at(HOUR), overlap.transport);
    const header = overlap.calls[0].headers['X-Trevra-Signature'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    const nowSeconds = Math.floor(at(HOUR).getTime() / 1000);
    const body = overlap.calls[0].body;
    expect(verifyWebhookSignature(header, newSecret, body, { nowSeconds })).toBe(true);
    expect(verifyWebhookSignature(header, oldSecret, body, { nowSeconds })).toBe(true);
    const [, first, second] = header.split(',');
    expect(
      verifyWebhookSignature(`t=${nowSeconds},${first}`, newSecret, body, { nowSeconds })
    ).toBe(true);
    expect(
      verifyWebhookSignature(`t=${nowSeconds},${second}`, oldSecret, body, { nowSeconds })
    ).toBe(true);
    expect(verifyWebhookSignature(header, 'whsec_wrong', body, { nowSeconds })).toBe(false);

    // After expiry: lazily dropped at signing time even before the closer runs.
    await createEvent(WS_A, at(25 * HOUR));
    const after = stubTransport();
    await dispatch(at(25 * HOUR), after.transport);
    const late = after.calls[0].headers['X-Trevra-Signature'];
    const lateSeconds = Math.floor(at(25 * HOUR).getTime() / 1000);
    expect(late).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature(late, newSecret, after.calls[0].body, { nowSeconds: lateSeconds })
    ).toBe(true);
    expect(
      verifyWebhookSignature(late, oldSecret, after.calls[0].body, { nowSeconds: lateSeconds })
    ).toBe(false);
    expect(
      (await listOutboundWebhookSubscriptions(db, WS_A, at(25 * HOUR)))[0].previousSecretExpiresAt
    ).toBeNull();

    // The closer physically removes the expired ciphertext.
    expect(await expireOutboundWebhookSecrets(db, at(23 * HOUR))).toBe(0);
    expect(await expireOutboundWebhookSecrets(db, at(25 * HOUR))).toBe(1);
    const stored = await db
      .prepare(
        `SELECT previous_ciphertext,previous_secret_expires_at FROM outbound_webhook_subscriptions WHERE id=?`
      )
      .get<{ previous_ciphertext: Buffer | null; previous_secret_expires_at: string | null }>(
        created.subscription.id
      );
    expect(stored).toEqual({ previous_ciphertext: null, previous_secret_expires_at: null });

    const audit = await db
      .prepare(
        `SELECT payload_json::text AS payload FROM domain_events
        WHERE workspace_id=? AND event_type='outbound_webhook.secret_rotated'`
      )
      .all<{ payload: string }>(WS_A);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).not.toContain('whsec_');
  });

  it('overlap 0 revokes the previous secret immediately; rotation is workspace-scoped', async () => {
    const created = await subscribe(WS_A);
    expect(
      await rotateOutboundWebhookSecret(db, {
        workspaceId: WS_B,
        subscriptionId: created.subscription.id,
        now: NOW
      })
    ).toBeNull();
    const rotated = await rotateOutboundWebhookSecret(db, {
      workspaceId: WS_A,
      subscriptionId: created.subscription.id,
      overlapSeconds: 0,
      now: NOW
    });
    expect(rotated!.subscription.previousSecretExpiresAt).toBeNull();
    await createEvent(WS_A);
    const { transport, calls } = stubTransport();
    await dispatch(NOW, transport);
    const header = calls[0].headers['X-Trevra-Signature'];
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    expect(
      verifyWebhookSignature(header, rotated!.signingSecret, calls[0].body, { nowSeconds })
    ).toBe(true);
    expect(
      verifyWebhookSignature(header, created.signingSecret, calls[0].body, { nowSeconds })
    ).toBe(false);
    expect(
      await errorOf(
        rotateOutboundWebhookSecret(db, {
          workspaceId: WS_A,
          subscriptionId: created.subscription.id,
          overlapSeconds: 8 * 24 * 3600
        })
      )
    ).toMatchObject({ status: 400 });
  });
});

describe('dead-letter replay', () => {
  it('replays one dead delivery with the same occurrence id, delivery id and body in a new attempt series', async () => {
    const { subscription } = await subscribe(WS_A);
    const event = await createEvent(WS_A);
    const first = stubTransport(() => 503);
    await dispatch(NOW, first.transport);
    const lastFailure = await exhaust(at(HOUR));
    const [dead] = (await listOutboundWebhookDeliveries(db, WS_A, subscription.id))!;
    expect(dead).toMatchObject({ status: 'dead', attempts: 6, attemptSeries: 0 });
    expect(dead.deadAt).toBeTruthy();

    const replayAt = new Date(lastFailure.getTime() + HOUR);
    expect(
      await replayOutboundWebhookDeliveries(db, {
        workspaceId: WS_A,
        subscriptionId: subscription.id,
        deliveryId: dead.id,
        actorId: 'owner',
        now: replayAt
      })
    ).toEqual({ replayed: 1, deliveryIds: [dead.id] });
    expect(await deliveryRow(dead.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      attempt_series: 1,
      dead_at: null
    });

    const replay = stubTransport();
    expect(await dispatch(replayAt, replay.transport)).toMatchObject({ delivered: 1 });
    const original = first.calls[0];
    const again = replay.calls[0];
    expect(again.headers['X-Trevra-Event-Id']).toBe(event.id);
    expect(again.headers['X-Trevra-Event-Id']).toBe(original.headers['X-Trevra-Event-Id']);
    expect(again.headers['X-Trevra-Delivery-Id']).toBe(original.headers['X-Trevra-Delivery-Id']);
    expect(again.body).toBe(original.body);
    expect(JSON.parse(again.body).id).toBe(event.id);
    expect(again.headers['X-Trevra-Attempt-Series']).toBe('1');
    expect(again.headers['X-Trevra-Attempt']).toBe('1');
    expect(original.headers['X-Trevra-Attempt-Series']).toBe('0');
    const attempts = await attemptRows(WS_A);
    expect(attempts.filter((row) => row.attempt_series === 0)).toHaveLength(6);
    expect(attempts.filter((row) => row.attempt_series === 1)).toMatchObject([
      { attempt_number: 1, outcome: 'delivered', http_status: 204 }
    ]);

    const audit = await db
      .prepare(
        `SELECT actor_id,payload_json FROM domain_events
        WHERE workspace_id=? AND event_type='outbound_webhook.deliveries_replayed'`
      )
      .all<{ actor_id: string; payload_json: Record<string, unknown> }>(WS_A);
    expect(audit).toMatchObject([
      { actor_id: 'owner', payload_json: { mode: 'single', count: 1, deliveryIds: [dead.id] } }
    ]);
    // A replay is never re-published as a webhook itself.
    expect(await deadCount(subscription.id)).toBe(0);

    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, {
          workspaceId: WS_A,
          subscriptionId: subscription.id,
          deliveryId: dead.id
        })
      )
    ).toMatchObject({ status: 409, code: 'not_dead' });
    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, {
          workspaceId: WS_B,
          subscriptionId: subscription.id,
          deliveryId: dead.id
        })
      )
    ).toMatchObject({ status: 404 });
  });

  it('bulk replay accepts 500, refuses 501 with a clear 400, and replays an explicit batch', async () => {
    const { subscription } = await subscribe(WS_A);
    const bulk = (limit?: number) =>
      replayOutboundWebhookDeliveries(db, {
        workspaceId: WS_A,
        subscriptionId: subscription.id,
        limit,
        actorId: 'owner',
        now: NOW
      });
    await insertDead(WS_A, subscription.id, 'a', 500);
    expect(await deadCount(subscription.id)).toBe(500);
    expect((await bulk()).replayed).toBe(500);
    expect(await deadCount(subscription.id)).toBe(0);

    await db
      .prepare(`UPDATE outbound_webhook_deliveries SET status='dead' WHERE subscription_id=?`)
      .run(subscription.id);
    await insertDead(WS_A, subscription.id, 'b', 1);
    expect(await deadCount(subscription.id)).toBe(501);
    const tooMany = await errorOf(bulk());
    expect(tooMany).toMatchObject({ status: 400, code: 'replay_cap_exceeded' });
    expect(tooMany.message).toMatch(
      /501 dead-lettered deliveries exceed the bulk replay cap of 500/
    );
    expect(await errorOf(bulk(501))).toMatchObject({ status: 400, code: 'replay_cap_exceeded' });
    expect(await errorOf(bulk(0))).toMatchObject({ status: 400 });
    expect(await deadCount(subscription.id)).toBe(501);
    const batch = await bulk(500);
    expect(batch.replayed).toBe(500);
    expect(await deadCount(subscription.id)).toBe(1);
    const series = await db
      .prepare(
        `SELECT MAX(attempt_series)::int AS top FROM outbound_webhook_deliveries WHERE subscription_id=?`
      )
      .get<{ top: number }>(subscription.id);
    expect(series?.top).toBe(2);
  });

  it('refuses replay while the subscription is disabled, and for an unknown subscription', async () => {
    const { subscription } = await subscribe(WS_A);
    await createEvent(WS_A);
    await exhaust();
    const [dead] = (await listOutboundWebhookDeliveries(db, WS_A, subscription.id))!;
    expect(await deactivateOutboundWebhookSubscription(db, WS_A, subscription.id)).toBe(true);
    const single = () =>
      replayOutboundWebhookDeliveries(db, {
        workspaceId: WS_A,
        subscriptionId: subscription.id,
        deliveryId: dead.id
      });
    expect(await errorOf(single())).toMatchObject({ status: 409, code: 'subscription_inactive' });
    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, { workspaceId: WS_A, subscriptionId: subscription.id })
      )
    ).toMatchObject({ status: 409, code: 'subscription_inactive' });
    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, { workspaceId: WS_A, subscriptionId: 'owhs_missing' })
      )
    ).toMatchObject({ status: 404 });
    await updateOutboundWebhookSubscription(
      db,
      { workspaceId: WS_A, subscriptionId: subscription.id, active: true },
      EGRESS
    );
    expect((await single()).replayed).toBe(1);
  });

  it('auto-disables after a long failure streak, dead-letters the queue, and needs re-enable before replay', async () => {
    const { subscription } = await subscribe(WS_A);
    await createEvent(WS_A);
    // A long streak that is still young does not disable.
    await db
      .prepare(
        `UPDATE outbound_webhook_subscriptions SET consecutive_failures=40,failing_since=?::timestamptz WHERE id=?`
      )
      .run(at(-HOUR).toISOString(), subscription.id);
    const { transport } = stubTransport(() => 500);
    await dispatch(NOW, transport);
    expect((await listOutboundWebhookSubscriptions(db, WS_A))[0]).toMatchObject({
      active: true,
      consecutiveFailures: 41
    });
    // An aged streak past the threshold does.
    await db
      .prepare(
        `UPDATE outbound_webhook_subscriptions SET consecutive_failures=29,failing_since=?::timestamptz WHERE id=?`
      )
      .run(at(-25 * HOUR).toISOString(), subscription.id);
    await dispatch(at(5 * 60_000), transport);
    const [disabled] = await listOutboundWebhookSubscriptions(db, WS_A);
    expect(disabled).toMatchObject({
      active: false,
      disabledReason: 'consecutive_failures',
      consecutiveFailures: 30,
      lastFailureCode: 'http_error'
    });
    const [dead] = (await listOutboundWebhookDeliveries(db, WS_A, subscription.id))!;
    expect(dead).toMatchObject({ status: 'dead', lastReasonCode: 'subscription_inactive' });
    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, { workspaceId: WS_A, subscriptionId: subscription.id })
      )
    ).toMatchObject({ status: 409 });
    expect(
      await updateOutboundWebhookSubscription(
        db,
        { workspaceId: WS_A, subscriptionId: subscription.id, active: true },
        EGRESS
      )
    ).toMatchObject({ active: true, disabledReason: null, consecutiveFailures: 0 });
    expect(
      await replayOutboundWebhookDeliveries(db, {
        workspaceId: WS_A,
        subscriptionId: subscription.id,
        now: at(HOUR)
      })
    ).toMatchObject({ replayed: 1 });
  });
});

describe('delivery visibility', () => {
  it('computes 24h/7d delivered, failed, pending and dead plus the failure streak', async () => {
    const { subscription } = await subscribe(WS_A);
    // Due order fixes attempt order: ok, ok, fail.
    const ok1 = await createEvent(WS_A, at(-3 * 60_000));
    const ok2 = await createEvent(WS_A, at(-2 * 60_000));
    const failing = await createEvent(WS_A, at(-60_000));
    const { transport } = stubTransport((request) =>
      request.headers['X-Trevra-Event-Id'] === failing.id ? 500 : 204
    );
    expect(await dispatch(NOW, transport)).toMatchObject({ claimed: 3, delivered: 2, retried: 1 });
    expect([ok1.id, ok2.id]).not.toContain(failing.id);

    // History: a 3-day-old delivery, failed attempt and queued write; a
    // 2-day-old dead letter; and 8-day-old rows outside both windows.
    await insertDead(WS_A, subscription.id, 'stats', 4);
    const fixtures = await db
      .prepare(
        `SELECT id FROM outbound_webhook_deliveries WHERE subscription_id=? AND id IN (
          SELECT 'owhd_' || md5(?::text || ':evt_dead_stats_' || g) FROM generate_series(1,4) g)
        ORDER BY id`
      )
      .all<{ id: string }>(subscription.id, subscription.id);
    expect(fixtures).toHaveLength(4);
    const [oldDelivered, oldDead, ancientDead, oldPending] = fixtures.map((row) => row.id);
    const stamp = (offset: number) => at(offset).toISOString();
    await db
      .prepare(
        `UPDATE outbound_webhook_deliveries SET status='delivered',dead_at=NULL,
        delivered_at=?::timestamptz WHERE id=?`
      )
      .run(stamp(-72 * HOUR), oldDelivered);
    await db
      .prepare(`UPDATE outbound_webhook_deliveries SET dead_at=?::timestamptz WHERE id=?`)
      .run(stamp(-48 * HOUR), oldDead);
    await db
      .prepare(`UPDATE outbound_webhook_deliveries SET dead_at=?::timestamptz WHERE id=?`)
      .run(stamp(-8 * 24 * HOUR), ancientDead);
    await db
      .prepare(
        `UPDATE outbound_webhook_deliveries SET status='pending',dead_at=NULL,
        created_at=?::timestamptz WHERE id=?`
      )
      .run(stamp(-72 * HOUR), oldPending);
    for (const [offset, number] of [
      [-72 * HOUR, 1],
      [-8 * 24 * HOUR, 2]
    ]) {
      await db
        .prepare(
          `INSERT INTO outbound_webhook_delivery_attempts
          (id,workspace_id,subscription_id,delivery_id,attempt_series,attempt_number,outcome,
            http_status,latency_ms,reason_code,attempted_at)
          VALUES (?,?,?,?,0,?,'failed',500,12,'http_error',?::timestamptz)`
        )
        .run(`owha_fixture_${number}`, WS_A, subscription.id, oldDead, number, stamp(offset));
    }

    const stats = await getOutboundWebhookStats(db, WS_A, subscription.id, NOW);
    expect(stats).toEqual({
      last24h: { delivered: 2, failed: 1, pending: 1, dead: 0 },
      last7d: { delivered: 3, failed: 2, pending: 2, dead: 1 },
      consecutiveFailures: 1,
      lastFailureCode: 'http_error',
      lastFailureAt: NOW.toISOString(),
      lastSuccessAt: NOW.toISOString()
    });

    const attempts = await listOutboundWebhookAttempts(db, WS_A, subscription.id, 3);
    expect(attempts).toHaveLength(3);
    expect(attempts![0]).toMatchObject({
      attemptSeries: 0,
      attemptNumber: 1,
      attemptedAt: NOW.toISOString()
    });
    expect(attempts!.map((row) => row.outcome).sort()).toEqual([
      'delivered',
      'delivered',
      'failed'
    ]);
    const failed = attempts!.find((row) => row.outcome === 'failed')!;
    expect(failed).toMatchObject({
      eventId: failing.id,
      httpStatus: 500,
      reasonCode: 'http_error'
    });
    expect(typeof failed.latencyMs).toBe('number');
    // No response body is stored or returned.
    expect(Object.keys(failed).sort()).toEqual([
      'attemptNumber',
      'attemptSeries',
      'attemptedAt',
      'deliveryId',
      'eventId',
      'httpStatus',
      'id',
      'latencyMs',
      'outcome',
      'reasonCode'
    ]);
  });

  it('keeps stats, attempts, edits, rotation and replay inside the owning workspace', async () => {
    const a = await subscribe(WS_A);
    const b = await subscribe(WS_B);
    await createEvent(WS_A);
    await createEvent(WS_B);
    await dispatch(NOW, stubTransport(() => 500).transport);
    expect(await getOutboundWebhookStats(db, WS_B, a.subscription.id, NOW)).toBeNull();
    expect(await listOutboundWebhookAttempts(db, WS_B, a.subscription.id)).toBeNull();
    expect(await listOutboundWebhookDeliveries(db, WS_B, a.subscription.id)).toBeNull();
    expect(
      await updateOutboundWebhookSubscription(
        db,
        { workspaceId: WS_B, subscriptionId: a.subscription.id, active: false },
        EGRESS
      )
    ).toBeNull();
    expect(
      await errorOf(
        replayOutboundWebhookDeliveries(db, {
          workspaceId: WS_B,
          subscriptionId: a.subscription.id
        })
      )
    ).toMatchObject({ status: 404 });
    const own = await listOutboundWebhookAttempts(db, WS_B, b.subscription.id);
    expect(own).toHaveLength(1);
    expect((await getOutboundWebhookStats(db, WS_B, b.subscription.id, NOW))!.last24h.failed).toBe(
      1
    );
    expect((await listOutboundWebhookSubscriptions(db, WS_A))[0].active).toBe(true);
  });

  it('prunes attempts past retention and nothing newer', async () => {
    const { subscription } = await subscribe(WS_A);
    await createEvent(WS_A);
    await dispatch(NOW, stubTransport(() => 500).transport);
    const [delivery] = (await listOutboundWebhookDeliveries(db, WS_A, subscription.id))!;
    await db
      .prepare(
        `INSERT INTO outbound_webhook_delivery_attempts
        (id,workspace_id,subscription_id,delivery_id,attempt_series,attempt_number,outcome,attempted_at)
        VALUES ('owha_ancient',?,?,?,9,1,'failed',?::timestamptz)`
      )
      .run(WS_A, subscription.id, delivery.id, at(-31 * 24 * HOUR).toISOString());
    expect(await pruneOutboundWebhookAttempts(db, NOW)).toBe(1);
    expect(await attemptRows(WS_A)).toHaveLength(1);
  });
});
