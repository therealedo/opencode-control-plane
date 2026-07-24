# OpenCode Control Plane Roadmap

This roadmap turns the July 2026 ecosystem review into an ordered development direction. It is intentionally conservative: preserve the parts that make Control Plane small and dependable, measure real outcomes before optimizing further, and add complexity only when project evidence justifies it.

## North star

OpenCode Control Plane should be a lean, terminal-native, deterministic lifecycle supervisor for OpenCode. It should run fresh, policy-bounded workers, verify their output, preserve evolving project intent, recover safely, and keep the orchestration layer free of model calls.

OpenCode remains the coding worker. Control Plane owns the lifecycle around it, not the coding-agent runtime itself.

## Product boundaries

Control Plane will continue to own:

- blueprint initialization, versioning, comparison, and safe evolution;
- deterministic task selection and context compilation;
- fresh implementation, repair, and review phases;
- fixed verification gates, Git transitions, recovery, and rollback evidence;
- the terminal fleet dashboard and safe framework upgrades;
- bounded credentials, tools, paths, outputs, and human approval boundaries.

Control Plane will not become:

- a general-purpose or multi-provider agent framework;
- a model-powered manager-agent hierarchy;
- a replacement for OpenCode's tools, sessions, providers, editor, or MCP support;
- a cloud service, browser dashboard, Slack bot, or hosted development platform;
- a database-backed issue tracker or generic workflow language;
- a parallel-agent system by default.

## Architecture boundary

The system should retain three clearly separated layers:

1. **Product contract:** versioned blueprints, decisions, compatibility, migrations, and targeted change discovery.
2. **Deterministic control plane:** task state, context selection, policies, gates, receipts, recovery, upgrades, and TUI. This layer makes no model calls.
3. **OpenCode worker plane:** fresh implementation, repair, or review sessions receiving only the context and capabilities needed for one bounded phase.

Blueprint and migration history belong to the cold planning path. They must not be repeatedly loaded into the autonomous execution path.

## Current baseline: v1.4

Version 1.4 already provides:

- modular, evolving blueprints;
- deterministic scaffolding and upgrades;
- fresh OpenCode sessions for bounded phases;
- selected and byte-bounded context packets;
- fixed tests and independent review;
- durable Git, state, receipt, and recovery evidence;
- a global terminal dashboard;
- measured reduction of framework-owned fixed prompt bytes.
- a pre-launch checkpoint and token-free dashboard control for provider reasoning variants;
- automatic upgrade of an older in-progress initialization scaffold before its first worker starts.
- a visible arrow-selectable global action menu while retaining direct keyboard shortcuts;
- a dependency-free, live folder-suggestion picker for adding initialized projects without memorizing paths;
- stricter skill wording that reserves human stops for genuinely human-resolvable boundaries.

The current measurement is a regression guard, not proof of end-to-end token savings or unchanged implementation quality. The next release must address that evidence gap before pursuing more prompt compression.

## Milestone 1: Evidence and truthful boundaries

**Goal:** establish whether Control Plane improves total efficiency without reducing quality.

Planned outcomes:

- Create a repeatable evaluation corpus covering greenfield work, feature changes, bug repair, integration changes, blueprint migration, interruption recovery, and failed verification.
- Compare direct OpenCode, a minimal Ralph-style fresh-session loop, and Control Plane on equivalent tasks.
- Measure total input, cache, reasoning, and output tokens per accepted task—not prompt bytes alone.
- Record retries, repair frequency, elapsed time, unnecessary code or dependencies, false completion, gate results, and final acceptance quality.
- Separate model/provider variability from framework-owned measurements.
- Define an application-level **policy boundary** accurately in user-facing language; do not imply operating-system isolation.
- Preserve the existing independent reviewer and safety gates while gathering the baseline.

Exit criteria:

- The same evaluation can be rerun with another supported model.
- Results identify where tokens are actually spent across implementation, repair, review, and tool use.
- Quality and recovery failures are visible rather than averaged away.
- Product descriptions consistently distinguish policy-bounded execution from real container or VM isolation.

## Milestone 2: Operational configuration

**Goal:** let projects change models and operating policy safely without changing product intent.

**Status:** in progress. Version 1.3 shipped the first vertical slice:

- initialization now stops at an explicit ready checkpoint before the first worker;
- the terminal dashboard changes provider reasoning variants without a model call or blueprint revision;
- the selected variant is injected into every fresh isolated worker phase;
- an interview started on v1.2 upgrades its finalized scaffold automatically and preserves all answers before pausing;
- the runtime setting is project-local, ignored by Git, disabled while a worker is live, and reversible to the provider default.

Remaining outcomes:

- Move model selection, cost limits, and the remaining runtime choices out of the product contract.
- Keep a project default while allowing safe global or phase-specific overrides.
- Allow model changes from the terminal dashboard at a maintenance boundary.
- Do not create a new blueprint version merely because a model changed.
- Validate model availability and OpenCode compatibility before activation.
- Preserve the previous runtime profile for immediate rollback.
- Establish and test a minimum supported OpenCode version and capability contract.

Exit criteria:

- A project can switch to a better model midway through development without reinitialization or blueprint migration.
- A failed runtime change leaves the previous working configuration active.
- Product architecture decisions remain distinct from execution preferences.

