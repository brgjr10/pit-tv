/*
 * store.js — the single source of truth.
 *
 * Plain pub/sub: subscribers get (state, event, payload) and may mutate via the
 * exposed action helpers. Kept in its own module (rather than inside app.js) so
 * ui.js / search.js / player.js can import it without a circular dependency.
 */

const PREF_KEY = "pittv:prefs:v1";

export const VIEWS = ["grid", "list", "artist", "timeline"];

/* ---------- restore-time validation ---------- */

/*
 * A stored payload can be hand-edited, rolled back from a newer build, or left
 * half-written, and restore() used to Object.assign it straight into state. A
 * single bad value then reached the query and render layers, which assume
 * arrays, and the app fell through to showFatal with a diagnostic that blamed
 * catalog.json — a dead end the user cannot escape. So each key is validated
 * here and falls back independently: one bad key must not cost the user the
 * rest of their settings.
 */

/** Filter keys and the shape each accepts. Date bounds are strings, not lists. */
const FILTER_KEYS = [
  "artist",
  "venue",
  "album",
  "quality",
  "source",
  "type",
  "dateFrom",
  "dateTo",
];

const isStringArray = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");

function sanitizeFilters(savedFilters) {
  const clean = {};
  for (const key of FILTER_KEYS) {
    if (!(key in savedFilters)) continue;
    const value = savedFilters[key];
    if (key === "dateFrom" || key === "dateTo") {
      clean[key] = typeof value === "string" ? value : "";
    } else {
      clean[key] = isStringArray(value) ? value : [];
    }
  }
  return clean;
}

function sanitizeSort(savedSort) {
  // An unrecognised field is not a crash vector — the query layer falls through
  // to date order — so only the type is enforced here.
  return {
    field: typeof savedSort?.field === "string" && savedSort.field.length > 0 ? savedSort.field : "date",
    dir: savedSort?.dir === "asc" || savedSort?.dir === "desc" ? savedSort.dir : "desc",
  };
}

function sanitizeSettings(savedSettings) {
  const clean = { ...defaultState().settings };
  if (!savedSettings || typeof savedSettings !== "object") return clean;
  if (savedSettings.reducedMotion === null || typeof savedSettings.reducedMotion === "boolean") {
    clean.reducedMotion = savedSettings.reducedMotion;
  }
  if (typeof savedSettings.autoPlay === "boolean") clean.autoPlay = savedSettings.autoPlay;
  if (savedSettings.theme === "dark" || savedSettings.theme === "light") clean.theme = savedSettings.theme;
  if (typeof savedSettings.sidebarOpen === "boolean") clean.sidebarOpen = savedSettings.sidebarOpen;
  return clean;
}

function sanitizeArtistGroups(savedGroups) {
  if (!savedGroups || typeof savedGroups !== "object") return {};
  const clean = {};
  for (const [artist, open] of Object.entries(savedGroups)) {
    if (typeof open === "boolean") clean[artist] = open;
  }
  return clean;
}

function sanitizePlaybackPositions(savedPositions) {
  if (!savedPositions || typeof savedPositions !== "object") return {};
  const clean = {};
  for (const [id, pos] of Object.entries(savedPositions)) {
    // A negative position would reach the progress bar as a negative scaleX and
    // mirror it, so only finite non-negative offsets are kept.
    if (typeof pos === "number" && Number.isFinite(pos) && pos >= 0) clean[id] = pos;
  }
  return clean;
}

const defaultState = () => ({
  catalog: [],
  filtered: [],
  currentVideo: null,
  currentTheme: null,
  view: "grid",
  filters: {
    artist: [],
    venue: [],
    album: [],
    quality: [],
    source: [],
    type: [],
    dateFrom: "",
    dateTo: "",
  },
  sort: { field: "date", dir: "desc" },
  searchQuery: "",
  playbackPositions: {},
  settings: {
    reducedMotion: null, // null = follow the OS preference
    autoPlay: true,
    theme: "dark", // dark | light
    sidebarOpen: true,
  },
  artistGroups: {},
  status: "idle", // idle | loading | ready | error
  error: null,
  facets: { artist: [], venue: [], album: [], quality: [], source: [], type: [] },
});

const state = defaultState();
const subscribers = new Map();
let nextId = 1;

/* ---------- pub/sub ---------- */

