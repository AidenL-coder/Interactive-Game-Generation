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
function cacheKey(biome, mood, timeOfDay, kind) {
  return `${kind}_${biome}_${mood}_${timeOfDay}.img`;
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
  return (
    `A wide panoramic sky and distant horizon backdrop above ${biome} terrain. ` +
    `Mood: ${mood}. Time of day: ${timeOfDay}. ` +
    "Painted game skybox backdrop, no foreground objects, no text, no people."
  );
}

/**
 * Returns `{ buffer, contentType }` for a scene texture, generating via Gemini on a
 * cache miss. `kind` is "ground" | "sky".
 */
export async function getTexture({ biome, mood, timeOfDay, kind = "ground" }) {
  if (!textureGenEnabled) throw new Error("texture generation disabled (no API key)");

  const key = cacheKey(biome, mood, timeOfDay, kind);
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
      kind === "sky" ? skyPrompt(biome, mood, timeOfDay) : groundPrompt(biome, mood, timeOfDay);

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
