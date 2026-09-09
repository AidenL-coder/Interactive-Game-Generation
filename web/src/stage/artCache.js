const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Loads game art and prepares it for the stage. Backdrops are used as-is; figures and
// portraits are cut out of their background so they can stand on the scene rather than
// sit in a rectangle on top of it.
//
// Everything is cached by exactly what it depicts, so a description that appears in
// three turns is fetched once and the browser never re-composites it.

const cache = new Map();

// The model only emits JPEG, so there is no alpha channel and transparency comes from
// keying out the flat magenta background it was asked for. The per-pixel decision lives
// in chromaKey.js, which is pure and tested.
import { keyAlpha, despill } from "./chromaKey.js";

// If the model ignored the magenta instruction, keying removes almost nothing and the
// figure renders as a raw rectangle pasted onto the scene — a framed picture standing in
// the room. Below this share of keyed pixels the generation is treated as unusable.
//
// A properly isolated object on a flat background keys out 40-70% of the frame, so 0.22
// is comfortably clear of a real cut-out and well above the 10-20% you get when only a
// thin border keyed.
const MIN_KEYED_FRACTION = 0.22;

// The other, nastier failure: the model paints a *print of* the object — a rectangular
// artwork with a magenta margin around it. The rim keys out, passing the fraction test,
// and what survives is a picture in a frame standing on the deck. It is recognisable by
// shape: what remains covers almost the whole image and is almost solidly opaque, which
// no real cut-out object is. Both conditions have to hold, so a genuinely rectangular
// subject (a gauge panel, a door) painted with a proper margin still passes.
const FRAME_COVERAGE = 0.88;
const FRAME_FILL = 0.85;

// And a third failure, which slipped past both of the above: the model paints the subject
// on a background that is *near* magenta rather than magenta — a mauve, a warm grey. Every
// pixel then lands inside the soft edge band instead of being cut, so the result is a
// half-transparent rectangle around the figure. A real cut-out has almost every pixel
// either fully opaque or fully clear, with only a thin rim between; this measures how much
// of the image is stuck in between.
const AMBIGUOUS_LO = 20;
const AMBIGUOUS_HI = 235;
const MAX_AMBIGUOUS_FRACTION = 0.18;

// Above this share of already-transparent pixels, the image arrived with real alpha and
// chroma keying would only risk eating parts of the subject.
const ALPHA_PRESENT_FRACTION = 0.04;

function cutOut(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const total = canvas.width * canvas.height;

  let alreadyTransparent = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 16) alreadyTransparent++;
  if (alreadyTransparent / total > ALPHA_PRESENT_FRACTION) {
    return { canvas, usable: true, keyed: false };
  }

  let keyed = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];

    const alpha = keyAlpha(r, g, b);
    if (alpha === 0) {
      d[i + 3] = 0;
      keyed++;
      continue;
    }
    d[i + 3] = alpha;

    const [dr2, dg2, db2] = despill(r, g, b);
    d[i] = dr2;
    d[i + 1] = dg2;
    d[i + 2] = db2;
  }
  ctx.putImageData(img, 0, 0);

  const keyedFraction = keyed / total;
  if (keyedFraction < MIN_KEYED_FRACTION) {
    return { canvas, usable: false, reason: `only ${(keyedFraction * 100).toFixed(0)}% keyed out` };
  }

  let ambiguous = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > AMBIGUOUS_LO && d[i] < AMBIGUOUS_HI) ambiguous++;
  }
  const ambiguousFraction = ambiguous / total;
  if (ambiguousFraction > MAX_AMBIGUOUS_FRACTION) {
    return {
      canvas,
      usable: false,
      reason: `${(ambiguousFraction * 100).toFixed(0)}% of it keyed only partially, leaving a translucent box`,
    };
  }

  if (looksLikeAFramedPicture(d, canvas.width, canvas.height)) {
    return { canvas, usable: false, reason: "what survived keying is a filled rectangle" };
  }
  return { canvas, usable: true };
}

// Measures the surviving region's bounding box and how solidly it is filled. Sampled on a
// grid rather than per-pixel: this runs on every figure at 1K resolution and the answer is
// a shape judgement, not a precise one.
function looksLikeAFramedPicture(data, width, height) {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 220));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  let sampled = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      sampled++;
      if (data[(y * width + x) * 4 + 3] > 128) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false; // nothing survived; the fraction test already caught it

  const coverage = ((maxX - minX) * (maxY - minY)) / (width * height);
  const boxSamples = ((maxX - minX) / step + 1) * ((maxY - minY) / step + 1);
  const fill = opaque / Math.max(boxSamples, 1);
  return coverage > FRAME_COVERAGE && fill > FRAME_FILL;
}

