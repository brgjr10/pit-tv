/*
 * tests/serve.test.js — regression tests for the HTTP surface of tools/serve.js.
 *
 * node:test, no dependencies (node --test). Run with `npm test`.
 *
 * Every test runs against a throwaway copy of tools/ under .qa-tmp/, never the
 * real tree: ROOT is derived from the script's own location, so copying
 * tools/ into a sandbox gives the server a sandbox as its root. Brodie's
 * data/catalog.json, data/shows.json and videos/ are therefore never written
 * to, which is why the no-clobber upload test can assert real file bytes.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = join(REPO, ".qa-tmp", "serve-test");

/** An unused loopback port, so parallel runs of this file do not collide. */
function freePort() {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.on("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}

/** Build the sandbox: a root containing tools/, data/ and videos/ and nothing of Brodie's. */
function makeSandbox() {
  // force: true still throws EPERM over SMB when a handle from a previous run is
  // still open, and the failure would read as a broken test rather than a stale
  // scratch directory.
  try {
    rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[tests] could not clear ${SANDBOX} (${err.message}); reusing what is there`);
  }
  mkdirSync(join(SANDBOX, "data"), { recursive: true });
  mkdirSync(join(SANDBOX, "videos"), { recursive: true });
  cpSync(join(REPO, "tools"), join(SANDBOX, "tools"), { recursive: true });
  writeFileSync(join(SANDBOX, "data", "catalog.json"), "[]\n");
  writeFileSync(join(SANDBOX, "data", "shows.json"), '{"shows":{}}\n');
  writeFileSync(join(SANDBOX, "index.html"), "<!doctype html><title>sandbox</title>\n");
  // 652 bytes of known content so a Range assertion can name the exact bytes.
  writeFileSync(join(SANDBOX, "probe.bin"), Buffer.alloc(652, 0x61));
}

/**
 * Start tools/serve.js in the sandbox and wait for the port to answer.
 * Returns the child plus helpers; nothing here touches the network beyond
 * 127.0.0.1.
 */
async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(SANDBOX, "tools", "serve.js"), String(port)], {
    cwd: SANDBOX,
    env: { ...process.env, HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`serve.js exited during startup (${child.exitCode}):\n${log}`);
    try {
      await send(port, { method: "GET", path: "/index.html" });
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`serve.js never answered on ${port}: ${err.message}\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    child,
    port,
    log: () => log,
    alive: () => child.exitCode === null,
    stop: () =>
      new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.on("exit", res);
        child.kill("SIGTERM");
      }),
  };
}

/**
 * Minimal HTTP client: returns { status, headers, body } without throwing on
 * 4xx/5xx.
 *
 * agent: false so every request gets its own socket. A keep-alive pool shared
 * between tests would let one server-side connection close surface as an
 * ECONNRESET on an unrelated later request.
 */
function send(port, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  return new Promise((res, rej) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", rej);
    if (body !== null) req.write(body);
    req.end();
  });
}

const json = (r) => JSON.parse(r.body.toString("utf8"));

before(() => makeSandbox());
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */

