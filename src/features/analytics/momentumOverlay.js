/**
 * momentumOverlay.js
 *
 * Direction-only momentum indicators for in-game players and the ball.
 * Deliberately NOT wired through useHaxballAnalytics's tick-rate pipeline —
 * this needs to be recomputed every RENDERED frame from the same
 * extrapolated room state the game renderer itself just drew, or the
 * arrows will visibly lag/desync from the moving circles. See renderer.js's
 * onRequestAnimationFrame hook (fires post-render, once per rAF) and its
 * exposed `cameraOrigin`/`cameraScale` for the transform this relies on.
 *
 * Speed magnitude is intentionally NOT used for arrow length — arrows are a
 * fixed screen length, direction-only. Whether something gets an arrow at
 * all is still gated by speed, but the threshold is derived from the
 * CURRENT stadium's own playerPhysics (acceleration/damping), not a
 * hardcoded constant — these differ per map, so a fixed number would be
 * too sensitive on some maps and too lax on others.
 */

/**
 * Rough steady-state running speed for the given player physics, used only
 * to scale a sensible "clearly moving" threshold. Derived from the
 * discrete damping model: v_(n+1) = v_n * damping + acceleration, which
 * converges to v = acceleration / (1 - damping).
 */
export function estimateTerminalSpeed(playerPhysics) {
  const { acceleration = 0, damping = 1 } = playerPhysics ?? {};
  const denom = 1 - damping;
  if (denom <= 0) return 0;
  return acceleration / denom;
}

/**
 * @param {Object} playerPhysics stadium.playerPhysics for the CURRENT map (read live, not cached)
 * @param {number} [fraction=0.10] fraction of estimated terminal speed to use as the "moderate" cutoff
 */
export function estimateModerateSpeedThreshold(playerPhysics, fraction = 0.10) {
  return estimateTerminalSpeed(playerPhysics) * fraction;
}

/**
 * Ball has no acceleration/damping-driven "terminal speed" the way players
 * do (it's not self-propelled — it only decelerates via damping unless
 * kicked), so there's no equivalent physics derivation. Reuses the same
 * per-map reference speed (player terminal speed) as a sensible scale, just
 * with a much smaller default fraction — the ball should get an arrow for
 * almost any real movement, this just filters out near-zero damping residue.
 *
 * @param {Object} playerPhysics stadium.playerPhysics for the CURRENT map (read live, not cached)
 * @param {number} [fraction=0.05]
 */
export function estimateBallSpeedThreshold(playerPhysics, fraction = 0.05) {
  return estimateTerminalSpeed(playerPhysics) * fraction;
}

/**
 * @param {import("node-haxball").RoomState} extrapolatedRoomState result of room.extrapolate(ms, true)
 * @param {number} speedThreshold players below this speed get no direction at all
 * @param {"both"|1|2} [teamFilter="both"] restrict to red (1), blue (2), or both.
 *   This is the shared team filter every overlay feature reads — not
 *   momentum-specific. Spectators (team 0) are never included regardless.
 * @returns {Array<{ playerId:number, team:number, pos:{x:number,y:number}, dir:{x:number,y:number} }>}
 *   dir is a unit vector; array only contains players currently in-game, on
 *   the selected team(s), and above threshold.
 */
export function getMomentumDirections(extrapolatedRoomState, speedThreshold, teamFilter = "both") {
  const results = [];
  const players = extrapolatedRoomState?.players ?? [];

  for (const p of players) {
    const disc = p.disc;
    if (!disc) continue; // spectator / not in game

    const teamId = p.team?.id ?? 0;
    if (teamFilter !== "both" && teamId !== teamFilter) continue;

    const vx = disc.speed.x;
    const vy = disc.speed.y;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed < speedThreshold) continue;

    results.push({
      playerId: p.id,
      team: teamId,
      pos: { x: disc.pos.x, y: disc.pos.y },
      dir: { x: vx / speed, y: vy / speed },
    });
  }

  return results;
}

