# Interactive Game Generation

Give it a premise, a chapter, a historical account — anything — and it generates a
playable illustrated adventure: a painted place you walk through, people you can talk to,
something to achieve, and a story that keeps being written from the choices you make.

See [`docs/research.md`](docs/research.md) for the problem formulation, related-work
positioning and evaluation plan. This is built as a research artifact (targeting
ICML/NeurIPS-style venues), not only a demo, so every generation call is ablatable
(personalization on/off, evolving memory on/off, persistent/regenerated world, 2D/3D
renderer) and logged to JSONL for analysis.

## What it makes

A side-on point-and-click adventure. One wide painted backdrop that the camera pans
across, cut-out figures standing on a pseudo-3D ground plane, and your own character
walking between them. Choices tied to a place can only be taken from that place, so
walking there *is* the act of choosing — the stage is load-bearing, not scenery.

```
web/     React frontend. web/src/stage/ is the 2D renderer; web/src/scene/ is the 3D one
server/  Express. Wraps Claude for narrative and art direction, Gemini for illustration
shared/  The generation contracts: story2d.js (2D) and worldState.js (3D)
docs/    Research framing: problem formulation, related work, ablations, eval plan
scripts/ playthrough.mjs — drives a real browser through a real game and screenshots it
```

The model emits a structured turn through a forced tool call — prose, the scene, the
choices, an objective, honest progress, and the beats the character acts out — and a
deterministic renderer turns that JSON into the playable stage. That split is what makes
the system ablatable: any difference between conditions traces to the generation call,
not to rendering noise.

**Nothing about the world comes from a fixed list.** There is no enum of settings, no
catalogue of objects, no library of art. The model authors its own vocabulary: every
actor carries a free-text description that its picture is painted from, every scene a
backdrop brief, a palette, a horizon and its own weather. A flooded cathedral and an
orbital hydroponics bay are equally expressible and neither is a preset.

## How the art holds together

The failure mode of generating each asset independently is twelve unrelated pictures. So
before a single image is made, one call decides the game's **art direction** — medium,
palette, light, edge quality — and who the protagonist is. That brief is then prepended
verbatim to every image prompt for the rest of the session
(`server/src/art/styleBible.js`). It is written fresh per premise, so a North Sea salvage
story and a courtly romance get genuinely different looks; what is fixed is only that a
look gets *chosen*.

Backdrops are painted at 21:9 and empty of anything that also appears as an actor.
Figures and portraits come back on flat magenta and are keyed out in the browser, with a
global despill pass because JPEG smears the backdrop colour several pixels into the
subject. Everything caches to disk under the art direction's id, so a description that
recurs is painted once.

## Setup

Requires **Node.js ≥ 18**.

```bash
npm install
cp server/.env.example server/.env    # then fill in the keys below
```

`server/.env`:

- `ANTHROPIC_API_KEY` — required. Narrative, art direction, and 3D geometry.
- `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) — illustration. Without it the game still
  plays, with painted silhouettes instead of art.
- `MESHY_API_KEY` — optional, 3D renderer only.

```bash
npm run dev:server   # http://localhost:3001
npm run dev:web      # http://localhost:5173  (proxies /api -> :3001)
npm test             # 136 dependency-free tests over the generation contracts
```

## Playing

Open `http://localhost:5173`, paste a premise (or take one of the four examples), give a
name and some interests — both are woven into the world and into who your character is —
and begin.

**Click to walk. Click a thing to walk over and examine it** (free, instant, and often
the most interesting text in the game). **A/D** or the arrow keys also walk; **shift**
runs. Choices are bottom right; a locked one tells you where to go and clicking it walks
you there. There is always at least one choice you can take from where you stand.

## Latency

Generation is slow by design — every object is drawn from scratch for this story. Two
things make that bearable:

- **The prose streams.** The narrative is the first field in the tool schema, and a
  partial-JSON reader pulls it out of the stream as it is written, so text starts
  appearing about a second in rather than after the whole turn is generated.
- **Art is generated before you are let in**, behind a curtain that shows the art
  direction and the opening prose. A world that appears finished is worth much more than
  one that starts sooner and assembles itself around you.

Measured across full playthroughs: a fresh opening scene takes **60–90 seconds** (art
direction, then the turn, then eight to twelve illustrations generated in parallel at
about ten seconds each), and a later turn **10–17 seconds**, with the first prose on
screen after **6–9** of them. Anything already generated is instant: the cache is
permanent and keyed by description, so a turn that changes nothing physical waits only on
the writing.

For a live demo, run the premise once beforehand. The second run is immediate.

## Two renderers

The 2D stage is the primary game. The first-person three.js renderer is still present and
working (`web/src/scene/`, `shared/worldState.js`, the un-prefixed `/api/*` routes) as the
other arm of the `engine` ablation: same narrative engine, same logging, same metrics,
different presentation. `web/src/App.jsx` mounts the 2D game.

## Current status

- End-to-end working: art direction, streaming narrative, illustrated stage, walking,
  proximity-gated choices, examine text, portraits for whoever is speaking, objective and
  honest progress, endings.
- `server/src/logging/logger.js` writes the JSONL substrate the eval plan depends on,
  including per-turn spatial-consistency counters (dangling references, duplicate ids,
  out-of-bounds placements) recorded from the first attempt, before any repair.
- **Personalization is prompt-only** — no retrieval over long history, no trained
  per-user component. Documented as a limitation in `docs/research.md`.
- The scoring scripts in `eval/` were written against the 3D contract and have not been
  ported to the 2D one.
