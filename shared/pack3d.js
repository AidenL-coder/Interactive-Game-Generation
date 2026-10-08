// The 3D half of a pack: the same places, cast, stats and premise as the 2D game, built
// as a walkable first-person world instead of a painted stage.
//
// One pack, two renderers, deliberately. The `engine` axis of this project's ablations
// compares the 2D stage against the 3D world, and until now that comparison could only
// be run between two different premises generated two different ways — so any
// difference between them was confounded with everything else that differed. A pack
// fixes the story's premise, its rooms, its people and its stakes, and lets the renderer
// be the only thing that changes. That is the controlled comparison the engine axis was
// always supposed to be.
//
// What a pack adds for 3D, on top of the 2D manifest that shared/pack.js validates:
//
//   places[].environment3d   the ground, sky, light and fog for that room
//   places[].stage3d         where each of the room's cast stands, on the x/z ground plane
//   cast[].form3d            how the object occupies space (decides collision and size)
//
// The label stays shared. It is the one description the 2D painting and the 3D geometry
// are both generated from, which is what makes the two renderings the same object.
//
// Like the 2D snapper, this exists because a pack's promise — nothing is generated while
// someone waits — cannot rest on the model copying a description word for word. The
// 3D assets are keyed by exactly those strings, so every one of them is forced back to
// the manifest before a single asset is requested.

import { descriptionSimilarity, PLACE_MATCH_THRESHOLD, filterPackStats } from "./pack.js";
import { PROP_FORMS, GROUND_HALF_EXTENT, MIN_PROPS, MAX_PROPS } from "./worldState.js";

const HEX = /^#[0-9a-f]{6}$/i;

function isStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isNum(v, lo, hi) {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

// The texture endpoint truncates a label to this many characters before it is used as
// either the prompt or the cache key. A sky brief longer than this is not wrong, but the
// part past the cut is silently never seen by the image model, so it is flagged.
export const SKY_BRIEF_LIMIT = 110;
// The geometry endpoint's own truncation, for the same reason.
export const GEOMETRY_LABEL_LIMIT = 160;

/** Whether a pack carries a 3D world at all. A 2D-only pack is perfectly valid. */
export function hasWorld3d(pack) {
  return Boolean(pack?.places?.length) && pack.places.every((p) => p?.environment3d);
}

/**
 * Checks the 3D half of a pack. Returns human-readable problems; empty means usable.
 * Only meaningful for a pack that claims to have a 3D world — see hasWorld3d.
 */
export function validatePack3d(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return ["pack is not an object"];

  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));

  for (const a of pack.cast || []) {
    const where = `cast member ${JSON.stringify(a?.id ?? "?")}`;
    if (!PROP_FORMS.includes(a?.form3d)) {
      errors.push(`${where}: form3d must be one of ${PROP_FORMS.join(", ")}`);
    }
    if (isStr(a?.label) && a.label.length > GEOMETRY_LABEL_LIMIT) {
      // Past this the geometry endpoint truncates silently, so the object is built from
      // a description that stops mid-sentence.
      errors.push(`${where}: label is ${a.label.length} chars; 3D geometry only reads ${GEOMETRY_LABEL_LIMIT}`);
    }
  }

  for (const p of pack.places || []) {
    const where = `place ${JSON.stringify(p?.id ?? "?")}`;
    const env = p?.environment3d;
    if (!env || typeof env !== "object") {
      errors.push(`${where}: environment3d is required for a 3D world`);
      continue;
    }
    if (!isStr(env.description)) errors.push(`${where}: environment3d.description is required`);
    else if (env.description.length > SKY_BRIEF_LIMIT) {
      errors.push(
        `${where}: environment3d.description is ${env.description.length} chars; the sky ` +
          `texture only reads the first ${SKY_BRIEF_LIMIT}`
      );
    }
    if (!isStr(env.ground_cover)) errors.push(`${where}: environment3d.ground_cover is required`);
    for (const k of ["ground", "fog", "light", "ambient"]) {
      if (!HEX.test(env.palette?.[k] || "")) errors.push(`${where}: environment3d.palette.${k} must be a #rrggbb hex`);
    }
    if (!isNum(env.light_level, 0, 1)) errors.push(`${where}: environment3d.light_level must be 0..1`);
    if (!isNum(env.visibility, 0, 1)) errors.push(`${where}: environment3d.visibility must be 0..1`);

    // The 3D contract refuses a scene with fewer than MIN_PROPS objects, so a room that
    // cannot reach that number from its own cast can never pass validation and would
    // burn every retry on every turn spent in it.
    const members = p.cast || [];
    if (members.length < MIN_PROPS) {
      errors.push(`${where}: has ${members.length} cast; a 3D scene needs at least ${MIN_PROPS}`);
    }
    if (members.length > MAX_PROPS) {
      errors.push(`${where}: has ${members.length} cast; a 3D scene allows at most ${MAX_PROPS}`);
    }

    const stage = p.stage3d || {};
    for (const id of members) {
      const s = stage[id];
      if (!s) {
        errors.push(`${where}: stage3d has no position for "${id}"`);
        continue;
      }
      if (!isNum(s.x, -GROUND_HALF_EXTENT, GROUND_HALF_EXTENT)) errors.push(`${where}: stage3d.${id}.x out of range`);
      if (!isNum(s.z, -GROUND_HALF_EXTENT, GROUND_HALF_EXTENT)) errors.push(`${where}: stage3d.${id}.z out of range`);
      if (s.scale !== undefined && !isNum(s.scale, 0.3, 3)) errors.push(`${where}: stage3d.${id}.scale must be 0.3..3`);
      if (!castById.has(id)) errors.push(`${where}: stage3d references unknown actor "${id}"`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Snapping a generated 3D turn onto the pack
// ---------------------------------------------------------------------------

/**
 * Which pinned place a 3D turn is in. Same precedence as the 2D resolver and for the same
 * reason: an explicit `relocate_to` must outrank the carried-forward environment, or a
 * delta turn can never leave the room it started in — which is precisely the bug that
 * kept the 2D pack in its first room for an entire playthrough.
 */
export function resolvePlace3d(environment, pack, relocateTo = null) {
  const places = pack?.places || [];
  if (!places.length) return { place: null, by: "none", score: 0 };

  const moved = places.find((p) => p.id === relocateTo);
  if (moved) return { place: moved, by: "relocate", score: 1 };

  const byId = places.find((p) => p.id === environment?.place);
  if (byId) return { place: byId, by: "id", score: 1 };

  let best = { place: null, score: 0 };
  for (const p of places) {
    const score = descriptionSimilarity(environment?.description, p.environment3d?.description);
    if (score > best.score) best = { place: p, score };
  }
  if (best.place && best.score >= PLACE_MATCH_THRESHOLD) {
    return { place: best.place, by: "description", score: best.score };
  }
  return { place: null, by: "none", score: best.score };
}

/** A cast member as a 3D prop, staged where the manifest puts it in this room. */
function stagedProp(place, castMember) {
  const s = place.stage3d?.[castMember.id] || {};
  return {
    id: castMember.id,
    label: castMember.label,
    form: castMember.form3d,
    x: s.x ?? 0,
    z: s.z ?? -6,
    ...(s.scale !== undefined ? { scale: s.scale } : {}),
    ...(castMember.character ? { character: true } : {}),
  };
}

/**
 * Rewrites a generated 3D turn so every string an asset is built from is one the pack has
 * already built: the environment (sky, ground, palette, light, fog) and every prop's
 * label, form and character flag. Positions and scale stay the model's — where things
 * stand is part of the story — except on a relocation, where the new room arrives exactly
 * as staged.
 *
 * @returns {{worldState: object, placeId: string|null, report: object}}
 */
export function snapToPack3d(worldState, pack, { currentPlaceId = null } = {}) {
  const report = {
    placeResolvedBy: "none",
    placeScore: 0,
    invented: [],
    snappedLabels: 0,
    keptPlace: false,
    addedFromPlace: [],
    droppedStats: [],
    relocated: false,
  };
  if (!worldState?.scene || !pack) return { worldState, placeId: currentPlaceId, report };

  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));
  const resolved = resolvePlace3d(worldState.scene.environment, pack, worldState.relocate_to);
  let place = resolved.place;
  report.placeResolvedBy = resolved.by;
  report.placeScore = Number(resolved.score.toFixed(3));

  if (!place) {
    place = (pack.places || []).find((p) => p.id === currentPlaceId) || (pack.places || [])[0] || null;
    report.keptPlace = true;
  }
  if (!place) return { worldState, placeId: null, report };

  const relocating = Boolean(currentPlaceId) && place.id !== currentPlaceId;
  report.relocated = relocating;
  const allowed = new Set(place.cast || []);

  const props = [];
  if (!relocating) {
    for (const prop of worldState.scene.props || []) {
      const pinned = castById.get(prop.id);
      if (!pinned || !allowed.has(prop.id)) {
        report.invented.push(prop.id);
        continue;
      }
      props.push({
        ...prop,
        label: pinned.label,
        form: pinned.form3d,
        ...(pinned.character ? { character: true } : { character: undefined }),
      });
      report.snappedLabels++;
    }
  } else {
    // On a move, whatever the model carried forward belongs to the room being left.
    // Report only the props the pack has no art for at all — leaving a room behind is
    // not the model inventing things.
    for (const prop of worldState.scene.props || []) {
      if (!castById.has(prop.id)) report.invented.push(prop.id);
    }
  }

  // A room arrives fully dressed when the player walks into it, and is topped back up to
  // what the 3D contract requires otherwise. Either way only from art that exists.
  const want = relocating ? allowed.size : Math.min(Math.max(MIN_PROPS, props.length), allowed.size);
  const have = new Set(props.map((p) => p.id));
  for (const id of place.cast || []) {
    if (have.size >= want) break;
    if (have.has(id)) continue;
    const pinned = castById.get(id);
    if (!pinned) continue;
    props.push(stagedProp(place, pinned));
    have.add(id);
    report.addedFromPlace.push(id);
  }

  const { stats, dropped } = filterPackStats(worldState.state_updates, pack);
  report.droppedStats = dropped;

  const present = new Set(props.map((p) => p.id));
  const choices = Array.isArray(worldState.choices)
    ? worldState.choices.map((c) =>
        c?.requires_near && !present.has(c.requires_near) ? { ...c, requires_near: undefined } : c
      )
    : worldState.choices;

  // Agent actions that target a prop no longer on stage would walk the avatar to nothing.
  const agentActions = Array.isArray(worldState.agent_actions)
    ? worldState.agent_actions.filter((a) => !a?.target_id || present.has(a.target_id))
    : worldState.agent_actions;

  return {
    worldState: {
      ...worldState,
      ...(stats === worldState.state_updates ? {} : { state_updates: stats }),
      ...(relocating ? { relocated: true, scene_delta: null } : {}),
      choices,
      agent_actions: agentActions,
      scene: {
        ...worldState.scene,
        environment: { ...place.environment3d, place: place.id },
        props,
      },
    },
    placeId: place.id,
    report,
  };
}

/**
 * Dresses a relocating 3D delta turn with the new room's props before validation sees it.
 *
 * A turn that moves the player legitimately removes the old room's objects and does not
 * list the new room's, because it was told the new room already exists. The 3D contract
 * then rejects the turn for having fewer than MIN_PROPS objects and the move is retried
 * away. Rewriting it as a full-scene relocation — the shape the contract already uses for
 * "the player went somewhere new" — is the honest repair, and invents nothing.
 *
 * @returns {{turn: object, repaired: boolean, placeId: string|null}}
 */
export function repairPackRelocation3d(turn, pack) {
  const target = (pack?.places || []).find((p) => p.id === turn?.relocate_to);
  if (!target) return { turn, repaired: false, placeId: null };

  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));
  const props = (target.cast || []).map((id) => castById.get(id)).filter(Boolean).map((a) => stagedProp(target, a));
  if (!props.length) return { turn, repaired: false, placeId: null };

  const { scene_delta: _discarded, ...rest } = turn;
  return {
    turn: {
      ...rest,
      scene: { environment: { ...target.environment3d, place: target.id }, props },
    },
    repaired: true,
    placeId: target.id,
  };
}

