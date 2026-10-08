// The contracts for the play-and-judge harness: what a vision player may do, what the
// judge must report, and the pure helpers both need. Kept dependency-free and separate
// from the scripts that drive them so the scoring rubric is reviewable on its own and the
// fuzzy matching is testable without a browser or an API key.
//
// Two agents, deliberately not one:
//
//   the PLAYER plays for fun, sees only screenshots, and reports how each turn landed
//   the JUDGE never sees the player's ratings, only the screenshots, and scores the game
//
// Collapsing them into a single agent that both plays and grades produces a transcript
// written to be graded well, and the grade then measures the agent's self-narration
// rather than the game. Keeping them apart also gives two independent estimates of the
// same thing — a live per-turn engagement signal and a retrospective verdict — and a
// disagreement between them is information rather than noise.

// ---------------------------------------------------------------------------
// What the player is allowed to do
// ---------------------------------------------------------------------------

// The action space is the real game's affordances and nothing more: the player reads the
// screen and either presses one of the choice buttons, clicks somewhere on the painting
// (which walks, and examines whatever is there), walks with the keyboard, or closes the
// examine card. There is deliberately no action that consults the scene JSON — a player
// cannot do that, so neither can this.
export const PLAY_ACTION_TOOL = {
  name: "take_action",
  description: "Report what you see on screen and what you do next.",
  input_schema: {
    type: "object",
    properties: {
      // Ordered first on purpose. The model writes these fields in sequence, so
      // describing the screen before choosing an action forces the choice to be grounded
      // in the image rather than in a guess about what an adventure game probably shows.
      // Asking for the action first produces confident clicks on buttons that aren't
      // there.
      reading: {
        type: "string",
        description:
          "What is actually on this screen, in your own words: where you seem to be, " +
          "what is happening, what the game is telling you. Describe only what you can " +
          "see. If something is unreadable or you cannot tell what you are looking at, " +
          "say so plainly — that is useful information, not a failure on your part.",
      },
      want: {
        type: "string",
        description:
          "What you are trying to achieve right now, as a player. One sentence. If you " +
          "have no idea what you are supposed to be doing, say that instead.",
      },
      engagement: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description:
          "How much you are enjoying this, at this moment. 1 = bored, I want to stop. " +
          "2 = going through the motions. 3 = mildly interested. 4 = genuinely caught " +
          "up in it. 5 = I would be annoyed if someone interrupted me. Be honest and " +
          "use the low end when it applies; most turns of most games are a 3.",
      },
      choices_distinct: {
        type: "boolean",
        description:
          "Do the options in front of you feel like meaningfully different things to " +
          "do, or are they reskins of the same move? False if they differ only in " +
          "wording.",
      },
      confusion: {
        type: "string",
        description:
          "Anything that does not make sense: a contradiction with an earlier turn, a " +
          "thing referred to that you cannot see, text you cannot read, a stat whose " +
          "meaning is opaque. Empty string if nothing is wrong.",
      },
      action: {
        type: "string",
        enum: ["choose", "click_stage", "walk_left", "walk_right", "dismiss", "wait"],
        description:
          "'choose' presses one of the choice buttons (give its text in `target`). " +
          "'click_stage' clicks a point on the painting, which walks you there and " +
          "examines whatever is at that spot (give `stage_x`/`stage_y`). " +
          "'walk_left'/'walk_right' hold the arrow key for a moment. 'dismiss' closes " +
          "an open examine card. 'wait' does nothing for a second.",
      },
      target: {
        type: "string",
        description:
          "For 'choose': the text of the button you are pressing, copied as closely as " +
          "you can read it. Ignored for other actions.",
      },
      stage_x: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "For 'click_stage': where to click across the screen, 0 = left edge, " +
          "1 = right edge.",
      },
      stage_y: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "For 'click_stage': where to click down the screen, 0 = top, 1 = bottom. " +
          "The ground is usually in the lower half.",
      },
    },
    required: ["reading", "want", "engagement", "choices_distinct", "confusion", "action"],
  },
};

/**
 * The player's persona. Not an evaluator: someone who sat down to play a game. The
 * difference matters — an agent told it is testing software reports defects, and an agent
 * told it is playing reports boredom, which is the thing we actually want to measure.
 */
