/*
 * theme.js — album-art driven theming.
 *
 * Pipeline: load art -> draw to an offscreen canvas (max 150px) -> median-cut
 * quantization -> build a readable palette -> animate the CSS custom properties
 * with anime.js.
 *
 * Readability is enforced after extraction: a cover is art, not a UI palette, so
 * every derived colour is pushed toward a minimum lightness/saturation floor and
 * the text colour is chosen by WCAG contrast against the derived background
 * rather than by guessing.
 */

import { setCurrentTheme } from "./store.js";
import { reducedMotion } from "./anime-helpers.js";

const SAMPLE_SIZE = 150; // keeps quantization under a few ms even for big art
const CACHE_LIMIT = 40;

/* ---------- colour space helpers (all in HSL) ---------- */

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return { r: 128, g: 128, b: 128 };
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsl({ r, g, b }) {
  if (![r, g, b].every(Number.isFinite)) return { h: 0, s: 0, l: 0.5 };
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const denominator = l > 0.5 ? 2 - max - min : max + min;
  if (denominator <= 0) return { h: 0, s: 0, l };
  const s = d / denominator;
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;

  return { h: h * 360, s, l };
}

function hslToRgb({ h, s, l }) {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sat = clamp(s, 0, 1);
  const li = clamp(l, 0, 1);

  if (sat === 0) {
    const v = Math.round(li * 255);
    return { r: v, g: v, b: v };
  }

  const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat;
  const p = 2 * li - q;
  return {
    r: Math.round(hueToChannel(p, q, hn + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, hn) * 255),
    b: Math.round(hueToChannel(p, q, hn - 1 / 3) * 255),
  };
}

function hueToChannel(p, q, t) {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const toHex = ({ r, g, b }) => {
  const channel = (c) => {
    // A non-finite channel would silently become "#NaN" and poison every
    // derived value, so clamp hard and fall back to mid-grey.
    const v = Number.isFinite(c) ? c : 128;
    return Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  };
  return `#${channel(r)}${channel(g)}${channel(b)}`;
};

function relativeLuminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(hexA, hexB) {
  const a = relativeLuminance(hexToRgb(hexA));
  const b = relativeLuminance(hexToRgb(hexB));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- median cut quantization ---------- */

/**
 * Median-cut palette extraction over an array of [r,g,b] samples.
 * @param {Array<number[]>} pixels
 * @param {number} count how many buckets to produce
 * @returns {Array<{hex: string, rgb: object, hsl: object, weight: number}>}
 */
export function medianCut(pixels, count = 6) {
  if (!pixels || !pixels.length) return [];

  let buckets = [pixels];
  while (buckets.length < count) {
    // Split the bucket with the largest weighted range.
    let targetIndex = -1;
    let bestRange = -1;
    let bestAxis = 0;

    buckets.forEach((bucket, i) => {
      if (bucket.length < 2) return;
      const ranges = channelRanges(bucket);
      let axis = 0;
      let widest = -1;
      for (let a = 0; a < 3; a += 1) {
        if (ranges[a] > widest) {
          widest = ranges[a];
          axis = a;
        }
      }
      if (widest > bestRange) {
        bestRange = widest;
        targetIndex = i;
        bestAxis = axis;
      }
    });

    if (targetIndex === -1 || bestRange <= 0) break;

    const sorted = [...buckets[targetIndex]].sort((a, b) => a[bestAxis] - b[bestAxis]);
    const mid = Math.floor(sorted.length / 2);
    buckets.splice(targetIndex, 1, sorted.slice(0, mid), sorted.slice(mid));
  }

  return buckets
    .filter((b) => b.length)
    .map((bucket) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [pr, pg, pb] of bucket) {
        r += pr;
        g += pg;
        b += pb;
      }
      const n = bucket.length;
      const rgb = { r: r / n, g: g / n, b: b / n };
      const hsl = rgbToHsl(rgb);
      if (![hsl.h, hsl.s, hsl.l].every(Number.isFinite)) return null;
      return { rgb, hex: toHex(rgb), hsl, weight: n };
    })
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight);
}

