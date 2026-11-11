// File: sw.js
// Taskitator Service Worker
const CACHE_NAME = 'taskitator-phase2-v18';

self.addEventListener('message', event => {
    if (event.data?.type === 'TASKITATOR_SECURITY_VERSION') {
        event.ports[0]?.postMessage({ version: CACHE_NAME });
    }
});

const STATIC_ASSETS = [
    './uni/universe-widgets.js',
    './uni/universe-shell.js',
    './uni/universe.css',
    './pro/study-plan.js',
    './pro/study-schedule.js',
    './pro/smart-study.js',
    './pro/early-bonus.js',
    './pro/status-count.js',
    './pro/study-manage.js',
    './pro/criteria-edit.js',
    './date-filter.js',
    './sleep.html',
    './study-plans.html',
    './study-plans.js',
    './uni/universe-archive.js',
    './uni/universe-release-ui.js',
    './uni/universe-ui.js',
    './uni/universe-tasks-ui.js',
    './uni/focus-timer.js',
    './',
    './index.html',
    './components.html',
    './task-drafts.js',
    './settings.html',
    './help.html',
    './login.html',
    './style.css',
    './tutorial-spotlight.css',
    './tutorial-spotlight.js',
    './tutorial-integration.js',
    './macro-bridge.js',
    './core.js',
    './pro.js',
    './components.js',
    './app.js',
    './manifest.json',
    './SYSTEM_PROMPT.md',
    './CRITERIA_TEMPLATES.json',
    './icon/icon-192.png',
    './icon/icon-512.png',
    './theme-boot.js',
    './i18n.js',
    './locales/ar.js',
    './locales/clerk-ar.js',
    './rtl.css',
    './registry.js',
    './icons.js',
    './nature.js',
    './appearance-ui.js',
    './palettes.css',
    './family-nature.css',
    './image/nature_sprites/sprite.svg',
    './image/nature_sprites/favicon.svg'
];

// Install: Resilient pre-caching (individual fetches prevent a single 404 from breaking installation)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cachePromises = STATIC_ASSETS.map(async (url) => {
                try {
                    const response = await fetch(url, { cache: 'reload' });
                    if (response && response.status === 200) {
                        await cache.put(url, response);
                    } else {
                        console.warn(`[SW] Skipped caching ${url}: HTTP ${response ? response.status : 'No Response'}`);
                    }
                } catch (err) {
                    console.warn(`[SW] Failed to fetch ${url} during pre-cache:`, err.message);
                }
            });

            await Promise.allSettled(cachePromises);
        }).then(() => self.skipWaiting())
    );
});

// Activate: Purge older cache versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: Network-first for HTML navigation, cache-first with query normalization for static assets
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    if (/\/(?:auth|sync|ai|universe)(?:\/|$)/.test(url.pathname) || url.pathname === '/status' || request.headers.has('Authorization')) return;
    const cacheKey = new Request(url.origin + url.pathname);

    // Only intercept standard GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Bypass caching for cross-origin API calls (Gemini API, external CDNs & Cloudflare Worker)
    if (url.origin !== self.location.origin) {
        return;
    }

    // UI code: serve the cached copy at once and refresh it in the background
    // (stale-while-revalidate). A release bumps CACHE_NAME, which installs a fresh
    // worker that re-downloads every file; core.js reloads the page onto it.
    if (/\.(?:js|css)$/.test(url.pathname)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(cacheKey);
            const refresh = fetch(request, { cache: 'no-cache' }).then(response => {
                if (response.ok) return cache.put(cacheKey, response.clone()).then(() => response);
                return response;
            });
            if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
            try { return await refresh; }
            catch { return new Response('App file unavailable. Reconnect and reload.', {status:503}); }
        })());
        return;
    }

    // The copilot prompt must refresh before use; keep a cached copy for offline use.
    if (url.pathname.endsWith('/SYSTEM_PROMPT.md')) {
        event.respondWith((async () => {
            try {
                const response = await fetch(request, { cache: 'no-cache' });
                if (response.ok) {
                    const copy = response.clone();
                    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy)));
                    return response;
                }
                return (await caches.match(cacheKey)) || response;
            } catch (_) {
                return (await caches.match(cacheKey)) || new Response('Prompt unavailable.', { status: 503 });
            }
        })());
        return;
    }

    // Page shells: same stale-while-revalidate as UI code, so switching pages does
    // not wait on the network. Uncached pages (or non-200 answers) go to the network.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(cacheKey);
            const refresh = fetch(request).then(response => {
                if (response && response.status === 200 && !response.redirected) return cache.put(cacheKey, response.clone()).then(() => response);
                return response;
            });
            if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
            try { return await refresh; } catch { return (await caches.match(cacheKey)) || Response.error(); }
        })());
        return;
    }

    // Cache-first falling back to network with ignoreSearch: true
    event.respondWith(
        caches.match(cacheKey).then((cachedResponse) => {
            if (cachedResponse) {
                // Background refresh for stale assets
                fetch(request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, networkResponse));
                    }
                }).catch(() => {});
                return cachedResponse;
            }

            return fetch(request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, responseToCache));
                return networkResponse;
            });
        })
    );
});
