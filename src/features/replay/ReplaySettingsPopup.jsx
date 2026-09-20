import { useState } from "react";
import Toggle from "../../components/Toggle.jsx";
import SliderOption from "../../components/SliderOption.jsx";
import NumericInput from "../../components/NumericInput.jsx";
import playerDefaultValues from "../../hooks/PlayerDataDefaultValues.js";
import { usePlayerData } from "../../hooks/usePlayerData.jsx";

/**
 * ReplaySettingsPopup.jsx
 *
 * The replay screen's own settings dialog.
 *
 * Why this exists instead of reusing `components/SettingsPopup.jsx`: the
 * replay screen needs a different set of options, and the live game's
 * settings dialog must not change in any way to provide them. An earlier
 * version added `tabs` / `hide` props to the shared `SettingsPopup` and
 * `VideoContent`; that was behaviour-preserving but still edited components
 * the live game renders. Those files are now untouched, and everything
 * replay-specific lives here.
 *
 * It reuses the shared input primitives (`Toggle`, `SliderOption`,
 * `NumericInput`) as-is — those are generic and carry no room/gameplay
 * assumptions.
 *
 * What is deliberately NOT offered here, and why:
 *   - Input tab          — binds keys for controlling a player; a replay has
 *                          no local player (`currentPlayerId` is -1).
 *   - Misc tab           — room/account settings that cannot apply to a file.
 *   - Sound VOLUME       — already on screen as the volume button.
 *   - Theme tab          — removed on request.
 *   - FPS limit,
 *     Show FPS counter   — removed on request; playback rate is controlled by
 *                          the speed selector on the transport bar, which is
 *                          the meaningful notion of speed for a recording.
 *   - Show Input Lag     — measures input round-trip; there is no input.
 *   - Show Network Graph — ping and packet loss; there is no connection.
 *   - Immediate render   — an input-latency optimisation; nothing to react to.
 *   - Display Mode /
 *     Resolution         — window management, unchanged by which screen you
 *                          are on; set it from the live settings dialog.
 *
 * Sound CHANNEL toggles are here, though, and are not a duplicate of the
 * volume button: that button controls gain only. `sound.main` is the master
 * "Sounds enabled" flag gating kicks, goals and leave sounds, and it is
 * persisted in the player profile. With no Sound tab on this screen there was
 * no way to see or change it here — so a profile with `main` switched off
 * looked exactly like "the kick sound is broken", with chat and join sounds
 * (a different channel) still working. Goals and leaves are rare enough in a
 * single recording that kicks are the symptom you notice.
 *
 * With Theme gone this is a single pane, so it renders no tab strip at all.
 *
 * Values are written to the same shared player profile the live settings use,
 * so a line width or resolution scale chosen while reviewing a replay is the
 * one you get in a live game and vice versa. That is deliberate: these
 * describe how *you* want the game drawn, not a property of the recording.
 * Only the dialog is replay-specific, not the underlying preferences.
 */
