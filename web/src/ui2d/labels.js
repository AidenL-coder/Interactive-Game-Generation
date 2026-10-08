// Turning a painter's brief into something you can print on a button.
//
// Every actor carries a `label` that is written to be painted from, not to be read:
// "a cloth-bound exchange ledger lying open on a shelf", "the Keeper, a calm woman in a
// long graphite-grey coat with cyan wire looped over one shoulder". The locked-choice
// pill has room for about three words of that, and which three it picks is the
// difference between "GO TO THE LEDGER" and "GO TO ON A SHELF".
//
// Pure and separate from the component so the rule can be pinned by tests — it was
// wrong for a long time in a way that only showed up in screenshots.

// Where the thing being described stops and the description of the picture begins.
// Everything from here on is staging: where it sits, what it rests on, what it is doing,
// what it is made of.
//
// Spelled out rather than inferred. The tempting general rule — "cut at the first word
// ending in -ing" — is wrong, because these labels put participles in front of the head
// as often as after it: "a heavy chrome CUTTING wheel" would lose its noun. An explicit
// list is longer but it only ever cuts where it was told to.
const CLAUSE_WORDS =
  "that|which|who|whose|of|with|without|on|in|at|under|over|beside|behind|against|across|from|" +
  "lying|standing|hanging|sitting|resting|propped|leaning|mounted|set|covered|covering|strung|" +
  "topped|wearing|holding|filled|suspended|projecting|running|feeding|braiding|divided|heaped|" +
  "stamped|marked|lined|carved|throwing|passing|full|made";

// Beyond this the pill is absurd; the CSS cap handles anything merely long.
export const MAX_PILL = 30;

const TRAILING_CLAUSE = new RegExp(`\\s+\\b(?:${CLAUSE_WORDS})\\b\\s.*$`, "i");
// A label that is nothing BUT a clause names nothing, and must not become the pill.
const LEADING_CLAUSE = new RegExp(`^(?:${CLAUSE_WORDS})\\b`, "i");

/**
 * The shortest phrase that still names the thing.
 *
 * The first version of this kept the LAST three words, reasoning that an English noun
 * phrase is head-final. It is — but these labels run on past the head into a trailing
 * description, so the rule reliably kept the description and discarded the noun. A
 * vision player reading the screen quoted "GO TO GREEN GLASS SHADE" as the name of a
 * button, and a judge called the pills unreadable. Take the front of the phrase.
 *
 * @param {string} label - the actor's full painter's brief
 * @param {string} [fallback] - what to say when there is nothing to name
 */
export function shortName(label, fallback = "there") {
  if (!label) return fallback;
  const head = String(label)
    // A comma, dash, colon or bracket ends the name and begins the brief.
    .split(/[,—(:;]/)[0]
    .replace(TRAILING_CLAUSE, "")
    .trim()
    // `\b` rather than `\s+`, so a label that is only the word "the" is stripped to
    // nothing and caught below instead of being printed as "GO TO THE".
    .replace(/^(a|an|the)\b\s*/i, "")
    .trim();

  const words = head.split(/\s+/).filter(Boolean);
  if (!words.length || LEADING_CLAUSE.test(head)) return fallback;

  // Generous, because the pill also has a CSS width cap with a real ellipsis: this
  // limit only exists to stop an absurd label, and cutting a legitimate three-word name
  // like "cloth-bound exchange ledger" in JS when it would have fitted on screen is the
  // worse error of the two.
  const kept = words.slice(0, 4).join(" ");
  return kept.length > MAX_PILL ? `${kept.slice(0, MAX_PILL - 2).trimEnd()}…` : kept;
}
