/*
 * catalog.js — load, validate and normalise data/catalog.json.
 *
 * The catalog is user-editable JSON, so every field is treated as untrusted:
 * missing fields are defaulted, bad entries are reported instead of thrown, and
 * the good ones still render. A partial catalog is far more useful than a blank
 * page.
 */

import { setStatus, setCatalog, setFacets, state, setRawCatalog } from "./store.js";
import { reconcileShows } from "./sync.js";
import { countFacets } from "./search.js";

const CATALOG_URL = "data/catalog.json";
const FALLBACK_URL = "catalog.json";
const SHOWS_URL = "data/shows.json";

/* ---------- validation ---------- */

// The allowlists for metadata.quality and metadata.source. normaliseEntry drops
// anything outside them, so the upload form populates its selects from these
// rather than keeping a second copy that could drift.
export const QUALITY_ORDER = ["4K", "1080p", "720p", "480p"];
export const SOURCE_VALUES = ["pro-shot", "audience", "broadcast", "soundboard", "archive"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

const toInt = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const isDigits = (s) => /^\d+$/.test(s);

/**
 * The on-disk field set for a catalog entry.
 *
 * normaliseEntry adds keys the file does not carry — datePrecision (derived),
 * dateRaw (a copy of the raw input), a defaulted "Unknown venue", an empty
 * songs array. Writing those back would bake normalised defaults into every
 * entry and re-introduce the date/venue/location copies the shows.json split
 * was built to remove. This list is the inverse: the fields a raw record is
 * allowed to hold. Anything else is dropped when projecting an edit back.
 */
const RAW_ENTRY_KEYS = [
  "id",
  "artist",
  "song",
  "songId",
  "clipIndex",
  "album",
  "venue",
  "date",
  "location",
  "video",
  "songs",
  "albumArt",
  "tags",
  "metadata",
  "chapters",
  "note",
];

/**
 * Project a normalised entry back onto the on-disk field set.
 *
 * Used by edit.js to build the `changes` patch for /api/catalog: only the
 * fields the user actually touched are sent, and only the ones the file is
 * allowed to carry. `datePrecision` is always dropped (it is derived from
 * `date`), and `songs` is dropped when empty so a save never writes an
 * empty array onto an entry that had none.
 */
export function toRawEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  for (const key of RAW_ENTRY_KEYS) {
    if (!(key in entry)) continue;
    const value = entry[key];
    if (key === "songs" && (!Array.isArray(value) || !value.length)) continue;
    out[key] = value;
  }
  return out;
}

