'use strict';
/* Territory Incremental Survivors — prototype v1
 * Color-Smash-style territory painting + Vampire-Survivors-style XP/levels.
 */

// ---- Cell states ----
const WHITE = 0, EMPTY = 1, BLUE = 2, RED = 3;
const CELL_COLORS = ['#eef1f6', '#3d4454', '#3b82f6', '#ef4444'];

const CELL_PX = 16;                 // render size of one cell
const TURN_RATE = (Math.PI * 2) / 3; // cannon sweep speed: 120 deg/s

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
const inEmpty  = document.getElementById('d-empty');
const inThresh = document.getElementById('d-thresh');

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
    emptyChance: clampNum(inEmpty.value, 0, 0.95, 0.15),
    thresholds: thresholds.length ? thresholds : [15],
  };
  // reflect clamped values back into the panel
  inCols.value = cols; inRows.value = rows;
  inSpeed.value = cfg.projSpeed; inFreq.value = cfg.freq;
  inArc.value = cfg.arc; inEmpty.value = cfg.emptyChance;
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
        S.cells[y * cfg.cols + x] = color;
      }
    }
  }
}

function newGame() {
  readDebug();
  const n = cfg.cols * cfg.rows;
  const cells = new Uint8Array(n); // all WHITE
  S = { cells, projs: [], cannons: [], xp: 0, level: 1, pending: 0,
        freqMult: 1, paused: false, frame: 0 };

  // Scatter empty (grey) cells
  for (let i = 0; i < n; i++) {
    if (Math.random() < cfg.emptyChance) cells[i] = EMPTY;
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
      S.cells[idx] = p.color;
      p.dead = true;
      if (p.color === BLUE) { S.xp++; checkLevel(); }
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
}

// ---- Render ----
function render() {
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = cfg.cols, h = cfg.rows;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = CELL_COLORS[S.cells[y * w + x]];
      ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
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
    `<div><span class="swatch" style="background:#3d4454"></span>Empty cells: <b>${empty}</b></div>` +
    `<div>Player fire rate: <b>${effFreq}/s</b> (×${S.freqMult.toFixed(2)})</div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b></div>`;
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
[inCols, inRows, inSpeed, inFreq, inArc, inEmpty, inThresh].forEach(el => {
  el.addEventListener('change', newGame);
});
document.getElementById('d-restart').addEventListener('click', newGame);

// ---- Mobile: collapsible debug panel (button only visible under 720px) ----
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug');
if (debugToggle && debugPanel) {
  debugToggle.addEventListener('click', () => debugPanel.classList.toggle('collapsed'));
}

newGame();
requestAnimationFrame(frame);
