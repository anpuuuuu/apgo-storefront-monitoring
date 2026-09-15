/* Storefront checkout probe — the investigator's "walk the funnel once"
   step, phase 1a of the alert investigator.

   Everything here talks only to Shopify's public storefront cart endpoints,
   exactly as a shopper's browser does: /products.json, POST /cart/add.js,
   GET /cart.js, GET /cart/shipping_rates.json, POST /cart/clear.js. It never
   opens the checkout page, never enters payment details and never creates an
   order (Wade, 2026-09-15: "你也不会真的点结账对吧"). Server-side fetches send
   no GA4 events and load no Layer 3 beacon, so the probe cannot pollute the
   very metrics it investigates.

   Confirmed against apgo.my on 2026-09-15: shipping_rates.json rejects a
   Malaysian postcode without a state (422 "Select a state/territory"); with
   zip=86900, country=MY, province=Johor it returns the rate list.

   Pure functions plus an injectable fetch so every branch is unit-testable. */

export const PROBE_USER_AGENT = 'APGO-Investigator/1.0 (storefront probe; no checkout)';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Minimal cookie jar: Shopify keys the anonymous cart on the `cart` cookie,
   so every request after /cart/add.js must send it back. */
export function createStorefrontClient({ baseUrl, fetchImpl = globalThis.fetch, userAgent = PROBE_USER_AGENT, timeoutMs = 15_000 }) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('baseUrl is required');
  const jar = new Map();
  const absorb = (response) => {
    const setCookies = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [].concat(response.headers?.get?.('set-cookie') || []);
    for (const line of setCookies) {
      const pair = String(line).split(';')[0];
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  };
  const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const cookie = cookieHeader();
      const response = await fetchImpl(`${base}${path}`, {
        method,
        body,
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept: 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      });
      absorb(response);
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, ok: response.ok, json, text: text.slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, cookies: () => cookieHeader() };
}

export function summarizeProduct(product) {
  return {
    id: product.id,
    handle: String(product.handle || ''),
    title: String(product.title || ''),
    updatedAt: product.updated_at || null,
    publishedAt: product.published_at || null,
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 30) : String(product.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 30),
    variants: (product.variants || []).map((variant) => ({
      id: variant.id,
      title: String(variant.title || ''),
      price: Number(variant.price),
      compareAtPrice: variant.compare_at_price === null || variant.compare_at_price === undefined ? null : Number(variant.compare_at_price),
      available: Boolean(variant.available),
      requiresShipping: variant.requires_shipping !== false,
    })),
  };
}

/* /products.json is public and paginated; four pages of 250 cover a store
   many times the size of apgo.my. */
export async function fetchCatalog(client, { maxPages = 4, pageSize = 250 } = {}) {
  const products = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request(`/products.json?limit=${pageSize}&page=${page}`);
    if (!response.ok || !Array.isArray(response.json?.products)) throw new Error(`products.json HTTP ${response.status}`);
    products.push(...response.json.products.map(summarizeProduct));
    if (response.json.products.length < pageSize) break;
  }
  return products;
}

export function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/* GA4 realtime only exposes unifiedScreenName — the document title, e.g.
   "APGO Atomic Crystal Merdeka Set – APGO Malaysia", truncated to 60 chars by
   topScreensForEvent — never the path. Titles in /products.json do not
   follow the handle (handle apgo-laundry-whitening-salt-500g-copy is titled
   "APGO Mold Remover 500ml"), so the catalog title is the only reliable key.
   The longest title that is a prefix of the screen (or that the truncated
   screen is a prefix of) wins. */
export function matchScreensToProducts(screens, catalog, limit = 3) {
  const indexed = catalog
    .map((product) => ({ product, key: normalizeTitle(product.title) }))
    .filter((entry) => entry.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);
  const matched = [];
  const unmatched = [];
  const ordered = [...(screens || [])].sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  for (const screen of ordered) {
    const key = normalizeTitle(screen.screen);
    if (!key) continue;
    const hit = indexed.find((entry) => key.startsWith(entry.key) || (key.length >= 12 && entry.key.startsWith(key)));
    if (!hit) { unmatched.push(screen.screen); continue; }
    if (matched.some((entry) => entry.handle === hit.product.handle)) continue;
    matched.push({ handle: hit.product.handle, title: hit.product.title, screen: screen.screen, count: Number(screen.count || 0) });
    if (matched.length >= limit) break;
  }
  return { matched, unmatched };
}

