// Reads the generation log and asks whether a session actually had stakes.
//
// "Is it fun" is not directly measurable, but the thing that made the tense playthroughs
// tense is: some force moved against the player every turn whether or not they chose
// well. A stat that is declared once and then sits still for eleven turns is set
// dressing, and a session where nothing moves against you is one where examining
// everything and talking to everyone forever is strictly optimal.
//
// This reports, per tracked stat, how many turns it actually changed on — which tells you
// at a glance whether the pressure is real or decorative.
//
// Usage:
//   node scripts/pressure-check.mjs [--session <id>] [--sessions 3]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, "..", "server", "logs", "generations.jsonl");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

// Research instrumentation, not something the player sees — it would always look like a
// busy "pressure" and drown out the real ones.
const HIDDEN = new Set(["inferred_preferences"]);

// Transitions needed before a verdict means anything. Below this, "changed on every turn"
// is arithmetic rather than evidence.
const MIN_TRANSITIONS = 4;

function valueOf(v) {
  if (Array.isArray(v)) return v.join("|");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

async function main() {
  let raw;
  try {
    raw = await readFile(LOG, "utf8");
  } catch {
    console.error(`no log at ${LOG} — play a session first`);
    process.exit(1);
  }

  const records = raw
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.worldState);

  const bySession = new Map();
  for (const r of records) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }

  const wanted = arg("session");
  const minTurns = Number(arg("min-turns", "1"));
  let sessions = [...bySession.entries()];
  if (wanted) {
    sessions = sessions.filter(([id]) => id.startsWith(wanted));
  } else {
    // The log is full of one-turn sessions from the motion probe, which opens a game and
    // never plays it. They cannot say anything about pacing, and including them buries the
    // real playthroughs.
    sessions = sessions.filter(([, turns]) => turns.length >= minTurns);
    sessions = sessions.slice(-Number(arg("sessions", "1")));
  }
  if (!sessions.length) {
    console.log(`no sessions with at least ${minTurns} turns in the log`);
    return;
  }

  for (const [id, turnsUnsorted] of sessions) {
    const turns = [...turnsUnsorted].sort((a, b) => a.turnIndex - b.turnIndex);
    const last = turns[turns.length - 1].worldState;

    console.log(`\n=== session ${id.slice(0, 8)} — ${turns.length} turns ===`);
    console.log(`objective : ${last.objective || "(none)"}`);
    console.log(
      `ending    : ${last.ending ? `${last.ending.outcome} on turn ${turns.length}` : "did not finish"}`
    );

    // Progress should climb and is allowed to fall; what it must not do is sit still.
    const progress = turns.map((t) => t.worldState.progress);
    const progressMoves = progress.filter((p, i) => i > 0 && p !== progress[i - 1]).length;
    console.log(
      `progress  : ${progress.map((p) => (typeof p === "number" ? p.toFixed(2) : "-")).join(" -> ")}`
    );
    console.log(`            moved on ${progressMoves}/${turns.length - 1} turns`);

    const names = new Set();
    for (const t of turns) {
      for (const k of Object.keys(t.worldState.state_updates || {})) {
        if (!HIDDEN.has(k)) names.add(k);
      }
    }

    console.log(`\nstats (changed on N of ${turns.length - 1} possible turns):`);
    const scored = [];
    for (const name of names) {
      const series = turns.map((t) => {
        const v = t.worldState.state_updates?.[name];
        return v === undefined ? null : valueOf(v);
      });
      const changes = series.filter((v, i) => i > 0 && v !== null && v !== series[i - 1]).length;
      scored.push({ name, changes, series });
    }
    scored.sort((a, b) => b.changes - a.changes);

    for (const s of scored) {
      const every = s.changes === turns.length - 1 ? "  <- moves every turn" : "";
      const preview = s.series.map((v) => (v === null ? "-" : v)).join(" -> ");
      console.log(
        `  ${s.name.padEnd(22)} ${String(s.changes).padStart(2)}${every}\n      ${preview.slice(0, 120)}`
      );
    }

    // A session with one turn has zero transitions, so "changed on every turn" is
    // vacuously true and the first version of this happily certified pressure from no
    // evidence whatsoever. Refuse to render a verdict without enough turns to see a trend.
    const transitions = turns.length - 1;
    const pressure = scored.find((s) => s.changes === transitions);

    let verdict;
    if (transitions < MIN_TRANSITIONS) {
      verdict =
        `not enough turns to judge — ${transitions} transition(s), need ` +
        `${MIN_TRANSITIONS}. A stat trivially "moves every turn" when there are no turns.`;
    } else if (pressure) {
      verdict = `"${pressure.name}" is a real pressure — it moved on all ${transitions} turns.`;
    } else {
      const best = scored[0];
      verdict =
        "NO stat moved every turn, so nothing was reliably pushing back on the player" +
        (best ? ` (the busiest was "${best.name}", ${best.changes}/${transitions}).` : ".");
    }
    console.log(`\nverdict   : ${verdict}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
