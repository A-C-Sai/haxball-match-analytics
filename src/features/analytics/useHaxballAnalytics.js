/**
 * useHaxballAnalytics.js
 *
 * Wires the data layer into a live room OR a replay: per-tick state
 * extraction, engine event capture, and (optionally) an NDJSON session file
 * plus a console heartbeat mirrored to the devtools console (F12).
 *
 * ---------------------------------------------------------------------------
 * Chaining, not assigning
 * ---------------------------------------------------------------------------
 * Game.jsx already assigns several `room.onAfterXXXXX` callbacks directly
 * rather than using a RoomConfig subclass. Two of the callbacks this hook
 * wants — `onAfterPlayerBallKick` and `onAfterTeamGoal` — are among them,
 * used for sound and UI. So every callback here is CHAINED, never assigned:
 * capture whatever was there, call it first, run our observer, restore the
 * previous value on cleanup, and pass the previous handler's return value
 * through untouched so the engine's customData convention still works.
 *
 * ---------------------------------------------------------------------------
 * Replay compatibility
 * ---------------------------------------------------------------------------
 * This hook runs unmodified against `replayRoomAdapter`. The adapter derives
 * an `onAfterX` name for every entry in its FORWARDED_CALLBACKS list and
 * invokes `adapter[afterName]`, so all of the events bound below are bridged
 * automatically. Adding a genuinely NEW event means adding it to that list.
 *
 * But a replay can seek, and a seek is a re-simulation rather than an index
 * lookup. Every event in the traversed span fires again at full speed — a
 * single measured scrub produced 539 to 841 kick events — and a backward seek
 * restarts from frame 0, so `frameNo` runs backwards and repeats. Recording
 * any of that would write occurrences that never happened at times that make
 * no sense, and would break every downstream assumption about ordering.
 *
 * So the whole observer is suppressed while `room.replay.isSeeking` is set,
 * mirroring what ReplayView already does for sound. In a live room the
 * property is absent and the optional chain is always false.
 *
 * Geometry is deliberately inside the guard too. A backward seek restores the
 * original room state wholesale, which can hand back a fresh stadium object
 * and would otherwise bump `geometryVersion` spuriously on every rewind. The
 * identity comparison persists across the suppressed window, so if the map
 * genuinely changed, the first tick after the seek completes still catches it.
 *
 * ---------------------------------------------------------------------------
 * Stadium changes
 * ---------------------------------------------------------------------------
 * Geometry is re-captured by watching `room.stadium` for identity changes
 * inside the tick handler, rather than also hooking `onAfterStadiumChange` —
 * that callback IS already used elsewhere in Game.jsx. Chaining would work
 * there too, but comparing object identity each tick is cheap and avoids
 * depending on effect ordering at all.
 */

import { useEffect, useRef } from "react";
import { extractStadiumGeometry, extractFrame } from "./gameStateExtractor.js";
import { SnapshotLogger } from "./snapshotLogger.js";

/**
 * Wraps `room[name]` so `observer` runs after whatever was already there.
 *
 * The engine passes a `customData` value as the last argument of each
 * callback and uses the return value to feed the next one in its chain. We
 * are a passive observer, so we call the previous handler first, ignore our
 * own return, and hand back exactly what the previous handler returned.
 *
 * @returns {() => void} restore function
 */
function chainRoomCallback(room, name, observer) {
  const previous = room[name];
  room[name] = (...args) => {
    const passthrough = previous?.(...args);
    try {
      observer(...args);
    } catch (err) {
      // An analytics bug must never take down gameplay, sound or playback.
      // eslint-disable-next-line no-console
      console.error(`[haxball-analytics] observer for ${name} threw:`, err);
    }
    return passthrough;
  };
  return () => {
    room[name] = previous ?? null;
  };
}

/**
 * `logging` is intentionally separate from `enabled`: `enabled` controls
 * whether this hook runs at all (tick extraction, event capture, future
 * overlay analytics); `logging` controls only whether SnapshotLogger records
 * to disk/console. Once live overlay analytics (LOS, heatmaps, passing
 * lanes) get added inside the tick handler below, they need `enabled: true`
 * to keep running even when you don't want a session file being written.
 *
 * Default for `logging`: `import.meta.env.DEV` — Vite sets this true for
 * `npm run dev` and false for a production build, so logging switches itself
 * off in whatever you actually ship. Pass `logging` explicitly to override.
 *
 * @param {React.RefObject<import("node-haxball").Room>} roomRef  a live Room,
 *   or the Room-shaped object returned by `createReplayRoomAdapter`.
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled=true] master switch for the whole hook.
 * @param {boolean} [opts.logging=import.meta.env.DEV] record to an NDJSON
 *   file + console heartbeat via SnapshotLogger.
 * @param {boolean} [opts.captureCollisions=true] include disc-vs-disc,
 *   disc-vs-segment and disc-vs-plane collisions. These are by far the
 *   highest-frequency events available — every wall graze and every body
 *   contact fires one — so this is the first thing to turn off if session
 *   files get unwieldy or the tick budget gets tight. Kicks, goals,
 *   kick-offs and position resets are unaffected by this flag.
 * @param {number} [opts.consoleHeartbeatTicks=60]
 * @param {number} [opts.sampleEveryNTicks=1] frame sampling only; events are
 *   never sampled.
 * @param {((room:any, frame:any, geometry:any)=>void)|null} [opts.onTick=null]
 *   Per-tick seam for live overlay analytics. Runs independently of
 *   `logging`, is skipped during replay seeks like every other observer, and
 *   is held in a ref so passing an inline arrow does not re-subscribe the
 *   room callbacks on every render. Exceptions are caught and logged — an
 *   overlay bug must not kill the tick handler.
 */
