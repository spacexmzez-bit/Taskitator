// sw.js
const CACHE_NAME = 'taskitator-v15';

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './general.html',
    './stats.html',
    './settings.html',
    './trash.html',
    './style.css',
    './sync-engine.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

// Install: pre-cache all critical shell assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

// Activate: clean up outdated cache versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: Network-first for Cloudflare sync requests, Cache-first for shell assets
self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    // Bypass caching for any cross-origin Cloudflare Worker sync API calls
    if (requestUrl.origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Fetch fresh copy in background to keep cache current (stale-while-revalidate)
                fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, networkResponse);
                        });
                    }
                }).catch(() => {/* Offline fallback handled by cache */});

                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return networkResponse;
            });
        })
    );
});
