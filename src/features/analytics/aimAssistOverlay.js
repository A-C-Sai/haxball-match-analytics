/**
 * aimAssistOverlay.js
 *
 * The cue line: where the ball would actually go if this player kicked NOW.
 *
 * Companion to ballTrajectoryOverlay.js, and deliberately the mirror image of
 * it. That one is descriptive — it traces a decision already taken. This one
 * is counterfactual: it traces a decision still in front of the player, which
 * is the only kind that can change what they do.
 *
 * ---------------------------------------------------------------------------
 * THE ONE FORMULA
 *
 *   v_post = ball.velocity + kickStrength * normalize(ball.pos - player.pos)
 *
 * Verified against node-haxball 2.3.1 (the version this repo locks) in a
 * sandbox (see
 * scripts/validate-aim-assist.mjs). The whole of the kick is that line:
 *
 *   - magnitude is exactly kickStrength, with NO distance falloff
 *   - direction is exactly player -> ball
 *   - it does not depend on the player's velocity
 *   - it is purely ADDITIVE to the ball's velocity
 *
 * Because the impulse is added to whatever the ball is already doing, the
 * current collision state is baked in for free: cushioning, power and a
 * glancing touch all fall out of ball.velocity without special-casing.
 *
 * After the impulse the ball is an ordinary free ball, so the rest of the
 * prediction is predictBallPath() unchanged. Measured, one tick after a kick
 * at gap 27 with the ball already moving at 6 along +x:
 *
 *   engine  p=(11.0000, 0.0000)  v=(10.8900, 0.0000)
 *   model   p=(11.0000, 0.0000)  v=(10.8900, 0.0000)
 *
 * i.e. impulse, then `p += v_post`, then damping — the same per-tick order
 * ballTrajectory.js already implements.
 *
 * ---------------------------------------------------------------------------
 * DO NOT DRAW THE FACING RAY
 *
 * The obvious implementation — draw a line along player -> ball — is wrong,
 * and wrong in the worst possible way: it is exactly right when the ball is
 * still and increasingly wrong as the ball moves, so it looks most confident
 * precisely when it is most misleading.
 *
 * The result is a VECTOR SUM. A ball crossing at speed 6, kicked "straight
 * up", leaves at 39.81 degrees where the facing ray claims 90. Fifty degrees
 * of error in an ordinary situation.
 *
 * Correcting that misconception is most of the value here. It is not a gap in
 * the player's information — it is a belief they hold that is measurably
 * wrong. The fix costs one vector addition.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS EXACT AND WHAT IS NOT
 *
 * The physics is not the uncertain part. For a kick taken THIS TICK the
 * post-kick velocity is exact and the resulting path is the engine's own
 * arithmetic (p99 2.4e-13 over 70,994 tick comparisons). "Where does it end
 * up" has an exact answer and predictBallPath already returns it.
 *
 * Two things vary, and neither is physics:
 *
 *   1. The kick has not happened yet. While a player carries the ball it
 *      jostles against them, so ball.velocity changes every tick and the
 *      exact answer changes with it. The line swings. That is the truth
 *      moving, not error — smoothing it would be lying about how much the
 *      timing matters.
 *
 *   2. Someone else may touch the ball. Exact geometry, contingent on no
 *      interference — which argues for a SHORT horizon, not a long one.
 *
 * A dead ball has no jostle, so kickoffs and restarts give a prediction that
 * is exact and stable. That is also where people practise.
 *
 * ---------------------------------------------------------------------------
 * THE REACHABLE WEDGE
 *
 * Since a fixed-magnitude impulse is ADDED to the current velocity, the set
 * of achievable post-kick velocities is a circle of radius kickStrength
 * centred on ball.velocity, in velocity space. Therefore:
 *
 *   |v_ball| <  kickStrength   ->  every direction reachable (origin inside)
 *   |v_ball| == kickStrength   ->  origin sits ON the circle; the deviation
 *                                  collapses to exactly half the orientation
 *                                  angle, so the supremum is 90 degrees and
 *                                  is never actually attained
 *   |v_ball| >  kickStrength   ->  a wedge around the ball's heading, of
 *                                  half-angle asin(kickStrength/|v_ball|)
 *
 * MEASURED against the engine by sweeping the player all the way around the
 * ball at each speed (scripts/validate-aim-assist.mjs, check 3):
 *
 *   ball speed   0    3      5      6       8       12
 *   measured   180  180  89.50  56.44   38.68    24.62
 *   predicted  180  180  90.00  56.44   38.68    24.62
 *
 * 56.44 degrees at ball speed 6. No amount of orbiting escapes it, which is
 * why the ball can never be sent back past the player (DOMAIN.md § Kicking) —
 * that is the degenerate case of the same constraint.
 *
 * A caution that cost a debugging round: above ball speed ~4 the ball crosses
 * the 4-unit band and reaches the player's BODY within the same tick for
 * orientations in front of it, so those samples are a kick plus a disc-vs-disc
 * collision and deviate further than any kick can. They are not evidence
 * against the wedge; they are not kicks. The validator excludes them
 * explicitly rather than widening its tolerance.
 *
 * The wedge is computed and exposed here; it is NOT drawn by default. Note it
 * assumes the player can place themselves at any n-hat, which is an orbit
 * question and belongs to feat/orbit-cost, not here.
 *
 * ---------------------------------------------------------------------------
 * THE LEAD-IN BAND, AND WHY IT IS NOT JUST A BIGGER RADIUS
 *
 * Gating the cue strictly on kick range makes it useless for the case it is
 * most wanted in: lining a pass up BEFORE arriving, without nudging the ball.
 * The band where you can kick without touching is only 4 units wide, so by the
 * time the cue appeared the choice was already being made.
 *
 * So the cue is also drawn during the approach, out to
 *
 *   leadIn = kickRange + terminalSpeed * leadInTicks
 *
 * DERIVED, not picked: terminalSpeed is the player's own per-map top speed
 * (acceleration / (1 - damping), the same primitive momentumOverlay derives
 * and the reachable-zone work reuses), so the band is always the same number
 * of TICKS of approach on every map rather than a distance that means
 * different things at different accelerations. At the classic map's 2.5
 * units/tick and the default 30 ticks that is 75 units of run-up, about half a
 * second.
 *
 * WHAT THE CUE MEANS THERE IS DIFFERENT, AND THE DRAWING SAYS SO. Inside
 * range it answers "kick now and this happens". Outside it, nothing happens
 * now — it answers "if you were in range at this angle, this is where it would
 * go". For a ball at rest that is exactly true and stays true while you walk
 * up, which is the dead-ball case the request is really about. For a moving
 * ball it decays, because both bodies move before you arrive.
 *
 * That decay is why the cue FADES with distance rather than being drawn at
 * full strength, and why the swept corridor — a claim about clearance at the
 * moment of the kick — is suppressed until you are actually in range.
 *
 * THE LEAD-IN IS A DRAW DECISION, NOT A COMPUTE ONE. The band is always
 * computed; `showLineOutOfRange` only decides whether the cue LINE is drawn
 * while out of range. The halo below is deliberately NOT gated by it — the
 * halo answers "how close am I to being able to kick", which is a question
 * about proximity and is wanted whether or not the path preview is. Gating
 * them together would mean turning off the line also blinded the approach.
 *
 * ---------------------------------------------------------------------------
 * KICKABILITY GOES ON THE BALL, NOT IN A RING
 *
 * The range and contact thresholds are centre-to-centre, because that is what
 * the engine measures. But nobody reads the game that way: you watch the GAP
 * between the two bodies, not whether an invisible centre has crossed an
 * invisible threshold. A ring at radius 29 also looks far too big, because
 * your sprite's edge reaches it a whole player-radius before your centre does.
 *
 * So the state is drawn as a halo on the ball itself. The camera already
 * follows the ball, so it is the one thing guaranteed to be looked at — it
 * passes the attention filter for free, and it adds no new object to the
 * screen, it modifies one that is already there.
 *
 * TWO STATES, NOT A GRADIENT:
 *
 *   approaching  the kick does nothing yet
 *   ready        a kick is available
 *
 * A smooth red-to-green ramp would imply that being at gap 26 is a better
 * kick than gap 28.9. It is not — the impulse has NO distance falloff, which
 * is measured. Shading inside the band would be drawing a difference that
 * does not exist.
 *
 * What IS continuous is the approach, so the halo fades up with proximity
 * while out of range and then goes flat the instant a kick becomes available.
 * The change from ramping to constant is itself the signal that the threshold
 * was crossed.
 *
 * WHY CONTACT IS NOT A THIRD STATE. It was, briefly, and it was wrong twice
 * over. Crossing into contact does not change the kick — the impulse is
 * identical either way — so it reports something the player can no longer act
 * on: by the time it lights up, the ball has already been nudged. And while
 * dribbling the gap oscillates across the contact threshold every few ticks
 * as the ball rebounds off the body, so the cue chattered several times a
 * second. A flickering cue is worse than no cue (see the main README on
 * attention, and on hysteresis for topological events). Merged into `ready`.
 *
 * Hue is therefore not load-bearing at all: there is one colour and one
 * absence of it. Red/green as a pair is avoided outright.
 *
 * The centre-to-centre rings are still available behind `showRangeCircle`,
 * off by default — they answer "where do I stand", which is a different and
 * more spatial question than "can I kick yet".
 * ---------------------------------------------------------------------------
 */

