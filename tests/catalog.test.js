/*
 * tests/catalog.test.js — regression tests for assets/js/catalog.js.
 *
 * node:test, no dependencies (run with `npm test`).
 *
 * toRawEntry is a pure projection — it does not touch localStorage or the DOM,
 * so it can be imported directly in node.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toRawEntry } from "../assets/js/catalog.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("PIT-TV-018 — show-level fields are not written back onto entries", () => {
  test("toRawEntry drops date, venue, location", () => {
    const entry = {
      id: "mgk-2019-01",
      artist: "MGK",
      song: "Welcome to the Party",
      date: "2019-05-17",
      venue: "Wolstein Center",
      location: "Cleveland, OH",
      video: { src: "videos/catalog/mgk-2019-01/clip.mp4" },
      albumArt: "covers/albums/mgk-2019-01.jpg",
    };
    const raw = toRawEntry(entry);
    assert.equal(raw.date, undefined);
    assert.equal(raw.venue, undefined);
    assert.equal(raw.location, undefined);
  });

  test("toRawEntry keeps the fields it allows", () => {
    const entry = {
      id: "mgk-2019-01",
      artist: "MGK",
      song: "Banger",
      date: "2019-05-17",
      venue: "X",
      location: "Y",
      video: { src: "videos/catalog/mgk-2019-01/clip.mp4" },
      albumArt: "covers/albums/mgk-2019-01.jpg",
      tags: ["live"],
      metadata: { audio: "stereo" },
    };
    const raw = toRawEntry(entry);
    assert.equal(raw.id, "mgk-2019-01");
    assert.equal(raw.artist, "MGK");
    assert.equal(raw.song, "Banger");
    assert.deepEqual(raw.tags, ["live"]);
    assert.deepEqual(raw.metadata, { audio: "stereo" });
    // derived fields that normaliseEntry adds are never persisted
    assert.equal(raw.datePrecision, undefined);
    assert.equal(raw.dateRaw, undefined);
  });

  test("an edit on an entry with inline dates no longer sends them", () => {
    // Simulates edit.js calling toRawEntry on an entry that applyShows enriched
    // from shows.json — the projected patch must not carry venue/date/location,
    // or the save re-introduces the duplication PIT-TV-018 reports.
    const enriched = {
      id: "a-01",
      artist: "A",
      song: "S",
      date: "2020-01-01",
      venue: "Hall",
      location: "City",
      dateRaw: "Jan 1 2020",
      datePrecision: "day",
    };
    const patch = toRawEntry(enriched);
    assert.deepEqual(Object.keys(patch).sort(), ["artist", "id", "song"]);
  });
});

describe("PIT-TV-018 — set-locations.mjs --prune-show-fields strips duplicates", () => {
  const sandbox = join(REPO, ".qa-tmp", "prune-test");

  function setupCatalog(catalog) {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    mkdirSync(sandbox, { recursive: true });
    mkdirSync(join(sandbox, "tools"), { recursive: true });
    mkdirSync(join(sandbox, "data"), { recursive: true });
    cpSync(join(REPO, "tools", "set-locations.mjs"), join(sandbox, "tools", "set-locations.mjs"));
    cpSync(join(REPO, "tools", "atomic-json.mjs"), join(sandbox, "tools", "atomic-json.mjs"));
    writeFileSync(join(sandbox, "data", "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  }

  test("strips date/venue/location from entries that carry them", (t) => {
    const catalog = [
      { id: "a-01", artist: "A", song: "S", date: "2020-01-01", venue: "V", location: "L" },
      { id: "b-01", artist: "B", song: "S", date: "2021-06-15" },
      { id: "c-01", artist: "C", song: "S" },
    ];
    setupCatalog(catalog);

    return new Promise((resolve, reject) => {
      execFile(process.execPath, [join(sandbox, "tools", "set-locations.mjs"), "--prune-show-fields"], {
        cwd: sandbox,
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          const result = JSON.parse(readFileSync(join(sandbox, "data", "catalog.json"), "utf8"));
          assert.equal(result.length, 3);
          assert.equal(result[0].date, undefined);
          assert.equal(result[0].venue, undefined);
          assert.equal(result[0].location, undefined);
          assert.equal(result[0].id, "a-01");
          assert.equal(result[0].artist, "A");
          assert.equal(result[1].date, undefined);
          assert.equal(result[1].artist, "B");
          assert.equal(result[2].artist, "C");
          assert.match(stdout.toString(), /Pruned 2 of 3 entries/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  test("--dry-run with --prune-show-fields reports but writes nothing", (t) => {
    const catalog = [
      { id: "a-01", artist: "A", song: "S", venue: "V" },
    ];
    setupCatalog(catalog);

    return new Promise((resolve, reject) => {
      execFile(process.execPath, [join(sandbox, "tools", "set-locations.mjs"), "--prune-show-fields", "--dry-run"], {
        cwd: sandbox,
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          const result = JSON.parse(readFileSync(join(sandbox, "data", "catalog.json"), "utf8"));
          // dry-run: the field survives
          assert.equal(result[0].venue, "V");
          assert.match(stdout.toString(), /Would prune 1 of 1/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

/*
 * The reverse direction of the sync. shows.json is authoritative for date, venue
 * and location — the app joins it onto every clip at load and toRawEntry refuses
 * to write those fields onto an entry — so nothing in the app corrects a stale
 * copy in catalog.json. These cover the mirror in tools/set-locations.mjs that
 * does, on the same pass as the catalog -> shows.json rebuild.
 */
