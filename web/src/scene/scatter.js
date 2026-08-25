import * as THREE from "three";
import { GROUND_HALF_EXTENT } from "iwg-shared";
import { heightAt, makeRng } from "./terrain.js";

// Environmental dressing, as distinct from the LLM's narrative props. The model authors
// ~14 meaningful, labelled, referenceable objects; this fills the other 1600 square
// units with hundreds of instances of biome-appropriate clutter so the world reads as a
// place rather than a diorama. All procedural: no API calls, no tokens, no latency.
//
// Everything here uses InstancedMesh, so several hundred objects cost a handful of draw
// calls. Scatter is deterministic given the scene seed, and is deliberately NOT part of
// the WorldState — it carries no narrative meaning and nothing can reference it, which
// keeps it out of the spatial-consistency measurements.

const HORIZON_INNER = GROUND_HALF_EXTENT + 4;
const HORIZON_OUTER = GROUND_HALF_EXTENT + 26;

// Per-biome recipe: what to scatter, how much, and how big. Counts are tuned so open
// biomes stay walkable while dense ones feel overgrown.
const BIOME_SCATTER = {
  forest: {
    ground: 0x2f4a2f,
    tufts: { count: 420, color: 0x4a7a3a, size: [0.25, 0.6] },
    shrubs: { count: 120, color: 0x2e5b30, size: [0.5, 1.1] },
    stones: { count: 70, color: 0x6b6459, size: [0.2, 0.5] },
    canopy: { count: 90, color: 0x24471f, size: [1.6, 3.4] },
    horizonColor: 0x1e3a1e,
  },
  desert: {
    ground: 0xc2a15c,
    tufts: { count: 130, color: 0xa89253, size: [0.2, 0.45] },
    shrubs: { count: 40, color: 0x8a7a45, size: [0.3, 0.7] },
    stones: { count: 160, color: 0xa38b5e, size: [0.2, 0.7] },
    canopy: { count: 8, color: 0x6b5f3a, size: [1.2, 2.2] },
    horizonColor: 0x9c8250,
  },
  ruins: {
    ground: 0x6b6459,
    tufts: { count: 220, color: 0x5f6b45, size: [0.2, 0.5] },
    shrubs: { count: 50, color: 0x4a5b38, size: [0.3, 0.8] },
    stones: { count: 260, color: 0x7d7568, size: [0.2, 0.9] },
    canopy: { count: 22, color: 0x3a4a2e, size: [1.4, 2.6] },
    horizonColor: 0x4f4a42,
  },
  cave: {
    ground: 0x2a2a30,
    tufts: { count: 40, color: 0x3a4a3a, size: [0.15, 0.35] },
    shrubs: { count: 15, color: 0x2a3a2a, size: [0.2, 0.5] },
    stones: { count: 320, color: 0x3d3d46, size: [0.25, 1.1] },
    canopy: { count: 0, color: 0x000000, size: [1, 1] },
    horizonColor: 0x17171c,
  },
  urban: {
    ground: 0x4a4a52,
    tufts: { count: 90, color: 0x4f5b3f, size: [0.15, 0.4] },
    shrubs: { count: 35, color: 0x3a4a35, size: [0.3, 0.8] },
    stones: { count: 190, color: 0x5e5e68, size: [0.2, 0.6] },
    canopy: { count: 18, color: 0x2f4a2f, size: [1.5, 2.8] },
    horizonColor: 0x3a3a42,
  },
  coast: {
    ground: 0xc9b98a,
    tufts: { count: 240, color: 0x8fa35c, size: [0.25, 0.65] },
    shrubs: { count: 45, color: 0x6b7d45, size: [0.3, 0.8] },
    stones: { count: 150, color: 0x9a927e, size: [0.2, 0.8] },
    canopy: { count: 14, color: 0x3f5b35, size: [1.4, 2.6] },
    horizonColor: 0x8a9a86,
  },
  snow: {
    ground: 0xdfe6ea,
    tufts: { count: 90, color: 0xc4cfd4, size: [0.2, 0.5] },
    shrubs: { count: 40, color: 0x9fb0ae, size: [0.3, 0.8] },
    stones: { count: 130, color: 0xb5bfc4, size: [0.2, 0.7] },
    canopy: { count: 45, color: 0x5b6b60, size: [1.5, 3.0] },
    horizonColor: 0xb9c6cc,
  },
  swamp: {
    ground: 0x3a4230,
    tufts: { count: 380, color: 0x55613a, size: [0.3, 0.8] },
    shrubs: { count: 100, color: 0x3f4a2e, size: [0.4, 1.0] },
    stones: { count: 60, color: 0x4c5640, size: [0.2, 0.5] },
    canopy: { count: 60, color: 0x2b3a26, size: [1.5, 3.2] },
    horizonColor: 0x2b3524,
  },
};

