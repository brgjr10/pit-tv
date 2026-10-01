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
import { randomBytes, timingSafeEqual } from "node:crypto";

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
// The JSON routes are the other unbounded read: each request buffered the whole
// body and Buffer.concat then allocated a second copy, so a multi-GB POST was
// an OOM kill on a container with no memory limit. 4 MB is far above any
// legitimate catalog patch.
const MAX_JSON_BYTES = Number(process.env.PITTV_MAX_JSON_MB || 4) * 1024 * 1024;
// Extensions the browser can actually play (see videos/README.md "Formats").
// Anything else is refused at plan time rather than after a long transfer.
const UPLOAD_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

// Mutating routes (writes to catalog.json, shows.json, or the videos/ tree).
// The gate and the auth check are applied to this list in one place, up front,
// so a route added later cannot forget either one.
const MUTATING_ROUTES = new Set([
  "/api/sync-shows",
  "/api/catalog",
  "/api/set-show",
  "/api/fetch-covers",
  "/api/upload",
]);

// Mutating routes are ON by default for local use: this archive is a
// single-user tool, and making the write path opt-in meant the app silently
// served a read-only experience on a bare `node tools/serve.js`. Set
// PITTV_WRITE=0 to lock it down.
//
// Two boundaries, and both have to hold before a write route is safe to
// publish: HOST keeps the server off the network, and PITTV_TOKEN makes the
// mutating routes refuse anyone who has not been given the token. The compose
// file now ships with writes off, because `docker compose up` publishes the
// port to the LAN.
//   HOST=0.0.0.0 PITTV_WRITE=0                 read-only on the LAN
//   HOST=0.0.0.0 PITTV_WRITE=1 PITTV_TOKEN=…   writable with the token
const WRITE_ENABLED = process.env.PITTV_WRITE !== "0";
const WRITE_TOKEN = process.env.PITTV_TOKEN || "";

/**
 * Is this request allowed to mutate the archive?
 *
 * With no PITTV_TOKEN set the server is assumed to be loopback-only, which is
 * the default and matches the bare `node tools/serve.js` workflow. Once a token
 * is configured, or the server is bound to a non-loopback interface, the token
 * is required — an empty/absent header must never be treated as a match.
 */
function isAuthorised(req) {
  if (!WRITE_TOKEN && HOST === "127.0.0.1") return true;
  if (!WRITE_TOKEN) return false;
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-pittv-token"] || "");
  const a = Buffer.from(String(presented));
  const b = Buffer.from(WRITE_TOKEN);
  // timingSafeEqual throws on a length mismatch, and the length itself is not a
  // secret, so compare lengths first and then constant-time the contents.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read and parse a JSON body, capped at MAX_JSON_BYTES.
 *
 * Answers 413 or 400 itself and returns undefined when it does, so the caller
 * can simply `return` — three routes had their own unbounded copy of this.
 */
async function readJsonBody(req, res) {
  const chunks = [];
  let size = 0;
  let over = false;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        // Stop reading and answer rather than buffering the rest. `pause` rather
        // than destroying the request: destroying it would reset the socket, and
        // the response would race the reset on the client's keep-alive pool.
        over = true;
        req.pause();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });

  if (over) {
    res.writeHead(413, {
      "Content-Type": "application/json; charset=utf-8",
      Connection: "close",
    });
    res.end(JSON.stringify({ ok: false, error: `request body is over the ${MAX_JSON_BYTES} byte cap` }));
    return undefined;
  }

  const body = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(body);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `bad request body: ${err.message}` }));
    return undefined;
  }
}

