import { propSprite } from "./propSprites.js";
import { propTexture } from "./propTextures.js";
import { propModel } from "./propModels.js";
import { GEOMETRIC_FORMS, FORM_HEIGHT } from "iwg-shared";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Generates every asset a scene needs before the player is shown the world, so the
// world appears finished rather than materialising around them over the next minute.
//
// Generation latency is deliberately traded for completeness here: a scene shown at
// once, fully dressed, is worth far more than one that starts sooner and pops in. Each
// underlying fetch shares the same per-description cache the renderer uses, so nothing
// generated here is generated twice.

function warmSky(env) {
  const params = new URLSearchParams({
    kind: "sky",
    label: env?.description || "an open sky",
    light_level: String(env?.light_level ?? 0.7),
  });
  return fetch(`${API_BASE}/texture?${params}`).catch(() => null);
}

function warmGround(env) {
  const params = new URLSearchParams({
    kind: "ground",
    label: env?.ground_cover || "worn stone",
  });
  return fetch(`${API_BASE}/texture?${params}`).catch(() => null);
}

function warmProp(prop) {
  // Mirrors the renderer's own resolution order so we warm exactly what it will ask for.
  return (async () => {
    const model = await propModel(prop.label, FORM_HEIGHT[prop.form]).catch(() => null);
    if (model) return;
    if (!GEOMETRIC_FORMS.has(prop.form)) {
      const sprite = await propSprite(prop.form, prop.label).catch(() => null);
      if (sprite) return;
    }
    await propTexture(prop.label).catch(() => null);
  })();
}

/**
 * Warms every asset for a scene.
 * @param {object} scene - WorldState.scene
 * @param {(done:number, total:number, label:string) => void} [onProgress]
 */
export async function prewarmScene(scene, onProgress) {
  const env = scene?.environment;
  const props = scene?.props || [];

  const tasks = [
    { label: "sky", run: () => warmSky(env) },
    { label: "ground", run: () => warmGround(env) },
    // Background vegetation shares the sprite cache, and is what the scatter upgrades to.
    ...(env?.scatter_cover
      ? [
          {
            label: env.scatter_cover,
            run: () => propSprite("tall", `a large clump of ${env.scatter_cover}, growing tall`),
          },
        ]
      : []),
    ...props.map((p) => ({ label: p.label, run: () => warmProp(p) })),
  ];

  let done = 0;
  const total = tasks.length;
  onProgress?.(0, total, "starting");

  // Run in parallel — these are independent network calls and the server dedupes
  // concurrent requests for the same asset — but report progress as each lands.
  await Promise.all(
    tasks.map(async (task) => {
      try {
        await task.run();
      } catch {
        // A failed asset is not fatal: the renderer falls back to placeholder geometry.
      }
      done++;
      onProgress?.(done, total, task.label);
    })
  );
}
