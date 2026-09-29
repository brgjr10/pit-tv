/*
 * tools/serve.js — zero-dependency static server for local development.
 *
 * The app needs an HTTP origin: ES modules, fetch() of catalog.json and the
 * service worker are all blocked over file://. This is the smallest thing that
 * fixes that without pulling in a dependency.
 *
 *   node tools/serve.js [port]
 */

import { createServer } from "node:http";
import { createReadStream, createWriteStream, statSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { basename, extname, join, normalize, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
// Loopback by default: every /api/* route that mutates files is gated behind
// PITTV_WRITE anyway, but binding to 127.0.0.1 means a misconfiguration cannot
// turn the archive into a remotely writable service even if the gate is skipped.
const HOST = process.env.HOST || "127.0.0.1";
const CATALOG_PATH = join(ROOT, "data", "catalog.json");
const VIDEOS_DIR = join(ROOT, "videos");

// Upload limits. Concert video is multi-gigabyte, so the cap is generous and
// configurable rather than a token 100 MB: PITTV_MAX_UPLOAD_MB overrides it.
const MAX_UPLOAD_BYTES = Number(process.env.PITTV_MAX_UPLOAD_MB || 40960) * 1024 * 1024;
// Extensions the browser can actually play (see videos/README.md "Formats").
// Anything else is refused at plan time rather than after a long transfer.
const UPLOAD_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

// Mutating routes (writes to catalog.json, shows.json, or the videos/ tree)
// are only served when the operator explicitly opts in. A static-file build
// never sets this, so uploads and catalog saves are refused rather than
// silently 404ing — the client falls back to its download path and says so.
const WRITE_ENABLED = process.env.PITTV_WRITE === "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mpd": "application/dash+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* ---------- admin API ---------- */

/**
 * Run a child process and capture its output.
 *
 * Args are passed directly (no shell) so values with spaces or special
 * characters survive intact. The working directory is the project root, so
 * relative tool paths and relative data paths inside the tools both resolve.
 */
function spawnChild(args) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd: ROOT, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (err2) => resolve({ ok: false, code: null, stdout: "", stderr: err2.message }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
  });
}

/**
 * POST /api/sync-shows  — run tools/set-locations.mjs and return its output.
 *
 * The catalog is edited on disk (clips added, titles fixed), and shows.json is
 * the join table that the app reads at load. Every reload should re-derive it
 * from the catalog, so the app hits this endpoint instead of running the tool
 * itself. The tool is invoked as a child process so its flags, BOM handling and
 * orphan-row logic are reused rather than re-implemented here.
 */
async function apiSyncShows() {
  return spawnChild(["tools/set-locations.mjs"]);
}

/**
 * POST /api/fetch-covers  — run tools/fetch-album-art.mjs and return its output.
 *
 * Same idea: the cover-fetch tool already knows how to match, download and
 * repoint entries, so the app asks it to do its thing and reports progress.
 * `--force` is not sent: a reload should only fill what is missing.
 */
async function apiFetchCovers() {
  return spawnChild(["tools/fetch-album-art.mjs"]);
}

/**
 * GET /api/fetch-status  — how many entries still have no cover.
 *
 * Cheap to answer from the catalog itself; the app uses it to decide whether
 * to bother kicking off a fetch at all.
 */
function apiFetchStatus(catalog) {
  // `missing` is a count, not a list: the client branches on it and interpolates
  // it into a log line, so it needs to be a number. (The old literal wrote the
  // key twice — once as a count, once as an array — and the array silently won.)
  const missing = catalog.filter((e) => !e.albumArt).length;
  return { total: catalog.length, missing };
}

/**
 * Read a JSON file, tolerating a byte-order mark.
 *
 * Copied from tools/set-locations.mjs:69-71 rather than imported, because that
 * tool is a sibling script with its own ROOT and importing it would drag in
 * its argument parsing. A BOM is legal in JSON per RFC 8259, and shows.json /
 * catalog.json are both files people open in Notepad and re-save by hand.
 */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

/**
 * Resolve id collisions on append, the same way normaliseEntry does at
 * catalog.js:140-145. Two uploads landing in the same show must not fight
 * over an id; the first one wins the bare id and later ones get -2, -3, …
 */
