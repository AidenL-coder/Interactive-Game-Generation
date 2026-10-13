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
import { router as router2d } from "./routes2d.js";
import { loadPack, listPacks } from "./packs/loadPack.js";
import { isPackId } from "./packs/packAssets.js";
import { materialMode } from "iwg-shared/pack3d";
import { PROP_FORMS } from "iwg-shared";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// The 2D illustrated adventure. This is the primary game; the 3D routes below are the
// other arm of the engine ablation and are left intact.
app.use("/api/2d", router2d);

function publicSession(session) {
  return {
    sessionId: session.id,
    ablation: session.ablation,
    turnIndex: session.turnIndex,
    worldState: session.lastWorldState,
    placeId: session.placeId ?? null,
    // How the pack's 3D world is surfaced, so the client does not request material
    // textures a flat-coloured pack never had.
    world3d: session.pack?.world3d ?? null,
  };
}

// Generated scene textures. Kept server-side because the image-gen key must never
// reach the browser. A 503 here is a normal, expected mode (no key configured) — the
// renderer treats it as "use the procedural fallback", not as an error.
app.get("/api/texture", async (req, res) => {
  // No up-front "no key" refusal any more: a pack ships its own textures and those must
  // be served on a machine with no image key at all. getTexture only demands the key
  // when it would actually have to generate something, and the catch below turns that
  // into the same 503 the renderer already treats as "use the procedural fallback".
  const { kind = "ground", type: propType, label, light_level: lightLevel, pack } = req.query;
  // Which pack's shipped textures to look in; anything that is not a valid pack id is
  // simply "no pack", never an error — the texture is then generated as usual.
  const packId = isPackId(pack) ? pack : null;

  // A flat-material pack has no material textures by design, and the client never asks
  // for one. If something does, refuse rather than falling through to the shared cache,
  // which would serve a stock-photo texture onto a game whose brief is flat colour.
  if (packId && kind === "prop") {
    const owner = await loadPack(packId).catch(() => null);
    if (owner && materialMode(owner) === "flat") {
      return res.status(404).json({ error: `${owner.title} draws materials as flat colour` });
    }
  }

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
      packId,
    });
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    if (!textureGenEnabled) {
      return res.status(503).json({ error: "texture generation disabled (no API key configured)" });
    }
    console.error("[GET /api/texture] generation failed:", err);
    res.status(502).json({ error: "texture generation failed", detail: String(err.message || err) });
  }
});

// Objects assembled from primitive parts — real geometry, built per description and
// cached forever. This is the primary way props are rendered.
app.get("/api/geometry", async (req, res) => {
  const { label, form, pack } = req.query;
  const packId = isPackId(pack) ? pack : null;

  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: "label is required" });
  }
  if (String(label).length > 200) {
    return res.status(400).json({ error: "label too long" });
  }

  try {
    const parts = await getGeometry(String(label), form ? String(form) : undefined, { packId });
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

// The pre-generated games, for either renderer. Each says which renderers it has a world
// for, so the 3D start screen only offers packs that can actually be walked around.
app.get("/api/packs", async (_req, res) => {
  try {
    res.json({ packs: await listPacks() });
  } catch (err) {
    console.error("[GET /api/packs] failed:", err);
    res.status(500).json({ error: "could not read the pack list" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { profile, sourceText, ablation, packId } = req.body || {};

  let pack = null;
  if (packId) {
    try {
      pack = await loadPack(String(packId));
    } catch (err) {
      console.error(`[3d] pack "${packId}" failed to load:`, err);
      return res.status(500).json({ error: "that game is misconfigured", detail: String(err.message || err) });
    }
    if (!pack) return res.status(404).json({ error: `no such game: ${packId}` });
    if (!pack.engines?.includes("3d")) {
      return res.status(400).json({ error: `${pack.title} has no 3D world` });
    }
  }

  const premise = pack ? pack.premise : sourceText;
  if (!premise || !String(premise).trim()) {
    return res.status(400).json({ error: "sourceText is required (or a packId)" });
  }

  const session = createSession({ profile, sourceText: String(premise), ablation, pack });
  const turnMessage = firstTurnMessage();

  try {
    const { worldState, newHistory, usage, latencyMs, spatial, placeId, snapReport } = await generateScene({
      profile: session.profile,
      sourceText: session.sourceText,
      ablation: session.ablation,
      history: session.history,
      turnMessage,
      lastWorldState: session.lastWorldState,
      pack: session.pack,
      currentPlaceId: session.placeId,
      turnIndex: session.turnIndex,
    });

    updateSession(session.id, {
      history: newHistory,
      lastWorldState: worldState,
      turnIndex: session.turnIndex + 1,
      placeId: placeId ?? session.placeId,
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
      place: placeId ?? null,
      snap: snapReport,
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
    const { worldState, newHistory, usage, latencyMs, spatial, placeId, snapReport } = await generateScene({
      profile: session.profile,
      sourceText: session.sourceText,
      ablation: session.ablation,
      history: session.history,
      turnMessage,
      lastWorldState: session.lastWorldState,
      pack: session.pack,
      currentPlaceId: session.placeId,
      turnIndex: session.turnIndex,
    });

    const turnIndex = session.turnIndex;
    updateSession(session.id, {
      history: newHistory,
      lastWorldState: worldState,
      turnIndex: turnIndex + 1,
      placeId: placeId ?? session.placeId,
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
      place: placeId ?? null,
      snap: snapReport,
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
