# PIT TV — Implementation instructions: clip grouping, in-UI upload, direct JSON writes

Status: **not started**. This is a build spec, derived from the three requests that
used to be the whole of this file. They are quoted verbatim at the top; everything
below is what to actually implement.

---

## Source requests (verbatim)

> 1. If there are multiple clips of the same song from the same performance, group
>    them automatically in all of the views into a single card and when viewing
>    them, allow the user to set the correct order of the clips and save that order
>    for the future.
>
> 2. I need the ability to fully upload clips inside of the ui and map out its
>    artist, song title, album, performance, venue, and date and have it save into
>    the server's directory to be used forever in the future.
>
> 3. I need the edit function to directly rewrite the json files instead of using
>    an export function.

Requests 1–3 map to Features A, B and C below. **Build them in the order C → B → A**;
C is the write path everything else needs, and B is just the first caller of it.

---

## Ground rules (read before writing any code)

This project is deliberately zero-dependency, zero-build and framework-free. The
instructions below are written so that an implementer cannot quietly break that.

| Rule | Why it exists |
|---|---|
| **No npm dependencies, no bundler, no build step.** Native ES modules served as files. | The whole server is `node:http` + `node:fs` (`tools/serve.js:11-15`) and the Dockerfile synthesises a stub `package.json` purely to enable `import` syntax. Adding Express/multer breaks the Docker build and the "no toolchain" promise. |
| **Server-side work is hand-rolled in `tools/serve.js`.** No Express, no multer. | There is no dependency tree to add to. |
| **Client work is new ES modules under `assets/js/`, imported by `ui.js`/`app.js`.** | Matches `store.js` / `search.js` / `sync.js` / `edit.js`. |
| **Every untrusted string goes through `escapeHtml` (`search.js:198`).** | `ui.js` renders catalog data with `innerHTML`; the header comment at `ui.js:2-7` makes this a hard rule. |
| **Cards and rows are `<button>`, so they may only contain phrasing content.** | Called out in the comments at `ui.js:292-293` and `ui.js:344-345`, and again at `ui.js:557-558` where `.card-tags` is a `span` rather than a `div`. **No nested interactive controls inside a card.** This is why clip reordering lives in the player queue panel, not on the card. |
| **Comment WHY, not WHAT.** The existing files are dense with rationale comments. Match that. | `catalog.js:83-88`, `set-locations.mjs:99-103`, `atomic-json.mjs` are the reference style. |
| **Every server path operation is contained inside `ROOT`.** | `tools/serve.js:166-171`. Copy this check verbatim for every new endpoint that touches the filesystem. |
| **Every JSON write is atomic.** | `tools/atomic-json.mjs` — write temp file, then `renameSync`. |
| **Preserve, don't rewrite.** | Local edits inside existing files; new code goes in new files. |

### Known issues to fix while you are in here

1. **`writeJsonAtomic`'s signature is wrong.** `tools/atomic-json.mjs` declares
   `(path, value, replacer = null, space = 2)`, but `tools/set-locations.mjs:179` calls
   it as `writeJsonAtomic(CONFIG, current, { trailingNewline: true })` — the object lands
   in the `replacer` slot, where `JSON.stringify` ignores it, so **no trailing newline is
   ever written** and the third argument silently does nothing. Every new write path
   (B and C) depends on this helper, so fix it first: change the signature to
   `writeJsonAtomic(path, value, { replacer = null, space = 2, trailingNewline = false } = {})`
   and update the one existing call site. `JSON.parse` tolerates a missing trailing
   newline, so this changes no behaviour — it just stops the next caller from repeating
   the mistake.

2. **The service worker's precache list is incomplete.** `sw.js:24-46` omits
   `assets/js/edit.js` and `assets/js/sync.js` entirely. Add those, add every new module
   from Features A and B, and bump `VERSION` (`sw.js:18`, currently `pittv-v15`) in the
   same change that touches any of them. A stale shell cache will otherwise serve a
   pre-feature build to an installed PWA and look like a failed implementation.

3. **`docker-compose.yml` does not mount `./data`.** The mount is commented out
   (`docker-compose.yml:11`), so in Docker `data/catalog.json` lives inside the container
   and is destroyed on rebuild. Features B and C are explicitly about data that is
   "used forever in the future" — **if the deployment is Docker, uncomment the `./data`
   mount as part of this work.** The `./videos` mount is already there and is what makes
   Feature B's uploads durable. Say so in `README.md`.

