self.__NEXUS_ASSETS__ = ["assets/GalaxyScene-BvPJispH.js","assets/index-AyvKo6Se.js","assets/index-BRQMjpGH.js","assets/index-CBr8Yiai.css","assets/index-Disfq97i.js","assets/index-DjhPNO-i.js","assets/index-IV4xvS3u.js","assets/index-K7UUlAQ4.js","assets/index-PtL15U2Y.js","assets/index-cuvntoWW.js","assets/index-tp0l5dvn.js","assets/motion--zA-rPix.js","assets/shell-DAa1yWUe.js","assets/three-DDyQpu33.js","assets/web-BPDm9EAU.js","assets/web-C-KvF3xP.js","assets/web-CJtER934.js","assets/web-D-PViOxt.js","assets/web-DX4WZfmx.js","assets/web-Drmg-j9d.js"];
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

const VERSION = 'nexus-v5';

// Paths are derived from the worker's own scope so the same file works both at
// the site root and under a project sub-path like /reminder/ on GitHub Pages.
const BASE = new URL('./', self.location).pathname;
const INDEX = `${BASE}index.html`;

/**
 * The built asset filenames, written in at build time.
 *
 * They have to be precached, and precaching them is not optional. The page's
 * own scripts are requested before this worker takes control, so they never
 * pass through the fetch handler on a first visit and would not be in the
 * cache when the connection later disappears — leaving an installed app that
 * cannot start. `scripts/inject-sw-assets.mjs` fills this in.
 */
const BUILD_ASSETS = self.__NEXUS_ASSETS__ ?? [];

const SHELL = [
  BASE,
  INDEX,
  `${BASE}manifest.webmanifest`,
  `${BASE}icon.svg`,
  `${BASE}icon-192.png`,
  `${BASE}icon-512.png`,
  ...BUILD_ASSETS.map((file) => `${BASE}${file}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // Individually, so one missing file cannot fail the whole install and
      // leave the app with no offline shell at all.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
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

  /**
   * Cached lookups ignore Vary, deliberately.
   *
   * The API sends `Vary: Origin` on everything, including the built assets.
   * A precache request made by this worker carries no Origin header, while the
   * page's own `<script crossorigin>` request does — so by the letter of the
   * spec they are different cache entries, and a precached bundle would never
   * be found again. The content does not actually vary by origin: these are
   * same-origin static files with a content hash in the name.
   */
  const MATCH = { ignoreVary: true };

  // Navigations: try the network, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(INDEX, MATCH).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Static assets: cache first, then fill the cache in the background.
  event.respondWith(
    caches.match(request, MATCH).then(
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
          // A failed asset must fail as an asset. Handing back the app shell
          // instead answers a script request with HTML, and the browser
          // rejects it on MIME type — which reads as a broken app rather than
          // a missing file, and is much harder to diagnose.
          .catch(() => Response.error()),
    ),
  );
});

/**
 * Acting on an alarm without opening the app.
 *
 * The buttons on the notification are the whole point: at 7am you want to press
 * "Snooze" on the notification itself, not hunt for a tab. If the app is open
 * the action is handed straight to it; if it is not, the app is opened with the
 * action in the URL and carries it out on load — so Snooze always snoozes,
 * whether or not anything was running.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { reminderId, itemId } = event.notification.data ?? {};
  const action = event.action || 'open';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'alarm-action', action, reminderId, itemId });
          return client.focus();
        }
      }
      const query = reminderId
        ? `?alarmAction=${encodeURIComponent(action)}&reminder=${encodeURIComponent(reminderId)}`
        : '';
      return self.clients.openWindow(`${BASE}${query}`);
    }),
  );
});

// Swiping a notification away is still an acknowledgement, so an escalating
// alarm should stop shouting rather than ring on into an empty room.
self.addEventListener('notificationclose', (event) => {
  const { reminderId } = event.notification.data ?? {};
  if (!reminderId) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        client.postMessage({ type: 'alarm-notification-closed', reminderId });
      }
    }),
  );
});
