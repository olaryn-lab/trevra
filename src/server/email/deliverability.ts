import { Resolver } from 'node:dns/promises';
import type {
  DeliverabilityCheck,
  DeliverabilityEvaluation,
  DeliverabilityStatus,
  EmailChannelIssue,
  MailProvider
} from './types.js';

/** The only DNS surface Trevra uses. Tests inject a fake; production uses node:dns. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  /** Optional: lets SPF a and exists mechanisms count void lookups. */
  resolveA?(name: string): Promise<string[]>;
  /** Optional: lets the SPF a mechanism tell an IPv6-only host from a void one. */
  resolveAaaa?(name: string): Promise<string[]>;
  /** Optional: lets SPF mx mechanisms count void lookups. */
  resolveMx?(name: string): Promise<{ exchange: string; priority: number }[]>;
}

/**
 * Real DNS, unless TREVRA_DNS_DISABLED=true (set for every test by
 * vitest.setup.ts), in which case every query fails with EDISABLED and the
 * evaluation reports unknown -- never pass.
 */
export function defaultDnsResolver(env: NodeJS.ProcessEnv = process.env): DnsResolver {
  if (env.TREVRA_DNS_DISABLED === 'true') {
    return {
      async resolveTxt() {
        throw Object.assign(new Error('DNS lookups are disabled in this process.'), {
          code: 'EDISABLED'
        });
      }
    };
  }
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveA: (name) => resolver.resolve4(name),
    resolveAaaa: (name) => resolver.resolve6(name),
    resolveMx: (name) => resolver.resolveMx(name)
  };
}

export function mailProviderFor(provider: string): MailProvider | null {
  const value = provider.trim().toLowerCase();
  if (value === 'gmail' || value === 'google-mail') return 'google';
  if (value === 'microsoft' || value === 'outlook') return 'microsoft';
  // Nango's built-in Zoho Mail provider; `zoho` alone is the generic Zoho
  // OAuth provider (CRM, Books, ...) and is not a mailbox.
  if (value === 'zoho-mail') return 'zoho';
  return null;
}

/** The one spelling of a sending domain: trimmed, lowercase, no trailing dot. */
export function normalizeSenderDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

export function emailDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

const SPF_LOOKUP_LIMIT = 10;
// RFC 7208 section 4.6.4: more than two lookups that return NXDOMAIN or no answer is a permerror.
const SPF_VOID_LOOKUP_LIMIT = 2;
const SPF_LOOKUP_MECHANISMS = new Set(['include', 'a', 'mx', 'ptr', 'exists']);
/**
 * Zoho documents two SPF includes: zohomail.com (Zoho Mail) and one.zoho.com
 * (Zoho One / Workplace bundles). Either authorizes Zoho's outbound servers.
 * Extended only from the per-data-centre evidence recorded by the Phase G
 * smoke test (Task 1, S6) -- never from guesses.
 */
// The per-data-centre includes are unverified until the Phase G smoke test.
export const ZOHO_SPF_INCLUDES: readonly string[] = ['zohomail.com', 'one.zoho.com'];
const PROVIDER_SPF_INCLUDES: Record<MailProvider, readonly string[]> = {
  google: ['_spf.google.com'],
  microsoft: ['spf.protection.outlook.com'],
  zoho: ZOHO_SPF_INCLUDES
};
const PROVIDER_LABEL: Record<MailProvider, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  zoho: 'Zoho Mail'
};
/**
 * Provider default selectors, tried after the owner-set selector stored in
 * email_dkim_selectors. Zoho has none: its admin console asks the founder to
 * name the selector, so without the owner's answer there is nothing to check.
 */
const DKIM_SELECTORS: Record<MailProvider, readonly string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2'],
  zoho: []
};
const CONSUMER_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'zoho.com',
  'zohomail.com'
]);

function issue(code: string, message: string): EmailChannelIssue {
  return { code, message, actionHref: '/setup/workspace' };
}

type TxtLookup =
  { kind: 'records'; records: string[] } | { kind: 'absent' } | { kind: 'unknown'; detail: string };

async function lookupTxt(resolver: DnsResolver, name: string): Promise<TxtLookup> {
  try {
    const chunks = await resolver.resolveTxt(name);
    return { kind: 'records', records: chunks.map((parts) => parts.join('')) };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    // NXDOMAIN and "no TXT records" are definite answers; anything else
    // (timeout, SERVFAIL, refused, disabled) is not an answer at all.
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { kind: 'absent' };
    return { kind: 'unknown', detail: code || 'DNS lookup failed' };
  }
}

