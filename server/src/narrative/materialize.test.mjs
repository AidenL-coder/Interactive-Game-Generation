// A 3D delta turn has to be turned back into a full world state, and for a long time it
// was turned into the wrong one: the scene was rebuilt as `{ biome, mood, time_of_day,
// props }`, the shape from before the fixed biome vocabulary was removed. Every delta
// turn therefore silently dropped `scene.environment`, and every lighting change the
// model asked for was discarded. Nothing visibly broke — the renderer applies a delta
// without re-reading the environment — which is exactly why it needs a test rather than
// a screenshot. Run with: npm test
import { materializeDeltaTurn } from "./generateScene.js";

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

const ENV = {
  description: "a vast navy machine hall",
  ground_cover: "paper-cream tiles",
  palette: { ground: "#e9e0cc", fog: "#1b2240", light: "#f3ead9", ambient: "#3a4470" },
  light_level: 0.7,
  visibility: 0.75,
};
const LAST = {
  scene: {
    environment: ENV,
    props: [
      { id: "press", label: "a press", form: "tall", x: -7, z: -7 },
      { id: "bin", label: "a bin", form: "small", x: 4, z: -5 },
    ],
  },
};

console.log("\n--- the environment survives a delta turn ---");
{
  const out = materializeDeltaTurn({ narrative: "x", scene_delta: { move: [{ id: "bin", x: 1, z: -3 }] } }, LAST);
  check("environment is present", Boolean(out.scene.environment));
  check("its description carries forward", out.scene.environment.description === ENV.description);
  check("its ground cover carries forward", out.scene.environment.ground_cover === ENV.ground_cover);
  check("its palette carries forward", out.scene.environment.palette.fog === "#1b2240");
  check("no pre-refactor biome field reappears", !("biome" in out.scene));
  check("no pre-refactor time_of_day field reappears", !("time_of_day" in out.scene));
  check("the move is applied", out.scene.props.find((p) => p.id === "bin").x === 1);
  check("it is not a relocation", out.relocated === false);
}

console.log("\n--- an ambient shift is actually applied ---");
{
  const out = materializeDeltaTurn(
    { narrative: "x", scene_delta: { ambient: { light_level: 0.2, palette: { fog: "#000000" } } } },
    LAST
  );
  check("light_level changes", out.scene.environment.light_level === 0.2);
  check("visibility is left alone when not given", out.scene.environment.visibility === 0.75);
  check("the palette entry given changes", out.scene.environment.palette.fog === "#000000");
  check("the palette entries not given survive", out.scene.environment.palette.light === "#f3ead9");
  check("the description is untouched by an ambient shift", out.scene.environment.description === ENV.description);
  check("the input is not mutated", LAST.scene.environment.light_level === 0.7 && LAST.scene.environment.palette.fog === "#1b2240");
}

console.log("\n--- no delta at all means nothing changed ---");
{
  const out = materializeDeltaTurn({ narrative: "a quiet conversation" }, LAST);
  check("the environment carries forward intact", out.scene.environment.description === ENV.description);
  check("the props carry forward intact", out.scene.props.length === 2);
  check("scene_delta is null, not undefined", out.scene_delta === null);
}

console.log("\n--- a full scene is a relocation ---");
{
  const scene = { environment: { ...ENV, description: "an observatory" }, props: [] };
  const out = materializeDeltaTurn({ narrative: "x", scene }, LAST);
  check("it is marked relocated", out.relocated === true);
  check("the new scene is used as-is", out.scene.environment.description === "an observatory");
  check("scene_delta is cleared", out.scene_delta === null);
}

console.log("\n--- no previous world ---");
{
  const out = materializeDeltaTurn({ narrative: "x", scene_delta: {} }, null);
  check("survives a missing previous world", Array.isArray(out.scene.props) && typeof out.scene.environment === "object");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
