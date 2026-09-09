// Single source of truth for the 2D story-world contract, shared by the generator
// (server/src/narrative/generateStory.js) and the renderer (web/src/stage/).
//
// This is the 2D counterpart to worldState.js. The 3D contract is kept intact next to
// it: the two renderers are an ablation axis, not a migration.
//
// The design principle carried over from the 3D work: there is no enum of settings, no
// enum of object types, no catalogue of art. The model authors its own vocabulary and
// the renderer derives everything from it. What stays fixed here is only what the
// renderer physically cannot infer — where a thing sits on screen and how it is anchored.

// The stage is a wide painted backdrop that the camera pans across, so `x` is a
// normalised position along the FULL backdrop, not along the visible viewport. A player
// at x=0.9 is off-screen until they walk there, which is what makes the place feel
// walked through rather than looked at.
export const STAGE_ASPECT = 2.6; // backdrop width / height
export const VIEW_ASPECT = 16 / 9; // roughly what is visible at once

// Depth is the pseudo-3D ground plane every side-on adventure game uses: 0 is the far
// back of the walkable ground (small, high on screen), 1 is right at the camera (large,
// low). It buys parallax, correct occlusion sorting, and believable scale for free.
export const DEPTH_FAR = 0;
export const DEPTH_NEAR = 1;

// How an actor meets the ground. This is the one thing the renderer cannot work out from
// a description: a lantern hanging from a beam and a crate on the floor have the same
// kind of label and must be placed completely differently.
export const ANCHORS = ["ground", "hanging", "floating", "wall"];

// Screen height for non-ground anchors, as a fraction down the frame.
export const ANCHOR_DEFAULT_Y = {
  ground: 1.0, // unused: ground actors derive y from depth and the horizon
  hanging: 0.18, // suspended from above
  floating: 0.45, // drifting mid-air — spirits, drones, motes of light
  wall: 0.55, // mounted flat against the backdrop
};

// Actors on screen at once. A wide backdrop holds more than a 3D clearing did before it
// reads as cluttered, but past ~10 cut-outs the scene stops being legible and every
// extra one is another slow image generation.
export const MIN_ACTORS = 4;
export const MAX_ACTORS = 9;

export const MIN_CHOICES = 1;
export const MAX_CHOICES = 4;

// How close, in normalised backdrop x, counts as standing "at" something. Generous
// enough not to be a pixel hunt, tight enough that you must actually walk there.
export const REACH = 0.06;

// Ordered beats the player's character performs before control returns.
export const BEAT_TYPES = ["walk_to", "face", "interact", "say", "emote", "wait"];
export const MAX_BEATS = 6;

const HEX = /^#?[0-9a-fA-F]{6}$/;

const ACTOR_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Stable unique identifier, e.g. 'lantern_01'. Reuse the same id across turns " +
        "for the same physical thing so it stays where the player left it.",
    },
    label: {
      type: "string",
      description:
        "What this is, specifically and visually — 'a brass diving helmet, green with " +
        "verdigris', 'Mara Voss, a rope-burned salvage diver in a patched drysuit'. This " +
        "is the description its artwork is painted from, so make it concrete and " +
        "evocative. Anything at all can appear here.",
    },
    detail: {
      type: "string",
      description:
        "One sentence the player reads when they examine this — what they notice up " +
        "close. This is free flavour that costs nothing to show, so make it worth " +
        "finding: a detail that implies history, not a restatement of the label.",
    },
    x: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Position along the full backdrop width. 0 is the far left edge, 1 the far right.",
    },
    depth: {
      type: "number",
      minimum: DEPTH_FAR,
      maximum: DEPTH_NEAR,
      description:
        "Distance from the camera. 0 = far back (drawn small and high), 1 = right at " +
        "the front (large and low). Spread these out: a scene where everything is at the " +
        "same depth looks like a row of stickers.",
    },
    scale: {
      type: "number",
      minimum: 0.25,
      maximum: 3,
      description: "Size multiplier on top of the depth scaling. 1 is roughly person-height.",
    },
    anchor: {
      type: "string",
      enum: ANCHORS,
      description:
        "How it meets the scene: 'ground' stands on the floor (default), 'hanging' is " +
        "suspended from above, 'floating' drifts in mid-air, 'wall' is mounted flat.",
    },
    character: {
      type: "boolean",
      description:
        "True for a person or creature the player can talk to. Name them in the label. " +
        "Characters get a painted portrait for dialogue as well as a full-body figure.",
    },
    facing: {
      type: "string",
      enum: ["left", "right"],
      description: "Which way they look. The artwork is flipped to match.",
    },
  },
  required: ["id", "label", "x", "depth"],
};

