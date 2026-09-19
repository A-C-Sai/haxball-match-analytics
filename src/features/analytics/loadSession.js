/**
 * loadSession.js
 *
 * For OFFLINE analysis only — run standalone with `node`, separate from the
 * NW.js client (e.g. `node --experimental-vm-modules` isn't needed, this is
 * plain ESM, matching this project's package.json "type":"module"). Reads
 * back an .ndjson session file written by SnapshotLogger and groups frames
 * by `geometryVersion`, so a map change mid-session (which can change
 * geometry, default player physics, and even ball properties on some custom
 * maps) never gets silently mixed across geometries in your analysis.
 *
 * Usage (from anywhere, e.g. a standalone scripts/ folder outside the app):
 *   import { loadSession } from "./loadSession.js";
 *   const s = loadSession("./analytics-sessions/session-....ndjson");
 *   console.log(s.geometries.map(g => [g.geometryVersion, g.name]));
 *   console.log(s.framesByVersion.get(1)?.length, "frames used geometry v1");
 */

import fs from "fs";

/**
 * @param {string} filePath
 * @returns {{
 *   geometries: Array<Object>,               // one entry per geometry version, in order
 *   geometryByVersion: Map<number, Object>,   // version -> geometry record
 *   framesByVersion: Map<number, Object[]>,   // version -> frames recorded while it was active
 *   allFrames: Object[],                      // every frame, in original order
 * }}
 */
export function loadSession(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const geometries = [];
  const geometryByVersion = new Map();
  const framesByVersion = new Map();
  const allFrames = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);

    if (record.type === "geometry") {
      geometries.push(record);
      geometryByVersion.set(record.geometryVersion, record);
      if (!framesByVersion.has(record.geometryVersion)) {
        framesByVersion.set(record.geometryVersion, []);
      }
    } else if (record.type === "frame") {
      allFrames.push(record);
      const bucket = framesByVersion.get(record.geometryVersion);
      if (bucket) bucket.push(record);
      else framesByVersion.set(record.geometryVersion, [record]); // frame arrived before its geometry line, shouldn't happen but don't drop data
    }
  }

  return { geometries, geometryByVersion, framesByVersion, allFrames };
}
