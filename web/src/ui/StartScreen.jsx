import { useState } from "react";

export default function StartScreen({ onStart, busy, error }) {
  const [name, setName] = useState("");
  const [interests, setInterests] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [personalization, setPersonalization] = useState(true);
  const [evolving, setEvolving] = useState(true);
  const [engine, setEngine] = useState("llm");

  function submit(e) {
    e.preventDefault();
    if (!sourceText.trim()) return;
    onStart({
      profile: {
        name: name.trim() || "Player",
        interests: interests.split(",").map((s) => s.trim()).filter(Boolean),
      },
      sourceText: sourceText.trim(),
      ablation: { personalization, evolving, engine },
    });
  }

  return (
    <div className="start-screen">
      <form className="start-form" onSubmit={submit}>
        <h1>Interactive World Generation</h1>
        <p className="subtitle">
          Give it a chapter, an article, a subject to learn, or just a premise. It
          generates a walkable 3D world and continues the story from your choices.
        </p>

        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aiden" />
        </label>

        <label>
          Interests (comma separated)
          <input
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            placeholder="tennis, math, history"
          />
        </label>

        <label>
          Source text / premise
          <textarea
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            placeholder="Paste a chapter, a historical account, or describe a premise..."
            rows={8}
            required
          />
        </label>

        <div className="ablation-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={personalization}
              onChange={(e) => setPersonalization(e.target.checked)}
            />
            Personalization on
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={evolving} onChange={(e) => setEvolving(e.target.checked)} />
            Evolving narrative (vs. memoryless baseline)
          </label>
        </div>

        <label>
          Generation engine
          <select value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="llm">Claude (generated)</option>
            <option value="template">Template baseline (non-LLM, for comparison)</option>
          </select>
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "Generating world..." : "Begin"}
        </button>
      </form>
    </div>
  );
}
