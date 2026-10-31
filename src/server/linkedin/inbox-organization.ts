import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { createSuppression } from '../suppressions.js';
import { LinkedInApiError } from './errors.js';
import { targetRefCandidates } from './inbox.js';
import { endManagedCampaignMember } from './managed-campaigns.js';
import {
  classifyLinkedInReply,
  REPLY_CLASSIFIER_VERSION,
  storeReplySuggestions,
  type ReplyClass
} from './reply-classification.js';

/**
 * TRV-036 / TRV-037: organizing stored LinkedIn conversations, and acting on a
 * human-confirmed reply class.
 *
 * ORGANIZED AT `linkedin_threads`, the rows `/outreach/inbox` lists (migration
 * 152). Every statement here names `workspace_id`; a thread, tag, note or
 * message id from another workspace reads as not found.
 *
 * ONLY A CONFIRMED CLASS DRIVES STATE. The deterministic classifier files
 * suggestions (reply-classification.ts). `confirmReplyClassification` is the one
 * path from a class to a consequence, it runs in one transaction, and it records
 * a domain event carrying identifiers and counts, never message text.
 */

export const INBOX_TAG_COLORS = ['neutral', 'green', 'blue', 'amber', 'red'] as const;
export type InboxTagColor = (typeof INBOX_TAG_COLORS)[number];

/** Most conversations one bulk request may change. Past it, nothing changes. */
export const INBOX_BULK_MAX = 200;
/** Tag catalog ceiling per workspace: a picker, not a free-text label store. */
export const INBOX_TAG_MAX = 100;
/** Live (not deleted) notes per conversation; the panel never truncates. */
export const THREAD_NOTE_MAX = 200;
export const THREAD_NOTE_BODY_MAX = 4000;

export const INBOX_BULK_ACTIONS = [
  'archive',
  'unarchive',
  'star',
  'unstar',
  'mark_read',
  'mark_unread',
  'tag',
  'untag',
  'assign',
  'unassign'
] as const;
export type InboxBulkAction = (typeof INBOX_BULK_ACTIONS)[number];

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ACTIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'];

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

/* -------------------------------------------------------------------------
 * Tags.
 * ---------------------------------------------------------------------- */

export interface InboxTag {
  id: string;
  name: string;
  color: InboxTagColor;
  threadCount: number;
  createdAt: string;
}

interface TagRow {
  id: string;
  name: string;
  color: InboxTagColor;
  thread_count: number;
  created_at: unknown;
}

function toTag(row: TagRow): InboxTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    threadCount: Number(row.thread_count ?? 0),
    createdAt: iso(row.created_at) ?? ''
  };
}

const TAG_COLUMNS = `
  g.id, g.name, g.color,
  TO_CHAR(g.created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  (SELECT COUNT(*) FROM linkedin_thread_tags tt
    WHERE tt.workspace_id = g.workspace_id AND tt.tag_id = g.id)::int AS thread_count
`;

export async function listTags(db: Db, workspaceId: string): Promise<InboxTag[]> {
  const rows = await db
    .prepare(
      `SELECT ${TAG_COLUMNS} FROM linkedin_inbox_tags g WHERE g.workspace_id=? ORDER BY LOWER(g.name), g.id`
    )
    .all<TagRow>(workspaceId);
  return rows.map(toTag);
}

async function tagById(db: Db, workspaceId: string, tagId: string): Promise<InboxTag | undefined> {
  const row = await db
    .prepare(`SELECT ${TAG_COLUMNS} FROM linkedin_inbox_tags g WHERE g.workspace_id=? AND g.id=?`)
    .get<TagRow>(workspaceId, tagId);
  return row ? toTag(row) : undefined;
}

function tagName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 40)
    throw new LinkedInApiError('A tag name must be 1 to 40 characters.', 400);
  return name;
}

export async function createTag(
  db: Db,
  input: { workspaceId: string; name: string; color?: InboxTagColor; actorUserId: string },
  now: Date
): Promise<InboxTag> {
  const name = tagName(input.name);
  return db.transactionOrInline(async (tx) => {
    // Serializes creates per workspace so the catalog ceiling holds under races.
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))')
      .get(`linkedin-inbox-tags:${input.workspaceId}`);
    const count = await tx
      .prepare('SELECT COUNT(*)::int AS n FROM linkedin_inbox_tags WHERE workspace_id=?')
      .get<{ n: number }>(input.workspaceId);
    if ((count?.n ?? 0) >= INBOX_TAG_MAX)
      throw new LinkedInApiError(
        `This workspace already has ${INBOX_TAG_MAX} inbox tags. Delete one before adding another.`,
        409
      );
    const tagId = id('ltag');
    const inserted = await tx
      .prepare(
        `INSERT INTO linkedin_inbox_tags (id, workspace_id, name, color, created_by_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?::timestamptz,?::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id`
      )
      .get<{ id: string }>(
        tagId,
        input.workspaceId,
        name,
        input.color ?? 'neutral',
        input.actorUserId,
        now.toISOString(),
        now.toISOString()
      );
    if (!inserted) throw new LinkedInApiError(`A tag named “${name}” already exists.`, 409);
    const tag = await tagById(tx, input.workspaceId, tagId);
    if (!tag) throw new LinkedInApiError('Tag could not be stored.', 500);
    return tag;
  });
}

