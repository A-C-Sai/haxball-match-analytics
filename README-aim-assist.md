# Aim assist

Branch: `feat/aim-assist`.

**Purpose: show what a kick *would* do, before it is taken.**

This is the first **predictive** overlay in the project. Everything shipped so
far — momentum arrows, the ball path — is *descriptive*: it shows what is
already happening, which is largely what the eye supplies for free. This one
shows the consequence of an action not yet taken.

The difference in one line:

- `feat/ball-trajectory` answers **"where is the ball going?"** — a fact about
  something already decided.
- `feat/aim-assist` answers **"where would the ball go if I kick?"** — a fact
  about a choice still in front of you.

Or: drawing a line behind a pool ball you have already struck, versus the cue
line you see before taking the shot. Only the second one changes a decision.

---

## Status

**Not started.** No code on this branch yet. Everything below is either
already-verified physics or a decision still to make.

| Area | State |
| --- | --- |
| Kick mechanics measured | ~~Done — [DOMAIN.md § Kicking](DOMAIN.md#kicking)~~ |
| Trajectory predictor to build on | ~~Done — `ballTrajectory.js`, validated~~ |
| Design decided | Partly — see [Open questions](#open-questions) |
| `aimAssistOverlay.js` | Not started |
| `scripts/validate-aim-assist.mjs` | Not started |
| Wired into the views | Not started |
| Seen running | Not started |

**Why this is cheap:** the hard parts are already done. The physics is
measured, the predictor is validated, and the overlay plumbing (`onTick` seam,
per-feature gating, the feature registry) exists and works. This branch is
mostly one formula plus rendering decisions.

---

## The physics, already settled

All verified in a headless sandbox. Full detail and measurements in
[DOMAIN.md § Kicking](DOMAIN.md#kicking); the four facts that shape this
branch:

**1. The post-kick velocity is one line.**

```js
v_post = ball.velocity + kickStrength * normalize(ball.pos − player.pos)
```

Feed that to `predictBallPath` and the result is exact. It automatically
captures cushioning and power, because whatever collision is happening right
now is already baked into `ball.velocity` — no special-casing for whether the
player is advancing or retreating.

**2. Kick range is a hard circle.**

```
range = player.radius + ball.radius + 4      (centre-to-centre, exclusive)
```

29 on the classic map, and the `+4` tracks the radii — compute it, never
hardcode. "Am I actually in range" is a real question with an exact answer,
and drawing that boundary is useful on its own.

**3. A held kick is ARMED, not press-timed.** One press fires on the first
tick the ball is within range. This is the finding that makes "ahead of time"
possible: when the ball is still approaching, the useful prediction is not
"what happens if I kick now" — nothing happens now — but **"what happens when
the ball arrives"**, computed by projecting the ball to the tick it enters
range and applying the impulse there.

**4. Pass or trap, decided by an invisible threshold.**

```
ball is sent away   ⟺   closing speed < kickStrength
```

Under it, the ball is returned — gently near the boundary, which is the
controlled short pass. Over it, the kick cancels most of the pace but cannot
reverse it: the ball creeps in, touches the player and **stops dead on them**.
That is a trap, not a loss. Both are useful; the threshold decides which you
get, and closing speed is not something a player can read off the screen.

**This is the strongest single candidate in the branch.** It passes the
three-filter test cleanly: perceptible consequences, cheap to derive,
genuinely not available to the eye.

---

## The trap to avoid

**Do not draw the facing ray.** It is the obvious implementation and it is
wrong. The kick is *added* to the ball's existing velocity, so the resulting
direction is the vector sum, not the direction you are pointing. Measured: a
ball crossing at speed 6, kicked "straight up", leaves at **39.81°** where the
facing ray claims 90°.

**Fifty degrees of error**, in an ordinary situation — receiving a pass, ball
rolling across the box — and the overlay would look most confident exactly
when it is most wrong. Worse than no overlay.

The correct version costs one extra vector addition.

---

## What to build

No new physics. This is `ballTrajectory.js` fed a hypothetical velocity.

- **`src/features/analytics/aimAssistOverlay.js`** — compute at tick rate into
  a ref, draw at render rate, mirroring `ballTrajectoryOverlay.js`. Reuse
  `buildCollisionSet` and its geometry cache; the ball is the same entity.
- **`scripts/validate-aim-assist.mjs`** — see [Validation](#validation).
- **Registry + defaults** — one entry in `OVERLAY_FEATURES`, one key in each
  view's `overlaySettings`. The per-feature draw gating already exists.

### What to show

Ranked by how much each adds beyond what the eye has:

1. **Pass-or-trap verdict.** The threshold above. Invisible, decisive, cheap.
2. **Predicted post-kick path**, from the corrected velocity, through at least
   the first bounce. Straight-to-the-wall is guessable; where it goes after is
   not.
3. **Kick-range circle**, computed exactly rather than eyeballed.

### What not to show

- The facing ray (see above).
- A long horizon. The prediction is exact only for the instant it describes;
  a long tail would look authoritative while being decoration.
- Anything while the player cannot act on it.

---

## Open questions

Decide these before writing much, since they change the shape of the code.

**Whose kick?** The decision-support case is the local player. But
`ReplayView` has no local player (`currentPlayerId` is -1), and the branch is
meant to be developed against replays. Suggested: local player when there is
one, otherwise whichever player currently has the ball in range. The second
is arguably more useful for review anyway.

**Should it show an opponent's kick?** Technically identical, tactically
different — it becomes threat assessment rather than aiming. Worth separating,
possibly a different visual treatment. Probably not in v1.

**How to handle volatility.** During contact the ball's velocity swings hard
from tick to tick (measured: −6.88 → −1.16 → −0.35 within a few ticks), so the
prediction swings with it. That volatility is **real information** — the
timing genuinely is the skill, and this would be the first thing to make it
visible — but it will look busy. Smoothing it would be lying. Decide
deliberately rather than discovering it looks broken.

**How far ahead to predict on an armed kick.** Projecting to the arrival tick
is computable, but the further ahead, the more likely something intervenes.
The principled bound is "until another player can reach the ball", which needs
the reachable-zone primitive (roadmap item 5). An arbitrary cap is fine to
start; note it as arbitrary.

**Does this need the aiming gate?** Roadmap item 9 also covers θ and `t_θ` —
how long it takes to *rotate* the kick direction into place by orbiting the
ball. That is a separate, larger piece. This branch can ship without it and
answer "what does kicking now do" rather than "what could I set up".

---

## Validation

The physics validator pattern carries over directly, and **this branch needs
its own**: press the kick in a sandbox, compare the engine's resulting ball
path against the prediction, tick by tick. Same standard — agreement at
floating-point noise, and a failure means the model is wrong, not that the
tolerance should move.

`scripts/validate-trajectory.mjs` is the template. The kick experiments that
produced [DOMAIN.md § Kicking](DOMAIN.md#kicking) already contain most of the
harness: placing a player at a chosen distance and angle, pressing kick with a
genuine rising edge, and differencing against a no-kick control run.

**But note what that validator cannot catch.** On `feat/ball-trajectory` the
physics validator passed at 1e-13 while the overlay shipped a stop marker that
could never draw — the condition was unreachable, and the validator only ever
tested the physics, not the display logic layered on top. The validated part
and the shipped part had quietly diverged.

So this branch wants **two** checks: the prediction against the engine, and a
cheap sanity check that each drawn element can actually fire in the states the
overlay will really be in. See [DOMAIN.md § Pitfalls
#9](DOMAIN.md#9-an-experiment-that-cannot-show-the-effect-will-report-its-absence).

---

## Known traps carried forward

- **Collision resolution order** — discs before planes and segments
  ([pitfall 8](DOMAIN.md#8-collision-resolution-order-changes-the-answer)).
  Already correct in `ballTrajectory.js`; do not re-derive it.
- **`cMask = 0` means "all", not "none"** — pitfall 2 in
  [DOMAIN.md § Pitfalls](DOMAIN.md#pitfalls).
- **Replay seeks** re-fire events and run `frameNo` backwards. The `onTick`
  seam already suppresses them; anything stateful added here inherits that
  problem if it bypasses the seam
  ([pitfall 7](DOMAIN.md#7-anything-cached-per-player-breaks-on-a-replay-seek)).
- **Play knowledge is a hypothesis generator.** Every claim from playing the
  game has been correct so far, and every mechanism behind those claims has
  differed from the obvious reading. Test the mechanism; keep the observation.

---

## Getting started

```bash
git checkout -b feat/aim-assist      # from feat/ball-trajectory
```

Read [DOMAIN.md § Kicking](DOMAIN.md#kicking) first — it is the whole basis of
this branch and it contains several things that contradict how the mechanics
feel from inside the game.

Then the shortest path to something real: build the pass-or-trap verdict
first. It is a single comparison, it needs no rendering beyond a two-state
indicator, and it is the item on the list that the eye genuinely cannot
supply. If it turns out not to be useful on screen, that is worth knowing
before building the path rendering around it.
