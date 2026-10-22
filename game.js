'use strict';
/* Territory Incremental Survivors — prototype v1
 * Color-Smash-style territory painting + Vampire-Survivors-style XP/levels.
 */

// ---- Cell states ----
const WHITE = 0, EMPTY = 1, BLUE = 2, RED = 3;
const CELL_COLORS = ['#eef1f6', '#3d4454', '#3b82f6', '#ef4444'];

const CELL_PX = 16;                 // render size of one cell
const BOUNCE_MAX = 8;               // bounces per projectile (backstop, not a target)
const STEER_RATE = 3;               // missile turn rate, rad/s (x S.steerMult)
const RED_DEPLOY_EVERY = 12;        // seconds between red turret deployments

// Turret roster: distinct damage patterns, no homing except the missile's
// steering (which is deliberately dumb: limited turn rate, walls win).
const TURRET = {
  cannon: { name: 'Cannon', hp: 8, interval: 1.0, dmg: 1 },
  rocket: { name: 'Rocket', hp: 6, interval: 2.5, dmg: 3 },
  laser:  { name: 'Laser',  hp: 5, interval: 2.0, dmg: 2 },
  mint:   { name: 'Mint',   hp: 4, interval: 15,  dmg: 0 },
};
const COIN_FLY_DUR = 0.45;           // seconds for a tapped coin to zip to the corner
const RING_DUR = 0.3;                // conversion shockwave ring lifetime (s)
const CHIP_CX = 41, CHIP_CY = 48;    // coin-counter chip center, in screen (CSS) px
// (hit-feel knobs live in cfg via the debug panel: popHold, popDur, popPush,
// rippleAmp, trailT)

// Rounded-rect path helper (not all targets have ctx.roundRect)
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- DOM ----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const xpfill = document.getElementById('xpfill');
const xplabel = document.getElementById('xplabel');
const statsEl = document.getElementById('d-stats');
const overlay = document.getElementById('levelup');
const placebanner = document.getElementById('placebanner');
const wavebanner = document.getElementById('wavebanner');
const runover = document.getElementById('runover');
const runstats = document.getElementById('runstats');

const inCols   = document.getElementById('d-cols');
const inRows   = document.getElementById('d-rows');
const inSpeed  = document.getElementById('d-speed');
const inFreq   = document.getElementById('d-freq');
const inArc    = document.getElementById('d-arc');
const inTurn   = document.getElementById('d-turn');
const inBounce  = document.getElementById('d-bounce');
const inCave   = document.getElementById('d-cave');
const inSeed   = document.getElementById('d-seed');
const inCoin   = document.getElementById('d-coin');
const inCollect = document.getElementById('d-collect');
const inThresh = document.getElementById('d-thresh');
const inPopHold = document.getElementById('d-pophold');
const inPopDur  = document.getElementById('d-popdur');
const inPopPush = document.getElementById('d-poppush');
const inRipple  = document.getElementById('d-ripple');
const inTrail   = document.getElementById('d-trail');
const inGravity = document.getElementById('d-gravity');

// ---- Camera: fullscreen canvas, pan + pinch zoom, always crisp ----
// The backing store is viewport x devicePixelRatio and the vector scene is
// re-rasterized through the camera transform every frame, so zooming never
// upscales a bitmap: it stays sharp at any zoom level.
const view = { w: 0, h: 0 }; // viewport, CSS px
let dpr = 1;
const cam = { x: 0, y: 0, zoom: 1 }; // x/y: world px at screen center; zoom: CSS px per world px

function minZoom() {
  // Outermost zoom: the whole map fits on screen (width binds on portrait
  // phones, height on landscape). Portrait pays for the overview with bars
  // above/below; pinch in for the cropped, bar-free view.
  if (!view.w || !view.h || !cfg.cols) return 1;
  return Math.min(view.w / (cfg.cols * CELL_PX), view.h / (cfg.rows * CELL_PX));
}
const START_ZOOM_MULT = 3; // new games start this far in (x min zoom), on the player
function resetCamera() {
  cam.zoom = minZoom() * START_ZOOM_MULT;
  const p = nearestBlueTurret(cfg.cols / 2, cfg.rows / 2); // the player's first turret
  cam.x = p ? (p.x + 0.5) * CELL_PX : (cfg.cols * CELL_PX) / 2;
  cam.y = p ? (p.y + 0.5) * CELL_PX : (cfg.rows * CELL_PX) / 2;
  clampCamera();
}
function clampCamera() {
  if (!cfg.cols) return;
  const mz = minZoom();
  cam.zoom = Math.min(Math.max(cam.zoom, mz), mz * 8);
  const hw = view.w / cam.zoom / 2, hh = view.h / cam.zoom / 2;
  const W = cfg.cols * CELL_PX, H = cfg.rows * CELL_PX;
  const pad = 2 * CELL_PX;
  // When the view is wider/taller than the map, pin to center instead of sliding
  cam.x = hw * 2 >= W ? W / 2 : Math.min(Math.max(cam.x, hw - pad), W - hw + pad);
  cam.y = hh * 2 >= H ? H / 2 : Math.min(Math.max(cam.y, hh - pad), H - hh + pad);
}
function screenToWorld(sx, sy) {
  return { x: (sx - view.w / 2) / cam.zoom + cam.x,
           y: (sy - view.h / 2) / cam.zoom + cam.y };
}
// Zoom keeping the world point under (sx, sy) pinned to the cursor/fingers
function zoomAt(sx, sy, newZoom) {
  const mz = minZoom();
  newZoom = Math.min(Math.max(newZoom, mz), mz * 8);
  const before = screenToWorld(sx, sy);
  cam.zoom = newZoom;
  const after = screenToWorld(sx, sy);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  clampCamera();
}
function resize() {
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(view.w * dpr));
  canvas.height = Math.max(1, Math.round(view.h * dpr));
  clampCamera();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ---- Seeded RNG, smooth value noise (Perlin-style), cave automata ----
function mulberry32(a) {
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise2D(rng) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = t => t * t * (3 - 2 * t);
  const val = (ix, iy) => perm[(perm[ix & 255] + (iy & 255)) & 511] / 255;
  function noise(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const u = fade(xf), v = fade(yf);
    const a = val(X, Y), b = val(X + 1, Y), c = val(X, Y + 1), d = val(X + 1, Y + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  return (x, y) => { // 3-octave fbm, normalized to ~[0,1]
    let v = 0, amp = 0.5, f = 1, tot = 0;
    for (let o = 0; o < 3; o++) { v += noise(x * f, y * f) * amp; tot += amp; amp *= 0.5; f *= 2.03; }
    return v / tot;
  };
}

// Cellular-automata caves: blobby voids instead of per-cell speckle
function genCaves(cols, rows, fill, rng) {
  let cur = new Uint8Array(cols * rows);
  for (let i = 0; i < cur.length; i++) cur[i] = rng() < fill ? 1 : 0;
  for (let it = 0; it < 5; it++) {
    const nxt = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && cur[ny * cols + nx]) n++;
          }
        }
        const was = cur[y * cols + x] === 1;
        nxt[y * cols + x] = (was ? n >= 4 : n >= 5) ? 1 : 0;
      }
    }
    cur = nxt;
  }
  return cur;
}

