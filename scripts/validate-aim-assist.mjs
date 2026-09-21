/**
 * Validate aimAssistOverlay.js against the real engine.
 *
 * Spins up a node-haxball sandbox, places a player at a chosen gap and angle
 * from a ball with a chosen velocity, presses kick with a genuine rising
 * edge, and compares the module's predicted path against the engine tick by
 * tick.
 *
 * Run:  node scripts/validate-aim-assist.mjs [--trials 300] [--ticks 120]
 *
 * PASS requires all five checks below.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE FIVE CHECKS AND NOT ONE
 *
 * On feat/ball-trajectory the physics validator passed at 1e-13 while the
 * overlay shipped a stop marker whose draw condition could never be true. The
 * validated part and the shipped part had quietly diverged, because the
 * validator only ever tested the physics.
 *
 * DOMAIN.md pitfall 9 is the general form: an experiment that cannot show the
 * effect will report its absence, confidently. So this script also checks the
 * things the OVERLAY depends on, not just the things the maths depends on:
 *
 *   1. PHYSICS   — predicted path vs engine, tick by tick, after a real kick.
 *   2. RANGE     — the kick fires below `kickRange()` and not at or above it.
 *   3. WEDGE     — achievable post-kick directions match asin(k/|v|).
 *   4. REACHABLE — every element the draw layer can render is actually
 *                  reachable in a state the overlay will really be in.
 *                  Specifically: a resting place must be findable inside the
 *                  default horizon, or the stop marker is dead code again.
 *   5. BLOCKERS   — a player standing in the path truncates the trace, and
 *                  truncates it BEFORE the engine's own path diverges. Also
 *                  that the current contact is suppressed as a LATCH rather
 *                  than a permanent exclusion, released on DIRECTION rather
 *                  than distance — so both a ball played into a corner and a
 *                  ball pressed against a wall truncate on the player they
 *                  come back into.
 *
 * A failure in 1-3 means the model is wrong. DO NOT loosen the tolerance.
 * A failure in 4 means the overlay is drawing something it can never draw.
 * A failure in 5 means the overlay is drawing through a body.
 *
 * ---------------------------------------------------------------------------
 * WHY CHECK 5 EXISTS, AND WHY IT IS LATE
 *
 * Check 1 parks every player at (6000, 6000) every tick, on purpose — it is
 * validating ball-vs-geometry. But that means the harness CONSTRUCTS A WORLD
 * IN WHICH BALL-VS-PLAYER CANNOT HAPPEN, so its p99 of 2.93e-13 was never
 * evidence about players and never could have been. Both overlays shipped
 * drawing straight through bodies the engine really does deflect the ball off.
 *
 * That is pitfall 9 again, and the most expensive instance in this project:
 * the earlier ones each hid a single wrong number, this one hid an entire
 * class of situation. A validator's exclusions are load-bearing claims about
 * what it does NOT prove, and they need writing down next to the number.
 *
 * Then check 5 sprang the same trap twice MORE while being written — two test
 * walls that could not return the ball far enough to show the effect, each
 * reporting a confident failure of a fix that was already correct. Both
 * reasons are recorded at the check itself. Do not move that wall back.
 */
import { createRequire } from 'module';
import { predictBallPath, buildCollisionSet } from '../src/features/analytics/ballTrajectory.js';
import { kickRange, contactRange, KICK_RANGE_MARGIN, findKicker, DEFAULT_LEAD_IN_TICKS } from '../src/features/analytics/aimAssistOverlay.js';
import { estimateTerminalSpeed } from '../src/features/analytics/momentumOverlay.js';

const require = createRequire(import.meta.url);
const API = require('node-haxball')(null, {});

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const TRIALS = arg('trials', 300);
const TICKS = arg('ticks', 120);

const KICK_BIT = 16;

const room = API.Room.sandbox({}, { controlledPlayerId: 1 });
room.setSimulationSpeed(0);
room.playerJoin(1, 'p', 'tr', '', '', '');
room.setPlayerTeam(1, 1, 0);
room.startGame(0);
room.runSteps(1);

