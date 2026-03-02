// Sadhana Tracker — Service Worker
// Handles: offline caching + push notifications

const CACHE_NAME = 'sadhana-tracker-v1';
const ASSETS = [
  '/Coordinators-Sadhana-Tracker/index.html',
  '/Coordinators-Sadhana-Tracker/app.js',
  '/Coordinators-Sadhana-Tracker/signup.html',
  '/Coordinators-Sadhana-Tracker/manifest.json',
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// ── INSTALL ──────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH (Network first, fallback to cache) ─────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('firestore.googleapis.com')) return; // never cache Firestore

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFICATIONS ───────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Sadhana Tracker', body: 'You have a new notification.' };
  try { data = e.data.json(); } catch {}

  const options = {
    body: data.body,
    icon: '/Coordinators-Sadhana-Tracker/icons/icon-192.png',
    badge: '/Coordinators-Sadhana-Tracker/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/Coordinators-Sadhana-Tracker/index.html' },
    actions: data.actions || [],
    requireInteraction: false
  };

  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── NOTIFICATION CLICK ───────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/Coordinators-Sadhana-Tracker/index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('Sadhana-Tracker') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── BACKGROUND SYNC (sadhana reminder check) ─────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sadhana-reminder') {
    e.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify() {
  const msg = {
    title: '🙏 Sadhana Reminder',
    body: "You haven't filled your Sadhana today. Please submit now.",
    url: '/Coordinators-Sadhana-Tracker/index.html'
  };
  await self.registration.showNotification(msg.title, {
    body: msg.body,
    icon: '/Coordinators-Sadhana-Tracker/icons/icon-192.png',
    data: { url: msg.url }
  });
}
