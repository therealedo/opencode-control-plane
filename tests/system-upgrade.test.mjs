import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerProject } from "../.agents/skills/init-project/bin/lib/project-registry.mjs";
import { createScaffold, repositoryRoot, run } from "./runtime-helpers.mjs";

const installer = path.join(repositoryRoot, "scripts", "install.mjs");
const upgrader = path.join(repositoryRoot, "scripts", "upgrade.mjs");

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
  assert.equal(output.global_install.control_plane_version, "1.5.0");
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
