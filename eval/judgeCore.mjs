// Shared logic between eval/judge.mjs (single pair, CLI) and eval/judge-batch.mjs
// (auto-pairs matched sessions and aggregates win rates). Kept separate so neither
// script duplicates the transcript-reconstruction/prompt-building logic.
import { readFile } from "node:fs/promises";

export const JUDGE_TOOL = {
  name: "emit_verdict",
  description: "Emit a structured pairwise verdict comparing two interactive-fiction transcripts.",
  input_schema: {
    type: "object",
    properties: {
      personalization_fit: {
        type: "object",
        description: "Which transcript better reflects the stated player profile/interests.",
        properties: {
          winner: { type: "string", enum: ["A", "B", "tie"] },
          rationale: { type: "string" },
        },
        required: ["winner", "rationale"],
      },
      narrative_coherence: {
        type: "object",
        description: "Which transcript is more internally consistent and well-written turn to turn.",
        properties: {
          winner: { type: "string", enum: ["A", "B", "tie"] },
          rationale: { type: "string" },
        },
        required: ["winner", "rationale"],
      },
      reactivity: {
        type: "object",
        description:
          "Which transcript's world feels like it actually reacted to the player's choices, with " +
          "visible consequences later, rather than choices being cosmetic.",
        properties: {
          winner: { type: "string", enum: ["A", "B", "tie"] },
          rationale: { type: "string" },
        },
        required: ["winner", "rationale"],
      },
      overall: {
        type: "object",
        description: "Overall preference weighing all three criteria.",
        properties: {
          winner: { type: "string", enum: ["A", "B", "tie"] },
          rationale: { type: "string" },
        },
        required: ["winner", "rationale"],
      },
    },
    required: ["personalization_fit", "narrative_coherence", "reactivity", "overall"],
  },
};

export async function loadJudgeRecords(logPath) {
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function buildTranscript(records, sessionId) {
  const turns = records
    .filter((r) => r.sessionId === sessionId && !r.error && r.worldState)
    .sort((a, b) => a.turnIndex - b.turnIndex);
  if (!turns.length) return null;

  const profile = turns[0].profile;
  const ablation = turns[0].ablation;
  const sourceText = turns[0].sourceText;
  const lines = [];
  turns.forEach((r, i) => {
    if (i > 0) lines.push(`[Player action]: ${r.turnMessage}`);
    lines.push(`Turn ${r.turnIndex}: ${r.worldState.narrative}`);
  });
  return { profile, ablation, sourceText, text: lines.join("\n\n") };
}

export function buildJudgePrompt(profile, transcriptA, transcriptB) {
  const profileBlock = profile
    ? `Player profile: name=${profile.name || "unknown"}, interests=${(profile.interests || []).join(", ") || "none"}`
    : "Player profile: unknown";

  return [
    "You are judging two interactive-fiction transcripts, both generated for the same player " +
      "and the same starting premise, but by two different (unlabeled) generation conditions. " +
      "You are NOT told which condition produced which transcript — judge only on the text.",
    profileBlock,
    `=== Transcript A ===\n${transcriptA}`,
    `=== Transcript B ===\n${transcriptB}`,
    "Compare them on: (1) personalization_fit — does the transcript reflect the player's stated " +
      "interests naturally, not just name-dropping; (2) narrative_coherence — internally consistent, " +
      "well-written turn to turn; (3) reactivity — does the world feel like it actually reacted to the " +
      "player's choices, with visible consequences, rather than choices being cosmetic; (4) overall. " +
      "Call emit_verdict with your judgment for all four.",
  ].join("\n\n");
}

/**
 * @returns {Promise<{verdict: object, a: object, b: object}|null>} null if either
 *   session has no successful turns to build a transcript from.
 */
export async function judgeSessions(anthropic, model, records, sessionIdA, sessionIdB) {
  const a = buildTranscript(records, sessionIdA);
  const b = buildTranscript(records, sessionIdB);
  if (!a || !b) return null;

  const sharedProfile = a.profile || b.profile;
  const prompt = buildJudgePrompt(sharedProfile, a.text, b.text);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: JUDGE_TOOL.name },
  });

  const toolUse = response.content.find((blk) => blk.type === "tool_use" && blk.name === JUDGE_TOOL.name);
  if (!toolUse) return null;

  return { verdict: toolUse.input, a, b };
}
