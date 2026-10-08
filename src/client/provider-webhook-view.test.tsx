import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderWebhookEndpointSummary } from './api';
import { STRIPE_OBSERVED_EVENTS } from '../shared/stripe-events';
import {
  SECRET_CUSTODY_MISSING,
  SecretCustodyNotice,
  StripeEventSelection,
  WebhookEndpointRow,
  copyText,
  providerWebhookUrl,
  showStripePanel
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
  });

  it('lists every event the server maps, including delayed payments, and says test mode never records', () => {
    const html = renderToStaticMarkup(<StripeEventSelection />);
    expect([...STRIPE_OBSERVED_EVENTS]).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'invoice.paid',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    ]);
    for (const name of STRIPE_OBSERVED_EVENTS) expect(html).toContain(`<code>${name}</code>`);
    expect(html).toContain(
      'Test-mode events are verified and counted, but never recorded as payments.'
    );
  });

  it('reports a rejected or missing clipboard instead of failing silently', async () => {
    const written: string[] = [];
    expect(
      await copyText('https://a.example/x', {
        writeText: async (text) => void written.push(text)
      })
    ).toBe(true);
    expect(written).toEqual(['https://a.example/x']);
    expect(
      await copyText('https://a.example/x', {
        writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
      })
    ).toBe(false);
    expect(await copyText('https://a.example/x', undefined)).toBe(false);
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

  it('shows a paused endpoint in a different tone from a listening one', () => {
    const row = (status: ProviderWebhookEndpointSummary['status']) =>
      renderToStaticMarkup(
        <WebhookEndpointRow
          endpoint={{ ...endpoint, status }}
          url="https://app.trevra.example/x"
          lastDelivery="None yet"
          busy={false}
          onToggle={() => undefined}
          onRemove={() => undefined}
        />
      );
    expect(row('active')).toContain('status-pill ok');
    expect(row('disabled')).toContain('status-pill muted');
    expect(row('disabled')).not.toContain('status-pill ok');
  });

  it('says missing secret storage in one founder-facing sentence, without an env var name', () => {
    const html = renderToStaticMarkup(<SecretCustodyNotice />);
    expect(html).toContain(SECRET_CUSTODY_MISSING);
    expect(SECRET_CUSTODY_MISSING).not.toContain('TREVRA_SECRETS_KEY');
    expect(html).toContain('role="status"');
  });

  it('names the provider it is given instead of Stripe', () => {
    const html = renderToStaticMarkup(
      <WebhookEndpointRow
        providerLabel="Cal.com"
        endpoint={{ ...endpoint, provider: 'calcom', path: '/api/hooks/v1/calcom/x' }}
        url="https://app.trevra.example/api/hooks/v1/calcom/x"
        lastDelivery="None yet"
        busy={false}
        onToggle={() => undefined}
        onRemove={() => undefined}
      />
    );
    expect(html).toContain('Cal.com endpoint');
    expect(html).toContain('Endpoint URL in Cal.com');
    expect(html).not.toContain('Stripe');
  });

  it('keeps the panel visible when loading failed, never a silent blank', () => {
    expect(showStripePanel('error', false)).toBe(true);
    expect(showStripePanel('ok', false)).toBe(false);
    expect(showStripePanel('ok', true)).toBe(true);
    expect(showStripePanel('pending', false)).toBe(false);
  });
});
