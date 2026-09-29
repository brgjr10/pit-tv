/*
 * upload.js — add concert clips to the archive from the browser.
 *
 * The common case is fourteen phone clips of one show, so this is not a
 * one-shot file input: the show metadata is typed once and a queue of files is
 * pushed through it in sequence, each with its own progress row and result.
 *
 * The transport is three steps, and the split is deliberate:
 *
 *   POST /api/upload/plan   — metadata in, destination path and entry id out.
 *                             The server owns the path so the client can never
 *                             name a location outside videos/.
 *   PUT  /api/upload?path=  — the raw File bytes. XHR rather than fetch,
 *                             because fetch() cannot report progress on a File
 *                             and concert video is multi-gigabyte.
 *   POST /api/upload/commit — the plan plus any edits, written to catalog.json
 *                             and shows.json in one server-side transaction.
 *
 * On success the page reloads rather than pushing the new record into
 * state.catalog: an entry has to pass through normaliseEntry before it is
 * renderable, and loadCatalog is the only code that does that. A raw record
 * spliced into the state renders a card with no datePrecision and no show join.
 */

import { state } from "./store.js";
import { QUALITY_ORDER, SOURCE_VALUES } from "./catalog.js";

// Mirrors the server's allowlist. It is repeated deliberately: rejecting a
// .avi before a multi-gigabyte transfer is far better UX than a plan request
// that comes back 400 thirty seconds in, and the server re-checks regardless.
const ACCEPT = ".mp4,.mov,.m4v,.webm,.mkv";

/* The two date forms set-locations.mjs will accept. Checked here so the user
 * is told before fourteen files are transferred, not after the first commit. */
const DATE_RE = /^\d{4}(-\d{2}-\d{2})?$/;

/* The write routes live on tools/serve.js behind PITTV_WRITE, which is on unless
 * PITTV_WRITE=0. A 403 here is not a bug to be worked around — say so, because
 * the alternative the user will reach for is dropping files into videos/ by hand
 * and editing catalog.json. */
const WRITE_DISABLED_HINT =
  "uploads are disabled on this server — it was started with PITTV_WRITE=0, or copy the files into videos/catalog/ and add the catalog entry by hand";

/* Reload is delayed just long enough to read the summary toast. The toast lives
 * in the DOM, so an instant reload would throw it away unread. */
const RELOAD_DELAY_MS = 1400;

let notifyCommitted = () => {};

/**
 * Wire the upload button to the panel.
 *
 * Returns a small handle so the app can open the panel from a keyboard shortcut
 * later without reaching into the DOM.
 */