export function playerSystem({ name = "Aiden", interests = [], patience = "normal" } = {}) {
  const taste = interests.length ? ` You are drawn to ${interests.join(", ")}.` : "";
  return `You are ${name}, a person playing an illustrated adventure game on a computer.${taste}

You are playing for your own enjoyment. Nobody is watching you and you owe the game
nothing. You will be shown a screenshot of the game and you decide what to do next, the
way you would with a mouse and keyboard.

How to play: choice buttons are in the lower right — pressing one takes the story
forward. A dimmed or locked choice means your character is standing in the wrong place;
pressing it walks you there. You can click anywhere on the painting to walk, and clicking
a person or object walks you over and tells you something about it, which costs nothing
and is often the most interesting writing in the game. Arrow keys also walk.

Two things about reporting your action, because getting them wrong makes the game do
something you did not intend:

  'choose' presses one of the buttons in the lower right, and nothing else. The target
  you give must be words actually printed on that button — copy them from the screen.
  Some buttons carry a small green "GO TO ..." tag as well as a sentence; either is fine
  to quote. Do not invent a button: if the thing you want to do is not written on one of
  them, you cannot choose it.

  To look at something, walk somewhere, or approach a person, use 'click_stage' with a
  point on the painting. That is how you examine things. "Take a closer look" is a
  click_stage, not a choose.

Play like a person, not a completionist: follow what you are actually curious about,
ignore what bores you, and push toward whatever you think the game wants from you.

Be honest in your reports. If a turn is dull, say it is dull. If two choices look like
the same choice twice, say so. If you cannot read the text or cannot work out what is
being asked of you, say that — do not fill the gap with a plausible guess about what an
adventure game would normally say. Your ${patience} patience is the measure here: an
answer of "I would have stopped playing by now" is a legitimate and useful thing to
report.`;
}

// ---------------------------------------------------------------------------
// The 3D player
// ---------------------------------------------------------------------------

// First person changes what "playing" means. On the 2D stage a locked choice walks you
// there when pressed and examining something is free; here a locked choice stays locked
// until you have physically walked within reach of the thing it names, and pressing E on
// an object is itself a turn. So the action space is movement — the same keys a person
// uses — plus the two things that advance the story.
export const PLAY_ACTION_TOOL_3D = {
  name: "take_action",
  description: "Report what you see on screen and what you do next.",
  input_schema: {
    type: "object",
    // Field order matters for the same reason it does in 2D: describing the view before
    // choosing an action grounds the action in the image.
    properties: {
      reading: PLAY_ACTION_TOOL.input_schema.properties.reading,
      want: PLAY_ACTION_TOOL.input_schema.properties.want,
      engagement: PLAY_ACTION_TOOL.input_schema.properties.engagement,
      choices_distinct: PLAY_ACTION_TOOL.input_schema.properties.choices_distinct,
      confusion: PLAY_ACTION_TOOL.input_schema.properties.confusion,
      action: {
        type: "string",
        enum: [
          "choose",
          "interact",
          "move_forward",
          "move_back",
          "strafe_left",
          "strafe_right",
          "turn_left",
          "turn_right",
          "wait",
        ],
        description:
          "'choose' presses one of the choice buttons (give its text in `target`); a " +
          "dimmed, locked button cannot be pressed until you are standing near what it " +
          "names. 'interact' presses E on whatever the label under the crosshair names — " +
          "this takes a turn, like a choice. The movement actions hold that key: " +
          "move/strafe for `seconds`, turn for `degrees`. 'wait' does nothing.",
      },
      target: {
        type: "string",
        description: "For 'choose': the words printed on the button. Ignored otherwise.",
      },
      seconds: {
        type: "number",
        minimum: 0.2,
        maximum: 3,
        description: "For move_* and strafe_*: how long to hold the key. About 1 second covers a few paces.",
      },
      degrees: {
        type: "number",
        minimum: 10,
        maximum: 180,
        description: "For turn_*: how far to turn. 90 is a right angle, 180 turns you around.",
      },
    },
    required: ["reading", "want", "engagement", "choices_distinct", "confusion", "action"],
  },
};

