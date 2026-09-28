# PIT TV — E2E QA Investigation Report

| | |
|---|---|
| **Report ID** | QA-RPT-001 |
| **Date** | 2026-09-28 |
| **Target** | `pit-tv` @ `\\zimaserver\ZimaOS-HD\AppData\Projects\pit-tv` |
| **Build** | Working tree, no VCS (repo is not under git — no commit SHA available) |
| **Method** | 4 parallel QA agents driving the live app at `http://localhost:3000/` via Chrome DevTools MCP, per `e2e_test.md` (QA-SOP-004) |
| **Corpus** | `data/catalog.json` — 198 entries, 30 artists, 14 venues, 45 tags |
| **Data integrity** | `data/catalog.json` unmodified — 154,817 bytes, last write 13:27 (pre-dates the test run at 13:35) |

---

## 1. Executive summary

Four agents covered catalog/data integrity, search/filter/sort, player/media, and
theming/a11y/responsive. They produced 13 candidate defects. **Six survived
verification.** Seven were artifacts of the agents' own test harness and were
disproved on re-test.

The single highest-impact finding is that **the filter sidebar is unusable below
900px** — it is fixed over the content with no way to dismiss it, obscuring the
left 264px of every view at tablet and phone widths. This is confirmed by direct
measurement at both 768px and 360px.

The remainder are a Lighthouse accessibility failure affecting all 198 cards, one
dead loading indicator, one silent-failure path that reports success while
failing, and three input-validation defects.

**One candidate is unresolved and needs a dedicated repro:** a suspected
Artist-sort no-op. The evidence gathered was not sufficient to confirm or refute
it, and it is explicitly flagged below rather than being reported as a defect.

---

## 2. Confirmed defects

### QA-001 — Filter sidebar overlays and obscures content below 900px
**Severity: Major** · **Area: Responsive layout** · `assets/css/layout.css:591-619`

At `max-width: 900px` the sidebar switches to `position: fixed` but is neither
hidden by default nor offset from the content. `.main` receives no left padding
and no backdrop, so the sidebar sits on top of the grid permanently.

Measured:

| Viewport | Sidebar | `.main` x | First card x | Obscured |
|---|---|---|---|---|
| 1440×900 | in flow | 264 | 288 | no |
| 768×1024 | fixed 264px | **0** | **24** | yes — first 264px |
| 360×640 (rendered 500×640) | fixed 264px, **53% of viewport** | **0** | **12** | yes — first 264px |

Steps to reproduce:
1. Resize the browser to 768×1024 (or narrower).
2. Load `http://localhost:3000/`.
3. Observe the sidebar rendered at `x=0, width=264, position:fixed`, with the
   first grid card at `x=24` — underneath it.

Expected: the sidebar is collapsed off-canvas by default below 900px, or the main
content is offset by `--sidebar-w` while it is open, or an overlay scrim intercepts
input.

Actual: `.sidebar` is visible, `.main` starts at `x=0`, and content is covered.
`document.documentElement.scrollWidth === window.innerWidth`, so there is no
horizontal scrollbar to recover the content — it is simply unreachable.

Note that `.sidebar[hidden]` (`layout.css:254-257`) already implements a
slide-out transform, and the store persists a sidebar state — the mechanism
exists, it is just never applied at this breakpoint.

---

### QA-002 — All 198 cards fail two Lighthouse accessibility rules
**Severity: Minor** · **Area: Accessibility** · `assets/js/ui.js:291-295`, `assets/js/ui.js:349-354`

Cards render as `<article class="video-card" role="button" aria-label="…">`.
This trips two axe rules on every card in the grid:

- `label-content-name-mismatch` — the visible text inside the card is not
  contained in the accessible name computed from `aria-label`.
- `agent-accessibility-tree` — `role="button"` on an `<article>` is flagged as an
  inappropriate ARIA role for the element.

