import { WORLD_STATE_TOOL, validateWorldState } from "iwg-shared";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";
import {
  buildSystemPrompt,
  summarizeStateForMemorylessTurn,
} from "./prompts.js";
import { generateTemplateScene } from "./templateBaseline.js";

// Pulls the emit_scene tool-call input out of an Anthropic response. We force
// tool_choice to this exact tool, so a well-formed response always contains it —
// but "always" per the API contract isn't "always" in practice (rate limits,
// truncation, model refusal), so this throws with a message that's actually useful
// in the eval log rather than a generic destructure crash.
function findToolUse(response) {
  return response.content.find(
    (block) => block.type === "tool_use" && block.name === WORLD_STATE_TOOL.name
  );
}

function extractToolInput(response) {
  const toolUse = findToolUse(response);
  if (!toolUse) {
    throw new Error(
      `No ${WORLD_STATE_TOOL.name} tool_use block in response (stop_reason: ${response.stop_reason})`
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
}) {
  // Non-LLM baseline (docs/research.md "Known gaps"): no model call, no history, just
  // a fixed recipe — the floor the LLM conditions should be compared against.
  if (ablation?.engine === "template") {
    return generateTemplateScene({ profile, ablation, turnMessage, lastWorldState });
  }

  const system = buildSystemPrompt({ profile, sourceText, ablation, lastWorldState });

  const userContent = ablation.evolving
    ? buildEvolvingUserContent(history, turnMessage)
    : `${summarizeStateForMemorylessTurn(lastWorldState)}\n\n${turnMessage}`;

  const messages = ablation.evolving
    ? [...history, { role: "user", content: userContent }]
    : [{ role: "user", content: userContent }];

  const startedAt = Date.now();
  let response, worldState;
  let lastViolations = [];
  let attempts = 0;

  for (; attempts < MAX_GENERATION_ATTEMPTS; attempts++) {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system,
      messages,
      tools: [WORLD_STATE_TOOL],
      tool_choice: { type: "tool", name: WORLD_STATE_TOOL.name },
    });

    const candidate = extractToolInput(response);
    const check = validateWorldState(candidate);
    if (check.valid) {
      worldState = candidate;
      break;
    }
    lastViolations = check.violations;
    console.warn(
      `[generateScene] invalid WorldState on attempt ${attempts + 1}/${MAX_GENERATION_ATTEMPTS}: ${lastViolations.join("; ")}`
    );
  }
  const latencyMs = Date.now() - startedAt;

  if (!worldState) {
    throw new Error(
      `Model returned an invalid WorldState after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastViolations.join("; ")}`
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
  return { worldState, newHistory, usage, latencyMs };
}
