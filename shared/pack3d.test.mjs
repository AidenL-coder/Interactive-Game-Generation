// The 3D half of a pack has the same one job as the 2D half: make sure nothing is ever
// generated while someone is waiting. Every 3D asset is keyed by a label, a form or an
// environment brief, so those must come back from the manifest verbatim however the
// model phrased them. These tests also pin the relocation rules, because the 2D pack lost
// an entire playthrough to a delta turn that could not leave its first room, and the 3D
// path has exactly the same shape. Run with: npm test
import {
  validatePack3d,
  hasWorld3d,
  resolvePlace3d,
  snapToPack3d,
  repairPackRelocation3d,
  packBriefing3d,
  SKY_BRIEF_LIMIT,
  materialMode,
} from "./pack3d.js";
import { MIN_PROPS } from "./worldState.js";

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
const clone = (o) => JSON.parse(JSON.stringify(o));

const ENV_A = {
  description: "a vast navy industrial hall drawn like a technical diagram",
  ground_cover: "paper-cream floor tiles ruled with graphite",
  palette: { ground: "#e9e0cc", fog: "#1b2240", light: "#f3ead9", ambient: "#3a4470" },
  light_level: 0.7,
  visibility: 0.75,
};
const ENV_B = {
  description: "a deep vaulted strongroom lined with brass filing drawers",
  ground_cover: "paper-cream floor with an inlaid circle",
  palette: { ground: "#e3dccb", fog: "#161c36", light: "#e9e2d2", ambient: "#2a3a66" },
  light_level: 0.55,
  visibility: 0.6,
};

const PACK = {
  stats: [{ key: "sentence", initial: "intact", pressure: true }],
  cast: [
    { id: "keeper", label: "the Keeper, in a grey coat", form3d: "humanoid", character: true },
    { id: "press", label: "a tall brass press", form3d: "tall" },
    { id: "wheel", label: "a chrome cutting wheel", form3d: "wide" },
    { id: "bin", label: "a crate of cream tiles", form3d: "small" },
    { id: "board", label: "a numbered pegboard", form3d: "tall" },
    { id: "cabinet", label: "a wall of brass drawers", form3d: "tall" },
    { id: "orrery", label: "an orrery of cyan points", form3d: "tall" },
    { id: "rail", label: "a rail of sine waves", form3d: "wide" },
    { id: "lamp", label: "a glass projecting lamp", form3d: "tall" },
  ],
  places: [
    {
      id: "yard",
      environment3d: ENV_A,
      cast: ["keeper", "press", "wheel", "bin", "board"],
      stage3d: {
        keeper: { x: 1, z: -2 },
        press: { x: -7, z: -7 },
        wheel: { x: -1, z: -9 },
        bin: { x: 4, z: -5 },
        board: { x: 8, z: -10, scale: 1.2 },
      },
    },
    {
      id: "vault",
      environment3d: ENV_B,
      cast: ["keeper", "cabinet", "orrery", "rail", "lamp"],
      stage3d: {
        keeper: { x: -1, z: -2 },
        cabinet: { x: -8, z: -8 },
        orrery: { x: 0, z: -11, scale: 1.2 },
        rail: { x: 6, z: -6 },
        lamp: { x: -3, z: -5, scale: 0.6 },
      },
    },
  ],
};

const yardProps = (overrides = {}) =>
  PACK.places[0].cast.map((id) => ({
    id,
    label: `whatever the model wrote for ${id}`,
    form: "small",
    x: 0,
    z: -4,
    ...(overrides[id] || {}),
  }));

