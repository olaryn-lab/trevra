/**
 * Contact enrichment behind one interface, so a second provider is a new
 * adapter and not a change to plans, runs, the cap or the ledger.
 *
 * A provider only READS (domain search, email verification). Nothing here
 * writes to a third party, so it needs no prepared-action adapter. It spends
 * the customer's money, though, so it only ever runs from an approved
 * `enrich_contacts` plan (gtm/intent.ts) under the workspace credit cap
 * (enrichment/runs.ts).
 */
export const ENRICHMENT_PROVIDERS = ['hunter'] as const;
export type EnrichmentProviderId = (typeof ENRICHMENT_PROVIDERS)[number];

/**
 * 'claimed' is Hunter's 451: the address owner asked Hunter to stop processing
 * it. It is never saved, under any opt-in.
 */
export type EmailVerificationStatus =
  'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown' | 'claimed';

export interface EnrichmentCandidate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  /** First public http(s) page the provider saw the address on. Null means unsourced: never saved. */
  sourceUri: string | null;
  providerConfidence: number | null;
}

export interface DomainSearchResult {
  candidates: EnrichmentCandidate[];
  credits: number;
}

export interface EmailVerificationResult {
  status: EmailVerificationStatus;
  credits: number;
}

export type EnrichmentProviderErrorCode =
  'key_invalid' | 'rate_limited' | 'quota_exhausted' | 'rejected' | 'unavailable';

/** Messages are fixed strings: a provider error must never quote the key or a response body. */
export class EnrichmentProviderError extends Error {
  constructor(
    message: string,
    public readonly code: EnrichmentProviderErrorCode
  ) {
    super(message);
    this.name = 'EnrichmentProviderError';
  }
}

export interface PersonEmailFinderResult {
  email: string | null;
  /** A confidence between 0 and 1, not an assertion that an address is deliverable. */
  confidence: number | null;
  /** Hunter's actual verifier decision; finding a public email is not proof of deliverability. */
  verificationStatus: 'valid' | 'accept_all' | 'unknown' | null;
  /** Billable Hunter search credits actually returned by the API. */
  credits: number;
}
export interface ContactEnrichmentProvider {
  readonly id: EnrichmentProviderId;
  /** Free call that proves the key works. Throws EnrichmentProviderError. */
  checkKey(): Promise<void>;
  domainSearch(domain: string, options: { limit: number }): Promise<DomainSearchResult>;
  verifyEmail(email: string): Promise<EmailVerificationResult>;
  /** Optional: named-person lookup (not every provider supports this endpoint). */
  findEmail?(input: {
    firstName: string;
    lastName: string;
    company: string;
    profileUrl: string | null;
  }): Promise<PersonEmailFinderResult>;
}

/**
 * Hunter documents two charging schemes; Trevra records the HIGHER of the two
 * so the ledger never under-counts (read 2026-10-06):
 * - Pricing FAQ (https://hunter.io/pricing): "In the Domain Search, 1 credit is
 *   used for each email found... If no emails are found, no credits are used."
 *   and "0.5 credit is counted per verified email. If we fail to verify, no
 *   credit is counted".
 * - API help (https://help.hunter.io): Domain Search is 1 credit per 1-10
 *   emails returned, and the Email Verifier is 0.5 credits per call.
 * So Domain Search is charged per email (always >= the help article) and every
 * verification that reaches a terminal answer is charged 0.5.
 */
export const HUNTER_PRICING_URL = 'https://hunter.io/pricing';
export const HUNTER_CREDIT_PRICE = { perEmailFound: 1, perVerification: 0.5 } as const;
export const ENRICHMENT_MAX_DOMAINS = 100;
export const ENRICHMENT_MAX_EMAILS_PER_DOMAIN = 10;

export function roundCredits(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Upper bound, never an average: every domain returns `emailsPerDomain`
 * emails and every one is verified. Hunter may charge less (repeat searches
 * in a billing period are counted once), never more, because the run stops
 * before any call that could cross this number.
 */
export function estimateEnrichmentCredits(input: { domains: number; emailsPerDomain: number }): {
  searchCredits: number;
  verificationCredits: number;
  estimatedCredits: number;
} {
  const emails = input.domains * input.emailsPerDomain;
  const searchCredits = roundCredits(emails * HUNTER_CREDIT_PRICE.perEmailFound);
  const verificationCredits = roundCredits(emails * HUNTER_CREDIT_PRICE.perVerification);
  return {
    searchCredits,
    verificationCredits,
    estimatedCredits: roundCredits(searchCredits + verificationCredits)
  };
}
