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
const GROW_INTERVAL = 5;            // Bloom: seconds per growth increment (x S.bloomMult)
const GROW_STEPS = 5;              // increments to turn a cell into territory
const BLOOM_RADIUS = 8;            // Bloom: how far (cells) it reaches for empty ground
const HARVEST_EVERY = 8;           // territory: seconds between pickups per cell

// Turret roster: distinct damage patterns, no homing except the missile's
// steering (which is deliberately dumb: limited turn rate, walls win).
const GATHER_BASE_RANGE = 6;         // pickup pull range in cells
const GATHER_RANGE_PER_LEVEL = 2;    // +range per Gather level
const GATHER_COOLDOWN = 6;           // seconds between pulls
const GATHER_FLASH_DUR = 1.5;        // range ring flash duration on pull (s)
// Shared icons (emoji) for weapons/passives — used in cards and HUD badges.
const ICONS = {
  cannon: '🔺', rocket: '🚀', laser: '💎', bloom: '🌱', lantern: '🏮',
  gather: '🧲', bounce: '⚡', steer: '🚀',
};
const TURRET = {
  cannon: { name: 'Cannon', hp: 8, interval: 1.0, dmg: 1 },
  rocket: { name: 'Rocket', hp: 6, interval: 2.5, dmg: 3 },
  laser:  { name: 'Laser',  hp: 5, interval: 2.0, dmg: 2 },
  bloom:  { name: 'Bloom',  hp: 4, interval: GROW_INTERVAL, dmg: 0 },
  lantern:{ name: 'Lantern',hp: 4, interval: 0, dmg: 0 }, // pure vision, no firing
  gather: { name: 'Gather', hp: 5, interval: GATHER_COOLDOWN, dmg: 0 }, // pulls pickups in range
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
const inTerrain = document.getElementById('d-terrain');
const inEmpty = document.getElementById('d-empty');
const inFogDist = document.getElementById('d-fogdist');
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
function resetCamera() {
  // New games start fully zoomed out: the whole map, fog and all.
  cam.zoom = minZoom();
  cam.x = (cfg.cols * CELL_PX) / 2;
  cam.y = (cfg.rows * CELL_PX) / 2;
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

// ---- Block colors: terrain gradient (weak -> strong), tinted toward damage ----
// The base colors come from the debug pickers (green terrain, brown empty);
// the gradient is rebuilt whenever they change.
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
let TERRAIN_LIGHT = [76, 175, 80];
let TERRAIN_DARK = [29, 67, 30];
let TERRAIN = [];
let CAVE_CSS = '#4caf50';
let CAVE_RGB = [76, 175, 80];
let CAVE_SHADES = [];
function rebuildColors() {
  const base = hexToRgb(inTerrain.value || '#6b543a');
  TERRAIN_LIGHT = base;
  TERRAIN_DARK = base.map(v => Math.round(v * 0.38));
  TERRAIN = [];
  for (let m = 3; m <= 10; m++) {
    const t = (m - 3) / 7;
    TERRAIN[m] = [0, 1, 2].map(j => Math.round(TERRAIN_LIGHT[j] + (TERRAIN_DARK[j] - TERRAIN_LIGHT[j]) * t));
  }
  CAVE_CSS = inEmpty.value || '#4caf50';
  CAVE_RGB = hexToRgb(CAVE_CSS);
  // Empty caves get Perlin shades too (purely visual — no gameplay effect).
  const caveDark = CAVE_RGB.map(v => Math.round(v * 0.55));
  CAVE_SHADES = [];
  for (let s = 0; s < 8; s++) {
    const t = s / 7;
    CAVE_SHADES[s] = [0, 1, 2].map(j => Math.round(CAVE_RGB[j] + (caveDark[j] - CAVE_RGB[j]) * t));
  }
}
const BLUE_RGB = [59, 130, 246];
const RED_RGB = [239, 68, 68];

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
  if (st === EMPTY) return CAVE_SHADES[S.shade[i] || 0];
  const max = S.maxhp[i] || 3, hpv = S.hp[i];
  const base = TERRAIN[max];
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
function spawnDmgNum(x, y, dmg, crit) {
  S.dmgNums.push({ x: x + (Math.random() - 0.5) * 0.5, y, t: 0, life: 0.6, dmg, crit: !!crit, dead: false });
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
  cfg = {
    cols, rows,
    projSpeed: clampNum(inSpeed.value, 40, 2000, 200),   // px/s
    freq: clampNum(inFreq.value, 0.1, 20, 1),            // shots/s (both cannons)
    arc: clampNum(inArc.value, 0, 360, 120),             // degrees
    turnRate: clampNum(inTurn.value, 0, 720, 100),          // cannon sweep speed (deg/s)
    bouncePerLevel: clampNum(inBounce.value, 0, 1, 0.12),     // bounce chance per passive level
    caveChance: clampNum(inCave.value, 0, 0.95, 0.38),      // CA cave fill
    coinChance: clampNum(inCoin.value, 0, 1, 0.3),          // coin drop per block excavated by blue
    popHold: clampNum(inPopHold.value, 0, 0.5, 0.03),        // big square hold time (s)
    popDur: clampNum(inPopDur.value, 0.05, 1, 0.1),          // pop shrink time (s)
    popPush: clampNum(inPopPush.value, 0, 1.5, 0.2),         // knockback push (cells)
    rippleAmp: clampNum(inRipple.value, 0, 1, 0.1),          // neighbor shockwave strength
    trailT: clampNum(inTrail.value, 0, 1, 0.1),               // projectile trail (s)
    gravity: clampNum(inGravity.value, 0, 40, 9),            // particle gravity (cells/s^2)
    fogDist: clampNum(inFogDist.value, 0, 20, 6),              // fog reveal distance (cells)
  };
  // reflect clamped values back into the panel
  inCols.value = cols; inRows.value = rows;
  inSpeed.value = cfg.projSpeed; inFreq.value = cfg.freq;
  inArc.value = cfg.arc; inCave.value = cfg.caveChance;
  inTurn.value = cfg.turnRate;
  inBounce.value = cfg.bouncePerLevel;
  inCoin.value = cfg.coinChance;
  inPopHold.value = cfg.popHold; inPopDur.value = cfg.popDur;
  inPopPush.value = cfg.popPush; inRipple.value = cfg.rippleAmp;
  inTrail.value = cfg.trailT;
  inGravity.value = cfg.gravity;
  inFogDist.value = cfg.fogDist;
  rebuildColors();
}

// ---- Meta progression (persisted): gold + weapon unlocks ----------------
// Gold is earned from territory fields and persists across runs. Weapons
// cost gold to unlock; only unlocked weapons can start a run or appear
// in level-up drafts.
const UNLOCK_COST = { rocket: 20, laser: 30, bloom: 40, lantern: 10 }; // cannon is free
const meta = { gold: 0, unlocks: { cannon: true, rocket: false, laser: false, bloom: false, lantern: false } };
function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem('tis_meta'));
    if (m && typeof m.gold === 'number') meta.gold = m.gold;
    if (m && m.unlocks) for (const k of Object.keys(meta.unlocks)) meta.unlocks[k] = !!m.unlocks[k];
  } catch (e) { /* fresh save */ }
}
function saveMeta() {
  try { localStorage.setItem('tis_meta', JSON.stringify(meta)); } catch (e) { /* ignore */ }
}
// The starter weapon for the next run (chosen on the pre-game screen).
let starterType = 'cannon';

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
  const w = color === BLUE && S.weapons[type] ? S.weapons[type] : null;
  const maxhp = Math.max(1, Math.round(spec.hp * hpScale)) + (w && w.hpBonus ? w.hpBonus : 0);
  return { x, y, color, type, hp: maxhp, maxhp, base, angle: base, dir: 1,
           cd: Math.random(), dead: false, coolT: 0 };
}
// Gather pull range in cells, from its weapon level.
function gatherRange() {
  const w = S.weapons.gather;
  const lv = w ? w.level : 1;
  return GATHER_BASE_RANGE + (lv - 1) * GATHER_RANGE_PER_LEVEL;
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
  // Bank the previous run's gold into the outer total.
  let banked = 0;
  if (S && S.gold > 0) {
    banked = S.gold;
    meta.gold += banked;
    saveMeta();
  }
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
  const shade = new Uint8Array(n); // Perlin shade index (0..7) for empty cells — visual only
  const goldNug = new Uint8Array(n); // 1 = gold nugget locked in this rock cell
  S = { cells, hp, maxhp, hitBy, popT, popAmp, popCol, popDX, popDY, projs: [], xp: 0, level: 1, pending: 0,
        freqMult: 1, paused: false, frame: 0, seed, shade, goldNug,
        coins: [], floaters: [], gold: 0, chipPulse: 0, time: 0, lastBanked: banked,
        // XP bar animation: xpShown eases toward xp; level-up cards wait
        // for the bar to finish filling.
        xpShown: 0, awaitingLevel: false,
        // weapons (VS-style): per-type level + stat mults. Picking a card
        // for an owned weapon levels it up instead of placing a new one.
        weapons: {},
        particles: [], particlesSpawned: 0, rings: [], dmgNums: [],
        destroyed: 0, destroyedBlue: 0,
        bounceChance: 0,
        // passives (VS-style): level 0 = not owned, max 8. Proposed once
        // active; upgrades stop at 8.
        passives: { bounce: 0 },
        // auto-battler state
        turrets: [], missiles: [], beams: [],
        wave: 0, redQueue: [], redTimer: 0, waveBreak: 0, redKills: 0,
        placing: null, runOver: false,
        dmgBonus: 0, steerMult: 1,
        // territory (Tiberium fields): per-cell growth progress
        growN: new Uint8Array(n), growBy: new Uint8Array(n), growT: new Float32Array(n),
        bloomMult: 1, harvT: new Float32Array(n),
        // fog of war: 0 = clear, 1 = half, 2 = full (black)
        fog: new Uint8Array(n).fill(2) };

  // Caves first (cellular-automata blobs), then HP from a smooth noise gradient:
  // white ~3 hits ... dark grey ~10 hits
  const cave = genCaves(cfg.cols, cfg.rows, cfg.caveChance, rng);
  const noise = makeNoise2D(rng);
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      // Visual shade for empty cells (Perlin, no gameplay effect).
      shade[i] = Math.round(noise((x / cfg.cols) * 4.5 + 10, (y / cfg.rows) * 4.5 + 10) * 7);
      if (cave[i]) { cells[i] = EMPTY; continue; }
      cells[i] = WHITE;
      const m = 3 + Math.round(noise((x / cfg.cols) * 3.5, (y / cfg.rows) * 3.5) * 7);
      maxhp[i] = m; hp[i] = m;
    }
  }

  // Gold nuggets: 1% of rock cells seed a cluster of 1-5 contiguous cells.
  // The gold is locked until the rock is broken.
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (cells[i] !== WHITE || goldNug[i] || rng() >= 0.01) continue;
      const size = 1 + Math.floor(rng() * 5);
      let cx = x, cy = y;
      for (let s = 0; s < size; s++) {
        const ci = cy * cfg.cols + cx;
        if (cells[ci] === WHITE) goldNug[ci] = 1;
        const d = Math.floor(rng() * 4);
        cx = Math.max(0, Math.min(cfg.cols - 1, cx + [1, -1, 0, 0][d]));
        cy = Math.max(0, Math.min(cfg.rows - 1, cy + [0, 0, 1, -1][d]));
      }
    }
  }

  // The player's Cannon spawns inside a cave near the bottom-left anchor —
  // chipping away at cave walls feels better than painting open ground.
  // Red comes in waves after that (see startWave).
  const pA = { x: cfg.cols * 0.15, y: cfg.rows * 0.85 };
  const pi = nearestCave(pA.x, pA.y, -1);
  const pc = pi >= 0 ? { x: pi % cfg.cols, y: Math.floor(pi / cfg.cols) } : snapAnchor(pA);
  const pci = pc.y * cfg.cols + pc.x;
  if (S.cells[pci] !== EMPTY) {
    // The starter always gets open ground: clear its cell (the snapAnchor
    // fallback can land on terrain when there are no caves at all).
    S.cells[pci] = EMPTY;
    S.hp[pci] = 0; S.maxhp[pci] = 0;
  }
  S.turrets.push(mkTurret(pc.x, pc.y, BLUE, starterType));
  S.weapons[starterType] = { level: 1, rateMult: 1, dmgBonus: 0, critChance: 0 };
  // Red Bloom: 60% chance to spawn in a distant cave (not the starter's).
  // It grows red territory — a reason to push out and kill it.
  if (rng() < 0.6) {
    const far = [];
    for (let y = 0; y < cfg.rows; y++) {
      for (let x = 0; x < cfg.cols; x++) {
        const i = y * cfg.cols + x;
        if (cells[i] !== EMPTY) continue;
        const dx = x - pc.x, dy = y - pc.y;
        if (dx * dx + dy * dy > 400) far.push({ x, y }); // >20 cells away
      }
    }
    if (far.length) {
      const spot = far[Math.floor(rng() * far.length)];
      S.turrets.push(mkTurret(spot.x, spot.y, RED, 'bloom'));
    }
  }
  startWave(1);
  computeFog();   // fog of war: only the home cave + fogDist is visible

  resize();       // backing store = viewport x devicePixelRatio
  resetCamera();  // fully zoomed out

  overlay.classList.add('hidden');
  runover.classList.add('hidden');
  placebanner.classList.add('hidden');
  wavebanner.classList.add('hidden');
  updateHud();
}

