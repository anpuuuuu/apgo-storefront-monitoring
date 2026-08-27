ALTER TABLE js_errors ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE js_errors ADD COLUMN visibility_state TEXT;
ALTER TABLE js_errors ADD COLUMN online_state INTEGER NOT NULL DEFAULT -1;
ALTER TABLE js_errors ADD COLUMN page_leaving INTEGER NOT NULL DEFAULT 0;
ALTER TABLE js_errors ADD COLUMN client_type TEXT;

CREATE INDEX IF NOT EXISTS idx_js_errors_client_created
  ON js_errors (client_type, created_at);
