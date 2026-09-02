// Google Analytics 4 storefront event tracker.
// Runs in the platform's sandboxed tracker frame; gtag lives on the storefront window (window.top),
// installed by snippets/global-header.html. Every gtag call goes through send() so a page without the
// snippet (no Measurement ID, or a theme without the global_header hook) never throws.
// The snippet applies the same gate (.strip in the template), so both halves agree on when the app is on.
if (app.settings.google_analytics_enabled && String(app.settings.google_analytics_measurement_id || '').trim()) {
    (function () {

        var settings = app.settings;

        var send = function () {
            var top = window.top;
            if (top && typeof top.gtag === 'function') {
                top.gtag.apply(top, arguments);
            }
        };

        // GA4 expects numbers; the storefront payload carries decimal strings ("79.99").
        var num = function (value) {
            var n = parseFloat(value);
            return isNaN(n) ? undefined : n;
        };

        var round = function (value) {
            return value === undefined ? undefined : Math.round(value * 100) / 100;
        };

        var coupon = function (data) {
            var vouchers = data && data.voucher_discounts;
            return vouchers && vouchers.length ? vouchers[0].name : '';
        };

        // One item shape for the whole funnel so item-scoped reports join across events:
        // item_id is the product id everywhere, sku and item_variant identify the child.
        // A product payload only names a sku when it has one (or a single variant); on a
        // multi-variant PDP the viewed variant is not in the payload, so sku is omitted.
        var productItem = function (product, index) {
            var price = product.purchase_info && product.purchase_info.price;
            var variants = product.variants;
            var category = product.categories && product.categories.length ? product.categories[0].name : undefined;
            return {
                item_id: String(product.id),
                item_name: product.title,
                sku: product.sku || (variants && variants.length === 1 ? variants[0].sku : undefined),
                item_category: category,
                price: num(price && price.price),
                quantity: 1,
                index: index
            };
        };

        // Unit price/discount are derived from line totals; when the payload has no positive
        // quantity they are left undefined rather than invented.
        var cartLineItem = function (line, index) {
            var quantity = num(line.quantity);
            var perUnit = function (total) {
                return total === undefined || !(quantity > 0) ? undefined : round(total / quantity);
            };
            return {
                item_id: String(line.product_id),
                item_name: line.product_title,
                sku: line.sku || undefined,
                item_variant: line.variant_title || undefined,
                price: perUnit(num(line.price_incl_tax)),
                discount: perUnit(num(line.total_discount)),
                quantity: quantity,
                index: index
            };
        };

        var checkoutItems = function (data) {
            return ((data && data.lines) || []).map(cartLineItem);
        };

        var currencyOf = function (data) {
            return data && data.currency;
        };

        // The category payload carries the products only (no category object), so the list is
        // identified by the page: path as the stable id, title as the display name.
        analytics.subscribe('product_category_viewed', function (event) {
            var products = (Array.isArray(event.data) ? event.data : []).filter(function (product) {
                return product && product.id != null;
            });
            if (!products.length) { return; }
            var first = products[0].purchase_info && products[0].purchase_info.price;
            var top = window.top || {};
            send('event', 'view_item_list', {
                item_list_id: top.location ? top.location.pathname : undefined,
                item_list_name: top.document ? top.document.title : undefined,
                currency: first && first.currency,
                items: products.map(productItem)
            });
        });

        analytics.subscribe('product_viewed', function (event) {
            var product = event.data;
            if (!product || product.id == null) { return; }
            var price = product.purchase_info && product.purchase_info.price;
            send('event', 'view_item', {
                currency: price && price.currency,
                value: num(price && price.price),
                items: [productItem(product, 0)]
            });
        });

        var cartLineEvent = function (name) {
            return function (event) {
                var line = event.data;
                if (!line || line.product_id == null) { return; }
                send('event', name, {
                    currency: currencyOf(line),
                    value: num(line.price_incl_tax),
                    items: [cartLineItem(line, 0)]
                });
            };
        };

        analytics.subscribe('product_added_to_cart', cartLineEvent('add_to_cart'));
        analytics.subscribe('product_removed_from_cart', cartLineEvent('remove_from_cart'));

        analytics.subscribe('checkout_started', function (event) {
            var data = event.data || {};
            send('event', 'begin_checkout', {
                currency: currencyOf(data),
                value: num(data.total_incl_tax),
                coupon: coupon(data),
                items: checkoutItems(data)
            });
        });

        analytics.subscribe('checkout_shipping_method_submitted', function (event) {
            var data = event.data || {};
            send('event', 'add_shipping_info', {
                currency: currencyOf(data),
                value: num(data.total_incl_tax),
                coupon: coupon(data),
                shipping_tier: data.shipping_method || undefined,
                items: checkoutItems(data)
            });
        });

        analytics.subscribe('checkout_completed', function (event) {
            var data = event.data || {};
            if (data.is_test && settings.google_analytics_skip_test_orders) { return; }

            send('event', 'purchase', {
                currency: currencyOf(data),
                value: num(data.total_incl_tax),
                transaction_id: data.number,
                coupon: coupon(data),
                shipping: num(data.shipping_incl_tax),
                tax: num(data.total_tax),
                items: checkoutItems(data)
            });

            // send_to needs the AW- form; a bare numeric id would fail silently in Ads.
            if (settings.google_adwords_conversion_enabled && /^AW-\d+$/.test(settings.google_adwords_conversion_id || '') && settings.google_adwords_conversion_label) {
                send('event', 'conversion', {
                    send_to: settings.google_adwords_conversion_id + '/' + settings.google_adwords_conversion_label,
                    transaction_id: data.number,
                    value: num(data.total_incl_tax),
                    currency: currencyOf(data)
                });
            }
        });

    })();
}
