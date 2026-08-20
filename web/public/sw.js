/**
 * Service worker for Nexus.
 *
 * Scope is deliberately narrow. It does two jobs:
 *  1. Serve the app shell offline so opening the app without a connection
 *     still gets you your interface (the data itself lives on your server).
 *  2. Own alarm notifications, so a notification raised by the alarm engine
 *     survives the tab being backgrounded, and tapping it focuses the app.
 *
 * API responses are never cached: showing a stale task list would be worse
 * than showing an honest "no connection".
 */

const VERSION = 'nexus-v2';

// Paths are derived from the worker's own scope so the same file works both at
// the site root and under a project sub-path like /reminder/ on GitHub Pages.
const BASE = new URL('./', self.location).pathname;
const INDEX = `${BASE}index.html`;
const SHELL = [BASE, INDEX, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`, `${BASE}icon-192.png`, `${BASE}icon-512.png`];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve a cached API response — stale tasks are worse than no tasks.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: try the network, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(INDEX).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Static assets: cache first, then fill the cache in the background.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request)
          .then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => caches.match(INDEX).then((fallback) => fallback ?? Response.error())),
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const itemId = event.notification.data?.itemId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'alarm-notification-click', itemId });
          return client.focus();
        }
      }
      return self.clients.openWindow(BASE);
    }),
  );
});