export async function updateTag(
  db: Db,
  input: { workspaceId: string; tagId: string; name?: string; color?: InboxTagColor },
  now: Date
): Promise<InboxTag> {
  const name = input.name === undefined ? null : tagName(input.name);
  let result;
  try {
    result = await db
      .prepare(
        `UPDATE linkedin_inbox_tags SET name=COALESCE(?::text, name), color=COALESCE(?::text, color), updated_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(name, input.color ?? null, now.toISOString(), input.workspaceId, input.tagId);
  } catch (error) {
    if (isUniqueViolation(error))
      throw new LinkedInApiError(`A tag named “${name}” already exists.`, 409);
    throw error;
  }
  if (result.changes === 0) throw new LinkedInApiError('Tag not found', 404);
  const tag = await tagById(db, input.workspaceId, input.tagId);
  if (!tag) throw new LinkedInApiError('Tag not found', 404);
  return tag;
}

/** Deletes the tag; the composite foreign key removes every association. */
export async function deleteTag(
  db: Db,
  workspaceId: string,
  tagId: string
): Promise<{ deleted: true; removedAssociations: number }> {
  return db.transactionOrInline(async (tx) => {
    const tag = await tx
      .prepare('SELECT id FROM linkedin_inbox_tags WHERE workspace_id=? AND id=? FOR UPDATE')
      .get<{ id: string }>(workspaceId, tagId);
    if (!tag) throw new LinkedInApiError('Tag not found', 404);
    const count = await tx
      .prepare(
        'SELECT COUNT(*)::int AS n FROM linkedin_thread_tags WHERE workspace_id=? AND tag_id=?'
      )
      .get<{ n: number }>(workspaceId, tagId);
    await tx
      .prepare('DELETE FROM linkedin_inbox_tags WHERE workspace_id=? AND id=?')
      .run(workspaceId, tagId);
    return { deleted: true as const, removedAssociations: count?.n ?? 0 };
  });
}

async function requireThread(db: Db, workspaceId: string, threadId: string): Promise<void> {
  const row = await db
    .prepare('SELECT id FROM linkedin_threads WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(workspaceId, threadId);
  if (!row) throw new LinkedInApiError('LinkedIn conversation not found', 404);
}

async function requireTag(db: Db, workspaceId: string, tagId: string): Promise<void> {
  const row = await db
    .prepare('SELECT id FROM linkedin_inbox_tags WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(workspaceId, tagId);
  if (!row) throw new LinkedInApiError('Tag not found', 404);
}

export async function tagThread(
  db: Db,
  input: { workspaceId: string; threadId: string; tagId: string; actorUserId: string },
  now: Date
): Promise<void> {
  await requireThread(db, input.workspaceId, input.threadId);
  await requireTag(db, input.workspaceId, input.tagId);
  await db
    .prepare(
      `INSERT INTO linkedin_thread_tags (thread_id, tag_id, workspace_id, tagged_by_user_id, created_at)
       VALUES (?,?,?,?,?::timestamptz) ON CONFLICT (thread_id, tag_id) DO NOTHING`
    )
    .run(input.threadId, input.tagId, input.workspaceId, input.actorUserId, now.toISOString());
}

export async function untagThread(
  db: Db,
  input: { workspaceId: string; threadId: string; tagId: string }
): Promise<void> {
  await requireThread(db, input.workspaceId, input.threadId);
  await db
    .prepare('DELETE FROM linkedin_thread_tags WHERE workspace_id=? AND thread_id=? AND tag_id=?')
    .run(input.workspaceId, input.threadId, input.tagId);
}

/* -------------------------------------------------------------------------
 * Assignment. The assignee must be a current member of the workspace.
 * ---------------------------------------------------------------------- */

export interface AssignableMember {
  /** Trevra `users.id`: the value stored as the assignee. */
  userId: string;
  name: string;
  email: string;
  isMe: boolean;
}

/**
 * Better Auth owns `member`/`"user"` and creates them at runtime, so a database
 * without them (tests, a pre-auth install) falls back to home-workspace
 * membership only. `to_regclass` rather than a caught error: a failed statement
 * would abort the surrounding transaction.
 */
async function betterAuthMembershipPresent(db: Db): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT (to_regclass('public.member') IS NOT NULL AND to_regclass('public."user"') IS NOT NULL) AS present`
    )
    .get<{ present: boolean }>();
  return row?.present === true;
}

export async function listAssignableMembers(
  db: Db,
  workspaceId: string,
  currentUserId: string
): Promise<AssignableMember[]> {
  const withAuth = await betterAuthMembershipPresent(db);
  // Every Trevra user owns exactly one home workspace; teammates join others
  // through Better Auth membership, matched to Trevra users by email.
  const rows = await db
    .prepare(
      withAuth
        ? `SELECT u.id, u.name, u.email FROM users u WHERE u.workspace_id=?
           UNION
           SELECT u.id, u.name, u.email FROM member m
           JOIN "user" au ON au.id = m."userId"
           JOIN users u ON lower(u.email) = lower(au.email)
           WHERE m."organizationId"=?
           ORDER BY 2, 1`
        : `SELECT u.id, u.name, u.email FROM users u WHERE u.workspace_id=? ORDER BY 2, 1`
    )
    .all<{ id: string; name: string | null; email: string }>(
      ...(withAuth ? [workspaceId, workspaceId] : [workspaceId])
    );
  return rows.map((row) => ({
    userId: row.id,
    name: row.name?.trim() || row.email,
    email: row.email,
    isMe: row.id === currentUserId
  }));
}

/** Accepts a Trevra user id or a Better Auth user id; returns the Trevra id. */
export async function resolveAssignee(
  db: Db,
  workspaceId: string,
  candidate: string
): Promise<string> {
  const refused = new LinkedInApiError('Assignee must be a current member of this workspace', 400);
  const withAuth = await betterAuthMembershipPresent(db);
  let user = await db
    .prepare('SELECT id, email, workspace_id FROM users WHERE id=?')
    .get<{ id: string; email: string; workspace_id: string }>(candidate);
  if (!user && withAuth) {
    user = await db
      .prepare(
        `SELECT u.id, u.email, u.workspace_id FROM "user" au
         JOIN users u ON lower(u.email) = lower(au.email) WHERE au.id=? LIMIT 1`
      )
      .get<{ id: string; email: string; workspace_id: string }>(candidate);
  }
  if (!user) throw refused;
  if (user.workspace_id === workspaceId) return user.id;
  if (!withAuth) throw refused;
  const member = await db
    .prepare(
      `SELECT 1 AS ok FROM member m JOIN "user" au ON au.id = m."userId"
       WHERE m."organizationId"=? AND lower(au.email) = lower(?) LIMIT 1`
    )
    .get<{ ok: number }>(workspaceId, user.email);
  if (!member) throw refused;
  return user.id;
}

/* -------------------------------------------------------------------------
 * Flags, read state and assignment, for one conversation or a bulk selection.
 * ---------------------------------------------------------------------- */

export interface ThreadOrganizationChange {
  starred?: boolean;
  archived?: boolean;
  /** Writes the existing `linkedin_threads.unread`; the next sync replaces it with LinkedIn's badge. */
  unread?: boolean;
  /** A user id to assign, null to unassign, undefined to leave as is. */
  assigneeUserId?: string | null;
}

/** Applies one change to threads already proven to be in the workspace. */
async function applyOrganization(
  tx: Db,
  workspaceId: string,
  threadIds: readonly string[],
  change: ThreadOrganizationChange & { assigneeResolved?: string | null },
  actorUserId: string,
  now: Date
): Promise<number> {
  const timestamp = now.toISOString();
  let changed = 0;
  if (change.unread !== undefined) {
    const result = await tx
      .prepare(
        'UPDATE linkedin_threads SET unread=? WHERE workspace_id=? AND id = ANY(?::text[]) AND unread IS DISTINCT FROM ?'
      )
      .run(change.unread, workspaceId, threadIds, change.unread);
    changed = Math.max(changed, result.changes);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (change.starred !== undefined) {
    sets.push('starred=?');
    params.push(change.starred);
  }
  if (change.archived !== undefined) {
    sets.push(
      'archived=?',
      'archived_at=CASE WHEN ?::boolean THEN COALESCE(archived_at, ?::timestamptz) ELSE NULL END'
    );
    params.push(change.archived, change.archived, timestamp);
  }
  if (change.assigneeResolved !== undefined) {
    const assignee = change.assigneeResolved;
    sets.push('assignee_user_id=?', 'assigned_by_user_id=?', 'assigned_at=?::timestamptz');
    params.push(assignee, assignee ? actorUserId : null, assignee ? timestamp : null);
  }
  if (sets.length === 0) return changed;
  await tx
    .prepare(
      `INSERT INTO linkedin_thread_organization (thread_id, workspace_id, updated_at)
       SELECT x.thread_id, ?, ?::timestamptz FROM unnest(?::text[]) AS x(thread_id)
       ON CONFLICT (thread_id) DO NOTHING`
    )
    .run(workspaceId, timestamp, threadIds);
  const result = await tx
    .prepare(
      `UPDATE linkedin_thread_organization SET ${sets.join(', ')}, updated_by_user_id=?, updated_at=?::timestamptz
       WHERE workspace_id=? AND thread_id = ANY(?::text[])`
    )
    .run(...params, actorUserId, timestamp, workspaceId, threadIds);
  return Math.max(changed, result.changes);
}

export async function updateThreadOrganization(
  db: Db,
  input: ThreadOrganizationChange & { workspaceId: string; threadId: string; actorUserId: string },
  now: Date
): Promise<void> {
  await requireThread(db, input.workspaceId, input.threadId);
  const assigneeResolved =
    input.assigneeUserId === undefined
      ? undefined
      : input.assigneeUserId === null
        ? null
        : await resolveAssignee(db, input.workspaceId, input.assigneeUserId);
  await db.transactionOrInline((tx) =>
    applyOrganization(
      tx,
      input.workspaceId,
      [input.threadId],
      { ...input, assigneeResolved },
      input.actorUserId,
      now
    )
  );
}

export interface BulkOrganizeInput {
  workspaceId: string;
  actorUserId: string;
  threadIds: readonly string[];
  action: InboxBulkAction;
  tagId?: string;
  assigneeUserId?: string;
}

export interface BulkOrganizeResult {
  action: InboxBulkAction;
  selected: number;
  changed: number;
}

/**
 * All or nothing: more than INBOX_BULK_MAX ids, an id outside the workspace, a
 * missing tag or a non-member assignee refuses the whole request unchanged.
 */
export async function bulkOrganizeThreads(
  db: Db,
  input: BulkOrganizeInput,
  now: Date
): Promise<BulkOrganizeResult> {
  const threadIds = [...new Set(input.threadIds.map((value) => value.trim()).filter(Boolean))];
  if (threadIds.length === 0) throw new LinkedInApiError('Select at least one conversation.', 400);
  if (threadIds.length > INBOX_BULK_MAX)
    throw new LinkedInApiError(
      `Bulk actions are limited to ${INBOX_BULK_MAX} conversations at a time; ${threadIds.length} were selected. Nothing was changed.`,
      400
    );
  if ((input.action === 'tag' || input.action === 'untag') && !input.tagId)
    throw new LinkedInApiError('Choose a tag for this bulk action.', 400);
  if (input.action === 'assign' && !input.assigneeUserId)
    throw new LinkedInApiError('Choose who to assign these conversations to.', 400);

  const assigneeResolved =
    input.action === 'assign'
      ? await resolveAssignee(db, input.workspaceId, input.assigneeUserId!)
      : input.action === 'unassign'
        ? null
        : undefined;

  return db.transactionOrInline(async (tx) => {
    const found = await tx
      .prepare('SELECT id FROM linkedin_threads WHERE workspace_id=? AND id = ANY(?::text[])')
      .all<{ id: string }>(input.workspaceId, threadIds);
    if (found.length !== threadIds.length)
      throw new LinkedInApiError(
        `${threadIds.length - found.length} of the selected conversations were not found in this workspace. Nothing was changed.`,
        404
      );
    let changed = 0;
    const timestamp = now.toISOString();
    switch (input.action) {
      case 'tag': {
        await requireTag(tx, input.workspaceId, input.tagId!);
        const result = await tx
          .prepare(
            `INSERT INTO linkedin_thread_tags (thread_id, tag_id, workspace_id, tagged_by_user_id, created_at)
             SELECT x.thread_id, ?, ?, ?, ?::timestamptz FROM unnest(?::text[]) AS x(thread_id)
             ON CONFLICT (thread_id, tag_id) DO NOTHING`
          )
          .run(input.tagId, input.workspaceId, input.actorUserId, timestamp, threadIds);
        changed = result.changes;
        break;
      }
      case 'untag': {
        await requireTag(tx, input.workspaceId, input.tagId!);
        const result = await tx
          .prepare(
            'DELETE FROM linkedin_thread_tags WHERE workspace_id=? AND tag_id=? AND thread_id = ANY(?::text[])'
          )
          .run(input.workspaceId, input.tagId, threadIds);
        changed = result.changes;
        break;
      }
      default: {
        const change: ThreadOrganizationChange & { assigneeResolved?: string | null } =
          input.action === 'archive' || input.action === 'unarchive'
            ? { archived: input.action === 'archive' }
            : input.action === 'star' || input.action === 'unstar'
              ? { starred: input.action === 'star' }
              : input.action === 'mark_read' || input.action === 'mark_unread'
                ? { unread: input.action === 'mark_unread' }
                : { assigneeResolved };
        changed = await applyOrganization(
          tx,
          input.workspaceId,
          threadIds,
          change,
          input.actorUserId,
          now
        );
      }
    }
    return { action: input.action, selected: threadIds.length, changed };
  });
}

/* -------------------------------------------------------------------------
 * Notes: authored, timestamped, versioned, soft-deleted, with full history.
 * ---------------------------------------------------------------------- */

export interface ThreadNote {
  id: string;
  threadId: string;
  body: string;
  version: number;
  authorUserId: string;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface ThreadNoteRevision {
  id: string;
  noteId: string;
  version: number;
  action: 'created' | 'edited' | 'deleted';
  body: string;
  actorUserId: string;
  actorName: string | null;
  createdAt: string;
}

interface NoteRow {
  id: string;
  thread_id: string;
  body: string;
  version: number;
  author_user_id: string;
  author_name: string | null;
  created_at: unknown;
  updated_at: unknown;
  updated_by_user_id: string | null;
}

const NOTE_COLUMNS = `
  n.id, n.thread_id, n.body, n.version, n.author_user_id,
  COALESCE(NULLIF(BTRIM(u.name), ''), u.email) AS author_name,
  TO_CHAR(n.created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  TO_CHAR(n.updated_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS updated_at,
  n.updated_by_user_id
`;

function toNote(row: NoteRow): ThreadNote {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    version: Number(row.version),
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? null,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
    updatedByUserId: row.updated_by_user_id ?? null
  };
}

function noteBody(value: string): string {
  const body = value.trim();
  if (body.length < 1 || body.length > THREAD_NOTE_BODY_MAX)
    throw new LinkedInApiError(`A note must be 1 to ${THREAD_NOTE_BODY_MAX} characters.`, 400);
  return body;
}

async function noteById(db: Db, workspaceId: string, noteId: string): Promise<ThreadNote> {
  const row = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS} FROM linkedin_thread_notes n LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.workspace_id=? AND n.id=?`
    )
    .get<NoteRow>(workspaceId, noteId);
  if (!row) throw new LinkedInApiError('Note not found', 404);
  return toNote(row);
}

export async function listNotes(
  db: Db,
  workspaceId: string,
  threadId: string
): Promise<ThreadNote[]> {
  await requireThread(db, workspaceId, threadId);
  const rows = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS} FROM linkedin_thread_notes n LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.workspace_id=? AND n.thread_id=? AND n.deleted_at IS NULL
       ORDER BY n.created_at ASC, n.id ASC`
    )
    .all<NoteRow>(workspaceId, threadId);
  return rows.map(toNote);
}

