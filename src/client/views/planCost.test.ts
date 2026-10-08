import { describe, expect, it } from 'vitest';
import type { EnrichmentRunView, EnrichmentSettings, GtmPlanCost } from '../api';
import {
  approveLabel,
  formatCredits,
  inferredContactTitle,
  keyStatusLine,
  parseCreditCap,
  personOptionLabel,
  planCostLines,
  runCompaniesLine,
  runContactsLine,
  runCreditsLine,
  runStatusLabel,
  usageLine
} from './planCost';

const cost: GtmPlanCost = {
  provider: 'hunter',
  unit: 'credits',
  domains: 2,
  emailsPerDomain: 3,
  searchCredits: 6,
  verificationCredits: 3,
  estimatedCredits: 9,
  monthlyCap: 20,
  usedThisMonth: 4.5,
  remainingAfter: 6.5,
  pricingUrl: 'https://hunter.io/pricing'
};

const settings: EnrichmentSettings = {
  provider: 'hunter',
  monthlyCreditCap: 20,
  keyStatus: 'valid',
  keyCheckedAt: '2026-10-06T09:00:00.000Z',
  key: null
};

describe('plan cost copy', () => {
  it('formats whole and half credits with the right noun', () => {
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(4.5)).toBe('4.5 credits');
    expect(formatCredits(0)).toBe('0 credits');
  });

  it('states the worst case, the month so far and what remains', () => {
    expect(planCostLines(cost)).toEqual([
      'Up to 9 credits: 6 credits to search 2 domains (3 per domain) and 3 credits to verify.',
      'This month: 4.5 credits used or reserved of your 20-credit monthly cap.',
      '6.5 credits would remain under the cap.'
    ]);
    expect(planCostLines({ ...cost, monthlyCap: 1 })[1]).toBe(
      'This month: 4.5 credits used or reserved of your 1-credit monthly cap.'
    );
    expect(planCostLines({ ...cost, remainingAfter: -4 })[2]).toBe(
      'This exceeds the cap by 4 credits.'
    );
  });

  it('puts the credit ceiling on the approve button', () => {
    expect(approveLabel(cost, false)).toBe('Approve · up to 9 credits');
    expect(approveLabel(undefined, false)).toBe('Prepare this');
    expect(approveLabel(cost, true)).toBe('Preparing…');
  });

  it('validates the monthly cap before it reaches the server', () => {
    expect(parseCreditCap('20')).toEqual({ ok: true, value: 20 });
    expect(parseCreditCap(' 0.5 ')).toEqual({ ok: true, value: 0.5 });
    expect(parseCreditCap('0')).toEqual({ ok: true, value: 0 });
    expect(parseCreditCap('100000')).toEqual({ ok: true, value: 100000 });
    expect(parseCreditCap('')).toEqual({ ok: false, message: 'Enter a number of credits.' });
    expect(parseCreditCap('   ')).toEqual({ ok: false, message: 'Enter a number of credits.' });
    expect(parseCreditCap('abc').ok).toBe(false);
    expect(parseCreditCap('-1').ok).toBe(false);
    expect(parseCreditCap('100000.5').ok).toBe(false);
    expect(parseCreditCap('1.3')).toEqual({
      ok: false,
      message: 'Use whole or half credits, such as 20 or 20.5.'
    });
  });

  it('describes key and usage state', () => {
    expect(keyStatusLine(settings)).toBe('Hunter key saved and accepted on 2026-10-06.');
    expect(keyStatusLine({ ...settings, keyStatus: 'missing' })).toBe('No Hunter key saved.');
    expect(
      usageLine(settings, {
        monthStart: '2026-10-01T00:00:00.000Z',
        chargedCredits: 3,
        reservedCredits: 1.5,
        usedCredits: 4.5
      })
    ).toBe('4.5 credits of 20 credits used or reserved since 2026-10-01.');
    expect(
      usageLine(
        { ...settings, monthlyCreditCap: 0 },
        {
          monthStart: '2026-10-01T00:00:00.000Z',
          chargedCredits: 0,
          reservedCredits: 0,
          usedCredits: 0
        }
      )
    ).toBe('Enrichment is off until you set a monthly credit cap.');
  });

  it('describes a run in companies, contacts saved and credits', () => {
    const run: EnrichmentRunView = {
      id: 'enr_1',
      status: 'failed',
      error: "Stopped at this month's Hunter credit cap.",
      domainsDone: 2,
      domainCount: 3,
      contactsSaved: 4,
      creditsSpent: 5.5,
      estimatedCredits: 9,
      createdAt: '2026-10-06T09:00:00.000Z',
      finishedAt: '2026-10-06T09:05:00.000Z'
    };
    expect(runStatusLabel('queued')).toBe('Queued');
    expect(runStatusLabel('running')).toBe('Running');
    expect(runStatusLabel('completed')).toBe('Completed');
    expect(runStatusLabel('failed')).toBe('Failed');
    expect(runCompaniesLine(run)).toBe('2 of 3 companies');
    expect(runCompaniesLine({ ...run, domainsDone: 0, domainCount: 1 })).toBe('0 of 1 company');
    expect(runContactsLine(run)).toBe('4 contacts saved');
    expect(runContactsLine({ ...run, contactsSaved: 1 })).toBe('1 contact saved');
    expect(runCreditsLine(run)).toBe('5.5 of 9 credits');
    expect(runCreditsLine({ ...run, creditsSpent: 0, estimatedCredits: 1 })).toBe('0 of 1 credit');
  });

  it('labels inferred contacts wherever the people list is shown', () => {
    const person = { id: 'con_1', name: 'Maya Chen', email: 'maya@acme.com', accountLink: null };
    expect(personOptionLabel(person)).toBe('Maya Chen');
    expect(inferredContactTitle(person)).toBeNull();
    const inferred = {
      ...person,
      accountLink: { confidence: 'inferred' as const, source: 'hunter' }
    };
    expect(personOptionLabel(inferred)).toBe('Maya Chen · Inferred');
    expect(inferredContactTitle(inferred)).toBe(
      'Inferred: Hunter could not verify this address. Check it before you rely on it.'
    );
    expect(
      personOptionLabel({
        ...person,
        name: null,
        accountLink: { confidence: 'verified', source: 'hunter' }
      })
    ).toBe('maya@acme.com');
    expect(personOptionLabel({ id: 'con_2', name: null, email: null, accountLink: null })).toBe(
      'con_2'
    );
  });
});
