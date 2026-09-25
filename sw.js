// sw.js - Taskitator Service Worker
const CACHE_NAME = 'taskitator-v37';

const STATIC_ASSETS = [
    './',
    './index.html',
    './general.html',
    './calendar.html',
    './projects.html',
    './stats.html',
    './settings.html',
    './trash.html',
    './blocker-guide.html',
    './login.html',
    './style.css',
    './manifest.json',
    './SYSTEM_PROMPT.md',
    './CRITERIA_TEMPLATES.json',
    './app.js',
    './exemplar-store.js',
    './agent-engine.js',
    './audit-engine.js',
    './sync-engine.js',
    './icon/icon-192.png',
    './icon/icon-512.png'
];

// Install: Resilient pre-caching (individual fetches prevent a single 404 from breaking installation)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cachePromises = STATIC_ASSETS.map(async (url) => {
                try {
                    const response = await fetch(url);
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

    // Only intercept standard GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Bypass caching for cross-origin API calls (Gemini API, external CDNs & Cloudflare Worker)
    if (url.origin !== self.location.origin) {
        return;
    }

    // Network-first for top-level HTML navigation requests to prevent stale shells
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).then((response) => {
                if (response && response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
                }
                return response;
            }).catch(() => caches.match(request, { ignoreSearch: true }))
        );
        return;
    }

    // Cache-first falling back to network with ignoreSearch: true
    event.respondWith(
        caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
            if (cachedResponse) {
                // Background refresh for stale assets
                fetch(request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
                    }
                }).catch(() => {});
                return cachedResponse;
            }

            return fetch(request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, responseToCache));
                return networkResponse;
            });
        })
    );
});