## Milestone 3: Risk-aware token efficiency

**Goal:** spend model tokens in proportion to task risk while keeping deterministic checks mandatory.

Planned outcomes:

- Assign a deterministic risk class using affected paths, task type, credentials, migrations, architecture, data, security, and deployment impact.
- Measure the value and cost of independent review for each risk class.
- Keep independent review as the default until evaluation demonstrates an equal-quality lower-cost policy for a specific class.
- Never remove required tests, security checks, migration checks, or destructive-action approval to save tokens.
- Prefer OpenCode's existing search and language intelligence before building or bundling a repository index.
- Continue returning compact typed contracts while leaving full evidence in bounded artifacts.

Possible policy, enabled only after evidence supports it:

- metadata-only work: deterministic validation;
- proven low-risk work: deterministic gates plus the least expensive review policy that preserves results;
- normal features: implementation and independent review;
- security, data, infrastructure, architecture, or migration work: stronger review and rollback requirements.

Exit criteria:

- End-to-end tokens per accepted task decrease on the evaluation corpus.
- Acceptance quality, recovery success, and safety results do not regress.
- Any reduced-review policy is narrow, reversible, and disabled automatically outside its proven risk class.

## Milestone 4: Existing-project adoption

**Goal:** bring an established repository under Control Plane without forcing a greenfield questionnaire or rewriting its history.

Planned outcomes:

- Inspect existing structure, tests, integrations, and architecture using bounded reads.
- Ask only for consequential facts that cannot be recovered from the repository.
- Create an initial blueprint and project memory representing the system as it exists.
- Preserve application files and accepted Git history byte-for-byte during planning.
- Require comparison, approval, and rollback for generated control files.
- Begin autonomous work only after readiness and safety boundaries are explicit.

Exit criteria:

- An existing project can be adopted without destructive regeneration.
- The resulting blueprint distinguishes observed facts, user-confirmed intent, and unresolved unknowns.
- Adoption is materially shorter than new-project discovery.

## Milestone 5: Optional real isolation

**Goal:** provide a stronger execution boundary for untrusted toolchains without burdening the default local workflow.

Planned outcomes:

- Define one narrow controller-owned execution-backend contract.
- Retain the fast local policy-bounded backend as the default.
- Evaluate an optional container or VM backend for commands, package scripts, browsers, and native binaries.
- Keep secrets scoped to the selected phase and isolation environment.
- Preserve inspectable logs, Git rollback, and deterministic gates across backends.
- Avoid exposing isolation machinery to model prompts unless a worker must interact with it.

Exit criteria:

- Documentation states exactly which threats each backend does and does not contain.
- Projects that do not need OS isolation gain no mandatory services, daemons, databases, or model context.
- A failed or unavailable optional backend cannot silently fall back to weaker isolation.

## Conditional future work

The following work is not committed. It should begin only when measurements demonstrate a concrete need.

### Official OpenCode SDK integration

Keep the current fresh-process execution while it remains simple and reliable. Consider the official SDK or server event stream only if it materially improves structured output, cancellation, compatibility, or live status without weakening phase isolation or requiring a persistent daemon.

### Parallel tasks and worktrees

Consider limited parallelism only when sequential task execution is a measured bottleneck. Require independent tasks, isolated worktrees, bounded concurrency, deterministic merge gates, and clear conflict recovery. Cross-project concurrency is preferable to multiple agents editing one project.

### Richer task dependencies

Extend the existing queue only if real projects cannot safely express their dependency graph. Do not add Beads, Dolt, or another database merely for potential scale.

### Additional worker runtimes

Remain OpenCode-only. Preserve a clean internal execution boundary, but do not build or advertise a generic runtime adapter unless OpenCode can no longer meet a demonstrated requirement.

## Release and compatibility policy

Every roadmap release must:

- keep global and project upgrades available through one terminal action;
- reach a maintenance boundary before replacing managed framework files;
- preserve application code, project-owned configuration, blueprints, receipts, credentials, and history;
- stop on managed-file drift instead of overwriting it;
- create a reversible Git commit for project framework changes;
- validate clean installation, upgrade from every supported release, interruption recovery, and rollback;
- document any changed boundary in beginner-facing language.

## Decision rules

Before accepting a new feature, ask:

1. Does it belong to product intent, deterministic lifecycle control, or OpenCode's worker runtime?
2. Can a script or existing OpenCode capability perform it without another model call?
3. Does measured project evidence justify its complexity and recurring context cost?
4. Can it remain optional without weakening safety or compatibility?
5. Can an upgrade introduce and roll it back without manual project migration?

If the answer is unclear, do not add the feature yet.

## Research references

- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [Ralph](https://github.com/snarktank/ralph)
- [Gas City](https://github.com/gastownhall/gascity) and [Beads](https://github.com/gastownhall/beads)
- [Open SWE](https://github.com/langchain-ai/open-swe)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [Plandex](https://github.com/plandex-ai/plandex)
- [Aider](https://github.com/Aider-AI/aider)
- [Goose](https://github.com/aaif-goose/goose)
- [Roo Code orchestration](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- [Container Use](https://github.com/dagger/container-use)
