import { layoutActor, withinReach } from "iwg-shared/story2d";
import { loadArt } from "./artCache.js";
import { Atmosphere } from "./atmosphere.js";

// The playable stage: a wide painted backdrop the camera pans across, with cut-out
// actors standing on a pseudo-3D ground plane and the player's own figure walking
// between them.
//
// Built out of DOM rather than canvas on purpose. Layering, hit-testing, cross-fades and
// per-element animation are all free here and would each be hand-rolled work on a
// canvas, while the only thing canvas is better at — hundreds of cheap particles — is
// handled by a single overlay (atmosphere.js). React owns the interface chrome; this
// class owns the picture and never re-renders through React, so walking stays smooth.

// How wide the stage is relative to the viewport. Above 1 the place extends past what
// you can see, so walking to the far end is a real journey rather than a stroll to the
// edge of a picture. Backdrops are painted at 21:9, which is already wider than a 16:9
// viewport; this crops a little off the top and bottom to widen it further.
const MIN_SCREENS = 1.55;

// A person at scale 1, standing at the very front, as a fraction of viewport height.
// The depth curve in layoutActor scales everything else off this.
const PERSON_FRAC = 0.42;

// Stage units per second. The full stage takes about six and a half seconds to cross at
// a walk, which is deliberate: distance has to cost something or proximity-gated choices
// are free.
const WALK_SPEED = 0.155;
const RUN_MULTIPLIER = 2.1;

