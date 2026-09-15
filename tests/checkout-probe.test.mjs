import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSnapshot,
  createStorefrontClient,
  diffProbe,
  fetchCatalog,
  matchScreensToProducts,
  normalizeTitle,
  probeProduct,
  renderInvestigation,
  shippingQuery,
  snapshotEntry,
  snapshotHandles,
  verdict,
} from '../scripts/checkout-probe-lib.mjs';

const ADDRESS = { zip: '86900', country: 'MY', province: 'Johor' };
const promo = {
  id: 9085513072794,
  handle: 'apgo-laundry-detergent-special-promotion-1',
  title: 'APGO Laundry Detergent - 1L Promotion',
  updated_at: '2026-09-14T10:00:00+08:00',
  published_at: '2026-08-05T22:51:11+08:00',
  tags: ['promo'],
  variants: [
    { id: 48952581488794, title: 'Rose', price: '39.00', compare_at_price: null, available: true, requires_shipping: true },
    { id: 48952581587098, title: 'Freesia', price: '39.00', compare_at_price: null, available: false, requires_shipping: true },
  ],
};
const mold = {
  id: 2, handle: 'apgo-laundry-whitening-salt-500g-copy', title: 'APGO Mold Remover 500ml', updated_at: '2026-08-01T00:00:00+08:00',
  tags: '', variants: [{ id: 22, title: 'Default', price: '19.90', available: true }],
};

/* A fake apgo.my: cookie-keyed cart, 202-then-200 shipping rates, province required. */
function fakeStore({ ratesPending = 1, rates = [{ name: 'West Malaysia Shipping 3-5 Days', price: '2.90', currency: 'MYR' }], addStatus = 200, autoGift = 0 } = {}) {
  const carts = new Map();
  const calls = [];
  let pending = ratesPending;
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const cookie = init.headers?.cookie || '';
    calls.push({ pathname, method: init.method || 'GET', cookie, ua: init.headers?.['user-agent'] });
    const respond = (status, body, setCookie) => ({
      status, ok: status >= 200 && status < 300,
      headers: { getSetCookie: () => (setCookie ? [setCookie] : []), get: () => null },
      text: async () => JSON.stringify(body),
    });
    if (pathname === '/products.json') {
      const page = Number(searchParams.get('page'));
      return respond(200, { products: page === 1 ? [promo, mold] : [] });
    }
    const token = cookie.match(/cart=([^;]+)/)?.[1] || `tok${carts.size + 1}`;
    if (pathname === '/cart/clear.js') { carts.set(token, []); return respond(200, { item_count: 0, items: [] }); }
    if (pathname === '/cart/add.js') {
      if (addStatus !== 200) return respond(addStatus, { status: addStatus, message: 'Cart Error', description: 'The product is sold out' });
      const items = JSON.parse(init.body).items.map((item) => ({ variant_id: item.id, quantity: item.quantity, price: 3900, final_line_price: 3900, handle: promo.handle, requires_shipping: true }));
      for (let index = 0; index < autoGift; index += 1) items.push({ variant_id: 999, quantity: 1, price: 0, final_line_price: 0, handle: 'free-gift', requires_shipping: true });
      carts.set(token, items);
      return respond(200, { items }, `cart=${token}; path=/; secure`);
    }
    if (pathname === '/cart.js') {
      const items = carts.get(token) || [];
      return respond(200, { token, item_count: items.reduce((sum, item) => sum + item.quantity, 0), total_price: items.reduce((sum, item) => sum + item.final_line_price, 0), currency: 'MYR', items });
    }
    if (pathname === '/cart/shipping_rates.json') {
      if (!searchParams.get('shipping_address[province]')) return respond(422, { province: ['Select a state/territory'] });
      if (pending > 0) { pending -= 1; return respond(202, {}); }
      return respond(200, { shipping_rates: rates });
    }
    return respond(404, { error: 'not found' });
  };
  return { fetchImpl, calls, carts };
}

