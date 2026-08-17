import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "generations.jsonl");

let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = mkdir(LOG_DIR, { recursive: true });
  return dirReady;
}

/**
 * Appends one JSONL record per generation call. This is the raw substrate the
 * evaluation plan in docs/research.md depends on (schema-validity rate, ablation
 * comparisons, latency/cost) — kept append-only and off the hot path's return value
 * so a logging failure never breaks a live session.
 */
// sourceText can be arbitrarily long (a full chapter) — capped so the log stays a
// reasonable size and greppable; full fidelity isn't needed for pairing sessions by
// premise in eval/judge-batch.mjs, just enough to fingerprint/display it.
const SOURCE_TEXT_LOG_CAP = 2000;

export async function logGeneration({
  sessionId,
  turnIndex,
  ablation,
  profile,
  sourceText,
  turnMessage,
  worldState,
  usage,
  latencyMs,
  error,
}) {
  const record = {
    ts: new Date().toISOString(),
    sessionId,
    turnIndex,
    ablation,
    profile: profile ?? null,
    sourceText: sourceText ? sourceText.slice(0, SOURCE_TEXT_LOG_CAP) : null,
    turnMessage,
    worldState: worldState ?? null,
    usage: usage ?? null,
    latencyMs: latencyMs ?? null,
    error: error ? String(error?.message || error) : null,
  };
  try {
    await ensureDir();
    await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[logger] failed to write generation log:", err);
  }
}
