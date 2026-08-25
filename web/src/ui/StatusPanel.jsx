// Surfaces the state the model already tracks in `state_updates`. It was being logged
// and fed back into prompts but never shown, so choices had no visible consequences —
// stakes you can't see aren't stakes.

// Research-internal fields the player shouldn't see: inferred_preferences is the
// personalization estimate (docs/research.md), not part of the fiction.
const HIDDEN_KEYS = new Set(["inferred_preferences"]);

function titleCase(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${titleCase(k)}: ${v}`)
      .join(" · ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export default function StatusPanel({ worldState, turnIndex }) {
  const state = worldState?.state_updates;
  const entries = Object.entries(state || {}).filter(
    ([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && v !== ""
  );

  const scene = worldState?.scene;

  return (
    <div className="status-panel">
      <div className="status-scene">
        {scene ? `${scene.biome} · ${scene.mood} · ${scene.time_of_day}` : "—"}
        <span className="status-turn">Turn {turnIndex ?? 0}</span>
      </div>

      {entries.length > 0 && (
        <dl className="status-stats">
          {entries.map(([key, value]) => (
            <div key={key} className="status-row">
              <dt>{titleCase(key)}</dt>
              <dd>{renderValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
