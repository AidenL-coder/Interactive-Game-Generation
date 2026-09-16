// Measures what the stage actually does while the player is moving.
//
// Screenshots are the wrong instrument for this: every individual frame can be correct
// and the motion still look wrong, because the fault is in the timing and in how the
// player's position lands relative to the camera's. This records the real per-frame
// numbers during a walk — frame intervals, camera and player displacement, dropped
// frames, long tasks — and only then takes a burst of stills to pair with them.
//
// Usage:
//   node scripts/motion-probe.mjs [--out .motion] [--seconds 4] [--headed]
import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const OUT = arg("out", ".motion");
const SECONDS = Number(arg("seconds", "4"));
const BASE = arg("url", "http://localhost:5173");

// Cached premise: the art and art direction already exist on disk, so the game opens in
// seconds and the probe measures rendering rather than generation.
const PREMISE =
  arg("premise") ||
  "A signal box on a branch line that closed in 1968. The levers still move. Every night " +
    "at 11:40 the block bell rings twice for a train that has not run in fifty years, and " +
    "tonight the relief signalman has decided to answer it.";

const log = (...m) => console.log("[motion]", ...m);

// Installed in the page. Samples once per animation frame while a walk is running.
function RECORDER() {
  const camera = document.querySelector(".stage-camera");
  const player = document.querySelector(".stage-player");
  const samples = [];
  const longTasks = [];

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* not supported everywhere */
  }

  const readCameraX = () => {
    const t = getComputedStyle(camera).transform;
    if (!t || t === "none") return 0;
    // matrix(a, b, c, d, tx, ty) or matrix3d(...)
    const nums = t.match(/-?[\d.]+/g);
    if (!nums) return 0;
    return nums.length === 6 ? parseFloat(nums[4]) : parseFloat(nums[12]);
  };

  let running = true;
  let last = performance.now();
  const tick = (now) => {
    if (!running) return;
    const cam = readCameraX();
    const rect = player?.getBoundingClientRect();
    samples.push({
      // Absolute timestamp as well as the interval. Analysis has to work in real time:
      // frames get filtered out downstream, and reconstructing a clock by summing the
      // survivors' intervals silently loses however long the dropped ones took.
      t: now,
      dt: now - last,
      cam,
      // Where the player actually appears on screen. This is the number that matters:
      // if it wobbles relative to the camera, the player swims against the backdrop.
      screenX: rect ? rect.left + rect.width / 2 : 0,
      // Their position in stage space, which is what the two should agree on.
      stageX: rect ? rect.left + rect.width / 2 - cam : 0,
    });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__probe = {
    stop() {
      running = false;
      return { samples, longTasks };
    },
  };
}

