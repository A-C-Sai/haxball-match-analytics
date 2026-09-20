import React from "react";

/**
 * Registry of overlay features this menu can toggle. Adding a new overlay
 * feature later (passing lanes, LOS, heatmaps, ...) means adding one entry
 * here and one matching default in Game.jsx's initial `overlaySettings`
 * state — the checkbox list below renders itself from this registry, no
 * other UI/logic changes needed.
 */
export const OVERLAY_FEATURES = [
  { key: "momentum", label: "Momentum" },
  { key: "trajectory", label: "Ball path" },
];

/**
 * Bottom-right overlay control panel.
 *
 * `settings` shape: { enabled, team, features: { [featureKey]: boolean } }.
 * - `enabled` is the master authority, deliberately separate from
 *   `features` — it does not get merged into or derived from the
 *   per-feature toggles. Whatever the individual feature checkboxes say,
 *   `enabled: false` means nothing computes or renders, full stop. This
 *   also means feature checkboxes stay interactive regardless of `enabled`
 *   — you can preselect momentum/LOS/etc. while the overlay is off, then
 *   flip `enabled` on and they're already configured.
 * - `team` is "both" | 1 (red) | 2 (blue), matching Haxball's own numeric
 *   team convention used everywhere else in this codebase. Shared across
 *   all features — there's one team filter, not one per feature.
 * - `features` is a per-feature on/off map, independent of each other and
 *   independent of `enabled`, so any combination (just momentum, just
 *   passing lanes, both, none, ...) is directly expressible.
 *
 * Session-only by design (no localStorage/player-data persistence) — resets
 * to defaults each time the app opens.
 */
export default function OverlayControls({ settings, onChange }) {
  const setEnabled = (enabled) => onChange({ ...settings, enabled });
  const setTeam = (team) => onChange({ ...settings, team });
  const toggleFeature = (key) =>
    onChange({ ...settings, features: { ...settings.features, [key]: !settings.features[key] } });

  const anyFeatureEnabled = Object.values(settings.features).some(Boolean);
  const overlayActive = settings.enabled && anyFeatureEnabled;

  return (
    <div className="overlay-controls">
      <label className="overlay-controls-master">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Overlay
      </label>

      <div className="overlay-controls-features">
        {OVERLAY_FEATURES.map(({ key, label }) => (
          <label key={key} className="overlay-controls-feature-row">
            <input
              type="checkbox"
              checked={!!settings.features[key]}
              onChange={() => toggleFeature(key)}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="overlay-controls-teams">
        <button
          type="button"
          className={settings.team === "both" ? "active" : ""}
          onClick={() => setTeam("both")}
          disabled={!overlayActive}
        >
          Both
        </button>
        <button
          type="button"
          className={settings.team === 1 ? "active" : ""}
          onClick={() => setTeam(1)}
          disabled={!overlayActive}
        >
          Red
        </button>
        <button
          type="button"
          className={settings.team === 2 ? "active" : ""}
          onClick={() => setTeam(2)}
          disabled={!overlayActive}
        >
          Blue
        </button>
      </div>
    </div>
  );
}