// ---- Block colors: grey gradient (weak -> strong), tinted toward damage ----
const GREY_LIGHT = [238, 241, 246]; // ~3 HP
const GREY_DARK = [88, 96, 114];    // ~10 HP
const GREYS = [];
for (let m = 3; m <= 10; m++) {
  const t = (m - 3) / 7;
  GREYS[m] = [0, 1, 2].map(j => Math.round(GREY_LIGHT[j] + (GREY_DARK[j] - GREY_LIGHT[j]) * t));
}
const BLUE_RGB = [59, 130, 246];
const RED_RGB = [239, 68, 68];
const CAVE_CSS = '#222839';
const CAVE_RGB = [34, 40, 57];

// Hit-pop envelope: full amp during the hold (instant big square), then lerp to 0
function popFactor(i) {
  const t = S.popT[i];
  if (t < 0) return 0;
  const amp = S.popAmp[i];
  if (t < cfg.popHold) return amp;
  const k = 1 - (t - cfg.popHold) / cfg.popDur;
  return k > 0 ? amp * k : 0;
}

function cellRGB(x, y) {
  const i = y * cfg.cols + x;
  const st = S.cells[i];
  if (st === BLUE) return BLUE_RGB;
  if (st === RED) return RED_RGB;
  if (st === EMPTY) return CAVE_RGB;
  const max = S.maxhp[i] || 3, hpv = S.hp[i];
  const base = GREYS[max];
  let r = base[0], g = base[1], b = base[2];
  const ac = S.hitBy[i] === RED ? RED_RGB : BLUE_RGB;
  if (hpv < max) { // progressive damage tint toward last hitter
    const k = (1 - hpv / max) * 0.9;
    r = Math.round(r + (ac[0] - r) * k);
    g = Math.round(g + (ac[1] - g) * k);
    b = Math.round(b + (ac[2] - b) * k);
  }
  const f = popFactor(i);
  if (f > 0) { // hit flash in the attacker's color, lerping back with the scale
    const fc = S.popCol[i] === RED ? RED_RGB : BLUE_RGB;
    r = Math.round(r + (fc[0] - r) * f);
    g = Math.round(g + (fc[1] - g) * f);
    b = Math.round(b + (fc[2] - b) * f);
  }
  return [r, g, b];
}

// Conversion burst: debris in every direction + an expanding shockwave ring
function spawnBurst(cx, cy, css) {
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 4 + Math.random() * 4;
    S.particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                       life: 0.4 + Math.random() * 0.25, t: 0, dead: false,
                       color: css, size: 4 + Math.random() * 3 });
    S.particlesSpawned++;
  }
  S.rings.push({ x: cx, y: cy, t: 0, css, dead: false });
  if (S.particles.length > 600) S.particles.splice(0, S.particles.length - 600);
  if (S.rings.length > 60) S.rings.splice(0, S.rings.length - 60);
}

// Impact chips: 1-2 squares in the projectile's color, spraying forward
// along the projectile's direction like debris from the impact.
function spawnChip(cx, cy, css, vx, vy) {
  const n = 1 + (Math.random() < 0.5 ? 1 : 0);
  const baseA = Math.atan2(vy, vx);
  for (let i = 0; i < n; i++) {
    const a = baseA + (Math.random() - 0.5) * 1.1; // spread around impact direction
    const sp = 3 + Math.random() * 3.5; // cells/sec
    S.particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                       life: 0.3 + Math.random() * 0.2, t: 0, dead: false,
                       color: css, size: 5 + Math.random() * 4 });
    S.particlesSpawned++;
  }
  if (S.particles.length > 600) S.particles.splice(0, S.particles.length - 600);
}

// Damage numbers: white retro text above the wall, drifting up, fading fast
function spawnDmgNum(x, y, dmg) {
  S.dmgNums.push({ x: x + (Math.random() - 0.5) * 0.5, y, t: 0, life: 0.6, dmg, dead: false });
  if (S.dmgNums.length > 200) S.dmgNums.splice(0, S.dmgNums.length - 200);
}

// ---- Config (from debug panel; any change restarts the game) ----
let cfg = {};

