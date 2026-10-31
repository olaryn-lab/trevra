-- TRV-043: a presented human-send handoff stays answerable whatever cancels it.
--
-- `handoff_resolved_at` is when the founder answered a handoff Today presented
-- (sent, skip or failed, through POST /api/linkedin/handoffs/:id/resolve).
--
-- Bulk and automated paths (stop, remove, end, skip step, resume at step,
-- move, suppression retirement, seat release, campaign end) keep cancelling
-- open rows to 'skipped' exactly as before. A row that was PRESENTED and then
-- cancelled that way while this column is still NULL is a handoff the founder
-- may already have sent by hand: Today keeps listing it, and "Mark sent" still
-- records the send (status 'sent', counted by every pacing window).
--
-- Writer: resolveLinkedInHandoff stamps it. Closer: presenting an open row
-- again (a retry or resume revived it) clears it, and it stops mattering once
-- the row is anything but 'skipped'. The partial index holds only the
-- cancelled-and-unanswered rows, which leave it when the founder answers.
--
-- Rows that left 'planned'/'held' before this column existed are marked
-- answered: the ledger cannot tell a founder's own skip from a bulk cancel for
-- them, and resurfacing every old card in Today would ask about sends nobody
-- can still date.

ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS handoff_resolved_at TIMESTAMPTZ;

UPDATE linkedin_actions
SET handoff_resolved_at = COALESCE(recorded_at, handoff_presented_at)
WHERE handoff_presented_at IS NOT NULL
  AND handoff_resolved_at IS NULL
  AND status NOT IN ('planned', 'held');

-- Built inline only on a small table, as migration 054 does: a plain CREATE
-- INDEX holds SHARE (blocking writes) for the whole build.
DO $$
DECLARE
  inline_limit CONSTANT BIGINT := 64 * 1024 * 1024;
  actions_bytes BIGINT := 0;
BEGIN
  SELECT pg_table_size('linkedin_actions') INTO actions_bytes;
  IF actions_bytes <= inline_limit THEN
    CREATE INDEX IF NOT EXISTS idx_linkedin_actions_handoff_unanswered
      ON linkedin_actions(workspace_id, handoff_presented_at)
      WHERE status = 'skipped' AND handoff_presented_at IS NOT NULL AND handoff_resolved_at IS NULL;
  ELSE
    RAISE WARNING 'linkedin_actions is % bytes, so migration 166 did NOT build its index inline. Run it by hand, outside a transaction: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_handoff_unanswered ON linkedin_actions(workspace_id, handoff_presented_at) WHERE status = ''skipped'' AND handoff_presented_at IS NOT NULL AND handoff_resolved_at IS NULL;', actions_bytes;
  END IF;
END
$$;

COMMENT ON COLUMN linkedin_actions.handoff_resolved_at IS
  'When the founder answered this presented human-send handoff (sent, skip or failed). A presented row cancelled to skipped while this is NULL may already have been sent by hand, so Today keeps asking and Mark sent still records it.';