const BACKDROP_SCHEMA = {
  type: "object",
  description: "The painted place the scene happens in. Drives the whole look of the screen.",
  properties: {
    description: {
      type: "string",
      description:
        "The setting as a painter would be briefed — 'the flooded nave of a cathedral, " +
        "pews half-submerged, light falling through a shattered rose window'. This is " +
        "the prompt the backdrop illustration is painted from, so be specific and " +
        "visual. It should read as one continuous wide place, not a collage. Describe " +
        "ONLY the empty setting: anything also listed in `actors` is painted separately " +
        "and placed on top, so naming it here paints it twice.",
    },
    mood: {
      type: "string",
      description:
        "The light and weather in a few words — 'cold blue dusk, long shadows', " +
        "'sodium-orange sodden night', 'flat noon glare'.",
    },
    horizon: {
      type: "number",
      minimum: 0.25,
      maximum: 0.85,
      description:
        "Where the WALKABLE GROUND BEGINS, as a fraction down the frame — the far edge " +
        "of the floor, not the sky's horizon. 0.6 is a normal standing eye level; lower " +
        "for a vista, higher for a cramped interior. Actors at depth 0 stand exactly " +
        "here, so it must match the painting you described.",
    },
    palette: {
      type: "object",
      description: "Hex colours pulled from the scene, used to tint UI and lighting.",
      properties: {
        key: { type: "string", description: "The dominant light colour." },
        shadow: { type: "string", description: "The colour in the shadows." },
        accent: { type: "string", description: "The one colour that stands out." },
      },
      required: ["key", "shadow", "accent"],
    },
    atmosphere: {
      type: "string",
      description:
        "Drifting particulate in the air, if any — 'dust motes', 'falling ash', 'fine " +
        "rain', 'drifting spores', 'snow', 'embers', 'none'. Animated over the painting, " +
        "which is most of what stops a still image looking still.",
    },
    atmosphere_intensity: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0 = barely there, 1 = heavy weather.",
    },
  },
  required: ["description", "mood", "horizon", "palette"],
};

const BEATS_SCHEMA = {
  type: "array",
  maxItems: MAX_BEATS,
  description:
    "Ordered actions the player's character performs automatically before control " +
    "returns — this is how the chosen action is acted out on stage rather than only " +
    "described in prose. Reference actors by id.",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: BEAT_TYPES },
      target_id: { type: "string", description: "Actor id to walk to / face / interact with." },
      x: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Walk to this position instead of to an actor.",
      },
      text: { type: "string", description: "Spoken line, for type 'say'." },
      seconds: { type: "number", minimum: 0.2, maximum: 3, description: "For type 'wait'." },
    },
    required: ["type"],
  },
};

const CHOICES_SCHEMA = {
  type: "array",
  description:
    "2-4 actions the player can take next. Omit ONLY on the final turn, when `ending` " +
    "is set and there is nothing left to choose.",
  minItems: MIN_CHOICES,
  maxItems: MAX_CHOICES,
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      // What makes the stage load-bearing instead of decorative: a choice tied to a
      // place can only be taken from there, so walking over is the act of choosing it.
      requires_near: {
        type: "string",
        description:
          "Optional actor id. The player must walk to it before this choice unlocks. " +
          "Use it for anything physical and located — prising open a hatch, reading an " +
          "inscription, speaking to someone across the room. Leave it off for choices " +
          "makeable from anywhere. Aim for about half the choices to be located.",
      },
    },
    required: ["id", "text"],
  },
};

const OBJECTIVE_SCHEMA = {
  type: "string",
  description:
    "The player's concrete goal in one short sentence. Set it on the FIRST turn and " +
    "repeat it verbatim every turn after, unless the story genuinely redefines it.",
};

const PROGRESS_SCHEMA = {
  type: "number",
  minimum: 0,
  maximum: 1,
  description:
    "How close the player is to the objective. Move it when they actually learn or " +
    "achieve something, and not at all when they do not — it is shown on screen, so it " +
    "has to be honest. It is allowed to go down.",
};

