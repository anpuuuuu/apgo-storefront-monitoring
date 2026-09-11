const SIGNATURE = /^[0-9a-f]{32}$/;

/* Only the hex signature and a quote-free, length-capped note ever reach the
   statement. Anything else fails before the workflow touches D1. */
export function buildMaintenanceSql({ action, signature = '', note = '' }) {
  if (action === 'list-muted') {
    return {
      sql: 'SELECT signature, muted, first_seen_at, last_alerted_at, substr(sample_message, 1, 80) AS sample, note FROM known_signatures WHERE muted = 1 ORDER BY last_alerted_at DESC',
      verify: null,
    };
  }
  if (action === 'list-alerts') {
    // Read-only: the last 48 hours of alert_log, newest first, so "why was
    // Telegram quiet" can be answered without the Cloudflare dashboard.
    return {
      sql: "SELECT created_at, layer, kind, substr(detail, 1, 200) AS detail FROM alert_log WHERE created_at >= datetime('now', '-48 hours') ORDER BY created_at DESC LIMIT 200",
      verify: null,
    };
  }
  if (action === 'list-orders') {
    return {
      sql: "SELECT key, substr(value, 1, 400) AS value, updated_at FROM state WHERE key LIKE '%:orders:%' ORDER BY key",
      verify: null,
    };
  }
  if (action !== 'mute-signature' && action !== 'unmute-signature') throw new Error(`unknown action: ${action}`);
  if (!SIGNATURE.test(signature)) throw new Error('signature must be 32 lowercase hex characters');
  const muted = action === 'mute-signature' ? 1 : 0;
  const cleanNote = String(note).replace(/['"\\;\r\n]/g, '').trim().slice(0, 200);
  return {
    sql: `INSERT INTO known_signatures (signature, sample_message, muted, note) VALUES ('${signature}', '', ${muted}, '${cleanNote}') ON CONFLICT(signature) DO UPDATE SET muted = ${muted}, note = '${cleanNote}'`,
    verify: `SELECT signature, muted, note, first_seen_at, last_alerted_at FROM known_signatures WHERE signature = '${signature}'`,
  };
}
