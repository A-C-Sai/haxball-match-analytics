# Progress

**The single place that says where this project is.** Everything else is
either permanent (how the game works, how a branch was built) or a catalogue
(what could be built). This file is the only one that goes stale on purpose,
and the only one that needs updating when a branch lands.

Last updated: after `fix/players-block-predictions`.

---

## Where things stand

Four branches done plus one cross-cutting fix. A working data layer, replay
playback as a test bench, a tick-exact ball predictor, and three overlay
features.

| Branch | State | What it left behind |
| --- | --- | --- |
| [`feat/replays`](README-replay.md) | **Merged** | `.hbr2` playback, shared renderer, the analytics hook runs unmodified against a replay |
| [`feat/session-event-capture`](README-session-event-capture.md) | **Complete** | events + game state captured; the reachable-zone formula validated at 100%, bound tight |
| [`feat/ball-trajectory`](README-ball-trajectory.md) | **Complete** | tick-exact ball predictor (p99 2.4e-13), live overlay at true ball width, most of the raycast primitive |
| [`feat/aim-assist`](README-aim-assist.md) | **Complete** | the cue line (p99 2.93e-13), a validator that tests display logic too, the reachable wedge |
| `fix/players-block-predictions` | **Complete** | both overlays stop drawing through bodies; `predictBallPath` takes per-tick blockers |

That last one is a fix off `main`, not a feature branch: it touches
`ballTrajectory.js` and `aimAssistOverlay.js`, so it belongs to neither of the
branches that own them. **Branch from `main`, not from a merged feature
branch**, or the bug comes back.

**What exists:** per-tick extraction, per-map geometry, engine events, NDJSON
session logging, replay playback, a validated ball predictor, and three
overlays — momentum arrows, the ball path, the aim cue.

**What does not:** any analytics function about *players*. No LOS, no passing
lanes, no dominance, no commitment. Everything shipped is about the ball,
which is the easy half — the ball has no intentions and cannot accelerate
itself. Players now appear in the predictions only as *blockers*: the path is
cut where a body would stop it, which needs no claim about where anyone is
going. Anything more needs `feat/reachable-zone`.

---

## What to do next

### `feat/reachable-zone` — the bottleneck

Roadmap item 5: port the tick-parameterised reachable zone into the live path.

**Why it is next.** It is the only unported primitive that other work is
already waiting on. It is written and validated at 100% against a full
recorded 6v6, so this is a port rather than a derivation — the seven things
that were wrong with it have already been found. Four separate items collapse
into it:

- `feat/interception` cannot start without it
- item 6 `feat/commitment` is a one-liner on top of it
- item 12 (time-consistent feasibility) needs it
- item 17 (dominance regions) falls straight out of it

Three branches have now shipped without touching it. It is the single thing
most likely to unblock the rest.

### `feat/orbit-cost` — the natural follow-up to aim assist

Roadmap item 7. `t_θ = θ·(r_player + r_ball)/v` — how many ticks it takes to
rotate the kick direction into place. It answers the question the aim cue
raises but cannot: *should I correct my orientation, and can I afford to?*

Needs no new primitive. Small.

### Either order is defensible

`feat/reachable-zone` unblocks more. `feat/orbit-cost` finishes a thought the
player is already having. Pick by whether you want breadth or depth next.

---

## The aim-assist family

One branch turned out to be five questions wearing one name. Split so each can
be judged on its own — an overlay that fuses them cannot be evaluated, because
if the combined thing feels bad you cannot tell which part caused it.

| Branch | Question | Depends on | State |
| --- | --- | --- | --- |
| `feat/aim-assist` | where would the ball go if I kick now | — | **done** |
| `feat/orbit-cost` | how many ticks to correct my aim by θ | — | not started |
| `feat/receive-outcome` | will this arriving ball come back off me, or die at my feet | — | not started |
| `feat/lane-clearance` | does the ball *fit* through that gap | `feat/raycast` | not started |
| `feat/interception` | will this pass get cut out | `feat/reachable-zone` | not started |

Two of those dependencies are branches of their own, not sub-tasks:

- **`feat/reachable-zone`** — roadmap item 5, above.
- **`feat/raycast`** — the cheap boolean half of item 8, extracted from the
  collision set `ballTrajectory.js` already builds. The curved-segment chord
  approximation noted in
  [README-session-event-capture.md](README-session-event-capture.md#known-limitations)
  is explicitly not good enough for it.

`feat/receive-outcome` depends on nothing and can land at any point — the
pass-or-trap threshold is already measured.

---

## Deferred, with reasons

Not "todo". Each was considered and deliberately left.

| Thing | Why it is waiting |
| --- | --- |
| The sensitivity band (aim assist) | Wanted the single cue line seen in play first. It reads well, so the band is now a real question rather than a fix. |
| Naive-ray training toggle | `showNaiveRay` exists, defaults off. Blocked on the training-mode question below. |
| Training mode as a third settings axis | Several cues teach by showing the wrong intuition beside the right answer — the point in review, clutter live. One concrete case now waits on it. |
| Analytics boundary (items 3–4) | Performance infrastructure for a performance problem nobody has measured. Revisit when something measures slow. |
| Classification layer (item 16) | Review-oriented, not live. Justify before building. |
| Dominance regions (item 17) | Easy to build because it looks impressive. Justify on its own terms. |

---

## Open decisions

Carried forward until something forces them.

- Separate process or in-app Web Worker for the analytics boundary.
- Whether replay/review is a first-class target alongside live play, or only a
  development harness. Gates how much can be shown and whether it is
  shareable.
- Whether cues should be suppressed outside `GamePlayState.Playing`, or shown
  in `BeforeKickOff` too — setup positioning is arguably the most coachable
  moment.
- Whether a training mode is a third axis alongside `enabled` and `features`.
- Hysteresis thresholds and minimum dwell time for topological events.
- Whether "defensive line" is meaningful below 4v4, or degenerates.
- `leadInTicks` for the aim cue is 30 — a guess about attention, not physics.

---

## Lessons that changed how things get built

The expensive ones. Each cost real debugging or a shipped mistake.

**Validate the display, not only the maths.** `feat/ball-trajectory` passed
its physics validator at 1e-13 while shipping a stop marker whose draw
condition could never be true. Every validator since checks that each drawn
element can actually fire in the states the overlay will really be in — and
that check has now caught a second dead branch.

**A validator's exclusions are load-bearing claims about what it does NOT
prove.** `validate-trajectory.mjs` parks every player on purpose and says so
in a comment, because it is validating ball-vs-geometry. That caveat never
travelled to what the overlay claimed on screen, so "p99 2.4e-13" circulated
as though it covered everything — through two branches, while both drew
straight through player bodies. Write the exclusion next to the number.

**A false negative is as available as a false positive.** Pitfall 9 in
DOMAIN.md, now six instances. Three hid a wrong number; one hid an entire
class of situation; **two were sprung inside a test written to catch that very
thing.** Constructing a case that cannot show the effect is not a mistake you
stop making — it is the default outcome of building a setup around what you
expect to see. State what the setup would look like if the effect were
present, then confirm the setup could produce it.

**A fix that passes is not a fix that is right.** The blocker work took three
attempts — exclude the kicker, release on separation, release on direction —
each correct for the case in front of it and wrong for the next, and each
found by someone playing rather than by a test. Every case that broke a
version is now in the validator, which is the only thing that makes attempt
four cheaper than attempt three.

**Derivations have missing cases that measurement finds.** The reachable wedge
was derived with two regimes and has three; the boundary case only appeared
when the sweep ran.

**A state change with no change in available action is not worth drawing.**
Shipped a contact cue that was both uninformative and chattering. The test is
"does this alter what is available", not "is this true".

**Different claims decay at different rates.** A cue contingent on arrival
should fade; a cue stating a fact about now should not. Group by how truth
decays, not by which feature they arrived with.

**Play knowledge is a hypothesis generator.** Every claim from playing the
game has been correct so far, and every mechanism behind those claims has
differed from the obvious reading. Test the mechanism; keep the observation.

---

## How to pick this up

1. **Read [DOMAIN.md](DOMAIN.md)** before writing any analytics. Several
   plausible feature ideas die on that page.
2. **Read [README.md](README.md)** for the design principles — they are
   binding, and a feature that fails them does not ship.
3. **Read the branch README** for whatever you are building on. They are
   permanent records of how a thing was built and what went wrong; none of
   them tell you what to do next, because that is this file's job.
4. **Run the validators** before trusting anything:
   ```bash
   node scripts/validate-zone.mjs analytics-sessions/session-<stamp>.ndjson
   node scripts/validate-trajectory.mjs
   node scripts/validate-aim-assist.mjs
   ```
   All are deterministic, so their numbers are baselines and any divergence is
   signal. Current: trajectory p99 `2.43e-13`; aim assist p99 `2.93e-13`, wedge
   `180/180/89.50/56.44/38.68/24.62`, blockers truncating at tick 21 where the
   engine diverges at tick 21.

   **Read what each validator excludes before quoting its number.** Check 1 of
   the aim-assist validator parks every player, so it proves nothing about
   ball-vs-player; that is check 5's job.

**When a branch lands, update this file and nothing else.** The branch README
records what was built; the roadmap in README.md describes what each item is.
Neither should say what comes next.