Lighthouse (desktop navigation): Accessibility **100** (the rules are in the
best-practices/agentic categories), Best Practices **96**, SEO 100.

This is not visible in the headline Accessibility score because Lighthouse weights
`best-practices` and `agent-accessibility-tree` separately — the cards are still
wrong for screen readers regardless.

Steps to reproduce:
1. Load the app with the 198-entry catalog.
2. Run `chrome-devtools_lighthouse_audit`.
3. Observe `label-content-name-mismatch` with 8 items and
   `agent-accessibility-tree` with 1 item, all on `article.video-card`.

Expected: each card is a native `<button>` (or a `<button>` wrapping the content)
so the accessible name derives from the visible text, with no ARIA override.

Actual: `aria-label` overrides the visible name and `role="button"` is applied
redundantly to a non-interactive element.

---

### QA-003 — YouTube/Vimeo embeds show no loading indicator
**Severity: Minor** · **Area: Player** · `assets/js/player.js:271` and `:275`

`mountEmbed()` calls `showMessage("Loading <provider> stream…")` on line 271, then
calls `hideMessage()` on line 275 — in the same synchronous block, before the
`<iframe>` is even constructed on line 277. The message is never painted.

This is inconsistent with `mountVideo()` (`player.js:300`), which shows
"Opening stream…" and leaves it up until `loadedmetadata`/`playing`.

Steps to reproduce:
1. Open any YouTube or Vimeo entry.
2. Observe the stage during and after iframe load.
3. `[data-message]` has `innerHTML` cleared and `hidden = true` throughout.

Expected: the loading indicator is visible until the iframe signals ready.

Actual: no indicator is ever displayed. The `dataset.kind` remains `"loading"` on
the hidden node, so any code branching on it sees a state the user never saw.

---

### QA-004 — Server sync failures are swallowed and logged as success
**Severity: Minor** · **Area: Catalog** · `assets/js/catalog.js:446-495`

`triggerServerSync()` POSTs to `/api/sync-shows`; `triggerCoverFetch()` GETs
`/api/fetch-status`. Both are fire-and-forget with `.catch(() => {})`.

Against the running server these fail — `501 Unsupported method ('POST')` and
`404` respectively — but the console still prints:
- `[sync] shows.json refreshed from catalog`
- `[covers] background fetch started for  entries`

Both messages are printed unconditionally before/independent of the response, so
they report success for work that never happened. This is the reason
`errors-in-console` fails in Lighthouse (2 items).

Steps to reproduce:
1. Serve the app from any static server without the `/api/*` routes.
2. Load the page and read the console.

Expected: a failed background sync is either reported or genuinely silent — never
announced as done.

Actual: success messages logged against failed requests; the failures are
invisible except in the network panel.

---

### QA-005 — `parseDate` accepts impossible month and day values
**Severity: Trivial** · **Area: Catalog validation** · `assets/js/catalog.js:73`

`parseDate("2016-13-45")` returns `{ iso: "2016-13-45", precision: "day" }`. The
regex matches but no range check follows. `formatDate` then builds
`new Date("2016-13-45T00:00:00")`, which JavaScript silently rolls over to a
*different real date* rather than producing `NaN` — so the bad value renders as a
plausible but incorrect date with no error anywhere.

`"2016-00-00"` is likewise accepted (month 0, day 0).

Expected: month 1–12, day 1–31, otherwise `{ iso: "", precision: "" }` like other
invalid input.

Actual: out-of-range values pass through and are silently normalised by the `Date`
constructor.

---

### QA-006 — `parseDuration` NaN guard is dead code; out-of-range accepted
**Severity: Trivial** · **Area: Catalog validation** · `assets/js/catalog.js:34-35`

`parts` is built with `.map((p) => toInt(p, 0))`. `toInt` returns either
`Math.floor(Number(v))` when finite and non-negative, or the `0` fallback. It
cannot return `NaN`, so `parts.some((n) => Number.isNaN(n))` is always `false`.

