import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboundMilestone } from './api';
import { MilestoneSection, milestoneKindsPhrase } from './inbound-milestones';
import { AttributionTables } from './inbound-attribution';

const milestone: InboundMilestone = {
  id: 'pm_0123456789abcdef',
  workspaceId: 'ws_1',
  kind: 'paid',
  contactId: 'con_1',
  accountId: 'acc_1',
  sourceType: 'stripe_event',
  sourceId: 'evt_1',
  providerEndpointId: 'pwh_0123456789abcdef01234567',
  externalObjectId: 'cs_1',
  occurredAt: '2026-10-06T09:00:00.000Z',
  createdAt: '2026-10-06T09:00:00.000Z',
  label: 'paid',
  personName: 'Ada Lovelace',
  personEmail: 'ada@acme.test',
  accountName: 'Acme'
};

describe('inbound milestones and attribution', () => {
  it('anchors each milestone for the Today link', () => {
    const html = renderToStaticMarkup(<MilestoneSection milestones={[milestone]} />);
    expect(html).toContain('id="milestone-pm_0123456789abcdef"');
    expect(html).toContain('Acme');
    expect(html).toContain('paid');
    expect(html).toContain('Stripe');
    // Relative wording in the row; the absolute day stays on hover.
    expect(html).toContain('dateTime="2026-10-06T09:00:00.000Z"');
    expect(html).toContain('title="2026-10-06"');
  });

  it('explains how to send milestones when there are none', () => {
    const html = renderToStaticMarkup(<MilestoneSection milestones={[]} />);
    expect(html).toContain('No milestones yet');
    expect(html).toContain('crossed a usage threshold');
    expect(html).toContain('Setup → Lead capture');
    // Founder copy names outcomes, never the machine kind codes.
    expect(html).not.toContain('usage_threshold_crossed');
    expect(html).not.toContain('<code>');
    expect(milestoneKindsPhrase()).toBe(
      'signed up, activated, connected an integration, crossed a usage threshold, paid, upgraded, or cancelled'
    );
  });

  it('says it is loading, not empty, until the first read settles', () => {
    const html = renderToStaticMarkup(<MilestoneSection milestones={null} />);
    expect(html).toContain('Loading milestones…');
    expect(html).not.toContain('No milestones yet');
    const failed = renderToStaticMarkup(<MilestoneSection milestones={null} error="Nope." />);
    expect(failed).toContain('Nope.');
    expect(failed).not.toContain('Loading milestones…');
  });

  it('says a failed milestone read failed, with a retry, instead of claiming none', () => {
    const html = renderToStaticMarkup(
      <MilestoneSection
        milestones={[]}
        error="Unable to load product milestones."
        onRetry={() => undefined}
      />
    );
    expect(html).toContain('Unable to load product milestones.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).not.toContain('No milestones yet');
  });

  it('says a failed attribution read failed, with a retry, instead of vanishing', () => {
    expect(renderToStaticMarkup(<AttributionTables summary={null} />)).toBe('');
    const html = renderToStaticMarkup(
      <AttributionTables
        summary={null}
        error="Unable to load where inbound came from."
        onRetry={() => undefined}
      />
    );
    expect(html).toContain('Where inbound came from');
    expect(html).toContain('Unable to load where inbound came from.');
    expect(html).toContain('Try again');
    expect(html).not.toContain('<table');
  });

  it('renders both 90-day attribution tables with readable channel names', () => {
    const html = renderToStaticMarkup(
      <AttributionTables
        summary={{
          since: '2026-07-08T09:00:00.000Z',
          days: 90,
          byUtmSource: [
            { value: 'newsletter', submissions: 3, people: 2, peopleWithOpportunity: 1 }
          ],
          byHeardAbout: [{ value: 'podcast', submissions: 1, people: 1, peopleWithOpportunity: 1 }]
        }}
      />
    );
    expect(html).toContain('Where inbound came from (90 days)');
    expect(html).toContain('newsletter');
    expect(html).toContain('Podcast');
    expect(html).toContain('With opportunity');
  });
});