// ---- Fog of war --------------------------------------------------------
// 0 = clear, 1 = half (smooth transition), 2 = full (black).
// Reveal sources: every cave containing a blue turret (flood-filled through
// EMPTY, plus fogDist beyond the boundary) and a fogDist radius around each
// lantern. Recomputed whenever the cave changes (a block is excavated) or a
// lantern is placed. Fog only ever clears, never closes back in.
function computeFog() {
  const W = cfg.cols, H = cfg.rows, n = W * H;
  const nf = new Uint8Array(n).fill(2);
  const R = cfg.fogDist, R2 = R * R, R12 = (R + 1) * (R + 1);
  const revealDisc = (cx, cy) => {
    for (let dy = -(R + 1); dy <= R + 1; dy++) {
      for (let dx = -(R + 1); dx <= R + 1; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R12) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (d2 <= R2) nf[ni] = 0;
        else if (nf[ni] === 2) nf[ni] = 1;
      }
    }
  };
  // Home caves: flood-fill EMPTY from each living blue turret.
  const home = new Uint8Array(n);
  const stack = [];
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    const i = t.y * W + t.x;
    if (S.cells[i] === EMPTY && !home[i]) { home[i] = 1; stack.push(i); }
  }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (stack.length) {
    const i = stack.pop();
    revealDisc(i % W, (i / W) | 0);
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (S.cells[ni] === EMPTY && !home[ni]) { home[ni] = 1; stack.push(ni); }
    }
  }
  // Lanterns push back the dark in a radius.
  for (const t of S.turrets) {
    if (t.dead || t.type !== 'lantern') continue;
    revealDisc(t.x, t.y);
  }
  // Merge: fog only ever clears.
  for (let i = 0; i < n; i++) if (nf[i] < S.fog[i]) S.fog[i] = nf[i];
}

