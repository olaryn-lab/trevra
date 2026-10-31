import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { LinkedInApiError } from './errors.js';
import { listThreads, readThread, syncThreadMessages, syncThreads } from './inbox.js';
import {
  addNote,
  bulkOrganizeThreads,
  confirmReplyClassification,
  createTag,
  deleteNote,
  deleteTag,
  editNote,
  INBOX_BULK_MAX,
  listAssignableMembers,
  listNoteRevisions,
  listNotes,
  listTags,
  listThreadClassifications,
  tagThread,
  untagThread,
  updateThreadOrganization
} from './inbox-organization.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import { createManagedCampaign, startManagedCampaign } from './managed-campaigns.js';
import { classifyLinkedInReply, REPLY_CLASSIFIER_VERSION } from './reply-classification.js';
import { runManagedCampaigns } from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * TRV-036 inbox organization and TRV-037 reply classification, against real
 * PostgreSQL. Every test mints its own workspaces, so nothing here depends on
 * cleanup order or on another file's rows.
 */

let db: Db;
/** A Monday, 09:00 UTC: inside the seat's working window, so campaigns plan. */
const NOW = new Date('2026-08-03T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  await db?.close();
});

async function workspace(): Promise<string> {
  const workspaceId = id('ws_org');
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, 'Inbox organization test', NOW.toISOString());
  return workspaceId;
}

async function member(workspaceId: string, name: string): Promise<string> {
  const userId = id('usr_org');
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, workspaceId, `${userId}@org.test`, name, NOW.toISOString());
  return userId;
}

const profile = (slug: string) => `https://www.linkedin.com/in/${slug}/`;

/** `count` conversations, newest first by index: thread 0 is the most recent. */
async function seedThreads(
  workspaceId: string,
  count: number,
  slugPrefix = 'lead'
): Promise<Array<{ id: string; urn: string; profileUrl: string }>> {
  const summaries = Array.from({ length: count }, (_, index) => ({
    threadUrn: `2-${slugPrefix}-${index}==`,
    profileUrl: profile(`${slugPrefix}-${index}`),
    name: `Lead ${index}`,
    lastMessageAt: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
    snippet: `Snippet ${index}`,
    unread: false
  }));
  await syncThreads(db, { workspaceId, threads: summaries }, NOW);
  const listed = await listThreads(db, workspaceId, { limit: 500, archived: 'any' });
  return summaries.map((summary) => {
    const row = listed.find((thread) => thread.threadUrn === summary.threadUrn);
    if (!row) throw new Error(`thread ${summary.threadUrn} was not stored`);
    return { id: row.id, urn: row.threadUrn, profileUrl: summary.profileUrl };
  });
}