function clampNum(v, lo, hi, fallback) {
  v = parseFloat(v);
  if (!isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function readDebug() {
  const cols = Math.round(clampNum(inCols.value, 8, 120, 48));
  const rows = Math.round(clampNum(inRows.value, 8, 120, 36));
  const thresholds = inThresh.value.split(',')
    .map(s => parseFloat(s.trim()))
    .filter(v => isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  cfg = {
    cols, rows,
    projSpeed: clampNum(inSpeed.value, 40, 2000, 260),   // px/s
    freq: clampNum(inFreq.value, 0.1, 20, 1),            // shots/s (both cannons)
    arc: clampNum(inArc.value, 0, 360, 120),             // degrees
    turnRate: clampNum(inTurn.value, 0, 720, 120),          // cannon sweep speed (deg/s)
    bounceChance: clampNum(inBounce.value, 0, 1, 0),         // block-bounce chance per hit
    caveChance: clampNum(inCave.value, 0, 0.95, 0.38),      // CA cave fill
    coinChance: clampNum(inCoin.value, 0, 1, 0.3),          // coin drop per block excavated by blue
    collectInterval: clampNum(inCollect.value, 0, 60, 30),  // auto-collect timer (s, 0 = off)
    popHold: clampNum(inPopHold.value, 0, 0.5, 0.03),        // big square hold time (s)
    popDur: clampNum(inPopDur.value, 0.05, 1, 0.1),          // pop shrink time (s)
    popPush: clampNum(inPopPush.value, 0, 1.5, 0.2),         // knockback push (cells)
    rippleAmp: clampNum(inRipple.value, 0, 1, 0.1),          // neighbor shockwave strength
    trailT: clampNum(inTrail.value, 0, 1, 0.1),               // projectile trail (s)
    gravity: clampNum(inGravity.value, 0, 40, 9),            // particle gravity (cells/s^2)
    thresholds: thresholds.length ? thresholds : [15],
  };
  // reflect clamped values back into the panel
  inCols.value = cols; inRows.value = rows;
  inSpeed.value = cfg.projSpeed; inFreq.value = cfg.freq;
  inArc.value = cfg.arc; inCave.value = cfg.caveChance;
  inTurn.value = cfg.turnRate;
  inBounce.value = cfg.bounceChance;
  inCoin.value = cfg.coinChance;
  inCollect.value = cfg.collectInterval;
  inPopHold.value = cfg.popHold; inPopDur.value = cfg.popDur;
  inPopPush.value = cfg.popPush; inRipple.value = cfg.rippleAmp;
  inTrail.value = cfg.trailT;
  inGravity.value = cfg.gravity;
  inThresh.value = cfg.thresholds.join(',');
}

// ---- Game state ----
let S = null;

function mkTurret(x, y, color, type) {
  const spec = TURRET[type];
  // Base aim is fixed at placement: blue aims map-center, red aims at blue's
  // corner. Nobody tracks anybody — the patterns do the fighting.
  const base = color === BLUE
    ? Math.atan2(cfg.rows / 2 - y, cfg.cols / 2 - x)
    : Math.atan2(cfg.rows * 0.85 - y, cfg.cols * 0.15 - x);
  // Red gets tankier every wave so the escalation is real.
  const hpScale = color === RED ? 1 + 0.2 * (S.wave - 1) : 1;
  const maxhp = Math.max(1, Math.round(spec.hp * hpScale));
  return { x, y, color, type, hp: maxhp, maxhp, base, angle: base, dir: 1,
           cd: Math.random(), dead: false };
}
// Turret occupying a cell, if any (skips the dead).
function turretAt(cx, cy) {
  for (const t of S.turrets) {
    if (!t.dead && t.x === cx && t.y === cy) return t;
  }
  return null;
}
function nearestBlueTurret(x, y) {
  let best = null, bd = Infinity;
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    const d = (t.x + 0.5 - x) ** 2 + (t.y + 0.5 - y) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
// Damage an enemy turret. Shows remaining HP above it, like block damage
// numbers — turrets are just big blocks that shoot back.
function damageTurret(t, dmg, byColor) {
  if (t.dead) return;
  t.hp -= dmg;
  spawnDmgNum(t.x + 0.5, t.y - 0.2, Math.max(0, t.hp));
  if (t.hp <= 0) {
    t.dead = true;
    killTurret(t);
  }
}
function killTurret(t) {
  spawnBurst(t.x + 0.5, t.y + 0.5, CELL_COLORS[t.color]);
  spawnBurst(t.x + 0.5, t.y + 0.5, '#ffffff');
  if (t.color === RED) {
    S.redKills++;
    // Kill reward: 3 coins scattered around the wreck.
    for (let k = 0; k < 3; k++) {
      if (S.coins.length >= 800) break;
      S.coins.push({ x: t.x + 0.5 + (Math.random() - 0.5) * 2,
                     y: t.y + 0.5 + (Math.random() - 0.5) * 2,
                     state: 'idle', phase: Math.random() * 6.283,
                     sx: 0, sy: 0, t: 0, dead: false });
    }
    checkWaveClear();
  } else {
    checkRunOver();
  }
}

// Nearest cave cell to an anchor point (for cannon spawns). exclude lets the
// second cannon avoid the first cannon's cell. -1 when the map has no caves.
function nearestCave(ax, ay, exclude) {
  let best = -1, bd = Infinity;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (i === exclude || S.cells[i] !== EMPTY) continue;
      const d = (x - ax) * (x - ax) + (y - ay) * (y - ay);
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}
function snapAnchor(a) { // fallback spawn when there are no caves at all
  return { x: Math.min(cfg.cols - 1, Math.max(0, Math.round(a.x))),
           y: Math.min(cfg.rows - 1, Math.max(0, Math.round(a.y))) };
}

function newGame() {
  readDebug();
  const seedStr = inSeed.value.trim();
  const seed = seedStr === '' ? (Math.random() * 1e9) | 0 : parseInt(seedStr, 10) || 0;
  const rng = mulberry32(seed);

  const n = cfg.cols * cfg.rows;
  const cells = new Uint8Array(n);
  const hp = new Uint8Array(n);
  const maxhp = new Uint8Array(n);
  const hitBy = new Uint8Array(n);
  const popT = new Float32Array(n).fill(-1); // time since hit (-1 = idle); drives the pop envelope
  const popAmp = new Float32Array(n); // pop intensity: 1 = direct hit, RIPPLE_AMP = neighbor shockwave
  const popCol = new Uint8Array(n); // flash color for the pop (the attacker)
  const popDX = new Float32Array(n); // knockback direction (unit vector), set at impact
  const popDY = new Float32Array(n);
  S = { cells, hp, maxhp, hitBy, popT, popAmp, popCol, popDX, popDY, projs: [], xp: 0, level: 1, pending: 0,
        freqMult: 1, paused: false, frame: 0, seed,
        coins: [], floaters: [], coinsCollected: 0, chipPulse: 0, time: 0,
        particles: [], particlesSpawned: 0, rings: [], dmgNums: [],
        destroyed: 0, destroyedBlue: 0, collectT: 0,
        bounceChance: cfg.bounceChance, suctionMult: 1,
        // auto-battler state
        turrets: [], missiles: [], beams: [],
        wave: 0, redQueue: [], redTimer: 0, waveBreak: 0, redKills: 0,
        placing: null, runOver: false,
        dmgBonus: 0, steerMult: 1 };

  // Caves first (cellular-automata blobs), then HP from a smooth noise gradient:
  // white ~3 hits ... dark grey ~10 hits
  const cave = genCaves(cfg.cols, cfg.rows, cfg.caveChance, rng);
  const noise = makeNoise2D(rng);
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (cave[i]) { cells[i] = EMPTY; continue; }
      cells[i] = WHITE;
      const m = 3 + Math.round(noise((x / cfg.cols) * 3.5, (y / cfg.rows) * 3.5) * 7);
      maxhp[i] = m; hp[i] = m;
    }
  }

  // The player's Cannon spawns inside a cave near the bottom-left anchor —
  // chipping away at cave walls feels better than painting open ground.
  // Red comes in waves after that (see startWave).
  const pA = { x: cfg.cols * 0.15, y: cfg.rows * 0.85 };
  const pi = nearestCave(pA.x, pA.y, -1);
  const pc = pi >= 0 ? { x: pi % cfg.cols, y: Math.floor(pi / cfg.cols) } : snapAnchor(pA);
  S.turrets.push(mkTurret(pc.x, pc.y, BLUE, 'cannon'));
  startWave(1);

  resize();       // backing store = viewport x devicePixelRatio
  resetCamera();  // overview framing, starting on the player's turret

  overlay.classList.add('hidden');
  runover.classList.add('hidden');
  placebanner.classList.add('hidden');
  wavebanner.classList.add('hidden');
  updateHud();
}

// ---- Waves: red deploys over time, mid-map. Clear them all -> jackpot. ----
function startWave(n) {
  S.wave = n;
  S.redQueue = [];
  const count = 2 + n;
  for (let i = 0; i < count; i++) {
    let type = 'cannon';
    const r = Math.random();
    if (n >= 3 && r < 0.3) type = 'rocket';       // rockets from wave 3
    else if (n >= 2 && r < 0.5) type = 'laser';   // lasers from wave 2
    S.redQueue.push(type);
  }
  S.redTimer = 0;
  wavebanner.textContent = 'WAVE ' + n;
  wavebanner.classList.remove('hidden');
  clearTimeout(S._wbt);
  S._wbt = setTimeout(() => wavebanner.classList.add('hidden'), 2000);
}
function deployRed(type) {
  // Random cave cell, weighted toward the middle (rejection sample).
  let bi = -1;
  for (let tries = 0; tries < 20 && bi < 0; tries++) {
    const x = (Math.random() * cfg.cols) | 0, y = (Math.random() * cfg.rows) | 0;
    const i = y * cfg.cols + x;
    if (S.cells[i] === EMPTY && !turretAt(x, y) &&
        Math.abs(x - cfg.cols / 2) < cfg.cols * 0.4) bi = i;
  }
  if (bi < 0) { // fallback: any empty, unoccupied cell
    for (let i = 0; i < S.cells.length && bi < 0; i++) {
      if (S.cells[i] === EMPTY && !turretAt(i % cfg.cols, (i / cfg.cols) | 0)) bi = i;
    }
  }
  if (bi < 0) return; // no room: this deployment fizzles
  const x = bi % cfg.cols, y = (bi / cfg.cols) | 0;
  S.turrets.push(mkTurret(x, y, RED, type));
  spawnBurst(x + 0.5, y + 0.5, CELL_COLORS[RED]);
}
function checkWaveClear() {
  if (S.runOver) return;
  const redsAlive = S.turrets.some(t => !t.dead && t.color === RED);
  if (!redsAlive && S.redQueue.length === 0) {
    // Jackpot: coins scattered around map center.
    const n = 10 + 5 * S.wave;
    for (let k = 0; k < n; k++) {
      if (S.coins.length >= 800) break;
      S.coins.push({ x: cfg.cols / 2 + (Math.random() - 0.5) * 10,
                     y: cfg.rows / 2 + (Math.random() - 0.5) * 10,
                     state: 'idle', phase: Math.random() * 6.283,
                     sx: 0, sy: 0, t: 0, dead: false });
    }
    wavebanner.textContent = 'WAVE ' + S.wave + ' CLEARED!';
    wavebanner.classList.remove('hidden');
    clearTimeout(S._wbt);
    S.waveBreak = 4; // seconds of breathing room before the next wave
  }
}
// Lose condition: your last turret falls -> run over.
function checkRunOver() {
  if (S.runOver) return;
  const bluesAlive = S.turrets.some(t => !t.dead && t.color === BLUE);
  if (!bluesAlive) {
    S.runOver = true;
    S.paused = true;
    S.placing = null;
    placebanner.classList.add('hidden');
    runstats.innerHTML =
      'Wave <b>' + S.wave + '</b> · Level <b>' + S.level + '</b><br>' +
      'Survived <b>' + Math.round(S.time) + 's</b> · ' +
      'Excavated <b>' + S.destroyed + '</b> · ' +
      'Red turrets destroyed <b>' + S.redKills + '</b> · ' +
      'Coins <b>' + S.coinsCollected + '</b>';
    runover.classList.remove('hidden');
  }
}

// ---- Firing ----
function fireTurret(t) {
  const speed = cfg.projSpeed / CELL_PX; // cells per second
  const mx = t.x + 0.5 + Math.cos(t.angle) * 1.1;
  const my = t.y + 0.5 + Math.sin(t.angle) * 1.1;
  S.projs.push({
    x: mx, y: my,
    vx: Math.cos(t.angle) * speed,
    vy: Math.sin(t.angle) * speed,
    color: t.color,
    dmg: TURRET.cannon.dmg + S.dmgBonus,
    bounces: 0,
    dead: false,
  });
}
// Rocket: launches a homing missile. It steers toward the nearest enemy
// turret but can only turn STEER_RATE rad/s — momentum carries it into walls,
// where it crashes and splash-digs the 3x3.
function fireMissile(t) {
  const sp = 10; // cells per second
  S.missiles.push({
    x: t.x + 0.5, y: t.y + 0.5,
    vx: Math.cos(t.base) * sp, vy: Math.sin(t.base) * sp,
    speed: sp, color: t.color,
    dmg: TURRET.rocket.dmg + S.dmgBonus,
    dead: false,
  });
  spawnBurst(t.x + 0.5, t.y + 0.5, '#fb923c');
}
// Laser: hitscan. Snipes the weakest block on the map (lowest current HP,
// nearest wins ties) — it finishes off damaged blocks first, chewing its own
// path toward the enemy caves. Beam fades in 0.15s.
function weakestBlock(t) {
  let bx = -1, by = -1, bi = -1, bestHp = Infinity, bd = Infinity;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (S.cells[i] !== WHITE) continue;
      const hp = S.hp[i];
      const d = (x - t.x) * (x - t.x) + (y - t.y) * (y - t.y);
      if (hp < bestHp || (hp === bestHp && d < bd)) { bestHp = hp; bd = d; bx = x; by = y; bi = i; }
    }
  }
  return bi < 0 ? null : { x: bx, y: by, i: bi };
}
function fireLaser(t) {
  const tgt = weakestBlock(t);
  if (!tgt) return; // nowhere left to dig
  S.beams.push({ x1: (t.x + 0.5) * CELL_PX, y1: (t.y + 0.5) * CELL_PX,
                 x2: (tgt.x + 0.5) * CELL_PX, y2: (tgt.y + 0.5) * CELL_PX, t: 0 });
  damageBlock(tgt.i, TURRET.laser.dmg + S.dmgBonus, t.color,
              t.x + 0.5, t.y + 0.5, tgt.x - t.x, tgt.y - t.y);
}
// Mint: doesn't shoot. Drops a coin beside itself on a timer.
function mintCoin(t) {
  if (S.coins.length >= 800) return;
  S.coins.push({ x: t.x + 0.5 + (Math.random() - 0.5) * 1.5,
                 y: t.y + 0.5 + (Math.random() - 0.5) * 1.5,
                 state: 'idle', phase: Math.random() * 6.283,
                 sx: 0, sy: 0, t: 0, dead: false });
}