// ---- Waves: red deploys over time, mid-map. Clear them all -> jackpot. ----
// Early-game focus: no enemy units for now.
const ENEMIES_ENABLED = false;
function startWave(n) {
  if (!ENEMIES_ENABLED) return;
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
      'Gold <b>' + meta.gold + '</b>';
    runover.classList.remove('hidden');
  }
}

// ---- Firing ----
function fireTurret(t) {
  const speed = cfg.projSpeed / CELL_PX; // cells per second
  const mx = t.x + 0.5 + Math.cos(t.angle) * 1.1;
  const my = t.y + 0.5 + Math.sin(t.angle) * 1.1;
  let dmg = TURRET.cannon.dmg + S.dmgBonus + weaponDmgBonus(t);
  let crit = false;
  const w = t.color === BLUE ? S.weapons.cannon : null;
  if (w && w.critChance > 0 && Math.random() < w.critChance) {
    dmg *= 2 + Math.floor(Math.random() * 2); // 2x or 3x, whole numbers
    crit = true;
  } else {
    // Damage variance (non-crit): sometimes +1, rarely +2 over base.
    const r = Math.random();
    if (r < 0.05) dmg += 2;
    else if (r < 0.25) dmg += 1;
  }
  S.projs.push({
    x: mx, y: my,
    vx: Math.cos(t.angle) * speed,
    vy: Math.sin(t.angle) * speed,
    color: t.color,
    dmg, crit,
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
    dmg: TURRET.rocket.dmg + S.dmgBonus + weaponDmgBonus(t),
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
      if (S.cells[i] !== WHITE || S.fog[i] !== 0) continue; // can't snipe what you can't see
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
  damageBlock(tgt.i, TURRET.laser.dmg + S.dmgBonus + weaponDmgBonus(t), t.color,
              t.x + 0.5, t.y + 0.5, tgt.x - t.x, tgt.y - t.y);
}
// Bloom: Tiberium-style territory. Every interval it makes one growth
// increment on the nearest empty cell in radius (preferring cells it has
// already started). GROW_STEPS increments turn the cell into solid territory
// of the Bloom's color, which then generates coins on harvest ticks.
// Progress persists if the Bloom dies — another Bloom can finish the job.
function bloomGrowth(t) {
  let bx = -1, by = -1, bd = Infinity;
  for (let dy = -BLOOM_RADIUS; dy <= BLOOM_RADIUS; dy++) {
    for (let dx = -BLOOM_RADIUS; dx <= BLOOM_RADIUS; dx++) {
      const nx = t.x + dx, ny = t.y + dy;
      if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) continue;
      const ni = ny * cfg.cols + nx;
      if (S.cells[ni] !== EMPTY || S.growN[ni] >= GROW_STEPS) continue;
      if (t.color === BLUE && S.fog[ni] !== 0) continue; // blue blooms only work in visible territory
      if (S.growBy[ni] !== 0 && S.growBy[ni] !== t.color) continue;
      if (turretAt(nx, ny)) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bx = nx; by = ny; }
    }
  }
  if (bx < 0) return; // no open ground in reach
  const bi = by * cfg.cols + bx;
  S.growN[bi]++;
  S.growBy[bi] = t.color;
  S.growT[bi] = S.time; // drives the newest dot's pop-in
  if (S.growN[bi] >= GROW_STEPS) {
    // Bloomed: the cell becomes solid territory.
    S.cells[bi] = t.color;
    S.growN[bi] = 0; S.growBy[bi] = 0;
    spawnBurst(bx + 0.5, by + 0.5, CELL_COLORS[t.color]);
    S.rings.push({ x: bx + 0.5, y: by + 0.5, t: 0, css: CELL_COLORS[t.color], dead: false });
    // A finished bloom drops a pickup: usually XP, sometimes gold.
    if (t.color === BLUE) {
      const kind = Math.random() < 0.2 ? 'gold' : 'xp';
      S.coins.push({ x: bx + 0.5, y: by + 0.5, state: 'idle', kind,
                     phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
      if (S.coins.length > 800) {
        const i = S.coins.findIndex(c => c.state === 'idle');
        if (i >= 0) S.coins.splice(i, 1);
      }
    }
  }
}
// Deterministic dot position for growth increment k of a cell: the k-th
// circle always plops in the same spot, so the field visibly accumulates.
function growthDotPos(idx, k) {
  let h = (idx * 31 + k * 17 + 7) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  const u = (h >>> 0) % 1000 / 1000, v = ((h >>> 10) % 1000) / 1000;
  return [0.22 + u * 0.56, 0.22 + v * 0.56];
}
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
// Any live coin sitting on a grid cell (so the harvest never stacks coins).
function coinAt(cx, cy) {
  for (const c of S.coins) {
    if (c.dead) continue;
    if (Math.floor(c.x) === cx && Math.floor(c.y) === cy) return true;
  }
  return false;
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
      const destroyed = damageBlock(idx, p.dmg || 1, p.color, p.x, p.y, p.vx, p.vy, p.crit);
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
    if (cell === EMPTY || cell === p.color) continue; // pass through open + own color
    // Enemy territory: bomb it back to empty. This is why fields need guards.
    S.cells[idx] = EMPTY;
    S.growN[idx] = 0; S.growBy[idx] = 0;
    spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[cell]);
    spawnChip(cx + 0.5, cy + 0.5, CELL_COLORS[cell], p.vx, p.vy);
    p.dead = true; return;
  }
}

