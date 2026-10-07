import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { resolveContact } from '../lead-capture/people.js';
import { companyDomainFromEmail } from '../lead-capture/freemail.js';
import {
  createProviderWebhookEndpoint,
  registerProviderVerifier,
  registerProviderWebhookRoutes,
  type ProviderWebhookEndpoint
} from './index.js';
import {
  isSubscriptionUpgrade,
  mapStripeEvent,
  stripeVerifier,
  type StripeEventEnvelope
} from './stripe.js';

const WS_A = 'ws_stripe_hooks_a';
const WS_B = 'ws_stripe_hooks_b';
const USER_A = 'usr_stripe_hooks_a';
const USER_B = 'usr_stripe_hooks_b';
const SECRET = `whsec_${randomBytes(24).toString('hex')}`;
const EMAIL = 'ada@acme-stripe.example';
const CUSTOMER = 'cus_TestAda001';
const AMOUNT = 987654;
const NOW = new Date('2026-10-06T09:00:00.000Z');

let db: Db;
let app: Express;
let endpoint: ProviderWebhookEndpoint;

function price(unitAmount: number | null, interval: string, currency = 'usd', intervalCount = 1) {
  return {
    unit_amount: unitAmount,
    currency,
    recurring: { interval, interval_count: intervalCount }
  };
}

function envelope(
  type: string,
  object: Record<string, unknown>,
  previous: Record<string, unknown> | null = null,
  eventId = 'evt_unit'
): StripeEventEnvelope {
  return {
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000) - 5,
    livemode: true,
    data: { object, previous_attributes: previous }
  };
}

function deliver(event: StripeEventEnvelope, secret = SECRET) {
  const payload = JSON.stringify({ object: 'event', api_version: '2026-09-30', ...event });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request(app)
    .post(`/api/hooks/v1/stripe/${endpoint.id}`)
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>(...params);
  return Number(row?.n ?? 0);
}

