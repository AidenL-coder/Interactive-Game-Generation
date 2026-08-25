import * as THREE from "three";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Prop types rendered as billboarded generated artwork rather than primitive geometry.
// Discrete, organic, or detailed objects only — architectural pieces (wall, pillar,
// structure) stay as geometry, since you walk right up to and around those and a flat
// card would give the illusion away immediately.
export const SPRITE_TYPES = new Set(["tree", "npc", "item", "altar", "crate", "torch", "rock"]);

// World height in units for each sprite, so a chest doesn't render as tall as a tree.
const SPRITE_HEIGHT = {
  tree: 4.2,
  npc: 1.85,
  item: 0.9,
  altar: 1.3,
  crate: 0.9,
  torch: 1.9,
  rock: 1.1,
};

const cache = new Map();

// The image model returns JPEG (no alpha), so transparency comes from keying out the
// magenta backdrop it was asked for. JPEG compression smears colour at edges, hence a
// generous distance threshold plus a softened rim rather than a hard binary cut.
const KEY = { r: 255, g: 0, b: 255 };
const KEY_DISTANCE = 130;
const EDGE_SOFTNESS = 60;

function chromaKeyToCanvas(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - KEY.r;
    const dg = d[i + 1] - KEY.g;
    const db = d[i + 2] - KEY.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist < KEY_DISTANCE) {
      d[i + 3] = 0;
    } else if (dist < KEY_DISTANCE + EDGE_SOFTNESS) {
      // Fade the rim so compression fringing doesn't leave a hard magenta halo.
      d[i + 3] = Math.round(((dist - KEY_DISTANCE) / EDGE_SOFTNESS) * 255);
      // Pull residual magenta out of semi-transparent edge pixels: where red and blue
      // both overshoot green, the excess is backdrop bleed rather than object colour.
      const g = d[i + 1];
      if (d[i] > g && d[i + 2] > g) {
        d[i] = Math.round((d[i] + g) / 2);
        d[i + 2] = Math.round((d[i + 2] + g) / 2);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Trims fully-transparent margin so the object sits on the ground rather than floating
// inside whatever padding the model left around it. This is what stops sprites from
// hovering, and it's why the generated framing doesn't have to be exact.
function trimTransparent(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas; // fully keyed out — nothing to trim

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Resolves to {texture, aspect} for a prop type, or null if unavailable. */
export function propSprite(type) {
  if (cache.has(type)) return cache.get(type);

  const job = (async () => {
    try {
      const res = await fetch(`${API_BASE}/texture?kind=sprite&type=${encodeURIComponent(type)}`);
      if (!res.ok) return null;
      const trimmed = trimTransparent(chromaKeyToCanvas(await createImageBitmap(await res.blob())));

      const texture = new THREE.CanvasTexture(trimmed);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return { texture, aspect: trimmed.width / trimmed.height };
    } catch {
      return null;
    }
  })();

  cache.set(type, job);
  return job;
}

/**
 * Swaps a prop's primitive geometry for a billboarded sprite once the artwork loads.
 * The geometry stays until then, so the scene is never empty while waiting — and stays
 * permanently if generation is unavailable.
 */
export async function attachSprite(group, type) {
  const loaded = await propSprite(type);
  // The prop may have been removed by a delta while its artwork was in flight.
  if (!loaded || !group.parent) return;

  const height = SPRITE_HEIGHT[type] || 1.5;
  const material = new THREE.SpriteMaterial({
    map: loaded.texture,
    transparent: true,
    // Discards near-transparent fragments so sprites don't blend weirdly through each
    // other and still write sensible depth.
    alphaTest: 0.35,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * loaded.aspect, height, 1);
  // Sprites pivot at their centre, so lift by half the height to stand it on the ground.
  sprite.position.y = height / 2;
  sprite.userData.isArtSprite = true;

  // Hide the placeholder geometry rather than removing it: it still defines the
  // prop's collision footprint and the delta tweens animate the group as a whole.
  for (const child of [...group.children]) child.visible = false;
  group.add(sprite);
}
