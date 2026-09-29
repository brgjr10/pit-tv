// Exercises store.js restore() against malformed stored-preference payloads.
// store.js is a leaf module with no imports, so it runs in Node with only a
// localStorage shim.

const store = {};

globalThis.localStorage = {
  _v: null,
  getItem() { return this._v; },
  setItem(_k, v) { this._v = v; },
  removeItem() { this._v = null; },
};

const { state, restore } = await import("../assets/js/store.js");

const CASES = [
  ['{"filters":{"artist":42}}', "filters.artist = number"],
  ['{"filters":{"artist":{"a":1}}}', "filters.artist = object"],
  ['{"filters":{"venue":null}}', "filters.venue = null"],
  ['{"view":"nonsense","sort":{"field":"not-a-field","dir":"sideways"}}', "bad view + sort"],
  ['{"playbackPositions":{"some-id":-500}}', "negative position"],
  ['{"playbackPositions":{"some-id":"abc"}}', "non-numeric position"],
  ['{"settings":{"reducedMotion":null}}', "reducedMotion null (VALID)"],
  ['{"artistGroups":"nope"}', "artistGroups = string"],
  ['{"artistGroups":{"Some Artist":42}}', "artistGroups value = number"],
  ['"not even json"', "malformed JSON"],
];

let failures = 0;

for (const [payload, label] of CASES) {
  localStorage._v = payload;
  // reset only the slice restore() writes, so each case starts clean
  state.filters = { artist: [], venue: [], album: [], quality: [], source: [], type: [], dateFrom: "", dateTo: "" };
  state.sort = { field: "date", dir: "desc" };
  state.settings = { reducedMotion: null, autoPlay: true, theme: "dark", sidebarOpen: true };
  state.playbackPositions = {};
  state.artistGroups = {};

  let threw = null;
  try {
    restore();
  } catch (err) {
    threw = err;
  }

  if (threw) {
    console.log(`FAIL  ${label}\n        threw: ${threw.message}`);
    failures += 1;
    continue;
  }

  // Everything downstream assumes these are the right shapes.
  const problems = [];
  for (const [k, v] of Object.entries(state.filters)) {
    if (k === "dateFrom" || k === "dateTo") {
      if (typeof v !== "string") problems.push(`filters.${k} is ${typeof v}`);
    } else if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      problems.push(`filters.${k} is not a string array`);
    }
  }
  if (typeof state.sort.field !== "string") problems.push("sort.field not a string");
  if (state.sort.dir !== "asc" && state.sort.dir !== "desc") problems.push(`sort.dir is ${state.sort.dir}`);
  for (const [id, p] of Object.entries(state.playbackPositions)) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) problems.push(`position ${id} is ${p}`);
  }
  for (const [a, o] of Object.entries(state.artistGroups)) {
    if (typeof o !== "boolean") problems.push(`artistGroups[${a}] is ${typeof o}`);
  }

  if (problems.length) {
    console.log(`FAIL  ${label}\n        ${problems.join("\n        ")}`);
    failures += 1;
  } else {
    console.log(`ok    ${label}`);
  }
}

// reducedMotion: null is a real sentinel and must survive, not be dropped.
localStorage._v = '{"settings":{"reducedMotion":null}}';
state.settings.reducedMotion = true;
restore();
console.log(
  state.settings.reducedMotion === null
    ? "ok    reducedMotion null survives restore (sentinel preserved)"
    : "FAIL  reducedMotion null was coerced away",
);
if (state.settings.reducedMotion !== null) failures += 1;

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
