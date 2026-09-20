# Haxball Live Tactical Overlay

Computer-assisted analysis on top of live Haxball games — line of sight,
passing lanes, space and commitment — built as a fork of the open-source
Haxball client.

The aim is to **show the possibilities and aid decision making**: expand what
a player can consider, not decide for them. That distinction drives most of
what follows.

---

## Documentation layout

| Document | Scope |
| --- | --- |
| **README.md** (this file) | Overview, design principles, architecture, roadmap |
| [DOMAIN.md](DOMAIN.md) | How the game works, verified findings, pitfalls. Branch-agnostic. |
| [README-replay.md](README-replay.md) | `feat/replays` — `.hbr2` playback |
| [README-session-event-capture.md](README-session-event-capture.md) | `feat/session-event-capture` — data layer + physics validation |
| [README-ball-trajectory.md](README-ball-trajectory.md) | `feat/ball-trajectory` — live ball path overlay at true ball width |
| [README-aim-assist.md](README-aim-assist.md) | `feat/aim-assist` — what a kick *would* do. Planned, not started |

**Read [DOMAIN.md](DOMAIN.md) before writing any analytics.** Several
plausible feature ideas die on that page, and every pitfall listed there cost
real debugging time to find.

---

## Status

| Branch | State |
| --- | --- |
| `feat/replays` | ~~Merged~~ — `.hbr2` playback, shared renderer, analytics hook runs unmodified |
| `feat/session-event-capture` | ~~Complete~~ — events + game state captured, reachable-zone formula validated at 100% |
| `feat/ball-trajectory` | ~~Complete~~ — tick-exact ball predictor (p99 2.4e-13), live overlay drawn at the ball's true width |
| *next* | `feat/aim-assist` — what a kick *would* do. Kick mechanics are measured ([DOMAIN.md § Kicking](DOMAIN.md#kicking)), so it is mostly wiring |

**What exists:** a working data layer (per-tick extraction, per-map geometry,
engine events, NDJSON session logging), replay playback as a test bench, a
tick-exact ball trajectory predictor with a validator behind it, and two
overlay features — momentum arrows and the ball path.

**What does not:** any analytics function about *players*. No LOS, no passing
lanes, no dominance, no commitment. Everything shipped so far is about the
ball, which is the easy half — the ball has no intentions and cannot
accelerate itself.

**The framing lesson so far.** Both shipped overlays are *descriptive*: they
show what is already happening, which is largely what the eye supplies. The
ball-path branch made that concrete — it is accurate to floating point and
still mostly restates the visible. The valuable class is *predictive*: what
would happen if you acted. That is what `feat/aim-assist` is, and why it comes
before anything else on the list.

### The momentum overlay, and what it was actually for

It stays. Not as the live feature it was built to be, but because building it
produced the infrastructure everything else draws through:

- **A pixel-accurate render path.** `renderer.js` keeps `cameraOrigin` and
  `cameraScale` as private closure variables and recomputes them every frame.
  A small additive patch exposes them, so overlay code reuses the game's own
  follow/zoom/clamp logic instead of reimplementing it. Every future overlay
  inherits that.
- **A separate overlay canvas** layered over the game canvas, rather than
  injected into the PIXI scene graph — which gets destroyed and recreated on
  stadium change and is not exposed anyway.
- **The stale-closure fix.** The render callback is constructed once, so
  reading React state inside it captures a snapshot that never updates. Found
  and solved here; every overlay setting added later needs the same ref
  treatment.
- **`estimateTerminalSpeed()`**, derived from the discrete damping model.
  Written to gate arrow visibility; turned out to be the exact primitive the
  reachable-zone formula needed.

And it taught the [three-filter test](#the-three-filter-test) by failing it.
Direction of travel is the single most perceptible thing on screen, and
nothing was derived from it — the overlay showed data and then terminated.
That is what made the principle concrete: **momentum is the wrong output but
the right input.** What the eye cannot compute is not where a player is going,
but what their momentum has already taken away from them.

So: a successful experiment that proved the drawing path and sharpened the
design rules. Keep it available for replay review, where clutter costs
nothing. Just do not mistake it for the thing the project is for.

---

## Base codebase

- **[node-haxball](https://github.com/wxyz-abcd/node-haxball)** — the engine.
  Reimplements Haxball's networking, physics and room protocol in JS. Consumed
  read-only; nothing here modifies it.
- **[node-haxball-client](https://github.com/wxyz-abcd/node-haxball-client)** —
  the desktop client we forked (React 19 + Vite + NW.js + PIXI.js).

---

## Setup

```bash
git clone <your fork url>
cd haxball-real-time-tactical-analytics
nvm use 22
npm install
npm run dev
```

Opens the NW.js desktop app (not a browser). F12 for the devtools console.

---

## Design principles

Binding, not advisory. A feature that fails these does not ship.

### The three-filter test

A feature must fail at least one filter to earn its place on screen.

1. **Is it perceptible?** Can the eye register it directly.
2. **Is it cheap to derive?** Some things are visible yet expensive to turn
   into a decision.
3. **Is it attended to?** The camera follows the ball; things can be visible,
   trivial, and still unseen.

| Feature | Perceptible? | Cheap to derive? | Attended? | Draw it? |
| --- | --- | --- | --- | --- |
| Momentum arrows | Yes | Nothing derived | Yes | No |
| Commitment window | Yes (velocity) | No — needs map physics | Yes | Yes |
| Who wins the ball | Yes (positions) | No — pursuit maths | Yes | Yes |
| Open lanes with radius | Partly | No | Mostly | Yes |
| Keeper out of position | Yes | Yes | **No** | Yes |

The failing filter determines the *kind* of cue: a derivation failure wants a
computed visual, an attention failure wants a nudge.

An earlier formulation — "would a strong player already know this?" — was
rejected for making the test relative to the observer. That has no stable
answer and becomes a licence to draw anything.

**The one field of view that is real:** the camera follows the ball, so
off-screen things are not drawn at all. That is a genuine perceptual limit,
unlike a vision cone which would be artificial. It turns filter 3 into a test
— *is this currently on screen?*

### Enumerate, do not recommend

Enumeration expands thinking: here are three outlets, one you had not seen.
Recommendation replaces it: pass to 5. The second demos better and is worse
for the player — it trains dependence and stops teaching the moment it is
switched off. It is also the version that reads unambiguously as cheating.

Ranking, if ever wanted, is a separate optional layer — never fused into the
base display.

### The enumeration must include the null action

Holding the ball is a valid option, and leaving it out biases the tool.

Every source reviewed is about passing — not because holding is unimportant,
but because event data records passes and does not record "chose to wait". The
literature carries a **pass bias baked in by its data**. An overlay that
enumerates only passing options implicitly recommends passing, through
omission rather than recommendation, which makes it easy to miss.

Holding has at least three versions: **absorbing** (body behind the ball,
buying time), **holding for power** (a stronger shot than a first-time touch),
and **holding for a lane**. The third is interesting because its value comes
*from* the others being bad — so the enumeration must be able to report
"nothing is open, and that is itself the finding" rather than falling silent.

### Attention is the binding constraint

The target is live play, so the overlay competes with the game. Clutter is
negative, not neutral. The best version probably shows nothing most of the
time and surfaces one cue only when actionable. Continuous display trains
people to stop looking.

### Prefer the exact computation

> **Standing rule:** when a source reaches for an approximation, check whether
> it did so because of data poverty this project does not share. Where the
> answer is yes, implement the exact version.

Every external source builds approximations shaped by missing information.
Tracking runs at 12 Hz for hockey players, 25–30 Hz for soccer, with smoothing
to suppress jitter. This project has 60 ticks per second for every body, exact
positions and velocities, and true physics constants read live from the
stadium.

### Distribution

A live tool reporting which opponents are committed and which lanes are open
is assistance, and in competitive rooms many would call it cheating. For
personal training, replay review and coaching this is a non-issue. If the tool
is ever shared, the replay-and-review framing is the uncontroversial one — and
it is also where clutter costs nothing, so far more can be shown.

---

## Architecture

### Two rates: tick-rate analytics vs render-rate overlay

- **Tick-rate** (`useHaxballAnalytics`, `onAfterGameTick`) fires once per
  physics tick. Home for logging, event capture, and analytics that do not
  need to visually track a moving object every displayed frame.
- **Render-rate** (`onRequestAnimationFrame` in `renderer.js`) fires once per
  *rendered* frame. The renderer re-extrapolates room state and recomputes the
  camera every frame — anything sitting on top of a moving player must do the
  same or it will visibly lag.

### The camera transform

```
screenX = (mapX - cameraOrigin.x) * cameraScale + canvasWidth/2
screenY = (mapY - cameraOrigin.y) * cameraScale + canvasHeight/2
```

`cameraOrigin`/`cameraScale` were private closure variables. A small additive
patch in `renderer.js` (~line 1719) exposes them, so overlay code reuses the
game's own follow/zoom/clamp logic. Everything downstream reads these fresh
every frame rather than caching.

The overlay draws on a **separate `<canvas>`** layered over the game canvas —
not injected into the PIXI scene graph, which gets destroyed and recreated on
stadium changes.

### Overlay controls

A bottom-right menu (`OverlayControls.jsx`) with three independent concerns:

- **`enabled`** — the master authority, deliberately decoupled from
  `features`. A separate AND-gate: turn it off and nothing computes or
  renders, whatever the feature checkboxes say.
- **`features`** — a per-feature on/off map driven by the
  `OVERLAY_FEATURES` registry. Adding a feature means one registry entry, one
  default in `Game.jsx`, one gating check in the draw loop.
- **`team`** — `"both" | 1 | 2`, shared across all features.

Session-only by design — no persistence.

**A React gotcha:** the render-loop callback is created once, when the
renderer is constructed. Reading a `useState` value inside it captures a stale
snapshot. Fixed by mirroring into a ref and reading `.current`. Any future
overlay-settings field needs the same treatment.

### The analytics boundary (planned)

Not yet built. The split should follow the tick/render division already in
place: the analytics layer owns tick-rate semantics and emits a compact
**decision state**; the client keeps render-rate drawing, re-projecting that
state onto current extrapolated positions every frame.

**The rule: semantics out, geometry back.** A tactical judgement one or two
ticks stale is still true — space and commitment do not change meaningfully in
17ms. What breaks is sending geometry back and drawing it verbatim, because
the world has moved underneath it.

Decision state should carry an **age**, and the client should stop drawing
past a tick budget rather than showing stale advice confidently.

### Data shapes

Not settled; recorded because the substrate is expensive to retrofit. Without
it, each feature invents its own notion of "where things are" and they can
never combine into one coherent statement.

| Shape | Holds | Examples |
| --- | --- | --- |
| Per-player attributes | one scalar per player | commitment ticks, orbit rate, forward space, pressure |
| Pairwise matrix | one value per ordered pair | lane openness γ, time-to-intercept, free angle |
| Angular interval set | arcs with costs, for one entity | the capability cone |

**Small rosters make the dense representation affordable, and this is the
constraint doing the real work.** With six to eight discs the pairwise matrix
is at most 64 cells — computable every tick with no pruning or caching. The
MPNN paper abandoned a fully-connected graph over quadratic cost and settled
for a star topology, losing teammate-to-teammate relationships. Here quadratic
is free.

Layering: raw frame at the bottom; attribute table and matrix derived from it;
graph topology by thresholding the matrix; events as diffs between snapshots.

### Team structure is a graph, not a polygon

A polygon of teammates cannot express being split. A graph gets it free — the
lane model plus a union-find over four nodes. Nodes are players; edges are
available passing lanes.

- A **triangle** is three mutually connected players — the core of 3v3 shape.
- A **break** is an edge cut, from the lane-obstruction test.
- A **split** is the graph dropping from one connected component to two.
- **Isolation** is a node of degree zero.

**Connectivity is not proximity.** Two teammates two units apart with a
defender between them are *not* connected; two far apart with a clear lane
*are*.

**Edges are weighted, not boolean, with hysteresis.** A binary edge chatters
when a defender jitters on the boundary, and a "shape split" cue firing ten
times a second is worse than useless.

Structure is expensive to draw. Likely answer: compute continuously, draw
almost never — surfacing only at the topological event.

---

## Prior art

Nine sources reviewed, in two groups. The first five are **analytics** work —
measuring what happened or what is available. The last four are **agent** work
from RoboCup — software that plays the game autonomously.

That split matters more than any individual finding. Agent papers exist to
**decide**: RoboCup forbids central control, so each agent reduces the world
to one action per cycle. This project exists to **enumerate** so a human
decides. Whenever an agent paper compresses options into a choice, that step
is discarded. What comes *before* the compression is often what is needed.

| Source | Verdict |
| --- | --- |
| Radke, Brecht & Radke, *Improving Passing Lane Models* (LINHAC 2022) | Near-blueprint. Hockey has boards, so the geometry matches. |
| Masella et al., *An enhanced MPNN approach to Receiver Selection* | One formula worth taking; the model itself is a trap. |
| Maleki et al., *Decision making in RoboCup 3D* (2008) | Best architectural fit. Take the feasibility filter, drop the chooser. |
| half-space, *Space Creation* | Cheap, and more legitimate at small roster sizes than in 11v11. |
| Prokopenko & Wang, *Disruptive innovations in RoboCup 2D* (2016) | Strategic areas; Voronoi as one input among several. |
| Zare et al., *CYRUS Team Description* (2021) | Cautionary tale. Its own experiment argues against ML here. |
| Karakuş & Arkadaş, *Structural Pass Analysis* | Review path only. Descriptive, not predictive. |
| American Soccer Analysis, *Passing networks* | Topology transfers; spatial averaging must be rejected. |
| Nycander & Andersson, *Analysis of WrightEagle* (KTH 2013) | Weakest evidence. Subjective video analysis. |

### What transfers

**Passing lanes as a continuous value (hockey).** Grow a teardrop region
outward from the direct line until its edge touches the nearest opponent. The
size at contact, γ, measures openness. Four requirements worth adopting: always
return a real number; account for the area around both passer and receiver;
be asymmetric with respect to pass direction; scale with pass length. A
continuous value lets outlets be *ordered* without one being chosen.

**The reflection trick (hockey).** A one-bank pass off a wall is geometrically
identical to a direct pass to the receiver *mirrored about that wall*. Reflect
receiver and opponents across the wall, run the same direct-lane code, take
the largest γ across the direct option and each wall. Haxball caveats: `bCoef`
tells you how lossy each wall is, and `curveF` marks curved segments which the
mirror assumes away.

**Expected movement, cheaply (hockey).** Project the receiver forward along
their velocity for the pass duration. Project each opponent forward only until
the ball passes the perpendicular foot of that opponent onto the lane — after
that they cannot intercept. Reported to cut receiver-location error on over
94% of completed passes.

**The cone-obstruction test (MPNN).** Closed-form test for whether an opponent
blocks a passing cone, accounting for occlusion radius r:

```
arccos(ŵ · t̂) − arcsin(r / |t|) ≤ α/2      and      |t| ≤ |w| + r
```

First condition is angular overlap; second confirms they are *between* passer
and receiver. No raycasting or sampling.

**The decision-maker pattern (Maleki).** Phase one asks *can this action be
performed at all*, through boolean Decision Makers. Phase two picks among
survivors. **Take phase one, discard phase two** — a feasibility filter is an
enumeration engine. Also: pass viability as `t₁ < t(i)` for every opponent,
and shot viability by discretising the goal mouth into n positions.

**Space as distance to the nearest opponent (half-space).** The crudest metric
reviewed and the most immediately shippable. With three or four opponents, the
nearest usually *is* the binding constraint — the approximation improves as
roster size falls. Published as retrospective; **reversed it becomes live**:
for each candidate outlet, how much space on receipt?

**Free angle (Cyrus).** The angular width of unobstructed space toward a
target. Cheaper than a full lane model, pairs with the cone test.

**Strategic areas (RoboCup).** Each player has a home region whose centre
shifts with ball position. Makes "you are out of position" computable — an
*attention* failure, so it wants a nudge, not a diagram.

**Passing network topology (ASA), without the spatial half.** Who passes to
whom, how often. At three or four nodes the graph is readable and converges
within a match.

### What to stay away from

**Perception cones and facing-based awareness.** A game engine uses vision
cones to **handicap** its AI so a human can beat it — this project does the
opposite. *This rejection is narrow:* it applies to cones modelling
*perception*. The capability cone has the same shape and the opposite meaning.

**Learned receiver-selection models.** Predicting which teammate a
professional chose is a recommendation engine trained on expert choices. It
also needs ~200,000 labelled passes.

**Spatially averaged passing networks.** Placing each player at the average
coordinates of their passes averages away exactly the rotation that is the
core skill. A player who correctly swaps roles renders as a blob in a position
they never occupied.

**Plain Voronoi as a model of control.** Assumes instantaneous movement at
equal speed, discarding inertia. *Narrow rejection:* Voronoi is legitimate as
a computational tool — the largest empty circle sits at a Voronoi vertex, and
the dominance partition over zones *is* a generalised Voronoi diagram.

**Fuzzy classification of computable quantities.** Fuzzy logic handles
*uncertainty*, and theirs comes from noisy sensors. Bucketing a computable
quantity into linguistic categories discards precision already in hand.

**Outcome-based pass valuation as a live cue.** Line Bypass Score, Space Gain
Metric and Tactical Impact Value measure what a pass *did* afterwards. The
authors call the framework descriptive rather than predictive.

**Machine learning to recover information already available.** Cyrus trained a
deep network to predict teammate behaviour under noisy observation. Their own
control experiment is the argument against it:

| Mode | Win rate | Expected win rate |
| --- | --- | --- |
| Normal (noisy observation) | 7.09% | 8.19% |
| Chain action full-state | 24.64% | 33.46% |
| Full state | 72.7% | 85.76% |

Same team, same opponent. Their ML recovers 11.3%; full state recovers roughly
ten times that. **Haxball supplies full state for free.**

**Computer vision — out of scope, not deferred.** CV extracts state from
pixels; exact state already comes from the engine, so CV here is a strictly
lossy re-derivation. Relevant only for analysing recorded video from
uninstrumented games.

---

## Roadmap

Each overlay feature is a **feasibility filter** answering "is this action
available right now", never a chooser.

Every item below says what it is, why it is needed, and — where the honest
answer is "not yet obviously" — says that too. The ordering is not a strict
dependency chain; see [Where this actually gets
useful](#where-this-actually-gets-useful) at the end for the shortest path to
something worth having on screen.

### Infrastructure

**1. ~~Capture engine events and `GamePlayState`~~** — `feat/session-event-capture`

*What:* record kicks, goals, collisions and restart state to a session file
alongside the per-tick positions.
*Why:* without events, "who kicked it" has to be guessed from physics, and
without play state the data silently mixes live play with post-goal teleports.

**2. ~~Validate the reachable-zone formula against a real match~~** — 100%, bound tight

*What:* prove that the formula for "where can this player be in N ticks"
actually contains where they went, across a full recorded 6v6.
*Why:* nearly everything below rests on that one formula. Seven things were
wrong with it and none were visible by reading engine source. See
[README-session-event-capture.md](README-session-event-capture.md).

**3. Decide the analytics boundary** — worker or separate process

*What:* choose where the maths runs — in the game's own thread, in a Web
Worker, or in a separate process the overlay talks to.
*Why:* the game must hit its tick rate. If analytics ever stall the main
thread, the overlay makes the game worse than no overlay at all.
*Honest caveat:* **this is probably premature.** Nothing is known to be slow
yet — the only maths shipped so far is arrow-drawing. The usual second
argument, "a boundary makes analytics testable", does not hold: analytics
written as pure `(frame, geometry) → result` functions are already testable
offline against a session file, boundary or no boundary. Worth revisiting only
once something actually measures slow.

**4. Build the boundary and wire `loadSession.js` through it**

*What:* make the replay loader feed frames through the same path the live game
uses.
*Why:* so a recorded match can drive the analytics exactly as a live one does —
change a formula, replay the same match, see whether the output changed. Cheap
regression testing without playing games.
*Honest caveat:* inherits 3's. If 3 is deferred, this collapses into "call the
analytic function over the loaded frames", which `loadSession.js` already
supports.

### The foundational primitive

**5. The tick-parameterised reachable zone in the live path**

*What:* for any player, the region they can occupy in N ticks — an octagon
whose centre is displaced by current momentum. Already written and validated in
`scripts/validate-zone.mjs`; this is the port into the running game.
*Why:* this is the single primitive everything else is built from. "Who gets
there first", "is this player committed", "whose territory is this" are all the
same question asked with different N. Porting it is mostly moving code.

**6. Commitment**

*What:* the largest N for which a player physically cannot get back to where
they are standing now. A player sprinting one way has a number of ticks during
which that decision is locked in.
*Why:* **this is the first thing on the list that shows something the eye does
not already give you.** You can see that an opponent is moving fast. You cannot
see that they are committed for the next 19 ticks and therefore cannot contest
the near post. It replaces the arbitrary fraction-of-terminal-speed cutoff
currently in `momentumOverlay.js` with a number that means something.
*Cost:* small. It needs item 5 and nothing else.

**7. Orbit slew rate**

*What:* how fast a player holding the ball can swing it around themselves —
`ω = v / (r_player + r_ball)`, arithmetic from radii and per-map speed.
*Why:* it converts "I want to shoot that way" into "that takes me 8 ticks to
line up", which is what makes an aiming window a real constraint rather than a
drawn line. Feeds item 9.

### Geometry

**8. The raycast primitive** — *partly delivered early by `feat/ball-trajectory`*

*What:* `canReach(from, to, radius, cGroup, cMask)` — is the straight line
between two points clear for *this specific entity*, accounting for segments,
planes, discs and vertices.
*Why:* a passing lane is not "a clear line", it is "a clear line for a disc of
the ball's size and collision mask". Player 4 walks through a boundary the ball
bounces off. The collision-mask bug that nearly shipped (see DOMAIN.md
§ Pitfalls) was exactly this mistake made earlier.
*Status:* `ballTrajectory.js` already does the hard half — per-entity geometry
filtering, straight and curved segments, vertices, planes and static discs,
all validated against the engine. It answers the *bouncing* case a
straight-line `canReach` cannot. What remains is the cheap early-out form: a
boolean "is this segment clear" that does not simulate. Extract it from the
same collision set rather than writing new geometry code.

**9. The aiming gate** — *mechanics now verified, see [DOMAIN.md § Kicking](DOMAIN.md#kicking)*

*What:* for each candidate target, the angle you must turn through and the
ticks that takes (θ and `t_θ`), plus the cone of directions you can currently
deliver into.
*Why:* an option you cannot aim at in time is not an option. Without this the
overlay would list passes that are geometrically open and physically
impossible. Built as a filter inside the feasibility layer — never a drawn cone
on screen, which would just be clutter.
*Status:* the kick itself is now fully measured — range, impulse, direction,
arming behaviour and the pass/trap threshold. Enough to build a live aim
assist, which is the predictive feature the trajectory overlay turned out not
to be. Note the measured trap: a facing-ray aim assist is wrong by up to 50°
whenever the ball is moving.

**10. Cheap availability metrics**

*What:* forward space (how far ahead of a player is clear) and free angle (how
wide a window they have). Both linear time.
*Why:* an intentional cheap approximation, shippable before the full lane model
exists. Gets something useful on screen early and gives a baseline to check the
expensive version against.

**11. The pairwise matrix as substrate**

*What:* one player-by-player table holding distances, lane clearances and
reach-times, computed once per tick and read by everything downstream.
*Why:* items 12–17 all want the same numbers. Computing them once and sharing
is the difference between one pass over 12 players and six.

### Enumeration

**12. Time-consistent feasibility, including the null action**

*What:* evaluate each option against where everyone *will be* when the ball
would arrive — not where they are now — and return a cost in ticks rather than
open/closed.
*Why:* this is the correctness fix that makes the whole idea honest. A lane
that is open now and shut in 6 ticks is not open. Including the null action
(hold the ball, wait) matters because holding is frequently the right play and
an option list that omits it is quietly telling you to do something.

**13. The γ lane model plus wall reflection**

*What:* the full version of item 10 — lane quality as a continuous value, and
passes that bounce off walls.
*Why:* wall passes are a genuine, heavily used Haxball option that a
straight-line model cannot see at all. This is where the overlay starts
covering options a player might actually miss.

**14. Corner assistant**

*What:* in corner situations specifically, enumerate the available options.
*Why:* corners recur constantly, the option set is small, and the geometry is
simple — comparing ball position against known map vertices. A contained place
to prove the enumeration idea works before applying it to open play.

### Structure and events

**15. Team graph and topological events**

*What:* treat the team as a graph of who can reach whom, and detect the moments
it changes shape — a connection breaking, the team splitting in two.
*Why:* the interesting thing is the *transition*, not the state. Drawing the
graph continuously is noise; saying "your defence just disconnected" is
information. Hysteresis stops it flickering.

**16. Classification layer**

*What:* pair kick events with what happened next to label them pass,
clearance, shot, turnover.
*Why:* **honestly, this one is for review, not for play.** Knowing a kick was a
turnover tells you about something already finished. It earns its place only if
replay analysis becomes a real goal (see Open questions) — as a live overlay it
fails the three-filter test on its face. Keeping it listed because the data is
already captured and the work is small, not because it is close to useful.

**17. Dominance regions**

*What:* for each point on the pitch, who reaches it soonest — the lowest N
whose zone contains that point.
*Why:* the natural "whose space is this" picture, and it falls straight out of
item 5. Risk to watch: this is the classic football-analytics visual, and it is
easy to build because it looks impressive rather than because it answers a
question a player is asking mid-game. Should be justified on its own terms when
it comes up, not assumed.

**18. Positional cues**

*What:* nudges about strategic area and team spread — text or a marker, not
diagrams.
*Why:* these are attention failures, not knowledge failures. The player would
know if they looked; they are looking elsewhere. So the right output is a
nudge, gated on whether the thing in question is actually off-camera — drawing
a diagram of something already on screen helps nobody.

### Where this actually gets useful

The list above is ordered by category, which is not the same as ordered by
value. Read honestly:

- **Item 6 could ship almost immediately.** It needs only the zone formula,
  which is written and validated. It is the first item that puts something on
  screen the eye cannot already supply, and it would replace the one piece of
  guesswork currently in the shipped overlay.
- **Items 3–4 sit ahead of everything and may not need to.** They are
  performance infrastructure for a performance problem nobody has measured.
- **Item 12 is where the project's core claim gets tested.** Twelve items in.
  Reaching it sooner is worth more than completing the ones before it.
- **Items 16 and 17 should be justified before being built,** for opposite
  reasons — one is review-oriented, the other is visually impressive.
- **Item 8 arrived early, out of order, and that was right.** It came out of
  `feat/ball-trajectory` because the ball's path is the one thing on the pitch
  that is exactly predictable, so it was the cheapest place to build and prove
  real collision geometry. Take the same opportunity elsewhere when it appears
  — the ordering below is a default, not a queue to be respected.

A reasonable re-ordering, if speed to something valuable matters more than
tidiness: **5 → 6 → 8 → 7 → 9 → 12 → 14**, with 3, 4 and 11 pulled in the
moment a measurement says they are needed, and 10 slotted in if an early win is
wanted.

---

## Open questions

- Separate process or in-app Web Worker for the analytics boundary.
- Whether replay/review is a first-class target alongside live play, or only a
  development harness. This gates how much the tool can show and whether it is
  shareable.
- Whether cues should be suppressed outside `GamePlayState.Playing`, or shown
  in `BeforeKickOff` too — setup positioning is arguably the most coachable
  moment.
- Hysteresis thresholds and minimum dwell time for topological events.
- Whether "defensive line" is meaningful below 4v4, or degenerates.
- Whether the angular interval set stays a one-off, or becomes a third
  first-class shape.

---

## Known gotchas

**Black canvas on join, sound still playing.** Disable WebGPU in Settings →
Video to fall back to WebGL — WebGPU texture allocation can fail silently on
some Linux/driver combinations.

**Session files grow fast.** 60 ticks/s plus collision events. Pass
`captureCollisions: false` to `useHaxballAnalytics` if files get unwieldy.

**Don't assign `room.onAfterXxx` directly.** `Game.jsx` already owns several.
Chain defensively — see `chainRoomCallback` in `useHaxballAnalytics.js`.

**Ball access on extrapolated state.** There is no `getBall()` equivalent on
`RoomState`. The renderer reads the ball as
`gameState.physicsState.discs[0]` — disc index 0 is always the ball.

---

## License

MIT. See [LICENSE](LICENSE). The upstream client's README is preserved as
[README-original.md](README-original.md).
