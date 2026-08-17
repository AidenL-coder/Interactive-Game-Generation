#!/usr/bin/env node
// LLM-judge pairwise comparison, per the "Human/LLM-judge" half of the evaluation plan
// in docs/research.md — the automatic metrics in score.mjs can't capture "did this
// feel personalized" or "did the world feel like it reacted to my choice" as well as
// an actual reader/judge can. Reconstructs two sessions' transcripts from the JSONL
// log and asks Claude to judge them blind (the model isn't told which ablation
// condition produced which transcript) on three criteria plus an overall verdict.
//
// Usage: node eval/judge.mjs <sessionIdA> <sessionIdB> [logPath]
// For running this across many pairs and aggregating win rates, see judge-batch.mjs.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { loadJudgeRecords, judgeSessions } from "./judgeCore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.join(__dirname, "..", "server", "logs", "generations.jsonl");
const OUT_DIR = path.join(__dirname, "out");

// Load server/.env explicitly rather than relying on CWD-relative "dotenv/config" —
// this script is meant to be runnable from the repo root, not just server/.
dotenv.config({ path: path.join(__dirname, "..", "server", ".env") });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set (checked server/.env) — the judge call needs it.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

async function main() {
  const [sessionIdA, sessionIdB, logPathArg] = process.argv.slice(2);
  if (!sessionIdA || !sessionIdB) {
    console.error("Usage: node eval/judge.mjs <sessionIdA> <sessionIdB> [logPath]");
    process.exit(1);
  }
  const logPath = logPathArg || DEFAULT_LOG_PATH;
  const records = await loadJudgeRecords(logPath);

  console.log(`Judging session A=${sessionIdA} vs B=${sessionIdB}...`);
  const result = await judgeSessions(anthropic, CLAUDE_MODEL, records, sessionIdA, sessionIdB);
  if (!result) {
    console.error("Could not build a verdict — check that both session IDs have successful turns in the log.");
    process.exit(1);
  }
  const { verdict, a, b } = result;

  console.log("\n--- Verdict (blind: judge did not know which ablation condition made A vs B) ---");
  for (const key of ["personalization_fit", "narrative_coherence", "reactivity", "overall"]) {
    console.log(`${key}: ${verdict[key].winner} — ${verdict[key].rationale}`);
  }
  console.log("\n--- Un-blinded mapping (for your interpretation, not shown to the judge) ---");
  console.log(`A = session ${sessionIdA}, ablation ${JSON.stringify(a.ablation)}`);
  console.log(`B = session ${sessionIdB}, ablation ${JSON.stringify(b.ablation)}`);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `judge-${sessionIdA}-vs-${sessionIdB}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        judgedAt: new Date().toISOString(),
        a: { sessionId: sessionIdA, ablation: a.ablation },
        b: { sessionId: sessionIdB, ablation: b.ablation },
        verdict,
      },
      null,
      2
    )
  );
  console.log(`\nFull verdict written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
