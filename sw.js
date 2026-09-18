// sw.js
/**
 * File: sw.js
 * Service Worker for Taskitator PWA
 * Version: taskitator-v19
 * 
 * - Full offline caching strategy for shell, styles, scripts, and local views.
 * - Removed nonexistent physical PNG icon paths to avoid cache.addAll() install failure.
 * - Auto-purges legacy caches on activation.
 */

const CACHE_NAME = 'taskitator-v19';

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './general.html',
    './stats.html',
    './trash.html',
    './settings.html',
    './style.css',
    './sync-engine.js',
    './audit-engine.js',
    './manifest.json'
];

// 1. Install Event: Pre-cache application shell and engines
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => {
            return self.skipWaiting();
        })
    );
});

// 2. Activate Event: Clear out obsolete caches
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
            return self.clients.claim();
        })
    );
});

// 3. Fetch Event: Cache-first with network fallback
self.addEventListener('fetch', (event) => {
    // Only intercept standard GET requests (bypass worker sync API calls and external AI endpoints)
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Allow Google AI Studio API calls and Worker endpoints to bypass cache directly
    if (url.hostname.includes('googleapis.com') || url.hostname.includes('workers.dev')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
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
            }).catch(() => {
                // Fallback for HTML documents if offline
                if (event.request.headers.get('accept')?.includes('text/html')) {
                    return caches.match('./index.html');
                }
            });
        })
    );
});