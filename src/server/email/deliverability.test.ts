import { describe, expect, it } from 'vitest';
import {
  defaultDnsResolver,
  emailDomainOf,
  evaluateDeliverability,
  mailProviderFor,
  type DnsResolver
} from './deliverability.js';

function fakeResolver(
  records: Record<string, string[] | Error>
): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (value instanceof Error) throw value;
      if (!value)
        throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';
const GOOGLE_SPF = { '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'] };
const MICROSOFT_SPF = { 'spf.protection.outlook.com': ['v=spf1 ip4:198.51.100.0/24 -all'] };

function googleDomain(overrides: Record<string, string[] | Error> = {}) {
  return {
    ...GOOGLE_SPF,
    'acme.test': ['google-site-verification=abc123', 'v=spf1 include:_spf.google.com ~all'],
    'google._domainkey.acme.test': [DKIM],
    '_dmarc.acme.test': ['v=DMARC1; p=none; rua=mailto:dmarc@acme.test'],
    ...overrides
  };
}

describe('email deliverability evaluation', () => {
  it('passes a Google Workspace domain with SPF, DKIM and DMARC', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain())
    );
    expect(result.status).toBe('pass');
    expect(result.blockers).toEqual([]);
    expect(result.spf).toMatchObject({ status: 'pass', lookups: 1 });
    expect(result.dkim).toMatchObject({ status: 'pass', selector: 'google' });
    expect(result.dmarc).toMatchObject({ status: 'pass', detail: 'DMARC p=none.' });
  });

  it('blocks a domain that publishes none of the three records', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver({})
    );
    expect(result.status).toBe('fail');
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_missing',
      'email_dkim_missing',
      'email_dmarc_missing'
    ]);
    expect(result.blockers.every((blocker) => blocker.actionHref === '/setup/workspace')).toBe(
      true
    );
    expect(result.blockers[0]!.message).toContain('include:_spf.google.com');
  });

  it('blocks SPF that does not authorize the sending provider', async () => {
    const outlookOnly = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          ...MICROSOFT_SPF,
          'acme.test': ['v=spf1 include:spf.protection.outlook.com -all']
        })
      )
    );
    expect(outlookOnly.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);

    const failQualified = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 -include:_spf.google.com ~all'] }))
    );
    expect(failQualified.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);
  });

  it('treats more than ten SPF lookups as invalid', async () => {
    const nested = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`n${index}.acme.test`, ['v=spf1 ~all']])
    );
    const includes = Array.from({ length: 10 }, (_, index) => `include:n${index}.acme.test`);
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          ...nested,
          'acme.test': [`v=spf1 include:_spf.google.com ${includes.join(' ')} ~all`]
        })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
    expect(result.spf.detail).toContain('more than 10 DNS lookups');
  });

  it('stops evaluating SPF mechanisms at the first all', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 ~all include:_spf.google.com'] }))
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);
    expect(result.spf.lookups).toBe(0);
  });

  it('treats a missing include as invalid at the first one', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          'acme.test': [
            'v=spf1 include:_spf.google.com include:gone1.acme.test include:gone2.acme.test include:gone3.acme.test ~all'
          ]
        })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
    expect(result.spf.detail).toContain('gone1.acme.test, which publishes no SPF record');
  });

  it('reports a missing include as invalid even when a later include times out', async () => {
    const timeout = Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' });
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          'acme.test': [
            'v=spf1 include:missing.example include:slow.example include:_spf.google.com -all'
          ],
          'slow.example': timeout
        })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
  });

  describe('void lookups for a, mx and exists', () => {
    function withA(records: Record<string, string[] | Error>, a: Record<string, string[]>) {
      return {
        ...fakeResolver(records),
        async resolveA(name: string) {
          const answer = a[name];
          if (!answer) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
          return answer;
        }
      };
    }
    const record = (voids: number) =>
      `v=spf1 ${Array.from({ length: voids }, (_, i) => `a:gone${i}.acme.test`).join(' ')} include:_spf.google.com ~all`;

    it('treats three void a lookups as invalid', async () => {
      const result = await evaluateDeliverability(
        { domain: 'acme.test', provider: 'google' },
        withA(googleDomain({ 'acme.test': [record(3)] }), {})
      );
      expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
      expect(result.spf.detail).toContain('more than 2 void lookups');
    });

    it('passes with only two void a lookups', async () => {
      const result = await evaluateDeliverability(
        { domain: 'acme.test', provider: 'google' },
        withA(googleDomain({ 'acme.test': [record(2)] }), {})
      );
      expect(result.status).toBe('pass');
    });

    it('reports unknown when an a lookup fails with a temporary error', async () => {
      const resolver = {
        ...fakeResolver(googleDomain({ 'acme.test': [record(1)] })),
        async resolveA(): Promise<string[]> {
          throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
        }
      };
      const result = await evaluateDeliverability(
        { domain: 'acme.test', provider: 'google' },
        resolver
      );
      expect(result.spf.status).toBe('unknown');
    });
  });

  it('rejects SPF records with unrecognised terms', async () => {
    for (const spf of [
      'v=spf1 include:_spf.google.com foo:bar ~all',
      'v=spf1 ip:203.0.113.5 include:_spf.google.com ~all'
    ]) {
      const result = await evaluateDeliverability(
        { domain: 'acme.test', provider: 'google' },
        fakeResolver(googleDomain({ 'acme.test': [spf] }))
      );
      expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
      expect(result.spf.detail).toContain('Unrecognised SPF term');
    }
  });

  it('rejects a duplicate redirect modifier and ignores unknown modifiers', async () => {
    const duplicate = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          'acme.test': ['v=spf1 redirect=_spf.google.com redirect=_spf.google.com']
        })
      )
    );
    expect(duplicate.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
    const unknown = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 include:_spf.google.com foo=bar ~all'] }))
    );
    expect(unknown.status).toBe('pass');
  });

  it('warns when SPF ends in +all or a bare all', async () => {
    for (const all of ['+all', 'all']) {
      const result = await evaluateDeliverability(
        { domain: 'acme.test', provider: 'google' },
        fakeResolver(googleDomain({ 'acme.test': [`v=spf1 include:_spf.google.com ${all}`] }))
      );
      expect(result.status).toBe('pass');
      expect(result.warnings.map((warning) => warning.code)).toEqual(['email_spf_permissive_all']);
    }
  });

  it('uses redirect= when there is no all and ignores it when all is present', async () => {
    const redirected = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 redirect=_spf.google.com'] }))
    );
    expect(redirected.spf.status).toBe('pass');
    const ignored = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(googleDomain({ 'acme.test': ['v=spf1 redirect=_spf.google.com ~all'] }))
    );
    expect(ignored.blockers.map((blocker) => blocker.code)).toEqual([
      'email_spf_provider_not_authorized'
    ]);
  });

  it('reports an include loop as invalid', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({
          'acme.test': ['v=spf1 include:loop.acme.test ~all'],
          'loop.acme.test': ['v=spf1 include:acme.test ~all']
        })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
    expect(result.spf.detail).toContain('include loop');
  });

  it('joins multi-chunk TXT strings, reads uppercase V=SPF1, and tells ENODATA from SERVFAIL', async () => {
    const chunked: DnsResolver = {
      async resolveTxt(name: string) {
        if (name === 'acme.test') return [['V=SPF1 include:_spf.goo', 'gle.com ~all']];
        if (name === '_spf.google.com') return [['v=spf1 ip4:203.0.113.0/24 ~all']];
        if (name === 'google._domainkey.acme.test') return [[DKIM.slice(0, 20), DKIM.slice(20)]];
        if (name === '_dmarc.acme.test') {
          throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
        }
        throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
      }
    };
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      chunked
    );
    expect(result.spf.status).toBe('pass');
    expect(result.dkim.status).toBe('pass');
    expect(result.dmarc.status).toBe('fail');
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_dmarc_missing']);

    const servfail: DnsResolver = {
      async resolveTxt(name: string) {
        return chunked
          .resolveTxt(name === '_dmarc.acme.test' ? 'servfail.acme.test' : name)
          .catch(() => {
            throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
          });
      }
    };
    const failed = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      servfail
    );
    expect(failed.dmarc.status).toBe('unknown');
  });

  it('treats two SPF records as invalid', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver(
        googleDomain({ 'acme.test': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 -all'] })
      )
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['email_spf_invalid']);
  });

  it('accepts an organizational DMARC record for a subdomain sender', async () => {
    const result = await evaluateDeliverability(
      { domain: 'mail.acme.test', provider: 'google' },
      fakeResolver({
        ...GOOGLE_SPF,
        'mail.acme.test': ['v=spf1 include:_spf.google.com ~all'],
        'google._domainkey.mail.acme.test': [DKIM],
        '_dmarc.acme.test': ['v=DMARC1; p=quarantine']
      })
    );
    expect(result.status).toBe('pass');
    expect(result.dmarc.detail).toBe('DMARC p=quarantine, inherited from acme.test.');
  });

  it('honours sp= for a subdomain that inherits the organizational DMARC record', async () => {
    const result = await evaluateDeliverability(
      { domain: 'mail.acme.test', provider: 'google' },
      fakeResolver({
        ...GOOGLE_SPF,
        'mail.acme.test': ['v=spf1 include:_spf.google.com ~all'],
        'google._domainkey.mail.acme.test': [DKIM],
        '_dmarc.acme.test': ['v=DMARC1; p=none; sp=quarantine']
      })
    );
    expect(result.dmarc.detail).toBe('DMARC sp=quarantine, inherited from acme.test.');
  });

  it('rejects an invalid sp= and an unrecognised DMARC version tag', async () => {
    const base = {
      ...GOOGLE_SPF,
      'acme.test': ['v=spf1 include:_spf.google.com ~all'],
      'google._domainkey.acme.test': [DKIM]
    };
    const bogus = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver({ ...base, '_dmarc.acme.test': ['v=DMARC1; p=reject; sp=bogus'] })
    );
    expect(bogus.blockers.map((blocker) => blocker.code)).toEqual(['email_dmarc_invalid']);
    const lower = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      fakeResolver({ ...base, '_dmarc.acme.test': ['v=dmarc1; p=reject'] })
    );
    expect(lower.blockers.map((blocker) => blocker.code)).toEqual(['email_dmarc_missing']);
  });

  it('reports unknown, never pass, when DNS times out', async () => {
    const timeout = Object.assign(new Error('queryTxt ETIMEOUT acme.test'), { code: 'ETIMEOUT' });
    const resolver: DnsResolver = {
      async resolveTxt() {
        throw timeout;
      }
    };
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('unknown');
    expect(result.blockers).toEqual([]);
    expect([result.spf.status, result.dkim.status, result.dmarc.status]).toEqual([
      'unknown',
      'unknown',
      'unknown'
    ]);
  });

  it('checks both Microsoft 365 DKIM selectors', async () => {
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'microsoft' },
      fakeResolver({
        ...MICROSOFT_SPF,
        'acme.test': ['v=spf1 include:spf.protection.outlook.com -all'],
        'selector2._domainkey.acme.test': [DKIM],
        '_dmarc.acme.test': ['v=DMARC1; p=reject']
      })
    );
    expect(result.status).toBe('pass');
    expect(result.dkim.selector).toBe('selector2');
  });

  it('does not query DNS for consumer mailboxes', async () => {
    const resolver = fakeResolver({});
    const result = await evaluateDeliverability(
      { domain: 'gmail.com', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('pass');
    expect(result.spf.status).toBe('provider_managed');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['email_consumer_mailbox']);
    expect(resolver.calls).toEqual([]);
  });

  it('refuses real DNS when TREVRA_DNS_DISABLED is true', async () => {
    const resolver = defaultDnsResolver({ TREVRA_DNS_DISABLED: 'true' } as NodeJS.ProcessEnv);
    await expect(resolver.resolveTxt('acme.test')).rejects.toMatchObject({ code: 'EDISABLED' });
    const result = await evaluateDeliverability(
      { domain: 'acme.test', provider: 'google' },
      resolver
    );
    expect(result.status).toBe('unknown');
  });

  it('maps providers and domains conservatively', () => {
    expect(mailProviderFor('google-mail')).toBe('google');
    expect(mailProviderFor('outlook')).toBe('microsoft');
    expect(mailProviderFor('hubspot')).toBeNull();
    expect(emailDomainOf('Founder@Acme.TEST')).toBe('acme.test');
    expect(emailDomainOf('not-an-address')).toBeNull();
  });
});
