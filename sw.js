// sw.js - Taskitator Service Worker
const CACHE_NAME = 'taskitator-v31';

const STATIC_ASSETS = [
    './',
    './index.html',
    './general.html',
    './stats.html',
    './settings.html',
    './trash.html',
    './blocker-guide.html',
    './login.html',
    './style.css',
    './manifest.json',
    './SYSTEM_PROMPT.md',
    './CRITERIA_TEMPLATES.json',
    './agent-engine.js',
    './audit-engine.js',
    './sync-engine.js',
    './icon/icon-192.png',
    './icon/icon-512.png'
];

// Install: Cache all core application assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
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

// Fetch: Stale-while-revalidate for dynamic runtime files, network-first for HTML
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // Bypass caching for cross-origin API calls (Gemini API & Cloudflare Worker)
    if (url.origin !== self.location.origin) {
        return;
    }

    // Network-first for top-level HTML navigation requests to prevent stale shells
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).then((response) => {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
                return response;
            }).catch(() => caches.match(request))
        );
        return;
    }

    // Cache-first falling back to network for all local assets
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                // Background refresh
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
