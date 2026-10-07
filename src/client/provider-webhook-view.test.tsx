import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderWebhookEndpointSummary } from './api';
import {
  STRIPE_WEBHOOK_EVENTS,
  WebhookEndpointRow,
  providerWebhookUrl
} from './provider-webhook-view';

const endpoint: ProviderWebhookEndpointSummary = {
  id: 'pwh_0123456789abcdef01234567',
  workspaceId: 'ws_1',
  provider: 'stripe',
  status: 'active',
  createdByUserId: 'usr_1',
  lastSeenAt: null,
  acceptedCount: 4,
  rejectedCount: 1,
  createdAt: '2026-10-06T09:00:00.000Z',
  updatedAt: '2026-10-06T09:00:00.000Z',
  path: '/api/hooks/v1/stripe/pwh_0123456789abcdef01234567'
};

describe('Stripe webhook setup view', () => {
  it('builds the URL the founder pastes into Stripe', () => {
    expect(providerWebhookUrl('https://app.trevra.example/', endpoint.path)).toBe(
      'https://app.trevra.example/api/hooks/v1/stripe/pwh_0123456789abcdef01234567'
    );
    expect([...STRIPE_WEBHOOK_EVENTS]).toEqual([
      'checkout.session.completed',
      'invoice.paid',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    ]);
  });

  it('shows the URL, honest counts and labelled actions, never a secret', () => {
    const html = renderToStaticMarkup(
      <WebhookEndpointRow
        endpoint={endpoint}
        url={`https://app.trevra.example${endpoint.path}`}
        lastDelivery="None yet"
        busy={false}
        onToggle={() => undefined}
        onRemove={() => undefined}
      />
    );
    expect(html).toContain(`https://app.trevra.example${endpoint.path}`);
    expect(html).toContain('Listening');
    expect(html).toContain('Verified deliveries');
    expect(html).toContain('Rejected deliveries');
    expect(html).toContain('None yet');
    expect(html).toContain('Pause');
    expect(html).toContain('Remove');
    expect(html).not.toContain('whsec_');
  });
});
