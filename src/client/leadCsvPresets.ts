import type { LinkedInLeadCsvPreview } from './api.js';
import { isLinkedInConnectionsHeader } from '../shared/lead-csv-header.js';

type Mapping = LinkedInLeadCsvPreview['mapping'];
type Field = keyof Mapping;

/**
 * CSV mapping presets. A preset ONLY PRE-FILLS the column mapping: the screen
 * still shows every field and the operator can change any of them before
 * importing, and the server applies the same validation, dedupe, exclusions
 * and caps whichever preset (or none) chose the columns. None of them connects
 * to LinkedIn or fetches, searches or scrapes anything -- they read a file the
 * operator already has.
 */

const headerKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Each field takes the first header matching one of its aliases, tried in the
 * alias order given (so "Full Name" beats "Name" when both exist), and a header
 * is never given to two fields. Unknown headings stay unmapped.
 */
function mapByAliases(
  headers: readonly string[],
  fields: ReadonlyArray<readonly [Field, readonly string[]]>
): Mapping {
  const used = new Set<string>();
  const mapping: Mapping = {};
  for (const [field, aliases] of fields) {
    for (const alias of aliases) {
      const key = headerKey(alias);
      const header = headers.find(
        (candidate) => !used.has(candidate) && headerKey(candidate) === key
      );
      if (header) {
        mapping[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return mapping;
}

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

/**
 * LinkedIn's own Connections.csv (Settings → Data privacy → Get a copy of
 * your data). The "Notes:" lines above its header are skipped by the parser,
 * on the server and in the local sample, before this sees the headings.
 */
export function linkedInConnectionsCsvMapping(headers: readonly string[]): Mapping {
  return mapByAliases(headers, [
    ['firstName', ['First Name']],
    ['lastName', ['Last Name']],
    ['company', ['Company']],
    ['title', ['Position']],
    ['email', ['Email Address']],
    ['profileUrl', ['URL', 'Profile URL']]
  ]);
}

/** A list exported from a LinkedIn-adjacent tool, matched by common column names. */
export function genericLinkedInListCsvMapping(headers: readonly string[]): Mapping {
  return mapByAliases(headers, [
    [
      'profileUrl',
      [
        'Profile URL',
        'LinkedIn URL',
        'LinkedIn Profile',
        'LinkedIn Profile URL',
        'Person LinkedIn URL',
        'Person LinkedIn Profile URL',
        'LinkedIn',
        'LinkedIn Link',
        'Profile Link',
        'URL'
      ]
    ],
    ['firstName', ['First Name', 'Firstname', 'Given Name']],
    ['lastName', ['Last Name', 'Lastname', 'Surname', 'Family Name']],
    ['fullName', ['Full Name', 'Name', 'Person Name', 'Lead Name', 'Contact Name']],
    [
      'company',
      [
        'Company',
        'Company Name',
        'Current Company',
        'Organization',
        'Organisation',
        'Employer',
        'Account Name'
      ]
    ],
    ['title', ['Title', 'Job Title', 'Position', 'Current Title', 'Current Position']],
    ['email', ['Email', 'Email Address', 'Work Email', 'Business Email']],
    ['phone', ['Phone', 'Phone Number', 'Mobile', 'Mobile Phone']],
    ['country', ['Country']]
  ]);
}

export type LeadCsvPresetId = 'linkedin_connections' | 'linkedin_generic' | 'sales_navigator';

export interface LeadCsvPreset {
  id: LeadCsvPresetId;
  label: string;
  hint: string;
  /** The kind of lead list an import under this preset creates. */
  listKind: 'csv' | 'sales_navigator';
  map: (headers: readonly string[]) => Mapping;
}

export const LEAD_CSV_PRESETS: readonly LeadCsvPreset[] = [
  {
    id: 'linkedin_connections',
    label: 'LinkedIn connections export',
    hint: 'Connections.csv from LinkedIn’s “Get a copy of your data”. The Notes lines above the header are skipped; First Name, Last Name, Company, Position, Email Address and URL are mapped.',
    listKind: 'csv',
    map: linkedInConnectionsCsvMapping
  },
  {
    id: 'linkedin_generic',
    label: 'Generic LinkedIn list export',
    hint: 'Matches common column names such as LinkedIn URL, Full name, Company name, Job title and Work email.',
    listKind: 'csv',
    map: genericLinkedInListCsvMapping
  },
  {
    id: 'sales_navigator',
    label: 'Sales Navigator-style CSV',
    hint: 'For a lead CSV you already have permission to export or use: Name, Current Company, profile URL and contact columns.',
    listKind: 'sales_navigator',
    map: salesNavigatorCsvMapping
  }
];

export function leadCsvPreset(id: string): LeadCsvPreset | undefined {
  return LEAD_CSV_PRESETS.find((preset) => preset.id === id);
}

/** The preset a file's own headings identify, if any. Only the Connections export is unambiguous. */
export function detectLeadCsvPreset(headers: readonly string[]): LeadCsvPresetId | null {
  return isLinkedInConnectionsHeader(headers) ? 'linkedin_connections' : null;
}
