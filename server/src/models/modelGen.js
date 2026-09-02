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

// Subject prompts per prop type. Text-to-3D behaves best with a single, clearly-bounded
// object and an explicit style, the same way the sprite prompts do.
const MODEL_PROMPTS = {
  tree: "a single stylized fantasy tree with a thick gnarled trunk and full leafy canopy",
  npc: "a single standing hooded traveler figure in a cloak, game character",
  item: "a small ornate treasure chest, closed, fantasy game prop",
  altar: "an ancient carved stone altar pedestal with worn runes",
  crate: "a wooden supply crate with iron banding, game prop",
  torch: "a wooden torch on an iron stand, fantasy game prop",
  rock: "a large mossy granite boulder, natural rock formation",
  pillar: "a weathered broken stone column, ancient ruin architecture",
  structure: "a small stone hut with a shingled roof, fantasy game building",
};

export function hasModelFor(type) {
  return Boolean(MODEL_PROMPTS[type]);
}

function cachePath(type) {
  return path.join(CACHE_DIR, `prop_${type}.glb`);
}

const inFlight = new Map();

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Meshy runs generation as an async task: create it, then poll until it reports
// SUCCEEDED and hands back a download URL.
async function generateViaMeshy(type) {
  const prompt = MODEL_PROMPTS[type];
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
 * Returns GLB bytes for a prop type, generating on a cache miss.
 * Concurrent callers for the same type share one generation.
 */
export async function getModel(type) {
  const file = cachePath(type);

  // Cache is checked before the enabled flag: a model committed or copied into the
  // cache directory should still be served even with no API key configured.
  try {
    return await readFile(file);
  } catch {
    // miss — generate
  }

  if (!modelGenEnabled) throw new Error("model generation disabled (no API key)");
  if (!hasModelFor(type)) throw new Error(`no model prompt defined for '${type}'`);

  if (inFlight.has(type)) return inFlight.get(type);

  const job = (async () => {
    const startedAt = Date.now();
    const buffer = await generateViaMeshy(type);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, buffer);
    console.log(`[models] generated ${type} (${buffer.length}B) in ${Date.now() - startedAt}ms`);
    return buffer;
  })().finally(() => inFlight.delete(type));

  inFlight.set(type, job);
  return job;
}
