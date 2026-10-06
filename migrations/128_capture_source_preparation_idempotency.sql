-- Retry-safe GTM intent preparation for signed inbound capture sources.
--
-- A browser/API retry with the same idempotency key must resolve to the same
-- source and signing secret rather than creating a second credential. The key
-- is internal correlation state, not part of the public capture-source record.
-- The plan hash binds that key to one exact GTM plan: reusing the key for a
-- different source request is a conflict, never an alias for the old secret.
ALTER TABLE capture_sources
  ADD COLUMN IF NOT EXISTS preparation_key TEXT,
  ADD COLUMN IF NOT EXISTS preparation_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_sources_workspace_preparation
  ON capture_sources(workspace_id, preparation_key)
  WHERE preparation_key IS NOT NULL;

COMMENT ON COLUMN capture_sources.preparation_key IS
'Internal idempotency key for GTM intent preparation. Never exposed as a capture credential.';

COMMENT ON COLUMN capture_sources.preparation_hash IS
'Canonical GTM plan hash bound to preparation_key; prevents one key from being reused for a different capture plan.';
