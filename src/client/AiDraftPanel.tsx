import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveAiDraft,
  editAiDraft,
  getAiDrafts,
  rejectAiDraft,
  requestAiDrafts,
  type AiDraft,
  type AiDraftReadiness
} from './api';
import { EmptyState, InlineActions } from './ui/layout';
import { Button, Field, Textarea } from './ui/primitives';

const ORIGIN_LABEL: Record<AiDraft['origin'], string> = {
  model: 'Drafted by AI',
  template_fallback: 'Template fallback',
  human_edit: 'Edited by a person'
};

type Busy = '' | 'loading' | 'drafting' | 'saving' | 'approving' | 'rejecting';

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * TRV-039 review panel for one queued message. The model only proposes text
 * from stored evidence; a person may edit it (which creates a new proposal
 * with a new hash) and an owner approves the exact text shown here. Nothing in
 * this panel can send.
 */
export function AiDraftPanel({
  campaignId,
  memberId,
  stepId,
  actionId,
  owner,
  onClose,
  onApproved
}: {
  campaignId: string;
  memberId: string;
  stepId: string | null;
  actionId: string;
  owner: boolean;
  onClose: () => void;
  onApproved: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [readiness, setReadiness] = useState<AiDraftReadiness | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<Busy>('loading');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const adopt = (next: AiDraft | null) => {
    setDraft(next);
    setText(next?.text ?? '');
  };

  const refreshReadiness = useCallback(async () => {
    try {
      const list = await getAiDrafts(campaignId);
      if (live.current) setReadiness(list.readiness);
    } catch {
      // The original error is already on screen.
    }
  }, [campaignId]);

  const draftNow = useCallback(async () => {
    setBusy('drafting');
    setError('');
    setNote('');
    try {
      const result = await requestAiDrafts(campaignId, [{ memberId, stepId }]);
      if (!live.current) return;
      const outcome = result.results[0];
      const created = result.drafts.find((row) => row.id === outcome?.draftId) ?? null;
      if (!created) {
        setError(outcome?.reason ?? 'No draft was produced for this message.');
        return;
      }
      adopt(created);
      if (outcome?.outcome === 'fallback')
        setNote('No AI draft passed the checks, so the rendered template is proposed instead.');
    } catch (cause) {
      if (!live.current) return;
      setError(messageOf(cause, 'Could not draft this message.'));
      await refreshReadiness();
    } finally {
      if (live.current) setBusy('');
    }
  }, [campaignId, memberId, stepId, refreshReadiness]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy('loading');
      try {
        const list = await getAiDrafts(campaignId);
        if (cancelled) return;
        setReadiness(list.readiness);
        const existing =
          list.drafts.find((row) => row.actionId === actionId && row.status === 'proposed') ?? null;
        if (existing) {
          adopt(existing);
          setBusy('');
        } else if (!list.readiness.blocker) {
          await draftNow();
        } else {
          setBusy('');
        }
      } catch (cause) {
        if (cancelled) return;
        setError(messageOf(cause, 'Could not load AI drafts.'));
        setBusy('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, actionId, draftNow]);

  const dirty = draft !== null && text !== draft.text;
  const overLimit = draft !== null && text.length > draft.maxChars;
  const working = busy !== '';
  const blocker = readiness?.blocker ?? null;

  const run = async (kind: Busy, work: () => Promise<void>, fallback: string) => {
    setBusy(kind);
    setError('');
    try {
      await work();
    } catch (cause) {
      if (live.current) setError(messageOf(cause, fallback));
    } finally {
      if (live.current) setBusy('');
    }
  };

  return (
    <section className="ai-draft-panel" aria-label="AI draft review" aria-busy={working}>
      <div className="ai-draft-heading">
        <strong>AI draft</strong>
        {draft && <span className="ai-draft-badge">{ORIGIN_LABEL[draft.origin]}</span>}
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {busy === 'loading' && <p className="ai-draft-meta">Loading drafts…</p>}
      {busy === 'drafting' && (
        <p className="ai-draft-meta" role="status">
          Drafting from this lead&apos;s stored evidence…
        </p>
      )}
      {!draft && !working && blocker && (
        <EmptyState
          title="AI drafting is not ready"
          description={blocker}
          action={
            <a className="secondary-button" href={readiness?.setupPath ?? '/setup'}>
              Open Setup
            </a>
          }
        />
      )}
      {!draft && !working && !blocker && (
        <EmptyState
          description="No draft is waiting for this message."
          action={
            <Button variant="primary" onClick={() => void draftNow()}>
              Draft with AI
            </Button>
          }
        />
      )}
      {draft && (
        <>
          <Field
            label={`Message to ${draft.contactName}`}
            hint={`${text.length} / ${draft.maxChars} characters${
              overLimit ? ' (over the limit)' : ''
            }`}
          >
            <Textarea
              value={text}
              rows={8}
              aria-invalid={overLimit}
              disabled={working}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          {note && <p className="ai-draft-meta">{note}</p>}
          <p className="ai-draft-meta">
            Model: {draft.modelLabel ?? 'none'} · Evidence {draft.evidenceHash.slice(0, 12)} ·
            Payload {draft.payloadHash.slice(0, 12)}
          </p>
          {draft.fallbackReason && (
            <details className="li-review-details">
              <summary>Why the template was proposed</summary>
              <p className="ai-draft-reason">{draft.fallbackReason}</p>
            </details>
          )}
          <details className="li-review-details">
            <summary>Evidence used ({draft.evidenceFacts.length})</summary>
            <dl className="ai-draft-evidence">
              {draft.evidenceFacts.map((fact, index) => (
                <div key={`${fact.label}-${index}`}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </details>
          <InlineActions className="ai-draft-actions">
            {dirty ? (
              <Button
                variant="primary"
                disabled={working || overLimit || !text.trim()}
                onClick={() =>
                  void run(
                    'saving',
                    async () => {
                      const next = await editAiDraft(campaignId, draft.id, text, draft.payloadHash);
                      if (live.current) adopt(next);
                    },
                    'Could not save the edit.'
                  )
                }
              >
                {busy === 'saving' ? 'Saving…' : 'Save edit'}
              </Button>
            ) : owner ? (
              <Button
                variant="primary"
                disabled={working}
                onClick={() =>
                  void run(
                    'approving',
                    async () => {
                      await approveAiDraft(campaignId, draft.id, draft.payloadHash);
                      await onApproved();
                    },
                    'This draft changed; refresh before approving.'
                  )
                }
              >
                {busy === 'approving' ? 'Approving…' : 'Approve this exact draft'}
              </Button>
            ) : (
              <p className="ai-draft-meta">A workspace owner approves drafts.</p>
            )}
            {dirty ? (
              <Button variant="ghost" disabled={working} onClick={() => setText(draft.text)}>
                Discard edit
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={working || Boolean(blocker)}
                onClick={() => void draftNow()}
              >
                Redraft
              </Button>
            )}
            {owner && !dirty && (
              <Button
                variant="ghost"
                disabled={working}
                onClick={() =>
                  void run(
                    'rejecting',
                    async () => {
                      await rejectAiDraft(campaignId, draft.id);
                      if (live.current) adopt(null);
                    },
                    'Could not reject the draft.'
                  )
                }
              >
                Reject draft
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </InlineActions>
        </>
      )}
      {!draft && (
        <InlineActions className="ai-draft-actions">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </InlineActions>
      )}
    </section>
  );
}