// Children spawned by the tool routes, so shutdown can take them with us.
const children = new Set();
// One cover fetch at a time: concurrent runs race on catalog.json.
let coverFetch = null;


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
function spawnChild(args, { timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", args, {
      cwd: ROOT,
      shell: false,
      // A cover fetch fans out to many HTTP requests and can legitimately take
      // minutes, but it must not be able to run forever: past the timeout it is
      // asked to stop rather than accumulating output and rewriting the catalog
      // while the operator has given up waiting for it.
      timeout,
      killSignal: "SIGTERM",
    });
    children.add(child);
    let out = "";
    let err = "";
    // Capped: a runaway child that printed without bound used to be an
    // unbounded-memory path on a route anyone could hit.
    const append = (acc, d) => (acc.length < 64_000 ? acc + d.toString() : acc);
    child.stdout.on("data", (d) => (out = append(out, d)));
    child.stderr.on("data", (d) => (err = append(err, d)));
    const done = (result) => {
      children.delete(child);
      resolve(result);
    };
    child.on("error", (err2) => done({ ok: false, code: null, stdout: "", stderr: err2.message }));
    child.on("close", (code, signal) =>
      done(signal === "SIGTERM"
        ? { ok: false, code, stdout: out, stderr: `${err.trim()}\nstopped: exceeded the ${timeout}ms budget`.trim() }
        : { ok: code === 0, code, stdout: out, stderr: err }));
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
  // One run at a time. Two concurrent fetches each rewrite catalog.json and
  // artist-ids.json, so they race and the last one wins — including losing the
  // cover work the other run had already downloaded.
  if (coverFetch) return { ok: false, code: null, stdout: "", stderr: "a cover fetch is already running — wait for it to finish" };
  coverFetch = spawnChild(["tools/fetch-album-art.mjs"]);
  try {
    return await coverFetch;
  } finally {
    coverFetch = null;
  }
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
 *
 * Returns the ids it had to renumber. apiCatalogPatch folds them into the same
 * `conflicts` array it reports stale `changes` ids in, so a client that
 * catalogues the id it sent back learns that the id actually used differs.
 * The array used to be declared and never written to, so renames were silent.
 */
function resolveIdCollisions(entries) {
  const seen = new Set(entries.map((e) => e.id).filter(Boolean));
  const renames = [];
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
    renames.push({ requested: base, assigned: entry.id });
  }
  return renames;
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
  const renames = resolveIdCollisions(safeAppends);
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
    // Appends whose id had to be renumbered, so a client that cached an id is
    // told the id it will actually find on disk.
    renames,
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
    // Dot runs are collapsed rather than kept: resolveUploadPath rejects any
    // path containing "..", so a performance name like "MGK Day 1..5" used to
    // plan cleanly and then fail at the PUT with an error that named neither
    // the field nor the cause — after the slowest part of the flow.
    .replace(/\.{2,}/g, ".")
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
  const planPath = `catalog/${folder}/${filename}`;

  // The plan must hand back a path the PUT will accept: a 200 here promises the
  // transfer can proceed, so verify it now rather than after a multi-gigabyte
  // transfer. This is the single place a future divergence in either
  // sanitizer shows up as a 400 instead.
  const planCheck = resolveUploadPath(planPath);
  if (planCheck.error) {
    return { ok: false, error: `the chosen destination cannot be stored: ${planCheck.error}` };
  }

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
    path: planPath,
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
  const { error, full: requested, ext, dir } = resolveUploadPath(url.searchParams.get("path"));
  if (error) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error }));
    return;
  }

  // Re-resolve the filename at commit time, not just at plan time. The plan may
  // be minutes old, and the PUT is reachable on its own, so the .part-then-
  // rename was overwriting an existing catalogued clip in place with no backup —
  // exactly what uniqueFilename's own comment says must never happen. The
  // response reports the path actually written, so the client catalogues what
  // is really on disk.
  const filename = uniqueFilename(dir, basename(requested));
  const full = join(dir, filename);
  // The .part path must derive from `full`, not from the requested path, or the
  // two disagree and the rename fails.
  const partPath = `${full}.${ext.slice(1)}.part`;

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `file is over the ${formatBytes(MAX_UPLOAD_BYTES)} cap` }));
    return;
  }

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

