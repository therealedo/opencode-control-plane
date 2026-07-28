#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertManagedPath,
  collectManagedSources,
  createInstalledManifest,
  hashManaged,
  mergeManagedSource,
} from "./lib/control-plane-files.mjs";
import {
  atomicWriteFile,
  inspectProcessLock,
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
import { acquireProjectLease } from "../assets/project/.autopilot/bin/lib/git.mjs";
import {
  upgradeBaseGitignoreFragment,
} from "../assets/project/.autopilot/bin/lib/gitignore.mjs";

const PROCESS_TIMEOUT_MS = 10 * 60_000;
const PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MANIFEST_BYTES = 512 * 1024;
const RECOVERY_ROLLBACK_BYTES = 1024 * 1024;
const RECOVERY_ROLLBACK_PREFIX = "control-plane-upgrade-rollback-";
const V170_PROJECT_LOCAL_OVERLAP = new Set([
  ".autopilot/bin/manual-mode.mjs",
  ".opencode/commands/evolve-project.md",
  ".opencode/commands/init-project.md",
  "manual-mode",
  "manual-mode.cmd",
]);
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
const LOCKFILE_TELEMETRY_BLOCKER = Object.freeze({
  kind: "gate_infrastructure",
  message: "The controller-owned unit gate is invoking OpenCode with invalid usage, so repository behavior cannot be evaluated.",
  required_action: "Correct the controller gate invocation; do not change repository scripts, gate definitions, or control files to mask it.",
  resume_condition: "Resume when the approved unit gate runs its intended credential-free test command.",
});
const CONTROLLER_RUNNER_BLOCKER = Object.freeze({
  kind: "controller_tooling",
  message: "Credential-free controller actions are unavailable/misrouted; pnpm-lock.yaml remains without resolved package snapshots, so frozen-install and required gate evidence cannot be produced safely.",
  required_action: "Restore the controller-owned pnpm lockfile resolver and gate runner, then rerun this phase.",
  resume_condition: "autopilot_lockfile can generate a complete pnpm 11.14.0 workspace lockfile and the listed gates execute their repository scripts.",
});
const GATE_CLEANUP_BLOCKER = Object.freeze({
  kind: "environment",
  message: "The controller gate runner reports GATE_CLEANUP_FAILED before gate execution.",
  required_action: "Repair or clear the controller-owned gate sandbox/cleanup state, then start a fresh repair attempt.",
  resume_condition: "Credential-free gates can execute and return application diagnostics.",
});
const REPAIRED_CONTROLLER_BLOCKER = Object.freeze({
  kind: "controller_tooling",
  message: "The Control Plane upgrade repaired the controller-owned tooling while preserving the active task and its application changes.",
  required_action: "Run the zero-token readiness check, then use explicit Resume to retry the preserved task.",
  resume_condition: "Readiness reports ready and the user explicitly resumes the preserved task.",
});
const args = parseArgs(process.argv.slice(2));
const defaultSkillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await main().then(output).catch((error) => {
  const result = { ok: false, error: error.message, code: error.code ?? "UPGRADE_FAILED", details: error.details ?? null };
  process.stderr.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const skillRoot = path.resolve(args.sourceSkill ?? defaultSkillRoot);
  const target = path.resolve(args.target ?? process.cwd());
  await assertStandaloneProject(target);
  const projectLease = args.dryRun
    ? null
    : await acquireProjectLease(target, path.join(target, ".git", "autopilot-controller.lock"), {
      pid: process.pid,
      root: target,
      started_at: new Date().toISOString(),
    });
  try {
  if (args.rollbackRecovery) {
    if (!projectLease) throw upgradeError("Recovery rollback requires the exclusive project lease", "ROLLBACK_LOCK_REQUIRED");
    return applyRecoveryRollback(target, args.rollbackRecovery);
  }
  const { release, entries } = await collectManagedSources(skillRoot);
  const manifestFile = path.join(target, ".autopilot", "control-plane.json");
  const previous = await readBoundedJson(manifestFile, MANIFEST_BYTES, { optional: true });
  if (!previous && !args.adopt) {
    throw upgradeError(
      "This project predates versioned Control Plane ownership. Review the managed-file preview and rerun with --adopt; product files are never included.",
      "ADOPTION_REQUIRED",
    );
  }
  const trustedLocalInstallPaths = previous
    ? await trustedProjectLocalInstallPaths(target, release, entries, previous)
    : new Set();
  if (previous) await validatePreviousManifest(target, previous, { trustedLocalInstallPaths });
  const state = await readBoundedJson(path.join(target, ".autopilot", "state.json"), 64 * 1024, { optional: true }) ?? {};
  const recoveryBoundary = await assertSafeControllerBoundary(target, state, previous, {
    leaseOwned: projectLease !== null,
    trustedLocalInstallPaths,
  });
  if (previous && compareVersions(previous.version, release.version) > 0) {
    throw upgradeError(`Downgrades are not allowed (${previous.version} -> ${release.version})`, "DOWNGRADE_DENIED");
  }
  if (args.interview) {
    if (args.adopt || !previous) throw upgradeError("Interview refresh requires existing versioned ownership", "INTERVIEW_REFRESH_DENIED");
    await assertInterviewBoundary(target, state);
  } else {
    await assertCleanGit(target, {
      allowedDirty: [...new Set([
        ...(recoveryBoundary?.allowedDirty ?? []),
        ...trustedLocalInstallPaths,
      ])],
    });
  }

  const candidates = new Map();
  for (const [relative, entry] of entries) {
    const destination = resolveManaged(target, relative);
    const current = await readManagedFile(destination, { optional: true });
    if (trustedLocalInstallPaths.has(relative)) {
      candidates.set(relative, Buffer.from(entry.bytes));
      continue;
    }
    if (!current && entry.mode !== "exact") {
      candidates.set(relative, Buffer.from(entry.bytes));
      continue;
    }
    const candidate = mergeManagedSource(entry, current ?? Buffer.alloc(0), { adopt: args.adopt && !previous });
    if (!current || !candidate.equals(current)) candidates.set(relative, candidate);
  }
  const gitignoreCandidate = await planBaseGitignoreUpgrade(target);
  if (gitignoreCandidate) candidates.set(".gitignore", gitignoreCandidate);

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
    reconciled_local_install_files: [...trustedLocalInstallPaths].sort(),
  };
  if (args.dryRun) return preview;
  if (!preview.changed) return { ...preview, commit: null, rollback: null };

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
    return {
      ...preview,
      interview_refreshed: true,
      commit: null,
      rollback: "The normal initialization baseline commit will capture the refreshed framework.",
      validation: transaction.validation,
      cleanup_warnings: transaction.cleanupWarnings,
    };
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
  return {
    ...preview,
    commit: transaction.commit,
    rollback: transaction.rollbackAction ?? `git revert ${transaction.commit}`,
    validation: transaction.validation,
  };
  } finally {
    if (projectLease) await projectLease.release();
  }
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
  let rollbackAction = null;
  if (isActiveTaskRecovery(recoveryBoundary) || requiresRecoveryBaselineAdvance(recoveryBoundary)) {
    assertSnapshotBound("captured recovery state", recoveryBoundary.stateBytes, 64 * 1024);
    assertSnapshotBound("captured recovery queue", recoveryBoundary.queueBytes, MANIFEST_BYTES);
    if (recoveryBoundary.candidateBytes !== null) {
      assertSnapshotBound("captured recovery candidate", recoveryBoundary.candidateBytes, 64 * 1024);
    }
    if (recoveryBoundary.maintenanceBytes !== null && recoveryBoundary.maintenanceBytes !== undefined) {
      assertSnapshotBound("captured maintenance sentinel", recoveryBoundary.maintenanceBytes, 1024);
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recoveryBoundary.currentHead ?? "")) {
      throw upgradeError("Captured recovery HEAD is invalid", "ACTIVE_TASK");
    }
  }
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

    await validateInstalledControllerRuntime(target);
    if (recoveryBoundary?.kind === "controller-tool-structural") {
      recoveryApplied = true;
      await applyStructuralControllerToolRecovery(target, recoveryBoundary);
    } else if (["exhausted-corepack-shim", "v1611-corepack-reset-repair", "v1612-dependency-lock", "v1613-lockfile-telemetry", "v1614-controller-runner", "v1617-gate-cleanup"].includes(recoveryBoundary?.kind)) {
      recoveryApplied = true;
      await applyCorepackActiveRecovery(target, recoveryBoundary);
    } else if (isExhaustedRecovery(recoveryBoundary)) {
      recoveryApplied = true;
      await applyExhaustedRecovery(target, recoveryBoundary);
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
      recoveryApplied = true;
      await advanceRecoveryBaseline(target, recoveryBoundary, commit);
    }
    if (isActiveTaskRecovery(recoveryBoundary)) {
      rollbackAction = await createRecoveryRollbackArtifact(target, recoveryBoundary, commit);
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
    if (recoveryBoundary?.kind === "controller-tool-structural" && Buffer.isBuffer(recoveryBoundary.maintenanceBytes)) {
      await clearRecoveredMaintenanceSentinel(target, recoveryBoundary.maintenanceBytes);
    }
    void commitResult;
    return { commit, validation, rollbackAction };
  } catch (error) {
    if (committed) {
      const recoveryRollbackErrors = [];
      if (recoveryApplied) {
        try {
          await atomicWriteFile(path.join(target, ".autopilot", "state.json"), recoveryBoundary.stateBytes);
          await atomicWriteFile(path.join(target, ".project", "plan", "queue.json"), recoveryBoundary.queueBytes);
          const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
          if (recoveryBoundary.candidateBytes) {
            await atomicWriteFile(candidateFile, recoveryBoundary.candidateBytes);
          } else {
            await rm(candidateFile, { force: true });
          }
        } catch (rollbackError) {
          recoveryRollbackErrors.push(rollbackError.message);
        }
      }
      throw upgradeError(
        `${error.message}; the validated upgrade commit was retained for safe manual revert${
          recoveryRollbackErrors.length > 0
            ? `, but runtime recovery rollback also failed: ${recoveryRollbackErrors.join("; ")}`
            : " and the pre-upgrade runtime boundary was restored"
        }`,
        recoveryRollbackErrors.length > 0
          ? "UPGRADE_ROLLBACK_FAILED"
          : error.code ?? "UPGRADE_POST_COMMIT_FAILED",
      );
    }
    const rollbackErrors = [];
    if (recoveryApplied) {
      try {
        await atomicWriteFile(path.join(target, ".autopilot", "state.json"), recoveryBoundary.stateBytes);
        await atomicWriteFile(path.join(target, ".project", "plan", "queue.json"), recoveryBoundary.queueBytes);
        if (recoveryBoundary.candidateBytes) {
          await atomicWriteFile(path.join(target, ".autopilot", "runtime", "candidate.json"), recoveryBoundary.candidateBytes);
        } else {
          await rm(path.join(target, ".autopilot", "runtime", "candidate.json"), { force: true });
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

async function validatePreviousManifest(target, manifest, { trustedLocalInstallPaths = new Set() } = {}) {
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
      if (trustedLocalInstallPaths.has(relative)) continue;
      throw upgradeError(
        `Managed framework file changed outside the upgrade system: ${relative}`,
        "CONTROL_PLANE_DRIFT",
        { path: relative },
      );
    }
  }
}

async function trustedProjectLocalInstallPaths(target, release, entries, previous) {
  if (compareVersions(previous.version, release.version) >= 0) return new Set();
  const file = path.join(target, ".opencode-control-plane", "install.json");
  const manifest = await readBoundedJson(file, MANIFEST_BYTES, { optional: true });
  if (!manifest) return new Set();
  if (
    manifest.schema_version !== 1 || manifest.product_id !== "opencode-control-plane" ||
    typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.version !== "1.7.0" ||
    compareVersions(previous.version, manifest.version) >= 0 ||
    compareVersions(manifest.version, release.version) >= 0 ||
    manifest.repository !== release.repository ||
    typeof manifest.target !== "string" || !path.isAbsolute(manifest.target) ||
    normalizePath(manifest.target ?? "") !== normalizePath(target) ||
    !Array.isArray(manifest.outputs) || manifest.outputs.length < 1 || manifest.outputs.length > 64
  ) return new Set();

  const outputs = new Map();
  for (const output of manifest.outputs) {
    if (
      !output || typeof output !== "object" || Array.isArray(output) ||
      Object.keys(output).sort().join("\0") !== "relative\0sha256" ||
      typeof output.relative !== "string" || !/^[0-9a-f]{64}$/.test(output.sha256 ?? "") ||
      outputs.has(output.relative.toLowerCase())
    ) return new Set();
    outputs.set(output.relative.toLowerCase(), output);
  }

  const status = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
  const dirty = new Map();
  for (const record of status) {
    if (record.length < 4) continue;
    dirty.set(record.slice(3).replaceAll("\\", "/").toLowerCase(), record.slice(0, 2));
  }
  const trusted = new Set();
  for (const [relative, entry] of entries) {
    if (entry.mode !== "exact" || !V170_PROJECT_LOCAL_OVERLAP.has(relative)) continue;
    const record = outputs.get(relative.toLowerCase());
    const worktreeStatus = dirty.get(relative.toLowerCase());
    if (!record || ![" M", "??"].includes(worktreeStatus)) continue;
    if (record.sha256 !== treeSha256Bytes(entry.bytes)) continue;
    const current = await readManagedFile(resolveManaged(target, relative), { optional: true });
    if (current?.equals(entry.bytes)) trusted.add(relative);
  }
  return trusted;
}

async function planBaseGitignoreUpgrade(target) {
  const file = resolveManaged(target, ".gitignore");
  const current = await readManagedFile(file);
  if (current.length > 256 * 1024) {
    throw upgradeError("Project .gitignore exceeds the safe migration limit", "GITIGNORE_MIGRATION_UNSAFE");
  }
  const migrated = upgradeBaseGitignoreFragment(current.toString("utf8"));
  if (migrated === null) {
    throw upgradeError(
      "Project .gitignore does not contain one recognized final Control Plane base-ignore fragment",
      "GITIGNORE_MIGRATION_UNSAFE",
    );
  }
  const bytes = Buffer.from(migrated, "utf8");
  return bytes.equals(current) ? null : bytes;
}

async function assertSafeControllerBoundary(target, state, previous, {
  leaseOwned = false,
  trustedLocalInstallPaths = new Set(),
} = {}) {
  if (!leaseOwned) {
    const lock = path.join(target, ".git", "autopilot-controller.lock");
    const lockInspection = await inspectProcessLock(lock, { expectedRoot: target });
    if (lockInspection.status === "live") {
      throw upgradeError(`Controller PID ${lockInspection.record?.pid ?? "unknown"} is still running`, "CONTROLLER_RUNNING");
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
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ...queueRelative.split("/"))),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
    };
  }

  const task = queue?.tasks?.[taskId];
  // Older releases retain their already-shipped exact bridges. v1.6.18 is the
  // final free-form legacy state; new releases use trusted machine fault data.
  const legacyControllerFaultVersion = previous?.version === "1.6.18";
  const trustedControllerFault =
    candidate === null &&
    Array.isArray(state.last_failure_evidence?.controller_faults) &&
    state.last_failure_evidence.controller_faults.length > 0 &&
    state.last_failure_evidence.controller_faults.length <= 8 &&
    state.last_failure_evidence.controller_faults.every((fault) =>
      fault && typeof fault === "object" && !Array.isArray(fault) &&
      Object.keys(fault).every((key) => ["operation", "error_code"].includes(key)) &&
      typeof fault.operation === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(fault.operation) &&
      typeof fault.error_code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fault.error_code)
    );
  const legacyControllerFault =
    legacyControllerFaultVersion &&
    candidate?.task_id === taskId && candidate?.attempt === attempt &&
    candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(state.blocker);
  const priorMigration = Array.isArray(previous?.migration_history)
    ? previous.migration_history.at(-1)
    : null;
  const priorRecoveryFailure = state.last_failure_evidence?.failure;
  const priorStructuralFromVersion = new Map([
    ["1.6.19", "1.6.18"],
    ["1.6.20", "1.6.19"],
  ]).get(previous?.version);
  const priorStructuralRecovery =
    priorStructuralFromVersion !== undefined &&
    candidate === null &&
    state.run_id === null && state.started_at === null &&
    state.last_failure_fingerprint === null && state.no_progress_count === 0 &&
    state.last_session === null && Array.isArray(state.session_ids) && state.session_ids.length === 0 &&
    state.last_failure_evidence && typeof state.last_failure_evidence === "object" &&
    !Array.isArray(state.last_failure_evidence) &&
    Object.keys(state.last_failure_evidence).sort().join("\0") === "failure" &&
    priorRecoveryFailure && typeof priorRecoveryFailure === "object" && !Array.isArray(priorRecoveryFailure) &&
    Object.keys(priorRecoveryFailure).sort().join("\0") === "code\0message" &&
    priorRecoveryFailure.code === "CONTROLLER_TOOL_RECOVERED" &&
    typeof priorRecoveryFailure.message === "string" && priorRecoveryFailure.message.length > 0 &&
    priorRecoveryFailure.message.length <= 1024 &&
    priorMigration && typeof priorMigration === "object" && !Array.isArray(priorMigration) &&
    Object.keys(priorMigration).sort().join("\0") ===
      "applied_at\0from_version\0kind\0recovered_task\0recovery_reason\0to_version" &&
    priorMigration.from_version === priorStructuralFromVersion && priorMigration.to_version === previous.version &&
    priorMigration.kind === "upgrade-recovery" && priorMigration.recovered_task === taskId &&
    priorMigration.recovery_reason === "controller-tool-structural" &&
    typeof priorMigration.applied_at === "string" && Number.isFinite(Date.parse(priorMigration.applied_at));
  const dependencyFault = trustedControllerFault && state.last_failure_evidence.controller_faults
    .some((fault) => fault.operation === "dependency-lock");
  const dependencyBoundaryApproved =
    Array.isArray(task?.allowed_paths) &&
    isAllowedPath("package.json", task.allowed_paths) &&
    isAllowedPath("pnpm-lock.yaml", task.allowed_paths);
  const structuralControllerFault =
    previous?.version &&
    state.status === "human_required" && state.phase === "blocked" && state.pid === null &&
    state.blocker?.kind === "controller_tooling" &&
    attempt >= 0 && typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" && task?.status === "blocked" &&
    Array.isArray(task?.allowed_paths) &&
    (legacyControllerFault || trustedControllerFault || priorStructuralRecovery) &&
    (!legacyControllerFault || dependencyBoundaryApproved) &&
    (!priorStructuralRecovery || dependencyBoundaryApproved) &&
    (!dependencyFault || dependencyBoundaryApproved);
  if (structuralControllerFault) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The controller-tool recovery contains unexpected accepted-phase evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The controller-tool recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    const installerDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (trustedLocalInstallPaths.has(file) && [" M", "??"].includes(status)) {
        installerDirtyPaths.push(file);
        continue;
      }
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The controller-tool recovery contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (taskDirtyPaths.length > 512) {
      throw upgradeError("The controller-tool recovery exceeds its preserved-file limit", "ACTIVE_TASK");
    }
    const allowedDirty = [queueRelative, ...installerDirtyPaths, ...taskDirtyPaths];
    await assertCleanGit(target, { allowedDirty });
    const headQueueResult = await git(target, ["show", `HEAD:${queueRelative}`]);
    if (Buffer.byteLength(headQueueResult.stdout, "utf8") > MANIFEST_BYTES) {
      throw upgradeError("Baseline queue exceeds its recovery cap", "ACTIVE_TASK");
    }
    let headQueue;
    try { headQueue = JSON.parse(headQueueResult.stdout); }
    catch { throw upgradeError("Baseline queue is not valid JSON", "ACTIVE_TASK"); }
    const expectedQueue = structuredClone(headQueue);
    const done = new Set(Object.entries(expectedQueue.tasks ?? {})
      .filter(([, queuedTask]) => queuedTask?.status === "done")
      .map(([id]) => id));
    for (const queuedTask of Object.values(expectedQueue.tasks ?? {})) {
      if (
        queuedTask?.status === "pending" &&
        Array.isArray(queuedTask.depends_on) &&
        queuedTask.depends_on.every((id) => done.has(id))
      ) queuedTask.status = "ready";
    }
    expectedQueue.revision = queue.revision;
    expectedQueue.project_status = "blocked";
    if (expectedQueue.tasks?.[taskId]) expectedQueue.tasks[taskId].status = "blocked";
    if (JSON.stringify(queue) !== JSON.stringify(expectedQueue)) {
      throw upgradeError("The controller-tool queue contains changes beyond deterministic readiness and runtime status fields", "ACTIVE_TASK");
    }
    const maintenanceBytes = await readManagedFile(
      path.join(target, ".autopilot", "MAINTENANCE"),
      { optional: true },
    );
    if (maintenanceBytes !== null) assertSnapshotBound("maintenance sentinel", maintenanceBytes, 1024);
    return {
      kind: "controller-tool-structural",
      taskId,
      attempt,
      recoveryAttempt: legacyControllerFault && !priorStructuralRecovery
        ? Math.max(0, attempt - 1)
        : attempt,
      baselineHead: head,
      currentHead: head,
      stateRevision: Number(state.revision ?? 0),
      blockerKind: "controller_tooling",
      blocker: state.blocker,
      allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: candidate === null
        ? null
        : await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
      candidateSummary: typeof candidate?.summary === "string" ? candidate.summary.slice(0, 1024) : null,
      maintenanceBytes,
    };
  }
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
      currentHead: head,
      stateRevision: Number(state.revision ?? 0),
      blockerKind: "path_boundary",
      allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json"), { optional: true }),
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

  const attemptLimit = Math.min(
    Number(task?.attempt_limit ?? Number.POSITIVE_INFINITY),
    Number((await readBoundedJson(path.join(target, ".autopilot", "config.json"), MANIFEST_BYTES))?.budgets?.max_attempts_per_task ?? Number.POSITIVE_INFINITY),
  );
  const lockfileTelemetryBoundary =
    previous?.version === "1.6.13" &&
    state.status === "human_required" && state.phase === "blocked" && state.pid === null &&
    JSON.stringify(state.blocker) === JSON.stringify(LOCKFILE_TELEMETRY_BLOCKER) &&
    state.last_failure_evidence?.failure?.code === "OPENCODE_TOOL_USAGE_INVALID" &&
    state.last_failure_evidence?.failure?.message === "OpenCode phase tool usage is invalid" &&
    typeof state.last_failure_fingerprint === "string" && state.last_failure_fingerprint.length > 0 &&
    Number.isFinite(attemptLimit) && attemptLimit > 0 && attempt === attemptLimit &&
    typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" && task?.status === "blocked" &&
    candidate?.task_id === taskId && candidate?.attempt === attempt && candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(LOCKFILE_TELEMETRY_BLOCKER) &&
    Array.isArray(task?.allowed_paths) &&
    isAllowedPath("package.json", task.allowed_paths) && isAllowedPath("pnpm-lock.yaml", task.allowed_paths);
  if (lockfileTelemetryBoundary) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The lockfile-telemetry recovery contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The lockfile-telemetry recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The lockfile-telemetry recovery contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (!taskDirtyPaths.includes("pnpm-lock.yaml") || taskDirtyPaths.length > 256) {
      throw upgradeError("The lockfile-telemetry recovery does not contain the expected bounded workspace output", "ACTIVE_TASK");
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
    ) throw upgradeError("The lockfile-telemetry queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    return {
      kind: "v1613-lockfile-telemetry", taskId, attempt, recoveryAttempt: 1,
      baselineHead: head, currentHead: head, stateRevision: Number(state.revision ?? 0),
      blockerKind: "gate_infrastructure", blocker: LOCKFILE_TELEMETRY_BLOCKER, allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
    };
  }

  const controllerRunnerBoundary =
    previous?.version === "1.6.14" &&
    state.status === "human_required" && state.phase === "blocked" && state.pid === null &&
    JSON.stringify(state.blocker) === JSON.stringify(CONTROLLER_RUNNER_BLOCKER) &&
    state.last_failure_fingerprint === null && state.last_failure_evidence === null &&
    attempt === 2 && typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" && task?.status === "blocked" &&
    candidate?.task_id === taskId && candidate?.attempt === attempt && candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(CONTROLLER_RUNNER_BLOCKER) &&
    Array.isArray(task?.allowed_paths) &&
    isAllowedPath("package.json", task.allowed_paths) && isAllowedPath("pnpm-lock.yaml", task.allowed_paths);
  if (controllerRunnerBoundary) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The controller-runner recovery contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The controller-runner recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The controller-runner recovery contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (!taskDirtyPaths.includes("pnpm-lock.yaml") || taskDirtyPaths.length > 256) {
      throw upgradeError("The controller-runner recovery does not contain the expected bounded workspace output", "ACTIVE_TASK");
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
    ) throw upgradeError("The controller-runner queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    return {
      kind: "v1614-controller-runner", taskId, attempt, recoveryAttempt: 1,
      baselineHead: head, currentHead: head, stateRevision: Number(state.revision ?? 0),
      blockerKind: "controller_tooling", blocker: CONTROLLER_RUNNER_BLOCKER, allowedDirty,
      stateBytes: await readManagedFile(path.join(target, ".autopilot", "state.json")),
      queueBytes: await readManagedFile(path.join(target, ".project", "plan", "queue.json")),
      candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json")),
    };
  }

  const gateCleanupBoundary =
    previous?.version === "1.6.17" &&
    state.status === "human_required" && state.phase === "blocked" && state.pid === null &&
    JSON.stringify(state.blocker) === JSON.stringify(GATE_CLEANUP_BLOCKER) &&
    state.last_failure_evidence?.failure?.code === "OPENCODE_TOOL_USAGE_INVALID" &&
    state.last_failure_evidence?.failure?.message === "OpenCode phase tool usage is invalid" &&
    typeof state.last_failure_fingerprint === "string" && state.last_failure_fingerprint.length > 0 &&
    Number.isFinite(attemptLimit) && attemptLimit > 0 && attempt === attemptLimit &&
    typeof state.baseline_head === "string" && state.baseline_head === head &&
    queue?.project_status === "blocked" && task?.status === "blocked" &&
    candidate?.task_id === taskId && candidate?.attempt === attempt && candidate?.status === "blocked" &&
    JSON.stringify(candidate.blocker) === JSON.stringify(GATE_CLEANUP_BLOCKER) &&
    Array.isArray(task?.allowed_paths) &&
    isAllowedPath("package.json", task.allowed_paths) && isAllowedPath("pnpm-lock.yaml", task.allowed_paths);
  if (gateCleanupBoundary) {
    for (const artifact of ["review.json", "mode-intent.json"]) {
      if (await exists(path.join(target, ".autopilot", "runtime", artifact))) {
        throw upgradeError("The gate-cleanup recovery contains unexpected runtime evidence", "ACTIVE_TASK");
      }
    }
    if (await exists(path.join(target, ".project", "receipts", `${taskId}.json`))) {
      throw upgradeError("The gate-cleanup recovery task already has an accepted receipt", "ACTIVE_TASK");
    }
    const dirtyRecords = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    const taskDirtyPaths = [];
    for (const record of dirtyRecords) {
      const status = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      if (file === queueRelative && status === " M") continue;
      if (![" M", "??"].includes(status) || !isAllowedPath(file, task.allowed_paths)) {
        throw upgradeError("The gate-cleanup recovery contains changes outside its approved task paths", "ACTIVE_TASK");
      }
      await assertSafeDestination(target, path.join(target, ...file.split("/")));
      taskDirtyPaths.push(file);
    }
    if (!taskDirtyPaths.includes("pnpm-lock.yaml") || taskDirtyPaths.length > 256) {
      throw upgradeError("The gate-cleanup recovery does not contain the expected bounded workspace output", "ACTIVE_TASK");
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
    ) throw upgradeError("The gate-cleanup queue contains changes beyond runtime status fields", "ACTIVE_TASK");
    return {
      kind: "v1617-gate-cleanup", taskId, attempt, recoveryAttempt: 1,
      baselineHead: head, currentHead: head, stateRevision: Number(state.revision ?? 0),
      blockerKind: "environment", blocker: GATE_CLEANUP_BLOCKER, allowedDirty,
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
  const exhaustedAttemptLimit = Math.min(
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
    Number.isFinite(exhaustedAttemptLimit) && exhaustedAttemptLimit > 0 && attempt === exhaustedAttemptLimit &&
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
    currentHead: head,
    stateRevision: Number(state.revision ?? 0),
    blockerKind: "repair_exhausted",
    allowedDirty: [queueRelative],
    stateBytes,
    queueBytes,
    candidateBytes: await readManagedFile(path.join(target, ".autopilot", "runtime", "candidate.json"), { optional: true }),
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
    "legacy-insufficient-evidence",
    "literal-directory-path-boundary",
    "exhausted-corepack-shim",
    "v1611-corepack-reset-repair",
    "v1612-dependency-lock",
    "v1613-lockfile-telemetry",
    "v1614-controller-runner",
    "v1617-gate-cleanup",
    "controller-tool-structural",
  ].includes(boundary?.kind);
}

function requiresRecoveryBaselineAdvance(boundary) {
  return [
    "legacy-insufficient-evidence",
    "literal-directory-path-boundary",
    "exhausted-corepack-shim",
    "v1611-corepack-reset-repair",
    "v1612-dependency-lock",
    "v1613-lockfile-telemetry",
    "v1614-controller-runner",
    "v1617-gate-cleanup",
    "controller-tool-structural",
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

async function applyStructuralControllerToolRecovery(target, boundary) {
  const stateFile = path.join(target, ".autopilot", "state.json");
  const queueFile = path.join(target, ".project", "plan", "queue.json");
  const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
  const [current, queue, candidate] = await Promise.all([
    readBoundedJson(stateFile, 64 * 1024),
    readBoundedJson(queueFile, MANIFEST_BYTES),
    readBoundedJson(candidateFile, 64 * 1024, { optional: true }),
  ]);
  if (
    current.revision !== boundary.stateRevision ||
    current.status !== "human_required" || current.phase !== "blocked" || current.pid !== null ||
    current.active_task !== boundary.taskId || current.attempt !== boundary.attempt ||
    current.baseline_head !== boundary.baselineHead ||
    JSON.stringify(current.blocker) !== JSON.stringify(boundary.blocker) ||
    queue?.project_status !== "blocked" || queue?.tasks?.[boundary.taskId]?.status !== "blocked" ||
    (boundary.candidateBytes !== null && (
      candidate?.task_id !== boundary.taskId || candidate?.attempt !== boundary.attempt ||
      candidate?.status !== "blocked" ||
      JSON.stringify(candidate.blocker) !== JSON.stringify(boundary.blocker)
    )) ||
    (boundary.candidateBytes === null && candidate !== null)
  ) throw upgradeError("Controller-tool recovery state changed during the framework upgrade", "UPGRADE_RACE");

  const recoveryEvidence = (
    current.last_failure_evidence?.controller_faults ||
    current.last_failure_evidence?.failure?.code === "CONTROLLER_TOOL_RECOVERED"
  )
    ? current.last_failure_evidence
    : {
        failure: {
          code: "CONTROLLER_TOOL_RECOVERED",
          message: boundary.candidateSummary || "A controller-owned tool failure interrupted the preserved task.",
        },
      };
  const next = {
    ...current,
    revision: Number(current.revision ?? 0) + 1,
    run_id: null,
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: null,
    heartbeat_at: new Date().toISOString(),
    attempt: boundary.recoveryAttempt,
    no_progress_count: 0,
    last_progress_hash: null,
    last_failure_fingerprint: null,
    last_failure_evidence: recoveryEvidence,
    last_session: null,
    session_ids: [],
    baseline_head: boundary.currentHead,
    blocker: REPAIRED_CONTROLLER_BLOCKER,
    completion: null,
    finalization: null,
  };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > 64 * 1024) {
    throw upgradeError("Controller-tool recovery state exceeds its bounded capacity", "STATE_CAPACITY_EXHAUSTED");
  }
  await atomicWriteFile(stateFile, contents);
  injectRecoveryFailure("structural-state-written");
  if (candidate !== null) await rm(candidateFile, { force: true });
}

async function clearRecoveredMaintenanceSentinel(target, expectedBytes) {
  const maintenanceFile = path.join(target, ".autopilot", "MAINTENANCE");
  await assertSafeDestination(target, maintenanceFile, { optional: true });
  const currentBytes = await readManagedFile(maintenanceFile, { optional: true });
  if (currentBytes === null) return;
  if (!currentBytes.equals(expectedBytes)) {
    throw upgradeError(
      "The maintenance request changed during the framework upgrade",
      "UPGRADE_RACE",
    );
  }
  await rm(maintenanceFile, { force: true });
}

async function createRecoveryRollbackArtifact(target, boundary, upgradeCommit) {
  const stateFile = path.join(target, ".autopilot", "state.json");
  const queueFile = path.join(target, ".project", "plan", "queue.json");
  const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
  const [postState, postQueue, postCandidate] = await Promise.all([
    readManagedFile(stateFile),
    readManagedFile(queueFile),
    readManagedFile(candidateFile, { optional: true }),
  ]);
  assertSnapshotBound("pre-upgrade state", boundary.stateBytes, 64 * 1024);
  assertSnapshotBound("pre-upgrade queue", boundary.queueBytes, MANIFEST_BYTES);
  if (boundary.candidateBytes !== null) {
    assertSnapshotBound("pre-upgrade candidate", boundary.candidateBytes, 64 * 1024);
  }
  assertSnapshotBound("post-upgrade state", postState, 64 * 1024);
  assertSnapshotBound("post-upgrade queue", postQueue, MANIFEST_BYTES);
  if (postCandidate !== null) assertSnapshotBound("post-upgrade candidate", postCandidate, 64 * 1024);

  const nonce = randomBytes(8).toString("hex");
  const relative = `.autopilot/runtime/${RECOVERY_ROLLBACK_PREFIX}${upgradeCommit.slice(0, 16)}-${nonce}.json`;
  const artifactFile = path.join(target, ...relative.split("/"));
  await assertSafeDestination(target, artifactFile, { optional: true });
  const artifact = {
    schema_version: 1,
    kind: "controller-owned-active-recovery",
    created_at: new Date().toISOString(),
    upgrade_commit: upgradeCommit,
    pre_upgrade_head: boundary.currentHead,
    task_id: boundary.taskId,
    allowed_dirty: [...new Set(boundary.allowedDirty ?? [])].sort(),
    pre_upgrade: {
      state: encodeSnapshot(boundary.stateBytes),
      queue: encodeSnapshot(boundary.queueBytes),
      candidate: boundary.candidateBytes === null ? null : encodeSnapshot(boundary.candidateBytes),
    },
    post_upgrade: {
      state_sha256: sha256Bytes(postState),
      queue_sha256: sha256Bytes(postQueue),
      candidate_sha256: postCandidate === null ? null : sha256Bytes(postCandidate),
    },
  };
  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > RECOVERY_ROLLBACK_BYTES) {
    throw upgradeError("Recovery rollback artifact exceeds its fixed capacity", "ROLLBACK_ARTIFACT_TOO_LARGE");
  }
  await atomicWriteFile(artifactFile, contents);
  return {
    kind: "controller-owned-active-recovery",
    artifact: relative,
    argv: [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--target", target,
      "--rollback-recovery", relative,
      "--json",
    ],
  };
}

async function applyRecoveryRollback(target, selectedArtifact) {
  const { file: artifactFile, relative: artifactRelative } = resolveRecoveryRollbackArtifact(target, selectedArtifact);
  await assertSafeDestination(target, artifactFile);
  const artifact = await readBoundedJson(artifactFile, RECOVERY_ROLLBACK_BYTES);
  validateRecoveryRollbackArtifact(artifact);
  const preStateBytes = decodeSnapshot("pre-upgrade state", artifact.pre_upgrade.state, 64 * 1024);
  const preQueueBytes = decodeSnapshot("pre-upgrade queue", artifact.pre_upgrade.queue, MANIFEST_BYTES);
  const preCandidateBytes = artifact.pre_upgrade.candidate === null
    ? null
    : decodeSnapshot("pre-upgrade candidate", artifact.pre_upgrade.candidate, 64 * 1024);
  const preState = parseSnapshotJson("pre-upgrade state", preStateBytes);
  const preQueue = parseSnapshotJson("pre-upgrade queue", preQueueBytes);
  validateRecoveryRollbackBoundary(artifact, preState, preQueue, preCandidateBytes);

  const head = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== artifact.upgrade_commit) {
    throw upgradeError("Recovery rollback requires the upgrade commit to remain the current HEAD", "ROLLBACK_STALE", {
      expected_head: artifact.upgrade_commit,
      actual_head: head,
    });
  }
  const parent = (await git(target, ["rev-parse", `${artifact.upgrade_commit}^`])).stdout.trim();
  if (parent !== artifact.pre_upgrade_head) {
    throw upgradeError("Recovery rollback commit ancestry no longer matches its captured boundary", "ROLLBACK_STALE");
  }

  const stateFile = path.join(target, ".autopilot", "state.json");
  const queueFile = path.join(target, ".project", "plan", "queue.json");
  const candidateFile = path.join(target, ".autopilot", "runtime", "candidate.json");
  await Promise.all([
    assertSafeDestination(target, stateFile),
    assertSafeDestination(target, queueFile),
    assertSafeDestination(target, candidateFile, { optional: true }),
  ]);
  const [postStateBytes, postQueueBytes, postCandidateBytes] = await Promise.all([
    readManagedFile(stateFile),
    readManagedFile(queueFile),
    readManagedFile(candidateFile, { optional: true }),
  ]);
  if (
    sha256Bytes(postStateBytes) !== artifact.post_upgrade.state_sha256 ||
    sha256Bytes(postQueueBytes) !== artifact.post_upgrade.queue_sha256 ||
    (postCandidateBytes === null ? null : sha256Bytes(postCandidateBytes)) !== artifact.post_upgrade.candidate_sha256
  ) {
    throw upgradeError("Controller runtime changed after the upgrade; guarded rollback is no longer safe", "ROLLBACK_STALE");
  }
  await assertRecoveryRollbackDirtyBoundary(target, artifact, preQueue);

  await git(target, ["revert", "--no-edit", artifact.upgrade_commit]);
  const rollbackCommit = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
  const restoredState = {
    ...preState,
    revision: Math.max(Number(preState.revision ?? 0), Number(parseSnapshotJson("post-upgrade state", postStateBytes).revision ?? 0)) + 1,
    heartbeat_at: new Date().toISOString(),
    baseline_head: rollbackCommit,
  };
  const restoredStateBytes = Buffer.from(`${JSON.stringify(restoredState, null, 2)}\n`, "utf8");
  assertSnapshotBound("restored state", restoredStateBytes, 64 * 1024);
  try {
    if (preCandidateBytes === null) await rm(candidateFile, { force: true });
    else await atomicWriteFile(candidateFile, preCandidateBytes);
    await atomicWriteFile(queueFile, preQueueBytes);
    await atomicWriteFile(stateFile, restoredStateBytes);
  } catch (error) {
    const restorationErrors = [];
    for (const [file, bytes] of [
      [candidateFile, postCandidateBytes],
      [queueFile, postQueueBytes],
      [stateFile, postStateBytes],
    ]) {
      try {
        if (bytes === null) await rm(file, { force: true });
        else await atomicWriteFile(file, bytes);
      } catch (restoreError) {
        restorationErrors.push(`${path.basename(file)}: ${restoreError.message}`);
      }
    }
    throw upgradeError(
      `Recovery rollback created ${rollbackCommit} but could not restore its runtime snapshot: ${error.message}${
        restorationErrors.length > 0 ? `; post-upgrade snapshot restoration also failed: ${restorationErrors.join("; ")}` : ""
      }. The private rollback artifact was retained at ${artifactRelative}.`,
      "ROLLBACK_RUNTIME_FAILED",
      { rollback_commit: rollbackCommit, artifact: artifactRelative },
    );
  }
  await assertCleanGit(target, { allowedDirty: artifact.allowed_dirty });
  await rm(artifactFile, { force: true });
  return {
    ok: true,
    rolled_back: true,
    reverted_upgrade_commit: artifact.upgrade_commit,
    rollback_commit: rollbackCommit,
    restored_task: artifact.task_id,
    baseline_head: rollbackCommit,
    artifact_removed: artifactRelative,
  };
}

