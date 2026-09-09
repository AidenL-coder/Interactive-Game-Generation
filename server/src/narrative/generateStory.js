import {
  STORY_TOOL,
  STORY_DELTA_TOOL,
  validateStory,
  validateStoryDelta,
  applyStoryDelta,
  spreadActors,
  findClearX,
} from "iwg-shared/story2d";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";
import {
  buildSystemPrompt2D,
  summarizeForMemorylessTurn2D,
} from "./prompts2d.js";
import { makeStringStreamer } from "./partialJson.js";

const TOOL_NAMES = new Set([STORY_TOOL.name, STORY_DELTA_TOOL.name]);

function findToolUse(message) {
  return message.content.find((b) => b.type === "tool_use" && TOOL_NAMES.has(b.name));
}

// Forcing tool_choice makes a well-formed reply likely, not guaranteed — rate limits,
// truncation and malformed nesting all happen. Validate and retry with a fresh sample
// before giving up, rather than serving a silently-broken scene.
const MAX_ATTEMPTS = 2;

// Every turn forces a tool_choice, so every assistant message in history ends in a
// tool_use block. The API requires that block be immediately followed by a matching
// tool_result — a bare user-text turn after it is a 400. So the evolving condition's
// user content is a tool_result plus a text block, not just a string.
function buildEvolvingUserContent(history, turnMessage) {
  const last = history[history.length - 1];
  const toolUse = last?.role === "assistant" ? findToolUse({ content: last.content }) : null;
  if (!toolUse) return turnMessage;
  return [
    { type: "tool_result", tool_use_id: toolUse.id, content: "Scene received." },
    { type: "text", text: turnMessage },
  ];
}

// Repair rather than reject. A dangling beat reference makes that one action unplayable,
// but the narrative, scene and choices around it are usually fine — failing the whole
// turn hands the player an error for a cosmetic fault. Drop the offending beats instead.
//
// Spatial counters are recorded BEFORE this runs, so measurement still sees the model's
// unrepaired output; repair changes what the player gets, not what is reported.
function repairBeats(turn, knownIds) {
  if (!Array.isArray(turn.beats)) return { turn, repaired: 0 };
  const known = new Set(knownIds);
  const kept = turn.beats.filter((b) => !b?.target_id || known.has(b.target_id));
  const repaired = turn.beats.length - kept.length;
  if (!repaired) return { turn, repaired: 0 };
  return { turn: { ...turn, beats: kept }, repaired };
}

// The 3D renderer un-gated a choice whenever the model gated all of them, because a
// player standing in the wrong place had no way to act except to wander. The 2D stage
// does not need that: a locked choice names where to go and clicking it walks you there,
// so an all-gated turn is one extra click rather than a dead end — and un-gating meant
// "examine the locker at the far rail" could be done from anywhere, which is worse.

// state_updates is advertised as "merged into the running state" — carry it forward, or
// any stat the model does not restate this turn silently vanishes from the status panel.
// Applied in both memory conditions on purpose: game state is not narrative memory, and
// holding it constant is what isolates the `evolving` variable to story continuity.
function mergeState(previous, incoming) {
  if (!previous && !incoming) return undefined;
  return { ...(previous || {}), ...(incoming || {}) };
}

function actorIdsAfter(turn, currentActors) {
  if (turn.scene?.actors) return turn.scene.actors.map((a) => a.id);
  const ids = new Set(currentActors.map((a) => a.id));
  for (const a of turn.scene_delta?.add || []) ids.add(a.id);
  for (const id of turn.scene_delta?.remove || []) ids.delete(id);
  return [...ids];
}

