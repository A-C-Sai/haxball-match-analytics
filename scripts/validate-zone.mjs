/**
 * validate-zone.mjs
 *
 * Offline check of the reachable-zone formula against a recorded session.
 *
 * For every player and every pair of frames (t, t+N) it computes the predicted
 * reachable zone at t and asks whether the player's ACTUAL position at t+N
 * falls inside it. The zone is an upper bound on reachability, so:
 *
 *   - inside  = formula is consistent with what happened (expected)
 *   - outside = the player went somewhere the formula says was impossible,
 *               which means the formula, the physics constants, or the
 *               assumption about which damping applies is wrong
 *
 * A containment rate at or very near 100% in open space is the pass condition.
 * Near walls the zone still contains the player (walls only ever REMOVE
 * reachable area), so failures there are just as meaningful — they are
 * reported separately only because overshoot statistics are less informative
 * when a wall is doing the limiting.
 *
 * Usage:
 *   node scripts/validate-zone.mjs <session.ndjson> [--ticks 3] [--limit 200000]
 */

import fs from "fs";

// ---------- CLI ----------

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const N = flag("ticks", 3);
const LIMIT = flag("limit", 200000);
/** --worst K prints the K worst contact-free windows in full, for diagnosis. */
const WORST = flag("worst", 0);

if (!filePath) {
  console.error("usage: node scripts/validate-zone.mjs <session.ndjson> [--ticks N] [--limit M]");
  process.exit(1);
}

// ---------- zone maths ----------

/**
 * The engine's per-tick order, established empirically from a recorded
 * session (see scripts/diagnose-physics.mjs):
 *
 *     v += a * u        1. apply the input force
 *     p += v            2. integrate position on the PRE-damping velocity
 *     v *= d            3. damp
 *
 * `disc.speed` is therefore sampled post-damping, while the displacement that
 * produced the recorded position used the pre-damping value. Two consequences
 * confirmed in the data:
 *
 *   - fitting |v(t+1) - v(t)*d| on input frames yields a*d, not a
 *   - p(t+1) - p(t) equals v(t+1)/d, leaving a residual of |v|*(1/d - 1)
 *     against v(t+1) — 0.0817 at the observed median speed of 1.96
 *
 * Writing w_k for the displacement at tick k:
 *
 *     w_k = v_(k-1) + a*u_k        and       v_k = d * w_k
 *
 * so w_k = d^(k-1) * v_0 + a * sum_(j=1..k) d^(k-j) * u_j, and summing over
 * N ticks gives a momentum term plus an input term that is direction-free.
 */

/** Sum of d^i for i = 1..n. Used by the radius. */
function dampedSum(d, n) {
  if (d >= 1) return n;
  return (d * (1 - Math.pow(d, n))) / (1 - d);
}

/**
 * Momentum carry over n ticks: sum of d^(k-1) for k = 1..n.
 *
 * Note this has NO leading factor of d — position integrates before damping,
 * so the first tick carries the full current velocity. An earlier version
 * used the damped sum here and under-predicted drift by exactly 1/d (4.17% at
 * d = 0.96), which is what produced a mean overshoot of 1.226.
 */
function momentumFactor(d, n) {
  if (d >= 1) return n;
  return (1 - Math.pow(d, n)) / (1 - d);
}

/**
 * Circumradius of the reachable octagon after n ticks.
 *   R_N = a/(1-d) * [ N - sum_(i=1..N) d^i ]
 *
 * Unchanged by the ordering correction: the input term's coefficients are the
 * same either way. `a` is the DECLARED acceleration, not the a*d that a naive
 * fit recovers.
 */
function zoneRadius(a, d, n) {
  if (d >= 1) return a * n;
  return (a / (1 - d)) * (n - dampedSum(d, n));
}

/**
 * Centre of the reachable zone after n ticks: current position carried
 * forward by momentum alone. Direction-independent.
 */
