// Single source of truth for the "WorldState" structured-output contract between the
// model (server/src/narrative) and the renderer (web/src/scene). Keeping this in one
// shared package means the JSON schema the model is forced to emit and the lookup
// tables the renderer uses to draw it can never silently drift apart.

// There is deliberately no biome enum and no prop-type enum. Fixing those to eight
// settings and eleven nouns meant every generated world was the same handful of objects
// re-skinned: a space station and a Victorian parlour both had to be described with
// "altar" and "crate", and every forest drew from one hardcoded recipe. The model now
// authors its own vocabulary — what the place is, what's in it, and how it's lit — and
// the renderer derives its look from those generated values rather than a lookup table.
//
// What remains fixed is only what the renderer physically cannot infer: how an object
// occupies space, which decides the placeholder shape, collision, and whether it can be
// drawn as a billboard.
export const PROP_FORMS = [
  "tall", // trees, columns, masts, standing stones — much taller than wide
  "wide", // walls, buildings, vehicles — architectural, you walk around it
  "small", // crates, chests, tools, debris piles — knee height or below
  "humanoid", // people, statues, creatures — roughly person-shaped and person-sized
  "flat", // pools, rugs, hatches, scorch marks — lies on the ground
];

// Forms that keep primitive geometry instead of becoming billboarded artwork.
//
// This was `["wide"]`, on the reasoning that you walk around architecture and a flat
// card gives itself away. In practice the model uses "wide" for far more than walls —
// lecterns, collapsed racks, hatches — and those rendered as featureless dark boxes
// sitting among detailed generated art, which looked far worse than a billboard seen
// from a slightly wrong angle. Empty for now: everything gets art, and the primitive
// survives underneath as the collision volume and the pre-generation placeholder.
export const GEOMETRIC_FORMS = new Set();

export const FORM_HEIGHT = {
  tall: 3.4,
  wide: 2.2,
  small: 0.8,
  humanoid: 1.85,
  // Flat things lie on the ground, so they're drawn as a ground decal rather than a
  // standing billboard — see attachSprite.
  flat: 0.12,
};

// Forms the player can walk through rather than collide with.
export const PASSABLE_FORMS = new Set(["flat"]);

// Primitive shapes an object can be assembled from. This is not a catalogue of objects —
// it's a catalogue of *parts*, the way a box of blocks isn't a catalogue of buildings.
// The model composes arbitrary things out of these, so a lectern, a camel and a reactor
// housing are all equally expressible without anything being pre-authored.
export const PART_SHAPES = [
  "box",
  "cylinder", // also cones and tapers, via differing top/bottom radii
  "sphere",
  "lathe", // a revolved profile: columns, vases, balusters, domes, bottles
  "torus",
  "plane",
];

export const MAX_PARTS = 14;

const PART_SCHEMA = {
  type: "object",
  properties: {
    shape: { type: "string", enum: PART_SHAPES },
    // Local to the object, in metres, with y=0 at the ground and the object centred on
    // x=z=0. The renderer places the assembled object in the world.
    pos: {
      type: "array",
      description: "[x, y, z] offset in metres from the object's base centre.",
      items: { type: "number", minimum: -6, maximum: 12 },
      minItems: 3,
      maxItems: 3,
    },
    size: {
      type: "array",
      description:
        "[x, y, z] in metres. box: full width/height/depth. cylinder: bottom radius, " +
        "height, top radius (top 0 gives a cone). sphere: radii. torus: ring radius, " +
        "tube radius, unused. plane: width, height, unused.",
      items: { type: "number", minimum: 0, maximum: 12 },
      minItems: 3,
      maxItems: 3,
    },
    rot: {
      type: "array",
      description: "[x, y, z] rotation in DEGREES. Optional, defaults to none.",
      items: { type: "number", minimum: -360, maximum: 360 },
      minItems: 3,
      maxItems: 3,
    },
    profile: {
      type: "array",
      description:
        "For shape 'lathe' only: the silhouette revolved around the vertical axis, as " +
        "[radius, height] pairs from bottom to top, e.g. a column: " +
        "[[0.5,0],[0.4,0.2],[0.35,2.6],[0.5,2.8],[0.5,3.0]].",
      items: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 12 },
        minItems: 2,
        maxItems: 2,
      },
    },
    color: { type: "string", description: "Hex colour, e.g. '#6b5a3a'." },
    roughness: { type: "number", minimum: 0, maximum: 1 },
    metalness: { type: "number", minimum: 0, maximum: 1 },
    emissive: {
      type: "string",
      description: "Hex colour for self-lit parts — flames, screens, glowing runes.",
    },
  },
  required: ["shape", "pos", "size", "color"],
};