export function shippingQuery(address) {
  const params = new URLSearchParams();
  params.set('shipping_address[zip]', String(address?.zip || ''));
  params.set('shipping_address[country]', String(address?.country || ''));
  if (address?.province) params.set('shipping_address[province]', String(address.province));
  return params.toString();
}

function summarizeCart(cart) {
  if (!cart || typeof cart !== 'object') return null;
  return {
    itemCount: Number(cart.item_count || 0),
    totalPrice: Number(cart.total_price || 0),
    currency: cart.currency || '',
    items: (cart.items || []).map((item) => ({
      handle: item.handle || '',
      variantId: item.variant_id,
      quantity: Number(item.quantity || 0),
      price: Number(item.price || 0),
      finalLinePrice: Number(item.final_line_price || 0),
      requiresShipping: item.requires_shipping !== false,
    })),
  };
}

function responseError(response) {
  const json = response.json;
  if (json && typeof json === 'object') {
    if (typeof json.description === 'string') return json.description;
    if (typeof json.message === 'string') return json.message;
    const firstField = Object.keys(json)[0];
    if (firstField && Array.isArray(json[firstField])) return `${firstField}: ${json[firstField].join(', ')}`;
  }
  return `HTTP ${response.status}${response.text ? ` ${response.text.slice(0, 120)}` : ''}`;
}

/* One product through the funnel: clear → add 1 → read cart → ask shipping
   rates for the address → clear. Returns a plain record; never throws. */
export async function probeProduct(client, product, address, { pollAttempts = 6, pollDelayMs = 1_000, sleep = defaultSleep } = {}) {
  const variant = (product.variants || []).find((entry) => entry.available) || (product.variants || [])[0];
  const result = {
    handle: product.handle,
    title: product.title,
    variantId: variant?.id ?? null,
    variantTitle: variant?.title ?? '',
    variantAvailable: Boolean(variant?.available),
    add: null,
    cart: null,
    ratesStatus: null,
    rates: null,
    ratesError: null,
    error: null,
  };
  if (!variant) { result.error = 'product has no variants'; return result; }
  try {
    await client.request('/cart/clear.js', { method: 'POST' });
    const add = await client.request('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: variant.id, quantity: 1 }] }),
    });
    result.add = { status: add.status, error: add.ok ? null : responseError(add) };
    if (!add.ok) return result;

    const cart = await client.request('/cart.js');
    result.cart = cart.ok ? summarizeCart(cart.json) : null;
    if (!cart.ok) result.error = `cart.js ${responseError(cart)}`;

    const path = `/cart/shipping_rates.json?${shippingQuery(address)}`;
    let rates = await client.request(path);
    let attempts = 0;
    while (rates.status === 202 && attempts < pollAttempts) {
      attempts += 1;
      await sleep(pollDelayMs);
      rates = await client.request(path);
    }
    result.ratesStatus = rates.status;
    if (rates.ok && Array.isArray(rates.json?.shipping_rates)) {
      result.rates = rates.json.shipping_rates.map((rate) => ({
        name: String(rate.name || rate.code || ''),
        price: Number(rate.price),
        currency: String(rate.currency || ''),
      }));
    } else {
      result.ratesError = rates.status === 202 ? 'shipping rates still processing after polling' : responseError(rates);
    }
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 200);
  } finally {
    try { await client.request('/cart/clear.js', { method: 'POST' }); } catch { /* best effort */ }
  }
  return result;
}

export function snapshotEntry(product, probe) {
  const prices = (product?.variants || []).map((variant) => variant.price).filter(Number.isFinite);
  return {
    title: product?.title || probe?.title || '',
    updatedAt: product?.updatedAt || null,
    minPrice: prices.length ? Math.min(...prices) : null,
    available: (product?.variants || []).some((variant) => variant.available),
    variantCount: (product?.variants || []).length,
    tags: product?.tags || [],
    add: probe?.add || null,
    cart: probe?.cart || null,
    ratesStatus: probe?.ratesStatus ?? null,
    rates: probe?.rates || null,
    ratesError: probe?.ratesError || null,
    error: probe?.error || null,
  };
}

