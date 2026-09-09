import { useState } from "react";

/**
 * The actions available this turn.
 *
 * A choice tied to a place is shown locked until the player is standing at the thing —
 * and clicking it walks them there rather than refusing, so the gate reads as an
 * instruction rather than as a rejection. This is what makes the stage load-bearing: the
 * walk is part of choosing, not an activity happening alongside a menu.
 */
export default function ChoiceBar({
  choices,
  actors,
  reachIds,
  busy,
  onChoose,
  onWalkTo,
  hidden,
}) {
  const [freeText, setFreeText] = useState("");
  const [typing, setTyping] = useState(false);

  if (hidden || !choices?.length) return null;

  const near = new Set(reachIds || []);
  const byId = new Map((actors || []).map((a) => [a.id, a]));

  // Labels are painterly briefs ("a battered brass and iron diving bell, streaked with
  // weed-stain, its one window dark"). A destination badge wants the name of the thing,
  // so take the first clause, drop the article, and keep it to a few words — a badge that
  // wraps to three lines is worse than one that says less.
  function shortName(label) {
    if (!label) return "there";
    const head = String(label)
      .split(/[,—(:]/)[0]
      .trim()
      .replace(/^(a|an|the)\s+/i, "");
    const words = head.split(/\s+/);
    const kept = words.length > 4 ? words.slice(-3).join(" ") : head;
    return kept.length > 24 ? `${kept.slice(0, 22)}…` : kept;
  }

  function submitFree(e) {
    e.preventDefault();
    const text = freeText.trim();
    if (!text || busy) return;
    setFreeText("");
    setTyping(false);
    onChoose({ freeText: text });
  }

  return (
    <div className={`choices${busy ? " busy" : ""}`}>
      {choices.map((choice) => {
        const gate = choice.requires_near;
        const locked = gate && !near.has(gate);
        const target = gate ? byId.get(gate) : null;

        return (
          <button
            key={choice.id}
            className={`choice${locked ? " locked" : ""}`}
            disabled={busy}
            onClick={() => (locked ? onWalkTo(gate) : onChoose({ choiceId: choice.id }))}
            title={locked ? `Walk to ${shortName(target?.label)} first` : undefined}
          >
            <span className="choice-text">{choice.text}</span>
            {locked && <span className="choice-gate">go to {shortName(target?.label)}</span>}
          </button>
        );
      })}

      {typing ? (
        <form className="choice-free" onSubmit={submitFree}>
          <input
            autoFocus
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onBlur={() => !freeText && setTyping(false)}
            placeholder="Do something else…"
            disabled={busy}
            maxLength={280}
          />
          <button type="submit" disabled={busy || !freeText.trim()}>
            Do it
          </button>
        </form>
      ) : (
        <button className="choice ghost" disabled={busy} onClick={() => setTyping(true)}>
          Something else…
        </button>
      )}
    </div>
  );
}
