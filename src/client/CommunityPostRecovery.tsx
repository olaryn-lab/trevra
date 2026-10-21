import { useCallback, useEffect, useState } from 'react';
import { getUnresolvedCommunityPosts, resolveUncertainCommunityPost } from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { Button, Field, Input, Select } from './ui/primitives';
import {
  COMMUNITY_POST_VERIFICATION,
  type UnresolvedCommunityPost
} from '../shared/community-post';

interface ReviewDecision {
  outcome: 'posted' | 'not_posted';
  verificationUrl: string;
  acknowledged: boolean;
}

const NEW_DECISION: ReviewDecision = {
  outcome: 'posted',
  verificationUrl: '',
  acknowledged: false
};

/** Pure presentation: owners see exactly which uncertain writes need a decision. */
export function CommunityPostRecoveryList({
  posts,
  decisions,
  busyId,
  onDecision,
  onResolve
}: {
  posts: UnresolvedCommunityPost[];
  decisions: Record<string, ReviewDecision>;
  busyId: string | null;
  onDecision: (id: string, patch: Partial<ReviewDecision>) => void;
  onResolve: (id: string) => void;
}) {
  if (posts.length === 0) {
    return <p className="empty-copy">No unresolved community replies.</p>;
  }
  return (
    <div className="page-stack">
      {posts.map((post) => {
        const decision = decisions[post.id] ?? NEW_DECISION;
        const busy = busyId !== null;
        const canResolve =
          post.readyForReview &&
          !busy &&
          decision.acknowledged &&
          /^https:\/\/[^\s]+$/i.test(decision.verificationUrl.trim());
        return (
          <article className="page-panel" key={post.id}>
            <h4>{post.platform} — unresolved reply</h4>
            <p className="li-hint">
              The provider may have posted the reply. Trevra will not retry it until an owner
              inspects the thread and records the outcome.
            </p>
            <p>
              <a href={post.threadUrl} target="_blank" rel="noopener noreferrer">
                Inspect original thread
              </a>
            </p>
            {post.lastError && <p className="li-hint">Last provider result: {post.lastError}</p>}
            {!post.readyForReview ? (
              <p className="li-hint">
                This request may still be in flight. Review after two minutes.
              </p>
            ) : (
              <div className="page-stack">
                <Field label="What did you verify on the original thread?">
                  <Select
                    value={decision.outcome}
                    disabled={busy}
                    onChange={(event) =>
                      onDecision(post.id, {
                        outcome: event.target.value as ReviewDecision['outcome'],
                        acknowledged: false
                      })
                    }
                  >
                    <option value="posted">The reply exists — mark posted</option>
                    <option value="not_posted">The reply does not exist — release claim</option>
                  </Select>
                </Field>
                <Field
                  label="Verification link"
                  hint="Paste the original platform thread or the published comment link."
                >
                  <Input
                    type="url"
                    placeholder="https://..."
                    value={decision.verificationUrl}
                    disabled={busy}
                    onChange={(event) =>
                      onDecision(post.id, {
                        verificationUrl: event.target.value,
                        acknowledged: false
                      })
                    }
                  />
                </Field>
                {decision.outcome === 'not_posted' && (
                  <p className="li-hint">
                    Releasing this claim can allow an existing approved action to retry. Confirm
                    absence only after inspecting the original thread.
                  </p>
                )}
                <label className="ui-field">
                  <span>
                    <input
                      type="checkbox"
                      checked={decision.acknowledged}
                      disabled={busy}
                      onChange={(event) =>
                        onDecision(post.id, { acknowledged: event.target.checked })
                      }
                    />{' '}
                    {COMMUNITY_POST_VERIFICATION}
                  </span>
                </label>
                <div>
                  <Button
                    variant="primary"
                    disabled={!canResolve}
                    onClick={() => onResolve(post.id)}
                  >
                    {busyId === post.id ? 'Recording…' : 'Record verified outcome'}
                  </Button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** Owner-facing recovery without automated platform reads or blind retries. */
export function CommunityPostRecovery({ setToast }: { setToast: (message: string) => void }) {
  const owner = useIsWorkspaceOwner();
  const [posts, setPosts] = useState<UnresolvedCommunityPost[]>([]);
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!owner) return;
    setLoading(true);
    setError('');
    try {
      setPosts(await getUnresolvedCommunityPosts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load unresolved replies.');
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!owner) return null;

  const onDecision = (id: string, patch: Partial<ReviewDecision>) => {
    setDecisions((current) => ({
      ...current,
      [id]: { ...(current[id] ?? NEW_DECISION), ...patch }
    }));
  };
  const onResolve = async (id: string) => {
    const choice = decisions[id];
    const post = posts.find((item) => item.id === id);
    if (!post?.readyForReview || !choice?.acknowledged || busyId) return;
    setBusyId(id);
    setError('');
    try {
      await resolveUncertainCommunityPost(id, {
        outcome: choice.outcome,
        verificationUrl: choice.verificationUrl.trim(),
        confirmation: COMMUNITY_POST_VERIFICATION
      });
      setToast('The verified community reply outcome was recorded.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record the outcome.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="page-panel page-stack" aria-label="Unresolved community replies">
      <div className="section-heading">
        <h3>Unresolved community replies</h3>
        <Button
          variant="secondary"
          disabled={loading || busyId !== null}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      <p className="li-hint">
        Unknown provider outcomes are never retried automatically. Inspect the original thread
        before confirming whether a public reply exists.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="empty-copy">Checking unresolved replies…</p>
      ) : (
        <CommunityPostRecoveryList
          posts={posts}
          decisions={decisions}
          busyId={busyId}
          onDecision={onDecision}
          onResolve={(id) => void onResolve(id)}
        />
      )}
    </section>
  );
}
