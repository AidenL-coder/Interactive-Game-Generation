# Literature Review & Novelty Analysis

Compiled 2026-08-16 via live web search (arXiv, ACL Anthology, AIIDE/CHI proceedings, DeepMind
blog) — not from training-data recall alone, since publishability depends on knowing what
actually exists *now*, not what existed as of any model's knowledge cutoff. Organized by
cluster, then a direct positioning section, then an honest gap analysis of this repo's own
implementation, then venue guidance. Citations are arXiv IDs / DOIs where available; check
before submission, since several of these are very recent (early 2026) and may have moved from
preprint to a venue by the time this is written up.

## 1. What this project actually claims

`docs/research.md`'s formulation: `ŷ_t ~ p_θ(y_t | x_0, P_u, H_{t-1})` — a structured
`(narrative_t, scene_t, choices_t)` object, generated turn-by-turn, conditioned on seed source
text `x_0`, an explicit + inferred user profile `P_u`, and accumulated interaction history
`H_{t-1}`, deterministically rendered to a walkable 3D scene. Ablatable on three independent
axes: `personalization`, `evolving` (memory), `engine` (LLM vs. non-LLM baseline). The question
this review answers: **does this combination already exist, and if not, what's the sharpest way
to claim the gap?**

## 2. Related work by cluster

### 2.1 Neural (pixel-level) interactive world models

These generate *frames* directly — no structured intermediate representation, no renderer.

