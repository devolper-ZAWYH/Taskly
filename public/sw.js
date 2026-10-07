/*
 * Service worker: makes the app installable and gives a friendly offline page.
 * It never caches API responses or pages (task data stays fresh and private);
 * only fingerprinted build assets are cached, since they never change.
 */
const VERSION = "v4"
const STATIC_CACHE = `static-${VERSION}`
// Cloudflare serves public/offline.html at /offline (it redirects the .html URL,
// and a redirected response cannot answer a page load).
const OFFLINE_URL = "/offline"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Page loads: always from the network; the offline page if there is none.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
    return
  }

  // Hashed build files never change: serve from cache, fill it on first use.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached
        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      }),
    )
  }
  // Everything else (API calls, logos, data) goes straight to the network.
})

/*
 * Push: the server sends an empty push; we fetch the newest notification over
 * the signed-in API so message text never passes through the push service.
 * If that fails (signed out, offline) we still show a generic notice.
 */
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let item = null
      try {
        const response = await fetch("/api/rpc/latestPushNotification", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: [] }),
          credentials: "same-origin",
        })
        if (response.ok) item = (await response.json()).data
      } catch {
        // fall through to the generic notice
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of windows) client.postMessage({ type: "notification" })
      await self.registration.showNotification("Taskly", {
        body: item?.text || "You have a new notification · لديك إشعار جديد",
        icon: "/icons/icon-192.png",
        tag: item?.id || "taskly",
        data: { link: item?.link || "/" },
      })
    })(),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.link || "/", self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (existing) {
        await existing.focus()
        if ("navigate" in existing) await existing.navigate(url).catch(() => {})
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
