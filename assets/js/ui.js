/*
 * ui.js — rendering, events and keyboard navigation.
 *
 * Views are rendered as real DOM (no innerHTML for untrusted fields; every
 * catalog string goes through escapeHtml) so focus, roving tabindex and screen
 * reader semantics work without re-implementing them.
 */

import {
  state,
  subscribe,
  setView,
  setSort,
  setSearchQuery,
  setFilter,
  setFiltered,
  toggleFilter,
  clearFilters,
  setSetting,
  readPosition,
} from "./store.js";
import { loadCatalog, formatDate, formatDuration, playableEntry, setlistFor } from "./catalog.js";
import { queryCatalog, highlight, escapeHtml, activeFilterSummary, SORT_FIELDS } from "./search.js";
import { createPlayer, isTypingTarget } from "./player.js?v=2026-09-27-fullscreen-fix-v4";
import { themeFromEntry, resetTheme } from "./theme.js";
import { editState, markDirty } from "./edit.js";
import {
  staggerIn,
  crossFade,
  sharedElement,
  closeModal,
  popIn,
  popOut,
  morphResults,
  pulse,
  toastIn,
  toastOut,
  countUp,
  reducedMotion,
  setReducedMotion,
} from "./anime-helpers.js";

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const FILTER_LABELS = {
  artist: "Artist",
  venue: "Venue",
  album: "Album",
  quality: "Quality",
  source: "Source",
};