test('normalizeTitle strips emoji and punctuation; screens match catalog titles by longest prefix', () => {
  assert.equal(normalizeTitle('✨Atomic Coating Mega Promo ✨'), 'atomic coating mega promo');
  assert.equal(normalizeTitle('APGO Laundry Detergent - 1L Promotion – APGO Malaysia'), 'apgo laundry detergent 1l promotion apgo malaysia');
  const catalog = [promo, mold, { handle: 'mold-twin', title: 'APGO Mold Remover 500ml Twin Pack', variants: [] }].map((product) => ({ ...product, tags: [], variants: product.variants || [] }));
  const screens = [
    { screen: 'APGO Mold Remover 500ml Twin Pack – APGO', count: 3 },
    { screen: 'APGO Laundry Detergent - 1L Promotion – APGO Malays', count: 9 },
    { screen: 'Cart – APGO Malaysia', count: 4 },
    { screen: 'APGO Laundry Detergent - 1L Promotion', count: 1 },
  ];
  const { matched, unmatched } = matchScreensToProducts(screens, catalog);
  assert.deepEqual(matched.map((entry) => [entry.handle, entry.count]), [
    ['apgo-laundry-detergent-special-promotion-1', 9],
    ['mold-twin', 3],
  ], 'ordered by count, longest title wins, duplicates collapsed');
  assert.deepEqual(unmatched, ['Cart – APGO Malaysia']);
  assert.equal(matchScreensToProducts(screens, catalog, 1).matched.length, 1);
  // GA4 truncates screen names to 60 chars: a truncated screen still matches when it is a prefix of the title.
  const truncated = [{ screen: 'apgo laundry detergent 1l promo', count: 2 }];
  assert.equal(matchScreensToProducts(truncated, catalog).matched[0]?.handle, promo.handle);
});

test('shippingQuery encodes the Malaysian address the way Shopify wants it', () => {
  assert.equal(shippingQuery(ADDRESS), 'shipping_address%5Bzip%5D=86900&shipping_address%5Bcountry%5D=MY&shipping_address%5Bprovince%5D=Johor');
  assert.equal(shippingQuery({ zip: '86900', country: 'MY' }), 'shipping_address%5Bzip%5D=86900&shipping_address%5Bcountry%5D=MY');
});

test('fetchCatalog paginates /products.json and probeProduct walks add → cart → rates → clear with the cart cookie', async () => {
  const store = fakeStore({ autoGift: 1 });
  const client = createStorefrontClient({ baseUrl: 'https://apgo.my/', fetchImpl: store.fetchImpl });
  const catalog = await fetchCatalog(client);
  assert.deepEqual(catalog.map((product) => product.handle), [promo.handle, mold.handle]);
  assert.equal(catalog[0].variants[0].price, 39);
  assert.equal(catalog[1].tags.length, 0);

  const probe = await probeProduct(client, catalog[0], ADDRESS, { sleep: async () => {} });
  assert.equal(probe.variantId, 48952581488794, 'first available variant');
  assert.deepEqual(probe.add, { status: 200, error: null });
  assert.equal(probe.cart.itemCount, 2, 'store-side free gift counted');
  assert.equal(probe.cart.totalPrice, 3900);
  assert.equal(probe.ratesStatus, 200);
  assert.deepEqual(probe.rates, [{ name: 'West Malaysia Shipping 3-5 Days', price: 2.9, currency: 'MYR' }]);
  assert.equal(probe.ratesError, null);
  assert.equal(probe.error, null);

  const paths = store.calls.map((call) => `${call.method} ${call.pathname}`);
  assert.deepEqual(paths.slice(1), [
    'POST /cart/clear.js', 'POST /cart/add.js', 'GET /cart.js',
    'GET /cart/shipping_rates.json', 'GET /cart/shipping_rates.json',
    'POST /cart/clear.js',
  ], 'polls the 202 once, always clears at the end, never touches /checkout');
  assert.ok(store.calls.slice(3).every((call) => call.cookie.includes('cart=')), 'cart cookie carried after the add');
  assert.ok(store.calls.every((call) => call.ua.startsWith('APGO-Investigator/')));
  assert.equal([...store.carts.values()].at(-1).length, 0, 'cart left empty');
});

