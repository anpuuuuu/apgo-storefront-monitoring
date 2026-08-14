-- Schema of the apgo-monitoring D1 database (already applied 2026-08-14).
-- Kept in the repo as the source of truth; re-runnable (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS js_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  signature TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT,
  line INTEGER,
  col INTEGER,
  stack TEXT,
  page_url TEXT,
  user_agent TEXT,
  session_id TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_js_errors_created ON js_errors (created_at);
CREATE INDEX IF NOT EXISTS idx_js_errors_sig ON js_errors (signature, created_at);
CREATE INDEX IF NOT EXISTS idx_js_errors_ip ON js_errors (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS known_signatures (
  signature TEXT PRIMARY KEY,
  sample_message TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  layer TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