export default function ReplaySettingsPopup({ onClose, room }) {
  const { player, setPlayerField } = usePlayerData();
  const [playerCopy, setPlayerCopy] = useState(player);

  /**
   * Mirrors VideoContent's own `rendererChanged`: persist to the player
   * profile, update the local copy driving the controls, and push the value
   * straight onto the live renderer so it takes effect without a reload.
   *
   * That last step is the one that matters — `room.renderer[field] = value`
   * goes through the Renderer's `defineVariable` setter, which fires
   * `onVariableValueChange` in renderer.js — that handler is what actually
   * applies the change, calling `_regenerateNecessaryObjects()` for the line
   * widths and rebuilding at the new `resolutionScale`.
   *
   * For that to arrive, the adapter must implement `_onVariableValueChange`
   * and forward it to the renderer, which a live Room does for free. See
   * replayRoomAdapter.js — without it the setter stored the value and nothing
   * redrew, which is why "General line width" did nothing and "Disc line
   * width" only seemed to affect one player at a time.
   */
  const rendererChanged = (field, value) => {
    setPlayerField("renderer", { ...player.renderer, [field]: value });
    setPlayerCopy((prev) => ({ ...prev, renderer: { ...prev.renderer, [field]: value } }));
    if (room?.renderer) room.renderer[field] = value;
  };

  const soundChanged = (field, value) => {
    setPlayerField("sound", { ...player.sound, [field]: value });
    setPlayerCopy((prev) => ({ ...prev, sound: { ...prev.sound, [field]: value } }));
  };

  const chatChanged = (field, value) => {
    setPlayerField("chat", { ...player.chat, [field]: value });
    setPlayerCopy((prev) => ({ ...prev, chat: { ...prev.chat, [field]: value } }));
  };

  const renderVideo = () => (
    <div className="settings-content">
      <SliderOption
        title={"Resolution scale"}
        min={0.1}
        max={1}
        step={0.1}
        value={playerCopy.renderer.resolutionScale}
        defaultValue={playerDefaultValues.renderer.resolutionScale}
        onChange={(value) => rendererChanged("resolutionScale", value)}
      />
      <NumericInput
        title={"Disc line width"}
        min={0}
        max={100}
        step={1}
        value={playerCopy.renderer.discLineWidth}
        defaultValue={playerDefaultValues.renderer.discLineWidth}
        onChange={(value) => rendererChanged("discLineWidth", value)}
      />
      <NumericInput
        title={"General line width"}
        min={0}
        max={100}
        step={1}
        value={playerCopy.renderer.generalLineWidth}
        defaultValue={playerDefaultValues.renderer.generalLineWidth}
        onChange={(value) => rendererChanged("generalLineWidth", value)}
      />
      <Toggle
        title={"Use WebGPU"}
        value={playerCopy.renderer.webGPU}
        defaultValue={playerDefaultValues.renderer.webGPU}
        onChange={(value) => rendererChanged("webGPU", value)}
      />
      <Toggle
        title={"Custom team colors enabled"}
        value={playerCopy.renderer.showTeamColors}
        defaultValue={playerDefaultValues.renderer.showTeamColors}
        onChange={(value) => rendererChanged("showTeamColors", value)}
      />
      <Toggle
        title={"Show player avatars"}
        value={playerCopy.renderer.showAvatars}
        defaultValue={playerDefaultValues.renderer.showAvatars}
        onChange={(value) => rendererChanged("showAvatars", value)}
      />
      <Toggle
        title={"Show chat indicators"}
        value={playerCopy.renderer.showChatIndicators}
        defaultValue={playerDefaultValues.renderer.showChatIndicators}
        onChange={(value) => rendererChanged("showChatIndicators", value)}
      />
      <Toggle
        title={"Sounds enabled (kicks, goals, leaves)"}
        value={playerCopy.sound.main}
        defaultValue={playerDefaultValues.sound.main}
        onChange={(value) => soundChanged("main", value)}
      />
      <Toggle
        title={"Chat sound enabled"}
        value={playerCopy.sound.chat}
        defaultValue={playerDefaultValues.sound.chat}
        onChange={(value) => soundChanged("chat", value)}
      />
      <Toggle
        title={"Nick highlight sound enabled"}
        value={playerCopy.sound.highlight}
        defaultValue={playerDefaultValues.sound.highlight}
        onChange={(value) => soundChanged("highlight", value)}
      />
      <SliderOption
        title={"Chat opacity"}
        min={0.5}
        max={1}
        step={0.01}
        value={playerCopy.chat.opacity}
        defaultValue={playerDefaultValues.chat.opacity}
        onChange={(value) => chatChanged("opacity", value)}
      />
      <SliderOption
        title={"Chat height"}
        min={0}
        max={400}
        step={1}
        value={playerCopy.chat.height}
        defaultValue={playerDefaultValues.chat.height}
        onChange={(value) => chatChanged("height", value)}
      />
    </div>
  );

  return (
    <div className="view-wrapper">
      <div className="dialog settings-view">
        <h1>Replay settings</h1>
        <button onClick={onClose} data-hook="close">Close</button>
        <div className="tabcontents">
          {renderVideo()}
        </div>
      </div>
    </div>
  );
}
