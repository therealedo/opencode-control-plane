# OpenCode Control Plane Roadmap

This roadmap turns the July 2026 ecosystem review into an ordered development direction. It is intentionally conservative: preserve the parts that make Control Plane small and dependable, measure real outcomes before optimizing further, and add complexity only when project evidence justifies it.

Checked items are shipped and verified. Unchecked items are planned or still need evidence. Each release should check completed work here instead of replacing the history.

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
- an optional local-first remote control surface for the same deterministic project state and actions;
- bounded credentials, tools, paths, outputs, and human approval boundaries.

Control Plane will not become:

- a general-purpose or multi-provider agent framework;
- a model-powered manager-agent hierarchy;
- a replacement for OpenCode's tools, sessions, providers, editor, or MCP support;
- a hosted cloud service, general browser IDE, Slack bot, or development platform;
- a replacement desktop or mobile OpenCode client;
- a database-backed issue tracker or generic workflow language;
- a parallel-agent system by default.

Terminal-native remains the default and complete experience. Any remote surface must be an optional thin client over the same deterministic controller, add no model calls, and keep projects fully usable when it is disabled.

## Architecture boundary

The system should retain three clearly separated layers:

1. **Product contract:** versioned blueprints, decisions, compatibility, migrations, and targeted change discovery.
2. **Deterministic control plane:** task state, context selection, policies, gates, receipts, recovery, upgrades, and TUI. This layer makes no model calls.
3. **OpenCode worker plane:** fresh implementation, repair, or review sessions receiving only the context and capabilities needed for one bounded phase.

Blueprint and migration history belong to the cold planning path. They must not be repeatedly loaded into the autonomous execution path.

Repository ownership and runtime placement are separate concerns. Durable product contracts and accepted evidence should remain reviewable with the project, while frequently written state, logs, locks, temporary phase contracts, and executable runtime files should move out of synchronized target repositories when this can be done without weakening recovery, portability, or rollback.

## Current baseline: v1.6.18

Version 1.6.18 carries forward the v1.6.17 baseline and provides:

- [x] Modular, evolving blueprints.
- [x] Deterministic scaffolding and upgrades.
- [x] Fresh OpenCode sessions for bounded phases.
- [x] Selected and byte-bounded context packets.
- [x] Fixed tests and independent review.
- [x] Durable Git, state, receipt, and recovery evidence.
- [x] A global terminal dashboard.
- [x] Measured reduction of framework-owned fixed prompt bytes.
- [x] A pre-launch checkpoint and token-free dashboard control for provider reasoning variants.
- [x] Automatic upgrade of an older in-progress initialization scaffold before its first worker starts.
- [x] A visible arrow-selectable global action menu while retaining direct keyboard shortcuts.
- [x] A high-contrast, color-aware selector with visible horizontal and vertical navigation cues.
- [x] A dependency-free, live folder-suggestion picker for adding initialized projects without memorizing paths.
- [x] Stricter skill wording that reserves human stops for genuinely human-resolvable boundaries.
- [x] A versioned, dependency-free evaluation corpus for seven representative development and recovery scenarios.
- [x] Direct OpenCode, minimal fresh-loop, and Control Plane trial modes that use only evaluator-owned disposable projects.
- [x] Strict provider-event telemetry, per-dimension token/cost budgets, atomic resume state, and JSON plus Markdown results.
- [x] Deterministic no-model simulation for release checks, while real model trials remain explicit opt-in work.
- [x] Accurate public wording: local execution is policy-bounded and self-verifying, not an operating-system sandbox.
- [x] Blueprint schema 6 with deterministic per-task Conventional Commit prefixes and fixed controller bookkeeping.
- [x] Zero-token commit selection from protected configuration rather than worker inference.
- [x] Unchanged support for Blueprint schema 5 and fixed-prefix initialized projects.
- [x] A hash-verified, blueprint-preserving refresh that lets an older active interview finalize without restarting.
- [x] A single authoritative, policy-validated Git changed-file record instead of a redundant worker-contract snapshot.
- [x] Backwards-compatible acceptance of the legacy `changed_files` contract field during project upgrades.
- [x] Strict recovery of provider usage from controller state when a phase fails before creating a task receipt.
- [x] Matching 4 MiB evaluator/worker output ceilings, Windows long-path Git isolation, and bounded calibration subsets.
- [x] Evidence-aware interruption recovery that re-enters implementation when no repair fingerprint exists.
- [x] A narrowly guarded v1.6.1 recovery that refunds only an evidence-less repair proven to have changed no application files.
- [x] A one-click upgrade bridge for that exact blocked state, with the task baseline advanced to the reversible framework-upgrade commit before resume.
- [x] Unchanged fail-closed upgrade behavior for running tasks, application changes, staged queue changes, and all other active transactions.
- [x] Bounded synchronized-folder retries for transient `EPERM`, `EACCES`, and `EBUSY` atomic replacement failures.
- [x] Precise stopped-controller diagnostics and a guarded resume action in the project dashboard.
- [x] Context-aware option 8: return to the main fleet dashboard when nested, or close to a usable shell when launched directly.
- [x] A backwards-compatible fleet marker that does not prevent older project dashboards from opening during staggered upgrades.
- [x] A checkbox-based roadmap that preserves completed work and makes pending work directly trackable.
- [x] Bounded, credential-redacted OpenCode launch diagnostics instead of hash-only provider failures.
- [x] Fleet and project status that cannot mislabel an interrupted active task as safely in maintenance.
- [x] A narrowly guarded upgrade recovery for v1.6.3 through v1.6.5 tasks exhausted solely by failed OpenCode launches with no application changes.
- [x] Automatic restoration of that task's exact committed ready queue, with a paused maintenance boundary and auditable migration record.
- [x] Fail-closed refusal of the recovery when any application file, queue field, phase contract, receipt, transaction, baseline, or controller-liveness proof differs.
- [x] Fleet upgrades delegate stopped active-task eligibility to the guarded project upgrader instead of rejecting every active task first.
- [x] Recoverable v1.6.3 through v1.6.5 projects can now cross the v1.6.6 bridge through **Update everything**.
- [x] Ordinary active tasks and unfinished transactions remain deferred without framework, queue, state, or attempt changes.
- [x] Structured OpenCode provider-authentication failures stop at the first failed launch instead of consuming repair attempts.
- [x] Authentication-only failures with no application changes refund the semantic attempt and wait for reauthentication plus explicit resume.
- [x] A narrowly guarded v1.6.7 upgrade recovery recognizes retained structured `401` evidence, restores the committed ready task, and records the recovery.
- [x] Plain text that merely mentions authentication is not accepted as recovery proof.
- [x] Consistent literal-directory allowlist semantics across worker writes and controller validation.
- [x] A guarded in-place upgrade bridge for the already blocked v1.6.8/v1.6.9 literal-directory task state.
- [x] Safe Windows Corepack execution through its fixed adjacent Node entry point without executing or parsing the `.cmd` shim.
- [x] A guarded v1.6.10 recovery that preserves allowed application work and refunds the exact exhausted Corepack-shim task.
- [x] Active-task continuity for Corepack recovery so preserved files remain M001 work instead of becoming unrelated dirty files.
- [x] A guarded bridge that repairs the exact v1.6.11 detached-file recovery state without deleting or rebuilding application work.
- [x] A single-use controller-owned pnpm lockfile action that disables lifecycle scripts and pnpmfile hooks and strips phase credentials.
- [x] Task- and role-scoped exposure of that action only when both the root manifest and lockfile are approved task paths.
- [x] Bounded diagnostics when same-session feedback runners fail before returning controller JSON.
- [x] A guarded v1.6.12 recovery that preserves M001, removes stale candidate evidence, and refunds its dependency-tooling attempt budget.
- [x] Complete bounded telemetry support for the controller-owned lockfile action.
- [x] A guarded v1.6.13 recovery that preserves M001, rejects unrelated changes, removes stale candidate evidence, and restores attempt 1 after the exact lockfile-telemetry defect.
- [x] Controller-owned actions and feedback gates launch through the controller's fixed Node runtime instead of the OpenCode/Bun worker host.
- [x] A guarded v1.6.14 recovery preserves the affected M001 workspace and restores attempt 1 after the exact runner-routing failure.
- [x] The project dashboard sends stopped blocked tasks directly to the guarded updater instead of making their recovery unreachable behind the maintenance guard.
- [x] Durable phase-usage validation accepts the controller-owned lockfile action, allowing the guarded recovery to retain its real usage audit through post-upgrade validation.
- [x] Gate cleanup uses bounded native retries for transient Windows file locks, with an exact v1.6.17 recovery that restores the affected M001 attempt budget.

The fixed-context measurement and simulated evaluation remain regression guards, not proof of end-to-end token savings or unchanged implementation quality. Controlled live trials across models are the next step before further prompt compression or reduced-review policy.

## Immediate maintenance: v1.6.18 Windows gate cleanup recovery (shipped)

**Goal:** keep short-lived Windows filesystem locks from turning controller-owned cleanup into an exhausted application task.

Delivered outcomes:

