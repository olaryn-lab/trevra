-- Phase G: Zoho Mail as a third mailbox provider.
--
-- 1. DNS checks for a Zoho sending domain are cached under provider 'zoho'.
-- 2. The owner names the DKIM selector their provider signs with, per sending
--    domain. Zoho has no default selector; Google and Microsoft 365 defaults
--    are still tried after the owner's selector.
-- No credential, token or Zoho account id is stored: Nango holds the OAuth
-- connection and Trevra re-reads the account id at send time.

ALTER TABLE email_deliverability_checks
  DROP CONSTRAINT IF EXISTS email_deliverability_checks_provider_check;
ALTER TABLE email_deliverability_checks
  ADD CONSTRAINT email_deliverability_checks_provider_check
  CHECK (provider IN ('google','microsoft','zoho'));

CREATE TABLE IF NOT EXISTS email_dkim_selectors (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = LOWER(domain) AND domain <> ''),
  -- One or more DNS labels, lowercase; the part before ._domainkey.
  selector TEXT NOT NULL CHECK (
    char_length(selector) BETWEEN 1 AND 200
    AND selector ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
  ),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, domain)
);
