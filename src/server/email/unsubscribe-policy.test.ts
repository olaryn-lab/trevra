import { describe, expect, it } from 'vitest';
import { OUTREACH_OPT_OUT_SENTENCE } from './compliance.js';
import {
  OUTREACH_REPLY_OPT_OUT_SENTENCE,
  UnsubscribePolicyError,
  assertUnsubscribeModeAllowed,
  footerForUnsubscribeMode,
  outreachUnsubscribeModeFor,
  parseOutreachUnsubscribeMode
} from './unsubscribe-policy.js';
import type { OutreachUnsubscribeMode } from './types.js';

const ADDRESS = 'Acme Labs Ltd, 1 Market Street, London EC1A 1AA';
const FOOTER = `${ADDRESS}\n${OUTREACH_OPT_OUT_SENTENCE}`;

describe('outreach unsubscribe policy', () => {
  it('keeps one-click headers for Google and Microsoft and allows reply-only for Zoho alone', () => {
    expect(outreachUnsubscribeModeFor('google')).toBe('list_unsubscribe_headers');
    expect(outreachUnsubscribeModeFor('microsoft')).toBe('list_unsubscribe_headers');
    expect(outreachUnsubscribeModeFor('zoho')).toBe('footer_and_reply');
  });

  it('parses only the two known modes', () => {
    expect(parseOutreachUnsubscribeMode('footer_and_reply')).toBe('footer_and_reply');
    expect(parseOutreachUnsubscribeMode('list_unsubscribe_headers')).toBe(
      'list_unsubscribe_headers'
    );
    for (const value of [undefined, null, '', 'FOOTER_AND_REPLY', 'none', 1, {}]) {
      expect(parseOutreachUnsubscribeMode(value)).toBeNull();
    }
  });

  it('swaps the opt-out sentence for the reply sentence only when it appears exactly once', () => {
    expect(footerForUnsubscribeMode(FOOTER, 'list_unsubscribe_headers')).toBe(FOOTER);
    expect(footerForUnsubscribeMode(FOOTER, 'footer_and_reply')).toBe(
      `${ADDRESS}\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`
    );
    expect(OUTREACH_REPLY_OPT_OUT_SENTENCE.toLowerCase()).toContain('reply');
    expect(OUTREACH_REPLY_OPT_OUT_SENTENCE.toLowerCase()).toContain('unsubscribe');
    expect(footerForUnsubscribeMode(ADDRESS, 'footer_and_reply')).toBeNull();
    expect(
      footerForUnsubscribeMode(`${FOOTER}\n${OUTREACH_OPT_OUT_SENTENCE}`, 'footer_and_reply')
    ).toBeNull();
  });

  const cases: Array<
    [string, 'outreach' | 'reply' | 'other', boolean, OutreachUnsubscribeMode | null, RegExp | null]
  > = [
    // Gmail and Microsoft 365: unchanged, the header stays required for Phase D outreach.
    ['gmail', 'outreach', true, 'list_unsubscribe_headers', null],
    ['gmail', 'outreach', true, null, null], // a gtm.email-outreach@1.0.0 run
    ['gmail', 'outreach', false, null, null], // campaign and legacy sends
    ['microsoft', 'outreach', true, 'list_unsubscribe_headers', null],
    ['gmail', 'outreach', false, 'footer_and_reply', /only for Zoho Mail/],
    ['microsoft', 'outreach', true, 'footer_and_reply', /only for Zoho Mail/],
    ['gmail', 'outreach', false, 'list_unsubscribe_headers', /was not approved with it/],
    ['zoho', 'outreach', false, 'footer_and_reply', /only for Zoho Mail/],
    ['smtp', 'outreach', false, 'footer_and_reply', /only for Zoho Mail/],
    // Zoho Mail: the one exception, and only for outreach approved in footer_and_reply.
    ['zoho-mail', 'outreach', false, 'footer_and_reply', null],
    ['zoho-mail', 'outreach', true, 'list_unsubscribe_headers', /cannot send the one-click/],
    ['zoho-mail', 'outreach', true, 'footer_and_reply', /cannot send the one-click/],
    ['zoho-mail', 'outreach', false, null, /not approved for Zoho Mail/],
    ['zoho-mail', 'outreach', false, 'list_unsubscribe_headers', /not approved for Zoho Mail/],
    ['zoho-mail', 'reply', false, null, /only approved outreach/],
    ['zoho-mail', 'other', false, 'footer_and_reply', /only approved outreach/]
  ];

  it.each(cases)(
    '%s %s requireListUnsubscribe=%s mode=%s',
    (provider, purpose, requireListUnsubscribe, unsubscribeMode, refusal) => {
      const check = () =>
        assertUnsubscribeModeAllowed({
          provider,
          purpose,
          requireListUnsubscribe,
          unsubscribeMode
        });
      if (!refusal) {
        expect(check).not.toThrow();
        return;
      }
      expect(check).toThrow(refusal);
      try {
        check();
      } catch (error) {
        expect(error).toBeInstanceOf(UnsubscribePolicyError);
        expect((error as UnsubscribePolicyError).status).toBe(409);
        expect((error as Error).message).toContain('nothing was sent');
      }
    }
  );
});
