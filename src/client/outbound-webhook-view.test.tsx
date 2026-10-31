import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OutboundWebhookSubscription } from './api';
import { OutboundWebhookDetail, type OutboundWebhookDetailData } from './OutboundWebhookSetup';
import {
  ROTATION_OVERLAP_HOURS,
  endpointHost,
  overlapLabel,
  reasonLabel,
  subscriptionStatus
} from './outbound-webhook-view';

const subscription: OutboundWebhookSubscription = {
  id: 'owh_1',
  workspaceId: 'ws_1',
  url: 'https://hooks.example.org/trevra',
  eventTypes: ['linkedin_campaign.started'],
  active: true,
  createdAt: '2026-10-30T09:00:00.000Z',
  disabledReason: null,
  disabledAt: null,
  secretRotatedAt: null,
  previousSecretExpiresAt: null,
  consecutiveFailures: 0,
  lastFailureCode: null,
  lastFailureAt: null,
  lastSuccessAt: null
};

const counts = { delivered: 3, failed: 2, pending: 1, dead: 1 };
const detail: OutboundWebhookDetailData = {
  health: {
    stats: {
      last24h: counts,
      last7d: { ...counts, delivered: 9 },
      consecutiveFailures: 2,
      lastFailureCode: 'http_error',
      lastFailureAt: '2026-10-30T09:05:00.000Z',
      lastSuccessAt: null
    },
    attempts: [
      {
        id: 'att_1',
        deliveryId: 'owd_1',
        eventId: 'evt_1',
        attemptSeries: 1,
        attemptNumber: 2,
        outcome: 'blocked',
        httpStatus: null,
        latencyMs: null,
        reasonCode: 'address_not_public',
        attemptedAt: '2026-10-30T09:05:00.000Z'
      },
      {
        id: 'att_2',
        deliveryId: 'owd_1',
        eventId: 'evt_1',
        attemptSeries: 0,
        attemptNumber: 1,
        outcome: 'failed',
        httpStatus: 503,
        latencyMs: 42,
        reasonCode: 'http_error',
        attemptedAt: '2026-10-30T09:00:00.000Z'
      }
    ]
  },
  dead: [
    {
      id: 'owd_1',
      eventId: 'evt_1',
      status: 'dead',
      attempts: 6,
      attemptSeries: 0,
      lastHttpStatus: 503,
      lastError: 'Endpoint returned HTTP 503',
      lastReasonCode: 'http_error',
      createdAt: '2026-10-30T08:00:00.000Z',
      deliveredAt: null,
      deadAt: '2026-10-30T09:00:00.000Z',
      replayedAt: null
    }
  ]
};

const render = (sub: OutboundWebhookSubscription) =>
  renderToStaticMarkup(
    <OutboundWebhookDetail subscription={sub} detail={detail} busy="" onReplay={() => undefined} />
  );

describe('outbound webhook view', () => {
  it('labels every subscription state, distinguishing an auto-pause from an owner pause', () => {
    expect(subscriptionStatus(subscription)).toEqual({ label: 'Active', tone: 'ok' });
    expect(subscriptionStatus({ ...subscription, consecutiveFailures: 3 })).toEqual({
      label: 'Failing',
      tone: 'warn'
    });
    expect(subscriptionStatus({ ...subscription, active: false, disabledReason: 'owner' })).toEqual(
      { label: 'Paused', tone: 'muted' }
    );
    expect(
      subscriptionStatus({
        ...subscription,
        active: false,
        disabledReason: 'consecutive_failures'
      })
    ).toEqual({ label: 'Auto-paused', tone: 'fail' });
  });

  it('names reason codes and degrades to the raw code or a dash', () => {
    expect(reasonLabel('address_not_public')).toBe('Host resolves to a private address');
    expect(reasonLabel('redirect_not_followed')).toBe('Redirect (not followed)');
    expect(reasonLabel('something_new')).toBe('something_new');
    expect(reasonLabel(null)).toBe('—');
  });

  it('offers the server-accepted overlap range with readable labels', () => {
    expect(ROTATION_OVERLAP_HOURS.every((hours) => hours >= 0 && hours <= 168)).toBe(true);
    expect(ROTATION_OVERLAP_HOURS.map(overlapLabel)).toEqual([
      'Revoke immediately',
      '1 hour',
      '24 hours',
      '3 days',
      '7 days'
    ]);
    expect(endpointHost('https://hooks.example.org/trevra')).toBe('hooks.example.org');
    expect(endpointHost('not a url')).toBe('not a url');
  });

  it('renders window stats, attempts without bodies, and dead deliveries with replay', () => {
    const html = render(subscription);
    expect(html).toContain('Last 24 hours');
    expect(html).toContain('<strong>9</strong>');
    expect(html).toContain('2 consecutive failed attempts');
    expect(html).toContain('503');
    expect(html).toContain('42 ms');
    expect(html).toContain('Host resolves to a private address');
    expect(html).toContain('Replay 1');
    expect(html).toContain('Replay dead deliveries');
    expect(html).toContain('up to 500 at a time');
    expect(html).toContain('aria-label="Replay delivery for event evt_1"');
    expect(html).not.toContain('Endpoint returned HTTP 503');
    expect(html).not.toContain('style=');
  });

  it('disables replay while the subscription is inactive and says why', () => {
    const html = render({ ...subscription, active: false, disabledReason: 'owner' });
    expect(html).toContain('Resume the endpoint before replaying dead deliveries.');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});
