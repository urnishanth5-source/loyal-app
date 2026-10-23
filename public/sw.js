const CACHE_NAME = "perklyn-app-v3";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/perklyn-logo.svg",
  "/icons/perklyn-192.png",
  "/icons/perklyn-512.png",
  "/icons/perklyn-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("/");
        return Response.error();
      }),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: "Perklyn", body: "You have a new notification." };
  }
  const title = String(payload.title || "Perklyn");
  const body = String(payload.body || "You have a new notification.");
  const id = String(payload.id || Date.now());
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icons/perklyn-192.png",
    badge: "/icons/perklyn-192.png",
    tag: String(payload.tag || `perklyn-${id}`),
    data: {
      url: String(payload.url || `/?notification=${id}`),
      notificationId: id,
    },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.navigate(destination);
        return existing.focus();
      }
      return clients.openWindow(destination);
    }),
  );
});
