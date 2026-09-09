import { useEffect, useState } from "react";
import { loadArt } from "../stage/artCache.js";

/**
 * The painted portrait of whoever is talking, shown beside the prose.
 *
 * Portraits are generated for every character in the scene anyway, so this costs nothing
 * extra — and it is the difference between reading a paragraph that mentions someone and
 * being spoken to by them.
 */
export default function SpeakerPortrait({ sessionId, actor }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    if (!actor?.label) return undefined;

    loadArt({ sessionId, kind: "portrait", description: actor.label }).then((art) => {
      if (live) setUrl(art?.url || null);
    });
    return () => {
      live = false;
    };
  }, [sessionId, actor?.label]);

  if (!actor) return null;

  // The name is the first clause of the label; the rest is the painter's brief.
  const name = String(actor.label).split(/[,—(]/)[0].trim();

  return (
    <div className={`speaker${url ? " has-art" : ""}`} key={actor.id}>
      <div className="speaker-frame">
        {url ? <img src={url} alt={name} /> : <div className="speaker-blank" />}
      </div>
      <div className="speaker-name">{name}</div>
    </div>
  );
}
