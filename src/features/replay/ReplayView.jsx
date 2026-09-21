import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import defaultRenderer from "../game/renderer.js";
import GameCanvas from "../game/components/GameCanvas.jsx";
import GameStateGUI from "../game/components/GameStateGUI.jsx";
import OverlayControls from "../game/components/OverlayControls.jsx";
import ChatBox from "../game/components/ChatBox.jsx";
import SoundButton from "../game/components/SoundButton.jsx";
import Popup from "../../components/Popup.jsx";
import ReplaySettingsPopup from "./ReplaySettingsPopup.jsx";
import ReplayControls from "./ReplayControls.jsx";
import ReplayRoomInfo from "./ReplayRoomInfo.jsx";
import { createReplayRoom } from "./replayRoomAdapter.js";
import { takePendingReplay } from "./pendingReplay.js";
import useHaxballAnalytics from "../analytics/useHaxballAnalytics.js";
import { usePlayerData } from "../../hooks/usePlayerData.jsx";
import { loadImage } from "../../utils/loadImage.js";
import grass from "../../assets/images/grass.png";
import concrete from "../../assets/images/concrete.png";
import concrete2 from "../../assets/images/concrete2.png";
import typing from "../../assets/images/typing.png";
import chatSnd from "../../assets/sounds/chat.ogg";
import goalSnd from "../../assets/sounds/goal.ogg";
import highlightSnd from "../../assets/sounds/highlight.wav";
import joinSnd from "../../assets/sounds/join.ogg";
import kickSnd from "../../assets/sounds/kick.ogg";
import leaveSnd from "../../assets/sounds/leave.ogg";
import {
  estimateModerateSpeedThreshold,
  estimateBallSpeedThreshold,
  getMomentumDirections,
  getBallMomentumDirection,
  drawMomentumArrows,
} from "../analytics/momentumOverlay.js";
import { computeBallTrace, drawBallTrace, blockersFromFrame } from "../analytics/ballTrajectoryOverlay.js";
import { computeAimAssist, drawAimAssist } from "../analytics/aimAssistOverlay.js";

/**
 * ReplayView.jsx
 *
 * Offline playback of a .hbr2 recording using the *same* renderer, overlay
 * canvas, chat box, scoreboard and analytics hook as a live room — a feature
 * built here needs no changes to work live, and vice versa. All the
 * compatibility work lives in `replayRoomAdapter.js`; nothing in
 * `renderer.js`, `gameStateExtractor.js`, `useHaxballAnalytics.js` or
 * `momentumOverlay.js` is replay-aware.
 *
 * Reused from the live game screen: the PIXI renderer, GameCanvas,
 * GameStateGUI (scoreboard/timer), ChatBox, SoundButton,
 * OverlayControls. Deliberately not reused: admin controls, kick/ban, room
 * link, recording, and player movement input — a replay has no local player
 * (`currentPlayerId` is -1) and cannot be mutated.
 *
 * Note on `.chatbox-view`: `renderer.js`'s `initialize()` looks that class up
 * by name and observes it to reserve bottom padding for the camera. ChatBox
 * renders it, so ChatBox must be mounted unconditionally — not gated behind a
 * loading flag — or the renderer throws during init and the canvas stays
 * black. The transport bar has its own class for exactly this reason.
 */

/**
 * Reports each distinct sound problem once per session. Kick fires hundreds
 * of times in a recording, so an unguarded warning would flood the console.
 */
const soundWarnings = new Set();
function warnAboutSoundOnce(key, message) {
  if (soundWarnings.has(key)) return;
  soundWarnings.add(key);
  console.warn(message);
}

/** Zoom presets bound to Digit1–7, matching gameInput.js. */
const ZOOM_VALUES = { 1: 1.0, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2, 6: 2.25, 7: 2.5 };

/**
 * Same WebAudio wrapper Game.jsx uses. Duplicated rather than imported
 * because Game.jsx declares it module-private; extracting it would mean
 * editing the live game screen, and this view is meant to sit alongside it
 * without disturbing that path.
 */
