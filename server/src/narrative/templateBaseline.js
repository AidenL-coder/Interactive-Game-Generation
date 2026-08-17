import {
  BIOMES,
  MOODS,
  TIMES_OF_DAY,
  PROP_TYPES,
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
export function generateTemplateScene({ profile, ablation, turnMessage, lastWorldState }) {
  const startedAt = Date.now();

  const seed = hashString((turnMessage || "") + JSON.stringify(lastWorldState?.scene || {}));
  const rng = seededRng(seed);

  const biome = pick(rng, BIOMES);
  const mood = pick(rng, MOODS);
  const time_of_day = pick(rng, TIMES_OF_DAY);
  const name = ablation?.personalization ? profile?.name || "the traveler" : "the traveler";
  const interest = ablation?.personalization ? (profile?.interests || []).filter(Boolean)[0] : null;

  const propCount = MIN_PROPS + Math.floor(rng() * (MAX_PROPS - MIN_PROPS + 1));
  const props = Array.from({ length: propCount }, () => ({
    type: pick(rng, PROP_TYPES),
    x: Math.round((rng() * 2 - 1) * GROUND_HALF_EXTENT * 0.9),
    z: Math.round((rng() * 2 - 1) * GROUND_HALF_EXTENT * 0.9),
    scale: Math.round((0.6 + rng() * 1.2) * 10) / 10,
  }));

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

  const worldState = { narrative, scene: { biome, mood, time_of_day, props }, choices };

  return { worldState, newHistory: [], usage: null, latencyMs: Date.now() - startedAt };
}
