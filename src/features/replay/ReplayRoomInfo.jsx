import React from "react";

/**
 * ReplayRoomInfo.jsx
 *
 * Read-only room panel (Escape / Menu), styled to match the live game's room
 * view exactly.
 *
 * It does that by rendering the *same markup and class names* the live panel
 * uses — `room-view` > `container` > `teams` > `player-list-view
 * t-red|t-spec|t-blue` > `buttons` + `list` > `player-list-item` (with
 * `.admin`) — so every existing rule in game.css applies to it untouched.
 * That includes centring (`.room-view` is already a centred flexbox filling
 * its section), panel chrome, team column widths, the team-coloured header
 * buttons, and the `--text-admin` colour on admin names. No CSS of its own.
 *
 * Details that exist purely to match the live panel, and matter:
 *   - Column order is Red, **Spectators**, Blue — the same as RoomHeader.
 *     Red/Blue/Spectators looks wrong because the live panel puts the
 *     neutral column in the middle.
 *   - The team header is a `button[data-hook=join-btn]`, not a span, because
 *     that is what game.css colours per team (`.t-red  button[data-hook=
 *     join-btn] { color: var(--team-red-text) }`). It is disabled — there is
 *     nothing to join in a recording.
 *   - Each row keeps its `[data-hook=ping]` cell, showing the player's live
 *     ping. The name cell is `flex: 1` and ping is a fixed 30px right-aligned
 *     column, so leaving it empty changes how every row lays out. Recordings
 *     carry periodic ping events, so this value moves as playback advances —
 *     ReplayView polls the roster while the panel is open to keep it current.
 *   - Time and score limits render as disabled `<select>`s, matching
 *     RoomHeader. That is what gives them the inset darker field the live
 *     panel has; plain text in a `.val` span has no background. They are
 *     numbers, 0 meaning no limit — the same convention the live selects use
 *     — not the word "none".
 *   - Row order matches RoomHeader: time limit, score limit, stadium.
 *
 * Why not mount `RoomHeader`/`PlayerListView` themselves: those are built to
 * *act* on a live room — Rec/Link/Leave, join and reset-team buttons,
 * drag-to-move players between teams, and a right-click admin popup reading
 * `room.currentPlayer`. A replay has no local player and cannot be mutated,
 * so those would be a panel of dead controls.
 */

/** Same order as RoomHeader: red, spectators, blue. */
const TEAMS = [
  { id: 1, label: "Red", className: "t-red" },
  { id: 0, label: "Spectators", className: "t-spec" },
  { id: 2, label: "Blue", className: "t-blue" },
];

export default function ReplayRoomInfo({ roomName, stadiumName, players, timeLimit, scoreLimit }) {
  return (
    <div className="room-view" style={{ display: "flex" }}>
      <div className="container">
        <h1 data-hook="room-name">{roomName}</h1>

        <div className="teams">
          {TEAMS.map(({ id, label, className }) => {
            const roster = players.filter((p) => (p.team?.id ?? 0) === id);
            return (
              <div key={id} className={`player-list-view ${className}`}>
                <div className="buttons">
                  <button type="button" data-hook="join-btn" disabled>
                    {label} ({roster.length})
                  </button>
                </div>
                <div className="list thin-scrollbar" data-hook="list">
                  {roster.map((p) => (
                    <div
                      key={p.id}
                      className={`player-list-item${p.isAdmin ? " admin" : ""}`}
                    >
                      <div data-hook="flag" className={`flagico f-${p.flag}`}></div>
                      <div data-hook="name">{p.name}</div>
                      <div data-hook="ping">{p.ping ?? ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="settings">
          <div>
            <label className="lbl">Time limit</label>
            <select data-hook="time-limit-sel" value={timeLimit} onChange={() => {}} disabled>
              <option value={timeLimit}>{timeLimit}</option>
            </select>
          </div>
          <div>
            <label className="lbl">Score limit</label>
            <select data-hook="score-limit-sel" value={scoreLimit} onChange={() => {}} disabled>
              <option value={scoreLimit}>{scoreLimit}</option>
            </select>
          </div>
          <div>
            <label className="lbl">Stadium</label>
            <label className="val" data-hook="stadium-name">{stadiumName}</label>
          </div>
        </div>
      </div>
    </div>
  );
}
