// Runs tracking.js the way the platform does: `app`, `analytics` and `window` are globals of the
// tracker frame, and gtag lives on the parent (storefront) window. Payload samples follow the
// storefront event-tracking reference: https://developers.nextcommerce.com/docs/storefront/event-tracking
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'tracking.js'), 'utf8');
// Objects built inside the vm have a different Object prototype; compare them as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));

function boot(settings, { parent } = {}) {
    const calls = [];
    const handlers = {};
    const storefront = parent === undefined
        ? { document: { title: 'Sheets | Velin' }, location: { pathname: '/c/sheets/' }, gtag: (...args) => calls.push(args) }
        : parent;
    const context = {
        app: { settings: { google_analytics_enabled: true, google_analytics_measurement_id: 'G-TEST', ...settings } },
        analytics: { subscribe: (name, fn) => { handlers[name] = fn; } },
        window: { parent: storefront },
    };
    vm.runInNewContext(source, context);
    return { calls, emit: (name, data) => handlers[name] && handlers[name]({ event_type: name, data }), handlers };
}

const names = calls => calls.map(c => c[1]);
const line = { currency: 'USD', product_id: 111, sku: 'WATCH-BL', product_title: 'Timeless Watch', variant_title: 'Black', quantity: 2, price_excl_tax: '159.98', price_incl_tax: '171.18', total_discount: '10.00', is_upsell: false };
const second = { ...line, product_id: 222, sku: 'PILLOW', product_title: 'Pillow Cover', variant_title: '', quantity: 1, price_excl_tax: '39.99', price_incl_tax: '42.79', total_discount: '0.00' };
const checkout = { number: '109659', currency: 'USD', total_incl_tax: '218.96', shipping_incl_tax: '4.99', total_tax: '14.00', shipping_method: 'Express', voucher_discounts: [{ name: 'SAVE10' }], lines: [line, second], is_test: false };
const product = { id: 111, title: 'Timeless Watch', categories: [{ name: 'Watches' }], variants: [{ sku: 'WATCH-BL' }], purchase_info: { price: { currency: 'USD', price: '79.99' } } };

test('the tracker stays off when disabled or when the measurement id is empty, whitespace or missing', () => {
    for (const settings of [{ google_analytics_enabled: false }, { google_analytics_measurement_id: '' }, { google_analytics_measurement_id: '  ' }, { google_analytics_measurement_id: null }, { google_analytics_measurement_id: undefined }]) {
        assert.deepEqual(Object.keys(boot(settings).handlers), [], JSON.stringify(settings));
    }
});

test('never throws when the parent has no gtag, is missing, or is cross-origin', () => {
    const crossOrigin = new Proxy({}, { get() { throw new Error('SecurityError'); } });
    for (const [label, parent] of [['plain', {}], ['null', null], ['cross-origin', crossOrigin]]) {
        const { emit } = boot({}, { parent });
        for (const [name, data] of [['product_category_viewed', [product]], ['product_viewed', product], ['product_added_to_cart', line], ['checkout_started', checkout], ['checkout_completed', checkout]]) {
            assert.doesNotThrow(() => emit(name, data), `${name} with ${label} parent`);
        }
    }
});

test('every GA4 event targets the configured measurement id', () => {
    const { calls, emit } = boot({});
    emit('product_category_viewed', [product]);
    emit('product_viewed', product);
    emit('product_added_to_cart', line);
    emit('checkout_started', checkout);
    emit('checkout_shipping_method_submitted', checkout);
    emit('checkout_completed', checkout);
    assert.equal(calls.length, 6);
    for (const [, name, params] of calls) assert.equal(params.send_to, 'G-TEST', name);
});