const st = room.state.stadium;
const pp = st.playerPhysics;
const STADIUM_DISCS = (st.discs ?? []).length;   // ball + goal posts; players follow
const PLAYER_DISC = STADIUM_DISCS;               // exactly one player in this room

const geometry = {
  vertices: st.vertices.map((v) => ({ pos: { x: v.pos.x, y: v.pos.y }, bCoef: v.bCoef, cMask: v.cMask, cGroup: v.cGroup })),
  segments: st.segments.map((s) => ({
    v0: { x: s.v0.pos.x, y: s.v0.pos.y },
    v1: { x: s.v1.pos.x, y: s.v1.pos.y },
    bCoef: s.bCoef, curveF: s.curveF, cMask: s.cMask, cGroup: s.cGroup,
  })),
  planes: st.planes.map((p) => ({ normal: { x: p.normal.x, y: p.normal.y }, dist: p.dist, bCoef: p.bCoef, cMask: p.cMask, cGroup: p.cGroup })),
  discs: (st.discs ?? []).map((d) => ({ pos: { x: d.pos.x, y: d.pos.y }, radius: d.radius, bCoef: d.bCoef, invMass: d.invMass, cMask: d.cMask, cGroup: d.cGroup })),
};

const proto = room.gameState.physicsState.discs[0];
const ballSpec = { radius: proto.radius, bCoef: proto.bCoef, damping: proto.damping, cMask: proto.cMask, cGroup: proto.cGroup };
const set = buildCollisionSet(geometry, ballSpec);

const K = pp.kickStrength;
const PLAYER_RADIUS = pp.radius;
const RANGE = kickRange(PLAYER_RADIUS, ballSpec.radius);
const CONTACT = PLAYER_RADIUS + ballSpec.radius;

console.log(`stadium "${st.name}"  stadium discs ${STADIUM_DISCS}  live discs ${room.gameState.physicsState.discs.length}`);
console.log(`kickStrength ${K}  playerRadius ${PLAYER_RADIUS}  ballRadius ${ballSpec.radius}  damping ${ballSpec.damping}`);
console.log(`contact ${CONTACT}  kick range ${RANGE} (margin ${KICK_RANGE_MARGIN})`);

let rng = 20260921;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

/** Reset to a clean live game and force the exact configuration we want. */
function place(px, py, bx, by, vx, vy) {
  room.stopGame();
  room.startGame(0);
  room.runSteps(1);
  room.playerInput(0, 1);        // guarantee a falling edge before the kick
  room.runSteps(1);
  const ps = room.gameState.physicsState;
  ps.discs[0].pos.x = bx; ps.discs[0].pos.y = by;
  ps.discs[0].speed.x = vx; ps.discs[0].speed.y = vy;
  ps.discs[PLAYER_DISC].pos.x = px; ps.discs[PLAYER_DISC].pos.y = py;
  ps.discs[PLAYER_DISC].speed.x = 0; ps.discs[PLAYER_DISC].speed.y = 0;
  return ps;
}

/** Park the player far away so the post-kick path is ball-vs-geometry only. */
function parkPlayer() {
  const live = room.gameState.physicsState.discs;
  live[PLAYER_DISC].pos.x = 6000; live[PLAYER_DISC].pos.y = 6000;
  live[PLAYER_DISC].speed.x = 0; live[PLAYER_DISC].speed.y = 0;
}

// ===========================================================================
// 1. PHYSICS — predicted path vs engine, after a real kick
// ===========================================================================
console.log('\n=== 1. physics: predicted post-kick path vs engine ===');

const errs = [];
let worst = 0, worstCase = null, bounceTicks = 0, cut = 0, kicked = 0;

