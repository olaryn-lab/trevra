import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import type { EmailChannelStatus } from '../server/email/types';
import { chooseInboundMailbox, getEmailChannel, recheckEmailDns, stopInboundMailbox } from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { EmailChannelSummary, type EmailChannelBusy } from './EmailChannelSummary';
import { Panel } from './ui/layout';

function problemText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function EmailChannelPanel({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [channel, setChannel] = useState<EmailChannelStatus | null>(null);
  const [busy, setBusy] = useState<EmailChannelBusy>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    getEmailChannel()
      .then((next) => {
        if (!cancelled) setChannel(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(problemText(error, 'The email channel could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (next: EmailChannelBusy, work: () => Promise<EmailChannelStatus>, done: string) => {
      setBusy(next);
      setProblem('');
      try {
        setChannel(await work());
        setToast(done);
      } catch (error) {
        setProblem(problemText(error, 'Nothing was changed.'));
      } finally {
        setBusy(null);
      }
    },
    [setToast]
  );

  return (
    <Panel
      title="Email"
      icon={<Mail size={18} />}
      description="Sending-domain checks, one-click unsubscribe, and the one mailbox Trevra reads."
    >
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {channel ? (
        <EmailChannelSummary
          channel={channel}
          isOwner={isOwner}
          busy={busy}
          onUseForInbound={(connectionId) =>
            void run(
              `inbound:${connectionId}`,
              () => chooseInboundMailbox(connectionId),
              'Inbound mailbox updated'
            )
          }
          onStopInbound={() =>
            void run('stop', stopInboundMailbox, 'Trevra stopped reading the mailbox')
          }
          onRecheck={() => void run('recheck', recheckEmailDns, 'DNS checked again')}
        />
      ) : problem ? null : (
        <p className="empty-copy">Checking your mailboxes…</p>
      )}
    </Panel>
  );
}
