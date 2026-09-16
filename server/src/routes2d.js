import express from "express";
import {
  createStorySession,
  getStorySession,
  updateStorySession,
  publicStorySession,
} from "./state/storySessions.js";
import { generateStory } from "./narrative/generateStory.js";
import { firstTurnMessage2D, choiceTurnMessage2D } from "./narrative/prompts2d.js";
import { getStyleBible } from "./art/styleBible.js";
import { getArt, artGenEnabled, ART_KINDS } from "./art/artGen.js";
import { logGeneration } from "./logging/logger.js";

export const router = express.Router();

// Turns are streamed as server-sent events rather than returned as one JSON body. The
// point is latency: the narrative field arrives about a second in, so the player is
// reading prose while the scene, choices and beats are still being generated. On the 3D
// path the same work happened behind a spinner and was the single worst thing about
// playing it.
//
// SSE over a POST (rather than EventSource, which is GET-only) because the turn needs a
// request body; the client reads the stream off fetch().body.
function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this a proxy will happily buffer the whole stream and hand it over at the
    // end, which silently undoes the entire feature.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let open = true;
  res.on("close", () => {
    open = false;
  });

  return {
    get open() {
      return open;
    },
    send(event, data) {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
    },
    end() {
      if (!open) return;
      res.end();
      open = false;
    },
  };
}

// One turn, start to finish, streamed. Shared by the opening scene and every choice
// after it — they differ only in the turn message and whether a session already exists.
async function streamTurn({ res, session, turnMessage }) {
  const stream = openStream(res);

  try {
    // The art direction is decided once per game and every picture is painted to it.
    // It has to exist before any art is requested, so it blocks the first turn — but
    // it is a small, fast call and it is cached, so replays are free.
    if (!session.bible) {
      stream.send("status", { phase: "art-direction" });
      try {
        const bible = await getStyleBible({
          sourceText: session.sourceText,
          profile: session.profile,
          personalize: session.ablation.personalization,
        });
        updateStorySession(session.id, { bible });
        session.bible = bible;
        stream.send("style", bible);
      } catch (err) {
        // A game with no art direction still plays; it just looks less coherent.
        console.warn("[2d] art direction unavailable:", err.message || err);
      }
    }

    stream.send("status", { phase: "writing" });

    const { state, newHistory, usage, latencyMs, spatial } = await generateStory({
      profile: session.profile,
      sourceText: session.sourceText,
      ablation: session.ablation,
      bible: session.bible,
      history: session.history,
      turnMessage,
      lastState: session.lastState,
      prevStats: session.prevStats,
      turnIndex: session.turnIndex,
      onProse: (delta) => stream.send("prose", { delta }),
      onRestart: () => stream.send("prose-reset", {}),
    });

    const turnIndex = session.turnIndex;
    updateStorySession(session.id, {
      history: newHistory,
      // The stats as they stood one turn further back. Telling the model that a specific
      // stat failed to move needs two previous turns to compare, not one — and at this
      // point `session.lastState` is still the turn before the one just generated.
      prevStats: session.lastState?.state_updates || null,
      lastState: state,
      turnIndex: turnIndex + 1,
    });

    await logGeneration({
      sessionId: session.id,
      turnIndex,
      ablation: session.ablation,
      profile: session.profile,
      sourceText: session.sourceText,
      turnMessage,
      worldState: state,
      usage,
      latencyMs,
      spatial,
    });

    stream.send("turn", publicStorySession(getStorySession(session.id)));
    stream.end();
  } catch (err) {
    console.error("[2d] turn generation failed:", err);
    await logGeneration({
      sessionId: session.id,
      turnIndex: session.turnIndex,
      ablation: session.ablation,
      profile: session.profile,
      sourceText: session.sourceText,
      turnMessage,
      error: err,
    });
    stream.send("failed", { error: String(err.message || err) });
    stream.end();
  }
}

