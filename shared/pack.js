// A pack is a game whose WORLD is pre-generated and whose STORY still is not.
//
// The generative path paints a place and a cast from scratch for whatever premise you
// type, which is the research contribution and also a 60-90 second wait before anyone
// sees anything. That wait is fine when you are the one who built it and ruinous when
// you are handing a laptop to someone at a poster session. A pack fixes the expensive
// half — the art direction, the places, the cast and every illustration — and leaves the
// expensive-but-fast half live: the prose, the choices, the consequences, the objective
// and the ending are still written per playthrough, so two people playing the same pack
// do not play the same game.
//
// It is deliberately NOT the template baseline. `server/src/narrative/templateBaseline.js`
// is the ablation arm where the *story* is canned. Here the story is as generated as it
// ever was; only the scenery is bought in advance. Sessions record which of the three
// they were (`worldSource: "generated" | "pack"`, `engine`, and so on) so a pack
// playthrough is never silently mixed into results about the generative path.
//
// The hard requirement a pack exists to meet: every image request a pack game makes must
// hit art that already exists. That cannot rest on the model obediently copying a
// 400-character backdrop brief word for word, because it will paraphrase. So the pack
// pins the strings and `snapToPack` below overwrites whatever the model wrote with the
// pinned version before any art is requested. Prompting asks for compliance; snapping
// guarantees it.

export const PACK_VERSION = 1;

