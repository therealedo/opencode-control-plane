import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerProject } from "../.agents/skills/init-project/bin/lib/project-registry.mjs";
import { createScaffold, repositoryRoot, run } from "./runtime-helpers.mjs";

const globalDashboard = path.join(repositoryRoot, ".agents", "skills", "init-project", "bin", "control-plane-global.mjs");

test("global snapshot works outside projects and never executes registered project code", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-global-home-"));
  const unrelated = await mkdtemp(path.join(os.tmpdir(), "ocp-global-cwd-"));
  t.after(async () => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(unrelated, { recursive: true, force: true }),
  ]));
  const root = await createScaffold(t);
  await registerProject(root, { home, name: "Producer Scribe" });
  const sentinel = path.join(root, "project-code-executed.txt");
  await writeFile(path.join(root, ".autopilot", "bin", "autopilot.mjs"), `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(sentinel)}, "bad");\n`, "utf8");

  const result = await run([process.execPath, globalDashboard, "--home", home, "--snapshot", "--json"], { cwd: unrelated });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].name, "Producer Scribe");
  assert.equal(value.projects[0].available, true);
  await assert.rejects(access(sentinel), /ENOENT/);
});

test("global snapshot isolates missing projects instead of hiding them", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-global-missing-home-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const root = await createScaffold(t);
  await registerProject(root, { home, name: "Temporary project" });
  await rm(root, { recursive: true, force: true });

  const result = await run([process.execPath, globalDashboard, "--home", home, "--snapshot", "--json"], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].available, false);
  assert.match(value.projects[0].error, /does not exist/i);
});