function stepProjectile(p, dt) {
  const dist = Math.hypot(p.vx, p.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.4)); // sub-step so fast shots can't tunnel
  let sx = (p.vx * dt) / steps, sy = (p.vy * dt) / steps;
  for (let s = 0; s < steps; s++) {
    p.x += sx; p.y += sy;
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) { p.dead = true; return; }
    // Turrets take priority: an enemy turret cell eats the shot.
    const t = turretAt(cx, cy);
    if (t && t.color !== p.color) {
      damageTurret(t, p.dmg || 1, p.color);
      spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[p.color]);
      p.dead = true; return;
    }
    const idx = cy * cfg.cols + cx;
    const cell = S.cells[idx];
    if (cell === WHITE) {
      const destroyed = damageBlock(idx, p.dmg || 1, p.color, p.x, p.y, p.vx, p.vy);
      if (destroyed) { p.dead = true; return; }
      // Pinball: a surviving block may bounce the shot back out (re-rolled per hit)
      if (p.bounces < BOUNCE_MAX && Math.random() < S.bounceChance) {
        p.bounces++;
        p.x -= sx; p.y -= sy; // back out to the pre-entry position
        if (Math.abs(sx) >= Math.abs(sy)) p.vx = -p.vx; else p.vy = -p.vy;
        sx = (p.vx * dt) / steps;
        sy = (p.vy * dt) / steps;
        continue;
      }
      p.dead = true;
      return;
    }
    if (cell === EMPTY || cell === p.color) continue; // pass through grey + own color
    p.dead = true; return; // enemy color blocks the shot
  }
}

