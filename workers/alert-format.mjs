/* One format for every notification the monitoring sends.

   Shared by the Workers and the GitHub-run scripts, so it imports nothing and
   touches no environment. Both sides import it by relative path.

   2026-10-06 the owner said he could no longer understand the notifications.
   Counting them showed why: about thirty kinds, a third in English, Layer 1
   named "[Layer 1]" in some and "[第1层·拨测]" in others, red meaning "the site
   may be down" in one and "the monitor's clock is late" in another, raw test
   output with terminal colour codes pasted in, and times in UTC with
   milliseconds. They had been added one at a time by different people, each
   solving its own problem, and nobody had read them as the person they are
   written for.

   So every message answers the owner's two questions first — is my store all
   right, and do I need to do anything — and only then says what happened.
   Technical detail is kept, but last, for whoever has to debug it.

     🔴 act      要你马上处理   the phone rings
     🟡 watch    有空看一下     silent
     ⚪ ignore   不用处理       silent
     ✅ ok       恢复了         silent

   Colour carries exactly one meaning, and so does the phone ringing: it rings
   only when something needs a person now. A broken monitor is not a broken
   store, so problems with the monitoring itself are never red. */

const LEVELS = {
  act: { icon: '🔴', action: '要你马上处理', silent: false },
  watch: { icon: '🟡', action: '有空看一下', silent: true },
  ignore: { icon: '⚪', action: '不用处理', silent: true },
  ok: { icon: '✅', action: '不用处理', silent: true },
  /* The one exception, and deliberately not a colour: the investigator's
     findings arrive as the second half of a red alert, and the owner asked
     on 2026-09-15 for them to ring too. Giving it 🔴 would make one incident
     look like two. */
  followup: { icon: '🔎', action: '接着上一条看', silent: false },
};

export const STORE = {
  fine: '店铺正常',
  maybe: '店铺可能有问题',
  broken: '店铺有问题',
  unknown: '店铺状况暂时看不到',
};

const DEFAULT_TIME_ZONE = 'Asia/Kuala_Lumpur';

/* "10/06 03:11" in the store's own time zone. The owner reads these on a
   phone; ISO strings with a Z and milliseconds made him do arithmetic. */
export function localTime(ms, timeZone = DEFAULT_TIME_ZONE) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/* "3 小时 10 分" / "45 分钟". */
export function duration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/* Strip terminal colour codes, with or without the escape byte that usually
   precedes them — Telegram received "[2mexpect( [22m [31mlocator" on
   2026-10-06 because the escape had been removed and the rest had not. */
export function plain(text, max = 300) {
  const cleaned = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\[[0-9;]{1,6}m/g, '')
    // A line must stay one line, or it breaks the layout around it. Ordinary
    // spaces are left alone: indentation groups a product's details under it.
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+$/u, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const DETAILS_BUDGET = 1_400;

/* Build a notification. Returns { text, silent } so the sender cannot pair a
   colour with the wrong ringing behaviour by accident.

   level     act | watch | ignore | ok
   title     what happened, a few words
   site      store label, e.g. "APGO MY"
   store     the store verdict, normally one of STORE
   action    overrides the level's default "do I need to act" text
   lines     one or two plain sentences, owner's language only
   atMs      when it happened
   details   technical lines, shown last
   link      run URL or similar
   detailsBudget  characters allowed for details; the browser-error digest
             needs more than most, since its details are the whole payload
             for whoever debugs it
   silent    override the level's ringing — reserved for the investigator,
             which the owner asked to ring as the second half of a red alert */
export function buildAlert({
  level,
  title,
  site = '',
  store = STORE.fine,
  action,
  lines = [],
  atMs = Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
  details = [],
  link = '',
  detailsBudget = DETAILS_BUDGET,
  silent,
} = {}) {
  const spec = LEVELS[level];
  if (!spec) throw new Error(`unknown alert level: ${level}`);
  if (!title) throw new Error('alert title is required');

  const out = [`${spec.icon} ${plain(title, 120)}`];
  out.push(`${site ? `${site} · ` : ''}${store}｜${action || spec.action}`);
  for (const line of lines.filter(Boolean)) out.push(plain(line, 400));
  const when = localTime(atMs, timeZone);
  if (when) out.push(`时间 ${when}`);

  const technical = [];
  let budget = Math.min(Number(detailsBudget) || DETAILS_BUDGET, 3_000);
  for (const line of details.filter(Boolean)) {
    const cleaned = plain(line, 300);
    if (cleaned.length > budget) { technical.push('…'); break; }
    technical.push(cleaned);
    budget -= cleaned.length;
  }
  if (technical.length || link) {
    out.push('—— 技术细节 ——');
    out.push(...technical);
    if (link) out.push(String(link));
  }

  return { text: out.join('\n'), silent: silent === undefined ? spec.silent : Boolean(silent) };
}
