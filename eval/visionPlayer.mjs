// A player that plays the game by looking at it.
//
// Every other harness in this project reads the turn JSON, which is exactly the wrong
// instrument for the question "would someone enjoy this". The JSON cannot show that two
// cut-outs are rendered in different styles, that the pressure stat reads `0.70` and
// means nothing to a human, that the choice text is clipped, or that the scene is
// handsome but boring. So this drives a real browser, screenshots it, and hands the
// screenshot to a model that decides what to do next from the pixels — the same
// information a person sitting at the machine has, and nothing else.
//
// The player is given no access to the scene data, the session state or the log. State
// IS read from the DOM here, but only to compute objective counters afterwards and to
// know when a turn has finished rendering; none of it reaches the player's prompt.
//
// Output is a play log: an ordered record of what the player saw, what it understood,
// what it wanted, how engaged it was, and what it did. eval/enjoymentJudge.mjs scores
// the screenshots; eval/rubric.mjs computes the counters. Those two stay independent on
// purpose.
import { launchBrowser } from "./browser.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PLAY_ACTION_TOOL, playerSystem, matchChoice } from "./rubric.mjs";

// Generating a first scene's art is minutes of work, not seconds. These are the timeouts
// playthrough.mjs arrived at over a lot of failed runs.
const CURTAIN_TIMEOUT = 8 * 60 * 1000;
const TURN_TIMEOUT = 5 * 60 * 1000;

// A player may examine things, wander and look around before committing to a choice, but
// it cannot do so forever: a model that finds clicking around more comfortable than
// deciding will happily spend a whole session not advancing the story.
const MAX_FREE_ACTIONS_PER_TURN = 3;

// How many of its own previous turns the player remembers. A person remembers the story
// so far; giving the player nothing makes it judge every turn as if it were the first,
// which destroys any chance of noticing that the world contradicted itself. Text only —
// re-sending every past screenshot would dominate the token cost for little gain.
const MEMORY_TURNS = 5;

const log = (...m) => console.log("[player]", ...m);

/**
 * Everything on screen that the harness needs and the player is not told. Read from the
 * DOM rather than the API so it reflects what was actually rendered — a stat present in
 * the turn JSON but pushed off a full status panel is not on screen, and for the purpose
 * of "did the player see pressure" it does not exist.
 */
async function readScreen(page) {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const stats = {};
    for (const node of document.querySelectorAll(".status-stat")) {
      const k = node.querySelector("dt")?.textContent?.trim();
      const v = node.querySelector("dd")?.textContent?.trim();
      if (k) stats[k] = v ?? "";
    }
    // Fall back to splitting the stat block's own text when the markup is not a dl pair,
    // so a markup change degrades the metric instead of silently zeroing it.
    if (!Object.keys(stats).length) {
      for (const node of document.querySelectorAll(".status-stat")) {
        const parts = node.textContent.trim().split(/\s{2,}|\n/).filter(Boolean);
        if (parts.length >= 2) stats[parts[0]] = parts.slice(1).join(" ");
      }
    }

    const width = document.querySelector(".status-progress-fill")?.style.width || "";
    const progress = /^([\d.]+)%$/.test(width) ? parseFloat(width) / 100 : null;

    return {
      title: text(".status-title"),
      objective: text(".status-objective"),
      progress,
      stats,
      narrativeChars: (text(".narrative-body") || "").length,
      choices: [...document.querySelectorAll(".choice:not(.ghost)")].map((c) => {
        const text = c.querySelector(".choice-text")?.textContent?.trim() || c.textContent.trim();
        // A gated choice also wears a "GO TO <somewhere>" pill, and that pill is often
        // the most legible thing on the button — a player reading the screen quotes it
        // as readily as the sentence above it. Matching against the sentence alone
        // reported those perfectly good reads as unreadable and pressed the wrong
        // button, which quietly played a different game than the one being reported on.
        const gate = c.querySelector(".choice-gate")?.textContent?.trim() || "";
        return {
          text,
          gate,
          visible: gate ? `${text} ${gate}` : text,
          locked: c.classList.contains("locked"),
          disabled: c.disabled === true,
        };
      }),
      examineOpen: Boolean(document.querySelector(".examine")),
      examineName: text(".examine-name"),
      examineDetail: text(".examine-detail"),
      ending: Boolean(document.querySelector(".ending")),
      endingOutcome: text(".ending-outcome"),
      curtain: Boolean(document.querySelector(".curtain")),
      actorsOnStage: document.querySelectorAll(".stage-actor").length,
      placeholders: document.querySelectorAll(".stage-actor.placeholder").length,
      backdropLoaded: Boolean(
        document.querySelector(".stage-backdrop")?.style.backgroundImage?.includes("url(")
      ),
    };
  });
}

