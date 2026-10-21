import { describe, expect, it } from 'vitest';
import { safeCsvCell } from './csv.js';

describe('CSV export formula safety', () => {
  it.each([
    '=HYPERLINK("https://example.com","click")',
    '+SUM(1,2)',
    '-1+2',
    '@SUM(1,2)',
    '  =1+1',
    '\t=2+2',
    '\r@SUM(1,2)',
    '\uFEFF-2+4'
  ])('escapes an attacker-controlled cell %s', (value) => {
    const serialized = safeCsvCell(value);
    expect(serialized.replace(/^"|"$/g, '').replace(/""/g, '"')).toBe(`'${value}`);
  });

  it('preserves benign cells and correct CSV quotes', () => {
    expect(safeCsvCell('Jane')).toBe('Jane');
    expect(safeCsvCell('Jane, Doe')).toBe('"Jane, Doe"');
    expect(safeCsvCell('Jane "Jo"')).toBe('"Jane ""Jo"""');
  });
});
