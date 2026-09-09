// Reads a named string field out of JSON that is still being written.
//
// The whole point of streaming a tool call is that the player sees prose about a second
// in rather than staring at a spinner for forty. The API streams the tool input as raw
// JSON fragments (`input_json_delta`), which cannot be JSON.parse'd until the object is
// closed — so we scan the buffer for the one key we care about and decode as much of its
// value as has arrived.
//
// `narrative` is deliberately the first property in both story tools' schemas, which is
// what makes this land early enough to matter.

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * @param {string} buffer - JSON text so far, possibly truncated mid-token
 * @param {string} key - the property name to read
 * @returns {{ value: string, complete: boolean } | null} null if the key has not
 *   appeared yet. `complete` is true once the closing quote has arrived, which is the
 *   signal that no more of this field is coming.
 */
export function readPartialString(buffer, key) {
  if (typeof buffer !== "string") return null;

  const needle = `"${key}"`;

  // The text `"narrative"` can appear as another field's *value* — or inside the prose
  // itself — before it appears as the key we want. So every occurrence is tried, and
  // only one actually followed by a colon and a string counts.
  let start = -1;
  let i = 0;
  for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, at + 1)) {
    // Step over `"key"`, whitespace, `:`, whitespace, and the opening quote. Any of
    // these may not have arrived yet, in which case there is nothing to show.
    let j = at + needle.length;
    while (j < buffer.length && /\s/.test(buffer[j])) j++;
    if (buffer[j] !== ":") continue;
    j++;
    while (j < buffer.length && /\s/.test(buffer[j])) j++;
    // Ran out of buffer mid-punctuation: this is very likely our key, just not open yet.
    if (j >= buffer.length) return null;
    if (buffer[j] !== '"') continue;
    start = at;
    i = j + 1;
    break;
  }
  if (start === -1) return null;

  let out = "";
  while (i < buffer.length) {
    const ch = buffer[i];

    if (ch === "\\") {
      // A backslash at the very end of the buffer is a half-arrived escape. Stop before
      // it rather than emitting a stray slash that the next chunk would contradict.
      if (i + 1 >= buffer.length) return { value: out, complete: false };
      const next = buffer[i + 1];

      if (next === "u") {
        // \uXXXX may also be split across chunks.
        if (i + 6 > buffer.length) return { value: out, complete: false };
        const hex = buffer.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, complete: false };
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }

      if (next in ESCAPES) {
        out += ESCAPES[next];
        i += 2;
        continue;
      }
      // Not a legal escape; treat it literally rather than dropping the character.
      out += next;
      i += 2;
      continue;
    }

    if (ch === '"') return { value: out, complete: true };

    out += ch;
    i++;
  }

  return { value: out, complete: false };
}

/**
 * Stateful wrapper: feed it the growing buffer and it yields only what is newly added,
 * so a caller can emit deltas down a socket without re-sending the whole string.
 */
export function makeStringStreamer(key) {
  let emitted = 0;
  let done = false;

  return function push(buffer) {
    if (done) return "";
    const read = readPartialString(buffer, key);
    if (!read) return "";
    if (read.complete) done = true;
    // The decoded value only ever grows, but guard anyway: a retry hands us a fresh
    // buffer, and emitting a negative slice would corrupt the stream.
    if (read.value.length <= emitted) return "";
    const delta = read.value.slice(emitted);
    emitted = read.value.length;
    return delta;
  };
}