function channelRanges(bucket) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const px of bucket) {
    for (let a = 0; a < 3; a += 1) {
      if (px[a] < min[a]) min[a] = px[a];
      if (px[a] > max[a]) max[a] = px[a];
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/* ---------- art sampling ---------- */

const paletteCache = new Map(); // artUrl -> palette
const inflight = new Map(); // artUrl -> Promise

function samplePixels(img) {
  const size = Math.min(SAMPLE_SIZE, img.naturalWidth || SAMPLE_SIZE, img.naturalHeight || SAMPLE_SIZE);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  // Centre-crop to a square so album art fills the sample instead of padding it.
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

  const { data } = ctx.getImageData(0, 0, size, size);
  const pixels = [];
  // Skip every other pixel: 2x downsample keeps the cost linear and the result
  // visually identical for palette purposes.
  for (let i = 0; i < data.length; i += 8) {
    const a = data[i + 3];
    if (a < 125) continue; // ignore transparent / near-transparent pixels
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  return pixels;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load album art: ${src}`));
    img.src = src;
  });
}

async function extractPalette(src) {
  if (!src) return null;
  if (paletteCache.has(src)) return paletteCache.get(src);
  if (inflight.has(src)) return inflight.get(src);

  const job = (async () => {
    const img = await loadImage(src);
    const pixels = samplePixels(img);
    const palette = pixels.length >= 12 ? medianCut(pixels, 7) : null;
    if (palette) {
      if (paletteCache.size >= CACHE_LIMIT) paletteCache.delete(paletteCache.keys().next().value);
      paletteCache.set(src, palette);
    }
    return palette;
  })();

  inflight.set(src, job);
  try {
    return await job;
  } finally {
    inflight.delete(src);
  }
}

/* ---------- palette -> CSS palette ---------- */

const KNOWN_ARTIST_THEMES = {
  radiohead: { primary: 340, hueShift: 0 },
  "grateful dead": { primary: 28 },
  tool: { primary: 200 },
  "bob dylan": { primary: 42 },
  "patti smith": { primary: 300 },
  "pearl jam": { primary: 96 },
  prince: { primary: 285 },
  "fleetwood mac": { primary: 25 },
};

/**
 * Build the full theme object from a quantized palette.
 * @param {Array} palette from medianCut
 * @param {object} opts { artist, light }
 */
export function buildTheme(palette, { artist = "", light = false } = {}) {
  if (!palette || !palette.length) return null;

  const buckets = palette.map((p) => ({ ...p, hsl: { ...p.hsl } }));

  // Dark UI: discard near-greys and near-blacks, which dominate moody covers
  // and would otherwise win the "primary" slot.
  const usable = buckets.filter((p) => p.hsl.s > 0.12 || p.hsl.l > 0.35);
  const pool = usable.length >= 2 ? usable : buckets;

  const scored = [...pool]
    .map((p) => {
      const { h, s, l } = p.hsl;
      // Favour saturated mid-lightness buckets: readable, recognisably "the cover".
      const score = s * 1.4 + (1 - Math.abs(l - 0.58) * 2) * 0.5 + Math.min(p.weight / 3000, 1) * 0.2;
      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score);

  const primary = scored[0].hsl;
  const secondarySource = scored[1]?.hsl || primary;

  const known = KNOWN_ARTIST_THEMES[artist.toLowerCase()];
  const primaryHue = known ? known.primary : primary.h;

  // Vary the secondary hue so the gradient is not a flat wash.
  const secondaryHue = secondarySource.h + 150;

  const theme = {
    primary: toHex(hslToRgb({ h: primaryHue, s: clamp(primary.s * 1.25, 0.45, 0.9), l: 0.62 })),
    secondary: toHex(hslToRgb({ h: secondaryHue, s: clamp(secondarySource.s * 1.1, 0.4, 0.85), l: 0.55 })),
    accent: toHex(hslToRgb({ h: primaryHue + 40, s: 0.78, l: 0.66 })),
  };

  if (light) return finishLightTheme(theme, primaryHue);
  return finishDarkTheme(theme, primaryHue);
}

function finishDarkTheme(theme, hue) {
  const bg = toHex(hslToRgb({ h: hue, l: 0.06, s: 0.16 }));
  const card = toHex(hslToRgb({ h: hue, l: 0.095, s: 0.14 }));
  const border = toHex(hslToRgb({ h: hue, l: 0.19, s: 0.16 }));
  const text = "#e6edf3";
  const muted = "#8b949e";

  // Nudge each accent until it clears 4.5:1 on the card surface; if it cannot,
  // fall back to a fixed lightness rather than shipping unreadable accents.
  // secondary and accent get the same treatment as primary: the README promises
  // the derived colours are contrast-checked, and secondary is already painted
  // into the header gradient, so leaving either unguarded made that a false
  // claim the moment a token was wired to a surface.
  theme.primary = ensureContrast(theme.primary, card, 4.5, { h: hue, s: 0.8, l: 0.72 });
  theme.secondary = ensureContrast(theme.secondary, card, 4.5, { h: hue, s: 0.55, l: 0.66 });
  theme.accent = ensureContrast(theme.accent, card, 4.5, { h: hue, s: 0.9, l: 0.6 });

  return {
    ...theme,
    bg,
    card,
    border,
    text,
    textMuted: muted,
    glow: hexToRgba(theme.primary, 0.3),
    gradient: `linear-gradient(135deg, ${hexToRgba(theme.primary, 0.17)}, ${hexToRgba(theme.secondary, 0.07)})`,
    mode: "dark",
  };
}

function finishLightTheme(theme, hue) {
  const bg = toHex(hslToRgb({ h: hue, l: 0.97, s: 0.18 }));
  const card = "#ffffff";
  const border = toHex(hslToRgb({ h: hue, l: 0.86, s: 0.2 }));
  const text = "#1f2328";

  theme.primary = ensureContrast(theme.primary, card, 4.5, { h: hue, s: 0.7, l: 0.32 });
  theme.secondary = ensureContrast(theme.secondary, card, 4.5, { h: hue, s: 0.5, l: 0.28 });
  theme.accent = ensureContrast(theme.accent, card, 4.5, { h: hue, s: 0.85, l: 0.26 });

  return {
    ...theme,
    bg,
    card,
    border,
    text,
    textMuted: "#59636e",
    glow: hexToRgba(theme.primary, 0.22),
    gradient: `linear-gradient(135deg, ${hexToRgba(theme.primary, 0.14)}, ${hexToRgba(theme.secondary, 0.06)})`,
    mode: "light",
  };
}

function ensureContrast(candidateHex, bgHex, min, fallbackHsl) {
  let hsl = rgbToHsl(hexToRgb(candidateHex));
  let l = hsl.l;
  const step = 0.04;
  const darken = relativeLuminance(hexToRgb(bgHex)) > 0.3;

  for (let i = 0; i < 12 && contrast(candidateHex, bgHex) < min; i += 1) {
    l = clamp(darken ? l - step : l + step, 0.05, 0.98);
    candidateHex = toHex(hslToRgb({ ...hsl, l }));
  }

  if (contrast(candidateHex, bgHex) < min) {
    candidateHex = toHex(hslToRgb(fallbackHsl));
  }
  return candidateHex;
}

function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/* ---------- applying the theme ---------- */

const CSS_VARS = [
  ["primary", "--theme-primary"],
  ["secondary", "--theme-secondary"],
  ["accent", "--theme-accent"],
  ["bg", "--theme-bg"],
  ["card", "--theme-card"],
  ["border", "--theme-border"],
  ["text", "--theme-text"],
  ["textMuted", "--theme-text-muted"],
];

let currentThemeKey = null;
let currentThemeRef = null;

/** Exposed for the settings popover: force neutral, no art involved. */
export function resetTheme({ light = false, animate = true } = {}) {
  return themeFromEntry(null, { light, animate });
}

/**
 * Apply a theme, morphing from whatever is currently on :root.
 *
 * The morph is driven by animating plain HSL numbers and writing the CSS custom
 * properties in anime's `update` callback, rather than asking anime to tween CSS
 * variables directly: that keeps the 600ms transition interpolating in HSL
 * (no muddy sRGB midpoints) and works identically with or without native
 * variable animation support.
 */
export function applyTheme(theme, { animate = true, duration = 600 } = {}) {
  if (!theme) return null;

  const root = document.documentElement;
  const light = theme.mode === "light";

  root.dataset.theme = light ? "light" : "dark";

  // Derived values are recomputed every frame from the live primary/secondary.
  const writeDerived = (primary, secondary) => {
    root.style.setProperty("--theme-glow", hexToRgba(primary, light ? 0.22 : 0.3));
    root.style.setProperty(
      "--theme-gradient",
      `linear-gradient(135deg, ${hexToRgba(primary, light ? 0.14 : 0.17)}, ${hexToRgba(secondary, light ? 0.06 : 0.07)})`
    );
  };

  const first = animate === "init" || currentThemeKey === null || reducedMotion() || !window.anime;

  if (first) {
    for (const [key, varName] of CSS_VARS) root.style.setProperty(varName, theme[key]);
    writeDerived(theme.primary, theme.secondary);
    document.body.style.backgroundColor = theme.bg;
    document.body.style.color = theme.text;
    currentThemeKey = themeKey(theme);
    setCurrentTheme(theme);
    return null;
  }

  // Snapshot what is on screen right now so rapid switches mid-morph blend
  // from the in-flight value instead of snapping.
  const channels = {};
  const targets = {};
  for (const [key, varName] of CSS_VARS) {
    const from = parseColour(getComputedStyle(root).getPropertyValue(varName).trim());
    const to = parseColour(theme[key]);
    if (!from || !to) {
      root.style.setProperty(varName, theme[key]);
      continue;
    }
    channels[`${key}_h`] = from.h;
    channels[`${key}_s`] = from.s;
    channels[`${key}_l`] = from.l;
    targets[`${key}_h`] = to.h;
    targets[`${key}_s`] = to.s;
    targets[`${key}_l`] = to.l;
  }

  const frames = { h: 0, s: 0, l: 0 };
  const anim = window.anime({
    targets: channels,
    ...targets,
    duration,
    easing: "easeOutExpo",
    update: () => {
      for (const [key, varName] of CSS_VARS) {
        if (channels[`${key}_h`] === undefined) continue;
        frames.h = channels[`${key}_h`];
        frames.s = channels[`${key}_s`];
        frames.l = channels[`${key}_l`];
        root.style.setProperty(varName, toHex(hslToRgb(frames)));
      }
      const primary = toHex(hslToRgb({ h: channels.primary_h, s: channels.primary_s, l: channels.primary_l }));
      const secondary = toHex(hslToRgb({ h: channels.secondary_h, s: channels.secondary_s, l: channels.secondary_l }));
      writeDerived(primary, secondary);
      document.body.style.backgroundColor = root.style.getPropertyValue("--theme-bg") || theme.bg;
    },
    complete: () => {
      for (const [key, varName] of CSS_VARS) root.style.setProperty(varName, theme[key]);
      writeDerived(theme.primary, theme.secondary);
    },
  });

  currentThemeKey = themeKey(theme);
  setCurrentTheme(theme);
  return anim;
}

const themeKey = (theme) => `${theme.primary}|${theme.bg}|${theme.mode}`;

function parseColour(value) {
  if (!value) return null;
  const str = value.trim();
  if (str.startsWith("#")) {
    const { h, s, l } = rgbToHsl(hexToRgb(str));
    return { h, s, l };
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  const { h, s, l } = rgbToHsl({ r: parts[0], g: parts[1], b: parts[2] });
  return { h, s, l };
}

/* ---------- public entry point ---------- */

/**
 * Theme the app from a catalog entry's album art.
 * Falls back to the neutral default palette when the art is missing or
 * cross-origin-restricted (canvas taint), so the UI never loses its colours.
 */
export async function themeFromEntry(entry, { light = false, animate = true } = {}) {
  const key = entry ? `${entry.id}::${light}` : `default::${light}`;
  if (key === currentThemeKey) return currentThemeRef;

  let palette = null;
  if (entry?.albumArt) {
    try {
      palette = await extractPalette(entry.albumArt);
    } catch (err) {
      // CORS-blocked art is common for wiki/CDN covers; not worth surfacing to
      // the user, just fall through to the neutral palette.
      console.debug("[theme] extraction failed, using fallback", err.message);
    }
  }

  const theme = buildTheme(palette, { artist: entry?.artist || "", light }) || neutralTheme(light);
  currentThemeRef = theme;
  applyTheme(theme, { animate });
  return theme;
}

function neutralTheme(light) {
  return buildTheme(
    [
      { hex: "#58a6ff", rgb: hexToRgb("#58a6ff"), hsl: { h: 212, s: 1, l: 0.67 }, weight: 100 },
      { hex: "#8b949e", rgb: hexToRgb("#8b949e"), hsl: { h: 213, s: 0.1, l: 0.58 }, weight: 100 },
    ],
    { light }
  );
}
