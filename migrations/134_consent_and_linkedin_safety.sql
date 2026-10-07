-- Phase E: consent and LinkedIn safety.
--
-- Four deterministic facts the control plane enforces without a model:
--   1. who a workspace's commercial email says it is from (CAN-SPAM needs a
--      postal address; Trevra also asks for a privacy policy URL);
--   2. a per-person, per-channel lawful basis for cold email, with its source;
--   3. which LinkedIn member a seat signs in as, so one person's limits are
--      counted once across every workspace that connected them;
--   4. whether a seat's invites and messages are sent by the founder by hand.
-- Not legal advice; verify with counsel.

CREATE TABLE IF NOT EXISTS workspace_sender_identities (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  legal_name TEXT CHECK (legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 200),
  postal_address TEXT CHECK (postal_address IS NULL OR char_length(postal_address) BETWEEN 1 AND 500),
  privacy_policy_url TEXT CHECK (
    privacy_policy_url IS NULL
    OR (privacy_policy_url ~ '^https://' AND char_length(privacy_policy_url) <= 2048)
  ),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE workspace_sender_identities IS
  'Who this workspace''s commercial email says it is from. Email outreach plans are blocked until postal_address and privacy_policy_url are set.';

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_country_code_check' AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_country_code_check
      CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_country_code_check' AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_country_code_check
      CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$') NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contact_lawful_bases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  basis TEXT NOT NULL CHECK (basis IN ('consent', 'existing_customer', 'legitimate_interest')),
  source TEXT NOT NULL CHECK (source IN ('inbound_capture', 'operator')),
  source_ref TEXT CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at TIMESTAMPTZ,
  withdrawn_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, person_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_lawful_bases_active
  ON contact_lawful_bases (workspace_id, person_id, channel)
  WHERE withdrawn_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_lawful_bases_active_unique
  ON contact_lawful_bases (workspace_id, person_id, channel, basis, source, (COALESCE(source_ref, '')))
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE contact_lawful_bases IS
  'Per person and channel: why Trevra may send cold outreach, where that came from, and when it was withdrawn. Rows are withdrawn, never deleted. Not legal advice; verify with counsel.';

CREATE TABLE IF NOT EXISTS linkedin_seat_identities (
  workspace_id TEXT NOT NULL,
  seat_key TEXT NOT NULL,
  identity_key TEXT NOT NULL CHECK (char_length(identity_key) BETWEEN 1 AND 300),
  confirmed_at TIMESTAMPTZ NOT NULL,
  -- The authenticated Trevra user who asked for the detect that observed this
  -- identity. The profile page itself is read through a browser the tenant
  -- controls, so the key alone proves nothing across workspaces: two seats
  -- share a budget only when one user bound both and is a member of both.
  bound_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, seat_key),
  FOREIGN KEY (workspace_id, seat_key)
    REFERENCES linkedin_seats(workspace_id, seat_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_linkedin_seat_identities_identity
  ON linkedin_seat_identities (identity_key);

COMMENT ON TABLE linkedin_seat_identities IS
  'The LinkedIn member a seat signed in as, read by the companion from its own signed-in profile. Seats sharing identity_key AND bound_user_id, with that user a current member of both workspaces, share one safety budget; only counts cross the workspace boundary.';

-- Who pressed Connect, carried to the worker that performs the detect so the
-- identity it records is bound to that user (see bound_user_id above).
ALTER TABLE linkedin_seat_detect_requests
  ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Current workspace membership, as the API checks it: Trevra's users row, the
-- better-auth user with the same email, and its member row in the
-- organization whose id is the workspace id. plpgsql so the body is planned
-- only when called: the better-auth tables are created by its own migrator,
-- and a database without them has no members, so nothing links (fail closed).
CREATE OR REPLACE FUNCTION trevra_user_is_workspace_member(p_user_id TEXT, p_workspace_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_user_id IS NULL OR p_workspace_id IS NULL
     OR to_regclass('member') IS NULL OR to_regclass('"user"') IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM users tu
    JOIN "user" au ON au.email = lower(tu.email)
    JOIN member m ON m."userId" = au.id
    WHERE tu.id = p_user_id AND m."organizationId" = p_workspace_id
  );
END;
$$;

ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'automated';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'linkedin_seats_send_mode_check' AND conrelid = 'linkedin_seats'::regclass
  ) THEN
    ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_send_mode_check
      CHECK (send_mode IN ('automated', 'human')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN linkedin_seats.send_mode IS
  'automated: the browser worker sends. human: invites and messages are drafted and gated, then handed to the founder in Today; passive kinds still run.';
