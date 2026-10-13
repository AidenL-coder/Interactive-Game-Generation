// A player that plays the first-person 3D game by looking at it.
//
// The same instrument as eval/visionPlayer.mjs, pointed at the other renderer: a real
// browser, a screenshot each step, and a model that decides from the pixels alone. What
// differs is only what first person makes the game:
//
//   - movement is the medium. The player walks, strafes and turns with the same keys a
//     person uses (held for a duration, not teleported), and has a larger budget of free
//     actions per turn, because crossing a room takes several.
//   - a locked choice stays locked until the player is physically near what it names. On
//     the 2D stage pressing one walks you there; here it does nothing, and the player is
//     told so — which is how it learns, as a person would, to go and stand by the thing.
//   - pressing E on whatever is under the crosshair is itself a turn.
//
// Nothing here reads the scene data. State is read from the DOM only to know when a turn
// has finished and to compute the objective counters afterwards; none of it reaches the
// player's prompt.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLAY_ACTION_TOOL_3D, playerSystem3d, matchChoice } from "./rubric.mjs";
import { decide } from "./visionPlayer.mjs";
import { launchBrowser } from "./browser.mjs";

const CURTAIN_TIMEOUT = 8 * 60 * 1000;
const TURN_TIMEOUT = 5 * 60 * 1000;

// Crossing a room is several actions; three, the 2D budget, would force a choice before
// the player could reach anything that a locked choice asks them to stand by.
const MAX_FREE_ACTIONS_PER_TURN = 6;
const MEMORY_TURNS = 5;

// Must match TURN_SPEED in web/src/scene/SceneRenderer.js (1.9 rad/s), so a request for
// a 90-degree turn holds the key for as long as a 90-degree turn takes.
const TURN_DEGREES_PER_SECOND = (1.9 * 180) / Math.PI;

const log = (...m) => console.log("[player3d]", ...m);

/** What the harness needs from the screen, and the player is never told. */
async function readScreen(page) {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;

    const stats = {};
    for (const row of document.querySelectorAll(".status-stats .status-row")) {
      const k = row.querySelector("dt")?.textContent?.trim();
      if (k) stats[k] = row.querySelector("dd")?.textContent?.trim() ?? "";
    }

    const width = document.querySelector(".status-progress-fill")?.style.width || "";
    const progress = /^([\d.]+)%$/.test(width) ? parseFloat(width) / 100 : null;

    const choices = [...document.querySelectorAll(".choice-buttons button")].map((b) => {
      const gate = b.querySelector(".choice-gate")?.textContent?.trim() || "";
      const full = b.textContent.trim();
      const text = gate && full.endsWith(gate) ? full.slice(0, full.length - gate.length).trim() : full;
      return {
        text,
        gate,
        // Sentence and "go to" pill together: the player quotes whichever it can read.
        visible: gate ? `${text} ${gate}` : text,
        locked: b.classList.contains("choice-locked"),
        disabled: b.disabled === true,
      };
    });

    // The crosshair label's own text, without the "E" key badge beside it.
    const focusEl = document.querySelector(".focus-label");
    const focus = focusEl
      ? [...focusEl.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() || null
      : null;

    return {
      objective: text(".status-objective-text"),
      progress,
      place: text(".status-place"),
      stats,
      choices,
      focus,
      ending: Boolean(document.querySelector(".ending-overlay")),
      endingOutcome: text(".ending-outcome"),
      prewarm: Boolean(document.querySelector(".prewarm-overlay")),
      busy: Boolean(document.querySelector(".turn-progress")),
      acting: Boolean(document.querySelector(".skip-button")),
    };
  });
}

