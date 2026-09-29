# PIT TV

A single-page archive for live concert video. Point it at a JSON catalog, browse
it four ways, and press play — the whole interface re-themes itself from the
album art of whatever is on screen.

Zero build step, zero framework, zero runtime dependencies beyond two vendored
libraries. Plain ES modules, CSS custom properties, and `anime.js` doing the
motion.

<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/01c6dc70-818a-47ac-96bf-b598612a4db4" />

---

## Run it

The app needs an HTTP origin. ES modules, `fetch()` of the catalog, and the
service worker are all blocked over `file://`.

```bash
node tools/serve.js 3000
```

Then open <http://localhost:3000/>.

**Use `tools/serve.js` for anything beyond a quick look.** It is the only server
in this repo that implements the `/api/*` routes the app calls, it supports HTTP
range requests so seeking works inside large local video files, it sets
`Service-Worker-Allowed` so the service worker can claim the whole origin, and it
refuses to serve anything outside the project folder.

Any other static server (`npx serve`, `python -m http.server`, a web-server GUI)
will render the app but silently fail the routes above, which surfaces as a flood
of red console errors that look like application bugs. If the console shows
`501 Unsupported method ('POST')` or a `404` on `/api/*`, you are on the wrong
server — start `tools/serve.js` instead.

---

## Docker

A multi-stage `Dockerfile` and `docker-compose.yml` are included. The container
runs the same zero-dependency server and ships the demo catalog, so it works out
of the box:

```bash
docker compose up --build
```

Then open <http://localhost:3000/>.

`docker-compose.yml` mounts `./videos` as a volume — drop your video files into
`videos/` on the host and they're served by the container. It also mounts
`./data` so `catalog.json` / `shows.json` and any uploads live on the host and
survive a rebuild; edit the catalog from the UI and the change is on disk, not
inside the container. To use custom album art, uncomment the `./covers` line.

The mutating routes (`/api/catalog`, `/api/upload/*`) are **on by default**, so
editing and uploading work from a bare `node tools/serve.js`. The boundary is
`HOST`, which defaults to `127.0.0.1` — writes are live but the port is
loopback-only. Set `PITTV_WRITE=0` to lock writes down, and note that
`HOST=0.0.0.0 PITTV_WRITE=0` is what you want if you ever publish the port and
do not want it remotely writable. The server warns at boot if it sees writes on
together with `HOST=0.0.0.0`.

The image runs as a non-root user and exposes port `3000` (override with `PORT`).

---

## The catalog

Everything the app shows comes from **`data/catalog.json`** — a plain JSON array.
Edit it, reload, done. It is user data, not build output.

The bundled catalog is the concert list: one entry per show, the headliner as
`artist`, the event as `song`, the year as `date`, and every act on the bill as
a `w/ …` tag. It points at `videos/<year>/<id>.mp4` — drop your own footage in
and the entries start playing. Until then every entry reports `File not found`,
which is the app telling you it is ready for your files.

The original sample catalog, which exercises YouTube/Vimeo/HLS/DASH/CC0 sources,
is kept alongside it as **`data/catalog.demo.json`**. To browse that one instead:

```bash
mv data/catalog.json data/catalog.concerts.json
cp data/catalog.demo.json data/catalog.json
```

```json
{
  "id": "rh-2024-06-15-01",
  "artist": "Radiohead",
  "song": "Everything In Its Right Place",
  "album": "Kid A",
  "venue": "Primavera Sound",
  "date": "2024-06-15",
  "location": "Barcelona, Spain",
  "video": {
    "type": "cloud",
    "src": "https://example.com/videos/rh-eiirp.mp4",
    "poster": "https://example.com/thumbs/rh-eiirp.jpg",
    "duration": 342
  },
  "songs": [
    {
      "title": "Everything In Its Right Place",
      "video": { "type": "local", "src": "videos/2024/primavera/01-eirp.mp4" }
    },
    {
      "title": "Idioteque",
      "video": { "type": "local", "src": "videos/2024/primavera/02-idioteque.mp4" },
      "duration": 366
    }
  ],
  "albumArt": "https://example.com/covers/kid-a.jpg",
  "tags": ["primavera-2024", "festival", "pro-shot"],
  "metadata": {
    "quality": "1080p",
    "source": "broadcast",
    "audio": "matrix"
  },
  "chapters": [
    { "time": 0, "title": "House Lights Down" },
    { "time": 42, "title": "Guitar Solo" }
  ]
}
```

