import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EmailChannelStatus, StoredDeliverability } from '../server/email/types';
import { EmailChannelSummary, type EmailChannelBusy } from './EmailChannelSummary';

const noop = () => undefined;

function deliverability(overrides: Partial<StoredDeliverability> = {}): StoredDeliverability {
  const check = { status: 'pass' as const, detail: 'Published.', record: null };
  return {
    domain: 'acme.test',
    provider: 'google',
    status: 'pass',
    spf: check,
    dkim: check,
    dmarc: check,
    blockers: [],
    warnings: [],
    checkedAt: '2026-10-06T09:00:00.000Z',
    expiresAt: '2026-10-07T09:00:00.000Z',
    ...overrides
  };
}

const MAILBOX: EmailChannelStatus['mailboxes'][number] = {
  connectionId: 'conn_mail_1',
  provider: 'gmail',
  providerKey: 'google',
  displayName: null,
  address: 'founder@acme.test',
  deliverability: deliverability(),
  dkimSelector: null,
  unsubscribeMode: 'list_unsubscribe_headers',
  dailyCap: null
};

function channel(overrides: Partial<EmailChannelStatus> = {}): EmailChannelStatus {
  return {
    unsubscribe: {
      oneClick: true,
      mailto: false,
      detail: 'Every outreach email offers one-click unsubscribe.'
    },
    mailboxes: [MAILBOX],
    inbound: null,
    ...overrides
  };
}

function inbound(
  syncStatus: 'starting' | 'syncing' | 'unavailable',
  syncError: string | null = null
): NonNullable<EmailChannelStatus['inbound']> {
  return {
    connectionId: 'conn_mail_1',
    address: 'founder@acme.test',
    syncStatus,
    syncError,
    designatedAt: '2026-10-06T09:00:00.000Z',
    lastRecordAt: null,
    nango: null
  };
}

function render(
  status: EmailChannelStatus,
  options: { isOwner?: boolean; busy?: EmailChannelBusy } = {}
): string {
  return renderToStaticMarkup(
    <EmailChannelSummary
      channel={status}
      isOwner={options.isOwner ?? true}
      busy={options.busy ?? null}
      onUseForInbound={noop}
      onStopInbound={noop}
      onRecheck={noop}
      onSaveDkimSelector={noop}
    />
  );
}

