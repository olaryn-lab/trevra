import { z } from 'zod';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  type ContactEnrichmentProvider,
  type EnrichmentCandidate,
  type EmailVerificationStatus,
  type PersonEmailFinderResult
} from './provider.js';

/**
 * Hunter.io, bring-your-own-key.
 *
 * Terms (https://hunter.io/terms-of-service, last updated May 23, 2024, read
 * 2026-10-06): Section 4 permits "use of the API through a third-party
 * product that accesses the Services" under the customer's own agreement;
 * Section 1 says "You must not share your account with others", so Trevra
 * never holds one shared key, only each workspace's own; Section 11 makes the
 * customer an independent Controller of what they look up.
 *
 * Custody: Nango's provider catalogue (packages/providers/providers.yaml, read
 * 2026-10-06) has no `hunter` entry, so the key is sealed in workspace_secrets
 * as kind 'hunter_api_key' and read only in enrichment/runs.ts.
 *
 * API: https://hunter.io/api-documentation/v2. The key travels in the
 * X-API-KEY header, never the query string, so it cannot land in a proxy
 * access log. The email verifier answers 222 when the remote SMTP server
 * failed (retry later) and 451 when the address owner asked Hunter to stop
 * processing it (must not be processed); both are per-address answers, never
 * run failures.
 *
 * Credits: every verification that reaches a terminal answer (including
 * unknown, disposable, 222, 451 and a poll timeout) is recorded at the
 * per-call 0.5 from help.hunter.io, the higher of Hunter's two documented
 * schemes. Thrown provider errors record nothing here.
 */
const HUNTER_API_BASE = 'https://api.hunter.io/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const VERIFY_POLLS = 3;
const VERIFY_POLL_DELAY_MS = 5_000;
const VERIFICATION_STATUSES: readonly EmailVerificationStatus[] = [
  'valid',
  'invalid',
  'accept_all',
  'webmail',
  'disposable',
  'unknown'
];

