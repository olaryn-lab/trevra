import type { LinkedInLeadCsvPreview } from './api.js';

type Mapping = LinkedInLeadCsvPreview['mapping'];

/**
 * Preset for user-supplied lead exports with Sales Navigator-style headings.
 * Does not connect to LinkedIn or fetch/search/scrape leads.
 * Never infer a person's country from a freeform Location.
 */
export function salesNavigatorCsvMapping(headers: readonly string[]): Mapping {
  const used = new Set<string>();
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pick = (...names: string[]): string | undefined => {
    const accepted = new Set(names.map(normalized));
    const result = headers.find((header) => !used.has(header) && accepted.has(normalized(header)));
    if (result) used.add(result);
    return result;
  };
  const mapping: Mapping = {};
  const fields: ReadonlyArray<[keyof Mapping, string[]]> = [
    ['firstName', ['First Name', 'Given Name']],
    ['lastName', ['Last Name', 'Surname']],
    ['fullName', ['Name', 'Full Name', 'Lead Name', 'Contact Name']],
    ['company', ['Current Company', 'Company', 'Company Name', 'Employer', 'Account']],
    [
      'profileUrl',
      ['Profile URL', 'LinkedIn URL', 'LinkedIn Profile URL', 'Lead Profile URL', 'URL']
    ],
    ['email', ['Email', 'Email Address', 'Work Email']],
    ['phone', ['Phone', 'Phone Number']],
    ['country', ['Country']]
  ];
  for (const [field, alternatives] of fields) {
    const header = pick(...alternatives);
    if (header) mapping[field] = header;
  }
  return mapping;
}
