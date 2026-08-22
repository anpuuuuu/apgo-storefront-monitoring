import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readRepoFile = (relativePath) => readFileSync(`${repoRoot}${relativePath}`, 'utf8');

test('event listing cards provide the product-card link ref required by the theme component', () => {
  const liquid = readRepoFile('snippets/apgo-event-listing-card.liquid');
  assert.match(liquid, /<product-card[\s\S]*?<a[\s\S]*?ref="productCardLink"/);
});

test('PDP cart writes lock every purchase entry point and surface only real failures', () => {
  const script = readRepoFile('assets/apgo-cc-pdp-picker.js');
  assert.match(script, /var cartRequestInFlight = false/);
  assert.match(script, /\[addBtn, buyBtn, buybarAddBtn, buybarBuyBtn, confirmAddBtn, confirmBuyBtn\]/);
  assert.match(script, /if \(cartRequestInFlight\)[\s\S]*?request_in_flight[\s\S]*?silent: true/);
  assert.match(script, /setPurchaseRequestBusy\(true, btn\)/);
  assert.match(script, /\.finally\(function \(\) \{[\s\S]*?cartRequestInFlight = false;[\s\S]*?setPurchaseRequestBusy\(false, btn\)/);
  assert.match(script, /function isSilentCartError[\s\S]*?choose-gifts/);
  assert.match(script, /function handleCartFailure/);
  assert.match(script, /addToCart\(\{ btn: addBtn \}\)\.catch\(function \(error\) \{[\s\S]*?handleCartFailure\(error\)/);
  assert.match(script, /addToCart\(\{ btn: buyBtn, silent: true \}\)[\s\S]*?handleCartFailure\(error\)/);
  assert.match(script, /function commitFromConfirm[\s\S]*?handleCartFailure\(error\)/);
});

test('cart quantity failures explain refresh state and restore server-rendered cart', () => {
  const script = readRepoFile('assets/component-cart-items.js');
  assert.match(script, /We couldn't update your cart\. Refreshing your cart/);
  assert.match(script, /sectionRenderer\.renderSection\(this\.sectionId, \{ cache: false \}\)/);
  assert.match(script, /Your cart has been refreshed\. Please try again\./);
  assert.match(script, /We couldn't refresh your cart\. Please reload the page before continuing\./);
});