export const PARTS_SCHEMA = {
  type: "array",
  maxItems: MAX_PARTS,
  description:
    "The object built as real 3D geometry, assembled from primitive parts. Compose the " +
    "actual silhouette: a lectern is a tapered base, a shaft and an angled top; a camel " +
    "is a body, neck, head, four legs and two humps. Use 4-12 parts — enough to be " +
    "recognisable in outline, not a detailed sculpt.",
  items: PART_SCHEMA,
};

// Half-extent of the walkable ground plane, in world units. Prop x/z must fall within
// [-GROUND_HALF_EXTENT, GROUND_HALF_EXTENT] so the renderer never has to clip/clamp.
export const GROUND_HALF_EXTENT = 20;

export const MIN_PROPS = 5;
export const MAX_PROPS = 14;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 4;

// Actions the avatar performs before control returns to the player. Capped so a turn's
// playback stays short enough that watching it doesn't become a chore.
export const AGENT_ACTION_TYPES = ["walk_to", "look_at", "interact", "say", "wait"];
export const MAX_AGENT_ACTIONS = 6;

// Shared by both tools so the full-scene and delta paths can never disagree about what
// a prop is. `id` is required: stable identity is what makes deltas, agent-action
// targeting, and cross-turn spatial-consistency measurement possible at all.
const PROP_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Stable unique identifier for this prop, e.g. 'altar_01'. Reuse the same id " +
        "across turns when referring to the same physical object.",
    },
    label: {
      type: "string",
      description:
        "What this object actually is, specifically and visually — 'cracked obsidian " +
        "altar veined with light', 'toppled vending machine', 'moss-eaten oak'. This is " +
        "the description the object's artwork is generated from, so be concrete and " +
        "evocative. Anything at all can appear here; you are not limited to a fixed list.",
    },
    form: {
      type: "string",
      enum: PROP_FORMS,
      description:
        "How the object occupies space, so it can be placed and collided with before " +
        "its art loads: tall (much taller than wide), wide (architectural, walk-around), " +
        "small (knee height or below), humanoid (person-shaped/sized), flat (lies on " +
        "the ground).",
    },
    x: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
    z: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
    scale: { type: "number", minimum: 0.3, maximum: 3 },
    character: {
      type: "boolean",
      description:
        "True if this is a person or creature the player can talk to. Give these a " +
        "name in the label, e.g. 'Sister Adair, the keeper'.",
    },
  },
  // Geometry is deliberately NOT part of this schema. Inlining a parts array per prop
  // made the `scene` object complex enough that the model began silently omitting it
  // altogether — a clean stop_reason, 4000 tokens of output, and no scene at all. Each
  // object's geometry is generated by its own focused call instead (see
  // server/src/geometry/), which is both more reliable and cacheable per description.
  required: ["id", "label", "form", "x", "z"],
};

