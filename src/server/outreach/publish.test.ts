import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import {
  assertPostingWindow,
  handoffReason,
  publishCommunityReply,
  type CommunityReplyPayload
} from './publish.js';
import { recordPost } from './store.js';

let db: Db;
const NOW = new Date('2026-08-03T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

function credentials(values: Record<string, string> = {}): CredentialAccessor {
  return { get: (name) => values[name] };
}

/** Records every call so "did anything leave the process" is directly assertable. */
function stubFetch(response: () => Response): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input) => {
      calls.push(input);
      return response();
    }
  };
}

const payload: CommunityReplyPayload = {
  platform: 'reddit',
  threadExternalId: 't1',
  threadUrl: 'https://www.reddit.com/r/webdev/comments/t1/x',
  community: 'webdev',
  body: 'A reply someone approved.',
  // Carried inside the hash-approved payload, so it cannot be flipped after
  // the founder signed off without invalidating the approval.
  metadata: { safetyAllowed: true }
};

const githubPayload: CommunityReplyPayload = {
  ...payload,
  platform: 'github',
  community: 'a/b',
  threadUrl: 'https://github.com/a/b/issues/1'
};

describe('handoffReason', () => {
  it('refuses platforms whose policy forbids unattended posting, even though their API can post', () => {
    // Reddit's API can comment. The reference did exactly that. It is the
    // sitewide self-promotion policy that makes it a handoff.
    expect(handoffReason('reddit')).toMatch(/prepare-only/);
    expect(handoffReason('hackernews')).toMatch(/prepare-only/);
    expect(handoffReason('linkedin')).toMatch(/prepare-only/);
  });

  it('refuses platforms that publish your own posts but cannot reply to someone else’s', () => {
    // dev.to is api-publish for ARTICLES and has no comment endpoint at all.
    expect(handoffReason('devto')).toMatch(/no API for replying/);
  });

  it('refuses a platform with no channel adapter rather than guessing it is allowed', () => {
    expect(handoffReason('stackoverflow')).toMatch(/no channel adapter/i);
    expect(handoffReason('doesnotexist')).toMatch(/no channel adapter/i);
  });

  it('permits only the platforms with both an api-publish policy and a reply API', () => {
    expect(handoffReason('github')).toBeNull();
    expect(handoffReason('mastodon')).toBeNull();
  });
});

