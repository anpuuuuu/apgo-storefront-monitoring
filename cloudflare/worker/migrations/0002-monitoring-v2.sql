ALTER TABLE js_errors ADD COLUMN kind TEXT NOT NULL DEFAULT 'error';
ALTER TABLE js_errors ADD COLUMN action TEXT;
ALTER TABLE js_errors ADD COLUMN http_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE js_errors ADD COLUMN stage TEXT;
ALTER TABLE js_errors ADD COLUMN critical INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS monitor_heartbeats (
  layer TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_monitor_heartbeats_observed ON monitor_heartbeats (observed_at);

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
CREATE INDEX IF NOT EXISTS idx_uptime_samples_target_created ON uptime_samples (target, created_at);

CREATE TABLE IF NOT EXISTS cron_executions (
  scheduled_time INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
