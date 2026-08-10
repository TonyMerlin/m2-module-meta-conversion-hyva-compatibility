# m2-module-meta-conversion-hyva-compatibility
Hyva compatibility layer for Meta_Conversion without RequireJS or jQuery


# Merlin_MetaConversionHyvaCompatibility

HyvÃ compatibility layer for `Meta_Conversion`.

The module leaves the Meta vendor package untouched and replaces only the frontend execution layer on HyvÃ layout handles.

## Design

- No RequireJS
- No jQuery
- No Knockout dependency introduced by this module
- No `mage/*`
- Reuses Meta's existing Blocks, configuration, controllers, server-side trackers and CAPI queue
- Reuses `fbe/pixel/tracker`, `fbe/pixel/userData` and `fbe/Pixel/ProductInfoForAddToCart`
- Uses HyvÃ `private-content-loaded` / `reload-customer-section-data`
- Uses HyvÃ configurable selection events
- Uses `hyva.getFormKey()` for the Meta ProductInfo request
- Uses `hyva_` layout handles so Luma/non-HyvÃ¤ themes retain the original Meta templates

## Events covered

- PageView
- ViewContent
- ViewCategory
- Search
- AddToCart
- InitiateCheckout
- Purchase
- CustomizeProduct
- AddPaymentInfo
- AddToWishlist
- CompleteRegistration
- Contact

Install extension into /app/code/Merlin/MetaConversionHyvaCompatibility/
