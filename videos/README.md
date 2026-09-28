# videos/

Drop local video files here and point a catalog entry at them:

```json
"video": {
  "type": "local",
  "src": "videos/2019/blink-182-2019.mp4",
  "duration": 789
}
```

`src` is resolved relative to the project root, so a `videos/filename.mp4` path
is the form to use. Absolute paths and `file://` URLs also work.

## What the concert catalog expects

`data/catalog.json` is the concert list, and every entry points at
`videos/<year>/<id>.mp4` — one folder per year, one file per show:

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