4. **The write endpoints are unauthenticated on a published port.** `HOST` defaults to
   `0.0.0.0` (`tools/serve.js:19`) and `docker-compose.yml:6` publishes `3500:3000`.
   Today every `/api/*` route is a read-mostly maintenance action; the new ones in
   Features B and C write arbitrary files. Gate all mutating routes behind
   `process.env.PITTV_WRITE === "1"` (default **off**, and log a clear warning at boot
   when an upload/write request arrives while it is off), and default `HOST` to
   `127.0.0.1` unless overridden. Dev ergonomics are preserved — the browser talks to
   `localhost` — and the archive stops being remotely writable.

---

## Data model changes (all three features)

Two optional fields are added to a catalog entry. Both are **optional and additive**:
`normaliseEntry` must keep working when they are absent, so an existing
`data/catalog.json` loads unchanged.

```jsonc
{
  "id": "mgk-xmas-2017-04",       // existing; showKeyFor() strips "-04" -> the show
  "artist": "Machine Gun Kelly",
  "song": "Lilac",                 // the shared song title for this clip group
  "songId": "mgk-xmas-2017-lilac", // NEW: stable group key within the show
  "clipIndex": 3,                  // NEW: 0-based position within the group
  "video": { "type": "local", "src": "videos/catalog/MGK/IMG_2878.MOV", "duration": 268 }
}
```

**Why `songId` on the entry rather than a separate order file:** clip order is a
property of the clip, it changes far more often than any show-level fact, and the
server already has to rewrite `catalog.json` for Feature C anyway. A separate
`data/groups.json` would mean a second file that can disagree with the catalog, and
one more thing to keep in sync. `shows.json` stays the home of show-level facts
(`date`, `venue`, `location`) exactly as `tools/set-locations.mjs` documents.

**Derivation when the fields are absent** (in `catalog.js`, after `normaliseEntry`):

- `songId` = `${showKey}-${slugify(song)}` when `song` is non-empty; otherwise the entry
  is a **singleton** — it forms its own group of one and is not shown as groupable.
  Reuse the existing `slugify()` at `catalog.js:108`; do not add a second implementation.
- `clipIndex` = the integer parsed from the `-N` suffix of the id when there is one
  (`"mgk-xmas-2017-04"` → `3`), else the entry's index in the file. This means the
  **existing 198-entry catalog groups correctly with zero edits**, because the ids were
  already built this way.

Derivation must be **pure** — it may not write to the file. It runs on load and its
result lives in memory; it is only persisted when the user actually reorders something
(Feature A) or the entry is re-saved (Feature C).

---

## Feature C — Edit rewrites the JSON files directly

*Request 3. **Do this first.** A and B both depend on it.*

### C.1 The trap: `state.catalog` is not the file

`state.catalog` holds the output of `normaliseEntry` (`catalog.js:121-190`), which has
**added keys the file on disk does not have** — `datePrecision`, `dateRaw`, a fully
populated `metadata` object, an always-present `songs: []`, `venue` defaulted to
`"Unknown venue"`. The current `saveCatalog()` at `edit.js:96-99` serialises
`state.catalog` directly.

Once that write becomes a real file write instead of a download, that stops being a
cosmetic difference: **the first save would bake normalised defaults into all 198
entries**, and `tools/set-locations.mjs:201-214` (`reportDuplicates`) would then start
warning about fields that were never there. Worse, the same code path would happily
re-add `date`/`venue`/`location` copies that the whole shows.json split was designed to
eliminate.

**Requirement C.1.1** — keep the raw parsed document. In `loadCatalog`
(`catalog.js:376`), stash the untouched parsed array (e.g. `setRawCatalog(raw)` in
`store.js`, held in module scope in `catalog.js`) alongside the normalised entries.
Edits mutate the normalised entry for rendering, and are **projected back onto the raw
record** by id at save time through a `toRawEntry(entry)` function that emits only the
on-disk field set, omitting `datePrecision` (derived) and omitting `songs` when empty.

### C.2 The trap: another process owns the file

