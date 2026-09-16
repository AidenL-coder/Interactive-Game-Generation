import { MIN_ACTORS, MAX_ACTORS, ANCHORS } from "iwg-shared/story2d";

// System prompt for the 2D illustrated adventure. Two independent ablation flags are
// read from session.ablation:
//   personalization: whether the player profile is injected at all
//   evolving:        whether full turn history is passed (handled in generateStory.js;
//                    this file only needs it for the framing sentence)

function profileBlock(profile) {
  const interests = (profile?.interests || []).filter(Boolean);
  const lines = [`Name: ${profile?.name || "the player"}`];
  if (interests.length) lines.push(`Interests: ${interests.join(", ")}`);
  if (profile?.preferences) lines.push(`Stated preferences: ${profile.preferences}`);
  return lines.join("\n");
}

// Where a story should be by a given turn. The model was never told what turn it was on,
// so it paced by feel and a session could still be opening threads at turn fourteen. Two
// numbers — where you are and where you should be — are enough to fix that without
// railroading the story.
const TARGET_LENGTH = 12;

function pacingNote(turnIndex, progress) {
  const turn = (turnIndex ?? 0) + 1;
  const expected = Math.min(0.95, turn / TARGET_LENGTH);
  const lines = [
    `PACING. This is turn ${turn}. A whole story here runs about ${TARGET_LENGTH} turns, ` +
      `so by now progress should be somewhere near ${expected.toFixed(2)}.`,
  ];

  if (typeof progress === "number" && progress < expected - 0.15) {
    lines.push(
      `Progress is ${progress.toFixed(2)} and running behind. Stop widening the story — ` +
        "open no new threads, introduce no new mysteries, and make this beat move the " +
        "player materially closer to the objective."
    );
  }
  if (turn >= TARGET_LENGTH - 2) {
    lines.push(
      "You are at the end of the story's natural length. Drive to the climax now and set " +
        "`ending` within the next turn or two. Tie off what you opened; do not start " +
        "anything you cannot finish. An ending that arrives is worth far more than a " +
        "thread that resolves perfectly and never gets there."
    );
  }
  if (turn >= TARGET_LENGTH + 3) {
    lines.push("END IT THIS TURN. Set `ending` with an outcome and an epilogue.");
  }
  return lines.join(" ");
}