- **Genie / Genie 2 / Genie 3** (DeepMind) — autoregressive latent-diffusion foundation world
  models; from a single image or text prompt, generate a playable, action-controllable
  environment. Genie 2 worlds stay consistent for ~10–60s. [genie (wikipedia)](https://en.wikipedia.org/wiki/Genie_(world_model)),
  [Genie 2 blog](https://deepmind.google/blog/genie-2-a-large-scale-foundation-world-model/),
  [Genie 3 blog](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/)
- **GameNGen** — real-time DOOM gameplay generated frame-by-frame via diffusion.
- **AlayaWorld** — long-horizon, playable video world generation.
  [arXiv:2607.06291](https://arxiv.org/pdf/2607.06291)
- **ProPlay** — procedural world models for self-evolving LLM agents (environment knowledge as
  a procedure graph, not raw pixels — a hybrid point worth noting).
  [arXiv:2606.12780](https://arxiv.org/html/2606.12780v1)
- Benchmarks for this cluster: **WorldRoamBench/WorldOdysseyBench** (action-following, visual
  drift, physics, and — notably — a *memory* dimension via 3D point-cloud reconstruction + VLM
  reasoning) and **PlayWorld** (long-horizon objectives with agent players).
  [arXiv:2606.31672](https://arxiv.org/pdf/2606.31672), [PlayWorld](https://huggingface.co/papers/2608.13552)

**Relation to this project**: different substrate entirely — pixels vs. structured JSON. But
the *motivation* is a direct parallel: WorldRoamBench exists because pixel-level world models
have a proven, measurable long-horizon consistency problem. This project's own eval
(`eval/score.mjs`, `eval/judge.mjs`) is the analogous instrument for the structured-output
paradigm — nobody has built that instrument for *this* substrate yet (see §4).

### 2.2 One-shot LLM-driven world synthesis (visual, not turn-by-turn)

- **WorldGen: Text-to-3D World Synthesis** — LLM parses a prompt into a structured JSON spec
  (terrain + object layout) → navmesh-conditioned diffusion mesh generation → automated part
  decomposition → per-object texture refinement. Explicitly mentions "persistent, personalized
  metaverse spaces" as an application, but per direct inspection of the pipeline: **one-shot**
  (prompt → complete world), no player-profile personalization mechanism, no turn-by-turn
  evolution based on interaction. [arXiv:2511.16825](https://www.emergentmind.com/papers/2511.16825)
- **WorldCraft** — LLM agents for photo-realistic 3D world creation/customization via natural
  language, with per-object attribute control. [arXiv:2502.15601](https://arxiv.org/html/2502.15601v2)
- **Word2World** — LLM narrative decomposition (characters/locations/objectives) matched
  against a fixed tile/asset library to build a 2D playable world; 90% playable-level success
  rate; includes an ablation study on coherence. No personalization, one-shot per world.
  [arXiv:2405.06686](https://arxiv.org/abs/2405.06686)
- **Narrative-to-Scene Generation** (AIIDE workshop 2025) — LLM-driven pipeline, narrative text
  → structured intermediate representation → 2D tilemap scene. Per direct inspection: no
  personalization, no player-choice-driven evolution — each scene generated independently.
  [arXiv:2509.04481](https://arxiv.org/pdf/2509.04481)
- **LLMR** (CHI 2024) — real-time natural-language prompting/modification of interactive 3D
  scenes; includes a technical ablation study. Closer in spirit (real-time, interactive edits)
  but not narrative/choice-driven and not personalized to a profile.
  [ACM DL](https://dl.acm.org/doi/10.1145/3613904.3642579)
- **CityGenAgent** — procedural 3D city generation via LLM agent. [arXiv:2602.05362](https://arxiv.org/pdf/2602.05362)

**Relation to this project**: this cluster solves *visual* world generation (the graphics gap
this project explicitly defers — see the earlier "better graphics" discussion). None of them
close the loop on player choices changing the world turn-by-turn, and none personalize to a
stated+inferred user profile. WorldGen in particular is the natural future integration point
if/when this project adds real mesh/texture generation — cite it as the target architecture for
that gap, not a competitor.

### 2.3 LLM-driven interactive fiction / tracked game state

- **STORY2GAME** (2025) — the closest single competitor to this project's core narrative loop.
  Generates a story, then generates LLM-derived *preconditions and effects* for actions,
  building executable game-engine code from them; supports dynamically generating brand-new
  actions when a player wants to do something outside the pre-generated set, with on-the-fly
  state-representation updates. Text-only (no visual rendering), no player-profile
  personalization. Mechanically **more rigorous than this project's own state tracking** — this
  project's `state_updates` is free-form/advisory, not preconditions/effects with enforcement.
  [arXiv:2505.03547](https://arxiv.org/abs/2505.03547)
- **Game Knowledge Management System (G-KMS)** — schema-governed LLM pipeline for RPG
  narrative generation with *normalization-based repair* for structurally invalid output,
  engine-aligned knowledge admission, evaluated with engine-level playability probes + a human
  player study. Directly on-point for the schema-validity bug this project found and fixed
  (`validateWorldState` + retry in `generateScene.js`) — G-KMS's repair-via-normalization is a
  more sophisticated fix than this project's "just retry from scratch."
  [MDPI](https://www.mdpi.com/2079-8954/14/2/175)
- **Multiverse of Greatness** (DCP/P — Dynamic Context Prompting/Programming) — graph-based
  branching story generation with a *dynamically managed* context window, shown to beat
  fixed-summary conditioning. Directly relevant to this project's binary
  full-history-vs-one-line-summary design for the `evolving` ablation — DCP/P is a more
  sophisticated middle ground worth comparing against or adopting.
  [arXiv:2411.14672](https://arxiv.org/abs/2411.14672)
- **"From World-Gen to Quest-Line"** — dependency-driven prompt pipeline for coherent RPG
  generation. [arXiv:2604.25482](https://www.emergentmind.com/papers/2604.25482)
- **Elsewise** — authoring tool with possibility-space visualization for AI interactive
  narrative (human-authoring-assist framing, not autonomous generation).
  [arXiv:2601.15295](https://arxiv.org/pdf/2601.15295)
- **WHAT-IF** — branching narratives via meta-prompting. [arXiv:2412.10582](https://arxiv.org/pdf/2412.10582)
- **NarrativePlay** — interactive narrative understanding (player interacts with characters in
  an existing story world). [arXiv:2310.01459](https://arxiv.org/pdf/2310.01459)

**Relation to this project**: this is the cluster to position against most directly. STORY2GAME
owns "generate an interactive fiction game with tracked state from a story" but is text-only
and non-personalized. G-KMS owns "robust structured LLM output for game engines" more
rigorously than this project currently does. Multiverse of Greatness owns "smarter-than-binary
context management." None combine these with personalization, 3D rendering, and a formal
ablation+judge evaluation harness the way this project does — but each individually is doing
one piece of this project's puzzle *better* than this project currently does it (see §4).

### 2.4 Personalized text/story generation (non-interactive)

- **"Personalized Generation In Large Model Era: A Survey"** (ACL 2025 main, long paper) —
  broad taxonomy of personalized generation (PGen) across modalities/contexts/tasks; the right
  paper to cite for grounding the general personalization framing.
  [ACL Anthology](https://aclanthology.org/2025.acl-long.1201/), [arXiv:2503.02614](https://arxiv.org/abs/2503.02614)
- **PREFINE** (AAAI 2026 Student Abstract, Oral) — personalizes story generation via a
  simulated pseudo-user critic + user-specific rubric generation + critique-and-refine loop,
  *without* fine-tuning or explicit feedback. Evaluated on PerDOC/PerMPST. Not interactive, not
  game-like — single-shot personalized story per user. A genuinely different mechanism from
  this project's in-context stated+inferred-preferences approach, and one this project could
  adopt a lightweight version of (a critique pass) to strengthen personalization quality.
  [arXiv:2510.21721](https://arxiv.org/abs/2510.21721)
- **Style-personalized text generation evaluation survey** — first critical evaluation of SPTG
  metrics; finds LLM-as-judge (GPT-4.1-class) outperforms other automatic metrics but ensembles
  beat any single metric. Relevant to justifying/critiquing this project's own
  personalization-hit-rate keyword metric as a weak proxy.
  [arXiv:2508.06374](https://arxiv.org/html/2508.06374)
- Already cited in `docs/research.md`: LaMP/LongLaMP (retrieval over user history), P-RLHF
  (per-user lightweight model), Wu et al. (incremental persona inference from revealed
  messages) — this project's new `inferred_preferences` mechanism is a lightweight, prompt-only
  version of exactly what Wu et al. and PREFINE do more rigorously.

### 2.5 Consistency/coherence evaluation for long-form and interactive generation

- **"Lost in Stories: Consistency Bugs in Long Story Generation by LLMs"** (ACL Findings 2026)
  — directly validates and generalizes this project's own empirical finding. Introduces
  **ConStory-Bench** (2,000 prompts, 4 task scenarios) and **ConStory-Checker** (automated,
  evidence-grounded contradiction detection), with a taxonomy of 5 error categories / 19
  subtypes. Finds errors cluster in factual/temporal dimensions, appear mid-narrative, and
  correlate with higher token-level entropy. This is close kin to — and considerably more
  rigorous than — the coherence break this project's `eval/judge.mjs` caught (an antagonist
  identity swap + garbled name in the memoryless condition) that the crude entity-overlap
  callback metric in `eval/score.mjs` completely missed. **Crucially, ConStory-Bench studies
  linear long-form generation, not interactive, choice-branching, personalized generation** —
  that combination appears to be open (see §5).
  [arXiv:2603.05890](https://arxiv.org/abs/2603.05890v1), [ACL Findings](https://aclanthology.org/2026.findings-acl.410.pdf)

### 2.6 LLM-as-judge methodology

- **Multi-Agent LLM Judge** — automatic personalized judge *design* for NLG evaluation.
  [arXiv:2504.02867](https://arxiv.org/pdf/2504.02867)
- **Persona-judge** — personalized alignment via token-level self-judgment.
  [arXiv:2504.12663](https://arxiv.org/pdf/2504.12663)
- **Judge Reliability Harness** — stress-tests LLM-judge reliability; directly relevant to this
  project's known, self-flagged gap (`eval/judge.mjs`/`judge-batch.mjs` run each pair once, in a
  fixed A/B order, with no position-bias control).
  [arXiv:2603.05399](https://arxiv.org/pdf/2603.05399)

### 2.7 Procedural content generation (PCG), classical and LLM-integrated

- Already cited in `docs/research.md`: the 2010 Mario player-experience-model PCG paper
  (Zixuan's slide), "Game Generation via Large Language Models."
- **"Procedural Content Generation in Games: A Survey with Insights on Emerging LLM
  Integration"** — the current state-of-the-field survey; frames LLM-PCG barriers as domain
  complexity, data scarcity, performance. [ResearchGate](https://www.researchgate.net/publication/385888613)
- **PCGRLLM** — LLM-driven *reward design* for PCG-via-reinforcement-learning.
  [arXiv:2502.10906](https://arxiv.org/pdf/2502.10906)
- **The Procedural Content Generation Benchmark** — open-source testbed for generative
  challenges in games; a template for how this project's `eval/` could be packaged as a
  reusable benchmark rather than a one-off script. [arXiv:2503.21474](https://arxiv.org/pdf/2503.21474)
- **Agentic PCG** — tool-using LLMs for PCG (directly analogous to this project's forced
  tool-call architecture). [project page](https://zehua-jiang.github.io/AgenticPCG/)

## 3. Positioning: the gap this project occupies

| System | Personalized to a profile | Turn-by-turn, choice-driven evolution | Real rendered visual world | Formal ablation + dual eval (automatic + LLM-judge) |
|---|---|---|---|---|
| Genie/Genie 2/Genie 3, GameNGen, AlayaWorld | No | Frame-by-frame, not choice/narrative-structured | Yes (pixels) | Benchmarked (WorldRoamBench) but not personalization-ablated |
| WorldGen, WorldCraft, Word2World, Narrative-to-Scene | No | No (one-shot) | Yes | Partial (some have coherence ablations, not personalization) |
| STORY2GAME | No | Yes (tracked state, dynamic actions) | No (text-only) | Success-rate eval only |
| G-KMS | No | Partial (RPG session) | 2D (Unity) | System-level + human playability study |
| Multiverse of Greatness | No | Yes (branching, dynamic context) | No (text) | Objective + bias analysis |
| PREFINE | Yes (rubric/critique) | No (single story) | No | Automatic + human, PerDOC/PerMPST |
| **This project** | **Yes (stated + inferred, in-context)** | **Yes (full history or memoryless baseline)** | **Yes (three.js, deterministic render from structured output)** | **Yes (2×2×3 ablation, automatic metrics + blind pairwise + batch LLM-judge)** |

No system found combines all four columns. The nearest neighbors each own one or two columns
more rigorously than this project does — that's the honest framing, not "nothing like this
exists." The genuinely defensible, specific claim is:

> **A structured-output/deterministic-render architecture for turn-by-turn, choice-driven
> interactive world generation, personalized via an explicit + adaptively-inferred user
> profile, evaluated with a combined automatic-metric and blind-LLM-judge harness across a
> formal ablation design (personalization × memory × generation engine).**

## 4. Honest gaps in *this repo's* current implementation vs. state of the art

A reviewer familiar with §2 would raise these — better to name them first:

1. **Weaker game-state modeling than STORY2GAME.** This project's `state_updates` is free-form
   and advisory (the model can just... not include it, as happened until the prompt was
   strengthened — see the `inferred_preferences` debugging in this session). STORY2GAME's
   precondition/effect modeling with dynamic action generation is a more principled mechanism
   for "did the world actually react to the choice."
2. **Weaker consistency measurement than ConStory-Bench.** `eval/score.mjs`'s callback metric is
   a crude entity-overlap heuristic that this session's own testing showed can't detect real
   coherence breaks (the antagonist-identity swap the LLM-judge caught). Adopting an
   evidence-grounded contradiction checker in the spirit of ConStory-Checker, *adapted to the
   choice-branching+personalized setting*, would both fix this weakness and is itself the
   sharpest available novelty angle (see §5).
3. **Weaker malformed-output handling than G-KMS.** This project retries from scratch on schema
   violation; G-KMS does normalization-based repair. Retry-from-scratch is simpler but wastes a
   full generation and doesn't guarantee the retry succeeds either.
4. **Small, dev-generated evaluation sample.** Every number reported this session (personalization
   hit rate, callback rate, judge win rates) comes from a handful of manually-triggered test
   sessions, not a real study. `eval/judge-batch.mjs`'s aggregate win rates are currently n=1
   per axis. This is explicitly flagged in `docs/research.md` already, but worth restating: a
   paper needs real scale here — dozens of sessions per condition minimum, ideally a small human
   study analogous to the Crystal Island 300/153-participant reference already in the docs.
5. **No position-bias control in the LLM-judge.** Each pair is judged once, fixed A/B order.
   Judge Reliability Harness (§2.6) is exactly the kind of check this needs before any judge
   win-rate numbers go in a paper.
6. **Visual fidelity is far below every visual-generation system in §2.1–2.2.** Procedural
   canvas textures + primitive three.js geometry vs. Genie-class pixel generation or
   WorldGen-class mesh synthesis. This project isn't competing on visual quality and shouldn't
   claim to — it should be explicit that the contribution is the personalization/evolution/eval
   architecture, not graphics.

## 5. Where the sharpest novelty claim actually is

Given §3–4, the strongest, most specific, most defensible contribution is **not** "we generate
3D worlds with an LLM" (crowded, and this project is behind on visual quality) and **not**
"we personalize story generation" (crowded, PREFINE/Wu et al./P-RLHF do this more rigorously
for non-interactive text). It's the intersection **plus** the evaluation methodology:

- **Extend consistency-bug analysis (ConStory-Bench-style: taxonomy + evidence-grounded
  automated checking) to the interactive, choice-branching, personalized setting**, and show —
  as this session's ad-hoc testing already suggests — that keyword/entity-overlap heuristics
  systematically under-detect real failures there, the same way this project's own callback
  metric did. This is a concrete, buildable, citable contribution: nobody found in this search
  has done ConStory-Bench-style analysis specifically for *interactive* generation, where the
  failure mode is compounded by the model also having to track "what the player already knows/
  did" across branches, not just narrative facts in a single linear stream.
- **The 2×2×3 ablation design itself, run at real scale with the dual automatic+judge harness**,
  is a legitimate benchmark/methodology contribution if scaled up — this is exactly the kind of
  contribution the NeurIPS "Evaluations & Datasets" track (renamed for 2026, scope explicitly
  includes "interaction protocols," "experimental study designs") is designed for.
- Secondary, supporting claim: the `inferred_preferences` mechanism as a *lightweight,
  zero-training* alternative to Wu et al./P-RLHF-style persona inference, with a direct
  ablation against static stated-interests-only personalization — publishable as a smaller
  finding within the larger paper, not the headline.

## 6. Venue guidance

`docs/research.md` states the project is "targeting ICML/NeurIPS-style venues." Based on where
the actual nearest-neighbor papers in §2 landed, **NeurIPS/ICML main track is a weak fit** —
main track wants a core ML/algorithmic contribution (new architecture, new training method,
theory), and this project's contribution is a system + an evaluation methodology, not a new
learning algorithm. That mismatch is worth correcting now, not after a rejection.

Better-fit options, ranked by how well the closest neighbors above actually landed:

1. **NeurIPS Evaluations & Datasets track** (2026 renaming of Datasets & Benchmarks — scope now
   explicitly includes interaction protocols and experimental/qualitative study design). Best
   fit *if* the paper leads with the ablation+judge evaluation harness as the contribution, per
   §5. Still a NeurIPS venue, still a strong line for a CV, and honestly the right track for
   what this project is.
2. **AIIDE** (AAAI Conference on Artificial Intelligence and Interactive Digital Entertainment)
   or **FDG** (Foundations of Digital Games) — direct topical home; STORY2GAME, Word2World,
   Narrative-to-Scene Generation, G-KMS-adjacent work all sit here. Best fit if the paper leads
   with the system/architecture contribution instead.
3. **CHI** — if the personalization/interactivity angle is framed around player experience and
   authored as an HCI contribution (LLMR is the model to follow here); would need a real human
   study, not just automatic + LLM-judge metrics.
4. **ACL/EMNLP Findings** — plausible for the consistency-bug/evaluation angle specifically,
   following ConStory-Bench's own venue, if the 3D-rendering half is de-emphasized and the paper
   is framed as an NLP evaluation contribution.

**Recommendation**: pick one lead angle rather than trying to be a systems paper, an HCI paper,
and an NLP-eval paper simultaneously — that dilution is the single most common reason papers
like this get rejected on "unclear contribution" grounds. Given what's actually built so far
(the ablation harness and the judge pipeline are further along than the game-state modeling or
visual quality), **the Evaluations & Datasets track angle (§5, first bullet) is the strongest
starting point**, with AIIDE/FDG as the fallback if the evaluation contribution doesn't scale up
in time.

## 7. Concrete next steps toward a submittable paper

1. Run `eval/judge-batch.mjs` at real scale (tens of sessions per condition, not n=1) — this is
   pure engineering, already built, just needs volume.
2. Build a ConStory-Checker-style evidence-grounded consistency checker for this project's
   interactive/branching setting, replacing or supplementing the entity-overlap callback metric
   (§4.2, §5). This is the headline contribution if pursued.
3. Add judge position-bias control (run each pair both ways, require agreement or report
   disagreement rate) before any win-rate numbers are reported.
4. Decide the lead venue/angle (§6) before writing — it changes what needs to be true by
   submission time (a human study for CHI; scale + a real benchmark artifact for NeurIPS ED;
   stronger game-state modeling for AIIDE/FDG).
5. Cite §2 properly in `docs/research.md`'s "Relation to prior work" section — it currently only
   covers the personalization-paper cluster from earlier in the summer, not this broader survey.

## 8. Full reference list

- Genie / Genie 2 / Genie 3 (DeepMind): https://deepmind.google/research/publications/60474/, https://deepmind.google/blog/genie-2-a-large-scale-foundation-world-model/, https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/
- WorldRoamBench: https://arxiv.org/pdf/2606.31672
- PlayWorld: https://huggingface.co/papers/2608.13552
- AlayaWorld: https://arxiv.org/pdf/2607.06291
- ProPlay: https://arxiv.org/html/2606.12780v1
- WorldGen: https://www.emergentmind.com/papers/2511.16825
- WorldCraft: https://arxiv.org/html/2502.15601v2
- Word2World: https://arxiv.org/abs/2405.06686
- Narrative-to-Scene Generation: https://arxiv.org/pdf/2509.04481
- LLMR (CHI 2024): https://dl.acm.org/doi/10.1145/3613904.3642579
- CityGenAgent: https://arxiv.org/pdf/2602.05362
- STORY2GAME: https://arxiv.org/abs/2505.03547
- Game Knowledge Management System (G-KMS): https://www.mdpi.com/2079-8954/14/2/175
- Multiverse of Greatness (DCP/P): https://arxiv.org/abs/2411.14672
- From World-Gen to Quest-Line: https://www.emergentmind.com/papers/2604.25482
- Elsewise: https://arxiv.org/pdf/2601.15295
- WHAT-IF: https://arxiv.org/pdf/2412.10582
- NarrativePlay: https://arxiv.org/pdf/2310.01459
- Personalized Generation In Large Model Era: A Survey (ACL 2025): https://aclanthology.org/2025.acl-long.1201/
- PREFINE (AAAI 2026): https://arxiv.org/abs/2510.21721
- Style-personalized text generation evaluation survey: https://arxiv.org/html/2508.06374
- Lost in Stories / ConStory-Bench (ACL Findings 2026): https://arxiv.org/abs/2603.05890v1, https://aclanthology.org/2026.findings-acl.410.pdf
- Multi-Agent LLM Judge: https://arxiv.org/pdf/2504.02867
- Persona-judge: https://arxiv.org/pdf/2504.12663
- Judge Reliability Harness: https://arxiv.org/pdf/2603.05399
- PCG in Games survey w/ LLM integration: https://www.researchgate.net/publication/385888613
- PCGRLLM: https://arxiv.org/pdf/2502.10906
- The Procedural Content Generation Benchmark: https://arxiv.org/pdf/2503.21474
- Agentic PCG: https://zehua-jiang.github.io/AgenticPCG/
- NeurIPS Evaluations & Datasets track (2026 renaming): https://blog.neurips.cc/2026/03/23/introducing-the-evaluations-datasets-track-at-neurips-2026/
