import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createScaffold,
  git,
  makeReady,
  readJson,
  repositoryRoot,
  run,
  writeJson,
} from "./runtime-helpers.mjs";

const upgrader = path.join(repositoryRoot, ".agents", "skills", "init-project", "bin", "upgrade-project.mjs");

async function upgradedSkill(t, version = "1.6.19") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ocp-release-fixture-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const skills = path.join(repositoryRoot, ".agents", "skills");
  await cp(path.join(skills, "init-project"), path.join(parent, "init-project"), { recursive: true });
  await cp(path.join(skills, "evolve-project"), path.join(parent, "evolve-project"), { recursive: true });
  const releaseFile = path.join(parent, "init-project", "assets", "control-plane-release.json");
  const release = await readJson(releaseFile);
  release.version = version;
  await writeJson(releaseFile, release);
  const agents = path.join(parent, "init-project", "assets", "project", "AGENTS.md");
  await writeFile(agents, `${await readFile(agents, "utf8")}\nControl Plane release fixture ${version}.\n`, "utf8");
  return path.join(parent, "init-project");
}

async function invoke(root, sourceSkill, extra = [], env = undefined) {
  return run([process.execPath, upgrader, "--target", root, "--source-skill", sourceSkill, "--json", ...extra], { cwd: root, env });
}

async function createPriorScaffold(t, options = {}) {
  const root = await createScaffold(t, options);
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.14";
  await writeJson(manifestFile, manifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate installed 1.6.14 release"]);
  return root;
}

test("project upgrade changes only owned framework files, validates, commits, and stays reversible", async (t) => {
  const root = await createPriorScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const configFile = path.join(root, ".autopilot", "config.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const beforeConfig = await readFile(configFile);
  const beforeQueue = await readFile(queueFile);

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.changed, true);
  assert.equal(output.from_version, "1.6.14");
  assert.equal(output.to_version, "1.6.19");
  assert.match(output.commit, /^[0-9a-f]{40,64}$/);
  assert.match(output.rollback, /^git revert /);
  assert.deepEqual(await readFile(configFile), beforeConfig);
  assert.deepEqual(await readFile(queueFile), beforeQueue);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /release fixture 1\.6\.19/);
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.version, "1.6.19");
  assert.equal(manifest.migration_history.at(-1).kind, "upgrade");
  assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.match(await git(root, ["log", "-1", "--pretty=%s"]), /control-plane: upgrade 1\.6\.14 to 1\.6\.19/);
});

test("project upgrade preserves and unlocks the v1.6.9 literal-directory path blocker", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t, "1.6.10");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.9";
  await writeJson(installedManifestFile, installedManifest);
  queue.tasks.M001.allowed_paths = ["src"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish literal directory task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "path_boundary",
    message: "Allowed directory entries are not writable as prefixes, and the repository has no pre-existing apps, packages, or tests directories.",
    required_action: "Authorize descendant file creation under src (or initialize that directory in the task workspace).",
    resume_condition: "autopilot_write accepts files beneath each directory path listed in M001 allowed_paths.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-literal-boundary-test",
    started_at: "2026-07-26T00:00:00.000Z",
    heartbeat_at: "2026-07-26T00:01:00.000Z",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 1,
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
    attempt: 1,
    status: "blocked",
    summary: "No application changes retained because literal directory descendants were rejected.",
    environment_variables: [],
    blocker,
  });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "preserved.txt"), "preserve task work\n", "utf8");

  await writeFile(path.join(root, "outside.txt"), "must block recovery\n", "utf8");
  const rejected = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.notEqual(rejected.code, 0);
  assert.equal(JSON.parse(rejected.stderr).code, "ACTIVE_TASK");
  await unlink(path.join(root, "outside.txt"));

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "literal-directory-path-boundary");
  assert.equal(output.recovered_active_task, "M001");
  const upgradedState = await readJson(stateFile);
  const upgradedQueue = await readJson(queueFile);
  const upgradedHead = await git(root, ["rev-parse", "HEAD"]);
  assert.equal(upgradedState.status, "human_required");
  assert.equal(upgradedState.phase, "blocked");
  assert.equal(upgradedState.active_task, "M001");
  assert.equal(upgradedState.attempt, 1);
  assert.equal(upgradedState.baseline_head, upgradedHead);
  assert.equal(upgradedQueue.project_status, "blocked");
  assert.equal(upgradedQueue.tasks.M001.status, "blocked");
  assert.deepEqual(upgradedQueue.tasks.M001.allowed_paths, ["src"]);
  assert.equal(await readFile(path.join(root, "src", "preserved.txt"), "utf8"), "preserve task work\n");
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).migration_history.at(-1).recovery_reason, "literal-directory-path-boundary");
  assert.deepEqual(
    new Set((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).split(/\r?\n/)),
    new Set(["M .project/plan/queue.json", "?? src/preserved.txt"]),
  );
});

