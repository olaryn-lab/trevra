import { describe, expect, it } from 'vitest';
import { emailSkipSummary, planIssues } from './gtmPlanFormat';

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

describe('planIssues', () => {
  it('keeps only well-formed issues with in-app links', () => {
    expect(
      planIssues([
        {
          code: 'email_replies_not_synced',
          message: 'Replies are not read.',
          actionHref: '/setup/workspace'
        },
        { code: 'email_dmarc_monitoring_only', message: 'DMARC is p=none.' },
        { code: 'offsite', message: 'Leaves the app.', actionHref: '//evil.test/x' },
        { code: 'no_message' },
        'not an issue',
        null
      ])
    ).toEqual([
      {
        code: 'email_replies_not_synced',
        message: 'Replies are not read.',
        actionHref: '/setup/workspace'
      },
      { code: 'email_dmarc_monitoring_only', message: 'DMARC is p=none.' },
      { code: 'offsite', message: 'Leaves the app.' }
    ]);
  });

  it('reads a missing or malformed value as no warnings', () => {
    expect(planIssues(undefined)).toEqual([]);
    expect(planIssues({ code: 'x', message: 'y' })).toEqual([]);
  });
});
