export async function getState(db, key) {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?1').bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export async function setState(db, key, value) {
  await db.prepare(
    `INSERT INTO state (key, value, updated_at)
     VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, JSON.stringify(value)).run();
}

export async function writeHeartbeat(db, siteId, layer, source, status = 'ok', detail = {}) {
  const now = new Date().toISOString();
  const key = `${siteId}:${layer}`;
  await db.prepare(
    `INSERT INTO monitor_heartbeats (layer, source, status, detail, observed_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(layer) DO UPDATE SET
       source = excluded.source,
       status = excluded.status,
       detail = excluded.detail,
       observed_at = excluded.observed_at,
       updated_at = datetime('now')`
  ).bind(key, source, status, JSON.stringify({ siteId, ...detail }), now).run();
}

export async function logAlert(db, layer, kind, detail) {
  await db.prepare(
    'INSERT INTO alert_log (layer, kind, detail) VALUES (?1, ?2, ?3)'
  ).bind(layer, kind, JSON.stringify(detail)).run();
}

export async function listHeartbeats(db) {
  const result = await db.prepare(
    'SELECT layer, source, status, detail, observed_at, updated_at FROM monitor_heartbeats ORDER BY layer'
  ).all();
  return result.results || [];
}

export async function listSiteHeartbeats(db, siteIds = []) {
  const rows = await listHeartbeats(db);
  return siteIds.flatMap((siteId) => ['layer1', 'layer2', 'layer3', 'layer4'].map((layer) => {
    const namespaced = rows.find((row) => row.layer === `${siteId}:${layer}`);
    const legacy = rows.find((row) => row.layer === layer);
    return { ...(namespaced || legacy || {}), siteId, logicalLayer: layer, legacyFallback: !namespaced && Boolean(legacy) };
  }));
}