// The player never walks all the way to the horizon or right up against the camera.
const PLAYER_DEPTH_MIN = 0.38;
const PLAYER_DEPTH_MAX = 0.95;
const PLAYER_DEPTH_DEFAULT = 0.62;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// Deterministic per-actor jitter, so the idle sway of a given object is the same every
// time that scene is drawn rather than reshuffling on every render.
// Labels are written as painterly briefs ("a brass diving helmet, green with verdigris,
// one port cracked"); the first clause is the thing itself, which is what a name tag
// wants. The rest is for the painter and for the examine text.
function shortLabel(label) {
  const head = String(label || "").split(/[,—(]/)[0].trim();
  return head.length > 30 ? `${head.slice(0, 28)}…` : head;
}

// Perceived brightness, for deciding whether text on a filled accent should be dark or
// light. Rec. 709 weights; good enough for a two-way choice.
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hashFloat(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export class Stage {
  // Last player position the reach test was evaluated at, so it is only redone when the
  // player has actually moved.
  #lastReachX;

  constructor(container) {
    this.container = container;
    this.root = el("div", "stage-root", container);

    this.camera = el("div", "stage-camera", this.root);
    this.backdrop = el("div", "stage-backdrop", this.camera);
    this.actorLayer = el("div", "stage-actors", this.camera);

    this.light = el("div", "stage-light", this.root);
    this.atmosphereCanvas = el("canvas", "stage-atmosphere", this.root);
    this.vignette = el("div", "stage-vignette", this.root);
    this.cursorHint = el("div", "stage-walk-hint", this.root);

    this.atmosphere = new Atmosphere(this.atmosphereCanvas);

    this.scene = null;
    this.bible = null;
    this.sessionId = null;
    this.backdropAspect = 21 / 9;

    /** @type {Map<string, {actor: object, node: HTMLElement, art: HTMLImageElement, label: string}>} */
    this.actors = new Map();

    this.player = {
      x: 0.5,
      depth: PLAYER_DEPTH_DEFAULT,
      targetX: 0.5,
      targetDepth: PLAYER_DEPTH_DEFAULT,
      facing: 1,
      walking: false,
      running: false,
    };
    this.playerNode = null;
    this.playerArt = null;

    // Device pixel ratio, used to snap the camera to whole physical pixels.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cam = 0;
    this.camTarget = 0;
    this.W = 0;
    this.H = 0;
    this.stageW = 0;

    this.reachIds = [];
    this.hovered = null;
    this.pendingExamine = null;
    this.frozen = false; // true while beats are playing: player input is suspended

    // Callbacks, assigned by the React layer.
    this.onReach = null;
    this.onFocus = null;
    this.onExamine = null;
    this.onPlayerMove = null;
    this.onSpeech = null;

    this.#bindInput();
    this.#observeSize();
    this.#loop();
  }

  // -- setup ---------------------------------------------------------------

  #observeSize() {
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(this.container);
    this.#resize();
  }

  #resize() {
    const rect = this.container.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    if (!this.W || !this.H) return;

    this.stageW = Math.max(this.W * MIN_SCREENS, this.H * this.backdropAspect);
    this.camera.style.width = `${this.stageW}px`;
    this.camera.style.height = `${this.H}px`;
    this.backdrop.style.width = `${this.stageW}px`;
    this.backdrop.style.height = `${this.H}px`;

    this.atmosphere.resize(this.W, this.H);
    this.#layoutAll();
  }

  #bindInput() {
    this.root.addEventListener("pointerdown", (e) => {
      if (this.frozen) return;
      // Clicks that land on an actor are handled by that actor's own listener.
      if (e.target.closest(".stage-actor")) return;
      const x = (e.clientX - this.root.getBoundingClientRect().left + this.cam) / this.stageW;
      this.pendingExamine = null;
      this.walkToX(clamp(x, 0.02, 0.98), { depth: null, running: e.shiftKey || e.detail > 1 });
      this.#pingHint(e.clientX, e.clientY);
    });

    this.root.addEventListener("pointermove", (e) => {
      const hit = e.target.closest(".stage-actor");
      const id = hit?.dataset.actorId || null;
      if (id !== this.hovered) {
        this.hovered = id;
        const entry = id ? this.actors.get(id) : null;
        this.onFocus?.(entry ? entry.actor : null);
      }
    });

    this.root.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.onFocus?.(null);
    });

    this.keyHandler = (e) => {
      if (this.frozen) return;
      // Walking with the keyboard as well as by clicking: some people reach for WASD
      // immediately and find click-to-move unresponsive by comparison.
      const left = e.key === "a" || e.key === "A" || e.key === "ArrowLeft";
      const right = e.key === "d" || e.key === "D" || e.key === "ArrowRight";
      if (!left && !right) return;
      if (e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName)) return;
      e.preventDefault();
      this.keyDir = left ? -1 : 1;
      this.player.running = e.shiftKey;
    };
    this.keyUpHandler = (e) => {
      if (/^(a|A|d|D|ArrowLeft|ArrowRight)$/.test(e.key)) this.keyDir = 0;
    };
    window.addEventListener("keydown", this.keyHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    this.keyDir = 0;
  }

  #pingHint(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    this.cursorHint.style.left = `${clientX - rect.left}px`;
    this.cursorHint.style.top = `${clientY - rect.top}px`;
    this.cursorHint.classList.remove("ping");
    // Force a reflow so the animation restarts on a repeated click in the same place.
    void this.cursorHint.offsetWidth;
    this.cursorHint.classList.add("ping");
  }

  // -- scene ---------------------------------------------------------------

  /**
   * Draws a scene, reusing anything already on stage. Actors that persist keep their
   * element and glide to their new position; actors whose description changed cross-fade
   * to new art; new ones fade in and departed ones fade out. Snapping everything into
   * place would throw away the continuity the persistent-world mode exists to provide.
   */
  async setScene(scene, { bible, sessionId, relocated = false } = {}) {
    this.scene = scene;
    if (bible) this.bible = bible;
    if (sessionId) this.sessionId = sessionId;

    const backdrop = scene?.backdrop;

    // Backdrop first: everything else is positioned against its horizon.
    if (backdrop?.description && backdrop.description !== this.backdropDescription) {
      this.backdropDescription = backdrop.description;
      const art = await loadArt({
        sessionId: this.sessionId,
        kind: "backdrop",
        description: backdrop.description,
        extra: { horizon: backdrop.horizon, mood: backdrop.mood },
      });
      if (art) {
        this.backdropAspect = art.aspect;
        this.backdrop.style.backgroundImage = `url(${art.url})`;
        this.backdrop.classList.add("loaded");
      } else {
        // No art: fall back to a painted gradient from the scene's own palette, so an
        // unconfigured or failed generation still gives a lit, coloured place rather
        // than a black rectangle.
        this.backdrop.style.backgroundImage = this.#fallbackBackdrop(backdrop);
        this.backdrop.classList.add("loaded");
      }
      this.#resize();
    }

    this.#applyLight(backdrop);

    if (typeof scene?.player_x === "number" && (relocated || this.playerNode === null)) {
      this.player.x = clamp(scene.player_x, 0.02, 0.98);
      this.player.targetX = this.player.x;
      this.cam = this.#cameraFor(this.player.x);
    }

    await this.#syncActors(scene?.actors || []);
    await this.#ensurePlayer();
    this.#layoutAll();
  }

  #fallbackBackdrop(backdrop) {
    const p = backdrop?.palette || {};
    const key = p.key || "#6b7d8a";
    const shadow = p.shadow || "#232a30";
    const accent = p.accent || "#c98a3a";
    const horizon = Math.round((backdrop?.horizon ?? 0.6) * 100);
    return (
      `radial-gradient(120% 70% at 50% ${horizon}%, ${accent}33, transparent 60%), ` +
      `linear-gradient(${shadow} 0%, ${key} ${horizon - 8}%, ${shadow} ${horizon}%, ${shadow} 100%)`
    );
  }

  #applyLight(backdrop) {
    const p = backdrop?.palette || {};
    this.light.style.background =
      `radial-gradient(90% 60% at 50% ${Math.round((backdrop?.horizon ?? 0.6) * 100)}%, ` +
      `${p.key || "#ffffff"}1f, transparent 70%)`;
    this.atmosphere.set(backdrop?.atmosphere, backdrop?.atmosphere_intensity ?? 0.35, p);
    this.atmosphere.start();
    this.root.style.setProperty("--stage-accent", p.accent || "#c98a3a");
    this.root.style.setProperty("--stage-shadow", p.shadow || "#1a1f24");
    // The interface borrows one colour from whatever has been painted, so the chrome
    // sits with the art instead of competing with it. Set on the document root because
    // the React layer lives outside the stage's subtree.
    const accent = p.accent || "#c98a3a";
    document.documentElement.style.setProperty("--game-accent", accent);
    document.documentElement.style.setProperty("--game-shadow", p.shadow || "#1a1f24");
    // The accent is whatever this particular scene happens to be about, so it ranges from
    // pale straw to near-black navy. Buttons filled with it need their text picked to
    // match, or a dark-accent game gets near-black labels on a near-black button.
    document.documentElement.style.setProperty(
      "--game-ink-on-accent",
      luminance(accent) > 0.45 ? "#16120a" : "#f6f3ea"
    );
  }

  async #syncActors(actors) {
    const wanted = new Map(actors.map((a) => [a.id, a]));

    // Departures.
    for (const [id, entry] of [...this.actors]) {
      if (wanted.has(id)) continue;
      entry.node.classList.add("leaving");
      this.actors.delete(id);
      setTimeout(() => entry.node.remove(), 600);
    }

    await Promise.all(
      actors.map(async (actor) => {
        const existing = this.actors.get(actor.id);

        if (existing) {
          existing.actor = actor;
          // A changed label means the model repainted it — a door now open, a coat now
          // bloodied. Cross-fade rather than swapping, so the change reads as a change.
          if (existing.label !== actor.label) {
            existing.label = actor.label;
            const tag = existing.node.querySelector(".actor-name");
            if (tag) tag.textContent = shortLabel(actor.label);
            const art = await loadArt({
              sessionId: this.sessionId,
              kind: "figure",
              description: actor.label,
            });
            if (art) this.#crossFade(existing, art);
          }
          return;
        }

        const node = el("div", "stage-actor entering", this.actorLayer);
        node.dataset.actorId = actor.id;
        if (actor.character) node.classList.add("is-character");

        const shadow = el("div", "actor-shadow", node);
        shadow.setAttribute("aria-hidden", "true");

        const art = el("img", "actor-art", node);
        art.alt = actor.label;
        art.draggable = false;

        // The name rides with the object rather than being drawn by React, so it tracks
        // the actor exactly while the camera pans and costs no re-render on hover.
        const tag = el("div", "actor-name", node);
        tag.textContent = shortLabel(actor.label);

        // Deterministic idle sway: a scene where nothing moves reads as a screenshot.
        const jitter = hashFloat(actor.id);
        node.style.setProperty("--sway-duration", `${4.2 + jitter * 3.4}s`);
        node.style.setProperty("--sway-delay", `${-jitter * 5}s`);
        node.style.setProperty("--sway-amount", actor.character ? "1.1deg" : "0.55deg");

        node.addEventListener("pointerdown", (e) => {
          if (this.frozen) return;
          e.stopPropagation();
          this.approach(actor.id);
        });

        const entry = { actor, node, art, label: actor.label };
        this.actors.set(actor.id, entry);

        const loaded = await loadArt({
          sessionId: this.sessionId,
          kind: "figure",
          description: actor.label,
        });
        if (!this.actors.has(actor.id)) return; // removed while its art was in flight

        if (loaded) {
          entry.art.src = loaded.url;
          entry.aspect = loaded.aspect;
          entry.node.classList.add("has-art");
        } else {
          // Silhouette placeholder: a solid shape in the scene's own accent colour,
          // which reads as "something is there" rather than as a broken image.
          entry.node.classList.add("placeholder");
          entry.aspect = actor.character ? 0.42 : 0.85;
        }
        requestAnimationFrame(() => entry.node.classList.remove("entering"));
        this.#layoutActorNode(entry);
      })
    );
  }

  #crossFade(entry, art) {
    const ghost = entry.art.cloneNode();
    ghost.className = "actor-art ghost";
    entry.node.appendChild(ghost);
    entry.art.src = art.url;
    entry.aspect = art.aspect;
    entry.node.classList.add("has-art", "repainted");
    setTimeout(() => {
      ghost.remove();
      entry.node.classList.remove("repainted");
    }, 900);
  }

  async #ensurePlayer() {
    if (this.playerNode) return;

    const node = el("div", "stage-actor stage-player", this.actorLayer);
    const shadow = el("div", "actor-shadow", node);
    shadow.setAttribute("aria-hidden", "true");
    const art = el("img", "actor-art", node);
    art.alt = "you";
    art.draggable = false;

    this.playerNode = node;
    this.playerArt = art;

    const description = this.bible?.protagonist;
    const loaded = description
      ? await loadArt({ sessionId: this.sessionId, kind: "figure", description })
      : null;
    if (loaded) {
      art.src = loaded.url;
      this.playerAspect = loaded.aspect;
      node.classList.add("has-art");
    } else {
      node.classList.add("placeholder");
      this.playerAspect = 0.4;
    }
  }

  // -- movement ------------------------------------------------------------

  /** Walk to a position on the stage. */
  walkToX(x, { depth = null, running = false } = {}) {
    this.player.targetX = clamp(x, 0.02, 0.98);
    if (depth !== null) this.player.targetDepth = clamp(depth, PLAYER_DEPTH_MIN, PLAYER_DEPTH_MAX);
    this.player.running = running;
    this.player.walking = true;
  }

  /**
   * Walk to an actor and, on arrival, examine it. Used both by clicking an actor and by
   * clicking a choice that is gated on being near one.
   */
  approach(actorId, { examine = true } = {}) {
    const entry = this.actors.get(actorId);
    if (!entry) return;
    const actor = entry.actor;

    // Stop beside it rather than on top of it, on whichever side the player is already.
    const side = this.player.x <= actor.x ? -1 : 1;
    const offset = 0.022 + 0.02 * (actor.depth ?? 0.5);
    this.pendingExamine = examine ? actorId : null;
    this.walkToX(actor.x + side * offset, { depth: actor.depth });
  }

  /** Immediately places the player, used when a scene relocates. */
  placeAt(x) {
    this.player.x = clamp(x, 0.02, 0.98);
    this.player.targetX = this.player.x;
    this.player.walking = false;
    this.cam = this.#cameraFor(this.player.x);
  }

  #cameraFor(x) {
    if (this.stageW <= this.W) return 0;
    return clamp(x * this.stageW - this.W / 2, 0, this.stageW - this.W);
  }

  // -- beats ---------------------------------------------------------------

  /**
   * Plays out the model's `beats` — the player's character acting out what was just
   * chosen — and resolves when finished. Input is suspended for the duration.
   */
  async playBeats(beats) {
    if (!Array.isArray(beats) || !beats.length) return;
    this.frozen = true;
    this.playbackToken = (this.playbackToken || 0) + 1;
    const token = this.playbackToken;

    try {
      for (const beat of beats) {
        if (token !== this.playbackToken) return; // skipped
        await this.#playBeat(beat, token);
      }
    } finally {
      if (token === this.playbackToken) {
        this.frozen = false;
        this.onSpeech?.(null);
      }
    }
  }

  cancelBeats() {
    this.playbackToken = (this.playbackToken || 0) + 1;
    this.frozen = false;
    this.player.targetX = this.player.x;
    this.player.walking = false;
    this.onSpeech?.(null);
  }

  async #playBeat(beat, token) {
    const target = beat.target_id ? this.actors.get(beat.target_id) : null;

    switch (beat.type) {
      case "walk_to": {
        if (target) this.approach(beat.target_id, { examine: false });
        else if (typeof beat.x === "number") this.walkToX(beat.x);
        await this.#waitForArrival(token);
        return;
      }
      case "face": {
        const x = target ? target.actor.x : beat.x;
        if (typeof x === "number") this.player.facing = x >= this.player.x ? 1 : -1;
        await this.#delay(280, token);
        return;
      }
      case "interact": {
        if (target) {
          target.node.classList.add("interacted");
          setTimeout(() => target.node.classList.remove("interacted"), 900);
        }
        this.playerNode?.classList.add("acting");
        await this.#delay(700, token);
        this.playerNode?.classList.remove("acting");
        return;
      }
      case "say": {
        this.onSpeech?.({ text: beat.text, kind: "say" });
        // Long enough to read, short enough not to become a chore.
        await this.#delay(clamp(1100 + beat.text.length * 42, 1400, 4600), token);
        this.onSpeech?.(null);
        return;
      }
      case "emote": {
        this.onSpeech?.({ text: beat.text, kind: "emote" });
        await this.#delay(clamp(900 + beat.text.length * 36, 1200, 3600), token);
        this.onSpeech?.(null);
        return;
      }
      case "wait":
        await this.#delay((beat.seconds || 0.5) * 1000, token);
        return;
      default:
        return;
    }
  }

  #delay(ms, token) {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      // A skip must not leave a chain of timers still firing behind it.
      const check = setInterval(() => {
        if (token !== this.playbackToken) {
          clearTimeout(id);
          clearInterval(check);
          resolve();
        }
      }, 60);
      setTimeout(() => clearInterval(check), ms + 80);
    });
  }

  #waitForArrival(token) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (token !== this.playbackToken || !this.player.walking) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Never hang the turn on a walk that somehow cannot complete.
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 9000);
    });
  }

  // -- frame loop ----------------------------------------------------------

  #loop() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      this.#step(dt);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  #step(dt) {
    if (!this.W || !this.stageW) return;
    const p = this.player;

    // Keyboard steering overrides any click target while a key is held.
    if (this.keyDir && !this.frozen) {
      p.targetX = clamp(p.x + this.keyDir * 0.2, 0.02, 0.98);
      p.walking = true;
    }

    if (p.walking) {
      const speed = WALK_SPEED * (p.running ? RUN_MULTIPLIER : 1);
      const dx = p.targetX - p.x;
      const step = speed * dt;

      if (Math.abs(dx) <= step) {
        p.x = p.targetX;
        p.walking = false;
        this.#arrived();
      } else {
        p.x += Math.sign(dx) * step;
        p.facing = dx >= 0 ? 1 : -1;
      }
      this.onPlayerMove?.(p.x);
    }

    // Depth eases separately and more slowly than x, so walking "into" the scene toward
    // something at the back reads as a diagonal rather than a snap.
    if (Math.abs(p.targetDepth - p.depth) > 0.001) {
      p.depth += (p.targetDepth - p.depth) * Math.min(1, dt * 2.6);
    }

    this.camTarget = this.#cameraFor(p.x);
    this.cam += (this.camTarget - this.cam) * Math.min(1, dt * 5.5);
    // Snap to whole device pixels. A camera at a fractional offset makes the browser
    // resample the entire backdrop every frame, and the resampling phase changes frame to
    // frame, which reads as the whole scene shimmering as you walk.
    const camPx = Math.round(this.cam * this.dpr) / this.dpr;
    this.#write(this.camera, "transform", `translate3d(${-camPx}px, 0, 0)`);

    this.#layoutPlayer();
    this.#updateReach();
  }

  #arrived() {
    const id = this.pendingExamine;
    this.pendingExamine = null;
    if (!id) return;
    const entry = this.actors.get(id);
    if (entry && withinReach(this.player.x, entry.actor)) {
      this.onExamine?.(entry.actor);
    }
  }

  #updateReach() {
    // Reach only changes when the player does. Recomputing it every frame meant two
    // class writes per actor per frame — a style invalidation storm for an answer that
    // was identical to the previous frame's.
    if (this.#lastReachX !== undefined && Math.abs(this.player.x - this.#lastReachX) < 0.0015) {
      return;
    }
    this.#lastReachX = this.player.x;

    const ids = [];
    // Several things can be in reach at once on a crowded stage, and showing all their
    // name tags stacks three labels on top of each other. Only the nearest is named.
    let closest = null;
    let closestGap = Infinity;

    for (const [id, entry] of this.actors) {
      const near = withinReach(this.player.x, entry.actor);
      entry.node.classList.toggle("in-reach", near);
      if (near) {
        ids.push(id);
        const gap = Math.abs(this.player.x - entry.actor.x);
        if (gap < closestGap) {
          closestGap = gap;
          closest = entry;
        }
      }
    }
    for (const entry of this.actors.values()) {
      entry.node.classList.toggle("is-closest", entry === closest);
    }
    // Only notify React when the set actually changes — this runs sixty times a second.
    if (ids.length !== this.reachIds.length || ids.some((id, i) => id !== this.reachIds[i])) {
      this.reachIds = ids;
      this.onReach?.(ids);
    }
  }

  // -- layout --------------------------------------------------------------

  #layoutAll() {
    if (!this.H) return;
    for (const entry of this.actors.values()) this.#layoutActorNode(entry);
    this.#layoutPlayer();
  }

  // Where an element's own box sits relative to the point it is anchored to. This used to
  // live in CSS, but position is now carried entirely by `transform` so it has to be part
  // of the same transform string.
  static #ANCHOR_OFFSET = {
    ground: "translate(-50%, -100%)",
    hanging: "translate(-50%, 0)",
    floating: "translate(-50%, -50%)",
    wall: "translate(-50%, -50%)",
  };

  // Writes a style only when the value actually changed. Every one of these is a style
  // invalidation, and the player's are re-derived sixty times a second — most frames only
  // the position differs, so re-asserting the other six was pure waste.
  #write(node, prop, value) {
    if (node.__last === undefined) node.__last = {};
    if (node.__last[prop] === value) return;
    node.__last[prop] = value;
    if (prop === "transform") node.style.transform = value;
    else if (prop === "zIndex") node.style.zIndex = value;
    else node.style.setProperty(prop, value);
  }

  #place(node, l, height, width) {
    // Position via transform rather than left/top. Layout properties are resolved at a
    // different stage of the pipeline than the camera's transform, so a child positioned
    // with `left` lands a frame apart from the camera that is translating underneath it —
    // which is precisely why the player appeared to swim against the backdrop while
    // walking even though every individual frame was correct.
    const px = l.x * this.stageW;
    const py = l.y * this.H;
    const anchor = Stage.#ANCHOR_OFFSET[l.anchor] || Stage.#ANCHOR_OFFSET.ground;
    this.#write(node, "transform", `translate3d(${px}px, ${py}px, 0) ${anchor}`);
    this.#write(node, "--h", `${height}px`);
    this.#write(node, "--w", `${width}px`);
  }

  #layoutActorNode(entry) {
    const { actor, node } = entry;
    const l = layoutActor(actor, this.scene?.backdrop);
    const height = PERSON_FRAC * this.H * l.scale;

    this.#place(node, l, height, height * (entry.aspect || 0.7));
    this.#write(node, "zIndex", String(l.z));
    if (node.dataset.anchor !== l.anchor) node.dataset.anchor = l.anchor;
    // Things further away are hazier: a depth cue that also stops distant cut-outs
    // reading as sharp stickers pasted on a soft painting.
    this.#write(node, "--haze", String(clamp((1 - l.depth) * 0.5, 0, 0.45)));
    this.#write(node, "--flip", actor.facing === "left" ? "-1" : "1");
  }

  #layoutPlayer() {
    if (!this.playerNode || !this.H) return;
    const node = this.playerNode;
    const l = layoutActor({ x: this.player.x, depth: this.player.depth }, this.scene?.backdrop);
    const height = PERSON_FRAC * this.H * l.scale;

    this.#place(node, l, height, height * (this.playerAspect || 0.4));
    // Always just in front of an actor at the same depth, so the player is never lost
    // behind something they are standing next to.
    this.#write(node, "zIndex", String(l.z + 1));
    this.#write(node, "--flip", String(this.player.facing));

    const walking = this.player.walking;
    const running = walking && this.player.running;
    if (node.__walking !== walking) {
      node.__walking = walking;
      node.classList.toggle("walking", walking);
    }
    if (node.__running !== running) {
      node.__running = running;
      node.classList.toggle("running", running);
    }
  }

  // -- teardown ------------------------------------------------------------

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
    this.atmosphere.dispose();
    this.root.remove();
    this.actors.clear();
  }
}
