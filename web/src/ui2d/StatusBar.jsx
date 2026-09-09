// Objective, honest progress, and whatever stats this particular story decided to track.
//
// Without these it is an interactive story rather than a game: there is nothing to
// achieve and no way to tell whether a choice helped. The progress bar is allowed to go
// down, and does.

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value && typeof value === "object") return "";
  return String(value ?? "—");
}

function labelFor(key) {
  return key.replace(/_/g, " ");
}

// Free-form stat names, so anything the model tracks shows up. Two are hidden: the
// inferred-preference vector is research instrumentation rather than something the
// player should be reading, and nested objects have no sensible one-line rendering.
const HIDDEN = new Set(["inferred_preferences"]);

export default function StatusBar({ title, objective, progress, stats, turnIndex }) {
  const entries = Object.entries(stats || {})
    .filter(([key, value]) => !HIDDEN.has(key) && !(value && typeof value === "object" && !Array.isArray(value)))
    .slice(0, 5);

  const pct = Math.round(Math.min(Math.max(progress ?? 0, 0), 1) * 100);

  return (
    <div className="status">
      <div className="status-main">
        {title && <div className="status-title">{title}</div>}
        {objective && <div className="status-objective">{objective}</div>}
        <div className="status-progress" title={`${pct}% of the way there`}>
          <div className="status-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="status-meta">
          <span>{pct}%</span>
          <span>turn {(turnIndex ?? 0) + 1}</span>
        </div>
      </div>

      {entries.length > 0 && (
        <dl className="status-stats">
          {entries.map(([key, value]) => (
            <div key={key} className="status-stat">
              <dt>{labelFor(key)}</dt>
              <dd>{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
