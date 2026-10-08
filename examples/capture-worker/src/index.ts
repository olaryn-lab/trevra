import { idempotencyKeyForToken, signCaptureRequest } from './sign';
import { verifyTurnstile, type FetchLike } from './turnstile';

export interface Env {
  /** Your Trevra API base URL, as shown in Setup → Lead capture recipes. */
  TREVRA_API_BASE_URL: string;
  TREVRA_CAPTURE_SOURCE_ID: string;
  /** Worker secret: `npx wrangler secret put TREVRA_CAPTURE_SECRET`. */
  TREVRA_CAPTURE_SECRET: string;
  /** Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`. */
  TURNSTILE_SECRET_KEY: string;
  /** The one site origin allowed to post, e.g. `https://www.example.com`. */
  ALLOWED_ORIGIN: string;
  /**
   * Comma-separated hostnames a Turnstile token must have been issued on.
   * Unset or blank means the hostname of `ALLOWED_ORIGIN`; the check is never off.
   */
  TURNSTILE_HOSTNAMES?: string;
  SUBMISSION_KIND?: string;
  REDIRECT_URL?: string;
}

export interface CaptureDeps {
  fetch: FetchLike;
  nowSeconds: () => number;
}

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TICKED = new Set(['on', 'true', '1']);
const MAX_ATTEMPTS = 2;
const FETCH_TIMEOUT_MS = 10_000;

function field(form: FormData, name: string, max: number): string | undefined {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Origin and path only: a query string can carry tokens the founder never meant to store. */
function originAndPath(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The page the visitor submitted from. The form's hidden `page_url` field wins
 * because cross-origin browsers truncate Referer to the origin, but only when
 * it is on ALLOWED_ORIGIN; anything else falls back to Referer.
 */
export function pageUrlFor(form: FormData, request: Request, env: Env): string | null {
  const claimed = originAndPath(field(form, 'page_url', 2048));
  const url = claimed && claimed.origin === env.ALLOWED_ORIGIN ? claimed : null;
  const referer = originAndPath(request.headers.get('referer'));
  const chosen = url ?? (referer && referer.origin === env.ALLOWED_ORIGIN ? referer : null);
  return chosen ? `${chosen.origin}${chosen.pathname}`.slice(0, 2048) : null;
}

/** Hostnames a Turnstile token may carry: the explicit list, else ALLOWED_ORIGIN's host. */
export function turnstileHostnames(env: Env): string[] {
  const listed = (env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  if (listed.length > 0) return listed;
  const origin = originAndPath(env.ALLOWED_ORIGIN);
  return origin ? [origin.hostname] : [];
}

/**
 * The canonical Trevra body (docs/lead-capture.md section 3), or null without a usable email.
 * Consent is sent only for an explicitly ticked `marketing_email` box.
 */
export function buildSubmission(
  form: FormData,
  env: Env,
  pageUrl: string | null,
  receivedAt: string
): Record<string, unknown> | null {
  const email = field(form, 'email', 320);
  if (!email || !EMAIL.test(email)) return null;
  const name = field(form, 'name', 200);
  const domain = field(form, 'company_domain', 500);
  const message = field(form, 'message', 20_000);
  const attribution: Record<string, string> = {};
  for (const key of UTM_FIELDS) {
    const value = field(form, key, 200);
    if (value) attribution[key] = value;
  }
  const ticked = TICKED.has((field(form, 'marketing_email', 20) ?? '').toLowerCase());
  return {
    kind: env.SUBMISSION_KIND || 'demo_request',
    person: name ? { email, name } : { email },
    ...(domain ? { company: { domain } } : {}),
    ...(pageUrl ? { page: { url: pageUrl } } : {}),
    ...(message ? { message } : {}),
    ...(Object.keys(attribution).length > 0 ? { attribution } : {}),
    ...(ticked ? { consent: { marketingEmail: true, capturedAt: receivedAt } } : {})
  };
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };
}

function reply(env: Env, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env) }
  });
}

function accepted(env: Env): Response {
  if (env.REDIRECT_URL)
    return new Response(null, {
      status: 303,
      headers: { location: env.REDIRECT_URL, ...corsHeaders(env) }
    });
  return reply(env, 200, { ok: true });
}

export async function handleCapture(
  request: Request,
  env: Env,
  deps: CaptureDeps = {
    fetch: (input, init) => fetch(input, init),
    nowSeconds: () => Date.now() / 1000
  }
): Promise<Response> {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method !== 'POST') return reply(env, 405, { ok: false, error: 'Use POST.' });
  if (request.headers.get('origin') !== env.ALLOWED_ORIGIN)
    return reply(env, 403, { ok: false, error: 'This form does not accept posts from that site.' });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(env, 415, { ok: false, error: 'Send the form as form data.' });
  }
  // Honeypot: a person never fills a field they cannot see. Answer as if it
  // worked so the bot learns nothing.
  if (field(form, 'website', 200)) return accepted(env);

  const tokenValue = form.get('cf-turnstile-response');
  const token = typeof tokenValue === 'string' ? tokenValue : '';
  const turnstile = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET_KEY,
    token,
    remoteIp: request.headers.get('cf-connecting-ip'),
    expectedHostnames: turnstileHostnames(env),
    fetchImpl: deps.fetch
  });
  if (!turnstile.success)
    return reply(env, 403, {
      ok: false,
      error: 'The bot check failed. Reload the page and try again.'
    });

  const receivedAt = new Date(deps.nowSeconds() * 1000).toISOString();
  const submission = buildSubmission(form, env, pageUrlFor(form, request, env), receivedAt);
  if (!submission)
    return reply(env, 400, { ok: false, error: 'A valid email address is required.' });

  // Built once: every attempt sends these exact bytes under this exact key.
  const body = JSON.stringify(submission);
  const idempotencyKey = await idempotencyKeyForToken(token);
  const endpoint = `${env.TREVRA_API_BASE_URL.replace(/\/+$/, '')}/api/intake/v1/submissions`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const headers = await signCaptureRequest({
      secret: env.TREVRA_CAPTURE_SECRET,
      sourceId: env.TREVRA_CAPTURE_SOURCE_ID,
      idempotencyKey,
      body,
      nowSeconds: deps.nowSeconds()
    });
    let status = 0;
    try {
      // The signed body must never follow a redirect to another host.
      status = (
        await deps.fetch(endpoint, {
          method: 'POST',
          headers: { ...headers },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
      ).status;
    } catch {
      status = 0;
    }
    if (status === 200 || status === 202) return accepted(env);
    if (status === 400 || status === 413)
      return reply(env, 400, { ok: false, error: 'The submission was not accepted.' });
    // Only a network failure, 429 or 5xx is worth one more try. 401/403/404/409
    // mean the Worker's source id or secret is wrong: retrying cannot fix that,
    // and the visitor cannot either.
    // A 3xx is a misconfigured base URL: not retryable either.
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable) break;
  }
  return reply(env, 502, {
    ok: false,
    error: 'The form could not be delivered. Try again shortly.'
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleCapture(request, env);
  }
};
