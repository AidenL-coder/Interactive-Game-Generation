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

export function buildSystemPrompt({ profile, sourceText, ablation, lastWorldState, currentProps }) {
  const parts = [];
  const persistent = ablation?.persistence === "persistent";
  const toolName = persistent ? "emit_scene_delta" : "emit_scene";

  parts.push(
    "You are a game-world generation engine. You turn a piece of source narrative " +
      `into a playable world, one beat at a time, by calling the \`${toolName}\` tool. ` +
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

    // Personalization here is otherwise static (stated interests only, never
    // adapting) — docs/research.md flags this as a limitation and points to Wu et
    // al.'s incremental persona-inference as the natural extension. This asks the
    // model to do a lightweight version of that itself each turn: infer *implicit*
    // taste from the choices actually made (not just what the player said up front),
    // and carry a running weight vector forward via the existing free-form
    // `state_updates` field rather than adding new schema/infra.
    if (ablation?.evolving) {
      const inferred = lastWorldState?.state_updates?.inferred_preferences;
      parts.push(
        (inferred && Object.keys(inferred).length
          ? `Running inferred preference weights from prior turns (0-1 each): ${JSON.stringify(inferred)}. ` +
            "Update these based on the choice that was just made, and let them (not just the stated " +
            "interests above) shape what the next scene and choices emphasize."
          : "Also infer *implicit* preferences from the choices the player actually makes as the story " +
            "progresses (e.g. do they gravitate toward combat, dialogue, caution, risk-taking, " +
            "exploration?) — these can diverge from their stated interests, and matter more the longer " +
            "the session runs.") +
          " Report your current best estimate as `state_updates.inferred_preferences`, an object of " +
          "short preference-name -> 0-1 weight pairs. Reuse the same preference names turn to turn " +
          "so they can be tracked as a running estimate, not reset each time."
      );
    }
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

  const trackPreferences = ablation?.personalization && ablation?.evolving;
  parts.push(
    `Scene constraints for \`${toolName}\`:\n` +
      `- biome ∈ {${BIOMES.join(", ")}}, mood ∈ {${MOODS.join(", ")}}, ` +
      `time_of_day ∈ {${TIMES_OF_DAY.join(", ")}}\n` +
      `- props: 5-14 items, each type ∈ {${PROP_TYPES.join(", ")}}, x and z within ` +
      `[-${GROUND_HALF_EXTENT}, ${GROUND_HALF_EXTENT}] (this is the walkable ground ` +
      "plane's half-extent), spaced so the player can walk between them\n" +
      "- every prop needs a stable `id` (e.g. 'altar_01') and a short `label`\n" +
      "- choices: 2-4 concrete, distinct actions the player can take next\n" +
      "- narrative: 2-4 short second-person paragraphs describing the current beat" +
      (trackPreferences
        ? "\n- state_updates.inferred_preferences: REQUIRED every turn (see above) — an object of " +
          "short preference-name -> 0-1 weight pairs, e.g. {\"combat\": 0.7, \"dialogue\": 0.3}. Do not " +
          "omit this field."
        : "")
  );

  // The avatar acts out the chosen action in the world before control returns, so the
  // 3D space is what the action resolves against rather than set dressing behind it.
  parts.push(
    "`agent_actions`: REQUIRED on every turn — an ordered list (1-3 typically, max 6) " +
      "that acts out what the player just chose, performed automatically by their " +
      "avatar before they regain control. Do not omit this field.\n" +
      "Types: `walk_to` (target_id or x/z), `look_at` (target_id or x/z), `interact` " +
      "(target_id required), `say` (text), `wait` (seconds).\n" +
      "Reference props by their id. The prose and the actions must depict the SAME " +
      "events: if the narrative says the player crosses to the altar and touches it, " +
      "emit walk_to then interact targeting that altar. Even a purely conversational " +
      "beat should have the avatar do something — look at the speaker, step closer, say " +
      "a line.\n" +
      "Only ever target props that exist. If the player asks to interact with something " +
      "that isn't in the world, either add it first (it plausibly exists but wasn't " +
      "modelled yet) or narratively redirect them to something that is there — never " +
      "target an id that doesn't exist."
  );

  if (persistent) {
    // Without an explicit inventory the model has to recall ids from conversation
    // history, which is the main source of dangling-reference bugs. Listing them is
    // cheap and removes the guesswork.
    const inventory = (currentProps || [])
      .map((p) => `  ${p.id} (${p.type}) at (${Math.round(p.x)}, ${Math.round(p.z)})${p.label ? ` — ${p.label}` : ""}`)
      .join("\n");

    parts.push(
      "PERSISTENT WORLD MODE. The world continues between turns; it is not rebuilt.\n" +
        (inventory
          ? `Props currently in the world:\n${inventory}\n\n`
          : "The world is currently empty — this is the opening scene.\n\n") +
        "Emit `scene_delta` to mutate this world (add / move / remove props, and " +
        "`ambient` for mood or time-of-day shifts). Only reference ids that exist in " +
        "the list above or that you add in the same turn. Keep the world between 5 and " +
        "14 props.\n" +
        "Emit a full `scene` INSTEAD of `scene_delta` only when the story relocates " +
        "somewhere genuinely new (a different biome/location) — that replaces the world " +
        "wholesale. Never emit both.\n" +
        "If the beat changes nothing physical (reading a letter, a conversation), omit " +
        "`scene_delta` entirely — the world simply carries forward. Do not invent " +
        "changes just to have something to report.\n" +
        "Most turns should be a small delta or none: the world should feel continuous, " +
        "with objects staying where the player left them."
    );
  }

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
