import type { EmailChannelStatus, StoredDeliverability } from '../server/email/types';
import { Button } from './ui/primitives';
import { prettyProvider } from './views/format';

/** Which control is waiting on the server; every control is disabled meanwhile. */
export type EmailChannelBusy = 'recheck' | 'stop' | `inbound:${string}` | null;

function deliverabilityBadge(deliverability: StoredDeliverability | null): {
  label: string;
  tone: 'pass' | 'fail' | 'unknown';
} {
  if (!deliverability) return { label: 'Address unknown', tone: 'unknown' };
  // A DNS check that ran out of time is "unknown" with no blockers: neutral, never a failure.
  if (deliverability.status === 'pass') return { label: 'SPF, DKIM and DMARC pass', tone: 'pass' };
  if (deliverability.status === 'fail') return { label: 'Sending blocked', tone: 'fail' };
  return { label: 'DNS check pending', tone: 'unknown' };
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
  isOwner,
  busy,
  onUseForInbound,
  onStopInbound,
  onRecheck
}: {
  channel: EmailChannelStatus;
  isOwner: boolean;
  busy: EmailChannelBusy;
  onUseForInbound: (connectionId: string) => void;
  onStopInbound: () => void;
  onRecheck: () => void;
}) {
  return (
    <div className="email-channel">
      {channel.mailboxes.length === 0 ? (
        <p className="empty-copy">
          Connect Gmail or Microsoft 365 above to send outreach email and read replies.
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
                  <span className={`status-pill email-channel-pill-${badge.tone}`}>
                    {badge.label}
                  </span>
                </div>
                {issues.length > 0 && (
                  <ul className="email-channel-issues">
                    {issues.map((issue, index) => (
                      <li key={`${issue.code}:${index}`}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {pendingDetail && <p className="email-channel-pending">{pendingDetail}</p>}
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
          <Button variant="ghost" disabled={busy !== null} onClick={onStopInbound}>
            {busy === 'stop' ? 'Stopping…' : 'Stop reading mail'}
          </Button>
        )}
      </div>
    </div>
  );
}
