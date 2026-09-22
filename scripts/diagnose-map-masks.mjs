/**
 * diagnose-map-masks.mjs
 *
 * Does buildCollisionSet() agree with the engine about what is solid?
 *
 * Loads a .hbs stadium into a node-haxball sandbox, builds the ball's collision
 * set exactly as the overlays do, and reports every element the set admits that
 * the engine's own guard rejects (and vice versa).
 *
 * The guard, read straight out of the engine's physics step in
 * node-haxball/src/api.js — the same expression for discs, planes, segments
 * and vertices alike:
 *
 *     boundary.cMask & disc.cGroup  &&  boundary.cGroup & disc.cMask
 *
 * Raw, unnormalised, and 0 is falsy. There is no "0 means all" anywhere in it.
 * A decorative `trait: "line"` element carries `cMask: []` -> 0 and therefore
 * collides with nothing at all.
 *
 * Run:  node scripts/diagnose-map-masks.mjs test-maps/K_Futsal_Huge_6v.hbs
 *
 * Exit 0 when the set matches the engine, 1 when it does not.
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { buildCollisionSet } from '../src/features/analytics/ballTrajectory.js';

const require = createRequire(import.meta.url);
const API = require('node-haxball')(null, {});

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/diagnose-map-masks.mjs <map.hbs>');
  process.exit(2);
}

// Real .hbs files saved out of the Haxball map editor start with a UTF-8 BOM.
// node-haxball's parseStadium() tolerates it; JSON.parse() does not, and fails
// with a message that blames the first brace rather than the invisible
// character in front of it. Strip it once, here, rather than at each use.
const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
const json = JSON.parse(raw);

const room = API.Room.sandbox({}, { controlledPlayerId: 1 });
room.setSimulationSpeed(0);
// The sandbox's setCurrentStadium() is a queued fake event and does not apply
// under runSteps(); assigning before startGame() is what actually loads a map.
room.state.stadium = API.Utils.parseStadium(raw);
room.playerJoin(1, 'p', 'tr', '', '', '');
room.setPlayerTeam(1, 1, 0);
room.startGame(0);
room.runSteps(1);

const st = room.state.stadium;
if (st.name !== json.name) {
  console.error(`stadium failed to load: room has "${st.name}", file has "${json.name}"`);
  process.exit(2);
}

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

const proto = room.gameState.physicsState.discs[0];
const ball = { radius: proto.radius, bCoef: proto.bCoef, damping: proto.damping, cMask: proto.cMask, cGroup: proto.cGroup };

/** The engine's guard, verbatim. */
const engineCollides = (e) => (e.cMask & ball.cGroup) !== 0 && (e.cGroup & ball.cMask) !== 0;

console.log(`map:  ${json.name}`);
console.log(`ball: radius ${ball.radius}, cMask ${ball.cMask}, cGroup ${ball.cGroup}`);
console.log(`file: ${geometry.segments.length} segments, ${geometry.planes.length} planes, ` +
            `${geometry.vertices.length} vertices, ${geometry.discs.length} discs\n`);

const set = buildCollisionSet(geometry, ball);

// Whether the set admits one specific element is decided by running the real
// buildCollisionSet() over a geometry containing only that element. Matching
// output back to input by coordinates looks equivalent and is not: these maps
// stack a decorative line on the exact endpoints of a kickOffBarrier, so a key
// built from coordinates cannot tell the two apart and silently credits one
// with the other's verdict. Re-deriving the mask rule here would instead make
// the check circular. This does neither.
const admits = (kind, element) => buildCollisionSet({ [kind]: [element] }, ball)[kind].length > 0;

const describe = {
  segments: (s) => `(${s.v0.x.toFixed(0)},${s.v0.y.toFixed(0)}) -> (${s.v1.x.toFixed(0)},${s.v1.y.toFixed(0)})` +
                   `${Number.isFinite(s.curveF) && s.curveF !== 0 ? ' curved' : ''}`,
  vertices: (v) => `(${v.pos.x.toFixed(0)},${v.pos.y.toFixed(0)})`,
  planes: (p) => `n=(${p.normal.x},${p.normal.y}) dist=${p.dist}`,
  discs: (d) => `(${d.pos.x.toFixed(0)},${d.pos.y.toFixed(0)}) r=${d.radius}`,
};
// Traits come from the raw JSON in file order, which is the order the engine
// parses them in. Vertices live under "vertexes" in the stadium format.
const rawOf = { segments: json.segments, vertexes: json.vertexes, planes: json.planes, discs: json.discs };
const rawKey = { segments: 'segments', vertices: 'vertexes', planes: 'planes', discs: 'discs' };

let disagreements = 0;

for (const kind of ['segments', 'planes', 'vertices', 'discs']) {
  const source = kind === 'discs' ? geometry.discs.filter((d) => d.invMass === 0) : geometry[kind];
  const rawList = rawOf[rawKey[kind]] ?? [];
  const engineWants = source.filter(engineCollides);

  const phantom = [];   // in the set, engine says no
  const missing = [];   // engine says yes, not in the set
  source.forEach((e, i) => {
    const present = admits(kind, e);
    const wanted = engineCollides(e);
    if (present && !wanted) phantom.push({ i, e });
    if (!present && wanted) missing.push({ i, e });
  });

  const status = phantom.length || missing.length ? 'MISMATCH' : 'ok';
  console.log(`${kind.padEnd(9)} set ${String(set[kind].length).padStart(3)}   engine ${String(engineWants.length).padStart(3)}   ${status}`);

  for (const [label, list] of [['phantom (drawn as solid, is not)', phantom], ['missing (is solid, not drawn)', missing]]) {
    if (!list.length) continue;
    disagreements += list.length;
    const byTrait = {};
    for (const { i } of list) {
      const t = rawList[i]?.trait ?? '(none)';
      byTrait[t] = (byTrait[t] ?? 0) + 1;
    }
    console.log(`  ${list.length} ${label}`);
    console.log(`    by trait: ${Object.entries(byTrait).map(([t, n]) => `${t} x${n}`).join(', ')}`);
    for (const { i, e } of list.slice(0, 6)) {
      console.log(`    [${i}] trait=${rawList[i]?.trait ?? '(none)'} cMask=${e.cMask} cGroup=${e.cGroup}  ${describe[kind](e)}`);
    }
    if (list.length > 6) console.log(`    ... and ${list.length - 6} more`);
  }
}

console.log(disagreements
  ? `\nFAIL — ${disagreements} elements where the collision set disagrees with the engine.`
  : '\nPASS — the collision set matches the engine exactly.');

process.exit(disagreements ? 1 : 0);
