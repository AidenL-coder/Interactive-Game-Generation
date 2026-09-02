import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Real 3D geometry for props, replacing the billboarded sprites where a model is
// available. Billboards always face the camera, so walking around one gives the trick
// away and they can't cast a real shadow. A GLB can be circled, lit, and shadowed like
// any other object in the scene.
//
// Same caching shape as textures and sprites: one model per prop type, fetched once,
// shared by every instance. Falls back to sprite, then to primitive geometry.

const loader = new GLTFLoader();
const cache = new Map();

// Target height in world units per prop type. Generated models arrive at arbitrary
// scale, so each is normalised to its bounding box and then scaled to these.
const MODEL_HEIGHT = {
  tree: 3.6,
  npc: 1.85,
  item: 0.7,
  altar: 1.3,
  crate: 0.9,
  torch: 1.9,
  rock: 1.0,
  pillar: 3.0,
  wall: 1.8,
  structure: 2.6,
};

/** Resolves to a THREE.Object3D template for a prop type, or null if unavailable. */
export function propModel(type) {
  if (cache.has(type)) return cache.get(type);

  const job = (async () => {
    try {
      const res = await fetch(`${API_BASE}/model?type=${encodeURIComponent(type)}`);
      if (!res.ok) return null; // 503 = generation disabled, 404 = none for this type

      const buffer = await res.arrayBuffer();
      const gltf = await loader.parseAsync(buffer, "");
      const root = gltf.scene;

      // Normalise: models arrive centred arbitrarily and at arbitrary scale. Rescale to
      // the intended height and sit the base on y=0 so it stands on the ground rather
      // than floating or sinking.
      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const height = size.y || 1;
      const scale = (MODEL_HEIGHT[type] || 1.5) / height;
      root.scale.setScalar(scale);

      const scaled = new THREE.Box3().setFromObject(root);
      const centre = new THREE.Vector3();
      scaled.getCenter(centre);
      root.position.x -= centre.x;
      root.position.z -= centre.z;
      root.position.y -= scaled.min.y;

      root.traverse((obj) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      return root;
    } catch (err) {
      console.warn(`[propModels] ${type} unavailable:`, err?.message || err);
      return null;
    }
  })();

  cache.set(type, job);
  return job;
}

/**
 * Replaces a prop's placeholder geometry with a real 3D model once it loads.
 * @returns {Promise<boolean>} whether a model was attached
 */
export async function attachModel(group, type) {
  const template = await propModel(type);
  // The prop may have been removed by a delta while the model was in flight.
  if (!template || !group.parent) return false;

  // Clone per instance: several props of the same type share the loaded geometry and
  // materials, but each needs its own transform in the scene graph.
  const instance = template.clone(true);
  instance.userData.isModel = true;

  // Give each instance a little rotational variety so a row of the same model doesn't
  // read as copy-paste.
  instance.rotation.y = Math.random() * Math.PI * 2;

  for (const child of [...group.children]) child.visible = false;
  group.add(instance);
  return true;
}
