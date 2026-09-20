/**
 * pendingReplay.js
 *
 * One-slot handoff for the .hbr2 the user just picked in RoomList, read on
 * this side of the navigation to /Replay.
 *
 * Why not react-router `location.state`: that state is written into the
 * history entry and has to survive serialization — a multi-megabyte
 * Uint8Array there is both wasteful and fragile (it would be re-cloned on
 * every back/forward). A module-scoped slot keeps the bytes in memory,
 * exactly once, and `takePendingReplay()` clears it so a refresh or a
 * direct visit to /Replay lands on "no replay loaded" instead of silently
 * replaying a stale file.
 */

let pending = null;

/** @param {{bytes: Uint8Array, fileName: string}} replay */
export function setPendingReplay(replay) {
  pending = replay;
}

/** Consumes and clears the slot. @returns {{bytes:Uint8Array,fileName:string}|null} */
export function takePendingReplay() {
  const p = pending;
  pending = null;
  return p;
}
