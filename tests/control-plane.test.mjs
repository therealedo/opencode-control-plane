import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  actionMenu,
  controllerArguments,
  controllerMode,
  primaryAction,
  renderDashboard,
  safeText,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/control-plane-ui.mjs";
import {
  nextRuntimeVariant,
  readRuntimeSettings,
  writeRuntimeVariant,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/runtime-settings.mjs";
import {
  parseArgs as parseDashboardArgs,
  restoreTerminalInput,
  upgradeNeedsMaintenanceDrain,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/control-plane.mjs";
import { createScaffold, readJson, run, writeJson } from "./runtime-helpers.mjs";

test("dashboard derives safe context actions without touching controller state", () => {
  assert.equal(primaryAction({ status: "idle" }).id, "start");
  assert.equal(primaryAction({ status: "running", controller_lock: { pid: 7 } }).id, "pause");
  assert.equal(primaryAction({ status: "paused" }).id, "resume");
  assert.equal(primaryAction({ status: "human_required" }).confirm, true);
  assert.equal(primaryAction({ status: "complete" }).enabled, false);
  assert.equal(controllerMode({ status: "running", controller_lock: null }).id, "interrupted");
  assert.equal(controllerMode({
    status: "running",
    controller_lock: null,
    active_task: "M001",
    maintenance_requested: true,
  }).id, "interrupted");
  assert.equal(controllerMode({
    status: "paused",
    active_task: "M001",
    maintenance_requested: true,
  }).id, "maintenance_queued");
  assert.equal(primaryAction({
    status: "running",
    controller_lock: null,
    controller_error: { code: "EPERM", message: "locked" },
  }).confirm, true);
  assert.deepEqual(controllerArguments("start"), ["start", "--detach"]);
  assert.deepEqual(controllerArguments("maintenance"), ["maintenance"]);
  assert.throws(() => controllerArguments("quit"), /Unsupported controller action/);
  assert.throws(() => controllerArguments("delete"), /Unsupported controller action/);
  assert.equal(actionMenu({ status: "complete" }).find((item) => item.id === "change").enabled, true);
  assert.match(actionMenu({ status: "idle" }, { runtime_variant: "high" }).find((item) => item.id === "reasoning").label, /high/);
  assert.equal(actionMenu({ controller_lock: { pid: 7 } }, {}).find((item) => item.id === "reasoning").enabled, false);
  assert.equal(actionMenu({}, {}).at(-1).label, "Close dashboard only");
  assert.equal(actionMenu({}, { return_to_fleet: true }).at(-1).label, "Back to main dashboard");
});

test("dashboard releases terminal input and identifies a fleet return", () => {
  const calls = [];
  restoreTerminalInput({
    setRawMode(value) { calls.push(["raw", value]); },
    pause() { calls.push(["pause"]); },
  });
  assert.deepEqual(calls, [["raw", false], ["pause"]]);
  assert.equal(parseDashboardArgs([], {
    env: { OPENCODE_CONTROL_PLANE_PARENT_DASHBOARD: "1" },
  }).returnToFleet, true);
});

test("dashboard lets the guarded updater inspect a stopped blocked task", () => {
  assert.equal(upgradeNeedsMaintenanceDrain({
    status: "human_required",
    phase: "blocked",
    active_task: "M001",
    controller_lock: null,
  }), false);
  assert.equal(upgradeNeedsMaintenanceDrain({
    status: "running",
    phase: "executing",
    active_task: "M001",
    controller_lock: { pid: 7 },
  }), true);
});

test("dashboard exposes a stopped controller's precise recovery error", async (t) => {
  const root = await createScaffold(t);
  await writeJson(path.join(root, ".autopilot", "state.json"), {
    ...(await readJson(path.join(root, ".autopilot", "state.json"))),
    status: "running",
    phase: "recovering",
    active_task: "M001",
    attempt: 1,
  });
  await writeJson(path.join(root, ".autopilot", "artifacts", "controller.log"), {
    error: "EPERM: operation not permitted while replacing state.json",
    code: "EPERM",
    details: null,
  });
  const dashboard = path.join(root, ".autopilot", "bin", "control-plane.mjs");
  const result = await run([process.execPath, dashboard, "--root", root, "--snapshot", "--json"], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.status.controller_error, {
    code: "EPERM",
    message: "EPERM: operation not permitted while replacing state.json",
  });
  assert.equal(snapshot.actions[0].label, "Resume after reviewing error");
  assert.equal(snapshot.actions[0].confirm, true);
  const rendered = renderDashboard({ status: snapshot.status, metadata: snapshot.metadata, width: 100 });
  assert.match(rendered, /EPERM: operation not permitted/);
  assert.match(rendered, /synchronization or the locking program/);
});

test("runtime reasoning is token-free, project-local, and reversible", async (t) => {
  const root = await createScaffold(t);
  assert.deepEqual(await readRuntimeSettings(root), { schema_version: 1, variant: null });
  assert.equal(nextRuntimeVariant(null), "low");
  await writeRuntimeVariant(root, "high");
  assert.deepEqual(await readRuntimeSettings(root), { schema_version: 1, variant: "high" });
  await writeRuntimeVariant(root, "default");
  assert.deepEqual(await readRuntimeSettings(root), { schema_version: 1, variant: null });
  await assert.rejects(writeRuntimeVariant(root, "unsafe value"), /safe provider variant/);
});

test("dashboard strips terminal control input and renders the public identity", () => {
  const injected = "Task\n\x1b[2Jowned\x07";
  assert.equal(safeText(injected), "Task owned");
  const rendered = renderDashboard({
    status: {
      status: "human_required",
      phase: "blocked",
      active_task: "M001",
      active_task_title: injected,
      blocker: { message: injected },
      task_counts: { done: 1, blocked: 1 },
    },
    metadata: { installed_version: "1.6.8", blueprint_version: 2, runtime_variant: "high" },
    width: 88,
  });
  assert.match(rendered, /^OpenCode Control Plane/m);
  assert.match(rendered, /zero-token orchestrator that turns OpenCode into a policy-bounded/);
  assert.match(rendered, /Keeping it lean, fast, and terminal-native is its superpower/);
  assert.doesNotMatch(rendered, /\bsandboxed\b/i);
  assert.doesNotMatch(rendered, /\x1b|\x07/);
});

test("noninteractive dashboard snapshot reports version, state, and visible actions", async (t) => {
  const root = await createScaffold(t);
  const dashboard = path.join(root, ".autopilot", "bin", "control-plane.mjs");
  const result = await run([process.execPath, dashboard, "--root", root, "--snapshot", "--json"], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.status.status, "idle");
  assert.equal(snapshot.metadata.installed_version, "1.6.19");
  assert.equal(snapshot.metadata.runtime_variant, "default");
  assert.equal(snapshot.actions.length, 8);
  assert.equal(snapshot.actions[0].id, "start");
});

test("fleet-opened project snapshot exposes a return action", async (t) => {
  const root = await createScaffold(t);
  const dashboard = path.join(root, ".autopilot", "bin", "control-plane.mjs");
  const result = await run([
    process.execPath,
    dashboard,
    "--root",
    root,
    "--snapshot",
    "--json",
  ], {
    cwd: root,
    env: { ...process.env, OPENCODE_CONTROL_PLANE_PARENT_DASHBOARD: "1" },
  });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.metadata.return_to_fleet, true);
  assert.equal(snapshot.actions.at(-1).label, "Back to main dashboard");
  assert.match(renderDashboard({ status: snapshot.status, metadata: snapshot.metadata }), /Returning to the main dashboard/);
});

test("Windows dashboard launcher resolves its project root and preserves Node exit codes", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createScaffold(t);
  const launcher = path.join(root, "control-plane.cmd");
  const command = process.env.ComSpec ?? "cmd.exe";
  const snapshot = await run([command, "/d", "/c", launcher, "--snapshot", "--json"], { cwd: root });
  assert.equal(snapshot.code, 0, snapshot.stderr || snapshot.stdout);
  assert.equal(JSON.parse(snapshot.stdout).status.status, "idle");

  const invalid = await run([command, "/d", "/c", launcher, "--not-a-real-option"], { cwd: root });
  assert.notEqual(invalid.code, 0, "the batch wrapper must not mask the dashboard exit code");
  assert.match(`${invalid.stderr}\n${invalid.stdout}`, /Unknown argument/);
});

test("maintenance request is a guarded lifecycle verb and appears in status", async (t) => {
  const root = await createScaffold(t);
  const controller = path.join(root, ".autopilot", "bin", "autopilot.mjs");
  const requested = await run([process.execPath, controller, "maintenance", "--root", root], { cwd: root });
  assert.equal(requested.code, 0, requested.stderr);
  assert.equal(JSON.parse(requested.stdout).requested, "maintenance");
  const status = await run([process.execPath, controller, "status", "--root", root], { cwd: root });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).maintenance_requested, true);
});

test("controller honors maintenance before selecting a task", async (t) => {
  const root = await createScaffold(t, { ready: true });
  const controller = path.join(root, ".autopilot", "bin", "autopilot.mjs");
  assert.equal((await run([process.execPath, controller, "maintenance", "--root", root], { cwd: root })).code, 0);
  const started = await run([process.execPath, controller, "start", "--root", root], { cwd: root });
  assert.equal(started.code, 0, started.stderr);
  const state = await readJson(path.join(root, ".autopilot", "state.json"));
  assert.equal(state.status, "paused");
  assert.equal(state.phase, "maintenance");
  assert.equal(state.active_task, null);
});
