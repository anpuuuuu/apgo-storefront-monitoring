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
  assert.match(mobilePath, /centerAndAssertTappable\(page, opener/);
  assert.match(source, /element\.scrollIntoView\(\{ block: 'center'/);
  assert.match(source, /document\.elementFromPoint\(x, y\)/);
  assert.match(source, /must not be covered by the sticky buy bar/);
});
