import { useEffect, useRef, useState } from "react";
import { paragraphsOf } from "./prose.js";

/**
 * The prose for the current beat.
 *
 * Text arrives a character at a time while the rest of the turn is still generating, so
 * this is what the player is looking at during the wait rather than a spinner. It
 * collapses out of the way once they have read it, because the picture is the point.
 */
export default function NarrativePanel({ text, streaming, collapsed, onToggle, portrait }) {
  const bodyRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  // Follow the text as it streams, but stop the moment the player scrolls up to re-read
  // something — yanking them back to the bottom mid-sentence is maddening.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || !autoScroll || !streaming) return;
    node.scrollTop = node.scrollHeight;
  }, [text, autoScroll, streaming]);

  // Once the beat is fully written, go back to the start of it. Following the stream
  // leaves the panel parked at the bottom, so the finished turn opens mid-sentence with
  // its first two paragraphs scrolled out of sight.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || streaming) return;
    setAutoScroll(true);
    node.scrollTo({ top: 0, behavior: "smooth" });
  }, [streaming]);

  // Whether anything is still below the fold. Drives the fade at the bottom edge: with
  // the panel parked at the top of a long beat, a hard cut through a line of glyphs is
  // indistinguishable from the game having truncated the sentence, and was read that way
  // by both a vision player and a judge.
  function measureOverflow() {
    const node = bodyRef.current;
    if (!node) return;
    setHasMore(node.scrollHeight - node.scrollTop - node.clientHeight > 8);
  }

  useEffect(measureOverflow, [text, collapsed, streaming]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = bodyRef.current;
    if (!node) return;
    // The panel is sized in vh, so the fold moves when the window does.
    const ro = new ResizeObserver(measureOverflow);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  function handleScroll() {
    const node = bodyRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setAutoScroll(atBottom);
    measureOverflow();
  }

  if (!text) return null;

  const paragraphs = paragraphsOf(text);
  if (!paragraphs.length) return null;

  return (
    <div className={`narrative${collapsed ? " collapsed" : ""}${streaming ? " streaming" : ""}`}>
      <button
        className="narrative-toggle"
        onClick={onToggle}
        title={collapsed ? "Show the text" : "Hide the text"}
      >
        {collapsed ? "Read" : "Hide"}
      </button>

      <div className="narrative-inner">
        {portrait}
        <div
          className={`narrative-body${hasMore ? " has-more" : ""}`}
          ref={bodyRef}
          onScroll={handleScroll}
        >
          {paragraphs.map((p, i) => (
            <p key={i}>
              {p}
              {/* A caret on the final paragraph while text is still arriving, so a pause
                  in the stream reads as thinking rather than as being finished. */}
              {streaming && i === paragraphs.length - 1 && <span className="caret" />}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
