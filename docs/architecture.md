# Architecture

This reference explains the machinery behind the beginner workflow. It is not loaded into worker prompts.

## Components

- `.project/` is the bounded, modular product model: brief, invariants, architecture, tooling, quality, roadmap, and task queue.
- `blueprints/` stores immutable versions plus `current/` and project memory.
- `.autopilot/bin/autopilot.mjs` is the deterministic controller.
- `.autopilot/bin/control-plane.mjs` is the zero-model per-project terminal dashboard. The global dashboard adds color-aware arrow-selectable fleet actions and a bounded, dependency-free folder picker; color falls back to plain text and neither feature invokes a model or executes candidate project code while browsing.
- The globally installed `control-plane` command is the zero-model fleet dashboard. It reads `~/.agents/opencode-control-plane/projects.json` and opens the selected project's local dashboard on demand.
- `.opencode/agents/` contains separate worker, repair, and reviewer roles.
- `.project/gates.json` maps approved test IDs to fixed argument arrays.
- `.project/receipts/` stores accepted task evidence without becoming prompt context.

## Autonomous loop

The controller validates a clean Git baseline, selects one ready task, compiles a byte-bounded context packet, and starts a fresh OpenCode process. The process receives only its role, task, permitted paths, selected context, exact tools, and credential profile.

Autonomous phases use a sterile OpenCode project directory. This prevents the manual/recovery `AGENTS.md` router and unrelated project discovery from being injected into every model call. Controller-owned bounded tools still bind explicitly to the real project root, so path, Git, credential, and gate enforcement is unchanged. This is fresh-process and application-policy separation, not operating-system containment.

The context compiler operates only on selected generated `.project/` references. It removes exact known controller boilerplate already present in the higher-authority role, collapses redundant blank space, and preserves fenced code blocks verbatim. It never rewrites project memory or application files.

The worker submits a typed candidate contract. The controller verifies changed paths and Git invariants, runs fixed gates, and starts a separate reviewer. Rejected work enters a fresh repair phase. Accepted work receives an application commit, metadata commit, and receipt before the next task is selected. A Blueprint schema-6 project can map each task ID to one validated Conventional Commit prefix; the controller reads that protected map without asking a model, while bookkeeping uses `chore(control-plane)`.

Each phase is a new OpenCode session. Long-session compaction remains a fallback, not the primary continuity mechanism. Durable JSON/Markdown contracts and Git commits carry state across sessions, crashes, and context limits.

## Maintenance boundary

The dashboard uses the guarded `maintenance` lifecycle verb. If a task is active, the request waits while that task reaches its accepted boundary. The controller then pauses before selecting another task, with `active_task` cleared and no completion/finalization journal. Blueprint evolution and framework upgrades require this state.

An ordinary pause may retain an active task, so it is not automatically safe for framework replacement.

## Token efficiency

- Scripts scaffold and render known structures.
- `AGENTS.md` is a small manual/recovery router and is absent from fresh phase discovery.
- Workers receive selected manifest bundles rather than every project file.
- Stable phase policy precedes task-specific packet data so compatible providers can reuse prompt prefixes.
- Reads, lists, searches, tool output, context packets, summaries, findings, and recovery evidence have narrow defaults and hard byte caps with explicit pagination.
- Repair evidence is projected by diagnostic priority into complete structured JSON; full raw evidence remains in artifacts.
- Implementation follows a reuse-first ladder: no change when none is needed, existing project code, native platform features, installed dependencies, then the minimum new code. Independent review rejects unjustified additions while preserving security, validation, accessibility, data safety, readability, and all acceptance checks.
- Receipts and archives remain durable but are excluded from prompt discovery.
- The dashboard, controller, validation, Git transitions, gates, and upgrades do not call a model.

OpenCode workers and interactive blueprint interviews still consume model tokens. Receipts retain provider-reported input, cache-read, output, reasoning, and cost data when available. Fixed packet-byte measurements are useful regression guards but are not equivalent to billed tokens; see [Token efficiency](token-efficiency.md).

## Evaluation boundary

The release evaluation harness belongs to this source repository, not to generated projects or normal worker context. It creates fresh candidates under its own operating-system temporary parent, copies one bundled seed into each candidate, runs an evaluator-owned held-out gate, records a bounded result, and removes only marker-owned safe work trees. It never accepts an existing project as a candidate, reads the global project registry, or calls installation, fleet update, or project registration code.

Simulation exercises the complete evaluator state/report path without OpenCode or network access. Live Direct, fresh-loop, and Control Plane trials are separate explicit operations. Their model/profile identity and provider usage stay attached to each result so results from different configurations are not silently pooled.

## Fleet dashboard

Successful initialization registers the canonical project root in one bounded atomic JSON file. The registry stores only an ID, display name, path, and timestamps. It never stores configuration, state copies, prompts, credentials, or environment values, and the dashboard never scans home directories or drives.

Fleet polling reads bounded state, queue, blueprint-record, ownership-manifest, sentinel, and controller-lock files directly. It does not execute registered project code. Selecting a project is an explicit boundary that opens that project's versioned local dashboard and controller actions.

While open, the fleet dashboard checks the fixed public GitHub release channel with a short timeout and six-hour cache. There is no background process. A confirmed fleet update installs the global release first, then updates registered projects sequentially at maintenance boundaries. Cross-project atomicity is impossible: the global install and each project are independently transactional, partial results remain visible, and rerunning completes eligible projects.

## Source map

- `.agents/skills/init-project/bin/control-plane-global.mjs`: global TUI and explicit release-update orchestration.
- `.agents/skills/init-project/bin/lib/project-registry.mjs`: bounded registration, locking, canonical paths, and atomic writes.
- `.agents/skills/init-project/bin/lib/release-channel.mjs`: fixed GitHub release checks and cache.
- `.agents/skills/init-project/bin/lib/global-control-plane-ui.mjs`: pure fleet rendering.
- `.agents/skills/init-project/bin/upgrade-all-projects.mjs`: safe sequential maintenance, project upgrade, and resume policy.
- `scripts/install.mjs`: transactional global skills, commands, and launcher installation.
- `scripts/upgrade.mjs`: global-first source validation and optional fleet upgrade entry point.
- `scripts/evaluate.mjs`: source-only disposable evaluation planning, simulation, live opt-in, budgets, resume, and reports.
- `evaluation/corpus/`: seven versioned seed/task/solution fixtures and their external held-out acceptance cases.
- `evaluation/gates/verify-case.mjs`: dependency-free, credential-free, no-network common acceptance gate.
- `.agents/skills/init-project/assets/project/`: version-owned project template copied by the scaffolder.
- `.agents/skills/init-project/assets/project/.autopilot/bin/lib/context-compiler.mjs`: deterministic selected-reference compaction with protected fenced content.
- `.agents/skills/init-project/assets/project/.autopilot/bin/lib/context-pack.mjs`: stable bounded phase-packet assembly and size reporting.
- `.agents/skills/init-project/assets/project/.autopilot/bin/lib/commit-policy.mjs`: fixed or mapped commit-policy validation and deterministic subjects.
- `tests/`: deterministic runtime, policy-boundary, evaluator, registry, dashboard, release, installer, evolution, and upgrade coverage.
