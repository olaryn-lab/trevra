import { PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import type { ProviderWebhookEndpointSummary } from './api';
import { STRIPE_OBSERVED_EVENTS } from '../shared/stripe-events';
import { Button } from './ui/primitives';

/** The events to select in Stripe: the same list the server maps. */
export function StripeEventSelection() {
  return (
    <>
      <div className="capture-webhook-events">
        {STRIPE_OBSERVED_EVENTS.map((name) => (
          <code key={name}>{name}</code>
        ))}
      </div>
      <p className="li-hint">
        Test-mode events are verified and counted, but never recorded as payments.
      </p>
    </>
  );
}

/**
 * Clipboard writes reject without permission or focus, and the API is absent
 * outside a secure context. Reports the outcome instead of failing silently.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard
): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
  onRemove,
  providerLabel = 'Stripe'
}: {
  endpoint: ProviderWebhookEndpointSummary;
  url: string;
  lastDelivery: string;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
  providerLabel?: string;
}) {
  const active = endpoint.status === 'active';
  return (
    <article className="capture-webhook-endpoint">
      <header>
        <strong>{providerLabel} endpoint</strong>
        <span className={active ? 'status-pill ok' : 'status-pill'}>
          {active ? 'Listening' : 'Paused'}
        </span>
      </header>
      <div className="capture-secret">
        <strong>Endpoint URL in {providerLabel}</strong>
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
