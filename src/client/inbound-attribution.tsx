import { heardAboutLabel } from '../shared/attribution';
import type { OpportunityRecord } from '../shared/types';

/** The self-reported channel as its own chip; UTM keys as `key=value` chips. */
export function attributionChips(attribution: Record<string, unknown>): {
  heardAbout: string | null;
  utm: Array<[string, string]>;
} {
  const heard = attribution.heard_about;
  const heardAbout = typeof heard === 'string' ? heardAboutLabel(heard) : null;
  const utm = Object.entries(attribution)
    .filter(
      ([key, value]) =>
        key !== 'heard_about' && value !== undefined && value !== null && String(value).trim()
    )
    .map(([key, value]) => [key, String(value)] as [string, string]);
  return { heardAbout, utm };
}

export function opportunitySourceLine(
  opportunity: Pick<OpportunityRecord, 'sourceHeardAbout' | 'sourceUtmSource'>
): string | null {
  const heard = heardAboutLabel(opportunity.sourceHeardAbout);
  const parts = [
    heard ? `heard about us via ${heard}` : null,
    opportunity.sourceUtmSource ? `utm_source=${opportunity.sourceUtmSource}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `Source: ${parts.join(' · ')}` : null;
}
