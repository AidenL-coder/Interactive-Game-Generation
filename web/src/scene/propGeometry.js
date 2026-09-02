import { buildPartsMesh, partsHeight } from "./partsMesh.js";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Fetches an object's assembled geometry and caches it per description, exactly like
// sprites and textures. A "wooden crate" is built once and reused wherever it appears,
// in this world and every later one.
const cache = new Map();

export function propParts(label, form) {
  const key = `${form || ""}::${label}`;
  if (cache.has(key)) return cache.get(key);

  const job = (async () => {
    try {
      const params = new URLSearchParams({ label });
      if (form) params.set("form", form);
      const res = await fetch(`${API_BASE}/geometry?${params}`);
      if (!res.ok) return null;
      const { parts } = await res.json();
      return Array.isArray(parts) && parts.length ? parts : null;
    } catch {
      return null;
    }
  })();

  cache.set(key, job);
  return job;
}

/**
 * Replaces a prop's placeholder with real assembled geometry.
 * @returns {Promise<boolean>} whether geometry was attached
 */
export async function attachGeometry(group, label, form) {
  const parts = await propParts(label, form);
  // The prop may have been removed by a delta while its geometry was in flight.
  if (!parts || !group.parent) return false;

  const assembled = buildPartsMesh(parts);
  if (!assembled) return false;

  // Hide rather than remove the placeholder: it still defines the collision volume and
  // the delta tweens animate the group as a whole.
  for (const child of [...group.children]) child.visible = false;
  group.add(assembled);
  group.userData.assembledHeight = partsHeight(assembled);
  return true;
}
