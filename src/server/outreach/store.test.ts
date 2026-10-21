import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import {
  COMMUNITY_POST_VERIFICATION,
  isThreadReplied,
  listOutreachThreads,
  listUnresolvedCommunityPosts,
  recordPost,
  recordSeenThreads,
  resolveCommunityUnknownPost
} from './store.js';
import { listDomainEvents } from '../control-plane/events.js';
import type { OutreachThread } from './types.js';

let db: Db;
const NOW = new Date('2026-08-03T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'reddit',
    externalId: 't1',
    url: 'https://www.reddit.com/r/webdev/comments/t1/x',
    title: 'Keeping agent costs down',
    content: 'My api cost tripled.',
    author: 'someone',
    community: 'webdev',
    score: 10,
    numComments: 4,
    createdAt: NOW.toISOString(),
    metadata: {},
    ...overrides
  };
}

async function reply(externalId: string, platform = 'reddit'): Promise<void> {
  await recordPost(
    db,
    {
      workspaceId: DEMO_WORKSPACE_ID,
      platform,
      community: 'webdev',
      threadExternalId: externalId,
      threadUrl: 'https://example.test/x',
      payloadHash: `hash-${platform}-${externalId}`,
      status: 'posted',
      provider: 'test',
      externalRef: 'ref',
      error: null,
      body: 'a reply'
    },
    NOW
  );
}

describe('unknown community write reconciliation', () => {
  async function pending(): Promise<string> {
    return (
      await recordPost(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          platform: 'github',
          community: 'example/repo',
          threadExternalId: 'issue-1',
          threadUrl: 'https://github.com/example/repo/issues/1',
          payloadHash: 'unknown-write',
          status: 'pending',
          provider: null,
          externalRef: null,
          error: 'Provider response lost',
          body: 'An approved reply'
        },
        NOW
      )
    ).id;
  }

  it('never allows a still-in-flight claim to be manually settled', async () => {
    const postId = await pending();
    const listed = await listUnresolvedCommunityPosts(db, DEMO_WORKSPACE_ID, NOW);
    expect(listed).toMatchObject([{ id: postId, readyForReview: false }]);
    await expect(
      resolveCommunityUnknownPost(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          postId,
          actorUserId: 'owner',
          outcome: 'not_posted',
          verificationUrl: 'https://github.com/example/repo/issues/1',
          confirmation: COMMUNITY_POST_VERIFICATION
        },
        new Date(NOW.getTime() + 30_000)
      )
    ).rejects.toThrow('may still be in flight');
    expect(
      await db
        .prepare('SELECT status FROM outreach_posts WHERE id=?')
        .get<{ status: string }>(postId)
    ).toEqual({ status: 'pending' });
  });

  it('requires explicit same-host verification and records an immutable owner resolution event', async () => {
    const postId = await pending();
    const later = new Date(NOW.getTime() + 3 * 60_000);
    const input = {
      workspaceId: DEMO_WORKSPACE_ID,
      postId,
      actorUserId: 'owner',
      outcome: 'posted' as const,
      verificationUrl: 'https://github.com/example/repo/issues/1#issuecomment-111',
      confirmation: COMMUNITY_POST_VERIFICATION
    };
    await expect(
      resolveCommunityUnknownPost(db, { ...input, confirmation: '' }, later)
    ).rejects.toThrow('Confirm you inspected');
    await expect(
      resolveCommunityUnknownPost(
        db,
        {
          ...input,
          verificationUrl: 'https://attacker.example/fake'
        },
        later
      )
    ).rejects.toThrow('same platform host');
    expect(await resolveCommunityUnknownPost(db, input, later)).toMatchObject({
      id: postId,
      status: 'posted',
      verificationUrl: input.verificationUrl
    });
    const events = await listDomainEvents(db, DEMO_WORKSPACE_ID, {
      streamType: 'outreach_post',
      streamId: postId
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorId: 'owner',
      eventType: 'community_reply.unknown_resolved',
      payload: { outcome: 'posted', verificationUrl: input.verificationUrl }
    });
    await expect(resolveCommunityUnknownPost(db, input, later)).rejects.toThrow(
      'no longer awaiting resolution'
    );
    expect(
      (await listUnresolvedCommunityPosts(db, DEMO_WORKSPACE_ID, later)).some(
        (post) => post.id === postId
      )
    ).toBe(false);
  });

  it('an owner-confirmed absence releases only its own claim and never triggers a send', async () => {
    const postId = await pending();
    const later = new Date(NOW.getTime() + 3 * 60_000);
    expect(
      await resolveCommunityUnknownPost(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          postId,
          actorUserId: 'owner',
          outcome: 'not_posted',
          verificationUrl: 'https://github.com/example/repo/issues/1',
          confirmation: COMMUNITY_POST_VERIFICATION
        },
        later
      )
    ).toMatchObject({ status: 'failed' });
    const row = await db
      .prepare(
        'SELECT status,provider,external_ref FROM outreach_posts WHERE workspace_id=? AND id=?'
      )
      .get<{ status: string; provider: string | null; external_ref: string | null }>(
        DEMO_WORKSPACE_ID,
        postId
      );
    expect(row).toEqual({ status: 'failed', provider: null, external_ref: null });
    expect(
      await resolveCommunityUnknownPost(
        db,
        {
          workspaceId: 'ws_other',
          postId,
          actorUserId: 'other',
          outcome: 'posted',
          verificationUrl: 'https://github.com/example/repo/issues/1',
          confirmation: COMMUNITY_POST_VERIFICATION
        },
        later
      )
    ).toBeNull();
    expect(await isThreadReplied(db, DEMO_WORKSPACE_ID, 'github', 'issue-1')).toBe(false);
  });
});

