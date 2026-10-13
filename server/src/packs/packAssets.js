import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = path.join(__dirname, "..", "..", "..", "packs");

// Where a pack keeps its 3D assets, alongside its 2D art:
//
//   packs/<id>/3d/textures/<name>   sky, ground and material textures
//   packs/<id>/3d/geometry/<name>   assembled-parts JSON per object
//
// A 3D asset request names its pack (`?pack=<id>`), and only that pack's directory is
// searched.
//
// The first version searched every pack, on the reasoning that a filename is a hash of
// the label that produced it, so a file of the right name in any pack must be the right
// asset. That held only while a pack's textures were generated exactly as the shared
// cache would have generated them. A pack's 3D textures are painted to its own art
// direction — the navy technical-diagram look of the transformers pack, say — so under
// search-everything, any other 3D game asking for "cast iron" would have been handed
// this pack's navy diagram texture. Asking the request to say which pack it belongs to
// is the only lookup that cannot leak one game's look into another.
export const PACK_ASSET_KINDS = ["textures", "geometry"];

/** A pack id as it may appear in a URL: the same rule loadPack enforces on disk. */
export function isPackId(id) {
  return typeof id === "string" && /^[a-z0-9-]+$/.test(id);
}

export function packAssetDir(packId, kind) {
  return path.join(PACKS_DIR, packId, "3d", kind);
}

/**
 * A pack's shipped 3D asset by its cache filename, or null.
 *
 * Read per request rather than indexed: the bake script writes into a running server's
 * pack directories, and a cached index would go stale silently — the one failure a pack
 * exists to rule out.
 *
 * @param {"textures"|"geometry"} kind
 * @param {string} fileName - exactly the name the generated cache would use
 * @param {string|null} packId - the pack the request belongs to; null means none
 * @returns {Promise<Buffer|null>}
 */
export async function readPackAsset(kind, fileName, packId) {
  if (!isPackId(packId)) return null;
  if (!PACK_ASSET_KINDS.includes(kind) || !fileName || fileName.includes("..") || /[\\/]/.test(fileName)) {
    return null;
  }
  try {
    return await readFile(path.join(packAssetDir(packId, kind), fileName));
  } catch {
    return null;
  }
}

/** Kept for the bake script's call site; there is no index left to forget. */
export function forgetPackAssets() {}
