import * as THREE from "three";

// Look derived from the environment the model authored for this specific scene, rather
// than looked up from a biome table. Every value here comes from generated data, which
// is what lets "bioluminescent fungal cavern" and "sunlit orchard" render as genuinely
// different places instead of two entries in the same preset list.

const FALLBACK = {
  ground: "#6b6459",
  fog: "#9aa0a6",
  light: "#fff4e0",
  ambient: "#b9c3cc",
  scatter: "#5f6b45",
};

function colorOf(value, fallback) {
  try {
    return new THREE.Color(value || fallback);
  } catch {
    // A malformed colour shouldn't take the whole scene down.
    return new THREE.Color(fallback);
  }
}

export function paletteOf(environment) {
  const p = environment?.palette || {};
  return {
    ground: colorOf(p.ground, FALLBACK.ground),
    fog: colorOf(p.fog, FALLBACK.fog),
    light: colorOf(p.light, FALLBACK.light),
    ambient: colorOf(p.ambient, FALLBACK.ambient),
    scatter: colorOf(p.scatter || p.ground, FALLBACK.scatter),
  };
}

const clamp01 = (v, fallback) => (typeof v === "number" && v >= 0 && v <= 1 ? v : fallback);

/**
 * Light intensities from the scene's light_level. The floor is deliberately well above
 * zero: a "dark" scene still has to be legible to walk through, and atmosphere comes
 * from colour and contrast rather than from an unlit frame.
 */
export function lightingOf(environment) {
  const level = clamp01(environment?.light_level, 0.7);
  return {
    sun: 0.45 + level * 1.7,
    ambient: 0.55 + level * 0.8,
    // Low light sits the sun lower in the sky for long, raking shadows.
    sunHeight: 6 + level * 20,
  };
}

/** Fog distances from visibility: 0 closes in tight, 1 opens to the horizon. */
export function fogOf(environment) {
  const v = clamp01(environment?.visibility, 0.6);
  return { near: 10 + v * 30, far: 40 + v * 90 };
}

export function scatterDensityOf(environment) {
  return clamp01(environment?.scatter_density, 0.45);
}