test("project upgrade preserves and refunds the exact exhausted v1.6.10 Corepack shim task", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t, "1.6.12");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.10";
  await writeJson(installedManifestFile, installedManifest);
  queue.tasks.M001.allowed_paths = ["package.json", "apps/web"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish Corepack recovery task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "gate_configuration",
    message: "The authoritative gate argv resolves `corepack` to a Windows `.cmd` shim without a matching PowerShell shim; gate/control files are outside the allowed paths and may not be changed.",
    required_action: "Update the fixed Windows gate launcher to use a native executable or invoke Corepack through an explicit Node script argv.",
    resume_condition: "Resume once the authoritative credential-free gates can launch Corepack on Windows without the unsupported shim.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-corepack-recovery-test",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "corepack-shim-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: {
        code: "WINDOWS_SHIM_UNSUPPORTED",
        message: "Windows command shim C:\\tools\\corepack.cmd has no matching PowerShell shim; use a native executable or an explicit node script argv",
      },
    },
    blocker,
  });
  queue.revision += 3;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 3,
    status: "blocked",
    summary: "The fixed gate launcher cannot run Corepack.",
    environment_variables: [],
    blocker,
  });
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "apps", "web", "preserved.txt"), "preserved work\n", "utf8");

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "exhausted-corepack-shim");
  assert.equal(output.recovered_active_task, "M001");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.phase, "blocked");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  const recoveredQueue = await readJson(queueFile);
  assert.equal(recoveredQueue.project_status, "blocked");
  assert.equal(recoveredQueue.tasks.M001.status, "blocked");
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "web", "preserved.txt"), "utf8"), "preserved work\n");
  assert.deepEqual(
    new Set((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).split(/\r?\n/)),
    new Set(["M .project/plan/queue.json", "?? apps/web/preserved.txt", "?? package.json"]),
  );
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.migration_history.at(-1).recovery_reason, "exhausted-corepack-shim");
});

test("project upgrade preserves and refunds the exact v1.6.12 dependency-lock authority blocker", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t, "1.6.13");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.12";
  await writeJson(installedManifestFile, installedManifest);
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish dependency lock task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "tooling_authority",
    message: "The available file-only tools cannot generate the complete pnpm 11.14.0 transitive lockfile, and the credential-free gate runner did not provide actionable output.",
    required_action: "Provide an approved credential-free pnpm 11.14.0 lockfile-generation action (or a complete generated lockfile) and restore bounded feedback-gate execution.",
    resume_condition: "A complete generated workspace lockfile or approved generation tool is available and the listed gates can return results.",
  };
  Object.assign(state, {
    revision: state.revision + 1, run_id: "run-dependency-lock-test",
    status: "human_required", phase: "blocked", pid: null, active_task: "M001",
    attempt: 2, baseline_head: baseline, last_failure_fingerprint: null,
    last_failure_evidence: null, blocker,
  });
  queue.revision += 2;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1, task_id: "M001", attempt: 2, status: "blocked",
    summary: "The lockfile needs deterministic resolution.", environment_variables: [], blocker,
  });
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"packageManager":"pnpm@11.14.0"}\n', "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved work\n", "utf8");

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "v1612-dependency-lock");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.deepEqual(recovered.blocker, blocker);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved work\n");
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).migration_history.at(-1).recovery_reason, "v1612-dependency-lock");
});

