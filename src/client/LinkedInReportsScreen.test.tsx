import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OutreachAnalytics } from './LinkedInReportsScreen';

describe('OutreachAnalytics', () => {
  it('renders the shared range control with every preset and a pressed default before any read', () => {
    const html = renderToStaticMarkup(<OutreachAnalytics setToast={() => undefined} />);
    expect(html).toContain('aria-label="Date range"');
    for (const label of ['Today', 'Yesterday', '7 days', '30 days', '90 days', 'Custom'])
      expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30 days</);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('LinkedIn account');
    expect(html).toContain('Reading the outreach ledger');
  });
});
