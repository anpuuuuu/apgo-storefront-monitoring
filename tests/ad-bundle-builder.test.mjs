import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ad-landing.spec.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('async function prepareBundleBuilder');
const helperEnd = source.indexOf('\nasync function reachPurchasableArea', helperStart);
const helper = source.slice(helperStart, helperEnd);

test('advertising journeys complete a bundle builder before requiring purchase CTAs', () => {
  assert(helperStart >= 0 && helperEnd > helperStart, 'bundle builder helper must be present');
  assert.match(helper, /data-apgo-bundle-action="all-same"/);
  assert.match(helper, /bundle scent allocation must survive the component update/);
  assert.match(helper, /data-apgo-bundle-add/);
  assert.match(helper, /data-apgo-bundle-buy-now/);
  assert.match(source, /await prepareBundleBuilder\(page\);[\s\S]*?let add = page\.locator\(addSelector\)/);
});