function zoneCentre(pos, vel, d, n) {
  const s = momentumFactor(d, n);
  return { x: pos.x + vel.x * s, y: pos.y + vel.y * s };
}

/**
 * Containment in a regular octagon of circumradius R, centred at the origin,
 * with vertices on the eight input directions (axis-aligned + diagonals).
 *
 * Edge normals sit at 22.5deg + k*45deg, and the support distance along each is
 * R*cos(pi/8). A point is inside iff it satisfies all eight half-planes.
 *
 * Returns the overshoot ratio: <= 1 is inside, > 1 is outside, and the value
 * is how far past the boundary the point sits as a multiple of it.
 */
const COS_PI_8 = Math.cos(Math.PI / 8);
const NORMALS = Array.from({ length: 8 }, (_, k) => {
  const ang = Math.PI / 8 + (k * Math.PI) / 4;
  return { x: Math.cos(ang), y: Math.sin(ang) };
});

function octagonOvershoot(dx, dy, R) {
  if (R <= 0) return Math.hypot(dx, dy) > 1e-9 ? Infinity : 0;
  const bound = R * COS_PI_8;
  let worst = 0;
  for (const n of NORMALS) {
    const proj = dx * n.x + dy * n.y;
    if (proj / bound > worst) worst = proj / bound;
  }
  return worst;
}

// ---------- wall proximity ----------

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Only segments that actually collide with PLAYERS count as a wall here.
 *
 * On many maps the pitch boundary accepts the ball but not players — the ball
 * cannot leave, while players run straight through. A segment like that is a
 * wall for the ball and empty space for a player, so including it would
 * mis-classify perfectly ordinary movement as wall-constrained.
 *
 * Collision needs both directions to match:
 *   ((a.cMask & b.cGroup) > 0) && ((b.cMask & a.cGroup) > 0)
 * A player disc's cGroup carries its team bit (red = 2, blue = 4), so a
 * segment blocks players only if its cMask accepts one of those.
 */
/**
 * A cMask of 0 means UNSPECIFIED, which in Haxball's stadium format means
 * "all" — not "nothing". Determined empirically: "K Futsal Huge 6v" carries
 * segments at x = +/-420 with cMask 0, and players are observed stopping dead
 * at x = +/-405, exactly one player radius short of them.
 *
 * Reading 0 as "collides with nothing" inverts the most permissive boundaries
 * on a map into invisible ones, which is the worst possible direction for the
 * error: geometry that stops things silently disappears from the model.
 */
const CMASK_ALL = 63;
const effectiveMask = (m) => (m === 0 || m == null ? CMASK_ALL : m);

const TEAM_BITS = 2 | 4;

function playerBlockingSegments(segments) {
  return segments.filter((s) => (effectiveMask(s.cMask) & TEAM_BITS) !== 0);
}

/**
 * Planes are infinite half-space boundaries — `normal . p = dist` — and are
 * what pitch boundaries are usually built from. Omitting them was why wall
 * contacts at |x| = 405 were being filed as open space.
 */
function playerBlockingPlanes(planes) {
  return (planes ?? []).filter((p) => (effectiveMask(p.cMask) & TEAM_BITS) !== 0);
}

function pointPlaneDistance(px, py, plane) {
  const nx = plane.normal?.x ?? 0;
  const ny = plane.normal?.y ?? 0;
  const len = Math.hypot(nx, ny);
  if (len < 1e-9) return Infinity;
  return Math.abs((px * nx + py * ny) / len - plane.dist / len);
}

/**
 * Static stadium discs — goal posts, and on custom maps whole barriers built
 * out of discs. Easy to overlook because "wall" suggests segments and planes,
 * but a map can stop a player with geometry that appears in neither.
 * Index 0 is the ball's template disc, not an obstacle.
 */