/** Accepts "3:45", "1:02:03" or a number of seconds. */
export function parseDuration(value) {
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  if (!isNonEmptyString(value)) return 0;
  if (/^\d+$/.test(value.trim())) return toInt(value.trim());
  const parts = value.trim().split(":");
  // Every component must be a plain run of digits — toInt silently coerces
  // non-numeric input to 0, which would mask bad values.  Cap at 3 parts so
  // "1:2:3:4" is rejected instead of reduced into a nonsense value.
  if (parts.length > 3 || !parts.every(isDigits)) return 0;
  // Every component after the first (minutes, seconds) must be 0-59.
  for (let i = 1; i < parts.length; i += 1) {
    if (Number(parts[i]) > 59) return 0;
  }
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return "--:--";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * "2024-06-15" -> "15 Jun 2024". Year-precision dates render as the bare year
 * instead of inventing a day. Returns the raw string if unparseable.
 */
export function formatDate(iso, precision = "day") {
  if (!isNonEmptyString(iso)) return "Unknown date";
  if (precision === "year") return iso.slice(0, 4) || iso;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// The Date constructor silently rolls 2016-02-31 to March 2, so a regex match
// is not enough — we must confirm the components survive a UTC round-trip
// unchanged.  This rejects impossible calendar dates without inventing one.
const dateRoundTrips = (y, m, d) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

/**
 * Parse a catalog date into a sortable key plus its precision.
 *
 * A bare year is accepted: an archive of shows remembered only by the season
 * still has to sort, filter and group by year, so "2016" becomes "2016-01-01"
 * and is tagged year-precision so it is never displayed as a specific day.
 */
export function parseDate(value) {
  if (!isNonEmptyString(value)) return { iso: "", precision: "" };
  const raw = value.trim();
  const year = raw.match(/^(\d{4})$/);
  if (year) return { iso: `${year[1]}-01-01`, precision: "year" };
  const day = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!day) return { iso: "", precision: "" };
  const y = +day[1];
  const m = +day[2];
  const d = +day[3];
  // Month 1-12 and day 1-31 are necessary but not sufficient — February has
  // no 30th, and leap years must be respected — so the round-trip check above
  // rejects 2016-02-31, 2023-02-29, etc.
  if (m < 1 || m > 12 || d < 1 || d > 31 || !dateRoundTrips(y, m, d)) {
    return { iso: "", precision: "" };
  }
  return { iso: `${day[1]}-${day[2]}-${day[3]}`, precision: "day" };
}

function slugify(value, fallback) {
  const s = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/**
 * Turn one raw catalog record into a normalised entry.
 * Returns { entry } on success, { error } for an unusable record, plus any
 * non-fatal `problems` (a malformed song is skipped, the show still renders).
 */
export function normaliseEntry(raw, index, seenIds) {
  const where = `entry #${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${where}: not an object` };
  }
  if (!isNonEmptyString(raw.artist)) return { error: `${where}: missing "artist"` };
  // "song" may be empty — the edit UI fills it in later — but it must be a string.
  if (typeof raw.song !== "string") return { error: `${where}: "song" must be a string` };

  const video = raw.video && typeof raw.video === "object" ? raw.video : {};
  const { iso: dateIso, precision: datePrecision } = parseDate(raw.date);
  // "2016" reads better inside a generated id than "2016-01-01".
  const dateKey = dateIso ? (datePrecision === "year" ? dateIso.slice(0, 4) : dateIso) : "";

  // IDs must be unique; duplicate or missing ids are repaired rather than fatal.
  let id = isNonEmptyString(raw.id) ? raw.id.trim() : "";
  if (!id) {
    id = `${slugify(raw.artist, "artist")}-${dateKey || "nodate"}-${slugify(raw.song, "track")}`;
  }
  if (seenIds.has(id)) {
    const base = id;
    let n = 2;
    while (seenIds.has(`${base}-${n}`)) n += 1;
    id = `${base}-${n}`;
  }
  seenIds.add(id);

  // songId and clipIndex are the clip-grouping keys. They are derived here so
  // every entry carries them in memory, but they are only persisted when the
  // user reorders a group (Feature A) or re-saves the entry (Feature C) — the
  // existing 198-entry catalog groups correctly with zero edits because the
  // ids were already built as <showKey>-<NN>.
  const showKey = showKeyFor(id);
  const songId = isNonEmptyString(raw.song) ? `${showKey}-${slugify(raw.song, "song")}` : "";
  // The clip number is the -N suffix of the id ("mgk-xmas-2017-04" -> 3);
  // when there is no suffix the entry is a singleton and falls back to its
  // index in the file, which is what an unnumbered entry would have been.
  const suffix = id.match(/-(\d+)$/);
  const clipIndex = suffix ? parseInt(suffix[1], 10) - 1 : index;

  // A show is playable either as one video or as a setlist of them, so a missing
  // "video" is only fatal when there are no songs to fall back on.
  const { songs, problems } = normaliseSongs(raw.songs, id);
  if (!isNonEmptyString(video.src) && !songs.length) {
    return { error: `${where} (${raw.artist} — ${raw.song}): needs "video.src" or a "songs" setlist` };
  }

  const src = isNonEmptyString(video.src) ? video.src.trim() : "";
  // A setlist-only show has no file of its own, so it carries no source type
  // either — the "video type" facet skips it rather than claiming "local".
  const type = src ? (video.type === "local" || video.type === "cloud" ? video.type : inferType(src)) : "";
  const quality = QUALITY_ORDER.includes(raw.metadata?.quality) ? raw.metadata.quality : "";

  return {
    problems,
    entry: {
      id,
      showKey,
      songId,
      clipIndex,
      artist: raw.artist.trim(),
      song: raw.song.trim(),
      album: isNonEmptyString(raw.album) ? raw.album.trim() : "",
      venue: isNonEmptyString(raw.venue) ? raw.venue.trim() : "Unknown venue",
      date: dateIso,
      dateRaw: isNonEmptyString(raw.date) ? raw.date.trim() : "",
      datePrecision,
      location: isNonEmptyString(raw.location) ? raw.location.trim() : "",
      video: {
        type,
        src,
        poster: isNonEmptyString(video.poster) ? video.poster.trim() : "",
        duration: parseDuration(video.duration),
      },
      songs,
      albumArt: isNonEmptyString(raw.albumArt) ? raw.albumArt.trim() : "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(isNonEmptyString).map((t) => t.trim()) : [],
      metadata: {
        quality,
        source: SOURCE_VALUES.includes(raw.metadata?.source) ? raw.metadata.source : "",
        audio: isNonEmptyString(raw.metadata?.audio) ? raw.metadata.audio : "",
      },
      chapters: normaliseChapters(raw.chapters),
    },
  };
}

