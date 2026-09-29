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
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
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
