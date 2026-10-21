import { describe, expect, it } from 'vitest';
import { mergeInboxSearchPage } from './inboxSearchPages.js';

const a = { threadUrn: 'a', name: 'Alice' };
const b = { threadUrn: 'b', name: 'Bob' };
const c = { threadUrn: 'c', name: 'Casey' };

describe('inbox search pagination', () => {
  it('replaces stale results on a new search or filter', () => {
    expect(mergeInboxSearchPage([a, b], [c], 0)).toEqual([c]);
  });
  it('appends a genuinely new offset page in order', () => {
    expect(mergeInboxSearchPage([a], [b, c], 1)).toEqual([a, b, c]);
  });
  it('does not duplicate threads on refresh and keeps the newest data', () => {
    expect(mergeInboxSearchPage([a, b], [{ ...b, name: 'Updated Bob' }, c], 1)).toEqual([
      a,
      { ...b, name: 'Updated Bob' },
      c
    ]);
    expect(mergeInboxSearchPage([a, b], [a, b], 1)).toEqual([a, b]);
  });
});
