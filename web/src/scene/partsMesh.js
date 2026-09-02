import * as THREE from "three";

// Builds real 3D geometry from the parts the model composed.
//
// This is the alternative to both billboarded 2D art (which has no thickness and can't
// cast a true shadow) and text-to-3D APIs (slow, paid, and rougher than they sound).
// The model assembles objects out of primitives — the way a box of blocks isn't a
// catalogue of buildings — so nothing is pre-authored and any object is expressible,
// while what lands in the scene is genuine geometry you can walk around.
//
// The look is deliberately stylised rather than photoreal: clean shapes, flat-ish
// materials, strong silhouettes. That's a coherent style, which reads far better than
// mixing painted cards with primitives did.

const MAX_DIMENSION = 12; // metres — guards against a stray large number swallowing the scene

function clampSize(n) {
  const v = Number.isFinite(n) ? Math.abs(n) : 0.1;
  return Math.min(Math.max(v, 0.02), MAX_DIMENSION);
}

function buildGeometry(part) {
  const [sx, sy, sz] = (part.size || [1, 1, 1]).map(clampSize);

  switch (part.shape) {
    case "cylinder":
      // size = [bottom radius, height, top radius]; a zero top radius gives a cone,
      // which is why cones aren't a separate shape.
      return new THREE.CylinderGeometry(clampSize(sz), sx, sy, 16, 1);

    case "sphere":
      // Scaled after the fact so ellipsoids are possible from one geometry.
      return new THREE.SphereGeometry(1, 18, 12).scale(sx, sy, sz);

    case "torus":
      // size = [ring radius, tube radius, unused]
      return new THREE.TorusGeometry(sx, Math.min(sy, sx * 0.9), 12, 24);

    case "plane":
      return new THREE.PlaneGeometry(sx, sy);

    case "lathe": {
      // A silhouette revolved around the vertical axis: columns, vases, domes, bottles.
      // Radius 0 is legal (a closed tip), so only the height is floored.
      const points = (part.profile || [])
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([r, y]) => new THREE.Vector2(Math.min(Math.abs(r), MAX_DIMENSION), clampSize(y)));
      if (points.length < 2) return new THREE.CylinderGeometry(sx, sx, sy, 12);
      return new THREE.LatheGeometry(points, 20);
    }

    case "box":
    default:
      return new THREE.BoxGeometry(sx, sy, sz);
  }
}

function buildMaterial(part) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(part.color || "#8a8578"),
    roughness: typeof part.roughness === "number" ? part.roughness : 0.75,
    metalness: typeof part.metalness === "number" ? part.metalness : 0.05,
    // Flat shading keeps the faceted, deliberate look and stops low-poly forms from
    // reading as badly-smoothed organic shapes.
    flatShading: true,
  });
  if (part.emissive) {
    material.emissive = new THREE.Color(part.emissive);
    material.emissiveIntensity = 1.1;
  }
  // Planes are usually signage or banners, which should be visible from behind.
  if (part.shape === "plane") material.side = THREE.DoubleSide;
  return material;
}

/**
 * Assembles a prop's parts into a THREE.Group, positioned so the object's base sits at
 * y=0 and it is centred horizontally on its own origin.
 *
 * @param {Array} parts
 * @returns {THREE.Group|null} null if nothing usable could be built
 */
export function buildPartsMesh(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;

  const group = new THREE.Group();

  for (const part of parts) {
    try {
      const mesh = new THREE.Mesh(buildGeometry(part), buildMaterial(part));

      const [px, py, pz] = part.pos || [0, 0, 0];
      mesh.position.set(px || 0, py || 0, pz || 0);

      if (Array.isArray(part.rot) && part.rot.length === 3) {
        mesh.rotation.set(
          THREE.MathUtils.degToRad(part.rot[0] || 0),
          THREE.MathUtils.degToRad(part.rot[1] || 0),
          THREE.MathUtils.degToRad(part.rot[2] || 0)
        );
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    } catch {
      // One malformed part shouldn't cost the whole object.
    }
  }

  if (group.children.length === 0) return null;

  // Seat the assembly on the ground and centre it horizontally, so the model only has
  // to get an object's proportions right, not its absolute placement.
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return null;
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  group.position.x -= centre.x;
  group.position.z -= centre.z;
  group.position.y -= box.min.y;

  return group;
}

/** Height of an assembled object in metres, for sizing collision and labels. */
export function partsHeight(group) {
  if (!group) return 1;
  const box = new THREE.Box3().setFromObject(group);
  return box.isEmpty() ? 1 : box.max.y - box.min.y;
}
