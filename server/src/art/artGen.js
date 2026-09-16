import { GoogleGenAI } from "@google/genai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleLine, negativeLine } from "./styleBible.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", ".art-cache");
const MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
export const artGenEnabled = Boolean(apiKey);

if (!artGenEnabled) {
  console.warn(
    "[art] No GOOGLE_API_KEY/GEMINI_API_KEY set — /api/2d/art will 503 and the stage " +
      "falls back to painted-silhouette placeholders. Playable, but not the real thing."
  );
}

const ai = artGenEnabled ? new GoogleGenAI({ apiKey }) : null;

// Three kinds of picture, and only three. Every one of them goes through the same
// style prefix, which is the whole reason the scene hangs together.
export const ART_KINDS = ["backdrop", "figure", "portrait"];

// Aspect and resolution per kind. The backdrop is deliberately much wider than the
// viewport: the camera pans across it, so the place extends past what you can see,
// which is most of what makes it feel walked through rather than looked at.
const FORMAT = {
  backdrop: { aspect_ratio: "21:9", image_size: "2K" },
  figure: { aspect_ratio: "2:3", image_size: "1K" },
  portrait: { aspect_ratio: "1:1", image_size: "1K" },
};

// Cut-outs are keyed off a flat magenta backdrop, because the model only emits JPEG and
// therefore never carries an alpha channel. Magenta because effectively nothing in these
// subjects is naturally that colour, so keying it out costs no part of the subject.
const CHROMA = "SOLID PURE MAGENTA (#FF00FF)";

// How much of a description survives into the prompt. A backdrop brief is a paragraph
// describing a whole place and routinely runs past 450 characters — truncating it to a
// figure's budget cut the brief off mid-clause and, worse, made two different places with
// the same opening sentence share a cache entry. Figures stay short because a cut-out is
// one object and a long prompt only invites the model to compose a scene around it.
const MAX_DESCRIPTION = { backdrop: 700, figure: 260, portrait: 260 };

function sanitize(text, kind = "figure") {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`\\{}<>]/g, "")
    .trim()
    .slice(0, MAX_DESCRIPTION[kind] ?? 260);
}

function keyFor(text, kind) {
  const clean = sanitize(text, kind).toLowerCase();
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h * 33) ^ clean.charCodeAt(i)) >>> 0;
  const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${slug || "untitled"}-${h.toString(36)}`;
}

function cutoutRules() {
  return (
    // Careful with the wording here. An earlier version opened "THIS IS A DIE-CUT STICKER
    // OF THE SUBJECT", which is a vivid way to convey isolation and also a literal
    // description of an object with a thick white outline around it — so the model duly
    // painted one, and every affected prop wore a white keyline in the game. A border
    // painted into the source cannot be keyed or eroded away afterwards, so the prompt has
    // to forbid it outright rather than imply it.
    "THE SUBJECT ALONE, ON AN EMPTY BACKGROUND — not a picture of a scene. There is no " +
    "room, no wall, no floor, no ground, no sky, no furniture and no second object " +
    "anywhere in this image. " +
    `Every single pixel that is not the subject itself is ${CHROMA}: completely flat, ` +
    "uniform, and reaching all four edges and all four corners, with no gradient, no " +
    "vignette and no cast shadow. " +
    "The subject's own painted edge must meet that magenta directly: do NOT draw an " +
    "outline, keyline, stroke, contour line, halo, glow or white edge around it, and do " +
    "NOT make it look like a sticker or a cut-out shape. No frame, border, plate mark, " +
    "paper edge, deckle, margin rule, panel, inset or mount of any kind. If you are about " +
    "to paint the subject standing somewhere, you have misunderstood: paint only the " +
    "subject, on flat magenta. It must contain no magenta and no pink itself, and be " +
    "shown whole and uncropped."
  );
}

