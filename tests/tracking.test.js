// Runs tracking.js the way the platform does: `app`, `analytics` and `window` are globals of the
// tracker frame, and gtag lives on window.top. Payload samples follow developer-docs
// content/docs/storefront/event-tracking.mdx.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'tracking.js'), 'utf8');
// Objects built inside the vm have a different Object prototype; compare them as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));

function boot(settings, { withGtag = true } = {}) {
    const calls = [];
    const handlers = {};
    const top = { document: { title: 'Sheets | Velin' }, location: { pathname: '/c/sheets/' } };
    if (withGtag) top.gtag = (...args) => calls.push(args);
    const context = {
        app: { settings: { google_analytics_enabled: true, google_analytics_measurement_id: 'G-TEST', ...settings } },
        analytics: { subscribe: (name, fn) => { handlers[name] = fn; } },
        window: { top },
    };
    vm.runInNewContext(source, context);
    return { calls, emit: (name, data) => handlers[name] && handlers[name]({ event_type: name, data }), handlers };
}

const line = { currency: 'USD', product_id: 111, sku: 'WATCH-BL', product_title: 'Timeless Watch', variant_title: 'Black', quantity: 2, price_incl_tax: '159.98', total_discount: '10.00', is_upsell: false };
const checkout = { number: '109659', currency: 'USD', total_incl_tax: '164.97', shipping_incl_tax: '4.99', total_tax: '0.00', shipping_method: 'Express', voucher_discounts: [{ name: 'SAVE10' }], lines: [line], is_test: false };

test('does nothing without a measurement id', () => {
    const { handlers } = boot({ google_analytics_measurement_id: '' });
    assert.deepEqual(Object.keys(handlers), []);
});

test('never throws when gtag is missing from the storefront window', () => {
    const { emit } = boot({}, { withGtag: false });
    assert.doesNotThrow(() => emit('product_added_to_cart', line));
});

test('add_to_cart sends numeric unit price and one item shape', () => {
    const { calls, emit } = boot({});
    emit('product_added_to_cart', line);
    const [, name, params] = calls[0];
    assert.equal(name, 'add_to_cart');
    assert.equal(params.value, 159.98);
    assert.deepEqual(plain(params.items[0]), { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', price: 79.99, discount: 5, quantity: 2, index: 0 });
});

test('remove_from_cart, view_item_list and add_shipping_info are mapped', () => {
    const { calls, emit } = boot({});
    emit('product_removed_from_cart', line);
    emit('product_category_viewed', [{ id: 5, title: 'Sheets', purchase_info: { price: { currency: 'USD', price: '109.99' } } }]);
    emit('checkout_shipping_method_submitted', checkout);
    assert.deepEqual(calls.map(c => c[1]), ['remove_from_cart', 'view_item_list', 'add_shipping_info']);
    assert.equal(calls[1][2].items[0].price, 109.99);
    assert.equal(calls[2][2].shipping_tier, 'Express');
});

test('begin_checkout maps a multi-line cart with coupon and numeric value', () => {
    const { calls, emit } = boot({});
    const second = { ...line, product_id: 222, sku: 'PILLOW', product_title: 'Pillow Cover', variant_title: '', quantity: 1, price_incl_tax: '39.99', total_discount: '0.00' };
    emit('checkout_started', { ...checkout, lines: [line, second] });
    const [, name, params] = calls[0];
    assert.equal(name, 'begin_checkout');
    assert.equal(params.value, 164.97);
    assert.equal(params.currency, 'USD');
    assert.equal(params.coupon, 'SAVE10');
    assert.deepEqual(plain(params.items), [
        { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', price: 79.99, discount: 5, quantity: 2, index: 0 },
        { item_id: '222', item_name: 'Pillow Cover', sku: 'PILLOW', price: 39.99, discount: 0, quantity: 1, index: 1 },
    ]);
});

test('category lists skip null entries and identify the list by path', () => {
    const { calls, emit } = boot({});
    emit('product_category_viewed', [null, { id: null, title: 'Broken' }, { id: 5, title: 'Sheets', purchase_info: { price: { currency: 'USD', price: '109.99' } } }]);
    assert.equal(calls[0][2].items.length, 1);
    assert.equal(calls[0][2].item_list_id, '/c/sheets/');
});

test('a missing quantity leaves unit price undefined instead of inventing one', () => {
    const { calls, emit } = boot({});
    emit('product_added_to_cart', { ...line, quantity: undefined });
    assert.equal(calls[0][2].items[0].price, undefined);
    assert.equal(calls[0][2].items[0].quantity, undefined);
});

test('Ads conversion is skipped when the id lacks the AW- prefix', () => {
    const { calls, emit } = boot({ google_adwords_conversion_enabled: true, google_adwords_conversion_id: '123', google_adwords_conversion_label: 'abc' });
    emit('checkout_completed', checkout);
    assert.deepEqual(calls.map(c => c[1]), ['purchase']);
});

test('view_item is skipped when the payload has no id', () => {
    const { calls, emit } = boot({});
    emit('product_viewed', undefined);
    emit('product_viewed', { title: 'No id' });
    assert.equal(calls.length, 0);
});

test('view_item uses the same item identity as the cart events', () => {
    const { calls, emit } = boot({});
    emit('product_viewed', { id: 111, title: 'Timeless Watch', categories: [{ name: 'Watches' }], variants: [{ sku: 'WATCH-BL' }, { sku: 'WATCH-BR' }], purchase_info: { price: { currency: 'USD', price: '79.99' } } });
    assert.equal(calls[0][2].items[0].item_id, '111');
    assert.equal(calls[0][2].items[0].sku, undefined, 'multi-variant product: viewed variant unknown, sku omitted');
    assert.equal(calls[0][2].items[0].item_category, 'Watches');
    assert.equal(calls[0][2].value, 79.99);
});

test('purchase carries numeric totals and the Ads conversion uses the order total', () => {
    const { calls, emit } = boot({ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'abc' });
    emit('checkout_completed', checkout);
    const purchase = calls.find(c => c[1] === 'purchase')[2];
    const conversion = calls.find(c => c[1] === 'conversion')[2];
    assert.equal(purchase.transaction_id, '109659');
    assert.equal(purchase.value, 164.97);
    assert.equal(purchase.shipping, 4.99);
    assert.equal(purchase.tax, 0);
    assert.equal(purchase.coupon, 'SAVE10');
    assert.deepEqual(plain(conversion), { send_to: 'AW-123/abc', transaction_id: '109659', value: 164.97, currency: 'USD' });
});

test('test orders are skipped only when the setting is on', () => {
    const on = boot({ google_analytics_skip_test_orders: true });
    on.emit('checkout_completed', { ...checkout, is_test: true });
    assert.equal(on.calls.length, 0);
    const off = boot({});
    off.emit('checkout_completed', { ...checkout, is_test: true });
    assert.equal(off.calls.length, 1);
});
