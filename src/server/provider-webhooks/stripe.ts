/**
 * Stripe, observed only.
 *
 * Trevra holds no Stripe API key and makes no Stripe API call. The founder adds
 * a per-workspace endpoint in the Stripe Dashboard; each delivery is verified
 * with Stripe's own library over the exact raw bytes
 * (https://docs.stripe.com/webhooks/signature,
 * https://github.com/stripe/stripe-node#webhook-signing), reduced to a closed
 * milestone, and recorded through the same function as the signed intake.
 *
 * STORED: the Stripe event id (milestone source) and object id (cs_/in_/sub_),
 * plus the customer id as a person identity. NEVER STORED: amounts, prices,
 * line items, invoice details or descriptions. Prices are read in memory only,
 * to decide whether a subscription change is an upgrade.
 */
import Stripe from 'stripe';
import type { Db } from '../db.js';
import { resolveContact, resolveExplicitAccount } from '../lead-capture/people.js';
import { recordProductMilestone } from '../lead-capture/milestone-recorder.js';
import type { GtmMilestoneKind } from '../lead-capture/milestones.js';
import { companyDomainFromEmail } from '../lead-capture/freemail.js';
import {
  accountForPerson,
  resolvePersonByIdentity,
  upsertPersonIdentity
} from '../person-identities.js';
import type {
  ProviderWebhookEndpoint,
  ProviderWebhookEvent,
  ProviderWebhookVerification,
  ProviderWebhookVerifier,
  WebhookHeaders
} from './types.js';

/** Stripe's documented default; bounds replay of a captured delivery. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** What the founder selects in the Stripe Dashboard; one list for server and client. */
export { STRIPE_OBSERVED_EVENTS } from '../../shared/stripe-events.js';

/** The event envelope (https://docs.stripe.com/api/events/object), loosely typed. */
export interface StripeEventEnvelope {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: Record<string, unknown>;
    previous_attributes?: Record<string, unknown> | null;
  };
}

export interface StripeItemLike {
  price?: {
    unit_amount?: unknown;
    currency?: unknown;
    recurring?: { interval?: unknown; interval_count?: unknown } | null;
  } | null;
  quantity?: unknown;
}

export interface MappedStripeEvent {
  kind: GtmMilestoneKind;
  objectId: string;
  customerId: string | null;
  email: string | null;
  name: string | null;
  occurredAt: Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function itemList(value: unknown): StripeItemLike[] | null {
  const data = record(value)?.data;
  return Array.isArray(data) ? (data as StripeItemLike[]) : null;
}

function customerIdOf(value: unknown): string | null {
  if (typeof value === 'string') return /^cus_[A-Za-z0-9]+$/.test(value) ? value : null;
  const nested = record(value);
  return nested ? customerIdOf(nested.id) : null;
}

const INTERVALS_PER_MONTH: Record<string, number> = {
  day: 365 / 12,
  week: 52 / 12,
  month: 1,
  year: 1 / 12
};

/**
 * Monthly run rate of a subscription's items, in minor units, in memory only.
 * Null when it cannot be compared honestly: mixed currencies, a price without
 * a fixed `unit_amount` (tiered or metered), or an unknown interval.
 */
export function monthlyRunRate(
  items: readonly StripeItemLike[]
): { currency: string; minorUnitsPerMonth: number } | null {
  if (items.length === 0) return null;
  let currency: string | null = null;
  let total = 0;
  for (const item of items) {
    const price = item?.price;
    const unitAmount = price?.unit_amount;
    const itemCurrency = typeof price?.currency === 'string' ? price.currency.toLowerCase() : null;
    const interval = typeof price?.recurring?.interval === 'string' ? price.recurring.interval : '';
    const perMonth = INTERVALS_PER_MONTH[interval];
    if (
      typeof unitAmount !== 'number' ||
      !Number.isFinite(unitAmount) ||
      !itemCurrency ||
      perMonth === undefined
    )
      return null;
    if (currency && currency !== itemCurrency) return null;
    currency = itemCurrency;
    const rawCount = price?.recurring?.interval_count;
    const count = typeof rawCount === 'number' && rawCount >= 1 ? Math.trunc(rawCount) : 1;
    const quantity = typeof item.quantity === 'number' && item.quantity >= 0 ? item.quantity : 1;
    total += (unitAmount * quantity * perMonth) / count;
  }
  return currency ? { currency, minorUnitsPerMonth: total } : null;
}

/**
 * THE UPGRADE RULE (content-free): a `customer.subscription.updated` event is an
 * upgrade when `data.previous_attributes.items` is present (the items changed;
 * https://docs.stripe.com/api/events/object, https://docs.stripe.com/billing/subscriptions/change-price)
 * and the monthly run rate of the new items is strictly higher than the old,
 * in the same currency. Anything not comparable is not an upgrade.
 */
export function isSubscriptionUpgrade(
  current: readonly StripeItemLike[],
  previous: readonly StripeItemLike[]
): boolean {
  const after = monthlyRunRate(current);
  const before = monthlyRunRate(previous);
  return Boolean(
    after &&
    before &&
    after.currency === before.currency &&
    after.minorUnitsPerMonth > before.minorUnitsPerMonth
  );
}

export function mapStripeEvent(envelope: StripeEventEnvelope, now: Date): MappedStripeEvent | null {
  const object = record(envelope.data?.object);
  const objectId = text(object?.id, 255);
  if (!object || !objectId) return null;
  const created =
    typeof envelope.created === 'number' && Number.isFinite(envelope.created)
      ? new Date(Math.min(envelope.created * 1000, now.getTime()))
      : now;
  const customerId = customerIdOf(object.customer);
  switch (envelope.type) {
    // A delayed payment method completes the session unpaid, then reports the
    // money with async_payment_succeeded (https://docs.stripe.com/checkout/fulfillment).
    // Both carry the same Checkout Session, so the same paid-only rule applies.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (object.mode === 'setup' || object.payment_status !== 'paid') return null;
      const details = record(object.customer_details);
      return {
        kind: 'paid',
        objectId,
        customerId,
        email: text(details?.email, 320) ?? text(object.customer_email, 320),
        name: text(details?.name, 200),
        occurredAt: created
      };
    }
    case 'invoice.paid': {
      if (!(typeof object.amount_paid === 'number' && object.amount_paid > 0)) return null;
      return {
        kind: 'paid',
        objectId,
        customerId,
        email: text(object.customer_email, 320),
        name: text(object.customer_name, 200),
        occurredAt: created
      };
    }
    case 'customer.subscription.updated': {
      if (!customerId) return null;
      const before = itemList(record(envelope.data?.previous_attributes)?.items);
      const after = itemList(object.items);
      if (!before || !after || !isSubscriptionUpgrade(after, before)) return null;
      return {
        kind: 'upgraded',
        objectId,
        customerId,
        email: null,
        name: null,
        occurredAt: created
      };
    }
    case 'customer.subscription.deleted':
      if (!customerId) return null;
      return {
        kind: 'cancelled',
        objectId,
        customerId,
        email: null,
        name: null,
        occurredAt: created
      };
    default:
      return null;
  }
}

