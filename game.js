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
const PENETRATE_CHANCE = 0.5;       // per-cell chance a piercing shot keeps going (v106, start 50%).
// v193: projectiles are chance-based now (Sam: the guaranteed extra
// projectile per level was ridiculously overpowered — treat it like
// penetration, where the chance makes the surprise). Each level adds
// one more MAX projectile, but every extra projectile is a chance
// roll in a chain: roll for the 2nd; if it lands, roll for the 3rd;
// and so on. Each slot's chance starts at 25% when it unlocks and
// grows +25% per level after that, capping at 100% — so the chances
// are staggered: early slots become reliable while later ones are
// still a gamble. Base 1 projectile always fires, never rolls.
// Expected count: ~1.25 at Lv1, ~2.2 at Lv3, ~4.2 at Lv5 (was a
// guaranteed 2 / 4 / 6), with a max of 6 and a min of 1.
function projChanceAt(slot, lv) {
  // slot = the projectile number (2, 3, ...); it unlocks at level
  // slot-1, at 25%, then +25% per level (25/50/75/100%).
  return Math.min(1, 0.25 * (lv - slot + 2));
}
// v193: how many projectiles this volley fires — 1 plus a chain of
// chance rolls, one per extra slot the proj level unlocks.
function rollProjCount(lv) {
  let n = 1;
  for (let slot = 2; slot <= lv + 1; slot++) {
    if (Math.random() < projChanceAt(slot, lv)) n++;
    else break;
  }
  return n;
}
                                      // Each rock/flood cell beyond the first rolls to continue; max depth still caps at penDepth.
const STEER_RATE = 3;               // missile turn rate, rad/s (x S.steerMult)
const RED_DEPLOY_EVERY = 12;        // seconds between red turret deployments
const GROW_INTERVAL = 5;            // Bloom: seconds per growth increment (x S.bloomMult)
const GROW_STEPS = 4;              // increments to turn a cell into territory
const GROW_ANIM_DUR = 0.5;         // centre-square growth animation, seconds per increment (render only, pacing unchanged)
// Centre-square growth fraction: how much of the cell the growing
// square fills, interpolating smoothly from the previous step over
// GROW_ANIM_DUR after each increment (growT), then holding. Pure
// render math (no game state changed), so the pacing stays exactly
// the discrete growN steps — only the visual is smooth.
function growthSquareFrac(n, growT, time) {
  const t = Math.min(1, Math.max(0, (time - growT) / GROW_ANIM_DUR));
  const ease = 1 - (1 - t) * (1 - t); // easeOut: fast start, gentle settle, no overshoot
  return ((n - 1) + ease) / GROW_STEPS;
}
const BLOOM_RADIUS = 8;            // Bloom: how far (cells) it reaches for empty ground
const HARVEST_EVERY = 8;           // territory: seconds between pickups per cell

