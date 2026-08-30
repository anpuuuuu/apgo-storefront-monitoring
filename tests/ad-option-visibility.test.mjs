import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ad-landing.spec.js', import.meta.url), 'utf8');
const fallbackStart = source.indexOf('// Some PDPs render desktop and mobile radio groups');
const fallbackEnd = source.indexOf('\nasync function chooseVisibleGifts', fallbackStart);
const fallback = source.slice(fallbackStart, fallbackEnd);

test('advertising option exercise ignores CSS-hidden desktop or mobile radio groups', () => {
  assert(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'visible-option fallback must be present');
  assert.match(fallback, /page\.locator\('main label:visible'\)\.evaluateAll/);
  assert.match(fallback, /only a customer-visible product option may be exercised/);
  assert.doesNotMatch(fallback, /page\.locator\('main input\[type="radio"\]\[name\]/);
});
