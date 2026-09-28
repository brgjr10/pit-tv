/*
 * anime-helpers.js — reusable anime.js timelines.
 *
 * anime.js is loaded as a classic script before the module graph (window.anime),
 * so it is intentionally not imported here. Every helper degrades to an
 * instant, side-effect-free call when motion is reduced: durations collapse to
 * 0 rather than the animation being skipped, so `complete` callbacks (which
 * remove .anim-pre, swap views, etc.) still fire in the same order.
 */

const anime = () => window.anime;

let motionOverride = null; // null = follow OS, true = reduce, false = full

export function setReducedMotion(value) {
  motionOverride = value;
  applyReducedMotionFlag();
}

export function reducedMotion() {
  const osPrefers = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return motionOverride === null ? osPrefers : motionOverride;
}

function applyReducedMotionFlag() {
  document.documentElement.dataset.reducedMotion = String(reducedMotion());
}

function dur(ms) {
  return reducedMotion() ? 0 : ms;
}

function stagger(step, opts) {
  if (reducedMotion()) return 0;
  return anime().stagger(step, opts);
}

export const EASE = {
  out: "easeOutExpo",
  quad: "easeInOutQuad",
  outQuart: "easeOutQuart",
  outBack: "easeOutBack",
};

/* ---------- Grids / lists: staggered entrance ---------- */

export function staggerIn(elements, { step = 40, start = 0, distance = 26, duration = 500 } = {}) {
  const targets = toArray(elements);
  if (!targets.length) return null;
  targets.forEach((el) => el.classList.add("anim-pre"));

  if (reducedMotion()) {
    targets.forEach((el) => el.classList.remove("anim-pre"));
    return null;
  }

  return anime()({
    targets,
    keyframes: [
      { opacity: [0, 1], translateY: [distance, 0], duration, easing: EASE.out },
    ],
    delay: stagger(step, { start }),
    complete: () => targets.forEach((el) => el.classList.remove("anim-pre")),
  });
}

/* ---------- View switch: cross-fade + layout shift ---------- */

export function crossFade(fromEl, toEl) {
  if (reducedMotion()) return null;
  if (fromEl) {
    anime()({
      targets: fromEl,
      opacity: [1, 0],
      translateY: [0, -10],
      duration: 180,
      easing: EASE.quad,
      complete: () => {
        fromEl.classList.remove("active");
        fromEl.style.opacity = "";
        fromEl.style.transform = "";
      },
    });
  }
  if (toEl) {
    anime()({
      targets: toEl,
      keyframes: [
        { opacity: [0, 1], translateY: [12, 0], duration: 320, easing: EASE.out },
      ],
    });
  }
  return null;
}

/* ---------- Shared element: card -> player ---------- */

export function sharedElement(cardEl, modalEl, backdropEl) {
  if (reducedMotion() || !cardEl) {
    if (backdropEl) backdropEl.style.opacity = "";
    if (modalEl) modalEl.style.opacity = "";
    return null;
  }

  const from = cardEl.getBoundingClientRect();
  const art = cardEl.querySelector(".card-art");

  if (backdropEl) {
    anime()({ targets: backdropEl, opacity: [0, 1], duration: 220, easing: EASE.quad });
  }

  const anim = anime()({
    targets: modalEl,
    keyframes: [
      { opacity: [0, 1], scale: [0.94, 1], translateY: [18, 0], duration: 420, easing: EASE.out },
    ],
  });

  // Fly a ghost of the cover art from the card into the stage.
  if (art) {
    const to = modalEl.querySelector(".stage");
    if (to) {
      const target = to.getBoundingClientRect();
      const ghost = art.cloneNode(true);
      ghost.style.cssText = `position:fixed;z-index:250;border-radius:12px;object-fit:cover;
        left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;
        pointer-events:none;margin:0;`;
      document.body.appendChild(ghost);
      anime()({
        targets: ghost,
        keyframes: [
          {
            translateX: [0, target.left - from.left],
            translateY: [0, target.top - from.top],
            width: [from.width, target.width],
            height: [from.height, target.height],
            opacity: [1, 0],
            duration: 460,
            easing: EASE.out,
          },
        ],
        complete: () => ghost.remove(),
      });
    }
  }

  return anim;
}

export function closeModal(modalEl, backdropEl) {
  if (reducedMotion()) return null;
  if (backdropEl) {
    anime()({ targets: backdropEl, opacity: [1, 0], duration: 180, easing: EASE.quad });
  }
  return anime()({
    targets: modalEl,
    keyframes: [{ opacity: [1, 0], scale: [1, 0.96], duration: 200, easing: EASE.quad }],
  });
}

/* ---------- Modal open (non-player): backdrop blur + scale from centre ---------- */

export function popIn(el) {
  if (reducedMotion()) return null;
  el.style.opacity = "0";
  return anime()({
    targets: el,
    keyframes: [
      { opacity: [0, 1], scale: [0.92, 1], duration: 320, easing: EASE.out },
    ],
    complete: () => {
      el.style.opacity = "";
      el.style.transform = "";
    },
  });
}

export function popOut(el, done) {
  if (reducedMotion()) {
    done?.();
    return null;
  }
  return anime()({
    targets: el,
    keyframes: [{ opacity: [1, 0], scale: [1, 0.94], duration: 180, easing: EASE.quad }],
    complete: done,
  });
}

/* ---------- Search results morph ---------- */

export function morphResults(container, { duration = 220 } = {}) {
  if (reducedMotion()) return null;
  const children = [...container.children];
  if (!children.length) return null;
  children.forEach((el) => el.classList.add("anim-pre"));
  return anime()({
    targets: children,
    keyframes: [
      { opacity: [0, 1], translateY: [12, 0], scale: [0.98, 1], duration, easing: EASE.out },
    ],
    delay: stagger(18),
    complete: () => children.forEach((el) => el.classList.remove("anim-pre")),
  });
}

/* ---------- Filter chip + toast micro-interactions ---------- */

export function pulse(el) {
  if (reducedMotion()) return null;
  return anime()({ targets: el, scale: [1, 1.04, 1], duration: 260, easing: "easeOutQuad" });
}

export function toastIn(el) {
  if (reducedMotion()) {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
    return null;
  }
  el.style.opacity = "0";
  return anime()({
    targets: el,
    keyframes: [
      { opacity: [0, 1], translateY: [14, 0], duration: 240, easing: EASE.out },
    ],
    complete: () => {
      el.style.opacity = "";
      el.style.transform = "translateX(-50%)";
    },
  });
}

export function toastOut(el, done) {
  if (reducedMotion()) {
    done?.();
    return null;
  }
  return anime()({
    targets: el,
    keyframes: [{ opacity: [1, 0], translateY: [0, 10], duration: 200, easing: EASE.quad }],
    complete: done,
  });
}

/* ---------- Number counters in the header ---------- */

export function countUp(el, to, format = (n) => String(n)) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  if (reducedMotion() || from === to) {
    el.textContent = format(to);
    return null;
  }
  const obj = { n: from };
  return anime()({
    targets: obj,
    n: to,
    round: 1,
    duration: 420,
    easing: "easeOutQuad",
    update: () => {
      el.textContent = format(obj.n);
    },
  });
}

/** Normalise the several shapes callers pass (selector, element, NodeList). */
function toArray(input) {
  if (!input) return [];
  if (typeof input === "string") return [...document.querySelectorAll(input)];
  if (input instanceof Element) return [input];
  return [...input];
}

// Keep the DOM flag in sync when the OS preference changes mid-session.
window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => {
  if (motionOverride === null) applyReducedMotionFlag();
});
