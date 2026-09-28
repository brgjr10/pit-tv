# Pit-TV — Live Concert Video Library

## Project Overview

Build a single-page web application for organizing, browsing, and playing live concert videos. The app uses a JSON-based catalog where each video entry maps to an artist, venue, date, and song title. The UI automatically themes itself to the album cover art for the song being played, with smooth transitions powered by [anime.js](https://github.com/juliangarnier/anime).

---

## Core Requirements

### 1. Data Model (JSON Catalog)

Each video entry in the catalog must support:

```json
{
  "id": "unique-string",
  "artist": "Artist Name",
  "song": "Song Title",
  "album": "Album Name",
  "venue": "Venue Name",
  "date": "YYYY-MM-DD",
  "location": "City, State/Country",
  "video": {
    "type": "local" | "cloud",
    "src": "path/or/url",
    "poster": "optional-thumbnail-url",
    "duration": 245
  },
  "albumArt": "https://.../cover.jpg",
  "tags": ["tour-name", "festival", "pro-shot", "audience"],
  "metadata": {
    "quality": "1080p" | "720p" | "4K",
    "source": "pro-shot" | "audience" | "broadcast",
    "audio": "matrix" | "soundboard" | "audience"
  }
}
```

**Storage:**
- Single `catalog.json` file in the project root (or `data/catalog.json`)
- Support for local files (relative paths from project root or absolute file:// URLs)
- Support for cloud URLs (YouTube, Vimeo, direct MP4/WebM, m3u8 HLS, cloud storage presigned URLs)

### 2. Automatic Album Art Theming

When a video is selected/played:
- Extract dominant colors from the album cover art
- Generate a cohesive color palette (primary, secondary, accent, background, text)
- Apply theme to entire page with smooth transitions (anime.js)
- Theme elements: background gradients, card borders, button accents, scrollbar, video player chrome

**Color extraction approach:**
- Use `<canvas>` to sample album art on load
- Implement color quantization (k-means or median cut) for dominant palette
- Fallback: predefined artist themes for known acts

### 3. Video Player

- HTML5 `<video>` element with custom controls
- Support formats: MP4, WebM, HLS (.m3u8 via hls.js), DASH
- Cloud sources: detect YouTube/Vimeo embeds, direct streaming URLs
- Features:
  - Play/pause, seek, volume, fullscreen
  - Keyboard shortcuts (Space, Arrows, F, M)
  - Picture-in-Picture
  - Playback rate (0.5x–2x)
  - Chapter markers (if provided in metadata)
  - Resume playback position (localStorage)

### 4. Browse & Search UI

**Views:**
- **Grid View** — Album art thumbnails, dense, responsive
- **List View** — Compact rows with metadata columns
- **Artist View** — Grouped by artist, expandable sections
- **Timeline View** — Chronological by date

**Filters (all combinable):**
- Artist (multi-select)
- Venue
- Date range
- Tag(s)
- Source quality
- Video type (local/cloud)

**Search:**
- Full-text across artist, song, venue, tags
- Fuzzy matching
- Highlight matches in results

**Sorting:**
- Date (newest/oldest)
- Artist (A-Z)
- Song (A-Z)
- Venue
- Duration

### 5. New-Gen UI Theme (anime.js Transitions)

**Visual Language:**
- Dark theme base: `#0d1117` background, `#161b22` cards, `#30363d` borders
- Glassmorphism cards with subtle blur
- Rounded corners (12–16px)
- Micro-interactions on every action

**Required anime.js Transitions:**
| Trigger | Animation |
|---------|-----------|
| Page load | Staggered card entrance (fade + slide up) |
| Theme change | Color morph (background, borders, text) — 600ms easeOutExpo |
| View switch | Cross-fade + layout FLIP |
| Filter apply | Staggered hide/show with scale |
| Video select | Expand card → full player (shared element transition) |
| Hover card | Lift + glow + album art zoom |
| Search typing | Debounced results morph |
| Modal open | Backdrop blur + scale from center |

**Transition Principles:**
- All state changes animated (no hard cuts)
- Reduced-motion media query respected
- 60fps target — use `will-change`, transform/opacity only
- Stagger delays: 30–50ms per item

### 6. Keyboard Navigation (First-Class)

- `Tab` / `Shift+Tab` — Focus order
- `Enter` / `Space` — Activate focused video
- `Arrow keys` — Navigate grid/list
- `Escape` — Close modal, clear search, exit fullscreen
- `/` — Focus search
- `G` — Toggle grid/list view
- `T` — Toggle timeline view
- `A` — Artist view
- `F` — Fullscreen
- `M` — Mute
- `←/→` — Seek ±10s
- `↑/↓` — Volume ±10%

### 7. Persistence & Settings

Store in `localStorage`:
- Last view mode
- Active filters
- Sort preference
- Theme preference (auto/light/dark — though dark is primary)
- Playback positions per video
- Window size/position (if Electron wrapper later)

---

## Technical Architecture

### Stack (Zero-Build, Vanilla-First)

```
pit-tv/
├── index.html          # Entry point
├── catalog.json        # Video catalog (user-editable)
├── assets/
│   ├── css/
│   │   ├── variables.css      # CSS custom properties (theming)
│   │   ├── reset.css
│   │   ├── layout.css
│   │   ├── components.css
│   │   ├── player.css
│   │   └── animations.css     # anime.js keyframes/helpers
│   └── js/
│       ├── app.js             # Main init, routing, state
│       ├── catalog.js         # Load, parse, validate catalog
│       ├── player.js          # Video player controller
│       ├── theme.js           # Color extraction, theme application
│       ├── ui.js              # Render, events, keyboard
│       ├── search.js          # Search/filter/sort logic
│       └── anime-helpers.js   # Reusable anime.js timelines
├── lib/
│   ├── anime.min.js           # Bundled anime.js (v3.x)
│   └── hls.min.js             # For HLS streaming
└── sw.js                      # Service worker (offline, caching)
```

**No bundler, no framework.** ES modules via `<script type="module">`. All CSS via native custom properties.

### State Management

Single global store (pub/sub pattern):

```js
const store = {
  catalog: [],
  filtered: [],
  currentVideo: null,
  currentTheme: null,
  view: 'grid', // 'grid' | 'list' | 'artist' | 'timeline'
  filters: { artist: [], venue: [], tags: [], dateRange: [], quality: [], type: [] },
  sort: { field: 'date', dir: 'desc' },
  searchQuery: '',
  playbackPositions: {},
  settings: { reducedMotion: false, autoPlay: false }
};
```

### Theme Engine (`theme.js`)

```js
// 1. Load album art image
// 2. Draw to offscreen canvas (max 150px)
// 3. Extract pixel data → color quantization
// 4. Generate CSS custom properties:
:root {
  --theme-primary: #hex;
  --theme-secondary: #hex;
  --theme-accent: #hex;
  --theme-bg: #hex;
  --theme-card: #hex;
  --theme-border: #hex;
  --theme-text: #hex;
  --theme-text-muted: #hex;
  --theme-gradient: linear-gradient(...);
}
// 5. Apply via anime.js: animate each property on document.documentElement.style
```

### Video Source Resolution (`player.js`)

```js
function resolveSource(entry) {
  const { video } = entry;
  if (video.type === 'local') return video.src; // relative or file://
  if (isYouTube(video.src)) return embedYouTube(video.src);
  if (isVimeo(video.src)) return embedVimeo(video.src);
  if (isHLS(video.src)) return { type: 'hls', src: video.src };
  if (isDASH(video.src)) return { type: 'dash', src: video.src };
  return video.src; // direct MP4/WebM
}
```

---

## Implementation Phases

### Phase 1: Foundation (Day 1–2)
- [ ] Project structure, `index.html`, CSS variables system
- [ ] Load `catalog.json` via fetch, validate schema
- [ ] Basic grid rendering with album art thumbnails
- [ ] anime.js integration, staggered entrance animation

### Phase 2: Player & Theming (Day 3–4)
- [ ] Custom video player component
- [ ] Local + cloud source handling (YouTube, Vimeo, HLS)
- [ ] Album art color extraction → CSS variables
- [ ] Theme transition animation (anime.js morph)

### Phase 3: Browse & Search (Day 5–6)
- [ ] Filter sidebar (collapsible, multi-select)
- [ ] Search with debounce + highlight
- [ ] Sort controls
- [ ] View toggle (grid/list/artist/timeline)
- [ ] All view transitions animated

### Phase 4: Polish & PWA (Day 7)
- [ ] Keyboard navigation full pass
- [ ] Service worker (cache catalog, assets, album art)
- [ ] Offline support for local videos
- [ ] localStorage persistence
- [ ] Reduced motion support
- [ ] Error states (missing video, broken art, corrupt JSON)

---

## anime.js Usage Patterns

**Shared Element Transition (Card → Player):**
```js
anime({
  targets: [cardEl, playerEl],
  keyframes: [
    { opacity: [1, 0], scale: [1, 0.95], duration: 200, easing: 'easeInOutQuad' },
    { opacity: [0, 1], scale: [1.05, 1], duration: 300, easing: 'easeOutExpo' }
  ]
});
```

**Theme Color Morph:**
```js
anime({
  targets: document.documentElement,
  '--theme-primary': '#newColor',
  '--theme-bg': 'linear-gradient(135deg, #c1, #c2)',
  duration: 600,
  easing: 'easeOutExpo'
});
```

**Staggered Grid Entrance:**
```js
anime({
  targets: '.video-card',
  opacity: [0, 1],
  translateY: [30, 0],
  delay: anime.stagger(40, { start: 200 }),
  duration: 500,
  easing: 'easeOutExpo'
});
```

---

## Catalog Management UX (Future)

- In-app editor modal to add/edit/delete entries
- Drag-drop album art upload → convert to data URL or save to `/covers/`
- Auto-fetch album art from MusicBrainz/Last.fm/Spotify via artist+song
- Export/import catalog.json
- Duplicate detection

---

## Acceptance Criteria

1. **Load catalog.json** → renders all videos in grid within 500ms (100 entries)
2. **Click video** → player opens, theme transitions in 600ms, video plays
3. **Switch theme** (different video) → smooth color morph, no layout shift
4. **Filter by artist** → staggered animate out/in, 300ms
5. **Search "radiohead"** → results highlight, animate in 200ms
6. **Keyboard only** → can browse, play, seek, close, filter without mouse
6. **Refresh page** → restores view, filters, scroll position, playback time
7. **Offline** → cached assets load, local videos play
8. **Reduced motion** → all animations disable instantly

---

## Stretch Goals

- [ ] Electron wrapper for native file:// access + menu bar
- [ ] Sync catalog to cloud (GitHub Gist, WebDAV, Supabase)
- [ ] Collaborative annotations (timestamped notes per video)
- [ ] Auto-generate setlists from date+venue grouping
- [ ] Three.js background visualization reactive to audio
- [ ] Chromecast/AirPlay sender support

---

## File: `catalog.json` Example

```json
[
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
      "src": "https://example.com/videos/rh-2024-06-15-eiirp.mp4",
      "poster": "https://example.com/thumbs/rh-2024-06-15-eiirp.jpg",
      "duration": 342
    },
    "albumArt": "https://example.com/covers/kid-a.jpg",
    "tags": ["primavera-2024", "festival", "pro-shot"],
    "metadata": {
      "quality": "1080p",
      "source": "broadcast",
      "audio": "matrix"
    }
  },
  {
    "id": "gd-1995-03-24-03",
    "artist": "Grateful Dead",
    "song": "Scarlet Begonias",
    "album": "Without a Net",
    "venue": "The Omni",
    "date": "1995-03-24",
    "location": "Atlanta, GA",
    "video": {
      "type": "local",
      "src": "videos/GD-1995-03-24-Scarlet.mp4",
      "duration": 789
    },
    "albumArt": "covers/without-a-net.jpg",
    "tags": ["spring-1995", "soundboard"],
    "metadata": {
      "quality": "720p",
      "source": "soundboard",
      "audio": "soundboard"
    }
  }
]
```

---

## Development Commands

```bash
# Serve locally (required for ES modules + fetch)
npx serve . -p 3000

# Or Python
python -m http.server 3000

# Validate catalog.json
node -e "console.log(JSON.parse(require('fs').readFileSync('catalog.json')))"
```

---

## Dependencies (Vendor Locally)

| Library | Version | File |
|---------|---------|------|
| anime.js | 3.2.2 | `lib/anime.min.js` |
| hls.js | 1.5.x | `lib/hls.min.js` |

Download and commit to `lib/` — no CDN in production.

---

## Browser Support

- Chrome/Edge 100+
- Firefox 98+
- Safari 15.4+
- Requires: CSS Custom Properties, ES Modules, OffscreenCanvas, File System Access API (optional)

---

## License

Personal use. No warranty.