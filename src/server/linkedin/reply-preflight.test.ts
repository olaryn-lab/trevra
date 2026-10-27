import { describe, expect, it, vi } from 'vitest';
import { createLinkedInReplyPreflight, needsLinkedInReplyPreflight } from './reply-preflight';
import type { DueLinkedInAction } from './local-worker';

const followup = {
  kind: 'dm',
  campaignId: 'campaign-1',
  targetRef: 'https://www.linkedin.com/in/test-prospect/',
  manual: false,
  replyToInbound: false
} as const satisfies Pick<
  DueLinkedInAction,
  'kind' | 'campaignId' | 'targetRef' | 'manual' | 'replyToInbound'
>;

describe('managed follow-up reply preflight', () => {
  it('leaves invitations, passive actions and explicit manual messages alone', () => {
    expect(needsLinkedInReplyPreflight({ ...followup, kind: 'invite' })).toBe(false);
    expect(needsLinkedInReplyPreflight({ ...followup, kind: 'profile_view' })).toBe(false);
    expect(needsLinkedInReplyPreflight({ ...followup, campaignId: null })).toBe(false);
    expect(needsLinkedInReplyPreflight({ ...followup, manual: true })).toBe(false);
    expect(needsLinkedInReplyPreflight({ ...followup, kind: 'reply', replyToInbound: true })).toBe(
      false
    );
    expect(needsLinkedInReplyPreflight({ ...followup, kind: 'inmail' })).toBe(true);
    expect(needsLinkedInReplyPreflight({ ...followup, kind: 'reply' })).toBe(true);
  });

  it('checks at most once per 15 minutes within a sitting, then refreshes', async () => {
    let clock = 10_000;
    const readInbox = vi.fn(async () => ({ blocked: null, degraded: [] }));
    const verify = createLinkedInReplyPreflight(readInbox, { now: () => new Date(clock) });
    await verify(followup);
    await verify(followup);
    expect(readInbox).toHaveBeenCalledTimes(1);
    clock += 15 * 60_000 + 1;
    await verify(followup);
    expect(readInbox).toHaveBeenCalledTimes(2);
    // Freshness belongs to each prospect, not the whole seat.
    await verify({ ...followup, targetRef: 'https://www.linkedin.com/in/other/' });
    expect(readInbox).toHaveBeenCalledTimes(3);
  });

  it('does not cache blocked or unreadable inbox evidence as a successful read', async () => {
    const readInbox = vi
      .fn()
      .mockResolvedValueOnce({ blocked: 'account mismatch', degraded: [] })
      .mockResolvedValueOnce({
        blocked: null,
        degraded: ['Conversation thread42 could not be read (selector_drift): unavailable']
      })
      .mockResolvedValueOnce({ blocked: null, degraded: [] });
    const verify = createLinkedInReplyPreflight(readInbox);
    await expect(verify(followup)).rejects.toThrow('blocked');
    await expect(verify(followup)).rejects.toThrow('could not be verified');
    await expect(verify(followup)).resolves.toBeUndefined();
    expect(readInbox).toHaveBeenCalledTimes(3);
  });

  it('ignores transcript metadata-linkage warnings rather than blocking all sending', async () => {
    const verify = createLinkedInReplyPreflight(async () => ({
      blocked: null,
      degraded: ['Profile URL missing for conversation']
    }));
    await expect(verify(followup)).resolves.toBeUndefined();
  });

  it('fails closed on a thrown browser/network error and does not expose sensitive detail', async () => {
    const verify = createLinkedInReplyPreflight(async () => {
      throw new Error('secret bearer token');
    });
    await expect(verify(followup)).rejects.not.toThrow('secret');
    await expect(verify(followup)).rejects.toThrow('remain queued');
  });
});