async function setCommunityPolicy(input: {
  actionPattern?: string;
  effect: 'deny' | 'allow' | 'require_approval';
  actorTypes?: string[];
  name?: string;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspace_policies (
      id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?::jsonb,TRUE,?::timestamptz,?::timestamptz)`
    )
    .run(
      id('pol'),
      DEMO_WORKSPACE_ID,
      input.name ?? 'No community replies',
      500,
      input.actionPattern ?? 'action:community.reply',
      input.effect,
      JSON.stringify(input.actorTypes ? { actorTypes: input.actorTypes } : {}),
      NOW.toISOString(),
      NOW.toISOString()
    );
}

describe('publishCommunityReply', () => {
  it('serializes the daily limit across simultaneous distinct manual handoffs', async () => {
    const submissions = Array.from({ length: 8 }, (_, index) =>
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        {
          ...payload,
          threadExternalId: `concurrent-${index}`,
          threadUrl: `https://www.reddit.com/r/community${index}/comments/${index}/`,
          community: `community${index}`
        },
        `handoff-concurrent-${index}`,
        NOW
      )
    );
    const results = await Promise.allSettled(submissions);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(3);
    for (const result of results) {
      if (result.status === 'rejected') expect(String(result.reason)).toMatch(/Daily cap reached/);
    }
    const counts = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM outreach_posts WHERE workspace_id=? AND platform='reddit' AND status='manual_handoff'"
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(counts?.total).toBe(5);
  });

  it('reserves the community cooldown before an in-flight API reply finishes', async () => {
    let unblock!: () => void;
    let contacted!: () => void;
    const received = new Promise<void>((resolve) => {
      contacted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(input);
      contacted();
      await blocked;
      return new Response(
        JSON.stringify({ id: 4, html_url: 'https://github.com/a/b/issues/1#reply' }),
        { status: 201 }
      );
    };
    const options = { fetchImpl, credentials: credentials({ GITHUB_TOKEN: 'tok' }) };
    const first = publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'inflight-one',
      NOW,
      options
    );
    try {
      await received;
      await expect(
        publishCommunityReply(
          db,
          DEMO_WORKSPACE_ID,
          {
            ...githubPayload,
            threadExternalId: 'other-issue',
            threadUrl: 'https://github.com/a/b/issues/2'
          },
          'inflight-two',
          NOW,
          options
        )
      ).rejects.toThrow(/Cooldown active/);
      expect(calls).toHaveLength(1);
      const held = await db
        .prepare(
          "SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash='inflight-one'"
        )
        .get<{ status: string }>(DEMO_WORKSPACE_ID);
      expect(held?.status).toBe('pending');
    } finally {
      unblock();
    }
    expect((await first).status).toBe('posted');
  });

  it('honors a workspace deny added after approval before an API write or handoff', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ id: 1 }), { status: 201 })
    );
    await setCommunityPolicy({ effect: 'deny' });
    const options = { fetchImpl, credentials: credentials({ GITHUB_TOKEN: 'tok' }) };
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'deny-github', NOW, options)
    ).rejects.toThrow('Workspace policy denies community reply');
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, payload, 'deny-handoff', NOW, options)
    ).rejects.toThrow('Workspace policy denies community reply');
    expect(calls).toEqual([]);
    const count = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM outreach_posts WHERE workspace_id=? AND payload_hash IN ('deny-github','deny-handoff')"
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(count?.total).toBe(0);
  });

  it('matches actor-scoped late policies against the original playbook actor', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ id: 2 }), { status: 201 })
    );
    await setCommunityPolicy({ effect: 'deny', actorTypes: ['agent'], name: 'Deny agents only' });
    const options = { fetchImpl, credentials: credentials({ GITHUB_TOKEN: 'tok' }) };
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'agent-denied', NOW, {
        ...options,
        actorType: 'agent'
      })
    ).rejects.toThrow('Deny agents only');
    expect(calls).toEqual([]);
    const permitted = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'system-allowed',
      NOW,
      { ...options, actorType: 'system' }
    );
    expect(permitted.status).toBe('posted');
    expect(calls).toHaveLength(1);
  });

  it('respects deny on the shared community action dispatcher with no outgoing effect', async () => {
    await setCommunityPolicy({ effect: 'deny' });
    const { executePreparedPlaybookAction } = await import('../control-plane/execution.js');
    await expect(
      executePreparedPlaybookAction(db, {
        workspaceId: DEMO_WORKSPACE_ID,
        actionType: 'community.reply',
        payload,
        payloadHash: 'dispatcher-policy-deny',
        actorType: 'agent'
      })
    ).rejects.toThrow('Workspace policy denies community reply');
    const count = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM outreach_posts WHERE workspace_id=? AND payload_hash='dispatcher-policy-deny'"
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(count?.total).toBe(0);
  });
  it('never touches the network for a prepare-only platform', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    const result = await publishCommunityReply(db, DEMO_WORKSPACE_ID, payload, 'hash-1', NOW, {
      credentials: credentials({ REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y' }),
      fetchImpl
    });

    expect(calls).toEqual([]);
    expect(result.status).toBe('manual_handoff');
    expect(result.provider).toBe('manual-handoff');
    // The founder is sent back to the thread itself, not a generic submit page.
    expect(result.externalRef).toBe(payload.threadUrl);

    const row = await db
      .prepare('SELECT status, body FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string; body: string }>(DEMO_WORKSPACE_ID, 'hash-1');
    expect(row?.status).toBe('manual_handoff');
    expect(row?.body).toBe(payload.body);
  });

  it('refuses to post when the approved payload carries no passing safety verdict', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 201 }));
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    // The guard said no.
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        { ...githubPayload, metadata: { safetyAllowed: false } },
        'h-blocked',
        NOW,
        options
      )
    ).rejects.toThrow(/does not carry a passing safety verdict/);

    // A hand-built action that skipped the guard step entirely: fail closed.
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        { ...githubPayload, metadata: undefined },
        'h-absent',
        NOW,
        options
      )
    ).rejects.toThrow(/does not carry a passing safety verdict/);

    expect(calls).toEqual([]);
  });

  it('rejects spoofed or ambiguous GitHub issue URLs before any claim or provider request', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ id: 100 }), { status: 201 })
    );
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };
    const badUrls = [
      'https://evil.test/https://github.com/a/b/issues/1',
      'https://evil.test/?next=https://github.com/a/b/issues/1',
      'https://github.com.evil.test/a/b/issues/1',
      'http://github.com/a/b/issues/1',
      'https://github.com@evil.test/a/b/issues/1',
      'https://github.com/a/b/issues/1/another',
      'https://github.com/a/b/issues/1comments',
      'https://github.com/a/b/issues/0',
      'https://github.com/a/b/issues/%31',
      'https://github.com/a/b/tree/main'
    ];
    for (const [index, threadUrl] of badUrls.entries()) {
      await expect(
        publishCommunityReply(
          db,
          DEMO_WORKSPACE_ID,
          { ...githubPayload, threadUrl },
          `bad-github-url-${index}`,
          NOW,
          options
        )
      ).rejects.toThrow(/GitHub reply/);
    }
    expect(calls).toEqual([]);
    const claims = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM outreach_posts WHERE workspace_id=? AND payload_hash LIKE 'bad-github-url-%'"
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(claims?.total).toBe(0);
  });

  it('does not send a second differently worded approved reply to an already posted thread', async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ id: 203, html_url: 'https://github.com/a/b/issues/1#issuecomment-203' }),
          { status: 201 }
        )
    );
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };
    const first = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'thread-one-first',
      NOW,
      options
    );
    expect(first.status).toBe('posted');
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        { ...githubPayload, body: 'Different approved wording' },
        'thread-one-second',
        NOW,
        options
      )
    ).rejects.toThrow(/thread already has a posted reply/i);
    // Another feed can use a different external id, a www host, and a pull
    // route for the same GitHub issue. It still must not send twice.
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        {
          ...githubPayload,
          threadExternalId: 'other-source-key',
          threadUrl: 'https://www.github.com/a/b/pull/1/?view=conversation',
          body: 'Yet another approved version'
        },
        'thread-one-third',
        NOW,
        options
      )
    ).rejects.toThrow(/thread already has a posted reply/i);
    expect(calls).toHaveLength(1);
    const rows = await db
      .prepare(
        "SELECT COUNT(*)::int AS count FROM outreach_posts WHERE workspace_id=? AND thread_external_id=? AND platform='github' AND status <> 'failed'"
      )
      .get<{ count: number }>(DEMO_WORKSPACE_ID, githubPayload.threadExternalId);
    expect(rows?.count).toBe(1);
  });

  it('does not turn a pending unknown thread into a second differently worded request', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('gateway timeout', { status: 502 }));
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        githubPayload,
        'pending-thread-first',
        NOW,
        options
      )
    ).rejects.toThrow(/outcome is unknown/);
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        { ...githubPayload, body: 'A different reply after unknown status' },
        'pending-thread-second',
        NOW,
        options
      )
    ).rejects.toThrow(/thread already has a pending reply/i);
    expect(calls).toHaveLength(1);
  });

  it('posts to GitHub and logs the delivery', async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ id: 99, html_url: 'https://github.com/a/b/issues/1#issuecomment-99' }),
          { status: 201 }
        )
    );
    const result = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'hash-gh',
      NOW,
      {
        credentials: credentials({ GITHUB_TOKEN: 'tok' }),
        fetchImpl
      }
    );

    expect(calls).toEqual(['https://api.github.com/repos/a/b/issues/1/comments']);
    expect(result.status).toBe('posted');
    expect(result.externalRef).toBe('https://github.com/a/b/issues/1#issuecomment-99');
  });

  it('is idempotent per approved payload: a retried action does not comment twice', async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(JSON.stringify({ id: 99, html_url: 'https://example.test/c' }), {
          status: 201
        })
    );
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    const first = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'hash-same',
      NOW,
      options
    );
    const second = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'hash-same',
      NOW,
      options
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    // The decisive assertion: one network call, not two.
    expect(calls).toHaveLength(1);
    expect(second.externalRef).toBe(first.externalRef);
  });

  it('releases the claim when the platform ANSWERED and refused, so a retry can succeed', async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      return attempt === 1
        ? new Response('rate limited', { status: 403 })
        : new Response(JSON.stringify({ id: 5, html_url: 'https://example.test/ok' }), {
            status: 201
          });
    };
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-retry', NOW, options)
    ).rejects.toThrow(/403/);

    const failed = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-retry');
    // A 403 means nothing was published, so the claim is released.
    expect(failed?.status).toBe('failed');

    const retried = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      githubPayload,
      'hash-retry',
      NOW,
      options
    );
    expect(retried.status).toBe('posted');
    expect(attempt).toBe(2);
  });

  it('HOLDS the claim when the outcome is unknown, so a retry cannot double-post', async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      // The request landed; the response was lost. Retrying would put a second
      // comment on a stranger’s issue, which cannot be undone.
      throw new Error('socket hang up');
    };
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-lost', NOW, options)
    ).rejects.toThrow(/outcome is unknown/);

    const held = await db
      .prepare('SELECT status, error FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string; error: string }>(DEMO_WORKSPACE_ID, 'hash-lost');
    expect(held?.status).toBe('pending');
    expect(held?.error).toMatch(/socket hang up/);

    // The decisive assertion: the retry makes no second request, and it does
    // NOT report a handoff -- that would send a human to post the same reply.
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-lost', NOW, options)
    ).rejects.toThrow(/is unresolved .*settle post/);
    expect(attempt).toBe(1);
  });

  it('holds the claim on a 5xx, which does not prove the write was skipped', async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      return new Response('bad gateway', { status: 502 });
    };
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-502', NOW, options)
    ).rejects.toThrow(/outcome is unknown/);

    const held = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-502');
    // A gateway error is not evidence the origin skipped the comment.
    expect(held?.status).toBe('pending');

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-502', NOW, options)
    ).rejects.toThrow(/unresolved/);
    expect(attempt).toBe(1);
  });

  it('does not release the claim when recording a SUCCESSFUL post fails', async () => {
    // The comment is public; only the bookkeeping failed. Releasing the claim
    // here is what would let the engine's retry post a second one.
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ id: 7, html_url: 'https://gh.test/c7' }), { status: 201 })
    );
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    const realPrepare = db.prepare.bind(db);
    let broken = true;
    db.prepare = ((sql: string) => {
      if (broken && sql.includes('UPDATE outreach_posts SET status=')) {
        return {
          get: async () => undefined,
          all: async () => [],
          run: async () => {
            throw new Error('connection terminated unexpectedly');
          }
        };
      }
      return realPrepare(sql);
    }) as typeof db.prepare;

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-settle', NOW, options)
    ).rejects.toThrow(/connection terminated/);
    broken = false;

    const row = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-settle');
    expect(row?.status).toBe('pending');

    // The decisive assertion: the retry refuses rather than posting again.
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-settle', NOW, options)
    ).rejects.toThrow(/unresolved/);
    expect(calls).toHaveLength(1);
  });

  it('never replays the comment body to a redirect target', async () => {
    // createSsrfFetch follows redirects by re-issuing { ...init } -- which for a
    // POST re-sends the body. One approved comment must not become several.
    // GitHub answers 301 here for a renamed repo, so this needs no attacker.
    const posted: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      posted.push(String(init?.body ?? ''));
      return new Response('', {
        status: 307,
        headers: { location: 'https://api.github.com/repos/a/b/issues/1/comments?v=2' }
      });
    };
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-redirect', NOW, options)
    ).rejects.toThrow(/outcome is unknown/);

    // Exactly one write escaped the process.
    expect(posted).toHaveLength(1);

    const held = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-redirect');
    // A redirect means the request went out; the outcome is unknown, so hold.
    expect(held?.status).toBe('pending');

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-redirect', NOW, options)
    ).rejects.toThrow(/unresolved/);
    expect(posted).toHaveLength(1);
  });

  it('holds the claim when an accepted write returns a body that is not an object', async () => {
    // `null` parses as valid JSON, then reading `.id` off it throws a bare
    // TypeError -- which must not be mistaken for "the platform refused".
    for (const [label, body] of [
      ['null', 'null'],
      ['array', '[]'],
      ['number', '7']
    ] as const) {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (input) => {
        calls.push(input);
        return new Response(body, { status: 201, headers: { 'content-type': 'application/json' } });
      };
      const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };
      const hash = `hash-body-${label}`;
      // A distinct community per case: the held claim from the previous
      // iteration would otherwise trip the 48h cooldown and mask the result.
      const target = {
        ...githubPayload,
        community: `acme/${label}`,
        threadUrl: `https://github.com/acme/${label}/issues/1`
      };

      await expect(
        publishCommunityReply(db, DEMO_WORKSPACE_ID, target, hash, NOW, options)
      ).rejects.toThrow(/outcome is unknown/);
      const row = await db
        .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
        .get<{ status: string }>(DEMO_WORKSPACE_ID, hash);
      expect(row?.status, `2xx body ${label} must hold the claim`).toBe('pending');

      await expect(
        publishCommunityReply(db, DEMO_WORKSPACE_ID, target, hash, NOW, options)
      ).rejects.toThrow(/unresolved/);
      expect(calls, `2xx body ${label} must not be retried`).toHaveLength(1);
    }
  });

  it('treats a 408 as unknown rather than a refusal', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(input);
      return new Response('timeout', { status: 408 });
    };
    const options = { credentials: credentials({ GITHUB_TOKEN: 'tok' }), fetchImpl };

    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-408', NOW, options)
    ).rejects.toThrow(/outcome is unknown/);
    const row = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-408');
    expect(row?.status).toBe('pending');
    expect(calls).toHaveLength(1);
  });

  it('refuses to hand the same approved reply to a human twice', async () => {
    const { fetchImpl } = stubFetch(() => new Response('{}', { status: 200 }));
    const options = { credentials: credentials({}), fetchImpl };

    const first = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      payload,
      'hash-hand',
      NOW,
      options
    );
    expect(first.status).toBe('manual_handoff');

    // Second execution of the same approved payload: the existingPost branch
    // catches it. A person pasting the reply twice is as much a duplicate as a
    // process posting it twice.
    const second = await publishCommunityReply(
      db,
      DEMO_WORKSPACE_ID,
      payload,
      'hash-hand',
      NOW,
      options
    );
    expect(second.duplicate).toBe(true);
    expect(second.postId).toBe(first.postId);
  });

  it('requires the platform credential before it will post', async () => {
    const { fetchImpl } = stubFetch(() => new Response('{}', { status: 201 }));
    await expect(
      publishCommunityReply(db, DEMO_WORKSPACE_ID, githubPayload, 'hash-nocred', NOW, {
        credentials: credentials({}),
        fetchImpl
      })
    ).rejects.toThrow(/GITHUB_TOKEN is required/);
  });

  it('applies the daily cap to manual handoffs too, not just API posts', async () => {
    // Reddit's cap is 5.
    for (let index = 0; index < 5; index += 1) {
      await recordPost(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          platform: 'reddit',
          community: `sub${index}`,
          threadExternalId: `t${index}`,
          threadUrl: 'https://example.test/x',
          payloadHash: `cap-${index}`,
          status: 'manual_handoff',
          provider: 'manual-handoff',
          externalRef: 'x',
          error: null,
          body: 'x'
        },
        NOW
      );
    }
    const { fetchImpl } = stubFetch(() => new Response('{}', { status: 200 }));
    await expect(
      publishCommunityReply(
        db,
        DEMO_WORKSPACE_ID,
        { ...payload, threadExternalId: 'not-a-previous-reddit-thread' },
        'hash-capped',
        NOW,
        {
          credentials: credentials({}),
          fetchImpl
        }
      )
    ).rejects.toThrow(/Daily cap reached/);
  });
});

