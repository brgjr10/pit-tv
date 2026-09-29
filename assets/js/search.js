/*
 * search.js — the query pipeline: search -> filter -> sort.
 *
 * Kept pure (no DOM) so it can be reasoned about and unit-tested on its own.
 * Search is fuzzy-ish: every whitespace-separated token must match somewhere in
 * the entry's haystack, and a prefix match on any word scores higher than a
 * mid-word one so "radi" surfaces "Radiohead" near the top.
 */

const haystackCache = new WeakMap();

/**
 * Every field a query can match against, lower-cased. Lives here rather than in
 * the catalog because deciding what is searchable is a query concern, and it
 * keeps this module free of imports — the catalog builds on top of it, never
 * the other way round.
 *
 * Quality, source and video type are included because the cards render them as
 * badges and Quality is a first-class facet: a field the user can see and
 * filter by but not type is the one combination that reliably reads as broken.
 */
function entrySearchText(entry) {
  const songs = (entry.songs || []).map((s) => s.title);
  return [
    entry.artist,
    entry.song,
    entry.album,
    entry.venue,
    entry.location,
    ...entry.tags,
    ...songs,
    entry.metadata?.quality,
    entry.metadata?.source,
    entry.video?.type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function haystackFor(entry) {
  let h = haystackCache.get(entry);
  if (!h) {
    const text = entrySearchText(entry);
    h = { text, words: text.split(/[\s·/,_-]+/).filter(Boolean) };
    haystackCache.set(entry, h);
  }
  return h;
}

/**
 * Subsequence (abbreviation) matching, e.g. "rdhd" -> "radiohead".
 *
 * Deliberately narrow: the token must be short, must match inside a single
 * word, and that word must not be much longer than the token. Without those
 * limits an 8-character query like "radiohead" matches unrelated entries whose
 * scattered letters happen to spell it in order, which is far worse than
 * missing a genuine abbreviation.
 */
const MAX_FUZZY_TOKEN = 5;
const MAX_WORD_RATIO = 4;

function fuzzyMatch(token, words) {
  for (const word of words) {
    if (word.length > token.length * MAX_WORD_RATIO) continue;
    let i = 0;
    for (let j = 0; j < word.length && i < token.length; j += 1) {
      if (word[j] === token[i]) i += 1;
    }
    if (i === token.length) return 10;
  }
  return 0;
}

/**
 * Score one token against one entry.
 * Returns 0 for no match, otherwise a positive relevance score.
 */
function scoreToken(token, entry) {
  const { text, words } = haystackFor(entry);

  if (text.includes(token)) {
    // Substring hit: rank it by how early it appears, and boost word prefixes.
    const at = text.indexOf(token);
    const base = 100 - Math.min(at, 60);
    const prefixBonus = words.some((w) => w.startsWith(token)) ? 40 : 0;
    const wholeWord = words.includes(token) ? 30 : 0;
    return base + prefixBonus + wholeWord;
  }

  if (token.length <= MAX_FUZZY_TOKEN) return fuzzyMatch(token, words);

  return 0;
}

export function matchQuery(entry, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return { matched: true, score: 0, hits: [] };

  const tokens = q.split(/\s+/).filter(Boolean);
  let total = 0;
  const hits = new Set();

  for (const token of tokens) {
    const score = scoreToken(token, entry);
    if (score === 0) return { matched: false, score: 0, hits: [] };
    total += score;

    // Record which fields hit so the row can show a highlight.
    if (entry.artist.toLowerCase().includes(token)) hits.add("artist");
    if (entry.song.toLowerCase().includes(token)) hits.add("song");
    if (entry.album.toLowerCase().includes(token)) hits.add("album");
    if (entry.venue.toLowerCase().includes(token)) hits.add("venue");
  }

  return { matched: true, score: total, hits: [...hits] };
}

/* ---------- filters ---------- */

const withinAny = (values, selected) => !selected.length || selected.includes(values);
const withinAll = (values, selected) => !selected.length || selected.every((v) => values.includes(v));

function passesFilters(entry, filters) {
  if (!withinAny(entry.artist, filters.artist)) return false;
  if (!withinAny(entry.venue, filters.venue)) return false;
  if (!withinAny(entry.album, filters.album)) return false;
  if (!withinAny(entry.metadata.quality, filters.quality)) return false;
  if (!withinAny(entry.metadata.source, filters.source)) return false;
  if (!withinAny(entry.video.type, filters.type)) return false;

  if (filters.dateFrom && (!entry.date || entry.date < filters.dateFrom)) return false;
  if (filters.dateTo && (!entry.date || entry.date > filters.dateTo)) return false;

  return true;
}

/* ---------- facet counts ---------- */

/**
 * An empty selection for every filter key. Facet counting always applies a
 * complete filter set, and a missing key would be read as an undefined
 * selection rather than as "nothing selected".
 */
const NO_SELECTION = {
  artist: [],
  venue: [],
  album: [],
  quality: [],
  source: [],
  type: [],
  dateFrom: "",
  dateTo: "",
};

/**
 * Count each dimension's values over the entries that match the search and
 * every filter *except that dimension's own selection*.
 *
 * The exclusion is what makes a count mean something: a count has to answer
 * "how many results would I get if I ticked this?". Counting a dimension
 * against its own selection would make an already-ticked value satisfy itself
 * at the cost of every alternative, so its whole list would collapse to zero
 * and the option the user is trying to untick would look unavailable.
 *
 * @param {Array} entries the whole catalog
 * @param {Array<{key: string, get: Function}>} dimensions the faceted dimensions
 * @returns {Map<string, Map<string, number>>} dimension key -> value -> count
 */
export function countFacets(entries, dimensions, { filters, searchQuery = "" } = {}) {
  const counts = new Map();

  for (const { key, get, multi } of dimensions) {
    const context = { ...NO_SELECTION, ...filters, [key]: NO_SELECTION[key] };
    const tally = new Map();
    for (const entry of entries) {
      if (!passesFilters(entry, context)) continue;
      if (!matchQuery(entry, searchQuery).matched) continue;
      // Empty values are tallied too: deciding which values are worth showing
      // belongs to whoever asked for the counts, not to the counting.
      for (const value of multi ? get(entry) : [get(entry)]) {
        tally.set(value, (tally.get(value) || 0) + 1);
      }
    }
    counts.set(key, tally);
  }

  return counts;
}

/* ---------- sorting ---------- */

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const SORTERS = {
  date: (a, b) => collator.compare(a.date || "0000-00-00", b.date || "0000-00-00"),
  artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.song, b.song),
  song: (a, b) => collator.compare(a.song, b.song),
  venue: (a, b) => collator.compare(a.venue, b.venue) || collator.compare(a.date, b.date),
  duration: (a, b) => (a.video.duration || 0) - (b.video.duration || 0),
  album: (a, b) => collator.compare(a.album, b.album) || collator.compare(a.song, b.song),
};

// Artist is sortable but has no list-header button, and that is deliberate.
//
// The list row renders the artist as the `.sub` under the song title inside the
// primary cell — it is not a column of its own — so there is no header cell to
// wire a `data-sort` button to. The header buttons map 1:1 onto row columns
// (Song -> .title, Venue -> .venue, Date -> .date, Album -> .album,
// Length -> .num), and artist has no such column. Sorting by artist is still
// available through the sort dropdown, which is enough.
//
// The comparator reads `entry.artist`, and `normaliseEntry` sets that field from
// `raw.artist` (catalog.js), so the UI key ("artist") and the field compared are
// the same — artist sort is not a no-op. Verified against the 198-entry catalog:
// ascending runs $uicideboy$ -> ZillaKami and descending is the exact reverse.
export const SORT_FIELDS = [
  { field: "date", label: "Date" },
  { field: "artist", label: "Artist" },
  { field: "song", label: "Song" },
  { field: "venue", label: "Venue" },
  { field: "album", label: "Album" },
  { field: "duration", label: "Duration" },
];

/**
 * Run the full pipeline.
 * @returns {{ entries: Array, scores: Map<string, number> }}
 */
export function queryCatalog(catalog, { filters, searchQuery, sort }) {
  const scores = new Map();
  const out = [];

  for (const entry of catalog) {
    if (!passesFilters(entry, filters)) continue;
    const { matched, score } = matchQuery(entry, searchQuery);
    if (!matched) continue;
    out.push(entry);
    if (searchQuery) scores.set(entry.id, score);
  }

  const sorter = SORTERS[sort.field] || SORTERS.date;
  const dir = sort.dir === "asc" ? 1 : -1;

  out.sort((a, b) => {
    // With a text query, relevance leads and the chosen sort breaks ties.
    if (scores.size) {
      const diff = (scores.get(b.id) || 0) - (scores.get(a.id) || 0);
      if (diff !== 0) return diff;
    }
    const primary = sorter(a, b);
    if (primary !== 0) return primary * dir;
    return collator.compare(a.id, b.id);
  });

  return { entries: out, scores };
}

/** Wrap matched characters in <mark>. Input is escaped by the caller. */
export function highlight(text, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q || !text) return escapeHtml(text || "");
  const tokens = [...new Set(q.split(/\s+/).filter((t) => t.length > 1))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return escapeHtml(text);

  // Sentinel bytes keep the replace loop from nesting <mark> inside a match.
  const open = "\u0001";
  const close = "\u0002";

  let html = escapeHtml(text);
  for (const token of tokens) {
    const pattern = new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    html = html.replace(pattern, `${open}$1${close}`);
  }
  return html.split(open).join("<mark>").split(close).join("</mark>");
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Which filter groups currently hold at least one value. */
export function activeFilterSummary(filters) {
  const chips = [];
  const labels = {
    artist: "Artist",
    venue: "Venue",
    album: "Album",
    quality: "Quality",
    source: "Source",
    type: "Type",
  };
  for (const [key, label] of Object.entries(labels)) {
    for (const value of filters[key] || []) {
      chips.push({ key, value, label: `${label}: ${value}` });
    }
  }
  if (filters.dateFrom) chips.push({ key: "dateFrom", value: filters.dateFrom, label: `From: ${filters.dateFrom}` });
  if (filters.dateTo) chips.push({ key: "dateTo", value: filters.dateTo, label: `To: ${filters.dateTo}` });
  return chips;
}
