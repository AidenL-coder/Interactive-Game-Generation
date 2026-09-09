import { paragraphsOf } from "./prose.js";

/**
 * Shown while a scene's artwork is being painted.
 *
 * It carries the game's title, the art direction that was just decided, and the opening
 * prose — so the wait is spent reading the thing you are about to play rather than
 * watching a bar. That matters: generating a first scene's art is the longest single
 * wait in the whole system.
 */
export default function Curtain({ phase, done, total, label, bible, prose, error, onRetry }) {
  const pct = total ? Math.round((done / total) * 100) : 0;

  const heading =
    phase === "art-direction"
      ? "Deciding how this will look"
      : phase === "writing"
        ? "Writing the opening"
        : "Painting the world";

  return (
    <div className="curtain">
      <div className="curtain-inner">
        <div className="curtain-head">
          {/* The title is the first thing the game has decided about itself, so it stays
              up from the moment it exists rather than only during the last phase. */}
          {bible?.title && <div className="curtain-title">{bible.title}</div>}
          <h2>{heading}</h2>
          {bible?.medium && <p className="curtain-medium">{bible.medium}</p>}
        </div>

        {prose && (
          <div className="curtain-prose">
            {paragraphsOf(prose).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}

        {error ? (
          <div className="curtain-error">
            <p className="error">{error}</p>
            {onRetry && (
              <button className="start2d-go" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="curtain-progress">
            <div className="curtain-bar">
              <div className="curtain-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="curtain-status">
              {total ? (
                <>
                  <span className="curtain-label">{label}</span>
                  <span className="curtain-count">
                    {done} / {total}
                  </span>
                </>
              ) : (
                <span className="curtain-label">working…</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
