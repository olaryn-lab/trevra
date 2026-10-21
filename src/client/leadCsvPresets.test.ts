import { describe, expect, it } from 'vitest';
import { salesNavigatorCsvMapping } from './leadCsvPresets.js';

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