import { predictBallPath } from "./ballTrajectory.js";
import { getCollisionSet } from "./ballTrajectoryOverlay.js";
import { estimateTerminalSpeed } from "./momentumOverlay.js";

/**
 * @typedef {{x:number,y:number}} Vec2
 */

/**
 * Width of the band between touching the ball and being out of kick range.
 *
 * VERIFIED CONSTANT, not a tuning knob: sweeping the ball radius over
 * 5/10/15/20/30 moved the boundary to 24/29/34/39/49 exactly, so the 4 is
 * additive and independent of both radii. The radii themselves are per-map,
 * so the range must be computed live and never hardcoded to 29.
 */
export const KICK_RANGE_MARGIN = 4;

/**
 * Default size of the lead-in band, in TICKS of approach (see the header).
 * Exported so the views and the validator read the same number instead of
 * each carrying their own copy with a "must match" comment.
 */
export const DEFAULT_LEAD_IN_TICKS = 30;

/**
 * Centre-to-centre distance below which this player can kick this ball.
 * EXCLUSIVE — at exactly this distance the kick does not fire.
 *
 * @param {number} playerRadius @param {number} ballRadius
 * @returns {number}
 */
export function kickRange(playerRadius, ballRadius) {
  return playerRadius + ballRadius + KICK_RANGE_MARGIN;
}

