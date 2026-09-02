import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARTS_SCHEMA, validateParts } from "iwg-shared";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", ".geometry-cache");

// Builds real 3D geometry for a single object by asking the model to assemble it out of
// primitives. This replaces both billboarded 2D art (no thickness, no true shadow) and
// paid text-to-3D (slow, and rougher than it sounds), and costs nothing but a small
// text call.
//
// It is deliberately a SEPARATE call from scene generation. Inlining a parts array into
// each prop made the scene object complex enough that the model started silently
// omitting `scene` altogether — clean stop_reason, 4000 tokens of output, no scene. One
// focused call per object is both far more reliable and cacheable by description, so a
// "wooden crate" is built once and reused everywhere it ever appears.

const GEOMETRY_TOOL = {
  name: "emit_geometry",
  description: "Emit an object built as 3D geometry, assembled from primitive parts.",
  input_schema: {
    type: "object",
    properties: { parts: PARTS_SCHEMA },
    required: ["parts"],
  },
};

const SYSTEM_PROMPT = `You build 3D game objects out of primitive shapes, like assembling them from blocks.

Given a description, emit the object's geometry via the emit_geometry tool. Aim for a
recognisable SILHOUETTE using 4-12 parts — not a detailed sculpt.

Coordinates are metres, local to the object: y=0 is the ground, y is up, and the object
should be centred on x=z=0. Reference sizes: a person ~1.8 tall, a table ~0.8, a doorway
~2.1, a tree ~4, a camel ~2.2.

Shapes:
- box — size [width, height, depth]. Slabs, crates, walls, planks, tabletops, limbs.
- cylinder — size [bottom radius, height, top radius]. A top radius of 0 gives a cone,
  so use it for spires, tents and tapered legs too.
- sphere — size [x, y, z] radii, so it can be squashed into an ellipsoid.
- lathe — a profile of [radius, height] pairs revolved around the vertical axis. Best
  for columns, vases, balusters, domes, bottles.
- torus — size [ring radius, tube radius, unused]. Rings, hoops, wheels.
- plane — size [width, height, unused]. Banners, signs, sails; orient with rot.

Give each part a color suited to its material, and emissive for anything that glows —
flame, screens, runes, eyes. rot is in degrees.

Build what the description actually says. A camel is a body, a neck, a head, four legs
and two humps — not a brown box. A lectern is a base, a shaft and an angled top.`;

export const geometryGenEnabled = Boolean(process.env.ANTHROPIC_API_KEY);

const MAX_DESCRIPTION = 160;
function sanitize(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`\\{}<>]/g, "")
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

function descriptionKey(description, form) {
  const clean = `${sanitize(description)}|${form || ""}`.toLowerCase();
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h * 33) ^ clean.charCodeAt(i)) >>> 0;
  const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `${slug}-${h.toString(36)}`;
}

const inFlight = new Map();
const MAX_ATTEMPTS = 2;

async function generate(description, form) {
  let lastViolations = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Build this object: ${sanitize(description)}` +
            (form ? `\n\nIt is roughly "${form}" in proportion.` : ""),
        },
      ],
      tools: [GEOMETRY_TOOL],
      tool_choice: { type: "tool", name: GEOMETRY_TOOL.name },
    });

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === GEOMETRY_TOOL.name
    );
    if (!toolUse) {
      lastViolations = [`no tool_use block (stop_reason: ${response.stop_reason})`];
      continue;
    }

    const parts = toolUse.input?.parts;
    const check = validateParts(parts);
    if (check.valid) return parts;

    lastViolations = check.violations;
    console.warn(
      `[geometry] invalid parts for "${description}" (attempt ${attempt + 1}): ` +
        lastViolations.slice(0, 3).join("; ")
    );
  }

  throw new Error(`could not build geometry: ${lastViolations.join("; ")}`);
}

/**
 * Returns the parts array for an object description, generating on a cache miss.
 * Concurrent requests for the same description share one generation.
 */
export async function getGeometry(description, form) {
  const key = descriptionKey(description, form);
  const file = path.join(CACHE_DIR, `${key}.json`);

  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // miss — generate
  }

  if (!geometryGenEnabled) throw new Error("geometry generation disabled (no API key)");
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const startedAt = Date.now();
    const parts = await generate(description, form);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(parts), "utf8");
    console.log(
      `[geometry] built "${description}" from ${parts.length} parts in ${Date.now() - startedAt}ms`
    );
    return parts;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}