const hunterEmailSchema = z
  .object({
    value: z.string(),
    confidence: z.number().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    sources: z
      .array(z.object({ uri: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional()
  })
  .passthrough();
const verifierSchema = z
  .object({ data: z.object({ status: z.string().nullable().optional() }).passthrough() })
  .passthrough();
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPublicPage(uri: string): boolean {
  try {
    const { protocol } = new URL(uri.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Raw entries Hunter returned (what it charged for); [] when the body has no emails array. */
function rawEmailEntries(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return [];
  const emails = (data as { emails?: unknown }).emails;
  return Array.isArray(emails) ? emails : [];
}

export interface HunterProviderOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createHunterProvider(
  apiKey: string,
  options: HunterProviderOptions = {}
): ContactEnrichmentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(
    path: string,
    params: Record<string, string>,
    passThrough: readonly number[] = []
  ): Promise<{ status: number; body: unknown }> {
    const query = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetchImpl(`${HUNTER_API_BASE}${path}${query ? `?${query}` : ''}`, {
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new EnrichmentProviderError('Hunter could not be reached.', 'unavailable');
    }
    if (passThrough.includes(response.status)) return { status: response.status, body: null };
    if (response.status === 401)
      throw new EnrichmentProviderError('Hunter rejected the API key.', 'key_invalid');
    if (response.status === 403)
      throw new EnrichmentProviderError('Hunter rate limit reached.', 'rate_limited');
    if (response.status === 429)
      throw new EnrichmentProviderError(
        'The Hunter account has no credits left this period.',
        'quota_exhausted'
      );
    if (response.status >= 500)
      throw new EnrichmentProviderError(`Hunter returned ${response.status}.`, 'unavailable');
    if (response.status !== 200 && response.status !== 202)
      throw new EnrichmentProviderError(
        `Hunter refused the request (${response.status}).`,
        'rejected'
      );
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  return {
    id: 'hunter',

    async checkKey() {
      await call('/account', {});
    },

    async domainSearch(domain, { limit }) {
      if (!Number.isFinite(limit))
        throw new EnrichmentProviderError(
          'Hunter domain search needs a numeric limit.',
          'rejected'
        );
      const cap = Math.max(1, Math.min(Math.trunc(limit), 100));
      const { body } = await call('/domain-search', {
        domain,
        limit: String(cap),
        type: 'personal'
      });
      // Hunter charged for every entry it returned, so credits come from the raw
      // count and a malformed entry is dropped, never allowed to lose the charge.
      const raw = rawEmailEntries(body);
      const candidates: EnrichmentCandidate[] = [];
      for (const item of raw) {
        const parsed = hunterEmailSchema.safeParse(item);
        if (!parsed.success) continue;
        const entry = parsed.data;
        const email = entry.value.trim().toLowerCase();
        if (!EMAIL_SHAPE.test(email)) continue;
        candidates.push({
          email,
          firstName: entry.first_name?.trim() || null,
          lastName: entry.last_name?.trim() || null,
          position: entry.position?.trim() || null,
          sourceUri:
            (entry.sources ?? [])
              .map((source) => source.uri ?? '')
              .find((uri) => isPublicPage(uri))
              ?.trim() ?? null,
          providerConfidence: entry.confidence ?? null
        });
        if (candidates.length >= cap) break;
      }
      return { credits: raw.length * HUNTER_CREDIT_PRICE.perEmailFound, candidates };
    },

    async findEmail(input): Promise<PersonEmailFinderResult> {
      const first = input.firstName.trim();
      const last = input.lastName.trim();
      const company = input.company.trim();
      let linkedinHandle = '';
      if (input.profileUrl) {
        try {
          const url = new URL(input.profileUrl);
          if (['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()))
            linkedinHandle = url.pathname.match(/^\/in\/([^/]+)/i)?.[1] ?? '';
        } catch {
          /* treat unrecognized profiles as absent, never forward arbitrary URLs */
        }
      }
      if (!linkedinHandle && (!first || !last || !company))
        return { email: null, confidence: null, verificationStatus: null, credits: 0 };
      // Found-only endpoint: never silently persist Hunter's inferred emails.
      // The customer's API key stays only in X-API-KEY, never the query string.
      const params: Record<string, string> = linkedinHandle
        ? { linkedin_handle: linkedinHandle }
        : { company, first_name: first, last_name: last };
      const { status, body } = await call('/email-finder/found', params, [451]);
      if (status === 451)
        return { email: null, confidence: null, verificationStatus: null, credits: 0 };
      const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : null;
      if (!data || typeof data !== 'object')
        return { email: null, confidence: null, verificationStatus: null, credits: 0 };
      const result = data as {
        email?: unknown;
        score?: unknown;
        confidence?: unknown;
        source_type?: unknown;
        verification?: { status?: unknown };
      };
      const email = typeof result.email === 'string' ? result.email.trim().toLowerCase() : '';
      if (!email || !EMAIL_SHAPE.test(email))
        return { email: null, confidence: null, verificationStatus: null, credits: 0 };
      const score = typeof result.score === 'number' ? result.score : result.confidence;
      const confidence =
        typeof score === 'number' && Number.isFinite(score)
          ? Math.max(0, Math.min(1, score / 100))
          : null;
      const accepted =
        confidence !== null &&
        confidence >= 0.7 &&
        (result.source_type === undefined || result.source_type === 'found');
      const state = result.verification?.status;
      const verificationStatus =
        accepted && (state === 'valid' || state === 'accept_all' || state === 'unknown')
          ? state
          : null;
      return { email: accepted ? email : null, confidence, verificationStatus, credits: 1 };
    },

    async verifyEmail(email) {
      const charge = HUNTER_CREDIT_PRICE.perVerification;
      let pending = false;
      for (let attempt = 0; attempt < VERIFY_POLLS; attempt += 1) {
        let reply: { status: number; body: unknown };
        try {
          reply = await call('/email-verifier', { email }, [222, 451]);
        } catch (error) {
          // Once Hunter accepted the verification (202) it may complete and
          // charge; a later poll failure must not lose that charge.
          if (pending) return { status: 'unknown', credits: charge };
          throw error;
        }
        const { status, body } = reply;
        if (status === 202) {
          pending = true;
          if (attempt < VERIFY_POLLS - 1) await sleep(VERIFY_POLL_DELAY_MS);
          continue;
        }
        if (status === 451) return { status: 'claimed', credits: charge };
        if (status === 222) return { status: 'unknown', credits: charge };
        const parsed = verifierSchema.safeParse(body);
        const raw = parsed.success ? parsed.data.data.status : null;
        const result: EmailVerificationStatus = VERIFICATION_STATUSES.includes(
          raw as EmailVerificationStatus
        )
          ? (raw as EmailVerificationStatus)
          : 'unknown';
        return { status: result, credits: charge };
      }
      // Hunter counts a verification once even when it completes after we
      // stop polling, so the ledger assumes the charge rather than miss it.
      return { status: 'unknown', credits: charge };
    }
  };
}
