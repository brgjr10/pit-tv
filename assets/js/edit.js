/*
 * edit.js — inline song title editing with write-back to catalog.json.
 *
 * Toggles edit mode on the list view so every song title becomes an
 * editable input. Changes are tracked in memory as a patch by entry id;
 * "Save to disk" POSTs that patch to /api/catalog, which merges it onto the
 * raw file server-side. A plain static host falls back to downloading the
 * patched catalog for the user to drop over data/catalog.json.
 */

import { getRawCatalog } from "./store.js";
import { withWriteLock } from "./sync.js";
import { loadCatalog, toRawEntry } from "./catalog.js";
import { apiFetch, requestApiToken } from "./api.js";

let editMode = false;
let dirty = false;
/* Supplied by app.js: the grid must be re-rendered when the mode flips, because
 * the editable title is chosen at render time rather than toggled in place. */
let rerender = () => {};

let pendingWrites = 0;

/**
 * The fields the user has actually changed, by entry id. Only these are sent to
 * /api/catalog — the server merges them onto the raw file, so a save can never
 * bake normalised defaults (datePrecision, an empty songs array, "Unknown venue")
 * back into entries that never had them.
 */
const pendingChanges = new Map();

export const editState = {
  isEditing: () => editMode,
  isDirty: () => dirty,
};

/** Record a field edit so saveCatalog can build a minimal patch. */
export function recordChange(entryId, field, value) {
  let fields = pendingChanges.get(entryId);
  if (!fields) {
    fields = {};
    pendingChanges.set(entryId, fields);
  }
  fields[field] = value;
  markDirty();
}

export function initEdit({ rerender: onRerender } = {}) {
  if (onRerender) rerender = onRerender;
  const dom = {
    toggle: document.querySelector("[data-edit-toggle]"),
    bar: document.querySelector("[data-edit-bar]"),
    done: document.querySelector("[data-edit-done]"),
    saveBtn: document.querySelector("[data-save-catalog]"),
    cancelBtn: document.querySelector("[data-cancel-edit]"),
  };

  if (!dom.toggle) return null;

  dom.toggle.addEventListener("click", () => toggleEdit());
  dom.saveBtn.addEventListener("click", saveCatalog);
  dom.cancelBtn.addEventListener("click", cancelEdit);

  // E key toggles edit mode
  document.addEventListener("keydown", (e) => {
    if (editMode && (e.key === "Escape" || e.key === "e")) {
      if (e.key === "Escape") { cancelEdit(); return; }
    }
    if (!editMode && e.key === "e" && !isTypingTarget(e.target)) {
      e.preventDefault();
      toggleEdit();
    }
  });

  return { toggleEdit, saveCatalog, isEditing: () => editMode, isDirty: () => dirty };
}

