/*
 * tools/set-locations.mjs — maintain data/shows.json, the home of show data.
 *
 * date, venue and location describe a show, not each of the clips in it, so they
 * live once per show here and the app joins them in by show id at load time
 * (see applyShows in assets/js/catalog.js). This tool writes only shows.json,
 * unless --prune-show-fields is given (one-shot migration, see PIT-TV-018).
 *
 * The catalog is the only place the list of shows comes from, so every run
 * rebuilds the rows from it: a show added to the catalog appears here by itself,
 * and any value already typed is carried over.
 *
 *   node tools/set-locations.mjs                  # sync the file and report gaps
 *   node tools/set-locations.mjs --dry-run        # same, writing nothing
 *   node tools/set-locations.mjs --list           # print the shows and exit
 *   node tools/set-locations.mjs --prune-show-fields  # strip date/venue/location from the catalog
 *
 *   # set values for one show, a glob, or every show
 *   node tools/set-locations.mjs --show='mgk-*' --date='2018-12-22' \
 *                                --venue='Wolstein Center' --location='Cleveland, OH'
 *
 *   # every show shot on a given night
 *   node tools/set-locations.mjs --show='date:2023-09-16' --venue='...'
 *
 *   # blank a field again
 *   node tools/set-locations.mjs --show='korn-2017' --clear --venue
 *
 * Options:
 *   --show=<key>      folder key, glob ("mgk-*"), "date:YYYY-MM-DD", or "all"
 *   --date=<text>     show date, YYYY-MM-DD
 *   --venue=<text>    venue name, e.g. an arena
 *   --location=<text> city/region, shown as the "Location" column
 *   --clear           blank the named fields (--venue, --location, --date) instead of setting them
 *   --dry-run         print what would change, write nothing
 *   --list            print the shows and exit
 *   --config=<path>   use a different config file
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = join(ROOT, "data", "catalog.json");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const val = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = has("dry-run");
const LIST = has("list");
const CLEAR = has("clear");
const CONFIG = resolve(ROOT, val("config") || "data/shows.json");
const SELECTOR = val("show");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- reading ---------- */

/**
 * Read a JSON file, tolerating a byte-order mark.
 *
 * shows.json is a file people open in Notepad and edit by hand, and plenty of
 * Windows tooling (Set-Content -Encoding utf8, Excel exports) writes one. A BOM
 * is legal in a JSON file per RFC 8259, so a plain JSON.parse would reject a
 * file the user believes they saved correctly.
 */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

/** A show is a video folder, so the clip counter is the last part of the id. */
const showKeyFor = (id) => String(id || "").replace(/-\d+$/, "") || String(id || "");

function indexShows(entries) {
  const shows = new Map();
  for (const entry of entries) {
    const key = showKeyFor(entry.id);
    if (!shows.has(key)) shows.set(key, { key, entries: [], artists: new Set(), dates: new Set() });
    const show = shows.get(key);
    show.entries.push(entry);
    show.artists.add(entry.artist);
  }
  return [...shows.values()].map((s) => ({ ...s, artists: [...s.artists].sort() }));
}

/* ---------- the file ---------- */

/**
 * The date to carry over from an older config.
 *
 * Dates used to live in the generated _dates note, which was rewritten from the
 * catalog on every scaffold and so could not be edited. A row whose clips agreed
 * on a single date is promoted to the real `date` field, so dates typed into
 * that note survive the upgrade instead of being reverted.
 */
function carriedDate(was) {
  if (typeof was.date === "string") return was.date.trim();
  const single = Array.isArray(was._dates) && was._dates.length === 1 ? was._dates[0] : null;
  return single || "";
}

const scaffoldConfig = (shows, previous) => {
  const out = {
    _comment:
      "One row per show: the date, venue and location shared by every clip in it. " +
      "The app joins these onto the catalog by show id, so a value is stored once, here, " +
      "and editing it updates the whole show. Keys starting with _ are notes.",
    shows: {},
  };
  for (const show of shows) {
    const was = previous?.shows?.[show.key] || {};
    out.shows[show.key] = {
      date: carriedDate(was),
      venue: typeof was.venue === "string" ? was.venue : "",
      location: typeof was.location === "string" ? was.location : "",
      _clips: show.entries.length,
      _artists: show.artists,
    };
  }
  return out;
};

