/**
 * Ball trajectory prediction.
 *
 * Tick-exact forward simulation of the ball against stadium geometry, for a
 * live trajectory trace / aim assist.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED ENGINE BEHAVIOUR (measured against node-haxball 2.2.0 in a sandbox
 * room; see scripts/validate-trajectory.mjs)
 *
 * Wall reflection is NOT symmetric. Per tick, for a free ball:
 *
 *   1. p += v                                  (integrate on pre-damping v)
 *   2. for each overlapping surface:
 *        push p out along the surface normal until exactly touching
 *        if (v · n) < 0:  v -= n * (v · n) * (1 + e)
 *   3. v *= damping                            (global, both components)
 *
 * where the restitution is the PRODUCT of the two bounce coefficients:
 *
 *   e = ball.bCoef * surface.bCoef
 *
 * Confirmed exactly at ball bCoef 0.00 / 0.25 / 0.50 / 0.75 / 1.00 / 1.50
 * against a bCoef-1.0 wall. Note e > 1 is legal — a custom map with
 * bCoef > 1 makes the ball leave the wall FASTER than it arrived.
 *
 * Consequences that matter for drawing a trace:
 *
 * - The normal component is scaled by e; the tangential component is NOT
 *   touched by the collision. Both are then scaled by damping. So the outgoing
 *   angle is flatter against the wall than the incoming angle whenever e < 1.
 *   At e = 0.5, a 45-degree approach leaves at 26.565 degrees.
 *
 * - Therefore you cannot draw a bounce by mirroring the incoming ray. The
 *   reflection has to be computed from the components.
 *
 * - Position is resolved by SNAPPING to exactly touching at the end of the
 *   collision tick. The engine does no sub-tick/continuous-time resolution, so
 *   the ball "loses" the remainder of that tick's travel, and the snap moves
 *   it along the surface NORMAL — off the incoming line. The bounce vertex is
 *   therefore not the geometric ray/wall intersection, and where it lands
 *   depends on tick phase: the same shot from half a tick earlier turns at a
 *   slightly different point.
 *
 *   So the path is straight segments (see below) but you still cannot get it
 *   by analytic raycasting: both the turn POINT and the turn ANGLE are wrong
 *   that way. Simulate tick by tick.
 *
 * - The ball NEVER CURVES. Damping is isotropic (v.x and v.y are scaled by the
 *   same 0.99), so heading is preserved exactly: measured drift over 80 free
 *   ticks is 2.2e-16 rad, and perpendicular deviation from the launch ray is
 *   5.7e-14 units. There is no spin, drag asymmetry or lateral force anywhere
 *   in the engine. Between bounces the path is a straight line, full stop.
 *
 *   What damping changes is the SPACING of tick positions along that line —
 *   the per-tick step shrinks by exactly 0.99 each tick. So the shape is
 *   straight but progress along it is geometric, not linear:
 *
 *     distance after N ticks = |v| * (1 - d^N) / (1 - d)
 *     total remaining travel = |v| / (1 - d)   =  100 * |v| at d = 0.99
 *
 *   A ball at speed 3 can never travel more than 300 units, however much
 *   space is ahead of it. Draw the path as straight segments; do not put
 *   evenly spaced time markers along them.
 *
 * - Which surfaces the ball bounces off is a cMask/cGroup question and is NOT
 *   the same set the players collide with. Filter per entity.
 *
 * - Curved segments reflect off the arc's radial normal, and only while the
 *   contact point lies inside the arc's angular span. Segment ends are handled
 *   by the vertices, which are their own collision objects.
 *
 * - ORDER MATTERS. Discs (goal posts, map barriers) must be resolved BEFORE
 *   planes/segments/vertices. When the ball touches a post and the goal-line
 *   geometry on the same tick, each contact moves the ball, so whichever is
 *   applied first changes the other's penetration depth. Resolving boundaries
 *   first reproduces the engine on head-on post hits but drifts ~1 unit per
 *   glancing hit — enough to send a predicted rebound to the wrong side of the
 *   post. This was invisible until goal posts were included in the test.
 *
 * ACCURACY: p99 position error 2.4e-13 units, max 1.5e-12, over 70,994 tick
 * comparisons including 663 ticks containing a bounce (walls, curved segments
 * and goal posts). That is floating-point noise — the model is the engine's
 * arithmetic, not an approximation of it.
 *
 * NOT MODELLED (deliberate):
 * - Goals. The trace runs through the goal line; stop it yourself at the goal.
 * - Kickoff/post-goal teleports.
 *
 * PLAYERS ARE BLOCKERS, NOT BOUNCERS. buildCollisionSet only takes STATIC
 * discs (invMass === 0), which is correct — it is fed the stadium, and a
 * player is neither static nor in it. Players live in physicsState.discs and
 * move every tick, so they cannot live in a set cached per geometryVersion.
 *
 * That left both overlays drawing straight through bodies the engine really
 * does bounce the ball off (the masks match: ball cGroup 193/cMask 63 against
 * player cGroup 2/cMask 47 passes both ways).
 *
 * So predictBallPath takes a per-tick `blockers` list and TRUNCATES at first
 * contact rather than simulating a rebound. That is the honest treatment:
 *
 *   - A player has invMass 0.5 against the ball's 1, so disc-vs-disc is a
 *     mass-weighted response in which BOTH bodies move. Not a wall.
 *   - They move during the ball's flight, so a rebound computed off a frozen
 *     position is a confident answer about a place the player has left.
 *   - Where they WILL be needs intent, which is not computable. Where they
 *     COULD be is the reachable zone, and that is another branch.
 *
 * "The path is valid this far" is a claim the physics supports. A predicted
 * rebound off a moving player is not, and would be the facing-ray mistake
 * again: most confident exactly where it is most wrong.
 *
 * The stationary assumption degrades in the right direction — the nearer the
 * blocker, the less time it has to move, so the shorter the truncated path
 * the more trustworthy it is.
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {{x:number,y:number}} Vec2
 */

