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

  const containerRef = useRef(null);
  const sceneRef = useRef(null);

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

  // Rebuild the 3D world whenever a new worldState arrives.
  useEffect(() => {
    if (session?.worldState?.scene && sceneRef.current) {
      sceneRef.current.setScene(session.worldState.scene);
    }
  }, [session?.worldState]);

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
      <ChoicePanel worldState={session?.worldState} onChoose={handleChoose} busy={busy} />
      {error && <p className="error floating-error">{error}</p>}
    </div>
  );
}
