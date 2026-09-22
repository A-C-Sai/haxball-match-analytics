/**
 * Validate ballTrajectory.js against the real engine.
 *
 * Spins up a node-haxball sandbox room, launches the ball from random states,
 * and compares the module's prediction to the engine tick by tick.
 *
 * Runs against the default stadium AND every map in test-maps/, because the
 * default stadiums are not representative: they carry almost no decorative
 * geometry, and a whole class of collision-set bug is invisible on them. The
 * phantom-obstacle bug — decorative `trait: "line"` elements with `cMask: 0`
 * being treated as solid — passed this validator at 2.4e-13 for three branches
 * while sending the predicted ball off the goal box on every custom map.
 *
 * Run:  node scripts/validate-trajectory.mjs [--trials 600] [--ticks 140]
 *       node scripts/validate-trajectory.mjs --map test-maps/K_Futsal_big_6v.hbs
 *
 * PASS: p99 error at floating-point noise (< 1e-9) with a healthy bounce count,
 * on every stadium. A failure here means the physics model is wrong — do NOT
 * loosen the tolerance to make it pass. See README-session-event-capture.md.
 *
 * WHAT THIS DOES NOT PROVE: every player is parked off-pitch for the duration,
 * so this is ball-vs-geometry only. It says nothing about ball-vs-player —
 * that is validate-aim-assist.mjs check 5's job. Quoting this file's p99 as
 * though it covered players is how both overlays came to draw through bodies.
 */
import { createRequire } from 'module';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { buildCollisionSet, predictBallPath } from '../src/features/analytics/ballTrajectory.js';

const require = createRequire(import.meta.url);
const API = require('node-haxball')(null, {});

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const strArg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
};
const TRIALS = arg('trials', 600);
const TICKS = arg('ticks', 140);

/** Stadiums to run: the default, plus every custom map available. */
function stadiumsToRun() {
  const one = strArg('map');
  if (one) return [{ label: one, raw: readFileSync(one, 'utf8') }];
  const list = [{ label: 'default (Classic)', raw: null }];
  const dir = 'test-maps';
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.hbs')).sort()) {
      list.push({ label: f, raw: readFileSync(join(dir, f), 'utf8') });
    }
  }
  return list;
}

