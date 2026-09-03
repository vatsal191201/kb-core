/* KB Core timer engine.  All elapsed time is derived from timer.t0: no tick is
   accumulated, so a throttled/background tab cannot make the workout drift. */
(function () {
  "use strict";

  const SETTINGS_KEY = "kb-core-settings-v2";
  const HISTORY_KEY = "kb-core-history-v2";
  const SESSION_KEY = "kb-core-session-v3";
  const LIMITS = { work: [20, 120], rest: [10, 60], rounds: [1, 6], prep: [0, 30] };
  const defaults = { work: 60, rest: 20, rounds: 3, prep: 10 };
  const $ = (selector) => document.querySelector(selector);
  const cleanText = value => String(value == null ? "" : value).replace(/[—–]/g, "-");
  const setText = (selector, value) => { const el = $(selector); if (el) el.textContent = cleanText(value); };

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
  const saved = storedSettings();
  KB.settings = Object.fromEntries(Object.keys(defaults).map(k => [k, clamp(k, saved[k])]));
  KB.intensity = ["easy", "standard", "hard"].includes(saved.intensity) ? saved.intensity : "standard";
  KB.equipment = ["kettlebell", "bodyweight", "both"].includes(saved.equipment) ? saved.equipment : "kettlebell";
  KB.focus = Array.isArray(saved.focus) ? saved.focus.filter(value => typeof value === "string") : [];
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
    // Only toggle TOP-LEVEL views. `document.querySelectorAll("section")` also
    // matches sections nested inside a view (e.g. the video player inside
    // #view-sources) and would hide them permanently.
    document.querySelectorAll("section.view, body > section").forEach(section => section.classList.add("hidden"));
    const next = document.getElementById(id);
    if (next) next.classList.remove("hidden");
    window.scrollTo(0, 0);
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
  function updateBuilderTotal() { setText("#builder-total", fmt(totalSeconds())); }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...KB.settings, intensity: KB.intensity, equipment: KB.equipment, focus: KB.focus })); } catch (_) {}
  }
  function syncSettings() {
    Object.keys(defaults).forEach(name => {
      const input = $(`#set-${name}`);
      const out = $(`#set-${name}-out`);
      if (input) input.value = KB.settings[name];
      if (out) out.value = KB.settings[name];
    });
    updateTotal(); updateBuilderTotal();
  }
  function notifyQueue() { if (typeof KB.onQueueChange === "function") KB.onQueueChange(); }
  function notifyTick() { if (typeof KB.onTick === "function") KB.onTick(); }

  function intensityOf(exercise) {
    const explicit = Number(exercise && exercise.intensity);
    if (Number.isFinite(explicit)) return explicit;
    return exercise && exercise.level === "Advanced" ? 3 : exercise && exercise.level === "Intermediate" ? 2 : 1;
  }
  function orderOf(exercise) {
    const explicit = Number(exercise && exercise.order);
    if (Number.isFinite(explicit)) return explicit;
    return exercise && exercise.position === "floor" ? 3 : exercise && exercise.position === "standing" ? 2 : 2;
  }
  function byOrder(a, b) { return orderOf(a) - orderOf(b) || String(a.name || a.id).localeCompare(String(b.name || b.id)); }
  function matchesFocus(exercise) {
    return !KB.focus.length || (Array.isArray(exercise.focus) && exercise.focus.some(value => KB.focus.includes(value)));
  }
  function equipmentOf(exercise) {
    return (exercise && exercise.equipment) || "kettlebell";
  }
  KB.matchesEquipment = function (exercise) {
    return KB.equipment === "both" || equipmentOf(exercise) === KB.equipment;
  };
  function eligibleExercises(exercises) {
    return (Array.isArray(exercises) ? exercises : []).filter(exercise => exercise && exercise.id
      && KB.matchesEquipment(exercise)
      && (KB.intensity !== "easy" || intensityOf(exercise) !== 3));
  }
  function makeQueueExercise(exercise, block, round, finisher) {
    return { id: exercise.id, name: exercise.name || exercise.id, mode: exercise.mode || "bilateral",
      modeLabel: exercise.modeLabel || "", cue: exercise.cue || "", stop: exercise.stop || "", block, round,
      finisher: Boolean(finisher), video: exercise.video || `media/${exercise.id}.mp4`, poster: exercise.poster || `media/${exercise.id}.jpg` };
  }
  function selectExercises(pool, count, offset) {
    if (!pool.length || count < 1) return [];
    const preferred = pool.filter(matchesFocus).sort(byOrder);
    const remainder = pool.filter(exercise => !matchesFocus(exercise)).sort(byOrder);
    const candidates = (preferred.length ? preferred.concat(remainder) : remainder);
    const size = Math.min(count, candidates.length);
    const start = KB.focus.length ? 0 : (offset * size) % candidates.length;
    const unique = Array.from({ length: size }, (_, index) => candidates[(start + index) % candidates.length]);
    return unique.sort(byOrder);
  }
  function generatedQueue(exercises, plan) {
    const pool = eligibleExercises(exercises);
    const slotCount = Math.max(1, (plan.rounds || []).length || pool.length);
    const warmupCount = Math.min((plan.warmup || []).length, pool.length);
    const cooldownCount = Math.min((plan.cooldown || []).length, pool.length);
    const queue = [];
    selectExercises(pool, warmupCount, 0).forEach(exercise => queue.push(makeQueueExercise(exercise, "Warm-up", 0)));
    const rounds = KB.intensity === "easy" ? 2 : 3;
    KB.settings.rounds = rounds;
    for (let round = 1; round <= rounds; round++) {
      selectExercises(pool, slotCount, round - 1).forEach(exercise => queue.push(makeQueueExercise(exercise, "Main", round)));
    }
    if (KB.intensity === "hard") {
      const finisher = selectExercises(pool, 1, rounds)[0];
      if (finisher) queue.push(makeQueueExercise(finisher, "Finisher", rounds + 1, true));
    }
    selectExercises(pool, cooldownCount, rounds).forEach(exercise => queue.push(makeQueueExercise(exercise, "Cool-down", 0)));
    return queue;
  }
  function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify(KB.queue)); } catch (_) {} }
  function restoreSession(exercises) {
    let savedSession = null;
    try { savedSession = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (_) {}
    if (!Array.isArray(savedSession)) return false;
    const catalogue = new Map(exercises.map(exercise => [exercise.id, exercise]));
    const restored = savedSession.map(item => {
      const exercise = catalogue.get(item && item.id);
      return exercise ? { ...makeQueueExercise(exercise, item.block || "Session", Number(item.round) || 0, item.finisher), ...item, name: exercise.name || item.name || item.id } : null;
    }).filter(Boolean);
    if (!restored.length && savedSession.length) return false;
    KB.queue = restored; KB.currentIndex = 0;
    return true;
  }
  async function rebuildQueue(options = {}) {
    const [plan, exercises] = await Promise.all([loadWorkout(), KB.loadExercises()]);
    if (!options.force && restoreSession(exercises)) {
      updateTotal(); updateBuilderTotal(); notifyQueue(); renderBuilder(); return KB.queue;
    }
    KB.queue = generatedQueue(exercises, plan);
    KB.currentIndex = 0; saveSettings(); saveSession(); syncSettings();
    updateTotal(); updateBuilderTotal(); notifyQueue(); renderBuilder();
    return KB.queue;
  }

  function titleCase(value) { return String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
  function renderEquipment(exercises) {
    const list = Array.isArray(exercises) ? exercises : [];
    const counts = { kettlebell: 0, bodyweight: 0, both: list.filter(e => e && e.id).length };
    list.forEach(e => { if (e && e.id) counts[equipmentOf(e)] = (counts[equipmentOf(e)] || 0) + 1; });
    document.querySelectorAll("#equipment button[data-equipment]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.equipment === KB.equipment));
    });
    document.querySelectorAll("[data-equipment-count]").forEach(node => {
      const key = node.dataset.equipmentCount;
      node.textContent = `${counts[key] || 0} moves`;
    });
    setText("#run-equipment", KB.equipment === "bodyweight" ? "No equipment" : titleCase(KB.equipment));
  }
  KB.renderEquipment = renderEquipment;
  function renderIntensity() {
    document.querySelectorAll("#intensity button[data-intensity]").forEach(button => {
      const selected = button.dataset.intensity === KB.intensity;
      button.setAttribute("aria-pressed", String(selected));
    });
    setText("#run-intensity", titleCase(KB.intensity));
  }
  function renderFocus(exercises) {
    const container = $("#focus-chips");
    const list = Array.isArray(exercises) ? exercises : [];
    const available = [...new Set(list.flatMap(exercise => Array.isArray(exercise.focus) ? exercise.focus : []))].sort((a, b) => a.localeCompare(b));
    KB.focus = KB.focus.filter(value => available.includes(value));
    const matched = eligibleExercises(list).filter(matchesFocus).length;
    setText("#focus-count", String(matched));
    if (!container) return;
    container.replaceChildren();
    available.forEach(focus => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "chip"; button.dataset.focus = focus;
      button.textContent = titleCase(focus); button.setAttribute("aria-pressed", String(KB.focus.includes(focus)));
      container.appendChild(button);
    });
  }
  function setQueue(queue) {
    KB.queue = Array.isArray(queue) ? queue : [];
    KB.currentIndex = 0; saveSession(); updateTotal(); updateBuilderTotal(); notifyQueue(); renderBuilder();
  }
  function builderMeta(item) {
    const parts = [item.block || "Session"];
    if (item.round) parts.push(item.finisher ? "Finisher" : `Round ${item.round}`);
    if (item.modeLabel) parts.push(item.modeLabel);
    return cleanText(parts.join(" · "));
  }
  function button(label, action, index) {
    const node = document.createElement("button");
    node.type = "button"; node.className = "slot__btn"; node.dataset.action = action; node.dataset.index = String(index); node.textContent = label;
    return node;
  }
  let pickerSwapIndex = null;
  function renderBuilder() {
    const list = $("#builder-list");
    updateBuilderTotal();
    if (!list) return;
    list.replaceChildren();
    if (!KB.queue.length) { list.textContent = "No exercises selected. Add an exercise to build your session."; return; }
    KB.queue.forEach((item, index) => {
      const row = document.createElement("div"); row.className = "slot"; row.dataset.index = String(index);
      // styles.css lays .slot out as a GRID and positions .slot__handle /
      // .slot__name / .slot__meta / .slot__actions into explicit cells. Wrapping
      // name+meta in an extra unstyled <div> made them one anonymous grid item,
      // which collapsed the column and wrapped every word onto its own line.
      // Append them as DIRECT children so the grid placement applies.
      const handle = document.createElement("span"); handle.className = "slot__handle"; handle.textContent = String(index + 1);
      const name = document.createElement("span"); name.className = "slot__name"; name.textContent = cleanText(item.name || item.id || "Exercise");
      const meta = document.createElement("span"); meta.className = "slot__meta"; meta.textContent = builderMeta(item);
      const actions = document.createElement("div"); actions.className = "slot__actions";
      actions.append(button("Swap", "swap", index), button("Remove", "remove", index), button("Up", "up", index), button("Down", "down", index));
      row.append(handle, name, meta, actions); list.appendChild(row);
    });
  }
  async function renderPicker() {
    const picker = $("#builder-picker");
    if (!picker) return;
    const exercises = await KB.loadExercises();
    if (!Array.isArray(exercises)) return;
    picker.replaceChildren();
    exercises.slice().sort(byOrder).forEach(exercise => {
      const item = document.createElement("button"); item.type = "button"; item.className = "picker-item"; item.dataset.exerciseId = exercise.id || "";
      item.textContent = cleanText(`${exercise.name || exercise.id || "Exercise"}${exercise.modeLabel ? ` · ${exercise.modeLabel}` : ""}`);
      picker.appendChild(item);
    });
    picker.hidden = false;
  }
  function closePicker() { const picker = $("#builder-picker"); if (picker) picker.hidden = true; pickerSwapIndex = null; }
  async function addPickerExercise(id) {
    const exercises = await KB.loadExercises();
    if (!Array.isArray(exercises)) return;
    const exercise = exercises.find(item => item.id === id);
    if (!exercise) return;
    const queue = KB.queue.slice();
    const replacing = Number.isInteger(pickerSwapIndex) ? queue[pickerSwapIndex] : null;
    const item = makeQueueExercise(exercise, replacing?.block || "Custom", Number(replacing?.round) || 0, replacing?.finisher);
    if (replacing) queue.splice(pickerSwapIndex, 1, item);
    else queue.push(item);
    closePicker(); setQueue(queue);
  }
  function wireBuilder() {
    const list = $("#builder-list");
    if (list && !list.dataset.builderWired) {
      list.dataset.builderWired = "true";
      list.addEventListener("click", event => {
        const action = event.target.closest("button[data-action]"); if (!action) return;
        const index = Number(action.dataset.index); if (!Number.isInteger(index) || !KB.queue[index]) return;
        if (action.dataset.action === "swap") { pickerSwapIndex = index; renderPicker(); return; }
        const queue = KB.queue.slice();
        if (action.dataset.action === "remove") queue.splice(index, 1);
        if (action.dataset.action === "up" && index > 0) [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
        if (action.dataset.action === "down" && index < queue.length - 1) [queue[index + 1], queue[index]] = [queue[index], queue[index + 1]];
        setQueue(queue);
      });
    }
    const picker = $("#builder-picker");
    if (picker && !picker.dataset.builderWired) {
      picker.dataset.builderWired = "true";
      picker.addEventListener("click", event => {
        const item = event.target.closest("button.picker-item[data-exercise-id]");
        if (item) addPickerExercise(item.dataset.exerciseId);
      });
    }
    wire("#btn-add-exercise", () => { pickerSwapIndex = null; renderPicker(); });
    wire("#btn-regenerate", () => rebuildQueue({ force: true }));
    wire("#btn-builder-back", () => showView("view-home"));
    wire("#btn-edit-session", () => { renderBuilder(); showView("view-builder"); });
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
    video.setAttribute("muted", ""); video.setAttribute("playsinline", ""); video.setAttribute("preload", "auto");
    if (!video.dataset.fallbackWired) {
      video.dataset.fallbackWired = "true";
      video.addEventListener("error", () => {
        // Keep the poster visible if a future clip has not been deployed yet.
        try { video.removeAttribute("src"); video.load(); } catch (_) {}
      });
    }
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
    setText("#run-intensity", titleCase(KB.intensity));
    setText("#phase", phase);
    setText("#ex-name", ex?.name || ""); setText("#name", ex?.name || "");
    setText("#ex-cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    setText("#cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    const stop = segment.type === "work" ? ex?.stop : "";
    // #ex-stop: styles.css prepends the words "Stop if " via ::before, so set the
    // RAW string here. #stopcue is the legacy v1 node with no such rule.
    setText("#ex-stop", stop || ""); setText("#stopcue", stop ? `Stop if: ${stop}` : "");
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
  /* THE CLOCK MUST NOT DEPEND ON requestAnimationFrame ALONE.
   *
   * Reported on device: "when I start a workout, the skip, resume and pause
   * don't actually work" - the clock sat frozen. rAF is a *rendering* callback:
   * the browser stops delivering it whenever the page is not compositing (tab
   * hidden, screen dimmed, low power mode, another app in front). A workout
   * timer that stops counting when the screen dims is broken by design.
   * Confirmed here: a probe counting rAF callbacks returned ZERO frames.
   *
   * So: a setInterval heartbeat drives the clock, and every value is still
   * computed from the single performance.now() origin, so it stays
   * drift-corrected and cannot accumulate error. rAF is kept only for the
   * smooth progress bar, as a bonus when it happens to run.
   */
  function startTicking() {
    stopTicking();
    timer.tick = setInterval(() => renderFrame(performance.now()), 200);
    timer.raf = requestAnimationFrame(renderFrame);
    renderFrame(performance.now());          // paint immediately, no 200ms lag
  }
  function stopTicking() {
    clearInterval(timer.tick);
    cancelAnimationFrame(timer.raf);
  }

  function renderFrame(now) {
    // Reported on device: "the skip, resume and pause don't actually work."
    //
    // This early return used to be a bare `return`, which killed the rAF loop.
    // setPaused(false) schedules exactly ONE frame; if that frame ran while
    // timer.paused was still true (or a skip re-entered moveTo in the same
    // tick), nothing rescheduled and the clock stayed frozen forever with the
    // button reading "Pause". Keep the loop ALIVE while paused instead: cheap,
    // and it means resume can never lose the heartbeat.
    if (timer.paused) return;              // the interval keeps running; nothing to draw
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
    // Smoothness only. Correctness comes from the interval above.
    cancelAnimationFrame(timer.raf);
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
      // Do NOT cancel the rAF here; renderFrame keeps itself alive while paused
      // so resume cannot lose the heartbeat.
      timer.pauseAt = performance.now(); $("#vid")?.pause();
      try { speechSynthesis.cancel(); } catch (_) {}
    } else {
      timer.t0 += performance.now() - timer.pauseAt; // preserve elapsed time exactly
      $("#vid")?.play().catch(() => {});
      lockScreen();
      startTicking();
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
    stopTicking(); timer.running = false; timer.paused = false; releaseLock();
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
    renderSegment(false); startTicking();
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
      input.addEventListener("input", () => { KB.settings[name] = clamp(name, input.value); input.value = KB.settings[name]; saveSettings(); syncSettings(); });
    });
    document.querySelectorAll("#intensity button[data-intensity]").forEach(button => {
      if (button.dataset.intensity && !button.dataset.intensityWired) {
        button.dataset.intensityWired = "true";
        button.addEventListener("click", () => {
          const intensity = button.dataset.intensity;
          if (!["easy", "standard", "hard"].includes(intensity)) return;
          KB.intensity = intensity; saveSettings(); renderIntensity(); rebuildQueue({ force: true });
        });
      }
    });
    document.querySelectorAll("#equipment button[data-equipment]").forEach(button => {
      if (button.dataset.equipment && !button.dataset.equipmentWired) {
        button.dataset.equipmentWired = "true";
        button.addEventListener("click", () => {
          const equipment = button.dataset.equipment;
          if (!["kettlebell", "bodyweight", "both"].includes(equipment)) return;
          if (equipment === KB.equipment) return;
          KB.equipment = equipment; saveSettings();
          KB.loadExercises().then(exercises => {
            renderEquipment(exercises); renderFocus(exercises);
            rebuildQueue({ force: true });
            if (typeof KB.onEquipmentChange === "function") KB.onEquipmentChange(KB.equipment);
            document.dispatchEvent(new CustomEvent("kb:equipmentchange", { detail: KB.equipment }));
          }).catch(() => {});
        });
      }
    });
    const focusChips = $("#focus-chips");
    if (focusChips && !focusChips.dataset.focusWired) {
      focusChips.dataset.focusWired = "true";
      focusChips.addEventListener("click", event => {
        const button = event.target.closest("button[data-focus]"); if (!button || !focusChips.contains(button)) return;
        const focus = button.dataset.focus; if (!focus) return;
        KB.focus = KB.focus.includes(focus) ? KB.focus.filter(value => value !== focus) : KB.focus.concat(focus);
        saveSettings(); KB.loadExercises().then(exercises => { renderFocus(exercises); rebuildQueue({ force: true }); }).catch(() => {});
      });
    }
    syncSettings(); renderIntensity(); wireBuilder();
    KB.loadExercises().then(exercises => { renderEquipment(exercises); renderFocus(exercises); }).catch(() => {});
    rebuildQueue(); renderHistory();
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
