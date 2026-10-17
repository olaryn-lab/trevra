-- No auth-table FKs: Better Auth initializes its schema separately. These rows
-- contain no provider tokens and never alter Trevra users/workspaces/credits.
CREATE TABLE authward_link_attempts (
  state_hash text PRIMARY KEY,
  user_id text NOT NULL,
  session_id text NOT NULL UNIQUE,
  verifier text NOT NULL,
  nonce text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE authward_identity_links (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer,subject)
);
