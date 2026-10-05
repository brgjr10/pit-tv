/*
 * check-catalog.mjs — the one diagnostic for the clip-grouping model.
 *
 * Consolidates the ad-hoc checks that used to be spread over check-groups.mjs
 * (what the file groups into) and check-group-rules.mjs (which rules the
 * grouping obeys), and adds the two checks that only matter once a group has
 * been reordered and written back to disk.
 *
 * Every section reports a count and a short sample rather than a full dump, so
 * the output stays readable on the 198-entry catalog. Nothing here mutates
 * anything: it is a read-only report, safe to run while the server is up.
 *
 *   node tools/check-catalog.mjs [path]      # default data/catalog.json
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

import { toGroups } from "../assets/js/grouping.js";
import { normaliseEntry } from "../assets/js/catalog.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "data", "catalog.json");

/* How many examples to print per section — enough to find the culprit, short
   enough to read on a terminal. */
const SAMPLE = 8;

const say = (...parts) => console.log(...parts);
const sample = (list) => list.slice(0, SAMPLE).join("; ") + (list.length > SAMPLE ? `; … +${list.length - SAMPLE}` : "");

/* ---------- read ---------- */

// data/catalog.json is gitignored, so a fresh worktree or a clone has no
// catalog at all. That is not an error: say what is missing and stop, rather
// than throwing a stack trace at someone who just wanted a smoke test.
if (!existsSync(CATALOG)) {
  say(`no catalog at ${CATALOG}`);
  say("nothing to check — start the server once, or pass a path: node tools/check-catalog.mjs <catalog.json>");
  process.exit(0);
}

