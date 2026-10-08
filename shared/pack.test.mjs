// A pack's whole promise is that nothing has to be generated while someone is waiting.
// That promise is kept by snapToPack overwriting whatever the model wrote with the
// strings the artwork was painted from, so these tests are mostly about one question:
// can a turn survive snapping with every image-bearing string pinned, and does the
// snapper refuse to invent a world when the model wanders off the map. Run with: npm test
import {
  validatePack,
  snapToPack,
  resolvePlace,
  descriptionSimilarity,
  packBriefing,
  repairPackRelocation,
  PLACE_MATCH_THRESHOLD,
  PACK_VERSION,
} from "./pack.js";

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

const PACK = {
  version: PACK_VERSION,
  id: "test-pack",
  title: "A Test Pack",
  blurb: "For tests.",
  premise: "A premise.",
  bible: {
    id: "sty1",
    medium: "m",
    palette: "p",
    light: "l",
    linework: "lw",
    protagonist: "someone",
  },
  stats: [{ key: "air", initial: "full", pressure: true }],
  cast: [
    { id: "keeper", label: "the Keeper, in a grey coat", detail: "She waits.", x: 0.3, depth: 0.5, character: true },
    { id: "wheel", label: "a heavy chrome cutting wheel", detail: "Worn smooth.", x: 0.5, depth: 0.6 },
    { id: "bin", label: "a crate of cream tiles", detail: "One reads 'ing'.", x: 0.7, depth: 0.7 },
    { id: "board", label: "a tall numbered pegboard", detail: "Fifty thousand pegs.", x: 0.9, depth: 0.4 },
    { id: "lamp", label: "a glass lamp projecting points", detail: "Three hundred lit.", x: 0.2, depth: 0.55 },
  ],
  places: [
    {
      id: "yard",
      name: "The Yard",
      teaches: "tokens",
      backdrop: {
        description: "A long industrial receiving yard with benches and a pegboard wall",
        mood: "bright and orderly",
        horizon: 0.58,
        palette: { key: "#fff", shadow: "#000", accent: "#f00" },
        atmosphere: "dust motes",
        atmosphere_intensity: 0.25,
      },
      cast: ["keeper", "wheel", "bin", "board"],
    },
    {
      id: "vault",
      name: "The Vault",
      teaches: "embeddings",
      backdrop: {
        description: "A deep vaulted strongroom lined with brass filing drawers",
        mood: "cool and hushed",
        horizon: 0.64,
        palette: { key: "#eee", shadow: "#111", accent: "#0ff" },
      },
      cast: ["keeper", "lamp"],
    },
  ],
  opening: { place: "yard", playerX: 0.3 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

console.log("\n--- validatePack ---");
check("a well-formed pack validates", validatePack(PACK).length === 0, validatePack(PACK).join("; "));
check("a non-object is rejected", validatePack(null).length > 0);
{
  const p = clone(PACK);
  p.version = 99;
  check("a wrong version is rejected", validatePack(p).some((e) => e.includes("version")));
}
{
  const p = clone(PACK);
  p.id = "Not A Slug";
  check("a non-slug id is rejected", validatePack(p).some((e) => e.includes("lowercase")));
}
{
  const p = clone(PACK);
  delete p.bible.id;
  // Without this every pack's art is filed under "nostyle" and games collide.
  check("a bible with no id is rejected", validatePack(p).some((e) => e.includes("bible.id")));
}
{
  const p = clone(PACK);
  delete p.cast[1].label;
  check("a cast member with no label is rejected", validatePack(p).some((e) => e.includes("label")));
}
{
  const p = clone(PACK);
  p.places[0].cast.push("ghost");
  check(
    "a place referencing an unknown actor is rejected",
    validatePack(p).some((e) => e.includes("unknown actor")),
    validatePack(p).join("; ")
  );
}
{
  const p = clone(PACK);
  p.cast.push({ ...PACK.cast[0] });
  check("a duplicate cast id is rejected", validatePack(p).some((e) => e.includes("duplicate")));
}
{
  const p = clone(PACK);
  p.opening.place = "nowhere";
  check("an opening in a place that does not exist is rejected", validatePack(p).some((e) => e.includes("opening.place")));
}
{
  const p = clone(PACK);
  p.stats = [{ key: "a", initial: "x" }, { key: "b", initial: "y" }];
  check("a pack with no pressure stat is rejected", validatePack(p).some((e) => e.includes("pressure")));
}
{
  const p = clone(PACK);
  p.stats = [
    { key: "a", initial: "x", pressure: true },
    { key: "b", initial: "y", pressure: true },
  ];
  check("two pressure stats are rejected", validatePack(p).some((e) => e.includes("only one")));
}
{
  const p = clone(PACK);
  // The failure this pins: a stat whose value is a bare fraction renders on screen as
  // "0.70" and tells the player nothing.
  p.stats = [{ key: "air", initial: 0.7, pressure: true }];
  check("a numeric stat value is rejected", validatePack(p).some((e) => e.includes("readable string")));
}
{
  const p = clone(PACK);
  p.stats = [1, 2, 3, 4, 5, 6].map((n) => ({ key: `s${n}`, initial: "x", pressure: n === 1 }));
  check("more than five stats is rejected", validatePack(p).some((e) => e.includes("at most 5")));
}

console.log("\n--- descriptionSimilarity ---");
check("identical briefs are 1", descriptionSimilarity("a brass wheel", "a brass wheel") === 1);
check("unrelated briefs are 0", descriptionSimilarity("a brass wheel", "pine forest dusk") === 0);
check("empty is 0", descriptionSimilarity("", "a brass wheel") === 0);
{
  // The realistic case: the model kept the nouns and rewrote everything else.
  const s = descriptionSimilarity(
    "A long industrial yard, benches along one side, a pegboard covering the far wall",
    PACK.places[0].backdrop.description
  );
  check("a paraphrase of a pinned brief scores above threshold", s >= PLACE_MATCH_THRESHOLD, `got ${s.toFixed(2)}`);
}

console.log("\n--- resolvePlace ---");
{
  const r = resolvePlace({ place: "vault", description: "anything at all" }, PACK);
  check("an explicit place id wins", r.place?.id === "vault" && r.by === "id");
}
{
  const r = resolvePlace({ description: "A deep vaulted strongroom lined with brass filing drawers" }, PACK);
  check("a copied description resolves", r.place?.id === "vault" && r.by === "description");
}
{
  const r = resolvePlace({ description: "A rain-lashed clifftop lighthouse above a black sea" }, PACK);
  check("an invented place resolves to nothing", r.place === null && r.by === "none", JSON.stringify(r));
}

console.log("\n--- snapToPack: the image-bearing strings are pinned ---");
{
  const turn = {
    narrative: "You step into the yard.",
    objective: "Find the wheel.",
    progress: 0.2,
    choices: [{ id: "c1", text: "Look at the wheel", requires_near: "wheel" }],
    scene: {
      backdrop: {
        place: "yard",
        // Everything the model wrote here must be discarded: the art was painted from
        // the pinned brief, so a paraphrase would miss the cache and repaint the room.
        description: "a big yard, sort of industrial, with machines around",
        mood: "spooky",
        horizon: 0.4,
        palette: { key: "#123456", shadow: "#654321", accent: "#abcdef" },
      },
      actors: [
        { id: "wheel", label: "a wheel I made up", detail: "invented detail", x: 0.55, depth: 0.62, facing: "left" },
        { id: "keeper", label: "some other woman", x: 0.25, depth: 0.5 },
        { id: "bin", label: "a bin", x: 0.7, depth: 0.7 },
        { id: "board", label: "a board", x: 0.9, depth: 0.4 },
      ],
    },
  };
  const { turn: snapped, placeId, report } = snapToPack(turn, PACK);

  check("the place resolves by id", placeId === "yard" && report.placeResolvedBy === "id");
  check(
    "the backdrop description is replaced with the pinned one",
    snapped.scene.backdrop.description === PACK.places[0].backdrop.description
  );
  check("the backdrop mood is pinned", snapped.scene.backdrop.mood === "bright and orderly");
  check("the backdrop horizon is pinned", snapped.scene.backdrop.horizon === 0.58);
  check("the palette is pinned", snapped.scene.backdrop.palette.key === "#fff");
  check("the place id is stamped on the backdrop", snapped.scene.backdrop.place === "yard");

  const wheel = snapped.scene.actors.find((a) => a.id === "wheel");
  check("an actor's label is replaced with the pinned one", wheel.label === "a heavy chrome cutting wheel");
  check("an actor's detail is replaced with the pinned one", wheel.detail === "Worn smooth.");
  check("the model's staging is kept: x", wheel.x === 0.55);
  check("the model's staging is kept: depth", wheel.depth === 0.62);
  check("the model's staging is kept: facing", wheel.facing === "left");
  check("character flag comes from the pack", snapped.scene.actors.find((a) => a.id === "keeper").character === true);

  check("the prose is untouched", snapped.narrative === "You step into the yard.");
  check("the objective is untouched", snapped.objective === "Find the wheel.");
  check("progress is untouched", snapped.progress === 0.2);
  check("the original turn is not mutated", turn.scene.backdrop.mood === "spooky");
}

console.log("\n--- snapToPack: actors the pack has no art for ---");
{
  const turn = {
    scene: {
      backdrop: { place: "yard" },
      actors: [
        { id: "wheel", label: "x", x: 0.5, depth: 0.6 },
        { id: "keeper", label: "x", x: 0.3, depth: 0.5 },
        { id: "bin", label: "x", x: 0.7, depth: 0.7 },
        { id: "board", label: "x", x: 0.9, depth: 0.4 },
        // There is no artwork for this, so rendering it would put a blank shape on stage.
        { id: "dragon_01", label: "an enormous dragon", x: 0.5, depth: 0.3 },
      ],
    },
  };
  const { turn: snapped, report } = snapToPack(turn, PACK);
  check("an invented actor is dropped", !snapped.scene.actors.some((a) => a.id === "dragon_01"));
  check("the drop is reported", report.invented.includes("dragon_01"));
  check("the real actors survive", snapped.scene.actors.length === 4);
}
{
  // An actor that exists in the pack but belongs to a different room is equally
  // unpaintable here — its art exists, but it has no business in this scene.
  const turn = {
    scene: {
      backdrop: { place: "vault" },
      actors: [
        { id: "keeper", label: "x", x: 0.3, depth: 0.5 },
        { id: "lamp", label: "x", x: 0.2, depth: 0.55 },
        { id: "wheel", label: "x", x: 0.5, depth: 0.6 },
      ],
    },
  };
  const { turn: snapped, report } = snapToPack(turn, PACK);
  check("an actor from another room is dropped", !snapped.scene.actors.some((a) => a.id === "wheel"));
  check("that drop is reported too", report.invented.includes("wheel"));
}

console.log("\n--- snapToPack: a room is never left empty ---");
{
  const turn = { scene: { backdrop: { place: "yard" }, actors: [{ id: "keeper", label: "x", x: 0.3, depth: 0.5 }] } };
  const { turn: snapped, report } = snapToPack(turn, PACK);
  check("missing fixtures are put back", snapped.scene.actors.length === 4, `got ${snapped.scene.actors.length}`);
  check("the restoration is reported", report.addedFromPlace.length === 3);
  check("restored fixtures carry pinned labels", snapped.scene.actors.every((a) => a.label && a.label !== "x"));
}

console.log("\n--- resolvePlace: relocate_to outranks a carried-forward backdrop ---");
{
  // THE bug. On a delta turn the backdrop is carried forward from the previous turn
  // with its place id already stamped on it, so matching on the backdrop alone can only
  // ever return the room the player was already in. A full playthrough walked through
  // four rooms in the prose while the painting stayed in the first one for all fifteen
  // turns, and the only visible symptom was a judge noting that the game's set-pieces
  // "exist only as text".
  const carried = { place: "yard", description: PACK.places[0].backdrop.description };
  const r = resolvePlace(carried, PACK, "vault");
  check("an explicit relocation wins over the stale id", r.place?.id === "vault" && r.by === "relocate", JSON.stringify(r));
}
{
  const carried = { place: "yard" };
  const r = resolvePlace(carried, PACK, null);
  check("no relocation means stay put", r.place?.id === "yard" && r.by === "id");
}
{
  const r = resolvePlace({ place: "yard" }, PACK, "nowhere");
  check("a relocation to a place that does not exist is ignored", r.place?.id === "yard" && r.by === "id");
}

console.log("\n--- snapToPack: relocating ---");
{
  const turn = {
    relocate_to: "vault",
    scene: {
      // Carried forward from the previous turn: the old room and the old cast.
      backdrop: { ...PACK.places[0].backdrop, place: "yard" },
      actors: [
        { id: "wheel", label: "x", x: 0.5, depth: 0.6 },
        { id: "bin", label: "x", x: 0.7, depth: 0.7 },
        { id: "keeper", label: "x", x: 0.3, depth: 0.5 },
      ],
    },
  };
  const { turn: snapped, placeId, report } = snapToPack(turn, PACK, { currentPlaceId: "yard" });

  check("the player actually moves", placeId === "vault");
  check("the backdrop is the new room's", snapped.scene.backdrop.description === PACK.places[1].backdrop.description);
  check("the backdrop palette changes too", snapped.scene.backdrop.palette.accent === "#0ff");
  check("the turn is marked as a relocation", snapped.relocated === true);
  check("the report says so", report.relocated === true);
  // The renderer repaints behind a curtain on `relocated`; without it the new backdrop
  // would appear under the previous room's actors.
  check("the new room arrives fully dressed", snapped.scene.actors.length === PACK.places[1].cast.length, `got ${snapped.scene.actors.length}`);
  check("only the new room's cast is present", snapped.scene.actors.every((a) => PACK.places[1].cast.includes(a.id)));
  check("the lamp is there with its pinned label", snapped.scene.actors.find((a) => a.id === "lamp")?.label === "a glass lamp projecting points");
  // Leaving a room behind is not the model inventing things.
  check("actors left behind are not reported as invented", report.invented.length === 0, JSON.stringify(report.invented));
}
{
  // Relocating to the room you are already in is not a relocation.
  const turn = {
    relocate_to: "yard",
    scene: { backdrop: { place: "yard" }, actors: [{ id: "keeper", label: "x", x: 0.3, depth: 0.5 }] },
  };
  const { turn: snapped, report } = snapToPack(turn, PACK, { currentPlaceId: "yard" });
  check("staying put is not flagged as a relocation", !snapped.relocated && report.relocated === false);
}

console.log("\n--- repairPackRelocation ---");
{
  // The turn as the model writes it: walk out, say where to, list nothing. Left alone
  // this fails the MIN_ACTORS contract check and the whole beat is retried away.
  const turn = { relocate_to: "vault", scene_delta: { remove: ["wheel", "bin", "board"] } };
  const current = [{ id: "wheel" }, { id: "bin" }, { id: "board" }, { id: "keeper" }];
  const { turn: fixed, repaired, placeId } = repairPackRelocation(turn, PACK, current);

  check("it reports the move", repaired === true && placeId === "vault");
  const added = fixed.scene_delta.add.map((a) => a.id).sort();
  check("the new room's cast is added", added.join() === "keeper,lamp", added.join());
  check("added actors carry their pinned labels", fixed.scene_delta.add.every((a) => a.label));
  check("added actors carry their staged positions", fixed.scene_delta.add.every((a) => typeof a.x === "number"));
  check("the old room's fixtures are removed", fixed.scene_delta.remove.includes("wheel"));
  // The Keeper is in both rooms and travels with the player; she must not be removed
  // and re-added, which would make her pop.
  check("an actor in both rooms is not removed", !fixed.scene_delta.remove.includes("keeper"));
}
{
  const turn = { relocate_to: "vault", scene_delta: { add: [{ id: "lamp", label: "x", x: 0.2, depth: 0.5 }] } };
  const { turn: fixed } = repairPackRelocation(turn, PACK, []);
  check("an actor the model already added is not duplicated", fixed.scene_delta.add.filter((a) => a.id === "lamp").length === 1);
}
{
  const { repaired } = repairPackRelocation({ scene_delta: {} }, PACK, []);
  check("a turn that is not relocating is untouched", repaired === false);
}
{
  const { repaired } = repairPackRelocation({ relocate_to: "atlantis" }, PACK, []);
  check("a relocation to nowhere is untouched", repaired === false);
}

console.log("\n--- snapToPack: a place the pack does not have ---");
{
  const turn = {
    scene: {
      backdrop: { description: "A rain-lashed clifftop lighthouse above a black sea", mood: "stormy", horizon: 0.5 },
      actors: [{ id: "keeper", label: "x", x: 0.3, depth: 0.5 }],
    },
  };
  // The player must not be teleported into a room that was never painted; they stay put.
  const { turn: snapped, placeId, report } = snapToPack(turn, PACK, { currentPlaceId: "vault" });
  check("the player stays where they were", placeId === "vault");
  check("the fallback is reported", report.keptPlace === true);
  check("the backdrop is the pinned one, not the invented one", snapped.scene.backdrop.description === PACK.places[1].backdrop.description);
}

console.log("\n--- snapToPack: choices gated on a dropped actor ---");
{
  const turn = {
    choices: [
      { id: "c1", text: "Talk to the dragon", requires_near: "dragon_01" },
      { id: "c2", text: "Look at the wheel", requires_near: "wheel" },
    ],
    scene: {
      backdrop: { place: "yard" },
      actors: [
        { id: "wheel", label: "x", x: 0.5, depth: 0.6 },
        { id: "keeper", label: "x", x: 0.3, depth: 0.5 },
        { id: "bin", label: "x", x: 0.7, depth: 0.7 },
        { id: "board", label: "x", x: 0.9, depth: 0.4 },
        { id: "dragon_01", label: "x", x: 0.5, depth: 0.3 },
      ],
    },
  };
  const { turn: snapped } = snapToPack(turn, PACK);
  // A gate on something that is not on stage can never be satisfied, so the player would
  // be stuck looking at a locked button with nowhere to walk.
  check("a gate on a dropped actor is lifted", snapped.choices[0].requires_near === undefined);
  check("a gate on a present actor survives", snapped.choices[1].requires_near === "wheel");
}

console.log("\n--- snapToPack: the pack's stats are the only stats ---");
{
  const turn = {
    // Taken verbatim from the first pack turn ever generated: three correct stats and
    // one invented nested object of abstract fractions, which renders on the status
    // panel as a meaningless "0.5" and crowds out the stat that is the actual clock.
    state_updates: {
      air: "half gone",
      inferred_preferences: { caution: 0.5, curiosity: 0.6 },
      clue_found_hatch: true,
    },
    scene: { backdrop: { place: "yard" }, actors: [{ id: "keeper", label: "x", x: 0.3, depth: 0.5 }] },
  };
  const { turn: snapped, report } = snapToPack(turn, PACK);
  check("a declared stat survives", snapped.state_updates.air === "half gone");
  check("an invented stat object is dropped", snapped.state_updates.inferred_preferences === undefined);
  check("a one-shot flag is dropped", snapped.state_updates.clue_found_hatch === undefined);
  check("the drops are reported", report.droppedStats.length === 2, JSON.stringify(report.droppedStats));
  check("the original turn is not mutated", turn.state_updates.clue_found_hatch === true);
}
{
  const turn = { state_updates: { air: "full" }, scene: { backdrop: { place: "yard" }, actors: [] } };
  const noStats = { ...PACK, stats: [] };
  const { turn: snapped, report } = snapToPack(turn, noStats);
  check("a pack with no declared stats filters nothing", snapped.state_updates.air === "full");
  check("and reports no drops", report.droppedStats.length === 0);
}

console.log("\n--- snapToPack: degenerate input ---");
{
  const { turn } = snapToPack(null, PACK);
  check("a null turn is returned unchanged", turn === null);
}
{
  const t = { narrative: "no scene here" };
  const { turn } = snapToPack(t, PACK);
  check("a turn with no scene is returned unchanged", turn === t);
}
{
  const t = { scene: { backdrop: { place: "yard" }, actors: [] } };
  const { turn } = snapToPack(t, null);
  check("no pack means no change", turn === t);
}

console.log("\n--- packBriefing ---");
{
  const brief = packBriefing(PACK);
  check("names every place", PACK.places.every((p) => brief.includes(p.id)));
  check("carries each pinned description verbatim", PACK.places.every((p) => brief.includes(p.backdrop.description)));
  check("carries each cast label verbatim", PACK.cast.every((c) => brief.includes(c.label)));
  check("marks who can be talked to", brief.includes("(a person — can be talked to)"));
  check("says not to invent", /may not invent/i.test(brief));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
