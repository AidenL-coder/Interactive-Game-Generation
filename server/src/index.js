import "dotenv/config";
import express from "express";
import cors from "cors";

import { createSession, getSession, updateSession } from "./state/sessionStore.js";
import { generateScene } from "./narrative/generateScene.js";
import { firstTurnMessage, choiceTurnMessage } from "./narrative/prompts.js";
import { logGeneration } from "./logging/logger.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function publicSession(session) {
  return {
    sessionId: session.id,
    ablation: session.ablation,
    turnIndex: session.turnIndex,
    worldState: session.lastWorldState,
  };
}

app.post("/api/sessions", async (req, res) => {
  const { profile, sourceText, ablation } = req.body || {};
  if (!sourceText || !sourceText.trim()) {
    return res.status(400).json({ error: "sourceText is required" });
  }

  const session = createSession({ profile, sourceText, ablation });
  const turnMessage = firstTurnMessage();

  try {
    const { worldState, newHistory, usage, latencyMs } = await generateScene({
      profile: session.profile,
      sourceText: session.sourceText,
      ablation: session.ablation,
      history: session.history,
      turnMessage,
      lastWorldState: session.lastWorldState,
    });

    updateSession(session.id, {
      history: newHistory,
      lastWorldState: worldState,
      turnIndex: session.turnIndex + 1,
    });

    await logGeneration({
      sessionId: session.id,
      turnIndex: 0,
      ablation: session.ablation,
      turnMessage,
      worldState,
      usage,
      latencyMs,
    });

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error("[POST /api/sessions] generation failed:", err);
    await logGeneration({
      sessionId: session.id,
      turnIndex: 0,
      ablation: session.ablation,
      turnMessage,
      error: err,
    });
    res.status(502).json({ error: "world generation failed", detail: String(err.message || err) });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json(publicSession(session));
});

app.post("/api/sessions/:id/choice", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });

  const { choiceId, freeText } = req.body || {};
  const choice = (session.lastWorldState?.choices || []).find((c) => c.id === choiceId);
  if (!choice && !freeText) {
    return res.status(400).json({ error: "choiceId did not match a current choice, and no freeText given" });
  }

  const turnMessage = choiceTurnMessage({ choiceText: choice?.text, freeText });

  try {
    const { worldState, newHistory, usage, latencyMs } = await generateScene({
      profile: session.profile,
      sourceText: session.sourceText,
      ablation: session.ablation,
      history: session.history,
      turnMessage,
      lastWorldState: session.lastWorldState,
    });

    const turnIndex = session.turnIndex;
    updateSession(session.id, {
      history: newHistory,
      lastWorldState: worldState,
      turnIndex: turnIndex + 1,
    });

    await logGeneration({
      sessionId: session.id,
      turnIndex,
      ablation: session.ablation,
      turnMessage,
      worldState,
      usage,
      latencyMs,
    });

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error(`[POST /api/sessions/${session.id}/choice] generation failed:`, err);
    await logGeneration({
      sessionId: session.id,
      turnIndex: session.turnIndex,
      ablation: session.ablation,
      turnMessage,
      error: err,
    });
    res.status(502).json({ error: "world generation failed", detail: String(err.message || err) });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`[iwg-server] listening on http://localhost:${port}`);
});
