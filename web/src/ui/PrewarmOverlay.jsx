// Shown while a world's artwork is generated, before the player is let into it.
// Generation is slow by nature (seconds per image, minutes per 3D model), so this makes
// the wait legible and shows what's being made rather than spinning blankly.
export default function PrewarmOverlay({ done, total, label, objective, narrative }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // The wait is 40+ seconds. Rather than watching a bar, the player reads the opening
  // of their own story and learns what they're trying to do — so by the time the world
  // is ready they're already oriented, and the dead time has become onboarding.
  return (
    <div className="prewarm-overlay">
      <div className="prewarm-card">
        {objective ? (
          <>
            <div className="prewarm-eyebrow">Your goal</div>
            <h2 className="prewarm-objective">{objective}</h2>
          </>
        ) : (
          <h2>Building the world</h2>
        )}

        {narrative && <p className="prewarm-narrative">{narrative}</p>}

        <div className="prewarm-bar">
          <div className="prewarm-fill" style={{ width: `${pct}%` }} />
        </div>

        <p className="prewarm-count">
          {label} · {done} of {total}
        </p>
        <p className="prewarm-note">
          Every object here is being built from scratch for this story. It only happens
          once — everything is cached afterwards.
        </p>
      </div>
    </div>
  );
}
