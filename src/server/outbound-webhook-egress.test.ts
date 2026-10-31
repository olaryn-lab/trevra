import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WebhookEgressError,
  checkWebhookUrl,
  nodeWebhookTransport,
  pinnedLookup,
  resolvePublicAddress,
  vetWebhookDestination,
  webhookEgressPolicy,
  type WebhookEgressPolicy,
  type WebhookReasonCode,
  type WebhookTransportRequest
} from './outbound-webhook-egress.js';

const POLICY: WebhookEgressPolicy = {
  allowedHosts: ['hooks.partner.example'],
  allowedPorts: [],
  allowHttp: false
};
const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

async function codeOf(work: () => unknown): Promise<WebhookReasonCode | 'ok'> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof WebhookEgressError) return error.code;
    throw error;
  }
}
const resolvingTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('webhook destination address classes', () => {
  // Every class the DNS answer may smuggle in; each must be refused at resolve time.
  const blocked: Record<string, string[]> = {
    loopback: ['127.0.0.1', '127.255.255.254'],
    rfc1918: ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1'],
    cgnat: ['100.64.0.1', '100.127.255.254'],
    'link-local / metadata': ['169.254.0.1', '169.254.169.254'],
    multicast: ['224.0.0.1', '239.255.255.250'],
    unspecified: ['0.0.0.0', '0.1.2.3'],
    broadcast: ['255.255.255.255'],
    'ipv6 loopback / unspecified': ['::1', '::'],
    'ipv6 ula': ['fc00::1', 'fd12:3456:789a::1'],
    'ipv6 link-local': ['fe80::1', 'fe80::1%eth0'],
    'ipv6 multicast': ['ff02::1'],
    'ipv4-mapped ipv6': [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:192.168.0.1',
      '::ffff:100.64.0.1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:0.0.0.0',
      '::ffff:224.0.0.1'
    ],
    'nat64-embedded': ['64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1'],
    'decimal / octal / hex ipv4 spellings': [
      '2130706433',
      '017700000001',
      '0x7f000001',
      '0x7f.0.0.1',
      '0177.0.0.1',
      '127.1',
      '2852039166'
    ]
  };
  for (const [label, addresses] of Object.entries(blocked)) {
    it(`refuses ${label}`, async () => {
      for (const address of addresses) {
        expect(
          await codeOf(() => resolvePublicAddress('hooks.partner.example', resolvingTo(address))),
          address
        ).toBe('address_not_public');
      }
    });
  }

  it('refuses a public answer mixed with a private one, and resolution failures', async () => {
    expect(
      await codeOf(() =>
        resolvePublicAddress('hooks.partner.example', resolvingTo(PUBLIC_V4, '10.0.0.7'))
      )
    ).toBe('address_not_public');
    expect(
      await codeOf(() =>
        resolvePublicAddress('hooks.partner.example', resolvingTo(PUBLIC_V6, 'fe80::2'))
      )
    ).toBe('address_not_public');
    expect(await codeOf(() => resolvePublicAddress('hooks.partner.example', resolvingTo()))).toBe(
      'dns_resolution_failed'
    );
    expect(
      await codeOf(() =>
        resolvePublicAddress('hooks.partner.example', async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        })
      )
    ).toBe('dns_resolution_failed');
  });

  it('pins the first public answer', async () => {
    expect(
      await resolvePublicAddress('hooks.partner.example', resolvingTo(PUBLIC_V4, PUBLIC_V6))
    ).toEqual({ address: PUBLIC_V4, family: 4 });
    expect(await resolvePublicAddress('hooks.partner.example', resolvingTo(PUBLIC_V6))).toEqual({
      address: PUBLIC_V6,
      family: 6
    });
  });
});

