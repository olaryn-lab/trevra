-- TRV-037: deterministic reply classification with human confirmation.
--
-- ONE ROW PER INBOUND LINKEDIN MESSAGE. The deterministic classifier in
-- src/server/linkedin/reply-classification.ts files a SUGGESTION with the rule
-- that produced it and that rule's fixed confidence. A suggestion changes no
-- state. Only a human confirmation (status 'confirmed') may drive the narrow,
-- audited effects in inbox-organization.ts: an opt-out suppression plus ended
-- campaign membership, an optional ended membership for not-interested, and a
-- recorded domain event for every confirmation.
--
-- CLOSER: rows cascade from both the message and the conversation, so the
-- existing inbox resets remove them with the conversation they classify.
-- `effects_json` holds identifiers and counts only, never message text.

CREATE TABLE IF NOT EXISTS linkedin_reply_classifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES linkedin_threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES linkedin_messages(id) ON DELETE CASCADE,
  suggested_class TEXT NOT NULL CHECK (suggested_class IN (
    'interested', 'not_interested', 'out_of_office', 'opt_out', 'referral', 'question', 'other'
  )),
  -- The rule id that produced the suggestion, e.g. 'rule:opt_out.explicit'.
  suggested_source TEXT NOT NULL,
  suggested_confidence REAL NOT NULL
    CHECK (suggested_confidence >= 0 AND suggested_confidence <= 1),
  classifier_version TEXT NOT NULL,
  suggested_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed')),
  confirmed_class TEXT CHECK (confirmed_class IS NULL OR confirmed_class IN (
    'interested', 'not_interested', 'out_of_office', 'opt_out', 'referral', 'question', 'other'
  )),
  confirmed_by_user_id TEXT,
  confirmed_at TIMESTAMPTZ,
  effects_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ck_linkedin_reply_classification_state CHECK (
    (status = 'suggested' AND confirmed_class IS NULL AND confirmed_at IS NULL)
    OR (status = 'confirmed' AND confirmed_class IS NOT NULL AND confirmed_at IS NOT NULL
        AND confirmed_by_user_id IS NOT NULL)
  )
);

-- One classification per message; also the cascade from a deleted message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_reply_classifications_message
  ON linkedin_reply_classifications (message_id);

-- The latest classification for a listed conversation, and the cascade from a
-- deleted conversation.
CREATE INDEX IF NOT EXISTS idx_linkedin_reply_classifications_thread
  ON linkedin_reply_classifications (thread_id, suggested_at DESC);
