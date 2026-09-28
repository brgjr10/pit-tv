/*
 * player.js — the custom video player.
 *
 * Owns the <video> element, the control bar, the chapter rail and all source
 * resolution (local files, YouTube/Vimeo embeds, HLS via hls.js, native HLS on
 * Safari, direct MP4/WebM). Playback positions are written back to the store on
 * a timer and flushed on close so a refresh resumes where the user left off.
 */

import { readPosition, savePosition, setCurrentVideo } from "./store.js";
import { formatDuration } from "./catalog.js";

/* ---------- source resolution ---------- */

const YT_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|m\.youtube\.com)$/i;
const VIMEO_HOSTS = /(?:^|\.)vimeo\.com$/i;

function hostOf(url) {
  try {
    return new URL(url, window.location.href).hostname;
  } catch {
    return "";
  }
}

export function isYouTube(url) {
  return YT_HOSTS.test(hostOf(url));
}

export function isVimeo(url) {
  return VIMEO_HOSTS.test(hostOf(url));
}

export function isHls(url) {
  return /\.m3u8(\?|#|$)/i.test(url);
}

export function isDash(url) {
  return /\.mpd(\?|#|$)/i.test(url);
}

function youTubeId(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(embed|shorts|live)\/([^/?#]+)/);
    if (m) return m[2];
    return null;
  } catch {
    return null;
  }
}

function vimeoId(url) {
  const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Resolve a catalog entry's video into something playable.
 * @returns {{kind: string, src: string, embedUrl?: string, native?: boolean}}
 */
export function resolveSource(entry) {
  const { video } = entry;
  const src = video.src;

  if (video.type === "local") return { kind: "file", src };

  if (isYouTube(src)) {
    const id = youTubeId(src);
    if (id) {
      return {
        kind: "embed",
        provider: "youtube",
        src,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1&start=${Math.floor(readPosition(entry.id))}`,
      };
    }
  }

  if (isVimeo(src)) {
    const id = vimeoId(src);
    if (id) {
      return {
        kind: "embed",
        provider: "vimeo",
        src,
        embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1#t=${Math.floor(readPosition(entry.id))}s`,
      };
    }
  }

  if (isHls(src)) {
    // Safari plays HLS natively; everywhere else needs hls.js.
    const nativeHls = document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
    return { kind: "hls", src, native: nativeHls };
  }

  if (isDash(src)) {
    if (window.dashjs) return { kind: "dash", src };
    return { kind: "direct", src };
  }

  return { kind: "direct", src };
}

/* ---------- icons ---------- */

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 7H6a5 5 0 1 0 5 5"/><path d="M11 3 7 7l4 4"/><text x="12" y="16.5" font-size="6" fill="currentColor" stroke="none" font-family="system-ui">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 7h5a5 5 0 1 1-5 5"/><path d="m13 3 4 4-4 4"/><text x="4" y="16.5" font-size="6" fill="currentColor" stroke="none" font-family="system-ui">10</text></svg>',
  volume: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4 4 0 0 0-2-3.46v6.92A4 4 0 0 0 16.5 12z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm15.5 1.4-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zm2 2v8h14V7z"/><path d="M12 11h7v4h-7z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>',
  exitFull: '<svg viewBox="0 0 24 24"><path d="M10 4h2v6H6V8h4V4zm4 0h2v4h4v2h-6V4zM6 14h6v6H8v-4H6v-2zm8 0h6v2h-4v4h-2v-6z"/></svg>',
  chapters: '<svg viewBox="0 0 24 24"><path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z"/></svg>',
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** True when focus sits in a field that should own its own key handling. */
export const isTypingTarget = (node) =>
  node instanceof HTMLElement &&
  (node.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName));

const SAVE_INTERVAL = 5000;
const RESUME_TAIL_THRESHOLD = 15; // don't offer "resume" in the last 15s
const EMBED_LOAD_TIMEOUT = 10000; // an embed that has not painted by now is stuck

/* ---------- controller ---------- */

export function createPlayer(root) {
  const el = {
    stage: root.querySelector("[data-stage]"),
    video: root.querySelector("[data-video]"),
    controls: root.querySelector("[data-controls]"),
    playBtn: root.querySelector("[data-play]"),
    bigPlay: root.querySelector("[data-big-play]"),
    back: root.querySelector("[data-back]"),
    fwd: root.querySelector("[data-fwd]"),
    mute: root.querySelector("[data-mute]"),
    volume: root.querySelector("[data-volume]"),
    pip: root.querySelector("[data-pip]"),
    full: root.querySelector("[data-full]"),
    rate: root.querySelector("[data-rate]"),
    rateMenu: root.querySelector("[data-rate-menu]"),
    chapters: root.querySelector("[data-chapters]"),
    scrub: root.querySelector("[data-scrub]"),
    played: root.querySelector("[data-played]"),
    buffered: root.querySelector("[data-buffered]"),
    knob: root.querySelector("[data-knob]"),
    ticks: root.querySelector("[data-ticks]"),
    current: root.querySelector("[data-current]"),
    total: root.querySelector("[data-total]"),
    message: root.querySelector("[data-message]"),
  };

  let entry = null;
  let source = null;
  let hls = null;
  let embedEl = null;
  let embedTimer = null;
  let embedProvider = "";
  let saveTimer = null;
  let idleTimer = null;
  let scrubbing = false;
  let scrubWasPlaying = false;
  let activeChapter = -1;
  let autoplayWanted = true;
  let embedUrl = "";
  let resumeApplied = false;
  let preflightError = null;

  /* ---- message helpers ---- */

  const showMessage = (text, kind = "loading") => {
    el.message.hidden = false;
    el.message.dataset.kind = kind;
    el.message.innerHTML = kind === "loading"
      ? `<span class="spinner"></span><span>${text}</span>`
      : `<span>${text}</span>`;
  };

  const hideMessage = () => {
    el.message.hidden = true;
    el.message.innerHTML = "";
    // Drop the kind too: a hidden node still reads as "loading" to anything
    // branching on it, which is a state the user never saw.
    delete el.message.dataset.kind;
  };

  const showControls = () => {
    el.controls.dataset.idle = "false";
    root.classList.add("cursor-active");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (el.video && !el.video.paused) el.controls.dataset.idle = "true";
    }, 2600);
  };

  let fullscreenActive = false;

  /* ---- teardown ---- */

  function detachSource() {
    flushPosition();
    clearInterval(saveTimer);
    saveTimer = null;
    clearTimeout(idleTimer);

    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (embedEl) {
      clearEmbedWatch();
      embedEl.remove();
      embedEl = null;
    }
    if (el.video) {
      el.video.pause();
      el.video.removeAttribute("src");
      el.video.load();
    }
    el.stage.querySelectorAll("iframe").forEach((f) => f.remove());
    el.bigPlay.hidden = true;
    el.scrub.parentElement.hidden = true;
    el.chapters.hidden = true;
    hideMessage();
    fullscreenActive = false;
  }

  /** Drop the embed's load listener and its stuck-loader timer, if either is armed. */
  function clearEmbedWatch() {
    if (embedTimer) {
      clearTimeout(embedTimer);
      embedTimer = null;
    }
    if (embedEl) embedEl.removeEventListener("load", onEmbedReady);
  }

  function flushPosition() {
    if (entry && el.video && Number.isFinite(el.video.currentTime)) {
      savePosition(entry.id, el.video.currentTime);
    }
  }

  /* ---- public API ---- */

  async function open(nextEntry, { autoplay = true } = {}) {
    detachSource();
    entry = nextEntry;
    resumeApplied = false;
    preflightError = null;
    setCurrentVideo(nextEntry);
    root.removeAttribute("data-tall");

    el.total.textContent = formatDuration(nextEntry.video.duration);
    el.current.textContent = "0:00";
    el.played.style.width = "0%";
    el.buffered.style.width = "0%";
    el.knob.style.left = "0%";
    el.stage.querySelectorAll("iframe").forEach((f) => f.remove());

    if (nextEntry.video.poster) {
      el.stage.style.backgroundImage = `url("${nextEntry.video.poster}")`;
    } else {
      el.stage.style.backgroundImage = "";
    }

    buildChapters(nextEntry);
    buildTicks(nextEntry);
    showControls();

    source = resolveSource(nextEntry);
    el.stage.dataset.kind = source.kind;

    if (source.kind === "embed") return mountEmbed(source, nextEntry, autoplay);

    return mountVideo(source, nextEntry, autoplay);
  }

  function mountEmbed(src, nextEntry, autoplay) {
    showMessage(`Loading ${src.provider} stream…`);
    el.scrub.parentElement.hidden = true;
    el.chapters.hidden = true;
    el.bigPlay.hidden = true;

    embedEl = document.createElement("iframe");
    embedUrl = src.embedUrl;
    embedProvider = src.provider;
    if (!autoplay) {
      embedUrl = embedUrl.replace(/[?&]autoplay=1/, "");
    }
    embedEl.src = embedUrl;
    embedEl.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    embedEl.allowFullscreen = true;
    embedEl.setAttribute("title", `${nextEntry.artist} — ${nextEntry.song}`);
    // The embed's document is cross-origin, so no playback event ever reaches
    // us; the iframe's own `load` is the only cross-origin signal that the
    // player document is up. The timer is the safety net for a blocked embed
    // or an offline network, where `load` simply never arrives.
    embedEl.addEventListener("load", onEmbedReady);
    embedTimer = setTimeout(onEmbedTimeout, EMBED_LOAD_TIMEOUT);
    el.stage.appendChild(embedEl);

    // Iframes own their own transport; disable the controls that would not work.
    for (const node of el.controls.querySelectorAll("[data-requires-media]")) {
      node.hidden = true;
    }
    el.full.hidden = false; // iframe has its own fullscreen; leave it alone
    return Promise.resolve();
  }

  function onEmbedReady() {
    clearEmbedWatch();
    hideMessage();
  }

  function onEmbedTimeout() {
    // Stay subscribed: a cold or throttled embed often lands well after this,
    // and a late `load` should clear the warning.
    embedTimer = null;
    showMessage(
      `Still loading the ${embedProvider} stream — check your connection or try another source.`,
      "error"
    );
  }

  function mountVideo(src, nextEntry, autoplay) {
    autoplayWanted = autoplay;
    for (const node of el.controls.querySelectorAll("[data-requires-media]")) node.hidden = false;

    showMessage("Opening stream…");
    el.scrub.parentElement.hidden = false;

    const video = el.video;
    video.poster = nextEntry.video.poster || nextEntry.albumArt || "";
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    video.playsInline = true;

    if (src.kind === "hls" && !src.native) {
      if (!window.Hls || !window.Hls.isSupported()) {
        showMessage("HLS stream needs hls.js, which failed to load.", "error");
        return Promise.resolve();
      }
      showMessage("Buffering HLS stream…");
      hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(src.src);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        onMetadata();
        hideMessage();
      });
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          showMessage("Network error while loading the stream.", "error");
          hls.startLoad();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          showMessage("Media error — attempting recovery.", "error");
          hls.recoverMediaError();
        } else {
          showMessage("This stream could not be played.", "error");
          hls.destroy();
        }
      });
      video.removeAttribute("src");
      saveTimer = setInterval(flushPosition, SAVE_INTERVAL);
      return Promise.resolve();
    }

    if (video.src === absoluteUrl(src.src)) {
      // Same file reopened: the metadata events will not fire again, so drive
      // the same setup by hand.
      onMetadata();
      if (autoplay) attemptPlay();
      return Promise.resolve();
    }

    video.src = src.src;
    saveTimer = setInterval(flushPosition, SAVE_INTERVAL);
    return preflightLocal(src, nextEntry);
  }

  /**
   * A local path that does not exist surfaces as the browser's opaque
   * SRC_NOT_SUPPORTED, which reads as "bad codec" and sends people hunting in
   * the wrong place. One HEAD request turns that into a precise message.
   *
   * Only same-origin local entries are probed: a remote host may reject HEAD,
   * and the media element reports remote failures accurately enough.
   */
  async function preflightLocal(src, nextEntry) {
    if (nextEntry.video.type !== "local") return;

    const url = absoluteUrl(src.src);
    if (!url.startsWith(window.location.origin)) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: controller.signal });
      if (res.status === 404) {
        preflightError = `File not found: ${nextEntry.video.src}`;
      } else if (!res.ok && res.status !== 405) {
        preflightError = `Could not open ${nextEntry.video.src} (HTTP ${res.status}).`;
      }
      if (preflightError) showMessage(preflightError, "error");
    } catch {
      // Offline, aborted, or blocked: the media element reports the real error.
    } finally {
      clearTimeout(timer);
    }
  }

  function absoluteUrl(path) {
    try {
      return new URL(path, window.location.href).href;
    } catch {
      return path;
    }
  }

  /* ---- media events ---- */

  function onMetadata() {
    hideMessage();
    const duration = el.video.duration;
    if (Number.isFinite(duration) && duration > 0) {
      el.total.textContent = formatDuration(duration);
      buildTicks(entry, duration);
    }

    updateAspect();
    if (resumeApplied) return;
    resumeApplied = true;

    const resume = readPosition(entry.id);
    if (resume > 2 && duration && resume < duration - RESUME_TAIL_THRESHOLD) {
      el.video.currentTime = resume;
      onTimeUpdate();
    }

    if (autoplayWanted) attemptPlay();
    else el.bigPlay.hidden = false;
  }

  function updateAspect() {
    const w = el.video.videoWidth;
    const h = el.video.videoHeight;
    if (!w || !h) return;
    if (root.dataset.open !== "true") return;
    if (fullscreenActive) return;
    el.video.style.aspectRatio = `${w} / ${h}`;
    el.stage.style.aspectRatio = `${w} / ${h}`;

    const ratio = w / h;
    if (ratio < 0.8) {
      root.dataset.tall = "true";
    } else {
      root.removeAttribute("data-tall");
    }
  }

  function onMediaError() {
    // A failed preflight already knows exactly what is wrong; the <video>
    // element would otherwise overwrite it with the same opaque SRC_NOT_SUPPORTED.
    if (preflightError) {
      showMessage(preflightError, "error");
      return;
    }
    const err = el.video.error;
    const messages = {
      1: "Playback was aborted.",
      2: "This file could not be found. Check the path in catalog.json.",
      3: "The file is corrupt or uses an unsupported codec.",
      4: "This source is not supported by your browser.",
    };
    showMessage(messages[err?.code] || "The video could not be played.", "error");
    console.error("[player] media error", err);
  }

  function onTimeUpdate() {
    const { currentTime, duration } = el.video;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const pct = (currentTime / duration) * 100;
    el.current.textContent = formatDuration(currentTime);
    if (!scrubbing) {
      el.played.style.width = `${pct}%`;
      el.knob.style.left = `${pct}%`;
    }
    syncChapter(currentTime);
  }

  function onProgress() {
    const { buffered, duration } = el.video;
    if (!buffered.length || !duration) return;
    const end = buffered.end(buffered.length - 1);
    el.buffered.style.width = `${Math.min(100, (end / duration) * 100)}%`;
  }

  function onPlayState() {
    const playing = !el.video.paused;
    el.playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
    el.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    el.bigPlay.hidden = playing;
    if (playing) {
      showControls();
    } else {
      clearTimeout(idleTimer);
      el.controls.dataset.idle = "false";
    }
  }

  function onVolumeChange() {
    const muted = el.video.muted || el.video.volume === 0;
    el.mute.innerHTML = muted ? ICONS.mute : ICONS.volume;
    el.mute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    el.volume.value = String(muted ? 0 : el.video.volume * 100);
  }

  function onEnded() {
    flushPosition();
    el.playBtn.innerHTML = ICONS.play;
    el.bigPlay.hidden = false;
    el.controls.dataset.idle = "false";
  }

  /* ---- chapters ---- */

  function buildChapters(nextEntry) {
    const chapters = nextEntry.chapters || [];
    el.chapters.innerHTML = "";
    activeChapter = -1;
    if (chapters.length < 1) {
      el.chapters.hidden = true;
      return;
    }
    chapters.forEach((chapter, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `${formatDuration(chapter.time)} · ${chapter.title}`;
      btn.addEventListener("click", () => seekTo(chapter.time));
      el.chapters.appendChild(btn);
    });
    el.chapters.hidden = false;
  }

  function syncChapter(currentTime) {
    if (!entry?.chapters?.length) return;
    let index = -1;
    entry.chapters.forEach((c, i) => {
      if (currentTime >= c.time) index = i;
    });
    if (index === activeChapter) return;
    activeChapter = index;
    [...el.chapters.children].forEach((btn, i) =>
      btn.setAttribute("aria-current", String(i === index))
    );
  }

  function buildTicks(nextEntry, durationOverride) {
    el.ticks.innerHTML = "";
    const chapters = nextEntry?.chapters || [];
    if (!chapters.length) return;
    const duration = durationOverride || nextEntry.video.duration;
    if (!duration) return;
    for (const chapter of chapters) {
      if (!chapter.time) continue;
      const tick = document.createElement("span");
      tick.className = "scrub-tick";
      tick.style.left = `${(chapter.time / duration) * 100}%`;
      el.ticks.appendChild(tick);
    }
  }

  /* ---- transport ---- */

  function attemptPlay() {
    el.video.play().catch((err) => {
      // Autoplay policies and stale HLS sources both land here; both are normal.
      console.debug("[player] autoplay deferred", err.message);
      el.bigPlay.hidden = false;
    });
  }

  function togglePlay() {
    if (!el.video || !el.video.src) return;
    if (el.video.paused) attemptPlay();
    else el.video.pause();
  }

  function seekTo(seconds) {
    if (!el.video) return;
    if (el.video.readyState < 2) return;
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : entry?.video.duration || 0;
    el.video.currentTime = Math.min(Math.max(0, seconds), duration || seconds);
    onTimeUpdate();
  }

  function nudge(delta) {
    seekTo((el.video?.currentTime || 0) + delta);
  }

  function changeVolume(delta) {
    if (!el.video) return;
    const next = Math.min(1, Math.max(0, el.video.volume + delta));
    el.video.muted = next === 0;
    el.video.volume = next;
    onVolumeChange();
  }

  function toggleMute() {
    if (!el.video) return;
    el.video.muted = !el.video.muted;
    onVolumeChange();
  }

  async function toggleFullscreen() {
    console.log('[player] toggleFullscreen called');
    const modal = el.stage.closest(".modal");
    try {
      if (document.fullscreenElement) {
        console.log('[player] exiting fullscreen');
        fullscreenActive = false;
        modal.dataset.tall = entry ? (el.video.videoWidth / el.video.videoHeight < 0.8 ? "true" : "false") : "false";
        document.body.classList.remove("player-fullscreen");
        el.video.style.cssText = "";
        el.stage.style.cssText = "";
        updateAspect();
        await document.exitFullscreen();
      } else {
        console.log('[player] entering fullscreen');
        fullscreenActive = true;
        modal.removeAttribute("data-tall");
        document.body.classList.add("player-fullscreen");
        el.video.style.cssText = "";
        el.stage.style.cssText = "";
        
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const videoRatio = el.video.videoWidth / el.video.videoHeight;
        
        if (videoRatio < 0.8) {
          const targetHeight = vh;
          const targetWidth = targetHeight * videoRatio;
          el.stage.style.cssText = `aspect-ratio:${videoRatio} !important;width:${targetWidth}px !important;height:${targetHeight}px !important;position:fixed !important;top:0 !important;left:50% !important;transform:translateX(-50%) !important;z-index:9999 !important;background:#000 !important`;
          el.video.style.cssText = `width:100% !important;height:100% !important;object-fit:contain !important`;
        } else {
          el.stage.style.cssText = `aspect-ratio:${videoRatio} !important;width:${vw}px !important;height:${vh}px !important;position:fixed !important;top:0 !important;left:0 !important;z-index:9999 !important;background:#000 !important`;
          el.video.style.cssText = `width:100% !important;height:100% !important;object-fit:contain !important`;
        }
        
        console.log('[player] requesting fullscreen');
        await modal.requestFullscreen();
        console.log('[player] fullscreen requested');
      }
    } catch (err) {
      console.warn("[player] fullscreen refused", err.message);
    }
  }
  async function togglePip() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && el.video.readyState >= 1) {
        await el.video.requestPictureInPicture();
      } else {
        showMessage("Picture-in-Picture is not available here.", "error");
      }
    } catch (err) {
      console.warn("[player] PiP refused", err.message);
    }
  }

  function setRate(rate) {
    if (el.video) el.video.playbackRate = rate;
    el.rate.textContent = `${rate}x`;
    for (const btn of el.rateMenu.querySelectorAll("button")) {
      btn.setAttribute("aria-checked", String(Number(btn.dataset.rate) === rate));
    }
    try {
      localStorage.setItem("pittv:rate", String(rate));
    } catch {
      /* non-critical */
    }
  }

  function stepRate(dir) {
    const current = el.video?.playbackRate || 1;
    const next = dir > 0
      ? RATES.find((r) => r > current + 0.001) ?? RATES[RATES.length - 1]
      : [...RATES].reverse().find((r) => r < current - 0.001) ?? RATES[0];
    setRate(next);
  }

  /* ---- scrubbing ---- */

  function positionFromEvent(event) {
    const rect = el.scrub.getBoundingClientRect();
    const x = (event.touches?.[0]?.clientX ?? event.clientX) - rect.left;
    return Math.min(1, Math.max(0, x / rect.width));
  }

  function startScrub(event) {
    if (!el.video || !Number.isFinite(el.video.duration) || el.video.readyState < 2) return;
    scrubbing = true;
    scrubWasPlaying = !el.video.paused;
    el.scrub.dataset.scrubbing = "true";
    el.scrub.setPointerCapture?.(event.pointerId);
    updateScrub(event);
  }

  function updateScrub(event) {
    const ratio = positionFromEvent(event);
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : entry?.video.duration || 0;
    el.played.style.width = `${ratio * 100}%`;
    el.knob.style.left = `${ratio * 100}%`;
    el.current.textContent = formatDuration(ratio * duration);
  }

  function endScrub(event) {
    if (!scrubbing) return;
    scrubbing = false;
    el.scrub.dataset.scrubbing = "false";
    const ratio = positionFromEvent(event);
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : entry?.video.duration || 0;
    if (duration) el.video.currentTime = ratio * duration;
    onTimeUpdate();
  }

  /* ---- wiring ---- */

  // Media listeners are registered once here rather than per-mount, so opening
  // a second video cannot stack duplicate handlers on the same <video> element.
  el.video.addEventListener("loadedmetadata", onMetadata);
  el.video.addEventListener("durationchange", onMetadata);
  el.video.addEventListener("error", onMediaError);
  el.video.addEventListener("timeupdate", onTimeUpdate);
  el.video.addEventListener("progress", onProgress);
  el.video.addEventListener("play", onPlayState);
  el.video.addEventListener("pause", onPlayState);
  el.video.addEventListener("volumechange", onVolumeChange);
  el.video.addEventListener("ended", onEnded);
  el.video.addEventListener("waiting", () => showMessage("Buffering…"));
  el.video.addEventListener("playing", hideMessage);
  el.video.addEventListener("loadeddata", () => { hideMessage(); updateAspect(); });

  // videoWidth/videoHeight can be 0 at metadata time in some browsers; watch
  // the element's bounding rect instead so vertical clips still get their
  // aspect class applied as soon as the frame is painted.
  const aspectObserver = new ResizeObserver(() => updateAspect());
  aspectObserver.observe(el.video);

  el.playBtn.innerHTML = ICONS.play;
  el.back.innerHTML = ICONS.back10;
  el.fwd.innerHTML = ICONS.fwd10;
  el.mute.innerHTML = ICONS.volume;
  el.pip.innerHTML = ICONS.pip;
  el.full.innerHTML = ICONS.full;
  el.bigPlay.innerHTML = ICONS.play;

  el.playBtn.addEventListener("click", togglePlay);
  el.bigPlay.addEventListener("click", () => {
    attemptPlay();
  });
  el.back.addEventListener("click", () => nudge(-10));
  el.fwd.addEventListener("click", () => nudge(10));
  el.mute.addEventListener("click", toggleMute);
  el.pip.addEventListener("click", togglePip);
  el.full.addEventListener("click", toggleFullscreen);

  el.volume.addEventListener("input", () => {
    const value = Number(el.volume.value) / 100;
    el.video.volume = value;
    el.video.muted = value === 0;
    onVolumeChange();
  });

  el.scrub.addEventListener("pointerdown", startScrub);
  el.scrub.addEventListener("pointermove", (e) => scrubbing && updateScrub(e));
  el.scrub.addEventListener("pointerup", endScrub);
  el.scrub.addEventListener("pointercancel", endScrub);
  el.scrub.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") nudge(-5);
    if (e.key === "ArrowRight") nudge(5);
  });

  el.rate.addEventListener("click", () => {
    const open = el.rateMenu.hidden;
    el.rateMenu.hidden = !open;
  });
  for (const btn of el.rateMenu.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      setRate(Number(btn.dataset.rate));
      el.rateMenu.hidden = true;
    });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!el.rateMenu.hidden && !el.rateMenu.contains(e.target) && !el.rate.contains(e.target)) {
      el.rateMenu.hidden = true;
    }
  });

  // Auto-hide the cursor alongside the controls so the stage feels like a player.
  [el.stage, el.controls].forEach((node) => {
    node.addEventListener("pointermove", showControls);
    node.addEventListener("pointerleave", () => {
      if (el.video && !el.video.paused) el.controls.dataset.idle = "true";
    });
  });

  el.stage.addEventListener("dblclick", toggleFullscreen);
  el.stage.addEventListener("click", (e) => {
    // Click-to-toggle, but ignore clicks that land on the controls.
    if (e.target.closest("[data-controls]")) return;
    if (e.target.closest(".stage-play")) return;
    if (e.target.tagName === "IFRAME") return;
    togglePlay();
  });

  document.addEventListener("fullscreenchange", () => {
    const on = Boolean(document.fullscreenElement);
    el.full.innerHTML = on ? ICONS.exitFull : ICONS.full;
    el.full.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
    if (on) {
      el.video.style.aspectRatio = "";
      el.video.style.objectFit = "contain";
      el.video.style.width = "100%";
      el.video.style.height = "100%";
      el.stage.style.aspectRatio = "";
    } else {
      fullscreenActive = false;
      document.body.classList.remove("player-fullscreen");
      if (entry) updateAspect();
    }
  });

  document.addEventListener("keydown", (e) => {
    // Only claim keys while the player is actually on screen, otherwise the
    // browser-level grid navigation in ui.js would never see an arrow key.
    if (root.dataset.open !== "true") return;
    if (isTypingTarget(e.target)) return;

    if (!e.key) return;
    const lower = e.key.toLowerCase();
    if (e.key === " " || lower === "k") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(-10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nudge(10);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      changeVolume(0.1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      changeVolume(-0.1);
    } else if (lower === "f") {
      toggleFullscreen();
    } else if (lower === "m") {
      toggleMute();
    } else if (e.key === "[" || lower === "j") {
      nudge(-5);
    } else if (e.key === "]" || lower === "l") {
      nudge(5);
    } else if (lower === "n" || lower === "p") {
      stepRate(lower === "n" ? 1 : -1);
    }
  });

  try {
    const savedRate = Number(localStorage.getItem("pittv:rate"));
    if (RATES.includes(savedRate)) el.video.playbackRate = savedRate;
  } catch {
    /* non-critical */
  }

  return {
    open,
    close: detachSource,
    togglePlay,
    seekTo,
    toggleFullscreen,
    toggleMute,
    nudge,
    changeVolume,
    flushPosition,
    get entry() {
      return entry;
    },
    setAutoplay(value) {
      autoplayWanted = value;
    },
  };
}









