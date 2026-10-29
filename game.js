'use strict';
/* Territory Incremental Survivors — prototype v1
 * Color-Smash-style territory painting + Vampire-Survivors-style XP/levels.
 */

// ---- Cell states ----
const WHITE = 0, EMPTY = 1, BLUE = 2, RED = 3, GREY = 4;
// SURVIVAL BRANCH palette flip (render-only): BLUE is the player
// internally, but renders red; RED is the flood internally, but renders
// blue. Logic (fog, bloom, harvest, win checks) still reads BLUE/RED
// as player/enemy — only the colors on screen are swapped.
const CELL_COLORS = ['#eef1f6', '#3d4454', '#ef4444', '#3b82f6', '#6b7280'];

const CELL_PX = 16;                 // render size of one cell
const BOUNCE_MAX = 8;               // bounces per projectile (backstop, not a target)
const STEER_RATE = 3;               // missile turn rate, rad/s (x S.steerMult)
const RED_DEPLOY_EVERY = 12;        // seconds between red turret deployments
const GROW_INTERVAL = 5;            // Bloom: seconds per growth increment (x S.bloomMult)
const GROW_STEPS = 4;              // quarters to turn a cell into territory
// Quarter fill order for bloom growth: top-left, top-right,
// bottom-left, bottom-right (each is a 0.5 x 0.5 mini-square).
const GROW_QUARTERS = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];
const BLOOM_RADIUS = 8;            // Bloom: how far (cells) it reaches for empty ground
const HARVEST_EVERY = 8;           // territory: seconds between pickups per cell

