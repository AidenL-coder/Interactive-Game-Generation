#!/usr/bin/env node
// Paints every picture a pack needs and files it inside the pack, so the game ships
// complete and starts instantly on a machine that has never run it.
//
// A pack's promise is that nobody waits. That promise is kept here or not at all: if one
// backdrop is missing when someone presses play, they sit in front of a curtain for
// ninety seconds and the pack has failed at the only thing it exists to do. So this
// enumerates the manifest rather than trusting a playthrough to have touched everything
// — a story that never walks into the fifth room would leave that room unpainted, and
// the gap would only surface in front of an audience.
//
// Safe to re-run: anything already baked is skipped, so an interrupted bake resumes and
// a pack that gains a room only pays for the new room.
//
// Usage:
//   node scripts/bake-pack.mjs attention-engine
//   node scripts/bake-pack.mjs attention-engine --force      # repaint everything
//   node scripts/bake-pack.mjs attention-engine --check      # report, generate nothing
//   node scripts/bake-pack.mjs attention-engine --no-verify  # skip the cut-out check
//   node scripts/bake-pack.mjs attention-engine --3d         # build the 3D world instead
//   node scripts/bake-pack.mjs attention-engine --3d --check
//   node scripts/bake-pack.mjs attention-engine --3d --force-materials   # repaint object materials only
//
// Verification drives a real browser against the web dev server, so "npm run dev:web"
// must be running unless --no-verify is passed.
import { mkdir, writeFile, readFile, stat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, "server", ".env") });

const { loadPack, packArtDir } = await import("../server/src/packs/loadPack.js");
const { getArt, artFileName, artGenEnabled } = await import("../server/src/art/artGen.js");

const args = process.argv.slice(2);
const packId = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");
const checkOnly = args.includes("--check");
const noVerify = args.includes("--no-verify");
const baseUrl = (args.indexOf("--url") !== -1 && args[args.indexOf("--url") + 1]) || "http://localhost:5173";

// Four at a time. The image API is the bottleneck and a cold pack is thirty-odd calls;
// unbounded parallelism just trades a rate-limit error for a slower bake.
const CONCURRENCY = 4;

if (!packId) {
  console.error("Usage: node scripts/bake-pack.mjs <packId> [--force] [--check]");
  process.exit(1);
}

