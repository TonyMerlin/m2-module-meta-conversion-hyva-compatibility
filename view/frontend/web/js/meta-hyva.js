/* global fbq, hyva */
(function () {
    'use strict';

    if (window.merlinMetaHyva) {
        return;
    }

    const nonCachedCapiEvents = new Set([
        'facebook_businessextension_ssapi_add_to_cart',
        'facebook_businessextension_ssapi_initiate_checkout',
        'facebook_businessextension_ssapi_add_payment_info',
        'facebook_businessextension_ssapi_purchase',
        'facebook_businessextension_ssapi_customer_registration_success',
        'facebook_businessextension_ssapi_add_to_wishlist'
    ]);

    const state = {
        sectionData: null,
        selectedSimpleByParent: Object.create(null),
        productPriceByParent: Object.create(null),
        pendingAddToCartKey: 'merlin_meta_pending_add_to_cart',
        addToCartConfig: null,
        paymentConfig: null,
        paymentRequestSeen: new Set(),
        addToCartInFlight: false
    };

    function generateUUID() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        const buffer = new Uint8Array(16);
        window.crypto.getRandomValues(buffer);
        buffer[6] = (buffer[6] & 0x0f) | 0x40;
        buffer[8] = (buffer[8] & 0x3f) | 0x80;

        return Array.from(buffer).map((byte, index) => {
            const value = byte.toString(16).padStart(2, '0');
            return [4, 6, 8, 10].includes(index) ? '-' + value : value;
        }).join('');
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function appendFormValue(params, key, value) {
        if (value === undefined || value === null) {
            params.append(key, '');
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                if (typeof item === 'object' && item !== null) {
                    Object.keys(item).forEach(childKey => {
                        appendFormValue(params, key + '[' + index + '][' + childKey + ']', item[childKey]);
                    });
                } else {
                    appendFormValue(params, key + '[]', item);
                }
            });
            return;
        }

        if (typeof value === 'object') {
            Object.keys(value).forEach(childKey => {
                appendFormValue(params, key + '[' + childKey + ']', value[childKey]);
            });
            return;
        }

        params.append(key, String(value));
    }

    function objectToSearchParams(data) {
        const params = new URLSearchParams();
        Object.keys(data || {}).forEach(key => appendFormValue(params, key, data[key]));
        return params;
    }

    function getCookie(name) {
        const prefix = encodeURIComponent(name) + '=';
        const parts = document.cookie ? document.cookie.split('; ') : [];
        for (const part of parts) {
            if (part.indexOf(prefix) === 0) {
                return decodeURIComponent(part.substring(prefix.length));
            }
        }
        return null;
    }

    function deleteCookie(name) {
        if (window.hyva && typeof window.hyva.setCookie === 'function') {
            window.hyva.setCookie(name, '', -1, true);
            return;
        }
        document.cookie = encodeURIComponent(name) + '=; Max-Age=0; path=/; SameSite=Lax';
    }

    function parseJson(value) {
        if (!value) {
            return null;
        }
        try {
            return JSON.parse(value);
        } catch (error) {
            console.error('[Merlin Meta Hyva] Unable to parse Meta cookie payload.', error);
            return null;
        }
    }

    function eventIdFromSections(eventName) {
        const section = state.sectionData && state.sectionData['capi-event-ids'];
        const ids = section && section.eventIds;
        return ids && ids[eventName] ? ids[eventName] : null;
    }

    function requestSectionReload(force) {
        if (force && window.hyva && typeof window.hyva.setCookie === 'function') {
            window.hyva.setCookie('mage-cache-sessid', '', -1, true);
        }
        window.dispatchEvent(new CustomEvent('reload-customer-section-data'));
    }

    function waitForSectionEventId(eventName, options) {
        const settings = Object.assign({forceReload: false, timeout: 5000, allowFallback: true}, options || {});
        const existing = eventIdFromSections(eventName);
        if (existing && !settings.forceReload) {
            return Promise.resolve(existing);
        }

        return new Promise(resolve => {
            let done = false;
            let timer = null;

            const finish = value => {
                if (done) {
                    return;
                }
                done = true;
                window.removeEventListener('private-content-loaded', onPrivateContent);
                if (timer) {
                    window.clearTimeout(timer);
                }
                resolve(value);
            };

            const onPrivateContent = event => {
                state.sectionData = event.detail && event.detail.data ? event.detail.data : {};
                const id = eventIdFromSections(eventName);
                if (id) {
                    finish(id);
                }
            };

            window.addEventListener('private-content-loaded', onPrivateContent);
            requestSectionReload(settings.forceReload);

            timer = window.setTimeout(() => {
                finish(settings.allowFallback ? generateUUID() : null);
            }, settings.timeout);
        });
    }

    function waitForPixel() {
        if (window.metaPixelInitFlag && typeof window.fbq === 'function') {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            window.addEventListener('metaPixelInitialized', resolve, {once: true});
        });
    }

    async function postServerEvent(url, payload) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: objectToSearchParams(payload).toString()
            });

            if (!response.ok) {
                console.error('[Merlin Meta Hyva] Meta tracker endpoint returned HTTP ' + response.status + '.');
            }
        } catch (error) {
            console.error('[Merlin Meta Hyva] Meta tracker request failed.', error);
        }
    }

    async function track(config) {
        if (!config || !config.payload || !config.browserEventData) {
            return;
        }

        const eventConfig = clone(config);
        const eventName = eventConfig.payload.eventName;

        if (!eventConfig.payload.eventId) {
            if (nonCachedCapiEvents.has(eventName)) {
                eventConfig.payload.eventId = await waitForSectionEventId(eventName, {
                    forceReload: true,
                    timeout: 5000,
                    allowFallback: true
                });
            } else {
                eventConfig.payload.eventId = generateUUID();
            }
        }

        eventConfig.browserEventData.payload = eventConfig.browserEventData.payload || {};
        eventConfig.browserEventData.payload.source = eventConfig.browserEventData.source;
        eventConfig.browserEventData.payload.pluginVersion = eventConfig.browserEventData.pluginVersion;

        await waitForPixel();

        const browser = eventConfig.browserEventData;
        window.fbq('set', 'agent', browser.fbAgentVersion, browser.fbPixelId);
        window.fbq(browser.track, browser.event, browser.payload, {
            eventID: eventConfig.payload.eventId
        });

        if (!nonCachedCapiEvents.has(eventName)) {
            await postServerEvent(eventConfig.url, eventConfig.payload);
        }
    }

    async function initPixel(config) {
        const pixelId = config.pixelId;
        const agent = config.agent;
        window.metaPixelInitFlag = false;

        if (!window.fbq) {
            (function (f, b, e, v, n, t, s) {
                if (f.fbq) {
                    return;
                }
                n = f.fbq = function () {
                    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
                };
                if (!f._fbq) {
                    f._fbq = n;
                }
                n.push = n;
                n.loaded = true;
                n.version = '2.0';
                n.queue = [];
                t = b.createElement(e);
                t.async = true;
                t.src = v;
                s = b.getElementsByTagName(e)[0];
                s.parentNode.insertBefore(t, s);
            })(window, document, 'script', '//connect.facebook.net/en_US/fbevents.js');
        }

        window.fbq('init', pixelId, {}, {agent: agent});

        if (config.automaticMatchingFlag) {
            try {
                const response = await fetch(config.userDataUrl, {
                    credentials: 'same-origin',
                    headers: {'X-Requested-With': 'XMLHttpRequest'}
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.success && result.user_data) {
                        window.fbq('init', pixelId, result.user_data, {agent: agent});
                    }
                }
            } catch (error) {
                console.error('[Merlin Meta Hyva] Automatic matching request failed.', error);
            }
        }

        window.metaPixelInitFlag = true;
        window.dispatchEvent(new Event('metaPixelInitialized'));
    }

    function getFormProductData(form) {
        if (!form) {
            return null;
        }

        const data = new FormData(form);
        const parentProductId = data.get('product') || form.dataset.productId || null;
        const rawHiddenSimpleId = data.get('selected_configurable_option');
        const hiddenSimpleId = rawHiddenSimpleId && String(rawHiddenSimpleId) !== '0' ? rawHiddenSimpleId : null;
        const selectedSimpleId = parentProductId && state.selectedSimpleByParent[parentProductId]
            ? state.selectedSimpleByParent[parentProductId]
            : null;
        const productId = hiddenSimpleId || selectedSimpleId || parentProductId;
        const sku = data.get('product_sku') || form.dataset.productSku || form.getAttribute('data-product-sku') || '';
        const qty = parseFloat(data.get('qty') || '1') || 1;

        if (!productId && !sku) {
            return null;
        }

        return {
            productId: productId ? String(productId) : '',
            parentProductId: parentProductId ? String(parentProductId) : '',
            sku: String(sku || ''),
            qty: qty,
            createdAt: Date.now(),
            previousEventId: eventIdFromSections('facebook_businessextension_ssapi_add_to_cart')
        };
    }

    function savePendingAddToCart(data) {
        if (!data) {
            return;
        }
        try {
            sessionStorage.setItem(state.pendingAddToCartKey, JSON.stringify(data));
        } catch (error) {
            // Session storage can be unavailable in restricted browser modes.
        }
    }

    function readPendingAddToCart() {
        try {
            return parseJson(sessionStorage.getItem(state.pendingAddToCartKey));
        } catch (error) {
            return null;
        }
    }

    function clearPendingAddToCart() {
        try {
            sessionStorage.removeItem(state.pendingAddToCartKey);
        } catch (error) {
            // Ignore.
        }
    }

    function isCartAddUrl(url) {
        try {
            const resolved = new URL(url, window.location.href);
            return /\/checkout\/cart\/add\/?$/i.test(resolved.pathname);
        } catch (error) {
            return String(url || '').indexOf('/checkout/cart/add') !== -1;
        }
    }

    async function sendAddToCart(productData) {
        if (!state.addToCartConfig || !productData || state.addToCartInFlight) {
            return;
        }

        state.addToCartInFlight = true;
        const params = new URLSearchParams();
        if (productData.sku) {
            params.set('product_sku', productData.sku);
        }
        if (productData.productId) {
            params.set('product_id', productData.productId);
        }
        params.set('form_key', window.hyva && typeof window.hyva.getFormKey === 'function'
            ? window.hyva.getFormKey()
            : (document.querySelector('input[name="form_key"]') || {}).value || '');

        try {
            const response = await fetch(state.addToCartConfig.productInfoUrl + '?' + params.toString(), {
                method: 'GET',
                credentials: 'same-origin',
                headers: {'X-Requested-With': 'XMLHttpRequest'}
            });

            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }

            const product = await response.json();
            if (!product || !product.productId || !product.id) {
                return;
            }

            const config = clone(state.addToCartConfig.trackerConfig);
            config.payload.productId = product.productId;
            config.browserEventData.payload = {
                content_name: product.name,
                content_ids: [product.id],
                value: product.value,
                currency: product.currency,
                content_type: product.content_type,
                contents: [{id: product.id, quantity: 1}]
            };

            await track(config);
            clearPendingAddToCart();
        } catch (error) {
            console.error('[Merlin Meta Hyva] Unable to build Meta AddToCart event.', error);
        } finally {
            state.addToCartInFlight = false;
        }
    }

    function onSuccessfulCartAdd(productData) {
        if (!productData) {
            productData = readPendingAddToCart();
        }
        if (!productData) {
            return;
        }

        requestSectionReload(true);
        sendAddToCart(productData);
    }

    function installAddToCartObservers() {
        document.addEventListener('submit', event => {
            const form = event.target;
            if (!(form instanceof HTMLFormElement) || !isCartAddUrl(form.action)) {
                return;
            }
            savePendingAddToCart(getFormProductData(form));
        }, true);

        const nativeFetch = window.fetch;
        if (typeof nativeFetch === 'function' && !nativeFetch.__merlinMetaWrapped) {
            const wrappedFetch = async function () {
                const input = arguments[0];
                const init = arguments[1] || {};
                const url = typeof input === 'string' ? input : input && input.url;
                const isAdd = isCartAddUrl(url);
                let productData = null;

                if (isAdd) {
                    productData = readPendingAddToCart();
                    if (!productData && init.body instanceof FormData) {
                        const virtualForm = document.createElement('form');
                        const parent = init.body.get('product');
                        productData = {
                            productId: String(
                                (init.body.get('selected_configurable_option') &&
                                    String(init.body.get('selected_configurable_option')) !== '0'
                                    ? init.body.get('selected_configurable_option')
                                    : null) ||
                                (parent && state.selectedSimpleByParent[parent]) || parent || ''
                            ),
                            parentProductId: String(parent || ''),
                            sku: String(init.body.get('product_sku') || ''),
                            qty: parseFloat(init.body.get('qty') || '1') || 1,
                            createdAt: Date.now(),
                            previousEventId: eventIdFromSections('facebook_businessextension_ssapi_add_to_cart')
                        };
                    }
                }

                const response = await nativeFetch.apply(this, arguments);
                if (isAdd && response.ok && !response.redirected) {
                    onSuccessfulCartAdd(productData);
                } else if (isAdd && response.ok) {
                    // Some Hyva add-to-cart responses contain a backUrl/redirect while still representing success.
                    onSuccessfulCartAdd(productData);
                }
                return response;
            };
            wrappedFetch.__merlinMetaWrapped = true;
            window.fetch = wrappedFetch;
        }

        window.addEventListener('configurable-selection-changed', captureConfigurableSelection);
        window.addEventListener('listing-configurable-selection-changed', captureConfigurableSelection);

        window.addEventListener('private-content-loaded', () => {
            const pending = readPendingAddToCart();
            const currentEventId = eventIdFromSections('facebook_businessextension_ssapi_add_to_cart');
            if (pending && Date.now() - pending.createdAt < 120000 && currentEventId &&
                (!pending.previousEventId || currentEventId !== pending.previousEventId)) {
                sendAddToCart(pending);
            }
        });
    }

    function captureConfigurableSelection(event) {
        const detail = event.detail || {};
        const parentId = detail.productId ? String(detail.productId) : '';
        if (!parentId) {
            return;
        }

        const candidates = Array.isArray(detail.candidates) ? detail.candidates : [];
        if (candidates.length === 1) {
            state.selectedSimpleByParent[parentId] = String(candidates[0]);
        } else {
            delete state.selectedSimpleByParent[parentId];
        }
    }

    function findProductForm(productId) {
        return document.querySelector('form[action*="/checkout/cart/add"][data-product-id="' + CSS.escape(String(productId)) + '"]') ||
            document.querySelector('form[action*="/checkout/cart/add"] input[name="product"][value="' + CSS.escape(String(productId)) + '"]')?.form ||
            document.querySelector('#product_addtocart_form');
    }

    function extractProductName(form) {
        const scope = form && form.closest('.product-item, .product-info-main, main') || document;
        const element = scope.querySelector('.product-item-link, .page-title .base, h1.page-title span.base, h1.page-title');
        return element ? element.textContent.trim() : '';
    }

    function extractProductSku(form) {
        if (form && form.dataset.productSku) {
            return form.dataset.productSku;
        }
        const scope = form && form.closest('.product-item, .product-info-main, main') || document;
        const element = scope.querySelector('.product.attribute.sku .value, [itemprop="sku"]');
        return element ? element.textContent.trim() : '';
    }

    function parseDisplayedPrice(form, productId) {
        if (state.productPriceByParent[productId] !== undefined) {
            return state.productPriceByParent[productId];
        }
        const scope = form && form.closest('.product-item, .product-info-main, main') || document;
        const amount = scope.querySelector('[data-price-type="finalPrice"] [data-price-amount], [data-price-amount]');
        if (amount && amount.dataset.priceAmount) {
            return Number(amount.dataset.priceAmount).toFixed(2);
        }
        return '';
    }

    function registerCustomizeProduct(config) {
        const send = event => {
            const detail = event.detail || {};
            const productId = detail.productId ? String(detail.productId) : '';
            if (!productId) {
                return;
            }
            const form = findProductForm(productId);
            const productName = extractProductName(form);
            const sku = extractProductSku(form);
            const value = parseDisplayedPrice(form, productId);
            const eventConfig = clone(config);

            eventConfig.browserEventData.payload.content_name = productName;
            eventConfig.browserEventData.payload.content_ids = [sku];
            eventConfig.browserEventData.payload.content_type = 'product_group';
            eventConfig.browserEventData.payload.value = value;

            eventConfig.payload.content_name = productName;
            eventConfig.payload.content_ids = [sku];
            eventConfig.payload.content_type = 'product_group';
            eventConfig.payload.value = value;

            track(eventConfig);
        };

        window.addEventListener('configurable-selection-changed', send);
        window.addEventListener('listing-configurable-selection-changed', send);
    }

    function registerPriceObserver(productId) {
        if (!productId) {
            return;
        }
        window.addEventListener('update-prices-' + productId, event => {
            const detail = event.detail || {};
            const price = detail.finalPrice || detail.basePrice || detail.basePriceAmount;
            if (price && typeof price.amount !== 'undefined') {
                state.productPriceByParent[String(productId)] = Number(price.amount).toFixed(2);
            }
        });
    }

    function registerCookieEvent(config, cookieName, mode) {
        const raw = getCookie(cookieName);
        if (raw === null) {
            return;
        }

        const payload = parseJson(raw);
        const eventConfig = clone(config);

        if (mode === 'wishlist' && payload) {
            const currency = eventConfig.browserEventData.payload.currency;
            eventConfig.browserEventData.payload = Object.assign({}, payload, {currency: currency});
            eventConfig.payload = Object.assign({}, eventConfig.payload, payload, {currency: currency});
        } else if (mode === 'registration' && payload) {
            const eventName = eventConfig.payload.eventName;
            const currency = eventConfig.browserEventData.payload.currency;
            eventConfig.browserEventData.payload = Object.assign({}, payload, {currency: currency});
            eventConfig.payload = Object.assign({}, eventConfig.payload, eventConfig.browserEventData.payload, {
                eventName: eventName,
                currency: currency
            });
        }

        track(eventConfig);
        deleteCookie(cookieName);
    }

    function isPaymentInformationUrl(url) {
        const value = String(url || '');
        return /\/(payment-information|set-payment-information)(?:\?|$)/i.test(value);
    }

    function paymentPayloadFromSections() {
        const cart = state.sectionData && state.sectionData.cart;
        return cart && cart.meta_payload ? clone(cart.meta_payload) : null;
    }

    async function sendPaymentInfo() {
        if (!state.paymentConfig) {
            return;
        }

        if (!paymentPayloadFromSections()) {
            requestSectionReload(true);
            await new Promise(resolve => {
                const timer = window.setTimeout(() => {
                    window.removeEventListener('private-content-loaded', onData);
                    resolve();
                }, 3000);
                const onData = () => {
                    window.clearTimeout(timer);
                    window.removeEventListener('private-content-loaded', onData);
                    resolve();
                };
                window.addEventListener('private-content-loaded', onData);
            });
        }

        const payload = paymentPayloadFromSections();
        if (!payload) {
            return;
        }

        const config = clone(state.paymentConfig);
        const currency = config.browserEventData.payload.currency;
        const eventName = config.payload.eventName;

        config.payload = Object.assign({}, payload, {
            content_type: 'product',
            currency: currency,
            eventName: eventName
        });
        config.browserEventData.payload = Object.assign({}, payload, {
            content_type: 'product',
            currency: currency
        });

        await track(config);
    }

    function installPaymentObservers() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch === 'function' && !nativeFetch.__merlinMetaPaymentWrapped) {
            const wrappedFetch = async function () {
                const input = arguments[0];
                const url = typeof input === 'string' ? input : input && input.url;
                const paymentRequest = isPaymentInformationUrl(url);
                const response = await nativeFetch.apply(this, arguments);
                if (paymentRequest && response.ok) {
                    sendPaymentInfo();
                }
                return response;
            };
            wrappedFetch.__merlinMetaPaymentWrapped = true;
            window.fetch = wrappedFetch;
        }

        if (window.XMLHttpRequest && !window.XMLHttpRequest.prototype.__merlinMetaPaymentWrapped) {
            const nativeOpen = window.XMLHttpRequest.prototype.open;
            const nativeSend = window.XMLHttpRequest.prototype.send;

            window.XMLHttpRequest.prototype.open = function (method, url) {
                this.__merlinMetaUrl = url;
                this.__merlinMetaMethod = method;
                return nativeOpen.apply(this, arguments);
            };

            window.XMLHttpRequest.prototype.send = function () {
                if (isPaymentInformationUrl(this.__merlinMetaUrl)) {
                    this.addEventListener('load', () => {
                        if (this.status >= 200 && this.status < 300) {
                            sendPaymentInfo();
                        }
                    }, {once: true});
                }
                return nativeSend.apply(this, arguments);
            };

            window.XMLHttpRequest.prototype.__merlinMetaPaymentWrapped = true;
        }
    }

    window.addEventListener('private-content-loaded', event => {
        state.sectionData = event.detail && event.detail.data ? event.detail.data : {};
    });

    installAddToCartObservers();

    window.merlinMetaHyva = {
        initPixel: initPixel,
        track: track,
        registerCustomizeProduct: registerCustomizeProduct,
        registerPriceObserver: registerPriceObserver,
        registerCookieEvent: registerCookieEvent,
        configureAddToCart: function (config) {
            state.addToCartConfig = clone(config);
            const pending = readPendingAddToCart();
            const currentEventId = eventIdFromSections('facebook_businessextension_ssapi_add_to_cart');
            if (pending && Date.now() - pending.createdAt < 120000 && currentEventId &&
                (!pending.previousEventId || currentEventId !== pending.previousEventId)) {
                sendAddToCart(pending);
            }
        },
        configurePaymentInfo: function (config) {
            state.paymentConfig = clone(config);
            installPaymentObservers();
        },
        getCookie: getCookie,
        deleteCookie: deleteCookie,
        generateUUID: generateUUID
    };
}());
