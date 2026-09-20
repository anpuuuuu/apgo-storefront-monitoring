const SIGNATURE = /^[0-9a-f]{32}$/;
const DATE = /^[0-9]{8}$/;

/* Only the hex signature and a quote-free, length-capped note ever reach the
   statement. Anything else fails before the workflow touches D1. */
export function buildMaintenanceSql({ action, signature = '', note = '', fromDate = '' }) {
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
  if (action === 'list-daily-report') {
    /* Read-only: the Layer 4 daily funnel deliberately keeps its numbers out of
       stdout (scripts/ga4-public-status.mjs: "GitHub Actions is public. Full
       financial reports belong in private D1 state, never in stdout"), so the
       run logs only carry counts. The full summary, including which segment was
       flagged and why, is in the state row the primary run writes. Every day
       from 2026-09-13 flagged at least one target and every one survived the
       confirm stage, so the daily report cannot be armed until this is read. */
    if (!DATE.test(fromDate)) throw new Error('date must be 8 digits, YYYYMMDD');
    return {
      sql: 'SELECT json_extract(value, \'$.targetDate\') AS target_date, '
        + 'json_extract(value, \'$.anomalies\') AS anomalies, '
        + 'json_extract(value, \'$.realtimeCoverage\') AS realtime_coverage '
        + "FROM state WHERE key LIKE '%:ga4:daily:candidate:%' "
        + `AND json_extract(value, '$.targetDate') >= '${fromDate}' ORDER BY 1`,
      verify: null,
    };
  }
  if (action === 'list-order-history') {
    /* Read-only: every order timestamp the push log still holds, one row per UTC
       day with the times of that day. Compact enough to read in a run log and
       exact to the minute, which is what an offline replay of a new order-gap
       rule needs. The log keeps ORDER_LIMITS.retentionDays, so this is the whole
       history without a date filter. */
    return {
      sql: "SELECT date(json_extract(e.value, '$.at') / 1000, 'unixepoch') AS day_utc, "
        + 'COUNT(*) AS orders, '
        + "group_concat(strftime('%H%M', json_extract(e.value, '$.at') / 1000, 'unixepoch')) AS times_utc "
        + "FROM state, json_each(json_extract(state.value, '$.entries')) AS e "
        + "WHERE state.key LIKE '%:orders:log' GROUP BY 1 ORDER BY 1",
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
