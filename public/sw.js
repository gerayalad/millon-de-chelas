// Service worker de Millón de Chelas: hace instalable la app (PWA), guarda una copia ligera
// para abrir sin red y muestra los avisos push de metas.
// Los push llegan vacíos: el texto se pide a /api/aviso (ver worker/src/push.ts).

const CACHE = 'chelas-v1';
const BASICOS = ['/', '/manifest.webmanifest', '/icon-192.png', '/favicon.svg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICOS)).catch(() => undefined));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Páginas: siempre de la red (el conteo es en vivo); sin red, la última copia.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === '/') {
            const copia = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copia));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // JS/CSS con hash en el nombre: no cambian, se guardan la primera vez.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (guardada) =>
          guardada ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copia = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copia));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      let aviso = { title: '🍺 Millón de Chelas', body: '¡El grupo llegó a una nueva meta!', url: '/' };
      try {
        const res = await fetch('/api/aviso', { cache: 'no-store' });
        if (res.ok) aviso = await res.json();
      } catch {
        /* sin red: el texto genérico */
      }
      await self.registration.showNotification(aviso.title, {
        body: aviso.body,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        tag: 'meta',
        data: { url: aviso.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const v of ventanas) {
        if ('focus' in v) {
          await v.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
