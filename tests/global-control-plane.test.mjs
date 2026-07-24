import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerProject } from "../.agents/skills/init-project/bin/lib/project-registry.mjs";
import {
  fleetActionMenu,
  nextFleetAction,
  renderFleet,
  terminalColorEnabled,
} from "../.agents/skills/init-project/bin/lib/global-control-plane-ui.mjs";
import { createScaffold, repositoryRoot, run } from "./runtime-helpers.mjs";

const globalDashboard = path.join(repositoryRoot, ".agents", "skills", "init-project", "bin", "control-plane-global.mjs");

test("fleet actions are arrow-selectable while preserving shortcut keys", () => {
  const project = { available: true, name: "Producer Scribe", mode: { id: "idle", label: "Ready" }, status: {} };
  const actions = fleetActionMenu(project);
  assert.deepEqual(actions.map((item) => item.id), ["open", "add", "forget", "update", "check", "refresh", "quit"]);
  assert.equal(actions[0].shortcut, "O");
  assert.equal(nextFleetAction(actions, 0, 1), 1);
  assert.equal(nextFleetAction(actions, 0, -1), 6);
  const withoutProject = fleetActionMenu(null);
  assert.equal(withoutProject[0].enabled, false);
  assert.equal(withoutProject[2].enabled, false);
  assert.equal(nextFleetAction(withoutProject, 0, 1), 1);

  const rendered = renderFleet({ projects: [project], selected: 0, selectedAction: 1, update: { installed_version: "1.4.5" } });
  assert.match(rendered, /Actions  ←\/→ select/);
  assert.match(rendered, /↑\/↓/);
  assert.match(rendered, /\[A: Add project\]/);
  assert.doesNotMatch(rendered, /\x1b/);

  const colored = renderFleet({
    projects: [project],
    selected: 0,
    selectedAction: 1,
    update: { installed_version: "1.4.5" },
    color: true,
  });
  assert.match(colored, /\x1b\[1;36m▶ Producer Scribe/);
  assert.match(colored, /\x1b\[1;30;46m← \[A: Add project\] →\x1b\[0m/);
});

test("fleet colors respect terminal capability and standard opt-outs", () => {
  assert.equal(terminalColorEnabled({ isTTY: true, env: {} }), true);
  assert.equal(terminalColorEnabled({ isTTY: false, env: {} }), false);
  assert.equal(terminalColorEnabled({ isTTY: true, env: { NO_COLOR: "1" } }), false);
  assert.equal(terminalColorEnabled({ isTTY: true, env: { FORCE_COLOR: "0" } }), false);
  assert.equal(terminalColorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } }), true);
  assert.equal(terminalColorEnabled({ isTTY: true, env: { TERM: "dumb" } }), false);
});

test("fleet rendering stays inside the requested terminal height", () => {
  const projects = Array.from({ length: 30 }, (_item, index) => ({
    available: true,
    name: `Project ${index + 1}`,
    mode: { id: index === 0 ? "running" : "idle", label: index === 0 ? "Running" : "Ready" },
    status: {},
    blueprint_version: 1,
    control_plane_version: "1.4.5",
  }));
  const height = 24;
  const rendered = renderFleet({
    projects,
    selected: 15,
    selectedAction: 0,
    update: { installed_version: "1.4.5" },
    message: "Ready.",
    width: 64,
    height,
  });
  assert.ok(rendered.split("\n").length <= height);
});

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