function playerBlockingDiscs(discs) {
  return (discs ?? []).filter((d) => d.index !== 0 && (effectiveMask(d.cMask) & TEAM_BITS) !== 0);
}

/** Distance to the nearest boundary that actually blocks players. */
function nearestBoundaryDistance(pos, segments, planes, discs) {
  let best = Infinity;
  for (const s of segments) {
    // Curved segments are approximated by their chord here. Only used to
    // classify "near a wall", never to compute the zone itself.
    const dist = pointSegmentDistance(pos.x, pos.y, s.v0.x, s.v0.y, s.v1.x, s.v1.y);
    if (dist < best) best = dist;
  }
  for (const p of planes) {
    const dist = pointPlaneDistance(pos.x, pos.y, p);
    if (dist < best) best = dist;
  }
  for (const d of discs) {
    const dist = Math.max(0, Math.hypot(pos.x - d.pos.x, pos.y - d.pos.y) - (d.radius ?? 0));
    if (dist < best) best = dist;
  }
  return best;
}

// ---------- load ----------

const geometryByVersion = new Map();
/** geometryVersion -> Map(frameNo -> frame) */
const framesByVersion = new Map();
/**
 * frameNo -> Set(playerId) for every player involved in a collision on that
 * tick. The zone bounds SELF-PROPELLED motion; a collision injects momentum
 * from outside the model, so those windows are measured separately rather
 * than counted as failures of the formula.
 */
const collisionsByFrame = new Map();
/** Non-collision events (kicks, goals, resets), kept for failure analysis. */
const discreteEvents = [];

const noteCollision = (frameNo, playerId) => {
  if (frameNo == null || playerId == null) return;
  let set = collisionsByFrame.get(frameNo);
  if (!set) collisionsByFrame.set(frameNo, (set = new Set()));
  set.add(playerId);
};

const text = fs.readFileSync(filePath, "utf8");
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue; // a truncated final line is normal if the app was killed
  }
  if (record.type === "geometry") {
    geometryByVersion.set(record.geometryVersion, record);
  } else if (record.type === "frame") {
    let byNo = framesByVersion.get(record.geometryVersion);
    if (!byNo) framesByVersion.set(record.geometryVersion, (byNo = new Map()));
    byNo.set(record.frameNo, record);
  } else if (record.type === "event") {
    if (record.event?.startsWith("collision")) {
      noteCollision(record.frameNo, record.discPlayerId);
      noteCollision(record.frameNo, record.discPlayerId1);
      noteCollision(record.frameNo, record.discPlayerId2);
    } else {
      discreteEvents.push(record);
    }
  }
}

/**
 * Frame ranges where the game is not really being played, derived from EVENTS
 * rather than from playState.
 *
 * Events are facts; state is an interpretation. Gating on state alone assumes
 * the engine flips to AfterGoal on the exact tick the goal fires. The real
 * dead window runs from `teamGoal` until the following `positionsReset` or
 * `kickOff` — players keep drifting through it and are then teleported.
 *
 * `gameStart` is deliberately NOT required to open play: a replay that begins
 * mid-game never fires it, so anything keyed off it silently does nothing.
 */
function deadRangesFromEvents(events) {
  const ordered = events.filter((e) => e.frameNo != null).sort((a, b) => a.frameNo - b.frameNo);
  const ranges = [];
  let openedAt = null;
  for (const e of ordered) {
    if (e.event === "teamGoal" && openedAt === null) {
      openedAt = e.frameNo;
    } else if ((e.event === "positionsReset" || e.event === "kickOff") && openedAt !== null) {
      ranges.push([openedAt, e.frameNo + 1]); // +1: the teleport lands on that frame
      openedAt = null;
    } else if (e.event === "gameStop" || e.event === "gameEnd") {
      ranges.push([e.frameNo, Infinity]);
    }
  }
  if (openedAt !== null) ranges.push([openedAt, Infinity]); // goal, no reset recorded
  return ranges;
}