/** The 3D player's persona: the same person, holding a keyboard instead of a mouse. */
export function playerSystem3d({ name = "Aiden", interests = [], patience = "normal" } = {}) {
  const taste = interests.length ? ` You are drawn to ${interests.join(", ")}.` : "";
  return `You are ${name}, a person playing a first-person 3D adventure game on a computer.${taste}

You are playing for your own enjoyment. Nobody is watching you and you owe the game
nothing. You will be shown a screenshot of the game and you decide what to do next, the
way you would with the keyboard.

How to play: you see the world through your character's eyes. W/S or the up and down
arrows walk forward and back, A/D step sideways, and the left and right arrows turn you
around. The small cross in the middle of the screen is where you are looking; when it is
on an object, its name appears beneath it and pressing E acts on it — that takes a turn,
like making a choice. The story is in the panel at the bottom and the choice buttons are
there too. A dimmed choice that says "go to …" can only be taken once you are standing
near that thing, so you have to walk over to it first.

Play like a person, not a completionist: follow what you are actually curious about,
ignore what bores you, and push toward whatever you think the game wants from you.

Two things about reporting your action, because getting them wrong makes the game do
something you did not intend:

  'choose' presses one of the choice buttons, and nothing else. The target must be words
  actually printed on that button. You cannot press a dimmed one.

  To get somewhere, turn to face it and walk. If you cannot see what you are looking
  for, turn around — it may be behind you.

Be honest in your reports. If a turn is dull, say it is dull. If you cannot tell what an
object is, or cannot find where you are meant to go, say that plainly — do not fill the
gap with a guess about what a game like this would normally contain. Your ${patience}
patience is the measure here: "I would have stopped playing by now" is a legitimate and
useful thing to report.`;
}

// ---------------------------------------------------------------------------
// What the judge must report
// ---------------------------------------------------------------------------

// Nine dimensions in three groups. The visual group is the reason this harness drives a
// browser and feeds images rather than reading the turn JSON: whether twelve
// independently generated pictures look like one game is invisible in the data structure
// that produced them and obvious on screen.
export const DIMENSIONS = [
  {
    key: "visual_coherence",
    group: "visual",
    question: "Do the pictures look like they belong to the same game?",
    anchors: {
      1: "Clearly unrelated images jammed together — different media, different palettes, a photoreal object next to a cartoon one.",
      3: "Broadly consistent, with obvious offenders: a figure whose rendering or colour does not match the backdrop it stands on.",
      5: "Reads as one authored art direction throughout. You would believe a single illustrator made all of it.",
    },
  },
  {
    key: "visual_craft",
    group: "visual",
    question: "Is it actually nice to look at?",
    anchors: {
      1: "Broken: white halos or rectangular blocks around cut-out figures, figures floating off the ground or sunk into it, blank placeholder shapes.",
      3: "Competent and clean but flat — correct compositing, unremarkable composition, nothing you would screenshot.",
      5: "Genuinely attractive. Considered composition, convincing light, figures that sit in the scene.",
    },
  },
  {
    key: "legibility",
    group: "visual",
    question: "Can you tell what is going on and what you can do?",
    anchors: {
      1: "You cannot find the text, read it, or work out what the controls are.",
      3: "Readable with effort — some text cramped, or the tracked numbers are opaque, or it is unclear which things are interactive.",
      5: "Immediately clear: where you are, what you are trying to do, what your options are, and what the numbers on screen mean.",
    },
  },
  {
    key: "agency",
    group: "experience",
    question: "Did the player's choices visibly change anything?",
    anchors: {
      1: "The story goes the same way whatever is pressed. Choices are flavour text on a rail.",
      3: "Choices are acknowledged in the next turn's prose but do not visibly redirect the story.",
      5: "Decisions open and close real paths, and a consequence of an earlier choice resurfaces later.",
    },
  },
  {
    key: "stakes",
    group: "experience",
    question: "Does anything press against the player?",
    anchors: {
      1: "Nothing is at risk and nothing is running out. Exhausting every option is strictly the best play.",
      3: "Stakes are asserted in the writing but nothing tracked on screen actually moves against the player.",
      5: "Something is visibly and steadily getting worse or running down, and it forces choices to be traded off.",
    },
  },
  {
    key: "pacing",
    group: "experience",
    question: "Does it keep moving?",
    anchors: {
      1: "Stalls. Turns pass with nothing happening, or it ends abruptly before anything is established.",
      3: "Uneven — a strong opening that sags, or good scenes separated by filler.",
      5: "Each turn advances something. It arrives at an ending that feels earned rather than hit at a turn limit.",
    },
  },
  {
    key: "curiosity",
    group: "experience",
    question: "Would you want to find out what happens next?",
    anchors: {
      1: "No. By the third turn there was no open question worth answering.",
      3: "Mild interest, driven more by politeness than pull.",
      5: "A real question you want the answer to, kept alive and paid off.",
    },
  },
  {
    key: "prose",
    group: "writing",
    question: "Is the writing any good?",
    anchors: {
      1: "Generic AI-adventure register: portentous, abstract, padded, interchangeable with any other premise.",
      3: "Clean and clear but unsurprising. Competent genre prose.",
      5: "Specific, economical, with concrete sensory detail and a voice. Lines worth rereading.",
    },
  },
  {
    key: "world_coherence",
    group: "writing",
    question: "Does the world hold together across turns?",
    anchors: {
      1: "Contradicts itself: things move or vanish without cause, characters forget what they just said, the place changes identity.",
      3: "Mostly consistent, with a couple of continuity slips.",
      5: "Fully consistent. Objects, people and geography persist and are referred to accurately turns later.",
    },
  },
];

