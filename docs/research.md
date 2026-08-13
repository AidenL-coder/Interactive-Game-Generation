# Research Framing

Working title: **Personalized Interactive World Generation** — turning arbitrary source
narrative (a novel chapter, a historical account, a subject to learn) into a playable,
personalized 3D world whose story continues to be generated turn-by-turn from the
player's choices, rather than being authored once and left static.

This document exists so the codebase in `server/` and `web/` doubles as the experimental
system for a paper, not just a demo: every generation call is ablatable and logged.

## Problem formulation

Following the standard personalized-generation setup (cf. Kelley's week-4 slide):

- Standard generation: `ŷ ~ p_θ(y | x)` — output depends only on the current request.
- Personalized generation: `ŷ ~ p_θ(y | x, P_u)` — additionally conditioned on a user
  profile `P_u` (stated interests/preferences, and preferences inferred from prior choices).

We extend this with a **history term** for the interactive/evolving setting:

```
ŷ_t ~ p_θ(y_t | x_0, P_u, H_{t-1})
```

where `x_0` is the seed source text, `P_u` is the user profile, and `H_{t-1}` is the
accumulated narrative + world-state + choice history up to turn `t-1`. `ŷ_t` is a
structured object `(narrative_t, scene_t, choices_t)`, not free text — `scene_t` is a
JSON world-state descriptor that a deterministic renderer turns into an actual walkable
3D scene (procedural geometry + placed props; see `web/src/scene/`). Fixing the
renderer as deterministic is what makes `scene_t` comparable across ablations: any
difference in the rendered world traces back to the generation call, not to rendering
noise.

Objective (cf. Kelley's slide 49): `Overall quality = Task quality + λ · Personalization quality`,
where task quality is roughly "is this a coherent, playable, well-formed world/story"
and personalization quality is "does it reflect `P_u`, and does it stay consistent turn
to turn." Both need proxies — see Evaluation below.

## System overview

```
source text + user profile ──▶ [server] generateScene() ──▶ structured WorldState (JSON)
                                     │  Claude, forced tool-call output          │
                                     │  (server/src/narrative/)                  ▼
                              history_{t-1} ◀── append ──  { narrative, scene, choices }
                                                                    │
                                                                    ▼
                                                     [web] SceneRenderer builds
                                                     actual three.js geometry/
                                                     textures from `scene` (deterministic,
                                                     no model call) — player walks it,
                                                     picks a choice, loop repeats
```

Two independent axes are wired as request-level flags so both can be ablated without
code changes (`server/src/narrative/prompts.js`, `sessionStore` ablation config):

- **`personalization`**: on = `P_u` (name, stated interests, inferred preferences) is
  injected into the system prompt and the model is instructed to weave it into the
  world; off = a generic/anonymous protagonist, same source text.
- **`evolving`**: on = full turn history `H_{t-1}` is passed to the model each call
  (continuity, callbacks, consequences persist); off = each turn is generated from a
  short state summary only, with no access to prior turns — a "memoryless" baseline
  closer to independently-regenerated levels (cf. the 2010 Mario PCG paper Zixuan
  covered, which optimizes a level once per player model rather than adapting turn by
  turn).

This gives a 2×2 design (personalization × evolving) for the eventual ablation table,
plus room for a third baseline of pure human-authored or template-based worlds if a
non-LLM baseline is wanted for the paper.

## Relation to prior work surveyed this summer

- **User modeling from interaction**: Inaba & Takahashi (2018) predict topic interest
  from dialogue with a trained classifier; we instead let an LLM infer + apply
  preferences directly from stated interests and in-context choice history — closer to
  Wu et al.'s "Aligning LLMs with Individual Preferences via Interaction" (COLING 2025),
  which infers a persona incrementally from revealed messages. Our `P_u` is currently
  explicit (user-stated) plus implicit-via-history; a natural extension is an explicit
  persona-inference step per turn, as in that paper.
- **Retrieval over user history**: LaMP / LongLaMP (Salemi et al.; Kumar et al., 2024)
  retrieve relevant past user records to condition generation. Our `H_{t-1}` is currently
  the full turn history in-context (bounded by context window); retrieval-augmented
  selection of *which* prior turns matter is a planned ablation once sessions get long.
- **Personalization beyond prompting**: P-RLHF (Li et al., 2024) trains a lightweight
  per-user model instead of relying on prompt-only conditioning. Our system is
  prompt-only by design (matches the "call an LLM, would simplify" note from Andrew's
  slide 8), which is a limitation worth stating explicitly in the paper — prompted
  personalization vs. trained personalization is a fair comparison to run if time
  allows.
- **Content generation for games**: "Towards Automatic Personalized Content Generation
  for Platform Games" (Mario, 2010) fits a player-experience model from telemetry, then
  optimizes a level for it once. "Game Generation via LLMs" treats an LLM as the level/
  rule/code author from a text blueprint. We combine both ideas but generate a new
  world-state every turn conditioned on the accumulating interaction, not once
  up front.
- **Narrative personalization via RL**: Wang et al., "Interactive Narrative
  Personalization with Deep Reinforcement Learning" (IJCAI 2017), trains a Q-network
  on a bipartite player-action/outcome simulator (33–57% accuracy on real deployments).
  Their result is a useful sanity check on how hard player-outcome prediction is even
  with dedicated training data; it's evidence our in-context approach should be
  evaluated on narrative/personalization quality, not assumed to "solve" player
  modeling implicitly.
- **Visual personalization**: DreamBooth, InstructPix2Pix, FABRIC, and PCG
  ("Personalized Visual Content Generation in Conversational Systems") all personalize
  *images* via fine-tuning, editing, or feedback loops. Our current renderer uses
  procedural geometry + generated 2D textures rather than per-object diffusion, for
  latency (StreamDiffusion-class real-time generation is the eventual target if we
  swap in live diffusion — see `web/src/scene/proceduralTexture.js` for the seam where
  a real texture-generation call would replace the procedural fallback).

## Evaluation plan (draft)

Automatic:
- **Coherence/validity**: schema-valid structured output rate, prop-count and
  placement bounds compliance, choice-count compliance (already enforced by the
  Anthropic tool schema in `server/src/narrative/schema.js`, but worth reporting as a
  reliability metric across ablations).
- **Personalization signal**: does `scene_t`/`narrative_t` text reference the stated
  interests/profile terms (simple keyword/embedding-similarity check) — compare
  personalization on vs. off.
- **Continuity**: for `evolving=on`, check whether turn `t` references
  entities/state introduced at turn `t-k` (a callback rate) — compare evolving on vs.
  off.

Human/LLM-judge (needed for the parts automatic metrics can't capture, per the
recurring "the more specific the model, the better the results" and CoNoder-style
reader-experience feedback discussed this summer):
- Pairwise preference between ablation conditions on: personalization fit, narrative
  coherence, and "did the world feel like it reacted to my choice."
- Session-level engagement proxy: turns played before quitting, in a small user study
  (cf. the Crystal Island 300/153-participant studies Andrew covered — useful as a
  scale reference, not something to match immediately).

All of the above depends on `server/src/logging/logger.js`, which writes one JSONL
record per generation call (session id, turn index, ablation config, prompt/response,
latency, token counts) specifically so these metrics can be computed offline without
re-running the system.

## Known gaps / next steps

- No real image/texture generation model wired in yet (procedural fallback only) —
  needed before the "AI 2D textures" half of the pipeline is real.
- No retrieval over history, no trained per-user component — currently prompt-only
  personalization, stated as a limitation above.
- No automatic metric implementation yet, only the logging substrate — `docs/research.md`
  vs. an `eval/` scoring script is the next gap to close.
- No non-LLM baseline (template-based or fixed level generator) implemented for
  contrast in the ablation table.
