// Browser regression check for the QA2-001/011/015/016/019 fixes.
// Run against a served pit-tv with `node tools/qa-browser-check.mjs [baseURL]`.

import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:3000";
// The card element is a native button classed .video-card (converted from the
// old div.card for the accessible-name work).
const CARD = ".video-card";
let failures = 0;

const check = (ok, label, detail = "") => {
  if (ok) console.log(`ok    ${label}${detail ? `  (${detail})` : ""}`);
  else {
    console.log(`FAIL  ${label}${detail ? `  (${detail})` : ""}`);
    failures += 1;
  }
};

// Prefer an explicitly configured Chrome, then the usual install locations, then
// fall back to Playwright's own download. Hardcoding one machine's path would
// make the harness fail everywhere else.
import { existsSync } from "node:fs";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const launchOpts = {};
const found = CHROME_CANDIDATES.find((p) => existsSync(p));
if (found) launchOpts.executablePath = found;

const browser = await chromium.launch(launchOpts);
// serviceWorkers: "block" so the harness always tests the files on disk. The app
// ships a service worker, and an uncontrolled stale cache silently serves the
// previous JS — which makes a correct fix look like it did nothing.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const page = await ctx.newPage();

const errors = [];
const failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(CARD, { timeout: 15000 }).catch(() => {});

// --- QA2-015: no cover fetch when nothing is missing ---
const coverPosts = [];
page.on("request", (r) => { if (r.url().includes("fetch-covers") && r.method() === "POST") coverPosts.push(r.url()); });

check((await page.locator(CARD).count()) === 198, "baseline renders 198 cards", `${await page.locator(CARD).count()}`);
check((await page.locator(".chip").count()) === 0, "baseline has 0 filter chips");
check(await page.locator("[data-view-grid].active").count() === 1, "grid view active by default");

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
check(coverPosts.length === 0, "no cover-fetch POST on load", `${coverPosts.length} POSTs`);

// --- QA2-001: facet counts reflect a live search ---
// The facet label is highlighted against the query, so match on the option's
// value attribute rather than its rendered text.
const countFor = (value) =>
  page.locator(`.filter-option input[data-filter-key="artist"][value="${value}"]`)
    .locator("xpath=../..")
    .locator(".filter-n")
    .first()
    .textContent();
const ARTIST = "Deftones";
const before = (await countFor(ARTIST))?.trim();
await page.fill("[data-search]", "deftones");
await page.waitForTimeout(700);
const after = (await countFor(ARTIST))?.trim();
check(before !== after, "facet count updates with search query", `${before} -> ${after}`);
await page.fill("[data-search]", "");
await page.waitForTimeout(700);

// --- QA2-011: list header and rows share one grid template at every width ---
await page.click('[data-set-view="list"]');
await page.waitForTimeout(600);
check(await page.locator("[data-view-list].active").count() === 1, "list view active");
check((await page.locator(".row").count()) > 0, "list rows rendered", `${await page.locator(".row").count()} rows`);

for (const width of [1440, 1024, 900, 899, 768, 500, 360]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const geom = await page.evaluate(() => {
    const head = document.querySelector(".list-head");
    const row = document.querySelector(".row");
    const main = document.querySelector("main.main") || document.querySelector("main");
    return {
      head: head ? getComputedStyle(head).gridTemplateColumns : null,
      row: row ? getComputedStyle(row).gridTemplateColumns : null,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minCell: row ? Math.min(...[...row.children].filter((c) => getComputedStyle(c).display !== "none").map((c) => c.getBoundingClientRect().width)) : null,
    };
  });
  // getComputedStyle resolves fr to px, so the templates cannot be compared as
  // strings: .row has padding and .list-head does not, so the fr tracks
  // legitimately differ. What must hold is the same track COUNT, and that the
  // fixed px tracks are byte-identical at the same index (only the fr ones move).
  const h = (geom.head || "").split(" ").filter(Boolean);
  const r = (geom.row || "").split(" ").filter(Boolean);
  const sameCount = h.length > 0 && h.length === r.length;
  const identical = h.filter((t, i) => t === r[i]).length;
  check(sameCount, `${width}px: .list-head and .row have the same track count`, `${h.length} vs ${r.length}`);
  check(identical >= 3, `${width}px: fixed px tracks are identical in both`, `${identical}/${h.length} identical`);
  // Above the breakpoint the desktop 8-track grid applies; at or below it the
  // three col-optional cells are hidden and the grid collapses to 5.
  const expected = width > 900 ? 8 : 5;
  check(h.length === expected, `${width}px: template has ${expected} tracks`, `${h.length}`);
  check(geom.mainOverflow <= 0, `${width}px: .main does not overflow`, `${geom.mainOverflow}px`);
  check(geom.minCell > 0, `${width}px: no zero-width visible cell`, `${Math.round(geom.minCell)}px min`);
}
await page.setViewportSize({ width: 1440, height: 900 });

