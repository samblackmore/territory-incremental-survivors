# Territory Incremental Survivors

Prototype: **Color Smash**-style excavation meets **Vampire Survivors**-style
incremental leveling, as an **auto-battler**. Your blue **Cannon** spawns inside
a **cave** and chips away at blocks that have **HP**: a smooth Perlin-noise
gradient makes light-green regions weak (~3 hits) and dark-green regions strong
(~10 hits) — the base green and the cave brown are both tunable via color
pickers in the debug panel. Hits tint blocks progressively toward the attacker's
color, every hit chips off little particle squares and pops a retro damage
number, and destroying a block excavates it into open (brown) void.
Cellular-automata **caves** carve the blobby voids the turrets live in, and
projectiles fly through open space. Excavating a block as blue can drop a
**coin** — tap it and it zips up to the coin counter in the top-left with a
satisfying pop, granting 1 XP (still called XP for now). Every few seconds
(auto-collect interval) the nearest idle coin zips into your nearest turret
for a free +1.

**Fog of war.** The map starts black except for the cave holding your first
turret (plus a tunable reveal distance and a 1-cell half-fog smoothing ring).
All units must be placed on fully-revealed cells. The **Lantern** (a new
placeable unit) sits on any visible ground — empty or terrain — and pushes
the fog back in a radius around it.

**Turrets, not cannons.** Leveling up offers 3 cards: 5 turret types
(**Cannon** — sweeping shots; **Rocket** — homing missiles with a limited turn
rate that weave through caves and crash-splash into walls; **Laser** — hitscan
zaps that always snipe the weakest *visible* block; **Bloom** — Tiberium-style
territory: every 5s it grows one increment on the nearest open *visible* cell,
10 increments bloom it into solid blue territory with a pop-in dot animation;
**Lantern** — clears fog around it) plus upgrades (fire rate, damage, bounce
chance, suction time, missile steering, bloom speed). Picking a turret card
enters **placement mode**: tap a revealed cell to deploy it (combat units and
Blooms need open ground; Lanterns take empty or terrain). Turrets have HP and
die. Enemy units are **disabled for now** while the early game takes shape —
red waves, the coin jackpot, and the run-over screen are parked behind
`ENEMIES_ENABLED`. Territory generates coins on harvest ticks. The canvas
fills the viewport with a pan/pinch camera (1-finger drag pans, 2-finger
pinch zooms, always crisp); new games start fully zoomed out.

## Run it

- **Locally:** just open `index.html` in a browser — no build step.
- **GitHub Pages:** repo Settings → Pages → *Deploy from a branch* → `main` / `/(root)`,
  then open `https://samblackmore.github.io/territory-incremental-survivors/`.

## Debug panel

Everything gameplay-related is tunable in the Debug sidebar; changing any value
restarts the game:

- Grid width / height (cells)
- Projectile speed (px/s)
- Fire frequency (shots/s, applies to both cannons; level-up cards multiply the player's)
- Cannon turn arc (degrees, max 360 = continuous spin)
- Cannon turn speed (deg/s)
- Bounce chance (probability a surviving block ricochets the projectile)
- Cave amount (cellular-automata cave fill, 0–0.95)
- Map seed (blank = random; the stats line shows the seed in use)
- Coin drop chance (probability per block excavated by blue)
- Auto-collect interval (seconds between free coin collections, 0 = off)
- Level thresholds (XP per level, comma-separated)
- Hit feel: pop hold/shrink time, knockback push, neighbor ripple, projectile
  trail, particle gravity
- Colors: terrain base color (green) and empty base color (brown) pickers
- Fog of war: fog reveal distance (cells)
- **Copy share link**: encodes the whole config into a URL — open it anywhere
  and the panel prefills with the same tune

The panel also shows live stats: wall/open cell counts, blocks excavated,
effective fire rate, and projectiles alive.
