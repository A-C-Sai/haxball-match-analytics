# Haxball domain knowledge

How the game actually works, what was learned the hard way, and the traps.

Branch-agnostic — nothing here is about a particular feature. Read it before
writing any analytics; several plausible ideas die on this page.

Everything marked **verified** was established empirically from a recorded
match and can be re-checked with `scripts/diagnose-physics.mjs` and
`scripts/validate-zone.mjs` on any session.

---

## Contents

- [The play surface](#the-play-surface)
- [Movement physics](#movement-physics)
- [The reachable zone](#the-reachable-zone)
- [Facing, orbits and aiming](#facing-orbits-and-aiming)
- [Collision geometry](#collision-geometry)
- [Game state and events](#game-state-and-events)
- [Tactical vocabulary](#tactical-vocabulary)
- [Pitfalls](#pitfalls)

---

## The play surface

A top-down 2D game where every entity is a circle. Players are coloured discs
carrying a number or avatar, with a name label rendered below. The ball is a
white disc. The camera follows the action rather than showing the whole pitch.

Team ids follow Haxball's numeric convention, used throughout the codebase:

| Team id | Meaning |
| --- | --- |
| 0 | Spectator |
| 1 | Red |
| 2 | Blue |

**Discs collide, they do not overlap.** The physics enforces separation, so
two players in contact sit at centre distance exactly `r₁ + r₂`. Contact is a
clean equality test rather than a fuzzy intersection measure. (What appears to
overlap on screen is the name labels, not the circles.)

---

## Movement physics

### The per-tick order — verified

```js
v += a * u      // 1. apply the input force
p += v          // 2. integrate position on the PRE-damping velocity
v *= d          // 3. damp
```

`disc.speed` is therefore sampled **post-damping**, while the displacement
that produced the recorded position used the **pre-damping** value.

Two independent fingerprints confirm this, both exact:

- Fitting `|v(t+1) − v(t)·d|` on input frames yields `a·d`, not `a`.
  Measured `0.10560` against a declared `0.11`; `0.07968` against `0.083`.
- `p(t+1) − p(t)` equals `v(t+1)/d`, leaving a residual of `|v|·(1/d − 1)`
  against `v(t+1)`. Predicted `0.0817` at the observed median speed of 1.96;
  measured `0.08165`.

### Input — verified

From node-haxball's movement code (`src/api.js`):

```js
dirX = ((input & 8) > 0) - ((input & 4) > 0);   // right − left
dirY = ((input & 2) > 0) - ((input & 1) > 0);   // down − up
if (dirX !== 0 && dirY !== 0) { dirX *= cG; dirY *= cG; }   // cG = 1/√2
accel = isKicking ? kickingAcceleration : acceleration;
disc.applyForce(dirX * accel, dirY * accel);
disc.damping = isKicking ? kickingDamping : damping;
```

**Eight directions, all unit magnitude.** Diagonals are normalised — no
diagonal speed advantage. Bit 16 is kick.

Three further facts from the same code:

- **Kicking switches damping, not only acceleration**, and the assignment
  happens every tick regardless of input. A kicking player always carries
  `kickingDamping`.
- **Opposite keys cancel exactly**, via the subtraction.
- **Acceleration applies only when at least one axis is non-zero.** No input
  means pure damping.

### Per-map constants

`acceleration`, `damping`, `kickingAcceleration`, `kickingDamping`, `radius`,
`invMass`, `kickStrength`, `kickback` and `gravity` all live on the stadium's
`playerPhysics` and differ between maps. Never hardcode any of them.

`gravity` is zero on standard maps but adds a constant-acceleration term where
non-zero — it is captured, so handle it rather than assume.

---

## The reachable zone

Where a player can **be** within N ticks. The game is tick-based, so
quantities belong in ticks rather than distance; that also makes commitment,
orbit time and arrival time directly comparable.

### The formula — verified

```
centre_N = p₀ + v₀ · (1 − dᴺ)/(1 − d)

R_N      = a/(1−d) · [ N − d(1 − dᴺ)/(1 − d) ]
```

No simulation, no sampling. The momentum factor has **no leading `d`** —
position integrates before damping, so the first tick carries the full current
velocity.

**The zone is an octagon, but off-centre.** The drift term is
direction-independent: where the player is going whether they like it or not.
The radius term is what they can do about it. A sprinting player's zone has
slid forward and the space behind them has dropped out of it entirely.

Because input is eight-directional, the hull is a **regular octagon,
axis-aligned in map coordinates** — fixed orientation, no rotation needed:

- `R_N` in the eight principal directions (vertices)
- `R_N · cos(π/8) ≈ 0.924 · R_N` in the eight in-between directions

About 7.6% anisotropy. A disk of radius `R_N` overestimates the worst
directions by that much.

### Validation result

Against 180,000 comparisons from a real 6v6 match:

| Bucket | Samples | Contained | Mean usage | Max overshoot |
| --- | --- | --- | --- | --- |
| Open space | 130,349 | **100.00%** | 0.924 | **1.0000** |
| Near a wall | 114 | 100.00% | 0.801 | 1.0000 |
| After contact | 49,337 | 90.84% | 0.940 | 20.33 |

Max overshoot of exactly `1.0000` means the bound is **tight**, not merely
satisfied — reachable in principle and reached in practice. Mean usage of
0.924 says real players spend most of their time near their physical maximum.

### It bounds self-propelled motion only

Contact injects momentum from outside the model, and the engine resolves
penetration by moving discs **positionally** — not just their velocities. No
velocity-based prediction can reproduce that.

This is a property, not a limitation: **body blocking is the deliberate
exploitation of that gap.** "Where can this player get to" has two different
answers — under their own power, and after being hit.

### Commitment falls out of it

A player **cannot return to their own current position within N ticks** when
drift exceeds radius:

```
|v₀| · (1−dᴺ)/(1−d)  >  a/(1−d) · [ N − d(1−dᴺ)/(1−d) ]
```

The largest such N is the commitment window, in ticks — a statement that a
specific location is unreachable for a specific duration, not a heuristic
threshold on speed.

### The bound must use reachable physics, not current physics

An upper bound is over **every behaviour available during the window**, not
the one in progress at its start.

Releasing kick is always available, and `kickingAcceleration` is typically
well below `acceleration` (0.083 vs 0.11 — a ratio of 1.33). Predicting a
kicking player with the kicking value produces a bound they break simply by
letting go.

This carries into live features: commitment computed from a defender's current
kick state lets them escape an "unreachable" window by releasing.

### Dominance falls out too

"Who controls this point" is: for each player, the smallest N whose zone
contains it; lowest N wins. A distance test against a moving centre and a
growing radius — analytic, per point, **no raster needed**. The full partition
is a generalised Voronoi diagram over disks growing at different rates from
displaced centres.

---

## Facing, orbits and aiming

### There is no orientation — except on the ball

No `angle`, `heading` or `facing` field exists on `Player`, `Disc` or
`MovableDisc`. A player is a circle with a position and a velocity.

**But facing exists while the ball is in kick range, and is steerable.** The
kick direction is the straight line from the player's centre through the
ball's centre, extended outward. Because both bodies are circles, the contact
point always lies on that centre-to-centre line, so "centre through contact
point" and "centre through ball centre" are the same ray — and the latter
needs no contact detection.

Facing is not a frozen instant at the moment of the kick. It is a live
quantity with a bounded slew rate, for as long as the player keeps the ball in
range. Off the ball there is nothing.

### Orbit slew rate

At distance `r = r_player + r_ball`, moving tangentially at speed `v`:

```
ω    = v / r
t_θ  = θ · (r_player + r_ball) / v
```

Larger radii orbit more slowly. Kicking while orbiting is slower still. Orbit
time is directly comparable against defender arrival time.

### The capability cone

While in kick range, the set of achievable kick directions is an angular
sector anchored on the ball. At contact it is a single ray; after `t` ticks of
orbiting it has widened to half-width `ωt`. **The cone grows with time on the
ball.**

It is a **capability** cone, not a perception cone — the same shape as a
vision cone with opposite semantics. A vision cone constrains what a player
takes in; this describes what they can send out.

- **Width is set by time on the ball.** A carrier with the ball settled and
  shielded has a wide reachable set; a player meeting a fast-moving ball has
  almost a single ray. This is the computable difference between *having* the
  ball and merely touching it.
- **It can be physically obstructed.** A defender's body in the orbit arc
  prevents rotation through it — exactly the body blocking that forces a
  shooting angle away from goal. Obstruction of the orbit path, not of sight;
  visual occlusion does not exist in a top-down view.
- **Obstruction makes it asymmetric.** If one direction is blocked, the same
  angle is reachable the long way round at higher time cost.

### Aiming gates every carrier action

**A geometrically clear lane is not the same as an available pass.**

To send the ball to teammate T, the carrier must be positioned *diametrically
opposite T across the ball*. Required direction is `normalize(T − ball)`;
current direction is `normalize(ball − player)`; the angular error is θ,
costing `t_θ` to close. "Back turned to a teammate" is θ ≈ π — the maximum of
a continuous quantity every receiver has.

Availability is a conjunction: the lane is clear, **and** the carrier can aim
within `t_θ`, **and** they still hold the ball after `t_θ`.

The second condition contaminates the first: **the lane must be clear at
`t_θ`, not now.** During the orbit, opponents close and the receiver drifts.

This splits the lane matrix in two. The pairwise matrix stays geometric and
symmetric — substrate. The carrier's *availability row* is that row gated by
θ. **Report a cost, not a verdict:** "available in N ticks" distinguishes a
teammate at θ = 20° from one at θ = 160° with otherwise identical lanes.

The capability cone is therefore a **gate, not a feature** — it filters
passes, shots and clearances alike.

**This explains the back-pass risk.** Running forward with the ball ahead, the
kick direction is forward; passing backward requires getting in front of the
ball — the maximal orbit, executed while an opponent closes. Back passes are
risky because they cost the most reorientation. The same explains why orbits
"allow you to pass, shoot and clear in a wider range of situations", and why
stutter-stepping is the technique for aiming.

---

## Collision geometry

### Four kinds, not two

| Kind | Notes |
| --- | --- |
| `segments` | Zero-width lines. May be curved (`curveF`, radians). |
| `planes` | Infinite half-spaces, `normal · p = dist`. Usually the pitch boundary. |
| `discs` | **Static discs.** Goal posts, and on custom maps whole barriers. |
| `vertices` | Point colliders at segment endpoints. |

Missing any of these makes real geometry invisible to the model.
`joints` also exist and tie discs together — a jointed disc can move, so
treating stadium discs as static is only safe when that list is empty.

### Everything has width

Players and ball carry a live, map-dependent `radius`. Segments and planes are
zero-width with no thickness field. The effective boundary for a disc of
radius r is that boundary offset outward by r.

### Masks are per-entity and per-map

Collision requires **both** directions to match:

```
((a.cMask & b.cGroup) > 0) && ((b.cMask & a.cGroup) > 0)
```

| Bit | Flag |
| --- | --- |
| 1 | ball |
| 2 | red |
| 4 | blue |
| 8 | redKO |
| 16 | blueKO |
| 32 | wall |
| 64 | kick |
| 128 | score |

A player's `cMask` is always OR'd with 39 (`wall|blue|red|ball`).

**On many maps the pitch boundary accepts the ball but not players** — the
ball cannot leave while players run straight through. A boundary is a wall for
one entity and empty space for another.

**`cGroup` carrying redKO/blueKO (8|16) means kick-off-only** — those
barriers stop players until the kick-off event, then vanish.

So the raycast primitive needs the entity as an argument, not just endpoints:
`canReach(from, to, radius, cGroup, cMask)`.

---

## Game state and events

### GamePlayState

`gameState.state` — a direct read, not an inference:

| Value | State | Notes |
| --- | --- | --- |
| 0 | `BeforeKickOff` | Game started, kick-off hasn't happened |
| 1 | `Playing` | Active play |
| 2 | `AfterGoal` | `goalTickCounter` counts down from 150 |
| 3 | `Ending` | A team has won; counts down from 300 |

Also on `GameState`: `goalTickCounter`, `pauseGameTickCounter` (120 on pause),
`goalConcedingTeam`, `paused`. Note `paused` is **separate** from `state` — a
paused game can still read as state 1.

### Event callbacks

Roughly 60 events, each in three flavours: `onBeforeXxx`, `onXxx` via
RoomConfig, and `room.onAfterXxx` by direct assignment (what this codebase
uses). They chain through a `customData` return value.

| Callback | Gives you |
| --- | --- |
| `onAfterPlayerBallKick` | Kick detection, directly |
| `onAfterTeamGoal` | Goals, with the goal object |
| `onAfterCollisionDiscVsSegment` | Wall impacts (ball is disc 0) |
| `onAfterCollisionDiscVsDisc` | Body and ball impacts |
| `onAfterKickOff` / `onAfterPositionsReset` | Restart boundaries |
| `onAfterGameStart` / `Stop` / `End` | Match lifecycle |
| `onAfterPlayerInputChange` | Input transitions without polling |

---

## Tactical vocabulary

What the overlay ultimately serves. Source: player-level notes gathered for
this project.

**Ball control** is the most important individual skill. *Stutter-step
dribbling* — tapping movement keys in short bursts — is how you aim shots and
passes and telegraph to teammates, and is the primary juke mechanism.
*Orbits* shield the ball and change exit angles. *Wall bounces* add momentum
and create space; one-bank passes work when a direct lane is blocked.

**Passing** is the most important team skill. Back passes are high yield —
they open space in possession — and severely punishing when missed. Resetting
to the keeper buys time and draws the press, opening gaps.

**Positioning.** The goalkeeper is a backbone pivot receiving loose balls; too
far back or too far forward is a liability.

| Format | Shape | Notes |
| --- | --- | --- |
| 3v3 | 1-2 (or 2-1) | Maintain a triangle so the carrier has two options. Man-to-man marking with the striker pressing high is common when defending. |
| 4v4 | 1-2-1 diamond | Most common in both attack and defence. |
| 4v4 | 2-1-1 | Pressing shape; lets a skilful centre back receive more often. |
| 4v4 | 2-2 | Most aggressive. Centre back rotates wide to offer a pass across goal. Demands high passing consistency from keeper and centre back. |

**Corners.** Defending: strikers contest; never commit two players into the
corner without a clear body-block opportunity, or you are outnumbered when the
ball spills. Keeper covers front post; defensive midfielder covers the cross
and corner spam. Attacking: the striker should have a back-pass option from
midfielder or keeper. In 4v4 the keeper need not commit high — the centre back
supports instead, sitting around or just behind halfway to cover spill balls
without conceding a one-on-one. In defence the centre back ideally stands
behind the keeper to cover the cross.

**Rotation.** Holding your starting position all match is a common
misconception. Rotate into space and use triangles to create passing lanes.
Diagnostic questions, all of which are candidate features:

- Does your striker have a back-pass option? Give them support.
- Is their keeper pushed too high? Move into space for a fast break.
- Is your keeper pushed too high? Rotate back to cover.
- Where is the space? Think about where to be for the *second* pass.

**Physical play.** *Body blocking* forces an opponent's shooting angle upward
or away from goal, or creates space for a teammate. *Absorbing* — body behind
the ball, waiting for the opponent to kick — buys time to set up or wins a
50/50 against a spammy opponent.

**Jukes** trick an opponent into committing the wrong way, via
stutter-stepping, orbits, wall bounces or momentum exploitation. Intent is not
computable; **commitment** is.

---

## Pitfalls

Each of these was a real error, found by data rather than by reading source.

### 1. Collision events fire on impact, not for sustained contact

**Verified.** A player pressed shoulder-to-shoulder sits at exactly `r₁ + r₂`
and the engine emits nothing after the initial impact. Same for a player
resting against a wall.

**Rule: events answer "did contact begin"; geometry answers "is contact
happening".** They are not interchangeable.

This matters for nearly every tactical concept: body blocking is *sustained*
contact, absorbing is a *held* position, and possession by a player shielding
the ball registers once then appears to end.

### 2. `cMask = 0` means "unspecified → all", not "none"

**Verified.** A map carried segments at x = ±420 with `cMask = 0`, and players
were observed stopping dead at x = ±405 — exactly one player radius short.

Reading 0 as "collides with nothing" inverts the **most permissive** boundaries
on a map into invisible ones. That is the worst direction for the error:
geometry that stops things silently disappears from the model.

### 3. Stadium discs are collision geometry

`Stadium.discs` holds goal posts and, on custom maps, whole barriers. An
extractor that reads only `vertices`, `segments`, `planes` and `goals` will
report a lane as clear straight through a goal post.

### 4. Walls do not constrain everyone

See [masks](#masks-are-per-entity-and-per-map). "Is this blocked?" has no
single answer — it depends on who is asking.

### 5. State gates are weaker than event gates

`playState` is an interpretation; events are facts. The genuinely dead window
runs from `teamGoal` until the following `positionsReset` or `kickOff` —
players keep drifting through it and are then teleported.

**Do not require `gameStart` to open play.** A replay that begins mid-game
never fires it, and a gate keyed off it silently drops everything — a check
that reports success because it evaluated nothing.

### 6. Position resets are teleports

Goals, team changes, `setDiscProperties` and player joins all reposition a
player with no state change. Any of them inside an analysis window produces
one enormous displacement between two ordinary ones.

### 7. Anything cached per player breaks on a replay seek

A backward seek rewinds room state wholesale and restores the original player
list **with no join events**, so any map keyed by player id silently goes
stale. See `README-replay.md` §11 — this froze the renderer, and will break
any overlay holding per-player state.

### 8. Intent is not computable

Whether a player is deceiving, telegraphing or faking is not in the data.
Stutter-stepping is partially visible via `input`, but whether a given stutter
is a fake or a correction is not.

The productive move is to find the computable physical fact underneath. For
jukes, that fact is **commitment**.

---

## The working method

Every error above survived careful reading of the source and died to a
recorded match. Three of them were caught only because a check existed that
could fail.

**Build the thing, build the thing that tries to break it, run both against a
real replay.**
