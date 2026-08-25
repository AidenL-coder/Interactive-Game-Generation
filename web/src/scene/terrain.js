// Deterministic terrain relief. Every consumer — the ground mesh, prop placement, the
// player's eye height, scatter — samples the same function, so nothing floats or sinks
// relative to anything else. Seeded per scene so a given world is always the same
// shape, which keeps the render deterministic given a WorldState (see docs/research.md).

const AMPLITUDE = 1.15; // gentle: enough to kill the "flat plane" read, not enough to trip on
const FREQUENCY = 0.045;

function hash2(ix, iz, seed) {
  let h = ix * 374761393 + iz * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

// Bilinearly-interpolated value noise. Cheap, and smooth enough that walking over it
// doesn't feel like stairs.
function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);

  const n00 = hash2(x0, z0, seed);
  const n10 = hash2(x0 + 1, z0, seed);
  const n01 = hash2(x0, z0 + 1, seed);
  const n11 = hash2(x0 + 1, z0 + 1, seed);

  return (
    n00 * (1 - fx) * (1 - fz) +
    n10 * fx * (1 - fz) +
    n01 * (1 - fx) * fz +
    n11 * fx * fz
  );
}

export function seedFromScene(scene) {
  const key = `${scene?.biome}|${scene?.mood}|${scene?.time_of_day}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/** Ground height at a world position. Two octaves: broad swells plus finer bumps. */
export function heightAt(x, z, seed) {
  const base = valueNoise(x * FREQUENCY, z * FREQUENCY, seed);
  const detail = valueNoise(x * FREQUENCY * 3.1, z * FREQUENCY * 3.1, seed + 7);
  return (base * 0.75 + detail * 0.25 - 0.5) * 2 * AMPLITUDE;
}

/** Seeded RNG for scatter placement, so a world's clutter is stable across visits. */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
