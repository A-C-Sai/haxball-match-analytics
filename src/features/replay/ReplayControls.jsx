import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * ReplayControls.jsx
 *
 * Transport bar for replay playback: play/pause, playback speed, and a
 * scrubber with a frame/time readout.
 *
 * Navigation is the scrubber plus the speed selector. Frame-stepping and
 * ±5s jump buttons were removed on request — with speeds from 0.1× to 16×,
 * slow-motion covers close inspection and the scrubber covers travel, so the
 * step buttons were a third way of doing the same job.
 *
 * One property of the format still shows through, and the "seeking…" state
 * exists because of it: node-haxball generates frames on the fly and never
 * stores them, so `setCurrentFrameNo(n)` fast-forwards from the current
 * position, and a target in the past means restarting from frame 0 and
 * re-simulating. Dragging the scrubber backwards therefore costs more the
 * deeper into the recording you are. A second seek is refused while one is
 * in flight, since overlapping seeks would fight each other.
 */

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

/** Haxball's physics rate — 1 tick = 1/60 s. */
const TICKS_PER_SECOND = 60;

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ReplayControls({ roomRef, fileName }) {
  const [frameNo, setFrameNo] = useState(0);
  const [maxFrameNo, setMaxFrameNo] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [seeking, setSeeking] = useState(false);

  // Mirrors of state for callbacks registered once, which would otherwise
  // close over stale values.
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // While dragging the scrubber, stop the poll overwriting the thumb, or it
  // snaps back under the cursor.
  const draggingRef = useRef(false);
  const [dragFrame, setDragFrame] = useState(null);

  const seekTo = useCallback((targetFrame, { keepPlaying = false } = {}) => {
    const room = roomRef.current;
    if (!room) return;
    const clamped = Math.min(Math.max(0, targetFrame), room.replay.maxFrameNo);
    // Pause first: letting playback advance during a seek makes the
    // destination a moving target.
    room.replay.setSpeed(0);
    setSeeking(true);
    room.replay.setCurrentFrameNo(clamped);
    if (keepPlaying) {
      room.replay.setSpeed(speedRef.current);
    } else {
      setPlaying(false);
      playingRef.current = false;
    }
  }, [roomRef]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    setMaxFrameNo(room.replay.maxFrameNo);

    const poll = setInterval(() => {
      const r = roomRef.current;
      if (!r) return;
      if (!draggingRef.current) setFrameNo(r.replay.getCurrentFrameNo());
    }, 100);

    room.replay.onDestinationTimeReached = () => {
      setSeeking(false);
      setFrameNo(roomRef.current?.replay.getCurrentFrameNo() ?? 0);
    };
    room.replay.onEnd = () => {
      setPlaying(false);
      playingRef.current = false;
      roomRef.current?.replay.setSpeed(0);
    };

    // Captured rather than read from the ref at cleanup: by then ReplayView
    // may already have nulled the ref while tearing the room down.
    const roomAtMount = room;
    return () => {
      clearInterval(poll);
      roomAtMount.replay.onDestinationTimeReached = null;
      roomAtMount.replay.onEnd = null;
    };
  }, [roomRef]);

  const applySpeed = (coefficient) => {
    setSpeed(coefficient);
    speedRef.current = coefficient;
    if (playingRef.current) roomRef.current?.replay.setSpeed(coefficient);
  };

  const togglePlay = () => {
    const room = roomRef.current;
    if (!room) return;
    if (playingRef.current) {
      room.replay.setSpeed(0);
      setPlaying(false);
      playingRef.current = false;
    } else {
      room.replay.setSpeed(speedRef.current);
      setPlaying(true);
      playingRef.current = true;
    }
  };

  const shownFrame = dragFrame ?? frameNo;
  const timeMs = (shownFrame / TICKS_PER_SECOND) * 1000;
  const totalMs = (maxFrameNo / TICKS_PER_SECOND) * 1000;

  return (
    <div className="replay-controls">
      <div className="replay-controls-row">
        {/* data-hook is how the Space shortcut in ReplayView reaches this
            button without lifting playback state out of this component. */}
        <button type="button" data-hook="replay-playpause" onClick={togglePlay} disabled={seeking}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>

        <label className="replay-controls-speed">
          Speed
          <select value={speed} onChange={(e) => applySpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </label>

        <span className="replay-controls-readout">
          {formatTime(timeMs)} / {formatTime(totalMs)} · frame {shownFrame} / {maxFrameNo}
          {seeking ? " · seeking…" : ""}
        </span>
      </div>

      <input
        className="replay-controls-scrubber"
        type="range"
        min={0}
        max={maxFrameNo}
        value={shownFrame}
        onMouseDown={() => { draggingRef.current = true; }}
        onChange={(e) => setDragFrame(Number(e.target.value))}
        onMouseUp={(e) => {
          draggingRef.current = false;
          const target = Number(e.target.value);
          setDragFrame(null);
          seekTo(target, { keepPlaying: playingRef.current });
        }}
      />

      {fileName ? <div className="replay-controls-filename">{fileName}</div> : null}
    </div>
  );
}
