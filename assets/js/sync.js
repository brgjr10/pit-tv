/*
 * sync.js — keep shows.json in step with catalog.json without asking.
 *
 * The catalog is the source of truth: every clip in it belongs to a show, and
 * the show's clip count and artist roster are derived from the catalog, not
 * typed in by hand. This module rewrites shows.json from the catalog whenever
 * the two disagree, so a refresh is never needed after adding clips.
 *
 * Missing album art is reported as a toast rather than silently rendered as a
 * placeholder card — the UI already falls back to initials, but the editor
 * should know which entries still need a cover.
 */

const SHOWS_URL = "data/shows.json";

/** Derive the show key from a catalog id: "korn-2017-04" -> "korn-2017". */
export function showKeyFor(id) {
  return String(id || "").replace(/-\d+$/, "") || String(id || "");
}

/**
 * Build a fresh shows.json document from a loaded catalog plus whatever was
 * already on disk. Date, venue and location are preserved from the existing
 * row; _clips and _artists are always recomputed from the catalog.
 *
 * @returns {{ doc: object, changed: boolean, missingArt: Array }}
 */
export function reconcileShows(catalog, existingShowsDoc) {
  const shows = {};
  if (existingShowsDoc && typeof existingShowsDoc === "object") {
    const existing = existingShowsDoc.shows;
    if (existing && typeof existing === "object") {
      for (const [key, row] of Object.entries(existing)) {
        // A null row is corruption, not a partial row: { ...null } would revive it
        // as {} and let the computed fields below redecorate it, so drop the key
        // and let the catalog rebuild it (or leave it absent) instead.
        if (row && typeof row === "object" && !Array.isArray(row)) {
          shows[key] = { ...row };
        }
      }
    }
  }

  // Clip counts and artist rosters, straight from the catalog.
  const byShow = new Map();
  for (const entry of catalog) {
    const key = showKeyFor(entry.id);
    let info = byShow.get(key);
    if (!info) {
      info = { clips: 0, artists: new Set() };
      byShow.set(key, info);
    }
    info.clips++;
    info.artists.add(entry.artist);
  }

  let changed = false;
  const existingKeys = new Set(Object.keys(shows));

  // Drop shows with no clips, update counts/artists for the rest.
  for (const key of existingKeys) {
    const info = byShow.get(key);
    if (!info) {
      delete shows[key];
      changed = true;
      continue;
    }
    const row = shows[key];
    const artists = [...info.artists].sort();
    if (row._clips !== info.clips) { row._clips = info.clips; changed = true; }
    if (!arraysEqual(row._artists, artists)) { row._artists = artists; changed = true; }
  }

  // Add shows that exist in the catalog but not in shows.json.
  for (const [key, info] of byShow) {
    if (shows[key]) continue;
    const first = catalog.find((e) => showKeyFor(e.id) === key);
    shows[key] = {
      date: first.date,
      venue: first.venue,
      location: first.location,
      _clips: info.clips,
      _artists: [...info.artists].sort(),
    };
    changed = true;
  }

  const doc = { shows };
  return { doc, changed, missingArt: findMissingArt(catalog) };
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function findMissingArt(catalog) {
  return catalog
    .filter((e) => !e.albumArt)
    .map((e) => ({ id: e.id, artist: e.artist, song: e.song }));
}

/**
 * Read the on-disk shows.json; returns null if it cannot be read. */
export async function readShows() {
  try {
    const res = await fetch(SHOWS_URL, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Lock so a catalog save and a clip-reorder save cannot race. Both POST to
 * /api/catalog, and the server re-reads the file on every call, so a save that
 * lands first is never silently reverted by one that started first.
 */
let writeLock = Promise.resolve();
export function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => undefined, () => undefined);
  return next;
}