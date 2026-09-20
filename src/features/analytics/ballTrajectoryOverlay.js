/**
 * ballTrajectoryOverlay.js
 *
 * Draw layer for ballTrajectory.js.
 *
 * RATE SPLIT. Unlike momentumOverlay.js, the trace is computed at TICK rate,
 * not per rendered frame. The path only changes when the ball's velocity
 * changes — a kick or a bounce — so recomputing it every rAF would be ~4x the
 * work for an identical result. Compute in the tick handler, keep the returned
 * points, draw them every frame. The points are map coordinates, so the same
 * array survives any number of frames and camera moves.
 *
 * The cost is that the computed path is up to one tick behind the extrapolated
 * ball sprite. That is NOT ignorable — at speed it leaves a visible gap
 * between the ball and the start of its own path, opening and closing every
 * tick, which reads as the overlay lagging. The draw layer closes it by
 * starting the path at the sprite's extrapolated position; see
 * `transform.ballPos` on drawBallTrace.
 *
 * ---------------------------------------------------------------------------
 * THE BALL HAS WIDTH, AND THE OVERLAY DRAWS IT
 *
 * The ball is a disc of `radius` (10 on the classic map), not a point. A
 * one-pixel centre line is a lie in the one case that matters most: whether
 * the ball actually FITS. A hairline can thread a gap between two players
 * that a 20-unit-wide ball cannot.
 *
 * So the path is drawn as the swept corridor — the region the ball body
 * actually occupies — by stroking the centre polyline at a width of
 * `2 * radius` map units with round caps and joins. That stroke is exactly the
 * Minkowski sum of the path with the ball disc, so the rounding at each bounce
 * corner is correct rather than cosmetic. A thin centre line is drawn on top
 * for precision.
 *
 * Note the width must be scaled by `cameraScale` like any other map-space
 * quantity. A fixed pixel width would be wrong at every zoom level.
 *
 * WHAT THIS ADDS BEYOND WHAT THE EYE HAS
 *
 * The ball is visibly moving in a direction, so the first stretch of the
 * centre line restates what is already on screen. Four things do not:
 *
 *   1. CLEARANCE. Whether the ball body fits through the gap ahead — visible
 *      only once the corridor is drawn at true width.
 *
 *   2. BOUNCE POINTS. Where it turns and what it does after. Needs the
 *      asymmetric reflection rule and each surface's bCoef — the goal-side
 *      walls on the classic map return almost nothing (e = 0.05) and look no
 *      different from a lively wall.
 *
 *   3. THE STOP POINT. Damping bounds total travel at |v| / (1 - d). A ball
 *      that looks like it will reach the far post may arrive 80 units short.
 *      This is why the horizon is a DISTANCE and not a tick count — a tick cap
 *      truncates precisely the slow ball whose resting place you wanted.
 *
 *   4. WHETHER IT GOES IN, after bounces.
 *
 * The pre-first-bounce stretch is therefore drawn slightly faded and
 * everything after a bounce at full strength — an emphasis, not a hiding.
 * The corridor itself is always shown while the ball is moving, because the
 * clearance question applies from the first tick.
 * ---------------------------------------------------------------------------
 */

import { buildCollisionSet, predictBallPath } from "./ballTrajectory.js";

/**
 * @typedef {{x:number,y:number}} Vec2
 */

/**
 * Cache the per-entity collision set. Rebuilding it scans the whole stadium,
 * so it must be keyed on the SAME geometryVersion the session logger uses —
 * a mid-game stadium change otherwise leaves the ball bouncing off the
 * previous map's walls.
 */
let cache = { geometryVersion: null, set: null };

/**
 * @param {Object} geometry output of extractStadiumGeometry()
 * @param {number} geometryVersion
 * @param {{cMask:number,cGroup:number}} ballSpec
 * @returns {ReturnType<typeof buildCollisionSet>}
 */
export function getCollisionSet(geometry, geometryVersion, ballSpec) {
  if (cache.geometryVersion !== geometryVersion || !cache.set) {
    cache = { geometryVersion, set: buildCollisionSet(geometry, ballSpec) };
  }
  return cache.set;
}

