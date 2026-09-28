/*
 * pwa.js — service worker registration.
 *
 * Registration is intentionally tolerant: a missing or failed sw.js must never
 * stop the app from working, it only means no offline cache.
 */

const SW_URL = "sw.js";

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return; // not supported, and not needed

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(SW_URL)
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          next?.addEventListener("statechange", () => {
            if (next.state === "installed" && navigator.serviceWorker.controller) {
              console.info("[pittv] a newer version is cached — reload to apply");
            }
          });
        });
      })
      .catch((err) => {
        console.info("[pittv] service worker not registered (offline cache disabled):", err.message);
      });
  });
}