`catalog.js:520-550` fires `POST /api/fetch-covers` on every load, and
`tools/fetch-album-art.mjs` **rewrites `data/catalog.json` in the background** to fill in
`albumArt`. `tools/set-locations.mjs` also rewrites `shows.json` on boot
(`tools/serve.js:230-243`). A blind `PUT` of the client's copy can therefore clobber
cover art the user waited seconds for — and would do so silently.

**Requirement C.2.1 — the server merges, it never overwrites.** `POST /api/catalog` takes
a *patch*, not a document:

```jsonc
{
  "changes": { "mgk-xmas-2017-04": { "song": "Lilac", "clipIndex": 3 } },  // by entry id
  "appends": [ /* fully-formed raw entries, from Feature B */ ],
  "removes": ["some-id"]
}
```

The handler must, on every call: (1) re-read `data/catalog.json` from disk with a
BOM-tolerant reader — copy `readJsonFile` from `tools/set-locations.mjs:69-71`; (2) apply
`removes`, then `appends`, then `changes`; (3) resolve **id collisions on append** with
the same `-2`, `-3` repair `normaliseEntry` does at `catalog.js:140-145`, so two uploads
in the same show never collide; (4) write with `writeJsonAtomic`; (5) run
`tools/set-locations.mjs` via the existing `spawnChild` helper (`tools/serve.js:53`) so
`shows.json` is re-derived in the same request — exactly what `/api/sync-shows` already
does; (6) respond with `{ ok, changed, conflicts, catalog }` where `catalog` is the file
as it now stands.

A `changes` entry whose id is no longer present is reported in `conflicts` rather than
silently dropped, and surfaced in the UI.

### C.3 What changes on the client

Rewrite `saveCatalog()` in `assets/js/edit.js:95-147`:

- Replace the `showSaveFilePicker` / `<a download>` block with
  `POST /api/catalog` carrying the patch from C.2.1.
- On success: `setCatalog` re-seeded from `response.catalog` via the existing
  `loadCatalog` normalisation path, `setFacets(buildFacets(entries))` recomputed, dirty
  flags cleared, `toast("Catalog saved", "success")`.
- On `409` or a non-empty `conflicts`: a warn toast naming the conflicting ids; do **not**
  clear the dirty flag.
- **Keep the old download path as the fallback** when the request fails because the
  endpoint does not exist (a plain static host). This matches the existing tolerance in
  `triggerServerSync` (`catalog.js:489-510`), which already explains that
  `/api/*` is "only served by `tools/serve.js`". Say so in the toast — do not pretend the
  write landed.
- Keep `withWriteLock` (`sync.js:157-161`) around the request so a save and a reorder
  save cannot race.
- **Delete** the client-side `writeShows()` call at `edit.js:134-140`. `shows.json` is
  derived server-side now; the browser must never write it. `sync.js:110-139` is then
  unused by `edit.js` — remove the export only if nothing else imports it, and leave
  `withWriteLock` and `reconcileShows` in place (the client still reconciles in memory to
  keep the UI honest when the server is unavailable).
- The progress counter in the edit bar (`edit.js:80-85`) is now counting pending *patch
  entries*, not files; relabel `data-edit-total` in `index.html:106` accordingly, or drop
  the fraction and show a plain "N changes" count.

---

## Feature B — Upload clips from the UI

*Request 2.*

### B.1 Transport: raw body, not multipart

`fetch` cannot stream a `File` with progress, and a `FormData` upload would need a
multipart parser written from scratch. Do neither:

- **Plan** — `POST /api/upload/plan`, `Content-Type: application/json`. Body: the
  metadata from the form plus `{ filename, size, extension }`. The server computes the
  destination and returns `{ ok, folder, filename, src, id, showId, songId, clipIndex }`.
  Doing the path computation server-side means the client can never ask for a path
  outside `videos/`, and the returned `id` is the one that will actually be written.
- **Transfer** — `PUT /api/upload?path=<relative path under videos/>`, body is the raw
  `File` bytes, `Content-Type: application/octet-stream`. Send it with
  `XMLHttpRequest` rather than `fetch` so `xhr.upload.onprogress` can drive a real
  percentage; concert video is multi-gigabyte and a progress bar is not a nicety here.
  Stream the request body to a `.<ext>.part` temp file in the destination directory and
  `renameSync` it into place only after the last byte arrives, so an interrupted upload
  never leaves a truncated file that the catalog would point at.
