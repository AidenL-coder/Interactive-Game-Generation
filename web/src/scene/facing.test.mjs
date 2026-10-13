// Scripted camera moves used to face exactly away from their target — a dot product of
// -1, from orienting a plain Object3D and copying its rotation onto the camera. Nothing
// errored; the player just walked backwards to everything. This pins the direction.
// Run with: npm test
import * as THREE from "three";
import { facingQuaternion, stopDistanceFor, STOP_MIN, STOP_MAX } from "./facing.js";

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

/** Where a camera with this orientation, at `from`, is actually looking. */
function lookDirection(from, q) {
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(from);
  cam.quaternion.copy(q);
  cam.updateMatrixWorld();
  return cam.getWorldDirection(new THREE.Vector3());
}

function facingDot(from, target) {
  const dir = lookDirection(from, facingQuaternion(from, target));
  const want = new THREE.Vector3(target.x - from.x, 0, target.z - from.z).normalize();
  return dir.dot(want);
}

console.log("\n--- the camera faces what it turns to ---");
const eye = new THREE.Vector3(0, 1.7, 0);
for (const [name, target] of [
  ["straight ahead (-z)", { x: 0, z: -10 }],
  ["behind (+z)", { x: 0, z: 10 }],
  ["to the right (+x)", { x: 10, z: 0 }],
  ["to the left (-x)", { x: -10, z: 0 }],
  ["on a diagonal", { x: 6, z: -8 }],
]) {
  const dot = facingDot(eye, target);
  check(`faces a target ${name}`, dot > 0.999, `dot ${dot.toFixed(3)}`);
}

console.log("\n--- the regression, reproduced and ruled out ---");
{
  // Exactly what the playback code used to do.
  const target = new THREE.Vector3(0, 1.7, -10);
  const look = new THREE.Object3D();
  look.position.copy(eye);
  look.lookAt(target);
  const old = lookDirection(eye, look.quaternion).dot(new THREE.Vector3(0, 0, -1));
  check("the old approach really did face away (dot -1)", old < -0.999, `dot ${old.toFixed(3)}`);
  check("the new one faces toward (dot +1)", facingDot(eye, { x: 0, z: -10 }) > 0.999);
}

console.log("\n--- level gaze ---");
{
  // A short object far below eye level must not tip the view into the floor.
  const dir = lookDirection(eye, facingQuaternion(eye, { x: 0, z: -3, y: 0 }));
  check("the gaze stays level whatever the target's height", Math.abs(dir.y) < 1e-6, `y ${dir.y}`);
}
{
  const high = new THREE.Vector3(5, 9, -2);
  const dir = lookDirection(high, facingQuaternion(high, { x: 5, z: -12 }));
  check("level from any eye height", Math.abs(dir.y) < 1e-6);
  check("and still toward the target", dir.z < -0.999);
}

console.log("\n--- degenerate input ---");
{
  const q = facingQuaternion(eye, { x: 0, z: 0 });
  check("looking at your own position gives a valid orientation", [q.x, q.y, q.z, q.w].every(Number.isFinite));
}

console.log("\n--- where a scripted walk stops ---");
{
  // Read straight from the shared contract, so if the reach radius ever changes this
  // test fails instead of the game quietly leaving story-walked choices locked.
  const { INTERACT_RADIUS } = await import("../../../shared/worldState.js");
  check("the stop distance is always within reach of the object", STOP_MAX < INTERACT_RADIUS, `${STOP_MAX} vs ${INTERACT_RADIUS}`);
  check("a person is approached to conversation distance", stopDistanceFor(1.85) === STOP_MIN);
  check("a tall object is approached from further away", stopDistanceFor(4.4) > stopDistanceFor(1.85));
  check("but never beyond reach", stopDistanceFor(40) === STOP_MAX);
  check("never closer than the minimum, even for something tiny", stopDistanceFor(0.3) === STOP_MIN);
  check("a missing height is survivable", stopDistanceFor(undefined) === STOP_MIN);
  // The case that was reported: a 4.4-unit press, previously stopped at 2.2.
  check("the press is no longer approached nose-first", stopDistanceFor(4.4) > 2.2 * 1.4, String(stopDistanceFor(4.4)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
