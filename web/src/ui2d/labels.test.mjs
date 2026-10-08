// The locked-choice pill tells the player where to walk. When it is wrong it is not
// subtly wrong — it says "GO TO ON A SHELF" — and it is invisible to every test that
// does not render. These are the real labels that produced the real bad pills, taken
// from screenshots of actual playthroughs. Run with: npm test
import { shortName } from "./labels.js";

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
const is = (label, want) => check(`"${label.slice(0, 44)}…" -> "${want}"`, shortName(label) === want, `got "${shortName(label)}"`);

console.log("\n--- the pills that were actually broken on screen ---");
// Each of these rendered as the tail of its own description.
is("a cloth-bound exchange ledger lying open on a shelf", "cloth-bound exchange ledger");
is("a slow-turning orrery of glowing cyan points suspended in open air", "slow-turning orrery");
is("a strange dripping oilskin that isn't yours", "strange dripping oilskin");
is("a tall pegboard covering one wall, hung with numbered cream tiles", "tall pegboard");
is("a heavy chrome cutting wheel mounted on a low bench", "heavy chrome cutting wheel");

console.log("\n--- names and short labels are left alone ---");
is("the Keeper, a calm woman in a long graphite-grey coat", "Keeper");
is("Mara Voss, a rope-burned salvage diver in a patched drysuit", "Mara Voss");
is("a brass diving helmet", "brass diving helmet");
is("lantern", "lantern");
is("an open crate heaped with small cream-coloured tiles", "open crate");

console.log("\n--- articles, separators and length ---");
check("the leading article goes", shortName("the wheel") === "wheel");
check("'an' goes too", shortName("an orrery") === "orrery");
check("an em dash ends the name", shortName("the door — swollen shut with damp") === "door");
check("a bracket ends the name", shortName("the ledger (water-damaged)") === "ledger");
check("a semicolon ends the name", shortName("the lamp; unlit") === "lamp");
check(
  "a very long head is cut with an ellipsis",
  shortName("a magnificent enormous resplendent cabinet").length <= 30,
  `got "${shortName("a magnificent enormous resplendent cabinet")}" (${shortName("a magnificent enormous resplendent cabinet").length})`
);
check("the ellipsis does not leave a trailing space", !/ …$/.test(shortName("a magnificent enormous resplendent gilded cabinet")));
check("at most four words survive", shortName("one two three four five six").split(/\s+/).length <= 4);

console.log("\n--- nothing to name ---");
check("empty gives the fallback", shortName("") === "there");
check("undefined gives the fallback", shortName(undefined) === "there");
check("null gives the fallback", shortName(null) === "there");
check("a custom fallback is used", shortName("", "the door") === "the door");
// A label that is nothing but a trailing clause must not produce an empty pill.
check("a label that reduces to nothing falls back", shortName("that isn't yours") === "there", `got "${shortName("that isn't yours")}"`);
check("a bare article falls back", shortName("the") === "there", `got "${shortName("the")}"`);

console.log("\n--- the pill is never longer than the button ---");
{
  const LABELS = [
    "a vast dark archway far down the hall, unlit, carved with a repeating motif",
    "eight identical tall cabinets standing shoulder to shoulder in a row",
    "a wide curved bank of upright glass tubes of markedly different heights",
    "a thick straight pipe running the entire length of the room above head height",
    "a floating sentence of glowing cream word-tokens strung in a gentle arc",
  ];
  check("every real pack label fits in 30 characters", LABELS.every((l) => shortName(l).length <= 30), LABELS.map((l) => `${shortName(l)}(${shortName(l).length})`).join(" | "));
  check("and none of them is empty", LABELS.every((l) => shortName(l).length > 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
