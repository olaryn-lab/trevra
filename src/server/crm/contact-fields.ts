import { canonicalProfileUrl } from '../linkedin/lead-import.js';

/**
 * Contact fields Trevra can upsert into a CRM (TRV-051), and the one table that
 * maps each to a provider's property.
 *
 * Matching and conflict detection compare NORMALIZED values. Writes send the
 * Trevra display value (trimmed, whitespace collapsed); email is written
 * lowercased and the LinkedIn URL as the canonical profile URL, because those
 * forms are the identity.
 */

export const CRM_CONTACT_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'company',
  'title',
  'linkedinUrl',
  'phone'
] as const;
export type CrmContactField = (typeof CRM_CONTACT_FIELDS)[number];

export const CRM_CONTACT_PROVIDERS = ['hubspot', 'attio'] as const;
export type CrmContactProviderKey = (typeof CRM_CONTACT_PROVIDERS)[number];

export interface CrmFieldMapping {
  /** The provider's property / attribute slug. */
  property: string;
  /**
   * False when Trevra reads the field for matching but never writes it (an Attio
   * person's company is a reference to a company record, not text).
   */
  writable: boolean;
  /** A value format the provider requires before Trevra writes the field. */
  format?: 'e164';
}

/**
 * THE field map. Provider code reads property names from here and nowhere else.
 *
 * HubSpot: default contact properties (`hs_linkedin_url` is HubSpot's "LinkedIn
 * URL" contact property). Attio: standard `people` attributes; `name` is one
 * personal-name value holding first and last name.
 */
export const CRM_CONTACT_FIELD_MAP: Record<
  CrmContactProviderKey,
  Record<CrmContactField, CrmFieldMapping>
> = {
  hubspot: {
    firstName: { property: 'firstname', writable: true },
    lastName: { property: 'lastname', writable: true },
    email: { property: 'email', writable: true },
    company: { property: 'company', writable: true },
    title: { property: 'jobtitle', writable: true },
    linkedinUrl: { property: 'hs_linkedin_url', writable: true },
    phone: { property: 'phone', writable: true }
  },
  attio: {
    firstName: { property: 'name.first_name', writable: true },
    lastName: { property: 'name.last_name', writable: true },
    email: { property: 'email_addresses', writable: true },
    company: { property: 'company', writable: false },
    title: { property: 'job_title', writable: true },
    linkedinUrl: { property: 'linkedin', writable: true },
    phone: { property: 'phone_numbers', writable: true, format: 'e164' }
  }
};

export function isCrmContactProvider(value: string): value is CrmContactProviderKey {
  return (CRM_CONTACT_PROVIDERS as readonly string[]).includes(value);
}

/** Trimmed, whitespace collapsed, NFKC; null when nothing is left. */
export function displayValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 500) : null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = displayValue(value)?.toLowerCase() ?? null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * `https://www.linkedin.com/in/<handle>/`, the form Trevra writes. Accepts the
 * forms CRMs hold: with or without scheme, `www.`, trailing slash or query.
 */
export function canonicalLinkedinUrl(value: unknown): string | null {
  const raw = displayValue(value);
  if (!raw) return null;
  const withScheme = /^(www\.)?linkedin\.com\//i.test(raw) ? `https://${raw}` : raw;
  let candidate = withScheme;
  try {
    if (/^https?:\/\//i.test(withScheme)) {
      const parsed = new URL(withScheme);
      parsed.search = '';
      parsed.hash = '';
      candidate = parsed.toString();
    }
  } catch {
    return null;
  }
  return canonicalProfileUrl(candidate);
}

/** The LinkedIn match key: the canonical profile URL, lowercased. */
export function normalizeLinkedinUrl(value: unknown): string | null {
  return canonicalLinkedinUrl(value)?.toLowerCase() ?? null;
}

/**
 * The spellings a CRM may hold for one canonical profile URL. Searched with an
 * exact-match OR, then every hit is re-checked through `normalizeLinkedinUrl`.
 */
export function linkedinUrlVariants(normalized: string): string[] {
  const match = /^https:\/\/www\.linkedin\.com\/in\/([^/]+)\/$/.exec(normalized);
  if (!match) return [normalized];
  const handle = match[1];
  const variants: string[] = [];
  for (const host of ['https://www.', 'https://', 'http://www.', 'http://', 'www.', '']) {
    for (const tail of ['/', '']) variants.push(`${host}linkedin.com/in/${handle}${tail}`);
  }
  return variants;
}

export function normalizeText(value: unknown): string | null {
  return displayValue(value)?.toLowerCase() ?? null;
}

/** `+` and digits only, so formatting differences are not conflicts. */
export function normalizePhone(value: unknown): string | null {
  const raw = displayValue(value);
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  return raw.trim().startsWith('+') ? `+${digits}` : digits;
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** The comparable form of one field, used for conflicts and staleness. */
export function normalizeField(field: CrmContactField, value: unknown): string | null {
  switch (field) {
    case 'email':
      return normalizeEmail(value) ?? normalizeText(value);
    case 'linkedinUrl':
      return normalizeLinkedinUrl(value) ?? normalizeText(value);
    case 'phone':
      return normalizePhone(value);
    default:
      return normalizeText(value);
  }
}

export function isEmptyValue(value: unknown): boolean {
  return displayValue(value) === null;
}