- [x] Retry `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, and `EPERM` cleanup failures with Node's bounded linear-backoff removal.
- [x] Retain the existing private-directory, link, owner, depth, entry-count, and location checks before removal.
- [x] Recognize only the exact exhausted v1.6.17 `GATE_CLEANUP_FAILED` state with matching candidate, queue, baseline, receipt absence, and allowlisted workspace files.
- [x] Preserve M001 and its usage audit, remove stale candidate evidence, advance the baseline, and restore attempt 1.

## Immediate maintenance: v1.6.17 lockfile usage validation (shipped)

**Goal:** complete the v1.6.14 recovery transaction when its retained usage ledger records the controller-owned lockfile action.

Delivered outcomes:

- [x] Add `lockfile` to the bounded durable phase-tool vocabulary.
- [x] Preserve the failed attempt's token and tool-usage audit instead of deleting evidence to pass validation.
- [x] Reproduce the exact post-copy rollback using a disposable copy of the affected project state.
- [x] Regression-test the real retained lockfile usage shape through the complete guarded upgrade.

## Immediate maintenance: v1.6.16 reachable blocked-task upgrades (shipped)

**Goal:** make the existing guarded recovery reachable from the project dashboard when the worker is already stopped at a blocker.

Delivered outcomes:

- [x] Require maintenance draining only while a controller process is live.
- [x] Let the guarded project updater inspect stopped blocked tasks directly.
- [x] Preserve fail-closed updater validation for every unrecognized active task or dirty state.
- [x] Regression-test both stopped-blocked and live-worker upgrade routing.

## Immediate maintenance: v1.6.15 controller runner routing (shipped)

**Goal:** route controller-owned scripts through the controller's trusted Node executable even when OpenCode hosts custom tools under Bun or another runtime.

Delivered outcomes:

- [x] Bind one absolute controller Node argv into every sterile phase policy.
- [x] Use that argv for both the pnpm lockfile action and bounded feedback-gate runner.
- [x] Regression-test the indirection through an explicit controller Node proxy.
- [x] Recognize only the exact v1.6.14 controller-tooling blocker with matching queue, baseline, candidate, lockfile, and allowlisted application files.
- [x] Preserve M001, remove stale candidate evidence, advance the baseline, and restore attempt 1 without rebuilding the project.

## Immediate maintenance: v1.6.14 lockfile telemetry recovery (shipped)

**Goal:** accept the bounded lockfile tool's own usage record and recover projects stopped by v1.6.13 without rebuilding their generated workspace.

Delivered outcomes:

- [x] Add `lockfile` to the exact accepted phase-tool telemetry names while retaining bounded counters and total-consistency checks.
- [x] Reproduce the valid lockfile usage record through the fresh OpenCode phase boundary.
- [x] Recognize only the exact exhausted v1.6.13 `OPENCODE_TOOL_USAGE_INVALID` state with matching blocker, queue, baseline, candidate, lockfile, and allowlisted application files.
- [x] Preserve all approved M001 output, remove stale candidate evidence, advance the baseline to the reversible upgrade commit, and restore attempt 1.
- [x] Keep all unrelated active tasks, changed control evidence, receipts, and out-of-scope files fail-closed.

## Immediate maintenance: v1.6.13 bounded dependency resolution (shipped)

**Goal:** let a worker complete an exactly pinned pnpm workspace lockfile without granting arbitrary shell access or requiring manual project repair.

Delivered outcomes:

- [x] Expose one fixed `pnpm install --lockfile-only` action only to eligible implementation and repair phases.
- [x] Disable package scripts and pnpmfile hooks, isolate user configuration, reject credential-bearing project `.npmrc` entries, and cap time/output.
- [x] Keep dependency resolution unavailable to independent review and limit it to one call per phase.
- [x] Return bounded actionable feedback when the ordinary feedback runner fails to produce controller JSON.
- [x] Recognize only the exact v1.6.12 M001 dependency-lock blocker with its unchanged queue, baseline, candidate, and allowlisted workspace files.
- [x] Preserve those files, advance the task baseline to the reversible upgrade commit, remove stale candidate evidence, and restore attempt 1.

Exit criteria:

- [x] Unsafe npm configuration is rejected before Corepack launches.
- [x] The dependency action and its one-call phase cap are regression tested without network access.
- [x] The reproduced v1.6.12 blocked task upgrades in place without deleting or rebuilding product work.

## Immediate maintenance: v1.6.12 Corepack task continuity (shipped)

**Goal:** reconnect application files preserved by v1.6.11 to M001 so strict validation can resume the task safely.

Delivered outcomes:

- [x] Keep the Corepack recovery as an active blocked task instead of resetting it to an unrelated clean-start boundary.
- [x] Advance the active task baseline to the reversible framework-upgrade commit.
- [x] Preserve one productive attempt and refund the framework-caused retries, leaving two bounded phases available.
- [x] Remove stale phase-candidate evidence before the next fresh execution.
- [x] Recognize and repair only the exact v1.6.11 `exhausted-corepack-shim` migration state with a committed ready queue and allowlisted preserved files.
- [x] Refuse out-of-bound files, changed queues, unexpected phase evidence, receipts, or mismatched migration history.

Exit criteria:

- [x] Direct v1.6.10 recovery remains active at M001 attempt 1 with its generated files preserved.
- [x] The reproduced v1.6.11 detached-file state upgrades to v1.6.12 and reconnects M001 without rebuilding.
- [x] Resume can pass strict validation and continue from the preserved workspace.

## Immediate maintenance: v1.6.11 Windows Corepack recovery (shipped)

**Goal:** run fixed Corepack gates safely on Windows and recover the already exhausted task without deleting its generated workspace.

Delivered outcomes:

- [x] Recognize only the standard adjacent `corepack.cmd` + `node.exe` + `node_modules/corepack/dist/corepack.js` layout.
- [x] Invoke the Corepack JavaScript entry point directly with the native Node executable; never execute or parse the command shim.
- [x] Keep every other unsupported `.cmd` or `.bat` launcher blocked by default.
- [x] Recognize only the exact v1.6.10 exhausted `WINDOWS_SHIM_UNSUPPORTED` gate state with matching candidate, queue, baseline, and blocker evidence.
- [x] Preserve unstaged regular application files only when every path remains inside M001's allowlist.
- [x] Restore the committed ready queue and attempt 0 while retaining the reversible framework-upgrade commit and migration history.

Exit criteria:

- [x] A Windows Corepack shim resolves to the adjacent native Node entry point.
- [x] An unknown Windows command shim still fails closed.
- [x] The reproduced M001 recovery keeps all generated application files and returns the task to a resumable ready state.

## Immediate maintenance: v1.6.10 blocked-task upgrade bridge (shipped)

**Goal:** let a project already stopped by the v1.6.8/v1.6.9 literal-directory bug install the corrected worker tools without rebuilding or manually migrating its active task.

Delivered outcomes:

- [x] Recognize only the exact bounded `path_boundary` state emitted by the literal-directory mismatch.
- [x] Require matching state and candidate blockers, attempt 1, no failure evidence, no receipt, an otherwise baseline-identical queue, and any preserved application diff to contain only unstaged private regular files inside the task allowlist.
- [x] Upgrade managed framework files and advance the active task's baseline to the reversible framework commit.
- [x] Preserve the blueprint, task definition, queue status, first attempt, candidate evidence, application files, and Git history.
- [x] Refuse unrelated path blockers, staged/deleted/linked/out-of-bound application changes, altered queues, unexpected runtime evidence, or unsupported versions.

Exit criteria:

- [x] **Update everything** upgrades the reproduced v1.6.8 blocked M001 state to v1.6.10.
- [x] M001 remains blocked at attempt 1 until the user explicitly resumes it.
- [x] Resume launches the corrected worker without broadening any allowed path.

## Immediate maintenance: v1.6.9 literal-directory task writes (shipped)

**Goal:** let greenfield tasks create files beneath explicitly allowed directory entries without asking the user to widen an already correct task boundary.

Delivered outcomes:

- [x] Treat a literal allowed path such as `apps/web` as authorizing that directory and its descendants in worker write, edit, move, delete, and executable-mode operations.
- [x] Match the descendant semantics already enforced by the controller's post-phase changed-file validator.
- [x] Preserve wildcard matching, protected paths, ignored files, symlink and hardlink rejection, and atomic writes.
- [x] Add a worker-tool regression using a literal directory allowlist.

Exit criteria:

- [x] A worker allowed `src` can create and modify `src/**` files.
- [x] The same worker cannot write outside `src`.
- [x] Existing v1.6.8 projects upgrade without blueprint, queue, application, attempt, or history reconstruction.

## Immediate maintenance: v1.6.8 provider-authentication boundary (shipped)

**Goal:** prevent expired provider sessions from spending a task's repair budget and recover the already affected v1.6.7 project safely.

Delivered outcomes:

- [x] Parse only structured OpenCode error events when classifying provider authentication failures.
- [x] Stop after the first failed launch, retain a bounded sanitized diagnostic, and request reauthentication.
- [x] Refund the semantic attempt only when the task has no application-file changes.
- [x] Resume the same task after the user reconnects the provider; do not rebuild or restart discovery.
- [x] Recover the exact v1.6.7 exhausted-authentication state during a normal fleet upgrade.
- [x] Require the existing baseline, queue, transaction, receipt, and controller-liveness proofs before recovery.
- [x] Reject unstructured authentication text as insufficient proof.

Exit criteria:

- [x] A simulated structured `401` pauses at attempt 0 after one launch.
- [x] Reauthentication plus Resume completes the same task from attempt 1.
- [x] The reproduced CRM state previews as `exhausted-provider-auth` without changing application files.

## Immediate maintenance: v1.6.7 fleet recovery routing (shipped)

**Goal:** make the one-click fleet updater reach v1.6.6's guarded exhausted-launch recovery without weakening normal active-task protection.

Delivered outcomes:

- [x] Removed the duplicate fleet-level rejection of every stopped project with an active task.
- [x] Delegated recovery eligibility to the project upgrader, which owns the full Git, state, receipt, transaction, and version proof.
- [x] Returned the recovery kind and recovered task in fleet preview and completion results.
- [x] Preserved deferred status for ordinary active tasks and unfinished transactions.
- [x] Added an end-to-end fleet regression for both the recoverable and non-recoverable paths.

Exit criteria:

- [x] **Update everything** previews and upgrades the reproduced v1.6.3 exhausted-empty CRM state.
- [x] The recovered task returns to its exact committed ready queue at attempt 0.
- [x] A normal stopped active task remains unchanged and reports `ACTIVE_TASK`.

## Immediate maintenance: v1.6.6 exhausted-launch recovery (shipped)

**Goal:** recover the real v1.6.3 empty-task failure without spending another attempt blindly or weakening project safety.

Delivered outcomes:

- [x] Preserve a maximum 4 KiB sanitized diagnostic when a fresh OpenCode process exits unsuccessfully.
- [x] Prefer the stopped-controller error over a queued maintenance marker in both project and fleet views.
- [x] Detect the exact exhausted `OPENCODE_FAILED` state from affected releases during project upgrade.
- [x] Prove the baseline commit is unchanged, the Git worktree contains only the queue projection, and that projection differs only in revision and runtime statuses.
- [x] Require the absence of candidate, review, mode-intent, receipt, completion, finalization, and live-controller evidence.
- [x] Restore the committed ready queue, reset the empty task at a paused maintenance boundary, and record `upgrade-recovery` in migration history.
- [x] Preserve all files and refuse recovery when any proof is missing or any application change exists.

Exit criteria:

- [x] The reproduced v1.6.3 CRM failure upgrades without deleting or rebuilding the project and can retry M001 from attempt 1.
- [x] Credential values and terminal escape sequences are absent from retained diagnostics.
- [x] A modified application file prevents automatic recovery.
- [x] Ordinary upgrades and the earlier evidence-less recovery remain unchanged.

## Immediate maintenance: v1.6.5 dashboard navigation (shipped)

**Goal:** make project-dashboard navigation explicit and ensure leaving the dashboard never traps the terminal or changes autonomous worker state.

Delivered outcomes:

- [x] Pause the project dashboard's input stream during cleanup so the Node process exits and releases the terminal.
- [x] Show **Back to main dashboard** as option 8 when a project was opened from the global fleet view.
- [x] Keep **Close dashboard only** for direct project-dashboard launches and return to a usable shell.
- [x] Preserve option 8 and Q as navigation-only actions with no pause, stop, resume, or attempt mutation.
- [x] Use a backwards-compatible inherited marker that older project dashboards safely ignore.
- [x] Add regression coverage for terminal cleanup, menu context, mixed-version navigation, and rendered guidance.

Exit criteria:

- [x] Returning from a fleet-opened project restores the main dashboard.
- [x] Closing a directly launched project dashboard restores an interactive terminal.
- [x] Leaving either dashboard does not stop the worker or consume an attempt.

### First controlled live calibration

On July 24, 2026, the greenfield case completed once per strategy with OpenCode 1.18.4, `openai/gpt-5.6-sol`, and the `max` reasoning variant. All three strategies passed the same held-out gate.

| Strategy | Accepted | Input | Output | Reasoning | Cache read | Elapsed |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Direct OpenCode | Yes | 7,171 | 625 | 1,449 | 5,632 | 62.5 s |
| Minimal fresh loop | Yes | 5,982 | 591 | 1,185 | 5,632 | 52.4 s |
| Control Plane v1.6.1 | Yes | 14,028 | 634 | 1,793 | 9,216 | 149.4 s |

Control Plane completed in one implementation attempt with zero repairs, one independent review, four successful strategy gates, no unexpected files, and no dependency additions. For this small, low-risk task, that extra assurance cost more input and elapsed time than either simpler strategy; this calibration does **not** show total-token savings. One repetition is directional evidence, not a statistically reliable benchmark. The next efficiency work should target phase input and risk-proportional review without weakening deterministic gates, followed by repeated trials across the full corpus before changing default policy.

## Immediate maintenance: v1.6.4 reliability (shipped)

**Goal:** make controller state transitions resilient to transient Windows and synchronized-folder file locks before undertaking broader storage refactoring.

The current atomic-write design is correct in principle, but a real Proton Drive project showed that a transient `EPERM` rename failure can outlast the existing retry window and terminate the worker while leaving the dashboard open.

Delivered outcomes:

- [x] Extended bounded retry and backoff for transient `EPERM`, `EACCES`, and `EBUSY` replacement failures without retrying permanent errors indefinitely.
- [x] Preserved the last durable state and a precise controller error when a replacement still cannot complete.
- [x] Made the dashboard distinguish an active worker from a dead worker immediately and explain the exact recovery action.
- [x] Added injected-lock tests covering a lock that clears within the retry window and one that remains locked beyond it.
- [x] Verified that a failed state write does not consume a semantic model attempt, lose application changes, or corrupt the task queue.

Exit criteria:

- [x] A representative transient synchronized-folder lock recovers automatically.
- [x] A persistent lock fails closed with the project, attempt budget, and rollback evidence intact.
- [x] The dashboard does not continue to present a dead worker as resumed or active.

## Milestone 1: Evidence and truthful boundaries

**Goal:** establish whether Control Plane improves total efficiency without reducing quality.

**Status:** evaluation infrastructure shipped in v1.5.0; the first three-strategy greenfield calibration is complete, while repeated and cross-scenario live baselines remain pending. Installation, upgrade, and normal project work never start paid evaluation trials.

Planned outcomes:

- [x] Repeatable corpus for greenfield work, feature changes, bug repair, integration changes, blueprint migration, interruption recovery, and failed verification.
- [x] Direct OpenCode, minimal fresh-session loop, and Control Plane trial modes on equivalent disposable tasks.
- [x] Strict input, cache-read, cache-write, reasoning, output, and provider-cost collection—not prompt bytes alone; first live calibration recorded.
- [x] Retries, repairs, elapsed time, unnecessary files/dependencies, false completion, gate results, and final common acceptance; first live calibration recorded.
- [x] Model/provider/profile identity separated from framework-owned measurements.
- [x] Accurate application-level **policy boundary** language without implying operating-system isolation.
- [x] Existing independent reviewer and deterministic safety gates retained while gathering the baseline.
- [ ] Repeated live baselines for supported model/profile combinations, including failures and incomplete telemetry.

Exit criteria:

- [x] The same evaluation can be rerun with another supported model.
- [x] Results identify where tokens are actually spent across implementation, repair, review, and tool use.
- [x] Quality and recovery failures are visible rather than averaged away.
- [x] Product descriptions consistently distinguish policy-bounded execution from real container or VM isolation.

## Planned release sequence

The next minor releases have one primary architectural purpose each. Maintenance fixes may ship between them, but they must not silently pull later release scope forward.

- [ ] **v1.7 — Operational profiles and OpenCode compatibility:** change how a project executes without changing product intent.
- [ ] **v1.8 — Global runtime cache and durable state decoupling:** reduce project footprint and synchronized-worktree churn while preserving exact version pinning.
- [ ] **v1.9 — Local-first remote control:** monitor and control the same deterministic projects from trusted devices while keeping the terminal experience complete.
- [ ] **Separate companion project, only if required:** true phone/desktop OpenCode session mirroring when the official shared-server path cannot meet the tested synchronization contract.

Evidence-gated work has no promised release number:

- [ ] Risk-aware token and review policy.
- [ ] Existing-project adoption.
- [ ] Optional container or VM isolation.
- [ ] Parallel tasks, richer dependency graphs, intermediate recovery checkpoints, or additional worker runtimes.

## v1.7: Operational profiles and OpenCode compatibility

**Goal:** let projects change models and operating policy safely without changing product intent.

**Status:** in progress. Version 1.3 shipped the first vertical slice:

- [x] Initialization stops at an explicit ready checkpoint before the first worker.
- [x] The terminal dashboard changes provider reasoning variants without a model call or blueprint revision.
- [x] The selected variant is injected into every fresh policy-bounded worker phase.
- [x] An interview started on v1.2 upgrades its finalized scaffold automatically and preserves all answers before pausing.
- [x] The runtime setting is project-local, ignored by Git, disabled while a worker is live, and reversible to the provider default.

Remaining outcomes:

- [ ] Move model selection, cost limits, and the remaining runtime choices out of the product contract.
- [ ] Keep a project default while allowing safe global or phase-specific overrides.
- [ ] Allow model changes from the terminal dashboard at a maintenance boundary.
- [ ] Do not create a new blueprint version merely because a model changed.
- [ ] Validate model availability and OpenCode compatibility before activation.
- [ ] Preserve the previous runtime profile for immediate rollback.
- [ ] Establish and test a minimum supported OpenCode version and capability contract.

Exit criteria:

- [ ] A project can switch to a better model midway through development without reinitialization or blueprint migration.
- [ ] A failed runtime change leaves the previous working configuration active.
- [ ] Product architecture decisions remain distinct from execution preferences.

## v1.8: Runtime decoupling and durable state storage

**Goal:** reduce managed-project footprint and eliminate synchronized-repository write churn without losing version pinning, project history, or one-command upgrades.

**Status:** planned after the shipped v1.6.4 reliability patch. This is an architectural migration, not a prerequisite for safely resuming current projects.

Planned outcomes:

- [ ] Install Control Plane executables in a trusted, versioned global runtime cache instead of copying `.autopilot/bin/` into every project.
- [ ] Keep supported runtime versions side by side and pin each project to an exact validated version; never silently substitute the newest runtime.
- [ ] Move hot mutable state, logs, locks, sentinels, and temporary phase contracts to a bounded per-user local data directory keyed to the canonical project identity.
- [ ] Keep blueprints, decisions, migration plans, gates, accepted queue history, and receipts project-owned and Git-reviewable where they provide durable product or verification evidence.
- [ ] Retain a minimal project locator/configuration that can reconnect a clean clone to its pinned runtime and reconstruct safe ignored state.
- [ ] Provide a one-command, reversible migration for existing projects, including projects paused at a safe maintenance boundary.
- [ ] Preserve legacy project compatibility during a documented transition window; a missing runtime or state store must fail closed with an actionable recovery path.
- [ ] Measure framework file count, bytes, write frequency, upgrade duration, and recovery behavior instead of optimizing for an arbitrary number of root files.

Exit criteria:

- [ ] Normal controller operation performs no high-frequency writes inside a synchronized project worktree.
- [ ] A clean clone can restore the exact compatible runtime without copying mutable history from another machine.
- [ ] Global upgrades preserve pinned older projects until their guarded project migration succeeds.
- [ ] Existing projects migrate without application-code changes, blueprint loss, manual file moves, or worker interruption outside the maintenance boundary.
- [ ] The new layout remains dependency-free and requires no daemon, database, or background model process.

## Evidence-gated backlog: Risk-aware token efficiency

**Goal:** spend model tokens in proportion to task risk while keeping deterministic checks mandatory.

Planned outcomes:

- [ ] Assign a deterministic risk class using affected paths, task type, credentials, migrations, architecture, data, security, and deployment impact.
- [ ] Measure the value and cost of independent review for each risk class.
- [ ] Keep independent review as the default until evaluation demonstrates an equal-quality lower-cost policy for a specific class.
- [ ] Never remove required tests, security checks, migration checks, or destructive-action approval to save tokens.
- [ ] Prefer OpenCode's existing search and language intelligence before building or bundling a repository index.
- [ ] Continue returning compact typed contracts while leaving full evidence in bounded artifacts.
- [ ] Preserve diagnostic identity, relevant stack frames, the beginning and end of failing compiler/test output, and the exact active diff; keep full bounded artifacts available rather than applying an unsafe blanket no-truncation rule.
- [ ] Measure repeated reads, evidence misses, repair success, and packet composition before adding any automatic full-file reinjection policy.
- [ ] Attribute phase input to stable policy, selected project context, dynamic evidence, tool results, and independent review so optimizations target measured overhead.

Possible policy, enabled only after evidence supports it:

- metadata-only work: deterministic validation;
- proven low-risk work: deterministic gates plus the least expensive review policy that preserves results;
- normal features: implementation and independent review;
- security, data, infrastructure, architecture, or migration work: stronger review and rollback requirements.

Exit criteria:

- [ ] End-to-end tokens per accepted task decrease on the evaluation corpus.
- [ ] Acceptance quality, recovery success, and safety results do not regress.
- [ ] Turn count, retries, false completion, and elapsed time remain visible alongside token use rather than being hidden by an aggregate.
- [ ] Any reduced-review policy is narrow, reversible, and disabled automatically outside its proven risk class.

## Evidence-gated backlog: Existing-project adoption

**Goal:** bring an established repository under Control Plane without forcing a greenfield questionnaire or rewriting its history.

Planned outcomes:

- [ ] Inspect existing structure, tests, integrations, and architecture using bounded reads.
- [ ] Ask only for consequential facts that cannot be recovered from the repository.
- [ ] Create an initial blueprint and project memory representing the system as it exists.
- [ ] Preserve application files and accepted Git history byte-for-byte during planning.
- [ ] Require comparison, approval, and rollback for generated control files.
- [ ] Begin autonomous work only after readiness and safety boundaries are explicit.

Exit criteria:

- [ ] An existing project can be adopted without destructive regeneration.
- [ ] The resulting blueprint distinguishes observed facts, user-confirmed intent, and unresolved unknowns.
- [ ] Adoption is materially shorter than new-project discovery.

## Evidence-gated backlog: Optional real isolation

**Goal:** provide a stronger execution boundary for untrusted toolchains without burdening the default local workflow.

Planned outcomes:

- [ ] Define one narrow controller-owned execution-backend contract.
- [ ] Retain the fast local policy-bounded backend as the default.
- [ ] Evaluate an optional container or VM backend for commands, package scripts, browsers, and native binaries.
- [ ] Evaluate bounded CPU, memory, timeout, and process-tree cleanup guarantees per backend instead of treating containerization alone as proof of cleanup.
- [ ] Keep secrets scoped to the selected phase and isolation environment.
- [ ] Preserve inspectable logs, Git rollback, and deterministic gates across backends.
- [ ] Avoid exposing isolation machinery to model prompts unless a worker must interact with it.

Exit criteria:

- [ ] Documentation states exactly which threats each backend does and does not contain.
- [ ] Projects that do not need OS isolation gain no mandatory services, daemons, databases, or model context.
- [ ] A failed or unavailable optional backend cannot silently fall back to weaker isolation.
- [ ] Controller termination removes or deterministically reaps the backend workload within a tested bounded interval.

## v1.9: Local-first remote control

**Goal:** let the user monitor and control the same Control Plane projects from a phone or another trusted device without creating a hosted service, duplicating controller state, or spending model tokens.

**Status:** approved direction; implementation begins only after the single-server OpenCode compatibility test and a threat model establish a small, dependable boundary.

Planned outcomes:

- [ ] Define a dependency-light local supervisor interface over the existing project registry, state, and deterministic actions.
- [ ] Keep the terminal TUI as the primary, fully capable interface; remote access remains optional and removable.
- [ ] Provide a responsive phone interface for fleet status, project status, start, pause, resume, safe stop, upgrades, and genuine human-intervention requests.
- [ ] Use one authoritative controller state; terminal and remote clients must never maintain competing project state.
- [ ] Stream bounded status changes without model calls and restore authoritative state after disconnect or device sleep.
- [ ] Require authentication and encrypted access through a trusted private network or equivalent secure transport; never advertise direct unauthenticated internet exposure.
- [ ] Make simultaneous actions idempotent or conflict-aware so two clients cannot approve, resume, or answer the same request twice.
- [ ] Keep credentials, raw provider output, unrestricted logs, and secrets off the remote surface.
- [ ] Measure idle CPU, memory, package footprint, startup time, and project write churn before accepting the implementation.
- [ ] Preserve one-command global upgrades and backwards-compatible project operation when the remote component is absent or outdated.

OpenCode interoperability:

- [ ] Test one authoritative `opencode web` or `opencode serve` instance with the desktop terminal attached and a phone connected to the exact same server and session.
- [ ] Verify simultaneous message streaming, reconnect recovery, permissions, and pending single-select and multi-select questions.
- [ ] Determine whether the currently observed frozen or missing-question behavior is caused by separate server instances, session selection, the third-party Android client, or OpenCode's server/client protocol.
- [ ] Prefer OpenCode's official server API and event stream; do not duplicate its conversation engine or session history inside Control Plane.
- [ ] Surface a link or handoff to the authoritative OpenCode session only if this can be done without making Control Plane responsible for editing or rendering the session.

Exit criteria:

- [ ] A phone and terminal can observe the same Control Plane project concurrently and receive the same blocker transition within a tested bounded interval.
- [ ] Exactly one accepted action is recorded when both clients attempt the same transition.
- [ ] Losing the phone connection cannot stop, duplicate, or mutate a worker.
- [ ] Remote access can be disabled completely without affecting local projects, upgrades, or the terminal dashboard.
- [ ] The feature adds zero model tokens to monitoring and controller actions.
- [ ] Security documentation explains the supported network boundary and rejects unsafe public exposure.

## Conditional future work

The following work is not committed. It should begin only when measurements demonstrate a concrete need.

### Official OpenCode SDK integration

Keep the current fresh-process execution while it remains simple and reliable. Consider the official SDK or server event stream only if it materially improves structured output, cancellation, compatibility, or live status without weakening phase separation or requiring a persistent daemon.

### True multi-device OpenCode session mirroring

This is a separate companion-project decision, not hidden v1.9 scope. First validate OpenCode's documented shared-server model with the official web interface, an attached desktop terminal, and the existing Android client. Control Plane may provide secure discovery, status, and a handoff to that one authoritative server, but it should not become a second owner of OpenCode conversations.

If the official path cannot reliably synchronize reconnects, pending questions, permissions, and single-writer answers, design a separate companion project that uses OpenCode's public server API and event stream. Keep that client independently installable and versioned so mobile UI complexity cannot enlarge the controller, weaken its zero-token boundary, or disrupt existing autonomous projects.

### Parallel tasks and worktrees

Consider limited parallelism only when sequential task execution is a measured bottleneck. Require independent tasks, isolated worktrees, bounded concurrency, deterministic merge gates, and clear conflict recovery. Cross-project concurrency is preferable to multiple agents editing one project.

### Intermediate recovery checkpoints

Consider immutable Git checkpoint objects or private refs only if recovery testing shows that the existing baseline-plus-worktree model can lose useful intermediate work. A checkpoint must preserve the visible repair diff, avoid automatic destructive stashing, remain outside normal branch history, and have deterministic cleanup and rollback. Do not add branching merely to support hypothetical non-linear work; the existing validated task dependency DAG remains the default.

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

## Measurement rules

- Reliability targets use explicit bounded times and injected-failure tests; avoid untestable terms such as "instantly."
- Footprint targets report managed files, bytes, write churn, and project-visible state; a small root-file count alone is not evidence of a clean architecture.
- Token-efficiency claims require accepted common gates and include input, output, reasoning, cache use, turns, retries, repairs, reviews, elapsed time, and false completion.
- Full evidence may remain in bounded artifacts while model context receives a precision-preserving projection; unlimited output is not a safety or quality requirement.

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
- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode Web](https://opencode.ai/docs/web/)
- [Ralph](https://github.com/snarktank/ralph)
- [Gas City](https://github.com/gastownhall/gascity) and [Beads](https://github.com/gastownhall/beads)
- [Open SWE](https://github.com/langchain-ai/open-swe)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [Plandex](https://github.com/plandex-ai/plandex)
- [Aider](https://github.com/Aider-AI/aider)
- [Goose](https://github.com/aaif-goose/goose)
- [Roo Code orchestration](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- [Container Use](https://github.com/dagger/container-use)