// Damage a WHITE block: pop, ripple, chips, damage number, maybe destroy.
// (sx, sy) = impact source (for knockback direction); (vx, vy) = spray direction.
// Returns true when the block was destroyed.
function damageBlock(idx, dmg, color, sx, sy, vx, vy, crit) {
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
    spawnDmgNum(cx + 0.5, cy + 0.2, dmg, crit); // the damage dealt floats up
    return false;
  }
  S.cells[idx] = EMPTY; // excavated: the block is gone, not painted over
  S.destroyed++;
  if (color === BLUE) S.destroyedBlue++;
  computeFog(); // the cave grew: push the fog boundary out
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[color]); // the block cracks: debris + ring
  if (S.goldNug[idx]) {
    // Gold nugget released: locked until the rock was broken.
    S.goldNug[idx] = 0;
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind: 'gold',
                   phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
    if (S.coins.length > 800) { // safety valve: drop oldest idle coin
      const i = S.coins.findIndex(c => c.state === 'idle');
      if (i >= 0) S.coins.splice(i, 1);
    }
  }
  if (color === BLUE && Math.random() < cfg.coinChance) {
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind: 'xp',
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
  // The update loop queues the level-up once the XP bar finishes animating
  // to the threshold; this just refreshes the HUD.
  updateHud();
}