function resolveIdCollisions(entries) {
  const seen = new Set(entries.map((e) => e.id).filter(Boolean));
  const conflicts = [];
  for (const entry of entries) {
    if (!entry.id) continue;
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      continue;
    }
    const base = entry.id;
    let n = 2;
    while (seen.has(`${base}-${n}`)) n += 1;
    entry.id = `${base}-${n}`;
    seen.add(entry.id);
  }
  return conflicts;
}

/**
 * POST /api/catalog — patch-merge the catalog from the browser.
 *
 * The client sends a *patch*, never a document:
 *   { changes: { "<id>": { field: value, … } }, appends: [ … ], removes: [ "<id>", … ] }
 *
 * On every call the handler:
 *   1. re-reads data/catalog.json from disk with a BOM-tolerant reader — another
 *      process (fetch-album-art.mjs) rewrites this file in the background, so a
 *      blind overwrite would silently clobber cover art the user waited for;
 *   2. applies removes, then appends, then changes (by entry id);
 *   3. resolves id collisions on append with the -2/-3 repair normaliseEntry uses;
 *   4. writes with writeJsonAtomic so a failure leaves the old file intact;
 *   5. runs tools/set-locations.mjs so shows.json is re-derived in the same
 *      request — exactly what /api/sync-shows already does.
 *
 * A `changes` entry whose id is no longer present is reported in `conflicts`
 * rather than silently dropped, and the UI surfaces the ids.
 */
async function apiCatalogPatch(body) {
  const patch = body || {};
  const changes = patch.changes && typeof patch.changes === "object" ? patch.changes : {};
  const appends = Array.isArray(patch.appends) ? patch.appends : [];
  const removes = Array.isArray(patch.removes) ? patch.removes : [];

  let catalog;
  try {
    catalog = readJsonFile(CATALOG_PATH);
  } catch (err) {
    return { ok: false, error: `could not re-read ${CATALOG_PATH}: ${err.message}` };
  }
  if (!Array.isArray(catalog)) {
    return { ok: false, error: `${CATALOG_PATH} must contain a JSON array of entries` };
  }

  const byId = new Map(catalog.map((e) => [e.id, e]));
  const conflicts = [];

  // 1. Removes first so an id that is being replaced is gone before appends.
  let removed = 0;
  for (const id of removes) {
    if (byId.has(id)) {
      byId.delete(id);
      removed += 1;
    }
  }

  // 2. Appends, with id collision repair.
  const safeAppends = appends
    .filter((e) => e && typeof e === "object" && !Array.isArray(e))
    .map((e) => ({ ...e }));
  resolveIdCollisions(safeAppends);
  for (const entry of safeAppends) {
    byId.set(entry.id, entry);
  }

  // 3. Changes by id. A stale id is a conflict, not a silent miss.
  let changed = 0;
  for (const [id, fields] of Object.entries(changes)) {
    const target = byId.get(id);
    if (!target) {
      conflicts.push(id);
      continue;
    }
    if (fields && typeof fields === "object") {
      for (const [key, value] of Object.entries(fields)) {
        target[key] = value;
      }
      changed += 1;
    }
  }

  const next = [...byId.values()];
  let writeError = null;
  try {
    const { writeJsonAtomic } = await import("./atomic-json.mjs");
    writeJsonAtomic(CATALOG_PATH, next, { trailingNewline: true });
  } catch (err) {
    writeError = err.message;
  }

  if (writeError) {
    return { ok: false, error: `write failed: ${writeError}` };
  }

  // 5. Re-derive shows.json in the same request so the file the app serves is
  // current before the client re-seeds its state.
  const sync = await spawnChild(["tools/set-locations.mjs"]);

  return {
    ok: true,
    changed: changed + removed + safeAppends.length,
    conflicts,
    catalog: next,
    sync: { ok: sync.ok, stdout: sync.stdout, stderr: sync.stderr },
  };
}

/**
 * POST /api/set-show?show=...&date=...&venue=...&location=...[&clear=1]
 *
 * Runs tools/set-locations.mjs with the given arguments and rewrites
 * data/shows.json. The app calls this from the edit UI so a venue or date
 * typed in the browser lands in the file the server serves.
 */
async function apiSetShow(searchParams) {
  const args = [];
  const show = searchParams.get("show");
  if (show) args.push(`--show=${show}`);
  const date = searchParams.get("date");
  if (date !== null) args.push(`--date=${date}`);
  const venue = searchParams.get("venue");
  if (venue !== null) args.push(`--venue=${venue}`);
  const location = searchParams.get("location");
  if (location !== null) args.push(`--location=${location}`);
  if (searchParams.get("clear") === "1") args.push("--clear");

  return spawnChild(["tools/set-locations.mjs", ...args]);
}