/** Any overlap between [from, to] and a dead range. */
function inDeadRange(ranges, from, to) {
  for (const [lo, hi] of ranges) if (from <= hi && to >= lo) return true;
  return false;
}

/**
 * Was this player involved in a collision anywhere in [from, to]?
 *
 * The start frame is INCLUDED. A collision on the opening tick is exactly
 * what corrupts the first displacement — the engine resolves penetration by
 * moving the disc positionally and zeroing its normal velocity, neither of
 * which any velocity-based prediction can reproduce.
 */
function collidedDuring(playerId, from, to) {
  for (let f = from; f <= to; f++) {
    if (collisionsByFrame.get(f)?.has(playerId)) return true;
  }
  return false;
}

if (geometryByVersion.size === 0) {
  console.error("No geometry records found. Is this a session file?");
  process.exit(1);
}

// ---------- compare ----------

const stats = {
  open: { total: 0, inside: 0, maxOvershoot: 0, sumUsage: 0 },
  nearWall: { total: 0, inside: 0, maxOvershoot: 0, sumUsage: 0 },
  contact: { total: 0, inside: 0, maxOvershoot: 0, sumUsage: 0 },
  skippedNoPhysics: 0,
  skippedStateNotPlaying: 0,
  skippedDeadRange: 0,
  worst: null,
};

const deadRanges = deadRangesFromEvents(discreteEvents);
if (deadRanges.length) {
  console.log(
    `\nEvent-derived dead ranges: ${deadRanges.length} ` +
      `(goal -> reset windows, plus anything after gameStop/gameEnd)`
  );
}

let compared = 0;
const worstWindows = [];
/** Every contact-free violation, for the failure analysis below. */
const failures = [];