// Trims fully transparent margin so the subject's real bottom edge sits on the ground
// line. This is what stops figures hovering, and why the generated framing does not have
// to be exact.
function trim(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas; // fully keyed out — nothing to trim

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function toURL(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png");
  });
}

/**
 * Fetches one piece of art.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {"backdrop"|"figure"|"portrait"} args.kind
 * @param {string} args.description
 * @param {object} [args.extra] - backdrop only: { horizon, mood }
 * @returns {Promise<{url: string, aspect: number}|null>} null when unavailable, which
 *   the stage renders as a painted placeholder rather than treating as an error.
 */
export function loadArt({ sessionId, kind, description, extra }) {
  if (!description || !String(description).trim()) return Promise.resolve(null);
  const key = `${kind}::${description}`;
  if (cache.has(key)) return cache.get(key);

  const job = (async () => {
    try {
      const fetchArt = (regenerate) => {
        const params = new URLSearchParams({ kind, description });
        if (sessionId) params.set("sid", sessionId);
        if (extra?.horizon !== undefined) params.set("horizon", String(extra.horizon));
        if (extra?.mood) params.set("mood", extra.mood);
        if (regenerate) params.set("regenerate", "1");
        return fetch(`${API_BASE}/2d/art?${params}`);
      };

      const res = await fetchArt(false);
      if (!res.ok) return null;

      const bitmap = await createImageBitmap(await res.blob());

      // Backdrops fill the frame — there is nothing to cut them out of.
      if (kind === "backdrop") {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        return { url: await toURL(canvas), aspect: bitmap.width / bitmap.height };
      }

      let cut = cutOut(bitmap);

      // The image model occasionally ignores the flat-background instruction outright.
      // A fresh sample of the same prompt usually complies, and without this retry the
      // unusable image stays cached and that object is a silhouette for the whole game.
      if (!cut.usable) {
        console.warn(
          `[art] "${description.slice(0, 50)}" came back unusable (${cut.reason}) — regenerating`
        );
        const retry = await fetchArt(true);
        if (retry.ok) cut = cutOut(await createImageBitmap(await retry.blob()));
      }

      if (!cut.usable) {
        console.warn(
          `[art] discarding "${description.slice(0, 50)}" — ${cut.reason}, so it would ` +
            "render as a rectangle pasted onto the scene"
        );
        return null;
      }

      const trimmed = trim(cut.canvas);
      return { url: await toURL(trimmed), aspect: trimmed.width / trimmed.height };
    } catch (err) {
      console.warn(`[art] "${String(description).slice(0, 50)}" unavailable:`, err?.message || err);
      return null;
    }
  })();

  cache.set(key, job);
  return job;
}

/** True once this description has been fetched (successfully or not) in this session. */
export function isLoaded(kind, description) {
  return cache.has(`${kind}::${description}`);
}

/**
 * Generates every picture a scene needs before the player is shown it, reporting
 * progress. A world that appears finished is worth far more than one that starts sooner
 * and materialises around the player over the following minute.
 */
export async function prewarmScene({ sessionId, scene, bible, onProgress }) {
  const jobs = [];

  if (scene?.backdrop?.description) {
    jobs.push({
      label: "painting the place",
      kind: "backdrop",
      description: scene.backdrop.description,
      run: () =>
        loadArt({
          sessionId,
          kind: "backdrop",
          description: scene.backdrop.description,
          extra: { horizon: scene.backdrop.horizon, mood: scene.backdrop.mood },
        }),
    });
  }

  if (bible?.protagonist) {
    jobs.push({
      label: "drawing you",
      kind: "figure",
      description: bible.protagonist,
      run: () => loadArt({ sessionId, kind: "figure", description: bible.protagonist }),
    });
  }

  for (const actor of scene?.actors || []) {
    jobs.push({
      label: actor.label,
      kind: "figure",
      description: actor.label,
      run: () => loadArt({ sessionId, kind: "figure", description: actor.label }),
    });
    if (actor.character) {
      jobs.push({
        label: actor.label,
        kind: "portrait",
        description: actor.label,
        run: () => loadArt({ sessionId, kind: "portrait", description: actor.label }),
      });
    }
  }

  // Anything already fetched resolves instantly from the cache, so counting it would make
  // a turn that paints one new object report "3 of 12" and sit at 11 for no reason.
  const pending = jobs.filter((job) => !isLoaded(job.kind, job.description));

  let done = 0;
  const total = pending.length;
  if (!total) return;
  onProgress?.(0, total, pending[0]?.label || "");

  // Generation is the slow part and the server dedupes concurrent identical requests, so
  // these run in parallel. Progress is reported as each lands rather than in order.
  await Promise.all(
    pending.map(async (job) => {
      try {
        await job.run();
      } catch {
        // A missing picture degrades to a placeholder; it must not block entry.
      }
      done++;
      onProgress?.(done, total, job.label);
    })
  );
}
