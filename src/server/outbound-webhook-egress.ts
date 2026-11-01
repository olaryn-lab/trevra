/**
 * Egress policy and transport for merchant outbound webhooks (TRV-052).
 *
 * The destination is checked twice: structurally plus a DNS pre-flight when a
 * subscription is created or changed, and again before EVERY delivery attempt.
 * At delivery the host is resolved exactly once, every resolved address must be
 * public, and the socket connects to that vetted address through a pinned
 * `lookup` -- the transport never consults DNS itself, so a rebinding answer
 * between check and connect cannot redirect the write. Redirects are never
 * followed, and every attempt is bounded by a connect timeout, a total timeout
 * and a response-size cap. The response body is drained and discarded.
 *
 * Address classification reuses `isBlockedAddress` from `skills/guard.ts`:
 * loopback, RFC1918, CGNAT, link-local (incl. 169.254.169.254), multicast,
 * unspecified, reserved, IPv6 ULA/link-local/loopback, and IPv4-mapped or NAT64
 * forms of all of these. Anything it cannot parse (e.g. a decimal `2130706433`)
 * is refused rather than guessed.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedAddress } from './skills/guard.js';

export const WEBHOOK_REASON_CODES = [
  // Destination policy: checked at create/update and before every attempt.
  'invalid_url',
  'scheme_not_allowed',
  'credentials_in_url',
  'query_or_fragment_not_allowed',
  'port_not_allowed',
  'ip_literal_not_allowed',
  'host_not_allowed',
  'host_not_allowlisted',
  'dns_resolution_failed',
  'address_not_public',
  // Transport.
  'connect_timeout',
  'timeout',
  'tls_failed',
  'connection_failed',
  'response_too_large',
  'redirect_not_followed',
  'http_error',
  // Subscription state.
  'subscription_inactive',
  'secret_unavailable'
] as const;
export type WebhookReasonCode = (typeof WEBHOOK_REASON_CODES)[number];

const POLICY_CODES: ReadonlySet<WebhookReasonCode> = new Set<WebhookReasonCode>([
  'invalid_url',
  'scheme_not_allowed',
  'credentials_in_url',
  'query_or_fragment_not_allowed',
  'port_not_allowed',
  'ip_literal_not_allowed',
  'host_not_allowed',
  'host_not_allowlisted',
  'dns_resolution_failed',
  'address_not_public'
]);

/** True when the code means the destination policy refused the attempt before any socket opened. */
export function isEgressPolicyCode(code: WebhookReasonCode): boolean {
  return POLICY_CODES.has(code);
}

export class WebhookEgressError extends Error {
  constructor(
    readonly code: WebhookReasonCode,
    message: string,
    readonly httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'WebhookEgressError';
  }
}

export interface WebhookEgressPolicy {
  /** Exact, lower-case hostnames the operator approved. Empty = no delivery at all. */
  allowedHosts: readonly string[];
  /** Non-default ports the operator approved. Default ports need no entry. */
  allowedPorts: readonly number[];
  /** Plain http. Never true in production, whatever the environment says. */
  allowHttp: boolean;
}

function csv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

export function webhookEgressPolicy(env: NodeJS.ProcessEnv = process.env): WebhookEgressPolicy {
  return {
    allowedHosts: csv(env.TREVRA_OUTBOUND_WEBHOOK_HOSTS),
    allowedPorts: csv(env.TREVRA_OUTBOUND_WEBHOOK_ALLOWED_PORTS)
      .map(Number)
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
    // Dev/test escape hatch only: production always requires TLS.
    allowHttp: env.NODE_ENV !== 'production' && env.TREVRA_OUTBOUND_WEBHOOK_ALLOW_HTTP === 'true'
  };
}

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa'];

/**
 * Structural destination check. Returns the normalized URL or throws a
 * {@link WebhookEgressError} carrying the reason code. No network access.
 */
