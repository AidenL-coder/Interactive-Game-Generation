#!/usr/bin/env node
// Offline scoring over server/logs/generations.jsonl, per the evaluation plan in
// docs/research.md ("Automatic" section). Reads the raw per-generation JSONL log,
// groups by ablation condition (personalization x evolving), and reports:
//   - schema validity (does each WorldState respect the shared/worldState.js contract)
//   - personalization signal (do the player's stated interests show up in the text)
//   - continuity/callback rate (does turn t reference something introduced earlier)
//   - latency/token cost
// Deliberately dependency-free (no zod/ajv/nlp libs) — this is meant to run against
// whatever's in server/logs/ with zero setup.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorldState } from "../shared/worldState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.join(__dirname, "..", "server", "logs", "generations.jsonl");
const OUT_DIR = path.join(__dirname, "out");

const STOPWORDS = new Set([
  "with", "that", "this", "from", "your", "have", "been", "were", "into", "there",
  "their", "about", "still", "each", "which", "while", "over", "under", "near",
  "against", "behind", "before", "after", "looked", "looking", "toward", "themselves",
]);

// ---------- loading ----------

async function loadRecords(logPath) {
  let raw;
  try {
    raw = await readFile(logPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`No log file at ${logPath} — run some sessions first (npm run dev:server + dev:web).`);
      process.exit(1);
    }
    throw err;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.error(`Skipping malformed JSONL line: ${line.slice(0, 80)}...`);
    }
  }
  return records;
}

// ---------- personalization signal ----------

// Fraction of the profile's stated interests that show up (as a substring, case-
// insensitive) somewhere in the turn's narrative or prop labels. Crude but requires
// no embedding model, and is symmetric across the personalization on/off conditions
// (both get scored the same way, so on/off is a fair comparison, not an artifact of
// different measurement).
function personalizationHitRate(worldState, profile) {
  const interests = (profile?.interests || []).filter(Boolean);
  if (!interests.length) return null;

  const propLabels = (worldState?.scene?.props || []).map((p) => p.label || "").join(" ");
  const haystack = `${worldState?.narrative || ""} ${propLabels}`.toLowerCase();

  const hits = interests.filter((interest) => haystack.includes(interest.toLowerCase()));
  return hits.length / interests.length;
}

// ---------- continuity / callback rate ----------

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function entityVocabFromTurn(worldState) {
  const labels = (worldState?.scene?.props || []).map((p) => p.label || "").join(" ");
  return new Set(tokenize(labels));
}

// ---------- aggregation ----------

function ablationKey(ablation) {
  const engine = ablation?.engine === "template" ? "template" : "llm";
  return `engine=${engine} personalization=${Boolean(ablation?.personalization)} evolving=${Boolean(ablation?.evolving)}`;
}