async function insertRevision(
  tx: Db,
  workspaceId: string,
  noteId: string,
  version: number,
  action: ThreadNoteRevision['action'],
  body: string,
  actorUserId: string,
  now: Date
): Promise<void> {
  await tx
    .prepare(
      `INSERT INTO linkedin_thread_note_revisions (id, workspace_id, note_id, version, action, body, actor_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?::timestamptz)`
    )
    .run(id('lnrv'), workspaceId, noteId, version, action, body, actorUserId, now.toISOString());
}

export async function addNote(
  db: Db,
  input: { workspaceId: string; threadId: string; body: string; actorUserId: string },
  now: Date
): Promise<ThreadNote> {
  const body = noteBody(input.body);
  return db.transactionOrInline(async (tx) => {
    await requireThread(tx, input.workspaceId, input.threadId);
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))')
      .get(`linkedin-thread-notes:${input.threadId}`);
    const live = await tx
      .prepare(
        'SELECT COUNT(*)::int AS n FROM linkedin_thread_notes WHERE workspace_id=? AND thread_id=? AND deleted_at IS NULL'
      )
      .get<{ n: number }>(input.workspaceId, input.threadId);
    if ((live?.n ?? 0) >= THREAD_NOTE_MAX)
      throw new LinkedInApiError(
        `This conversation already has ${THREAD_NOTE_MAX} notes. Delete one before adding another.`,
        409
      );
    const noteId = id('lnote');
    const timestamp = now.toISOString();
    await tx
      .prepare(
        `INSERT INTO linkedin_thread_notes (id, workspace_id, thread_id, author_user_id, body, version, created_at, updated_at, updated_by_user_id)
         VALUES (?,?,?,?,?,1,?::timestamptz,?::timestamptz,?)`
      )
      .run(
        noteId,
        input.workspaceId,
        input.threadId,
        input.actorUserId,
        body,
        timestamp,
        timestamp,
        input.actorUserId
      );
    await insertRevision(tx, input.workspaceId, noteId, 1, 'created', body, input.actorUserId, now);
    return noteById(tx, input.workspaceId, noteId);
  });
}