const ENDING_SCHEMA = {
  type: "object",
  description:
    "Set ONLY on the turn the story actually ends. Aim to reach an ending in roughly " +
    "8-15 turns rather than drifting on. Omit entirely while the story is still running.",
  properties: {
    outcome: { type: "string", enum: ["victory", "defeat", "bittersweet"] },
    epilogue: { type: "string", description: "2-3 paragraphs closing the story." },
  },
  required: ["outcome", "epilogue"],
};

// Who is talking to the player this beat. When set, their painted portrait is shown
// beside the prose, which is what turns "a character exists in this scene" into "you are
// having a conversation with someone". Portraits are generated for every character
// anyway, so this costs nothing extra to use.
const SPEAKER_SCHEMA = {
  type: "string",
  description:
    "The actor id of whoever is speaking to the player in this beat, if anyone. Their " +
    "portrait is shown next to the text. Set it whenever a character is talking — a " +
    "conversation should look like a conversation. Omit for beats with no speaker.",
};

const STATE_UPDATES_SCHEMA = {
  type: "object",
  description:
    "Tracked stats and flags that changed this turn (resolve, air, coin, an inventory " +
    "array, a relationship). Merged into the running state and shown on screen.",
  additionalProperties: true,
};

// Full-scene tool: used on the opening turn and whenever the story relocates.
export const STORY_TOOL = {
  name: "emit_scene",
  description:
    "Emit the next beat of the illustrated story: prose, the painted scene the player " +
    "stands in, and the choices offered to them.",
  input_schema: {
    type: "object",
    properties: {
      // Deliberately first: the streaming parser reads this key out of the partial tool
      // JSON so prose starts appearing about a second in, instead of after the whole
      // scene has finished generating.
      narrative: {
        type: "string",
        description: "2-4 short paragraphs of second-person prose narrating this beat.",
      },
      scene: {
        type: "object",
        description: "The painted place and everything standing in it.",
        properties: {
          backdrop: BACKDROP_SCHEMA,
          actors: {
            type: "array",
            minItems: MIN_ACTORS,
            maxItems: MAX_ACTORS,
            items: ACTOR_SCHEMA,
          },
          player_x: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Where the player's character is standing when the scene opens.",
          },
        },
        required: ["backdrop", "actors"],
      },
      beats: BEATS_SCHEMA,
      speaker: SPEAKER_SCHEMA,
      choices: CHOICES_SCHEMA,
      objective: OBJECTIVE_SCHEMA,
      progress: PROGRESS_SCHEMA,
      ending: ENDING_SCHEMA,
      state_updates: STATE_UPDATES_SCHEMA,
    },
    // `choices` stays required here even though validation lets an ending turn omit it.
    // Dropping it from this list told the model choices were optional on every turn and
    // it promptly started omitting them mid-story.
    required: ["narrative", "scene", "choices"],
  },
};