### Field notes

| Field | Required | Notes |
|---|---|---|
| `id` | no | Auto-generated from artist + date + song if missing. Duplicates get a numeric suffix. |
| `artist`, `song` | **yes** | An entry missing either is skipped and reported in the console. |
| `venue` | no | Defaults to `Unknown venue`. Fill it in once you know which room you were in. |
| `date` | no | `YYYY-MM-DD`, or a bare `YYYY` when only the year is known. A year sorts, filters and groups like any other date but is displayed as `2016`, never as `1 Jan 2016`. |
| `video.type` | no | `local` or `cloud`. Inferred from the URL when omitted. |
| `video.src` | yes* | Relative path, `file://`, or any URL. Required unless the entry has a `songs` setlist. |
| `video.duration` | no | Seconds, or `"12:34"` / `"1:02:03"`. Used before metadata loads. |
| `songs` | no | The setlist — see below. |
| `songs[].title` | **yes** | The label shown in the setlist. `song` is accepted as an alias. |
| `songs[].video.src` | **yes** | Each song is its own file and its own resume position. |
| `songs[].duration` | no | Also read from `songs[].video.duration`. |
| `songs[].albumArt` | no | Re-themes the interface for that song. Falls back to the show's art. |
| `songs[].chapters` | no | Same shape as the entry's. |
| `albumArt` | no | Falls back to artist initials on a themed placeholder. |
| `metadata` | no | `quality` / `source` / `audio`. Left out of the concert catalog until the files exist — the filter groups simply do not appear until something sets them. |
| `chapters` | no | Non-standard extension — puts markers on the scrub bar and a jump rail under it. |

A bad entry never takes the page down. Invalid records are logged, skipped, and
surfaced as a toast; everything else still renders.

### Setlists

A concert card is a show, and a show can hold many videos. Give the entry a
`songs` array and the card reports how many it holds; opening it lists the setlist
under the stage, each row labelled with its song title, and clicking a row plays
that video in the same stage.

- **A show is playable as a setlist, a file, or both.** With no `video` of its
  own, the setlist *is* the show. With one, its file is offered as a `Full show`
  row above the songs — so a full-set rip and the individual songs can coexist.
- **Each song keeps its own position.** Resume is stored per song, and reopening
  a show lands on the last song you watched, not the first.
- **Song titles are searchable.** Typing a song title finds the show it belongs
  to, and the match is highlighted in the setlist.
- **A song can change the theme.** Give it its own `albumArt` and the interface
  re-themes to that song; otherwise it uses the show's art.
- **Bad songs are skipped, not fatal.** A song missing a title or a source is
  reported and dropped; the rest of the bill still plays.
- Rows are ordinary buttons, so <kbd>Tab</kbd> + <kbd>Enter</kbd> works without
  a mouse.

```json
{
  "id": "mgk-day-2022",
  "artist": "Machine Gun Kelly",
  "song": "MGK Day Festival Year 1",
  "date": "2022",
  "albumArt": "covers/mgk-day-2022.svg",
  "songs": [
    { "title": "Intro", "video": { "type": "local", "src": "videos/2022/mgk-day-2022/01-intro.mp4" } },
    { "title": "Name In Locker", "video": { "type": "local", "src": "videos/2022/mgk-day-2022/02-name-in-locker.mp4" } }
  ]
}
```

### Video sources

| Source | How it is handled |
|---|---|
| `local` relative path | Played directly. A `HEAD` preflight turns a missing file into `File not found: <path>` instead of the browser's misleading "unsupported source". |
| `file://` | Played directly (only reachable from an Electron/file-origin build). |
| YouTube | Replaced with a `youtube-nocookie` iframe. Transport controls are hidden — the embed owns them. |
| Vimeo | Replaced with the official player iframe. Same. |
| `.m3u8` (HLS) | `hls.js`, or native playback on Safari. |
| `.mpd` (DASH) | Plays if the browser supports it natively. |
| Direct `.mp4` / `.webm` | Played directly. |

The concert catalog uses the `local` form throughout; `data/catalog.demo.json`
mixes all of the above. Local entries point at `videos/` files you are expected
to supply — see [`videos/README.md`](videos/README.md) — so the missing-file
path is easy to see.

---

## Editing the catalog

`data/catalog.json` is user data, not build output, and the app now writes it
back directly instead of asking you to download a replacement. In **Edit**
mode (button in the header, or press `E`) every song title becomes an
contenteditable field; **Save to disk** sends a patch to the server.