export function initUpload({ onCommitted } = {}) {
  if (typeof onCommitted === "function") notifyCommitted = onCommitted;

  const dom = {
    open: document.querySelector("[data-upload-open]"),
    panel: document.querySelector("[data-upload-panel]"),
    backdrop: document.querySelector("[data-upload-backdrop]"),
    close: document.querySelectorAll("[data-upload-close]"),
    form: document.querySelector("[data-upload-form]"),
    start: document.querySelector("[data-upload-start]"),
    files: document.querySelector("[data-upload-files]"),
    rows: document.querySelector("[data-upload-rows]"),
    summary: document.querySelector("[data-upload-summary]"),
    artist: document.querySelector("[data-upload-artist]"),
    artistList: document.querySelector("[data-upload-artists]"),
    song: document.querySelector("[data-upload-song]"),
    album: document.querySelector("[data-upload-album]"),
    albumList: document.querySelector("[data-upload-albums]"),
    performance: document.querySelector("[data-upload-performance]"),
    date: document.querySelector("[data-upload-date]"),
    venue: document.querySelector("[data-upload-venue]"),
    location: document.querySelector("[data-upload-location]"),
    quality: document.querySelector("[data-upload-quality]"),
    source: document.querySelector("[data-upload-source]"),
  };

  if (!dom.open || !dom.panel || !dom.form) return null;

  /* In-flight transfers, so a close mid-upload can stop them rather than leave
   * an orphaned XHR writing into a panel the user can no longer see. */
  const active = new Set();
  let running = false;
  let lastFocus = null;

  dom.open.addEventListener("click", () => openPanel());
  // Two close affordances: the × in the header and Cancel in the footer.
  for (const button of dom.close) button.addEventListener("click", () => closePanel());
  if (dom.backdrop) dom.backdrop.addEventListener("click", () => closePanel());
  dom.form.addEventListener("submit", (e) => {
    e.preventDefault();
    startBatch();
  });

  document.addEventListener("keydown", (e) => {
    if (dom.panel.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
      return;
    }
    if (e.key === "Tab") trapTab(e, dom.panel);
  });

  fillSelect(dom.quality, QUALITY_ORDER);
  fillSelect(dom.source, SOURCE_VALUES);
  if (dom.files) dom.files.setAttribute("accept", ACCEPT);

  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => !dom.panel.hidden,
    isRunning: () => running,
  };

  /* ---------- panel ---------- */

  function openPanel() {
    if (!dom.panel.hidden) return;
    lastFocus = document.activeElement;
    dom.panel.hidden = false;
    dom.open.setAttribute("aria-expanded", "true");
    /* The facets are built once at load, so the suggestions are free — and they
     * are the whole reason this form is quick for a show that is already here. */
    fillDatalist(dom.artistList, state.facets?.artist);
    fillDatalist(dom.albumList, state.facets?.album);
    (dom.artist || dom.files)?.focus();
  }

  function closePanel() {
    if (dom.panel.hidden) return;
    if (running && !confirm("An upload is still running. Stop it and close? Partial files are cleaned up, but anything not yet committed will not be catalogued.")) {
      return;
    }
    if (running) {
      for (const xhr of active) xhr.abort();
      running = false;
      setSummary("Upload stopped. Nothing was committed.", "warn");
    }
    dom.panel.hidden = true;
    dom.open.setAttribute("aria-expanded", "false");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- the queue ---------- */

  async function startBatch() {
    if (running) return;

    const files = Array.from(dom.files?.files || []);
    if (!files.length) {
      setSummary("Choose at least one video file first — the file input is the box at the top of this panel.", "warn");
      return;
    }
    if (!dom.artist?.value.trim()) {
      setSummary("An artist is required: the catalog will not load an entry without one.", "warn");
      dom.artist?.focus();
      return;
    }
    if (dom.date?.value.trim() && !DATE_RE.test(dom.date.value.trim())) {
      setSummary("The date must be YYYY-MM-DD or a bare year (2023-06-18, or 2023). shows.json rejects anything else.", "warn");
      dom.date?.focus();
      return;
    }

    const rejected = files.filter((f) => !ACCEPT.includes(extname(f.name).toLowerCase()));
    const accepted = files.filter((f) => ACCEPT.includes(extname(f.name).toLowerCase()));
    if (rejected.length) {
      setSummary(
        `${rejected.length} file${rejected.length === 1 ? " was" : "s were"} skipped — not a video format (${ACCEPT.replace(/,/g, ", ")}): ${rejected.map((f) => f.name).slice(0, 3).join(", ")}${rejected.length > 3 ? ", …" : ""}`,
        "warn"
      );
    } else {
      setSummary("");
    }
    if (!accepted.length) return;

    running = true;
    if (dom.start) dom.start.disabled = true;
    if (dom.rows) dom.rows.textContent = "";
    if (dom.files) dom.files.value = "";

    let done = 0;
    let failed = 0;

    // Sequential, not parallel: fourteen concurrent multi-gigabyte PUTs would
    // starve each other and make every progress bar useless.
    for (const file of accepted) {
      const row = addRow(file);
      try {
        await uploadOne(file, dom, row, active);
        done += 1;
      } catch (err) {
        failed += 1;
        row.setStatus("error", err.message);
      }
    }

    running = false;
    if (dom.start) dom.start.disabled = false;

    if (!done) {
      setSummary(`Nothing was uploaded. ${failed} file${failed === 1 ? "" : "s"} failed — see the row above for why.`, "error");
      return;
    }
    setSummary(
      `Added ${done} clip${done === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}. Reloading…`,
      failed ? "warn" : "ok"
    );
    toast(`${done} clip${done === 1 ? "" : "s"} added to the catalog.`, failed ? "warn" : "ok", 4000);
    setTimeout(() => notifyCommitted(), RELOAD_DELAY_MS);
  }

  /**
   * plan -> PUT -> commit for one file.
   *
   * Any step throws with a message that says what failed, why, and what to do
   * next. A silent no-op here loses a multi-gigabyte transfer, so nothing in
   * this path is allowed to end quietly.
   */
  async function uploadOne(file, dom, row, active) {
    const meta = readMeta(dom);

    row.setStatus("busy", "Reading duration…");
    const duration = await readDuration(file);

    row.setStatus("busy", "Planning…");
    const plan = await postJson("/api/upload/plan", {
      ...meta,
      filename: file.name,
      size: file.size,
      extension: extname(file.name),
      duration,
    });

    row.setStatus("busy", "Uploading…");
    await putBytes(plan.path, file, row, active);

    row.setStatus("busy", "Adding to the catalog…");
    const committed = await postJson("/api/upload/commit", { ...plan, ...meta }, (r) => r);

    if (committed.sync && committed.sync.ok === false) {
      throw new Error(
        `the video is on disk at ${plan.src} and the catalog entry was written, but shows.json was not updated (${firstLine(committed.sync.stderr || committed.sync.stdout)}). Run: node tools/set-locations.mjs --show=${plan.showId}`
      );
    }

    row.setStatus("done", `Saved as ${committed.entry.id} → ${plan.src}`);
  }
}

