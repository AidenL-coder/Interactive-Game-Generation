import { randomUUID } from "node:crypto";

// In-memory session store for the 2D illustrated adventure. Kept separate from the 3D
// store rather than shared: the two renderers are an ablation axis, and entangling their
// state would make it easy to break one while changing the other.
//
// Deliberately not persisted — a session holds live interactive state (the history array
// carries full Anthropic content blocks), whereas the eval-relevant record of what
// happened is written turn by turn to the JSONL log. Swap for Redis/SQLite if sessions
// need to survive a restart.
const sessions = new Map();

// Sessions are only reachable by their own uuid, but a long-lived server accumulating
// full turn histories is a slow leak. Evict the oldest once past this.
const MAX_SESSIONS = 200;

export function createStorySession({ profile, sourceText, ablation, pack = null }) {
  const id = randomUUID();
  const session = {
    id,
    profile,
    sourceText,
    ablation: {
      personalization: ablation?.personalization ?? true,
      evolving: ablation?.evolving ?? true,
      // "persistent" = the scene mutates across turns via deltas; "regenerated" =
      // every turn repaints from scratch, which is the weaker baseline.
      persistence: ablation?.persistence === "regenerated" ? "regenerated" : "persistent",
      engine: "2d",
      // Whether the scenery was generated for this premise or came pre-painted in a
      // pack. Recorded as an ablation axis so pack playthroughs can never be quietly
      // pooled with generative ones when results are computed.
      worldSource: pack ? "pack" : "generated",
      packId: pack?.id ?? null,
      // `engine` above means "2d" here but "llm"/"template" in the 3D store — the two
      // stores grew that field for different axes. `renderer` is the unambiguous one, set
      // identically in both, so a 2D-vs-3D comparison can be filtered on a single field.
      renderer: "2d",
    },
    // The pack itself is held on the session rather than re-read per turn; it is static.
    pack,
    // Which of the pack's pinned places the player is currently standing in.
    placeId: pack?.opening?.place ?? null,
    bible: pack ? pack.bible : null,
    history: [],
    lastState: null,
    turnIndex: 0,
    createdAt: new Date().toISOString(),
  };

  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  sessions.set(id, session);
  return session;
}

export function getStorySession(id) {
  return sessions.get(id) || null;
}

export function updateStorySession(id, patch) {
  const session = getStorySession(id);
  if (!session) return null;
  Object.assign(session, patch);
  return session;
}

/** What the client is allowed to see: no history, no source text echo, no pack manifest. */
export function publicStorySession(session) {
  return {
    sessionId: session.id,
    ablation: session.ablation,
    turnIndex: session.turnIndex,
    bible: session.bible,
    state: session.lastState,
    placeId: session.placeId ?? null,
  };
}