async function lockNoteForAuthor(
  tx: Db,
  workspaceId: string,
  noteId: string,
  actorUserId: string,
  act: string
): Promise<{ body: string; version: number }> {
  const row = await tx
    .prepare(
      `SELECT body, version, author_user_id FROM linkedin_thread_notes
       WHERE workspace_id=? AND id=? AND deleted_at IS NULL FOR UPDATE`
    )
    .get<{ body: string; version: number; author_user_id: string }>(workspaceId, noteId);
  if (!row) throw new LinkedInApiError('Note not found', 404);
  if (row.author_user_id !== actorUserId)
    throw new LinkedInApiError(`Only the note’s author can ${act} it.`, 403);
  return { body: row.body, version: Number(row.version) };
}

export async function editNote(
  db: Db,
  input: { workspaceId: string; noteId: string; body: string; actorUserId: string },
  now: Date
): Promise<ThreadNote> {
  const body = noteBody(input.body);
  return db.transactionOrInline(async (tx) => {
    const current = await lockNoteForAuthor(
      tx,
      input.workspaceId,
      input.noteId,
      input.actorUserId,
      'edit'
    );
    if (current.body === body) return noteById(tx, input.workspaceId, input.noteId);
    const version = current.version + 1;
    await tx
      .prepare(
        `UPDATE linkedin_thread_notes SET body=?, version=?, updated_at=?::timestamptz, updated_by_user_id=?
         WHERE workspace_id=? AND id=?`
      )
      .run(body, version, now.toISOString(), input.actorUserId, input.workspaceId, input.noteId);
    await insertRevision(
      tx,
      input.workspaceId,
      input.noteId,
      version,
      'edited',
      body,
      input.actorUserId,
      now
    );
    return noteById(tx, input.workspaceId, input.noteId);
  });
}