function buildPrompt(kind, description, bible, extra = {}) {
  const style = styleLine(bible);
  const negative = negativeLine(bible);
  const subject = sanitize(description, kind);

  if (kind === "backdrop") {
    // The horizon has to match where the renderer will stand actors, or everyone floats
    // or sinks. Stating it as a fraction of frame height is the one instruction here
    // that is about geometry rather than art.
    const horizonPct = Math.round((extra.horizon ?? 0.6) * 100);
    const mood = sanitize(extra.mood, "figure");
    return (
      `${style} ` +
      `An extremely wide panoramic establishing shot: ${subject}.` +
      (mood ? ` ${mood}.` : "") +
      ` The walkable ground begins about ${horizonPct}% of the way down the frame and ` +
      "runs level from there to the bottom edge — this is a stage a character walks " +
      "along, so the floor must be continuous and unbroken from the far left edge to the " +
      "far right edge. " +
      "This is an EMPTY SET, painted before anything is placed in it. Show the fixed " +
      "setting only: ground, walls, sky, water, distance, architecture, weather. No " +
      "people, no animals, and no loose objects, furniture, crates, vehicles, machinery " +
      "or props of any kind — those are painted separately and stood on this later, so " +
      "anything here would be a duplicate. Keep the whole lower half open and " +
      "uncluttered. Fill the frame edge to edge with one continuous scene, not a collage " +
      "or a panel layout. " +
      `Do not include: ${negative}, no people, no figures, no characters, no free-` +
      "standing objects, no split panels, no picture frames, no vignette border."
    );
  }

  if (kind === "portrait") {
    return (
      `${style} ` +
      `A head-and-shoulders portrait of ${subject}, facing the viewer, caught mid-` +
      "expression rather than posed. " +
      cutoutRules() +
      ` Do not include: ${negative}.`
    );
  }

  // figure
  return (
    `${style} ` +
    `A single ${subject}, shown complete and entire from top to bottom, at rest, seen ` +
    "from ground level at eye height, in three-quarter view. One subject only. " +
    // People are the subject the model is most tempted to place somewhere. Objects come
    // back correctly isolated; give it a person with an occupation and it paints them at
    // work in a room — a whole scene, which then gets discarded as a framed picture, and
    // the player's own figure is the cut-out that is always on screen. So say outright
    // that a person stands alone and does nothing.
    "If the subject is a person or a creature, they stand still and alone in a neutral " +
    "upright pose, arms at their sides, doing nothing and touching nothing: not working, " +
    "not operating or holding equipment, not seated, not in a room, and not beside any " +
    "other object. Their occupation is conveyed by their clothing alone. " +
    cutoutRules() +
    ` Do not include: ${negative}, no frame, no border, no plate mark, no paper edge.`
  );
}

// The model's declared output format is not guaranteed to match what it returns
// (observed on the 3D path: PNG requested, JPEG bytes delivered), and serving a wrong
// Content-Type leaves the browser to sniff its way out of our mistake. Read the format
// off the magic bytes instead of trusting either end.
function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

// Several actors can ask for the same picture on the same turn, and without this each
// would fire its own slow, paid generation.
const inFlight = new Map();

const MAX_ATTEMPTS = 2;

/**
 * Returns `{ buffer, contentType }` for one piece of game art, generating on a miss.
 *
 * Cached under the art direction's id, so every game gets its own art even for an
 * identically-worded object — a "wooden door" in the woodblock-print game and the
 * charcoal one are different pictures. Within a game, the same description is generated
 * exactly once however many times it appears.
 *
 * @param {object} args
 * @param {"backdrop"|"figure"|"portrait"} args.kind
 * @param {string} args.description - what to paint
 * @param {object} args.bible - the session's art direction
 * @param {object} [args.extra] - kind-specific hints (backdrop: horizon, mood)
 * @param {boolean} [args.regenerate] - ignore and overwrite the cached image. The client
 *   asks for this when a cut-out came back unusable: the model occasionally ignores the
 *   magenta-background instruction entirely, and a fresh sample of the same prompt
 *   usually succeeds. Without it that object is a silhouette for the rest of the game,
 *   because the bad image is cached like any other.
 */
export async function getArt({ kind, description, bible, extra, regenerate = false }) {
  if (!ART_KINDS.includes(kind)) throw new Error(`unknown art kind '${kind}'`);
  if (!artGenEnabled) throw new Error("art generation disabled (no API key)");

  const styleId = bible?.id || "nostyle";
  const file = path.join(CACHE_DIR, styleId, `${kind}_${keyFor(description, kind)}.img`);

  if (!regenerate) {
    try {
      const cached = await readFile(file);
      return { buffer: cached, contentType: sniffImageType(cached), cached: true };
    } catch {
      // miss — generate
    }
  }

  // A regeneration must not join the in-flight job it is trying to replace, but two
  // concurrent regenerations of the same image should still share one call.
  const flightKey = regenerate ? `regen:${file}` : file;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);

  const job = (async () => {
    const prompt = buildPrompt(kind, description, bible, extra);
    const startedAt = Date.now();

    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const interaction = await ai.interactions.create({
          model: MODEL,
          input: prompt,
          // JPEG is the only format this model will emit, so there is no alpha channel
          // and cut-outs must come from keying the magenta backdrop. Aspect ratio is
          // honoured, which is what makes a genuinely wide panoramic stage possible.
          response_format: {
            type: "image",
            mime_type: "image/jpeg",
            ...FORMAT[kind],
          },
        });

        const image = interaction.output_image;
        if (!image?.data) throw new Error("model returned no image");

        const buffer = Buffer.from(image.data, "base64");
        const contentType = sniffImageType(buffer);

        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buffer);
        console.log(
          `[art] ${kind} "${sanitize(description, kind).slice(0, 44)}" ` +
            `(${contentType}, ${Math.round(buffer.length / 1024)}kB) in ${Date.now() - startedAt}ms`
        );
        return { buffer, contentType, cached: false };
      } catch (err) {
        lastErr = err;
        console.warn(`[art] ${kind} attempt ${attempt + 1} failed: ${err.message || err}`);
      }
    }
    throw lastErr || new Error("art generation failed");
  })().finally(() => inFlight.delete(flightKey));

  inFlight.set(flightKey, job);
  return job;
}