- **Commit** — `POST /api/upload/commit`, JSON: the plan result plus any fields the user
  edited after planning. Runs the same re-read-merge-write sequence as C.2, then
  `set-locations.mjs`, then returns the new entry.

Validate on the server: extension allowlist (`mp4`, `mov`, `m4v`, `webm`, `mkv`), a
configurable size cap, `path` must resolve inside `videos/` (reuse the containment check
at `tools/serve.js:166-171`), and reject a filename containing `..` or a path separator.
Refuse to overwrite an existing file: append `-2`, `-3` before the extension.

### B.2 Destination path

```
videos/catalog/<Performance>/<filename>
```

which is the layout the existing media already uses (`videos/catalog/Halsey/IMG_2520.MOV`,
`videos/catalog/$uicideboy$/2023 $uicideboy$ Grey Day Tour w Ghostemane.../`).

The `performance` form field is the folder name. Sanitise each path segment server-side:
strip `/\:*?"<>|` and control characters, collapse runs of whitespace, trim to 120
characters, and reject the segment entirely if it reduces to empty. **Preserve the file
extension's original case** — the existing tree mixes `.MOV` and `.MP4` and a
case-folding rename would break `video.src` references elsewhere. If `performance` is
blank, fall back to the artist name.

The new entry's `id` is `<showSlug>-<NN>` where `NN` is the next free clip number for
that show, so `showKeyFor` (`catalog.js:306`) resolves it to the right show without
change. `songId` and `clipIndex` are filled from the same derivation as Feature A, so a
clip uploaded as "the second take of Lilac" lands in the right group on the first load.

### B.3 Which file each field goes in

This matters, because `tools/set-locations.mjs:201-214` actively reports catalog entries
that carry show-level fields as a bug.

| Form field | Destination | Notes |
|---|---|---|
| Artist | `catalog.json` entry `artist` | Required. |
| Song title | `catalog.json` entry `song` | May be blank — the entry then forms a singleton group. |
| Album | `catalog.json` entry `album` | Optional. |
| Performance | the destination folder name, and the slug half of the entry `id` | |
| Date | **`shows.json`** | ISO `YYYY-MM-DD` or a bare `YYYY`. The tool rejects anything else (`set-locations.mjs:280`) — validate in the form, not after. |
| Venue | **`shows.json`** | |
| Location | **`shows.json`** | The existing `/api/set-show` route (`tools/serve.js:111-124`) already takes all three; route the form through it. |
| Duration | `catalog.json` `video.duration` | Read client-side from an object URL before upload (`<video>.duration`), not asked of the user. |
| Quality / source | `catalog.json` `metadata.quality` / `metadata.source` | `QUALITY_ORDER` and `SOURCE_VALUES` at `catalog.js:19-20` are the allowlists; populate the selects from them. |

A `date`, `venue` or `location` written onto the catalog entry is a regression against
the file split the project already made — the commit step must not do it.

### B.4 Client module

New file `assets/js/upload.js`:

- `initUpload({ onCommitted })` — wires a new `[data-upload-open]` button in the header
  (`index.html`) to a `<dialog>`-style panel. Follow the existing overlay conventions:
  `hidden` attribute, `role="dialog"`, `aria-modal`, Escape to close, focus restore on
  close. The settings popover at `index.html:64-86` and the shortcuts overlay at
  `index.html:216-239` are the reference patterns.
- The form is a plain `<form>` with labelled inputs. No framework, no form library.
- Datalist or `<select>` suggestions for artist/album from `state.facets` — the facet
  counts are already built (`catalog.js:562-587`) and this is free.
- On a successful commit: toast, then **reload**. The entry must pass through
  `normaliseEntry` before it is renderable, and `loadCatalog` is the only code that does
  that. `location.reload()` is correct and cheap here; pushing the raw record into
  `state.catalog` is not, and will produce a card missing `datePrecision`.
- One-shot file input is not enough — allow selecting several files to upload against the
  same show metadata in sequence, with a per-file row showing progress and result. This
  is the common real case: 14 phone clips of one show at once.
- Every failure must say what failed, why, and what to do next. Match the existing tone
  in `catalog.js:504-506`. A silent no-op here loses a multi-gigabyte transfer.

### B.5 Card and CSS

