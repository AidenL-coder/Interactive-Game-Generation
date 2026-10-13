import * as THREE from "three";

// How the camera turns to look at something.
//
// three.js's Object3D.lookAt points a CAMERA's -Z axis at the target but a plain
// Object3D's +Z axis at it. Scripted playback used to orient a plain Object3D and copy its
// rotation onto the camera, which left the camera facing exactly away from its target —
// a dot product of -1 with the direction it meant to face. Every "walk to the Keeper" the
// story asked for turned the player around, walked them backwards to her, and left them
// staring at empty floor; the turn that followed then opened on nothing at all. It was
// found by a judge reporting a frame of empty floor right after the player had walked
// up to someone.
//
// Isolated here, with a test, because the mistake is a one-word difference that reads
// correctly and renders without error.

const _m = new THREE.Matrix4();
const _target = new THREE.Vector3();

// How far from something a scripted walk stops.
//
// This was a fixed 2.2 units for everything. For a person that is a conversation; for a
// press 4.4 units tall it is standing with your nose against it — the frame becomes a
// featureless slab, and a judge reported the eye as being "at knee height". Stopping
// further from taller things keeps them in frame. The upper bound is not about framing:
// a choice gated on an object unlocks within INTERACT_RADIUS (4.5) of it, so a walk the
// story narrates as "you step up to the press" has to finish inside that radius, or the
// choices it was meant to unlock stay locked.
export const STOP_MIN = 3.2;
export const STOP_MAX = 4.2;
// Keep the top of the object about 28° above the level gaze — inside the 35° half-angle
// of the 70° field of view, with a little sky above it.
const FRAME_TOP = Math.tan((28 * Math.PI) / 180);

/**
 * Where a walk toward an object of this height should stop, measured from its centre.
 *
 * @param {number} height - the object's height in world units
 * @param {number} [eyeHeight]
 */
export function stopDistanceFor(height, eyeHeight = 1.7) {
  const h = Number.isFinite(height) ? height : 0;
  const framing = (h - eyeHeight) / FRAME_TOP;
  return Math.min(Math.max(framing, STOP_MIN), STOP_MAX);
}

/**
 * The camera orientation that looks level at `target` from `from`.
 *
 * Level, not pitched: the target's own height is ignored, so walking up to a short object
 * does not tip the view down into the floor. Matrix4.lookAt(eye, target, up) is the
 * camera convention — the same call three.js makes inside camera.lookAt.
 *
 * @param {THREE.Vector3} from - the camera position
 * @param {{x: number, z: number}} target
 * @param {THREE.Vector3} [up]
 * @returns {THREE.Quaternion}
 */
export function facingQuaternion(from, target, up = new THREE.Vector3(0, 1, 0)) {
  _target.set(target.x, from.y, target.z);
  // Looking at your own position has no direction; keep a valid orientation instead of NaN.
  if (_target.distanceToSquared(from) < 1e-9) return new THREE.Quaternion();
  _m.lookAt(from, _target, up);
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}