/**
 * Normalise a show's setlist.
 *
 * Each song is a video plus the label to show for it, and carries its own id so
 * the player can keep a separate resume position per song. A song without a
 * usable title or source is dropped and reported; the rest of the setlist stays.
 */
function normaliseSongs(rawSongs, showId) {
  if (!Array.isArray(rawSongs)) return { songs: [], problems: [] };

  const problems = [];
  const songs = [];
  const seen = new Set();

  rawSongs.forEach((raw, i) => {
    const where = `song #${i + 1} of ${showId}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${where}: not an object`);
      return;
    }

    const title = isNonEmptyString(raw.title) ? raw.title.trim() : isNonEmptyString(raw.song) ? raw.song.trim() : "";
    if (!title) {
      problems.push(`${where}: missing "title"`);
      return;
    }

    const video = raw.video && typeof raw.video === "object" ? raw.video : {};
    if (!isNonEmptyString(video.src)) {
      problems.push(`${where} (${title}): missing "video.src"`);
      return;
    }

    let id = isNonEmptyString(raw.id) ? raw.id.trim() : `${showId}-${slugify(title, "song")}`;
    if (seen.has(id)) {
      const base = id;
      let n = 2;
      while (seen.has(`${base}-${n}`)) n += 1;
      id = `${base}-${n}`;
    }
    seen.add(id);

    songs.push({
      id,
      title,
      number: songs.length + 1,
      video: {
        type: video.type === "local" || video.type === "cloud" ? video.type : inferType(video.src),
        src: video.src.trim(),
        poster: isNonEmptyString(video.poster) ? video.poster.trim() : "",
        // A duration is the one field people naturally write beside the title
        // rather than inside the video object, so accept either spelling.
        duration: parseDuration(video.duration ?? raw.duration),
      },
      albumArt: isNonEmptyString(raw.albumArt) ? raw.albumArt.trim() : "",
      chapters: normaliseChapters(raw.chapters),
    });
  });

  return { songs, problems };
}

/**
 * The playable rows of a show, in order.
 *
 * A show with a full-set file and a setlist keeps both: the entry's own video
 * comes first, then each song. A show with only one of the two is unaffected.
 */
export function setlistFor(entry) {
  const rows = [];
  if (entry.video?.src) rows.push({ id: entry.id, title: "Full show", song: null });
  for (const song of entry.songs || []) rows.push({ id: song.id, title: song.title, song });
  return rows;
}

/**
 * Merge a setlist row into its show so the player can treat it as an entry:
 * same shape, its own id, video, art and chapters. Returns the entry unchanged
 * when there is no song (a show that is just one video).
 */
export function playableEntry(entry, song) {
  if (!song) return entry;
  return {
    ...entry,
    id: song.id,
    song: song.title,
    showId: entry.id,
    albumArt: song.albumArt || entry.albumArt,
    video: song.video,
    chapters: song.chapters,
  };
}

function normaliseChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters
    .map((c) => ({
      time: parseDuration(c?.time ?? c?.start ?? 0),
      title: isNonEmptyString(c?.title) ? c.title.trim() : "",
    }))
    .filter((c) => c.title && c.time > 0)
    .sort((a, b) => a.time - b.time);
}

function inferType(src) {
  return /^(https?:)?\/\//i.test(src) || /^file:/i.test(src) ? "cloud" : "local";
}

/* ---------- shows ---------- */

/**
 * A show is a video folder, so the clip counter is the last part of the id.
 * This is the join key between a catalog entry and its row in shows.json.
 */
export function showKeyFor(id) {
  return String(id || "").replace(/-\d+$/, "") || String(id || "");
}

/** Read shows.json into a key -> { date, venue, location } map. */
function normaliseShows(raw) {
  const map = new Map();
  const gaps = [];
  if (!raw || typeof raw !== "object" || !raw.shows || typeof raw.shows !== "object") {
    return { map, gaps };
  }
  for (const [key, row] of Object.entries(raw.shows)) {
    if (!isNonEmptyString(key) || !row || typeof row !== "object") continue;
    const date = isNonEmptyString(row.date) ? row.date.trim() : "";
    const venue = isNonEmptyString(row.venue) ? row.venue.trim() : "";
    const location = isNonEmptyString(row.location) ? row.location.trim() : "";
    if (!date || !venue || !location) gaps.push(key);
    map.set(key, { date, venue, location });
  }
  return { map, gaps };
}

/**
 * Join each entry to its show.
 *
 * date, venue and location describe the show, not each of the clips in it, so
 * they live once in shows.json and are attached here. Copying them onto every
 * clip instead means the same fact is stored 47 times for one festival show and
 * a correction has to be applied 47 times to stick.
 *
 * A blank field in shows.json is left as the entry already had it, so a
 * half-filled file still renders instead of blanking the screen.
 */
function applyShows(entries, raw) {
  const { map, gaps } = normaliseShows(raw);
  const problems = [];
  const uncovered = new Set();

  for (const entry of entries) {
    const key = showKeyFor(entry.id);
    const show = map.get(key);
    if (!show) {
      uncovered.add(key);
      continue;
    }
    if (show.venue) entry.venue = show.venue;
    if (show.location) entry.location = show.location;
    if (show.date) {
      const { iso, precision } = parseDate(show.date);
      entry.date = iso;
      entry.dateRaw = show.date;
      entry.datePrecision = precision;
    }
  }

  for (const key of uncovered) problems.push(`show "${key}" has no row in ${SHOWS_URL}`);
  for (const key of gaps) problems.push(`show "${key}" is missing a date, venue or location in ${SHOWS_URL}`);
  return problems;
}

/* ---------- loading ---------- */

