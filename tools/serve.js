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
import { createReadStream, statSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

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
