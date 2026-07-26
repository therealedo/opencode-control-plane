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

async function upgradedSkill(t, version = "1.6.9") {
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

test("project upgrade changes only owned framework files, validates, commits, and stays reversible", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  const configFile = path.join(root, ".autopilot", "config.json");
  const queueFile = path.join(root, ".project", "plan", "queue.json");
  const beforeConfig = await readFile(configFile);
  const beforeQueue = await readFile(queueFile);

  const result = await invoke(root, sourceSkill);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.changed, true);
  assert.equal(output.from_version, "1.6.8");
  assert.equal(output.to_version, "1.6.9");
  assert.match(output.commit, /^[0-9a-f]{40,64}$/);
  assert.match(output.rollback, /^git revert /);
  assert.deepEqual(await readFile(configFile), beforeConfig);
  assert.deepEqual(await readFile(queueFile), beforeQueue);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /release fixture 1\.6\.9/);
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.version, "1.6.9");
  assert.equal(manifest.migration_history.at(-1).kind, "upgrade");
  assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.match(await git(root, ["log", "-1", "--pretty=%s"]), /control-plane: upgrade 1\.6\.8 to 1\.6\.9/);
});

test("project upgrade uses controller Conventional Commit identity for mapped projects", async (t) => {
  const root = await createScaffold(t, { ready: true });
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
    "chore(control-plane): upgrade 1.6.8 to 1.6.9",
  );
  assert.deepEqual(await readJson(configFile), config);
});

test("project upgrade honors a schema-6 fixed commit policy", async (t) => {
  const root = await createScaffold(t, { ready: true });
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
  assert.equal(await git(root, ["log", "-1", "--pretty=%s"]), "chore: upgrade 1.6.8 to 1.6.9");
  assert.deepEqual(await readJson(configFile), config);
});

test("interview refresh restores every managed byte when post-validation parsing fails", async (t) => {
  const root = await createScaffold(t);
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
  const sourceProject = await createScaffold(t, { ready: true });
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
  assert.equal(JSON.parse(result.stdout).to_version, "1.6.9");
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
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.6.9");
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
  const root = await createScaffold(t, { ready: true, mode: "success" });
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
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.6.8");
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