async function expectApiError(work: Promise<unknown>, status: number, message?: RegExp) {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(LinkedInApiError);
  expect((error as LinkedInApiError).status).toBe(status);
  if (message) expect((error as LinkedInApiError).message).toMatch(message);
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe('classifyLinkedInReply', () => {
  it.each([
    ['Please stop messaging me.', 'opt_out', 'rule:opt_out.explicit', 0.9],
    ['Unsubscribe', 'opt_out', 'rule:opt_out.explicit', 0.9],
    ['Not interested, please stop', 'opt_out', 'rule:opt_out.explicit', 0.9],
    [
      'I am out of the office until Monday with limited access to email.',
      'out_of_office',
      'rule:out_of_office.notice',
      0.85
    ],
    ['Not interested, thanks.', 'not_interested', 'rule:not_interested.explicit', 0.8],
    ['No thanks, we are all set.', 'not_interested', 'rule:not_interested.explicit', 0.8],
    ['You should reach out to Sam, she runs ops.', 'referral', 'rule:referral.redirect', 0.7],
    ["Sounds good, let's talk next week.", 'interested', 'rule:interested.positive', 0.7],
    ['What does it cost?', 'question', 'rule:question.mark', 0.55],
    ['ok', 'other', 'rule:other.fallback', 0.3],
    ['   ', 'other', 'rule:other.empty', 0]
  ])('files %j as %s', (body, replyClass, source, confidence) => {
    expect(classifyLinkedInReply(body)).toEqual({ replyClass, source, confidence });
  });

  it('is deterministic and reads only the new text above a quoted reply', () => {
    const body = 'Sounds great!\n\nOn Mon, Aug 3, 2026 at 9:00 AM Pankaj wrote:\n> please stop';
    expect(classifyLinkedInReply(body)).toEqual(classifyLinkedInReply(body));
    expect(classifyLinkedInReply(body).replyClass).toBe('interested');
  });
});

describe('inbox organization', () => {
  it('keeps every organize operation inside its own workspace', async () => {
    const a = await workspace();
    const b = await workspace();
    const userA = await member(a, 'Ana');
    const userB = await member(b, 'Ben');
    const [threadA] = await seedThreads(a, 1);
    await seedThreads(b, 1);
    const tagA = await createTag(db, { workspaceId: a, name: 'Hot', actorUserId: userA }, NOW);
    await tagThread(
      db,
      { workspaceId: a, threadId: threadA.id, tagId: tagA.id, actorUserId: userA },
      NOW
    );
    await addNote(
      db,
      { workspaceId: a, threadId: threadA.id, body: 'A only', actorUserId: userA },
      NOW
    );

    expect(await listTags(db, b)).toEqual([]);
    expect(await listThreads(db, b, { tagId: tagA.id })).toEqual([]);
    await expectApiError(
      updateThreadOrganization(
        db,
        { workspaceId: b, threadId: threadA.id, actorUserId: userB, starred: true },
        NOW
      ),
      404
    );
    await expectApiError(
      tagThread(
        db,
        { workspaceId: b, threadId: threadA.id, tagId: tagA.id, actorUserId: userB },
        NOW
      ),
      404
    );
    await expectApiError(listNotes(db, b, threadA.id), 404);
    await expectApiError(deleteTag(db, b, tagA.id), 404);
    await expectApiError(
      bulkOrganizeThreads(
        db,
        { workspaceId: b, actorUserId: userB, threadIds: [threadA.id], action: 'archive' },
        NOW
      ),
      404,
      /Nothing was changed/
    );
    // Workspace B's member cannot be assigned in workspace A.
    await expectApiError(
      updateThreadOrganization(
        db,
        { workspaceId: a, threadId: threadA.id, actorUserId: userA, assigneeUserId: userB },
        NOW
      ),
      400,
      /current member/
    );
    expect((await listAssignableMembers(db, a, userA)).map((entry) => entry.userId)).toEqual([
      userA
    ]);

    const [listed] = await listThreads(db, a);
    expect(listed.starred).toBe(false);
    expect(listed.tags).toEqual([{ id: tagA.id, name: 'Hot', color: 'neutral' }]);
  });

  it('filters by tag, assignee, starred, archived and last sender, composably and with pagination', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const teammate = await member(ws, 'Teammate');
    const t = await seedThreads(ws, 8);
    const hot = await createTag(
      db,
      { workspaceId: ws, name: 'Hot', color: 'red', actorUserId: me },
      NOW
    );
    const later = await createTag(db, { workspaceId: ws, name: 'Later', actorUserId: me }, NOW);

    await tagThread(
      db,
      { workspaceId: ws, threadId: t[0].id, tagId: hot.id, actorUserId: me },
      NOW
    );
    await tagThread(
      db,
      { workspaceId: ws, threadId: t[1].id, tagId: hot.id, actorUserId: me },
      NOW
    );
    await tagThread(
      db,
      { workspaceId: ws, threadId: t[2].id, tagId: later.id, actorUserId: me },
      NOW
    );
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: t[0].id, actorUserId: me, starred: true, assigneeUserId: me },
      NOW
    );
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: t[2].id, actorUserId: me, assigneeUserId: teammate },
      NOW
    );
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: t[3].id, actorUserId: me, archived: true, starred: true },
      NOW
    );
    // t4: they wrote last. t5: we wrote last (after their reply).
    await syncThreadMessages(
      db,
      {
        workspaceId: ws,
        threadUrn: t[4].urn,
        messages: [
          { at: '2026-08-03T08:00:00.000Z', direction: 'out', body: 'Hi there' },
          { at: '2026-08-03T08:10:00.000Z', direction: 'in', body: 'Tell me more' }
        ]
      },
      NOW
    );
    await syncThreadMessages(
      db,
      {
        workspaceId: ws,
        threadUrn: t[5].urn,
        messages: [
          { at: '2026-08-03T08:00:00.000Z', direction: 'in', body: 'Who are you?' },
          { at: '2026-08-03T08:10:00.000Z', direction: 'out', body: 'Pankaj, from Trevra' }
        ]
      },
      NOW
    );

    expect(ids(await listThreads(db, ws, { tagId: hot.id }))).toEqual([t[0].id, t[1].id]);
    expect(ids(await listThreads(db, ws, { assigneeUserId: me }))).toEqual([t[0].id]);
    expect(ids(await listThreads(db, ws, { assigneeUserId: teammate }))).toEqual([t[2].id]);
    expect(ids(await listThreads(db, ws, { assigneeUserId: null }))).toEqual(
      [t[1], t[4], t[5], t[6], t[7]].map((thread) => thread.id)
    );
    // Archived is hidden by default, even from the starred filter.
    expect(ids(await listThreads(db, ws, { starred: true }))).toEqual([t[0].id]);
    expect(ids(await listThreads(db, ws))).not.toContain(t[3].id);
    expect(ids(await listThreads(db, ws, { archived: true }))).toEqual([t[3].id]);
    expect(ids(await listThreads(db, ws, { starred: true, archived: 'any' }))).toEqual([
      t[0].id,
      t[3].id
    ]);
    expect(ids(await listThreads(db, ws, { lastFrom: 'lead' }))).toEqual([t[4].id]);
    expect(ids(await listThreads(db, ws, { lastFrom: 'sender' }))).toEqual([t[5].id]);
    expect(ids(await listThreads(db, ws, { hasReply: true }))).toEqual([t[4].id, t[5].id]);
    expect(ids(await listThreads(db, ws, { hasReply: false, assigneeUserId: null }))).toEqual(
      [t[1], t[6], t[7]].map((thread) => thread.id)
    );

    // Combined filters and pagination.
    expect(ids(await listThreads(db, ws, { tagId: hot.id, starred: true }))).toEqual([t[0].id]);
    expect(ids(await listThreads(db, ws, { tagId: hot.id, starred: false }))).toEqual([t[1].id]);
    expect(ids(await listThreads(db, ws, { tagId: hot.id, limit: 1, offset: 1 }))).toEqual([
      t[1].id
    ]);
    const pageOne = await listThreads(db, ws, { assigneeUserId: null, limit: 2, offset: 0 });
    const pageTwo = await listThreads(db, ws, { assigneeUserId: null, limit: 2, offset: 2 });
    const pageThree = await listThreads(db, ws, { assigneeUserId: null, limit: 2, offset: 4 });
    expect([...ids(pageOne), ...ids(pageTwo), ...ids(pageThree)]).toEqual(
      [t[1], t[4], t[5], t[6], t[7]].map((thread) => thread.id)
    );
    expect(ids(await listThreads(db, ws, { search: 'Lead 1', tagId: hot.id }))).toEqual([t[1].id]);

    const [first] = await listThreads(db, ws, { assigneeUserId: me });
    expect(first.assignee).toEqual({ userId: me, name: 'Me', email: `${me}@org.test` });
    expect(first.tags.map((tag) => tag.name)).toEqual(['Hot']);
    expect(first.starred).toBe(true);
  });

  it('backs every organization filter with an index', async () => {
    const indexes = await db
      .prepare(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename IN ('linkedin_thread_tags','linkedin_thread_organization','linkedin_reply_classifications')`
      )
      .all<{ indexname: string; indexdef: string }>();
    const names = indexes.map((index) => index.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_linkedin_thread_tags_tag',
        'idx_linkedin_thread_org_assignee',
        'idx_linkedin_thread_org_starred',
        'idx_linkedin_thread_org_archived',
        'idx_linkedin_reply_classifications_thread'
      ])
    );
  });

  it('deleting a tag removes its associations and nothing else', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const t = await seedThreads(ws, 3);
    const tag = await createTag(db, { workspaceId: ws, name: 'Follow up', actorUserId: me }, NOW);
    const keep = await createTag(db, { workspaceId: ws, name: 'Keep', actorUserId: me }, NOW);
    await tagThread(
      db,
      { workspaceId: ws, threadId: t[0].id, tagId: tag.id, actorUserId: me },
      NOW
    );
    await tagThread(
      db,
      { workspaceId: ws, threadId: t[1].id, tagId: tag.id, actorUserId: me },
      NOW
    );
    await tagThread(
      db,
      { workspaceId: ws, threadId: t[1].id, tagId: keep.id, actorUserId: me },
      NOW
    );
    await expectApiError(
      createTag(db, { workspaceId: ws, name: 'follow UP', actorUserId: me }, NOW),
      409
    );

    expect(await deleteTag(db, ws, tag.id)).toEqual({ deleted: true, removedAssociations: 2 });
    const remaining = await db
      .prepare(
        'SELECT COUNT(*)::int AS n FROM linkedin_thread_tags WHERE workspace_id=? AND tag_id=?'
      )
      .get<{ n: number }>(ws, tag.id);
    expect(remaining?.n).toBe(0);
    expect(ids(await listThreads(db, ws))).toEqual(ids(t));
    expect(
      (await listThreads(db, ws)).map((thread) => thread.tags.map((entry) => entry.name))
    ).toEqual([[], ['Keep'], []]);
    expect((await listTags(db, ws)).map((entry) => [entry.name, entry.threadCount])).toEqual([
      ['Keep', 1]
    ]);
    await untagThread(db, { workspaceId: ws, threadId: t[1].id, tagId: keep.id });
    expect((await listTags(db, ws))[0].threadCount).toBe(0);
  });

  it('requires a current workspace member as assignee and allows reassignment', async () => {
    const ws = await workspace();
    const elsewhere = await workspace();
    const me = await member(ws, 'Me');
    const teammate = await member(ws, 'Teammate');
    const outsider = await member(elsewhere, 'Outsider');
    const [thread] = await seedThreads(ws, 1);

    await expectApiError(
      updateThreadOrganization(
        db,
        { workspaceId: ws, threadId: thread.id, actorUserId: me, assigneeUserId: outsider },
        NOW
      ),
      400,
      /current member/
    );
    await expectApiError(
      updateThreadOrganization(
        db,
        { workspaceId: ws, threadId: thread.id, actorUserId: me, assigneeUserId: 'usr_missing' },
        NOW
      ),
      400
    );
    await expectApiError(
      bulkOrganizeThreads(
        db,
        {
          workspaceId: ws,
          actorUserId: me,
          threadIds: [thread.id],
          action: 'assign',
          assigneeUserId: outsider
        },
        NOW
      ),
      400
    );
    expect((await listThreads(db, ws))[0].assignee).toBeNull();

    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: thread.id, actorUserId: me, assigneeUserId: me },
      NOW
    );
    expect((await listThreads(db, ws))[0].assignee?.userId).toBe(me);
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: thread.id, actorUserId: me, assigneeUserId: teammate },
      NOW
    );
    expect((await listThreads(db, ws))[0].assignee?.userId).toBe(teammate);
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: thread.id, actorUserId: me, assigneeUserId: null },
      NOW
    );
    expect((await listThreads(db, ws))[0].assignee).toBeNull();
    const members = await listAssignableMembers(db, ws, me);
    expect(members.map((entry) => [entry.userId, entry.isMe])).toEqual([
      [me, true],
      [teammate, false]
    ]);
  });

  it('marks read and unread on the existing unread flag, and a new reply un-archives', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const [thread] = await seedThreads(ws, 1);
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: thread.id, actorUserId: me, unread: true },
      NOW
    );
    expect((await listThreads(db, ws, { unread: true }))[0]?.id).toBe(thread.id);
    await updateThreadOrganization(
      db,
      { workspaceId: ws, threadId: thread.id, actorUserId: me, unread: false, archived: true },
      NOW
    );
    expect(await listThreads(db, ws, { unread: true, archived: 'any' })).toEqual([]);
    expect(await listThreads(db, ws)).toEqual([]);

    await syncThreadMessages(
      db,
      {
        workspaceId: ws,
        threadUrn: thread.urn,
        messages: [{ at: NOW.toISOString(), direction: 'in', body: 'Any update?' }]
      },
      NOW
    );
    const [back] = await listThreads(db, ws);
    expect(back?.id).toBe(thread.id);
    expect(back?.archived).toBe(false);
  });

  it('keeps notes authored, versioned and soft-deleted with a full revision trail', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const teammate = await member(ws, 'Teammate');
    const [thread] = await seedThreads(ws, 1);

    const note = await addNote(
      db,
      { workspaceId: ws, threadId: thread.id, body: 'Call on Friday', actorUserId: me },
      NOW
    );
    expect(note).toMatchObject({
      authorUserId: me,
      authorName: 'Me',
      version: 1,
      body: 'Call on Friday'
    });
    await expectApiError(
      editNote(
        db,
        { workspaceId: ws, noteId: note.id, body: 'Hijacked', actorUserId: teammate },
        NOW
      ),
      403
    );
    await expectApiError(
      addNote(
        db,
        { workspaceId: ws, threadId: thread.id, body: 'x'.repeat(4001), actorUserId: me },
        NOW
      ),
      400
    );
    const later = new Date(NOW.getTime() + 60_000);
    const edited = await editNote(
      db,
      { workspaceId: ws, noteId: note.id, body: 'Call on Monday', actorUserId: me },
      later
    );
    expect(edited).toMatchObject({ version: 2, body: 'Call on Monday', updatedByUserId: me });
    await deleteNote(db, { workspaceId: ws, noteId: note.id, actorUserId: me }, later);

    expect(await listNotes(db, ws, thread.id)).toEqual([]);
    const revisions = await listNoteRevisions(db, ws, note.id);
    expect(revisions.map((revision) => [revision.version, revision.action, revision.body])).toEqual(
      [
        [1, 'created', 'Call on Friday'],
        [2, 'edited', 'Call on Monday'],
        [2, 'deleted', 'Call on Monday']
      ]
    );
    const stored = await db
      .prepare('SELECT deleted_by_user_id FROM linkedin_thread_notes WHERE workspace_id=? AND id=?')
      .get<{ deleted_by_user_id: string }>(ws, note.id);
    expect(stored?.deleted_by_user_id).toBe(me);
    await expectApiError(
      editNote(db, { workspaceId: ws, noteId: note.id, body: 'Revived', actorUserId: me }, later),
      404
    );
  });

  it('applies a bulk action at the 200 cap and refuses past it with nothing changed', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const t = await seedThreads(ws, INBOX_BULK_MAX + 1);
    const allIds = ids(t);

    await expectApiError(
      bulkOrganizeThreads(
        db,
        { workspaceId: ws, actorUserId: me, threadIds: allIds, action: 'archive' },
        NOW
      ),
      400,
      /limited to 200 conversations at a time; 201 were selected\. Nothing was changed\./
    );
    expect(await listThreads(db, ws, { archived: true, limit: 500 })).toEqual([]);
    // Duplicates collapse before the cap is counted.
    const atCap = allIds.slice(0, INBOX_BULK_MAX);
    const result = await bulkOrganizeThreads(
      db,
      { workspaceId: ws, actorUserId: me, threadIds: [...atCap, atCap[0]], action: 'archive' },
      NOW
    );
    expect(result).toEqual({
      action: 'archive',
      selected: INBOX_BULK_MAX,
      changed: INBOX_BULK_MAX
    });
    expect(ids(await listThreads(db, ws, { limit: 500 }))).toEqual([allIds[INBOX_BULK_MAX]]);

    const tag = await createTag(db, { workspaceId: ws, name: 'Batch', actorUserId: me }, NOW);
    await bulkOrganizeThreads(
      db,
      { workspaceId: ws, actorUserId: me, threadIds: atCap, action: 'tag', tagId: tag.id },
      NOW
    );
    await bulkOrganizeThreads(
      db,
      { workspaceId: ws, actorUserId: me, threadIds: atCap, action: 'assign', assigneeUserId: me },
      NOW
    );
    await bulkOrganizeThreads(
      db,
      { workspaceId: ws, actorUserId: me, threadIds: atCap, action: 'mark_unread' },
      NOW
    );
    const tagged = await listThreads(db, ws, {
      tagId: tag.id,
      assigneeUserId: me,
      unread: true,
      archived: true,
      limit: 500
    });
    expect(tagged).toHaveLength(INBOX_BULK_MAX);
    await expectApiError(
      bulkOrganizeThreads(
        db,
        {
          workspaceId: ws,
          actorUserId: me,
          threadIds: [...atCap.slice(0, 5), 'lthr_missing'],
          action: 'star'
        },
        NOW
      ),
      404
    );
    expect(await listThreads(db, ws, { starred: true, archived: 'any' })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * TRV-037: suggestions are inert; only a confirmation acts.
 * ---------------------------------------------------------------------- */

async function campaignFor(ws: string, slug: string) {
  await upsertSeat(
    db,
    ws,
    {
      label: 'Owner',
      timezone: 'UTC',
      workingDays: [1, 2, 3, 4, 5],
      workStartMinute: 480,
      workEndMinute: 1080,
      // Established: the planner sizes the seat from the gate's allowance, and
      // a cold ledger admits one invite a day.
      warmupOverride: true
    },
    new Date('2026-01-01T09:00:00.000Z')
  );
  const workflow = await saveWorkflow(
    db,
    {
      workspaceId: ws,
      name: 'Invite',
      steps: [
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: {}
        }
      ]
    },
    NOW
  );
  const list = await createLeadList(db, { workspaceId: ws, name: 'Leads' }, NOW);
  const csv = [
    'First Name,Last Name,Company,Email,LinkedIn URL',
    `Olive,Out,Acme,${slug}@lead.test,https://www.linkedin.com/in/${slug}`,
    `Other,Person,Acme,other-${slug}@lead.test,https://www.linkedin.com/in/other-${slug}`
  ].join('\n');
  await importLeadCsv(db, { workspaceId: ws, listId: list.id, csv }, NOW);
  const made = await createManagedCampaign(
    db,
    { workspaceId: ws, name: 'Campaign', leadListId: list.id, workflowId: workflow.id },
    NOW
  );
  await startManagedCampaign(db, ws, made.campaign.id, NOW);
  await runManagedCampaigns(db, ws, NOW);
  return made.campaign.id;
}

async function memberStatuses(ws: string): Promise<Record<string, string>> {
  const rows = await db
    .prepare(
      `SELECT c.profile_url, m.status FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts c ON c.id = m.contact_id WHERE m.workspace_id=?`
    )
    .all<{ profile_url: string; status: string }>(ws);
  return Object.fromEntries(rows.map((row) => [row.profile_url.replace(/\/$/, ''), row.status]));
}

async function openActions(ws: string): Promise<Array<{ target_ref: string; status: string }>> {
  return db
    .prepare(
      `SELECT target_ref, status FROM linkedin_actions
       WHERE workspace_id=? AND status IN ('planned','held') ORDER BY target_ref`
    )
    .all<{ target_ref: string; status: string }>(ws);
}

async function suppressionCount(ws: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*)::int AS n FROM suppressions WHERE workspace_id=? AND lifted_at IS NULL'
    )
    .get<{ n: number }>(ws);
  return row?.n ?? 0;
}

