# Haxball Live Tactical Overlay

Personal project: computer-assisted analysis on top of live Haxball games (line of sight, heatmaps, passing lanes, and similar decision-support overlays), built as a fork of the official-ish open-source Haxball client.

**Status: data layer done, first live overlay feature (momentum/direction arrows) built and confirmed working, plus a shared overlay control menu (master authority + per-feature toggles + team filter).** See [Status / Next Steps](#status--next-steps).

## Base codebase

- **[node-haxball](https://github.com/wxyz-abcd/node-haxball)** — the underlying engine/API. Reimplements Haxball's networking, physics, and room protocol in JS. We consume its `Room`, `Stadium`, `Disc`/`Player` objects read-only; nothing here modifies the engine itself.
- **[node-haxball-client](https://github.com/wxyz-abcd/node-haxball-client)** — the desktop client we forked (React 19 + Vite + NW.js + PIXI.js). This is the actual app we run (`npm run dev`); it provides room join/create UI, rendering, chat, etc. Our data layer and overlay are wired into its existing `Game.jsx` and `renderer.js`.

## Domain notes (how Haxball actually works — read before writing analytics)

These came out of discussion before building anything, and every analytics/overlay decision needs to respect them:

- **Players have no orientation, ever.** Confirmed directly from node-haxball's own type declarations — `Player`/`Disc`/`MovableDisc` have no `angle`/`heading`/`facing` field of any kind. A player is a circle with a position and a velocity, nothing more.
- **"Facing" only exists at the moment of a kick, and only then.** When a player is in kick range of the ball, the kick direction is the straight line through the player's center and the ball's center at that instant — that geometry *is* the direction, not a stored heading. Off the ball, "facing" is undefined, not fuzzy or approximate — there's nothing to infer it from, and nothing should try.
- **Everything has width — treat it as circles, not points.** Players and the ball both have a live `radius` (map-dependent, read fresh every tick, never hardcoded). Segments/planes are zero-width collision lines with no "wall thickness" field; the effective collision boundary against one is that segment/plane's position offset outward by whichever disc's radius is approaching it (subject to `cMask`/`cGroup` matching). Any future LOS ray or passing lane needs to account for the ball's/players' actual radius, not treat them as infinitely thin points or lines.

## What's built

Lives in `src/features/analytics/` (data + overlay logic) and `src/features/game/components/` (overlay UI), wired into `src/features/game/Game.jsx` and (for the camera transform) `src/features/game/renderer.js`.

| File | Purpose | Permanent or debug-only? |
|---|---|---|
| `gameStateExtractor.js` | Converts node-haxball's live `room` object into clean, normalized snapshots (stadium geometry once per map, player/ball state every tick). | **Permanent.** Everything else depends on this. |
| `useHaxballAnalytics.js` | React hook wiring the extractor into the live `room` via `onAfterGameTick`. Tick-rate home for heavier, non-visual-critical analytics (LOS, passing lanes, logging). | **Permanent** (scaffolding). Its *contents* will grow. |
| `momentumOverlay.js` | Direction-only movement arrows for in-game players and the ball — the first live overlay feature. Render-rate, not tick-rate (see below). Team-filterable (see [Overlay controls](#overlay-controls-master-authority--per-feature-toggles--team-filter)). | **Permanent.** First piece of the actual overlay. |
| `components/OverlayControls.jsx` | Bottom-right menu: master `enabled` authority (separate from feature toggles) + independent per-feature checkboxes (registry: `OVERLAY_FEATURES`) + shared Red/Blue/Both team filter. | **Permanent.** Shared overlay infrastructure. |
| `snapshotLogger.js` | Writes tick-by-tick data to an NDJSON file + prints a console heartbeat, for validating the extractor and capturing sessions to test analytics offline. | **Debug tool.** Off by default (see [Logging toggle](#logging-toggle)). Not part of the live overlay's runtime path. |
| `loadSession.js` | Standalone offline helper — reads back an NDJSON session file and groups frames by which map/geometry was active. Never runs inside the live client. | **Debug/dev tool.** |

## Two different rates: tick-rate analytics vs. render-rate overlay

This distinction matters and shaped the momentum overlay's design:

- **Tick-rate** (`useHaxballAnalytics`, `onAfterGameTick`): fires once per physics simulation tick. Good for logging and for analytics that don't need to visually track a moving object every displayed frame.
- **Render-rate** (`onRequestAnimationFrame` in `renderer.js`, currently only used by the momentum overlay): fires once per *rendered* frame, which can run at a different rate than physics ticks. The game renderer itself re-extrapolates room state and recomputes the camera transform fresh every rendered frame — anything meant to visually sit on top of a moving player has to do the same, or it will visibly lag/desync.

### The camera transform (why the overlay is pixel-perfect)

`renderer.js` draws everything through a transform that updates every frame:
```
screenX = (mapX - cameraOrigin.x) * cameraScale + canvasWidth/2
screenY = (mapY - cameraOrigin.y) * cameraScale + canvasHeight/2
```
`cameraOrigin`/`cameraScale` were previously private closure variables inside `renderer.js`, inaccessible to anything outside it. We added a small, purely additive patch (6 lines, right after the camera updates each frame) exposing them as `thisRenderer.cameraOrigin`/`cameraScale`, so overlay code can reuse the game's own live transform instead of reimplementing the follow/zoom/clamp logic. Everything downstream — the momentum arrows, and any future overlay — reads these two values fresh every frame rather than caching or approximating them.

### Momentum overlay specifics

- **Direction only, no speed-based length.** Per design discussion: the point is seeing *which way* something is moving (backing off, charging forward, etc.), not encoding speed visually. Arrows are a fixed pixel length.
- **Players and the ball**, styled distinctly (ball defaults to gold, players to white) so they're distinguishable at a glance.
- **Adaptive "moderate" movement threshold**, not a hardcoded number — derived from the *current map's own* `playerPhysics` (`acceleration / (1 - damping)` as an estimated running speed). Players use ~35% of that as the cutoff; the ball uses a much smaller ~5%, since it has no acceleration/damping-driven "terminal speed" the way a self-propelled player does — it only decelerates via damping unless kicked, so its threshold just needs to filter out damping residue near a full stop, not gate on "clearly committed movement." Both are read live from the current stadium, never hardcoded, since player physics differ per map.
- **Ball access note:** there's no `getBall()`-equivalent on the extrapolated `RoomState` (only `getPlayer(id)`). The renderer itself reads the ball as `gameState.physicsState.discs[0]` — disc index 0 is always the ball, confirmed both from `renderer.js`'s own usage and node-haxball's `GameState.physicsState: World` type — so the overlay uses that exact same documented path.
- **Rendered on a separate `<canvas>`** layered exactly over the game canvas (not injected into the game's own PIXI scene graph, which gets destroyed/recreated on stadium changes and isn't exposed anyway), redrawn every `requestAnimationFrame` using the exposed camera transform.
- **Tunable at the call site in `Game.jsx`** or via defaults in `momentumOverlay.js`: threshold fractions (`estimateModerateSpeedThreshold`/`estimateBallSpeedThreshold`), and per-item style (`color`/`lengthPx`/`lineWidth` for players, `ballColor`/`ballLengthPx`/`ballLineWidth` for the ball) via the `style` argument to `drawMomentumArrows`.

## Overlay controls (master authority + per-feature toggles + team filter)

A bottom-right menu (`OverlayControls.jsx`) controls three independent things every overlay feature — momentum now, LOS/passing-lanes/etc. later — reads from the same place, rather than each building its own toggle:

- **`enabled`** — the master authority. Deliberately **decoupled** from `features`, not derived from or merged into it: it's a separate AND-gate checked on top of whatever the per-feature checkboxes say. Turn `enabled` off and a feature's checkbox can still show checked underneath — nothing computes or renders either way, canvas included. This was an explicit correction mid-build: an earlier version folded "on/off" into a single feature toggle when there was only one feature (momentum), which coupled "is the overlay system on" with "is this specific feature on" — those needed to be separable once more features arrived.
- **`features`** — a per-feature on/off map (`{ momentum: true, ... }`), each entirely independent of the others. Any combination — just momentum, just passing lanes, several at once, none — is directly expressible. Registered in `OverlayControls.OVERLAY_FEATURES` (`[{ key, label }, ...]`); the checkbox list renders itself from that array, so adding a new overlay feature later means one new registry entry + one matching default in `Game.jsx`'s initial state + one gating check in the draw loop — no UI rewrite. Feature checkboxes stay interactive regardless of `enabled`, so a feature can be pre-selected while the overlay is off and it's already configured when switched on.
- **`team`** — `"both" | 1 | 2` (red/blue, matching Haxball's own numeric team convention used everywhere else in this codebase). Shared across all features — one team filter, not one per feature. `getMomentumDirections` filters players by this; the ball is unaffected by it (it doesn't belong to a team) and only depends on `enabled` + the momentum feature toggle.

**Session-only, by design** — no persistence to player settings/localStorage. Resets to `{ enabled: true, team: "both", features: { momentum: true } }` every time the app opens.

**A React gotcha worth remembering if more controls get added here:** the render-loop callback (`onRequestAnimationFrame`) is created once, when the renderer is constructed — it does *not* re-run on every React render. Reading `overlaySettings` (a `useState` value) directly inside it would capture a stale snapshot from whenever the renderer was built, not the current value. Fixed by mirroring the state into a ref (`overlaySettingsRef`, kept in sync via a `useEffect`) and reading `.current` inside the callback instead. Any future overlay-settings field needs the same treatment.

**CSS lives appended to the end of `game.css`**, not a new file — this project only imports `game.css` and `fontello.css` globally (see `main.jsx`), so a separate stylesheet would've needed its own import wired up for no benefit.


## Logging toggle

`useHaxballAnalytics(roomRef, opts)` takes two independent flags:

- **`enabled`** (default `true`) — master switch for the whole hook: tick extraction, stadium-change detection, tick-rate analytics.
- **`logging`** (default `import.meta.env.DEV`) — controls *only* whether `SnapshotLogger` runs (NDJSON file + console heartbeat). Currently set explicitly in `Game.jsx`:
```js
useHaxballAnalytics(roomRef, { logging: false });
```
Flip to `{ logging: true }` whenever a session capture is needed, then back to `false` when done. With `logging: false`, `SnapshotLogger` is never constructed — no folder, no file, no console output — but tick extraction keeps running underneath regardless, since `enabled` (not `logging`) controls that.

## Setup

```bash
git clone <your fork url>
cd node-haxball-client
nvm use 22
npm install
npm run dev
```
Opens the actual NW.js desktop app (not a browser). Join/create a room, F12 for devtools console.

**Known gotcha:** if the game canvas is black on join but sound plays, disable WebGPU in Settings → Video (`webGPU` toggle) to fall back to the WebGL renderer — WebGPU texture allocation can fail silently on some Linux/driver combos.

## Status / Next steps

**Done:**
- Live data pipeline (extraction, per-tick player/ball state, per-map geometry, map-change handling, optional session recording).
- Momentum/direction overlay for players and the ball — first working live overlay feature, confirmed pixel-accurate against the game's own camera.
- Shared overlay control menu — master `enabled` authority, independent per-feature checkboxes (extensible registry), and a Red/Blue/Both team filter — reusable infrastructure any future overlay feature plugs into.

**Not started yet:**
1. **Real analytics functions** — no LOS, heatmap, or passing-lane computation exists yet. Both reduce to raycasting against `segments`/`planes`, accounting for player/ball radius (see [Domain notes](#domain-notes-how-haxball-actually-works--read-before-writing-analytics)), and both should register in `OverlayControls.OVERLAY_FEATURES` and read the shared `enabled`/`team` overlay settings rather than adding their own toggle.
2. **Kick-direction-based logic** — nothing yet uses the player-center → ball-center kick geometry described in the domain notes (e.g. predicting where a kick would send the ball).
3. Everything else layered on top of the now-working overlay rendering path (arrows, cones, heatmap shading, etc. all now have a proven pixel-perfect place to draw, and a filtering mechanism to respect).