/**
 * Centre-to-centre distance at which the two bodies touch. Crossing this
 * disturbs the ball; the 4 units between here and `kickRange` are where a
 * kick can be taken without moving it first.
 *
 * @param {number} playerRadius @param {number} ballRadius
 * @returns {number}
 */
export function contactRange(playerRadius, ballRadius) {
  return playerRadius + ballRadius;
}

/**
 * Pick whose kick to preview.
 *
 * The decision-support case is the local player, so they win whenever they
 * are in range. But ReplayView has no local player (`currentPlayerId` is -1)
 * and the branch is developed against replays, so the fallback is whoever is
 * closest to the ball while still inside their own kick range. For review
 * that is arguably the more useful choice anyway — it follows the ball.
 *
 * The team filter is applied uniformly, including to the local player, so the
 * control reads as "whose aim am I looking at" rather than having a hidden
 * exception.
 *
 * @param {Array} players frame.players from extractFrame()
 * @param {{pos:Vec2, radius:number}} ball
 * @param {number} currentPlayerId room.currentPlayerId, or -1 on a replay
 * @param {"both"|1|2} team
 * @param {number} [leadIn=0] extra centre-to-centre distance beyond kick range
 *   to still consider, so the cue can be shown during the approach. 0 gives
 *   the strict in-range-only behaviour.
 * @returns {{player:Object, gap:number, range:number, contact:number,
 *            inRange:boolean}|null}
 */
