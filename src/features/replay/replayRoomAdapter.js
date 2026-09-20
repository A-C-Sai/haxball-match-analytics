/**
 * replayRoomAdapter.js
 *
 * Presents an `AsyncReplayReader` (from `API.Replay.read`) behind the same
 * surface the rest of this codebase already expects from a live `Room`, so
 * that `renderer.js`, `gameStateExtractor.js`, `useHaxballAnalytics.js` and
 * every future overlay feature run against a replay **unchanged**.
 *
 * ---------------------------------------------------------------------------
 * Why an adapter is needed at all
 * ---------------------------------------------------------------------------
 * `Replay.read()` does NOT return a Room. It returns a deliberately minimal
 * playback object (verified against node-haxball v2.2.0's `index.d.ts` and by
 * introspecting a live reader):
 *
 *   own members : state, extrapolate, getSpeed, setSpeed, getTime, length,
 *                 setTime, getCurrentFrameNo, setCurrentFrameNo, destroy,
 *                 onDestinationTimeReached, onEnd
 *   getters     : gameState, maxFrameNo, currentPlayerId (always -1)
 *
 * Everything else this codebase reaches for lives on `Room`, not on the
 * reader:
 *
 *   room.players            -> reader.state.players
 *   room.getPlayer(id)      -> reader.state.getPlayer(id)   (RoomState has it)
 *   room.stadium            -> reader.state.stadium
 *   room.getBall(ext)       -> NOT on reader or RoomState  (synthesized here)
 *   room.getPlayerDisc(...) -> NOT on reader or RoomState  (synthesized here)
 *   room.getDiscs/getDisc   -> NOT on reader or RoomState  (synthesized here)
 *   room.currentFrameNo     -> reader.getCurrentFrameNo()
 *   room.redScore/blueScore -> reader.gameState?.redScore / .blueScore
 *   room.timeElapsed        -> reader.gameState?.timeElapsed
 *   room.setRenderer(r)     -> NOT on reader               (synthesized here)
 *
 * ---------------------------------------------------------------------------
 * The `onAfterGameTick` trap (the reason a naive wiring looks dead)
 * ---------------------------------------------------------------------------
 * Measured against a real 30,093-frame .hbr2: during replay playback the
 * reader fires `onGameTick` 26,647 times and `onAfterGameTick` **zero** times.
 * `onBefore*`/`onAfter*` are Room-side hook points; the replay reader only
 * emits the plain callback set documented in
 * `node_modules/node-haxball/examples/api_structure/replayReader.js`.
 *
 * `useHaxballAnalytics.js` assigns `room.onAfterGameTick`. Rather than fork
 * that hook, this adapter subscribes to the reader's `onGameTick` and re-emits
 * it as `adapter.onAfterGameTick?.()`. The analytics layer therefore needs no
 * replay-specific branch — it just sees a room that ticks.
 *
 * ---------------------------------------------------------------------------
 * Renderer attachment
 * ---------------------------------------------------------------------------
 * `Room.setRenderer(r)` in node-haxball is exactly:
 *     old && (old.finalize?.(), old.room = null);
 *     r   && (r.room = this,   r.initialize?.());
 * (`room` is a getter/setter on `Renderer.prototype` aliasing the internal
 * field.) `setRenderer` below reproduces that, so `renderer.js` — which drives
 * its own MessageChannel render loop and pulls `thisRenderer.room.extrapolate(
 * ms, true)` every frame — works against a replay with no changes.
 *
 * The reader's own `render` callback is deliberately NOT used: this renderer
 * self-drives and would double-render.
 */

/** Disc index 0 is always the ball — same assumption `renderer.js` makes. */
const BALL_DISC_INDEX = 0;

