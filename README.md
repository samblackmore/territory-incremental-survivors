# Territory Incremental Survivors

Prototype: **Color Smash**-style territory painting meets **Vampire Survivors**-style
incremental leveling. A blue player cannon and a red enemy cannon sweep their aim
arcs and fire projectiles that paint white cells their color (grey empty cells are
passed through). Every cell painted blue earns 1 XP; leveling up offers a choice of
3 fire-rate upgrade cards.

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
- Empty-cell chance (grey cells that projectiles pass through)
- Level thresholds (XP per level, comma-separated)

The panel also shows live stats: blue/red/white/empty cell counts, effective fire
rate, and projectiles alive.
