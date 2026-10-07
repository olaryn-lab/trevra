-- Phase E: a human-send handoff, once shown, stays the founder's.
--
-- Today stamps a row the first time it hands it to the founder as a LinkedIn
-- handoff. From then on the row is that seat's handoff whatever the safety
-- gate says on a later day, and the seat cannot be switched back to automatic
-- sending while it is still open: the founder may already have sent it by hand,
-- and the worker must not send it a second time. The stamp is never cleared;
-- it stops mattering once the row leaves 'planned'/'held' (sent, skipped,
-- retired), so it needs no retention job of its own.

ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS handoff_presented_at TIMESTAMPTZ;

COMMENT ON COLUMN linkedin_actions.handoff_presented_at IS
  'When Today first handed this row to the founder as a human-send handoff. An open presented row blocks switching its seat back to automatic.';
