// The play-and-judge harness spends real money and several minutes per run, so the parts
// of it that are arithmetic are pinned here instead of being debugged inside a
// playthrough. Two things matter most: that a choice the player read off a screenshot is
// matched to the right button (a mismatch silently corrupts the whole run by playing a
// different game than the one being reported on), and that the objective counters say
// "no data" rather than "zero" when there is no data — a distinction this project has
// already been caught by once. Run with: npm test
import {
  similarity,
  matchChoice,
  mean,
  playMetrics,
  repairVerdictShape,
  MATCH_THRESHOLD,
  DIMENSIONS,
  VERDICT_TOOL,
  dimensionsFor,
  verdictToolFor,
  judgeSystem,
  PLAY_ACTION_TOOL_3D,
  playerSystem3d,
} from "./rubric.mjs";

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

console.log("\n--- similarity ---");
check("identical text is 1", similarity("Open the hatch", "Open the hatch") === 1);
check("unrelated text is 0", similarity("Open the hatch", "Talk to Mara") === 0);
check("case and punctuation do not matter", similarity("Open the hatch.", "open the HATCH") === 1);
check("empty input is 0", similarity("", "Open the hatch") === 0);
check("empty candidate is 0", similarity("Open the hatch", "") === 0);
check(
  "stop words alone do not match",
  similarity("the a to of", "the hatch is open") === 0,
  `got ${similarity("the a to of", "the hatch is open")}`
);

console.log("\n--- similarity: the misreadings a vision player actually makes ---");
{
  // Dropped article: the single most common difference between what is on the button and
  // what the model types back.
  const s = similarity("Open hatch", "Open the hatch");
  check("a dropped article still matches strongly", s > 0.9, `got ${s.toFixed(2)}`);
}
{
  // Quoting the first few words of a long button.
  const s = similarity("Ask Mara about the diver", "Ask Mara about the diver who went down last");
  check("a partial quote of a long button matches", s > 0.6, `got ${s.toFixed(2)}`);
}
{
  // One word guessed wrong under a particle effect.
  const s = similarity("Cut the cable loose", "Cut the cable free");
  check("one wrong word still matches", s > 0.5, `got ${s.toFixed(2)}`);
}
{
  // Two buttons that share most of their words must still be separable.
  const a = similarity("Ask Mara about the wreck", "Ask Mara about the wreck");
  const b = similarity("Ask Mara about the wreck", "Ask Mara about the crew");
  check("the exact button outscores its near neighbour", a > b, `${a.toFixed(2)} vs ${b.toFixed(2)}`);
}

console.log("\n--- similarity: the gate pill is part of the button ---");
{
  // A locked choice wears a green "GO TO <place>" tag under its sentence, and that tag
  // is frequently the most legible thing on the button — the player quotes it instead of
  // the sentence. Matching on the sentence alone reported those reads as unreadable and
  // pressed a different button, which silently played a different game than the one
  // being scored. The harness now matches against sentence + tag together.
  const sentence = "Walk back into the dark behind the lamp's reach to see what cast that second shadow.";
  const visible = `${sentence} GO TO GREEN GLASS SHADE`;
  check(
    "quoting only the gate tag does not match the sentence alone",
    similarity("GO TO GREEN GLASS SHADE", sentence) < MATCH_THRESHOLD
  );
  check(
    "quoting only the gate tag matches sentence + tag",
    similarity("GO TO GREEN GLASS SHADE", visible) >= MATCH_THRESHOLD,
    `got ${similarity("GO TO GREEN GLASS SHADE", visible).toFixed(2)}`
  );
  check(
    "quoting the sentence still matches sentence + tag",
    similarity("Walk back into the dark behind the lamp", visible) >= MATCH_THRESHOLD
  );
}

