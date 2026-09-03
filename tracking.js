// Google Analytics 4 storefront event tracker.
//
// The platform runs this file inside an iframe that is a direct child of the storefront page.
// gtag is installed on that parent window by snippets/global-header.html. Every access to the
// parent goes through storefront() and send(), both wrapped in try/catch: when the storefront is
// itself embedded (theme preview, a landing page framing the store) the parent chain can be
// cross-origin and any property read throws. The snippet applies the same enable gate
// (.strip in the template), so both halves agree on when the app is on.
if (app.settings.google_analytics_enabled && String(app.settings.google_analytics_measurement_id || '').trim()) {
    (function () {

        var settings = app.settings;
        var measurementId = String(settings.google_analytics_measurement_id).trim();

        // Google Ads settings are normalised and validated here only; the snippet does not touch
        // them (a Django template cannot mirror this regex). A bare numeric id gets the AW- prefix
        // so an older paste keeps working; labels are the alphanumeric/_/- tokens Ads issues.
        var adsId = (function () {
            var raw = String(settings.google_adwords_conversion_id || '').trim().toUpperCase().replace(/^AW-/, '');
            return /^\d+$/.test(raw) ? 'AW-' + raw : '';
        })();
        var adsLabel = (function () {
            var raw = String(settings.google_adwords_conversion_label || '').trim();
            return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : '';
        })();
        var adsEnabled = Boolean(settings.google_adwords_conversion_enabled && adsId && adsLabel);

        var storefront = function () {
            try {
                var parent = window.parent;
                // Touch a property so a cross-origin parent fails here, inside the try.
                void parent.document;
                return parent;
            } catch (e) {
                return null;
            }
        };

        var send = function () {
            try {
                var win = storefront();
                if (win && typeof win.gtag === 'function') {
                    win.gtag.apply(win, arguments);
                }
            } catch (e) {
                // A page without the snippet, or a cross-origin parent, must never break the tracker.
            }
        };

        // Every GA4 event targets the configured property so a second Google tag on the page
        // (theme, another app) does not also receive it.
        var sendGa = function (name, params) {
            params.send_to = measurementId;
            send('event', name, params);
        };

        // Ads conversion tracking needs the AW- destination configured before send_to can attribute.
        // gtag queues calls until gtag.js loads, and this runs before any storefront event fires.
        if (adsEnabled) {
            send('config', adsId);
        }

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
            return vouchers && vouchers.length ? vouchers[0].name : undefined;
        };

        // GA4 rejects an event with more than 200 items outright, so longer lists are truncated
        // to the first 200: a partial list still reaches the report, a dropped event does not.
        var MAX_ITEMS = 200;

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

        var checkoutLines = function (data) {
            return ((data && data.lines) || []).filter(function (line) {
                return line && line.product_id != null;
            }).slice(0, MAX_ITEMS);
        };

        // GA4 defines value on checkout events as item revenue (sum of price x quantity);
        // shipping and tax travel in their own parameters. total_incl_tax is the order grand
        // total, so value is rebuilt from the lines.
        var checkoutEcommerce = function (data) {
            var lines = checkoutLines(data);
            var value;
            lines.forEach(function (line) {
                var total = num(line.price_incl_tax);
                if (total !== undefined) { value = (value || 0) + total; }
            });
            return {
                currency: data.currency,
                value: round(value),
                coupon: coupon(data),
                items: lines.map(cartLineItem)
            };
        };

        var pageContext = function () {
            try {
                var win = storefront();
                return win ? { path: win.location.pathname, title: win.document.title } : {};
            } catch (e) {
                return {};
            }
        };

        // The category payload carries the products only (no category object), so the list is
        // identified by the page: path as the stable id, title as the display name.
        analytics.subscribe('product_category_viewed', function (event) {
            var products = (Array.isArray(event.data) ? event.data : []).filter(function (product) {
                return product && product.id != null;
            });
            if (!products.length) { return; }
            // Currency comes from the first priced product in the whole list, before truncation.
            var priced = products.filter(function (product) {
                return product.purchase_info && product.purchase_info.price;
            })[0];
            products = products.slice(0, MAX_ITEMS);
            var page = pageContext();
            sendGa('view_item_list', {
                item_list_id: page.path,
                item_list_name: page.title,
                currency: priced && priced.purchase_info.price.currency,
                items: products.map(productItem)
            });
        });

        analytics.subscribe('product_viewed', function (event) {
            var product = event.data;
            if (!product || product.id == null) { return; }
            var price = product.purchase_info && product.purchase_info.price;
            sendGa('view_item', {
                currency: price && price.currency,
                value: num(price && price.price),
                items: [productItem(product, 0)]
            });
        });

        var cartLineEvent = function (name) {
            return function (event) {
                var line = event.data;
                if (!line || line.product_id == null) { return; }
                sendGa(name, {
                    currency: line.currency,
                    value: num(line.price_incl_tax),
                    items: [cartLineItem(line, 0)]
                });
            };
        };

        analytics.subscribe('product_added_to_cart', cartLineEvent('add_to_cart'));
        analytics.subscribe('product_removed_from_cart', cartLineEvent('remove_from_cart'));

        analytics.subscribe('checkout_started', function (event) {
            if (!event.data) { return; }
            sendGa('begin_checkout', checkoutEcommerce(event.data));
        });

        analytics.subscribe('checkout_shipping_method_submitted', function (event) {
            if (!event.data) { return; }
            var params = checkoutEcommerce(event.data);
            params.shipping_tier = event.data.shipping_method || undefined;
            sendGa('add_shipping_info', params);
        });

        analytics.subscribe('checkout_completed', function (event) {
            var data = event.data;
            if (!data) { return; }
            if (data.is_test && settings.google_analytics_skip_test_orders) { return; }

            var params = checkoutEcommerce(data);
            params.transaction_id = data.number;
            params.shipping = num(data.shipping_incl_tax);
            params.tax = num(data.total_tax);
            sendGa('purchase', params);

            // The Ads conversion value is the order total the merchant was paid, by design.
            if (adsEnabled) {
                send('event', 'conversion', {
                    send_to: adsId + '/' + adsLabel,
                    transaction_id: data.number,
                    value: num(data.total_incl_tax),
                    currency: data.currency
                });
            }
        });

    })();
}
