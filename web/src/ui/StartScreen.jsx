import { useState } from "react";

// Chosen to be unlike each other — a ruin, a spacecraft, an interior, a historical
// setting — so it's immediately clear the system isn't drawing from a fantasy preset.
const EXAMPLE_PREMISES = [
  {
    label: "Drowned cathedral",
    text: "A drowned gothic cathedral, its nave flooded waist-deep, lit only by green light through broken stained glass. Something is still living in here.",
  },
  {
    label: "Derelict station",
    text: "A derelict orbital station whose hydroponics bay has gone feral. The crew are eleven years gone, but the lights still come on for someone.",
  },
  {
    label: "Desert market",
    text: "A sun-blasted desert trading market at high noon. A caravan has arrived carrying something it will not declare.",
  },
  {
    label: "Vanished keeper",
    text: "A lighthouse keeper has vanished. The lamp still turns. The tide is coming in and the causeway will be gone within the hour.",
  },
];

export default function StartScreen({ onStart, busy, error }) {
  const [name, setName] = useState("");
  const [interests, setInterests] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [personalization, setPersonalization] = useState(true);
  const [evolving, setEvolving] = useState(true);
  const [engine, setEngine] = useState("llm");
  const [persistent, setPersistent] = useState(true);

  function submit(e) {
    e.preventDefault();
    if (!sourceText.trim()) return;
    onStart({
      profile: {
        name: name.trim() || "Player",
        interests: interests.split(",").map((s) => s.trim()).filter(Boolean),
      },
      sourceText: sourceText.trim(),
      ablation: {
        personalization,
        evolving,
        engine,
        persistence: persistent ? "persistent" : "regenerated",
      },
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

        {/* A blank box is the worst moment of a demo — someone stares at it and can't
            think of anything. These are one click and deliberately unalike, to show the
            range rather than suggest a house style. */}
        <div className="premise-examples">
          <span className="premise-examples-label">Or try:</span>
          {EXAMPLE_PREMISES.map((p) => (
            <button
              key={p.label}
              type="button"
              className="premise-chip"
              onClick={() => setSourceText(p.text)}
            >
              {p.label}
            </button>
          ))}
        </div>

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
          <label className="checkbox">
            <input
              type="checkbox"
              checked={persistent}
              onChange={(e) => setPersistent(e.target.checked)}
            />
            Persistent world (vs. regenerated each turn)
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
