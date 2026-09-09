import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", ".style-cache");

// One art direction per game, decided before a single image is generated and then
// prepended to every image prompt for the rest of the session.
//
// This is the single biggest fix carried over from the 3D version. There, every asset
// was generated from its own description with no shared brief, so a scene ended up
// holding a photoreal rock, a cel-shaded person and a watercolour door — twelve
// unrelated pictures rather than one game. Deciding the medium, palette, light and line
// quality up front and repeating them verbatim in every prompt is what makes the
// results look authored.
//
// It is NOT a template: the direction is written fresh for each premise, so a Antarctic
// survival log and a courtly romance get genuinely different looks. What is fixed is
// that a look is *chosen*, not that any particular look is.

const STYLE_TOOL = {
  name: "emit_art_direction",
  description: "Decide the visual identity of this game and who the player is.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The game's title. Short, evocative, specific to this premise — 2-5 words, " +
          "no subtitle, no colon.",
      },
      medium: {
        type: "string",
        description:
          "The physical medium and technique, as you would brief an illustrator — " +
          "'gouache on cold-press paper with visible tooth', 'sharp cel-shaded digital " +
          "painting with heavy black holding lines', 'smudged charcoal and white chalk', " +
          "'1970s airbrushed paperback cover art'. Commit to ONE technique. This is the " +
          "single most important field: it is what makes every picture look like the " +
          "same game. Describe only how marks are MADE — never how the image is " +
          "presented. No plate marks, paper edges, deckled borders, frames, torn edges, " +
          "vignettes or margins: individual objects are cut out of their background and " +
          "stood in the scene, so anything that implies a rectangle around the picture " +
          "turns every object into a floating framed print.",
      },
      palette: {
        type: "string",
        description:
          "The colour scheme in words, naming 3-5 specific colours and their roles — " +
          "'bleached bone white and dust ochre, with one bruise-purple in the shadows'. " +
          "Restrict it. A limited palette is most of what reads as art direction.",
      },
      light: {
        type: "string",
        description:
          "How things are lit throughout — 'low raking sunlight, long shadows, strong " +
          "warm/cool split', 'flat overcast with no cast shadows', 'single candle " +
          "source, deep falloff'.",
      },
      linework: {
        type: "string",
        description:
          "Edge quality and level of detail — 'no outlines, soft edges, forms read as " +
          "masses', 'crisp uniform ink contour on everything, flat fills'.",
      },
      protagonist: {
        type: "string",
        description:
          "The player character as a painter would need them described, head to toe, " +
          "in one sentence — build, clothing, what they carry, how they hold themselves. " +
          "Draw it from the source material and the player's own profile. This is what " +
          "the player's on-screen figure gets painted from, so make it visually " +
          "distinctive: a silhouette you can recognise across a wide scene.",
      },
      negative: {
        type: "string",
        description:
          "What must never appear, comma-separated — always include text and watermarks, " +
          "plus whatever would break this particular look ('no photorealism, no lens " +
          "flare, no 3d render').",
      },
    },
    required: ["title", "medium", "palette", "light", "linework", "protagonist"],
  },
};

const SYSTEM = `You are an art director starting work on an illustrated adventure game.

You are given the source material the game is built from and, sometimes, a profile of
the person who will play it. Decide the game's visual identity and call
emit_art_direction.

Choose a look that SUITS THIS MATERIAL and commits hard. The failure mode is the
generic default — soft digital fantasy concept art, orange-and-teal, rendered in the
middle of every style at once. Anything is on the table: woodblock print, risograph,
oil impasto, ligne claire, torn-paper collage, silverpoint, painted cel animation,
technical illustration. Pick the one an art director who had read this material would
actually pick, and describe it concretely enough that ten different illustrators given
your brief would produce pictures that hang together.

Be specific about colour. "Muted earth tones" is not art direction; "wet slate grey and
peat brown, with sodium-lamp orange as the only warm note" is.

One hard constraint on the technique you pick: the pictures are composited, not framed.
Backdrops fill the screen and individual objects are cut out of a flat background and
stood on them. So describe mark-making, colour and light — never presentation. Any brief
mentioning plate marks, paper edges, borders, frames, margins, torn or deckled edges, or
"a print of" something makes the image model paint a rectangular artwork instead of an
object, and every prop in the game becomes a picture hanging in mid-air.`;

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const styleGenEnabled = Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Renders the art direction into the prefix that goes in front of every image prompt.
 * Word-for-word identical across a session on purpose: an image model treats a reworded
 * brief as a different brief.
 */
export function styleLine(bible) {
  if (!bible) return "Painted game illustration.";
  return [
    bible.medium,
    `Colour: ${bible.palette}.`,
    `Light: ${bible.light}.`,
    `Edges: ${bible.linework}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What must never appear, appended to every image prompt. */
export function negativeLine(bible) {
  const base = "no text, no lettering, no watermark, no signature, no borders, no UI";
  return bible?.negative ? `${base}, ${bible.negative}` : base;
}

const inFlight = new Map();

/**
 * Returns the art direction for a game, generating on a cache miss.
 *
 * Keyed by the source text plus the profile fields that feed into it, so replaying the
 * same premise reuses the same look (and therefore the whole art cache), while a
 * different premise gets a different one.
 */
export async function getStyleBible({ sourceText, profile, personalize = true }) {
  const seed = [
    sourceText || "",
    personalize ? profile?.name || "" : "",
    personalize ? (profile?.interests || []).join(",") : "",
    personalize ? profile?.preferences || "" : "",
  ].join("|");
  const id = hash(seed);
  const file = path.join(CACHE_DIR, `${id}.json`);

  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // miss — generate
  }

  if (!styleGenEnabled) throw new Error("art direction unavailable (no ANTHROPIC_API_KEY)");
  if (inFlight.has(id)) return inFlight.get(id);

  const job = (async () => {
    const interests = (profile?.interests || []).filter(Boolean);
    const who =
      personalize && (profile?.name || interests.length)
        ? `\n\nThe player: ${profile?.name || "unnamed"}` +
          (interests.length ? `, drawn to ${interests.join(", ")}` : "") +
          (profile?.preferences ? `. They say: ${profile.preferences}` : "") +
          "\nLet this shape who the protagonist is, without overriding the source material."
        : "";

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: `Source material:\n"""\n${sourceText}\n"""${who}` }],
      tools: [STYLE_TOOL],
      tool_choice: { type: "tool", name: STYLE_TOOL.name },
    });

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === STYLE_TOOL.name
    );
    if (!toolUse?.input?.medium) {
      throw new Error(`art direction call returned nothing usable (${response.stop_reason})`);
    }

    const bible = { id, ...toolUse.input };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(bible, null, 2), "utf8");
    console.log(
      `[style] "${bible.title}" — ${bible.medium.slice(0, 60)}... (${Date.now() - startedAt}ms)`
    );
    return bible;
  })().finally(() => inFlight.delete(id));

  inFlight.set(id, job);
  return job;
}