/**
 * Parse a single-range `Range: bytes=…` header against a known file size.
 *
 * Returns { start, end } for a satisfiable range, or null for anything that is
 * not one well-formed numeric range (malformed, multi-range, inverted, or
 * past the end of the file). Callers answer 416 for null.
 *
 * The old parser was `range.replace(/bytes=/, "").split("-")` with no
 * validation: "bytes=abc-def" gave end=NaN, and createReadStream then threw
 * inside the async request handler, which became an unhandled rejection and
 * killed the process on a single unauthenticated request. The same parser also
 * read "bytes=-20" as 0-20 and served the head of the file instead of the
 * tail. RFC 7233 allows exactly the two forms handled here; multi-range is
 * refused rather than guessed at, because guessing is what caused the crash.
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const fromRaw = m[1];
  const toRaw = m[2];
  if (fromRaw === "" && toRaw === "") return null;

  let start;
  let end;
  if (fromRaw === "") {
    // Suffix form: the last N bytes. A suffix longer than the file is the whole
    // file, per RFC 7233 — the start clamps at 0 rather than going negative.
    const suffix = Number(toRaw);
    if (!Number.isInteger(suffix)) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(fromRaw);
    end = toRaw === "" ? size - 1 : Number(toRaw);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > size - 1) end = Math.min(end, size - 1);
  if (start < 0 || start > end || start >= size) return null;
  return { start, end };
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    // Nothing in the request path is allowed to take the process down, so the
    // handler's promise is always observed and a failure becomes a 500.
    console.error(`[serve] ${req.method} ${req.url} failed: ${err.stack || err.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  // ---- write gate and auth, checked once for every mutating route ----
  // Hoisted to the top of the handler because the per-route gate missed the
  // two routes that spawn a child process, so PITTV_WRITE=0 did not stop them
  // rewriting shows.json and catalog.json. A route added now cannot forget.
  if (MUTATING_ROUTES.has(pathname) || pathname.startsWith("/api/upload/")) {
    if (!WRITE_ENABLED) {
      // resume() first: answering without consuming the body leaves unread
      // bytes in the socket, and the next keep-alive request on that connection
      // is parsed as the tail of this one.
      req.resume();
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: false,
        error: `writes are disabled: set process.env.PITTV_WRITE='1' (writes are on unless PITTV_WRITE=0) to enable ${pathname}`,
      }));
      return;
    }
    if (!isAuthorised(req)) {
      req.resume();
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": 'Bearer realm="pit-tv"',
      });
      res.end(JSON.stringify({
        ok: false,
        error: "unauthenticated: this port can rewrite the catalog and the video library. Set process.env.PITTV_TOKEN, or bind HOST=127.0.0.1.",
      }));
      return;
    }
  }

  // ---- admin API, before any file resolution ----
  if (pathname === "/api/sync-shows" && req.method === "POST") {
    const result = await apiSyncShows();
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }
  if (pathname === "/api/catalog" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const result = await apiCatalogPatch(body);
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }
  if (pathname === "/api/set-show" && req.method === "POST") {
    const result = await apiSetShow(new URLSearchParams(url.search));
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  // ---- upload: plan → PUT bytes → commit ----
  if (pathname.startsWith("/api/upload")) {
    if (pathname === "/api/upload" && req.method === "PUT") {
      handleUploadPut(req, res, url);
      return;
    }
    if (pathname === "/api/upload/plan" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const result = apiUploadPlan(body);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname === "/api/upload/commit" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const result = await apiUploadCommit(body);
      res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
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
      // readJsonFile, not a bare JSON.parse: a catalog.json saved by Notepad
      // carries a BOM, which is legal in JSON per RFC 8259 and which every
      // other reader in this codebase already tolerates.
      const catalog = readJsonFile(CATALOG_PATH);
      const status = apiFetchStatus(Array.isArray(catalog) ? catalog : []);
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
  // An ETag from mtime+size gives `no-cache` something to revalidate against,
  // which is what turns a seek on a multi-GB clip into a 304 instead of a
  // re-transfer of the same bytes.
  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": type,
    "Content-Length": stats.size,
    // The service worker must be allowed to update while developing.
    "Cache-Control": "no-cache",
    "ETag": etag,
    "Last-Modified": stats.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // The app serves user-authored JSON from this same origin, so a CSP that
    // pins scripts and styles to self is the backstop for any escaping mistake.
    // `unsafe-inline` is still needed for the inline bootstrap script and the
    // inline onerror handler in index.html / ui.js.
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' https: blob:; " +
      "script-src 'self' 'unsafe-inline' https://www.youtube.com https://player.vimeo.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self'; frame-src https://www.youtube.com https://player.vimeo.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
  if (filePath.endsWith("sw.js")) headers["Service-Worker-Allowed"] = "/";

  if (req.method !== "GET" && req.method !== "HEAD") {
    // Anything else answered 200 with the real Content-Length and an empty body,
    // which desynchronises a keep-alive connection and tells clients a DELETE
    // succeeded when nothing was touched.
    req.resume();
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  if (req.headers["if-none-match"] === etag && !req.headers.range) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  // Range support so <video> can seek local files.
  const range = req.headers.range;
  if (range) {
    const parsed = parseRange(range, stats.size);
    if (!parsed) {
      res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      res.end();
      return;
    }
    const { start, end } = parsed;
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${stats.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    pipeFile(filePath, { start, end }, res);
    return;
  }

  res.writeHead(200, { ...headers, "Accept-Ranges": "bytes" });
  pipeFile(filePath, {}, res);
}

/**
 * Stream a file to the response without letting a mid-read failure take the
 * process down. Once the headers are out the status cannot change, so the
 * only honest thing left is to cut the connection and log what happened.
 */
