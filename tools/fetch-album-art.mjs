/*
 * tools/fetch-album-art.mjs — pull real album cover art into covers/albums/.
 *
 * The archive themes itself from cover art and theme.js reads the pixels through
 * a canvas, so art has to be LOCAL: a hot-linked cover taints the canvas and the
 * palette silently falls back to neutral. This downloads each cover once and
 * writes the local path into `albumArt`, which keeps the app offline-capable and
 * makes the theme morph work for every entry.
 *
 * Sources, in order:
 *   1. Deezer  — no key, no aggressive rate limiting, clean artist/album pairs.
 *   2. iTunes  — broader catalogue, but it throttles hard, so it is only asked
 *                about the leftovers and is spaced out.
 *
 * A wrong cover is worse than a missing one, so nothing is written on a weak
 * match. A release is only accepted when its title matches the catalog album
 * (after dropping "(Deluxe)", "- Single" and a leading "the") AND its artist
 * matches; everything else is reported and keeps whatever art it already has.
 *
 *   node tools/fetch-album-art.mjs            # fetch what is missing
 *   node tools/fetch-album-art.mjs --dry-run  # resolve + report, download nothing
 *   node tools/fetch-album-art.mjs --force    # re-download existing files
 *   node tools/fetch-album-art.mjs --size=1000
 *   node tools/fetch-album-art.mjs --only="Machine Gun Kelly"
 *   node tools/fetch-album-art.mjs --no-artist-fallback
 *
 * Anything the album pass cannot place falls back to a photo of the artist, so a
 * show is never left with a generated placeholder when a recognisable act is
 * available. That covers both an album that was not found and an entry that was
 * never titled, and the artist photo only applies where no album cover won.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = join(ROOT, "data", "catalog.json");
const OUT_DIR = join(ROOT, "covers", "albums");
const ART_DIR_REL = "covers/albums";
const ARTIST_OUT_DIR = join(ROOT, "covers", "artists");
const ARTIST_DIR_REL = "covers/artists";
// Album matches are cached on disk, so on a re-run there is no live result left
// to learn an artist id from. The manifest carries them over between runs.
const ID_MAP = join(ARTIST_OUT_DIR, "artist-ids.json");
// Where each cached artist photo came from, so a re-run can spot a cached
// Deezer default placeholder without re-querying the API.
const SOURCE_MAP = join(ARTIST_OUT_DIR, "artist-sources.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flag("dry-run");
const FORCE = flag("force");
const NO_ARTIST_FALLBACK = flag("no-artist-fallback");
const SIZE = parseInt(opt("size", "1000"), 10) || 1000;
const ONLY = opt("only", "");
const CONCURRENCY = 3;
const DEEZER_GAP_MS = 120;
const ITUNES_GAP_MS = 3500; // iTunes starts returning 403/429 well before this
const ATTEMPTS = 4;

/* ---------- matching ---------- */

const QUALIFIER =
  /\((?:deluxe|expanded|remaster(?:ed)?|anniversary|bonus|explicit|version|edit|mix|reissue)[^)]*\)|\[[^\]]*\]|\b(?:deluxe|expanded|remastered|anniversary|reissue)\b/gi;

const tidy = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "")
    .replace(QUALIFIER, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Comparable form of a title. Drops a leading article as well as the qualifiers,
 * because catalogues disagree about it — "The Grey Gorilla" is filed as "Grey
 * Gorilla" — and that mismatch would otherwise cost a perfect match.
 */
const titleKey = (value) => tidy(value).replace(/^(?:the|a|an) /, "");

const artistKey = (value) => tidy(value).replace(/[^a-z0-9 ]/g, "").trim();

const slug = (...parts) =>
  parts
    .join("--")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "album";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- sources ---------- */

/** Serialised so the shared rate limit is respected even with concurrent workers. */
let gate = Promise.resolve();
function throttle(gap) {
  const run = gate.then(async () => {
    await wait(gap);
  });
  gate = run.catch(() => {});
  return run;
}

async function getJson(url, { gap, label }) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await throttle(gap);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "pit-tv/1.0 (local album art fetch)", Accept: "application/json" },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 429 || res.status === 403) {
        // Back off much harder than the base gap; these are throttle signals.
        await wait(2500 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === ATTEMPTS) {
        console.warn(`  ! ${label} lookup failed: ${err.message}`);
        return null;
      }
      await wait(800 * attempt);
    }
  }
  return null;
}