/** Waits until the game is accepting input again, or has ended. */
async function waitUntilPlayable(page) {
  // A relocating turn repaints the whole place behind a full-screen curtain, during which
  // the narrative panel does not exist at all. Waiting on that panel sat through a full
  // five-minute timeout on a turn where every generation call had in fact succeeded.
  if (await page.$(".curtain")) {
    log("  relocating — waiting for the new place to be painted");
    await page.waitForSelector(".curtain", { state: "detached", timeout: CURTAIN_TIMEOUT });
  }
  await page.waitForFunction(
    () => {
      if (document.querySelector(".ending")) return true;
      const bar = document.querySelector(".choices");
      if (!bar || bar.classList.contains("busy")) return false;
      return [...bar.querySelectorAll(".choice:not(.ghost)")].some((c) => !c.disabled);
    },
    undefined,
    { timeout: TURN_TIMEOUT }
  );
  // Let the backdrop cross-fade and the opening beats settle before the screenshot: a
  // frame caught mid-fade would be judged on a transition no player sits through.
  await page.waitForTimeout(2200);
}

/**
 * Asks the player what to do, given the screen in front of it.
 *
 * @returns {Promise<object>} the validated tool input
 */
export async function decide({ anthropic, model, system, shotPath, memory, turnIndex, tool = PLAY_ACTION_TOOL }) {
  const b64 = (await readFile(shotPath)).toString("base64");

  const remembered = memory.length
    ? "What you remember of the story so far:\n" +
      memory.map((m, i) => `  ${i + 1}. You thought: ${m.reading}\n     You wanted: ${m.want}\n     You did: ${m.did}`).join("\n")
    : "You have just started playing.";

  const ask = async (nudge) => {
    const response = await anthropic.messages.create({
      model,
      // Generous: `reading` is a paragraph and a cramped budget truncates the tool call
      // into an unparseable fragment, which surfaces as a missing action rather than as
      // the length problem it is.
      max_tokens: 2000,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
            {
              type: "text",
              text:
                `${remembered}\n\nThis is your screen right now` +
                (turnIndex === 0 ? " (you have just begun)" : "") +
                ". Look at it and call take_action with what you see and what you do next." +
                (nudge ? `\n\n${nudge}` : ""),
            },
          ],
        },
      ],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    });
    const use = response.content.find((b) => b.type === "tool_use" && b.name === tool.name);
    return { use, response };
  };

  let { use, response } = await ask();
  if (!use?.input?.action) {
    // Observed twice: the tool is called and most fields are filled in, but `action` is
    // missing despite being required. One retry naming the omission costs a few cents.
    ({ use, response } = await ask(
      "Your last call left out the required action field. Call take_action again and " +
        "include it — and the target too, if the action is 'choose'."
    ));
  }

  let inferred = null;
  if (!use?.input?.action) {
    // Still missing. Throwing here loses the entire playthrough over one malformed call,
    // which is a worse outcome than continuing with a reasonable reading of what the
    // player clearly meant: a `target` naming a button is a 'choose', and anything else
    // is a look around. The substitution is recorded on the turn so it can never be
    // mistaken for the player's own decision.
    inferred = use?.input?.target ? "choose" : "wait";
    const got = use?.input ? Object.keys(use.input).join(", ") : "no tool call at all";
    console.warn(`[player] no action returned (fields: ${got}) — treating it as '${inferred}'`);
  }

  return {
    ...use.input,
    action: use?.input?.action || inferred,
    actionInferred: Boolean(inferred),
    // Models write "none" rather than leaving the field empty, and counting that as a
    // confused turn would inflate the one metric that is supposed to catch real
    // incoherence.
    confusion: /^(none|n\/?a|nothing|no|-|—)\.?$/i.test((use.input.confusion || "").trim())
      ? ""
      : use.input.confusion || "",
    usage: response.usage,
  };
}