/**
 * @param {import("node-haxball").RoomState} extrapolatedRoomState result of room.extrapolate(ms, true)
 * @param {number} speedThreshold below this speed, no direction is returned
 * @returns {{pos:{x:number,y:number}, dir:{x:number,y:number}, isBall:true} | null}
 *   null if the ball is below threshold or unavailable (game not running).
 *
 * Ball access note: there's no `getBall()`-equivalent on RoomState (only
 * `getPlayer(id)`). The renderer itself reads the ball as
 * `gameState.physicsState.discs[0]` — disc index 0 is always the ball, per
 * Haxball's own convention (confirmed against renderer.js's own ballDisc
 * usage, and GameState.physicsState: World in node-haxball's type
 * declarations) — so we use the exact same documented path.
 */
export function getBallMomentumDirection(extrapolatedRoomState, speedThreshold) {
  const ball = extrapolatedRoomState?.gameState?.physicsState?.discs?.[0];
  if (!ball) return null;

  const vx = ball.speed.x;
  const vy = ball.speed.y;
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed < speedThreshold) return null;

  return {
    pos: { x: ball.pos.x, y: ball.pos.y },
    dir: { x: vx / speed, y: vy / speed },
    isBall: true,
  };
}

/**
 * Draws fixed-length direction arrows on a 2D canvas context already sized
 * to canvasWidth x canvasHeight in the SAME logical-pixel space the game
 * renderer uses (see resizeCanvas()'s `logicalWidth`/`logicalHeight` in
 * renderer.js — CSS pixels, not raw devicePixelRatio-scaled backing-store
 * pixels; the caller is responsible for a matching ctx.scale(dpr, dpr)).
 *
 * Items tagged `isBall: true` (from getBallMomentumDirection) are drawn
 * with the ball* style overrides instead of the player defaults, so the
 * ball's arrow is visually distinct at a glance.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{pos:{x:number,y:number}, dir:{x:number,y:number}, isBall?:boolean}>} directions
 * @param {{cameraOrigin:{x:number,y:number}, cameraScale:number, canvasWidth:number, canvasHeight:number}} transform
 * @param {{lengthPx?:number, color?:string, lineWidth?:number, ballLengthPx?:number, ballColor?:string, ballLineWidth?:number}} [style]
 */
export function drawMomentumArrows(ctx, directions, transform, style = {}) {
  const { cameraOrigin, cameraScale, canvasWidth, canvasHeight } = transform;
  const {
    lengthPx = 22,
    color = "#4fe8ff",
    lineWidth = 5,
    ballLengthPx = 22,
    ballColor = "#ffd700", // gold — visually distinct from the default player white
    ballLineWidth = 5,
  } = style;

  ctx.save();
  ctx.lineCap = "round";

  for (const item of directions) {
    const { pos, dir, isBall } = item;
    const itemLengthPx = isBall ? ballLengthPx : lengthPx;
    const itemColor = isBall ? ballColor : color;
    const itemLineWidth = isBall ? ballLineWidth : lineWidth;

    ctx.strokeStyle = itemColor;
    ctx.fillStyle = itemColor;
    ctx.lineWidth = itemLineWidth;

    const screenX = (pos.x - cameraOrigin.x) * cameraScale + canvasWidth / 2;
    const screenY = (pos.y - cameraOrigin.y) * cameraScale + canvasHeight / 2;

    const tipX = screenX + dir.x * itemLengthPx;
    const tipY = screenY + dir.y * itemLengthPx;

    // shaft
    ctx.beginPath();
    ctx.moveTo(screenX, screenY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // arrowhead (small triangle at the tip, oriented along dir)
    const headLen = 7;
    const headAngle = Math.PI / 6.5; // ~27.7deg half-angle
    const baseAngle = Math.atan2(dir.y, dir.x);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - headLen * Math.cos(baseAngle - headAngle),
      tipY - headLen * Math.sin(baseAngle - headAngle)
    );
    ctx.lineTo(
      tipX - headLen * Math.cos(baseAngle + headAngle),
      tipY - headLen * Math.sin(baseAngle + headAngle)
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}
