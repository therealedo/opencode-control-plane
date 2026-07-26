#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertManagedPath,
  collectManagedSources,
  createInstalledManifest,
  hashManaged,
  mergeManagedSource,
} from "./lib/control-plane-files.mjs";
import {
  atomicWriteFile,
  isAllowedPath,
} from "../assets/project/.autopilot/bin/lib/core.mjs";
import {
  externalExecutionEnv,
  gitSafeAmbientConfigArgs,
  resolveExternalGitExecutable,
  runArgv,
  safeBaseEnv,
  sanitizeProcessResult,
} from "../assets/project/.autopilot/bin/lib/process.mjs";
import { controllerCommitMessage } from "../assets/project/.autopilot/bin/lib/commit-policy.mjs";

const PROCESS_TIMEOUT_MS = 10 * 60_000;
const PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MANIFEST_BYTES = 512 * 1024;
const COREPACK_BLOCKER = Object.freeze({
  kind: "gate_configuration",
  message: "The authoritative gate argv resolves `corepack` to a Windows `.cmd` shim without a matching PowerShell shim; gate/control files are outside the allowed paths and may not be changed.",
  required_action: "Update the fixed Windows gate launcher to use a native executable or invoke Corepack through an explicit Node script argv.",
  resume_condition: "Resume once the authoritative credential-free gates can launch Corepack on Windows without the unsupported shim.",
});
const DEPENDENCY_LOCK_BLOCKER = Object.freeze({
  kind: "tooling_authority",
  message: "The available file-only tools cannot generate the complete pnpm 11.14.0 transitive lockfile, and the credential-free gate runner did not provide actionable output.",
  required_action: "Provide an approved credential-free pnpm 11.14.0 lockfile-generation action (or a complete generated lockfile) and restore bounded feedback-gate execution.",
  resume_condition: "A complete generated workspace lockfile or approved generation tool is available and the listed gates can return results.",
});
const args = parseArgs(process.argv.slice(2));
const defaultSkillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await main().catch((error) => {
  const result = { ok: false, error: error.message, code: error.code ?? "UPGRADE_FAILED", details: error.details ?? null };
  process.stderr.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const skillRoot = path.resolve(args.sourceSkill ?? defaultSkillRoot);
  const target = path.resolve(args.target ?? process.cwd());
  await assertStandaloneProject(target);
  const { release, entries } = await collectManagedSources(skillRoot);
  const manifestFile = path.join(target, ".autopilot", "control-plane.json");
  const previous = await readBoundedJson(manifestFile, MANIFEST_BYTES, { optional: true });
  if (!previous && !args.adopt) {
    throw upgradeError(
      "This project predates versioned Control Plane ownership. Review the managed-file preview and rerun with --adopt; product files are never included.",
      "ADOPTION_REQUIRED",
    );
  }
  if (previous) await validatePreviousManifest(target, previous);
  const state = await readBoundedJson(path.join(target, ".autopilot", "state.json"), 64 * 1024, { optional: true }) ?? {};
  const recoveryBoundary = await assertSafeControllerBoundary(target, state, previous);
  if (previous && compareVersions(previous.version, release.version) > 0) {
    throw upgradeError(`Downgrades are not allowed (${previous.version} -> ${release.version})`, "DOWNGRADE_DENIED");
  }
  if (args.interview) {
    if (args.adopt || !previous) throw upgradeError("Interview refresh requires existing versioned ownership", "INTERVIEW_REFRESH_DENIED");
    await assertInterviewBoundary(target, state);
  } else {
    await assertCleanGit(target, { allowedDirty: recoveryBoundary?.allowedDirty ?? [] });
  }

  const candidates = new Map();
  for (const [relative, entry] of entries) {
    const destination = resolveManaged(target, relative);
    const current = await readManagedFile(destination, { optional: true });
    if (!current && entry.mode !== "exact") {
      candidates.set(relative, Buffer.from(entry.bytes));
      continue;
    }
    const candidate = mergeManagedSource(entry, current ?? Buffer.alloc(0), { adopt: args.adopt && !previous });
    if (!current || !candidate.equals(current)) candidates.set(relative, candidate);
  }

  if (previous && previous.version === release.version && candidates.size > 0) {
    throw upgradeError(
      `Managed source changed without a release version bump (${release.version})`,
      "RELEASE_VERSION_NOT_BUMPED",
      { changed_files: [...candidates.keys()] },
    );
  }

  const preview = {
    ok: true,
    dry_run: args.dryRun,
    adopted_legacy_project: !previous,
    from_version: previous?.version ?? null,
    to_version: release.version,
    changed: candidates.size > 0 || !previous || previous.version !== release.version,
    changed_files: [...candidates.keys()],
    retained_retired_files: Object.keys(previous?.managed_files ?? {}).filter((relative) => !entries.has(relative)),
    recovered_active_task: recoveryBoundary?.taskId ?? null,
    recovery_kind: recoveryBoundary?.kind ?? null,
  };
  if (args.dryRun) return output(preview);
  if (!preview.changed) return output({ ...preview, commit: null, rollback: null });

  if (args.interview) {
    const transaction = await applyInterviewRefresh({
      target,
      skillRoot,
      release,
      entries,
      previous,
      candidates,
      manifestFile,
    });
    return output({
      ...preview,
      interview_refreshed: true,
      commit: null,
      rollback: "The normal initialization baseline commit will capture the refreshed framework.",
      validation: transaction.validation,
      cleanup_warnings: transaction.cleanupWarnings,
    });
  }

  const transaction = await applyTransaction({
    target,
    skillRoot,
    release,
    entries,
    previous,
    candidates,
    manifestFile,
    recoveryBoundary,
  });
  output({
    ...preview,
    commit: transaction.commit,
    rollback: `git revert ${transaction.commit}`,
    validation: transaction.validation,
  });
}

async function applyInterviewRefresh({ target, skillRoot, release, entries, previous, candidates, manifestFile }) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const swaps = [];
  const quarantine = path.join(target, ".autopilot", "runtime", `interview-refresh-backup-${nonce}`);
  const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json");
  const blueprintBefore = await readManagedFile(blueprintFile);
  try {
    for (const [relative, bytes] of candidates) {
      const destination = resolveManaged(target, relative);
      await assertSafeDestination(target, destination, { optional: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await assertSafeDestination(target, destination, { optional: true });
      const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-stage-${nonce}`);
      const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-backup-${nonce}`);
      await assertAbsent(stage);
      await assertAbsent(backup);
      const hadDestination = await exists(destination);
      const mode = relative === "control-plane" ? 0o755 : 0o600;
      await writeFile(stage, bytes, { flag: "wx", mode });
      swaps.push({ relative, destination, stage, backup, hadDestination, backupMoved: false, installed: false });
    }

    await performSwaps(swaps);
    if (await exists(path.join(target, "control-plane"))) await chmod(path.join(target, "control-plane"), 0o755);

    const manifest = await createInstalledManifest(skillRoot, target, {
      installedAt: new Date().toISOString(),
      previous,
      kind: "interview-refresh",
    });
    const manifestSwap = await stageManifestSwap(target, manifestFile, manifest, nonce);
    swaps.push(manifestSwap);
    await performSwaps([manifestSwap]);

    const toolCheck = await runNode(
      target,
      path.join(target, ".autopilot", "bin", "configure-tools.mjs"),
      ["--root", target, "--check", "--json"],
    );
    if (toolCheck.code !== 0 || toolCheck.output_truncated) {
      throw upgradeError(`Role-tool validation failed: ${diagnostic(toolCheck)}`, "UPGRADE_VALIDATION_FAILED");
    }
    const validationResult = await runNode(
      target,
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--root", target, "--skip-git", "--json"],
    );
    if (validationResult.code !== 0 || validationResult.output_truncated) {
      throw upgradeError(`Interview refresh validation failed: ${diagnostic(validationResult)}`, "UPGRADE_VALIDATION_FAILED");
    }
    const blueprintAfter = await readManagedFile(blueprintFile);
    if (!blueprintAfter.equals(blueprintBefore)) {
      throw upgradeError("Interview refresh changed the draft blueprint", "INTERVIEW_BLUEPRINT_CHANGED");
    }

    const validation = JSON.parse(validationResult.stdout);
    await assertSafeDestination(target, quarantine, { optional: true });
    await mkdir(quarantine, { recursive: false, mode: 0o700 });
    let backupIndex = 0;
    for (const swap of swaps) {
      if (!swap.backupMoved) continue;
      const retained = path.join(quarantine, `${String(backupIndex).padStart(4, "0")}.backup`);
      backupIndex += 1;
      await assertAbsent(retained);
      await rename(swap.backup, retained);
      swap.backup = retained;
    }
    for (const swap of swaps) swap.backupMoved = false;

    const cleanupWarnings = [];
    try {
      await rm(quarantine, { recursive: true, force: true });
    } catch (error) {
      cleanupWarnings.push(`Validated pre-initialization backups remain in ignored runtime storage: ${error.message}`);
    }
    return { validation, cleanupWarnings };
  } catch (error) {
    const rollbackErrors = [];
    for (const swap of [...swaps].reverse()) {
      try {
        if (swap.installed) await rm(swap.destination, { force: true });
        if (swap.backupMoved) await rename(swap.backup, swap.destination);
        await rm(swap.stage, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${swap.relative}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length === 0) {
      try {
        await rm(quarantine, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`interview refresh quarantine: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw upgradeError(
        `${error.message}; rollback also failed: ${rollbackErrors.join("; ")}; recovery artifacts were retained (quarantine when used: ${quarantine})`,
        "UPGRADE_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
}

async function applyTransaction({ target, skillRoot, release, previous, candidates, manifestFile, recoveryBoundary }) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const swaps = [];
  let committed = false;
  let stagedByGit = false;
  let recoveryApplied = false;
  try {
    for (const [relative, bytes] of candidates) {
      const destination = resolveManaged(target, relative);
      await assertSafeDestination(target, destination, { optional: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await assertSafeDestination(target, destination, { optional: true });
      const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-stage-${nonce}`);
      const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-backup-${nonce}`);
      await assertAbsent(stage);
      await assertAbsent(backup);
      const hadDestination = await exists(destination);
      const mode = relative === "control-plane" ? 0o755 : 0o600;
      await writeFile(stage, bytes, { flag: "wx", mode });
      swaps.push({ relative, destination, stage, backup, hadDestination, backupMoved: false, installed: false });
    }

    await performSwaps(swaps);
    if (await exists(path.join(target, "control-plane"))) await chmod(path.join(target, "control-plane"), 0o755);

    if (["exhausted-corepack-shim", "v1611-corepack-reset-repair", "v1612-dependency-lock"].includes(recoveryBoundary?.kind)) {
      await applyCorepackActiveRecovery(target, recoveryBoundary);
      recoveryApplied = true;
    } else if (isExhaustedRecovery(recoveryBoundary)) {
      await applyExhaustedRecovery(target, recoveryBoundary);
      recoveryApplied = true;
    }

    const installedAt = new Date().toISOString();
    const manifest = await createInstalledManifest(skillRoot, target, {
      installedAt,
      previous,
      kind: isActiveTaskRecovery(recoveryBoundary)
        ? "upgrade-recovery"
        : previous ? "upgrade" : "legacy-adoption",
    });
    if (isActiveTaskRecovery(recoveryBoundary)) {
      Object.assign(manifest.migration_history.at(-1), {
        recovered_task: recoveryBoundary.taskId,
        recovery_reason: recoveryBoundary.kind,
      });
    }
    const manifestSwap = await stageManifestSwap(target, manifestFile, manifest, nonce);
    swaps.push(manifestSwap);
    await performSwaps([manifestSwap]);

    const toolCheck = await runNode(target, path.join(target, ".autopilot", "bin", "configure-tools.mjs"), ["--root", target, "--check", "--json"]);
    if (toolCheck.code !== 0 || toolCheck.output_truncated) {
      throw upgradeError(`Role-tool validation failed: ${diagnostic(toolCheck)}`, "UPGRADE_VALIDATION_FAILED");
    }
    const validationResult = await runNode(target, path.join(target, ".autopilot", "bin", "validate.mjs"), ["--root", target, "--strict", "--skip-git"]);
    if (validationResult.code !== 0 || validationResult.output_truncated) {
      throw upgradeError(`Project validation failed: ${diagnostic(validationResult)}`, "UPGRADE_VALIDATION_FAILED");
    }
    const validation = JSON.parse(validationResult.stdout);

    const changedPaths = [...new Set([...candidates.keys(), ".autopilot/control-plane.json"])].sort();
    await git(target, ["add", "--", ...changedPaths]);
    stagedByGit = true;
    const staged = splitZero((await git(target, ["diff", "--cached", "--name-only", "-z", "--"])).stdout).sort();
    const allowed = new Set(changedPaths);
    const unexpected = staged.filter((relative) => !allowed.has(relative));
    if (unexpected.length > 0 || !staged.includes(".autopilot/control-plane.json")) {
      throw upgradeError("Git staged paths escaped or omitted the required managed upgrade set", "UPGRADE_GIT_SCOPE_MISMATCH", {
        allowed: changedPaths,
        actual: staged,
        unexpected,
      });
    }
    const description = previous
      ? `upgrade ${previous.version} to ${release.version}`
      : `adopt ${release.version}`;
    const projectConfig = await readBoundedJson(
      path.join(target, ".autopilot", "config.json"),
      MANIFEST_BYTES,
    );
    const message = projectConfig.schema_version === 2
      ? controllerCommitMessage(projectConfig.git, description)
      : `control-plane: ${description}`;
    const commitResult = await git(target, ["commit", "--no-verify", "-m", message]);
    const commit = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
    committed = true;
    if (requiresRecoveryBaselineAdvance(recoveryBoundary)) {
      await advanceRecoveryBaseline(target, recoveryBoundary, commit);
    }
    for (const swap of swaps) {
      if (swap.backupMoved) {
        await rm(swap.backup, { force: true });
        swap.backupMoved = false;
      }
      await rm(swap.stage, { force: true });
    }
    await assertCleanGit(target, {
      allowedDirty: isActiveTaskRecovery(recoveryBoundary) || requiresRecoveryBaselineAdvance(recoveryBoundary)
        ? recoveryBoundary.allowedDirty
        : [],
    });
    void commitResult;
    return { commit, validation };
  } catch (error) {
    if (committed) {
      throw upgradeError(`${error.message}; the validated upgrade commit was retained for safe manual revert`, error.code ?? "UPGRADE_POST_COMMIT_FAILED");
    }
    const rollbackErrors = [];
    if (recoveryApplied) {
      try {
        await atomicWriteFile(path.join(target, ".autopilot", "state.json"), recoveryBoundary.stateBytes);
        await atomicWriteFile(path.join(target, ".project", "plan", "queue.json"), recoveryBoundary.queueBytes);
        if (recoveryBoundary.candidateBytes) {
          await atomicWriteFile(path.join(target, ".autopilot", "runtime", "candidate.json"), recoveryBoundary.candidateBytes);
        }
        recoveryApplied = false;
      } catch (rollbackError) {
        rollbackErrors.push(`exhausted task recovery: ${rollbackError.message}`);
      }
    }
    for (const swap of [...swaps].reverse()) {
      try {
        if (swap.installed) await rm(swap.destination, { force: true });
        if (swap.backupMoved) await rename(swap.backup, swap.destination);
        await rm(swap.stage, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${swap.relative}: ${rollbackError.message}`);
      }
    }
    if (stagedByGit) {
      try {
        const paths = [...new Set([...candidates.keys(), ".autopilot/control-plane.json"])];
        await git(target, ["add", "-A", "--", ...paths]);
      } catch (rollbackError) {
        rollbackErrors.push(`Git index: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw upgradeError(`${error.message}; rollback also failed: ${rollbackErrors.join("; ")}`, "UPGRADE_ROLLBACK_FAILED");
    }
    throw error;
  }
}

async function performSwaps(items) {
  for (const item of items) {
    if (item.installed) continue;
    const existsNow = await exists(item.destination);
    if (existsNow !== item.hadDestination) throw upgradeError(`Upgrade target changed during staging: ${item.relative}`, "UPGRADE_RACE");
    if (item.hadDestination) {
      await rename(item.destination, item.backup);
      item.backupMoved = true;
    }
    await rename(item.stage, item.destination);
    item.installed = true;
  }
}

async function stageManifestSwap(target, manifestFile, manifest, nonce) {
  const relative = ".autopilot/control-plane.json";
  await assertSafeDestination(target, manifestFile, { optional: true });
  const stage = path.join(path.dirname(manifestFile), `.${path.basename(manifestFile)}.ocp-stage-${nonce}`);
  const backup = path.join(path.dirname(manifestFile), `.${path.basename(manifestFile)}.ocp-backup-${nonce}`);
  await assertAbsent(stage);
  await assertAbsent(backup);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text) > MANIFEST_BYTES) throw upgradeError("Control Plane manifest exceeds its byte cap", "MANIFEST_TOO_LARGE");
  await writeFile(stage, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    relative,
    destination: manifestFile,
    stage,
    backup,
    hadDestination: await exists(manifestFile),
    backupMoved: false,
    installed: false,
  };
}

async function validatePreviousManifest(target, manifest) {
  if (
    manifest.schema_version !== 1 ||
    manifest.product_id !== "opencode-control-plane" ||
    typeof manifest.version !== "string" ||
    !manifest.managed_files ||
    typeof manifest.managed_files !== "object" ||
    Array.isArray(manifest.managed_files) ||
    Object.keys(manifest.managed_files).length > 256
  ) throw upgradeError("Existing Control Plane manifest is invalid", "INVALID_CONTROL_PLANE_MANIFEST");
  const folded = new Set();
  for (const [relative, record] of Object.entries(manifest.managed_files)) {
    assertManagedPath(relative);
    const key = relative.toLowerCase();
    if (folded.has(key)) throw upgradeError(`Case-colliding managed path: ${relative}`, "INVALID_CONTROL_PLANE_MANIFEST");
    folded.add(key);
    if (!record || !["exact", "normalized-role", "managed-block"].includes(record.mode) || !/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) {
      throw upgradeError(`Invalid ownership record for ${relative}`, "INVALID_CONTROL_PLANE_MANIFEST");
    }
    const file = resolveManaged(target, relative);
    const bytes = await readManagedFile(file);
    if (hashManaged(record.mode, bytes) !== record.sha256) {
      throw upgradeError(
        `Managed framework file changed outside the upgrade system: ${relative}`,
        "CONTROL_PLANE_DRIFT",
        { path: relative },
      );
    }
  }
}

async function assertSafeControllerBoundary(target, state, previous) {
  const lock = path.join(target, ".git", "autopilot-controller.lock");
  if (await exists(lock)) {
    try {
      const value = await readBoundedJson(lock, 16 * 1024);
      process.kill(value.pid, 0);
      throw upgradeError(`Controller PID ${value.pid} is still running`, "CONTROLLER_RUNNING");
    } catch (error) {
      if (error?.code === "EPERM") throw upgradeError("Controller liveness cannot be verified", "CONTROLLER_RUNNING");
      if (error?.code === "CONTROLLER_RUNNING") throw error;
    }
  }
  if (state.completion) throw upgradeError("A task completion transaction is unfinished", "ACTIVE_TRANSACTION");
  if (state.finalization) throw upgradeError("A project finalization transaction is unfinished", "ACTIVE_TRANSACTION");
  const resetCorepackBoundary = await detectResetCorepackBoundary(target, state, previous);
  if (resetCorepackBoundary) return resetCorepackBoundary;
  if (!state.active_task) return null;

  const taskId = state.active_task;
  const attempt = Number(state.attempt ?? 0);
  const queueRelative = ".project/plan/queue.json";
  const queue = await readBoundedJson(path.join(target, ...queueRelative.split("/")), MANIFEST_BYTES, { optional: true });
  const candidate = await readBoundedJson(path.join(target, ".autopilot", "runtime", "candidate.json"), 64 * 1024, { optional: true });
  const head = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
  const legacyRecoverable =
    state.status === "human_required" &&
    state.phase === "blocked" &&
    state.pid === null &&
    state.blocker?.kind === "insufficient_evidence" &&
    state.last_failure_fingerprint === null &&
    state.last_failure_evidence === null &&
    attempt > 1 &&
    typeof state.baseline_head === "string" &&
    state.baseline_head === head &&
    queue?.project_status === "blocked" &&
    queue?.tasks?.[taskId]?.status === "blocked" &&
    candidate?.task_id === taskId &&
    candidate?.attempt === attempt &&
    candidate?.status === "blocked" &&
    candidate?.blocker?.kind === "insufficient_evidence";
  if (legacyRecoverable) {
    return {
      kind: "legacy-insufficient-evidence",
      taskId,
      attempt,
      baselineHead: head,
      currentHead: head,
      stateRevision: Number(state.revision ?? 0),
      blockerKind: "insufficient_evidence",
      allowedDirty: [queueRelative],
    };
  }

  const task = queue?.tasks?.[taskId];
  const literalBoundaryMessage = "Allowed directory entries are not writable as prefixes, and the repository has no pre-existing apps, packages, or tests directories.";
  const literalPathBoundary =
    previous?.version &&
    compareVersions(previous.version, "1.6.8") >= 0 &&
    compareVersions(previous.version, "1.6.9") <= 0 &&
    state.status === "human_required" &&
    state.phase === "blocked" &&
    state.pid === null &&
    state.blocker?.kind === "path_boundary" &&
    state.blocker?.message === literalBoundaryMessage &&
    state.last_failure_fingerprint === null &&
    state.last_failure_evidence === null &&
    attempt === 1 &&
    typeof state.baseline_head === "string" &&
    state.baseline_head === head &&
    queue?.project_status === "blocked" &&
    task?.status === "blocked" &&
    candidate?.task_id === taskId &&
    candidate?.attempt === attempt &&
    candidate?.status === "blocked" &&
    candidate?.blocker?.kind === "path_boundary" &&
    candidate?.blocker?.message === literalBoundaryMessage &&
    JSON.stringify(candidate.blocker) === JSON.stringify(state.blocker) &&
    Array.isArray(task?.allowed_paths) &&
    task.allowed_paths.some((allowed) => typeof allowed === "string" && !/[?*]/.test(allowed));
  if (literalPathBoundary) {
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The blocked path-boundary task contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (taskDirtyPaths.length > 64) {
      throw upgradeError("The blocked path-boundary task has too many preserved application files", "ACTIVE_TASK");
    }
    const allowedDirty = [queueRelative, ...taskDirtyPaths];
    await assertCleanGit(target, { allowedDirty });
    const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
    if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
      throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
    }
    let headQueue;
    try { headQueue = JSON.parse(headQueueResult.stdout); }
    catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
    const projected = structuredClone(queue);
    projected.revision = headQueue.revision;
    projected.project_status = headQueue.project_status;
    if (projected.tasks?.[taskId]) projected.tasks[taskId].status = headQueue.tasks?.[taskId]?.status;
    if (
      headQueue.project_status !== "ready" ||
      headQueue.tasks?.[taskId]?.status !== "ready" ||
      JSON.stringify(projected) !== JSON.stringify(headQueue)
    ) throw upgradeError("The blocked task queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The blocked path-boundary task contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The blocked path-boundary task already has an accepted receipt", "ACTIVE_TASK");
    }
    return {
      kind: "literal-directory-path-boundary",
      taskId,
      attempt,
      baselineHead: head,
      stateRevision: Number(state.revision ?? 0),
      blockerKind: "path_boundary",
      allowedDirty,
    };
  }

  const corepackAttemptLimit = Math.min(
    Number(task?.attempt_limit ?? Number.POSITIVE_INFINITY),
    Number((await readBoundedJson(path.join(target, ".autopilot", "config.json"), MANIFEST_BYTES))?.budgets?.max_attempts_per_task ?? Number.POSITIVE_INFINITY),
  );
  const exhaustedCorepackShim =
    previous?.version === "1.6.10" &&
    state.status === "human_required" &&
    state.phase === "blocked" &&
    state.pid === null &&
    state.blocker?.kind === "gate_configuration" &&
    JSON.stringify(state.blocker) === JSON.stringify(COREPACK_BLOCKER) &&
    state.last_failure_evidence?.failure?.code === "WINDOWS_SHIM_UNSUPPORTED" &&
    typeof state.last_failure_evidence?.failure?.message === "string" &&
    /\\corepack\.cmd has no matching PowerShell shim/.test(state.last_failure_evidence.failure.message) &&
    typeof state.last_failure_fingerprint === "string" &&
    state.last_failure_fingerprint.length > 0 &&
    Number.isFinite(corepackAttemptLimit) && corepackAttemptLimit > 0 && attempt === corepackAttemptLimit &&
    typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" &&
    task?.status === "blocked" &&
    candidate?.task_id === taskId &&
    candidate?.attempt === attempt &&
    candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(COREPACK_BLOCKER);
  if (exhaustedCorepackShim) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The Corepack recovery contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The Corepack recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The blocked Corepack task contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (taskDirtyPaths.length > 128) {
      throw upgradeError("The blocked Corepack task has too many preserved application files", "ACTIVE_TASK");
    }
    const allowedDirty = [queueRelative, ...taskDirtyPaths];
    await assertCleanGit(target, { allowedDirty });
    const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
    if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
      throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
    }
    let headQueue;
    try { headQueue = JSON.parse(headQueueResult.stdout); }
    catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
    const projected = structuredClone(queue);
    projected.revision = headQueue.revision;
    projected.project_status = headQueue.project_status;
    if (projected.tasks?.[taskId]) projected.tasks[taskId].status = headQueue.tasks?.[taskId]?.status;
    if (
      headQueue.project_status !== "ready" ||
      headQueue.tasks?.[taskId]?.status !== "ready" ||
      JSON.stringify(projected) !== JSON.stringify(headQueue)
    ) throw upgradeError("The Corepack task queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    return {
      kind: "exhausted-corepack-shim",
      taskId,
      attempt,
      baselineHead: head,
      currentHead: head,
      stateRevision: Number(state.revision ?? 0),
      blockerKind: "gate_configuration",
      recoveryAttempt: 1,
      allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
      baselineQueueBytes: Buffer.from(headQueueResult.stdout, "utf8"),
    };
  }

  const dependencyLockBoundary =
    previous?.version === "1.6.12" &&
    state.status === "human_required" && state.phase === "blocked" && state.pid === null &&
    state.blocker?.kind === "tooling_authority" &&
    JSON.stringify(state.blocker) === JSON.stringify(DEPENDENCY_LOCK_BLOCKER) &&
    state.last_failure_fingerprint === null && state.last_failure_evidence === null &&
    attempt === 2 && typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" && task?.status === "blocked" &&
    candidate?.task_id === taskId && candidate?.attempt === attempt && candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(DEPENDENCY_LOCK_BLOCKER) &&
    Array.isArray(task?.allowed_paths) &&
    isAllowedPath("package.json", task.allowed_paths) && isAllowedPath("pnpm-lock.yaml", task.allowed_paths);
  if (dependencyLockBoundary) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The dependency-lock recovery contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The dependency-lock recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The dependency-lock recovery contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (taskDirtyPaths.length === 0 || taskDirtyPaths.length > 256) {
      throw upgradeError("The dependency-lock recovery has an invalid preserved application-file count", "ACTIVE_TASK");
    }
    const allowedDirty = [queueRelative, ...taskDirtyPaths];
    await assertCleanGit(target, { allowedDirty });
    const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
    if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
      throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
    }
    let headQueue;
    try { headQueue = JSON.parse(headQueueResult.stdout); }
    catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
    const projected = structuredClone(queue);
    projected.revision = headQueue.revision;
    projected.project_status = headQueue.project_status;
    if (projected.tasks?.[taskId]) projected.tasks[taskId].status = headQueue.tasks?.[taskId]?.status;
    if (
      headQueue.project_status !== "ready" || headQueue.tasks?.[taskId]?.status !== "ready" ||
      JSON.stringify(projected) !== JSON.stringify(headQueue)
    ) throw upgradeError("The dependency-lock queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    return {
      kind: "v1612-dependency-lock", taskId, attempt, recoveryAttempt: 1,
      baselineHead: head, currentHead: head, stateRevision: Number(state.revision ?? 0),
      blockerKind: "tooling_authority", blocker: DEPENDENCY_LOCK_BLOCKER, allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
    };
  }

  const affectedVersion = previous?.version &&
    compareVersions(previous.version, "1.6.3") >= 0 &&
    compareVersions(previous.version, "1.6.5") <= 0;
  const affectedAuthVersion = previous?.version &&
    compareVersions(previous.version, "1.6.6") >= 0 &&
    compareVersions(previous.version, "1.6.7") <= 0 &&
    hasRetainedProviderAuthFailure(state);
  const exhaustedRecoveryKind = affectedAuthVersion
    ? "exhausted-provider-auth"
    : affectedVersion ? "exhausted-empty-opencode" : null;
  const attemptLimit = Math.min(
    Number(task?.attempt_limit ?? Number.POSITIVE_INFINITY),
    Number((await readBoundedJson(path.join(target, ".autopilot", "config.json"), MANIFEST_BYTES))?.budgets?.max_attempts_per_task ?? Number.POSITIVE_INFINITY),
  );
  const runtimeArtifactsAbsent = await Promise.all([
    "candidate.json",
    "review.json",
    "mode-intent.json",
  ].map((name) => exists(path.join(target, ".autopilot", "runtime", name))));
  const receiptAbsent = !(await exists(path.join(target, ".project", "receipts", `${taskId}.json`)));
  const exhaustedShape =
    exhaustedRecoveryKind &&
    state.status === "human_required" &&
    state.phase === "blocked" &&
    state.pid === null &&
    state.blocker?.kind === "repair_exhausted" &&
    state.blocker?.error_code === "OPENCODE_FAILED" &&
    state.last_failure_evidence?.failure?.code === "OPENCODE_FAILED" &&
    typeof state.last_failure_fingerprint === "string" &&
    state.last_failure_fingerprint.length > 0 &&
    Number.isFinite(attemptLimit) && attemptLimit > 0 && attempt === attemptLimit &&
    typeof state.baseline_head === "string" && state.baseline_head === head &&
    ["running", "blocked"].includes(queue?.project_status) &&
    ["in_progress", "blocked"].includes(task?.status) &&
    runtimeArtifactsAbsent.every((present) => !present) &&
    receiptAbsent;
  if (!exhaustedShape) throw upgradeError(`Task ${taskId} is still active; wait for a task boundary`, "ACTIVE_TASK");

  await assertCleanGit(target, { allowedDirty: [queueRelative] });
  const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
  if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
    throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
  }
  let headQueue;
  try { headQueue = JSON.parse(headQueueResult.stdout); }
  catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
  const projected = structuredClone(queue);
  projected.revision = headQueue.revision;
  projected.project_status = headQueue.project_status;
  if (projected.tasks?.[taskId]) projected.tasks[taskId].status = headQueue.tasks?.[taskId]?.status;
  if (
    headQueue.project_status !== "ready" ||
    headQueue.tasks?.[taskId]?.status !== "ready" ||
    JSON.stringify(projected) !== JSON.stringify(headQueue)
  ) throw upgradeError("The active task queue contains changes beyond empty runtime status fields", "ACTIVE_TASK");

  const stateBytes = await readManagedFile(path.join(target, ".autopilot", "state.json"));
  const queueBytes = await readManagedFile(path.join(target, ".project", "plan", "queue.json"));
  return {
    kind: exhaustedRecoveryKind,
    taskId,
    attempt,
    baselineHead: head,
    stateRevision: Number(state.revision ?? 0),
    blockerKind: "repair_exhausted",
    allowedDirty: [queueRelative],
    stateBytes,
    queueBytes,
    baselineQueueBytes: Buffer.from(headQueueResult.stdout, "utf8"),
  };
}

async function detectResetCorepackBoundary(target, state, previous) {
  const migration = previous?.migration_history?.at?.(-1);
  if (
    previous?.version !== "1.6.11" ||
    migration?.from_version !== "1.6.10" ||
    migration?.to_version !== "1.6.11" ||
    migration?.kind !== "upgrade-recovery" ||
    migration?.recovery_reason !== "exhausted-corepack-shim" ||
    typeof migration?.recovered_task !== "string" ||
    state.status !== "paused" ||
    state.phase !== "maintenance" ||
    state.pid !== null ||
    state.active_task !== null ||
    Number(state.attempt ?? -1) !== 0 ||
    state.blocker !== null ||
    state.last_failure_fingerprint !== null ||
    state.last_failure_evidence !== null ||
    typeof state.baseline_head !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(state.baseline_head)
  ) return null;

  const taskId = migration.recovered_task;
  const queueRelative = ".project/plan/queue.json";
  const queueFile = path.join(target, ...queueRelative.split("/"));
  const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
  const queue = await readBoundedJson(queueFile, MANIFEST_BYTES);
  const candidate = await readBoundedJson(candidateFile, 64 * 1024, { optional: true });
  const task = queue?.tasks?.[taskId];
  if (
    queue?.project_status !== "ready" ||
    task?.status !== "ready" ||
    !Array.isArray(task?.allowed_paths) ||
    candidate?.task_id !== taskId ||
    candidate?.status !== "blocked" ||
    JSON.stringify(candidate?.blocker) !== JSON.stringify(COREPACK_BLOCKER)
  ) return null;
  for (const artifact of ["review.json", "mode-intent.json"]) {
    if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
      throw upgradeError("The reset Corepack recovery contains unexpected runtime evidence", "ACTIVE_TASK");
    }
  }
  if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
    throw upgradeError("The reset Corepack recovery task already has an accepted receipt", "ACTIVE_TASK");
  }
  const head = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
  const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
  if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
    throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
  }
  let headQueue;
  try { headQueue = JSON.parse(headQueueResult.stdout); }
  catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
  if (JSON.stringify(queue) !== JSON.stringify(headQueue)) {
    throw upgradeError("The reset Corepack queue differs from the committed ready queue", "ACTIVE_TASK");
  }

  const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
  const taskDirtyPaths = [];
  for (const record of dirtyRecords) {
    const status = record.slice(0, 2);
    const file = record.slice(3).replaceAll("\\", "/");
    if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
      throw upgradeError("The reset Corepack task contains changes outside its approved task paths", "ACTIVE_TASK");
    }
    await assertSafeDestination(target, path.join(target, ...file.split("/")));
    taskDirtyPaths.push(file);
  }
  if (taskDirtyPaths.length === 0 || taskDirtyPaths.length > 128) {
    throw upgradeError("The reset Corepack task has an invalid preserved application-file count", "ACTIVE_TASK");
  }
  const allowedDirty = [queueRelative, ...taskDirtyPaths];
  await assertCleanGit(target, { allowedDirty });
  return {
    kind: "v1611-corepack-reset-repair",
    taskId,
    attempt: 0,
    recoveryAttempt: 1,
    baselineHead: state.baseline_head,
    currentHead: head,
    stateRevision: Number(state.revision ?? 0),
    blockerKind: null,
    allowedDirty,
    stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
    queueBytes: await readManagedFile(queueFile),
    candidateBytes: await readManagedFile(candidateFile),
  };
}

function isExhaustedRecovery(boundary) {
  return ["exhausted-empty-opencode", "exhausted-provider-auth"].includes(boundary?.kind);
}

function isActiveTaskRecovery(boundary) {
  return isExhaustedRecovery(boundary) || [
    "literal-directory-path-boundary",
    "exhausted-corepack-shim",
    "v1611-corepack-reset-repair",
    "v1612-dependency-lock",
  ].includes(boundary?.kind);
}

function requiresRecoveryBaselineAdvance(boundary) {
  return [
    "legacy-insufficient-evidence",
    "literal-directory-path-boundary",
    "exhausted-corepack-shim",
    "v1611-corepack-reset-repair",
    "v1612-dependency-lock",
  ].includes(boundary?.kind);
}

function hasRetainedProviderAuthFailure(state) {
  if (state?.last_failure_evidence?.failure?.code !== "OPENCODE_FAILED") return false;
  const excerpt = state.last_failure_evidence.failure.details_excerpt;
  if (typeof excerpt !== "string" || excerpt.length === 0 || excerpt.length > 4096) return false;
  let details;
  try { details = JSON.parse(excerpt); }
  catch { return false; }
  if (details?.code !== 1 || typeof details?.diagnostic_excerpt !== "string") return false;
  for (const line of details.diagnostic_excerpt.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    const message = event?.type === "error" && typeof event?.error?.data?.message === "string"
      ? event.error.data.message
      : "";
    if (/(?:token refresh failed|authentication failed|unauthorized|invalid (?:access |refresh )?token|expired (?:access |refresh )?token)/i.test(message)) {
      return true;
    }
  }
  return false;
}

async function applyExhaustedRecovery(target, boundary) {
  const stateFile = path.join(target, ".autopilot", "state.json");
  const current = await readBoundedJson(stateFile, 64 * 1024);
  if (
    current.revision !== boundary.stateRevision ||
    current.status !== "human_required" ||
    current.phase !== "blocked" ||
    current.active_task !== boundary.taskId ||
    current.attempt !== boundary.attempt ||
    current.baseline_head !== boundary.baselineHead ||
    current.blocker?.kind !== boundary.blockerKind ||
    (boundary.kind !== "exhausted-corepack-shim" && current.blocker?.error_code !== "OPENCODE_FAILED")
  ) throw upgradeError("Blocked task state changed during the framework upgrade", "UPGRADE_RACE");
  const next = {
    ...current,
    revision: Number(current.revision ?? 0) + 1,
    run_id: null,
    status: "paused",
    phase: "maintenance",
    pid: null,
    started_at: null,
    heartbeat_at: new Date().toISOString(),
    completed_in_run: 0,
    active_task: null,
    attempt: 0,
    no_progress_count: 0,
    last_progress_hash: null,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    last_session: null,
    session_ids: [],
    task_tool_usage: {},
    blocker: null,
    completion: null,
    finalization: null,
  };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > 64 * 1024) {
    throw upgradeError("Controller state exceeds its recovery cap", "STATE_CAPACITY_EXHAUSTED");
  }
  await atomicWriteFile(path.join(target, ".project", "plan", "queue.json"), boundary.baselineQueueBytes);
  await atomicWriteFile(stateFile, contents);
}

async function applyCorepackActiveRecovery(target, boundary) {
  const stateFile = path.join(target, ".autopilot", "state.json");
  const queueFile = path.join(target, ".project", "plan", "queue.json");
  const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
  const [current, queue, candidate] = await Promise.all([
    readBoundedJson(stateFile, 64 * 1024),
    readBoundedJson(queueFile, MANIFEST_BYTES),
    readBoundedJson(candidateFile, 64 * 1024),
  ]);
  const originalBlocked = ["exhausted-corepack-shim", "v1612-dependency-lock"].includes(boundary.kind);
  const expectedBlocker = boundary.kind === "v1612-dependency-lock" ? DEPENDENCY_LOCK_BLOCKER : COREPACK_BLOCKER;
  const stateMatches = originalBlocked
    ? current.revision === boundary.stateRevision &&
      current.status === "human_required" && current.phase === "blocked" &&
      current.pid === null && current.active_task === boundary.taskId &&
      current.attempt === boundary.attempt && current.baseline_head === boundary.baselineHead &&
      JSON.stringify(current.blocker) === JSON.stringify(expectedBlocker)
    : current.revision === boundary.stateRevision &&
      current.status === "paused" && current.phase === "maintenance" &&
      current.pid === null && current.active_task === null && current.attempt === 0 &&
      current.baseline_head === boundary.baselineHead && current.blocker === null;
  if (
    !stateMatches ||
    candidate?.task_id !== boundary.taskId ||
    candidate?.status !== "blocked" ||
    JSON.stringify(candidate?.blocker) !== JSON.stringify(expectedBlocker) ||
    !queue?.tasks?.[boundary.taskId]
  ) throw upgradeError("Corepack recovery state changed during the framework upgrade", "UPGRADE_RACE");

  const nextQueue = structuredClone(queue);
  if (nextQueue.project_status !== "blocked" || nextQueue.tasks[boundary.taskId].status !== "blocked") {
    nextQueue.revision = Number(nextQueue.revision ?? 0) + 1;
    nextQueue.project_status = "blocked";
    nextQueue.tasks[boundary.taskId].status = "blocked";
  }
  const nextState = {
    ...current,
    revision: Number(current.revision ?? 0) + 1,
    run_id: null,
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: null,
    heartbeat_at: new Date().toISOString(),
    active_task: boundary.taskId,
    attempt: boundary.recoveryAttempt,
    no_progress_count: 0,
    last_progress_hash: null,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    last_session: null,
    session_ids: [],
    baseline_head: boundary.currentHead,
    blocker: expectedBlocker,
    completion: null,
    finalization: null,
  };
  const stateContents = `${JSON.stringify(nextState, null, 2)}\n`;
  const queueContents = `${JSON.stringify(nextQueue, null, 2)}\n`;
  if (Buffer.byteLength(stateContents, "utf8") > 64 * 1024 || Buffer.byteLength(queueContents, "utf8") > MANIFEST_BYTES) {
    throw upgradeError("Corepack recovery state exceeds its bounded capacity", "STATE_CAPACITY_EXHAUSTED");
  }
  await atomicWriteFile(queueFile, queueContents);
  await atomicWriteFile(stateFile, stateContents);
  await rm(candidateFile, { force: true });
}

async function advanceRecoveryBaseline(target, boundary, commit) {
  const stateFile = path.join(target, ".autopilot", "state.json");
  const state = await readBoundedJson(stateFile, 64 * 1024);
  const corepackRecovery = ["exhausted-corepack-shim", "v1611-corepack-reset-repair", "v1612-dependency-lock"].includes(boundary.kind);
  const expectedRevision = corepackRecovery ? boundary.stateRevision + 1 : boundary.stateRevision;
  const expectedAttempt = corepackRecovery ? boundary.recoveryAttempt : boundary.attempt;
  const expectedBaseline = corepackRecovery ? boundary.currentHead : boundary.baselineHead;
  const expectedBlocker = boundary.kind === "v1612-dependency-lock"
    ? "tooling_authority"
    : corepackRecovery ? "gate_configuration" : boundary.blockerKind;
  if (
    state.revision !== expectedRevision ||
    state.status !== "human_required" ||
    state.phase !== "blocked" ||
    state.active_task !== boundary.taskId ||
    state.attempt !== expectedAttempt ||
    state.baseline_head !== expectedBaseline ||
    state.blocker?.kind !== expectedBlocker
  ) throw upgradeError("Blocked task state changed during the framework upgrade", "UPGRADE_RACE");
  const next = {
    ...state,
    revision: Number(state.revision ?? 0) + 1,
    heartbeat_at: new Date().toISOString(),
    baseline_head: commit,
  };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents) > 64 * 1024) {
    throw upgradeError("Controller state exceeds its recovery cap", "STATE_CAPACITY_EXHAUSTED");
  }
  await atomicWriteFile(stateFile, contents);
}

async function assertInterviewBoundary(target, state) {
  if (
    state.status !== "idle" || state.phase !== "idle" || state.pid !== null ||
    state.active_task !== null || state.completion !== null || state.finalization !== null
  ) {
    throw upgradeError("Interview refresh requires the untouched idle initialization boundary", "INTERVIEW_REFRESH_DENIED");
  }
  const queue = await readBoundedJson(path.join(target, ".project", "plan", "queue.json"), MANIFEST_BYTES);
  if (queue?.project_status !== "initializing") {
    throw upgradeError("Interview refresh is allowed only before blueprint finalization", "INTERVIEW_REFRESH_DENIED");
  }
  await readManagedFile(path.join(target, ".autopilot", "init", "blueprint.json"));
  for (const forbidden of [
    path.join(target, "blueprints", "current", "record.json"),
    path.join(target, "blueprints", "current", "render-manifest.json"),
    path.join(target, "blueprints", "v1"),
  ]) {
    if (await exists(forbidden)) {
      throw upgradeError("Interview refresh refuses an already rendered or versioned blueprint", "INTERVIEW_REFRESH_DENIED");
    }
  }
}

async function assertStandaloneProject(target) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(target)) !== path.resolve(target)) {
    throw upgradeError("Project root must be one real directory", "UNSAFE_PROJECT_ROOT");
  }
  const gitDirectory = path.join(target, ".git");
  const gitInfo = await lstat(gitDirectory);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || path.resolve(await realpath(gitDirectory)) !== path.resolve(gitDirectory)) {
    throw upgradeError("Project must use a real local .git directory", "UNSAFE_GIT_LAYOUT");
  }
  const top = (await git(target, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (normalizePath(top) !== normalizePath(target)) throw upgradeError("Project must be the exact Git worktree root", "UNSAFE_GIT_LAYOUT");
  await access(path.join(target, ".autopilot", "config.json"));
}

async function assertCleanGit(target, { allowedDirty = [] } = {}) {
  const status = (await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const allowed = new Set(allowedDirty);
  const dirty = splitZero(status);
  const unexpected = dirty.filter((record) => {
    const file = record.slice(3).replaceAll("\\", "/");
    return ![" M", "??"].includes(record.slice(0, 2)) || !allowed.has(file);
  });
  if (unexpected.length > 0) {
    throw upgradeError("Commit or discard existing project changes before upgrading the Control Plane", "DIRTY_WORKTREE");
  }
  const tagged = splitZero((await git(target, ["ls-files", "-v", "-z"])).stdout);
  const unsafeFlags = tagged.filter((record) => !record.startsWith("H "));
  if (unsafeFlags.length > 0) {
    throw upgradeError(
      `Clear nonstandard Git index flags before upgrading: ${unsafeFlags.slice(0, 8).join(", ")}`,
      "UNSAFE_GIT_INDEX",
      { entries: unsafeFlags.slice(0, 64) },
    );
  }
}

async function assertSafeDestination(root, destination, { optional = false } = {}) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw upgradeError(`Managed destination escapes the project: ${destination}`, "UNSAFE_MANAGED_PATH");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) throw upgradeError(`Managed destination traverses a link: ${current}`, "UNSAFE_MANAGED_PATH");
  }
  if (!optional) await readManagedFile(destination);
}

async function readManagedFile(file, { optional = false } = {}) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 2 * 1024 * 1024) {
      throw upgradeError(`Managed path is not one bounded private regular file: ${file}`, "UNSAFE_MANAGED_PATH");
    }
    return readFile(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readBoundedJson(file, cap, { optional = false } = {}) {
  try {
    const bytes = await readManagedFile(file);
    if (bytes.length > cap) throw upgradeError(`JSON file exceeds ${cap} bytes: ${file}`, "MANIFEST_TOO_LARGE");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function runNode(cwd, script, arguments_) {
  return runExternal([process.execPath, script, ...arguments_], cwd);
}

async function git(cwd, arguments_) {
  const environment = await externalExecutionEnv(cwd);
  const executable = await resolveExternalGitExecutable(cwd, environment, { label: "Control Plane upgrade Git executable" });
  const safeAmbientConfig = await gitSafeAmbientConfigArgs(cwd, executable, environment);
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = await runExternal([
    executable,
    "--no-pager",
    "--no-replace-objects",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "credential.interactive=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", `core.excludesFile=${nullDevice}`,
    ...safeAmbientConfig,
    ...arguments_,
  ], cwd, {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_LITERAL_PATHSPECS: "1",
    SSH_ASKPASS_REQUIRE: "never",
  });
  if (result.code !== 0 || result.timed_out || result.output_truncated) {
    throw upgradeError(`git ${arguments_[0]} failed: ${diagnostic(result)}`, "UPGRADE_GIT_FAILED");
  }
  return result;
}

async function runExternal(argv, cwd, environment = safeBaseEnv()) {
  const raw = await runArgv(argv, {
    cwd,
    env: environment,
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: PROCESS_OUTPUT_BYTES,
    guardProcessTree: true,
  });
  return sanitizeProcessResult(raw, [], PROCESS_OUTPUT_BYTES);
}

function resolveManaged(root, relative) {
  assertManagedPath(relative);
  const resolved = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(root, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) throw upgradeError(`Managed path escapes project: ${relative}`, "UNSAFE_MANAGED_PATH");
  return resolved;
}

function compareVersions(left, right) {
  const parts = (value) => String(value).split("-")[0].split(".").map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function splitZero(value) {
  return value.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
}

function diagnostic(result) {
  return String(result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`).replace(/[\r\n]+/g, " ").trim().slice(0, 4096);
}

function upgradeError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function parseArgs(argv) {
  const result = { target: null, sourceSkill: null, dryRun: false, adopt: false, interview: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--target", "--source-skill"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error(`${value} requires a path`);
      if (value === "--target") result.target = selected;
      else result.sourceSkill = selected;
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--adopt") result.adopt = true;
    else if (value === "--interview") result.interview = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") {
      process.stdout.write("Usage: upgrade-project.mjs [--target PATH] [--source-skill PATH] [--dry-run] [--adopt | --interview] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (result.adopt && result.interview) throw new Error("--adopt and --interview are mutually exclusive");
  return result;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, args.json ? 0 : 2)}\n`);
}

async function exists(location) {
  try { await lstat(location); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function assertAbsent(location) {
  if (await exists(location)) throw upgradeError(`Temporary upgrade path already exists: ${location}`, "UPGRADE_TEMP_COLLISION");
}
