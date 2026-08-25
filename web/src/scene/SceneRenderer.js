import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GROUND_HALF_EXTENT } from "iwg-shared";
import {
  groundTexture,
  skyColor,
  ambientIntensity,
  sunIntensity,
  moodTintColor,
} from "./proceduralTexture.js";

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 6; // units/sec
const MAX_POINT_LIGHTS = 4; // cap live lights (torches) for perf
const API_BASE = import.meta.env.VITE_API_URL || "/api";

function labelSprite(text) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const pad = 16;
  ctx.font = "28px sans-serif";
  const width = Math.min(400, ctx.measureText(text).width + pad * 2);
  canvas.width = width;
  canvas.height = 44;
  ctx.font = "28px sans-serif";
  ctx.fillStyle = "rgba(10,10,14,0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f4f1e8";
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, canvas.height / 2, canvas.width - pad * 2);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scale = canvas.width / canvas.height;
  sprite.scale.set(scale * 0.5, 0.5, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/** Builds a THREE.Group for a single prop entry from the model's scene.props array. */
function buildProp(prop, mood) {
  const group = new THREE.Group();
  const tint = moodTintColor(mood);
  const scale = prop.scale && prop.scale > 0 ? prop.scale : 1;

  const stoneMat = () => new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.9 });
  const woodMat = () => new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 });

  switch (prop.type) {
    case "tree": {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 6), woodMat());
      trunk.position.y = 0.7;
      const topColor = new THREE.Color(0x2e6b3a).lerp(tint, 0.15);
      const top = new THREE.Mesh(
        new THREE.ConeGeometry(0.9, 1.8, 8),
        new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.8 })
      );
      top.position.y = 2.1;
      group.add(trunk, top);
      break;
    }
    case "rock": {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), stoneMat());
      rock.position.y = 0.4;
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      group.add(rock);
      break;
    }
    case "pillar": {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 3, 8), stoneMat());
      pillar.position.y = 1.5;
      group.add(pillar);
      break;
    }
    case "wall": {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, 0.3), stoneMat());
      wall.position.y = 0.9;
      group.add(wall);
      break;
    }
    case "structure": {
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2.2), stoneMat());
      base.position.y = 0.8;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1.7, 1.1, 4),
        new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.8 })
      );
      roof.position.y = 2.15;
      roof.rotation.y = Math.PI / 4;
      group.add(base, roof);
      break;
    }
    case "water": {
      const plane = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 20),
        new THREE.MeshStandardMaterial({
          color: 0x2e6f8e,
          transparent: true,
          opacity: 0.75,
          roughness: 0.2,
          metalness: 0.1,
        })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = 0.02;
      group.add(plane);
      break;
    }
    case "torch": {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.2, 6), woodMat());
      stick.position.y = 0.6;
      const flame = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffa23c, emissive: 0xff8c1a, emissiveIntensity: 1.5 })
      );
      flame.position.y = 1.25;
      group.add(stick, flame);
      group.userData.flameLight = true;
      break;
    }
    case "npc": {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x3a8a8a, roughness: 0.6 })
      );
      body.position.y = 1;
      group.add(body);
      break;
    }
    case "item": {
      const item = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.3, 0),
        new THREE.MeshStandardMaterial({ color: 0xd8b23c, emissive: 0x8a6a10, emissiveIntensity: 0.6, metalness: 0.4 })
      );
      item.position.y = 0.9;
      group.add(item);
      group.userData.bob = true;
      break;
    }
    case "altar": {
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.4), stoneMat());
      base.position.y = 0.2;
      const top = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1), stoneMat());
      top.position.y = 0.65;
      group.add(base, top);
      break;
    }
    case "crate": {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), woodMat());
      crate.position.y = 0.4;
      group.add(crate);
      break;
    }
    default: {
      const fallback = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), stoneMat());
      fallback.position.y = 0.3;
      group.add(fallback);
    }
  }

  group.scale.setScalar(scale);
  group.position.set(prop.x || 0, 0, prop.z || 0);

  if (prop.label) {
    const sprite = labelSprite(prop.label);
    sprite.position.set(0, 2.2 * scale, 0);
    group.add(sprite);
  }

  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  return group;
}

/**
 * Imperative three.js scene manager, deliberately kept outside React's render cycle
 * (React only mounts/unmounts the canvas container and reacts to worldState changes
 * via setWorldState — see web/src/ui usage in App.jsx).
 */
