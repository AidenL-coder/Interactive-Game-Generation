import { GoogleGenAI } from "@google/genai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  // Material textures stay keyed by type: bark is bark regardless of which tree it's
  // wrapped around, so per-label variants would be pure waste.
  if (kind === "prop") return `prop_${propType}.img`;
  // Object sprites key on the label, falling back to the type when a prop has none.
  if (kind === "sprite") {
    const key = labelKey(label);
    return key ? `sprite_${propType}_${key}.img` : `sprite_${propType}.img`;
  }
  return `${kind}_${biome}_${mood}_${timeOfDay}.img`;
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

function propPrompt(propType) {
  const material = PROP_MATERIAL_PROMPTS[propType] || "rough grey stone surface";
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

function groundPrompt(biome, mood, timeOfDay) {
  return (
    `A seamless, tileable top-down texture of ${biome} ground terrain. ` +
    `Mood: ${mood}. Lighting: ${timeOfDay}. ` +
    "Photorealistic game texture, evenly lit, no shadows cast across it, no objects, " +
    "no horizon, no sky, no text. Flat overhead view of the ground surface only, " +
    "edges must tile seamlessly. Square 1:1 aspect ratio, filling the entire frame."
  );
}

function skyPrompt(biome, mood, timeOfDay) {
  // Sky ONLY. An earlier version asked for a "horizon backdrop above {biome} terrain"
  // and got cliffs and rocks — which, wrapped equirectangularly onto the scene
  // background, appeared as dark landmasses hanging directly overhead.
  return (
    `A ${timeOfDay} sky, ${mood} in feeling, seen looking straight up and around: ` +
    "clouds and open sky filling the entire frame. " +
    "ABSOLUTELY NO ground, NO terrain, NO horizon line, NO mountains, NO trees, " +
    "NO buildings, NO birds, NO text — nothing but sky and cloud. " +
    "Seamless 360-degree equirectangular panorama, wide 2:1 aspect ratio, " +
    "painterly digital matte painting."
  );
}

/**
 * Returns `{ buffer, contentType }` for a scene texture, generating via Gemini on a
 * cache miss. `kind` is "ground" | "sky".
 */
export async function getTexture({ biome, mood, timeOfDay, kind = "ground", propType, label }) {
  if (!textureGenEnabled) throw new Error("texture generation disabled (no API key)");

  const key = cacheKey(biome, mood, timeOfDay, kind, propType, label);
  const cachePath = path.join(CACHE_DIR, key);

  try {
    const cached = await readFile(cachePath);
    return { buffer: cached, contentType: sniffImageType(cached) };
  } catch {
    // cache miss — fall through and generate
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const prompt =
      kind === "sky"
        ? skyPrompt(biome, mood, timeOfDay)
        : kind === "prop"
          ? propPrompt(propType)
          : kind === "sprite"
            ? spritePrompt(propType, label)
            : groundPrompt(biome, mood, timeOfDay);

    const startedAt = Date.now();
    const interaction = await ai.interactions.create({ model: MODEL, input: prompt });
    const image = interaction.output_image;
    if (!image?.data) {
      throw new Error(`image model returned no image for ${key}`);
    }
    const buffer = Buffer.from(image.data, "base64");
    const contentType = sniffImageType(buffer);

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