describe('webhook URL policy', () => {
  it('assigns a reason code to every structural refusal', () => {
    const cases: Array<[string, WebhookReasonCode]> = [
      ['not a url', 'invalid_url'],
      ['http://hooks.partner.example/hook', 'scheme_not_allowed'],
      ['ftp://hooks.partner.example/hook', 'scheme_not_allowed'],
      ['https://user:pass@hooks.partner.example/hook', 'credentials_in_url'],
      ['https://token@hooks.partner.example/hook', 'credentials_in_url'],
      ['https://hooks.partner.example/hook?token=x', 'query_or_fragment_not_allowed'],
      ['https://hooks.partner.example/hook#frag', 'query_or_fragment_not_allowed'],
      ['https://hooks.partner.example:8443/hook', 'port_not_allowed'],
      ['https://127.0.0.1/hook', 'ip_literal_not_allowed'],
      ['https://169.254.169.254/latest/meta-data', 'ip_literal_not_allowed'],
      ['https://2130706433/hook', 'ip_literal_not_allowed'],
      ['https://0x7f000001/hook', 'ip_literal_not_allowed'],
      ['https://0177.0.0.1/hook', 'ip_literal_not_allowed'],
      ['https://0x7f.1/hook', 'ip_literal_not_allowed'],
      ['https://[::1]/hook', 'ip_literal_not_allowed'],
      ['https://[::ffff:127.0.0.1]/hook', 'ip_literal_not_allowed'],
      ['https://[::ffff:a9fe:a9fe]/hook', 'ip_literal_not_allowed'],
      ['https://[fd00::1]/hook', 'ip_literal_not_allowed'],
      ['https://8.8.8.8/hook', 'ip_literal_not_allowed'],
      ['https://localhost/hook', 'host_not_allowed'],
      ['https://api.localhost/hook', 'host_not_allowed'],
      ['https://printer.local/hook', 'host_not_allowed'],
      ['https://metadata.google.internal/computeMetadata/v1/', 'host_not_allowed'],
      ['https://metadata.google.internal./computeMetadata/v1/', 'host_not_allowed'],
      ['https://intranet/hook', 'host_not_allowed'],
      ['https://hooks.partner.example.evil.invalid/', 'host_not_allowlisted'],
      ['https://other.example/hook', 'host_not_allowlisted']
    ];
    for (const [url, code] of cases) {
      let actual: string = 'ok';
      try {
        checkWebhookUrl(url, POLICY);
      } catch (error) {
        actual = error instanceof WebhookEgressError ? error.code : 'unexpected';
      }
      expect(actual, url).toBe(code);
    }
    expect(checkWebhookUrl('https://hooks.partner.example/hook', POLICY).toString()).toBe(
      'https://hooks.partner.example/hook'
    );
    // Default port is normalized away and therefore allowed.
    expect(checkWebhookUrl('https://hooks.partner.example:443/hook', POLICY).port).toBe('');
  });

  it('allows a non-default port or http only when configured', () => {
    expect(
      checkWebhookUrl('https://hooks.partner.example:8443/hook', {
        ...POLICY,
        allowedPorts: [8443]
      }).port
    ).toBe('8443');
    expect(
      checkWebhookUrl('http://hooks.partner.example/hook', { ...POLICY, allowHttp: true }).protocol
    ).toBe('http:');
  });

  it('never honours the plain-http flag in production', () => {
    expect(
      webhookEgressPolicy({
        NODE_ENV: 'production',
        TREVRA_OUTBOUND_WEBHOOK_ALLOW_HTTP: 'true',
        TREVRA_OUTBOUND_WEBHOOK_HOSTS: 'Hooks.Partner.Example, x.example',
        TREVRA_OUTBOUND_WEBHOOK_ALLOWED_PORTS: '8443,abc,70000,0'
      })
    ).toEqual({
      allowedHosts: ['hooks.partner.example', 'x.example'],
      allowedPorts: [8443],
      allowHttp: false
    });
    expect(
      webhookEgressPolicy({ NODE_ENV: 'test', TREVRA_OUTBOUND_WEBHOOK_ALLOW_HTTP: 'true' })
        .allowHttp
    ).toBe(true);
    expect(webhookEgressPolicy({ NODE_ENV: 'development' }).allowHttp).toBe(false);
  });

  it('runs the DNS pre-flight after the structural check', async () => {
    expect(
      await codeOf(() =>
        vetWebhookDestination(
          'https://hooks.partner.example/hook',
          POLICY,
          resolvingTo('169.254.169.254')
        )
      )
    ).toBe('address_not_public');
    let resolved = 0;
    expect(
      await codeOf(() =>
        vetWebhookDestination('https://127.0.0.1/hook', POLICY, async () => {
          resolved++;
          return [];
        })
      )
    ).toBe('ip_literal_not_allowed');
    expect(resolved).toBe(0);
    expect(
      (
        await vetWebhookDestination(
          'https://hooks.partner.example/hook',
          POLICY,
          resolvingTo(PUBLIC_V4)
        )
      ).hostname
    ).toBe('hooks.partner.example');
  });
});

