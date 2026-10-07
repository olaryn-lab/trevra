/* ---------------------------------------------------------------------------
 * COLD EMAIL BY RECIPIENT COUNTRY: a deliberately conservative, static table.
 *
 * NOT LEGAL ADVICE; VERIFY WITH COUNSEL. Every rule names its primary source.
 * Where a country allows B2B email on a legitimate interest, Trevra still
 * requires that interest to be RECORDED for the person, and a country with no
 * rule here -- or no known country at all -- requires an explicit recorded
 * basis. Pure functions only: the store is lawful-basis.ts, and no model
 * output reaches any of this.
 * ------------------------------------------------------------------------ */

export const JURISDICTION_RULES_DISCLAIMER = 'Not legal advice; verify with counsel.';

export const LAWFUL_BASES = ['consent', 'existing_customer', 'legitimate_interest'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export type ColdEmailRegime = 'consent_required' | 'basis_required' | 'opt_out';

export interface ColdEmailRule {
  country: string | null;
  regime: ColdEmailRegime;
  accepts: readonly LawfulBasis[];
  summary: string;
  sources: readonly string[];
}

const SOURCES = {
  ftc: 'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business',
  uwgDe: 'https://www.gesetze-im-internet.de/uwg_2004/__7.html',
  uwgCh: 'https://www.fedlex.admin.ch/eli/cc/1988/223_223_223/de',
  tkgAt: 'https://www.ris.bka.gv.at/eli/bgbl/i/2021/190/P174/NOR40238632',
  cnil: 'https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel',
  pecr: 'https://www.legislation.gov.uk/uksi/2003/2426/regulation/22',
  ico: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/',
  casl: 'https://laws-lois.justice.gc.ca/eng/acts/E-1.6/',
  crtc: 'https://crtc.gc.ca/eng/com500/guide.htm'
} as const;

const CONSENT_OR_CUSTOMER: readonly LawfulBasis[] = ['consent', 'existing_customer'];

export const COLD_EMAIL_RULES: Readonly<Record<string, ColdEmailRule>> = {
  DE: {
    country: 'DE',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Germany: advertising email needs prior express consent, with a narrow existing-customer exception (UWG section 7).',
    sources: [SOURCES.uwgDe]
  },
  AT: {
    country: 'AT',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Austria: direct-marketing email needs prior consent, with a narrow existing-customer exception (TKG 2021 section 174).',
    sources: [SOURCES.tkgAt]
  },
  CH: {
    country: 'CH',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Switzerland: mass advertising by email needs prior consent unless the recipient is an existing customer (UWG Art. 3 para. 1 lit. o).',
    sources: [SOURCES.uwgCh]
  },
  CA: {
    country: 'CA',
    regime: 'consent_required',
    accepts: CONSENT_OR_CUSTOMER,
    summary:
      'Canada: commercial electronic messages need express or implied consent; an existing business relationship is implied consent (CASL).',
    sources: [SOURCES.casl, SOURCES.crtc]
  },
  FR: {
    country: 'FR',
    regime: 'basis_required',
    accepts: LAWFUL_BASES,
    summary:
      'France: email to individuals needs consent; email to a professional about their job may rely on a legitimate interest (CNIL).',
    sources: [SOURCES.cnil]
  },
  GB: {
    country: 'GB',
    regime: 'basis_required',
    accepts: LAWFUL_BASES,
    summary:
      'United Kingdom: email to individual subscribers needs consent or the soft opt-in; corporate subscribers are outside regulation 22 but still need a lawful basis (PECR, ICO).',
    sources: [SOURCES.pecr, SOURCES.ico]
  },
  US: {
    country: 'US',
    regime: 'opt_out',
    accepts: LAWFUL_BASES,
    summary:
      'United States: commercial email needs no prior consent but must carry a postal address, a working opt-out and honest headers (CAN-SPAM).',
    sources: [SOURCES.ftc]
  }
};

export const UNKNOWN_RULE: ColdEmailRule = {
  country: null,
  regime: 'basis_required',
  accepts: LAWFUL_BASES,
  summary: 'Country unknown: Trevra requires an explicit recorded basis before cold email.',
  sources: []
};

export function ruleFor(country: string | null): ColdEmailRule {
  if (!country) return UNKNOWN_RULE;
  return (
    COLD_EMAIL_RULES[country] ?? {
      country,
      regime: 'basis_required',
      accepts: LAWFUL_BASES,
      summary: `No rule is recorded for ${country}: Trevra requires an explicit recorded basis before cold email.`,
      sources: []
    }
  );
}

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  germany: 'DE',
  deutschland: 'DE',
  austria: 'AT',
  österreich: 'AT',
  oesterreich: 'AT',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  svizzera: 'CH',
  france: 'FR',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  canada: 'CA'
};