describe('community.reply action routing', () => {
  it('reaches publishCommunityReply through the control-plane action dispatcher', async () => {
    // The integration point the playbook actually uses. Reddit is prepare-only,
    // so this exercises the full route with no network involved.
    const { executePreparedPlaybookAction } = await import('../control-plane/execution.js');
    const result = await executePreparedPlaybookAction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      actionType: 'community.reply',
      payload,
      payloadHash: 'hash-routed'
    });

    expect(result).toEqual({
      provider: 'manual-handoff',
      externalRef: payload.threadUrl,
      actionType: 'community.reply'
    });
    const row = await db
      .prepare('SELECT status FROM outreach_posts WHERE workspace_id=? AND payload_hash=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, 'hash-routed');
    expect(row?.status).toBe('manual_handoff');
  });

  it('rejects a payload the schema does not accept, before any state is written', async () => {
    const { executePreparedPlaybookAction } = await import('../control-plane/execution.js');
    await expect(
      executePreparedPlaybookAction(db, {
        workspaceId: DEMO_WORKSPACE_ID,
        actionType: 'community.reply',
        payload: { ...payload, threadUrl: 'not-a-url' },
        payloadHash: 'hash-bad'
      })
    ).rejects.toThrow();

    const row = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM outreach_posts WHERE workspace_id=? AND payload_hash=?'
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID, 'hash-bad');
    expect(row?.total).toBe(0);
  });
});

