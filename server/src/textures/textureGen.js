import { GoogleGenAI } from "@google/genai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackAsset } from "../packs/packAssets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", ".texture-cache");
const MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
export const textureGenEnabled = Boolean(apiKey);

if (!textureGenEnabled) {
  console.warn(
    "[textures] No GOOGLE_API_KEY/GEMINI_API_KEY set — /api/texture will 503 and the " +
      "renderer falls back to procedural textures. This is a supported mode, not a failure."
  );
}

const ai = textureGenEnabled ? new GoogleGenAI({ apiKey }) : null;

// Cache key is exactly the scene fields the texture depends on. Two consequences,
// both deliberate: repeat biome/mood/time combos cost one generation total, and the
// render stays *deterministic given a WorldState* — which is what docs/research.md
// relies on for cross-ablation comparability. A fresh sample per turn would reintroduce
// exactly the rendering noise that design decision exists to eliminate.
function cacheKey(biome, mood, timeOfDay, kind, propType, label) {
  // Prop materials are keyed by type alone, not by biome/mood/time: bark is bark
  // regardless of the weather. 11 prop types => 11 generations, ever. Keying them by
  // scene context instead would multiply that by ~200 for no visible benefit.
  // Everything is keyed by what it actually depicts, so two worlds that describe
  // themselves differently get genuinely different art rather than sharing a preset.
  const key = labelKey(label);
  if (kind === "prop") return `prop_${key || propType || "generic"}.img`;
  if (kind === "sprite") return `sprite_${key || propType || "generic"}.img`;
  return `${kind}_${key || "default"}.img`;
}

// Material description per prop type. These are surface textures tiled onto the
// geometry, not pictures of the object — asking for "a tree" would return a tree on a
// background, which looks wrong wrapped around a cone.
const PROP_MATERIAL_PROMPTS = {
  tree: "rough brown tree bark with deep vertical grooves",
  rock: "rough grey granite stone surface with mineral speckles",
  // Pale cream marble rendered as a featureless white cylinder under bright sun; a
  // darker, higher-contrast stone actually reads as carved masonry.
  pillar: "weathered grey-brown carved stone column surface with deep vertical fluting and dark veining",
  wall: "old stone masonry blocks with visible mortar joints",
  structure: "weathered sandstone block wall, slightly mossy",
  water: "clear rippling water surface, gentle caustics",
  torch: "dark charred wood grain",
  npc: "coarse woven wool cloth in muted earth tones",
  item: "polished antique gold metal with fine engraving",
  altar: "carved weathered limestone with faint ancient runes",
  crate: "rough wooden planks with iron nail heads",
};

// Object sprites, as opposed to material textures. These are billboarded in the scene,
// so we need the object itself cleanly separated from its background. The model won't
// reliably emit alpha (it returns JPEG), so we ask for a flat chroma-key backdrop and
// cut it out client-side. Magenta because effectively nothing in these subjects is
// naturally that colour.
export const CHROMA_KEY = { r: 255, g: 0, b: 255 };

const SPRITE_SUBJECT_PROMPTS = {
  tree: "a single full tree with a thick trunk and dense leafy canopy",
  npc: "a single standing cloaked human figure, front view, full body, neutral pose",
  item: "a single ornate treasure chest, closed, three-quarter view",
  altar: "a single carved stone altar pedestal with worn engravings",
  crate: "a single wooden supply crate with iron banding",
  torch: "a single wooden torch on a stand with a burning flame",
  rock: "a single large mossy boulder",
};

export function hasSpriteFor(propType) {
  return Boolean(SPRITE_SUBJECT_PROMPTS[propType]);
}