for (const [version, byNo] of framesByVersion) {
  const geom = geometryByVersion.get(version);
  const pp = geom?.playerPhysics;
  if (!pp || pp.acceleration == null || pp.damping == null) {
    stats.skippedNoPhysics += byNo.size;
    continue;
  }
  const allSegments = geom.segments ?? [];
  const segments = playerBlockingSegments(allSegments);
  const planes = playerBlockingPlanes(geom.planes);
  const discs = playerBlockingDiscs(geom.discs);
  if ((geom.discs ?? []).length === 0) {
    console.log(
      `\nNote: "${geom.name}" has no stadium discs recorded. If this session predates\n` +
        `      capturing stadium.discs, goal posts and disc-built barriers are missing\n` +
        `      from the boundary set and wall contacts will be misfiled as open space.`
    );
  }
  if ((allSegments.length || (geom.planes ?? []).length) && !segments.length && !planes.length && !discs.length) {
    console.log(
      `\nNote: no segment or plane on "${geom.name}" collides with players.\n` +
        `      Players are not constrained by the pitch boundary on this map, so the\n` +
        `      near-wall bucket will be empty. Boundaries still bound the ball.`
    );
  }

  for (const [frameNo, frame] of byNo) {
    const later = byNo.get(frameNo + N);
    if (!later) continue;

    // Only compare inside active play. Position resets after a goal teleport
    // players, which no movement formula should be expected to predict.
    if (frame.playState !== 1 || later.playState !== 1) {
      stats.skippedStateNotPlaying++;
      continue;
    }
    // Event-derived exclusion, on top of the state gate. Catches the
    // goal-to-reset window even when playState has not caught up yet.
    if (inDeadRange(deadRanges, frameNo, frameNo + N)) {
      stats.skippedDeadRange++;
      continue;
    }

    const laterById = new Map(later.players.map((p) => [p.id, p]));

    for (const p of frame.players) {
      if (!p.inGame || !p.pos || !p.vel) continue;
      const q = laterById.get(p.id);
      if (!q || !q.inGame || !q.pos) continue;

      // The zone is an UPPER BOUND on where a player can be, so it must use
      // the most permissive physics they can reach during the window — not
      // the physics in force at its start.
      //
      // Releasing kick is always available, and kickingAcceleration (0.083)
      // is well below acceleration (0.11) on a typical map. Predicting a
      // kicking player with the kicking value produced a bound they broke
      // simply by letting go: a ratio of 0.11/0.083 = 1.33, which is exactly
      // where 84% of the failures sat.
      //
      // Pressing kick mid-window is also available, so damping takes
      // whichever value carries further.
      const a = Math.max(pp.acceleration ?? 0, pp.kickingAcceleration ?? 0);
      const d = Math.max(pp.damping ?? 0, pp.kickingDamping ?? 0);

      const centre = zoneCentre(p.pos, p.vel, d, N);
      const R = zoneRadius(a, d, N);
      const overshoot = octagonOvershoot(q.pos.x - centre.x, q.pos.y - centre.y, R);

      // Contact is detected two ways, because neither alone is sufficient.
      //
      // Engine events are reliable for disc-vs-disc, but a player resting
      // against a wall produces no sustained stream of them — the callback
      // fires on impact, not every tick of contact. Observed directly: the
      // segments at x = +/-420 stop players dead with no event recorded.
      //
      // So geometry is checked too: if the player is touching or penetrating
      // a player-blocking boundary at ANY tick in the window, the engine will
      // have resolved that positionally, and no velocity-based model can
      // predict it.
      const inGeometricContact = () => {
        for (let f = frameNo; f <= frameNo + N; f++) {
          const fr = byNo.get(f);
          const pl = fr?.players?.find((x) => x.id === p.id);
          if (!pl?.pos || !pl.inGame) continue;
          const r = pl.radius ?? 15;

          // against static geometry
          if (nearestBoundaryDistance(pl.pos, segments, planes, discs) <= r + 0.5) return true;

          // against other players — sustained shoulder-to-shoulder contact
          // sits at exactly r1 + r2 and produces no repeating event stream
          for (const other of fr.players ?? []) {
            if (other.id === pl.id || !other.inGame || !other.pos) continue;
            const gap = Math.hypot(other.pos.x - pl.pos.x, other.pos.y - pl.pos.y);
            if (gap <= r + (other.radius ?? 15) + 0.5) return true;
          }

          // against the ball
          if (fr.ball?.pos) {
            const gap = Math.hypot(fr.ball.pos.x - pl.pos.x, fr.ball.pos.y - pl.pos.y);
            if (gap <= r + (fr.ball.radius ?? 0) + 0.5) return true;
          }
        }
        return false;
      };

      let bucket;
      if (collidedDuring(p.id, frameNo, frameNo + N) || inGeometricContact()) {
        bucket = stats.contact;
      } else {
        const clearance = nearestBoundaryDistance(p.pos, segments, planes, discs);
        bucket = clearance < R + (p.radius ?? 15) ? stats.nearWall : stats.open;
      }

      bucket.total++;
      bucket.sumUsage += Math.min(overshoot, 4);
      if (overshoot <= 1 + 1e-9) bucket.inside++;
      if (overshoot > bucket.maxOvershoot) bucket.maxOvershoot = overshoot;

      if (bucket !== stats.contact) {
        if (!stats.worst || overshoot > stats.worst.overshoot) {
          stats.worst = { overshoot, frameNo, playerId: p.id, name: p.name, isKicking: p.isKicking };
        }
        if (overshoot > 1 + 1e-9) {
          failures.push({
            overshoot,
            frameNo,
            playerId: p.id,
            name: p.name,
            isKicking: p.isKicking,
            speed: Math.hypot(p.vel.x, p.vel.y),
          });
          if (WORST > 0) {
            worstWindows.push({ overshoot, frameNo, p, q, centre, R, version });
            if (worstWindows.length > WORST * 4) {
              worstWindows.sort((x, y) => y.overshoot - x.overshoot);
              worstWindows.length = WORST;
            }
          }
        }
      }

      if (++compared >= LIMIT) break;
    }
    if (compared >= LIMIT) break;
  }
  if (compared >= LIMIT) break;
}

