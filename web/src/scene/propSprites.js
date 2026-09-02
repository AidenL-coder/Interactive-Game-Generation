import * as THREE from "three";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Props are billboarded generated artwork unless their form is architectural — you walk
// right up to and around a wall or a building, where a flat card gives itself away.
// Sizing comes from the prop's form rather than a per-type table, since there is no
// fixed set of types any more; FORM_HEIGHT lives in the shared schema so the renderer
// and the model agree on what "tall" means.
import { FORM_HEIGHT } from "iwg-shared";

const cache = new Map();

// The image model returns JPEG (no alpha), so transparency comes from keying out the
// magenta backdrop it was asked for. JPEG compression smears colour at edges, hence a
// generous distance threshold plus a softened rim rather than a hard binary cut.
const KEY = { r: 255, g: 0, b: 255 };
const KEY_DISTANCE = 165;
const EDGE_SOFTNESS = 85;
// Below this, a red+blue-over-green cast is just a warm or purple object colour rather
// than backdrop bleed, so leave it alone.
const DESPILL_THRESHOLD = 22;

// If the model ignored the magenta-backdrop instruction, keying removes almost nothing
// and the sprite renders as a raw rectangle floating in the world — a framed picture
// hanging in mid-air. Below this share of keyed-out pixels we treat the generation as
// unusable and fall back to geometry, which is wrong-looking but not obviously broken.
const MIN_KEYED_FRACTION = 0.12;

function chromaKeyToCanvas(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let keyed = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];

    const dr = r - KEY.r;
    const dg = g - KEY.g;
    const db = b - KEY.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist < KEY_DISTANCE) {
      d[i + 3] = 0;
      keyed++;
      continue;
    }
    if (dist < KEY_DISTANCE + EDGE_SOFTNESS) {
      // Fade the rim so compression fringing doesn't leave a hard halo.
      d[i + 3] = Math.round(((dist - KEY_DISTANCE) / EDGE_SOFTNESS) * 255);
    }

    // Despill every surviving pixel, not just the soft rim. Restricting it to the rim
    // left a bright magenta outline glowing around every sprite: JPEG smears backdrop
    // colour several pixels deep into the object, well past the alpha transition.
    const avgRB = (r + b) / 2;
    const excess = avgRB - g;
    if (excess > DESPILL_THRESHOLD) {
      const cut = (excess - DESPILL_THRESHOLD) * 0.9;
      d[i] = Math.max(g, r - cut);
      d[i + 2] = Math.max(g, b - cut);
    }
  }
  ctx.putImageData(img, 0, 0);
  const keyedFraction = keyed / (canvas.width * canvas.height);
  return { canvas, keyedFraction };
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
export function propSprite(type, label) {
  // Cache on the label, not just the type: one sprite per type meant every world reused
  // the same handful of objects. The model names each prop specifically, so that
  // description is what the art comes from.
  if (!label || !String(label).trim()) return Promise.resolve(null);
  const key = `${type}::${label}`;
  if (cache.has(key)) return cache.get(key);

  const job = (async () => {
    try {
      const params = new URLSearchParams({ kind: "sprite", type });
      if (label) params.set("label", label);
      const res = await fetch(`${API_BASE}/texture?${params}`);
      if (!res.ok) return null;

      const { canvas, keyedFraction } = chromaKeyToCanvas(await createImageBitmap(await res.blob()));
      if (keyedFraction < MIN_KEYED_FRACTION) {
        console.warn(
          `[propSprites] discarding "${label || type}" — only ${(keyedFraction * 100).toFixed(1)}% ` +
            "keyed out, so the backdrop wasn't magenta and this would render as a rectangle"
        );
        return null;
      }
      const trimmed = trimTransparent(canvas);

      const texture = new THREE.CanvasTexture(trimmed);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return { texture, aspect: trimmed.width / trimmed.height };
    } catch {
      return null;
    }
  })();

  cache.set(key, job);
  return job;
}

// THREE.Sprite cannot cast a shadow, so sprite props had nothing anchoring them to the
// ground and read as stickers pasted onto the scene. A soft radial blob under each one
// is the standard cheap fix and does most of the work a real shadow would.
let contactShadowTexture = null;
function getContactShadowTexture() {
  if (contactShadowTexture) return contactShadowTexture;

  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.5, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  contactShadowTexture = new THREE.CanvasTexture(canvas);
  return contactShadowTexture;
}

function contactShadow(width) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * 0.62),
    new THREE.MeshBasicMaterial({
      map: getContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03; // just above the terrain to avoid z-fighting
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * Swaps a prop's primitive geometry for a billboarded sprite once the artwork loads.
 * The geometry stays until then, so the scene is never empty while waiting — and stays
 * permanently if generation is unavailable.
 */
export async function attachSprite(group, form, label) {
  const loaded = await propSprite(form, label);
  // The prop may have been removed by a delta while its artwork was in flight.
  if (!loaded || !group.parent) return false;

  // Flat things lie on the floor — a pool of water or a hatch drawn as a standing
  // billboard would be absurd. They get a ground decal instead.
  if (form === "flat") {
    const size = 2.6 * (loaded.aspect > 1 ? loaded.aspect : 1);
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size / (loaded.aspect || 1)),
      new THREE.MeshStandardMaterial({
        map: loaded.texture,
        transparent: true,
        alphaTest: 0.3,
        roughness: 0.4,
        depthWrite: false,
      })
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.y = 0.04; // above the terrain to avoid z-fighting
    decal.receiveShadow = true;
    for (const child of [...group.children]) child.visible = false;
    group.add(decal);
    return true;
  }

  const height = FORM_HEIGHT[form] || 1.5;
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
  group.add(contactShadow(height * loaded.aspect * 0.7), sprite);
  return true;
}
