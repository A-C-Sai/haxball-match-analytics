/**
 * useHaxballAnalytics.js
 *
 * Wires the data layer into a live room: writes a session NDJSON file and
 * mirrors a heartbeat + geometry summary to the devtools console (F12).
 *
 * Integration note: Game.jsx already assigns several `room.onAfterXXXXX`
 * callbacks directly (see its useEffect around line ~446) rather than using
 * a RoomConfig subclass. `onAfterGameTick` is not one of them (grep confirms
 * it's unused elsewhere in this codebase), so this hook can assign it
 * directly. It still chains defensively (calls whatever was there before,
 * then its own logic, and restores the previous value on cleanup) in case
 * that ever changes upstream.
 *
 * Stadium geometry is re-captured by watching `room.stadium` for identity
 * changes inside the tick handler, rather than also hooking
 * `onAfterStadiumChange` — that callback IS already used elsewhere in
 * Game.jsx, and re-assigning it here would silently clobber it depending on
 * effect ordering. Comparing object identity each tick is cheap and avoids
 * that whole class of bug.
 */

import { useEffect, useRef } from "react";
import { extractStadiumGeometry, extractFrame } from "./gameStateExtractor.js";
import { SnapshotLogger } from "./snapshotLogger.js";

/**
 * `logging` is intentionally separate from `enabled`: `enabled` controls
 * whether this hook runs at all (tick extraction, future overlay analytics,
 * everything); `logging` controls only whether SnapshotLogger records to
 * disk/console. Once live overlay analytics (LOS, heatmaps, passing lanes)
 * get added inside the tick handler below, they need `enabled: true` to
 * keep running even when you don't want a session file being written —
 * logging was always a debugging aid, not part of the overlay itself.
 *
 * Default: `import.meta.env.DEV` — Vite sets this true for `npm run dev`
 * and false for a production build (`npm run dist:*`/`zip:*`), so logging
 * switches itself off in whatever you actually ship without needing to
 * remember to flip anything by hand. Pass `logging` explicitly to override.
 *
 * @param {React.RefObject<import("node-haxball").Room>} roomRef
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled=true] master switch for the whole hook.
 * @param {boolean} [opts.logging=import.meta.env.DEV] whether to record to
 *   an NDJSON file + console heartbeat via SnapshotLogger.
 * @param {number} [opts.consoleHeartbeatTicks=60]
 * @param {number} [opts.sampleEveryNTicks=1]
 */
export default function useHaxballAnalytics(roomRef, opts = {}) {
  const {
    enabled = true,
    logging = import.meta.env.DEV,
    consoleHeartbeatTicks = 60,
    sampleEveryNTicks = 1,
  } = opts;
  const loggerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    const room = roomRef?.current;
    if (!room) return;

    const logger = logging ? new SnapshotLogger({ consoleHeartbeatTicks, sampleEveryNTicks }) : null;
    loggerRef.current = logger;

    let lastStadiumRef = null;
    let currentGeometry = null;

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

    const previousOnAfterGameTick = room.onAfterGameTick;
    room.onAfterGameTick = (customData) => {
      previousOnAfterGameTick?.(customData);
      const geometry = captureGeometryIfChanged();
      const frame = extractFrame(room);
      if (logger) logger.writeFrame(frame);

      // --- seam for live overlay analytics, independent of `logging` ---
      // e.g. const lanes = computePassingLanes(frame, geometry);
      //      overlayStateRef.current = { frame, geometry, lanes };
    };

    return () => {
      room.onAfterGameTick = previousOnAfterGameTick ?? null;
      logger?.close();
      loggerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomRef, enabled, logging, consoleHeartbeatTicks, sampleEveryNTicks]);

  return loggerRef;
}
