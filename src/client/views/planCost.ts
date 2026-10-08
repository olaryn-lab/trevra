import type { EnrichmentSettings, EnrichmentUsage, GtmPlanCost } from '../api';

export function formatCredits(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'credit' : 'credits'}`;
}

export function planCostLines(cost: GtmPlanCost): string[] {
  const domains = `${cost.domains} ${cost.domains === 1 ? 'domain' : 'domains'}`;
  return [
    `Up to ${formatCredits(cost.estimatedCredits)}: ${formatCredits(cost.searchCredits)} to search ${domains} (${cost.emailsPerDomain} per domain) and ${formatCredits(cost.verificationCredits)} to verify.`,
    `This month: ${formatCredits(cost.usedThisMonth)} used or reserved of your ${cost.monthlyCap}-credit monthly cap.`,
    cost.remainingAfter >= 0
      ? `${formatCredits(cost.remainingAfter)} would remain under the cap.`
      : `This exceeds the cap by ${formatCredits(-cost.remainingAfter)}.`
  ];
}

export function approveLabel(cost: GtmPlanCost | undefined, preparing: boolean): string {
  if (preparing) return 'Preparing…';
  return cost ? `Approve · up to ${formatCredits(cost.estimatedCredits)}` : 'Prepare this';
}

export function keyStatusLine(settings: EnrichmentSettings): string {
  switch (settings.keyStatus) {
    case 'missing':
      return 'No Hunter key saved.';
    case 'unchecked':
      return 'Hunter key saved, not yet checked.';
    case 'valid':
      return settings.keyCheckedAt
        ? `Hunter key saved and accepted on ${settings.keyCheckedAt.slice(0, 10)}.`
        : 'Hunter key saved and accepted.';
    case 'invalid':
      return 'Hunter rejected the saved key. Replace it to enrich again.';
  }
}

export function usageLine(settings: EnrichmentSettings, usage: EnrichmentUsage): string {
  if (settings.monthlyCreditCap <= 0)
    return 'Enrichment is off until you set a monthly credit cap.';
  return `${formatCredits(usage.usedCredits)} of ${formatCredits(settings.monthlyCreditCap)} used or reserved since ${usage.monthStart.slice(0, 10)}.`;
}

export const MAX_MONTHLY_CREDIT_CAP = 100_000;

export function parseCreditCap(
  text: string
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    return { ok: false, message: 'Enter a number of credits.' };
  }
  if (value < 0 || value > MAX_MONTHLY_CREDIT_CAP) {
    return { ok: false, message: `Enter between 0 and ${MAX_MONTHLY_CREDIT_CAP} credits.` };
  }
  if (!Number.isInteger(value * 2)) {
    return { ok: false, message: 'Use whole or half credits, such as 20 or 20.5.' };
  }
  return { ok: true, value };
}
