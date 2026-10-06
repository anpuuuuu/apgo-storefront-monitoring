import { buildAlert } from '../workers/alert-format.mjs';

export function splitDailyAnomalies(anomalies, { defaultMode = 'observe', issueModes = {} } = {}) {
  const armed = [];
  const observed = [];
  for (const anomaly of anomalies || []) {
    const armedIssues = [];
    const observedIssues = [];
    for (const issue of anomaly.issues || []) {
      const mode = issueModes[issue] || defaultMode;
      (mode === 'armed' ? armedIssues : observedIssues).push(issue);
    }
    if (armedIssues.length) armed.push({ ...anomaly, issues: armedIssues });
    if (observedIssues.length) observed.push({ ...anomaly, issues: observedIssues });
  }
  return { armed, observed };
}

export function persistentDailyAnomalies(primary, confirmation) {
  const confirmed = new Map((confirmation || []).map((item) => [item.label, new Set(item.issues || [])]));
  return (primary || []).flatMap((item) => {
    const confirmedIssues = confirmed.get(item.label);
    if (!confirmedIssues) return [];
    const issues = (item.issues || []).filter((issue) => confirmedIssues.has(issue));
    return issues.length ? [{ ...item, issues }] : [];
  });
}

/* The daily funnel compares a whole day with the same weekday on earlier
   weeks, and only alerts once both the morning and the afternoon run agree.
   These say what was found the way the owner would: which part of the store,
   and which step of buying, in words rather than metric names. */
const ISSUE_WORDS = {
  view_to_atc: '看商品后加入购物车的比例',
  atc_to_checkout: '加入购物车后进结账的比例',
  checkout_to_purchase: '进结账后付款成功的比例',
  revenue: '营业额',
};
const DEVICE_WORDS = { mobile: '手机', desktop: '电脑', tablet: '平板' };

export function segmentWords(label) {
  const text = String(label || '');
  if (text === 'all') return '全站';
  const [dimension, ...rest] = text.split(':');
  const value = rest.join(':');
  if (dimension === 'device' || dimension === 'deviceCategory') return DEVICE_WORDS[value] || value;
  if (dimension === 'product' || dimension === 'itemName') return `商品「${value}」`;
  if (dimension === 'country') return `${value} 的顾客`;
  return value || text;
}

/* "20261005" or "2026-10-05" -> "10/05". */
function dayWords(targetDate) {
  const match = String(targetDate || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return match ? `${match[2]}/${match[3]}` : String(targetDate || '');
}

export function dailyFunnelAlert({ site = '', targetDate, armed = [], nowMs = Date.now(), runUrl = '' }) {
  const issues = [...new Set(armed.flatMap((item) => item.issues || []))];
  const onlyPayment = issues.length === 1 && issues[0] === 'checkout_to_purchase';
  const shown = armed.slice(0, 8);
  return buildAlert({
    level: 'act',
    title: onlyPayment ? '昨天付款成功的比例明显偏低' : '昨天的购买流程有一步明显变差',
    site,
    store: '店铺可能有问题',
    lines: [
      `${dayWords(targetDate)} 一整天，下面这些地方比平时同一天差很多（上午和下午两次检查都确认）：`,
      ...shown.map((item) => `· ${segmentWords(item.label)}：${(item.issues || []).map((issue) => ISSUE_WORDS[issue] || issue).join('、')}偏低`),
      onlyPayment
        ? '请看 Shopify 后台的弃单（abandoned checkouts），检查付款方式和结账设置；必要时用手机实际走一遍结账。'
        : '请用手机实际走一遍「看商品 → 加入购物车 → 结账」，看哪一步不顺。',
    ],
    atMs: nowMs,
    details: shown.map((item) => `${item.label}: ${(item.issues || []).join(', ')}`),
    link: runUrl,
  });
}

const QUALITY_WORDS = {
  PURCHASE_REVENUE_MISSING: 'GA4 记到了交易，但营业额是 0。购买事件少了金额，广告会算错成交价值。',
  REALTIME_COVERAGE_LOW: '监控那天有好几个时段没跑到，覆盖不完整，那天的判断可能漏看。',
};

export function dailyQualityAlert({ site = '', targetDate, issues = [], nowMs = Date.now(), runUrl = '' }) {
  return buildAlert({
    level: 'watch',
    title: `${dayWords(targetDate)} 的 GA4 数据不完整`,
    site,
    store: '店铺多半正常',
    lines: issues.map((item) => QUALITY_WORDS[item.code] || item.message),
    atMs: nowMs,
    details: issues.map((item) => `${item.code}: ${item.message}`),
    link: runUrl,
  });
}
