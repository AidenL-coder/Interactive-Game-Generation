// Shown when the story actually concludes. Without a real ending the game just drifts,
// and nothing that came before it carries any weight — an outcome you can reach is what
// makes the choices along the way matter.

const OUTCOMES = {
  victory: { title: "You succeeded", tone: "victory" },
  defeat: { title: "You failed", tone: "defeat" },
  bittersweet: { title: "It ended", tone: "bittersweet" },
};

export default function EndingScreen({ ending, objective, turnIndex, stats, onRestart }) {
  const { title, tone } = OUTCOMES[ending?.outcome] || OUTCOMES.bittersweet;

  // Research-internal, never player-facing.
  const shown = Object.entries(stats || {}).filter(([k]) => k !== "inferred_preferences");

  return (
    <div className="ending-overlay">
      <div className={`ending-card ending-${tone}`}>
        <div className="ending-outcome">{title}</div>
        {objective && <p className="ending-objective">{objective}</p>}

        <p className="ending-epilogue">{ending?.epilogue}</p>

        <div className="ending-stats">
          <span>{turnIndex ?? 0} turns</span>
          {shown.map(([key, value]) => (
            <span key={key}>
              {key.replace(/_/g, " ")}: {Array.isArray(value) ? value.length : String(value)}
            </span>
          ))}
        </div>

        <button onClick={onRestart}>Play another story</button>
      </div>
    </div>
  );
}