async function fetchJson(url) {
  // "no-store" (not "no-cache"): no-cache still sends If-Modified-Since and a
  // server that honours it answers 304 with no body, which the app cannot parse.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function loadCatalog({ url = CATALOG_URL, fallback = FALLBACK_URL } = {}) {
  let raw;
  let usedUrl = url;
  try {
    raw = await fetchJson(url);
  } catch (primaryErr) {
    if (fallback && fallback !== url) {
      try {
        raw = await fetchJson(fallback);
        usedUrl = fallback;
      } catch {
        throw primaryErr;
      }
    } else {
      throw primaryErr;
    }
  }

  if (!Array.isArray(raw)) {
    throw new Error(`${usedUrl} must contain a JSON array of entries`);
  }

  // Stash the untouched parsed document alongside the normalised entries. Edits
  // mutate the normalised entry for rendering and are projected back onto the
  // raw record by id at save time through toRawEntry, so a save can never bake
  // normalised defaults (datePrecision, an empty songs array, "Unknown venue")
  // back into entries that never had them.
  setRawCatalog(raw);

  const seenIds = new Set();
  const entries = [];
  const problems = [];
  let skipped = 0;

  raw.forEach((record, i) => {
    const result = normaliseEntry(record, i, seenIds);
    if (result.error) {
      problems.push(result.error);
      skipped += 1;
    } else {
      entries.push(result.entry);
      if (result.problems?.length) problems.push(...result.problems);
    }
  });

  if (!entries.length) {
    throw new Error(
      problems.length
        ? `No valid entries. ${problems.slice(0, 3).join("; ")}`
        : `${usedUrl} is empty`
    );
  }

  // Show data is joined in before the facets are built, so searching, sorting
  // and the venue facet all see the same values the list renders.
  let rawShows = null;
  let showsFailed = "";
  let syncResult = null;
  try {
    rawShows = await fetchJson(SHOWS_URL);
  } catch (err) {
    showsFailed = `${SHOWS_URL} could not be read (${err.message}) — shows have no date, venue or location`;
  }
  if (showsFailed) problems.push(showsFailed);
  else {
    // The catalog is the source of truth for clip counts and artist rosters.
    // Reconcile first so the file on disk matches what is actually in the
    // catalog, then join the (possibly updated) rows onto the entries.
    syncResult = reconcileShows(entries, rawShows);
    if (syncResult.changed) {
      // The reconciled doc is always applied to the entries. Writing shows.json
      // is the server's job now (/api/catalog and /api/sync-shows both run
      // set-locations.mjs), so the browser never writes it — a download here
      // would only hand the user a file to drop, and the real one stays stale.
      rawShows = syncResult.doc;
    }
    problems.push(...applyShows(entries, rawShows));
  }

  if (syncResult?.missingArt?.length) {
    problems.push(`${syncResult.missingArt.length} ${syncResult.missingArt.length === 1 ? "entry has" : "entries have"} no album art`);
  }

  // The server re-derives shows.json from the catalog on every request, so the
  // file on disk is always current after this resolves. Same deal for missing
  // covers: the server runs fetch-album-art.mjs in the background, which fills
  // what it can and rewrites catalog.json. Both are fire-and-forget — the page
  // renders from what it already has, and a later refresh picks up the results.
  // They are guarded so a repeat loadCatalog (e.g. on re-render) can't pile up
  // duplicate in-flight requests.
  triggerServerSync();
  triggerCoverFetch();

  setStatus("ready");
  setCatalog(entries);
  // Restored preferences are already in state by now, so the first sidebar
  // render has to be counted against them rather than against the bare catalog.
  setFacets(buildFacets(entries, { filters: state.filters, searchQuery: state.searchQuery }));
  return { entries, problems, skipped, url: usedUrl, sync: syncResult };
}

// Session-level guards for the fire-and-forget background syncs: a static-file
// deployment will fail these endpoints, but re-issuing them on every reload or
// render just multiplies the same expected error.  Once one has succeeded (or
// been confirmed unnecessary) it is not retried; the in-flight flag prevents
// concurrent duplicates from overlapping loadCatalog calls.
let syncInFlight = false;
let syncSucceeded = false;
let coverFetchInFlight = false;
let coverFetchSucceeded = false;

/**
 * Ask the server to re-run tools/set-locations.mjs so shows.json matches the
 * catalog on disk. The server reads the catalog itself, so this is the single
 * place that needs to know about the tool.
 */
async function triggerServerSync() {
  if (syncInFlight || syncSucceeded) return;
  syncInFlight = true;
  try {
    const res = await fetch("/api/sync-shows", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.ok && result.stdout) {
      console.info("[sync] shows.json refreshed from catalog");
      syncSucceeded = true;
    } else {
      console.warn(`[sync] /api/sync-shows responded ${res.status} but reported an issue:`, (result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" | "));
    }
  } catch (err) {
    // Not fatal — the client-side reconcile above already kept the UI honest.
    // /api/sync-shows is only served by tools/serve.js; a plain static server
    // won't implement it, so this is expected there, not a bug in the app.
    console.warn(`[sync] /api/sync-shows failed (${err.message}); served only by \`node tools/serve.js\`, static-file deployments are fine — shows.json on disk is used as-is`);
  } finally {
    syncInFlight = false;
  }
}