### The write path

`POST /api/catalog` takes a *patch*, never a document:

```json
{
  "changes": { "mgk-xmas-2017-04": { "song": "Lilac" } },
  "appends": [],
  "removes": []
}
```

On every call the handler re-reads `data/catalog.json` from disk (so a cover
fetch running in the background cannot be clobbered), applies removes, then
appends, then changes by entry id, resolves id collisions with the same `-2`
repair the client uses, writes atomically, and runs
`tools/set-locations.mjs` so `shows.json` is re-derived in the same request.
A `changes` entry whose id is no longer present is reported in `conflicts`
rather than silently dropped.

This route is only served by `tools/serve.js`, and only when
`process.env.PITTV_WRITE !== "0"` (writes are on by default). A static-file
build, or a server started with `PITTV_WRITE=0`, answers `403` and the app
falls back to downloading the patched catalog for you to drop over
`data/catalog.json`.

### The two new fields

Every entry may carry two optional, additive fields that drive clip grouping:

| Field | Purpose |
|---|---|
| `songId` | Stable group key within a show, `${showKey}-${slugify(song)}`. Taken from the field when present, else derived from the song title. Blank when the `song` is blank — the entry is then a singleton and never groups. |
| `clipIndex` | 0-based position within the group. Taken from the field when present, else derived from the `-N` suffix of the id (`mgk-xmas-2017-04` → `3`), or the entry's file index when there is no suffix. |

They are derived on load and live in memory; they are only persisted when a
clip is reordered, an entry is re-saved, or a clip is uploaded. The existing
catalog groups correctly with zero edits because its ids were already built this
way. A persisted value wins over the derived one on load — otherwise a reorder
would be undone the next time the page opened.

`date`, `venue` and `location` belong in `shows.json`, not on the entries —
saving an edit that carries them is a regression, and the write path projects
every entry through `toRawEntry` so they cannot come back.

### Clip groups

Two entries are one card when they share a show key **and** a non-empty
`songId`. Everything else stays a singleton:

- A group of one renders exactly as it did before — no count badge, no reorder
  panel, no synthetic id.
- A clip with a blank `song` never groups. Two untitled clips of one show are far
  more likely to be two different songs than two takes of one; the user groups
  them by giving them a title, and the grouping follows.
- A clip that also declares a `songs` setlist is contradictory (it has a full
  show *and* its own clips). Every clip in the bucket renders ungrouped and a
  `console.warn` names the offending id — collapsing to the setlist alone would
  drop the other clips off the screen entirely. *Any* clip in the bucket
  carrying a setlist disqualifies it, not just the first, so a bucket whose
  setlist sits on a later clip cannot be collapsed by accident.

Grouping runs at the render boundary only (`toGroups` in `assets/js/grouping.js`).
Search, filtering, sorting, scoring and the facet counts still run per entry, so
matching any clip surfaces its group and the relevance order is untouched — only
the render list and the result counter become groups.

A group is a synthetic entry: every field the views read is promoted from the
first clip in user order, plus `clips` and `clipCount`. That is why no renderer
needed rewriting. Its progress bar is `Σ positions / Σ durations` across the
clips, since a group has no single runtime.

Editing a grouped title writes it to **every** clip in the group — the title is
promoted from one clip, so a single write would rename that clip only and the
group would fall apart on the next render.

### Ordering clips

Reordering lives in the player queue panel, not on the card: a card is a
`<button>` and may not contain interactive children.

**Reorder clips** in the panel header reveals ↑/↓ per row (`aria-label="Move clip
2 earlier"`). They are the primary mechanism rather than drag-and-drop because
they are keyboard accessible, work on touch and need no dependency. Moving a
clip swaps the `clipIndex` of the two affected entries and POSTs them to
`/api/catalog` as `{"changes": {"<id>": {"clipIndex": n}}}` — `clipIndex` is the
only field a reorder moves. Swapping rather than renumbering means two users
reordering concurrently converge instead of clobbering each other.

Ordering is a normal user action, not an edit-mode action: the arrows work and
save whether or not titles are being edited. The order on screen is only kept
when the write landed — on a failure (writes disabled, a rejected write, a
locked file) the swap is rolled back and the patch corrected, because a panel
that looks reordered but is not on disk is the exact failure this feature
exists to prevent. A reorder never falls back to handing the user a
`catalog.json` to drop over the real one; that is the right answer for a
deliberate title edit and the wrong one for a press of an arrow key, so the
reorder path reports the refusal instead.