// Turret roster: distinct damage patterns, no homing except the missile's
// steering (which is deliberately dumb: limited turn rate, walls win).
const GATHER_COOLDOWN = 6;           // seconds between pulls (legacy interval field, unused by the moving harvester)
// Cannon hand-designed 8-level track (VS-style: predictable, no random rolls).
// Index 0 = L1 base (unused); index N = upgrade from LN to LN+1.
// Split stat tracks: each weapon stat levels independently (chips top-left),
// one card per stat boost — no more bundled tracks. Caps vary: projectiles
// stops at 5 (volume control), the rest run to 8. Steps are uniform by
// design, so a card always tells you exactly what you get.
const STAT_DEFS = {
  cannon: [
    { key: 'dmg', name: 'Damage', cap: 8, effect: '+1 damage' },
    // Projectiles is shop-only (gold-gated): it's the strongest stat, so
    // it costs gold instead of a free XP pick. Still a track (chips + cap).
    { key: 'proj', name: 'Projectiles', cap: 5, effect: '+1 projectile', shopOnly: true },
    { key: 'rate', name: 'Fire rate', cap: 8, effect: '+15% fire rate' },
    { key: 'crit', name: 'Crit', cap: 8, effect: '+5% crit' },
    // Penetration: how deep a shot paints into flood (VS pass-through
    // for painting). Base depth 1 (just the edge block); each level
    // paints one more flood cell in the same shot's path.
    { key: 'pen', name: 'Penetration', cap: 8, effect: '+1 paint depth' },
  ],
  bloom: [
    { key: 'growth', name: 'Growth', cap: 8, effect: '+20% growth speed' },
  ],
  gather: [
    { key: 'count', name: 'Count', cap: 8, effect: '+1 pickup per pull' },
  ],
  mole: [
    { key: 'dig', name: 'Dig', cap: 8, effect: '+1 dig damage' },
  ],
};
// Fresh per-stat levels for a weapon type (0 = base value, cap = maxed).
function initWeaponStats(type) {
  const s = {};
  for (const d of (STAT_DEFS[type] || [])) s[d.key] = 0;
  return s;
}
// Apply one stat pick to the weapon's derived fields (the update loop and
// firing code read these, not the raw stat levels).
function applyStat(w, weapon, st) {
  const n = w.stats[st];
  if (weapon === 'cannon') {
    if (st === 'dmg') w.dmgBonus = n;
    else if (st === 'proj') w.proj = n;
    else if (st === 'rate') w.rateMult = Math.pow(1.15, n);
    else if (st === 'crit') w.critChance = 0.05 * n;
    else if (st === 'pen') w.penDepth = 1 + n; // paint depth: base 1 + 1 per level
  } else if (weapon === 'bloom') {
    if (st === 'growth') w.rateMult = Math.pow(1.2, n);
  }
  // gather count derives from stats (gatherCount); mole
  // dig uses dmgBonus, set by the bundle below.
}
// Cannon EVO (Sprayer) unlocks when every cannon stat track is maxed.
function cannonMaxed() {
  const w = S.weapons.cannon;
  return !!w && !w.evo && STAT_DEFS.cannon.every(d => (w.stats[d.key] || 0) >= d.cap);
}
// Mid-run unit costs (run gold, not meta gold): base + 5 per living unit
// of that type. The starter Cannon is free (pre-placed); every duplicate
// costs extra, and the price climbs as your army grows. Tunable.
const UNIT_COST = { cannon: 10, mole: 3, bloom: 6, gather: 6, lantern: 4, wall: 2, laser: 20 };
const UNIT_COST_STEP = 5;
const LANTERN_COST_STEP = 1; // lanterns stay cheap so chaining them to extend the base is affordable
function unitCost(type) {
  let count = 0;
  for (const t of S.turrets) {
    if (!t.dead && t.color === BLUE && t.type === type) count++;
  }
  const step = type === 'lantern' ? LANTERN_COST_STEP : UNIT_COST_STEP;
  return UNIT_COST[type] + step * count;
}
// Red mole price: same formula as blue's, counted on living red moles.
function redMoleCost() {
  let count = 0;
  for (const t of S.turrets) {
    if (!t.dead && t.color === RED && t.type === 'mole') count++;
  }
  return UNIT_COST.mole + UNIT_COST_STEP * count;
}
// Shared icons (inline SVG) for cards — matching the canvas badge shapes.
// Player icons use '#ef4444' here (the original); buildIcons() swaps that
// hex for the current team color, so the shop cards follow a toggle.
const ICONS_ORIG = {
  cannon: '<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="20,6 8,18 20,18" fill="#ef4444"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="20,12 12,8 12,16" fill="#ef4444"/><rect x="6" y="9.5" width="7" height="5" fill="#ef4444"/></svg>',
  laser: '<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="12,5 17,12 12,19 7,12" fill="#ef4444"/></svg>',
  bloom: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="5.5" fill="#ef4444"/></svg>',
  lantern: '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="7" y="6" width="10" height="12" fill="none" stroke="#ef4444" stroke-width="1.5"/><circle cx="12" cy="12" r="2.5" fill="#fef3c7"/></svg>',
  gather: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M7,6 A5,5 0 0,0 17,6" stroke="#ef4444" stroke-width="2.5" fill="none"/><circle cx="7" cy="15.5" r="1.8" fill="#ef4444"/><circle cx="17" cy="15.5" r="1.8" fill="#ef4444"/><circle cx="12" cy="12" r="2" fill="#ef4444"/></svg>',
  wall: '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="4" y="6" width="16" height="12" fill="#9ca3af" stroke="#4b5563" stroke-width="1.5"/><line x1="12" y1="6" x2="12" y2="18" stroke="#4b5563" stroke-width="1"/><line x1="4" y1="12" x2="20" y2="12" stroke="#4b5563" stroke-width="1"/></svg>',
  bounce: '<svg viewBox="0 0 24 24" width="36" height="36"><polyline points="5,17 9,7 13,17 17,7" stroke="#fb923c" stroke-width="2" fill="none"/></svg>',
  steer: '<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="20,12 12,8 12,16" fill="#ef4444"/><rect x="6" y="9.5" width="7" height="5" fill="#ef4444"/></svg>',
  mole: '<svg viewBox="0 0 24 24" width="36" height="36"><ellipse cx="12" cy="14" rx="7" ry="5" fill="#8b5a2b"/><circle cx="9" cy="12" r="1.2" fill="#1a2138"/><circle cx="15" cy="12" r="1.2" fill="#1a2138"/><polygon points="12,16 10,19 14,19" fill="#d4a574"/></svg>',
  gold: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 9 C8 9 5.5 12 5.5 15.5 C5.5 19 8.5 21.5 12 21.5 C15.5 21.5 18.5 19 18.5 15.5 C18.5 12 16 9 12 9 Z" fill="#f5b301" stroke="#b8860b" stroke-width="1.5"/><rect x="10.5" y="3.5" width="3" height="5.5" rx="1" fill="#b8860b"/></svg>',
};
function buildIcons(playerHex) {
  const o = {};
  for (const k in ICONS_ORIG) o[k] = ICONS_ORIG[k].replaceAll('#ef4444', playerHex);
  return o;
}
let ICONS = buildIcons('#ef4444');
const TURRET = {
  cannon: { name: 'Cannon', hp: 8, interval: 1.0, dmg: 1 },
  rocket: { name: 'Rocket', hp: 6, interval: 2.5, dmg: 3 },
  laser:  { name: 'Laser',  hp: 5, interval: 2.0, dmg: 2 },
  bloom:  { name: 'Field',  hp: 4, interval: GROW_INTERVAL, dmg: 0 },
  lantern:{ name: 'Lantern',hp: 4, interval: 0, dmg: 0 }, // pure vision, no firing
  gather: { name: 'Harvester', hp: 5, interval: GATHER_COOLDOWN, dmg: 0 }, // roams for pickups, anywhere, slowly
  mole:   { name: 'Digger', hp: 6, interval: 1.0, dmg: 1 }, // digs through rock, then dies
  wall:   { name: 'Wall',   hp: 20, interval: 0, dmg: 0 }, // terrain, not a turret (see placeTurretAt wall branch)
};
const MOLE_LIFETIME_MIN = 10;      // cells dug before dying (min)
const MOLE_LIFETIME_MAX = 20;      // ... (max)
const MOLE_TURN_EVERY = 3;         // cells before random turn
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
const lvfx = document.getElementById('lvfx');
const lvctx = lvfx ? lvfx.getContext('2d') : null;
// Minimap: black + one pixel per red/blue bloom cell, top-right.
const minimap = document.getElementById('minimap');
const mmctx = minimap ? minimap.getContext('2d') : null;
const mmBlue = document.getElementById('minimap-blue');
const mmRed = document.getElementById('minimap-red');
const finishbtn = document.getElementById('finishbtn');
const victory = document.getElementById('victory');
const continuebtn = document.getElementById('continuebtn');
// Win condition: the red bloom spawned, and now no red bloom turret
// survives and no red cells remain — the field is fully wiped out.
function checkWin() {
  if (!S || !S.redBloomSpawned || S.finished || S.runOver) return;
  if (finishbtn && !finishbtn.classList.contains('hidden')) return; // already offered
  for (const t of S.turrets) {
    if (!t.dead && t.color === RED && t.type === 'bloom') return;
  }
  for (let i = 0; i < S.cells.length; i++) {
    if (S.cells[i] === RED) return;
  }
  if (finishbtn) finishbtn.classList.remove('hidden');
}
if (finishbtn) {
  finishbtn.addEventListener('click', () => {
    // Reveal the full map: zoom all the way out, lift all fog.
    S.finished = true;
    S.paused = true;
    finishbtn.classList.add('hidden');
    resetCamera();
    S.fog.fill(0);
    if (victory) victory.classList.remove('hidden');
  });
}
if (continuebtn) {
  continuebtn.addEventListener('click', () => {
    // Bank the run's gold, then back to the start screen showing the
    // new total and the "+N" that was just added.
    if (S && S.gold > 0) {
      S.lastBanked = S.gold;
      meta.gold += S.gold;
      S.gold = 0;
      saveMeta();
    }
    if (victory) victory.classList.add('hidden');
    document.getElementById('startscreen').classList.remove('hidden');
    renderStartScreen();
  });
}
// Debug x-ray: double-tap the minimap to hide/show the fog overlay.
// Render-only — the real fog data, and everything gated on it (placement,
// bloom visibility, laser targeting), stays untouched, so this is a view
// for watching the enemy, not a cheat.
let fogHidden = false;
let lastMmTap = 0;
if (minimap) minimap.addEventListener('pointerup', e => {
  e.preventDefault(); e.stopPropagation();
  const now = performance.now();
  if (now - lastMmTap < 400) {
    fogHidden = !fogHidden;
    lastMmTap = 0;
  } else {
    lastMmTap = now;
  }
});
function drawMinimap() {
  if (!mmctx || !S) return;
  const cols = cfg.cols, rows = cfg.rows;
  const px = 2; // px per cell
  if (minimap.width !== cols * px) minimap.width = cols * px;
  if (minimap.height !== rows * px) minimap.height = rows * px;
  mmctx.fillStyle = '#000';
  mmctx.fillRect(0, 0, minimap.width, minimap.height);
  // Explored footprint: light grey where fog is fully cleared, dark grey
  // for the half-fog edge ring, black where still fogged. Grey rock in a
  // cleared cell reads as medium grey, so deposits are spottable.
  // (When fog is hidden for debugging, every cell reads as cleared.)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const f = fogHidden ? 0 : S.fog[y * cols + x];
      if (f === 0) {
        mmctx.fillStyle = S.cells[y * cols + x] === GREY ? '#6b7280' : '#9ca3af';
        mmctx.fillRect(x * px, y * px, px, px);
      }
      else if (f === 1) { mmctx.fillStyle = '#4b5563'; mmctx.fillRect(x * px, y * px, px, px); }
    }
  }
  let blue = 0, red = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = S.cells[y * cols + x];
      if (c === BLUE) { mmctx.fillStyle = CELL_COLORS[BLUE]; mmctx.fillRect(x * px, y * px, px, px); blue++; }
      else if (c === RED) {
        // Flood minimap pixel: flat base color (no HP gradient anymore;
        // minimap is 2px/cell, elevation shading would be invisible).
        mmctx.fillStyle = CELL_COLORS[RED];
        mmctx.fillRect(x * px, y * px, px, px); red++;
      }
    }
  }
  // Units: one pixel per living turret, team color, on top — so you can
  // see your cannon sitting in a lit area and the enemy over there.
  // (Units sit on EMPTY cells, never on territory, so they always show.)
  for (const t of S.turrets) {
    if (t.dead) continue;
    mmctx.fillStyle = CELL_COLORS[t.color];
    mmctx.fillRect(t.x * px, t.y * px, px, px);
  }
  // Incoming-storm warning (survival, early lull only): a gently
  // pulsing yellow line on the minimap edge the next storm comes
  // FROM. This is the quiet warning; the final 30s before the storm
  // use the old toast countdown instead (see floodTick). During the
  // storm itself there's no pulse: the flood is visible on the
  // minimap as blue territory. No pulse during grace either.
  if (SURVIVAL && S.flood && S.flood.phase === 'lull' && S.flood.timer > FLOOD_TOAST_AT) {
    const W = minimap.width, H = minimap.height, T = 3; // line thickness px
    const a = 0.42 + 0.18 * Math.sin(S.time * Math.PI * 2 / 2.2); // gentle 2.2s pulse, alpha 0.24–0.60
    mmctx.fillStyle = `rgba(255, 215, 94, ${a})`; // gold #ffd75e
    if (S.flood.dir === 0) mmctx.fillRect(0, 0, W, T); // from top
    else if (S.flood.dir === 1) mmctx.fillRect(0, H - T, W, T); // from bottom
    else if (S.flood.dir === 2) mmctx.fillRect(0, 0, T, H); // from left
    else mmctx.fillRect(W - T, 0, T, H); // from right
  }
  const total = cols * rows;
  // Dots match the RENDERED colors, not the internal team ids. When the
  // player renders blue (unflipped), blue% = player. When the player
  // renders red (flipped), the values swap — otherwise the blue dot
  // shows the red pixels' share and vice versa, which reads backwards.
  if (mmBlue) mmBlue.textContent = Math.round((PLAYER_RED ? red : blue) / total * 100) + '%';
  if (mmRed) mmRed.textContent = Math.round((PLAYER_RED ? blue : red) / total * 100) + '%';
}
// Celebration particles pouring down from the XP bar while cards show.
const lvParticles = [];
function stepLvParticles(dt) {
  if (!lvctx || overlay.classList.contains('hidden')) { lvParticles.length = 0; return; }
  const w = lvfx.width = (typeof innerWidth !== 'undefined' ? innerWidth : 800),
        h = lvfx.height = (typeof innerHeight !== 'undefined' ? innerHeight : 600);
  // Spawn: ~90/s from the XP bar strip at the top.
  const spawn = Math.round(90 * dt);
  for (let k = 0; k < spawn; k++) {
    lvParticles.push({
      x: Math.random() * w, y: 30 + Math.random() * 8,
      vx: (Math.random() - 0.5) * 40, vy: 30 + Math.random() * 60,
      r: 1.5 + Math.random() * 2.5, life: 0, max: 1.2 + Math.random() * 0.8,
      col: ['#5aa2ff', '#7dd3fc', '#2f6fe4', '#a5d8ff'][Math.floor(Math.random() * 4)],
    });
  }
  lvctx.clearRect(0, 0, w, h);
  for (let i = lvParticles.length - 1; i >= 0; i--) {
    const p = lvParticles[i];
    p.life += dt;
    if (p.life >= p.max || p.y > h) { lvParticles.splice(i, 1); continue; }
    p.vy += 120 * dt; // gravity
    p.x += p.vx * dt; p.y += p.vy * dt;
    const a = 1 - p.life / p.max;
    lvctx.globalAlpha = a;
    lvctx.fillStyle = p.col;
    lvctx.beginPath(); lvctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); lvctx.fill();
  }
  lvctx.globalAlpha = 1;
}
const placebanner = document.getElementById('placebanner');
const wavebanner = document.getElementById('wavebanner');
const runover = document.getElementById('runover');
const runstats = document.getElementById('runstats');
const commander = document.getElementById('commander');

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
  // No slack: the view's edge stops exactly at the map's edge, so you
  // never see void past the world (bars top/bottom on portrait are the
  // map itself being shorter than the screen, not overshoot).
  // When the view is wider/taller than the map, pin to center instead of sliding
  cam.x = hw * 2 >= W ? W / 2 : Math.min(Math.max(cam.x, hw), W - hw);
  cam.y = hh * 2 >= H ? H / 2 : Math.min(Math.max(cam.y, hh), H - hh);
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
let PLAYER_SHADES = []; // survival painterly: player territory (red on survival) in 8 elevation shades
let FLOOD_SHADES = [];  // survival painterly: flood (blue on survival) in 8 elevation shades
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
  // Painterly territory shades: player and flood each get 8 elevation
  // shades from their base color (darkened like caves). A cell keeps its
  // S.shade index when it flips color, so grass → field/flood (or flood
  // → field via painting) keeps the same elevation it had as grass,
  // just in a new hue. No HP gradient, no production glow: uniform
  // color per cell, shading only from elevation (not game state).
  const playerDark = BLUE_RGB.map(v => Math.round(v * 0.55));
  const floodDark = RED_RGB.map(v => Math.round(v * 0.55));
  PLAYER_SHADES = []; FLOOD_SHADES = [];
  for (let s = 0; s < 8; s++) {
    const t = s / 7;
    PLAYER_SHADES[s] = [0, 1, 2].map(j => Math.round(BLUE_RGB[j] + (playerDark[j] - BLUE_RGB[j]) * t));
    FLOOD_SHADES[s] = [0, 1, 2].map(j => Math.round(RED_RGB[j] + (floodDark[j] - RED_RGB[j]) * t));
  }
}
let BLUE_RGB = [239, 68, 68]; // player render color (set by applyTeamColors; default = branch look)
let RED_RGB = [59, 130, 246]; // enemy render color (set by applyTeamColors; default = branch look)
// Team colors (switchable, start screen): internal BLUE is always the
// player, internal RED always the enemy — only the RENDER hues swap.
// PLAYER_RED true = player red / enemy blue (current survival look);
// false = player blue / enemy red (original main look). Stored in
// localStorage ('tis_team'); with no stored preference, defaults to
// the branch look (survival red, main blue) so nothing changes until
// the player toggles. A global preference (applies to both branches).
const TEAM_RED_HEX = '#ef4444', TEAM_BLUE_HEX = '#3b82f6';
const TEAM_RED_RGB = [239, 68, 68], TEAM_BLUE_RGB = [59, 130, 246];
let PLAYER_RED = true; // set by applyTeamColors at boot (before first run)
function applyTeamColors() {
  let stored = null;
  try { stored = localStorage.getItem('tis_team'); } catch (e) { /* ignore */ }
  PLAYER_RED = stored === 'red' ? true : stored === 'blue' ? false : SURVIVAL;
  const playerHex = PLAYER_RED ? TEAM_RED_HEX : TEAM_BLUE_HEX;
  const enemyHex = PLAYER_RED ? TEAM_BLUE_HEX : TEAM_RED_HEX;
  BLUE_RGB = (PLAYER_RED ? TEAM_RED_RGB : TEAM_BLUE_RGB).slice();
  RED_RGB = (PLAYER_RED ? TEAM_BLUE_RGB : TEAM_RED_RGB).slice();
  CELL_COLORS[BLUE] = playerHex; CELL_COLORS[RED] = enemyHex;
  ICONS = buildIcons(playerHex);
  CARD_POOL = buildCardPool();
  rebuildColors(); // refreshes PLAYER_SHADES/FLOOD_SHADES from the new RGBs
}
// Grey rock: the mid-map hard rock. Same Perlin gradient as brown, ~10x the
// HP (30–100), in cellular-automata chunks. Fixed grey shades (light = soft,
// charcoal = tough) — no debug picker, grey should always read as grey.
const GREY_SHADES = [
  [229, 231, 235], [209, 213, 219], [156, 163, 175], [107, 114, 128],
  [75, 85, 99], [55, 65, 81], [31, 41, 55], [17, 24, 39],
];
const GREY_FILL = 0.40;        // CA seed fill for grey chunks (caves use 0.38; below ~0.33 the CA collapses to nothing)
const GREY_MIN_DIST = 12;      // cells from the starter: no grey near the opening
const GREY_HP_MIN = 30, GREY_HP_MAX = 100;
const GREY_GOLD_CHANCE = 0.8;  // grey drops: mostly gold (XP is easy mid-game)
const MOVE_DUR = 0.25; // seconds to glide from one cell to the next (moles)
const HARVESTER_STEP_DUR = 1.0; // seconds per harvester step — slow on purpose, so speed (not range) limits collection
const MOLE_NUGGET_BIAS = 0.7; // blue mole: 70% toward nearest nugget, 30% random wander
// Enemy moles: while the red Bloom lives, it buys moles toward blue
// from its bank (same mole pricing as blue: base + step per living
// mole). Up to RED_MOLE_MAX alive — the cost, not a timer, is the
// limiter, so the enemy has to earn its army from its own fields.
const RED_MOLE_MAX = 3;
// Enemy bloom head start: Growth 3 (1.2^3 = 1.73x) vs the player's
// fresh bloom at Growth 0 — the early overwhelmed feeling, same rules.
const RED_BLOOM_GROWTH = 3;
// Territory harvest: a cell glows over HARVEST_EVERY seconds, then has
// this chance to produce (same as the rock XP surprise, not a salary).
const BLOOM_HARVEST_CHANCE = 0.3;

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
  const base = st === GREY ? GREY_SHADES[S.shade[i] || 0] : TERRAIN[max];
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
const UNLOCK_COST = { gather: 10, mole: 20, bloom: 40 }; // cannon is free
// Temporarily removed: rocket (20), laser (30), lantern (10) — focus is cannon/mole/bloom/gather.
const meta = { gold: 0, unlocks: { cannon: true, gather: false, mole: false, bloom: false } };
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
  const t = { x, y, color, type, hp: maxhp, maxhp, base, angle: base, dir: 1,
              cd: Math.random(), dead: false, coolT: 0, burstLeft: 0, burstT: 0 };
  if (type === 'mole') {
    // Digger: burrows through rock, turning randomly, dies after N cells.
    t.moleDir = Math.floor(Math.random() * 4);
    t.dug = 0;
    t.lifetime = MOLE_LIFETIME_MIN + Math.floor(Math.random() * (MOLE_LIFETIME_MAX - MOLE_LIFETIME_MIN + 1));
    t.digT = 0;
    // Smooth-movement render state (glides cell to cell, no jumps).
    t.rx = x; t.ry = y; t.moveT = 1;
  }
  if (type === 'gather') {
    // Harvester: roams the grid toward pickups (see harvesterStep).
    t.rx = x; t.ry = y; t.moveT = 1; t.stepT = 0;
  }
  return t;
}
// Gather pickups per pull, from its Count stat track.
function gatherCount() {
  const w = S.weapons.gather;
  return 1 + (w && w.stats ? (w.stats.count || 0) : 0);
}
// Harvester pathing: BFS (not A* — we just need the nearest reachable
// pickup, and BFS guarantees it avoids walls). From the Harvester's cell,
// over open ground (EMPTY or own BLUE territory, never rock/grey/red,
// never another turret), find the closest idle pickup anywhere reachable.
// No range cap: it goes as far as it likes, slowly — slowness is the
// limiter, not distance, which is why you might want a second one.
// Returns the next cell to step into, or null when nothing is reachable
// at all (no idle pickups on open ground).
function harvesterStep(t) {
  const W = cfg.cols, H = cfg.rows;
  const start = t.y * W + t.x;
  const dist = new Int32Array(W * H).fill(-1);
  const prev = new Int32Array(W * H).fill(-1);
  const q = [start];
  dist[start] = 0;
  // Idle pickups by cell (first one per cell wins).
  const pickAt = new Map();
  for (const c of S.coins) {
    if (c.state !== 'idle') continue;
    const pi = Math.floor(c.y) * W + Math.floor(c.x);
    if (!pickAt.has(pi)) pickAt.set(pi, c);
  }
  let qi = 0, found = -1;
  while (qi < q.length && found < 0) {
    const cur = q[qi++];
    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] >= 0) continue;
      const cell = S.cells[ni];
      if (cell !== EMPTY && cell !== BLUE) continue; // walls: rock, grey, red
      if (turretAt(nx, ny)) continue; // occupied
      dist[ni] = dist[cur] + 1;
      prev[ni] = cur;
      if (pickAt.has(ni)) { found = ni; break; }
      q.push(ni);
    }
  }
  if (found < 0) return null;
  // Backtrack to the first step from the start.
  let cur = found;
  while (prev[cur] !== start && prev[cur] >= 0) cur = prev[cur];
  return { nx: cur % W, ny: Math.floor(cur / W) };
}
// Harvester collection: when a Gather steps onto (or is already on) a
// cell, it collects up to Count idle pickups ON THAT CELL ONLY (stacked
// pickups on one cell, up to Count per stop). No reach: it must enter
// a pickup's exact cell to collect it — adjacent pickups stay idle
// until it steps onto them. Collected pickups fly to the HUD like
// tapped ones (same 'fly' state, same grant on arrival).
function collectAtGather(t) {
  const here = [];
  for (const c of S.coins) {
    if (c.state !== 'idle') continue;
    if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y) here.push(c);
  }
  const take = here.slice(0, gatherCount());
  for (const c of take) {
    c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
  }
  return take.length;
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
// Greedy direction from (cx, cy) toward the nearest unbroken gold nugget
// (WHITE cell with goldNug set). Null when no nuggets remain.
function moleDirToNugget(cx, cy) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < S.cells.length; i++) {
    if (S.cells[i] !== WHITE || !S.goldNug[i]) continue;
    const x = i % cfg.cols, y = Math.floor(i / cfg.cols);
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return null;
  const bx = best % cfg.cols, by = Math.floor(best / cfg.cols);
  const dx = bx - cx, dy = by - cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 1 : (dx < 0 ? 3 : 0);
  return dy > 0 ? 2 : 0;
}
// Greedy direction from (cx, cy) toward the nearest blue turret: pick the
// axis with the larger gap (dirs: 0 up, 1 right, 2 down, 3 left). This is
// how red moles encroach instead of wandering.
function moleDirToward(cx, cy) {
  const b = nearestBlueTurret(cx + 0.5, cy + 0.5);
  if (!b) return Math.floor(Math.random() * 4);
  const dx = (b.x + 0.5) - (cx + 0.5), dy = (b.y + 0.5) - (cy + 0.5);
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}
// Spawn one red mole from the red Bloom's cave (nearest open cell within
// 5). Only while the Bloom lives — kill it and the pressure stops (the
// moles already out must still be mopped up).
function spawnRedMole() {
  const bloom = S.turrets.find(t => !t.dead && t.color === RED && t.type === 'bloom');
  if (!bloom) return false;
  let best = null, bd = Infinity;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (S.cells[i] !== EMPTY) continue;
      if (turretAt(x, y)) continue;
      const d = (x - bloom.x) ** 2 + (y - bloom.y) ** 2;
      if (d > 25 || d >= bd) continue;
      bd = d; best = { x, y };
    }
  }
  if (!best) return false;
  const m = mkTurret(best.x, best.y, RED, 'mole');
  m.moleDir = moleDirToward(best.x, best.y);
  S.turrets.push(m);
  return true;
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
    // Kill reward: 3 gold coins scattered around the wreck.
    for (let k = 0; k < 3; k++) {
      if (S.coins.length >= 800) break;
      S.coins.push({ x: t.x + 0.5 + (Math.random() - 0.5) * 2,
                     y: t.y + 0.5 + (Math.random() - 0.5) * 2,
                     state: 'idle', kind: 'gold', phase: Math.random() * 6.283,
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
  // A fresh run clears any finish/victory UI from the last one.
  if (typeof finishbtn !== 'undefined' && finishbtn) finishbtn.classList.add('hidden');
  if (typeof victory !== 'undefined' && victory) victory.classList.add('hidden');
  if (typeof commander !== 'undefined' && commander) commander.classList.add('hidden');
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
        // weapons (VS-style): per-type stat tracks + derived mults. Picking
        // a stat card fills one chip on that track.
        weapons: {},
        // Red mirrors blue's weapon system (same STAT_DEFS, same
        // applyStat), just a separate object — so red can start ahead
        // (bloom Growth 3) without touching blue's tracks.
        redWeapons: {},
        // Enemy bank: red gold, earned from red territory harvest, spent
        // on red moles (same pricing as blue). Starts at 0 — red has to
        // earn its first mole.
        redGold: 0,
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
  // Survival: the flood controller (random edge, wave timer). Its own
  // RNG stream, so the map below is identical to main for the same seed.
  S.flood = floodInit(seed);

  // Caves first (cellular-automata blobs), then HP from a smooth noise gradient:
  // white ~3 hits ... dark grey ~10 hits
  const cave = genCaves(cfg.cols, cfg.rows, cfg.caveChance, rng);
  const noise = makeNoise2D(rng);
  // Raw fbm clusters in the middle (0.16–0.89 on a typical map), so the
  // lightest and darkest rock never appeared. Normalize per map: stretch
  // the observed range to 0–1, so all 8 HP levels show up every seed.
  // Same field, just wider values — blob edges get steeper HP ramps while
  // blob centers stay smooth. Grey reuses this field (see below).
  const raw = new Float32Array(cfg.cols * cfg.rows);
  let vmin = 1, vmax = 0;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      raw[i] = noise((x / cfg.cols) * 3.5, (y / cfg.rows) * 3.5);
      if (!cave[i]) {
        if (raw[i] < vmin) vmin = raw[i];
        if (raw[i] > vmax) vmax = raw[i];
      }
    }
  }
  const vspan = (vmax - vmin) || 1; // degenerate map guard
  const norm = v => (v - vmin) / vspan;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      // Visual shade for empty cells (Perlin, no gameplay effect).
      shade[i] = Math.round(noise((x / cfg.cols) * 4.5 + 10, (y / cfg.rows) * 4.5 + 10) * 7);
      if (cave[i]) { cells[i] = EMPTY; continue; }
      cells[i] = WHITE;
      const m = 3 + Math.round(norm(raw[i]) * 7);
      maxhp[i] = m; hp[i] = m;
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
  // The starter is always Cannon; the shop only gates mid-run drafts.
  S.turrets.push(mkTurret(pc.x, pc.y, BLUE, 'cannon'));
  S.weapons.cannon = { stats: initWeaponStats('cannon'), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false };
  // Enemy head start: red bloom at Growth 3 (same stat, same formula as
  // blue's Growth picks — just pre-applied, so red spreads faster early).
  S.redWeapons.bloom = { stats: initWeaponStats('bloom'), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false };
  S.redWeapons.bloom.stats.growth = RED_BLOOM_GROWTH;
  applyStat(S.redWeapons.bloom, 'bloom', 'growth');
  // Grey rock: hard mid-map chunks, same CA blobs as caves but only where
  // the map is central AND far from the starter — never around the opening.
  // Only brown terrain converts (caves stay open); HP + shade come from the
  // same noise field as brown, scaled to 30–100.
  {
    const greyMask = genCaves(cfg.cols, cfg.rows, GREY_FILL, rng);
    const x0 = cfg.cols * 0.25, x1 = cfg.cols * 0.75, y0 = cfg.rows * 0.25, y1 = cfg.rows * 0.75;
    for (let y = 0; y < cfg.rows; y++) {
      for (let x = 0; x < cfg.cols; x++) {
        const i = y * cfg.cols + x;
        if (!greyMask[i] || cells[i] !== WHITE) continue;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        const dx = x - pc.x, dy = y - pc.y;
        if (dx * dx + dy * dy < GREY_MIN_DIST * GREY_MIN_DIST) continue;
        // Same normalized field as brown: grey now spans its full 30–100
        // and all 8 grey shades (it had the same middle-clustering bug).
        const v = norm(raw[i]);
        cells[i] = GREY;
        maxhp[i] = hp[i] = GREY_HP_MIN + Math.round(v * (GREY_HP_MAX - GREY_HP_MIN));
        shade[i] = Math.round(v * 7);
      }
    }
  }
  // Gold nuggets: 1% of rock cells seed a cluster of 1-5 contiguous cells.
  // The gold is locked until the rock is broken. (Runs after grey, so
  // nuggets only ever land on brown — grey has its own drop.)
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
  // Red Bloom: always spawns in a distant cave (not the starter's).
  // It grows red territory — a reason to push out and kill it. Wiping it
  // out (turret + all red cells) is the round's win condition.
  // SURVIVAL: no enemy base — the flood replaces it, so skip the bloom
  // (checkWin then never fires; survival is endless until overrun).
  S.redBloomSpawned = false;
  if (!SURVIVAL) {
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
      S.redBloomSpawned = true;
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
    runstats.innerHTML = SURVIVAL
      ? 'Flood storms <b>' + (S.flood ? S.flood.storms : 0) + '</b> · Level <b>' + S.level + '</b><br>' +
        'Survived <b>' + Math.round(S.time) + 's</b> · ' +
        'Excavated <b>' + S.destroyed + '</b> · ' +
        'Gold <b>' + meta.gold + '</b>'
      : 'Wave <b>' + S.wave + '</b> · Level <b>' + S.level + '</b><br>' +
        'Survived <b>' + Math.round(S.time) + 's</b> · ' +
        'Excavated <b>' + S.destroyed + '</b> · ' +
        'Red turrets destroyed <b>' + S.redKills + '</b> · ' +
        'Gold <b>' + meta.gold + '</b>';
    runover.classList.remove('hidden');
  }
}