The consequence is that the check it appears to provide does not exist:
`parseDuration("25:999")` returns `2499` (treated as 2499 minutes) rather than
being rejected.

Expected: either remove the misleading check, or implement real component
validation so the guard means something.

---

### QA-007 — Null show rows are spread into empty objects
**Severity: Trivial** · **Area: Sync** · `assets/js/sync.js:34`

```js
if (!row || typeof row === "object" && !Array.isArray(row)) {
  shows[key] = { ...row };
}
```

A `null` row satisfies `!row`, and `{ ...null }` evaluates to `{}`. The corrupted
row is therefore *retained* rather than dropped, then decorated with computed
`_clips`/`_artists` fields on the next pass, and reported as a "gap" by
`normaliseShows` on the following load.

Verified directly: a null row produced
`{ "_clips": 1, "_artists": ["Grateful Dead"] }`.

Expected: the `!row` case drops the key.

Actual: the guard's intent (normalise partial rows) is applied to `null` too, so
corruption persists instead of being cleared.

---

## 3. Unresolved — requires a dedicated repro

### QA-008 (unconfirmed) — Artist sort may not reorder rows
**Area: Search / sort** · `assets/js/ui.js:1083-1089`, `index.html:121-127`

Two observations, neither of which constitutes a repro:

1. **No Artist sort control in the list header.** `ui.js:1083-1089` wires
   `data-sort` buttons for song, venue, date, album and duration only.
   `index.html:121-127` confirms the header renders Song, Venue, Date, Album,
   Quality, Location, Length. Artist is absent as a clickable header.
   *The sort dropdown (`[data-sort-field]`) does offer Artist.* This is very
   likely intentional — not every sortable column needs a header button — but it
   is an inconsistency worth a deliberate decision.

2. **Suspected no-op.** After setting the dropdown to Artist, `state.sort.field`
   changed to `"artist"` but row order was reported unchanged across an asc/desc
   toggle. The supporting evidence was "rows looked identical across two runs",
   which does not rule out a stable sort on an already-alphabetical subset.

**Action:** do not act on this yet. Reproduce by loading the 198-entry catalog,
switching to List view, setting sort=artist, then capturing the first and last 5
row labels with the direction toggled. If both are byte-identical, it is real and
the cause is almost certainly in the comparator's handling of the `artist` key in
`search.js`.

---

## 4. Disproved — do not action

These were reported by the agents as defects. Each was re-tested directly and is
**not** a bug. They are recorded here so the same findings are not re-investigated.

| Claimed defect | Test result |
|---|---|
| "Clicking grid cards adds filters instead of opening the player" | **False.** Card click opens the player; filter chips stay at 0 before and after. Caused by stale `localStorage` from the agent's own earlier runs. |
| "Esc requires two presses to close the player" | **False.** One press closes it at 1440×900. |
| "Close button does not dismiss the modal" | **False.** `.modal-close` click closes it. |
| "Backdrop click does not dismiss the modal" | **False.** `.modal-backdrop` click closes it. |
| "Duration displays `0:05 / 0:05` instead of the real duration" | **Artifact.** Read before `loadedmetadata` fired. HLS entries display correct durations (verified: `10:34`, and `0:42` after a chapter seek). |
| "Server ignores `?catalog=` query param" | **Not a bug.** That parameter is not a documented feature of `catalog.js`. |
| "Player keyboard shortcuts leak to the grid" | **False.** Space, ←/→, ↑/↓, M, F, N, P, `[`/`]`, j/l all verified working inside the player. |
| "Filter chips persist; 'Clear all' is non-functional" | **Artifact of stale `localStorage`** set up by the agent's own test sequence. |

---

## 5. Coverage achieved

### Verified correct

**Search (`search.js`)** — multi-token AND semantics, prefix-outranks-midword
scoring, subsequence matching (`sklt` → 23, `sklt ded` → 23), case-insensitivity
(`KORN`, `Korn Issues`), empty string → 198, whitespace-only → 198, single char → 73,
emoji → 0, `!@#$%^&*` → 0, 200×`a` → 0, search chip renders and clears.

