// Regression coverage for the 2D story contract. Schema validity is itself a metric
// this project reports (docs/research.md), so a silent break here would corrupt eval
// numbers rather than crash anything — hence tests, kept dependency-free to match the
// rest of the repo. Run with: npm test
import {
  validateStory,
  validateStoryDelta,
  applyStoryDelta,
  layoutActor,
  withinReach,
  spreadActors,
  findClearX,
  MIN_ACTORS,
  MAX_ACTORS,
} from "./story2d.js";

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

function actors(n, prefix = "a") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    label: "a barnacled mooring post",
    x: 0.1 + i * 0.08,
    depth: 0.5,
  }));
}
const choices = [{ id: "a", text: "A" }, { id: "b", text: "B" }];

const backdrop = {
  description: "the flooded nave of a cathedral, pews half-submerged",
  mood: "cold green water-light, long shadows",
  horizon: 0.62,
  palette: { key: "#a8d8c0", shadow: "#1e2a30", accent: "#d8a03a" },
  atmosphere: "dust motes",
  atmosphere_intensity: 0.4,
};
const baseScene = { backdrop, actors: actors(6), player_x: 0.2 };

console.log("\n--- validateStory (full scene) ---");
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices });
  check("valid full scene passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "  ", scene: baseScene, choices });
  check("blank narrative rejected", !r.valid);
}
{
  const dup = {
    ...baseScene,
    actors: [...actors(5), { id: "a0", label: "another post", x: 0.9, depth: 0.5 }],
  };
  const r = validateStory({ narrative: "hi", scene: dup, choices });
  check("duplicate actor id rejected", !r.valid);
  check("duplicate counted in spatial", r.spatial.duplicateIds === 1, JSON.stringify(r.spatial));
}
{
  const oob = {
    ...baseScene,
    actors: [...actors(5), { id: "z", label: "a post", x: 1.4, depth: 0.5 }],
  };
  const r = validateStory({ narrative: "hi", scene: oob, choices });
  check("x above 1 rejected", !r.valid);
  check("out-of-bounds counted", r.spatial.outOfBounds === 1, JSON.stringify(r.spatial));
}
{
  const oob = {
    ...baseScene,
    actors: [...actors(5), { id: "z", label: "a post", x: 0.5, depth: 1.6 }],
  };
  const r = validateStory({ narrative: "hi", scene: oob, choices });
  check("depth above 1 rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: { ...baseScene, actors: actors(MIN_ACTORS - 1) }, choices });
  check("too few actors rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: { ...baseScene, actors: actors(MAX_ACTORS + 1) }, choices });
  check("too many actors rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: { ...baseScene, player_x: 2 }, choices });
  check("player_x out of range rejected", !r.valid);
}
{
  const bad = { ...backdrop, palette: { key: "not-a-colour", shadow: "#1e2a30", accent: "#d8a03a" } };
  const r = validateStory({ narrative: "hi", scene: { ...baseScene, backdrop: bad }, choices });
  check("non-hex palette entry rejected", !r.valid);
}
{
  const bad = { ...backdrop, horizon: 1.4 };
  const r = validateStory({ narrative: "hi", scene: { ...baseScene, backdrop: bad }, choices });
  check("horizon out of range rejected", !r.valid);
}
{
  const r = validateStory({
    narrative: "hi",
    scene: { ...baseScene, actors: [...actors(5), { id: "z", label: "a lamp", x: 0.5, depth: 0.5, anchor: "ceiling" }] },
    choices,
  });
  check("unknown anchor rejected", !r.valid);
}
{
  const r = validateStory({
    narrative: "hi",
    scene: baseScene,
    choices: [{ id: "a", text: "A", requires_near: "nope_01" }],
  });
  check("choice gated on unknown actor rejected", !r.valid);
  check("dangling gate counted", r.spatial.danglingRefs === 1, JSON.stringify(r.spatial));
}
{
  const r = validateStory({
    narrative: "hi",
    scene: baseScene,
    choices: [{ id: "a", text: "A", requires_near: "a2" }],
  });
  check("choice gated on a real actor passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "the end", scene: baseScene, choices: [], ending: { outcome: "victory", epilogue: "..." } });
  check("ending turn may have zero choices", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "the end", scene: baseScene, ending: { outcome: "defeat", epilogue: "..." } });
  check("ending turn may omit choices entirely", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "mid", scene: baseScene });
  check("non-ending turn must have choices", !r.valid);
}

console.log("\n--- beats ---");
{
  const r = validateStory({
    narrative: "hi",
    scene: baseScene,
    choices,
    beats: [{ type: "walk_to", target_id: "a1" }, { type: "interact", target_id: "a1" }, { type: "say", text: "Hello." }],
  });
  check("valid beats pass", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "walk_to", target_id: "ghost" }] });
  check("beat targeting unknown actor rejected", !r.valid);
  check("dangling beat counted", r.spatial.danglingRefs === 1);
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "walk_to" }] });
  check("walk_to without target or x rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "walk_to", x: 0.7 }] });
  check("walk_to with bare x passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "interact" }] });
  check("interact without target rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "say", text: "  " }] });
  check("say with blank text rejected", !r.valid);
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, beats: [{ type: "teleport", target_id: "a1" }] });
  check("unknown beat type rejected", !r.valid);
}