export async function deleteNote(
  db: Db,
  input: { workspaceId: string; noteId: string; actorUserId: string },
  now: Date
): Promise<{ deleted: true }> {
  return db.transactionOrInline(async (tx) => {
    const current = await lockNoteForAuthor(
      tx,
      input.workspaceId,
      input.noteId,
      input.actorUserId,
      'delete'
    );
    await tx
      .prepare(
        `UPDATE linkedin_thread_notes SET deleted_at=?::timestamptz, deleted_by_user_id=?
         WHERE workspace_id=? AND id=?`
      )
      .run(now.toISOString(), input.actorUserId, input.workspaceId, input.noteId);
    await insertRevision(
      tx,
      input.workspaceId,
      input.noteId,
      current.version,
      'deleted',
      current.body,
      input.actorUserId,
      now
    );
    return { deleted: true as const };
  });
}

/** The full audit trail, including for a note that has since been deleted. */
export async function listNoteRevisions(
  db: Db,
  workspaceId: string,
  noteId: string
): Promise<ThreadNoteRevision[]> {
  const note = await db
    .prepare('SELECT id FROM linkedin_thread_notes WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(workspaceId, noteId);
  if (!note) throw new LinkedInApiError('Note not found', 404);
  const rows = await db
    .prepare(
      `SELECT r.id, r.note_id, r.version, r.action, r.body, r.actor_user_id,
         COALESCE(NULLIF(BTRIM(u.name), ''), u.email) AS actor_name,
         TO_CHAR(r.created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at
       FROM linkedin_thread_note_revisions r LEFT JOIN users u ON u.id = r.actor_user_id
       WHERE r.workspace_id=? AND r.note_id=?
       -- Version, then lifecycle, is a total order that never depends on clock
       -- ties: created is v1, each edit bumps it, and a delete is terminal at
       -- the last version.
       ORDER BY r.version ASC,
         CASE r.action WHEN 'created' THEN 0 WHEN 'edited' THEN 1 ELSE 2 END ASC`
    )
    .all<{
      id: string;
      note_id: string;
      version: number;
      action: ThreadNoteRevision['action'];
      body: string;
      actor_user_id: string;
      actor_name: string | null;
      created_at: unknown;
    }>(workspaceId, noteId);
  return rows.map((row) => ({
    id: row.id,
    noteId: row.note_id,
    version: Number(row.version),
    action: row.action,
    body: row.body,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name ?? null,
    createdAt: iso(row.created_at) ?? ''
  }));
}

/* -------------------------------------------------------------------------
 * TRV-037: reply classification. Suggestions are advisory; a confirmation is
 * the only thing that acts.
 * ---------------------------------------------------------------------- */

export interface ReplyClassificationEffects {
  suppressionId?: string;
  endedMemberIds?: string[];
  skippedActionIds?: string[];
  /** Claimed (in-flight) actions left to the send-time suppression gate. */
  inFlightActionCount?: number;
}

export interface ReplyClassificationView {
  /** Null for a preview computed for a message that has no stored row yet. */
  id: string | null;
  threadId: string;
  messageId: string;
  suggestedClass: ReplyClass;
  source: string;
  confidence: number;
  classifierVersion: string;
  suggestedAt: string | null;
  status: 'suggested' | 'confirmed';
  confirmedClass: ReplyClass | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  effects: ReplyClassificationEffects;
}

interface ClassificationRow {
  id: string;
  thread_id: string;
  message_id: string;
  suggested_class: ReplyClass;
  suggested_source: string;
  suggested_confidence: number;
  classifier_version: string;
  suggested_at: unknown;
  status: 'suggested' | 'confirmed';
  confirmed_class: ReplyClass | null;
  confirmed_by_user_id: string | null;
  confirmed_at: unknown;
  effects_json: unknown;
}

const CLASSIFICATION_COLUMNS = `
  c.id, c.thread_id, c.message_id, c.suggested_class, c.suggested_source, c.suggested_confidence,
  c.classifier_version, TO_CHAR(c.suggested_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS suggested_at,
  c.status, c.confirmed_class, c.confirmed_by_user_id,
  TO_CHAR(c.confirmed_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS confirmed_at, c.effects_json
`;

function parseEffects(value: unknown): ReplyClassificationEffects {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ReplyClassificationEffects;
    } catch {
      return {};
    }
  }
  return value as ReplyClassificationEffects;
}