/* ---------- upload (Feature B) ---------- */

/**
 * Make one path segment safe to put on disk.
 *
 * The destination is videos/catalog/<Performance>/<filename>, and "performance"
 * is typed by a human into a free-text field, so it arrives containing "/" from
 * a pasted folder name, a colon from a drive letter, or 300 characters of a
 * tour title. Windows additionally reserves /\:*?"<>| and rejects trailing dots
 * and spaces, so those are stripped rather than left to fail at write time.
 *
 * Returns "" when the segment reduces to nothing — the caller rejects rather
 * than inventing a folder name.
 */
function sanitizeSegment(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 120)
    .trim();
}

/**
 * Lowercase, non-alphanumerics to "-", matching catalog.js:159-165 and
 * set-locations.mjs's showKeyFor consumers. The id has to survive
 * showKeyFor(id) === showId, which is what joins the entry to shows.json.
 */
function slugify(value, fallback) {
  const s = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/**
 * Accept only the two date forms set-locations.mjs understands: a full ISO
 * day, or a bare year. A bare year is expanded to Jan 1 for shows.json, which
 * is the only place the tool will accept a value at all.
 */
function normalizeShowDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { date: "" };
  const year = raw.match(/^(\d{4})$/);
  if (year) return { date: `${year[1]}-01-01` };
  const day = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!day) return { error: `date "${raw}" must be YYYY-MM-DD or YYYY` };
  const [y, m, d] = [+day[1], +day[2], +day[3]];
  const round = new Date(Date.UTC(y, m - 1, d));
  if (round.getUTCFullYear() !== y || round.getUTCMonth() !== m - 1 || round.getUTCDate() !== d) {
    return { error: `date "${raw}" is not a real calendar date` };
  }
  return { date: raw };
}

/**
 * Next free clip number for a show, as a zero-padded two-digit string.
 *
 * The existing ids are "<showKey>-<NN>" (mgk-xmas-2017-04), and showKeyFor
 * strips the trailing number, so a new clip of an existing show has to take the
 * next NN in that same series. Zero-padded to match what is already on disk;
 * the padding is cosmetic — the join is by suffix removal, not by width.
 */
function nextClipNumber(catalog, showId) {
  const re = new RegExp(`^${showId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  let max = 0;
  for (const entry of catalog) {
    if (!entry || typeof entry.id !== "string") continue;
    const m = entry.id.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (catalog.some((e) => e && e.id === `${showId}-${String(n).padStart(2, "0")}`)) n += 1;
  return String(n).padStart(2, "0");
}

/**
 * Pick a filename that does not exist yet, appending -2, -3 before the
 * extension. Overwriting is never acceptable here: the existing file is a
 * multi-gigabyte clip that is already in the catalog under its own id.
 */
function uniqueFilename(dir, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let candidate = filename;
  let n = 2;
  while (existsSync(join(dir, candidate))) {
    candidate = `${base}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/**
 * Resolve a client-supplied relative path to an absolute one inside videos/.
 *
 * The plan route is the only thing that computes a destination, but the PUT
 * takes the path back from the client, so it is validated again: no "..", no
 * separators smuggled through, and the resolved file must still be under
 * videos/. The containment check mirrors the static handler's at the bottom of
 * this file.
 */
function resolveUploadPath(relativePath) {
  const raw = String(relativePath ?? "");
  if (!raw) return { error: "path is required" };
  if (raw.includes("\0")) return { error: "path contains a null byte" };
  if (raw.includes("..")) return { error: 'path may not contain ".."' };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return { error: "path must be relative to videos/" };
  }
  const full = resolve(VIDEOS_DIR, normalize(raw));
  if (full !== VIDEOS_DIR && !full.startsWith(VIDEOS_DIR + sep)) {
    return { error: "path resolves outside videos/" };
  }
  const ext = extname(full).toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(ext)) {
    return { error: `${ext || "that file"} is not an accepted video format (${[...UPLOAD_EXTENSIONS].join(", ")})` };
  }
  return { full, ext, dir: dirname(full) };
}

