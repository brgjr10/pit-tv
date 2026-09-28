/*
 * app.js — entry point.
 *
 * Restores persisted preferences, wires the store to the UI, registers the
 * service worker and logs a startup banner with anything the user should fix
 * (missing catalog, blocked fetch, missing vendored libs).
 */

import { state, restore, subscribe } from "./store.js";
import { initUI } from "./ui.js";
import { initEdit } from "./edit.js";
import { setReducedMotion } from "./anime-helpers.js";
import { registerServiceWorker } from "./pwa.js";

function boot() {
  restore();
  setReducedMotion(state.settings.reducedMotion);

  const ui = initUI();
  // Edit mode swaps each rendered title for a contenteditable span, so the grid
  // has to be re-rendered when the mode flips — otherwise entering edit mode
  // looks like it did nothing until some unrelated re-render happened to land.
  const edit = initEdit({ rerender: () => ui.render({ animate: false }) });

  // Scroll position survives a refresh, per the persistence requirements.
  restoreScroll();
  window.addEventListener(
    "scroll",
    debounce(() => {
      try {
        sessionStorage.setItem("pittv:scroll", String(document.querySelector(".main")?.scrollTop || 0));
      } catch {
        /* non-critical */
      }
    }, 200),
    { passive: true }
  );

  subscribe((s, event) => {
    if (event === "theme") document.title = s.currentVideo ? `${s.currentVideo.artist} — ${s.currentVideo.song} · PIT TV` : "PIT TV — Concert Video Archive";
  });

  registerServiceWorker();
  warnAboutMissingVendorLibs();

  // Handy for poking at state from the console; not used by the app itself.
  window.pittv = { state, ui, edit };
}

function restoreScroll() {
  try {
    const saved = Number(sessionStorage.getItem("pittv:scroll") || 0);
    if (saved > 0) {
      requestAnimationFrame(() => {
        const main = document.querySelector(".main");
        if (main) main.scrollTop = saved;
      });
    }
  } catch {
    /* non-critical */
  }
}

/**
 * anime.js and hls.js are vendored locally per the brief. If either failed to
 * load (wrong path, blocked), say so clearly rather than failing silently.
 */
function warnAboutMissingVendorLibs() {
  const missing = [];
  if (!window.anime) missing.push("lib/anime.min.js");
  if (!window.Hls) missing.push("lib/hls.min.js (HLS streams will not play)");
  if (missing.length) {
    console.warn("[pittv] missing vendor libraries:", missing.join(", "));
  }
  if (location.protocol === "file:") {
    console.warn(
      "[pittv] opened over file:// — ES modules and fetch() require an HTTP server. Run: npx serve . -p 3000"
    );
  }
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
