// Single source of truth for the "WorldState" structured-output contract between the
// model (server/src/narrative) and the renderer (web/src/scene). Keeping this in one
// shared package means the JSON schema the model is forced to emit and the lookup
// tables the renderer uses to draw it can never silently drift apart.

export const BIOMES = [
  "forest",
  "desert",
  "ruins",
  "cave",
  "urban",
  "coast",
  "snow",
  "swamp",
];

export const MOODS = [
  "serene",
  "tense",
  "ominous",
  "joyful",
  "mysterious",
  "desolate",
];

export const TIMES_OF_DAY = ["dawn", "day", "dusk", "night"];

export const PROP_TYPES = [
  "tree",
  "rock",
  "pillar",
  "wall",
  "structure",
  "water",
  "torch",
  "npc",
  "item",
  "altar",
  "crate",
];

// Half-extent of the walkable ground plane, in world units. Prop x/z must fall within
// [-GROUND_HALF_EXTENT, GROUND_HALF_EXTENT] so the renderer never has to clip/clamp.
export const GROUND_HALF_EXTENT = 20;

export const MIN_PROPS = 5;
export const MAX_PROPS = 14;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 4;

// JSON Schema for the Anthropic tool-call the model is forced to emit. Kept
// dependency-free (no zod/ajv) so it can be imported as-is by the Anthropic SDK's
// `tools[].input_schema` and, if desired, validated later with any JSON Schema
// validator without pulling extra packages into this shared package.
export const WORLD_STATE_TOOL = {
  name: "emit_scene",
  description:
    "Emit the next beat of the interactive world: narrative prose, a structured scene " +
    "description the renderer can build real 3D geometry from, and the choices offered " +
    "to the player.",
  input_schema: {
    type: "object",
    properties: {
      narrative: {
        type: "string",
        description:
          "2-4 short paragraphs of second-person prose narrating the current beat.",
      },
      scene: {
        type: "object",
        description: "Structured description of the 3D scene the player stands in.",
        properties: {
          biome: { type: "string", enum: BIOMES },
          mood: { type: "string", enum: MOODS },
          time_of_day: { type: "string", enum: TIMES_OF_DAY },
          props: {
            type: "array",
            minItems: MIN_PROPS,
            maxItems: MAX_PROPS,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: PROP_TYPES },
                x: {
                  type: "number",
                  minimum: -GROUND_HALF_EXTENT,
                  maximum: GROUND_HALF_EXTENT,
                },
                z: {
                  type: "number",
                  minimum: -GROUND_HALF_EXTENT,
                  maximum: GROUND_HALF_EXTENT,
                },
                scale: { type: "number", minimum: 0.3, maximum: 3 },
                label: {
                  type: "string",
                  description: "Short human-readable description, e.g. 'broken statue'.",
                },
              },
              required: ["type", "x", "z"],
            },
          },
        },
        required: ["biome", "mood", "time_of_day", "props"],
      },
      choices: {
        type: "array",
        minItems: MIN_CHOICES,
        maxItems: MAX_CHOICES,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
      state_updates: {
        type: "object",
        description:
          "Free-form tracked stats/flags that changed this turn (e.g. reputation, " +
          "inventory, relationships). Merged into the running world state.",
        additionalProperties: true,
      },
    },
    required: ["narrative", "scene", "choices"],
  },
};
