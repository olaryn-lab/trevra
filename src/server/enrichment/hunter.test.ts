import { describe, expect, it, vi } from 'vitest';
import { createHunterProvider } from './hunter.js';
import { EnrichmentProviderError, estimateEnrichmentCredits } from './provider.js';

const KEY = 'hunter-test-key-0001';

function stubFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('unexpected Hunter call');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('Hunter adapter', () => {
  it('checks the key against the free account endpoint with the key in a header', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { data: { email: 'f@x.com' } } }]);
    await createHunterProvider(KEY, { fetchImpl }).checkKey();
    expect(calls[0]!.url).toBe('https://api.hunter.io/v2/account');
    expect(calls[0]!.headers['X-API-KEY']).toBe(KEY);
  });

  it('maps a domain search to sourced, lower-cased candidates and counts one credit per email', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: {
          data: {
            emails: [
              {
                value: 'Maya@Acme.com',
                confidence: 94,
                first_name: 'Maya',
                last_name: 'Chen',
                position: 'CEO',
                sources: [{ uri: 'ftp://old' }, { uri: 'https://acme.com/team' }]
              },
              { value: 'jonas@acme.com', confidence: 60, sources: [] }
            ]
          }
        }
      }
    ]);
    const result = await createHunterProvider(KEY, { fetchImpl }).domainSearch('acme.com', {
      limit: 3
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v2/domain-search');
    expect(url.searchParams.get('domain')).toBe('acme.com');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('type')).toBe('personal');
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(result.credits).toBe(2);
    expect(result.candidates).toEqual([
      {
        email: 'maya@acme.com',
        firstName: 'Maya',
        lastName: 'Chen',
        position: 'CEO',
        sourceUri: 'https://acme.com/team',
        providerConfidence: 94
      },
      {
        email: 'jonas@acme.com',
        firstName: null,
        lastName: null,
        position: null,
        sourceUri: null,
        providerConfidence: 60
      }
    ]);
  });

  it('charges nothing when a domain search finds no email', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { data: { emails: [] } } }]);
    const result = await createHunterProvider(KEY, { fetchImpl }).domainSearch('empty.com', {
      limit: 3
    });
    expect(result).toEqual({ candidates: [], credits: 0 });
  });

  it('polls a 202 verification and charges half a credit for a definite answer', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([
      { status: 202, body: {} },
      { status: 200, body: { data: { status: 'valid' } } }
    ]);
    const result = await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail(
      'maya@acme.com'
    );
    expect(result).toEqual({ status: 'valid', credits: 0.5 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('charges half a credit for unknown or disposable results too', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { data: { status: 'unknown' } } },
      { status: 200, body: { data: { status: 'disposable' } } }
    ]);
    const provider = createHunterProvider(KEY, { fetchImpl });
    expect(await provider.verifyEmail('a@acme.com')).toEqual({ status: 'unknown', credits: 0.5 });
    expect(await provider.verifyEmail('b@acme.com')).toEqual({
      status: 'disposable',
      credits: 0.5
    });
  });

  it('treats a 222 SMTP failure as unknown and a 451 claimed email as claimed, charged and non-fatal', async () => {
    const { fetchImpl } = stubFetch([{ status: 222 }, { status: 451 }]);
    const provider = createHunterProvider(KEY, { fetchImpl });
    expect(await provider.verifyEmail('a@acme.com')).toEqual({ status: 'unknown', credits: 0.5 });
    expect(await provider.verifyEmail('b@acme.com')).toEqual({ status: 'claimed', credits: 0.5 });
  });

  it('assumes a charge when verification is still running after the last poll', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([{ status: 202 }, { status: 202 }, { status: 202 }]);
    const result = await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail('a@acme.com');
    expect(result).toEqual({ status: 'unknown', credits: 0.5 });
  });

  it('maps provider failures to stable codes without echoing the key', async () => {
    const cases: Array<[{ status: number } | Error, string]> = [
      [{ status: 401 }, 'key_invalid'],
      [{ status: 403 }, 'rate_limited'],
      [{ status: 429 }, 'quota_exhausted'],
      [{ status: 400 }, 'rejected'],
      [{ status: 503 }, 'unavailable'],
      [new TypeError('fetch failed'), 'unavailable']
    ];
    for (const [response, code] of cases) {
      const { fetchImpl } = stubFetch([response]);
      const error = await createHunterProvider(KEY, { fetchImpl })
        .checkKey()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EnrichmentProviderError);
      expect((error as EnrichmentProviderError).code).toBe(code);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('records the raw charge when Hunter returns more emails than the limit', async () => {
    const emails = Array.from({ length: 5 }, (_, i) => ({ value: `p${i}@acme.com`, sources: [] }));
    const { fetchImpl } = stubFetch([{ status: 200, body: { data: { emails } } }]);
    const result = await createHunterProvider(KEY, { fetchImpl }).domainSearch('acme.com', {
      limit: 3
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.credits).toBe(5);
  });

  it('never drops the charge for malformed entries or a missing emails array', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 200,
        body: {
          data: {
            emails: [
              { value: 'good@acme.com' },
              { value: 'bad@acme.com', confidence: '94' },
              { value: '   ' }
            ]
          }
        }
      },
      { status: 200, body: { data: {} } }
    ]);
    const provider = createHunterProvider(KEY, { fetchImpl });
    const first = await provider.domainSearch('acme.com', { limit: 5 });
    expect(first.candidates.map((c) => c.email)).toEqual(['good@acme.com']);
    expect(first.credits).toBe(3);
    expect(await provider.domainSearch('acme.com', { limit: 5 })).toEqual({
      candidates: [],
      credits: 0
    });
  });

  it('keeps the charge when a poll fails after a 202, but throws on the first call', async () => {
    const sleep = vi.fn(async () => undefined);
    for (const later of [{ status: 429 }, { status: 503 }, new TypeError('fetch failed')]) {
      const { fetchImpl } = stubFetch([{ status: 202 }, later]);
      expect(
        await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail('a@acme.com')
      ).toEqual({ status: 'unknown', credits: 0.5 });
    }
    const { fetchImpl } = stubFetch([{ status: 429 }]);
    await expect(
      createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail('a@acme.com')
    ).rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('passes an abort signal on every call and maps abort/timeout to unavailable', async () => {
    const signals: unknown[] = [];
    const ok = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response('{}', { status: 200 });
    });
    await createHunterProvider(KEY, { fetchImpl: ok as unknown as typeof fetch }).checkKey();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    for (const name of ['AbortError', 'TimeoutError']) {
      const failing = vi.fn(async () => {
        throw new DOMException('timed out', name);
      });
      await expect(
        createHunterProvider(KEY, { fetchImpl: failing as unknown as typeof fetch }).checkKey()
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('rejects a non-finite limit before any request', async () => {
    const { fetchImpl, calls } = stubFetch([]);
    await expect(
      createHunterProvider(KEY, { fetchImpl }).domainSearch('acme.com', { limit: Number.NaN })
    ).rejects.toMatchObject({ code: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('does not sleep after the final pending poll', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([{ status: 202 }, { status: 202 }, { status: 202 }]);
    await createHunterProvider(KEY, { fetchImpl, sleep }).verifyEmail('a@acme.com');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('estimates the worst case: one credit per email plus half a credit to verify it', () => {
    expect(estimateEnrichmentCredits({ domains: 2, emailsPerDomain: 3 })).toEqual({
      searchCredits: 6,
      verificationCredits: 3,
      estimatedCredits: 9
    });
  });
});
