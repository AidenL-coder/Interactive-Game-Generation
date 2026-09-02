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

**Open vocabulary.** `scene_t` deliberately contains no fixed categorical vocabulary.
An earlier version enumerated eight biomes and eleven prop types, which meant every
generated world was the same small set of nouns re-skinned — a space station and a
Victorian parlour both had to describe themselves with "altar" and "crate", and each
biome mapped to one hardcoded scatter recipe, so every forest was byte-identical. The
model now authors the world's own vocabulary: each prop carries a free-text `label`
(from which its artwork is generated) and each scene an `environment` with a
description, ground cover, an explicit hex palette, and light/visibility/density
ratios that drive the actual render.

The single remaining enum is `form` (`tall`/`wide`/`small`/`humanoid`/`flat`), which is
not descriptive vocabulary but the renderer's only way to know how an object occupies
space before its artwork exists — it decides placeholder shape, collision, sizing, and
whether the object can be billboarded.

This trade costs enum-conformance checking, which was measuring conformance to a
template we deliberately removed. It costs nothing in the spatial-consistency metrics
below: those were always about identifiers, dangling references and coordinate bounds.

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

- **`persistence`**: `persistent` = the world is a durable object that mutates across
  turns via `scene_delta` (add/move/remove props, ambient shifts), with props carrying
  stable ids; `regenerated` = every turn rebuilds the scene from scratch (the original
  behaviour). This is what makes the 3D layer causally load-bearing rather than
  decorative: under `persistent`, the spatial layout is the substrate the player's
  action resolves against, and objects stay where the player left them.

Orthogonally to persistence, every turn also emits `agent_actions` — a short queue
(`walk_to` / `look_at` / `interact` / `say` / `wait`, targeting props by id) that the
avatar performs before control returns. These are emitted in **both** persistence modes
deliberately: confining them to `persistent` would confound the persistence axis with
the presence of embodied action, making a result attributable to neither.

This gives a 2×2×2×2 design (personalization × evolving × persistence × engine) for the
eventual ablation table, with the template engine as the non-LLM floor.

### Spatial consistency: a failure mode unique to this setting

Persistence introduces failure modes that linear text generation cannot exhibit, and
which are cheap to detect structurally (no judge call required). `validateDeltaTurn()`
in `shared/worldState.js` counts, per turn, on the model's **first, unrepaired** output:

- **dangling references** — a delta or agent action naming a prop id that doesn't exist
- **duplicate ids** — the same identity minted twice for different objects
- **out-of-bounds** — a prop moved off the walkable plane

These are logged per-turn as `spatial` in `generations.jsonl`. This is the spatial
analogue of ConStory-Bench's contradiction detection (see `literature-review.md` §2.5),
in a setting none of the nearest neighbours occupy — and it's the concrete form of the
novelty claim that doc's §5 identifies as the sharpest available.

An early observation worth confirming at scale: explicitly injecting the current prop
inventory into each prompt (ids, types, positions, labels) appears to largely eliminate
dangling references. Before that injection existed, the model referenced props from an
entirely different session's world. That prompt-design choice is therefore itself an
ablatable variable, and a plausible small finding.

Note on repair vs. measurement: a dangling agent-action reference is repaired (the
offending action is dropped) rather than failing the turn, since the surrounding
narrative is usually fine and a hard failure hands the player a 502 over a cosmetic
fault. The spatial counters are recorded *before* repair, so measurement reflects the
model's unaided output while the player still gets a playable turn.

## Relation to prior work surveyed this summer