// Resolves a delta turn into the shape the renderer understands: a full `scene` plus
// the `scene_delta` that produced it. The client needs both — the scene to know what is
// there, the delta to know what to animate rather than snapping into place.
function materializeDeltaTurn(turn, lastState) {
  const prev = lastState?.scene;

  if (turn.scene) {
    return { ...turn, scene_delta: null, relocated: true };
  }

  const delta = turn.scene_delta || {};
  const light = delta.light || {};
  return {
    ...turn,
    scene: {
      backdrop: {
        ...(prev?.backdrop || {}),
        mood: light.mood ?? prev?.backdrop?.mood,
        palette: light.palette
          ? { ...(prev?.backdrop?.palette || {}), ...light.palette }
          : prev?.backdrop?.palette,
        atmosphere: light.atmosphere ?? prev?.backdrop?.atmosphere,
        atmosphere_intensity:
          light.atmosphere_intensity ?? prev?.backdrop?.atmosphere_intensity,
      },
      actors: applyStoryDelta(prev?.actors || [], delta),
      player_x: prev?.player_x,
    },
    scene_delta: turn.scene_delta || null,
    relocated: false,
  };
}

/**
 * Runs one streamed generation attempt.
 *
 * The narrative field is emitted first in both tool schemas, so `onProse` starts firing
 * roughly a second in — long before the scene, choices and beats have been written. That
 * is the whole reason this path streams: the 3D version made the player watch a spinner
 * for the full generation, which was its worst experiential problem.
 */
async function runAttempt({ system, messages, tool, onProse }) {
  const streamer = onProse ? makeStringStreamer("narrative") : null;
  let buffer = "";

  const stream = anthropic.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  });

  if (streamer) {
    stream.on("streamEvent", (event) => {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta" &&
        typeof event.delta.partial_json === "string"
      ) {
        buffer += event.delta.partial_json;
        const delta = streamer(buffer);
        if (delta) {
          // A listener throwing (a disconnected client, say) must not tear down the
          // generation — the turn is still worth finishing and storing.
          try {
            onProse(delta);
          } catch {
            /* client went away */
          }
        }
      }
    });
  }

  return stream.finalMessage();
}

/**
 * Generates the next turn of the 2D story.
 *
 * @param {object} args
 * @param {object} args.profile - { name, interests: string[], preferences? }
 * @param {string} args.sourceText
 * @param {object} args.ablation - { personalization, evolving, persistence }
 * @param {object} args.bible - the session's art direction
 * @param {Array} args.history - prior turns, only sent when ablation.evolving
 * @param {string} args.turnMessage
 * @param {number} args.turnIndex - how many turns have already been taken
 * @param {object|null} args.lastState
 * @param {(delta: string) => void} [args.onProse] - called with narrative text as it
 *   arrives. Only fires on the first attempt; a retry sends `onRestart` first.
 * @param {() => void} [args.onRestart] - the streamed prose was from a turn that failed
 *   validation and is being regenerated; discard what was shown.
 */