test("project upgrade preserves and refunds the exact v1.6.13 lockfile telemetry failure", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t, "1.6.14");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.13";
  await writeJson(manifestFile, manifest);
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps"];
  queue.tasks.M001.attempt_limit = 3;
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish lockfile telemetry recovery task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "gate_infrastructure",
    message: "The controller-owned unit gate is invoking OpenCode with invalid usage, so repository behavior cannot be evaluated.",
    required_action: "Correct the controller gate invocation; do not change repository scripts, gate definitions, or control files to mask it.",
    resume_condition: "Resume when the approved unit gate runs its intended credential-free test command.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-lockfile-telemetry-test",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "lockfile-telemetry-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: {
        code: "OPENCODE_TOOL_USAGE_INVALID",
        message: "OpenCode phase tool usage is invalid",
      },
    },
    blocker,
  });
  queue.revision += 3;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 3,
    status: "blocked",
    summary: "The lockfile action completed, but controller telemetry validation rejected its counter.",
    environment_variables: [],
    blocker,
  });
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"packageManager":"pnpm@11.14.0"}\n', "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved work\n", "utf8");

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "v1613-lockfile-telemetry");

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "v1613-lockfile-telemetry");
  assert.equal(output.recovered_active_task, "M001");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.phase, "blocked");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.deepEqual(recovered.blocker, blocker);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved work\n");
  assert.equal((await readJson(manifestFile)).migration_history.at(-1).recovery_reason, "v1613-lockfile-telemetry");
});

test("project upgrade preserves and refunds the exact v1.6.14 controller-runner failure", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.14";
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps"];
  await writeJson(manifestFile, manifest);
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish controller-runner recovery task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "controller_tooling",
    message: "Credential-free controller actions are unavailable/misrouted; pnpm-lock.yaml remains without resolved package snapshots, so frozen-install and required gate evidence cannot be produced safely.",
    required_action: "Restore the controller-owned pnpm lockfile resolver and gate runner, then rerun this phase.",
    resume_condition: "autopilot_lockfile can generate a complete pnpm 11.14.0 workspace lockfile and the listed gates execute their repository scripts.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-controller-runner-test",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 2,
    baseline_head: baseline,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    task_tool_usage: {
      "execute:a2": {
        schema_version: 1,
        phase: "execute",
        task_id: "M001",
        tool_calls: 2,
        returned_bytes: 12,
        by_tool: {
          read: { calls: 1, returned_bytes: 12 },
          lockfile: { calls: 1, returned_bytes: 0 },
        },
      },
    },
    blocker,
  });
  queue.revision += 2;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 2,
    status: "blocked",
    summary: "Controller scripts were routed through the worker host executable.",
    environment_variables: [],
    blocker,
  });
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"packageManager":"pnpm@11.14.0"}\n', "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved work\n", "utf8");

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "v1614-controller-runner");
  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "v1614-controller-runner");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.deepEqual(recovered.blocker, blocker);
  assert.deepEqual(recovered.task_tool_usage, state.task_tool_usage);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved work\n");
  assert.equal((await readJson(manifestFile)).migration_history.at(-1).recovery_reason, "v1614-controller-runner");
});

test("project upgrade preserves and refunds the exact v1.6.17 gate-cleanup failure", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.17";
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "apps"];
  await writeJson(manifestFile, manifest);
  await writeJson(queueFile, queue);
  await git(root, ["add", ".autopilot/control-plane.json", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish gate-cleanup recovery task"]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const blocker = {
    kind: "environment",
    message: "The controller gate runner reports GATE_CLEANUP_FAILED before gate execution.",
    required_action: "Repair or clear the controller-owned gate sandbox/cleanup state, then start a fresh repair attempt.",
    resume_condition: "Credential-free gates can execute and return application diagnostics.",
  };
  Object.assign(state, {
    revision: state.revision + 1,
    run_id: "run-gate-cleanup-test",
    status: "human_required",
    phase: "blocked",
    pid: null,
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "gate-cleanup-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: {
        code: "OPENCODE_TOOL_USAGE_INVALID",
        message: "OpenCode phase tool usage is invalid",
      },
    },
    task_tool_usage: {
      "execute:a2": {
        schema_version: 1,
        phase: "execute",
        task_id: "M001",
        tool_calls: 2,
        returned_bytes: 12,
        by_tool: {
          read: { calls: 1, returned_bytes: 12 },
          lockfile: { calls: 1, returned_bytes: 0 },
        },
      },
      "repair:a3": {
        schema_version: 1,
        phase: "repair",
        task_id: "M001",
        tool_calls: 1,
        returned_bytes: 8,
        by_tool: { check: { calls: 1, returned_bytes: 8 } },
      },
    },
    blocker,
  });
  queue.revision += 3;
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 3,
    status: "blocked",
    summary: "Controller gate cleanup failed before the feedback gate could return diagnostics.",
    environment_variables: [],
    blocker,
  });
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"packageManager":"pnpm@11.14.0"}\n', "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "preserved.txt"), "preserved work\n", "utf8");

  const preview = await invoke(root, sourceSkill, ["--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).recovery_kind, "v1617-gate-cleanup");
  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "v1617-gate-cleanup");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  assert.deepEqual(recovered.blocker, blocker);
  assert.deepEqual(recovered.task_tool_usage, state.task_tool_usage);
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "preserved.txt"), "utf8"), "preserved work\n");
  assert.equal((await readJson(manifestFile)).migration_history.at(-1).recovery_reason, "v1617-gate-cleanup");
});

