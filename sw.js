// Простой service worker: кэширует игры при первом визите,
// чтобы приложение открывалось даже без интернета после установки.
const CACHE_NAME = "kids-games-cache-v8";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./coloring_game.html",
  "./numbers_game.html",
  "./piano_game.html",
  "./fishes_game.html",
  "./puzzle_game.html",
  "./feed_animals_game.html",
  "./build_house_game.html",
  "./soap_bubbles_game.html",
  "./car_adventure_game.html",
  "./car_soccer_game.html",
  "./lib/three.min.js",
  "./lib/GLTFLoader.js",
  "./racing/index.html",
  "./racing/style.css",
  "./racing/car_model.js",
  "./racing/grass_texture.js",
  "./racing/pine_model.js",
  "./racing/game.js",
  "./racing/car.glb",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Стратегия: сеть в приоритете (чтобы всегда подтягивались свежие коммиты),
// а кэш — как запасной вариант, если интернета нет.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