export function checkWebhookUrl(raw: string, policy: WebhookEgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookEgressError('invalid_url', 'Webhook endpoint must be a valid URL.');
  }
  if (url.toString().length > 1500)
    throw new WebhookEgressError('invalid_url', 'Webhook URL exceeds size limit.');
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:'))
    throw new WebhookEgressError('scheme_not_allowed', 'Webhook endpoint must use HTTPS.');
  if (url.username || url.password)
    throw new WebhookEgressError(
      'credentials_in_url',
      'Webhook endpoint must not carry credentials in the URL.'
    );
  if (url.search || url.hash)
    throw new WebhookEgressError(
      'query_or_fragment_not_allowed',
      'Webhook endpoint must not include a query string or fragment.'
    );
  // WHATWG drops a default port, so any remaining port is non-default.
  if (url.port && !policy.allowedPorts.includes(Number(url.port)))
    throw new WebhookEgressError(
      'port_not_allowed',
      'Webhook endpoint must use the default port for its scheme.'
    );
  // WHATWG normalizes decimal, octal and hex IPv4 spellings to dotted quads and
  // brackets IPv6, so these two tests see every literal form.
  if (!url.hostname || url.hostname.startsWith('[') || isIP(url.hostname))
    throw new WebhookEgressError(
      'ip_literal_not_allowed',
      'Webhook endpoint must be a hostname, not an IP address.'
    );
  const host = url.hostname.replace(/\.+$/, '');
  if (
    !host.includes('.') ||
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    throw new WebhookEgressError(
      'host_not_allowed',
      'Webhook endpoint must be a public internet hostname.'
    );
  if (!policy.allowedHosts.includes(host))
    throw new WebhookEgressError(
      'host_not_allowlisted',
      'Webhook endpoint host is not on the operator-approved allowlist.'
    );
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type WebhookResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemWebhookResolver: WebhookResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export interface VettedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve ONCE and require every answer to be public: one public A record does
 * not excuse an AAAA record pointing at link-local space. The first answer is
 * the address the socket will be pinned to.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolver: WebhookResolver
): Promise<VettedAddress> {
  let records: ResolvedAddress[];
  try {
    records = await resolver(hostname.replace(/\.+$/, ''));
  } catch {
    throw new WebhookEgressError('dns_resolution_failed', 'Webhook host did not resolve.');
  }
  if (!records.length)
    throw new WebhookEgressError('dns_resolution_failed', 'Webhook host did not resolve.');
  for (const record of records) {
    if (isBlockedAddress(String(record.address)))
      throw new WebhookEgressError(
        'address_not_public',
        'Webhook host resolves to a non-public address.'
      );
  }
  const address = String(records[0].address);
  const family = isIP(address);
  if (family !== 4 && family !== 6)
    throw new WebhookEgressError(
      'address_not_public',
      'Webhook host resolves to an invalid address.'
    );
  return { address, family };
}

/** Full create/update-time check: structure, allowlist, then a DNS pre-flight. */
export async function vetWebhookDestination(
  raw: string,
  policy: WebhookEgressPolicy,
  resolver: WebhookResolver = systemWebhookResolver
): Promise<URL> {
  const url = checkWebhookUrl(raw, policy);
  await resolvePublicAddress(url.hostname, resolver);
  return url;
}

export interface WebhookTransportRequest {
  url: URL;
  /** The vetted address. The transport must connect here and nowhere else. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
}
export interface WebhookTransportResponse {
  status: number;
}
export type WebhookTransport = (
  request: WebhookTransportRequest
) => Promise<WebhookTransportResponse>;

export const WEBHOOK_TRANSPORT_LIMITS = {
  connectTimeoutMs: 3_000,
  totalTimeoutMs: 10_000,
  maxResponseBytes: 64 * 1024
} as const;

/** A `lookup` that answers with the vetted address and never touches DNS. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    // Happy Eyeballs (autoSelectFamily, default on) asks for `all: true`.
    if (options && (options as { all?: boolean }).all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function classifySocketError(error: unknown): WebhookEgressError {
  const code = String((error as { code?: unknown })?.code ?? '');
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code))
    return new WebhookEgressError('tls_failed', 'TLS handshake with the webhook endpoint failed.');
  return new WebhookEgressError('connection_failed', 'Connection to the webhook endpoint failed.');
}

/**
 * Node http(s) transport. One request per socket (`agent: false`) so no pooled
 * connection to an earlier address is ever reused; SNI and certificate checks
 * still use the hostname. 3xx is returned as a status, never followed.
 */
export const nodeWebhookTransport: WebhookTransport = (input) =>
  new Promise<WebhookTransportResponse>((resolve, reject) => {
    const secure = input.url.protocol === 'https:';
    let settled = false;
    let req: ClientRequest | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;
    const finish = (error: WebhookEgressError | null, status = 0) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else resolve({ status });
    };
    connectTimer = setTimeout(
      () =>
        finish(
          new WebhookEgressError(
            'connect_timeout',
            'Webhook endpoint did not accept a connection in time.'
          )
        ),
      input.connectTimeoutMs
    );
    totalTimer = setTimeout(
      () => finish(new WebhookEgressError('timeout', 'Webhook endpoint did not respond in time.')),
      input.totalTimeoutMs
    );
    const options: RequestOptions & { servername?: string } = {
      method: 'POST',
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port ? Number(input.url.port) : secure ? 443 : 80,
      path: input.url.pathname || '/',
      headers: { ...input.headers, 'Content-Length': String(Buffer.byteLength(input.body)) },
      agent: false,
      lookup: pinnedLookup(input.address, input.family),
      ...(secure ? { servername: input.url.hostname } : {})
    };
    try {
      req = (secure ? httpsRequest : httpRequest)(options);
    } catch (error) {
      finish(classifySocketError(error));
      return;
    }
    req.once('socket', (socket) => {
      if (!socket.connecting) {
        if (connectTimer) clearTimeout(connectTimer);
      } else
        socket.once('connect', () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
    });
    req.once('response', (res) => {
      const status = res.statusCode ?? 0;
      const tooLarge = () =>
        finish(
          new WebhookEgressError(
            'response_too_large',
            'Webhook response exceeded the size limit.',
            status
          )
        );
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > input.maxResponseBytes) {
        tooLarge();
        res.destroy();
        return;
      }
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > input.maxResponseBytes) {
          tooLarge();
          res.destroy();
        }
      });
      res.once('end', () => finish(null, status));
      res.once('error', (error) => finish(classifySocketError(error)));
      res.once('close', () => {
        if (!res.complete) finish(classifySocketError(null));
      });
    });
    req.once('error', (error) => finish(classifySocketError(error)));
    req.end(input.body);
  });