// Persistent-world counterpart. Two tools rather than one with mutually-exclusive
// fields: oneOf/anyOf in tool input schemas is unreliable, and forced tool_choice gives
// a clean way to select the mode.
export const STORY_DELTA_TOOL = {
  name: "emit_scene_delta",
  description:
    "Emit the next beat of a PERSISTENT illustrated story. Prefer `scene_delta` so the " +
    "place stays continuous. Use `scene` only when the story moves somewhere new.",
  input_schema: {
    type: "object",
    properties: {
      narrative: {
        type: "string",
        description: "2-4 short paragraphs of second-person prose narrating this beat.",
      },
      scene_delta: {
        type: "object",
        description: "Incremental change to the existing scene. Reference actors by id.",
        properties: {
          add: { type: "array", items: ACTOR_SCHEMA },
          move: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                x: { type: "number", minimum: 0, maximum: 1 },
                depth: { type: "number", minimum: DEPTH_FAR, maximum: DEPTH_NEAR },
              },
              required: ["id", "x"],
            },
          },
          remove: { type: "array", items: { type: "string" } },
          // 2D-native and worth having: an object's art comes from its description, so
          // rewriting the description repaints it. A door becomes a door standing open;
          // a character's coat becomes a bloodied coat. The 3D renderer had no equivalent.
          restyle: {
            type: "array",
            description:
              "Repaint an existing actor because it visibly changed. Give the FULL new " +
              "description, not the difference — 'the iron door, now hanging open on one " +
              "hinge'. Use this sparingly, for changes the player should see.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                detail: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
          light: {
            type: "object",
            description: "Shifts in mood or weather that do not change location.",
            properties: {
              mood: BACKDROP_SCHEMA.properties.mood,
              palette: BACKDROP_SCHEMA.properties.palette,
              atmosphere: BACKDROP_SCHEMA.properties.atmosphere,
              atmosphere_intensity: BACKDROP_SCHEMA.properties.atmosphere_intensity,
            },
          },
        },
      },
      scene: {
        type: "object",
        description: "Full replacement scene. Use ONLY when relocating somewhere new.",
        properties: {
          backdrop: BACKDROP_SCHEMA,
          actors: {
            type: "array",
            minItems: MIN_ACTORS,
            maxItems: MAX_ACTORS,
            items: ACTOR_SCHEMA,
          },
          player_x: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["backdrop", "actors"],
      },
      beats: BEATS_SCHEMA,
      speaker: SPEAKER_SCHEMA,
      choices: CHOICES_SCHEMA,
      objective: OBJECTIVE_SCHEMA,
      progress: PROGRESS_SCHEMA,
      ending: ENDING_SCHEMA,
      state_updates: STATE_UPDATES_SCHEMA,
    },
    required: ["narrative", "choices"],
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Spatial-consistency counters, tallied alongside plain structural validity. These are
// the failure modes that only exist once a world persists across turns: referencing
// something that is not there, minting a duplicate identity, placing something off the
// stage. Linear text generation cannot exhibit them, which is why they are measured.
function emptySpatial() {
  return { danglingRefs: 0, duplicateIds: 0, outOfBounds: 0 };
}

function checkBackdrop(backdrop, violations, path = "scene.backdrop") {
  if (!backdrop || typeof backdrop !== "object") {
    violations.push(`${path} missing/not an object`);
    return;
  }
  if (!backdrop.description?.trim()) violations.push(`${path}.description missing/empty`);
  if (!backdrop.mood?.trim()) violations.push(`${path}.mood missing/empty`);

  const h = backdrop.horizon;
  if (typeof h !== "number" || h < 0.15 || h > 0.95) {
    violations.push(`${path}.horizon '${h}' outside [0.15, 0.95]`);
  }

  const palette = backdrop.palette;
  if (!palette || typeof palette !== "object") {
    violations.push(`${path}.palette missing/not an object`);
  } else {
    for (const key of ["key", "shadow", "accent"]) {
      if (!HEX.test(palette[key] || "")) {
        violations.push(`${path}.palette.${key} '${palette[key]}' is not a hex colour`);
      }
    }
  }
}

function checkActors(actors, violations, spatial, { path = "scene.actors" } = {}) {
  const ids = new Set();
  if (!Array.isArray(actors)) {
    violations.push(`${path} missing/not an array`);
    return ids;
  }
  actors.forEach((a, i) => {
    const at = `${path}[${i}]`;
    if (!a?.id || typeof a.id !== "string") {
      violations.push(`${at}.id missing`);
    } else if (ids.has(a.id)) {
      violations.push(`${at}.id '${a.id}' duplicated`);
      spatial.duplicateIds++;
    } else {
      ids.add(a.id);
    }
    if (!a?.label?.trim()) violations.push(`${at}.label missing/empty`);
    if (typeof a?.x !== "number" || a.x < 0 || a.x > 1) {
      violations.push(`${at}.x '${a?.x}' outside [0, 1]`);
      spatial.outOfBounds++;
    }
    if (typeof a?.depth !== "number" || a.depth < DEPTH_FAR || a.depth > DEPTH_NEAR) {
      violations.push(`${at}.depth '${a?.depth}' outside [${DEPTH_FAR}, ${DEPTH_NEAR}]`);
      spatial.outOfBounds++;
    }
    if (a?.anchor !== undefined && !ANCHORS.includes(a.anchor)) {
      violations.push(`${at}.anchor '${a.anchor}' not in enum`);
    }
    if (a?.facing !== undefined && a.facing !== "left" && a.facing !== "right") {
      violations.push(`${at}.facing '${a.facing}' not 'left' or 'right'`);
    }
  });
  return ids;
}

// `ended` relaxes the requirement: a story that has finished has no next choice, and
// demanding one made generation fail at the exact moment a session reached its climax.
function checkChoices(choices, violations, ended, knownIds, spatial) {
  if (!Array.isArray(choices)) {
    if (!ended) violations.push("choices missing/not an array");
    return;
  }
  if (ended && choices.length === 0) return;
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
    violations.push(`choices.length=${choices.length} outside [${MIN_CHOICES}, ${MAX_CHOICES}]`);
  }
  choices.forEach((c, i) => {
    if (!c?.id || !c?.text) violations.push(`choices[${i}] missing id/text`);
    // A choice gated on an actor that does not exist can never be taken, so it is a
    // dangling reference like any other.
    if (c?.requires_near && knownIds && !knownIds.has(c.requires_near)) {
      violations.push(`choices[${i}] requires_near unknown actor '${c.requires_near}'`);
      if (spatial) spatial.danglingRefs++;
    }
  });
}

