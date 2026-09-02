// Shown while a world's artwork is generated, before the player is let into it.
// Generation is slow by nature (seconds per image, minutes per 3D model), so this makes
// the wait legible and shows what's being made rather than spinning blankly.
export default function PrewarmOverlay({ done, total, label }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="prewarm-overlay">
      <div className="prewarm-card">
        <h2>Building the world</h2>
        <p className="prewarm-label">{label}</p>

        <div className="prewarm-bar">
          <div className="prewarm-fill" style={{ width: `${pct}%` }} />
        </div>

        <p className="prewarm-count">
          {done} of {total} pieces
        </p>
        <p className="prewarm-note">
          Every object here is being drawn from scratch for this story. This takes a
          minute, and only happens once — it's cached afterwards.
        </p>
      </div>
    </div>
  );
}