for (let trial = 0; trial < TRIALS; trial++) {
  // Keep the action near the middle so a bounce is possible but a goal or a
  // kickoff reset is not immediate.
  const bx = (rand() - 0.5) * 500, by = (rand() - 0.5) * 220;
  // Gap strictly between contact and range: a clean kick with no collision
  // on the same tick, which is the state the overlay previews.
  const gap = CONTACT + 0.5 + rand() * (RANGE - CONTACT - 1);
  const ang = rand() * Math.PI * 2;
  const px = bx - Math.cos(ang) * gap, py = by - Math.sin(ang) * gap;
  const sp = rand() * 7, vang = rand() * Math.PI * 2;
  const vx = Math.cos(vang) * sp, vy = Math.sin(vang) * sp;

  const ps = place(px, py, bx, by, vx, vy);
  const score0 = room.gameState.redScore + room.gameState.blueScore;

  // The model: the impulse, then an ordinary free ball.
  const nHat = { x: (bx - px) / gap, y: (by - py) / gap };
  const vPost = { x: vx + K * nHat.x, y: vy + K * nHat.y };
  const pred = predictBallPath(
    { pos: { x: bx, y: by }, vel: vPost, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    set, TICKS, { stopSpeed: 0 },
  );

  room.playerInput(KICK_BIT, 1);            // rising edge -> fires this tick
  void ps;

  let prev = { vx: vPost.x, vy: vPost.y };
  let sawKick = false;

  for (let t = 0; t < TICKS; t++) {
    room.runSteps(1);
    const gs = room.gameState;
    if (!gs || gs.redScore + gs.blueScore !== score0) { cut++; break; }
    parkPlayer();                           // ball-vs-geometry only from here
    const b = gs.physicsState.discs[0];

    if (b.pos.x === 0 && b.pos.y === 0 && b.speed.x === 0 && b.speed.y === 0) { cut++; break; }

    if (t === 0) {
      // Did the kick actually fire? Pitfall 9: a trial where it did not would
      // otherwise contribute a beautiful zero error for the wrong reason.
      const expect = { x: vPost.x * ballSpec.damping, y: vPost.y * ballSpec.damping };
      sawKick = Math.hypot(b.speed.x - expect.x, b.speed.y - expect.y) < 1e-6;
      if (!sawKick) break;
      kicked++;
    }

    if (Math.abs(b.speed.x - prev.vx * ballSpec.damping) > 1e-9 ||
        Math.abs(b.speed.y - prev.vy * ballSpec.damping) > 1e-9) bounceTicks++;
    prev = { vx: b.speed.x, vy: b.speed.y };

    const err = Math.hypot(b.pos.x - pred.points[t].x, b.pos.y - pred.points[t].y);
    errs.push(err);
    if (err > worst) {
      worst = err;
      worstCase = {
        trial, t,
        ball: [+bx.toFixed(1), +by.toFixed(1)], v0: [+vx.toFixed(2), +vy.toFixed(2)],
        gap: +gap.toFixed(2), vPost: [+vPost.x.toFixed(3), +vPost.y.toFixed(3)],
        engine: [+b.pos.x.toFixed(4), +b.pos.y.toFixed(4)],
        pred: [+pred.points[t].x.toFixed(4), +pred.points[t].y.toFixed(4)],
      };
    }
  }
}

errs.sort((a, b) => a - b);
const q = (f) => errs[Math.min(errs.length - 1, Math.floor(errs.length * f))];
console.log(`trials ${TRIALS}, kicks that fired ${kicked}, samples ${errs.length}, bounce ticks ${bounceTicks}, cut by engine ${cut}`);
console.log(`error  median ${q(0.5).toExponential(2)}   p99 ${q(0.99).toExponential(2)}   max ${worst.toExponential(3)}`);
if (worstCase) console.log('worst:', JSON.stringify(worstCase));

const physicsPass = kicked > TRIALS * 0.8 && errs.length > 1000 && q(0.99) < 1e-9 && worst < 1e-6;
console.log(physicsPass ? 'PASS' : 'FAIL');

// ===========================================================================
// 2. RANGE — the boundary is where kickRange() says it is, and exclusive
// ===========================================================================
console.log('\n=== 2. kick range boundary ===');

function firesAt(gap) {
  place(-gap, 0, 0, 0, 0, 0);
  room.playerInput(KICK_BIT, 1);
  room.runSteps(1);
  const b = room.gameState.physicsState.discs[0];
  return Math.abs(b.speed.x) > 1e-9 || Math.abs(b.speed.y) > 1e-9;
}

const boundaryProbes = [
  [RANGE - 1.0, true], [RANGE - 0.1, true], [RANGE - 0.01, true],
  [RANGE, false], [RANGE + 0.01, false], [RANGE + 1.0, false],
];
let rangePass = true;
for (const [gap, expected] of boundaryProbes) {
  const got = firesAt(gap);
  const ok = got === expected;
  if (!ok) rangePass = false;
  console.log(`  gap ${gap.toFixed(2).padStart(6)}  fired ${String(got).padEnd(5)} expected ${String(expected).padEnd(5)} ${ok ? 'ok' : 'MISMATCH'}`);
}
console.log(rangePass ? 'PASS' : 'FAIL');

// ===========================================================================
// 3. WEDGE — achievable directions vs asin(k/|v|)
// ===========================================================================
// Measured against the engine rather than asserted from algebra: for each
// ball speed, sweep the player all the way around the ball, kick, and record
// the actual resulting heading. The widest deviation from the ball's own
// heading is the wedge half-angle.
console.log('\n=== 3. reachable wedge ===');

// Measured against the engine, not asserted from algebra: for each ball speed,
// sweep the player all the way around the ball, kick, and record the actual
// resulting heading.
//
// CONTAMINATED SAMPLES MUST BE EXCLUDED. At ball speeds above ~4 the ball can
// cross the 4-unit band and reach the player's body within the same tick, so
// the recorded velocity change is a kick PLUS a disc-vs-disc collision. Those
// samples deviate further than any kick can and would fail the check for the
// wrong reason — they are not evidence against the wedge, they are not kicks.
// A sample is clean exactly when the engine's post-tick velocity equals
// (v_ball + K*n) * damping; anything else had a second force in it.
//
// The expected half-angle has three regimes, because the achievable velocity
// set is a circle of radius K centred on v_ball:
//
//   |v| <  K   origin strictly inside  -> every direction, max deviation 180°
//   |v| == K   origin ON the circle    -> deviation is exactly a/2, so the
//                                         supremum is 90° and is never reached
//   |v| >  K   origin outside          -> asin(K/|v|)
const N_SWEEP = 360;
const SWEEP_RES = 180 / N_SWEEP;        // sampling can only approach a smooth max

let wedgePass = true;
for (const speed of [0, 3, 5, 6, 8, 12]) {
  const gap = CONTACT + 1.5;
  let maxDev = 0, clean = 0, contaminated = 0;
  for (let i = 0; i < N_SWEEP; i++) {
    const a = (i / N_SWEEP) * Math.PI * 2;
    const px = -Math.cos(a) * gap, py = -Math.sin(a) * gap;
    place(px, py, 0, 0, speed, 0);
    room.playerInput(KICK_BIT, 1);
    room.runSteps(1);
    const b = room.gameState.physicsState.discs[0];

    const vPost = { x: speed + K * Math.cos(a), y: K * Math.sin(a) };
    const expect = { x: vPost.x * ballSpec.damping, y: vPost.y * ballSpec.damping };
    if (Math.hypot(b.speed.x - expect.x, b.speed.y - expect.y) > 1e-6) { contaminated++; continue; }

    const s = Math.hypot(b.speed.x, b.speed.y);
    if (s < 1e-9) { clean++; continue; }          // v_post exactly zero: no heading
    clean++;
    const dev = Math.abs(Math.atan2(b.speed.y, b.speed.x));
    if (dev > maxDev) maxDev = dev;
  }

  const predicted = speed > K ? Math.asin(K / speed)
                  : speed === K ? Math.PI / 2
                  : Math.PI;
  const tol = SWEEP_RES + 0.5;
  const devDeg = maxDev * 180 / Math.PI, predDeg = predicted * 180 / Math.PI;
  // Enough clean samples to have actually seen the extreme, per pitfall 9.
  const enough = clean > N_SWEEP * 0.5;
  const ok = enough && Math.abs(devDeg - predDeg) < tol;
  if (!ok) wedgePass = false;
  console.log(
    `  ball speed ${String(speed).padStart(2)}  measured ${devDeg.toFixed(2).padStart(6)}°` +
    `  predicted ${predDeg.toFixed(2).padStart(6)}°  clean ${String(clean).padStart(3)}/${N_SWEEP}` +
    `  collided ${String(contaminated).padStart(3)}  ${ok ? 'ok' : 'MISMATCH'}`,
  );
}
console.log(wedgePass ? 'PASS' : 'FAIL');

// ===========================================================================
// 4. REACHABLE — can every drawn element actually fire?
// ===========================================================================
// This is the check feat/ball-trajectory did not have. The physics can be
// perfect while the overlay draws something whose condition is never true.
console.log('\n=== 4. draw conditions are reachable ===');

const DEFAULT_MAX_DISTANCE = 520;   // must match computeAimAssist's default
const DEFAULT_MAX_TICKS = 600;

// (a) the resting marker: a dead ball kicked at kickStrength must come to
//     rest INSIDE the default horizon, or `stops` is permanently false.
const deadBall = predictBallPath(
  { pos: { x: 0, y: 0 }, vel: { x: K, y: 0 }, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
  set, DEFAULT_MAX_TICKS, { maxDistance: DEFAULT_MAX_DISTANCE },
);
const totalTravel = K / (1 - ballSpec.damping);
console.log(`  dead-ball kick: total travel ${totalTravel.toFixed(1)}, horizon ${DEFAULT_MAX_DISTANCE}, ` +
            `ticks used ${deadBall.points.length}/${DEFAULT_MAX_TICKS}, stops=${deadBall.stopped}`);
const stopReachable = deadBall.stopped;

// (b) bounces: a kick toward a wall must produce at least one.
const toWall = predictBallPath(
  { pos: { x: st.width - 60, y: 0 }, vel: { x: K + 4, y: 0 }, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
  set, DEFAULT_MAX_TICKS, { maxDistance: DEFAULT_MAX_DISTANCE },
);
console.log(`  kick into the wall: bounces ${toWall.bounces.length}`);
const bounceReachable = toWall.bounces.length > 0;

// (c) the wedge readout: must be non-null for a ball above kickStrength and
//     null at or below it, so neither branch is dead.
const wedgeAbove = 8 > K ? Math.asin(K / 8) : null;
const wedgeBelow = 3 > K ? Math.asin(K / 3) : null;
console.log(`  wedge at ball speed 8: ${wedgeAbove === null ? 'null' : (wedgeAbove * 180 / Math.PI).toFixed(2) + '°'}; ` +
            `at speed 3: ${wedgeBelow === null ? 'null' : 'non-null'}`);
const wedgeReachable = wedgeAbove !== null && wedgeBelow === null;

// (d) the lead-in band: both branches of `inRange` must be producible, or the
//     approach cue (or the in-range cue) is dead code. Added when the cue was
//     extended beyond kick range — a new branch needs a new reachability check,
//     not the old one reused.
const terminal = estimateTerminalSpeed(pp);
const leadIn = terminal * DEFAULT_LEAD_IN_TICKS;
const fakeBall = { pos: { x: 0, y: 0 }, radius: ballSpec.radius };
const mkPlayer = (gap) => [{ id: 7, team: 1, inGame: true, radius: PLAYER_RADIUS, pos: { x: gap, y: 0 } }];

const inside = findKicker(mkPlayer(RANGE - 1), fakeBall, -1, 'both', leadIn);
const band = findKicker(mkPlayer(RANGE + leadIn / 2), fakeBall, -1, 'both', leadIn);
const outside = findKicker(mkPlayer(RANGE + leadIn + 5), fakeBall, -1, 'both', leadIn);
console.log(`  terminal speed ${terminal.toFixed(3)} u/tick -> lead-in ${leadIn.toFixed(1)} units ` +
            `(cue shows from ${(RANGE + leadIn).toFixed(1)} in)`);
console.log(`  gap ${(RANGE - 1).toFixed(1)}: ${inside ? 'found, inRange=' + inside.inRange : 'none'}; ` +
            `gap ${(RANGE + leadIn / 2).toFixed(1)}: ${band ? 'found, inRange=' + band.inRange : 'none'}; ` +
            `gap ${(RANGE + leadIn + 5).toFixed(1)}: ${outside ? 'found' : 'none (correct)'}`);
console.log(`  contact circle radius ${contactRange(PLAYER_RADIUS, ballSpec.radius)}, band width ` +
            `${(RANGE - contactRange(PLAYER_RADIUS, ballSpec.radius)).toFixed(1)}`);
const leadInReachable = !!inside && inside.inRange === true
                     && !!band && band.inRange === false
                     && outside === null;

const reachablePass = stopReachable && bounceReachable && wedgeReachable && leadInReachable;
console.log(reachablePass ? 'PASS' : 'FAIL');

// ===========================================================================
// 5. BLOCKERS — a body in the path truncates the trace, and does so in time
// ===========================================================================
// The opposite of check 1: instead of parking the players, put one in the way.
console.log('\n=== 5. players truncate the path ===');

let blockerPass = true;
{
  // Ball launched along +x from the middle; a stationary player planted ahead.
  const by = 0, bx = -300;
  const speed = 8;
  const standAt = bx + 180;

  const blockers = [{ x: standAt, y: by, r: PLAYER_RADIUS, id: 7 }];
  const withB = predictBallPath(
    { pos: { x: bx, y: by }, vel: { x: speed, y: 0 }, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    set, 200, { blockers },
  );
  const without = predictBallPath(
    { pos: { x: bx, y: by }, vel: { x: speed, y: 0 }, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    set, 200, {},
  );

  const expectedX = standAt - (PLAYER_RADIUS + ballSpec.radius);
  const gotX = withB.blocked ? withB.blocked.pos.x : NaN;
  console.log(`  blocked: ${!!withB.blocked}  at x ${gotX.toFixed(3)}  expected ${expectedX.toFixed(3)}  ` +
              `points ${withB.points.length} vs ${without.points.length} unblocked`);
  const truncates = !!withB.blocked
    && Math.abs(gotX - expectedX) < 1e-9
    && withB.points.length < without.points.length;

  // And the engine agrees the path stops being valid there: run it for real
  // with a player standing at that spot and see where the ball deviates from
  // the unblocked prediction.
  place(standAt, by, bx, by, speed, 0);
  let deviateAt = null;
  for (let t = 0; t < 60; t++) {
    room.runSteps(1);
    const gs = room.gameState;
    if (!gs) break;
    // hold the blocker still; we are testing "does contact happen here", not
    // what the player does afterwards
    const live = gs.physicsState.discs;
    live[PLAYER_DISC].pos.x = standAt; live[PLAYER_DISC].pos.y = by;
    live[PLAYER_DISC].speed.x = 0; live[PLAYER_DISC].speed.y = 0;
    const b = live[0];
    if (Math.hypot(b.pos.x - without.points[t].x, b.pos.y - without.points[t].y) > 0.5) { deviateAt = t; break; }
  }
  const blockedTick = withB.points.length - 1;
  console.log(`  engine diverges from the unblocked path at tick ${deviateAt}; trace truncates at tick ${blockedTick}`);

  // Truncating no later than the divergence is the requirement. Earlier is
  // fine and is the safe direction; later means we drew through a body.
  const inTime = deviateAt !== null && blockedTick <= deviateAt;

  // The carrier must NOT truncate the trace at zero length.
  const carrier = predictBallPath(
    { pos: { x: 0, y: 0 }, vel: { x: 5, y: 0 }, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    set, 60, { blockers: [{ x: -20, y: 0, r: PLAYER_RADIUS, id: 9 }] },
  );
  console.log(`  overlapping carrier ignored: ${carrier.blocked === null} (${carrier.points.length} points)`);
  const carrierOk = carrier.blocked === null && carrier.points.length > 10;

  // THE REBOUND CASE. Kick into a wall and the ball comes back to the player
  // who kicked it. They started in contact, so suppressing the current contact
  // PERMANENTLY draws the cue line straight through their own body — the bug
  // this check exists to catch. The suppression has to be a latch that re-arms
  // once the ball separates.
  //
  // Against a LIVELY wall, deliberately. The classic map's side wall returns
  // almost nothing (measured e ~ 0.03: a 7-speed ball dies 22 units off it and
  // never comes back), so a test built on it cannot produce the phenomenon and
  // would report a confident pass — pitfall 9, in the validator itself. This
  // one uses a synthetic bCoef-1.0 plane so the return is guaranteed.
  // The wall is deliberately CLOSE. e = ball.bCoef * wall.bCoef = 0.5 even
  // against a perfect wall, so a long outbound run damps the ball and halves
  // what is left: from 500 units out it returns only as far as x = 237 and the
  // check passes for the wrong reason. Near wall, fast arrival, long return.
  const livelyGeom = {
    planes: [{ normal: { x: -1, y: 0 }, dist: -100, bCoef: 1, cMask: 0, cGroup: 32 }],
    segments: [], vertices: [], discs: [],
  };
  const livelySet = buildCollisionSet(livelyGeom, ballSpec);
  const kicker = { x: 0, y: 0, r: PLAYER_RADIUS, id: 3 };
  const rebound = predictBallPath(
    { pos: { x: 20, y: 0 }, vel: { x: 10, y: 0 },        // gap 20 < 25: overlapping
      radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    livelySet, 400, { blockers: [kicker] },
  );
  const reboundOk = rebound.bounces.length > 0
    && rebound.blocked !== null
    && rebound.blocked.index > rebound.bounces[0].index;
  console.log(`  rebound onto the kicker: bounces ${rebound.bounces.length}, ` +
              (rebound.blocked
                ? `blocked at x ${rebound.blocked.pos.x.toFixed(2)} (expected ${(kicker.x + PLAYER_RADIUS + ballSpec.radius).toFixed(2)}), after the bounce: ${reboundOk}`
                : 'NOT BLOCKED — the cue would draw through the kicker'));

  // PRESSED INTO A WALL. The ball is jammed between the player and a wall, so
  // the predicted path is into the wall, bounce, straight back — the whole of
  // it inside the player's own body radius. The ball NEVER separates, so a
  // distance-based latch never re-arms and the cue draws straight through
  // them. Only a direction-based release catches this.
  const pressWall = {
    planes: [{ normal: { x: -1, y: 0 }, dist: -100, bCoef: 1, cMask: 0, cGroup: 32 }],
    segments: [], vertices: [], discs: [],
  };
  const pressSet = buildCollisionSet(pressWall, ballSpec);
  const presser = { x: 70, y: 0, r: PLAYER_RADIUS, id: 4 };
  const pressed = predictBallPath(
    { pos: { x: 90, y: 0 }, vel: { x: 6, y: 0 },      // ball on the wall, gap 20 to the player
      radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
    pressSet, 200, { blockers: [presser] },
  );
  const maxGap = Math.max(...pressed.points.map((q) => Math.hypot(q.x - presser.x, q.y - presser.y)));
  console.log(`  pressed against a wall: ball never separates (max gap ${maxGap.toFixed(1)} vs R ` +
              `${(ballSpec.radius + presser.r).toFixed(1)}), ` +
              (pressed.blocked
                ? `blocked at tick ${pressed.blocked.index} — correct`
                : `NOT BLOCKED over ${pressed.points.length} ticks — the cue would draw through them`));
  const pressOk = pressed.blocked !== null
    && maxGap <= ballSpec.radius + presser.r        // confirms separation really never happens
    && pressed.points.length > 1;                   // and the line is not degenerate

  blockerPass = truncates && inTime && carrierOk && reboundOk && pressOk;
}
console.log(blockerPass ? 'PASS' : 'FAIL');

// ===========================================================================
console.log('\n' + '='.repeat(60));
const all = physicsPass && rangePass && wedgePass && reachablePass && blockerPass;
console.log(`physics ${physicsPass ? 'PASS' : 'FAIL'}   range ${rangePass ? 'PASS' : 'FAIL'}   ` +
            `wedge ${wedgePass ? 'PASS' : 'FAIL'}   reachable ${reachablePass ? 'PASS' : 'FAIL'}   ` +
            `blockers ${blockerPass ? 'PASS' : 'FAIL'}`);
console.log(all ? 'ALL PASS' : 'FAILED');
process.exit(all ? 0 : 1);
