#!/usr/bin/env node
// Runs the LLM-judge pairwise comparison (judgeCore.mjs) across every pair of sessions
// in the log that share the same source text + player profile but differ in exactly
// one ablation axis (personalization, evolving, or engine) — then aggregates win rates
// per axis. This is what turns eval/judge.mjs from a one-off anecdote into a real
// evaluation, per docs/research.md's explicit next step after judge.mjs landed.
//
// Usage: node eval/judge-batch.mjs [logPath]
//
// Caveat: each pair is judged once, in a fixed A/B order (lower sessionId = A) — no
// position-swap control for judge position-bias. Worth adding (run each pair both
// ways, require agreement) once the sample size is large enough to justify doubling
// the judge-call cost; not done here.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { loadJudgeRecords, judgeSessions } from "./judgeCore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.join(__dirname, "..", "server", "logs", "generations.jsonl");
const OUT_DIR = path.join(__dirname, "out");

dotenv.config({ path: path.join(__dirname, "..", "server", ".env") });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set (checked server/.env) — judge calls need it.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const AXES = ["personalization", "evolving", "engine"];

// Approximate "same premise" fingerprint: exact match on the (capped) logged source
// text plus the profile object. Sessions started with the same source text/profile
// through the web UI or a test script will match; anything typed slightly differently
// won't — this is deliberately strict rather than fuzzy-matching premises. Sessions
// logged before sourceText was added to the logger have sourceText=null; matching
// those by profile alone would falsely pair sessions from *different* premises that
// happened to reuse the same test profile, so each gets its own unmatchable
// fingerprint (keyed on sessionId) instead of being silently excluded or fuzzy-matched.
function fingerprint(sourceText, profile, sessionId) {
  const trimmed = (sourceText || "").trim();
  if (!trimmed) return `no-source-text-logged:${sessionId}`;
  return JSON.stringify({ sourceText: trimmed, profile: profile || null });
}

function ablationDiffAxis(a, b) {
  const diffs = AXES.filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  return diffs.length === 1 ? diffs[0] : null;
}

async function main() {
  const logPath = process.argv[2] || DEFAULT_LOG_PATH;
  const records = await loadJudgeRecords(logPath);

  // One entry per session, from its first successful turn.
  const sessions = new Map();
  for (const r of records) {
    if (r.error || !r.worldState || sessions.has(r.sessionId)) continue;
    sessions.set(r.sessionId, {
      sessionId: r.sessionId,
      fingerprint: fingerprint(r.sourceText, r.profile, r.sessionId),
      ablation: r.ablation,
    });
  }

  const byFingerprint = new Map();
  for (const s of sessions.values()) {
    if (!byFingerprint.has(s.fingerprint)) byFingerprint.set(s.fingerprint, []);
    byFingerprint.get(s.fingerprint).push(s);
  }

  const pairs = [];
  for (const group of byFingerprint.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const axis = ablationDiffAxis(group[i].ablation, group[j].ablation);
        if (!axis) continue;
        const [a, b] = [group[i], group[j]].sort((p, q) => (p.sessionId < q.sessionId ? -1 : 1));
        pairs.push({ axis, a, b });
      }
    }
  }

  if (!pairs.length) {
    console.log(
      "No matched pairs found — need >=2 sessions sharing the same source text + profile that differ " +
        "in exactly one ablation axis (personalization, evolving, or engine)."
    );
    return;
  }

  console.log(
    `Found ${pairs.length} matched pair(s) across ${byFingerprint.size} distinct premise/profile group(s). Judging...\n`
  );

  const results = [];
  for (const pair of pairs) {
    process.stdout.write(`  [${pair.axis}] ${pair.a.sessionId} vs ${pair.b.sessionId} ... `);
    const result = await judgeSessions(anthropic, CLAUDE_MODEL, records, pair.a.sessionId, pair.b.sessionId);
    if (!result) {
      console.log("skipped (no transcript)");
      continue;
    }
    console.log(`overall=${result.verdict.overall.winner}`);
    results.push({ axis: pair.axis, a: pair.a, b: pair.b, verdict: result.verdict });
  }

  // Attribute each win to the ablation *value* the winning session actually had, not
  // to "A"/"B" (which is just sessionId sort order and carries no meaning on its own).
  const aggregates = {};
  for (const axis of AXES) aggregates[axis] = { pairs: 0, byValue: {}, ties: 0 };

  for (const r of results) {
    const agg = aggregates[r.axis];
    agg.pairs++;
    const winner = r.verdict.overall.winner;
    if (winner === "tie") {
      agg.ties++;
      continue;
    }
    const winningSession = winner === "A" ? r.a : r.b;
    const value = JSON.stringify(winningSession.ablation[r.axis]);
    agg.byValue[value] = (agg.byValue[value] || 0) + 1;
  }

  console.log("\n--- Aggregate win rates by ablation axis (overall criterion) ---");
  for (const axis of AXES) {
    const agg = aggregates[axis];
    if (!agg.pairs) continue;
    const valueSummary = Object.entries(agg.byValue)
      .map(([v, n]) => `${v}=${n}`)
      .join(", ");
    console.log(`${axis}: n=${agg.pairs} | wins: ${valueSummary || "none"} | ties=${agg.ties}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "judge-batch-summary.json");
  await writeFile(
    outPath,
    JSON.stringify({ judgedAt: new Date().toISOString(), logPath, aggregates, results }, null, 2)
  );
  console.log(`\nFull batch results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
