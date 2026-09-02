import * as THREE from "three";
import { MIRROR_AXES } from "iwg-shared";

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

    case "capsule":
      // size = [radius, length, unused]. Rounded ends read as organic where a cylinder
      // reads as machined — limbs, necks, bodies.
      return new THREE.CapsuleGeometry(sx, Math.max(sy - sx * 2, 0.02), 4, 12);

    case "wedge": {
      // A triangular prism: roofs, ramps, prows, blades. Built by extruding a right
      // triangle so the slope runs along +y.
      const shape = new THREE.Shape();
      shape.moveTo(-sx / 2, 0);
      shape.lineTo(sx / 2, 0);
      shape.lineTo(-sx / 2, sy);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: sz, bevelEnabled: false });
      geo.translate(0, 0, -sz / 2);
      return geo;
    }

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
    // Faceted by default: it keeps a deliberate, carved look and stops low-poly forms
    // from reading as badly-smoothed blobs. Organic parts opt into smooth shading,
    // where facets on a body or a fruit look like a modelling mistake.
    flatShading: !part.smooth,
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
// Expands one part definition into every placement it describes. Mirroring and
// repetition are what let a 14-part budget produce a colonnade or a four-legged animal:
// the part is defined once and the placements are derived, so detail costs geometry
// rather than tokens.
function placementsFor(part) {
  const [px, py, pz] = part.pos || [0, 0, 0];
  let placements = [{ x: px || 0, y: py || 0, z: pz || 0, flipX: false, flipZ: false }];

  const repeat = part.repeat;
  if (repeat && Number.isFinite(repeat.count) && repeat.count >= 2) {
    const count = Math.min(Math.round(repeat.count), 16);
    const expanded = [];
    for (const base of placements) {
      if (Number.isFinite(repeat.radius) && repeat.radius > 0) {
        // Ring: spokes, columns around a rotunda, teeth.
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          expanded.push({
            ...base,
            x: base.x + Math.cos(a) * repeat.radius,
            z: base.z + Math.sin(a) * repeat.radius,
            spin: a,
          });
        }
      } else {
        // Straight run: fence posts, ribs, windows.
        const [ox, oy, oz] = repeat.offset || [1, 0, 0];
        for (let i = 0; i < count; i++) {
          expanded.push({
            ...base,
            x: base.x + (ox || 0) * i,
            y: base.y + (oy || 0) * i,
            z: base.z + (oz || 0) * i,
          });
        }
      }
    }
    placements = expanded;
  }

  if (MIRROR_AXES.includes(part.mirror)) {
    const mirrored = [];
    for (const p of placements) {
      mirrored.push(p);
      if (part.mirror === "x" || part.mirror === "xz") {
        mirrored.push({ ...p, x: -p.x, flipX: true });
      }
      if (part.mirror === "z" || part.mirror === "xz") {
        mirrored.push({ ...p, z: -p.z, flipZ: true });
      }
      if (part.mirror === "xz") {
        mirrored.push({ ...p, x: -p.x, z: -p.z, flipX: true, flipZ: true });
      }
    }
    placements = mirrored;
  }

  return placements;
}

export function buildPartsMesh(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;

  const group = new THREE.Group();

  for (const part of parts) {
    try {
      // Geometry and material are shared across a part's placements; only the transform
      // differs, so a 12-post fence is one geometry and twelve cheap meshes.
      const geometry = buildGeometry(part);
      const material = buildMaterial(part);

      for (const place of placementsFor(part)) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(place.x, place.y, place.z);

        if (Array.isArray(part.rot) && part.rot.length === 3) {
          mesh.rotation.set(
            THREE.MathUtils.degToRad(part.rot[0] || 0),
            THREE.MathUtils.degToRad(part.rot[1] || 0),
            THREE.MathUtils.degToRad(part.rot[2] || 0)
          );
        }
        // Ring repeats face outward, so spokes and columns orient sensibly.
        if (Number.isFinite(place.spin)) mesh.rotation.y += place.spin;

        // Negative scale is what actually mirrors the shape, not just its position —
        // otherwise an asymmetric part (a curved horn, an angled roof) would be
        // translated rather than reflected.
        if (place.flipX) mesh.scale.x *= -1;
        if (place.flipZ) mesh.scale.z *= -1;

        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
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
