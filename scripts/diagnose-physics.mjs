/**
 * diagnose-physics.mjs
 *
 * Works out what the engine ACTUALLY does, from a recorded session, instead of
 * assuming. Run this when validate-zone.mjs fails.
 *
 * It answers four questions, each independently:
 *
 *   1. Are recorded frames consecutive? (a gap distribution)
 *   2. Is position integrated with the new velocity or the old one?
 *   3. What damping does the data imply? (fitted from coasting frames)
 *   4. What acceleration does the data imply? (fitted from input frames)
 *
 * Fitted values are then compared against the stadium's declared
 * `playerPhysics`. A mismatch tells you which constant is wrong rather than
 * leaving you to guess from an overshoot number.
 *
 * Usage:
 *   node scripts/diagnose-physics.mjs <session.ndjson>
 */

import fs from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("usage: node scripts/diagnose-physics.mjs <session.ndjson>");
  process.exit(1);
}

// ---------- collision flags ----------

/**
 * node-haxball's CollisionFlags, read from its own decoder in src/api.js.
 * A collision between a and b happens only when BOTH directions match:
 *
 *   ((a.cMask & b.cGroup) > 0) && ((b.cMask & a.cGroup) > 0)
 */
const FLAGS = [
  ["ball", 1], ["red", 2], ["blue", 4], ["redKO", 8], ["blueKO", 16],
  ["wall", 32], ["kick", 64], ["score", 128], ["c0", 1 << 28], ["c1", 1 << 29],
];

const decodeFlags = (m) => {
  if (m == null) return "(undefined)";
  const on = FLAGS.filter(([, bit]) => (m & bit) !== 0).map(([n]) => n);
  return on.length ? on.join("|") : "none";
};

/**
 * A cMask of 0 means COLLIDES WITH NOTHING. It is not "unspecified".
 *
 * See the note in scripts/validate-zone.mjs and DOMAIN.md pitfall 2 for the
 * evidence, which reverses what this file used to say. Short version: the
 * engine guards every collision with a raw `cMask & cGroup` test in which zero
 * is falsy, and `traits.line` is `{"cMask": []}` on most custom maps, so every
 * decorative line arrives here with a zero mask and is ignored by the engine.
 */
const CMASK_DEFAULT = 63;
const effectiveMask = (m) => (m == null ? CMASK_DEFAULT : m);

const TEAM_BITS = 2 | 4; // red | blue

// ---------- input decoding (mirrors node-haxball's own movement code) ----------

const SQRT1_2 = 1 / Math.SQRT2;

function inputDirection(input) {
  let dx = ((input & 8) > 0 ? 1 : 0) - ((input & 4) > 0 ? 1 : 0);
  let dy = ((input & 2) > 0 ? 1 : 0) - ((input & 1) > 0 ? 1 : 0);
  if (dx !== 0 && dy !== 0) {
    dx *= SQRT1_2;
    dy *= SQRT1_2;
  }
  return { dx, dy, moving: dx !== 0 || dy !== 0 };
}

// ---------- load ----------

const geometries = new Map();
const framesByVersion = new Map();

for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.type === "geometry") geometries.set(r.geometryVersion, r);
  else if (r.type === "frame") {
    let m = framesByVersion.get(r.geometryVersion);
    if (!m) framesByVersion.set(r.geometryVersion, (m = new Map()));
    m.set(r.frameNo, r);
  }
}

const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`\nSession: ${filePath}`);

