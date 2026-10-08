import {
  WORLD_STATE_TOOL,
  WORLD_STATE_DELTA_TOOL,
  validateWorldState,
  validateDeltaTurn,
  applySceneDelta,
} from "iwg-shared";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";
import {
  buildSystemPrompt,
  summarizeStateForMemorylessTurn,
} from "./prompts.js";
import { generateTemplateScene } from "./templateBaseline.js";
import { snapToPack3d, repairPackRelocation3d } from "iwg-shared/pack3d";

// Pulls the emit_scene tool-call input out of an Anthropic response. We force
// tool_choice to this exact tool, so a well-formed response always contains it —
// but "always" per the API contract isn't "always" in practice (rate limits,
// truncation, model refusal), so this throws with a message that's actually useful
// in the eval log rather than a generic destructure crash.
const TOOL_NAMES = new Set([WORLD_STATE_TOOL.name, WORLD_STATE_DELTA_TOOL.name]);

function findToolUse(response) {
  return response.content.find(
    (block) => block.type === "tool_use" && TOOL_NAMES.has(block.name)
  );
}

function extractToolInput(response) {
  const toolUse = findToolUse(response);
  if (!toolUse) {
    throw new Error(
      `No scene tool_use block in response (stop_reason: ${response.stop_reason})`
    );
  }
  return toolUse.input;
}

// Forcing tool_choice makes a well-formed reply *likely*, not guaranteed — seen in
// practice: a response whose tool_use.input had `scene` as a garbled string (stray
// "<parameter name=...>" tag text) with mood/time_of_day/props stranded as top-level
// siblings instead of nested inside it. The renderer's defensive fallbacks mean that
// wouldn't crash, it would just silently draw an empty default scene — worse than an
// explicit failure. So: validate, and retry with a fresh independent sample before
// giving up and surfacing an error the client actually sees.
const MAX_GENERATION_ATTEMPTS = 2;

// Every turn forces a tool_choice, so every assistant message in history ends in a
// tool_use block. The API requires that block be immediately followed by a matching
// tool_result in the very next message — a bare user-text turn after it is a 400. So
// the evolving condition's user content is a tool_result (satisfying that contract)
// plus a text block carrying the actual turn message, not just a string.
function buildEvolvingUserContent(history, turnMessage) {
  const last = history[history.length - 1];
  const toolUse = last?.role === "assistant" ? findToolUse({ content: last.content }) : null;
  if (!toolUse) return turnMessage; // first turn: no prior tool_use to satisfy
  return [
    { type: "tool_result", tool_use_id: toolUse.id, content: "Scene received." },
    { type: "text", text: turnMessage },
  ];
}

// Repair rather than reject. A dangling agent-action reference (the model names a prop
// that doesn't exist) makes that one action unplayable, but the narrative, delta, and
// choices around it are usually fine — failing the whole turn over it hands the player
// a 502 for a cosmetic fault. So drop the offending actions and continue.
//
// The spatial counters are recorded BEFORE this runs, so measurement still sees the
// model's unrepaired output; repair changes what the player gets, not what we report.
// (docs/literature-review.md §4.3 notes G-KMS does normalization-repair where this
// project previously only retried from scratch — this is that, narrowly scoped.)
function repairAgentActions(turn, knownIds) {
  if (!Array.isArray(turn.agent_actions)) return { turn, repaired: 0 };
  const known = new Set(knownIds);
  const kept = turn.agent_actions.filter((a) => !a?.target_id || known.has(a.target_id));
  const repaired = turn.agent_actions.length - kept.length;
  if (!repaired) return { turn, repaired: 0 };
  return { turn: { ...turn, agent_actions: kept }, repaired };
}

// The schema advertises state_updates as "merged into the running world state", but
// nothing merged it: each turn simply replaced the last, so any stat the model didn't
// restate that turn silently vanished from the player's status panel. Carry it forward.
//
// This applies in both memory conditions on purpose. Game state (health, coin) is not
// narrative memory — holding it constant across conditions is what isolates the
// `evolving` variable to story continuity, which is what it's meant to measure.
function mergeState(previous, incoming) {
  if (!previous && !incoming) return undefined;
  return { ...(previous || {}), ...(incoming || {}) };
}

// The prompt asks for roughly half the choices to be tied to a place; in practice the
// model gates all of them. That leaves a player who is standing in the wrong spot with
// nothing they can do but walk, which is herding rather than choosing. Freeing one
// choice guarantees there is always an option available from where they stand.
//
// Repaired rather than rejected: this is a matter of degree, not a malformed turn.
function ensureUngatedChoice(turn) {
  const choices = turn.choices;
  if (!Array.isArray(choices) || choices.length < 2) return turn;
  if (choices.some((c) => !c.requires_near)) return turn;

  // Free the last one — the model tends to order choices by salience, so the earlier
  // ones are the more deliberate hooks.
  const freed = choices.map((c, i) =>
    i === choices.length - 1 ? { ...c, requires_near: undefined } : c
  );
  return { ...turn, choices: freed };
}