const checkout = (eventId: string) =>
  envelope(
    'checkout.session.completed',
    {
      id: 'cs_test_001',
      object: 'checkout.session',
      customer: CUSTOMER,
      customer_details: { email: EMAIL, name: 'Ada Lovelace' },
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: AMOUNT,
      line_items: { data: [{ description: 'Secret Pro Plan', amount_total: AMOUNT }] }
    },
    null,
    eventId
  );

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const [workspaceId, userId] of [
    [WS_A, USER_A],
    [WS_B, USER_B]
  ]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, new Date().toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@stripe.test`, userId, new Date().toISOString());
  }
  // Workspace B already knows the same person: a Stripe event for A must never touch it.
  await resolveContact(db, WS_B, { email: EMAIL, name: 'Ada in B' });
  registerProviderVerifier(stripeVerifier);
  endpoint = await createProviderWebhookEndpoint(db, {
    workspaceId: WS_A,
    actorUserId: USER_A,
    provider: 'stripe',
    signingSecret: SECRET
  });
  app = express();
  registerProviderWebhookRoutes(app, db);
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS_A, WS_B);
  await db?.close();
});

describe('Stripe event mapping (content-free)', () => {
  it('maps only paid checkouts and non-zero invoices to paid', () => {
    expect(mapStripeEvent(checkout('evt_1'), NOW)).toMatchObject({
      kind: 'paid',
      objectId: 'cs_test_001',
      customerId: CUSTOMER,
      email: EMAIL
    });
    expect(
      mapStripeEvent(
        envelope('checkout.session.completed', {
          id: 'cs_unpaid',
          mode: 'payment',
          payment_status: 'unpaid'
        }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('checkout.session.completed', {
          id: 'cs_setup',
          mode: 'setup',
          payment_status: 'paid'
        }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('invoice.paid', { id: 'in_zero', customer: CUSTOMER, amount_paid: 0 }),
        NOW
      )
    ).toBeNull();
    expect(
      mapStripeEvent(
        envelope('invoice.paid', {
          id: 'in_1',
          customer: CUSTOMER,
          customer_email: EMAIL,
          amount_paid: AMOUNT
        }),
        NOW
      )
    ).toMatchObject({ kind: 'paid', objectId: 'in_1' });
    expect(mapStripeEvent(envelope('charge.refunded', { id: 'ch_1' }), NOW)).toBeNull();
  });

  it('calls a subscription change an upgrade only when the monthly run rate rises', () => {
    const items = (...prices: Array<ReturnType<typeof price>>) =>
      prices.map((p) => ({ price: p, quantity: 1 }));
    expect(isSubscriptionUpgrade(items(price(2500, 'month')), items(price(1000, 'month')))).toBe(
      true
    );
    expect(isSubscriptionUpgrade(items(price(1000, 'month')), items(price(2500, 'month')))).toBe(
      false
    );
    // 9000/month is below 120000/year (10000/month).
    expect(isSubscriptionUpgrade(items(price(9000, 'month')), items(price(120000, 'year')))).toBe(
      false
    );
    expect(
      isSubscriptionUpgrade(
        [{ price: price(1000, 'month'), quantity: 3 }],
        [{ price: price(1000, 'month'), quantity: 2 }]
      )
    ).toBe(true);
    expect(
      isSubscriptionUpgrade(items(price(5000, 'month', 'eur')), items(price(1000, 'month')))
    ).toBe(false);
    expect(isSubscriptionUpgrade(items(price(null, 'month')), items(price(1000, 'month')))).toBe(
      false
    );

    const upgraded = envelope(
      'customer.subscription.updated',
      { id: 'sub_1', customer: CUSTOMER, items: { data: items(price(2500, 'month')) } },
      { items: { data: items(price(1000, 'month')) } }
    );
    expect(mapStripeEvent(upgraded, NOW)).toMatchObject({ kind: 'upgraded', objectId: 'sub_1' });
    const metadataOnly = envelope(
      'customer.subscription.updated',
      { id: 'sub_1', customer: CUSTOMER, items: { data: items(price(2500, 'month')) } },
      { metadata: { plan: 'x' } }
    );
    expect(mapStripeEvent(metadataOnly, NOW)).toBeNull();
    expect(
      mapStripeEvent(
        envelope('customer.subscription.deleted', { id: 'sub_1', customer: CUSTOMER }),
        NOW
      )
    ).toMatchObject({ kind: 'cancelled', objectId: 'sub_1' });
  });

  it('creates Accounts only from company domains', () => {
    expect(companyDomainFromEmail('ada@acme.com')).toBe('acme.com');
    expect(companyDomainFromEmail('ada@gmail.com')).toBeNull();
    expect(companyDomainFromEmail('ada@yahoo.co.uk')).toBeNull();
    expect(companyDomainFromEmail('not-an-email')).toBeNull();
  });
});

describe('Stripe webhook through createApp', () => {
  it('verifies a signed delivery at the real mount point (raw body before express.json)', async () => {
    const fullApp = createApp(db);
    const event = envelope('customer.subscription.deleted', {
      id: 'sub_e2e',
      customer: 'cus_E2E1'
    });
    const payload = JSON.stringify({ object: 'event', api_version: '2026-09-30', ...event });
    const signed = (secret: string) =>
      request(fullApp)
        .post(`/api/hooks/v1/stripe/${endpoint.id}`)
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', Stripe.webhooks.generateTestHeaderString({ payload, secret }))
        .send(payload);
    expect((await signed(SECRET)).body).toEqual({ received: true, handled: false });
    expect((await signed(`whsec_${randomBytes(24).toString('hex')}`)).status).toBe(400);
  });
});

describe('Stripe webhook delivery', () => {
  it('records payment, upgrade and cancellation once each, however often Stripe retries', async () => {
    const first = await deliver(checkout('evt_checkout_1'));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, handled: true });
    expect((await deliver(checkout('evt_checkout_1'))).body).toEqual({
      received: true,
      duplicate: true
    });
    await deliver(
      envelope(
        'invoice.paid',
        {
          id: 'in_test_001',
          customer: CUSTOMER,
          customer_email: EMAIL,
          amount_paid: AMOUNT,
          lines: { data: [{ description: 'Secret Pro Plan', amount: AMOUNT }] }
        },
        null,
        'evt_invoice_1'
      )
    ).expect(200);
    const items = (amount: number) => [{ price: price(amount, 'month'), quantity: 1 }];
    await deliver(
      envelope(
        'customer.subscription.updated',
        { id: 'sub_test_001', customer: CUSTOMER, items: { data: items(4900) } },
        { items: { data: items(1900) } },
        'evt_sub_up_1'
      )
    ).expect(200);
    for (const eventId of ['evt_sub_del_1', 'evt_sub_del_2'])
      await deliver(
        envelope(
          'customer.subscription.deleted',
          { id: 'sub_test_001', customer: CUSTOMER },
          null,
          eventId
        )
      ).expect(200);

    for (const [kind, expected] of [
      ['paid', 1],
      ['upgraded', 1],
      ['cancelled', 1]
    ] as const)
      expect(
        await count(
          'SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND kind=?',
          WS_A,
          kind
        ),
        kind
      ).toBe(expected);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=? AND stage='won'",
        WS_A
      )
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM opportunities WHERE workspace_id=?', WS_A)
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_signals s JOIN accounts a ON a.id=s.account_id WHERE s.workspace_id=? AND a.domain='acme-stripe.example' AND s.kind='customer-paid'",
        WS_A
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM person_identities WHERE workspace_id=? AND provider='stripe' AND identity_type='customer' AND normalized_value=?",
        WS_A,
        CUSTOMER
      )
    ).toBe(1);
  });

  it('attaches only to the endpoint workspace, even when another workspace knows the email', async () => {
    expect(
      await count('SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=?', WS_B)
    ).toBe(0);
    const owners = await db
      .prepare(
        `SELECT DISTINCT p.workspace_id FROM product_milestones m
         JOIN contacts p ON p.id=m.contact_id
         WHERE m.provider_endpoint_id=?`
      )
      .all<{ workspace_id: string }>(endpoint.id);
    expect(owners).toEqual([{ workspace_id: WS_A }]);
  });

  it('stores ids only: no amount, email, description or line items at rest', async () => {
    const raw = JSON.stringify(
      await Promise.all([
        db
          .prepare(
            'SELECT payload_json::text AS a, metadata_json::text AS b FROM domain_events WHERE workspace_id=?'
          )
          .all(WS_A),
        db
          .prepare(
            "SELECT (to_jsonb(m) - 'id' - 'workspace_id' - 'contact_id' - 'account_id' - 'provider_endpoint_id' - 'source_id' - 'external_object_id' - 'idempotency_key')::text AS a FROM product_milestones m WHERE workspace_id=?"
          )
          .all(WS_A),
        db
          .prepare(
            "SELECT (to_jsonb(w) - 'id' - 'payload_hash' - 'workspace_id' - 'external_event_id')::text AS a FROM webhook_events w WHERE workspace_id=?"
          )
          .all(WS_A),
        db
          .prepare(
            "SELECT detail AS a, COALESCE(previous,'') AS b, COALESCE(current,'') AS c FROM account_signals WHERE workspace_id=?"
          )
          .all(WS_A),
        db.prepare('SELECT rationale_json AS a FROM account_scores WHERE workspace_id=?').all(WS_A)
      ])
    );
    // Only content-bearing text is searched: id-shaped tokens, hashes and ISO
    // timestamps are removed so the amount digits cannot match them by chance.
    const stored = raw
      .replace(/[A-Za-z0-9]{2,8}_[A-Za-z0-9_-]{6,}/g, '')
      .replace(/\b[0-9a-f]{32,}\b/g, '')
      .replace(/\d{4}-\d{2}-\d{2}[T ][0-9:.+Z-]+/g, '');
    expect(stored).not.toContain(String(AMOUNT));
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain('Secret Pro Plan');
    expect(stored).not.toContain('line_items');
  });

  it('ignores test-mode events, unknown customers, and bad signatures', async () => {
    const testMode = { ...checkout('evt_test_mode'), livemode: false };
    expect((await deliver(testMode)).body).toEqual({ received: true, handled: false });
    const stranger = envelope(
      'customer.subscription.deleted',
      { id: 'sub_stranger', customer: 'cus_Stranger999' },
      null,
      'evt_stranger'
    );
    expect((await deliver(stranger)).body).toEqual({ received: true, handled: false });
    const forged = await deliver(
      checkout('evt_forged'),
      `whsec_${randomBytes(24).toString('hex')}`
    );
    expect(forged.status).toBe(400);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND source_id IN ('evt_test_mode','evt_stranger','evt_forged')",
        WS_A
      )
    ).toBe(0);
  });
});