// The look of the world, authored per scene rather than looked up from a biome table.
const ENVIRONMENT_SCHEMA = {
  type: "object",
  description: "What this place is and how it is lit. Drives the entire render.",
  properties: {
    description: {
      type: "string",
      description:
        "The setting in a few concrete visual words — 'bioluminescent fungal cavern', " +
        "'flooded gothic cathedral at dusk', 'orbital station corridor'. Anything at " +
        "all; this is what the sky and ground artwork are generated from.",
    },
    ground_cover: {
      type: "string",
      description:
        "What the floor is made of, e.g. 'wet black stone and pale fungus', 'drifted " +
        "red sand', 'cracked marble tiles'. Generates the ground texture.",
    },
    palette: {
      type: "object",
      description: "Hex colours (e.g. '#3a2f4a') that set the mood of the lighting.",
      properties: {
        ground: { type: "string", description: "Base ground colour before texture loads." },
        fog: { type: "string", description: "Distance haze / horizon colour." },
        light: { type: "string", description: "Colour of the main light source." },
        ambient: { type: "string", description: "Colour of the ambient fill light." },
        scatter: { type: "string", description: "Dominant colour of ground vegetation/debris." },
      },
      required: ["ground", "fog", "light", "ambient"],
    },
    light_level: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0 = near dark (deep cave, night), 1 = full bright daylight.",
    },
    visibility: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0 = dense fog closing in, 1 = clear open air to the horizon.",
    },
    scatter_density: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0 = bare floor, 1 = densely overgrown or heavily littered.",
    },
    scatter_cover: {
      type: "string",
      description:
        "What the small scattered ground detail is — 'fern clumps and fallen branches', " +
        "'shattered glass and rebar', 'ice crusts'. Purely decorative filler.",
    },
  },
  required: ["description", "ground_cover", "palette", "light_level", "visibility"],
};

const AGENT_ACTIONS_SCHEMA = {
  type: "array",
  maxItems: MAX_AGENT_ACTIONS,
  description:
    "Ordered actions the player's avatar performs automatically before control returns. " +
    "Use these to act out the chosen action in the world (walk to the altar, examine it). " +
    "Reference props by their id.",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: AGENT_ACTION_TYPES },
      target_id: { type: "string", description: "Prop id to walk to / look at / interact with." },
      x: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
      z: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
      text: { type: "string", description: "Spoken line, for type 'say'." },
      seconds: { type: "number", minimum: 0.2, maximum: 4, description: "For type 'wait'." },
    },
    required: ["type"],
  },
};

const CHOICES_SCHEMA = {
  type: "array",
  minItems: MIN_CHOICES,
  maxItems: MAX_CHOICES,
  items: {
    type: "object",
    properties: { id: { type: "string" }, text: { type: "string" } },
    required: ["id", "text"],
  },
};

// What turns this from an interactive story generator into a game: something to
// achieve, visible movement toward it, and an ending you can reach or fail to reach.
// Kept to three flat fields on purpose — the one time a large nested addition was made
// here, the model began silently dropping `scene` altogether.
const OBJECTIVE_SCHEMA = {
  type: "string",
  description:
    "The player's concrete goal, in one short sentence — 'find out what happened to " +
    "the keeper before the tide comes in'. Set it on the FIRST turn and repeat it " +
    "verbatim every turn after, unless the story genuinely redefines it.",
};

const PROGRESS_SCHEMA = {
  type: "number",
  minimum: 0,
  maximum: 1,
  description:
    "How close the player is to the objective, 0 to 1. Move it meaningfully when they " +
    "learn or achieve something real, and not at all when they don't — this is shown " +
    "on screen, so it has to mean something.",
};

const ENDING_SCHEMA = {
  type: "object",
  description:
    "Set ONLY on the turn the story actually ends. Stories should reach an ending in " +
    "roughly 8-15 turns rather than continuing indefinitely — build toward it, then " +
    "finish. Omit entirely while the story is still running.",
  properties: {
    outcome: {
      type: "string",
      enum: ["victory", "defeat", "bittersweet"],
    },
    epilogue: {
      type: "string",
      description: "2-3 paragraphs closing the story. Shown on the ending screen.",
    },
  },
  required: ["outcome", "epilogue"],
};

const STATE_UPDATES_SCHEMA = {
  type: "object",
  description:
    "Free-form tracked stats/flags that changed this turn (e.g. reputation, " +
    "inventory, relationships). Merged into the running world state.",
  additionalProperties: true,
};

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
          environment: ENVIRONMENT_SCHEMA,
          props: {
            type: "array",
            minItems: MIN_PROPS,
            maxItems: MAX_PROPS,
            items: PROP_SCHEMA,
          },
        },
        required: ["environment", "props"],
      },
      agent_actions: AGENT_ACTIONS_SCHEMA,
      choices: CHOICES_SCHEMA,
      objective: OBJECTIVE_SCHEMA,
      progress: PROGRESS_SCHEMA,
      ending: ENDING_SCHEMA,
      state_updates: STATE_UPDATES_SCHEMA,
    },
    required: ["narrative", "scene", "choices"],
  },
};

