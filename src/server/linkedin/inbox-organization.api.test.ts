import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { id, openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { syncThreadMessages, syncThreads } from './inbox.js';

/**
 * The TRV-036/037 HTTP surface: route wiring, workspace scoping through real
 * sessions, the "me"/"unassigned" assignee filter, and the bulk cap's error.
 */

let db: Db;
let app: Express;
const NOW = new Date('2026-08-03T09:00:00.000Z');
const ORGANIZE = '/api/linkedin/inbox/organize';

async function seedSession(workspaceId: string, label: string) {
  const userId = `usr_${workspaceId}`;
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, label, NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, workspaceId, `${userId}@trevra.test`, label, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString()
    );
  return { token, userId };
}

function as(token: string) {
  const cookie = `trevra_session=${token}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

async function seedThreads(workspaceId: string, count: number) {
  const threads = Array.from({ length: count }, (_, index) => ({
    threadUrn: `2-api-${workspaceId}-${index}==`,
    profileUrl: `https://www.linkedin.com/in/api-${workspaceId}-${index}/`,
    name: `Lead ${index}`,
    lastMessageAt: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
    snippet: 'Hello',
    unread: false
  }));
  await syncThreads(db, { workspaceId, threads }, NOW);
  const rows = await db
    .prepare(
      'SELECT id, thread_urn FROM linkedin_threads WHERE workspace_id=? ORDER BY last_message_at DESC'
    )
    .all<{ id: string; thread_urn: string }>(workspaceId);
  return rows.map((row) => ({ id: row.id, urn: row.thread_urn }));
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterEach(async () => {
  await db?.close();
});