**Filters (`ui.js`)** — artist, venue, tags match-any and match-all, quality, date
range; all combinable; chip removal by ×; "no results" state; clear-all; sidebar
facets (Artist 30, Venue 14, Album 69, Quality 3).

**Theming (`theme.js`)** — the 4.5:1 contrast push holds across every adversarial
cover tested:

| Cover | primary:card | accent:card |
|---|---|---|
| solid red `#e63946` | 5.06 | 9.73 |
| solid blue `#2a9d8f` | 11.08 | 6.54 |
| near-black `#0d1117` | 5.82 | 4.36 |
| near-white `#f0e6d8` | 7.94 | 13.09 |
| all-grey `#808080` | 5.28 | 10.46 |
| vibrant purple `#9b5de5` | 4.57 | 6.41 |

Missing `albumArt` → neutral fallback; corrupt URL → neutral fallback; two-colour
split → correct 2-bucket palette; all-grey does not get stuck on grey;
`buildTheme([])` and `buildTheme(null)` both return `null`; cache cap of 40
confirmed at `theme.js:18`.

**Catalog resilience (`catalog.js`)** — malformed JSON, empty array, non-array root,
404, and all-invalid-entries each produce a specific fatal message with a working
Retry button. Mixed valid/invalid renders the valid entries and toasts
"Skipped N invalid entries". `shows.json` 404 degrades gracefully. Invalid entries
never take the page down.

**Service worker (`sw.js`)** — registered and active; shell cache `pittv-v15-shell`
(31 entries), art cache `pittv-v15-art` (78, under the 300 cap), data cache holds
the catalogs. **Video media is correctly never intercepted** (the
`/(?:mp4|webm|m4v|mov|mkv|m3u8|mpd|ts)$/i` bypass holds) and range requests still
return 206 with the SW active. Offline reload succeeds with the shell and
`shows.json` served from cache.

**Reduced motion** — OS-level `prefers-reduced-motion` honoured, Settings override
works, anime.js helpers return zero durations while `complete` callbacks still
fire in order, and all `.finished` chains in `ui.js` are correctly guarded.

**Player sources** — local missing file → `File not found: <path>` via HEAD
preflight; existing local file → clean mount; YouTube/Vimeo → correct
`youtube-nocookie` / `player.vimeo.com` embed URLs; HLS → working via hls.js;
direct MP4/WebM → correct resolution; chapters seek correctly (`0:42`); setlist
per-song navigation and resume work (`1 of 3` → `2 of 3`); resume survives reload.

**Keyboard transport (player)** — Space/K, ←/→ seek, ↑/↓ volume, M, F, N/P rate,
`[`/`]` and j/l all functional. `1`–`9` percentage seek did **not** fire, but is
not in the documented shortcut table, so it is not counted as a defect.

### Not covered

- **DASH (`.mpd`)** — Chrome has no native DASH support; never exercised.
- **CORS-tainted album art** — requires a cross-origin image without
  `Access-Control-Allow-Origin`; not exercised.
- **PiP, 0.5x–2x rate range limits, volume bounds** — not individually asserted.
- **Race conditions on rapid open/close/reseek** — resume positions behaved
  correctly in functional tests but were not stress-tested for write races or
  NaN/negative persisted values.

---

## 6. Blocker: the test corpus is broken

`data/catalog.demo.json` is supposed to exercise every source type. It does not:

| Entry | Expected | Actual |
|---|---|---|
| Radiohead — Idioteque | YouTube embed plays | Video unavailable (private/deleted) |
| Patti Smith — Gloria | YouTube embed plays | Video unavailable |
| Tool — Fear Inoculum | Vimeo embed plays | 404 from Vimeo |
| Bob Dylan — Beyond the Horizon | DASH | "This source is not supported" |
| Fleetwood Mac — The Chain | Direct MP4 plays | "This source is not supported" |
| Fleetwood Mac — Dreams | Direct MP4 plays | "This source is not supported" |

