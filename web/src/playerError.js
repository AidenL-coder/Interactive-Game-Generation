// What a player is told when something goes wrong, in either renderer.
//
// Both games used to put the raw error on screen. In a judged playthrough that meant two
// of fourteen turns of the 2D game and one of the 3D game were a full-width red panel
// reading "Model returned an invalid delta after 3 attempts: choices[0] requires_near
// unknown actor 'meaning_orrery'" — developer identifiers leaking at the player, over the
// art, mid-story. The judge named it the biggest problem in the 2D run.
//
// The detail still matters to whoever is debugging, so it goes to the console in full.
// The player gets a sentence that is true: a failed turn does not advance the story or
// change any stat on the server, so trying again costs nothing.

/**
 * @param {unknown} err
 * @param {"start"|"turn"} [phase]
 * @returns {string} the message to show the player
 */
export function playerFacingError(err, phase = "turn") {
  const detail = String(err?.message || err || "unknown error");
  console.warn(`[game] ${phase} failed:`, detail);

  if (/failed to fetch|networkerror|network request|load failed|ECONNREFUSED/i.test(detail)) {
    return "Lost the connection to the game. Check it is still running, then try again.";
  }
  if (phase === "start") {
    return "The world could not be built just now. Give it a moment and try again.";
  }
  return "That didn't go through — the story stumbled. Nothing was lost: try it again, or choose something else.";
}