// The scene as it stood before a delta turn, shared by the speaker and delta blocks.
const known = ["a0", "a1", "a2", "a3", "a4", "a5"];

console.log("\n--- speaker ---");
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, speaker: "a2" });
  check("speaker naming a real actor passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, speaker: "ghost" });
  check("speaker naming an unknown actor rejected", !r.valid);
  check("dangling speaker counted", r.spatial.danglingRefs === 1);
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices });
  check("omitted speaker is fine", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, speaker: "" });
  check("empty speaker is treated as absent", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStory({ narrative: "hi", scene: baseScene, choices, speaker: 7 });
  check("non-string speaker rejected", !r.valid);
}
{
  const r = validateStoryDelta(
    {
      narrative: "hi",
      choices,
      scene_delta: { add: [{ id: "new_01", label: "a stranger", x: 0.8, depth: 0.6, character: true }] },
      speaker: "new_01",
    },
    known
  );
  check("speaker may be an actor added this turn", r.valid, JSON.stringify(r.violations));
}

console.log("\n--- validateStoryDelta ---");
{
  const r = validateStoryDelta({ narrative: "hi", choices }, known);
  check("no-change turn is valid", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStoryDelta(
    { narrative: "hi", choices, scene_delta: { add: [{ id: "new_01", label: "a lantern", x: 0.8, depth: 0.6 }] } },
    known
  );
  check("add passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStoryDelta(
    { narrative: "hi", choices, scene_delta: { add: [{ id: "a0", label: "a duplicate", x: 0.8, depth: 0.6 }] } },
    known
  );
  check("add re-using an existing id rejected", !r.valid);
  check("re-used id counted as duplicate", r.spatial.duplicateIds === 1);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { move: [{ id: "ghost", x: 0.5 }] } }, known);
  check("move of unknown actor rejected", !r.valid);
  check("dangling move counted", r.spatial.danglingRefs === 1);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { move: [{ id: "a1", x: 1.8 }] } }, known);
  check("move out of bounds rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { remove: ["ghost"] } }, known);
  check("remove of unknown actor rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { remove: ["a0", "a1"] } }, known);
  check("removing down to the minimum passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { remove: ["a0", "a1", "a2"] } }, known);
  check("removing below the minimum rejected", !r.valid);
}
{
  const r = validateStoryDelta(
    { narrative: "hi", choices, scene_delta: { restyle: [{ id: "a1", label: "the post, now splintered" }] } },
    known
  );
  check("restyle of a known actor passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { restyle: [{ id: "ghost", label: "x" }] } }, known);
  check("restyle of unknown actor rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { restyle: [{ id: "a1", label: "  " }] } }, known);
  check("restyle with blank label rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { light: { atmosphere_intensity: 3 } } }, known);
  check("atmosphere_intensity out of range rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: { light: { palette: { key: "zzz" } } } }, known);
  check("non-hex light palette rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene_delta: {}, scene: baseScene }, known);
  check("delta and scene together rejected", !r.valid);
}
{
  const r = validateStoryDelta({ narrative: "hi", choices, scene: baseScene }, known);
  check("relocation via full scene passes", r.valid, JSON.stringify(r.violations));
}
{
  // An action may legitimately target something the same turn just added.
  const r = validateStoryDelta(
    {
      narrative: "hi",
      choices,
      scene_delta: { add: [{ id: "new_01", label: "a lantern", x: 0.8, depth: 0.6 }] },
      beats: [{ type: "interact", target_id: "new_01" }],
    },
    known
  );
  check("beat may target an actor added this turn", r.valid, JSON.stringify(r.violations));
}
{
  // ...and must not target one this turn removed.
  const r = validateStoryDelta(
    { narrative: "hi", choices, scene_delta: { remove: ["a5"] }, beats: [{ type: "interact", target_id: "a5" }] },
    known
  );
  check("beat may not target an actor removed this turn", !r.valid);
}

console.log("\n--- applyStoryDelta ---");
{
  const start = actors(5);
  const out = applyStoryDelta(start, { add: [{ id: "n", label: "new", x: 0.9, depth: 0.3 }] });
  check("add appends", out.length === 6 && out.some((a) => a.id === "n"));
  check("add does not mutate the input", start.length === 5);
}
{
  const out = applyStoryDelta(actors(5), { move: [{ id: "a1", x: 0.95 }] });
  check("move updates x", out.find((a) => a.id === "a1").x === 0.95);
  check("move without depth keeps depth", out.find((a) => a.id === "a1").depth === 0.5);
}
{
  const out = applyStoryDelta(actors(5), { move: [{ id: "a1", x: 0.95, depth: 0.1 }] });
  check("move updates depth when given", out.find((a) => a.id === "a1").depth === 0.1);
}
{
  const start = [{ id: "d", label: "an iron door", detail: "shut fast", x: 0.5, depth: 0.5 }];
  const out = applyStoryDelta(start, { restyle: [{ id: "d", label: "the iron door, hanging open" }] });
  check("restyle replaces the label", out[0].label === "the iron door, hanging open");
  check("restyle without detail keeps the old detail", out[0].detail === "shut fast");
}
{
  const out = applyStoryDelta(actors(5), { remove: ["a0", "a4"] });
  check("remove drops actors", out.length === 3 && !out.some((a) => a.id === "a0"));
}
{
  // Order matters: something added and then removed in the same turn is gone.
  const out = applyStoryDelta(actors(5), { add: [{ id: "n", label: "x", x: 0.1, depth: 0.5 }], remove: ["n"] });
  check("add-then-remove in one delta leaves nothing", !out.some((a) => a.id === "n"));
}

console.log("\n--- layout ---");
{
  const far = layoutActor({ id: "f", x: 0.5, depth: 0 }, backdrop);
  const near = layoutActor({ id: "n", x: 0.5, depth: 1 }, backdrop);
  check("far actor sits at the horizon", Math.abs(far.y - backdrop.horizon) < 1e-6, `${far.y}`);
  check("near actor sits at the bottom of frame", Math.abs(near.y - 1) < 1e-6, `${near.y}`);
  check("near actor is drawn larger", near.scale > far.scale);
  check("near actor sorts in front", near.z > far.z);
}
{
  const hanging = layoutActor({ id: "h", x: 0.5, depth: 0.5, anchor: "hanging" }, backdrop);
  check("hanging actor ignores the ground line", hanging.y < backdrop.horizon);
  check("hanging actor sorts above ground actors", hanging.z > layoutActor({ id: "g", x: 0.5, depth: 1 }, backdrop).z);
}
{
  const scaled = layoutActor({ id: "s", x: 0.5, depth: 1, scale: 2 }, backdrop);
  const plain = layoutActor({ id: "p", x: 0.5, depth: 1 }, backdrop);
  check("author scale multiplies depth scale", Math.abs(scaled.scale - plain.scale * 2) < 1e-9);
}
{
  const clamped = layoutActor({ id: "c", x: 5, depth: -3 }, backdrop);
  check("out-of-range layout input is clamped, not NaN", clamped.x === 1 && clamped.y >= backdrop.horizon);
}
{
  // A missing backdrop must still lay out — the renderer draws during generation, before
  // the backdrop has arrived.
  const noBackdrop = layoutActor({ id: "c", x: 0.5, depth: 0.5 }, undefined);
  check("layout tolerates a missing backdrop", Number.isFinite(noBackdrop.y) && Number.isFinite(noBackdrop.scale));
}

console.log("\n--- spreadActors ---");
{
  // The observed failure: three things authored on top of each other around whatever the
  // scene is "about", rendering as a pile with the important one hidden behind another.
  const piled = [
    { id: "a", x: 0.2, depth: 0.6 },
    { id: "b", x: 0.24, depth: 0.6 },
    { id: "c", x: 0.28, depth: 0.6 },
  ];
  const out = spreadActors(piled);
  const xs = out.map((a) => a.x).sort((p, q) => p - q);
  check("coplanar pile is separated", xs[1] - xs[0] > 0.05 && xs[2] - xs[1] > 0.05, JSON.stringify(xs));
  check("ordering is preserved", out[0].x < out[1].x && out[1].x < out[2].x, JSON.stringify(out.map((a) => a.x)));
  check("input is not mutated", piled[1].x === 0.24);
  check(
    "the group stays near where it was authored",
    Math.abs((xs[0] + xs[2]) / 2 - 0.24) < 0.06,
    JSON.stringify(xs)
  );
}
{
  // Depth layering is the point of the ground plane; things at different depths are
  // supposed to overlap, so they must be left alone.
  const layered = [
    { id: "front", x: 0.5, depth: 0.95 },
    { id: "back", x: 0.52, depth: 0.1 },
  ];
  const out = spreadActors(layered);
  check("actors at different depths are left overlapping", out[0].x === 0.5 && out[1].x === 0.52);
}
{
  const spread = [
    { id: "a", x: 0.1, depth: 0.5 },
    { id: "b", x: 0.5, depth: 0.5 },
    { id: "c", x: 0.9, depth: 0.5 },
  ];
  const out = spreadActors(spread);
  check(
    "an already-spread scene is untouched",
    out.every((a, i) => a.x === spread[i].x),
    JSON.stringify(out.map((a) => a.x))
  );
}
{
  // Everything stacked on one point, more than can comfortably fit: it must still end up
  // on the stage rather than pushed off the edges.
  const out = spreadActors(Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, x: 0.5, depth: 0.7 })));
  check("a total pile-up stays within the stage", out.every((a) => a.x >= 0.03 && a.x <= 0.97), JSON.stringify(out.map((a) => a.x)));
  check("a total pile-up produces distinct positions", new Set(out.map((a) => a.x.toFixed(3))).size >= 6);
}
{
  const out = spreadActors([{ id: "solo", x: 0.5, depth: 0.5 }]);
  check("a single actor is returned unchanged", out.length === 1 && out[0].x === 0.5);
  check("an empty scene does not throw", spreadActors([]).length === 0);
}
{
  // Big things need more room than small ones.
  const big = spreadActors([
    { id: "a", x: 0.4, depth: 0.9, scale: 2.5 },
    { id: "b", x: 0.45, depth: 0.9, scale: 2.5 },
  ]);
  const small = spreadActors([
    { id: "a", x: 0.4, depth: 0.9, scale: 0.3 },
    { id: "b", x: 0.45, depth: 0.9, scale: 0.3 },
  ]);
  check(
    "larger actors are pushed further apart than smaller ones",
    big[1].x - big[0].x > small[1].x - small[0].x
  );
}

console.log("\n--- findClearX ---");
{
  const stage = [
    { id: "a", x: 0.2, depth: 0.6 },
    { id: "b", x: 0.5, depth: 0.6 },
    { id: "c", x: 0.8, depth: 0.6 },
  ];
  const x = findClearX(stage, undefined);
  check("a spawn is found", Number.isFinite(x) && x >= 0 && x <= 1, String(x));
  check(
    "the spawn is clear of every actor",
    stage.every((a) => Math.abs(x - a.x) > 0.08),
    `x=${x}`
  );
}
{
  // The observed failure: the model's own player_x landed inside a prop, so the player
  // was drawn entirely behind it.
  const stage = [
    { id: "case", x: 0.42, depth: 0.7 },
    { id: "b", x: 0.7, depth: 0.5 },
    { id: "c", x: 0.9, depth: 0.5 },
    { id: "d", x: 0.15, depth: 0.5 },
  ];
  const x = findClearX(stage, 0.42);
  check("a spawn inside an actor is rejected", Math.abs(x - 0.42) > 0.05, `x=${x}`);
  check("the replacement is clear", stage.every((a) => Math.abs(x - a.x) > 0.07), `x=${x}`);
}
{
  const stage = [
    { id: "a", x: 0.1, depth: 0.5 },
    { id: "b", x: 0.9, depth: 0.5 },
  ];
  check("an already-clear authored spawn is kept", findClearX(stage, 0.5) === 0.5);
}
{
  check("an empty stage still yields a position", Number.isFinite(findClearX([], undefined)));
  check("a nonsense preferred value is ignored", findClearX([], 42) !== 42);
}
{
  // Everything crammed together: there may be nowhere genuinely clear, but it must still
  // return the least bad spot on the stage rather than something arbitrary or NaN.
  const crowded = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, x: 0.1 + i * 0.1, depth: 0.8 }));
  const x = findClearX(crowded, undefined);
  check("a crowded stage still yields a valid position", x >= 0 && x <= 1, String(x));
}

console.log("\n--- reach ---");
{
  const actor = { id: "a", x: 0.5, depth: 0.5 };
  check("standing on it is in reach", withinReach(0.5, actor));
  check("just beside it is in reach", withinReach(0.53, actor));
  check("across the stage is out of reach", !withinReach(0.9, actor));
  check("reach is wider for near actors", withinReach(0.555, { id: "b", x: 0.5, depth: 1 }) && !withinReach(0.555, { id: "c", x: 0.5, depth: 0 }));
  check("no player position is never in reach", !withinReach(undefined, actor));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
