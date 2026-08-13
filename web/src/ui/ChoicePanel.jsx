import { useState } from "react";

export default function ChoicePanel({ worldState, onChoose, busy }) {
  const [freeText, setFreeText] = useState("");

  if (!worldState) return null;

  function submitFreeText(e) {
    e.preventDefault();
    if (!freeText.trim()) return;
    onChoose({ freeText: freeText.trim() });
    setFreeText("");
  }

  return (
    <div className="choice-panel">
      <p className="narrative-text">{worldState.narrative}</p>

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