test("project upgrade reconnects files detached by the v1.6.11 Corepack recovery", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t, "1.6.12");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const candidateFile = path.join(root, ".autopilot", "runtime", "candidate.json");
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const queue = await readJson(queueFile);
  queue.tasks.M001.allowed_paths = ["package.json", "apps/web"];
  await writeJson(queueFile, queue);
  await git(root, ["add", ".project/plan/queue.json"]);
  await git(root, ["commit", "-m", "test: establish pre-recovery task"]);
  const oldBaseline = await git(root, ["rev-parse", "HEAD"]);
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.11";
  manifest.migration_history.push({
    from_version: "1.6.10",
    to_version: "1.6.11",
    applied_at: "2026-07-26T06:58:10.162Z",
    kind: "upgrade-recovery",
    recovered_task: "M001",
    recovery_reason: "exhausted-corepack-shim",
  });
  await writeJson(manifestFile, manifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate v1.6.11 reset recovery"]);
  const state = await readJson(stateFile);
  Object.assign(state, {
    revision: 43,
    run_id: null,
    status: "paused",
    phase: "maintenance",
    pid: null,
    started_at: null,
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
    baseline_head: oldBaseline,
  });
  await writeJson(stateFile, state);
  await writeJson(candidateFile, {
    schema_version: 1,
    task_id: "M001",
    attempt: 3,
    status: "blocked",
    summary: "The fixed gate launcher cannot run Corepack.",
    environment_variables: [],
    blocker: {
      kind: "gate_configuration",
      message: "The authoritative gate argv resolves `corepack` to a Windows `.cmd` shim without a matching PowerShell shim; gate/control files are outside the allowed paths and may not be changed.",
      required_action: "Update the fixed Windows gate launcher to use a native executable or invoke Corepack through an explicit Node script argv.",
      resume_condition: "Resume once the authoritative credential-free gates can launch Corepack on Windows without the unsupported shim.",
    },
  });
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "apps", "web", "preserved.txt"), "preserved work\n", "utf8");

  const preUpgradeState = await readJson(stateFile);
  const preUpgradeQueue = await readFile(queueFile);
  const preUpgradeCandidate = await readFile(candidateFile);
  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovery_kind, "v1611-corepack-reset-repair");
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "human_required");
  assert.equal(recovered.phase, "blocked");
  assert.equal(recovered.active_task, "M001");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.baseline_head, output.commit);
  const recoveredQueue = await readJson(queueFile);
  assert.equal(recoveredQueue.project_status, "blocked");
  assert.equal(recoveredQueue.tasks.M001.status, "blocked");
  await assert.rejects(readFile(candidateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "apps", "web", "preserved.txt"), "utf8"), "preserved work\n");
  assert.equal((await readJson(manifestFile)).migration_history.at(-1).recovery_reason, "v1611-corepack-reset-repair");

  const rollback = await run(output.rollback.argv, { cwd: root });
  assert.equal(rollback.code, 0, rollback.stderr || rollback.stdout);
  const rollbackOutput = JSON.parse(rollback.stdout);
  const restored = await readJson(stateFile);
  assert.deepEqual(restored, {
    ...preUpgradeState,
    revision: restored.revision,
    heartbeat_at: restored.heartbeat_at,
    baseline_head: rollbackOutput.rollback_commit,
  });
  assert.deepEqual(await readFile(queueFile), preUpgradeQueue);
  assert.deepEqual(await readFile(candidateFile), preUpgradeCandidate);
  assert.equal(restored.baseline_head, await git(root, ["rev-parse", "HEAD"]));
});

