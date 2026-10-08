import { useState, type FormEvent } from 'react';
import type { EmailChannelStatus, StoredDeliverability } from '../server/email/types';
import type { WorkspaceRole } from './auth-client';
import { ConfirmDrawer } from './ui/dialog';
import { OwnerOnlyNote } from './ui/forms';
import { Button, Field, Input } from './ui/primitives';
import { prettyProvider } from './views/format';

/** Which control is waiting on the server; every control is disabled meanwhile. */
export type EmailChannelBusy = 'recheck' | 'stop' | `inbound:${string}` | `dkim:${string}` | null;

function deliverabilityBadge(deliverability: StoredDeliverability | null): {
  label: string;
  /** The shared `.status-pill` tone modifier. */
  tone: 'ok' | 'fail' | 'muted';
} {
  if (!deliverability) return { label: 'Address unknown', tone: 'muted' };
  // A DNS check that ran out of time is "unknown" with no blockers: neutral, never a failure.
  if (deliverability.status === 'pass') return { label: 'SPF, DKIM and DMARC pass', tone: 'ok' };
  if (deliverability.status === 'fail') return { label: 'Sending blocked', tone: 'fail' };
  return { label: 'DNS check pending', tone: 'muted' };
}

function inboundSentence(inbound: EmailChannelStatus['inbound']): string {
  if (!inbound) {
    return 'No mailbox is read. Replies to outreach email stay in your inbox and never reach Conversations.';
  }
  if (inbound.syncStatus === 'syncing') {
    return `Reading ${inbound.address}. Only mail from People already in Trevra is kept; everything else is ignored.`;
  }
  if (inbound.syncStatus === 'starting') return `Starting to read ${inbound.address}.`;
  return `Trevra cannot read ${inbound.address}. ${
    inbound.syncError ?? 'The inbound-messages sync is not available on this Nango deployment.'
  }`;
}