type SpfWalk =
  | { result: 'ok'; authorized: boolean; record: string }
  | { result: 'missing'; void: boolean }
  | { result: 'invalid'; detail: string; record: string | null }
  | { result: 'unknown'; detail: string };

async function walkSpf(
  resolver: DnsResolver,
  domain: string,
  targets: ReadonlySet<string>,
  state: { lookups: number; voids: number },
  ancestors: ReadonlySet<string>
): Promise<SpfWalk> {
  if (ancestors.has(domain)) {
    return { result: 'invalid', detail: `SPF include loop at ${domain}.`, record: null };
  }
  const lookup = await lookupTxt(resolver, domain);
  if (lookup.kind === 'unknown') {
    return { result: 'unknown', detail: `SPF lookup for ${domain} failed (${lookup.detail}).` };
  }
  const records =
    lookup.kind === 'records'
      ? lookup.records
          .map((value) => value.trim())
          .filter((value) => /^v=spf1(?:\s|$)/i.test(value))
      : [];
  if (records.length === 0) {
    // Void: the name does not exist or has no TXT answer at all.
    const isVoid = lookup.kind === 'absent' || lookup.records.length === 0;
    return { result: 'missing', void: isVoid };
  }
  const record = records[0]!;
  if (records.length > 1) {
    return {
      result: 'invalid',
      detail: `${domain} publishes ${records.length} SPF records; receivers treat that as a permanent error.`,
      record
    };
  }
  const terms = record.split(/\s+/).slice(1);
  const hasAll = terms.some((term) => /^[+?~-]?all$/i.test(term));
  const path = new Set(ancestors).add(domain);
  const invalid = (detail: string): SpfWalk => ({ result: 'invalid', detail, record });
  const voidLimit = (): SpfWalk =>
    invalid(
      `SPF for ${domain} makes more than ${SPF_VOID_LOOKUP_LIMIT} void lookups; receivers treat that as a permanent error.`
    );
  for (const name of ['redirect', 'exp']) {
    const count = terms.filter((term) => new RegExp(`^${name}=`, 'i').test(term)).length;
    if (count > 1) return invalid(`SPF at ${domain} has more than one ${name}= modifier.`);
  }
  let authorized = false;
  for (const term of terms) {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
    const mechanismMatch = modifier
      ? null
      : /^([+?~-]?)(all|include|a|mx|ptr|ip4|ip6|exists)(?::([^/]*))?(\/\d+)?(\/\/\d+)?$/i.exec(
          term
        );
    if (!modifier && !mechanismMatch)
      return invalid(`Unrecognised SPF term "${term}" at ${domain}.`);
    const qualifier = mechanismMatch ? mechanismMatch[1] || '+' : '+';
    const mechanism = (modifier ? modifier[1]! : mechanismMatch![2]!).toLowerCase();
    const raw = (modifier ? modifier[2]! : (mechanismMatch![3] ?? '')).trim();
    // Mechanisms after the first "all" are never evaluated (RFC 7208 section 5.1).
    const cidr = mechanismMatch ? `${mechanismMatch[4] ?? ''}${mechanismMatch[5] ?? ''}` : '';
    if (!modifier && mechanism === 'all') {
      if (raw || cidr || mechanismMatch![3] !== undefined)
        return invalid(`Unrecognised SPF term "${term}" at ${domain}.`);
      break;
    }
    if (modifier && mechanism !== 'redirect') continue; // exp and unknown modifiers never authorize
    // A cidr suffix is only meaningful on a, mx, ip4 and ip6; a colon with no domain-spec is empty.
    if (
      !modifier &&
      ((cidr && ['include', 'exists'].includes(mechanism)) ||
        (['a', 'mx'].includes(mechanism) && mechanismMatch![3] !== undefined && !raw))
    ) {
      return invalid(`Unrecognised SPF term "${term}" at ${domain}.`);
    }
    if (modifier && mechanism === 'redirect' && raw.includes('/')) {
      return invalid(`Unrecognised SPF term "${term}" at ${domain}.`);
    }
    const value = raw.toLowerCase().replace(/\.$/, '');
    if (!modifier && ['ip4', 'ip6', 'exists', 'include'].includes(mechanism) && !value) {
      return invalid(`SPF ${mechanism} at ${domain} names no value.`);
    }
    const isRedirect = mechanism === 'redirect' && !hasAll;
    if (mechanism === 'redirect' && hasAll) continue;
    if (SPF_LOOKUP_MECHANISMS.has(mechanism) || isRedirect) {
      state.lookups += 1;
      if (state.lookups > SPF_LOOKUP_LIMIT) {
        return invalid(
          `SPF for ${domain} needs more than ${SPF_LOOKUP_LIMIT} DNS lookups; receivers stop evaluating it.`
        );
      }
    }
    if (mechanism === 'a' || mechanism === 'mx' || mechanism === 'exists') {
      const name = value || domain;
      // Macro targets cannot be evaluated statically; skip the query.
      if (name.includes('%')) continue;
      const outcome = await probeSpfTarget(resolver, mechanism, name);
      if (outcome.kind === 'unknown') {
        return {
          result: 'unknown',
          detail: `SPF ${mechanism} lookup for ${name} failed (${outcome.detail}).`
        };
      }
      if (outcome.kind === 'void') {
        state.voids += 1;
        if (state.voids > SPF_VOID_LOOKUP_LIMIT) return voidLimit();
      }
      continue;
    }
    if (mechanism !== 'include' && !isRedirect) continue;
    if (!value) return invalid(`SPF ${mechanism} at ${domain} names no domain.`);
    // Macro targets (%{...}) cannot be evaluated statically; they never count as authorizing.
    if (value.includes('%')) continue;
    const nested = await walkSpf(resolver, value, targets, state, path);
    if (nested.result === 'unknown') return nested;
    if (nested.result === 'missing') {
      if (nested.void) state.voids += 1;
      if (state.voids > SPF_VOID_LOOKUP_LIMIT) return voidLimit();
      return invalid(`SPF for ${domain} includes ${value}, which publishes no SPF record.`);
    }
    if (nested.result === 'invalid') return { result: 'invalid', detail: nested.detail, record };
    if ((isRedirect || qualifier === '+') && (targets.has(value) || nested.authorized)) {
      authorized = true;
    }
  }
  return { result: 'ok', authorized, record };
}