// ---------- report ----------

const pct = (n, total) => (total ? ((100 * n) / total).toFixed(2) + "%" : "n/a");

console.log(`\nSession:        ${filePath}`);
console.log(`Horizon:        N = ${N} ticks`);
console.log(`Geometries:     ${[...geometryByVersion.values()].map((g) => g.name).join(", ")}`);
console.log(`Comparisons:    ${compared}`);
if (stats.skippedStateNotPlaying) {
  console.log(`Skipped:        ${stats.skippedStateNotPlaying} frame pairs outside active play (state)`);
}
if (stats.skippedDeadRange) {
  console.log(`Skipped:        ${stats.skippedDeadRange} frame pairs in a goal-to-reset window (events)`);
}
if (stats.skippedNoPhysics) {
  console.log(`Skipped:        ${stats.skippedNoPhysics} frames with no playerPhysics`);
}

for (const [label, s, note] of [
  ["Open space", stats.open, "want ~100%"],
  ["Near a wall", stats.nearWall, "want ~100%"],
  ["After contact", stats.contact, "informational — not a pass condition"],
]) {
  console.log(`\n${label}`);
  console.log(`  samples:      ${s.total}`);
  console.log(`  contained:    ${pct(s.inside, s.total)}   <- ${note}`);
  console.log(`  mean usage:   ${s.total ? (s.sumUsage / s.total).toFixed(3) : "n/a"}   (1.0 = exactly at the boundary)`);
  console.log(`  max overshoot:${s.maxOvershoot.toFixed(4)}   (>1 means the bound was violated)`);
}

console.log(
  `\nThe contact bucket holds windows where the player collided with another\n` +
    `disc, a segment or a plane. The zone bounds self-propelled motion only —\n` +
    `a collision injects momentum from outside the model — so those windows\n` +
    `are measured but do not decide the verdict.`
);

if (stats.worst) {
  const w = stats.worst;
  console.log(
    `\nWorst contact-free case: overshoot ${w.overshoot.toFixed(4)} at frame ${w.frameNo}, ` +
      `player ${w.playerId} (${w.name}${w.isKicking ? ", kicking" : ""})`
  );
}

// ---------- failure analysis ----------
// The point of this section is to tell a MODELLING error from BOOKKEEPING.
// A modelling error spreads evenly across players and sits just over the
// boundary. Bookkeeping errors cluster — on a few players, or around resets.

