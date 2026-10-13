// Scores a playthrough from its screenshots.
//
// The judge is shown the frames the player decided from, in order, and nothing else: not
// the turn JSON, not the session state, not the player's own engagement ratings. That
// last exclusion is the important one. If the judge could read the player's "this turn
// was a 2", it would anchor on it, and the two measurements would stop being independent
// — at which point agreement between them proves nothing and disagreement is impossible.
//
// What the judge does get is the premise, because the player typed it in and can see it
// on the first screenshot anyway.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { verdictToolFor, judgeSystem, DIMENSIONS, mean, repairVerdictShape } from "./rubric.mjs";

/** Builds the interleaved image/label content block list the judge reads. */
async function buildContent(shotPaths, { premise, turnCount, reachedEnding, engine = "2d" }) {
  const content = [
    {
      type: "text",
      text:
        `Here is a complete playthrough of one AI-generated ${engine === "3d" ? "first-person 3D" : "illustrated"} adventure game, ` +
        `as ${shotPaths.length} screenshots in the order the player saw them.\n\n` +
        (premise
          ? `The player began from this premise, which they typed in themselves:\n"""\n${premise}\n"""\n\n`
          : "The player picked a ready-made game from the menu rather than writing a premise, " +
            "so the first screenshot is where they chose it.\n\n") +
        `The playthrough ran for ${turnCount} turn${turnCount === 1 ? "" : "s"} and ` +
        (reachedEnding
          ? "reached an ending."
          : "did NOT reach an ending — it stopped at the harness's turn cap, so judge pacing on what you can see rather than assuming the game would never have ended.") +
        `\n\nThe screenshots follow, each labelled.`,
    },
  ];

  for (let i = 0; i < shotPaths.length; i++) {
    const b64 = (await readFile(shotPaths[i])).toString("base64");
    content.push({ type: "text", text: `--- Screenshot ${i + 1} of ${shotPaths.length} (${path.basename(shotPaths[i])}) ---` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
  }

  content.push({
    type: "text",
    text:
      "That is the whole playthrough. Study the pictures as well as the words in them, " +
      "then call emit_enjoyment_verdict. Remember that 3 is the expected score and that " +
      "you must name the single biggest problem.",
  });

  return content;
}

/**
 * Runs the judge once.
 *
 * @returns {Promise<{verdict: object, usage: object}>}
 */
export async function judgeOnce({ anthropic, model, shotPaths, premise, turnCount, reachedEnding, engine = "2d" }) {
  // The same nine dimensions either way; only the three visual anchors differ, because a
  // 3D world fails differently from a painted stage. See dimensionsFor() in rubric.mjs.
  const VERDICT_TOOL = verdictToolFor(engine);
  const content = await buildContent(shotPaths, { premise, turnCount, reachedEnding, engine });

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    system: judgeSystem(engine),
    messages: [{ role: "user", content }],
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: VERDICT_TOOL.name },
  });

  const use = response.content.find((b) => b.type === "tool_use" && b.name === VERDICT_TOOL.name);
  if (!use?.input) throw new Error(`the judge returned no verdict (${response.stop_reason})`);

  const { verdict, missing, repaired } = repairVerdictShape(use.input);
  if (repaired) console.warn("[judge] the verdict came back in the wrong shape and was reassembled");
  if (missing.length) console.warn(`[judge] no score for: ${missing.join(", ")}`);
  if (missing.length === DIMENSIONS.length) {
    // Say what actually came back. "scored nothing" on its own sent a diagnosis down a
    // guessing path once already; the shape of the reply is the entire diagnosis.
    const shape = JSON.stringify(use.input, (k, v) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v));
    throw new Error(
      `the judge scored nothing (stop_reason=${response.stop_reason}).\nIt returned: ${shape.slice(0, 1400)}`
    );
  }

  return { verdict, missing, usage: response.usage };
}

/**
 * Runs the judge `samples` times and summarises.
 *
 * More than one sample is worth the money when a number is about to be quoted as a
 * result. An LLM judge is a measuring instrument, and an instrument whose reading moves
 * by two points between identical runs cannot support a claim about a one-point
 * difference between conditions. The spread reported here is what says whether it can.
 */