/**
 * Events the reader emits that must be forwarded to the attached renderer.
 *
 * This is the fix for the "ball teleports outside the map / collisions look
 * broken" symptom, and it is NOT a physics problem: re-simulating a full
 * 30,093-frame replay headlessly keeps the ball inside the pitch the whole
 * time (max |x| 540 against a 550 goal line, max |y| 230 against 270) with a
 * constant disc count. The simulation is right; the picture was wrong.
 *
 * `renderer.js` does not rebuild its scene from state each frame. It keeps a
 * persistent PIXI sprite list (`customDiscInfo`, indexed to match the physics
 * disc array) that is created by `_regenerateNecessaryObjects()` and then
 * maintained incrementally through these callbacks — `onPlayerJoin` and
 * `onPlayerTeamChange` add/remove disc infos, `onGameStart` regenerates the
 * whole set, `onGameStop` tears it down, `onTeamGoal`/`onTimeIsUp`/`onGameEnd`
 * draw the overlay text.
 *
 * A live `Room` fans every event out to its attached renderer automatically.
 * `Replay.read(bytes, callbacks)` fans out only to the single callbacks object
 * it was given, so a renderer attached afterwards hears nothing and its sprite
 * list drifts out of alignment with the disc array — sprites end up drawn at
 * another disc's coordinates, which reads exactly like objects teleporting.
 *
 * Names come from `node_modules/node-haxball/src/rendererTemplate.js`, minus
 * the addon-related ones (customEvent / roomConfig / plugin / renderer /
 * library / language), which replay files contain no events for. Forwarding a
 * callback the renderer doesn't implement is harmless.
 */
const FORWARDED_CALLBACKS = [
  "onAnnouncement", "onAutoTeams", "onBansClear", "onCollisionDiscVsDisc",
  "onCollisionDiscVsPlane", "onCollisionDiscVsSegment", "onGameEnd",
  "onGamePauseChange", "onGameStart", "onGameStop", "onHandicapChange",
  "onKickOff", "onKickRateLimitChange", "onPingData", "onPlayerAdminChange",
  "onPlayerAvatarChange", "onPlayerBallKick", "onPlayerChat",
  "onPlayerChatIndicatorChange", "onPlayerDiscCreated",
  "onPlayerDiscDestroyed", "onPlayerHeadlessAvatarChange",
  "onPlayerInputChange", "onPlayerJoin", "onPlayerLeave",
  "onPlayerObjectCreated", "onPlayerSyncChange", "onPlayerTeamChange",
  "onPlayersOrderChange", "onPositionsReset", "onRoomPropertiesChange",
  "onRoomRecaptchaModeChange", "onRoomRecordingChange", "onScoreLimitChange",
  "onSetDiscProperties", "onStadiumChange", "onTeamColorsChange", "onTeamGoal",
  "onTeamsLockChange", "onTimeIsUp", "onTimeLimitChange",
];

/** Returns the extrapolated view of an object when asked for and available. */
function view(obj, extrapolated) {
  if (!obj) return null;
  return extrapolated ? (obj.ext ?? obj) : obj;
}

/**
 * Wraps a .hbr2 buffer in a Room-like playback object.
 *
 * @param {object} API                 `window.API` (node-haxball).
 * @param {Uint8Array} uint8Array      Raw contents of the .hbr2 file.
 * @param {object} [callbacks]         Any callbacks from the replay reader set
 *                                     (onPlayerChat, onTeamGoal, onPlayerBallKick, ...).
 *                                     `onGameTick` is chained, not overwritten.
 * @param {object} [options]           `{ requestAnimationFrame, cancelAnimationFrame }`.
 * @returns {object} adapter — Room-like, plus replay transport (`replay.*`).
 * @throws Propagates node-haxball errors (e.g. `ReplayFileVersionMismatchError`
 *         code 39, `ReplayFileReadError` code 40) — callers should try/catch.
 */
