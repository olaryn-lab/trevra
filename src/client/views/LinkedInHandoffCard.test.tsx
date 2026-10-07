import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TodayItem } from '../../server/today';
import { LinkedInHandoffCard, handoffCopyLabel, handoffFromItem } from './LinkedInHandoffCard';

function item(metadata: Record<string, unknown>): TodayItem {
  return {
    id: 'linkedin_handoff:lact_card',
    kind: 'linkedin_handoff_waiting',
    priority: 42,
    title: 'Send a LinkedIn message from Founder',
    detail: 'Trevra checked this against the account limits.',
    href: '/outreach',
    observedAt: '2026-08-04T09:59:00.000Z',
    reference: { type: 'linkedin_action', id: 'lact_card' },
    metadata: {
      actionId: 'lact_card',
      actionKind: 'dm',
      seatKey: 'owner',
      copyText: 'Hi Maya, thanks for connecting.',
      subject: null,
      targetUrl: 'https://www.linkedin.com/in/maya-card/',
      targetRef: 'maya-card',
      campaignName: null,
      channel: 'linkedin',
      ...metadata
    }
  };
}

describe('LinkedIn handoff card', () => {
  it('shows the approved copy, the profile link and the two answers', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard item={item({})} onResolved={() => undefined} />
    );
    expect(html).toContain('Send a LinkedIn message from Founder');
    expect(html).toContain('Hi Maya, thanks for connecting.');
    expect(html).toContain('href="https://www.linkedin.com/in/maya-card/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Copy message');
    expect(html).toContain('Mark sent');
    expect(html).toContain('Skip');
    expect(html).toContain('Nothing goes out from Trevra.');
    expect(html).not.toContain('To: ');
  });

  it('names the recipient by reference when there is no profile link', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard
        item={item({ targetUrl: null, targetRef: 'urn:li:member:123' })}
        onResolved={() => undefined}
      />
    );
    expect(html).toContain('To: urn:li:member:123');
    expect(html).not.toContain('Open profile');
  });

  it('says an invite goes without a note when it has none, and offers nothing to copy', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard
        item={item({ actionKind: 'invite', copyText: null })}
        onResolved={() => undefined}
      />
    );
    expect(html).toContain('No note: send the invite without one.');
    expect(html).not.toContain('Copy note');
    expect(handoffCopyLabel('invite')).toBe('Copy note');
  });

  it('reads only handoff items', () => {
    expect(handoffFromItem({ ...item({}), kind: 'verified_reply' })).toBeNull();
    expect(handoffFromItem(item({ actionId: '' }))).toBeNull();
    expect(handoffFromItem(item({}))).toMatchObject({ actionId: 'lact_card', actionKind: 'dm' });
    expect(handoffFromItem(item({ targetUrl: null }))).toMatchObject({
      targetUrl: null,
      targetRef: 'maya-card'
    });
  });
});
