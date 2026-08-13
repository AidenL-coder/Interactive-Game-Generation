# Interactive Game Generation

Turns arbitrary source narrative (a novel chapter, a historical account, a subject to
learn, a bare premise) into a playable, personalized 3D world whose story keeps being
generated from the player's choices instead of being authored once and left static.

See [`docs/research.md`](docs/research.md) for the problem formulation, related-work
positioning, and evaluation plan — this is being built as a research artifact (targeting
ICML/NeurIPS-style venues), not just a demo, so every generation call is ablatable
(personalization on/off, evolving-memory on/off) and logged to JSONL for later analysis.

## Architecture

```
web/     React + three.js frontend — first-person walkable 3D scene, choice UI
server/  Express backend — wraps the Claude API, forces structured JSON output
shared/  WorldState JSON schema + vocab shared by server (generation) and web (rendering)
docs/    Research framing: problem formulation, related work, ablations, eval plan
```

The model never generates images or meshes directly. It emits a structured `WorldState`
(narrative text + a scene descriptor: biome, mood, time of day, a list of typed/placed
props, and the next choices) via a forced tool call — see `shared/worldState.js` for the
exact schema. The renderer deterministically turns that JSON into real three.js geometry
and procedural textures. This split is what makes the system ablatable: any difference
between conditions traces back to the generation call, not rendering noise.

## Setup

Requires **Node.js ≥ 18** and **npm**. Neither was available on the machine this was
scaffolded on, so none of this has been run or tested yet — treat it as a first pass to
get running and debug, not working code.

```bash
npm install                          # installs all three workspaces
cp server/.env.example server/.env   # then fill in ANTHROPIC_API_KEY
```

Run both dev servers (two terminals):

```bash
npm run dev:server   # http://localhost:3001
npm run dev:web      # http://localhost:5173  (proxies /api -> :3001)
```

Open `http://localhost:5173`, fill in the start form (name, interests, source text, and
the two ablation toggles), then click into the 3D view and use WASD + mouse look. Choices
appear in the bottom panel; picking one (or typing free text) regenerates the world.

## Current status / known gaps

- **Texture/art generation is procedural only** — no live diffusion model is wired in
  yet, so "AI 2D textures" is currently a canvas-based stand-in
  (`web/src/scene/proceduralTexture.js`). That module is the intended integration point.
- **Personalization is prompt-only** — no retrieval over long history, no trained
  per-user component. Documented as a limitation in `docs/research.md`.
- **No automatic eval metrics implemented yet** — `server/src/logging/logger.js` writes
  the raw JSONL substrate (`server/logs/generations.jsonl`) the eval plan depends on, but
  the scoring scripts themselves don't exist yet.
- **Untested end-to-end** — written without a local Node/Python install; expect to need
  a debugging pass (dependency versions, the `three/addons/*` import path, Anthropic SDK
  response shape) once run for the first time.