/** An ISO 3166-1 alpha-2 code, or null when the value is not one Trevra can read. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  const named = COUNTRY_NAMES[key];
  if (named) return named;
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}

// Two-letter TLDs sold as generic names; they say nothing about a country.
const GENERIC_COUNTRY_TLDS = new Set([
  'ai',
  'cc',
  'co',
  'fm',
  'gg',
  'io',
  'ly',
  'me',
  'sh',
  'so',
  'to',
  'tv',
  'vc',
  'ws'
]);

function hostOf(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]!
    .replace(/\.+$/, '');
}

/** The country of a ccTLD (`uk` -> GB), or null for a generic or regional TLD. */
export function countryFromDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const tld = hostOf(domain).split('.').pop() ?? '';
  if (!/^[a-z]{2}$/.test(tld) || tld === 'eu' || GENERIC_COUNTRY_TLDS.has(tld)) return null;
  return tld === 'uk' ? 'GB' : tld.toUpperCase();
}

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** RFC 2606 / RFC 6761 names: no mail can ever be delivered there. */
export function isReservedEmailDomain(domain: string): boolean {
  const host = hostOf(domain);
  const tld = host.split('.').pop() ?? '';
  return (
    RESERVED_TLDS.has(tld) ||
    RESERVED_DOMAINS.some((reserved) => host === reserved || host.endsWith(`.${reserved}`))
  );
}

export type CountrySource = 'contact' | 'lead_list' | 'account' | 'account_domain' | 'unknown';

/** Explicit beats derived, the person beats the company, and nothing is guessed. */
export function resolveRecipientCountry(input: {
  contactCountry: string | null;
  leadCountry: string | null;
  accountCountry: string | null;
  accountDomain: string | null;
}): { country: string | null; source: CountrySource } {
  const contact = normalizeCountryCode(input.contactCountry);
  if (contact) return { country: contact, source: 'contact' };
  const lead = normalizeCountryCode(input.leadCountry);
  if (lead) return { country: lead, source: 'lead_list' };
  const account = normalizeCountryCode(input.accountCountry);
  if (account) return { country: account, source: 'account' };
  const fromDomain = countryFromDomain(input.accountDomain);
  if (fromDomain) return { country: fromDomain, source: 'account_domain' };
  return { country: null, source: 'unknown' };
}

export type EmailPurpose = 'outreach' | 'reply' | 'qualified_demand';

export interface LawfulBasisDecision {
  status: 'not_required' | 'satisfied' | 'missing';
  country: string | null;
  countrySource: CountrySource;
  basis: LawfulBasis | null;
  /** Country code and basis labels only: never an address, a name or a body. */
  reason: string;
}

const BASIS_LABEL: Record<LawfulBasis, string> = {
  consent: 'recorded consent',
  existing_customer: 'an existing-customer relationship',
  legitimate_interest: 'a recorded legitimate interest'
};

function orList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

export function decideEmailLawfulBasis(input: {
  email: string;
  country: string | null;
  countrySource: CountrySource;
  bases: readonly string[];
  purpose: EmailPurpose;
  hasInboundEmail: boolean;
  hasInboundRequest: boolean;
}): LawfulBasisDecision {
  const where = { country: input.country, countrySource: input.countrySource };
  const domain = input.email.includes('@')
    ? input.email.slice(input.email.lastIndexOf('@') + 1)
    : '';
  if (domain && isReservedEmailDomain(domain))
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'Reserved test domain: no mail can reach it.'
    };
  if (input.purpose === 'reply' && input.hasInboundEmail)
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'A reply to a person who emailed first is not cold email.'
    };
  if (input.purpose === 'qualified_demand' && input.hasInboundRequest)
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: 'An answer to a request this person submitted is not cold email.'
    };

  const rule = ruleFor(input.country);
  if (rule.regime === 'opt_out')
    return {
      ...where,
      status: 'not_required',
      basis: null,
      reason: `${input.country} allows commercial email without prior consent when it carries a postal address and an opt-out.`
    };

  const basis = rule.accepts.find((accepted) => input.bases.includes(accepted)) ?? null;
  const place = input.country ?? 'an unknown country';
  if (basis)
    return {
      ...where,
      status: 'satisfied',
      basis,
      reason: `${BASIS_LABEL[basis].charAt(0).toUpperCase()}${BASIS_LABEL[basis].slice(1)} covers cold email to a recipient in ${place}.`
    };
  return {
    ...where,
    status: 'missing',
    basis: null,
    reason: `Cold email to a recipient in ${place} needs ${orList(
      rule.accepts.map((accepted) => BASIS_LABEL[accepted])
    )}; none is recorded for this person.`
  };
}
