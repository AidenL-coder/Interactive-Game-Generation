import { useEffect, useRef, useState } from "react";
import { Scene3D } from "./scene/SceneRenderer.js";
import StartScreen from "./ui/StartScreen.jsx";
import ChoicePanel from "./ui/ChoicePanel.jsx";
import StatusPanel from "./ui/StatusPanel.jsx";
import PrewarmOverlay from "./ui/PrewarmOverlay.jsx";
import EndingScreen from "./ui/EndingScreen.jsx";
import { prewarmScene } from "./scene/prewarm.js";
import { startSession, sendChoice } from "./api.js";

// The first-person 3D game: the other arm of the renderer comparison. It was the original
// front end, was unmounted when the 2D stage became the primary game, and is mounted again
// here (open the app with ?engine=3d) so the same pre-generated pack can be played — and
// judged — in both renderers.
export default function Game3D() {
  const [phase, setPhase] = useState("start"); // 'start' | 'playing'
  const [session, setSession] = useState(null); // { sessionId, ablation, worldState, turnIndex }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [playing, setPlaying] = useState(false); // avatar is acting out the last choice
  const [speech, setSpeech] = useState(null);
  const [focusLabel, setFocusLabel] = useState(null);
  const [prewarm, setPrewarm] = useState(null); // asset generation progress before entry
  const [nearbyIds, setNearbyIds] = useState([]); // props the player is standing at

  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const renderedTurnRef = useRef(null);

  // Mount/unmount the three.js scene exactly once, only while playing.
  useEffect(() => {
    if (phase !== "playing" || !containerRef.current) return undefined;
    const scene3d = new Scene3D(containerRef.current);
    sceneRef.current = scene3d;
    return () => {
      scene3d.dispose();
      sceneRef.current = null;
    };
  }, [phase]);

  // Reflect each new worldState in the 3D view. In persistent mode a turn usually
  // carries a delta, which mutates the existing world (animated) rather than rebuilding
  // it — rebuilding would throw away the continuity that mode exists to provide.
  useEffect(() => {
    const scene3d = sceneRef.current;
    const ws = session?.worldState;
    if (!scene3d || !ws?.scene) return;

    const isFirstRender = renderedTurnRef.current === null;
    const canMutate = !isFirstRender && !ws.relocated && ws.scene_delta !== undefined;

    if (canMutate) {
      // scene_delta null means "nothing physical changed" — still a valid turn.
      if (ws.scene_delta) scene3d.applyDelta(ws.scene_delta);
    } else {
      scene3d.setScene(ws.scene);
    }
    renderedTurnRef.current = session.turnIndex;

    if (ws.agent_actions?.length) {
      setPlaying(true);
      scene3d.playActions(ws.agent_actions).finally(() => setPlaying(false));
    }
  }, [session?.worldState]);

  // Surface `say` actions as on-screen speech, and the looked-at prop's label.
  useEffect(() => {
    const scene3d = sceneRef.current;
    if (!scene3d) return undefined;
    scene3d.onSay = setSpeech;
    scene3d.onFocus = setFocusLabel;
    scene3d.onNearby = setNearbyIds;
    return () => {
      scene3d.onSay = null;
      scene3d.onFocus = null;
      scene3d.onNearby = null;
    };
  }, [phase]);

  // Pressing E on a prop feeds it back as a normal turn, so exploring the world is a
  // way of making choices rather than a separate activity from them.
  useEffect(() => {
    const scene3d = sceneRef.current;
    if (!scene3d) return undefined;
    scene3d.onInteract = (prop) => {
      if (busy || playing) return;
      handleChoose({
        freeText: prop.character
          ? `Approach and speak with ${prop.label}.`
          : `Examine and interact with the ${prop.label}.`,
      });
    };
    return () => {
      scene3d.onInteract = null;
    };
  }, [phase, busy, playing, session?.sessionId]);

  function handleRestart() {
    setSession(null);
    setPhase("start");
    setError(null);
    renderedTurnRef.current = null;
  }

  async function handleStart(payload) {
    setBusy(true);
    setError(null);
    try {
      const result = await startSession(payload);

      // Generate every asset before showing the world. For a pre-generated pack this is
      // a read from disk and takes a moment; for a typed premise it is the slow part.
      const opening = {
        objective: result.worldState?.objective,
        narrative: result.worldState?.narrative,
      };
      setPrewarm({ done: 0, total: 1, label: "reading the world", ...opening });
      await prewarmScene(result.worldState?.scene, (done, total, label) =>
        setPrewarm({ done, total, label, ...opening })
      );
      setPrewarm(null);

      setSession(result);
      setPhase("playing");
    } catch (err) {
      setError(err.message);
      setPrewarm(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleChoose(choicePayload) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendChoice(session.sessionId, choicePayload);

      // Generate anything this turn introduces before showing it, so the world never
      // visibly assembles itself.
      //
      // This used to read `result.relocated`, which does not exist — the flag lives on
      // `result.worldState`. So a move to a new place prewarmed nothing but the (null)
      // delta: the new room's sky, ground and every object in it materialised around the
      // player instead of being ready behind the overlay.
      const ws = result.worldState;
      if (ws?.relocated && ws.scene) {
        setPrewarm({ done: 0, total: 1, label: "entering a new place" });
        await prewarmScene(ws.scene, (done, total, label) => setPrewarm({ done, total, label }));
        setPrewarm(null);
      } else if (ws?.scene_delta?.add?.length) {
        const fresh = ws.scene_delta.add;
        setPrewarm({ done: 0, total: fresh.length, label: "drawing what changed" });
        await prewarmScene(
          { environment: ws.scene.environment, props: fresh },
          (done, total, label) => setPrewarm({ done, total, label })
        );
        setPrewarm(null);
      }

      setSession(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (phase === "start") {
    return (
      <>
        <StartScreen onStart={handleStart} busy={busy} error={error} />
        {prewarm && <PrewarmOverlay {...prewarm} />}
      </>
    );
  }

  return (
    <div className="game-root">
      <div className="scene-container" ref={containerRef} />
      <div className="hint">
        WASD or ↑↓ move · ← → turn · click to look with the mouse · Shift run · E interact
      </div>

      {busy && <div className="turn-progress" />}

      <StatusPanel worldState={session?.worldState} turnIndex={session?.turnIndex} />

      {!playing && (
        <>
          <div className="crosshair" />
          {focusLabel && (
            <div className="focus-label">
              {focusLabel}
              <span className="focus-key">E</span>
            </div>
          )}
        </>
      )}

      {speech && <div className="speech-bubble">{speech}</div>}

      {playing && (
        <button className="skip-button" onClick={() => sceneRef.current?.cancelPlayback()}>
          Skip ⏭
        </button>
      )}

      <ChoicePanel
        worldState={session?.worldState}
        nearbyIds={nearbyIds}
        onChoose={handleChoose}
        busy={busy || playing || Boolean(session?.worldState?.ending)}
      />

      {prewarm && <PrewarmOverlay {...prewarm} />}

      {session?.worldState?.ending && (
        <EndingScreen
          ending={session.worldState.ending}
          objective={session.worldState.objective}
          turnIndex={session.turnIndex}
          stats={session.worldState.state_updates}
          onRestart={handleRestart}
        />
      )}

      {error && <p className="error floating-error">{error}</p>}
    </div>
  );
}
