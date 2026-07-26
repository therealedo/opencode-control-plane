import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerProject } from "../.agents/skills/init-project/bin/lib/project-registry.mjs";
import { createScaffold, git, readJson, repositoryRoot, run, writeJson } from "./runtime-helpers.mjs";

const installer = path.join(repositoryRoot, "scripts", "install.mjs");
const upgrader = path.join(repositoryRoot, "scripts", "upgrade.mjs");
const fleetUpgrader = path.join(repositoryRoot, ".agents", "skills", "init-project", "bin", "upgrade-all-projects.mjs");

test("one-command upgrade validates source and previews the owned global update", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-system-upgrade-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const setup = await run([process.execPath, installer, "--home", home, "--json"], { cwd: repositoryRoot });
  assert.equal(setup.code, 0, setup.stderr);

  const result = await run([
    process.execPath,
    upgrader,
    "--local",
    "--dry-run",
    "--home",
    home,
    "--json",
  ], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.validation.ok, true);
  assert.equal(output.global_install.upgrade, true);
  assert.equal(output.global_install.dry_run, true);
  assert.equal(output.global_install.control_plane_version, "1.6.13");
});

test("one-command dry-run previews every registered initialized project", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-system-fleet-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const setup = await run([process.execPath, installer, "--home", home, "--json"], { cwd: repositoryRoot });
  assert.equal(setup.code, 0, setup.stderr);
  const project = await createScaffold(t, { ready: true });
  await registerProject(project, { home, name: "Producer Scribe" });

  const result = await run([
    process.execPath,
    upgrader,
    "--local",
    "--dry-run",
    "--all-projects",
    "--home",
    home,
    "--json",
  ], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.project_upgrades.total, 1);
  assert.equal(output.project_upgrades.complete, true);
  assert.equal(output.project_upgrades.results[0].name, "Producer Scribe");
  assert.equal(output.project_upgrades.results[0].status, "current");
});

test("fleet upgrade reaches the guarded exhausted-launch recovery instead of deferring it", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-system-recovery-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const project = await createScaffold(t, { ready: true, mode: "success" });
  const manifestFile = path.join(project, ".autopilot", "control-plane.json");
  const stateFile = path.join(project, ".autopilot", "state.json");
  const queueFile = path.join(project, ".project", "plan", "queue.json");
  const manifest = await readJson(manifestFile);
  manifest.version = "1.6.5";
  await writeJson(manifestFile, manifest);
  await git(project, ["add", ".autopilot/control-plane.json"]);
  await git(project, ["commit", "-m", "test: simulate affected 1.6.5 fleet project"]);
  const baseline = await git(project, ["rev-parse", "HEAD"]);
  const baselineQueue = await readFile(queueFile);
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    revision: 9,
    run_id: "fleet-exhausted-empty-opencode",
    status: "human_required",
    phase: "blocked",
    pid: null,
    started_at: new Date().toISOString(),
    active_task: "M001",
    attempt: 3,
    baseline_head: baseline,
    last_failure_fingerprint: "fleet-opencode-failed-fingerprint",
    last_failure_evidence: {
      schema_version: 1,
      failure: { code: "OPENCODE_FAILED", message: "Fresh OpenCode repair session failed" },
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
  await writeFile(path.join(project, ".autopilot", "MAINTENANCE"), "requested\n", "utf8");
  await registerProject(project, { home, name: "Recoverable project" });

  const preview = await run([process.execPath, fleetUpgrader, "--home", home, "--dry-run", "--json"], { cwd: repositoryRoot });
  assert.equal(preview.code, 0, preview.stderr || preview.stdout);
  const previewResult = JSON.parse(preview.stdout).results[0];
  assert.equal(previewResult.status, "preview");
  assert.equal(previewResult.recovery_kind, "exhausted-empty-opencode");

  const upgraded = await run([process.execPath, fleetUpgrader, "--home", home, "--json"], { cwd: repositoryRoot });
  assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
  const output = JSON.parse(upgraded.stdout);
  assert.equal(output.complete, true);
  assert.equal(output.results[0].status, "upgraded");
  assert.equal(output.results[0].recovery_kind, "exhausted-empty-opencode");
  assert.deepEqual(await readFile(queueFile), baselineQueue);
  const recovered = await readJson(stateFile);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.phase, "maintenance");
  assert.equal(recovered.active_task, null);
  assert.equal(recovered.attempt, 0);
});

test("fleet upgrade still defers an ordinary stopped active task", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-system-active-deferred-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const project = await createScaffold(t, { ready: true });
  const stateFile = path.join(project, ".autopilot", "state.json");
  const queueFile = path.join(project, ".project", "plan", "queue.json");
  const manifestFile = path.join(project, ".autopilot", "control-plane.json");
  const state = await readJson(stateFile);
  const queue = await readJson(queueFile);
  Object.assign(state, {
    status: "paused",
    phase: "paused",
    pid: null,
    active_task: "M001",
    attempt: 1,
    baseline_head: await git(project, ["rev-parse", "HEAD"]),
  });
  queue.project_status = "running";
  queue.tasks.M001.status = "in_progress";
  await writeJson(stateFile, state);
  await writeJson(queueFile, queue);
  const manifestBefore = await readFile(manifestFile);
  const queueBefore = await readFile(queueFile);
  await registerProject(project, { home, name: "Ordinary active project" });

  const result = await run([process.execPath, fleetUpgrader, "--home", home, "--json"], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.complete, false);
  assert.equal(output.results[0].status, "deferred");
  assert.equal(output.results[0].code, "ACTIVE_TASK");
  assert.deepEqual(await readFile(manifestFile), manifestBefore);
  assert.deepEqual(await readFile(queueFile), queueBefore);
  assert.equal((await readJson(stateFile)).attempt, 1);
});