export function findKicker(players, ball, currentPlayerId, team = "both", leadIn = 0) {
  let best = null;

  for (const p of players ?? []) {
    if (!p.inGame || !p.pos || p.radius == null) continue;
    if (team !== "both" && p.team !== team) continue;

    const gap = Math.hypot(ball.pos.x - p.pos.x, ball.pos.y - p.pos.y);
    if (gap === 0) continue;                      // degenerate: no direction
    const range = kickRange(p.radius, ball.radius);
    if (gap >= range + leadIn) continue;

    const found = {
      player: p, gap, range,
      contact: contactRange(p.radius, ball.radius),
      inRange: gap < range,                       // exclusive boundary
    };
    if (p.id === currentPlayerId) return found;
    if (!best || gap < best.gap) best = found;
  }

  return best;
}

/**
 * Compute the cue line. Call once per TICK from useHaxballAnalytics's onTick
 * seam — not from the rAF hook. Like the ball trace, the answer only changes
 * when the inputs change, and both inputs are tick-rate quantities.
 *
 * Reads positions from `frame` (extractFrame's output) rather than from the
 * room, so player discs, the ball and their radii all arrive already
 * normalized and there is no second convention to keep in sync.
 *
 * @param {Object} frame output of extractFrame()
 * @param {Object} geometry output of extractStadiumGeometry()
 * @param {*} geometryVersion cache key; pass `room.stadium` as the views do
 * @param {number} currentPlayerId room.currentPlayerId, or -1 on a replay
 * @param {Object} [options]
 * @param {"both"|1|2} [options.team="both"]
 * @param {number} [options.leadInTicks=DEFAULT_LEAD_IN_TICKS] ticks of approach beyond
 *   kick range the cue is still drawn for, converted to a distance using the
 *   player's own per-map terminal speed. 0 restores strict in-range-only.
 *   Expressed in ticks so it means the same amount of run-up on every map.
 * @param {number} [options.maxDistance=520] path horizon in MAP UNITS, not
 *   ticks. 520 is deliberate: a dead ball kicked at kickStrength 5 has a total
 *   remaining travel of |v|/(1-d) = 500 at the classic damping, so this horizon
 *   is just wide enough to always show where a standing ball comes to rest.
 *   Anything faster is truncated, which is the honest treatment — the far end
 *   of a long path is contingent on nobody else touching the ball.
 * @param {number} [options.maxTicks=600] safety bound. Must stay above ~390,
 *   the number of ticks a 5-speed ball needs to damp below stopSpeed, or the
 *   resting marker becomes unreachable — which is exactly the bug that shipped
 *   on feat/ball-trajectory.
 * @returns {{playerId:number, isLocal:boolean, isKicking:boolean,
 *            gap:number, range:number, contact:number, inRange:boolean,
 *            proximity:number, nHat:Vec2, vPost:Vec2,
 *            playerPos:Vec2, ballPos:Vec2, radius:number,
 *            points:Vec2[], bounces:Array, firstBounceIndex:number,
 *            stops:boolean, travelled:number,
 *            naiveDir:Vec2, wedgeHalfAngle:number|null,
 *            ballSpeed:number, kickStrength:number} | null}
 *   `inRange` is false while the player is still approaching — the geometry is
 *   real but the kick cannot fire yet, and `proximity` (1 at the boundary, 0
 *   at the outer edge) is how much the draw layer should fade it.
 *   null whenever there is nothing honest to draw: no ball, no geometry, no
 *   player within range plus the lead-in band, or a stadium that does not
 *   declare kickStrength.
 */