/**
 * Config rows whose show is no longer in the catalog.
 *
 * A show disappears whenever its clips are renamed or refiled — a fixed typo, a
 * re-cut folder — and rebuilding the config from the catalog would quietly throw
 * away the venue and location that were typed for it. They are carried over
 * instead, so nothing is lost and the stale row is reported.
 */
function orphanedRows(shows, previous) {
  if (!previous?.shows) return [];
  const live = new Set(shows.map((s) => s.key));
  return Object.entries(previous.shows).filter(([key]) => !live.has(key));
}

/* ---------- selecting ---------- */

const globsToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/** Resolve a --show selector to shows: an exact key, a glob, a date, or all. */
function selectShows(shows, selector) {
  if (!selector || selector.toLowerCase() === "all") return shows;
  if (selector.toLowerCase().startsWith("date:")) {
    const wanted = selector.slice(5).trim();
    return shows.filter((s) => {
      const row = current.shows[s.key];
      const date = row?.date || "";
      return date === wanted || date.startsWith(wanted);
    });
  }
  const exact = shows.filter((s) => s.key === selector);
  if (exact.length) return exact;
  const re = globsToRegExp(selector);
  return shows.filter((s) => re.test(s.key));
}

/* ---------- run ---------- */

const catalog = readJsonFile(CATALOG);
const shows = indexShows(catalog);
const previous = existsSync(CONFIG) ? readJsonFile(CONFIG) : null;

// Rebuild from the catalog so a newly added show needs no separate step, and the
// generated notes stay honest. Typed values are carried over.
const current = scaffoldConfig(shows, previous);
const orphans = orphanedRows(shows, previous);
for (const [key, row] of orphans) current.shows[key] = row;

const serialise = (value) => JSON.stringify(value, null, 2) + "\n";
const onDisk = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8").replace(/^﻿/, "") : null;
let stale = onDisk === null || serialise(current) !== onDisk;

function save() {
  if (DRY_RUN || !stale) return;
  writeJsonAtomic(CONFIG, current, { trailingNewline: true });
  stale = false;
}

function reportOrphans() {
  if (!orphans.length) return;
  console.log(`${orphans.length} row(s) kept for shows that are not in the catalog:`);
  for (const [key, row] of orphans) {
    console.log(`  ${key.padEnd(24)} ${row.date || "—"}  ${row.venue || "—"}  ${row.location || "—"}`);
  }
  console.log("  (the show was renamed or removed — re-file the clips, or delete the row)");
}

/**
 * Catalog entries that still carry their own date/venue/location.
 *
 * Show data lives in this file, so a copy on an entry is a stale duplicate that
 * will drift. The usual cause is saving catalog.json from an editor buffer that
 * was open before the values moved here, which puts them all back at once — so
 * this reports the count and where to look rather than editing the catalog
 * itself, which would be undone by the next save from that same buffer.
 */
const DUPLICATED = ["date", "venue", "location"];
function reportDuplicates() {
  const stale = catalog.filter((e) => DUPLICATED.some((f) => f in e));
  if (!stale.length) return;
  const fields = new Set();
  for (const e of stale) for (const f of DUPLICATED) if (f in e) fields.add(f);
  console.log(
    `\n${stale.length} of ${catalog.length} catalog entries still carry ${[...fields].sort().join("/")}. ` +
      "Those belong here, not on the entries."
  );
  console.log(`  First: ${stale.slice(0, 3).map((e) => e.id).join(", ")}${stale.length > 3 ? ", ..." : ""}`);
  console.log("  If data/catalog.json is open in an editor, that buffer is probably stale —");
  console.log("  close and reopen it before saving, or the duplicate values will come back.");
}

