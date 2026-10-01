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
