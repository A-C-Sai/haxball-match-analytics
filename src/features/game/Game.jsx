import React, { useEffect, useRef, useState, useMemo } from "react";
import defaultRenderer from './renderer.js';
import grass from '../../assets/images/grass.png';
import concrete from '../../assets/images/concrete.png';
import concrete2 from '../../assets/images/concrete2.png';
import typing from '../../assets/images/typing.png';
import { loadImage } from "../../utils/loadImage.js";
import setGameInputs from "./gameInput.js";
import { usePlayerData } from '../../hooks/usePlayerData.jsx';
import LeaveRoomPopup from "./components/popups/LeaveRoomPopup.jsx";
import RoomLinkPopup from "./components/popups/RoomLinkPopup.jsx";
import StadiumPickPopup from "./components/popups/StadiumPickPopup.jsx";
import SettingsPopup from '../../components/SettingsPopup.jsx'
import { downloadFile } from "../../utils/downloadFile.js";
import ChatBox from './components/ChatBox.jsx';
import RoomHeader from './components/RoomHeader.jsx';
import GameCanvas from './components/GameCanvas.jsx';
import GameStateGUI from './components/GameStateGUI.jsx';
import OverlayControls from './components/OverlayControls.jsx';
import chatSnd from "../../assets/sounds/chat.ogg"
import crowdSnd from "../../assets/sounds/crowd.ogg"
import goalSnd from "../../assets/sounds/goal.ogg"
import highlightSnd from "../../assets/sounds/highlight.wav"
import joinSnd from "../../assets/sounds/join.ogg"
import kickSnd from "../../assets/sounds/kick.ogg"
import leaveSnd from "../../assets/sounds/leave.ogg"
import Popup from '../../components/Popup.jsx'
import { useCallback } from "react";
import SoundButton from "./components/SoundButton.jsx";
import useHaxballAnalytics from "../analytics/useHaxballAnalytics.js";
import { estimateModerateSpeedThreshold, estimateBallSpeedThreshold, getMomentumDirections, getBallMomentumDirection, drawMomentumArrows } from "../analytics/momentumOverlay.js";
import { computeBallTrace, drawBallTrace, blockersFromFrame } from "../analytics/ballTrajectoryOverlay.js";
import { computeAimAssist, drawAimAssist } from "../analytics/aimAssistOverlay.js";

function Sound(volume) {
  this.audio = new (window.AudioContext || window.webkitAudioContext)();
  this.gain = this.audio.createGain();
  this.gain.gain.value = volume;
  this.gain.connect(this.audio.destination);
  this.loadSound = (path) => {
    return fetch(path).then(res => {
      if (!res.ok) throw new Error("failed load");
      return res.arrayBuffer();
    }).then(buf => new Promise((resolve, reject) =>
      this.audio.decodeAudioData(buf, resolve, reject)
    ));
  };
  this.playSound = (sound) => {
    if (!sound) return;
    const src = this.audio.createBufferSource();
    src.buffer = sound;
    src.connect(this.gain);
    src.start();
  };
}