test("project upgrade uses controller Conventional Commit identity for mapped projects", async (t) => {
  const root = await createPriorScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const configFile = path.join(root, ".autopilot", "config.json");
  const config = await readJson(configFile);
  config.schema_version = 2;
  delete config.git.commit_prefix;
  config.git.commit_prefixes = { M001: "fix(auth)" };
  await writeJson(configFile, config);
  await git(root, ["add", ".autopilot/config.json"]);
  await git(root, ["commit", "-m", "test: configure mapped commit policy"]);

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(
    await git(root, ["log", "-1", "--pretty=%s"]),
    "chore(control-plane): upgrade 1.6.14 to 1.6.19",
  );
  assert.deepEqual(await readJson(configFile), config);
});

test("project upgrade honors a schema-6 fixed commit policy", async (t) => {
  const root = await createPriorScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const configFile = path.join(root, ".autopilot", "config.json");
  const config = await readJson(configFile);
  config.schema_version = 2;
  config.git.commit_prefix = "chore";
  delete config.git.commit_prefixes;
  await writeJson(configFile, config);
  await git(root, ["add", ".autopilot/config.json"]);
  await git(root, ["commit", "-m", "test: configure fixed schema-6 commit policy"]);

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(await git(root, ["log", "-1", "--pretty=%s"]), "chore: upgrade 1.6.14 to 1.6.19");
  assert.deepEqual(await readJson(configFile), config);
});

test("interview refresh restores every managed byte when post-validation parsing fails", async (t) => {
  const root = await createPriorScaffold(t);
  const sourceSkill = await upgradedSkill(t);
  const brokenValidator = path.join(
    sourceSkill,
    "assets",
    "project",
    ".autopilot",
    "bin",
    "validate.mjs",
  );
  await writeFile(brokenValidator, '#!/usr/bin/env node\nprocess.stdout.write("not-json\\n");\n', "utf8");

  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const manifestBytes = await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const before = new Map();
  for (const relative of Object.keys(manifest.managed_files)) {
    before.set(relative, await readFile(path.join(root, ...relative.split("/"))));
  }

  const result = await invoke(root, sourceSkill, ["--interview"]);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /JSON|not-json|Unexpected token/i);
  assert.deepEqual(await readFile(manifestFile), manifestBytes);
  for (const [relative, bytes] of before) {
    assert.deepEqual(await readFile(path.join(root, ...relative.split("/"))), bytes, relative);
  }
});

test("project upgrade fails closed on committed managed drift before writing", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const agents = path.join(root, "AGENTS.md");
  await writeFile(agents, `${await readFile(agents, "utf8")}\nuser drift\n`, "utf8");
  await git(root, ["add", "AGENTS.md"]);
  await git(root, ["commit", "-m", "test: committed framework drift"]);
  const head = await git(root, ["rev-parse", "HEAD"]);

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "CONTROL_PLANE_DRIFT");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), head);
  assert.doesNotMatch(await readFile(agents, "utf8"), /release fixture/);
});

test("project upgrade honors the checkout's global CRLF normalization without enabling ambient Git behavior", async (t) => {
  const sourceProject = await createPriorScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const gitHome = await mkdtemp(path.join(os.tmpdir(), "ocp-git-home-"));
  t.after(async () => rm(gitHome, { recursive: true, force: true }));
  await writeFile(path.join(gitHome, ".gitconfig"), "[core]\n\tautocrlf = true\n[user]\n\tname = Test User\n\temail = test@example.invalid\n", "utf8");
  const environment = { ...process.env, HOME: gitHome, USERPROFILE: gitHome };

  const cloneParent = await mkdtemp(path.join(os.tmpdir(), "ocp-crlf-clone-"));
  t.after(async () => rm(cloneParent, { recursive: true, force: true }));
  const root = path.join(cloneParent, "project");
  const cloned = await run(["git", "-c", "core.autocrlf=true", "clone", "--no-hardlinks", sourceProject, root], { cwd: cloneParent, env: environment });
  assert.equal(cloned.code, 0, cloned.stderr || cloned.stdout);
  await Promise.all([
    mkdir(path.join(root, ".autopilot", "runtime"), { recursive: true }),
    mkdir(path.join(root, ".autopilot", "artifacts"), { recursive: true }),
    cp(path.join(sourceProject, ".autopilot", "state.json"), path.join(root, ".autopilot", "state.json")),
    cp(path.join(sourceProject, ".autopilot", "init"), path.join(root, ".autopilot", "init"), { recursive: true, force: true }),
  ]);
  assert.match(await readFile(path.join(root, ".project", "brief.md"), "utf8"), /\r\n/, "the fixture must contain checkout-generated CRLF text");
  const ordinaryStatus = await run(["git", "-c", "core.autocrlf=true", "status", "--porcelain=v1"], { cwd: root, env: environment });
  assert.equal(ordinaryStatus.code, 0, ordinaryStatus.stderr);
  assert.equal(ordinaryStatus.stdout, "", "the checkout must be clean under the normalization used to create it");

  const result = await invoke(root, sourceSkill, [], environment);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).to_version, "1.6.19");
});

