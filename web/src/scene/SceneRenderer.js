import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GROUND_HALF_EXTENT } from "iwg-shared";
import { paletteOf, lightingOf, fogOf, groundColorOf } from "./palette.js";
import { applyPropTexture } from "./propTextures.js";
import { attachSprite } from "./propSprites.js";
import { attachModel } from "./propModels.js";
import { GEOMETRIC_FORMS, PASSABLE_FORMS } from "iwg-shared";
import { attachGeometry } from "./propGeometry.js";
import { buildScatter } from "./scatter.js";
import { heightAt, seedFromScene } from "./terrain.js";

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 6; // units/sec
const SPRINT_MULTIPLIER = 1.85; // hold shift; a 40-unit world is tedious at walking pace
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


// How generous the "what am I looking at" test is, for the on-demand prop label.
const FOCUS_MAX_DISTANCE = 9;
const FOCUS_MIN_ALIGNMENT = 0.9; // ~25° cone around the view direction

// Ground extends past the playable bounds so the terrain runs under the horizon ring
// rather than ending in a visible edge.
const HORIZON_MARGIN = 60;

// Opening-shot framing: how many vantage points to test around the scene's centre. How
// far back to stand is derived per scene from how spread out the props are.
const VANTAGE_SAMPLES = 24;
const OPENING_PITCH = THREE.MathUtils.degToRad(11);

