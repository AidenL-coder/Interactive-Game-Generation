import { useEffect, useState } from "react";
import { fetchPacks } from "../api2d.js";

// Four premises deliberately spread across genre, register and period, because the
// thing worth showing off is that the art direction, the place and the mechanics come
// out different every time. They are one click each so a demo never opens with someone
// typing.
const EXAMPLES = [
  {
    name: "The Salvage",
    text:
      "A diving bell sits on the deck of a rusting salvage barge in the North Sea. Below " +
      "it is a wreck nobody will name, and the crew have stopped answering questions " +
      "about the last diver who went down.",
  },
  {
    name: "The Orchard",
    text:
      "The last teaching orchard of a monastery that no longer has monks. An archivist " +
      "arrives to catalogue the trees before the land is sold, and finds every one of " +
      "them labelled in the same handwriting, including the ones planted after the last " +
      "brother died.",
  },
  {
    name: "Nightshift",
    text:
      "A twenty-four hour laundrette on a road out of a town that is emptying. The " +
      "machines run all night whether or not anyone is there. Tonight somebody has left " +
      "a full load and a set of car keys, and has not come back for either.",
  },
  {
    name: "The Cartographer",
    text:
      "A mapmaker is commissioned to survey a valley that appears on no two maps in the " +
      "same place. The villagers are helpful, precise, and describe entirely different " +
      "roads.",
  },
];

export default function StartScreen2D({ onStart, busy, error }) {
  const [name, setName] = useState("");
  const [interests, setInterests] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [packs, setPacks] = useState([]);

  useEffect(() => {
    let live = true;
    fetchPacks().then((list) => live && setPacks(list));
    return () => {
      live = false;
    };
  }, []);

  function profileNow() {
    return {
      name: name.trim() || "the player",
      interests: interests
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  function submit(e) {
    e?.preventDefault();
    const text = sourceText.trim();
    if (!text || busy) return;
    onStart({ profile: profileNow(), sourceText: text });
  }

  function startPack(packId) {
    if (busy) return;
    onStart({ profile: profileNow(), packId });
  }

  return (
    <div className="start2d">
      <div className="start2d-inner">
        <header className="start2d-head">
          <h1>An illustrated adventure, made from whatever you give it</h1>
          <p>
            Paste a premise, a chapter, a historical account — anything. It is painted
            into a place you can walk through, populated with people you can talk to, and
            given something to achieve and a way to fail at it.
          </p>
        </header>

        {packs.length > 0 && (
          <section className="start2d-packs">
            <div className="packs-head">
              <span className="packs-label">Ready to play</span>
              <span className="packs-note">
                already painted — starts straight away, and the story is still written as you play
              </span>
              {packs.some((p) => p.engines?.includes("3d")) && (
                <a className="packs-3d" href="?engine=3d">
                  or walk it in 3D →
                </a>
              )}
            </div>
            {packs.map((p) => (
              <button
                key={p.id}
                type="button"
                className="pack-card"
                data-pack-id={p.id}
                disabled={busy}
                onClick={() => startPack(p.id)}
              >
                <span className="pack-title">{p.title}</span>
                <span className="pack-blurb">{p.blurb}</span>
                <span className="pack-meta">
                  {p.places} places · {p.cast} things to find · no wait
                </span>
              </button>
            ))}
          </section>
        )}

        <form onSubmit={submit}>
          <label className="field">
            <span>{packs.length ? "Or make a new one from anything" : "The story"}</span>
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="A lighthouse keeper's logbook stops mid-sentence on the third of November..."
              rows={6}
              disabled={busy}
            />
          </label>

          <div className="start2d-examples">
            <span className="examples-label">or start from</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.name}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setSourceText(ex.text)}
              >
                {ex.name}
              </button>
            ))}
          </div>

          <div className="start2d-row">
            <label className="field">
              <span>Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Aiden"
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>Things you like</span>
              <input
                value={interests}
                onChange={(e) => setInterests(e.target.value)}
                placeholder="deep sea, folk horror, machines"
                disabled={busy}
              />
            </label>
          </div>
          <p className="field-note">
            Both are woven into the world and into who your character is — they are not
            cosmetic.
          </p>

          <button className="start2d-go" type="submit" disabled={busy || !sourceText.trim()}>
            {busy ? "Building the world…" : "Begin"}
          </button>

          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