router.post("/sessions", async (req, res) => {
  const { profile, sourceText, ablation } = req.body || {};
  if (!sourceText || !String(sourceText).trim()) {
    return res.status(400).json({ error: "sourceText is required" });
  }
  if (String(sourceText).length > 20000) {
    return res.status(400).json({ error: "sourceText too long (20000 char limit)" });
  }

  const session = createStorySession({ profile, sourceText: String(sourceText), ablation });
  // The client needs the id before the stream finishes so it can cancel or reconnect.
  res.setHeader("X-Session-Id", session.id);
  await streamTurn({ res, session, turnMessage: firstTurnMessage2D() });
});

router.post("/sessions/:id/choice", async (req, res) => {
  const session = getStorySession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.lastState?.ending) {
    return res.status(409).json({ error: "this story has ended" });
  }

  const { choiceId, freeText, examined } = req.body || {};
  const choice = (session.lastState?.choices || []).find((c) => c.id === choiceId);
  if (!choice && !freeText && !examined) {
    return res
      .status(400)
      .json({ error: "choiceId did not match a current choice, and no freeText/examined given" });
  }

  // A gated choice taken from the wrong place would let the player skip the walk that
  // makes the stage matter. The client hides these, but the check belongs here too.
  if (choice?.requires_near) {
    const playerX = Number(req.body?.playerX);
    const target = (session.lastState?.scene?.actors || []).find(
      (a) => a.id === choice.requires_near
    );
    if (target && Number.isFinite(playerX)) {
      const pad = 0.06 * (0.7 + 0.6 * (target.depth ?? 0.5));
      if (Math.abs(playerX - target.x) > pad) {
        return res.status(409).json({ error: "you are not close enough to do that" });
      }
    }
  }

  const turnMessage = choiceTurnMessage2D({
    choiceText: choice?.text,
    freeText: freeText ? String(freeText).slice(0, 500) : undefined,
    examined: examined ? String(examined).slice(0, 300) : undefined,
  });

  await streamTurn({ res, session, turnMessage });
});

router.get("/sessions/:id", (req, res) => {
  const session = getStorySession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json(publicStorySession(session));
});

// Game art. Served from the session so the art direction is applied server-side and the
// image key never reaches the browser. A 503 is a normal configuration state (no key),
// which the stage renders as a painted placeholder rather than treating as an error.
router.get("/art", async (req, res) => {
  const { sid, kind = "figure", description, horizon, mood, regenerate } = req.query;

  if (!ART_KINDS.includes(String(kind))) {
    return res.status(400).json({ error: `kind must be one of ${ART_KINDS.join(", ")}` });
  }
  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: "description is required — it is what gets painted" });
  }
  // This endpoint drives a paid image API, so attacker-chosen text is bounded here as
  // well as sanitized downstream. The bound has to clear a real backdrop brief, which is
  // a full paragraph describing a place — at 400 this rejected every backdrop the model
  // wrote and the game silently played out against a fallback gradient.
  if (String(description).length > 1200) {
    return res.status(400).json({ error: "description too long" });
  }

  const session = sid ? getStorySession(String(sid)) : null;
  if (sid && !session) return res.status(404).json({ error: "session not found" });

  if (!artGenEnabled) {
    return res.status(503).json({ error: "art generation disabled (no image API key)" });
  }

  try {
    const { buffer, contentType } = await getArt({
      kind: String(kind),
      description: String(description),
      bible: session?.bible,
      // Asked for when the browser could not cut the returned image out of its
      // background: a fresh sample replaces the unusable cached one.
      regenerate: regenerate === "1",
      extra: {
        horizon: horizon === undefined ? undefined : Number(horizon),
        mood: mood ? String(mood) : undefined,
      },
    });
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(buffer);
  } catch (err) {
    console.error("[GET /api/2d/art] failed:", err);
    res.status(502).json({ error: "art generation failed", detail: String(err.message || err) });
  }
});