/**
 * Surfaces the given entity can actually collide with.
 *
 * cMask = 0 means "unspecified -> all", NOT "none". Reading it as "none" makes
 * the most permissive geometry on a map invisible. See DOMAIN.md § Pitfalls.
 *
 * @param {number} mask
 * @returns {number}
 */
const effectiveMask = (mask) => (mask === 0 || mask == null ? 0xffffffff : mask);

/**
 * @param {number} aMask @param {number} aGroup
 * @param {number} bMask @param {number} bGroup
 * @returns {boolean}
 */
function collides(aMask, aGroup, bMask, bGroup) {
  const am = effectiveMask(aMask), bm = effectiveMask(bMask);
  return (am & bGroup) !== 0 && (bm & aGroup) !== 0;
}

/**
 * Pre-filter stadium geometry down to what one entity can hit, and precompute
 * arc parameters. Do this once per geometryVersion, not per tick.
 *
 * `geometry` is the object produced by extractStadiumGeometry().
 *
 * @param {{vertices:Array,segments:Array,planes:Array,discs:Array}} geometry
 * @param {{cMask:number,cGroup:number}} entity
 * @returns {{segments:Array,planes:Array,vertices:Array,discs:Array}}
 */
export function buildCollisionSet(geometry, entity) {
  const { cMask, cGroup } = entity;
  const out = { segments: [], planes: [], vertices: [], discs: [] };

  for (const s of geometry.segments ?? []) {
    if (!collides(s.cMask, s.cGroup, cMask, cGroup)) continue;
    const a = { x: s.v0.x, y: s.v0.y };
    const b = { x: s.v1.x, y: s.v1.y };
    const cf = s.curveF;
    const o = { a, b, bCoef: s.bCoef, curved: Number.isFinite(cf) && cf !== 0 };
    if (o.curved) {
      // Arc centre/radius, derived exactly as the engine derives them.
      const hx = 0.5 * (b.x - a.x), hy = 0.5 * (b.y - a.y);
      const cx = a.x + hx - hy * cf, cy = a.y + hy + hx * cf;
      o.c = { x: cx, y: cy };
      o.r = Math.hypot(a.x - cx, a.y - cy);
      // Half-plane normals bounding the arc's angular span.
      o.n0 = { x: cy - a.y, y: a.x - cx };
      o.n1 = { x: b.y - cy, y: cx - b.x };
      if (cf <= 0) {
        o.n0 = { x: -o.n0.x, y: -o.n0.y };
        o.n1 = { x: -o.n1.x, y: -o.n1.y };
      }
    }
    out.segments.push(o);
  }

  for (const p of geometry.planes ?? []) {
    if (!collides(p.cMask, p.cGroup, cMask, cGroup)) continue;
    const len = Math.hypot(p.normal.x, p.normal.y) || 1;
    out.planes.push({ nx: p.normal.x / len, ny: p.normal.y / len, dist: p.dist / len, bCoef: p.bCoef });
  }

  for (const v of geometry.vertices ?? []) {
    if (!collides(v.cMask, v.cGroup, cMask, cGroup)) continue;
    out.vertices.push({ x: v.pos.x, y: v.pos.y, bCoef: v.bCoef });
  }

  // Static stadium discs: goal posts, and on custom maps whole barriers.
  for (const d of geometry.discs ?? []) {
    if (d.invMass !== 0) continue;               // movable discs are not static geometry
    if (!collides(d.cMask, d.cGroup, cMask, cGroup)) continue;
    out.discs.push({ x: d.pos.x, y: d.pos.y, r: d.radius, bCoef: d.bCoef });
  }

  return out;
}