// ---- Flood (SURVIVAL BRANCH) ----
// The asymmetric enemy: not a base, but damage from a direction.
// A flood controller picks a random edge per run, then fires waves of
// projectiles in patterns (a sweeping line, or scattered rain/hail)
// from that edge. Flood shots damage rock and player territory, and
// claim what they destroy as flood territory (RED internally, blue
// on screen after the palette flip) — so the flood visibly advances
// as a front the player must push back, not a transient event.
// No classes in this codebase (plain functions + S state), so the
// flood is a controller object on S plus these functions.
const SURVIVAL = true; // survival branch: player renders red, flood is blue, enemy base off
const FLOOD_GRACE_DUR = 300;  // 5 min grace before the first storm: prepare your base (commander dialog gives the ETA)
const FLOOD_TOAST_AT = 30;    // seconds before a storm when the old toast countdown returns (earlier in the lull: minimap pulse only)
const FLOOD_FIRST_STORM = 30; // seconds of lull after grace before the first storm (toast shows the whole time: 30 <= 30)
const FLOOD_STORM_DUR = 20;   // seconds a storm barrages, then it passes
const FLOOD_LULL = 60;        // seconds between storms (was 20: lengthened so pulse (60→30) + toast (30→0) both get a window)
const FLOOD_DMG = 1;          // per flood projectile — constant barrage, so toned down (was 2)
const FLOOD_SPEED = 8;        // cells/s — slower than player shots (12.5), a lumbering front
const FLOOD_OFF = 3;          // cells outside the map the emitter sits (never seen)
const FLOOD_SWEEP_EVERY = 0.12; // seconds between sweeping-cannon shots
const FLOOD_SWEEP_RATE = Math.PI / 2; // rad/s the sweep rotates (90 deg/s)
const FLOOD_RING_EVERY = 1.2; // seconds between radial ring bursts
const FLOOD_RING_DIRS = 24;   // directions per ring (before culling)
const FLOOD_SPREAD_EVERY = 2; // seconds between gradual-spread ticks
const FLOOD_SPREAD_CHANCE = 0.1; // per flood cell per spread tick: grow one adjacent EMPTY cell
const FLOOD_DIRS = ['north', 'south', 'west', 'east']; // edge the flood comes FROM
// dir: 0 = from top, 1 = from bottom, 2 = from left, 3 = from right.
// The emitter is a single point just outside the map on that edge —
// never seen, only its effects creeping in. Each storm picks a new
// dir + position along the edge, so storms surprise from anywhere.
// Own RNG stream (seed + 99991) for the FIRST storm, so flood setup
// never shifts the map-gen stream — same seed still builds the same
// map as main. Later storms use Math.random (runtime events).
function floodPickDir(f, rng) {
  const W = cfg.cols, H = cfg.rows;
  f.dir = Math.floor(rng() * 4);
  if (f.dir === 0) { f.ex = rng() * W; f.ey = -FLOOD_OFF; }
  else if (f.dir === 1) { f.ex = rng() * W; f.ey = H + FLOOD_OFF; }
  else if (f.dir === 2) { f.ex = -FLOOD_OFF; f.ey = rng() * H; }
  else { f.ex = W + FLOOD_OFF; f.ey = rng() * H; }
}
function floodInit(seed) {
  const f = { dir: 0, ex: 0, ey: 0, phase: 'grace', timer: FLOOD_GRACE_DUR,
              sweep: 0, ringT: 0, sweepT: 0, storms: 0, spreadT: FLOOD_SPREAD_EVERY };
  floodPickDir(f, mulberry32(seed + 99991));
  return f;
}
// Gradual, bloom-like spread: each flood cell has a chance to grow one
// increment on a random adjacent EMPTY cell (8-dir); 4 increments
// (quarters, same GROW_STEPS as bloom) → flood, fresh and weak (HP 1).
// No pickup — flood never pays. Runs always (storm or lull): the flood
// creeps even between storms, so waiting it out doesn't work.
function floodSpread() {
  const W = cfg.cols, H = cfg.rows;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (S.cells[i] !== RED) continue;
      if (Math.random() >= FLOOD_SPREAD_CHANCE) continue;
      const dx = Math.floor(Math.random() * 3) - 1, dy = Math.floor(Math.random() * 3) - 1;
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (S.cells[ni] !== EMPTY || S.growN[ni] >= GROW_STEPS) continue;
      if (S.growBy[ni] !== 0 && S.growBy[ni] !== RED) continue;
      if (turretAt(nx, ny)) continue;
      S.growN[ni]++;
      S.growBy[ni] = RED;
      S.growT[ni] = S.time;
      if (S.growN[ni] >= GROW_STEPS) {
        S.cells[ni] = RED;
        S.hp[ni] = 0; S.maxhp[ni] = 0; S.harvT[ni] = 0; // no HP on flood
        S.growN[ni] = 0; S.growBy[ni] = 0;
        spawnBurst(nx + 0.5, ny + 0.5, CELL_COLORS[RED]);
        S.rings.push({ x: nx + 0.5, y: ny + 0.5, t: 0, css: CELL_COLORS[RED], dead: false });
      }
    }
  }
}
// Ray from the (off-map) emitter along unit (dx, dy): where does it
// ENTER the map? Returns that point nudged just inside, or null if the
// ray never hits the map — those shots are never spawned (Sam: don't
// spawn projectiles we'll never see). Projectiles can't spawn outside
// the map (stepProjectile kills out-of-bounds shots on the first step),
// so the emitter stays virtual and shots start at the edge entry.
function floodEntry(ex, ey, dx, dy) {
  const W = cfg.cols, H = cfg.rows;
  let tmin = 0, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ex < 0 || ex > W) return null;
  } else {
    let t1 = (0 - ex) / dx, t2 = (W - ex) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-9) {
    if (ey < 0 || ey > H) return null;
  } else {
    let t1 = (0 - ey) / dy, t2 = (H - ey) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (tmax < tmin || tmax < 0) return null;
  const t = Math.max(tmin, 0) + 0.05; // just inside the first cell
  return { x: ex + dx * t, y: ey + dy * t };
}
// One flood shot at angle (radians) from the emitter — culled if its
// ray never reaches the map. Returns true when a shot was spawned.
function floodFireAt(angle) {
  const f = S.flood;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const e = floodEntry(f.ex, f.ey, dx, dy);
  if (!e) return false;
  // bounces = max: flood shots never pinball (that's the player's passive).
  S.projs.push({ x: e.x, y: e.y, vx: dx * FLOOD_SPEED, vy: dy * FLOOD_SPEED,
                 color: RED, dmg: FLOOD_DMG, flood: true, bounces: BOUNCE_MAX, crit: false, dead: false });
  return true;
}
function floodFireRing() {
  for (let k = 0; k < FLOOD_RING_DIRS; k++) floodFireAt(k * 2 * Math.PI / FLOOD_RING_DIRS);
}
function floodTick(dt) {
  const f = S.flood;
  if (!f || S.runOver) return;
  // Gradual spread ticks always (storm or lull), on its own clock.
  if (f.spreadT === undefined) f.spreadT = FLOOD_SPREAD_EVERY;
  f.spreadT -= dt;
  if (f.spreadT <= 0) { f.spreadT += FLOOD_SPREAD_EVERY; floodSpread(); }
  f.timer -= dt;
  if (f.phase === 'grace') {
    // Grace: prepare your base. No storms, no warnings — the
    // commander dialog already gave the ETA. Spread no-ops here
    // (no RED cells exist yet, so floodSpread finds nothing).
    wavebanner.classList.add('hidden'); // no stale toast
    if (f.timer <= 0) {
      // Grace over: first lull, direction already picked at init,
      // so the toast (30s) warns the whole way to the first storm.
      f.phase = 'lull';
      f.timer = FLOOD_FIRST_STORM;
    }
    return;
  }
  if (f.phase === 'lull') {
    if (f.timer <= 0) {
      f.phase = 'storm';
      f.timer = FLOOD_STORM_DUR;
      f.sweep = 0; f.ringT = 0; f.sweepT = 0; // fire immediately
      f.storms++;
      wavebanner.classList.add('hidden'); // storm: no toast (flood visible)
      return;
    }
    // Final 30s before the storm: the old toast countdown returns
    // (explicit, urgent). Earlier in the lull the minimap pulse
    // carries the warning quietly (see drawMinimap).
    if (f.timer <= FLOOD_TOAST_AT) {
      wavebanner.textContent = 'FLOOD STORM FROM THE ' + FLOOD_DIRS[f.dir].toUpperCase() + ' IN ' + Math.max(1, Math.ceil(f.timer)) + 's';
      wavebanner.classList.remove('hidden');
    } else {
      wavebanner.classList.add('hidden'); // early lull: pulse only
    }
    return;
  }
  // Storm: constant barrage — a sweeping cannon plus radial rings.
  // No banner and no pulse while it runs: the flood is visible on
  // the minimap as blue territory creeping in from the side.
  f.sweepT -= dt;
  if (f.sweepT <= 0) { f.sweepT += FLOOD_SWEEP_EVERY; floodFireAt(f.sweep); }
  f.sweep += FLOOD_SWEEP_RATE * dt;
  f.ringT -= dt;
  if (f.ringT <= 0) { f.ringT += FLOOD_RING_EVERY; floodFireRing(); }
  if (f.timer <= 0) {
    // Storm passes: lull, and pick the NEXT storm's direction now so
    // the minimap pulse can name it. New lull starts in pulse phase
    // (timer 60 > 30), so hide any toast explicitly.
    f.phase = 'lull';
    f.timer = FLOOD_LULL;
    floodPickDir(f, Math.random);
    wavebanner.classList.add('hidden');
  }
}

