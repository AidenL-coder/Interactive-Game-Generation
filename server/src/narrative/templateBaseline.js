import {
  GROUND_HALF_EXTENT,
  MIN_PROPS,
  MAX_PROPS,
  MIN_CHOICES,
  MAX_CHOICES,
} from "iwg-shared";

// Non-LLM baseline: a fixed recipe (seeded RNG + canned sentence templates), no model
// call, no learned player model. docs/research.md's "Known gaps" calls out the absence
// of a non-LLM contrast point for the ablation table — this is that point. Selected via
// ablation.engine === "template" (see generateScene.js); `evolving` has no effect here
// since the generator has no notion of history at all, which is itself the point of
// contrast against the LLM conditions.

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

// Small linear-congruential generator so a given (turnMessage, lastWorldState) pair
// always produces the same scene — deterministic, not just "random every time."
function seededRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

const NARRATIVE_TEMPLATES = [
  "{name} steps into a {mood} {biome}, {time_of_day} light settling over everything. The way forward isn't obvious yet.",
  "The {biome} stretches out ahead, {mood} in the {time_of_day} air. {name} has to decide what to do next.",
  "Something is different here. {name} takes stock of the {mood} {biome} around them — it's {time_of_day} now.",
  "A {mood} hush hangs over the {biome}. {name} pauses, {time_of_day} shadows lengthening, weighing the options.",
];

const CHOICE_TEMPLATES = [
  "Move forward carefully.",
  "Investigate the nearest object.",
  "Call out to see if anyone answers.",
  "Look for another way around.",
  "Search the area for anything useful.",
  "Wait and observe before acting.",
];

/**
 * @param {object} args
 * @param {object} args.profile
 * @param {object} args.ablation - only `.personalization` matters here
 * @param {string} args.turnMessage
 * @param {object|null} args.lastWorldState
 * @returns {{worldState: object, newHistory: [], usage: null, latencyMs: number}}
 */
// Canned vocabulary for the non-LLM baseline. Kept deliberately fixed and small: this
// condition exists to represent "template-driven generation", which is the thing the
// LLM path is being measured against.
const BASELINE_PLACES = ["forest", "desert", "ruin", "cavern", "shoreline", "snowfield"];
const BASELINE_MOODS = ["quiet", "tense", "bleak", "still"];
const BASELINE_TIMES = ["dawn", "day", "dusk", "night"];
const BASELINE_GROUND = ["packed dirt and gravel", "cracked flagstones", "coarse grass", "dry sand"];
const BASELINE_PALETTES = [
  { ground: "#6b6459", fog: "#9aa0a6", light: "#fff4e0", ambient: "#b9c3cc", scatter: "#5f6b45" },
  { ground: "#3a4230", fog: "#6b7a6b", light: "#e8f0d8", ambient: "#8fa08f", scatter: "#4c5640" },
  { ground: "#c2a15c", fog: "#d8c9a0", light: "#fff0d0", ambient: "#c8bfa8", scatter: "#a89253" },
];
const BASELINE_PROPS = [
  { label: "a weathered standing stone", form: "tall" },
  { label: "a low crumbling wall", form: "wide" },
  { label: "a wooden crate", form: "small" },
  { label: "a silent hooded figure", form: "humanoid" },
  { label: "a shallow pool of water", form: "flat" },
  { label: "a mossy boulder", form: "small" },
];

export function generateTemplateScene({ profile, ablation, turnMessage, lastWorldState }) {
  const startedAt = Date.now();

  const seed = hashString((turnMessage || "") + JSON.stringify(lastWorldState?.scene || {}));
  const rng = seededRng(seed);

  // This baseline is deliberately the template condition — a fixed vocabulary drawn at
  // random, which is exactly what the LLM path no longer does. It exists to be compared
  // against, so it keeps its canned word lists on purpose.
  const biome = pick(rng, BASELINE_PLACES);
  const mood = pick(rng, BASELINE_MOODS);
  const time_of_day = pick(rng, BASELINE_TIMES);
  const name = ablation?.personalization ? profile?.name || "the traveler" : "the traveler";
  const interest = ablation?.personalization ? (profile?.interests || []).filter(Boolean)[0] : null;

  const propCount = MIN_PROPS + Math.floor(rng() * (MAX_PROPS - MIN_PROPS + 1));
  const props = Array.from({ length: propCount }, (_, i) => {
    const thing = pick(rng, BASELINE_PROPS);
    return {
      // Ids are required by the schema now. The baseline has no notion of persistence
      // (every turn is independent), so these are unique-per-turn rather than stable
      // across turns — which is itself the honest representation of this baseline.
      id: `tpl_${i}`,
      label: thing.label,
      form: thing.form,
      x: Math.round((rng() * 2 - 1) * GROUND_HALF_EXTENT * 0.9),
      z: Math.round((rng() * 2 - 1) * GROUND_HALF_EXTENT * 0.9),
      scale: Math.round((0.6 + rng() * 1.2) * 10) / 10,
    };
  });

  let narrative = pick(rng, NARRATIVE_TEMPLATES)
    .replaceAll("{name}", name)
    .replaceAll("{mood}", mood)
    .replaceAll("{biome}", biome)
    .replaceAll("{time_of_day}", time_of_day);
  if (interest) {
    narrative += ` For a moment, ${name} is reminded of ${interest}, though nothing here explains why.`;
  }

  const choiceCount = MIN_CHOICES + Math.floor(rng() * (MAX_CHOICES - MIN_CHOICES + 1));
  const choices = [...CHOICE_TEMPLATES]
    .sort(() => rng() - 0.5)
    .slice(0, choiceCount)
    .map((text, i) => ({ id: `template_choice_${i}`, text }));

  const worldState = {
    narrative,
    scene: {
      environment: {
        description: `a ${mood} ${biome} at ${time_of_day}`,
        ground_cover: pick(rng, BASELINE_GROUND),
        palette: pick(rng, BASELINE_PALETTES),
        light_level: time_of_day === "night" ? 0.25 : time_of_day === "day" ? 0.9 : 0.55,
        visibility: 0.6,
        scatter_density: 0.4,
        scatter_cover: "scrub and loose stones",
      },
      props,
    },
    choices,
  };

  return { worldState, newHistory: [], usage: null, latencyMs: Date.now() - startedAt };
}