test('add_to_cart sends numeric unit price and one item shape', () => {
    const { calls, emit } = boot({});
    emit('product_added_to_cart', line);
    const [, name, params] = calls[0];
    assert.equal(name, 'add_to_cart');
    assert.equal(params.value, 159.98);
    assert.deepEqual(plain(params.items[0]), { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', price: 79.99, discount: 5, quantity: 2, index: 0 });
});

test('cart events without a line payload are dropped', () => {
    const { calls, emit } = boot({});
    emit('product_added_to_cart', undefined);
    emit('product_removed_from_cart', { quantity: 1 });
    assert.equal(calls.length, 0);
});

test('unit price guards zero, negative, string and non-numeric inputs', () => {
    const { calls, emit } = boot({});
    emit('product_added_to_cart', { ...line, quantity: 0 });
    emit('product_added_to_cart', { ...line, quantity: -1 });
    emit('product_added_to_cart', { ...line, quantity: '3', price_excl_tax: '10.00', price_incl_tax: '10.70', total_discount: '1.00' });
    emit('product_added_to_cart', { ...line, quantity: undefined, price_excl_tax: undefined, price_incl_tax: 'abc' });
    assert.deepEqual(plain(calls[0][2].items[0]), { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', quantity: 0, index: 0 });
    assert.equal(calls[1][2].items[0].price, undefined);
    assert.deepEqual(plain(calls[2][2].items[0]), { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', price: 3.33, discount: 0.33, quantity: 3, index: 0 });
    assert.equal(calls[3][2].value, undefined);
    assert.equal(calls[3][2].items[0].price, undefined);
});

test('view_item takes the sku from the product, then a single variant, else omits it', () => {
    const { calls, emit } = boot({});
    emit('product_viewed', product);
    emit('product_viewed', { ...product, sku: 'TOP-SKU' });
    emit('product_viewed', { ...product, variants: [{ sku: 'A' }, { sku: 'B' }] });
    emit('product_viewed', { ...product, variants: [], categories: [] });
    assert.deepEqual(plain(calls[0][2]), { currency: 'USD', value: 79.99, items: [{ item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_category: 'Watches', price: 79.99, quantity: 1, index: 0 }], send_to: 'G-TEST' });
    assert.equal(calls[1][2].items[0].sku, 'TOP-SKU');
    assert.equal(calls[2][2].items[0].sku, undefined);
    assert.equal(calls[3][2].items[0].sku, undefined);
    assert.equal(calls[3][2].items[0].item_category, undefined);
});

test('view_item is skipped when the payload has no id', () => {
    const { calls, emit } = boot({});
    emit('product_viewed', undefined);
    emit('product_viewed', { title: 'No id' });
    emit('product_viewed', { id: null });
    assert.equal(calls.length, 0);
});

test('view_item_list skips invalid entries, identifies the list by path, caps at 200 items, and takes currency from the first priced product', () => {
    const { calls, emit } = boot({});
    emit('product_category_viewed', []);
    emit('product_category_viewed', { id: 1 });
    emit('product_category_viewed', [null, { id: null }]);
    assert.equal(calls.length, 0);
    const many = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, title: `P${i + 1}` }));
    emit('product_category_viewed', [null, { id: null, title: 'Broken' }, { id: 5, title: 'Unpriced' }, ...many, { id: 9, title: 'Sheets', purchase_info: { price: { currency: 'USD', price: '109.99' } } }]);
    const params = calls[0][2];
    assert.equal(params.items.length, 200);
    assert.equal(params.item_list_id, '/c/sheets/');
    assert.equal(params.item_list_name, 'Sheets | Velin');
    assert.equal(params.currency, 'USD', 'currency is taken before truncation');
    const { calls: c2, emit: e2 } = boot({});
    e2('product_category_viewed', [{ id: 5, title: 'Unpriced' }, { id: 9, title: 'Sheets', purchase_info: { price: { currency: 'EUR', price: '99.00' } } }]);
    assert.equal(c2[0][2].currency, 'EUR');
});

test('begin_checkout value is item revenue, not the order total, and drops lines without a product', () => {
    const { calls, emit } = boot({});
    emit('checkout_started', { ...checkout, lines: [line, second, { product_id: null, quantity: 1, price_incl_tax: '5.00' }] });
    const [, name, params] = calls[0];
    assert.equal(name, 'begin_checkout');
    assert.equal(params.value, 199.97, '159.98 + 39.99, deleted-product line ignored');
    assert.equal(params.currency, 'USD');
    assert.equal(params.coupon, 'SAVE10');
    assert.deepEqual(plain(params.items), [
        { item_id: '111', item_name: 'Timeless Watch', sku: 'WATCH-BL', item_variant: 'Black', price: 79.99, discount: 5, quantity: 2, index: 0 },
        { item_id: '222', item_name: 'Pillow Cover', sku: 'PILLOW', price: 39.99, discount: 0, quantity: 1, index: 1 },
    ]);
});

test('checkout events without a payload are dropped, and an empty cart or missing voucher leaves value and coupon unset', () => {
    const { calls, emit } = boot({});
    emit('checkout_started', undefined);
    emit('checkout_completed', null);
    assert.equal(calls.length, 0);
    emit('checkout_shipping_method_submitted', { ...checkout, lines: [], voucher_discounts: [], shipping_method: null });
    const params = plain(calls[0][2]);
    assert.deepEqual(params, { currency: 'USD', items: [], send_to: 'G-TEST' });
});

test('add_shipping_info carries the shipping tier and the same item revenue', () => {
    const { calls, emit } = boot({});
    emit('checkout_shipping_method_submitted', checkout);
    assert.equal(calls[0][1], 'add_shipping_info');
    assert.equal(calls[0][2].shipping_tier, 'Express');
    assert.equal(calls[0][2].value, 199.97);
});

test('purchase reconciles to its items and carries shipping and tax separately; the Ads conversion uses the order total', () => {
    const { calls, emit } = boot({ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'abc' });
    emit('checkout_completed', checkout);
    const purchase = calls.find(c => c[1] === 'purchase')[2];
    const conversion = calls.find(c => c[1] === 'conversion')[2];
    assert.equal(purchase.transaction_id, '109659');
    assert.equal(purchase.value, 199.97);
    assert.equal(purchase.value, purchase.items.reduce((sum, i) => sum + i.price * i.quantity, 0));
    assert.equal(purchase.shipping, 4.99);
    assert.equal(purchase.tax, 14);
    assert.equal(purchase.coupon, 'SAVE10');
    assert.deepEqual(plain(conversion), { send_to: 'AW-123/abc', transaction_id: '109659', value: 218.96, currency: 'USD' });
});

test('the Ads destination is configured once at startup only when the settings validate', () => {
    const on = boot({ google_adwords_conversion_enabled: true, google_adwords_conversion_id: ' aw-123 ', google_adwords_conversion_label: 'abc' });
    assert.deepEqual(on.calls, [['config', 'AW-123']]);
    for (const settings of [{}, { google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123' }, { google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'aw123', google_adwords_conversion_label: 'abc' }, { google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'aw-123-aw-456', google_adwords_conversion_label: 'abc' }]) {
        assert.equal(boot(settings).calls.length, 0, JSON.stringify(settings));
    }
});

test('Ads conversion needs the checkbox, a numeric id (bare, prefixed, spaced or lower-case) and a well-formed label', () => {
    const cases = [
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'Abc/Def' }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: "ab'c" }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'AbC_d-9' }, 'AW-123/AbC_d-9'],
        [{ google_adwords_conversion_enabled: false, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'abc' }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123' }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: undefined, google_adwords_conversion_label: 'abc' }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123/abc', google_adwords_conversion_label: 'abc' }, null],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: 'AW-123', google_adwords_conversion_label: 'abc' }, 'AW-123/abc'],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: '123', google_adwords_conversion_label: 'abc' }, 'AW-123/abc'],
        [{ google_adwords_conversion_enabled: true, google_adwords_conversion_id: ' aw-123 ', google_adwords_conversion_label: ' abc ' }, 'AW-123/abc'],
    ];
    for (const [settings, expected] of cases) {
        const { calls, emit } = boot(settings);
        emit('checkout_completed', checkout);
        const conversion = calls.find(c => c[1] === 'conversion');
        assert.equal(conversion ? conversion[2].send_to : null, expected, JSON.stringify(settings));
    }
});

test('test orders are skipped only when the setting is on', () => {
    const on = boot({ google_analytics_skip_test_orders: true });
    on.emit('checkout_completed', { ...checkout, is_test: true });
    assert.equal(on.calls.length, 0);
    const off = boot({});
    off.emit('checkout_completed', { ...checkout, is_test: true });
    off.emit('checkout_completed', { ...checkout, is_test: null });
    assert.deepEqual(names(off.calls), ['purchase', 'purchase']);
});

test('every template interpolation inside the snippet script block is escaped, and the gates match the tracker', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'global-header.html'), 'utf8');
    assert.match(html.split('\n')[0], /google_analytics_enabled and app\.settings\.google_analytics_measurement_id\.strip/);
    assert.doesNotMatch(html, /adwords/, 'Ads settings are handled by tracking.js only');
    const interpolations = [...html.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(m => m[1]);
    assert.ok(interpolations.length >= 3);
    for (const expr of interpolations) assert.match(expr, /\|(escapejs|urlencode)$/, `unescaped interpolation: ${expr}`);
});
