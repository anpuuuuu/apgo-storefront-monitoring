-- Forward-only compatibility migration for the central multi-store monitor.
-- Existing APGO Malaysia data is preserved and backfilled. Heartbeat/state
-- tables intentionally keep their schema; new code namespaces their keys.
ALTER TABLE js_errors ADD COLUMN site_id TEXT NOT NULL DEFAULT 'apgo-my';
UPDATE js_errors SET site_id = 'apgo-my' WHERE site_id IS NULL OR site_id = '';
CREATE INDEX IF NOT EXISTS idx_js_errors_site_sig_created
  ON js_errors (site_id, signature, created_at);