function resolveRecoveryRollbackArtifact(target, selected) {
  if (typeof selected !== "string" || selected.length === 0 || selected.length > 512 || selected.includes("\0")) {
    throw upgradeError("Recovery rollback artifact path is invalid", "ROLLBACK_ARTIFACT_INVALID");
  }
  const file = path.isAbsolute(selected) ? path.resolve(selected) : path.resolve(target, selected);
  const relative = path.relative(target, file).replaceAll(path.sep, "/");
  if (
    !new RegExp(`^\\.autopilot/runtime/${RECOVERY_ROLLBACK_PREFIX}[0-9a-f]{16}-[0-9a-f]{16}\\.json$`).test(relative) ||
    relative.startsWith("../") || path.isAbsolute(relative)
  ) {
    throw upgradeError("Recovery rollback artifact must be the exact controller-owned private runtime file", "ROLLBACK_ARTIFACT_INVALID");
  }
  return { file, relative };
}

function validateRecoveryRollbackArtifact(artifact) {
  const exactKeys = (value, keys) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (
    !exactKeys(artifact, [
      "schema_version", "kind", "created_at", "upgrade_commit", "pre_upgrade_head", "task_id",
      "allowed_dirty", "pre_upgrade", "post_upgrade",
    ]) ||
    artifact.schema_version !== 1 || artifact.kind !== "controller-owned-active-recovery" ||
    typeof artifact.created_at !== "string" || !Number.isFinite(Date.parse(artifact.created_at)) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.upgrade_commit) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.pre_upgrade_head) ||
    typeof artifact.task_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(artifact.task_id) ||
    !Array.isArray(artifact.allowed_dirty) || artifact.allowed_dirty.length > 513 ||
    artifact.allowed_dirty.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\\") || item.includes("\0")) ||
    !exactKeys(artifact.pre_upgrade, ["state", "queue", "candidate"]) ||
    !exactKeys(artifact.post_upgrade, ["state_sha256", "queue_sha256", "candidate_sha256"]) ||
    !/^[0-9a-f]{64}$/.test(artifact.post_upgrade.state_sha256) ||
    !/^[0-9a-f]{64}$/.test(artifact.post_upgrade.queue_sha256) ||
    !(artifact.post_upgrade.candidate_sha256 === null || /^[0-9a-f]{64}$/.test(artifact.post_upgrade.candidate_sha256))
  ) throw upgradeError("Recovery rollback artifact has an invalid contract", "ROLLBACK_ARTIFACT_INVALID");
}

