// The decision, per pixel, of what is background and what is subject.
//
// Split out of artCache.js so it can be tested without a DOM: this is pure arithmetic,
// it has been quietly wrong twice, and both times the symptom was a subtly ruined
// picture rather than an error.
//
// The key is measured as "magentaness" — how far red and blue BOTH rise above green —
// rather than as Euclidean distance from magenta in RGB space. Distance is the obvious
// choice and is badly wrong here: mid-grey sits about 220 from magenta and pale grey
// about 215, both inside any keying radius wide enough to catch JPEG-smeared background,
// so every grey or desaturated subject came back half dissolved (a chrome washing machine
// keyed 34% of itself away). Magentaness puts grey, white and black all at zero while
// pure magenta is 255, so the subject's lightness stops mattering — which is the whole
// point of chroma keying.

export const KEY_STRONG = 120; // at or above this, and lit, it is background
export const KEY_WEAK = 55; // below this it is subject; between the two is the soft rim
// Magenta is a bright colour. Requiring both channels to be genuinely lit stops a very
// dark plum shadow inside the subject from being read as backdrop.
export const KEY_MIN_CHANNEL = 85;

// Below this, a red-and-blue-over-green cast is a warm or purple subject colour rather
// than backdrop bleed, so leave it alone.
export const DESPILL_THRESHOLD = 22;

/** How magenta a colour is: 255 for pure magenta, 0 for any grey, black or white. */
export function magentaness(r, g, b) {
  return Math.min(r, b) - g;
}

/**
 * Alpha this pixel should end up with: 0 for background, 255 for subject, and a ramp
 * between for the compression fringe around the edge.
 */
export function keyAlpha(r, g, b) {
  const lit = r >= KEY_MIN_CHANNEL && b >= KEY_MIN_CHANNEL;
  if (!lit) return 255;
  const m = magentaness(r, g, b);
  if (m >= KEY_STRONG) return 0;
  if (m <= KEY_WEAK) return 255;
  return Math.round(((KEY_STRONG - m) / (KEY_STRONG - KEY_WEAK)) * 255);
}

/**
 * Removes backdrop colour that has bled into the subject. Applied to every surviving
 * pixel, not only the soft rim: restricting it to the rim left a magenta outline glowing
 * around every cut-out, because lossy compression smears background colour several pixels
 * deep into the subject, well past the alpha transition.
 *
 * @returns {[number, number, number]} the corrected colour
 */
export function despill(r, g, b) {
  const excess = (r + b) / 2 - g;
  if (excess <= DESPILL_THRESHOLD) return [r, g, b];
  const cut = (excess - DESPILL_THRESHOLD) * 0.9;
  return [Math.max(g, r - cut), g, Math.max(g, b - cut)];
}