function propIdsAfter(turn, currentProps) {
  if (turn.scene?.props) return turn.scene.props.map((p) => p.id);
  const ids = new Set(currentProps.map((p) => p.id));
  for (const p of turn.scene_delta?.add || []) ids.add(p.id);
  for (const id of turn.scene_delta?.remove || []) ids.delete(id);
  return [...ids];
}

// Resolves a delta turn into the same shape the renderer already understands: a full
// `scene`, plus the `scene_delta` that produced it. The client needs both — the full
// scene to know what the world *is*, the delta to know what to animate rather than
// snapping everything into place.
export function materializeDeltaTurn(turn, lastWorldState) {
  const prev = lastWorldState?.scene;

  if (turn.scene) {
    // Relocation: the old world is discarded wholesale, nothing to animate from.
    return { ...turn, scene_delta: null, relocated: true };
  }

  // No delta at all is legal and means "nothing physical changed this turn" — the
  // previous scene carries forward untouched.
  //
  // This used to rebuild the scene as `{ biome, mood, time_of_day, props }` — the shape
  // from before the fixed biome vocabulary was removed — and read `ambient.mood` and
  // `ambient.time_of_day`, which the delta schema no longer has. So every delta turn
  // silently dropped `scene.environment` from the world state, and every lighting or
  // weather shift the model asked for through `ambient` was thrown away. It went
  // unnoticed because the renderer applies a delta without re-reading the environment;
  // anything that did read it afterwards — a relocation's carried state, the log, the
  // pack snapper — got nothing.
  const delta = turn.scene_delta || {};
  const ambient = delta.ambient || {};
  const prevEnv = prev?.environment || {};
  return {
    ...turn,
    scene: {
      environment: {
        ...prevEnv,
        ...(ambient.palette ? { palette: { ...(prevEnv.palette || {}), ...ambient.palette } } : {}),
        ...(typeof ambient.light_level === "number" ? { light_level: ambient.light_level } : {}),
        ...(typeof ambient.visibility === "number" ? { visibility: ambient.visibility } : {}),
      },
      props: applySceneDelta(prev?.props || [], delta),
    },
    scene_delta: turn.scene_delta || null,
    relocated: false,
  };
}

/**
 * Generates the next WorldState turn.
 *
 * @param {object} args
 * @param {object} args.profile - { name, interests: string[], preferences? }
 * @param {string} args.sourceText - seed narrative/subject material
 * @param {object} args.ablation - { personalization: bool, evolving: bool, engine?: 'llm'|'template' }
 * @param {Array<{role: 'user'|'assistant', content: any}>} args.history - prior turns,
 *   only actually sent to the model when ablation.evolving is true
 * @param {string} args.turnMessage - the human-readable text describing this turn's
 *   input (opening prompt, or "the player chose X")
 * @param {object|null} args.lastWorldState - most recent WorldState, used to build a
 *   compact summary when ablation.evolving is false
 * @returns {Promise<{worldState: object, newHistory: Array, usage: object|null, latencyMs: number}>}
 */
