# Replay playback (`.hbr2`)

Offline playback of Haxball recordings inside this client, built as a test
bench for the tactical-overlay work: **anything developed against a replay
runs unchanged in a live room, and vice versa.**

Branch: `feat/replays`. This file is the running log — what the feature is,
how it works, what was broken and why, and what is deliberately left out.

---

## Status

**Working.** Load a `.hbr2` from the room list and it plays with the real
renderer, the real chat transcript, sound, the momentum overlay and the
analytics tick loop running against it.

| Area | State |
|---|---|
| Parsing / playback | Done |
| Renderer, overlay canvas, camera | Done — shared with live play |
| Analytics hook (`useHaxballAnalytics`) | Done — runs unmodified |
| Chat transcript + notices | Done |
| Sound | Done |
| Transport (play/pause, speed, scrub) | Done |
| Read-only room panel | Done |
| Replay-specific settings | Done |
| Stats/aggregation over a replay | Not started — see [Next](#next) |

---

## How to use

1. Room list → **Replays** → pick a `.hbr2`.
2. Opens paused on frame 0. Space or **▶ Play**.
3. `Escape` or **Menu** toggles the room panel. `1`–`7` zoom presets, mouse
   wheel zooms, cog opens replay settings.

---

## The `.hbr2` format

Worth knowing, because it explains most of the design decisions below.

```
offset 0  : "HBR2"              magic
offset 4  : uint32 BE           version (3; only 3 is supported)
offset 8  : uint32 BE           total frame count
offset 12 : raw DEFLATE stream  (no zlib header — inflate with windowBits -15)
```

The inflated payload is **not** a position log. It is:

- **`roomData`** — the initial `RoomState`: room name, full stadium, player
  list, and a `gameState` (recordings often start mid-game).
- **`events[]`** — each tagged with a `frameNo`. Overwhelmingly input
  bitmasks; the rest are chat, ping, team changes, pause/resume, joins.

So a replay is **a seed state plus an input tape**. Player positions, the
ball and goals do not exist in the file — they are re-derived by running
Haxball's deterministic physics over those inputs.

Two consequences that shape everything:

- **Goals aren't events.** They fall out of the simulation.
- **Seeking is re-simulation, not indexing.** Frames are generated on the fly
  and never stored. Seeking forward fast-forwards from the current position;
  seeking backward restarts from frame 0 and re-runs everything.

Reference sample (a real 30,093-frame / 501 s recording, "Big Easy",
14 players): 33,330 events, of which 33,102 are input.

---

## Architecture

`API.Replay.read()` does **not** return a `Room`. It returns a deliberately
minimal playback object:

```
own    : state, extrapolate, getSpeed, setSpeed, getTime, length, setTime,
         getCurrentFrameNo, setCurrentFrameNo, destroy,
         onDestinationTimeReached, onEnd
getters: gameState, maxFrameNo, currentPlayerId (always -1)
```

Everything else this codebase reaches for lives on `Room`. So the entire
compatibility layer is **one file** — `replayRoomAdapter.js` — which presents
the reader behind a Room-shaped surface. Nothing in `renderer.js`,
`gameStateExtractor.js`, `useHaxballAnalytics.js` or `momentumOverlay.js` is
replay-aware, and none of them were modified.

What the adapter has to supply:

| Needed by our code | On the reader? |
|---|---|
| `state`, `extrapolate`, `currentPlayerId` | yes |
| `players`, `stadium`, `getPlayer(id)` | on `state`, re-exposed |
| `getBall()`, `getPlayerDisc()`, `getDisc()`, `getDiscs()` | **no — synthesized** |
| `currentFrameNo`, `redScore`, `blueScore`, `timeElapsed` | **no — derived** |
| `setRenderer()` | **no — reimplemented** |
| event fan-out to the renderer | **no — forwarded** |
| `_onVariableValueChange` | **no — forwarded** |
| `onAfterGameTick` | **no — bridged from `onGameTick`** |

### Files

| File | Purpose |
|---|---|
| `replayRoomAdapter.js` | The whole compatibility layer. Start here. |
| `ReplayView.jsx` | The screen: renderer, overlay, chat, sound, input, layout. |
| `ReplayControls.jsx` | Transport bar (play/pause, speed, scrubber). |
| `ReplayRoomInfo.jsx` | Read-only room panel, reusing live room-view classes. |
| `ReplaySettingsPopup.jsx` | Replay-only settings dialog. |
| `pendingReplay.js` | One-slot handoff of the file bytes into the route. |

---

## Bugs found, and why they happened

Kept because each one is a trap that will re-appear if this code is touched.

### 1. The Replays button did nothing

The `.hbr2` file input had no `onChange` at all. It was dead in **upstream
`node-haxball-client` too** — never implemented, not something this fork
broke.

### 2. Analytics silently dead — `onAfterGameTick` never fires

Replay readers emit only the plain callback set. Measured over the reference
recording:

```
onGameTick       26,647
onAfterGameTick        0
```

`useHaxballAnalytics` binds `onAfterGameTick`. Rather than fork the hook, the
adapter subscribes to `onGameTick` and re-emits it. **If you add analytics
that bind an `onAfterX` callback, add the bridge for it too.**

### 3. Ball "teleporting outside the map" — part one: dropped events

`renderer.js` does not rebuild its scene each frame. It keeps a persistent
PIXI sprite list (`customDiscInfo`) indexed to match the physics disc array,
maintained incrementally via `onPlayerJoin`, `onPlayerTeamChange`,
`onGameStart` and friends. A live `Room` fans events out to its renderer
automatically; `Replay.read(bytes, callbacks)` fans out only to the single
callbacks object it was given. The renderer heard nothing, its sprite list
drifted, and sprite *n* drew at disc *n+1*'s position.

Fixed by forwarding the full event set (`FORWARDED_CALLBACKS`) to the
attached renderer.

### 4. Ball teleporting — part two: extrapolation

The simulation was never wrong. Re-simulated headlessly, the ball stays
inside the pitch for all 26,647 ticks (max |x| 540 against a 550 goal line).

The cause was `extrapolate()`. On a live room it hides network latency. On a
replay reader:

```js
cW: function(h=0){            // = extrapolate(ms)
  this.LM();                          // advance playback
  var N = this.a.AE(++this.nk);       // copy of current state
  N.nM(this.UW + h*this.xE | 0);      // run h-ms of RAW physics steps
  return N;
}
```

`N.nM(k)` runs `k` blind steps on that copy — no recorded inputs, no
re-resolution against the authoritative tick. Driven every rendered frame:

| `renderer.extrapolation` | rendered ball worst \|x\| | frame jumps >40u |
|---|---|---|
| 0 ms | 540 (in bounds) | 1 |
| 100 ms | **575 (off the pitch)** | 79 |

A replay has zero latency, so extrapolation buys nothing here. It is pinned
to `0` **inside the adapter**, not just on the renderer, so a persisted
live-play setting cannot leak back in through the settings UI. The one
remaining >40u jump is the kick-off reset — real game behaviour.

### 5. FPS / resolution scale appeared to do nothing

`VideoContent` applies renderer changes via `roomRef?.renderer[field] = value`
where `roomRef` is the room **object**, not the React ref. The replay screen
passed nothing, so values reached player data but never the renderer.

### 6. Line widths not applying

Renderer options are declared with `defineVariable`, whose setter is:

```js
set: a => { var i = I; a != i && (I = a, E.DM?._onVariableValueChange?.(E, W, i, I)); }
```

`E.DM` is the renderer's room. Assigning an option calls
`room._onVariableValueChange(...)`, which a live `Room` fans out to the
renderer's `onVariableValueChange` — the handler that actually applies the
change (`_regenerateNecessaryObjects()` for line widths, rebuild for
resolution scale). The adapter didn't implement it, so the value was stored
and nothing redrew: "General line width" did nothing, and "Disc line width"
only seemed to affect one player at a time, each disc picking the new width
up whenever the per-frame cache check redrew it for an unrelated reason.

### 7. Step buttons resumed playback instead of parking

`step()` set `playing` false, then `seekTo` read a **stale `true`** from its
closure and resumed. Fixed with refs mirroring state; the step buttons were
later removed anyway, but the stale-closure pattern is the thing to remember
— the reader's callbacks are registered once and close over first-render
values.

### 8. Kick sound silent while chat sound worked

Two stacked causes, neither of them the sound loading.

**Channel split.** `player.sound.main` is the master "Sounds enabled" flag and
gates exactly three sounds — kicks, goals and leaves. Chat and join are a
different channel (`sound.chat`). A profile with `main` off therefore presents
as "the kick sound is broken", because in a single recording goals may never
happen (the reference file is 0–0) and leaves are rare. Kicks are the only one
of the three you reliably notice.

**Stale closure.** The gate read `player.sound` captured inside the mount
effect, which runs once. Toggling the setting writes a *new* object into
player data; the frozen one still said `false`, so the toggle appeared to do
nothing until the replay was reloaded. It now reads through a ref.

Compounding both: the replay settings dialog had no sound section at all
(the on-screen volume button is gain only), so there was no way to see or
change `main` from this screen. The dialog now carries the three channel
toggles.

**Confirmed in practice:** the profile simply had `main` off. Kicks had never
played in a replay; what sounded like "sound works, kicks don't" was chat and
join on the other channel. The same profile silences kicks in live rooms too —
it is a player setting, not a replay bug.

**Why `play()` reports itself.** Both failure modes are silent: the channel
gate returns early and `playSound` no-ops on a missing buffer, so "switched
off" and "clip never decoded" look identical from outside. Three rounds went
into guessing between them. `play()` now warns once per distinct cause, naming
the clip and the reason, and answered it on the first run. Keep that — silent
audio failure is worth one line of console.

### 9. All sounds silent if one clip fails

Clips were loaded with a single `Promise.all`: one failed fetch/decode
rejects the batch, nothing is assigned, and `playSound` no-ops on every
`undefined` buffer. Each clip now loads and assigns independently and logs
its own failure by name.

### 10. Loud static when scrubbing during playback

Dragging the scrubber while playing produced a burst of noise.

A seek re-simulates at full speed and every event in the traversed span still
reaches the callbacks. Measured through the UI's own call sequence
(`setSpeed(0)` / `setCurrentFrameNo` / `setSpeed(n)`):

```
BACKWARD 15000 -> 3000    63 kick events, 57 of 62 gaps under 10ms
FORWARD   3000 -> 22000   539 kick events
FORWARD   1000 -> 29000   841 kick events
```

Dozens to hundreds of identical buffers starting within milliseconds of each
other sum in the mixer, which reads as static rather than as kicks.

A measurement trap worth recording: an early harness suggested forward seeks
fired nothing. That harness omitted the trailing `setSpeed` the UI performs,
so the reader's animation-frame loop never restarted and the fast-forward
never ran. **Both directions fire, and forward fires more.** When a headless
result contradicts what the app plainly does, suspect the harness.

Two guards, both in replay code:

- The adapter tracks seek state and exposes `replay.isSeeking`, true from
  `setCurrentFrameNo`/`setTime` until the destination is reached. `play()`
  returns early while it is set — none of that is happening in real time, so
  none of it should be audible. It is raised by any seek and lowered only when
  the reader settles, so direction is irrelevant. After the fix, across four
  scrubs in both directions: 58 / 536 / 838 / 0 events suppressed, with only
  2-3 genuine kicks each time once playback resumed.

  The flag is lowered by `onDestinationTimeReached`, by `onEnd` (which fires
  INSTEAD when a seek runs past the end of the recording — without that, the
  flag would stay raised and mute every sound for the rest of the session),
  and by a 10s watchdog as a last resort. The slowest real seek measured is
  ~107ms, so the watchdog cannot fire during a legitimate one.
- A 40ms minimum gap between two plays of the same clip, which also keeps 16x
  playback from turning kicks into a buzz. Well below what is distinguishable
  at 1x, so normal playback is untouched.

Note that the adapter now owns `reader.onDestinationTimeReached` and forwards
it to whatever `replay.onDestinationTimeReached` was set to, so it can clear
the flag first. Assigning the reader's handler directly would break seeking.

### 11. Frozen picture after replaying from the end

Let the replay finish, then seek back to the start: the picture freezes while
the frame counter keeps climbing and sound keeps playing. Console shows

```
renderer.js:1304 Uncaught TypeError: Cannot read properties of undefined (reading 'active')
    at update (renderer.js:1233)
    at _doRender (renderer.js:1723)
```

That signature — playback alive, rendering dead — means the render loop threw
and stopped while the reader carried on.

`renderer.js` keys several maps by player id (`customDiscInfo`,
`chatIndicatorInfo`, `locationIndicatorInfo`) and maintains them through
join/leave/team-change callbacks instead of rebuilding per frame. A backward
seek resets the reader to frame 0 and re-simulates, restoring the ORIGINAL
player list wholesale — and no join event fires for that. Anyone who left
during the recording is back in the state with their renderer entries still
deleted. The next frame reaches

```js
const chatIndicator = chatIndicatorInfo[player.id];
if (chatIndicator.active && ...)     // no guard — unlike discInfo two lines above
```

and throws.

Fixed in the adapter, which calls the renderer's own `onGameStart` — its
public "rebuild everything" entry point (`_regenerateNecessaryObjects()` +
`resetTexts()`) — whenever a seek completes. renderer.js stays untouched.

**The general rule: any state rewind invalidates the renderer's incremental
caches.** Anything else added that caches per-player state across frames needs
rebuilding at the same point.

---

## Deliberate omissions

Not missing — decided.

| Left out | Why |
|---|---|
| Player movement / kick input | No local player; `currentPlayerId` is -1. |
| Chat sending, admin, kick/ban, room link, Rec | A recording is immutable. |
| Input + Misc settings tabs | Key binds for a player that doesn't exist; room/account settings. |
| Sound settings tab | Already the on-screen volume button — one setting, one place. |
| Input lag + network graph | No connection, no input round-trip. Forced off. |
| FPS limit, FPS counter | Playback rate is the transport's speed selector. |
| Theme tab | Removed on request. |
| Display mode / resolution | Window management; unchanged by which screen you're on. |
| Frame-step and ±5s buttons | Speeds run 0.1×–16×; slow-mo covers inspection, the scrubber covers travel. |

### Why not port `haxball-replay-analyzer`

That project works by running a **deobfuscated copy of Haxball's real
`game-min.js`**, with analytics hand-spliced into decompiled method bodies —
single-letter identifiers, no types, patches cut into functions like
`Jb.prototype.Cq`. It renders beautifully because it *is* the real client.

Rejected because it would mean: two engines in the app, its own canvas
renderer instead of ours, and a second implementation of the whole analytics
layer against a different object model — so overlay features would stop being
write-once across live and replay. Every future feature would be hand-patched
into obfuscated code, and re-patched whenever Haxball ships a new build.

Both symptoms that motivated the port (§3–4) turned out to be bugs in our own
wiring, not in node-haxball.

---

## Known limits

**Backward seeking re-simulates from frame 0.** Inherent to an input-tape
format. Cost of a single step *back*, measured:

| Position | Cost |
|---|---|
| frame 5,000 | 30 ms |
| frame 15,000 | 55 ms |
| frame 25,000 | 84 ms |
| frame 30,000 | 107 ms |

Fine for scrubbing; noticeable if you rewind repeatedly late in a long
recording. The fix, if it ever matters, is periodic state snapshots to rewind
from — `takeSnapshot()`/`useSnapshot()` exist on the sandbox room but not on
the replay reader, so it would mean keeping a parallel simulation.

**`geometry.checksum` is `null` for default stadiums.** Correct, not a bug —
only custom stadiums carry one.

---

## Scoping rules

The overriding constraint: **normal gameplay, rooms, sandbox and headless
must be untouched.** Verified against the branch point, not assumed.

Untouched, byte-identical: `Game.jsx`, `renderer.js`, `gameInput.js`, the
whole of `features/analytics/`, `ChatBox.jsx`, `OverlayControls.jsx`,
`SettingsPopup.jsx`, `VideoContent.jsx`, `JoinRoom.jsx`, `CreateSandbox.jsx`,
`PlayerDataDefaultValues.js`.

Modified, and **purely additive — zero lines removed**:

| File | Change |
|---|---|
| `src/App.jsx` | +2 — one import, one route |
| `src/features/rooms/RoomList.jsx` | +26 — handler for the dead file input |
| `src/assets/css/game.css` | +145 — appended `Replay playback` block |

Rules for future work on this branch:

- Shared components are **imported, never edited**. If one needs a new prop
  to serve the replay screen, write a replay-local component instead.
- Replay CSS lives only in the appended block and is scoped by
  `.replay-*` classes or the `.replay-bottom` marker class.
- Compatibility gaps belong in `replayRoomAdapter.js`, not in `if (isReplay)`
  branches scattered through shared code.
- **Anything that caches per-player state across frames must be rebuilt when a
  seek completes.** A seek rewinds room state wholesale, and a backward one
  restores the original player list with no join events — so any map keyed by
  player id silently goes stale and refers to players who are back. This is
  what froze the renderer (§11); a future overlay holding per-player state —
  LOS, passing lanes, per-player trails — will break the same way. The rebuild
  point is `rebuildRendererAfterSeek` in the adapter, which already runs on
  every completed seek; hook into it rather than inventing a second one.
- `ReplayRoomInfo` reuses the live `room-view` / `player-list-view` /
  `player-list-item` class names on purpose, so it inherits real styling
  (including the `--text-admin` highlight) with no CSS of its own.

Sanity check after any change:

```bash
git diff --numstat <branch-point> -- src/App.jsx \
  src/features/rooms/RoomList.jsx src/assets/css/game.css
# every line must show 0 deletions
```

---

## Next

- Stats over a whole replay — possession, passes, shots, heatmaps — by
  running the reader headlessly at high speed and aggregating from
  `extractFrame`. A full pass over the reference recording takes a few
  seconds at `setSpeed(5000)`.
- Batch mode: point it at a folder of `.hbr2` files and emit one NDJSON
  session per file, feeding `loadSession.js`.
- Goal markers / event timeline on the scrubber (goals must be detected from
  the simulation, not read from the file — see §format).
- Snapshot-based rewind if backward scrubbing becomes a bottleneck.
