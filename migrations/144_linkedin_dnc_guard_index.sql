-- Speed the final LinkedIn contact opt-out guard without depending on
-- asynchronous suppression materialization. Expression matches the path
-- normalization in the guard, including ?tracking and #fragments.
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_dnc_profile_guard
  ON linkedin_lead_contacts(
    workspace_id,
    LOWER(RTRIM(SPLIT_PART(SPLIT_PART(profile_url, '?', 1), '#', 1), '/'))
  )
  WHERE do_not_contact IS TRUE AND profile_url IS NOT NULL;
