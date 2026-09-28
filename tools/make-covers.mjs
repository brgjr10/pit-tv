/*
 * tools/make-covers.mjs — generate the sample album art in covers/.
 *
 * The archive themes itself from cover art, so the demo needs art that is
 * (a) local, so colour extraction works without CORS headers, and
 * (b) visibly different per album, so the theme morph is obvious.
 *
 * Real covers are hot-linked in a real catalog; these are placeholders.
 *
 *   node tools/make-covers.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(fileURLToPath(new URL("../covers", import.meta.url)));

// One entry per album in data/catalog.demo.json. `hue` drives the whole
// palette; `variant` picks the geometric treatment so the set does not look
// uniform.
const DEMO_COVERS = [
  { slug: "kid-a", label: "KID A", artist: "RADIOHEAD", hue: 340, variant: "grid" },
  { slug: "without-a-net", label: "WITHOUT A NET", artist: "GRATEFUL DEAD", hue: 22, variant: "arc" },
  { slug: "lateralus", label: "LATERALUS", artist: "TOOL", hue: 196, variant: "spiral" },
  { slug: "fear-inoculum", label: "FEAR INOCULUM", artist: "TOOL", hue: 268, variant: "arc" },
  { slug: "greatest-hits", label: "GREATEST HITS", artist: "BOB DYLAN", hue: 44, variant: "grid" },
  { slug: "wave", label: "WAVE", artist: "PATTI SMITH", hue: 312, variant: "spiral" },
  { slug: "ten", label: "TEN", artist: "PEARL JAM", hue: 96, variant: "arc" },
  { slug: "purple-rain", label: "PURPLE RAIN", artist: "PRINCE", hue: 286, variant: "spiral" },
  { slug: "rumours", label: "RUMOURS", artist: "FLEETWOOD MAC", hue: 14, variant: "grid" },
];

// One entry per show in data/catalog.json. The slug matches the catalog id so a
// cover is trivial to re-generate after a rename.
const SHOW_COVERS = [
  { slug: "tdd-2016", label: "FULL SET", artist: "THREE DOORS DOWN", hue: 205, variant: "grid" },
  { slug: "korn-2017", label: "FULL SET", artist: "KORN", hue: 8, variant: "arc" },
  { slug: "mgk-xmas-2017", label: "XXMAS Y1", artist: "MACHINE GUN KELLY", hue: 330, variant: "spiral" },
  { slug: "logic-2018", label: "FULL SET", artist: "LOGIC", hue: 150, variant: "grid" },
  { slug: "mgk-xmas-2018", label: "XXMAS Y2", artist: "MACHINE GUN KELLY", hue: 342, variant: "spiral" },
  { slug: "grandson-2019", label: "FULL SET", artist: "GRANDSON", hue: 265, variant: "arc" },
  { slug: "blink-182-2019", label: "FULL SET", artist: "BLINK-182", hue: 20, variant: "grid" },
  { slug: "breaking-benjamin-2019", label: "FULL SET", artist: "BREAKING BENJAMIN", hue: 190, variant: "arc" },
  { slug: "pfv-2019", label: "FULL SET", artist: "PFV", hue: 95, variant: "spiral" },
  { slug: "mgk-xmas-2019", label: "XXMAS Y3", artist: "MACHINE GUN KELLY", hue: 350, variant: "spiral" },
  { slug: "mgk-xmas-2021", label: "XXMAS Y4", artist: "MACHINE GUN KELLY", hue: 5, variant: "spiral" },
  { slug: "halsey-2022", label: "FULL SET", artist: "HALSEY", hue: 310, variant: "arc" },
  { slug: "mgk-day-2022", label: "MGK DAY Y1", artist: "MACHINE GUN KELLY", hue: 275, variant: "grid" },
  { slug: "suicide-grey-day-2022", label: "GREY DAY TOUR", artist: "$UICIDEBOY$", hue: 120, variant: "arc" },
  { slug: "shinedown-2023", label: "FULL SET", artist: "SHINEDOWN", hue: 40, variant: "grid" },
  { slug: "fall-out-boy-2023", label: "FULL SET", artist: "FALL OUT BOY", hue: 55, variant: "arc" },
  { slug: "suicide-grey-day-2023", label: "GREY DAY TOUR", artist: "$UICIDEBOY$", hue: 135, variant: "arc" },
  { slug: "mgk-day-2023", label: "MGK DAY Y2", artist: "MACHINE GUN KELLY", hue: 285, variant: "grid" },
  { slug: "mgk-day-2024", label: "MGK DAY Y3", artist: "MACHINE GUN KELLY", hue: 295, variant: "grid" },
  { slug: "kesha-2025", label: "FULL SET", artist: "KESHA", hue: 300, variant: "spiral" },
  { slug: "mgk-xxcon-2025", label: "XXCON", artist: "MACHINE GUN KELLY", hue: 15, variant: "grid" },
  { slug: "mgk-day-2025", label: "MGK DAY Y4", artist: "MACHINE GUN KELLY", hue: 305, variant: "grid" },
  { slug: "deftones-2025", label: "FULL SET", artist: "DEFTONES", hue: 175, variant: "arc" },
  { slug: "mgk-lost-americana-2026", label: "LOST AMERICANA", artist: "MACHINE GUN KELLY", hue: 25, variant: "spiral" },
  { slug: "mgk-day-2026", label: "MGK DAY Y5", artist: "MACHINE GUN KELLY", hue: 315, variant: "grid" },
];

const COVERS = [...SHOW_COVERS, ...DEMO_COVERS];

/* ---------- colour helpers ---------- */

