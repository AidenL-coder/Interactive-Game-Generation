#!/usr/bin/env node
// Plays the game with a vision agent and scores how much a person would enjoy it.
//
// This is the "is it fun" instrument. The other harnesses answer narrower questions —
// scripts/playthrough.mjs asks whether the thing renders, scripts/motion-probe.mjs
// whether it moves smoothly, scripts/pressure-check.mjs whether anything was at stake —
// and all three read the renderer or the log. None of them can tell you that a game is
// technically flawless and nobody would play it twice.
//
// Two agents and one calculator, kept independent:
//   a PLAYER   drives a real browser, sees only screenshots, reports how each turn landed
//   a JUDGE    sees the same screenshots afterwards and scores enjoyment against a rubric
//   playMetrics counts what actually happened, asking no model anything
//
// Where the judge and the counters disagree, the report says so. That is the most useful
// line it prints.
//
// Usage:
//   node eval/play-and-judge.mjs                             # default premise, 14 turns
//   node eval/play-and-judge.mjs --premise "..." --turns 8
//   node eval/play-and-judge.mjs --samples 3                 # judge 3x, report the spread
//   node eval/play-and-judge.mjs --judge-only eval/out/play-… # re-score, no replay
//   node eval/play-and-judge.mjs --headed                    # watch it play
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { playGame } from "./visionPlayer.mjs";
import { judgePlaythrough, formatReport } from "./enjoymentJudge.mjs";
import { playMetrics } from "./rubric.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, "server", ".env") });

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const DEFAULT_PREMISE =
  "A diving bell sits on the deck of a rusting salvage barge in the North Sea. Below it " +
  "is a wreck nobody will name, and the crew have stopped answering questions about the " +
  "last diver who went down.";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set (checked server/.env) — both agents need it.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The player can be a cheaper model than the judge: deciding which button to press from a
// screenshot is a much easier call than scoring a playthrough against a rubric, and the
// player makes one request per turn while the judge makes one per run.
const PLAYER_MODEL = arg("player-model", process.env.PLAYER_MODEL || "claude-sonnet-5");
const JUDGE_MODEL = arg("judge-model", process.env.JUDGE_MODEL || "claude-opus-5");

async function main() {
  const judgeOnly = arg("judge-only");
  const samples = Number(arg("samples", "1"));

  let outDir;
  let playLog;

  if (judgeOnly) {
    outDir = path.resolve(judgeOnly);
    playLog = JSON.parse(await readFile(path.join(outDir, "play-log.json"), "utf8"));
    // Stored paths are relative to the run directory so a run can be moved or shared.
    playLog.judgeShotPaths = (playLog.shots?.judge || []).map((p) => path.join(outDir, p));
    console.log(`re-judging ${playLog.turns?.length ?? 0} turns from ${outDir}`);
  } else {
    const packId = arg("pack") || null;
    const premise = packId ? null : arg("premise", DEFAULT_PREMISE);
    const profile = {
      name: arg("name", "Aiden"),
      interests: arg("interests", "deep sea, machines")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    outDir = path.resolve(arg("out", path.join(__dirname, "out", `play-${stamp}`)));
    await mkdir(outDir, { recursive: true });

    console.log(`player: ${PLAYER_MODEL}   judge: ${JUDGE_MODEL}`);
    console.log(packId ? `pack: ${packId}` : `premise: ${premise.slice(0, 90)}…`);
    console.log(`out: ${outDir}\n`);

    playLog = await playGame({
      anthropic,
      model: PLAYER_MODEL,
      baseUrl: arg("url", "http://localhost:5173"),
      premise,
      packId,
      profile,
      outDir,
      maxTurns: Number(arg("turns", "14")),
      headed: flag("headed"),
    });

    console.log(
      `\nplayed ${playLog.turns.length} turns in ${(playLog.durationMs / 1000 / 60).toFixed(1)} min ` +
        `(${playLog.usage.input_tokens} in / ${playLog.usage.output_tokens} out tokens)`
    );
  }

  if (!playLog.turns?.length) {
    console.error("\nthe player took no turns — nothing to judge. Check that both servers are up.");
    if (playLog.problems?.length) for (const p of playLog.problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const metrics = playMetrics(playLog.turns);

  console.log(`\njudging ${playLog.judgeShotPaths.length} screenshots${samples > 1 ? ` x${samples} samples` : ""}…`);
  const summary = await judgePlaythrough({
    anthropic,
    model: JUDGE_MODEL,
    playLog,
    outDir,
    samples,
  });

  console.log(formatReport(summary, metrics));

  if (playLog.problems?.length) {
    console.log("\n=== faults the harness saw while playing ===\n");
    for (const p of playLog.problems) console.log(`  ${p}`);
  }

  // What the player said in the moment, which is the other half of the picture and often
  // more actionable than the score: a specific sentence about a specific turn.
  const lowPoints = playLog.turns
    .filter((t) => (t.engagement ?? 5) <= 2 || (t.confusion || "").trim())
    .slice(0, 6);
  if (lowPoints.length) {
    console.log("\n=== where the player struggled ===\n");
    for (const t of lowPoints) {
      console.log(`  turn ${t.turn} (engagement ${t.engagement}/5)`);
      if ((t.confusion || "").trim()) console.log(`    confused: ${t.confusion.trim()}`);
      console.log(`    wanted:   ${t.want}`);
    }
  }

  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ metrics, verdict: summary, problems: playLog.problems }, null, 2)
  );
  console.log(`\nfull report: ${path.join(outDir, "report.json")}`);
  console.log(`screenshots: ${path.join(outDir, "shots")}`);
}

main().catch((err) => {
  console.error("\n[play-and-judge] failed:", err.message || err);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
