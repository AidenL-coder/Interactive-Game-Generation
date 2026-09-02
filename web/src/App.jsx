import { useEffect, useRef, useState } from "react";
import { Scene3D } from "./scene/SceneRenderer.js";
import StartScreen from "./ui/StartScreen.jsx";
import ChoicePanel from "./ui/ChoicePanel.jsx";
import StatusPanel from "./ui/StatusPanel.jsx";
import PrewarmOverlay from "./ui/PrewarmOverlay.jsx";
import EndingScreen from "./ui/EndingScreen.jsx";
import { prewarmScene } from "./scene/prewarm.js";
import { startSession, sendChoice } from "./api.js";

export default function App() {
  const [phase, setPhase] = useState("start"); // 'start' | 'playing'
  const [session, setSession] = useState(null); // { sessionId, ablation, worldState, turnIndex }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [playing, setPlaying] = useState(false); // avatar is acting out the last choice
  const [speech, setSpeech] = useState(null);
  const [focusLabel, setFocusLabel] = useState(null);
  const [prewarm, setPrewarm] = useState(null); // asset generation progress before entry

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
    return () => {
      scene3d.onSay = null;
      scene3d.onFocus = null;
    };
  }, [phase]);

  // Pressing E on a prop feeds it back as a normal turn, so exploring the world is a
  // way of making choices rather than a separate activity from them. Re-bound whenever
  // handleChoose changes identity so it never captures a stale session.
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

      // Generate every asset before showing the world. Art generation is slow, but a
      // world that appears finished is worth far more than one that starts sooner and
      // materialises around the player over the following minute — especially when the
      // first thing anyone sees is the opening shot.
      setPrewarm({ done: 0, total: 1, label: "reading the world" });
      await prewarmScene(result.worldState?.scene, (done, total, label) =>
        setPrewarm({ done, total, label })
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

      // A delta can introduce objects that have never been drawn. Generate their art
      // before the turn is shown, so the world never visibly assembles itself.
      const added = result.worldState?.scene_delta?.add;
      const fresh = result.relocated ? result.worldState?.scene?.props : added;
      if (fresh?.length) {
        setPrewarm({ done: 0, total: fresh.length, label: "drawing what changed" });
        await prewarmScene(
          { environment: result.worldState.scene.environment, props: fresh },
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
      <div className="hint">Click to look · WASD move · Shift run · E interact · Esc release</div>

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
        onChoose={handleChoose}
        busy={busy || playing || Boolean(session?.worldState?.ending)}
      />

      {/* Also shown mid-game: a turn that introduces new objects generates their art
          before the turn is revealed, so the world never assembles itself on screen. */}
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
