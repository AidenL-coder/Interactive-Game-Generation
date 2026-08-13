import { BIOMES, MOODS, TIMES_OF_DAY, PROP_TYPES, GROUND_HALF_EXTENT } from "iwg-shared";

// Two independent ablation flags, both read from session.ablation:
//   personalization: whether the user profile is injected into the prompt at all
//   evolving:        whether full turn history is passed (handled in generateScene.js,
//                     not here) — this file only needs to know it for the system prompt
//                     framing sentence.

function profileBlock(profile) {
  const interests = (profile?.interests || []).filter(Boolean);
  const lines = [`Name: ${profile?.name || "the player"}`];
  if (interests.length) lines.push(`Interests: ${interests.join(", ")}`);
  if (profile?.preferences) lines.push(`Stated preferences: ${profile.preferences}`);
  return lines.join("\n");
}

export function buildSystemPrompt({ profile, sourceText, ablation }) {
  const parts = [];

  parts.push(
    "You are a game-world generation engine. You turn a piece of source narrative " +
      "into a playable world, one beat at a time, by calling the `emit_scene` tool. " +
      "Never respond in plain prose outside the tool call."
  );

  parts.push(
    "Source material (grounds the setting/genre/tone; do not just summarize it, use " +
      `it as inspiration for an original interactive scenario):\n"""\n${sourceText}\n"""`
  );

  if (ablation?.personalization) {
    parts.push(
      "Personalize the world for this specific player. Weave their stated interests " +
        "into the setting, characters, and choices naturally (do not just namedrop " +
        `them). Player profile:\n${profileBlock(profile)}`
    );
  } else {
    parts.push(
      "Generate for a generic, unspecified protagonist. Do not personalize to any " +
        "individual — this is the non-personalized baseline condition."
    );
  }

  parts.push(
    ablation?.evolving
      ? "This is the EVOLVING condition: you will see the full turn history. Maintain " +
          "continuity — earlier choices, characters, and world state should have " +
          "visible consequences later."
      : "This is the MEMORYLESS baseline condition: you only see a short summary of " +
          "the current state, not the full history. Generate a coherent next beat from " +
          "that summary alone."
  );

  parts.push(
    "Scene constraints for `emit_scene`:\n" +
      `- biome ∈ {${BIOMES.join(", ")}}, mood ∈ {${MOODS.join(", ")}}, ` +
      `time_of_day ∈ {${TIMES_OF_DAY.join(", ")}}\n` +
      `- props: 5-14 items, each type ∈ {${PROP_TYPES.join(", ")}}, x and z within ` +
      `[-${GROUND_HALF_EXTENT}, ${GROUND_HALF_EXTENT}] (this is the walkable ground ` +
      "plane's half-extent), spaced so the player can walk between them\n" +
      "- choices: 2-4 concrete, distinct actions the player can take next\n" +
      "- narrative: 2-4 short second-person paragraphs describing the current beat"
  );

  return parts.join("\n\n");
}

export function firstTurnMessage() {
  return "Begin the story: generate the opening scene.";
}

export function choiceTurnMessage({ choiceText, freeText }) {
  if (freeText && freeText.trim()) {
    return `The player, ignoring the listed choices, instead does/says: "${freeText.trim()}". Continue the story from that.`;
  }
  return `The player chose: "${choiceText}". Continue the story from that choice.`;
}

// Used only in the memoryless (evolving=false) baseline, where we can't send full
// history — we send a compact summary of "where things stand" instead so the model
// still has *something* coherent to generate the next beat from, without giving it
// the actual turn-by-turn memory the evolving condition has access to.
export function summarizeStateForMemorylessTurn(worldState) {
  if (!worldState) return "No prior state — this is the first turn.";
  const { scene, state_updates } = worldState;
  const lines = [
    `Last biome/mood/time: ${scene?.biome}/${scene?.mood}/${scene?.time_of_day}`,
  ];
  if (state_updates && Object.keys(state_updates).length) {
    lines.push(`Tracked state: ${JSON.stringify(state_updates)}`);
  }
  return lines.join("\n");
}