let raw;
try {
  raw = JSON.parse(readFileSync(CATALOG, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
  say(`could not read ${CATALOG}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(raw)) {
  say(`${CATALOG} must contain a JSON array of entries, found ${typeof raw}`);
  process.exit(1);
}

// The bundled demo predates the shows.json split and ships no media, so a run
// against it legitimately reports every entry as carrying show fields and every
// local video as missing. Say so rather than let it read as breakage.
const isDemo = /catalog\.demo\.json$/.test(CATALOG);
if (isDemo) say("NOTE: this is the demo fallback, not the real catalog — its show-level fields and missing media are expected.");

/* ---------- normalise ---------- */

const seenIds = new Set();
const entries = [];
const bad = [];
raw.forEach((record, i) => {
  const result = normaliseEntry(record, i, seenIds);
  if (result.error) bad.push(result.error);
  else entries.push(result.entry);
});
if (bad.length) say(`skipped ${bad.length}: ${sample(bad)}`);

/* ---------- 1. grouping keys are derived, not stored ---------- */

// songId and clipIndex are derived by normaliseEntry so every in-memory entry
// always has them, which means "missing" can only be asked of the raw file. A
// raw entry without them is not broken — the keys come from its song and its id
// — but it is the thing to look at when a group forms or orders wrongly.
const noSongId = raw.filter((r) => !r.songId).map((r) => r.id);
const noClipIndex = raw.filter((r) => r.clipIndex === undefined).map((r) => r.id);
say(`entries ${raw.length}, normalised ${entries.length}`);
say(`songId derived (absent on disk) ${noSongId.length}: ${sample(noSongId)}`);
say(`clipIndex derived (absent on disk) ${noClipIndex.length}: ${sample(noClipIndex)}`);

/* ---------- 2. what the file renders as ---------- */

const groups = toGroups(entries);
const multi = groups.filter((g) => g.isGroup);
say(`cards ${groups.length}, multi-clip groups ${multi.length}, clips absorbed ${multi.reduce((a, g) => a + g.clipCount, 0)}`);

/* ---------- 3. clips in a group must agree on the song ---------- */

// songId is the group key and is derived from the song title, so a group whose
// clips disagree on the song can only happen when a persisted songId outlived a
// rename. Grouping still works (the key is stable), but the card's title is
// promoted from one clip and would silently be wrong for the rest.
const disagreeing = [];
for (const group of multi) {
  const titles = new Set(group.clips.map((c) => c.song));
  if (titles.size > 1) disagreeing.push(`${group.id} -> ${[...titles].map((t) => JSON.stringify(t)).join(" / ")}`);
}
say(`groups whose clips disagree on song ${disagreeing.length}: ${sample(disagreeing)}`);

/* ---------- 4. no two clips of a group may share an index ---------- */

// A duplicate index means the swap that a reorder performs wrote the same value
// twice, so the user's chosen order cannot be reconstructed and the panel's ↑/↓
// would appear to do nothing on reload.
const duplicated = [];
for (const group of multi) {
  const byIndex = new Map();
  for (const clip of group.clips) {
    const seen = byIndex.get(clip.clipIndex) || [];
    seen.push(clip.id);
    byIndex.set(clip.clipIndex, seen);
  }
  for (const [index, ids] of byIndex) {
    if (ids.length > 1) duplicated.push(`${group.id} clipIndex ${index}: ${ids.join(", ")}`);
  }
}
say(`groups with a duplicate clipIndex ${duplicated.length}: ${sample(duplicated)}`);

/* ---------- 5. every referenced video is on disk ---------- */

// Only repo-relative paths are checked. An absolute http(s) source is a hosted
// stream (YouTube, Mux, a CDN), which the filesystem has no opinion about.
//
// This one is about the checkout, not the file: videos/ is gitignored, so a
// clone or a worktree legitimately has no media and every entry reports missing.
// The header below says which case this is so the number is not read as damage.
const mediaPresent = existsSync(join(ROOT, "videos", "catalog"));
const missingFiles = [];
for (const entry of entries) {
  const src = entry.video?.src;
  if (!src || /^https?:\/\//i.test(src)) continue;
  if (!existsSync(join(ROOT, src))) missingFiles.push(`${entry.id} -> ${src}`);
}
say(`entries whose video.src is not on disk ${missingFiles.length}${mediaPresent ? "" : " (no videos/catalog here — the media tree is gitignored)"}: ${sample(missingFiles)}`);

/* ---------- 6. the copies on each clip must agree with shows.json ---------- */

// date, venue and location are authoritative in shows.json, and
// tools/set-locations.mjs mirrors them onto every clip of the show on each run —
// so a clip that carries a different value is drift something can act on: the
// app renders shows.json either way, which means a wrong copy here is invisible
// on screen and wrong for every tool that reads the catalog on its own.
//
// Checked against the raw records, not the normalised entries: applyShows joins
// all three onto every entry in memory, so a normalised entry always agrees and
// would report nothing.
const showKey = (id) => String(id || "").replace(/-\d+$/, "") || String(id || "");

let showRows = {};
const SHOWS = join(ROOT, "data", "shows.json");
if (existsSync(SHOWS)) {
  try {
    showRows = JSON.parse(readFileSync(SHOWS, "utf8").replace(/^﻿/, "")).shows || {};
  } catch (err) {
    say(`could not read ${SHOWS}: ${err.message} — clip copies cannot be checked against it`);
  }
}

const drifted = [];
for (const r of raw) {
  if (!r || typeof r !== "object") continue;
  const row = showRows[showKey(r.id)];
  // A clip with no row is not drift: the app renders it from the values on the
  // clip, and set-locations.mjs scaffolds a row for every show in the catalog.
  if (!row) continue;
  const fields = ["date", "venue", "location"].filter((f) => {
    const want = typeof row[f] === "string" ? row[f].trim() : "";
    return want && String(r[f] ?? "").trim() !== want;
  });
  if (fields.length) drifted.push(`${r.id} ${fields.join("/")} (${r.venue || "—"}, ${r.location || "—"})`);
}
say(`clips whose date/venue/location disagree with shows.json ${drifted.length}: ${sample(drifted)}`);
if (drifted.length) say("  run `node tools/set-locations.mjs` to bring the copies back in line");

/* ---------- summary ---------- */

// Two different things are counted apart. A grouping problem means the clip
// model itself is inconsistent — clips that cannot be told apart or ordered.
// A data problem means the checkout or the file disagrees with the layout the
// rest of the project assumes. Only the first is something this feature broke.
const grouping = disagreeing.length + duplicated.length;
const data = missingFiles.length + drifted.length;
say(`grouping problems ${grouping}, data problems ${data}`);
if (!grouping && multi.length) {
  say("order of the first group:", multi[0].clips.map((c) => `${c.clipIndex}:${c.id}`).join(" , "));
}
