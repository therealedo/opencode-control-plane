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

async function upgradedSkill(t, version = "1.4.6") {
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
  assert.equal(output.from_version, "1.4.5");
  assert.equal(output.to_version, "1.4.6");
  assert.match(output.commit, /^[0-9a-f]{40,64}$/);
  assert.match(output.rollback, /^git revert /);
  assert.deepEqual(await readFile(configFile), beforeConfig);
  assert.deepEqual(await readFile(queueFile), beforeQueue);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /release fixture 1\.4\.6/);
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"));
  assert.equal(manifest.version, "1.4.6");
  assert.equal(manifest.migration_history.at(-1).kind, "upgrade");
  assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.match(await git(root, ["log", "-1", "--pretty=%s"]), /control-plane: upgrade 1\.4\.5 to 1\.4\.6/);
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
  assert.equal(JSON.parse(result.stdout).to_version, "1.4.6");
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
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.4.6");
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

test("project upgrade rejects hidden Git index flags before writing", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const sourceSkill = await upgradedSkill(t);
  await git(root, ["update-index", "--assume-unchanged", "AGENTS.md"]);

  const result = await invoke(root, sourceSkill);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).code, "UNSAFE_GIT_INDEX");
  assert.equal((await readJson(path.join(root, ".autopilot", "control-plane.json"))).version, "1.4.5");
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