describe('recordSeenThreads', () => {
  it('keeps returning a discovered thread until we have actually replied to it', async () => {
    // The backlog case. A run that discovers 3 threads and replies to 1 must
    // still offer the other 2 on the next run -- the reference buried them.
    const batch = [
      thread({ externalId: 'a' }),
      thread({ externalId: 'b' }),
      thread({ externalId: 'c' })
    ];

    const first = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(first.fresh.map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);
    expect(first.repliedCount).toBe(0);

    // Merely re-seeing them changes nothing.
    const second = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(second.fresh.map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);

    await reply('a');

    const third = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(third.fresh.map((entry) => entry.externalId)).toEqual(['b', 'c']);
    expect(third.repliedCount).toBe(1);
  });

  it('detects that a thread was edited after we first read it', async () => {
    await recordSeenThreads(db, DEMO_WORKSPACE_ID, [thread({ externalId: 'a' })], NOW);

    const unchanged = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(unchanged.changed).toEqual([]);

    // The OP adds the detail that makes the thread worth replying to.
    const edited = thread({ externalId: 'a', content: 'My api cost tripled. It is now $400/mo.' });
    const afterEdit = await recordSeenThreads(db, DEMO_WORKSPACE_ID, [edited], NOW);
    expect(afterEdit.changed).toEqual(['a']);

    // The edit is reported once, against the stored hash -- not on every poll.
    const settled = await recordSeenThreads(db, DEMO_WORKSPACE_ID, [edited], NOW);
    expect(settled.changed).toEqual([]);
  });

  it('refreshes engagement counters, so the scorer reads current numbers', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', score: 3, numComments: 1 })],
      NOW
    );
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', score: 92, numComments: 40 })],
      NOW
    );

    const row = await db
      .prepare(
        'SELECT score, num_comments FROM outreach_threads WHERE workspace_id=? AND external_id=?'
      )
      .get<{ score: number; num_comments: number }>(DEMO_WORKSPACE_ID, 'a');
    expect(row).toEqual({ score: 92, num_comments: 40 });
  });

  it('records one row per thread however many times it is re-polled', async () => {
    for (let index = 0; index < 3; index += 1) {
      await recordSeenThreads(db, DEMO_WORKSPACE_ID, [thread({ externalId: 'a' })], NOW);
    }
    const row = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM outreach_threads WHERE workspace_id=? AND external_id=?'
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID, 'a');
    expect(row?.total).toBe(1);
  });

  it('scopes both the dedup and the reply history per platform and per workspace', async () => {
    await reply('a', 'reddit');

    // Same external id on another platform is a different thread.
    const other = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', platform: 'lobsters' })],
      NOW
    );
    expect(other.fresh).toHaveLength(1);

    // Another workspace has its own reply history. Created idempotently: the
    // container outlives a single test file and resetDemoData only drops the
    // demo workspace.
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run('ws_store_other', 'Other', NOW.toISOString());
    await db.prepare('DELETE FROM outreach_threads WHERE workspace_id=?').run('ws_store_other');
    const elsewhere = await recordSeenThreads(
      db,
      'ws_store_other',
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(elsewhere.fresh).toHaveLength(1);
  });

  it('withholds a thread that was handed off for manual posting, not just one posted by API', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'handoff-a',
        status: 'manual_handoff',
        provider: 'manual-handoff',
        externalRef: 'x',
        error: null,
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(0);
    expect(result.repliedCount).toBe(1);
  });

  it('does not withhold a thread whose only attempt failed', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'failed-a',
        status: 'failed',
        provider: null,
        externalRef: null,
        error: 'rejected',
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(1);
    expect(await isThreadReplied(db, DEMO_WORKSPACE_ID, 'reddit', 'a')).toBe(false);
  });

  it('treats a held pending claim as replied, so the thread is not offered twice', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'pending-a',
        status: 'pending',
        provider: null,
        externalRef: null,
        error: 'socket hang up',
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(0);
  });
});

