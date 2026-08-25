import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUND_HALF_EXTENT } from "iwg-shared";
import { heightAt, makeRng } from "./terrain.js";
import { propSprite } from "./propSprites.js";

// Environmental dressing, as distinct from the LLM's narrative props. The model authors
// ~14 meaningful, labelled, referenceable objects; this fills the other 1600 square
// units with hundreds of instances of biome-appropriate clutter so the world reads as a
// place rather than a diorama. All procedural: no API calls, no tokens, no latency.
//
// Everything here uses InstancedMesh, so several hundred objects cost a handful of draw
// calls. Scatter is deterministic given the scene seed, and is deliberately NOT part of
// the WorldState — it carries no narrative meaning and nothing can reference it, which
// keeps it out of the spatial-consistency measurements.

// Far enough out that fog carries most of the effect and the band stays small on screen.
const DISTANT_INNER = GROUND_HALF_EXTENT + 6;
const DISTANT_OUTER = GROUND_HALF_EXTENT + 30;

// Must match SceneRenderer's spawn position. Keeping the player's immediate
// surroundings clear means turn one always opens on a readable view of the world
// rather than the inside of a shrub.
const SPAWN_CLEAR_RADIUS = 9;

// Per-biome recipe: what to scatter, how much, and how big. Counts are tuned so open
// biomes stay walkable while dense ones feel overgrown.
const BIOME_SCATTER = {
  forest: {
    ground: 0x2f4a2f,
    tufts: { count: 420, color: 0x4a7a3a, size: [0.25, 0.6] },
    shrubs: { count: 120, color: 0x2e5b30, size: [0.5, 1.1] },
    stones: { count: 70, color: 0x6b6459, size: [0.2, 0.5] },
    canopy: { count: 90, color: 0x24471f, size: [1.1, 1.9] },
    horizonColor: 0x1e3a1e,
    distantCount: 150,
  },
  desert: {
    ground: 0xc2a15c,
    tufts: { count: 130, color: 0xa89253, size: [0.2, 0.45] },
    shrubs: { count: 40, color: 0x8a7a45, size: [0.3, 0.7] },
    stones: { count: 160, color: 0xa38b5e, size: [0.2, 0.7] },
    canopy: { count: 8, color: 0x6b5f3a, size: [0.9, 1.4] },
    horizonColor: 0x9c8250,
    distantCount: 0,
  },
  ruins: {
    ground: 0x6b6459,
    tufts: { count: 220, color: 0x5f6b45, size: [0.2, 0.5] },
    shrubs: { count: 50, color: 0x4a5b38, size: [0.3, 0.8] },
    stones: { count: 260, color: 0x7d7568, size: [0.2, 0.9] },
    canopy: { count: 22, color: 0x3a4a2e, size: [1.0, 1.6] },
    horizonColor: 0x4f4a42,
    distantCount: 70,
  },
  cave: {
    ground: 0x2a2a30,
    tufts: { count: 40, color: 0x3a4a3a, size: [0.15, 0.35] },
    shrubs: { count: 15, color: 0x2a3a2a, size: [0.2, 0.5] },
    stones: { count: 320, color: 0x3d3d46, size: [0.25, 1.1] },
    canopy: { count: 0, color: 0x000000, size: [1, 1] },
    horizonColor: 0x17171c,
    distantCount: 0,
  },
  urban: {
    ground: 0x4a4a52,
    tufts: { count: 90, color: 0x4f5b3f, size: [0.15, 0.4] },
    shrubs: { count: 35, color: 0x3a4a35, size: [0.3, 0.8] },
    stones: { count: 190, color: 0x5e5e68, size: [0.2, 0.6] },
    canopy: { count: 18, color: 0x2f4a2f, size: [1.0, 1.7] },
    horizonColor: 0x3a3a42,
    distantCount: 40,
  },
  coast: {
    ground: 0xc9b98a,
    tufts: { count: 240, color: 0x8fa35c, size: [0.25, 0.65] },
    shrubs: { count: 45, color: 0x6b7d45, size: [0.3, 0.8] },
    stones: { count: 150, color: 0x9a927e, size: [0.2, 0.8] },
    canopy: { count: 14, color: 0x3f5b35, size: [1.0, 1.6] },
    horizonColor: 0x8a9a86,
    distantCount: 55,
  },
  snow: {
    ground: 0xdfe6ea,
    tufts: { count: 90, color: 0xc4cfd4, size: [0.2, 0.5] },
    shrubs: { count: 40, color: 0x9fb0ae, size: [0.3, 0.8] },
    stones: { count: 130, color: 0xb5bfc4, size: [0.2, 0.7] },
    canopy: { count: 45, color: 0x5b6b60, size: [1.0, 1.8] },
    horizonColor: 0xb9c6cc,
    distantCount: 90,
  },
  swamp: {
    ground: 0x3a4230,
    tufts: { count: 380, color: 0x55613a, size: [0.3, 0.8] },
    shrubs: { count: 100, color: 0x3f4a2e, size: [0.4, 1.0] },
    stones: { count: 60, color: 0x4c5640, size: [0.2, 0.5] },
    canopy: { count: 60, color: 0x2b3a26, size: [1.0, 1.8] },
    horizonColor: 0x2b3524,
    distantCount: 120,
  },
};

