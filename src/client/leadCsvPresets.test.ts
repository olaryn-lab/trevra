import { describe, expect, it } from 'vitest';
import {
  LEAD_CSV_PRESETS,
  detectLeadCsvPreset,
  genericLinkedInListCsvMapping,
  leadCsvPreset,
  linkedInConnectionsCsvMapping,
  salesNavigatorCsvMapping
} from './leadCsvPresets.js';

const CONNECTIONS_HEADERS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On'
];

describe('LinkedIn connections export preset (TRV-021)', () => {
  it('maps every Connections.csv column the importer can store', () => {
    expect(linkedInConnectionsCsvMapping(CONNECTIONS_HEADERS)).toEqual({
      firstName: 'First Name',
      lastName: 'Last Name',
      company: 'Company',
      title: 'Position',
      email: 'Email Address',
      profileUrl: 'URL'
    });
  });

  it('is detected from the export header and from nothing looser', () => {
    expect(detectLeadCsvPreset(CONNECTIONS_HEADERS)).toBe('linkedin_connections');
    expect(
      detectLeadCsvPreset([' first name ', 'LAST NAME', 'company', 'position', 'Connected On'])
    ).toBe('linkedin_connections');
    expect(detectLeadCsvPreset(['First Name', 'Last Name', 'Company', 'Email'])).toBeNull();
    expect(detectLeadCsvPreset(['Notes:'])).toBeNull();
  });

  it('only pre-fills: the operator can override any preset column', () => {
    const preset = leadCsvPreset('linkedin_connections')!;
    const prefilled = preset.map(CONNECTIONS_HEADERS);
    // The screen keeps the preset as overrides; a change replaces one field and
    // leaves the rest, and an explicit '' means "not imported".
    const edited = { ...prefilled, title: 'Connected On', email: '' };
    expect(edited).toMatchObject({ firstName: 'First Name', title: 'Connected On', email: '' });
    expect(prefilled.title).toBe('Position');
    expect(preset.listKind).toBe('csv');
  });
});

describe('generic LinkedIn list export preset (TRV-021)', () => {
  it('matches common aliases for profile URL, name, company, title and email', () => {
    expect(
      genericLinkedInListCsvMapping([
        'Person Linkedin Url',
        'Full Name',
        'Company Name',
        'Job Title',
        'Work Email',
        'Notes'
      ])
    ).toEqual({
      profileUrl: 'Person Linkedin Url',
      fullName: 'Full Name',
      company: 'Company Name',
      title: 'Job Title',
      email: 'Work Email'
    });
    expect(
      genericLinkedInListCsvMapping([
        'linkedin_profile',
        'firstname',
        'lastname',
        'organisation',
        'position',
        'email_address'
      ])
    ).toEqual({
      profileUrl: 'linkedin_profile',
      firstName: 'firstname',
      lastName: 'lastname',
      company: 'organisation',
      title: 'position',
      email: 'email_address'
    });
  });

  it('prefers the more specific alias and never gives one column to two fields', () => {
    const mapping = genericLinkedInListCsvMapping(['Name', 'Full Name', 'URL', 'LinkedIn URL']);
    expect(mapping).toEqual({ fullName: 'Full Name', profileUrl: 'LinkedIn URL' });
    const values = Object.values(mapping);
    expect(new Set(values).size).toBe(values.length);
  });

  it('offers exactly the three presets, none of which connects to LinkedIn', () => {
    expect(LEAD_CSV_PRESETS.map((preset) => preset.label)).toEqual([
      'LinkedIn connections export',
      'Generic LinkedIn list export',
      'Sales Navigator-style CSV'
    ]);
  });
});

describe('Sales Navigator-style user CSV preset', () => {
  it('maps a combined-name prospect export without treating Title or Location as a company or country', () => {
    expect(
      salesNavigatorCsvMapping([
        'Name',
        'Current Company',
        'Title',
        'Location',
        'Profile URL',
        'Email Address'
      ])
    ).toEqual({
      fullName: 'Name',
      company: 'Current Company',
      profileUrl: 'Profile URL',
      email: 'Email Address'
    });
  });
  it('prefers independently identified first and last columns when available', () => {
    expect(
      salesNavigatorCsvMapping(['Given Name', 'Surname', 'Company Name', 'LinkedIn URL'])
    ).toMatchObject({
      firstName: 'Given Name',
      lastName: 'Surname',
      company: 'Company Name',
      profileUrl: 'LinkedIn URL'
    });
  });
  it('leaves unknown headings unmapped instead of guessing user-controlled identity', () => {
    expect(salesNavigatorCsvMapping(['Employer Notes', 'Position', 'Residence'])).toEqual({});
  });
});