New `assets/css/upload.css` (add the `<link>` to `index.html` next to `edit.css`), using
the tokens in `assets/css/variables.css` — `--card`, `--border`, `--theme-primary`,
`--text-dim`, `--dur`, `--ease-out-expo`. Match `.edit-bar`'s density
(`edit.css:44-53`); it is the closest existing piece of chrome to a status bar.

---

## Feature A — Group clips of the same song into one card, orderable

*Request 1. **Do this last** — it is the most invasive and it rides on C.*

### A.1 The key architectural move: a group is a synthetic entry

`ui.js` renders one `entry` per card/row, and reads exactly these fields:
`id`, `artist`, `song`, `album`, `venue`, `date`, `datePrecision`, `location`,
`albumArt`, `tags`, `metadata.quality`, `metadata.source`, `video.{duration,type,src}`,
`songs`. (Card: `ui.js:290-325`. Row: `ui.js:343-368`. Timeline item: `ui.js:458-475`.)

**If the group object quacks like an entry, every renderer keeps working.** That is the
whole strategy — it is why this feature does not require rewriting the views.

New file `assets/js/grouping.js`:

```js
/**
 * Collapse the ordered result of the query pipeline into renderable groups.
 *
 * A group is a synthetic entry: every field the views read is promoted from the
 * group's representative clip, plus `clips` (ordered) and `clipCount`. A group of
 * one is indistinguishable from a plain entry, so nothing downstream has to
 * special-case the common case.
 */
export function toGroups(entries) { /* ... */ }

/** Playable rows for a group, in user order — the same shape setlistFor returns. */
export function groupRowsFor(group) { /* ... */ }
```

A group is:

```js
{
  id: "<showId>~<songId>",   // unique across the catalog
  showId, songId,
  isGroup: true,
  clips: [entry, ...],        // ordered by clipIndex, tie-broken by the current sort
  clipCount: clips.length,
  // promoted from the representative clip (index 0 — the first in user order):
  artist, song, album, venue, date, datePrecision, location, albumArt, tags, metadata,
  video, chapters,
  songs: [],                  // a clip group is not a setlist
}
```

`groupRowsFor(group)` returns `clips.map(c => ({ id: c.id, title: c.song || "Untitled", song: c }))`.
Feed that to the existing `playableEntry()` (`catalog.js:272-283`), which already merges
a song-shaped object into its show — so the player, resume positions, theming, chapter
rail and "Song n of m" facts all work without a change.

### A.2 Where grouping runs

Insert one step between the query pipeline and the renderers, in `render()`
(`ui.js:134-163`):

```js
const { entries } = queryCatalog(state.catalog, { ... });   // unchanged
const groups = toGroups(entries);                            // new
...
nodes = renderEntries(groups, container);
setFiltered(groups);
```

Search, filtering, sorting, scoring and the facet counts all continue to operate on
**entries** — matching any clip surfaces the group, and the existing relevance ordering is
untouched. Only the render list becomes groups. The result counter (`ui.js:700`) should
count groups, since that is what the user sees.

Two consequences to handle explicitly:

- **`upNextEntries` (`ui.js:889-893`)** does `state.filtered.findIndex(e => e.id === entry.id)`.
  It now operates on groups. A group opens via its first clip; make `openEntry` resolve
  `group.clips[0]` before calling `playRow`, and the existing `id` comparison keeps working.
- **The FLIP animation and roving focus key off `data-entry` / `data-id`**
  (`ui.js:264-273`, `ui.js:919`). Set both to the **group id**, not the representative
  clip id, or sorting/filtering will animate individual clips that are no longer on screen.

### A.3 Card, row, and timeline rendering

- **Grid card** (`renderCard`, `ui.js:290`): unchanged markup, plus a clip-count badge
  when `clipCount > 1`. Reuse `.card-duration`'s existing `data-songs` treatment
  (`components.css:91`) rather than inventing a badge — render `3 clips` there in place of
  the duration, and keep the duration on the title attribute. The card is a `<button>`,
  so **no reorder arrows go on it**.
- **List row** (`renderRow`, `ui.js:343`): `lengthCell()` (`ui.js:328-332`) already
  branches on a setlist count; add the clip-count branch beside it.
- **Timeline item** (`ui.js:458`): same, via `timelineBadge()` (`ui.js:335-339`).
- **Artist view** (`renderArtistView`, `ui.js:372`): groups flow through unchanged because
  `toGroups` runs before the artist grouping. Verify the section counts read sensibly.