export const VERDICT_TOOL = {
  name: "emit_enjoyment_verdict",
  description:
    "Score a playthrough of an illustrated adventure game on how much a player would " +
    "enjoy it, from the screenshots of that playthrough.",
  input_schema: {
    type: "object",
    properties: {
      // Evidence before scores, for the same autoregressive reason the player describes
      // the screen before acting: a score written first becomes the thing the evidence is
      // then selected to justify.
      what_i_saw: {
        type: "string",
        description:
          "A short account of the playthrough as the screenshots show it: where it " +
          "began, what the player did, how it ended. Two or three sentences. Ground " +
          "this in the images — if the screenshots do not show something, do not assume " +
          "it happened.",
      },
      // Two flat scalar fields per dimension, and no nested objects anywhere in this
      // schema.
      //
      // This took two tries to get right. Originally the nine dimensions lived inside a
      // `scores` object; the judge hoisted eight of them to the top level, emitted
      // `scores` as a bare string, and dropped the ninth. Moving them to the top level
      // as `{evidence, score}` objects did not help, because the nesting was still
      // there — one level down — and the next attempt came back with the tool-call
      // markup leaking into the value as a literal string:
      //
      //   "visual_coherence": "\n<parameter name=\"evidence\">Every screenshot (2-16)…"
      //
      // So the object is the problem, not where it sits. Scalars only. `_evidence`
      // is declared immediately before its score so the evidence is still written
      // first, which is the point of having it.
      ...Object.fromEntries(
        DIMENSIONS.flatMap((d) => [
          [
            `${d.key}_evidence`,
            {
              type: "string",
              description:
                `Evidence for ${d.key}: the specific thing in the screenshots that ` +
                "decides this score — name the screenshot number and what is in it. " +
                "Quote on-screen text where it is the point. Write this before the score.",
            },
          ],
          [
            d.key,
            {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description:
                `${d.question} 1 = ${d.anchors[1]} 3 = ${d.anchors[3]} 5 = ${d.anchors[5]}`,
            },
          ],
        ])
      ),
      best_moment: {
        type: "string",
        description: "The single best thing in this playthrough, and which screenshot it is in.",
      },
      biggest_problem: {
        type: "string",
        description:
          "The one change that would most improve this game. Required: every " +
          "playthrough has a weakest link, and naming it is the useful half of this " +
          "report. Be concrete and specific to what you saw.",
      },
      minutes_before_quitting: {
        type: "integer",
        minimum: 0,
        description:
          "How many minutes you estimate a typical player would play this before " +
          "stopping, if nobody asked them to continue. A behavioural estimate, not a " +
          "compliment — be realistic.",
      },
      overall_enjoyment: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description:
          "Overall: how much would a player enjoy this? Not an average of the " +
          "dimensions — weigh them as they actually bear on enjoyment.",
      },
      would_recommend: {
        type: "boolean",
        description: "Would you send this to a friend without caveats?",
      },
    },
    required: [
      "what_i_saw",
      ...DIMENSIONS.flatMap((d) => [`${d.key}_evidence`, d.key]),
      "best_moment",
      "biggest_problem",
      "minutes_before_quitting",
      "overall_enjoyment",
      "would_recommend",
    ],
  },
};

/**
 * The judge's system prompt, with the rubric rendered from DIMENSIONS so the anchors the
 * judge is held to and the anchors documented in this file cannot drift apart.
 */
