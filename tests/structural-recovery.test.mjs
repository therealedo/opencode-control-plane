import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScaffold,
  git,
  readJson,
  repositoryRoot,
  run,
  writeJson,
} from "./runtime-helpers.mjs";

const upgrader = path.join(
  repositoryRoot,
  ".agents", "skills", "init-project", "bin", "upgrade-project.mjs",
);
const repairedControllerBlocker = {
  kind: "controller_tooling",
  message: "The Control Plane upgrade repaired the controller-owned tooling while preserving the active task and its application changes.",
  required_action: "Run the zero-token readiness check, then use explicit Resume to retry the preserved task.",
  resume_condition: "Readiness reports ready and the user explicitly resumes the preserved task.",
};

async function nextReleaseSkill(t, version = "1.7.0") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ocp-structural-release-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(repositoryRoot, ".agents", "skills");
  await cp(path.join(source, "init-project"), path.join(parent, "init-project"), { recursive: true });
  await cp(path.join(source, "evolve-project"), path.join(parent, "evolve-project"), { recursive: true });
  const releaseFile = path.join(parent, "init-project", "assets", "control-plane-release.json");
  const release = await readJson(releaseFile);
  release.version = version;
  await writeJson(releaseFile, release);
  return path.join(parent, "init-project");
}

async function invoke(root, sourceSkill, extra = []) {
  return run([
    process.execPath,
    upgrader,
    "--target", root,
    "--source-skill", sourceSkill,
    "--json",
    ...extra,
  ], { cwd: root });
}

