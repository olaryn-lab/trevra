import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import type { TodayItem } from '../../server/today';
import {
  presentLinkedInHandoff,
  resolveLinkedInHandoff,
  type LinkedInHandoffFailure
} from '../api';
import { errorMessage } from '../LinkedInSafety';
import { Button, Field, Input } from '../ui/primitives';

export interface LinkedInHandoffView {
  actionId: string;
  actionKind: string;
  copyText: string | null;
  subject: string | null;
  targetUrl: string | null;
  targetRef: string | null;
  /** Presented, then cancelled by Trevra before it was answered. */
  cancelled: boolean;
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
    targetRef: text(item.metadata.targetRef),
    cancelled: item.metadata.cancelled === true
  };
}

export function handoffCopyLabel(kind: string): string {
  return kind === 'invite' ? 'Copy note' : 'Copy message';
}

/** A `datetime-local` value as an ISO instant, or null when it is empty or unreadable. */
export function sentAtIso(value: string): string | null {
  if (!value.trim()) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export type HandoffAnswer =
  | { resolution: 'sent' }
  | { resolution: 'skip' }
  | { resolution: 'failed'; failure: LinkedInHandoffFailure };

export interface LinkedInHandoffCardViewProps {
  item: TodayItem;
  /**
   * What to show. For a waiting handoff these are the words AS STAMPED by the
   * present call, and null until it answers: unstamped words are never shown,
   * because an edit could still change them.
   */
  handoff: LinkedInHandoffView | null;
  /** Why the present call refused, when it did. */
  refused: string;
  busy: HandoffAnswer['resolution'] | null;
  copied: boolean;
  problem: string;
  sentAt: string;
  onSentAtChange: (value: string) => void;
  onCopy: () => void;
  onAnswer: (answer: HandoffAnswer) => void;
  onRefresh: () => void;
}

/**
 * One human-send handoff in Today, as markup. A waiting handoff shows the
 * row's exact stored bytes, frozen from the moment the card presented them,
 * so "Mark sent" records what the founder pasted; the founder's own reading is
 * the review. A cancelled one asks only whether it already went out. "Mark
 * sent" is the one primary action either way.
 */
export function LinkedInHandoffCardView({
  item,
  handoff,
  refused,
  busy,
  copied,
  problem,
  sentAt,
  onSentAtChange,
  onCopy,
  onAnswer,
  onRefresh
}: LinkedInHandoffCardViewProps) {
  const cancelled = handoff?.cancelled === true;
  const kind = handoff?.actionKind ?? text(item.metadata.actionKind) ?? 'dm';
  return (
    <li className="today-item-expanded">
      <Send size={19} />
      <div>
        <strong>{item.title}</strong>
        <small>{item.detail}</small>
      </div>
      <span className="status-pill">{cancelled ? 'Cancelled' : 'You send'}</span>
      <div className="today-action-review">
        <div className="today-action-review-head">
          <div>
            <strong>{kind === 'invite' ? 'Invite note' : 'Message'}</strong>
            <small>
              {cancelled
                ? 'Trevra cancelled this after showing it to you. Do not send it now.'
                : 'Nothing goes out from Trevra. You send this on LinkedIn, then tell Trevra.'}
            </small>
            {handoff && !handoff.targetUrl && handoff.targetRef && (
              <small>To: {handoff.targetRef}</small>
            )}
          </div>
          {handoff?.targetUrl && !cancelled && (
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
        {refused ? (
          <>
            <div className="error-banner" role="alert">
              {refused}
            </div>
            <div className="today-action-review-actions">
              <Button variant="secondary" onClick={onRefresh}>
                Refresh
              </Button>
            </div>
          </>
        ) : !handoff ? (
          <p className="li-hint" role="status">
            Checking this is still yours to send…
          </p>
        ) : (
          <>
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
              <p className="li-hint">
                {cancelled ? 'No note.' : 'No note: send the invite without one.'}
              </p>
            )}
            <details className="today-handoff-more">
              <summary className="ui-disclosure-summary">
                {cancelled ? 'Sent it earlier?' : "Sent it earlier, or couldn't send it?"}
              </summary>
              <div className="today-handoff-more-body">
                <Field label="When you sent it" hint="Leave empty if you just sent it.">
                  <Input
                    type="datetime-local"
                    value={sentAt}
                    onChange={(event) => onSentAtChange(event.target.value)}
                  />
                </Field>
                {!cancelled && (
                  <div className="today-action-review-actions">
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        onAnswer({ resolution: 'failed', failure: 'profile_unavailable' })
                      }
                    >
                      Profile unavailable
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        onAnswer({ resolution: 'failed', failure: 'linkedin_refused' })
                      }
                    >
                      {busy === 'failed' ? 'Recording…' : 'LinkedIn refused it'}
                    </Button>
                  </div>
                )}
              </div>
            </details>
            {problem && (
              <div className="error-banner" role="alert">
                {problem}
              </div>
            )}
            <div className="today-action-review-actions">
              {handoff.copyText && !cancelled && (
                <Button variant="secondary" onClick={onCopy}>
                  {copied ? 'Copied' : handoffCopyLabel(kind)}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => onAnswer({ resolution: 'skip' })}
              >
                {busy === 'skip' ? 'Recording…' : cancelled ? "I didn't send it" : 'Skip'}
              </Button>
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => onAnswer({ resolution: 'sent' })}
              >
                {busy === 'sent' ? 'Recording…' : 'Mark sent'}
              </Button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * One human-send handoff in Today. A waiting handoff presents itself when it
 * is on screen (POST .../present) and shows the words that call froze;
 * reading Today alone presents nothing. A cancelled one was presented already.
 */
export function LinkedInHandoffCard({
  item,
  onResolved
}: {
  item: TodayItem;
  onResolved: () => void;
}) {
  const listed = handoffFromItem(item);
  const [shown, setShown] = useState<LinkedInHandoffView | null>(null);
  const [refused, setRefused] = useState('');
  const [busy, setBusy] = useState<HandoffAnswer['resolution'] | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  const [sentAt, setSentAt] = useState('');
  const actionId = listed?.actionId ?? null;
  const cancelled = listed?.cancelled === true;

  useEffect(() => {
    if (!actionId || cancelled) return;
    let live = true;
    presentLinkedInHandoff(actionId)
      .then((stamped) => {
        if (!live) return;
        setShown((current) => ({
          ...(current ?? listed!),
          copyText: stamped.copyText,
          subject: stamped.subject
        }));
      })
      .catch((error: unknown) => {
        if (live)
          setRefused(
            errorMessage(error, 'This handoff is no longer waiting for you. Refresh Today.')
          );
      });
    return () => {
      live = false;
    };
    // Present once per row; the listed words are deliberately not a dependency.
  }, [actionId, cancelled]);

  if (!listed) return null;
  const handoff = cancelled ? listed : shown;

  const copy = async () => {
    if (!handoff?.copyText) return;
    setProblem('');
    try {
      await navigator.clipboard.writeText(handoff.copyText);
      setCopied(true);
    } catch {
      setProblem('The browser blocked copying. Select the text above and copy it yourself.');
    }
  };

  const answer = async (choice: HandoffAnswer) => {
    const at = choice.resolution === 'sent' ? sentAtIso(sentAt) : null;
    if (choice.resolution === 'sent' && sentAt.trim() && !at) {
      setProblem('Enter when you sent it as a date and time, or leave it empty.');
      return;
    }
    setBusy(choice.resolution);
    setProblem('');
    try {
      await resolveLinkedInHandoff(listed.actionId, choice.resolution, {
        ...(at ? { sentAt: at } : {}),
        ...(choice.resolution === 'failed' ? { failure: choice.failure } : {})
      });
      onResolved();
    } catch (error) {
      setProblem(
        errorMessage(
          error,
          choice.resolution === 'sent'
            ? 'Trevra could not record this as sent, so the limits do not count it yet. Try again.'
            : choice.resolution === 'failed'
              ? 'Trevra could not record that this failed. It is still waiting for you.'
              : 'Trevra could not record this. It is still waiting for you.'
        )
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <LinkedInHandoffCardView
      item={item}
      handoff={handoff}
      refused={refused}
      busy={busy}
      copied={copied}
      problem={problem}
      sentAt={sentAt}
      onSentAtChange={setSentAt}
      onCopy={() => void copy()}
      onAnswer={(choice) => void answer(choice)}
      onRefresh={onResolved}
    />
  );
}