describe("PIT-TV-001 / PIT-TV-020 — Range headers cannot kill the process", () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  // Each of these crashed the process before the fix: createReadStream was
  // handed end=NaN, threw inside the async request handler, and the unhandled
  // rejection exited node. Repeating each is the point — a single pass could
  // be luck.
  const MALFORMED = [
    "bytes=abc-def",
    "bytes=0-5,10-20",
    "bytes=1-2-3",
    "bytes=",
    "bytes=0-0x10",
    "bytes=-",
    "items=0-10",
    "bytes=0-10,20-30,40-50",
    "bytes=1e3-2e3",
    "bytes= 0-10",
  ];

  for (const header of MALFORMED) {
    test(`refuses ${header} with 416 and stays up`, async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await send(s.port, { path: "/probe.bin", headers: { Range: header } });
        assert.ok(res.status === 416 || res.status === 400, `${header} answered ${res.status}`);
      }
      assert.ok(s.alive(), "serve.js exited on a malformed Range header");
    });
  }

  test("an inverted range is refused", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=500-100" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers["content-range"], "bytes */652");
    assert.ok(s.alive());
  });

  test("a range past the end is refused", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=999999-" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers["content-range"], "bytes */652");
  });

  test("an explicit range returns exactly those bytes", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=0-9" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 0-9/652");
    assert.equal(res.body.length, 10);
    assert.ok(res.body.every((b) => b === 0x61));
  });

  test("bytes=10- runs to the end of the file", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=10-" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 10-651/652");
    assert.equal(res.body.length, 642);
  });

  test("a suffix range returns the TAIL, not the head", async () => {
    // The old parser read bytes=-20 as 0-20 and served the first 21 bytes.
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=-20" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 632-651/652");
    assert.equal(res.body.length, 20);
  });

  test("a suffix range longer than the file is the whole file", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=-99999" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 0-651/652");
  });

  test("an end past the end is clamped, not refused", async () => {
    const res = await send(s.port, { path: "/probe.bin", headers: { Range: "bytes=650-99999" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 650-651/652");
    assert.equal(res.body.length, 2);
  });

  test("the server still serves normally afterwards", async () => {
    const res = await send(s.port, { path: "/index.html" });
    assert.equal(res.status, 200);
    assert.ok(s.alive());
  });
});

describe("PIT-TV-031 — traversal and null bytes are refused", () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  // The sandbox has tools/serve.js and tools/atomic-json.mjs in it; anything
  // that reaches them by escaping the root is the failure this guards.
  const ESCAPES = [
    "/../server.key",
    "/%2e%2e%2f%2e%2e%2fserver.key",
    "/..%5c..%5cpackage.json",
    "/....//....//etc/passwd",
  ];

  for (const path of ESCAPES) {
    test(`refuses ${path}`, async () => {
      const res = await send(s.port, { path });
      assert.ok(res.status === 404 || res.status === 403, `${path} answered ${res.status}`);
      assert.ok(!res.body.toString().includes("PORT"), `${path} leaked file contents`);
      assert.ok(s.alive());
    });
  }

  test("a null byte in the path is a 404, not a crash", async () => {
    const res = await send(s.port, { path: "/index%00.html" });
    assert.equal(res.status, 404);
    assert.ok(s.alive());
  });

  test("a null byte in an upload path is a 400", async () => {
    const res = await send(s.port, {
      method: "PUT",
      path: "/api/upload?path=catalog%2Fok.mp4%00.txt",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    });
    assert.equal(res.status, 400);
    assert.match(json(res).error, /null byte/);
    assert.ok(s.alive());
  });

  test("an upload path with .. is a 400", async () => {
    const res = await send(s.port, {
      method: "PUT",
      path: "/api/upload?path=..%2F..%2Fescape.mp4",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    });
    assert.equal(res.status, 400);
    assert.match(json(res).error, /\.\./);
  });

  test("an upload path escaping videos/ is a 400", async () => {
    const res = await send(s.port, {
      method: "PUT",
      path: "/api/upload?path=%2Fetc%2Fpasswd.mp4",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    });
    assert.equal(res.status, 400);
  });

  test("a symlink-free containment check still holds for the static route", () => {
    // tools/serve.js is INSIDE the root and must remain readable — the guard is
    // containment, not a blanket refusal of anything with a separator.
    return send(s.port, { path: "/tools/serve.js" }).then((res) => {
      assert.equal(res.status, 200);
    });
  });

  test("a traversal that lands back inside the root is contained, not refused", async () => {
    // /%2e%2e/%2e%2e/tools/serve.js normalises to ROOT/tools/serve.js. That is
    // the correct outcome for a containment check — the answer must be a file
    // from inside the sandbox and never one from above it.
    const res = await send(s.port, { path: "/%2e%2e/%2e%2e/tools/serve.js" });
    assert.ok(res.status === 200 || res.status === 403 || res.status === 404, `answered ${res.status}`);
    if (res.status === 200) {
      assert.equal(res.body.toString("utf8"), readFileSync(join(SANDBOX, "tools", "serve.js"), "utf8"));
    }
  });
});

