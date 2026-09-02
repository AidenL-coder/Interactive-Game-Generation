import * as THREE from "three";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Tiling surface textures for assembled geometry, keyed by the material description the
// model wrote ("rough oak planks", "coarse camel hide"). One generation per distinct
// material, shared by every part in every object in every world that names it — so a
// scene full of wooden things costs one wood texture, not one per plank.
const cache = new Map();

export function materialTexture(description) {
  const key = String(description || "").trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return cache.get(key);

  const job = (async () => {
    try {
      const params = new URLSearchParams({ kind: "prop", label: key });
      const res = await fetch(`${API_BASE}/texture?${params}`);
      if (!res.ok) return null; // 503 = generation unavailable; parts keep flat colour
      const bitmap = await createImageBitmap(await res.blob());

      const tex = new THREE.CanvasTexture(bitmap);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      return tex;
    } catch {
      return null;
    }
  })();

  cache.set(key, job);
  return job;
}

/** Every distinct material named across a set of parts, for pre-generation. */
export function materialsIn(parts) {
  const names = new Set();
  for (const part of parts || []) {
    const name = String(part?.material || "").trim().toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}
