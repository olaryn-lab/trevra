import type { OutboundWebhookSubscription } from './api';

/** Founder-facing wording for the server's delivery reason codes. */
const REASONS: Record<string, string> = {
  invalid_url: 'Invalid URL',
  scheme_not_allowed: 'Not HTTPS',
  credentials_in_url: 'Credentials in URL',
  query_or_fragment_not_allowed: 'Query or fragment in URL',
  port_not_allowed: 'Port not allowed',
  ip_literal_not_allowed: 'IP address instead of hostname',
  host_not_allowed: 'Private or internal hostname',
  host_not_allowlisted: 'Host not approved by operator',
  dns_resolution_failed: 'Host did not resolve',
  address_not_public: 'Host resolves to a private address',
  connect_timeout: 'Connection timed out',
  timeout: 'Endpoint timed out',
  tls_failed: 'TLS handshake failed',
  connection_failed: 'Connection failed',
  response_too_large: 'Response too large',
  redirect_not_followed: 'Redirect (not followed)',
  http_error: 'Error status',
  subscription_inactive: 'Endpoint paused',
  secret_unavailable: 'Signing secret unavailable'
};

export function reasonLabel(code: string | null): string {
  if (!code) return '—';
  return REASONS[code] ?? code;
}

export function subscriptionStatus(subscription: OutboundWebhookSubscription): {
  label: string;
  tone: 'ok' | 'warn' | 'fail' | 'muted';
} {
  if (!subscription.active)
    return subscription.disabledReason === 'consecutive_failures'
      ? { label: 'Auto-paused', tone: 'fail' }
      : { label: 'Paused', tone: 'muted' };
  if (subscription.consecutiveFailures > 0) return { label: 'Failing', tone: 'warn' };
  return { label: 'Active', tone: 'ok' };
}

export function endpointHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Overlap choices offered when rotating; 0 revokes the old secret at once. */
export const ROTATION_OVERLAP_HOURS = [0, 1, 24, 72, 168] as const;

export function overlapLabel(hours: number): string {
  if (hours === 0) return 'Revoke immediately';
  if (hours === 1) return '1 hour';
  if (hours % 24 === 0) return hours === 24 ? '24 hours' : `${hours / 24} days`;
  return `${hours} hours`;
}