/* ---------- steps ---------- */

/**
 * The metadata half of the form, read fresh for each file.
 *
 * A date, venue or location goes to shows.json, not onto the entry — the server
 * splits them the same way, and tools/set-locations.mjs reports an entry that
 * carries show fields as a bug.
 */
function readMeta(dom) {
  return {
    artist: dom.artist?.value.trim() || "",
    song: dom.song?.value.trim() || "",
    album: dom.album?.value.trim() || "",
    performance: dom.performance?.value.trim() || "",
    date: dom.date?.value.trim() || "",
    venue: dom.venue?.value.trim() || "",
    location: dom.location?.value.trim() || "",
    quality: dom.quality?.value || "",
    source: dom.source?.value || "",
  };
}

/**
 * POST JSON and surface the server's own error text.
 *
 * 403 is separated out because it is the one failure with a specific fix
 * (the server was started with PITTV_WRITE=0) and is not the user's fault.
 */
async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`could not reach ${url} (${err.message}). Is the PIT TV server still running?`);
  }

  if (res.status === 403) throw new Error(WRITE_DISABLED_HINT);

  let result = null;
  try {
    result = await res.json();
  } catch {
    throw new Error(`${url} answered ${res.status} with a body that was not JSON — the server may have restarted mid-upload.`);
  }
  if (!res.ok || result?.ok === false) {
    throw new Error(`${url} refused the upload: ${result?.error || `HTTP ${res.status}`}`);
  }
  return result;
}

/**
 * PUT the raw bytes with a real progress percentage.
 *
 * fetch() cannot report upload progress, which is the entire reason this step
 * is not folded into the commit request: a multi-gigabyte transfer with no
 * progress bar is indistinguishable from a hung server.
 */
function putBytes(path, file, row, active) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?path=${encodeURIComponent(path)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) row.setProgress(e.loaded / e.total, formatBytes(e.loaded));
    };

    xhr.onload = () => {
      active.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        row.setProgress(1, formatBytes(file.size));
        resolve();
        return;
      }
      let message = `HTTP ${xhr.status}`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        /* a proxy or crash page, not our JSON */
      }
      reject(new Error(`${message} — nothing was written; the temporary file was removed, so retry the upload.`));
    };

    xhr.onerror = () => {
      active.delete(xhr);
      reject(new Error("the connection dropped mid-transfer. The file was not moved into place, so retry — a truncated clip never reaches the catalog."));
    };
    xhr.onabort = () => {
      active.delete(xhr);
      reject(new Error("the upload was stopped before it finished, so the clip was not added. Select the file again to retry."));
    };

    active.add(xhr);
    xhr.send(file);
  });
}