describe("two-way sync — set-locations.mjs mirrors shows.json onto the clips", () => {
  const sandbox = join(REPO, ".qa-tmp", "mirror-test");

  /** A catalog whose clips carry stale copies, and the shows.json that corrects them. */
  function setup(catalog, shows) {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    mkdirSync(sandbox, { recursive: true });
    mkdirSync(join(sandbox, "tools"), { recursive: true });
    mkdirSync(join(sandbox, "data"), { recursive: true });
    cpSync(join(REPO, "tools", "set-locations.mjs"), join(sandbox, "tools", "set-locations.mjs"));
    cpSync(join(REPO, "tools", "atomic-json.mjs"), join(sandbox, "tools", "atomic-json.mjs"));
    writeFileSync(join(sandbox, "data", "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(sandbox, "data", "shows.json"), JSON.stringify({ shows }, null, 2) + "\n");
  }

  /** Run the tool in the sandbox and hand back stdout plus both files as written. */
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [join(sandbox, "tools", "set-locations.mjs"), ...args], { cwd: sandbox }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stdout}\n${stderr}`));
        try {
          resolve({
            stdout: stdout.toString(),
            catalog: JSON.parse(readFileSync(join(sandbox, "data", "catalog.json"), "utf8")),
            shows: JSON.parse(readFileSync(join(sandbox, "data", "shows.json"), "utf8")),
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  const STALE = [
    { id: "logic-2018-01", artist: "Logic", song: "S1", venue: "TD Pavilion at Highmark Mann", date: "2026-10-01", dateRaw: "2026-10-01", location: "Philadelphia, PA" },
    { id: "logic-2018-02", artist: "Logic", song: "S2", venue: "TD Pavilion at Highmark Mann", date: "2026-10-01", dateRaw: "2026-10-01", location: "Philadelphia, PA" },
    { id: "artemas-2026-01", artist: "Artemas", song: "S3", venue: "The Fillmore", date: "2026-03-10", dateRaw: "2026-03-10", location: "Detroit, MI" },
  ];
  const CORRECTED = {
    "logic-2018": { date: "2026-09-25", venue: "Riverbend Music Center", location: "Cincinnati, OH" },
    "artemas-2026": { date: "2026-03-10", venue: "House of Blues", location: "Cleveland, OH" },
  };

  test("a value typed in shows.json reaches every clip of that show", async () => {
    setup(STALE, CORRECTED);
    const { catalog, stdout } = await run([]);

    for (const entry of catalog.filter((e) => e.id.startsWith("logic-2018"))) {
      assert.equal(entry.venue, "Riverbend Music Center");
      assert.equal(entry.location, "Cincinnati, OH");
      assert.equal(entry.date, "2026-09-25");
    }
    // A different show is corrected the same way — one run, every show.
    assert.equal(catalog[2].venue, "House of Blues");
    assert.equal(catalog[2].location, "Cleveland, OH");
    assert.match(stdout, /Mirrored show values onto 3 clip\(s\)/);
  });

  test("dateRaw follows date rather than contradicting it", async () => {
    setup(STALE, CORRECTED);
    const { catalog } = await run([]);
    assert.equal(catalog[0].dateRaw, "2026-09-25");
    // An unchanged date must not be rewritten.
    assert.equal(catalog[2].dateRaw, "2026-03-10");
  });

  test("--show=… writes the value into shows.json and onto the clips", async () => {
    // This is the path a venue correction takes: /api/set-show runs the tool with
    // these flags. Before the mirror it updated shows.json and left the catalog
    // carrying the old venue, which is the bug this covers.
    setup(STALE, CORRECTED);
    const { catalog, shows } = await run(["--show=artemas-2026", "--venue=House of Blues", "--location=Cleveland, OH"]);

    assert.equal(shows.shows["artemas-2026"].venue, "House of Blues");
    assert.equal(catalog[2].venue, "House of Blues");
    assert.equal(catalog[2].location, "Cleveland, OH");
    // The show that was not named keeps the value shows.json already had.
    assert.equal(catalog[0].venue, "Riverbend Music Center");
  });

  test("a blank field in shows.json leaves the clip's own value alone", async () => {
    // applyShows skips a blank show field rather than blanking the clip, and the
    // mirror has to match: writing "" would lose a value the user never typed
    // over, on every clip of the show.
    setup(STALE, { "logic-2018": { date: "", venue: "", location: "" } });
    const { catalog } = await run([]);

    assert.equal(catalog[0].venue, "TD Pavilion at Highmark Mann");
    assert.equal(catalog[0].location, "Philadelphia, PA");
    assert.equal(catalog[0].date, "2026-10-01");
  });

  test("a clip whose show has no row is left untouched", async () => {
    setup(
      [{ id: "mystery-01", artist: "M", song: "S", venue: "V", date: "2020-01-01", location: "L" }],
      { "other-show": { date: "2021-01-01", venue: "Other", location: "Elsewhere" } }
    );
    const { catalog, stdout } = await run([]);

    assert.equal(catalog[0].venue, "V");
    assert.equal(catalog[0].date, "2020-01-01");
    assert.doesNotMatch(stdout, /Mirrored show values onto/);
  });

  test("--dry-run reports the mirror and writes neither file", async () => {
    setup(STALE, CORRECTED);
    const { catalog, shows, stdout } = await run(["--dry-run"]);

    assert.match(stdout, /Would mirror show values onto 3 clip\(s\)/);
    // Nothing on disk moved: the catalog keeps its stale copies…
    assert.equal(catalog[0].venue, "TD Pavilion at Highmark Mann");
    assert.equal(catalog[0].date, "2026-10-01");
    // …and shows.json is left byte-identical, so a run cannot half-apply.
    assert.equal(shows.shows["logic-2018"].venue, "Riverbend Music Center");
  });

  test("a second run is a no-op — the copies are already in step", async () => {
    setup(STALE, CORRECTED);
    await run([]);
    const { stdout } = await run([]);
    assert.doesNotMatch(stdout, /Mirrored show values onto/);
  });
});
