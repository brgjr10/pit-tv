// Measures --theme-accent / --theme-secondary contrast across the whole catalog,
// in both themes, in a real browser. QA2-014 claimed 198/198 light-mode failures
// for accent; this checks whether the ensureContrast guard fixed that.
import { chromium } from "playwright";
import { existsSync } from "node:fs";

// Same resolution as qa-browser-check.mjs: an explicit CHROME_PATH, then the
// usual install locations, then Playwright's own browser.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.argv[2] || "http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const result = await page.evaluate(async () => {
  const mod = await import("/assets/js/theme.js");
  const catalog = await (await fetch("data/catalog.json")).json();

  const parse = (v) => {
    const c = v.trim();
    if (c.startsWith("#")) {
      const h = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    const m = c.match(/[\d.]+/g).map(Number);
    return m.slice(0, 3);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const out = {};
  for (const light of [false, true]) {
    const stats = { accent: { fail: 0, worst: Infinity }, secondary: { fail: 0, worst: Infinity } };
    for (const entry of catalog) {
      const theme = await mod.themeFromEntry(entry, { light, animate: false });
      const card = parse(theme.card);
      for (const key of ["accent", "secondary"]) {
        const r = ratio(parse(theme[key]), card);
        if (r < 4.5) stats[key].fail += 1;
        if (r < stats[key].worst) stats[key].worst = r;
      }
    }
    stats.accent.worst = Math.round(stats.accent.worst * 100) / 100;
    stats.secondary.worst = Math.round(stats.secondary.worst * 100) / 100;
    out[light ? "light" : "dark"] = stats;
  }
  return { total: catalog.length, ...out };
});

await browser.close();

console.log(`covers measured: ${result.total}`);
for (const mode of ["dark", "light"]) {
  const s = result[mode];
  console.log(`  ${mode}: accent ${s.accent.fail}/${result.total} below 4.5 (worst ${s.accent.worst}:1) | secondary ${s.secondary.fail}/${result.total} (worst ${s.secondary.worst}:1)`);
}
const bad =
  result.dark.accent.fail + result.dark.secondary.fail + result.light.accent.fail + result.light.secondary.fail;
console.log(bad === 0 ? "\nALL PASS — every derived accent clears 4.5:1 in both themes" : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
