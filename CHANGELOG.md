# Changelog

## Unreleased

- Google Ads conversions now send the order total as the value (was the tax) and the `AW-` tag is configured in the snippet, so `send_to` can attribute (#2).
- The snippet and tracker are gated on a non-empty Measurement ID; a store that only ticks "Enable" no longer loads `gtag/js?id=` (#3). Tracker calls are guarded so a page without the snippet never throws.
- `debug_mode` and `user_id` are passed in one config object; debug mode works for logged-in shoppers (#4).
- All money fields are numbers, unit `price`/`discount` are derived from line totals, one item shape across the funnel (`item_id` = product id, `sku`, `item_variant`), and page fields are no longer stuffed into `items[]` (#5).
- New events: `view_item_list`, `remove_from_cart`, `add_shipping_info`. New "Skip Test Orders" setting (#6). Consent Mode defaults and `add_payment_info` are not included: the platform has no payment-step event, and consent defaults need a CMP to be useful.
- Settings labels, help text and README say Google Ads and Next Commerce (#7).
- Added a Node test harness (`npm test`) and a CI workflow.