export function buildSystemPrompt2D({
  profile,
  sourceText,
  ablation,
  bible,
  lastState,
  prevStats,
  currentActors,
  turnIndex,
}) {
  const parts = [];
  const persistent = ablation?.persistence !== "regenerated";
  const toolName = persistent && (currentActors?.length || 0) > 0 ? "emit_scene_delta" : "emit_scene";

  parts.push(
    "You are the engine of an illustrated side-on adventure game. You turn source " +
      `narrative into a playable, painted world one beat at a time by calling \`${toolName}\`. ` +
      "Never respond in prose outside the tool call."
  );

  parts.push(
    "Source material — this grounds the setting, genre and tone. Do not summarise it; " +
      `use it as the seed for an original playable scenario:\n"""\n${sourceText}\n"""`
  );

  // The art direction was decided before any of this and every picture in the game is
  // painted to it. Telling the writer what the game looks like keeps the prose and the
  // pictures describing the same object.
  if (bible) {
    parts.push(
      `THIS GAME'S LOOK, already fixed and applied to every illustration:\n` +
        `- Title: ${bible.title}\n` +
        `- Medium: ${bible.medium}\n` +
        `- Palette: ${bible.palette}\n` +
        `- Light: ${bible.light}\n` +
        `- The player character is drawn as: ${bible.protagonist}\n` +
        "Write scenes that suit this look and stay inside this palette. When you describe " +
        "an object, you are writing the brief its picture is painted from."
    );
  }

  if (ablation?.personalization) {
    parts.push(
      "Personalize the world for this specific player. Weave their stated interests " +
        "into the setting, characters and choices naturally — do not just namedrop " +
        `them. Player profile:\n${profileBlock(profile)}`
    );

    // Personalization is otherwise static (stated interests only, never adapting);
    // docs/research.md flags this as a limitation and points to Wu et al.'s incremental
    // persona inference as the natural extension. This is a lightweight version of that,
    // carried in the existing free-form state_updates rather than new schema.
    if (ablation?.evolving) {
      const inferred = lastState?.state_updates?.inferred_preferences;
      parts.push(
        (inferred && Object.keys(inferred).length
          ? `Running inferred preference weights from prior turns (0-1 each): ${JSON.stringify(inferred)}. ` +
            "Update these from the choice just made, and let them — not only the stated " +
            "interests — shape what the next scene emphasises."
          : "Also infer IMPLICIT preferences from the choices the player actually makes " +
            "(caution vs risk, talking vs acting, exploring vs pressing on). These can " +
            "diverge from stated interests and matter more the longer the session runs.") +
          " Report your current estimate as `state_updates.inferred_preferences`, an object " +
          "of short preference-name -> 0-1 weight pairs. Reuse the same names every turn so " +
          "they read as a running estimate rather than a fresh guess."
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
      ? "This is the EVOLVING condition: you see the full turn history. Maintain " +
          "continuity — earlier choices, characters and world state must have visible " +
          "consequences later."
      : "This is the MEMORYLESS baseline: you see only a short summary of the current " +
          "state, not the history. Generate a coherent next beat from that alone."
  );

  // ---- The stage -----------------------------------------------------------
  parts.push(
    "THE STAGE. This is a side-on game. There is one wide painted backdrop, and the " +
      "camera pans across it as the player walks left and right. Everything is placed on " +
      "that backdrop with two numbers:\n" +
      "- `x` (0 to 1) — position along the FULL backdrop, which is about three screens " +
      "wide. 0 is the far left edge, 1 the far right. The player can only see about a " +
      "third of it at once, so things at 0.1 and 0.9 are genuinely far apart and walking " +
      "between them takes real time.\n" +
      "- `depth` (0 to 1) — 0 is the far background (drawn small and high in frame), 1 is " +
      "right at the camera (large and low). This is what gives the scene layers.\n" +
      "\n" +
      "USE THE WHOLE STAGE. Spread actors from about 0.05 to about 0.95 and vary their " +
      "depth. A scene where everything sits between 0.4 and 0.6 at depth 0.5 is a row of " +
      "stickers, not a place. Put something worth walking to at each end.\n" +
      `- \`anchor\` ∈ {${ANCHORS.join(", ")}} — 'ground' (default) stands on the floor, ` +
      "'hanging' is suspended from above, 'floating' drifts in mid-air, 'wall' is mounted " +
      "flat. Use hanging and wall: lanterns, signs, chains, banners and mounted things " +
      "fill the upper frame, which is otherwise dead space.\n" +
      "- `scale` — a multiplier. 1 is roughly person-height. A cathedral door is 2.5; a " +
      "dropped key is 0.3."
  );

  parts.push(
    "BACKDROP. `scene.backdrop.description` is the brief a painter works from, so write " +
      "it as one: what the place is, what it is built or grown out of, what the light is " +
      "doing, what is visible in the distance. It must read as ONE continuous wide place.\n" +
      "CRITICAL: the backdrop is the EMPTY SET. Everything in `actors` is painted " +
      "separately and stood on top of it, so anything you name in both appears TWICE — a " +
      "second winch painted into the deck beside the real one. Describe only what stays " +
      "put: ground, walls, sky, water, architecture, horizon, weather. No people, no " +
      "creatures, and none of the objects you are about to list as actors. If the winch " +
      "is an actor, the backdrop is a bare deck.\n" +
      "- `horizon` (0.25-0.85) is where the WALKABLE GROUND BEGINS — the far edge of the " +
      "floor the player walks on, not the sky's horizon line. Actors at depth 0 are stood " +
      "exactly there. About 0.6 for standing at ground level, lower for a vista from " +
      "height, higher for a cramped interior.\n" +
      "- `mood`, `palette` (real hex colours drawn from this scene) and `atmosphere` " +
      "('dust motes', 'falling ash', 'fine rain', 'drifting spores', 'embers', 'none') " +
      "with `atmosphere_intensity` 0-1. The atmosphere is animated over the painting and " +
      "is most of what stops a still image from looking still — use it whenever the air " +
      "would plausibly carry anything."
  );

  parts.push(
    `ACTORS: ${MIN_ACTORS}-${MAX_ACTORS} of them. Each needs:\n` +
      "- `id`: stable, e.g. 'winch_01'. The SAME id means the same physical thing across " +
      "every turn.\n" +
      "- `label`: what it is, specifically and visually. This is the description its " +
      "picture is painted from, so it must be a thing you can paint — 'a brass diving " +
      "helmet, green with verdigris, one port cracked' rather than 'diving equipment'.\n" +
      "- `detail`: ONE sentence the player gets when they examine it up close. This is " +
      "free — it costs no image and no extra turn — so make it earn its place: a detail " +
      "that implies history or hints at something, never a restatement of the label. This " +
      "is where a lot of the pleasure of exploring lives.\n" +
      "- `character: true` for anyone the player can talk to, named in the label. Give " +
      "them a face and a bearing, not a job title: 'Mara Voss, a rope-burned salvage diver " +
      "with a jaw set against bad news'. At least one character in nearly every scene — " +
      "a place with nobody in it is much less interesting to walk into.\n" +
      "- `facing`: 'left' or 'right', so people look toward what matters."
  );

  // ---- The game ------------------------------------------------------------
  parts.push(
    "THIS IS A GAME, NOT AN ENDLESS STORY. Give the player something to achieve and let " +
      "them succeed or fail at it.\n" +
      "- `objective`: on the FIRST turn, one concrete sentence — something achievable, " +
      "with a reason it is urgent. Repeat it VERBATIM every turn after so it stays stable " +
      "on screen.\n" +
      "- `progress`: 0 to 1, how close they are. Move it when they actually learn or " +
      "achieve something; leave it alone when they don't. It is displayed, so it must be " +
      "honest — a wasted turn shows as a wasted turn, and a bad decision may move it DOWN.\n" +
      "- Choices must MATTER. Some advance the objective; some cost something real (time, " +
      "trust, a resource, safety); it must be possible to make things worse. A choice with " +
      "no downside is not a choice.\n" +
      "- Escalate. Raise the pressure as progress rises. Do not wander scene to scene.\n" +
      "- `ending`: when the objective is achieved or definitively lost, set outcome and a " +
      "closing epilogue. Aim to reach an ending in 8-15 turns. A story that cannot end is " +
      "not a game.\n" +
      "- Failure is allowed and is what makes success mean anything. If they have " +
      "squandered their chances, let them lose.\n" +
      // Observed across playthroughs: the tense sessions were the ones that happened to
      // grow a clock — a signal box counting toward 11:40, forty minutes left on a shift.
      // The slack ones had stats that never bit, so examining everything and talking to
      // everyone forever was strictly optimal and nothing the player did carried a cost.
      // Requiring one stat to move against them every turn is what turns a set of things
      // to read into a situation to get out of.
      "- PRESSURE: exactly one of your `state_updates` is a force working against the " +
      "player, and it moves EVERY SINGLE TURN whether or not they chose well — a clock " +
      "running down, air or fuel draining, a tide coming in, suspicion rising, someone " +
      "getting closer, a storm arriving. Give it a plain name AND a value a player can " +
      "read at a glance with no legend: a clock time ('3:14 am'), a countdown ('40 min', " +
      "'2 reels left'), or a short phrase ('rising fast'). Never an abstract fraction — " +
      "'time to dawn: 0.70' is displayed verbatim on screen and means nothing to anyone " +
      "reading it. Move it every turn without exception, and say in the prose " +
      "when the player can feel it. When it runs out the story ends on it, whatever the " +
      "progress bar says. This is what makes spending a turn cost something."
  );

  parts.push(pacingNote(turnIndex, lastState?.progress));

  // A standing instruction to move the pressure every turn holds about half the time —
  // measured across logged sessions, four of eight had a stat that actually moved on every
  // turn, and one declared a clock and then froze it for thirteen turns running. Naming
  // the specific stat that just failed to move is much harder to skim past than a rule
  // stated once at the top of a long prompt.
  const stalled = [];
  if (prevStats && lastState?.state_updates) {
    for (const [name, value] of Object.entries(lastState.state_updates)) {
      if (name === "inferred_preferences") continue;
      if (!(name in prevStats)) continue;
      if (JSON.stringify(prevStats[name]) === JSON.stringify(value)) stalled.push(name);
    }
  }
  if (stalled.length) {
    parts.push(
      `THESE DID NOT MOVE LAST TURN: ${stalled.join(", ")}. If one of them is your ` +
        "pressure, move it this turn — a number that sits still two turns running is not " +
        "pressure, it is decoration, and the player stops reading it. If it genuinely " +
        "cannot move any further, then it has run out: say so and end the story on it."
    );
  }

  parts.push(
    "CHOICES: 2-4 concrete, distinct actions. One choice only at a genuine climax where " +
      "there is one thing left to do; none at all only on the turn the story ends.\n" +
      "- `requires_near`: set this to an actor's id for any choice that happens AT " +
      "something — prising open a hatch, reading an inscription, speaking to someone " +
      "across the yard. The player must walk there before it unlocks, which is what makes " +
      "the space matter rather than decorate. Aim for about half of them located, and " +
      "always leave at least one free so a player always has something to do from where " +
      "they stand.\n" +
      "- Write them as things the character DOES, in the imperative, not as menu labels."
  );

  // Characters were the thinnest part of the 3D version: you walked up to someone, got
  // one paragraph, and the conversation was over. A conversation that lasts several
  // exchanges is most of what makes a character feel like a person rather than a
  // dispenser of plot.
  parts.push(
    "TALKING TO PEOPLE. When the player is speaking with someone, set `speaker` to that " +
      "actor's id — their painted portrait is shown beside the text, so a conversation " +
      "looks like one.\n" +
      "Stay in the conversation for 2-4 exchanges rather than resolving it in a single " +
      "turn. While it is running, the `choices` are things to SAY or ASK — press them, " +
      "change the subject, offer something, call them a liar, walk away — and at least " +
      "one should always be a way out of the conversation. Let people evade, lie, soften, " +
      "and want things. Someone who answers every question fully the first time is not a " +
      "character."
  );

  parts.push(
    "NARRATIVE: 2-4 short second-person paragraphs for this beat. Short. The player is " +
      "looking at a picture of the place, so do not re-describe what they can see — spend " +
      "the words on what they notice, what it means, and what just changed. Give " +
      "characters real dialogue with quotation marks; a line of speech does more than a " +
      "paragraph about a mood."
  );

  parts.push(
    "STATE: `state_updates` tracks 2-4 concrete, player-visible stats fitting this story " +
      "(air, resolve, coin, suspicion, an inventory array, a named relationship). Short " +
      "snake_case names, the SAME names every turn, values changing as a consequence of " +
      "what the player just did. These are shown on screen as their status.\n" +
      // Measured across logged sessions: one orchard playthrough declared `resolve` and
      // `daylight_remaining` and then never moved either, while minting fourteen one-shot
      // clue_* booleans that each fired once and never again. The panel only has room for
      // about five, so the flags shoved the pressure off the screen entirely — the player
      // could not see the one number that was supposed to be closing in on them.
      "HARD LIMIT: at most five tracked stats for the whole story, chosen on the first " +
      "turn and kept by the same names to the end. Do NOT mint a new flag for each " +
      "discovery — no `clue_ink_never_ages`, no `jig_repaired`, no `mystery_solved`. " +
      "Things the player has learned belong in the prose, or folded into one count or one " +
      "inventory array. A stat earns its place only if it can move both ways and the " +
      "player would change their mind on seeing it. If you are not going to move a number " +
      "again, do not track it." +
      (ablation?.personalization && ablation?.evolving
        ? "\nAlso `state_updates.inferred_preferences` every turn, as described above. Do " +
          "not omit it."
        : "")
  );

  parts.push(
    "BEATS: `beats` is REQUIRED every turn — 1-4 ordered actions the player's character " +
      "performs on stage before control returns, acting out what was just chosen.\n" +
      "Types: `walk_to` (target_id or x), `face` (target_id or x), `interact` (target_id), " +
      "`say` (text), `emote` (text — a short third-person beat like 'steadies herself " +
      "against the rail'), `wait` (seconds).\n" +
      "The prose and the beats must depict the SAME events: if the narrative says they " +
      "cross to the winch and haul on it, emit walk_to then interact targeting that winch. " +
      "Even a purely conversational beat should move them — face the speaker, step closer, " +
      "say a line.\n" +
      "Only ever target actors that exist. If the player asks to interact with something " +
      "not in the scene, either add it (it plausibly existed and had not been drawn yet) " +
      "or redirect them narratively to something that is there. Never target an id that " +
      "does not exist."
  );

  if (persistent && (currentActors?.length || 0) > 0) {
    // Without an explicit inventory the model has to recall ids from conversation
    // history, which was the main source of dangling-reference bugs on the 3D path.
    const inventory = currentActors
      .map(
        (a) =>
          `  ${a.id} — ${a.label} (x ${a.x?.toFixed?.(2) ?? a.x}, depth ${a.depth})` +
          (a.character ? " [character]" : "")
      )
      .join("\n");

    parts.push(
      "PERSISTENT SCENE MODE. The place continues between turns; it is not repainted.\n" +
        `Currently on stage:\n${inventory}\n\n` +
        "Emit `scene_delta` to change it — `add`, `move`, `remove`, `restyle`, and " +
        "`light` for mood/weather shifts. Only reference ids from the list above or ones " +
        "you add in the same turn. Keep the stage between " +
        `${MIN_ACTORS} and ${MAX_ACTORS} actors.\n` +
        "`restyle` REPAINTS an actor because it visibly changed — a door now hanging open, " +
        "a character now bloodied, a lamp now lit. Give the full new description, not the " +
        "difference. It costs a fresh illustration, so use it for changes that matter and " +
        "that the player caused.\n" +
        "Emit a full `scene` INSTEAD of `scene_delta` only when the story moves somewhere " +
        "genuinely new — that repaints everything. Never emit both.\n" +
        "If the beat genuinely changes nothing physical, omit `scene_delta`; the scene " +
        "carries forward, and objects staying where the player left them is what makes the " +
        "place feel real. But look for the consequence before you conclude there isn't " +
        "one. When something lands — a secret told, a lock forced, a threat made, a bargain " +
        "struck — it should be visible: someone crosses the deck or walks out, a door is " +
        "now open, a thing is produced from a pocket, a light goes out. A place that looks " +
        "identical for five turns running stops being worth looking at, however good the " +
        "prose is.\n" +
        "`light` is the cheapest of these by far — it repaints nothing, so a shift in mood, " +
        "palette or weather costs you a field and is felt immediately. Use it whenever the " +
        "temperature of the scene changes."
    );
  }

  return parts.join("\n\n");
}

export function firstTurnMessage2D() {
  return "Begin: generate the opening scene.";
}

export function choiceTurnMessage2D({ choiceText, freeText, examined }) {
  if (examined) {
    return `The player walks up to and examines: ${examined}. Continue from that — what do they find, and what does it change?`;
  }
  if (freeText && freeText.trim()) {
    return `The player, ignoring the listed choices, instead does/says: "${freeText.trim()}". Continue the story from that.`;
  }
  return `The player chose: "${choiceText}". Continue the story from that choice.`;
}

// Used only in the memoryless (evolving=false) baseline, where we cannot send history —
// a compact summary of where things stand goes instead, so the model still has
// something coherent to work from without being given the actual turn-by-turn memory
// the evolving condition has.
export function summarizeForMemorylessTurn2D(state) {
  if (!state) return "No prior state — this is the first turn.";
  const lines = [
    `Current place: ${state.scene?.backdrop?.description || "unknown"}` +
      (state.scene?.backdrop?.mood ? ` (${state.scene.backdrop.mood})` : ""),
  ];
  if (state.objective) lines.push(`Objective: ${state.objective}`);
  if (state.state_updates && Object.keys(state.state_updates).length) {
    lines.push(`Tracked state: ${JSON.stringify(state.state_updates)}`);
  }
  return lines.join("\n");
}