- **Card progress bar** (`ui.js:319`): a group has no single duration. Use
  `Σ positions / Σ durations` across `clips`, so partially-watched multi-clip groups show
  a truthful bar.

### A.4 Editing a grouped title

`attachEditableListeners` (`ui.js:505-542`) writes `entry[field] = value` on
`state.catalog.find(e => e.id === entryId)`. For a group, `entry.song` is promoted from
the representative clip, so a single write would rename one clip and the group would fall
apart on the next render.

**Requirement A.4.1** — when `editableTitle` is given a group, write the new title to
**every clip in the group**, then `markDirty()`. Same for the empty-title case
(`edit.css:37-41` shows "Untitled" via `::before`; a group whose clips have no title
should show the same). Non-title fields are not editable yet and need no change.

### A.5 Ordering the clips

Reordering happens in the player queue panel, not on the card, because a card may not
contain interactive children.

`renderQueuePanel` (`ui.js:832-887`) currently renders a setlist as
`<ol class="setlist-list">` of `<button class="setlist-item">` buttons. Add a parallel
branch for groups:

- Header: `Clips <span class="sl-count">3 clips</span>` plus a small
  `Reorder clips` toggle button.
- In reorder mode each row gains ↑/↓ buttons (`<button>`, `aria-label="Move clip 2 earlier"`).
  **Use ↑/↓ buttons as the primary mechanism, not drag-and-drop** — they are keyboard
  accessible, they work on touch, and they need no dependency. Drag handles may be added
  later as an enhancement.
- Moving a clip swaps the `clipIndex` values of the two affected entries and calls
  `markDirty()`. Re-render the panel from the new order; do not mutate the DOM in place,
  or the next `renderModalInfo` will disagree with it.
- When the group is showing and the user is **not** in edit mode, the ↑/↓ buttons still
  work and still persist — ordering is a normal user action, not an edit-mode action. The
  guard at `ui.js:726` (`if (editState.isEditing()) return;`) applies to *opening* a clip,
  so it does not block this.
- Saving goes through Feature C's `POST /api/catalog` as
  `{"changes": {"<id>": {"clipIndex": n}}}`. `clipIndex` is the only field that moves.
- **Survive a reload**: after the save resolves, the in-memory `state.catalog` must be
  refreshed from the response (C.3) so the order the user sees is the order on disk. A
  group that looks reordered but is not persisted is the exact failure this feature
  exists to prevent — verify it by reloading.

### A.6 Auto-grouping rules

Group when **all** of these hold:

1. Same show key (`showKeyFor(id)`, `catalog.js:306`).
2. Same non-empty `songId`.
3. **At least two clips.** A group of one renders and behaves exactly as today — no count
   badge, no reorder panel, no `Full show` row.

Entries whose `song` is empty are **singletons** and are never auto-grouped. Do not
guess: two untitled clips of the same show are far more likely to be two different songs
than two takes of one. The user groups them by giving them a title, and the grouping
follows.

A group of clips that also declares a `songs` setlist is a contradictory state. Render the
setlist and ignore the group ordering, and log a warning naming the id.

---

## File-by-file change list

| File | Change | Feature |
|---|---|---|
| `tools/serve.js` | `POST /api/catalog` (patch-merge), `POST /api/upload/plan`, `PUT /api/upload`, `POST /api/upload/commit`, optional `DELETE /api/entry`. `PITTV_WRITE` gate. Loopback `HOST` default. | B, C |
| `tools/atomic-json.mjs` | Fix the signature; support `trailingNewline`. | shared |
| `tools/set-locations.mjs` | Update the one `writeJsonAtomic` call site. | shared |
| `assets/js/store.js` | `setRawCatalog` / `rawCatalog` (or a module-scope raw in `catalog.js`); `setClipOrder` helper if the patch is built here. | C |
| `assets/js/catalog.js` | Derive `songId` / `clipIndex` in normalisation; stash the raw doc; `toRawEntry()` projection; import `toGroups` at the render boundary. | A, C |
| `assets/js/grouping.js` | **New.** `toGroups()`, `groupRowsFor()`. | A |
| `assets/js/upload.js` | **New.** `initUpload()`, XHR transfer, the form. | B |
| `assets/js/edit.js` | Replace the picker/download with `POST /api/catalog`; keep the download as the static-host fallback; drop the `writeShows` call. | C |
| `assets/js/sync.js` | Remove `writeShows` if now unused. Keep `reconcileShows`, `withWriteLock`. | C |
| `assets/js/ui.js` | `render()` groups; clip-count badges; group-aware progress; `editableTitle` writes every clip; queue-panel reorder UI; `upNextEntries` resolves `clips[0]`. | A |
| `assets/js/app.js` | `initUpload({ ... })` on boot; expose on `window.pittv`. | B |
| `index.html` | Upload button + panel markup, form fields, `<link>` for `upload.css`, edit-bar relabel. | A, B |
| `assets/css/upload.css` | **New.** | B |
| `assets/css/components.css` | Clip-count badge variants, reorder control styling. | A |
| `sw.js` | Add `edit.js`, `sync.js`, `grouping.js`, `upload.js`, `upload.css`; bump `VERSION`. | all |
| `docker-compose.yml` | Uncomment the `./data` mount. | B, C |
| `README.md` | Document the new endpoints, `PITTV_WRITE`, the new catalog fields, the group/order model. | all |
| `videos/README.md` | Document the upload destination layout and the collision rule. | B |

