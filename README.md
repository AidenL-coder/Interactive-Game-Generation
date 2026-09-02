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

The model emits a structured `WorldState` via a forced tool call — narrative prose, the
next choices, and a scene descriptor — and a deterministic renderer turns that JSON into
a real walkable three.js world. See `shared/worldState.js` for the exact schema. The
split is what makes the system ablatable: any difference between conditions traces back
to the generation call, not to rendering noise.

**Nothing about the world is drawn from a fixed list.** The model authors its own
vocabulary: every prop carries a free-text description (`"MOSS-7, a squat maintenance
drone half-buried in vines"`), and every scene an environment — what the place is, what
the floor is made of, a hex palette, and light/visibility/density ratios that drive the
actual lighting, fog and ground cover. A drowned cathedral and an orbital hydroponics
bay are equally expressible, and neither is a preset.

Art is generated from those descriptions and cached on them:

- **ground and sky** from the environment's description and ground cover
- **object sprites** from each prop's own label, keyed out of a chroma background
- **3D models (GLB)** from the same label, when a text-to-3D key is configured
- everything else — terrain relief, hundreds of instanced scatter details, the distant
  horizon — is procedural, derived from the environment's palette and density

Props resolve through three tiers, best-effort: real 3D model → generated billboard →
primitive with a generated surface texture. Each upgrade lands in place, so a prop is
always visible and nothing blocks on the network.

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

## Presenting it

Generation is slow by design — every object in a world is drawn from scratch for that
story. A world's entire art set is generated up front, behind a progress screen, before
the player is let in, so the opening shot is finished rather than assembling itself on
screen. Expect roughly **40 seconds** for a fresh world with an image key configured,
and near-instant on anything already generated, since everything caches to disk
permanently.

For a live demo, run the premise once beforehand: the cache makes the second run
immediate.

## Controls

Click to capture the mouse. **WASD** to move, **Shift** to run, **E** to interact with
whatever the crosshair is on (talking to people, examining objects — both feed back into
the story as a normal turn), **Esc** to release the mouse.

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
