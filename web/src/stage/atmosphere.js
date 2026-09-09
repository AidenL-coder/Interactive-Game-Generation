// The animated air in front of the painting.
//
// A generated backdrop is a still image, and a still image reads as a still image no
// matter how good it is. Drifting particulate — dust in a shaft of light, rain, ash,
// embers, spores — is the cheapest possible fix and does more for the sense of a living
// place than anything else on the client. It is one canvas and a few hundred points, so
// it costs nothing.
//
// Behaviour comes from the scene's authored `atmosphere` string rather than a fixed
// enum, so the model can ask for whatever suits the place and the nearest matching
// physics is used.

const BEHAVIOURS = [
  {
    match: ["rain", "drizzle", "downpour", "shower"],
    count: 380,
    make: (rng, w, h) => ({
      x: rng() * w,
      y: rng() * h,
      len: 9 + rng() * 16,
      vx: -0.6 - rng() * 0.5,
      vy: 9 + rng() * 7,
      a: 0.18 + rng() * 0.3,
      w: 1,
    }),
    draw(ctx, p, colour) {
      ctx.strokeStyle = colour;
      ctx.globalAlpha = p.a;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 1.6, p.y + p.len);
      ctx.stroke();
    },
  },
  {
    match: ["snow", "sleet", "flurr"],
    count: 220,
    make: (rng, w, h) => ({
      x: rng() * w,
      y: rng() * h,
      r: 0.9 + rng() * 2.2,
      vx: 0,
      vy: 0.5 + rng() * 0.9,
      sway: 0.5 + rng() * 1.4,
      phase: rng() * Math.PI * 2,
      a: 0.35 + rng() * 0.5,
    }),
    draw(ctx, p, colour, t) {
      ctx.fillStyle = colour;
      ctx.globalAlpha = p.a;
      ctx.beginPath();
      ctx.arc(p.x + Math.sin(t * 0.0011 + p.phase) * p.sway * 9, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    match: ["ash", "soot", "cinder", "fallout", "snowfall of paper"],
    count: 190,
    make: (rng, w, h) => ({
      x: rng() * w,
      y: rng() * h,
      r: 0.7 + rng() * 1.8,
      vx: -0.15 - rng() * 0.3,
      vy: 0.35 + rng() * 0.7,
      sway: 0.6 + rng() * 1.6,
      phase: rng() * Math.PI * 2,
      a: 0.25 + rng() * 0.4,
    }),
    draw(ctx, p, colour, t) {
      ctx.fillStyle = colour;
      ctx.globalAlpha = p.a * (0.7 + 0.3 * Math.sin(t * 0.002 + p.phase));
      ctx.beginPath();
      ctx.arc(p.x + Math.sin(t * 0.0009 + p.phase) * p.sway * 7, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    // Rising, glowing, and fading out as they climb.
    match: ["ember", "spark", "firefl", "mote of fire", "ignis"],
    count: 130,
    make: (rng, w, h) => ({
      x: rng() * w,
      y: rng() * h,
      r: 0.8 + rng() * 1.7,
      vx: (rng() - 0.5) * 0.35,
      vy: -0.5 - rng() * 1.1,
      phase: rng() * Math.PI * 2,
      a: 0.4 + rng() * 0.5,
      glow: true,
    }),
    draw(ctx, p, colour, t) {
      const flicker = 0.55 + 0.45 * Math.sin(t * 0.006 + p.phase);
      ctx.globalAlpha = p.a * flicker;
      ctx.fillStyle = colour;
      ctx.shadowBlur = 8;
      ctx.shadowColor = colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    },
  },
  {
    match: ["spore", "pollen", "seed", "drifting light", "will-o", "plankton"],
    count: 160,
    make: (rng, w, h) => ({
      x: rng() * w,
      y: rng() * h,
      r: 1.0 + rng() * 2.0,
      vx: (rng() - 0.5) * 0.25,
      vy: -0.12 - rng() * 0.25,
      sway: 1 + rng() * 2,
      phase: rng() * Math.PI * 2,
      a: 0.3 + rng() * 0.45,
      glow: true,
    }),
    draw(ctx, p, colour, t) {
      ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(t * 0.0015 + p.phase));
      ctx.fillStyle = colour;
      ctx.shadowBlur = 6;
      ctx.shadowColor = colour;
      ctx.beginPath();
      ctx.arc(p.x + Math.sin(t * 0.0008 + p.phase) * p.sway * 11, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    },
  },
];

// The default: fine motes hanging in the air, drifting almost imperceptibly. Used for
// "dust" and for anything unrecognised, because almost any interior or still exterior
// looks better with it than without.
const DUST = {
  count: 200,
  make: (rng, w, h) => ({
    x: rng() * w,
    y: rng() * h,
    r: 0.5 + rng() * 1.4,
    vx: (rng() - 0.5) * 0.16,
    vy: (rng() - 0.5) * 0.14,
    phase: rng() * Math.PI * 2,
    a: 0.14 + rng() * 0.34,
  }),
  draw(ctx, p, colour, t) {
    ctx.globalAlpha = p.a * (0.5 + 0.5 * Math.sin(t * 0.0012 + p.phase));
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  },
};

function behaviourFor(text) {
  const t = String(text || "").toLowerCase();
  if (!t || t === "none" || t === "clear" || t === "still") return null;
  for (const b of BEHAVIOURS) {
    if (b.match.some((m) => t.includes(m))) return b;
  }
  return DUST;
}

// Which of the scene's colours a given weather should be drawn in. Everything used to
// take the accent, which put bright orange rain over a grey North Sea — falling water and
// snow are lit by the sky, not by whatever the scene's one warm note happens to be.
// Things that emit their own light do take the accent, because they are the light.
const TINTS = { rain: "pale", snow: "pale", ash: "muted", ember: "accent", spore: "accent" };

function mixToward(hex, target, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return target;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const t = [(target >> 16) & 255, (target >> 8) & 255, target & 255];
  const out = c.map((v, i) => Math.round(v + (t[i] - v) * amount));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function particleColour(behaviour, palette) {
  const key = palette?.key || "#ffffff";
  const accent = palette?.accent || key;
  const tint = behaviour ? TINTS[behaviourName(behaviour)] : undefined;

  if (tint === "accent") return accent;
  if (tint === "pale") return mixToward(key, 0xffffff, 0.75);
  if (tint === "muted") return mixToward(key, 0x9a9a9a, 0.55);
  return mixToward(key, 0xffffff, 0.35); // dust and anything unrecognised
}

// The behaviour objects are matched by keyword, so name them by their first keyword
// rather than carrying a redundant id.
function behaviourName(behaviour) {
  return behaviour?.match?.[0];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Owns one full-viewport canvas of drifting particulate.
 *
 * Particles live in viewport space, not stage space, so they do not scroll with the
 * camera — which is correct: air is between you and the scene, not painted on it.
 */
export class Atmosphere {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.particles = [];
    this.behaviour = null;
    this.colour = "#ffffff";
    this.raf = null;
    this.w = 0;
    this.h = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.#populate();
  }

  /**
   * @param {string} kind - the scene's authored atmosphere description
   * @param {number} intensity - 0 to 1
   * @param {{key?: string, accent?: string}} palette - the scene's own colours
   */
  set(kind, intensity, palette = {}) {
    this.behaviour = behaviourFor(kind);
    this.intensity = Math.min(Math.max(intensity ?? 0.4, 0), 1);
    this.colour = particleColour(this.behaviour, palette);
    this.#populate();
  }

  #populate() {
    if (!this.behaviour || !this.w || !this.h) {
      this.particles = [];
      return;
    }
    // Seeded so the same scene always produces the same air. Determinism matters here
    // for the same reason it does everywhere else in the render: two runs of one
    // WorldState should be comparable.
    const rng = mulberry32(Math.round(this.intensity * 1000) + this.behaviour.count);
    // A floor of 15% keeps a trace of air even when the scene asks for almost none;
    // stepping straight to zero looks like a bug rather than a choice.
    const n = Math.round(this.behaviour.count * (0.15 + 0.85 * this.intensity));
    this.particles = Array.from({ length: n }, () => this.behaviour.make(rng, this.w, this.h));
  }

  start() {
    if (this.raf) return;
    let last = performance.now();
    const frame = (now) => {
      // Normalised to 60fps so the drift is the same speed on any display, and clamped
      // so a backgrounded tab does not teleport everything on return.
      const step = Math.min((now - last) / 16.67, 3);
      last = now;
      this.#draw(now, step);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  #draw(now, step) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.behaviour || !this.particles.length) return;

    ctx.save();
    for (const p of this.particles) {
      p.x += p.vx * step;
      p.y += p.vy * step;

      // Wrap rather than respawn: a particle leaving one edge re-enters the opposite
      // one, so density stays constant and nothing pops into existence on screen.
      const margin = 20;
      if (p.x < -margin) p.x = this.w + margin;
      else if (p.x > this.w + margin) p.x = -margin;
      if (p.y < -margin) p.y = this.h + margin;
      else if (p.y > this.h + margin) p.y = -margin;

      this.behaviour.draw(ctx, p, this.colour, now);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  dispose() {
    this.stop();
    this.particles = [];
  }
}