export function initUI() {
  const dom = grabDOM();
  assertDOM(dom);
  const player = createPlayer(dom.modal);

  /* ---------- boot ---------- */

  function grabDOM() {
    const q = (sel) => document.querySelector(sel);
    return {
      grid: q("[data-view-grid]"),
      list: q("[data-view-list]"),
      listHead: q("[data-list-head]"),
      artist: q("[data-view-artist]"),
      timeline: q("[data-view-timeline]"),
      sidebar: q("[data-sidebar]"),
      filters: q("[data-filters]"),
      chips: q("[data-chips]"),
      search: q("[data-search]"),
      searchCount: q("[data-search-count]"),
      resultCount: q("[data-result-count]"),
      sortField: q("[data-sort-field]"),
      sortDir: q("[data-sort-dir]"),
      viewButtons: [...document.querySelectorAll("[data-set-view]")],
      sidebarToggle: q("[data-sidebar-toggle]"),
      settingsBtn: q("[data-settings]"),
      settings: q("[data-settings-panel]"),
      modal: q("[data-modal]"),
      modalBackdrop: q("[data-modal-backdrop]"),
      modalClose: q("[data-modal-close]"),
      modalTitle: q("[data-modal-title]"),
      modalByline: q("[data-modal-byline]"),
      modalFacts: q("[data-modal-facts]"),
      queue: q("[data-queue]"),
      toasts: q("[data-toasts]"),
      shortcuts: q("[data-shortcuts]"),
      shortcutsPanel: q("[data-shortcuts-panel]"),
      showShortcuts: q("[data-show-shortcuts]"),
      reducedToggle: q("[data-toggle-reduced]"),
      autoplayToggle: q("[data-toggle-autoplay]"),
      themeSelect: q("[data-select-theme]"),
      live: q("[data-live]"),
    };
  }

  /**
   * The module graph is fixed and index.html is hand-maintained, so a missing
   * hook is a build mistake, not a runtime condition. Fail with the list of
   * offending selectors instead of a bare "cannot read property of null".
   */
  function assertDOM(dom) {
    const required = [
      "grid", "list", "listHead", "artist", "timeline",
      "sidebar", "filters", "chips", "search", "resultCount",
      "sortField", "sortDir", "modal", "modalBackdrop", "modalClose",
      "modalTitle", "modalByline", "modalFacts", "queue", "toasts",
      "shortcuts", "shortcutsPanel", "showShortcuts", "settingsBtn",
      "settings", "reducedToggle", "autoplayToggle", "themeSelect",
    ];
    const missing = required.filter((key) => !dom[key]);
    if (missing.length) {
      throw new Error(
        `index.html is missing required hooks: ${missing.join(", ")} — ` +
        `check that every data-* attribute the UI queries is still present.`
      );
    }
  }

  /* ---------- rendering ---------- */

  function activeViewEl() {
    return { grid: dom.grid, list: dom.list, artist: dom.artist, timeline: dom.timeline }[state.view];
  }

  function render({ animate = true } = {}) {
    const { entries } = queryCatalog(state.catalog, {
      filters: state.filters,
      searchQuery: state.searchQuery,
      sort: state.sort,
    });

    const container = activeViewEl();
    const previous = animate ? snapshotRects(container) : null;

    clearView(container);

    let nodes = [];
    if (entries.length) {
      nodes = renderEntries(entries, container);
    } else {
      const target = container === dom.list ? listBody() : container;
      target.innerHTML = emptyStateMarkup();
    }
    setFiltered(entries);

    renderChips();
    syncControls();
    updateCounts(entries.length, animate);
    announce(`${entries.length} ${entries.length === 1 ? "result" : "results"}`);

    if (!animate || !entries.length) return;

    animateReconcile(container, nodes, previous);
  }

  /**
   * Empty the active view.
   *
   * The list view owns a persistent header, so it is detached and re-appended
   * rather than wiped — otherwise the cached reference to the row container
   * would point at a detached node and every row would render into the void.
   */
  function clearView(container) {
    if (container === dom.list) {
      const head = dom.list.querySelector("[data-list-head]");
      const body = listBody();
      container.replaceChildren(head ?? document.createComment("no header"), body);
      body.replaceChildren();
      return;
    }
    container.replaceChildren();
  }

  /** The list row container, created on first use and kept stable thereafter. */
  function listBody() {
    let body = dom.list.querySelector("[data-list-body]");
    if (!body) {
      body = el("div", "list-body");
      body.dataset.listBody = "";
      dom.list.appendChild(body);
    }
    return body;
  }

  /**
   * Reconcile a re-render against what was on screen:
   *   - ids that survived -> FLIP from their old position (no jump on filter/sort)
   *   - new ids          -> staggered rise-in
   *   - dropped ids      -> a cloned ghost animates out, then removes itself
   */
  function animateReconcile(container, nodes, previous) {
    const survivors = [];
    const fresh = [];

    for (const node of nodes) {
      const before = previous.get(node.dataset.id);
      if (!before) {
        fresh.push(node);
        continue;
      }
      const deltaY = before.top - node.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) continue;
      survivors.push({ node, deltaY });
    }

    if (survivors.length && window.anime && !reducedMotion()) {
      window.anime({
        targets: survivors.map((s) => s.node),
        translateY: survivors.map((s) => s.deltaY),
        duration: 420,
        easing: "easeOutExpo",
        complete: () =>
          window.anime({ targets: survivors.map((s) => s.node), translateY: 0, duration: 0 }),
      });
    }

    if (fresh.length) {
      fresh.forEach((n) => n.classList.add("anim-pre"));
      staggerIn(fresh, { step: 28, start: 60, distance: 20, duration: 380 });
    }

    // Exit ghosts: clone the outgoing node into a fixed-position layer so the
    // removal is animated even though the live node is already replaced.
    const leaving = [...previous.keys()].filter((id) => !nodes.some((n) => n.dataset.id === id));
    if (!leaving.length || !window.anime || reducedMotion()) return;

    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;z-index:1;pointer-events:none";
    document.body.appendChild(layer);

    const ghosts = [];
    for (const id of leaving) {
      const source = previous.get(id).node;
      if (!source?.isConnected) continue;
      const rect = previous.get(id);
      const ghost = source.cloneNode(true);
      ghost.removeAttribute("tabindex");
      ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;pointer-events:none`;
      layer.appendChild(ghost);
      ghosts.push(ghost);
    }

    if (!ghosts.length) {
      layer.remove();
      return;
    }

    window.anime({
      targets: ghosts,
      keyframes: [{ opacity: [1, 0], scale: [1, 0.93], duration: 200, easing: "easeInOutQuad" }],
      complete: () => layer.remove(),
    });
  }

  /** Record on-screen rects for every rendered entry, keyed by id. */
  function snapshotRects(container) {
    const map = new Map();
    for (const node of container.querySelectorAll("[data-entry]")) {
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      map.set(node.dataset.id, { node, top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    }
    return map;
  }

  function renderEntries(entries, container) {
    switch (state.view) {
      case "list":
        return entries.map((e) => renderRow(e, listBody()));
      case "artist":
        return renderArtistView(entries);
      case "timeline":
        return renderTimelineView(entries);
      default:
        return entries.map((e) => renderCard(e, dom.grid));
    }
  }

  /* ---- grid card ---- */

  function renderCard(entry, container) {
    const node = el("article", "video-card");
    node.dataset.id = entry.id;
    node.dataset.entry = entry.id;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", cardLabel(entry));

    const duration = entry.video.duration;
    const position = readPosition(entry.id);
    const songCount = (entry.songs || []).length;

    node.innerHTML = `
      <div class="card-art" data-missing="${!entry.albumArt}" data-fallback="${escapeHtml(initials(entry.artist))}">
        ${entry.albumArt ? artImg(entry) : ""}
        <button class="card-play" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        <span class="card-duration" data-songs="${songCount}">${songCount ? `${songCount} songs` : duration ? formatDuration(duration) : "--:--"}</span>
      </div>
      <div class="card-body">
        <div class="card-song">${editableTitle(entry)}</div>
        <div class="card-artist">${highlight(entry.artist, state.searchQuery)}</div>
        <div class="card-meta">
          <span>${escapeHtml(formatDate(entry.date, entry.datePrecision))}</span>
          <span class="dot"></span>
          <span>${highlight(entry.venue, state.searchQuery)}</span>
        </div>
        ${tagBadges(entry)}
      </div>
      ${position && duration ? `<span class="card-progress" style="transform:scaleX(${position / duration})"></span>` : ""}
    `;

    attachOpen(node, entry);
    container.appendChild(node);
    return node;
  }

  /** Screen-reader text for a card or row: a show says how many videos it holds. */
  function cardLabel(entry) {
    const when = formatDate(entry.date, entry.datePrecision);
    const count = (entry.songs || []).length;
    return `${entry.artist} — ${entry.song}, ${when}${count ? `, ${count} songs` : ""}`;
  }

  /** The right-hand column of a list row: a song count, or a duration. */
  function lengthCell(entry) {
    const count = (entry.songs || []).length;
    if (count) return `<span class="badge" data-songs="${count}">${count} songs</span>`;
    return entry.video.duration ? formatDuration(entry.video.duration) : "--:--";
  }

  /** Timeline rows stay narrow, so a setlist collapses to a count. */
  function timelineBadge(entry) {
    const count = (entry.songs || []).length;
    if (count) return `${count} songs`;
    return escapeHtml(entry.metadata.quality || entry.video.type);
  }

  /* ---- list row ---- */

  function renderRow(entry, container) {
    const node = el("div", "row");
    node.dataset.id = entry.id;
    node.dataset.entry = entry.id;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", cardLabel(entry));

    node.innerHTML = `
      <div class="thumb">${entry.albumArt ? artImg(entry) : ""}</div>
      <div class="primary">
        <span class="title">${editableTitle(entry)}</span>
        <span class="sub">${highlight(entry.artist, state.searchQuery)}</span>
      </div>
      <div class="venue col-optional">${highlight(entry.venue, state.searchQuery)}</div>
      <div class="date">${escapeHtml(formatDate(entry.date, entry.datePrecision))}</div>
      <div class="album">${entry.album ? `<span title="${escapeHtml(entry.album)}">${highlight(entry.album, state.searchQuery)}</span>` : ""}</div>
      <div class="quality col-optional">${entry.metadata.quality ? qualityBadge(entry) : `<span class="badge">${escapeHtml(entry.video.type)}</span>`}</div>
      <div class="col-optional">${locationCell(entry)}</div>
      <div class="num">${lengthCell(entry)}</div>
    `;

    attachOpen(node, entry);
    container.appendChild(node);
    return node;
  }

  /* ---- artist view ---- */

  function renderArtistView(entries) {
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.artist)) groups.set(entry.artist, []);
      groups.get(entry.artist).push(entry);
    }

    const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const nodes = [];

    for (const [artist, list] of ordered) {
      const section = el("section", "artist-section");
      const years = list.map((e) => e.date.slice(0, 4)).filter(Boolean);
      const first = years.length ? Math.min(...years) : "";
      const last = years.length ? Math.max(...years) : "";
      // "2019" reads better than "2019–2019" for a single year.
      const span = !first ? "" : first === last ? first : `${first}–${last}`;

      section.dataset.open = "true";
      section.innerHTML = `
        <button class="artist-head" type="button" aria-expanded="true">
          <span class="artist-caret">▼</span>
          <span class="artist-name">${highlight(artist, state.searchQuery)}</span>
          <span class="artist-stats">${list.length} ${list.length === 1 ? "video" : "videos"}${span ? ` · ${span}` : ""}</span>
          <span class="artist-span"></span>
        </button>
        <div class="artist-grid"></div>
      `;

      const grid = section.querySelector(".artist-grid");
      for (const entry of list) nodes.push(renderCard(entry, grid));

      section.querySelector(".artist-head").addEventListener("click", () => {
        const open = section.dataset.open !== "false";
        section.dataset.open = String(!open);
        section.querySelector(".artist-head").setAttribute("aria-expanded", String(!open));
        if (window.anime && !reducedMotion()) {
          const grid = section.querySelector(".artist-grid");
          window.anime({
            targets: grid,
            opacity: [open ? 1 : 0, open ? 0 : 1],
            translateY: [0, open ? -6 : 6],
            duration: 220,
            easing: "easeOutExpo",
          });
        }
      });

      dom.artist.appendChild(section);
    }

    return nodes;
  }

  /* ---- timeline view ---- */

  function renderTimelineView(entries) {
    const chronological = [...entries].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const nodes = [];

    let currentYear = null;
    let currentMonth = null;
    let rail = null;

    for (const entry of chronological) {
      const year = entry.date.slice(0, 4) || "Undated";
      // A year-precision date has no month to group under.
      const month = entry.datePrecision === "year" ? "" : entry.date.slice(5, 7) || "";

      if (year !== currentYear) {
        currentYear = year;
        currentMonth = null;
        const heading = el("div", "timeline-year");
        heading.textContent = year;
        dom.timeline.appendChild(heading);
        rail = el("div", "timeline-rail");
        dom.timeline.appendChild(rail);
      }

      if (month && month !== currentMonth) {
        currentMonth = month;
        const label = el("div", "timeline-month");
        label.textContent = monthLabel(month);
        rail.appendChild(label);
      }

      const item = el("button", "tl-item");
      item.type = "button";
      item.dataset.id = entry.id;
      item.dataset.entry = entry.id;
      item.innerHTML = `
        <span class="tl-date">${escapeHtml(formatDate(entry.date, entry.datePrecision))}</span>
        ${entry.albumArt ? artImg(entry, "tl-thumb") : ""}
        <span class="tl-main">
          <span class="t">${editableTitle(entry)}</span>
          <span class="s">${highlight(entry.artist, state.searchQuery)}</span>
        </span>
        <span class="tl-venue">${highlight(entry.venue, state.searchQuery)}</span>
        <span class="badge" data-songs="${(entry.songs || []).length}">${timelineBadge(entry)}</span>
      `;
      attachOpen(item, entry);
      rail.appendChild(item);
      nodes.push(item);
    }

    return nodes;
  }

  /* ---------- small builders ---------- */

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function artImg(entry, className = "") {
    return `<img class="${className}" src="${escapeHtml(entry.albumArt)}" alt="" loading="lazy" decoding="async"
      onerror="this.closest('.card-art')?.setAttribute('data-missing','true');this.remove()">`;
  }

  /** An editable song title span. In edit mode it becomes an input. */
  function editableTitle(entry, extraClass = "") {
    const editing = editState && editState.isEditing();
    const title = escapeHtml(entry.song || "");
    const cls = `edit-title ${extraClass} ${title ? "" : "empty"}`.trim();
    if (editing) {
      return `<span class="${cls}" contenteditable="true" spellcheck="false" data-entry-id="${escapeHtml(entry.id)}" data-field="song">${title}</span>`;
    }
    return `<span class="${cls.replace("edit-title ", "")}">${highlight(entry.song, state.searchQuery)}</span>`;
  }

  /** Attach delegated listener for editable song titles. */
  function attachEditableListeners() {
    const container = document.querySelector(".main");
    if (!container) return;
    container.addEventListener("focusin", (e) => {
      const el = e.target.closest("[contenteditable='true']");
      if (!el) return;
      el.classList.add("editing");
      if (el.textContent.trim()) el.classList.remove("empty");
    });
    container.addEventListener("input", (e) => {
      const el = e.target.closest("[contenteditable='true']");
      if (!el) return;
      el.classList.toggle("empty", !el.textContent.trim());
    });
    container.addEventListener("focusout", (e) => {
      const el = e.target.closest("[contenteditable='true']");
      if (!el) return;
      el.classList.remove("editing");
      el.classList.toggle("empty", !el.textContent.trim());
      const entryId = el.dataset.entryId;
      const field = el.dataset.field;
      const value = el.textContent.trim();
      if (!entryId || !field) return;
      const entry = state.catalog.find((e) => e.id === entryId);
      if (!entry) return;
      const old = entry[field] || "";
      if (value !== old) {
        entry[field] = value;
        markDirty();
      }
    });
    container.addEventListener("keydown", (e) => {
      const el = e.target.closest("[contenteditable='true']");
      if (!el) return;
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      if (e.key === "Escape") { e.preventDefault(); el.blur(); }
    });
  }

  function qualityBadge(entry) {
    return `<span class="badge" data-quality="${escapeHtml(entry.metadata.quality)}">${escapeHtml(entry.metadata.quality)}</span>`;
  }

  function tagBadges(entry) {
    const badges = [];
    if (entry.metadata.quality) badges.push(qualityBadge(entry));
    if (entry.metadata.source) {
      badges.push(`<span class="badge" data-source="${escapeHtml(entry.metadata.source)}">${escapeHtml(entry.metadata.source)}</span>`);
    }
    if (entry.album) {
      badges.push(`<span class="badge" data-album="${escapeHtml(entry.album)}" title="${escapeHtml(entry.album)}">${escapeHtml(entry.album)}</span>`);
    }
    return badges.length ? `<div class="card-tags">${badges.join("")}</div>` : "";
  }

  function locationCell(entry) {
    if (!entry.location) return `<span class="badge">${escapeHtml(entry.venue)}</span>`;
    return `<span class="badge">${escapeHtml(entry.location)}</span>`;
  }

  function initials(value) {
    return (value || "?")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase();
  }

  function monthLabel(mm) {
    const d = new Date(2000, Number(mm) - 1, 1);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "long" });
  }

  function emptyStateMarkup() {
    const filtered = Object.values(state.filters).some((v) => (Array.isArray(v) ? v.length : v));
    if (state.searchQuery) {
      return `<div class="state">
        <span class="state-icon">🔍</span>
        <h3>No matches for “${escapeHtml(state.searchQuery)}”</h3>
        <p>Try a different spelling, or search by venue, album or tag instead.</p>
        <button class="btn" type="button" data-action="clear-all">Clear search &amp; filters</button>
      </div>`;
    }
    if (filtered) {
      return `<div class="state">
        <span class="state-icon">🎛</span>
        <h3>No concerts match these filters</h3>
        <p>${state.catalog.length} ${state.catalog.length === 1 ? "entry is" : "entries are"} in the catalog, none of which match the current combination.</p>
        <button class="btn" type="button" data-action="clear-all">Reset filters</button>
      </div>`;
    }
    return `<div class="state">
      <span class="state-icon">💿</span>
      <h3>The catalog is empty</h3>
      <p>Add entries to <code>data/catalog.json</code> and reload to populate the archive.</p>
    </div>`;
  }

  /* ---------- filter sidebar ---------- */

  function renderFilters() {
    const groups = Object.entries(state.facets)
      .filter(([key, values]) => values.length)
      .map(([key, values]) => {
        const selected = state.filters[key] || [];
        const options = values
          .map(
            ({ value, count }) => `
        <label class="filter-option">
          <input type="checkbox" data-filter-key="${key}" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""}>
          <span class="filter-box"></span>
          <span class="filter-label">${highlight(value, state.searchQuery)}</span>
          <span class="filter-n">${count}</span>
        </label>`
          )
          .join("");
        return `<details class="filter-group" open>
          <summary>${FILTER_LABELS[key] || key}<span class="count">${selected.length || ""}</span></summary>
          <div class="filter-list">${options}</div>
        </details>`;
      })
      .join("");

    const dateFrom = state.filters.dateFrom || "";
    const dateTo = state.filters.dateTo || "";
    const dateGroup = `<details class="filter-group" ${dateFrom || dateTo ? "open" : ""}>
      <summary>Date range<span class="count">${dateFrom || dateTo ? "1" : ""}</span></summary>
      <div class="date-range">
        <input type="date" data-filter-key="dateFrom" value="${escapeHtml(dateFrom)}" aria-label="From date">
        <span class="filter-n">to</span>
        <input type="date" data-filter-key="dateTo" value="${escapeHtml(dateTo)}" aria-label="To date">
      </div>
    </details>`;

    dom.filters.innerHTML = dateGroup + groups;
  }

  function renderChips() {
    const chips = activeFilterSummary(state.filters);
    const parts = chips.map(
      (chip) => `<span class="chip"><span class="k">${escapeHtml(chip.label.split(":")[0])}</span>${escapeHtml(chip.label.split(":").slice(1).join(":").trim())}
        <button type="button" aria-label="Remove ${escapeHtml(chip.label)}" data-chip-key="${chip.key}" data-chip-value="${escapeHtml(chip.value)}">×</button></span>`
    );
    if (state.searchQuery) {
      parts.unshift(`<span class="chip"><span class="k">Search</span>${escapeHtml(state.searchQuery)}
        <button type="button" aria-label="Clear search" data-chip-key="search" data-chip-value="">×</button></span>`);
    }
    if (parts.length) {
      parts.push(`<button class="chip chip-clear" type="button" data-action="clear-all">Clear all</button>`);
    }
    dom.chips.innerHTML = parts.join("");

    // Facet counts change as filters change, so the sidebar is re-rendered too.
    renderFilters();
  }

  function syncControls() {
    for (const btn of dom.viewButtons) {
      const active = btn.dataset.setView === state.view;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
    // A restored preference (or a keyboard view switch) can land on a container
    // that has never been activated, so the classes are authoritative here.
    for (const [view, node] of Object.entries({
      grid: dom.grid,
      list: dom.list,
      artist: dom.artist,
      timeline: dom.timeline,
    })) {
      node.classList.toggle("active", view === state.view);
    }

    dom.sortField.value = state.sort.field;
    dom.sortDir.textContent = state.sort.dir === "desc" ? "↓" : "↑";
    dom.sortDir.setAttribute("aria-label", state.sort.dir === "desc" ? "Descending" : "Ascending");
    if (dom.search.value !== state.searchQuery) dom.search.value = state.searchQuery;
    dom.sidebar.classList.toggle("collapsed", !state.settings.sidebarOpen);
    dom.sidebarToggle.setAttribute("aria-pressed", String(state.settings.sidebarOpen));
    dom.sidebarToggle.setAttribute("aria-label", state.settings.sidebarOpen ? "Hide filters" : "Show filters");
  }

  function updateCounts(count, animate) {
    const el = dom.resultCount;
    el.innerHTML = `<strong>${count}</strong> of ${state.catalog.length}`;
    dom.searchCount.textContent = state.searchQuery ? `${count} found` : "";
    if (animate) countUp(el.querySelector("strong"), count);
  }

  function announce(message) {
    if (dom.live) dom.live.textContent = message;
  }

  /* ---------- toasts ---------- */

  function toast(message, kind = "info", ms = 3200) {
    const node = el("div", "toast");
    node.dataset.kind = kind;
    node.textContent = message;
    dom.toasts.appendChild(node);
    toastIn(node);
    setTimeout(() => {
      toastOut(node, () => node.remove());
    }, ms);
  }

  /* ---------- opening the player ---------- */

  function attachOpen(node, entry) {
    node.addEventListener("click", (e) => {
      if (editState && editState.isEditing()) return;
      openEntry(entry, node);
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (editState && editState.isEditing()) return;
        openEntry(entry, node);
      }
    });
  }

  let openCard = null;

  async function openEntry(entry, sourceNode) {
    openCard = sourceNode;

    // A show with a setlist opens on the video you last watched, so reopening a
    // concert picks up where you left off instead of restarting the bill.
    const row = setlistFor(entry)[initialRowIndex(entry)];
    renderModalInfo(entry, row.song);
    renderQueuePanel(entry, row.id);

    dom.modal.hidden = false;
    dom.modal.dataset.open = "true";
    document.body.style.overflow = "hidden";
    sharedElement(sourceNode, dom.modal, dom.modalBackdrop);
    dom.modalClose.focus({ preventScroll: true });
    if (window.anime && !reducedMotion()) {
      window.anime({ targets: dom.modalBackdrop, opacity: [0, 1], duration: 200, easing: "easeInOutQuad" });
    }

    await playRow(entry, row);
  }

  /** Index of the row to open: the first one already watched, else the first. */
  function initialRowIndex(entry) {
    const rows = setlistFor(entry);
    const watched = rows.findIndex((r) => readPosition(r.id) > 2);
    return watched === -1 ? 0 : watched;
  }

  /**
   * Load one setlist row into the player: merge it into its show, re-theme from
   * whatever art that video has, and update the modal chrome to match.
   */
  async function playRow(entry, row) {
    const playable = playableEntry(entry, row.song);
    renderModalInfo(entry, row.song);
    markCurrentRow(row.id);
    themeFromEntry(playable, { light: state.settings.theme === "light" });
    await player.open(playable, { autoplay: state.settings.autoPlay });
  }

  function closePlayer({ restoreFocus = true } = {}) {
    if (dom.modal.hidden) return;
    player.close();
    dom.modal.dataset.open = "false";
    const finish = () => {
      dom.modal.hidden = true;
      dom.modalBackdrop.style.opacity = "";
      if (restoreFocus) openCard?.focus?.({ preventScroll: true });
    };
    if (window.anime && !reducedMotion()) closeModal(dom.modal, dom.modalBackdrop).finished.then(finish);
    else finish();
  }

  function renderModalInfo(entry, song) {
    // With a song loaded the title is the song and the byline keeps the show it
    // came from, so the headline never loses the concert it belongs to.
    dom.modalTitle.innerHTML = highlight(song ? song.title : entry.song, state.searchQuery);
    dom.modalByline.textContent = song ? `${entry.artist} — ${entry.song}` : entry.artist;

    const songCount = (entry.songs || []).length;
    const songNumber = song ? entry.songs.indexOf(song) + 1 : 0;

    const facts = [
      entry.album && { k: "Album", v: entry.album },
      { k: "Venue", v: entry.venue },
      { k: "Date", v: formatDate(entry.date, entry.datePrecision) },
      entry.location && { k: "Location", v: entry.location },
      songCount && { k: "Song", v: song ? `${songNumber} of ${songCount}` : `${songCount} in setlist` },
      entry.metadata.quality && { k: "Quality", v: entry.metadata.quality },
      entry.metadata.source && { k: "Source", v: entry.metadata.source },
      entry.metadata.audio && { k: "Audio", v: entry.metadata.audio },
      { k: "Length", v: formatDuration(song ? song.video.duration : entry.video.duration) },
    ].filter(Boolean);

    dom.modalFacts.innerHTML = facts
      .map((f) => `<span class="fact"><span class="k">${escapeHtml(f.k)}</span><span class="v">${highlight(f.v, state.searchQuery)}</span></span>`)
      .join("");

    // Positions are stored per playable id, so a song resumes where IT stopped.
    const resume = readPosition(song ? song.id : entry.id);
    if (resume > 2) {
      dom.modalFacts.insertAdjacentHTML(
        "beforeend",
        `<span class="fact"><span class="k">Resume</span><span class="v">${formatDuration(resume)}</span></span>`
      );
    }
  }

  /**
   * The panel under the stage: the show's setlist when it has one, then the
   * next shows in the current view. A show with no setlist is just "Up next".
   */
  function renderQueuePanel(entry, activeId) {
    const songs = entry.songs || [];
    const rows = setlistFor(entry);
    const sections = [];

    if (songs.length) {
      const items = rows
        .map(
          (row) => `<li>
          <button class="setlist-item" type="button" data-row-id="${escapeHtml(row.id)}" aria-current="${row.id === activeId}">
            <span class="sl-num">${row.song ? row.song.number : ""}</span>
            <span class="sl-title">${highlight(row.title, state.searchQuery)}</span>
            <span class="sl-dur">${formatDuration(row.song ? row.song.video.duration : entry.video.duration)}</span>
          </button>
        </li>`
        )
        .join("");

      sections.push(`<section class="setlist">
        <h3>Setlist <span class="sl-count">${songs.length} ${songs.length === 1 ? "song" : "songs"}</span></h3>
        <ol class="setlist-list" data-setlist>${items}</ol>
      </section>`);
    }

    const upNext = upNextEntries(entry);
    if (upNext.length) {
      sections.push(`<h3>Up next</h3><div class="queue-list">${upNext
        .map(
          (e) => `<button class="queue-item" type="button" data-queue-id="${e.id}">
          ${e.albumArt ? artImg(e) : `<span class="queue-placeholder"></span>`}
          <span style="min-width:0">
            <span class="qt">${escapeHtml(e.song)}</span>
            <span class="qa">${escapeHtml(e.artist)}</span>
          </span>
        </button>`
        )
        .join("")}</div>`);
    }

    dom.queue.hidden = sections.length === 0;
    dom.queue.innerHTML = sections.join("");

    for (const btn of dom.queue.querySelectorAll("[data-row-id]")) {
      btn.addEventListener("click", () => {
        const row = rows.find((r) => r.id === btn.dataset.rowId);
        if (row) playRow(entry, row);
      });
    }

    for (const btn of dom.queue.querySelectorAll("[data-queue-id]")) {
      btn.addEventListener("click", () => {
        const next = state.catalog.find((e) => e.id === btn.dataset.queueId);
        if (next) openEntry(next, openCard);
      });
    }
  }

  function upNextEntries(entry) {
    const list = state.filtered.length ? state.filtered : state.catalog;
    const index = list.findIndex((e) => e.id === entry.id);
    return [list[index + 1], list[index + 2], list[index + 3]].filter(Boolean);
  }

  /** Highlight the playing row without re-rendering the panel. */
  function markCurrentRow(id) {
    for (const btn of dom.queue.querySelectorAll("[data-row-id]")) {
      const current = btn.dataset.rowId === id;
      btn.setAttribute("aria-current", String(current));
      if (current) btn.scrollIntoView({ block: "nearest" });
    }
  }

  /* ---------- view switching ---------- */

  function switchView(view) {
    if (view === state.view) return;
    const from = activeViewEl();
    setView(view); // the store subscriber re-renders into the new container
    const to = activeViewEl();
    to.classList.add("active");
    crossFade(from, to);
  }

  /* ---------- keyboard ---------- */

  function moveFocus(delta) {
    const container = activeViewEl();
    const items = [...container.querySelectorAll("[data-entry]")];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = index === -1 ? (delta > 0 ? 0 : items.length - 1) : clampIndex(index + delta, items.length);
    items[next]?.focus({ preventScroll: false });
    items[next]?.scrollIntoView({ block: "nearest" });
  }

  function focusEdge(which) {
    const items = [...activeViewEl().querySelectorAll("[data-entry]")];
    if (!items.length) return;
    (which === "first" ? items[0] : items[items.length - 1]).focus();
  }

  const clampIndex = (i, len) => Math.min(len - 1, Math.max(0, i));

  function columns() {
    if (state.view === "list") return 1;
    if (state.view === "timeline") return 1;
    const first = activeViewEl().querySelector("[data-entry]");
    if (!first) return 1;
    const style = getComputedStyle(first.parentElement);
    return Math.max(1, (style.gridTemplateColumns || "").split(" ").filter(Boolean).length);
  }

  document.addEventListener("keydown", (e) => {
    // Modal has its own bindings (player.js); only Escape is shared.
    if (dom.modal.dataset.open === "true") {
      if (e.key === "Escape") {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
        else closePlayer();
      }
      return;
    }

    if (!dom.shortcuts.hidden && e.key === "Escape") {
      e.preventDefault();
      toggleShortcuts(false);
      return;
    }

    if (isTypingTarget(e.target)) {
      if (e.key === "Escape") {
        e.target.blur();
        if (state.searchQuery) {
          dom.search.value = "";
          setSearchQuery("");
        }
      }
      if (e.key === "Enter" && e.target === dom.search) {
        e.preventDefault();
        const first = activeViewEl().querySelector("[data-entry]");
        if (first) first.focus();
      }
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const cols = columns();
    switch (e.key) {
      case "/":
        e.preventDefault();
        dom.search.focus();
        dom.search.select();
        break;
      case "g":
        e.preventDefault();
        switchView(state.view === "grid" ? "list" : "grid");
        break;
      case "t":
        e.preventDefault();
        switchView(state.view === "timeline" ? "grid" : "timeline");
        break;
      case "a":
        e.preventDefault();
        switchView(state.view === "artist" ? "grid" : "artist");
        break;
      case "l":
        e.preventDefault();
        switchView(state.view === "list" ? "grid" : "list");
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(cols);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-cols);
        break;
      case "Home":
        e.preventDefault();
        focusEdge("first");
        break;
      case "End":
        e.preventDefault();
        focusEdge("last");
        break;
      case "?":
        e.preventDefault();
        toggleShortcuts();
        break;
      case "Escape":
        if (state.searchQuery) {
          dom.search.value = "";
          setSearchQuery("");
        } else {
          clearFilters();
        }
        break;
      case "s":
        e.preventDefault();
        setSetting("sidebarOpen", !state.settings.sidebarOpen);
        break;
      default:
        break;
    }
  });

  function toggleShortcuts(force) {
    const show = force === undefined ? dom.shortcuts.hidden : force;
    if (show) {
      dom.shortcuts.hidden = false;
      popIn(dom.shortcutsPanel);
    } else {
      popOut(dom.shortcutsPanel, () => {
        dom.shortcuts.hidden = true;
      });
    }
  }

  /* ---------- event wiring ---------- */

  const onSearch = debounce((value) => {
    setSearchQuery(value);
  }, 180);

  dom.search.addEventListener("input", (e) => onSearch(e.target.value));
  dom.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      dom.search.value = "";
      setSearchQuery("");
    }
  });

  for (const btn of dom.viewButtons) {
    btn.addEventListener("click", () => switchView(btn.dataset.setView));
  }

  dom.sortField.innerHTML = SORT_FIELDS.map(
    (f) => `<option value="${f.field}">${f.label}</option>`
  ).join("");
  dom.sortField.value = state.sort.field;
  dom.sortField.addEventListener("change", (e) => setSort(e.target.value, state.sort.dir));
  dom.sortDir.addEventListener("click", () => {
    setSort(state.sort.field, state.sort.dir === "desc" ? "asc" : "desc");
    pulse(dom.sortDir.parentElement);
  });

  for (const headBtn of dom.listHead.querySelectorAll("[data-sort]")) {
    headBtn.addEventListener("click", () => {
      const field = headBtn.dataset.sort;
      const dir = state.sort.field === field && state.sort.dir === "asc" ? "desc" : "asc";
      setSort(field, dir);
    });
  }

  dom.sidebarToggle.addEventListener("click", () => setSetting("sidebarOpen", !state.settings.sidebarOpen));

  // Filter interactions are delegated: the sidebar is re-rendered on every
  // change, so per-node listeners would be thrown away each time.
  dom.filters.addEventListener("change", (e) => {
    const input = e.target;
    const key = input.dataset.filterKey;
    if (!key) return;
    if (input.type === "checkbox") toggleFilter(key, input.value);
    else setFilter(key, input.value);
  });

  dom.chips.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-chip-key]");
    if (remove) {
      const { chipKey, chipValue } = remove.dataset;
      if (chipKey === "search") {
        dom.search.value = "";
        setSearchQuery("");
        return;
      }
      const current = state.filters[chipKey] || [];
      if (Array.isArray(current)) setFilter(chipKey, current.filter((v) => v !== chipValue));
      else setFilter(chipKey, "");
      return;
    }
    if (e.target.closest('[data-action="clear-all"]')) {
      dom.search.value = "";
      clearFilters();
    }
  });

  // "Reset filters" buttons inside the empty state
  document.addEventListener("click", (e) => {
    if (!e.target.closest('[data-action="clear-all"]')) return;
    if (dom.chips.contains(e.target) || dom.filters.contains(e.target)) return;
    dom.search.value = "";
    clearFilters();
  });

  dom.modalClose.addEventListener("click", () => closePlayer());
  dom.modalBackdrop.addEventListener("click", () => closePlayer());

  dom.showShortcuts.addEventListener("click", () => toggleShortcuts(true));
  dom.shortcuts.addEventListener("click", (e) => {
    if (e.target === dom.shortcuts || e.target.closest("[data-close-shortcuts]")) {
      toggleShortcuts(false);
    }
  });

  dom.settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.settings.hidden = !dom.settings.hidden;
    if (!dom.settings.hidden) popIn(dom.settings);
  });
  document.addEventListener("click", (e) => {
    if (dom.settings.hidden) return;
    if (dom.settings.contains(e.target) || dom.settingsBtn.contains(e.target)) return;
    dom.settings.hidden = true;
  });

  dom.reducedToggle.checked = reducedMotion();
  dom.reducedToggle.addEventListener("change", (e) => {
    setReducedMotion(e.target.checked);
    setSetting("reducedMotion", e.target.checked);
  });

  dom.autoplayToggle.checked = Boolean(state.settings.autoPlay);
  dom.autoplayToggle.addEventListener("change", (e) => setSetting("autoPlay", e.target.checked));

  dom.themeSelect.value = state.settings.theme;
  dom.themeSelect.addEventListener("change", (e) => {
    setSetting("theme", e.target.value);
    const current = state.currentVideo;
    if (current) themeFromEntry(current, { light: e.target.value === "light" });
    else resetTheme({ light: e.target.value === "light" });
  });

  /* ---------- store subscription ---------- */

  subscribe((s, event) => {
    switch (event) {
      case "catalog":
        render({ animate: true });
        break;
      case "filters":
      case "search":
      case "sort":
        render({ animate: event !== "sort" });
        if (event === "search") morphResults(activeViewEl());
        break;
      case "view":
        render({ animate: false });
        break;
      case "setting":
        syncControls();
        if (s.settings.reducedMotion !== undefined && s.settings.reducedMotion !== null) {
          setReducedMotion(s.settings.reducedMotion);
          dom.reducedToggle.checked = reducedMotion();
        }
        break;
      case "status":
        if (s.status === "error") showFatal(s.error);
        break;
      default:
        break;
    }
  });

  function showFatal(error) {
    dom.grid.innerHTML = `<div class="state">
      <span class="state-icon">⚠</span>
      <h3>The catalog could not be loaded</h3>
      <p>${escapeHtml(error?.message || String(error))}</p>
      <p>Expected a JSON array at <code>data/catalog.json</code>. Serving the folder over HTTP is required —
      opening <code>index.html</code> from the filesystem will block <code>fetch()</code>.</p>
      <button class="btn btn-primary" type="button" onclick="location.reload()">Retry</button>
    </div>`;
    toast("Catalog failed to load", "error", 6000);
  }

  /* ---------- start ---------- */

  async function start() {
    syncControls();
    try {
      const { entries, problems, skipped = 0, sync } = await loadCatalog();
      if (problems.length) {
        console.warn("[catalog] data notes", problems);
        // Most of these are shows missing a date or venue, which still render —
        // calling them skipped entries would be wrong and alarming.
        toast(
          skipped
            ? `Skipped ${skipped} invalid ${skipped === 1 ? "entry" : "entries"}`
            : `${problems.length} show${problems.length === 1 ? " needs" : "s need"} a date, venue or location`,
          "warn",
          5000
        );
      }
      if (sync?.missingArt?.length) {
        const sample = sync.missingArt
          .slice(0, 3)
          .map((m) => `${m.artist} — ${m.song}`)
          .join("; ");
        toast(
          `${sync.missingArt.length} ${sync.missingArt.length === 1 ? "clip has" : "clips have"} no album art: ${sample}${sync.missingArt.length > 3 ? "…" : ""}`,
          "info",
          8000
        );
      }
      render({ animate: true });
      announce(`Catalog loaded: ${entries.length} entries`);
      attachEditableListeners();
    } catch (err) {
      console.error("[catalog] load failed", err);
      showFatal(err);
    }
  }

  start();
  return { render, switchView, closePlayer, toast, openEntry, player, dom };
}