function validateRecoveryRollbackBoundary(artifact, state, queue, candidateBytes) {
  const task = queue?.tasks?.[artifact.task_id];
  const blockedBoundary =
    state?.status === "human_required" && state?.phase === "blocked" && state?.pid === null &&
    state?.active_task === artifact.task_id && queue?.project_status === "blocked" && task?.status === "blocked";
  const maintenanceBoundary =
    state?.status === "paused" && state?.phase === "maintenance" && state?.pid === null &&
    state?.active_task === null && state?.attempt === 0 && state?.blocker === null &&
    queue?.project_status === "ready" && task?.status === "ready";
  if (
    (!blockedBoundary && !maintenanceBoundary) || !Array.isArray(task?.allowed_paths) ||
    (maintenanceBoundary && candidateBytes === null) ||
    typeof state?.baseline_head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(state.baseline_head)
  ) throw upgradeError("Recovery rollback snapshot is not a bounded controller recovery boundary", "ROLLBACK_ARTIFACT_INVALID");
  if (candidateBytes !== null) {
    const candidate = parseSnapshotJson("pre-upgrade candidate", candidateBytes);
    if (
      candidate?.task_id !== artifact.task_id || candidate?.status !== "blocked" ||
      (blockedBoundary && (
        candidate?.attempt !== state.attempt || JSON.stringify(candidate.blocker) !== JSON.stringify(state.blocker)
      ))
    ) throw upgradeError("Recovery rollback candidate does not match its captured task boundary", "ROLLBACK_ARTIFACT_INVALID");
  }
  const queueRelative = ".project/plan/queue.json";
  if (
    !artifact.allowed_dirty.includes(queueRelative) ||
    artifact.allowed_dirty.some((relative) =>
      relative !== queueRelative && !isAllowedPath(relative, task.allowed_paths)
    )
  ) throw upgradeError("Recovery rollback dirty-path scope exceeds the captured task boundary", "ROLLBACK_ARTIFACT_INVALID");
}