function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    worst: +s[s.length - 1].toFixed(2),
  };
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: !flag("headed"),
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  // A rejected cut-out renders as a flat silhouette, which is quiet enough to miss in a
  // screenshot and says nothing about why it was rejected. The reason is logged, so catch
  // it: "which assets did the usability checks throw away, and on what grounds" is
  // otherwise unanswerable without guessing.
  const artNotes = [];
  page.on("console", (m) => {
    const text = m.text();
    if (text.includes("[art]")) artNotes.push(text);
  });

  log("opening the game (art is cached, so this is quick)");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("textarea", PREMISE);
  await page.fill('input[placeholder="Aiden"]', "Aiden");
  await page.click(".start2d-go");
  await page.waitForSelector(".game2d", { timeout: 8 * 60 * 1000 });

  // Let the opening beats finish so the walk is the only thing moving.
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector(".skip")?.click());
  await page.waitForTimeout(1200);

  // Walk to the left edge first so there is a full stage width to cross while recording.
  // Movement is driven from the keyboard rather than by clicking the stage: a click lands
  // wherever the interface happens to be, and the first version of this probe spent its
  // whole run having quietly pressed a choice button instead of walking.
  await page.keyboard.down("a");
  await page.waitForTimeout(2500);
  await page.keyboard.up("a");
  await page.waitForTimeout(700);

  log("recording a walk across the stage…");
  await page.evaluate(RECORDER);
  await page.keyboard.down("d");

  const burst = [];
  const frames = Math.min(10, Math.round((SECONDS * 1000) / 220));
  for (let i = 0; i < frames; i++) {
    await page.waitForTimeout(220);
    const file = path.join(OUT, `walk-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: file });
    burst.push(file);
  }
  await page.waitForTimeout(Math.max(0, SECONDS * 1000 - frames * 220));
  await page.keyboard.up("d");

  const { samples, longTasks } = await page.evaluate(() => window.__probe.stop());

  if (!samples.length) throw new Error("no frames sampled at all — the stage never rendered");
  const camMoved = Math.max(...samples.map((s) => s.cam)) - Math.min(...samples.map((s) => s.cam));
  if (camMoved < 1) {
    console.log("\n!! the camera never moved — the walk did not happen.");
    console.log(`   ${samples.length} frames sampled, camera stayed at ${samples[0].cam}`);
    console.log("   first samples:", JSON.stringify(samples.slice(0, 3)));
    await browser.close();
    process.exit(1);
  }
  log(`camera travelled ${Math.round(camMoved)}px over ${samples.length} frames`);

  // Only the frames where the camera was actually moving tell us anything.
  const moving = samples.filter((s, i) => i > 0 && Math.abs(s.cam - samples[i - 1].cam) > 0.01);
  const intervals = moving.map((s) => s.dt);
  const camSteps = moving.map((s, i) => (i ? Math.abs(s.cam - moving[i - 1].cam) : 0)).slice(1);
  const stageSteps = moving
    .map((s, i) => (i ? s.stageX - moving[i - 1].stageX : 0))
    .slice(1);

  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
  };

  // Everything below is measured against TIME, not against frames.
  //
  // The first version of this probe divided the per-frame movement's spread by its mean,
  // which is worthless for comparing two runs at different frame rates: at 60fps each
  // frame covers half the distance it did at 30, so identical noise reports double the
  // jitter. It made a genuine 2x improvement look like a regression. A walk at constant
  // speed covers ground proportional to elapsed time, so the honest questions are whether
  // the *velocity* is steady and how far, in real pixels, the player drifts from where
  // constant motion would have put them.
  // Time between consecutive MOVING frames, measured from absolute timestamps. Using each
  // frame's own `dt` here would divide a step taken since the previous moving frame by the
  // time since the previous *sample*, which are different numbers whenever the camera sat
  // clamped at the edge of the stage for a while.
  const dts = moving.slice(1).map((s, i) => s.t - moving[i].t);
  const velocities = stageSteps.map((d, i) => d / (dts[i] || 16.7));

  // A walk genuinely starts from rest, cruises, then decelerates into the edge of the
  // stage. Measuring smoothness across all of that reports the acceleration profile as
  // judder: the previous version claimed 120px of drift on a walk that had zero backwards
  // frames, and those two cannot both be true. Smoothness is only a meaningful question
  // about the stretch where the player is actually up to speed, so everything below is
  // restricted to the cruise.
  const sortedSpeeds = velocities.map(Math.abs).sort((a, b) => a - b);
  const medianSpeed = sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] || 0;
  const cruise = velocities
    .map((v, i) => (Math.abs(v) >= medianSpeed * 0.6 ? i : -1))
    .filter((i) => i >= 0);

  const cruiseV = cruise.map((i) => velocities[i]);
  const velocityCV = cruiseV.length ? sd(cruiseV) / (Math.abs(mean(cruiseV)) || 1) : 0;
  const camVelocities = camSteps.map((d, i) => d / (dts[i] || 16.7));
  const cruiseCamV = cruise.map((i) => camVelocities[i]).filter(Number.isFinite);
  const camVelocityCV = cruiseCamV.length
    ? sd(cruiseCamV) / (Math.abs(mean(cruiseCamV)) || 1)
    : 0;

  // Least-squares line through the player's stage position against elapsed time. The
  // residual is in pixels, so it means something physical: "the player wobbles this far
  // against the scene while walking."
  const points = cruise.map((i) => ({ t: moving[i + 1].t, x: moving[i + 1].stageX }));
  let maxDevPx = 0;
  let rmsDevPx = 0;
  if (points.length > 2) {
    const mt = mean(points.map((p) => p.t));
    const mx = mean(points.map((p) => p.x));
    const num = mean(points.map((p) => (p.t - mt) * (p.x - mx)));
    const den = mean(points.map((p) => (p.t - mt) ** 2)) || 1;
    const slope = num / den;
    const devs = points.map((p) => Math.abs(p.x - (mx + slope * (p.t - mt))));
    maxDevPx = Math.max(...devs);
    rmsDevPx = Math.sqrt(mean(devs.map((d) => d * d)));
  }

  // An outright reversal — drifting backwards for a frame while walking forwards — is
  // unambiguous desync and cannot be explained away by timing.
  const reversals = cruise.filter((i, k) => {
    if (k === 0) return false;
    const now = Math.sign(velocities[i]);
    const before = Math.sign(velocities[cruise[k - 1]]);
    return now !== 0 && before !== 0 && now !== before;
  }).length;

  const report = {
    movingFrames: moving.length,
    fps: moving.length ? +(1000 / mean(intervals)).toFixed(1) : 0,
    frameMs: stats(intervals),
    droppedOver20ms: intervals.filter((d) => d > 20).length,
    droppedOver32ms: intervals.filter((d) => d > 32).length,
    cameraStepPx: stats(camSteps),
    cameraVelocityCV: +camVelocityCV.toFixed(3),
    playerVelocityCV: +velocityCV.toFixed(3),
    playerDriftPx: { max: +maxDevPx.toFixed(2), rms: +rmsDevPx.toFixed(2) },
    // Without these, a perfect 0.000 is unreadable: it could mean the motion really is
    // frame-perfect, or that the cruise window collapsed to a couple of samples and the
    // spread of two identical numbers is trivially zero. Print the sample size and the
    // speed it was measured at so the zero can be believed or rejected.
    cruiseFrames: cruise.length,
    meanPlayerSpeedPxPerFrame: +(Math.abs(mean(stageSteps)) || 0).toFixed(3),
    reversals,
    longTasksMs: longTasks.slice(0, 12),
  };

  await writeFile(path.join(OUT, "motion.json"), JSON.stringify({ report, samples }, null, 2));

  console.log("\n--- motion while walking ---");
  console.log(`  frames sampled while moving : ${report.movingFrames}`);
  console.log(`  effective fps               : ${report.fps}`);
  console.log(`  frame interval ms           : p50 ${report.frameMs?.p50}  p95 ${report.frameMs?.p95}  worst ${report.frameMs?.worst}`);
  console.log(`  frames over 20ms / 32ms     : ${report.droppedOver20ms} / ${report.droppedOver32ms}`);
  console.log(`  camera velocity variation   : ${report.cameraVelocityCV}  (0 = perfectly steady)`);
  console.log(`  player velocity variation   : ${report.playerVelocityCV}  (0 = perfectly steady)`);
  console.log(`  player drift vs scene       : ${report.playerDriftPx.max}px worst, ${report.playerDriftPx.rms}px rms`);
  console.log(`  measured over               : ${report.cruiseFrames} cruise frames at ${report.meanPlayerSpeedPxPerFrame}px/frame`);
  console.log(`  backwards frames            : ${report.reversals}  (any is real desync)`);
  console.log(`  long tasks (ms)             : ${report.longTasksMs.join(", ") || "none"}`);
  const placeholders = await page.$$eval(".stage-actor.placeholder", (n) => n.length);
  console.log(`\n  actors with no usable artwork : ${placeholders}`);
  for (const note of [...new Set(artNotes)]) console.log(`    ${note}`);

  console.log(`\n  ${burst.length} stills during motion in ${OUT}/`);

  await browser.close();
}

main().catch((err) => {
  console.error("[motion] failed:", err);
  process.exit(1);
});