describe('listOutreachThreads', () => {
  it('filters by platform and pages by recency, not platform score', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        // r1 is older but out-scores r2 on the platform's own points -- the
        // page must still put r2 first, on recency.
        thread({
          externalId: 'r1',
          platform: 'reddit',
          score: 9,
          createdAt: new Date(NOW.getTime() - 3_600_000).toISOString()
        }),
        thread({ externalId: 'r2', platform: 'reddit', score: 5, createdAt: NOW.toISOString() }),
        thread({ externalId: 'l1', platform: 'linkedin', score: 3 })
      ],
      NOW
    );

    const reddit = await listOutreachThreads(db, DEMO_WORKSPACE_ID, { platform: 'reddit' });
    expect(reddit.map((row) => row.external_id)).toEqual(['r2', 'r1']);

    const all = await listOutreachThreads(db, DEMO_WORKSPACE_ID);
    expect(all).toHaveLength(3);
  });

  it('pages by recency even when it inverts the platform score order', async () => {
    // Score and recency point opposite ways for all three rows: the oldest
    // thread has the highest platform score, the newest has the lowest. A
    // page that still ordered by `score` would put the newest thread LAST,
    // and a relevance re-rank downstream (loadThreadFeed) would never see it
    // if it fell past the page limit.
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        thread({
          externalId: 'oldest-high-score',
          score: 100,
          createdAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString()
        }),
        thread({
          externalId: 'mid',
          score: 50,
          createdAt: new Date(NOW.getTime() - 86_400_000).toISOString()
        }),
        thread({ externalId: 'newest-low-score', score: 1, createdAt: NOW.toISOString() })
      ],
      NOW
    );

    const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, {});

    expect(rows.map((row) => row.external_id)).toEqual([
      'newest-low-score',
      'mid',
      'oldest-high-score'
    ]);
  });

  it('returns nothing for a workspace with no discovered threads', async () => {
    const rows = await listOutreachThreads(db, 'ws_no_such_workspace');
    expect(rows).toEqual([]);
  });

  it('clamps limit to the same [1, 200] band the skill-run list uses', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'c1' }), thread({ externalId: 'c2' }), thread({ externalId: 'c3' })],
      NOW
    );

    const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, { limit: 0 });
    // limit=0 clamps to 1, not 0 -- with 3 rows seeded, [] would mean the
    // clamp is missing entirely rather than merely rounding down.
    expect(rows).toHaveLength(1);
  });

  it('returns the body and metadata a re-score needs, not just the hash', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        thread({
          externalId: 'body-1',
          content: 'my api cost tripled last month',
          metadata: { tags: ['ask_hn'] }
        })
      ],
      NOW
    );

    const [row] = await listOutreachThreads(db, DEMO_WORKSPACE_ID, {});

    expect(row.content).toBe('my api cost tripled last month');
    expect(row.metadata_json).toEqual({ tags: ['ask_hn'] });
  });

  it('refreshes stored content when an author edits the thread', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'body-2', content: 'first read' })],
      NOW
    );
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'body-2', content: 'edited later' })],
      NOW
    );

    const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, {});
    expect(rows.find((row) => row.external_id === 'body-2')?.content).toBe('edited later');
  });
});