export default function useHaxballAnalytics(roomRef, opts = {}) {
  const {
    enabled = true,
    logging = import.meta.env.DEV,
    captureCollisions = true,
    consoleHeartbeatTicks = 60,
    sampleEveryNTicks = 1,
    onTick = null,
  } = opts;
  const loggerRef = useRef(null);

  // Held in a ref, NOT in the effect's dependency array. Callers pass an
  // inline arrow, which is a new function identity every render — as a
  // dependency that would tear down and re-chain all eleven room callbacks
  // on every render. The ref lets the effect subscribe exactly once while
  // still calling the latest callback.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    if (!enabled) return;
    const room = roomRef?.current;
    if (!room) return;

    const logger = logging ? new SnapshotLogger({ consoleHeartbeatTicks, sampleEveryNTicks }) : null;
    loggerRef.current = logger;

    let lastStadiumRef = null;
    let currentGeometry = null;

    /**
     * True only on a replay that is mid-seek. Absent on a live Room, where
     * the optional chain short-circuits to undefined.
     */
    const isSeeking = () => room.replay?.isSeeking === true;

    const captureGeometryIfChanged = () => {
      if (room.stadium !== lastStadiumRef) {
        lastStadiumRef = room.stadium;
        currentGeometry = extractStadiumGeometry(room);
        if (logger && currentGeometry) logger.writeGeometry(currentGeometry);
      }
      return currentGeometry;
    };

    // capture immediately for the stadium already loaded on join
    captureGeometryIfChanged();

    const restorers = [];

    // ---- per-tick state ----
    restorers.push(
      chainRoomCallback(room, "onAfterGameTick", () => {
        if (isSeeking()) return;

        const geometry = captureGeometryIfChanged();
        const frame = extractFrame(room);
        if (logger) logger.writeFrame(frame);

        // --- seam for live overlay analytics, independent of `logging` ---
        // `onTick` runs whether or not a session is being recorded: overlays
        // must work with logging off, which is the normal case.
        //
        // NOTE for anything stateful added here: a backward seek rewinds room
        // state wholesale and restores the original player list with no join
        // events, so any map keyed by player id silently goes stale. The
        // replay adapter's `rebuildRendererAfterSeek` is the rebuild point —
        // hook into it rather than inventing a second one.
        //
        // Throwing here would kill the tick handler for the rest of the
        // session, so a bad overlay cannot take the game down with it.
        if (onTickRef.current) {
          try {
            onTickRef.current(room, frame, geometry);
          } catch (err) {
            console.error("[haxball-analytics] onTick threw:", err);
          }
        }
      })
    );

    // ---- discrete events ----
    // Recording ids rather than object references: the NDJSON has to survive
    // serialization, and the geometry line already carries everything those
    // references would have pointed at.
    const onEvent = (event, data) => {
      if (isSeeking()) return;
      logger?.writeEvent(event, data);
    };

    restorers.push(
      chainRoomCallback(room, "onAfterPlayerBallKick", (playerId) =>
        onEvent("playerBallKick", { playerId })
      ),
      chainRoomCallback(room, "onAfterTeamGoal", (teamId, goalId) =>
        onEvent("teamGoal", { teamId, goalId })
      ),
      chainRoomCallback(room, "onAfterKickOff", () => onEvent("kickOff", {})),
      chainRoomCallback(room, "onAfterPositionsReset", () => onEvent("positionsReset", {})),
      chainRoomCallback(room, "onAfterGameStart", (byId) => onEvent("gameStart", { byId })),
      chainRoomCallback(room, "onAfterGameStop", (byId) => onEvent("gameStop", { byId })),
      chainRoomCallback(room, "onAfterGameEnd", (winningTeamId) =>
        onEvent("gameEnd", { winningTeamId })
      )
    );

    if (captureCollisions) {
      restorers.push(
        chainRoomCallback(room, "onAfterCollisionDiscVsDisc", (discId1, discPlayerId1, discId2, discPlayerId2) =>
          onEvent("collisionDiscVsDisc", { discId1, discPlayerId1, discId2, discPlayerId2 })
        ),
        chainRoomCallback(room, "onAfterCollisionDiscVsSegment", (discId, discPlayerId, segmentId) =>
          onEvent("collisionDiscVsSegment", { discId, discPlayerId, segmentId })
        ),
        chainRoomCallback(room, "onAfterCollisionDiscVsPlane", (discId, discPlayerId, planeId) =>
          onEvent("collisionDiscVsPlane", { discId, discPlayerId, planeId })
        )
      );
    }

    return () => {
      // Restore in reverse assignment order, so nested wrappers unwind
      // cleanly if anything else chained on top of us in the meantime.
      for (let i = restorers.length - 1; i >= 0; i--) restorers[i]();
      logger?.close();
      loggerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomRef, enabled, logging, captureCollisions, consoleHeartbeatTicks, sampleEveryNTicks]);

  return loggerRef;
}
