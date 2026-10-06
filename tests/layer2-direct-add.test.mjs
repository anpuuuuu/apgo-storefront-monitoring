import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { waitsForMobileConfirm } = createRequire(import.meta.url)('./monitor-fixture.js');

/* waitsForMobileConfirm runs inside the page through button.evaluate, so it
   reads window and document as globals. These tests stand up the smallest
   page that has the same shape: a buy bar that may carry direct-add, and
   gift pickers that may or may not sit inside the cart/event gift modals. */

const realWindow = globalThis.window;
const realDocument = globalThis.document;
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.document = realDocument;
});

function page({ width = 375, directAdd = false, giftPickers = [] } = {}) {
  globalThis.window = { innerWidth: width };
  globalThis.document = {
    querySelector(selector) {
      if (selector === '[data-apgo-cc-buybar][data-apgo-cc-direct-add]') return directAdd ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== '[data-apgo-cc-gift-picker]') return [];
      return giftPickers.map((insideModal) => ({
        closest: (ancestor) => (insideModal && ancestor === insideModal ? {} : null),
      }));
    },
  };
}

const button = (...attributes) => ({ hasAttribute: (name) => attributes.includes(name) });
const ADD = button('data-apgo-cc-buybar-add');
const BUY = button('data-apgo-cc-buybar-checkout');

test('a v3 buy bar without direct-add still opens the confirm sheet', () => {
  page({ directAdd: false });
  assert.equal(waitsForMobileConfirm(ADD), true);
  assert.equal(waitsForMobileConfirm(BUY), true);
});

test('direct-add commits straight away, for Add to cart and Buy now alike', () => {
  /* 2026-10-06 Pocket-Friendly Deals: tapping the buy bar added the item at
     once. The theme sends both intents through commitDirect, so neither
     button may be made to wait for a sheet. */
  page({ directAdd: true });
  assert.equal(waitsForMobileConfirm(ADD), false);
  assert.equal(waitsForMobileConfirm(BUY), false);
});

test('an active gift picker keeps the sheet even under direct-add', () => {
  // On phones the free gifts are chosen inside the sheet, so the theme opens
  // it regardless. Skipping it here would test a path no customer can take.
  page({ directAdd: true, giftPickers: [null] });
  assert.equal(waitsForMobileConfirm(ADD), true);
});

test('gift pickers inside the cart or event gift modals do not count', () => {
  /* Same exclusions the theme applies when it computes giftPickerActive.
     A picker that only lives in the cart drawer does not change what the
     product page buy bar does. */
  page({ directAdd: true, giftPickers: ['[data-apgo-cart-gift-modal]', '[data-apgo-event-gift-modal]'] });
  assert.equal(waitsForMobileConfirm(ADD), false);
  // One genuine page picker alongside them is enough to bring the sheet back.
  page({ directAdd: true, giftPickers: ['[data-apgo-cart-gift-modal]', null] });
  assert.equal(waitsForMobileConfirm(ADD), true);
});

test('desktop never waits for the sheet, whatever the bar says', () => {
  // The theme's openConfirmModal returns early from 1024px; the desktop page
  // uses inline buttons instead.
  page({ width: 1024, directAdd: false });
  assert.equal(waitsForMobileConfirm(ADD), false);
  page({ width: 1023, directAdd: false });
  assert.equal(waitsForMobileConfirm(ADD), true, '1023px is still a phone layout');
});

test('legacy v2 buttons keep their own confirm, untouched by direct-add', () => {
  // direct-add is a v3 buy bar attribute; the older [data-apgo-confirm] sheet
  // is a different component and behaves as it always did.
  page({ directAdd: true });
  assert.equal(waitsForMobileConfirm(button('data-apgo-add')), true);
  assert.equal(waitsForMobileConfirm(button('data-apgo-buy-now')), true);
});

test('an ordinary add button opens nothing', () => {
  page({ directAdd: false });
  assert.equal(waitsForMobileConfirm(button('name')), false);
});

test('the function survives being serialized into the page', () => {
  /* Playwright ships it to the browser as source text, so anything it closes
     over would be undefined there. Rebuilding it from its own source and
     running that copy proves it carries everything it needs. */
  const rebuilt = new Function(`return (${waitsForMobileConfirm.toString()})`)();
  page({ directAdd: true });
  assert.equal(rebuilt(ADD), false);
  page({ directAdd: false });
  assert.equal(rebuilt(ADD), true);
});