function runStadium({ label, raw }) {
  const room = API.Room.sandbox({}, { controlledPlayerId: 1 });
  room.setSimulationSpeed(0);
  // The sandbox's setCurrentStadium() is a queued fake event that does not
  // apply under runSteps(); assigning before startGame() is what loads a map.
  if (raw) room.state.stadium = API.Utils.parseStadium(raw);
  room.playerJoin(1, 'p', 'tr', '', '', '');
  room.setPlayerTeam(1, 1, 0);
  room.startGame(0);
  room.runSteps(1);

  const st = room.state.stadium;

  // Geometry in the shape extractStadiumGeometry() produces.
  const geometry = {
    vertices: st.vertices.map((v) => ({ pos: { x: v.pos.x, y: v.pos.y }, bCoef: v.bCoef, cMask: v.cMask, cGroup: v.cGroup })),
    segments: st.segments.map((s) => ({
      v0: { x: s.v0.pos.x, y: s.v0.pos.y },
      v1: { x: s.v1.pos.x, y: s.v1.pos.y },
      bCoef: s.bCoef, bias: s.bias, curveF: s.curveF, cMask: s.cMask, cGroup: s.cGroup,
    })),
    planes: st.planes.map((p) => ({ normal: { x: p.normal.x, y: p.normal.y }, dist: p.dist, bCoef: p.bCoef, cMask: p.cMask, cGroup: p.cGroup })),
    discs: (st.discs ?? []).map((d) => ({ pos: { x: d.pos.x, y: d.pos.y }, radius: d.radius, bCoef: d.bCoef, invMass: d.invMass, cMask: d.cMask, cGroup: d.cGroup })),
  };

  const STADIUM_DISCS = (st.discs ?? []).length;
  const proto = room.gameState.physicsState.discs[0];
  const ballSpec = { radius: proto.radius, bCoef: proto.bCoef, damping: proto.damping, cMask: proto.cMask, cGroup: proto.cGroup };
  const set = buildCollisionSet(geometry, ballSpec);

  console.log(`\n=== ${label} — "${st.name}" ===`);
  console.log(`stadium discs (incl. ball): ${STADIUM_DISCS}; live discs: ${room.gameState.physicsState.discs.length}`);
  console.log('ball:', JSON.stringify(ballSpec));
  console.log(`geometry in file:  ${geometry.segments.length} segments, ${geometry.planes.length} planes, ` +
              `${geometry.vertices.length} vertices, ${geometry.discs.length} discs`);
  console.log(`collision set:     ${set.segments.length} segments (${set.segments.filter((s) => s.curved).length} curved), ` +
              `${set.planes.length} planes, ${set.vertices.length} vertices, ${set.discs.length} static discs`);

  // Launch inside the pitch, scaled to this map rather than hardcoded to the
  // default's dimensions — a fixed +/-350 box on an 800-wide map would never
  // reach the geometry that matters.
  const halfW = (st.width || 420) * 0.85;
  const halfH = (st.height || 200) * 0.85;

  let rng = 987654321;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  const errs = [];
  let worst = 0, wc = null, bounceTicks = 0, cutByEngine = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const sx = (rand() - 0.5) * 2 * halfW, sy = (rand() - 0.5) * 2 * halfH;
    const sp = 2 + rand() * 10, ang = rand() * Math.PI * 2;
    const vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };

    room.stopGame();
    room.startGame(0);
    room.runSteps(1);

    let gs = room.gameState;
    const ps = gs.physicsState;
    const ball = ps.discs[0];
    // discs[0..stadiumDiscCount-1] are stadium discs (ball + goal posts);
    // player discs come after. Park only the players.
    for (let i = STADIUM_DISCS; i < ps.discs.length; i++) {
      ps.discs[i].pos.x = 40000; ps.discs[i].pos.y = 40000;
      ps.discs[i].speed.x = 0;  ps.discs[i].speed.y = 0;
    }
    ball.pos.x = sx; ball.pos.y = sy;
    ball.speed.x = vel.x; ball.speed.y = vel.y;

    const score0 = gs.redScore + gs.blueScore;
    const pred = predictBallPath(
      { pos: { x: sx, y: sy }, vel, radius: ballSpec.radius, bCoef: ballSpec.bCoef, damping: ballSpec.damping },
      set, TICKS, { stopSpeed: 0 },
    );

    let prev = { vx: vel.x, vy: vel.y };
    for (let t = 0; t < TICKS; t++) {
      room.runSteps(1);
      gs = room.gameState;                       // engine replaces this on a goal
      if (!gs || gs.redScore + gs.blueScore !== score0) { cutByEngine++; break; }
      const b = gs.physicsState.discs[0];
      // The engine re-places player discs at kickoff, so park them every tick;
      // this validates ball-vs-geometry only.
      const live = gs.physicsState.discs;
      for (let i = STADIUM_DISCS; i < live.length; i++) {
        live[i].pos.x = 40000; live[i].pos.y = 40000; live[i].speed.x = 0; live[i].speed.y = 0;
      }

      // The engine also teleports on kickoff restarts; that is not physics.
      if (b.pos.x === 0 && b.pos.y === 0 && b.speed.x === 0 && b.speed.y === 0) { cutByEngine++; break; }

      if (Math.abs(b.speed.x - prev.vx * ballSpec.damping) > 1e-9 ||
          Math.abs(b.speed.y - prev.vy * ballSpec.damping) > 1e-9) bounceTicks++;
      prev = { vx: b.speed.x, vy: b.speed.y };

      const err = Math.hypot(b.pos.x - pred.points[t].x, b.pos.y - pred.points[t].y);
      errs.push(err);
      if (err > worst) {
        worst = err;
        wc = { trial, t, start: [+sx.toFixed(1), +sy.toFixed(1)], v0: [+vel.x.toFixed(2), +vel.y.toFixed(2)],
               engine: [+b.pos.x.toFixed(4), +b.pos.y.toFixed(4)],
               pred: [+pred.points[t].x.toFixed(4), +pred.points[t].y.toFixed(4)] };
      }
    }
  }

  errs.sort((a, b) => a - b);
  const q = (f) => errs[Math.min(errs.length - 1, Math.floor(errs.length * f))];

  console.log(`samples ${errs.length}, ticks containing a bounce ${bounceTicks}, trials cut by an engine reset ${cutByEngine}/${TRIALS}`);
  console.log(`error  median ${q(0.5).toExponential(2)}   p99 ${q(0.99).toExponential(2)}   max ${worst.toExponential(3)}`);
  if (wc) console.log('worst:', JSON.stringify(wc));

  const pass = bounceTicks > 100 && q(0.99) < 1e-9 && worst < 1e-6;
  console.log(`${pass ? 'PASS' : 'FAIL'} — predictor ${pass ? 'reproduces' : 'does NOT reproduce'} engine arithmetic on this stadium`);
  return { label, name: st.name, pass, p99: q(0.99), worst, bounceTicks };
}

const results = stadiumsToRun().map(runStadium);

console.log('\n================ summary ================');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(30)} p99 ${r.p99.toExponential(2)}  max ${r.worst.toExponential(2)}  bounces ${r.bounceTicks}`);
}
const allPass = results.every((r) => r.pass);
console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(allPass ? 0 : 1);
