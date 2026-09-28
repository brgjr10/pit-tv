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
        if (!row || typeof row === "object" && !Array.isArray(row)) {
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
 * Write the reconciled shows.json back to disk.
 *
 * Prefers the File System Access API (writes to the real file). Falls back to
 * a download the user can drop over the real file — same shape either way.
 */
export async function writeShows(doc) {
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json" });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "shows.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { method: "filesystem" };
    } catch (err) {
      if (err.name === "AbortError") return { method: "cancelled" };
      console.warn("[sync] File System Access API failed, falling back to download", err);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shows.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { method: "download" };
}

/** Read the on-disk shows.json; returns null if it cannot be read. */
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
 * Lock so a catalog save and the shows re-sync cannot both call
 * showSaveFilePicker at the same time — two concurrent pickers are rejected
 * with "File picker already active".
 */
let writeLock = Promise.resolve();
export function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => undefined, () => undefined);
  return next;
}