// A speaker who is not in the scene is a dangling reference like any other — and a
// visible one, since the renderer would go looking for a portrait that does not exist.
function checkSpeaker(speaker, knownIds, violations, spatial) {
  if (speaker === undefined || speaker === null || speaker === "") return;
  if (typeof speaker !== "string") {
    violations.push(`speaker '${speaker}' is not an actor id`);
    return;
  }
  if (knownIds && !knownIds.has(speaker)) {
    violations.push(`speaker references unknown actor '${speaker}'`);
    spatial.danglingRefs++;
  }
}

function checkBeats(beats, knownIds, violations, spatial) {
  if (beats === undefined) return;
  if (!Array.isArray(beats)) {
    violations.push("beats not an array");
    return;
  }
  if (beats.length > MAX_BEATS) {
    violations.push(`beats.length=${beats.length} exceeds ${MAX_BEATS}`);
  }
  beats.forEach((b, i) => {
    if (!BEAT_TYPES.includes(b?.type)) {
      violations.push(`beats[${i}].type '${b?.type}' not in enum`);
      return;
    }
    const hasX = typeof b.x === "number";
    if (b.target_id && !knownIds.has(b.target_id)) {
      violations.push(`beats[${i}] targets unknown actor '${b.target_id}'`);
      spatial.danglingRefs++;
    }
    if (b.type === "walk_to" && !b.target_id && !hasX) {
      violations.push(`beats[${i}] (walk_to) needs target_id or x`);
    }
    if (b.type === "face" && !b.target_id && !hasX) {
      violations.push(`beats[${i}] (face) needs target_id or x`);
    }
    if (b.type === "interact" && !b.target_id) {
      violations.push(`beats[${i}] (interact) needs target_id`);
    }
    if ((b.type === "say" || b.type === "emote") && !String(b.text || "").trim()) {
      violations.push(`beats[${i}] (${b.type}) needs text`);
    }
  });
}

/** Structural + spatial validation of a full-scene turn. */
export function validateStory(turn) {
  const violations = [];
  const spatial = emptySpatial();
  if (!turn || typeof turn !== "object") {
    return { valid: false, violations: ["turn missing/not an object"], spatial };
  }

  if (typeof turn.narrative !== "string" || !turn.narrative.trim()) {
    violations.push("narrative missing/empty");
  }

  const scene = turn.scene;
  let ids = new Set();
  if (!scene || typeof scene !== "object") {
    violations.push("scene missing/not an object");
  } else {
    checkBackdrop(scene.backdrop, violations);
    if (
      Array.isArray(scene.actors) &&
      (scene.actors.length < MIN_ACTORS || scene.actors.length > MAX_ACTORS)
    ) {
      violations.push(
        `scene.actors.length=${scene.actors.length} outside [${MIN_ACTORS}, ${MAX_ACTORS}]`
      );
    }
    ids = checkActors(scene.actors, violations, spatial);
    if (
      scene.player_x !== undefined &&
      (typeof scene.player_x !== "number" || scene.player_x < 0 || scene.player_x > 1)
    ) {
      violations.push(`scene.player_x '${scene.player_x}' outside [0, 1]`);
      spatial.outOfBounds++;
    }
  }

  checkChoices(turn.choices, violations, Boolean(turn.ending), ids, spatial);
  checkBeats(turn.beats, ids, violations, spatial);
  checkSpeaker(turn.speaker, ids, violations, spatial);

  return { valid: violations.length === 0, violations, spatial };
}