export class Scene3D {
  constructor(container) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.keys = new Set();
    this._onResize = this._onResize.bind(this);
    this._onKeyDown = (e) => this.keys.add(e.code);
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._animate = this._animate.bind(this);

    this._initThree();
    this._initControls();
    window.addEventListener("resize", this._onResize);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    this.renderer.setAnimationLoop(this._animate);
  }

  _initThree() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87ceeb, 15, 45);

    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 200);
    this.camera.position.set(0, EYE_HEIGHT, 6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.position.set(10, 20, 10);
    this.sun.castShadow = true;
    this.scene.add(this.ambient, this.sun);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.groundMesh = null;
    this.dynamicProps = [];
    this._sceneToken = 0;
  }

  _initControls() {
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    this.renderer.domElement.addEventListener("click", () => this.controls.lock());
  }

  _onResize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** Rebuilds the world group from a WorldState.scene object (see shared/worldState.js). */
  setScene(scene) {
    // dispose previous world geometry/materials before rebuilding
    this.worldGroup.traverse((obj) => {
      if (obj.isMesh || obj.isSprite) {
        obj.geometry?.dispose?.();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose?.();
      }
    });
    this.worldGroup.clear();
    this.dynamicProps = [];

    const groundGeo = new THREE.PlaneGeometry(GROUND_HALF_EXTENT * 2, GROUND_HALF_EXTENT * 2);
    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTexture(scene.biome, scene.mood),
      roughness: 1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.worldGroup.add(ground);

    // The procedural texture above renders immediately; a generated one (if the server
    // has an image-gen key) can take seconds, so it's fetched in the background and
    // swapped in on arrival rather than blocking the scene on it.
    this._loadGeneratedGround(scene, groundMat);

    let lightsUsed = 0;
    for (const prop of scene.props || []) {
      const group = buildProp(prop, scene.mood);
      this.worldGroup.add(group);
      if (group.userData.bob) this.dynamicProps.push({ group, kind: "bob", base: 0.9 });
      if (group.userData.flameLight && lightsUsed < MAX_POINT_LIGHTS) {
        const light = new THREE.PointLight(0xff9640, 1.2, 6, 2);
        light.position.set(prop.x, 1.3, prop.z);
        this.worldGroup.add(light);
        lightsUsed++;
      }
    }

    this.scene.background = skyColor(scene.mood, scene.time_of_day);
    this.scene.fog.color = this.scene.background;
    this.ambient.intensity = ambientIntensity(scene.time_of_day);
    this.sun.intensity = sunIntensity(scene.time_of_day);

    // reset the player to a sensible spot each new scene rather than leaving them
    // possibly stranded outside the new ground extent
    this.camera.position.set(0, EYE_HEIGHT, GROUND_HALF_EXTENT * 0.6);
  }

  async _loadGeneratedGround(scene, groundMat) {
    // Each setScene() bumps the token; a texture request that resolves after the player
    // has already advanced to the next scene is discarded rather than painted onto the
    // wrong world (or onto a material that's since been disposed).
    const token = ++this._sceneToken;
    const params = new URLSearchParams({
      biome: scene.biome,
      mood: scene.mood,
      time_of_day: scene.time_of_day,
      kind: "ground",
    });

    try {
      const res = await fetch(`${API_BASE}/texture?${params}`);
      if (!res.ok) return; // 503 = no key configured; keep the procedural texture
      const blob = await res.blob();
      if (token !== this._sceneToken) return;

      const bitmap = await createImageBitmap(blob);
      if (token !== this._sceneToken) {
        bitmap.close();
        return;
      }

      const tex = new THREE.CanvasTexture(bitmap);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(4, 4);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;

      groundMat.map?.dispose();
      groundMat.map = tex;
      groundMat.needsUpdate = true;
    } catch {
      // network/decode failure — procedural texture stays, nothing to do
    }
  }

  _animate() {
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (this.controls.isLocked) {
      const dir = new THREE.Vector3();
      const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      if (forward || strafe) {
        dir.set(strafe, 0, -forward).normalize();
        this.controls.moveRight(dir.x * MOVE_SPEED * dt);
        this.controls.moveForward(-dir.z * MOVE_SPEED * dt);
      }
      const limit = GROUND_HALF_EXTENT - 0.5;
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -limit, limit);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -limit, limit);
      this.camera.position.y = EYE_HEIGHT;
    }

    const t = performance.now() / 1000;
    for (const p of this.dynamicProps) {
      if (p.kind === "bob") p.group.position.y = Math.sin(t * 2) * 0.1;
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.controls.unlock?.();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
