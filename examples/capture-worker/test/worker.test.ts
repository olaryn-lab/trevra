import { describe, expect, it } from 'vitest';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  readCaptureHeaders
} from '../../../src/server/lead-capture/signature';
import { inboundSubmissionSchema } from '../../../src/server/lead-capture/types';
import { handleCapture, type Env } from '../src/index';
import { idempotencyKeyForToken, signCaptureRequest } from '../src/sign';
import { SITEVERIFY_URL, type FetchLike } from '../src/turnstile';

// Cloudflare's documented Turnstile test secrets: always pass, always fail.
const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const EMAIL = 'ada@acme.test';
const NOW = 1_791_280_000;
const ENDPOINT = 'https://trevra.example.test/api/intake/v1/submissions';

const env: Env = {
  TREVRA_API_BASE_URL: 'https://trevra.example.test/',
  TREVRA_CAPTURE_SOURCE_ID: 'cap_worker_test',
  TREVRA_CAPTURE_SECRET: 'trv_capture_worker_test_secret',
  TURNSTILE_SECRET_KEY: PASS_SECRET,
  ALLOWED_ORIGIN: 'https://acme.test',
  TURNSTILE_HOSTNAMES: 'acme.test'
};

function stubFetch(trevraStatuses: number[], tokenHostname = 'acme.test') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const statuses = [...trevraStatuses];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === SITEVERIFY_URL) {
      const form = init.body as FormData;
      const ok = form.get('secret') === PASS_SECRET && form.get('response') === TOKEN;
      return new Response(
        JSON.stringify(
          ok
            ? { success: true, hostname: tokenHostname, 'error-codes': [] }
            : { success: false, 'error-codes': ['invalid-input-secret'] }
        ),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: statuses.shift() ?? 500 });
  };
  return { calls, fetchImpl };
}

function formRequest(
  fields: Record<string, string>,
  origin = 'https://acme.test',
  referer = 'https://acme.test/demo?utm_source=ignored#form'
) {
  return new Request('https://capture.acme.test/', {
    method: 'POST',
    headers: {
      origin,
      referer,
      'cf-connecting-ip': '203.0.113.7',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields)
  });
}

const deps = (fetchImpl: FetchLike) => ({ fetch: fetchImpl, nowSeconds: () => NOW });

/** Runs a valid post through the Worker and returns the JSON body Trevra received. */
async function postedBody(
  fields: Record<string, string>,
  options: { referer?: string; env?: Env } = {}
): Promise<Record<string, unknown>> {
  const { calls, fetchImpl } = stubFetch([202]);
  const response = await handleCapture(
    formRequest(
      { email: EMAIL, 'cf-turnstile-response': TOKEN, ...fields },
      'https://acme.test',
      options.referer
    ),
    options.env ?? env,
    deps(fetchImpl)
  );
  expect(response.status).toBe(200);
  return JSON.parse(String(calls[1].init.body)) as Record<string, unknown>;
}

