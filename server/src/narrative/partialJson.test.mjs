// The streaming prose parser reads a string field out of JSON that is still arriving, so
// it has to cope with a buffer that can be cut at any byte — including halfway through an
// escape sequence. Getting that wrong emits a character the next chunk contradicts, which
// shows up as garbage in the player's face rather than as an exception. Hence tests.
// Run with: npm test
import { readPartialString, makeStringStreamer } from "./partialJson.js";

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

console.log("\n--- readPartialString ---");
check("no key yet returns null", readPartialString('{"sce', "narrative") === null);
check("key without colon returns null", readPartialString('{"narrative"', "narrative") === null);
check("colon without quote returns null", readPartialString('{"narrative": ', "narrative") === null);
check(
  "whitespace between key and value tolerated",
  readPartialString('{"narrative"   :   "hi', "narrative")?.value === "hi"
);
{
  const r = readPartialString('{"narrative": "abc', "narrative");
  check("open string is incomplete", r.value === "abc" && r.complete === false);
}
{
  const r = readPartialString('{"narrative": "abc", "scene": {}}', "narrative");
  check("closed string is complete", r.value === "abc" && r.complete === true);
}
check(
  "escaped quote decodes",
  readPartialString('{"narrative": "she said \\"go\\""', "narrative").value === 'she said "go"'
);
check(
  "newline escape decodes",
  readPartialString('{"narrative": "one\\ntwo"', "narrative").value === "one\ntwo"
);
check(
  "backslash escape decodes",
  readPartialString('{"narrative": "a\\\\b"', "narrative").value === "a\\b"
);
check(
  "unicode escape decodes",
  readPartialString('{"narrative": "caf\\u00e9"', "narrative").value === "café"
);
// The dangerous cases: a buffer cut mid-escape must hold the partial back rather than
// emitting something the next chunk will contradict.
check(
  "trailing lone backslash is held back",
  readPartialString('{"narrative": "a\\', "narrative").value === "a"
);
check(
  "partial unicode escape is held back",
  readPartialString('{"narrative": "a\\u00', "narrative").value === "a"
);
check(
  "malformed unicode escape is held back",
  readPartialString('{"narrative": "a\\uZZ', "narrative").value === "a"
);
check(
  "a quote inside an earlier field does not confuse the scan",
  readPartialString('{"other": "narrative", "narrative": "real', "narrative").value === "real"
);

console.log("\n--- makeStringStreamer ---");
{
  // Feed the buffer one byte at a time; the concatenated deltas must equal the value and
  // nothing may ever be emitted twice.
  const value = 'You wake to "rain".\nCold, and \\ still dark. café';
  const json = JSON.stringify({ narrative: value, scene: { a: 1 } });
  const push = makeStringStreamer("narrative");
  let acc = "";
  let out = "";
  for (const ch of json) {
    acc += ch;
    out += push(acc);
  }
  check("byte-at-a-time stream reconstructs the value exactly", out === value, JSON.stringify(out));
}
{
  // Realistic chunking: the API delivers arbitrary-length fragments.
  const value = "A short beat.\n\nAnd another one, with an em dash — and a \"quote\".";
  const json = JSON.stringify({ narrative: value });
  const push = makeStringStreamer("narrative");
  let acc = "";
  let out = "";
  for (let i = 0; i < json.length; i += 7) {
    acc += json.slice(i, i + 7);
    out += push(acc);
  }
  check("chunked stream reconstructs the value exactly", out === value, JSON.stringify(out));
}
{
  const push = makeStringStreamer("narrative");
  push('{"narrative": "abc", "x": 1}');
  const after = push('{"narrative": "abcdef"');
  check("nothing more is emitted once the string closed", after === "");
}
{
  const push = makeStringStreamer("narrative");
  check("a buffer without the key emits nothing", push('{"scene": {') === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