// Subtle darkening toward the frame edge. Costs almost nothing and does a
// disproportionate amount of the work separating "3D tech demo" from "game" — it
// focuses the eye centrally and hides the flat falloff at the screen border.
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.85 },
    softness: { value: 0.55 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float softness;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      // distance from centre, normalised so corners sit near 1.0
      float d = distance(vUv, vec2(0.5)) * 1.414;
      float v = smoothstep(1.0, softness, d);
      color.rgb *= mix(1.0, v, strength);
      gl_FragColor = color;
    }
  `,
};

/** Builds a THREE.Group for a single prop entry from the model's scene.props array. */
// Chooses where the player opens the scene. A fixed spawn regularly put a wall or a
// building directly between the camera and everything worth looking at. This samples
// vantage points around the props' centre and picks the one with the clearest line of
// sight, so a turn opens on a readable composition rather than the back of a hut.
function chooseVantage(props) {
  const fallback = { x: 0, z: GROUND_HALF_EXTENT * 0.6 };
  if (!props?.length) return { position: fallback, target: { x: 0, z: 0 } };

  const target = {
    x: props.reduce((s, p) => s + p.x, 0) / props.length,
    z: props.reduce((s, p) => s + p.z, 0) / props.length,
  };

  // Stand back in proportion to how spread out the scene actually is. A fixed 13m made
  // a tight cluster of objects look like a distant toy set, and would have cropped a
  // sprawling one. Framed to the spread, plus a little breathing room.
  const spread = Math.max(
    ...props.map((p) => Math.hypot(p.x - target.x, p.z - target.z)),
    2
  );
  const distance = THREE.MathUtils.clamp(spread * 1.15 + 4, 7, 20);

  const limit = GROUND_HALF_EXTENT - 2;
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < VANTAGE_SAMPLES; i++) {
    const angle = (i / VANTAGE_SAMPLES) * Math.PI * 2;
    const x = THREE.MathUtils.clamp(target.x + Math.cos(angle) * distance, -limit, limit);
    const z = THREE.MathUtils.clamp(target.z + Math.sin(angle) * distance, -limit, limit);

    const dx = target.x - x;
    const dz = target.z - z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;

    let score = 0;
    for (const p of props) {
      const px = p.x - x;
      const pz = p.z - z;
      const along = px * ux + pz * uz; // distance along the view direction
      if (along < 0 || along > len) continue; // behind us, or past the subject
      const perp = Math.abs(px * uz - pz * ux); // sideways offset from the sight line
      // Anything close to the sight line and close to the camera is an obstruction;
      // the same object far away is just part of the scene.
      if (perp < 2.5) score -= (len - along) / len;
      // A little standing room matters too.
      if (along < 3 && perp < 2) score -= 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { x, z };
    }
  }

  return { position: best || fallback, target };
}

// Placeholder geometry, shown until the prop's generated artwork arrives and used
// permanently if generation is unavailable. There is no prop-type vocabulary any more,
// so the shape comes from the object's `form` — how it occupies space — which is the
// only thing the renderer can know before it has seen the art.
function buildProp(prop, palette) {
  const group = new THREE.Group();
  const scale = prop.scale && prop.scale > 0 ? prop.scale : 1;
  const base = palette?.ground || new THREE.Color(0x8a8578);


  const mat = (lighten) =>
    new THREE.MeshStandardMaterial({
      color: base.clone().lerp(new THREE.Color(0xffffff), lighten),
      roughness: 0.9,
    });

  switch (prop.form) {
    case "tall": {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 3, 8), mat(0.25));
      shaft.position.y = 1.5;
      group.add(shaft);
      break;
    }
    case "wide": {
      // Architectural: keeps real geometry rather than becoming a billboard, since the
      // player can walk around it. Kept slab-like and modestly sized — at 2.6 x 2.2 x 1.6
      // a scaled-up instance filled the frame with a featureless green wall.
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.9, 0.7), mat(0.18));
      body.position.y = 0.95;
      group.add(body);
      break;
    }
    case "humanoid": {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.05, 4, 8), mat(0.35));
      body.position.y = 0.95;
      group.add(body);
      break;
    }
    case "flat": {
      const plane = new THREE.Mesh(
        new THREE.CircleGeometry(1.3, 20),
        new THREE.MeshStandardMaterial({
          color: base.clone().lerp(new THREE.Color(0x2e6f8e), 0.5),
          roughness: 0.25,
          metalness: 0.1,
          transparent: true,
          opacity: 0.85,
        })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = 0.03;
      group.add(plane);
      break;
    }
    case "small":
    default: {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat(0.22));
      box.position.y = 0.35;
      group.add(box);
      break;
    }
  }

  group.scale.setScalar(scale);
  group.position.set(prop.x || 0, 0, prop.z || 0);

  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Resolution order, best-effort, each upgrading in place as it arrives:
  //   1. geometry assembled from primitives — real 3D, true shadows, solid from every
  //      angle, and the primary path
  //   2. a generated GLB model, if a text-to-3D key is configured
  //   3. billboarded generated artwork
  //   4. this primitive with a generated surface texture
  (async () => {
    if (await attachGeometry(group, prop.label, prop.form)) return;
    if (await attachModel(group, prop.label, prop.form)) return;
    if (!GEOMETRIC_FORMS.has(prop.form)) {
      if (await attachSprite(group, prop.form, prop.label)) return;
    }
    applyPropTexture(group, prop.label);
  })();

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
    // The default shadow frustum is a 10-unit box — in a 40-unit world that leaves
    // most of the scene unshadowed with a visible cut-off line across the ground.
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowCam = this.sun.shadow.camera;
    shadowCam.left = -GROUND_HALF_EXTENT * 1.3;
    shadowCam.right = GROUND_HALF_EXTENT * 1.3;
    shadowCam.top = GROUND_HALF_EXTENT * 1.3;
    shadowCam.bottom = -GROUND_HALF_EXTENT * 1.3;
    shadowCam.near = 0.5;
    shadowCam.far = 120;
    shadowCam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006; // kills shadow acne on the displaced terrain
    this.scene.add(this.ambient, this.sun);

    this._initPostProcessing(w, h);

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
    this._bobPhase = 0;
    this._lightsUsed = 0;
    this._palette = null;
  }

  // Bloom + anti-aliasing + vignette. Bloom is what makes torches, sunlit foliage and
  // the item glow read as light rather than as bright paint, and is most of the
  // difference between "objects rendered in a scene" and "a game".
  _initPostProcessing(w, h) {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      0.55, // strength — enough to glow, low enough not to wash the scene out
      0.7, // radius
      0.75 // threshold: only genuinely bright pixels bloom, not every lit surface
    );
    this.composer.addPass(this.bloomPass);

    this.vignettePass = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignettePass);

    // EffectComposer renders to a render target, which bypasses the renderer's own
    // MSAA — without this the whole scene comes back visibly jagged.
    this.composer.addPass(new SMAAPass(w, h));

    // Applies tone mapping and colour space conversion at the end of the chain, where
    // it belongs once post-processing is involved.
    this.composer.addPass(new OutputPass());
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
    // The composer owns its own render targets and doesn't track the renderer's size.
    this.composer?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
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
    const env = scene.environment;
    const palette = paletteOf(env);
    this._palette = palette;
    // Picked before the scatter is built so clutter can be kept off the spawn point.
    const vantage = chooseVantage(scene.props);

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

    // Flat palette colour until the generated ground texture arrives.
    const groundMat = new THREE.MeshStandardMaterial({
      color: groundColorOf(env),
      roughness: 1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.worldGroup.add(ground);

    // Hundreds of instanced biome details plus a horizon ring, so the world reads as a
    // place instead of a few objects on a lawn. Purely decorative and deterministic —
    // deliberately not part of WorldState, so it can't affect spatial-consistency metrics.
    this.worldGroup.add(buildScatter(scene, this._seed, vantage.position));

    // The procedural texture above renders immediately; a generated one (if the server
    // has an image-gen key) can take seconds, so it's fetched in the background and
    // swapped in on arrival rather than blocking the scene on it.
    this._loadGeneratedGround(scene, groundMat);

    this._lightsUsed = 0;
    for (const prop of scene.props || []) this._addProp(prop);

    // Every value here is authored by the model for this specific place, so two scenes
    // only look alike if they were described alike.
    this.scene.background = palette.fog.clone();
    this.scene.fog.color = palette.fog.clone();
    const fog = fogOf(env);
    this.scene.fog.near = fog.near;
    this.scene.fog.far = fog.far;

    const lighting = lightingOf(env);
    this.sun.position.set(12, lighting.sunHeight, 10);
    this.sun.color.copy(palette.light);
    this.sun.intensity = lighting.sun;
    this.ambient.color.copy(palette.ambient);
    this.ambient.intensity = lighting.ambient;
    this._loadGeneratedSky(scene);

    // Open on a vantage with a clear view of the scene, rather than a fixed point that
    // might be staring at a wall.
    const { position, target } = vantage;
    this.camera.position.set(
      position.x,
      heightAt(position.x, position.z, this._seed) + EYE_HEIGHT,
      position.z
    );
    this.camera.lookAt(target.x, this.camera.position.y, target.z);
    // The choice panel occupies the bottom of the screen, so a perfectly level camera
    // spends most of the *visible* area on sky and hides the world behind the UI.
    // Pitching down compensates, putting the ground and props in the readable region.
    this.camera.rotateX(-OPENING_PITCH);
  }

  _addProp(prop) {
    const group = buildProp(prop, this._palette);
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
  applyDelta(delta) {
    if (!delta) return;

    for (const prop of delta.add || []) {
      if (this.propsById.has(prop.id)) this._removeProp(prop.id);
      const group = this._addProp(prop);
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
      kind: "sky",
      label: scene.environment?.description || "an open sky",
      light_level: String(scene.environment?.light_level ?? 0.7),
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
      this.scene.fog.color = this._palette.fog.clone();
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
      kind: "ground",
      label: scene.environment?.ground_cover || "worn stone",
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
      if (PASSABLE_FORMS.has(prop.form)) continue;
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
  // ground height every frame turns small bumps into visible jitter. A small walking
  // bob rides on top: without it, moving feels like sliding a camera on rails.
  _settleEyeHeight(dt, moving, speedScale = 1) {
    this._bobPhase = moving ? this._bobPhase + dt * 9 * speedScale : 0;
    const bob = moving ? Math.sin(this._bobPhase) * 0.045 * speedScale : 0;
    const ground = heightAt(this.camera.position.x, this.camera.position.z, this._seed);
    const target = ground + EYE_HEIGHT + bob;
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
      const sprinting = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      const speed = MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1);
      const moving = Boolean(forward || strafe);
      if (moving) {
        const before = this.camera.position.clone();
        dir.set(strafe, 0, -forward).normalize();
        this.controls.moveRight(dir.x * speed * dt);
        this.controls.moveForward(-dir.z * speed * dt);

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
      this._settleEyeHeight(dt, moving, sprinting ? SPRINT_MULTIPLIER : 1);
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

    this.composer.render();
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
