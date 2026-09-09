import { useCallback, useEffect, useRef, useState } from "react";
import { Stage } from "./stage/Stage.js";
import { prewarmScene, isLoaded } from "./stage/artCache.js";
import { startStory, sendChoice2D } from "./api2d.js";

import StartScreen2D from "./ui2d/StartScreen2D.jsx";
import NarrativePanel from "./ui2d/NarrativePanel.jsx";
import ChoiceBar from "./ui2d/ChoiceBar.jsx";
import StatusBar from "./ui2d/StatusBar.jsx";
import Curtain from "./ui2d/Curtain.jsx";
import SpeakerPortrait from "./ui2d/SpeakerPortrait.jsx";
import EndingScreen2D from "./ui2d/EndingScreen2D.jsx";

export default function App() {
  const [phase, setPhase] = useState("start"); // 'start' | 'playing'
  const [session, setSession] = useState(null);
  const [bible, setBible] = useState(null);

  const [prose, setProse] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const [curtain, setCurtain] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [reachIds, setReachIds] = useState([]);
  const [examined, setExamined] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [acting, setActing] = useState(false);
  const [painting, setPainting] = useState(null);
  // The controls are worth stating once and then getting out of the way; left up, the
  // hint just sits under the examine panel for the rest of the game.
  const [showHint, setShowHint] = useState(true);
  // Who we believe is speaking while the next turn is still streaming. The turn itself
  // carries `speaker`, but that only arrives at the end — and when the player has just
  // chosen to talk to someone we already know who it is, so the portrait can be up while
  // they read rather than appearing forty seconds later.
  const [pendingSpeaker, setPendingSpeaker] = useState(null);

  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const playerXRef = useRef(0.5);
  const lastStartRef = useRef(null);

  // Mount the stage exactly once, only while playing.
  useEffect(() => {
    if (phase !== "playing" || !containerRef.current) return undefined;
    const stage = new Stage(containerRef.current);
    stageRef.current = stage;

    stage.onReach = setReachIds;
    stage.onExamine = (actor) => setExamined(actor);
    stage.onSpeech = setSpeech;
    stage.onPlayerMove = (x) => {
      playerXRef.current = x;
    };
    // Walking away from something dismisses whatever it told you.
    stage.onFocus = () => {};

    return () => {
      stage.dispose();
      stageRef.current = null;
    };
  }, [phase]);

  // Draw each new turn. The scene is diffed against what is already on stage, so
  // persisting actors glide rather than being torn down and rebuilt.
  useEffect(() => {
    const stage = stageRef.current;
    const state = session?.state;
    if (!stage || !state?.scene) return;

    let cancelled = false;
    (async () => {
      await stage.setScene(state.scene, {
        bible,
        sessionId: session.sessionId,
        relocated: Boolean(state.relocated),
      });
      if (cancelled) return;

      if (state.beats?.length) {
        setActing(true);
        await stage.playBeats(state.beats);
        if (!cancelled) setActing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.state, session?.turnIndex]);

  // The examine bubble belongs to the thing you are standing at; step away and it goes.
  useEffect(() => {
    if (examined && !reachIds.includes(examined.id)) setExamined(null);
  }, [reachIds, examined]);

  useEffect(() => {
    if (phase !== "playing") return undefined;
    const id = setTimeout(() => setShowHint(false), 14000);
    return () => clearTimeout(id);
  }, [phase]);

  const handleStart = useCallback(async (payload) => {
    lastStartRef.current = payload;
    setBusy(true);
    setError(null);
    setProse("");
    setStreaming(true);
    setCurtain({ phase: "art-direction", done: 0, total: 0 });

    let liveBible = null;
    let liveProse = "";

    try {
      const turn = await startStory(payload, {
        status: (p) => setCurtain((c) => ({ ...(c || {}), phase: p })),
        style: (b) => {
          liveBible = b;
          setBible(b);
          setCurtain((c) => ({ ...(c || {}), bible: b }));
        },
        prose: (delta) => {
          liveProse += delta;
          setProse(liveProse);
          setCurtain((c) => ({ ...(c || {}), prose: liveProse }));
        },
        proseReset: () => {
          liveProse = "";
          setProse("");
          setCurtain((c) => ({ ...(c || {}), prose: "" }));
        },
      });

      setStreaming(false);
      const artBible = turn.bible || liveBible;
      setBible(artBible);

      // Every picture is generated before the player is let in. Generation is slow, but
      // a world that appears finished is worth far more than one that starts sooner and
      // assembles itself around them over the following minute.
      setCurtain((c) => ({ ...(c || {}), phase: "painting", done: 0, total: 1 }));
      await prewarmScene({
        sessionId: turn.sessionId,
        scene: turn.state.scene,
        bible: artBible,
        onProgress: (done, total, label) =>
          setCurtain((c) => ({ ...(c || {}), phase: "painting", done, total, label })),
      });

      setSession(turn);
      setPhase("playing");
      setCurtain(null);
      setCollapsed(false);
    } catch (err) {
      setStreaming(false);
      setError(err.message);
      setCurtain((c) => ({ ...(c || {}), error: err.message }));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleChoose = useCallback(
    async (payload) => {
      if (!session || busy || acting) return;

      setBusy(true);
      setError(null);
      setExamined(null);
      setProse("");
      setStreaming(true);
      setCollapsed(false);

      // If this action is aimed at a person, put their portrait up now rather than when
      // the turn lands. Anything else clears it, so we never leave the wrong face up.
      const actors = session.state?.scene?.actors || [];
      const chosen = (session.state?.choices || []).find((c) => c.id === payload.choiceId);
      const aimedAt =
        actors.find((a) => a.character && payload.freeText?.includes(a.label)) ||
        (chosen?.requires_near && actors.find((a) => a.id === chosen.requires_near && a.character));
      setPendingSpeaker(aimedAt || null);

      let liveProse = "";

      try {
        const turn = await sendChoice2D(
          session.sessionId,
          { ...payload, playerX: playerXRef.current },
          {
            prose: (delta) => {
              liveProse += delta;
              setProse(liveProse);
            },
            proseReset: () => {
              liveProse = "";
              setProse("");
            },
          }
        );
        setStreaming(false);

        // Mid-game there is deliberately no full-screen curtain: the player stays in the
        // world reading the new prose. Only genuinely new art has to be waited for, and
        // only a relocation repaints everything.
        const state = turn.state;
        const onStage = state.scene?.actors || [];
        // Resolve changed ids against the merged scene rather than using the delta
        // entries directly: a restyle carries only id and label, so a repainted person
        // would otherwise lose their `character` flag and never get a new portrait.
        const changedIds = new Set(
          [...(state.scene_delta?.add || []), ...(state.scene_delta?.restyle || [])].map((a) => a.id)
        );
        const fresh = state.relocated ? onStage : onStage.filter((a) => changedIds.has(a.id));
        const unpainted = fresh.filter((a) => a.label && !isLoaded("figure", a.label));

        const needsBackdrop =
          state.relocated && state.scene?.backdrop?.description &&
          !isLoaded("backdrop", state.scene.backdrop.description);

        if (unpainted.length || needsBackdrop) {
          setPainting({ done: 0, total: unpainted.length + (needsBackdrop ? 1 : 0) });
          await prewarmScene({
            sessionId: session.sessionId,
            scene: state.relocated ? state.scene : { backdrop: null, actors: unpainted },
            bible,
            onProgress: (done, total) => setPainting({ done, total }),
          });
          setPainting(null);
        }

        setSession(turn);
      } catch (err) {
        setStreaming(false);
        setError(err.message);
      } finally {
        setBusy(false);
        setPainting(null);
      }
    },
    [session, busy, acting, bible]
  );

  const handleWalkTo = useCallback((actorId) => {
    stageRef.current?.approach(actorId);
  }, []);

  function handleRestart() {
    setSession(null);
    setBible(null);
    setPhase("start");
    setProse("");
    setError(null);
    setExamined(null);
    setReachIds([]);
  }

  if (phase === "start") {
    return (
      <>
        <StartScreen2D onStart={handleStart} busy={busy} error={curtain ? null : error} />
        {curtain && (
          <Curtain
            {...curtain}
            onRetry={
              curtain.error
                ? () => {
                    setCurtain(null);
                    setError(null);
                    if (lastStartRef.current) handleStart(lastStartRef.current);
                  }
                : undefined
            }
          />
        )}
      </>
    );
  }

  const state = session?.state;
  const ended = Boolean(state?.ending);
  // While a turn streams, `state` is still the previous one — so trust the optimistic
  // guess then, and the turn's own `speaker` once it has actually arrived.
  const speakerActor = streaming
    ? pendingSpeaker
    : (state?.scene?.actors || []).find((a) => a.id === state?.speaker) || null;

  return (
    <div className="game2d">
      <div className="stage-container" ref={containerRef} />

      <StatusBar
        title={bible?.title}
        objective={state?.objective}
        progress={state?.progress}
        stats={state?.state_updates}
        turnIndex={session?.turnIndex - 1}
      />

      {examined && (
        <div className="examine">
          <div className="examine-name">{examined.label}</div>
          {examined.detail && <p className="examine-detail">{examined.detail}</p>}
          <div className="examine-actions">
            <button
              disabled={busy || acting || ended}
              onClick={() =>
                handleChoose(
                  examined.character
                    ? { freeText: `Approach ${examined.label} and speak with them.` }
                    : { examined: examined.label }
                )
              }
            >
              {examined.character ? "Talk to them" : "Take a closer look"}
            </button>
            <button className="ghost" onClick={() => setExamined(null)}>
              Leave it
            </button>
          </div>
        </div>
      )}

      {speech && (
        <div className={`speech ${speech.kind}`}>
          {speech.kind === "say" ? `“${speech.text}”` : speech.text}
        </div>
      )}

      {acting && (
        <button className="skip" onClick={() => stageRef.current?.cancelBeats()}>
          Skip
        </button>
      )}

      {painting && (
        <div className="painting-badge">
          painting {painting.done}/{painting.total}
        </div>
      )}

      <NarrativePanel
        text={prose}
        streaming={streaming}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        portrait={
          speakerActor && <SpeakerPortrait sessionId={session?.sessionId} actor={speakerActor} />
        }
      />

      <ChoiceBar
        choices={state?.choices}
        actors={state?.scene?.actors}
        reachIds={reachIds}
        busy={busy || acting}
        hidden={ended || streaming}
        onChoose={handleChoose}
        onWalkTo={handleWalkTo}
      />

      {busy && !streaming && <div className="turn-progress" />}

      {showHint && !examined && (
        <div className="controls-hint">
          click to walk · click a thing to examine it · A/D or ←/→ · shift to run
        </div>
      )}

      {ended && (
        <EndingScreen2D
          ending={state.ending}
          title={bible?.title}
          objective={state.objective}
          turnIndex={session.turnIndex - 1}
          stats={state.state_updates}
          onRestart={handleRestart}
        />
      )}

      {error && <p className="error floating-error">{error}</p>}
    </div>
  );
}