/** Shows the file does not fully cover. Every show needs all three fields. */
function reportGaps() {
  const gaps = shows.filter((s) => {
    const row = current.shows[s.key];
    return !row || !row.date || !row.venue || !row.location;
  });
  if (!gaps.length) {
    console.log(`\nAll ${shows.length} show(s) have a date, venue and location.`);
    reportDuplicates();
    return;
  }
  console.log(`\n${gaps.length} show(s) still need a date, venue or location:`);
  for (const show of gaps) {
    const row = current.shows[show.key] || {};
    const missing = [!row.date && "date", !row.venue && "venue", !row.location && "location"]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${show.key.padEnd(24)} ${String(show.entries.length).padStart(3)} clips  ` +
        `needs ${missing}  (${show.artists.join(", ")})`
    );
  }
  reportDuplicates();
}

function listShows() {
  for (const show of shows) {
    const row = current.shows[show.key] || {};
    const complete = row.date && row.venue && row.location;
    const mark = complete ? "  " : "· ";
    console.log(
      `${mark}${show.key.padEnd(24)} ${String(show.entries.length).padStart(3)} clips  ` +
        `${row.date || "—"}  ${row.venue || "—"}  ${row.location || "—"}`
    );
  }
}

/* ---- set or clear values from the command line ---- */

const cliDate = val("date");
const cliVenue = val("venue");
const cliLocation = val("location");
const named = [cliDate, cliVenue, cliLocation].filter((v) => v !== null);

// --clear with nothing named blanks all three; --clear with a named field blanks
// only that one; otherwise a named field is set to the value given.
if (SELECTOR && (named.length || CLEAR)) {
  const targets = selectShows(shows, SELECTOR);
  if (!targets.length) console.warn(`! "${SELECTOR}" matched no show`);

  for (const show of targets) {
    const row = current.shows[show.key] || { _clips: show.entries.length, _artists: show.artists };

    if (CLEAR && !named.length) {
      row.date = "";
      row.venue = "";
      row.location = "";
    }

    if (cliDate !== null) {
      if (CLEAR) row.date = "";
      else if (!cliDate) row.date = "";
      else if (!ISO_DATE.test(cliDate)) console.warn(`! --date "${cliDate}" is not YYYY-MM-DD — ignored.`);
      else row.date = cliDate;
    }

    for (const [value, field] of [
      [cliVenue, "venue"],
      [cliLocation, "location"],
    ]) {
      if (value === null) continue;
      row[field] = CLEAR ? "" : value.trim();
    }

    current.shows[show.key] = row;
  }

  const verb = DRY_RUN ? "Would set" : "Set";
  for (const show of targets) {
    const row = current.shows[show.key];
    console.log(`${verb} ${show.key}: ${row.date || "—"}  ${row.venue || "—"}  ${row.location || "—"}`);
  }
  save();
  if (!DRY_RUN) console.log(`\nWrote ${CONFIG}`);
  reportGaps();
  reportOrphans();
  process.exit(0);
}

/* ---- otherwise: sync the file and report what is missing ---- */

const PRUNE = has("prune-show-fields");

if (PRUNE) {
  // One-shot migration: strip the show-level fields that PIT-TV-018 reports as
  // duplicated, so each fact lives only in shows.json once the code's toRawEntry
  // has stopped writing them back. Writes catalog.json atomically.
  let stripped = 0;
  const pruned = catalog.map((e) => {
    let hit = false;
    for (const f of DUPLICATED) {
      if (f in e) { delete e[f]; hit = true; }
    }
    if (hit) stripped += 1;
    return e;
  });
  if (DRY_RUN) {
    console.log(`Would prune ${stripped} of ${catalog.length} entries — dry run, no changes written.`);
  } else {
    writeJsonAtomic(CATALOG, pruned, { trailingNewline: true });
    console.log(`Pruned ${stripped} of ${catalog.length} entries — date/venue/location now come from shows.json.`);
  }
  reportGaps();
  reportOrphans();
  process.exit(0);
}

/* ---- otherwise: sync the file and report what is missing ---- */

if (stale) {
  save();
  console.log(`${DRY_RUN ? "Would sync" : "Synced"} ${CONFIG} — ${shows.length} show(s) from the catalog.`);
} else if (!LIST) {
  console.log(`${CONFIG} is already up to date.`);
}

if (LIST) listShows();
else reportGaps();

reportOrphans();