/**
 * Ask the server to run tools/fetch-album-art.mjs for any entries that still
 * have no albumArt. The tool downloads from Deezer/iTunes, writes the covers
 * and repoints catalog.json; the app picks the results up on the next load.
 *
 * Only kicks off when there is actually something missing, so a fully-covered
 * archive costs one cheap status check and nothing else.
 */
async function triggerCoverFetch() {
  if (coverFetchInFlight || coverFetchSucceeded) return;
  coverFetchInFlight = true;
  try {
    const res = await fetch("/api/fetch-status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    // `missing` is a count (see tools/serve.js), so coerce it once rather than
    // trusting the field directly: the guard needs a number to be falsy when
    // nothing is missing, and the log line needs a number to interpolate.
    const missingCount = Number(status?.missing) || 0;

    if (!missingCount) {
      // No missing covers — nothing to do, and don't retry the check.
      coverFetchSucceeded = true;
      return;
    }

    const res2 = await fetch("/api/fetch-covers", { method: "POST" });
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    const result = await res2.json();
    if (result.ok) {
      console.info(`[covers] background fetch started for ${missingCount} entr${missingCount === 1 ? "y" : "ies"}`);
      coverFetchSucceeded = true;
    } else {
      console.warn(`[covers] /api/fetch-covers responded ${res2.status} but reported an issue:`, (result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" | "));
    }
  } catch (err) {
    // /api/fetch-status and /api/fetch-covers are only served by tools/serve.js;
    // a plain static server won't implement them, so this is expected there.
    console.warn(`[covers] /api/fetch-status or /api/fetch-covers failed (${err.message}); served only by \`node tools/serve.js\`, static-file deployments are fine`);
  } finally {
    coverFetchInFlight = false;
  }
}

/* ---------- facets ---------- */

const facetConfig = [
  { key: "artist", get: (e) => e.artist },
  { key: "venue", get: (e) => e.venue },
  { key: "album", get: (e) => e.album },
  { key: "quality", get: (e) => e.metadata.quality },
  { key: "source", get: (e) => e.metadata.source },
  { key: "type", get: (e) => e.video.type },
];

/**
 * The sidebar's option lists, in display order, each value carrying the count
 * it has in the current context.
 *
 * Two tallies per dimension: the whole catalog decides which values exist and
 * in what order, so the list does not reshuffle as the user types and a value
 * they already picked stays on screen to untick; the context decides the number
 * beside it. Called with no context the two are the same tally, which is the
 * unfiltered sidebar.
 */
const catalogCountsCache = new WeakMap();

/**
 * The context-free tally, memoised on the entries array.
 *
 * It depends only on `entries`, so unlike the context tally it does not need
 * recomputing when the user types or changes a filter. buildFacets runs on
 * every render, and the context pass alone is already 6 dimensions over the
 * whole catalog, so recomputing an invariant pass on every keystroke is pure
 * waste. A WeakMap matches the haystackCache idiom in search.js and frees with
 * the catalog it describes.
 */
function catalogCountsFor(entries) {
  let counts = catalogCountsCache.get(entries);
  if (!counts) {
    counts = countFacets(entries, facetConfig);
    catalogCountsCache.set(entries, counts);
  }
  return counts;
}

export function buildFacets(entries, context = {}) {
  const facets = { artist: [], venue: [], album: [], quality: [], source: [], type: [] };

  const catalogCounts = catalogCountsFor(entries);
  const contextCounts = countFacets(entries, facetConfig, context);

  for (const { key } of facetConfig) {
    const counts = contextCounts.get(key);
    facets[key] = [...catalogCounts.get(key).keys()]
      .filter(isNonEmptyString)
      .map((value) => ({ value, count: counts.get(value) || 0 }))
      .sort((a, b) => (a.value === b.value ? 0 : a.value.localeCompare(b.value)));
  }

  // Quality is an ordered scale, not an alphabet.
  const qRank = (q) => {
    const i = QUALITY_ORDER.indexOf(q.value);
    return i === -1 ? QUALITY_ORDER.length : i;
  };
  facets.quality.sort((a, b) => qRank(a) - qRank(b));

  return facets;
}