export function EmailChannelSummary({
  channel,
  role,
  busy,
  onUseForInbound,
  onStopInbound,
  onRecheck,
  onSaveDkimSelector
}: {
  channel: EmailChannelStatus;
  /** `pending` renders neither the owner controls nor the member line. */
  role: WorkspaceRole;
  busy: EmailChannelBusy;
  onUseForInbound: (connectionId: string) => void;
  onStopInbound: () => void;
  onRecheck: () => void;
  onSaveDkimSelector: (connectionId: string, selector: string | null) => void;
}) {
  const isOwner = role === 'owner';
  const [confirmStop, setConfirmStop] = useState(false);

  function saveSelector(event: FormEvent<HTMLFormElement>, connectionId: string) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('dkimSelector') ?? '').trim();
    // Empty clears the selector and returns to the provider's standard ones.
    onSaveDkimSelector(connectionId, value || null);
  }

  const inboundMailbox = channel.mailboxes.find(
    (mailbox) => mailbox.connectionId === channel.inbound?.connectionId
  );

  return (
    <div className="email-channel">
      {channel.mailboxes.length === 0 ? (
        <p className="empty-copy">
          Connect Gmail, Microsoft 365 or Zoho Mail under Connections to send outreach email and
          read replies.
        </p>
      ) : (
        <ul className="email-channel-mailboxes">
          {channel.mailboxes.map((mailbox) => {
            const badge = deliverabilityBadge(mailbox.deliverability);
            const isInbound = channel.inbound?.connectionId === mailbox.connectionId;
            const issues = [
              ...(mailbox.deliverability?.blockers ?? []),
              ...(mailbox.deliverability?.warnings ?? [])
            ];
            const pendingDetail =
              mailbox.deliverability?.status === 'unknown' && issues.length === 0
                ? mailbox.deliverability.spf.detail
                : null;
            const domain = mailbox.address?.split('@')[1] ?? null;
            const needsSelector = (mailbox.deliverability?.blockers ?? []).some(
              (issue) => issue.code === 'email_dkim_selector_missing'
            );
            return (
              <li key={mailbox.connectionId}>
                <div className="email-channel-mailbox-head">
                  <div>
                    <strong>
                      {mailbox.address ?? mailbox.displayName ?? prettyProvider(mailbox.provider)}
                    </strong>
                    <span>
                      {prettyProvider(mailbox.provider)}
                      {isInbound ? ' · inbound mailbox' : ''}
                    </span>
                  </div>
                  <span className={`status-pill ${badge.tone}`}>{badge.label}</span>
                </div>
                {issues.length > 0 && (
                  <ul className="email-channel-issues">
                    {issues.map((issue, index) => (
                      <li key={`${issue.code}:${index}`}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {pendingDetail && <p className="email-channel-pending">{pendingDetail}</p>}
                {mailbox.unsubscribeMode === 'footer_and_reply' && (
                  <p className="email-channel-note">
                    Zoho Mail cannot add one-click unsubscribe. Outreach from this mailbox ends with
                    your footer asking people to reply “unsubscribe”
                    {mailbox.dailyCap !== null
                      ? `, and sends at most ${mailbox.dailyCap} a day`
                      : ''}
                    .
                  </p>
                )}
                {isOwner && domain && (
                  <details className="email-channel-dkim" open={needsSelector}>
                    <summary className="ui-disclosure-summary">
                      {mailbox.dkimSelector
                        ? `DKIM selector: ${mailbox.dkimSelector}`
                        : 'DKIM selector'}
                    </summary>
                    <form
                      className="email-channel-dkim-form ui-field-row"
                      onSubmit={(event) => saveSelector(event, mailbox.connectionId)}
                    >
                      <Field
                        label="DKIM selector"
                        hint={
                          mailbox.provider === 'zoho-mail'
                            ? `Zoho Mail has no standard selector; enter the one from your Zoho Mail admin console. Trevra checks <selector>._domainkey.${domain}.`
                            : `From your mail provider's DKIM settings. Trevra checks <selector>._domainkey.${domain}. Leave empty to use the provider's standard selectors.`
                        }
                      >
                        <Input
                          // Remount after a save so the field shows the stored selector.
                          key={mailbox.dkimSelector ?? ''}
                          name="dkimSelector"
                          defaultValue={mailbox.dkimSelector ?? ''}
                          placeholder="zmail"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={200}
                          disabled={busy !== null}
                        />
                      </Field>
                      <Button type="submit" disabled={busy !== null}>
                        {busy === `dkim:${mailbox.connectionId}` ? 'Saving…' : 'Save selector'}
                      </Button>
                    </form>
                  </details>
                )}
                {isOwner && !isInbound && (
                  <Button
                    disabled={busy !== null}
                    onClick={() => onUseForInbound(mailbox.connectionId)}
                  >
                    {busy === `inbound:${mailbox.connectionId}`
                      ? 'Starting…'
                      : 'Use for inbound mail'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <dl className="email-channel-facts">
        <div>
          <dt>Inbound mail</dt>
          <dd>{inboundSentence(channel.inbound)}</dd>
        </div>
        <div>
          <dt>Unsubscribe</dt>
          <dd>{channel.unsubscribe.detail}</dd>
        </div>
      </dl>
      <div className="email-channel-actions">
        <Button disabled={busy !== null || channel.mailboxes.length === 0} onClick={onRecheck}>
          {busy === 'recheck' ? 'Checking…' : 'Re-check DNS'}
        </Button>
        {isOwner && channel.inbound && (
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmStop(true)}>
              {busy === 'stop' ? 'Stopping…' : 'Stop reading mail'}
            </Button>
            {inboundMailbox?.unsubscribeMode === 'footer_and_reply' && (
              <p className="email-channel-note">
                Zoho Mail opt-outs arrive as replies. While Trevra is not reading this mailbox,
                unsubscribe replies are not recorded.
              </p>
            )}
          </>
        )}
        {role === 'member' && (
          <OwnerOnlyNote>choose the inbound mailbox or set a DKIM selector</OwnerOnlyNote>
        )}
      </div>
      {confirmStop && (
        <ConfirmDrawer
          title="Stop reading this mailbox?"
          body={
            <p>
              Replies to your outreach, including unsubscribe replies, are no longer read from{' '}
              {channel.inbound?.address ?? 'this mailbox'}. You can choose it again at any time.
            </p>
          }
          confirmLabel="Stop reading mail"
          busy={busy === 'stop'}
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            onStopInbound();
          }}
        />
      )}
    </div>
  );
}
