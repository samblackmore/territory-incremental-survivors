'use strict';
/* Territory Incremental Survivors — prototype v1
 * Color-Smash-style territory painting + Vampire-Survivors-style XP/levels.
 */

// ---- Cell states ----
const WHITE = 0, EMPTY = 1, BLUE = 2, RED = 3;
const CELL_COLORS = ['#eef1f6', '#3d4454', '#3b82f6', '#ef4444'];

const CELL_PX = 16;                 // render size of one cell
const TURN_RATE = (Math.PI * 2) / 3; // cannon sweep speed: 120 deg/s
const COIN_FLY_DUR = 0.45;           // seconds for a tapped coin to zip to the corner
const POP_DUR = 0.22;                // seconds for a hit block to shrink 2x -> 1x
const POP_PUSH = 0.4;                // knockback offset at full pop, in cells
const CHIP_CX = 41, CHIP_CY = 19;    // coin-counter chip center, in canvas px

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

const inCols   = document.getElementById('d-cols');
const inRows   = document.getElementById('d-rows');
const inSpeed  = document.getElementById('d-speed');
const inFreq   = document.getElementById('d-freq');
const inArc    = document.getElementById('d-arc');
const inCave   = document.getElementById('d-cave');
const inSeed   = document.getElementById('d-seed');
const inCoin   = document.getElementById('d-coin');
const inThresh = document.getElementById('d-thresh');

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
  const pop = S.pop[i];
  if (pop > 0) { // hit flash: full projectile color, lerping back with the scale
    r = Math.round(r + (ac[0] - r) * pop);
    g = Math.round(g + (ac[1] - g) * pop);
    b = Math.round(b + (ac[2] - b) * pop);
  }
  return [r, g, b];
}

// A damaged block chips: small squares fly off in its current color
function spawnChip(cx, cy, rgb) {
  const css = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  for (let n = 0; n < 3; n++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * 3.5; // cells/sec
    S.particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5,
                       life: 0.35 + Math.random() * 0.25, t: 0, dead: false,
                       color: css, size: 5 + Math.random() * 4 });
    S.particlesSpawned++;
  }
  if (S.particles.length > 600) S.particles.splice(0, S.particles.length - 600);
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
    caveChance: clampNum(inCave.value, 0, 0.95, 0.38),      // CA cave fill
    coinChance: clampNum(inCoin.value, 0, 1, 0.3),          // coin drop per blue conversion
    thresholds: thresholds.length ? thresholds : [15],
  };
  // reflect clamped values back into the panel
  inCols.value = cols; inRows.value = rows;
  inSpeed.value = cfg.projSpeed; inFreq.value = cfg.freq;
  inArc.value = cfg.arc; inCave.value = cfg.caveChance;
  inCoin.value = cfg.coinChance;
  inThresh.value = cfg.thresholds.join(',');
}

// ---- Game state ----
let S = null;

function mkCannon(gx, gy, color) {
  // Base aim: toward the map center, so bottom-left aims up-right etc.
  const cx = cfg.cols / 2, cy = cfg.rows / 2;
  const base = Math.atan2(cy - gy, cx - gx);
  return { x: gx, y: gy, color, base, angle: base, dir: 1, acc: 0 };
}

function paintBlob(cx, cy, color) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < cfg.cols && y < cfg.rows) {
        const i = y * cfg.cols + x;
        S.cells[i] = color;
        S.maxhp[i] = 10; S.hp[i] = 10; S.hitBy[i] = 0;
      }
    }
  }
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
  const pop = new Float32Array(n); // hit feedback: 1 -> 0, scale 2x -> 1x + color flash
  const popDX = new Float32Array(n); // knockback direction (unit vector), set at impact
  const popDY = new Float32Array(n);
  S = { cells, hp, maxhp, hitBy, pop, popDX, popDY, projs: [], cannons: [], xp: 0, level: 1, pending: 0,
        freqMult: 1, paused: false, frame: 0, seed,
        coins: [], floaters: [], coinsCollected: 0, chipPulse: 0, time: 0,
        particles: [], particlesSpawned: 0 };

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

  // Player cannon (blue) near bottom-left, enemy (red) near top-right
  const px = Math.round(cfg.cols * 0.15), py = Math.round(cfg.rows * 0.85);
  const ex = Math.round(cfg.cols * 0.85), ey = Math.round(cfg.rows * 0.15);
  paintBlob(px, py, BLUE);
  paintBlob(ex, ey, RED);
  S.cannons.push(mkCannon(px, py, BLUE));
  S.cannons.push(mkCannon(ex, ey, RED));

  canvas.width = cfg.cols * CELL_PX;
  canvas.height = cfg.rows * CELL_PX;

  overlay.classList.add('hidden');
  updateHud();
}