console.log("\n--- matchChoice ---");
const CHOICES = [
  { text: "Open the hatch and climb down" },
  { text: "Ask Mara about the diver who went down last" },
  { text: "Wait for the tide to turn" },
];
{
  const m = matchChoice("Ask Mara about the diver", CHOICES);
  check("picks the intended button", m.index === 1 && m.matched, JSON.stringify(m));
}
{
  const m = matchChoice("open hatch, climb down", CHOICES);
  check("tolerates reordered punctuation", m.index === 0 && m.matched, JSON.stringify(m));
}
{
  // The important negative case. A player reporting something that is not on screen must
  // be recorded as a miss, not quietly resolved to the closest button — that would hide a
  // legibility defect and play a turn nobody chose.
  const m = matchChoice("Sharpen the harpoon", CHOICES);
  check("an unreadable report is a miss, not a nearest match", !m.matched, JSON.stringify(m));
  check("a miss reports index -1", m.index === -1 || m.score < MATCH_THRESHOLD);
}
{
  const m = matchChoice("anything", []);
  check("no candidates is a miss", !m.matched && m.index === -1);
}
{
  const m = matchChoice("", CHOICES);
  check("an empty report is a miss", !m.matched);
}

console.log("\n--- mean: absent data is not zero ---");
check("averages numbers", mean([1, 2, 3]) === 2);
check("an empty list is null, not 0", mean([]) === null);
check("undefined is null", mean(undefined) === null);
check("non-numbers are ignored", mean([2, null, "x", 4]) === 3);
check("all-zero is 0, not null", mean([0, 0]) === 0);

console.log("\n--- playMetrics ---");
{
  const m = playMetrics([]);
  check("no turns gives null engagement, not 0", m.engagementMean === null);
  check("no turns gives null samey rate, not 0", m.sameyChoiceRate === null);
  check("no turns reached no ending", m.reachedEnding === false);
  check("no turns has no pressure stat", m.pressureStats.length === 0);
}
{
  const turns = [
    { engagement: 4, choices_distinct: true, stats: { air: "full", resolve: "steady" }, progress: 0.1 },
    { engagement: 3, choices_distinct: true, stats: { air: "40 min", resolve: "steady" }, progress: 0.3 },
    { engagement: 3, choices_distinct: false, stats: { air: "22 min", resolve: "steady" }, progress: 0.5 },
    { engagement: 2, choices_distinct: false, stats: { air: "9 min", resolve: "steady" }, progress: 0.7 },
    { engagement: 4, choices_distinct: true, stats: { air: "empty", resolve: "steady" }, progress: 1, ending: true },
  ];
  const m = playMetrics(turns);
  check("counts turns", m.turns === 5);
  check("sees the ending", m.reachedEnding === true);
  check("averages engagement", Math.abs(m.engagementMean - 3.2) < 1e-9, `got ${m.engagementMean}`);
  check("reports the worst turn", m.engagementMin === 2);
  check("measures samey choices", Math.abs(m.sameyChoiceRate - 0.4) < 1e-9, `got ${m.sameyChoiceRate}`);
  check("counts a moving stat's changes", m.statMovement.air.changes === 4);
  check("counts a frozen stat's changes", m.statMovement.resolve.changes === 0);
  check("identifies the stat carrying pressure", m.pressureStats.join() === "air", m.pressureStats.join());
  check("a frozen stat is not pressure", !m.pressureStats.includes("resolve"));
  check("monotonic progress has no reversals", m.progressReversals === 0);
  check("reports final progress", m.finalProgress === 1);
}
{
  // The guard that matters: three observations is not enough to call something pressure,
  // however cleanly it moved. "Changed every turn" over two transitions is arithmetic,
  // not evidence.
  const turns = [
    { stats: { air: "full" } },
    { stats: { air: "half" } },
    { stats: { air: "low" } },
  ];
  const m = playMetrics(turns);
  check("too few observations to certify pressure", m.pressureStats.length === 0, m.pressureStats.join());
}
{
  const turns = [
    { progress: 0.4 },
    { progress: 0.2 },
    { progress: 0.6 },
    { progress: 0.5 },
  ];
  check("counts progress going backwards", playMetrics(turns).progressReversals === 2);
}
{
  const turns = [
    { confusion: "", targetMiss: false },
    { confusion: "  ", targetMiss: false },
    { confusion: "a hatch I cannot see is mentioned", targetMiss: true },
  ];
  const m = playMetrics(turns);
  check("blank confusion does not count", m.confusedTurns === 1);
  check("counts unreadable choices", m.unreadableChoiceTurns === 1);
}

