# Live ball trajectory overlay

Branch: `feat/ball-trajectory`.

**Purpose: a live, dynamic overlay of where the ball is going — drawn at the
ball's true width, not as a hairline.**

The ball is not self-propelled, so between touches its entire future is fixed
by position, velocity and the map. That makes it the one thing on the pitch
that can be predicted exactly. This branch predicts it and draws it.

---

## Status

| Area | State |
| --- | --- |
| Reflection rule reverse-engineered | ~~Done — `e = bCoef₁ × bCoef₂`, verified~~ |
| Trajectory predictor | ~~Done — `ballTrajectory.js`~~ |
| Predictor validated against the engine | ~~Done — PASS, p99 2.4e-13~~ **on Classic only; wrong by ~395u on custom maps until `fix/custom-map-geometry`** |
| Curved segments + goal posts handled | ~~Done~~ |
| Overlay draw layer | ~~Done — `ballTrajectoryOverlay.js`~~ |
| Wired into `Game.jsx` and `ReplayView.jsx` | ~~Done — toggle "Ball path"~~ |
| Lint / build clean | ~~Done — no new issues~~ |
| Seen running | ~~Done — draws correctly, widths hold at all zooms, bounces land on walls, momentum still draws, scrubbing safe~~ |
| Three defects found on first run | ~~Fixed — see [First run](#first-run-what-it-got-wrong)~~ |
| Tuned against real play | Not done — deliberately deferred |

**Closed.** The branch does what it set out to do: a live trajectory overlay
drawn at the ball's true width, on a predictor that reproduces engine
arithmetic exactly.

**Two things were accepted without being checked**, and a future session
should know which:

1. **The three fixes were never confirmed on screen.** They are verified by
   measurement — the predicted resting place now matches the engine to
   `0.00e+0` — but nobody has watched a ball roll to a stop under the ring.
   The third fix (path lag) is the shakiest: its cause was diagnosed from the
   code rather than from footage, so if the overlay still feels like it trails
   the ball, that diagnosis was simply wrong.
2. **Replay seek was never exercised with the console open.** Seeks are
   suppressed inside the analytics hook and scrubbing looked fine, but the
   logs were not read.

Neither blocks anything downstream — the predictor is what later work depends
on, and that is the part with a validator behind it.

---

## Picking it back up

The branch is closed, so nothing here is outstanding work. This is the
checklist to run if you change the predictor, return to tune the overlay, or
want to close out the two unchecked items above.

### 1. Confirm the physics still holds

```bash
npm install
node scripts/validate-trajectory.mjs
```

Expect `PASS`, p99 around `1e-13`, and roughly 600+ ticks containing a bounce.

If this fails, **stop** — the physics model disagrees with the engine and
nothing visual is worth debugging until that is resolved. Do not loosen the
tolerance to get past it; see [Verify it before trusting
it](#verify-it-before-trusting-it).

### 2. Run it

```bash
npm run dev
```

Load a replay (cheaper to iterate on than a live game — that is what
`feat/replays` was built for), then toggle **"Ball path"** in the overlay
panel, bottom right.

### 3. What to look for

The structural checks all passed on the first run and are unlikely to have
regressed — corridor width at multiple zooms, bounces landing on walls,
momentum still drawing, scrubbing safe. **This pass is about the three fixes**
(see [First run](#first-run-what-it-got-wrong)):

- [ ] **The stop marker now appears.** Let a ball roll gently and die on its
      own. A ring should be drawn at its resting place, at the ball's own
      radius. This previously could never draw at all — if it still does not,
      the fix did not take.
- [ ] **The ring lands where the ball actually stops.** The predicted resting
      position matches the engine exactly in testing, so any visible offset
      means the draw layer, not the physics.
- [ ] **No start delay, no early fade.** The trace should appear as soon as the
      ball is meaningfully moving and stay until it is nearly dead, rather than
      vanishing with a sixth of the pitch left to roll.
- [ ] **The path starts under the ball, not behind it.** Watch a fast ball —
      there should be no gap between the sprite and the start of its own path.
      **This is the uncertain fix**: the cause was diagnosed from the code, not
      from footage. If it still lags, the diagnosis was wrong and the trace is
      stale for some other reason.
- [ ] **A fast ball is not spaghetti.** The horizon is now capped by distance
      (520 units), so a hard clearance should draw a readable path rather than
      bouncing around the pitch.

### 4. What to capture before the next session

- A clip of **a ball rolling to a stop** — the one case that could not be seen
  at all before.
- A clip of **a fast ball**, for the lag fix and the distance cap.
- Console output during a **replay seek** — still the one path that cannot be
  exercised headlessly, and still unverified.
- Answers to the [open questions](#open-questions-for-the-tuning-pass): does
  the corridor read as useful or as clutter at speed, and does it flicker
  distractingly while someone is dribbling?

### If it is wrong, suspect these first

| Symptom | Likely cause |
| --- | --- |
| Nothing draws | `traceRef.current` never set — check the console for a logged `onTick` error |
| Draws but never updates | Trace computed outside `onTick`, or the hook is not `enabled` |
| Hairline instead of a corridor | `cameraScale` not applied to the corridor width |
| Path lags the ball badly | Trace being recomputed per frame from extrapolated state instead of per tick |
| Bounces in the wrong place | Collision set built for the wrong entity, or a stale stadium — check the cache key |
| Overlay disappears when momentum is on | Per-feature gating regressed to an early `return` |

---

## First run: what it got wrong

Three defects, all found by actually looking at it, none catchable by the
validator — it tests the physics, not the display logic layered on top. That
gap is the lesson: the validated part and the shipped part had quietly
diverged.

### 1. The stop marker could never draw

It was gated on the ball reaching `stopSpeed = 0.05` within a 90-tick horizon.
From the minimum speed the overlay would even display, that needs

```
ln(0.05 / 1.5) / ln(0.99)  ≈  338 ticks
```

The condition was unreachable from any state the overlay could be in. A
feature that cannot fire shipped, and the handover checklist told the reader
to look for it.

**Fix: the horizon is now a DISTANCE, not a tick count.** Damping makes ticks
the wrong unit — at `d = 0.99` a ball at speed 1.5 needs ~338 ticks to stop
while one at speed 10 crosses the pitch and bounces repeatedly in the same
span. A tick cap truncates precisely the slow ball whose resting place you
wanted, and draws spaghetti for the fast one. Capping by path length
(`maxDistance`, default 520) gives both the right thing.

Verified against the engine — any ball that comes to rest inside the horizon
now has its resting place predicted exactly:

| Ball speed | Stops? | Predicted rest vs engine |
| --- | --- | --- |
| 0.3 | yes | error 0.00e+0 |
| 1.5 | yes | error 0.00e+0 |
| 3 | yes | error 0.00e+0 |
| 5 | yes | error 7.1e-14 |
| 8 | no — truncated, correctly not flagged | — |

### 2. The display threshold was invented, and far too high

`minSpeed = 1.5` caused both the start delay and the early fade. At damping
0.99 a ball at that speed still has **150 units** of travel left — about a
sixth of the pitch, during which the overlay showed nothing and took the
resting place with it. For scale, `momentumOverlay.js` derives its ball
threshold rather than guessing, and lands at 0.1375: this cutoff was **eleven
times stricter** than the existing overlay on the same canvas.

**Fix: gate on remaining travel, not speed.** `minRemainingTravel = 15` units
(~1.5 ball diameters), which is a physical statement rather than a taste one,
and adapts automatically to a map with different damping.

### 3. The path started behind its own ball

The trace is computed at tick rate; the ball sprite is drawn extrapolated
between ticks. So the path began where the ball *was*, up to a full
ball-diameter behind the sprite at speed, with the gap opening and closing
every tick. That reads as the overlay lagging.

**Fix:** `drawBallTrace` takes `transform.ballPos` — the extrapolated position
from the frame the renderer just drew — and starts the path there.

This one was reported as "not responsive enough" and diagnosed from the code
rather than from footage, so it is the least certain of the three. If it still
feels laggy, this was the wrong cause.

---

## Why width matters

A one-pixel centre line is a lie in the case that matters most: **whether the
ball fits.** A hairline threads a gap between two players that a 20-unit-wide
ball cannot.

So the overlay draws the **swept corridor** — the region the ball body
actually occupies. Implementation detail worth knowing: stroking the centre
polyline at `2 × radius` with round caps and joins *is* the Minkowski sum of
the path with the ball disc, so the rounding at each bounce corner is
geometrically correct rather than cosmetic. One stroke call, no polygon
construction.

The width is in **map units** and must be scaled by `cameraScale`. A fixed
pixel width would be wrong at every zoom level.

---

## The physics, and why it is not obvious

Full detail in [DOMAIN.md § Ball physics](DOMAIN.md#ball-physics). The three
findings that shaped the code:

**Wall reflection is not symmetric.** Angle in does not equal angle out. The
engine scales the *normal* component by `e = ball.bCoef × surface.bCoef` and
leaves the *tangential* component untouched, then applies global damping to
both. At `e = 0.5`, a 45° approach leaves at **26.565°**. The product rule is
exact — confirmed at ball `bCoef` 0.00/0.25/0.50/0.75/1.00/1.50. Note `e > 1`
is legal, so a custom map can return the ball *faster* than it arrived.

Per-surface `bCoef` varies more than it looks. On the classic stadium the
top/bottom walls give `e = 0.50` and the goal-side walls give `e = 0.05` —
the ball effectively dies. Two walls that look identical return completely
different balls.

**The ball never curves.** Damping is isotropic, so heading is preserved to
one float ULP (2.2e-16 rad over 80 ticks). Between bounces the path is a
straight line. What damping changes is the *spacing* of tick positions —
each step is exactly `d` times the last, which bounds total travel at
`|v| / (1 − d)` = 100·|v|. A ball at speed 3 can never travel more than 300
units however much space is ahead of it.

**But it still cannot be raycast.** The engine resolves collisions discretely:
integrate, detect overlap, snap out along the normal. No sub-tick sweep. So
the bounce vertex is *not* the geometric ray/wall intersection — the snap
moves the ball off its incoming line, and where it lands depends on tick
phase. Both the turn point and the turn angle come out wrong analytically.
Simulate tick by tick.

---

## What changed

### `src/features/analytics/ballTrajectory.js` (new)

The predictor. `buildCollisionSet(geometry, entity)` pre-filters stadium
geometry to what one entity can hit and precomputes arc parameters — do this
once per `geometryVersion`, never per tick. `predictBallPath(ball, set, ticks)`
returns points, bounce locations and where the ball stops.

Handles straight segments, curved segments, vertices, planes and static discs.
The entity is an argument throughout, so the same code will serve a player
raycast later — the surfaces the ball collides with are **not** the set the
players collide with.

### `scripts/validate-trajectory.mjs` (new)

Spins up a headless `node-haxball` sandbox, launches the ball from random
states and compares the predictor to the engine tick by tick.

```bash
node scripts/validate-trajectory.mjs --trials 600 --ticks 140
```

Current result: **PASS** — p99 error 2.4e-13, max 1.5e-12, over 70,994 tick
comparisons including 663 ticks containing a bounce. That is floating-point
noise; the model is the engine's arithmetic, not an approximation of it.

> **EXCLUSION (added by `fix/custom-map-geometry`).** Every one of those 70,994
> comparisons was run on the **default Classic stadium**, and that is the whole
> of what the number covers. On custom maps this predictor was wrong by up to
> **395 units** at the same moment it was reporting 2.4e-13 here — bouncing the
> ball off decorative geometry (`cMask: 0` read as "all") and treating one-way
> walls as solid (`bias` not modelled at all). Classic has almost no decorative
> geometry and no biased segments, so it could not show either.
>
> The validator now runs every map in `test-maps/` as well. Current figures:
> Classic p99 1.71e-13, K Futsal Huge 1.14e-13, K Futsal big 1.42e-13.
>
> This is the same failure this file warns about elsewhere — a validator's
> exclusions are load-bearing claims about what it does not prove — arriving in
> the file that first taught it. "Validated against the engine" meant
> "validated against one stadium", and nothing said so.

No new dependency — `node-haxball` is already in `package.json`.

### `src/features/analytics/ballTrajectoryOverlay.js` (new)

The draw layer. `computeBallTrace(...)` at tick rate, `drawBallTrace(...)`
every rendered frame.

**Rate split, deliberately different from `momentumOverlay.js`.** Momentum
arrows recompute every rAF because they must track the extrapolated sprite.
The trace must not: the path only changes when the ball's velocity changes, so
recomputing per frame is ~4× the work for an identical answer. The points are
map coordinates, so one array survives any number of frames and camera moves.
The cost is that the path is up to one tick stale relative to the ball sprite,
which is acceptable because the path is a claim about the future — its far end
is the point, not its first pixel.

---

## The one error worth remembering

**Collision resolution order changes the answer.** Static discs — goal posts,
and whole barriers on custom maps — must be resolved *before* planes, segments
and vertices. Each contact moves the ball, so whichever applies first changes
the other's penetration depth.

Resolving boundaries first reproduced the engine exactly on head-on post hits
and drifted about a unit on glancing ones — enough to send a predicted rebound
to the wrong side of the post.

The trap: this was invisible while goal posts were absent from the test. The
model passed at 1e-13 against walls alone and was still wrong. It only
surfaced once the posts were in — and they were only absent because the test
harness had parked them off-pitch along with the players, since both live in
the same disc array.

Recorded as [DOMAIN.md § Pitfalls #8](DOMAIN.md#pitfalls).

---

## Handover

### How it is wired

`useHaxballAnalytics` gained an **`onTick(room, frame, geometry)`** option,
filling the seam that was already reserved in its tick handler. It runs
independently of `logging`, is skipped during replay seeks like every other
observer, and is held in a ref rather than the effect's dependency array —
passing an inline arrow as a dependency would tear down and re-chain all
eleven room callbacks on every React render. Exceptions are caught and
logged, so an overlay bug cannot kill the tick handler.

Both views then do the same two things:

```js
// tick rate — path only changes when the ball's velocity does
onTick: (room, frame, geometry) => {
  traceRef.current = computeBallTrace(room.state, geometry, room.stadium, { ticks: 90 });
}

// render rate — inside onRequestAnimationFrame, same transform as momentum
if (settings.features.trajectory && traceRef.current) {
  drawBallTrace(ctx, traceRef.current, transform);
}
```

`room.stadium` is the cache key for the collision set — identity-compared,
exactly as the hook already tracks stadium changes. `geometryVersion` was not
used because it lives inside the logger and is unavailable when logging is
off.

Two related changes:

- **The rAF handler no longer early-returns on a disabled feature.** It used
  to `return` when `features.momentum` was false, which would have silently
  suppressed every overlay added after it. Each feature is now gated on its
  own. Ball path draws first so momentum arrows land on top of the corridor.
- **`logging` is now `false` in both views.** Session capture is finished, so
  neither playing a game nor watching a replay should write an NDJSON file.
  Flip it back only for a deliberate recording run.

### Verify it before trusting it

```bash
node scripts/validate-trajectory.mjs [--trials 600] [--ticks 140]
```

Run this after any change to `ballTrajectory.js`, and after any engine or
`node-haxball` version bump — the model reproduces engine arithmetic exactly,
so an engine change is precisely what this is built to catch.

**Do not loosen the tolerance to make this pass.** A failure is diagnostic
information about the engine, exactly as with the zone validator. The bar is
floating-point noise because the model reproduces the engine's arithmetic —
anything larger means a real disagreement.

### Open questions for the tuning pass

These are judgement calls that need eyes on a real match, not more maths:

- **Horizon.** 90 ticks is a guess. The honest limit is "until a player can
  touch the ball" — which the reachable-zone formula could actually compute.
  That is the principled version and is worth trying once the zone primitive
  is in the live path.
- **Does the corridor read as clutter at speed?** It is drawn faded before the
  first bounce and solid after, but that split may be the wrong emphasis.
- **Should it show at all when nobody can act on it?** A ball travelling into
  open space with no contest is a trace nobody needs.
- **Possession.** While a player is dribbling, the ball's velocity changes
  every few ticks and the trace will flicker. Probably wants suppressing when
  the ball is inside someone's kick range.

### Known limitations

- **Exact only while no player touches the ball.** The moment one does, the
  real path diverges. The tail of a long trace is a decaying claim, not a
  prediction — a long horizon would look authoritative while being decoration.
- **~~Players are not obstacles in the model.~~ Corrected later — they are.**
  This entry read as a decision and was an oversight, which is why it survived
  into a second branch. The reasoning was half right: modelling players as
  static *bouncers* would be false precision, since they have mass and move.
  But it was over-applied into ignoring them entirely, and the overlay drew
  straight through bodies the engine does deflect the ball off. `predictBallPath`
  now takes per-tick `blockers` and **truncates** the path at first contact —
  "the path is valid this far" needs no assumption about where anyone is going.
  See [DOMAIN.md § Players collide with the
  ball](DOMAIN.md#players-collide-with-the-ball-and-are-not-stadium-geometry).
- **The corridor still answers "does the ball fit through the gap as it is
  now"**, not "will it still be there".
- **Per-disc physics overrides are not read.** The ball's own `bCoef`,
  `damping` and `radius` are read live, but a host changing them mid-game via
  `setDiscProperties` is not watched for.

---

## What this leaves behind

The overlay is the smaller half of what this branch produced. The lasting
parts are:

- **`ballTrajectory.js`** — a validated, entity-agnostic collision model.
  Most of roadmap item 8 (`feat/raycast`) arriving early and in stronger
  form, since it handles the bouncing case a straight-line `canReach`
  cannot. What is left for that branch is the cheap boolean early-out,
  extracted from the same collision set.
- **[DOMAIN.md § Ball physics](DOMAIN.md#ball-physics)** — reflection is not
  symmetric, the ball never curves, and the path cannot be raycast.
- **[DOMAIN.md § Kicking](DOMAIN.md#kicking)** — measured while scoping what
  came next, and the reason the aim assist is now cheap to build.
- **Two pitfalls**: collision resolution order, and experiments that cannot
  show the effect they are testing.

It also settled a framing question the hard way. This overlay is
**descriptive** — it shows where the ball is *already* going, which is largely
what the eye supplies. The predictive version, showing what a kick *would* do,
is the one worth having, and it is now cheap because the physics underneath it
is measured.

**A bug shipped here and was only found much later:** the trace ignored
players entirely. The cause was three-deep — `buildCollisionSet` skips movable
discs, players are not in the stadium geometry at all, and the set is cached
per stadium so a per-tick entity could never live in it — and the validator
could not have caught it, because it parks every player on purpose. Fixed by
truncating rather than bouncing; see Known limitations above.

**Two things came back to this branch later.** The unreachable stop marker
found here became a standing validator check — every overlay since tests that
each drawn element can actually fire, not just that the maths is right, and
that check has caught a second dead branch. And the
descriptive/predictive framing got sharpened on `feat/aim-assist`: the value
of a cue turned out to be *contradicting a belief* more than supplying missing
data, which is a better filter than "predictive" alone.