type SpfProbe = { kind: 'ok' } | { kind: 'void' } | { kind: 'unknown'; detail: string };

/** Resolves the target of an a, mx or exists mechanism when the resolver can; counts voids. */
async function probeSpfTarget(
  resolver: DnsResolver,
  mechanism: 'a' | 'mx' | 'exists',
  name: string
): Promise<SpfProbe> {
  const query = async (
    run: (() => Promise<unknown[]>) | undefined
  ): Promise<SpfProbe | 'unavailable'> => {
    if (!run) return 'unavailable';
    try {
      return (await run()).length === 0 ? { kind: 'void' } : { kind: 'ok' };
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (code === 'ENODATA' || code === 'ENOTFOUND') return { kind: 'void' };
      return { kind: 'unknown', detail: code || 'DNS lookup failed' };
    }
  };
  // A resolver that cannot answer: counted toward the lookup limit, not resolved.
  if (mechanism === 'mx') {
    const mx = await query(resolver.resolveMx && (() => resolver.resolveMx!(name)));
    return mx === 'unavailable' ? { kind: 'ok' } : mx;
  }
  const a = await query(resolver.resolveA && (() => resolver.resolveA!(name)));
  if (a === 'unavailable') return { kind: 'ok' };
  if (a.kind !== 'void' || mechanism === 'exists') return a;
  // The a mechanism also matches AAAA, so a void A alone does not prove a void target.
  const aaaa = await query(resolver.resolveAaaa && (() => resolver.resolveAaaa!(name)));
  return aaaa === 'unavailable' ? { kind: 'ok' } : aaaa;
}

type Evaluated = {
  check: DeliverabilityCheck;
  blocker: EmailChannelIssue | null;
  warning?: EmailChannelIssue;
};

async function evaluateSpf(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider
): Promise<Evaluated> {
  const includes = PROVIDER_SPF_INCLUDES[provider];
  // The include Trevra tells the founder to add; any listed include authorizes.
  const target = includes[0]!;
  const named = includes.join(' or ');
  const label = PROVIDER_LABEL[provider];
  const state = { lookups: 0, voids: 0 };
  const walk = await walkSpf(resolver, domain, new Set(includes), state, new Set());
  if (walk.result === 'unknown') {
    return {
      check: { status: 'unknown', detail: walk.detail, record: null, lookups: state.lookups },
      blocker: null
    };
  }
  if (walk.result === 'missing') {
    return {
      check: {
        status: 'fail',
        detail: `${domain} publishes no SPF record.`,
        record: null,
        lookups: 0
      },
      blocker: issue(
        'email_spf_missing',
        `${domain} publishes no SPF record. Add the TXT record "v=spf1 include:${target} ~all" so receivers accept mail sent through ${label}.`
      )
    };
  }
  if (walk.result === 'invalid') {
    return {
      check: { status: 'fail', detail: walk.detail, record: walk.record, lookups: state.lookups },
      blocker: issue('email_spf_invalid', walk.detail)
    };
  }
  if (!walk.authorized) {
    return {
      check: {
        status: 'fail',
        detail: `SPF does not authorize ${named}.`,
        record: walk.record,
        lookups: state.lookups
      },
      blocker: issue(
        'email_spf_provider_not_authorized',
        `The SPF record for ${domain} does not include ${named}, so mail sent through ${label} fails SPF. Add "include:${target}" before the final "all".`
      )
    };
  }
  const finalAll = walk.record
    .split(/\s+/)
    .slice(1)
    .find((term) => /^[+?~-]?all$/i.test(term));
  const permissive = finalAll !== undefined && /^\+?all$/i.test(finalAll);
  return {
    check: {
      status: 'pass',
      detail: `SPF authorizes ${target} (${state.lookups} of ${SPF_LOOKUP_LIMIT} lookups).`,
      record: walk.record,
      lookups: state.lookups
    },
    blocker: null,
    ...(permissive
      ? {
          warning: issue(
            'email_spf_permissive_all',
            `The SPF record for ${domain} ends in "${finalAll}", which lets anyone send as ${domain}. Use "~all" or "-all".`
          )
        }
      : {})
  };
}