---

## Verification

There is no test runner, linter or typechecker in this repo — `package.json` does not
exist in the source tree, and `QA_REPORT.md` documents manual Playwright/Chrome DevTools
QA. Follow `e2e_test.md` (QA-SOP-004) for the pass: pre-flight checklist, execute, file a
bug report per issue. Add a `tools/check-catalog.mjs` diagnostic in the style of
`tools/check-sync.mjs` that reports: entries missing `songId`/`clipIndex`, groups whose
clips disagree on `song`, groups with duplicate `clipIndex` values, entries whose
`video.src` does not exist on disk, and any entry that regressed into carrying
`date`/`venue`/`location` itself.

**Feature C**
- [ ] Edit a song title, save, reload → the change is in `data/catalog.json` on disk, and the file did **not** gain `datePrecision`/`songs` on entries that lacked them.
- [ ] Kick off `/api/fetch-covers` to fill cover art, then save an edit → the new `albumArt` values are still there afterwards. This is the C.2 race; it must not regress.
- [ ] `shows.json` is updated by the same request, and the browser never writes it.
- [ ] Serve the app from a static host (no `/api/catalog`) → the save falls back to the old download and the toast says so.
- [ ] Write a `changes` patch for an id that no longer exists → the id is named in the UI, and the save is not reported as clean.
- [ ] A second browser tab has the catalog open, saves, and the first tab's save does not silently revert the second tab's work.

**Feature B**
- [ ] Upload a 2 GB `.MP4` → progress bar advances, file lands at `videos/catalog/<Performance>/<filename>`, the `videos/` volume mount means it survives a container rebuild.
- [ ] Upload a file whose name collides → `-2` is inserted before the extension, and `video.src` matches the file that is actually on disk.
- [ ] Upload with a `..` in the performance field and in the filename → both are rejected with a clear message; nothing is written outside `videos/`.
- [ ] Kill the server mid-upload → no truncated file is left, and no catalog entry points at one.
- [ ] Date/venue/location go to `shows.json`; the new catalog entry does **not** carry them. `node tools/set-locations.mjs` reports no duplicates.
- [ ] Duration is filled in automatically; the card shows it without the user typing anything.
- [ ] Upload three files with the same song title in one batch → one group, three cards' worth of clips, orderable.
- [ ] `PITTV_WRITE` unset → upload and save are refused with a message naming the env var.

**Feature A**
- [ ] A show with 4 clips of one song renders as **one** card in grid, list, artist and timeline, with a `4 clips` badge.
- [ ] A show with clips of three different songs renders as three cards.
- [ ] Two untitled clips of one show stay as two cards.
- [ ] Reorder the clips in the player, reload the page, reopen → the order survived.
- [ ] The existing 198-entry catalog groups correctly with no manual edits (the `-N` id suffix drives `clipIndex`).
- [ ] Editing the title of a grouped card renames every clip in the group.
- [ ] Search "lilac" surfaces the group once; the result count counts groups; arrow-key navigation steps group by group; sorting and filtering do not leave orphaned clip nodes in the FLIP animation.
- [ ] A group of one behaves exactly as it did before: no count badge, no reorder panel.
- [ ] Reduced-motion is respected by the new panel's animations.