/**
 * POST /api/upload/plan — decide where a file will land, before any bytes move.
 *
 * The path computation is server-side on purpose: the client cannot ask for a
 * destination outside videos/, and the id returned here is the id that will
 * actually be written, so the commit step does not have to re-derive it (and
 * cannot disagree with it).
 *
 * Body: { artist, song, album, performance, quality, source, duration,
 *         date, venue, location, filename, size, extension }
 * Returns: { ok, folder, filename, src, id, showId, songId, clipIndex, … }
 */
function apiUploadPlan(body) {
  const b = body || {};

  const artist = String(b.artist ?? "").trim();
  if (!artist) return { ok: false, error: "artist is required" };

  const filenameRaw = String(b.filename ?? "").trim();
  if (!filenameRaw) return { ok: false, error: "filename is required" };
  if (filenameRaw.includes("/") || filenameRaw.includes("\\")) {
    return { ok: false, error: "filename may not contain a path separator" };
  }
  if (filenameRaw.includes("..")) return { ok: false, error: 'filename may not contain ".."' };

  // Validate on the extension of the name the user actually chose, but write it
  // back with its original case: the existing tree mixes .MOV and .MP4, and
  // case-folding would break video.src references elsewhere.
  const ext = extname(filenameRaw);
  if (!UPLOAD_EXTENSIONS.has(ext.toLowerCase())) {
    return { ok: false, error: `${ext || "that file"} is not an accepted video format (${[...UPLOAD_EXTENSIONS].join(", ")})` };
  }
  const base = basename(filenameRaw, ext);
  const safeBase = sanitizeSegment(base);
  if (!safeBase) return { ok: false, error: "filename has no usable characters left" };

  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "size must be a positive number of bytes" };
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `file is ${formatBytes(size)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} cap — raise PITTV_MAX_UPLOAD_MB on the server to allow it` };
  }

  // Performance is the folder name; a blank one falls back to the artist so the
  // clip still lands somewhere sensible.
  const folder = sanitizeSegment(b.performance) || sanitizeSegment(artist);
  if (!folder) return { ok: false, error: "performance is empty and there is no artist to fall back to" };

  // Checked here as well as at commit: the date is a form field, and finding
  // out it is unusable after a multi-gigabyte transfer is the worst possible
  // time. The client validates first, but it cannot be the only guard.
  const dateResult = normalizeShowDate(b.date);
  if (dateResult.error) return { ok: false, error: dateResult.error };

  const dir = join(VIDEOS_DIR, "catalog", folder);
  const filename = uniqueFilename(dir, `${safeBase}${ext}`);
  const src = `videos/catalog/${folder}/${filename}`;

  let catalog = [];
  try {
    catalog = readJsonFile(CATALOG_PATH);
    if (!Array.isArray(catalog)) catalog = [];
  } catch {
    // A missing or unreadable catalog is not fatal for planning: the commit
    // step is what writes, and it re-reads and reports its own failure.
    catalog = [];
  }

  const showId = slugify(folder, "unknown-show");
  const clip = nextClipNumber(catalog, showId);
  const id = `${showId}-${clip}`;
  const song = String(b.song ?? "").trim();
  const songId = song ? `${showId}-${slugify(song, "song")}` : "";

  const duration = Number(b.duration);
  const quality = String(b.quality ?? "").trim();
  const source = String(b.source ?? "").trim();

  return {
    ok: true,
    folder,
    filename,
    // What the client PUTs to, relative to videos/.
    path: `catalog/${folder}/${filename}`,
    src,
    id,
    showId,
    songId,
    clipIndex: parseInt(clip, 10) - 1,
    artist,
    song,
    album: String(b.album ?? "").trim(),
    date: dateResult.date,
    duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0,
    quality,
    source,
  };
}

/**
 * PUT /api/upload?path=<relative path under videos/> — receive the bytes.
 *
 * The body is the raw file, not multipart: fetch() cannot report progress on a
 * File, and a multipart parser would be a lot of code for one endpoint. The
 * client uses XMLHttpRequest for that reason.
 *
 * Bytes go to a "<name>.<ext>.part" sibling and are renamed into place only
 * after the last one arrives, so an interrupted multi-gigabyte transfer leaves
 * a temp file rather than a truncated video the catalog would point at.
 */