function mean(nums) {
  const vals = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function main() {
  const logPath = process.argv[2] || DEFAULT_LOG_PATH;
  const records = await loadRecords(logPath);

  if (!records.length) {
    console.error(`Log file at ${logPath} is empty — nothing to score.`);
    process.exit(1);
  }

  // Group into sessions (ordered by turnIndex) so continuity can be computed per session.
  const bySession = new Map();
  for (const r of records) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  for (const turns of bySession.values()) turns.sort((a, b) => a.turnIndex - b.turnIndex);

  const byCondition = new Map();
  function bucket(ablation) {
    const key = ablationKey(ablation);
    if (!byCondition.has(key)) {
      byCondition.set(key, {
        key,
        attempts: 0,
        errors: 0,
        schemaValid: 0,
        schemaChecked: 0,
        violationSamples: [],
        personalizationHits: [],
        callbackHits: [],
        latencies: [],
        totalTokens: [],
      });
    }
    return byCondition.get(key);
  }

  for (const [, turns] of bySession) {
    // turnVocabs[i] = entity tokens introduced at turn i (empty set for error turns).
    // Callback for turn i only looks at turns 0..i-2 — turn i-1 is deliberately
    // excluded. The immediately preceding turn's vocabulary reaches the model via the
    // chosen choice's own text (`turnMessage` = `The player chose: "..."`), which is
    // sent regardless of the evolving flag — it's just "what action is this turn
    // responding to," not memory. Crediting that as a callback would make the
    // memoryless baseline look falsely continuous. Requiring k>=2 isolates the effect
    // `evolving` is actually supposed to produce: recall beyond the current action.
    const turnVocabs = [];

    turns.forEach((r, i) => {
      const b = bucket(r.ablation);
      b.attempts++;

      if (r.error) {
        b.errors++;
        turnVocabs.push(new Set());
        return;
      }

      const { valid, violations } = validateWorldState(r.worldState);
      b.schemaChecked++;
      if (valid) {
        b.schemaValid++;
      } else if (b.violationSamples.length < 5) {
        b.violationSamples.push({ sessionId: r.sessionId, turnIndex: r.turnIndex, violations });
      }

      const pHit = personalizationHitRate(r.worldState, r.profile);
      if (pHit !== null) b.personalizationHits.push(pHit);

      if (i >= 2) {
        const priorVocab = new Set();
        for (let k = 0; k <= i - 2; k++) for (const tok of turnVocabs[k]) priorVocab.add(tok);
        const narrativeTokens = new Set(tokenize(r.worldState?.narrative));
        const hasCallback = [...priorVocab].some((tok) => narrativeTokens.has(tok));
        b.callbackHits.push(hasCallback ? 1 : 0);
      }
      turnVocabs.push(entityVocabFromTurn(r.worldState));

      if (typeof r.latencyMs === "number") b.latencies.push(r.latencyMs);
      if (r.usage) {
        const total = (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0);
        b.totalTokens.push(total);
      }
    });
  }

  const summary = [...byCondition.values()].map((b) => ({
    condition: b.key,
    attempts: b.attempts,
    errors: b.errors,
    errorRate: b.attempts ? b.errors / b.attempts : null,
    schemaValidRate: b.schemaChecked ? b.schemaValid / b.schemaChecked : null,
    schemaChecked: b.schemaChecked,
    personalizationHitRate: mean(b.personalizationHits),
    personalizationN: b.personalizationHits.length,
    callbackRate: mean(b.callbackHits),
    callbackN: b.callbackHits.length,
    avgLatencyMs: mean(b.latencies),
    avgTotalTokens: mean(b.totalTokens),
    violationSamples: b.violationSamples,
  }));

  // ---------- report ----------

  console.log(`\nScored ${records.length} generation records across ${bySession.size} sessions from ${logPath}\n`);

  const pct = (x) => (x === null ? "  n/a" : `${(x * 100).toFixed(1)}%`.padStart(6));
  const num = (x) => (x === null ? "  n/a" : x.toFixed(0).padStart(6));

  console.log(
    "condition".padEnd(55) +
      "n".padStart(5) +
      "errs".padStart(6) +
      "schema-ok".padStart(11) +
      "pers-hit".padStart(10) +
      "callback".padStart(10) +
      "avg-ms".padStart(9) +
      "avg-tok".padStart(9)
  );
  for (const s of summary) {
    console.log(
      s.condition.padEnd(55) +
        String(s.attempts).padStart(5) +
        String(s.errors).padStart(6) +
        pct(s.schemaValidRate).padStart(11) +
        pct(s.personalizationHitRate).padStart(10) +
        pct(s.callbackRate).padStart(10) +
        num(s.avgLatencyMs).padStart(9) +
        num(s.avgTotalTokens).padStart(9)
    );
  }

  for (const s of summary) {
    if (s.violationSamples.length) {
      console.log(`\nSchema violations sampled for [${s.condition}]:`);
      for (const v of s.violationSamples) {
        console.log(`  session ${v.sessionId} turn ${v.turnIndex}: ${v.violations.join("; ")}`);
      }
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "summary.json");
  await writeFile(outPath, JSON.stringify({ scoredAt: new Date().toISOString(), logPath, summary }, null, 2));
  console.log(`\nFull summary written to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