/**
 * Resolve one overlap: snap out along the normal, then reflect.
 * @param {Vec2} p @param {Vec2} v
 * @param {number} nx @param {number} ny @param {number} pen @param {number} e
 */
function resolveContact(p, v, nx, ny, pen, e) {
  p.x += nx * pen;
  p.y += ny * pen;
  const vn = v.x * nx + v.y * ny;
  if (vn < 0) {
    const k = (1 + e) * vn;
    v.x -= nx * k;
    v.y -= ny * k;
  }
}

/**
 * Apply every collision for one tick, in place.
 * @param {Vec2} p @param {Vec2} v
 * @param {number} radius @param {number} bCoef
 * @param {ReturnType<typeof buildCollisionSet>} set
 */
export function resolveCollisions(p, v, radius, bCoef, set) {
  for (const d of set.discs) {
    const dx = p.x - d.x, dy = p.y - d.y;
    const dist = Math.hypot(dx, dy);
    const reach = radius + d.r;
    if (dist >= reach || dist === 0) continue;
    resolveContact(p, v, dx / dist, dy / dist, reach - dist, bCoef * d.bCoef);
  }
  for (const g of set.planes) {
    // valid region is p·n >= dist
    const d = p.x * g.nx + p.y * g.ny - g.dist;
    if (d >= radius) continue;
    resolveContact(p, v, g.nx, g.ny, radius - d, bCoef * g.bCoef);
  }

  for (const s of set.segments) {
    let nx, ny, dist;
    if (s.curved) {
      const dx = p.x - s.c.x, dy = p.y - s.c.y;
      if (dx * s.n0.x + dy * s.n0.y <= 0) continue;   // outside the arc's span
      if (dx * s.n1.x + dy * s.n1.y <= 0) continue;
      const dl = Math.hypot(dx, dy);
      if (dl === 0) continue;
      const gap = dl - s.r;                            // signed: outside is positive
      dist = Math.abs(gap);
      if (dist >= radius) continue;
      const sgn = gap >= 0 ? 1 : -1;
      nx = (dx / dl) * sgn;
      ny = (dy / dl) * sgn;
    } else {
      const abx = s.b.x - s.a.x, aby = s.b.y - s.a.y;
      const denom = abx * abx + aby * aby;
      if (denom === 0) continue;
      const t = ((p.x - s.a.x) * abx + (p.y - s.a.y) * aby) / denom;
      if (t < 0 || t > 1) continue;                    // the ends are the vertices' job
      const cx = s.a.x + abx * t, cy = s.a.y + aby * t;
      const dx = p.x - cx, dy = p.y - cy;
      dist = Math.hypot(dx, dy);
      if (dist >= radius || dist === 0) continue;
      nx = dx / dist;
      ny = dy / dist;
    }
    resolveContact(p, v, nx, ny, radius - dist, bCoef * s.bCoef);
  }

  for (const w of set.vertices) {
    const dx = p.x - w.x, dy = p.y - w.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= radius || dist === 0) continue;
    resolveContact(p, v, dx / dist, dy / dist, radius - dist, bCoef * w.bCoef);
  }

}

