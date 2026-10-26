-- Prevent overlapping worker replicas from delivering the same companion outage
-- notification concurrently. Claims expire for crash recovery: SMTP itself
-- does not offer exactly-once semantics, so an ambiguous delivery may retry.
ALTER TABLE linkedin_companion_devices
  ADD COLUMN IF NOT EXISTS disconnect_claimed_at timestamptz;
