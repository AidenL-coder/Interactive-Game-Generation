import { WORLD_STATE_TOOL } from "iwg-shared";
import { anthropic, CLAUDE_MODEL } from "../anthropic.js";
import {
  buildSystemPrompt,
  summarizeStateForMemorylessTurn,
} from "./prompts.js";

// Pulls the emit_scene tool-call input out of an Anthropic response. We force
// tool_choice to this exact tool, so a well-formed response always contains it —
// but "always" per the API contract isn't "always" in practice (rate limits,
// truncation, model refusal), so this throws with a message that's actually useful
// in the eval log rather than a generic destructure crash.
function extractToolInput(response) {
  const toolUse = response.content.find(
    (block) => block.type === "tool_use" && block.name === WORLD_STATE_TOOL.name
  );
  if (!toolUse) {
    throw new Error(
      `No ${WORLD_STATE_TOOL.name} tool_use block in response (stop_reason: ${response.stop_reason})`
    );
  }
  return toolUse.input;
}

/**
 * Generates the next WorldState turn.
 *
 * @param {object} args
 * @param {object} args.profile - { name, interests: string[], preferences? }
 * @param {string} args.sourceText - seed narrative/subject material
 * @param {object} args.ablation - { personalization: bool, evolving: bool }
 * @param {Array<{role: 'user'|'assistant', content: any}>} args.history - prior turns,
 *   only actually sent to the model when ablation.evolving is true
 * @param {string} args.turnMessage - the human-readable text describing this turn's
 *   input (opening prompt, or "the player chose X")
 * @param {object|null} args.lastWorldState - most recent WorldState, used to build a
 *   compact summary when ablation.evolving is false
 * @returns {Promise<{worldState: object, newHistory: Array, usage: object, latencyMs: number}>}
 */
export async function generateScene({
  profile,
  sourceText,
  ablation,
  history,
  turnMessage,
  lastWorldState,
}) {
  const system = buildSystemPrompt({ profile, sourceText, ablation });

  const userContent = ablation.evolving
    ? turnMessage
    : `${summarizeStateForMemorylessTurn(lastWorldState)}\n\n${turnMessage}`;

  const messages = ablation.evolving
    ? [...history, { role: "user", content: userContent }]
    : [{ role: "user", content: userContent }];

  const startedAt = Date.now();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system,
    messages,
    tools: [WORLD_STATE_TOOL],
    tool_choice: { type: "tool", name: WORLD_STATE_TOOL.name },
  });
  const latencyMs = Date.now() - startedAt;

  const worldState = extractToolInput(response);

  // Only the evolving condition accumulates history — the memoryless baseline must
  // stay memoryless on every subsequent call, so we deliberately do not append there.
  const newHistory = ablation.evolving
    ? [
        ...history,
        { role: "user", content: userContent },
        { role: "assistant", content: response.content },
      ]
    : history;

  return { worldState, newHistory, usage: response.usage, latencyMs };
}