function recipeFor(biome) {
  return BIOME_SCATTER[biome] || BIOME_SCATTER.ruins;
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

function placeInstances(mesh, count, rng, seed, props, { size, pad, sink = 0, jitterRot = true }) {
  const dummy = new THREE.Object3D();
  const limit = GROUND_HALF_EXTENT - 0.5;
  let placed = 0;
  let attempts = 0;

  while (placed < count && attempts < count * 6) {
    attempts++;
    const x = (rng() * 2 - 1) * limit;
    const z = (rng() * 2 - 1) * limit;
    if (tooCloseToProps(x, z, props, pad)) continue;

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
export function buildScatter(scene, seed) {
  const group = new THREE.Group();
  const recipe = recipeFor(scene.biome);
  const props = scene.props || [];
  const rng = makeRng(seed);

  // Grass/undergrowth: cones read as tufts in bulk and cost 4 triangles each.
  if (recipe.tufts.count) {
    const tufts = instanced(new THREE.ConeGeometry(0.18, 0.5, 4), recipe.tufts.color, recipe.tufts.count);
    placeInstances(tufts, recipe.tufts.count, rng, seed, props, { size: recipe.tufts.size, pad: 1.4, sink: 0.1 });
    group.add(tufts);
  }

  if (recipe.shrubs.count) {
    const shrubs = instanced(new THREE.IcosahedronGeometry(0.5, 0), recipe.shrubs.color, recipe.shrubs.count);
    placeInstances(shrubs, recipe.shrubs.count, rng, seed, props, { size: recipe.shrubs.size, pad: 1.8, sink: 0.35 });
    group.add(shrubs);
  }

  if (recipe.stones.count) {
    const stones = instanced(new THREE.DodecahedronGeometry(0.35, 0), recipe.stones.color, recipe.stones.count);
    placeInstances(stones, recipe.stones.count, rng, seed, props, { size: recipe.stones.size, pad: 1.5, sink: 0.45 });
    group.add(stones);
  }

  // Mid-distance canopy: the thing that actually makes a forest feel like a forest,
  // rather than a lawn with a few trees on it.
  if (recipe.canopy.count) {
    const canopy = instanced(new THREE.ConeGeometry(0.9, 2.6, 6), recipe.canopy.color, recipe.canopy.count);
    placeInstances(canopy, recipe.canopy.count, rng, seed, props, { size: recipe.canopy.size, pad: 3.2, sink: -0.4 });
    group.add(canopy);
  }

  group.add(buildHorizon(recipe, rng, seed));
  return group;
}

// Without this the world visibly stops at an invisible wall. A ring of large silhouettes
// beyond the play area, sunk into fog, reads as landscape continuing past the boundary.
function buildHorizon(recipe, rng, seed) {
  const COUNT = 110;
  const mesh = instanced(new THREE.ConeGeometry(1, 2.4, 5), recipe.horizonColor, COUNT, 1);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < COUNT; i++) {
    const angle = (i / COUNT) * Math.PI * 2 + rng() * 0.25;
    const radius = HORIZON_INNER + rng() * (HORIZON_OUTER - HORIZON_INNER);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const s = 3 + rng() * 7;

    dummy.position.set(x, heightAt(x, z, seed) - 1, z);
    dummy.scale.set(s * (0.6 + rng() * 0.5), s, s * (0.6 + rng() * 0.5));
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
