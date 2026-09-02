/* KB Core — interval engine.
   Timing is drift-corrected off performance.now(); never accumulates setInterval ticks. */

const EX = {
  "halo":               {name:"Kettlebell Halo",           mode:"bilateral"},
  "around-world":       {name:"Around The World",          mode:"bilateral"},
  "bird-dog":           {name:"Bird Dog",                  mode:"unilateral_split"},
  "suitcase-march":     {name:"Suitcase March",            mode:"unilateral_split"},
  "halfkneel-windmill": {name:"Half-Kneeling Windmill",    mode:"unilateral_split"},
  "overhead-march":     {name:"Overhead March",            mode:"unilateral_split"},
  "plank-pull-through": {name:"Plank Pull-Through",        mode:"bilateral"},
  "woodchop":           {name:"Half-Kneeling Woodchop",    mode:"unilateral_split"},
  "russian-twist":      {name:"Russian Twist",             mode:"bilateral"},
  "deadbug":            {name:"Kettlebell Dead Bug",       mode:"bilateral"},
  "hollow-rock":        {name:"Hollow Rock",               mode:"bilateral"},
  "sideplank-knee":     {name:"Side Plank Knee-to-Elbow",  mode:"unilateral_split"},
  "kb-pullover":        {name:"Kettlebell Pullover",       mode:"bilateral"},
  "kb-situp":           {name:"Kettlebell Sit-Up",         mode:"bilateral"},
  "highplank-tap":      {name:"High Plank KB Tap",         mode:"bilateral"},
  "leg-raise":          {name:"Leg Raise Over Kettlebell", mode:"bilateral"},
  "sprinter-situp":     {name:"Sprinter Sit-Up",           mode:"unilateral_split"},
  "atlas-swing":        {name:"Atlas Swing",               mode:"bilateral"},
};

const WORK = 60, REST = 20, PREP = 10;
let PLAN = null, intensity = "standard";
let queue = [], idx = 0, t0 = 0, raf = 0, paused = false, pauseAt = 0;
let wakeLock = null, actx = null;

const $ = s => document.querySelector(s);

/* ---------- audio: WebAudio tones, zero assets ---------- */
function beep(freq, dur = 0.13, when = 0, vol = 0.5) {
  if (!actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
const cueWork   = () => { beep(880, .18); beep(1320, .22, .16); };
const cueRest   = () => beep(420, .3);
const cueTick   = () => beep(660, .07, 0, .32);
const cueSwitch = () => { beep(1000, .1); beep(1000, .1, .16); };
const cueDone   = () => { beep(660,.16); beep(880,.16,.18); beep(1320,.34,.36); };

function say(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.volume = 0.95;
    speechSynthesis.speak(u);
  } catch (e) {}
}

/* ---------- wake lock ---------- */
async function lockScreen() {
  if (!("wakeLock" in navigator)) { $("#wl").textContent = "Screen may sleep — set auto-lock to Never"; return; }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    $("#wl").textContent = "Screen stays on";
    wakeLock.addEventListener("release", () => { $("#wl").textContent = "Screen lock released"; });
  } catch (e) { $("#wl").textContent = "Screen may sleep — set auto-lock to Never"; }
}
// Browsers silently drop the lock when the tab backgrounds; re-acquire on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !paused && queue.length) lockScreen();
});

/* ---------- build the session ---------- */
function buildQueue() {
  const rounds = intensity === "easy" ? 2 : 3;
  const q = [];
  PLAN.warmup.forEach(w => q.push({ ...w, block: "Warm-up" }));
  for (let r = 1; r <= rounds; r++)
    PLAN.rounds.forEach(w => q.push({ ...w, block: `Round ${r}/${rounds}` }));
  if (intensity === "hard") q.push({ ...PLAN.cooldown[0], block: "Finisher" });
  PLAN.cooldown.forEach(w => q.push({ ...w, block: "Cool-down" }));
  return q;
}