async function confirmationEvents(ws: string) {
  return db
    .prepare(
      `SELECT stream_id, actor_type, actor_id, payload_json FROM domain_events
       WHERE workspace_id=? AND event_type='linkedin.reply_classification.confirmed' ORDER BY position`
    )
    .all<{
      stream_id: string;
      actor_type: string;
      actor_id: string;
      payload_json: Record<string, unknown>;
    }>(ws);
}

async function replyFrom(ws: string, slug: string, body: string) {
  const urn = `2-${slug}==`;
  await syncThreads(
    db,
    {
      workspaceId: ws,
      threads: [
        {
          threadUrn: urn,
          profileUrl: profile(slug),
          name: 'Olive Out',
          lastMessageAt: NOW.toISOString(),
          snippet: body,
          unread: true
        }
      ]
    },
    NOW
  );
  await syncThreadMessages(
    db,
    {
      workspaceId: ws,
      threadUrn: urn,
      messages: [
        { at: '2026-08-03T08:00:00.000Z', direction: 'out', body: 'Hi Olive, quick question.' },
        { at: '2026-08-03T08:30:00.000Z', direction: 'in', body }
      ]
    },
    NOW
  );
  const conversation = await readThread(db, ws, urn);
  if (!conversation) throw new Error('conversation missing');
  const inboundMessage = conversation.messages.find((message) => message.direction === 'in')!;
  const outboundMessage = conversation.messages.find((message) => message.direction === 'out')!;
  return { conversation, inboundMessage, outboundMessage };
}