console.log("\n--- validatePack3d ---");
check("a well-formed pack validates", validatePack3d(PACK).length === 0, validatePack3d(PACK).join("; "));
check("hasWorld3d sees it", hasWorld3d(PACK));
check("a pack without environments has no 3D world", !hasWorld3d({ places: [{ id: "x" }] }));
{
  const p = clone(PACK);
  p.cast[1].form3d = "enormous";
  check("an unknown form is rejected", validatePack3d(p).some((e) => e.includes("form3d")));
}
{
  const p = clone(PACK);
  p.places[0].environment3d.description = "x".repeat(SKY_BRIEF_LIMIT + 5);
  // Not fatal to render, but the image model never sees the part past the cut.
  check("a sky brief the texture will truncate is flagged", validatePack3d(p).some((e) => e.includes("only reads")));
}
{
  const p = clone(PACK);
  p.places[0].cast = ["keeper", "press", "wheel"];
  // The 3D contract refuses scenes under MIN_PROPS; a room that cannot reach it would
  // fail validation on every single turn spent in it.
  check("a room too small for the 3D contract is rejected", validatePack3d(p).some((e) => e.includes(`at least ${MIN_PROPS}`)));
}
{
  const p = clone(PACK);
  delete p.places[1].stage3d.lamp;
  check("a cast member with nowhere to stand is rejected", validatePack3d(p).some((e) => e.includes('no position for "lamp"')));
}
{
  const p = clone(PACK);
  p.places[0].stage3d.press.x = 99;
  check("a position off the ground plane is rejected", validatePack3d(p).some((e) => e.includes("out of range")));
}
{
  const p = clone(PACK);
  p.places[0].environment3d.palette.fog = "navy";
  check("a palette entry that is not a hex is rejected", validatePack3d(p).some((e) => e.includes("palette.fog")));
}
{
  const p = clone(PACK);
  p.cast[2].label = "a".repeat(170);
  check("a label the geometry endpoint will truncate is rejected", validatePack3d(p).some((e) => e.includes("3D geometry only reads")));
}

console.log("\n--- resolvePlace3d ---");
check("relocate_to wins over a stale carried-forward id", resolvePlace3d({ ...ENV_A, place: "yard" }, PACK, "vault").by === "relocate");
check("a place id resolves", resolvePlace3d({ place: "vault" }, PACK).place?.id === "vault");
check("a copied description resolves", resolvePlace3d({ description: ENV_B.description }, PACK).place?.id === "vault");
check("an invented place resolves to nothing", resolvePlace3d({ description: "a rain-lashed clifftop lighthouse" }, PACK).place === null);

console.log("\n--- snapToPack3d: the asset-bearing strings are pinned ---");
{
  const ws = {
    narrative: "You look around.",
    objective: "Find the wheel.",
    progress: 0.2,
    choices: [{ id: "c1", text: "Look at the wheel", requires_near: "wheel" }],
    scene: {
      environment: { ...ENV_A, place: "yard", description: "a big sort of factory", ground_cover: "concrete" },
      props: yardProps({ wheel: { x: 2.5, z: -6, scale: 1.4 } }),
    },
  };
  const { worldState: out, placeId, report } = snapToPack3d(ws, PACK, { currentPlaceId: "yard" });
  check("stays in the yard", placeId === "yard" && !out.relocated);
  check("the sky brief is pinned", out.scene.environment.description === ENV_A.description);
  check("the ground cover is pinned", out.scene.environment.ground_cover === ENV_A.ground_cover);
  check("the place id is stamped", out.scene.environment.place === "yard");
  const wheel = out.scene.props.find((p) => p.id === "wheel");
  check("a prop label is pinned", wheel.label === "a chrome cutting wheel");
  check("a prop form is pinned (it keys the geometry)", wheel.form === "wide");
  check("the model's position is kept", wheel.x === 2.5 && wheel.z === -6);
  check("the model's scale is kept", wheel.scale === 1.4);
  check("the character flag comes from the pack", out.scene.props.find((p) => p.id === "keeper").character === true);
  check("a non-character is not flagged", !out.scene.props.find((p) => p.id === "bin").character);
  check("the prose is untouched", out.narrative === "You look around." && out.objective === "Find the wheel.");
  check("every prop was snapped", report.snappedLabels === 5);
  check("the input is not mutated", ws.scene.environment.ground_cover === "concrete");
}

