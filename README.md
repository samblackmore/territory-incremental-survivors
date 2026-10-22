# Territory Incremental Survivors

Prototype: **Color Smash**-style excavation meets **Vampire Survivors**-style
incremental leveling. A blue player cannon and a red enemy cannon spawn inside
**caves**, sweep their aim arcs, and chip away at blocks that have **HP**: a
smooth Perlin-noise gradient makes white regions weak (~3 hits) and dark-grey
regions strong (~10 hits). Hits tint blocks progressively toward the attacker's
color, every hit chips off little particle squares and pops a retro damage
number, and destroying a block excavates it into open void. Cellular-automata
**caves** carve the blobby voids the cannons live in, and projectiles fly
through open space. Excavating a block as blue can drop a **coin** — tap it and
it zips up to the coin counter in the top-left with a satisfying pop, granting
1 XP (still called XP for now). Every few seconds (auto-collect interval) the
nearest idle coin zips into your cannon for a free +1. Leveling up offers a
choice of 3 upgrade cards: fire rate, bounce chance, or faster suction. The
canvas fills the viewport with a pan/pinch camera (1-finger drag pans,
2-finger pinch zooms, always crisp).

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
- **Copy share link**: encodes the whole config into a URL — open it anywhere
  and the panel prefills with the same tune

The panel also shows live stats: wall/open cell counts, blocks excavated,
effective fire rate, and projectiles alive.
