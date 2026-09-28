/*
 * edit.js — inline song title editing with write-back to catalog.json.
 *
 * Toggles edit mode on the list view so every song title becomes an
 * editable input. Changes are tracked in memory; "Save to disk" writes the
 * full catalog back to data/catalog.json using the File System Access API
 * (when available) with a download fallback.
 */

import { state, subscribe } from "./store.js";
import { reconcileShows, writeShows, withWriteLock } from "./sync.js";

let editMode = false;
let dirty = false;
let pendingWrites = 0;
let totalEntries = 0;

export const editState = {
  isEditing: () => editMode,
  isDirty: () => dirty,
};

export function initEdit() {
  const dom = {
    toggle: document.querySelector("[data-edit-toggle]"),
    bar: document.querySelector("[data-edit-bar]"),
    done: document.querySelector("[data-edit-done]"),
    total: document.querySelector("[data-edit-total]"),
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
      totalEntries = state.catalog.length;
      pendingWrites = 0;
      updateEditProgress();
      toast("Click any song title to edit it. Press E or Esc to exit.", "info");
    }
  }

function updateEditProgress() {
  const done = document.querySelector("[data-edit-done]");
  const total = document.querySelector("[data-edit-total]");
  if (done) done.textContent = String(pendingWrites);
  if (total) total.textContent = String(totalEntries);
}

export function markDirty() {
  dirty = true;
  pendingWrites++;
  updateEditProgress();
}

export function isEditing() { return editMode; }

async function saveCatalog() {
  return withWriteLock(async () => {
    const json = JSON.stringify(state.catalog, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const filename = "data/catalog.json";

    // Try File System Access API first
    let wrote = false;
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: "catalog.json",
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        wrote = true;
      }
    } catch (err) {
      if (err.name === "AbortError") return; // user cancelled
      console.warn("[edit] File System Access API failed, falling back to download", err);
    }

    if (!wrote) {
      // Fallback: trigger a download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("Catalog downloaded — replace data/catalog.json manually", "warn", 5000);
    }

    // The catalog is the source of truth for shows.json: clip counts and artist
    // rosters are derived, so a catalog save is also a shows save.
    try {
      const existing = await (await fetch("data/shows.json", { cache: "no-store" })).json();
      const { doc, changed } = reconcileShows(state.catalog, existing);
      if (changed) await writeShows(doc);
    } catch (err) {
      console.warn("[edit] shows.json was not re-synced after save", err);
    }

    dirty = false;
    pendingWrites = 0;
    updateEditProgress();
    toast("Catalog saved to disk", "success");
  });
}

function cancelEdit() {
  if (dirty) {
    if (!confirm("Discard unsaved changes?")) return;
  }
  editMode = false;
  dirty = false;
  pendingWrites = 0;
  document.body.classList.remove("edit-mode");
  const btn = document.querySelector("[data-edit-toggle]");
  if (btn) btn.setAttribute("aria-pressed", "false");
  const bar = document.querySelector("[data-edit-bar]");
  if (bar) bar.hidden = true;
  updateEditProgress();
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