async function assertRecoveryRollbackDirtyBoundary(target, artifact, preQueue) {
  const task = preQueue.tasks[artifact.task_id];
  const records = splitZero((await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
  for (const record of records) {
    const status = record.slice(0, 2);
    const relative = record.slice(3).replaceAll("\\", "/");
    if (!artifact.allowed_dirty.includes(relative) || ![" M", "??"].includes(status)) {
      throw upgradeError("Recovery rollback found changes outside its captured dirty-path boundary", "ROLLBACK_STALE");
    }
    if (relative !== ".project/plan/queue.json" && !isAllowedPath(relative, task.allowed_paths)) {
      throw upgradeError("Recovery rollback found a task file outside its approved path scope", "ROLLBACK_STALE");
    }
    await assertSafeDestination(target, path.join(target, ...relative.split("/")));
  }
}

function encodeSnapshot(bytes) {
  return { sha256: sha256Bytes(bytes), base64: bytes.toString("base64") };
}

function decodeSnapshot(label, snapshot, cap) {
  if (
    !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
    Object.keys(snapshot).sort().join("\0") !== "base64\0sha256" ||
    typeof snapshot.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(snapshot.base64) ||
    snapshot.base64.length % 4 !== 0 || !/^[0-9a-f]{64}$/.test(snapshot.sha256)
  ) throw upgradeError(`${label} snapshot has an invalid contract`, "ROLLBACK_ARTIFACT_INVALID");
  const bytes = Buffer.from(snapshot.base64, "base64");
  if (bytes.toString("base64") !== snapshot.base64 || bytes.length > cap || sha256Bytes(bytes) !== snapshot.sha256) {
    throw upgradeError(`${label} snapshot failed its bounded integrity check`, "ROLLBACK_ARTIFACT_INVALID");
  }
  return bytes;
}

function parseSnapshotJson(label, bytes) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw upgradeError(`${label} snapshot is not valid JSON`, "ROLLBACK_ARTIFACT_INVALID"); }
}