function recipeFor(biome) {
  return BIOME_SCATTER[biome] || BIOME_SCATTER.ruins;
}

// A single cone reads as a traffic cone, not a tree — which is exactly how the first
// pass looked. Merging a trunk and three tapering tiers into one geometry gives the
// instanced background trees a recognisable silhouette while still costing a single
// draw call for the whole forest.
function makeTreeGeometry() {
  const parts = [];

  const trunk = new THREE.CylinderGeometry(0.11, 0.17, 1.0, 5);
  trunk.translate(0, 0.5, 0);
  parts.push(trunk);

  const tiers = [
    { y: 1.25, r: 0.72, h: 1.15 },
    { y: 1.95, r: 0.55, h: 0.95 },
    { y: 2.5, r: 0.34, h: 0.75 },
  ];
  for (const t of tiers) {
    const cone = new THREE.ConeGeometry(t.r, t.h, 6);
    cone.translate(0, t.y, 0);
    parts.push(cone);
  }

  return mergeGeometries(parts, false);
}

// Keeps clutter from growing through the narrative props, which would look like a bug
// and could visually bury something the story needs the player to find.
function tooCloseToProps(x, z, props, pad) {
  for (const p of props) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz < pad * pad) return true;
  }
  return false;
}

function instanced(geometry, color, count, roughness = 0.9) {
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness, flatShading: true }),
    count
  );
  mesh.castShadow = false; // hundreds of shadow casters costs far more than it adds
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