console.log("\n--- repairVerdictShape ---");
{
  // The fully-flat shape the schema now asks for: two scalars per dimension.
  const raw = { what_i_saw: "a game", overall_enjoyment: 3 };
  for (const d of DIMENSIONS) {
    raw[`${d.key}_evidence`] = `saw ${d.key}`;
    raw[d.key] = 3;
  }
  const { verdict, missing, repaired } = repairVerdictShape(raw);
  check("scalar scores are collected", DIMENSIONS.every((d) => verdict.scores[d.key].score === 3));
  check("scalar evidence is paired up", verdict.scores.agency.evidence === "saw agency");
  check("nothing is missing", missing.length === 0);
  check("the canonical shape needs no repair", repaired === false);
  check("the other fields are kept", verdict.overall_enjoyment === 3 && verdict.what_i_saw === "a game");
}
{
  // The object-per-dimension shape an earlier schema asked for.
  const raw = { what_i_saw: "a game" };
  for (const d of DIMENSIONS) raw[d.key] = { evidence: `saw ${d.key}`, score: 4 };
  const { verdict, missing } = repairVerdictShape(raw);
  check("a top-level object per dimension still works", DIMENSIONS.every((d) => verdict.scores[d.key].score === 4));
  check("its evidence survives", verdict.scores.prose.evidence === "saw prose");
  check("and nothing is missing", missing.length === 0);
}
{
  // The leak that broke a whole run: the tool-call markup for the nested object arrived
  // inside the string, and the score spilled out beside it as a stray top-level `score`.
  const raw = {
    what_i_saw: "a game",
    visual_coherence: '\n<parameter name="evidence">Every screenshot uses the same flat palette.</parameter>',
    score: 5,
  };
  const { verdict, missing, repaired } = repairVerdictShape(raw);
  check("the leaked score is recovered", verdict.scores.visual_coherence.score === 5);
  check(
    "the markup is stripped from the evidence",
    verdict.scores.visual_coherence.evidence === "Every screenshot uses the same flat palette.",
    `got "${verdict.scores.visual_coherence.evidence}"`
  );
  check("it is flagged as repaired", repaired === true);
  check("the eight dimensions with nothing at all are reported missing", missing.length === DIMENSIONS.length - 1);
}
{
  const raw = { what_i_saw: "x" };
  for (const d of DIMENSIONS) {
    raw[`${d.key}_evidence`] = "e";
    raw[d.key] = "4"; // a score arriving as a string
  }
  const { verdict, missing } = repairVerdictShape(raw);
  check("a numeric string score is coerced", verdict.scores.stakes.score === 4);
  check("and nothing is reported missing", missing.length === 0);
}
{
  const raw = { what_i_saw: "x" };
  for (const d of DIMENSIONS) raw[d.key] = 9; // out of the 1-5 range the schema declares
  const { verdict } = repairVerdictShape(raw);
  // Out-of-range is kept rather than clamped: a judge ignoring the scale is a fact
  // about the run, and silently rewriting it to 5 would hide that.
  check("an out-of-range score is kept, not clamped", verdict.scores.pacing.score === 9);
}
{
  // The older nested shape must still work.
  const scores = {};
  for (const d of DIMENSIONS) scores[d.key] = { evidence: "e", score: 4 };
  const { verdict, missing, repaired } = repairVerdictShape({ scores, overall_enjoyment: 4 });
  check("a properly nested verdict passes through", DIMENSIONS.every((d) => verdict.scores[d.key].score === 4));
  check("nested is not flagged as repaired", repaired === false);
  check("nested reports nothing missing", missing.length === 0);
}
{
  // The exact shape that broke a real run: `scores` is a bare string, eight dimensions
  // are hoisted to the top level, and the ninth is simply gone. Every dimension printed
  // "?" and the run looked measured when it was not.
  const raw = {
    what_i_saw: "a game",
    scores: "\n",
    overall_enjoyment: 3,
    minutes_before_quitting: 18,
  };
  for (const d of DIMENSIONS) {
    if (d.key === "agency") continue;
    raw[d.key] = { evidence: `saw ${d.key}`, score: 3 };
  }
  const { verdict, missing, repaired } = repairVerdictShape(raw);
  check("the hoisted dimensions are recovered", DIMENSIONS.filter((d) => d.key !== "agency").every((d) => verdict.scores[d.key].score === 3));
  check("a string scores field is discarded", typeof verdict.scores === "object");
  check("the dropped dimension is reported, not invented", missing.length === 1 && missing[0] === "agency");
  check("agency is absent rather than guessed", verdict.scores.agency === undefined);
  check("it is flagged as repaired", repaired === true);
}
{
  const raw = { what_i_saw: "x" };
  for (const d of DIMENSIONS) raw[d.key] = 5; // a bare number instead of {evidence, score}
  const { verdict, missing } = repairVerdictShape(raw);
  check("a bare number is kept as a score", verdict.scores.prose.score === 5);
  check("with empty evidence", verdict.scores.prose.evidence === "");
  check("and nothing reported missing", missing.length === 0);
}
{
  const { verdict, missing } = repairVerdictShape(null);
  check("null is survivable", verdict === null);
  check("and reports everything missing", missing.length === DIMENSIONS.length);
}
{
  const { missing } = repairVerdictShape({ what_i_saw: "nothing scored" });
  check("an empty verdict reports every dimension missing", missing.length === DIMENSIONS.length);
}