function isTypingTarget(el) {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function toggleEdit() {
    editMode = !editMode;
    document.body.classList.toggle("edit-mode", editMode);
    const btn = document.querySelector("[data-edit-toggle]");
    if (btn) btn.setAttribute("aria-pressed", String(editMode));
    const bar = document.querySelector("[data-edit-bar]");
    if (bar) bar.hidden = !editMode;
    if (editMode) {
      pendingWrites = 0;
      updateEditProgress();
      toast("Click any song title to edit it. Press E or Esc to exit.", "info");
    }
    // Re-render last: leaving edit mode has to strip the contenteditable spans
    // back out again, not just hide the bar.
    rerender();
  }

function updateEditProgress() {
  const done = document.querySelector("[data-edit-done]");
  if (done) done.textContent = String(pendingWrites);
}

export function markDirty() {
  dirty = true;
  pendingWrites += 1;
  updateEditProgress();
}

export function isEditing() { return editMode; }

/**
 * Build the patch for /api/catalog from the pending field edits.
 *
 * Each entry is projected through toRawEntry so only the on-disk field set
 * (id, artist, song, songId, clipIndex, album, video, songs, albumArt, tags,
 * metadata, chapters, note) is sent — never datePrecision, dateRaw, a
 * defaulted venue, an empty songs array, or the show-level date/venue/location
 * that live in shows.json (PIT-TV-018). Entries that were never edited are omitted entirely.
 */
function buildPatch() {
  const changes = {};
  for (const [id, fields] of pendingChanges) {
    const raw = toRawEntry(fields);
    if (raw && Object.keys(raw).length) changes[id] = raw;
  }
  return { changes };
}

/**
 * Write the pending patch to /api/catalog and re-seed state from the file.
 *
 * `allowDownload` is false for a clip reorder: the static-host fallback hands
 * the user a whole catalog.json to drop over the real one, which is the right
 * answer for a deliberate title edit and the wrong one for a press of an arrow
 * key. Those callers get a refusal message instead.
 *
 * Resolves true when the write landed and the catalog was re-read.
 */
export async function saveCatalog({ allowDownload = true } = {}) {
  return withWriteLock(async () => {
    const patch = buildPatch();
    const hasPatch = Object.keys(patch.changes).length > 0;

    if (!hasPatch) {
      toast("Nothing to save — no titles were changed.", "info");
      return false;
    }

    // A reorder has no sensible static-host fallback (handing the user a whole
    // catalog.json to drop over the real one because they pressed an arrow key
    // is not a feature), so these callers get a refusal that names the actual
    // cause. PITTV_WRITE is only suggested when the cause could plausibly be
    // the write gate — an EPERM from the atomic rename is the filesystem, and
    // telling the user to set an env var would send them the wrong way.
    const refuseDownload = (err) => {
      const gated = err?.status === 403 || err?.name === "TypeError";
      toast(
        gated
          ? `Not saved: ${err.message} The server may not accept writes — writes are on by default, so check PITTV_WRITE=0.`
          : `Not saved: ${err.message}`,
        "warn",
        8000
      );
      return false;
    };

    let res;
    try {
      res = await apiFetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      // A static host has no /api/catalog. Fall back to the old download and
      // say so plainly — the user must replace the file by hand.
      if (!allowDownload) return refuseDownload(err);
      return fallbackDownload(patch, err);
    }

    if (res.status === 403) {
      toast("Writes are disabled: this server was started with PITTV_WRITE=0.", "warn", 6000);
      return false;
    }

    if (res.status === 401) {
      // A published server refuses writes without the operator's token. Say how
      // to supply it rather than leaving a bare 401 the user cannot act on.
      if (requestApiToken()) {
        toast("Token saved. Try the edit again.", "ok", 4000);
      } else {
        toast("Write token required — nothing was changed.", "warn", 6000);
      }
      return false;
    }

    let result;
    try {
      result = await res.json();
    } catch {
      if (!allowDownload) return refuseDownload(new Error("the server answered but the body was not JSON"));
      return fallbackDownload(patch, new Error("the server answered but the body was not JSON"));
    }

    if (!res.ok || result.error) {
      if (!allowDownload) return refuseDownload(new Error(result.error || `HTTP ${res.status}`));
      return fallbackDownload(patch, new Error(result.error || `HTTP ${res.status}`));
    }

    if (result.conflicts?.length) {
      toast(`Not saved: ${result.conflicts.length} entr${result.conflicts.length === 1 ? "y" : "ies"} no longer exist on disk (${result.conflicts.slice(0, 4).join(", ")}${result.conflicts.length > 4 ? ", …" : ""}). Reopen the catalog and try again.`, "warn", 8000);
      return false;
    }

    // Re-seed from the catalog the server just wrote, not from a second fetch of
    // data/catalog.json. The response body is the file as it stands after this
    // write (and after the server re-derived shows.json), so state matches disk
    // exactly — which is what a clip reorder depends on: the order on screen must
    // be the order that was persisted, or ↑/↓ appear to work and revert on
    // reload. A re-fetch could also be served from a cache the write did not
    // invalidate. The fallback matters only for a server that omits `catalog`.
    await loadCatalog(Array.isArray(result.catalog) && result.catalog.length ? { raw: result.catalog } : {});

    dirty = false;
    pendingWrites = 0;
    pendingChanges.clear();
    updateEditProgress();
    toast("Catalog saved to disk", "success");
    return true;
  });
}

/**
 * The static-host fallback. /api/catalog is only served by tools/serve.js, so
 * a plain file server cannot accept the write — offer the download the old
 * code path did, and say exactly what the user has to do with it.
 */
function fallbackDownload(patch, err) {
  const raw = getRawCatalog();
  const next = raw.map((e) => {
    const fields = patch.changes[e.id];
    return fields ? { ...e, ...fields } : e;
  });
  const json = JSON.stringify(next, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "data/catalog.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Could not write to the server (${err.message}) — downloaded catalog.json instead; drop it over data/catalog.json to apply the changes.`, "warn", 8000);
}

function cancelEdit() {
  if (dirty) {
    if (!confirm("Discard unsaved changes?")) return;
  }
  editMode = false;
  dirty = false;
  pendingWrites = 0;
  pendingChanges.clear();
  document.body.classList.remove("edit-mode");
  const btn = document.querySelector("[data-edit-toggle]");
  if (btn) btn.setAttribute("aria-pressed", "false");
  const bar = document.querySelector("[data-edit-bar]");
  if (bar) bar.hidden = true;
  updateEditProgress();
  rerender();
}

function toast(message, kind = "info", ms = 3200) {
  const stack = document.querySelector("[data-toasts]");
  if (!stack) { console.log(`[${kind}] ${message}`); return; }
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => node.remove(), ms);
}