/**
 * Earliest fraction along the segment from->to at which a disc of `radius`
 * first touches a circle of radius R centred at c, or null if it never does.
 *
 * A swept test, not a point-in-circle test at the tick position: it is cheap
 * insurance against tunnelling, and it puts the truncation mark where the ball
 * would first make contact rather than where it happened to land that tick.
 *
 * @param {Vec2} from @param {Vec2} to @param {Vec2} c
 * @param {number} R combined radius (ball + blocker)
 * @returns {number|null} t in [0,1]
 */
function sweptCircleEntry(from, to, c, R) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const fx = from.x - c.x, fy = from.y - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - R * R;

  if (a === 0) return cc <= 0 ? 0 : null;          // no movement this tick
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 >= 0 && t0 <= 1) return t0;
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t0 < 0 && t1 > 1) return 0;                  // started inside and stayed
  return null;
}

/**
 * Forward-simulate the ball.
 *
 * Tick-exact while no player touches the ball. The moment a player does, the
 * real path diverges — so treat the tail of a long trace as a decaying claim,
 * not a prediction. For an aim assist, a short horizon is honest and a long
 * one is decoration.
 *
 * THE HORIZON IS A DISTANCE, NOT A TICK COUNT. Damping makes ticks a terrible
 * unit here: at d = 0.99 a ball at speed 1.5 needs ~338 ticks to come to rest,
 * while one at speed 10 crosses the whole pitch and bounces repeatedly in the
 * same span. A tick cap therefore truncates exactly the slow ball whose
 * resting place you wanted to know, and draws spaghetti for the fast one.
 * Capping by path length gives both the right thing: any ball whose remaining
 * travel (|v| / (1 - d)) fits inside `maxDistance` is drawn all the way to
 * where it stops.
 *
 * `maxTicks` remains only as a safety bound on the loop.
 *
 * @param {{pos:Vec2, vel:Vec2, radius:number, bCoef:number, damping:number}} ball
 * @param {ReturnType<typeof buildCollisionSet>} set
 * @param {number} maxTicks hard loop bound
 * @param {{stopSpeed?:number, maxDistance?:number,
 *          blockers?:{x:number,y:number,r:number,id?:*}[]}} [options]
 *   stopSpeed: treat the ball as at rest below this, ending the trace.
 *   maxDistance: stop once the path has covered this much ground.
 *   blockers: per-tick circles (players) that END the trace on contact rather
 *     than bouncing it. See the header for why truncating is the honest
 *     treatment. A blocker already overlapping the ball at the start is
 *     ignored UNTIL THE BALL SEPARATES FROM IT, then becomes live again —
 *     including the player doing the kicking. See the latch below.
 * @returns {{points:Vec2[], bounces:{index:number, pos:Vec2}[],
 *            stopped:boolean, travelled:number,
 *            blocked:{index:number, pos:Vec2, id:*}|null}}
 *   `stopped` is true only when the ball actually came to rest inside the
 *   trace — not when the trace merely ran out of room. Only then is the last
 *   point a real resting place.
 *   `blocked` is non-null when a blocker ended the trace; beyond that point
 *   the prediction says nothing, rather than saying the ball carries on.
 */
