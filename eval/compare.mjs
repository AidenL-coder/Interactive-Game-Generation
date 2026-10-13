#!/usr/bin/env node
// Side-by-side scores for any number of play-and-judge runs.
//
// The table a paper wants is a comparison between conditions — the same pack played in
// the 2D stage and the 3D world, say — with each number shown alongside its spread
// across judge samples, because a difference smaller than the spread is not a finding.
// This reads the run directories directly so the table is never transcribed by hand.
//
// Usage:
//   node eval/compare.mjs eval/out/compare-2d eval/out/compare-3d
//   node eval/compare.mjs eval/out/*            # every run on disk
//   node eval/compare.mjs --csv eval/out/a eval/out/b > scores.csv
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DIMENSIONS, repairVerdictShape, mean, playMetrics } from "./rubric.mjs";

const args = process.argv.slice(2);
const csv = args.includes("--csv");
const dirs = args.filter((a) => !a.startsWith("--"));
if (!dirs.length) {
  console.error("Usage: node eval/compare.mjs [--csv] <run-dir> [<run-dir> …]");
  process.exit(1);
}

async function load(dir) {
  const read = async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8"));
  let log, verdict;
  try {
    log = await read("play-log.json");
    verdict = await read("verdict.json");
  } catch {
    return null;
  }
  // Every sample, put back into canonical shape: runs judged under an older schema still
  // read correctly, and a dimension the judge never scored stays absent, not zero.
  const runs = (verdict.runs || []).map((r) => repairVerdictShape(r).verdict);
  const dims = {};
  for (const d of DIMENSIONS) {
    const s = runs.map((r) => r.scores?.[d.key]?.score).filter((v) => typeof v === "number");
    dims[d.key] = { mean: mean(s), min: s.length ? Math.min(...s) : null, max: s.length ? Math.max(...s) : null, n: s.length };
  }
  const overall = runs.map((r) => r.overall_enjoyment).filter((v) => typeof v === "number");
  return {
    name: path.basename(dir),
    engine: log.engine || "2d",
    game: log.packId ? `pack:${log.packId}` : (log.premise || "").slice(0, 24),
    renderer: log.renderer ? (/swiftshader/i.test(log.renderer) ? "software" : "gpu") : "unrecorded",
    samples: runs.length,
    turns: log.turns?.length ?? 0,
    ended: Boolean(log.turns?.some((t) => t.ending)),
    dims,
    overall: { mean: mean(overall), min: overall.length ? Math.min(...overall) : null, max: overall.length ? Math.max(...overall) : null },
    minutes: mean(runs.map((r) => r.minutes_before_quitting)),
    recommend: runs.length ? runs.filter((r) => r.would_recommend).length / runs.length : null,
    metrics: playMetrics(log.turns || []),
    places: log.placesVisited?.length ?? null,
  };
}

const runs = (await Promise.all(dirs.map(load))).filter(Boolean);
if (!runs.length) {
  console.error("none of those directories holds a finished, judged run");
  process.exit(1);
}

// "3.7 (3–4)" when samples disagree, "4.0" when they agree, "–" when unscored.
const cell = (s) => {
  if (!s || s.mean === null) return "–";
  const m = s.mean.toFixed(1);
  return s.min === s.max ? m : `${m} (${s.min}–${s.max})`;
};

if (csv) {
  const head = ["run", "engine", "game", "renderer", "samples", "turns", ...DIMENSIONS.map((d) => d.key), "overall", "overall_min", "overall_max", "minutes", "recommend"];
  console.log(head.join(","));
  for (const r of runs) {
    console.log(
      [r.name, r.engine, r.game, r.renderer, r.samples, r.turns, ...DIMENSIONS.map((d) => r.dims[d.key].mean?.toFixed(2) ?? ""),
        r.overall.mean?.toFixed(2) ?? "", r.overall.min ?? "", r.overall.max ?? "", r.minutes?.toFixed(1) ?? "", r.recommend ?? ""].join(",")
    );
  }
  process.exit(0);
}

// Build every row first, then size the columns to their widest cell, so a long label or
// a long game name never runs into the next column.
const rows = [];
const add = (label, vals) => rows.push([label, ...vals.map(String)]);
add("", runs.map((r) => r.name));
add("renderer", runs.map((r) => `${r.engine} · ${r.renderer}`));
add("game", runs.map((r) => r.game));
add("judge samples", runs.map((r) => r.samples));
add("turns", runs.map((r) => `${r.turns}${r.ended ? " (ended)" : ""}`));
let group = null;
for (const d of DIMENSIONS) {
  if (d.group !== group) {
    group = d.group;
    rows.push([`  ${group}`]);
  }
  add(`    ${d.key}`, runs.map((r) => cell(r.dims[d.key])));
}
add("  OVERALL", runs.map((r) => cell(r.overall)));
add("  minutes to quit", runs.map((r) => (r.minutes === null ? "–" : `~${Math.round(r.minutes)}`)));
add("  would recommend", runs.map((r) => (r.recommend === null ? "–" : `${Math.round(r.recommend * 100)}%`)));
rows.push(["  measured"]);
add("    engagement (player)", runs.map((r) => (r.metrics.engagementMean === null ? "–" : r.metrics.engagementMean.toFixed(1))));
add("    samey choices", runs.map((r) => (r.metrics.sameyChoiceRate === null ? "–" : `${Math.round(r.metrics.sameyChoiceRate * 100)}%`)));
add("    pressure stat", runs.map((r) => r.metrics.pressureStats.join(",") || "none"));
add("    places visited", runs.map((r) => r.places ?? "–"));

const widths = [];
for (const r of rows) {
  if (r.length === 1) continue; // group headings span the row
  r.forEach((c, i) => (widths[i] = Math.max(widths[i] || 0, c.length)));
}
console.log("");
for (const r of rows) {
  console.log(r.length === 1 ? r[0] : r.map((c, i) => c.padEnd(widths[i] + 2)).join("").trimEnd());
}
console.log("");
console.log("Ranges are across judge samples. A gap between two runs smaller than their ranges is not a difference.");
if (runs.some((r) => r.samples < 2)) console.log("Runs with one sample have no range; their scores carry no estimate of judge noise.");