// Damage a WHITE block: pop, ripple, chips, damage number, maybe destroy.
// (sx, sy) = impact source (for knockback direction); (vx, vy) = spray direction.
// Returns true when the block was destroyed.
function damageBlock(idx, dmg, color, sx, sy, vx, vy) {
  const cx = idx % cfg.cols, cy = Math.floor(idx / cfg.cols);
  S.hp[idx] = Math.max(0, S.hp[idx] - dmg); // clamp: hp is a Uint8Array, no wraparound
  S.hitBy[idx] = color;
  S.popT[idx] = 0; // start the hit-pop: instant 2x scale + full attacker color
  S.popAmp[idx] = 1;
  S.popCol[idx] = color;
  // knockback: push the block away from the impact source
  const pdx = (cx + 0.5) - sx, pdy = (cy + 0.5) - sy;
  const plen = Math.hypot(pdx, pdy) || 1;
  S.popDX[idx] = pdx / plen;
  S.popDY[idx] = pdy / plen;
  // shockwave ripple: nudge the 8 neighbors radially away from the impact
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) continue;
      const ni = ny * cfg.cols + nx;
      if (S.cells[ni] !== WHITE) continue;
      if (S.popT[ni] >= 0 && S.popAmp[ni] >= cfg.rippleAmp) continue; // never downgrade a real hit
      S.popT[ni] = 0;
      S.popAmp[ni] = cfg.rippleAmp;
      S.popCol[ni] = color;
      const rl = Math.hypot(dx, dy);
      S.popDX[ni] = dx / rl;
      S.popDY[ni] = dy / rl;
    }
  }
  spawnChip(cx + 0.5, cy + 0.5, CELL_COLORS[color], vx, vy);
  if (S.hp[idx] > 0) {
    spawnDmgNum(cx + 0.5, cy + 0.2, S.hp[idx]); // remaining HP floats up
    return false;
  }
  S.cells[idx] = EMPTY; // excavated: the block is gone, not painted over
  S.destroyed++;
  if (color === BLUE) S.destroyedBlue++;
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[color]); // the block cracks: debris + ring
  if (color === BLUE && Math.random() < cfg.coinChance) {
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle',
                   phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
    if (S.coins.length > 800) { // safety valve: drop oldest idle coin
      const i = S.coins.findIndex(c => c.state === 'idle');
      if (i >= 0) S.coins.splice(i, 1);
    }
  }
  return true;
}

// ---- Level-ups ----
function checkLevel() {
  const t = cfg.thresholds;
  while (S.level - 1 < t.length && S.xp >= t[S.level - 1]) {
    S.level++;
    S.pending++;
  }
  if (S.pending > 0 && !S.paused) {
    S.paused = true;
    offerCards();
    overlay.classList.remove('hidden');
  }
}

// Card pool: 4 turret cards (placement = the skill expression) + 5 upgrades.
const CARD_POOL = [
  { kind: 'turret', type: 'cannon', title: 'Cannon', sub: 'New turret' },
  { kind: 'turret', type: 'rocket', title: 'Rocket', sub: 'Homing missiles' },
  { kind: 'turret', type: 'laser', title: 'Laser', sub: 'Snipes weak blocks' },
  { kind: 'turret', type: 'mint', title: 'Mint', sub: '+1 coin / 15s' },
  { kind: 'freq', mult: 1.25, title: '+25%', sub: 'Fire rate' },
  { kind: 'damage', add: 1, title: '+1', sub: 'Damage' },
  { kind: 'bounce', add: 0.25, title: '+25%', sub: 'Bounce chance' },
  { kind: 'suction', mult: 0.75, title: '−25%', sub: 'Suction time' },
  { kind: 'steer', mult: 1.3, title: '+30%', sub: 'Missile steering' },
];
function offerCards() {
  const pool = CARD_POOL.slice();
  const els = document.querySelectorAll('.card');
  for (let k = 0; k < els.length && pool.length; k++) {
    const p = pool.splice((Math.random() * pool.length) | 0, 1)[0];
    const el = els[k];
    el.dataset.kind = p.kind;
    el.dataset.type = p.type || '';
    el.dataset.mult = p.mult || '';
    el.dataset.add = p.add || '';
    el.innerHTML = '<b>' + p.title + '</b><span>' + p.sub + '</span>';
  }
}

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    const kind = card.dataset.kind || 'freq';
    if (kind === 'turret') {
      // Placement mode: tap the map to deploy. The game stays paused until
      // the turret is down — no cancel, there's always room somewhere.
      S.pending--;
      overlay.classList.add('hidden');
      updateHud();
      enterPlacement(card.dataset.type);
      return;
    }
    if (kind === 'bounce') {
      S.bounceChance = Math.min(0.95, S.bounceChance + parseFloat(card.dataset.add));
    } else if (kind === 'suction') {
      S.suctionMult = Math.max(0.2, S.suctionMult * parseFloat(card.dataset.mult));
    } else if (kind === 'damage') {
      S.dmgBonus += parseInt(card.dataset.add, 10);
    } else if (kind === 'steer') {
      S.steerMult *= parseFloat(card.dataset.mult);
    } else {
      S.freqMult *= parseFloat(card.dataset.mult);
    }
    S.pending--;
    if (S.pending <= 0) {
      S.pending = 0;
      S.paused = false;
      overlay.classList.add('hidden');
    }
    updateHud();
  });
});

// Run over -> dive again: fresh map, fresh run.
document.getElementById('diveagain').addEventListener('click', () => {
  runover.classList.add('hidden');
  newGame();
});

// Placement: the chosen turret clears its own 1-cell pad and goes live.
function enterPlacement(type) {  S.placing = { type };
  placebanner.innerHTML = 'Tap the map to deploy <b>' + TURRET[type].name + '</b>';
  placebanner.classList.remove('hidden');
}
function placeTurretAt(sx, sy) {
  const wpt = screenToWorld(sx, sy);
  let cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  cx = Math.max(0, Math.min(cfg.cols - 1, cx));
  cy = Math.max(0, Math.min(cfg.rows - 1, cy));
  if (turretAt(cx, cy)) {
    // Occupied: red ring says no, placement mode stays on.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  S.cells[cy * cfg.cols + cx] = EMPTY; // clear a pad
  S.turrets.push(mkTurret(cx, cy, BLUE, S.placing.type));
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[BLUE]);
  S.placing = null;
  placebanner.classList.add('hidden');
  if (!S.runOver) {
    if (S.pending > 0) {
      offerCards(); // more picks to make: fresh cards, game stays paused
      overlay.classList.remove('hidden');
    } else {
      S.paused = false;
    }
  }
}

// Effective auto-collect interval after suction upgrades
function suctionInterval() {
  return cfg.collectInterval * S.suctionMult;
}

