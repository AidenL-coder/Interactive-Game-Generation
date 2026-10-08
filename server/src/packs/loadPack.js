import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePack } from "../../../shared/pack.js";
import { validatePack3d, hasWorld3d } from "../../../shared/pack3d.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKS_DIR = path.join(__dirname, "..", "..", "..", "packs");

// Packs are read once and held. They are static files that ship with the repo, not user
// content, so re-reading them per request buys nothing — and a pack is a few hundred
// kilobytes of manifest that gets stringified into a system prompt on every turn.
const cache = new Map();
let listing = null;

/** Where a pack keeps the artwork that travels with it. */
export function packArtDir(packId) {
  return path.join(PACKS_DIR, packId, "art");
}

/**
 * Loads one pack by id, or null if there is no such pack.
 *
 * A pack that fails validation throws rather than returning, and the route turns that
 * into a 500. That is deliberate: the alternative is a game that looks like it started
 * correctly and then spends twenty minutes generating the artwork it was supposed to
 * already have, which is the exact failure a pack exists to prevent and is almost
 * impossible to notice from the outside.
 */
export async function loadPack(packId) {
  if (!/^[a-z0-9-]+$/.test(String(packId || ""))) return null;
  if (cache.has(packId)) return cache.get(packId);

  const file = path.join(PACKS_DIR, packId, "pack.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const pack = JSON.parse(raw);
  const errors = validatePack(pack);
  // The 3D half is optional, but if a pack claims one it has to be complete: a pack that
  // half-describes a 3D world would start, then fail to build its second room.
  if (hasWorld3d(pack)) errors.push(...validatePack3d(pack).map((e) => `[3d] ${e}`));
  if (errors.length) {
    throw new Error(`pack "${packId}" is invalid:\n  ${errors.join("\n  ")}`);
  }
  if (pack.id !== packId) {
    throw new Error(`pack in packs/${packId}/ declares id "${pack.id}"`);
  }

  // The art lookup needs to know which pack's directory to search, and the bible is the
  // one object that is already threaded through every art request.
  pack.bible = { ...pack.bible, packId: pack.id };
  // Which renderers can play it. Every valid pack has the 2D stage; the 3D world is an
  // addition, and the 3D start screen only offers packs that have one.
  pack.engines = ["2d", ...(hasWorld3d(pack) ? ["3d"] : [])];

  cache.set(packId, pack);
  return pack;
}

/**
 * Every pack on disk, as the start screen needs them: enough to show and choose, not the
 * whole manifest.
 */
export async function listPacks() {
  if (listing) return listing;

  let entries = [];
  try {
    entries = await readdir(PACKS_DIR);
  } catch {
    return (listing = []);
  }

  const out = [];
  for (const id of entries) {
    try {
      if (!(await stat(path.join(PACKS_DIR, id))).isDirectory()) continue;
      const pack = await loadPack(id);
      if (!pack) continue;
      out.push({
        id: pack.id,
        title: pack.title,
        blurb: pack.blurb,
        places: pack.places.length,
        cast: pack.cast.length,
        targetTurns: pack.targetTurns ?? null,
        engines: pack.engines,
        // What the start screen most wants to say: this one does not make you wait.
        instant: true,
      });
    } catch (err) {
      // One broken pack must not take the menu down with it.
      console.warn(`[packs] skipping "${id}": ${err.message}`);
    }
  }

  listing = out;
  return out;
}

/** Drops the caches. Only used by the bake script, which rewrites manifests in place. */
export function forgetPacks() {
  cache.clear();
  listing = null;
}
