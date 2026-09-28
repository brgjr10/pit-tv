/*
 * tools/fill-covers.mjs — auto-fill albumArt and poster from artist+album.
 *
 * The catalog stores artist and album as text; the cover files on disk are
 * named from those values. This script derives the right file name for every
 * entry and writes it into albumArt (album cover preferred, artist photo as
 * fallback) and video.poster (the show's own generated SVG, falling back to
 * album art). Nothing is fetched: every path it produces must already exist.
 *
 *   node tools/fill-covers.mjs            # write changes to data/catalog.json
 *   node tools/fill-covers.mjs --dry-run  # report, write nothing
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = join(ROOT, "data", "catalog.json");
const ALBUM_DIR = join(ROOT, "covers", "albums");
const ARTIST_DIR = join(ROOT, "covers", "artists");
const SHOW_DIR = join(ROOT, "covers");

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

/* ---------- naming ---------- */

const slug = (...parts) =>
  parts
    .join("--")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "album";

const tidy = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/* ---------- lookups ---------- */

function findAlbum(artist, album) {
  if (!album) return null;
  const candidate = `${slug(artist, album)}.jpg`;
  return existsSync(join(ALBUM_DIR, candidate)) ? `covers/albums/${candidate}` : null;
}

function findArtistPhoto(artist) {
  const candidate = `${slug(artist)}.jpg`;
  return existsSync(join(ARTIST_DIR, candidate)) ? `covers/artists/${candidate}` : null;
}

function findShowSvg(showKey) {
  const candidate = `${showKey}.svg`;
  return existsSync(join(SHOW_DIR, candidate)) ? `covers/${candidate}` : null;
}

/* ---------- overrides ---------- */

/**
 * A few catalog entries are correct as data but resolve to the wrong cover
 * under the artist+album rule. Each override names the album art file that
 * entry should actually use, with the reason it is not the default.
 *
 *   logic-2018-44 — artist is "Juicy J" and song is "Dark Horse", which is
 *     Katy Perry's song from Prism. The artist field is not being changed,
 *     but the cover should be the album the song is from, not a Juicy J
 *     photo (which does not exist on disk anyway).
 */
const ART_OVERRIDES = {
  "logic-2018-44": "covers/albums/katy-perry-prism.jpg",
};

/* ---------- run ---------- */

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));

let albumArtUpdated = 0;
let posterUpdated = 0;
let noArt = [];

for (const entry of catalog) {
  const showKey = String(entry.id || "").replace(/-\d+$/, "");

  // albumArt: album cover wins; artist photo is the fallback. An explicit
  // override wins both. When nothing resolves the field is cleared so the UI
  // falls back to initials instead of leaving another artist's photo in place.
  const art =
    ART_OVERRIDES[entry.id] ||
    findAlbum(entry.artist, entry.album) ||
    findArtistPhoto(entry.artist);
  if (art) {
    if (entry.albumArt !== art) {
      entry.albumArt = art;
      albumArtUpdated += 1;
    }
  } else {
    if (entry.albumArt) {
      entry.albumArt = "";
      albumArtUpdated += 1;
    }
    noArt.push(entry.id);
  }

  // poster: the show's own SVG first, then the album art, then nothing.
  const poster = findShowSvg(showKey) || art || "";
  if (entry.video && entry.video.poster !== poster) {
    entry.video.poster = poster;
    posterUpdated += 1;
  }
}

console.log(`${catalog.length} entries`);
console.log(`albumArt filled/updated: ${albumArtUpdated}`);
console.log(`poster filled/updated:  ${posterUpdated}`);
if (noArt.length) console.log(`still no art: ${noArt.join(", ")}`);

if (DRY_RUN) {
  console.log("\n(dry run: nothing written)");
  process.exit(0);
}

writeJsonAtomic(CATALOG, catalog);
console.log("\nwrote data/catalog.json");