**This must be fixed before any player retest is meaningful.** Three of the six
failures are indistinguishable from a real defect, so the player coverage in this
report is only as good as the entries that did work (HLS, local, setlists).

Replace the dead URLs with stable public test streams, or pin specific known-good
video IDs. Nothing else in the player matrix can be trusted until this is done.

---

## 7. Environment note

The server bound to `localhost:3000` is **PID 35928, `C:\Python314\python.exe`**
(`python -m http.server`), not the project's `tools/serve.js`.

`tools/serve.js` provides `/api/sync-shows` and `/api/fetch-status`, plus proper
range support. The plain Python server has neither, which is the direct cause of
QA-004's console errors. It also lacks `Service-Worker-Allowed`.

**Any future test run must use `node tools/serve.js <port>`.** Running against the
Python server will manufacture phantom failures in the catalog and PWA suites.

---

## 8. Remediation plan

Ordered by value-per-effort.

### P0 — unblocks reliable testing

| # | Item | Addresses |
|---|---|---|
| 1 | Replace the dead URLs in `data/catalog.demo.json` with stable public test streams | §6 |
| 2 | Document/enforce `node tools/serve.js` as the only supported test server; stop the Python server on :3000 | §7, QA-004 |

### P1 — user-facing breakage

| # | Item | Addresses |
|---|---|---|
| 3 | Collapse the sidebar off-canvas by default below 900px, or offset `.main` by `--sidebar-w` while it is open and add a scrim that closes it | QA-001 |
| 4 | Re-run the mobile/tablet modal check once #3 lands — the stage was reported cut off at both sizes, but that may be a downstream symptom of the sidebar defect rather than an independent one | QA-001 |

### P2 — correctness and accessibility

| # | Item | Addresses |
|---|---|---|
| 5 | Replace `<article role="button" aria-label>` with a native `<button>` in both the grid card and list row renderers; drop the redundant role and let the accessible name come from the visible text | QA-002 |
| 6 | Remove the `hideMessage()` at `player.js:275`; hide on the iframe's `load` event instead | QA-003 |
| 7 | Make `triggerServerSync`/`triggerCoverFetch` log honestly — log on success, warn (or stay silent) on failure; do not print a success line before the request resolves | QA-004 |

### P3 — validation hygiene

| # | Item | Addresses |
|---|---|---|
| 8 | Add month 1–12 / day 1–31 range checks in `parseDate`, returning `{ iso: "", precision: "" }` on failure | QA-005 |
| 9 | Either delete the dead `Number.isNaN` guard at `catalog.js:35` or implement real per-component validation in `parseDuration` | QA-006 |
| 10 | Change the `sync.js:34` guard to drop null/undefined rows rather than spread them | QA-007 |

### P4 — resolve the open question

| # | Item | Addresses |
|---|---|---|
| 11 | Run the dedicated repro in §3. If confirmed, fix the `artist` comparator in `search.js`. Separately, decide whether Artist should get a clickable list header for consistency with the sort dropdown. | QA-008 |

---

## 9. Process recommendations

1. **Isolate test state.** Three of eight reported defects were stale
   `localStorage` from earlier runs. Every test run must start from
   `localStorage.clear(); sessionStorage.clear()` and a hard reload, asserted
   before testing begins — not assumed.
2. **Persist findings to disk early.** Two agents were killed by output-token
   limits mid-run and lost everything not yet written down. Instruct agents to
   write a running log to a scratch file as they go.
3. **Verify before reporting.** Three further defects were reproducible only in an
   agent's own broken harness. A finding should be reported only after a clean-state
   repro.
4. **Consider `git init`.** The project is not under version control, so no
   finding can be bisected, no fix reviewed as a diff, and no regression pinned.
   This is the single biggest structural gap in the current setup.