export function predictBallPath(ball, set, maxTicks, options = {}) {
  const { stopSpeed = 0.1, maxDistance = Infinity, blockers = [] } = options;
  const p = { x: ball.pos.x, y: ball.pos.y };
  const v = { x: ball.vel.x, y: ball.vel.y };
  const d = ball.damping;

  // A blocker touching the ball right now is the CURRENT contact, not a
  // future block — without this, every trace from a carried ball truncates at
  // zero length against the carrier.
  //
  // THE RELEASE CONDITION IS DIRECTION, NOT DISTANCE. Two bugs were needed to
  // find that. Excluding an overlapping blocker for the whole trace drew the
  // cue through the kicker's own body when a ball played into a corner came
  // back. Releasing on separation instead fixed that but not the harder case:
  // press the ball against a wall and the predicted path is into the wall,
  // bounce, straight back into you, entirely inside your own body radius. The
  // ball never separates, so a distance-based latch never re-arms and the cue
  // draws through you again.
  //
  // What actually distinguishes "resting on me" from "about to hit me" is
  // which way the ball is going. So an overlapping blocker stays suppressed
  // only while the ball is moving AWAY from it, and goes live the moment the
  // velocity turns back toward it — separated or not.
  const suppressed = blockers.map(
    (b) => Math.hypot(ball.pos.x - b.x, ball.pos.y - b.y) <= ball.radius + b.r,
  );

  const points = [];
  const bounces = [];
  let travelled = 0;
  let stopped = false;
  let blocked = null;

  for (let t = 0; t < maxTicks; t++) {
    const fromX = p.x, fromY = p.y;
    p.x += v.x;
    p.y += v.y;

    // Swept against the tick's whole displacement, before geometry is
    // resolved: a player standing in front of a wall blocks the ball on the
    // way in, not after the wall has already turned it around.
    if (blockers.length) {
      let best = null;
      for (let i = 0; i < blockers.length; i++) {
        const b = blockers[i];
        const R = ball.radius + b.r;
        if (suppressed[i]) {
          // Clear of it: an ordinary separation, measured at the START of the
          // tick so separating and re-entering within one tick is impossible.
          const clear = Math.hypot(fromX - b.x, fromY - b.y) > R;
          // Or still overlapping but now heading back INTO it — the pressed
          // -against-a-wall case, where separation never happens.
          const closing = v.x * (b.x - fromX) + v.y * (b.y - fromY) > 0;
          // Never on the first tick: the ball has to be allowed to leave
          // before it can be said to be arriving, and a trace of zero length
          // reads as a broken overlay rather than as "nothing happens".
          if (clear || (t > 0 && closing)) suppressed[i] = false;
          else continue;
        }
        const tt = sweptCircleEntry(
          { x: fromX, y: fromY }, { x: p.x, y: p.y }, { x: b.x, y: b.y }, R,
        );
        if (tt !== null && (best === null || tt < best.t)) best = { t: tt, b };
      }
      if (best) {
        const hit = {
          x: fromX + (p.x - fromX) * best.t,
          y: fromY + (p.y - fromY) * best.t,
        };
        travelled += Math.hypot(hit.x - fromX, hit.y - fromY);
        points.push(hit);
        blocked = { index: points.length - 1, pos: hit, id: best.b.id };
        break;
      }
    }

    const vxBefore = v.x, vyBefore = v.y;
    resolveCollisions(p, v, ball.radius, ball.bCoef, set);
    if (v.x !== vxBefore || v.y !== vyBefore) {
      bounces.push({ index: points.length, pos: { x: p.x, y: p.y } });
    }

    v.x *= d;
    v.y *= d;

    travelled += Math.hypot(p.x - fromX, p.y - fromY);
    points.push({ x: p.x, y: p.y });

    if (Math.hypot(v.x, v.y) < stopSpeed) { stopped = true; break; }
    if (travelled >= maxDistance) break;
  }

  return { points, bounces, stopped, travelled, blocked };
}

/**
 * The furthest the ball can still travel along its current path, ignoring
 * walls: |v| / (1 - damping). Useful as a cheap "can this reach at all" gate
 * before running a full trace.
 *
 * @param {Vec2} vel @param {number} damping
 * @returns {number}
 */
export function remainingTravel(vel, damping) {
  return Math.hypot(vel.x, vel.y) / (1 - damping);
}