test('probeProduct reports sold-out adds, province rejections and rate failures without throwing', async () => {
  const soldOut = fakeStore({ addStatus: 422 });
  const catalog = await fetchCatalog(createStorefrontClient({ baseUrl: 'https://apgo.my', fetchImpl: soldOut.fetchImpl }));
  const client = createStorefrontClient({ baseUrl: 'https://apgo.my', fetchImpl: soldOut.fetchImpl });
  const failed = await probeProduct(client, catalog[0], ADDRESS, { sleep: async () => {} });
  assert.deepEqual(failed.add, { status: 422, error: 'The product is sold out' });
  assert.equal(failed.cart, null);
  assert.equal(soldOut.calls.at(-1).pathname, '/cart/clear.js', 'still clears');

  const noProvince = fakeStore();
  const client2 = createStorefrontClient({ baseUrl: 'https://apgo.my', fetchImpl: noProvince.fetchImpl });
  const rejected = await probeProduct(client2, catalog[0], { zip: '86900', country: 'MY' }, { sleep: async () => {} });
  assert.equal(rejected.ratesStatus, 422);
  assert.equal(rejected.rates, null);
  assert.equal(rejected.ratesError, 'province: Select a state/territory');

  const stuck = fakeStore({ ratesPending: 99 });
  const client3 = createStorefrontClient({ baseUrl: 'https://apgo.my', fetchImpl: stuck.fetchImpl });
  const timedOut = await probeProduct(client3, catalog[0], ADDRESS, { sleep: async () => {}, pollAttempts: 2 });
  assert.equal(timedOut.ratesStatus, 202);
  assert.equal(timedOut.ratesError, 'shipping rates still processing after polling');

  const broken = await probeProduct(createStorefrontClient({ baseUrl: 'https://apgo.my', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), catalog[0], ADDRESS, { sleep: async () => {} });
  assert.equal(broken.error, 'ECONNRESET');
  assert.equal(await probeProduct(client, { handle: 'x', title: 'x', variants: [] }, ADDRESS).then((entry) => entry.error), 'product has no variants');
});

test('snapshot entries diff into the changes a human would look for first', () => {
  const product = { ...promo, tags: ['promo'], updatedAt: '2026-09-14T10:00:00+08:00', variants: [{ id: 1, price: 39, available: true }] };
  const good = { add: { status: 200, error: null }, cart: { itemCount: 10, totalPrice: 23400, currency: 'MYR' }, ratesStatus: 200, rates: [{ name: 'West Malaysia', price: 0, currency: 'MYR' }, { name: 'Express', price: 8, currency: 'MYR' }] };
  const before = snapshotEntry(product, good);
  assert.equal(before.minPrice, 39);
  assert.equal(before.available, true);
  assert.deepEqual(diffProbe(before, before), []);
  assert.deepEqual(diffProbe(null, before), [], 'no snapshot means nothing to diff');

  // 2026-09-15 pattern: free shipping switched off, product edited.
  const freeGone = snapshotEntry({ ...product, updatedAt: '2026-09-15T00:30:00+08:00' }, { ...good, rates: [{ name: 'West Malaysia', price: 2.9, currency: 'MYR' }, { name: 'Express', price: 8, currency: 'MYR' }] });
  const changes = diffProbe(before, freeGone);
  assert.ok(changes.some((line) => line.includes('被修改过')), changes.join('|'));
  assert.ok(changes.some((line) => line === '免运费选项消失了'), changes.join('|'));
  assert.ok(changes.some((line) => line.startsWith('运费变价：West Malaysia 0.00 → 2.90')), changes.join('|'));

  const ratesBroken = snapshotEntry(product, { ...good, rates: null, ratesStatus: 500, ratesError: 'HTTP 500' });
  assert.deepEqual(diffProbe(before, ratesBroken), ['运费查询从正常变成失败：HTTP 500']);
  assert.deepEqual(diffProbe(before, snapshotEntry(product, { ...good, cart: { itemCount: 9, totalPrice: 23400, currency: 'MYR' } })), ['加 1 件后购物车 10 件 → 9 件（自动加入的东西变了）']);
  assert.deepEqual(diffProbe(before, snapshotEntry({ ...product, variants: [{ id: 1, price: 45, available: false }] }, good)), ['价格 39 → 45', '商品从可购买变成不可购买']);
  assert.deepEqual(diffProbe(before, snapshotEntry(product, { ...good, rates: [{ name: 'West Malaysia', price: 0, currency: 'MYR' }] })), ['运费选项消失：Express MYR 8.00']);

  const snapshot = buildSnapshot({ takenAt: '2026-09-15T04:25:00.000Z', address: ADDRESS, products: [product], probes: [{ handle: promo.handle, ...good }] });
  assert.equal(snapshot.address.province, 'Johor');
  assert.equal(snapshot.products[promo.handle].minPrice, 39);
});

test('verdict and the 🔎 message lead with the most likely cause and never claim a fix', () => {
  const ok = { add: { status: 200, error: null }, cart: { itemCount: 10, totalPrice: 23400, currency: 'MYR' }, ratesStatus: 200, rates: [{ name: 'West Malaysia Shipping 3-5 Days', price: 2.9, currency: 'MYR' }] };
  const base = { handle: promo.handle, title: promo.title, count: 7, probe: ok, hadSnapshot: true, changes: [] };
  assert.match(verdict([base]), /没发现异常/);
  assert.match(verdict([{ ...base, changes: ['免运费选项消失了'] }]), /免运费方案被关掉/);
  assert.match(verdict([{ ...base, changes: ['商品在快照之后被修改过（…）'] }]), /被后台修改过/);
  assert.match(verdict([{ ...base, probe: { ...ok, rates: [] } }]), /拿不到运费方案/);
  assert.match(verdict([{ ...base, probe: { ...ok, rates: null, ratesError: 'HTTP 500' } }]), /HTTP 500/);
  assert.match(verdict([{ ...base, probe: { ...ok, add: { status: 422, error: 'sold out' }, cart: null } }]), /加购本身失败/);

  const text = renderInvestigation({
    ruleLabel: '加购后没有结账',
    address: ADDRESS,
    results: [{ ...base, changes: ['免运费选项消失了'] }, { ...base, handle: 'other', title: 'Other', count: 2, hadSnapshot: false }],
    unmatched: ['Cart – APGO Malaysia'],
    snapshotTakenAt: '2026-09-15T04:25:00.000Z',
  });
  assert.ok(text.startsWith('🔎 [第4层·调查员] 加购后没有结账 自动排查'));
  assert.ok(text.includes('邮编 86900，不进结账'));
  assert.ok(text.includes(`1. ${promo.title}  /products/${promo.handle}（加购 7）`));
  assert.ok(text.includes('加 1 件 → 购物车 10 件 RM 234.00（自动加入 +9）'));
  assert.ok(text.includes('运费：West Malaysia Shipping 3-5 Days MYR 2.90'));
  assert.ok(text.includes('⚠ 免运费选项消失了'));
  assert.ok(text.includes('（快照 2026-09-15T04:25 没有这个商品）'));
  assert.ok(text.includes('对不上商品的页面：Cart – APGO Malaysia'));
  assert.ok(text.includes('结论：最可能：免运费方案被关掉'));
  assert.ok(text.endsWith('修复由人来做；这条只是线索。'));
  assert.ok(!/checkout|结账页已/.test(text.replace('不进结账', '').replace('结账页本身', '')));

  const empty = renderInvestigation({ ruleLabel: 'x', address: ADDRESS, results: [], unmatched: ['Home'], snapshotTakenAt: null });
  assert.ok(empty.includes('GA4 的页面标题对不上任何商品：Home'));
});

test('snapshotHandles takes the advertised landing products first, then the fixtures, without duplicates', () => {
  const site = { fixtures: { detergentPromo: { handle: promo.handle }, giftPickerV3: { handle: 'gift' }, atomicBundle: { handle: '✨atomic✨' }, normalV3: { handle: 'towel' }, laundryPdp: { handle: 'laundry' } } };
  const ads = [{ landingPath: '/products/%E2%9C%A8atomic%E2%9C%A8' }, { landingPath: `/products/${promo.handle}?variant=1` }, { landingPath: '/collections/all' }, { landingPath: '/' }];
  assert.deepEqual(snapshotHandles(site, ads), ['✨atomic✨', promo.handle, 'gift', 'towel', 'laundry']);
  assert.deepEqual(snapshotHandles({}, []), []);
});
