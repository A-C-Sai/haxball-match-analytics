# Session event capture + physics validation

Branch: `feat/session-event-capture`.

Makes the data layer record everything an analytics function will need, and
proves the recording is trustworthy by validating the reachable-zone formula
against a real match.

The deliverable is not the code. It is a **PASS** from
`scripts/validate-zone.mjs` on a recorded game — evidence that the physics
model is right before anything gets built on it.

---

## Status

**Complete.** 130,349 contact-free samples in open space, zero violations,
max overshoot exactly 1.0000.

| Area | State |
| --- | --- |
| Engine event capture | ~~Done~~ |
| `GamePlayState` in frames | ~~Done~~ |
| Stadium discs + joints extracted | ~~Done~~ |
| Replay seek suppression | ~~Done~~ |
| Reachable-zone formula validated | ~~Done — 100%, bound tight~~ |
| Offline diagnostics | ~~Done~~ |

---

## Why it was needed

Before this branch the logger captured positions and velocities per tick and
nothing else. Three gaps mattered:

- **Events weren't captured.** Kicks, goals, wall bounces and body contacts
  all come free from the engine, but nothing was listening. Without them,
  possession, passes and clearances would have to be reconstructed from
  physics — badly.
- **Game state wasn't captured.** No way to tell active play from a post-goal
  reset, so analysis would silently include frames where players are being
  teleported.
- **Nothing verified the physics model.** Every planned feature — commitment,
  dominance, who-reaches-the-ball-first — rests on one formula for where a
  player can be in N ticks. That formula was derived from reading engine
  source and had never met the engine running.

---

## What changed

### `src/features/analytics/useHaxballAnalytics.js`

Every callback is **chained, never assigned**, through `chainRoomCallback`:
capture the previous handler, call it first, run the observer inside a
try/catch, restore on cleanup, and pass the previous return value through
untouched so the engine's `customData` convention still works.

`Game.jsx` already owns `onAfterPlayerBallKick` and `onAfterTeamGoal` for
sound and UI, so assignment would have silently broken both.

Events captured: kicks, goals, kick-off, positions reset, game
start/stop/end, and the three collision types. Collisions sit behind
`captureCollisions` (default `true`) since they are by far the highest
frequency.

**Replay seek suppression.** The whole observer is skipped while
`room.replay?.isSeeking` is set. A seek re-simulates at full speed and
re-fires every event in the traversed span — a single measured scrub produced
539–841 kick events — and a backward seek restarts from frame 0, so `frameNo`
runs backwards. Recording any of that would write occurrences that never
happened. Geometry capture is inside the guard too, so a rewind does not bump
`geometryVersion` spuriously.

### `src/features/analytics/snapshotLogger.js`

Gains `writeEvent`, stamping each event with the last frame number seen so
events align to the exact tick. Events are deliberately **not** sampled by
`sampleEveryNTicks` — dropping some kicks would make the stream misleading
rather than just coarser.

### `src/features/analytics/gameStateExtractor.js`

Adds `playState`, `goalTickCounter` and `paused` per frame, and — added
mid-branch after a validation failure — **`discs` and `joints`** from the
stadium. Static discs are goal posts and, on custom maps, whole barriers. An
extractor reading only vertices, segments, planes and goals reports a lane as
clear straight through a goal post.

### `src/features/analytics/loadSession.js`

Returns `allEvents`, `eventsByType` and `eventsByFrameNo` alongside the
existing frame grouping.

### `scripts/validate-zone.mjs` (new)

Checks the reachable-zone formula against a recorded session. For every player
and every frame pair `(t, t+N)`, computes the predicted zone at `t` and asks
whether the actual position at `t+N` falls inside it.

Buckets by open space / near a wall / after contact, since the zone bounds
self-propelled motion only. Flags: `--ticks N`, `--worst K`, `--limit M`.

### `scripts/diagnose-physics.mjs` (new)

Works out what the engine actually does by fitting constants from a recording:
frame continuity, integration order, damping, acceleration, collision masks,
and where players empirically stop. Run it when validation fails — it names
the wrong constant rather than leaving you to guess from an overshoot number.

### Small fixes

- `momentumOverlay.js` JSDoc said `fraction=0.35`; actual default is `0.10`.
- `.gitignore` gains `analytics-sessions`.

---

## The validation story

Seven things were wrong. None were findable by reading source more carefully;
each needed a recorded match and a check that could fail.

| # | Error | Found by |
| --- | --- | --- |
| 1 | Damping applied before position integration | Fitted acceleration landing on `a × d` exactly |
| 2 | Bound used current, not reachable, physics | 84% of failures clustered at the 1.33 ratio |
| 3 | Walls assumed to constrain all entities | Players observed passing through boundaries |
| 4 | Stadium discs never extracted | Geometry listing having no candidate |
| 5 | `cMask = 0` read as "none" not "all" | Dumping geometry regardless of mask |
| 6 | Goal-to-reset window not excluded | State gate assuming events and state agree |
| 7 | Sustained contact emits no events | Nearest-player gaps sitting at exactly 30.00 |

Progress across those fixes:

| | Start | End |
| --- | --- | --- |
| Open-space containment | 15.59% | **100.00%** |
| Max overshoot (contact-free) | 20.33 | **1.0000** |
| Violations | 1,554 | **0** |

### The one that mattered most

**#5.** `cMask = 0` means "unspecified → all", not "none". Reading it
backwards made the *most permissive* boundaries on a map invisible — geometry
that stops things silently disappearing from the model.