test("legacy CRLF projects adopt without rebuilding or rewriting project-owned context", async (t) => {
  const sourceProject = await createScaffold(t, { ready: true });
  await Promise.all([
    unlink(path.join(sourceProject, ".gitattributes")),
    unlink(path.join(sourceProject, ".autopilot", "control-plane.json")),
  ]);
  await git(sourceProject, ["add", "-A"]);
  await git(sourceProject, ["commit", "-m", "test: legacy project before versioned ownership"]);
  const sourceSkill = await upgradedSkill(t);

  const gitHome = await mkdtemp(path.join(os.tmpdir(), "ocp-legacy-git-home-"));
  const cloneParent = await mkdtemp(path.join(os.tmpdir(), "ocp-legacy-crlf-clone-"));
  t.after(async () => Promise.all([
    rm(gitHome, { recursive: true, force: true }),
    rm(cloneParent, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(gitHome, ".gitconfig"), "[core]\n\tautocrlf = true\n[user]\n\tname = Test User\n\temail = test@example.invalid\n", "utf8");
  const environment = { ...process.env, HOME: gitHome, USERPROFILE: gitHome };
  const root = path.join(cloneParent, "project");
  const cloned = await run(["git", "clone", "--no-hardlinks", sourceProject, root], { cwd: cloneParent, env: environment });
  assert.equal(cloned.code, 0, cloned.stderr || cloned.stdout);
  await Promise.all([
    mkdir(path.join(root, ".autopilot", "runtime"), { recursive: true }),
    mkdir(path.join(root, ".autopilot", "artifacts"), { recursive: true }),
    cp(path.join(sourceProject, ".autopilot", "state.json"), path.join(root, ".autopilot", "state.json")),
    cp(path.join(sourceProject, ".autopilot", "init"), path.join(root, ".autopilot", "init"), { recursive: true, force: true }),
  ]);
  const roleBefore = await readFile(path.join(root, ".opencode", "agents", "autopilot-worker.md"), "utf8");
  assert.match(roleBefore, /\r\n/, "the legacy role fixture must use checkout-generated CRLF text");
  const ordinaryStatus = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, env: environment });
  assert.equal(ordinaryStatus.code, 0, ordinaryStatus.stderr);
  assert.equal(ordinaryStatus.stdout, "");

  const result = await invoke(root, sourceSkill, ["--adopt"], environment);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.adopted_legacy_project, true);
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.6.19");
  assert.match(await readFile(path.join(root, ".gitattributes"), "utf8"), /Control Plane-owned text/);
  const finalStatus = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, env: environment });
  assert.equal(finalStatus.stdout, "", finalStatus.stderr || finalStatus.stdout);
});

test("project upgrade refuses active controller transactions even when ignored state is clean", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const state = await readJson(stateFile);
  state.status = "running";
  state.active_task = "M001";
  state.started_at = new Date().toISOString();
  await writeJson(stateFile, state);

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).code, "ACTIVE_TASK");
});

