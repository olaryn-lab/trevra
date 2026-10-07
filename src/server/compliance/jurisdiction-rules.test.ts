import { describe, expect, it } from 'vitest';
import {
  COLD_EMAIL_RULES,
  JURISDICTION_RULES_DISCLAIMER,
  countryFromDomain,
  decideEmailLawfulBasis,
  isReservedEmailDomain,
  normalizeCountryCode,
  resolveRecipientCountry
} from './jurisdiction-rules.js';

function decide(
  country: string | null,
  bases: string[] = [],
  extra: Partial<Parameters<typeof decideEmailLawfulBasis>[0]> = {}
) {
  return decideEmailLawfulBasis({
    email: 'buyer@acme-gmbh.de',
    country,
    countrySource: country ? 'contact' : 'unknown',
    bases,
    purpose: 'outreach',
    hasInboundEmail: false,
    hasInboundRequest: false,
    ...extra
  });
}

describe('jurisdiction rules', () => {
  it('cites a primary source for every country it names and says it is not legal advice', () => {
    expect(JURISDICTION_RULES_DISCLAIMER).toBe('Not legal advice; verify with counsel.');
    expect(Object.keys(COLD_EMAIL_RULES).sort()).toEqual([
      'AT',
      'CA',
      'CH',
      'DE',
      'FR',
      'GB',
      'US'
    ]);
    for (const rule of Object.values(COLD_EMAIL_RULES)) {
      expect(rule.sources.length).toBeGreaterThan(0);
      expect(rule.sources.every((source) => source.startsWith('https://'))).toBe(true);
    }
  });

  it('reads country names and codes, and refuses what it cannot read', () => {
    expect(normalizeCountryCode('Germany')).toBe('DE');
    expect(normalizeCountryCode(' deutschland ')).toBe('DE');
    expect(normalizeCountryCode('uk')).toBe('GB');
    expect(normalizeCountryCode('United States')).toBe('US');
    expect(normalizeCountryCode('ch')).toBe('CH');
    expect(normalizeCountryCode('Atlantis')).toBeNull();
    expect(normalizeCountryCode('')).toBeNull();
    expect(normalizeCountryCode(42)).toBeNull();
  });

  it('takes a country from a ccTLD only, never from a generic or regional one', () => {
    expect(countryFromDomain('acme-gmbh.de')).toBe('DE');
    expect(countryFromDomain('acme.co.uk')).toBe('GB');
    expect(countryFromDomain('acme.ch')).toBe('CH');
    expect(countryFromDomain('acme.io')).toBeNull();
    expect(countryFromDomain('acme.com')).toBeNull();
    expect(countryFromDomain('acme.eu')).toBeNull();
    expect(countryFromDomain(null)).toBeNull();
  });

  it('knows the reserved test domains', () => {
    expect(isReservedEmailDomain('example.com')).toBe(true);
    expect(isReservedEmailDomain('mail.example.org')).toBe(true);
    expect(isReservedEmailDomain('people.test')).toBe(true);
    expect(isReservedEmailDomain('acme-gmbh.de')).toBe(false);
  });

  it('resolves the country from the person first, the account domain last', () => {
    const all = {
      contactCountry: 'FR',
      leadCountry: 'Germany',
      accountCountry: 'CH',
      accountDomain: 'acme.at'
    };
    expect(resolveRecipientCountry(all)).toEqual({ country: 'FR', source: 'contact' });
    expect(resolveRecipientCountry({ ...all, contactCountry: null })).toEqual({
      country: 'DE',
      source: 'lead_list'
    });
    expect(resolveRecipientCountry({ ...all, contactCountry: null, leadCountry: null })).toEqual({
      country: 'CH',
      source: 'account'
    });
    expect(
      resolveRecipientCountry({
        contactCountry: null,
        leadCountry: null,
        accountCountry: null,
        accountDomain: 'acme.at'
      })
    ).toEqual({ country: 'AT', source: 'account_domain' });
    expect(
      resolveRecipientCountry({
        contactCountry: null,
        leadCountry: 'Atlantis',
        accountCountry: null,
        accountDomain: 'acme.io'
      })
    ).toEqual({ country: null, source: 'unknown' });
  });

  it('denies cold email to Germany without consent or a customer relationship, without naming the address', () => {
    const decision = decide('DE', ['legitimate_interest']);
    expect(decision.status).toBe('missing');
    expect(decision.reason).toBe(
      'Cold email to a recipient in DE needs recorded consent or an existing-customer relationship; none is recorded for this person.'
    );
    expect(decision.reason).not.toContain('acme-gmbh');
    expect(decide('DE', ['consent'])).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('accepts a recorded legitimate interest in FR and GB, and needs nothing recorded in the US', () => {
    expect(decide('FR', ['legitimate_interest'])).toMatchObject({
      status: 'satisfied',
      basis: 'legitimate_interest'
    });
    expect(decide('GB', [])).toMatchObject({ status: 'missing' });
    expect(decide('US', [])).toMatchObject({ status: 'not_required', basis: null });
  });

  it('requires an explicit basis for an unknown country and for a country with no rule', () => {
    expect(decide(null).reason).toBe(
      'Cold email to a recipient in an unknown country needs recorded consent, an existing-customer relationship, or a recorded legitimate interest; none is recorded for this person.'
    );
    expect(decide(null)).toMatchObject({ status: 'missing', countrySource: 'unknown' });
    expect(decide('JP')).toMatchObject({ status: 'missing' });
    expect(decide('JP', ['legitimate_interest'])).toMatchObject({ status: 'satisfied' });
  });

  it('exempts only what is not cold: reserved domains, replies to inbound email, answers to an inbound request', () => {
    expect(decide('DE', [], { email: 'lead@example.com' }).status).toBe('not_required');
    expect(decide('DE', [], { purpose: 'reply', hasInboundEmail: true }).status).toBe(
      'not_required'
    );
    expect(decide('DE', [], { purpose: 'reply', hasInboundEmail: false }).status).toBe('missing');
    expect(decide('DE', [], { purpose: 'qualified_demand', hasInboundRequest: true }).status).toBe(
      'not_required'
    );
    expect(decide('DE', [], { purpose: 'outreach', hasInboundRequest: true }).status).toBe(
      'missing'
    );
  });
});
