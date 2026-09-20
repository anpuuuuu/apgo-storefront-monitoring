import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { payableFromCheckout, giftLinesOf } = createRequire(import.meta.url)('./layer2-journeys.js');

/* Captured verbatim from run 35483291509 (2026-09-20 02:10 UTC), the journey
   that failed five days running on the old FREE/0.00 text check. Whitespace and
   commas are stripped exactly as enterCheckout does. */
const REAL_CHECKOUT = 'SkiptocontentNavigatetoOnlineStoreOrdersummaryTotalpriceRM395.00DiscountedpriceRM257.00'
  + 'APGO.MYCheckoutContactSigninEmailUsedforyourorderconfirmationandcartremindersDeliveryCountry/Region'
  + 'MalaysiaSingaporePostcodeCityState/territoryJohorShippingmethodEnteryourshippingaddresstoview'
  + 'availableshippingmethodsPaymentAlltransactionsaresecureandencrypted'
  + 'OrdersummaryOrdersummaryTotal11itemsRM395.00MYRRM257.00FinalizeorderPaynowRM257.00SubmitRefundpolicy';

test('payableFromCheckout reads what the shopper is charged, not the list total', () => {
  // The page shows RM395.00 and RM257.00; only the second is payable.
  assert.equal(payableFromCheckout(REAL_CHECKOUT, 'RM'), '257.00');

  // A letter currency marker must not be excluded: the original bug was a
  // [^A-Za-z] class that could never match "PaynowRM257.00".
  assert.equal(payableFromCheckout('FinalizeorderPaynowRM99.00Submit', 'RM'), '99.00');
  // A regex-special marker must be escaped, not interpreted.
  assert.equal(payableFromCheckout('PaynowS$120.50Submit', 'S$'), '120.50');
  assert.equal(payableFromCheckout('PaynowS$120.50Submit', '$'), null, 'the wrong marker must not half-match');

  // No such label: fall back to the looser whole-page check rather than fail.
  assert.equal(payableFromCheckout('OrdersummaryTotalRM257.00', 'RM'), null);
  assert.equal(payableFromCheckout('', 'RM'), null);
});

test('a checkout that charges the list price instead of the discounted total is caught', () => {
  const overcharged = REAL_CHECKOUT.replace('PaynowRM257.00', 'PaynowRM395.00');
  assert.equal(payableFromCheckout(overcharged, 'RM'), '395.00');
  // enterCheckout compares this against the cart total (257.00) and fails.
  assert.notEqual(payableFromCheckout(overcharged, 'RM'), '257.00');
});

test('giftLinesOf finds zero-priced lines and lines tagged by the promotion apps', () => {
  const names = ['_free_gift', '_gift_for', '_aiod_free_gift', '_gift_pick'];
  // Shape taken from the cart page on 2026-09-20: one free line plus two paid.
  const items = [
    { product_title: 'APGO Laundry Detergent - 1L Promotion', quantity: 1, final_line_price: 0, original_line_price: 3900, properties: {} },
    { product_title: 'APGO Laundry Detergent - 1L Promotion', quantity: 4, final_line_price: 15600, original_line_price: 15600, properties: {} },
    { product_title: 'APGO Laundry Detergent - 1L Promotion', quantity: 3, final_line_price: 11700, original_line_price: 11700, properties: {} },
  ];
  assert.equal(giftLinesOf(items, names).length, 1);
  assert.equal(giftLinesOf(items, names)[0].final_line_price, 0);

  // A line the app tags as a gift but still bills is a real fault, so it must be
  // selected and then fail the "must cost nothing" check in enterCheckout.
  const billedGift = [{ product_title: 'Gift', quantity: 1, final_line_price: 4400, original_line_price: 4400, properties: { _aiod_free_gift: 'yes' } }];
  assert.equal(giftLinesOf(billedGift, names).length, 1);
  assert.equal(giftLinesOf(billedGift, names)[0].final_line_price, 4400);

  // `_bundle_role` is the theme's own buy/gift tag, not a free-gift marker.
  assert.equal(giftLinesOf([{ quantity: 3, final_line_price: 11700, properties: { _bundle_role: 'gift' } }], names).length, 0);
  assert.equal(giftLinesOf([], names).length, 0);
  assert.equal(giftLinesOf([{ quantity: 1, final_line_price: 3900 }], names).length, 0);
});

test('the real cart is discounted below its list value, which is what the gift check asserts', () => {
  const items = [
    { quantity: 1, final_line_price: 0, original_line_price: 3900 },
    { quantity: 4, final_line_price: 15600, original_line_price: 15600 },
    { quantity: 3, final_line_price: 11700, original_line_price: 11700 },
  ];
  const listValue = items.reduce((sum, item) => sum + Number(item.original_line_price ?? item.final_line_price), 0);
  const cartTotal = items.reduce((sum, item) => sum + item.final_line_price, 0);
  assert.equal(listValue, 31200);
  assert.equal(cartTotal, 27300);
  assert.ok(listValue > cartTotal, 'the gift must make the cart cheaper than its list value');
});