/** Waits until the world has finished responding: generated, pre-loaded and acted out. */
async function waitUntilPlayable(page) {
  // A turn shows a progress bar while it is written; a move to a new place then loads
  // that place behind an overlay before revealing it. Either can come after the other.
  for (let pass = 0; pass < 2; pass++) {
    await page.waitForFunction(() => !document.querySelector(".prewarm-overlay"), undefined, { timeout: CURTAIN_TIMEOUT });
    await page.waitForFunction(
      () => document.querySelector(".ending-overlay") || !document.querySelector(".turn-progress"),
      undefined,
      { timeout: TURN_TIMEOUT }
    );
    await page.waitForTimeout(400);
  }

  // The character may act out what just happened. A person can watch or skip; give it
  // a moment, then skip, as an impatient person would.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && (await page.$(".skip-button"))) await page.waitForTimeout(500);
  const skip = await page.$(".skip-button");
  if (skip) await skip.click().catch(() => {});

  // Let fresh textures land before the frame is captured; a frame of half-loaded
  // surfaces would be judged on a moment no player actually sits through.
  await page.waitForTimeout(1500);
}

// Keystrokes go to the focused element. After pressing a choice button the button keeps
// focus, which is harmless, but if the free-text box ever has it the game deliberately
// ignores movement keys — so movement always starts from an unfocused page.
async function releaseFocus(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
}

async function hold(page, code, ms) {
  await releaseFocus(page);
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
  await page.waitForTimeout(250);
}

const MOVES = {
  move_forward: "KeyW",
  move_back: "KeyS",
  strafe_left: "KeyA",
  strafe_right: "KeyD",
  turn_left: "ArrowLeft",
  turn_right: "ArrowRight",
};

/**
 * Carries out one action.
 *
 * @returns {Promise<{advanced: boolean, note: string, targetMiss: boolean, kind: string}>}
 *   `advanced` is true when the action started a new story turn.
 */
