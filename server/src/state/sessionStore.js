import { randomUUID } from "node:crypto";

// In-memory session store. Deliberately not persisted to disk/DB: sessions are the
// live *interactive* state (history array can hold full Anthropic content blocks,
// which we don't want to serialize casually), whereas the eval-relevant record of
// what happened is written turn-by-turn to the JSONL log (see logging/logger.js).
// Swap this for Redis/SQLite if sessions need to survive a server restart later.
const sessions = new Map();

export function createSession({ profile, sourceText, ablation }) {
  const id = randomUUID();
  const session = {
    id,
    profile,
    sourceText,
    ablation: {
      personalization: ablation?.personalization ?? true,
      evolving: ablation?.evolving ?? true,
      engine: ablation?.engine === "template" ? "template" : "llm",
      // "persistent" = world mutates across turns via deltas; "regenerated" = each turn
      // rebuilds the scene from scratch (the original behaviour, kept as the baseline).
      persistence: ablation?.persistence === "persistent" ? "persistent" : "regenerated",
    },
    history: [],
    lastWorldState: null,
    turnIndex: 0,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function updateSession(id, patch) {
  const session = getSession(id);
  if (!session) return null;
  Object.assign(session, patch);
  return session;
}