export function computeAimAssist(
  frame,
  geometry,
  geometryVersion,
  currentPlayerId,
  options = {},
) {
  const {
    team = "both",
    maxDistance = 520,
    maxTicks = 600,
    leadInTicks = DEFAULT_LEAD_IN_TICKS,
  } = options;

  const ball = frame?.ball;
  if (!ball || !geometry) return null;

  // Per-map, never assumed. A stadium that does not declare it gets no
  // overlay rather than a plausible-looking wrong one.
  const kickStrength = geometry.playerPhysics?.kickStrength;
  if (!Number.isFinite(kickStrength)) return null;

  // Derived from the map's own player physics, so the run-up is the same
  // number of ticks everywhere rather than the same number of units.
  const terminalSpeed = estimateTerminalSpeed(geometry.playerPhysics);
  const leadIn = Math.max(0, terminalSpeed * leadInTicks);

  const found = findKicker(frame.players, ball, currentPlayerId, team, leadIn);
  if (!found) return null;
  const { player, gap, range, contact, inRange } = found;

  // 1 at the kick-range boundary, falling to 0 at the outer edge of the
  // lead-in band. The draw layer fades with this: outside range the cue is a
  // statement about a kick that cannot happen yet, and it should not look as
  // confident as one that can.
  const proximity = inRange || leadIn <= 0
    ? 1
    : Math.max(0, Math.min(1, (range + leadIn - gap) / leadIn));

  // n-hat points player -> ball. Because both bodies are circles the contact
  // point always lies on this line, so "centre through contact point" and
  // "centre through ball centre" are the same ray, and this needs no contact
  // detection.
  const nHat = {
    x: (ball.pos.x - player.pos.x) / gap,
    y: (ball.pos.y - player.pos.y) / gap,
  };

  const vPost = {
    x: ball.vel.x + kickStrength * nHat.x,
    y: ball.vel.y + kickStrength * nHat.y,
  };

  const set = getCollisionSet(geometry, geometryVersion, {
    radius: ball.radius,
    bCoef: ball.bCoef,
    damping: ball.damping,
    cMask: ball.cMask,
    cGroup: ball.cGroup,
  });

  const trace = predictBallPath(
    {
      pos: { x: ball.pos.x, y: ball.pos.y },
      vel: vPost,
      radius: ball.radius,
      bCoef: ball.bCoef,
      damping: ball.damping,
    },
    set,
    maxTicks,
    { maxDistance },
  );

  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y);

  return {
    playerId: player.id,
    isLocal: player.id === currentPlayerId,
    // Already holding the kick: it is ARMED and will fire on the first tick
    // the ball is in range, so this prediction is about to become the actual
    // path rather than a hypothetical one. Worth a visual distinction.
    isKicking: !!player.isKicking,
    gap,
    range,
    contact,
    inRange,
    proximity,
    nHat,
    vPost,
    playerPos: { x: player.pos.x, y: player.pos.y },
    ballPos: { x: ball.pos.x, y: ball.pos.y },
    radius: ball.radius,
    points: trace.points,
    bounces: trace.bounces,
    firstBounceIndex: trace.bounces.length ? trace.bounces[0].index : -1,
    stops: trace.stopped,
    travelled: trace.travelled,
    // The wrong answer, kept so a training mode can show the gap between
    // intuition and physics. Never drawn as the prediction.
    naiveDir: nHat,
    wedgeHalfAngle: ballSpeed > kickStrength ? Math.asin(kickStrength / ballSpeed) : null,
    ballSpeed,
    kickStrength,
  };
}