// Persistent-world counterpart to WORLD_STATE_TOOL. Two separate tools rather than one
// tool with mutually-exclusive fields: `oneOf`/`anyOf` support in tool input schemas is
// unreliable, and the forced tool_choice already gives us a clean way to select a mode.
//
// `scene_delta` mutates the existing world; `scene` replaces it wholesale. Exactly one
// must be present — enforced in validateDeltaTurn() rather than the schema, for the same
// reason. Relocating to a new place (biome change) is what `scene` is for.
export const WORLD_STATE_DELTA_TOOL = {
  name: "emit_scene_delta",
  description:
    "Emit the next beat of a PERSISTENT interactive world. Prefer `scene_delta` to mutate " +
    "the existing scene so the world stays continuous. Only use `scene` when the story " +
    "relocates somewhere genuinely new (a different biome/location).",
  input_schema: {
    type: "object",
    properties: {
      narrative: {
        type: "string",
        description:
          "2-4 short paragraphs of second-person prose narrating the current beat.",
      },
      scene_delta: {
        type: "object",
        description: "Incremental change to the existing scene. Reference props by id.",
        properties: {
          add: { type: "array", items: PROP_SCHEMA },
          move: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                x: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
                z: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
              },
              required: ["id", "x", "z"],
            },
          },
          remove: { type: "array", items: { type: "string" } },
          ambient: {
            type: "object",
            description: "Environment shifts that don't change location.",
            properties: {
              palette: ENVIRONMENT_SCHEMA.properties.palette,
              light_level: ENVIRONMENT_SCHEMA.properties.light_level,
              visibility: ENVIRONMENT_SCHEMA.properties.visibility,
            },
          },
        },
      },
      scene: {
        type: "object",
        description: "Full replacement scene. Use ONLY when relocating somewhere new.",
        properties: {
          environment: ENVIRONMENT_SCHEMA,
          props: {
            type: "array",
            minItems: MIN_PROPS,
            maxItems: MAX_PROPS,
            items: PROP_SCHEMA,
          },
        },
        required: ["environment", "props"],
      },
      agent_actions: AGENT_ACTIONS_SCHEMA,
      choices: CHOICES_SCHEMA,
      objective: OBJECTIVE_SCHEMA,
      progress: PROGRESS_SCHEMA,
      ending: ENDING_SCHEMA,
      state_updates: STATE_UPDATES_SCHEMA,
    },
    required: ["narrative", "choices"],
  },
};

// Structural validation for a WorldState the model claims to have emitted. Forcing
// tool_choice makes a well-formed response *likely*, not guaranteed — the model can
// still emit a structurally malformed tool_use.input (wrong nesting, a stray string
// where an object belongs, enum drift). Used both server-side (generateScene.js
// retries once on failure rather than serving a silently-broken world) and by
// eval/score.mjs (reports the validity rate as a reliability metric per docs/research.md).
// Spatial-consistency counters, tallied alongside plain structural validity. These are
// the failure modes that only exist once a world persists in space across turns —
// referencing an object that isn't there, minting a duplicate identity, shoving
// something off the map. Linear text generation cannot exhibit them, which is exactly
// why they're worth measuring here (see docs/research.md, evaluation plan).
function emptySpatial() {
  return { danglingRefs: 0, duplicateIds: 0, outOfBounds: 0 };
}

