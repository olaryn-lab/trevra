/**
 * Lead intake sources Trevra deliberately does not support (TRV-021/022/023).
 *
 * ONE SOURCE OF TRUTH FOR THE REFUSAL. The server answers a request to collect
 * from one of these with `INTAKE_SOURCE_UNSUPPORTED` and the sentence below;
 * the intake screen renders the same sentence before anybody asks. Neither
 * side may paraphrase it into something softer ("unavailable right now"), because
 * it is not temporary and there is no switch that turns it on.
 *
 * Collecting people out of LinkedIn search, Sales Navigator or a post's likers
 * and commenters is scraping. That breaks LinkedIn's User Agreement and puts
 * the operator's own LinkedIn account at risk, so the supported paths are the
 * ones where the operator brings the people: a CSV they may use, or profile
 * URLs they picked themselves.
 */

/** Stable machine-readable code on every refusal of an unsupported intake source. */
export const INTAKE_SOURCE_UNSUPPORTED = 'intake_source_unsupported' as const;

export type UnsupportedIntakeSource = 'linkedin_search' | 'sales_navigator' | 'post_engagers';

export const UNSUPPORTED_INTAKE_SOURCE_ORDER: readonly UnsupportedIntakeSource[] = [
  'linkedin_search',
  'sales_navigator',
  'post_engagers'
];

export interface UnsupportedIntakeCopy {
  /** What the operator would call it. */
  label: string;
  /** Why Trevra will not do it, in product language. */
  reason: string;
  /** The supported path that gets the same people in. */
  instead: string;
}

export const UNSUPPORTED_INTAKE_COPY: Record<UnsupportedIntakeSource, UnsupportedIntakeCopy> = {
  linkedin_search: {
    label: 'LinkedIn people search',
    reason:
      'Trevra does not scrape LinkedIn search results. Collecting people from a search automatically violates LinkedIn’s terms and puts your LinkedIn account at risk of restriction.',
    instead:
      'Run the search on LinkedIn yourself and paste the profile URLs of the people you chose, or import a CSV you are allowed to use.'
  },
  sales_navigator: {
    label: 'Sales Navigator',
    reason:
      'Trevra does not scrape Sales Navigator. Collecting leads from Sales Navigator automatically violates LinkedIn’s terms and puts your LinkedIn account at risk of restriction.',
    instead:
      'Import a CSV of leads you are allowed to export (the Sales Navigator-style mapping reads it), or paste the profile URLs of the leads you chose.'
  },
  post_engagers: {
    label: 'Post likers and commenters',
    reason:
      'Trevra does not collect the people who liked or commented on a post. That requires scraping the post, which violates LinkedIn’s terms and puts your LinkedIn account at risk of restriction.',
    instead:
      'If you have identified people yourself, paste their profile URLs. You can also import a CSV you are allowed to use.'
  }
};

/**
 * Which unsupported source a requested collection kind belongs to. Every kind
 * the retired browser walker knew is one of these three; anything unknown is
 * treated as a search, which is what it would have been.
 */
export function unsupportedIntakeSourceFor(kind: unknown): UnsupportedIntakeSource {
  if (kind === 'sales_navigator') return 'sales_navigator';
  if (kind === 'post' || kind === 'content' || kind === 'post_keyword') return 'post_engagers';
  return 'linkedin_search';
}

/** The full refusal sentence the server sends and the screen renders. */
export function unsupportedIntakeMessage(source: UnsupportedIntakeSource): string {
  const copy = UNSUPPORTED_INTAKE_COPY[source];
  return `${copy.reason} ${copy.instead}`;
}

/** The response body of a refused collection request. */
export interface UnsupportedIntakeRefusal {
  error: string;
  code: typeof INTAKE_SOURCE_UNSUPPORTED;
  source: UnsupportedIntakeSource;
}

export function unsupportedIntakeRefusal(kind: unknown): UnsupportedIntakeRefusal {
  const source = unsupportedIntakeSourceFor(kind);
  return { error: unsupportedIntakeMessage(source), code: INTAKE_SOURCE_UNSUPPORTED, source };
}