console.log("\n--- snapToPack3d: invented props and the minimum ---");
{
  const ws = {
    scene: {
      environment: { place: "yard" },
      props: [...yardProps().slice(0, 4), { id: "dragon", label: "a dragon", form: "tall", x: 0, z: -3 }],
    },
  };
  const { worldState: out, report } = snapToPack3d(ws, PACK, { currentPlaceId: "yard" });
  check("an invented prop is dropped", !out.scene.props.some((p) => p.id === "dragon"));
  check("the drop is reported", report.invented.includes("dragon"));
  // Dropping it left four; the 3D contract needs five, so the room is topped up.
  check(`the room is topped back up to ${MIN_PROPS}`, out.scene.props.length === MIN_PROPS, `got ${out.scene.props.length}`);
  check("the refill is reported", report.addedFromPlace.length === 1);
  const refilled = out.scene.props.find((p) => p.id === report.addedFromPlace[0]);
  check("a refilled prop stands where the manifest stages it", refilled.x === PACK.places[0].stage3d[refilled.id].x);
}
{
  const ws = {
    scene: {
      environment: { place: "yard" },
      props: [...yardProps(), { id: "lamp", label: "x", form: "tall", x: 0, z: -3 }],
    },
  };
  const { worldState: out, report } = snapToPack3d(ws, PACK, { currentPlaceId: "yard" });
  check("a real prop from the wrong room is dropped", !out.scene.props.some((p) => p.id === "lamp"));
  check("and reported", report.invented.includes("lamp"));
}

console.log("\n--- snapToPack3d: relocation ---");
{
  // The delta carried the yard forward; the model said it moved to the vault.
  const ws = {
    relocate_to: "vault",
    scene_delta: { remove: ["press"] },
    scene: { environment: { ...ENV_A, place: "yard" }, props: yardProps() },
  };
  const { worldState: out, placeId, report } = snapToPack3d(ws, PACK, { currentPlaceId: "yard" });
  check("the player actually moves", placeId === "vault");
  check("the environment is the new room's", out.scene.environment.description === ENV_B.description);
  check("the fog changes with it", out.scene.environment.palette.fog === "#161c36");
  check("it is marked as a relocation so the renderer rebuilds", out.relocated === true);
  check("the stale delta is cleared", out.scene_delta === null);
  check("the new room arrives fully dressed", out.scene.props.length === PACK.places[1].cast.length);
  check("only the new room's props are present", out.scene.props.every((p) => PACK.places[1].cast.includes(p.id)));
  check("props arrive at their staged positions", out.scene.props.find((p) => p.id === "orrery").z === -11);
  check("leaving the old room is not 'invention'", report.invented.length === 0, JSON.stringify(report.invented));
}

console.log("\n--- snapToPack3d: stats, gates and agent actions ---");
{
  const ws = {
    state_updates: { sentence: "eight words", trust_ferris: 0.5, inferred_preferences: { caution: 0.4 } },
    choices: [
      { id: "c1", text: "Talk to the dragon", requires_near: "dragon" },
      { id: "c2", text: "Check the bin", requires_near: "bin" },
    ],
    agent_actions: [
      { type: "walk_to", target_id: "dragon" },
      { type: "walk_to", target_id: "bin" },
      { type: "say", text: "Hm." },
    ],
    scene: { environment: { place: "yard" }, props: [...yardProps(), { id: "dragon", label: "x", form: "tall", x: 0, z: -3 }] },
  };
  const { worldState: out, report } = snapToPack3d(ws, PACK, { currentPlaceId: "yard" });
  // The exact pair of invented stats the very first live 3D turn produced.
  check("a declared stat survives", out.state_updates.sentence === "eight words");
  check("an abstract-fraction stat is dropped", out.state_updates.trust_ferris === undefined);
  check("an invented stat object is dropped", out.state_updates.inferred_preferences === undefined);
  check("the stat drops are reported", report.droppedStats.length === 2);
  check("a gate on a dropped prop is lifted", out.choices[0].requires_near === undefined);
  check("a gate on a present prop survives", out.choices[1].requires_near === "bin");
  check("an agent action aimed at a dropped prop is removed", !out.agent_actions.some((a) => a.target_id === "dragon"));
  check("other agent actions survive", out.agent_actions.length === 2);
}