export function subscribe(fn) {
  const id = nextId++;
  subscribers.set(id, fn);
  return () => subscribers.delete(id);
}

export function emit(event, payload) {
  for (const fn of [...subscribers.values()]) {
    try {
      fn(state, event, payload);
    } catch (err) {
      // One broken subscriber must not stop the rest of the UI from updating.
      console.error(`[store] subscriber failed on "${event}"`, err);
    }
  }
}

/* ---------- persistence ---------- */

export function persist() {
  try {
    const slice = {
      view: state.view,
      filters: state.filters,
      sort: state.sort,
      settings: state.settings,
      playbackPositions: state.playbackPositions,
      artistGroups: state.artistGroups,
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(slice));
  } catch (err) {
    // Private-mode / quota failures must not break the session.
    console.warn("[store] could not persist preferences", err);
  }
}

export function restore() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (VIEWS.includes(saved.view)) state.view = saved.view;
    if (saved.filters) Object.assign(state.filters, sanitizeFilters(saved.filters));
    if (saved.sort) Object.assign(state.sort, sanitizeSort(saved.sort));
    if (saved.settings) Object.assign(state.settings, sanitizeSettings(saved.settings));
    if (saved.playbackPositions) state.playbackPositions = sanitizePlaybackPositions(saved.playbackPositions);
    if (saved.artistGroups) state.artistGroups = sanitizeArtistGroups(saved.artistGroups);
  } catch (err) {
    console.warn("[store] could not restore preferences", err);
  }
}

export function savePosition(id, seconds) {
  if (!id) return;
  if (seconds > 2) state.playbackPositions[id] = Math.floor(seconds);
  else delete state.playbackPositions[id];
  persist();
}

export function readPosition(id) {
  return state.playbackPositions[id] || 0;
}

/* ---------- mutations (each one emits) ---------- */

export function setStatus(status, error = null) {
  state.status = status;
  state.error = error;
  emit("status", { status, error });
}

export function setCatalog(entries) {
  state.catalog = entries;
  emit("catalog", entries);
}

/**
 * The untouched parsed document behind state.catalog.
 *
 * normaliseEntry adds keys the file on disk does not have (datePrecision,
 * dateRaw, a defaulted venue, an empty songs array), so the normalised entries
 * cannot be written back blindly. This holds the raw array so edit.js can diff
 * against it and project changes onto the on-disk field set.
 */
let rawCatalog = [];

export function setRawCatalog(entries) {
  rawCatalog = Array.isArray(entries) ? entries : [];
  emit("rawCatalog", rawCatalog);
}

export function getRawCatalog() {
  return rawCatalog;
}

export function setFiltered(entries) {
  state.filtered = entries;
  emit("filtered", entries);
}

export function setView(view) {
  if (!VIEWS.includes(view) || state.view === view) return;
  state.view = view;
  persist();
  emit("view", view);
}

export function setSort(field, dir) {
  state.sort = { field, dir };
  persist();
  emit("sort", state.sort);
}

export function setSearchQuery(query) {
  const q = (query || "").trim();
  if (q === state.searchQuery) return;
  state.searchQuery = q;
  emit("search", q);
}

export function setFilter(key, values) {
  if (!(key in state.filters)) return;
  state.filters[key] = values;
  persist();
  emit("filters", { key, values });
}

export function toggleFilter(key, value) {
  const current = state.filters[key] || [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  setFilter(key, next);
  return next;
}

export function clearFilters() {
  state.filters = defaultState().filters;
  state.searchQuery = "";
  persist();
  emit("filters", { key: "*", values: [] });
}

export function setSetting(key, value) {
  state.settings[key] = value;
  persist();
  emit("setting", { key, value });
}

export function setArtistGroupOpen(artist, open) {
  state.artistGroups = { ...state.artistGroups, [artist]: open };
  persist();
  emit("artistGroups", state.artistGroups);
}

export function getArtistGroupOpen(artist) {
  return state.artistGroups[artist] !== false;
}

export function setFacets(facets) {
  state.facets = facets;
  emit("facets", facets);
}

export function setCurrentVideo(entry) {
  state.currentVideo = entry;
  emit("current", entry);
}

export function setCurrentTheme(theme) {
  state.currentTheme = theme;
  emit("theme", theme);
}

export { state, PREF_KEY };