export async function judgePlaythrough({
  anthropic,
  model,
  playLog,
  outDir,
  samples = 1,
  shotPaths = null,
}) {
  const paths = shotPaths || playLog.judgeShotPaths || [];
  if (!paths.length) throw new Error("no screenshots to judge");

  const turnCount = playLog.turns?.length ?? 0;
  const reachedEnding = Boolean(playLog.turns?.some((t) => t.ending));
  // Logs written before the 3D renderer existed carry no engine; they were all 2D.
  const engine = playLog.engine === "3d" ? "3d" : "2d";

  const runs = [];
  const unscored = new Set();
  let usage = { input_tokens: 0, output_tokens: 0 };
  // A sample that fails after others have succeeded must not throw the successful ones
  // away. Observed: the API's credit ran out on the second of three samples, and the
  // first — already paid for, already scored — was discarded with it. Keep what was
  // collected and say plainly that the run is short; a reader of the summary must never
  // mistake one sample for three.
  let incomplete = null;
  for (let i = 0; i < samples; i++) {
    let result;
    try {
      result = await judgeOnce({
        anthropic,
        model,
        shotPaths: paths,
        premise: playLog.premise,
        turnCount,
        reachedEnding,
        engine,
      });
    } catch (err) {
      if (!runs.length) throw err;
      incomplete = { wanted: samples, got: runs.length, reason: String(err.message || err).slice(0, 300) };
      console.warn(`[judge] stopped after ${runs.length} of ${samples} samples: ${incomplete.reason}`);
      break;
    }
    const { verdict, missing, usage: u } = result;
    runs.push(verdict);
    for (const m of missing || []) unscored.add(m);
    usage.input_tokens += u?.input_tokens || 0;
    usage.output_tokens += u?.output_tokens || 0;
    if (samples > 1) console.log(`[judge] sample ${i + 1}/${samples}: overall ${verdict.overall_enjoyment}/5`);
  }

  // Per dimension across samples: the mean, and the spread that says whether the mean
  // means anything.
  const perDimension = {};
  for (const d of DIMENSIONS) {
    const scores = runs.map((r) => r.scores?.[d.key]?.score).filter((s) => typeof s === "number");
    perDimension[d.key] = {
      mean: mean(scores),
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      scores,
      // The evidence from the first sample, which is what a reader wants to see; the
      // other samples' evidence is kept in `runs`.
      evidence: runs[0]?.scores?.[d.key]?.evidence || "",
    };
  }

  const overallScores = runs.map((r) => r.overall_enjoyment).filter((s) => typeof s === "number");
  const summary = {
    judgedAt: new Date().toISOString(),
    engine,
    // Null when every requested sample was scored; otherwise how far it got, and why.
    incomplete,
    model,
    samples,
    screenshots: paths.length,
    unscored: [...unscored],
    turnCount,
    reachedEnding,
    perDimension,
    overall: {
      mean: mean(overallScores),
      min: overallScores.length ? Math.min(...overallScores) : null,
      max: overallScores.length ? Math.max(...overallScores) : null,
    },
    minutesBeforeQuitting: mean(runs.map((r) => r.minutes_before_quitting)),
    recommendRate: runs.length ? runs.filter((r) => r.would_recommend).length / runs.length : null,
    // Free text from the first sample: these are for a person to read and act on, and
    // averaging prose is not a thing.
    whatISaw: runs[0]?.what_i_saw || "",
    bestMoment: runs[0]?.best_moment || "",
    biggestProblem: runs[0]?.biggest_problem || "",
    allProblemsNamed: runs.map((r) => r.biggest_problem).filter(Boolean),
    runs,
    usage,
  };

  if (outDir) await writeFile(path.join(outDir, "verdict.json"), JSON.stringify(summary, null, 2));
  return summary;
}