export function verifyStripeSignature(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
  now: Date
): ProviderWebhookVerification {
  const header = headers['stripe-signature'];
  const signature = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (!signature) return { ok: false, status: 400, error: 'Missing Stripe-Signature header' };
  let event: { id?: unknown; type?: unknown } | null;
  try {
    // receivedAt is in milliseconds; the library rejects deliveries older than
    // the tolerance (https://docs.stripe.com/webhooks/signature).
    event = Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
      STRIPE_SIGNATURE_TOLERANCE_SECONDS,
      undefined,
      now.getTime()
    );
  } catch {
    return { ok: false, status: 400, error: 'Invalid Stripe signature' };
  }
  // A validly signed body need not be an object: `null` parses to null.
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string'
  )
    return { ok: false, status: 400, error: 'Stripe event is missing its id or type' };
  return { ok: true, eventId: event.id, eventType: event.type, payload: event };
}

function isClientFault(error: unknown): boolean {
  const status =
    error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export async function handleStripeEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  event: ProviderWebhookEvent,
  now: Date
): Promise<{ handled: boolean }> {
  const envelope = event.payload as StripeEventEnvelope;
  // Test-mode deliveries verify (and count as accepted) but never become
  // commercial outcomes.
  if (envelope.livemode !== true) return { handled: false };
  const mapped = mapStripeEvent(envelope, now);
  if (!mapped) return { handled: false };
  const workspaceId = endpoint.workspaceId;

  let personId: string | null = null;
  if (mapped.customerId) {
    const known = await resolvePersonByIdentity(db, {
      workspaceId,
      provider: 'stripe',
      identityType: 'customer',
      identityValue: mapped.customerId
    });
    personId = known?.id ?? null;
  }
  if (!personId && mapped.email) {
    try {
      const resolved = await resolveContact(
        db,
        workspaceId,
        { email: mapped.email, name: mapped.name },
        now
      );
      personId = resolved.contact.id;
    } catch (error) {
      // A Person this payload cannot resolve (a LeadCaptureError, always 4xx)
      // will not resolve on a retry either: ignore the event instead of making
      // Stripe redeliver it for days.
      if (isClientFault(error)) return { handled: false };
      throw error;
    }
  }
  // lc-debt: a subscription event for a customer Trevra never saw pay is
  // ignored, because observe-only means no API key to look the customer up;
  // upgrade path is an optional restricted read key in Nango.
  if (!personId) return { handled: false };
  if (mapped.customerId)
    await upsertPersonIdentity(
      db,
      {
        workspaceId,
        personId,
        provider: 'stripe',
        identityType: 'customer',
        identityValue: mapped.customerId
      },
      now
    );

  let accountId: string | null = null;
  const domain = companyDomainFromEmail(mapped.email);
  if (domain) {
    const account = await resolveExplicitAccount(
      db,
      workspaceId,
      personId,
      { domain, name: null, source: 'capture', sourceDetail: `stripe:${endpoint.id}` },
      now
    );
    accountId = account?.accountId ?? null;
  }
  if (!accountId) accountId = await accountForPerson(db, workspaceId, personId);

  await recordProductMilestone(
    db,
    {
      workspaceId,
      kind: mapped.kind,
      contactId: personId,
      accountId,
      sourceType: 'stripe_event',
      sourceId: event.eventId,
      providerEndpointId: endpoint.id,
      externalObjectId: mapped.objectId,
      occurredAt: mapped.occurredAt
    },
    now
  );
  return { handled: true };
}

export const stripeVerifier: ProviderWebhookVerifier = {
  provider: 'stripe',
  secretPattern: /^whsec_\S{16,200}$/,
  verify: verifyStripeSignature,
  handle: handleStripeEvent
};
