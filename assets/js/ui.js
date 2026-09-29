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
  setFacets,
  toggleFilter,
  clearFilters,
  setSetting,
  readPosition,
  setArtistGroupOpen,
  getArtistGroupOpen,
} from "./store.js";
import { loadCatalog, buildFacets, formatDate, formatDuration, playableEntry, setlistFor } from "./catalog.js";
import { queryCatalog, highlight, escapeHtml, activeFilterSummary, SORT_FIELDS } from "./search.js";
import { toGroups, groupRowsFor } from "./grouping.js";
import { createPlayer, isTypingTarget } from "./player.js?v=2026-09-29-a11y-focus-v5";
import { themeFromEntry, resetTheme } from "./theme.js";
import { editState, recordChange, saveCatalog } from "./edit.js";
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
  type: "Type",
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
      scrim: q("[data-sidebar-scrim]"),
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
      "sidebar", "scrim", "filters", "chips", "search", "resultCount",
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

    // Facet counts are context-dependent, so they are recounted on every render
    // rather than once per catalog load — otherwise the sidebar keeps promising
    // results the current search and filters cannot deliver.
    setFacets(buildFacets(state.catalog, { filters: state.filters, searchQuery: state.searchQuery }));

    // One step between the query pipeline and the renderers. Everything above
    // still ran per entry — search, filters, sorting and the facet counts — so
    // matching any clip surfaces its group and the relevance order is intact.
    const groups = toGroups(entries);

    const container = activeViewEl();
    const previous = animate ? snapshotRects(container) : null;

    clearView(container);

    let nodes = [];
    if (groups.length) {
      nodes = renderEntries(groups, container);
    } else {
      const target = container === dom.list ? listBody() : container;
      target.innerHTML = emptyStateMarkup();
    }
    // The store holds what is on screen, so up-next and the roving focus walk
    // group by group rather than stopping on a clip that is not rendered.
    setFiltered(groups);

    renderChips();
    syncControls();
    // The counter reports what the user can see, which is groups.
    updateCounts(groups.length, animate);
    announce(`${groups.length} ${groups.length === 1 ? "result" : "results"}`);

    if (!animate || !groups.length) return;

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
    // A native button gives the card its accessible name from the visible text
    // and Enter/Space activation for free. Children are phrasing content
    // because a button may not contain flow or interactive content.
    const node = el("button", "video-card");
    node.type = "button";
    node.dataset.id = entry.id;
    node.dataset.entry = entry.id;

    const duration = entry.video.duration;
    const songCount = (entry.songs || []).length;
    const clipCount = entry.clipCount || 0;
    // A group has no single runtime, so the badge counts clips and the summed
    // runtime lives on the title attribute rather than being thrown away. The
    // attribute is omitted entirely for anything else, so no card grows a blank
    // tooltip the browser would still surface as an empty hover target.
    const length = clipCount > 1
      ? `${clipCount} clips`
      : songCount ? `${songCount} songs` : duration ? formatDuration(duration) : "--:--";
    const lengthTitle = clipCount > 1
      ? ` title="${escapeHtml(`${clipCount} clips · ${formatDuration(sumDurations(entry.clips))} total`)}"`
      : "";

    node.innerHTML = `
      <span class="card-art" data-missing="${!entry.albumArt}" data-fallback="${escapeHtml(initials(entry.artist))}">
        ${entry.albumArt ? artImg(entry) : ""}
        <span class="card-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        <span class="card-duration" data-songs="${songCount}" data-clips="${clipCount}"${lengthTitle}>${length}</span>
      </span>
      <span class="card-body">
        <span class="card-song">${editableTitle(entry)}</span>
        <span class="card-artist">${highlight(entry.artist, state.searchQuery)}</span>
        <span class="card-meta">
          <span>${escapeHtml(formatDate(entry.date, entry.datePrecision))}</span>
          <span class="dot"></span>
          <span>${highlight(entry.venue, state.searchQuery)}</span>
        </span>
        ${tagBadges(entry)}
      </span>
      ${cardProgress(entry)}
    `;

    attachOpen(node, entry);
    container.appendChild(node);
    return node;
  }

  /**
   * The progress bar under a card.
   *
   * A group has no single runtime, so the bar is the ratio of watched seconds to
   * total seconds across its clips: partially-watched multi-clip groups show a
   * truthful bar instead of the representative clip's own fraction.
   */
  function cardProgress(entry) {
    const clips = entry.clipCount > 1 ? entry.clips : [entry];
    let watched = 0;
    let total = 0;
    for (const clip of clips) {
      watched += readPosition(clip.id);
      total += clip.video?.duration || 0;
    }
    return watched && total ? `<span class="card-progress" style="transform:scaleX(${Math.min(1, watched / total)})"></span>` : "";
  }

  function sumDurations(clips) {
    return (clips || []).reduce((acc, c) => acc + (c.video?.duration || 0), acc);
  }

  /** The right-hand column of a list row: a clip count, a song count, or a duration. */
  function lengthCell(entry) {
    const clips = entry.clipCount || 0;
    if (clips > 1) return `<span class="badge" data-clips="${clips}">${clips} clips</span>`;
    const count = (entry.songs || []).length;
    if (count) return `<span class="badge" data-songs="${count}">${count} songs</span>`;
    return entry.video.duration ? formatDuration(entry.video.duration) : "--:--";
  }

  /** Timeline rows stay narrow, so a setlist or a clip group collapses to a count. */
  function timelineBadge(entry) {
    const clips = entry.clipCount || 0;
    if (clips > 1) return `${clips} clips`;
    const count = (entry.songs || []).length;
    if (count) return `${count} songs`;
    return escapeHtml(entry.metadata.quality || entry.video.type);
  }

  /* ---- list row ---- */

  function renderRow(entry, container) {
    // Native button for the same reason as the card: the accessible name comes
    // from the visible columns, so no aria-label can drift out of sync with them.
    const node = el("button", "row");
    node.type = "button";
    node.dataset.id = entry.id;
    node.dataset.entry = entry.id;

    node.innerHTML = `
      <span class="thumb">${entry.albumArt ? artImg(entry) : ""}</span>
      <span class="primary">
        <span class="title">${editableTitle(entry)}</span>
        <span class="sub">${highlight(entry.artist, state.searchQuery)}</span>
      </span>
      <span class="venue col-optional">${highlight(entry.venue, state.searchQuery)}</span>
      <span class="date">${escapeHtml(formatDate(entry.date, entry.datePrecision))}</span>
      <span class="album">${entry.album ? `<span title="${escapeHtml(entry.album)}">${highlight(entry.album, state.searchQuery)}</span>` : ""}</span>
      <span class="quality col-optional">${entry.metadata.quality ? qualityBadge(entry) : `<span class="badge">${escapeHtml(entry.video.type)}</span>`}</span>
      <span class="col-optional">${locationCell(entry)}</span>
      <span class="num">${lengthCell(entry)}</span>
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

      section.dataset.open = String(getArtistGroupOpen(artist));
      section.innerHTML = `
        <button class="artist-head" type="button" aria-expanded="${getArtistGroupOpen(artist)}">
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
        const nextOpen = !open;
        section.dataset.open = String(nextOpen);
        section.querySelector(".artist-head").setAttribute("aria-expanded", String(nextOpen));
        setArtistGroupOpen(artist, nextOpen);
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
        <span class="badge" data-songs="${(entry.songs || []).length}" data-clips="${entry.clipCount || 0}">${timelineBadge(entry)}</span>
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

      // A group is a synthetic entry: its id is not in state.catalog, and its
      // title is promoted from one clip. Writing a single clip would rename that
      // clip only and the group would fall apart on the next render, so a group
      // title is written to every clip in the group.
      const group = state.filtered.find((item) => item.id === entryId);
      if (group?.isGroup) {
        let changed = 0;
        for (const clip of group.clips) {
          if ((clip[field] || "") === value) continue;
          clip[field] = value;
          recordChange(clip.id, field, value);
          changed += 1;
        }
        if (changed) {
          // The clips were mutated in place, so render() rebuilds the groups from
          // them and the card reflects the new title without a second write.
          const row = currentRowId();
          render({ animate: false });
          // The queue panel is not part of that render, so a group that is open
          // would still list the old title on every row. openGroup held the
          // pre-render object, so it is re-resolved from the fresh list first.
          const fresh = openGroup && state.filtered.find((e) => e.id === openGroup.id);
          if (fresh) renderQueuePanel((openGroup = fresh), row);
        }
        return;
      }

      const entry = state.catalog.find((e) => e.id === entryId);
      if (!entry) return;
      const old = entry[field] || "";
      if (value !== old) {
        entry[field] = value;
        recordChange(entryId, field, value);
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
    // A span, not a div: the badge row sits inside the card's <button>, which
    // may only contain phrasing content.
    return badges.length ? `<span class="card-tags">${badges.join("")}</span>` : "";
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

  /** True when the sidebar is an overlay drawer rather than an in-flow panel. */
  function isDrawerOverlay() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  /* ---------- filter sidebar ---------- */

  function renderFilters() {
    const groups = Object.entries(state.facets)
      .filter(([key, values]) => values.length)
      .map(([key, values]) => {
        const selected = state.filters[key] || [];
        const options = values
          .map(({ value, count }) => {
            const isSelected = selected.includes(value);
            // A count of zero means ticking this returns nothing, so the option
            // is marked unavailable rather than left to fail silently. A ticked
            // value is never marked: the context that zeroed it is the user's own
            // doing, and unticking it is the only way back.
            //
            // aria-disabled, not the disabled attribute: a disabled checkbox
            // leaves the tab order entirely, so a keyboard user could no longer
            // reach an option to discover that it is unavailable. The change
            // handler refuses the toggle instead — the control stays focusable
            // and announced as dimmed.
            const unavailable = count === 0 && !isSelected;
            return `
        <label class="filter-option" data-unavailable="${unavailable}">
          <input type="checkbox" data-filter-key="${key}" value="${escapeHtml(value)}" ${isSelected ? "checked" : ""}${unavailable ? ' aria-disabled="true"' : ""}>
          <span class="filter-box"></span>
          <span class="filter-label">${highlight(value, state.searchQuery)}</span>
          <span class="filter-n">${count}</span>
        </label>`;
          })
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

    /*
     * The sidebar is rebuilt wholesale because the facet counts depend on the
     * live query — the right call for the counts, but it also throws away the
     * scroll position and drops focus to the document. So a user part-way down
     * the facets who types a search gets yanked back to the top mid-interaction,
     * and a keyboard user loses the checkbox they were on. Capture both across
     * the swap and put them back.
     */
    const active = document.activeElement;
    const refocus =
      active && dom.filters.contains(active) && active.dataset?.filterKey
        ? { key: active.dataset.filterKey, value: active.type === "checkbox" ? active.value : null }
        : null;
    const scrollTop = dom.filters.scrollTop;

    dom.filters.innerHTML = dateGroup + groups;

    dom.filters.scrollTop = scrollTop;
    if (refocus) {
      // Checkboxes are only unique by key *and* value — there are dozens per
      // group. The two date inputs are unique by key alone.
      const selector =
        refocus.value === null
          ? `[data-filter-key="${refocus.key}"]`
          : `[data-filter-key="${refocus.key}"][value="${CSS.escape(refocus.value)}"]`;
      dom.filters.querySelector(selector)?.focus({ preventScroll: true });
    }
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
    // CSS keeps the scrim display:none on desktop, so the attribute is the only
    // state sync needed here.
    dom.scrim.hidden = !state.settings.sidebarOpen;
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
  let shortcutsPreviousFocus = null;
  /* The clip group currently open, if any. The player is always handed a real
   * clip, never the synthetic group, so the group is kept here for the modal
   * facts and the queue panel's clip list and reorder controls. */
  let openGroup = null;
  /* Reorder mode is a panel-local toggle, not a preference: it is a way of
   * interacting with the clips that are on screen right now. */
  let reorderClips = false;

  async function openEntry(entry, sourceNode) {
    openCard = sourceNode;
    openGroup = entry.isGroup ? entry : null;
    reorderClips = false;

    // A show with a setlist opens on the video you last watched, so reopening a
    // concert picks up where you left off instead of restarting the bill.
    const row = rowsFor(entry)[initialRowIndex(entry)];

    // A group opens on a real clip, never on the synthetic group: everything the
    // player does then runs against an entry that is in state.catalog, so the
    // group id never has to survive into a resume position or a theme lookup. The
    // clip is resolved from the row, so it is the one the user last watched and
    // not merely the first in order.
    const show = entry.isGroup ? entry.clips.find((c) => c.id === row.id) || entry.clips[0] : entry;

    renderModalInfo(show, row.song);
    renderQueuePanel(entry, row.id);

    dom.modal.hidden = false;
    dom.modal.dataset.open = "true";
    document.body.style.overflow = "hidden";
    sharedElement(sourceNode, dom.modal, dom.modalBackdrop);
    dom.modalClose.focus({ preventScroll: true });
    if (window.anime && !reducedMotion()) {
      window.anime({ targets: dom.modalBackdrop, opacity: [0, 1], duration: 200, easing: "easeInOutQuad" });
    }

    await playRow(show, row);
  }

  /**
   * The playable rows of whatever is open.
   *
   * A clip group is not a setlist, so its rows come from grouping.js in the
   * user's clip order; everything else keeps the show's own setlist. The rows
   * share a shape with setlistFor, so the player, the resume positions, the
   * chapter rail and the "Song n of m" facts need no change.
   */
  function rowsFor(entry) {
    return entry.isGroup ? groupRowsFor(entry) : setlistFor(entry);
  }

  /** Index of the row to open: the first one already watched, else the first. */
  function initialRowIndex(entry) {
    const rows = rowsFor(entry);
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
      // Player is closing: drop the entry's art-derived palette and restore the
      // neutral base theme in the persisted light/dark variant. Settings promises
      // the accent "always" comes from the open video's art, so with nothing open
      // the page must go back to the base palette. This runs after the close
      // animation so the morph blends from the last frame.
      resetTheme({ light: state.settings.theme === "light" });
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

    // A clip group is not a setlist, so its position reads as a clip count. The
    // group is not the entry the player was handed (that is clips[0]), so the
    // open group is tracked separately.
    const group = openGroup;
    const clipNumber = group && song ? group.clips.findIndex((c) => c.id === song.id) + 1 : 0;

    const facts = [
      entry.album && { k: "Album", v: entry.album },
      { k: "Venue", v: entry.venue },
      { k: "Date", v: formatDate(entry.date, entry.datePrecision) },
      entry.location && { k: "Location", v: entry.location },
      songCount && { k: "Song", v: song ? `${songNumber} of ${songCount}` : `${songCount} in setlist` },
      clipNumber && { k: "Clip", v: `${clipNumber} of ${group.clipCount}` },
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
   * The panel under the stage: the clip list for a group, the setlist for a show
   * with one, then the next shows in the current view. A single video is just
   * "Up next".
   */
  function renderQueuePanel(entry, activeId) {
    const songs = entry.songs || [];
    const rows = rowsFor(entry);
    const sections = [];

    if (entry.isGroup) {
      sections.push(clipGroupSection(entry, rows, activeId));
    } else if (songs.length) {
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
        if (!row) return;
        // A group's rows are its clips, so the clicked row names the clip to play
        // — the row the user pressed, not whichever one happens to sort first.
        // playableEntry takes the id, video and chapters from row.song, so this
        // resolves the same entry either way; naming the actual clip keeps the
        // modal facts and the theme pointed at what is on screen.
        const clip = entry.isGroup ? entry.clips.find((c) => c.id === row.id) : null;
        playRow(clip || entry, row);
      });
    }

    // Reorder controls are re-wired after every rebuild of the section, so they
    // are attached by one helper rather than twice here.
    wireClipGroupControls(entry, rows, activeId);

    for (const btn of dom.queue.querySelectorAll("[data-queue-id]")) {
      btn.addEventListener("click", () => {
        // The list on screen holds groups, so the target is looked up there
        // first; a group id is not in state.catalog.
        const next = state.filtered.find((e) => e.id === btn.dataset.queueId)
          || state.catalog.find((e) => e.id === btn.dataset.queueId);
        if (next) openEntry(next, openCard);
      });
    }
  }

  /**
   * The clips branch of the queue panel.
   *
   * Reordering lives here and not on the card because a card is a <button> and
   * may not contain interactive children. ↑/↓ buttons are the primary mechanism
   * rather than drag-and-drop: they are keyboard accessible, they work on touch
   * and they need no dependency.
   */
  function clipGroupSection(entry, rows, activeId) {
    const total = entry.clipCount;
    const items = rows
      .map((row, i) => {
        const clip = entry.clips[i];
        const position = i + 1;
        const moves = reorderClips
          ? `<span class="clip-moves">
              <button type="button" class="clip-move" data-clip-move="-1" data-clip-index="${i}" aria-label="Move clip ${position} earlier"${i === 0 ? " disabled" : ""}>↑</button>
              <button type="button" class="clip-move" data-clip-move="1" data-clip-index="${i}" aria-label="Move clip ${position} later"${i === total - 1 ? " disabled" : ""}>↓</button>
            </span>`
          : "";
        return `<li class="clip-row" data-reorderable="${reorderClips}">
          <button class="setlist-item" type="button" data-row-id="${escapeHtml(row.id)}" aria-current="${row.id === activeId}">
            <span class="sl-num">${position}</span>
            <span class="sl-title">${highlight(row.title, state.searchQuery)}</span>
            <span class="sl-dur">${formatDuration(clip.video?.duration)}</span>
          </button>
          ${moves}
        </li>`;
      })
      .join("");

    return `<section class="setlist" data-clip-group>
      <h3>Clips <span class="sl-count">${total} ${total === 1 ? "clip" : "clips"}</span>
        <button type="button" class="clip-reorder-toggle" data-reorder-clips aria-pressed="${reorderClips}">${reorderClips ? "Done" : "Reorder clips"}</button>
      </h3>
      <ol class="setlist-list" data-clips>${items}</ol>
    </section>`;
  }

  /**
   * The clips section as a node.
   *
   * replaceWith() takes nodes, not markup — handing it a string inserts a text
   * node, which would silently empty the panel. The template is also how the
   * section gets its ids, so this is the only place the markup is parsed.
   */
  function clipGroupNode(group, rows, activeId) {
    const template = document.createElement("template");
    template.innerHTML = clipGroupSection(group, rows, activeId).trim();
    return template.content.firstElementChild;
  }

  /** Rebuild the clips section in place, from the current order. */
  function refreshClipGroup(group, rows, activeId) {
    const section = dom.queue.querySelector("[data-clip-group]");
    section?.replaceWith(clipGroupNode(group, rows, activeId));
    wireClipGroupControls(group, rows, activeId);
  }

  function wireClipGroupControls(group, rows, activeId) {
    for (const btn of dom.queue.querySelectorAll("[data-reorder-clips]")) {
      btn.addEventListener("click", () => {
        // Toggle, then rebuild the section: mutating the rows in place would
        // leave the next renderModalInfo disagreeing with what is on screen.
        reorderClips = !reorderClips;
        refreshClipGroup(group, rows, activeId);
      });
    }
    for (const btn of dom.queue.querySelectorAll("[data-clip-move]")) {
      btn.addEventListener("click", () => moveClip(group, Number(btn.dataset.clipIndex), Number(btn.dataset.clipMove)));
    }
  }

  /**
   * Move a clip one place up or down and persist the new order.
   *
   * Swapping the two entries' clipIndex values is the whole change: it is the
   * only field a reorder moves, and swapping rather than renumbering means two
   * users reordering concurrently converge instead of clobbering each other's
   * numbering. The panel is rebuilt from the new order rather than moved in
   * place, so what is on screen always matches what will be written.
   *
   * This is a normal user action, not an edit-mode one, so it works (and saves)
   * whether or not titles are being edited.
   */
  async function moveClip(group, from, delta) {
    const to = from + delta;
    if (to < 0 || to >= group.clips.length) return;
    const a = group.clips[from];
    const b = group.clips[to];
    if (!a || !b) return;

    const aIndex = a.clipIndex;
    const bIndex = b.clipIndex;
    a.clipIndex = bIndex;
    b.clipIndex = aIndex;
    recordChange(a.id, "clipIndex", bIndex);
    recordChange(b.id, "clipIndex", aIndex);
    swapClips(group, from, to);

    const saved = await saveClipOrder(group);
    if (saved) return;

    // The write did not land, so the swap is rolled back rather than left on
    // screen. A panel showing an order the server rejected is the exact failure
    // this feature exists to prevent, and a user who then saves their titles
    // would write the reverted order back as if it were theirs.
    a.clipIndex = aIndex;
    b.clipIndex = bIndex;
    swapClips(group, from, to);
    // The patch still holds the rejected values, so it is corrected too — a
    // later save must not resurrect an order that was never persisted.
    recordChange(a.id, "clipIndex", aIndex);
    recordChange(b.id, "clipIndex", bIndex);
    refreshClipGroup(group, rowsFor(group), currentRowId());
  }

  /** Swap two positions in a group's clip list. */
  function swapClips(group, from, to) {
    const next = [...group.clips];
    [next[from], next[to]] = [next[to], next[from]];
    group.clips = next;
  }

  /** The clip the panel is currently highlighting. */
  function currentRowId() {
    return dom.queue.querySelector("[data-row-id][aria-current='true']")?.dataset.rowId || "";
  }

  /**
   * Push the pending reorder to /api/catalog and re-seed from the response.
   *
   * The re-seed matters: a panel that looks reordered but is not on disk is the
   * exact failure this feature exists to prevent, so the order on screen is only
   * kept when the write landed. saveCatalog runs behind the shared write lock and
   * re-seeds from the catalog the response carries, so what is left in state is
   * the file as it now stands.
   *
   * Resolves true when the order is on disk.
   */
  async function saveClipOrder(group) {
    // allowDownload: false — a press of an arrow key must not hand the user a
    // whole catalog.json to drop over the real one.
    try {
      const saved = await saveCatalog({ allowDownload: false });
      if (!saved) return false;
      // The re-seed replaced every entry with a new object, so the group this
      // panel is describing is stale. It is re-resolved from the freshly rendered
      // list, or the panel would keep showing an order that no longer matches the
      // entries behind it.
      if (group) {
        const fresh = state.filtered.find((e) => e.id === group.id);
        if (fresh) {
          openGroup = fresh;
          renderQueuePanel(fresh, currentRowId());
        }
      }
      return true;
    } catch (err) {
      toast(`Clip order could not be saved: ${err.message}`, "error", 6000);
      return false;
    }
  }

  /**
   * The next three things in the current view.
   *
   * The list holds groups, so the position of what is open is found by group id.
   * The player is handed a real clip rather than the group, so the clip id is
   * matched too — without that a group opened from a row click would land on
   * index -1 and offer whatever happened to be first in the view.
   */
  function upNextEntries(entry) {
    const list = state.filtered.length ? state.filtered : state.catalog;
    const index = list.findIndex((e) => e.id === entry.id || e.clips?.some((c) => c.id === entry.id));
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

    // Shortcuts panel is open — suppress all single-letter app shortcuts
    // (G, L, A, T, S, /, ?) but allow Escape to close it and Tab to move within.
    if (!dom.shortcuts.hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleShortcuts(false);
      }
      // Allow Tab for focus movement within the panel, block everything else
      if (e.key !== "Tab") return;
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
        // Escape is a dismissal key, so it unwinds one layer at a time: the
        // player, the shortcut panel, the mobile drawer, then the search text.
        //
        // It deliberately does NOT reset every filter. Above the drawer
        // breakpoint there is no overlay for the first press to absorb, so a
        // stray Escape wiped the whole filter set with no undo — the one
        // irreversible thing this app's keyboard can do. The sidebar's "Clear
        // all" chip is the explicit way to do that, and it is reversible by
        // re-ticking. This also makes desktop and mobile agree: on both, the
        // first Escape closes the sidebar and only the next one touches state.
        if (state.settings.sidebarOpen && isDrawerOverlay()) {
          e.preventDefault();
          setSetting("sidebarOpen", false);
          break;
        }
        if (state.searchQuery) {
          e.preventDefault();
          dom.search.value = "";
          setSearchQuery("");
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
      shortcutsPreviousFocus = document.activeElement;
      dom.shortcuts.hidden = false;
      popIn(dom.shortcutsPanel);
      // Move focus into the panel - focus the close button
      const closeBtn = dom.shortcutsPanel.querySelector("[data-close-shortcuts]");
      closeBtn?.focus({ preventScroll: true });
    } else {
      popOut(dom.shortcutsPanel, () => {
        dom.shortcuts.hidden = true;
        // Restore focus to what had it before (the Keys button or wherever)
        shortcutsPreviousFocus?.focus?.({ preventScroll: true });
        shortcutsPreviousFocus = null;
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

  // On small screens the drawer is an overlay, so tapping the content behind it
  // has to be a dismiss rather than a click on the grid.
  dom.scrim.addEventListener("click", () => setSetting("sidebarOpen", false));

  // Filter interactions are delegated: the sidebar is re-rendered on every
  // change, so per-node listeners would be thrown away each time.
  dom.filters.addEventListener("change", (e) => {
    const input = e.target;
    const key = input.dataset.filterKey;
    if (!key) return;
    // An option with no matches in the current context is aria-disabled rather
    // than disabled, so it stays reachable by keyboard. Undo the tick here
    // instead: the browser has already flipped the box by the time this fires.
    if (input.type === "checkbox") {
      if (input.getAttribute("aria-disabled") === "true") {
        input.checked = false;
        return;
      }
      toggleFilter(key, input.value);
    } else setFilter(key, input.value);
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
    const isHidden = dom.settings.hidden;
    dom.settings.hidden = !isHidden;
    dom.settingsBtn.setAttribute("aria-expanded", String(!isHidden));
    if (!dom.settings.hidden) popIn(dom.settings);
  });
  document.addEventListener("click", (e) => {
    if (dom.settings.hidden) return;
    if (dom.settings.contains(e.target) || dom.settingsBtn.contains(e.target)) return;
    dom.settings.hidden = true;
    dom.settingsBtn.setAttribute("aria-expanded", "false");
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
    // Below the drawer breakpoint a restored `sidebarOpen: true` would cover the
    // grid on first paint. Mutating in memory (not setSetting) keeps the stored
    // preference intact for desktop, and any later toggle this session sticks.
    if (isDrawerOverlay()) state.settings.sidebarOpen = false;
    syncControls();
    // The catch is scoped to the catalog fetch and nothing else. render() used to
    // sit inside it, so a render-time fault was reported as "the catalog could
    // not be loaded" and told the user to check a perfectly good
    // data/catalog.json — with a Retry button that reloaded into the same fault.
    // Keeping the block narrow keeps showFatal's diagnosis honest.
    let loaded;
    try {
      loaded = await loadCatalog();
    } catch (err) {
      console.error("[catalog] load failed", err);
      showFatal(err);
      return;
    }

    const { entries, problems, skipped = 0, sync } = loaded;
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
  }

  start();
  return { render, switchView, closePlayer, toast, openEntry, player, dom };
}