if (failures.length) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`FAILURE ANALYSIS  (${failures.length} contact-free violations)`);
  console.log(`${"=".repeat(72)}`);

  // How far over? Marginal failures mean a slightly-off constant; extreme
  // ones mean something discontinuous.
  const bands = [
    ["1.0 - 1.1", (o) => o <= 1.1],
    ["1.1 - 1.5", (o) => o > 1.1 && o <= 1.5],
    ["1.5 - 2.0", (o) => o > 1.5 && o <= 2],
    ["2   - 5  ", (o) => o > 2 && o <= 5],
    ["5   - 10 ", (o) => o > 5 && o <= 10],
    ["> 10     ", (o) => o > 10],
  ];
  console.log(`\nOvershoot distribution:`);
  for (const [label, test] of bands) {
    const n = failures.filter((f) => test(f.overshoot)).length;
    if (!n) continue;
    const bar = "#".repeat(Math.max(1, Math.round((60 * n) / failures.length)));
    console.log(`  ${label}  ${String(n).padStart(6)}  ${pct(n, failures.length).padStart(7)}  ${bar}`);
  }

  // Concentrated on a few players => their discs likely have non-default
  // physics. Spread evenly => the model itself is off.
  const byPlayer = new Map();
  for (const f of failures) {
    const e = byPlayer.get(f.playerId) ?? { name: f.name, n: 0 };
    e.n++;
    byPlayer.set(f.playerId, e);
  }
  const ranked = [...byPlayer.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\nBy player (${byPlayer.size} distinct):`);
  for (const [id, e] of ranked.slice(0, 6)) {
    console.log(`  ${String(id).padStart(6)}  ${(e.name ?? "?").padEnd(16)}  ${String(e.n).padStart(6)}  ${pct(e.n, failures.length)}`);
  }

  // Clustering near a restart would mean a teleport the state gate missed.
  const eventFrames = discreteEvents
    .filter((e) => ["positionsReset", "kickOff", "teamGoal", "gameStart"].includes(e.event))
    .map((e) => e.frameNo)
    .filter((f) => f != null)
    .sort((a, b) => a - b);
  if (eventFrames.length) {
    const nearRestart = failures.filter((f) =>
      eventFrames.some((ef) => Math.abs(ef - f.frameNo) <= N + 2)
    ).length;
    console.log(`\nWithin ${N + 2} ticks of a restart event: ${nearRestart}  (${pct(nearRestart, failures.length)})`);
  }

  const kicking = failures.filter((f) => f.isKicking).length;
  console.log(`Holding kick at window start:        ${kicking}  (${pct(kicking, failures.length)})`);

  const speeds = failures.map((f) => f.speed).sort((a, b) => a - b);
  console.log(
    `Speed at window start: median ${speeds[Math.floor(speeds.length / 2)].toFixed(3)}, ` +
      `max ${speeds[speeds.length - 1].toFixed(3)} units/tick`
  );
}

// ---------- worst-window dump ----------

if (WORST > 0) {
  worstWindows.sort((a, b) => b.overshoot - a.overshoot);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`WORST ${Math.min(WORST, worstWindows.length)} CONTACT-FREE WINDOWS`);
  console.log(`${"=".repeat(72)}`);

  for (const w of worstWindows.slice(0, WORST)) {
    const byNo = framesByVersion.get(w.version);
    const vec = (v) => (v ? `(${v.x.toFixed(2)}, ${v.y.toFixed(2)})` : "null");
    const speed = (v) => (v ? Math.hypot(v.x, v.y).toFixed(3) : "-");

    console.log(`\n--- overshoot ${w.overshoot.toFixed(3)}  frame ${w.frameNo} -> ${w.frameNo + N}  player ${w.p.id} (${w.p.name})`);
    console.log(`    predicted centre ${vec(w.centre)}   R ${w.R.toFixed(4)}`);
    console.log(`    actual  pos      ${vec(w.q.pos)}`);
    console.log(`    miss distance    ${Math.hypot(w.q.pos.x - w.centre.x, w.q.pos.y - w.centre.y).toFixed(3)}`);
    console.log(`    tick-by-tick:`);
    for (let f = w.frameNo; f <= w.frameNo + N; f++) {
      const fr = byNo.get(f);
      const pl = fr?.players?.find((x) => x.id === w.p.id);
      const evts = [...(collisionsByFrame.get(f) ? ["collision"] : [])];
      console.log(
        `      f=${f}  state=${fr?.playState ?? "?"}  pos=${vec(pl?.pos)}  vel=${vec(pl?.vel)}  ` +
          `|v|=${speed(pl?.vel)}  input=${pl?.input ?? "-"}  kick=${pl?.isKicking ? "Y" : "n"}` +
          (evts.length ? `  [${evts.join(",")}]` : "")
      );
    }
    // Step-by-step displacement, to expose a teleport as one huge jump.
    const steps = [];
    for (let f = w.frameNo; f < w.frameNo + N; f++) {
      const a = byNo.get(f)?.players?.find((x) => x.id === w.p.id);
      const b = byNo.get(f + 1)?.players?.find((x) => x.id === w.p.id);
      steps.push(a?.pos && b?.pos ? Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y).toFixed(3) : "?");
    }
    console.log(`    per-tick displacement: ${steps.join("  ")}`);

    // What else was nearby? A recurring stop with no boundary to explain it is
    // usually another disc — the ball pinned against a ball-only wall, or an
    // opponent braced against one. Both stop a player at a fixed offset.
    const f0 = byNo.get(w.frameNo);
    const me = f0?.players?.find((x) => x.id === w.p.id);
    if (f0 && me?.pos) {
      if (f0.ball?.pos) {
        const gap = Math.hypot(f0.ball.pos.x - me.pos.x, f0.ball.pos.y - me.pos.y);
        console.log(
          `    ball at ${vec(f0.ball.pos)}  r=${f0.ball.radius ?? "?"}  ` +
            `centre gap ${gap.toFixed(2)}  surface gap ${(gap - (me.radius ?? 15) - (f0.ball.radius ?? 0)).toFixed(2)}`
        );
      }
      // Everything in the geometry within 60 units of where the player was
      // stopped, REGARDLESS of collision mask. If a recurring stop has no
      // entry here, the constraint is not in the stadium data at all.
      const g = geometryByVersion.get(w.version);
      const near = [];
      for (const sg of g?.segments ?? []) {
        const d = pointSegmentDistance(me.pos.x, me.pos.y, sg.v0.x, sg.v0.y, sg.v1.x, sg.v1.y);
        if (d < 60) near.push(`segment (${sg.v0.x},${sg.v0.y})->(${sg.v1.x},${sg.v1.y}) d=${d.toFixed(1)} cMask=${sg.cMask}`);
      }
      for (const pl of g?.planes ?? []) {
        const d = pointPlaneDistance(me.pos.x, me.pos.y, pl);
        if (d < 60) near.push(`plane n=(${pl.normal.x},${pl.normal.y}) dist=${pl.dist} d=${d.toFixed(1)} cMask=${pl.cMask}`);
      }
      for (const dc of g?.discs ?? []) {
        const d = Math.hypot(me.pos.x - dc.pos.x, me.pos.y - dc.pos.y) - (dc.radius ?? 0);
        if (d < 60) near.push(`disc (${dc.pos.x},${dc.pos.y}) r=${dc.radius} d=${d.toFixed(1)} cMask=${dc.cMask}`);
      }
      for (const vx of g?.vertices ?? []) {
        const d = Math.hypot(me.pos.x - vx.pos.x, me.pos.y - vx.pos.y);
        if (d < 60) near.push(`vertex (${vx.pos.x},${vx.pos.y}) d=${d.toFixed(1)} cMask=${vx.cMask}`);
      }
      console.log(`    geometry within 60u: ${near.length ? "" : "NOTHING — constraint is not in the stadium data"}`);
      for (const nstr of near.slice(0, 8)) console.log(`      ${nstr}`);

      const others = (f0.players ?? [])
        .filter((x) => x.id !== w.p.id && x.inGame && x.pos)
        .map((x) => ({ x, dist: Math.hypot(x.pos.x - me.pos.x, x.pos.y - me.pos.y) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2);
      for (const o of others) {
        console.log(
          `    nearest player ${o.x.id} (${o.x.name}) at ${vec(o.x.pos)}  ` +
            `centre gap ${o.dist.toFixed(2)}  surface gap ${(o.dist - (me.radius ?? 15) - (o.x.radius ?? 15)).toFixed(2)}`
        );
      }
    }
  }
  console.log("");
}

const openOk = stats.open.total > 0 && stats.open.inside === stats.open.total;
const wallOk = stats.nearWall.inside === stats.nearWall.total;
console.log(`\nVERDICT: ${openOk && wallOk ? "PASS — no violations in contact-free windows" : "FAIL — see max overshoot above"}\n`);

process.exit(openOk && wallOk ? 0 : 2);