describe('pinned webhook transport (loopback stub server, no DNS)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    const open = server;
    server = null;
    if (open) {
      open.closeAllConnections();
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
  });
  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return (server!.address() as AddressInfo).port;
  }
  function request(port: number, overrides: Partial<WebhookTransportRequest> = {}) {
    return {
      // `.invalid` never resolves: the request can only land if the pinned
      // address is used instead of DNS.
      url: new URL(`http://rebind-target.invalid:${port}/hook`),
      address: '127.0.0.1',
      family: 4 as const,
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"evt_1"}',
      connectTimeoutMs: 2_000,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 1024,
      ...overrides
    };
  }

  it('pinnedLookup answers with the vetted address for any hostname, both call shapes', () => {
    const lookup = pinnedLookup(PUBLIC_V4, 4);
    const single: unknown[] = [];
    lookup('evil.example', {}, (...args: unknown[]) => single.push(...args));
    expect(single).toEqual([null, PUBLIC_V4, 4]);
    const all: unknown[] = [];
    lookup('evil.example', { all: true }, (...args: unknown[]) => all.push(...args));
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 }]]);
  });

  it('connects to the vetted address, not to whatever the hostname resolves to', async () => {
    const seen: Array<{ host?: string; body: string }> = [];
    const port = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ host: req.headers.host, body });
        res.writeHead(204).end();
      });
    });
    expect(await nodeWebhookTransport(request(port))).toEqual({ status: 204 });
    expect(seen).toEqual([{ host: `rebind-target.invalid:${port}`, body: '{"id":"evt_1"}' }]);
  });

  it('returns a redirect as a status and never follows it', async () => {
    let hits = 0;
    const port = await listen((req, res) => {
      hits++;
      req.resume();
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` }).end();
    });
    expect(await nodeWebhookTransport(request(port))).toEqual({ status: 302 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hits).toBe(1);
  });

  it('aborts an endpoint that never answers at the total timeout', async () => {
    const port = await listen((req) => {
      req.resume();
      // Never respond.
    });
    const started = Date.now();
    expect(await codeOf(() => nodeWebhookTransport(request(port, { totalTimeoutMs: 150 })))).toBe(
      'timeout'
    );
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('caps the response size, streamed or declared', async () => {
    const streamed = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(512, 97);
      let sent = 0;
      const pump = () => {
        while (sent < 400 && res.write(chunk)) sent++;
        if (sent < 400) res.once('drain', pump);
        else res.end();
      };
      pump();
    });
    let error: unknown = null;
    try {
      await nodeWebhookTransport(request(streamed));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(WebhookEgressError);
    expect((error as WebhookEgressError).code).toBe('response_too_large');
    expect((error as WebhookEgressError).httpStatus).toBe(200);
  });

  it('refuses a declared Content-Length past the cap without reading it', async () => {
    const port = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Length': String(10 * 1024 * 1024) });
      res.write('x');
    });
    expect(await codeOf(() => nodeWebhookTransport(request(port)))).toBe('response_too_large');
  });

  it('reports a refused connection without leaking the socket error text', async () => {
    const port = await listen(() => undefined);
    const open = server!;
    server = null;
    await new Promise<void>((resolve) => open.close(() => resolve()));
    expect(await codeOf(() => nodeWebhookTransport(request(port)))).toBe('connection_failed');
  });
});