// ---- Update ----
function update(dt) {
  const arcRad = (cfg.arc * Math.PI) / 180;
  const turnRate = (cfg.turnRate * Math.PI) / 180; // rad/s
  for (const t of S.turrets) {
    if (t.dead) continue;
    const rateMult = cfg.freq * (t.color === BLUE ? S.freqMult : 1);
    if (t.type === 'cannon') {
      // Sweep the aim within the turn arc (full 360 = continuous spin)
      if (cfg.arc >= 360) {
        t.angle += turnRate * dt;
      } else if (arcRad > 0) {
        t.angle += t.dir * turnRate * dt;
        const lo = t.base - arcRad / 2, hi = t.base + arcRad / 2;
        if (t.angle > hi) { t.angle = hi; t.dir = -1; }
        else if (t.angle < lo) { t.angle = lo; t.dir = 1; }
      } else {
        t.angle = t.base;
      }
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = 1 / rateMult; fireTurret(t); }
    } else if (t.type === 'rocket') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = TURRET.rocket.interval / rateMult; fireMissile(t); }
    } else if (t.type === 'laser') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = TURRET.laser.interval / rateMult; fireLaser(t); }
    } else if (t.type === 'mint') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = TURRET.mint.interval / rateMult; mintCoin(t); }
    }
  }
  S.turrets = S.turrets.filter(t => !t.dead);
  for (const p of S.projs) stepProjectile(p, dt);
  if (S.projs.length > 4000) S.projs.splice(0, S.projs.length - 4000); // safety valve
  S.projs = S.projs.filter(p => !p.dead);

  // Missiles: steer toward the nearest enemy turret, limited turn rate.
  // Walls always win a momentum contest — crashes splash-dig the 3x3.
  const maxTurn = STEER_RATE * S.steerMult * dt;
  for (const m of S.missiles) {
    let tgt = null, bd = Infinity;
    for (const t of S.turrets) {
      if (t.dead || t.color === m.color) continue;
      const d = (t.x + 0.5 - m.x) ** 2 + (t.y + 0.5 - m.y) ** 2;
      if (d < bd) { bd = d; tgt = t; }
    }
    if (tgt) {
      const desired = Math.atan2(tgt.y + 0.5 - m.y, tgt.x + 0.5 - m.x);
      const cur = Math.atan2(m.vy, m.vx);
      let diff = desired - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
      const na = cur + turn;
      m.vx = Math.cos(na) * m.speed;
      m.vy = Math.sin(na) * m.speed;
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    // flame trail
    S.particles.push({ x: m.x, y: m.y,
      vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
      life: 0.25, t: 0, dead: false, color: '#fb923c', size: 3 + Math.random() * 2 });
    const cx = Math.floor(m.x), cy = Math.floor(m.y);
    if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) { m.dead = true; continue; }
    const tt = turretAt(cx, cy);
    if (tt && tt.color !== m.color) {
      // direct hit!
      damageTurret(tt, m.dmg, m.color);
      spawnBurst(m.x, m.y, '#fb923c');
      spawnBurst(m.x, m.y, CELL_COLORS[m.color]);
      m.dead = true;
      continue;
    }
    if (S.cells[cy * cfg.cols + cx] === WHITE) {
      // crash: splash-dig the 3x3 so it never feels wasted
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) continue;
          const ni = ny * cfg.cols + nx;
          if (S.cells[ni] === WHITE) damageBlock(ni, 2, m.color, m.x, m.y, m.vx, m.vy);
        }
      }
      spawnBurst(m.x, m.y, '#fb923c');
      S.rings.push({ x: m.x, y: m.y, t: 0, css: '#fb923c', dead: false });
      m.dead = true;
    }
  }
  S.missiles = S.missiles.filter(m => !m.dead);

  // Laser beams: quick fade
  for (const b of S.beams) b.t += dt;
  S.beams = S.beams.filter(b => b.t < 0.15);

  // Red deploys over time; wave-clear breather, then the next wave.
  if (!S.runOver && S.redQueue.length) {
    S.redTimer += dt;
    if (S.redTimer >= RED_DEPLOY_EVERY) { S.redTimer = 0; deployRed(S.redQueue.shift()); }
  }
  if (S.waveBreak > 0) {
    S.waveBreak -= dt;
    if (S.waveBreak <= 0) startWave(S.wave + 1);
  }

  // Tapped coins zip to the top-left chip (accelerating = satisfying).
  // The chip lives in screen space, so re-project its target every frame.
  S.time += dt;
  const tgt = screenToWorld(CHIP_CX, CHIP_CY);
  const TX = tgt.x / CELL_PX, TY = tgt.y / CELL_PX;
  for (const c of S.coins) {
    if (c.state === 'fly') {
      c.t += dt;
      const k = Math.min(1, c.t / COIN_FLY_DUR);
      const e = k * k;
      c.x = c.sx + (TX - c.sx) * e;
      c.y = c.sy + (TY - c.sy) * e;
      if (k >= 1) {
        c.dead = true;
        S.xp++;
        S.coinsCollected++;
        S.chipPulse = 1; // the "blurp": chip pops
        S.floaters.push({ x: CHIP_CX + 30, y: CHIP_CY, t: 0 });
        checkLevel();
      }
    } else if (c.state === 'cannon') {
      // auto-collected: lerps into the nearest blue turret, pops gold on arrival
      const pt = nearestBlueTurret(c.x, c.y);
      if (!pt) { c.state = 'idle'; continue; } // no turrets left: coin stays put
      c.t += dt;
      const k = Math.min(1, c.t / COIN_FLY_DUR);
      const e = k * k;
      const px = pt.x + 0.5, py = pt.y + 0.5;
      c.x = c.sx + (px - c.sx) * e;
      c.y = c.sy + (py - c.sy) * e;
      if (k >= 1) {
        c.dead = true;
        S.xp++;
        S.coinsCollected++;
        S.chipPulse = 1;
        spawnBurst(px, py, '#f5b301');
        checkLevel();
      }
    }
  }
  S.coins = S.coins.filter(c => !c.dead);
  for (const f of S.floaters) f.t += dt;
  S.floaters = S.floaters.filter(f => f.t < 0.7);
  S.chipPulse = Math.max(0, S.chipPulse - dt * 3);

  // Auto-collect: every interval the nearest idle coin zips to its nearest
  // blue turret for a free +1. Tapping still sends coins to the corner chip.
  if (cfg.collectInterval > 0) {
    S.collectT += dt;
    if (S.collectT >= suctionInterval()) {
      S.collectT = 0;
      let bestC = null, bd = Infinity;
      for (const c of S.coins) {
        if (c.state !== 'idle') continue;
        const pt = nearestBlueTurret(c.x, c.y);
        if (!pt) continue;
        const d = (c.x - pt.x) * (c.x - pt.x) + (c.y - pt.y) * (c.y - pt.y);
        if (d < bd) { bd = d; bestC = c; }
      }
      if (bestC) { bestC.state = 'cannon'; bestC.sx = bestC.x; bestC.sy = bestC.y; bestC.t = 0; }
    }
  }

  // Hit-pop clock: holds full size briefly (impact reads as instant), then lerps down
  const popEnd = cfg.popHold + cfg.popDur;
  for (let i = 0; i < S.popT.length; i++) {
    const t = S.popT[i];
    if (t >= 0) S.popT[i] = t + dt >= popEnd ? -1 : t + dt;
  }

  // Chip particles: fly, gravity, shrink to nothing, then destroyed
  for (const pt of S.particles) {
    pt.t += dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += cfg.gravity * dt;
    if (pt.t >= pt.life) pt.dead = true;
  }
  S.particles = S.particles.filter(p => !p.dead);

  // Shockwave rings: expand and fade
  for (const r of S.rings) {
    r.t += dt;
    if (r.t >= RING_DUR) r.dead = true;
  }
  S.rings = S.rings.filter(r => !r.dead);

  // Damage numbers: drift up, fade fast, then gone
  for (const d of S.dmgNums) {
    d.t += dt;
    d.y -= 1.4 * dt;
    if (d.t >= d.life) d.dead = true;
  }
  S.dmgNums = S.dmgNums.filter(d => !d.dead);
}