/** The places-and-props reference for the 3D system prompt, rendered from the manifest. */
export function packBriefing3d(pack) {
  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));
  const lines = [];
  lines.push(
    `THIS GAME'S WORLD ALREADY EXISTS. ${(pack.places || []).length} places are built, with a fixed set of objects and people in each. You are writing the story that happens in them.`
  );
  lines.push("");
  lines.push(
    "Use ONLY the places and the props listed below. Copy each prop's `label` and `form` exactly as given — they are what its geometry was built from, and a reworded label has no geometry. Copy the place's environment exactly too. You may move props within a room: x, z and scale are yours to stage. You may not invent a place, a prop, or a new description; there is nothing built for anything that is not on this list."
  );
  lines.push("");
  lines.push(
    "MOVING BETWEEN PLACES: when the player walks into a different place you MUST set `relocate_to` to that place's id. Writing the move only in the prose changes nothing — the world on screen carries forward and the player reads about the next room while still standing in the last one. If the prose says they moved, the turn must move them."
  );
  lines.push("");
  for (const p of pack.places || []) {
    const e = p.environment3d || {};
    lines.push(`PLACE ${p.id} — ${p.name}`);
    if (p.teaches) lines.push(`  the player learns here: ${p.teaches}`);
    lines.push(`  environment.description: ${e.description}`);
    lines.push(`  environment.ground_cover: ${e.ground_cover}`);
    lines.push(
      `  palette ${JSON.stringify(e.palette)} | light_level ${e.light_level} | visibility ${e.visibility}` +
        (e.scatter_density !== undefined ? ` | scatter_density ${e.scatter_density}` : "")
    );
    lines.push("  props:");
    for (const id of p.cast || []) {
      const a = castById.get(id);
      const s = p.stage3d?.[id] || {};
      if (a) {
        lines.push(
          `    ${a.id} [${a.form3d}] at x=${s.x} z=${s.z}${s.scale !== undefined ? ` scale=${s.scale}` : ""}` +
            `${a.character ? " (a person — can be talked to)" : ""}: ${a.label}`
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