/**
 * Read a video's duration client-side from an object URL.
 *
 * Asked of nobody: a phone clip's length is knowable without making the user
 * type it, and getting it wrong shows up as a bogus total time in the player.
 * Returns 0 rather than throwing when the browser cannot decode the header —
 * duration is optional metadata, and a failed read must not fail the upload.
 */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    // Some containers report Infinity until they are seeked; a hard cap keeps a
    // malformed header from holding the queue open forever.
    const timer = setTimeout(() => done(0), 10000);
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? Math.round(video.duration) : 0);
    video.onerror = () => done(0);
    video.src = url;
  });
}

/* ---------- rows ---------- */

function addRow(file) {
  const host = document.querySelector("[data-upload-rows]");
  if (!host) return noopRow();
  const node = document.createElement("div");
  node.className = "upload-row";
  node.dataset.state = "pending";
  node.innerHTML = `
    <span class="upload-row-name"></span>
    <span class="upload-row-size"></span>
    <span class="upload-row-bar"><span class="upload-row-fill"></span></span>
    <span class="upload-row-status"></span>`;
  node.querySelector(".upload-row-name").textContent = file.name;
  node.querySelector(".upload-row-size").textContent = formatBytes(file.size);
  node.querySelector(".upload-row-status").textContent = "Queued";
  host.appendChild(node);
  const fill = node.querySelector(".upload-row-fill");
  return {
    node,
    setStatus(state, message) {
      node.dataset.state = state;
      node.querySelector(".upload-row-status").textContent = message;
      if (state === "done") fill.style.width = "100%";
    },
    setProgress(fraction, label) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      node.dataset.state = "uploading";
      node.querySelector(".upload-row-status").textContent = label;
    },
  };
}

function noopRow() {
  return { node: null, setStatus() {}, setProgress() {} };
}

function setSummary(message, kind) {
  const node = document.querySelector("[data-upload-summary]");
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind || "";
  node.hidden = !message;
}

/* ---------- helpers ---------- */

/**
 * Populate a select from an allowlist, with a blank leading option.
 *
 * The blank default matters: without it the first allowlist value is selected
 * by default, and every clip would silently be filed as 4K / pro-shot. An
 * unset field is omitted from the entry, which is honest; a wrong one is not.
 */
function fillSelect(select, values) {
  if (!select) return;
  select.textContent = "";
  for (const value of ["", ...values]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value || "—";
    select.appendChild(option);
  }
}

/**
 * Facet suggestions for the artist and album inputs.
 *
 * buildFacets returns { value, count } objects, not strings — the counts are
 * what make the list useful, and the sidebar already renders them. The count
 * goes in the option's label so the browser's dropdown shows it alongside the
 * value without it becoming part of what gets typed into the field.
 */
function fillDatalist(list, values) {
  if (!list) return;
  list.textContent = "";
  for (const item of values || []) {
    if (!item) continue;
    const value = typeof item === "string" ? item : item.value;
    if (!value) continue;
    const option = document.createElement("option");
    option.value = value;
    if (typeof item === "object" && item.count) {
      option.label = `${item.count} clip${item.count === 1 ? "" : "s"}`;
    }
    list.appendChild(option);
  }
}

/**
 * Keep Tab inside the panel. It is a modal dialog, so focus must not wander to
 * the grid behind it — which is fully interactive and would swallow the next
 * keystroke into a search box.
 */
function trapTab(e, panel) {
  const focusable = panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function extname(name) {
  const dot = String(name).lastIndexOf(".");
  return dot <= 0 ? "" : String(name).slice(dot);
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(n) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function firstLine(text) {
  return String(text || "").trim().split("\n").filter(Boolean)[0] || "no output";
}

/**
 * The toast markup is keyed on data-kind in layout.css:559-570, not on a class
 * modifier, so the kind is set as an attribute to match the stylesheet.
 */
function toast(message, kind = "info", ms = 3200) {
  const stack = document.querySelector("[data-toasts]");
  if (!stack) {
    console.log(`[${kind}] ${message}`);
    return;
  }
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => node.remove(), ms);
}