*This section covers the personalization-focused papers surveyed by the team over the summer.
For a broader, actively-researched literature review — neural world models (Genie/GameNGen),
one-shot LLM 3D/2D world synthesis (WorldGen, Word2World), LLM-driven interactive fiction with
tracked game state (STORY2GAME, G-KMS), consistency-bug evaluation (ConStory-Bench), a direct
positioning table against the nearest neighbors, an honest gap analysis of this repo's own
implementation, and venue guidance for a publication target — see
[`docs/literature-review.md`](literature-review.md). Short version: no existing system combines
personalization + turn-by-turn choice-driven evolution + real rendered 3D + a formal
ablation/LLM-judge evaluation harness the way this project does, but several neighbors do
individual pieces of it more rigorously than this project currently does (see that doc's §4)
— NeurIPS/ICML main track is likely a weaker fit than originally assumed below; see that doc's
§6 for why.*

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
  placement bounds compliance, choice-count compliance (the shape is forced by the
  Anthropic tool schema in `shared/worldState.js`, but the model doesn't always honor
  array-length/enum bounds in practice, so it's worth reporting as a reliability metric
  across ablations — see `eval/score.mjs`).
- **Personalization signal**: does `scene_t`/`narrative_t` text reference the stated
  interests/profile terms (simple keyword/embedding-similarity check) — compare
  personalization on vs. off.
- **Continuity**: check whether turn `t` references entities/state introduced at
  turn `t-k` for `k>=2` (a callback rate) — compare evolving on vs. off.
  `k>=2` matters: the immediately preceding turn (`k=1`) reaches the model via the
  chosen choice's own text regardless of the evolving flag (`turnMessage` = `The
  player chose: "..."`), so crediting `k=1` overlap as "continuity" makes the
  memoryless baseline look falsely continuous — confirmed empirically the first time
  `eval/score.mjs` was run against real sessions. Even with `k>=2`, short sessions can
  still show some leakage into the memoryless condition, since the per-turn state
  summary + choice-text relay can carry a noun forward turn-by-turn without the model
  ever seeing full history; only longer sessions and/or an LLM-judge pass can cleanly
  separate that from genuine in-context recall.

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
  needed before the "AI 2D textures" half of the pipeline is real. Deliberately
  deferred: needs a provider decision (OpenAI/Stability/other) and an API key neither
  of which is available yet.
- Personalization is no longer purely static. Beyond stated interests, the
  personalization+evolving condition now asks the model to maintain
  `state_updates.inferred_preferences` — a running 0-1 weight vector inferred from
  the choices actually made (combat vs. dialogue vs. caution vs. exploration, etc.),
  fed back into the system prompt each turn (`prompts.js buildSystemPrompt`). This is
  still prompt-only (no retrieval, no trained per-user component — that part of the
  limitation stands), but it is at least adaptive now, not fixed at session start.
  Verified empirically: over a 4-turn test session where the player consistently
  chose dialogue/investigation options over combat, the model's own tracked weights
  moved accordingly turn to turn (dialogue 0.5→0.65, combat 0.2→0.1). Needed the
  requirement stated twice — once in the personalization framing, once again as a
  concrete bullet in the `emit_scene` constraints list — before the model reliably
  populated it; the first placement alone was silently ignored.
- Automatic metrics (`eval/score.mjs`) cover schema validity, personalization keyword
  hit rate, and a heuristic entity-callback rate for continuity — all crude proxies.
  Confirmed empirically to be an insufficient substitute for judgment, not just in
  theory: the callback metric showed *zero* difference between evolving on/off even
  on 6-turn sessions, but `eval/judge.mjs` (LLM-judge, blind pairwise comparison — see
  below) correctly and decisively preferred evolving=on, catching a real coherence
  break in the memoryless transcript (the antagonist's identity silently swapped
  partway through, plus a garbled character name) and an unresolved plot thread that
  the evolving condition actually paid off. Keyword/entity-overlap heuristics miss
  this kind of failure entirely — it's a plot/character-identity break, not a vocab
  difference. This is the strongest evidence so far that `evolving` matters, but it
  came from the judge, not the automatic metric.
- Non-LLM baseline implemented: `server/src/narrative/templateBaseline.js`, selected
  via `ablation.engine = "template"`. Fixed recipe (seeded RNG + canned sentence
  templates), no model call, no history — the floor the LLM conditions are compared
  against in `eval/score.mjs`'s per-condition table.
- LLM-judge implemented: `eval/judge.mjs <sessionIdA> <sessionIdB>` reconstructs two
  sessions' transcripts from the log and asks Claude to blind-judge them (personalization
  fit, narrative coherence, reactivity, overall), then reveals which ablation condition
  produced which transcript for interpretation.
- LLM-judge now also runs at scale: `eval/judge-batch.mjs` auto-pairs sessions sharing
  the same source text + player profile that differ in exactly one ablation axis
  (personalization/evolving/engine), judges every such pair, and aggregates win rates
  per axis to `eval/out/judge-batch-summary.json`. Sample size so far is small (this
  is dev-test data, not a real study — n=1 per axis in the first run) and each pair is
  judged once in a fixed A/B order with no position-swap control for judge
  position-bias; worth adding once sample size justifies doubling the judge-call cost.
  The mechanism itself is verified working end to end.
