-- Search every stored LinkedIn thread, not just the first 500 retrieved rows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_linkedin_threads_search_trgm
ON linkedin_threads USING gin (
  (LOWER(COALESCE(name,'') || ' ' || COALESCE(profile_url,'') || ' ' || COALESCE(snippet,''))) gin_trgm_ops
);
