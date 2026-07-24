# Token efficiency and evaluation

Version 1.2 reduces recurring model context by compiling the smallest safe packet for each autonomous phase. It does not install a compression skill or ask the model to summarize framework state on every turn.

## Design

- **Compile, do not accumulate.** The controller selects only the task, phase references, tools, and evidence needed by the worker, repairer, or reviewer. Durable history and receipts remain on disk and outside normal prompts.
- **Remove only proven duplication.** A deterministic compiler removes an exact allowlist of controller policies already enforced elsewhere. It processes only `.project/` references, preserves fenced content and internal spacing, and leaves application files untouched.
- **Avoid implicit project reloads.** Autonomous OpenCode phases start from a sterile discovery directory. Project `AGENTS.md` remains useful for manual sessions but is not paid for again in every fresh phase.
- **Use the first sufficient implementation.** After tracing the affected flow and callers, workers prefer no change, existing project code, language or platform features, installed dependencies, then minimal new code. Correctness, validation, security, data safety, accessibility, readability, and required tests remain mandatory.
- **Return contracts, not narration.** The controller derives task identity, attempt, and changed paths. A phase submits one concise typed result; scripts and the TUI report progress without model-written status updates.
- **Compile commit intent once.** Optional per-task Conventional Commit prefixes live in protected controller configuration and never enter worker prompts or trigger runtime classification.
- **Measure without steering acceptance.** Receipts can retain validated provider-reported input, output, reasoning, cache, and cost data when OpenCode supplies it. Telemetry never decides whether work passes.

## Fixed-context measurement

The regression test scaffolds a fresh project, renders the pinned insurance blueprint fixture, and measures UTF-8 bytes of framework-owned fixed context for task `M001`. The v1.1 baseline includes each phase role body, static packet, and project `AGENTS.md` as it was then loaded. The v1.2 measurement includes each compact role body and compiled static packet; the sterile phase directory contributes zero project-`AGENTS.md` bytes.

| Phase | v1.1 bytes | v1.2 bytes | Reduction |
|---|---:|---:|---:|
| Execute | 10,426 | 5,455 | 47.7% |
| Repair | 10,053 | 5,162 | 48.7% |
| Review | 7,437 | 3,051 | 59.0% |
| **Total** | **27,916** | **13,668** | **51.0%** |

That is 14,248 fewer fixed prompt bytes across the three phases. The test also verifies that protected content survives compilation, application text is unchanged, compiled references never grow, and projected packets stay inside the configured 10 KiB context cap. See the [test](../tests/token-efficiency.test.mjs) and frozen [v1.1 baseline](../tests/fixtures/token-footprint-v1.1.json).

## Honest caveats

- **51.0% is a byte reduction, not a billed-token claim.** Tokenizers, prompt caching, models, and providers differ.
- The measurement covers framework-owned fixed context for one generated fixture and task. It excludes dynamic application reads, user content, tool catalogs and results, model reasoning and output, retries, and blueprint interviews.
- Real savings vary with task context and model behavior. Provider usage receipts and controlled same-task comparisons are the appropriate end-to-end evidence.
- The measurement does not prove equal implementation quality. v1.2 keeps the same deterministic gates, independent review, security boundaries, and acceptance requirements, but broader quality claims require separate task benchmarks.
- Upstream benchmark figures belong to their authors and are not Control Plane results. Caveman documents that a full recurring skill prompt can become net-negative on terse workloads. Ponytail documents one-model, small-sample, nondeterministic, and safety-test limitations.

## Inspiration and attribution

The design takes two narrow ideas from popular open-source projects and adapts them to a deterministic controller:

- [Caveman](https://github.com/JuliusBrussee/caveman), by Julius Brussee: concise result prose, preservation of exact technical content, and honest whole-workload measurement. See its [core rules](https://github.com/JuliusBrussee/caveman/blob/main/skills/caveman/SKILL.md), [honest numbers](https://github.com/JuliusBrussee/caveman/blob/main/docs/HONEST-NUMBERS.md), and [MIT license](https://github.com/JuliusBrussee/caveman/blob/main/LICENSE).
- [Ponytail](https://github.com/DietrichGebert/ponytail), by Dietrich Gebert: understand the real flow first, then stop at the first sufficient solution without removing safety. See its [core rules](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md), [agentic benchmark and limitations](https://github.com/DietrichGebert/ponytail/blob/main/benchmarks/results/2026-06-18-agentic.md), and [MIT license](https://github.com/DietrichGebert/ponytail/blob/main/LICENSE).

No Caveman or Ponytail code, skills, prompts, plugins, or dependencies are bundled. Their ideas are independently paraphrased and implemented within OpenCode Control Plane's existing scripts and phase contracts.

## v1.5 evaluation baseline

Version 1.5 adds the missing end-to-end measurement layer without adding context to normal projects. Its seven dependency-free cases cover greenfield work, a feature, a bug, a fake-transport integration, implementation of the finalized insurance Blueprint v2 migration, interruption recovery, and failed verification with repair.

Each live profile runs the same finalized task and held-out gate through:

- one bounded Direct OpenCode pass;
- a minimal loop of fresh OpenCode sessions plus deterministic gate feedback;
- the full Control Plane lifecycle with repair, independent review, receipts, and recovery.

The evaluator records input, output, reasoning, cache-read, cache-write, and provider-reported cost separately. Provider accounting can overlap these dimensions, so it deliberately reports no synthetic "total tokens" or subscription-percentage conversion. Missing or malformed telemetry is unavailable or invalid, never zero, and cannot enter an efficiency comparison.

It also records attempts, repairs, reviews, elapsed time, gate failures, false completion, unexpected files, dependency additions, and common final acceptance. Failures remain visible instead of disappearing into an average.

Evaluation state and candidate repositories live under an evaluator-owned operating-system temporary directory. Simulation uses no model and is part of release regression testing. Live trials require an explicit profile and spend confirmation; setup, upgrade, the dashboard, and normal project workers never start them. Live trials can still consume the same provider quota and CPU as personal work, and local policy controls are not container or VM isolation.

No live benchmark result is bundled with v1.5. Until repeated controlled trials are published, the project makes no new claim about end-to-end token savings or unchanged quality.