// Real duration: no rest after the final interval.
function totalSeconds(q) { return PREP + q.length * WORK + Math.max(0, q.length - 1) * REST; }
function fmtMin(s) { return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`; }

function renderPlan() {
  const q = buildQueue(), rounds = intensity === "easy" ? 2 : 3;
  // Safe: all interpolated values are integers computed locally or come from our own
  // bundled workout.json — no user-supplied or remote input reaches this string.
  $("#planlist").innerHTML = `
    <li><b>${PLAN.warmup.length}</b> warm-up moves</li>
    <li><b>${rounds} rounds</b> × ${PLAN.rounds.length} core stations</li>
    <li><b>${PLAN.cooldown.length}</b> cool-down moves</li>
    <li><b>${q.length} intervals</b> · about <b>${fmtMin(totalSeconds(q))}</b> total</li>`;
}

/* ---------- media ---------- */
function loadClip(id) {
  const v = $("#vid");
  v.poster = `media/${id}.jpg`;
  if (v.dataset.id !== id) {
    v.dataset.id = id;
    v.src = `media/${id}.mp4`;
    v.load();
  }
  v.play().catch(() => {}); // muted+playsinline: allowed; ignore if blocked
}

/* ---------- the loop ---------- */
function segments() {
  // flatten into [{kind:'prep'|'work'|'rest', dur, i}]
  const segs = [{ kind: "prep", dur: PREP, i: 0 }];
  queue.forEach((_, i) => {
    segs.push({ kind: "work", dur: WORK, i });
    if (i < queue.length - 1) segs.push({ kind: "rest", dur: REST, i });
  });
  return segs;
}
let SEGS = [], segIdx = 0, lastWhole = -1, firedSwitch = false;

function startSession() {
  queue = buildQueue();
  SEGS = segments();
  segIdx = 0; lastWhole = -1; firedSwitch = false;
  t0 = performance.now();
  $("#start").classList.add("hidden");
  $("#done").classList.add("hidden");
  $("#run").classList.remove("hidden");
  enterSeg();
  raf = requestAnimationFrame(tick);
}

function enterSeg() {
  const s = SEGS[segIdx];
  const ex = queue[s.i];
  const meta = EX[ex.id] || { name: ex.id, mode: "bilateral" };
  document.body.className = s.kind;
  $("#prog").textContent = `${s.i + 1} / ${queue.length} · ${ex.block}`;
  firedSwitch = false;

  if (s.kind === "prep") {
    $("#phase").textContent = "Get ready";
    $("#name").textContent = meta.name;
    $("#cue").textContent = ex.cue || "";
    $("#stopcue").textContent = "";
    $("#side").textContent = meta.mode === "unilateral_split" ? "Start LEFT" : "";
    $("#next").textContent = "Starting…";
    loadClip(ex.id);
    say(`Get ready. ${meta.name}`);
  } else if (s.kind === "work") {
    $("#phase").textContent = "Work";
    $("#name").textContent = meta.name;
    $("#cue").textContent = ex.cue || "";
    $("#stopcue").textContent = ex.stop ? `Stop if: ${ex.stop}` : "";
    $("#side").textContent = meta.mode === "unilateral_split" ? "LEFT SIDE" : "";
    loadClip(ex.id);
    cueWork();
    const nx = queue[s.i + 1];
    $("#next").textContent = nx ? `Next: ${(EX[nx.id] || {}).name || nx.id}` : "Last one";
  } else {
    const nx = queue[s.i + 1];
    const nm = nx ? (EX[nx.id] || {}).name || nx.id : "";
    $("#phase").textContent = "Rest";
    $("#name").textContent = nm;
    $("#cue").textContent = nx ? nx.cue : "";
    $("#stopcue").textContent = "";
    $("#side").textContent = (EX[nx.id] || {}).mode === "unilateral_split" ? "Start LEFT" : "";
    $("#next").textContent = "Coming up";
    if (nx) loadClip(nx.id);
    cueRest();
    say(`Rest. Next, ${nm}`);
  }
}

function tick(now) {
  if (paused) return;
  const s = SEGS[segIdx];
  const elapsedAll = (now - t0) / 1000;
  const before = SEGS.slice(0, segIdx).reduce((a, x) => a + x.dur, 0);
  let left = s.dur - (elapsedAll - before);

  if (left <= 0) {
    segIdx++;
    if (segIdx >= SEGS.length) return finish();
    lastWhole = -1;
    enterSeg();
    raf = requestAnimationFrame(tick);
    return;
  }

  const whole = Math.ceil(left);
  if (whole !== lastWhole) {
    lastWhole = whole;
    $("#clock").textContent = whole >= 60 ? `${Math.floor(whole/60)}:${String(whole%60).padStart(2,"0")}` : whole;
    if (whole <= 3) cueTick();
  }
  // 30s side switch on unilateral work
  if (s.kind === "work" && !firedSwitch) {
    const meta = EX[queue[s.i].id] || {};
    if (meta.mode === "unilateral_split" && left <= s.dur / 2) {
      firedSwitch = true;
      cueSwitch(); say("Switch sides");
      $("#side").textContent = "RIGHT SIDE";
    }
  }
  $("#barfill").style.width = `${(1 - left / s.dur) * 100}%`;
  raf = requestAnimationFrame(tick);
}

function finish() {
  cancelAnimationFrame(raf);
  cueDone(); say("Workout complete. Nice work.");
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  $("#run").classList.add("hidden");
  $("#done").classList.remove("hidden");
  $("#donesub").textContent = `${queue.length} intervals · ${fmtMin(totalSeconds(queue))} · ${intensity}`;
}

/* ---------- pause / resume ---------- */
function setPaused(p) {
  paused = p;
  $("#paused").classList.toggle("hidden", !p);
  if (p) {
    pauseAt = performance.now();
    cancelAnimationFrame(raf);
    $("#vid").pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
  } else {
    t0 += performance.now() - pauseAt;   // shift the origin: no drift
    $("#vid").play().catch(() => {});
    raf = requestAnimationFrame(tick);
  }
}

/* ---------- wiring ---------- */
$("#intensity").addEventListener("click", e => {
  const b = e.target.closest("button[data-v]"); if (!b) return;
  [...e.currentTarget.children].forEach(x => x.setAttribute("aria-pressed", x === b));
  intensity = b.dataset.v;
  renderPlan();
});
$("#go").addEventListener("click", () => {
  // Audio must NEVER block the workout from starting. resume() can hang
  // indefinitely (no audio device / autoplay policy), so fire-and-forget it
  // rather than awaiting — a silent workout still beats a dead button.
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    actx.resume().then(() => beep(880, .08, 0, .3)).catch(() => {});
  } catch (e) { actx = null; }
  lockScreen();          // also not awaited: it can reject on some browsers
  startSession();
});
$("#tapzone").addEventListener("click", () => setPaused(true));
$("#resume").addEventListener("click", e => { e.stopPropagation(); setPaused(false); });
$("#quit").addEventListener("click", e => { e.stopPropagation(); setPaused(false); finish(); });
$("#again").addEventListener("click", () => {
  $("#done").classList.add("hidden"); $("#start").classList.remove("hidden");
});

fetch("workout.json").then(r => r.json()).then(p => { PLAN = p; renderPlan(); });

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {});