function toClassification(row: ClassificationRow): ReplyClassificationView {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    suggestedClass: row.suggested_class,
    source: row.suggested_source,
    confidence: Number(row.suggested_confidence),
    classifierVersion: row.classifier_version,
    suggestedAt: iso(row.suggested_at),
    status: row.status,
    confirmedClass: row.confirmed_class ?? null,
    confirmedByUserId: row.confirmed_by_user_id ?? null,
    confirmedAt: iso(row.confirmed_at),
    effects: parseEffects(row.effects_json)
  };
}

/**
 * Every inbound message of one conversation with its classification: the
 * stored row where one exists, otherwise a preview computed now and NOT
 * written (a read never writes; confirming stores the row).
 */
export async function listThreadClassifications(
  db: Db,
  workspaceId: string,
  threadId: string,
  messages: ReadonlyArray<{ id: string; direction: 'in' | 'out'; body: string }>
): Promise<ReplyClassificationView[]> {
  const rows = await db
    .prepare(
      `SELECT ${CLASSIFICATION_COLUMNS} FROM linkedin_reply_classifications c
       WHERE c.workspace_id=? AND c.thread_id=?`
    )
    .all<ClassificationRow>(workspaceId, threadId);
  const stored = new Map(rows.map((row) => [row.message_id, toClassification(row)]));
  const views: ReplyClassificationView[] = [];
  for (const message of messages) {
    if (message.direction !== 'in') continue;
    const existing = stored.get(message.id);
    if (existing) {
      views.push(existing);
      continue;
    }
    const preview = classifyLinkedInReply(message.body);
    views.push({
      id: null,
      threadId,
      messageId: message.id,
      suggestedClass: preview.replyClass,
      source: preview.source,
      confidence: preview.confidence,
      classifierVersion: REPLY_CLASSIFIER_VERSION,
      suggestedAt: null,
      status: 'suggested',
      confirmedClass: null,
      confirmedByUserId: null,
      confirmedAt: null,
      effects: {}
    });
  }
  return views;
}