describe('assertPostingWindow', () => {
  it('refuses to post when the cap was consumed between approval and execution', async () => {
    for (let index = 0; index < 10; index += 1) {
      await recordPost(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          platform: 'github',
          community: `repo/${index}`,
          threadExternalId: `t${index}`,
          threadUrl: 'https://example.test/x',
          payloadHash: `window-${index}`,
          status: 'posted',
          provider: 'github',
          externalRef: 'ref',
          error: null,
          body: 'x'
        },
        NOW
      );
    }
    await expect(assertPostingWindow(db, DEMO_WORKSPACE_ID, 'github', 'a/b', NOW)).rejects.toThrow(
      /Daily cap reached/
    );
  });

  it('refuses to post into a community whose cooldown started after approval', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'github',
        community: 'a/b',
        threadExternalId: 't',
        threadUrl: 'https://example.test/x',
        payloadHash: 'cooldown-1',
        status: 'posted',
        provider: 'github',
        externalRef: 'ref',
        error: null,
        body: 'x'
      },
      new Date(NOW.getTime() - 3_600_000)
    );
    await expect(assertPostingWindow(db, DEMO_WORKSPACE_ID, 'github', 'a/b', NOW)).rejects.toThrow(
      /Cooldown active/
    );
  });

  it('allows a post inside both windows', async () => {
    await expect(
      assertPostingWindow(db, DEMO_WORKSPACE_ID, 'github', 'a/b', NOW)
    ).resolves.toBeUndefined();
  });
});