function pipeFile(filePath, options, res) {
  let stream;
  try {
    stream = createReadStream(filePath, options);
  } catch (err) {
    console.error(`[serve] open ${filePath} failed: ${err.message}`);
    res.destroy();
    return;
  }
  stream.on("error", (err) => {
    console.error(`[serve] read ${filePath} failed: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

// A crash here is a bug in this server, not a reason to take the archive
// offline for everyone on the LAN. Log it loudly and keep serving: the
// alternative is a single-request denial of service (which is exactly how the
// malformed-Range bug presented).
process.on("unhandledRejection", (err) => {
  console.error(`[serve] unhandled rejection: ${(err && err.stack) || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[serve] uncaught exception: ${(err && err.stack) || err}`);
});

server.listen(PORT, HOST, async () => {
  console.log(`PIT TV serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  const MUTATING_LABEL = "/api/sync-shows, /api/catalog, /api/set-show, /api/fetch-covers, /api/upload/*";
  if (WRITE_ENABLED) {
    // Writes are the normal case locally, so say only what the operator needs
    // to change it: the routes are live, PITTV_WRITE=0 turns them off, and the
    // auth story depends on whether a token is configured.
    console.log(`  [write] mutating routes (${MUTATING_LABEL}) are ON — set PITTV_WRITE=0 to disable`);
    if (HOST === "0.0.0.0") {
      if (!WRITE_TOKEN) {
        console.log("  [write] WARNING: HOST=0.0.0.0 with writes on and no PITTV_TOKEN — anyone who can reach this port can rewrite the catalog and the video library.");
        console.log("  [write]          Set PITTV_WRITE=0 for a read-only server, or PITTV_TOKEN=<secret> and send `Authorization: Bearer <secret>`.");
      } else {
        console.log("  [write] HOST=0.0.0.0 — writes require the PITTV_TOKEN bearer token.");
      }
    }
  } else {
    // The app still loads and browses, but every mutating route answers 403. The
    // client falls back to its download path and tells the user why.
    console.log(`  [write] mutating routes (${MUTATING_LABEL}) are OFF — set PITTV_WRITE=1 to enable`);
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

/**
 * Stop accepting connections, let in-flight requests finish, then take the
 * tool children down with us. Without this a `docker compose stop` during an
 * upload or a cover fetch orphans the child and leaves it writing files after
 * the server it belongs to is gone.
 */
function shutdown() {
  console.log("\n[serve] shutting down");
  server.close(() => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