describe('EmailChannelSummary', () => {
  it('shows a passing sender and offers it to the owner as the inbound mailbox', () => {
    const markup = render(channel());
    expect(markup).toContain('founder@acme.test');
    expect(markup).toContain('SPF, DKIM and DMARC pass');
    expect(markup).toContain('Use for inbound mail');
    expect(markup).toContain('No mailbox is read.');
    expect(markup).toContain('Every outreach email offers one-click unsubscribe.');
    expect(markup).toContain('Re-check DNS');
  });

  it('spells out every DNS blocker instead of only showing a badge', () => {
    const markup = render(
      channel({
        mailboxes: [
          {
            ...MAILBOX,
            deliverability: deliverability({
              status: 'fail',
              blockers: [
                {
                  code: 'email_dkim_missing',
                  message: 'No DKIM key is published for acme.test at google._domainkey.',
                  actionHref: '/setup/workspace'
                }
              ]
            })
          }
        ]
      })
    );
    expect(markup).toContain('Sending blocked');
    expect(markup).toContain('No DKIM key is published for acme.test at google._domainkey.');
  });

  it('says plainly when the inbound sync cannot run', () => {
    const markup = render(
      channel({
        inbound: inbound(
          'unavailable',
          'Nango could not start the inbound-messages sync: sync not found'
        )
      })
    );
    expect(markup).toContain('Trevra cannot read founder@acme.test.');
    expect(markup).toContain('sync not found');
    expect(markup).not.toContain('Use for inbound mail');
    expect(markup).toContain('Stop reading mail');
  });

  it('shows members the state without the owner-only controls', () => {
    const markup = render(channel({ inbound: inbound('syncing') }), { isOwner: false });
    expect(markup).toContain('Reading founder@acme.test.');
    expect(markup).not.toContain('Use for inbound mail');
    expect(markup).not.toContain('Stop reading mail');
    expect(markup).toContain('Re-check DNS');
  });

  it('tells a workspace without a mailbox how to start and disables the DNS check', () => {
    const markup = render(channel({ mailboxes: [] }));
    expect(markup).toContain('Connect Gmail, Microsoft 365 or Zoho Mail');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS<\/button>/);
  });

  it('shows a timed-out DNS check as pending, not as a failure', () => {
    const detail = 'DNS did not answer within 5s; rechecking.';
    const check = { status: 'unknown' as const, detail, record: null };
    const markup = render(
      channel({
        mailboxes: [
          {
            ...MAILBOX,
            deliverability: deliverability({
              status: 'unknown',
              spf: check,
              dkim: check,
              dmarc: check
            })
          }
        ]
      })
    );
    expect(markup).toContain('DNS check pending');
    expect(markup).toContain(detail);
    expect(markup).toContain('email-channel-pill-unknown');
    expect(markup).not.toContain('Sending blocked');
    expect(markup).not.toContain('email-channel-pill-fail');
  });

  it('shows an unknown sending address as neutral', () => {
    const markup = render(
      channel({ mailboxes: [{ ...MAILBOX, address: null, deliverability: null }] })
    );
    expect(markup).toContain('Address unknown');
    expect(markup).toContain('email-channel-pill-unknown');
    expect(markup).not.toContain('Sending blocked');
  });

  it('says the inbound sync is starting', () => {
    const markup = render(channel({ inbound: inbound('starting') }));
    expect(markup).toContain('Starting to read founder@acme.test.');
    expect(markup).toContain('Stop reading mail');
  });

  it('falls back to a fixed sentence when an unavailable sync has no error text', () => {
    const markup = render(channel({ inbound: inbound('unavailable') }));
    expect(markup).toContain('Trevra cannot read founder@acme.test.');
    expect(markup).toContain('not available on this Nango deployment');
  });

  it('shows progress on the control that is busy', () => {
    expect(render(channel(), { busy: 'recheck' })).toContain('Checking…');
    expect(render(channel(), { busy: 'inbound:conn_mail_1' })).toContain('Starting…');
  });

  it('disables sibling controls while one is busy', () => {
    const recheck = render(channel({ inbound: null }), { busy: 'recheck' });
    expect(recheck).toMatch(/<button[^>]*disabled=""[^>]*>Use for inbound mail/);
    const stop = render(channel({ inbound: inbound('syncing') }), { busy: 'stop' });
    expect(stop).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS/);
    const inboundBusy = render(channel(), { busy: 'inbound:conn_mail_1' });
    expect(inboundBusy).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS/);
  });

  const ZOHO: EmailChannelStatus['mailboxes'][number] = {
    ...MAILBOX,
    connectionId: 'conn_zoho',
    provider: 'zoho-mail',
    providerKey: 'zoho',
    unsubscribeMode: 'footer_and_reply',
    dailyCap: 50,
    deliverability: deliverability({
      provider: 'zoho',
      status: 'fail',
      dkim: { status: 'fail', detail: 'No DKIM selector is set for this domain.', record: null },
      blockers: [
        {
          code: 'email_dkim_selector_missing',
          message: 'Enter the DKIM selector from your Zoho Mail admin console.',
          actionHref: '/setup/workspace'
        }
      ]
    })
  };

  it('explains reply-to-unsubscribe and the daily cap for a Zoho Mail sender', () => {
    const markup = render(channel({ mailboxes: [ZOHO] }));
    expect(markup).toContain('Zoho Mail');
    expect(markup).toContain('Zoho Mail cannot add one-click unsubscribe.');
    expect(markup).toContain('at most 50 a day');
    expect(render(channel())).not.toContain('Zoho Mail cannot add one-click unsubscribe.');
  });

  it('opens the DKIM selector form when the check needs one, for the owner only', () => {
    const owner = render(channel({ mailboxes: [ZOHO] }));
    expect(owner).toContain('<details class="email-channel-dkim" open="">');
    expect(owner).toContain('<span class="ui-field-label">DKIM selector</span>');
    expect(owner).toMatch(/<input[^>]*name="dkimSelector"/);
    expect(owner).toMatch(/<button[^>]*type="submit"[^>]*>Save selector<\/button>/);
    expect(render(channel({ mailboxes: [ZOHO] }), { isOwner: false })).not.toContain(
      'dkimSelector'
    );
  });

  it('keeps the DKIM selector form closed when DKIM passes and shows the stored selector', () => {
    const markup = render(channel({ mailboxes: [{ ...MAILBOX, dkimSelector: 'custom2026' }] }));
    expect(markup).toContain('<details class="email-channel-dkim">');
    expect(markup).toContain('DKIM selector: custom2026');
    expect(markup).toContain('value="custom2026"');
  });

  it('tells a Zoho Mail owner the DKIM selector is required, and only Zoho Mail', () => {
    const zohoHint =
      'Zoho Mail has no standard selector; enter the one from your Zoho Mail admin console.';
    const zoho = render(channel({ mailboxes: [ZOHO] }));
    expect(zoho).toContain(zohoHint);
    expect(zoho).not.toContain('Leave empty to use the provider');
    const gmail = render(channel());
    expect(gmail).not.toContain(zohoHint);
    expect(gmail).toContain('Leave empty to use the provider&#x27;s standard selectors.');
  });

  it('warns beside Stop reading mail that a Zoho inbound mailbox records opt-outs only while read', () => {
    const note = 'Zoho Mail opt-outs arrive as replies.';
    const zoho = render(
      channel({ mailboxes: [ZOHO], inbound: { ...inbound('syncing'), connectionId: 'conn_zoho' } })
    );
    expect(zoho).toContain('Stop reading mail');
    expect(zoho).toContain(
      `${note} While Trevra is not reading this mailbox, unsubscribe replies are not recorded.`
    );
    expect(render(channel({ inbound: inbound('syncing') }))).not.toContain(note);
  });

  it('shows progress while a DKIM selector saves and disables the other controls', () => {
    const markup = render(channel(), { busy: 'dkim:conn_mail_1' });
    expect(markup).toContain('Saving…');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-check DNS/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use for inbound mail/);
  });
});
