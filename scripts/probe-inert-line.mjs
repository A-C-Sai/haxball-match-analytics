/**
 * probe-inert-line.mjs
 *
 * Does a player actually stop at a decorative `cMask: 0` line?
 *
 * DOMAIN.md pitfall 2 records an observation — players stopping dead at
 * x = +/-405, one player radius short of segments at x = +/-420 carrying
 * cMask 0 — and concludes from it that 0 must mean "all". K Futsal Huge has
 * decorative lines at exactly x = +/-420, so the claim can be run rather than
 * argued about.
 *
 * Drives a player at the line in the real engine and reports where it ends up.
 *
 * Run:  node scripts/probe-inert-line.mjs [map.hbs] [targetX]
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const API = require('node-haxball')(null, {});

const mapPath = process.argv[2] ?? 'test-maps/K_Futsal_Huge_6v.hbs';
const targetX = Number(process.argv[3] ?? 420);

const raw = readFileSync(mapPath, 'utf8');
const room = API.Room.sandbox({}, { controlledPlayerId: 1 });
room.setSimulationSpeed(0);
room.state.stadium = API.Utils.parseStadium(raw);
room.playerJoin(1, 'p', 'tr', '', '', '');
room.setPlayerTeam(1, 1, 0);
room.startGame(0);
room.runSteps(1);

const st = room.state.stadium;
const stadiumDiscs = (st.discs ?? []).length;
const ps = room.gameState.physicsState;
const player = ps.discs[stadiumDiscs];

console.log(`map: ${st.name}`);
console.log(`player radius ${player.radius}, cMask ${player.cMask}, cGroup ${player.cGroup}\n`);

// What is at targetX, and what does it claim to collide with?
const here = (x) => Math.abs(x - targetX) < 1;
const atX = [
  ...st.segments
    .map((s, i) => ({ kind: 'segment', i, x0: s.v0.pos.x, x1: s.v1.pos.x, cMask: s.cMask, cGroup: s.cGroup }))
    .filter((s) => here(s.x0) && here(s.x1)),
  ...st.vertices
    .map((v, i) => ({ kind: 'vertex', i, x0: v.pos.x, x1: v.pos.x, cMask: v.cMask, cGroup: v.cGroup }))
    .filter((v) => here(v.x0)),
  ...st.planes
    .map((p, i) => ({ kind: 'plane', i, x0: p.dist, x1: p.dist, cMask: p.cMask, cGroup: p.cGroup, normal: [p.normal.x, p.normal.y] }))
    .filter((p) => Math.abs(p.normal.x) > 0.5 && here(Math.abs(p.dist))),
];
console.log(`geometry at x = ${targetX}:`);
for (const g of atX) console.log(`  ${g.kind} [${g.i}] cMask=${g.cMask} cGroup=${g.cGroup}`);
if (!atX.length) console.log('  (none)');

// Coast the player straight at it. No input: one shove, then let damping do
// the rest, so nothing is being pushed through by brute force. Player damping
// is 0.96, so total travel from speed v is v/(1-0.96) = 25v — speed 12 carries
// it 300 units, comfortably past the 120 it needs.
const START = targetX - 120;
player.pos.x = START;
player.pos.y = 0;
player.speed.x = 12;
player.speed.y = 0;

let maxX = player.pos.x;
const TICKS = 400;
for (let t = 0; t < TICKS; t++) {
  room.runSteps(1);
  const live = room.gameState.physicsState.discs[stadiumDiscs];
  if (!live) break;
  if (live.pos.x > maxX) maxX = live.pos.x;
}

const edge = maxX + player.radius;
console.log(`\nstarted at x = ${START.toFixed(1)}, ran right for ${TICKS} ticks`);
console.log(`furthest centre reached: x = ${maxX.toFixed(2)}  (leading edge x = ${edge.toFixed(2)})`);

const stoppedShort = Math.abs(maxX - (targetX - player.radius)) < 2;
const passedThrough = maxX > targetX + player.radius;

if (stoppedShort) {
  console.log(`\nSTOPPED one radius short of ${targetX}: the line blocks players.`);
} else if (passedThrough) {
  console.log(`\nPASSED THROUGH x = ${targetX}: the line does not block players.`);
} else {
  console.log(`\nStopped at ${maxX.toFixed(2)}, which is neither. Something else is in the way.`);
}
process.exit(0);