Had it shipped, passing lanes would have been drawn through barriers, the
capability cone would have missed walls blocking an orbit, and dominance
regions would have spanned solid obstacles. All plausible-looking, all quietly
wrong. It surfaced only because the zone formula made a falsifiable claim and
0.14% of the time reality said no.

Full details in [DOMAIN.md § Pitfalls](DOMAIN.md#pitfalls).

---

## Handover

### Verify capture

```bash
grep -o '"event":"[a-zA-Z]*"' analytics-sessions/session-*.ndjson | sort | uniq -c
```

Expect a mix of event types. `collisionDiscVsSegment` will dominate — that is
normal. If `playerBallKick` is absent after a kick, the chaining is broken and
nothing else is worth doing.

### Validate physics

```bash
node scripts/validate-zone.mjs analytics-sessions/session-<stamp>.ndjson --ticks 3
```

**Pass condition:** open space at or very near 100%, mean usage below 1.0.

A max overshoot of exactly `1.0000` is the good result — it means the bound is
*tight*, reachable in principle and reached in practice. A max well under 1
would mean the bound is loose.

The contact bucket sitting around 90% is expected and is **not** a failure.

### If it fails

Run `scripts/diagnose-physics.mjs` first. Do not adjust the formula to make
validation pass — a failure is diagnostic information about the engine.

| Symptom | Likely cause |
| --- | --- |
| Overshoot barely above 1.0, spread across players | A constant marginally off |
| Concentrated on a few players | Those discs have non-default physics |
| High share near a restart | Teleports the gate missed |
| High share while kicking | The kicking-physics switch |
| Extreme outliers, contact-free | Missing collision geometry |

### Session file format

NDJSON, one record per line. Every record carries `geometryVersion` so a
mid-session map change never silently mixes geometries.

**`{"type":"geometry"}`** — once per stadium load. `name`, `width`, `height`,
`vertices`, `segments`, `planes`, `goals`, `discs`, `joints`, spawn points,
and `playerPhysics`.

**`{"type":"frame"}`** — one per tick.

| Field | Meaning |
| --- | --- |
| `frameNo` | engine tick number; the join key for events |
| `timestampMs` | wall-clock, for pacing a replay |
| `players[]` | `id`, `name`, `team`, `isAdmin`, `isKicking`, `input`, `inGame`, `pos`, `vel`, `radius`, `bCoef` |
| `ball` | `pos`, `vel`, `radius`, `bCoef`, `invMass`, `mass`, `damping`, `cMask`, `cGroup` |
| `playState` | `GamePlayState` — gate analytics on `1` |
| `goalTickCounter`, `paused` | restart and pause state |
| `redScore`, `blueScore`, `timeElapsed` | scoreboard |

**`{"type":"event"}`** — discrete occurrences, never sampled. Carries `event`,
`frameNo`, `timestampMs`, plus per-event ids: `playerBallKick` → `playerId`;
`teamGoal` → `teamId`, `goalId`; `collisionDiscVsDisc` → `discId1`,
`discPlayerId1`, `discId2`, `discPlayerId2`; `collisionDiscVsSegment` →
`discId`, `discPlayerId`, `segmentId`; `gameStart`/`gameStop` → `byId`;
`gameEnd` → `winningTeamId`.

Object references are deliberately not serialized — ids only. The geometry
line already carries everything those references would point at.

### Known limitations

- **Per-disc physics is not captured.** `playerPhysics` is a per-map default;
  individual discs can override `damping`, `invMass` and masks. Not currently
  extracted per player. Did not affect validation, but would matter if a map
  or host sets them.
- **The contact bucket depends on geometry, not only events.** Sustained
  contact emits nothing, so `validate-zone.mjs` tests proximity directly. Any
  future possession or body-block detection needs the same approach.
- **Curved segments are approximated by their chord** in the wall-proximity
  test. Fine for classification, not for a real raycast.

---

## Recording from a replay

Replays are the cheapest corpus source — deterministic, repeatable, and real
high-level play rather than solo sandbox movement.

`ReplayView.jsx` passes `logging: false` by default so that watching a replay
does not write a file. Flip it for a capture run:

```js
useHaxballAnalytics(roomRef, { enabled: ready, logging: true });
```

Keep `enabled: ready`. On the replay path the adapter is built asynchronously,
and `ready` is what re-triggers the effect once `roomRef.current` is
populated — without it the hook runs once against a null room and never again.

Scrubbing is safe (seeks are suppressed), but a clean straight-through play
makes validator output easier to read.

---

## Next

Roadmap items 1 and 2 are done.

**[`feat/ball-trajectory`](README-ball-trajectory.md)** is complete — a live
overlay of where the ball is going, drawn at the ball's true width. It built
directly on this branch: the geometry extraction added here (stadium `discs`
and `joints`, plus the mask handling) is exactly what a trajectory needs to
bounce off the right surfaces, and it applied the same standard of proof — a
predictor plus a validator that can fail, run against the engine.

That branch also turned up an eighth pitfall, in the same shape as the ones
found here: collision **resolution order** changes the answer, and the error
was invisible until goal posts were present in the test.

Next is `feat/aim-assist`, which reuses that branch's predictor to show what a
kick *would* do rather than what the ball is already doing.

After that, the reachable-zone formula validated here feeds roadmap item 5
(zone primitive in the live path) and then item 6, commitment. See the [main
README](README.md#roadmap) — the closing subsection there argues for that
route ahead of the analytics-boundary work listed as items 3 and 4.
