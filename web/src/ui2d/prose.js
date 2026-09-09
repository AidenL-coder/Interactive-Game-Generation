/**
 * Normalises generated prose for display.
 *
 * Models writing long strings into JSON quite often escape them twice: the tool input
 * arrives carrying `\\n` and `\"`, so a correct JSON decode yields a literal backslash-n
 * or backslash-quote and the text renders with visible escape codes in the middle of a
 * sentence — `\"You're the replacement,\" he says`.
 *
 * Normalising here rather than in the streaming parser is deliberate. That parser's job
 * is to decode JSON faithfully, and a stream delta can legitimately be split between the
 * backslash and the character it escapes, so the fix belongs where the whole string is.
 */
function unescape(text) {
  return String(text || "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\(["'])/g, "$1")
    .replace(/\r\n/g, "\n");
}

/** Splits prose into paragraphs, dropping blank ones. */
export function paragraphsOf(text) {
  return unescape(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The same normalisation for text shown as a single block. */
export function cleanProse(text) {
  return unescape(text).trim();
}