export function judgeSystem() {
  const rubric = DIMENSIONS.map(
    (d) =>
      `${d.key} — ${d.question}\n` +
      `    1: ${d.anchors[1]}\n` +
      `    3: ${d.anchors[3]}\n` +
      `    5: ${d.anchors[5]}`
  ).join("\n\n");

  return `You are evaluating an AI-generated illustrated adventure game by looking at
screenshots of someone playing it. You see what the player saw, in order, and nothing
else: no source code, no internal state, no generation logs. Judge the game as a player
would experience it.

Score each dimension 1-5 against these anchors. 2 and 4 are available for cases that sit
between them.

${rubric}

Calibration, and this is the part that matters most:

**3 is the expected score.** 3 means competent, functional, unremarkable — which is what
most generated content is, and it is not an insult. Reserve 5 for work that would hold up
as a commercial release, and use 1 and 2 without hesitation when something is broken or
absent. A report where everything scores 4 is useless to the people trying to improve the
game, and is almost always wrong.

Judge only what the screenshots support. If you cannot see whether an early choice had
consequences twenty turns later, score agency on what is visible and say in the evidence
that the view was partial. Do not infer quality from the premise being interesting, from
the prose sounding confident, or from the game appearing to work — a game can be
flawless and dull, and dull is the failure this report exists to catch.

Look hard at the pictures, not only the text in them. Cut-out figures with pale fringes
or hard rectangular edges, figures whose feet do not meet the ground, a character
rendered in a different style from the scene behind them, a blank shape where art failed
— these are the defects a player notices first and a text transcript cannot show.`;
}

/**
 * Normalises a verdict into a canonical `{ ..., scores: { <dim>: {evidence, score} } }`,
 * whichever shape the judge actually emitted.
 *
 * Accepts the flat shape the schema now asks for, the nested `scores` object an earlier
 * schema asked for, and the mixture that caused this function to exist: eight dimensions
 * hoisted to the top level, `scores` present but holding a string, and the ninth
 * dimension missing entirely. A whole playthrough's scores were reported as "?" because
 * of that, which is a worse failure than a crash — the run looked like it had been
 * measured.
 *
 * Like `repairTurnShape` in the narrative contract, this reassembles and never invents:
 * a dimension that is genuinely absent stays absent and is listed in `missing`, so the
 * caller can say so rather than quietly scoring it.
 *
 * @returns {{verdict: object, missing: string[], repaired: boolean}}
 */
export function repairVerdictShape(raw) {
  if (!raw || typeof raw !== "object") return { verdict: raw, missing: DIMENSIONS.map((d) => d.key), repaired: false };

  const nested = raw.scores && typeof raw.scores === "object" && !Array.isArray(raw.scores) ? raw.scores : null;
  const scores = {};
  const missing = [];
  let repaired = false;

  // When a nested object could not be produced, the markup for it sometimes arrives
  // inside the string instead. Recover the text rather than printing the tags.
  const cleanEvidence = (v) => {
    if (typeof v !== "string") return "";
    const tagged = /<parameter\s+name="evidence">([\s\S]*?)(?:<\/parameter>|$)/i.exec(v);
    return (tagged ? tagged[1] : v).replace(/<\/?parameter[^>]*>/gi, "").trim();
  };
  const asScore = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // A score arriving as "4" rather than 4.
    if (typeof v === "string" && /^\s*[1-5]\s*$/.test(v)) return Number(v.trim());
    return null;
  };

  for (const d of DIMENSIONS) {
    const flatScore = asScore(raw[`${d.key}_score`] ?? raw[d.key]);
    const object = nested?.[d.key] ?? raw[d.key];

    if (flatScore !== null) {
      // The shape the schema now asks for: a scalar score beside a scalar evidence
      // string. `raw[d.key]` being a plain number is also this case.
      scores[d.key] = {
        evidence: cleanEvidence(raw[`${d.key}_evidence`]) || cleanEvidence(object?.evidence),
        score: flatScore,
      };
      if (!raw[`${d.key}_evidence`]) repaired = true;
    } else if (object && typeof object === "object" && asScore(object.score) !== null) {
      // An older nested {evidence, score}.
      scores[d.key] = { evidence: cleanEvidence(object.evidence), score: asScore(object.score) };
      if (!nested?.[d.key]) repaired = true;
    } else if (typeof object === "string" && cleanEvidence(object) && asScore(raw.score) !== null) {
      // The leak: evidence landed in the dimension's own field as markup, and the score
      // spilled out beside it as a stray top-level `score`.
      scores[d.key] = { evidence: cleanEvidence(object), score: asScore(raw.score) };
      repaired = true;
    } else {
      missing.push(d.key);
    }
  }

  if (typeof raw.scores === "string") repaired = true;

  return { verdict: { ...raw, scores }, missing, repaired };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "in", "on", "at", "for", "with", "it",
  "its", "your", "you", "my", "i", "is", "be", "that", "this", "them", "him", "her",
]);

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