/**
 * Validates a persistent-mode turn against the world as it stood before this turn.
 *
 * @param {object} turn - the emit_scene_delta tool input
 * @param {Set<string>|string[]} knownIds - actor ids existing before this turn
 */
export function validateStoryDelta(turn, knownIds = []) {
  const violations = [];
  const spatial = emptySpatial();
  const known = knownIds instanceof Set ? new Set(knownIds) : new Set(knownIds);

  if (!turn || typeof turn !== "object") {
    return { valid: false, violations: ["turn missing/not an object"], spatial };
  }

  if (typeof turn.narrative !== "string" || !turn.narrative.trim()) {
    violations.push("narrative missing/empty");
  }

  const hasDelta = turn.scene_delta && typeof turn.scene_delta === "object";
  const hasScene = turn.scene && typeof turn.scene === "object";
  let idsAfter;

  if (hasDelta && hasScene) {
    violations.push("scene_delta and scene are mutually exclusive, got both");
  }
  // Neither is valid and common: plenty of beats (reading a letter, a conversation)
  // change nothing physical. Treating that as an error forced the model to invent
  // spurious churn, so "no delta" means "the scene is unchanged".
  if (!hasDelta && !hasScene) {
    idsAfter = new Set(known);
  }

  if (hasScene && !hasDelta) {
    const scene = turn.scene;
    checkBackdrop(scene.backdrop, violations);
    if (
      Array.isArray(scene.actors) &&
      (scene.actors.length < MIN_ACTORS || scene.actors.length > MAX_ACTORS)
    ) {
      violations.push(
        `scene.actors.length=${scene.actors.length} outside [${MIN_ACTORS}, ${MAX_ACTORS}]`
      );
    }
    idsAfter = checkActors(scene.actors, violations, spatial);
  } else if (hasDelta) {
    const d = turn.scene_delta;
    idsAfter = new Set(known);

    if (d.add !== undefined) {
      const added = checkActors(d.add, violations, spatial, { path: "scene_delta.add" });
      for (const id of added) {
        if (idsAfter.has(id)) {
          violations.push(`scene_delta.add re-uses existing actor id '${id}'`);
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
            violations.push(`scene_delta.move[${i}] targets unknown actor '${m?.id}'`);
            spatial.danglingRefs++;
          }
          if (typeof m?.x !== "number" || m.x < 0 || m.x > 1) {
            violations.push(`scene_delta.move[${i}].x outside [0, 1]`);
            spatial.outOfBounds++;
          }
          if (
            m?.depth !== undefined &&
            (typeof m.depth !== "number" || m.depth < DEPTH_FAR || m.depth > DEPTH_NEAR)
          ) {
            violations.push(`scene_delta.move[${i}].depth out of range`);
            spatial.outOfBounds++;
          }
        });
    }

    if (d.restyle !== undefined) {
      if (!Array.isArray(d.restyle)) violations.push("scene_delta.restyle not an array");
      else
        d.restyle.forEach((r, i) => {
          if (!r?.id || !idsAfter.has(r.id)) {
            violations.push(`scene_delta.restyle[${i}] targets unknown actor '${r?.id}'`);
            spatial.danglingRefs++;
          }
          if (!r?.label?.trim()) violations.push(`scene_delta.restyle[${i}].label missing/empty`);
        });
    }

    if (d.remove !== undefined) {
      if (!Array.isArray(d.remove)) violations.push("scene_delta.remove not an array");
      else
        d.remove.forEach((id, i) => {
          if (!idsAfter.has(id)) {
            violations.push(`scene_delta.remove[${i}] targets unknown actor '${id}'`);
            spatial.danglingRefs++;
          }
          idsAfter.delete(id);
        });
    }

    if (d.light) {
      const v = d.light.atmosphere_intensity;
      if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) {
        violations.push(`scene_delta.light.atmosphere_intensity '${v}' outside [0, 1]`);
      }
      if (d.light.palette !== undefined) {
        if (typeof d.light.palette !== "object" || d.light.palette === null) {
          violations.push("scene_delta.light.palette not an object");
        } else {
          for (const [key, value] of Object.entries(d.light.palette)) {
            if (!HEX.test(value || "")) {
              violations.push(`scene_delta.light.palette.${key} '${value}' is not a hex colour`);
            }
          }
        }
      }
    }

    if (idsAfter.size < MIN_ACTORS) {
      violations.push(`scene would have ${idsAfter.size} actors, below minimum ${MIN_ACTORS}`);
    }
    if (idsAfter.size > MAX_ACTORS) {
      violations.push(`scene would have ${idsAfter.size} actors, above maximum ${MAX_ACTORS}`);
    }
  }

  checkChoices(turn.choices, violations, Boolean(turn.ending), idsAfter, spatial);
  checkBeats(turn.beats, idsAfter ?? new Set(), violations, spatial);
  checkSpeaker(turn.speaker, idsAfter ?? new Set(), violations, spatial);

  return { valid: violations.length === 0, violations, spatial };
}

