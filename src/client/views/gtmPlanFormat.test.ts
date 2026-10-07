import { describe, expect, it } from 'vitest';
import { emailSkipSummary } from './gtmPlanFormat';

describe('emailSkipSummary', () => {
  it('says nothing when nobody was skipped', () => {
    expect(emailSkipSummary([])).toBe('');
  });

  it('counts skipped People by reason in a fixed order', () => {
    expect(
      emailSkipSummary([
        { contactId: 'a', reason: 'already_contacted' },
        { contactId: 'b', reason: 'no_email' },
        { contactId: 'c', reason: 'no_email' },
        { contactId: 'd', reason: 'suppressed' }
      ])
    ).toBe(
      'Skipped 4: 2 without an email address, 1 unsubscribed or suppressed, 1 already emailed.'
    );
  });
});