/** Drop the cached set. Call on stadium change if you do not pass a version. */
export function resetCollisionSetCache() {
  cache = { geometryVersion: null, set: null };
}

/**
 * Compute the trace. Call once per TICK, from useHaxballAnalytics's tick
 * handler — not from the rAF hook.
 *
 * Reads the ball from `gameState.physicsState.discs[0]`, the same documented
 * path renderer.js and momentumOverlay.js use.
 *
 * @param {import("node-haxball").RoomState} roomState live (NOT extrapolated) room state
 * @param {Object} geometry output of extractStadiumGeometry()
 * @param {number} geometryVersion
 * @param {Object} [options]
 * @param {number} [options.maxDistance=520] how far along the path to trace, in
 *   map units. This is the real horizon — see predictBallPath on why ticks are
 *   the wrong unit. Any ball whose remaining travel fits inside this is drawn
 *   all the way to where it stops.
 * @param {number} [options.minRemainingTravel=15] hide the trace once the ball
 *   has less than this much travel left. DERIVED, not guessed: remaining
 *   travel is |v| / (1 - damping), so 15 units is about 1.5 ball diameters —
 *   the point past which the path is too short to tell you anything. The
 *   previous version used a raw speed cutoff of 1.5, which at damping 0.99
 *   still leaves 150 units of roll: the overlay vanished with a sixth of the
 *   pitch still to cross, and took the resting place with it.
 * @param {number} [options.maxTicks=600] safety bound on the simulation loop.
 * @param {boolean} [options.onlyWhenInteresting=false] when true, suppress traces
 *   with no bounce and no stop point. Off by default: the clearance question
 *   (see header) applies even to a plain straight run, so there is usually
 *   something to show.
 * @returns {{points:Vec2[], bounces:{index:number,pos:Vec2}[],
 *            firstBounceIndex:number, stops:boolean, radius:number,
 *            travelled:number} | null}
 *   `radius` is carried through so the draw layer can render true ball width
 *   without re-reading the room. `stops` is true only when the ball genuinely
 *   comes to rest inside the trace.
 */
export function computeBallTrace(roomState, geometry, geometryVersion, options = {}) {
  const {
    maxDistance = 520,
    minRemainingTravel = 15,
    maxTicks = 600,
    onlyWhenInteresting = false,
  } = options;

  const ball = roomState?.gameState?.physicsState?.discs?.[0];
  if (!ball) return null;

  const speed = Math.hypot(ball.speed.x, ball.speed.y);
  // Gate on how far the ball can still go, not on raw speed — the same speed
  // means very different things at different damping values.
  const remaining = speed / (1 - ball.damping);
  if (remaining < minRemainingTravel) return null;

  const ballSpec = {
    radius: ball.radius,
    bCoef: ball.bCoef,
    damping: ball.damping,
    cMask: ball.cMask,
    cGroup: ball.cGroup,
  };
  const set = getCollisionSet(geometry, geometryVersion, ballSpec);

  const trace = predictBallPath(
    {
      pos: { x: ball.pos.x, y: ball.pos.y },
      vel: { x: ball.speed.x, y: ball.speed.y },
      radius: ballSpec.radius,
      bCoef: ballSpec.bCoef,
      damping: ballSpec.damping,
    },
    set,
    maxTicks,
    { maxDistance },
  );

  const firstBounceIndex = trace.bounces.length ? trace.bounces[0].index : -1;
  const stops = trace.stopped;

  // Nothing here the eye does not already have: no bounce, and the ball is
  // still travelling at the end of the horizon so there is no stop point
  // either. Drawing this is decoration.
  if (onlyWhenInteresting && firstBounceIndex === -1 && !stops) return null;

  return { ...trace, firstBounceIndex, stops, radius: ballSpec.radius };
}

/**
 * Draw the trace. Call every rendered frame, from the same rAF hook
 * momentumOverlay.js draws from, using the same transform.
 *
 * `transform.ballPos` should be the EXTRAPOLATED ball position from the same
 * frame the renderer just drew. The trace is computed at tick rate, so its
 * first point is where the ball will be at the end of the current tick, while
 * the ball sprite is drawn somewhere part-way there. Without this the path
 * visibly starts ahead of its own ball — a gap that opens and closes every
 * tick, up to a full ball-diameter wide at speed. Passing it makes the path
 * begin exactly under the sprite. Omitting it degrades gracefully.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof computeBallTrace>} trace
 * @param {{cameraOrigin:Vec2, cameraScale:number, canvasWidth:number,
 *          canvasHeight:number, ballPos?:Vec2}} transform
 * @param {Object} [style]
 */