console.log("\n--- the verdict schema matches the rubric ---");
{
  const props = VERDICT_TOOL.input_schema.properties;
  const keys = Object.keys(props);
  const required = VERDICT_TOOL.input_schema.required;

  check("every dimension has a scalar score field", DIMENSIONS.every((d) => props[d.key]?.type === "integer"));
  check("every dimension has a scalar evidence field", DIMENSIONS.every((d) => props[`${d.key}_evidence`]?.type === "string"));
  check("both are required", DIMENSIONS.every((d) => required.includes(d.key) && required.includes(`${d.key}_evidence`)));
  check(
    "evidence is declared before its score",
    DIMENSIONS.every((d) => keys.indexOf(`${d.key}_evidence`) < keys.indexOf(d.key))
  );
  check("every dimension has 1/3/5 anchors", DIMENSIONS.every((d) => d.anchors[1] && d.anchors[3] && d.anchors[5]));
  // The anchors are the calibration. If they only live in the system prompt and not on
  // the field the model is filling in, they are much easier to drift away from.
  check("the anchors reach the model on the field itself", DIMENSIONS.every((d) => props[d.key].description.includes(d.anchors[3])));
  check("biggest_problem cannot be omitted", required.includes("biggest_problem"));
  check(
    "the account of what was seen is ordered first",
    keys[0] === "what_i_saw"
  );

  // The invariant this schema was rebuilt twice to reach. A nested object anywhere is
  // what produced a `scores` string with eight dimensions hoisted out of it, and then
  // a dimension whose value was the literal text `<parameter name="evidence">…`. Both
  // times a whole playthrough's scores were lost. Scalars only.
  check("no property is an object", keys.every((k) => props[k].type !== "object"));
  check("no property is an array", keys.every((k) => props[k].type !== "array"));
  check("no property declares sub-properties", keys.every((k) => props[k].properties === undefined));
  check("there is no scores wrapper left", props.scores === undefined);
}