// --- QA2-019: light mode survives a reload ---
await page.evaluate(() => {
  localStorage.setItem("pittv:prefs:v1", JSON.stringify({ view: "grid", settings: { theme: "light" } }));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
const theme = await page.evaluate(() => document.documentElement.dataset.theme);
check(theme === "light", "light mode survives a reload", `data-theme=${theme}`);

await page.evaluate(() => {
  const p = JSON.parse(localStorage.getItem("pittv:prefs:v1"));
  p.settings.theme = "dark";
  localStorage.setItem("pittv:prefs:v1", JSON.stringify(p));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark mode survives a reload");

// --- QA2-016: poisoned prefs must not brick the grid ---
const POISON = [
  '{"filters":{"artist":42}}',
  '{"filters":{"artist":{"a":1}}}',
  '{"filters":{"venue":null}}',
  '{"view":"nonsense","sort":{"field":"not-a-field","dir":"sideways"}}',
  '{"playbackPositions":{"some-id":-500}}',
  '{"artistGroups":"nope"}',
  '"not even json"',
];
for (const payload of POISON) {
  await page.evaluate((p) => localStorage.setItem("pittv:prefs:v1", p), payload);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const state = await page.evaluate((sel) => ({
    cards: document.querySelectorAll(sel).length,
    fatal: !!document.querySelector(".state-icon"),
  }), CARD);
  check(state.cards > 0 && !state.fatal, `poisoned prefs recover: ${payload}`, `${state.cards} cards, fatal=${state.fatal}`);
}

// --- valid prefs still round-trip ---
await page.evaluate(() => {
  localStorage.setItem(
    "pittv:prefs:v1",
    JSON.stringify({
      view: "list",
      filters: { quality: ["720p"] },
      sort: { field: "artist", dir: "asc" },
      settings: { reducedMotion: null, theme: "dark" },
    }),
  );
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const round = await page.evaluate(() => ({
  list: !!document.querySelector("[data-view-list].active"),
  qualityChecked: [...document.querySelectorAll('[data-filter-key="quality"]')].some((i) => i.checked),
  sortDir: document.querySelector("[data-sort-dir]")?.value || null,
  reducedMotionNull: JSON.parse(localStorage.getItem("pittv:prefs:v1")).settings.reducedMotion === null,
}));
check(round.list, "valid prefs: view=list restored");
check(round.qualityChecked, "valid prefs: filter restored");
check(round.reducedMotionNull, "valid prefs: reducedMotion null sentinel preserved");

// --- QA2-010: badge values are searchable ---
// Back to grid first: the card selector above only matches in grid view, and
// the list-view checks above left us in list view.
await page.click('[data-set-view="grid"]');
await page.waitForTimeout(600);
// Clear any active filters first: a residual quality filter would legitimately
// zero out a "480p" search, which would read as a failure rather than as the
// filter working.
await page.evaluate(() => {
  document.querySelectorAll('[data-filter-key="quality"]').forEach((i) => { if (i.checked) i.click(); });
});
await page.waitForTimeout(700);
for (const [q, min] of [["480p", 1], ["local", 1]]) {
  await page.fill("[data-search]", q);
  await page.waitForTimeout(700);
  const n = await page.locator(CARD).count();
  check(n >= min, `search "${q}" matches (was 0 before QA2-010)`, `${n} cards`);
}
await page.fill("[data-search]", "");
await page.waitForTimeout(600);

// --- QA2-012: Escape must not wipe the filter set ---
// The checkbox is visually hidden (opacity 0) inside its label, so click the label.
await page.locator('label:has([data-filter-key="quality"])').first().click();
await page.waitForTimeout(700);
const chipsBefore = await page.locator(".chip").count();
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const chipsAfterEscape = await page.locator(".chip").count();
check(chipsAfterEscape === chipsBefore, "Escape preserves the filter set", `${chipsBefore} -> ${chipsAfterEscape} chips`);

// --- QA2-017: sidebar scroll + focus survive a re-render ---
await page.evaluate(() => {
  document.querySelector("[data-filters]").scrollTop = 220;
  document.querySelectorAll('[data-filter-key="artist"]')[6]?.focus();
});
const beforeFocus = await page.evaluate(() => ({
  scroll: document.querySelector("[data-filters]").scrollTop,
  value: document.activeElement?.value || null,
}));
// Drive a re-render without moving focus: page.fill() would focus the search
// box, which is exactly what the assertion is trying to check is NOT happening.
const driveReRender = () =>
  page.evaluate(() => {
    const s = document.querySelector("[data-search]");
    s.value = "a";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });

await driveReRender();
await page.waitForTimeout(800);
const afterFocus = await page.evaluate(() => ({
  scroll: document.querySelector("[data-filters]").scrollTop,
  value: document.activeElement?.value || null,
}));
check(Math.abs(afterFocus.scroll - beforeFocus.scroll) < 40, "sidebar scroll survives a re-render", `${beforeFocus.scroll} -> ${afterFocus.scroll}`);
check(beforeFocus.value !== null && afterFocus.value === beforeFocus.value, "sidebar checkbox keeps focus across a re-render", `${beforeFocus.value} -> ${afterFocus.value}`);

await page.fill("[data-search]", "");
await page.evaluate(() => {
  document.querySelectorAll('[data-filter-key="quality"]').forEach((i) => { if (i.checked) i.click(); });
});
await page.waitForTimeout(600);

check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
check(failedRequests.length === 0, "no 4xx/5xx requests", failedRequests.slice(0, 3).join(" | "));

await browser.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