export function buildSnapshot({ takenAt, address, products, probes }) {
  const byHandle = new Map((products || []).map((product) => [product.handle, product]));
  const entries = {};
  for (const probe of probes || []) entries[probe.handle] = snapshotEntry(byHandle.get(probe.handle), probe);
  return { takenAt, address: { zip: address?.zip || '', country: address?.country || '', province: address?.province || '' }, products: entries };
}

const money = (value, currency = 'RM') => `${currency === 'MYR' || !currency ? 'RM' : currency} ${(Number(value) / 100).toFixed(2)}`;
const rateText = (rate) => `${rate.name} ${rate.price === 0 ? '免运' : `${rate.currency || 'MYR'} ${rate.price.toFixed(2)}`}`;

/* Human-readable differences between the nightly snapshot entry and the
   probe taken now. Empty array = nothing changed. */
export function diffProbe(previous, current) {
  const changes = [];
  if (!previous) return changes;
  if (previous.updatedAt && current.updatedAt && previous.updatedAt !== current.updatedAt) {
    changes.push(`商品在快照之后被修改过（Shopify updated_at ${previous.updatedAt} → ${current.updatedAt}）`);
  }
  if (previous.minPrice !== null && current.minPrice !== null && previous.minPrice !== current.minPrice) {
    changes.push(`价格 ${previous.minPrice} → ${current.minPrice}`);
  }
  if (previous.available && !current.available) changes.push('商品从可购买变成不可购买');
  if (!previous.available && current.available) changes.push('商品从不可购买变成可购买');
  if (previous.cart && current.cart && previous.cart.itemCount !== current.cart.itemCount) {
    changes.push(`加 1 件后购物车 ${previous.cart.itemCount} 件 → ${current.cart.itemCount} 件（自动加入的东西变了）`);
  }
  if (previous.cart && current.cart && previous.cart.totalPrice !== current.cart.totalPrice) {
    changes.push(`购物车金额 ${money(previous.cart.totalPrice, previous.cart.currency)} → ${money(current.cart.totalPrice, current.cart.currency)}`);
  }
  const hadRates = Array.isArray(previous.rates);
  const hasRates = Array.isArray(current.rates);
  if (hadRates && !hasRates) changes.push(`运费查询从正常变成失败：${current.ratesError || current.error || '未知错误'}`);
  if (!hadRates && hasRates) changes.push('运费查询从失败恢复正常');
  if (hadRates && hasRates) {
    const before = new Map(previous.rates.map((rate) => [rate.name, rate]));
    const after = new Map(current.rates.map((rate) => [rate.name, rate]));
    const hadFree = previous.rates.some((rate) => rate.price === 0);
    const hasFree = current.rates.some((rate) => rate.price === 0);
    if (hadFree && !hasFree) changes.push('免运费选项消失了');
    if (!hadFree && hasFree) changes.push('新出现免运费选项');
    for (const [name, rate] of before) {
      if (!after.has(name)) changes.push(`运费选项消失：${rateText(rate)}`);
      else if (after.get(name).price !== rate.price) changes.push(`运费变价：${name} ${rate.price.toFixed(2)} → ${after.get(name).price.toFixed(2)}`);
    }
    for (const [name, rate] of after) if (!before.has(name)) changes.push(`新运费选项：${rateText(rate)}`);
    if (previous.rates.length && !current.rates.length) changes.push('运费选项从有变成没有');
  }
  return changes;
}

/* The verdict is deliberately a short list of rules of thumb; the message
   shows the evidence so the reader can disagree. */