// ---- Firing ----
// Fires ONE cannon shot along the current sweep angle. Multishot is a
// staggered burst (see the cannon update: shoot, brief pause, shoot),
// not a simultaneous fan — the sweep itself spreads the shots.
function fireTurret(t) {
  const speed = cfg.projSpeed / CELL_PX; // cells per second
  const w = t.color === BLUE ? S.weapons.cannon : null;
  const mx = t.x + 0.5 + Math.cos(t.angle) * 1.1;
  const my = t.y + 0.5 + Math.sin(t.angle) * 1.1;
  let dmg = TURRET.cannon.dmg + S.dmgBonus + weaponDmgBonus(t);
  let crit = false;
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
    paintLeft: (w && w.penDepth) || 1, // painting depth: flood cells this shot can still flip
    dead: false,
  });
}
const BURST_GAP = 0.09; // seconds between staggered multishot rounds
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
      if ((S.cells[i] !== WHITE && S.cells[i] !== GREY) || S.fog[i] !== 0) continue; // can't snipe what you can't see
      const hp = S.hp[i];
      const d = (x - t.x) * (x - t.x) + (y - t.y) * (y - t.y);
      if (hp < bestHp || (hp === bestHp && d < bd)) { bestHp = hp; bd = d; bx = x; by = y; bi = i; }
    }
  }
  return bi < 0 ? null : { x: bx, y: by, i: bi };
}
function fireLaser(t) {
  if (SURVIVAL) {
    // Anti-flood only: paint the nearest VISIBLE flood cell (line of
    // sight = fog cleared). If no flood is in sight, do nothing —
    // the laser sits idle, which is the drama: it activates the
    // moment flood finally approaches. Never zaps rock on survival.
    // Painting (flip to player color), not HP damage: flood has no
    // HP anymore, so the laser paints like the cannon, just with a
    // beam to one precise cell instead of a penetrating line.
    const tgt = weakestFlood(t);
    if (!tgt) return;
    S.beams.push({ x1: (t.x + 0.5) * CELL_PX, y1: (t.y + 0.5) * CELL_PX,
                   x2: (tgt.x + 0.5) * CELL_PX, y2: (tgt.y + 0.5) * CELL_PX, t: 0 });
    const i = tgt.i;
    S.cells[i] = t.color;
    S.growN[i] = 0; S.growBy[i] = 0; S.harvT[i] = 0;
    S.hp[i] = 0; S.maxhp[i] = 0;
    spawnBurst(tgt.x + 0.5, tgt.y + 0.5, CELL_COLORS[t.color]);
    return;
  }
  const tgt = weakestBlock(t);
  if (!tgt) return; // nowhere left to dig
  S.beams.push({ x1: (t.x + 0.5) * CELL_PX, y1: (t.y + 0.5) * CELL_PX,
                 x2: (tgt.x + 0.5) * CELL_PX, y2: (tgt.y + 0.5) * CELL_PX, t: 0 });
  damageBlock(tgt.i, TURRET.laser.dmg + S.dmgBonus + weaponDmgBonus(t), t.color,
              t.x + 0.5, t.y + 0.5, tgt.x - t.x, tgt.y - t.y);
}
// Weakest VISIBLE flood cell (survival Laser target): flood (RED) with
// fog cleared (line of sight), lowest HP first, nearest on ties —
// same shape as weakestBlock, but flood-only, never rock.
function weakestFlood(t) {
  // Nearest VISIBLE flood cell (survival Laser target): flood (RED)
  // with line of sight (fog cleared). No HP anymore, so nearest wins
  // (not weakest — all flood paints the same).
  let bx = -1, by = -1, bi = -1, bd = Infinity;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      if (S.cells[i] !== RED || S.fog[i] !== 0) continue; // needs line of sight to flood
      const d = (x - t.x) * (x - t.x) + (y - t.y) * (y - t.y);
      if (d < bd) { bd = d; bx = x; by = y; bi = i; }
    }
  }
  return bi < 0 ? null : { x: bx, y: by, i: bi };
}
// Bloom: Tiberium-style territory. Every interval it makes one growth
// increment on the nearest empty cell in radius (preferring cells it has
// already started). GROW_STEPS increments turn the cell into solid territory
// of the Bloom's color, which then feeds its owner's harvest (blue map
// pickups, red banked gold).
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
    if (cell === WHITE || cell === GREY) {
      const destroyed = damageBlock(idx, p.dmg || 1, p.color, p.x, p.y, p.vx, p.vy, p.crit);
      if (destroyed) {
        // Flood claim: a flood shot that breaks rock takes the cell
        // (the flood advances as it destroys). No HP: flood is just
        // a uniform color to paint, not a rock to chip.
        if (p.flood) {
          S.cells[idx] = p.color;
          S.hp[idx] = 0; S.maxhp[idx] = 0; S.harvT[idx] = 0;
          S.growN[idx] = 0; S.growBy[idx] = 0;
        }
        p.dead = true; return;
      }
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
    if (SURVIVAL && cell === RED && !p.flood) {
      // Player shot vs flood: PAINTS it (flips to player color,
      // instant, no HP). Penetration: the shot keeps flying, painting
      // up to paintLeft flood cells in its path, then dies. Rock still
      // stops it (digs, as before); empty/own-color pass through.
      // No damage number: it's a flip, not damage — just a paint burst
      // in the new color. Painted territory harvests like field-grown
      // territory (fresh harvT, no leftover flood growth).
      S.cells[idx] = p.color;
      S.growN[idx] = 0; S.growBy[idx] = 0; S.harvT[idx] = 0;
      S.hp[idx] = 0; S.maxhp[idx] = 0; // no HP on colored cells anymore
      spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[p.color]);
      if (p.paintLeft === undefined) p.paintLeft = 1; // base depth for shots without it
      p.paintLeft--;
      if (p.paintLeft <= 0) { p.dead = true; return; }
      continue; // still painting: keep flying to the next cell
    }
    // Enemy territory: normally bombed back to empty. A flood shot
    // claims it instead (the flood takes over what it washes over).
    // No HP on the claim: flood is paintable color, not chippable rock.
    if (p.flood) {
      S.cells[idx] = p.color;
      S.hp[idx] = 0; S.maxhp[idx] = 0; S.harvT[idx] = 0;
    } else {
      S.cells[idx] = EMPTY;
    }
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
      if (S.cells[ni] !== WHITE && S.cells[ni] !== GREY) continue;
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
  const wasGrey = S.cells[idx] === GREY;
  S.cells[idx] = EMPTY; // excavated: the block is gone, not painted over
  S.destroyed++;
  if (color === BLUE) S.destroyedBlue++;
  computeFog(); // the cave grew: push the fog boundary out
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[color]); // the block cracks: debris + ring
  if (S.goldNug[idx] && (color === BLUE || !SURVIVAL)) {
    // Gold nugget released: locked until the rock was broken.
    // (Survival: flood never pays — a flood shot breaking a nugget
    // drops nothing. Main: any breaker drops it, as before.)
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
  if (wasGrey && color === BLUE) {
    // Grey rock pays mostly gold (XP is easy mid-game): a guaranteed
    // pickup, 80% gold / 20% XP — the reward for chewing hard rock.
    const kind = Math.random() < GREY_GOLD_CHANCE ? 'gold' : 'xp';
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind,
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

// Card pool: turret entries feed the SHOP row (placements); the XP row
// draws from stat cards (one per weapon stat), Bag of Gold, and passives.
// `needs` gates an upgrade on owning a turret it actually affects — no
// steering card before you've got a rocket.
function buildCardPool() { return [
  { kind: 'turret', type: 'cannon', title: 'Cannon', icon: ICONS.cannon, sub: 'Sweeps shots in an arc, blasting rock.' },
  { kind: 'turret', type: 'rocket', title: 'Rocket', icon: ICONS.rocket, sub: 'Fires homing missiles that crash and splash-dig.' },
  { kind: 'turret', type: 'laser', title: 'Laser', icon: ICONS.laser, sub: 'Waits for flood, then paints it.' },
  { kind: 'turret', type: 'bloom', title: 'Field', icon: ICONS.bloom, sub: 'Grows territory that harvests gold coins.' },
  { kind: 'turret', type: 'lantern', title: 'Lantern', icon: ICONS.lantern, sub: 'Pushes back the fog of war.' },
  { kind: 'turret', type: 'gather', title: 'Harvester', icon: ICONS.gather, sub: 'Steps onto pickups to collect them, slowly.' },
  { kind: 'turret', type: 'mole', title: 'Digger', icon: ICONS.mole, sub: 'Digs tunnels through rock.' },
  { kind: 'turret', type: 'wall', title: 'Wall', icon: ICONS.wall, sub: '2x2 defensive barrier.' },
  // Stat cards, generated from STAT_DEFS (cannon/bloom/gather only — mole
  // dig advances via the shop bundle, never as a free XP pick; shopOnly
  // stats like projectiles are bought with gold, not XP).
  ...['cannon', 'bloom', 'gather'].flatMap(weapon =>
    STAT_DEFS[weapon].filter(d => !d.shopOnly).map(d => ({
      kind: 'stat', weapon, stat: d.key, cap: d.cap,
      title: d.name, icon: ICONS[weapon], effect: d.effect,
    }))),
  // Bag of Gold: the XP-for-gold exchange. A free XP-row pick that grants
  // run gold — the bridge to a shop unit you can see but can't afford yet.
  // Amount rolls at deal time (3–5): you see what you get before picking.
  { kind: 'gold', title: 'Bag of Gold', icon: ICONS.gold },
  { kind: 'passive', passive: 'bounce', title: 'Bounce', icon: ICONS.bounce, sub: 'Shots ricochet off rock.', needs: ['cannon'] },
  { kind: 'steer', mult: 1.3, title: '+30%', icon: ICONS.steer, sub: 'Missile steering', needs: ['rocket'] },
]; }
let CARD_POOL = buildCardPool();
function hasTurretTypes(types) {
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    if (types.includes(t.type)) return true;
  }
  return false;
}
function availableCards() {
  // XP row: FREE cards only. Turret placements live in the shop row, so
  // no turret kind appears here at all. What remains: stat cards for
  // owned weapons (below cap; EVO'd cannon offers no more stats),
  // Bag of Gold, passives, and the EVO capstone when earned.
  const pool = CARD_POOL.filter(c => {
    if (c.kind === 'turret') return false;
    if (c.kind === 'stat') {
      const w = S.weapons[c.weapon];
      if (!w || !w.stats) return false;
      if (c.weapon === 'cannon' && w.evo) return false;
      return (w.stats[c.stat] || 0) < c.cap;
    }
    if (c.kind === 'passive') return S.passives[c.passive] < 8;
    return (!c.needs || hasTurretTypes(c.needs));
  });
  if (cannonMaxed()) {
    pool.push({ kind: 'evo', title: 'Sprayer', icon: ICONS.cannon, sub: 'Blazing-fast sweep spray' });
  }
  if (SURVIVAL) {
    // Projectiles hybrid (survival only): back in the XP row as a
    // randomized draft card, but it costs gold (like a shop card).
    // If you see it and can afford it, it's a strong pick — but it
    // still consumes the level-up (pick-one holds). Main keeps proj
    // in the shop (v75, unchanged).
    const cw = S.weapons.cannon;
    if (cw && cw.stats && (cw.stats.proj || 0) < 5) {
      pool.push({ kind: 'proj', weapon: 'cannon', stat: 'proj',
        title: 'Projectiles', icon: ICONS.cannon, cost: projCost() });
    }
  }
  return pool;
}
// Shop row: one placement card per active unit type, plus gold-gated stat
// upgrades (currently just cannon projectiles), affordable or not.
// Unaffordable ones still show (greyed) so you can see what to save for.
function availableShopCards() {
  if (SURVIVAL) {
    // Full shop (no proj — it's an XP hybrid now): all 7 placements,
    // cost order (cheapest first) so you can plan ahead. No draw.
    // Laser is the pricey late-game anti-flood unit (20, last).
    const types = ['cannon', 'mole', 'bloom', 'gather', 'lantern', 'wall', 'laser'];
    const pool = CARD_POOL.filter(c => c.kind === 'turret' && types.includes(c.type)).map(c => ({
      ...c, cost: unitCost(c.type), owned: !!S.weapons[c.type],
    }));
    pool.sort((a, b) => a.cost - b.cost);
    return pool;
  }
  // Main: 4 placements + proj, drawn 2 at random (affordable-first) in offerShopCards.
  const types = ['cannon', 'mole', 'bloom', 'gather'];
  const pool = CARD_POOL.filter(c => c.kind === 'turret' && types.includes(c.type)).map(c => ({
    ...c, cost: unitCost(c.type), owned: !!S.weapons[c.type],
  }));
  const cw = S.weapons.cannon;
  if (cw && cw.stats && (cw.stats.proj || 0) < 5) {
    pool.push({ kind: 'proj', weapon: 'cannon', stat: 'proj',
      title: 'Projectiles', icon: ICONS.cannon, cost: projCost(), owned: true });
  }
  return pool;
}
// Projectile upgrade price: starts at 10 gold, +5 per level already owned
// (the shop's unit step) — 10, 15, 20, 25, 30 for the 5 levels.
function projCost() {
  const w = S.weapons.cannon;
  const lv = w && w.stats ? (w.stats.proj || 0) : 0;
  return 10 + lv * UNIT_COST_STEP;
}
function offerCards() {
  // XP row: 3 free cards, weighted draw without replacement. Bag of Gold
  // counts three-quarters (weight 0.75 vs 1 for everything else) — it's
  // uncapped, so without a discount it would crowd out real upgrades
  // as stats max out, but early on you're craving gold.
  // Slots beyond the pool stay hidden.
  const pool = availableCards().slice();
  const weight = p => p.kind === 'gold' ? 0.75 : 1;
  const els = document.querySelectorAll('#levelup .xpcard');
  els.forEach(el => {
    el.classList.remove('dealt', 'unaffordable');
    el.dataset.kind = ''; el.dataset.type = ''; el.dataset.mult = '';
    el.dataset.add = ''; el.dataset.passive = ''; el.dataset.stat = '';
    el.dataset.cost = ''; el.dataset.amount = ''; el.dataset.weapon = '';
    el.innerHTML = ''; el.style.display = 'none';
  });
  for (let k = 0; k < els.length && pool.length; k++) {
    let total = 0;
    for (const p of pool) total += weight(p);
    let r = Math.random() * total, pi = 0;
    while (pi < pool.length - 1 && (r -= weight(pool[pi])) > 0) pi++;
    const p = pool.splice(pi, 1)[0];
    const el = els[k];
    el.style.display = '';
    el.dataset.kind = p.kind;
    el.dataset.type = p.type || '';
    el.dataset.mult = p.mult || '';
    el.dataset.add = p.add || '';
    el.dataset.passive = p.passive || '';
    el.dataset.amount = p.amount || '';
    el.dataset.stat = '';
    el.dataset.cost = '';
    el.dataset.weapon = '';
    const lv = p.kind === 'passive' ? S.passives[p.passive] : 0;
    let title = p.title, sub = p.sub, newTag = '', priceHtml = '';
    const icon = `<div class="icon">${p.icon || ''}</div>`;
    // VS-style: first time bringing it into the run gets a yellow "New!" tag,
    // separate from the name.
    if (p.kind === 'passive' && lv === 0) newTag = '<span class="newtag">New!</span>';
    else if (p.kind === 'passive' && lv > 0) {
      title = `${p.title} <span class="lv">Lv${lv + 1}</span>`;
      // Show the stat change, not just the description.
      if (p.passive === 'bounce') sub = `+${Math.round(cfg.bouncePerLevel * 100)}% bounce chance`;
    }
    else if (p.kind === 'stat') {
      // One stat, one chip: title is the stat + its NEW level, sub the effect.
      // The weapon icon says which weapon it belongs to.
      // First pick of a stat (level 0 → 1) gets the yellow New! tag.
      const w = S.weapons[p.weapon];
      const cur = w && w.stats ? (w.stats[p.stat] || 0) : 0;
      title = `${p.title} <span class="lv">Lv${cur + 1}</span>`;
      sub = p.effect;
      el.dataset.weapon = p.weapon;
      el.dataset.stat = p.stat;
      if (cur === 0) newTag = '<span class="newtag">New!</span>';
    }
    else if (p.kind === 'evo') {
      title = `Sprayer <span class="lv">EVO</span>`;
      sub = p.sub;
    }
    else if (p.kind === 'gold') {
      // Roll the amount at deal time (3–5 gold): the card shows its roll.
      // A preset amount (tests/fixtures) wins over the roll.
      const amt = p.amount || (3 + Math.floor(Math.random() * 3));
      el.dataset.amount = amt;
      sub = `+${amt}<span class="coin"></span>`;
    }
    else if (p.kind === 'proj') {
      // Hybrid (survival): XP-row draft card with a gold cost. Shows
      // the price like a shop card; greyed + untappable if you can't
      // afford it (click handler's cost guard covers the rest).
      // First projectile pick gets New! like any other first stat.
      const w = S.weapons.cannon;
      const lv = w && w.stats ? (w.stats.proj || 0) : 0;
      title = `Projectiles <span class="lv">Lv${lv + 1}</span>`;
      sub = `+1 projectile`;
      el.dataset.weapon = 'cannon';
      el.dataset.stat = 'proj';
      el.dataset.cost = String(p.cost);
      priceHtml = `<div class="price">${p.cost}<span class="coin"></span></div>`;
      if (S.gold < p.cost) el.classList.add('unaffordable');
      if (lv === 0) newTag = '<span class="newtag">New!</span>';
    }
    el.innerHTML = priceHtml + icon + newTag + '<b>' + title + '</b><span>' + sub + '</span>';
    // Staggered deal: cards appear one by one (prevents accidental taps).
    setTimeout(() => el.classList.add('dealt'), 150 + k * 120);
  }
}
// Shop row: survival shows the FULL shop (all items, cost order, no
// draw) in a 3x3 grid; main keeps the original 2-card affordable-first
// random draw (unchanged).
function offerShopCards() {
  const pool = availableShopCards();
  const els = document.querySelectorAll('#levelup .shopcard');
  document.getElementById('shoplabel').innerHTML =
    'Shop<span class="shopgold">' + S.gold + '<span class="coin"></span></span>';
  els.forEach(el => {
    el.classList.remove('dealt', 'unaffordable');
    el.dataset.kind = ''; el.dataset.type = ''; el.dataset.stat = ''; el.dataset.cost = ''; el.dataset.weapon = '';
    el.innerHTML = ''; el.style.display = 'none';
  });
  let picks;
  if (SURVIVAL) {
    picks = pool; // full shop, cost order, no draw
  } else {
    const afford = pool.filter(p => p.cost <= S.gold);
    const pricey = pool.filter(p => p.cost > S.gold);
    picks = [];
    while (picks.length < 2 && afford.length) {
      picks.push(afford.splice((Math.random() * afford.length) | 0, 1)[0]);
    }
    while (picks.length < 2 && pricey.length) {
      picks.push(pricey.splice((Math.random() * pricey.length) | 0, 1)[0]);
    }
  }
  for (let j = 0; j < picks.length; j++) {
    const p = picks[j];
    const el = els[j];
    el.style.display = '';
    const affordable = S.gold >= p.cost;
    el.dataset.cost = p.cost;
    let title = p.title, sub, newTag = '';
    if (p.kind === 'proj') {
      // Gold-gated stat upgrade (not a placement): pay, fill one chip.
      // No New! tag — it's an upgrade to a weapon you already own.
      const w = S.weapons.cannon;
      const lv = w && w.stats ? (w.stats.proj || 0) : 0;
      el.dataset.kind = 'proj';
      el.dataset.weapon = 'cannon';
      el.dataset.stat = 'proj';
      title = `Projectiles <span class="lv">Lv${lv + 1}</span>`;
      sub = `+1 projectile`;
    } else {
      const w = S.weapons[p.type];
      el.dataset.kind = 'turret';
      el.dataset.type = p.type;
      if (!w) {
        newTag = '<span class="newtag">New!</span>';
        sub = p.sub;
        el.dataset.stat = 'place';
      } else if (p.type === 'mole') {
      // Mole bundle: always a fresh placement AND the upgrade, so you
      // never upgrade a Mole that already died. Dig track shown, capped
      // at 8 — after that the shop still sells plain placements.
      const dig = w.stats ? (w.stats.dig || 0) : 0;
      title = `${p.title} <span class="lv">Lv${Math.min(dig + 1, 8)}</span>`;
      sub = dig >= 8 ? `New digger` : `New digger · +1 dig damage`;
      el.dataset.stat = 'mole-place';
    } else {
      sub = `New turret`;
      el.dataset.stat = 'place';
    }
    }
    if (!affordable) el.classList.add('unaffordable');
    el.innerHTML = `<div class="price">${p.cost}<span class="coin"></span></div>` +
      `<div class="icon">${p.icon || ''}</div>` + newTag + '<b>' + title + '</b><span>' + sub + '</span>';
    // Deal after the XP row (cascade continues: slots 3, 4).
    setTimeout(() => el.classList.add('dealt'), 150 + (3 + j) * 120);
  }
}

document.querySelectorAll('#levelup .card').forEach(card => {
  card.addEventListener('click', () => {
    const kind = card.dataset.kind || 'freq';
    // Affordability guard: only gold-costing cards (shop placements +
    // proj hybrid) can be blocked. Free XP cards never carry a cost
    // (offerCards clears it), so a stale cost on a reused slot can't
    // block a free pick. (CSS blocks real taps too; this covers
    // programmatic clicks.)
    if ((kind === 'turret' || kind === 'proj') && parseInt(card.dataset.cost || '0', 10) > S.gold) return;
    // Choosing an upgrade resets the XP bar to zero (it stayed full
    // while the cards were showing).
    S.xp = 0; S.xpShown = 0; S.levelUpNeed = 0;
    if (kind === 'turret') {
      // Shop row only now (XP row has no turret cards): a placement, or
      // the Mole bundle (upgrade rides along with a fresh placement).
      const type = card.dataset.type;
      const w = S.weapons[type];
      const cost = parseInt(card.dataset.cost || '0', 10);
      if (w && card.dataset.stat === 'mole-place') {
        if (w.stats && (w.stats.dig || 0) < 8) {
          w.stats.dig++;
          w.dmgBonus = w.stats.dig;
        }
        S.gold -= cost;
        // fall through to placement below
      }
      // Placement mode: a bought unit (unowned first, owned duplicate)
      // deducts its gold card price, then tap the map to deploy.
      // (Mole bundle already deducted above.)
      if (cost > 0 && card.dataset.stat !== 'mole-place') S.gold -= cost;
      S.pending--;
      overlay.classList.add('hidden');
      updateHud();
      enterPlacement(type);
      return;
    }
    if (kind === 'stat') {
      // One stat, one chip: fill the next chip on that track (capped).
      const w = S.weapons[card.dataset.weapon];
      const st = card.dataset.stat;
      const def = (STAT_DEFS[card.dataset.weapon] || []).find(d => d.key === st);
      if (w && w.stats && def && (w.stats[st] || 0) < def.cap) {
        w.stats[st]++;
        applyStat(w, card.dataset.weapon, st);
      }
    } else if (kind === 'evo') {
      // Cannon capstone: all stat tracks maxed → becomes the Sprayer.
      if (S.weapons.cannon) S.weapons.cannon.evo = true;
    } else if (kind === 'proj') {
      // Gold-gated stat upgrade: pay, then fill one chip on the track.
      // (Affordability was already guarded above; no placement follows.)
      const w = S.weapons.cannon;
      const cost = parseInt(card.dataset.cost || '0', 10);
      if (w && w.stats && (w.stats.proj || 0) < 5) {
        S.gold -= cost;
        w.stats.proj++;
        applyStat(w, 'cannon', 'proj');
      }
    } else if (kind === 'passive') {
      const p = card.dataset.passive;
      if (S.passives[p] < 8) {
        S.passives[p]++;
        if (p === 'bounce') S.bounceChance = Math.min(0.95, S.passives.bounce * cfg.bouncePerLevel);
      }
    } else if (kind === 'steer') {
      S.steerMult *= parseFloat(card.dataset.mult);
    } else if (kind === 'gold') {
      // Bag of Gold: free XP pick that grants run gold.
      S.gold += parseInt(card.dataset.amount || '10', 10);
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
  if (SURVIVAL) showCommander();
});

// Placement: the chosen turret clears its own 1-cell pad and goes live.
// Wall: a 2x2 defensive barrier (GREY terrain, not a turret). Flood
// chews through it like rock (20 hits per cell at flood dmg 1), so it
// slows the flood rather than stopping it forever. Flat 2 gold —
// walls aren't turrets, so unitCost never escalates them.
const WALL_HP = 200;
const WALL_SHADE = 3; // mid grey ([107,114,128]) — reads as stone, distinct from natural grey variation
// Survival placement: units go near your base, not anywhere lit.
// (Matches fogDist, so a lantern extends the placeable range by 6.)
const PLACE_RADIUS = 6;
function nearBase(cx, cy) {
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    const dx = t.x - cx, dy = t.y - cy;
    if (dx * dx + dy * dy <= PLACE_RADIUS * PLACE_RADIUS) return true;
  }
  return false;
}
function enterPlacement(type) {  S.placing = { type };
  placebanner.innerHTML = SURVIVAL
    ? (type === 'lantern'
        ? 'Tap near your base or any clear open cell to deploy <b>Lantern</b>'
        : 'Tap near your base to deploy <b>' + TURRET[type].name + '</b>')
    : 'Tap the map to deploy <b>' + TURRET[type].name + '</b>';
  placebanner.classList.remove('hidden');
}
function placeTurretAt(sx, sy) {
  const type = S.placing.type;
  const wpt = screenToWorld(sx, sy);
  let cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  cx = Math.max(0, Math.min(cfg.cols - 1, cx));
  cy = Math.max(0, Math.min(cfg.rows - 1, cy));
  if (type === 'wall') {
    // 2x2 wall: anchor + right + down + diagonal must all be in bounds,
    // unoccupied, and EMPTY or BLUE (you can wall your own territory,
    // but walling it stops its harvest — wall on open ground when you can).
    if (cx + 1 >= cfg.cols || cy + 1 >= cfg.rows) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    const cells2x2 = [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]];
    for (const [wx, wy] of cells2x2) {
      const wi = wy * cfg.cols + wx;
      if (turretAt(wx, wy) || (S.cells[wi] !== EMPTY && S.cells[wi] !== BLUE)) {
        S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
        return;
      }
    }
    if (SURVIVAL) {
      if (!nearBase(cx, cy)) {
        S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
        return;
      }
    } else if (S.fog[cy * cfg.cols + cx] !== 0) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    for (const [wx, wy] of cells2x2) {
      const wi = wy * cfg.cols + wx;
      S.cells[wi] = GREY;
      S.hp[wi] = WALL_HP; S.maxhp[wi] = WALL_HP; S.shade[wi] = WALL_SHADE;
      S.growN[wi] = 0; S.growBy[wi] = 0; S.harvT[wi] = 0; S.goldNug[wi] = 0; S.popT[wi] = -1;
    }
    spawnBurst(cx + 1, cy + 1, '#9ca3af'); // center of the 2x2 block
    // No turret, no weapon entry — walls are terrain. (So the shop card
    // keeps showing New! + the description every time, which is fine:
    // each wall IS new.)
    S.placing = null;
    placebanner.classList.add('hidden');
    if (!S.runOver) {
      if (S.pending > 0) {
        offerCards(); offerShopCards();
        overlay.classList.remove('hidden');
      } else {
        S.paused = false;
      }
    }
    return;
  }
  if (turretAt(cx, cy)) {
    // Occupied: red ring says no, placement mode stays on.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  const pi = cy * cfg.cols + cx;
  if (SURVIVAL) {
    if (type === 'lantern') {
      // Lantern exception: near base it sits on any ground (as before);
      // far from base it can still go anywhere that's open ground and
      // clear of fog. That's how you extend past the build discs: drop
      // a lantern at the edge of the revealed area, and it becomes a
      // new anchor for the next units.
      if (!nearBase(cx, cy) && !(S.cells[pi] === EMPTY && S.fog[pi] === 0)) {
        S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
        return;
      }
    } else if (!nearBase(cx, cy)) {
      // Survival: place near your base (within PLACE_RADIUS of a living
      // player unit) — not just anywhere lit.
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
  } else if (S.fog[pi] !== 0) {
    // Units can only be placed in fully-revealed cells.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  if (type === 'lantern') {
    // Lanterns sit on any visible ground near base (main: any ground;
    // survival far lanterns already checked EMPTY + clear above).
    // No pad clearing.
  } else {
    // Combat units and Blooms need open ground.
    if (S.cells[pi] !== EMPTY) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    S.cells[pi] = EMPTY; // clear a pad
  }
  S.turrets.push(mkTurret(cx, cy, BLUE, type));
  if (!S.weapons[type]) {
    S.weapons[type] = { stats: initWeaponStats(type), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false };
  }
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[BLUE]);
  if (type === 'lantern') computeFog(); // the lantern pushes back the dark
  S.placing = null;
  placebanner.classList.add('hidden');
  if (!S.runOver) {
    if (S.pending > 0) {
      offerCards(); offerShopCards(); // more picks: fresh XP + shop rows, stays paused
      overlay.classList.remove('hidden');
    } else {
      S.paused = false;
    }
  }
}

// ---- Update ----
// Per-type weapon stats, per side: blue reads S.weapons, red reads
// S.redWeapons (same system, separate tracks — red starts ahead on bloom).
function weaponRateMult(t) {
  if (t.color === BLUE) return S.weapons[t.type] ? S.weapons[t.type].rateMult : 1;
  return S.redWeapons[t.type] ? S.redWeapons[t.type].rateMult : 1;
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
    S.levelUpNeed = xpNeed(); // freeze the threshold just met — the bar
    // must read full (3/3) while cards show, not 3/4 against the new level
    S.level++;
    // XP stays full while the cards show (so you see what caused the
    // level-up); it resets to zero only when you pick a card.
    S.pending++;
    S.paused = true;
    offerCards(); offerShopCards();
    overlay.classList.remove('hidden');
    updateHud();
  }
  // Enemy pressure: survival runs the flood clock; main runs the red
  // bank (red Bloom buys moles from its harvest gold, up to RED_MOLE_MAX
  // alive. No timer — the economy is the limiter, so starving red's
  // fields starves its army).
  if (SURVIVAL) {
    floodTick(dt);
  } else if (!S.runOver) {
    const redMoles = S.turrets.filter(t => !t.dead && t.color === RED && t.type === 'mole').length;
    if (redMoles < RED_MOLE_MAX) {
      const cost = redMoleCost();
      if ((S.redGold || 0) >= cost && spawnRedMole()) S.redGold -= cost;
    }
  }
  for (const t of S.turrets) {
    if (t.dead) continue;
    // Smooth-movement clock (mole + harvester): render glides from rx/ry.
    if (t.rx !== undefined) t.moveT += dt;
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
      // EVO Sprayer: same sweep, but ~12x faster — a continuous spray.
      const w = t.color === BLUE ? S.weapons.cannon : null;
      const evoBoost = w && w.evo ? 0.08 : 1;
      // Staggered burst: multishot fires one round, pauses a split second,
      // fires the next — the sweep spreads them, not a simultaneous fan.
      if (t.burstLeft > 0) {
        t.burstT -= dt;
        if (t.burstT <= 0) {
          fireTurret(t);
          t.burstLeft--;
          t.burstT = BURST_GAP;
        }
      } else if (t.cd <= 0) {
        t.cd = (1 / rateMult) * evoBoost * (0.8 + Math.random() * 0.4);
        t.burstLeft = 1 + (w && w.proj ? w.proj : 0);
        t.burstT = 0; // first round fires immediately
      }
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
    } else if (t.type === 'mole') {
      // Digger: chews through rock in its direction, turns, dies after
      // its lifetime (cells dug). Red turns toward the nearest blue turret
      // (encroachment) and opens ground toward blue. Blue prefers the nearest
      // gold nugget (70%) with random wander mixed in (30%) — purposeful
      // but not a beeline, and it stops looping in circles. Grey and
      // territory block both (they turn).
      const turn = () => {
        if (t.color === RED) {
          t.moleDir = moleDirToward(t.x, t.y);
        } else {
          const nd = moleDirToNugget(t.x, t.y);
          t.moleDir = (nd !== null && Math.random() < MOLE_NUGGET_BIAS) ? nd : Math.floor(Math.random() * 4);
        }
      };
      t.digT += dt;
      if (t.digT >= TURRET.mole.interval) {
        t.digT = 0;
        const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const [dx, dy] = dirs[t.moleDir];
        const nx = t.x + dx, ny = t.y + dy;
        if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) {
          turn(); // edge: turn
        } else {
          const ni = ny * cfg.cols + nx;
          if (S.cells[ni] === WHITE) {
            // Dig: damage the rock. If it breaks, move in.
            // Red gets no blue weapon bonus.
            const w = S.weapons.mole;
            const dmg = TURRET.mole.dmg + (t.color === BLUE && w ? w.dmgBonus : 0);
            const broken = damageBlock(ni, dmg, t.color, t.x + 0.5, t.y + 0.5, 0, 0, false);
            if (broken) {
              // Dug rock becomes open cave (EMPTY) for both colors.
              // Only the Bloom makes territory — red moles open ground
              // toward blue, they don't paint it red.
              // Glide: render starts from the old cell (no jump).
              t.rx = t.x; t.ry = t.y; t.moveT = 0;
              t.x = nx; t.y = ny;
              t.dug++;
              if (t.dug >= t.lifetime) { t.dead = true; continue; }
              if (t.dug % MOLE_TURN_EVERY === 0) turn();
            }
          } else if (S.cells[ni] === EMPTY || S.cells[ni] === t.color) {
            // Open ground (a cave, or own team's territory): walk straight
            // through instead of spinning. This un-sticks red moles, which
            // spawn inside their bloom's red territory and would otherwise
            // turn forever against a cell they can never dig. Walking costs
            // no dig and no lifetime (only dug cells count).
            t.rx = t.x; t.ry = t.y; t.moveT = 0;
            t.x = nx; t.y = ny;
          } else {
            // Not rock, not walkable (grey, enemy ground): turn.
            turn();
          }
        }
      }
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
          if (S.cells[ni] === WHITE || S.cells[ni] === GREY) damageBlock(ni, 2, m.color, m.x, m.y, m.vx, m.vy);
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

  // Harvest: each territory cell (blue or red) lightens over
  // HARVEST_EVERY seconds, then has a BLOOM_HARVEST_CHANCE to produce —
  // a map pickup for blue (80% XP, 20% gold), banked gold for red (it
  // has no collector, so the product goes straight to its bank).
  // Otherwise the glow just resets: a surprise, not a salary.
  for (let i = 0; i < S.cells.length; i++) {
    if (S.cells[i] !== BLUE && S.cells[i] !== RED) continue;
    if (S.cells[i] === RED && SURVIVAL) continue; // Flood: no harvest, no HP — just a uniform color to paint (harvT stays 0).
    S.harvT[i] += dt;
    if (S.harvT[i] >= HARVEST_EVERY) {
      S.harvT[i] = 0;
      const cx = i % cfg.cols, cy = (i / cfg.cols) | 0;
      if (S.cells[i] === BLUE && (coinAt(cx, cy) || S.coins.length >= 800)) continue;
      if (Math.random() >= BLOOM_HARVEST_CHANCE) continue; // no product this cycle
      if (S.cells[i] === BLUE) {
        const kind = Math.random() < 0.2 ? 'gold' : 'xp';
        S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind,
                       phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
      } else if (!SURVIVAL) {
        S.redGold = (S.redGold || 0) + 1;
      }
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

  // Harvester units: each living blue Harvester roams the grid toward the
  // closest idle pickup it can reach anywhere (BFS, avoids walls). It
  // steps one cell per HARVESTER_STEP_DUR — slow, always moving, never
  // waiting-then-zipping — and collects on arrival (same cell only,
  // up to Count per stop).
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE || t.type !== 'gather') continue;
    t.stepT = (t.stepT || 0) + dt;
    if (t.stepT < HARVESTER_STEP_DUR) continue;
    t.stepT = 0;
    // Collect anything already on our cell, then step toward the next pickup.
    collectAtGather(t);
    const step = harvesterStep(t);
    if (!step) continue; // no reachable pickup anywhere: wait here (rare — usually there's always one to chase)
    t.rx = t.x; t.ry = t.y; t.moveT = 0;
    t.x = step.nx; t.y = step.ny;
    collectAtGather(t);
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
function drawRockCell(x, y) {
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
  ctx.fillStyle = '#000'; // void beyond the map matches the fog (no seam)
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
        if (SURVIVAL) {
          // Painterly field: uniform player color in the cell's
          // elevation shade (same S.shade it had as grass). No
          // production glow: with dozens of field cells, per-cell
          // production timers are just a flashing checkerboard.
          const sh = PLAYER_SHADES[S.shade[i] || 0];
          ctx.fillStyle = `rgb(${sh[0]},${sh[1]},${sh[2]})`;
        } else {
          // Main (frozen): harvest glow lightens toward white as the next pickup approaches.
          const k = Math.min(1, S.harvT[i] / HARVEST_EVERY) * 0.45;
          const r = Math.round(BLUE_RGB[0] + (255 - BLUE_RGB[0]) * k);
          const g = Math.round(BLUE_RGB[1] + (255 - BLUE_RGB[1]) * k);
          const b = Math.round(BLUE_RGB[2] + (255 - BLUE_RGB[2]) * k);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
      else if (st === RED) {
        if (SURVIVAL) {
          // Painterly flood: uniform flood color in the cell's
          // elevation shade. No HP gradient: flood has no HP anymore,
          // it's just flippable color (paint it, don't chip it).
          const sh = FLOOD_SHADES[S.shade[i] || 0];
          ctx.fillStyle = `rgb(${sh[0]},${sh[1]},${sh[2]})`;
        } else {
          // Main (frozen): same glow for red (its fields feed the enemy bank, same rules).
          const k = Math.min(1, S.harvT[i] / HARVEST_EVERY) * 0.45;
          const r = Math.round(RED_RGB[0] + (255 - RED_RGB[0]) * k);
          const g = Math.round(RED_RGB[1] + (255 - RED_RGB[1]) * k);
          const b = Math.round(RED_RGB[2] + (255 - RED_RGB[2]) * k);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
      else if (st === EMPTY) {
        const sh = CAVE_SHADES[S.shade[i] || 0];
        ctx.fillStyle = `rgb(${sh[0]},${sh[1]},${sh[2]})`;
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
      else if (S.popT[i] < 0) drawRockCell(x, y); // popped cells draw in the pass below
    }
  }
  // Popped (enlarged) cells render last, in front of surrounding squares.
  // Two passes: the faint neighbor ripple first, then the hard-hit cell itself,
  // so the damaged cell always lands on top of its own shockwave.
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((S.cells[i] !== WHITE && S.cells[i] !== GREY) || S.popT[i] < 0) continue;
        if (pass === 0 ? S.popAmp[i] >= 1 : S.popAmp[i] < 1) continue;
        drawRockCell(x, y);
      }
    }
  }
  // Territory growth: each increment fills one quarter of the cell with
  // a mini-square (top-left, top-right, bottom-left, bottom-right, in
  // that order); the newest quarter pops in with an overshoot. At
  // GROW_STEPS the cell blooms into solid territory (handled in bloomGrowth).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const n = S.growN[i];
      if (n <= 0 || S.cells[i] !== EMPTY) continue;
      ctx.fillStyle = CELL_COLORS[S.growBy[i]];
      for (let k = 0; k < n; k++) {
        const [qx, qy] = GROW_QUARTERS[k];
        let s = 1;
        if (k === n - 1) s = Math.max(0.01, easeOutBack(Math.min(1, (S.time - S.growT[i]) / 0.2)));
        // Scale the newest quarter around its own center so it pops in.
        const cx = (x + qx + 0.25) * CELL_PX, cy = (y + qy + 0.25) * CELL_PX;
        const half = 0.25 * s * CELL_PX;
        ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
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
    // Smooth movement: moles + harvesters glide from the previous cell
    // instead of jumping (logical position steps, render interpolates).
    // Harvesters glide slower (their step duration) so they read as slow,
    // not zippy; moles keep the quick glide.
    let dx = t.x, dy = t.y;
    const dur = t.type === 'gather' ? HARVESTER_STEP_DUR : MOVE_DUR;
    if (t.rx !== undefined && t.moveT < dur) {
      const k = t.moveT / dur;
      dx = t.rx + (t.x - t.rx) * k;
      dy = t.ry + (t.y - t.ry) * k;
    }
    const px = (dx + 0.5) * CELL_PX, py = (dy + 0.5) * CELL_PX;
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
    } else if (t.type === 'mole') { // a mole: brown body (blue) or red body (red), snout, eyes
      ctx.fillStyle = t.color === RED ? '#b91c1c' : '#8b5a2b';
      ctx.beginPath(); ctx.ellipse(0, 2, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = t.color === RED ? '#ef4444' : '#d4a574';
      ctx.beginPath(); ctx.arc(0, -2, 3, 0, Math.PI * 2); ctx.fill(); // snout
      ctx.fillStyle = '#1a2138';
      ctx.beginPath(); ctx.arc(-3, 0, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, 0, 1.2, 0, Math.PI * 2); ctx.fill();
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
    // HP bar above damaged turrets
    if (t.hp < t.maxhp) {
      const w = 24, k = Math.max(0, t.hp / t.maxhp);
      ctx.fillStyle = 'rgba(11,14,22,0.8)';
      ctx.fillRect(px - w / 2, py - 18, w, 5);
      ctx.fillStyle = k > 0.5 ? '#4ade80' : k > 0.25 ? '#f5b301' : '#ef4444';
      ctx.fillRect(px - w / 2, py - 18, w * k, 5);
    }
  }
  // Build range (survival, proximity-gated units): while placing, show
  // the discs around your base units that a new unit must land inside.
  // A tap outside every disc is why the red ring rejects it. Lantern
  // gets no discs — it can also go outside them on clear open ground
  // (see the lantern exception in placeTurretAt). Main has no
  // proximity rule (fog shows where you can place), so no discs there.
  if (SURVIVAL && S.placing && S.placing.type !== 'lantern') {
    ctx.save();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.07)';
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.45)';
    ctx.lineWidth = 2;
    for (const t of S.turrets) {
      if (t.dead || t.color !== BLUE) continue;
      ctx.beginPath();
      ctx.arc((t.x + 0.5) * CELL_PX, (t.y + 0.5) * CELL_PX, PLACE_RADIUS * CELL_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
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
  // Fog of war over everything: full = black, half = 50% black (smooth edge).
  // Skipped entirely when fog is hidden (double-tap the minimap) — the
  // debug x-ray view.
  if (!fogHidden) for (let y = 0; y < cfg.rows; y++) {
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
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(13, iy + 5); ctx.lineTo(17, iy - 5);
    ctx.lineTo(21, iy + 5); ctx.lineTo(25, iy - 5);
    ctx.stroke();
    // level pips
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(34 + i * 7.5, iy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i < lvl ? '#ffd75e' : '#2a3145';
      ctx.fill();
    }
    ppy += bh + 6;
  }
  // Stat chips, top-left: one row per owned weapon stat. Each row: weapon
  // icon + 4-letter stat label + chips (gold filled / dark empty). This
  // is the progress bar you watch climb — one chip per stat pick.
  // A stat with no picks yet (level 0) hides its row entirely — the
  // corner only shows stats you've actually invested in, and a stat
  // card shows New! on its first pick (see offerCards).
  const STAT_LABEL = { dmg: 'DAMG', proj: 'PROJ', rate: 'RATE', crit: 'CRIT', pen: 'PENE', growth: 'GROW', count: 'CNTS', dig: 'DIGS' };
  for (const type of ['cannon', 'bloom', 'gather', 'mole']) {
    const w = S.weapons[type];
    if (!w || !w.stats) continue;
    for (const d of (STAT_DEFS[type] || [])) {
      const lvl = w.stats[d.key] || 0;
      if (lvl === 0) continue; // not upgraded yet: no row (and no gap — ppy doesn't advance)
      const bw = 122, bh = 18;
      ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
      rr(8, ppy, bw, bh, 6); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = '#2a3145';
      rr(8, ppy, bw, bh, 6); ctx.stroke();
      const iy = ppy + bh / 2;
      const col = CELL_COLORS[BLUE];
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      if (type === 'cannon') {
        ctx.beginPath(); ctx.moveTo(26, iy - 6); ctx.lineTo(14, iy + 5); ctx.lineTo(26, iy + 5); ctx.closePath(); ctx.fill();
      } else if (type === 'bloom') {
        ctx.beginPath(); ctx.arc(20, iy, 5.5, 0, Math.PI * 2); ctx.fill();
      } else if (type === 'gather') {
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(20, iy, 5, Math.PI * 0.15, Math.PI * 0.85, true); ctx.stroke();
        ctx.beginPath(); ctx.arc(15.5, iy + 3.5, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(24.5, iy + 3.5, 1.8, 0, Math.PI * 2); ctx.fill();
      } else if (type === 'mole') {
        ctx.fillStyle = '#8b5a2b';
        ctx.beginPath(); ctx.ellipse(20, iy + 1, 5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d4a574';
        ctx.beginPath(); ctx.arc(20, iy - 1.5, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#dfe5f2';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(STAT_LABEL[d.key] || d.key.toUpperCase(), 30, iy + 1);
      for (let i = 0; i < d.cap; i++) {
        ctx.beginPath();
        ctx.arc(60 + i * 7.5, iy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = i < lvl ? '#ffd75e' : '#2a3145';
        ctx.fill();
      }
      ppy += bh + 4;
    }
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
  // While cards show, the bar measures against the frozen threshold that
  // was just met (so it reads full), not the new level's higher need.
  const need = S.levelUpNeed || xpNeed();
  const pct = Math.min(1, Math.max(0, S.xpShown / need));
  // Run timer (play time, pauses excluded) after the level + XP counts.
  const tsec = Math.floor(S.time || 0);
  const timer = `${Math.floor(tsec / 60)}:${String(tsec % 60).padStart(2, '0')}`;
  const label = `LV ${lvl} &nbsp;·&nbsp; ${Math.floor(S.xpShown)}/${need} XP &nbsp;·&nbsp; ${timer}`;
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
    `<div>Fire rate: <b>${effFreq}/s</b> (×${S.freqMult.toFixed(2)}) · Damage: <b>+${S.dmgBonus}</b> · Steering: <b>×${S.steerMult.toFixed(2)}</b> · Field: <b>×${S.bloomMult.toFixed(2)}</b></div>` +
    `<div>Bounce: <b>Lv${S.passives.bounce}</b> (${Math.round(S.bounceChance * 100)}%) · Harvester: <b>${gatherCount()} per stop</b></div>` +
    `<div>Weapons: <b>${Object.entries(S.weapons).map(([k, w]) => `${k} ${w.stats ? Object.entries(w.stats).map(([s, n]) => `${s} ${n}`).join('/') : ''} (×${w.rateMult.toFixed(2)} rate, +${w.dmgBonus} dmg${w.critChance ? `, ${Math.round(w.critChance * 100)}% crit` : ''}${w.proj ? `, +${w.proj} proj` : ''})`).join(' · ')}</b></div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b> · Missiles: <b>${S.missiles.length}</b></div>` +
    `<div>Pickups: <b>${S.coins.length}</b> on field · Gold this run: <b>${S.gold}</b> · Total: <b>${meta.gold}</b> · Red bank: <b>${S.redGold || 0}</b> (next mole <b>${redMoleCost()}</b>)</div>`;
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
  if (S.frame % 6 === 0) drawMinimap(); // territory map, throttled
  if (S.frame % 30 === 0) checkWin(); // win check, throttled
  stepLvParticles(dt); // celebration rain while cards show (also when paused)
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
      else if (tryChipDoubleTap(downPos.x, downPos.y)) { /* debug level grant */ }
      else tapCoin(downPos.x, downPos.y); // tap a coin to collect it; anything else does nothing
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

// ---- Collapsible debug panel (starts hidden; <> toggles it) ----
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug');
if (debugToggle && debugPanel) {
  debugToggle.addEventListener('click', () => debugPanel.classList.toggle('collapsed'));
  debugPanel.classList.add('collapsed'); // start hidden by default on all screens (tap <> to open)
}

// ---- Fullscreen: hide the browser UI ----
const fsbtn = document.getElementById('fsbtn');
if (fsbtn) {
  fsbtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  });
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

// ---- Pre-game start screen: just the title + Start Run now. The shop is
// dormant (see renderShop below) until starter weapons return — the in-run
// gold economy carries progression for now. ----
const WEAPON_DESC = {
  cannon: 'Sweeping shots',
  mole: 'Digs tunnels through rock',
  bloom: 'Grows coin-generating territory',
  gather: 'Pulls in nearby pickups',
};
// Build number for the title-screen diagnostic: read from this script's
// own ?v= param (the cache-buster in index.html), so it can never drift
// from the build actually loaded. Falls back to 'dev' when there is no
// script tag (harness eval, local file without a query).
const BUILD = (() => {
  try {
    const s = document.currentScript;
    if (s && s.src) {
      const m = /[?&]v=([^&]+)/.exec(s.src);
      if (m) return m[1];
    }
  } catch (e) { /* ignore: no script URL available */ }
  return 'dev';
})();

function renderStartScreen() {
  // Title screen is just the title + Start Run, plus the build stamp
  // (diagnostic: confirms which build is actually loaded).
  const bv = document.getElementById('buildver');
  if (bv) bv.textContent = 'build v' + BUILD + (SURVIVAL ? ' · Survival prototype' : '');
  renderTeamToggle();
}
function renderTeamToggle() {
  // Start-screen team picker: highlights the current choice (PLAYER_RED
  // set by applyTeamColors). Buttons persist the pick + reapply colors
  // immediately, so the upcoming run uses the new hues (no reload).
  const r = document.getElementById('team-red'), b = document.getElementById('team-blue');
  if (r) r.classList.toggle('selected', PLAYER_RED === true);
  if (b) b.classList.toggle('selected', PLAYER_RED === false);
  if (r && !r.dataset.bound) {
    r.dataset.bound = '1';
    r.addEventListener('click', () => {
      try { localStorage.setItem('tis_team', 'red'); } catch (e) { /* ignore */ }
      applyTeamColors(); renderTeamToggle();
    });
  }
  if (b && !b.dataset.bound) {
    b.dataset.bound = '1';
    b.addEventListener('click', () => {
      try { localStorage.setItem('tis_team', 'blue'); } catch (e) { /* ignore */ }
      applyTeamColors(); renderTeamToggle();
    });
  }
}
// ---- Shop (DORMANT — not called). Restore when other starter weapons
// arrive: it renders the unlock grid into #weaponlist, spending meta gold.
// Kept intact so the meta unlock system (UNLOCK_COST, meta.unlocks, banking)
// can come back without a rewrite. ----
function renderShop() {
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
  for (const type of ['cannon', 'mole', 'bloom', 'gather']) {
    const unlocked = meta.unlocks[type];
    const cost = UNLOCK_COST[type] || 0;
    const div = document.createElement('div');
    div.className = 'weapon' + (unlocked ? '' : ' locked') + (type === 'cannon' ? ' selected' : '');
    const icon = document.createElement('div');
    icon.className = 'wicon';
    icon.innerHTML = ICONS[type] || '';
    div.appendChild(icon);
    const info = document.createElement('div');
    info.className = 'winfo';
    const name = document.createElement('div');
    name.className = 'wname';
    name.textContent = TURRET[type].name;
    const desc = document.createElement('div');
    desc.className = 'wdesc';
    desc.textContent = WEAPON_DESC[type];
    info.appendChild(name);
    info.appendChild(desc);
    div.appendChild(info);
    const btn = document.createElement('button');
    if (type === 'cannon') {
      btn.textContent = 'Starter';
      btn.disabled = true;
    } else if (unlocked) {
      btn.textContent = 'Owned';
      btn.disabled = true;
    } else {
      btn.className = 'unlock';
      btn.innerHTML = `${cost}<span class="coin"></span>`;
      btn.disabled = meta.gold < cost;
      btn.addEventListener('click', () => {
        if (meta.gold < cost || meta.unlocks[type]) return;
        meta.gold -= cost;
        meta.unlocks[type] = true;
        saveMeta();
        renderShop();
      });
    }
    div.appendChild(btn);
    list.appendChild(div);
  }
}
// Commander intro dialog (survival only, dummy): the storm warning
// at the start of a run, with the grace ETA filled in from the
// constant so the text can never go stale. Prepare starts the run —
// the game stays paused while reading, so grace runs from there.
function showCommander() {
  const ct = document.getElementById('commander-text');
  if (ct) ct.textContent = 'Commander, the storm is approaching. ETA ' + (FLOOD_GRACE_DUR / 60) + ' minutes till impact.';
  S.paused = true; // newGame unpaused; re-pause while reading
  commander.classList.remove('hidden');
}
document.getElementById('commander-btn').addEventListener('click', () => {
  commander.classList.add('hidden');
  S.paused = false;
});
document.getElementById('startbtn').addEventListener('click', () => {
  // Every run starts with Cannon; the shop only gates mid-run drafts.
  document.getElementById('startscreen').classList.add('hidden');
  newGame();
  if (SURVIVAL) showCommander();
});

applyUrlParams();
loadMeta();
applyTeamColors(); // before first run: stored preference, else branch look (survival red, main blue)
newGame();
S.paused = true; // behind the start screen until the player picks a starter
renderStartScreen();
document.getElementById('startscreen').classList.remove('hidden');
requestAnimationFrame(frame);
