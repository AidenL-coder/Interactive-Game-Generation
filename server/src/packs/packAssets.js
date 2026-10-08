import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = path.join(__dirname, "..", "..", "..", "packs");

// Where a pack keeps its 3D assets, alongside its 2D art:
//
//   packs/<id>/3d/textures/<name>   sky, ground and material textures
//   packs/<id>/3d/geometry/<name>   assembled-parts JSON per object
//
// The 2D art endpoint is handed a session, so it knows which pack to look in. The 3D
// asset endpoints are not: a texture or geometry request carries only the label it was
// generated from. That turns out not to matter, because every filename here is a hash of
// exactly that label (and form). A file of the right name in any pack IS the right asset
// by construction, so the lookup can search every pack without knowing which one asked —
// and the renderer needs no changes at all to play a pack.
export const PACK_ASSET_KINDS = ["textures", "geometry"];

export function packAssetDir(packId, kind) {
  return path.join(PACKS_DIR, packId, "3d", kind);
}

// The list of pack directories, not their contents. Contents are read per request
// rather than indexed, because the bake script writes new files into a running server's
// pack directories and a cached index would go stale silently — which is the one failure
// a pack exists to rule out.
let packIds = null;
async function knownPacks() {
  if (packIds) return packIds;
  try {
    const entries = await readdir(PACKS_DIR, { withFileTypes: true });
    packIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    packIds = [];
  }
  return packIds;
}

/**
 * A shipped 3D asset by its cache filename, or null.
 *
 * @param {"textures"|"geometry"} kind
 * @param {string} fileName - exactly the name the generated cache would use
 * @returns {Promise<Buffer|null>}
 */
export async function readPackAsset(kind, fileName) {
  if (!PACK_ASSET_KINDS.includes(kind) || !fileName || fileName.includes("..") || /[\\/]/.test(fileName)) {
    return null;
  }
  for (const id of await knownPacks()) {
    try {
      return await readFile(path.join(packAssetDir(id, kind), fileName));
    } catch {
      // not in this pack
    }
  }
  return null;
}

/** For the bake script, which may create a pack directory the server has not seen. */
export function forgetPackAssets() {
  packIds = null;
}
