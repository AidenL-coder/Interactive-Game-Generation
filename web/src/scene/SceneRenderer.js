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
import { applyPropTexture } from "./propTextures.js";
import { attachSprite, SPRITE_TYPES } from "./propSprites.js";
import { buildScatter } from "./scatter.js";
import { heightAt, seedFromScene } from "./terrain.js";

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 6; // units/sec
const MAX_POINT_LIGHTS = 4; // cap live lights (torches) for perf
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Agent-action playback tuning. Turn and translate are deliberately sequential, and
// both eased, to keep automated camera movement comfortable to watch.
const TURN_DURATION = 0.45;
const INTERACT_DURATION = 0.6;
const SAY_DURATION = 2.2;
const STOP_DISTANCE = 2.2; // stop short of a target rather than inside it
const PROP_TWEEN_DURATION = 0.6;

const COLLISION_RADIUS = 0.9;
const PASSABLE_PROPS = new Set(["water", "item"]);

// How generous the "what am I looking at" test is, for the on-demand prop label.
const FOCUS_MAX_DISTANCE = 9;
const FOCUS_MIN_ALIGNMENT = 0.9; // ~25° cone around the view direction

// Ground extends past the playable bounds so the terrain runs under the horizon ring
// rather than ending in a visible edge.
const HORIZON_MARGIN = 60;

