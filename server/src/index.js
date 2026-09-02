import "dotenv/config";
import express from "express";
import cors from "cors";

import { createSession, getSession, updateSession } from "./state/sessionStore.js";
import { generateScene } from "./narrative/generateScene.js";
import { firstTurnMessage, choiceTurnMessage } from "./narrative/prompts.js";
import { logGeneration } from "./logging/logger.js";
import { getTexture, textureGenEnabled } from "./textures/textureGen.js";
import { getModel, modelGenEnabled } from "./models/modelGen.js";
import { getGeometry, geometryGenEnabled } from "./geometry/geometryGen.js";
import { PROP_FORMS } from "iwg-shared";

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

  const { kind = "ground", type: propType, label, light_level: lightLevel } = req.query;

  if (!["ground", "sky", "prop", "sprite"].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'ground', 'sky', 'prop', or 'sprite'" });
  }

  // There is no vocabulary enum to validate against any more — the whole point is that
  // the model authors its own. What still matters is that this unauthenticated endpoint
  // can't be used to drive unbounded attacker-chosen text into a paid image API, so the
  // description is length-capped and stripped downstream in sanitizeLabel().
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: "label is required — it is what gets generated" });
  }
  if (String(label).length > 200) {
    return res.status(400).json({ error: "label too long" });
  }

  try {
    const { buffer, contentType } = await getTexture({
      kind,
      propType,
      label: String(label),
      lightLevel: Number(lightLevel) || 0.7,
    });
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    console.error("[GET /api/texture] generation failed:", err);
    res.status(502).json({ error: "texture generation failed", detail: String(err.message || err) });
  }
});

// Objects assembled from primitive parts — real geometry, built per description and
// cached forever. This is the primary way props are rendered.
app.get("/api/geometry", async (req, res) => {
  const { label, form } = req.query;

  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: "label is required" });
  }
  if (String(label).length > 200) {
    return res.status(400).json({ error: "label too long" });
  }

  try {
    const parts = await getGeometry(String(label), form ? String(form) : undefined);
    res.set("Cache-Control", "public, max-age=604800");
    res.json({ parts });
  } catch (err) {
    if (!geometryGenEnabled) {
      return res.status(503).json({ error: "geometry generation disabled (no API key)" });
    }
    console.error("[GET /api/geometry] failed:", err);
    res.status(502).json({ error: "geometry generation failed", detail: String(err.message || err) });
  }
});

// Real 3D prop geometry. Same contract as /api/texture: a 503 means "not configured",
// which the renderer treats as "fall back to sprites", not as an error.
app.get("/api/model", async (req, res) => {
  const { type } = req.query;

  if (!type || !String(type).trim() || String(type).length > 200) {
    return res.status(400).json({ error: "type (the object description) is required" });
  }

  try {
    const buffer = await getModel(type);
    res.set("Content-Type", "model/gltf-binary");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(buffer);
  } catch (err) {
    // A missing key is an expected configuration state, not a server fault.
    if (!modelGenEnabled) {
      return res.status(503).json({ error: "model generation disabled (no API key configured)" });
    }
    console.error("[GET /api/model] generation failed:", err);
    res.status(502).json({ error: "model generation failed", detail: String(err.message || err) });
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
