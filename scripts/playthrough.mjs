// Drives a real browser through a real game and saves screenshots.
//
// This exists because almost every serious defect in this project has been visual —
// figures floating off the ground, art that would not key out, a horizon in the wrong
// place, panels covering the character. None of those show up in a unit test or a JSON
// dump, and all of them are obvious in a screenshot.
//
// Usage:
//   node scripts/playthrough.mjs [--premise "..."] [--turns 3] [--out .shots]
//                                [--headed] [--keep]
import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const flag = (name) => args.includes(`--${name}`);

const PREMISE =
  arg("premise") ||
  "A diving bell sits on the deck of a rusting salvage barge in the North Sea. Below it " +
    "is a wreck nobody will name, and the crew have stopped answering questions about " +
    "the last diver who went down.";
const TURNS = Number(arg("turns", "2"));
const OUT = arg("out", ".shots");
const BASE = arg("url", "http://localhost:5173");

// Generating a first scene's art is minutes of work, not seconds.
const CURTAIN_TIMEOUT = 8 * 60 * 1000;
const TURN_TIMEOUT = 5 * 60 * 1000;

const log = (...m) => console.log("[playthrough]", ...m);

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

async function main() {
  if (!flag("keep")) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: !flag("headed"),
    // Software rendering: there is no GPU in this environment and the default
    // swiftshader path renders CSS filters and blend modes correctly.
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const problems = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") problems.push(`console.error: ${text}`);
    else if (msg.type() === "warning" && /discard|unavailable|not keyable/i.test(text)) {
      problems.push(`console.warn: ${text}`);
    }
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (req.url().includes("/api/")) problems.push(`request failed: ${req.url()}`);
  });

  log(`opening ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await shot(page, "00-start");

  await page.fill("textarea", PREMISE);
  await page.fill('input[placeholder="Aiden"]', "Aiden");
  await page.fill('input[placeholder="deep sea, folk horror, machines"]', "deep sea, machines");
  await page.click(".start2d-go");

  // The curtain shows the art direction and the streaming prose while the pictures are
  // painted; catching it mid-flight is worth a shot of its own.
  await page.waitForSelector(".curtain-prose", { timeout: TURN_TIMEOUT });
  await page.waitForTimeout(2500);
  await shot(page, "01-curtain");

  log("waiting for the world to finish painting (this is the slow part)…");
  await page.waitForSelector(".game2d", { timeout: CURTAIN_TIMEOUT });
  // Let the backdrop fade in and the first beats play out.
  await page.waitForTimeout(4000);
  await shot(page, "02-opening");

  // What the scene actually contains, as the renderer sees it — this catches figures
  // placed off-stage or sized absurdly, which a screenshot alone can be ambiguous about.
  const report = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".stage-actor")];
    const root = document.querySelector(".stage-root")?.getBoundingClientRect();
    return {
      viewport: { w: innerWidth, h: innerHeight },
      stageWidth: document.querySelector(".stage-camera")?.getBoundingClientRect().width,
      backdrop: {
        loaded: document.querySelector(".stage-backdrop")?.classList.contains("loaded"),
        image: document.querySelector(".stage-backdrop")?.style.backgroundImage || "",
      },
      actors: nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          id: n.dataset.actorId || "PLAYER",
          anchor: n.dataset.anchor,
          placeholder: n.classList.contains("placeholder"),
          hasArt: n.classList.contains("has-art"),
          inReach: n.classList.contains("in-reach"),
          // Whether the player can actually see themselves: on screen horizontally, and
          // not entirely behind another cut-out.
          onScreen: r.right > 0 && r.left < innerWidth,
          left: Math.round(r.left - (root?.left || 0)),
          bottom: Math.round(r.bottom - (root?.top || 0)),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }),
      choices: [...document.querySelectorAll(".choice")].map((c) => ({
        text: c.querySelector(".choice-text")?.textContent,
        locked: c.classList.contains("locked"),
      })),
      objective: document.querySelector(".status-objective")?.textContent,
      progress: document.querySelector(".status-progress-fill")?.style.width,
      title: document.querySelector(".status-title")?.textContent,
    };
  });
  await writeFile(path.join(OUT, "scene.json"), JSON.stringify(report, null, 2));
  // A backdrop that fell back to the painted gradient still renders a plausible-looking
  // scene, so this failure hid in plain sight for a whole session until the screenshot
  // was compared against an earlier one. Assert on it.
  if (!report.backdrop.image.includes("url(")) {
    problems.push("NO BACKDROP ARTWORK — the stage fell back to the gradient placeholder");
    log("!! backdrop artwork missing; the stage is using the fallback gradient");
  }

  const placeholders = report.actors.filter((a) => a.placeholder);
  log(`actors on stage: ${report.actors.length}, placeholders: ${placeholders.length}`);
  if (placeholders.length) problems.push(`no artwork for: ${placeholders.map((a) => a.id).join(", ")}`);

  const player = report.actors.find((a) => a.id === "PLAYER");
  if (!player) problems.push("the player's own figure is not on stage at all");
  else {
    log(`player at x=${player.left}..${player.left + player.w}, ${player.onScreen ? "on screen" : "OFF SCREEN"}`);
    if (!player.onScreen) problems.push("the player's figure is off screen at the opening");
    // Standing inside something means the player is simply invisible.
    // Compare centres, not bounding boxes. A cut-out's DOM box spans the whole image
    // including its transparent margins, so a wide prop's box can swallow the player's
    // midpoint while the painted art is nowhere near it — this reported the player
    // "overlapping" a projector that the scene data puts a third of the stage away.
    const playerCentre = player.left + player.w * 0.5;
    const behind = report.actors.filter((a) => {
      if (a.id === "PLAYER") return false;
      const centre = a.left + a.w * 0.5;
      return Math.abs(centre - playerCentre) < (a.w + player.w) * 0.25;
    });
    if (behind.length) problems.push(`player spawned overlapping: ${behind.map((a) => a.id).join(", ")}`);
  }

  // Walk to the far right so the camera pans — a still of the spawn position cannot show
  // whether the stage is actually wider than the screen.
  await page.mouse.click(1450, 620);
  await page.waitForTimeout(3500);
  await shot(page, "03-walked-right");

  // Examine whatever is now within reach.
  const reachable = await page.$(".stage-actor.in-reach");
  if (reachable) {
    await reachable.click();
    await page.waitForTimeout(2200);
    await shot(page, "04-examined");
  } else {
    log("nothing in reach after walking — proximity may be too tight");
    problems.push("nothing was in reach after walking to the far side");
  }

  let ended = false;

  for (let turn = 1; turn <= TURNS; turn++) {
    // A finished story has no next choice, which is correct and used to leave this
    // waiting five minutes for a button that is never coming.
    if (await page.$(".ending")) {
      ended = true;
      break;
    }

    const dismiss = await page.$(".examine-actions button.ghost");
    if (dismiss) await dismiss.click();

    // Prefer a choice we can take from here. If every choice is gated — which is a
    // normal turn, not a dead end — click a locked one to walk there, then take it.
    let choice = await page.$(".choice:not(.locked):not(.ghost):not([disabled])");
    if (!choice) {
      const locked = await page.$(".choice.locked:not([disabled])");
      if (!locked) {
        log("no choices at all — stopping");
        break;
      }
      log("every choice is gated; walking to the first one");
      await locked.click();
      // The walk is a few seconds; the choice unlocks on arrival.
      await page
        .waitForSelector(".choice:not(.locked):not(.ghost):not([disabled])", { timeout: 20000 })
        .catch(() => {});
      choice = await page.$(".choice:not(.locked):not(.ghost):not([disabled])");
      if (!choice) {
        problems.push("walking to a gated choice did not unlock it");
        log("walking there did not unlock it — stopping");
        break;
      }
      await shot(page, `1${turn}-turn${turn}-walked`);
    }

    const text = await choice.textContent();
    log(`turn ${turn}: "${text?.trim().slice(0, 60)}"`);
    await choice.click();

    // Prose should start appearing quickly; that is the whole point of streaming.
    const startedAt = Date.now();
    // waitForFunction's second argument is `arg`, not options — passing the options
    // object there silently left Playwright's 30s default in place, which failed a run
    // on a turn that was simply taking a while to start.
    await page.waitForFunction(
      () => (document.querySelector(".narrative-body")?.textContent || "").length > 40,
      undefined,
      { timeout: TURN_TIMEOUT }
    );
    log(`  first prose after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    await page.waitForTimeout(1500);
    await shot(page, `1${turn}-turn${turn}-streaming`);

    // Either the next set of choices arrives, or the story has ended.
    await page.waitForSelector(".choices .choice:not([disabled]), .ending", {
      timeout: TURN_TIMEOUT,
    });
    await page.waitForTimeout(3000);
    await shot(page, `1${turn}-turn${turn}-done`);

    if (await page.$(".ending")) {
      ended = true;
      const outcome = await page.$eval(".ending-outcome", (n) => n.textContent).catch(() => "?");
      log(`the story ended after ${turn} turns: ${outcome}`);
      break;
    }
  }

  if (ended) {
    await page.waitForTimeout(1200);
    await shot(page, "98-ending");
  } else {
    log(`ran out of turns at ${TURNS} without reaching an ending`);
  }

  await shot(page, "99-final");

  if (!flag("keep")) await browser.close();

  if (problems.length) {
    console.log("\n--- problems ---");
    for (const p of [...new Set(problems)]) console.log("  " + p);
  } else {
    console.log("\nno console errors or failed requests");
  }
}

main().catch((err) => {
  console.error("[playthrough] failed:", err);
  process.exit(1);
});
