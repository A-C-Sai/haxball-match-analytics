# Haxball Tactical Analytics

Computer-assisted analysis of Haxball games, built as a fork of the
open-source Haxball client.

*(The repo name and the old title say "live overlay". That predates the
direction change recorded below and in [PROGRESS.md](PROGRESS.md); the live
overlay is now the smaller of two tracks, not the product.)*

The aim is to **make the players better**, not to play for them. That is a
learning goal, and it decides almost every design question that follows —
because a tool that hands you the answer mid-game improves your play while it
is switched on and teaches you nothing, which this file has always said:
*that trains dependence and stops teaching the moment it is switched off.*

So the tool has two jobs on two timescales, and they are not the same product:

| | When | What it does | Bandwidth |
| --- | --- | --- | --- |
| **Measure and explain** | between games | which options went unused, what you should practise, how your execution is actually failing | unlimited |
| **Direct attention** | during play | one thing, now, over there | 1–2 bits |

The between-games track is where the value is, because it is the only one
with room to explain, and explanation is what makes a lesson yours. The live
track is not a smaller version of it — it is a different thing entirely, and
the only live job supported by the evidence is **pointing the eyes**, not
telling them what to conclude.

**What the tool never does:** improve execution in the moment. Aiming, timing
and touch are motor skills. No cue helps you perform one, and reading a cue
competes for the moment in which you would perform it. The tool can measure
how your execution fails and tell you what to drill; it cannot aim for you and
should not try.

### And a third job: test what the player already believes

Everything a player knows about this game is a model built from watching it,
and **perception is excellent at noticing and unreliable at explaining.**
Pitfall 2 is the worked example: the observation *players stop dead at
x = ±405* was correct, and two successive explanations of it were wrong, one
of them sitting in DOMAIN.md marked **Verified** through four branches. What
actually caused it is invisible — a room script writing positions — so no
amount of careful watching could ever have settled it.

So a first-class use of the corpus is checking beliefs, not only finding
unused options. *I think the ball comes off a moving player differently — is
that true?* DOMAIN.md is already this, done by hand.

---

## What the finished thing looks like

Concretely, so that no future branch mistakes the overlay for the product.

**During play: nothing.** Perhaps a rare spatialised tone when something is
closing that the player cannot see. That is the whole live product, and its
smallness is deliberate.

**After a session**, point it at the replay files. It runs headless and
produces a short list — not statistics, *moments*:

```
14 moments from tonight (3 games)
  4x  held under pressure with a first-time option open
  3x  a teammate arrived unmarked while you were facing away
  2x  cleared when a retained possession was available
  5x  shot taken with a better angle one touch away
```

**Click one.** The existing replay harness jumps there, paused, a second
before the decision. It plays out, then shows what else was available — which
lanes were open, who could have reached what, how long there actually was.
The player judges it: *missed it* / *had a reason*. Ten minutes for a session.

**Occasionally with the team.** The moments about shape rather than
individual choices, everyone on screen at once. That is how football review
actually works, and it is what the word *we* in the aim is pointing at.

**Over months**, the measurements that need volume — *you hold the ball 0.4s
longer under pressure than you did in April* — which nobody can self-assess
and which say what to drill.

**Whenever wanted**, inquiry mode: a question about the game or about your own
play, answered from data instead of recollection.

So: **review** (here are the moments worth a second look) and **inquiry**
(here is a question, answered). Less like a HUD, more like a coach's laptop —
opened between sessions, argued with, and some of it changes what happens next
time.

**The acceptance test for everything here: does it change what the player does
in the next game?** That is the check this project spent four branches without
having, and switching the overlays off was it being run informally.

---

## Documentation layout

Each file has one job, and only one of them goes stale.

