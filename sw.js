// sw.js
/**
 * Taskitator Service Worker
 * Version: taskitator-v22
 * 
 * Features:
 * - Network-First for core shell assets with offline cache fallback.
 * - Strict bypass for Cloudflare sync APIs and non-GET requests to prevent sync interference.
 * - Automatic stale cache eviction on activation.
 */

const CACHE_NAME = 'taskitator-v22';

const ASSETS_TO_CACHE = [
    './',
    './login.html',
    './index.html',
    './general.html',
    './stats.html',
    './settings.html',
    './blocker-guide.html',
    './style.css',
    './sync-engine.js',
    './audit-engine.js',
    './manifest.json',
    './icon/icon-192.png',
    './icon/icon-512.png'
];

// =========================================================================
// 1. Install Event: Cache Core App Shell
// =========================================================================
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => {
            // Force newly installed service worker to activate immediately
            return self.skipWaiting();
        })
    );
});

// =========================================================================
// 2. Activate Event: Evict Outdated Caches
// =========================================================================
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_NAME) {
                        return caches.delete(name);
                    }
                })
            );
        }).then(() => {
            // Claim clients immediately so updated SW controls existing tabs
            return self.clients.claim();
        })
    );
});

// =========================================================================
// 3. Fetch Event: Network-First with Live Sync Bypass
// =========================================================================
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. NEVER intercept non-GET requests (POST sync push, etc.)
    if (event.request.method !== 'GET') {
        return;
    }

    // 2. NEVER intercept Cloudflare Worker sync or external APIs
    if (url.hostname.includes('workers.dev') || url.hostname.includes('googleapis.com')) {
        return; // Hand over directly to live network
    }

    // 3. Network-First strategy for local app assets
    // Ensures code updates deploy immediately when online, falling back to cache when offline
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // If response is valid, update the cache with fresh version
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Offline fallback: serve from local cache
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // If navigating to an uncached page offline, fallback to login/index
                    if (event.request.mode === 'navigate') {
                        return caches.match('./login.html') || caches.match('./index.html');
                    }
                });
            })
    );
});