describe("PIT-TV-011 / PIT-TV-009 — method handling, headers and validators", () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  for (const method of ["DELETE", "PUT", "POST", "PATCH", "OPTIONS"]) {
    test(`${method} on a static file is 405, not an empty 200`, async () => {
      const res = await send(s.port, { method, path: "/index.html" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, "GET, HEAD");
      // The old handler answered 200 with the real Content-Length and zero
      // bytes, which desynchronises keep-alive framing.
      assert.notEqual(res.headers["content-length"], String(res.body.length));
      assert.ok(s.alive());
    });
  }

  test("HEAD answers with the headers and no body", async () => {
    const res = await send(s.port, { method: "HEAD", path: "/index.html" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers["content-length"], String(statSync(join(SANDBOX, "index.html")).size));
  });

  test("security headers are present", async () => {
    const res = await send(s.port, { path: "/index.html" });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  });

  test("an ETag is sent and a matching one gets a 304", async () => {
    const first = await send(s.port, { path: "/probe.bin" });
    assert.ok(first.headers.etag);
    assert.ok(first.headers["last-modified"]);
    const second = await send(s.port, { path: "/probe.bin", headers: { "If-None-Match": first.headers.etag } });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });

  test("a JSON body over the cap is 413", async () => {
    const res = await send(s.port, {
      method: "POST",
      path: "/api/catalog",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: {}, blob: "x".repeat(5 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.match(json(res).error, /cap/);
    assert.ok(s.alive());
  });

  test("malformed JSON is 400", async () => {
    const res = await send(s.port, {
      method: "POST",
      path: "/api/catalog",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.match(json(res).error, /bad request body/);
  });
});

describe("PIT-TV-005 — PITTV_WRITE=0 gates every mutating route", () => {
  let s;
  before(async () => (s = await startServer({ PITTV_WRITE: "0" })));
  after(() => s.stop());

  const MUTATING = [
    ["POST", "/api/sync-shows", ""],
    ["POST", "/api/catalog", JSON.stringify({ changes: {} })],
    ["POST", "/api/set-show?show=x&date=2020-01-01", ""],
    ["POST", "/api/fetch-covers", ""],
    ["POST", "/api/upload/plan", JSON.stringify({ artist: "a", filename: "c.mp4", size: 10 })],
    ["POST", "/api/upload/commit", JSON.stringify({ id: "a-01", src: "videos/catalog/a/c.mp4", artist: "a" })],
    ["PUT", "/api/upload?path=catalog%2Fa%2Fc.mp4", "bytes"],
  ];

  for (const [method, path, body] of MUTATING) {
    test(`${method} ${path.split("?")[0]} is 403`, async () => {
      const res = await send(s.port, {
        method,
        path,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body || null,
      });
      // sync-shows and fetch-covers used to answer 200 and run the tool.
      assert.equal(res.status, 403, `${path} answered ${res.status}`);
      assert.match(json(res).error, /writes are disabled/);
    });
  }

  test("nothing was written to the sandbox data directory", () => {
    assert.equal(readFileSync(join(SANDBOX, "data", "catalog.json"), "utf8").trim(), "[]");
  });

  test("read routes still work", async () => {
    assert.equal((await send(s.port, { path: "/index.html" })).status, 200);
    assert.equal((await send(s.port, { path: "/api/fetch-status" })).status, 200);
  });
});

describe("PIT-TV-002 — a published server requires a token to write", () => {
  let s;
  before(async () => (s = await startServer({ HOST: "0.0.0.0", PITTV_WRITE: "1", PITTV_TOKEN: "s3cret" })));
  after(() => s.stop());

  test("a write without the token is 401", async () => {
    const res = await send(s.port, {
      method: "POST",
      path: "/api/catalog",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: {} }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers["www-authenticate"], /Bearer/);
  });

  test("a write with the wrong token is 401", async () => {
    const res = await send(s.port, {
      method: "POST",
      path: "/api/catalog",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ changes: {} }),
    });
    assert.equal(res.status, 401);
  });

  test("a write with the right token is accepted", async () => {
    const res = await send(s.port, {
      method: "POST",
      path: "/api/catalog",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify({ changes: {} }),
    });
    assert.equal(res.status, 200);
    assert.equal(json(res).ok, true);
  });

  test("reading needs no token", async () => {
    assert.equal((await send(s.port, { path: "/index.html" })).status, 200);
  });

  test("the startup banner says the port needs the token", () => {
    assert.match(s.log(), /PITTV_TOKEN|requires the PITTV_TOKEN/);
  });
});

describe("PIT-TV-004 — an upload never clobbers an existing clip", () => {
  let s;
  before(async () => {
    s = await startServer();
    mkdirSync(join(SANDBOX, "videos", "catalog", "Show"), { recursive: true });
    writeFileSync(join(SANDBOX, "videos", "catalog", "Show", "IMPORTANT.mp4"), "ORIGINAL-27-BYTES--KEEPME");
  });
  after(() => s.stop());

  test("a PUT to an existing name writes a sibling and leaves the original", async () => {
    const before = readFileSync(join(SANDBOX, "videos", "catalog", "Show", "IMPORTANT.mp4"), "utf8");
    const res = await send(s.port, {
      method: "PUT",
      path: "/api/upload?path=catalog%2FShow%2FIMPORTANT.mp4",
      headers: { "Content-Type": "application/octet-stream" },
      body: "CLOBBERED",
    });
    assert.equal(res.status, 200);
    // The response reports the path ACTUALLY written, so the commit step
    // catalogues a file that exists rather than the one that was asked for.
    assert.equal(json(res).path, "catalog/Show/IMPORTANT-2.mp4");
    assert.equal(readFileSync(join(SANDBOX, "videos", "catalog", "Show", "IMPORTANT.mp4"), "utf8"), before);
    assert.equal(readFileSync(join(SANDBOX, "videos", "catalog", "Show", "IMPORTANT-2.mp4"), "utf8"), "CLOBBERED");
  });

  test("a third upload takes -3, not -2 again", async () => {
    const res = await send(s.port, {
      method: "PUT",
      path: "/api/upload?path=catalog%2FShow%2FIMPORTANT.mp4",
      headers: { "Content-Type": "application/octet-stream" },
      body: "THIRD",
    });
    assert.equal(json(res).path, "catalog/Show/IMPORTANT-3.mp4");
  });

  test("no .part sibling is left behind", () => {
    const leftovers = existsSync(join(SANDBOX, "videos", "catalog", "Show", "IMPORTANT-3.mp4.part"));
    assert.equal(leftovers, false);
  });
});

describe("PIT-TV-008 — the plan hands back a path the PUT will accept", () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  const plan = (body) =>
    send(s.port, {
      method: "POST",
      path: "/api/upload/plan",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  for (const performance of ["AC/DC .. Live", "MGK Day 1..5", "Tour 2023..24", "../../escape", "..", "..."]) {
    test(`a plan for ${JSON.stringify(performance)} is storable`, async () => {
      const res = await plan({ artist: "A", filename: "clip.mp4", size: 10, performance });
      assert.equal(res.status, 200);
      const result = json(res);
      assert.ok(result.ok, `${performance}: ${result.error}`);
      // The load-bearing part: resolveUploadPath is the same function the PUT
      // runs, so this is the assertion that would have caught the divergence
      // before a multi-gigabyte transfer.
      assert.ok(!result.path.includes(".."), `plan path still contains ..: ${result.path}`);
      const put = await send(s.port, {
        method: "PUT",
        path: `/api/upload?path=${encodeURIComponent(result.path)}`,
        headers: { "Content-Type": "application/octet-stream" },
        body: "bytes",
      });
      assert.equal(put.status, 200, `${performance}: PUT rejected the plan's own path (${json(put).error})`);
    });
  }

  test("the plan still rejects what it always rejected", async () => {
    assert.equal((await plan({ filename: "c.mp4", size: 1 })).status, 400);
    assert.equal((await plan({ artist: "A", filename: "c.exe", size: 1 })).status, 400);
    assert.equal((await plan({ artist: "A", filename: "a/b.mp4", size: 1 })).status, 400);
    assert.equal((await plan({ artist: "A", filename: "c.mp4", size: -1 })).status, 400);
    const bad = await plan({ artist: "A", filename: "c.mp4", size: 1, date: "2023-02-30" });
    assert.equal(bad.status, 400);
    assert.match(json(bad).error, /not a real calendar date/);
  });
});

describe("PIT-TV-021 — one cover fetch at a time", () => {
  let s;
  before(async () => {
    // Swap the real cover tool for one that sleeps: the guard is about two
    // overlapping requests, which cannot be arranged against a tool that exits
    // in milliseconds on an empty catalog. The sandbox is a copy, so the real
    // tools/fetch-album-art.mjs is untouched.
    writeFileSync(
      join(SANDBOX, "tools", "fetch-album-art.mjs"),
      '// test stub: stands in for a slow cover fetch\nsetTimeout(() => process.exit(0), 3000);\n'
    );
    s = await startServer();
  });
  after(() => s.stop());

  test("a second concurrent fetch is refused rather than racing", async () => {
    // Both used to start a child that raced on catalog.json, last writer wins.
    const [a, b] = await Promise.all([
      send(s.port, { method: "POST", path: "/api/fetch-covers" }),
      new Promise((r) => setTimeout(() => r(send(s.port, { method: "POST", path: "/api/fetch-covers" })), 200)),
    ]);
    const refused = [a, b].filter((r) => /already running/.test(r.body.toString()));
    assert.equal(refused.length, 1, "the second concurrent fetch was not refused");
    assert.equal(json(refused[0]).ok, false);
    assert.ok(s.alive());
  });

  test("a fetch is allowed again once the first has finished", async () => {
    // Nothing is running by now, so this must not be refused — the guard is a
    // concurrency lock, not a latch that stays closed.
    const res = await send(s.port, { method: "POST", path: "/api/fetch-covers" });
    assert.equal(res.status, 200);
    assert.equal(json(res).ok, true);
  });
});

describe("PIT-TV-023 — /api/fetch-status reads the catalog BOM-tolerantly", () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  test("a catalog with a UTF-8 BOM still answers", async () => {
    writeFileSync(join(SANDBOX, "data", "catalog.json"), `\uFEFF${JSON.stringify([{ id: "a-01" }])}`);
    const res = await send(s.port, { path: "/api/fetch-status" });
    assert.equal(res.status, 200);
    assert.equal(json(res).total, 1);
    assert.equal(json(res).missing, 1);
  });

  test("a missing catalog answers rather than throwing", async () => {
    rmSync(join(SANDBOX, "data", "catalog.json"));
    const res = await send(s.port, { path: "/api/fetch-status" });
    assert.equal(res.status, 500);
    assert.ok(typeof json(res).error === "string");
    writeFileSync(join(SANDBOX, "data", "catalog.json"), "[]\n");
  });
});

describe("PIT-TV-024 — SIGTERM stops the server", () => {
  test("the server exits on SIGTERM rather than hanging", async () => {
    const s = await startServer();
    const exited = new Promise((res) => s.child.on("exit", (code) => res(code)));
    s.child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise((res) => setTimeout(() => res("HUNG"), 10000)),
    ]);
    assert.notEqual(code, "HUNG", "the server did not exit within 10s of SIGTERM");

    // Windows terminates on SIGTERM unconditionally and never runs the handler,
    // so the graceful path (server.close -> kill children -> exit 0) can only be
    // asserted on POSIX. Everywhere, what must hold is that the process goes away.
    if (process.platform === "win32") {
      assert.ok(code === null || typeof code === "number", `unexpected exit ${code}`);
    } else {
      assert.equal(code, 0, "SIGTERM should be a clean shutdown, not a kill");
      assert.match(s.log(), /shutting down/);
    }
  });
});