const searchDeezer = async (artist, album) => {
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(`${artist} ${album}`)}&limit=25`;
  const body = await getJson(url, { gap: DEEZER_GAP_MS, label: "deezer" });
  return (body?.data || []).map((r) => ({
    title: r.title,
    artist: r.artist?.name || "",
    artistId: r.artist?.id || 0,
    art: r.cover_xl || r.cover_big || r.cover_medium || "",
  }));
};

const searchItunes = async (artist, album) => {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=25`;
  const body = await getJson(url, { gap: ITUNES_GAP_MS, label: "itunes" });
  return (body?.results || []).map((r) => ({
    title: r.collectionName,
    artist: r.artistName,
    artistId: 0,
    art: (r.artworkUrl100 || "").replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${SIZE}x${SIZE}bb.$1`),
  }));
};

/**
 * Pick the release that actually is this catalog album.
 *
 * The title has to match on its own terms and the artist has to agree too —
 * shared names like "17" and "Revenge" would otherwise attach a different
 * artist's cover to this show.
 */
function choose(results, artist, album) {
  const wantTitle = titleKey(album);
  const wantArtist = artistKey(artist);
  if (!wantTitle) return null;

  let best = null;
  for (const r of results) {
    // Deezer's default album placeholder is the same grey square it serves for
    // every missing cover; a wrong-but-real cover is worse than a missing one,
    // so reject the placeholder too.
    if (!r.art || isPlaceholderArt(r.art)) continue;
    const title = titleKey(r.title);
    const by = artistKey(r.artist);

    let titleScore = 0;
    if (title === wantTitle) titleScore = 100;
    else if (title.startsWith(`${wantTitle} `)) titleScore = 70;
    else if (title.includes(wantTitle)) titleScore = 50;
    if (!titleScore) continue;

    let artistScore = 0;
    if (by === wantArtist) artistScore = 100;
    else if (by.includes(wantArtist) || wantArtist.includes(by)) artistScore = 60;
    if (!artistScore) continue;

    // A same-named single/EP is the wrong record.
    if (/\b(?:single|ep)\b/.test(tidy(r.title)) && !/\b(?:single|ep)\b/.test(wantTitle)) titleScore -= 30;

    const score = titleScore + artistScore * 0.5;
    if (!best || score > best.score) best = { score, release: r };
  }
  return best;
}

/* ---------- artist identity ---------- */

// Deezer spells artist names in ways a straight comparison will not survive:
// "Machine Gun Kelly" is filed as "mgk", "Three Doors Down" as "3 Doors Down",
// and Korn as "KoЯn" — with a Cyrillic Ya, alongside an unrelated one-release act
// also called "Korn". Folding these away makes the names comparable again.
const CONFUSABLES = {
  а: "a", б: "b", в: "b", г: "r", е: "e", ё: "e", з: "3", и: "u", к: "k",
  м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t", у: "y", х: "x",
  ц: "u", ч: "4", ш: "w", щ: "w", ъ: "", ы: "b", ь: "", э: "e", ю: "io",
  я: "r", і: "i", ѕ: "s", ј: "j", ϲ: "c", α: "a", ε: "e", ο: "o", ρ: "p",
};

const NUMBER_WORDS = {
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four",
  5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
};

const compareKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\u0400-\u04ff\u0370-\u03ff]/g, (ch) => CONFUSABLES[ch] ?? ch)
    .split("")
    .map((ch) => NUMBER_WORDS[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokenSet = (value) => new Set(compareKey(value).split(" ").filter(Boolean));

/**
 * Abbreviations iTunes and Deezer use for acts whose names do not share words.
 * "Machine Gun Kelly" is filed as "mgk" on both services, and a Jaccard
 * comparison of their tokens scores that at 0.00 — worse than an unrelated act.
 * These are the known ones in this archive; anything not listed falls through
 * to the similarity test and is reported as a miss rather than silently
 * mismatched.
 */
const ARTIST_ALIASES = {
  "machine gun kelly": ["mgk", "machine gun kelly", "mgk & jelly roll"],
  "mgk": ["machine gun kelly", "mgk"],
};

/** Jaccard overlap, so "3 doors down" and "three doors down" line up. */
function similarity(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;

  // An alias is a deliberate override, not a fuzzy match — it wins outright.
  const aKey = compareKey(a);
  const bKey = compareKey(b);
  const aliasesA = ARTIST_ALIASES[aKey] || [];
  const aliasesB = ARTIST_ALIASES[bKey] || [];
  if (aliasesA.some((x) => compareKey(x) === bKey) || aliasesB.some((x) => compareKey(x) === aKey)) {
    return 1;
  }

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

const MIN_ARTIST_SIMILARITY = 0.6;

/**
 * Pick the right artist photo by name.
 *
 * Placeholder art is discarded, similarity has to clear the threshold, and among
 * equally similar names the act with the largest catalogue wins — that is what
 * separates the real Korn (41 releases) from the tribute act that squatted on
 * the name with one.
 *
 * Deezer serves a default "no image" for artists with no uploaded photo, and the
 * URL is easy to spot: `.../000000-80-0-0.jpg`. Those are the same 29 kB grey
 * blob for every missing act, so a placeholder is treated as no photo at all
 * rather than as a real picture of Ramirez.
 */
function isPlaceholderArt(url) {
  if (!url) return true;
  // Deezer's default "no image" for artists with no uploaded photo and for
  // albums with no cover: cdn-images.dzcdn.net/images/artist/<hash>/1000x1000-000000-80-0-0.jpg
  // and the same pattern under images/album/. It is the same grey square for
  // every missing act, so it is treated as no photo rather than as a real one.
  return /images\/artist\//.test(url) || /-000000-80-0-0\.jpg$/.test(url);
}

function chooseArtist(results, artist) {
  const usable = results.filter((r) => r && r.art && !isPlaceholderArt(r.art));
  if (!usable.length) return null;

  const scored = usable
    .map((r) => ({ r, sim: similarity(artist, r.name) }))
    .filter((x) => x.sim >= MIN_ARTIST_SIMILARITY)
    .sort((a, b) => b.sim - a.sim || b.r.albums - a.r.albums);

  return scored.length ? scored[0].r : null;
}

const searchArtist = async (artist) => {
  const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(artist)}&limit=25`;
  const body = await getJson(url, { gap: DEEZER_GAP_MS, label: "deezer/artist" });
  return (body?.data || []).map((r) => ({
    name: r.name,
    art: r.picture_xl || r.picture_big || r.picture_medium || "",
    albums: Number(r.nb_album) || 0,
  }));
};

/**
 * Ask Deezer about an artist by the id an album result already proved.
 *
 * This is the reliable path: the album match was made against a real release, so
 * its artist id is the canonical one and no name comparison is involved. The
 * photo may still be Deezer's placeholder when the artist never uploaded one,
 * in which case the caller falls through to other sources.
 */
const artistById = async (id) => {
  const body = await getJson(`https://api.deezer.com/artist/${id}`, { gap: DEEZER_GAP_MS, label: "deezer/artist-id" });
  if (!body || isPlaceholderArt(body.picture_xl)) return null;
  return { name: body.name, art: body.picture_xl, albums: Number(body.nb_album) || 0 };
};

/**
 * iTunes does not expose an artist search in its public API. What it does
 * expose is album search, and every album result carries its artist's name and
 * cover — so asking for albums by that name and keeping the best-matching
 * artist is the way to get an artist's artwork from iTunes.
 *
 * The cover is a real release cover rather than a headshot, but for acts Deezer
 * has no photo for it is the difference between a picture and a grey blob.
 *
 * Matching is similarity-based, not exact: iTunes files "Machine Gun Kelly"
 * as "mgk" and "Three Doors Down" as "3 Doors Down", so the same Jaccard
 * comparison used to disambiguate Deezer artist names is applied here.
 */
const searchArtistItunes = async (artist) => {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=album&limit=25`;
  const body = await getJson(url, { gap: ITUNES_GAP_MS, label: "itunes/artist" });
  const out = [];
  for (const r of body?.results || []) {
    if (!r.artistName || !r.artworkUrl100) continue;
    out.push({
      name: r.artistName,
      art: r.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${SIZE}x${SIZE}bb.$1`),
      albums: Number(r.collectionCount) || 0,
    });
    if (out.length >= 25) break;
  }
  return out;
};

