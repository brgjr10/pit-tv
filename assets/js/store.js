/*
 * store.js — the single source of truth.
 *
 * Plain pub/sub: subscribers get (state, event, payload) and may mutate via the
 * exposed action helpers. Kept in its own module (rather than inside app.js) so
 * ui.js / search.js / player.js can import it without a circular dependency.
 */

const PREF_KEY = "pittv:prefs:v1";

export const VIEWS = ["grid", "list", "artist", "timeline"];

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
    if (saved.filters) Object.assign(state.filters, saved.filters);
    if (saved.sort) Object.assign(state.sort, saved.sort);
    if (saved.settings) Object.assign(state.settings, saved.settings);
    if (saved.playbackPositions) state.playbackPositions = saved.playbackPositions;
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
