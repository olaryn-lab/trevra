import { PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import type { ProviderWebhookEndpointSummary } from './api';
import { Button } from './ui/primitives';

/** The events the founder selects in Stripe (server: STRIPE_OBSERVED_EVENTS). */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted'
] as const;

export type WebhookLoadState = 'pending' | 'ok' | 'error';

/** Hidden only while loading or when the server does not offer Stripe; a failed load stays visible. */
export function showStripePanel(load: WebhookLoadState, available: boolean): boolean {
  if (load === 'error') return true;
  return load === 'ok' && available;
}

export function providerWebhookUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${path}`;
}

export function WebhookEndpointRow({
  endpoint,
  url,
  lastDelivery,
  busy,
  onToggle,
  onRemove
}: {
  endpoint: ProviderWebhookEndpointSummary;
  url: string;
  lastDelivery: string;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const active = endpoint.status === 'active';
  return (
    <article className="capture-webhook-endpoint">
      <header>
        <strong>Stripe endpoint</strong>
        <span className={active ? 'status-pill ok' : 'status-pill'}>
          {active ? 'Listening' : 'Paused'}
        </span>
      </header>
      <div className="capture-secret">
        <strong>Endpoint URL in Stripe</strong>
        <code>{url}</code>
      </div>
      <div className="capture-metrics">
        <span>
          <strong>{endpoint.acceptedCount}</strong>
          <small>Verified deliveries</small>
        </span>
        <span>
          <strong>{endpoint.rejectedCount}</strong>
          <small>Rejected deliveries</small>
        </span>
        <span>
          <strong>{lastDelivery}</strong>
          <small>Last delivery</small>
        </span>
      </div>
      <div className="capture-actions">
        <Button disabled={busy} onClick={onToggle}>
          {active ? <PauseCircle size={15} aria-hidden /> : <PlayCircle size={15} aria-hidden />}
          {active ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="danger" disabled={busy} onClick={onRemove}>
          <Trash2 size={15} aria-hidden /> Remove
        </Button>
      </div>
    </article>
  );
}