console.log("\n--- repairPackRelocation3d ---");
{
  const turn = { narrative: "You follow her through.", relocate_to: "vault", scene_delta: { remove: ["press", "wheel"] } };
  const { turn: fixed, repaired, placeId } = repairPackRelocation3d(turn, PACK);
  check("a relocating delta is repaired", repaired && placeId === "vault");
  // A full `scene` is how the 3D contract already says "somewhere new".
  check("it becomes a full-scene turn", Boolean(fixed.scene) && fixed.scene_delta === undefined);
  check("with the new room's environment", fixed.scene.environment.description === ENV_B.description);
  check(`with enough props to pass the contract (${MIN_PROPS}+)`, fixed.scene.props.length >= MIN_PROPS);
  check("with pinned forms", fixed.scene.props.find((p) => p.id === "lamp").form === "tall");
  check("the prose survives", fixed.narrative === "You follow her through.");
}
check("a turn that is not relocating is untouched", repairPackRelocation3d({ scene_delta: {} }, PACK).repaired === false);
check("a relocation to nowhere is untouched", repairPackRelocation3d({ relocate_to: "atlantis" }, PACK).repaired === false);

console.log("\n--- material mode ---");
check("a pack without world3d is textured", materialMode(PACK) === "textured");
check("a flat pack is flat", materialMode({ ...PACK, world3d: { materials: "flat" } }) === "flat");
check("an unknown mode falls back to textured", materialMode({ world3d: { materials: "chrome" } }) === "textured");
check("no pack is textured", materialMode(null) === "textured");
{
  const p = clone(PACK);
  p.world3d = { materials: "chrome" };
  check("an unknown mode is rejected by validation", validatePack3d(p).some((e) => e.includes("world3d.materials")));
}
{
  const p = clone(PACK);
  p.world3d = { materials: "flat" };
  check("a flat pack validates", validatePack3d(p).length === 0, validatePack3d(p).join("; "));
}

console.log("\n--- the room's name reaches the status panel ---");
{
  const named = clone(PACK);
  named.places[1].name = "The Vault";
  const ws = { relocate_to: "vault", scene: { environment: { place: "yard" }, props: yardProps() } };
  const { worldState: out } = snapToPack3d(ws, named, { currentPlaceId: "yard" });
  // Without this the panel shows the sky brief: "A Vast Navy Industrial Hall Drawn Like…"
  check("the environment carries the room's name", out.scene.environment.name === "The Vault");
  const { turn } = repairPackRelocation3d({ relocate_to: "vault", scene_delta: {} }, named);
  check("so does a repaired relocation", turn.scene.environment.name === "The Vault");
}

console.log("\n--- degenerate input ---");
check("no scene is returned unchanged", snapToPack3d({ narrative: "x" }, PACK).worldState.narrative === "x");
check("no pack is returned unchanged", snapToPack3d({ scene: {} }, null).worldState.scene !== undefined);

console.log("\n--- packBriefing3d ---");
{
  const b = packBriefing3d(PACK);
  check("names every place", PACK.places.every((p) => b.includes(p.id)));
  check("carries every sky brief verbatim", PACK.places.every((p) => b.includes(p.environment3d.description)));
  check("carries every label verbatim", PACK.cast.every((c) => b.includes(c.label)));
  check("carries each prop's form", b.includes("[humanoid]") && b.includes("[wide]"));
  check("carries staged positions", b.includes("x=-7 z=-7"));
  check("explains relocate_to", /relocate_to/.test(b));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
