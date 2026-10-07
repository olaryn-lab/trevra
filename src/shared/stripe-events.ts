/**
 * The Stripe events Trevra observes: exactly what the founder selects in the
 * Stripe Dashboard (https://docs.stripe.com/webhooks). Shared so the setup
 * screen and the webhook mapper (`src/server/provider-webhooks/stripe.ts`)
 * cannot drift apart.
 *
 * `checkout.session.async_payment_succeeded` is how a delayed payment method
 * (bank debit, voucher) reports the money arriving after a checkout that
 * completed unpaid (https://docs.stripe.com/checkout/fulfillment).
 */
export const STRIPE_OBSERVED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted'
] as const;