// ---- Firing ----
function fire(c) {
  const speed = cfg.projSpeed / CELL_PX; // cells per second
  const mx = c.x + Math.cos(c.angle) * 1.1;
  const my = c.y + Math.sin(c.angle) * 1.1;
  S.projs.push({
    x: mx, y: my,
    vx: Math.cos(c.angle) * speed,
    vy: Math.sin(c.angle) * speed,
    color: c.color,
    dead: false,
  });
}

function stepProjectile(p, dt) {
  const dist = Math.hypot(p.vx, p.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.4)); // sub-step so fast shots can't tunnel
  const sx = (p.vx * dt) / steps, sy = (p.vy * dt) / steps;
  for (let s = 0; s < steps; s++) {
    p.x += sx; p.y += sy;
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) { p.dead = true; return; }
    const idx = cy * cfg.cols + cx;
    const cell = S.cells[idx];
    if (cell === WHITE) {
      const rgb = cellRGB(cx, cy); // chip flies off in the block's current color
      S.hp[idx]--;
      S.hitBy[idx] = p.color;
      S.pop[idx] = 1; // start the hit-pop: 2x scale + full projectile color
      // knockback: push the block away from the projectile's entry point
      const pdx = (cx + 0.5) - p.x, pdy = (cy + 0.5) - p.y;
      const plen = Math.hypot(pdx, pdy) || 1;
      S.popDX[idx] = pdx / plen;
      S.popDY[idx] = pdy / plen;
      spawnChip(cx + 0.5, cy + 0.5, rgb);
      p.dead = true;
      if (S.hp[idx] <= 0) {
        S.cells[idx] = p.color;
        if (p.color === BLUE && Math.random() < cfg.coinChance) {
          S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle',
                         phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
          if (S.coins.length > 800) { // safety valve: drop oldest idle coin
            const i = S.coins.findIndex(c => c.state === 'idle');
            if (i >= 0) S.coins.splice(i, 1);
          }
        }
      }
      return;
    }
    if (cell === EMPTY || cell === p.color) continue; // pass through grey + own color
    p.dead = true; return; // enemy color blocks the shot
  }
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
    overlay.classList.remove('hidden');
  }
}

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    S.freqMult *= parseFloat(card.dataset.mult);
    S.pending--;
    if (S.pending <= 0) {
      S.pending = 0;
      S.paused = false;
      overlay.classList.add('hidden');
    }
    updateHud();
  });
});

// ---- Update ----
function update(dt) {
  const arcRad = (cfg.arc * Math.PI) / 180;
  for (const c of S.cannons) {
    // Sweep the aim within the turn arc (full 360 = continuous spin)
    if (cfg.arc >= 360) {
      c.angle += TURN_RATE * dt;
    } else if (arcRad > 0) {
      c.angle += c.dir * TURN_RATE * dt;
      const lo = c.base - arcRad / 2, hi = c.base + arcRad / 2;
      if (c.angle > hi) { c.angle = hi; c.dir = -1; }
      else if (c.angle < lo) { c.angle = lo; c.dir = 1; }
    } else {
      c.angle = c.base;
    }
    // Fire. Frequency upgrades apply to the player's (blue) cannon only.
    const rate = cfg.freq * (c.color === BLUE ? S.freqMult : 1);
    c.acc += dt * rate;
    while (c.acc >= 1) { c.acc -= 1; fire(c); }
  }
  for (const p of S.projs) stepProjectile(p, dt);
  if (S.projs.length > 4000) S.projs.splice(0, S.projs.length - 4000); // safety valve
  S.projs = S.projs.filter(p => !p.dead);

  // Tapped coins zip to the top-left chip (accelerating = satisfying)
  S.time += dt;
  const TX = CHIP_CX / CELL_PX, TY = CHIP_CY / CELL_PX;
  for (const c of S.coins) {
    if (c.state !== 'fly') continue;
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
  }
  S.coins = S.coins.filter(c => !c.dead);
  for (const f of S.floaters) f.t += dt;
  S.floaters = S.floaters.filter(f => f.t < 0.7);
  S.chipPulse = Math.max(0, S.chipPulse - dt * 3);

  // Hit-pops decay: scale 2x -> 1x, flash -> damaged color, same lerp
  const popDecay = dt / POP_DUR;
  for (let i = 0; i < S.pop.length; i++) {
    if (S.pop[i] > 0) S.pop[i] = Math.max(0, S.pop[i] - popDecay);
  }

  // Chip particles: fly, gravity, fade
  for (const pt of S.particles) {
    pt.t += dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 9 * dt;
    if (pt.t >= pt.life) pt.dead = true;
  }
  S.particles = S.particles.filter(p => !p.dead);
}

