import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./auth-client', () => ({ useIsWorkspaceOwner: () => true }));
import {
  COMMUNITY_POST_VERIFICATION,
  type UnresolvedCommunityPost
} from '../shared/community-post';
import { CommunityPostRecoveryList } from './CommunityPostRecovery';

const post: UnresolvedCommunityPost = {
  id: 'post-1',
  platform: 'github',
  threadUrl: 'https://github.com/example/repo/issues/1',
  createdAt: '2026-10-21T02:00:00.000Z',
  lastError: 'Provider response lost',
  readyForReview: true
};

const noAction = () => undefined;

function render(
  posts: UnresolvedCommunityPost[],
  decisions: Record<
    string,
    {
      outcome: 'posted' | 'not_posted';
      verificationUrl: string;
      acknowledged: boolean;
    }
  > = {},
  busyId: string | null = null
) {
  return renderToStaticMarkup(
    <CommunityPostRecoveryList
      posts={posts}
      decisions={decisions}
      busyId={busyId}
      onDecision={noAction}
      onResolve={noAction}
    />
  );
}

describe('owner community reply recovery', () => {
  it('reports the empty state without offering any retry or fake publication', () => {
    expect(render([])).toContain('No unresolved community replies');
  });

  it('withholds controls while the provider request could still be active', () => {
    const markup = render([{ ...post, readyForReview: false }]);
    expect(markup).toContain('Review after two minutes');
    expect(markup).toContain('Inspect original thread');
    expect(markup).not.toContain('Record verified outcome');
  });

  it('requires explicit verification before an owner can record an outcome', () => {
    const pending = render([post]);
    expect(pending).toContain('Provider response lost');
    expect(pending).toContain(COMMUNITY_POST_VERIFICATION);
    expect(pending).toMatch(/Record verified outcome<\/button>/);
    expect(pending).toMatch(/disabled=""/);
    const available = render([post], {
      [post.id]: {
        outcome: 'not_posted',
        verificationUrl: 'https://github.com/example/repo/issues/1',
        acknowledged: true
      }
    });
    expect(available).toContain(
      'Releasing this claim can allow an existing approved action to retry'
    );
    expect(available).toContain('Record verified outcome');
    expect(available).toContain('https://github.com/example/repo/issues/1');
  });

  it('disables resolution controls during an existing owner decision', () => {
    const markup = render(
      [post],
      {
        [post.id]: {
          outcome: 'posted',
          verificationUrl: post.threadUrl,
          acknowledged: true
        }
      },
      post.id
    );
    expect(markup).toContain('Recording…');
    expect(markup).toContain('disabled=""');
  });
});
