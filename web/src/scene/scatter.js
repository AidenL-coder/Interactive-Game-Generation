import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUND_HALF_EXTENT } from "iwg-shared";
import { heightAt, makeRng } from "./terrain.js";
import { paletteOf, scatterDensityOf } from "./palette.js";

// Environmental dressing, as distinct from the props the model authors. The model
// describes ~14 meaningful, labelled, referenceable objects; this fills the other 1600
// square units with hundreds of instances of small filler so the world reads as a place
// rather than a diorama. All procedural: no API calls, no tokens, no latency.
//
// Previously this was a hardcoded recipe per biome, which meant every forest was
// literally identical. Density and colour now come from the scene's authored
// environment, so the amount and hue of ground clutter varies per world.
//
// Everything uses InstancedMesh, so several hundred objects cost a handful of draw
// calls. Scatter is deterministic given the scene seed, and is deliberately NOT part of
// the WorldState — it carries no narrative meaning and nothing can reference it, which
// keeps it out of the spatial-consistency measurements.

const DISTANT_INNER = GROUND_HALF_EXTENT + 6;
const DISTANT_OUTER = GROUND_HALF_EXTENT + 30;
const SPAWN_CLEAR_RADIUS = 9;

// Population at scatter_density = 1. Actual counts scale down from here.
const MAX_TUFTS = 420;
const MAX_SHRUBS = 130;
const MAX_STONES = 260;
const MAX_CANOPY = 90;
const MAX_DISTANT = 150;

// Words in the environment description that imply an enclosed space, where a distant
// treeline or skyline would be nonsense.
const ENCLOSED_HINTS = [
  "cave", "cavern", "interior", "indoor", "room", "hall", "corridor", "tunnel",
  "chamber", "basement", "cellar", "vault", "inside", "underground", "mine",
  "cathedral", "nave", "church", "temple", "crypt", "library", "station", "bay",
  "warehouse", "factory", "lab", "bunker", "shaft", "aisle", "atrium", "dome",
];

// Words implying vegetation. Without these the scatter stays mineral — sand, rubble,
// grit — which is what stops a desert or a server room sprouting shrubs.
const VEGETATION_HINTS = [
  "forest", "wood", "jungle", "grass", "meadow", "moss", "fern", "garden", "orchard",
  "swamp", "marsh", "overgrown", "vine", "leaf", "foliage", "tree", "hedge", "field",
];

function mentions(text, words) {
  const t = (text || "").toLowerCase();
  return words.some((w) => t.includes(w));
}

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
  mesh.castShadow = false; // hundreds of shadow casters cost far more than they add
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

// A single cone reads as a traffic cone, not a tree. Merging a trunk and three tapering
// tiers gives instanced background trees a recognisable silhouette for one draw call.
function makeTreeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.11, 0.17, 1.0, 5);
  trunk.translate(0, 0.5, 0);
  parts.push(trunk);

  for (const t of [
    { y: 1.25, r: 0.72, h: 1.15 },
    { y: 1.95, r: 0.55, h: 0.95 },
    { y: 2.5, r: 0.34, h: 0.75 },
  ]) {
    const cone = new THREE.ConeGeometry(t.r, t.h, 6);
    cone.translate(0, t.y, 0);
    parts.push(cone);
  }
  return mergeGeometries(parts, false);
}

function placeInstances(mesh, count, rng, seed, props, spawn, { size, pad, sink = 0 }) {
  const dummy = new THREE.Object3D();
  const limit = GROUND_HALF_EXTENT - 0.5;
  let placed = 0;
  let attempts = 0;

  while (placed < count && attempts < count * 6) {
    attempts++;
    const x = (rng() * 2 - 1) * limit;
    const z = (rng() * 2 - 1) * limit;
    if (tooCloseToProps(x, z, props, pad)) continue;
    // Nothing may spawn on the player's starting position — a large instance landing
    // there filled half the screen on turn one.
    const sx = x - spawn.x;
    const sz = z - spawn.z;
    if (sx * sx + sz * sz < SPAWN_CLEAR_RADIUS * SPAWN_CLEAR_RADIUS) continue;

    const s = size[0] + rng() * (size[1] - size[0]);
    dummy.position.set(x, heightAt(x, z, seed) - sink * s, z);
    dummy.scale.set(s, s * (0.8 + rng() * 0.6), s);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed++, dummy.matrix);
  }

  // Unused slots would otherwise render stacked at the origin as a garbage pile.
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Builds all environmental dressing for a scene.
 * @param {object} scene - WorldState.scene, carrying the authored environment
 * @param {number} seed
 * @param {{x:number,z:number}} spawn - kept clear of clutter
 */
