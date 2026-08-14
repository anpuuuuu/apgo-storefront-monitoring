/* APGO Layer 3: public error-beacon receiver.
   Deployed to Cloudflare Workers (see deploy-worker.yml), writes into the
   apgo-monitoring D1 database. Deliberately keyless — the theme snippet holds
   no credential, so abuse control lives entirely here:
   - synthetic-monitoring traffic (UA contains APGO-HealthCheck) is dropped
   - foreign Origin/Referer is dropped silently
   - oversized payloads rejected, every field re-truncated server-side
   - per-IP rate limit (hashed with a daily salt; raw IPs are never stored) */

const OWN_ORIGINS = ['https://apgo.my', 'https://www.apgo.my'];
const ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.myshopify\.com$/];

const MAX_BODY = 8192;
const RATE_LIMIT_PER_MIN = 10;

function originAllowed(o) {
  return OWN_ORIGINS.includes(o) || ORIGIN_PATTERNS.some((re) => re.test(o));
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': originAllowed(origin) ? origin : OWN_ORIGINS[0],
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return new Response('apgo-error-monitor', { status: 405, headers });

    const ua = request.headers.get('user-agent') || '';
    if (ua.includes('APGO-HealthCheck')) return new Response(null, { status: 204, headers });

    /* sendBeacon may omit both Origin and Referer — absent is allowed;
       present-but-foreign is silently swallowed. */
    let refOrigin = origin;
    if (!refOrigin) {
      try { refOrigin = new URL(request.headers.get('referer') || '').origin; } catch { refOrigin = ''; }
    }
    if (refOrigin && !originAllowed(refOrigin)) return new Response(null, { status: 204, headers });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return new Response(null, { status: 413, headers });

    let d;
    try { d = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers }); }
    if (!d || typeof d.m !== 'string' || !d.m || typeof d.sid !== 'string') {
      return new Response(null, { status: 400, headers });
    }

    const message = d.m.slice(0, 300);
    const source = String(d.src || '').slice(0, 300);
    const line = Number.isFinite(+d.line) ? Math.trunc(+d.line) : 0;
    const col = Number.isFinite(+d.col) ? Math.trunc(+d.col) : 0;
    const stack = String(d.stack || '').slice(0, 1000);
    const pageUrl = String(d.url || '').split('?')[0].slice(0, 300);
    const sid = d.sid.slice(0, 64);

    const ip = request.headers.get('cf-connecting-ip') || '';
    const day = new Date().toISOString().slice(0, 10);
    const ipHash = (await sha256hex(ip + '|' + day)).slice(0, 32);
    const signature = (await sha256hex(message + '|' + source + '|' + line)).slice(0, 32);

    /* Rate limit via an indexed count; if the check itself errors, fail open
       and insert anyway — the client-side 5-per-pageview cap is the real
       volume bound, and real error signal beats a perfect limiter. */
    try {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM js_errors WHERE ip_hash = ?1 AND created_at > datetime('now', '-60 seconds')"
      ).bind(ipHash).first();
      if (r && r.c >= RATE_LIMIT_PER_MIN) return new Response(null, { status: 429, headers });
    } catch (e) { /* fail open */ }

    try {
      await env.DB.prepare(
        'INSERT INTO js_errors (signature, message, source, line, col, stack, page_url, user_agent, session_id, ip_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)'
      ).bind(signature, message, source, line, col, stack, pageUrl, ua.slice(0, 300), sid, ipHash).run();
    } catch (e) {
      return new Response(null, { status: 500, headers });
    }
    return new Response(null, { status: 204, headers });
  },
};
