-- Meetings: a time and one matched Person, from Google Calendar or a Cal.com booking.
--
-- Deliberately narrow. No title, description, location, conference link or guest
-- list is stored here or in the meeting's source record: Today renders the Person
-- and Account names, and source_records.external_url is the way back to the event.
--
-- One row per provider event or booking id. A Cal.com reschedule mints a new uid;
-- the old row is cancelled and the new row names it in previous_external_id, which
-- is also how a late delivery for the old uid is recognised and ignored.
--
-- Closers: the workspace cascade, and the Person cascade below.
-- lc-debt: a meeting's source_records row (which holds the matched email) survives
-- deletion of its Person, exactly as message source rows do today; delete it in the
-- person-erasure path once one exists.

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  previous_external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'rescheduled', 'cancelled')),
  origin TEXT NOT NULL CHECK (origin IN ('calendar', 'booking')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  person_id TEXT NOT NULL,
  account_id TEXT,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (ends_at >= starts_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  UNIQUE (workspace_id, provider, external_id),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_starts
  ON meetings(workspace_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_ends
  ON meetings(workspace_id, ends_at);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_person
  ON meetings(workspace_id, person_id);

CREATE INDEX IF NOT EXISTS idx_meetings_previous_external
  ON meetings(workspace_id, provider, previous_external_id)
  WHERE previous_external_id IS NOT NULL;

-- The workspace booking link merged into outreach as {{booking_link}}. Cleared by
-- setting it to NULL; removed with the workspace.
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS booking_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_settings_booking_url_https') THEN
    ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_booking_url_https
      CHECK (
        booking_url IS NULL
        OR (booking_url ~ '^https://[^[:space:]]+$' AND char_length(booking_url) <= 500)
      );
  END IF;
END $$;