// Card pool: 4 turret cards (placement = the skill expression) + 5 upgrades.
// `needs` gates an upgrade on owning a turret it actually affects — no
// steering card before you've got a rocket.
const CARD_POOL = [
  { kind: 'turret', type: 'cannon', title: 'Cannon', icon: ICONS.cannon, sub: 'Sweeps shots in an arc, blasting rock.' },
  { kind: 'turret', type: 'rocket', title: 'Rocket', icon: ICONS.rocket, sub: 'Fires homing missiles that crash and splash-dig.' },
  { kind: 'turret', type: 'laser', title: 'Laser', icon: ICONS.laser, sub: 'Zaps the weakest visible block.' },
  { kind: 'turret', type: 'bloom', title: 'Bloom', icon: ICONS.bloom, sub: 'Grows territory that harvests gold coins.' },
  { kind: 'turret', type: 'lantern', title: 'Lantern', icon: ICONS.lantern, sub: 'Pushes back the fog of war.' },
  { kind: 'turret', type: 'gather', title: 'Gather', icon: ICONS.gather, sub: 'Pulls in nearby pickups.' },
  // (no global fire-rate / damage cards — weapon levels are the single
  // linear upgrade track: each level is +10% rate, +1 damage, or +5% crit)
  { kind: 'passive', passive: 'bounce', title: 'Bounce', icon: ICONS.bounce, sub: 'Shots ricochet off rock.', needs: ['cannon'] },
  { kind: 'steer', mult: 1.3, title: '+30%', icon: ICONS.steer, sub: 'Missile steering', needs: ['rocket'] },
  { kind: 'bloom', mult: 0.8, title: '+25%', icon: ICONS.bloom, sub: 'Bloom grow frequency', needs: ['bloom'] },
];
function hasTurretTypes(types) {
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    if (types.includes(t.type)) return true;
  }
  return false;
}
function availableCards() {
  // Locked weapons never appear in a run's drafts. Passives are proposed
  // until maxed (level 8); the obtain (level 1) is how you get them.
  return CARD_POOL.filter(c =>
    (!c.needs || hasTurretTypes(c.needs)) &&
    (c.kind !== 'turret' || c.type === 'bloom' || c.type === 'gather' || meta.unlocks[c.type]) &&
    (c.kind !== 'passive' || S.passives[c.passive] < 8));
}
function offerCards() {
  const pool = availableCards().slice();
  const els = document.querySelectorAll('.card');
  // Clear previous deal animation.
  els.forEach(el => el.classList.remove('dealt'));
  for (let k = 0; k < els.length && pool.length; k++) {
    const p = pool.splice((Math.random() * pool.length) | 0, 1)[0];
    const el = els[k];
    el.dataset.kind = p.kind;
    el.dataset.type = p.type || '';
    el.dataset.mult = p.mult || '';
    el.dataset.add = p.add || '';
    el.dataset.passive = p.passive || '';
    el.dataset.stat = '';
    const lv = p.kind === 'passive' ? S.passives[p.passive] : 0;
    let title = p.title, sub = p.sub, newTag = '';
    const icon = `<div class="icon">${p.icon || ''}</div>`;
    // VS-style: first time bringing it into the run gets a yellow "New!" tag,
    // separate from the name.
    if (p.kind === 'passive' && lv === 0) newTag = '<span class="newtag">New!</span>';
    else if (p.kind === 'passive' && lv > 0) {
      title = `${p.title} <span class="lv">Lv${lv + 1}</span>`;
      // Show the stat change, not just the description.
      if (p.passive === 'bounce') sub = `+${Math.round(cfg.bouncePerLevel * 100)}% bounce chance`;
    }
    else if (p.kind === 'turret' && !S.weapons[p.type]) newTag = '<span class="newtag">New!</span>';
    else if (p.kind === 'turret' && S.weapons[p.type]) {
      // Owned weapon: usually a level-up, sometimes a fresh placement
      // (so you can field a second cannon, not just a stronger one).
      const w = S.weapons[p.type];
      if (Math.random() < 0.3) {
        title = p.title;
        sub = 'New turret';
        el.dataset.stat = 'place';
      } else {
        // Level-up: roll the stat now so the card shows exactly what
        // you'll get — "Cannon Lv2 / +20% FIRE RATE". Stats fit the weapon:
        // Bloom grows faster, Lantern gets tougher.
        title = `${p.title} <span class="lv">Lv${w.level + 1}</span>`;
        let stat;
        if (p.type === 'bloom') {
          stat = 'rate'; sub = '+20% growth speed';
        } else if (p.type === 'lantern') {
          stat = 'hp'; sub = '+2 max HP';
        } else if (p.type === 'gather') {
          stat = 'range'; sub = `+${GATHER_RANGE_PER_LEVEL} pickup range`;
        } else if (p.type === 'cannon') {
          const roll = Math.random();
          if (roll < 1 / 3) { stat = 'rate'; sub = '+20% fire rate'; }
          else if (roll < 2 / 3) { stat = 'dmg'; sub = '+1 damage'; }
          else { stat = 'crit'; sub = '+5% crit chance'; }
        } else {
          if (Math.random() < 0.5) { stat = 'rate'; sub = '+20% fire rate'; }
          else { stat = 'dmg'; sub = '+1 damage'; }
        }
        el.dataset.stat = stat;
      }
    }
    el.innerHTML = icon + newTag + '<b>' + title + '</b><span>' + sub + '</span>';
    // Staggered deal: cards appear one by one (prevents accidental taps).
    setTimeout(() => el.classList.add('dealt'), 150 + k * 120);
  }
}

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    const kind = card.dataset.kind || 'freq';
    if (kind === 'turret') {
      const type = card.dataset.type;
      const w = S.weapons[type];
      if (w && card.dataset.stat !== 'place') {
        // Owned: apply the level-up the card promised (rolled at offer time).
        w.level++;
        const stat = card.dataset.stat || 'dmg';
        if (stat === 'rate') w.rateMult *= 1.2;
        else if (stat === 'crit') w.critChance = Math.min(1, (w.critChance || 0) + 0.05);
        else if (stat === 'hp') {
          w.hpBonus = (w.hpBonus || 0) + 2;
          for (const t of S.turrets) {
            if (!t.dead && t.color === BLUE && t.type === type) { t.maxhp += 2; t.hp += 2; }
          }
        }
        else if (stat === 'range') { /* range derives from w.level via gatherRange() */ }
        else w.dmgBonus += 1;
        S.pending--;
        if (S.pending <= 0) {
          S.pending = 0;
          S.paused = false;
          overlay.classList.add('hidden');
        }
        updateHud();
        return;
      }
      // Placement mode: tap the map to deploy. The game stays paused until
      // the turret is down — no cancel, there's always room somewhere.
      S.pending--;
      overlay.classList.add('hidden');
      updateHud();
      enterPlacement(type);
      return;
    }
    if (kind === 'passive') {
      const p = card.dataset.passive;
      if (S.passives[p] < 8) {
        S.passives[p]++;
        if (p === 'bounce') S.bounceChance = Math.min(0.95, S.passives.bounce * cfg.bouncePerLevel);
      }
    } else if (kind === 'steer') {
      S.steerMult *= parseFloat(card.dataset.mult);
    } else if (kind === 'bloom') {
      S.bloomMult = Math.max(0.2, S.bloomMult * parseFloat(card.dataset.mult));
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
function enterPlacement(type) {  S.placing = { type }; S.placePreview = null;
  placebanner.innerHTML = 'Tap the map to deploy <b>' + TURRET[type].name + '</b>';
  placebanner.classList.remove('hidden');
}
function placeTurretAt(sx, sy) {
  const type = S.placing.type;
  const wpt = screenToWorld(sx, sy);
  let cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  cx = Math.max(0, Math.min(cfg.cols - 1, cx));
  cy = Math.max(0, Math.min(cfg.rows - 1, cy));
  if (turretAt(cx, cy)) {
    // Occupied: red ring says no, placement mode stays on.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  const pi = cy * cfg.cols + cx;
  if (S.fog[pi] !== 0) {
    // Units can only be placed in fully-revealed cells.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  if (type === 'lantern') {
    // Lanterns sit on any visible ground: empty or terrain. No pad clearing.
  } else {
    // Combat units and Blooms need open ground.
    if (S.cells[pi] !== EMPTY) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    S.cells[pi] = EMPTY; // clear a pad
  }
  S.turrets.push(mkTurret(cx, cy, BLUE, type));
  if (!S.weapons[type]) S.weapons[type] = { level: 1, rateMult: 1, dmgBonus: 0, critChance: 0 };
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[BLUE]);
  if (type === 'lantern') computeFog(); // the lantern pushes back the dark
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

// ---- Update ----
// Per-type weapon stats (blue only; reds use base stats).
function weaponRateMult(t) {
  return (t.color === BLUE && S.weapons[t.type]) ? S.weapons[t.type].rateMult : 1;
}
function weaponDmgBonus(t) {
  return (t.color === BLUE && S.weapons[t.type]) ? S.weapons[t.type].dmgBonus : 0;
}
// XP needed to go from the current level to the next: linear, +1 per level
// (3, 4, 5...). XP resets to zero on every level-up.
function xpNeed() { return S.level + 2; }
function update(dt) {
  const arcRad = (cfg.arc * Math.PI) / 180;
  const turnRate = (cfg.turnRate * Math.PI) / 180; // rad/s
  // XP bar animates toward the true XP (full bar in ~0.6s); the level-up
  // cards wait until the bar finishes filling.
  if (S.xpShown < S.xp) {
    const need = xpNeed();
    S.xpShown = Math.min(S.xp, S.xpShown + (need / 0.6) * dt);
  }
  if (!S.awaitingLevel && S.xp >= xpNeed()) S.awaitingLevel = true;
  if (S.awaitingLevel && S.xpShown >= xpNeed()) {
    S.awaitingLevel = false;
    S.level++;
    S.xp = 0; S.xpShown = 0; // reset for the next level
    S.pending++;
    S.paused = true;
    offerCards();
    overlay.classList.remove('hidden');
    updateHud();
  }
  for (const t of S.turrets) {
    if (t.dead) continue;
    const rateMult = cfg.freq * (t.color === BLUE ? S.freqMult : 1) * weaponRateMult(t);
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
      // Jittered interval: a fixed cadence phase-locks to the sweep arc and
      // keeps hitting the same spots. ±20% breaks the pattern up.
      if (t.cd <= 0) { t.cd = (1 / rateMult) * (0.8 + Math.random() * 0.4); fireTurret(t); }
    } else if (t.type === 'rocket') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = (TURRET.rocket.interval / rateMult) * (0.8 + Math.random() * 0.4); fireMissile(t); }
    } else if (t.type === 'laser') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = (TURRET.laser.interval / rateMult) * (0.8 + Math.random() * 0.4); fireLaser(t); }
    } else if (t.type === 'bloom') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = TURRET.bloom.interval / rateMult * S.bloomMult; bloomGrowth(t); }
    } else if (t.type === 'lantern') {
      // Lanterns don't fire — they just hold back the fog.
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

  // Harvest: each blue territory cell glows over HARVEST_EVERY seconds,
  // then pops a pickup (80% XP, 20% gold) and resets to base color.
  for (let i = 0; i < S.cells.length; i++) {
    if (S.cells[i] !== BLUE) continue;
    S.harvT[i] += dt;
    if (S.harvT[i] >= HARVEST_EVERY) {
      S.harvT[i] = 0;
      const cx = i % cfg.cols, cy = (i / cfg.cols) | 0;
      if (coinAt(cx, cy) || S.coins.length >= 800) continue;
      const kind = Math.random() < 0.2 ? 'gold' : 'xp';
      S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind,
                     phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
    }
  }

  // Tapped pickups zip to their HUD target (accelerating = satisfying).
  // Targets live in screen space, so re-project every frame.
  S.time += dt;
  const tgt = screenToWorld(CHIP_CX, CHIP_CY);
  const TX = tgt.x / CELL_PX, TY = tgt.y / CELL_PX;
  const xtgt = screenToWorld(view.w / 2, 18); // XP bar, top-center
  const XX = xtgt.x / CELL_PX, XY = xtgt.y / CELL_PX;
  for (const c of S.coins) {
    if (c.state === 'fly') {
      c.t += dt;
      const k = Math.min(1, c.t / COIN_FLY_DUR);
      const e = k * k;
      // XP orbs fly to the XP bar; gold coins fly to the gold chip.
      const gx = c.kind === 'gold' ? TX : XX, gy = c.kind === 'gold' ? TY : XY;
      c.x = c.sx + (gx - c.sx) * e;
      c.y = c.sy + (gy - c.sy) * e;
      if (k >= 1) {
        c.dead = true;
        if (c.kind === 'gold') {
          S.gold++; // run gold only — banked to the meta total when the run ends
          S.chipPulse = 1; // the "blurp": chip pops
          S.floaters.push({ x: CHIP_CX + 30, y: CHIP_CY, t: 0 });
        } else {
          S.xp++;
          checkLevel();
        }
      }
    } else if (c.state === 'cannon') {
      // auto-collected: lerps into the nearest blue turret, pops on arrival
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
        if (c.kind === 'gold') {
          S.gold++; // run gold only — banked to the meta total when the run ends
          S.chipPulse = 1;
          spawnBurst(px, py, '#f5b301');
        } else {
          S.xp++;
          spawnBurst(px, py, '#7dd3fc');
          checkLevel();
        }
      }
    } else if (c.state === 'gather') {
      // pulled by a Gather unit: lerps into it, pops on arrival
      c.t += dt;
      const k = Math.min(1, c.t / COIN_FLY_DUR);
      const e = k * k;
      c.x = c.sx + (c.gx - c.sx) * e;
      c.y = c.sy + (c.gy - c.sy) * e;
      if (k >= 1) {
        c.dead = true;
        if (c.kind === 'gold') {
          S.gold++; // run gold only — banked to the meta total when the run ends
          S.chipPulse = 1;
          S.floaters.push({ x: CHIP_CX + 30, y: CHIP_CY, t: 0 });
          spawnBurst(c.gx, c.gy, '#f5b301');
        } else {
          S.xp++;
          spawnBurst(c.gx, c.gy, '#7dd3fc');
          checkLevel();
        }
      }
    }
  }
  S.coins = S.coins.filter(c => !c.dead);
  for (const f of S.floaters) f.t += dt;
  S.floaters = S.floaters.filter(f => f.t < 0.7);
  S.chipPulse = Math.max(0, S.chipPulse - dt * 3);

  // Gather units: every cooldown, each living Gather pulls all idle pickups
  // within its range toward itself.
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE || t.type !== 'gather') continue;
    if (t.showRange > 0) t.showRange -= dt;
    t.coolT += dt;
    if (t.coolT >= GATHER_COOLDOWN) {
      t.coolT = 0;
      t.showRange = GATHER_FLASH_DUR; // flash the range on every pull
      const r2 = gatherRange() * gatherRange();
      for (const c of S.coins) {
        if (c.state !== 'idle') continue;
        const dx = c.x - (t.x + 0.5), dy = c.y - (t.y + 0.5);
        if (dx * dx + dy * dy <= r2) {
          c.state = 'gather'; c.sx = c.x; c.sy = c.y; c.gx = t.x + 0.5; c.gy = t.y + 0.5; c.t = 0;
        }
      }
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
  // Gold nugget: a single circle per cell so clusters read as a group
  // of cells, not a clump within one cell.
  if (S.goldNug[i]) {
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath();
    ctx.arc(x * CELL_PX + CELL_PX / 2, y * CELL_PX + CELL_PX / 2, 3, 0, Math.PI * 2);
    ctx.fill();
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
      if (st === BLUE) {
        // Harvest glow: lightens toward white as the next pickup approaches.
        const k = Math.min(1, S.harvT[i] / HARVEST_EVERY) * 0.45;
        const r = Math.round(BLUE_RGB[0] + (255 - BLUE_RGB[0]) * k);
        const g = Math.round(BLUE_RGB[1] + (255 - BLUE_RGB[1]) * k);
        const b = Math.round(BLUE_RGB[2] + (255 - BLUE_RGB[2]) * k);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
      else if (st === RED) { ctx.fillStyle = CELL_COLORS[RED]; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (st === EMPTY) {
        const sh = CAVE_SHADES[S.shade[i] || 0];
        ctx.fillStyle = `rgb(${sh[0]},${sh[1]},${sh[2]})`;
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
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
  // Territory growth: each increment plops a little circle at a deterministic
  // spot inside the cell; the newest one pops in with an overshoot. At
  // GROW_STEPS the cell blooms into solid territory (handled in bloomGrowth).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const n = S.growN[i];
      if (n <= 0 || S.cells[i] !== EMPTY) continue;
      ctx.fillStyle = CELL_COLORS[S.growBy[i]];
      for (let k = 0; k < n; k++) {
        const [fx, fy] = growthDotPos(i, k);
        let s = 1;
        if (k === n - 1) s = Math.max(0.01, easeOutBack(Math.min(1, (S.time - S.growT[i]) / 0.2)));
        ctx.beginPath();
        ctx.arc((x + fx) * CELL_PX, (y + fy) * CELL_PX, 3.2 * s, 0, Math.PI * 2);
        ctx.fill();
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
  // (Coins/orbs render after the fog, below — they shine through the dark.)
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
  // Damage numbers: bold retro white text with a dark outline, drifting up.
  // Crits render gold and slightly larger.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const d of S.dmgNums) {
    const k = d.t / d.life;
    ctx.globalAlpha = k < 0.25 ? 1 : 1 - (k - 0.25) / 0.75; // brief hold, then a quick fade
    const px = d.x * CELL_PX, py = d.y * CELL_PX;
    ctx.font = (d.crit ? '14px' : '12px') + ' "Press Start 2P", "Courier New", monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(11,14,22,0.9)';
    ctx.strokeText(d.dmg, px, py);
    ctx.fillStyle = d.crit ? '#ffd75e' : '#ffffff';
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
    } else if (t.type === 'bloom') { // a sprout
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 7); ctx.quadraticCurveTo(1, 0, 0, -6); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(-4.5, -3, 4.5, 2.6, -0.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(4.5, -5, 4.5, 2.6, 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -7.5, 2.2, 0, Math.PI * 2); ctx.fill(); // bud
    } else if (t.type === 'gather') { // a magnet: horseshoe pulling inward
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 7, Math.PI * 0.15, Math.PI * 0.85, true); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(-5.5, 4.5, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(5.5, 4.5, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill(); // core
    } else { // lantern: a little glowing lantern
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, -5, 3.5, Math.PI, 0); ctx.stroke(); // handle
      ctx.beginPath(); ctx.rect(-5, -5, 10, 12); ctx.fill(); ctx.stroke(); // body
      ctx.fillStyle = '#fef3c7'; // glowing core
      ctx.beginPath(); ctx.arc(0, 1, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // Gather cooldown clock: thin arc filling as the next pull approaches.
    if (t.type === 'gather' && !t.dead) {
      const k = Math.min(1, t.coolT / GATHER_COOLDOWN);
      ctx.save();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px, py, 12, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      // Tapped or just pulled: flash the pull range, fading out.
      if (t.showRange > 0) {
        const fade = Math.min(1, t.showRange / GATHER_FLASH_DUR);
        ctx.save();
        ctx.strokeStyle = `rgba(250, 204, 21, ${0.6 * fade})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(px, py, gatherRange() * CELL_PX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    // HP bar above damaged turrets
    if (t.hp < t.maxhp) {
      const w = 24, k = Math.max(0, t.hp / t.maxhp);
      ctx.fillStyle = 'rgba(11,14,22,0.8)';
      ctx.fillRect(px - w / 2, py - 18, w, 5);
      ctx.fillStyle = k > 0.5 ? '#4ade80' : k > 0.25 ? '#f5b301' : '#ef4444';
      ctx.fillRect(px - w / 2, py - 18, w * k, 5);
    }
  }
  // Gather placement preview: range circle follows the pointer.
  if (S.placing && S.placing.type === 'gather' && S.placePreview) {
    const wpt = screenToWorld(S.placePreview.x, S.placePreview.y);
    const r = gatherRange() * CELL_PX;
    ctx.save();
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(wpt.x, wpt.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
  // Fog of war over everything: full = black, half = 50% black (smooth edge)
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const f = S.fog[y * cfg.cols + x];
      if (f === 2) { ctx.fillStyle = '#000'; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (f === 1) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
    }
  }
  // Pickups (XP orbs + gold coins) shine through the fog — idle ones pulse
  // gently so they beg to be tapped.
  for (const c of S.coins) {
    const px = c.x * CELL_PX, py = c.y * CELL_PX;
    let r = 5.5;
    if (c.state === 'idle') r += Math.sin(S.time * 4 + c.phase) * 1.2;
    else r *= 1 - 0.4 * Math.min(1, c.t / COIN_FLY_DUR);
    const isGold = c.kind === 'gold';
    ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isGold ? 'rgba(255, 200, 60, 0.22)' : 'rgba(125, 211, 252, 0.25)';
    ctx.fill(); // glow
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = isGold ? '#f5b301' : '#7dd3fc';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isGold ? '#8a5b00' : '#0369a1';
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill(); // shine
  }
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
  ctx.fillText('× ' + S.gold, CHIP_CX - chw / 2 + 26, CHIP_CY + 1);
  ctx.restore();
  // Passive badges, top-left under the gold chip: icon + level pips (8 max).
  let ppy = CHIP_CY + 32;
  for (const key of ['bounce']) {
    const lvl = S.passives[key];
    if (lvl === 0) continue;
    const bw = 96, bh = 20;
    ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
    rr(8, ppy, bw, bh, 6); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#2a3145';
    rr(8, ppy, bw, bh, 6); ctx.stroke();
    const iy = ppy + bh / 2;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(ICONS[key], 12, iy + 1);
    // level pips
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(34 + i * 7.5, iy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i < lvl ? '#ffd75e' : '#2a3145';
      ctx.fill();
    }
    ppy += bh + 6;
  }
  // Weapon badges: icon + level number (levels go to 50+, so no pips).
  for (const type of ['cannon', 'rocket', 'laser', 'bloom', 'lantern', 'gather']) {
    const w = S.weapons[type];
    if (!w) continue;
    const bw = 96, bh = 20;
    ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
    rr(8, ppy, bw, bh, 6); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#2a3145';
    rr(8, ppy, bw, bh, 6); ctx.stroke();
    const iy = ppy + bh / 2;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(ICONS[type], 12, iy + 1);
    ctx.fillStyle = '#dfe5f2';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('Lv ' + w.level, 34, iy + 1);
    ppy += bh + 6;
  }
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
  const lvl = S.level;
  const need = xpNeed();
  const pct = Math.min(1, Math.max(0, S.xpShown / need));
  const label = `LV ${lvl} &nbsp;·&nbsp; ${Math.floor(S.xpShown)}/${need} XP`;
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
    (ENEMIES_ENABLED ? `<div>Wave: <b>${S.wave}</b> · Your turrets: <b>${blues}</b> · Enemy: <b>${reds}</b>${S.redQueue.length ? ` (+${S.redQueue.length} incoming)` : ''}</div>` : `<div>Your turrets: <b>${blues}</b></div>`) +
    `<div>Blocks excavated: <b>${S.destroyed}</b> · Red turrets destroyed: <b>${S.redKills}</b></div>` +
    `<div>Map seed: <b>${S.seed}</b></div>` +
    `<div>Fire rate: <b>${effFreq}/s</b> (×${S.freqMult.toFixed(2)}) · Damage: <b>+${S.dmgBonus}</b> · Steering: <b>×${S.steerMult.toFixed(2)}</b> · Bloom: <b>×${S.bloomMult.toFixed(2)}</b></div>` +
    `<div>Bounce: <b>Lv${S.passives.bounce}</b> (${Math.round(S.bounceChance * 100)}%) · Gather: <b>Lv${S.weapons.gather ? S.weapons.gather.level : 0}</b> (${gatherRange()} cells / ${GATHER_COOLDOWN}s)</div>` +
    `<div>Weapons: <b>${Object.entries(S.weapons).map(([k, w]) => `${k} Lv${w.level} (×${w.rateMult.toFixed(2)} rate, +${w.dmgBonus} dmg${w.critChance ? `, ${Math.round(w.critChance * 100)}% crit` : ''})`).join(' · ')}</b></div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b> · Missiles: <b>${S.missiles.length}</b></div>` +
    `<div>Pickups: <b>${S.coins.length}</b> on field · Gold this run: <b>${S.gold}</b> · Total: <b>${meta.gold}</b></div>`;
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
[inCols, inRows, inSpeed, inFreq, inArc, inTurn, inBounce, inCave, inCoin, inSeed,
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
      return true;
    }
  }
  return false;
}
// Tapping a placed Gather flashes its range for a few seconds.
function tapGather(sx, sy) {
  const wpt = screenToWorld(sx, sy);
  const cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  const t = turretAt(cx, cy);
  if (t && !t.dead && t.type === 'gather' && t.color === BLUE) {
    t.showRange = 3;
    return true;
  }
  return false;
}
const pointers = new Map(); // pointerId -> {x, y} in client px
let pinchD0 = 0;
let downPos = null, panning = false;
const TAP_SLOP = 8; // px: below this, a press is a tap, not a pan
canvas.addEventListener('pointerdown', (e) => {
  if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (S.placing && S.placing.type === 'gather') S.placePreview = { x: e.clientX, y: e.clientY };
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
  if (S.placing && S.placing.type === 'gather') S.placePreview = { x: e.clientX, y: e.clientY };
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
      else if (tryChipDoubleTap(downPos.x, downPos.y)) { /* debug level grant */ }
      else if (!tapCoin(downPos.x, downPos.y)) tapGather(downPos.x, downPos.y);
    }
    downPos = null; panning = false;
  } else if (pointers.size === 1) {
    // pinch -> one finger: re-anchor so the remaining finger doesn't jump
    const [p] = [...pointers.values()];
    downPos = { x: p.x, y: p.y }; panning = false;
  }
}

// Debug gesture: double-tap the coin-counter chip to grant enough XP for
// the next level. Hidden, harmless in production — just a fast way to
// exercise the card draft while tuning.
function tryChipDoubleTap(sx, sy) {
  if (Math.abs(sx - CHIP_CX) > 38 || Math.abs(sy - CHIP_CY) > 13) return false;
  const now = S.time;
  if (now - (S._lastChipTap ?? -1) < 0.4) {
    S._lastChipTap = -1;
    debugGrantLevel();
    return true;
  }
  S._lastChipTap = now;
  return false; // first tap falls through to tapCoin
}
function debugGrantLevel() {
  const need = xpNeed() - S.xp;
  if (need <= 0) return;
  S.xp += need;
  S.chipPulse = 1;
  checkLevel();
  updateHud();
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
    turn: inTurn, bounce: inBounce, cave: inCave, seed: inSeed, coin: inCoin,
    pophold: inPopHold, popdur: inPopDur,
    poppush: inPopPush, ripple: inRipple, trail: inTrail, gravity: inGravity,
    terrain: inTerrain, empty: inEmpty, fogdist: inFogDist };
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
    turn: cfg.turnRate, bounce: cfg.bouncePerLevel, cave: cfg.caveChance, seed: inSeed.value.trim(), coin: cfg.coinChance,
    pophold: cfg.popHold, popdur: cfg.popDur, poppush: cfg.popPush,
    ripple: cfg.rippleAmp, trail: cfg.trailT, gravity: cfg.gravity,
    terrain: inTerrain.value, empty: inEmpty.value, fogdist: cfg.fogDist,
  });
  const url = location.origin + location.pathname + '?' + q.toString();
  const btn = document.getElementById('d-copylink');
  navigator.clipboard.writeText(url).then(
    () => flashButton(btn, 'Copied!'),
    () => flashButton(btn, 'Copy failed'));
});

// ---- Pre-game start screen: pick a starter, unlock weapons with gold ----
const WEAPON_DESC = {
  cannon: 'Sweeping shots',
  rocket: 'Homing missiles that crash-splash',
  laser: 'Snipes the weakest visible block',
  bloom: 'Grows coin-generating territory',
  lantern: 'Pushes back the fog',
};
function renderStartScreen() {
  document.getElementById('startgold').textContent = meta.gold;
  const banked = document.getElementById('bankedmsg');
  if (S.lastBanked > 0) {
    banked.textContent = `+${S.lastBanked} gold from last run banked!`;
    banked.classList.remove('hidden');
    S.lastBanked = 0; // show it once
  } else {
    banked.classList.add('hidden');
  }
  const list = document.getElementById('weaponlist');
  list.innerHTML = '';
  for (const type of ['cannon', 'rocket', 'laser', 'bloom', 'lantern']) {
    const unlocked = meta.unlocks[type];
    const cost = UNLOCK_COST[type] || 0;
    const div = document.createElement('div');
    div.className = 'weapon' + (unlocked ? '' : ' locked') + (starterType === type ? ' selected' : '');
    const info = document.createElement('div');
    info.className = 'winfo';
    const name = document.createElement('div');
    name.className = 'wname';
    name.textContent = TURRET[type].name;
    const desc = document.createElement('div');
    desc.className = 'wdesc';
    desc.textContent = WEAPON_DESC[type] + (unlocked ? '' : ` — unlock for ${cost}g`);
    info.appendChild(name);
    info.appendChild(desc);
    div.appendChild(info);
    const btn = document.createElement('button');
    if (unlocked) {
      btn.textContent = starterType === type ? 'Selected' : 'Select';
      btn.disabled = starterType === type;
      btn.addEventListener('click', () => { starterType = type; renderStartScreen(); });
    } else {
      btn.textContent = `Unlock ${cost}g`;
      btn.disabled = meta.gold < cost;
      btn.addEventListener('click', () => {
        if (meta.gold < cost || meta.unlocks[type]) return;
        meta.gold -= cost;
        meta.unlocks[type] = true;
        starterType = type;
        saveMeta();
        renderStartScreen();
      });
    }
    div.appendChild(btn);
    list.appendChild(div);
  }
}
document.getElementById('startbtn').addEventListener('click', () => {
  // Locked weapons can't start a run (defensive; the UI never selects them).
  if (!meta.unlocks[starterType]) starterType = 'cannon';
  document.getElementById('startscreen').classList.add('hidden');
  newGame();
});

applyUrlParams();
loadMeta();
newGame();
S.paused = true; // behind the start screen until the player picks a starter
renderStartScreen();
document.getElementById('startscreen').classList.remove('hidden');
requestAnimationFrame(frame);