// Labels are written by the model and can be arbitrary text, so they're bounded and
// stripped before being interpolated into a prompt sent to a paid API. The prop type
// stays as the authoritative subject anchor, so even a nonsense label still produces
// something of the right category.
const MAX_LABEL = 110;
function sanitizeLabel(label) {
  if (typeof label !== "string") return "";
  return label
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`\\{}<>]/g, "")
    .trim()
    .slice(0, MAX_LABEL);
}

// Short stable filename component for a label, so cache entries stay readable and
// filesystem-safe regardless of what the model wrote.
export function labelKey(label) {
  const clean = sanitizeLabel(label).toLowerCase();
  if (!clean) return "";
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h * 33) ^ clean.charCodeAt(i)) >>> 0;
  const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
  return `${slug}-${h.toString(36)}`;
}

// Keyed by the prop's LABEL rather than its type. Generating one sprite per type meant
// every world reused the same seven objects forever — a medieval monastery and a
// derelict station got the identical tree. The model already names each prop
// specifically ("pillar shaped like a swinging figure"), so that description is what
// the art should come from; the type only supplies category and fallback.
function spritePrompt(propType, label) {
  const clean = sanitizeLabel(label);
  const subject = clean
    ? `a single ${clean}`
    : SPRITE_SUBJECT_PROMPTS[propType] || "a single weathered stone object";

  return (
    `${subject}, painted fantasy game art, rich detail, soft even lighting. ` +
    "The object is centered, complete, and fully visible, viewed from ground level at " +
    "eye height. Isolated on a SOLID PURE MAGENTA (#FF00FF) background — the background " +
    "must be uniform magenta with no gradient, no shadow, no ground, no scenery, no " +
    "text. The object itself must contain no magenta or pink."
  );
}

// Surface material for architectural props, which keep real geometry rather than being
// billboarded. Generated from the object's own description so a "rusted bulkhead" and a
// "lichen-stained abbey wall" get different surfaces.
function propPrompt(propType, label) {
  const described = sanitizeLabel(label);
  const material = described
    ? `the surface material of ${described}`
    : PROP_MATERIAL_PROMPTS[propType] || "rough grey stone surface";
  return (
    `A seamless, tileable material texture: ${material}. ` +
    "Flat lay, evenly lit, photographed straight on, filling the entire frame. " +
    "No objects, no shadows, no background, no text, no edges or borders. " +
    "Square 1:1 aspect ratio, edges must tile seamlessly."
  );
}

// The model's declared output format isn't guaranteed to match what it actually
// returns (observed: PNG requested, JPEG bytes delivered), and serving a wrong
// Content-Type leaves the browser to sniff its way out of our mistake. Read the
// format off the magic bytes instead of trusting either end.
function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

// In-flight dedupe: several props/clients can request the same texture on the same
// turn, and without this each would fire its own (slow, paid) generation call.
const inFlight = new Map();

// Ground and sky are generated from the scene's authored description rather than a
// biome enum, so "drowned cathedral nave" and "orbital hydroponics bay" produce their
// own surfaces instead of both being forced into the nearest of eight presets.
export function describedGroundPrompt(groundCover, description) {
  const surface = sanitizeLabel(groundCover) || "worn grey stone";
  const place = sanitizeLabel(description);
  return (
    `A seamless, tileable ground texture: ${surface}` +
    (place ? `, from ${place}` : "") +
    ". Photorealistic game texture, evenly lit, no shadows cast across it, no objects, " +
    "no horizon, no sky, no text. Flat overhead view of the ground surface only. " +
    "Square 1:1 aspect ratio, edges must tile seamlessly."
  );
}

export function describedSkyPrompt(description, lightLevel) {
  const place = sanitizeLabel(description) || "an open landscape";
  const brightness =
    lightLevel >= 0.75 ? "bright daylight" : lightLevel >= 0.4 ? "dim overcast light" : "deep darkness";
  return (
    `The sky and upper distance as seen from inside ${place}, in ${brightness}. ` +
    "Fills the entire frame. NO ground, NO terrain, NO horizon line, NO buildings, " +
    "NO text — only what is overhead. Seamless 360-degree equirectangular panorama, " +
    "wide 2:1 aspect ratio, painterly digital matte painting."
  );
}

/**
 * Returns `{ buffer, contentType }` for a scene texture, generating via Gemini on a
 * cache miss.
 *
 * @param {object} args
 * @param {"ground"|"sky"|"prop"|"sprite"} args.kind
 * @param {string} args.label - what the texture depicts; for ground/sky this is the
 *   scene's authored description, for props/sprites the object's own label. All art is
 *   generated from description rather than from a fixed set of presets.
 * @param {number} [args.lightLevel] - 0-1, used to pitch sky brightness.
 */
// The image model refuses some requests as "recitation" — output that would too closely
// reproduce something it was trained on. It is not about the words in the prompt: a
// material texture of "cast iron", "frosted glass tube" or "rubber foot" is a stock
// photograph almost by definition, so the most likely image IS a near-copy, and the
// filter catches it. Twelve of a pack's material textures failed this way in one bake.
// Re-asking with the same prompt mostly fails the same way; steering away from the stock
// photograph — toward a specific, worn, one-off surface — gets through. The cache key is
// unchanged, because the request is still for the same material.
const RECITATION_NUDGES = [
  "Make it a specific, individual surface with its own irregular wear, not a generic stock texture.",
  "An original close-up with unusual, uneven detail and slight colour variation; avoid any standard reference image of this material.",
];

function isRecitationBlock(err) {
  return /recitation|copyright/i.test(String(err?.message || err));
}

/**
 * The filename a texture is stored under, in the generated cache and in a pack's own
 * 3D assets alike. Exported so scripts/bake-pack.mjs files a pack's textures under
 * exactly the name this module will later look for.
 */
export function textureFileName({ kind = "ground", propType, label }) {
  return cacheKey(null, null, null, kind, propType, label);
}

/**
 * The prompt for one texture. With a `style` — a pack's art direction — the look each kind
 * otherwise hardcodes (a photographed material, a photorealistic ground, a painterly
 * matte-painted sky) is replaced by that direction, so a pack's 3D world is painted to the
 * same brief as its 2D stage rather than to a stock-photo default.
 */
export function texturePrompt({ kind = "ground", propType, label, lightLevel = 0.7, style }) {
  if (!style) {
    return kind === "sky"
      ? describedSkyPrompt(label, lightLevel)
      : kind === "prop"
        ? propPrompt(propType, label)
        : kind === "sprite"
          ? spritePrompt(propType, label)
          : describedGroundPrompt(label, label);
  }

  const direction = `Art direction, followed exactly: ${sanitizeStyle(style)}`;
  const what = sanitizeLabel(label);
  if (kind === "sky") {
    const brightness = lightLevel >= 0.75 ? "bright" : lightLevel >= 0.4 ? "dim" : "very dark";
    return (
      `${direction}\n\nWhat is overhead and in the upper distance, seen from inside ` +
      `${what || "a vast hall"}, ${brightness}. Fills the entire frame. NO ground, NO floor, ` +
      "NO horizon line, NO text — only what is overhead. Seamless 360-degree equirectangular " +
      "panorama, wide 2:1 aspect ratio, drawn in the art direction above — not a photograph " +
      "and not a painterly matte painting."
    );
  }
  if (kind === "sprite") return `${direction}\n\n${spritePrompt(propType, label)}`;

  if (kind === "prop") {
    // An object's material is a SURFACE, and in a styled game it has one job: carry the
    // surface's character while the object's own colour, chosen from the palette, does
    // the rest. The renderer multiplies the two (the part's colour is pulled about halfway
    // to white first), so a dark or saturated texture drowns that colour.
    //
    // The first styled bake asked only for the material "in the art direction above",
    // and with this pack's brief — "labels and tiny arrows rendered as clean geometric
    // glyphs" — the model drew busy navy illustrations covered in glyphs. Every object
    // came out as the same dark speckled box, and a judge called the Keeper "an
    // unreadable stack of blobs". A material is not a picture of anything.
    return (
      `${direction}\n\nA seamless, tileable SURFACE texture for one material on a 3D object: ` +
      `${what || "rough grey stone"}. This is a surface, not an illustration. Render it in pale, ` +
      "near-neutral tones — the object's own colour is applied separately on top, so this should " +
      "carry only the material's character: faint grain, finish, a soft gradient or light wear, " +
      "in the art direction's manner. Low contrast throughout. NO symbols, glyphs, icons, " +
      "letters, labels, arrows, diagrams, patterns or repeating motifs — nothing that reads as a " +
      "picture of something. Flat, evenly lit, seen straight on, filling the entire frame. No " +
      "objects, no cast shadows, no edges or borders. Square 1:1 aspect ratio, edges must tile " +
      "seamlessly."
    );
  }

  return (
    `${direction}\n\nA seamless, tileable floor texture: ${what || "a worn floor"}, drawn in the ` +
    "art direction above — not a photograph. Flat, evenly lit, seen straight on, filling the " +
    "entire frame. No objects, no cast shadows, no background, no text, no edges or borders. " +
    "Square 1:1 aspect ratio, edges must tile seamlessly."
  );
}

function sanitizeStyle(style) {
  return String(style)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`\\{}<>]/g, "")
    .trim()
    .slice(0, 900);
}