When the write does land, the client re-seeds itself from the `catalog` the
response carries — the file as it now stands — rather than re-fetching
`data/catalog.json`. What the panel shows is then by construction what is on
disk, and a second read that a stale cache could answer differently cannot
unmake the order. `node tools/check-catalog.mjs` reports the grouping and the
persisted order a file produces, which is the quickest way to confirm a
reorder actually stuck.

### Uploads

**Upload** (button in the header) pushes clips from the UI into the archive:

- `POST /api/upload/plan` — the server computes the destination
  (`videos/catalog/<Performance>/<filename>`) and returns the id it will write.
- `PUT /api/upload?path=<…>` — raw file bytes streamed to a `.<ext>.part` temp
  file, renamed into place only after the last byte, so an interrupted upload
  leaves no truncated file.
- `POST /api/upload/commit` — runs the same re-read-merge-write as
  `/api/catalog`, then `set-locations.mjs`, then returns the new entry.

Validation is server-side: an extension allowlist (`mp4`, `mov`, `m4v`, `webm`,
`mkv`), a size cap, and a containment check that rejects `..` and path
separators. Date, venue and location go to `shows.json`; the new catalog entry
does not carry them. Duration is read from the file client-side before upload.

Uploads follow the same rule as every other mutating route: on unless
`PITTV_WRITE=0`.

---

## Features

**Four views**, all sharing the same filter/sort state:

- **Grid** — dense, art-forward cards
- **List** — compact rows with sortable metadata columns
- **Artist** — grouped into collapsible per-artist sections
- **Timeline** — chronological, with sticky year rails

**Filters** (all combinable): artist, venue, album, quality, source, video type,
and a date range. Every active filter is shown as a removable chip.

**Search** across artist, song, album, venue, location, tags, setlist song
titles, and the quality/source/video-type badges shown on each card. So `480p`
and `local` both return results, as well as `akron` for a location.
Whitespace separated tokens must all match; matches are scored so a prefix hit
outranks a mid-word one and highlights are drawn inline. Short queries also try
subsequence matching, so `rdhd` finds Radiohead in the demo catalog and
`kesha scissor` finds Kesha's 2025 show in the concert list.