// Draw one WHITE (terrain) cell with its hit-pop scale; popped cells are drawn
// in a second pass so the enlarged square sits in front of its neighbors.
function drawWhiteCell(x, y) {
  const i = y * cfg.cols + x;
  const c = cellRGB(x, y);
  ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  const pop = S.pop[i];
  if (pop > 0) {
    // hit-pop: 2x scale about the cell center, shoved along the knockback
    // direction; both lerp back to normal as pop -> 0
    const s = CELL_PX * (1 + pop);
    const push = POP_PUSH * CELL_PX * pop;
    const ox = x * CELL_PX + CELL_PX / 2 + S.popDX[i] * push;
    const oy = y * CELL_PX + CELL_PX / 2 + S.popDY[i] * push;
    ctx.fillRect(ox - s / 2, oy - s / 2, s, s);
  } else {
    ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
  }
}

// ---- Render ----
function render() {
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = cfg.cols, h = cfg.rows;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const st = S.cells[i];
      if (st === BLUE) { ctx.fillStyle = CELL_COLORS[BLUE]; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (st === RED) { ctx.fillStyle = CELL_COLORS[RED]; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (st === EMPTY) { ctx.fillStyle = CAVE_CSS; ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX); }
      else if (S.pop[i] <= 0) drawWhiteCell(x, y); // popped cells draw in the pass below
    }
  }
  // Popped (enlarged) cells render last, in front of surrounding squares
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (S.cells[i] === WHITE && S.pop[i] > 0) drawWhiteCell(x, y);
    }
  }
  // Projectiles
  for (const p of S.projs) {
    ctx.beginPath();
    ctx.arc(p.x * CELL_PX, p.y * CELL_PX, 4.5, 0, Math.PI * 2);
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
  // Chip particles
  for (const pt of S.particles) {
    ctx.globalAlpha = Math.max(0, 1 - pt.t / pt.life);
    ctx.fillStyle = pt.color;
    const s = pt.size;
    ctx.fillRect(pt.x * CELL_PX - s / 2, pt.y * CELL_PX - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  // Cannons (rectangles, like the spec)
  for (const c of S.cannons) {
    ctx.save();
    ctx.translate(c.x * CELL_PX, c.y * CELL_PX);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#10141f';
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = CELL_COLORS[c.color];
    ctx.strokeStyle = '#0b0e16'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-4, -6, 26, 12); // the cannon rectangle, pointing along aim
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
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
  let blue = 0, red = 0, white = 0, empty = 0;
  const cells = S.cells;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === BLUE) blue++;
    else if (cells[i] === RED) red++;
    else if (cells[i] === WHITE) white++;
    else empty++;
  }
  const effFreq = (cfg.freq * S.freqMult).toFixed(2);
  statsEl.innerHTML =
    `<div><span class="swatch" style="background:#3b82f6"></span>Blue cells: <b>${blue}</b></div>` +
    `<div><span class="swatch" style="background:#ef4444"></span>Red cells: <b>${red}</b></div>` +
    `<div><span class="swatch" style="background:#eef1f6"></span>White cells: <b>${white}</b></div>` +
    `<div><span class="swatch" style="background:#222839"></span>Cave cells: <b>${empty}</b></div>` +
    `<div>Map seed: <b>${S.seed}</b></div>` +
    `<div>Player fire rate: <b>${effFreq}/s</b> (×${S.freqMult.toFixed(2)})</div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b></div>` +
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
[inCols, inRows, inSpeed, inFreq, inArc, inCave, inCoin, inSeed, inThresh].forEach(el => {
  el.addEventListener('change', newGame);
});
document.getElementById('d-restart').addEventListener('click', newGame);

// ---- Coin tapping: topmost idle coin within tap radius starts its flight ----
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (canvas.width / r.width) / CELL_PX;
  const cy = (e.clientY - r.top) * (canvas.height / r.height) / CELL_PX;
  for (let i = S.coins.length - 1; i >= 0; i--) {
    const c = S.coins[i];
    if (c.state !== 'idle') continue;
    const dx = c.x - cx, dy = c.y - cy;
    if (dx * dx + dy * dy < 0.81) { // 0.9-cell tap radius
      c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
      break;
    }
  }
});

// ---- Mobile: collapsible debug panel (button only visible under 720px) ----
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug');
if (debugToggle && debugPanel) {
  debugToggle.addEventListener('click', () => debugPanel.classList.toggle('collapsed'));
}

newGame();
requestAnimationFrame(frame);