/**
 * End every active campaign membership for this person: matched by the
 * contact's profile URL (any spelling `targetRefCandidates` knows) or by the
 * People record the suppression resolved. Goes through the existing
 * `endManagedCampaignMember`, which also skips the member's unclaimed sends,
 * channel actions and pending manual tasks.
 */
async function endMembershipsFor(
  tx: Db,
  workspaceId: string,
  candidates: readonly string[],
  personId: string | null,
  outcome: 'excluded' | 'removed',
  reason: string | null,
  now: Date
): Promise<string[]> {
  const members = await tx
    .prepare(
      `SELECT m.id FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
       WHERE m.workspace_id=? AND m.status = ANY(?::text[])
         AND (LOWER(c.profile_url) = ANY(?::text[]) OR (?::text IS NOT NULL AND c.person_id = ?::text))
       ORDER BY m.id
       FOR UPDATE OF m`
    )
    .all<{ id: string }>(workspaceId, ACTIVE_MEMBER_STATUSES, candidates, personId, personId);
  const ended: string[] = [];
  for (const member of members) {
    if (await endManagedCampaignMember(tx, workspaceId, member.id, outcome, now))
      ended.push(member.id);
  }
  if (ended.length > 0 && reason) {
    await tx
      .prepare(
        'UPDATE linkedin_campaign_members SET exclusion_reason=? WHERE workspace_id=? AND id = ANY(?::text[])'
      )
      .run(reason, workspaceId, ended);
  }
  return ended;
}

export interface ConfirmReplyClassificationInput {
  workspaceId: string;
  messageId: string;
  confirmedClass: ReplyClass;
  /** not_interested only: also end the person's active campaign membership. */
  endMembership?: boolean;
  actorUserId: string;
}

/**
 * A human confirms (or changes) the class of one inbound message. One
 * transaction: the classification row is locked, the effect runs, the row is
 * marked confirmed with the identifiers it touched, and a domain event records
 * it. Re-confirming the same class is a no-op; a different class after
 * confirmation is refused, because its effects have already run.
 *
 * - opt_out: a LinkedIn-channel suppression (`createSuppression`), every active
 *   campaign membership ended as excluded, and every unclaimed planned/held
 *   LinkedIn action against the person skipped workspace-wide.
 * - not_interested: ends active membership only when `endMembership` is set.
 * - every other class: no state change beyond the confirmation and its event.
 */