// Environment is authored per scene, so there is no enum to check it against — only
// that it is structurally present and usable by the renderer. A missing palette colour
// would leave the scene rendering against undefined, which is a real fault; an unusual
// *choice* of colour is not.
const HEX = /^#?[0-9a-fA-F]{6}$/;
function checkEnvironment(env, violations, path = "scene.environment") {
  if (!env || typeof env !== "object") {
    violations.push(`${path} missing/not an object`);
    return;
  }
  if (!env.description?.trim()) violations.push(`${path}.description missing/empty`);
  if (!env.ground_cover?.trim()) violations.push(`${path}.ground_cover missing/empty`);

  const palette = env.palette;
  if (!palette || typeof palette !== "object") {
    violations.push(`${path}.palette missing/not an object`);
  } else {
    for (const key of ["ground", "fog", "light", "ambient"]) {
      if (!HEX.test(palette[key] || "")) {
        violations.push(`${path}.palette.${key} '${palette[key]}' is not a hex colour`);
      }
    }
  }

  for (const key of ["light_level", "visibility"]) {
    const v = env[key];
    if (typeof v !== "number" || v < 0 || v > 1) {
      violations.push(`${path}.${key} '${v}' outside [0, 1]`);
    }
  }
}

// Parts describe real geometry, so a malformed one renders as a visible defect rather
// than failing loudly — a part at NaN, or sized 40 metres, wrecks the scene silently.
// Validated strictly for that reason.
export function validateParts(parts) {
  const violations = [];
  const path = "parts";
  if (!Array.isArray(parts) || parts.length === 0) {
    return { valid: false, violations: [`${path} missing/empty`] };
  }
  if (parts.length > MAX_PARTS) {
    violations.push(`${path}.length=${parts.length} exceeds ${MAX_PARTS}`);
  }

  const triple = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

  parts.forEach((part, i) => {
    const at = `${path}[${i}]`;
    if (!PART_SHAPES.includes(part?.shape)) {
      violations.push(`${at}.shape '${part?.shape}' not in enum`);
    }
    if (!triple(part?.pos)) violations.push(`${at}.pos must be 3 finite numbers`);
    if (!triple(part?.size)) violations.push(`${at}.size must be 3 finite numbers`);
    else if (part.size.every((n) => n <= 0)) violations.push(`${at}.size is all zero`);
    if (part?.rot !== undefined && !triple(part.rot)) {
      violations.push(`${at}.rot must be 3 finite numbers`);
    }
    if (!HEX.test(part?.color || "")) {
      violations.push(`${at}.color '${part?.color}' is not a hex colour`);
    }
    if (part?.shape === "lathe") {
      const ok =
        Array.isArray(part.profile) &&
        part.profile.length >= 2 &&
        part.profile.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      if (!ok) violations.push(`${at}.profile required for lathe (>=2 [radius,height] pairs)`);
    }
  });

  return { valid: violations.length === 0, violations };
}

function checkProps(props, violations, spatial, { path = "props" } = {}) {
  const ids = new Set();
  if (!Array.isArray(props)) {
    violations.push(`${path} missing/not an array`);
    return ids;
  }
  props.forEach((p, i) => {
    if (!p?.id || typeof p.id !== "string") {
      violations.push(`${path}[${i}].id missing`);
    } else if (ids.has(p.id)) {
      violations.push(`${path}[${i}].id '${p.id}' duplicated`);
      spatial.duplicateIds++;
    } else {
      ids.add(p.id);
    }
    if (!p?.label?.trim()) violations.push(`${path}[${i}].label missing/empty`);
    // Form stays enumerated: it isn't descriptive vocabulary, it's the renderer's only
    // way to know how the object occupies space before its artwork exists.
    if (!PROP_FORMS.includes(p?.form)) violations.push(`${path}[${i}].form '${p?.form}' not in enum`);
    if (typeof p?.x !== "number" || Math.abs(p.x) > GROUND_HALF_EXTENT) {
      violations.push(`${path}[${i}].x out of bounds`);
      spatial.outOfBounds++;
    }
    if (typeof p?.z !== "number" || Math.abs(p.z) > GROUND_HALF_EXTENT) {
      violations.push(`${path}[${i}].z out of bounds`);
      spatial.outOfBounds++;
    }
  });
  return ids;
}

function checkChoices(choices, violations) {
  if (!Array.isArray(choices)) {
    violations.push("choices missing/not an array");
    return;
  }
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
    violations.push(`choices.length=${choices.length} outside [${MIN_CHOICES}, ${MAX_CHOICES}]`);
  }
  choices.forEach((c, i) => {
    if (!c?.id || !c?.text) violations.push(`choices[${i}] missing id/text`);
  });
}

