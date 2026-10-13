// Which pre-generated pack the 3D world currently belongs to, if any.
//
// Every texture and geometry request names it (`&pack=<id>`), and the server searches only
// that pack's shipped assets. A pack's textures are painted to its own art direction, so
// without this a different game asking for "cast iron" could be handed one pack's styled
// version — see server/src/packs/packAssets.js.
//
// Module-level rather than threaded through every call, because the requests are made
// from half a dozen places deep in the renderer that know nothing about sessions. The
// pack also prefixes each module's in-memory cache key, so a pack game followed by a
// typed-premise game in the same tab cannot reuse each other's textures.
let currentPack = null;
let materials = "textured";

/**
 * Set when a game starts; null for a game generated from a typed premise.
 *
 * @param {string|null} packId
 * @param {object} [world3d] - the pack's 3D settings, from the session
 */
export function setAssetPack(packId, world3d = null) {
  currentPack = typeof packId === "string" && /^[a-z0-9-]+$/.test(packId) ? packId : null;
  materials = currentPack && world3d?.materials === "flat" ? "flat" : "textured";
}

/**
 * True when this pack's objects are drawn in flat palette colours, with no material
 * textures — so none are requested at all. See MATERIAL_MODES in shared/pack3d.js.
 */
export function flatMaterials() {
  return materials === "flat";
}

/** Adds the pack to an asset request's query, when there is one. */
export function withPack(params) {
  if (currentPack) params.set("pack", currentPack);
  return params;
}

/** Namespaces an in-memory cache key by pack. */
export function packKey(key) {
  return `${currentPack || ""}::${key}`;
}
