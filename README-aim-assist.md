# Aim assist

Branch: `feat/aim-assist`.

**Purpose: show where the ball will actually go if kicked now, so the player
can correct their aim before committing.**

The first **predictive** overlay in the project. Everything before it —
momentum arrows, the ball path — is *descriptive*: it shows what is already
happening, which is largely what the eye supplies for free. This one shows the
consequence of an action not yet taken.

- `feat/ball-trajectory` answers **"where is the ball going?"** — a fact about
  something already decided.
- `feat/aim-assist` answers **"where would the ball go if I kick?"** — a fact
  about a choice still in front of you.

Or: drawing a line behind a pool ball you have already struck, versus the cue
line you see before taking the shot. Only the second one changes a decision.

---

## Status

**Complete.** Built, validated against the engine, and played.

| Area | State |
| --- | --- |
| Kick mechanics measured | ~~Done — [DOMAIN.md § Kicking](DOMAIN.md#kicking)~~ |
| Trajectory predictor to build on | ~~Done — `ballTrajectory.js`~~ |
| Scope decided | ~~Done — cue line only~~ |
| The reachable wedge | ~~Measured, 6 ball speeds — [DOMAIN.md](DOMAIN.md#the-reachable-wedge-measured)~~ |
| `aimAssistOverlay.js` | ~~Done~~ |
| `scripts/validate-aim-assist.mjs` | ~~Done — 4 checks, ALL PASS~~ |
| Wired into both views | ~~Done — registry, defaults, per-feature gating~~ |
| Seen running | ~~Done — kickoff, carrying, crossing ball, wall aim~~ |

```
physics PASS   range PASS   wedge PASS   reachable PASS
```

Deliberately **not** built: the sensitivity band, the naive-ray training
toggle, and training mode as a third settings axis. See [Left
unbuilt](#left-unbuilt-on-purpose).

---

## What it is

**A cue line, driven by the player's own orientation.**

There is no target picking in Haxball and none was added. A player's
orientation is already defined by physics: the ray from the ball's centre
along `ball − player`, extended ([DOMAIN.md § Facing, orbits and
aiming](DOMAIN.md#facing-orbits-and-aiming)). It is live and steerable — orbit
the ball and the ray sweeps.

The loop:

1. The player eyeballs a target, as they already do.
2. The overlay draws where the ball would **actually** go along the current
   orientation — through bounces, at true ball width, ending where the ball
   runs out of travel.
3. The aim is off, so the player orbits.
4. The line swings onto the target. Now kick.

It never names the target, never ranks anything, and never chooses. It reports
one physical fact about the current configuration. The human supplies the
intent, which is the only part that is not computable at all ([pitfall
10](DOMAIN.md#10-intent-is-not-computable)).

### What a player gets

- **You see your aim before you commit**, instead of discovering it was wrong
  after the pass has gone.
- **It corrects the thing everyone gets wrong** — a rolling ball does not go
  where you are pointing, because your kick is *added* to the motion it
  already has. Measured at 50° of error in an ordinary crossing situation.
- **Wall bounces stop being guesswork.** The rebound is flatter than a mirror,
  and the goal-side walls on the classic map (`e ≈ 0.05`) barely return the
  ball at all while looking identical to a lively wall.
- **You see where it runs out.** The line ends where the ball ends, so a pass
  that dies short is visible before it is made.

The goal is calibration, not dependence: a player who uses it for a while
should be able to switch it off and aim better than before.

---

## What is on screen

| Element | When | Meaning |
| --- | --- | --- |
| Cue line, cyan dashed | in kick range; on approach too unless switched off | the predicted post-kick path, through bounces |
| Swept corridor | in kick range only | the region the ball body would occupy — answers "does it fit" |
| Bounce dots | wherever the path turns | |
| Resting circle | when the ball would stop inside the horizon | where it actually ends up |
| Ball halo, white, fading up | approaching | how close you are to being able to kick |
| Ball halo, green, steady | a kick is available | |
| Range + contact rings | off by default (`showRangeCircle`) | the band you can kick from without touching the ball |

The cue line is **cyan and dashed** against the ball path's solid gold. That
separation is not cosmetic: one is counterfactual and one is actual, and two
similar lines from nearly the same origin with opposite epistemic status is
genuinely confusing.

### Controls

`Aim assist` in the overlay panel, with `on approach` nested under it. The
sub-option is disabled while its parent is off, so it cannot be left on in a
state where it does nothing.

---

## The physics

All verified in a headless sandbox against node-haxball 2.3.1. Full detail in
[DOMAIN.md § Kicking](DOMAIN.md#kicking).

**1. The post-kick velocity is one line.**

```js
v_post = ball.velocity + kickStrength * normalize(ball.pos − player.pos)
```

Feed that to `predictBallPath` and the result is exact. It automatically
captures cushioning and power, because whatever collision is happening now is
already baked into `ball.velocity`.

**2. Kick range is a hard circle**, `player.radius + ball.radius + 4`,
exclusive. 29 on the classic map. Computed live, never hardcoded — the
validator confirms the boundary fires at 28.99 and not at 29.00.

**3. The rebound is not a mirror.** The normal component is scaled by
`e = ball.bCoef * surface.bCoef`, the tangential is untouched, so the outgoing
angle is flatter whenever `e < 1`.

**4. Travel is bounded** at `|v| / (1 − damping)` — `100 · |v|` at the classic
damping. A dead ball kicked at `kickStrength` can never travel more than **500
units**. Some passes are not badly weighted; they are impossible in one touch.

**5. The reachable wedge.** Above ball speed `kickStrength`, only directions
within `asin(kickStrength / |v_ball|)` of the ball's heading are achievable at
all — 56.44° at speed 6. Now measured; see [DOMAIN.md § The reachable
wedge](DOMAIN.md#the-reachable-wedge-measured). Computed and exposed on the
returned object, not drawn.

---

## The trap avoided

**The facing ray is not the answer.** It is the obvious implementation and it
is wrong: the kick is *added* to the ball's existing velocity, so the result
is the vector sum, not the direction you are pointing. A ball crossing at
speed 6 kicked "straight up" leaves at **39.81°** where the facing ray claims
90°.

Fifty degrees of error, in an ordinary situation, and the overlay would look
most confident exactly when it was most wrong. Correcting that misconception
is most of the value of the branch: it is not a gap in the player's
information, it is a belief they hold that is measurably wrong.

---

## Exactness, and what actually varies

**The physics is not the uncertain part.** For a kick taken *this tick*,
`v_post` is exact and the resulting path is validated at p99 2.93e-13 over
32,805 tick comparisons. "Where does it end up" has an exact answer.

What varies is two other things:

1. **The kick has not happened yet.** While carrying, the ball jostles against
   the player every tick, so the exact answer changes with it. The line swings
   — that is the truth moving, not error, and smoothing it would be lying.
2. **Someone else may touch the ball.** Exact geometry, contingent on no
   interference. The argument for a short horizon, not a long one.

**A dead ball has no jostle**, so kickoffs and restarts are exact *and* stable.
Confirmed in play: "kickoff is rock solid".

---

## The lead-in band

Gating strictly on kick range made the cue useless for the case it was most
wanted in: lining a pass up *before* arriving, without nudging the ball. The
band where a kick can be taken without touching is only 4 units wide, so by
the time the cue appeared the choice was already being made.

```
leadIn = kickRange + terminalSpeed * leadInTicks
```

**Derived, not picked.** `terminalSpeed` is the player's own per-map top speed,
`acceleration / (1 − damping)` — the primitive `momentumOverlay` already had,
now exported rather than recomputed. Expressed in **ticks** so every map gives
the same run-up in time rather than in units. Classic: 2.5 u/tick × 30 = 75
units, so the cue appears at gap 104 instead of 29.

Out there the cue means something weaker. Inside range: "kick now and this
happens". Outside: "if you were in range at this angle, this is where it would
go" — exactly true for a ball at rest and stays true while you walk up, decays
for a moving one. The drawing says so rather than leaving it implicit: the cue
**fades with distance**, and the corridor is **suppressed** until in range.

**`leadInTicks` is the tuning lever.** 30 is a guess about attention, not
physics. Lower it if the cue feels eager; `0` restores in-range-only. The
`on approach` toggle sets it at draw time rather than compute time — see
below.

---

## Two design findings worth keeping

Both generalise past this branch, and both were only visible by looking at the
running thing.

### A state change with no change in available action is not worth drawing

Contact was briefly a third halo state. It was wrong twice over. Crossing into
contact **does not change the kick** — the impulse is identical either way —
so it reported a fact the player could no longer act on: by the time it lit
up, the ball had already been nudged. And while dribbling the gap oscillates
across the contact threshold every few ticks as the ball rebounds off the
body, so it fired several times a second.

A cue that changes state without the *choice* changing is noise, however
truthful. The test is not "is this true" but "does this alter what is
available".

### Different claims decay at different rates and cannot share a fade

The cue line is contingent on arrival, so it fades with distance. The ball
halo answers "how close am I to being able to kick" — a proximity fact, true
right now — and it is most needed during the approach, which is precisely when
the cue line's fade was hiding it.

They were initially gated together, so turning the lead-in off also blinded
the approach. The band is now **always computed** and the toggle applies at
draw time only (`showLineOutOfRange`). **Group cues by how their truth decays,
not by which feature they arrived with.**

---

## Validation

`node scripts/validate-aim-assist.mjs` — four checks, not one.

| Check | What it proves | Result |
| --- | --- | --- |
| 1. Physics | predicted path vs engine, tick by tick, after a real kick | p99 **2.93e-13**, max 1.19e-12, 32,805 samples, 298/300 kicks fired |
| 2. Range | the boundary is where `kickRange()` says, and exclusive | fires at 28.99, not at 29.00 |
| 3. Wedge | achievable directions match the three regimes | exact at all six speeds |
| 4. Reachable | every drawn element can actually fire | stop marker, bounces, both wedge branches, both `inRange` branches |

**Check 4 is the one `feat/ball-trajectory` did not have.** There the physics
validator passed at 1e-13 while the overlay shipped a stop marker whose draw
condition could never be true — the validated part and the shipped part had
quietly diverged. Every new branch in the draw layer gets a new reachability
check rather than reusing the old one; the `inRange` rows were added when the
lead-in was.

The run is deterministic (fixed seed), so the numbers above are a baseline and
any divergence is signal rather than noise.

**A failure in 1–3 means the model is wrong. Do not loosen the tolerance.**
Check 3 failed on first run at 60.35° against a predicted 38.68°, and the
cause was the harness measuring kicks contaminated by body collisions — see
[DOMAIN.md § The reachable
wedge](DOMAIN.md#the-reachable-wedge-measured).

---

## Left unbuilt, on purpose

**The sensitivity band.** The honest version of "a zone showing margin of
error": sweep the orientation a few degrees either side, run `predictBallPath`
for each, show how far the landing point moves. Tight spread = forgiving shot;
wide = delicate. Cheap. Held back because the single line needed to be seen
first, and it reads well enough that the band is now a genuine question rather
than a fix.

**The naive-ray training toggle.** `showNaiveRay` exists in the style object,
defaulting off. Drawing the facing ray beside the true path makes the
discrepancy visible and teaches the correction — valuable in review, clutter
live.

**Training mode as a third axis.** Several cues teach best by showing the
player's wrong intuition next to the right answer. That is the entire point in
review and noise in a live game. If the answer is yes, it belongs alongside
`enabled` and `features` rather than as per-feature flags. Recorded as an open
question in the [main README](README.md#open-questions).

---

## Files

| File | Role |
| --- | --- |
| `src/features/analytics/aimAssistOverlay.js` | compute at tick rate, draw at render rate |
| `scripts/validate-aim-assist.mjs` | the four checks |
| `src/features/analytics/momentumOverlay.js` | `estimateTerminalSpeed` exported for the lead-in |
| `src/features/game/components/OverlayControls.jsx` | registry entry + `parent` nesting |
| `src/features/game/Game.jsx`, `src/features/replay/ReplayView.jsx` | defaults, tick seam, draw call |
| `src/assets/css/game.css` | indented sub-option row |

`computeAimAssist` reads `frame` (from `extractFrame`) rather than the room, so
every disc arrives normalized and there is no second convention to keep in
sync. It reuses `getCollisionSet` from the trajectory overlay — the ball is
the same entity, and the geometry cache is keyed the same way.

In both views the overlay settings state is declared **above** the analytics
hook, because `onTick` reads it and this codebase's convention is that the
tick closure never references a binding declared further down.

---

## Known traps carried forward

- **Collision resolution order** — discs before planes and segments
  ([pitfall 8](DOMAIN.md#8-collision-resolution-order-changes-the-answer)).
  Already correct in `ballTrajectory.js`; do not re-derive it.
- **`cMask = 0` means "all", not "none"** — pitfall 2.
- **Replay seeks** re-fire events and run `frameNo` backwards. The `onTick`
  seam suppresses them; anything stateful added here inherits the problem if
  it bypasses the seam ([pitfall
  7](DOMAIN.md#7-anything-cached-per-player-breaks-on-a-replay-seek)).
- **Per-disc physics is not captured.** `kickStrength` is read from
  `playerPhysics`; a map or host that overrides it per disc is not handled,
  and `computeAimAssist` returns null rather than guessing when it is absent.
- **Play knowledge is a hypothesis generator.** Every claim from playing the
  game has been correct so far, and every mechanism behind those claims has
  differed from the obvious reading.

---

## What this leaves behind

- **A validated counterfactual predictor.** "What would happen if" is now a
  solved shape: hypothetical velocity into the existing path simulator.
  `feat/receive-outcome` needs nothing new from the physics.
- **The wedge**, promoted into DOMAIN.md, including the `= kickStrength`
  regime the first derivation missed.
- **A four-check validator pattern** that tests the display logic and not only
  the maths.
- **Two design rules** (above) that apply to every overlay after this one.
- **`estimateTerminalSpeed` exported**, which anything needing "how far can a
  player get in N ticks" will want — `feat/reachable-zone` first.