// Draw one WHITE (terrain) cell with its hit-pop scale; popped cells are drawn
// in a second pass so the enlarged square sits in front of its neighbors.
function drawWhiteCell(x, y) {
  const i = y * cfg.cols + x;
  const c = cellRGB(x, y);
  ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  const f = popFactor(i);
  if (f > 0) {
    // hit-pop: instant 2x scale about the cell center, shoved along the
    // knockback direction; scale, offset and flash all lerp back as f -> 0
    const s = CELL_PX * (1 + f);
    const push = cfg.popPush * CELL_PX * f;
    const ox = x * CELL_PX + CELL_PX / 2 + S.popDX[i] * push;
    const oy = y * CELL_PX + CELL_PX / 2 + S.popDY[i] * push;
    ctx.fillRect(ox - s / 2, oy - s / 2, s, s);
  } else {
    ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
  }
}

// ---- Render ----
function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px: crisp on hidpi
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, view.w, view.h);
  // ---- world pass: everything through the camera ----
  ctx.save();
  ctx.translate(view.w / 2, view.h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  const w = cfg.cols, h = cfg.rows;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const st = S.cells[i];
      if (st === BLUE) { ctx.fillStyle = CELL_COLORS[BLUE]; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (st === RED) { ctx.fillStyle = CELL_COLORS[RED]; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (st === EMPTY) { ctx.fillStyle = CAVE_CSS; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (S.popT[i] < 0) drawWhiteCell(x, y); // popped cells draw in the pass below
    }
  }
  // Popped (enlarged) cells render last, in front of surrounding squares.
  // Two passes: the faint neighbor ripple first, then the hard-hit cell itself,
  // so the damaged cell always lands on top of its own shockwave.
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (S.cells[i] !== WHITE || S.popT[i] < 0) continue;
        if (pass === 0 ? S.popAmp[i] >= 1 : S.popAmp[i] < 1) continue;
        drawWhiteCell(x, y);
      }
    }
  }
  // Projectiles (with white tracer trails)
  ctx.lineCap = 'round';
  for (const p of S.projs) {
    const px = p.x * CELL_PX, py = p.y * CELL_PX;
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo((p.x - p.vx * cfg.trailT) * CELL_PX, (p.y - p.vy * cfg.trailT) * CELL_PX);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = CELL_COLORS[p.color];
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
  }
  // Coins (idle ones pulse gently so they beg to be tapped)
  for (const c of S.coins) {
    const px = c.x * CELL_PX, py = c.y * CELL_PX;
    let r = 5.5;
    if (c.state === 'idle') r += Math.sin(S.time * 4 + c.phase) * 1.2;
    else r *= 1 - 0.4 * Math.min(1, c.t / COIN_FLY_DUR);
    ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 200, 60, 0.22)'; ctx.fill(); // glow
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f5b301'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#8a5b00'; ctx.stroke();
    ctx.beginPath(); ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill(); // shine
  }
  // Chip particles (no fade: they shrink to nothing, then pop out of existence)
  for (const pt of S.particles) {
    ctx.fillStyle = pt.color;
    const s = Math.max(0.1, pt.size * (1 - pt.t / pt.life));
    ctx.fillRect(pt.x * CELL_PX - s / 2, pt.y * CELL_PX - s / 2, s, s);
  }
  // Shockwave rings
  for (const r of S.rings) {
    const k = r.t / RING_DUR;
    ctx.globalAlpha = Math.max(0, 1 - k);
    ctx.strokeStyle = r.css;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(r.x * CELL_PX, r.y * CELL_PX, 4 + k * CELL_PX * 1.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Damage numbers: bold retro white text with a dark outline, drifting up
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '12px "Press Start 2P", "Courier New", monospace';
  for (const d of S.dmgNums) {
    const k = d.t / d.life;
    ctx.globalAlpha = k < 0.25 ? 1 : 1 - (k - 0.25) / 0.75; // brief hold, then a quick fade
    const px = d.x * CELL_PX, py = d.y * CELL_PX;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(11,14,22,0.9)';
    ctx.strokeText(d.dmg, px, py);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(d.dmg, px, py);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
  // Turrets: distinct shapes per type, color = owner. HP bar when damaged.
  for (const t of S.turrets) {
    const px = (t.x + 0.5) * CELL_PX, py = (t.y + 0.5) * CELL_PX;
    const col = CELL_COLORS[t.color];
    ctx.save();
    ctx.translate(px, py);
    // base
    ctx.fillStyle = '#10141f';
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.strokeStyle = '#0b0e16';
    if (t.type === 'cannon') {
      ctx.rotate(t.angle);
      ctx.beginPath(); ctx.rect(-4, -6, 26, 12); ctx.fill(); ctx.stroke();
    } else if (t.type === 'rocket') {
      ctx.rotate(t.base);
      ctx.beginPath(); // nose cone
      ctx.moveTo(11, 0); ctx.lineTo(-3, -7); ctx.lineTo(-3, 7);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (t.type === 'laser') {
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath(); // crystal
      ctx.moveTo(0, -9); ctx.lineTo(6, 0); ctx.lineTo(0, 9); ctx.lineTo(-6, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else { // mint: a gold coin
      ctx.fillStyle = '#f5b301';
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8a5b00';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', 0, 1);
      ctx.textAlign = 'start';
    }
    ctx.restore();
    // HP bar above damaged turrets
    if (t.hp < t.maxhp) {
      const w = 24, k = Math.max(0, t.hp / t.maxhp);
      ctx.fillStyle = 'rgba(11,14,22,0.8)';
      ctx.fillRect(px - w / 2, py - 18, w, 5);
      ctx.fillStyle = k > 0.5 ? '#4ade80' : k > 0.25 ? '#f5b301' : '#ef4444';
      ctx.fillRect(px - w / 2, py - 18, w * k, 5);
    }
  }
  // Missiles: little triangles flying along their velocity
  for (const m of S.missiles) {
    ctx.save();
    ctx.translate(m.x * CELL_PX, m.y * CELL_PX);
    ctx.rotate(Math.atan2(m.vy, m.vx));
    ctx.fillStyle = CELL_COLORS[m.color];
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-5, -4.5); ctx.lineTo(-5, 4.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // Laser beams: instant cyan lines, fading fast
  for (const b of S.beams) {
    ctx.globalAlpha = Math.max(0, 1 - b.t / 0.15);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore(); // ---- end world pass; screen pass below (chip, floaters) ----
  // Coin-counter chip, top-left: the zip target. Pops on collect.
  const pulse = S.chipPulse;
  const chw = 76, chh = 26;
  ctx.save();
  ctx.translate(CHIP_CX, CHIP_CY);
  const cs = 1 + 0.3 * pulse;
  ctx.scale(cs, cs);
  ctx.translate(-CHIP_CX, -CHIP_CY);
  ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
  rr(CHIP_CX - chw / 2, CHIP_CY - chh / 2, chw, chh, 8); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#2a3145';
  rr(CHIP_CX - chw / 2, CHIP_CY - chh / 2, chw, chh, 8); ctx.stroke();
  ctx.beginPath(); ctx.arc(CHIP_CX - chw / 2 + 14, CHIP_CY, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#f5b301'; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#8a5b00'; ctx.stroke();
  ctx.fillStyle = '#dfe5f2';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('× ' + S.coinsCollected, CHIP_CX - chw / 2 + 26, CHIP_CY + 1);
  ctx.restore();
  // "+1" floaters
  for (const f of S.floaters) {
    const k = f.t / 0.7;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('+1', f.x, f.y - k * 26);
    ctx.globalAlpha = 1;
  }
}

// ---- HUD ----
function updateHud() {
  const t = cfg.thresholds;
  const lvl = S.level;
  let pct = 1, label;
  if (lvl - 1 < t.length) {
    const next = t[lvl - 1];
    const prev = lvl > 1 ? t[lvl - 2] : 0;
    pct = Math.min(1, Math.max(0, (S.xp - prev) / (next - prev)));
    label = `LV ${lvl} &nbsp;·&nbsp; ${S.xp}/${next} XP`;
  } else {
    label = `LV ${lvl} &nbsp;·&nbsp; MAX (${S.xp} XP)`;
  }
  xpfill.style.width = (pct * 100).toFixed(1) + '%';
  xplabel.innerHTML = label;

  // Debug stats (throttled by caller)
  let white = 0, empty = 0;
  const cells = S.cells;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === WHITE) white++;
    else empty++;
  }
  const effFreq = (cfg.freq * S.freqMult).toFixed(2);
  let blues = 0, reds = 0;
  for (const t of S.turrets) {
    if (t.dead) continue;
    if (t.color === BLUE) blues++; else reds++;
  }
  statsEl.innerHTML =
    `<div><span class="swatch" style="background:#eef1f6"></span>Wall blocks: <b>${white}</b></div>` +
    `<div><span class="swatch" style="background:#222839"></span>Open space: <b>${empty}</b></div>` +
    `<div>Wave: <b>${S.wave}</b> · Your turrets: <b>${blues}</b> · Enemy: <b>${reds}</b>${S.redQueue.length ? ` (+${S.redQueue.length} incoming)` : ''}</div>` +
    `<div>Blocks excavated: <b>${S.destroyed}</b> · Red turrets destroyed: <b>${S.redKills}</b></div>` +
    `<div>Map seed: <b>${S.seed}</b></div>` +
    `<div>Fire rate: <b>${effFreq}/s</b> (×${S.freqMult.toFixed(2)}) · Damage: <b>+${S.dmgBonus}</b> · Steering: <b>×${S.steerMult.toFixed(2)}</b></div>` +
    `<div>Bounce chance: <b>${Math.round(S.bounceChance * 100)}%</b> · Suction every: <b>${suctionInterval().toFixed(1)}s</b></div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b> · Missiles: <b>${S.missiles.length}</b></div>` +
    `<div>Coins: <b>${S.coins.length}</b> on field · <b>${S.coinsCollected}</b> collected</div>`;
}

// ---- Main loop ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!S.paused) update(dt);
  render();
  S.frame++;
  if (S.frame % 2 === 0 || S.paused) updateHud(); // XP bar stays live
  requestAnimationFrame(frame);
}

// ---- Debug wiring: any change restarts the game ----
[inCols, inRows, inSpeed, inFreq, inArc, inTurn, inBounce, inCave, inCoin, inCollect, inSeed, inThresh,
 inPopHold, inPopDur, inPopPush, inRipple, inTrail, inGravity].forEach(el => {
  el.addEventListener('change', newGame);
});
document.getElementById('d-restart').addEventListener('click', newGame);

// ---- Camera controls: 1-finger drag pans, 2-finger pinch zooms, tap hits coins ----
// touch-action:none on the canvas stops the page scrolling/zooming underneath.
function tapCoin(sx, sy) {
  const wpt = screenToWorld(sx, sy);
  const cx = wpt.x / CELL_PX, cy = wpt.y / CELL_PX;
  for (let i = S.coins.length - 1; i >= 0; i--) {
    const c = S.coins[i];
    if (c.state !== 'idle') continue;
    const dx = c.x - cx, dy = c.y - cy;
    if (dx * dx + dy * dy < 0.81) { // 0.9-cell tap radius
      c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
      break;
    }
  }
}
const pointers = new Map(); // pointerId -> {x, y} in client px
let pinchD0 = 0;
let downPos = null, panning = false;
const TAP_SLOP = 8; // px: below this, a press is a tap, not a pan
canvas.addEventListener('pointerdown', (e) => {
  if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) { downPos = { x: e.clientX, y: e.clientY }; panning = false; }
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchD0 = Math.hypot(a.x - b.x, a.y - b.y);
    downPos = null; panning = false; // a second finger cancels the tap
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    if (!panning && downPos &&
        Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > TAP_SLOP) panning = true;
    if (panning) { cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom; clampCamera(); }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchD0 > 0 && d > 0) {
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, cam.zoom * (d / pinchD0));
    }
    pinchD0 = d;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (downPos && !panning) {
      if (S.placing) placeTurretAt(downPos.x, downPos.y); // placement eats the tap
      else tapCoin(downPos.x, downPos.y);
    }
    downPos = null; panning = false;
  } else if (pointers.size === 1) {
    // pinch -> one finger: re-anchor so the remaining finger doesn't jump
    const [p] = [...pointers.values()];
    downPos = { x: p.x, y: p.y }; panning = false;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// Desktop: wheel zooms around the cursor; drag pans (same pointer logic as touch)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, cam.zoom * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// ---- Mobile: collapsible debug panel (button only visible under 720px) ----
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug');
if (debugToggle && debugPanel) {
  debugToggle.addEventListener('click', () => debugPanel.classList.toggle('collapsed'));
  if (window.innerWidth < 720) debugPanel.classList.add('collapsed'); // start tucked away on phones
}

// ---- Share link: encode the whole debug config into the URL ----
function applyUrlParams() {
  if (typeof location === 'undefined' || !location.search) return;
  const q = new URLSearchParams(location.search);
  const map = { cols: inCols, rows: inRows, speed: inSpeed, freq: inFreq, arc: inArc,
    turn: inTurn, bounce: inBounce, cave: inCave, seed: inSeed, coin: inCoin, collect: inCollect,
    pophold: inPopHold, popdur: inPopDur,
    poppush: inPopPush, ripple: inRipple, trail: inTrail, gravity: inGravity, thresh: inThresh };
  for (const k of Object.keys(map)) if (q.has(k)) map[k].value = q.get(k);
}
function flashButton(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1200);
}
document.getElementById('d-copylink').addEventListener('click', () => {
  readDebug();
  const q = new URLSearchParams({
    cols: cfg.cols, rows: cfg.rows, speed: cfg.projSpeed, freq: cfg.freq, arc: cfg.arc,
    turn: cfg.turnRate, bounce: cfg.bounceChance, cave: cfg.caveChance, seed: inSeed.value.trim(), coin: cfg.coinChance,
    collect: cfg.collectInterval, pophold: cfg.popHold, popdur: cfg.popDur, poppush: cfg.popPush,
    ripple: cfg.rippleAmp, trail: cfg.trailT, gravity: cfg.gravity, thresh: cfg.thresholds.join(','),
  });
  const url = location.origin + location.pathname + '?' + q.toString();
  const btn = document.getElementById('d-copylink');
  navigator.clipboard.writeText(url).then(
    () => flashButton(btn, 'Copied!'),
    () => flashButton(btn, 'Copy failed'));
});

applyUrlParams();
newGame();
requestAnimationFrame(frame);