/**
 * Carries out one action in the browser.
 *
 * @returns {Promise<{advanced: boolean, note: string, targetMiss: boolean}>} `advanced`
 *   is true when the action consumed a story turn, which is the only thing that moves the
 *   narrative on.
 */
async function perform(page, decision, screen) {
  const { action } = decision;

  if (action === "choose") {
    const live = screen.choices.filter((c) => !c.disabled);
    if (!live.length) return { advanced: false, note: "no choice available to press", targetMiss: true };

    // Match against everything written on the button, sentence and gate pill alike.
    const match = matchChoice(decision.target, live.map((c) => ({ text: c.visible })));
    let chosen = live[match.index];
    let targetMiss = false;
    let prefix = "";

    if (!match.matched) {
      // The player could not name any button on screen clearly enough. That is a
      // legibility finding and it is recorded as one — but the session still has to
      // continue, so press the closest thing rather than always falling back to the
      // first option, which would systematically bias every unreadable turn toward the
      // top of the list and make the resulting playthrough worse than the game is.
      targetMiss = true;
      chosen = match.index >= 0 ? live[match.index] : live[0];
      prefix = `could not clearly match "${decision.target}" (best ${match.score.toFixed(2)}); `;
    }
    // The button index in `live` is not the DOM index once disabled buttons are filtered,
    // so locate by text rather than position.
    const locator = page.locator(".choice:not(.ghost):not([disabled])", { hasText: chosen.text.slice(0, 40) }).first();
    const target = (await locator.count()) ? locator : page.locator(".choice:not(.ghost):not([disabled])").first();
    await target.click();

    if (chosen.locked) {
      // A gated choice walks the character there and unlocks on arrival; the turn is only
      // taken on the second press. This is a normal turn, not a dead end.
      await page
        .waitForSelector(".choice:not(.locked):not(.ghost):not([disabled])", { timeout: 25000 })
        .catch(() => {});
      const after = page.locator(".choice:not(.locked):not(.ghost):not([disabled])", { hasText: chosen.text.slice(0, 40) }).first();
      if (await after.count()) await after.click();
      else await page.locator(".choice:not(.locked):not(.ghost):not([disabled])").first().click();
      return { advanced: true, note: `${prefix}walked to the gated choice, then took it: "${chosen.text}"`, targetMiss };
    }
    return { advanced: true, note: `${prefix}pressed "${chosen.text}"`, targetMiss };
  }

  if (action === "click_stage") {
    const box = await page.locator(".stage-root, .stage-container").first().boundingBox();
    const vp = page.viewportSize();
    const x = (decision.stage_x ?? 0.5) * (box?.width ?? vp.width) + (box?.x ?? 0);
    const y = (decision.stage_y ?? 0.65) * (box?.height ?? vp.height) + (box?.y ?? 0);
    await page.mouse.click(x, y);
    await page.waitForTimeout(2600); // the walk, plus the examine card if one opens
    return { advanced: false, note: `clicked the stage at ${Math.round(x)},${Math.round(y)}`, targetMiss: false };
  }

  if (action === "walk_left" || action === "walk_right") {
    const key = action === "walk_left" ? "ArrowLeft" : "ArrowRight";
    await page.keyboard.down(key);
    await page.waitForTimeout(1100);
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
    return { advanced: false, note: `walked ${action === "walk_left" ? "left" : "right"}`, targetMiss: false };
  }

  if (action === "dismiss") {
    const ghost = await page.$(".examine-actions button.ghost");
    if (ghost) await ghost.click();
    await page.waitForTimeout(400);
    return { advanced: false, note: "closed the examine card", targetMiss: false };
  }

  await page.waitForTimeout(1000);
  return { advanced: false, note: "waited", targetMiss: false };
}