function assertSnapshotBound(label, bytes, cap) {
  if (!Buffer.isBuffer(bytes) || bytes.length > cap) {
    throw upgradeError(`${label} exceeds its fixed capacity`, "ROLLBACK_ARTIFACT_TOO_LARGE");
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function injectRecoveryFailure(point) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.AUTOPILOT_TEST_UPGRADE_RECOVERY_FAILURE === point
  ) {
    throw upgradeError(`Injected recovery failure at ${point}`, "UPGRADE_TEST_RECOVERY_FAILURE");
  }
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
  const originalBlocked = ["exhausted-corepack-shim", "v1612-dependency-lock", "v1613-lockfile-telemetry", "v1614-controller-runner", "v1617-gate-cleanup"].includes(boundary.kind);
  const expectedBlocker = boundary.kind === "v1612-dependency-lock"
    ? DEPENDENCY_LOCK_BLOCKER
    : boundary.kind === "v1613-lockfile-telemetry"
      ? LOCKFILE_TELEMETRY_BLOCKER
      : boundary.kind === "v1614-controller-runner"
        ? CONTROLLER_RUNNER_BLOCKER
        : boundary.kind === "v1617-gate-cleanup" ? GATE_CLEANUP_BLOCKER : COREPACK_BLOCKER;
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
  const corepackRecovery = ["exhausted-corepack-shim", "v1611-corepack-reset-repair", "v1612-dependency-lock", "v1613-lockfile-telemetry", "v1614-controller-runner", "v1617-gate-cleanup", "controller-tool-structural"].includes(boundary.kind);
  const expectedRevision = corepackRecovery ? boundary.stateRevision + 1 : boundary.stateRevision;
  const expectedAttempt = corepackRecovery ? boundary.recoveryAttempt : boundary.attempt;
  const expectedBaseline = corepackRecovery ? boundary.currentHead : boundary.baselineHead;
  const expectedBlocker = boundary.kind === "v1612-dependency-lock"
    ? "tooling_authority"
    : boundary.kind === "v1613-lockfile-telemetry"
      ? "gate_infrastructure"
      : boundary.kind === "v1614-controller-runner"
        ? "controller_tooling"
        : boundary.kind === "v1617-gate-cleanup"
          ? "environment"
        : boundary.kind === "controller-tool-structural"
          ? "controller_tooling"
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

async function validateInstalledControllerRuntime(target) {
  const bin = path.join(target, ".autopilot", "bin");
  const runners = [
    path.join(bin, "autopilot.mjs"),
    path.join(bin, "control-plane.mjs"),
    path.join(bin, "run-action.mjs"),
    path.join(bin, "run-gate.mjs"),
  ];
  const libraries = [
    path.join(bin, "lib", "controller.mjs"),
    path.join(bin, "lib", "dependency-manager.mjs"),
    path.join(bin, "lib", "gate-runner.mjs"),
    path.join(bin, "lib", "opencode-isolated.mjs"),
  ];
  const commands = [
    ...runners.map((runner) => [process.execPath, "--check", runner]),
    [
      process.execPath,
      "--input-type=module",
      "--eval",
      libraries.map((file) => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(";"),
    ],
  ];
  for (const argv of commands) {
    const result = await runExternal(argv, target);
    if (result.code !== 0 || result.output_truncated || result.timed_out) {
      throw upgradeError(
        `Installed controller runtime failed its bounded structural preflight: ${diagnostic(result)}`,
        "UPGRADE_READINESS_FAILED",
      );
    }
  }
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

function treeSha256Bytes(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return createHash("sha256").update(`file\0\0${digest}\0`).digest("hex");
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
  const result = {
    target: null,
    sourceSkill: null,
    rollbackRecovery: null,
    dryRun: false,
    adopt: false,
    interview: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--target", "--source-skill", "--rollback-recovery"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error(`${value} requires a path`);
      if (value === "--target") result.target = selected;
      else if (value === "--source-skill") result.sourceSkill = selected;
      else result.rollbackRecovery = selected;
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--adopt") result.adopt = true;
    else if (value === "--interview") result.interview = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") {
      process.stdout.write("Usage: upgrade-project.mjs [--target PATH] [--source-skill PATH] [--dry-run] [--adopt | --interview] [--rollback-recovery ARTIFACT] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (result.adopt && result.interview) throw new Error("--adopt and --interview are mutually exclusive");
  if (
    result.rollbackRecovery &&
    (result.dryRun || result.adopt || result.interview || result.sourceSkill)
  ) throw new Error("--rollback-recovery cannot be combined with source, preview, adoption, or interview options");
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