function hasDkimKey(record: string): boolean {
  const tags = new Map(
    record.split(';').map((part) => {
      const index = part.indexOf('=');
      return index < 0
        ? [part.trim().toLowerCase(), '']
        : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1)];
    })
  );
  const key = (tags.get('p') ?? '').replace(/\s+/g, '');
  return /^[A-Za-z0-9+/]{16,}={0,2}$/.test(key);
}

async function evaluateDkim(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider,
  ownerSelector: string | null
): Promise<Evaluated> {
  const selectors = [
    ...new Set(
      [ownerSelector, ...DKIM_SELECTORS[provider]].filter((value): value is string =>
        Boolean(value)
      )
    )
  ];
  if (selectors.length === 0) {
    return {
      check: {
        status: 'fail',
        detail: 'No DKIM selector is set for this sending domain.',
        record: null,
        selector: null
      },
      blocker: issue(
        'email_dkim_selector_missing',
        `${PROVIDER_LABEL[provider]} signs mail with a DKIM selector you named when you turned DKIM on. Enter that selector for ${domain} under Email in Workspace settings so Trevra can check it.`
      )
    };
  }
  let failure: string | null = null;
  for (const selector of selectors) {
    const lookup = await lookupTxt(resolver, `${selector}._domainkey.${domain}`);
    if (lookup.kind === 'unknown') {
      failure = lookup.detail;
      continue;
    }
    if (lookup.kind === 'absent') continue;
    const record = lookup.records.find(hasDkimKey);
    if (record) {
      return {
        check: {
          status: 'pass',
          detail: `DKIM key published at selector ${selector}.`,
          record,
          selector
        },
        blocker: null
      };
    }
  }
  if (failure) {
    return {
      check: {
        status: 'unknown',
        detail: `DKIM lookup failed (${failure}).`,
        record: null,
        selector: null
      },
      blocker: null
    };
  }
  return {
    check: {
      status: 'fail',
      detail: `No DKIM key at ${selectors.map((selector) => `${selector}._domainkey.${domain}`).join(' or ')}.`,
      record: null,
      selector: null
    },
    blocker: issue(
      'email_dkim_missing',
      `No DKIM key is published for ${domain} at selector ${selectors.join(' or ')}. Turn on DKIM signing in the ${PROVIDER_LABEL[provider]} admin console and publish the key it gives you.`
    )
  };
}

type DmarcLookup =
  | { kind: 'record'; record: string; policy: string; subdomainPolicy: string | null }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string; record: string }
  | { kind: 'unknown'; detail: string };

async function dmarcAt(resolver: DnsResolver, name: string): Promise<DmarcLookup> {
  const lookup = await lookupTxt(resolver, name);
  if (lookup.kind === 'unknown') {
    return { kind: 'unknown', detail: `DMARC lookup for ${name} failed (${lookup.detail}).` };
  }
  if (lookup.kind === 'absent') return { kind: 'absent' };
  const records = lookup.records
    .map((value) => value.trim())
    .filter((value) => /^v\s*=\s*DMARC1\s*(?:;|$)/.test(value));
  if (records.length === 0) return { kind: 'absent' };
  if (records.length > 1) {
    return {
      kind: 'invalid',
      detail: `${name} publishes ${records.length} DMARC records; receivers ignore all of them.`,
      record: records[0]!
    };
  }
  const policy =
    /(?:^|;)\s*p\s*=\s*([a-z]+)\s*(?:;|$)/i.exec(records[0]!)?.[1]?.toLowerCase() ?? '';
  if (!['none', 'quarantine', 'reject'].includes(policy)) {
    return {
      kind: 'invalid',
      detail: `${name} has no valid DMARC policy (p=none, quarantine or reject).`,
      record: records[0]!
    };
  }
  const spRaw = /(?:^|;)\s*sp\s*=\s*([^;]*)/i.exec(records[0]!)?.[1];
  const sp = spRaw?.trim().toLowerCase();
  if (sp !== undefined && !['none', 'quarantine', 'reject'].includes(sp)) {
    return {
      kind: 'invalid',
      detail: `${name} has no valid DMARC subdomain policy (sp=none, quarantine or reject).`,
      record: records[0]!
    };
  }
  const subdomainPolicy = sp ?? null;
  return { kind: 'record', record: records[0]!, policy, subdomainPolicy };
}