/**
 * Plays one game from start to ending (or to `maxTurns`) and returns the play log.
 *
 * @param {object} args
 * @param {object} args.anthropic - an Anthropic client
 * @param {string} args.model - the player's model
 * @param {string} args.baseUrl - where the web app is served
 * @param {string} args.premise - the source text to start a game from
 * @param {string} [args.packId] - start a pre-generated game instead of a premise
 * @param {object} args.profile - { name, interests: string[] }
 * @param {string} args.outDir - where screenshots and the log are written
 * @param {number} [args.maxTurns]
 * @param {boolean} [args.headed]
 */
export async function playGame({
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

  // The real GPU when there is one; see eval/browser.mjs for why that matters and why
  // the renderer is recorded.
  const { browser, renderer } = await launchBrowser({ headed });
  log(`rendering on: ${renderer}`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/")) problems.push(`request failed: ${r.url()}`);
  });

  const system = playerSystem({ name: profile?.name, interests: profile?.interests });
  const turns = [];
  const memory = [];
  // Every screenshot taken, for a human to flick through; the judge is given the
  // decision frames only, which is one per story turn plus the ending.
  const allShots = [];
  const judgeShots = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let startedAt = Date.now();
  let crashedWith = null;

  const shoot = async (name) => {
    const file = path.join(shotsDir, `${name}.png`);
    await page.screenshot({ path: file });
    allShots.push(file);
    return file;
  };

  try {
    log(`opening ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    judgeShots.push(await shoot("00-start-screen"));

    if (profile?.name) await page.fill('input[placeholder="Aiden"]', profile.name);
    if (profile?.interests?.length) {
      await page.fill('input[placeholder="deep sea, folk horror, machines"]', profile.interests.join(", "));
    }

    if (packId) {
      const card = page.locator(`[data-pack-id="${packId}"]`);
      if (!(await card.count())) throw new Error(`no pack card for "${packId}" on the start screen`);
      await card.click();
    } else {
      await page.fill("textarea", premise);
      await page.click(".start2d-go");
    }

    log("waiting for the world to be painted (60-90s on a cold cache)…");
    await page.waitForSelector(".game2d", { timeout: CURTAIN_TIMEOUT });
    await waitUntilPlayable(page);
    log(`world ready in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

    for (let turn = 0; turn < maxTurns; turn++) {
      let advanced = false;
      let freeActions = 0;
      const turnStartedAt = Date.now();

      // The screen the player decides this turn from, and the frame the judge is shown.
      let screenBefore = await readScreen(page);
      if (screenBefore.ending) break;

      // A turn can be settled enough to read but still have every button disabled for a
      // moment while the choice bar swaps one set for the next. Screenshotting into that
      // gap gave the player a screen with nothing pressable on it, and it spent its whole
      // free-action budget trying to act on it.
      if (!screenBefore.choices.some((c) => !c.disabled)) {
        await waitUntilPlayable(page).catch(() => {});
        screenBefore = await readScreen(page);
        if (screenBefore.ending) break;
      }

      const decisionShot = await shoot(`t${String(turn).padStart(2, "0")}-decide`);
      judgeShots.push(decisionShot);

      if (!screenBefore.backdropLoaded) problems.push(`turn ${turn}: no backdrop artwork — stage fell back to the gradient`);
      if (screenBefore.placeholders) problems.push(`turn ${turn}: ${screenBefore.placeholders} actor(s) with no artwork`);

      let record = null;

      while (!advanced && freeActions <= MAX_FREE_ACTIONS_PER_TURN) {
        const screen = freeActions === 0 ? screenBefore : await readScreen(page);
        const shot =
          freeActions === 0 ? decisionShot : await shoot(`t${String(turn).padStart(2, "0")}-look${freeActions}`);

        let decision;
        try {
          decision = await decide({ anthropic, model, system, shotPath: shot, memory, turnIndex: turn });
        } catch (err) {
          problems.push(`turn ${turn}: the player could not decide — ${err.message}`);
          throw err;
        }
        usage.input_tokens += decision.usage?.input_tokens || 0;
        usage.output_tokens += decision.usage?.output_tokens || 0;

        // Out of patience for looking around: the next action has to be a choice.
        if (!advanced && freeActions === MAX_FREE_ACTIONS_PER_TURN && decision.action !== "choose") {
          decision.action = "choose";
          decision.target = decision.target || screen.choices.find((c) => !c.disabled)?.text || "";
        }

        const result = await perform(page, decision, screen);
        log(
          `turn ${turn}${freeActions ? `.${freeActions}` : ""}: eng=${decision.engagement} ` +
            `${result.advanced ? "" : "(free) "}${result.note}`
        );
        if (decision.confusion?.trim()) log(`  confused: ${decision.confusion.trim().slice(0, 110)}`);

        const entry = {
          turn,
          shot: path.relative(outDir, shot),
          reading: decision.reading,
          want: decision.want,
          engagement: decision.engagement,
          choices_distinct: decision.choices_distinct,
          confusion: decision.confusion || "",
          action: decision.action,
          target: decision.target || null,
          note: result.note,
          targetMiss: result.targetMiss,
          // Screen state, for the objective counters only — never shown to the player or
          // the judge.
          title: screen.title,
          objective: screen.objective,
          progress: screen.progress,
          stats: screen.stats,
          choicesOffered: screen.choices.map((c) => c.text),
          lockedChoices: screen.choices.filter((c) => c.locked).length,
          actorsOnStage: screen.actorsOnStage,
          examined: screen.examineOpen ? { name: screen.examineName, detail: screen.examineDetail } : null,
        };

        // One record per story turn: the decision that advanced it. Free looking around is
        // folded into that record's note rather than inflating the turn count.
        if (result.advanced || !record) record = entry;
        else record.note = `${record.note}; ${result.note}`;

        memory.push({
          reading: decision.reading,
          want: decision.want,
          did: result.note,
        });
        while (memory.length > MEMORY_TURNS) memory.shift();

        advanced = result.advanced;
        if (!advanced) freeActions++;
      }

      if (record) {
        const after = await readScreen(page);
        if (!advanced) {
          record.note = `${record.note}; the turn did not advance`;
        } else {
          await waitUntilPlayable(page).catch((err) => {
            problems.push(`turn ${turn}: the next turn never became playable — ${err.message}`);
          });
        }
        const settled = await readScreen(page);
        record.latencyMs = Date.now() - turnStartedAt;
        record.ending = settled.ending;
        record.endingOutcome = settled.endingOutcome;
        turns.push(record);

        if (settled.ending) {
          log(`the story ended after ${turn + 1} turns: ${settled.endingOutcome || "?"}`);
          judgeShots.push(await shoot("99-ending"));
          break;
        }
        if (!advanced) {
          problems.push(`turn ${turn}: the player never took a choice; stopping`);
          break;
        }
        void after;
      }
    }

    const last = await readScreen(page);
    if (!last.ending) {
      judgeShots.push(await shoot("99-final"));
      log(`stopped at the ${maxTurns}-turn cap without reaching an ending`);
    }
  } catch (err) {
    // A run that falls over on turn 9 still contains nine turns worth of evidence, and
    // throwing here used to discard all of it along with the screenshots already paid
    // for. Record the fault as a finding and let the log be written below.
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
    engine: "2d",
    renderer,
    crashed: crashedWith ? String(crashedWith.message || crashedWith) : null,
    turns,
    problems: [...new Set(problems)],
    usage,
    shots: { all: allShots.map((f) => path.relative(outDir, f)), judge: judgeShots.map((f) => path.relative(outDir, f)) },
    judgeShotPaths: judgeShots,
  };

  await writeFile(path.join(outDir, "play-log.json"), JSON.stringify(playLog, null, 2));
  // Only a run that produced nothing at all is a hard failure; anything else is a short
  // playthrough with a recorded reason, which the judge can still score.
  if (crashedWith && !turns.length) throw crashedWith;
  return playLog;
}
