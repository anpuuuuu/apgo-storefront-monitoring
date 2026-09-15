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
  if (action === 'list-signatures') {
    // Read-only: every signature that ever made a digest, with the message
    // text that alert_log truncates plus the latest source URL and page from
    // js_errors (30-day retention, so old rows show null), so a mute decision
    // can be made from the Actions log instead of the Cloudflare dashboard.
    return {
      sql: 'SELECT k.signature, k.muted, k.first_seen_at, k.last_alerted_at, substr(k.sample_message, 1, 120) AS sample, '
        + '(SELECT substr(e.source, 1, 120) FROM js_errors e WHERE e.signature = k.signature ORDER BY e.created_at DESC LIMIT 1) AS source, '
        + '(SELECT substr(e.page_url, 1, 80) FROM js_errors e WHERE e.signature = k.signature ORDER BY e.created_at DESC LIMIT 1) AS page, '
        + 'k.note FROM known_signatures k ORDER BY k.last_alerted_at DESC LIMIT 100',
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
  if (action === 'list-recent-orders') {
    // Read-only: order timestamps pushed in the last 48 hours, so a
    // checkout alert can be checked against what the store actually sold.
    return {
      sql: "SELECT datetime(json_extract(e.value, '$.at') / 1000, 'unixepoch') AS created_at_utc, json_extract(e.value, '$.id') AS order_id FROM state, json_each(json_extract(state.value, '$.entries')) AS e WHERE state.key LIKE '%:orders:log' AND json_extract(e.value, '$.at') >= (strftime('%s', 'now') - 172800) * 1000 ORDER BY 1 DESC LIMIT 300",
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
