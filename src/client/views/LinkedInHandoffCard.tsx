import { useState } from 'react';
import { Send } from 'lucide-react';
import type { TodayItem } from '../../server/today';
import { resolveLinkedInHandoff } from '../api';
import { errorMessage } from '../LinkedInSafety';
import { Button } from '../ui/primitives';

export interface LinkedInHandoffView {
  actionId: string;
  actionKind: string;
  copyText: string | null;
  subject: string | null;
  targetUrl: string | null;
  targetRef: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The handoff off a Today item, or null when the item is not one. */
export function handoffFromItem(item: TodayItem): LinkedInHandoffView | null {
  if (item.kind !== 'linkedin_handoff_waiting') return null;
  const actionId = text(item.metadata.actionId);
  if (!actionId) return null;
  return {
    actionId,
    actionKind: text(item.metadata.actionKind) ?? 'dm',
    copyText: text(item.metadata.copyText),
    subject: text(item.metadata.subject),
    targetUrl: text(item.metadata.targetUrl),
    targetRef: text(item.metadata.targetRef)
  };
}

export function handoffCopyLabel(kind: string): string {
  return kind === 'invite' ? 'Copy note' : 'Copy message';
}

/**
 * One human-send handoff in Today. Trevra drafted it, the approval covered
 * these exact bytes, and the safety gate passed it; the founder sends it on
 * LinkedIn and reports back. "Mark sent" is the one primary action.
 */
export function LinkedInHandoffCard({
  item,
  onResolved
}: {
  item: TodayItem;
  onResolved: () => void;
}) {
  const handoff = handoffFromItem(item);
  const [busy, setBusy] = useState<'sent' | 'skip' | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  if (!handoff) return null;

  const copy = async () => {
    if (!handoff.copyText) return;
    setProblem('');
    try {
      await navigator.clipboard.writeText(handoff.copyText);
      setCopied(true);
    } catch {
      setProblem('The browser blocked copying. Select the text above and copy it yourself.');
    }
  };

  const resolve = async (resolution: 'sent' | 'skip') => {
    setBusy(resolution);
    setProblem('');
    try {
      await resolveLinkedInHandoff(handoff.actionId, resolution);
      onResolved();
    } catch (error) {
      setProblem(
        errorMessage(
          error,
          resolution === 'sent'
            ? 'Trevra could not record this as sent, so the limits do not count it yet. Try again.'
            : 'Trevra could not skip this. It is still waiting for you.'
        )
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="today-item-expanded">
      <Send size={19} />
      <div>
        <strong>{item.title}</strong>
        <small>{item.detail}</small>
      </div>
      <span className="status-pill">You send</span>
      <div className="today-action-review">
        <div className="today-action-review-head">
          <div>
            <strong>{handoff.actionKind === 'invite' ? 'Invite note' : 'Message'}</strong>
            <small>
              Nothing goes out from Trevra. You send this on LinkedIn, then tell Trevra.
            </small>
            {!handoff.targetUrl && handoff.targetRef && <small>To: {handoff.targetRef}</small>}
          </div>
          {handoff.targetUrl && (
            <a
              className="ui-button secondary-button"
              href={handoff.targetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open profile
            </a>
          )}
        </div>
        {handoff.subject && (
          <dl>
            <div>
              <dt>Subject</dt>
              <dd>{handoff.subject}</dd>
            </div>
          </dl>
        )}
        {handoff.copyText ? (
          <pre>{handoff.copyText}</pre>
        ) : (
          <p className="li-hint">No note: send the invite without one.</p>
        )}
        {problem && (
          <div className="error-banner" role="alert">
            {problem}
          </div>
        )}
        <div className="today-action-review-actions">
          {handoff.copyText && (
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : handoffCopyLabel(handoff.actionKind)}
            </Button>
          )}
          <Button variant="secondary" disabled={busy !== null} onClick={() => void resolve('skip')}>
            {busy === 'skip' ? 'Skipping…' : 'Skip'}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void resolve('sent')}>
            {busy === 'sent' ? 'Recording…' : 'Mark sent'}
          </Button>
        </div>
      </div>
    </li>
  );
}