**Clip groups.** Several takes of one song are one card. A `N clips` badge
replaces the runtime (the summed length stays on the badge's tooltip), and the
row, card and timeline variants all show it. Opening one lists the clips under
the stage in your order, with ↑/↓ buttons to rearrange them. See
[Clip groups](#clip-groups) and [Ordering clips](#ordering-clips).

**Setlists.** A card with a `songs` array reports its song count, and opening it
lists the bill under the stage — each row labelled with its song title, the
playing one marked, and a `Full show` row when the entry also has its own file.
Clicking a row swaps the video without leaving the stage, and the theme follows
the song's art if it has any. Reopening a show resumes the last song watched.

**Album-art theming.** Opening a video samples its cover art on an offscreen
canvas, runs median-cut quantization over the pixels, and derives a palette. The
derived accent is then pushed until it clears 4.5:1 against the derived surface,
so an illegible cover cannot produce an unreadable interface. The morph between
themes interpolates in HSL over 600ms (`easeOutExpo`) rather than sRGB, which
avoids the grey midpoint most colour tweens pass through.

Themes are cached per image, capped at 40 entries.

**Player.** Custom controls, scrub bar with buffered range and chapter ticks,
0.5x–2x playback, Picture-in-Picture, fullscreen, keyboard transport, and
playback-position resume. HLS errors are handled by class (network errors retry,
media errors attempt recovery, anything else stops). Missing files, dead
streams and unsupported codecs each get their own message.

**Persistence.** View mode, filters, sort, sidebar state, settings and per-video
playback positions are kept in `localStorage`; scroll position in
`sessionStorage`. Positions are keyed per playable video, so a setlist keeps one
per song.

**Offline.** `sw.js` precaches the app shell, serves the catalog
stale-while-revalidate, and caches album art up to 300 entries. Video media is
deliberately never intercepted — range requests and large files are the one
thing a naive cache makes worse.

**Reduced motion.** Honoured from the OS by default and overridable in Settings.
Two layers: CSS collapses transitions, and the anime.js helpers return zero
durations so timelines still fire their `complete` callbacks in order instead of
being skipped.

---

## Keyboard

| Key | Action |
|---|---|
| `/` | Focus search |
| `G` | Toggle grid / list |
| `L` `A` `T` | List / artist / timeline view |
| `S` | Toggle the filter sidebar |
| `↑` `↓` `←` `→` | Move between videos |
| `Home` `End` | First / last video |
| `Enter` `Space` | Open the focused video |
| `Esc` | Close player → close shortcuts → close the mobile drawer → clear search |
| `?` | Shortcut panel |
| `Space` `K` | Play / pause (in player) |
| `←` `→` | Seek ∓10s (in player) |
| `↑` `↓` | Volume ∓10% |
| `F` / `M` | Fullscreen / mute |
| `N` / `P` | Playback speed |

---

## Layout

```
pit-tv/
├── index.html                 entry point
├── sw.js                      service worker
├── manifest.webmanifest
├── catalog.json               optional fallback location
├── data/
│   ├── catalog.json           the catalog (the concert list)
│   └── catalog.demo.json      the original sample catalog
├── covers/                    album art (gitignored — generate with `node tools/make-covers.mjs`)
├── videos/                    drop local video files here
├── assets/
│   ├── css/
│   │   ├── variables.css      design tokens + theme variables
│   │   ├── reset.css
│   │   ├── layout.css         app shell, views, responsive rules
│   │   ├── components.css     cards, rows, filters, chips
│   │   ├── player.css         modal, transport, chapters
│   │   └── animations.css     keyframes + reduced-motion overrides
│   └── js/
│       ├── app.js             boot, persistence, service worker
│       ├── store.js           single pub/sub store
│       ├── catalog.js         load, validate, normalise
│       ├── search.js          search / filter / sort (pure)
│       ├── theme.js           colour extraction and theming
│       ├── player.js          player controller + source resolution
│       ├── anime-helpers.js   reusable anime.js timelines
│       └── pwa.js             service worker registration
│   └── icons/
│       └── icon.svg
├── lib/
│   ├── anime.min.js           anime.js 3.2.2 (vendored)
│   └── hls.min.js             hls.js 1.5.17 (vendored)
└── tools/
    ├── serve.js               zero-dependency dev server
    └── make-covers.mjs        regenerates the sample covers
├── Dockerfile                 multi-stage container image
├── docker-compose.yml         local dev / runtime compose
└── .dockerignore              trims build context (videos, git, docs)
```

`store.js` and `pwa.js` are not in the original layout in `instructions.md`.
`store.js` exists so the UI, search, player and theme modules can all import the
state without a circular dependency through `app.js`; `pwa.js` keeps service
worker registration out of the boot path.

No bundler, no build step, no CDN at runtime. `lib/` is committed.

---

## Browser support

Chrome/Edge 111+, Firefox 121+, Safari 16.2+. Requires CSS custom properties and
ES modules. Picture-in-Picture and the File System Access API are used when
present and ignored when not.

The floor is set by two CSS features rather than by ES modules: `:has()` in the
filter checkboxes (`components.css`) needs Firefox 121+, and `color-mix()` in the
edit-mode title field (`edit.css`) needs Chrome 111+, Firefox 113+ and Safari
16.2+. Below these the relevant declarations are dropped rather than breaking the
page, so `:has()` loses the checked-filter styling and `color-mix()` loses the
field tint and focus ring. Everything else in the app works on much older
browsers; these two are what the stated floor is paying for.

---

## Notes

- `covers/*.svg` are generated placeholders (`node tools/make-covers.mjs`), one
  per catalog entry with a deliberately distinct hue so the theming is visible.
  Replace them with real art and remote images will work too — but note that
  colour extraction needs `Access-Control-Allow-Origin` on the image host,
  otherwise the canvas is tainted and the app falls back to a neutral palette.
- `data/catalog.demo.json`'s cloud sources point at public test streams and CC0
  clips so that catalog is usable immediately. They are not the real
  performances.
- The concert catalog carries no `venue` or `metadata`. Fill them in as you go —
  `venue`, `metadata.quality` and `metadata.source` are what turn the sidebar
  from "Unknown venue (25)" into something worth filtering.
- The concert catalog has no setlists yet, because the concert list does not
  record one. Add a `songs` array to a show once you have the individual files
  (see [Setlists](#setlists)); the card then shows a song count and opens on the
  setlist. `data/catalog.demo.json` has two worked examples — one with a
  `Full show` file *and* six songs, one with songs only.
- Personal use, no warranty.
