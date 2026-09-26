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
  function equipmentOf(exercise) {
    return (exercise && exercise.equipment) || "kettlebell";
  }
  KB.matchesEquipment = function (exercise) {
    return KB.equipment === "both" || equipmentOf(exercise) === KB.equipment;
  };
  function makeQueueExercise(exercise, block, round, finisher) {
    return { id: exercise.id, name: exercise.name || exercise.id, mode: exercise.mode || "bilateral",
      modeLabel: exercise.modeLabel || "", cue: exercise.cue || "", stop: exercise.stop || "",
      steps: Array.isArray(exercise.steps) ? exercise.steps : [], focus: Array.isArray(exercise.focus) ? exercise.focus : [],
      sourceUrl: exercise.sourceUrl || "", sourceTitle: exercise.sourceTitle || "",
      sourceChannel: exercise.sourceChannel || "", sourceStart: exercise.sourceStart,
      block, round, finisher: Boolean(finisher), video: exercise.video || `media/${exercise.id}.mp4`, poster: exercise.poster || `media/${exercise.id}.jpg` };
  }
  function sourceInfo(exercise) {
    const plain = String(exercise?.sourceUrl || "");
    if (!plain) return null;
    let href = plain;
    const seconds = Number(exercise?.sourceStart);
    const hasTimestamp = Number.isFinite(seconds) && seconds >= 0;
    try {
      const url = new URL(plain);
      // Source chapters can come from a YouTube Short. The requested affordance
      // is always the canonical watch URL so timestamps work consistently.
      const shortId = url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1];
      if (shortId) { url.pathname = "/watch"; url.search = `?v=${encodeURIComponent(shortId)}`; }
      if (hasTimestamp) url.searchParams.set("t", `${Math.floor(seconds)}s`);
      href = url.toString();
    } catch (_) { return null; }
    return { href, seconds: hasTimestamp ? Math.floor(seconds) : null,
      title: exercise?.sourceTitle || "Original video", channel: exercise?.sourceChannel || "" };
  }
  KB.sourceInfo = sourceInfo;
  /* ---------------------------------------------------------------------------
   * Goal-directed selection (KB Core v3 — core-focused 70.3 block).
   *
   * The old selector took a contiguous window off the head of an order-sorted
   * list, so it served the standing kettlebell moves (shoulders/power) first and
   * left most of the library — and almost all the core work — unreachable
   * (Main was 67% core / 3 qualities; upper-abs 0-of-16, lower-abs 2-of-35).
   *
   * This replaces it with a seeded, weighted, coverage-aware sampler that builds
   * a core-DOMINANT session: braces first, overhead/power rare 30 days out, every
   * move reachable across sessions, stable within a running session, varied to the
   * next. It is a pure function of its inputs + seed (see buildSession), so it can
   * be regenerated identically and checked headlessly.
   * ------------------------------------------------------------------------- */
  const CORE_TAGS = ["anti-extension", "anti-rotation", "anti-lateral-flexion", "obliques", "upper-abs", "lower-abs"];
  const BRACE_TAGS = ["anti-extension", "anti-rotation", "anti-lateral-flexion"];
  const CORE_SET = new Set(CORE_TAGS);
  const BRACE_SET = new Set(BRACE_TAGS);
  // Bracing family first: anti-* transfers to holding aero on the bike and posture
  // on a fatigued run. anti-* > obliques > the flexion abs.
  const TAG_PRIORITY = ["anti-extension", "anti-rotation", "anti-lateral-flexion", "obliques", "lower-abs", "upper-abs"];
  // High-fatigue / high-skill loaded moves to keep rare in the Main block close to
  // a race. Matched by id so exercises.json is never touched; power-tagged moves
  // are de-emphasised too. They stay in the library and are welcome in warm-up.
  const HEAVY_ID = /(swing|windmill|overhead|atlas|snatch|jerk|clean)/i;
  const SEED_KEY = "kb-core-seed-v1";

  function focusList(exercise) { return Array.isArray(exercise && exercise.focus) ? exercise.focus : []; }
  function coreTagsOf(exercise) { return focusList(exercise).filter(tag => CORE_SET.has(tag)); }
  function isCore(exercise) { return focusList(exercise).some(tag => CORE_SET.has(tag)); }
  function isBrace(exercise) { return focusList(exercise).some(tag => BRACE_SET.has(tag)); }
  function isShoulderPower(exercise) { return focusList(exercise).some(tag => tag === "shoulders" || tag === "power"); }
  // The capped set (req #2): a move whose ONLY core tag co-occurs with shoulders/power
  // — pressing/overhead work that barely counts as core (e.g. Overhead Press). A plank
  // that also lists shoulders but carries multiple core qualities is genuine bracing
  // work, not counted here, so the anti-* family the race wants is never capped out.
  function isShoulderPowerOnlyCore(exercise) { return isShoulderPower(exercise) && coreTagsOf(exercise).length === 1; }
  function isHeavy(exercise) { return focusList(exercise).includes("power") || HEAVY_ID.test(String((exercise && exercise.id) || "")); }

  // Deterministic PRNG: a session is stable across reloads (same seed) but the next
  // session (next seed) differs. xmur3 hashes the seed string, mulberry32 streams.
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return function () { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return h >>> 0; };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rngFrom(parts) { return mulberry32(xmur3(parts.join("|"))()); }

  // Efraimidis-Spirakis weighted sampling without replacement: key = u^(1/w),
  // larger key first. Any positive weight keeps a move reachable at some rank, so
  // across seeds the union of picks covers the whole library.
  function weightedOrder(items, weightFn, rng) {
    return items.map(exercise => {
      const weight = Math.max(weightFn(exercise), 1e-6);
      const u = rng() || 1e-12;
      return { exercise, key: Math.pow(u, 1 / weight) };
    }).sort((a, b) => b.key - a.key || byOrder(a.exercise, b.exercise)).map(entry => entry.exercise);
  }

  /* Weights are a SOFT prior only. The hard guarantees come from pickMain's caps
   * (≥80% core, shoulder/power ≤⅓, heavy ≤1) and Phase-A coverage — so the ranges
   * below are deliberately compressed (≈2-3× spread within a block) to keep two
   * consecutive sessions from converging on the same high-weight moves. */
  function mainWeight(exercise) {
    if (!isCore(exercise)) return 0.05;               // non-core: near-absent from Main (the cap enforces the 80% floor)
    let weight = 1;                                    // spread across ALL core so consecutive sessions diverge as much as the library allows
    if (isShoulderPowerOnlyCore(exercise)) weight *= 0.5;   // pressing-type, incidental core — de-emphasised and hard-capped
    if (isBrace(exercise)) weight *= 1.15;           // gentle bracing bias for the race (kept mild to preserve variety)
    if (isHeavy(exercise)) weight *= 0.3;            // race-aware de-emphasis (also hard-capped to ≤1)
    return weight;
  }
  // Warm-up / cool-down carry only a light prior (position, keep-pure-core-for-Main,
  // route-heavy-here) — kept gentle so these blocks stay near-uniform and don't
  // recur move-for-move between sessions.
  function warmupWeight(exercise) {
    let weight = 1;                                   // floor stays viable so bodyweight (≈no standing) can still warm up
    const position = exercise && exercise.position;
    if (position === "standing") weight *= 1.5;
    else if (position === "kneeling") weight *= 1.25;
    else if (position === "plank") weight *= 0.9;
    if (isHeavy(exercise)) weight *= 1.25;           // route swings/overhead into warm-up, out of Main
    if (isCore(exercise) && !isShoulderPower(exercise)) weight *= 0.5;  // keep pure core for Main → warm-up draws a mostly-disjoint sub-pool
    return weight;
  }
  function cooldownWeight(exercise) {
    let weight = 1;
    const position = exercise && exercise.position;
    if (position === "floor") weight *= 1.4; else if (position === "standing") weight *= 0.7;
    if (isBrace(exercise)) weight *= 1.1;            // finish on stabilising brace work
    if (isHeavy(exercise)) weight *= 0.5;
    return weight;
  }
  function finisherWeight(exercise) {
    if (!isCore(exercise)) return 0.02;
    let weight = 3;
    if (intensityOf(exercise) >= 2) weight *= 1.8;
    if (isBrace(exercise)) weight *= 1.3;
    if (isHeavy(exercise)) weight *= 0.2;
    return weight;
  }

  // Weighted unique draw for warm-up / cool-down / finisher. Never repeats: if the
  // eligible pool is smaller than the requested block, the block is simply shorter
  // (a thin focus filter must not pad by cycling the same 1-3 moves).
  function drawUnique(pool, count, weightFn, rng, used) {
    const chosen = [];
    if (count < 1 || !pool.length) return chosen;
    const ordered = weightedOrder(pool.filter(exercise => !used.has(exercise.id)), weightFn, rng);
    for (const exercise of ordered) {
      if (chosen.length >= count) break;
      chosen.push(exercise); used.add(exercise.id);
    }
    return chosen;
  }

  // The Main block: core-dominant, ≥4 distinct core qualities, overhead/power capped.
  function pickMain(pool, count, rng, used) {
    if (count < 1 || !pool.length) return [];
    const ordered = weightedOrder(pool.filter(exercise => !used.has(exercise.id)), mainWeight, rng);
    const chosen = [], ids = new Set(), tags = new Set();
    let nonCore = 0, shoulderPower = 0, heavy = 0;
    const maxNonCore = Math.max(0, count - Math.ceil(count * 0.8));  // ≥80% of Main carries a core tag
    const maxShoulderPower = Math.max(1, Math.round(count / 3));     // incidental shoulder/power core ≤ ~a third
    const maxHeavy = 1;                                              // race-aware: at most one loaded move in Main
    const canAdd = (exercise) => {
      if (ids.has(exercise.id)) return false;
      if (!isCore(exercise) && nonCore >= maxNonCore) return false;
      if (isShoulderPowerOnlyCore(exercise) && shoulderPower >= maxShoulderPower) return false;
      if (isHeavy(exercise) && heavy >= maxHeavy) return false;
      return true;
    };
    const take = (exercise) => {
      chosen.push(exercise); ids.add(exercise.id); used.add(exercise.id);
      if (!isCore(exercise)) nonCore++; else coreTagsOf(exercise).forEach(tag => tags.add(tag));
      if (isShoulderPowerOnlyCore(exercise)) shoulderPower++;
      if (isHeavy(exercise)) heavy++;
    };
    // Phase A — guarantee distinct core qualities, bracing family first.
    for (const tag of TAG_PRIORITY) {
      if (chosen.length >= count || tags.size >= Math.min(count, 6)) break;
      if (tags.has(tag)) continue;
      const candidate = ordered.find(exercise => canAdd(exercise) && coreTagsOf(exercise).includes(tag));
      if (candidate) take(candidate);
    }
    // Phase B — fill by weighted order, honouring the caps.
    for (const exercise of ordered) {
      if (chosen.length >= count) break;
      if (canAdd(exercise)) take(exercise);
    }
    // Phase C — caps left us short (small pool): relax caps, keep uniqueness.
    for (const exercise of ordered) {
      if (chosen.length >= count) break;
      if (!ids.has(exercise.id)) take(exercise);
    }
    // No padding: when the (focus-filtered) pool is genuinely smaller than the block
    // the Main block is simply SHORTER. A move never repeats to fill slots — a thin
    // focus yields a coherent short session, not the same 2-3 moves cycled ~20x.
    return chosen;
  }

  function isEligibleFor(exercise, equipment, intensity) {
    if (!exercise || !exercise.id) return false;
    const mode = equipmentOf(exercise);
    if (!(equipment === "both" || mode === equipment)) return false;
    if (intensity === "easy" && intensityOf(exercise) === 3) return false;
    return true;
  }
  function focusMatches(exercise, focus) {
    return !focus.length || (Array.isArray(exercise.focus) && exercise.focus.some(tag => focus.includes(tag)));
  }

  /* Focus-chip availability — the single source of truth shared by renderFocus and
   * the verifier. A tag is SELECTABLE iff at least one exercise clears the EXACT gate
   * buildSession uses (isEligibleFor: equipment + intensity), so a chip shown normal
   * always yields a real, non-empty session and a tag with nothing in the current mode
   * is shown disabled with an honest hint — never tappable-and-empty. The chip SET is
   * the whole library's tag list (mode-independent), so a tag is never silently hidden;
   * only its enabled/disabled state changes when you switch mode or intensity. */
  function focusCatalog(exercises) {
    return [...new Set((Array.isArray(exercises) ? exercises : [])
      .flatMap(exercise => Array.isArray(exercise.focus) ? exercise.focus : []))]
      .sort((a, b) => a.localeCompare(b));
  }
  function focusAvailability(exercises, options) {
    const opts = options || {};
    const equipment = ["kettlebell", "bodyweight", "both"].includes(opts.equipment) ? opts.equipment : KB.equipment;
    const intensity = ["easy", "standard", "hard"].includes(opts.intensity) ? opts.intensity : KB.intensity;
    const list = Array.isArray(exercises) ? exercises : [];
    const hasTag = (eq, inten, tag) => list.some(e => isEligibleFor(e, eq, inten) && Array.isArray(e.focus) && e.focus.includes(tag));
    const countTag = (eq, inten, tag) => list.reduce((n, e) => n + (isEligibleFor(e, eq, inten) && Array.isArray(e.focus) && e.focus.includes(tag) ? 1 : 0), 0);
    return focusCatalog(list).map(tag => {
      const count = countTag(equipment, intensity, tag);
      const selectable = count > 0;
      let hint = "";
      if (!selectable) {
        // Where CAN these moves be found? Guide the user, don't just hide the tag.
        if (hasTag("kettlebell", intensity, tag)) hint = "Kettlebell only";
        else if (hasTag("bodyweight", intensity, tag)) hint = "No-equipment only";
        else if (hasTag(equipment, "standard", tag) || hasTag(equipment, "hard", tag)
              || hasTag("kettlebell", "hard", tag) || hasTag("bodyweight", "hard", tag)) hint = "Needs Standard/Hard";
        else hint = "Unavailable";
      }
      return { tag, count, selectable, thin: selectable && count < 4, hint };
    });
  }
  // Drop focus selections that are dead in the given mode (never leave a hidden filter).
  function pruneFocus(focus, exercises, options) {
    const live = new Set(focusAvailability(exercises, options).filter(a => a.selectable).map(a => a.tag));
    return (Array.isArray(focus) ? focus : []).filter(tag => live.has(tag));
  }
  KB.focusCatalog = focusCatalog;
  KB.focusAvailability = focusAvailability;
  KB.pruneFocus = pruneFocus;

  // Pure, testable session builder: output depends only on its inputs + seed.
  function buildSession(exercises, plan, options) {
    const opts = options || {};
    const equipment = ["kettlebell", "bodyweight", "both"].includes(opts.equipment) ? opts.equipment : KB.equipment;
    const intensity = ["easy", "standard", "hard"].includes(opts.intensity) ? opts.intensity : KB.intensity;
    const focus = Array.isArray(opts.focus) ? opts.focus.filter(value => typeof value === "string") : [];
    const rounds = clamp("rounds", opts.rounds != null ? opts.rounds : KB.settings.rounds);
    const seed = opts.seed != null ? opts.seed : currentSeed();
    plan = plan || {};

    let pool = (Array.isArray(exercises) ? exercises : []).filter(exercise => isEligibleFor(exercise, equipment, intensity));
    if (focus.length) pool = pool.filter(exercise => focusMatches(exercise, focus));  // focus chips are a hard filter
    if (!pool.length) return [];

    const slotCount = Math.max(1, (plan.rounds || []).length || 5);
    const warmupCount = Math.min((plan.warmup || []).length || 0, pool.length);
    const cooldownCount = Math.min((plan.cooldown || []).length || 0, pool.length);
    const mainCount = slotCount * rounds;
    const key = [seed >>> 0, equipment, intensity, rounds, focus.slice().sort().join(",")].join("|");
    const used = new Set();
    const queue = [];

    // Main first so it always draws from the richest pool and its coverage is protected;
    // warm-up then absorbs the standing / overhead / power moves kept out of Main.
    const main = pickMain(pool, mainCount, rngFrom([key, "main"]), used);
    const warmup = drawUnique(pool, warmupCount, warmupWeight, rngFrom([key, "warmup"]), used);
    const cooldown = drawUnique(pool, cooldownCount, cooldownWeight, rngFrom([key, "cooldown"]), used);
    const finisher = intensity === "hard" ? (drawUnique(pool, 1, finisherWeight, rngFrom([key, "finisher"]), used)[0] || null) : null;

    warmup.forEach(exercise => queue.push(makeQueueExercise(exercise, "Warm-up", 0)));
    for (let round = 1; round <= rounds; round++) {
      main.slice((round - 1) * slotCount, round * slotCount)
        .forEach(exercise => queue.push(makeQueueExercise(exercise, "Main", round)));
    }
    if (finisher) queue.push(makeQueueExercise(finisher, "Finisher", rounds + 1, true));
    cooldown.forEach(exercise => queue.push(makeQueueExercise(exercise, "Cool-down", 0)));
    return queue;
  }
  KB.buildSession = buildSession;

  // Rotating seed: stable within a session (persisted), advanced on regenerate.
  function currentSeed() {
    let raw = null;
    try { raw = localStorage.getItem(SEED_KEY); } catch (_) {}
    let n = parseInt(raw, 10);
    if (!Number.isFinite(n)) { n = daySeed(); try { localStorage.setItem(SEED_KEY, String(n)); } catch (_) {} }
    return n >>> 0;
  }
  function bumpSeed() {
    const n = (currentSeed() + 1) >>> 0;
    try { localStorage.setItem(SEED_KEY, String(n)); } catch (_) {}
    return n;
  }
  function daySeed() {
    try { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) >>> 0; }
    catch (_) { return 1; }
  }
  KB.currentSeed = currentSeed; KB.bumpSeed = bumpSeed;

  function generatedQueue(exercises, plan) {
    return buildSession(exercises, plan, {
      equipment: KB.equipment, intensity: KB.intensity, focus: KB.focus,
      rounds: KB.settings.rounds, seed: currentSeed()
    });
  }
  function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify(KB.queue)); } catch (_) {} }
  function restoreSession(exercises) {
    let savedSession = null;
    try { savedSession = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (_) {}
    if (!Array.isArray(savedSession)) return false;
    const catalogue = new Map(exercises.map(exercise => [exercise.id, exercise]));
    // A stored custom session must obey the current equipment gate too.
    if (savedSession.some(item => !catalogue.has(item?.id) || !KB.matchesEquipment(catalogue.get(item.id)))) return false;
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
    // A forced regenerate advances the rotating seed so the next session differs;
    // a plain reload takes the restore path above and keeps the running queue stable.
    if (options.force) bumpSeed();
    KB.queue = generatedQueue(exercises, plan);
    KB.currentIndex = 0; saveSettings(); saveSession(); syncSettings();
    updateTotal(); updateBuilderTotal(); notifyQueue(); renderBuilder();
    return KB.queue;
  }

  function titleCase(value) { return String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
  KB.titleCase = titleCase;
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
    const gate = { equipment: KB.equipment, intensity: KB.intensity };
    const availability = focusAvailability(list, gate);
    // Drop any selection that went dead in the current mode so no invisible filter
    // silently narrows the session; persist so the dropped chip never comes back.
    const pruned = pruneFocus(KB.focus, list, gate);
    if (pruned.length !== KB.focus.length) { KB.focus = pruned; saveSettings(); }
    // Honest count: eligible moves matching the current selection, over the pool total.
    const pool = list.filter(exercise => isEligibleFor(exercise, KB.equipment, KB.intensity));
    const matched = pool.filter(exercise => focusMatches(exercise, KB.focus)).length;
    setText("#focus-count", KB.focus.length ? `${matched} of ${pool.length} moves` : `${pool.length} moves`);
    const modeLabel = KB.equipment === "bodyweight" ? "No-equipment" : titleCase(KB.equipment);
    // Short-session note when the active selection can't fill a full block (1-3 moves).
    const note = $("#focus-note");
    if (note) {
      if (KB.focus.length && matched > 0 && matched < 4) {
        note.textContent = `Short focused session — only ${matched} matching move${matched === 1 ? "" : "s"} in ${modeLabel} mode. Slots won't repeat to pad it out.`;
        note.hidden = false;
      } else { note.textContent = ""; note.hidden = true; }
    }
    if (!container) return;
    container.replaceChildren();
    availability.forEach(({ tag, count, selectable, thin, hint }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.focus = tag;
      button.className = "chip" + (selectable ? (thin ? " chip--thin" : "") : " chip--disabled");
      const label = document.createElement("span");
      label.className = "chip__label"; label.textContent = titleCase(tag);
      button.appendChild(label);
      if (selectable) {
        button.setAttribute("aria-pressed", String(KB.focus.includes(tag)));
        if (thin) {
          const badge = document.createElement("span");
          badge.className = "chip__badge"; badge.textContent = String(count); badge.setAttribute("aria-hidden", "true");
          button.appendChild(badge);
          button.setAttribute("aria-label", `${titleCase(tag)} — only ${count} move${count === 1 ? "" : "s"} in ${modeLabel} mode (short session)`);
        }
      } else {
        // Visibly unavailable, not hidden: user learns the tag lives elsewhere.
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.setAttribute("aria-pressed", "false");
        const tagHint = document.createElement("span");
        tagHint.className = "chip__hint"; tagHint.textContent = hint; tagHint.setAttribute("aria-hidden", "true");
        button.appendChild(tagHint);
        button.setAttribute("aria-label", `${titleCase(tag)} — unavailable in ${modeLabel} mode (${hint})`);
      }
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
    setText("#builder-count", `${KB.queue.length} moves`);
    if ($("#btn-start")) $("#btn-start").disabled = !KB.queue.length;
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
      actions.querySelector('[data-action="up"]').disabled = index === 0;
      actions.querySelector('[data-action="down"]').disabled = index === KB.queue.length - 1;
      row.append(handle, name, meta, actions); list.appendChild(row);
    });
  }
  async function renderPicker() {
    const picker = $("#builder-picker");
    if (!picker) return;
    const exercises = await KB.loadExercises();
    if (!Array.isArray(exercises)) return;
    picker.replaceChildren();
    const pool = exercises.filter(KB.matchesEquipment).sort(byOrder);
    setText("#picker-count", `${pool.length} moves`);
    picker.dataset.swapping = String(Number.isInteger(pickerSwapIndex));
    pool.forEach(exercise => {
      const item = document.createElement("button"); item.type = "button"; item.className = "picker-item"; item.dataset.exerciseId = exercise.id || "";
      item.textContent = cleanText(`${exercise.name || exercise.id || "Exercise"}${exercise.modeLabel ? ` · ${exercise.modeLabel}` : ""}`);
      picker.appendChild(item);
    });
    picker.hidden = false;
    picker.scrollTop = 0;
    picker.scrollIntoView({ block: "center" });
  }
  function closePicker() { const picker = $("#builder-picker"); if (picker) picker.hidden = true; pickerSwapIndex = null; }
  async function addPickerExercise(id) {
    const exercises = await KB.loadExercises();
    if (!Array.isArray(exercises)) return;
    const exercise = exercises.find(item => item.id === id);
    if (!exercise || !KB.matchesEquipment(exercise)) return;
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
    wire("#btn-regenerate", () => { closePicker(); rebuildQueue({ force: true }); });
    wire("#btn-builder-back", () => { closePicker(); showView("view-home"); });
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
  const timer = { segments: [], index: 0, t0: 0, raf: 0, running: false, paused: false, pauseAt: 0, lastSecond: null, switched: false, startedAt: 0, pausedMs: 0 };
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
    video.autoplay = !timer.paused; video.loop = true; video.muted = true; video.playsInline = true;
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
    if (timer.paused) video.pause();
    else video.play().catch(() => {});
  }
  function formatSourceTime(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function renderRunExerciseDetails(exercise) {
    const steps = $("#ex-steps");
    if (steps) {
      steps.replaceChildren();
      (Array.isArray(exercise?.steps) ? exercise.steps : []).slice(0, 4).forEach(step => {
        const item = document.createElement("li"); item.textContent = cleanText(step); steps.appendChild(item);
      });
    }
    const targets = $("#ex-focus");
    if (targets) {
      targets.replaceChildren();
      (Array.isArray(exercise?.focus) ? exercise.focus : []).forEach(focus => {
        const tag = document.createElement("span");
        tag.className = `focus-tag focus-tag--${focus}`;
        tag.textContent = titleCase(focus); targets.appendChild(tag);
      });
    }
    const source = $("#ex-source");
    if (source) {
      source.replaceChildren();
      const info = sourceInfo(exercise);
      if (!info) { source.hidden = true; return; }
      const link = document.createElement("a");
      link.href = info.href; link.target = "_blank"; link.rel = "noopener";
      link.className = "run__source-link";
      link.setAttribute("aria-label", `Watch original: ${info.title}${info.seconds === null ? "" : ` at ${formatSourceTime(info.seconds)}`}`);
      const icon = document.createElement("span"); icon.className = "run__source-icon"; icon.textContent = "↗"; icon.setAttribute("aria-hidden", "true"); link.appendChild(icon);
      const label = document.createElement("span"); label.className = "run__source-label"; label.textContent = "Source"; link.appendChild(label);
      const meta = [info.channel, info.title, info.seconds === null ? "" : formatSourceTime(info.seconds)].filter(Boolean).join(" · ");
      const metaNode = document.createElement("span"); metaNode.className = "run__source-meta"; metaNode.textContent = cleanText(meta); link.appendChild(metaNode);
      source.appendChild(link); source.hidden = false;
    }
  }
  function renderSegment(announce = true) {
    const segment = timer.segments[timer.index];
    if (!segment) return;
    const ex = currentExercise();
    KB.currentIndex = segment.exerciseIndex;
    const progressText = `${KB.currentIndex + 1} / ${KB.queue.length}${ex?.round ? ` · Round ${ex.round}/${KB.settings.rounds}` : ""}`;
    setText("#prog-text", progressText);
    const progress = $("#progress-bar");
    if (progress) { progress.style.width = "0%"; progress.setAttribute("aria-valuenow", "0"); }
    timer.switched = false; timer.lastSecond = null;
    const phase = segment.type === "prep" ? "GET READY" : segment.type.toUpperCase();
    setText("#run-intensity", titleCase(KB.intensity));
    setText("#phase", phase);
    const demo = segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1] || ex) : ex;
    setText("#ex-name", demo?.name || ""); setText("#name", demo?.name || "");
    setText("#ex-cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    setText("#cue", segment.type === "rest" ? (KB.queue[segment.exerciseIndex + 1]?.cue || "") : (ex?.cue || ""));
    renderRunExerciseDetails(demo);
    const stop = segment.type === "work" ? ex?.stop : "";
    // #ex-stop: styles.css prepends the words "Stop if " via ::before, so set the
    // RAW string here. #stopcue is the legacy v1 node with no such rule.
    setText("#ex-stop", stop || ""); setText("#stopcue", stop ? `Stop if: ${stop}` : "");
    const side = ex?.mode === "unilateral_split" && segment.type === "work" ? "LEFT SIDE" : "";
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
    if (left <= 0) {
      // Natural transitions preserve elapsed time after a throttled tab wakes.
      do { timer.index++; } while (timer.segments[timer.index] && elapsed >= segmentStart(timer.index) + timer.segments[timer.index].duration);
      if (!timer.segments[timer.index]) return finish(true);
      renderSegment(); renderFrame(now); return;
    }
    const whole = Math.ceil(left);
    if (whole !== timer.lastSecond) {
      timer.lastSecond = whole; setText("#clock", fmt(whole));
      if (whole <= 3 && segment.type !== "prep") sounds.tick();
    }
    if (segment.type === "work" && !timer.switched && currentExercise()?.mode === "unilateral_split" && inSegment >= segment.duration / 2) {
      timer.switched = true; sounds.switch(); say("Switch sides"); setText("#ex-side", "RIGHT SIDE"); setText("#side", "RIGHT SIDE");
    }
    const pct = Math.max(0, Math.min(100, (inSegment / segment.duration) * 100));
    const bar = $("#progress-bar") || $("#barfill"); if (bar) { bar.style.width = `${pct}%`; bar.setAttribute("aria-valuenow", String(Math.round(pct))); }
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
      const pausedMs = performance.now() - timer.pauseAt;
      timer.pausedMs += pausedMs;
      timer.t0 += pausedMs; // preserve elapsed time exactly
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
    const activeMs = (timer.paused ? timer.pauseAt : performance.now()) - timer.startedAt - timer.pausedMs;
    stopTicking(); timer.running = false; timer.paused = false; releaseLock();
    $("#vid")?.pause();
    document.body.classList.remove("work", "rest", "prep");
    if (completed) {
      sounds.done(); say("Workout complete");
      // Transport edits move t0, so record active time separately from queue position.
      const durationSec = Math.max(0, Math.round(activeMs / 1000));
      const entry = { date: new Date().toISOString(), durationSec, intensity: { ...KB.settings }, intensityName: KB.intensity, equipment: KB.equipment };
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
    timer.segments = makeSegments(); timer.index = 0; timer.t0 = performance.now(); timer.startedAt = timer.t0; timer.pausedMs = 0;
    timer.running = true; timer.paused = false;
    setText("#btn-pause", "Pause");
    $(".upnext__all")?.removeAttribute("open");
    if ($("#view-run")) showView("view-run"); else { $("#start")?.classList.add("hidden"); $("#run")?.classList.remove("hidden"); }
    renderSegment(false); startTicking();
  }
  function renderHistory() {
    const list = $("#history-list"); if (!list) return;
    let history = []; try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (_) {}
    list.replaceChildren(...history.map(item => { const li = document.createElement("li"), d = new Date(item.date); li.textContent = `${d.toLocaleDateString()} · ${fmt(item.durationSec)} · ${item.intensityName ? titleCase(item.intensityName) + " · " : ""}${item.intensity?.rounds || "?"} rounds`; return li; }));
    if (!history.length) list.textContent = "No completed workouts yet.";
  }
  function wire(selector, handler) { const el = $(selector); if (el) el.addEventListener("click", handler); }
  function init() {
    Object.keys(defaults).forEach(name => {
      const input = $(`#set-${name}`); if (!input) return;
      input.min = LIMITS[name][0]; input.max = LIMITS[name][1]; input.value = KB.settings[name];
      input.addEventListener("input", () => {
        if (input.value === "") return;
        KB.settings[name] = clamp(name, input.value);
        saveSettings(); updateTotal(); updateBuilderTotal(); notifyQueue();
        if (name === "rounds") rebuildQueue({ force: true });
      });
      input.addEventListener("change", () => {
        const previous = KB.settings[name];
        KB.settings[name] = clamp(name, input.value); saveSettings(); syncSettings(); notifyQueue();
        if (name === "rounds" && previous !== KB.settings[name]) rebuildQueue({ force: true });
      });
    });
    document.querySelectorAll("#intensity button[data-intensity]").forEach(button => {
      if (button.dataset.intensity && !button.dataset.intensityWired) {
        button.dataset.intensityWired = "true";
        button.addEventListener("click", () => {
          const intensity = button.dataset.intensity;
          if (!["easy", "standard", "hard"].includes(intensity)) return;
          KB.intensity = intensity; KB.settings.rounds = intensity === "easy" ? 2 : 3;
          saveSettings(); renderIntensity();
          KB.loadExercises().then(renderFocus); rebuildQueue({ force: true });
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
        // A disabled (dead-in-this-mode) chip must never toggle a filter or build a session.
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
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
