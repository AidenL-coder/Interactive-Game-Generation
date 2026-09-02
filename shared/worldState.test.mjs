// Regression coverage for the WorldState contract. Schema validity is itself a metric
// this project reports (docs/research.md), so a silent break here would corrupt eval
// numbers rather than crash anything — hence tests, kept dependency-free to match the
// rest of the repo. Run with: npm test
import { validateWorldState, validateDeltaTurn, applySceneDelta } from "./worldState.js";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

function props(n, prefix = "p") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, label: "a mossy boulder", form: "small", x: i, z: 0,
  }));
}
const choices = [{ id: "a", text: "A" }, { id: "b", text: "B" }];

// There is no biome/mood/time vocabulary any more — the model authors the environment,
// so the tests assert structure (present, in range, parseable colours) rather than
// membership of a fixed list.
const environment = {
  description: "a drowned cathedral nave lit by green water-light",
  ground_cover: "silted flagstones under shallow water",
  palette: { ground: "#3a4a52", fog: "#1e2a30", light: "#a8d8c0", ambient: "#405a64" },
  light_level: 0.4,
  visibility: 0.5,
  scatter_density: 0.3,
};
const baseScene = { environment, props: props(6) };

console.log("\n--- validateWorldState (full scene) ---");
{
  const r = validateWorldState({ narrative: "hi", scene: baseScene, choices });
  check("valid full scene passes", r.valid, JSON.stringify(r.violations));
}
{
  const dup = { ...baseScene, props: [...props(5), { id: "p0", label: "a stone", form: "small", x: 1, z: 1 }] };
  const r = validateWorldState({ narrative: "hi", scene: dup, choices });
  check("duplicate id rejected", !r.valid);
  check("duplicate counted in spatial", r.spatial.duplicateIds === 1, JSON.stringify(r.spatial));
}
{
  const oob = { ...baseScene, props: [...props(5), { id: "zz", label: "a stone", form: "small", x: 999, z: 0 }] };
  const r = validateWorldState({ narrative: "hi", scene: oob, choices });
  check("out-of-bounds counted", r.spatial.outOfBounds === 1, JSON.stringify(r.spatial));
}
{
  const r = validateWorldState({ narrative: "hi", scene: baseScene, choices,
    agent_actions: [{ type: "walk_to", target_id: "nope" }] });
  check("dangling action ref rejected", !r.valid);
  check("dangling counted", r.spatial.danglingRefs === 1, JSON.stringify(r.spatial));
}
{
  const r = validateWorldState({ narrative: "hi", scene: baseScene, choices,
    agent_actions: [{ type: "walk_to", target_id: "p1" }, { type: "say", text: "hello" }] });
  check("valid agent actions pass", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateWorldState({ narrative: "hi", scene: baseScene, choices,
    agent_actions: [{ type: "interact" }] });
  check("interact without target rejected", !r.valid);
}
{
  const r = validateWorldState({ narrative: "hi", scene: baseScene, choices,
    agent_actions: [{ type: "walk_to", x: 3, z: 4 }] });
  check("walk_to with coords (no id) passes", r.valid, JSON.stringify(r.violations));
}

console.log("\n--- validateDeltaTurn ---");
const known = ["p0", "p1", "p2", "p3", "p4", "p5"];
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { move: [{ id: "p1", x: 5, z: 5 }] } }, known);
  check("valid delta passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { move: [{ id: "ghost", x: 1, z: 1 }] } }, known);
  check("move of unknown prop rejected", !r.valid);
  check("dangling counted in delta", r.spatial.danglingRefs === 1, JSON.stringify(r.spatial));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { remove: ["ghost"] } }, known);
  check("remove of unknown prop rejected", !r.valid);
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { add: [{ id: "p0", label: "a tree", form: "tall", x: 1, z: 1 }] } }, known);
  check("add with colliding id rejected", !r.valid);
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { add: [{ id: "new1", label: "a tree", form: "tall", x: 1, z: 1 }] },
    agent_actions: [{ type: "walk_to", target_id: "new1" }] }, known);
  check("action can target prop added same turn", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { remove: ["p0"] },
    agent_actions: [{ type: "walk_to", target_id: "p0" }] }, known);
  check("action targeting removed prop rejected", !r.valid);
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: {}, scene: baseScene }, known);
  check("both delta and scene rejected", !r.valid);
}
{
  // A beat that changes nothing physical (reading a letter, a conversation) is normal.
  // Rejecting it forced the model to invent spurious world churn.
  const r = validateDeltaTurn({ narrative: "n", choices }, known);
  check("no-change turn accepted", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    agent_actions: [{ type: "interact", target_id: "p1" }] }, known);
  check("no-change turn still resolves action targets", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    agent_actions: [{ type: "interact", target_id: "ghost" }] }, known);
  check("no-change turn still catches dangling refs", !r.valid);
}
{
  const r = validateDeltaTurn({ narrative: "n", choices, scene: baseScene }, known);
  check("relocation via full scene passes", r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { remove: ["p0", "p1", "p2"] } }, known);
  check("dropping below MIN_PROPS rejected", !r.valid, JSON.stringify(r.violations));
}
{
  const r = validateDeltaTurn({ narrative: "n", choices,
    scene_delta: { ambient: { light_level: 5 } } }, known);
  check("out-of-range ambient light_level rejected", !r.valid);
}

console.log("\n--- applySceneDelta ---");
{
  const start = props(3);
  const out = applySceneDelta(start, {
    add: [{ id: "new", label: "a tree", form: "tall", x: 2, z: 2 }],
    move: [{ id: "p0", x: 9, z: 9 }],
    remove: ["p1"],
  });
  check("add applied", out.some((p) => p.id === "new"));
  check("move applied", out.find((p) => p.id === "p0").x === 9);
  check("remove applied", !out.some((p) => p.id === "p1"));
  check("input not mutated", start.find((p) => p.id === "p0").x === 0);
  check("count correct", out.length === 3, `got ${out.length}`);
}
{
  const out = applySceneDelta(props(2), { move: [{ id: "ghost", x: 1, z: 1 }] });
  check("move of missing id is a no-op", out.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