test("project upgrade crosses only the legacy evidence-less empty-task boundary", async (t) => {
  const root = await createPriorScaffold(t, { ready: true, mode: "success" });
  const sourceSkill = await upgradedSkill(t);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const runtime = path.join(root, ".autopilot", "runtime");
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    run_id: "legacy-upgrade-recovery",
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: new Date().toISOString(),
    active_task: "M001",
    attempt: 2,
    baseline_head: baseline,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    blocker: {
      kind: "insufficient_evidence",
      message: "No actionable failure fingerprint was supplied.",
      required_action: "Provide failure evidence.",
      resume_condition: "Actionable evidence is available.",
    },
  });
  queue.project_status = "blocked";
  queue.tasks.M001.status = "blocked";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: "M001",
    attempt: 2,
    status: "blocked",
    summary: "No failure evidence was supplied.",
    environment_variables: [],
    blocker: {
      kind: "insufficient_evidence",
      message: "No actionable failure fingerprint was supplied.",
      required_action: "Provide failure evidence.",
      resume_condition: "Actionable evidence is available.",
    },
  });

  const upgraded = await invoke(root, sourceSkill);
  assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
  const output = JSON.parse(upgraded.stdout);
  assert.equal(output.recovered_active_task, "M001");
  const upgradedState = await readJson(stateFile);
  assert.equal(upgradedState.status, "human_required");
  assert.equal(upgradedState.attempt, 2);
  assert.equal(upgradedState.baseline_head, output.commit);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "M .project/plan/queue.json");

  const resumed = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
    { cwd: root },
  );
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
  const completed = await readJson(stateFile);
  const invocations = await readJson(path.join(runtime, "fake-invocations.json"));
  assert.equal(completed.status, "complete", JSON.stringify({ completed, resumed }, null, 2));
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 2],
    ["review", 2],
  ]);
});

test("project upgrade safely refunds an exhausted OpenCode launch that changed no project files", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" });
  const sourceSkill = await upgradedSkill(t);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.5";
  await writeJson(installedManifestFile, installedManifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate affected 1.6.5 project"]);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const baselineQueue = await readFile(queueFile);
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    revision: 9,
    run_id: "exhausted-empty-opencode",
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: new Date().toISOString(),
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "opencode-failed-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: {
        code: "OPENCODE_FAILED",
        message: "Fresh OpenCode repair session failed; raw output was not persisted",
        details_excerpt: JSON.stringify({ code: 1, output_hash: "a".repeat(64) }),
      },
    },
    blocker: {
      kind: "repair_exhausted",
      error_code: "OPENCODE_FAILED",
      message: "Repair stopped after attempt 3",
      required_action: "Inspect the bounded checkpoint.",
      resume_condition: "The explicit resume command is run.",
    },
  });
  queue.revision = Number(queue.revision ?? 0) + 4;
  queue.project_status = "running";
  queue.tasks.M001.status = "in_progress";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeFile(path.join(root, ".autopilot", "MAINTENANCE"), "requested\n", "utf8");

  const upgraded = await invoke(root, sourceSkill);
  assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
  const output = JSON.parse(upgraded.stdout);
  assert.equal(output.recovered_active_task, "M001");
  assert.equal(output.recovery_kind, "exhausted-empty-opencode");
  assert.deepEqual(await readFile(queueFile), baselineQueue);
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.phase, "maintenance");
  assert.equal(recovered.active_task, null);
  assert.equal(recovered.attempt, 0);
  assert.equal(recovered.last_failure_evidence, null);
  assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.deepEqual(
    {
      kind: manifest.migration_history.at(-1).kind,
      task: manifest.migration_history.at(-1).recovered_task,
      reason: manifest.migration_history.at(-1).recovery_reason,
    },
    { kind: "upgrade-recovery", task: "M001", reason: "exhausted-empty-opencode" },
  );
});

test("project upgrade refunds a v1.6.7 authentication-only exhaustion with retained proof", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" });
  const sourceSkill = await upgradedSkill(t);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.7";
  await writeJson(installedManifestFile, installedManifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate affected 1.6.7 auth project"]);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const baselineQueue = await readFile(queueFile);
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    revision: 12,
    run_id: "v167-auth-exhaustion",
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: new Date().toISOString(),
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "v167-auth-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: {
        code: "OPENCODE_FAILED",
        message: "Fresh OpenCode repair session failed; a bounded sanitized diagnostic was retained",
        details_excerpt: JSON.stringify({
          code: 1,
          output_hash: "b".repeat(64),
          diagnostic_excerpt: `stdout:\n${JSON.stringify({
            type: "error",
            sessionID: "fixture-auth-session",
            error: { name: "UnknownError", data: { message: "Token refresh failed: 401" } },
          })}`,
        }),
      },
    },
    blocker: {
      kind: "repair_exhausted",
      error_code: "OPENCODE_FAILED",
      message: "Repair stopped after attempt 3: Token refresh failed: 401",
      required_action: "Reconnect the provider.",
      resume_condition: "Authentication succeeds.",
    },
  });
  queue.revision = Number(queue.revision ?? 0) + 6;
  queue.project_status = "running";
  queue.tasks.M001.status = "in_progress";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.recovered_active_task, "M001");
  assert.equal(output.recovery_kind, "exhausted-provider-auth");
  assert.deepEqual(await readFile(queueFile), baselineQueue);
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.phase, "maintenance");
  assert.equal(recovered.active_task, null);
  assert.equal(recovered.attempt, 0);
  assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.migration_history.at(-1).kind, "upgrade-recovery");
  assert.equal(manifest.migration_history.at(-1).recovery_reason, "exhausted-provider-auth");
});