export function verdict(results) {
  const failing = results.filter((entry) => entry.probe.add?.error || entry.probe.error);
  if (failing.length) return `最可能：加购本身失败（${failing.map((entry) => `${entry.handle}: ${entry.probe.add?.error || entry.probe.error}`).join('；')}）。先查商品是否下架/售罄。`;
  const noRates = results.filter((entry) => !Array.isArray(entry.probe.rates) || entry.probe.rates.length === 0);
  if (noRates.length) return `最可能：结账拿不到运费方案（${noRates.map((entry) => `${entry.handle}: ${entry.probe.ratesError || '没有任何选项'}`).join('；')}）。先查 Shopify 后台 Settings → Shipping and delivery 的方案与商品所属 profile。`;
  const freeGone = results.filter((entry) => entry.changes.some((change) => change.includes('免运费选项消失')));
  if (freeGone.length) return `最可能：免运费方案被关掉或改了条件（${freeGone.map((entry) => entry.handle).join('、')}）。这正是 2026-09-15 那次的模式。`;
  const edited = results.filter((entry) => entry.changes.some((change) => change.includes('被修改过')));
  if (edited.length) return `商品在快照之后被后台修改过（${edited.map((entry) => entry.handle).join('、')}），先看那次修改改了什么（价格、库存、运费 profile、赠品规则）。`;
  const changed = results.filter((entry) => entry.changes.length);
  if (changed.length) return `探测到变化（${changed.map((entry) => entry.handle).join('、')}），见上面各条；加购和运费本身仍可用。`;
  return '探测没发现异常：加购、购物车、运费方案都正常。原因可能在结账页本身（付款方式、折扣码、地址校验）或流量端（广告落地页、GA4 采集），本探测覆盖不到这些。';
}

export function renderInvestigation({ ruleLabel, address, results, unmatched = [], snapshotTakenAt = null, siteLabel = '' }) {
  const lines = [`🔎 [第4层·调查员] ${ruleLabel || ''} 自动排查`.trim()];
  lines.push(`对象：GA4 最近 30 分钟加购最多的商品页，各加 1 件试走到运费（邮编 ${address?.zip || '?'}，不进结账）`);
  if (!results.length) {
    lines.push(unmatched.length ? `GA4 的页面标题对不上任何商品：${unmatched.slice(0, 3).join(' | ')}` : '没有可探测的商品页');
  }
  results.forEach((entry, index) => {
    const { probe, changes } = entry;
    lines.push(`${index + 1}. ${entry.title || entry.handle}  /products/${entry.handle}${entry.count ? `（加购 ${entry.count}）` : ''}`);
    if (probe.add?.error) lines.push(`   ❌ 加购失败：${probe.add.error}`);
    else if (probe.error && !probe.cart) lines.push(`   ❌ 探测失败：${probe.error}`);
    if (probe.cart) {
      const extra = probe.cart.itemCount - 1;
      lines.push(`   加 1 件 → 购物车 ${probe.cart.itemCount} 件 ${money(probe.cart.totalPrice, probe.cart.currency)}${extra > 0 ? `（自动加入 +${extra}）` : ''}`);
    }
    if (Array.isArray(probe.rates)) {
      lines.push(probe.rates.length ? `   运费：${probe.rates.map(rateText).join(' · ')}` : '   ❌ 运费：没有任何选项');
    } else if (probe.cart) {
      lines.push(`   ❌ 运费查询失败：${probe.ratesError || probe.error || `HTTP ${probe.ratesStatus}`}`);
    }
    if (!snapshotTakenAt) lines.push('   （还没有快照可比）');
    else if (!entry.hadSnapshot) lines.push(`   （快照 ${snapshotTakenAt.slice(0, 16)} 没有这个商品）`);
    else if (!changes.length) lines.push(`   与快照（${snapshotTakenAt.slice(0, 16)}）相比无变化`);
    else changes.forEach((change) => lines.push(`   ⚠ ${change}`));
  });
  if (results.length && unmatched.length) lines.push(`对不上商品的页面：${unmatched.slice(0, 3).join(' | ')}`);
  if (results.length) lines.push(`结论：${verdict(results)}`);
  lines.push('修复由人来做；这条只是线索。');
  return lines.join('\n');
}

/* Which handles the nightly snapshot covers: the site's fixture products
   (the advertised promo, the gift picker, the bundle, the plain product) plus
   whatever GA4 says paid traffic lands on right now. */
export function snapshotHandles(site, adTargets = []) {
  const handles = [];
  const push = (handle) => { const clean = String(handle || '').trim(); if (clean && !handles.includes(clean)) handles.push(clean); };
  for (const target of adTargets) {
    const match = String(target?.landingPath || '').match(/^\/products\/([^/?#]+)/);
    if (match) push(decodeURIComponent(match[1]));
  }
  const fixtures = site?.fixtures || {};
  for (const key of ['detergentPromo', 'giftPickerV3', 'atomicBundle', 'normalV3', 'laundryPdp']) push(fixtures[key]?.handle);
  return handles;
}
