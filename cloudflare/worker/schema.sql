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
  ip_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'error',
  action TEXT,
  http_status INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  critical INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS monitor_heartbeats (
  layer TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_monitor_heartbeats_observed
  ON monitor_heartbeats (observed_at);

CREATE TABLE IF NOT EXISTS uptime_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_time INTEGER NOT NULL,
  target TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scheduled_time, target)
);
CREATE INDEX IF NOT EXISTS idx_uptime_samples_target_created
  ON uptime_samples (target, created_at);

CREATE TABLE IF NOT EXISTS cron_executions (
  scheduled_time INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
