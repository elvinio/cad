// Service worker: offline-first app shell with cache-first strategy.

const CACHE = 'scadpad-v1';

const SHELL = [
  '.',
  'index.html',
  'manifest.json',
  'css/app.css',
  'js/main.js',
  'js/state.js',
  'js/storage.js',
  'js/render-manager.js',
  'js/viewer.js',
  'js/editor.js',
  'js/customizer.js',
  'js/projects.js',
  'js/libraries.js',
  'js/export.js',
  'js/gdrive.js',
  'js/settings.js',
  'js/ui.js',
  'js/worker/openscad-worker.js',
  'vendor/three/three.module.js',
  'vendor/three/three.core.js',
  'vendor/three/OrbitControls.js',
  'vendor/three/STLLoader.js',
  'vendor/fflate/fflate.module.js',
  'vendor/openscad/openscad.js',
  'examples/default.scad',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
];

// Big files cached tolerantly: install must not fail if these time out.
const HEAVY = ['vendor/openscad/openscad.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await Promise.allSettled(HEAVY.map(url => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'getVersion') {
    event.source.postMessage({ type: 'version', version: CACHE });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never intercept auth/API traffic.
  if (url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(event.request, response.clone());
    }
    return response;
  })());
});