function handleUploadPut(req, res, url) {
  const { error, full, ext, dir } = resolveUploadPath(url.searchParams.get("path"));
  if (error) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error }));
    return;
  }

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `file is over the ${formatBytes(MAX_UPLOAD_BYTES)} cap` }));
    return;
  }

  const partPath = `${full}.${ext.slice(1)}.part`;
  let received = 0;
  let settled = false;

  const fail = (status, message) => {
    if (settled) return;
    settled = true;
    try { unlinkSync(partPath); } catch { /* nothing written yet */ }
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: message }));
  };

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `could not create ${dir}: ${err.message}` }));
    return;
  }

  const out = createWriteStream(partPath);

  req.on("data", (chunk) => {
    received += chunk.length;
    // Enforce the cap on the stream as well as the header: a chunked request
    // has no content-length to check, and the declared one is only a claim.
    if (received > MAX_UPLOAD_BYTES) {
      req.destroy();
      out.destroy();
      fail(413, `upload exceeded the ${formatBytes(MAX_UPLOAD_BYTES)} cap`);
    }
  });
  out.on("error", (err) => fail(500, `write failed: ${err.message}`));
  req.on("error", (err) => {
    out.destroy();
    fail(400, `transfer interrupted after ${formatBytes(received)}: ${err.message}`);
  });
  out.on("close", () => {
    if (settled) return;
    settled = true;
    try {
      renameSync(partPath, full);
    } catch (err) {
      try { unlinkSync(partPath); } catch { /* best effort */ }
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `could not move the upload into place: ${err.message}` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, path: relative(VIDEOS_DIR, full).split(sep).join("/"), bytes: received }));
  });

  req.pipe(out);
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(n) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * POST /api/upload/commit — record the uploaded file in the catalog.
 *
 * Same discipline as /api/catalog: re-read data/catalog.json from disk (the
 * fetch-album-art tool rewrites it in the background), append, resolve id
 * collisions, write atomically, then re-derive shows.json. A date, venue or
 * location typed in the upload form goes to shows.json via set-locations.mjs,
 * never onto the entry — tools/set-locations.mjs:201-214 reports that as a bug.
 *
 * Body: the plan result plus any fields the user edited after planning.
 */