const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

const wrap = (text, perLine = 12) => {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > perLine) {
      lines.push(line.trim());
      line = word;
    } else {
      line += " " + word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
};

const textBlock = (lines, { x, y, size, fill, weight = 800, spacing = 1.05, anchor = "start", family = "Inter, Segoe UI, sans-serif" }) =>
  lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * size * spacing}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${size * 0.08}">${line}</text>`
    )
    .join("\n    ");

const pattern = {
  grid: (h) => `
    ${Array.from({ length: 7 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="600" stroke="${hsl(h, 70, 70)}" stroke-opacity="0.13" stroke-width="2"/>`).join("")}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 100}" x2="600" y2="${i * 100}" stroke="${hsl(h, 70, 70)}" stroke-opacity="0.13" stroke-width="2"/>`).join("")}
    <circle cx="300" cy="250" r="150" fill="none" stroke="${hsl(h + 30, 80, 66)}" stroke-opacity="0.4" stroke-width="3"/>`,
  arc: (h) => `
    ${Array.from({ length: 9 }, (_, i) => `<circle cx="300" cy="600" r="${120 + i * 46}" fill="none" stroke="${hsl(h + i * 6, 75, 68)}" stroke-opacity="${0.42 - i * 0.035}" stroke-width="3"/>`).join("")}
    <rect x="0" y="0" width="600" height="300" fill="${hsl(h + 180, 30, 8)}" fill-opacity="0.35"/>`,
  spiral: (h) => `
    ${Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 7;
      const r = 12 + i * 3.6;
      return `<circle cx="${(300 + Math.cos(a) * r).toFixed(1)}" cy="${(250 + Math.sin(a) * r).toFixed(1)}" r="${(7 - i * 0.07).toFixed(1)}" fill="${hsl(h + i * 2, 78, 68)}" fill-opacity="0.34"/>`;
    }).join("")}`,
};

const svg = ({ slug, label, artist, hue, variant }) => {
  const id = slug.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const labelLines = wrap(label, 11);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${label} by ${artist}">
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hsl(hue, 62, 22)}"/>
      <stop offset="0.55" stop-color="${hsl(hue + 18, 58, 14)}"/>
      <stop offset="1" stop-color="${hsl(hue + 40, 54, 8)}"/>
    </linearGradient>
    <radialGradient id="glow-${id}" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="${hsl(hue + 30, 85, 58)}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${hsl(hue + 30, 85, 40)}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="600" height="600" fill="url(#bg-${id})"/>
  <g>${pattern[variant](hue)}</g>
  <rect width="600" height="600" fill="url(#glow-${id})"/>

  <g transform="translate(48 372)">
    ${textBlock(labelLines, { x: 0, y: 0, size: 62, fill: "#ffffff" })}
  </g>
  <text x="48" y="540" font-family="Inter, Segoe UI, sans-serif" font-size="21" font-weight="600"
        fill="${hsl(hue + 30, 60, 78)}" letter-spacing="4.5">${artist}</text>
  <rect x="48" y="556" width="120" height="3" fill="${hsl(hue + 30, 70, 62)}"/>
</svg>
`;
};

mkdirSync(OUT, { recursive: true });
for (const cover of COVERS) {
  const file = join(OUT, `${cover.slug}.svg`);
  writeFileSync(file, svg(cover), "utf8");
  console.log(`${file}  (hue ${cover.hue}, ${cover.variant})`);
}
console.log(`\n${COVERS.length} covers written to ${OUT}`);