// `knownIds` is every prop id that exists in the world *after* this turn's changes are
// applied — an action may legitimately target something the same turn just added.
function checkAgentActions(actions, knownIds, violations, spatial) {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    violations.push("agent_actions not an array");
    return;
  }
  if (actions.length > MAX_AGENT_ACTIONS) {
    violations.push(`agent_actions.length=${actions.length} exceeds ${MAX_AGENT_ACTIONS}`);
  }
  actions.forEach((a, i) => {
    if (!AGENT_ACTION_TYPES.includes(a?.type)) {
      violations.push(`agent_actions[${i}].type '${a?.type}' not in enum`);
      return;
    }
    const hasCoords = typeof a.x === "number" && typeof a.z === "number";
    if (a.target_id && !knownIds.has(a.target_id)) {
      violations.push(`agent_actions[${i}] targets unknown prop '${a.target_id}'`);
      spatial.danglingRefs++;
    }
    if ((a.type === "walk_to" || a.type === "look_at") && !a.target_id && !hasCoords) {
      violations.push(`agent_actions[${i}] (${a.type}) needs target_id or x/z`);
    }
    if (a.type === "interact" && !a.target_id) {
      violations.push(`agent_actions[${i}] (interact) needs target_id`);
    }
    if (a.type === "say" && (!a.text || !String(a.text).trim())) {
      violations.push(`agent_actions[${i}] (say) needs text`);
    }
  });
}

export function validateWorldState(ws) {
  const violations = [];
  const spatial = emptySpatial();
  if (!ws || typeof ws !== "object") {
    return { valid: false, violations: ["worldState missing/not an object"], spatial };
  }

  if (!ws.narrative || typeof ws.narrative !== "string" || !ws.narrative.trim()) {
    violations.push("narrative missing/empty");
  }

  const scene = ws.scene;
  let ids = new Set();
  if (!scene || typeof scene !== "object") {
    violations.push("scene missing/not an object");
  } else {
    checkEnvironment(scene.environment, violations);

    if (Array.isArray(scene.props) && (scene.props.length < MIN_PROPS || scene.props.length > MAX_PROPS)) {
      violations.push(`props.length=${scene.props.length} outside [${MIN_PROPS}, ${MAX_PROPS}]`);
    }
    ids = checkProps(scene.props, violations, spatial, { path: "scene.props" });
  }

  checkChoices(ws.choices, violations);
  checkAgentActions(ws.agent_actions, ids, violations, spatial);

  return { valid: violations.length === 0, violations, spatial };
}

/**
 * Validates a persistent-mode turn against the world as it stood before this turn.
 *
 * @param {object} turn - the emit_scene_delta tool input
 * @param {Set<string>|string[]} knownPropIds - prop ids existing before this turn
 */
