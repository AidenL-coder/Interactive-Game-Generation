import { useEffect, useRef, useState } from "react";
import { Scene3D } from "./scene/SceneRenderer.js";
import StartScreen from "./ui/StartScreen.jsx";
import ChoicePanel from "./ui/ChoicePanel.jsx";
import { startSession, sendChoice } from "./api.js";

export default function App() {
  const [phase, setPhase] = useState("start"); // 'start' | 'playing'
  const [session, setSession] = useState(null); // { sessionId, ablation, worldState, turnIndex }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [playing, setPlaying] = useState(false); // avatar is acting out the last choice
  const [speech, setSpeech] = useState(null);

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
      if (ws.scene_delta) scene3d.applyDelta(ws.scene_delta, ws.scene.mood);
    } else {
      scene3d.setScene(ws.scene);
    }
    renderedTurnRef.current = session.turnIndex;

    if (ws.agent_actions?.length) {
      setPlaying(true);
      scene3d.playActions(ws.agent_actions).finally(() => setPlaying(false));
    }
  }, [session?.worldState]);

  // Surface `say` actions as on-screen speech while the avatar acts.
  useEffect(() => {
    const scene3d = sceneRef.current;
    if (!scene3d) return undefined;
    scene3d.onSay = setSpeech;
    return () => {
      scene3d.onSay = null;
    };
  }, [phase]);

  async function handleStart(payload) {
    setBusy(true);
    setError(null);
    try {
      const result = await startSession(payload);
      setSession(result);
      setPhase("playing");
    } catch (err) {
      setError(err.message);
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
      setSession(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (phase === "start") {
    return <StartScreen onStart={handleStart} busy={busy} error={error} />;
  }

  return (
    <div className="game-root">
      <div className="scene-container" ref={containerRef} />
      <div className="hint">Click to look around · WASD to move · Esc to release</div>

      {speech && <div className="speech-bubble">{speech}</div>}

      {playing && (
        <button className="skip-button" onClick={() => sceneRef.current?.cancelPlayback()}>
          Skip ⏭
        </button>
      )}

      <ChoicePanel
        worldState={session?.worldState}
        onChoose={handleChoose}
        busy={busy || playing}
      />
      {error && <p className="error floating-error">{error}</p>}
    </div>
  );
}