export async function confirmReplyClassification(
  db: Db,
  input: ConfirmReplyClassificationInput,
  now: Date
): Promise<ReplyClassificationView> {
  return db.transactionOrInline(async (tx) => {
    const message = await tx
      .prepare(
        `SELECT m.id, m.thread_id, m.direction, m.body, t.profile_url
         FROM linkedin_messages m
         JOIN linkedin_threads t ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
         WHERE m.workspace_id=? AND m.id=?`
      )
      .get<{
        id: string;
        thread_id: string;
        direction: string;
        body: string;
        profile_url: string | null;
      }>(input.workspaceId, input.messageId);
    if (!message) throw new LinkedInApiError('LinkedIn message not found', 404);
    if (message.direction !== 'in')
      throw new LinkedInApiError('Only a message the lead sent can be classified.', 400);

    await storeReplySuggestions(
      tx,
      input.workspaceId,
      message.thread_id,
      [{ id: message.id, body: message.body }],
      now
    );
    const row = await tx
      .prepare(
        `SELECT ${CLASSIFICATION_COLUMNS} FROM linkedin_reply_classifications c
         WHERE c.workspace_id=? AND c.message_id=? FOR UPDATE`
      )
      .get<ClassificationRow>(input.workspaceId, input.messageId);
    if (!row) throw new LinkedInApiError('Classification could not be stored.', 500);
    const current = toClassification(row);
    if (current.status === 'confirmed') {
      if (current.confirmedClass === input.confirmedClass) return current;
      throw new LinkedInApiError(
        `This reply was already confirmed as ${current.confirmedClass}. A confirmation is final because its effects have run.`,
        409
      );
    }

    const effects: ReplyClassificationEffects = {};
    const candidates = message.profile_url
      ? [
          ...new Set(
            targetRefCandidates(message.profile_url).flatMap((value) => [
              value,
              value.replace(/\/+$/, '')
            ])
          )
        ]
      : [];

    if (input.confirmedClass === 'opt_out') {
      if (!message.profile_url || candidates.length === 0)
        throw new LinkedInApiError(
          'This conversation has no resolved LinkedIn profile, so an opt-out cannot be recorded against it. Re-sync the conversation with profile resolution, then confirm.',
          409
        );
      let suppression;
      try {
        suppression = await createSuppression(
          tx,
          {
            workspaceId: input.workspaceId,
            channel: 'linkedin',
            linkedinUrl: message.profile_url,
            reason: 'Opted out in a LinkedIn reply (confirmed by a person)',
            source: 'linkedin_reply_classification',
            sourceRef: current.id,
            actorType: 'human',
            actorId: input.actorUserId
          },
          now
        );
      } catch (error) {
        if (error instanceof LinkedInApiError) throw error;
        throw new LinkedInApiError(
          error instanceof Error ? error.message : 'Suppression could not be stored.',
          409
        );
      }
      effects.suppressionId = suppression.id;
      effects.endedMemberIds = await endMembershipsFor(
        tx,
        input.workspaceId,
        candidates,
        suppression.personId,
        'excluded',
        'Opted out in a LinkedIn reply',
        now
      );
      const skipped = await tx
        .prepare(
          `UPDATE linkedin_actions SET status='skipped', claimed_at=NULL, recorded_at=NULL
           WHERE workspace_id=? AND status IN ('planned','held') AND claimed_at IS NULL
             AND LOWER(SPLIT_PART(SPLIT_PART(target_ref, chr(63), 1), '#', 1)) = ANY(?::text[])
           RETURNING id`
        )
        .all<{ id: string }>(input.workspaceId, candidates);
      effects.skippedActionIds = skipped.map((entry) => entry.id).sort();
      const inFlight = await tx
        .prepare(
          `SELECT COUNT(*)::int AS n FROM linkedin_actions
           WHERE workspace_id=? AND status IN ('planned','held') AND claimed_at IS NOT NULL
             AND LOWER(SPLIT_PART(SPLIT_PART(target_ref, chr(63), 1), '#', 1)) = ANY(?::text[])`
        )
        .get<{ n: number }>(input.workspaceId, candidates);
      effects.inFlightActionCount = inFlight?.n ?? 0;
    } else if (input.confirmedClass === 'not_interested' && input.endMembership) {
      if (!message.profile_url || candidates.length === 0)
        throw new LinkedInApiError(
          'This conversation has no resolved LinkedIn profile, so no campaign membership can be matched to it.',
          409
        );
      effects.endedMemberIds = await endMembershipsFor(
        tx,
        input.workspaceId,
        candidates,
        null,
        'removed',
        null,
        now
      );
    }

    const timestamp = now.toISOString();
    await tx
      .prepare(
        `UPDATE linkedin_reply_classifications
         SET status='confirmed', confirmed_class=?, confirmed_by_user_id=?, confirmed_at=?::timestamptz,
             effects_json=?::jsonb
         WHERE workspace_id=? AND id=?`
      )
      .run(
        input.confirmedClass,
        input.actorUserId,
        timestamp,
        JSON.stringify(effects),
        input.workspaceId,
        current.id
      );
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_thread',
      streamId: message.thread_id,
      eventType: 'linkedin.reply_classification.confirmed',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: {
        classificationId: current.id,
        messageId: message.id,
        suggestedClass: current.suggestedClass,
        suggestedSource: current.source,
        suggestedConfidence: current.confidence,
        confirmedClass: input.confirmedClass,
        changedFromSuggestion: input.confirmedClass !== current.suggestedClass,
        effects: {
          suppressionId: effects.suppressionId ?? null,
          endedMemberCount: effects.endedMemberIds?.length ?? 0,
          endedMemberIds: effects.endedMemberIds ?? [],
          skippedActionCount: effects.skippedActionIds?.length ?? 0,
          inFlightActionCount: effects.inFlightActionCount ?? 0
        }
      },
      occurredAt: now
    });
    const updated = await tx
      .prepare(
        `SELECT ${CLASSIFICATION_COLUMNS} FROM linkedin_reply_classifications c WHERE c.workspace_id=? AND c.id=?`
      )
      .get<ClassificationRow>(input.workspaceId, current.id);
    if (!updated) throw new LinkedInApiError('Classification could not be stored.', 500);
    return toClassification(updated);
  });
}