test("project upgrade does not trust authentication words outside a structured provider event", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" });
  const sourceSkill = await upgradedSkill(t);
  const manifestFile = path.join(root, ".autopilot", "control-plane.json");
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.7";
  await writeJson(manifestFile, manifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate unproven 1.6.7 failure"]);
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    status: "human_required", phase: "blocked", pid: null, active_task: "M001", attempt: 3,
    baseline_head: await git(root, ["rev-parse", "HEAD"]),
    last_failure_fingerprint: "unproven-auth-words",
    last_failure_evidence: {
      failure: {
        code: "OPENCODE_FAILED",
        details_excerpt: JSON.stringify({ code: 1, diagnostic_excerpt: "stdout:\nToken refresh failed: 401" }),
      },
    },
    blocker: { kind: "repair_exhausted", error_code: "OPENCODE_FAILED" },
  });
  queue.project_status = "running";
  queue.tasks.M001.status = "in_progress";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).code, "ACTIVE_TASK");
  assert.equal((await readJson(stateFile)).attempt, 3);
  assert.equal((await readJson(manifestFile)).version, "1.6.7");
});

test("project upgrade never refunds an exhausted OpenCode task with application changes", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const installedManifestFile = path.join(root, ".autopilot", "control-plane.json");
  const installedManifest = await readJson(installedManifestFile);
  installedManifest.version = "1.6.5";
  await writeJson(installedManifestFile, installedManifest);
  await git(root, ["add", ".autopilot/control-plane.json"]);
  await git(root, ["commit", "-m", "test: simulate affected 1.6.5 project"]);
  const stateFile = path.join(root, ".autopilot", "state.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    status: "human_required", phase: "blocked", pid: null, active_task: "M001", attempt: 3,
    baseline_head: await git(root, ["rev-parse", "HEAD"]),
    last_failure_fingerprint: "failure",
    last_failure_evidence: { failure: { code: "OPENCODE_FAILED" } },
    blocker: { kind: "repair_exhausted", error_code: "OPENCODE_FAILED" },
  });
  queue.project_status = "running";
  queue.tasks.M001.status = "in_progress";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  await writeFile(path.join(root, "application-change.txt"), "must be preserved\n", "utf8");

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).code, "DIRTY_WORKTREE");
  assert.equal(await readFile(path.join(root, "application-change.txt"), "utf8"), "must be preserved\n");
});

test("project upgrade rejects hidden Git index flags before writing", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  await git(root, ["update-index", "--assume-unchanged", "AGENTS.md"]);

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).code, "UNSAFE_GIT_INDEX");
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.6.19");
});

test("legacy project adoption requires explicit approval and preserves unmarked ignore content", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const manifest = path.join(root, ".autopilot", "control-plane.json");
  const ignore = path.join(root, ".ignore");
  const customIgnore = "custom-user-cache/\n";
  await unlink(manifest);
  await writeFile(ignore, customIgnore, "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "test: legacy project fixture"]);

  const blocked = await invoke(root, sourceSkill);
  assert.notEqual(blocked.code, 0);
  assert.equal(JSON.parse(blocked.stderr).code, "ADOPTION_REQUIRED");

  const adopted = await invoke(root, sourceSkill, ["--adopt"]);
  assert.equal(adopted.code, 0, adopted.stderr);
  const output = JSON.parse(adopted.stdout);
  assert.equal(output.adopted_legacy_project, true);
  const ignoreAfter = await readFile(ignore, "utf8");
  assert.match(ignoreAfter, /^custom-user-cache\//);
  assert.match(ignoreAfter, /BEGIN OPENCODE CONTROL PLANE MANAGED/);
  assert.equal((await readJson(manifest)).migration_history.at(-1).kind, "legacy-adoption");
});
