/* KB Core timer engine.  All elapsed time is derived from timer.t0: no tick is
   accumulated, so a throttled/background tab cannot make the workout drift. */
(function () {
  "use strict";

  const SETTINGS_KEY = "kb-core-settings-v2";
  const HISTORY_KEY = "kb-core-history-v2";
  const LIMITS = { work: [20, 120], rest: [10, 60], rounds: [1, 6], prep: [0, 30] };
  const defaults = { work: 60, rest: 20, rounds: 3, prep: 10 };
  const $ = (selector) => document.querySelector(selector);
  const setText = (selector, value) => { const el = $(selector); if (el) el.textContent = value; };

  function storedSettings() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
    catch (_) { return { ...defaults }; }
  }
  function clamp(name, value) {
    const [min, max] = LIMITS[name];
    value = Number(value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : defaults[name];
  }
  const KB = window.KB = window.KB || {};
  KB.settings = Object.fromEntries(Object.keys(defaults).map(k => [k, clamp(k, storedSettings()[k])]));
  KB.queue = [];
  KB.currentIndex = 0;
  KB.onQueueChange = KB.onQueueChange || null;
  KB.onTick = KB.onTick || null;

  let exercisesPromise;
  KB.loadExercises = () => {
    if (!exercisesPromise) exercisesPromise = fetch("exercises.json")
      .then(r => { if (!r.ok) throw new Error("Could not load exercises"); return r.json(); })
      .catch(err => { console.warn("KB Core:", err); return []; });
    return exercisesPromise;
  };
  let workoutPromise;
  const loadWorkout = () => {
    if (!workoutPromise) workoutPromise = fetch("workout.json")
      .then(r => { if (!r.ok) throw new Error("Could not load workout"); return r.json(); })
      .catch(err => { console.warn("KB Core:", err); return { warmup: [], rounds: [], cooldown: [] }; });
    return workoutPromise;
  };

  window.showView = function (id) {
    document.querySelectorAll("section").forEach(section => section.classList.add("hidden"));
    const next = document.getElementById(id);
    if (next) next.classList.remove("hidden");
  };

  function fmt(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function totalSeconds() {
    const n = KB.queue.length;
    const s = KB.settings;
    return s.prep + n * s.work + Math.max(0, n - 1) * s.rest;
  }
  function updateTotal() { setText("#total-duration", fmt(totalSeconds())); }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(KB.settings)); } catch (_) {} }
  function syncSettings() {
    Object.keys(defaults).forEach(name => {
      const input = $(`#set-${name}`);
      const out = $(`#set-${name}-out`);
      if (input) input.value = KB.settings[name];
      if (out) out.value = KB.settings[name];
    });
    updateTotal();
  }
  function notifyQueue() { if (typeof KB.onQueueChange === "function") KB.onQueueChange(); }
  function notifyTick() { if (typeof KB.onTick === "function") KB.onTick(); }

  async function rebuildQueue() {
    const [plan, exercises] = await Promise.all([loadWorkout(), KB.loadExercises()]);
    const catalogue = new Map(exercises.map(ex => [ex.id, ex]));
    const add = (item, block, round) => {
      const ex = catalogue.get(item.id) || {};
      KB.queue.push({ id: item.id, name: ex.name || item.id, mode: ex.mode || "bilateral",
        cue: item.cue || ex.cue || "", stop: item.stop || ex.stop || "", block, round,
        video: ex.video || `media/${item.id}.mp4`, poster: ex.poster || `media/${item.id}.jpg` });
    };
    KB.queue = [];
    (plan.warmup || []).forEach(item => add(item, "Warm-up", 0));
    for (let round = 1; round <= KB.settings.rounds; round++) (plan.rounds || []).forEach(item => add(item, "Main", round));
    (plan.cooldown || []).forEach(item => add(item, "Cool-down", 0));
    KB.currentIndex = 0;
    updateTotal();
    notifyQueue();
    return KB.queue;
  }

  let audio = null, wakeLock = null;
  function beep(freq, dur = .12, delay = 0, vol = .25) {
    if (!audio || audio.state === "closed") return;
    try {
      const time = audio.currentTime + delay, oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.frequency.value = freq; oscillator.type = "sine";
      gain.gain.setValueAtTime(.0001, time); gain.gain.exponentialRampToValueAtTime(vol, time + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, time + dur);
      oscillator.connect(gain).connect(audio.destination); oscillator.start(time); oscillator.stop(time + dur + .02);
    } catch (_) {}
  }
  const sounds = { work: () => { beep(880, .14); beep(1320, .18, .15); }, rest: () => beep(420, .25), tick: () => beep(660, .06), switch: () => { beep(1040, .09); beep(1040, .09, .14); }, done: () => { beep(660, .12); beep(880, .12, .15); beep(1320, .25, .3); } };
  function say(text) {
    try { if ("speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } } catch (_) {}
  }
  async function lockScreen() {
    if (!("wakeLock" in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); }
    catch (_) { wakeLock = null; }
  }
  function releaseLock() { if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; } }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer.running && !timer.paused) lockScreen();
  });

  // A segment duration may be adjusted, but position always comes from t0.
  const timer = { segments: [], index: 0, t0: 0, raf: 0, running: false, paused: false, pauseAt: 0, lastSecond: null, switched: false, startedAt: 0 };
  const segmentStart = index => timer.segments.slice(0, index).reduce((sum, segment) => sum + segment.duration, 0);
  function makeSegments() {
    const segments = [];
    if (KB.settings.prep > 0) segments.push({ type: "prep", duration: KB.settings.prep, exerciseIndex: 0 });
    KB.queue.forEach((_, index) => {
      segments.push({ type: "work", duration: KB.settings.work, exerciseIndex: index });
      if (index < KB.queue.length - 1) segments.push({ type: "rest", duration: KB.settings.rest, exerciseIndex: index });
    });
    return segments;
  }
  function currentExercise() { return KB.queue[timer.segments[timer.index]?.exerciseIndex || 0] || null; }
  function loadClip(exercise) {
    const video = $("#vid");
    if (!video || !exercise) return;
    video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
    if (video.dataset.exercise !== exercise.id) {
      video.dataset.exercise = exercise.id; video.src = exercise.video; video.poster = exercise.poster; video.load();
    }
    video.play().catch(() => {});
  }
  function renderSegment(announce = true) {
    const segment = timer.segments[timer.index];
    if (!segment) return;
    const ex = currentExercise();
    KB.currentIndex = segment.exerciseIndex;
    timer.switched = false; timer.lastSecond = null;
    const phase = segment.type === "prep" ? "GET READY" : segment.type.toUpperCase();
    setText("#phase", phase);
    setText("#ex-name", ex?.name || ""); setText("#name", ex?.name || "");
    setText("#ex-cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    setText("#cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    const stop = segment.type === "work" ? ex?.stop : "";
    setText("#ex-stop", stop ? `Stop if: ${stop}` : ""); setText("#stopcue", stop ? `Stop if: ${stop}` : "");
    const side = ex?.mode === "unilateral_split" && segment.type !== "rest" ? "LEFT SIDE" : "";
    setText("#ex-side", side); setText("#side", side);
    const next = segment.type === "rest" ? KB.queue[segment.exerciseIndex + 1] : KB.queue[segment.exerciseIndex + 1];
    setText("#up-next", next?.name || "Last interval"); setText("#next", next ? `Next: ${next.name}` : "Last interval");
    if (ex) loadClip(segment.type === "rest" ? (next || ex) : ex);
    const run = $("#view-run") || $("#run"); if (run) run.dataset.phase = segment.type;
    document.body.className = segment.type;
    if (announce) {
      if (segment.type === "work") { sounds.work(); say(ex?.name || "Work"); }
      else if (segment.type === "rest") { sounds.rest(); say("Rest"); }
      else say(`Get ready. ${ex?.name || ""}`);
    }
    notifyTick();
  }
  function renderFrame(now) {
    if (timer.paused) return;
    const segment = timer.segments[timer.index];
    if (!segment) return finish(true);
    const elapsed = (now - timer.t0) / 1000;
    const inSegment = elapsed - segmentStart(timer.index);
    const left = segment.duration - inSegment;
    if (left <= 0) { moveTo(timer.index + 1, now); return; }
    const whole = Math.ceil(left);
    if (whole !== timer.lastSecond) {
      timer.lastSecond = whole; setText("#clock", fmt(whole));
      if (whole <= 3 && segment.type !== "prep") sounds.tick();
    }
    if (segment.type === "work" && !timer.switched && currentExercise()?.mode === "unilateral_split" && inSegment >= segment.duration / 2) {
      timer.switched = true; sounds.switch(); say("Switch sides"); setText("#ex-side", "RIGHT SIDE"); setText("#side", "RIGHT SIDE");
    }
    const pct = Math.max(0, Math.min(100, (inSegment / segment.duration) * 100));
    const bar = $("#progress-bar") || $("#barfill"); if (bar) bar.style.width = `${pct}%`;
    const text = `${Math.min(KB.currentIndex + 1, KB.queue.length)} / ${KB.queue.length}${currentExercise()?.round ? ` · Round ${currentExercise().round}/${KB.settings.rounds}` : ""}`;
    setText("#prog-text", text); setText("#prog", text);
    timer.raf = requestAnimationFrame(renderFrame);
  }
  function moveTo(target, now = performance.now()) {
    if (!timer.running) return;
    if (target >= timer.segments.length) return finish(true);
    target = Math.max(0, target);
    timer.index = target;
    // Reposition the single origin at the start of the requested segment.
    const anchor = timer.paused ? timer.pauseAt : now;
    timer.t0 = anchor - segmentStart(target) * 1000;
    renderSegment();
    if (timer.paused) setText("#clock", fmt(timer.segments[target].duration));
    else renderFrame(now);
  }
  function setPaused(value) {
    if (!timer.running || timer.paused === value) return;
    timer.paused = value;
    const pause = $("#btn-pause"); if (pause) pause.textContent = value ? "Resume" : "Pause";
    const oldPause = $("#paused"); if (oldPause) oldPause.classList.toggle("hidden", !value);
    if (value) {
      timer.pauseAt = performance.now(); cancelAnimationFrame(timer.raf); $("#vid")?.pause();
      try { speechSynthesis.cancel(); } catch (_) {}
    } else {
      timer.t0 += performance.now() - timer.pauseAt; // preserve elapsed time exactly
      $("#vid")?.play().catch(() => {}); lockScreen(); timer.raf = requestAnimationFrame(renderFrame);
    }
  }
  function nudge(seconds) {
    if (!timer.running) return;
    const now = timer.paused ? timer.pauseAt : performance.now(), segment = timer.segments[timer.index];
    const elapsed = (now - timer.t0) / 1000, before = segmentStart(timer.index);
    const elapsedHere = Math.max(0, elapsed - before);
    segment.duration = Math.max(elapsedHere + 1, segment.duration + seconds);
    // Recalculate t0 from the same elapsed position; it remains the only clock origin.
    timer.t0 = now - (segmentStart(timer.index) + elapsedHere) * 1000;
    if (timer.paused) setText("#clock", fmt(segment.duration - elapsedHere));
    else renderFrame(now);
  }
  function finish(completed) {
    if (!timer.running) return;
    cancelAnimationFrame(timer.raf); timer.running = false; timer.paused = false; releaseLock();
    if (completed) {
      sounds.done(); say("Workout complete");
      // t0 has already been shifted for pauses, skips, and nudges, so this is
      // active session time rather than wall-clock time spent on the pause screen.
      const durationSec = Math.max(0, Math.round((performance.now() - timer.t0) / 1000));
      const entry = { date: new Date().toISOString(), durationSec, intensity: { ...KB.settings } };
      try { const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); history.unshift(entry); localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30))); } catch (_) {}
      renderHistory(); setText("#done-summary", `${KB.queue.length} intervals · ${fmt(durationSec)}`); setText("#donesub", `${KB.queue.length} intervals · ${fmt(durationSec)}`);
      if ($("#view-done")) showView("view-done"); else { $("#run")?.classList.add("hidden"); $("#done")?.classList.remove("hidden"); }
    } else if ($("#view-home")) showView("view-home");
    else { $("#run")?.classList.add("hidden"); $("#start")?.classList.remove("hidden"); }
  }
  async function start() {
    // These must be fire-and-forget: a blocked audio resume must never deaden Start.
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); audio.resume().then(() => beep(880, .08)).catch(() => {}); } catch (_) { audio = null; }
    lockScreen();
    if (!KB.queue.length) await rebuildQueue();
    if (!KB.queue.length) return;
    timer.segments = makeSegments(); timer.index = 0; timer.t0 = performance.now(); timer.startedAt = timer.t0;
    timer.running = true; timer.paused = false;
    if ($("#view-run")) showView("view-run"); else { $("#start")?.classList.add("hidden"); $("#run")?.classList.remove("hidden"); }
    renderSegment(false); timer.raf = requestAnimationFrame(renderFrame);
  }
  function renderHistory() {
    const list = $("#history-list"); if (!list) return;
    let history = []; try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (_) {}
    list.replaceChildren(...history.map(item => { const li = document.createElement("li"), d = new Date(item.date); li.textContent = `${d.toLocaleDateString()} · ${fmt(item.durationSec)} · ${item.intensity?.rounds || "?"} rounds`; return li; }));
    if (!history.length) list.textContent = "No completed workouts yet.";
  }
  function wire(selector, handler) { const el = $(selector); if (el) el.addEventListener("click", handler); }
  function init() {
    Object.keys(defaults).forEach(name => {
      const input = $(`#set-${name}`); if (!input) return;
      input.min = LIMITS[name][0]; input.max = LIMITS[name][1]; input.value = KB.settings[name];
      input.addEventListener("input", () => { KB.settings[name] = clamp(name, input.value); input.value = KB.settings[name]; saveSettings(); syncSettings(); rebuildQueue(); });
    });
    syncSettings(); rebuildQueue(); renderHistory();
    wire("#btn-start", start); wire("#go", start);
    wire("#btn-pause", () => setPaused(!timer.paused)); wire("#resume", () => setPaused(false));
    wire("#btn-skip", () => moveTo(timer.index + 1)); wire("#btn-prev", () => moveTo(timer.index - 1));
    wire("#btn-plus30", () => nudge(30)); wire("#btn-minus10", () => nudge(-10));
    wire("#btn-end", () => { if (window.confirm("End this workout?")) finish(false); });
    wire("#quit", () => { if (window.confirm("End this workout?")) finish(false); });
    wire("#btn-home", () => showView("view-home")); wire("#again", () => { if ($("#view-home")) showView("view-home"); else { $("#done")?.classList.add("hidden"); $("#start")?.classList.remove("hidden"); } });
    wire("#tapzone", () => setPaused(!timer.paused));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
}());
