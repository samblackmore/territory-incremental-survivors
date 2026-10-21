# Territory Incremental Survivors

Prototype: **Color Smash**-style territory painting meets **Vampire Survivors**-style
incremental leveling. A blue player cannon and a red enemy cannon sweep their aim
arcs and fire projectiles at blocks that have **HP**: a smooth Perlin-noise
gradient makes white regions weak (~3 hits) and dark-grey regions strong
(~10 hits), hits tint blocks progressively toward the attacker's color, and every
hit chips off little particle squares. Cellular-automata **caves** carve blobby
voids that projectiles fly through. Converting a block to blue can drop a
**coin** — tap it and it zips up to the coin counter in the top-left with a
satisfying pop, granting 1 XP (still called XP for now). Leveling up offers a
choice of 3 fire-rate upgrade cards.

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
- Cave amount (cellular-automata cave fill, 0–0.95)
- Map seed (blank = random; the stats line shows the seed in use)
- Coin drop chance (probability per blue conversion)
- Level thresholds (XP per level, comma-separated)

The panel also shows live stats: blue/red/white/empty cell counts, effective fire
rate, and projectiles alive.
