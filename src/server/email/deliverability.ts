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
  return { resolveTxt: (name) => resolver.resolveTxt(name) };
}

export function mailProviderFor(provider: string): MailProvider | null {
  const value = provider.trim().toLowerCase();
  if (value === 'gmail' || value === 'google-mail') return 'google';
  if (value === 'microsoft' || value === 'outlook') return 'microsoft';
  return null;
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
const PROVIDER_SPF_INCLUDE: Record<MailProvider, string> = {
  google: '_spf.google.com',
  microsoft: 'spf.protection.outlook.com'
};
const PROVIDER_LABEL: Record<MailProvider, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365'
};
// lc-debt: default selectors only (Google "google", Microsoft 365 "selector1"/"selector2"); a custom DKIM selector reads as missing. Upgrade path: an owner-set selector stored per sending domain.
const DKIM_SELECTORS: Record<MailProvider, string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2']
};
const CONSUMER_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com'
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
  target: string,
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
  let authorized = false;
  // A missing include is a permerror, but it is held until the record is fully walked so
  // the void-lookup limit can report the more specific cause.
  let deferredInvalid: string | null = null;
  for (const term of terms) {
    const match = /^([+?~-]?)([a-z][a-z0-9.-]*)(?:[:=](.*))?$/i.exec(term);
    if (!match) continue;
    const qualifier = match[1] || '+';
    const mechanism = match[2]!.toLowerCase();
    // Mechanisms after the first "all" are never evaluated (RFC 7208 section 5.1).
    if (mechanism === 'all') break;
    const value = (match[3] ?? '').trim().toLowerCase().replace(/\.$/, '');
    const isRedirect = mechanism === 'redirect' && !hasAll;
    if (SPF_LOOKUP_MECHANISMS.has(mechanism) || isRedirect) {
      state.lookups += 1;
      if (state.lookups > SPF_LOOKUP_LIMIT) {
        return {
          result: 'invalid',
          detail: `SPF for ${domain} needs more than ${SPF_LOOKUP_LIMIT} DNS lookups; receivers stop evaluating it.`,
          record
        };
      }
    }
    if (mechanism !== 'include' && !isRedirect) continue;
    if (!value) {
      return {
        result: 'invalid',
        detail: `SPF ${mechanism} at ${domain} names no domain.`,
        record
      };
    }
    // Macro targets (%{...}) cannot be evaluated statically; they never count as authorizing.
    if (value.includes('%')) continue;
    const nested = await walkSpf(resolver, value, target, state, path);
    if (nested.result === 'unknown') return nested;
    if (nested.result === 'missing') {
      if (nested.void) state.voids += 1;
      if (state.voids > SPF_VOID_LOOKUP_LIMIT) {
        return {
          result: 'invalid',
          detail: `SPF for ${domain} makes more than ${SPF_VOID_LOOKUP_LIMIT} void lookups; receivers treat that as a permanent error.`,
          record
        };
      }
      deferredInvalid ??= `SPF for ${domain} includes ${value}, which publishes no SPF record.`;
      continue;
    }
    if (nested.result === 'invalid') return { result: 'invalid', detail: nested.detail, record };
    if ((isRedirect || qualifier === '+') && (value === target || nested.authorized)) {
      authorized = true;
    }
  }
  if (deferredInvalid) return { result: 'invalid', detail: deferredInvalid, record };
  return { result: 'ok', authorized, record };
}

type Evaluated = { check: DeliverabilityCheck; blocker: EmailChannelIssue | null };

async function evaluateSpf(
  resolver: DnsResolver,
  domain: string,
  provider: MailProvider
): Promise<Evaluated> {
  const target = PROVIDER_SPF_INCLUDE[provider];
  const label = PROVIDER_LABEL[provider];
  const state = { lookups: 0, voids: 0 };
  const walk = await walkSpf(resolver, domain, target, state, new Set());
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
        detail: `SPF does not authorize ${target}.`,
        record: walk.record,
        lookups: state.lookups
      },
      blocker: issue(
        'email_spf_provider_not_authorized',
        `The SPF record for ${domain} does not include ${target}, so mail sent through ${label} fails SPF. Add "include:${target}" before the final "all".`
      )
    };
  }
  return {
    check: {
      status: 'pass',
      detail: `SPF authorizes ${target} (${state.lookups} of ${SPF_LOOKUP_LIMIT} lookups).`,
      record: walk.record,
      lookups: state.lookups
    },
    blocker: null
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
  provider: MailProvider
): Promise<Evaluated> {
  const selectors = DKIM_SELECTORS[provider];
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
    .filter((value) => /^v=DMARC1\s*(?:;|$)/i.test(value));
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
  const sp = /(?:^|;)\s*sp\s*=\s*([a-z]+)\s*(?:;|$)/i.exec(records[0]!)?.[1]?.toLowerCase();
  // An unrecognised sp= is ignored, so the subdomain falls back to p=.
  const subdomainPolicy = sp && ['none', 'quarantine', 'reject'].includes(sp) ? sp : null;
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
  input: { domain: string; provider: MailProvider },
  resolver: DnsResolver = defaultDnsResolver()
): Promise<DeliverabilityEvaluation> {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, '');
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
    evaluateDkim(resolver, domain, input.provider),
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
    warnings: []
  };
}
