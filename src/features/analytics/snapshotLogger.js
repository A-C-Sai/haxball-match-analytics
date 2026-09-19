/**
 * snapshotLogger.js
 *
 * Writes one NDJSON (newline-delimited JSON) file per session:
 *   - first line: { type: "geometry", ... }               (stadium, once per stadium load)
 *   - every subsequent line: { type: "frame", ... }        (one per game tick)
 *
 * That single file is exactly what you share with me for offline analysis —
 * self-describing, no separate geometry file to keep track of.
 *
 * Uses window.require(...) rather than ESM `import fs from 'fs'` because
 * that's how this codebase already accesses Node built-ins from renderer
 * code under NW.js (see src/utils/screenResolution.js,
 * src/themes/ThemeContext.jsx) — Vite's dev server can't resolve bare
 * `fs`/`path` imports itself, but NW.js exposes a real `window.require`.
 */

const fs = window.require("fs");
const path = window.require("path");
const process = window.require("process");

export class SnapshotLogger {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] directory to write the session file into.
   *   Defaults to "<project root>/analytics-sessions" (project root = the
   *   cwd the app was launched from, which `npm run dev` sets to the repo
   *   root — see scripts/run-nw.js).
   * @param {number} [opts.consoleHeartbeatTicks=60] log a one-line summary
   *   to the devtools console every N ticks (~1s at 60 ticks/s) so you can
   *   watch it live in F12 without flooding the console every tick.
   * @param {number} [opts.sampleEveryNTicks=1] only record every Nth tick
   *   to disk, if you want to shrink file size for longer sessions.
   */
  constructor(opts = {}) {
    const {
      dir = path.join(process.cwd(), "analytics-sessions"),
      consoleHeartbeatTicks = 60,
      sampleEveryNTicks = 1,
    } = opts;

    this.consoleHeartbeatTicks = consoleHeartbeatTicks;
    this.sampleEveryNTicks = sampleEveryNTicks;
    this._tickCount = 0;

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `session-${stamp}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });

    // Bumped every time writeGeometry() is called (i.e. every map/stadium
    // change). Stamped onto every record so an offline reader can always
    // tell which geometry a given frame belongs to, without guessing from
    // timestamps — maps can change mid-session (vote, admin swap, etc.),
    // and player radius/bCoef/ball properties can differ per map.
    this.geometryVersion = 0;

    // eslint-disable-next-line no-console
    console.log(
      `%c[haxball-analytics] recording to: ${this.filePath}`,
      "color:#4caf50;font-weight:bold;"
    );
  }

  /** Call once on join and again whenever the stadium changes. */
  writeGeometry(geometry) {
    this.geometryVersion += 1;
    this.stream.write(
      JSON.stringify({ type: "geometry", geometryVersion: this.geometryVersion, ...geometry }) + "\n"
    );
    // eslint-disable-next-line no-console
    console.log(
      `%c[haxball-analytics] geometry v${this.geometryVersion} captured:`,
      "color:#2196f3;font-weight:bold;",
      {
        stadium: geometry?.name,
        vertices: geometry?.vertices?.length,
        segments: geometry?.segments?.length,
        planes: geometry?.planes?.length,
        goals: geometry?.goals?.length,
        defaultPlayerRadius: geometry?.playerPhysics?.radius,
      }
    );
  }

  /** Call from onAfterGameTick with the extracted frame. */
  writeFrame(frame) {
    this._tickCount += 1;
    if (this._tickCount % this.sampleEveryNTicks !== 0) return;

    this.stream.write(
      JSON.stringify({ type: "frame", geometryVersion: this.geometryVersion, ...frame }) + "\n"
    );

    if (this._tickCount % this.consoleHeartbeatTicks === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[haxball-analytics] frame ${frame.frameNo} (geo v${this.geometryVersion}) | players=${frame.players.length} ` +
          `| ball=${frame.ball ? `(${frame.ball.pos.x.toFixed(0)},${frame.ball.pos.y.toFixed(0)})` : "n/a"} ` +
          `| score=${frame.redScore}-${frame.blueScore}`
      );
    }
  }

  /** Call on room leave / component unmount. */
  close() {
    // eslint-disable-next-line no-console
    console.log(`[haxball-analytics] session file closed: ${this.filePath}`);
    this.stream.end();
  }
}
