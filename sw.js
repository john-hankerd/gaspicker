// Minimal service worker — enables "Add to Home Screen" installability.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Pass-through fetch handler (required by install criteria in some browsers).
self.addEventListener('fetch', () => {});