/**
 * Draw the cue line. Call every rendered frame from the same rAF hook the
 * other overlays draw from, with the same transform.
 *
 * VISUAL SEPARATION IS NOT COSMETIC HERE. ballTrajectoryOverlay draws the
 * ball's ACTUAL path in solid gold from almost the same origin. This is a
 * COUNTERFACTUAL path. Two similar lines from one point with opposite
 * epistemic status is genuinely confusing, so this one is cyan and dashed:
 * dashes read as provisional, and the hue separation survives colour-blind
 * viewing better than a second warm colour would.
 *
 * `transform.ballPos` should be the extrapolated ball position from the frame
 * the renderer just drew, for the same reason drawBallTrace wants it — the
 * trace is computed at tick rate, so without it the line starts up to a full
 * ball-diameter away from the sprite it belongs to.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof computeAimAssist>} aim
 * @param {{cameraOrigin:Vec2, cameraScale:number, canvasWidth:number,
 *          canvasHeight:number, ballPos?:Vec2}} transform
 * @param {Object} [style]
 * @param {boolean} [style.showCorridor=true] sweep the path at true ball
 *   width. This is what answers "does the ball FIT", which a hairline cannot.
 *   Suppressed automatically while out of range — clearance is a claim about
 *   the moment of the kick, and it is the heaviest thing on screen.
 * @param {boolean} [style.showRangeCircle=true] the kick-range and contact
 *   circles, drawn around the BALL. The annulus between them is the band
 *   where a kick can be taken without disturbing the ball, which is what a
 *   run-up is aiming for.
 * @param {"ball"|"player"} [style.rangeAnchor="ball"] which body the circles
 *   are centred on. The distance is symmetric, so this only changes what the
 *   question reads as: around the ball it is "where do I need to stand",
 *   around the player it is "how close is the ball to being kickable".
 * @param {boolean} [style.showNaiveRay=false] the facing ray, for training.
 *   OFF by default: live it is a second line saying something false.
 * @param {boolean} [style.showLineOutOfRange=true] whether the cue LINE is
 *   drawn during the approach. False keeps the path preview to actual kick
 *   range — but the ball halo still shows, because how close you are to being
 *   able to kick is a different question from where the ball would go.
 * @param {number} [style.minAlpha=0.30] opacity at the far edge of the
 *   lead-in band. The cue ramps from here to full at the range boundary.
 */