for (const [version, byNo] of framesByVersion) {
  const geom = geometries.get(version);
  const pp = geom?.playerPhysics ?? {};
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Geometry v${version}: ${geom?.name}`);
  console.log(`  declared playerPhysics:`);
  console.log(`    acceleration        ${pp.acceleration}`);
  console.log(`    damping             ${pp.damping}`);
  console.log(`    kickingAcceleration ${pp.kickingAcceleration}`);
  console.log(`    kickingDamping      ${pp.kickingDamping}`);
  console.log(`    radius              ${pp.radius}`);
  console.log(`    invMass             ${pp.invMass}`);
  console.log(`    gravity             ${JSON.stringify(pp.gravity)}`);

  // ---- 0. what actually blocks what ----
  // On many maps the boundary segments accept the ball but NOT players, so
  // players run straight through the wall while the ball cannot. Anything
  // that treats "wall" as a universal constraint is wrong on those maps.
  const boundaries = [
    ...(geom?.segments ?? []).map((s) => ({ kind: "segment", ...s })),
    ...(geom?.planes ?? []).map((p) => ({ kind: "plane", ...p })),
    // Static discs are collision geometry too — goal posts, and on custom
    // maps entire barriers built from discs. Index 0 is the ball template.
    ...(geom?.discs ?? []).filter((d) => d.index !== 0).map((d) => ({ kind: "disc", ...d })),
  ];
  const hasDiscs = (geom?.discs ?? []).length > 0;
  let blocksBall = 0;
  let blocksPlayers = 0;
  let blocksBoth = 0;
  let blocksNeither = 0;
  for (const b of boundaries) {
    const m = effectiveMask(b.cMask);
    const ball = (m & 1) !== 0;
    const players = (m & TEAM_BITS) !== 0;
    if (ball && players) blocksBoth++;
    else if (ball) blocksBall++;
    else if (players) blocksPlayers++;
    else blocksNeither++;
  }
  console.log(`\n0. COLLISION MASKS  (${boundaries.length} segments + planes)`);
  console.log(`   block ball AND players: ${blocksBoth}`);
  console.log(`   block ball ONLY:        ${blocksBall}   <- players pass through these`);
  console.log(`   block players ONLY:     ${blocksPlayers}`);
  console.log(`   block neither:          ${blocksNeither}`);
  console.log(`   playerPhysics.cGroup:   ${pp.cGroup} = ${decodeFlags(pp.cGroup)}`);
  const distinct = [...new Set(boundaries.map((b) => b.cMask))].slice(0, 8);
  console.log(`   distinct cMask values:  ${distinct.map((m) => `${m} (${m === 0 ? "unspecified -> all" : decodeFlags(m)})`).join(", ")}`);

  // The actual geometry of everything that blocks players. If a player is
  // observed stopping somewhere with no boundary listed near it, this set is
  // incomplete and any "near a wall" test built on it is wrong.
  const playerBlocking = boundaries.filter((b) => (effectiveMask(b.cMask) & TEAM_BITS) !== 0);
  // Kick-off-only barriers: cGroup carries redKO/blueKO, so they stop players
  // only until the kick-off event fires. During open play they are not there.
  const KO_BITS = 8 | 16;
  const koOnly = playerBlocking.filter((b) => (b.cGroup & KO_BITS) !== 0 && (b.cGroup & 32) === 0);
  if (koOnly.length) {
    console.log(`   (${koOnly.length} of these are kick-off-only: cGroup has redKO/blueKO)`);
  }

  // Everything the BALL collides with but players do not. A ball pinned
  // against one of these stops a player at radius(player)+radius(ball) from
  // it — a constraint that appears nowhere in the player-blocking set.
  const ballOnly = boundaries.filter((b) => (effectiveMask(b.cMask) & 1) !== 0 && (effectiveMask(b.cMask) & TEAM_BITS) === 0);
  if (ballOnly.length) {
    console.log(`\n   ball-only boundaries (${ballOnly.length}) — players pass, ball does not:`);
    for (const b of ballOnly.slice(0, 12)) {
      if (b.kind === "segment") {
        console.log(
          `     segment (${b.v0.x.toFixed(1)}, ${b.v0.y.toFixed(1)}) -> ` +
            `(${b.v1.x.toFixed(1)}, ${b.v1.y.toFixed(1)})`
        );
      } else if (b.kind === "plane") {
        console.log(`     plane   normal (${b.normal.x.toFixed(3)}, ${b.normal.y.toFixed(3)})  dist=${b.dist}`);
      } else {
        console.log(`     disc    centre (${b.pos.x.toFixed(1)}, ${b.pos.y.toFixed(1)})  r=${b.radius}`);
      }
    }
    if (ballOnly.length > 12) console.log(`     ... and ${ballOnly.length - 12} more`);
  }

  console.log(`\n   boundaries that block players (${playerBlocking.length}):`);
  for (const b of playerBlocking.slice(0, 30)) {
    if (b.kind === "segment") {
      const curve = b.curveF ? `  curveF=${b.curveF}` : "";
      console.log(
        `     segment (${b.v0.x.toFixed(1)}, ${b.v0.y.toFixed(1)}) -> ` +
          `(${b.v1.x.toFixed(1)}, ${b.v1.y.toFixed(1)})  cMask=${b.cMask} cGroup=${b.cGroup}${curve}`
      );
    } else if (b.kind === "plane") {
      console.log(
        `     plane   normal (${b.normal.x.toFixed(3)}, ${b.normal.y.toFixed(3)})  ` +
          `dist=${b.dist}  cMask=${b.cMask}`
      );
    } else {
      console.log(
        `     disc    centre (${b.pos.x.toFixed(1)}, ${b.pos.y.toFixed(1)})  ` +
          `r=${b.radius}  cMask=${b.cMask}  ${b.invMass === 0 ? "static" : `invMass=${b.invMass}`}`
      );
    }
  }
  if (playerBlocking.length > 30) console.log(`     ... and ${playerBlocking.length - 30} more`);
  console.log(`   stadium width x height: ${geom?.width} x ${geom?.height}`);
  if (!hasDiscs) {
    console.log(`\n   !! This session has NO stadium discs recorded.`);
    console.log(`      Either the map genuinely has none, or it was captured before`);
    console.log(`      gameStateExtractor started reading stadium.discs. Goal posts and`);
    console.log(`      disc-built barriers are real collision geometry; if players are`);
    console.log(`      observed stopping where no segment or plane sits, this is why.`);
  }

  // Where do players actually come to rest? A hard clamp shows up as a spike
  // in the extreme coordinates, and tells you where the real boundary is.
  const xs = [];
  const ys = [];
  for (const fr of byNo.values()) {
    for (const p of fr.players ?? []) {
      if (p.inGame && p.pos) {
        xs.push(p.pos.x);
        ys.push(p.pos.y);
      }
    }
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const extremes = (arr) =>
    `min ${arr[0].toFixed(2)}, max ${arr[arr.length - 1].toFixed(2)}`;
  console.log(`\n   observed player positions: x ${extremes(xs)} | y ${extremes(ys)}`);

  // Find the constraint surfaces EMPIRICALLY rather than trusting the
  // geometry list. A player pushing into something has that velocity
  // component killed while the input still points at it — so the positions
  // where that happens are where the real boundaries are, whatever the
  // stadium data does or does not say.
  const stopsX = new Map();
  const stopsY = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const fno of [...byNo.keys()].sort((a, b) => a - b)) {
    const a = byNo.get(fno);
    const b = byNo.get(fno + 1);
    if (!a || !b || a.playState !== 1) continue;
    const later = new Map(b.players.map((p) => [p.id, p]));
    for (const p of a.players) {
      const q = later.get(p.id);
      if (!p.inGame || !q?.inGame || !p.vel || !q.vel || !q.pos) continue;
      const u = inputDirection(p.input ?? 0);
      // velocity killed on an axis the player is actively pushing into
      if (u.dx !== 0 && Math.abs(p.vel.x) > 0.5 && Math.abs(q.vel.x) < 0.05) {
        bump(stopsX, Math.round(q.pos.x));
      }
      if (u.dy !== 0 && Math.abs(p.vel.y) > 0.5 && Math.abs(q.vel.y) < 0.05) {
        bump(stopsY, Math.round(q.pos.y));
      }
    }
  }

  const topStops = (map) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  console.log(`\n   WHERE PLAYERS ACTUALLY STOP (velocity killed while pushing in)`);
  console.log(`   x: ${topStops(stopsX).map(([v, n]) => `${v} (${n}x)`).join(", ") || "none"}`);
  console.log(`   y: ${topStops(stopsY).map(([v, n]) => `${v} (${n}x)`).join(", ") || "none"}`);
  console.log(`   Add the player radius (${pp.radius}) to get the surface position.`);
  console.log(`   Anything here with no matching boundary above is missing geometry.`);
  if (blocksBall > 0 && blocksBoth === 0) {
    console.log(`   => PLAYERS ARE NOT CONSTRAINED BY THE PITCH BOUNDARY ON THIS MAP.`);
    console.log(`      Walls bound the ball only. Any "distance to wall" used as a`);
    console.log(`      constraint on player movement is meaningless here.`);
  }

  const frameNos = [...byNo.keys()].sort((a, b) => a - b);

  // ---- 1. frame continuity ----
  const gaps = {};
  for (let i = 1; i < frameNos.length; i++) {
    const g = frameNos[i] - frameNos[i - 1];
    gaps[g] = (gaps[g] ?? 0) + 1;
  }
  console.log(`\n1. FRAME CONTINUITY  (${frameNos.length} frames)`);
  for (const [g, n] of Object.entries(gaps).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`   gap of ${g} tick(s): ${n}`);
  }

  // ---- collect consecutive pairs ----
  const pairs = [];
  for (const fno of frameNos) {
    const a = byNo.get(fno);
    const b = byNo.get(fno + 1);
    if (!a || !b) continue;
    if (a.playState !== 1 || b.playState !== 1) continue;
    const later = new Map(b.players.map((p) => [p.id, p]));
    for (const p of a.players) {
      const q = later.get(p.id);
      if (!p.inGame || !q?.inGame || !p.pos || !p.vel || !q.pos || !q.vel) continue;
      pairs.push({ p, q });
    }
  }
  console.log(`   usable consecutive player-pairs: ${pairs.length}`);
  if (!pairs.length) continue;

  // ---- 2. integration order ----
  // Is p(t+1) - p(t) equal to v(t+1) (velocity-first) or v(t) (position-first)?
  let errNew = [];
  let errOld = [];
  for (const { p, q } of pairs) {
    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    errNew.push(Math.hypot(dx - q.vel.x, dy - q.vel.y));
    errOld.push(Math.hypot(dx - p.vel.x, dy - p.vel.y));
  }
  console.log(`\n2. INTEGRATION ORDER   (median residual, lower wins)`);
  console.log(`   p(t+1)-p(t) vs v(t+1)  [velocity first]: ${median(errNew).toExponential(3)}`);
  console.log(`   p(t+1)-p(t) vs v(t)    [position first]: ${median(errOld).toExponential(3)}`);
  const velocityFirst = median(errNew) < median(errOld);
  console.log(`   => ${velocityFirst ? "velocity-first (p += v_new)" : "position-first (p += v_old)"}`);

  // ---- 3. damping, fitted from coasting frames ----
  // No movement input => v(t+1) should be exactly v(t) * damping.
  const fitD = { normal: [], kicking: [] };
  for (const { p, q } of pairs) {
    if (inputDirection(p.input ?? 0).moving) continue;
    const s0 = Math.hypot(p.vel.x, p.vel.y);
    const s1 = Math.hypot(q.vel.x, q.vel.y);
    if (s0 < 0.05) continue; // too slow to measure a ratio reliably
    (p.isKicking ? fitD.kicking : fitD.normal).push(s1 / s0);
  }
  console.log(`\n3. DAMPING  (fitted from coasting frames, no movement input)`);
  console.log(`   not kicking: median ${median(fitD.normal).toFixed(5)}  (n=${fitD.normal.length})  declared ${pp.damping}`);
  console.log(`   kicking:     median ${median(fitD.kicking).toFixed(5)}  (n=${fitD.kicking.length})  declared ${pp.kickingDamping}`);

  const dFit = Number.isFinite(median(fitD.normal)) ? median(fitD.normal) : pp.damping;

  // ---- 4. acceleration, fitted from input frames ----
  // v(t+1) = v(t)*d + a*u  =>  a = |v(t+1) - v(t)*d|, and the residual
  // direction should line up with the decoded input direction.
  const fitA = { normal: [], kicking: [] };
  const dirDot = [];
  for (const { p, q } of pairs) {
    const u = inputDirection(p.input ?? 0);
    if (!u.moving) continue;
    const d = p.isKicking ? (Number.isFinite(median(fitD.kicking)) ? median(fitD.kicking) : dFit) : dFit;
    const ax = q.vel.x - p.vel.x * d;
    const ay = q.vel.y - p.vel.y * d;
    const mag = Math.hypot(ax, ay);
    (p.isKicking ? fitA.kicking : fitA.normal).push(mag);
    if (mag > 1e-6) dirDot.push((ax * u.dx + ay * u.dy) / mag);
  }
  console.log(`\n4. ACCELERATION  (fitted as |v(t+1) - v(t)*d| on input frames)`);
  console.log(`   not kicking: median ${median(fitA.normal).toFixed(5)}  (n=${fitA.normal.length})  declared ${pp.acceleration}`);
  console.log(`   kicking:     median ${median(fitA.kicking).toFixed(5)}  (n=${fitA.kicking.length})  declared ${pp.kickingAcceleration}`);
  console.log(`   input-direction agreement: median cos ${median(dirDot).toFixed(4)}  (1.0 = input decoding correct)`);

  // ---- 5. observed speeds vs predicted terminal speed ----
  const speeds = pairs.map(({ p }) => Math.hypot(p.vel.x, p.vel.y));
  speeds.sort((a, b) => a - b);
  const p99 = speeds[Math.floor(speeds.length * 0.99)];
  const declaredTerminal = pp.acceleration / (1 - pp.damping);
  const fittedTerminal = median(fitA.normal) / (1 - dFit);
  console.log(`\n5. SPEED SANITY`);
  console.log(`   observed 99th pct speed:   ${p99.toFixed(4)} units/tick`);
  console.log(`   terminal from declared:    ${declaredTerminal.toFixed(4)}`);
  console.log(`   terminal from fitted:      ${fittedTerminal.toFixed(4)}`);
  console.log(
    `   => ${p99 > declaredTerminal * 1.05 ? "PLAYERS EXCEED THE DECLARED TERMINAL SPEED — declared constants are wrong" : "consistent with declared constants"}`
  );
}

console.log("");
