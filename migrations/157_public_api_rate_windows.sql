-- TRV-053: shared fixed-window request counters for the supported public API
-- (src/server/public-api). Cloud Run runs several instances, so an in-memory
-- limiter would multiply every documented limit by the instance count; one
-- upsert per request against this table keeps the limit global.
--
-- One row per (workspace, subject, request class, window). `subject` is
-- 'workspace' for the shared workspace bucket or 'token:<agent_tokens.id>' for
-- a single credential. Rows are counters only: no request content, no IP.
-- Closer: the worker deletes windows older than one hour
-- (prunePublicApiRateWindows); workspace deletion cascades.
-- Additive and forward-only.
CREATE TABLE public_api_rate_windows (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject = 'workspace' OR subject LIKE 'token:%'),
  request_class TEXT NOT NULL CHECK (request_class IN ('read','write')),
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL CHECK (hits > 0),
  PRIMARY KEY (workspace_id, subject, request_class, window_start)
);
CREATE INDEX idx_public_api_rate_windows_window_start
  ON public_api_rate_windows (window_start);
