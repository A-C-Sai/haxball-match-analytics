/**
 * gameStateExtractor.js
 *
 * The one seam between node-haxball internals and your analytics code
 * (LOS / heatmaps / passing lanes). Field names here are taken directly
 * from node-haxball's own type declarations (node_modules/node-haxball/src/index.d.ts)
 * — Disc/MovableDisc, Player, Stadium, Vertex, Segment, Plane, Goal,
 * PlayerPhysics — not guessed, so this should match the live objects exactly.
 *
 * Physics note: segments/planes are zero-width collision lines. There is no
 * "wall thickness" field anywhere in the stadium data — the effective
 * collision boundary for a disc of radius r approaching a segment/plane is
 * that segment/plane's own position offset outward by r (subject to that
 * segment's cMask/cGroup matching the disc's cGroup/cMask). Bake that into
 * your LOS/collision math rather than looking for a thickness value.
 */

// ---------- stadium geometry (call once on join + on stadium change) ----------

/**
 * @typedef {{x:number,y:number}} Vec2
 */

/**
 * @param {import("node-haxball").Room} room
 */
export function extractStadiumGeometry(room) {
  const s = room.stadium;
  if (!s) return null;

  const vertices = s.vertices.map((v) => ({
    id: v.id,
    pos: { x: v.pos.x, y: v.pos.y },
    bCoef: v.bCoef,
    cMask: v.cMask,
    cGroup: v.cGroup,
  }));

  const segments = s.segments.map((seg) => ({
    v0: { x: seg.v0.pos.x, y: seg.v0.pos.y },
    v1: { x: seg.v1.pos.x, y: seg.v1.pos.y },
    bCoef: seg.bCoef,
    vis: seg.vis,
    curveF: seg.curveF,
    normal: seg.normal ? { x: seg.normal.x, y: seg.normal.y } : null,
    cMask: seg.cMask,
    cGroup: seg.cGroup,
  }));

  const planes = s.planes.map((p) => ({
    normal: { x: p.normal.x, y: p.normal.y },
    dist: p.dist,
    bCoef: p.bCoef,
    cMask: p.cMask,
    cGroup: p.cGroup,
  }));

  const goals = s.goals.map((g) => ({
    p0: { x: g.p0.x, y: g.p0.y },
    p1: { x: g.p1.x, y: g.p1.y },
    team: g.team?.id ?? null, // 1 = red, 2 = blue
  }));

  const pp = s.playerPhysics ?? {};

  return {
    name: s.name,
    width: s.width,
    height: s.height,
    bgWidth: s.bgWidth,
    bgHeight: s.bgHeight,
    bgKickOffRadius: s.bgKickOffRadius,
    bgCornerRadius: s.bgCornerRadius,
    bgGoalLine: s.bgGoalLine,
    vertices,
    segments,
    planes,
    goals,
    redSpawnPoints: (s.redSpawnPoints ?? []).map((p) => ({ x: p.x, y: p.y })),
    blueSpawnPoints: (s.blueSpawnPoints ?? []).map((p) => ({ x: p.x, y: p.y })),
    playerPhysics: {
      radius: pp.radius,
      bCoef: pp.bCoef,
      invMass: pp.invMass,
      damping: pp.damping,
      kickingDamping: pp.kickingDamping,
      acceleration: pp.acceleration,
      kickingAcceleration: pp.kickingAcceleration,
      kickStrength: pp.kickStrength,
      kickback: pp.kickback,
      cGroup: pp.cGroup,
      gravity: pp.gravity ? { x: pp.gravity.x, y: pp.gravity.y } : { x: 0, y: 0 },
    },
    checksum: safeChecksum(s),
  };
}

function safeChecksum(stadium) {
  try {
    return stadium.calculateChecksum();
  } catch {
    return null;
  }
}

// ---------- per-tick frame (call from onAfterGameTick) ----------

/** Normalizes a Disc/MovableDisc into a flat shape. */
function normalizeDisc(disc) {
  if (!disc) return null;
  return {
    pos: { x: disc.pos.x, y: disc.pos.y },
    vel: { x: disc.speed.x, y: disc.speed.y },
    gravity: { x: disc.gravity.x, y: disc.gravity.y },
    radius: disc.radius,
    bCoef: disc.bCoef,
    invMass: disc.invMass,
    mass: disc.invMass > 0 ? 1 / disc.invMass : Infinity,
    damping: disc.damping,
    cMask: disc.cMask,
    cGroup: disc.cGroup,
  };
}

/**
 * @param {import("node-haxball").Room} room
 * @param {{extrapolateMs?: number}} [opts]
 */
export function extractFrame(room, opts = {}) {
  const { extrapolateMs = 0 } = opts;
  if (extrapolateMs > 0) room.extrapolate(extrapolateMs);
  const useExt = extrapolateMs > 0;

  const players = room.players.map((p) => {
    const disc = room.getPlayerDisc(p.id, useExt);
    const normalized = normalizeDisc(disc);
    return {
      id: p.id,
      name: p.name,
      team: p.team?.id ?? 0, // 0 spec, 1 red, 2 blue
      isAdmin: p.isAdmin,
      isKicking: p.isKicking,
      input: p.input,
      inGame: normalized !== null,
      pos: normalized?.pos ?? null,
      vel: normalized?.vel ?? null,
      radius: normalized?.radius ?? null,
      bCoef: normalized?.bCoef ?? null,
    };
  });

  const ball = normalizeDisc(room.getBall(useExt));

  return {
    frameNo: room.currentFrameNo,
    timestampMs: Date.now(),
    players,
    ball,
    redScore: room.redScore,
    blueScore: room.blueScore,
    timeElapsed: room.timeElapsed,
  };
}
