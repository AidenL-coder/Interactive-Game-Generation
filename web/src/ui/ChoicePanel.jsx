import { useEffect, useState } from "react";

// Roughly how much prose fits in the collapsed panel before it's worth offering "more".
// Below this the toggle would be noise, so it isn't shown at all.
const COLLAPSE_THRESHOLD = 260;

export default function ChoicePanel({ worldState, onChoose, busy }) {
  const [freeText, setFreeText] = useState("");
  const [expanded, setExpanded] = useState(false);

  const narrative = worldState?.narrative || "";
  const isLong = narrative.length > COLLAPSE_THRESHOLD;

  // Each new beat starts collapsed, so the world stays visible by default and a long
  // turn doesn't leave the panel stuck open over the next scene.
  useEffect(() => {
    setExpanded(false);
  }, [narrative]);

  if (!worldState) return null;

  function submitFreeText(e) {
    e.preventDefault();
    if (!freeText.trim()) return;
    onChoose({ freeText: freeText.trim() });
    setFreeText("");
  }

  return (
    <div className={`choice-panel${expanded ? " expanded" : ""}`}>
      <div className="narrative-wrap">
        <p className={`narrative-text${isLong && !expanded ? " clamped" : ""}`}>{narrative}</p>
        {isLong && (
          <button
            type="button"
            className="narrative-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Show less ▲" : "Read more ▼"}
          </button>
        )}
      </div>

      <div className="choice-buttons">
        {(worldState.choices || []).map((c) => (
          <button key={c.id} disabled={busy} onClick={() => onChoose({ choiceId: c.id })}>
            {c.text}
          </button>
        ))}
      </div>

      <form className="freetext-row" onSubmit={submitFreeText}>
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="Or type your own action..."
          disabled={busy}
        />
        <button type="submit" disabled={busy || !freeText.trim()}>
          Go
        </button>
      </form>

      {busy && <p className="generating-hint">Generating next scene...</p>}
    </div>
  );
}
