import { describe, expect, it } from 'vitest';
import type { EnrichmentSettings, GtmPlanCost } from '../api';
import { approveLabel, formatCredits, keyStatusLine, planCostLines, usageLine } from './planCost';

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
      'This month: 4.5 credits used or reserved of a 20 credits cap.',
      '6.5 credits would remain under the cap.'
    ]);
    expect(planCostLines({ ...cost, remainingAfter: -4 })[2]).toBe(
      'This exceeds the cap by 4 credits.'
    );
  });

  it('puts the credit ceiling on the approve button', () => {
    expect(approveLabel(cost, false)).toBe('Approve · up to 9 credits');
    expect(approveLabel(undefined, false)).toBe('Prepare this');
    expect(approveLabel(cost, true)).toBe('Preparing…');
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
});