function placeInstances(mesh, count, rng, seed, props, spawn, { size, pad, sink = 0, jitterRot = true }) {
  const dummy = new THREE.Object3D();
  const limit = GROUND_HALF_EXTENT - 0.5;
  let placed = 0;
  let attempts = 0;

  while (placed < count && attempts < count * 6) {
    attempts++;
    const x = (rng() * 2 - 1) * limit;
    const z = (rng() * 2 - 1) * limit;
    if (tooCloseToProps(x, z, props, pad)) continue;
    // Nothing may spawn on the player's starting position. A large canopy instance
    // landing there filled half the screen with a flat green triangle on turn one.
    const sx = x - spawn.x;
    const sz = z - spawn.z;
    if (sx * sx + sz * sz < SPAWN_CLEAR_RADIUS * SPAWN_CLEAR_RADIUS) continue;

    const s = size[0] + rng() * (size[1] - size[0]);
    dummy.position.set(x, heightAt(x, z, seed) - sink * s, z);
    dummy.scale.set(s, s * (0.8 + rng() * 0.6), s);
    dummy.rotation.set(0, jitterRot ? rng() * Math.PI * 2 : 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed++, dummy.matrix);
  }

  // Unused slots would otherwise render stacked at the origin as a garbage pile.
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Builds all environmental dressing for a scene as a single group.
 * @param {object} scene - WorldState.scene
 * @param {number} seed - from seedFromScene()
 */
export function buildScatter(scene, seed, spawn = { x: 0, z: 0 }) {
  const group = new THREE.Group();
  const recipe = recipeFor(scene.biome);
  const props = scene.props || [];
  const rng = makeRng(seed);

  // Grass/undergrowth: cones read as tufts in bulk and cost 4 triangles each.
  if (recipe.tufts.count) {
    const tufts = instanced(new THREE.ConeGeometry(0.18, 0.5, 4), recipe.tufts.color, recipe.tufts.count);
    placeInstances(tufts, recipe.tufts.count, rng, seed, props, spawn, { size: recipe.tufts.size, pad: 1.4, sink: 0.1 });
    group.add(tufts);
  }

  if (recipe.shrubs.count) {
    const shrubs = instanced(new THREE.IcosahedronGeometry(0.5, 0), recipe.shrubs.color, recipe.shrubs.count);
    placeInstances(shrubs, recipe.shrubs.count, rng, seed, props, spawn, { size: recipe.shrubs.size, pad: 1.8, sink: 0.35 });
    group.add(shrubs);
  }

  if (recipe.stones.count) {
    const stones = instanced(new THREE.DodecahedronGeometry(0.35, 0), recipe.stones.color, recipe.stones.count);
    placeInstances(stones, recipe.stones.count, rng, seed, props, spawn, { size: recipe.stones.size, pad: 1.5, sink: 0.45 });
    group.add(stones);
  }

  // Mid-distance trees: the thing that actually makes a forest feel like a forest,
  // rather than a lawn with a few trees on it. Flat-shaded geometry goes in first so
  // the scene is never bare, then gets replaced by painted billboards using the same
  // artwork as the hero trees — low-poly cones standing next to painted sprites read as
  // two different games.
  if (recipe.canopy.count) {
    const canopy = instanced(makeTreeGeometry(), recipe.canopy.color, recipe.canopy.count);
    placeInstances(canopy, recipe.canopy.count, rng, seed, props, spawn, { size: recipe.canopy.size, pad: 5.5 });
    group.add(canopy);
    upgradeCanopyToBillboards(group, canopy, recipe, seed, props);
  }

  const distant = buildDistantScenery(recipe, rng, seed);
  if (distant) group.add(distant);
  return group;
}

// Two quads crossed at right angles, the classic cheap vegetation billboard. Unlike a
// THREE.Sprite it can be instanced, and unlike a single quad it doesn't vanish when
// viewed edge-on — so it never needs to track the camera.
function makeCrossedPlanes() {
  const a = new THREE.PlaneGeometry(1, 1);
  a.translate(0, 0.5, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  return mergeGeometries([a, b], false);
}

// Swaps the placeholder cone forest for billboards carrying the same painted tree
// artwork the hero props use, reusing each instance's existing transform so nothing
// moves. Silently leaves the cones in place if artwork isn't available.
async function upgradeCanopyToBillboards(group, placeholder, recipe, seed, props) {
  const loaded = await propSprite("tree");
  if (!loaded || !placeholder.parent) return;

  const count = placeholder.count;
  const mesh = new THREE.InstancedMesh(
    makeCrossedPlanes(),
    new THREE.MeshStandardMaterial({
      map: loaded.texture,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.9,
      // Billboards are lit flat; a slight emissive lift keeps them from going muddy
      // against a bright sky when the sun is behind them.
      emissive: 0x0a0f08,
    }),
    count
  );
  mesh.receiveShadow = true;

  // Reuse the placeholder's transforms, correcting for the difference between the cone
  // geometry's proportions and the billboard's aspect.
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    placeholder.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);
    const height = scl.y * 3.2;
    m.compose(pos, quat, new THREE.Vector3(height * loaded.aspect, height, height * loaded.aspect));
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;

  group.add(mesh);
  group.remove(placeholder);
  placeholder.geometry.dispose();
  placeholder.material.dispose();
}

// A ring of cones at the world's edge read as exactly that — a wall of traffic cones
// filling the view, competing with the generated sky behind it. The distant band is now
// pushed far enough out that fog does most of the work, kept low to the ground so it
// sits under the skyline rather than across it, and skipped entirely for biomes where a
// treeline makes no sense (open desert, enclosed cave).
function buildDistantScenery(recipe, rng, seed) {
  if (!recipe.distantCount) return null;

  const mesh = instanced(new THREE.ConeGeometry(1, 2.2, 5), recipe.horizonColor, recipe.distantCount, 1);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < recipe.distantCount; i++) {
    const angle = (i / recipe.distantCount) * Math.PI * 2 + rng() * 0.4;
    const radius = DISTANT_INNER + rng() * (DISTANT_OUTER - DISTANT_INNER);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const s = 1.6 + rng() * 2.0;

    dummy.position.set(x, heightAt(x, z, seed) - 0.8, z);
    dummy.scale.set(s * (0.7 + rng() * 0.4), s, s * (0.7 + rng() * 0.4));
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
