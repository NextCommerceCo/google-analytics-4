# Google Analytics 4

Google Analytics 4 app for Next Commerce. Installs the Google tag on any storefront theme and sends GA4 ecommerce events through [Storefront Event Tracking](https://developers.nextcommerce.com/docs/storefront/event-tracking). Optionally sends a Google Ads conversion on completed orders.

## Settings

| Setting | Notes |
|---|---|
| Enable Google Analytics | Nothing loads until a Measurement ID is also set. |
| Google Analytics Measurement ID | `G-XXXXXXXXXX`. |
| Enable Google Ads Conversion Tracking | Configures the `AW-` tag and sends a `conversion` event on `checkout_completed`. |
| Google Ads Conversion ID | Including the `AW-` prefix, e.g. `AW-123456789`. |
| Google Ads Conversion Label | From the Ads conversion action. |
| Enable Debug Mode | Sends `debug_mode` so events show in GA4 DebugView. |
| Skip Test Orders | Suppresses `purchase` and `conversion` for orders flagged `is_test`. |

## Events

| Storefront event | GA4 event |
|---|---|
| `product_category_viewed` | `view_item_list` |
| `product_viewed` | `view_item` |
| `product_added_to_cart` | `add_to_cart` |
| `product_removed_from_cart` | `remove_from_cart` |
| `checkout_started` | `begin_checkout` |
| `checkout_shipping_method_submitted` | `add_shipping_info` |
| `checkout_completed` | `purchase` (+ Ads `conversion` when enabled) |

`page_view` is sent by the Google tag itself on `config`.

Items use one shape across the funnel so GA4 item reports join: `item_id` is the product id, `sku` and `item_variant` identify the child product, `price` and `discount` are per unit, and all money fields are numbers.

## Files

- `manifest.json` — settings schema, snippet location, event tracker mapping.
- `snippets/global-header.html` — loads gtag and configures the GA4 (and optional Ads) tag. Rendered only when a Measurement ID is set.
- `tracking.js` — the event tracker. Runs in the platform's sandboxed tracker frame and calls `gtag` on the storefront window; every call is guarded so a page without the snippet never throws.

## Tests

```bash
npm test
```

`tests/tracking.test.js` runs `tracking.js` with the same globals the platform provides (`app`, `analytics`, `window.top`) and asserts the payload of every mapped event. No dependencies; Node 22, the version CI runs.
