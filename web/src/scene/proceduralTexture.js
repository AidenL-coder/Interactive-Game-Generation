import * as THREE from "three";

// Stand-in for the "AI 2D textures" half of the pipeline (see docs/research.md,
// "Known gaps"). Real diffusion-generated textures would slot in here behind the same
// groundTexture()/skyColor() signatures — swapping this module out is the whole
// integration surface, nothing else in the renderer needs to change.

const BIOME_PALETTE = {
  forest: { base: "#2f4a2f", accent: "#3f6b3f" },
  desert: { base: "#c2a15c", accent: "#d9bd7d" },
  ruins: { base: "#6b6459", accent: "#847c6d" },
  cave: { base: "#2a2a30", accent: "#3d3d46" },
  urban: { base: "#4a4a52", accent: "#5e5e68" },
  coast: { base: "#c9b98a", accent: "#e0d3a8" },
  snow: { base: "#dfe6ea", accent: "#f2f6f8" },
  swamp: { base: "#3a4230", accent: "#4c5640" },
};

const MOOD_TINT = {
  serene: "#ffffff",
  tense: "#ffdede",
  ominous: "#c9c2ff",
  joyful: "#fff6d8",
  mysterious: "#dccfff",
  desolate: "#d8d8d8",
};

const SKY_BASE = {
  dawn: { serene: "#f2b98a", tense: "#e08a6a", ominous: "#7a5a7a", joyful: "#f7cf9a", mysterious: "#8a6a9a", desolate: "#b0a090" },
  day: { serene: "#87ceeb", tense: "#a9b8c0", ominous: "#6b7280", joyful: "#8fd3f4", mysterious: "#9aa5c9", desolate: "#9aa0a6" },
  dusk: { serene: "#e08a52", tense: "#c15a4a", ominous: "#4a3a5a", joyful: "#f0a860", mysterious: "#5a4a6a", desolate: "#8a7a70" },
  night: { serene: "#0a1030", tense: "#1a1020", ominous: "#08060f", joyful: "#101838", mysterious: "#120a28", desolate: "#0d0d10" },
};

function paletteFor(biome) {
  return BIOME_PALETTE[biome] || BIOME_PALETTE.ruins;
}

/** Deterministic-ish speckled ground texture, no external asset/model call. */
export function groundTexture(biome, mood) {
  const { base, accent } = paletteFor(biome);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // seeded-ish speckle pattern (not cryptographically random, just visually varied)
  let seed = [...biome + mood].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  ctx.fillStyle = accent;
  for (let i = 0; i < 900; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 2.5;
    ctx.globalAlpha = 0.25 + rand() * 0.35;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function skyColor(mood, timeOfDay) {
  const row = SKY_BASE[timeOfDay] || SKY_BASE.day;
  return new THREE.Color(row[mood] || row.serene);
}

// Raised substantially from the original values: with photographic textures and filmic
// tone mapping, dusk and night rendered as near-black silhouettes where nothing was
// readable. Even "dark" scenes need enough fill light to see the world you're walking
// through — atmosphere comes from colour and contrast, not from an unlit frame.
export function ambientIntensity(timeOfDay) {
  return { dawn: 1.0, day: 1.25, dusk: 0.95, night: 0.6 }[timeOfDay] ?? 1.0;
}

export function sunIntensity(timeOfDay) {
  return { dawn: 1.4, day: 2.0, dusk: 1.3, night: 0.5 }[timeOfDay] ?? 1.4;
}

export function moodTintColor(mood) {
  return new THREE.Color(MOOD_TINT[mood] || "#ffffff");
}

// Sun direction and colour per time of day. A fixed overhead white light made dawn,
// dusk and night look identical apart from the sky tint, which wasted the strongest
// atmosphere signal the model gives us. Low-angle warm light also produces long
// shadows, which is most of what sells time of day.
const SUN_SETUP = {
  dawn: { position: [-18, 9, 12], color: "#ffc999", ambient: "#a8bdd0" },
  day: { position: [12, 24, 10], color: "#fff6e8", ambient: "#c6d3de" },
  dusk: { position: [18, 8, -10], color: "#ffa968", ambient: "#a99dc0" },
  night: { position: [-10, 16, -14], color: "#a9bde8", ambient: "#5a6684" },
};

export function sunSetup(timeOfDay) {
  return SUN_SETUP[timeOfDay] || SUN_SETUP.day;
}

// Fog distance also carries mood: an ominous scene closes in, a serene one opens up.
const MOOD_FOG = {
  serene: [34, 92],
  joyful: [38, 98],
  mysterious: [20, 62],
  tense: [24, 70],
  ominous: [16, 54],
  desolate: [26, 76],
};

export function fogRange(mood, timeOfDay) {
  const [near, far] = MOOD_FOG[mood] || MOOD_FOG.serene;
  // Night pulls the view in further whatever the mood.
  return timeOfDay === "night" ? [near * 0.7, far * 0.65] : [near, far];
}
