# Progress

**The single place that says where this project is.** Everything else is
either permanent (how the game works, how a branch was built) or a catalogue
(what could be built). This file is the only one that goes stale on purpose,
and the only one that needs updating when a branch lands.

Last updated: 2026-09-23 — a DIRECTION CHANGE (see below), on top of
`fix/custom-map-geometry`.

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
| `fix/custom-map-geometry` | **Complete** | both overlays are correct on custom maps; the validator runs on real maps; `cMask` and `bias` now match the engine |

Those last two are fixes off `main`, not feature branches: they touch
`ballTrajectory.js` and `aimAssistOverlay.js`, so they belong to neither of the
branches that own them. **Branch from `main`, not from a merged feature
branch**, or the bug comes back.

**`fix/custom-map-geometry` in one line:** the default stadiums are not
representative, and everything shipped had only ever been validated on them.
Two independent errors were live on every custom map — decorative geometry
treated as solid (`cMask = 0` read as "all") and one-way walls treated as solid
(`bias` not modelled at all). Both are in [DOMAIN.md](DOMAIN.md); the second
was found only because fixing the first made the validator able to see it.

**What exists:** per-tick extraction, per-map geometry, engine events, NDJSON
session logging, replay playback, a validated ball predictor, and three
overlays — momentum arrows, the ball path, the aim cue.

**What does not:** any analytics function about *players*. No LOS, no passing
lanes, no dominance, no commitment. Everything shipped is about the ball,
which is the easy half — the ball has no intentions and cannot accelerate
itself. Players now appear in the predictions only as *blockers*: the path is
cut where a body would stop it, which needs no claim about where anyone is
going. Anything more needs `feat/reachable-zone`.

**And nothing that serves the stated aim.** Three overlays, all correct, all
switched off in play. No possession segmentation, no option enumeration, no
outcome attribution, no aggregation across games — none of the machinery a
tool that makes players better would need. That gap, not any missing
primitive, is what the direction change below is about.

---

## Direction change

**The heading changed on 2026-09-23.** Everything below this section was
written under the old one and some of it no longer applies; where it does not,
it says so.

### The old heading, and what was wrong with it

*Build a live overlay that shows a player what is possible, so they decide
better in the moment.*

Four branches of it shipped. All were validated to floating-point accuracy.
**The author plays with them switched off.** That is the result the whole
change rests on, and it is worth being precise about why it happened, because
three separate mistakes stacked:

**1. Capability-driven, not goal-driven.** Every feature was chosen because it
was buildable from the previous primitive, not because it served the aim. The
momentum arrows existed because the render path did; the ball path because the
predictor did; the aim cue because the predictor did. Each branch is a
demonstration of the one before it. Nothing was ever derived backwards from
what a player needed.

**2. No check on usefulness.** Four validators answer *is this correct*. None
answers *does this change what I do*. The step that kept failing was feature
selection, and it was the only step with no check that could fail — the same
shape as the `cMask` bug, where what nobody could see was what nobody was
measuring.

**3. The bottleneck was misidentified.** The design principles assume a
feature's job is to supply information. For most of what was built, the
limiting factor was not information at all:

- *Execution.* Aiming is muscle memory, timing and touch. Knowing where the
  ball would go does not place your body or release on the right tick, and
  reading a cue competes for the moment in which you would act. This is now
  [filter 0](README.md#filter-0-is-the-bottleneck-information-or-execution).
- *Perception.* A skilled player on this small, fully drawn pitch can already
  count defenders behind the ball, read pursuit and see the thresholds. Four
  candidate features died on this in one conversation.
- *The subject.* All three overlays describe the ball, which is the easiest
  object in the game to perceive — see
  [README.md § The ball is the wrong subject](README.md#the-ball-is-the-wrong-subject).

And one framing error underneath all of it: **the aim was always "become
better players", which is a learning goal, and a live hint is a poor teaching
channel by construction.** It improves play while switched on and teaches
nothing — which this project's own principles already said about directives,
without noticing it applied to the whole live track.

### The new heading

**Make the players better. Measure and explain between games; point the eyes
during them.** Two tracks, different timescales, different bandwidths, not
the same product. See [README.md](README.md) for the aim statement.

What survives: the session capture, the replay harness, the validated
predictor and the collision geometry. Not one of them was a detour — you
cannot show a player an option they did not use without knowing which passes
were possible, and you cannot judge a kick without knowing where the ball
would have gone. What does not survive is the assumption that the overlay is the
product.

---

## What to do next

> **Superseded in part.** The reasoning here still holds and the step below —
> originally called "miss-detection", now
> [unused options](#unused-options-what-the-term-means) — is Phase 2 of the
> plan. Two corrections to how it was framed: calling it "an instrument to
> test usefulness" undersells it, because under a learning goal finding and
> explaining unused options **is** the product; and "miss" asserted an error
> the tool has no standing to assert.

### How to work, which matters more than the phase list

The failure mode that produced this direction change was **building a
primitive, then looking for a use.** Four times. The inverse discipline:

> **Start from one question you actually want answered. Build the minimum that
> answers it. Look at the answer. Only then decide what is next.**

No framework before a question has demanded it. If the answer turns out
boring, that cost two days and is itself worth knowing. The phases below
describe what tends to be needed in what order — they are not a licence to
build all of Phase 1 before asking anything.

And the acceptance test, every time: **did it change what anyone does in the
next game?** Nothing else has ever distinguished the useful work here from the
merely correct work.

### The plan

Phases, in order, because each needs the one before it. Nothing here is a
branch name yet — name them when they start.

**Phase 1 — decision points.** Segment recorded games into the moments that
matter: a player has the ball, has options, and makes a choice. Everything
downstream is anchored to these, and none of it works without them. Needs
only what already exists.

**Phase 2 — options at those moments.** What *could* have been done. This is
where `feat/raycast` (lane clearance) and `feat/reachable-zone` finally have a
consumer that justifies them — not as live overlays, but as the enumerator
behind a review. Demoted for live use, re-justified here.

**Phase 3 — outcomes.** What happened next: goal, turnover, possession
retained, territory gained. Derivable from events already captured. This is
what turns an option list into a lesson.

**Phase 4 — personal and team patterns.** Aggregate across many sessions.
Descriptive first and prescriptive never, if necessary — *"a third option
existed in 60% of your possessions and you used it in 8%"* is already a
lesson, and it needs no value model. Includes the execution measurements in
[README.md § Measure what cannot be felt](README.md#measure-what-cannot-be-felt).

**Phase 5 — ranking, only if the data supports it.** Saying which option was
*best* needs values, values need outcomes at volume, and that volume may not
be reachable by one group of players. Treat as optional. Do not block the
first four phases on it.

**Live track, in parallel and deliberately small:** attention direction only.
One bit, peripheral, near the ball. Nothing that must be read. It has no
dependency on Phases 1–5 and should not grow one.

### Unused options: what the term means

Defined here because it is used throughout this file and was not defined
anywhere for several revisions, which is its own small lesson about coining
vocabulary mid-design.

**An unused option is a moment where something else was available and was not
taken.** Worked example:

> Frame 8,400. Ball near the left touchline, an opponent closing. From the
> physics already validated, the tool knows:
> - a square pass to the teammate 90 units right was **open** — clear lane,
>   nobody reaches it in time
> - a shot existed but at a poor angle with two bodies in the way
> - holding was possible for ~12 more ticks before being closed down
>
> The player cleared it long. That moment is flagged: *an open pass existed
> and was not used.*

**One flag means nothing.** The player may have seen the pass and judged the
receiver about to be closed down, or cleared deliberately under pressure. The
value is entirely in the aggregate — after two hundred of them, *square passes
to the right go unused 80% of the time when open* is a habit, and habits are
coachable in a way single moments are not.

It needs Phase 1 (decision points) and Phase 2 (what was possible at each),
which is why it is not the first question.

**On the name.** It was called "miss-detection" until 2026-09-23. "Miss"
asserts a mistake before anyone has judged whether one occurred — which is
precisely what [Advise, never act](README.md#advise-never-act) forbids the
tool from doing, and it contradicted the hand-labelling step, which has *"had
a reason"* as an outcome. The flag reports availability. Whether it was an
error is the player's call.

### The first question to ask: how does team XYZ play?

**Recommended starting point, ahead of individual unused-option analysis.** Not
settled by play evidence — argued from the plan's own constraints, so
override it if the first run says otherwise.

Everything below falls out of Phase 1 plus positions. No option enumeration,
no value model, no intent:

| What | How |
| --- | --- |
| Shape | average positions per player, split by in/out of possession |
| Defensive line height | where the deepest outfield player sits, by phase |
| Compactness, width | spread between highest/deepest and widest players |
| Pressing intensity | time from a player receiving the ball to the first defender arriving |
| Where they press | whether that number changes by pitch third |
| Build-up | where possessions start, touches before crossing halfway |
| Transitions | what the shape does in the 2s after winning or losing the ball |
| Tempo | touches per possession, time per touch |
| Roles | who occupies which zone, who is always the outlet |
| Kick-off routines | deterministic and repeated, so trivially detectable |

Why this before unused-option analysis:

- **More robust.** Aggregates over hundreds of possessions instead of judging
  single moments, so noise averages out instead of needing hand-labelling.
- **Less machinery.** Possessions and positions. Phase 2 is not required.
- **Actionable collectively.** *We sit 40 units higher than they do* is
  something a team can decide to change on Monday. A missed pass is one
  person's habit.
- **It is what the aim's "we" was pointing at.**
- **The comparison is the finding.** One team's numbers alone say little;
  next to your own they generate a lesson immediately.

Two uses, both worth having: **learn from them** (what do better teams do that
we do not) and **scout them** (they press the keeper in a two, so play around
it).

Limits to state in any output, so it is not over-read:

- **What, never why.** Intent is not recoverable. A deep line may be a plan or
  may be fear.
- **Shape without execution can backfire.** A high line needs the pace to hold
  it; the number transfers, the capability may not.
- **"How XYZ plays" is really "how XYZ plays against these opponents."** Split
  their games by opponent strength before believing a pattern.

### What happens to the overlays

**Demote, do not delete.** Keep them available in the replay viewer with live
defaulting to off — which is the reasoning already applied to the momentum
overlay, now applied consistently. Seeing the predicted path while reviewing a
moment is useful; clutter costs nothing there.

The accounting, so nobody re-litigates it:

| | Fate |
| --- | --- |
| `ballTrajectory.js`, `gameStateExtractor.js`, collision geometry, validators, replay harness | **Load-bearing.** Phase 2 cannot enumerate a pass without knowing where the ball would go, or judge a shot without the angles available. |
| `computeAimAssist`, the reachable wedge, the blocker logic | **This is the option enumerator.** It computes what is reachable and what is blocked — the review question, asked live by mistake. |
| The draw layers — `drawBallTrace`, cue rendering, momentum arrows | **In question.** ~1,000 lines of rendering built for a channel that carries 1–2 bits. |

Roughly two thirds of the analytics code is foundation the new heading needs.
The third that drew to a saturated visual channel is what did not survive
contact with playing.

**One cheap experiment before retiring live visuals entirely:** gate the ball
path to *post-first-bounce*, the only part of that trace that is not free
information to a human eye. Small change. If it still does not help, the live
visual track is retired on evidence rather than argument.

### Tools: none of this needs ML

Settled in [README.md § What this needs, and what it
does not](README.md#what-this-needs-and-what-it-does-not). Short version:
Phases 1–4 are geometry and counting. No computer vision — the engine already
hands over exact state, which is the thing CV exists to approximate. No
reinforcement learning — it outputs an action with the reasoning discarded,
which the design principles forbid regardless of how well it scores. Phase 5
may want a supervised model on tabular features, and only if it stays
interpretable.

**Getting volume is an engineering problem, not a research one.**
`API.Replay.readAll()` parses a `.hbr2` into events and initial room state
synchronously, and `API.Replay.read()` returns a reader that runs without a
render callback — so batch-converting a folder of replays into the NDJSON the
scripts already consume needs no GUI and no play-through. It has not been
proven outside the app, so prove it on one file before building on it. That
converter is the cheapest thing on this list and it unblocks every phase.

### The corpus already exists

**No more games need to be played to start.** A large archive of `.hbr2`
replays is already on hand, and that is the input to every phase. Nothing here
is blocked on playing.

Two properties of that archive matter more than its size:

- **Follow one team across many games**, rather than sampling randomly. A
  fixed cohort gives personal patterns (the same player, hundreds of
  possessions), change over time (are they improving, and at what), and a
  natural before/after if the team's level shifted. Random replays give none
  of that — they give an average over strangers.
- **Replays of stronger teams are the imitation baseline.** *In situations
  like this one, players above your level chose X* needs no value model and no
  agent — only games by better players, which cost nothing to collect. This is
  the cheapest route to anything resembling "what should I have done", and it
  is human-executable by construction because a human did it under real time
  pressure.

Identity across files is by player name, which is workable and imperfect —
names change and are reused. Check it rather than assuming it; a cohort
silently merging two people is exactly the kind of quiet mislabelling this
project keeps being bitten by.

### Steps for Phase 1, concretely

1. Build the headless replay-to-NDJSON converter (see Tools above) and run it
   over the existing archive. Prove it on one file first.
2. Define a possession: who has the ball, from when to when. Events give
   kicks; the gap between them plus proximity gives the rest.
3. Emit one row per decision point: who, where, ball state, who else was on
   the pitch and where, what they did, what followed.
4. **Sanity-check by hand before building on it.** Watch twenty of them in
   the replay harness and confirm they are really decision points. A
   segmenter that quietly mislabels is another validator that cannot fail.

### What is still unknown

Honest gaps, so nobody later mistakes these for settled:

- **Intent is not recoverable.** The data never says what a player *meant* to
  do, so "did you execute what you intended" is unanswerable. Everything must
  be phrased against outcomes and available options instead.
- **How much volume is enough is unproven.** An archive exists, so collection
  is not the problem; knowing when a pattern is real rather than noise is.
  Check it early by splitting the corpus in half and seeing whether the same
  pattern appears in both halves. A finding that does not survive that split
  is not a finding.
- **Whether the live nudge helps at all** is untested. It is cheap, so test it
  rather than argue about it.
- **Whether a review tool changes play.** The entire premise is that reviewing
  unused options improves later decisions. That is plausible and unproven, and
  it is the one thing worth designing a real check for — because *not* having
  such a check is what produced this direction change.

---

## Superseded: what to do next under the old heading

### The result that reorders everything

**The author turns the overlays off while playing.** Three features shipped,
all validated to floating-point noise, none used in a live game. That is the
most informative measurement this project has produced and it is not in any
validator.

Read against the three-filter test, which is supposed to be binding:

| Shipped | Verdict on reflection |
| --- | --- |
| Momentum arrows | Already judged: perceptible, nothing derived. Correctly not live. |
| Ball path | **Retrospective.** It draws after the kick, so the decision it could inform is already spent. For everyone else it is linear extrapolation, which the eye does for free. |
| Aim cue | Passes filter 2 honestly — composing your own momentum into the kick is not free. But it must be *traced* to be read, so it only lands when play is slow. |

The pattern is not bad execution. **All three describe the ball, and the ball
is the easiest possible subject for human perception** — one object, no
intentions, damped linear motion, permanently centred because the camera is
welded to it. See README.md § *The ball is the wrong subject*.

Play knowledge has also killed four candidate "humans are bad at this"
features in a single conversation: counting defenders behind the ball,
invisible thresholds, who-reaches-the-ball-first, and the whole
*you-cannot-reach-this* family. That last one is not merely unhelpful, it is
**tactically wrong** — chasing a lost ball applies pressure and forces errors,
so a cue discouraging it would make the player worse while being physically
correct.

### `feat/unused-options` — build the instrument before the next feature

**The gap is instrumentation, not features.** There are four validators for
*is this correct* and none for *does this change what I do*. The selection
step is the one that keeps failing and it is the only step with no feedback
loop. That is the same shape as the `cMask` bug: what nobody could see was
what nobody was measuring.

So before any new cue, answer one question offline: **how often is there a
materially better option that the player did not take?**

1. Run a detector over recorded games. Flag moments where the player had the
   ball and a better option existed. Crude physical proxy to start: a teammate
   reachable by a pass the physics permits, in a lane that is actually clear,
   less contested than the option taken.
2. Watch the flagged moments in replay and label them by hand — *missed it* /
   *covered* / *had a reason*. **Expert judgement is the label source.** No
   outcome dataset and no value model are needed to begin; fifty labels are
   enough to know whether the detector has signal.

It is built from `predictBallPath`, the raycast and the reachable zone — the
primitives already validated, which is also what would justify them.

**What each outcome means:**

| Result | Reading |
| --- | --- |
| Flags ~40, agree with ~30 | Real signal. Now characterise it: what kind of miss, how often, and **how much time was available** — that last number decides which delivery tier is even possible. |
| Flags ~40, agree with ~3 | The detector finds nothing real. No display polish fixes that. Consider redirecting to less skilled players, where misses are abundant and the same tool would genuinely teach. |
| Flags ~3 | The premise is in trouble. Better to know in a week than after four more branches. |

### The three delivery tiers

Bandwidth is set by where the fovea is, not by taste (README.md § *Live cues
are peripheral cues*). These do not compete and should not be conflated:

| Tier | Bandwidth | Content |
| --- | --- | --- |
| Live, near-ball | 1–2 bits, peripheral | safe/unsafe, urgency, a coarse direction |
| Windows with time — kick-off, dead ball, far from play | a shortlist | ranked options **with their criteria** |
| Review | unlimited | full explanation; where the value model gets built |

The open decision about whether to show cues in `BeforeKickOff` is really the
middle tier asking to exist. *Setup positioning is arguably the most coachable
moment* was already written here as a question; treat it as an answer.

### On the coaching goal

The stated aim is guidance that suggests the best decision. Two constraints
that are not negotiable if it is to stay the tool described in README.md:

- **"Best" needs a value model, and physics cannot supply one.** Physics
  yields *options*; ranking them needs to know what each is worth, which is
  learned from outcomes. The pressure finding proves the values are not
  physical — chasing a lost ball has worth that no simulation produces. The
  hand-labelling above is how that dataset starts.
- **Reasoning must travel with the recommendation**, or this becomes the
  collapse the design principles already reject. A shortlist with visible
  criteria is coaching; a bare arrow is a remote control.

### Demoted, with reasons

`feat/reachable-zone` (item 5) is still the most-depended-on unported
primitive, and `feat/orbit-cost` (item 7) is still small and finishes a
thought the aim cue starts. Neither is next, because both are *more of what
already did not work* until there is evidence a cue would be used.

The zone survives the pressure objection only if its output changes: not
*who wins the ball*, which is readable by eye, but **how much unpressured time
an opponent has** — the quantity that decides whether they can look up and
pick a pass or must just clear it. Same maths, and it does not tell anyone to
stop running.

### What not to do yet

- **The analytics boundary (items 3–4).** Still unmeasured. Time the `onTick`
  compute and get a p99 first — if the aim cue is *late* rather than *slow*,
  the fix is `leadInTicks` and costs nothing.
- **A fifth physics primitive.** The physics is not what is failing.
- **The coach ranking.** Ranking needs values; values need labels; labels come
  from the step above.

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

**A validator's fixtures are claims too, and they inherit the bug.** The
`cMask = 0` error lived in the collision set AND in two synthetic walls in
`validate-aim-assist.mjs`, written `cMask: 0` by an author who believed that
meant "all". The check passed because the code under test shared the
misconception with the scenery it was tested against. When a rule turns out to
be wrong, grep the fixtures for it before trusting the suite that vouched for
it — a green suite is evidence about agreement, not about truth.

**There is a validator for correctness and none for usefulness.** Four
branches shipped at floating-point accuracy and were switched off in play. The
step that keeps failing is feature *selection*, and it is the only step with
no check that can fail. Every principle in README.md was applied by reasoning
about features that did not exist yet; play knowledge has since overturned
several of those verdicts, including on shipped work. **Correctness
instrumentation does not transfer — build the other kind.**

**Some of the game is not in the game.** A room script enforces rules the
stadium cannot express by writing player state directly — the defender cap
that stops players at x = ±405 is a `setDiscProperties` write, not a collider.
It left no trace in the record for four branches, so a player stopping dead
with nothing there was explained twice, confidently, and wrongly both times.
Nothing in the map file could have settled it; one line of the event log did.
**When the data cannot distinguish two explanations, capture more data rather
than arguing better.**

**The test environment was the blind spot, not the test.** Three branches of
ball physics were validated to 1e-13 against the DEFAULT stadium only, and the
default stadiums carry almost no decorative geometry and no one-way walls. Two
errors that made the overlays wrong on every custom map were invisible the
whole time, at full confidence. The validator now runs every map in
`test-maps/`, which is where the second error surfaced — fixing the first was
what let the harness reach geometry it had never touched.

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

0. **Read [Direction change](#direction-change) first**, then
   [README.md § What the finished thing looks like](README.md#what-the-finished-thing-looks-like).
   The heading moved on 2026-09-23. Four branches were built under the old one
   and the sections below this file's plan still describe it. If you are about
   to build a live overlay feature, that is almost certainly the wrong track
   now — and the reasons are specific, not a mood.

   **The first action is the headless `.hbr2` → NDJSON converter**, run over
   the replay archive that already exists. Nothing is blocked on playing more
   games.

   **The first question is
   [how does team XYZ play](#the-first-question-to-ask-how-does-team-xyz-play)** —
   answered end to end, for one team, before anything general gets built. See
   [How to work](#how-to-work-which-matters-more-than-the-phase-list) for why
   the order is question-first and not framework-first.
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
   node scripts/validate-trajectory.mjs          # default + every map in test-maps/
   node scripts/validate-aim-assist.mjs
   node scripts/diagnose-map-masks.mjs test-maps/<map>.hbs   # per-map, fast
   ```
   All are deterministic, so their numbers are baselines and any divergence is
   signal. Current: trajectory p99 `1.71e-13` Classic, `1.14e-13` K Futsal Huge,
   `1.42e-13` K Futsal big; aim assist p99 `2.27e-13`, wedge
   `180/180/89.50/56.44/38.68/24.62`, blockers truncating at tick 21 where the
   engine diverges at tick 21.

   **Drop a new `.hbs` into `test-maps/` and the trajectory validator picks it
   up.** That is the cheapest guard there is against the whole class of bug
   that `fix/custom-map-geometry` was: geometry that is fine on Classic and
   wrong everywhere else.

   `validate-zone.mjs` re-run after the `cMask` correction on a fresh 6v6:
   **open space 100.00% contained over 151,672 samples**, near-wall 100.00%
   over 48. The 266 windows where a room script wrote the player's position
   are reported in their own bucket and do not decide the verdict.

   That 100% is the same number as before the correction and means something
   different. It used to be reached with the old mask rule filing those
   windows under contact; it is now reached by attributing them to what
   actually caused them. **A restored number is not a preserved one** — check
   which windows moved, not just that the total held.

   **Read what each validator excludes before quoting its number.** Check 1 of
   the aim-assist validator parks every player, so it proves nothing about
   ball-vs-player; that is check 5's job.

**When a branch lands, update this file and nothing else.** The branch README
records what was built; the roadmap in README.md describes what each item is.
Neither should say what comes next.
