import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ad-landing.spec.js', import.meta.url), 'utf8');
const fallbackStart = source.indexOf('// Some PDPs render desktop and mobile radio groups');
const fallbackEnd = source.indexOf('\nasync function chooseVisibleGifts', fallbackStart);
const fallback = source.slice(fallbackStart, fallbackEnd);
const mobileStart = source.indexOf('if (useMobileConfirm)');
const mobileEnd = source.indexOf('\n  // Some PDPs render desktop and mobile radio groups', mobileStart);
const mobilePath = source.slice(mobileStart, mobileEnd);

test('advertising option exercise ignores CSS-hidden desktop or mobile radio groups', () => {
  assert(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'visible-option fallback must be present');
  assert.match(fallback, /page\.locator\('main label:visible'\)\.evaluateAll/);
  assert.match(fallback, /only a customer-visible product option may be exercised/);
  assert.match(fallback, /not\(\[name\^="apgo-bundle-"\]\)/);
  assert.doesNotMatch(fallback, /page\.locator\('main input\[type="radio"\]\[name\]/);
});

test('mobile option exercise waits for picker readiness and avoids the sticky buy bar', () => {
  assert(mobileStart >= 0 && mobileEnd > mobileStart, 'mobile confirm path must be present');
  assert.match(mobilePath, /typeof window\.apgoOpenConfirmModal/);
  assert.match(mobilePath, /centerAndAssertTappable\(page, chip/);
  assert.match(source, /element\.scrollIntoView\(\{ block: 'center'/);
  assert.match(source, /document\.elementFromPoint\(x, y\)/);
  assert.match(source, /must not be covered by the sticky buy bar/);
});

test('tapping a mobile option selects it and leaves the purchase-confirm modal shut', () => {
  /* apgo-theme 8088317: "tapping an option no longer forces the purchase-confirm
     modal open ... the modal opens only from Add to cart / Buy now". The journey
     required the opposite until 2026-09-20 and failed on every post-deploy run
     against a storefront that was behaving as designed. Lock the new contract in
     at the source, so the old expectation cannot creep back. */
  assert.match(mobilePath, /toBeChecked\(\)/, "the tap must be shown to select the value");
  assert.match(mobilePath, /must not open the purchase-confirm modal/);
  assert.match(mobilePath, /not\.toHaveClass\(\/is-open\//);
  assert.doesNotMatch(mobilePath, /await expect\(confirmModal[^)]*\)\.toHaveClass\(\/is-open\//, "tapping a chip must never be required to open the modal");
  // Chips are located through the real markup, not "first visible label or button".
  assert.match(mobilePath, /input\[data-apgo-cc-option-input\]/);
});