/* ---------- run ---------- */

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));

const targets = new Map();
for (const entry of catalog) {
  if (!entry.album || !entry.artist) continue;
  if (ONLY && !`${entry.artist} ${entry.album}`.toLowerCase().includes(ONLY.toLowerCase())) continue;
  const key = `${entry.artist}\u0000${entry.album}`;
  if (!targets.has(key)) targets.set(key, { artist: entry.artist, album: entry.album });
  targets.get(key).ids = [...(targets.get(key).ids || []), entry.id];
}

const queue = [...targets.values()];
console.log(`${catalog.length} entries — ${queue.length} distinct album${queue.length === 1 ? "" : "s"} to resolve`);
if (DRY_RUN) console.log("(dry run: nothing downloaded, nothing written)\n");
else mkdirSync(OUT_DIR, { recursive: true });

const matched = [];
const unresolved = [];
const artistIds = new Map(Object.entries(existsSync(ID_MAP) ? JSON.parse(readFileSync(ID_MAP, "utf8")) : {}));
let done = 0;
const stamp = () => `[${String(++done).padStart(2)}/${targets.size}]`;

async function resolveOne(target) {
  const { artist, album } = target;

  for (const [source, search] of [
    ["deezer", searchDeezer],
    ["itunes", searchItunes],
  ]) {
    const results = await search(artist, album);
    const best = choose(results, artist, album);
    if (best) return { ...best, source };
  }
  return null;
}