/**
 * Paints one texture and returns it, without touching any cache.
 *
 * The bake script calls this directly with a pack's style, because a styled texture must
 * never land in the shared generated cache: that cache is keyed by label alone, so a
 * navy technical-diagram "cast iron" stored there would be served to every other game
 * that ever asks for cast iron.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function generateTexture({ kind = "ground", propType, label, lightLevel = 0.7, style } = {}) {
  if (!textureGenEnabled) throw new Error("texture generation disabled (no API key)");
  const prompt = texturePrompt({ kind, propType, label, lightLevel, style });
  const key = cacheKey(null, null, null, kind, propType, label);

  let image;
  let lastErr;
  for (let attempt = 0; attempt < RECITATION_NUDGES.length + 1; attempt++) {
    try {
      const input = attempt === 0 ? prompt : `${prompt} ${RECITATION_NUDGES[attempt - 1]}`;
      const interaction = await ai.interactions.create({ model: MODEL, input });
      image = interaction.output_image;
      if (image?.data) break;
      lastErr = new Error(`image model returned no image for ${key}`);
    } catch (err) {
      lastErr = err;
      // Only a recitation block is worth re-asking differently; anything else (a rate
      // limit, a network fault) is the caller's to retry.
      if (!isRecitationBlock(err)) throw err;
      console.warn(`[textures] ${key} blocked as recitation; re-asking with a nudge (${attempt + 1})`);
    }
  }
  if (!image?.data) throw lastErr;
  const buffer = Buffer.from(image.data, "base64");
  return { buffer, contentType: sniffImageType(buffer) };
}

/**
 * Returns a texture: from the request's pack, then the shared cache, then a fresh
 * unstyled generation that is cached.
 *
 * @param {object} args
 * @param {string|null} [args.packId] - the pack this request belongs to. Only that pack's
 *   shipped textures are searched — see server/src/packs/packAssets.js for why.
 */
export async function getTexture({ kind = "ground", propType, label, lightLevel = 0.7, packId = null }) {
  const key = cacheKey(null, null, null, kind, propType, label);
  const cachePath = path.join(CACHE_DIR, key);

  // Shipped textures need no API key at all. This check used to sit behind the key
  // guard, which meant a machine without one could not even read a file already on disk.
  const shipped = await readPackAsset("textures", key, packId);
  if (shipped) return { buffer: shipped, contentType: sniffImageType(shipped), fromPack: true };

  try {
    const cached = await readFile(cachePath);
    return { buffer: cached, contentType: sniffImageType(cached) };
  } catch {
    // cache miss — fall through and generate
  }

  if (!textureGenEnabled) throw new Error("texture generation disabled (no API key)");
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const startedAt = Date.now();
    const { buffer, contentType } = await generateTexture({ kind, propType, label, lightLevel });
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, buffer);
    console.log(
      `[textures] generated ${key} (${contentType}, ${buffer.length}B) in ${Date.now() - startedAt}ms`
    );
    return { buffer, contentType };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}
