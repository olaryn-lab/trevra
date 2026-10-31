import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnsupportedIntakeSources } from './LeadIntakeSources';
import {
  INTAKE_SOURCE_UNSUPPORTED,
  UNSUPPORTED_INTAKE_COPY,
  unsupportedIntakeRefusal,
  unsupportedIntakeSourceFor
} from '../shared/lead-intake';

const noop = () => undefined;

describe('unsupported intake sources (TRV-021/022/023)', () => {
  it('explains, in product language, why search, Sales Navigator and post engagers are refused', () => {
    const html = renderToStaticMarkup(
      <UnsupportedIntakeSources onImportCsv={noop} onPasteUrls={noop} />
    );
    expect(html).toContain('LinkedIn search, Sales Navigator and post engagers are not supported');
    expect(html).toContain('Trevra does not scrape LinkedIn');
    expect(html).toContain('violates LinkedIn’s terms');
    expect(html).toContain('at risk of restriction');
    for (const copy of Object.values(UNSUPPORTED_INTAKE_COPY)) {
      expect(html).toContain(copy.label);
      expect(html).toContain(copy.reason);
    }
    expect(html.match(/Not supported</g)).toHaveLength(3);
    expect(html).toContain('Post likers and commenters');
    expect(html).toContain('paste their profile URLs');
  });

  it('offers the supported paths as real buttons, one primary', () => {
    const html = renderToStaticMarkup(
      <UnsupportedIntakeSources onImportCsv={noop} onPasteUrls={noop} />
    );
    expect(html).toMatch(/<button[^>]*primary-button[^>]*>.*Import a CSV<\/button>/);
    expect(html).toMatch(/<button[^>]*secondary-button[^>]*>.*Paste profile URLs<\/button>/);
    expect(html.match(/primary-button/g)).toHaveLength(1);
    expect(html).not.toMatch(/style=/);
    // No CRM import is offered: Trevra has none.
    expect(html).not.toMatch(/CRM/);
  });

  it('puts the source a deep link asked for first and offers its URL only as a link out', () => {
    const html = renderToStaticMarkup(
      <UnsupportedIntakeSources
        requested="sales_navigator"
        requestedUrl="https://www.linkedin.com/sales/search/people?query=x"
        onImportCsv={noop}
        onPasteUrls={noop}
      />
    );
    const first = html.indexOf('<div class="is-requested">');
    expect(first).toBeGreaterThan(-1);
    expect(html.indexOf('<dt>Sales Navigator')).toBe(first + '<div class="is-requested">'.length);
    expect(html.indexOf('<dt>Sales Navigator')).toBeLessThan(
      html.indexOf('<dt>LinkedIn people search')
    );
    expect(html.match(/is-requested/g)).toHaveLength(1);
    expect(html).toContain('href="https://www.linkedin.com/sales/search/people?query=x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('maps every legacy collection kind to one refusal with the stable code', () => {
    expect(unsupportedIntakeSourceFor('search')).toBe('linkedin_search');
    expect(unsupportedIntakeSourceFor('company_employees')).toBe('linkedin_search');
    expect(unsupportedIntakeSourceFor('sales_navigator')).toBe('sales_navigator');
    expect(unsupportedIntakeSourceFor('post')).toBe('post_engagers');
    expect(unsupportedIntakeSourceFor('content')).toBe('post_engagers');
    expect(unsupportedIntakeRefusal('post')).toEqual({
      code: INTAKE_SOURCE_UNSUPPORTED,
      source: 'post_engagers',
      error: `${UNSUPPORTED_INTAKE_COPY.post_engagers.reason} ${UNSUPPORTED_INTAKE_COPY.post_engagers.instead}`
    });
  });

  it('leaves no client call that queues a lead source', () => {
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    const leads = readFileSync(new URL('./LinkedInLeads.tsx', import.meta.url), 'utf8');
    expect(api).not.toMatch(/createLinkedInLeadSource/);
    expect(api).not.toMatch(/'\/api\/linkedin\/lead-sources',\s*\{\s*method:\s*'POST'/);
    expect(leads).not.toMatch(/createLinkedInLeadSource|Queue search|searchUrlForKeywords/);
  });
});
