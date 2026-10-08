import { z } from 'zod';
import {
  EnrichmentProviderError,
  HUNTER_CREDIT_PRICE,
  type ContactEnrichmentProvider,
  type EmailVerificationStatus
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
    value: z.string().min(3),
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
const domainSearchSchema = z
  .object({ data: z.object({ emails: z.array(hunterEmailSchema) }).passthrough() })
  .passthrough();
const verifierSchema = z
  .object({ data: z.object({ status: z.string().nullable().optional() }).passthrough() })
  .passthrough();

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
      const { body } = await call('/domain-search', {
        domain,
        limit: String(Math.max(1, Math.min(Math.trunc(limit), 100))),
        type: 'personal'
      });
      const parsed = domainSearchSchema.safeParse(body);
      // 'rejected', not 'unavailable': a retry would pay again for a body we
      // still could not read.
      if (!parsed.success)
        throw new EnrichmentProviderError(
          'Hunter returned an unreadable domain search.',
          'rejected'
        );
      const emails = parsed.data.data.emails;
      return {
        credits: emails.length * HUNTER_CREDIT_PRICE.perEmailFound,
        candidates: emails.map((entry) => ({
          email: entry.value.trim().toLowerCase(),
          firstName: entry.first_name?.trim() || null,
          lastName: entry.last_name?.trim() || null,
          position: entry.position?.trim() || null,
          sourceUri:
            (entry.sources ?? [])
              .map((source) => source.uri ?? '')
              .find((uri) => /^https?:\/\//i.test(uri)) ?? null,
          providerConfidence: entry.confidence ?? null
        }))
      };
    },

    async verifyEmail(email) {
      const charge = HUNTER_CREDIT_PRICE.perVerification;
      for (let attempt = 0; attempt < VERIFY_POLLS; attempt += 1) {
        const { status, body } = await call('/email-verifier', { email }, [222, 451]);
        if (status === 202) {
          await sleep(VERIFY_POLL_DELAY_MS);
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
