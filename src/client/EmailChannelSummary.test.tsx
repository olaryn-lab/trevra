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
  dkimSelector: null
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
    expect(markup).toContain('Connect Gmail or Microsoft 365');
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
});