/** Renders the verdict and the objective counters side by side for a terminal. */
export function formatReport(summary, metrics) {
  const lines = [];
  const bar = (v) => (v === null ? "  ?  " : "█".repeat(Math.round(v)) + "·".repeat(5 - Math.round(v)));
  const spread = (d) => (d.min === d.max || d.min === null ? "" : ` (${d.min}-${d.max})`);

  lines.push("");
  lines.push("=== how much would someone enjoy this ===");
  if (summary.incomplete) {
    lines.push("");
    lines.push(
      `  !! INCOMPLETE: only ${summary.incomplete.got} of ${summary.incomplete.wanted} judge samples were ` +
        "scored, so there is no spread to read."
    );
    lines.push(`     ${summary.incomplete.reason}`);
    lines.push("     Re-score with: node eval/play-and-judge.mjs --judge-only <this run> --samples N");
  }
  lines.push("");
  let group = null;
  for (const d of DIMENSIONS) {
    if (d.group !== group) {
      group = d.group;
      lines.push(`  ${group}`);
    }
    const s = summary.perDimension[d.key];
    lines.push(
      `    ${d.key.padEnd(17)} ${bar(s.mean)} ${s.mean === null ? "?" : s.mean.toFixed(1)}${spread(s)}`
    );
  }
  lines.push("");
  lines.push(
    `  OVERALL           ${bar(summary.overall.mean)} ` +
      `${summary.overall.mean === null ? "?" : summary.overall.mean.toFixed(1)}/5` +
      (summary.overall.min === summary.overall.max ? "" : ` (${summary.overall.min}-${summary.overall.max})`)
  );
  lines.push(
    `  would play for      ~${summary.minutesBeforeQuitting === null ? "?" : Math.round(summary.minutesBeforeQuitting)} min before stopping`
  );
  lines.push(`  would recommend     ${summary.recommendRate === null ? "?" : `${Math.round(summary.recommendRate * 100)}%`} of samples`);

  lines.push("");
  lines.push(`  best moment     ${summary.bestMoment}`);
  lines.push(`  biggest problem ${summary.biggestProblem}`);

  if (metrics) {
    lines.push("");
    lines.push("=== what was measured, independently of the judge ===");
    lines.push("");
    lines.push(`  turns played            ${metrics.turns}${metrics.reachedEnding ? " (reached an ending)" : " (no ending)"}`);
    lines.push(
      `  player engagement       ${metrics.engagementMean === null ? "?" : metrics.engagementMean.toFixed(1)}/5 mean, ` +
        `worst turn ${metrics.engagementMin ?? "?"}`
    );
    lines.push(
      `  choices felt samey on   ${metrics.sameyChoiceRate === null ? "?" : `${Math.round(metrics.sameyChoiceRate * 100)}% of turns`}`
    );
    lines.push(`  turns with confusion    ${metrics.confusedTurns}`);
    lines.push(`  unreadable choices on   ${metrics.unreadableChoiceTurns} turn(s)`);
    lines.push(`  progress went backwards ${metrics.progressReversals} time(s)`);
    const movers = Object.entries(metrics.statMovement || {});
    if (movers.length) {
      lines.push("  tracked stats:");
      for (const [key, m] of movers) {
        lines.push(`    ${key.padEnd(22)} moved on ${m.changes}/${Math.max(m.observations - 1, 0)} transitions`);
      }
    }
    lines.push(
      `  carrying pressure       ${metrics.pressureStats.length ? metrics.pressureStats.join(", ") : "NOTHING — no stat moved consistently"}`
    );

    // The cross-check this whole two-instrument design exists for.
    const stakes = summary.perDimension.stakes?.mean;
    if (stakes !== null && stakes >= 4 && !metrics.pressureStats.length) {
      lines.push("");
      lines.push(
        `  !! the judge scored stakes ${stakes.toFixed(1)}/5 but no tracked stat moved consistently —`
      );
      lines.push("     the prose is asserting pressure the mechanics never apply.");
    }
    const agency = summary.perDimension.agency?.mean;
    if (agency !== null && agency >= 4 && metrics.sameyChoiceRate !== null && metrics.sameyChoiceRate >= 0.4) {
      lines.push("");
      lines.push(
        `  !! the judge scored agency ${agency.toFixed(1)}/5 but the player found the choices ` +
          `interchangeable on ${Math.round(metrics.sameyChoiceRate * 100)}% of turns —`
      );
      lines.push("     consequences may be narrated after the fact rather than offered as a real decision.");
    }
  }

  return lines.join("\n");
}