/**
 * How closely two pieces of button text agree, 0..1.
 *
 * The player reads choice text off a screenshot and types back what it read, so the
 * string it reports is close to but rarely identical to the DOM text — a dropped article,
 * a guessed word under a particle effect, a truncation. Token overlap tolerates that
 * where exact comparison would not. Weighted toward the candidate: the player quoting
 * three words of a twelve-word button should still match it.
 */
export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;

  const setB = new Set(tb);
  const hits = ta.filter((t) => setB.has(t)).length;
  if (!hits) return 0;

  const precision = hits / ta.length;
  const recall = hits / tb.length;
  // Favour precision: everything the player claimed to read being present in the button
  // is stronger evidence than the button being fully covered.
  return (2 * precision * recall) / (precision + recall) * 0.5 + precision * 0.5;
}

// Below this, the player's reported text is not recognisably any of the buttons on
// screen. That is worth recording rather than silently papering over: a player who
// cannot read the options is a legibility defect, and quietly clicking the first button
// would hide it and corrupt the playthrough at the same time.
export const MATCH_THRESHOLD = 0.34;

/**
 * Picks the on-screen choice the player meant.
 *
 * @param {string} reported - the button text as the player read it off the screen
 * @param {Array<{text: string}>} candidates - the choices actually in the DOM
 * @returns {{index: number, score: number, matched: boolean}} index is -1 when nothing
 *   cleared MATCH_THRESHOLD.
 */
export function matchChoice(reported, candidates) {
  let best = { index: -1, score: 0, matched: false };
  (candidates || []).forEach((c, index) => {
    const score = similarity(reported, c?.text);
    if (score > best.score) best = { index, score, matched: score >= MATCH_THRESHOLD };
  });
  return best;
}

/**
 * Mean of a numeric list, or null for an empty one. Returns null rather than 0 or NaN
 * because "no turns recorded" and "every turn scored zero" are different findings, and
 * an earlier version of the pressure checker in this project certified a session on
 * exactly that confusion.
 */
export function mean(values) {
  const nums = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Objective counters over a play log, computed without asking a model anything.
 *
 * These exist to be compared against the judge's opinion, not to feed it. The judge
 * scoring `stakes` a 5 on a session where no tracked number ever moved means the prose
 * is writing cheques the mechanics do not cash — which is a finding about the game, and
 * one that is only visible because the two measurements are taken independently.
 */
export function playMetrics(turns) {
  const list = turns || [];
  const statHistory = new Map();
  for (const t of list) {
    for (const [k, v] of Object.entries(t.stats || {})) {
      if (!statHistory.has(k)) statHistory.set(k, []);
      statHistory.get(k).push(v);
    }
  }

  const statMovement = {};
  for (const [key, values] of statHistory) {
    let changes = 0;
    for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) changes++;
    statMovement[key] = { observations: values.length, changes };
  }

  // A stat that moved on nearly every turn it was present is doing the job the pressure
  // requirement in the narrative prompt asks of it.
  const pressureStats = Object.entries(statMovement)
    .filter(([, m]) => m.observations >= 4 && m.changes >= m.observations - 2)
    .map(([k]) => k);

  const progress = list.map((t) => t.progress).filter((p) => typeof p === "number");
  let progressReversals = 0;
  for (let i = 1; i < progress.length; i++) if (progress[i] < progress[i - 1]) progressReversals++;

  return {
    turns: list.length,
    reachedEnding: list.some((t) => t.ending),
    engagementMean: mean(list.map((t) => t.engagement)),
    engagementMin: list.length ? Math.min(...list.map((t) => t.engagement ?? 5)) : null,
    // The share of turns where the player thought it was being offered the same move
    // twice. High here with a high `agency` score from the judge is a contradiction
    // worth looking at.
    sameyChoiceRate: list.length
      ? list.filter((t) => t.choices_distinct === false).length / list.length
      : null,
    confusedTurns: list.filter((t) => (t.confusion || "").trim()).length,
    // Turns where the player could not find the button it tried to press.
    unreadableChoiceTurns: list.filter((t) => t.targetMiss).length,
    statMovement,
    pressureStats,
    progressReversals,
    finalProgress: progress.length ? progress[progress.length - 1] : null,
  };
}