// Turret roster: distinct damage patterns, no homing except the missile's
// steering (which is deliberately dumb: limited turn rate, walls win).
const GATHER_COOLDOWN = 6;           // seconds between pulls (legacy interval field, unused by the moving harvester)
// Magnet (v181, Sam: global pull passive): every living BLUE unit pulls
// nearby idle pickups toward itself — nearest first, lerp to the unit,
// grant on arrival (same 'gather' coin state as the old Field/Outpost
// vacuums, still in the coin update). Level 0 = no pull: Field and
// Outpost no longer pull by default (Field is purely growth, Outpost
// purely base expansion + teleport anchor). Each Magnet pick improves
// all three: +1 radius, -0.5s interval, +1 count every 2 levels.
// Level 1: radius 3, every 4s, 1 per pull. Level 8 (max): radius 10,
// every 1s, 4 per pull. Tunable. Harvester speed unchanged — it just
// pulls while it drives now.
// v171 note: the pull range ring flash is gone — no circle indicator
// on any pull. The coins still fly in.
const MAGNET_RADIUS_BASE = 2;        // pull radius = base + level (3 at Lv1, 10 at Lv8)
const MAGNET_INTERVAL_BASE = 4.5;    // seconds between pulls at Lv0 (4 at Lv1, 1 at Lv7+, floored)
const MAGNET_INTERVAL_STEP = 0.5;    // seconds shaved per level
const MAGNET_INTERVAL_MIN = 1;       // fastest pull interval, in seconds
const MAGNET_COUNT_STEP = 2;         // +1 pickup per pull every 2 levels (1 at Lv1-2, 4 at Lv7-8)
function magnetLevel() { return (S.passives && S.passives.magnet) || 0; }
function magnetRadiusAt(lv) { return MAGNET_RADIUS_BASE + lv; }
function magnetIntervalAt(lv) { return Math.max(MAGNET_INTERVAL_MIN, MAGNET_INTERVAL_BASE - MAGNET_INTERVAL_STEP * lv); }
function magnetCountAt(lv) { return 1 + Math.floor((lv - 1) / MAGNET_COUNT_STEP); }
function magnetRadius() { return magnetRadiusAt(magnetLevel()); }
function magnetInterval() { return magnetIntervalAt(magnetLevel()); }
function magnetCount() { return magnetCountAt(magnetLevel()); }
// What the NEXT Magnet pick (level n+1) gives, in RELATIVE terms
// (v184, Sam: like the other stat cards — deltas, not absolutes).
// Radius always +1; the interval drop shows as a % faster pull
// rate (rounded); count +1 when the pick crosses an even level
// (count improves every 2 levels). At the interval floor (Lv7->8)
// the % part drops out — and the Lv7->8 pick is radius-only
// (count is already 4 at Lv7).
function magnetNextEffect(n) {
  const parts = ['+1 radius'];
  const iv0 = magnetIntervalAt(n), iv1 = magnetIntervalAt(n + 1);
  if (iv1 < iv0) parts.push(Math.round((iv0 / iv1 - 1) * 100) + '% faster pulls');
  if (magnetCountAt(n + 1) > magnetCountAt(n)) parts.push('+1 count');
  return parts.join(' · ');
}
// Magnet pull: pull up to `count` nearest idle pickups within `radius`
// cells toward the unit (state 'gather', lerp to the unit, grant on
// arrival). Fogged coins are not collectible (v166).
function pullCoinsTo(t, radius, count) {
  const r2 = radius * radius;
  const inRange = [];
  for (const c of S.coins) {
    if (c.state !== 'idle') continue;
    if (coinFogged(c)) continue;
    const dx = c.x - (t.x + 0.5), dy = c.y - (t.y + 0.5);
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) inRange.push({ c, d2 });
  }
  inRange.sort((a, b) => a.d2 - b.d2);
  const take = Math.min(count, inRange.length);
  for (let k = 0; k < take; k++) {
    const c = inRange[k].c;
    c.state = 'gather'; c.sx = c.x; c.sy = c.y; c.gx = t.x + 0.5; c.gy = t.y + 0.5; c.t = 0;
  }
}
// Cannon split stat tracks (v114): each weapon stat levels independently
// (chips top-left), one card per stat boost — no more bundled tracks.
// Caps are 5 for cannon (v114, down from 8 — a 30-minute round never
// reached 8, so 8 was a paper max, not a real one). Crit is NOT a
// separate track anymore (v114): nobody picked it, so it rides on
// Damage instead (+5% crit per Damage level, max 25% at Damage 5).
// Steps are uniform by design, so a card always tells you exactly
// what you get. Rate step is +25% (v114, up from +15%): +15% sat inside
// the ±20% fire jitter, so a Rate pick felt invisible; +25% restores
// the old 8-level final rate (1.25^5 ≈ 3.05x ≈ 1.15^8 ≈ 3.06x) in 5 picks.
const STAT_DEFS = {
  cannon: [
    { key: 'dmg', name: 'Damage', cap: 5, effect: '+1 damage, +5% crit' },
    // Projectiles: v193, chance-based like Penetration (Sam: the
    // guaranteed extra projectile per level was ridiculously
    // overpowered). Each level adds one more MAX projectile, but
    // every extra one is a chance roll in a chain (projChanceAt /
    // rollProjCount) — the nerf is the chance, not gold. shopOnly
    // stays set, but on survival shopOnly stats are free XP stat
    // cards (see the CARD_POOL filter); on main it still means the
    // shop-only gold card (v75, unchanged).
    { key: 'proj', name: 'Projectiles', cap: 5, effect: '+1 projectile (chance of firing)', shopOnly: true },
    { key: 'rate', name: 'Fire rate', cap: 5, effect: '+25% fire rate' },
    // Penetration: how many cells one shot pierces (VS pass-through).
    // Base depth 1 (just the first cell); each level adds one more
    // MAX cell in the same shot's path — rock it damages, or flood it
    // paints. Since v106 each cell beyond the first has only a 50%
    // chance to continue (PENETRATE_CHANCE), so average pierce is
    // ~2 cells even at high levels, but long rare pierces stay possible.
    // Cap 5 (v114, down from 8): max depth 6, average pierce ~1.97 vs
    // ~2.00 at depth 9, so the cap cut costs almost nothing in practice.
    // v133: gold-gated like Projectiles (shopOnly, XP hybrid, 10+5/lv)
    // — as a free starter pick it was too strong. v193: the gold is
    // gone (the nerf is the chance, not gold) — on survival it's a
    // free XP stat card now, like Projectiles; shopOnly still means
    // gold-gated on main only.
    { key: 'pen', name: 'Penetration', cap: 5, effect: '+1 pierce depth (chance of continuing)', shopOnly: true },
  ],
  bloom: [
    // v181: growth only — pull left the Field track for the global
    // Magnet passive, so Field is purely growth now. Cap 3, each pick
    // +20% growth, max 1.73x (same max as the old 12-level rotation,
    // whose growth picks landed at levels 1, 5, 9). Red Field level
    // (below) moves 9 -> 3 to keep its 1.73x head start.
    { key: 'field', name: 'Field', cap: 3, effect: '+20% growth speed' },
  ],
  gather: [
    { key: 'count', name: 'Count', cap: 8, effect: '+1 pickup per pull' },
  ],
  mole: [
    // v192: the Digger finally has an XP track (Sam: it was
    // overpowered at level 1 with no way to upgrade it). One track,
    // Dig, cap 8 — a mix of damage and lifetime (see moleDamageAt /
    // moleLifetimeMinAt / moleLifetimeMaxAt). The card sub shows the
    // next pick's delta (moleNextEffect), not this static effect.
    { key: 'dig', name: 'Dig', cap: 8, effect: '+2 lifetime' },
  ],
  wall: [
    // v194: one track now (Sam: the two Wall cards crowded the deal
    // — half of it on one unit). Reinforce, cap 5: +10 HP every
    // pick, +1 size at picks 1, 3 and 5 (see wallSizeAt) — so it
    // reaches the same maxima as the old two tracks (70 HP, 5x5)
    // in 5 picks instead of 8. The card sub shows the next pick's
    // delta (wallNextEffect), like Dig/Magnet.
    { key: 'reinforce', name: 'Reinforce', cap: 5, effect: '+10 wall HP' },
  ],
  laser: [
    // v186: the Laser is a shield now (Sam: repurpose it to shoot down
    // enemy projectiles). One track boosts BOTH: +25% fire rate and
    // +1 shield radius per pick, cap 5. Base radius 3 (Lv0), max 8.
    { key: 'shield', name: 'Shield', cap: 5, effect: '+25% fire rate, +1 shield radius' },
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
    if (st === 'dmg') { w.dmgBonus = n; w.critChance = 0.05 * n; } // v114: crit rides on Damage, no separate Crit track
    else if (st === 'proj') w.proj = n;
    else if (st === 'rate') w.rateMult = Math.pow(1.25, n); // v114: +25% per level (was +15%)
    else if (st === 'pen') w.penDepth = 1 + n; // max penetration depth: base 1 + 1 per level (rock hits + flood paints, each step 50% chance v106)
  } else if (weapon === 'bloom') {
    if (st === 'field') {
      // v181: growth only — pull left the Field track for the global
      // Magnet passive. Each pick is +20% growth; cap 3 = 1.73x max.
      const n = w.stats.field || 0;
      w.rateMult = Math.pow(1.2, n);
    }
  } else if (weapon === 'laser') {
    if (st === 'shield') {
      // v186: one track, two boosts — fire rate (+25%/pick, like the
      // cannon's rate track, so the laser's cooldown shrinks) and
      // shield radius (+1/pick, read live by laserShieldRadius).
      w.rateMult = Math.pow(1.25, n);
    }
  } else if (weapon === 'mole') {
    if (st === 'dig') {
      // v192: the Dig track sets the damage bonus (damage is
      // moleDamageAt(n), base 1 — the lifetime is read live at
      // spawn (moleLifetimeMinAt/MaxAt), so no spawn-time work here.
      // The old dig bundle (buying a Digger gave +1 dig) is gone:
      // Dig comes from the XP track only now.
      w.dmgBonus = moleDamageAt(n) - TURRET.mole.dmg;
    }
  }
  // gather count derives from stats (gatherCount).
}
// Per-stat Cannon EVOS (v114, replacing the old cannon-wide Evo).
// The old Evo required ALL cannon stats maxed (37 picks, never reached
// in a 30-minute round). Now each stat evolves on its own at cap 5:
// Rate 5 → Sprayer (w.evo, 12x fire speed, as before), Damage 5 →
// Painter (w.evoPaint, trail painting, see stepProjectile). Other
// tracks (Projectiles, Penetration) cap at 5 with no Evo yet.
function cannonRateMaxed() {
  const w = S.weapons.cannon;
  return !!w && !w.evo && (w.stats.rate || 0) >= 5;
}
function cannonDmgMaxed() {
  const w = S.weapons.cannon;
  return !!w && !w.evoPaint && (w.stats.dmg || 0) >= 5;
}
// Mid-run unit costs (run gold, not meta gold): base + 5 per living unit
// of that type. The starter Cannon is free (pre-placed); every duplicate
// costs extra, and the price climbs as your army grows. Tunable.
// Early game is cheap on purpose: Outpost 2 (base expansion), Field 3
// (early resources), Digger 4 (early exploration), Waypoint 5 (cannon
// aiming) — the flood starts at 3 min, so you need cheap options before
// you can level the cannon.
const UNIT_COST = { cannon: 10, mole: 4, bloom: 3, gather: 6, lantern: 2, wall: 2, laser: 5, waypoint: 5 };
const UNIT_COST_STEP = 5;
const LANTERN_COST_STEP = 1; // outposts stay cheap so chaining them to extend the base is affordable
function unitCost(type) {
  if (type === 'wall') return wallCost(); // v182: scales with Size (area)
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
  steer: '<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="20,12 12,8 12,16" fill="#ef4444"/><rect x="6" y="9.5" width="7" height="5" fill="#ef4444"/></svg>',
  mole: '<svg viewBox="0 0 24 24" width="36" height="36"><ellipse cx="12" cy="14" rx="7" ry="5" fill="#8b5a2b"/><circle cx="9" cy="12" r="1.2" fill="#1a2138"/><circle cx="15" cy="12" r="1.2" fill="#1a2138"/><polygon points="12,16 10,19 14,19" fill="#d4a574"/></svg>',
  gold: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 9 C8 9 5.5 12 5.5 15.5 C5.5 19 8.5 21.5 12 21.5 C15.5 21.5 18.5 19 18.5 15.5 C18.5 12 16 9 12 9 Z" fill="#f5b301" stroke="#b8860b" stroke-width="1.5"/><rect x="10.5" y="3.5" width="3" height="5.5" rx="1" fill="#b8860b"/></svg>',
  teleport: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M4 18 C4 8 20 8 20 18" fill="none" stroke="#ef4444" stroke-width="2.5"/><polygon points="20,18 16.5,15.5 17.5,19.5" fill="#ef4444"/><circle cx="4" cy="18" r="2.5" fill="#ef4444"/></svg>',
  waypoint: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="8" fill="none" stroke="#ef4444" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="#ef4444"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="#ef4444" stroke-width="2"/></svg>',
  // Evo icons (v115): same flat SVG style, player color via buildIcons.
  // Sprayer = spray fan (origin dot + 3 fanning lines); Painter =
  // paint splash (filled starburst blob + droplets). Used on the Evo
  // cards themselves (with the name) and on the Damage/Rate stat cards'
  // little Evo line (icon + EVO, no name — v115/v116: the name appears
  // only when you reach the Evo, not on the base stat card).
  evoSpray: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="6" cy="12" r="2.5" fill="#ef4444"/><path d="M9 10 L19 5 M9 12 L20 12 M9 14 L19 19" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>',
  evoPaint: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 3 L14 7 L19 6 L17 11 L21 13 L16 15 L18 20 L12 17 L6 20 L8 15 L3 13 L7 11 L5 6 L10 7 Z" fill="#ef4444"/><circle cx="20" cy="4" r="1.5" fill="#ef4444"/><circle cx="4" cy="19" r="1.2" fill="#ef4444"/></svg>',
  // Magnet (v181): horseshoe magnet — U body in team color, pale pole tips.
  magnet: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M6 3 h4 v8 a2 2 0 0 0 4 0 V3 h4 v8 a6 6 0 0 1 -12 0 Z" fill="#ef4444"/><rect x="6" y="3" width="4" height="3.5" fill="#f5f5f5"/><rect x="14" y="3" width="4" height="3.5" fill="#f5f5f5"/></svg>',
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
  laser:  { name: 'Laser',  hp: 5, interval: 2.0, dmg: 2 }, // v186: dmg is main-only now (survival Laser is a shield, it deals no damage)
  bloom:  { name: 'Field',  hp: 4, interval: GROW_INTERVAL, dmg: 0 },
  lantern:{ name: 'Outpost',hp: 4, interval: 0, dmg: 0 }, // fog light + base anchor, no firing (display rename v107, internal type still 'lantern', like Field/Digger/Harvester; v181: vacuum moved to the Magnet passive)
  gather: { name: 'Harvester', hp: 5, interval: GATHER_COOLDOWN, dmg: 0 }, // roams for pickups, anywhere, slowly
  mole:   { name: 'Digger', hp: 6, interval: 1.0, dmg: 1 }, // digs through rock, then dies
  wall:   { name: 'Wall',   hp: 20, interval: 0, dmg: 0 }, // terrain, not a turret (see placeTurretAt wall branch)
};
const LASER_SHIELD_RADIUS_BASE = 3; // v186: shield radius in cells at Shield 0
// v195: is there a live RED projectile inside this Laser's shield
// radius? (The reactive trigger — the laser only fires when there's
// something to shoot down, so it never wastes a shot on empty air.)
function laserHasTarget(t) {
  const r = laserShieldRadius();
  const cx = t.x + 0.5, cy = t.y + 0.5;
  for (const p of S.projs) {
    if (p.dead || p.color !== RED) continue;
    const dx = p.x - cx, dy = p.y - cy;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}
// v186: shield radius = base + Shield level (3 at Lv0, 8 at Lv5).
function laserShieldRadius() {
  const w = S.weapons.laser;
  return LASER_SHIELD_RADIUS_BASE + ((w && w.stats && w.stats.shield) || 0);
}
const MOLE_LIFETIME_MIN = 20;      // cells dug before dying (min, doubled: diggers were dying too soon to be useful)
const MOLE_LIFETIME_MAX = 40;      // ... (max)
const MOLE_LIFETIME_MIN_L1 = 12;   // v192: BLUE digger lifetime at Dig 0 (was 20 — too long for a level-1 unit)
const MOLE_LIFETIME_MAX_L1 = 24;   // v192: BLUE digger lifetime at Dig 0 (was 40)
// v192: Digger upgrade track (Sam: 8 levels, a mix of damage and
// lifetime — I chose the mix). Damage: +1 at Dig 3 and Dig 6
// (1 -> 3 at max). Lifetime: +2 to both ends of the range per pick
// (12-24 -> 28-40 at max). So most picks are lifetime, with a
// damage bump every third pick. RED moles don't level — they keep
// the old 20-40.
function moleDamageAt(lv) { return 1 + Math.floor(lv / 3); }
function moleLifetimeMinAt(lv) { return MOLE_LIFETIME_MIN_L1 + 2 * lv; }
function moleLifetimeMaxAt(lv) { return MOLE_LIFETIME_MAX_L1 + 2 * lv; }
// v192: what the NEXT Dig pick does, for the card sub (like
// magnetNextEffect) — damage only on picks 3 and 6, lifetime every pick.
function moleNextEffect(n) {
  const parts = [];
  if (moleDamageAt(n + 1) > moleDamageAt(n)) parts.push('+1 damage');
  parts.push('+2 lifetime');
  return parts.join(' · ');
}
const MOLE_TURN_EVERY = 3;         // cells before random turn
const COIN_FLY_DUR = 0.45;           // seconds for a tapped coin to zip to the corner
const RING_DUR = 0.3;                // conversion shockwave ring lifetime (s)
const CHIP_CX = 41, CHIP_CY = 48;    // coin-counter chip center, in screen (CSS) px
const CIV_CHIP_CX = CHIP_CX + 84, CIV_CHIP_CY = CHIP_CY; // v165: civilians counter chip, right next to the gold chip
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
const lvviewmap = document.getElementById('lvviewmap');
// v149 View map / View upgrades: toggle between the cards and the
// map underneath, without leaving the level-up screen. The overlay
// itself stays visible (so stepLvParticles keeps raining), only the
// .cards hide, and in map view the overlay is transparent and
// click-through so the map can be panned/zoomed. Taps on the map
// while viewing it do nothing (see endPointer), so assessing can't
// accidentally collect a coin or delete a waypoint. Every new deal
// resets to cards view (see offerCards).
if (lvviewmap) lvviewmap.addEventListener('click', () => {
  // Don't rely on toggle()'s return value (the harness stub's
  // toggle returns undefined); read the class back instead.
  overlay.classList.toggle('mapview');
  const viewingMap = overlay.classList.contains('mapview');
  lvviewmap.textContent = viewingMap ? 'View upgrades' : 'View map';
});
const lvfx = document.getElementById('lvfx');
const lvctx = lvfx ? lvfx.getContext('2d') : null;
// Rescue discovery celebration (v177): dark overlay + pink confetti.
const rescueOverlay = document.getElementById('rescueceleb');
const rescueFx = document.getElementById('rescuefx');
const rescueCtx = rescueFx ? rescueFx.getContext('2d') : null;
const rescueTitle = document.getElementById('rescuetitle');
// Tap anywhere on the celebration overlay to continue (closes it).
if (rescueOverlay) rescueOverlay.addEventListener('click', closeRescueCelebration);
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
        const ci = y * cols + x;
        mmctx.fillStyle = S.cells[ci] === GREY ? '#6b7280' :
          (S.ocean && S.ocean[ci] && S.cells[ci] === EMPTY ? OCEAN_MINIMAP :
          (S.beach && S.beach[ci] && S.cells[ci] === EMPTY ? BEACH_MINIMAP :
          (S.grass && S.grass[ci] && S.cells[ci] === EMPTY ? GRASS_MINIMAP : '#9ca3af')));
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
  // Rescue (survival only): moving + settled civilians show as pink
  // pixels (so you can track the walk home and the crowd around a
  // base); undiscovered sites show a pink ? at the site anchor,
  // shining through fog — the ? disappears once the site clears (you
  // can see the blobs on the main map then). Civilians are never
  // removed now (v113: they congregate, not vanish), so the ? is
  // purely fog-gated.
  if (SURVIVAL && S.rescue) {
    for (const c of (S.rescue.civilians || [])) {
      if (c.state !== 'moving' && c.state !== 'settled') continue;
      mmctx.fillStyle = CIV_PINK;
      mmctx.fillRect(c.x * px, c.y * px, px, px);
    }
    for (let si = 0; si < (S.rescue.sites || []).length; si++) {
      if (!rescueSiteUndiscovered(si)) continue; // discovered: no ? needed
      const site = S.rescue.sites[si];
      mmctx.fillStyle = CIV_PINK;
      mmctx.font = 'bold 10px sans-serif';
      mmctx.textAlign = 'center';
      mmctx.textBaseline = 'middle';
      mmctx.fillText('?', site.x * px + 1, site.y * px + 1);
    }
  }
  // Meteor warning (v116): yellow circles on the minimap for every
  // target that has not impacted yet — all of them during the 10s
  // warning, then the remaining ones as the shower progresses (each
  // circle disappears as its meteor lands). Shines through fog, like
  // the rescue ?, so fogged targets still warn. Stroke only, so the
  // underlying terrain cell stays readable.
  if (SURVIVAL && S.meteor && (S.meteor.phase === 'warn' || S.meteor.phase === 'shower')) {
    const a = 0.55 + 0.25 * Math.sin(S.time * Math.PI * 2 / 2.2);
    mmctx.strokeStyle = `rgba(255, 215, 94, ${a})`;
    mmctx.lineWidth = 1.5;
    for (const t of S.meteor.targets) {
      if (t.state === 'done') continue;
      mmctx.beginPath();
      mmctx.arc(t.x * px + 1, t.y * px + 1, 4, 0, Math.PI * 2);
      mmctx.stroke();
    }
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
// Celebration particles: spawn from the top strip and rain down with
// gravity, fading out. Shared by the level-up screen (blue rain) and
// the rescue discovery celebration (civilian pink rain, v177).
const lvParticles = [];
const rescueParticles = [];
function stepFxParticles(list, fctx, fcanvas, visible, colors, dt) {
  if (!fctx || !visible) { list.length = 0; return; }
  const w = fcanvas.width = (typeof innerWidth !== 'undefined' ? innerWidth : 800),
        h = fcanvas.height = (typeof innerHeight !== 'undefined' ? innerHeight : 600);
  // Spawn: ~90/s from the XP bar strip at the top.
  const spawn = Math.round(90 * dt);
  for (let k = 0; k < spawn; k++) {
    list.push({
      x: Math.random() * w, y: 30 + Math.random() * 8,
      vx: (Math.random() - 0.5) * 40, vy: 30 + Math.random() * 60,
      r: 1.5 + Math.random() * 2.5, life: 0, max: 1.2 + Math.random() * 0.8,
      col: colors[Math.floor(Math.random() * colors.length)],
    });
  }
  fctx.clearRect(0, 0, w, h);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life += dt;
    if (p.life >= p.max || p.y > h) { list.splice(i, 1); continue; }
    p.vy += 120 * dt; // gravity
    p.x += p.vx * dt; p.y += p.vy * dt;
    const a = 1 - p.life / p.max;
    fctx.globalAlpha = a;
    fctx.fillStyle = p.col;
    fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); fctx.fill();
  }
  fctx.globalAlpha = 1;
}
function stepLvParticles(dt) {
  stepFxParticles(lvParticles, lvctx, lvfx, !overlay.classList.contains('hidden'),
                  ['#5aa2ff', '#7dd3fc', '#2f6fe4', '#a5d8ff'], dt);
}
function stepRescueParticles(dt) {
  stepFxParticles(rescueParticles, rescueCtx, rescueFx,
                  !!(rescueOverlay && !rescueOverlay.classList.contains('hidden')),
                  ['#f472b6', '#ec4899', '#f9a8d4', '#be185d'], dt);
}
const placebanner = document.getElementById('placebanner');
const placeswap = document.getElementById('placeswap');
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
  // v168: the outermost zoom is set by WIDTH only — the board
  // exactly fills the screen width, no further out. The old rule
  // (the whole map fits, min of width/height) let a portrait phone
  // zoom out until the whole tall map fit vertically, leaving the
  // board a narrow strip with black bars on the sides and far too
  // much map on screen at once — you lose control of it. Now the
  // board is always full-width and solid; you pan north/south to
  // see the rest of the climb.
  if (!view.w || !view.h || !cfg.cols) return 1;
  return view.w / (cfg.cols * CELL_PX);
}
function resetCamera(zoomMult = 1, cx = null, cy = null) {
  // Default (no args): fully zoomed out, board fills the width,
  // centered — the finish-reveal and the harness camera tests use this.
  // New games (v119) pass zoomMult = START_ZOOM_MULT with the starter's
  // world center, so the run starts zoomed in on the starting unit
  // instead of the full-map overview. clampCamera pins the center to
  // the map edge (v122: slack reverted to 0 — the starter now sits
  // inland on sand, behind the ocean ring, so it centres without slack).
  cam.zoom = minZoom() * zoomMult;
  cam.x = cx !== null ? cx : (cfg.cols * CELL_PX) / 2;
  cam.y = cy !== null ? cy : (cfg.rows * CELL_PX) / 2;
  clampCamera();
}
const START_ZOOM_MULT = 3; // v119: start zoom = 3x the full-map zoom (tunable; max is 8x)
// v154 place bar + unlock cards (Sam, 2026-11-05): shop removed from the
// level-up screen; placements live in an always-visible bottom bar,
// gold-gated, tap icon then tap map. Units start unlocked or are
// unlocked by an XP-row card (VS-style), then bought with gold.
// v156 (Sam, 2026-11-05): the start-unlocked special rule is removed —
// you only start with the Cannon. Outpost and Wall are unlock cards
// too, like Field, Digger, Harvester, Laser, Waypoint. Start-screen
// toggles still filter the run: a toggled-off type never unlocks.
const START_UNLOCKED = ['cannon'];
const UNLOCKABLE = ['lantern', 'wall', 'bloom', 'mole', 'gather', 'laser', 'waypoint'];
const PLACEBAR_TYPES = ['cannon', 'lantern', 'wall', 'bloom', 'mole', 'gather', 'laser', 'waypoint'];
// v153 auto-cam try-it (Sam, 2026-11-04): a toggleable, slow, north-only
// follow camera. It never moves south, never changes zoom, never kills
// anything — it just drifts north, at 1 cell/s, when even your
// southernmost fixed unit has moved north. Manual pan, placing, and
// teleporting all pause it for that frame; tapping CAM turns it off
// again. Default off each first load, preserved across runs in a
// session (see newGame). This is stage 1 only: no hard edge, no
// abandonment, no zoom-out — just feel whether a slowly advancing
// camera creates pressure without fighting the player.
const AUTO_CAM_SPEED = CELL_PX * 1; // 1 cell/s, deliberately very slow
const AUTO_CAM_MARGIN_CELLS = 3; // southernmost fixed unit sits this far above the bottom edge
function updateAutoCam(dt) {
  if (!S || !S.autoCam) return;
  if (S.placing || S.teleporting) return;
  if (typeof panning !== 'undefined' && panning) return;
  // Fixed units only: Harvesters and Diggers wander for coins/rock and
  // must not pin the camera south. Cannon, Laser, Field, Outpost are
  // fixed (lantern = Outpost, bloom = Field, internal names).
  let southY = -1;
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    if (t.type === 'gather' || t.type === 'mole') continue;
    if (t.y > southY) southY = t.y;
  }
  if (southY < 0) return;
  const hh = view.h / cam.zoom / 2;
  const targetY = (southY + 0.5) * CELL_PX + AUTO_CAM_MARGIN_CELLS * CELL_PX - hh;
  if (targetY >= cam.y) return; // north-only: never drift south
  cam.y = Math.max(targetY, cam.y - AUTO_CAM_SPEED * dt);
  clampCamera();
}
// World border (v120, kept in v122): a subtle translucent white line
// around the map's edge, so you can tell exactly where the game world
// stops, even through fog. In v122 the ocean is inside the map, so
// the border outlines the whole map including its ocean ring.
const WORLD_BORDER = 'rgba(255,255,255,0.35)';
function clampCamera() {
  if (!cfg.cols) return;
  const mz = minZoom();
  cam.zoom = Math.min(Math.max(cam.zoom, mz), mz * 8);
  const hw = view.w / cam.zoom / 2, hh = view.h / cam.zoom / 2;
  const W = cfg.cols * CELL_PX, H = cfg.rows * CELL_PX;
  // No slack (v122, reverted from v120/v121): the view's edge stops
  // exactly at the map's edge. This is fine now because the starter
  // is no longer on the map edge — it sits on sand, inland of the
  // ocean ring, so centring on it does not squash it against the edge.
  // When the view is wider/taller than the map, pin to center instead of sliding.
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
const MOUNTAIN_BROWN_FILL = 0.42; // v197: CA seed fill for the brown islands left in the mountain biome (grey everywhere else) — ~15% brown, small scattered islands that break the grey up (measured: fill 0.42 -> ~15% coverage, 0.45 -> ~26%)
const GREY_MIN_DIST = 12;      // v198: cells from the starter with no grey — the central-grey pass that used this is gone, but the rule still holds: the v152 safety net converts any cliff grey within this radius back to easy brown, so the opening is never a 30–100 HP wall (SPAWN_EASY_RADIUS is the same 12)
// v152 spawn tuning (Sam: unlucky hard rock next to spawn, and corner
// spawns wasting half the arc): brown rock within SPAWN_EASY_RADIUS
// of the starter is capped at SPAWN_EASY_MAX_HP, and beach cells
// within SPAWN_CORNER_MARGIN of a perpendicular edge (i.e. in a
// corner) are never picked as the starter. Both are tuning knobs.
const SPAWN_EASY_RADIUS = 12;  // cells from the starter: easy rock zone (matches GREY_MIN_DIST)
const SPAWN_EASY_MAX_HP = 4;   // brown rock HP cap in that zone (was up to 10)
const SPAWN_CORNER_MARGIN = 15; // cells from a perpendicular edge: corner exclusion (see spawn filter)
const GREY_HP_MIN = 30, GREY_HP_MAX = 100;
const GREY_GOLD_CHANCE = 0.8;  // grey drops: mostly gold (XP is easy mid-game)
const BROWN_GOLD_CHANCE = 0.1; // regular brown rock: 10% gold on break (BLUE only, non-nugget, non-grey) — but only if the XP roll above failed (v130, Sam: no double drops), so effective gold is 0.7 × 0.1 = 7%, XP 30%, nothing 63%, and a brown break never drops 2 coins
// Coast (v117 beach, v119 grass, v122 ocean): three rings of open ground
// around the island, from the edge inward: ocean, sand, grass, then
// regular terrain. NOT percentage-based (v122): the total border is a
// fixed 10–20 cells per edge, varying smoothly along the edge, so a
// bigger map gets more island interior, not a bigger beach. Sand and
// grass are fixed thin (2 cells each); the ocean takes the remainder
// (6–16 cells), so you see a good bit of ocean, and the flood storm —
// whose shots enter at the map edge and paint open ground as they fly
// — visibly advances through the ocean first, then sand, then grass.
// Ocean, sand and grass cells are still EMPTY for all gameplay
// (placement, fog, flood spread, harvest, meteors) — S.ocean / S.beach
// / S.grass are only geographic flags: an ocean cell renders blue when
// it is EMPTY, sand yellow, grass green, and all three render normally
// (rock/territory) when something covers them, so a meteor boulder on
// the coast, once cleared, reveals coast again. The flags never clear,
// so coast geography persists. Because the coast is now inside the
// grid, fog applies to it (distance discs around units) and placement
// rules apply to it — units can technically stand on ocean (it is open
// ground, same as sand), which is a v122 simplification to flag, not a
// separate water-physics system.
// Coastline: per-edge total depths from smooth 1D noise, normalized
// per edge so the full 10–20 range actually shows (raw fbm clusters in
// the middle, which would look almost straight). Min 10 guarantees the
// rings are never broken: the ocean ring is a continuous edge loop,
// so the whole coast is one connected component (the starter's home
// component for pickRescueSites).
const COAST_MIN_DEPTH = 10; // fixed border: min total coast depth per edge, in cells
const COAST_MAX_DEPTH = 20; // fixed border: max total coast depth per edge, in cells
const COAST_SAND_CELLS = 2; // sand layer thickness, fixed (thin)
const COAST_GRASS_CELLS = 2; // grass layer thickness, fixed (thin)
const COAST_SEED_OFFSET = 77777; // own RNG stream: island generation (caves/noise/grey/nuggets) is untouched for a given seed
// v157 bottom ocean (Sam, 2026-11-05): 5x the ocean at the bottom, so
// the starter (on the bottom beach) sits further north in the map and
// appears closer to the top of the screen at start, with a wide blue
// band below it. Ocean = total - 4, so Nx ocean means total = 4 + Nx.
// v179 (Sam, 2026-11-09): 3x, down from 5x — the 5x coast swung
// 34–84 cells deep, so the shoreline ran near-vertical and the
// cannon's wide shots flew out over water; 3x swings 22–52, ~40%
// gentler slopes, shorter inlets. Capped at 60% of rows, so a small
// map can't become all ocean — the interior is preserved, just
// shorter. Top/left/right are unchanged.
const BOTTOM_OCEAN_MULT = 3;
const BOTTOM_COAST_MAX_FRAC = 0.6;
// v157 tile overdraw: each cell is drawn 0.5 world px larger on every
// side, so neighbours overlap and seal the hairline seams that
// fractional camera zoom leaves (black background showing through
// between cells). Later cells paint over the overlap, so boundaries
// stay where they were, to within half a world pixel.
const TILE_OVERDRAW = 0.5;
// Extra map rows added at the bottom for the 3x ocean (see newGame):
// the ocean grows by 2x its original depth, so the map grows by
// 2x the *largest* bottom ocean depth, and the interior north of the
// beach keeps exactly its old size — the ocean eats no terrain.
function bottomOceanExtraRows(seed, cols) {
  const noise = makeNoise2D(mulberry32(seed + COAST_SEED_OFFSET));
  const bottom = coastDepths(cols, noise, 0.71);
  let maxOcean = 0;
  for (let k = 0; k < bottom.length; k++) {
    maxOcean = Math.max(maxOcean, bottom[k] - COAST_SAND_CELLS - COAST_GRASS_CELLS);
  }
  return Math.round((BOTTOM_OCEAN_MULT - 1) * maxOcean);
}
function fillCell(x, y) {
  ctx.fillRect(x * CELL_PX - TILE_OVERDRAW, y * CELL_PX - TILE_OVERDRAW,
               CELL_PX + 2 * TILE_OVERDRAW, CELL_PX + 2 * TILE_OVERDRAW);
}
// v177: exact-size fill (no overdraw) — for the half-fog overlay only.
// The 50% black of adjacent half-fog cells overlaps by a pixel each
// side, and the overlap composites darker (0.75), drawing a grid over
// every half-fogged edge. Exact squares tile with no overlap, so the
// half-fog reads as one flat dim. Full fog stays overdrawn (opaque
// black: the overlap is invisible and it still seals the seams).
function fillCellExact(x, y) {
  ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
}
// v158 terrain tiles (Sam, 2026-11-05): pixel-art tiles in the style
// of his reference image, generated as a clean 4x2 sheet and cropped
// to assets/tiles/*.png (grass, sand, ocean, rock-brown, rock-grey,
// blue, red, soil). Cells draw the tile instead of a flat coloured
// square. Loading is guarded: in environments with no Image global
// (the harness) or before the files arrive, drawCellTile returns
// false and the caller falls back to the old flat-colour fillCell,
// so the game never depends on the tiles being ready. Team toggle
// is honoured: the player tile is red when PLAYER_RED, blue
// otherwise, and the flood tile is the opposite. Soil is loaded
// but unused yet — a future Field/plowed-ground tile.
// v160 (Sam, 2026-11-05): tiles are 16x16 (was 128x128), so each
// tile pixel is one cell pixel — chunky and pixelated, not smooth.
// v161 (Sam, 2026-11-05): tiles are 8x8 — each tile pixel is two
// cell pixels, even more pixelated. NEAREST sampling at 8x8 is
// lossy, so some tiles read blotchier than at 16x16; try-it by feel.
// And the shade range is back: a tile on its own is too flat, the
// old flat squares ran from a light shade to a dark one (ocean
// light sky blue to deep blue). So the tile is tinted with the
// cell's old flat shade colour at TILE_TINT_ALPHA — texture shows
// through, but the light/dark range is the old one. The ?v=160
// on the file names busts the browser cache of the 128px tiles.
// v162 (Sam, 2026-11-05): tiles are SHELVED — too distracting
// right now, so the game is back to flat coloured squares. Nothing
// is deleted: the tile files stay in assets/tiles/, the loading and
// draw code stays, and the tint stays, all behind TILES_ENABLED.
// Flip it to true, or open the game with ?tiles=1, to bring the
// tiles back; a future sprite editor will paint these same files.
let TILES_ENABLED = false; // shelved in v162; ?tiles=1 at boot re-enables
const TILE_TINT_ALPHA = 0.5; // tint overlay alpha — the shade-range knob
const TILE_NAMES = ['grass', 'sand', 'ocean', 'rock-brown', 'rock-grey', 'blue', 'red', 'soil'];
const TILES = {};
if (typeof Image !== 'undefined') {
  for (const name of TILE_NAMES) {
    const img = new Image();
    img.src = 'assets/tiles/' + name + '.png?v=161';
    TILES[name] = img;
  }
}
function tileReady(img) { return !!(img && img.complete && img.naturalWidth > 0); }
function drawCellTile(img, x, y, shade, tint) {
  if (!TILES_ENABLED) return false; // v162: tiles shelved, flat squares
  if (!tileReady(img)) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x * CELL_PX - TILE_OVERDRAW, y * CELL_PX - TILE_OVERDRAW,
                CELL_PX + 2 * TILE_OVERDRAW, CELL_PX + 2 * TILE_OVERDRAW);
  if (tint) {
    ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${TILE_TINT_ALPHA})`;
    fillCell(x, y);
  } else {
    const s = shade || 0;
    if (s > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + (s * 0.05).toFixed(3) + ')';
      fillCell(x, y);
    }
  }
  return true;
}
const OCEAN_SHADES = [ // v123: lighter sky blue, centred on the XP orb
  // color (#7dd3fc, shade 2) — light -> dark, so water reads as water,
  // not as the player's deeper blue or the flood's blue
  [224, 242, 254], [186, 230, 253], [125, 211, 252], [56, 189, 248],
  [14, 165, 233], [2, 132, 199], [3, 105, 161], [12, 74, 110],
];
const OCEAN_MINIMAP = '#7dd3fc'; // middle ocean shade = XP orb color, for the minimap
const BEACH_SHADES = [ // fixed sand yellow, light -> dark (not tied to the empty-color debug picker)
  [232, 213, 124], [226, 205, 110], [217, 196, 106], [205, 183, 94],
  [190, 168, 82], [172, 151, 70], [150, 131, 58], [128, 111, 48],
];
const BEACH_MINIMAP = '#d9c46a'; // middle beach shade, for the minimap
const GRASS_SHADES = [ // fixed grass green, light -> dark (distinct from cave green, so the grass layer reads on its own)
  [139, 195, 74], [130, 182, 69], [121, 170, 65], [112, 157, 60],
  [103, 145, 55], [94, 132, 51], [85, 120, 46], [76, 107, 41],
];
const GRASS_MINIMAP = '#79aa41'; // middle grass shade, for the minimap
function coastDepths(n, noise, u0) {
  // Raw noise along one edge (~2.5 undulations), normalized to 0–1,
  // then mapped to [COAST_MIN_DEPTH, COAST_MAX_DEPTH]. Returns total
  // coast depths in cells (float).
  const raw = new Float32Array(n);
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = noise((k / n) * 2.5, u0);
    raw[k] = v; if (v < mn) mn = v; if (v > mx) mx = v;
  }
  const span = (mx - mn) || 1;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const norm = (raw[k] - mn) / span;
    out[k] = COAST_MIN_DEPTH + (COAST_MAX_DEPTH - COAST_MIN_DEPTH) * norm;
  }
  return out;
}
function coastMask(cols, rows, seed) {
  // Returns { ocean, beach, grass } masks. v163: bottom edge ONLY —
  // no side coasts, no top coast (Sam, 2026-11-06). The bottom is
  // the ocean + starter beach; land runs to the map edge on the
  // other three sides, and the top is a beach biome, not a coast
  // ring (see BIOME_* in newGame). Per bottom position, total depth
  // T is the coast depth; ocean = T - 4, sand ends at T - 2, grass
  // ends at T. Bottom uses distance = (dim-1) - coord.
  const ocean = new Uint8Array(cols * rows);
  const beach = new Uint8Array(cols * rows);
  const grass = new Uint8Array(cols * rows);
  const noise = makeNoise2D(mulberry32(seed + COAST_SEED_OFFSET));
  const top = coastDepths(cols, noise, 0.13);
  const bottom = coastDepths(cols, noise, 0.71);
  // v157: 3x bottom ocean (v179, was 5x), capped at 60% of rows (see constants above).
  const bottomCap = Math.max(COAST_MAX_DEPTH, Math.floor(rows * BOTTOM_COAST_MAX_FRAC));
  for (let k = 0; k < bottom.length; k++) {
    bottom[k] = Math.min(4 + BOTTOM_OCEAN_MULT * (bottom[k] - COAST_SAND_CELLS - COAST_GRASS_CELLS), bottomCap);
  }
  const left = coastDepths(rows, noise, 0.29);
  const right = coastDepths(rows, noise, 0.87);
  // v163: no side/top coasts — zero those depths out. The arrays
  // are still computed so the noise stream (and therefore the
  // bottom depths for a given seed) is unchanged.
  top.fill(0); left.fill(0); right.fill(0);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const oceanD = (d, t) => d < t - COAST_SAND_CELLS - COAST_GRASS_CELLS;
      const sandD = (d, t) => d < t - COAST_GRASS_CELLS;
      const ringD = (d, t) => d < t;
      // Distances to each edge, as (distance, total) pairs.
      const edges = [
        [y, top[x]], [rows - 1 - y, bottom[x]],
        [x, left[y]], [cols - 1 - x, right[y]],
      ];
      if (edges.some(([d, t]) => oceanD(d, t))) { ocean[i] = 1; continue; }
      if (edges.some(([d, t]) => sandD(d, t))) { beach[i] = 1; continue; }
      if (edges.some(([d, t]) => ringD(d, t))) grass[i] = 1;
    }
  }
  return { ocean, beach, grass };
}
const MOVE_DUR = 0.25; // seconds to glide from one cell to the next (moles)
const HARVESTER_STEP_DUR = 1.0; // seconds per harvester step — slow on purpose, so speed (not range) limits collection
const MOLE_NUGGET_BIAS = 0.7; // blue mole: 70% toward nearest nugget, 30% random wander
// Enemy moles: while the red Bloom lives, it buys moles toward blue
// from its bank (same mole pricing as blue: base + step per living
// mole). Up to RED_MOLE_MAX alive — the cost, not a timer, is the
// limiter, so the enemy has to earn its army from its own fields.
const RED_MOLE_MAX = 3;
// Enemy bloom head start: Field level 3 (1.2^3 = 1.73x growth) vs
// the player's fresh Field at level 0 — the early overwhelmed
// feeling, same rules. (v181: was level 9 on the old 4-stat rotation,
// whose growth picks landed at levels 1, 5, 9; Field is growth-only
// now, so level 3 gives the same 1.73x.)
const RED_BLOOM_FIELD = 3;
// Territory harvest: a cell glows over HARVEST_EVERY seconds, then has
// this chance to produce (same as the rock XP surprise, not a salary).
const BLOOM_HARVEST_CHANCE = 0.3;
// Painted harvest (v114, middle option): cannon-painted ground pays
// too, but clearly weaker than Field — 10% vs Field's 30% per cycle,
// same 8-second cycle, same 80% XP / 20% gold split. Tunable.
const PAINTED_HARVEST_CHANCE = 0.1;

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
  if (st === EMPTY) {
    if (S.ocean && S.ocean[i]) return OCEAN_SHADES[S.shade[i] || 0];
    if (S.beach && S.beach[i]) return BEACH_SHADES[S.shade[i] || 0];
    if (S.grass && S.grass[i]) return GRASS_SHADES[S.shade[i] || 0];
    return CAVE_SHADES[S.shade[i] || 0];
  }
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
  const cols = Math.round(clampNum(inCols.value, 8, 200, 75));
  const rows = Math.round(clampNum(inRows.value, 8, 200, 50));
  cfg = {
    cols, rows,
    projSpeed: clampNum(inSpeed.value, 40, 2000, 200),   // px/s
    freq: clampNum(inFreq.value, 0.1, 20, 1),            // shots/s (both cannons)
    arc: clampNum(inArc.value, 0, 360, 120),             // degrees
    turnRate: clampNum(inTurn.value, 0, 720, 100),          // cannon sweep speed (deg/s)
    caveChance: clampNum(inCave.value, 0, 0.95, 0.38),      // CA cave fill
    coinChance: clampNum(inCoin.value, 0, 1, 0.3),          // coin drop per block excavated by blue
    popHold: clampNum(inPopHold.value, 0, 0.5, 0.03),        // big square hold time (s)
    popDur: clampNum(inPopDur.value, 0.05, 1, 0.1),          // pop shrink time (s)
    popPush: clampNum(inPopPush.value, 0, 1.5, 0.2),         // knockback push (cells)
    rippleAmp: clampNum(inRipple.value, 0, 1, 0.1),          // neighbor shockwave strength
    trailT: clampNum(inTrail.value, 0, 1, 0.1),               // projectile trail (s)
    gravity: clampNum(inGravity.value, 0, 40, 9),            // particle gravity (cells/s^2)
    fogDist: clampNum(inFogDist.value, 0, 20, 12),              // fog reveal distance on open ground (cells; v128: was 6)
  };
  // reflect clamped values back into the panel
  inCols.value = cols; inRows.value = rows;
  inSpeed.value = cfg.projSpeed; inFreq.value = cfg.freq;
  inArc.value = cfg.arc; inCave.value = cfg.caveChance;
  inTurn.value = cfg.turnRate;
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
const meta = { gold: 0, unlocks: { cannon: true, gather: false, mole: false, bloom: false },
  // Perma upgrades (outside runs, start screen): cannon Damage + Fire
  // Rate, 4 levels each (circles). A perma level is a new BASE: the run
  // starts at that level, and in-run picks stack on top (same track,
  // same cap 8 total). No cost yet (unlock/cost design TBD).
  perma: { dmg: 0, rate: 0 },
  // Start-screen shop toggles: which placements appear in the in-run
  // shop. Missing = enabled (all on by default, so runs are unchanged
  // until the player toggles). Explicit false = excluded from the run.
  // (Separate from unlocks: unlocks are future progression gating;
  // toggles are player choice for this run. End-of-run unlocking TBD.)
  enabled: {} };
function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem('tis_meta'));
    if (m && typeof m.gold === 'number') meta.gold = m.gold;
    if (m && m.unlocks) for (const k of Object.keys(meta.unlocks)) meta.unlocks[k] = !!m.unlocks[k];
    if (m && m.perma) {
      meta.perma.dmg = Math.max(0, Math.min(4, m.perma.dmg | 0));
      meta.perma.rate = Math.max(0, Math.min(4, m.perma.rate | 0));
    }
    if (m && m.enabled) for (const t of ['cannon', 'mole', 'bloom', 'gather', 'lantern', 'wall', 'laser'])
      if (typeof m.enabled[t] === 'boolean') meta.enabled[t] = m.enabled[t];
  } catch (e) { /* fresh save */ }
}
function saveMeta() {
  try { localStorage.setItem('tis_meta', JSON.stringify(meta)); } catch (e) { /* ignore */ }
}
// ---- Game state ----
let S = null;

// v144, starter-only inland aim: direction from (x, y) to the nearest
// interior cell — a cell that is none of ocean/beach/grass. Coast
// flags never clear, so this is geographic, not rock-state: the aim
// does not drift as the wall in front of the starter is cleared.
// From a beach cell the nearest interior cell is straight inland
// (the cliff wall), so a starter on the east beach faces west, on
// the south beach faces north, in a corner faces diagonally inward.
// Falls back to map centre if there is no interior cell at all.
function inlandAngle(x, y) {
  if (!S.ocean || !S.beach || !S.grass) return Math.atan2(cfg.rows / 2 - y, cfg.cols / 2 - x);
  let best = null, bd = Infinity;
  for (let yy = 0; yy < cfg.rows; yy++) {
    for (let xx = 0; xx < cfg.cols; xx++) {
      const i = yy * cfg.cols + xx;
      if (S.ocean[i] || S.beach[i] || S.grass[i]) continue;
      const d2 = (xx - x) ** 2 + (yy - y) ** 2;
      if (d2 < bd) { bd = d2; best = { x: xx, y: yy }; }
    }
  }
  if (!best) return Math.atan2(cfg.rows / 2 - y, cfg.cols / 2 - x);
  return Math.atan2(best.y - y, best.x - x);
}
function mkTurret(x, y, color, type) {
  const spec = TURRET[type];
  // Base aim is fixed at placement: blue aims straight up on survival
  // (v180), map-center on main; red aims at blue's corner. Nobody
  // tracks anybody — the patterns do the fighting. A waypoint
  // overrides a blue cannon's base while placed (see update loop).
  // inlandAngle is kept for the harness; nothing uses it anymore.
  // v180: on survival every BLUE cannon aims straight up (-PI/2) —
  // levels are vertical, so up is always the way to go, unless a
  // waypoint re-aims it (see the update loop). Main keeps map-centre
  // aim; red keeps aiming at blue's corner.
  const base = color === BLUE
    ? (SURVIVAL ? -Math.PI / 2 : Math.atan2(cfg.rows / 2 - y, cfg.cols / 2 - x))
    : Math.atan2(cfg.rows * 0.85 - y, cfg.cols * 0.15 - x);
  // Red gets tankier every wave so the escalation is real.
  const hpScale = color === RED ? 1 + 0.2 * (S.wave - 1) : 1;
  const w = color === BLUE && S.weapons[type] ? S.weapons[type] : null;
  const maxhp = Math.max(1, Math.round(spec.hp * hpScale)) + (w && w.hpBonus ? w.hpBonus : 0);
  const t = { x, y, color, type, hp: maxhp, maxhp, base, angle: base, dir: 1,
              cd: Math.random(), dead: false, coolT: 0, burstLeft: 0, burstT: 0 };
  // v195: a new Laser starts armed on survival (no initial cooldown)
  // — reactive firing means it should be ready the moment a
  // projectile enters range, even one already there when placed.
  if (type === 'laser' && SURVIVAL) t.cd = 0;
  if (type === 'mole') {
    // Digger: burrows through rock, turning randomly, dies after N cells.
    t.moleDir = Math.floor(Math.random() * 4);
    t.dug = 0;
    // v192: BLUE diggers live by the Dig track (12-24 at Dig 0,
    // +2/+2 per pick, 28-40 at Dig 8); RED moles keep the old
    // 20-40 (they don't level).
    const digLv = color === BLUE && S.weapons.mole && S.weapons.mole.stats ? (S.weapons.mole.stats.dig || 0) : 0;
    const lMin = color === BLUE ? moleLifetimeMinAt(digLv) : MOLE_LIFETIME_MIN;
    const lMax = color === BLUE ? moleLifetimeMaxAt(digLv) : MOLE_LIFETIME_MAX;
    t.lifetime = lMin + Math.floor(Math.random() * (lMax - lMin + 1));
    t.digT = 0;
    // Smooth-movement render state (glides cell to cell, no jumps).
    t.rx = x; t.ry = y; t.moveT = 1;
    // Flag: the cell this digger is trying to reach (blue only — red
    // moles keep hunting blue turrets, no flag). Set at spawn so the
    // flag is visible immediately, retargeted on arrival / staleness.
    t.flag = null; t.flagKind = null;
    if (color === BLUE) retargetDigger(t);
  }
  if (type === 'gather') {
    // Harvester: roams the grid toward pickups (see harvesterStep).
    t.rx = x; t.ry = y; t.moveT = 1; t.stepT = 0;
  }
  if (type === 'lantern') {
    // Outpost: stationary base anchor (v181: the vacuum left with the
    // Magnet passive; the Outpost itself does nothing per-frame).
  }
  return t;
}
// Gather pickups per pull, from its Count stat track.
function gatherCount() {
  const w = S.weapons.gather;
  return 1 + (w && w.stats ? (w.stats.count || 0) : 0);
}
// v181: the Field pull helpers are gone with the Field pull itself —
// pull now lives on the global Magnet passive (see magnetRadius /
// magnetInterval / magnetCount above), and Field is growth only.
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
    if (coinFogged(c)) continue; // v166: fogged coins are not collectible
    if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y) here.push(c);
  }
  const take = here.slice(0, gatherCount());
  for (const c of take) {
    c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
  }
  return take.length;
}
// Digger pickup (v135): a blue Digger collects every idle coin within
// 1 cell (Chebyshev: the 3x3 around it, own cell included) on each dig
// step, so it mines and banks gold/XP as it goes, without needing a
// Harvester or Outpost to chase those coins. Red moles don't collect
// (they have no player economy; stealing player coins would be a
// different mechanic). Coins fly to the XP bar / gold chip exactly like
// Harvester pickups, so gold and XP grant on arrival, not instantly.
const MOLE_PICKUP_RANGE = 1;
function collectAtMole(t) {
  if (t.color !== BLUE) return 0;
  let n = 0;
  for (const c of S.coins) {
    if (c.state !== 'idle') continue;
    if (coinFogged(c)) continue; // v166: fogged coins are not collectible
    if (Math.abs(Math.floor(c.x) - t.x) <= MOLE_PICKUP_RANGE &&
        Math.abs(Math.floor(c.y) - t.y) <= MOLE_PICKUP_RANGE) {
      c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
      n++;
    }
  }
  return n;
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
// ---- Digger flags (blue only) ----
// A blue digger always has a target cell (its flag): the nearest, by BFS
// steps through rock + open ground, among gold nugget cells (WHITE +
// goldNug) and cave cells it can't already walk to (EMPTY not reachable
// over open ground alone — i.e. a separate cave pocket, the way into
// the rescue caves). Whichever is closer wins; caves win ties (exploration
// toward rescue). When the digger reaches its flag it retargets to the
// next one; a flag that goes stale (gold broken elsewhere, cave painted
// to territory, occupied) retargets too. Turret cells block both BFS
// passes (a digger never stacks onto a turret, it routes around).
function diggerPathNext(sx, sy, tx, ty) {
  // BFS next step toward (tx, ty) over EMPTY / own BLUE / WHITE.
  // GREY and enemy RED block. Returns a direction index (0 up, 1 right,
  // 2 down, 3 left) for the first step, or null when already there or
  // unreachable.
  if (sx === tx && sy === ty) return null;
  const W = cfg.cols, H = cfg.rows;
  const blocked = new Set();
  for (const t of S.turrets) if (!t.dead) blocked.add(t.y * W + t.x);
  const dist = new Int32Array(W * H).fill(-1);
  const prev = new Int32Array(W * H).fill(-1);
  const start = sy * W + sx, target = ty * W + tx;
  const q = [start]; dist[start] = 0;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur === target) break;
    const cx = cur % W, cy = Math.floor(cur / W);
    for (let d = 0; d < 4; d++) {
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] >= 0 || (blocked.has(ni) && ni !== start)) continue;
      const st = S.cells[ni];
      if (st !== EMPTY && st !== BLUE && st !== WHITE) continue;
      dist[ni] = dist[cur] + 1; prev[ni] = cur; q.push(ni);
    }
  }
  if (dist[target] < 0) return null;
  let cur = target;
  while (prev[cur] !== -1 && prev[cur] !== start) cur = prev[cur];
  if (prev[cur] === -1) return null;
  const fx = cur % W, fy = Math.floor(cur / W);
  if (fx - sx === 1) return 1;
  if (fx - sx === -1) return 3;
  if (fy - sy === 1) return 2;
  return 0;
}
function retargetDigger(t) {
  if (!S || !S.cells) { t.flag = null; t.flagKind = null; return; }
  const W = cfg.cols, H = cfg.rows;
  const start = t.y * W + t.x;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const blocked = new Set();
  for (const u of S.turrets) if (!u.dead) blocked.add(u.y * W + u.x);
  // Open-reachable: EMPTY / own BLUE only, no rock. Caves in this set
  // are already connected — no need to dig to them.
  const open = new Uint8Array(W * H);
  {
    const q = [start]; open[start] = 1; let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      const cx = cur % W, cy = Math.floor(cur / W);
      for (let d = 0; d < 4; d++) {
        const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (open[ni] || (blocked.has(ni) && ni !== start)) continue;
        const st = S.cells[ni];
        if (st !== EMPTY && st !== BLUE) continue;
        open[ni] = 1; q.push(ni);
      }
    }
  }
  // Rock BFS distances: EMPTY / BLUE / WHITE, GREY + RED block.
  const dist = new Int32Array(W * H).fill(-1);
  {
    const q = [start]; dist[start] = 0; let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      const cx = cur % W, cy = Math.floor(cur / W);
      for (let d = 0; d < 4; d++) {
        const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (dist[ni] >= 0 || (blocked.has(ni) && ni !== start)) continue;
        const st = S.cells[ni];
        if (st !== EMPTY && st !== BLUE && st !== WHITE) continue;
        dist[ni] = dist[cur] + 1; q.push(ni);
      }
    }
  }
  let best = null, bestD = Infinity, bestKind = null, bestRank = Infinity;
  // Waiting civilians in caves (v136): a civilian cell in a pocket
  // the digger can't already walk to is the top-priority flag, ahead
  // of any cave or gold, even if farther — the digger is now the
  // rescue opener. If no waiting civilians remain, it falls back to
  // the old cave/gold choice below.
  const civCells = new Set();
  if (SURVIVAL && S.rescue && S.rescue.civilians) {
    for (const c of S.rescue.civilians) {
      if (c.state === 'waiting') civCells.add(c.y * W + c.x);
    }
  }
  for (let i = 0; i < S.cells.length; i++) {
    if (dist[i] < 0) continue;
    const st = S.cells[i];
    let kind = null, rank = Infinity;
    if (st === EMPTY && !open[i] && civCells.has(i)) { kind = 'civ'; rank = 0; }
    else if (st === WHITE && S.goldNug[i]) { kind = 'gold'; rank = 2; }
    else if (st === EMPTY && !open[i]) { kind = 'cave'; rank = 1; }
    else continue;
    if (blocked.has(i)) continue; // never target an occupied cell
    const d = dist[i];
    if (rank < bestRank || (rank === bestRank && d < bestD)) {
      best = i; bestD = d; bestKind = kind; bestRank = rank;
    }
  }
  if (best === null) { t.flag = null; t.flagKind = null; }
  else { t.flag = { x: best % W, y: Math.floor(best / W) }; t.flagKind = bestKind; }
}
function flagValid(t) {
  if (!t.flag) return false;
  const i = t.flag.y * cfg.cols + t.flag.x;
  if (t.flagKind === 'gold') {
    if (S.cells[i] !== WHITE || !S.goldNug[i]) return false;
  } else if (t.flagKind === 'civ') {
    // A civilian flag is stale once that civilian leaves its cave
    // (discovered and walking home) or the cell stops being open ground.
    if (S.cells[i] !== EMPTY) return false;
    const civ = (SURVIVAL && S.rescue && S.rescue.civilians || []).find(c => c.x === t.flag.x && c.y === t.flag.y);
    if (!civ || civ.state !== 'waiting') return false;
  } else if (t.flagKind === 'cave') {
    if (S.cells[i] !== EMPTY) return false;
  } else return false;
  const occ = turretAt(t.flag.x, t.flag.y);
  if (occ && occ !== t) return false;
  return true;
}
// ---- Rescue sites (survival only) ----
// Biome of a cell, for rescue sites (v177, v199: five biomes).
// Desert/grass come from the biome flags; unflagged land is
// mountain (upper) or dirt (lower); ocean is water. The bottom
// coast's sand/grass ring carries the same flags as the biome
// bands, so a row split separates them: the desert band ends
// ~0.20H down and the coast starts lower, so desert cells are
// above 0.25H and grass-band cells above 0.45H; anything flagged
// below that is coast, never a rescue biome. Unflagged land splits
// at 0.60H (mountain above, dirt below).
function rescueBiomeAt(x, y) {
  const i = y * cfg.cols + x;
  if (S.ocean && S.ocean[i]) return 'ocean';
  if (S.beach && S.beach[i]) return y < cfg.rows * 0.25 ? 'desert' : 'coast';
  if (S.grass && S.grass[i]) return y < cfg.rows * 0.45 ? 'grass' : 'coast';
  return y < cfg.rows * 0.60 ? 'mountain' : 'dirt';
}
// Pick RESCUE_SITES_PER_BIOME sites per biome (cliff, grass, beach),
// 1-5 civilians each (capped by pocket size). One site per separate
// pocket-in-biome first (spread across the biome), then extra sites
// in already-used pockets, then home-pocket cells as a last resort —
// so a run always has up to 9 sites, even on a map with few separate
// pockets. Uses the map-gen rng (same seed -> same sites); cells
// themselves are untouched, so the map stays identical to main for
// the same seed.
function pickRescueSites(rng) {
  if (!SURVIVAL || !S || !S.cells) return;
  const W = cfg.cols, H = cfg.rows, n = W * H;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // Components over EMPTY (4-dir) — a "separate pocket" really is
  // disconnected until you dig to it. (Fog no longer uses this
  // definition since v118; rescue still does.)
  const comp = new Int32Array(n).fill(-1);
  let compCount = 0;
  for (let i = 0; i < n; i++) {
    if (S.cells[i] !== EMPTY || comp[i] >= 0) continue;
    const q = [i]; comp[i] = compCount; let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      const cx = cur % W, cy = Math.floor(cur / W);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (S.cells[ni] !== EMPTY || comp[ni] >= 0) continue;
        comp[ni] = compCount; q.push(ni);
      }
    }
    compCount++;
  }
  // Home component = the one holding the starter cannon.
  let homeComp = -1;
  for (const t of S.turrets) {
    if (!t.dead && t.color === BLUE) { homeComp = comp[t.y * W + t.x]; break; }
  }
  // Pockets: component index -> cell list (turret-free cells only, so a
  // civilian never starts stacked on a turret).
  const pockets = new Map();
  for (let i = 0; i < n; i++) {
    if (S.cells[i] !== EMPTY || comp[i] < 0) continue;
    const x = i % W, y = Math.floor(i / W);
    if (turretAt(x, y)) continue;
    if (!pockets.has(comp[i])) pockets.set(comp[i], []);
    pockets.get(comp[i]).push(i);
  }
  const used = new Set(); // cell indices already holding a civilian
  const sites = [];
  const addSite = (cellList, biome) => {
    const avail = cellList.filter(i => !used.has(i));
    if (!avail.length) return false;
    for (let i = avail.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [avail[i], avail[j]] = [avail[j], avail[i]];
    }
    const count = Math.min(CIV_MIN + Math.floor(rng() * (CIV_MAX - CIV_MIN + 1)), avail.length);
    const siteIdx = sites.length;
    const anchor = avail[0];
    for (let k = 0; k < count; k++) {
      const ci = avail[k];
      used.add(ci);
      S.rescue.civilians.push({ x: ci % W, y: Math.floor(ci / W), rx: ci % W, ry: Math.floor(ci / W),
                               moveT: 1, stepT: 0, state: 'waiting', site: siteIdx,
                               counted: false, baseX: -1, baseY: -1 });
    }
    // celebrated: set by newGame after computeFog — a site whose
    // anchor is already clear at spawn was never hidden, so there
    // is no discovery to celebrate.
    sites.push({ x: anchor % W, y: Math.floor(anchor / W), biome, celebrated: false });
    return true;
  };
  // Per biome: pockets scoped to that biome's cells (a pocket can
  // span a boundary, so each pocket contributes its cells-in-biome
  // separately). Coast/ocean cells are never a rescue biome.
  for (const biome of RESCUE_BIOMES) {
    const inBiome = [];
    for (const [ci, cellsList] of pockets) {
      if (ci === homeComp) continue;
      const sub = cellsList.filter(i => rescueBiomeAt(i % W, Math.floor(i / W)) === biome);
      if (sub.length) inBiome.push(sub);
    }
    // Shuffle pockets with the map rng (same seed -> same sites).
    for (let i = inBiome.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [inBiome[i], inBiome[j]] = [inBiome[j], inBiome[i]];
    }
    const biomeStart = sites.length;
    // One site per separate pocket-in-biome first (spread across the biome).
    for (const pocket of inBiome) {
      if (sites.length - biomeStart >= RESCUE_SITES_PER_BIOME) break;
      addSite(pocket, biome);
    }
    // Fallback: extra sites in already-used pockets (different cells),
    // then home pocket cells in this biome, until we have 3 sites in
    // this biome or run out of cells.
    if (sites.length - biomeStart < RESCUE_SITES_PER_BIOME) {
      for (const pocket of inBiome) {
        if (sites.length - biomeStart >= RESCUE_SITES_PER_BIOME) break;
        addSite(pocket, biome);
      }
    }
    if (sites.length - biomeStart < RESCUE_SITES_PER_BIOME && homeComp >= 0 && pockets.has(homeComp)) {
      const homeInBiome = pockets.get(homeComp).filter(i => rescueBiomeAt(i % W, Math.floor(i / W)) === biome);
      while (sites.length - biomeStart < RESCUE_SITES_PER_BIOME) {
        if (!addSite(homeInBiome, biome)) break;
      }
    }
  }
  S.rescue.sites = sites;
  S.rescue.total = S.rescue.civilians.length;
  S.rescue.rescued = 0;
  // Spawn totals per biome (for the discovery message's Y — the
  // total number of civilians in that biome this run).
  S.rescue.byBiome = {};
  for (const b of RESCUE_BIOMES) S.rescue.byBiome[b] = 0;
  for (const c of S.rescue.civilians) {
    const b = (sites[c.site] || {}).biome;
    if (b && S.rescue.byBiome[b] !== undefined) S.rescue.byBiome[b]++;
  }
}
// Rescue target: a living BLUE Cannon or Outpost counts as base (Field,
// Harvester, Digger, Laser do not — Sam's spec: cannon or outpost for
// now). A civilian is rescued when it stands adjacent to one.
function isBaseAdjacent(cx, cy) {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of DIRS) {
    const t = turretAt(cx + dx, cy + dy);
    if (t && !t.dead && t.color === BLUE && (t.type === 'cannon' || t.type === 'lantern')) return true;
  }
  return false;
}
// Rescue markers (v173): the minimap ? and the world ? share one rule —
// a site counts as undiscovered while it still has civilians and its
// anchor cell is fogged. Once the fog clears you can see the blobs on
// the main map, so no ? is needed anywhere.
function rescueSiteUndiscovered(si) {
  if (!SURVIVAL || !S.rescue || !S.rescue.sites || !S.rescue.sites[si]) return false;
  const site = S.rescue.sites[si];
  const remaining = (S.rescue.civilians || []).some(c => c.site === si);
  if (!remaining) return false;
  if (fogHidden) return false; // x-ray debug: everything reads as clear
  return S.fog[site.y * cfg.cols + site.x] !== 0;
}
// Nearest cave with civilians still waiting there, measured to the
// player's base (nearest living BLUE Cannon/Outpost — the same base
// definition rescue uses). Moving civilians don't count: they're
// already walking home. Null when no cave has waiting civilians.
function nearestRescueSite() {
  if (!SURVIVAL || !S.rescue || !S.rescue.sites) return null;
  let best = null, bestD = Infinity;
  for (let si = 0; si < S.rescue.sites.length; si++) {
    const site = S.rescue.sites[si];
    const waiting = (S.rescue.civilians || []).some(c => c.site === si && c.state === 'waiting');
    if (!waiting) continue;
    let d = Infinity;
    for (const t of S.turrets) {
      if (t.dead || t.color !== BLUE || (t.type !== 'cannon' && t.type !== 'lantern')) continue;
      const dd = (t.x - site.x) * (t.x - site.x) + (t.y - site.y) * (t.y - site.y);
      if (dd < d) d = dd;
    }
    if (d === Infinity) d = 0; // no base units left: all sites tie, take the first
    if (d < bestD) { bestD = d; best = site; }
  }
  return best;
}
// Vampire-Survivors-style edge arrow to the nearest waiting cave.
// Null when there is no target, or when the target is on screen
// (you can see the cave — or its ? if fogged — so no arrow).
// Otherwise returns the screen position (edge-clamped) and angle.
function rescueArrow() {
  const site = nearestRescueSite();
  if (!site) return null;
  const sx = (site.x + 0.5) * CELL_PX, sy = (site.y + 0.5) * CELL_PX;
  const px = view.w / 2 + (sx - cam.x) * cam.zoom;
  const py = view.h / 2 + (sy - cam.y) * cam.zoom;
  if (px >= 0 && px <= view.w && py >= 0 && py <= view.h) return null; // in view: hide
  const m = 30; // arrow sits this far inside the screen edge
  // Top edge: below the HUD, not the screen edge. The XP bar (30px),
  // the gold/civilians chips (bottom 61) and the % stats (bottom ~66)
  // all live up there, and the chevron's tip reaches 14px above its
  // centre when it points straight up — so the centre clamps to 88,
  // clearing the HUD with a small gap. Sides and bottom keep m.
  const mTop = 88;
  const cx = view.w / 2, cy = view.h / 2;
  let dx = px - cx, dy = py - cy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const tx = dx !== 0 ? (dx > 0 ? (view.w - m - cx) / dx : (m - cx) / dx) : Infinity;
  const ty = dy !== 0 ? (dy > 0 ? (view.h - m - cy) / dy : (mTop - cy) / dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) };
}
// Rescue discovery celebration (v177): when a site's fog first clears
// while civilians still wait there, make it a moment — pause the game,
// lerp the camera to the cave, then show the dark overlay with pink
// confetti and "X / Y civilians discovered in Z biome" — discovered,
// not rescued: they only count as rescued when they reach your base.
// Tap anywhere to
// continue. One celebration per site (site.celebrated); sites whose
// anchor was already clear at spawn are marked celebrated in newGame
// and never celebrate.
function siteBiome(si) {
  const site = S.rescue && S.rescue.sites ? S.rescue.sites[si] : null;
  if (!site) return 'dirt';
  if (site.biome) return site.biome;
  return rescueBiomeAt(site.x, site.y); // synthetic/legacy sites without a biome
}
function checkRescueDiscovery() {
  if (!SURVIVAL || !S || !S.rescue || !S.rescue.sites || S.paused || S.runOver) return;
  if (fogHidden) return; // x-ray debug: nothing is really discovered
  if (S.rescueCeleb) return; // already celebrating one
  for (let si = 0; si < S.rescue.sites.length; si++) {
    const site = S.rescue.sites[si];
    if (site.celebrated) continue;
    const remaining = (S.rescue.civilians || []).some(c => c.site === si);
    if (!remaining) { site.celebrated = true; continue; }
    if (S.fog[site.y * cfg.cols + site.x] !== 0) continue; // still fogged
    startRescueCelebration(si);
    return; // one at a time; the next undiscovered site fires after this one closes
  }
}
function startRescueCelebration(si) {
  const site = S.rescue.sites[si];
  site.celebrated = true;
  const biome = siteBiome(si);
  const inCave = (S.rescue.civilians || []).filter(c => c.site === si).length;
  const inBiome = (S.rescue.byBiome && S.rescue.byBiome[biome] !== undefined)
    ? S.rescue.byBiome[biome]
    : (S.rescue.civilians || []).filter(c => siteBiome(c.site) === biome).length;
  if (rescueTitle) rescueTitle.textContent =
    `${inCave} / ${inBiome} civilians discovered in ${BIOME_NAMES[biome] || biome} biome`;
  S.paused = true;
  S.rescueCeleb = {
    si, phase: 'lerp', t: 0, dur: 0.8,
    x0: cam.x, y0: cam.y,
    x1: (site.x + 0.5) * CELL_PX, y1: (site.y + 0.5) * CELL_PX,
  };
}
function stepRescueCeleb(dt) {
  const celeb = S && S.rescueCeleb;
  if (!celeb || celeb.phase !== 'lerp') return;
  celeb.t += dt;
  const k = Math.min(celeb.t / celeb.dur, 1);
  const e = k * k * (3 - 2 * k); // smoothstep: gentle start and stop
  cam.x = celeb.x0 + (celeb.x1 - celeb.x0) * e;
  cam.y = celeb.y0 + (celeb.y1 - celeb.y0) * e;
  clampCamera();
  if (k >= 1) {
    celeb.phase = 'show';
    if (rescueOverlay) rescueOverlay.classList.remove('hidden');
  }
}
function closeRescueCelebration() {
  if (!S || !S.rescueCeleb) return;
  if (rescueOverlay) rescueOverlay.classList.add('hidden');
  S.rescueCeleb = null;
  S.paused = false;
}
// BFS next step toward the nearest base-adjacent cell (see isBaseAdjacent),
// over EMPTY / own BLUE, turret cells blocked. Returns a direction index
// (0 up, 1 right, 2 down, 3 left) for the first step, or null when already
// base-adjacent (caller rescues instead of moving) or unreachable (no
// path yet — the civilian waits until you dig one open).
function civilianPathNext(sx, sy) {
  if (isBaseAdjacent(sx, sy)) return null;
  const W = cfg.cols, H = cfg.rows;
  const blocked = new Set();
  for (const t of S.turrets) if (!t.dead) blocked.add(t.y * W + t.x);
  const dist = new Int32Array(W * H).fill(-1);
  const prev = new Int32Array(W * H).fill(-1);
  const start = sy * W + sx;
  const q = [start]; dist[start] = 0;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let head = 0, target = -1;
  while (head < q.length) {
    const cur = q[head++];
    const cx = cur % W, cy = Math.floor(cur / W);
    if (cur !== start && isBaseAdjacent(cx, cy)) { target = cur; break; }
    for (let d = 0; d < 4; d++) {
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] >= 0 || (blocked.has(ni) && ni !== start)) continue;
      const st = S.cells[ni];
      if (st !== EMPTY && st !== BLUE) continue;
      dist[ni] = dist[cur] + 1; prev[ni] = cur; q.push(ni);
    }
  }
  if (target < 0) return null;
  let cur = target;
  while (prev[cur] !== -1 && prev[cur] !== start) cur = prev[cur];
  if (prev[cur] === -1) return null;
  const fx = cur % W, fy = Math.floor(cur / W);
  if (fx - sx === 1) return 1;
  if (fx - sx === -1) return 3;
  if (fy - sy === 1) return 2;
  return 0;
}
// Civilian on a cell (any state), or null — so placement never stacks a
// turret / wall / waypoint on a civilian (v113).
function civilianAt(cx, cy) {
  if (!SURVIVAL || !S.rescue || !S.rescue.civilians) return null;
  for (const c of S.rescue.civilians) if (c.x === cx && c.y === cy) return c;
  return null;
}
// Collection spot (v113 settle spot, v165 collection trigger): the
// base a civilian may be collected at, or null. A cell is a spot when
// it is open ground (EMPTY/BLUE), not turret-occupied, not already
// holding another civilian (self excluded — the caller is standing
// there), and within CIV_SETTLE_RADIUS (Manhattan) of a living BLUE
// Cannon or Outpost. Nearest such base wins when a cell sits between
// two bases. Standing on a spot means "home" — the civilian flies
// away (see collectCivilian), it does not settle there anymore.
function civilianSettleBase(cx, cy, self) {
  if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) return null;
  const st = S.cells[cy * cfg.cols + cx];
  if (st !== EMPTY && st !== BLUE) return null;
  if (turretAt(cx, cy)) return null;
  for (const c of (S.rescue.civilians || [])) {
    if (c !== self && c.x === cx && c.y === cy) return null;
  }
  let best = null, bd = Infinity;
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE || (t.type !== 'cannon' && t.type !== 'lantern')) continue;
    const d = Math.abs(t.x - cx) + Math.abs(t.y - cy);
    if (d <= CIV_SETTLE_RADIUS && d < bd) { bd = d; best = t; }
  }
  return best;
}
// BFS next step toward the nearest settleable cell (see
// civilianSettleBase), over EMPTY / own BLUE, turret cells blocked.
// Settled cells are pass-through for transit (otherwise a crowd in a
// corridor would deadlock) — only the settle target must be free, so
// final resting cells never overlap. Returns a direction index, or
// null when no free spot is reachable yet.
function civilianSettleNext(sx, sy, self) {
  const W = cfg.cols, H = cfg.rows;
  const blocked = new Set();
  for (const t of S.turrets) if (!t.dead) blocked.add(t.y * W + t.x);
  const dist = new Int32Array(W * H).fill(-1);
  const prev = new Int32Array(W * H).fill(-1);
  const start = sy * W + sx;
  const q = [start]; dist[start] = 0;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let head = 0, target = -1;
  while (head < q.length) {
    const cur = q[head++];
    const cx = cur % W, cy = Math.floor(cur / W);
    if (cur !== start && civilianSettleBase(cx, cy, self)) { target = cur; break; }
    for (let d = 0; d < 4; d++) {
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] >= 0 || (blocked.has(ni) && ni !== start)) continue;
      const st = S.cells[ni];
      if (st !== EMPTY && st !== BLUE) continue;
      dist[ni] = dist[cur] + 1; prev[ni] = cur; q.push(ni);
    }
  }
  if (target < 0) return null;
  let cur = target;
  while (prev[cur] !== -1 && prev[cur] !== start) cur = prev[cur];
  if (prev[cur] === -1) return null;
  const fx = cur % W, fy = Math.floor(cur / W);
  if (fx - sx === 1) return 1;
  if (fx - sx === -1) return 3;
  if (fy - sy === 1) return 2;
  return 0;
}
// v165: civilian resource SEEKING is gone (v136's civilianCollectNext
// was deleted with it). A civilian never goes out of its way for a
// pickup — it only banks what is on the cell it happens to stand on
// (see collectAtCivilian, called on its cell each step). The rescue
// itself is now a collection: reaching a base flies the civilian to
// the civilians counter (see collectCivilian), it does not settle.
// Civilian collection on its cell: every idle pickup on that cell
// flies to the HUD like a tapped / Harvester pickup (grant on arrival).
function collectAtCivilian(c) {
  let n = 0;
  for (const coin of S.coins) {
    if (coin.state !== 'idle') continue;
    if (coinFogged(coin)) continue; // v166: fogged coins are not collectible
    if (Math.floor(coin.x) === c.x && Math.floor(coin.y) === c.y) {
      coin.state = 'fly'; coin.sx = coin.x; coin.sy = coin.y; coin.t = 0;
      n++;
    }
  }
  return n;
}
// v165: collect the civilian itself. It leaves the map at once (its
// cell frees up for the next civilian the same tick — the update loop
// filters 'collected' civilians out after the pass) as a pink blob
// flying to the civilians counter, reusing the coin fly machinery
// (kind 'civ', same accelerating lerp, same COIN_FLY_DUR). The count
// increments when the fly ARRIVES at the chip, not when it leaves —
// see the fly loop. The pink burst is the departure pop.
function collectCivilian(c) {
  c.state = 'collected';
  spawnBurst(c.x + 0.5, c.y + 0.5, CIV_PINK);
  S.coins.push({ x: c.x + 0.5, y: c.y + 0.5, state: 'fly', kind: 'civ',
                 sx: c.x + 0.5, sy: c.y + 0.5, t: 0, phase: 0, dead: false });
}
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
  const prevAutoCam = !!(S && S.autoCam); // v153: CAM toggle persists across runs in a session
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
  // v157: grow the map southward for the 3x bottom ocean (v179, was 5x), before any
  // cell array is allocated. cfg.rows is the *panel* size (inRows
  // stays untouched, so the next run adds the same extra again —
  // no runaway); the extra rows are all ocean, so the interior
  // keeps its old size and the starter keeps its old distance from
  // the top, while the map centre moves south and the starter
  // appears closer to the top of the screen at start.
  cfg.rows += bottomOceanExtraRows(seed, cfg.cols);

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
        freqMult: 1, paused: false, frame: 0, seed, shade, goldNug, autoCam: prevAutoCam,
        // v154: which placement types are in the bottom bar. Start
        // unlocked is Cannon only (v156, if enabled on the start
        // screen); the rest join when an XP unlock card is picked.
        unlocked: Object.fromEntries(PLACEBAR_TYPES.map(t => [t, START_UNLOCKED.includes(t) && !(meta && meta.enabled && meta.enabled[t] === false)])),
        coins: [], floaters: [], gold: 0, chipPulse: 0, civChipPulse: 0, time: 0, lastBanked: banked,
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
        // Sparkles (v123, v124 ocean ripples, v125 dash shimmer,
        // v126 both): purely visual glints on ocean water, no gameplay
        // effect. See updateSparkles / render.
        sparkles: [], sparkleT: 0.8,
        destroyed: 0, destroyedBlue: 0,
        // passives (VS-style): Magnet (v181) is the first since
        // Bounce was removed v106, replaced by Penetration (forward,
        // not random ricochet). Future passives go here with initial
        // level 0; unset passives read as 0 everywhere (|| 0).
        passives: {},
        // auto-battler state
        turrets: [], missiles: [], beams: [],
        wave: 0, redQueue: [], redTimer: 0, waveBreak: 0, redKills: 0,
        placing: null, runOver: false,
        // rescue (survival only, populated by pickRescueSites below):
        // sites = anchor cells for the minimap ?, civilians walk home.
        // byBiome = spawn totals per biome (for the discovery message).
        rescue: { sites: [], civilians: [], rescued: 0, total: 0, byBiome: {} },
        // Rescue discovery celebration (v177): camera lerp + overlay
        // while a site is being celebrated; null otherwise.
        rescueCeleb: null,
        // waypoints (survival shop only): gold aim markers, not turrets —
        // cannons orient to the nearest one (see cannon update).
        waypoints: [],
        // meteor shower (v116): idle -> warn (10s minimap rings)
        // -> shower (staggered shrinking shadows -> impact) -> idle.
        // First warning starts 1–2 minutes in (v126: was 2–4), so the
        // first minute stays quiet for levelling, then showers break in.
        meteor: { phase: 'idle',
                  timer: METEOR_INTERVAL_MIN + Math.random() * (METEOR_INTERVAL_MAX - METEOR_INTERVAL_MIN),
                  targets: [], idx: 0, stagger: 0 },
        dmgBonus: 0, steerMult: 1,
        // territory (Tiberium fields): per-cell growth progress
        growN: new Uint8Array(n), growBy: new Uint8Array(n), growT: new Float32Array(n),
        bloomMult: 1, harvT: new Float32Array(n),
        // paint (v113): 1 = cannon-painted territory, no harvest (Field
        // still owns resources); 0 = Field-grown or flipped flood, harvests.
        // Painted cells render, count for %, and block exactly like field
        // cells — only harvest (and placement, see placeTurretAt) cares.
        noHarvest: new Uint8Array(n),
        // fog of war: 0 = clear, 1 = half, 2 = full (black)
        fog: new Uint8Array(n).fill(2),
        // v159: cells permanently revealed by enemy projectiles
        // (see stepProjectile). Merged into computeFog, so a revealed
        // cell stays clear even when no turret is in range — the map
        // gets revealed in the pattern of the enemy shots, instead of
        // projectiles flying obscured by fog. Fog still only clears.
        fogRevealed: new Uint8Array(n),
        // ocean (v122, survival only): 1 = ocean-ring cell (see coastMask).
        // Geographic only — gameplay still sees EMPTY; rendering/minimap
        // use it to show blue ocean when the cell is open.
        ocean: new Uint8Array(n),
        // beach (v117, survival only): 1 = sand-ring cell (see coastMask).
        // Geographic only — gameplay still sees EMPTY; rendering/minimap
        // use it to show yellow sand when the cell is open.
        beach: new Uint8Array(n),
        // grass (v119, survival only): 1 = grass-ring cell, the inner
        // layer of the coast ring (ocean outer, sand middle, grass inner).
        // Same rules as beach: EMPTY gameplay, green rendering when open.
        grass: new Uint8Array(n) };
  // Survival: the flood controller (random edge, wave timer). Its own
  // RNG stream, so the map below is identical to main for the same seed.
  S.flood = floodInit(seed);

  // Coast mask early (v117/v119/v122, survival only): it must exist
  // before the HP normalization below, so coast cells' noise values
  // don't set the island's HP range — otherwise an HP extreme that only
  // occurs on the coast would vanish from island rock (HP 3 did on
  // seed 1234, beach-only, before the exclusion).
  if (SURVIVAL) {
    const coast = coastMask(cfg.cols, cfg.rows, seed);
    S.ocean = coast.ocean; S.beach = coast.beach; S.grass = coast.grass;
  }

  // Caves first (cellular-automata blobs), then HP from a smooth noise gradient:
  // white ~3 hits ... dark grey ~10 hits
  const cave = genCaves(cfg.cols, cfg.rows, cfg.caveChance, rng);
  const noise = makeNoise2D(rng);
  // Raw fbm clusters in the middle (0.16–0.89 on a typical map), so the
  // lightest and darkest rock never appeared. Normalize per map: stretch
  // the observed range to 0–1, so all 8 HP levels show up every seed.
  // Same field, just wider values — blob edges get steeper HP ramps while
  // blob centers stay smooth. Grey reuses this field (see below).
  // Coast cells are excluded: only island rock sets the range.
  const raw = new Float32Array(cfg.cols * cfg.rows);
  let vmin = 1, vmax = 0;
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      raw[i] = noise((x / cfg.cols) * 3.5, (y / cfg.rows) * 3.5);
      if (!cave[i] && !S.ocean[i] && !S.beach[i] && !S.grass[i]) {
        if (raw[i] < vmin) vmin = raw[i];
        if (raw[i] > vmax) vmax = raw[i];
      }
    }
  }
  const vspan = (vmax - vmin) || 1; // degenerate map guard
  let norm = v => (v - vmin) / vspan; // v179: reassigned after the
  // biome pass (below), once the final rock set is known
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

  // Ocean + sand + grass (v117/v119/v122, survival only): override the
  // coast rings to open ground, after terrain but before starter/grey/
  // nuggets, so grey and nuggets (both WHITE-only) never land on the
  // coast, and the starter can spawn on sand. Island interior is
  // untouched for a given seed (coast uses its own RNG stream; the mask
  // was computed before terrain so island HP normalization excludes
  // coast cells). Fog note (v118): fog is distance-only, so the coast
  // rings are NOT fully revealed at start — only the starter's disc
  // is, and the rest of the coast stays dark until a unit gets near
  // it. Rescue note: the coast ring is the starter's home component,
  // so pickRescueSites puts civilians in separate island pockets, not
  // on the coast — rescue still means digging into the island.
  if (SURVIVAL) {
    for (let i = 0; i < n; i++) {
      if (!S.ocean[i] && !S.beach[i] && !S.grass[i]) continue;
      cells[i] = EMPTY; hp[i] = 0; maxhp[i] = 0; goldNug[i] = 0;
    }
  }

  // v163 biomes (Sam, 2026-11-06), v199 (Sam, 2026-11-13): the map
  // is five horizontal bands, each roughly a fifth of the height,
  // bottom to top:
  //   ocean — the bottom coast (already done above, 3x ocean + beach)
  //   dirt — brown earth: the existing cave-pockets-in-rock
  //     interior, untouched below (the soft ground you start in)
  //   mountain — grey rock (v197/v198: grey IS the cliff, solid
  //     rock as opposed to brown earth), with little brown islands
  //   grass — mostly open grass, with LARGE rock islands for mining
  //   desert — a long dry sand at the top, with only SMALL rock
  //     islands (sand, no water — unlike the beach by the ocean)
  // No side coasts: land runs to the left/right edges in every band.
  // Grass and desert bands are applied here, after the cave/rock
  // generation above and the coast override, so they replace it in
  // their bands only. Rock islands keep HP from the same Perlin
  // field (3–10, like dirt rock); open ground renders via the
  // grass/beach flags, so the minimap and tiles read the biome too.
  // (The desert sets the S.beach flag — it means sand, whether
  // beach by the water or dry desert at the top.)
  // Rescue note: grass/desert open ground is one big EMPTY component,
  // so rescue sites may now sit in open ground there, not only in
  // dirt/mountain caves — pickRescueSites' fallback already covers that.
  // v164 (Sam, 2026-11-06): three fixes from his screenshot —
  // (1) grass islands are BIGGER: fill 0.42 -> 0.48, and any grass
  // rock island smaller than BIOME_MIN_ISLAND cells is removed, so
  // the speckle goes and the islands read as large;
  // (2) the top desert gets islands too, at the size the grass ones
  // were in v163 (fill 0.42) — small islands, fewer of them than
  // the grass band has;
  // (3) the biome edges are no longer straight horizontal lines:
  // each boundary wanders by up to BIOME_EDGE_WANDER cells along x
  // (Perlin), and inside a BIOME_TRANSITION-wide zone around it
  // the two biomes are dithered by noise, so the edge is ragged
  // with fingers of each biome crossing it instead of a hard line.
  if (SURVIVAL) {
    const H = cfg.rows;
    const BIOME_GRASS_FILL = 0.45, BIOME_DESERT_FILL = 0.42;
    const BIOME_EDGE_WANDER = 12, BIOME_TRANSITION = 8, BIOME_MIN_ISLAND = 6;
    const grassRock = genCaves(cfg.cols, cfg.rows, BIOME_GRASS_FILL, rng);
    const desertRock = genCaves(cfg.cols, cfg.rows, BIOME_DESERT_FILL, rng);
    // v197: brown islands for the mountain biome — own RNG stream
    // (seed + 99993) so the existing map generation is untouched.
    const mountainBrown = genCaves(cfg.cols, cfg.rows, MOUNTAIN_BROWN_FILL, mulberry32(seed + 99993));
    const edgeNoise = makeNoise2D(mulberry32(seed + 99991));
    const ditherNoise = makeNoise2D(mulberry32(seed + 99992));
    // Wander is capped so adjacent boundaries can never cross, even
    // on a short map (bands are 0.20H tall).
    const wander = Math.min(BIOME_EDGE_WANDER, H * 0.06);
    const b1 = x => H * 0.20 + (edgeNoise(x * 0.06, 0.31) - 0.5) * 2 * wander;
    const b2 = x => H * 0.40 + (edgeNoise(x * 0.06, 0.73) - 0.5) * 2 * wander;
    const b3 = x => H * 0.60 + (edgeNoise(x * 0.06, 0.17) - 0.5) * 2 * wander;
    const biomeAt = (x, y) => {
      const t = BIOME_TRANSITION;
      const dither = (d, lower, upper) => {
        if (d < -t) return upper;
        if (d > t) return lower;
        const p = (d + t) / (2 * t); // 0 at top of zone, 1 at bottom
        return ditherNoise(x * 0.25, y * 0.25) < p ? lower : upper;
      };
      if (dither(y - b1(x), 'grass', 'desert') === 'desert') return 'desert';
      if (dither(y - b2(x), 'mountain', 'grass') === 'grass') return 'grass';
      return dither(y - b3(x), 'dirt', 'mountain');
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < cfg.cols; x++) {
        const i = y * cfg.cols + x;
        // Coast wins: the deep bottom coast can reach up into the
        // grass band (it is up to 60% of rows), so a coast cell must
        // never become a biome rock island with its coast flag left
        // on — that was a sand cell turned WHITE with S.beach set.
        if (S.ocean[i] || S.beach[i] || S.grass[i]) continue;
        const band = biomeAt(x, y);
        if (band === 'desert') { // top desert biome (sand, no water)
          if (desertRock[i]) {
            cells[i] = WHITE;
            const m = 3 + Math.round(norm(raw[i]) * 7);
            maxhp[i] = m; hp[i] = m; goldNug[i] = 0;
          } else {
            cells[i] = EMPTY; hp[i] = 0; maxhp[i] = 0; goldNug[i] = 0;
            S.beach[i] = 1; // S.beach means sand (desert or beach)
          }
        } else if (band === 'grass') { // grass biome
          if (grassRock[i]) {
            cells[i] = WHITE;
            const m = 3 + Math.round(norm(raw[i]) * 7);
            maxhp[i] = m; hp[i] = m; goldNug[i] = 0;
          } else {
            cells[i] = EMPTY; hp[i] = 0; maxhp[i] = 0; goldNug[i] = 0;
            S.grass[i] = 1;
          }
        } else if (band === 'mountain') { // mountain biome (v197):
          // mostly grey rock (Sam: grey IS the cliff, solid rock
          // as opposed to brown earth). Brown survives only as
          // little islands (mountainBrown mask) that break the
          // grey up. Caves stay open; only WHITE rock converts.
          if (cells[i] === WHITE && !mountainBrown[i]) {
            const v = norm(raw[i]);
            cells[i] = GREY;
            maxhp[i] = hp[i] = GREY_HP_MIN + Math.round(v * (GREY_HP_MAX - GREY_HP_MIN));
            shade[i] = Math.round(v * 7);
            goldNug[i] = 0;
          }
        }
        // 'dirt' biome: untouched — brown earth with cave pockets,
        // the soft ground you start in (no conversion here).
      }
    }
    // Grass speckle removal: flood-fill the WHITE cells in the grass
    // band and delete any rock island smaller than BIOME_MIN_ISLAND
    // cells, so the grass biome is open grass plus a few large
    // islands. Desert islands are left alone — small is what Sam
    // wants there.
    {
      const seen = new Uint8Array(n);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < cfg.cols; x++) {
          const i = y * cfg.cols + x;
          if (seen[i] || cells[i] !== WHITE || S.ocean[i] || S.beach[i] || S.grass[i]) continue;
          if (biomeAt(x, y) !== 'grass') continue;
          const comp = [i]; seen[i] = 1;
          for (let head = 0; head < comp.length; head++) {
            const cur = comp[head], cx = cur % cfg.cols, cy = Math.floor(cur / cfg.cols);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= H) continue;
              const ni = ny * cfg.cols + nx;
              if (seen[ni] || cells[ni] !== WHITE || S.ocean[ni] || S.beach[ni] || S.grass[ni]) continue;
              if (biomeAt(nx, ny) !== 'grass') continue;
              seen[ni] = 1; comp.push(ni);
            }
          }
          if (comp.length < BIOME_MIN_ISLAND) {
            for (const ci of comp) {
              cells[ci] = EMPTY; hp[ci] = 0; maxhp[ci] = 0; goldNug[ci] = 0;
              S.grass[ci] = 1;
            }
          }
        }
      }
    }
  }

  // v179: re-stretch the brown HP field over the FINAL white cells.
  // The first normalization (above) ran before the biome pass, and
  // the biome pass can turn the extreme cells into open ground, so
  // HP 10 (or 3) could vanish on some seeds — the "all 8 levels
  // every seed" guarantee only holds if the stretch is measured on
  // the cells that stay rock. Grey runs after this and reuses norm,
  // so it keeps the same full 30–100 stretch.
  {
    let vmin2 = 1, vmax2 = 0;
    for (let i = 0; i < n; i++) {
      if (cells[i] !== WHITE) continue;
      if (raw[i] < vmin2) vmin2 = raw[i];
      if (raw[i] > vmax2) vmax2 = raw[i];
    }
    const vspan2 = (vmax2 - vmin2) || 1;
    norm = v => (v - vmin2) / vspan2;
    for (let i = 0; i < n; i++) {
      if (cells[i] !== WHITE) continue;
      const m = 3 + Math.round(norm(raw[i]) * 7);
      maxhp[i] = m; hp[i] = m;
    }
  }

  // The player's Cannon spawns: survival = anywhere on the beach
  // (random beach cell, own RNG stream so the island RNG is untouched
  // — same seed still builds the same island, and the same beach
  // starter). Main (frozen) = inside a cave near the bottom-left
  // anchor, as before — chipping away at cave walls feels better than
  // painting open ground. Red comes in waves after that (see startWave).
  let pc;
  if (SURVIVAL) {
    const beachCells = [];
    for (let i = 0; i < n; i++) if (S.beach[i]) beachCells.push(i);
    // v155 bottom-only: spawn is always on the bottom beach — a
    // beach cell in the bottom coast band, with x at least
    // SPAWN_CORNER_MARGIN from either side edge, so the starter sits
    // mid-bottom, never in a corner. v157: the bottom band is now
    // up to 60% of rows (3x ocean, v179 was 5x), not the old last-20-rows band.
    // Fallback: if filtering empties the list (tiny custom maps),
    // use the full beach list — a corner spawn beats no spawn.
    const bottomBand = Math.max(COAST_MAX_DEPTH, Math.floor(cfg.rows * BOTTOM_COAST_MAX_FRAC));
    const bottomCells = beachCells.filter(i => {
      const x = i % cfg.cols, y = Math.floor(i / cfg.cols);
      return y >= cfg.rows - bottomBand && x >= SPAWN_CORNER_MARGIN && x <= cfg.cols - 1 - SPAWN_CORNER_MARGIN;
    });
    const spawnCells = bottomCells.length ? bottomCells : beachCells;
    if (spawnCells.length) {
      const starterRng = mulberry32(seed + 88888);
      const bi = spawnCells[Math.floor(starterRng() * spawnCells.length)];
      pc = { x: bi % cfg.cols, y: Math.floor(bi / cfg.cols) };
    } else {
      const pA = { x: cfg.cols * 0.15, y: cfg.rows * 0.85 };
      const pi = nearestCave(pA.x, pA.y, -1);
      pc = pi >= 0 ? { x: pi % cfg.cols, y: Math.floor(pi / cfg.cols) } : snapAnchor(pA);
    }
  } else {
    const pA = { x: cfg.cols * 0.15, y: cfg.rows * 0.85 };
    const pi = nearestCave(pA.x, pA.y, -1);
    pc = pi >= 0 ? { x: pi % cfg.cols, y: Math.floor(pi / cfg.cols) } : snapAnchor(pA);
  }
  const pci = pc.y * cfg.cols + pc.x;
  if (S.cells[pci] !== EMPTY) {
    // The starter always gets open ground: clear its cell (the snapAnchor
    // fallback can land on terrain when there are no caves at all).
    S.cells[pci] = EMPTY;
    S.hp[pci] = 0; S.maxhp[pci] = 0;
  }
  // The starter is always Cannon; the shop only gates mid-run drafts.
  // v155 bottom-only (supersedes v144 inland aim): the starter always
  // faces straight up (-PI/2, north), because the spawn is always on
  // the bottom beach and the run always goes up. v180: every later
  // BLUE cannon aims straight up too, from mkTurret. A waypoint
  // overrides it while placed, and teleport clears the starter flag
  // (see completeTeleport) — a teleported cannon still aims straight
  // up like any placed cannon. inlandAngle() is kept for the harness,
  // but no longer used for the starter.
  const starterT = mkTurret(pc.x, pc.y, BLUE, 'cannon');
  if (SURVIVAL) {
    starterT.isStarter = true;
    starterT.base = starterT.angle = -Math.PI / 2;
    // v155: waves always come from the south, fixed for the run.
    // Never updated on teleport — a teleported starter does not
    // move the flood front.
    if (S.flood) S.flood.starterDir = 1; // FLOOD_DIRS[1] = 'south'
  }
  S.turrets.push(starterT);
  S.weapons.cannon = { stats: initWeaponStats('cannon'), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false, evoPaint: false };
  // v182: the wall track lives here (walls have no turret entry, so
  // placement never creates it). The cards are gated on
  // S.unlocked.wall, so the levels sit at 0 until the Wall is
  // unlocked and picked.
  S.weapons.wall = { stats: initWeaponStats('wall'), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false };
  // Perma base: cannon starts at the perma levels (not 0), and in-run
  // picks stack on top (same track, same cap 5 total). Starter is always
  // placed even if cannon is toggled off on the start screen — the toggle
  // only stops the shop offering cannon duplicates, it never removes the starter.
  S.weapons.cannon.stats.dmg = (meta.perma && meta.perma.dmg) || 0;
  S.weapons.cannon.stats.rate = (meta.perma && meta.perma.rate) || 0;
  applyStat(S.weapons.cannon, 'cannon', 'dmg');
  applyStat(S.weapons.cannon, 'cannon', 'rate');
  // Enemy head start: red bloom at Growth 3 (same stat, same formula as
  // blue's Growth picks — just pre-applied, so red spreads faster early).
  S.redWeapons.bloom = { stats: initWeaponStats('bloom'), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false };
  // v138: red Field level 9 gives growth at levels 1,5,9 = 1.2^3 = 1.73x,
  // the old Growth 3 head start; its pull radius/count/interval are
  // irrelevant (red Fields don't pull), so only the growth part matters.
  S.redWeapons.bloom.stats.field = RED_BLOOM_FIELD;
  applyStat(S.redWeapons.bloom, 'bloom', 'field');
  // v198 (Sam): the old central-grey pass is gone. It put hard grey
  // chunks in the centre of the map because the original prototype
  // was attacked from four directions, so you were always pushing
  // inwards and the centre was made the strongest. Now the game
  // only goes up (bottom to north), so that logic is obsolete —
  // grey lives only in the cliff biome (v197: grey IS the cliff,
  // solid rock, as opposed to brown earth). The first grey you meet
  // is in the cliff. (Meteors still add grey rock dynamically.)
  // v152 easy rock at spawn: yes, you can seed a spot — not by
  // re-seeding the global Perlin field (that would move the whole
  // map), but by post-processing the spawn area after generation.
  // Brown rock within SPAWN_EASY_RADIUS of the starter is capped
  // at SPAWN_EASY_MAX_HP (both hp and maxhp, so the cell reads as
  // full-health light rock, not damaged dark rock). Perlin variation
  // survives as 3 vs 4 HP, and beyond the radius the full 3–10
  // depth is untouched — so an unlucky spawn can no longer start
  // you next to a 10-HP wall, but the rest of the map still varies.
  // v197: cliff grey can land within the radius too (the cliff
  // conversion runs before the starter is placed, so it has no
  // GREY_MIN_DIST check) — any GREY within the radius becomes
  // easy brown instead, so the opening is never a 30–100 HP wall.
  // (v198: the central-grey pass is gone, so cliff grey is the
  // only grey that can land here — and the first grey you meet is
  // in the cliff, past this radius.)
  for (let y = 0; y < cfg.rows; y++) {
    for (let x = 0; x < cfg.cols; x++) {
      const i = y * cfg.cols + x;
      const dx = x - pc.x, dy = y - pc.y;
      if (dx * dx + dy * dy >= SPAWN_EASY_RADIUS * SPAWN_EASY_RADIUS) continue;
      if (cells[i] === GREY) {
        cells[i] = WHITE;
        hp[i] = maxhp[i] = SPAWN_EASY_MAX_HP;
        goldNug[i] = 0;
      } else if (cells[i] === WHITE && hp[i] > SPAWN_EASY_MAX_HP) {
        hp[i] = SPAWN_EASY_MAX_HP; maxhp[i] = SPAWN_EASY_MAX_HP;
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
  if (SURVIVAL) pickRescueSites(rng); // 3 sites per biome, 1-5 civilians each (see pickRescueSites)
  startWave(1);
  computeFog();   // fog of war: fogDist on open ground, 3 into rock, around player units
  // v177: a site whose anchor is already fog-clear at spawn was never
  // hidden, so there is no discovery to celebrate — mark it celebrated
  // so the rescue celebration never fires for it.
  if (SURVIVAL && S.rescue) for (const site of S.rescue.sites) {
    if (S.fog[site.y * cfg.cols + site.x] === 0) site.celebrated = true;
  }

  resize();       // backing store = viewport x devicePixelRatio
  // v119: start zoomed in on the starting unit, not fully zoomed out.
  // pc is the starter (sand on survival, cave on main) — clampCamera
  // inside resetCamera pins to the map edge (v122: no slack, but the
  // starter is inland of the ocean ring, so it still centres well).
  resetCamera(START_ZOOM_MULT, (pc.x + 0.5) * CELL_PX, (pc.y + 0.5) * CELL_PX);

  overlay.classList.add('hidden');
  overlay.classList.remove('mapview');
  if (lvviewmap) lvviewmap.textContent = 'View map';
  runover.classList.add('hidden');
  placebanner.classList.add('hidden');
  placeswap.classList.add('hidden');
  wavebanner.classList.add('hidden');
  if (typeof syncCamBtn === 'function') syncCamBtn(); // v153: CAM button reflects preserved toggle
  updateHud();
}

// ---- Fog of war --------------------------------------------------------
// 0 = clear, 1 = half (smooth transition), 2 = full (black).
// Reveal source (v128, Sam: open ground should show much further
// than terrain): light from each living BLUE unit. Open ground
// (EMPTY, territory — ocean, sand, grass, cave floor) reveals out
// to fogDist (default 12, was 6), but only via an open path —
// rocky terrain (WHITE brown, GREY rock/walls) blocks the light,
// which only penetrates FOG_ROCK_PENETRATION (2) cells into rock
// and never leads on to open ground beyond the rock. So a beach
// and ocean around a unit actually show, while an island's interior
// stays dark behind its rock face, except for the 2-cell face
// itself. Half-fog is the 1-cell edge beyond whatever is clear.
// Recomputed when a block is excavated, a unit is placed or
// teleported, or the game starts. Fog only ever clears, never
// closes back in. No cave flood-fill: being in the same cave, or
// on the connected beach ring, no longer reveals the whole component
// — only the open ground within fogDist, via an open path, does.
const FOG_ROCK_PENETRATION = 2; // cells deep into rock light goes (v128, cut to 2 in v131)
function computeFog() {
  const W = cfg.cols, H = cfg.rows, n = W * H;
  const nf = new Uint8Array(n).fill(2);
  const R = cfg.fogDist, R2 = R * R;
  const isRock = (i) => S.cells[i] === WHITE || S.cells[i] === GREY;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    // BFS per unit. best[i] = smallest rock depth seen reaching i
    // (255 = unreached; open cells are depth 0). A rock cell reached
    // via a shallower rock path re-queues, because it can then
    // penetrate further — a cell reached first via 3 rock steps
    // could still be reached via 1 rock step around the other side.
    const best = new Uint8Array(n).fill(255);
    const start = t.y * W + t.x;
    const q = [start];
    let head = 0;
    best[start] = 0; nf[start] = 0;
    while (head < q.length) {
      const cur = q[head++];
      const cx = cur % W, cy = Math.floor(cur / W);
      const curIsRock = cur !== start && isRock(cur);
      const curDepth = best[cur];
      if (curIsRock && curDepth >= FOG_ROCK_PENETRATION) continue; // rock face ends here
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (isRock(ni)) {
          const nd = curIsRock ? curDepth + 1 : 1;
          if (nd > FOG_ROCK_PENETRATION || best[ni] <= nd) continue;
          best[ni] = nd; nf[ni] = 0; q.push(ni);
        } else {
          if (curIsRock) continue; // rock blocks: no open ground beyond it, via this path
          const ddx = nx - t.x, ddy = ny - t.y;
          if (ddx * ddx + ddy * ddy > R2) continue; // open ground only to fogDist
          if (best[ni] !== 255) continue;
          best[ni] = 0; nf[ni] = 0; q.push(ni);
        }
      }
    }
  }
  // Half-fog: 1 cell beyond clear, collected first so it cannot
  // cascade into a second, third, … half ring.
  const half = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (nf[i] !== 2) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (nf[ny * W + nx] === 0) { half.push(i); break; }
    }
  }
  for (const i of half) nf[i] = 1;
  // v159: enemy-projectile reveals are permanent and survive the
  // recompute — a cell a red shot passed through stays clear.
  if (S.fogRevealed) for (let i = 0; i < n; i++) if (S.fogRevealed[i]) nf[i] = 0;
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
    placeswap.classList.add('hidden');
    runstats.innerHTML = SURVIVAL
      ? 'Attack <b>' + Math.max(0, Math.round(S.time - FLOOD_GRACE_DUR)) + 's</b> · Level <b>' + S.level + '</b><br>' +
        'Survived <b>' + Math.round(S.time) + 's</b> · ' +
        'Excavated <b>' + S.destroyed + '</b> · ' +
        'Gold <b>' + meta.gold + '</b><br>' +
        'Civilians rescued <b>' + (S.rescue ? S.rescue.rescued : 0) + '/' + (S.rescue ? S.rescue.total : 0) + '</b>'
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
// A flood controller fires single staggered shots from the south
// edge (v166: no storms, no lulls, no waves — one continuous
// attack from 3:00, ramping faster over time), and from 20:00 a
// sweeping cannon joins, also from the south. Flood shots damage
// rock and player territory, and claim what they destroy as flood
// territory (RED internally, blue on screen after the palette
// flip) — so the flood visibly advances as a front the player must
// push back, not a transient event.
// No classes in this codebase (plain functions + S state), so the
// flood is a controller object on S plus these functions.
const SURVIVAL = true; // survival branch: player renders red, flood is blue, enemy base off
const FLOOD_GRACE_DUR = 180; // v183: 3 min grace before the attack starts (was 1 min in v167 — Sam then: the immediate threat is good, make it more immediate; now back to 3 min, Sam 2026-11-10). Prepare your base (XP-bar threat countdown gives the ETA; commander dialog disabled v126)
const FLOOD_SWEEP_START = 1200; // 20 min run time: the sweeping cannon joins the attack (v137, v150: was 10 min, see floodTick)
// Phases (v166, Sam, 2026-11-06 — waves/storms/lulls REMOVED):
// 0–3 min grace, no attack; at 3:00 the attack starts and never
// stops — no storms, no lulls, no breather. Single staggered shots
// from the south only (single columns at random x, like rain, not a
// simultaneous row), at floodWaveInterval(), which ramps from 5s
// and halves every 90s of attack time, floored at 0.1s. From
// 20:00 the sweeping cannon joins, also from the south, also
// continuous. The flood spread still creeps on its own clock the
// whole time, storm or not — waiting it out never worked, and now
// there is nothing to wait out.
// (History: v137 storms + 60s lulls, v146 first storm at grace end,
// v150 sweep at 20:00, v151 starter-side waves, v155 bottom-only,
// v159 staggered waves at 3:00. All of that storm/lull machinery
// was deleted in v166; floodCycleDir is kept only for the harness.)
const FLOOD_DMG = 1;          // per flood projectile — constant barrage, so toned down (was 2)
const FLOOD_SPEED = 8;        // cells/s — slower than player shots (12.5), a lumbering front
const FLOOD_OFF = 3;          // cells outside the map the emitter sits (never seen)
const FLOOD_SWEEP_EVERY = 0.12; // seconds between sweeping-cannon shots
const FLOOD_SWEEP_RATE = Math.PI / 2; // rad/s the sweep rotates (90 deg/s)
// v159 staggered waves (Sam, 2026-11-05; v166: the storm/lull
// cycle is gone, the shots are now the whole attack): wave shots
// are single columns at random south x positions, staggered like rain
// going bottom-up — not a simultaneous row across the whole border.
// Interval starts long (one shot every 5s when the attack starts
// at 3:00) and gets gradually faster as attack time grows: it
// halves every 100 seconds of attack time (v196: was 60s — Sam:
// the 12:00 peak came while the base was still early/mid strength,
// so the ramp is slower now; peak at ~18:00, a couple of minutes
// before the sweep joins at 20:00). 5s at 3:00, 3.3s at 4:00,
// 2.2s at 5:00, 1.4s at 6:00, 0.95s at 7:00, 0.63s at 8:00,
// 0.41s at 9:00, 0.27s at 10:00, 0.12s at 12:00, 0.034s at 15:00,
// floored at 0.01s (~100 shots/s) from about 17:57. There is no
// breather anymore — the ramp is the pressure.
// Napkin math (75-col board): a shot flies north at 8 cells/s and
// dies on the first rock/turret/territory it hits — early on that
// is the cliff after ~40 cells of open ocean/beach, so a shot lives
// ~5s. Concurrent shots ≈ rate × lifetime: ~1 on screen at 3:00,
// ~2 at 5:00, ~3 at 6:00, ~5 at 7:00, ~8 at 8:00, ~12 at 9:00,
// ~18 at 10:00, ~42 at 12:00, ~150 at 15:00, ~500 at 18:00 (and
// more later, as dug channels and flood-painted ground let shots
// fly further). At 100 shots/s over 75 columns, each column takes
// a shot about every 0.75s, so a 20-HP wall cell lasts ~15s of
// fire in its column at the cap.
const FLOOD_WAVE_FIRST_INTERVAL = 5;
const FLOOD_WAVE_MIN_INTERVAL = 0.01;
const FLOOD_WAVE_RAMP_HALF_LIFE = 100; // v196: seconds of attack time to halve the interval (was 60 — peak now at ~18:00, not ~12:00)
function floodWaveInterval() {
  const t = Math.max(0, S.time - FLOOD_GRACE_DUR);
  return Math.max(FLOOD_WAVE_MIN_INTERVAL,
    FLOOD_WAVE_FIRST_INTERVAL * Math.pow(0.5, t / FLOOD_WAVE_RAMP_HALF_LIFE));
}
const FLOOD_WAVE_SPEED_JITTER = 0.15; // wave speed randomisation, ±15% (v140): the line breaks up as faster shots outrun slower ones, instead of staying perfect
const FLOOD_SPREAD_EVERY = 2; // seconds between gradual-spread ticks
// Pressure (v110): base chance per flood cell per spread tick, AFTER
// picking a valid target (see floodSpread). Retuned 0.1 -> 0.04: the old
// pick-then-filter wasted most rolls on invalid directions (self, rock,
// out of bounds), so removing those wastes speeds spread ~3x; lowering
// the base keeps average frontier pace similar while redistributing
// growth toward bottlenecks (see PRESSURE_BONUS_PER_SOLID).
const FLOOD_SPREAD_CHANCE = 0.04;
// Per solid neighbor of the growth target (rock, grey, player territory,
// map edge, unit — NOT flood, NOT empty), chance multiplier bonus.
// A corridor target boxed in by walls rolls much higher than an open
// target, so flood punches through chokes fast and fans out slowly.
const PRESSURE_BONUS_PER_SOLID = 0.25;
const FLOOD_DIRS = ['north', 'south', 'west', 'east']; // edge the flood comes FROM
// Rescue (v112): 3 sites in random cave pockets, 1-5 civilians each
// (capped by pocket size — a 2-cell pocket holds 2, not 5). Civilians
// wait, hidden by fog, until their cell clears, then walk home 1 cell
// per second (Harvester pace) to the nearest Cannon or Outpost. They
// never die in v112 (flood can trap them, painting them back out frees
// them) — death/stakes are a later tuning call, not a v112 mechanic.
// v177: 3 rescue sites per biome — v199: four land biomes (dirt,
// mountain, grass, desert), 12 total — so a run forces you to
// climb through every biome to find them all. Ocean/coast cells
// never hold a site.
const RESCUE_SITES_PER_BIOME = 3;
const RESCUE_BIOMES = ['dirt', 'mountain', 'grass', 'desert'];
const BIOME_NAMES = { dirt: 'Dirt', mountain: 'Mountain', grass: 'Grass', desert: 'Desert' };
const CIV_MIN = 1;
const CIV_MAX = 5;
const CIV_STEP_DUR = 1.0; // seconds per civilian step — slow on purpose, like Harvester
const CIV_PINK = '#f472b6'; // civilian blob + minimap ? + rescue burst, one pink everywhere
const CIV_SETTLE_RADIUS = 2; // Manhattan distance from a base at which a civilian is collected (v113: settle spot; v165: collection trigger — same spot, the civilian flies away instead of staying)
// Meteor shower (v116, v126 interval doubled in frequency): a periodic reshuffling event to liven up the
// quiet first minute — and every 1–2 minutes after, even during
// the attack. Sequence: 10s warning (toast countdown + yellow circles
// on the minimap for every target), then shadows appear one by one,
// staggered, each shrinking from large to small, then impact.
// Impact, per cell in a circular cluster (radius 2, 13 cells):
//   EMPTY (no turret/civilian/idle coin) -> strong grey rock (80 HP,
//     shade 5, consistent with the grey HP/shade curve) — a boulder in
//     a cleared cave, clearable later for grey rewards (guaranteed
//     pickup, 80% gold / 20% XP, same as any grey rock).
//   WHITE/GREY terrain -> 10 damage (brown, HP <= 10, is wiped out to a
//     hole; grey, HP 30–100, is only chipped). No drops, no nugget
//     release — like flood destruction, the meteor does not pay.
//   BLUE/RED territory -> bombed to EMPTY (a hole in the base/flood).
//   Living turret on the cell -> 3 damage, cell unchanged (turret
//     protects its pad; full-HP units all survive: min unit HP is 4
//     (Field/Outpost), so 3 never one-shots a healthy unit — a unit
//     already at <= 3 HP can still be finished off, like any damage).
//   Civilian cell -> skipped entirely (civilians never die, never buried).
//   EMPTY cell with an idle coin -> skipped (coin would be buried and
//     uncollectible; it stays, the cluster just has a gap there).
// v171: no toast anymore (Sam: the banner countdown was noise) — the
// warning is the minimap rings for the full 10s, and the main-map
// rings only in the last 5s (METEOR_WORLD_WARN_DUR), so the map stays
// readable until impact is near. meteorTick never touches wavebanner.
const METEOR_WARN_DUR = 10; // seconds of minimap markers before the shower
const METEOR_WORLD_WARN_DUR = 5; // seconds before impact the main-map rings appear
const METEOR_INTERVAL_MIN = 60; // 1 minute, random up to (v126: was 2 min — Sam wanted showers more frequent)
const METEOR_INTERVAL_MAX = 120; // 2 minutes between showers (warning start to warning start)
const METEOR_STAGGER = 0.7; // seconds between shadow appearances, one by one
const METEOR_SHADOW_DUR = 1.2; // seconds a shadow shrinks from large to impact
const METEOR_SHADOW_R0 = 2.5; // cells, initial shadow radius
const METEOR_SHADOW_R1 = 0.4; // cells, final shadow radius at impact
const METEOR_CLUSTER_R2 = 4; // squared radius: dx*dx + dy*dy <= 4 (radius 2, 13 cells)
const METEOR_TERRAIN_DMG = 10;
const METEOR_UNIT_DMG = 3;
const METEOR_ROCK_HP = 20; // v171: was 80 — a landed rock took 80 cannon/flood hits to clear, like the old 200-HP walls; Sam: same as walls now (20)
const METEOR_ROCK_SHADE = 5;
// dir: 0 = from top, 1 = from bottom, 2 = from left, 3 = from right.
// The emitter is a single point just outside the map on that edge —
// never seen, only its effects creeping in. v155 bottom-only
// (supersedes v132 cycling): the sweep emitter is always on the
// south edge, at a random x along it each storm. No cycling, no
// second front from another side after 20:00 — the flood always
// comes from below, like the waves.
function floodPickDir(f, rng) {
  const W = cfg.cols, H = cfg.rows;
  f.dir = 1; // south, always
  f.ex = rng() * W; f.ey = H + FLOOD_OFF;
}
// v166: storms are gone, so nothing in the game calls this anymore
// (the harness still exercises it). Kept so the south-emitter rule
// stays in one place: same south edge, new random x along it.
function floodCycleDir(f, rng) {
  const W = cfg.cols, H = cfg.rows;
  f.dir = 1; // south, always
  f.ex = rng() * W; f.ey = H + FLOOD_OFF;
}
// v151: the map edge nearest (x, y), in FLOOD_DIRS order
// (north, south, west, east) on ties. The starter cannon sits on a
// beach facing inland, so its nearest edge is the side behind it —
// the side the single-side waves come from.
function starterSideDir(x, y) {
  const dN = y, dS = cfg.rows - 1 - y, dW = x, dE = cfg.cols - 1 - x;
  let dir = 0, best = dN;
  if (dS < best) { dir = 1; best = dS; }
  if (dW < best) { dir = 2; best = dW; }
  if (dE < best) { dir = 3; best = dE; }
  return dir;
}
function floodInit(seed) {
  const f = { dir: 1, ex: 0, ey: 0, phase: 'grace', timer: FLOOD_GRACE_DUR,
              sweep: 0, waveT: 0, sweepT: 0, storms: 0, spreadT: FLOOD_SPREAD_EVERY, cycle: 1, starterDir: 1 }; // v155: south, always
  const rng = mulberry32(seed + 99991);
  floodPickDir(f, rng);
  // Third call on the seeded stream, so the first storm's dir +
  // position are unchanged for a given seed; cycle direction is
  // decided once here and never re-rolled.
  f.cycle = rng() < 0.5 ? 1 : -1;
  return f;
}
// Gradual, bloom-like spread with pressure (v110): each flood cell
// collects its valid adjacent EMPTY targets first (filter-then-pick,
// no wasted picks on self/rock/out-of-bounds), picks one at random,
// then rolls with a confinement bonus: the more solid neighbors the
// target has (rock, grey, player territory, map edge, unit — not flood,
// not empty), the higher the chance. So a corridor target boxed in by
// walls grows fast, while an open target with many escape routes grows
// slow — flow forced through a small opening moves faster than a mass
// spreading into empty space. 4 increments (same GROW_STEPS as bloom)
// → flood, fresh and weak (HP 1). No pickup — flood never pays.
// Runs always (storm or lull): the flood creeps even between storms,
// so waiting it out doesn't work.
function floodSpread() {
  const W = cfg.cols, H = cfg.rows;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (S.cells[i] !== RED) continue;
      // Valid targets first: EMPTY, not finished, growing for flood
      // (or unclaimed), unoccupied. No valid target -> no attempt.
      const targets = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (S.cells[ni] !== EMPTY || S.growN[ni] >= GROW_STEPS) continue;
          if (S.growBy[ni] !== 0 && S.growBy[ni] !== RED) continue;
          if (turretAt(nx, ny)) continue;
          targets.push(ni);
        }
      }
      if (!targets.length) continue;
      const ni = targets[Math.floor(Math.random() * targets.length)];
      const nx = ni % W, ny = Math.floor(ni / W);
      // Confinement: solid neighbors of the target (rock/grey/player
      // territory, map edge, unit). Flood and empty don't count.
      let solid = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const mx = nx + dx, my = ny + dy;
          if (mx < 0 || my < 0 || mx >= W || my >= H) { solid++; continue; }
          if (turretAt(mx, my)) { solid++; continue; }
          const mc = S.cells[my * W + mx];
          if (mc !== EMPTY && mc !== RED) solid++;
        }
      }
      const chance = FLOOD_SPREAD_CHANCE * (1 + solid * PRESSURE_BONUS_PER_SOLID);
      if (Math.random() >= chance) continue;
      S.growN[ni]++;
      S.growBy[ni] = RED;
      S.growT[ni] = S.time;
      if (S.growN[ni] >= GROW_STEPS) {
        S.cells[ni] = RED;
        S.hp[ni] = 0; S.maxhp[ni] = 0; S.harvT[ni] = 0; // no HP on flood
        S.growN[ni] = 0; S.growBy[ni] = 0;
        if (S.noHarvest) S.noHarvest[ni] = 0;
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
// One flood shot at angle (radians) from the sweep emitter — culled
// if its ray never reaches the map. Returns true when a shot was spawned.
function floodFireAt(angle, ex, ey) {
  const f = S.flood;
  const sx = ex === undefined ? f.ex : ex, sy = ey === undefined ? f.ey : ey;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const e = floodEntry(sx, sy, dx, dy);
  if (!e) return false;
  S.projs.push({ x: e.x, y: e.y, vx: dx * FLOOD_SPEED, vy: dy * FLOOD_SPEED,
                 color: RED, dmg: FLOOD_DMG, flood: true, crit: false, dead: false });
  return true;
}
// Border wave (v140, replaces the radial rings of v137): the whole
// Does a straight inward ray from a border cell reach actual land?
// Step cell by cell inward: land is a cell that is none of
// ocean/beach/grass (the interior: rock, cave, territory, etc.), or
// a cell with a living turret (a coastal turret is still a target).
// A ray that only ever crosses ocean/beach/grass — e.g. the west
// edge at the top-left corner shooting right across the top ocean
// band to the right side, or a ray sliding along a coast band —
// never reaches land, so it is culled (v141, Sam). Without coast
// flags (synthetic tests), assume it reaches land rather than
// culling everything.
function floodWaveReachesLand(cx, cy, dx, dy) {
  if (!S.ocean || !S.beach || !S.grass) return true;
  let x = cx, y = cy;
  while (x >= 0 && y >= 0 && x < cfg.cols && y < cfg.rows) {
    if (turretAt(x, y)) return true;
    const i = y * cfg.cols + x;
    if (!S.ocean[i] && !S.beach[i] && !S.grass[i]) return true;
    x += dx; y += dy;
  }
  return false;
}
// Border wave (v140, v141 culling + attack-only, v151 single side):
// v140–v150 the whole border spawned at once, one projectile per
// border cell that reaches land, travelling straight inward — north
// edge south, south edge north, west edge east, east edge west,
// corners twice (once per edge direction). v151: waves come only
// from the starter side (S.flood.starterDir, the map edge nearest
// the starter at run start — the side behind you, since the starter
// faces inland). The spawn code is unchanged — one projectile per
// border cell on that edge, culling, speed jitter, attack-only —
// just restricted to one edge, so a corner cell on that edge now
// spawns once, not twice, and the erosion rate on that side is
// unchanged (a wave every 1.2s from that side, as before); the
// other three sides get no waves at all, so inland caves survive
// longer and the mission becomes rescuing civilians before the
// front erodes in from behind. The sweep is NOT changed: it still
// cycles and still joins at 20 min, so after 20 min there is a
// second front. If starterDir is unknown (synthetic flood objects
// in tests), fall back to all four sides, as before.
// v141: wave shots are attack-only, NOT flood shots (flood: false):
// they leave no flood paint trail on EMPTY ground, they bomb blue
// territory to EMPTY instead of claiming it as flood, and a broken
// rock stays EMPTY instead of becoming flood. They still damage
// rock (1, dies on the first rock it hits), damage turrets, and
// pass through existing flood territory — so each wave erodes the
// shoreline without painting it flood. The sweep, by contrast, is
// still a flood shot and still paints/claims.
function floodFireWave() {
  // v159 staggered: one shot per call, from a random south x, straight
  // north — like a single rain column, not a border-wide row. Try up
  // to 10 random columns and fire the first whose ray reaches land
  // (floodWaveReachesLand culls rays that never reach land, e.g. a
  // column that is all ocean/coast to the top), so the cadence stays
  // close to floodWaveInterval() instead of skipping on ocean columns.
  // Attack-only, as before (flood: false): no paint trail, bombs BLUE
  // territory to EMPTY, dies on the first rock it hits.
  const W = cfg.cols, H = cfg.rows;
  for (let k = 0; k < 10; k++) {
    const x = Math.floor(Math.random() * W);
    if (!floodWaveReachesLand(x, H - 1, 0, -1)) continue;
    const speed = FLOOD_SPEED * (1 + (Math.random() * 2 - 1) * FLOOD_WAVE_SPEED_JITTER);
    S.projs.push({ x: x + 0.5, y: H - 0.05, vx: 0, vy: -speed,
                   color: RED, dmg: FLOOD_DMG, flood: false, crit: false, dead: false });
    return;
  }
}
function floodTick(dt) {
  const f = S.flood;
  if (!f || S.runOver) return;
  // Gradual spread ticks always, on its own clock.
  if (f.spreadT === undefined) f.spreadT = FLOOD_SPREAD_EVERY;
  f.spreadT -= dt;
  if (f.spreadT <= 0) { f.spreadT += FLOOD_SPREAD_EVERY; floodSpread(); }
  f.timer -= dt;
  if (f.phase === 'grace') {
    // Grace: prepare your base. No attack, no toast — the XP bar
    // threat countdown gives the ETA during grace. Spread no-ops
    // here (no RED cells exist yet, so floodSpread finds nothing).
    wavebanner.classList.add('hidden'); // no stale toast
    if (f.timer <= 0) {
      // v166: grace over = the attack starts, and it never stops.
      // No storm, no lull, no breather — the grace threat countdown
      // was the only warning. Direction was already picked at init,
      // so shots fire at once.
      f.phase = 'attack';
      f.sweep = 0; f.waveT = 0; f.sweepT = 0; // fire immediately
      f.storms++;
      wavebanner.classList.add('hidden'); // attack: no toast (flood visible)
    }
    return;
  }
  // Attack (v166): continuous, no phases after this. Staggered
  // single shots from the south at floodWaveInterval() — the ramp
  // is the pressure now, not a storm cycle. From 20:00 run time
  // the sweeping cannon joins, also continuous, also from the south.
  // No banner and no pulse while it runs: the flood is visible on
  // the minimap as blue territory creeping in. While gated off, the
  // sweep angle and timer are left alone, so the first sweep shot
  // fires as soon as the gate opens.
  if (S.time >= FLOOD_SWEEP_START) {
    f.sweepT -= dt;
    if (f.sweepT <= 0) { f.sweepT += FLOOD_SWEEP_EVERY; floodFireAt(f.sweep); }
    f.sweep += FLOOD_SWEEP_RATE * dt;
  }
  f.waveT -= dt;
  // v172: while, not if — once the interval drops below one frame
  // (~16.7ms at 60fps), a single shot per frame would cap the rate
  // at ~60/s no matter how low the floor goes. The loop fires every
  // shot the elapsed time owes, so the 0.01s floor really means
  // ~100/s. At most ~5 shots per frame (dt clamps at 0.05s).
  while (f.waveT <= 0) { f.waveT += floodWaveInterval(); floodFireWave(); }
}

// Meteor shower (v116): periodic terrain reshuffle, even during the
// attack. Runs after floodTick in update(). The 10s warning is
// minimap rings only (v171: the banner countdown toast is gone),
// and the main-map rings join in the last 5s.
// Paused/finished runs freeze it (update() only runs when playing).
function meteorNextInterval() {
  return METEOR_INTERVAL_MIN + Math.random() * (METEOR_INTERVAL_MAX - METEOR_INTERVAL_MIN);
}
function meteorTargets() {
  // Count scales with map area: 1–1.5 per 1728 cells (v199: was
  // 2–3 — Sam: half the density, the showers were leaving too
  // many holes/walls over time. v171 was 3–5 since v129 — but maps
  // are now ~12k cells, not the 3750-cell 75x50 the old density
  // was tuned for, so showers had grown to 20–45 meteors; Sam:
  // reduce a bit, keep it density-based so it scales with map
  // size). Now ~7–13 on a current map. Positions are uniform —
  // anywhere, including fog, starter area, and flood territory —
  // except the ocean (v166, Sam: a meteor ADD in the ocean drops
  // a rock that blocks the flood shots coming from the south,
  // gutting the threat — and meteors are strong early).
  // Retry up to 20 times for a non-ocean cell; if the map is
  // (nearly) all ocean, that target is skipped.
  const area = cfg.cols * cfg.rows;
  const base = 1 + Math.floor(Math.random() * 2) * 0.5; // 1 or 1.5 (half of the old 2 or 3)
  const n = Math.max(1, Math.round(area / 1728 * base));
  const out = [];
  for (let k = 0; k < n; k++) {
    let tx = -1, ty = -1;
    for (let tries = 0; tries < 20; tries++) {
      const x = Math.floor(Math.random() * cfg.cols);
      const y = Math.floor(Math.random() * cfg.rows);
      if (S.ocean && S.ocean[y * cfg.cols + x]) continue;
      tx = x; ty = y; break;
    }
    if (tx < 0) continue;
    out.push({ x: tx, y: ty, state: 'pending', shadowT: 0 });
  }
  return out;
}
function meteorTick(dt) {
  const m = S.meteor;
  if (!m || S.runOver) return;
  if (m.phase === 'idle') {
    m.timer -= dt;
    if (m.timer <= 0) {
      m.phase = 'warn';
      m.timer = METEOR_WARN_DUR;
      m.targets = meteorTargets();
      m.idx = 0; m.stagger = 0;
    }
    return;
  }
  if (m.phase === 'warn') {
    m.timer -= dt;
    // v171: no toast — the warning is minimap rings (full 10s) plus
    // main-map rings in the last 5s (see render). Nothing writes
    // wavebanner here anymore.
    if (m.timer <= 0) {
      m.phase = 'shower';
      m.idx = 0; m.stagger = 0;
      // v127: stagger scales so a shower still lasts ~21s on huge
      // maps — with the old fixed 0.7s, a 200x200 map's ~200 targets
      // would rain for over 2 minutes. Fallback to the fixed stagger
      // when a shower object was built directly (harness).
      m.staggerDur = Math.min(METEOR_STAGGER, 21 / Math.max(1, m.targets.length));
    }
    return;
  }
  // Shower: shadows appear one by one, staggered, each shrinking to impact.
  m.stagger -= dt;
  if (m.stagger <= 0 && m.idx < m.targets.length) {
    m.targets[m.idx].state = 'shadow';
    m.targets[m.idx].shadowT = 0;
    m.idx++;
    m.stagger = m.staggerDur || METEOR_STAGGER;
  }
  let done = true;
  for (const t of m.targets) {
    if (t.state === 'shadow') {
      t.shadowT += dt;
      if (t.shadowT >= METEOR_SHADOW_DUR) {
        t.state = 'done';
        meteorImpact(t.x, t.y);
      } else {
        done = false;
      }
    } else if (t.state !== 'done') {
      done = false;
    }
  }
  if (done && m.idx >= m.targets.length) {
    m.phase = 'idle';
    m.timer = meteorNextInterval();
    m.targets = [];
    m.idx = 0; m.stagger = 0;
  }
}
// One meteor impact (v142, Sam: one add/subtract effect per meteor,
// not per-cell): first count the circular cluster around (tx, ty)
// (radius 2, 13 cells, in-bounds only) by cell state — EMPTY vs
// WHITE/GREY/BLUE/RED, regardless of turret/civilian/coin on top.
// Mostly empty (empty > non-empty, tie goes to carve) -> ADD: the
// whole area becomes landed rock (GREY, 20 HP, shade 5, clearable
// later for normal grey rewards). Mostly not empty -> CARVE: every
// non-empty cell is removed to EMPTY, and no rock is placed anywhere
// in the cluster. Protections from before are kept in both modes,
// as gaps in the effect: civilian cells are skipped whole (civilians
// never die, never get buried), living turrets take 3 damage and
// their ground is left unchanged (a turret pad is never buried),
// and EMPTY cells holding an idle coin are skipped in ADD mode
// (a coin buried in rock would be uncollectible). In CARVE mode an
// idle-coin cell is EMPTY anyway, so it stays EMPTY with its coin.
// Drops (v145): ADD mode still pays nothing — a nugget on a
// converted cell is lost with no free coin, like flood destruction.
// CARVE mode pays like a BLUE cannon break, terrain only: regular
// brown WHITE drops XP 30%, else gold 10% (never both); a nugget
// WHITE drops only its guaranteed gold (no XP roll, v190); GREY
// drops the XP roll plus a guaranteed 80% gold / 20% XP pickup. Territory
// (BLUE/RED) carved to EMPTY pays nothing, exactly as a cannon
// bombing territory pays nothing — territory pays on harvest, not
// on destruction. Fog is recomputed once, after all cells, not per cell.
// Push one idle coin, with the same 800-coin safety valve damageBlock
// uses (drop the oldest idle coin when full).
function pushIdleCoin(cx, cy, kind) {
  S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind,
                 phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
  if (S.coins.length > 800) {
    const i = S.coins.findIndex(c => c.state === 'idle');
    if (i >= 0) S.coins.splice(i, 1);
  }
}
function meteorImpact(tx, ty) {
  const cluster = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx * dx + dy * dy > METEOR_CLUSTER_R2) continue;
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= cfg.cols || y >= cfg.rows) continue;
      // v166: the ocean is untouched by meteors — a rock dropped
      // in the ocean would block the flood shots from the south.
      // Ocean cells are not in the cluster at all, so they neither
      // count toward the add/carve decision nor get changed.
      if (S.ocean && S.ocean[y * cfg.cols + x]) continue;
      cluster.push({ x, y, idx: y * cfg.cols + x });
    }
  }
  let emptyCount = 0;
  for (const c of cluster) if (S.cells[c.idx] === EMPTY) emptyCount++;
  const add = emptyCount > cluster.length - emptyCount; // mostly empty; tie -> carve
  let changed = false;
  for (const c of cluster) {
    const { x, y, idx } = c;
    // Civilians never die and never get buried: skip their cell whole.
    if (S.rescue && (S.rescue.civilians || []).some(cv => cv.x === x && cv.y === y)) continue;
    // Living turret on the cell: damage the unit, leave its ground alone
    // (burying a turret pad in rock would break fog flood-fill from it).
    const tur = S.turrets.find(t => !t.dead && t.x === x && t.y === y);
    if (tur) {
      damageTurret(tur, METEOR_UNIT_DMG, RED);
      spawnBurst(x + 0.5, y + 0.5, '#ffd75e'); // meteor flash on the unit
      continue;
    }
    const cell = S.cells[idx];
    if (add) {
      // ADD: whole area to rock, except the idle-coin gap above.
      if (cell === EMPTY && (S.coins || []).some(co => co.state === 'idle' && Math.floor(co.x) === x && Math.floor(co.y) === y)) continue;
      if (cell === GREY && S.hp[idx] === METEOR_ROCK_HP && S.shade[idx] === METEOR_ROCK_SHADE && S.growN[idx] === 0) {
        // Already exactly the landed rock: no change, no burst spam.
        // (Still clear a nugget? No — a landed rock has no nugget by
        // construction, and this branch only fires when it already is one.)
        continue;
      }
      S.cells[idx] = GREY;
      S.hp[idx] = METEOR_ROCK_HP; S.maxhp[idx] = METEOR_ROCK_HP;
      S.shade[idx] = METEOR_ROCK_SHADE;
      S.hitBy[idx] = 0; S.goldNug[idx] = 0;
      S.growN[idx] = 0; S.growBy[idx] = 0;
      if (S.noHarvest) S.noHarvest[idx] = 0;
      spawnBurst(x + 0.5, y + 0.5, CELL_COLORS[GREY]); // grey dust per new rock
      changed = true;
    } else {
      // CARVE: non-empty cells to EMPTY, no rock placed anywhere.
      if (cell === EMPTY) continue;
      const wasCell = cell, wasNugget = !!S.goldNug[idx], wasGrey = cell === GREY;
      S.cells[idx] = EMPTY;
      S.hp[idx] = 0; S.maxhp[idx] = 0;
      S.goldNug[idx] = 0;
      S.growN[idx] = 0; S.growBy[idx] = 0;
      if (S.noHarvest) S.noHarvest[idx] = 0;
      if (wasCell === WHITE || wasCell === GREY) S.destroyed++;
      // v145: terrain carved here pays exactly like a BLUE cannon
      // break (same rolls as damageBlock, same order). Territory
      // pays nothing — the if below is terrain-only on purpose.
      if (wasCell === WHITE || wasCell === GREY) {
        if (wasNugget) pushIdleCoin(x, y, 'gold'); // nugget's guaranteed gold
        let xpDropped = false;
        // v190: nuggets drop only their guaranteed gold — no XP roll.
        if (!wasNugget && Math.random() < cfg.coinChance) { pushIdleCoin(x, y, 'xp'); xpDropped = true; }
        if (!wasGrey && !wasNugget && !xpDropped && Math.random() < BROWN_GOLD_CHANCE) pushIdleCoin(x, y, 'gold');
        if (wasGrey) pushIdleCoin(x, y, Math.random() < GREY_GOLD_CHANCE ? 'gold' : 'xp');
      }
      spawnBurst(x + 0.5, y + 0.5, CELL_COLORS[wasCell]);
      changed = true;
    }
  }
  if (changed) computeFog();
}

// Debug only: jump the run clock to the end of grace (3:00) and start
// the attack immediately (v166: no storms anymore — fire at once,
// toast hidden, attack counted once). Run time only moves forward,
// never backwards, so clicking mid-attack restarts it without
// inflating the count. Paused/placing/teleport state is left
// untouched: time is frozen while paused anyway, so the attack fires
// once play resumes. No-op if there is no flood or the run is over
// (the debug panel sits under the run-over overlay anyway).
function debugJumpToFlood() {
  const f = S.flood;
  if (!f || S.runOver) return;
  if (S.time < FLOOD_GRACE_DUR) S.time = FLOOD_GRACE_DUR;
  if (f.phase !== 'attack') f.storms++;
  f.phase = 'attack';
  f.sweep = 0; f.waveT = 0; f.sweepT = 0;
  wavebanner.classList.add('hidden');
  updateHud();
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
    paintLeft: (w && w.penDepth) || 1, // penetration left (max): rock cells it can still damage + flood cells it can still flip, each step 50% chance to continue
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
    // v186: the Laser is a shield now (Sam: repurpose it to shoot
    // down enemy projectiles). Each shot clears every RED projectile
    // within the shield radius of the Laser (base 3, +1 per Shield
    // pick). It no longer paints flood — the Painter cannon does
    // that job. A pulse ring shows the shield sweeping on every
    // shot; a beam + burst mark the farthest kill. (weakestFlood is
    // gone with the painting job — the Laser has no flood target
    // anymore.)
    const r = laserShieldRadius();
    const cx = t.x + 0.5, cy = t.y + 0.5;
    let kills = 0, fx = 0, fy = 0, fd = -1;
    for (const p of S.projs) {
      if (p.dead || p.color !== RED) continue;
      const dx = p.x - cx, dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) {
        p.dead = true;
        kills++;
        if (d2 > fd) { fd = d2; fx = p.x; fy = p.y; }
      }
    }
    // v195: the ring only appears when the laser actually fires,
    // and on survival it only fires on a target (reactive), so a
    // ring now means it shot something down.
    S.rings.push({ x: cx, y: cy, t: 0, css: CELL_COLORS[t.color], dead: false });
    if (kills > 0) {
      S.beams.push({ x1: cx * CELL_PX, y1: cy * CELL_PX,
                     x2: fx * CELL_PX, y2: fy * CELL_PX, t: 0 });
      spawnBurst(fx, fy, CELL_COLORS[t.color]);
    }
    return;
  }
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
    if (S.noHarvest) S.noHarvest[bi] = 0; // Field-grown: harvests
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
// v166: an idle coin is hidden by fog — invisible and uncollectible
// while its cell is fogged (fog 1 half-fog hides it too; only fully
// clear cells show their resources). Flying/gathering coins are
// already being banked, so they still render and still grant. The
// fog x-ray debug (fogHidden) counts as clear, like everywhere else.
// Two deliberate exceptions keep shining through fog: meteor warning
// rings and rescue ? marks (they are warnings, not resources).
function coinFogged(c) {
  if (c.state !== 'idle') return false;
  if (fogHidden) return false;
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) return false;
  return S.fog[cy * cfg.cols + cx] !== 0;
}

function stepProjectile(p, dt) {
  const dist = Math.hypot(p.vx, p.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.4)); // sub-step so fast shots can't tunnel
  let sx = (p.vx * dt) / steps, sy = (p.vy * dt) / steps;
  for (let s = 0; s < steps; s++) {
    p.x += sx; p.y += sy;
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) { p.dead = true; return; }
    // v159: enemy projectiles reveal the fog as they fly — the cell
    // the shot is in clears immediately and stays clear (see
    // fogRevealed in computeFog). v187: on survival, player (BLUE)
    // cannon shots reveal too (Sam: cannon projectiles clear fog
    // the same way enemy projectiles do) — so the sweep of your own
    // cannon opens up the map ahead of it. On main the old rule
    // stands (RED only), so the frozen war prototype is untouched.
    // v167: one cell either side of the channel is half-fog (fog 1),
    // like the fringe computeFog draws around discovered terrain —
    // so the reveal reads as a soft corridor, not a hard 1-cell
    // line. The fringe is set on the 4 orthogonal neighbours (the
    // two on the line itself are already clear or about to be);
    // neighbours are NOT marked fogRevealed, or the next computeFog
    // would force them fully clear. Fog only ever clears (see the
    // merge in computeFog), so the fringe sticks until a turret's
    // own fog disc clears it properly.
    if (SURVIVAL || p.color === RED) {
      const ridx = cy * cfg.cols + cx;
      if (S.fogRevealed) S.fogRevealed[ridx] = 1;
      S.fog[ridx] = 0;
      const W = cfg.cols, H = cfg.rows;
      const fringe = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of fringe) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nidx = ny * W + nx;
        if (S.fog[nidx] === 2) S.fog[nidx] = 1;
      }
    }
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
      // Same-cell re-hit guard: a piercing shot stays inside one rock
      // cell for several sub-steps / frames; only the first sub-step in
      // a new rock cell damages it, otherwise one shot would drain its
      // whole penetration budget on a single cell.
      if (p.lastRockIdx === idx) continue;
      p.lastRockIdx = idx;
      const destroyed = damageBlock(idx, p.dmg || 1, p.color, p.x, p.y, p.vx, p.vy, p.crit);
      // Penetration (shared budget with flood painting): each rock hit
      // consumes 1 paintLeft. Budget left -> roll PENETRATE_CHANCE to
      // keep flying straight (pierce), whether the rock broke or just
      // took damage. Budget spent, or the roll fails -> dies (no
      // ricochet anymore — Penetration replaced Bounce in v106).
      if (p.paintLeft === undefined) p.paintLeft = 1; // base depth for shots without it
      p.paintLeft--;
      if (destroyed) {
        // Flood claim: a flood shot that breaks rock takes the cell
        // (the flood advances as it destroys). No HP: flood is just
        // a uniform color to paint, not a rock to chip.
        if (p.flood) {
          S.cells[idx] = p.color;
          S.hp[idx] = 0; S.maxhp[idx] = 0; S.harvT[idx] = 0;
          S.growN[idx] = 0; S.growBy[idx] = 0;
          if (S.noHarvest) S.noHarvest[idx] = 0;
        }
        if (p.paintLeft > 0 && !p.flood && Math.random() < PENETRATE_CHANCE) continue; // broke through and rolled to keep going
        p.dead = true; return;
      }
      if (p.paintLeft > 0 && Math.random() < PENETRATE_CHANCE) continue; // pierced (damaged, intact) and rolled to keep going
      p.dead = true;
      return;
    }
    if (cell === EMPTY) {
      p.lastRockIdx = -1;
      // Paint trail (v113, survival only; gated on Damage EVO in v114):
      // a shot paints open ground as it flies — player cannon paints
      // player color ONLY once Damage is evolved to Painter, storm
      // paints flood color always — free, no paintLeft cost (it's a
      // trail, not a depth budget), and the shot keeps flying. Only
      // player shots (BLUE, Painter-evolved) and flood shots (p.flood)
      // paint — enemy-cannon shots (RED, not flood, which don't exist
      // in survival play, only in tests) pass through empty as before,
      // so red excavation still leaves empty ground, not flood color.
      // Growing cells are left alone (growN > 0): Field growth completes
      // to harvestable territory, flood spread completes to flood,
      // instead of being stolen mid-growth. No burst per painted cell
      // (a burst every cell would spam particles) — the trail itself
      // is the visual. Shading is automatic: colored cells render with
      // elevation shades, exactly like field cells. Player paint is
      // weaker-harvest (v114: 10% vs Field 30%, see harvest loop);
      // flood paint is RED, which never harvests on survival anyway.
      const canPaintBlue = p.color === BLUE && S.weapons.cannon && S.weapons.cannon.evoPaint;
      if (SURVIVAL && (canPaintBlue || p.flood) && S.growN[idx] === 0) {
        S.cells[idx] = p.color;
        S.hp[idx] = 0; S.maxhp[idx] = 0; S.harvT[idx] = 0;
        S.growN[idx] = 0; S.growBy[idx] = 0;
        if (S.noHarvest) S.noHarvest[idx] = (p.color === BLUE && !p.flood) ? 1 : 0;
      }
      continue; // left rock: a later re-entry hits again
    }
    if (cell === p.color) { p.lastRockIdx = -1; continue; } // own color: pass through
    if (SURVIVAL && cell === RED && !p.flood) {
      // Player shot vs flood: PAINTS it (flips to player color,
      // instant, no HP). Penetration: the shot keeps flying, painting
      // up to paintLeft cells in its path (rock hits share this same
      // budget), each step beyond the first rolling PENETRATE_CHANCE
      // to continue (v106), then dies on budget spent or roll failed.
      // Empty/own-color pass through.
      // No damage number: it's a flip, not damage — just a paint burst
      // in the new color. Painted territory harvests like field-grown
      // territory (fresh harvT, no leftover flood growth).
      p.lastRockIdx = -1;
      S.cells[idx] = p.color;
      S.growN[idx] = 0; S.growBy[idx] = 0; S.harvT[idx] = 0;
      S.hp[idx] = 0; S.maxhp[idx] = 0; // no HP on colored cells anymore
      if (S.noHarvest) S.noHarvest[idx] = 0; // flipped flood: harvests like field (v97)
      spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[p.color]);
      if (p.paintLeft === undefined) p.paintLeft = 1; // base depth for shots without it
      p.paintLeft--;
      if (p.paintLeft <= 0) { p.dead = true; return; } // max depth reached, no roll needed
      if (Math.random() >= PENETRATE_CHANCE) { p.dead = true; return; } // roll failed: stop early, budget remains
      continue; // rolled to keep painting
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
    if (S.noHarvest) S.noHarvest[idx] = 0;
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
  spawnDmgNum(cx + 0.5, cy + 0.2, dmg, crit); // every hit shows damage dealt, killing or not
  if (S.hp[idx] > 0) {
    return false;
  }
  const wasGrey = S.cells[idx] === GREY;
  const wasNugget = !!S.goldNug[idx];
  S.cells[idx] = EMPTY; // excavated: the block is gone, not painted over
  if (S.noHarvest) S.noHarvest[idx] = 0;
  S.destroyed++;
  if (color === BLUE) S.destroyedBlue++;
  computeFog(); // excavation recomputes unit light (fog only clears, so this is a no-op unless a unit moved since the last call)
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
  let xpDropped = false;
  // v190: nugget cells drop only their guaranteed gold — no XP roll
  // (Sam: breaking a nugget should pay gold, not XP).
  if (color === BLUE && !wasNugget && Math.random() < cfg.coinChance) {
    xpDropped = true;
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind: 'xp',
                   phase: Math.random() * 6.283, sx: 0, sy: 0, t: 0, dead: false });
    if (S.coins.length > 800) { // safety valve: drop oldest idle coin
      const i = S.coins.findIndex(c => c.state === 'idle');
      if (i >= 0) S.coins.splice(i, 1);
    }
  }
  // v130, Sam: no double drops on brown. Gold is only rolled if the
  // XP roll above failed, so a regular brown break drops at most
  // one coin: XP 30%, else gold 10% of the remaining 70% = 7%
  // effective, else nothing 63%. Nugget cells keep their guaranteed
  // gold only (no XP roll since v190); grey keeps its 80/20
  // guaranteed pickup below. Red/flood breaks pay nothing. (Grey
  // can still drop 2 coins — guaranteed + XP roll.)
  if (color === BLUE && !wasGrey && !wasNugget && !xpDropped && Math.random() < BROWN_GOLD_CHANCE) {
    S.coins.push({ x: cx + 0.5, y: cy + 0.5, state: 'idle', kind: 'gold',
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
// draws from stat cards (one per weapon stat), Gold Ore, and steer.
// `needs` gates an upgrade on owning a turret it actually affects — no
// steering card before you've got a rocket.
// Passives: Magnet (v181) is the first since Bounce was removed in
// v106, replaced by Penetration — forward pierce fits the fantasy
// better than a random ricochet back at your own cannon.
function buildCardPool() { return [
  { kind: 'turret', type: 'cannon', title: 'Cannon', icon: ICONS.cannon, sub: 'Sweeps shots in an arc, blasting rock.' },
  { kind: 'turret', type: 'rocket', title: 'Rocket', icon: ICONS.rocket, sub: 'Fires homing missiles that crash and splash-dig.' },
  { kind: 'turret', type: 'laser', title: 'Laser', icon: ICONS.laser, sub: 'Shoots down enemy shots in a radius around it.' },
  { kind: 'turret', type: 'bloom', title: 'Field', icon: ICONS.bloom, sub: 'Grows territory that harvests.' },
  { kind: 'turret', type: 'lantern', title: 'Outpost', icon: ICONS.lantern, sub: 'Pushes back fog and anchors your base.' },
  { kind: 'turret', type: 'gather', title: 'Harvester', icon: ICONS.gather, sub: 'Steps onto pickups to collect them, slowly.' },
  { kind: 'turret', type: 'mole', title: 'Digger', icon: ICONS.mole, sub: 'Digs tunnels through rock.' },
  { kind: 'turret', type: 'wall', title: 'Wall', icon: ICONS.wall, sub: '2x2 defensive barrier.' },
  { kind: 'turret', type: 'waypoint', title: 'Waypoint', icon: ICONS.waypoint, sub: 'Cannons aim at the nearest waypoint.' },
  // Stat cards, generated from STAT_DEFS (cannon/bloom/gather/wall/
  // laser/mole). Wall stats are gated on the Wall being unlocked (see
  // availableCards), so they never appear before you can place one.
  // Laser stats need a Laser placed (S.weapons.laser is created on
  // first placement), so the Shield card never appears before one;
  // v192: Dig needs a Digger placed the same way. v193: shopOnly
  // stats (Projectiles, Penetration) are free XP stat cards on
  // survival — the filter lets them in here, and the generic stat
  // machinery deals and picks them with no gold. On main shopOnly
  // still means what it says: they're shop-only gold cards there.
  ...['cannon', 'bloom', 'gather', 'wall', 'laser', 'mole'].flatMap(weapon =>
    STAT_DEFS[weapon].filter(d => !d.shopOnly || SURVIVAL).map(d => ({
      kind: 'stat', weapon, stat: d.key, cap: d.cap,
      title: d.name, icon: ICONS[weapon], effect: d.effect,
    }))),
  // Magnet (v181): the global pull passive. Every living BLUE unit
  // pulls in nearby pickups; each pick grows the radius, speeds the
  // pull up, and adds count. Field and Outpost no longer pull by
  // default — this is the only pull there is.
  { kind: 'passive', passive: 'magnet', title: 'Magnet', icon: ICONS.magnet, sub: 'All units pull in nearby pickups.' },
  // Gold Ore: the XP-for-gold exchange. A free XP-row pick that grants
  // run gold — the bridge to a shop unit you can see but can't afford yet.
  // Amount rolls at deal time (3–5): you see what you get before picking.
  { kind: 'gold', title: 'Gold Ore', icon: ICONS.gold },
  // Teleport: one-time XP-row pick. Pick it, tap a Cannon, tap
  // inside a gold base circle to move it there (stats kept — the
  // point is moving an upgraded weapon, not buying a base one).
  // Gated in availableCards on a living BLUE cannon existing, so
  // picking it can never leave you with nothing to move.
  // v139: Cannon only (was Cannon or Laser).
  { kind: 'teleport', title: 'Teleport', icon: ICONS.teleport, sub: 'Move a Cannon to a new spot.' },
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
// Teleport eligibility: a living BLUE Cannon exists to move.
// Cannon only (v139, was Cannon or Laser) — the point is
// repositioning cannon firepower, and gating here prevents picking
// Teleport with nothing movable (which would strand the paused game
// in pick mode).
function hasTeleportTarget() {
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    if (t.type === 'cannon') return true;
  }
  return false;
}
function availableCards() {
  // XP row: FREE cards only. Turret placements live in the shop row, so
  // no turret kind appears here at all. What remains: stat cards for
  // owned weapons (below cap), Gold Ore, steer (via needs), and the
  // per-stat EVO capstones when earned (v114: Rate→Sprayer, Damage→
  // Painter — evolving one stat does NOT hide the other stat cards,
  // capped stats are already filtered by the cap check below).
  // (Passive branch below remains for future passives; none in pool.)
  const pool = CARD_POOL.filter(c => {
    if (c.kind === 'turret') return false;
    if (c.kind === 'stat') {
      const w = S.weapons[c.weapon];
      if (!w || !w.stats) return false;
      // v182: wall stats only once the Wall is unlocked — they make
      // no sense before you can place one.
      if (c.weapon === 'wall' && !(S.unlocked && S.unlocked.wall)) return false;
      return (w.stats[c.stat] || 0) < c.cap;
    }
    if (c.kind === 'passive') return (S.passives[c.passive] || 0) < 8;
    if (c.kind === 'teleport') return hasTeleportTarget();
    return (!c.needs || hasTurretTypes(c.needs));
  });
  if (SURVIVAL) {
    // v154 unlock cards: a placement type joins the bottom bar when
    // its card is picked (VS-style), then it's bought with gold there.
    // Start-unlocked types never appear here; start-screen toggles
    // filter the pool, so a toggled-off type can never be unlocked.
    for (const t of UNLOCKABLE) {
      if (S.unlocked && S.unlocked[t]) continue;
      if (meta && meta.enabled && meta.enabled[t] === false) continue;
      const entry = CARD_POOL.find(c => c.kind === 'turret' && c.type === t);
      if (entry) pool.push({ kind: 'unlock', type: t, title: entry.title, icon: entry.icon, sub: entry.sub });
    }
  }
  if (cannonRateMaxed()) {
    pool.push({ kind: 'evo', title: 'Sprayer', icon: ICONS.evoSpray, sub: 'Blazing-fast sweep spray' });
  }
  if (cannonDmgMaxed()) {
    pool.push({ kind: 'evoPaint', title: 'Painter', icon: ICONS.evoPaint, sub: 'Cannon paints ground as it fires — painted ground pays, weaker than Field' });
  }
  // v193: the gold-gated XP hybrids (v133) are gone — Projectiles
  // and Penetration are free XP stat cards on survival now (they
  // join the pool via the CARD_POOL filter above), so there's no
  // hybrid block here anymore. The nerf is the chance, not gold.
  // Main keeps proj in the shop (v75, unchanged) via projCost().
  return pool;
}
// Shop row: one placement card per active unit type, plus gold-gated stat
// upgrades (currently just cannon projectiles), affordable or not.
// Unaffordable ones still show (greyed) so you can see what to save for.
function availableShopCards() {
  if (SURVIVAL) {
    // Full shop (no proj/pen — they're free XP stat cards now, v193):
    // all 8 placements, cost order (cheapest first) so you can plan
    // ahead. No draw. v194: the Laser is 5 gold now (was 20 — it
    // was too weak to be worth 20 early), so it sorts near the
    // cheap end, not last.
    // Start-screen toggles filter it: only enabled items appear
    // (missing = enabled, explicit false = excluded from the run).
    const types = ['cannon', 'mole', 'bloom', 'gather', 'lantern', 'wall', 'laser', 'waypoint']
      .filter(t => !(meta && meta.enabled && meta.enabled[t] === false));
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
// v193: penCost() is gone with the gold hybrids — Penetration is
// a free XP stat card on survival now, and main's shop never sold
// it (only Projectiles). projCost() stays for main's shop.
function offerCards() {
  // v149: a new deal always starts in cards view, not map view — a
  // previous View map toggle must not carry over to the next level.
  overlay.classList.remove('mapview');
  if (lvviewmap) lvviewmap.textContent = 'View map';
  // XP row: 4 free cards (v171: was 3), weighted draw without replacement. Gold Ore
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
    const lv = p.kind === 'passive' ? (S.passives[p.passive] || 0) : 0;
    let title = p.title, sub = p.sub, newTag = '', priceHtml = '', evoLine = '';
    const icon = `<div class="icon">${p.icon || ''}</div>`;
    // v176: "New!" means first time picking up a unit — only unlock cards
    // carry it (below). Stat and hybrid first picks are upgrades to a
    // weapon you already own, so they never get the tag.
    // v188: a passive is the exception — at level 0 you don't own it at
    // all, so the first pick IS a new pickup and gets the tag (Sam: the
    // first-time Magnet card in his screenshot had no tag). Later picks
    // show the level, like other stat cards.
    if (p.kind === 'passive') {
      if (lv > 0) title = `${p.title} <span class="lv">Lv${lv + 1}</span>`;
      else newTag = '<span class="newtag">New!</span>';
    }
    // v181: Magnet shows what the NEXT pick actually does, like the
    // old Field rotation card did — radius, interval, count.
    // v189: only from the second pick on. The first pick (NEW!) keeps
    // the generic card text — what Magnet does in general terms —
    // not the individual stat deltas (Sam: first-time descriptions
    // are generic, not stat talk). The unlock cards are already
    // generic this way; Magnet was the only NEW! card overriding
    // its sub with a stat delta.
    if (p.kind === 'passive' && p.passive === 'magnet' && lv > 0) sub = magnetNextEffect(lv);
    else if (p.kind === 'stat') {
      // One stat, one chip: title is the stat + its NEW level, sub the effect.
      // The weapon icon says which weapon it belongs to.
      // v176: no New! tag here — a first stat pick is an upgrade to a
      // weapon you already own, not a new unit (only unlocks get New!).
      // v115: cannon Damage/Rate cards (the only tracks with Evos) get
      // a little gold Evo line — icon + the word EVO, no Evo name —
      // so you can see at a glance that this track evolves. Other
      // tracks (Projectiles, Penetration, Bloom, Gather) get no line.
      const w = S.weapons[p.weapon];
      const cur = w && w.stats ? (w.stats[p.stat] || 0) : 0;
      title = `${p.title} <span class="lv">Lv${cur + 1}</span>`;
      sub = p.effect;
      // v192: the Dig card's mix varies per level (damage only on
      // picks 3 and 6, lifetime every pick), so the sub shows the
      // next pick's actual delta, like the Magnet card does.
      if (p.weapon === 'mole' && p.stat === 'dig') sub = moleNextEffect(cur);
      // v194: the Reinforce card's mix varies per level too (size
      // only on picks 1, 3 and 5, HP every pick).
      if (p.weapon === 'wall' && p.stat === 'reinforce') sub = wallNextEffect(cur);
      el.dataset.weapon = p.weapon;
      el.dataset.stat = p.stat;
      if (p.weapon === 'cannon' && p.stat === 'dmg') evoLine = `<span class="evoline">${ICONS.evoPaint} EVO</span>`;
      if (p.weapon === 'cannon' && p.stat === 'rate') evoLine = `<span class="evoline">${ICONS.evoSpray} EVO</span>`;
    }
    else if (p.kind === 'unlock') {
      // v154: unlocks a placement type for the bottom bar, and the
      // pick itself places one for free (VS-style: you get the weapon).
      // v176: this is the ONLY place a New! tag is set — picking up a
      // unit for the first time.
      title = p.title;
      sub = p.sub || 'Unlocks in the bottom bar — place one now, free.';
      newTag = '<span class="newtag">New!</span>';
    }
    else if (p.kind === 'evo') {
      title = `Sprayer <span class="lv">EVO</span>`;
      sub = p.sub;
    }
    else if (p.kind === 'evoPaint') {
      title = `Painter <span class="lv">EVO</span>`;
      sub = p.sub;
    }
    else if (p.kind === 'gold') {
      // Roll the amount at deal time (3–5 gold): the card shows its roll.
      // A preset amount (tests/fixtures) wins over the roll.
      const amt = p.amount || (3 + Math.floor(Math.random() * 3));
      el.dataset.amount = amt;
      sub = `+${amt}<span class="coin"></span>`;
    }
    // v193: the XP-row hybrid branches (kind 'proj'/'pen', gold
    // price) are gone with the hybrids — Projectiles and Penetration
    // are free stat cards now, rendered by the generic stat branch
    // above (title, Lv, effect from STAT_DEFS, no price). The
    // 'proj'/'pen' pick-handler branches stay for main's shop card.
    el.innerHTML = priceHtml + icon + newTag + '<b>' + title + '</b><span>' + sub + '</span>' + evoLine;
    // Staggered deal: cards appear one by one (prevents accidental taps).
    setTimeout(() => el.classList.add('dealt'), 150 + k * 120);
  }
}
// Shop row: survival shows the FULL shop (all items, cost order, no
// draw) in a 3x3 grid; main keeps the original 2-card affordable-first
// random draw (unchanged).
function offerShopCards() {
  // v154: legacy — the level-up screen no longer calls this (shop
  // removed, placements live in the place bar). Kept so the harness
  // and the shop pool (availableShopCards) stay testable.
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
    // proj/pen hybrids) can be blocked. Free XP cards never carry a cost
    // (offerCards clears it), so a stale cost on a reused slot can't
    // block a free pick. (CSS blocks real taps too; this covers
    // programmatic clicks.)
    if ((kind === 'turret' || kind === 'proj' || kind === 'pen') && parseInt(card.dataset.cost || '0', 10) > S.gold) return;
    // Choosing an upgrade resets the XP bar to zero (it stayed full
    // while the cards were showing).
    S.xp = 0; S.xpShown = 0; S.levelUpNeed = 0;
    if (kind === 'turret') {
      // Shop row only now (XP row has no turret cards): a placement, or
      // the Mole bundle (upgrade rides along with a fresh placement).
      const type = card.dataset.type;
      const w = S.weapons[type];
      const cost = parseInt(card.dataset.cost || '0', 10);
      let digApplied = false;
      if (w && card.dataset.stat === 'mole-place') {
        if (w.stats && (w.stats.dig || 0) < 8) {
          w.stats.dig++;
          w.dmgBonus = w.stats.dig;
          digApplied = true;
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
      // v147 swap: remember what this pick cost, so the Swap button
      // can refund exactly that amount (and undo a mole dig pick).
      if (S.placing) { S.placing.cost = cost; S.placing.moleBundle = digApplied; }
      return;
    }
    if (kind === 'unlock') {
      // v174: unlocks the type for the bottom bar — and that's it. No
      // free placement anymore: the unit is now available down there,
      // gated by gold, and a fly animation (card icon -> bar button)
      // shows you where it went. A Digger bought from the bar later
      // still carries the +1 dig bundle (see onPlaceBtn).
      const type = card.dataset.type;
      const from = cardIconCenter(card); // before the overlay hides
      if (S.unlocked) S.unlocked[type] = true;
      S.pending--;
      updateHud(); updatePlaceBar();
      if (S.pending <= 0) {
        S.pending = 0;
        S.paused = false;
        overlay.classList.add('hidden');
        startUnlockFly(type, from); // only when the bar is visible
      } else {
        offerCards();
        overlay.classList.remove('hidden');
      }
      return;
    }
    if (kind === 'teleport') {
      // One-time move: like a placement, this returns early — the
      // pending-- here replaces the generic one at the end, the overlay
      // hides, and the game stays paused while you pick a weapon, then
      // a destination. Completion (completeTeleport) re-offers cards
      // if picks remain, else unpauses.
      S.pending--;
      overlay.classList.add('hidden');
      updateHud();
      enterTeleport();
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
      // Rate EVO: Rate 5 → becomes the Sprayer (12x fire speed).
      if (S.weapons.cannon) S.weapons.cannon.evo = true;
    } else if (kind === 'evoPaint') {
      // Damage EVO: Damage 5 → becomes the Painter (trail painting on).
      if (S.weapons.cannon) S.weapons.cannon.evoPaint = true;
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
    } else if (kind === 'pen') {
      // Gold-gated stat upgrade (v133, same as proj): pay, fill one
      // Penetration chip, no placement follows.
      const w = S.weapons.cannon;
      const cost = parseInt(card.dataset.cost || '0', 10);
      if (w && w.stats && (w.stats.pen || 0) < 5) {
        S.gold -= cost;
        w.stats.pen++;
        applyStat(w, 'cannon', 'pen');
      }
    } else if (kind === 'passive') {
      const p = card.dataset.passive;
      const cur = S.passives[p] || 0;
      if (cur < 8) {
        S.passives[p] = cur + 1;
      }
    } else if (kind === 'steer') {
      S.steerMult *= parseFloat(card.dataset.mult);
    } else if (kind === 'gold') {
      // Gold Ore: free XP pick that grants run gold.
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
// slows the flood rather than stopping it forever. v169: 200 -> 20
// (Sam: at 200 HP a 2-gold wall cell absorbed 200 shots, so the
// threat was trivially blocked — at 20 HP a cell lasts ~2 min of
// fire in its column at the 10/s rate, so walls buy time, not
// forever). v182: HP and Size are upgradeable tracks (see STAT_DEFS
// wall); gold cost scales with Size via wallCost, so a bigger wall
// costs proportionally more, not the same flat 2.
const WALL_HP = 20;
const WALL_HP_PER_LEVEL = 10; // v182: +10 HP per Reinforce pick
const WALL_SIZE_BASE = 2;     // v182: wall block dimension at level 0
// v194: one Reinforce level (0 until the Wall is unlocked and
// picked) drives both HP and size — HP +10/pick (20 -> 70), size
// +1 at picks 1, 3 and 5 (2x2 -> 5x5). Walls have no turret entry,
// so the track lives in S.weapons.wall, created in newGame; the
// card is gated on S.unlocked.wall. Existing walls keep the HP
// they were placed with — the upgrade only affects new placements.
function wallLevel() { const w = S.weapons.wall; return (w && w.stats && w.stats.reinforce) || 0; }
function wallHpAt(lv) { return WALL_HP + WALL_HP_PER_LEVEL * lv; }
function wallSizeAt(lv) { return WALL_SIZE_BASE + Math.ceil(lv / 2); }
function wallHp() { return wallHpAt(wallLevel()); }
function wallSize() { return wallSizeAt(wallLevel()); }
// v194: what the NEXT Reinforce pick does, for the card sub (like
// moleNextEffect) — +10 HP every pick, +1 size on picks 1, 3 and 5.
function wallNextEffect(n) {
  const parts = [];
  if (wallSizeAt(n + 1) > wallSizeAt(n)) parts.push('+1 wall size');
  parts.push('+10 wall HP');
  return parts.join(' · ');
}
// v182: wall gold cost scales with the block's area (per-cell cost
// stays ~0.5 gold): 2x2 = 2, 3x3 = 5, 4x4 = 8, 5x5 = 13.
function wallCost() {
  const n = wallSize();
  return Math.round(UNIT_COST.wall * n * n / (WALL_SIZE_BASE * WALL_SIZE_BASE));
}
const WALL_SHADE = 3; // mid grey ([107,114,128]) — reads as stone, distinct from natural grey variation
// Survival placement: units go near your base, not anywhere lit.
// (Matches fogDist, so an outpost extends the placeable range by 6.)
const PLACE_RADIUS = 6;
const OUTPOST_PLACE_RADIUS = PLACE_RADIUS * 3; // v180: outposts anchor
// within 3x the normal radius (18 cells) — the old anywhere-in-cleared-
// fog rule is gone (Sam: it felt cheaty once half the map was uncovered).
function nearBase(cx, cy, r) {
  if (r === undefined) r = PLACE_RADIUS;
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    const dx = t.x - cx, dy = t.y - cy;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}
// v180: teleport bases — only a living BLUE Cannon or Outpost counts
// as a base for teleport destinations (Sam: you can't teleport next
// to a Digger). v191: the Field uses the same anchor rule for
// placement (Sam: a Field can't be placed next to a Digger either).
// Placement's nearBase still counts any living unit for everything
// else.
function nearTeleportBase(cx, cy) {
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE) continue;
    if (t.type !== 'cannon' && t.type !== 'lantern') continue;
    const dx = t.x - cx, dy = t.y - cy;
    if (dx * dx + dy * dy <= PLACE_RADIUS * PLACE_RADIUS) return true;
  }
  return false;
}
// v147 Swap upgrade type: while placing, tap this to go back to
// the level-up screen and choose something different. It undoes
// exactly what picking the shop card did, except the XP reset (the
// level was spent, the pick is what is being changed): gold refunded,
// pending restored, mole-bundle dig undone if it was applied. The
// cards shown are the same deal as before — no re-deal, so swapping
// is not a free re-roll: the dealt cards are still in the DOM, the
// overlay was only hidden, not cleared. Picking a different card
// from there spends the restored pending pick as normal; picking
// the same placement card again just re-enters placement.
placeswap.addEventListener('click', () => {
  if (!S.placing) return;
  const p = S.placing;
  if (p.cost) S.gold += p.cost;
  if (p.moleBundle) {
    const w = S.weapons.mole;
    if (w && w.stats && (w.stats.dig || 0) > 0) {
      w.stats.dig--;
      w.dmgBonus = w.stats.dig;
    }
  }
  S.placing = null;
  placebanner.classList.add('hidden');
  placeswap.classList.add('hidden');
  S.pending++;
  // Refresh the shop gold label to the refunded gold (offerShopCards
  // set it at deal time, before the deduction).
  document.getElementById('shoplabel').innerHTML =
    'Shop<span class="shopgold">' + S.gold + '<span class="coin"></span></span>';
  overlay.classList.remove('hidden'); // game stays paused while choosing
  updateHud();
});
// v154: gold is paid on successful placement from the bar (not at
// icon tap, so a failed tap or a cancel never needs a refund).
// Shop-legacy placements already paid at card pick, and unlock
// placements are free, so only fromBar pays here. Mole bundle:
// a bar/unlock Digger placement also applies the +1 dig upgrade
// at placement time (after its weapon entry is created).
function payForPlacement(type, placing, cost) {
  if (!placing) return;
  if (placing.fromBar) {
    // v185: a partial wall fill pays the proportional cost passed in;
    // other placements pay the full unit cost.
    const c = (cost !== undefined ? cost : unitCost(type));
    if (S.gold >= c) S.gold -= c;
  }
  // v192: the dig bundle is gone (see onPlaceBtn) — placing a
  // Digger no longer raises the Dig stat. Dig comes from the XP
  // track only now (applyStat mole branch).
  updatePlaceBar();
}
// Cancel a bar placement: tap its icon again. Unlock placements can
// also be cancelled this way (the unlock itself stays — you keep the
// button, you just don't place this free one right now).
function cancelPlacement() {
  if (!S || !S.placing) return;
  S.placing = null;
  placebanner.classList.add('hidden');
  placeswap.classList.add('hidden');
  updatePlaceBar();
  if (S.pending > 0) { offerCards(); overlay.classList.remove('hidden'); }
}
function enterPlacement(type) {  S.placing = { type };
  // v154: Swap is gone with the shop — a bar placement is cancelled
  // by tapping its icon again (see place bar handler), an unlock
  // placement is a free pick with no level-up to return to.
  placeswap.classList.add('hidden');
  if (type === 'waypoint') {
    // Waypoints bypass the base discs: any clear cell, any ground
    // (rock, territory, cave — you aim at walls, not just open ground).
    // Same rule on both branches (main is fog-gated anyway).
    placebanner.innerHTML = 'Tap any clear cell to deploy <b>Waypoint</b>';
  } else {
    placebanner.innerHTML = SURVIVAL
      ? (type === 'lantern'
          ? 'Tap near your base or any clear open cell to deploy <b>Outpost</b>'
          : 'Tap near your base to deploy <b>' + TURRET[type].name + '</b>')
      : 'Tap the map to deploy <b>' + TURRET[type].name + '</b>';
  }
  placebanner.classList.remove('hidden');
}
function placeTurretAt(sx, sy) {
  const type = S.placing.type;
  const wpt = screenToWorld(sx, sy);
  let cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  cx = Math.max(0, Math.min(cfg.cols - 1, cx));
  cy = Math.max(0, Math.min(cfg.rows - 1, cy));
  if (type === 'wall') {
    // v182: the wall block is wallSize() x wallSize() (2x2 base, +1
    // per Size pick, up to 5x5). v185: partial fill — each cell of
    // the block is judged on its own (in bounds, unoccupied, EMPTY
    // or a color cell: BLUE or RED, v134 — you can wall your own
    // territory, walling it stops its harvest, and you can wall
    // flood, destroying that color and cutting the flood off).
    // Rock/grey still refuse, but a refused cell no longer blocks
    // the whole block — it is just skipped (see below).
    const n = wallSize();
    // v185: partial fill — the wall fills every cell of the
    // wallSize() x wallSize() block that is individually placeable
    // (in bounds, unoccupied, EMPTY or a color cell), so a 1x gap
    // between a wall and a cliff fills with a single tap. Only the
    // TAPPED cell must be placeable: if it isn't (rock/grey or
    // occupied — the tap is clamped in bounds, so out-of-bounds
    // can't happen for it), the whole placement fails with a red
    // ring, as before. Out-of-bounds and blocked cells of the block
    // are simply skipped, not a failure.
    const filled = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
      const wx = cx + dx, wy = cy + dy;
      if (wx >= cfg.cols || wy >= cfg.rows) continue; // past the edge: skip
      const wi = wy * cfg.cols + wx;
      if (turretAt(wx, wy) || civilianAt(wx, wy) || (S.cells[wi] !== EMPTY && S.cells[wi] !== BLUE && S.cells[wi] !== RED)) continue;
      filled.push([wx, wy]);
    }
    // The tapped cell is the anchor of the fill — it must be placeable.
    if (!filled.some(([wx, wy]) => wx === cx && wy === cy)) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
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
    // Convert the filled cells to GREY wall: this destroys any color
    // there (own or flood) and clears any growth in progress, so
    // flood growing on an EMPTY cell is removed, not just completed flood.
    const hp = wallHp();
    let bx = 0, by = 0;
    for (const [wx, wy] of filled) {
      const wi = wy * cfg.cols + wx;
      S.cells[wi] = GREY;
      S.hp[wi] = hp; S.maxhp[wi] = hp; S.shade[wi] = WALL_SHADE;
      S.growN[wi] = 0; S.growBy[wi] = 0; S.harvT[wi] = 0; S.goldNug[wi] = 0; S.popT[wi] = -1;
      if (S.noHarvest) S.noHarvest[wi] = 0;
      bx += wx; by += wy;
    }
    spawnBurst(bx / filled.length + 0.5, by / filled.length + 0.5, '#9ca3af'); // centroid of the filled cells
    // No turret entry — walls are terrain. (The stat track lives in
    // S.weapons.wall, but no turret is ever created, so the shop card
    // keeps showing New! + the description every time, which is fine:
    // each wall IS new.)
    const wallPlacing = S.placing;
    // v185: pay in proportion to the cells actually filled (min 1
    // gold), not the full block cost — a 1-cell gap fill costs 1.
    const fillCost = Math.max(1, Math.round(wallCost() * filled.length / (n * n)));
    payForPlacement(type, wallPlacing, fillCost);
    // v154 wall chaining: a bar wall stays in placement mode while
    // you can afford another, so you can tap-tap-tap a defensive
    // line before a wave. Unlock walls are free and single-shot.
    if (wallPlacing && wallPlacing.fromBar && S.gold >= unitCost('wall') && !S.runOver && S.pending <= 0) {
      S.placing = { type: 'wall', fromBar: true, moleBundle: false, cost: unitCost('wall') };
      updatePlaceBar();
      return;
    }
    S.placing = null;
    placebanner.classList.add('hidden');
    placeswap.classList.add('hidden');
    if (!S.runOver) {
      if (S.pending > 0) {
        offerCards(); // v154: shop removed from level-up, placements live in the place bar
        overlay.classList.remove('hidden');
      } else {
        S.paused = false;
      }
    }
    return;
  }
  if (type === 'waypoint') {
    // Waypoint marker (not a turret, no weapon entry — so the shop cost
    // stays flat 5, like Wall's flat 2): any fog-clear cell, any ground
    // (rock, territory, cave), but not on a turret (a waypoint on its
    // own cannon would aim at itself) and not on another waypoint.
    // No nearBase check — "anywhere not fog" is the whole point.
    const pi = cy * cfg.cols + cx;
    if (!S.waypoints) S.waypoints = [];
    const dup = S.waypoints.some(w => w.x === cx && w.y === cy);
    if (dup || turretAt(cx, cy) || civilianAt(cx, cy) || S.fog[pi] !== 0) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    S.waypoints.push({ x: cx, y: cy });
    spawnBurst(cx + 0.5, cy + 0.5, '#ffd75e'); // gold, matching the marker
    payForPlacement(type, S.placing);
    S.placing = null;
    placebanner.classList.add('hidden');
    placeswap.classList.add('hidden');
    if (!S.runOver) {
      if (S.pending > 0) {
        offerCards(); // v154: shop removed from level-up, placements live in the place bar
        overlay.classList.remove('hidden');
      } else {
        S.paused = false;
      }
    }
    return;
  }
  if (turretAt(cx, cy) || civilianAt(cx, cy)) {
    // Occupied: red ring says no, placement mode stays on.
    S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
    return;
  }
  const pi = cy * cfg.cols + cx;
  if (SURVIVAL) {
    if (type === 'lantern') {
      // Outpost (v180, Sam): no more anywhere-in-cleared-fog — it must
      // land within 3x the normal radius of a living BLUE unit, on any
      // visible ground (fog-clear; near-base cells are clear by
      // construction, at 3x the check matters). That's how you extend
      // past the build discs, but bounded: drop an outpost at the edge
      // of the revealed area and it becomes a new anchor for the next
      // units — it just can't leap halfway across a half-cleared map.
      if (!nearBase(cx, cy, OUTPOST_PLACE_RADIUS) || S.fog[pi] !== 0) {
        S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
        return;
      }
    } else if (type === 'bloom') {
      // v191: the Field anchors on a Cannon or Outpost only (Sam:
      // same rule as the Cannon's teleport anchor — you can't place
      // a Field next to a Digger). A roaming Digger must not let you
      // drop Fields deep in a cave, far from your base; Fields expand
      // from your bases, and the Outpost is the cheap expansion
      // anchor (2 gold) for pushing the frontier out.
      if (!nearTeleportBase(cx, cy)) {
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
    // Outposts sit on any visible ground near base (main: any ground;
    // survival far outposts already checked EMPTY + clear above).
    // No pad clearing.
  } else if (type === 'bloom') {
    // Field (v134, same as Wall): can be placed on a color cell
    // (BLUE or RED), destroying that color — so you can plant a Field
    // into flood and cut it off — or on open ground. Rock/grey still
    // refuse. Clearing the pad also removes any growth in progress
    // there (flood growing on an EMPTY cell is removed, not frozen
    // under the Field).
    if (S.cells[pi] !== EMPTY && S.cells[pi] !== BLUE && S.cells[pi] !== RED) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    S.cells[pi] = EMPTY; // clear a pad (destroys color, if any)
    S.growN[pi] = 0; S.growBy[pi] = 0; S.harvT[pi] = 0;
    if (S.noHarvest) S.noHarvest[pi] = 0;
  } else {
    // Combat units need open ground — or cannon-painted
    // ground (v113: painted territory is just color, weaker harvest
    // since v114, so building on it is fine; it clears the paint at
    // that cell. Field-grown / flipped territory still refuses, to
    // protect its harvest — that's the painted-vs-field distinction,
    // for now behavioral, not visual, as Sam said to worry about
    // visuals later).
    const paintedPad = S.cells[pi] === BLUE && S.noHarvest && S.noHarvest[pi] === 1;
    if (S.cells[pi] !== EMPTY && !paintedPad) {
      S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
      return;
    }
    S.cells[pi] = EMPTY; // clear a pad (clears paint too, if painted)
    if (S.noHarvest) S.noHarvest[pi] = 0;
  }
  S.turrets.push(mkTurret(cx, cy, BLUE, type));
  if (!S.weapons[type]) {
    S.weapons[type] = { stats: initWeaponStats(type), rateMult: 1, dmgBonus: 0, critChance: 0, proj: 0, evo: false, evoPaint: false };
  }
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[BLUE]);
  computeFog(); // light fog (v128): the new unit reveals immediately, not on the next rock break
  payForPlacement(type, S.placing); // v154: bar placements pay here, after the weapon entry exists (Mole dig)
  S.placing = null;
  placebanner.classList.add('hidden');
  placeswap.classList.add('hidden');
  if (!S.runOver) {
    if (S.pending > 0) {
      offerCards(); // v154: shop removed from level-up, placements live in the place bar // more picks: fresh XP + shop rows, stays paused
      overlay.classList.remove('hidden');
    } else {
      S.paused = false;
    }
  }
}

// ---- Teleport: one-time XP pick, move a Cannon ----
// Flow (game stays paused throughout, like placement, no cancel):
//   pick Teleport card -> enterTeleport (stage 'pick', banner)
//   -> tap a BLUE Cannon -> stage 'dest', banner names it,
//      gold base discs show (survival) where it may land
//   -> tap inside a disc on EMPTY unoccupied ground -> it moves there
//      instantly (no glide), re-aims at map centre, fog recomputed,
//      then pending handling mirrors placement (more picks -> re-offer,
//      else unpause).
// Destination rule mirrors placement per branch: survival =
// nearTeleportBase (inside a PLACE_RADIUS disc around a living BLUE
// Cannon or Outpost — v180, Diggers/Harvesters/Lasers/Fields don't
// count — including the moving unit itself, so it can hop up to 6
// cells from its old spot, or jump to an Outpost anchor); main =
// fog-clear (no discs, fog is the visualization, like placement).
// Tapping another Cannon in 'dest' switches selection; tapping the
// selected Cannon itself keeps it; any other occupied cell or invalid
// ground shows a red ring and stays in the current stage.
// v139: Cannon only — Lasers are no longer selectable, in pick or dest.
function enterTeleport() {
  S.teleporting = { stage: 'pick', unit: null };
  S.placing = null;
  placeswap.classList.add('hidden'); // swap is for placements, not teleport
  placebanner.innerHTML = 'Tap a Cannon to teleport';
  placebanner.classList.remove('hidden');
}
function teleportRedRing(cx, cy) {
  S.rings.push({ x: cx + 0.5, y: cy + 0.5, t: 0, css: '#ef4444', dead: false });
}
function handleTeleportTap(sx, sy) {
  const tp = S.teleporting;
  if (!tp) return;
  const wpt = screenToWorld(sx, sy);
  let cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  cx = Math.max(0, Math.min(cfg.cols - 1, cx));
  cy = Math.max(0, Math.min(cfg.rows - 1, cy));
  const tapped = turretAt(cx, cy);
  const isWeapon = tapped && !tapped.dead && tapped.color === BLUE &&
    tapped.type === 'cannon'; // v139: Cannon only, Laser no longer selectable
  if (tp.stage === 'pick') {
    if (isWeapon) {
      tp.unit = tapped;
      tp.stage = 'dest';
      placebanner.innerHTML = 'Tap inside a gold circle to move <b>' + TURRET[tapped.type].name + '</b>';
    } else {
      teleportRedRing(cx, cy);
    }
    return;
  }
  // Destination stage.
  if (isWeapon) {
    // Re-pick (or re-tap the selected Cannon): switch selection, stay here.
    tp.unit = tapped;
    placebanner.innerHTML = 'Tap inside a gold circle to move <b>' + TURRET[tapped.type].name + '</b>';
    return;
  }
  if (tapped) { teleportRedRing(cx, cy); return; } // occupied: can't land here
  if (civilianAt(cx, cy)) { teleportRedRing(cx, cy); return; } // civilian crowd: can't land on them
  const pi = cy * cfg.cols + cx;
  const okGround = S.cells[pi] === EMPTY &&
    (SURVIVAL ? nearTeleportBase(cx, cy) : S.fog[pi] === 0);
  if (!okGround) { teleportRedRing(cx, cy); return; }
  completeTeleport(tp.unit, cx, cy);
}
function completeTeleport(t, cx, cy) {
  const ox = t.x, oy = t.y;
  spawnBurst(ox + 0.5, oy + 0.5, CELL_COLORS[BLUE]); // leave: burst at origin
  t.x = cx; t.y = cy; t.rx = cx; t.ry = cy; t.moveT = 1; // instant, no glide
  // Re-aim from the new spot: straight up on survival (v180: all
  // cannons aim up), map centre on main. v144: teleport clears the
  // starter flag — a teleported starter is now a placed cannon, so
  // it keeps up aim thereafter (including on waypoint removal)
  // instead of snapping back to the coast.
  t.base = SURVIVAL ? -Math.PI / 2 : Math.atan2(cfg.rows / 2 - cy, cfg.cols / 2 - cx);
  t.angle = t.base;
  t.isStarter = false;
  spawnBurst(cx + 0.5, cy + 0.5, CELL_COLORS[BLUE]); // arrive: burst at destination
  computeFog(); // unit moved, so its disc reveals at the new spot, like placement
  S.teleporting = null;
  placebanner.classList.add('hidden');
  placeswap.classList.add('hidden');
  if (!S.runOver) {
    if (S.pending > 0) {
      offerCards(); // v154: shop removed from level-up, placements live in the place bar // more picks: fresh XP + shop rows, stays paused
      overlay.classList.remove('hidden');
    } else {
      S.paused = false;
    }
  }
  updateHud();
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
// ---- Sparkles (v123, v124 ocean ripples, v125 dash shimmer, v126 both) ----
// Pure polish, no gameplay: every ~0.7–1.6s a shimmer event appears on
// a random fog-clear EMPTY ocean cell currently in view (so you
// actually see it — a random map cell would usually be off-screen at
// 3x zoom). Two looks, kept together (v126, Sam: rings feel like
// raindrops, diamonds like sun glitter): usually a single expanding
// ring pair (v124), and much less often — 20% of spawns, so about
// once every 5–6 seconds — a small patch of 1–3 elongated diamond
// glints in nearby ocean cells (v125), warm white, length 5–11 world
// px and about a third as tall, random vertical offset in the cell.
// Each effect lives 1.2s. At most 9 effects at once, so it reads as
// weather, not fireworks. Ocean only, fog-clear only (never leaks
// fogged ground); turret, civilian and coin cells are skipped. If no
// ocean is in view, no shimmer spawns.
const SPARKLE_MAX = 9; // max effects on screen
const SPARKLE_LIFE = 1.2; // seconds per effect
const SPARKLE_SPAWN_MIN = 0.7, SPARKLE_SPAWN_MAX = 1.6; // seconds between events
const SPARKLE_DASH_CHANCE = 0.2; // v126: diamond patches are rare — 1 in 5 spawns, rings the rest
function spawnSparkle() {
  if (!S || !cfg.cols) return;
  const hw = view.w / cam.zoom / 2, hh = view.h / cam.zoom / 2;
  const x0 = Math.max(0, Math.floor((cam.x - hw) / CELL_PX)), x1 = Math.min(cfg.cols - 1, Math.ceil((cam.x + hw) / CELL_PX));
  const y0 = Math.max(0, Math.floor((cam.y - hh) / CELL_PX)), y1 = Math.min(cfg.rows - 1, Math.ceil((cam.y + hh) / CELL_PX));
  const okCell = (x, y) => {
    if (x < 0 || y < 0 || x >= cfg.cols || y >= cfg.rows) return false;
    const i = y * cfg.cols + x;
    if (!S.ocean[i] || S.cells[i] !== EMPTY || S.fog[i] !== 0) return false;
    if (turretAt(x, y) || civilianAt(x, y) || coinAt(x, y)) return false;
    if (S.sparkles.some(s => s.x === x && s.y === y)) return false;
    return true;
  };
  // Collect eligible cells in view first, then pick one — random
  // tries alone flake when eligible ocean is sparse (e.g. only the
  // starter's fog disc, ~39 of ~520 view cells, failed ~10% of the
  // time on 30 tries). Collecting guarantees a shimmer whenever any
  // eligible ocean cell is visible, and keeps the pick uniform.
  const eligible = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (okCell(x, y)) eligible.push([x, y]);
  if (!eligible.length) return;
  const [x, y] = eligible[Math.floor(Math.random() * eligible.length)];
  // v126: usually a ring (raindrop), rarely a diamond patch (sun glitter).
  if (Math.random() >= SPARKLE_DASH_CHANCE) {
    S.sparkles.push({ x, y, t: 0, life: SPARKLE_LIFE, kind: 'ring' });
    return;
  }
  const pushGlint = (gx, gy) => {
    S.sparkles.push({ x: gx, y: gy, t: 0, life: SPARKLE_LIFE, kind: 'dash',
                      len: 5 + Math.random() * 6, dy: (Math.random() - 0.5) * 8 });
  };
  pushGlint(x, y);
  // A scattered patch, like the photo: up to 2 more glints in nearby
  // ocean cells, wider horizontally than vertically, still in view.
  for (let extra = 0; extra < 2 && S.sparkles.length < SPARKLE_MAX; extra++) {
    let placed = false;
    for (let t2 = 0; t2 < 10 && !placed; t2++) {
      const nx = x + Math.floor(Math.random() * 5) - 2;
      const ny = y + Math.floor(Math.random() * 3) - 1;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || !okCell(nx, ny)) continue;
      pushGlint(nx, ny); placed = true;
    }
  }
}
function updateSparkles(dt) {
  if (!S) return;
  if (!S.sparkles) S.sparkles = [];
  if (S.sparkleT === undefined) S.sparkleT = 0.8;
  S.sparkleT -= dt;
  if (S.sparkleT <= 0) {
    S.sparkleT = SPARKLE_SPAWN_MIN + Math.random() * (SPARKLE_SPAWN_MAX - SPARKLE_SPAWN_MIN);
    if (S.sparkles.length < SPARKLE_MAX) spawnSparkle();
  }
  for (const s of S.sparkles) s.t += dt;
  S.sparkles = S.sparkles.filter(s => s.t < s.life);
}
function update(dt) {
  updateAutoCam(dt); // v153 try-it: slow north-only follow, toggleable, never south/zoom/death
  updateUnlockFlies(dt); // v174: card -> bar icon flight after an unlock pick
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
    offerCards(); // v154: shop removed from level-up, placements live in the place bar
    overlay.classList.remove('hidden');
    updateHud();
  }
  // Enemy pressure: survival runs the flood clock; main runs the red
  // bank (red Bloom buys moles from its harvest gold, up to RED_MOLE_MAX
  // alive. No timer — the economy is the limiter, so starving red's
  // fields starves its army).
  if (SURVIVAL) {
    floodTick(dt);
    meteorTick(dt); // after floodTick: meteor warning wins the shared toast for 10s
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
      // Waypoint aim (BLUE only): if any waypoint exists, the arc
      // centre re-aims at the nearest waypoint each frame (so a
      // teleported cannon re-aims from its new spot automatically).
      // Arc, sweep, and turn rate are unchanged — only the centre
      // moves. No waypoints = base untouched (straight-up aim on
      // survival, as set at placement / teleport). Red cannons never
      // use waypoints.
      if (t.color === BLUE && S.waypoints && S.waypoints.length) {
        let best = null, bd = Infinity;
        for (const w of S.waypoints) {
          const d2 = (w.x - t.x) ** 2 + (w.y - t.y) ** 2;
          if (d2 < bd) { bd = d2; best = w; }
        }
        if (best) t.base = Math.atan2(best.y - t.y, best.x - t.x);
      }
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
        // v193: projectiles are chance-based on survival (like
        // penetration) — roll the chain at volley start; main keeps
        // the guaranteed 1 + proj count. The stagger (one round per
        // BURST_GAP) is unchanged — the roll only sets how many.
        t.burstLeft = SURVIVAL ? rollProjCount((w && w.stats ? (w.stats.proj || 0) : 0))
                               : 1 + (w && w.proj ? w.proj : 0);
        t.burstT = 0; // first round fires immediately
      }
    } else if (t.type === 'rocket') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = (TURRET.rocket.interval / rateMult) * (0.8 + Math.random() * 0.4); fireMissile(t); }
    } else if (t.type === 'laser') {
      t.cd -= dt;
      // v195: reactive firing on survival (Sam: a projectile could
      // slip through between timer shots and hit the laser). The
      // laser sits armed (no cooldown) while idle; the moment a RED
      // projectile enters its shield radius it fires immediately,
      // then the cooldown starts. It never fires on a blind timer
      // anymore, so every ring means it shot something down. Main
      // keeps the blind timer (its laser zaps rock, not projectiles).
      const armed = SURVIVAL ? (t.cd <= 0 && laserHasTarget(t)) : (t.cd <= 0);
      if (armed) {
        t.cd = (TURRET.laser.interval / rateMult) * (0.8 + Math.random() * 0.4);
        fireLaser(t);
      }
    } else if (t.type === 'bloom') {
      t.cd -= dt;
      if (t.cd <= 0) { t.cd = TURRET.bloom.interval / rateMult * S.bloomMult; bloomGrowth(t); }
      // v181: Field no longer pulls — it is purely growth now. Pull
      // lives on the global Magnet passive (see the block after the
      // type chain below). Red Fields grow only, as before.
      // (The lantern branch is gone too: v181 moved the Outpost
      // vacuum to Magnet as well, so Outposts have no per-frame work.)
    } else if (t.type === 'mole') {
      // Digger: chews through rock, dies after its lifetime (cells dug).
      // Red turns toward the nearest blue turret (encroachment) and opens
      // ground toward blue. Blue follows its flag every tick (BFS next
      // step toward gold or an unreachable cave, nearest wins) — no
      // random turn every 3 cells while it has a flag, so it doesn't
      // veer off its tunnel. No flag (nothing left to reach) falls back
      // to the old nugget-bias wander on turn events. Grey and enemy
      // territory block both; a flagged digger waits instead of turning
      // away (next tick's steering routes around), an unflagged one turns.
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
        if (t.color === BLUE) {
          // Flag steering, every tick: retarget on arrival / staleness /
          // unreachability, then head down the BFS path. No turn() here
          // (that would jitter the direction every second when unflagged).
          if (t.flag && t.x === t.flag.x && t.y === t.flag.y) retargetDigger(t);
          if (!t.flag || !flagValid(t)) retargetDigger(t);
          if (t.flag) {
            let nd = diggerPathNext(t.x, t.y, t.flag.x, t.flag.y);
            if (nd === null) {
              retargetDigger(t);
              if (t.flag) nd = diggerPathNext(t.x, t.y, t.flag.x, t.flag.y);
            }
            if (nd !== null) t.moleDir = nd;
          }
        }
        const flagged = t.color === BLUE && !!t.flag;
        const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const [dx, dy] = dirs[t.moleDir];
        const nx = t.x + dx, ny = t.y + dy;
        if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) {
          if (!flagged) turn(); // flagged: wait, steering routes around next tick
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
              // Collect before the lifetime death check, so a Digger
              // that dies on this step still banks the coin it just mined.
              if (t.color === BLUE) collectAtMole(t);
              if (t.dug >= t.lifetime) { t.dead = true; continue; }
              if (!flagged && t.dug % MOLE_TURN_EVERY === 0) turn();
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
            // Not rock, not walkable (grey, enemy ground).
            if (!flagged) turn();
          }
        }
        // After each dig step (moved, walked, or waited): a blue
        // Digger picks up idle coins within 1 cell (v135).
        if (!t.dead) collectAtMole(t);
      }
    }
    // Magnet (v181, global pull): every living BLUE unit pulls nearby
    // idle pickups toward itself. Level 0 = no pull. This runs for
    // every type — Cannon, Digger, Field, Harvester (pulls while it
    // drives, speed unchanged), Outpost, Laser — because it sits
    // outside the type chain, after it. Red never pulls.
    if (t.color === BLUE && !t.dead && magnetLevel() > 0) {
      t.pullT = (t.pullT || 0) + dt;
      if (t.pullT >= magnetInterval()) {
        t.pullT = 0;
        pullCoinsTo(t, magnetRadius(), magnetCount());
      }
    }
  }
  S.turrets = S.turrets.filter(t => !t.dead);
  // Civilians (survival only): wait, hidden by fog, until their cell
  // clears, then walk home 1 cell per second to the nearest Cannon or
  // Outpost (BFS each step, so tunnels opening / bases moving / flood
  // blocking all reroute automatically). No path yet = wait in place.
  // v165 collection (Sam, 2026-11-06): arriving = collected, not
  // settled. A civilian standing on a free spot around a base (the
  // old v113 settle spot, radius 2) flies to the civilians counter
  // and is gone from the map; the rescued count increments when the
  // fly arrives at the chip. No crowd, no settled state, no
  // settled-block-placement anymore — a collected cell is free ground
  // again. Resource seeking is gone too (v136 reverted): a civilian
  // never goes out of its way for a pickup, it only banks what is on
  // the cell it happens to stand on. No death.
  if (SURVIVAL && S.rescue && S.rescue.civilians) {
    for (const c of S.rescue.civilians) {
      if (c.rx !== undefined) c.moveT += dt; // glide clock, like turrets
      c.stepT = (c.stepT || 0) + dt;
      if (c.stepT < CIV_STEP_DUR) continue;
      c.stepT = 0;
      if (c.state === 'waiting') {
        if (S.fog[c.y * cfg.cols + c.x] !== 0) continue; // still hidden: wait
        c.state = 'moving'; // discovered: start escaping now, same tick
      }
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      // Chance pickup only: bank what is on our cell (a coin that
      // spawned here, or arrived last tick) — never chase one.
      collectAtCivilian(c);
      // Already home? Collect immediately (no extra second).
      if (civilianSettleBase(c.x, c.y, c)) { collectCivilian(c); continue; }
      // Otherwise walk one step toward the nearest free spot; if none
      // exists (base full / no space yet), walk toward the nearest
      // base anyway so the crowd waits near base, not stranded mid-map.
      let nd = civilianSettleNext(c.x, c.y, c);
      if (nd === null) nd = civilianPathNext(c.x, c.y);
      if (nd === null) continue; // no path yet: wait for a tunnel / base
      c.rx = c.x; c.ry = c.y; c.moveT = 0;
      c.x += dirs[nd][0]; c.y += dirs[nd][1];
      collectAtCivilian(c); // stepped onto a pickup: bank it by chance
      // Arrived on a free spot? Collect immediately (no extra second).
      if (civilianSettleBase(c.x, c.y, c)) collectCivilian(c);
    }
    // Collected civilians are flying to the counter, not on the map.
    S.rescue.civilians = S.rescue.civilians.filter(c => c.state !== 'collected');
  }
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
  // HARVEST_EVERY seconds, then has a chance to produce —
  // a map pickup for blue (80% XP, 20% gold), banked gold for red (it
  // has no collector, so the product goes straight to its bank).
  // Field-grown / flipped / laser-painted blue pays at BLOOM_HARVEST_CHANCE
  // (30%); cannon-painted blue (noHarvest === 1) pays weaker at
  // PAINTED_HARVEST_CHANCE (10%, v114 middle option) — Field still
  // clearly owns resources, but painting now has an incentive.
  // Otherwise the glow just resets: a surprise, not a salary.
  for (let i = 0; i < S.cells.length; i++) {
    if (S.cells[i] !== BLUE && S.cells[i] !== RED) continue;
    if (S.cells[i] === RED && SURVIVAL) continue; // Flood: no harvest, no HP — just a uniform color to paint (harvT stays 0).
    const painted = S.cells[i] === BLUE && S.noHarvest && S.noHarvest[i] === 1;
    S.harvT[i] += dt;
    if (S.harvT[i] >= HARVEST_EVERY) {
      S.harvT[i] = 0;
      const cx = i % cfg.cols, cy = (i / cfg.cols) | 0;
      if (S.cells[i] === BLUE && (coinAt(cx, cy) || S.coins.length >= 800)) continue;
      const chance = painted ? PAINTED_HARVEST_CHANCE : BLOOM_HARVEST_CHANCE;
      if (Math.random() >= chance) continue; // no product this cycle
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
  updateSparkles(dt); // v123, v124 ocean-only, v125 dashes, v126 both: occasional glitter/ripples on visible water
  const tgt = screenToWorld(CHIP_CX, CHIP_CY);
  const TX = tgt.x / CELL_PX, TY = tgt.y / CELL_PX;
  const civTgt = screenToWorld(CIV_CHIP_CX, CIV_CHIP_CY); // v165: civilians counter chip
  const CIVTX = civTgt.x / CELL_PX, CIVTY = civTgt.y / CELL_PX;
  const xtgt = screenToWorld(view.w / 2, 18); // XP bar, top-center
  const XX = xtgt.x / CELL_PX, XY = xtgt.y / CELL_PX;
  for (const c of S.coins) {
    if (c.state === 'fly') {
      c.t += dt;
      const k = Math.min(1, c.t / COIN_FLY_DUR);
      const e = k * k;
      // XP orbs fly to the XP bar; gold coins fly to the gold chip;
      // collected civilians fly to the civilians counter chip.
      const gx = c.kind === 'gold' ? TX : c.kind === 'civ' ? CIVTX : XX;
      const gy = c.kind === 'gold' ? TY : c.kind === 'civ' ? CIVTY : XY;
      c.x = c.sx + (gx - c.sx) * e;
      c.y = c.sy + (gy - c.sy) * e;
      if (k >= 1) {
        c.dead = true;
        if (c.kind === 'gold') {
          S.gold++; // run gold only — banked to the meta total when the run ends
          S.chipPulse = 1; // the "blurp": chip pops
          S.floaters.push({ x: CHIP_CX + 30, y: CHIP_CY, t: 0 });
        } else if (c.kind === 'civ') {
          // v165: the rescue counts on ARRIVAL at the counter, not
          // when the civilian leaves the map.
          if (S.rescue) S.rescue.rescued++;
          S.civChipPulse = 1;
          S.floaters.push({ x: CIV_CHIP_CX + 30, y: CIV_CHIP_CY, t: 0 });
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
  S.civChipPulse = Math.max(0, (S.civChipPulse || 0) - dt * 3); // v165: civilians chip pop decays like the gold one

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
    // v158: rock tile instead of a flat square, when loaded (survival
    // only — main is frozen).
    const rockTile = S.cells[i] === GREY ? TILES['rock-grey'] : TILES['rock-brown'];
    // v160: tint with the cell's own flat colour (HP + damage tint
    // already in c), so a chipped rock still reads as damaged and
    // the light/dark HP range is back. No separate damage overlay.
    if (!SURVIVAL || !drawCellTile(rockTile, x, y, S.shade[i] || 0, c)) fillCell(x, y);
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
  ctx.fillStyle = '#000'; // v122: black again, so it blends with fog — the ocean is now inside the map, not outside it
  ctx.fillRect(0, 0, view.w, view.h);
  // ---- world pass: everything through the camera ----
  ctx.save();
  ctx.translate(view.w / 2, view.h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  const w = cfg.cols, h = cfg.rows;
  // v127: cull cell passes to the visible view (+2 cells margin, so
  // 2x popped cells and cell edges never clip). Without this, a
  // 200x200 map drew 40,000 cells every frame; at 3x zoom only
  // ~6,000 are on screen. Off-screen cells are invisible anyway
  // (canvas clips them), so culling changes nothing visually.
  const vw = view.w / cam.zoom / 2, vh = view.h / cam.zoom / 2;
  const vx0 = Math.max(0, Math.floor((cam.x - vw) / CELL_PX) - 2), vx1 = Math.min(w - 1, Math.ceil((cam.x + vw) / CELL_PX) + 2);
  const vy0 = Math.max(0, Math.floor((cam.y - vh) / CELL_PX) - 2), vy1 = Math.min(h - 1, Math.ceil((cam.y + vh) / CELL_PX) + 2);
  for (let y = vy0; y <= vy1; y++) {
    for (let x = vx0; x <= vx1; x++) {
      const i = y * w + x;
      const st = S.cells[i];
      if (st === BLUE) {
        // v158: player territory tile (red on survival, blue if the
        // team toggle is flipped); falls back to the flat colour.
        if (SURVIVAL && drawCellTile(PLAYER_RED ? TILES.red : TILES.blue, x, y, S.shade[i] || 0, PLAYER_SHADES[S.shade[i] || 0])) continue;
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
        fillCell(x, y);
      }
      else if (st === RED) {
        // v158: flood tile — the opposite hue to the player tile.
        if (SURVIVAL && drawCellTile(PLAYER_RED ? TILES.blue : TILES.red, x, y, S.shade[i] || 0, FLOOD_SHADES[S.shade[i] || 0])) continue;
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
        fillCell(x, y);
      }
      else if (st === EMPTY) {
        // v158: ground tiles — ocean, sand, or grass (coast grass and
        // cave ground both use the grass tile for now).
        if (SURVIVAL) {
          const groundTile = (S.ocean && S.ocean[i]) ? TILES.ocean :
            (S.beach && S.beach[i]) ? TILES.sand : TILES.grass;
          const groundTint = (S.ocean && S.ocean[i]) ? OCEAN_SHADES[S.shade[i] || 0] :
            (S.beach && S.beach[i]) ? BEACH_SHADES[S.shade[i] || 0] :
            (S.grass && S.grass[i]) ? GRASS_SHADES[S.shade[i] || 0] : CAVE_SHADES[S.shade[i] || 0];
          if (drawCellTile(groundTile, x, y, S.shade[i] || 0, groundTint)) continue;
        }
        const sh = (S.ocean && S.ocean[i]) ? OCEAN_SHADES[S.shade[i] || 0] :
          (S.beach && S.beach[i]) ? BEACH_SHADES[S.shade[i] || 0] :
          (S.grass && S.grass[i]) ? GRASS_SHADES[S.shade[i] || 0] : CAVE_SHADES[S.shade[i] || 0];
        ctx.fillStyle = `rgb(${sh[0]},${sh[1]},${sh[2]})`;
        fillCell(x, y);
      }
      else if (S.popT[i] < 0) drawRockCell(x, y); // popped cells draw in the pass below
    }
  }
  // Popped (enlarged) cells render last, in front of surrounding squares.
  // Two passes: the faint neighbor ripple first, then the hard-hit cell itself,
  // so the damaged cell always lands on top of its own shockwave.
  for (let pass = 0; pass < 2; pass++) {
    for (let y = vy0; y <= vy1; y++) {
      for (let x = vx0; x <= vx1; x++) {
        const i = y * w + x;
        if ((S.cells[i] !== WHITE && S.cells[i] !== GREY) || S.popT[i] < 0) continue;
        if (pass === 0 ? S.popAmp[i] >= 1 : S.popAmp[i] < 1) continue;
        drawRockCell(x, y);
      }
    }
  }
  // Territory growth: a single square growing from the cell centre.
  // Size is growN / GROW_STEPS of the cell, interpolating smoothly
  // from the previous step over GROW_ANIM_DUR after each increment
  // (growT), then holding until the next increment. At GROW_STEPS
  // the cell becomes solid territory (handled in bloomGrowth /
  // floodSpread). One coherent shape, not fragments, so a growing
  // cell reads as becoming solid, not broken.
  for (let y = vy0; y <= vy1; y++) {
    for (let x = vx0; x <= vx1; x++) {
      const i = y * w + x;
      const n = S.growN[i];
      if (n <= 0 || S.cells[i] !== EMPTY) continue;
      ctx.fillStyle = CELL_COLORS[S.growBy[i]];
      const frac = growthSquareFrac(n, S.growT[i], S.time);
      const size = Math.max(0.01, frac) * CELL_PX;
      const cx = (x + 0.5) * CELL_PX, cy = (y + 0.5) * CELL_PX;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
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
  // Meteor shadows (v116): one dark circle per falling meteor, large
  // then shrinking (and darkening) as it nears the ground. Drawn under
  // turrets/damage numbers so units stay readable through the shadow.
  if (S.meteor && S.meteor.phase === 'shower') {
    for (const t of S.meteor.targets) {
      if (t.state !== 'shadow') continue;
      const k = Math.min(1, t.shadowT / METEOR_SHADOW_DUR);
      const rad = (METEOR_SHADOW_R0 + (METEOR_SHADOW_R1 - METEOR_SHADOW_R0) * k) * CELL_PX;
      ctx.globalAlpha = 0.25 + 0.25 * k; // faint large -> dark small
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc((t.x + 0.5) * CELL_PX, (t.y + 0.5) * CELL_PX, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
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
    } else { // outpost: a little glowing lantern (icon unchanged from Lantern)
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, -5, 3.5, Math.PI, 0); ctx.stroke(); // handle
      ctx.beginPath(); ctx.rect(-5, -5, 10, 12); ctx.fill(); ctx.stroke(); // body
      ctx.fillStyle = '#fef3c7'; // glowing core
      ctx.beginPath(); ctx.arc(0, 1, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // Teleport rings: pick stage = dashed gold ring on every movable
    // Cannon (BLUE) so you see the candidates; destination stage =
    // solid gold ring on the selected Cannon only. v139: Cannon only.
    if (S.teleporting && !t.dead && t.color === BLUE &&
        t.type === 'cannon') {
      const isSel = S.teleporting.stage === 'dest' && S.teleporting.unit === t;
      if (S.teleporting.stage === 'pick' || isSel) {
        ctx.save();
        ctx.strokeStyle = isSel ? 'rgba(250, 204, 21, 0.95)' : 'rgba(250, 204, 21, 0.6)';
        ctx.lineWidth = isSel ? 2.5 : 2;
        if (!isSel) ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
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
  // Civilians (survival only): pink blobs, gliding cell to cell like
  // Harvesters (step duration = glide duration, so they walk smoothly).
  // Rendered BEFORE fog, so waiting civilians in fogged caves stay
  // hidden — only the minimap ? hints at them until discovery.
  if (SURVIVAL && S.rescue && S.rescue.civilians) {
    for (const c of S.rescue.civilians) {
      let dx = c.x, dy = c.y;
      if (c.rx !== undefined && c.moveT < CIV_STEP_DUR) {
        const k = c.moveT / CIV_STEP_DUR;
        dx = c.rx + (c.x - c.rx) * k;
        dy = c.ry + (c.y - c.ry) * k;
      }
      const px = (dx + 0.5) * CELL_PX, py = (dy + 0.5) * CELL_PX;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = CIV_PINK; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0e16'; ctx.stroke();
    }
  }
  // Waypoints (survival only): gold crosshairs, before fog (waypoints
  // only ever sit on clear cells, so fog never covers them anyway).
  if (SURVIVAL && S.waypoints) {
    for (const w of S.waypoints) {
      const px = (w.x + 0.5) * CELL_PX, py = (w.y + 0.5) * CELL_PX;
      ctx.strokeStyle = '#ffd75e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Build range (survival, proximity-gated units): while placing, show
  // the discs around your base units that a new unit must land inside.
  // A tap outside every disc is why the red ring rejects it. Outpost
  // shows wider discs (OUTPOST_PLACE_RADIUS, v180) around the same
  // units. Teleport shows the same discs, but only in its destination
  // stage (after a weapon is picked) — pick stage shows unit rings
  // instead — and only around Cannons and Outposts, the only teleport
  // bases (v180). Placing a Field shows the same bases-only discs
  // (v191: Fields anchor on Cannon/Outpost only). Main has no
  // proximity rule (fog shows where you can place), so no discs there.
  let discR = 0, discBases = false;
  if (SURVIVAL && S.placing) {
    discR = S.placing.type === 'lantern' ? OUTPOST_PLACE_RADIUS : PLACE_RADIUS;
    discBases = S.placing.type === 'bloom';
  } else if (SURVIVAL && S.teleporting && S.teleporting.stage === 'dest') { discR = PLACE_RADIUS; discBases = true; }
  if (discR > 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.07)';
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.45)';
    ctx.lineWidth = 2;
    for (const t of S.turrets) {
      if (t.dead || t.color !== BLUE) continue;
      if (discBases && t.type !== 'cannon' && t.type !== 'lantern') continue;
      ctx.beginPath();
      ctx.arc((t.x + 0.5) * CELL_PX, (t.y + 0.5) * CELL_PX, discR * CELL_PX, 0, Math.PI * 2);
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
  if (!fogHidden) for (let y = vy0; y <= vy1; y++) {
    for (let x = vx0; x <= vx1; x++) {
      const f = S.fog[y * cfg.cols + x];
      if (f === 2) { ctx.fillStyle = '#000'; fillCell(x, y); }
      else if (f === 1) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; fillCellExact(x, y); }
    }
  }
  // World border (v120): after the fog, so it stays visible even where
  // the map is dark — the line itself says where the world stops.
  ctx.strokeStyle = WORLD_BORDER;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, cfg.cols * CELL_PX, cfg.rows * CELL_PX);
  // Meteor warning rings on the main map (v135): the same flashing
  // yellow circles as the minimap, but on the map itself, so you don't
  // have to look at the minimap to see where they will land. Drawn
  // after the fog, like pickups and flags, so fogged targets still
  // warn. Ring radius = 2 cells, the actual impact cluster radius, so
  // the ring shows the danger zone, not just the centre point; a dot
  // marks the centre. v171: only in the last 5s of the warning (the
  // minimap carries the full 10s), and for targets not yet impacted
  // during the shower, disappearing as each lands.
  const showWorldRings = S.meteor && (S.meteor.phase === 'shower' ||
    (S.meteor.phase === 'warn' && S.meteor.timer <= METEOR_WORLD_WARN_DUR));
  if (SURVIVAL && showWorldRings) {
    const a = 0.55 + 0.25 * Math.sin(S.time * Math.PI * 2 / 2.2);
    ctx.strokeStyle = `rgba(255, 215, 94, ${a})`;
    ctx.fillStyle = `rgba(255, 215, 94, ${a})`;
    ctx.lineWidth = 2;
    for (const t of S.meteor.targets) {
      if (t.state === 'done') continue;
      const px = (t.x + 0.5) * CELL_PX, py = (t.y + 0.5) * CELL_PX;
      if (px < (vx0 - 2) * CELL_PX || px > (vx1 + 3) * CELL_PX ||
          py < (vy0 - 2) * CELL_PX || py > (vy1 + 3) * CELL_PX) continue;
      ctx.beginPath();
      ctx.arc(px, py, 2 * CELL_PX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Rescue ? in the world (v173): the same undiscovered-site rule as
  // the minimap ?, but on the map itself, so you don't have to look
  // at the minimap to find the caves. Drawn after the fog, like the
  // meteor rings, so a fogged site still shows. Disappears once the
  // fog clears — the pink blobs are visible on the main map then.
  if (SURVIVAL && S.rescue) {
    const pulse = 0.8 + 0.2 * Math.sin(S.time * Math.PI * 2 / 1.6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 16px system-ui, sans-serif';
    for (let si = 0; si < (S.rescue.sites || []).length; si++) {
      if (!rescueSiteUndiscovered(si)) continue;
      const site = S.rescue.sites[si];
      const px = (site.x + 0.5) * CELL_PX, py = (site.y + 0.5) * CELL_PX;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(11,14,22,0.9)';
      ctx.strokeText('?', px, py);
      ctx.fillStyle = CIV_PINK;
      ctx.fillText('?', px, py);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'start';
  }
  // Pickups (XP orbs + gold coins): idle ones pulse gently so they
  // beg to be tapped — but only on fog-clear cells (v166: a fogged
  // coin is invisible until the fog lifts; flying/gathering coins
  // still render, they are already being banked).
  for (const c of S.coins) {
    if (coinFogged(c)) continue;
    const px = c.x * CELL_PX, py = c.y * CELL_PX;
    let r = 5.5;
    if (c.state === 'idle') r += Math.sin(S.time * 4 + c.phase) * 1.2;
    else r *= 1 - 0.4 * Math.min(1, c.t / COIN_FLY_DUR);
    const isGold = c.kind === 'gold';
    const isCiv = c.kind === 'civ'; // v165: collected civilian flying to its counter — pink, like the civilian itself
    ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isGold ? 'rgba(255, 200, 60, 0.22)' : isCiv ? 'rgba(244, 114, 182, 0.25)' : 'rgba(125, 211, 252, 0.25)';
    ctx.fill(); // glow
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = isGold ? '#f5b301' : isCiv ? CIV_PINK : '#7dd3fc';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isGold ? '#8a5b00' : isCiv ? '#be185d' : '#0369a1';
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill(); // shine
  }
  // Sparkles (v123, v124 rings, v125 dashes, v126 both): rings read as
  // raindrops, diamonds as sun glitter. Rings are two expanding white
  // circles, the second trailing the first by 35%; diamonds are
  // elongated warm-white glints fading in and out over their life.
  for (const s of (S.sparkles || [])) {
    const k = Math.min(1, s.t / s.life);
    if (k >= 1) continue;
    const px = (s.x + 0.5) * CELL_PX, py = (s.y + 0.5) * CELL_PX;
    if (s.kind === 'dash') {
      const a = Math.sin(Math.PI * k);
      if (a <= 0) continue;
      const cy = py + (s.dy || 0), len = s.len || 8, h = len * 0.3;
      ctx.globalAlpha = 0.95 * a;
      ctx.fillStyle = '#fef3c7'; // warm white, like sun glitter
      ctx.beginPath();
      ctx.moveTo(px - len / 2, cy);
      ctx.lineTo(px, cy - h);
      ctx.lineTo(px + len / 2, cy);
      ctx.lineTo(px, cy + h);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    // Ring (default, also for old sparkle objects without a kind).
    const ring = (kk, a) => {
      if (kk < 0 || kk > 1) return;
      ctx.globalAlpha = a * (1 - kk);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 2 + kk * CELL_PX * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    };
    ring(k, 0.8);
    ring((k - 0.35) / 0.65, 0.5); // trailing ring, 35% behind
    ctx.globalAlpha = 1;
  }
  // Digger flags: each blue digger's target cell gets a little flag
  // (gold for gold, white for a cave) so you can see where it's headed.
  // Drawn after the fog, like coins, so flags in unexplored ground shine through.
  for (const t of S.turrets) {
    if (t.dead || t.color !== BLUE || t.type !== 'mole' || !t.flag) continue;
    const fx = (t.flag.x + 0.5) * CELL_PX, fy = (t.flag.y + 0.5) * CELL_PX;
    ctx.strokeStyle = '#0b0e16';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(fx - 3, fy + 6); ctx.lineTo(fx - 3, fy - 6); ctx.stroke(); // pole
    // Gold flag = gold, civilian flag = pink (v136, rescue target),
    // cave flag = white.
    ctx.fillStyle = t.flagKind === 'gold' ? '#ffd75e' : (t.flagKind === 'civ' ? CIV_PINK : '#ffffff');
    ctx.beginPath();
    ctx.moveTo(fx - 3, fy - 6); ctx.lineTo(fx + 5, fy - 3); ctx.lineTo(fx - 3, fy - 1);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore(); // ---- end world pass; screen pass below (chip, floaters) ----
  // Rescue arrow (v173, survival only): Vampire-Survivors-style edge
  // arrow to the nearest cave with waiting civilians. Hidden when the
  // cave is on screen; the world ? covers the fogged case.
  if (SURVIVAL) {
    const ar = rescueArrow();
    if (ar) {
      const pulse = 0.75 + 0.25 * Math.sin(S.time * 4);
      ctx.save();
      ctx.translate(ar.x, ar.y);
      ctx.rotate(ar.angle);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = CIV_PINK;
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-10, -11); ctx.lineTo(-4, 0); ctx.lineTo(-10, 11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
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
  ctx.fillText('× ' + S.gold, CHIP_CX - chw / 2 + 26, CHIP_CY + 1);
  ctx.restore();
  // Civilians counter chip (v165, survival only): right next to the
  // gold chip, same size and style, pink dot instead of a gold coin.
  // Pops when a rescued civilian's fly arrives at it.
  if (SURVIVAL) {
    const cpulse = S.civChipPulse || 0;
    ctx.save();
    ctx.translate(CIV_CHIP_CX, CIV_CHIP_CY);
    const ccs = 1 + 0.3 * cpulse;
    ctx.scale(ccs, ccs);
    ctx.translate(-CIV_CHIP_CX, -CIV_CHIP_CY);
    ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
    rr(CIV_CHIP_CX - chw / 2, CIV_CHIP_CY - chh / 2, chw, chh, 8); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#2a3145';
    rr(CIV_CHIP_CX - chw / 2, CIV_CHIP_CY - chh / 2, chw, chh, 8); ctx.stroke();
    ctx.beginPath(); ctx.arc(CIV_CHIP_CX - chw / 2 + 14, CIV_CHIP_CY, 7, 0, Math.PI * 2);
    ctx.fillStyle = CIV_PINK; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#be185d'; ctx.stroke();
    ctx.fillStyle = '#dfe5f2';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('× ' + (S.rescue ? S.rescue.rescued : 0), CIV_CHIP_CX - chw / 2 + 26, CIV_CHIP_CY + 1);
    ctx.restore();
  }
  // Stat chips start under the gold chip (no passive badges anymore —
  // Bounce removed v106, Penetration is a stat row, not a badge).
  let ppy = CHIP_CY + 32;
  // Stat chips, top-left: one row per owned weapon stat. Each row: weapon
  // icon + 4-letter stat label + chips (gold filled / dark empty). This
  // is the progress bar you watch climb — one chip per stat pick.
  // A stat with no picks yet (level 0) hides its row entirely — the
  // corner only shows stats you've actually invested in, and a stat
  // card shows New! on its first pick (see offerCards).
  const STAT_LABEL = { dmg: 'DAMG', proj: 'PROJ', rate: 'RATE', pen: 'PENE', growth: 'GROW', field: 'FLD', count: 'CNTS', dig: 'DIGS', reinforce: 'WALL', shield: 'SHLD' };
  for (const type of ['cannon', 'bloom', 'gather', 'mole', 'wall', 'laser']) {
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
      } else if (type === 'wall') {
        // v182: small grey wall block (two stacked bricks).
        ctx.fillStyle = '#9ca3af';
        ctx.fillRect(14, iy - 5, 12, 10);
        ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 1;
        ctx.strokeRect(14, iy - 5, 12, 10);
        ctx.beginPath(); ctx.moveTo(20, iy - 5); ctx.lineTo(20, iy + 5); ctx.moveTo(14, iy); ctx.lineTo(26, iy); ctx.stroke();
      } else if (type === 'laser') {
        // v186: diamond, matching ICONS.laser.
        ctx.beginPath();
        ctx.moveTo(20, iy - 6); ctx.lineTo(26, iy); ctx.lineTo(20, iy + 6); ctx.lineTo(14, iy);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#dfe5f2';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(STAT_LABEL[d.key] || d.key.toUpperCase(), 30, iy + 1);
      for (let i = 0; i < d.cap; i++) {
        ctx.beginPath();
        // Field (v136 cap 9, v138 cap 12) squeezes chips so the row
        // still fits its 122px box: 7px at cap 9, 5px at cap 12;
        // other tracks keep 7.5px.
        ctx.arc(60 + i * (d.cap > 10 ? 5 : d.cap > 8 ? 7 : 7.5), iy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = i < lvl ? '#ffd75e' : '#2a3145';
        ctx.fill();
      }
      ppy += bh + 4;
    }
  }
  // v184: Magnet (a passive, not a weapon stat) gets the same row
  // once picked — Sam: it wasn't showing in the top-left corner
  // like the other upgrades. Same 122x18 row, horseshoe icon,
  // 'MGNT' label, one chip per level (cap 8).
  const mgLvl = magnetLevel();
  if (mgLvl > 0) {
    const bw = 122, bh = 18;
    ctx.fillStyle = 'rgba(10, 13, 22, 0.85)';
    rr(8, ppy, bw, bh, 6); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#2a3145';
    rr(8, ppy, bw, bh, 6); ctx.stroke();
    const iy = ppy + bh / 2;
    // Horseshoe magnet (matches ICONS.magnet): red U, pale pole tips.
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(24.5, iy - 5); ctx.lineTo(24.5, iy + 1);
    ctx.arc(20, iy + 1, 4.5, 0, Math.PI);
    ctx.lineTo(15.5, iy - 5);
    ctx.stroke();
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(13.5, iy - 6, 4, 3);
    ctx.fillRect(22.5, iy - 6, 4, 3);
    ctx.fillStyle = '#dfe5f2';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('MGNT', 30, iy + 1);
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(60 + i * 7.5, iy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i < mgLvl ? '#ffd75e' : '#2a3145';
      ctx.fill();
    }
    ppy += bh + 4;
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
// v154 place bar: one button per placement type, icon + current gold
// cost, hidden until unlocked, dimmed when unaffordable, gold-ringed
// while its placement mode is active. Buttons are looked up by id
// (pb-<type>) so the harness stub can provide them; a missing button
// is skipped, never thrown on.
const placeBtns = {};
function initPlaceBar() {
  for (const t of PLACEBAR_TYPES) {
    try { placeBtns[t] = document.getElementById('pb-' + t); } catch (e) { placeBtns[t] = null; }
    const btn = placeBtns[t];
    if (!btn) continue;
    const entry = CARD_POOL.find(c => c.kind === 'turret' && c.type === t);
    // v175: build the button's spans ONCE and keep references to them.
    // updatePlaceBar used to rewrite btn.innerHTML on every HUD refresh
    // (~30x/s), destroying the icon/cost spans under the pointer mid-tap
    // — a real tap then lost its click (the pointerdown target was gone
    // before pointerup) while a synthetic .click() still worked, which
    // is exactly the v174 bar-tap bug. Now only the cost number and the
    // classes change; the spans themselves never move.
    const picon = document.createElement('span');
    picon.className = 'picon';
    picon.innerHTML = entry ? entry.icon : '';
    const pcost = document.createElement('span');
    pcost.className = 'pcost';
    const costNum = document.createElement('span');
    costNum.className = 'pcost-num';
    const coin = document.createElement('span');
    coin.className = 'coin';
    pcost.appendChild(costNum);
    pcost.appendChild(coin);
    btn.appendChild(picon);
    btn.appendChild(pcost);
    btn._picon = picon;
    btn._costNum = costNum;
    btn.addEventListener('click', () => onPlaceBtn(t));
  }
  updatePlaceBar();
}
// Unlock fly (v174): when a unit is unlocked for the first time, its
// icon flies from the picked card to its button in the bottom bar —
// the same accelerating lerp as the coin zip (e = k*k, same 0.45s),
// so you learn where the unit lives now. Driven by update(dt), like
// the coin flies. Every DOM touch is guarded: in environments without
// real geometry (the harness stubs) the animation just doesn't run,
// and the unlock itself is unaffected.
const unlockFlies = [];
function cardIconCenter(card) {
  // Centre of the card's icon, in viewport px — captured before the
  // overlay hides. Falls back to the card centre, then null when the
  // DOM gives no geometry.
  try {
    const icon = card && card.querySelector ? card.querySelector('.icon') : null;
    const el = icon || card;
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r || !r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } catch (e) { return null; }
}
function startUnlockFly(type, from) {
  if (!from) return;
  const btn = placeBtns[type];
  if (!btn || typeof btn.getBoundingClientRect !== 'function') return;
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
  const r = btn.getBoundingClientRect();
  if (!r || !r.width) return;
  const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const icon = (CARD_POOL.find(c => c.kind === 'turret' && c.type === type) || {}).icon || '';
  const el = document.createElement('div');
  el.className = 'unlock-fly';
  el.innerHTML = `<span class="picon">${icon}</span>`;
  el.style.left = from.x + 'px';
  el.style.top = from.y + 'px';
  document.body.appendChild(el);
  unlockFlies.push({ el, btn, x0: from.x, y0: from.y, x1: to.x, y1: to.y, t: 0 });
}
function updateUnlockFlies(dt) {
  for (let i = unlockFlies.length - 1; i >= 0; i--) {
    const f = unlockFlies[i];
    f.t += dt;
    const k = Math.min(1, f.t / COIN_FLY_DUR);
    const e = k * k; // same accelerating lerp as the coin zip
    const x = f.x0 + (f.x1 - f.x0) * e, y = f.y0 + (f.y1 - f.y0) * e;
    if (f.el && f.el.style) { f.el.style.left = x + 'px'; f.el.style.top = y + 'px'; }
    if (k >= 1) {
      unlockFlies.splice(i, 1);
      if (f.el) {
        if (typeof f.el.remove === 'function') f.el.remove();
        else if (f.el.parentNode && typeof f.el.parentNode.removeChild === 'function') f.el.parentNode.removeChild(f.el);
      }
      // Land: pop the bar button so the eye catches where it went.
      if (f.btn && f.btn.classList) {
        f.btn.classList.add('just-unlocked');
        setTimeout(() => { if (f.btn && f.btn.classList) f.btn.classList.remove('just-unlocked'); }, 600);
      }
    }
  }
}
function updatePlaceBar() {
  if (!S || !S.unlocked) return;
  for (const t of PLACEBAR_TYPES) {
    const btn = placeBtns[t];
    if (!btn) continue;
    const unlocked = !!S.unlocked[t];
    btn.classList.toggle('hidden', !unlocked);
    if (!unlocked) continue;
    const cost = unitCost(t);
    // v175: never rewrite innerHTML here (see initPlaceBar) — only the
    // cost number changes. The old rewrite is kept as a fallback for a
    // button whose spans were never built (defensive; init covers all).
    if (btn._costNum) btn._costNum.textContent = String(cost);
    else btn.innerHTML = `<span class="picon">${(CARD_POOL.find(c => c.kind === 'turret' && c.type === t) || {}).icon || ''}</span><span class="pcost">${cost}<span class="coin"></span></span>`;
    btn.classList.toggle('unaffordable', S.gold < cost);
    btn.classList.toggle('active', !!(S.placing && S.placing.type === t));
  }
}
// Tap a place-bar button: if its placement mode is already active,
// cancel it; if another type is active, switch to this one; if you
// can't afford it, do nothing (the dimmed button already says so).
function onPlaceBtn(type) {
  if (!S || !S.unlocked || !S.unlocked[type]) return;
  if (S.placing && S.placing.type === type) { cancelPlacement(); return; }
  if (S.gold < unitCost(type)) return;
  if (S.teleporting) return;
  enterPlacement(type);
  S.placing.fromBar = true;
  // v192: the dig bundle is gone — buying a Digger no longer gives
  // +1 dig (that's how damage crept to 2 at level 1). Dig comes
  // from the XP track only now. moleBundle stays false so the swap
  // handler has nothing to undo.
  S.placing.moleBundle = false;
  S.placing.cost = unitCost(type);
  updatePlaceBar();
}
function updateHud() {
  const lvl = S.level;
  // While cards show, the bar measures against the frozen threshold that
  // was just met (so it reads full), not the new level's higher need.
  const need = S.levelUpNeed || xpNeed();
  const pct = Math.min(1, Math.max(0, S.xpShown / need));
  // Run timer (play time, pauses excluded) after the level + XP counts.
  const tsec = Math.floor(S.time || 0);
  const timer = `${Math.floor(tsec / 60)}:${String(tsec % 60).padStart(2, '0')}`;
  // Threat countdown (survival, grace only): time until the attack
  // starts, counting down from the grace duration (3:00). Short +
  // vague on purpose ("threat", not "flood"), yellow, inside the XP
  // bar next to the run timer. Hidden once grace ends — the attack
  // itself is visible from there, no warning needed.
  let threat = '';
  if (SURVIVAL && S.flood && S.flood.phase === 'grace') {
    const gsec = Math.max(0, Math.ceil(S.flood.timer));
    threat = ` &nbsp;·&nbsp; <span style="color:#ffd75e">${Math.floor(gsec / 60)}:${String(gsec % 60).padStart(2, '0')} threat incoming!</span>`;
  }
  const label = `LV ${lvl} &nbsp;·&nbsp; ${Math.floor(S.xpShown)}/${need} XP &nbsp;·&nbsp; ${timer}${threat}`;
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
    `<div>Harvester: <b>${gatherCount()} per stop</b></div>` +
    `<div>Weapons: <b>${Object.entries(S.weapons).filter(([, w]) => w).map(([k, w]) => `${k} ${w.stats ? Object.entries(w.stats).map(([s, n]) => `${s} ${n}`).join('/') : ''} (×${w.rateMult.toFixed(2)} rate, +${w.dmgBonus} dmg${w.critChance ? `, ${Math.round(w.critChance * 100)}% crit` : ''}${w.proj ? `, +${w.proj} proj` : ''})`).join(' · ')}</b></div>` +
    `<div>Projectiles alive: <b>${S.projs.length}</b> · Missiles: <b>${S.missiles.length}</b></div>` +
    `<div>Pickups: <b>${S.coins.length}</b> on field · Gold this run: <b>${S.gold}</b> · Total: <b>${meta.gold}</b> · Red bank: <b>${S.redGold || 0}</b> (next mole <b>${redMoleCost()}</b>)</div>`;
  updatePlaceBar(); // v154: costs/affordability follow gold, which changes outside level-ups now
}

// ---- Main loop ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!S.paused) update(dt);
  stepRescueCeleb(dt); // camera swoop to a discovered cave (runs while paused)
  checkRescueDiscovery(); // first fog-clear over a waiting site starts one
  render();
  S.frame++;
  if (S.frame % 2 === 0 || S.paused) updateHud(); // XP bar stays live
  if (S.frame % 6 === 0) drawMinimap(); // territory map, throttled
  if (S.frame % 30 === 0) checkWin(); // win check, throttled
  stepLvParticles(dt); // celebration rain while cards show (also when paused)
  stepRescueParticles(dt); // pink rain while the rescue overlay shows
  requestAnimationFrame(frame);
}

// ---- Debug wiring: any change restarts the game ----
[inCols, inRows, inSpeed, inFreq, inArc, inTurn, inCave, inCoin, inSeed,
 inPopHold, inPopDur, inPopPush, inRipple, inTrail, inGravity].forEach(el => {
  el.addEventListener('change', newGame);
});
document.getElementById('d-restart').addEventListener('click', newGame);
document.getElementById('d-jumpflood').addEventListener('click', debugJumpToFlood);

// ---- Camera controls: 1-finger drag pans, 2-finger pinch zooms, tap hits coins ----
// touch-action:none on the canvas stops the page scrolling/zooming underneath.
function tapCoin(sx, sy) {
  const wpt = screenToWorld(sx, sy);
  const cx = wpt.x / CELL_PX, cy = wpt.y / CELL_PX;
  for (let i = S.coins.length - 1; i >= 0; i--) {
    const c = S.coins[i];
    if (c.state !== 'idle') continue;
    if (coinFogged(c)) continue; // v166: fogged coins cannot be tapped
    const dx = c.x - cx, dy = c.y - cy;
    if (dx * dx + dy * dy < 0.81) { // 0.9-cell tap radius
      c.state = 'fly'; c.sx = c.x; c.sy = c.y; c.t = 0;
      return true;
    }
  }
  return false;
}
// Waypoint removal (not requested, but a misplaced waypoint would
// otherwise hijack a cannon's aim for the whole run): tap the exact
// waypoint cell during normal play to remove it, free. Placement taps
// never remove (they refuse duplicates with a red ring instead), so
// removal never charges gold. Last removal reverts BLUE cannons to
// straight-up aim on survival (v180: all cannons aim up), map-centre
// on main — so placing and removing a waypoint does not silently
// change a cannon's aim.
function tryWaypointRemove(sx, sy) {
  if (!S.waypoints || !S.waypoints.length) return false;
  const wpt = screenToWorld(sx, sy);
  const cx = Math.floor(wpt.x / CELL_PX), cy = Math.floor(wpt.y / CELL_PX);
  const idx = S.waypoints.findIndex(w => w.x === cx && w.y === cy);
  if (idx < 0) return false;
  S.waypoints.splice(idx, 1);
  spawnBurst(cx + 0.5, cy + 0.5, '#9ca3af'); // grey puff: marker gone
  if (!S.waypoints.length) {
    for (const t of S.turrets) {
      if (!t.dead && t.color === BLUE && t.type === 'cannon') {
        // v180: all cannons revert to straight up on survival (the
        // starter is no longer special — every cannon aims up);
        // map-centre aim on main, as at placement.
        t.base = SURVIVAL ? -Math.PI / 2
          : Math.atan2(cfg.rows / 2 - t.y, cfg.cols / 2 - t.x);
      }
    }
  }
  return true;
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
      // v149: in View map mode, taps assess only — no coin collect,
      // no waypoint removal, no debug chip. Pan/pinch already ran
      // in pointermove, so this guard only blocks the tap actions.
      if (overlay.classList.contains('mapview')) { /* assess only */ }
      else if (S.placing) placeTurretAt(downPos.x, downPos.y); // placement eats the tap
      else if (S.teleporting) handleTeleportTap(downPos.x, downPos.y); // teleport eats the tap
      else if (tryChipDoubleTap(downPos.x, downPos.y)) { /* debug level grant */ }
      else if (!tapCoin(downPos.x, downPos.y)) tryWaypointRemove(downPos.x, downPos.y); // coin first (a coin on a waypoint collects, it does not remove it), then free waypoint removal
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

// ---- Auto camera toggle (v153 try-it): one tap, gold when on, off again on tap.
// Persists across runs in a session via S.autoCam in newGame; default off.
const cambtn = document.getElementById('cambtn');
function syncCamBtn() {
  if (!cambtn) return;
  if (S && S.autoCam) cambtn.classList.add('on'); else cambtn.classList.remove('on');
}
if (cambtn) {
  cambtn.addEventListener('click', () => {
    if (!S) return;
    S.autoCam = !S.autoCam;
    syncCamBtn();
  });
}

// ---- Minimap toggle (v180): hidden since v173, back as a button ----
// Map (top-right) shows the minimap; the × in its corner hides it
// again and brings the Map button back. The % stats stay top-left
// either way; the canvas keeps drawing while hidden, so showing it
// is instant. The double-tap fog x-ray on the canvas works again
// while it is shown.
const mapbtn = document.getElementById('mapbtn');
const mapmin = document.getElementById('mapmin');
const minimapWrap = document.getElementById('minimap-wrap');
if (mapbtn && minimapWrap) {
  mapbtn.addEventListener('click', () => {
    minimapWrap.style.display = 'block';
    mapbtn.style.display = 'none';
  });
}
if (mapmin && minimapWrap) {
  mapmin.addEventListener('click', () => {
    minimapWrap.style.display = 'none';
    if (mapbtn) mapbtn.style.display = '';
  });
}

// ---- Share link: encode the whole debug config into the URL ----
function applyUrlParams() {
  if (typeof location === 'undefined' || !location.search) return;
  const q = new URLSearchParams(location.search);
  const map = { cols: inCols, rows: inRows, speed: inSpeed, freq: inFreq, arc: inArc,
    turn: inTurn, cave: inCave, seed: inSeed, coin: inCoin,
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
    turn: cfg.turnRate, cave: cfg.caveChance, seed: inSeed.value.trim(), coin: cfg.coinChance,
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
  renderShopToggles();
  renderPerma();
}
function renderShopToggles() {
  // Start-screen shop toggles: click to include/exclude a placement
  // from the run's shop (survival only; main is frozen). Missing =
  // enabled (all on by default). The starter cannon is always placed
  // even if cannon is toggled off — the toggle only stops the shop
  // offering cannon duplicates, it never removes the starter.
  const types = ['cannon', 'mole', 'bloom', 'gather', 'lantern', 'wall', 'laser', 'waypoint'];
  for (const type of types) {
    const b = document.getElementById('toggle-' + type);
    if (!b) continue;
    const enabled = !(meta && meta.enabled && meta.enabled[type] === false);
    b.classList.toggle('disabled', !enabled);
    if (!b.dataset.bound) {
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        if (!meta.enabled) meta.enabled = {};
        const enabledNow = meta.enabled[type] !== false; // missing = enabled
        meta.enabled[type] = !enabledNow;
        saveMeta();
        renderShopToggles();
      });
    }
  }
}
function renderPerma() {
  // Perma stat cards: click to add a level (up to 4, then no-op),
  // shown as little circles (filled = level). Reset clears all perma
  // levels (not item toggles) — the VS-style sell-all.
  const defs = [
    { id: 'perma-dmg', key: 'dmg', title: 'Damage', sub: '+1 base damage, +5% crit per level' },
    { id: 'perma-rate', key: 'rate', title: 'Fire Rate', sub: '+25% base fire rate per level' },
  ];
  for (const d of defs) {
    const b = document.getElementById(d.id);
    if (!b) continue;
    const lv = (meta.perma && meta.perma[d.key]) || 0;
    let pips = '';
    for (let i = 0; i < 4; i++) pips += `<span class="pip${i < lv ? ' on' : ''}"></span>`;
    b.innerHTML = `<b>${d.title}</b><div class="permasub">${d.sub}</div><div>${pips}</div>`;
    if (!b.dataset.bound) {
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        if (!meta.perma) meta.perma = { dmg: 0, rate: 0 };
        if (meta.perma[d.key] < 4) { meta.perma[d.key]++; saveMeta(); renderPerma(); }
      });
    }
  }
  const r = document.getElementById('perma-reset');
  if (r && !r.dataset.bound) {
    r.dataset.bound = '1';
    r.addEventListener('click', () => {
      meta.perma = { dmg: 0, rate: 0 };
      saveMeta(); renderPerma();
    });
  }
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
// DISABLED 2026-11-01 (v126, Sam: tapping Prepare every run is
// annoying) — showCommander is now a no-op, so Start Run and Dive
// Again go straight into play. The dialog code and markup are kept
// intact so it can come back by flipping this flag.
const COMMANDER_INTRO_ENABLED = false;
function showCommander() {
  if (!COMMANDER_INTRO_ENABLED) return;
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

// Random map size (v127, v128 range, v143 minimum: Sam: 100–200 was
// really big, then 50–100, then max 150 after a 140 map felt about
// the large limit — so now 50–150, then minimum raised to 75): on
// page load, width and height each roll 75–150 cells, so every
// refresh is a new world, bigger than the old fixed 75x50 but not as
// huge as v127's 100–200.
// Explicit URL sizes (share links, ?cols=&rows=) are respected —
// randomize only the dimensions the URL didn't set. Start Run and
// Dive Again keep the session's size (readDebug reads the panel),
// so the debug panel still controls size within a session; refresh
// the page for a new roll.
function randomizeMapSize() {
  let qCols = false, qRows = false;
  try {
    if (typeof location !== 'undefined' && location.search) {
      const q = new URLSearchParams(location.search);
      qCols = q.has('cols'); qRows = q.has('rows');
    }
  } catch (e) { /* no URL API (harness): randomize both */ }
  // v163: vertical maps — narrow and tall, so the run is a climb.
  // v167: width was FIXED at 60 columns, no randomisation (was
  // 75–100 random, average ~87 — Sam: the map doesn't need to be so
  // big, you're never going to explore all of it, and a narrower map
  // caps how far out the camera can zoom and concentrates the enemy
  // shots from below). v179 (Sam, 2026-11-09): 75 columns — wider
  // again, so the coast has room to breathe and the shoreline slopes
  // can run longer. Still narrower than the old ~87 average.
  // Rows are 175–250 random (v199: was 140–200 — the level got
  // taller for five biomes instead of four, so each band keeps its
  // old height of ~35–50 rows; panel size, newGame still adds the
  // bottom-ocean extra rows on top, so a real map is taller still).
  // Biomes (see newGame) split the height into fifths.
  // ?cols= in the URL still overrides the fixed width.
  if (!qCols) inCols.value = 75;
  if (!qRows) inRows.value = 175 + Math.floor(Math.random() * 76);
}

applyUrlParams();
// v162: ?tiles=1 brings the shelved tiles back, ?tiles=0 keeps them
// off — no code change needed to try them again later.
try {
  if (typeof location !== 'undefined' && location.search) {
    const q = new URLSearchParams(location.search);
    if (q.get('tiles') === '1') TILES_ENABLED = true;
    if (q.get('tiles') === '0') TILES_ENABLED = false;
  }
} catch (e) { /* no URL API (harness): tiles stay shelved */ }
randomizeMapSize();
loadMeta();
applyTeamColors(); // before first run: stored preference, else branch look (survival red, main blue)
initPlaceBar(); // v154: bottom bar buttons (needs CARD_POOL + ICONS, both built above)
newGame();
S.paused = true; // behind the start screen until the player picks a starter
renderStartScreen();
document.getElementById('startscreen').classList.remove('hidden');
requestAnimationFrame(frame);
