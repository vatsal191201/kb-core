/* Exercise library and read-only session queues for KB Core. */
(function () {
  "use strict";

  const FILTERS = [
    ["all", "All"],
    ["warmup", "Warm-up"],
    ["main", "Main"],
    ["alt", "Alternatives"],
    ["Beginner", "Beginner"],
    ["Intermediate", "Intermediate"],
    ["Advanced", "Advanced"]
  ];

  let exercises = [];
  let activeFilter = "all";
  let videoObserver = null;
  let hookedKB = null;
  let upcomingSignature = "";

  const byId = id => document.getElementById(id);

  function addText(parent, tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? "" : String(value).replace(/[—–]/g, "-");
    parent.appendChild(node);
    return node;
  }

  // iOS Safari stops decoding past a handful of simultaneous videos.
  const MAX_LIVE_VIDEOS = 6;

  function makeVideo(exercise, className) {
    const video = document.createElement("video");
    if (className) video.className = className;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    // preload="metadata" only fetches the header, so readyState tops out at 1
    // and play() resolves without ever rendering frames: 18 cards sat "ready"
    // but frozen on their posters. "auto" lets the observer actually start
    // playback; clips are ~100-300KB and only visible ones ever play.
    // LAZY. Do NOT set .src here.
    //
    // Reported on device: "the videos don't play back properly and the exercise
    // tab does not render properly on my phone". With 46 cards, assigning src +
    // preload="auto" to every one told the browser to fetch 46 videos at once.
    // Mobile Safari caps how many media elements can decode concurrently; past
    // that limit play() rejects silently and cards sit frozen on their posters.
    // Desktop has a much higher cap, which is why this never reproduced here.
    //
    // The src is attached by the IntersectionObserver when the card scrolls
    // into view, and detached when it leaves, so only a handful are ever live.
    video.preload = "none";
    // Attributes (not just properties) - iOS Safari checks the ATTRIBUTES when
    // deciding whether inline autoplay is permitted.
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("loop", "");
    video.poster = exercise.poster || "";
    video.dataset.src = exercise.video || "";
    video.addEventListener("error", () => {
      // A missing future clip must leave its poster/card usable.
      try { video.removeAttribute("src"); video.load(); } catch (_) {}
    }, { once: true });
    video.setAttribute("aria-label", `${exercise.name || "Exercise"} demonstration`);
    return video;
  }

  // Attach/detach the real src so only on-screen clips hold a decoder.
  function attachSrc(video) {
    const want = video.dataset.src;
    if (!want || video.src.endsWith(want)) return;
    video.src = want;
    video.load();
  }
  function detachSrc(video) {
    if (!video.src) return;
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();          // actually frees the decoder on iOS
    } catch (_) {}
  }

  function ensureObserver() {
    if (videoObserver || !("IntersectionObserver" in window)) return;
    videoObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const video = entry.target;
        const card = video.closest(".ex-card");
        if (entry.isIntersecting && entry.intersectionRatio > 0 && !(card && card.hidden)) {
          attachSrc(video);
          video.play().catch(() => {});
        } else {
          detachSrc(video);
        }
      });
      // Hard ceiling regardless of what the observer thinks is visible.
      const live = Array.from(document.querySelectorAll("#library-grid video"))
        .filter(v => v.src);
      if (live.length > MAX_LIVE_VIDEOS) {
        live.slice(0, live.length - MAX_LIVE_VIDEOS).forEach(v => {
          const r = v.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) detachSrc(v);
        });
      }
    }, { threshold: 0.15, rootMargin: "200px 0px" });
  }

  function observeVideo(video) {
    video.pause();
    if (videoObserver) videoObserver.observe(video);
    else if (!("IntersectionObserver" in window)) { attachSrc(video); video.play().catch(() => {}); }
  }

  /* Belt and braces. IntersectionObserver is the efficient path, but it is not
     guaranteed to deliver a callback (it did not fire at all in one headless
     environment, and a missed callback means a grid of frozen posters, which is
     exactly what was reported on device). This sweep runs on scroll/resize and
     once after render: it attaches the clips that are actually on screen and
     detaches the rest, so the grid is correct even if the observer never fires.
     Idempotent - attachSrc/detachSrc both no-op when already in the right state. */
  function sweepVisible() {
    const vids = Array.from(document.querySelectorAll("#library-grid video"));
    let live = 0;
    vids.forEach(v => {
      const card = v.closest(".ex-card");
      const r = v.getBoundingClientRect();
      const onScreen = !(card && card.hidden) &&
                       r.bottom > -200 && r.top < window.innerHeight + 200 &&
                       r.width > 0;
      if (onScreen && live < MAX_LIVE_VIDEOS) {
        live++;
        attachSrc(v);
        if (v.paused) v.play().catch(() => {});
      } else {
        detachSrc(v);
      }
    });
  }
  let sweepPending = false;
  function scheduleSweep() {
    if (sweepPending) return;
    sweepPending = true;
    setTimeout(() => { sweepPending = false; sweepVisible(); }, 120);
  }
  window.addEventListener("scroll", scheduleSweep, { passive: true });
  window.addEventListener("resize", scheduleSweep, { passive: true });

  function ensureFilters() {
    const filters = byId("library-filters");
    if (!filters) return;
    FILTERS.forEach(([value, label]) => {
      let button = Array.from(filters.querySelectorAll("button[data-filter]")).find(
        item => item.dataset.filter === value
      );
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.filter = value;
        button.textContent = label;
        filters.appendChild(button);
      }
      button.setAttribute("aria-pressed", String(value === activeFilter));
    });
  }

  function matchesFilter(exercise) {
    return activeFilter === "all" ||
      exercise.block === activeFilter || exercise.level === activeFilter;
  }

  function applyFilter() {
    const grid = byId("library-grid");
    const filters = byId("library-filters");
    if (filters) {
      filters.querySelectorAll("button[data-filter]").forEach(button => {
        button.setAttribute("aria-pressed", String(button.dataset.filter === activeFilter));
      });
    }
    if (!grid) return;
    grid.querySelectorAll(".ex-card").forEach((card, index) => {
      const show = matchesFilter(exercises[index] || {});
      card.hidden = !show;
      const video = card.querySelector("video");
      if (video && !show) { video.pause(); detachSrc(video); }
      if (video && show && !videoObserver) { attachSrc(video); video.play().catch(() => {}); }
      // Re-observe visible cards. The IntersectionObserver only re-evaluates on
      // intersection CHANGES, and `hidden` is applied AFTER observe() during the
      // initial render, so every card looked hidden at first callback and no src
      // was ever attached: 46 posters, zero playing. Re-observing forces a fresh
      // callback against the card's true visibility.
      if (video && show && videoObserver) {
        videoObserver.unobserve(video);
        videoObserver.observe(video);
      }
    });
    scheduleSweep();
  }

  function openDetail(exercise) {
    const detail = byId("library-detail");
    if (!detail) return;
    detail.replaceChildren();

    const close = addText(detail, "button", "library-detail__close", "Back to exercises");
    close.type = "button";
    close.addEventListener("click", () => {
      const video = detail.querySelector("video");
      if (video) video.pause();
      detail.hidden = true;
    });

    const video = makeVideo(exercise, "library-detail__video");
    // The detail sheet is not watched by the IntersectionObserver, so nothing
    // would ever attach its src now that makeVideo() is lazy. Attach it here.
    attachSrc(video);
    video.play().catch(() => {});
    detail.appendChild(video);
    addText(detail, "h2", "library-detail__name", exercise.name);

    const facts = document.createElement("div");
    facts.className = "library-detail__facts";
    addText(facts, "span", "ex-card__meta", exercise.level);
    addText(facts, "span", "ex-card__meta", exercise.modeLabel);
    detail.appendChild(facts);
    addText(detail, "p", "library-detail__muscles", `Targets: ${exercise.muscles || "Not specified"}`);
    addText(detail, "p", "library-detail__cue", `Form cue: ${exercise.cue || "Move slowly and stay in control."}`);
    addText(detail, "p", "library-detail__stop", `Stop if: ${exercise.stop || "You cannot maintain controlled form."}`);

    const credit = document.createElement("a");
    credit.className = "library-detail__credit";
    credit.href = exercise.sourceUrl || "#";
    credit.target = "_blank";
    credit.rel = "noopener";
    credit.textContent = `Source: ${exercise.sourceTitle || "Video"}${exercise.sourceChannel ? ` - ${exercise.sourceChannel}` : ""}`;
    detail.appendChild(credit);
    detail.hidden = false;
    video.play().catch(() => {});
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderLibrary() {
    const grid = byId("library-grid");
    if (!grid) return;
    ensureObserver();
    if (videoObserver) videoObserver.disconnect();
    grid.replaceChildren();

    exercises.forEach(exercise => {
      const card = document.createElement("article");
      card.className = "ex-card";
      card.dataset.exerciseId = exercise.id || "";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `View ${exercise.name || "exercise"} details`);

      const media = document.createElement("div");
      media.className = "ex-card__media";
      const video = makeVideo(exercise);
      media.appendChild(video);
      card.appendChild(media);

      const body = document.createElement("div");
      body.className = "ex-card__body";
      addText(body, "h3", "ex-card__name", exercise.name);
      addText(body, "span", "ex-card__meta", exercise.level);
      addText(body, "p", "ex-card__meta", exercise.muscles);
      card.appendChild(body);

      card.addEventListener("click", () => openDetail(exercise));
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetail(exercise);
        }
      });
      grid.appendChild(card);
      observeVideo(video);
    });
    applyFilter();
    scheduleSweep();
  }

  function durationFor(item) {
    const kb = window.KB || {};
    const explicit = Number(item && (item.duration ?? item.dur ?? item.seconds));
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    const kind = String(item && (item.kind || item.type || item.phase) || "").toLowerCase();
    const settings = kb.settings || {};
    if (kind === "rest") return Number(settings.rest) || 0;
    if (kind === "prep" || kind === "prepare") return Number(settings.prep) || 0;
    return Number(settings.work) || 0;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    return value >= 60
      ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`
      : `${value}s`;
  }

  function itemName(item) {
    if (!item) return "Interval";
    return item.name || item.label || item.title ||
      (String(item.kind || item.type || "").toLowerCase() === "rest" ? "Rest" : item.id || "Interval");
  }

  function itemBlock(item) {
    return item && (item.block || item.blockLabel || item.round || item.kind || item.type) || "Session";
  }

  function makeQueueItem(item, index, currentIndex, includeState) {
    const row = document.createElement("div");
    row.className = "queue-item";
    if (includeState && index < currentIndex) row.classList.add("queue-item--done");
    if (includeState && index === currentIndex) {
      row.classList.add("queue-item--current");
      row.setAttribute("aria-current", "step");
    }
    addText(row, "span", "queue-item__number", String(index + 1));
    const copy = document.createElement("span");
    copy.className = "queue-item__copy";
    addText(copy, "span", "queue-item__name", itemName(item));
    addText(copy, "span", "queue-item__block", itemBlock(item));
    row.appendChild(copy);
    addText(row, "span", "queue-item__duration", formatDuration(durationFor(item)));
    return row;
  }

  function renderPreview() {
    const container = byId("session-preview");
    if (!container) return;
    const queue = Array.isArray(window.KB && window.KB.queue) ? window.KB.queue : [];
    container.replaceChildren();
    if (!queue.length) {
      addText(container, "p", "queue-empty", "Your session preview will appear here.");
      return;
    }
    const fragment = document.createDocumentFragment();
    queue.forEach((item, index) => fragment.appendChild(makeQueueItem(item, index, -1, false)));
    container.appendChild(fragment);
  }

  function renderUpcoming(force) {
    const container = byId("upcoming-list");
    const upNext = byId("up-next");
    const kb = window.KB || {};
    const queue = Array.isArray(kb.queue) ? kb.queue : [];
    const currentIndex = Math.max(0, Number.isFinite(Number(kb.currentIndex)) ? Number(kb.currentIndex) : 0);
    const signature = `${currentIndex}|${queue.length}|${queue.map(item => `${itemName(item)}:${durationFor(item)}`).join("|")}`;
    if (!force && signature === upcomingSignature) return;
    upcomingSignature = signature;

    if (upNext) {
      const next = queue[currentIndex + 1];
      upNext.textContent = next ? itemName(next) : (queue.length ? "Last interval" : "Nothing queued");
    }
    if (!container) return;
    container.replaceChildren();
    if (!queue.length) {
      addText(container, "p", "queue-empty", "No intervals queued.");
      return;
    }
    const fragment = document.createDocumentFragment();
    queue.forEach((item, index) => fragment.appendChild(makeQueueItem(item, index, currentIndex, true)));
    container.appendChild(fragment);
    const current = container.querySelector(".queue-item--current");
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  function attachHooks(kb) {
    if (!kb || hookedKB === kb) return;
    hookedKB = kb;
    kb.onQueueChange = function () {
      renderPreview();
      renderUpcoming(true);
    };
    kb.onTick = function () {
      renderUpcoming(false);
    };
    renderPreview();
    renderUpcoming(true);
  }

  async function loadLibrary(kb) {
    if (!kb || typeof kb.loadExercises !== "function" || exercises.length) return;
    try {
      const data = await kb.loadExercises();
      if (!Array.isArray(data)) return;
      exercises = data;
      renderLibrary();
    } catch (error) {
      const grid = byId("library-grid");
      if (grid && !grid.children.length) addText(grid, "p", "queue-empty", "Exercise library unavailable.");
    }
  }

  function navigateHome() {
    if (typeof window.showView === "function") window.showView("view-home");
  }

  function wireDOM() {
    ensureFilters();
    const filters = byId("library-filters");
    if (filters && !filters.dataset.libraryWired) {
      filters.dataset.libraryWired = "true";
      filters.addEventListener("click", event => {
        const button = event.target.closest("button[data-filter]");
        if (!button || !filters.contains(button)) return;
        activeFilter = button.dataset.filter;
        const detail = byId("library-detail");
        if (detail) detail.hidden = true;
        applyFilter();
      });
    }
    const back = byId("btn-library-back");
    if (back && !back.dataset.libraryWired) {
      back.dataset.libraryWired = "true";
      back.addEventListener("click", navigateHome);
    }
    const open = byId("btn-open-library");
    if (open && !open.dataset.libraryWired) {
      open.dataset.libraryWired = "true";
      open.addEventListener("click", () => {
        if (typeof window.showView === "function") window.showView("view-library");
      });
    }
  }

  function connect() {
    wireDOM();
    const kb = window.KB;
    if (kb) {
      attachHooks(kb);
      loadLibrary(kb);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connect, { once: true });
  else connect();

  // The module is also safe when app.js creates KB after this script executes.
  const kbPoll = window.setInterval(() => {
    connect();
    if (window.KB && hookedKB === window.KB && typeof window.KB.loadExercises === "function" && exercises.length) {
      window.clearInterval(kbPoll);
    }
  }, 250);
}());