/**
 * Applies a validated delta to an actor array, returning a new array. Pure — the caller
 * owns the registry. Order matters and matches the order validateStoryDelta checks in:
 * add, move, restyle, remove.
 */
export function applyStoryDelta(actors, delta) {
  const byId = new Map((actors || []).map((a) => [a.id, { ...a }]));

  for (const a of delta?.add || []) byId.set(a.id, { ...a });

  for (const m of delta?.move || []) {
    const existing = byId.get(m.id);
    if (existing) {
      byId.set(m.id, {
        ...existing,
        x: m.x,
        depth: m.depth === undefined ? existing.depth : m.depth,
      });
    }
  }

  for (const r of delta?.restyle || []) {
    const existing = byId.get(r.id);
    if (existing) {
      byId.set(r.id, {
        ...existing,
        label: r.label,
        detail: r.detail === undefined ? existing.detail : r.detail,
      });
    }
  }

  for (const id of delta?.remove || []) byId.delete(id);

  return [...byId.values()];
}

/**
 * Where an actor sits on screen, in fractions of the backdrop. Shared by the renderer
 * and by anything that needs to reason about layout without a DOM (tests, tooling).
 *
 * Depth does three things at once, which is what sells the pseudo-3D ground plane:
 * things further back are smaller, sit higher up the frame, and are drawn behind.
 */
export function layoutActor(actor, backdrop) {
  const horizon = typeof backdrop?.horizon === "number" ? backdrop.horizon : 0.6;
  const depth = Math.min(Math.max(actor?.depth ?? 0.5, 0), 1);
  const anchor = ANCHORS.includes(actor?.anchor) ? actor.anchor : "ground";

  // Far things sit right on the horizon; near things sit at the bottom of frame. The
  // curve is deliberately not linear — real ground planes compress toward the horizon.
  const groundY = horizon + (1 - horizon) * Math.pow(depth, 1.35);

  // Scale runs from about a third at the horizon to full size at the front, times the
  // author's own multiplier.
  const depthScale = 0.34 + 0.66 * Math.pow(depth, 1.15);
  const scale = depthScale * (actor?.scale ?? 1);

  const y = anchor === "ground" ? groundY : ANCHOR_DEFAULT_Y[anchor];

  return {
    x: Math.min(Math.max(actor?.x ?? 0.5, 0), 1),
    y,
    scale,
    depth,
    anchor,
    // Painter's algorithm: further back is drawn first. Hanging things sit above
    // everything on the ground so a lantern never disappears behind a crate.
    z: Math.round(depth * 1000) + (anchor === "hanging" ? 1200 : 0),
  };
}

// Roughly how much of the stage's width an actor's artwork covers at a given depth,
// derived from the renderer's own sizing so the two cannot drift apart. Used only to
// decide how far apart things need to stand.
function stageFootprint(actor) {
  const depth = Math.min(Math.max(actor?.depth ?? 0.5, 0), 1);
  const depthScale = 0.34 + 0.66 * Math.pow(depth, 1.15);
  return 0.105 * depthScale * (actor?.scale ?? 1);
}

// Minimum clear space between the centres of two things at similar depth, as a fraction
// of their combined footprint. Below 1 they overlap, which is fine and even desirable
// between layers; this is about the case where several objects land on top of each other.
const SEPARATION = 0.85;

// Actors at genuinely different depths should be allowed to overlap — that is what makes
// the scene read as layered rather than as a row. Only near-coplanar neighbours are
// pushed apart.
const COPLANAR = 0.28;

