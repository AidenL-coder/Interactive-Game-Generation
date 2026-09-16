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

// The worst cut-out failure, because it survives every other check: the model paints the
// subject inside a fully rendered scene and puts the magenta around it as a *border*. The
// border keys out cleanly, so the keyed fraction looks healthy and the alpha is crisp —
// and what stands on the stage is a complete illustration in a frame, floating in mid-air.
//
// It is recognisable by shape. What survives covers nearly the whole image and is almost
// solidly opaque. A real cut-out never is: a standing figure fills perhaps 40% of its own
// bounding box, because arms, legs and negative space are transparent.
export const FRAME_COVERAGE = 0.7;
export const FRAME_FILL = 0.85;

/**
 * Whether what survived keying is a filled rectangle rather than a cut-out object.
 *
 * Sampled on a grid rather than per-pixel: this runs on every figure at 1K resolution and
 * the answer is a judgement about shape, not a precise measurement.
 *
 * @param {Uint8ClampedArray} data - RGBA pixels, alpha already applied
 */
export function looksLikeAFramedPicture(data, width, height) {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 220));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (data[(y * width + x) * 4 + 3] > 128) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false; // nothing survived; the keyed-fraction test catches that

  const coverage = ((maxX - minX) * (maxY - minY)) / (width * height);
  const boxSamples = ((maxX - minX) / step + 1) * ((maxY - minY) / step + 1);
  const fill = opaque / Math.max(boxSamples, 1);
  return coverage > FRAME_COVERAGE && fill > FRAME_FILL;
}

/**
 * Eats the contaminated pixels at the edge of a cut-out.
 *
 * Despill pulls red and blue down toward green, which is right in the middle of a subject
 * but wrong at its rim: a bright magenta fringe pixel has all three channels pulled
 * together at a high value, so it comes out *white*. The result is a hard white outline
 * traced around the figure — the exact opposite of the magenta halo despill exists to
 * prevent, and just as obviously wrong.
 *
 * No amount of colour correction fixes a pixel that is mostly background. Cutting them
 * away does. This erodes the opaque region by a couple of pixels and then softens what is
 * left, which removes white rims and magenta rims together.
 *
 * @param {Uint8ClampedArray} data - RGBA, modified in place
 * @param {number} passes - pixels to eat; JPEG fringing is about two deep
 */
export function erodeAlpha(data, width, height, passes = 2) {
  const n = width * height;
  let alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3];

  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(alpha);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (alpha[i] === 0) continue;
        // Touching the background, or the frame edge, means this pixel's colour is part
        // background and cannot be trusted.
        const edge =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          alpha[i - 1] === 0 ||
          alpha[i + 1] === 0 ||
          alpha[i - width] === 0 ||
          alpha[i + width] === 0;
        if (edge) next[i] = 0;
      }
    }
    alpha = next;
  }

  // One box blur over the mask so the new edge is not a hard jagged step.
  const soft = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += alpha[yy * width + xx];
          count++;
        }
      }
      // Clamped to the eroded mask so the blur only ever softens inward. A plain
      // symmetric blur spreads alpha back out over the pixels erosion just removed —
      // and those pixels still hold their original contaminated colour, so reviving
      // them at partial alpha paints the white rim straight back on.
      soft[i] = Math.min(Math.round(sum / count), alpha[i]);
    }
  }

  for (let i = 0; i < n; i++) data[i * 4 + 3] = soft[i];
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