export function drawAimAssist(ctx, aim, transform, style = {}) {
  if (!aim || aim.points.length < 1) return;

  const { cameraOrigin, cameraScale, canvasWidth, canvasHeight, ballPos } = transform;
  const {
    lineColor = "#3ad9ff",
    armedColor = "#7dfcc4",
    corridorColor = "rgba(58, 217, 255, 0.10)",
    rangeColor = "rgba(58, 217, 255, 0.75)",
    bandFill = "rgba(58, 217, 255, 0.11)",
    naiveColor = "rgba(255, 92, 92, 0.45)",
    bounceColor = "#3ad9ff",
    stopColor = "#7dfcc4",
    lineWidth = 2,
    dash = [7, 5],
    bounceRadiusPx = 3.5,
    contactColor = "rgba(255, 145, 90, 0.80)",
    showCorridor = true,
    showBallState = true,
    readyColor = "#5ef08a",
    approachColor = "rgba(230, 240, 255, 0.9)",
    showRangeCircle = false,
    rangeAnchor = "ball",
    showNaiveRay = false,
    showLineOutOfRange = true,
    minAlpha = 0.30,
  } = style;

  const toX = (x) => (x - cameraOrigin.x) * cameraScale + canvasWidth / 2;
  const toY = (y) => (y - cameraOrigin.y) * cameraScale + canvasHeight / 2;

  // Start under the ball sprite rather than at the tick position it has
  // already left.
  const origin = ballPos ? { x: ballPos.x, y: ballPos.y } : aim.ballPos;
  const points = [origin, ...aim.points];

  // Armed means the kick is already bought and fires on the next in-range
  // tick, so the line is about to stop being hypothetical.
  const mainColor = aim.isKicking ? armedColor : lineColor;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const prox = aim.proximity ?? 1;

  // --- kickability, drawn on the ball ---------------------------------------
  // Full strength and before the distance fade: this is a fact about right
  // now, not a claim about a kick that has not happened.
  if (showBallState) {
    const bc = ballPos ?? aim.ballPos;
    const cx = toX(bc.x), cy = toY(bc.y);
    const haloR = (aim.radius + 3) * cameraScale;

    ctx.lineWidth = Math.max(2, 3 * cameraScale);
    ctx.setLineDash([]);
    if (aim.inRange !== false) {
      // A kick is available. CONSTANT — neither the distance within the band
      // nor whether the bodies are touching changes the impulse, so the cue
      // must not imply either does. Holding it steady is also what stops it
      // chattering while the ball rebounds off the player during a dribble.
      ctx.strokeStyle = readyColor;
      ctx.globalAlpha = 1;
    } else {
      // Still approaching. Here distance IS meaningful, so this one ramps.
      ctx.strokeStyle = approachColor;
      ctx.globalAlpha = 0.12 + 0.5 * prox;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  // --- the band you are aiming to stand in ----------------------------------
  // Drawn FIRST and at full strength, deliberately OUTSIDE the distance fade
  // below. The fade exists because the cue line describes a kick that cannot
  // happen yet; this band is not a claim about a kick at all, it is plain
  // geometry — and it matters most during the approach, which is precisely
  // when the fade would have hidden it.
  //
  // It is filled as an annulus rather than stroked as two circles. Two 1px
  // dashed hairlines 4 units apart read as one thick line at best and as
  // nothing at all over a textured pitch; a tinted ring reads as a place to
  // stand, which is what it is.
  if (showRangeCircle && Number.isFinite(aim.contact)) {
    const anchor = rangeAnchor === "player" ? aim.playerPos : (ballPos ?? aim.ballPos);
    const cx = toX(anchor.x), cy = toY(anchor.y);
    const outer = aim.range * cameraScale;
    const inner = aim.contact * cameraScale;

    ctx.setLineDash([]);
    ctx.fillStyle = bandFill;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);   // reverse winding = hole
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = rangeColor;                    // outer: can kick inside this
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = contactColor;                  // inner: touching it from here
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Everything from here is the path preview. With the lead-in switched off
  // that stops at the kick-range boundary — but the halo above has already
  // been drawn, so the approach is still readable.
  if (aim.inRange === false && !showLineOutOfRange) {
    ctx.restore();
    return;
  }

  // Out of range the cue describes a kick that cannot happen yet, so it is
  // drawn weaker the further away the player is. Full strength is reserved
  // for a claim that is true right now.
  ctx.globalAlpha = aim.inRange === false ? minAlpha + (1 - minAlpha) * prox : 1;

  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(toX(points[0].x), toY(points[0].y));
    for (let i = 1; i < points.length; i++) ctx.lineTo(toX(points[i].x), toY(points[i].y));
  };

  // --- the facing ray, only in training mode --------------------------------
  // Drawn as what a player intuitively expects, so the gap to the real path
  // is visible. It is deliberately the odd colour out: it is the wrong answer.
  if (showNaiveRay) {
    const len = Math.max(60, aim.travelled);
    ctx.setLineDash([2, 6]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = naiveColor;
    ctx.beginPath();
    ctx.moveTo(toX(origin.x), toY(origin.y));
    ctx.lineTo(toX(origin.x + aim.naiveDir.x * len), toY(origin.y + aim.naiveDir.y * len));
    ctx.stroke();
  }

  // --- the swept corridor, at the ball's true width -------------------------
  // Stroking the centre polyline at 2*radius with round caps/joins is exactly
  // the Minkowski sum of the path with the ball disc, so this is the region
  // the ball body would occupy — not a decorative thickening.
  // Suppressed during the approach: it is a clearance claim about the kick,
  // and it is the heaviest element on screen.
  const corridorPx = 2 * aim.radius * cameraScale;
  if (showCorridor && aim.inRange !== false && corridorPx > 1 && points.length > 1) {
    ctx.setLineDash([]);
    ctx.lineWidth = corridorPx;
    ctx.strokeStyle = corridorColor;
    tracePath();
    ctx.stroke();
  }

  // --- the cue line ---------------------------------------------------------
  if (points.length > 1) {
    ctx.setLineDash(dash);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = mainColor;
    tracePath();
    ctx.stroke();
  }

  ctx.setLineDash([]);

  for (const b of aim.bounces) {
    ctx.fillStyle = bounceColor;
    ctx.beginPath();
    ctx.arc(toX(b.pos.x), toY(b.pos.y), bounceRadiusPx, 0, Math.PI * 2);
    ctx.fill();
  }

  // Where the ball would actually come to rest. Only meaningful when it
  // genuinely stops inside the horizon — otherwise this is just where the
  // drawn line ran out, which is a different claim.
  if (aim.stops && points.length > 1) {
    const end = points[points.length - 1];
    ctx.strokeStyle = stopColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toX(end.x), toY(end.y), Math.max(3, aim.radius * cameraScale), 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
