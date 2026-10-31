import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TodayItem } from '../../server/today';
import {
  LinkedInHandoffCard,
  LinkedInHandoffCardView,
  handoffCopyLabel,
  handoffFromItem,
  sentAtIso,
  type LinkedInHandoffCardViewProps
} from './LinkedInHandoffCard';

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

/** The card as it renders once the present call stamped and returned these words. */
function shown(
  metadata: Record<string, unknown>,
  overrides: Partial<LinkedInHandoffCardViewProps> = {}
): string {
  const listed = item(metadata);
  return renderToStaticMarkup(
    <LinkedInHandoffCardView
      item={listed}
      handoff={handoffFromItem(listed)}
      refused=""
      busy={null}
      copied={false}
      problem=""
      sentAt=""
      onSentAtChange={() => undefined}
      onCopy={() => undefined}
      onAnswer={() => undefined}
      onRefresh={() => undefined}
      {...overrides}
    />
  );
}

describe('LinkedIn handoff card', () => {
  it('shows nothing to send until the present call has stamped the words', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard item={item({})} onResolved={() => undefined} />
    );
    expect(html).toContain('Send a LinkedIn message from Founder');
    expect(html).toContain('Checking this is still yours to send');
    expect(html).not.toContain('Hi Maya, thanks for connecting.');
    expect(html).not.toContain('Mark sent');
    expect(html).not.toContain('Open profile');
  });

  it('shows the presented copy, the profile link and the answers', () => {
    const html = shown({});
    expect(html).toContain('Hi Maya, thanks for connecting.');
    expect(html).toContain('href="https://www.linkedin.com/in/maya-card/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Copy message');
    expect(html).toContain('Mark sent');
    expect(html).toContain('Skip');
    expect(html).toContain('Nothing goes out from Trevra.');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('Profile unavailable');
    expect(html).toContain('LinkedIn refused it');
    expect(html.match(/primary-button/g)).toHaveLength(1);
    expect(html).not.toContain('To: ');
  });

  it('says why it will not show a handoff the present call refused, and offers a refresh', () => {
    const html = shown(
      {},
      { handoff: null, refused: 'This LinkedIn handoff is no longer waiting for you.' }
    );
    expect(html).toContain('This LinkedIn handoff is no longer waiting for you.');
    expect(html).toContain('Refresh');
    expect(html).not.toContain('Hi Maya, thanks for connecting.');
    expect(html).not.toContain('Mark sent');
  });

  it('asks about a cancelled handoff without inviting a new send', () => {
    const html = renderToStaticMarkup(
      <LinkedInHandoffCard item={item({ cancelled: true })} onResolved={() => undefined} />
    );
    expect(html).toContain('Cancelled');
    expect(html).toContain('Do not send it now.');
    expect(html).toContain('Hi Maya, thanks for connecting.');
    expect(html).toContain('Mark sent');
    expect(html).toContain('I didn&#x27;t send it');
    expect(html).not.toContain('Open profile');
    expect(html).not.toContain('Copy message');
    expect(html).not.toContain('LinkedIn refused it');
  });

  it('names the recipient by reference when there is no profile link', () => {
    const html = shown({ targetUrl: null, targetRef: 'urn:li:member:123' });
    expect(html).toContain('To: urn:li:member:123');
    expect(html).not.toContain('Open profile');
  });

  it('says an invite goes without a note when it has none, and offers nothing to copy', () => {
    const html = shown({ actionKind: 'invite', copyText: null });
    expect(html).toContain('No note: send the invite without one.');
    expect(html).not.toContain('Copy note');
    expect(handoffCopyLabel('invite')).toBe('Copy note');
  });

  it('reads only handoff items', () => {
    expect(handoffFromItem({ ...item({}), kind: 'verified_reply' })).toBeNull();
    expect(handoffFromItem(item({ actionId: '' }))).toBeNull();
    expect(handoffFromItem(item({}))).toMatchObject({
      actionId: 'lact_card',
      actionKind: 'dm',
      cancelled: false
    });
    expect(handoffFromItem(item({ cancelled: true }))).toMatchObject({ cancelled: true });
    expect(handoffFromItem(item({ targetUrl: null }))).toMatchObject({
      targetUrl: null,
      targetRef: 'maya-card'
    });
  });

  it('turns the sent-at field into an instant, or nothing', () => {
    expect(sentAtIso('')).toBeNull();
    expect(sentAtIso('not a time')).toBeNull();
    expect(sentAtIso('2026-08-04T09:30')).toBe(new Date('2026-08-04T09:30').toISOString());
  });
});
