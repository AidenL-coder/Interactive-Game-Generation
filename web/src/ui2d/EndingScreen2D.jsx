import { paragraphsOf } from "./prose.js";

const OUTCOME = {
  victory: { word: "You did it", className: "victory" },
  defeat: { word: "You failed", className: "defeat" },
  bittersweet: { word: "It ends", className: "bittersweet" },
};

export default function EndingScreen2D({ ending, title, objective, turnIndex, stats, onRestart }) {
  const outcome = OUTCOME[ending?.outcome] || OUTCOME.bittersweet;
  const paragraphs = paragraphsOf(ending?.epilogue);

  const kept = Object.entries(stats || {}).filter(
    ([key, value]) =>
      key !== "inferred_preferences" && !(value && typeof value === "object" && !Array.isArray(value))
  );

  return (
    <div className={`ending ${outcome.className}`}>
      <div className="ending-inner">
        <div className="ending-outcome">{outcome.word}</div>
        {title && <h2 className="ending-title">{title}</h2>}
        {objective && <p className="ending-objective">{objective}</p>}

        <div className="ending-epilogue">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        <div className="ending-footer">
          <span>{(turnIndex ?? 0) + 1} turns</span>
          {kept.map(([key, value]) => (
            <span key={key}>
              {key.replace(/_/g, " ")}: {Array.isArray(value) ? value.length : String(value)}
            </span>
          ))}
        </div>

        <button className="start2d-go" onClick={onRestart}>
          Play something else
        </button>
      </div>
    </div>
  );
}