describe('reply classification', () => {
  it('stores a suggestion on sync and changes no state until a person confirms it', async () => {
    const ws = await workspace();
    await member(ws, 'Me');
    const slug = 'olive-suggest';
    await campaignFor(ws, slug);
    const before = await openActions(ws);
    expect(before.length).toBeGreaterThan(0);

    const { conversation, inboundMessage } = await replyFrom(ws, slug, 'Please stop messaging me.');
    const stored = await db
      .prepare(
        `SELECT suggested_class, suggested_source, suggested_confidence, classifier_version, status, confirmed_class
         FROM linkedin_reply_classifications WHERE workspace_id=? AND message_id=?`
      )
      .get<Record<string, unknown>>(ws, inboundMessage.id);
    expect(stored).toEqual({
      suggested_class: 'opt_out',
      suggested_source: 'rule:opt_out.explicit',
      suggested_confidence: expect.closeTo(0.9, 5),
      classifier_version: REPLY_CLASSIFIER_VERSION,
      status: 'suggested',
      confirmed_class: null
    });
    expect(await suppressionCount(ws)).toBe(0);
    expect(await openActions(ws)).toEqual(before);
    expect(Object.values(await memberStatuses(ws)).every((status) => status !== 'excluded')).toBe(
      true
    );
    expect(await confirmationEvents(ws)).toEqual([]);

    const [listed] = await listThreads(db, ws);
    expect(listed.replySuggestion).toMatchObject({
      messageId: inboundMessage.id,
      suggestedClass: 'opt_out',
      status: 'suggested',
      confirmedClass: null
    });
    const views = await listThreadClassifications(
      db,
      ws,
      conversation.thread.id,
      conversation.messages
    );
    expect(views.map((view) => [view.messageId, view.status, view.suggestedClass])).toEqual([
      [inboundMessage.id, 'suggested', 'opt_out']
    ]);
  });

  it('a confirmed opt-out suppresses, ends membership and leaves no planned or held actions', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const slug = 'olive-optout';
    await campaignFor(ws, slug);
    // Outside any campaign, in other spellings of the same person.
    await recordAction(
      db,
      {
        workspaceId: ws,
        kind: 'dm',
        targetRef: slug,
        status: 'held',
        campaignId: null,
        source: 'export'
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: ws,
        kind: 'follow',
        targetRef: `https://linkedin.com/in/${slug}?trk=abc`,
        status: 'planned',
        campaignId: null,
        source: 'export'
      },
      NOW
    );
    const { conversation, inboundMessage } = await replyFrom(
      ws,
      slug,
      'Not for me. Please stop messaging me.'
    );

    const confirmed = await confirmReplyClassification(
      db,
      { workspaceId: ws, messageId: inboundMessage.id, confirmedClass: 'opt_out', actorUserId: me },
      NOW
    );
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      confirmedClass: 'opt_out',
      confirmedByUserId: me
    });
    expect(confirmed.effects.suppressionId).toMatch(/^sup/);
    expect(confirmed.effects.endedMemberIds).toHaveLength(1);

    const suppression = await db
      .prepare(
        'SELECT channel, linkedin_url, source, source_ref, created_by_type, created_by_id FROM suppressions WHERE workspace_id=?'
      )
      .all<Record<string, unknown>>(ws);
    expect(suppression).toEqual([
      {
        channel: 'linkedin',
        linkedin_url: `https://www.linkedin.com/in/${slug}/`,
        source: 'linkedin_reply_classification',
        source_ref: confirmed.id,
        created_by_type: 'human',
        created_by_id: me
      }
    ]);
    const statuses = await memberStatuses(ws);
    expect(statuses[`https://www.linkedin.com/in/${slug}`]).toBe('excluded');
    expect(statuses[`https://www.linkedin.com/in/other-${slug}`]).not.toBe('excluded');
    const open = await openActions(ws);
    expect(
      open.filter(
        (action) =>
          action.target_ref.toLowerCase().includes(`/${slug}`) || action.target_ref === slug
      )
    ).toEqual([]);
    expect(open.some((action) => action.target_ref.includes(`other-${slug}`))).toBe(true);

    const events = await confirmationEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stream_id: conversation.thread.id,
      actor_type: 'human',
      actor_id: me
    });
    expect(events[0].payload_json).toMatchObject({
      messageId: inboundMessage.id,
      suggestedClass: 'opt_out',
      confirmedClass: 'opt_out',
      changedFromSuggestion: false
    });
    expect(JSON.stringify(events[0].payload_json)).not.toContain('stop messaging');

    // Re-confirming is a no-op; a different class after confirmation is refused.
    await confirmReplyClassification(
      db,
      { workspaceId: ws, messageId: inboundMessage.id, confirmedClass: 'opt_out', actorUserId: me },
      NOW
    );
    expect(await confirmationEvents(ws)).toHaveLength(1);
    expect(await suppressionCount(ws)).toBe(1);
    await expectApiError(
      confirmReplyClassification(
        db,
        {
          workspaceId: ws,
          messageId: inboundMessage.id,
          confirmedClass: 'interested',
          actorUserId: me
        },
        NOW
      ),
      409
    );
    const [listed] = await listThreads(db, ws);
    expect(listed.replySuggestion).toMatchObject({
      status: 'confirmed',
      confirmedClass: 'opt_out'
    });
  });

  it('lets a person change the class; interested and plain not-interested change no outreach', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const slug = 'olive-change';
    await campaignFor(ws, slug);
    const before = await openActions(ws);
    const { inboundMessage, outboundMessage } = await replyFrom(
      ws,
      slug,
      'Please stop messaging me.'
    );

    await expectApiError(
      confirmReplyClassification(
        db,
        {
          workspaceId: ws,
          messageId: outboundMessage.id,
          confirmedClass: 'interested',
          actorUserId: me
        },
        NOW
      ),
      400
    );
    const changed = await confirmReplyClassification(
      db,
      {
        workspaceId: ws,
        messageId: inboundMessage.id,
        confirmedClass: 'interested',
        actorUserId: me
      },
      NOW
    );
    expect(changed).toMatchObject({
      suggestedClass: 'opt_out',
      confirmedClass: 'interested',
      effects: {}
    });
    expect(await suppressionCount(ws)).toBe(0);
    expect(await openActions(ws)).toEqual(before);
    const [event] = await confirmationEvents(ws);
    expect(event.payload_json).toMatchObject({
      changedFromSuggestion: true,
      confirmedClass: 'interested'
    });
  });

  it('not-interested ends membership only when asked to', async () => {
    const ws = await workspace();
    const me = await member(ws, 'Me');
    const quiet = 'olive-quiet';
    await campaignFor(ws, quiet);
    const first = await replyFrom(ws, quiet, 'Not interested, thanks.');
    const quietBefore = await openActions(ws);
    const kept = await confirmReplyClassification(
      db,
      {
        workspaceId: ws,
        messageId: first.inboundMessage.id,
        confirmedClass: 'not_interested',
        actorUserId: me
      },
      NOW
    );
    expect(kept.effects).toEqual({});
    expect((await memberStatuses(ws))[`https://www.linkedin.com/in/${quiet}`]).toBe('waiting');
    expect(await openActions(ws)).toEqual(quietBefore);

    const ws2 = await workspace();
    const me2 = await member(ws2, 'Me');
    const done = 'olive-done';
    await campaignFor(ws2, done);
    const second = await replyFrom(ws2, done, 'Not interested, thanks.');
    expect((await memberStatuses(ws2))[`https://www.linkedin.com/in/${done}`]).toBe('waiting');
    const result = await confirmReplyClassification(
      db,
      {
        workspaceId: ws2,
        messageId: second.inboundMessage.id,
        confirmedClass: 'not_interested',
        endMembership: true,
        actorUserId: me2
      },
      NOW
    );
    const statuses = await memberStatuses(ws2);
    expect(statuses[`https://www.linkedin.com/in/${done}`]).toBe('removed');
    expect(statuses[`https://www.linkedin.com/in/other-${done}`]).toBe('waiting');
    expect(result.effects.endedMemberIds).toHaveLength(1);
    // Ending the membership withdraws the campaign's own queued step for them.
    expect((await openActions(ws2)).map((action) => action.target_ref)).toEqual([
      `https://www.linkedin.com/in/other-${done}/`
    ]);
    expect(await suppressionCount(ws2)).toBe(0);
  });

  it('refuses to classify a message from another workspace', async () => {
    const ws = await workspace();
    const other = await workspace();
    const me = await member(ws, 'Me');
    const otherMe = await member(other, 'Other');
    const { inboundMessage } = await replyFrom(ws, 'olive-isolated', 'Sounds good');
    await expectApiError(
      confirmReplyClassification(
        db,
        {
          workspaceId: other,
          messageId: inboundMessage.id,
          confirmedClass: 'opt_out',
          actorUserId: otherMe
        },
        NOW
      ),
      404
    );
    expect(await suppressionCount(ws)).toBe(0);
    expect(await suppressionCount(other)).toBe(0);
    void me;
  });
});