async function markInstalledVersion(root, version) {
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const manifest = await readJson(manifestFile);
  manifest.version = version;
  await writeJson(manifestFile, manifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", `test: model installed Control Plane ${version}`]);
}

test("v1.6.18 free-form controller faults recover structurally with work preserved", async (t) => {
  const root = await createScaffold(t, { ready: true });
  await markInstalledVersion(root, "1.6.18");
  const sourceSkill = await nextReleaseSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const maintenanceFile = path.join(root, ".autopilot", "MAINTENANCE");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps/**"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish dependency task boundary"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "controller_tooling",
    message: "Arbitrary model wording that is intentionally not a release fingerprint.",
    required_action: "Repair the controller-owned dependency and gate transport.",
    resume_condition: "The zero-model readiness probe succeeds.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-structural-controller-fault",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 2,
    baseline_head: baseline,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    blocker,
  });
  queue.revision += 1;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 2,
    status: "blocked",
    summary: "A partial workspace is preserved after a controller-owned operation failed.",
    environment_variables: [],
    blocker,
  });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    private: true,
    packageManager: "pnpm@11.14.0",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: {}\nimporters:\n  .: {}\n", "utf8");
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved workspace\n", "utf8");
  await writeFile(maintenanceFile, "requested\n", "utf8");

  await writeFile(path.join(root, "outside.txt"), "must fail closed\n", "utf8");
  const rejected = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.notEqual(rejected.code, 0);
  await rm(path.join(root, "outside.txt"));

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "controller-tool-structural");

  const preUpgradeState = await readJson(stateFile);
  const preUpgradeQueueBytes = await readFile(queueFile);
  const preUpgradeCandidateBytes = await readFile(candidateFile);
  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "controller-tool-structural");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.equal(recovered.last_failure_evidence.failure.code, "CONTROLLER_TOOL_RECOVERED");
  assert.deepEqual(recovered.blocker, repairedControllerBlocker);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  await assert.rejects(readFile(maintenanceFile), { code: "ENOENT" });
  assert.deepEqual(await readFile(queueFile), preUpgradeQueueBytes);
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved workspace\n");
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.migration_history.at(-1).recovery_reason, "controller-tool-structural");

  assert.equal(output.rollback.kind, "controller-owned-active-recovery");
  assert.match(output.rollback.artifact, /^\.autopilot\/runtime\/control-plane-upgrade-rollback-/);
  assert.deepEqual(output.rollback.argv.slice(-3), [
    "--rollback-recovery", output.rollback.artifact, "--json",
  ]);
  const rollback = await run(output.rollback.argv, { cwd: root });
  assert.equal(rollback.code, 0, rollback.stderr || rollback.stdout);
  const rollbackOutput = JSON.parse(rollback.stdout);
  assert.equal(rollbackOutput.rolled_back, true);
  assert.equal(rollbackOutput.reverted_upgrade_commit, output.commit);
  const restored = await readJson(stateFile);
  assert.deepEqual(restored, {
    ...preUpgradeState,
    revision: restored.revision,
    heartbeat_at: restored.heartbeat_at,
    baseline_head: rollbackOutput.rollback_commit,
  });
  assert.ok(restored.revision > recovered.revision);
  assert.equal(restored.baseline_head, await git(root, ["rev-parse", "HEAD"]));
  assert.deepEqual(await readFile(queueFile), preUpgradeQueueBytes);
  assert.deepEqual(await readFile(candidateFile), preUpgradeCandidateBytes);
  await assert.rejects(readFile(path.join(root, output.rollback.artifact)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved workspace\n");
});

test("a recovery fault after the first runtime mutation restores the exact pre-upgrade boundary", async (t) => {
  const root = await createScaffold(t, { ready: true });
  await markInstalledVersion(root, "1.6.18");
  const sourceSkill = await nextReleaseSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const maintenanceFile = path.join(root, ".autopilot", "MAINTENANCE");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps/**"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish dependency task boundary"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "controller_tooling",
    message: "A legacy controller operation failed after producing bounded work.",
    required_action: "Restore the controller-owned dependency operation.",
    resume_condition: "The controller can retry without consuming the failed attempt.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-fault-injection",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 2,
    baseline_head: baseline,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    blocker,
  });
  queue.revision += 1;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 2,
    status: "blocked",
    summary: "Preserve this candidate across a failed upgrade transaction.",
    environment_variables: [],
    blocker,
  });
  await writeFile(path.join(root, "package.json"), "{\"private\":true,\"packageManager\":\"pnpm@11.14.0\"}\n", "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: {}\nimporters:\n  .: {}\n", "utf8");
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved workspace\n", "utf8");
  await writeFile(maintenanceFile, "requested\n", "utf8");

  const before = {
    head: await git(root, ["rev-parse", "HEAD"]),
    state: await readFile(stateFile),
    queue: await readFile(queueFile),
    candidate: await readFile(candidateFile),
    manifest: await readFile(manifestFile),
    controller: await readFile(path.join(root, ".autopilot", "bin", "lib", "controller.mjs")),
    maintenance: await readFile(maintenanceFile),
  };
  const failed = await run([
    process.execPath,
    upgrader,
    "--target", root,
    "--source-skill", sourceSkill,
    "--json",
  ], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AUTOPILOT_TEST_UPGRADE_RECOVERY_FAILURE: "structural-state-written",
    },
  });
  assert.notEqual(failed.code, 0);
  assert.equal(JSON.parse(failed.stderr).code, "UPGRADE_TEST_RECOVERY_FAILURE");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), before.head);
  assert.deepEqual(await readFile(stateFile), before.state);
  assert.deepEqual(await readFile(queueFile), before.queue);
  assert.deepEqual(await readFile(candidateFile), before.candidate);
  assert.deepEqual(await readFile(manifestFile), before.manifest);
  assert.deepEqual(await readFile(path.join(root, ".autopilot", "bin", "lib", "controller.mjs")), before.controller);
  assert.deepEqual(await readFile(maintenanceFile), before.maintenance);
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved workspace\n");
});

test("v1.6.19 structural recovery bridge clears stale maintenance without a second refund", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await nextReleaseSkill(t, "1.7.0");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const maintenanceFile = path.join(root, ".autopilot", "MAINTENANCE");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const manifest = await readJson(manifestFile);

  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps/**"];
  manifest.version = "1.6.19";
  manifest.migration_history.push({
    from_version: "1.6.18",
    to_version: "1.6.19",
    applied_at: "2026-07-27T00:38:16.433Z",
    kind: "upgrade-recovery",
    recovered_task: "M001",
    recovery_reason: "controller-tool-structural",
  });
  await writeJson(queueFile, queue);
  await writeJson(manifestFile, manifest);
  await git(root, ["add", ".project/plan/queue.json", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: model the v1.6.19 structural recovery boundary"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "controller_tooling",
    message: "The pre-v1.6.19 controller could not complete dependency resolution.",
    required_action: "Upgrade the controller-owned dependency and gate tools.",
    resume_condition: "The controller can retry the preserved task.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: null,
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: null,
    active_task: "M001",
    attempt: 1,
    no_progress_count: 0,
    last_progress_hash: null,
    last_failure_fingerprint: null,
    last_failure_evidence: {
      failure: {
        code: "CONTROLLER_TOOL_RECOVERED",
        message: "The first structural upgrade preserved the dependency workspace.",
      },
    },
    last_session: null,
    session_ids: [],
    baseline_head: baseline,
    blocker,
  });
  queue.revision += 1;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await rm(candidateFile, { force: true });
  await writeFile(path.join(root, "package.json"), "{\"private\":true,\"packageManager\":\"pnpm@11.14.0\"}\n", "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: {}\nimporters:\n  .: {}\n", "utf8");
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved after v1.6.19\n", "utf8");
  await writeFile(maintenanceFile, "requested\n", "utf8");
  const preUpgradeQueueBytes = await readFile(queueFile);

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "controller-tool-structural");
  assert.equal(await readFile(maintenanceFile, "utf8"), "requested\n");

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "controller-tool-structural");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.phase, "blocked");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.deepEqual(recovered.blocker, repairedControllerBlocker);
  assert.equal(recovered.last_failure_evidence.failure.code, "CONTROLLER_TOOL_RECOVERED");
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  await assert.rejects(readFile(maintenanceFile), { code: "ENOENT" });
  assert.deepEqual(await readFile(queueFile), preUpgradeQueueBytes);
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved after v1.6.19\n");
  const upgradedManifest = await readJson(manifestFile);
  assert.deepEqual(upgradedManifest.migration_history.at(-1), {
    from_version: "1.6.19",
    to_version: "1.7.0",
    applied_at: upgradedManifest.migration_history.at(-1).applied_at,
    kind: "upgrade-recovery",
    recovered_task: "M001",
    recovery_reason: "controller-tool-structural",
  });
});

test("typed controller faults preserve an already-refunded zero attempt without dependency paths", async (t) => {
  const root = await createScaffold(t, { ready: true });
  await markInstalledVersion(root, "1.6.18");
  const sourceSkill = await nextReleaseSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  assert.deepEqual(queue.tasks.M001.allowed_paths, ["src/**"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "controller_tooling",
    error_code: "GATE_RUNNER_PROTOCOL_INVALID",
    message: "The controller gate runner returned an invalid typed envelope.",
    required_action: "Upgrade the controller-owned gate runner.",
    resume_condition: "The controller tool preflight succeeds.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: null,
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 0,
    baseline_head: baseline,
    last_failure_fingerprint: null,
    last_failure_evidence: {
      controller_faults: [{
        operation: "gate",
        error_code: "GATE_RUNNER_PROTOCOL_INVALID",
      }],
    },
    blocker,
  });
  queue.revision += 1;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await rm(candidateFile, { force: true });

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "controller-tool-structural");

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.attempt, 0);
  assert.deepEqual(recovered.last_failure_evidence.controller_faults, [{
    operation: "gate",
    error_code: "GATE_RUNNER_PROTOCOL_INVALID",
  }]);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
});