export async function generateScene({
  profile,
  sourceText,
  ablation,
  history,
  turnMessage,
  lastWorldState,
  pack = null,
  currentPlaceId = null,
  turnIndex = 0,
}) {
  // Non-LLM baseline (docs/research.md "Known gaps"): no model call, no history, just
  // a fixed recipe — the floor the LLM conditions should be compared against.
  if (ablation?.engine === "template") {
    return generateTemplateScene({ profile, ablation, turnMessage, lastWorldState });
  }

  // Persistent mode keeps a live prop registry across turns; the world mutates rather
  // than being rebuilt. The opening turn has nothing to mutate, so it always uses the
  // full-scene tool regardless of mode.
  const currentProps = lastWorldState?.scene?.props || [];
  const usingDelta = ablation?.persistence === "persistent" && currentProps.length > 0;
  const tool = usingDelta ? WORLD_STATE_DELTA_TOOL : WORLD_STATE_TOOL;

  const system = buildSystemPrompt({
    profile,
    sourceText,
    ablation,
    lastWorldState,
    currentProps,
    pack,
    currentPlaceId,
    turnIndex,
  });

  const userContent = ablation.evolving
    ? buildEvolvingUserContent(history, turnMessage)
    : `${summarizeStateForMemorylessTurn(lastWorldState)}\n\n${turnMessage}`;

  const messages = ablation.evolving
    ? [...history, { role: "user", content: userContent }]
    : [{ role: "user", content: userContent }];

  const startedAt = Date.now();
  let response, worldState;
  let lastViolations = [];
  let spatial = null;
  let attempts = 0;
  // Pack games also report which pinned place the turn resolved to and what had to be
  // corrected to keep it there.
  let placeId = currentPlaceId;
  let snapReport = null;

  for (; attempts < MAX_GENERATION_ATTEMPTS; attempts++) {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      // The authored-environment schema is far larger than the old enum one: a palette,
      // descriptions, and up to 14 props each carrying a full sentence of label. At 2048
      // the tool call was being truncated mid-object, which surfaced as the baffling
      // "scene missing/not an object" rather than as an obvious truncation error.
      max_tokens: 8000,
      system,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    });

    // Truncation produces a half-written object whose validation errors describe
    // symptoms rather than the cause, so name it explicitly.
    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[generateScene] response hit max_tokens on attempt ${attempts + 1} — the tool ` +
          "call was cut off mid-object; raise max_tokens if this recurs"
      );
    }

    const rawCandidate = extractToolInput(response);
    const knownIds = currentProps.map((p) => p.id);
    const validate = (c) =>
      usingDelta ? validateDeltaTurn(c, knownIds) : validateWorldState(c);

    let check = validate(rawCandidate);

    // Spatial counters are recorded from the FIRST attempt, pre-repair: they measure how
    // often the model gets the world right unaided, which is the research question.
    // Reading them off a repaired or post-retry success would flatter the numbers.
    if (attempts === 0) spatial = check.spatial;

    // Salvage an otherwise-good turn whose only fault is unplayable action targets.
    let candidate = rawCandidate;

    // A pack relocation first, because it is the one "invalid" turn that is actually
    // correct: the model empties the room to walk out of it and does not re-list the
    // room it walks into, having been told that room already exists. The 3D contract
    // then fails it for too few props and the move is retried away. Rewriting it as a
    // full-scene relocation — the contract's own shape for "somewhere new" — makes it
    // valid without inventing anything.
    if (!check.valid && pack && rawCandidate?.relocate_to) {
      const reloc = repairPackRelocation3d(rawCandidate, pack);
      if (reloc.repaired) {
        const recheck = validate(reloc.turn);
        if (recheck.valid) {
          console.warn(`[generateScene] pack: built ${reloc.placeId} from the manifest for the move`);
          candidate = reloc.turn;
          check = recheck;
        }
      }
    }

    if (!check.valid) {
      const { turn: fixed, repaired } = repairAgentActions(
        rawCandidate,
        propIdsAfter(rawCandidate, currentProps)
      );
      if (repaired) {
        const recheck = validate(fixed);
        if (recheck.valid) {
          console.warn(`[generateScene] repaired ${repaired} dangling agent action(s)`);
          candidate = fixed;
          check = recheck;
        }
      }
    }

    if (check.valid) {
      worldState = usingDelta ? materializeDeltaTurn(candidate, lastWorldState) : candidate;

      // In a pack game every string an asset is built from — the environment's sky and
      // ground briefs, each prop's label and form — is forced back to the manifest here,
      // before the client sees the scene and therefore before it can ask for geometry or
      // a texture that was never built. The prose, choices, actions and stats beyond the
      // declared ones are the model's.
      if (pack) {
        const snap = snapToPack3d(worldState, pack, { currentPlaceId });
        worldState = snap.worldState;
        placeId = snap.placeId;
        snapReport = snap.report;
        if (snap.report.invented.length) {
          console.warn(`[generateScene] pack: dropped ${snap.report.invented.length} prop(s) with no assets (${snap.report.invented.join(", ")})`);
        }
        if (snap.report.relocated) console.log(`[generateScene] pack: moved to ${snap.placeId}`);
      }

      worldState = ensureUngatedChoice(worldState);
      worldState.state_updates = mergeState(
        lastWorldState?.state_updates,
        worldState.state_updates
      );

      // The objective is the player's whole reason to act, so it can't be allowed to
      // blink out because one turn forgot to restate it. Progress likewise holds its
      // last value rather than resetting to zero.
      if (!worldState.objective?.trim() && lastWorldState?.objective) {
        worldState.objective = lastWorldState.objective;
      }
      if (typeof worldState.progress !== "number" && typeof lastWorldState?.progress === "number") {
        worldState.progress = lastWorldState.progress;
      }
      break;
    }
    lastViolations = check.violations;
    // "scene missing" describes a symptom, not a cause. Dump the shape of what actually
    // came back so the real fault is visible instead of inferred.
    console.warn(
      `[generateScene] returned keys: ${Object.keys(rawCandidate || {}).join(", ") || "(none)"}` +
        ` | stop_reason: ${response.stop_reason}` +
        ` | output tokens: ${response.usage?.output_tokens}`
    );
    console.warn(
      `[generateScene] invalid ${usingDelta ? "delta" : "WorldState"} on attempt ` +
        `${attempts + 1}/${MAX_GENERATION_ATTEMPTS}: ${lastViolations.join("; ")}`
    );
  }
  const latencyMs = Date.now() - startedAt;

  if (!worldState) {
    throw new Error(
      `Model returned an invalid ${usingDelta ? "delta" : "WorldState"} after ` +
        `${MAX_GENERATION_ATTEMPTS} attempts: ${lastViolations.join("; ")}`
    );
  }

  // Only the evolving condition accumulates history — the memoryless baseline must
  // stay memoryless on every subsequent call, so we deliberately do not append there.
  const newHistory = ablation.evolving
    ? [
        ...history,
        { role: "user", content: userContent },
        { role: "assistant", content: response.content },
      ]
    : history;

  const usage = response.usage ? { ...response.usage, attempts: attempts + 1 } : null;
  return { worldState, newHistory, usage, latencyMs, spatial, placeId, snapReport };
}