async function perform(page, decision, screen) {
  const { action } = decision;

  if (action === "choose") {
    if (!screen.choices.length) return { advanced: false, note: "there were no choices to press", targetMiss: true, kind: "choose" };
    const match = matchChoice(decision.target, screen.choices.map((c) => ({ text: c.visible })));
    let chosen = match.index >= 0 ? screen.choices[match.index] : null;
    let prefix = "";
    let targetMiss = false;

    if (!match.matched) {
      // Unreadable is a finding, recorded as one; the session still has to go on, so take
      // the closest pressable button rather than always the first.
      targetMiss = true;
      const pressable = screen.choices.filter((c) => !c.disabled);
      chosen = chosen && !chosen.disabled ? chosen : pressable[0];
      if (!chosen) return { advanced: false, note: "could not read the choices, and none can be pressed", targetMiss, kind: "choose" };
      prefix = `could not clearly match "${decision.target}" (best ${match.score.toFixed(2)}); `;
    }

    if (chosen.locked || chosen.disabled) {
      // This is the information a person gets from a dimmed button, and it is exactly
      // what the player needs next: where to walk.
      const where = chosen.gate.replace(/^go to\s+/i, "") || "the thing it names";
      return {
        advanced: false,
        note: `tried "${chosen.text}" but it is locked — you have to walk up to the ${where} first`,
        targetMiss,
        kind: "locked",
      };
    }

    const button = page.locator(".choice-buttons button", { hasText: chosen.text.slice(0, 40) }).first();
    await ((await button.count()) ? button : page.locator(".choice-buttons button:not([disabled])").first()).click();
    return { advanced: true, note: `${prefix}pressed "${chosen.text}"`, targetMiss, kind: "choose" };
  }

  if (action === "interact") {
    if (!screen.focus) {
      return { advanced: false, note: "pressed E, but nothing was under the crosshair", targetMiss: false, kind: "interact" };
    }
    await releaseFocus(page);
    await page.keyboard.press("KeyE");
    const started = await page
      .waitForSelector(".turn-progress", { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    return started
      ? { advanced: true, note: `pressed E on the ${screen.focus}`, targetMiss: false, kind: "interact" }
      : { advanced: false, note: `pressed E on the ${screen.focus}, and nothing happened`, targetMiss: false, kind: "interact" };
  }

  if (MOVES[action]) {
    const turning = action.startsWith("turn_");
    const ms = turning
      ? (Math.min(Math.max(decision.degrees ?? 45, 10), 180) / TURN_DEGREES_PER_SECOND) * 1000
      : Math.min(Math.max(decision.seconds ?? 1, 0.2), 3) * 1000;
    await hold(page, MOVES[action], ms);
    const amount = turning ? `${Math.round(decision.degrees ?? 45)}°` : `${(ms / 1000).toFixed(1)}s`;
    return { advanced: false, note: `${action.replace("_", " ")} ${amount}`, targetMiss: false, kind: "move" };
  }

  await page.waitForTimeout(1000);
  return { advanced: false, note: "waited", targetMiss: false, kind: "wait" };
}

/**
 * Plays one 3D game from start to ending (or to `maxTurns`) and returns the play log, in
 * the same shape as the 2D player's so the same judge and counters read both.
 */
export async function playGame3d({
  anthropic,
  model,
  baseUrl,
  premise,
  packId = null,
  profile,
  outDir,
  maxTurns = 14,
  headed = false,
}) {
  await mkdir(outDir, { recursive: true });
  const shotsDir = path.join(outDir, "shots");
  await mkdir(shotsDir, { recursive: true });

  const { browser, renderer, hardware } = await launchBrowser({ headed });
  log(`rendering on: ${renderer}`);
  if (!hardware) log("!! no GPU — the 3D world will run far below real-time and movement will under-travel");
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${r.url().replace(/.*\/api\//, "/api/").slice(0, 120)}`);
  });

  const system = playerSystem3d({ name: profile?.name, interests: profile?.interests });
  const turns = [];
  const memory = [];
  const allShots = [];
  const judgeShots = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const counts = { moves: 0, lockedAttempts: 0, interactions: 0, emptyInteracts: 0, turnsAllLocked: 0 };
  const startedAt = Date.now();
  let crashedWith = null;

  const shoot = async (name) => {
    const file = path.join(shotsDir, `${name}.png`);
    await page.screenshot({ path: file });
    allShots.push(file);
    return file;
  };

  try {
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}engine=3d`;
    log(`opening ${url}`);
    await page.goto(url, { waitUntil: "networkidle" });
    judgeShots.push(await shoot("00-start-screen"));

    if (profile?.name) await page.fill('input[placeholder="Aiden"]', profile.name);
    if (profile?.interests?.length) await page.fill('input[placeholder="tennis, math, history"]', profile.interests.join(", "));

    if (packId) {
      const card = page.locator(`[data-pack-id="${packId}"]`);
      if (!(await card.count())) throw new Error(`no 3D pack card for "${packId}" on the start screen`);
      await card.click();
    } else {
      await page.fill("textarea", premise);
      await page.click('.start-form button[type="submit"]');
    }

    log("waiting for the world to be built…");
    await page.waitForSelector(".scene-container canvas", { timeout: CURTAIN_TIMEOUT });
    await waitUntilPlayable(page);
    log(`world ready in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

    for (let turn = 0; turn < maxTurns; turn++) {
      const turnStartedAt = Date.now();
      let screen = await readScreen(page);
      if (screen.ending) break;
      if (screen.choices.length && screen.choices.every((c) => c.disabled)) counts.turnsAllLocked++;

      // The frame the turn opens on — the new prose and the world as it now stands. The
      // 2D judge is given exactly this frame per turn, so it stays the anchor here too.
      const openingShot = await shoot(`t${String(turn).padStart(2, "0")}-open`);
      judgeShots.push(openingShot);

      let advanced = false;
      let free = 0;
      let record = null;
      let lastShot = openingShot;

      while (!advanced) {
        if (free > 0) {
          screen = await readScreen(page);
          lastShot = await shoot(`t${String(turn).padStart(2, "0")}-look${free}`);
        }

        let decision = await decide({ anthropic, model, system, shotPath: lastShot, memory, turnIndex: turn, tool: PLAY_ACTION_TOOL_3D });
        usage.input_tokens += decision.usage?.input_tokens || 0;
        usage.output_tokens += decision.usage?.output_tokens || 0;

        // Out of patience for wandering: the next action has to move the story.
        if (free >= MAX_FREE_ACTIONS_PER_TURN && decision.action !== "choose" && decision.action !== "interact") {
          const open = screen.choices.find((c) => !c.disabled);
          decision = { ...decision, action: "choose", target: open?.text || decision.target || "" };
        }

        const result = await perform(page, decision, screen);
        if (result.kind === "move") counts.moves++;
        if (result.kind === "locked") counts.lockedAttempts++;
        if (result.kind === "interact") (result.advanced ? counts.interactions++ : counts.emptyInteracts++);

        log(`turn ${turn}${free ? `.${free}` : ""}: eng=${decision.engagement ?? "?"} ${result.advanced ? "" : "(free) "}${result.note}`);
        if ((decision.confusion || "").trim()) log(`  confused: ${decision.confusion.trim().slice(0, 110)}`);

        const entry = {
          turn,
          shot: path.relative(outDir, lastShot),
          reading: decision.reading,
          want: decision.want,
          engagement: decision.engagement,
          choices_distinct: decision.choices_distinct,
          confusion: decision.confusion || "",
          action: decision.action,
          actionInferred: Boolean(decision.actionInferred),
          target: decision.target || null,
          note: result.note,
          targetMiss: result.targetMiss,
          // Screen state, for the counters only.
          place: screen.place,
          objective: screen.objective,
          progress: screen.progress,
          stats: screen.stats,
          choicesOffered: screen.choices.map((c) => c.text),
          lockedChoices: screen.choices.filter((c) => c.locked).length,
          focus: screen.focus,
        };
        if (result.advanced || !record) record = { ...entry, freeActions: free };
        else record.note = `${record.note}; ${result.note}`;

        memory.push({ reading: decision.reading, want: decision.want, did: result.note });
        while (memory.length > MEMORY_TURNS) memory.shift();

        advanced = result.advanced;
        if (!advanced) {
          free++;
          // A player who cannot press anything and has nothing left to try is stuck, and
          // that is a result, not a reason to spin forever.
          if (free > MAX_FREE_ACTIONS_PER_TURN + 2) break;
        }
      }

      // If the player had to walk before it could act, the judge also sees where it got
      // to — in first person, the walk is part of what the turn was like.
      if (lastShot !== openingShot) judgeShots.push(lastShot);

      if (!advanced) {
        problems.push(`turn ${turn}: the player could not advance the story; stopping`);
        record.note = `${record.note}; never advanced`;
        turns.push({ ...record, latencyMs: Date.now() - turnStartedAt });
        break;
      }

      await waitUntilPlayable(page).catch((err) => problems.push(`turn ${turn}: never became playable — ${err.message}`));
      const settled = await readScreen(page);
      turns.push({
        ...record,
        latencyMs: Date.now() - turnStartedAt,
        ending: settled.ending,
        endingOutcome: settled.endingOutcome,
        placeAfter: settled.place,
      });

      if (settled.ending) {
        log(`the story ended after ${turn + 1} turns: ${settled.endingOutcome || "?"}`);
        judgeShots.push(await shoot("99-ending"));
        break;
      }
    }

    if (!(await readScreen(page)).ending) {
      judgeShots.push(await shoot("99-final"));
      log(`stopped at the ${maxTurns}-turn cap without reaching an ending`);
    }
  } catch (err) {
    crashedWith = err;
    problems.push(`the run stopped early: ${err.message || err}`);
    log(`!! stopped early: ${err.message || err}`);
  } finally {
    await browser.close();
  }

  const playLog = {
    playedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    premise: packId ? null : premise,
    packId,
    profile,
    model,
    maxTurns,
    engine: "3d",
    renderer,
    crashed: crashedWith ? String(crashedWith.message || crashedWith) : null,
    turns,
    counts3d: counts,
    placesVisited: [...new Set(turns.flatMap((t) => [t.place, t.placeAfter]).filter(Boolean))],
    problems: [...new Set(problems)],
    usage,
    shots: { all: allShots.map((f) => path.relative(outDir, f)), judge: judgeShots.map((f) => path.relative(outDir, f)) },
    judgeShotPaths: judgeShots,
  };

  await writeFile(path.join(outDir, "play-log.json"), JSON.stringify(playLog, null, 2));
  if (crashedWith && !turns.length) throw crashedWith;
  return playLog;
}