export async function generateStory({
  profile,
  sourceText,
  ablation,
  bible,
  history,
  turnMessage,
  lastState,
  turnIndex,
  onProse,
  onRestart,
}) {
  // Persistent mode keeps a live actor registry; the scene mutates rather than being
  // repainted. The opening turn has nothing to mutate, so it always uses the full tool.
  const currentActors = lastState?.scene?.actors || [];
  const usingDelta = ablation?.persistence !== "regenerated" && currentActors.length > 0;
  const tool = usingDelta ? STORY_DELTA_TOOL : STORY_TOOL;

  const system = buildSystemPrompt2D({
    profile,
    sourceText,
    ablation,
    bible,
    lastState,
    currentActors,
    turnIndex,
  });

  const userContent = ablation?.evolving
    ? buildEvolvingUserContent(history, turnMessage)
    : `${summarizeForMemorylessTurn2D(lastState)}\n\n${turnMessage}`;

  const messages = ablation?.evolving
    ? [...history, { role: "user", content: userContent }]
    : [{ role: "user", content: userContent }];

  const startedAt = Date.now();
  let response, state;
  let lastViolations = [];
  let spatial = null;
  let attempts = 0;

  for (; attempts < MAX_ATTEMPTS; attempts++) {
    // Only the first attempt streams. If it failed validation the prose it produced
    // belongs to a discarded turn, so the client is told to clear it rather than
    // having a second turn's text appended to a first turn's.
    if (attempts > 0 && onRestart) {
      try {
        onRestart();
      } catch {
        /* client went away */
      }
    }

    response = await runAttempt({
      system,
      messages,
      tool,
      onProse: attempts === 0 ? onProse : null,
    });

    // Truncation produces a half-written object whose validation errors describe
    // symptoms rather than the cause, so name it explicitly.
    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[generateStory] hit max_tokens on attempt ${attempts + 1} — the tool call was ` +
          "cut off mid-object; raise max_tokens if this recurs"
      );
    }

    const toolUse = findToolUse(response);
    if (!toolUse) {
      lastViolations = [`no scene tool_use block (stop_reason: ${response.stop_reason})`];
      console.warn(`[generateStory] ${lastViolations[0]}`);
      continue;
    }

    const raw = toolUse.input;
    const knownIds = currentActors.map((a) => a.id);
    const validate = (c) => (usingDelta ? validateStoryDelta(c, knownIds) : validateStory(c));

    let check = validate(raw);

    // Spatial counters come from the FIRST attempt, pre-repair: they measure how often
    // the model gets the world right unaided, which is the research question. Reading
    // them off a repaired or retried success would flatter the numbers.
    if (attempts === 0) spatial = check.spatial;

    let candidate = raw;
    if (!check.valid) {
      const { turn: fixed, repaired } = repairBeats(raw, actorIdsAfter(raw, currentActors));
      if (repaired) {
        const recheck = validate(fixed);
        if (recheck.valid) {
          console.warn(`[generateStory] repaired ${repaired} dangling beat(s)`);
          candidate = fixed;
          check = recheck;
        }
      }
    }

    if (check.valid) {
      state = usingDelta ? materializeDeltaTurn(candidate, lastState) : candidate;

      // Relax collisions before anything downstream sees the scene, so the renderer, the
      // reach test and the player's spawn all agree on where things actually are.
      if (state.scene?.actors) state.scene.actors = spreadActors(state.scene.actors);

      state.state_updates = mergeState(lastState?.state_updates, state.state_updates);

      // The objective is the player's whole reason to act, so it cannot be allowed to
      // blink out because one turn forgot to restate it. Progress likewise holds its
      // last value rather than resetting to zero.
      if (!state.objective?.trim() && lastState?.objective) {
        state.objective = lastState.objective;
      }
      if (typeof state.progress !== "number" && typeof lastState?.progress === "number") {
        state.progress = lastState.progress;
      }
      // Carry the player's position forward across turns that do not set one, so the
      // camera does not teleport them back to the start of the stage every beat. On a
      // fresh or relocated scene there is nothing to carry, so pick clear ground.
      if (state.scene) {
        const fresh = state.relocated || !lastState;
        if (fresh) {
          // A spawn point must not be inside something: the player is drawn at the same
          // scale as whatever they overlap, so they vanish behind it and the scene looks
          // as though it has no protagonist at all.
          state.scene.player_x = findClearX(state.scene.actors, state.scene.player_x);
        } else {
          // Mid-story the client is authoritative about where the player is standing, so
          // this only has to avoid contradicting it.
          state.scene.player_x = lastState.scene?.player_x ?? state.scene.player_x;
        }
      }
      break;
    }

    lastViolations = check.violations;
    console.warn(
      `[generateStory] returned keys: ${Object.keys(raw || {}).join(", ") || "(none)"}` +
        ` | stop_reason: ${response.stop_reason} | out tokens: ${response.usage?.output_tokens}`
    );
    console.warn(
      `[generateStory] invalid ${usingDelta ? "delta" : "scene"} on attempt ` +
        `${attempts + 1}/${MAX_ATTEMPTS}: ${lastViolations.join("; ")}`
    );
  }

  const latencyMs = Date.now() - startedAt;

  if (!state) {
    throw new Error(
      `Model returned an invalid ${usingDelta ? "delta" : "scene"} after ${MAX_ATTEMPTS} ` +
        `attempts: ${lastViolations.join("; ")}`
    );
  }

  // Only the evolving condition accumulates history — the memoryless baseline must stay
  // memoryless on every later call, so history is deliberately not appended there.
  const newHistory = ablation?.evolving
    ? [
        ...history,
        { role: "user", content: userContent },
        { role: "assistant", content: response.content },
      ]
    : history;

  const usage = response.usage ? { ...response.usage, attempts: attempts + 1 } : null;
  return { state, newHistory, usage, latencyMs, spatial };
}
