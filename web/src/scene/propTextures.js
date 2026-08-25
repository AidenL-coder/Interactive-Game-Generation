import * as THREE from "three";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// One texture per prop type, shared by every instance of that type and across scenes.
// A world with nine rocks issues one request, not nine; revisiting a biome issues none.
// Values are Promises so concurrent callers during a scene build dedupe onto one fetch
// rather than racing.
const cache = new Map();

// Repeat counts are per prop type because the geometries differ wildly in size: bark
// wrapping a 1.4-unit trunk needs far less tiling than masonry across a 3-unit wall.
const REPEAT = {
  tree: [1, 2],
  rock: [1, 1],
  pillar: [1, 3],
  wall: [3, 2],
  structure: [2, 2],
  torch: [1, 2],
  npc: [1, 1],
  item: [1, 1],
  altar: [2, 1],
  crate: [1, 1],
  water: [2, 2],
};

/**
 * Resolves to a THREE.Texture for a prop type, or null when generation is unavailable
 * (no API key configured, request failed). Callers keep their flat-colour material in
 * that case, so the scene still renders — just without generated detail.
 */
export function propTexture(type) {
  if (cache.has(type)) return cache.get(type);

  const job = (async () => {
    try {
      const res = await fetch(`${API_BASE}/texture?kind=prop&type=${encodeURIComponent(type)}`);
      if (!res.ok) return null; // 503 = disabled, 502 = generation failed
      const bitmap = await createImageBitmap(await res.blob());

      const tex = new THREE.CanvasTexture(bitmap);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const [ru, rv] = REPEAT[type] || [1, 1];
      tex.repeat.set(ru, rv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    } catch {
      return null;
    }
  })();

  cache.set(type, job);
  return job;
}

/**
 * Applies the generated material texture to every mesh in a prop group once it loads.
 * Keeps each mesh's existing colour as a tint so the mood-based colouring still reads
 * through the texture rather than being flattened by it.
 */
export async function applyPropTexture(group, type) {
  const tex = await propTexture(type);
  if (!tex) return;

  group.traverse((obj) => {
    // Sprites are the floating text labels — texturing those would obliterate them.
    if (!obj.isMesh || obj.userData.noTexture) return;
    const mat = obj.material;
    if (!mat || Array.isArray(mat)) return;
    mat.map = tex;
    // Full-strength tint over a photographic texture reads as muddy, but lifting too
    // far toward white blew out pale textures into featureless shapes — a marble pillar
    // rendered as a plain white cylinder. Keep enough of the base colour that the
    // texture's own contrast survives.
    mat.color?.lerp(new THREE.Color(0xffffff), 0.3);
    mat.needsUpdate = true;
  });
}
