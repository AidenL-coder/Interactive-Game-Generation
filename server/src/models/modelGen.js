import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", ".model-cache");

// Real 3D props, as opposed to the billboarded sprites. Text-to-3D generation is far
// slower than image generation (minutes, not seconds) and costs more per asset, so the
// cache matters more here, not less: one model per prop type, generated once, reused by
// every instance in every scene forever.
//
// Provider-agnostic on purpose. Meshy is implemented because it has a straightforward
// REST polling API and returns GLB directly, but the contract below is small enough
// that swapping in Tripo/Rodin means writing one function.

export const MODEL_PROVIDER = process.env.MODEL_PROVIDER || "meshy";
const MESHY_API_KEY = process.env.MESHY_API_KEY;

export const modelGenEnabled = Boolean(MESHY_API_KEY);

if (!modelGenEnabled) {
  console.warn(
    "[models] MESHY_API_KEY not set — /api/model returns 503 and props fall back to " +
      "generated sprites. This is a supported mode, not a failure."
  );
}

// Models are generated from the object's own description, so the world isn't limited to
// a fixed catalogue of nouns. Text-to-3D behaves best with a single, clearly-bounded
// object and an explicit style.
const MAX_DESCRIPTION = 140;
function sanitize(description) {
  return String(description || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`\\{}<>]/g, "")
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

function modelPrompt(description) {
  return (
    `${sanitize(description)}, as a single isolated 3D game asset. ` +
    "Clean topology, game-ready, centered, complete object only, no base or platform, " +
    "no scenery, no text."
  );
}

// Stable, filesystem-safe filename for an arbitrary description.
function descriptionKey(description) {
  const clean = sanitize(description).toLowerCase();
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h * 33) ^ clean.charCodeAt(i)) >>> 0;
  const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
  return `${slug}-${h.toString(36)}`;
}

function cachePath(description) {
  return path.join(CACHE_DIR, `prop_${descriptionKey(description)}.glb`);
}

const inFlight = new Map();

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Meshy runs generation as an async task: create it, then poll until it reports
// SUCCEEDED and hands back a download URL.
async function generateViaMeshy(description) {
  const prompt = modelPrompt(description);
  const headers = {
    Authorization: `Bearer ${MESHY_API_KEY}`,
    "Content-Type": "application/json",
  };

  const createRes = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "preview",
      prompt,
      should_remesh: true,
      // Game props at conversational distance don't need film-grade density, and lower
      // counts keep the GLB small enough to ship to a browser quickly.
      target_polycount: 12000,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`meshy create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { result: taskId } = await createRes.json();

  // Generation typically takes 1-4 minutes.
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(8000);
    const pollRes = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`, { headers });
    if (!pollRes.ok) continue;
    const task = await pollRes.json();

    if (task.status === "SUCCEEDED") {
      const url = task.model_urls?.glb;
      if (!url) throw new Error("meshy succeeded but returned no glb url");
      const glbRes = await fetch(url);
      if (!glbRes.ok) throw new Error(`meshy glb download failed: ${glbRes.status}`);
      return Buffer.from(await glbRes.arrayBuffer());
    }
    if (task.status === "FAILED" || task.status === "CANCELED") {
      throw new Error(`meshy task ${task.status}: ${task.task_error?.message || "unknown"}`);
    }
  }
  throw new Error("meshy task timed out");
}

/**
 * Returns GLB bytes for an object description, generating on a cache miss.
 * Concurrent callers for the same description share one generation.
 */
export async function getModel(description) {
  const key = descriptionKey(description);
  const file = cachePath(description);

  // Cache is checked before the enabled flag: a model copied into the cache directory
  // by hand should still be served even with no API key configured.
  try {
    return await readFile(file);
  } catch {
    // miss — generate
  }

  if (!modelGenEnabled) throw new Error("model generation disabled (no API key)");
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const startedAt = Date.now();
    const buffer = await generateViaMeshy(description);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, buffer);
    console.log(`[models] generated "${description}" (${buffer.length}B) in ${Date.now() - startedAt}ms`);
    return buffer;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}