// A pack scene is built from the same primitives as a generated one, so the renderer
// cannot tell the difference and no second code path exists.
export const PACK_PLACEMENT_FIELDS = ["x", "depth", "scale", "anchor", "facing"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isNum(v, lo, hi) {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Checks a pack manifest for the mistakes that would turn a pre-generated game back into
 * a slow one, or break the renderer.
 *
 * Returns an array of human-readable problems; empty means usable. This runs at load
 * time and the server refuses to serve a pack that fails, because the failure mode
 * otherwise is a game that looks fine and quietly generates art for twenty minutes.
 *
 * @param {object} pack
 * @returns {string[]}
 */
export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return ["pack is not an object"];

  if (pack.version !== PACK_VERSION) {
    errors.push(`version must be ${PACK_VERSION}, got ${JSON.stringify(pack.version)}`);
  }
  for (const key of ["id", "title", "blurb", "premise"]) {
    if (!isStr(pack[key])) errors.push(`${key} is required and must be a non-empty string`);
  }
  if (pack.id && !/^[a-z0-9-]+$/.test(pack.id)) {
    // The id becomes a directory name and a URL parameter.
    errors.push(`id "${pack.id}" must be lowercase letters, digits and hyphens only`);
  }

  // The art direction is the whole point of the cache namespace: its id is what every
  // cached image is filed under, so a pack without one would file its art under
  // "nostyle" and collide with every other styleless game.
  if (!pack.bible || typeof pack.bible !== "object") {
    errors.push("bible is required (the pinned art direction)");
  } else {
    if (!isStr(pack.bible.id)) errors.push("bible.id is required — it namespaces the art cache");
    for (const key of ["medium", "palette", "light", "linework", "protagonist"]) {
      if (!isStr(pack.bible[key])) errors.push(`bible.${key} is required`);
    }
  }

  const cast = Array.isArray(pack.cast) ? pack.cast : [];
  if (!cast.length) errors.push("cast must have at least one member");

  const seenCast = new Set();
  for (const a of cast) {
    const where = `cast member ${JSON.stringify(a?.id ?? "?")}`;
    if (!isStr(a?.id)) errors.push(`${where}: id is required`);
    else if (seenCast.has(a.id)) errors.push(`${where}: duplicate id`);
    else seenCast.add(a.id);
    // The label is the image prompt. If it drifts, the art cache misses.
    if (!isStr(a?.label)) errors.push(`${where}: label is required — it is what gets painted`);
    if (a?.x !== undefined && !isNum(a.x, 0, 1)) errors.push(`${where}: x must be 0..1`);
    if (a?.depth !== undefined && !isNum(a.depth, 0, 1)) errors.push(`${where}: depth must be 0..1`);
    if (a?.scale !== undefined && !isNum(a.scale, 0.25, 3)) errors.push(`${where}: scale must be 0.25..3`);
  }

  const places = Array.isArray(pack.places) ? pack.places : [];
  if (!places.length) errors.push("places must have at least one entry");

  const seenPlaces = new Set();
  for (const p of places) {
    const where = `place ${JSON.stringify(p?.id ?? "?")}`;
    if (!isStr(p?.id)) errors.push(`${where}: id is required`);
    else if (seenPlaces.has(p.id)) errors.push(`${where}: duplicate id`);
    else seenPlaces.add(p.id);
    if (!isStr(p?.name)) errors.push(`${where}: name is required`);

    const b = p?.backdrop;
    if (!b || typeof b !== "object") {
      errors.push(`${where}: backdrop is required`);
    } else {
      if (!isStr(b.description)) errors.push(`${where}: backdrop.description is required`);
      if (!isStr(b.mood)) errors.push(`${where}: backdrop.mood is required`);
      if (!isNum(b.horizon, 0.25, 0.85)) errors.push(`${where}: backdrop.horizon must be 0.25..0.85`);
      for (const k of ["key", "shadow", "accent"]) {
        if (!isStr(b.palette?.[k])) errors.push(`${where}: backdrop.palette.${k} is required`);
      }
    }

    // A place whose cast list names someone who does not exist would put a dangling
    // reference into a scene, which is one of the spatial-consistency faults this
    // project measures. Catching it here keeps it out of the data.
    const members = Array.isArray(p?.cast) ? p.cast : [];
    if (!members.length) errors.push(`${where}: cast must list at least one actor id`);
    for (const id of members) {
      if (!seenCast.has(id)) errors.push(`${where}: cast references unknown actor "${id}"`);
    }
  }

  const openingPlace = pack.opening?.place;
  if (!isStr(openingPlace)) errors.push("opening.place is required");
  else if (places.length && !seenPlaces.has(openingPlace)) {
    errors.push(`opening.place "${openingPlace}" is not one of the places`);
  }
  if (pack.opening?.playerX !== undefined && !isNum(pack.opening.playerX, 0, 1)) {
    errors.push("opening.playerX must be 0..1");
  }

  // Stats are pinned so a pack cannot reproduce the two failure modes measured on the
  // generative path: a pressure stat that freezes, and a flood of one-shot flags that
  // pushes the real pressure off the panel.
  const stats = Array.isArray(pack.stats) ? pack.stats : [];
  if (stats.length > 5) errors.push(`at most 5 stats, got ${stats.length}`);
  for (const s of stats) {
    if (!isStr(s?.key)) errors.push("every stat needs a key");
    if (!isStr(s?.initial)) {
      errors.push(`stat ${JSON.stringify(s?.key ?? "?")}: initial must be a readable string, not a number or a fraction`);
    }
  }
  if (stats.length && !stats.some((s) => s?.pressure)) {
    errors.push("exactly one stat must be marked pressure: true — the thing that moves every turn");
  }
  if (stats.filter((s) => s?.pressure).length > 1) {
    errors.push("only one stat may be marked pressure");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Snapping a generated turn onto the pack's pinned world
// ---------------------------------------------------------------------------

const DESC_STOP = new Set([
  "a", "an", "the", "of", "and", "or", "in", "on", "at", "with", "as", "if", "is",
  "its", "it", "that", "this", "to", "by", "from", "for", "like", "into", "over",
]);

function descTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !DESC_STOP.has(t));
}

/**
 * How much two art descriptions overlap, 0..1.
 *
 * Tuned differently from the choice matcher in eval/rubric.mjs, and kept separate from it
 * on purpose: that one compares a dozen words of button text a model read off a
 * screenshot, this one compares paragraph-length painter's briefs where the model has
 * rewritten the connective tissue but kept the nouns. Jaccard over content words is the
 * right shape for the second and too blunt for the first.
 */
export function descriptionSimilarity(a, b) {
  const ta = new Set(descTokens(a));
  const tb = new Set(descTokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

// Below this, a generated description is not a paraphrase of any pinned place — it is a
// place the model invented. Snapping it to the nearest pack entry anyway would drop the
// player somewhere the story did not mean, so the caller is told and keeps the place the
// player was already in.
export const PLACE_MATCH_THRESHOLD = 0.25;

/**
 * Finds which pinned place a generated backdrop is meant to be.
 *
 * Prefers the explicit `place` id, which is what the prompt asks the model to emit and
 * what it usually does; falls back to comparing the description it wrote against the
 * pinned briefs, which covers the case where it ignored the field but did describe one of
 * the real rooms.
 *
 * @returns {{place: object|null, by: "id"|"description"|"none", score: number}}
 */
export function resolvePlace(backdrop, pack, relocateTo = null) {
  const places = pack?.places || [];
  if (!places.length) return { place: null, by: "none", score: 0 };

  // An explicit relocation outranks everything. It has to: on a delta turn the backdrop
  // is carried forward from the previous turn with its place id already stamped on it,
  // so matching on that alone can only ever return the room the player was already in.
  const moved = places.find((p) => p.id === relocateTo);
  if (moved) return { place: moved, by: "relocate", score: 1 };

  const byId = places.find((p) => p.id === backdrop?.place);
  if (byId) return { place: byId, by: "id", score: 1 };

  let best = { place: null, score: 0 };
  for (const p of places) {
    const score = descriptionSimilarity(backdrop?.description, p.backdrop.description);
    if (score > best.score) best = { place: p, score };
  }
  if (best.place && best.score >= PLACE_MATCH_THRESHOLD) {
    return { place: best.place, by: "description", score: best.score };
  }
  return { place: null, by: "none", score: best.score };
}

/**
 * Keeps only the stats a pack declares. Shared by the 2D and 3D snappers, so both
 * renderings of one pack enforce the same stats in the same way.
 *
 * A pack declares its stats exactly as it declares its rooms, and for the same reason:
 * the status panel holds about five, so an invented sixth pushes the one that matters off
 * the screen. Observed on the first pack turn ever generated — the model added an
 * `inferred_preferences` object of abstract fractions alongside the three real stats,
 * which renders as "0.5" and tells a player nothing — and again on the very first 3D turn
 * generated against the same premise. Prompting against it is not sufficient on its own.
 *
 * Returns the input object itself (not a copy) when nothing was dropped, so a caller can
 * tell by identity that there was nothing to change.
 *
 * @returns {{stats: object, dropped: string[]}}
 */
export function filterPackStats(stateUpdates, pack) {
  if (!pack?.stats?.length || !stateUpdates || typeof stateUpdates !== "object") {
    return { stats: stateUpdates, dropped: [] };
  }
  const allowed = new Set(pack.stats.map((s) => s.key));
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(stateUpdates)) {
    if (allowed.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  return { stats: dropped.length ? kept : stateUpdates, dropped };
}

/**
 * Rewrites a generated turn so every string an image is painted from is one the pack has
 * already painted.
 *
 * What is overwritten: the backdrop's description, mood, horizon, palette and atmosphere,
 * and every actor's `label` and `detail`. What is left alone: the prose, the objective,
 * progress, the choices, the beats, the stats, the ending — and each actor's position,
 * depth, scale and facing, because where things stand is part of the story the model is
 * telling, not part of the art that was bought in advance.
 *
 * Actors the model invented that the pack has no art for are dropped rather than
 * rendered as blank placeholders, and the drop is reported so a pack that keeps provoking
 * them can have its prompt fixed.
 *
 * @param {object} turn - a validated turn from the generator
 * @param {object} pack
 * @param {object} [options]
 * @param {string} [options.currentPlaceId] - where the player was before this turn, used
 *   when the model describes a place the pack does not have
 * @returns {{turn: object, placeId: string|null, report: object}}
 */
export function snapToPack(turn, pack, { currentPlaceId = null } = {}) {
  const report = {
    placeResolvedBy: "none",
    placeScore: 0,
    invented: [],
    snappedLabels: 0,
    keptPlace: false,
    addedFromPlace: [],
    droppedStats: [],
  };
  if (!turn?.scene || !pack) return { turn, placeId: currentPlaceId, report };

  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));
  const resolved = resolvePlace(turn.scene.backdrop, pack, turn.relocate_to);
  let place = resolved.place;
  report.placeResolvedBy = resolved.by;
  report.placeScore = Number(resolved.score.toFixed(3));
  // A move to a new room is not the same event as the model inventing actors, and the
  // two must not be reported as one: on a relocation the previous room's cast is
  // supposed to be left behind.
  const relocating = resolved.by === "relocate" && currentPlaceId && place.id !== currentPlaceId;
  report.relocated = Boolean(relocating);

  if (!place) {
    // The model described somewhere that is not in the pack. Keep the player where they
    // were: a pack game that teleports into an unpainted room is worse than one that
    // stays put while the prose talks about moving.
    place = (pack.places || []).find((p) => p.id === currentPlaceId) || (pack.places || [])[0] || null;
    report.keptPlace = true;
  }
  if (!place) return { turn, placeId: null, report };

  const allowed = new Set(place.cast || []);

  const actors = [];
  for (const actor of turn.scene.actors || []) {
    const pinned = castById.get(actor.id);
    if (!pinned || !allowed.has(actor.id)) {
      // Actors left behind in the room the player just walked out of are expected, not
      // a fault; only report the ones the pack has no art for at all.
      if (!relocating || !pinned) report.invented.push(actor.id);
      continue;
    }
    actors.push({
      ...actor,
      // The two fields that drive image generation, taken from the pack verbatim.
      label: pinned.label,
      detail: pinned.detail ?? actor.detail,
      character: pinned.character ?? actor.character,
      // Placement stays the model's, but falls back to the pack's staging when the model
      // left it out.
      x: typeof actor.x === "number" ? actor.x : pinned.x,
      depth: typeof actor.depth === "number" ? actor.depth : pinned.depth,
      scale: typeof actor.scale === "number" ? actor.scale : pinned.scale,
      anchor: actor.anchor ?? pinned.anchor,
      facing: actor.facing ?? pinned.facing,
    });
    report.snappedLabels++;
  }

  // A place the player can walk around in needs enough in it to be a place. If the model
  // dropped most of the room, put the missing fixtures back at their staged positions —
  // the art for them exists either way, and an empty hall is the one thing a
  // pre-generated world has no excuse for.
  // On a relocation the room is brand new and should arrive fully dressed at its staged
  // positions; otherwise just top up a scene the model under-populated.
  const want = relocating ? allowed.size : Math.min(4, allowed.size);
  if (actors.length < want) {
    const have = new Set(actors.map((a) => a.id));
    for (const id of place.cast || []) {
      if (have.size >= want) break;
      if (have.has(id)) continue;
      const pinned = castById.get(id);
      if (!pinned) continue;
      actors.push({ ...pinned });
      have.add(id);
      report.addedFromPlace.push(id);
    }
  }

  const { stats: stateUpdates, dropped } = filterPackStats(turn.state_updates, pack);
  report.droppedStats = dropped;

  const snapped = {
    ...turn,
    ...(stateUpdates === turn.state_updates ? {} : { state_updates: stateUpdates }),
    // The renderer repaints the whole stage behind its curtain when this is set, which
    // is exactly what a change of room needs. Without it the new backdrop would pop in
    // under the old scene's actors.
    ...(relocating ? { relocated: true } : {}),
    scene: {
      ...turn.scene,
      // Every backdrop field comes from the pack, including the palette that tints the
      // UI: a pinned painting with the model's invented colours on top of it looks wrong
      // in a way that is hard to place.
      backdrop: { ...place.backdrop, place: place.id },
      actors,
    },
  };

  // A choice gated on an actor that was just dropped can never be taken. Re-point those
  // at nothing rather than leaving a gate the player can never open.
  const present = new Set(actors.map((a) => a.id));
  if (Array.isArray(snapped.choices)) {
    snapped.choices = snapped.choices.map((c) =>
      c?.requires_near && !present.has(c.requires_near) ? { ...c, requires_near: undefined } : c
    );
  }

  return { turn: snapped, placeId: place.id, report };
}

/**
 * Dresses a relocating delta turn with the new room's cast, before validation sees it.
 *
 * A turn that moves the player legitimately empties the stage: the previous room's
 * fixtures are removed and the new room's have not been added, because the model has
 * been told the new room already exists and does not think it needs to list it. The
 * generic contract check then fails the turn for having fewer than MIN_ACTORS actors and
 * the whole beat is thrown away and retried — which is how a relocation becomes a turn
 * that silently does not happen.
 *
 * Nothing here is invention: every actor added is one the pack already has artwork for,
 * placed where the manifest stages it.
 *
 * @returns {{turn: object, repaired: boolean, placeId: string|null}}
 */
export function repairPackRelocation(turn, pack, currentActors = []) {
  const target = (pack?.places || []).find((p) => p.id === turn?.relocate_to);
  if (!target) return { turn, repaired: false, placeId: null };

  const castById = new Map((pack.cast || []).map((a) => [a.id, a]));
  const arriving = (target.cast || []).map((id) => castById.get(id)).filter(Boolean);
  if (!arriving.length) return { turn, repaired: false, placeId: null };

  const keep = new Set(target.cast || []);
  const onStage = new Set((currentActors || []).map((a) => a.id));
  const leaving = [...onStage].filter((id) => !keep.has(id));

  const delta = turn.scene_delta || {};
  const alreadyAdded = new Set((delta.add || []).map((a) => a.id));

  // Someone who is in both rooms — the Keeper is in all five — is already on stage and
  // stays there, so they must not be added again. This used to re-add them, which the
  // contract rejects as a duplicate id: every move that needed this repair therefore
  // still failed validation, and after three attempts the player was shown a raw
  // "invalid delta" error. A test that checked who was removed, but never ran the real
  // validator on the result, let it through.
  const toAdd = arriving.filter((a) => !alreadyAdded.has(a.id) && !onStage.has(a.id));

  return {
    turn: {
      ...turn,
      scene_delta: {
        ...delta,
        add: [...(delta.add || []), ...toAdd.map((a) => ({ ...a }))],
        remove: [...new Set([...(delta.remove || []), ...leaving])],
      },
    },
    repaired: true,
    placeId: target.id,
  };
}

/**
 * How and when to move between a pack's places — shared word for word by the 2D and 3D
 * briefings. It has now gone wrong in both directions, and the rule has to rule out both:
 *
 *   too late  — the prose walked into the next room but the turn did not say so; the
 *               scenery stayed in the first room for an entire playthrough.
 *   too early — the turn moved the moment the prose *announced* the move ("she beckons you
 *               through"), so the player stood in the new room while the next choices
 *               were still "follow her in" and "glance back at the sentence one last
 *               time". Those choices pointed at the previous room's objects, failed
 *               validation, and put a raw error on screen.
 */
export const RELOCATION_RULES =
  "MOVING BETWEEN PLACES — the one thing it is easiest to get wrong, in either direction. " +
  "Set `relocate_to` on the beat in which the player ARRIVES: this beat's prose ends with " +
  "them already standing in the new place. Writing the move only in the prose changes " +
  "nothing, because the scene on screen carries forward. But do not move them early: if " +
  "this beat ends at the threshold — the Keeper beckoning, a door opening — do NOT set " +
  "`relocate_to`; offer going through as one of the choices, and move them on the beat that " +
  "follows. Whichever room the player stands in at the END of this beat is the only room " +
  "this turn may refer to: every choice, every `requires_near`, every action or beat names " +
  "only that room's objects and people. Never offer \"follow her into the hall\" to someone " +
  "already in the hall, and never point a choice at an object in a room they have left.";

/**
 * The engine-neutral half of a pack's prompt: its fixed stats, its objective, and where
 * the player should be on the route by now. Both the 2D and the 3D prompt append this
 * after their own world briefing, so the two renderings of one pack are told the same
 * story rules in the same words — otherwise a difference in how they play could come
 * from the prompt rather than the renderer, and the engine comparison would mean nothing.
 *
 * @returns {string[]} prompt sections, in order
 */
export function packStoryNotes(pack, { turnIndex, currentPlaceId } = {}) {
  const sections = [];

  if (pack?.stats?.length) {
    const lines = pack.stats.map(
      (s) =>
        `  ${s.key}${s.pressure ? "  [THE PRESSURE — it must move every single turn]" : ""}\n` +
        `    starts at: ${s.initial}\n` +
        (s.note ? `    ${s.note}\n` : "")
    );
    sections.push(
      "TRACKED STATE — these are the only stats this game has. Do not invent others, " +
        "do not rename these, do not drop one. Every value is a short readable phrase a " +
        "player understands at a glance.\n\n" +
        lines.join("")
    );
  }

  if (pack?.objective) {
    sections.push(
      `The objective is fixed for this game and you should keep it essentially intact, ` +
        `rewording only if the player's situation has genuinely changed it:\n"${pack.objective}"`
    );
  }

  // A pack's places are a route, and nothing in the rest of the prompt knows that. Left
  // alone, the model will happily spend a whole playthrough in the first room: measured
  // at eleven of twelve turns in the Tokenizer Yard, which a judge scored 2/5 for pacing
  // and called "a lecture wearing an adventure's clothes". This tracks *place*, which for
  // a pack is the thing that actually has to move.
  const places = pack?.places || [];
  if (places.length > 1 && typeof turnIndex === "number") {
    const target = pack.targetTurns || 14;
    const perPlace = target / places.length;
    const dueIndex = Math.min(Math.floor(turnIndex / perPlace), places.length - 1);
    const due = places[dueIndex];
    const atIndex = places.findIndex((p) => p.id === currentPlaceId);
    const at = atIndex >= 0 ? places[atIndex] : null;

    const line = [
      `ROUTE — this game has ${places.length} places and about ${target} turns, so roughly ` +
        `${perPlace.toFixed(1)} turns each. This is turn ${turnIndex}.`,
    ];
    if (at) line.push(`The player is in ${at.name}.`);
    line.push(`By this turn they should be in ${due.name}.`);

    if (at && atIndex < dueIndex) {
      line.push(
        `THEY ARE ${dueIndex - atIndex} PLACE(S) BEHIND. Move them onward this turn: finish ` +
          "what is happening here in this beat and have them walk through to the next place, " +
          "or make one of the choices the act of leaving. Do not open a new line of enquiry " +
          "in this room. A player who spends the whole game in the first room never finds " +
          "out what the machine does, which is the entire point of playing."
      );
    } else if (at && atIndex > dueIndex) {
      line.push("They are ahead of schedule, which is fine — let this place breathe.");
    } else {
      line.push(
        "They are on schedule. Keep it that way: this place has about " +
          `${Math.max(1, Math.round(perPlace))} turns before they should be moving on.`
      );
    }
    sections.push(line.join(" "));
  }

  return sections;
}

/**
 * The places-and-cast reference that goes into the system prompt, rendered from the pack
 * so the prompt and the manifest cannot drift apart.
 */
export function packBriefing(pack) {
  const lines = [];
  lines.push(`THIS GAME'S WORLD ALREADY EXISTS. ${(pack.places || []).length} places are built and painted, with a fixed cast. You are writing the story that happens in them.`);
  lines.push("");
  lines.push("Set `scene.backdrop.place` to the id of the place the scene is in, and copy that place's `description`, `mood`, `horizon` and `palette` into the backdrop exactly as given. Use ONLY the actor ids listed for that place, with their labels exactly as given. You may move them: x, depth, scale and facing are yours to stage. You may not invent a place, an actor, or a new description — there is no artwork for anything that is not on this list, and inventing one puts a blank shape on screen.");
  lines.push("");
  lines.push(RELOCATION_RULES);
  lines.push("");
  for (const p of pack.places || []) {
    lines.push(`PLACE ${p.id} — ${p.name}`);
    if (p.teaches) lines.push(`  this room is where the player learns: ${p.teaches}`);
    lines.push(`  description: ${p.backdrop.description}`);
    lines.push(`  mood: ${p.backdrop.mood} | horizon: ${p.backdrop.horizon} | palette: ${JSON.stringify(p.backdrop.palette)}` + (p.backdrop.atmosphere ? ` | atmosphere: ${p.backdrop.atmosphere} @ ${p.backdrop.atmosphere_intensity ?? 0.3}` : ""));
    lines.push("  cast:");
    for (const id of p.cast || []) {
      const a = (pack.cast || []).find((c) => c.id === id);
      if (a) lines.push(`    ${a.id}${a.character ? " (a person — can be talked to)" : ""}: ${a.label}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