describe('capture worker', () => {
  it('signs exactly what the server verifies', async () => {
    const body = JSON.stringify({ kind: 'demo_request', person: { email: EMAIL } });
    const headers = await signCaptureRequest({
      secret: env.TREVRA_CAPTURE_SECRET,
      sourceId: env.TREVRA_CAPTURE_SOURCE_ID,
      idempotencyKey: await idempotencyKeyForToken(TOKEN),
      body,
      nowSeconds: NOW
    });
    const parsed = readCaptureHeaders(headers);
    expect(parsed.sourceId).toBe('cap_worker_test');
    expect(captureHeaderProblem(parsed, NOW)).toBeNull();
    expect(captureSignatureMatches([env.TREVRA_CAPTURE_SECRET], parsed, Buffer.from(body))).toBe(
      true
    );
    expect(captureSignatureMatches(['trv_capture_other'], parsed, Buffer.from(body))).toBe(false);
  });

  it('verifies Turnstile, then posts a signed canonical submission', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({
        email: EMAIL,
        name: 'Ada Lovelace',
        company_domain: 'acme.test',
        message: 'Demo please',
        utm_source: 'newsletter',
        'cf-turnstile-response': TOKEN
      }),
      env,
      deps(fetchImpl)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([SITEVERIFY_URL, ENDPOINT]);
    expect((calls[0].init.body as FormData).get('remoteip')).toBe('203.0.113.7');

    const raw = String(calls[1].init.body);
    const headers = readCaptureHeaders(calls[1].init.headers as Record<string, string>);
    expect(captureSignatureMatches([env.TREVRA_CAPTURE_SECRET], headers, Buffer.from(raw))).toBe(
      true
    );
    expect(headers.idempotencyKey).toBe(await idempotencyKeyForToken(TOKEN));
    const parsed = inboundSubmissionSchema.parse(JSON.parse(raw));
    expect(parsed).toMatchObject({
      kind: 'demo_request',
      person: { email: EMAIL, name: 'Ada Lovelace' },
      company: { domain: 'acme.test' },
      page: { url: 'https://acme.test/demo' },
      message: 'Demo please',
      attribution: { utm_source: 'newsletter' }
    });
    expect(JSON.parse(raw)).not.toHaveProperty('consent');
  });

  it('uses a hidden page_url on the allowed origin, else the Referer', async () => {
    const hidden = await postedBody(
      { page_url: 'https://acme.test/pricing/pro?token=secret#x' },
      { referer: 'https://acme.test/' }
    );
    expect(inboundSubmissionSchema.parse(hidden).page).toEqual({
      url: 'https://acme.test/pricing/pro'
    });

    // A cross-origin browser truncates Referer to the origin; the field restores the path.
    const foreign = await postedBody(
      { page_url: 'https://evil.test/landing' },
      { referer: 'https://acme.test/' }
    );
    expect(foreign.page).toEqual({ url: 'https://acme.test/' });

    const junk = await postedBody(
      { page_url: 'javascript:alert(1)' },
      { referer: 'https://acme.test/demo' }
    );
    expect(junk.page).toEqual({ url: 'https://acme.test/demo' });

    const absent = await postedBody({}, { referer: 'https://acme.test/' });
    expect(absent.page).toEqual({ url: 'https://acme.test/' });
  });

  it('maps only an explicitly ticked marketing_email box to consent', async () => {
    const ticked = await postedBody({ marketing_email: 'on' });
    expect(ticked.consent).toEqual({
      marketingEmail: true,
      capturedAt: new Date(NOW * 1000).toISOString()
    });
    expect(inboundSubmissionSchema.parse(ticked).consent).toMatchObject({ marketingEmail: true });

    expect(await postedBody({})).not.toHaveProperty('consent');
    expect(await postedBody({ marketing_email: '' })).not.toHaveProperty('consent');
    expect(await postedBody({ marketing_email: 'off' })).not.toHaveProperty('consent');
  });

  it('requires the token hostname to match TURNSTILE_HOSTNAMES, defaulting to ALLOWED_ORIGIN', async () => {
    const { TURNSTILE_HOSTNAMES: _unused, ...unset } = env;
    const request = () => formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN });

    const foreignToken = stubFetch([202], 'evil.test');
    const refused = await handleCapture(request(), unset, deps(foreignToken.fetchImpl));
    expect(refused.status).toBe(403);
    expect(foreignToken.calls.map((call) => call.url)).toEqual([SITEVERIFY_URL]);

    const ownToken = stubFetch([202], 'acme.test');
    expect((await handleCapture(request(), unset, deps(ownToken.fetchImpl))).status).toBe(200);

    // A blank list is the same as unset, never "no check".
    const blank = stubFetch([202], 'evil.test');
    const blankResponse = await handleCapture(
      request(),
      { ...env, TURNSTILE_HOSTNAMES: ' , ' },
      deps(blank.fetchImpl)
    );
    expect(blankResponse.status).toBe(403);

    // An explicit list replaces the default.
    const listed = stubFetch([202], 'www.acme.test');
    const listedResponse = await handleCapture(
      request(),
      { ...env, TURNSTILE_HOSTNAMES: 'acme.test, www.acme.test' },
      deps(listed.fetchImpl)
    );
    expect(listedResponse.status).toBe(200);

    // An unusable ALLOWED_ORIGIN yields no hostnames, which fails closed.
    const broken = stubFetch([202]);
    const brokenResponse = await handleCapture(
      new Request('https://capture.acme.test/', {
        method: 'POST',
        headers: { origin: 'not a url' },
        body: new URLSearchParams({ email: EMAIL, 'cf-turnstile-response': TOKEN })
      }),
      { ...unset, ALLOWED_ORIGIN: 'not a url' },
      deps(broken.fetchImpl)
    );
    expect(brokenResponse.status).toBe(403);
    expect(broken.calls.filter((call) => call.url === ENDPOINT)).toHaveLength(0);
  });

  it('refuses a failed Turnstile check without calling Trevra', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      { ...env, TURNSTILE_SECRET_KEY: FAIL_SECRET },
      deps(fetchImpl)
    );
    expect(response.status).toBe(403);
    expect(calls.map((call) => call.url)).toEqual([SITEVERIFY_URL]);
  });

  it('retries once with the same key and bytes, then reports 502', async () => {
    const failing = stubFetch([503, 503]);
    const failed = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      env,
      deps(failing.fetchImpl)
    );
    expect(failed.status).toBe(502);
    const posts = failing.calls.filter((call) => call.url === ENDPOINT);
    expect(posts).toHaveLength(2);
    expect(posts[0].init.body).toBe(posts[1].init.body);
    const keys = posts.map(
      (call) => readCaptureHeaders(call.init.headers as Record<string, string>).idempotencyKey
    );
    expect(keys[0]).toBe(keys[1]);

    const recovering = stubFetch([503, 202]);
    const recovered = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      env,
      deps(recovering.fetchImpl)
    );
    expect(recovered.status).toBe(200);
  });

  it('maps a rejected payload to 400 and a misconfigured source to 502 without retrying', async () => {
    const invalid = stubFetch([400]);
    const rejected = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      env,
      deps(invalid.fetchImpl)
    );
    expect(rejected.status).toBe(400);
    const misconfigured = stubFetch([401]);
    const unsigned = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      env,
      deps(misconfigured.fetchImpl)
    );
    expect(unsigned.status).toBe(502);
    expect(misconfigured.calls.filter((call) => call.url === ENDPOINT)).toHaveLength(1);
  });

  it('drops honeypot posts silently and refuses foreign origins, bad emails and other methods', async () => {
    const { calls, fetchImpl } = stubFetch([202]);
    const trapped = await handleCapture(
      formRequest({
        email: EMAIL,
        website: 'https://spam.test',
        'cf-turnstile-response': TOKEN
      }),
      env,
      deps(fetchImpl)
    );
    expect(trapped.status).toBe(200);
    expect(calls).toHaveLength(0);
    const foreign = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }, 'https://evil.test'),
      env,
      deps(fetchImpl)
    );
    expect(foreign.status).toBe(403);
    const badEmail = await handleCapture(
      formRequest({ email: 'not-an-email', 'cf-turnstile-response': TOKEN }),
      env,
      deps(fetchImpl)
    );
    expect(badEmail.status).toBe(400);
    const get = await handleCapture(
      new Request('https://capture.acme.test/'),
      env,
      deps(fetchImpl)
    );
    expect(get.status).toBe(405);
    const preflight = await handleCapture(
      new Request('https://capture.acme.test/', { method: 'OPTIONS' }),
      env,
      deps(fetchImpl)
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://acme.test');
  });

  it('redirects to a thank-you page when one is configured', async () => {
    const { fetchImpl } = stubFetch([202]);
    const response = await handleCapture(
      formRequest({ email: EMAIL, 'cf-turnstile-response': TOKEN }),
      { ...env, REDIRECT_URL: 'https://acme.test/thanks' },
      deps(fetchImpl)
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://acme.test/thanks');
  });
});
