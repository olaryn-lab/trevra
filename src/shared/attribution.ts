/**
 * Self-reported "how did you hear about us", bounded. The form may send free
 * text; only one of these choices is ever stored, and anything else becomes
 * 'other'. That keeps the answer countable and content-free.
 */
export const HEARD_ABOUT_CHOICES = [
  'search',
  'ai_assistant',
  'social',
  'community',
  'github',
  'newsletter',
  'podcast',
  'event',
  'referral',
  'partner',
  'other'
] as const;

export type HeardAbout = (typeof HEARD_ABOUT_CHOICES)[number];

export const HEARD_ABOUT_LABELS: Record<HeardAbout, string> = {
  search: 'Search engine',
  ai_assistant: 'AI assistant',
  social: 'Social media',
  community: 'Community or forum',
  github: 'GitHub',
  newsletter: 'Newsletter',
  podcast: 'Podcast',
  event: 'Event',
  referral: 'Referral',
  partner: 'Partner',
  other: 'Other'
};

const CHOICES = new Set<string>(HEARD_ABOUT_CHOICES);

export function normalizeHeardAbout(value: string): HeardAbout {
  const key = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CHOICES.has(key) ? (key as HeardAbout) : 'other';
}

export function heardAboutLabel(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return HEARD_ABOUT_LABELS[normalizeHeardAbout(value)];
}