function Sound(volume) {
  this.audio = new (window.AudioContext || window.webkitAudioContext)();
  this.gain = this.audio.createGain();
  this.gain.gain.value = volume;
  this.gain.connect(this.audio.destination);
  this.loadSound = (path) =>
    fetch(path)
      .then((res) => {
        if (!res.ok) throw new Error("failed load");
        return res.arrayBuffer();
      })
      .then((buf) => new Promise((resolve, reject) => this.audio.decodeAudioData(buf, resolve, reject)));
  this.playSound = (sound) => {
    if (!sound) return;
    const src = this.audio.createBufferSource();
    src.buffer = sound;
    src.connect(this.gain);
    src.start();
  };
}

export default function ReplayView() {
  const API = useMemo(() => window.API, []);
  const navigate = useNavigate();
  const { player, setPlayerField } = usePlayerData();

  const roomRef = useRef(null);
  const canvasRef = useRef(null);
  const momentumCanvasRef = useRef(null);
  // Latest ball trajectory, recomputed once per tick by the analytics hook
  // and read by the rAF draw below. A ref, not state — it changes every tick.
  const traceRef = useRef(null);
  // Latest aim-assist cue line, same rate split: computed per tick, drawn
  // per frame.
  const aimRef = useRef(null);
  const chatBoxRef = useRef(null);
  const chatInputRef = useRef(null);
  const rendererRef = useRef(null);
  // Sound buffers load asynchronously while the replay's callbacks are
  // registered at read() time, so handlers read the instance from this ref
  // and no-op until it's ready rather than capturing it at creation.
  const soundRef = useRef(null);
  /**
   * The sound CHANNEL flags (`main`, `chat`, `highlight`) are read through a
   * ref, not captured when the replay is opened.
   *
   * The mount effect below runs once and registers the reader's callbacks, so
   * anything it closes over is frozen at open time. Capturing `player.sound`
   * there meant the gate kept consulting the object as it was when the file
   * was loaded: toggling "Sounds enabled" in the settings dialog created a
   * NEW object in player data, the frozen one still said false, and the
   * setting appeared to do nothing until the replay was reloaded.
   *
   * `sound.main` gates kicks, goals and leaves; `sound.chat` gates chat and
   * join. That split is why a profile with `main` off presents as "the kick
   * sound is broken" while chat sounds still work.
   */
  const soundSettingsRef = useRef(player.sound);
  useEffect(() => {
    soundSettingsRef.current = player.sound;
  }, [player.sound]);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState("");
  const [replayName, setReplayName] = useState("");
  const [stadiumName, setStadiumName] = useState("");
  const [players, setPlayers] = useState([]);
  const [timeLimit, setTimeLimit] = useState(0);
  const [scoreLimit, setScoreLimit] = useState(0);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [popup, setPopup] = useState(null);


  // Declared above the analytics hook on purpose: `onTick` reads
  // overlaySettingsRef, and the tick closure must not reference a binding
  // declared further down the component.
  const [overlaySettings, setOverlaySettings] = useState({
    enabled: true,
    team: "both",
    features: { momentum: true, trajectory: true, aimAssist: true, aimAssistLeadIn: true },
  });
  const overlaySettingsRef = useRef(overlaySettings);
  useEffect(() => {
    overlaySettingsRef.current = overlaySettings;
  }, [overlaySettings]);

  // Runs against the adapter exactly as it runs against a live room. The
  // adapter re-emits the reader's `onGameTick` as `onAfterGameTick`, which is
  // what this hook binds (replay readers never fire the `onAfter*` variants).
  // `logging: false` — session capture is done (feat/session-event-capture).
  // Flip it back to true only for a deliberate recording run; watching a
  // replay should not write an NDJSON file every time.
  //
  // `onTick` is independent of `logging`, so the trajectory overlay works
  // with capture off. Keep `enabled: ready` — on the replay path the adapter
  // is built asynchronously and `ready` is what re-triggers the effect once
  // `roomRef.current` is populated.
  useHaxballAnalytics(roomRef, {
    enabled: ready,
    logging: false,
    onTick: (room, frame, geometry) => {
      // Tick rate, not render rate: the path only changes when the ball's
      // velocity does. Written to a ref so it never drives a React render.
      // Horizon defaults are distance-based (see computeBallTrace); a tick
      // count is the wrong unit once damping is in play.
      // Players are per-tick, so the blocker list is rebuilt every tick and
      // handed in — it cannot live in the geometry-keyed collision cache.
      traceRef.current = computeBallTrace(room.state, geometry, room.stadium, {
        blockers: blockersFromFrame(frame),
      });

      // The cue line. A replay has no local player (`currentPlayerId` is -1),
      // so computeAimAssist falls back to whoever currently has the ball
      // inside their own kick range — which follows the action, and is the
      // more useful choice for review anyway.
      const settings = overlaySettingsRef.current;
      // The lead-in band is ALWAYS computed — the ball halo needs it whether
      // or not the path preview is shown on approach. The toggle is applied
      // at draw time instead.
      aimRef.current = settings.features.aimAssist
        ? computeAimAssist(frame, geometry, room.stadium, room.currentPlayerId ?? -1, { team: settings.team })
        : null;
    },
  });

  const leave = useCallback(() => navigate("/RoomList"), [navigate]);

  /** Mirrors Game.jsx's chatApi, minus the focus/blur plumbing tied to input. */
  const chatApi = useMemo(
    () => ({
      receiveChatMessage: (nick, msg) => chatBoxRef.current?.addRow({ type: 0, content: `${nick}: ${msg}` }),
      receiveAnnouncement: (msg, color, style) =>
        chatBoxRef.current?.addRow({ type: 1, content: msg, color, font: style }),
      receiveNotice: (msg) => chatBoxRef.current?.addRow({ type: 0, content: msg, className: "notice" }),
    }),
    []
  );

  useEffect(() => {
    const pending = takePendingReplay();
    if (!pending) {
      setError("No replay loaded. Pick a .hbr2 file from the room list.");
      return;
    }
    setFileName(pending.fileName);

    let cancelled = false;
    let rendererObj = null;
    let room = null;

    /**
     * Plays clip `name` if channel `channel` is enabled.
     *
     * Audio failing is otherwise completely invisible — `playSound` no-ops on
     * a missing buffer and the channel gate returns silently — so a clip that
     * never decoded and a channel that is switched off look identical from the
     * outside ("the kick sound is broken"). Each distinct cause is reported
     * once, naming the clip and the reason, so the browser console answers the
     * question instead of requiring a bisect.
     *
     * Channels: `main` gates kick/goal/leave, `chat` gates chat/join,
     * `highlight` gates the nick-highlight sound. They are separate flags in
     * the player profile, which is why one can be silent while another works.
     */
    /**
     * Minimum gap between two plays of the SAME clip. Guards against clip
     * pile-up: identical buffers started within a few milliseconds of each
     * other sum in the mixer and read as a burst of static rather than as
     * distinct sounds. Also keeps fast playback (up to 16x) from turning the
     * kick sound into a buzz. 40ms is well below the gap between kicks a
     * human can distinguish at 1x, so normal playback is unaffected.
     */
    const MIN_REPLAY_MS = 40;
    const lastPlayedAt = new Map();

    const play = (name, channel) => {
      const s = soundRef.current;
      if (!s) return; // still constructing; nothing to report
      // A seek re-simulates at full speed and replays every event in between;
      // a backward scrub alone can fire dozens of kicks in a few milliseconds.
      // None of it is happening in real time, so none of it should be audible.
      if (roomRef.current?.replay?.isSeeking) return;
      if (!soundSettingsRef.current?.[channel]) {
        warnAboutSoundOnce(
          `channel:${channel}`,
          `[replay] "${name}" sound suppressed — the "${channel}" sound channel is OFF. ` +
            `Turn it on in the replay settings (cog): ` +
            `${channel === "main" ? '"Sounds enabled (kicks, goals, leaves)"' : `"${channel}"`}.`
        );
        return;
      }
      const buffer = s[name];
      if (!buffer) {
        warnAboutSoundOnce(
          `buffer:${name}`,
          `[replay] "${name}" sound has no decoded audio buffer — that clip failed to load or decode. ` +
            `Look for an earlier 'replay sound "${name}" failed to load' warning.`
        );
        return;
      }
      const now = performance.now();
      if (now - (lastPlayedAt.get(name) ?? -Infinity) < MIN_REPLAY_MS) return;
      lastPlayedAt.set(name, now);
      s.playSound(buffer);
    };
    const teamName = (teamId) => API.Impl.Core.Team.byId[teamId]?.name ?? "Spectators";
    const nameOf = (id) => roomRef.current?.getPlayer(id)?.name;
    const refreshPlayers = () => setPlayers([...(roomRef.current?.players ?? [])]);

    /**
     * Chat history and notices. In a live room Game.jsx binds these as
     * `room.onAfterX`; a replay reader emits the plain `onX` set, and the
     * adapter fans each event out to these handlers, to the renderer, and to
     * `onAfterX` alike — so the transcript a replay produces matches what the
     * live client would have shown at the time.
     */
    const replayCallbacks = {
      onPlayerChat: (id, message) => {
        const name = nameOf(id);
        if (name) chatApi.receiveChatMessage(name, message);
        play("chat", "chat");
      },
      onAnnouncement: (msg, color, style, sound) => {
        chatApi.receiveAnnouncement(msg, color, style);
        if (sound === 1) play("chat", "chat");
        if (sound === 2) play("highlight", "highlight");
      },
      onPlayerJoin: (playerObj) => {
        refreshPlayers();
        chatApi.receiveNotice(`${playerObj.name} has joined`);
        play("join", "chat");
      },
      onPlayerLeave: (playerObj, reason, isBanned, byId) => {
        refreshPlayers();
        const by = nameOf(byId);
        if (reason?.length >= 0) {
          const verb = isBanned ? "banned" : "kicked";
          chatApi.receiveNotice(
            `${playerObj.name} was ${verb}${by ? ` by ${by}` : ""}${reason.length > 0 ? ` (${reason})` : ""}`
          );
        } else {
          chatApi.receiveNotice(`${playerObj.name} has left`);
        }
        play("leave", "main");
      },
      onPlayerTeamChange: (id, teamId, byId) => {
        refreshPlayers();
        const moved = nameOf(id);
        const by = nameOf(byId);
        if (moved) chatApi.receiveNotice(`${moved} was moved to ${teamName(teamId)}${by ? ` by ${by}` : ""}`);
      },
      onPlayerAdminChange: (id, isAdmin, byId) => {
        refreshPlayers();
        const changed = nameOf(id);
        const by = nameOf(byId);
        if (!changed) return;
        chatApi.receiveNotice(
          isAdmin
            ? `${changed} was given admin rights${by ? ` by ${by}` : ""}`
            : `${changed} admin rights were taken away${by ? ` by ${by}` : ""}`
        );
      },
      onTeamGoal: (teamId) => {
        chatApi.receiveNotice(`${teamName(teamId)} team scored`);
        play("goal", "main");
      },
      onPlayerBallKick: () => play("kick", "main"),
      onGameStart: (byId) => {
        const by = nameOf(byId);
        chatApi.receiveNotice(by ? `Game started by ${by}` : "Game started");
      },
      onGameStop: (byId) => {
        const by = nameOf(byId);
        chatApi.receiveNotice(by ? `Game stopped by ${by}` : "Game stopped");
      },
      onGamePauseChange: (paused, byId) => {
        const by = nameOf(byId);
        chatApi.receiveNotice(`Game ${paused ? "paused" : "resumed"}${by ? ` by ${by}` : ""}`);
      },
      onTimeIsUp: () => chatApi.receiveNotice("Time is up"),
      onStadiumChange: (stadium) => setStadiumName(stadium?.name ?? ""),
      onTimeLimitChange: (value) => setTimeLimit(value),
      onScoreLimitChange: (value) => setScoreLimit(value),
    };

    try {
      room = createReplayRoom(API, pending.bytes, replayCallbacks, {});
    } catch (err) {
      // node-haxball throws its own Errors object; toString() resolves it
      // through the active Language pack (version mismatch is code 39).
      setError(`Could not read replay: ${err?.toString?.() ?? err}`);
      return;
    }
    roomRef.current = room;
    setReplayName(room.name);
    setStadiumName(room.stadium?.name ?? "");
    setTimeLimit(room.timeLimit);
    setScoreLimit(room.scoreLimit);
    setPlayers([...room.players]);

    const sound = new Sound(player.sound.gain);
    soundRef.current = sound;
    /**
     * Each clip is loaded and assigned independently rather than through a
     * single `Promise.all`. With Promise.all, ONE clip failing to fetch or
     * decode rejects the whole batch, so nothing is ever assigned and every
     * sound goes silent together — a failure mode that is invisible except
     * as "some sounds don't play". Loading them separately means a bad clip
     * costs only itself, and logs which one it was.
     */
    for (const [key, url] of Object.entries({
      chat: chatSnd, goal: goalSnd, highlight: highlightSnd,
      join: joinSnd, kick: kickSnd, leave: leaveSnd,
    })) {
      sound.loadSound(url)
        .then((buffer) => { sound[key] = buffer; })
        .catch((err) => console.warn(`replay sound "${key}" failed to load`, err));
    }

    const canvas = canvasRef.current;
    const initRenderer = async () => {
      try {
        const imgs = await Promise.all([grass, concrete, concrete2, typing].map(loadImage));
        if (cancelled) return;

        rendererObj = new defaultRenderer(API, {
          canvas,
          paintGame: true,
          images: { grass: imgs[0], concrete: imgs[1], concrete2: imgs[2], typing: imgs[3] },
          onRequestAnimationFrame: (extrapolatedRoomState) => {
            const overlayCanvas = momentumCanvasRef.current;
            if (!overlayCanvas || !rendererObj?.cameraOrigin) return;

            const rect = overlayCanvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const cssWidth = Math.round(rect.width);
            const cssHeight = Math.round(rect.height);
            const pixelWidth = Math.round(cssWidth * dpr);
            const pixelHeight = Math.round(cssHeight * dpr);

            if (overlayCanvas.width !== pixelWidth || overlayCanvas.height !== pixelHeight) {
              overlayCanvas.width = pixelWidth;
              overlayCanvas.height = pixelHeight;
            }

            const ctx = overlayCanvas.getContext("2d");
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssWidth, cssHeight);

            const settingsNow = overlaySettingsRef.current;
            if (!settingsNow.enabled) return;

            const stadium = extrapolatedRoomState?.gameState?.stadium;
            if (!stadium) return;

            const transform = {
              cameraOrigin: rendererObj.cameraOrigin,
              cameraScale: rendererObj.cameraScale,
              canvasWidth: cssWidth,
              canvasHeight: cssHeight,
              // Extrapolated ball position, so the trajectory path starts
              // under the ball sprite instead of one tick behind it.
              ballPos: extrapolatedRoomState?.gameState?.physicsState?.discs?.[0]?.pos,
            };

            // Each feature is gated on its own — no early return past this
            // point, or enabling one overlay would silently suppress the
            // others below it.

            // Ball path first, so the momentum arrows draw on top of the
            // corridor rather than under it.
            if (settingsNow.features.trajectory && traceRef.current) {
              drawBallTrace(ctx, traceRef.current, transform);
            }

            // Aim assist after the ball path so the counterfactual cue reads
            // on top of the actual corridor rather than under it.
            if (settingsNow.features.aimAssist && aimRef.current) {
              drawAimAssist(ctx, aimRef.current, transform, {
                showLineOutOfRange: !!settingsNow.features.aimAssistLeadIn,
              });
            }

            if (settingsNow.features.momentum) {
              const threshold = estimateModerateSpeedThreshold(stadium.playerPhysics);
              const directions = getMomentumDirections(extrapolatedRoomState, threshold, settingsNow.team);

              const ballThreshold = estimateBallSpeedThreshold(stadium.playerPhysics);
              const ballDirection = getBallMomentumDirection(extrapolatedRoomState, ballThreshold);
              if (ballDirection) directions.push(ballDirection);

              drawMomentumArrows(ctx, directions, transform);
            }
          },
        });

        if (cancelled) {
          rendererObj.finalize();
          return;
        }

        // "showInputLag" and "showNetGraph" are deliberately absent: both
        // describe a live network connection. A recording has no ping, no
        // packet loss and no input round-trip, so those readouts would show
        // meaningless numbers. They are forced off below rather than copied
        // from player data, and the Video settings tab hides their toggles
        // for this screen (see `hideVideoOptions`).
        const rendererOptions = [
          "webGPU", "discLineWidth", "generalLineWidth", "resolutionScale",
          "showTeamColors", "showAvatars", "showChatIndicators", "showFPS",
          "targetFPS", "displayMode", "resolution", "playerAvatarTexturePath",
        ];
        for (const key of rendererOptions) rendererObj[key] = player.renderer[key];
        rendererObj.showInputLag = false;
        rendererObj.showNetGraph = false;

        rendererObj.setZoom(canvas.width / 2, canvas.height / 2, player.renderer.zoomCoeff);

        // Goes through the adapter's setRenderer, which reproduces
        // node-haxball's own attach semantics (renderer.room = room;
        // renderer.initialize()).
        room.setRenderer(rendererObj);
        // NOT `player.extrapolation` — that is a live-play latency setting and
        // is actively harmful on a replay, where it makes the renderer draw
        // blind forward physics steps (measured: the ball passing through the
        // goal line). The adapter pins extrapolation to 0 regardless; this
        // keeps the renderer's own field honest about it.
        rendererObj.extrapolation = 0;

        rendererRef.current = rendererObj;
        setReady(true);
      } catch (err) {
        console.error("Replay renderer init error:", err);
        setError(`Renderer failed to start: ${err?.message ?? err}`);
      }
    };
    initRenderer();

    return () => {
      cancelled = true;
      roomRef.current = null;
      rendererRef.current = null;
      room?.destroy();
      rendererObj = null;
      soundRef.current = null;
      // Browsers cap live AudioContexts; one left open per replay would
      // eventually refuse to create new ones.
      sound.audio?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Camera + view input. This is the subset of `gameInput.js` that makes sense
   * without a local player: wheel zoom, the Digit1–7 zoom presets, and Escape
   * to toggle the room panel. Everything gameInput.js does for movement,
   * kicking and chat submission is deliberately absent — there is nobody to
   * control and nothing to send.
   *
   * Zoom changes persist back into player data via `setPlayerField`, exactly
   * as gameInput.js does, so a zoom level chosen while reviewing a replay
   * carries over to live play and back.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;

    const persistZoom = (zoomCoeff) =>
      setPlayerField("renderer", { ...player.renderer, zoomCoeff });

    const onWheel = (event) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      persistZoom(renderer.onWheel(event));
      canvas.focus();
    };

    const onKeyDown = (e) => {
      if (document.activeElement === chatInputRef.current) {
        if (e.code === "Escape") canvas.focus();
        return;
      }
      if (e.code === "Escape") {
        setShowRoomInfo((prev) => !prev);
        return;
      }
      if (/^Digit[1-7]$/.test(e.code)) {
        const renderer = rendererRef.current;
        if (!renderer) return;
        persistZoom(
          renderer.setZoom(canvas.width / 2, canvas.height / 2, ZOOM_VALUES[Number(e.code.at(-1))])
        );
        return;
      }
      // Space toggles playback — the one transport control worth a key.
      if (e.code === "Space") {
        e.preventDefault();
        document.querySelector("[data-hook='replay-playpause']")?.click();
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    setTimeout(() => canvas.focus());
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [ready, player.renderer, setPlayerField]);

  /**
   * The replay screen has its own settings dialog rather than the shared
   * `components/SettingsPopup.jsx`, so that the live game's settings are not
   * modified in any way to accommodate this screen. See
   * ReplaySettingsPopup.jsx for what it offers and what it leaves out.
   *
   * `room` is the room OBJECT, not the React ref: the dialog applies changes
   * by assigning to `room.renderer[field]`, which is what makes options like
   * FPS limit and resolution scale take effect immediately.
   */
  /**
   * Ping changes continuously as a replay plays (the recording carries
   * periodic ping events), but the roster is otherwise only rebuilt on
   * join/leave/team-change. Poll while the panel is open so the ping column
   * is live rather than frozen at whatever it was when the panel opened.
   * Same 1Hz-ish tactic GameStateGUI uses for the scoreboard, and it stops
   * as soon as the panel closes.
   */
  useEffect(() => {
    if (!showRoomInfo || !ready) return;
    const poll = setInterval(() => {
      const room = roomRef.current;
      if (room) setPlayers([...room.players]);
    }, 500);
    return () => clearInterval(poll);
  }, [showRoomInfo, ready]);

  const openSettings = useCallback(() => {
    setPopup({ component: ReplaySettingsPopup, props: { room: roomRef.current } });
  }, []);

  if (error) {
    return (
      <div className="game-view">
        <div className="replay-error">
          <p>{error}</p>
          <button type="button" onClick={leave}>Back to room list</button>
        </div>
      </div>
    );
  }

  return (
    <div tabIndex={-1} className="game-view" style={{ "--chat-opacity": `${player.chat.opacity}` }}>
      <div className="gameplay-section">
        <div className="game-state-view">
          <div className="bar-container" style={{ pointerEvents: "none" }}>
            <GameStateGUI roomRef={roomRef} />
          </div>
          <GameCanvas canvasRef={canvasRef} />
          <canvas
            ref={momentumCanvasRef}
            className="momentum-overlay-canvas"
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: "100%",
              imageRendering: "auto", pointerEvents: "none",
            }}
          />
        </div>
      </div>

      <div className="top-section" style={{ zIndex: showRoomInfo ? 2 : 0 }}>
        {showRoomInfo ? (
          <ReplayRoomInfo
            roomName={replayName}
            stadiumName={stadiumName}
            players={players}
            timeLimit={timeLimit}
            scoreLimit={scoreLimit}
          />
        ) : null}
      </div>

      {/* Mounted unconditionally: renderer.js's initialize() looks up
          `.chatbox-view`, which this renders. Gating it on `ready` would make
          the renderer fail to start. */}
      <div tabIndex={-1} className="bottom-section replay-bottom" style={{ zIndex: 2 }}>
        <ChatBox
          ref={chatBoxRef}
          // A recording cannot be talked into; the box is a transcript.
          onChatSubmit={() => {}}
          chatInputRef={chatInputRef}
          height={player.chat.height}
          chat={player.chat}
          setPlayerField={setPlayerField}
          roomRef={roomRef}
        />
        {/* Flush against the bottom of the chat history, same width, so the
            two read as one centred panel. */}
        <div className="replay-transport">
          {ready ? <ReplayControls roomRef={roomRef} fileName={fileName} /> : <div>Loading replay…</div>}
        </div>
      </div>

      <div className="buttons" style={{ zIndex: 2 }}>
        <SoundButton
          sound={player.sound}
          soundInstance={soundRef.current}
          setPlayerField={setPlayerField}
        />
        <button data-hook="menu" onClick={() => setShowRoomInfo((p) => !p)}>
          <i className="icon-menu" />Menu<span className="tooltip">Toggle room info [Escape]</span>
        </button>
        <button data-hook="settings" onClick={openSettings}><i className="icon-cog" /></button>
        <button data-hook="leave-replay" onClick={leave}>
          <i className="icon-logout" />Close<span className="tooltip">Close replay</span>
        </button>
      </div>

      <OverlayControls settings={overlaySettings} onChange={setOverlaySettings} />
      <Popup
        PopupComponent={popup?.component}
        closePopup={() => setPopup(null)}
        popupComponentProps={popup?.props}
      />
    </div>
  );
}