async function apiUploadCommit(body) {
  const b = body || {};
  if (!b.id || !b.src || !b.artist) {
    return { ok: false, error: "commit needs the plan result (id, src, artist)" };
  }

  const dateResult = normalizeShowDate(b.date);
  if (dateResult.error) return { ok: false, error: dateResult.error };

  let catalog;
  try {
    catalog = readJsonFile(CATALOG_PATH);
  } catch (err) {
    return { ok: false, error: `could not re-read ${CATALOG_PATH}: ${err.message}` };
  }
  if (!Array.isArray(catalog)) {
    return { ok: false, error: `${CATALOG_PATH} must contain a JSON array of entries` };
  }

  const entry = {
    id: String(b.id),
    artist: String(b.artist).trim(),
    song: String(b.song ?? "").trim(),
    songId: String(b.songId ?? ""),
    clipIndex: Number.isFinite(Number(b.clipIndex)) ? Number(b.clipIndex) : 0,
    video: {
      type: "local",
      src: String(b.src),
      duration: Number(b.duration) > 0 ? Math.floor(Number(b.duration)) : 0,
    },
  };
  if (b.songId) entry.songId = String(b.songId);
  const album = String(b.album ?? "").trim();
  if (album) entry.album = album;
  const metadata = {};
  if (b.quality) metadata.quality = String(b.quality);
  if (b.source) metadata.source = String(b.source);
  if (Object.keys(metadata).length) entry.metadata = metadata;

  // The id came from the plan, but the plan may be minutes old: another tab
  // could have taken it. Re-run the same -2/-3 repair the rest of the file uses.
  if (catalog.some((e) => e && e.id === entry.id)) {
    const base = entry.id;
    let n = 2;
    while (catalog.some((e) => e && e.id === `${base}-${n}`)) n += 1;
    entry.id = `${base}-${n}`;
  }

  const next = [...catalog, entry];

  let writeError = null;
  try {
    const { writeJsonAtomic } = await import("./atomic-json.mjs");
    writeJsonAtomic(CATALOG_PATH, next, { trailingNewline: true });
  } catch (err) {
    writeError = err.message;
  }
  if (writeError) {
    return { ok: false, error: `catalog write failed: ${writeError} — the video is on disk but not catalogued` };
  }

  // Show-level fields go to shows.json, keyed by the show half of the id.
  const showId = String(b.showId ?? String(entry.id).replace(/-\d+$/, ""));
  const sync = await spawnChild([
    "tools/set-locations.mjs",
    `--show=${showId}`,
    `--date=${dateResult.date}`,
    `--venue=${String(b.venue ?? "").trim()}`,
    `--location=${String(b.location ?? "").trim()}`,
  ]);

  return {
    ok: true,
    entry,
    show: { id: showId, ...dateResult, venue: b.venue ?? "", location: b.location ?? "" },
    sync: { ok: sync.ok, stdout: sync.stdout, stderr: sync.stderr },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  // ---- admin API, before any file resolution ----
  if (pathname === "/api/sync-shows" && req.method === "POST") {
    const result = await apiSyncShows();
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }
  if (pathname === "/api/catalog" && req.method === "POST") {
    if (!WRITE_ENABLED) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "writes are disabled: set process.env.PITTV_WRITE='1' to enable /api/catalog" }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8") || "{}";
      const result = await apiCatalogPatch(JSON.parse(body));
      res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `bad request body: ${err.message}` }));
    }
    return;
  }
  if (pathname === "/api/set-show" && req.method === "POST") {
    const result = await apiSetShow(new URLSearchParams(url.search));
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  // ---- upload: plan → PUT bytes → commit, all behind the same write gate ----
  if (pathname.startsWith("/api/upload")) {
    if (!WRITE_ENABLED) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: false,
        error: "writes are disabled: set process.env.PITTV_WRITE='1' to enable /api/upload",
      }));
      return;
    }
    try {
      if (pathname === "/api/upload" && req.method === "PUT") {
        handleUploadPut(req, res, url);
        return;
      }
      if (pathname === "/api/upload/plan" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8") || "{}";
        const result = apiUploadPlan(JSON.parse(body));
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
      if (pathname === "/api/upload/commit" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8") || "{}";
        const result = await apiUploadCommit(JSON.parse(body));
        res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `bad request: ${err.message}` }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `no such route: ${req.method} ${pathname}` }));
    return;
  }
  if (pathname === "/api/fetch-covers" && req.method === "POST") {
    const result = await apiFetchCovers();
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }
  if (pathname === "/api/fetch-status" && req.method === "GET") {
    try {
      const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));
      const status = apiFetchStatus(catalog);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  // Contain every request inside ROOT: normalise, then verify the resolved path
  // still starts with ROOT before touching the filesystem.
  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  let stats;
  try {
    stats = statSync(filePath);
    if (stats.isDirectory()) throw new Error("directory");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not found: ${pathname}`);
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  const headers = {
    "Content-Type": type,
    "Content-Length": stats.size,
    // The service worker must be allowed to update while developing.
    "Cache-Control": "no-cache",
  };
  if (filePath.endsWith("sw.js")) headers["Service-Worker-Allowed"] = "/";

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  // Range support so <video> can seek local files.
  const range = req.headers.range;
  if (range) {
    const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-");
    const start = Number(startRaw) || 0;
    const end = endRaw ? Math.min(Number(endRaw), stats.size - 1) : stats.size - 1;

    if (start >= stats.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${stats.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, "Accept-Ranges": "bytes" });
  if (req.method === "GET") createReadStream(filePath).pipe(res);
  else res.end();
});

server.listen(PORT, HOST, async () => {
  console.log(`PIT TV serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  if (!WRITE_ENABLED) {
    // Say it once, at boot, in the same tone as the startup sync line: the app
    // still loads and browses, but every mutating route answers 403. The client
    // falls back to its download path and tells the user why.
    console.log("  [write] mutating routes (/api/catalog, /api/upload/*) are OFF — set PITTV_WRITE=1 to enable");
  }

  // Re-derive shows.json from the catalog on startup so the file the app
  // serves is always current, even if the catalog was edited while the server
  // was down. The result is logged, not fatal: a bad catalog still boots.
  try {
    const result = await apiSyncShows();
    if (result.ok) {
      const tail = result.stdout.trim().split("\n").slice(-2).join(" | ");
      if (tail) console.log(`  [sync] ${tail}`);
    } else {
      console.warn(`  [sync] startup sync failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-2).join(" | ")}`);
    }
  } catch (err) {
    console.warn("  [sync] startup sync threw:", err.message);
  }
});
