# videos/

Local video files, pointed at by a catalog entry:

```json
"video": {
  "type": "local",
  "src": "videos/2019/blink-182-2019.mp4",
  "duration": 789
}
```

`src` is resolved relative to the project root, so a `videos/filename.mp4` path
is the form to use. Absolute paths and `file://` URLs also work.

## The `catalog/` layout

Anything added from the app's **Upload** panel lands here, alongside the media
that was already filed this way:

```
videos/catalog/<Performance>/<filename>
```

```
videos/catalog/
├── Halsey/IMG_2520.MOV
└── $uicideboy$/2023 $uicideboy$ Grey Day Tour w Ghostemane.../IMG_4471.MP4
```

One folder per performance, one file per clip — the folder is the `performance`
form field, and it becomes the slug half of the new entry's `id`. The real
catalogue's show folders are much longer than the `id` slugs
(`grey-day-tour` vs. `$uicideboy$ Grey Day Tour w Ghostemane`); that is
deliberate. A folder name is a label, an `id` is a join key, and `showKeyFor`
matches the two by stripping the trailing `-NN` from the id:

```
videos/catalog/Grey Day Tour/IMG_4471.MP4
  -> id "grey-day-tour-04"
  -> showKeyFor("grey-day-tour-04") === "grey-day-tour"   (catalog.js:373)
  -> shows.json row "grey-day-tour" carries the date, venue and location
```

So the folder can be renamed to whatever reads best without breaking the join,
as long as the id is left alone.

A clip's number is the next free one for that show, zero-padded to match the
ids already on disk (`grey-day-tour-04`, then `-05`).

### Never overwritten

A file whose name is already taken gets `-2`, `-3` and so on **before** the
extension:

```
IMG_4471.MP4  ->  IMG_4471-2.MP4  ->  IMG_4471-3.MP4
```

The existing file is a multi-gigabyte clip that is already in the catalog under
its own `id`, so overwriting is never an option — the two entries would end up
pointing at one file. The collision rule is applied server-side at plan time
(`tools/serve.js`, `uniqueFilename`), which is also why the app never picks the
name itself: it is told the destination and told the `id` that will actually be
written.

### Case is preserved

The extension keeps the case it arrived with. The tree mixes `.MOV` and
`.MP4`, and `video.src` is an exact string — a case-folding rename would break
every entry pointing at the old name. The rest of the name is sanitised
(`/\:*?"<>|` and control characters stripped, whitespace collapsed, trimmed to
120 characters), and a segment that reduces to nothing is rejected rather than
silently replaced.

### Interrupted transfers

Bytes are written to `<name>.<ext>.part` in the destination folder and renamed
into place only after the last one arrives. A dropped connection mid-transfer
leaves a `.part` file, never a truncated video that the catalog points at. The
`.part` files are safe to delete.

## Uploading from the app

Start the server with writes enabled:

```bash
PITTV_WRITE=1 node tools/serve.js 3000
```

Then **Upload** in the header. Three requests per file, all on `tools/serve.js`:

| Step | Route | What it does |
|---|---|---|
| Plan | `POST /api/upload/plan` | Validates the metadata and picks the path, filename and id. |
| Transfer | `PUT /api/upload?path=…` | Raw bytes, streamed to the `.part` file. |
| Commit | `POST /api/upload/commit` | Appends the catalog entry and re-derives `shows.json`. |

The size cap is `PITTV_MAX_UPLOAD_MB`, default 40960 (40 GB). A full set of a
long show will pass; raise it if it does not:

```bash
PITTV_MAX_UPLOAD_MB=81920 PITTV_WRITE=1 node tools/serve.js 3000
```

Accepted formats: `mp4`, `mov`, `m4v`, `webm`, `mkv`.

**Date, venue and location go to `shows.json`, not onto the entry.** They
describe the show, not each clip in it, and `tools/set-locations.mjs` reports a
catalog entry carrying them as a bug (it will say so after the upload if a stale
editor buffer put them back).

Without `PITTV_WRITE=1` the three routes answer 403 and the panel says so rather
than failing quietly — the files are on the user's computer either way, and
losing a silent multi-gigabyte transfer to a missing env var is the worst
possible outcome.

## What the concert catalog expects

`data/catalog.json` is the concert list. Entries added by hand can point
anywhere, but the conventional layout is one folder per show:

```
videos/
├── 2016/tdd-2016.mp4
├── 2017/korn-2017.mp4
├── 2017/mgk-xmas-2017.mp4
├── …
└── 2026/mgk-day-2026.mp4
```

Nothing in that tree is committed, so out of the box every entry reports:

```
File not found: videos/2019/blink-182-2019.mp4
```

Drop the file in under the name the catalog asks for and the same entry plays.
Any other name works too — just edit `video.src`. Renaming the file does not
lose your saved playback position; the entry `id` is what tracks that, and it
does not change when you repoint `src`.

## One file per song

When a show is split into individual songs, give the entry a `songs` array and
point each song at its own file — a folder per show keeps it tidy:

```json
{
  "id": "mgk-day-2022",
  "artist": "Machine Gun Kelly",
  "song": "MGK Day Festival Year 1",
  "date": "2022",
  "songs": [
    { "title": "Intro", "video": { "src": "videos/2022/mgk-day-2022/01-intro.mp4" } },
    { "title": "Name In Locker", "video": { "src": "videos/2022/mgk-day-2022/02-name-in-locker.mp4" } }
  ]
}
```

```
videos/2022/mgk-day-2022/
├── 01-intro.mp4
└── 02-name-in-locker.mp4
```

The `type` is optional for a local path — a relative path is assumed. If the show
also has a full-set file, keep the entry's own `video` next to `songs` and it is
offered as a `Full show` row above the songs.

PIT TV issues a `HEAD` request for local entries before handing the path to the
`<video>` element, so a missing file produces that message rather than the
browser's misleading "This source is not supported by your browser."

Two entries in `data/catalog.demo.json` also point at files that are deliberately
absent, for the same reason:

```
File not found: videos/GD-1995-03-24-ScarletBegonias.mp4
```

## Formats

Anything the browser can play natively works: MP4 (H.264/AAC), WebM (VP8/VP9 +
Opus), and MOV in Safari. HLS (`.m3u8`) and DASH (`.mpd`) streams are handled
too — put the playlist URL in `src` and set `"type": "cloud"`.

Long shows are better split than concatenated. Give each song its own catalog row
via the `songs` array above, and each gets its own scrub position, resume point
and setlist row.

## Serving

Run the included server rather than opening `index.html` directly:

```bash
node tools/serve.js 3000
```

It supports HTTP range requests, so seeking inside a large file works.

## A note on the file itself

None of this folder's contents are committed. Video files are large and may be
copyrighted; keep your own copies here and keep the folder out of version
control if you publish the repository.