export default function Game({ roomRef, usingCustomAPI }) {
  const API = useMemo(()=>(usingCustomAPI || window.API), [usingCustomAPI]);
  // Latest ball trajectory, recomputed once per tick by the analytics hook
  // below and read by the rAF draw. A ref, not state — it changes every tick,
  // and it is declared here (above the hook) so the onTick closure does not
  // reference a binding declared further down the component.
  const traceRef = useRef(null);
  // Latest aim-assist cue line, same rate split as the trace above: computed
  // once per tick, drawn every frame.
  const aimRef = useRef(null);

  // Shared overlay settings — every overlay feature (momentum now,
  // LOS/passing-lanes/etc. later) reads from this same
  // { enabled, team, features: { [featureKey]: boolean } } shape rather
  // than inventing its own toggle. `enabled` is the master authority,
  // deliberately decoupled from `features` — it's an independent AND-gate
  // on top of whatever the per-feature checkboxes say, not derived from or
  // merged into them (see OverlayControls.jsx for the full rationale).
  // `features` lets any combination of overlays be on/off independently
  // (see OverlayControls.OVERLAY_FEATURES for the registry). Session-only
  // by design, no persistence. `team` is "both" | 1 (red) | 2 (blue),
  // shared across all features.
  const [overlaySettings, setOverlaySettings] = useState({ enabled: true, team: "both", features: { momentum: true, trajectory: true, aimAssist: true, aimAssistLeadIn: true } });
  // onRequestAnimationFrame below is captured once when the renderer is
  // constructed (inside initRenderer), not re-created on every React
  // render — so it would otherwise close over a STALE overlaySettings value.
  // Mirror the latest value into a ref that closure can always read fresh.
  const overlaySettingsRef = useRef(overlaySettings);
  useEffect(() => {
    overlaySettingsRef.current = overlaySettings;
  }, [overlaySettings]);
  // `logging: false` — session capture is done (feat/session-event-capture).
  // Flip it back to true only for a deliberate recording run; playing should
  // not write an NDJSON file every game.
  //
  // `onTick` is independent of `logging`, so the trajectory overlay works
  // with capture off.
  useHaxballAnalytics(roomRef, {
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

      // The cue line: where the ball would go if the kicker kicked THIS tick.
      // Reads `frame` rather than room.state — extractFrame has already
      // normalized every disc, so there is no second convention to keep in
      // sync. Returns null whenever there is nothing honest to draw (nobody
      // in kick range being the common case).
      // Gated on the feature being on: with it off there is nothing to draw,
      // and this runs a full path simulation every tick.
      const settings = overlaySettingsRef.current;
      // The lead-in band is ALWAYS computed — the ball halo needs it whether
      // or not the path preview is shown on approach. The toggle is applied
      // at draw time instead.
      aimRef.current = settings.features.aimAssist
        ? computeAimAssist(frame, geometry, room.stadium, room.currentPlayerId, { team: settings.team })
        : null;
    },
  });
  const { player, setPlayerField } = usePlayerData();
  const [roomName, setRoomName] = useState(null);
  const [stadiumName, setStadiumName] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showRoomView, setShowRoomView] = useState(false);
  const chatBoxRef = useRef(null);
  const [players, setPlayers] = useState([]);
  const [teamsLocked, setTeamsLocked] = useState(true);
  const [gameStarted, setGameStarted] = useState(false);
  const [popup, setPopup] = useState(null);
  const [timeLimit, setTimeLimit] = useState(0);
  const [scoreLimit, setScoreLimit] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const canvasRef = useRef(null);
  const momentumCanvasRef = useRef(null);
  const chatInput = useRef(null);
  const soundInstanceRef = useRef(null);
  const soundRef = useRef(null);
  const [uiVisible, setUiVisible] = useState(true);
  const uiVisibleRef = useRef(true);
  const [rendererObj, setRendererObj] = useState(null);
  const timerRef = useRef(null);
  const keysHandlerRef = useRef(null);
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  });

  const showUI = useCallback(() => {
    if (!uiVisibleRef.current) {
      uiVisibleRef.current = true;
      setUiVisible(true);
    }
  }, []);

  const hideUI = useCallback(() => {
    if (uiVisibleRef.current) {
      uiVisibleRef.current = false;
      setUiVisible(false);
    }
  }, []);

  const requestLock = () => {
    if (!player.chat.alwaysHide) return;
    const canvas = canvasRef.current;
    canvas.requestPointerLock();
  };

  const handleActivity = useCallback(() => {
    if (document.activeElement === chatInput.current) return;

    clearTimeout(timerRef.current);

    showUI();

    if (
      player.chat.alwaysHide &&
      !showRoomView &&
      document.pointerLockElement !== canvasRef.current
    ) {
      requestLock();
    }

    timerRef.current = setTimeout(() => {
      if (document.activeElement === chatInput.current) return;

      hideUI();
    }, 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.chat.alwaysHide, showRoomView, showUI, hideUI]);

  const getPlayerField = useCallback((field) => {
    return playerRef.current[field];
  }, []);

  const chatApi = useMemo(()=>({
    receiveChatMessage: (nick, msg) => {
      chatBoxRef.current?.addRow({ type: 0, content: nick + ": " + msg });
      handleActivity();
    },
    receiveAnnouncement: (msg, color, style) => {
      chatBoxRef.current?.addRow({ type: 1, content: msg, color, font: style });
      handleActivity();
    },
    receiveNotice: (msg) => {
      chatBoxRef.current?.addRow({ type: 0, content: msg, className: "notice" });
      handleActivity();
    },
    focusOnChat: () => {
      if (document.activeElement === chatInput.current) canvasRef.current.focus();
      else chatInput.current.focus();
      handleActivity();
    },
    blurChat: () => chatInput.current.blur(),
  }), [handleActivity]);

  const analyzeChatCommand = useCallback((msg) => {
    if (!msg || msg.charAt(0) !== "/") return false;
    const room = roomRef.current;
    const tokens = msg.substring(1).split(" ");
    var { parseHexInt } = API.Utils;
    switch (tokens[0]) {
      case "avatar":
        if (tokens[1]) {
          room.setAvatar(tokens[1]);
          setPlayerField('avatar', tokens[1]);
          chatApi.receiveNotice("Avatar set");
        }
        break;
      case "clear_avatar":
        room.setAvatar(null);
        setPlayerField('avatar', null);
        chatApi.receiveNotice("Avatar cleared");
        break;
      case "checksum":
        var cs = room.stadium.calculateChecksum();
        if (!cs)
          chatApi.receiveNotice('Current stadium is original: "' + room.stadium.name + '"')
        else
          chatApi.receiveNotice('Stadium: "' + room.stadium.name + '" (checksum: ' + cs + ")")
        break;
      case "clear_bans":
        if (room.isHost) {
          room.clearBans(null);
          chatApi.receiveNotice("All bans have been cleared");
        }
        else
          chatApi.receiveNotice("Only the host can clear bans");
        break;
      case "set_password":
        if (tokens.length == 2) {
          if (room.isHost) {
            room.setProperties({ password: tokens[1] });
            chatApi.receiveNotice("Password set");
          }
          else
            chatApi.receiveNotice("Only the host can change the password");
        }
        break;
      case "clear_password":
        if (room.isHost) {
          room.setProperties({ password: null });
          chatApi.receiveNotice("Password cleared");
        }
        else
          chatApi.receiveNotice("Only the host can change the password");
        break;
      case "colors":
        try {
          var teamId = (tokens[1] == "blue") ? 2 : 1;
          var angle = tokens[2];
          if (angle == "clear") {
            angle = 0;
            msg = [];
          }
          else
            msg.splice(0, 3);
          room.setTeamColors(teamId, angle, ...msg.map(c => parseHexInt("0x" + c)));
        } catch (g) {
          chatApi.receiveNotice(msg.toString());
        }
        break;
      case "extrapolation":
        if (tokens.length == 2) {
          const value = parseHexInt(tokens[1]);
          if (value != null) { // && -200 <= msg && 200 >= msg
            room.renderer.extrapolation = value;
            chatApi.receiveNotice("Extrapolation set to " + value + " msec");
            setPlayerField("extrapolation", value);
          }
          else
            chatApi.receiveNotice("Extrapolation must be a value between -200 and 200 milliseconds");
        }
        else
          chatApi.receiveNotice("Extrapolation requires a value in milliseconds.");
        break;
      case "handicap":
        if (tokens.length == 2) {
          const value = parseHexInt(tokens[1]);
          if (value != null) { // && 0 <= msg && 300 >= msg
            room.setHandicap(value);
            chatApi.receiveNotice("Ping handicap set to " + value + " msec");
          }
          else
            chatApi.receiveNotice("Ping handicap must be a value between 0 and 300 milliseconds");
        }
        else
          chatApi.receiveNotice("Ping handicap requires a value in milliseconds.");
        break;
      case "kick_ratelimit":
        if (tokens.length < 4)
          chatApi.receiveNotice("Usage: /kick_ratelimit <min> <rate> <burst>");
        else {
          var d = parseHexInt(tokens[1]), e = parseHexInt(tokens[2]);
          const value = parseHexInt(tokens[3]);
          if (d == null || e == null || value == null)
            chatApi.receiveNotice("Invalid arguments");
          else
            room.setKickRateLimit(d, e, msg);
        }
        break;
      case "recaptcha":
        if (!room.isHost)
          chatApi.receiveNotice("Only the host can set recaptcha mode");
        else
          try {
            if (tokens.length == 2) {
              switch (tokens[1]) {
                case "off":
                  e = false;
                  break;
                case "on":
                  e = true;
                  break;
                default:
                  throw null;
              }
              room.setRecaptcha(e);
              chatApi.receiveNotice("Room join Recaptcha " + (e ? "enabled" : "disabled"));
            }
            else
              throw null;
          } catch (g) {
            chatApi.receiveNotice("Usage: /recaptcha <on|off>");
          }
        break;
      case "store":
        var f = room.stadium;
        if (!f.isCustom) {
          chatApi.receiveNotice("Can't store default stadium.");
        } else {
          const request = window.indexedDB.open("stadiums", 1);
          request.onupgradeneeded = function (event) {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("stadiums")) {
              db.createObjectStore("stadiums", { autoIncrement: true });
            }
          };
          request.onsuccess = function (event) {
            const db = event.target.result;
            const transaction = db.transaction(["stadiums"], "readwrite");
            const objectStore = transaction.objectStore("stadiums");
            const addRequest = objectStore.add(API.Utils.exportStadium(f), );
            addRequest.onsuccess = function (event) {
              chatApi.receiveNotice("Stadium stored successfully.");
            };
          };
          request.onerror = function (event) {
            chatApi.receiveNotice("Error occurred while storing stadium.");
          };
          //chatApi.receiveNotice("Not implemented to keep the web examples simple.");
        }
        break;
      default:
        chatApi.receiveNotice(`Unknown command: ${tokens[0]}`);
    }
    return true;
  }, [API.Utils, chatApi, roomRef, setPlayerField]);

  const onChatSubmit = useCallback((value) => {
    if (value.length > 0 && !analyzeChatCommand(value)) {
      roomRef.current?.sendChat(value);
    }
  }, [analyzeChatCommand, roomRef]);

  const make2Digits = useCallback((a) => {
    let s = String(a || "");
    while (s.length < 2) s = "0" + s;
    return s;
  }, []);

  const handleRec = useCallback(() => {
    if (!roomRef.current) return;
    if (roomRef.current.isRecording()) {
      const data = roomRef.current.stopRecording();
      const date = new Date();
      const fileName = `HBReplay-${date.getFullYear()}-${make2Digits(date.getMonth() + 1)}-${make2Digits(date.getDate())}-${make2Digits(date.getHours())}h${make2Digits(date.getMinutes())}m.hbr2`;
      downloadFile(fileName, "octet/stream", data);
      setIsRecording(false);
    } else {
      roomRef.current.startRecording();
      setIsRecording(true);
    }
  }, [make2Digits, roomRef]);

  const handleLeave = useCallback(() => setPopup({
    component: LeaveRoomPopup, 
    props: {
      room: roomRef.current,
      showPopup: setPopup
    }
  }), [roomRef]);
  const handleLink = useCallback(() => setPopup({
    component: RoomLinkPopup,
    props: {
      link:roomRef.current?.link,
      showPopup: setPopup
    }
  }), [roomRef]);
  const handleStadiumPick = useCallback(() => setPopup({
    component: StadiumPickPopup,
    props: {
      room:roomRef.current,
      showPopup:setPopup
    }
  }), [roomRef]);
  const handleSettings = useCallback(()=>setPopup({
    component: SettingsPopup,
    props: {
      roomRef: roomRef?.current
    }

  }), [roomRef]);

  const handleMenu = useCallback(() => setShowRoomView(prev => !prev), []);
  
  useEffect(() => {
    const room = roomRef?.current;
    const canvas = canvasRef.current;
    if (!room || !canvas) {
      return
    };
    let cancelled = false;
    canvas.focus();
    setGameStarted(!!room.gameState);
    setPlayers([...room.players]);
    setRoomName(room.name);
    setStadiumName(room.stadium?.name || "");
    setTimeLimit(room.timeLimit);
    setScoreLimit(room.scoreLimit);
    setTeamsLocked(room.state?.teamsLocked ?? true);
    setIsAdmin(room.currentPlayer.isAdmin);
    if (!room.gameState) setShowRoomView(true);
    const s = new Sound(player.sound.gain);
    soundInstanceRef.current = s;
    soundRef.current = s;
    Promise.all([chatSnd, crowdSnd, goalSnd, highlightSnd, joinSnd, kickSnd, leaveSnd].map(url => s.loadSound(url)))
      .then(([chatB, crowdB, goalB, hiB, joinB, kickB, leaveB]) => {
        s.chat = chatB; s.crowd = crowdB; s.goal = goalB; s.highlight = hiB; s.join = joinB; s.kick = kickB; s.leave = leaveB;
      }).catch(err => { console.warn("sound load", err); });
    let defaultRendererObj;
    const initRenderer = async () => {
      try {
        const imgs = await Promise.all([grass, concrete, concrete2, typing].map(loadImage));
        if (cancelled) return;
        var counter = 0;
        defaultRendererObj = new defaultRenderer(API, {
          canvas,
          paintGame: true,
          images: { grass: imgs[0], concrete: imgs[1], concrete2: imgs[2], typing: imgs[3] },
          onRequestAnimationFrame: (extrapolatedRoomState) => {
            const overlayCanvas = momentumCanvasRef.current;
            if (!overlayCanvas || !defaultRendererObj?.cameraOrigin) return;

            const rect = overlayCanvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            // logical (CSS) pixel space — matches renderer.js's resizeCanvas()
            // `logicalWidth`/`logicalHeight`, i.e. the same space stage.x/y use.
            const cssWidth = Math.round(rect.width);
            const cssHeight = Math.round(rect.height);
            const pixelWidth = Math.round(cssWidth * dpr);
            const pixelHeight = Math.round(cssHeight * dpr);

            if (overlayCanvas.width !== pixelWidth || overlayCanvas.height !== pixelHeight) {
              overlayCanvas.width = pixelWidth;
              overlayCanvas.height = pixelHeight;
            }

            const ctx = overlayCanvas.getContext("2d");
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 1 ctx unit = 1 CSS pixel
            ctx.clearRect(0, 0, cssWidth, cssHeight);

            const overlaySettingsNow = overlaySettingsRef.current;
            // `enabled` is the master authority: independent of, and checked
            // in addition to, each feature's own toggle — not merged into it.
            if (!overlaySettingsNow.enabled) return;

            const stadium = extrapolatedRoomState?.gameState?.stadium;
            if (!stadium) return;

            const transform = {
              cameraOrigin: defaultRendererObj.cameraOrigin,
              cameraScale: defaultRendererObj.cameraScale,
              canvasWidth: cssWidth,
              canvasHeight: cssHeight,
              // Extrapolated ball position, so the trajectory path starts
              // under the ball sprite instead of one tick behind it.
              ballPos: extrapolatedRoomState?.gameState?.physicsState?.discs?.[0]?.pos,
            };

            // Each feature is gated on its own — no early return past this
            // point, or enabling one overlay would silently suppress the
            // others below it. Canvas is already cleared above, so a feature
            // that is off simply skips its own computation.

            // Ball path first, so the momentum arrows draw on top of the
            // corridor rather than under it.
            if (overlaySettingsNow.features.trajectory && traceRef.current) {
              drawBallTrace(ctx, traceRef.current, transform);
            }

            // Aim assist after the ball path so the counterfactual cue reads
            // on top of the actual corridor rather than under it.
            if (overlaySettingsNow.features.aimAssist && aimRef.current) {
              drawAimAssist(ctx, aimRef.current, transform, {
                showLineOutOfRange: !!overlaySettingsNow.features.aimAssistLeadIn,
              });
            }

            if (overlaySettingsNow.features.momentum) {
              const threshold = estimateModerateSpeedThreshold(stadium.playerPhysics);
              const directions = getMomentumDirections(extrapolatedRoomState, threshold, overlaySettingsNow.team);

              const ballThreshold = estimateBallSpeedThreshold(stadium.playerPhysics);
              const ballDirection = getBallMomentumDirection(extrapolatedRoomState, ballThreshold);
              if (ballDirection) directions.push(ballDirection); // ball has no team, always included when this feature is on

              drawMomentumArrows(ctx, directions, transform);
            }
          }
        });
        if (cancelled) {
          defaultRendererObj.finalize();
          return;
        }
        setRendererObj(defaultRendererObj);
        const rendererOptions = ["webGPU", "discLineWidth", "generalLineWidth", "resolutionScale", "showTeamColors", "showAvatars", "showChatIndicators", "showFPS", "showInputLag", "showNetGraph", "targetFPS", "displayMode", "resolution", "playerAvatarTexturePath"]
        for (let i = 0; i < rendererOptions.length; i++) {
            defaultRendererObj[rendererOptions[i]] = player.renderer[rendererOptions[i]];
        }
        defaultRendererObj.setZoom(
          canvas.width / 2,
          canvas.height / 2,
          player.renderer["zoomCoeff"]
        );
        room.setRenderer(defaultRendererObj);
        room.renderer.extrapolation = player.extrapolation;
        if (player.extrapolation != null) room.renderer.extrapolation = player.extrapolation;
      } catch (err) {
        console.error("Renderer init error:", err);
      }
    };
    initRenderer();

    return () => {
      cancelled = true;
      API.Callback.remove('Wheel')
      room.leave();
      room.setRenderer(null);
      defaultRendererObj = null;
      room.renderer = null;
      if (soundRef.current && soundRef.current.audio) {
          soundRef.current.audio.close();
      }
      if (roomRef) {
          roomRef.current = null;
      }
      setPopup(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const room = roomRef?.current;
    if (!room) return;
    const s = soundRef.current;

    room.onAfterGamePauseChange = (paused, byId) => {
      const author = room.getPlayer(byId)?.name;

      chatApi.receiveNotice(
        `Game ${paused ? "paused" : "resumed"}${author ? ` by ${author}` : ""}`
      );
    };
    room.onAfterStadiumChange = (stadium) => setStadiumName(stadium.name);
    room.onAfterTeamGoal = () => {
      if (player.sound.main) s.playSound(s.goal);
    };
    room.onAfterPlayerAdminChange = (id, admin, byId) => {
      setPlayers([...room.players]);
      const playerChanged = room.getPlayer(id);
      const byPlayer = room.getPlayer(byId);
      if (id == room.currentPlayerId)
        setIsAdmin(admin);
      if (admin)
        chatApi.receiveNotice(`${playerChanged.name} was given admin rights by ${byPlayer.name}`);
      else 
        chatApi.receiveNotice(`${playerChanged.name} admin rights were taken away by ${byPlayer.name}`);
    };
    room.onAfterPlayerTeamChange = (id, teamId, byId) => {
      setPlayers([...room.players]);
      const moved = room.getPlayer(id);
      const playerObj = room.getPlayer(byId);
      const team = API.Impl.Core.Team.byId[teamId];
      if (playerObj)
        chatApi.receiveNotice(
          `${moved.name} was moved to ${team.name} by ${playerObj.name}`
        );
    };
    room.onAfterPlayerChat = (id, message) => {
      const playerObj = room.state.players.find((x) => x.id == id);
      if (!playerObj) return;
      chatApi.receiveChatMessage(playerObj.name, message);
      if (player.sound.chat) s.playSound(s.chat);
    };
    room.onAfterPlayerJoin = (playerObj) => {
      setPlayers([...room.players]);
      if (player.sound.chat) s.playSound(s.join);
      chatApi.receiveNotice(`${playerObj.name} has joined`);
    };
    room.onAfterPlayerLeave = (playerObj, reason, isBanned, byId) => {
      setPlayers([...room.players]);
      if (player.sound.main) s.playSound(s.leave);
      if (reason?.length >= 0) {
        const byPlayer = room.getPlayer(byId);
        if (isBanned) {
          chatApi.receiveNotice(`${playerObj.name} was banned ${byPlayer ? `by ${byPlayer.name}` : ''} ${reason.length > 0 ? '(' + reason + ')' : ''}`);
        } else {
          chatApi.receiveNotice(`${playerObj.name} was kicked ${byPlayer ? `by ${byPlayer.name}` : ''} ${reason.length > 0 ? '(' + reason + ')' : ''}`);
        }
      } else {
        chatApi.receiveNotice(`${playerObj.name} has left`);
      }
    };
    room.onAfterTeamsLockChange = (value) => setTeamsLocked(value);
    room.onAfterGameStop = (byId) => {
      setShowRoomView(true);
      setGameStarted(false);
      const playerObj = room.getPlayer(byId);
      if (playerObj)
        chatApi.receiveNotice(`Game stopped by ${playerObj.name}`)
    };
    room.onAfterGameStart = (byId) => {
      setShowRoomView(false);
      setGameStarted(true);
      const playerObj = room.getPlayer(byId);
      if (playerObj)
        chatApi.receiveNotice(`Game started by ${playerObj.name}`)
      else chatApi.receiveNotice(`Game started`)
    };
    room.onAfterAnnouncement = (msg, color, style, _sound) => {
      chatApi.receiveAnnouncement(msg, color, style);
      if (_sound === 1 && player.sound.chat) s.playSound(s.chat);
      if (_sound === 2 && player.sound.chat) s.playSound(s.highlight);
    };
    room.onAfterPlayerBallKick = () => {
      if (player.sound.main) s.playSound(s.kick);
    };
    room.onAfterScoreLimitChange = (value) => setScoreLimit(value);
    room.onAfterTimeLimitChange = (value) => setTimeLimit(value);
    return () => {
      room.onAfterStadiumChange = null;
      room.onAfterTeamGoal = null;
      room.onAfterPlayerAdminChange = null;
      room.onAfterPlayerTeamChange = null;
      room.onAfterPlayerChat = null;
      room.onAfterPlayerJoin = null;
      room.onAfterPlayerLeave = null;
      room.onAfterTeamsLockChange = null;
      room.onAfterGameStop = null;
      room.onAfterGameStart = null;
      room.onAfterAnnouncement = null;
      room.onAfterPlayerBallKick = null;
      room.onAfterScoreLimitChange = null;
      room.onAfterTimeLimitChange = null;
    }
  }, [API.Impl.Core.Team.byId, chatApi, player.sound, roomRef, soundRef]);

  useEffect(() => {
    const room = roomRef.current;
    const canvas = canvasRef.current;
    const chatInputEl = chatInput.current;
    const keysHandler = setGameInputs(room, () => setShowRoomView(prev => !prev), chatApi, player.keys, canvas, chatInputEl, setPlayerField, getPlayerField, rendererObj);
    keysHandlerRef.current = keysHandler;
    return () => { keysHandler.kill(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererObj]);

  useEffect(() => {
    keysHandlerRef.current?.setKeys(player.keys);
  }, [player.keys]);

  const changeScoreLimit = useCallback((value) => {
    setScoreLimit(value);
    roomRef.current?.setScoreLimit(value);
  }, [roomRef]);
  const changeTimeLimit = useCallback((value) => {
    setTimeLimit(value);
    roomRef.current?.setTimeLimit(value);
  }, [roomRef]);

  const rafRef = useRef(null);

  useEffect(() => {
    const onMouseMove = () => {
      if (rafRef.current) return;

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        handleActivity();
      });
    };

    window.addEventListener("mousemove", onMouseMove);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [handleActivity]);
  
  const uiClass = gameStarted && !player.chat.neverHide && !uiVisible && !showRoomView ? "auto-hide-ui hidden" : "";
  const viewClass = gameStarted && !player.cursor.neverHide && !uiVisible && !showRoomView ? "game-view hide-cursor" : "game-view";

  return (
    <div tabIndex={-1} className={viewClass} style={{ "--chat-opacity": `${player.chat.opacity}`}}>
      <div className="gameplay-section">
        <div className="game-state-view" style={{visibility: !gameStarted ? 'hidden' : 'visible'}}>
          <div className="bar-container" style={{pointerEvents:'none'}}>
            <GameStateGUI roomRef={roomRef} />
          </div>
          <GameCanvas canvasRef={canvasRef} />
          <canvas
            ref={momentumCanvasRef}
            className="momentum-overlay-canvas"
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', imageRendering: 'auto', pointerEvents: 'none' }}
          />
        </div>
      </div>

      <div className={`top-section`} style={{zIndex: showRoomView ? 2 : 0}}>
        {showRoomView ? (
          <RoomHeader
            roomRef={roomRef}
            roomName={roomName}
            stadiumName={stadiumName}
            isAdmin={isAdmin}
            teamsLocked={teamsLocked}
            gameStarted={gameStarted}
            timeLimit={timeLimit}
            scoreLimit={scoreLimit}
            setTimeLimit={changeTimeLimit}
            setScoreLimit={changeScoreLimit}
            handleRec={handleRec}
            handleLink={handleLink}
            handleLeave={handleLeave}
            handleStadiumPick={handleStadiumPick}
            players={players}
            setPopup={setPopup}
          />
        ) : null}
      </div>

      <div tabIndex={-1} className={`bottom-section ${uiClass}`} style={{zIndex:2, width:'50vw'}}>

        <ChatBox
          ref={chatBoxRef}
          onChatSubmit={onChatSubmit}
          chatInputRef={chatInput}
          height={player.chat.height}
          chat={player.chat}
          setPlayerField={setPlayerField}
          roomRef={roomRef}
        />

        <div className="bottom-spacer" />
      </div>

      <div className={`buttons`} style={{zIndex:2}}>
        <SoundButton sound={player.sound} soundInstance={soundInstanceRef.current} setPlayerField={setPlayerField}></SoundButton>
        <button data-hook="menu" disabled={!gameStarted} onClick={handleMenu}><i className="icon-menu" />Menu<span className="tooltip">Toggle room menu [Escape]</span></button>
        <button data-hook="settings" onClick={handleSettings}><i className="icon-cog" /></button>
      </div>
      <OverlayControls settings={overlaySettings} onChange={setOverlaySettings} />
      <Popup PopupComponent={popup?.component} closePopup={()=>setPopup(null)} popupComponentProps={popup?.props} ></Popup>
    </div>
  );
}
