import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8"));
const shows = JSON.parse(readFileSync("data/shows.json", "utf8"));

const showKey = (id) => String(id || "").replace(/-\d+$/, "") || String(id || "");

console.log("showKey('tdd-2016-01') =", showKey("tdd-2016-01"));

const byShow = new Map();
for (const e of catalog) {
  const k = showKey(e.id);
  let i = byShow.get(k);
  if (!i) { i = { clips: 0, artists: new Set() }; byShow.set(k, i); }
  i.clips++;
  i.artists.add(e.artist);
}

let changed = [];
for (const [k, row] of Object.entries(shows.shows)) {
  const info = byShow.get(k);
  if (!info) { changed.push(`${k} deleted`); continue; }
  const a = [...info.artists].sort();
  if (row._clips !== info.clips) changed.push(`${k} clips ${row._clips}->${info.clips}`);
  if (JSON.stringify(row._artists) !== JSON.stringify(a)) changed.push(`${k} artists changed`);
}
for (const [k] of byShow) {
  if (!shows.shows[k]) changed.push(`${k} missing from shows.json`);
}

console.log("catalog entries:", catalog.length);
console.log("shows keys:", Object.keys(shows.shows).length);
console.log("changes:", changed.length);
console.log(changed.slice(0, 25).join("; "));