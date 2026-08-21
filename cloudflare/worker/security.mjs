export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function secretMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

export function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export function cleanPath(value) {
  try {
    const url = new URL(String(value || ''), 'https://apgo.my');
    return redactSensitivePath(url.pathname).slice(0, 300);
  } catch {
    return '/';
  }
}

export function cleanSource(value) {
  const input = String(value || '');
  if (!input) return '';
  try {
    const url = new URL(input, 'https://apgo.my');
    return `${url.origin}${redactSensitivePath(url.pathname)}`.slice(0, 300);
  } catch {
    return input.replace(/[?#].*$/, '').slice(0, 300);
  }
}

function redactSensitivePath(pathname) {
  return String(pathname || '/')
    .replace(/(\/gift_cards\/)[^/]+/i, '$1[redacted]');
}