export function drawBallTrace(ctx, trace, transform, style = {}) {
  if (!trace || trace.points.length < 2) return;

  const { cameraOrigin, cameraScale, canvasWidth, canvasHeight, ballPos } = transform;
  const {
    corridorColor = "rgba(255, 215, 0, 0.14)",  // the swept body, post-bounce
    corridorKnownColor = "rgba(255, 215, 0, 0.07)", // the swept body, pre-bounce
    knownColor = "rgba(255, 215, 0, 0.45)",     // centre line, pre-first-bounce
    predictedColor = "#ffd700",                 // centre line, post-bounce
    centreLineWidth = 1.5,
    bounceColor = "#ff8c3a",
    bounceRadiusPx = 4,
    stopColor = "#ff5470",
  } = style;

  const toScreenX = (x) => (x - cameraOrigin.x) * cameraScale + canvasWidth / 2;
  const toScreenY = (y) => (y - cameraOrigin.y) * cameraScale + canvasHeight / 2;

  // Start the drawn path under the ball sprite rather than at the tick
  // position it has already left.
  const raw = trace.points;
  const points = ballPos ? [{ x: ballPos.x, y: ballPos.y }, ...raw] : raw;
  const shift = ballPos ? 1 : 0;
  const { bounces, firstBounceIndex, radius } = trace;
  const splitAt = firstBounceIndex === -1 ? points.length - 1 : firstBounceIndex + shift;

  /** Trace a sub-path of the centre polyline into the current ctx path. */
  const pathFrom = (from, to) => {
    ctx.beginPath();
    ctx.moveTo(toScreenX(points[from].x), toScreenY(points[from].y));
    for (let i = from + 1; i <= to; i++) ctx.lineTo(toScreenX(points[i].x), toScreenY(points[i].y));
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // --- the swept corridor: true ball width, in map units -------------------
  // Stroking at 2*radius with round caps/joins IS the Minkowski sum of the
  // path with the ball disc, so this is the region the ball body occupies —
  // not a decorative thickening. Scale with the camera like any map quantity.
  const corridorPx = 2 * radius * cameraScale;
  if (corridorPx > 1) {
    ctx.lineWidth = corridorPx;
    if (splitAt > 0) {
      ctx.strokeStyle = corridorKnownColor;
      pathFrom(0, splitAt);
      ctx.stroke();
    }
    if (splitAt < points.length - 1) {
      ctx.strokeStyle = corridorColor;
      pathFrom(splitAt, points.length - 1);
      ctx.stroke();
    }
  }

  // --- the centre line, for precision --------------------------------------
  ctx.lineWidth = centreLineWidth;

  // Up to the first bounce: restates what is visible, so it is faded.
  if (splitAt > 0) {
    ctx.strokeStyle = knownColor;
    pathFrom(0, splitAt);
    ctx.stroke();
  }

  // After the first bounce: not on screen yet.
  if (splitAt < points.length - 1) {
    ctx.strokeStyle = predictedColor;
    pathFrom(splitAt, points.length - 1);
    ctx.stroke();
  }

  for (const b of bounces) {
    ctx.fillStyle = bounceColor;
    ctx.beginPath();
    ctx.arc(toScreenX(b.pos.x), toScreenY(b.pos.y), bounceRadiusPx, 0, Math.PI * 2);
    ctx.fill();
  }

  // Where the ball actually runs out of travel. Drawn at the ball's own
  // radius, so it reads as "the ball ends up here" rather than as a generic
  // marker. Only meaningful if it stops inside the horizon — otherwise this
  // is just the end of the drawn line.
  if (trace.stops) {
    const end = points[points.length - 1];
    ctx.strokeStyle = stopColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toScreenX(end.x), toScreenY(end.y), Math.max(3, radius * cameraScale), 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