async function worker() {
  while (queue.length) {
    const target = queue.shift();
    const file = join(OUT_DIR, `${slug(target.artist, target.album)}.jpg`);

    if (!FORCE && existsSync(file)) {
      matched.push({ ...target, rel: `${ART_DIR_REL}/${slug(target.artist, target.album)}.jpg`, note: "cached" });
      // The cover is already on disk, but the artist id still has to be learned
      // once from the same lookup, and then it is remembered in the manifest.
      if (!artistIds.has(target.artist)) {
        const hit = await resolveOne(target);
        if (hit?.release.artistId) artistIds.set(target.artist, hit.release.artistId);
      }
      console.log(`${stamp()} cache ${target.artist} — ${target.album}`);
      continue;
    }

    const hit = await resolveOne(target);

    if (!hit) {
      unresolved.push({ ...target, reason: "no title+artist match" });
      console.log(`${stamp()} MISS  ${target.artist} — ${target.album}`);
      continue;
    }

    const { release, source } = hit;
    const rel = `${ART_DIR_REL}/${slug(target.artist, target.album)}.jpg`;

    // A confirmed Deezer album release also confirms who the artist is.
    if (release.artistId) artistIds.set(target.artist, release.artistId);

    if (DRY_RUN) {
      matched.push({ ...target, rel, note: `${release.title} [${source}]` });
      console.log(`${stamp()} ok    ${target.artist} — ${target.album}  ->  ${release.title} (${release.artist}) [${source}]`);
      continue;
    }

    try {
      await throttle(DEEZER_GAP_MS);
      const res = await fetch(release.art, { signal: AbortSignal.timeout(40000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 2048) throw new Error(`suspiciously small (${bytes.length} bytes)`);
      // Deezer's default album placeholder is the same grey square it serves for
      // every missing cover. A wrong-but-real cover is worse than a missing one,
      // so reject the download rather than write a placeholder as a real cover.
      if (isPlaceholderArt(release.art)) throw new Error("Deezer placeholder image");
      writeFileSync(file, bytes);
      matched.push({ ...target, rel, note: release.title });
      console.log(`${stamp()} ok    ${target.artist} — ${target.album}  ->  ${release.title} (${(bytes.length / 1024).toFixed(0)} kB)`);
    } catch (err) {
      unresolved.push({ ...target, reason: err.message });
      console.log(`${stamp()} DLFAIL ${target.artist} — ${target.album}  (${err.message})`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (artistIds.size) {
  mkdirSync(ARTIST_OUT_DIR, { recursive: true });
  const previous = existsSync(ID_MAP) ? JSON.parse(readFileSync(ID_MAP, "utf8")) : {};
  const merged = Object.fromEntries(Object.entries({ ...previous, ...Object.fromEntries(artistIds) }).sort());
  if (JSON.stringify(merged) !== JSON.stringify(previous)) writeJsonAtomic(ID_MAP, merged, { trailingNewline: true });
  console.log(`\n${artistIds.size} artist id(s) known (${Object.keys(previous).length} carried over).`);
}

/* ---------- fallback: artist photo for anything the album pass could not place ---------- */

const albumCoverFor = new Map(matched.map((m) => [`${m.artist}\u0000${m.album}`, m.rel]));
// An artist whose albums all matched has a confirmed identity, and any of those
// covers is a real image of that act. When Deezer has no photo for them (the
// default placeholder), using one of their own album covers is both accurate and
// better than an external name match — a name search for "Ramirez" pulls in
// Lenin Ramírez, a regional Mexican artist with 107 albums, and the largest-
// catalogue tiebreak picks him every time.
const artistAlbumCover = new Map();
for (const m of matched) {
  if (!artistAlbumCover.has(m.artist)) artistAlbumCover.set(m.artist, m.rel);
}

// An artist needs a photo when any of their entries has no album cover — either
// the album was not found, or the entry was never titled in the first place.
// Deriving the list this way also means no artist photo is downloaded for an
// artist whose whole catalogue is already covered, so nothing is left orphaned.
const needsPhoto = [
  ...new Set(
    catalog.filter((e) => e.artist && !albumCoverFor.get(`${e.artist}\u0000${e.album}`)).map((e) => e.artist)
  ),
].sort();

const artistShots = new Map(); // artist -> { rel, note }
const noArtistShot = [];
const artistSources = new Map(
  Object.entries(existsSync(SOURCE_MAP) ? JSON.parse(readFileSync(SOURCE_MAP, "utf8")) : {})
);

if (!NO_ARTIST_FALLBACK && needsPhoto.length) {
  console.log(`\n${needsPhoto.length} artist(s) needing a photo: ${needsPhoto.join(", ")}`);

  for (const artist of needsPhoto) {
    const file = join(ARTIST_OUT_DIR, `${slug(artist)}.jpg`);
    const rel = `${ARTIST_DIR_REL}/${slug(artist)}.jpg`;

    // A file already on disk is kept unless the manifest says it is Deezer's
    // default placeholder. Deezer serves the same 29 kB grey blob for every
    // artist with no uploaded photo (Ramirez, Deftones, Korn, Juicy J, …), and
    // it is indistinguishable from a real photo by size alone — only the source
    // URL says which it is. The manifest records that, so a re-run can replace
    // cached placeholders without re-querying the API.
    //
    // A file with no manifest entry is treated as unknown rather than trusted:
    // the placeholders were written by an earlier run that did not record their
    // source, and re-fetching them is the only way to know.
    const known = artistSources.get(artist);
    if (!FORCE && existsSync(file) && known && !known.placeholder) {
      artistShots.set(artist, { rel, note: "cached" });
      console.log(`  cache  ${artist}`);
      continue;
    }
    if (!FORCE && existsSync(file) && (!known || known.placeholder)) {
      console.log(`  replace  ${artist}  (${known?.placeholder ? "cached placeholder" : "unknown source, re-fetching"})`);
    }

    const results = artistIds.has(artist)
      ? [await artistById(artistIds.get(artist))]
      : await searchArtist(artist);
    let best = results.filter(Boolean)[0];
    if (best && isPlaceholderArt(best.art)) best = null;
    best = best || chooseArtist(results, artist);

    // Deezer often returns its default placeholder for artists with no uploaded
    // photo. Rather than fall back to an external name match that can land on
    // a different person, use one of this act's own album covers when the album
    // pass already confirmed who they are — it is a real image of the right act.
    if (!best && artistAlbumCover.has(artist)) {
      const rel = artistAlbumCover.get(artist);
      // The album cover is already on disk; just point the artist photo at it
      // rather than downloading a duplicate. The file is served from the same
      // directory, so the relative path is what the app stores.
      best = { name: artist, art: rel, albums: 0, reuse: true };
      console.log(`  reuse   ${artist}  (own album cover — Deezer has no artist photo)`);
    }

    // Only then try iTunes, which carries artwork for a different slice of acts.
    if (!best) {
      const itunes = await searchArtistItunes(artist);
      best = chooseArtist(itunes, artist);
    }

    if (!best) {
      noArtistShot.push(artist);
      console.log(`  MISS   ${artist}  (no usable artist photo)`);
      continue;
    }

    if (DRY_RUN) {
      artistShots.set(artist, { rel: best.reuse ? best.art : rel, note: `${best.name} (${best.albums} releases)` });
      console.log(`  ok     ${artist}  ->  ${best.name} (${best.albums} releases)`);
      continue;
    }

    // A reused album cover is already on disk — no download, no rate limit.
    if (best.reuse) {
      artistShots.set(artist, { rel: best.art, note: best.name });
      artistSources.set(artist, { url: best.art, placeholder: false });
      console.log(`  ok     ${artist}  ->  ${best.name} (reused, on disk)`);
      continue;
    }

    try {
      mkdirSync(ARTIST_OUT_DIR, { recursive: true });
      await throttle(DEEZER_GAP_MS);
      const res = await fetch(best.art, { signal: AbortSignal.timeout(40000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 2048) throw new Error(`suspiciously small (${bytes.length} bytes)`);
      writeFileSync(file, bytes);
      artistShots.set(artist, { rel, note: best.name });
      artistSources.set(artist, { url: best.art, placeholder: isPlaceholderArt(best.art) });
      console.log(`  ok     ${artist}  ->  ${best.name} (${(bytes.length / 1024).toFixed(0)} kB)`);
    } catch (err) {
      noArtistShot.push(artist);
      console.log(`  DLFAIL ${artist}  (${err.message})`);
    }
  }
}

if (artistSources.size) {
  const merged = Object.fromEntries(
    Object.entries({ ...Object.fromEntries(artistSources) }).sort()
  );
  if (JSON.stringify(merged) !== JSON.stringify(Object.fromEntries(artistSources))) {
    writeJsonAtomic(SOURCE_MAP, merged, { trailingNewline: true });
  }
}

/* ---------- apply ---------- */

const onAlbum = (e) => albumCoverFor.get(`${e.artist}\u0000${e.album}`);
const onArtist = (e) => artistShots.get(e.artist)?.rel;

if (DRY_RUN) {
  const byAlbumCover = catalog.filter(onAlbum).length;
  const byArtistPhoto = catalog.filter((e) => !onAlbum(e) && onArtist(e)).length;
  const byNeither = catalog.filter((e) => !onAlbum(e) && !onArtist(e)).length;
  console.log(`\n${matched.length} album covers, ${artistShots.size} artist photos would be applied.`);
  console.log(`Entries: ${byAlbumCover} album cover, ${byArtistPhoto} artist photo, ${byNeither} nothing.`);
  if (unresolved.length) {
    console.log("\nAlbums that had no cover match:");
    for (const u of unresolved) console.log(`  ${u.artist} — ${u.album}  (${u.reason})`);
  }
  if (noArtistShot.length) console.log(`\nNo artist photo either: ${noArtistShot.join(", ")}`);
  process.exit(0);
}

let updated = 0;
const stillUntouched = [];

for (const entry of catalog) {
  // Album art wins; an artist photo is the fallback for anything without one.
  const rel = onAlbum(entry) || onArtist(entry);
  if (!rel) {
    stillUntouched.push(entry);
    continue;
  }
  if (entry.albumArt === rel) continue;
  entry.albumArt = rel;
  updated += 1;
}

writeJsonAtomic(CATALOG, catalog);

console.log(`\n${matched.length} album covers + ${artistShots.size} artist photos on disk, ${updated} entries repointed.`);
if (stillUntouched.length) {
  console.log(`${stillUntouched.length} entries still have no fetched art:`);
  for (const e of stillUntouched) console.log(`  ${e.id} | ${e.artist} — ${e.album || "(no album)"}`);
}