describe('inbox organize routes', () => {
  it('organizes a thread and filters by me, unassigned, tag and archived', async () => {
    const a = await seedSession(id('ws_orgapi'), 'A');
    const [first, second] = await seedThreads(a.userId.slice(4), 2);

    const tag = await as(a.token).post(`${ORGANIZE}/tags`).send({ name: 'Hot', color: 'amber' });
    expect(tag.status).toBe(201);
    expect(tag.body.tag).toMatchObject({ name: 'Hot', color: 'amber' });
    expect(
      (await as(a.token).post(`${ORGANIZE}/tags`).send({ name: 'Hot', color: 'teal' })).status
    ).toBe(400);

    expect(
      (
        await as(a.token)
          .post(`${ORGANIZE}/threads/${first.id}/tags`)
          .send({ tagId: tag.body.tag.id })
      ).status
    ).toBe(200);
    const patched = await as(a.token)
      .patch(`${ORGANIZE}/threads/${first.id}`)
      .send({ assigneeUserId: a.userId, starred: true });
    expect(patched.status).toBe(200);
    expect(
      (await as(a.token).patch(`${ORGANIZE}/threads/${first.id}`).send({ pinned: true })).status
    ).toBe(400);
    expect(
      (
        await as(a.token)
          .patch(`${ORGANIZE}/threads/${second.id}`)
          .send({ assigneeUserId: 'usr_nobody' })
      ).body
    ).toEqual({ error: 'Assignee must be a current member of this workspace' });

    const mine = await as(a.token).get('/api/linkedin/inbox/threads?assignee=me');
    expect(mine.status).toBe(200);
    expect(mine.body.threads.map((thread: { id: string }) => thread.id)).toEqual([first.id]);
    expect(mine.body.threads[0]).toMatchObject({
      starred: true,
      archived: false,
      assignee: { userId: a.userId },
      tags: [{ name: 'Hot', color: 'amber' }]
    });
    const unassigned = await as(a.token).get('/api/linkedin/inbox/threads?assignee=unassigned');
    expect(unassigned.body.threads.map((thread: { id: string }) => thread.id)).toEqual([second.id]);
    const tagged = await as(a.token).get(
      `/api/linkedin/inbox/threads?tagId=${tag.body.tag.id}&starred=true`
    );
    expect(tagged.body.threads.map((thread: { id: string }) => thread.id)).toEqual([first.id]);

    await as(a.token).patch(`${ORGANIZE}/threads/${second.id}`).send({ archived: true });
    const visible = await as(a.token).get('/api/linkedin/inbox/threads');
    expect(visible.body.threads.map((thread: { id: string }) => thread.id)).toEqual([first.id]);
    const archived = await as(a.token).get('/api/linkedin/inbox/threads?archived=true');
    expect(archived.body.threads.map((thread: { id: string }) => thread.id)).toEqual([second.id]);
    expect((await as(a.token).get('/api/linkedin/inbox/threads?archived=maybe')).status).toBe(400);

    const removed = await as(a.token).delete(`${ORGANIZE}/tags/${tag.body.tag.id}`);
    expect(removed.body).toEqual({ deleted: true, removedAssociations: 1 });
  });

  it("refuses to organize, note or classify another workspace's conversation", async () => {
    const a = await seedSession(id('ws_orgapi'), 'A');
    const b = await seedSession(id('ws_orgapi'), 'B');
    const wsA = a.userId.slice(4);
    const [thread] = await seedThreads(wsA, 1);
    await syncThreadMessages(
      db,
      {
        workspaceId: wsA,
        threadUrn: thread.urn,
        messages: [{ at: NOW.toISOString(), direction: 'in', body: 'Unsubscribe' }]
      },
      NOW
    );
    const message = await db
      .prepare("SELECT id FROM linkedin_messages WHERE workspace_id=? AND direction='in'")
      .get<{ id: string }>(wsA);

    expect(
      (await as(b.token).patch(`${ORGANIZE}/threads/${thread.id}`).send({ starred: true })).status
    ).toBe(404);
    expect(
      (await as(b.token).post(`${ORGANIZE}/threads/${thread.id}/notes`).send({ body: 'Hi' })).status
    ).toBe(404);
    expect(
      (
        await as(b.token)
          .post(`${ORGANIZE}/messages/${message!.id}/classification`)
          .send({ confirmedClass: 'opt_out' })
      ).status
    ).toBe(404);
    expect(
      (await as(b.token).get('/api/linkedin/inbox/threads?archived=any')).body.threads
    ).toEqual([]);

    // The owner sees the stored suggestion with the conversation, and an
    // unknown class is a validation error rather than a state change.
    const detail = await as(a.token).get(
      `/api/linkedin/inbox/threads/${encodeURIComponent(thread.urn)}`
    );
    expect(detail.status).toBe(200);
    expect(detail.body.replyClassifications).toEqual([
      expect.objectContaining({
        messageId: message!.id,
        suggestedClass: 'opt_out',
        status: 'suggested'
      })
    ]);
    expect(
      (
        await as(a.token)
          .post(`${ORGANIZE}/messages/${message!.id}/classification`)
          .send({ confirmedClass: 'spam' })
      ).status
    ).toBe(400);
    const confirmed = await as(a.token)
      .post(`${ORGANIZE}/messages/${message!.id}/classification`)
      .send({ confirmedClass: 'opt_out' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.classification).toMatchObject({
      status: 'confirmed',
      confirmedClass: 'opt_out'
    });

    const note = await as(a.token)
      .post(`${ORGANIZE}/threads/${thread.id}/notes`)
      .send({ body: 'Asked to stop' });
    expect(note.status).toBe(201);
    expect((await as(b.token).get(`${ORGANIZE}/notes/${note.body.note.id}/revisions`)).status).toBe(
      404
    );
    expect((await as(b.token).delete(`${ORGANIZE}/notes/${note.body.note.id}`)).status).toBe(404);
  });

  it('answers a bulk request past 200 with a clear error and changes nothing', async () => {
    const a = await seedSession(id('ws_orgapi'), 'A');
    const threads = await seedThreads(a.userId.slice(4), 201);
    const threadIds = threads.map((thread) => thread.id);

    const over = await as(a.token).post(`${ORGANIZE}/bulk`).send({ threadIds, action: 'archive' });
    expect(over.status).toBe(400);
    expect(over.body).toEqual({
      error:
        'Bulk actions are limited to 200 conversations at a time; 201 were selected. Nothing was changed.'
    });
    expect(
      (await as(a.token).get('/api/linkedin/inbox/threads?archived=true')).body.threads
    ).toEqual([]);

    const atCap = await as(a.token)
      .post(`${ORGANIZE}/bulk`)
      .send({ threadIds: threadIds.slice(0, 200), action: 'star' });
    expect(atCap.status).toBe(200);
    expect(atCap.body).toEqual({ action: 'star', selected: 200, changed: 200 });
    expect(
      (await as(a.token).post(`${ORGANIZE}/bulk`).send({ threadIds: [], action: 'star' })).status
    ).toBe(400);
    expect(
      (
        await as(a.token)
          .post(`${ORGANIZE}/bulk`)
          .send({ threadIds: threadIds.slice(0, 2), action: 'tag' })
      ).status
    ).toBe(400);
  });
});