/**
 * Nudges overlapping actors apart along x.
 *
 * The model is asked to spread things across the stage and mostly does, but it reliably
 * clusters two or three around whatever the scene is "about" — which renders as a pile of
 * cut-outs with the important object hidden behind another. This relaxes the collisions
 * while keeping the authored ordering and staying as close to the authored positions as
 * it can, so it corrects a defect rather than overriding the composition.
 *
 * Pure: returns a new array.
 */
export function spreadActors(actors) {
  if (!Array.isArray(actors) || actors.length < 2) return actors || [];

  const out = actors.map((a) => ({ ...a }));
  // Sorting by x means each pass only has to consider neighbours.
  const order = out
    .map((a, i) => ({ i, x: Number.isFinite(a.x) ? a.x : 0.5 }))
    .sort((p, q) => p.x - q.x);

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;

    for (let k = 0; k < order.length - 1; k++) {
      const a = out[order[k].i];
      const b = out[order[k + 1].i];
      if (Math.abs((a.depth ?? 0.5) - (b.depth ?? 0.5)) > COPLANAR) continue;

      const need = SEPARATION * (stageFootprint(a) + stageFootprint(b)) * 0.5 * 2;
      const gap = (b.x ?? 0.5) - (a.x ?? 0.5);
      if (gap >= need) continue;

      // Split the correction between the pair so neither is dragged far from where it
      // was authored, then re-clamp to the stage.
      const push = (need - gap) / 2;
      a.x = Math.min(Math.max((a.x ?? 0.5) - push, 0.03), 0.97);
      b.x = Math.min(Math.max((b.x ?? 0.5) + push, 0.03), 0.97);
      moved = true;
    }

    if (!moved) break;
    order.sort((p, q) => out[p.i].x - out[q.i].x);
  }

  return out;
}

/**
 * Finds somewhere on the stage the player can stand without being inside anything.
 *
 * The player is drawn at the same scale as whatever they overlap, so a spawn point on top
 * of an actor simply hides them and the scene looks as though it has no protagonist. This
 * checks against the actors' actual drawn footprints rather than the interaction radius,
 * which is much narrower — being close enough to touch something is not the same as
 * standing inside it.
 *
 * @param {Array} actors
 * @param {number} [preferred] - the authored position, kept if it is already clear
 * @param {number} [playerDepth] - the depth the player will be drawn at
 */
export function findClearX(actors, preferred, playerDepth = 0.62) {
  const placed = (actors || []).filter((a) => Number.isFinite(a?.x));
  const self = { depth: playerDepth, scale: 1 };
  const clearOf = (x) =>
    placed.every(
      (a) => Math.abs(x - a.x) >= SEPARATION * (stageFootprint(self) + stageFootprint(a))
    );

  if (Number.isFinite(preferred) && preferred >= 0 && preferred <= 1 && clearOf(preferred)) {
    return preferred;
  }

  // Prefer the middle of the widest gap: it is the most robustly clear spot, and it
  // leaves something worth walking to on both sides.
  const xs = [...new Set(placed.map((a) => a.x))].sort((p, q) => p - q);
  const bounds = [0.04, ...xs, 0.96];
  let best = 0.5;
  let bestGap = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    const gap = bounds[i + 1] - bounds[i];
    if (gap > bestGap) {
      bestGap = gap;
      best = (bounds[i] + bounds[i + 1]) / 2;
    }
  }
  if (clearOf(best)) return Math.min(Math.max(best, 0.04), 0.96);

  // Nowhere is truly clear — a very crowded stage. Take the least bad position rather
  // than returning something arbitrary.
  let bestX = best;
  let bestClearance = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const x = 0.04 + (i / 40) * 0.92;
    const clearance = Math.min(...placed.map((a) => Math.abs(x - a.x)));
    if (clearance > bestClearance) {
      bestClearance = clearance;
      bestX = x;
    }
  }
  return bestX;
}

/** Whether the player standing at `playerX` can reach `actor`. */
export function withinReach(playerX, actor) {
  if (typeof playerX !== "number" || !actor) return false;
  // Reach widens slightly with depth so a large foreground object does not demand more
  // precision than a small distant one.
  const pad = REACH * (0.7 + 0.6 * (actor.depth ?? 0.5));
  return Math.abs(playerX - actor.x) <= pad;
}