console.log("\n--- the 3D instrument differs from the 2D one only where it must ---");
{
  // The 2D instrument has already produced published-looking numbers, so asking for it
  // must return the very same objects — not equal copies, the same ones.
  check("2D dimensions are the canonical array", dimensionsFor("2d") === DIMENSIONS);
  check("an unknown engine falls back to 2D", dimensionsFor("vr") === DIMENSIONS);
  check("the 2D verdict tool is the canonical tool", verdictToolFor("2d") === VERDICT_TOOL);

  const d3 = dimensionsFor("3d");
  check("3D has the same dimensions in the same order", d3.map((d) => d.key).join() === DIMENSIONS.map((d) => d.key).join());
  check("3D asks the same question of every dimension", d3.every((d, i) => d.question === DIMENSIONS[i].question));
  const nonVisual = DIMENSIONS.filter((d) => d.group !== "visual");
  check(
    "non-visual anchors are identical in 3D",
    nonVisual.every((d) => JSON.stringify(d3.find((x) => x.key === d.key).anchors) === JSON.stringify(d.anchors))
  );
  check(
    "visual anchors are re-written for 3D",
    DIMENSIONS.filter((d) => d.group === "visual").every((d) => d3.find((x) => x.key === d.key).anchors[1] !== d.anchors[1])
  );
  check("no 3D anchor talks about cut-outs", !JSON.stringify(d3).includes("cut-out"));

  const t3 = verdictToolFor("3d");
  const k2 = Object.keys(VERDICT_TOOL.input_schema.properties);
  const k3 = Object.keys(t3.input_schema.properties);
  check("the 3D verdict has exactly the 2D fields, in order", k2.join() === k3.join());
  check("the 3D verdict is scalars only too", k3.every((k) => !["object", "array"].includes(t3.input_schema.properties[k].type)));
  check("the 3D verdict carries the 3D anchors on its fields", t3.input_schema.properties.visual_craft.description.includes("clipping"));

  check("the 3D judge is told it is first-person", /first-person 3D/.test(judgeSystem("3d")));
  check("the 3D judge is not told to look for cut-out fringes", !/Cut-out figures/.test(judgeSystem("3d")));
  check("the 2D judge still is", /Cut-out figures/.test(judgeSystem()));
}

console.log("\n--- the 3D player ---");
{
  const props = Object.keys(PLAY_ACTION_TOOL_3D.input_schema.properties);
  check("the 3D player describes the screen before acting", props[0] === "reading" && props.indexOf("action") > props.indexOf("reading"));
  const actions = PLAY_ACTION_TOOL_3D.input_schema.properties.action.enum;
  for (const a of ["choose", "interact", "move_forward", "turn_left", "turn_right", "strafe_left", "wait"]) {
    check(`the 3D player can ${a.replace("_", " ")}`, actions.includes(a));
  }
  check("the 3D player cannot click the stage (there is none)", !actions.includes("click_stage"));
  check("turns are bounded to a half-circle", PLAY_ACTION_TOOL_3D.input_schema.properties.degrees.maximum === 180);
  const sys = playerSystem3d({ name: "Aiden", interests: ["machines"] });
  check("the 3D player is told about the arrow keys", /arrows? turn|left and right arrows/i.test(sys));
  check("the 3D player is told locked choices need walking to", /dimmed choice|walk over to it/i.test(sys));
  check("the 3D player is told E takes a turn", /E acts on it/.test(sys) && /takes a turn/.test(sys));
  check("the 3D player is still told it is playing for fun", /for your own enjoyment/.test(sys));
}

console.log("\n--- the harness turns at the game's own rate ---");
{
  // A "turn 90°" is a key held for as long as the game takes to turn 90°. If the game's
  // TURN_SPEED changes and this harness does not, every turn the player asks for is
  // silently wrong, and it reads as the player being bad at navigating.
  const { readFileSync } = await import("node:fs");
  const game = readFileSync(new URL("../web/src/scene/SceneRenderer.js", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./visionPlayer3d.mjs", import.meta.url), "utf8");
  const gameRate = Number(/const TURN_SPEED = ([\d.]+);/.exec(game)?.[1]);
  const harnessRate = Number(/TURN_DEGREES_PER_SECOND = \(([\d.]+) \* 180\) \/ Math\.PI/.exec(harness)?.[1]);
  check("the game declares a turn speed", Number.isFinite(gameRate), String(gameRate));
  check("the harness turns at the same rate", gameRate === harnessRate, `game ${gameRate} vs harness ${harnessRate}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
