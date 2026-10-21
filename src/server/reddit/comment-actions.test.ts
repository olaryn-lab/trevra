import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openDatabase, type Db, id } from '../db.js';
import {
  prepareRedditComment,
  getRedditCommentReview,
  approveRedditComment,
  executeRedditComment,
  listRedditComments,
  listRedditCommentEvents
} from './comment-actions.js';

const WS = 'ws_reddit_comment_actions_a';
const OTHER = 'ws_reddit_comment_actions_b';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const URL = 'https://www.reddit.com/r/SaaS/comments/abc123/thread/';
let db: Db;
const posted = async () => ({
  ok: true as const,
  result: { ok: true, failureKind: null, externalRef: URL + 't1_reply/' }
});
async function policy(effect: 'allow' | 'deny') {
  await db
    .prepare(
      `INSERT INTO workspace_policies(
     id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at)
     VALUES (?,?,?,100,'action:reddit.comment',?,'{}'::jsonb,TRUE,?::timestamptz,?::timestamptz)`
    )
    .run(id('pol'), WS, `Reddit ${effect}`, effect, NOW.toISOString(), NOW.toISOString());
}
beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
});
afterEach(async () => {
  for (const workspaceId of [WS, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});
describe('Reddit exact-payload comment approval', () => {
  it('prepares once, scopes to workspace and refuses forged stale hashes without a browser write', async () => {
    const first = await prepareRedditComment(
      db,
      WS,
      { url: URL + '?context=3', body: ' One thoughtful reply ' },
      NOW
    );
    expect(first).toMatchObject({
      status: 'prepared',
      approved: false,
      body: 'One thoughtful reply',
      policy: { effect: 'require_approval' }
    });
    const replay = await prepareRedditComment(
      db,
      WS,
      { url: URL, body: 'One thoughtful reply' },
      NOW
    );
    expect(replay.id).toBe(first.id);
    expect(await getRedditCommentReview(db, OTHER, first.id)).toBeNull();
    expect(await listRedditComments(db, OTHER)).toEqual([]);
    expect(
      (await prepareRedditComment(db, OTHER, { url: URL, body: 'One thoughtful reply' }, NOW)).id
    ).not.toBe(first.id);
    await expect(
      prepareRedditComment(
        db,
        WS,
        { url: 'https://reddit.com.evil.invalid/r/SaaS/comments/abc123/', body: 'Hi' },
        NOW
      )
    ).rejects.toThrow('canonical');
    await expect(
      approveRedditComment(db, WS, first.id, '0'.repeat(64), 'owner', NOW)
    ).rejects.toThrow('changed');
    let calls = 0;
    const held = await executeRedditComment(
      db,
      WS,
      first.id,
      async () => {
        calls++;
        return posted();
      },
      NOW
    );
    expect(held).toMatchObject({ status: 'prepared', posted: false });
    expect(calls).toBe(0);
    expect((await listRedditCommentEvents(db, WS, first.id)).map((e) => e.decision)).toEqual([
      'held'
    ]);
  });

  it('executes only the exact approved reply and never posts it twice', async () => {
    const first = await prepareRedditComment(db, WS, { url: URL, body: 'Solid feedback' }, NOW);
    await approveRedditComment(db, WS, first.id, first.contentHash, 'owner', NOW);
    let sends = 0;
    const execute = () =>
      executeRedditComment(
        db,
        WS,
        first.id,
        async (payload) => {
          sends++;
          expect(payload).toEqual({ threadUrl: URL, body: 'Solid feedback' });
          return posted();
        },
        NOW
      );
    expect(await execute()).toMatchObject({ status: 'posted', posted: true });
    expect(await execute()).toMatchObject({ status: 'posted', posted: true });
    expect(sends).toBe(1);
    expect((await listRedditCommentEvents(db, WS, first.id)).map((e) => e.decision).sort()).toEqual(
      ['approved', 'allowed'].sort()
    );
  });

  it('an explicit workspace allow executes without a grant, while a later deny beats approval', async () => {
    await policy('allow');
    const allowed = await prepareRedditComment(db, WS, { url: URL, body: 'Allowed reply' }, NOW);
    let sends = 0;
    expect(
      await executeRedditComment(
        db,
        WS,
        allowed.id,
        async () => {
          sends++;
          return posted();
        },
        NOW
      )
    ).toMatchObject({ status: 'posted', posted: true });
    expect(sends).toBe(1);
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WS);
    const blocked = await prepareRedditComment(db, WS, { url: URL, body: 'Another reply' }, NOW);
    await approveRedditComment(db, WS, blocked.id, blocked.contentHash, 'owner', NOW);
    await policy('deny');
    const res = await executeRedditComment(
      db,
      WS,
      blocked.id,
      async () => {
        sends++;
        return posted();
      },
      NOW
    );
    expect(res).toMatchObject({ status: 'prepared', posted: false });
    expect(sends).toBe(1);
    expect(
      (await listRedditCommentEvents(db, WS, blocked.id)).map((e) => e.decision).sort()
    ).toEqual(['approved', 'denied'].sort());
  });

  it('halts on unknown outcomes including throws, never auto-retries or double-posts', async () => {
    const first = await prepareRedditComment(db, WS, { url: URL, body: 'Lost network' }, NOW);
    await approveRedditComment(db, WS, first.id, first.contentHash, 'owner', NOW);
    let calls = 0;
    expect(
      await executeRedditComment(
        db,
        WS,
        first.id,
        async () => {
          calls++;
          throw new Error('Lost browser response');
        },
        NOW
      )
    ).toMatchObject({ status: 'unknown', posted: false });
    expect(
      await executeRedditComment(
        db,
        WS,
        first.id,
        async () => {
          calls++;
          return posted();
        },
        NOW
      )
    ).toMatchObject({ status: 'unknown', posted: false });
    expect(calls).toBe(1);
  });

  it('atomically claims a reply so concurrent execute calls cannot both publish', async () => {
    const comment = await prepareRedditComment(db, WS, { url: URL, body: 'Concurrent' }, NOW);
    await approveRedditComment(db, WS, comment.id, comment.contentHash, 'owner', NOW);
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const first = executeRedditComment(
      db,
      WS,
      comment.id,
      async () => {
        calls++;
        started();
        await pending;
        return posted();
      },
      NOW
    );
    await startedPromise;
    const second = await executeRedditComment(
      db,
      WS,
      comment.id,
      async () => {
        calls++;
        return posted();
      },
      NOW
    );
    expect(second).toMatchObject({ status: 'executing', posted: false });
    release();
    expect(await first).toMatchObject({ status: 'posted', posted: true });
    expect(calls).toBe(1);
  });
});
