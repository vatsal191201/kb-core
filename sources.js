/* sources.js - follow the ORIGINAL videos.
 *
 * Third way to train, alongside the generated session and the custom builder:
 * play a source workout end to end, or jump straight to any exercise inside it
 * using the chapter markers extracted from that video.
 *
 * Owns: #view-sources and everything inside it. Reads sources.json only.
 */
(function () {
  "use strict";

  var byId = function (id) { return document.getElementById(id); };
  var sources = null;
  var current = null;

  function fmt(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent: never inject raw HTML
    return n;
  }

  function embedUrl(src, start) {
    // youtube-nocookie + no related videos. `start` jumps to an exercise.
    var u = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(src.id) +
            "?rel=0&modestbranding=1&playsinline=1&autoplay=1";
    if (start) u += "&start=" + Math.max(0, Math.floor(start));
    return u;
  }

  function openPlayer(src, start, label) {
    current = src;
    var frame = byId("source-iframe");
    var box = byId("source-player");
    if (!frame || !box) return;
    frame.src = embedUrl(src, start);
    var t = byId("player-title");
    if (t) t.textContent = label ? (src.channel + " - " + label) : src.title;
    box.classList.remove("hidden");
    renderChapters(src);
    // The player is a fixed overlay now, so it is on screen by definition.
    // Lock the page behind it and reset the overlay's own scroll to the top.
    document.body.classList.add("no-scroll");
    box.scrollTop = 0;
  }

  function closePlayer() {
    var frame = byId("source-iframe");
    var box = byId("source-player");
    if (frame) frame.src = "";          // stop playback, do not leave it running
    if (box) box.classList.add("hidden");
    document.body.classList.remove("no-scroll");
    current = null;
  }

  function renderChapters(src) {
    var wrap = byId("player-chapters");
    if (!wrap) return;
    wrap.replaceChildren();
    if (!src.chapters || !src.chapters.length) {
      wrap.appendChild(el("p", "note", "No exercise markers for this video."));
      return;
    }
    wrap.appendChild(el("p", "label", "Jump to exercise"));
    var list = el("div", "chapters__list");
    src.chapters.forEach(function (c, i) {
      var b = el("button", "chapter");
      b.type = "button";
      b.appendChild(el("span", "chapter__n", String(i + 1)));
      b.appendChild(el("span", "chapter__name", c.name));
      b.appendChild(el("span", "chapter__t", fmt(c.start)));
      b.addEventListener("click", function () { openPlayer(src, c.start, c.name); });
      list.appendChild(b);
    });
    wrap.appendChild(list);
  }

  function render() {
    var host = byId("sources-list");
    if (!host || !sources) return;
    host.replaceChildren();

    sources.filter(function (src) {
      var kb = window.KB;
      if (kb && typeof kb.matchesEquipment === "function") return kb.matchesEquipment(src);
      return true;
    }).forEach(function (src) {
      var card = el("article", "source");

      var head = el("div", "source__head");
      head.appendChild(el("h3", "source__title", src.title));
      head.appendChild(el("p", "source__meta",
        src.channel + "  |  " + fmt(src.durationSec) +
        "  |  " + src.exerciseCount + " exercises"));
      card.appendChild(head);

      var acts = el("div", "source__actions");

      var play = el("button", "btn btn--primary btn--sm", "Follow along");
      play.type = "button";
      play.addEventListener("click", function () { openPlayer(src, 0, null); });
      acts.appendChild(play);

      if (src.chapters && src.chapters.length) {
        var jump = el("button", "btn btn--ghost btn--sm", "Exercises");
        jump.type = "button";
        jump.addEventListener("click", function () {
          openPlayer(src, src.chapters[0].start, src.chapters[0].name);
        });
        acts.appendChild(jump);
      }

      var yt = el("a", "btn btn--ghost btn--sm", "YouTube");
      yt.href = src.url; yt.target = "_blank"; yt.rel = "noopener noreferrer";
      acts.appendChild(yt);

      card.appendChild(acts);
      host.appendChild(card);
    });
  }

  function boot() {
    var open = byId("btn-open-sources");
    if (open) open.addEventListener("click", function () {
      if (window.showView) window.showView("view-sources");
    });
    var back = byId("btn-sources-back");
    if (back) back.addEventListener("click", function () {
      closePlayer();
      if (window.showView) window.showView("view-home");
    });
    var close = byId("btn-close-player");
    if (close) close.addEventListener("click", closePlayer);
    // Equipment lives in app.js. Both this module and library.js need to react,
    // so listen on a DOM event rather than compete for a single KB callback slot.
    document.addEventListener("kb:equipmentchange", function () {
      closePlayer();
      render();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePlayer();
    });

    fetch("sources.json")
      .then(function (r) { return r.json(); })
      .then(function (d) { sources = d; render(); })
      .catch(function () {
        var host = byId("sources-list");
        if (host) host.appendChild(el("p", "note", "Video list unavailable offline."));
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