function organizationalDomain(domain: string): string {
  // lc-debt: last-two-labels heuristic, wrong for multi-label public suffixes such as co.uk (it then checks _dmarc.co.uk, finds nothing and blocks, which fails safe); upgrade path: a Public Suffix List lookup.
  return domain.split('.').slice(-2).join('.');
}

async function evaluateDmarc(resolver: DnsResolver, domain: string): Promise<Evaluated> {
  let found = await dmarcAt(resolver, `_dmarc.${domain}`);
  let inheritedFrom: string | null = null;
  if (found.kind === 'absent') {
    const org = organizationalDomain(domain);
    if (org !== domain) {
      found = await dmarcAt(resolver, `_dmarc.${org}`);
      inheritedFrom = org;
    }
  }
  if (found.kind === 'unknown') {
    return { check: { status: 'unknown', detail: found.detail, record: null }, blocker: null };
  }
  if (found.kind === 'invalid') {
    return {
      check: { status: 'fail', detail: found.detail, record: found.record },
      blocker: issue('email_dmarc_invalid', found.detail)
    };
  }
  if (found.kind === 'absent') {
    return {
      check: { status: 'fail', detail: `${domain} publishes no DMARC record.`, record: null },
      blocker: issue(
        'email_dmarc_missing',
        `${domain} publishes no DMARC record. Add a TXT record at _dmarc.${domain}, for example "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".`
      )
    };
  }
  // A subdomain that inherits the organizational record is governed by sp= when present.
  const effective =
    inheritedFrom && found.subdomainPolicy ? `sp=${found.subdomainPolicy}` : `p=${found.policy}`;
  return {
    check: {
      status: 'pass',
      detail: inheritedFrom
        ? `DMARC ${effective}, inherited from ${inheritedFrom}.`
        : `DMARC ${effective}.`,
      record: found.record
    },
    blocker: null
  };
}

export async function evaluateDeliverability(
  input: { domain: string; provider: MailProvider; dkimSelector?: string | null },
  resolver: DnsResolver = defaultDnsResolver()
): Promise<DeliverabilityEvaluation> {
  const domain = normalizeSenderDomain(input.domain);
  if (CONSUMER_MAILBOX_DOMAINS.has(domain)) {
    const managed: DeliverabilityCheck = {
      status: 'provider_managed',
      detail: `${domain} is a consumer mailbox; its provider manages SPF, DKIM and DMARC.`,
      record: null
    };
    return {
      domain,
      provider: input.provider,
      status: 'pass',
      spf: managed,
      dkim: managed,
      dmarc: managed,
      blockers: [],
      warnings: [
        issue(
          'email_consumer_mailbox',
          `${domain} is a consumer mailbox: you cannot publish your own SPF, DKIM or DMARC and daily sending limits are low. Use a mailbox on your own domain for outreach.`
        )
      ]
    };
  }
  const [spf, dkim, dmarc] = await Promise.all([
    evaluateSpf(resolver, domain, input.provider),
    evaluateDkim(resolver, domain, input.provider, input.dkimSelector ?? null),
    evaluateDmarc(resolver, domain)
  ]);
  const blockers = [spf.blocker, dkim.blocker, dmarc.blocker].filter(
    (blocker): blocker is EmailChannelIssue => blocker !== null
  );
  const status: DeliverabilityStatus =
    blockers.length > 0
      ? 'fail'
      : [spf.check, dkim.check, dmarc.check].some((check) => check.status === 'unknown')
        ? 'unknown'
        : 'pass';
  return {
    domain,
    provider: input.provider,
    status,
    spf: spf.check,
    dkim: dkim.check,
    dmarc: dmarc.check,
    blockers,
    warnings: [spf.warning].filter((warning): warning is EmailChannelIssue => warning !== undefined)
  };
}
