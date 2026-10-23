import { describe, expect, it } from 'vitest';
import {
  INBOX_MESSAGE_PAGE,
  inboxMessageLimitForThread,
  newestInboxMessages,
  nextInboxMessageLimit
} from './inboxMessageWindow';

const messages = Array.from({ length: 132 }, (_, i) => ({ id: 'm' + i, body: 'message ' + i }));

describe('inbox message disclosure', () => {
  it('shows only the newest 50 messages in the original chronological order', () => {
    const visible = newestInboxMessages(messages, INBOX_MESSAGE_PAGE);
    expect(visible).toHaveLength(50);
    expect(visible[0]).toBe(messages[82]);
    expect(visible.at(-1)).toBe(messages.at(-1));
  });
  it('reveals earlier pages without gaps, duplication, or rearrangement', () => {
    const first = newestInboxMessages(messages, 50);
    const second = newestInboxMessages(messages, nextInboxMessageLimit(50, messages.length));
    const all = newestInboxMessages(messages, nextInboxMessageLimit(100, messages.length));
    expect(second).toHaveLength(100);
    expect(second.slice(-50)).toEqual(first);
    expect(all).toEqual(messages);
    expect(nextInboxMessageLimit(132, 132)).toBe(132);
  });
  it('keys the expanded window by Trevra thread ID, not the shared LinkedIn URN', () => {
    expect(
      inboxMessageLimitForThread({ threadId: 'seat-a-thread', limit: 100 }, 'seat-a-thread')
    ).toBe(100);
    expect(
      inboxMessageLimitForThread({ threadId: 'seat-a-thread', limit: 100 }, 'seat-b-thread')
    ).toBe(50);
    expect(inboxMessageLimitForThread({ threadId: 'seat-a-thread', limit: 100 }, null)).toBe(50);
    expect(inboxMessageLimitForThread(null, 'seat-a-thread')).toBe(50);
  });
  it('does not hide short conversations or mis-handle empty histories', () => {
    expect(newestInboxMessages(messages.slice(0, 10), 50)).toEqual(messages.slice(0, 10));
    expect(newestInboxMessages([], 50)).toEqual([]);
    expect(newestInboxMessages(messages, 0)).toEqual([]);
    expect(newestInboxMessages(messages, Number.NaN)).toEqual([]);
  });
});