/** Everything the pack will ever ask the art endpoint for. */
function manifest(pack) {
  const jobs = [];

  for (const place of pack.places) {
    jobs.push({
      kind: "backdrop",
      description: place.backdrop.description,
      extra: { horizon: place.backdrop.horizon, mood: place.backdrop.mood },
      label: `${place.id} (backdrop)`,
    });
  }

  for (const actor of pack.cast) {
    jobs.push({ kind: "figure", description: actor.label, label: `${actor.id} (figure)` });
    // Anyone who can be spoken to gets a portrait for dialogue as well as a full-body
    // figure. Missing one means a conversation with a blank face.
    if (actor.character) {
      jobs.push({ kind: "portrait", description: actor.label, label: `${actor.id} (portrait)` });
    }
  }

  // The player's own figure is painted from the art direction's protagonist line and is
  // on screen in every single scene — the easiest thing to forget and the most visible.
  if (pack.bible?.protagonist) {
    jobs.push({ kind: "figure", description: pack.bible.protagonist, label: "the player (figure)" });
  }

  // The same description can legitimately appear twice; it is one picture.
  const seen = new Set();
  return jobs.filter((j) => {
    const key = `${j.kind}:${j.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks that each figure can actually be cut out of its magenta background.
 *
 * A file on disk is not a usable picture. The image model occasionally ignores the
 * flat-background instruction and paints a whole scene, or surrounds the subject with a
 * pale fringe, and the browser then refuses the cut-out and draws a coloured silhouette
 * instead. On a generated game that self-corrects — the client asks for a fresh sample —
 * but a pack is supposed to be finished, and there is nothing to correct it at play
 * time. The Embedding Vault shipped with a flat teal blob where its glass lamp should
 * have been, and the bake had called itself complete.
 *
 * Runs the real browser code rather than a reimplementation of it: the page imports
 * web/src/stage/artCache.js from the dev server, so this cannot drift from what the game
 * will actually do with the same bytes.
 */
async function verifyCutouts(jobs, baseUrl) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch {
    await browser.close();
    throw new Error(`could not reach the web dev server at ${baseUrl} — start it with "npm run dev:web", or pass --no-verify`);
  }

  const results = [];
  for (const job of jobs) {
    const b64 = (await readFile(job.file)).toString("base64");
    const verdict = await page.evaluate(async (data) => {
      const { cutOut } = await import("/src/stage/artCache.js");
      const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      const { usable, reason } = cutOut(bmp);
      return { usable, reason: reason || "" };
    }, b64);
    results.push({ ...job, ...verdict });
  }

  await browser.close();
  return results;
}

/** Runs `fn` over `items` at most `limit` at a time, in order of completion. */
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

/**
 * Builds and files every 3D asset a pack can ask for.
 *
 * A 3D room needs a sky and a ground texture, and every object in it needs its assembled
 * geometry plus a tiling texture for each material that geometry names. Materials are
 * only knowable after the geometry exists, so this runs in two waves rather than one.
 *
 * The 3D endpoints carry no session — a request is just a label — so the assets are
 * filed under exactly the cache name the server derives from that label. The server
 * then finds them in the pack without the renderer knowing a pack is involved at all.
 */
async function bake3d(pack) {
  const { generateTexture, textureFileName, textureGenEnabled } = await import("../server/src/textures/textureGen.js");
  const { generateGeometry, geometryFileName, geometryGenEnabled } = await import("../server/src/geometry/geometryGen.js");
  const { styleLine } = await import("../server/src/art/styleBible.js");
  // The same art direction the 2D stage is painted to, verbatim. Without it the 3D world
  // was textured from stock-photo defaults — a photographic storm sky over a navy
  // technical-diagram hall — and a 2D-versus-3D comparison of this pack would have been
  // measuring "art-directed versus not" as much as "2D versus 3D".
  const style = styleLine(pack.bible);
  const { packAssetDir, forgetPackAssets } = await import("../server/src/packs/packAssets.js");
  const { validatePack3d, hasWorld3d, materialMode } = await import("../shared/pack3d.js");

  if (!hasWorld3d(pack)) {
    console.error(`${pack.id} has no 3D world (no environment3d on its places).`);
    process.exit(1);
  }
  const problems = validatePack3d(pack);
  if (problems.length) {
    console.error(`${pack.id}'s 3D world is invalid:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  const texDir = packAssetDir(pack.id, "textures");
  const geoDir = packAssetDir(pack.id, "geometry");
  await mkdir(texDir, { recursive: true });
  await mkdir(geoDir, { recursive: true });
  forgetPackAssets();

  // Wave 1: the rooms and the objects.
  const textures = new Map(); // fileName -> {kind, label, propType, lightLevel, why}
  const addTexture = (spec, why) => {
    const name = textureFileName(spec);
    if (!textures.has(name)) textures.set(name, { ...spec, why, file: path.join(texDir, name) });
  };
  for (const place of pack.places) {
    const env = place.environment3d;
    addTexture({ kind: "sky", label: env.description, lightLevel: env.light_level }, `${place.id} sky`);
    addTexture({ kind: "ground", label: env.ground_cover }, `${place.id} ground`);
  }

  const objects = new Map(); // fileName -> {label, form, ids}
  for (const actor of pack.cast) {
    const name = geometryFileName(actor.label, actor.form3d);
    if (!objects.has(name)) objects.set(name, { label: actor.label, form: actor.form3d, ids: [], file: path.join(geoDir, name) });
    objects.get(name).ids.push(actor.id);
  }

  const missingGeo = [];
  for (const o of objects.values()) if (force || !(await exists(o.file))) missingGeo.push(o);

  console.log(`pack "${pack.title}" — 3D world`);
  console.log(`  rooms           : ${pack.places.length} (sky + ground each)`);
  console.log(`  objects         : ${objects.size} (${objects.size - missingGeo.length} already built)`);

  if (checkOnly) {
    // Materials can only be enumerated from geometry that exists.
    const parts = [];
    for (const o of objects.values()) if (await exists(o.file)) parts.push(...JSON.parse(await readFile(o.file, "utf8")));
    for (const m of new Set(parts.map((p) => String(p?.material || "").trim().toLowerCase()).filter(Boolean))) {
      addTexture({ kind: "prop", label: m }, `material "${m}"`);
    }
    const missingTex = [];
    for (const t of textures.values()) if (!(await exists(t.file))) missingTex.push(t.why);
    const gaps = [...missingGeo.map((o) => `geometry: ${o.ids.join(", ")}`), ...missingTex.map((w) => `texture: ${w}`)];
    if (gaps.length) {
      console.log("\nmissing:");
      for (const g of gaps) console.log(`  ${g}`);
      if (missingGeo.length) console.log("  (materials of unbuilt objects cannot be listed until they are built)");
    }
    console.log(gaps.length ? "\nINCOMPLETE — this 3D world would build assets while someone waited." : "\ncomplete");
    process.exit(gaps.length ? 1 : 0);
  }

  if (missingGeo.length && !geometryGenEnabled) {
    console.error("\nANTHROPIC_API_KEY is not set — cannot build geometry.");
    process.exit(1);
  }

  const startedAt = Date.now();
  const failedGeo = [];

  console.log("\nbuilding geometry…");
  await pool(missingGeo, CONCURRENCY, async (o) => {
    const t0 = Date.now();
    try {
      const parts = await generateGeometry(o.label, o.form, { style });
      if (!Array.isArray(parts) || !parts.length) throw new Error("no parts");
      await writeFile(o.file, JSON.stringify(parts));
      console.log(`  ${o.ids.join(", ").padEnd(26)} ${String(parts.length).padStart(2)} parts  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      failedGeo.push(o);
      console.log(`  ${o.ids.join(", ").padEnd(26)} FAILED: ${err.message || err}`);
    }
  });

  // Wave 2: every material the built geometry names, plus a billboard sprite for any
  // object whose geometry could not be built — that is what the renderer falls back to.
  // A flat-material pack has no material textures by design (see MATERIAL_MODES in
  // shared/pack3d.js), so there is nothing to paint, and the sweep below removes any left
  // over from before the pack was flat.
  const flat = materialMode(pack) === "flat";
  if (flat) console.log("\nmaterials: flat palette colour, no textures (world3d.materials = flat)");
  for (const o of objects.values()) {
    if (flat || !(await exists(o.file))) continue;
    for (const part of JSON.parse(await readFile(o.file, "utf8"))) {
      // Normalised exactly as the client's materialsIn() does, or the names differ.
      const m = String(part?.material || "").trim().toLowerCase();
      if (m) addTexture({ kind: "prop", label: m }, `material "${m}"`);
    }
  }
  for (const o of failedGeo) addTexture({ kind: "sprite", propType: o.form, label: o.label }, `${o.ids.join(", ")} sprite fallback`);

  const missingTex = [];
  // --force-materials repaints only the object materials, keeping geometry, sky and ground.
  const forceMaterials = args.includes("--force-materials");
  for (const t of textures.values()) {
    if (force || (forceMaterials && t.kind === "prop") || !(await exists(t.file))) missingTex.push(t);
  }
  console.log(`\npainting ${missingTex.length} texture(s) (${textures.size - missingTex.length} already on disk)…`);

  if (missingTex.length && !textureGenEnabled) {
    console.error("GOOGLE_API_KEY / GEMINI_API_KEY is not set — cannot paint textures.");
    process.exit(1);
  }

  const failedTex = [];
  await pool(missingTex, CONCURRENCY, async (t) => {
    const t0 = Date.now();
    try {
      const { buffer } = await generateTexture({
        kind: t.kind,
        propType: t.propType,
        label: t.label,
        lightLevel: t.lightLevel,
        style,
      });
      await writeFile(t.file, buffer);
      console.log(`  ${t.why.slice(0, 44).padEnd(44)} ${String(Math.round(buffer.length / 1024)).padStart(4)}kB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      failedTex.push(t);
      console.log(`  ${t.why.slice(0, 44).padEnd(44)} FAILED: ${err.message || err}`);
    }
  });

  console.log(`\ndone in ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);
  const gaps = [...failedGeo.map((o) => `geometry for ${o.ids.join(", ")} (falls back to a sprite)`), ...failedTex.map((t) => t.why)];
  if (failedTex.length) {
    console.log(`\n${gaps.length} gap(s) — re-run to retry:`);
    for (const g of gaps) console.log(`  ${g}`);
    process.exit(1);
  }
  if (failedGeo.length) {
    console.log("\nnote: these objects will render as billboards rather than built geometry:");
    for (const o of failedGeo) console.log(`  ${o.ids.join(", ")}`);
  }

  // Sweep anything the manifest no longer asks for. Rebuilding an object can name new
  // materials, and the textures of the old ones would otherwise ship forever as dead
  // weight in a directory that is committed to the repository.
  const keepGeo = new Set([...objects.keys()]);
  const keepTex = new Set([...textures.keys()]);
  let swept = 0;
  for (const [dir, keep] of [[geoDir, keepGeo], [texDir, keepTex]]) {
    for (const name of await readdir(dir)) {
      if (keep.has(name)) continue;
      await unlink(path.join(dir, name));
      swept++;
    }
  }
  if (swept) console.log(`\nremoved ${swept} asset(s) the manifest no longer uses`);

  console.log(`\n${pack.id} 3D world is complete: ${objects.size - failedGeo.length} objects built, ${textures.size} textures on disk.`);
}

async function exists(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const pack = await loadPack(packId);
  if (!pack) {
    console.error(`no pack at packs/${packId}/pack.json`);
    process.exit(1);
  }

  if (args.includes("--3d")) return bake3d(pack);

  const artDir = packArtDir(pack.id);
  await mkdir(artDir, { recursive: true });

  const jobs = manifest(pack);
  for (const j of jobs) j.file = path.join(artDir, artFileName(j.kind, j.description));

  const missing = [];
  for (const j of jobs) if (force || !(await exists(j.file))) missing.push(j);

  console.log(`pack "${pack.title}" (${pack.id})`);
  console.log(`  art direction : ${pack.bible.id}`);
  console.log(`  pictures      : ${jobs.length}`);
  console.log(`  already baked : ${jobs.length - missing.length}`);
  console.log(`  to paint      : ${missing.length}${force ? " (forced)" : ""}`);

  if (checkOnly) {
    if (missing.length) {
      console.log("\nmissing:");
      for (const j of missing) console.log(`  ${j.label}`);
    }
    console.log(missing.length ? "\nINCOMPLETE — this pack would generate art while someone waited." : "\ncomplete");
    process.exit(missing.length ? 1 : 0);
  }

  // Note: no early return when `missing` is empty. A fully-painted pack still has to be
  // verified — a pack whose files are all present but one of which cannot be cut out is
  // exactly the state that shipped a flat teal blob into the Embedding Vault, and the
  // bake reported "complete" on the way past.
  if (missing.length && !artGenEnabled) {
    console.error("\nGOOGLE_API_KEY / GEMINI_API_KEY is not set — cannot paint anything.");
    process.exit(1);
  }

  if (missing.length) console.log("");
  let done = 0;
  let failed = 0;
  const startedAt = Date.now();

  const queue = [...missing];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      try {
        const { buffer } = await getArt({
          kind: job.kind,
          description: job.description,
          // Passing the pack's bible means a picture already in the generated cache from
          // an earlier session is reused rather than repainted — which is how the six
          // fixtures of the Attention Hall cost nothing to bake.
          bible: pack.bible,
          extra: job.extra,
          regenerate: force,
        });
        await writeFile(job.file, buffer);
        done++;
        console.log(
          `  [${String(done + failed).padStart(2)}/${missing.length}] ${job.label.padEnd(32)} ` +
            `${Math.round(buffer.length / 1024)}kB  ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      } catch (err) {
        failed++;
        console.log(`  [${String(done + failed).padStart(2)}/${missing.length}] ${job.label.padEnd(32)} FAILED: ${err.message || err}`);
      }
    }
  });
  await Promise.all(workers);

  if (missing.length) {
    console.log(
      `\npainted ${done}, failed ${failed}, in ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`
    );
  }

  const stillMissing = [];
  for (const j of jobs) if (!(await exists(j.file))) stillMissing.push(j.label);
  if (stillMissing.length) {
    console.log(`\nSTILL MISSING (${stillMissing.length}) — re-run to retry:`);
    for (const l of stillMissing) console.log(`  ${l}`);
    process.exit(1);
  }

  if (noVerify) {
    console.log(`\n${pack.id}: every picture is on disk (cut-outs unverified).`);
    return;
  }

  // On disk is not the same as usable.
  const cutouts = jobs.filter((j) => j.kind !== "backdrop");
  console.log(`\nchecking ${cutouts.length} cut-outs against the renderer…`);
  let bad = await verifyCutouts(cutouts, baseUrl);
  bad = bad.filter((r) => !r.usable);

  for (let attempt = 1; attempt <= 2 && bad.length; attempt++) {
    console.log(`\n${bad.length} unusable cut-out(s) — repainting (attempt ${attempt}/2):`);
    for (const j of bad) console.log(`  ${j.label}: ${j.reason}`);
    for (const j of bad) {
      try {
        // A fresh sample of the same prompt usually succeeds: the fault is a bad roll,
        // not a bad description.
        const { buffer } = await getArt({ kind: j.kind, description: j.description, bible: pack.bible, regenerate: true });
        await writeFile(j.file, buffer);
      } catch (err) {
        console.log(`  ${j.label}: repaint failed — ${err.message || err}`);
      }
    }
    bad = (await verifyCutouts(bad, baseUrl)).filter((r) => !r.usable);
  }

  if (bad.length) {
    console.log(`\n${bad.length} cut-out(s) STILL unusable — these will render as flat silhouettes:`);
    for (const j of bad) console.log(`  ${j.label}: ${j.reason}`);
    console.log("Reword the label in pack.json, or re-run to roll again.");
    process.exit(1);
  }

  console.log(`\n${pack.id} is complete: every picture is on disk and every cut-out keys cleanly.`);
}

main().catch((err) => {
  console.error("[bake-pack] failed:", err);
  process.exit(1);
});