export function createReplayRoom(API, uint8Array, callbacks = {}, options = {}) {
  const adapter = {};

  let renderer = null;
  let seeking = false;
  let seekWatchdog = null;
  let userOnDestinationTimeReached = null;
  let userOnEnd = null;

  // Every event goes three places, in the order a live Room would deliver
  // them: the caller's own handler, the attached renderer (looked up at call
  // time, since the renderer is attached after read()), and the Room-shaped
  // `onAfterX` property so existing code that binds `room.onAfterX` keeps
  // working. `render` is deliberately never passed through — renderer.js
  // drives its own loop and would double-render.
  const readerCallbacks = {};
  for (const name of FORWARDED_CALLBACKS) {
    const userHandler = callbacks[name];
    const afterName = `onAfter${name.slice(2)}`;
    readerCallbacks[name] = (...args) => {
      userHandler?.(...args);
      renderer?.[name]?.(...args);
      adapter[afterName]?.(...args);
    };
  }

  // The caller's onGameTick still runs; then the Room-shaped re-emit fires.
  const userOnGameTick = callbacks.onGameTick;
  readerCallbacks.onGameTick = (customData) => {
    userOnGameTick?.(customData);
    renderer?.onGameTick?.(customData);
    // Bridge: replay readers never emit onAfterGameTick (see header note).
    adapter.onAfterGameTick?.(customData);
  };

  const reader = API.Replay.read(uint8Array, readerCallbacks, {
    requestAnimationFrame: null,
    cancelAnimationFrame: null,
    ...options,
  });

  /**
   * Seek-state bookkeeping.
   *
   * `seeking` is direction-agnostic on purpose: it is raised by any
   * `setCurrentFrameNo`/`setTime` and lowered only once the reader settles,
   * so forward and backward scrubs are covered by exactly the same gate.
   *
   * The adapter owns the reader's `onDestinationTimeReached` and `onEnd` so it
   * can lower the flag before handing either event to whoever registered one
   * through `replay.*`. Both matter:
   *
   *   - `onDestinationTimeReached` is the normal landing.
   *   - `onEnd` fires INSTEAD when a seek runs past the end of the recording.
   *     In that case the destination is never reached, so without this the
   *     flag would stay raised and every sound would be muted for the rest of
   *     the session — a silent, permanent failure.
   *
   * The watchdog is the last resort for any settle path neither callback
   * covers. It is deliberately generous: the slowest measured seek (a full
   * rewind from the end of a 30,093-frame recording) is ~107ms, so 10s cannot
   * fire during a legitimate seek, and a stuck flag costs at most that long.
   */
  const endSeek = () => {
    seeking = false;
    if (seekWatchdog !== null) {
      clearTimeout(seekWatchdog);
      seekWatchdog = null;
    }
  };

  const beginSeek = () => {
    seeking = true;
    if (seekWatchdog !== null) clearTimeout(seekWatchdog);
    seekWatchdog = setTimeout(endSeek, 10000);
  };

  /**
   * A completed seek invalidates the renderer's incremental caches, so they
   * are rebuilt before anyone else sees the event.
   *
   * `renderer.js` keys several maps by player id — `customDiscInfo`,
   * `chatIndicatorInfo`, `locationIndicatorInfo` — and maintains them through
   * join/leave/team-change callbacks rather than rebuilding per frame. A
   * backward seek resets the reader to frame 0 and re-simulates, which
   * restores the ORIGINAL player list wholesale; no join event fires for that,
   * so anyone who left during the recording comes back in the state with their
   * renderer entries still deleted.
   *
   * The next frame then hits renderer.js:1303:
   *
   *     const chatIndicator = chatIndicatorInfo[player.id];
   *     if (chatIndicator.active && ...)      // no guard, unlike discInfo above
   *
   * which throws `Cannot read properties of undefined (reading 'active')`
   * inside the render loop. The loop dies while the reader keeps running — the
   * picture freezes, but the frame counter keeps climbing and sound keeps
   * playing. That is the signature of this bug: playback alive, rendering dead.
   *
   * `onGameStart` is the renderer's own public "rebuild everything" entry
   * point (`_regenerateNecessaryObjects()` + `resetTexts()`), which clears
   * those maps and repopulates them from the current player list. Calling it
   * here keeps the fix in replay code — renderer.js stays untouched.
   */
  const rebuildRendererAfterSeek = () => {
    if (!renderer) return;
    try {
      renderer.onGameStart?.();
    } catch (err) {
      console.warn("[replay] renderer rebuild after seek failed", err);
    }
  };

  reader.onDestinationTimeReached = () => {
    const wasSeeking = seeking;
    endSeek();
    if (wasSeeking) rebuildRendererAfterSeek();
    userOnDestinationTimeReached?.();
  };

  reader.onEnd = () => {
    const wasSeeking = seeking;
    endSeek();
    // Only when a seek was in flight — a natural end-of-playback needs nothing.
    if (wasSeeking) rebuildRendererAfterSeek();
    userOnEnd?.();
  };

  Object.defineProperties(adapter, {
    // --- identity / room-level state -------------------------------------
    state: { get: () => reader.state, enumerable: true },
    gameState: { get: () => reader.gameState, enumerable: true },
    name: { get: () => reader.state?.name ?? "", enumerable: true },
    stadium: { get: () => reader.state?.stadium ?? null, enumerable: true },
    players: { get: () => reader.state?.players ?? [], enumerable: true },
    teamColors: { get: () => reader.state?.teamColors, enumerable: true },
    teamsLocked: { get: () => reader.state?.teamsLocked ?? true, enumerable: true },
    timeLimit: { get: () => reader.state?.timeLimit ?? 0, enumerable: true },
    scoreLimit: { get: () => reader.state?.scoreLimit ?? 0, enumerable: true },

    // --- live game readouts ----------------------------------------------
    currentFrameNo: { get: () => reader.getCurrentFrameNo(), enumerable: true },
    redScore: { get: () => reader.gameState?.redScore ?? null, enumerable: true },
    blueScore: { get: () => reader.gameState?.blueScore ?? null, enumerable: true },
    timeElapsed: { get: () => reader.gameState?.timeElapsed ?? null, enumerable: true },

    // --- renderer compatibility -------------------------------------------
    // Renderers read this during initialize() to pick a follow target. The
    // reader always reports -1 (no local player), which is what we want: a
    // replay is a spectator view, so the camera should not lock to anyone.
    currentPlayerId: { get: () => -1, enumerable: true },
    renderer: {
      get: () => renderer,
      set: (value) => { adapter.setRenderer(value); },
      enumerable: true,
    },

    // --- replay transport (not part of the Room surface) -------------------
    replay: {
      value: {
        reader,
        /** Total frames in the file. */
        get maxFrameNo() { return reader.maxFrameNo; },
        /** Replay length in milliseconds. */
        length: () => reader.length(),
        getTime: () => reader.getTime(),
        getCurrentFrameNo: () => reader.getCurrentFrameNo(),
        getSpeed: () => reader.getSpeed(),
        /** 0 = paused, 1 = realtime, >1 = fast-forward, <1 = slow-mo. */
        setSpeed: (coefficient) => reader.setSpeed(coefficient),
        /**
         * Seeking is a re-simulation, not an index lookup — frames are
         * generated on the fly and never stored, so rewinding replays the
         * whole file from frame 0 and can take a moment on long recordings.
         * `onDestinationTimeReached` fires when it lands.
         *
         * `isSeeking` is true for that whole window, and callers should use it
         * to suppress anything that assumes real-time playback — sound above
         * all. A backward seek re-simulates from frame 0 at full speed, which
         * replays every event in between: measured on a real recording, a
         * single 15000 -> 3000 scrub fired 63 kick events with 57 of 62 gaps
         * under 10ms. Played as audio that is dozens of identical buffers
         * summing in the mixer — a burst of static, not a kick.
         */
        setTime: (ms) => { beginSeek(); reader.setTime(ms); },
        setCurrentFrameNo: (frameNo) => { beginSeek(); reader.setCurrentFrameNo(frameNo); },
        get isSeeking() { return seeking; },
        set onDestinationTimeReached(fn) { userOnDestinationTimeReached = fn; },
        get onDestinationTimeReached() { return userOnDestinationTimeReached; },
        set onEnd(fn) { userOnEnd = fn; },
        get onEnd() { return userOnEnd; },
      },
      enumerable: true,
    },
  });

  // --- disc accessors the extractor and renderer rely on -------------------

  /** @returns {object|null} the ball disc (index 0), or null if no game. */
  adapter.getBall = (extrapolated = false) =>
    view(reader.gameState?.physicsState?.discs?.[BALL_DISC_INDEX], extrapolated);

  adapter.getDiscs = (extrapolated = false) => {
    const discs = reader.gameState?.physicsState?.discs ?? [];
    return extrapolated ? discs.map((d) => view(d, true)) : discs;
  };

  adapter.getDisc = (discId, extrapolated = false) =>
    view(reader.gameState?.physicsState?.discs?.[discId], extrapolated);

  adapter.getPlayer = (id) => reader.state?.getPlayer(id) ?? null;

  /** Player discs hang off the Player object; spectators have none. */
  adapter.getPlayerDisc = (playerId, extrapolated = false) =>
    view(reader.state?.getPlayer(playerId)?.disc, extrapolated);

  adapter.getPlayerDisc_exp = (playerId) => adapter.getPlayerDisc(playerId, false);

  // --- renderer / lifecycle -------------------------------------------------

  /**
   * Extrapolation is deliberately and unconditionally pinned to 0 here.
   *
   * On a live room, `extrapolate(ms)` hides network latency by projecting the
   * last known state forward. On a *replay reader* it does something quite
   * different — from node-haxball's own implementation:
   *
   *     cW: function(h=0){            // = extrapolate(ms)
   *       this.LM();                          // advance playback
   *       var N = this.a.AE(++this.nk);       // copy of current state
   *       N.nM(this.UW + h*this.xE | 0);      // run h-ms of RAW physics steps
   *       return N;
   *     }
   *
   * `N.nM(k)` runs k blind physics steps on that copy: no recorded inputs, no
   * re-resolution against the authoritative tick. Measured on a real replay,
   * driving this the way `renderer.js` does (every rendered frame, uncapped):
   *
   *     extrapolation = 0ms   -> rendered ball max |x| 540 (pitch is 550),  1 frame jump >40u
   *     extrapolation = 100ms -> rendered ball max |x| 575 (OFF the pitch), 79 frame jumps >40u
   *
   * while the authoritative state stayed at 540 in both. That is the "ball
   * teleports outside the map / collisions look broken" symptom, and it is a
   * rendering artifact, not a physics error.
   *
   * A replay has zero latency, so extrapolation buys nothing here and costs
   * exactly this. Pinning it in the adapter (rather than only setting
   * `renderer.extrapolation = 0`) means the user's persisted live-play
   * extrapolation setting can never leak back in through the settings UI.
   *
   * The second argument exists only because `renderer.js` passes one; on a
   * live Room it forces a recompute, which is already the reader's behaviour.
   */
  adapter.extrapolate = () => reader.extrapolate(0);

  /**
   * Renderer option changes (`renderer.discLineWidth = 5`, etc.).
   *
   * Renderer options are declared with `defineVariable`, which installs a
   * setter that does, from node-haxball's own source:
   *
   *     set: a => { var i = I; a != i && (I = a,
   *                 E.DM?._onVariableValueChange?.(E, W, i, I)); }
   *
   * `E.DM` is the renderer's room. So assigning an option calls
   * `room._onVariableValueChange(renderer, name, oldValue, newValue)`, and a
   * live Room fans that out to the renderer's own `onVariableValueChange`
   * handler — which is what actually applies the change (it calls
   * `_regenerateNecessaryObjects()` for the line widths, rebuilds at the new
   * `resolutionScale`, toggles the FPS text, and so on).
   *
   * Without this method the assignment silently stored the value and nothing
   * ever redrew: "General line width" did nothing at all, and "Disc line
   * width" only appeared to affect one player at a time — each disc picked
   * the new width up incidentally, whenever the per-frame cache check
   * happened to redraw it for an unrelated reason (a colour or radius
   * change).
   */
  adapter._onVariableValueChange = (addonObject, variableName, oldValue, newValue) => {
    renderer?.onVariableValueChange?.(addonObject, variableName, oldValue, newValue);
  };

  /** Mirrors node-haxball's own `Room.setRenderer` semantics exactly. */
  adapter.setRenderer = (value) => {
    if (renderer) {
      renderer.finalize?.();
      renderer.room = null;
    }
    renderer = value ?? null;
    if (renderer) {
      renderer.room = adapter;
      renderer.initialize?.();
    }
  };

  /**
   * Room-surface no-ops.
   *
   * These exist so the app's shared components (ChatBox, PlayerListView,
   * RoomHeader, …) can be mounted against a replay without each growing an
   * `if (isReplay)` branch. A recording is immutable and has no local player,
   * so every mutating call is a silent no-op rather than an error: components
   * call these from event handlers where throwing would break the UI.
   *
   * `currentPlayer` is null for the same reason `currentPlayerId` is -1 —
   * a replay is a spectator view with nobody behind the camera. Components
   * that offer per-player admin actions should be passed `isAdmin={false}`,
   * which disables those controls before they can reach these stubs.
   */
  adapter.isRecording = () => false;
  adapter.sendChat = () => {};
  adapter.setChatIndicatorActive = () => {};
  adapter.changeTeam = () => {};
  adapter.resetTeam = () => {};
  adapter.setPlayerTeam = () => {};
  adapter.setPlayerAdmin = () => {};
  adapter.setAvatar = () => {};
  adapter.startGame = () => {};
  adapter.stopGame = () => {};
  adapter.pauseGame = () => {};
  adapter.currentPlayer = null;
  adapter.leave = () => adapter.destroy();

  adapter.destroy = () => {
    adapter.setRenderer(null);
    adapter.onAfterGameTick = null;
    endSeek();
    userOnEnd = null;
    userOnDestinationTimeReached = null;
    reader.onEnd = null;
    reader.onDestinationTimeReached = null;
    try {
      reader.setSpeed(0);
    } catch { /* reader may already be torn down */ }
    reader.destroy();
  };

  return adapter;
}

/**
 * Reads a `File` (from the .hbr2 file input) into a `Uint8Array`.
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
export function readReplayFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("Could not read replay file"));
    fr.readAsArrayBuffer(file);
  });
}