export function buildScatter(scene, seed, spawn = { x: 0, z: 0 }) {
  const group = new THREE.Group();
  const env = scene?.environment;
  const props = scene?.props || [];
  const rng = makeRng(seed);

  const palette = paletteOf(env);
  const density = scatterDensityOf(env);
  const text = `${env?.description || ""} ${env?.ground_cover || ""} ${env?.scatter_cover || ""}`;
  const leafy = mentions(text, VEGETATION_HINTS);
  const enclosed = mentions(text, ENCLOSED_HINTS);

  // Vegetation colour comes from the palette's scatter hue; mineral debris borrows the
  // ground colour so rubble matches the floor it broke off.
  const plantColor = palette.scatter;
  const stoneColor = palette.ground.clone().lerp(new THREE.Color(0xffffff), 0.12);

  const n = (max) => Math.round(max * density);

  // Low ground cover. Leafy places get tufts; bare ones get more loose debris instead.
  const tuftCount = leafy ? n(MAX_TUFTS) : n(MAX_TUFTS * 0.25);
  if (tuftCount > 0) {
    const tufts = instanced(new THREE.ConeGeometry(0.18, 0.5, 4), plantColor, tuftCount);
    placeInstances(tufts, tuftCount, rng, seed, props, spawn, { size: [0.25, 0.6], pad: 1.4, sink: 0.1 });
    group.add(tufts);
  }

  const shrubCount = leafy ? n(MAX_SHRUBS) : n(MAX_SHRUBS * 0.2);
  if (shrubCount > 0) {
    const shrubs = instanced(new THREE.IcosahedronGeometry(0.5, 0), plantColor, shrubCount);
    placeInstances(shrubs, shrubCount, rng, seed, props, spawn, { size: [0.45, 1.0], pad: 1.8, sink: 0.35 });
    group.add(shrubs);
  }

  const stoneCount = leafy ? n(MAX_STONES * 0.35) : n(MAX_STONES);
  if (stoneCount > 0) {
    const stones = instanced(new THREE.DodecahedronGeometry(0.35, 0), stoneColor, stoneCount);
    placeInstances(stones, stoneCount, rng, seed, props, spawn, { size: [0.2, 0.8], pad: 1.5, sink: 0.45 });
    group.add(stones);
  }

  // Mid-distance trees, only where vegetation makes sense and the sky is visible.
  if (leafy && !enclosed) {
    const canopyCount = n(MAX_CANOPY);
    if (canopyCount > 0) {
      const canopy = instanced(makeTreeGeometry(), plantColor.clone().multiplyScalar(0.6), canopyCount);
      placeInstances(canopy, canopyCount, rng, seed, props, spawn, { size: [1.0, 1.8], pad: 5.5 });
      group.add(canopy);
      // Art comes from what the model said grows here, not a hardcoded tree — otherwise
      // an overgrown space station sprouts oak trees.
      upgradeCanopyToBillboards(group, canopy, env?.scatter_cover || env?.ground_cover);
    }
  }

  // Without a distant band the world visibly stops at an invisible wall — but indoors
  // there should be no horizon at all.
  if (!enclosed) {
    const distantCount = leafy ? MAX_DISTANT : Math.round(MAX_DISTANT * 0.35);
    group.add(buildDistantScenery(distantCount, palette, rng, seed));
  }

  return group;
}

// Replaces the placeholder cone forest with billboards carrying the same painted tree
// artwork the props use, so background and foreground don't read as two different games.
// Imported lazily to avoid a circular import with propSprites.
async function upgradeCanopyToBillboards(group, placeholder, cover) {
  const { propSprite } = await import("./propSprites.js");
  const subject = cover?.trim()
    ? `a large clump of ${cover}, growing tall`
    : "a full leafy tree with a thick trunk";
  const loaded = await propSprite("tall", subject);
  if (!loaded || !placeholder.parent) return;

  const count = placeholder.count;
  const a = new THREE.PlaneGeometry(1, 1);
  a.translate(0, 0.5, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);

  const mesh = new THREE.InstancedMesh(
    mergeGeometries([a, b], false),
    new THREE.MeshStandardMaterial({
      map: loaded.texture,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.9,
      emissive: 0x0a0f08,
    }),
    count
  );
  mesh.receiveShadow = true;

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

// Far enough out that fog carries most of the effect and the band stays small on screen.
function buildDistantScenery(count, palette, rng, seed) {
  const color = palette.fog.clone().lerp(palette.scatter, 0.55);
  const mesh = instanced(new THREE.ConeGeometry(1, 2.2, 5), color, count, 1);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rng() * 0.4;
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