/** Builds a THREE.Group for a single prop entry from the model's scene.props array. */
function buildProp(prop, mood) {
  const group = new THREE.Group();
  const tint = moodTintColor(mood);
  const scale = prop.scale && prop.scale > 0 ? prop.scale : 1;

  const stoneMat = () => new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.9 });
  const woodMat = () => new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 });

  switch (prop.type) {
    case "tree": {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 1.5, 7), woodMat());
      trunk.position.y = 0.75;
      const topColor = new THREE.Color(0x2e6b3a).lerp(tint, 0.15);
      // Three stacked, slightly rotated tiers read as foliage; one cone reads as a party hat.
      const foliageMat = new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.85 });
      foliageMat.userData.foliage = true;
      group.add(trunk);
      const tiers = [
        { y: 1.7, r: 1.0, h: 1.1 },
        { y: 2.3, r: 0.78, h: 1.0 },
        { y: 2.85, r: 0.52, h: 0.85 },
      ];
      for (const [i, t] of tiers.entries()) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(t.r, t.h, 8), foliageMat);
        cone.position.y = t.y;
        cone.rotation.y = i * 0.4;
        cone.userData.noTexture = true; // bark texture on leaves looks wrong
        group.add(cone);
      }
      break;
    }
    case "rock": {
      // Jitter the vertices so rocks aren't identical faceted balls.
      const geo = new THREE.IcosahedronGeometry(0.6, 1);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const f = 0.78 + Math.random() * 0.44;
        pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.8, pos.getZ(i) * f);
      }
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, stoneMat());
      rock.position.y = 0.38;
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
      flame.userData.noTexture = true; // charred-wood texture on a flame reads as a rock
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
      // Items are the thing the player is meant to notice, so they get a faceted gem
      // plus a glow and a ground halo rather than a plain floating blob.
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32, 1),
        new THREE.MeshStandardMaterial({
          color: 0xf0c850,
          emissive: 0xc08a10,
          emissiveIntensity: 0.7,
          metalness: 0.65,
          roughness: 0.25,
        })
      );
      gem.position.y = 0.95;
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.46, 20),
        new THREE.MeshBasicMaterial({
          color: 0xffd98a,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
        })
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      halo.userData.noTexture = true;
      group.add(gem, halo);
      // Deliberately no bob: items render as real objects (a chest, a relic) that rest
      // on the ground. Hovering is what made them read as floating dots.
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

  // Labels used to hang over every prop as floating text, which read as debug overlay
  // and cluttered the view. The label now surfaces only for whatever the player is
  // actually looking at (see _updateFocus), so it's information on demand.

  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Discrete objects become billboarded artwork; architectural pieces keep their
  // geometry and just get a material texture. Both arrive asynchronously, so the prop
  // renders immediately either way and upgrades in place when the image lands.
  if (SPRITE_TYPES.has(prop.type)) attachSprite(group, prop.type);
  else applyPropTexture(group, prop.type);

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
    this._onKeyDown = (e) => {
      this.keys.add(e.code);
      // Walking up to something and acting on it is the point of having a 3D world at
      // all — it turns exploration into the choice mechanism rather than a parallel
      // activity happening behind a menu.
      if (e.code === "KeyE" && this._focusProp && !this.playback) {
        this.onInteract?.(this._focusProp);
      }
    };
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
    // Starts well beyond the play area so the horizon silhouettes fade into distance
    // instead of the fog closing in around the player.
    this.scene.fog = new THREE.Fog(0x87ceeb, 28, 78);

    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 240);
    this.camera.position.set(0, EYE_HEIGHT, 6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Photographic textures rendered linearly look washed out and blow out around
    // torches; filmic tone mapping keeps highlights under control and deepens contrast.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
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
    this.propsById = new Map();
    this.playback = null;
    this.onSay = null; // set by the UI to surface `say` action text
    this.onFocus = null; // set by the UI to surface the looked-at prop's label
    this.onInteract = null; // set by the UI; fired when the player presses E on a prop
    this._focusLabel = null;
    this._focusProp = null;
    this._seed = 1;
    this._lightsUsed = 0;
    this._mood = "serene";
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

  _disposeObject(obj) {
    obj.traverse?.((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
  }

  /** Rebuilds the world group from a WorldState.scene object (see shared/worldState.js). */
  setScene(scene) {
    // dispose previous world geometry/materials before rebuilding
    this._disposeObject(this.worldGroup);
    this.worldGroup.clear();
    this.dynamicProps = [];
    this.propsById = new Map();
    this.cancelPlayback();
    // Invalidates any in-flight texture request from the previous scene, so a slow
    // response can't paint itself onto the world that replaced it.
    this._sceneToken++;

    this._seed = seedFromScene(scene);

    // A flat plane is the single most "unfinished" thing in a 3D scene. Displacing the
    // ground costs nothing at runtime and everything else (props, scatter, the player's
    // eye height) samples the same height function so nothing floats or sinks.
    const groundGeo = new THREE.PlaneGeometry(
      GROUND_HALF_EXTENT * 2 + HORIZON_MARGIN,
      GROUND_HALF_EXTENT * 2 + HORIZON_MARGIN,
      96,
      96
    );
    const gpos = groundGeo.attributes.position;
    for (let i = 0; i < gpos.count; i++) {
      // geometry is still in its own XY plane here; it becomes XZ after the rotation below
      gpos.setZ(i, heightAt(gpos.getX(i), -gpos.getY(i), this._seed));
    }
    groundGeo.computeVertexNormals();

    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTexture(scene.biome, scene.mood),
      roughness: 1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.worldGroup.add(ground);

    // Hundreds of instanced biome details plus a horizon ring, so the world reads as a
    // place instead of a few objects on a lawn. Purely decorative and deterministic —
    // deliberately not part of WorldState, so it can't affect spatial-consistency metrics.
    this.worldGroup.add(buildScatter(scene, this._seed));

    // The procedural texture above renders immediately; a generated one (if the server
    // has an image-gen key) can take seconds, so it's fetched in the background and
    // swapped in on arrival rather than blocking the scene on it.
    this._loadGeneratedGround(scene, groundMat);

    this._lightsUsed = 0;
    this._mood = scene.mood;
    for (const prop of scene.props || []) this._addProp(prop, scene.mood);

    this.scene.background = skyColor(scene.mood, scene.time_of_day);
    this.scene.fog.color = this.scene.background;
    this.ambient.intensity = ambientIntensity(scene.time_of_day);
    this.sun.intensity = sunIntensity(scene.time_of_day);
    this._loadGeneratedSky(scene);

    // reset the player to a sensible spot each new scene rather than leaving them
    // possibly stranded outside the new ground extent
    const spawnZ = GROUND_HALF_EXTENT * 0.6;
    this.camera.position.set(0, heightAt(0, spawnZ, this._seed) + EYE_HEIGHT, spawnZ);
    this.camera.lookAt(0, this.camera.position.y, 0); // face the middle of the world
  }

  _addProp(prop, mood) {
    const group = buildProp(prop, mood ?? this._mood);
    group.userData.propId = prop.id;
    group.position.y = heightAt(prop.x, prop.z, this._seed);
    this.worldGroup.add(group);
    this.propsById.set(prop.id, { group, prop: { ...prop } });

    if (group.userData.bob) this.dynamicProps.push({ group, kind: "bob", base: 0.9 });
    if (group.userData.flameLight && this._lightsUsed < MAX_POINT_LIGHTS) {
      const light = new THREE.PointLight(0xff9640, 1.2, 6, 2);
      light.position.set(prop.x, 1.3, prop.z);
      group.userData.light = light;
      this.worldGroup.add(light);
      this._lightsUsed++;
    }
    return group;
  }

  _removeProp(id) {
    const entry = this.propsById.get(id);
    if (!entry) return;
    const { group } = entry;
    if (group.userData.light) {
      this.worldGroup.remove(group.userData.light);
      this._lightsUsed = Math.max(0, this._lightsUsed - 1);
    }
    this.dynamicProps = this.dynamicProps.filter((d) => d.group !== group);
    this.worldGroup.remove(group);
    this._disposeObject(group);
    this.propsById.delete(id);
  }

  /**
   * Applies a scene_delta in place, so the world mutates instead of being rebuilt.
   * Moves are animated (see _animate) rather than snapped, so the change is legible
   * as a change rather than reading as a new scene.
   */
  applyDelta(delta, mood) {
    if (!delta) return;
    if (mood) this._mood = mood;

    for (const prop of delta.add || []) {
      if (this.propsById.has(prop.id)) this._removeProp(prop.id);
      const group = this._addProp(prop, this._mood);
      // fade/pop in so appearing objects read as arriving, not as always-having-been
      group.scale.multiplyScalar(0.01);
      this.dynamicProps.push({
        group,
        kind: "grow",
        target: prop.scale && prop.scale > 0 ? prop.scale : 1,
        t: 0,
      });
    }

    for (const m of delta.move || []) {
      const entry = this.propsById.get(m.id);
      if (!entry) continue;
      entry.prop.x = m.x;
      entry.prop.z = m.z;
      this.dynamicProps.push({
        group: entry.group,
        kind: "slide",
        from: { x: entry.group.position.x, z: entry.group.position.z },
        to: { x: m.x, z: m.z },
        t: 0,
      });
    }

    for (const id of delta.remove || []) this._removeProp(id);
  }

  /**
   * Plays the avatar's actions for a turn: the camera walks/turns/acts on the player's
   * behalf before control returns. Deliberately turn-then-move rather than both at once,
   * and eased at both ends — simultaneous rotation+translation is the main trigger for
   * motion discomfort here.
   *
   * @returns {Promise<void>} resolves when playback finishes or is skipped
   */
  playActions(actions) {
    this.cancelPlayback();
    const queue = (actions || []).filter((a) => a && a.type);
    if (!queue.length) return Promise.resolve();

    this.controls.unlock?.();
    return new Promise((resolve) => {
      this.playback = { queue, index: 0, phase: "start", t: 0, resolve, say: null };
    });
  }

  cancelPlayback() {
    if (this.playback) {
      const { resolve } = this.playback;
      this.playback = null;
      this.onSay?.(null);
      resolve?.();
    }
  }

  _resolveTarget(action) {
    if (action.target_id) {
      const entry = this.propsById.get(action.target_id);
      if (entry) return new THREE.Vector3(entry.prop.x, 0, entry.prop.z);
    }
    if (typeof action.x === "number" && typeof action.z === "number") {
      return new THREE.Vector3(action.x, 0, action.z);
    }
    return null;
  }

  _stepPlayback(dt) {
    const pb = this.playback;
    const action = pb.queue[pb.index];
    if (!action) {
      this.cancelPlayback();
      return;
    }

    const advance = () => {
      pb.index++;
      pb.phase = "start";
      pb.t = 0;
      pb.say = null;
      this.onSay?.(null);
      if (pb.index >= pb.queue.length) this.cancelPlayback();
    };

    // ease in/out — constant-velocity camera motion is what reads as "floaty"
    const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

    if (action.type === "wait") {
      pb.t += dt;
      if (pb.t >= Math.min(action.seconds ?? 1, 4)) advance();
      return;
    }

    if (action.type === "say") {
      if (pb.phase === "start") {
        pb.phase = "saying";
        pb.t = 0;
        this.onSay?.(action.text);
      }
      pb.t += dt;
      if (pb.t >= SAY_DURATION) advance();
      return;
    }

    const target = this._resolveTarget(action);
    if (!target) return advance();

    if (pb.phase === "start") {
      // Face the target first; only then translate.
      const dir = new THREE.Vector3(target.x - this.camera.position.x, 0, target.z - this.camera.position.z);
      pb.startQuat = this.camera.quaternion.clone();
      const look = new THREE.Object3D();
      look.position.copy(this.camera.position);
      look.lookAt(target.x, EYE_HEIGHT, target.z);
      pb.endQuat = look.quaternion.clone();
      pb.from = this.camera.position.clone();
      // stop short so we don't end up standing inside the object
      const dist = Math.max(dir.length() - STOP_DISTANCE, 0);
      pb.to = pb.from.clone().add(dir.normalize().multiplyScalar(dist));
      pb.to.y = heightAt(pb.to.x, pb.to.z, this._seed) + EYE_HEIGHT;
      pb.phase = "turn";
      pb.t = 0;
    }

    if (pb.phase === "turn") {
      pb.t += dt;
      const u = Math.min(pb.t / TURN_DURATION, 1);
      this.camera.quaternion.slerpQuaternions(pb.startQuat, pb.endQuat, ease(u));
      if (u >= 1) {
        pb.phase = action.type === "walk_to" ? "move" : "act";
        pb.t = 0;
      }
      return;
    }

    if (pb.phase === "move") {
      const distance = pb.from.distanceTo(pb.to);
      const duration = Math.max(distance / MOVE_SPEED, 0.25);
      pb.t += dt;
      const u = Math.min(pb.t / duration, 1);
      this.camera.position.lerpVectors(pb.from, pb.to, ease(u));
      this.camera.position.y =
        heightAt(this.camera.position.x, this.camera.position.z, this._seed) + EYE_HEIGHT;
      if (u >= 1) advance();
      return;
    }

    // look_at / interact: brief beat once facing the target
    pb.t += dt;
    if (pb.t >= (action.type === "interact" ? INTERACT_DURATION : 0.3)) advance();
  }

  // The flat background colour is the single largest share of the viewport, so a
  // generated sky changes the look of the scene more than any other texture. Mapped
  // equirectangularly: the model's output isn't a true 360 panorama, but wrapped as one
  // it reads convincingly as sky and distant horizon.
  async _loadGeneratedSky(scene) {
    const token = this._sceneToken;
    const params = new URLSearchParams({
      biome: scene.biome,
      mood: scene.mood,
      time_of_day: scene.time_of_day,
      kind: "sky",
    });

    try {
      const res = await fetch(`${API_BASE}/texture?${params}`);
      if (!res.ok) return; // keep the flat colour
      const bitmap = await createImageBitmap(await res.blob());
      if (token !== this._sceneToken) {
        bitmap.close();
        return;
      }

      const tex = new THREE.CanvasTexture(bitmap);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;

      this.scene.background?.dispose?.();
      this.scene.background = tex;
      // Fog must stay a colour, not the texture — keep it matched to the sky's mood so
      // distant geometry still fades into the horizon instead of standing out against it.
      this.scene.fog.color = skyColor(scene.mood, scene.time_of_day);
    } catch {
      // keep the procedural sky colour
    }
  }

  async _loadGeneratedGround(scene, groundMat) {
    // setScene() bumps the token; a texture request that resolves after the player has
    // already advanced to the next scene is discarded rather than painted onto the
    // wrong world (or onto a material that's since been disposed).
    const token = this._sceneToken;
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

  // Blocks the camera from walking through solid props. Water and items are passable so
  // the player can stand on/over them; everything else pushes back.
  _blocked(x, z) {
    for (const { prop } of this.propsById.values()) {
      if (PASSABLE_PROPS.has(prop.type)) continue;
      const r = COLLISION_RADIUS * (prop.scale && prop.scale > 0 ? prop.scale : 1);
      const dx = x - prop.x;
      const dz = z - prop.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // Reports the nearest prop the player is roughly facing and standing near, so its
  // label can be shown on demand instead of every prop shouting its name at all times.
  _updateFocus() {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const camPos = this.camera.position;

    let best = null;
    let bestScore = -Infinity;
    for (const { prop } of this.propsById.values()) {
      if (!prop.label) continue;
      const dx = prop.x - camPos.x;
      const dz = prop.z - camPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > FOCUS_MAX_DISTANCE) continue;

      // dot product of the flattened view direction against the direction to the prop:
      // 1 is dead ahead, 0 is off to the side.
      const alignment = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (alignment < FOCUS_MIN_ALIGNMENT) continue;

      // Prefer things both centred in view and close by.
      const score = alignment - dist * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = prop;
      }
    }

    const label = best?.label ?? null;
    if (label !== this._focusLabel) {
      this._focusLabel = label;
      this._focusProp = best || null;
      this.onFocus?.(label);
    }
  }

  // Eases the camera onto the terrain rather than snapping it. Snapping to the exact
  // ground height every frame turns small bumps into visible jitter.
  _settleEyeHeight(dt) {
    const target = heightAt(this.camera.position.x, this.camera.position.z, this._seed) + EYE_HEIGHT;
    this.camera.position.y += (target - this.camera.position.y) * Math.min(dt * 12, 1);
  }

  _animate() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!this.playback) this._updateFocus();

    if (this.playback) {
      this._stepPlayback(dt);
    } else if (this.controls.isLocked) {
      const dir = new THREE.Vector3();
      const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      if (forward || strafe) {
        const before = this.camera.position.clone();
        dir.set(strafe, 0, -forward).normalize();
        this.controls.moveRight(dir.x * MOVE_SPEED * dt);
        this.controls.moveForward(-dir.z * MOVE_SPEED * dt);

        // resolve each axis separately so hitting a wall slides along it rather than
        // sticking the player in place
        const { x, z } = this.camera.position;
        if (this._blocked(x, z)) {
          if (!this._blocked(x, before.z)) this.camera.position.z = before.z;
          else if (!this._blocked(before.x, z)) this.camera.position.x = before.x;
          else this.camera.position.copy(before);
        }
      }
      const limit = GROUND_HALF_EXTENT - 0.5;
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -limit, limit);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -limit, limit);
      this._settleEyeHeight(dt);
    }

    const t = performance.now() / 1000;
    let settled = false;
    for (const p of this.dynamicProps) {
      if (p.kind === "bob") {
        p.group.position.y = Math.sin(t * 2) * 0.1;
      } else if (p.kind === "grow") {
        p.t = Math.min(p.t + dt / PROP_TWEEN_DURATION, 1);
        p.group.scale.setScalar(p.target * p.t);
        if (p.t >= 1) settled = true;
      } else if (p.kind === "slide") {
        p.t = Math.min(p.t + dt / PROP_TWEEN_DURATION, 1);
        const u = p.t < 0.5 ? 2 * p.t * p.t : 1 - (-2 * p.t + 2) ** 2 / 2;
        p.group.position.x = THREE.MathUtils.lerp(p.from.x, p.to.x, u);
        p.group.position.z = THREE.MathUtils.lerp(p.from.z, p.to.z, u);
        // follow the terrain while sliding, or the prop skims through hillsides
        p.group.position.y = heightAt(p.group.position.x, p.group.position.z, this._seed);
        if (p.t >= 1) settled = true;
      }
    }
    // drop finished one-shot tweens; 'bob' loops forever so it always stays
    if (settled) {
      this.dynamicProps = this.dynamicProps.filter((p) => p.kind === "bob" || p.t < 1);
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
