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
  assert.match(script, /function confirmUnknownAddOutcome/);
  assert.match(script, /quantityAfter < quantityBefore \+ quantity/);
  assert.match(script, /cart add response was lost; cart state confirmed the add/);
  const recoveryBlock = script.slice(
    script.indexOf('function confirmUnknownAddOutcome'),
    script.indexOf('function purchaseButtons'),
  );
  assert.doesNotMatch(recoveryBlock, /cart\/add\.js/);
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

test('PDP free-gift popup keeps its timer below the image and has no competing CTA', () => {
  const liquid = readRepoFile('snippets/apgo-promo-popup.liquid');
  const script = readRepoFile('assets/apgo-promo-popup.js');
  const section = readRepoFile('sections/apgo_product_page_v3.liquid');
  const visualStart = liquid.indexOf('class="apgo-promo-popup__visual"');
  const visualEnd = liquid.indexOf('class="apgo-promo-popup__body"');
  const image = liquid.indexOf('class="apgo-promo-popup__media"', visualStart);
  const timer = liquid.indexOf('data-apgo-promo-timer', visualStart);
  assert(visualStart >= 0 && image > visualStart && timer > image && timer < visualEnd);
  assert.doesNotMatch(liquid, /data-apgo-promo-cta|apgo-promo-popup__cta/);
  assert.doesNotMatch(script, /data-apgo-promo-cta/);
  assert.doesNotMatch(section, /promo_popup_cta|apgo-promo-popup__cta/);
});