export function validateDeltaTurn(turn, knownPropIds = []) {
  const violations = [];
  const spatial = emptySpatial();
  const known = knownPropIds instanceof Set ? new Set(knownPropIds) : new Set(knownPropIds);

  if (!turn || typeof turn !== "object") {
    return { valid: false, violations: ["turn missing/not an object"], spatial };
  }

  if (!turn.narrative || typeof turn.narrative !== "string" || !turn.narrative.trim()) {
    violations.push("narrative missing/empty");
  }

  const hasDelta = turn.scene_delta && typeof turn.scene_delta === "object";
  const hasFullScene = turn.scene && typeof turn.scene === "object";
  let idsAfter;

  if (hasDelta && hasFullScene) {
    violations.push("scene_delta and scene are mutually exclusive, got both");
  }
  // Neither is valid and common: plenty of beats (reading a letter, a conversation)
  // change nothing physical. Treating that as an error forced the model to invent
  // spurious world churn, so "no delta" means "the world is unchanged".
  if (!hasDelta && !hasFullScene) {
    idsAfter = new Set(known);
  }

  if (hasFullScene && !hasDelta) {
    // Relocation: the previous world is discarded, so nothing carries over.
    const scene = turn.scene;
    checkEnvironment(scene.environment, violations);
    if (Array.isArray(scene.props) && (scene.props.length < MIN_PROPS || scene.props.length > MAX_PROPS)) {
      violations.push(`scene.props.length=${scene.props.length} outside [${MIN_PROPS}, ${MAX_PROPS}]`);
    }
    idsAfter = checkProps(scene.props, violations, spatial, { path: "scene.props" });
  } else if (hasDelta) {
    const d = turn.scene_delta;
    idsAfter = new Set(known);

    if (d.add !== undefined) {
      const addedIds = checkProps(d.add, violations, spatial, { path: "scene_delta.add" });
      for (const id of addedIds) {
        if (idsAfter.has(id)) {
          violations.push(`scene_delta.add re-uses existing prop id '${id}'`);
          spatial.duplicateIds++;
        }
        idsAfter.add(id);
      }
    }

    if (d.move !== undefined) {
      if (!Array.isArray(d.move)) violations.push("scene_delta.move not an array");
      else
        d.move.forEach((m, i) => {
          if (!m?.id || !idsAfter.has(m.id)) {
            violations.push(`scene_delta.move[${i}] targets unknown prop '${m?.id}'`);
            spatial.danglingRefs++;
          }
          if (typeof m?.x !== "number" || Math.abs(m.x) > GROUND_HALF_EXTENT) {
            violations.push(`scene_delta.move[${i}].x out of bounds`);
            spatial.outOfBounds++;
          }
          if (typeof m?.z !== "number" || Math.abs(m.z) > GROUND_HALF_EXTENT) {
            violations.push(`scene_delta.move[${i}].z out of bounds`);
            spatial.outOfBounds++;
          }
        });
    }

    if (d.remove !== undefined) {
      if (!Array.isArray(d.remove)) violations.push("scene_delta.remove not an array");
      else
        d.remove.forEach((id, i) => {
          if (!idsAfter.has(id)) {
            violations.push(`scene_delta.remove[${i}] targets unknown prop '${id}'`);
            spatial.danglingRefs++;
          }
          idsAfter.delete(id);
        });
    }

    if (d.ambient) {
      // Ambient shifts are partial by nature — a turn may change only the light level —
      // so each field is validated only when present.
      for (const key of ["light_level", "visibility"]) {
        const v = d.ambient[key];
        if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) {
          violations.push(`scene_delta.ambient.${key} '${v}' outside [0, 1]`);
        }
      }
      if (d.ambient.palette !== undefined) {
        if (typeof d.ambient.palette !== "object" || d.ambient.palette === null) {
          violations.push("scene_delta.ambient.palette not an object");
        } else {
          for (const [key, value] of Object.entries(d.ambient.palette)) {
            if (!HEX.test(value || "")) {
              violations.push(`scene_delta.ambient.palette.${key} '${value}' is not a hex colour`);
            }
          }
        }
      }
    }

    if (idsAfter.size < MIN_PROPS) {
      violations.push(`world would have ${idsAfter.size} props, below minimum ${MIN_PROPS}`);
    }
    if (idsAfter.size > MAX_PROPS) {
      violations.push(`world would have ${idsAfter.size} props, above maximum ${MAX_PROPS}`);
    }
  }

  checkChoices(turn.choices, violations);
  checkAgentActions(turn.agent_actions, idsAfter ?? new Set(), violations, spatial);

  return { valid: violations.length === 0, violations, spatial };
}

/**
 * Applies a validated delta to a prop array, returning a new array. Pure — the caller
 * owns the registry. Order matters: add, then move, then remove, matching the order
 * validateDeltaTurn() checks them in.
 */
export function applySceneDelta(props, delta) {
  const byId = new Map((props || []).map((p) => [p.id, { ...p }]));

  for (const p of delta?.add || []) byId.set(p.id, { ...p });
  for (const m of delta?.move || []) {
    const existing = byId.get(m.id);
    if (existing) byId.set(m.id, { ...existing, x: m.x, z: m.z });
  }
  for (const id of delta?.remove || []) byId.delete(id);

  return [...byId.values()];
}
