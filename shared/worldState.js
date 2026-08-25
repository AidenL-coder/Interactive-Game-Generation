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
    type: { type: "string", enum: PROP_TYPES },
    x: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
    z: { type: "number", minimum: -GROUND_HALF_EXTENT, maximum: GROUND_HALF_EXTENT },
    scale: { type: "number", minimum: 0.3, maximum: 3 },
    label: {
      type: "string",
      description: "Short human-readable description, e.g. 'broken statue'.",
    },
  },
  required: ["id", "type", "x", "z"],
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
          biome: { type: "string", enum: BIOMES },
          mood: { type: "string", enum: MOODS },
          time_of_day: { type: "string", enum: TIMES_OF_DAY },
          props: {
            type: "array",
            minItems: MIN_PROPS,
            maxItems: MAX_PROPS,
            items: PROP_SCHEMA,
          },
        },
        required: ["biome", "mood", "time_of_day", "props"],
      },
      agent_actions: AGENT_ACTIONS_SCHEMA,
      choices: CHOICES_SCHEMA,
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
              mood: { type: "string", enum: MOODS },
              time_of_day: { type: "string", enum: TIMES_OF_DAY },
            },
          },
        },
      },
      scene: {
        type: "object",
        description: "Full replacement scene. Use ONLY when relocating somewhere new.",
        properties: {
          biome: { type: "string", enum: BIOMES },
          mood: { type: "string", enum: MOODS },
          time_of_day: { type: "string", enum: TIMES_OF_DAY },
          props: {
            type: "array",
            minItems: MIN_PROPS,
            maxItems: MAX_PROPS,
            items: PROP_SCHEMA,
          },
        },
        required: ["biome", "mood", "time_of_day", "props"],
      },
      agent_actions: AGENT_ACTIONS_SCHEMA,
      choices: CHOICES_SCHEMA,
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
    if (!PROP_TYPES.includes(p?.type)) violations.push(`${path}[${i}].type '${p?.type}' not in enum`);
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
    if (!BIOMES.includes(scene.biome)) violations.push(`biome '${scene.biome}' not in enum`);
    if (!MOODS.includes(scene.mood)) violations.push(`mood '${scene.mood}' not in enum`);
    if (!TIMES_OF_DAY.includes(scene.time_of_day)) violations.push(`time_of_day '${scene.time_of_day}' not in enum`);

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
    if (!BIOMES.includes(scene.biome)) violations.push(`scene.biome '${scene.biome}' not in enum`);
    if (!MOODS.includes(scene.mood)) violations.push(`scene.mood '${scene.mood}' not in enum`);
    if (!TIMES_OF_DAY.includes(scene.time_of_day)) {
      violations.push(`scene.time_of_day '${scene.time_of_day}' not in enum`);
    }
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
      if (d.ambient.mood !== undefined && !MOODS.includes(d.ambient.mood)) {
        violations.push(`scene_delta.ambient.mood '${d.ambient.mood}' not in enum`);
      }
      if (d.ambient.time_of_day !== undefined && !TIMES_OF_DAY.includes(d.ambient.time_of_day)) {
        violations.push(`scene_delta.ambient.time_of_day '${d.ambient.time_of_day}' not in enum`);
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