| Document | Scope | Changes when |
| --- | --- | --- |
| [PROGRESS.md](PROGRESS.md) | **Where the project is.** What is done, what to do next, what is deferred and why. | every branch |
| **README.md** (this file) | The aim, what the finished thing is, design principles, architecture, prior art, and the roadmap — what each possible feature *is* | a principle or an item changes |
| [DOMAIN.md](DOMAIN.md) | How the game works, verified findings, pitfalls. Branch-agnostic. | something is measured |
| [README-replay.md](README-replay.md) | `feat/replays` — `.hbr2` playback | never (permanent record) |
| [README-session-event-capture.md](README-session-event-capture.md) | `feat/session-event-capture` — data layer + physics validation | never (permanent record) |
| [README-ball-trajectory.md](README-ball-trajectory.md) | `feat/ball-trajectory` — live ball path overlay at true ball width | never (permanent record) |
| [README-aim-assist.md](README-aim-assist.md) | `feat/aim-assist` — the cue line: where the ball would actually go if kicked now | never (permanent record) |

**Branch READMEs are permanent records**, not status pages. They say what was
built, how, and what went wrong. **None of them says what comes next** — that
is [PROGRESS.md](PROGRESS.md)'s job, and keeping it in one place is why it can
be trusted. A "Next" section in five files is five things to go stale, and
three of them had.

**The one thing that does get written back: a correction.** "Permanent" means
no status updates, not preserved errors. A branch README that states something
now known to be false gets a marked correction block — original text left
standing, the correction above it, dated to the branch that found it. The
record of what was believed is worth keeping; so is not re-teaching it.
Three carry one now, all from `fix/custom-map-geometry`, because a trap list
and a validated number are read as settled fact by whoever picks the branch up
next — which is exactly how a wrong `cMask` rule survived four branches.

**Read [DOMAIN.md](DOMAIN.md) before writing any analytics.** Several
plausible feature ideas die on that page, and every pitfall listed there cost
real debugging time to find.

---

## Status

**See [PROGRESS.md](PROGRESS.md).** Branch states, what is next and why, what
is deferred and for what reason, and the open decisions all live there — in
one file, so there is one thing to update and one thing to trust.

This file stays with the parts that do not change branch to branch: the design
principles, the architecture, the prior art, and the roadmap of what each
possible feature is.

---

## The momentum overlay, and what it was actually for

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

### `test-maps/` — keep it populated

`scripts/validate-trajectory.mjs` validates against the default stadium plus
**every `.hbs` in `test-maps/`**. Drop a map in and it is covered from then on.

This matters more than it sounds. The default stadiums carry almost no
decorative geometry and no one-way walls, so a predictor can be wrong by
hundreds of units on a real map while reporting floating-point agreement on
Classic — which is exactly what happened for four branches. If the directory
is empty the validator still prints `ALL PASS`, having tested one stadium, so
**an empty `test-maps/` is a green run that proves almost nothing.**

Custom maps are not in git. Copy in whatever you actually play on.

---

## Design principles

Binding, not advisory. A feature that fails these does not ship.

### Filter 0: is the bottleneck information, or execution?

**Asked before the other three, because they all presume the answer is
information.** If the limiting factor is a motor skill — aiming, timing,
touch, micro-positioning — then no cue helps, and a cue may actively
interfere by competing for the moment in which the act is performed.

This would have killed the aim cue on paper. It passes filter 2 honestly:
composing your own momentum into the kick genuinely is not free to compute.
But computing it was never the bottleneck. The player still has to place their
body, orient and release on the right tick, and knowing where the ball *would*
go does not do any of that for them.

