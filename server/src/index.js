import "dotenv/config";
import express from "express";
import cors from "cors";

import { createSession, getSession, updateSession } from "./state/sessionStore.js";
import { generateScene } from "./narrative/generateScene.js";
import { firstTurnMessage, choiceTurnMessage } from "./narrative/prompts.js";
import { logGeneration } from "./logging/logger.js";
import { getTexture, textureGenEnabled, hasSpriteFor } from "./textures/textureGen.js";
import { BIOMES, MOODS, TIMES_OF_DAY, PROP_TYPES } from "iwg-shared";

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

// Generated scene textures. Kept server-side because the image-gen key must never
// reach the browser. A 503 here is a normal, expected mode (no key configured) — the
// renderer treats it as "use the procedural fallback", not as an error.
app.get("/api/texture", async (req, res) => {
  if (!textureGenEnabled) {
    return res.status(503).json({ error: "texture generation disabled (no API key configured)" });
  }

  const { biome, mood, time_of_day: timeOfDay, kind = "ground", type: propType } = req.query;

  // Validate against the shared enums rather than interpolating raw query strings into
  // a model prompt — this endpoint is unauthenticated and otherwise lets a caller drive
  // arbitrary text into a paid image API.
  if (!["ground", "sky", "prop", "sprite"].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'ground', 'sky', 'prop', or 'sprite'" });
  }
  if (kind === "sprite") {
    if (!hasSpriteFor(propType)) {
      return res.status(404).json({ error: "no sprite defined for that prop type" });
    }
  } else if (kind === "prop") {
    // Prop materials depend only on the prop type, not on scene context.
    if (!PROP_TYPES.includes(propType)) {
      return res.status(400).json({ error: "type must be a valid prop type" });
    }
  } else if (!BIOMES.includes(biome) || !MOODS.includes(mood) || !TIMES_OF_DAY.includes(timeOfDay)) {
    return res.status(400).json({ error: "biome, mood, and time_of_day must be valid enum values" });
  }

  try {
    const { buffer, contentType } = await getTexture({ biome, mood, timeOfDay, kind, propType });
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    console.error("[GET /api/texture] generation failed:", err);
    res.status(502).json({ error: "texture generation failed", detail: String(err.message || err) });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { profile, sourceText, ablation } = req.body || {};
  if (!sourceText || !sourceText.trim()) {
    return res.status(400).json({ error: "sourceText is required" });
  }

  const session = createSession({ profile, sourceText, ablation });
  const turnMessage = firstTurnMessage();

  try {
    const { worldState, newHistory, usage, latencyMs, spatial } = await generateScene({
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
      profile: session.profile,
      sourceText: session.sourceText,
      turnMessage,
      worldState,
      usage,
      latencyMs,
      spatial,
    });

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error("[POST /api/sessions] generation failed:", err);
    await logGeneration({
      sessionId: session.id,
      turnIndex: 0,
      ablation: session.ablation,
      profile: session.profile,
      sourceText: session.sourceText,
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
    const { worldState, newHistory, usage, latencyMs, spatial } = await generateScene({
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
      profile: session.profile,
      sourceText: session.sourceText,
      turnMessage,
      worldState,
      usage,
      latencyMs,
      spatial,
    });

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error(`[POST /api/sessions/${session.id}/choice] generation failed:`, err);
    await logGeneration({
      sessionId: session.id,
      turnIndex: session.turnIndex,
      ablation: session.ablation,
      profile: session.profile,
      sourceText: session.sourceText,
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
