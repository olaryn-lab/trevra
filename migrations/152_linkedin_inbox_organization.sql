-- TRV-036: inbox organization for stored LinkedIn conversations.
--
-- ORGANIZED AT THE LEVEL THE INBOX LISTS. `/outreach/inbox` lists
-- `linkedin_threads` rows, so tags, notes, assignment and the star/archive flags
-- hang off `linkedin_threads.id`. Every table carries `workspace_id`, and every
-- read and write in src/server/linkedin/inbox-organization.ts names it.
--
-- CLOSERS. Everything per-conversation cascades from `linkedin_threads(id)`, so
-- the existing inbox resets (`clearInboxForWorkspace` / `clearInboxForSeat`,
-- which run when the connected LinkedIn account changes) remove this state with
-- the conversation it describes. The tag catalog is workspace configuration and
-- lives until the operator deletes a tag (which removes its associations through
-- the composite foreign key) or the workspace is deleted. Soft-deleted notes and
-- note revisions are the audit trail of a conversation and are retained exactly
-- as long as that conversation is.
--
-- AUDIT ACTOR COLUMNS ARE PLAIN TEXT, NOT FOREIGN KEYS: who wrote or changed
-- something must survive that user later being removed. Only the functional
-- `assignee_user_id` references `users(id)`, and is nulled if the user goes.

CREATE TABLE IF NOT EXISTS linkedin_inbox_tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- A token name from a fixed palette, never a hex value: the client maps each
  -- to the shared --t-* colour tokens so tags stay legible in both themes.
  color TEXT NOT NULL DEFAULT 'neutral'
    CHECK (color IN ('neutral', 'green', 'blue', 'amber', 'red')),
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_linkedin_inbox_tags_workspace_id UNIQUE (workspace_id, id)
);

-- One tag name per workspace, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_inbox_tags_name
  ON linkedin_inbox_tags (workspace_id, LOWER(name));

CREATE TABLE IF NOT EXISTS linkedin_thread_tags (
  thread_id TEXT NOT NULL REFERENCES linkedin_threads(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tagged_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, tag_id),
  -- Composite: a thread can only carry a tag from its own workspace's catalog,
  -- and deleting the tag deletes every association with it.
  CONSTRAINT fk_linkedin_thread_tags_tag FOREIGN KEY (workspace_id, tag_id)
    REFERENCES linkedin_inbox_tags (workspace_id, id) ON DELETE CASCADE
);

-- The tag filter on the inbox list, and the cascade from a deleted tag.
CREATE INDEX IF NOT EXISTS idx_linkedin_thread_tags_tag
  ON linkedin_thread_tags (workspace_id, tag_id, thread_id);

-- One row per organized conversation. A conversation nobody has touched has no
-- row, and reads treat that as not starred, not archived and unassigned.
CREATE TABLE IF NOT EXISTS linkedin_thread_organization (
  thread_id TEXT PRIMARY KEY REFERENCES linkedin_threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  -- Hidden from the default inbox list. A newly stored inbound message clears
  -- it, so archiving never hides a fresh reply.
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_by_user_id TEXT,
  assigned_at TIMESTAMPTZ,
  updated_by_user_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Assignee filter (workspace + user) and the ON DELETE SET NULL lookup by user.
CREATE INDEX IF NOT EXISTS idx_linkedin_thread_org_assignee
  ON linkedin_thread_organization (assignee_user_id, workspace_id)
  WHERE assignee_user_id IS NOT NULL;

-- Starred and archived filters. Partial: both are the small half of the table.
CREATE INDEX IF NOT EXISTS idx_linkedin_thread_org_starred
  ON linkedin_thread_organization (workspace_id, thread_id)
  WHERE starred;
CREATE INDEX IF NOT EXISTS idx_linkedin_thread_org_archived
  ON linkedin_thread_organization (workspace_id, thread_id)
  WHERE archived;

CREATE TABLE IF NOT EXISTS linkedin_thread_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES linkedin_threads(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- Incremented on every edit; each version is also kept in the revisions table.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_user_id TEXT,
  -- Soft delete: the note leaves the panel, the history stays.
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id TEXT
);

-- A conversation's notes in order, and the cascade from a deleted conversation.
CREATE INDEX IF NOT EXISTS idx_linkedin_thread_notes_thread
  ON linkedin_thread_notes (thread_id, created_at);

-- Append-only history of every note: created, each edit, and the delete.
CREATE TABLE IF NOT EXISTS linkedin_thread_note_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES linkedin_thread_notes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'edited', 'deleted')),
  body TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

-- One revision per (version, lifecycle step): created is v1, each edit bumps the
-- version, a delete is terminal. The index also serves the ordered history read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_thread_note_revisions_note
  ON linkedin_thread_note_revisions (note_id, version, action);