An execution bottleneck is not beyond help — it is beyond *live* help. See
[Measure what cannot be felt](#measure-what-cannot-be-felt).

### The three-filter test

Once filter 0 says the bottleneck is information, a feature must fail at least
one of these to earn its place on screen.

1. **Is it perceptible?** Can the eye register it directly.
2. **Is it cheap to derive?** Some things are visible yet expensive to turn
   into a decision.
3. **Is it attended to?** The camera follows the ball; things can be visible,
   trivial, and still unseen.

**Filter 3 is the live track's entire territory.** Play has repeatedly shown
that filters 1 and 2 are near-impossible to fail against a skilled player on
this pitch — the scene is small, fully drawn, and physically simple, and they
have trained on it for years. What stays available is that the eyes are in one
place and the decisive thing is in another. Seeing is not the same as
attending, and a player fixed on the ball is not failing to perceive the
overlap behind them; they are failing to look.

That is a nudge, and a nudge is one bit: *here, now*. It cannot carry a reason,
because a reason has to be read (see
[Live cues are peripheral cues](#live-cues-are-peripheral-cues)). Anything
wanting to explain itself belongs between games.

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

### Advise, never act

**The line is not enumerate-versus-recommend. It is advise-versus-act.**

The tool may filter, rank and surface a shortlist. What it must never do is
take the action. The human reads the display and makes the move — always, with
no exceptions and no automation path. That is the boundary that matters, and it
is the one that stays stable under pressure to make the overlay more useful.

An earlier formulation of this principle said "enumerate, do not recommend",
and treated any ranking as the failure mode. That was wrong on its own terms.
**Every filter is an implicit ranking**, so "never recommend" is not achievable
— and showing all options at once is itself a choice, and the worst available
one. An unranked dump of every open lane makes the player pay the full
attention cost *and* still rank them under time pressure, which is exactly the
work the tool exists to absorb. For a live player, more options is not more
help.

What made "pass to 5" objectionable was never the ranking. It was the
**collapse**: one directive with the reasoning discarded. That trains
dependence and stops teaching the moment it is switched off. So the constraints
on a ranked display are:

- **Show the criterion, not just the order.** Why this outlet ranks where it
  does — lane quality γ, ticks to aim, who contests it. The player should be
  able to disagree with the ranking and see what they are disagreeing with.
- **Never reduce to a single unexplained imperative.** A shortlist with visible
  reasons is assistance; a bare arrow is a remote control.
- **Keep the null action in the set** (see below), or the ranking quietly
  recommends acting.
- **Prefer filters that remove options for physical reasons.** "You cannot aim
  there in time" is a fact; "this pass is worse" is a judgement. The aiming
  gate (roadmap item 9) is the least contentious kind of filter there is, and
  the most defensible place to do the cutting.

Filtering hard enough is not a compromise of this principle — it is required by
[Attention is the binding constraint](#attention-is-the-binding-constraint).
The two sections say the same thing from opposite ends.

### Enumeration is about search, not sight

**Relocated, not abandoned, by the 2026-09-23 direction change.** The original
justification was *show what is possible so the player decides better now*.
That justification is dead: a skilled player can already see the options, and
a list cannot be read mid-scramble anyway.

The surviving justification is different, and it is worth stating precisely
because the distinction is what makes the feature defensible at all:

> *I could see the options* and *I considered the options* are different
> claims, and only the first is about perception. With 300ms you evaluate two
> of four — not because two were invisible, but because there was no time to
> look.

That is a **search** limit, not a sight limit, and it is not fixable live —
the time genuinely is not there. What is fixable is the habit behind it, and
that only becomes visible in aggregate:

> a third option existed in 60% of your possessions; you used it in 8%

No single moment contains that claim, not even watched back. So enumeration
lives in review, as the input to pattern-finding, and never as a live display.
Ranking those options is a further step again, deferred and optional — with
time to think, the player judges the set perfectly well without being told an
order.

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

This is the same constraint as [Advise, never act](#advise-never-act) seen
from the other side. Surfacing one cue *is* a filter with a threshold of one,
and it is the right default — not a reluctant compromise of some purer
enumeration. The question for any feature is therefore not "how many options
can we show" but **how few, and on what stated criterion**.

### The ball is the wrong subject

Established the expensive way: three overlays shipped, all validated to
floating-point noise, all switched off in live play. Every one of them
describes the ball.

**The ball is the easiest possible subject for human perception**, on every
axis at once — a single object, no intentions, damped linear motion, and
permanently centred on screen because the camera is welded to it. Ball-side
quantities therefore fail filter 2 for nearly everyone, and the failure is not
observer-relative in the way the rejected "would a strong player know this"
formulation was. It is a property of the subject, not the viewer.

Two corollaries with teeth:

- **A cue that draws after the action it describes is retrospective**, whatever
  the maths says. The ball path renders once the kick is spent; the decision it
  could have informed is over. Retrospective cues can still pass a physics
  validator perfectly.
- **Where the ball path stops being free is after the first bounce.** A ball
  running straight to a stop is read for nothing. A ball off a wall at
  `bCoef 0.445`, off a post, or off a curved corner segment is not. If that
  feature is kept live, gate it to *from first contact onward* — which also
  removes most of its ink.

Everything the eye is bad at concerns *players*: what a body's momentum has
already taken away from it, how much unpressured time an opponent has, whether
a lane survives until the ball arrives. None of it is built.

### Measure what cannot be felt

The tool's real advantage over a skilled player is not perception and not
computation — both of those lost, repeatedly and on the evidence. It is
**persistence**. It watches all twelve players every tick of every game,
never tires, never has its attention pulled to the ball, and never forgets.

No human can audit their own five hundred kicks. That makes a whole class of
finding available to the tool and to nothing else:

- how long you sit in kick range before releasing, and how that changes under
  pressure
- whether kicks taken while moving laterally land differently from settled
  ones
- what share of your passes reach a teammate when contested versus free, and
  by how much the misses miss
- how many options existed per possession, and how many you used

None of that helps in the moment, and none of it is meant to. It tells you
**what to practise**, which is the mechanism by which execution actually
improves. It is also the one thing here that survives filter 0: execution
cannot be coached live, but it can be measured, and measurement is what makes
it coachable at all.

This is why the ball predictor is not wasted. The machinery that could not
help you aim is exactly what is needed to judge, afterwards, whether a kick
went where it should have.

### Live cues are peripheral cues

The camera follows the ball, so the player's fovea is on the ball. **Any cue
requiring an eye movement costs them the ball**, which makes "quick to read"
the wrong specification. The right one is *readable without being looked at*.

That sets a hard ceiling. Peripheral vision has poor acuity and poor colour
discrimination, but is excellent at motion onset and coarse luminance change.
A live cue must therefore render close to the ball and survive at low
resolution, which permits roughly **one to two bits**: urgency, safe/unsafe, a
coarse direction. Not text. Not a thin line that must be traced from end to
end — that is focal attention, several hundred milliseconds that do not exist
in a scramble.

This is why the aim cue only lands when play is slow. The information is
right; the *reading method* is too expensive. The same computation displayed
as a state signal — this kick, now, is on target or is not — is readable in a
glance because there is nothing to trace.

A ranked shortlist with visible criteria, which
[Advise, never act](#advise-never-act) requires, cannot be read in the
periphery mid-scramble. It is not a live artefact; it belongs in a window
where the player has time. Those windows exist — kick-off, dead ball, coasting
far from play — and are underused.

### A state change with no change in available action is not worth drawing

From `feat/aim-assist`. A "you are touching the ball" cue was built, and was
wrong twice over. Crossing into contact does not change the kick — the impulse
is identical either way — so it reported a fact the player could no longer act
on: by the time it lit up, the ball had already been nudged. And the dribble
physics crosses that threshold every few ticks, so it fired several times a
second.

**The test is not "is this true" but "does this alter what is available".** A
cue that changes state without the choice changing is noise, however accurate,
and a threshold the game naturally oscillates across will chatter — the same
argument that puts hysteresis on [topological
events](#team-structure-is-a-graph-not-a-polygon).

### Different claims decay at different rates and cannot share a fade

Also from `feat/aim-assist`, and the more reusable of the two. A cue
contingent on something that has not happened yet should weaken as that thing
gets less certain. A cue stating a fact about right now should not.

Those were initially gated together — the aim cue line fades with distance,
and the ball halo inherited the fade even though it answers "how close am I to
being able to kick", which is true right now and is *most* needed during the
approach. Turning the path preview off also blinded the approach.

**Group cues by how their truth decays, not by which feature they arrived
with.** In practice that usually means computing unconditionally and gating at
draw time, so a display choice cannot silently remove information that was
never contingent.

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

### What this needs, and what it does not

A standing decision, because the question recurs every time the aim sounds
ambitious: **this is arithmetic and geometry, not machine learning.** The
ladder, in the order it should be climbed, and most of it stops at the first
rung:

| Rung | Used for | Needed? |
| --- | --- | --- |
| Geometry + arithmetic | decision points, option enumeration, lane clearance, reachability, every execution measurement | **Yes — Phases 1–4 are entirely this** |
| Counting and frequency | a first notion of value: *possessions reaching here ended in a goal 12% of the time, elsewhere 3%* | **Yes, with a corpus.** No model required |
| Supervised model on tabular features | Phase 5 ranking, if counting is too coarse | Only if needed, and only if it stays interpretable |
| Reinforcement learning | — | **No** |
| Computer vision | — | **No** |

**No computer vision, ever.** CV exists to recover state from pixels when
state is unavailable. The engine hands over exact positions, velocities,
radii and masks at 60 Hz. Professional football analytics fights CV because
broadcast video is all it has; this project starts with the ground truth that
industry spends fortunes approximating. Reaching for CV here would be
throwing away a better input.

**No reinforcement learning**, and the objection is principled before it is
practical. An RL policy outputs an *action*, with the reasoning discarded —
which is exactly the collapse [Advise, never act](#advise-never-act) forbids.
It also learns to *play*, and playing well is not the same skill as
explaining what a human should have done. A self-play agent that beats you
teaches you nothing about why.

The practical objection is smaller than it looks, incidentally: node-haxball
is a fast deterministic simulator, so self-play is technically within reach.
That makes the principled objection the one that matters. **Accuracy that
cannot show its criterion is not usable output for this tool**, which rules
out black boxes whatever they score.

So the design principles do the tool selection. *Show the criterion, not just
the order* eliminates most of the fancy options before cost is even
considered — which means simple is not a compromise here. It is required.

The one thing genuinely missing is not an algorithm. It is **volume, and a
layer that turns physics into football** — possessions, passes, shots,
turnovers. Per-tick positions are not analysable; nothing tactical can be
counted until the stream is segmented into events with outcomes. That is
Phases 1–3, and it is pure derivation from data already captured.

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
  default in `Game.jsx`, one gating check in the draw loop. A registry entry
  may declare a `parent`, which renders it indented and disabled while its
  owner is off — so a sub-option cannot be left switched on in a state where
  it does nothing.
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
enumeration engine. The discard is about *autonomy*, not about ordering: their
phase two picks an action and then executes it with no human in the loop.
Ordering the survivors for a human to read is fine and often necessary (see
[Advise, never act](#advise-never-act)); handing the result to a controller is
not. Also: pass viability as `t₁ < t(i)` for every opponent,
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
available right now" — and, where it helps, how the survivors order. Never an
actor: nothing here ever touches the input path.

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

**5. The tick-parameterised reachable zone in the live path** — `feat/reachable-zone`

*What:* for any player, the region they can occupy in N ticks — an octagon
whose centre is displaced by current momentum. Already written and validated in
`scripts/validate-zone.mjs`; this is the port into the running game.
*Why:* this is the single primitive everything else is built from. "Who gets
there first", "is this player committed", "whose territory is this" are all the
same question asked with different N. Porting it is mostly moving code.
*Status:* validated at 100% against a full recorded 6v6 with the bound tight
(see [README-session-event-capture.md](README-session-event-capture.md)) and
**still not in the live path.** Re-validated after `fix/custom-map-geometry`
at 100.00% over 151,672 open-space samples — the earlier 100% had been reached
partly by a wrong mask rule filing the failing windows under contact, so the
figure survived but its derivation did not. One thing the port must handle
that the formula does not: a room script can write a player's position
outright, so the zone is *sound* but loose wherever a script is policing an
area (DOMAIN.md pitfall 2). It is the only unported primitive that other
branches are already waiting on — `feat/interception` cannot start without it,
items 6, 12 and 17 all reduce to it, and it is the first thing on the list that
puts something on screen the eye cannot supply. It is a port, not a
derivation: the formula is settled and the seven things that were wrong with
it have already been found.

**6. Commitment** — `feat/commitment`

*What:* the largest N for which a player physically cannot get back to where
they are standing now. A player sprinting one way has a number of ticks during
which that decision is locked in.
*Why:* **this is the first thing on the list that shows something the eye does
not already give you.** You can see that an opponent is moving fast. You cannot
see that they are committed for the next 19 ticks and therefore cannot contest
the near post. It replaces the arbitrary fraction-of-terminal-speed cutoff
currently in `momentumOverlay.js` with a number that means something.
*Cost:* small. It needs item 5 and nothing else.

**7. Orbit slew rate** — `feat/orbit-cost`

*What:* how fast a player holding the ball can swing it around themselves —
`ω = v / (r_player + r_ball)`, arithmetic from radii and per-map speed.
*Why:* it converts "I want to shoot that way" into "that takes me 8 ticks to
line up", which is what makes an aiming window a real constraint rather than a
drawn line. This is the whole of `feat/orbit-cost`, and the direct answer to
"should I correct my orientation" that the cue line raises but cannot answer.

### Geometry

**8. The raycast primitive** — `feat/raycast`, *partly delivered early by `feat/ball-trajectory`*

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

**9. The aiming gate** — *split; see below. Mechanics verified, see [DOMAIN.md § Kicking](DOMAIN.md#kicking)*

*What:* for each candidate target, the angle you must turn through and the
ticks that takes (θ and `t_θ`), plus the cone of directions you can currently
deliver into.
*Why:* an option you cannot aim at in time is not an option. Without this the
overlay would list passes that are geometrically open and physically
impossible. Built as a filter inside the feasibility layer — never a drawn cone
on screen, which would just be clutter.
*Status:* the kick itself is now fully measured — range, impulse, direction,
arming behaviour and the pass/trap threshold. Note the measured trap: a
facing-ray aim assist is wrong by up to 50° whenever the ball is moving.

This item has since split. The **θ and `t_θ` half** — the cost of correcting
an orientation — is `feat/orbit-cost`, and it is a filter, as described above.
The **cone half** is subtler than first written: there are two separate cones,
and only one of them is a time cost.

- The *orbit* cone, already in [DOMAIN.md § The capability
  cone](DOMAIN.md#the-capability-cone): directions reachable within `t` ticks
  of orbiting. Widens with time on the ball.
- The *reachable wedge*, **now measured** on `feat/aim-assist`: since a fixed
  impulse is added to the ball's current velocity, the achievable post-kick
  velocities form a circle of radius `kickStrength` centred on
  `ball.velocity`. When the ball is moving faster than `kickStrength`, only a
  wedge of half-angle `arcsin(kickStrength / |v_ball|)` is reachable **at
  all** — 56.44° at ball speed 6 — and no amount of orbiting escapes it.

The first is "you cannot aim there *yet*"; the second is "you cannot aim there
*ever*, from this ball state". The wedge has since been swept against the
engine at six ball speeds and promoted into [DOMAIN.md § The reachable
wedge](DOMAIN.md#the-reachable-wedge-measured) — including a third regime at
`|v| = kickStrength` that the original two-case derivation missed.

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

- **The cue line (`feat/aim-assist`) jumped the queue, and that was right.** It
  needed no primitive that did not already exist, it is exact rather than
  approximate, and it is the first feature aimed at a *skill* rather than a
  tactical read. It sat outside the numbered list because the list is
  organised around enumeration and this is not an enumeration feature —
  which is worth remembering as a pattern, not treated as an exception.
- **`feat/reachable-zone` (item 5) is the most depended-on unported
  primitive.** Written, validated at 100%, and four separate things wait on
  it. Nothing else on the list has that profile — which is an argument about
  *dependencies*, not about value, and it was read as the latter for three
  branches.
- **The whole list is ranked by what unblocks what, not by what a player would
  use.** That is a real gap in this catalogue, and it is why every item on it
  should now be asked the [subject](#the-ball-is-the-wrong-subject) and
  [bandwidth](#live-cues-are-peripheral-cues) questions before it is picked
  up. An item that cannot be read in the periphery is not a live feature, and
  an item about the ball probably is not a feature at all.

These are judgments about the items themselves, and they stay here. **What to
actually build next, and in what order, is in
[PROGRESS.md](PROGRESS.md#what-to-do-next)** — it changes every branch, and
this list does not.

---

## Open questions

**See [PROGRESS.md](PROGRESS.md#open-decisions).** Kept with the rest of the
mutable state rather than here, so a decision gets recorded in one place when
it is finally made.

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
