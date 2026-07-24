#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  actionMenu,
  controllerArguments,
  renderDashboard,
  safeText,
  statusFingerprint,
} from "./lib/control-plane-ui.mjs";
import { findProjectRoot } from "./lib/core.mjs";
import {
  nextRuntimeVariant,
  readRuntimeSettings,
  runtimeVariantLabel,
  writeRuntimeVariant,
} from "./lib/runtime-settings.mjs";

const POLL_MS = 1000;
const OUTPUT_CAP = 1024 * 1024;
const WAIT_FOR_BOUNDARY_MS = 24 * 60 * 60 * 1000;
const scriptFile = fileURLToPath(import.meta.url);
const options = parseArgs(process.argv.slice(2));

if (isMain()) await main().catch(fatal);

function parseArgs(argv) {
  const result = { root: null, snapshot: false, json: false, color: !process.env.NO_COLOR };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error("--root requires a path");
      result.root = selected;
    } else if (value === "--snapshot") result.snapshot = true;
    else if (value === "--json") result.json = true;
    else if (value === "--no-color") result.color = false;
    else if (value === "--help") {
      process.stdout.write("Usage: control-plane.mjs [--root PATH] [--snapshot] [--json] [--no-color]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

async function main() {
  const root = await findProjectRoot(options.root ? path.resolve(options.root) : process.cwd());
  if (options.snapshot || !process.stdin.isTTY || !process.stdout.isTTY) {
    const [status, metadata] = await Promise.all([readStatus(root), readMetadata(root)]);
    if (options.json) process.stdout.write(`${JSON.stringify({ status, metadata, actions: actionMenu(status, metadata) }, null, 2)}\n`);
    else process.stdout.write(`${renderDashboard({ status, metadata, width: process.stdout.columns ?? 88 })}\n`);
    return;
  }
  await interactive(root);
}

async function interactive(root) {
  const model = {
    status: {},
    metadata: {},
    activity: [],
    message: "Loading current project state...",
    stale: true,
    selected: 0,
    confirm: null,
    pendingAction: null,
    busy: false,
    stopped: false,
    fingerprint: null,
    pollSerial: 0,
  };
  let timer = null;
  let raw = false;

  const enterScreen = () => {
    if (raw) return;
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    raw = true;
  };
  const leaveScreen = () => {
    if (!raw) return;
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    raw = false;
  };
  const draw = () => {
    if (!raw) return;
    const screen = renderDashboard({
      ...model,
      width: process.stdout.columns ?? 88,
    });
    process.stdout.write(`\x1b[H\x1b[2J${screen}`);
  };
  const record = (text) => {
    model.activity.push(`${new Date().toLocaleTimeString()}  ${safeText(text)}`);
    if (model.activity.length > 10) model.activity.shift();
  };
  const refresh = async () => {
    if (model.stopped) return;
    const serial = ++model.pollSerial;
    try {
      const [status, metadata] = await Promise.all([readStatus(root), readMetadata(root)]);
      if (serial !== model.pollSerial) return;
      const fingerprint = statusFingerprint(status);
      if (model.fingerprint && fingerprint !== model.fingerprint) {
        record(`${status.status ?? "unknown"}: ${status.phase ?? "unknown"}${status.active_task ? ` (${status.active_task})` : ""}`);
      }
      model.fingerprint = fingerprint;
      model.status = status;
      model.metadata = metadata;
      model.stale = false;
      if (model.message === "Loading current project state...") model.message = "Ready.";
    } catch (error) {
      if (serial !== model.pollSerial) return;
      model.stale = true;
      model.message = `Status unavailable: ${safeText(error.message)}`;
    }
    draw();
  };
  const cleanup = () => {
    if (model.stopped) return;
    model.stopped = true;
    if (timer) clearInterval(timer);
    process.stdin.off("keypress", onKey);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdout.off("resize", draw);
    leaveScreen();
  };
  const quit = () => {
    cleanup();
    process.exitCode = 0;
  };
  const onSignal = () => quit();

  const perform = async (menuAction) => {
    if (model.busy || !menuAction?.enabled) return;
    if (menuAction.confirm && !model.confirm) {
      model.pendingAction = menuAction;
      model.confirm = confirmationFor(menuAction.id);
      draw();
      return;
    }
    model.confirm = null;
    model.pendingAction = null;
    model.busy = true;
    model.message = `${menuAction.label}...`;
    draw();
    try {
      if (["start", "resume"].includes(menuAction.id)) {
        if (menuAction.id === "start") {
          const preflight = await invokeController(root, "preflight");
          if (!preflight.value?.ready) throw new Error(firstPreflightProblem(preflight.value));
        }
        await invokeController(root, menuAction.id);
        model.message = menuAction.id === "start" ? "Worker started." : "Worker resumed.";
      } else if (["pause", "stop"].includes(menuAction.id)) {
        await invokeController(root, menuAction.id);
        model.message = `${menuAction.label} requested. The current safe unit will finish first.`;
      } else if (menuAction.id === "preflight") {
        const result = await invokeController(root, "preflight");
        model.message = result.value?.ready ? "Ready: every deterministic preflight check passed." : firstPreflightProblem(result.value);
      } else if (menuAction.id === "reasoning") {
        const current = await readRuntimeSettings(root);
        const updated = await writeRuntimeVariant(root, nextRuntimeVariant(current.variant));
        model.message = `Worker reasoning set to ${runtimeVariantLabel(updated.variant)}. It applies to the next fresh worker session.`;
      } else if (menuAction.id === "change") {
        await drainToMaintenance(root, model, draw, refresh);
        model.message = "Opening the targeted blueprint-change interview...";
        draw();
        leaveScreen();
        try { await launchEvolution(root); }
        finally { enterScreen(); }
        model.message = "Blueprint session closed. Review the status, then resume when ready.";
      } else if (menuAction.id === "upgrade") {
        await drainToMaintenance(root, model, draw, refresh);
        const result = await launchProjectUpgrade(root);
        model.message = result.changed
          ? `Updated to Control Plane ${result.to_version}. Restart this dashboard, then resume.`
          : `Control Plane ${result.to_version ?? model.metadata.installed_version ?? "current"} is already current.`;
      } else if (menuAction.id === "refresh") {
        model.message = "Refreshed.";
      } else if (menuAction.id === "quit") {
        quit();
        return;
      }
      record(model.message);
    } catch (error) {
      model.message = `Could not complete action: ${safeText(error.message, 700)}`;
      record(model.message);
    } finally {
      model.busy = false;
      await refresh();
      draw();
    }
  };

  const onKey = (_text, key = {}) => {
    if (key.ctrl && key.name === "c") return quit();
    if (model.confirm) {
      if (key.name === "y") {
        const action = model.pendingAction;
        model.confirm = null;
        model.pendingAction = null;
        void perform({ ...action, confirm: false });
      } else if (["n", "escape"].includes(key.name)) {
        model.confirm = null;
        model.pendingAction = null;
        model.message = "Cancelled.";
        draw();
      }
      return;
    }
    if (model.busy) return;
    const menu = actionMenu(model.status, model.metadata);
    if (key.name === "up") model.selected = (model.selected + menu.length - 1) % menu.length;
    else if (key.name === "down") model.selected = (model.selected + 1) % menu.length;
    else if (key.name === "return") void perform(menu[model.selected]);
    else if (/^[1-8]$/.test(key.sequence ?? "")) {
      model.selected = Number(key.sequence) - 1;
      void perform(menu[model.selected]);
    } else if (key.name === "q") void perform(menu.find((item) => item.menu_id === "quit"));
    else if (key.name === "r") void perform(menu.find((item) => item.menu_id === "refresh"));
    draw();
  };

  process.stdin.on("keypress", onKey);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdout.on("resize", draw);
  enterScreen();
  await refresh();
  timer = setInterval(() => { void refresh(); }, POLL_MS);
  timer.unref();
  draw();
}

async function drainToMaintenance(root, model, draw, refresh) {
  if (!model.status.maintenance_requested) await invokeController(root, "maintenance");
  model.message = "Waiting for the current task to reach a safe maintenance boundary...";
  draw();
  const deadline = Date.now() + WAIT_FOR_BOUNDARY_MS;
  let resumedPausedTask = false;
  while (Date.now() < deadline) {
    await wait(1000);
    await refresh();
    if (!model.status.controller_lock && !model.status.active_task && !model.status.completion && !model.status.finalization) return;
    if (!model.status.controller_lock && model.status.active_task && model.status.status === "paused" && !resumedPausedTask) {
      resumedPausedTask = true;
      await invokeController(root, "resume");
      model.message = "Finishing the paused task before maintenance...";
      draw();
      continue;
    }
    if (!model.status.controller_lock && model.status.active_task) {
      throw new Error("The current task needs attention before maintenance. Resolve its blocker or resume recovery; the maintenance request will remain queued.");
    }
  }
  throw new Error("Timed out waiting for a safe maintenance boundary");
}

async function readStatus(root) {
  const result = await runCaptured(process.execPath, [path.join(root, ".autopilot", "bin", "autopilot.mjs"), "status", "--root", root], { cwd: root, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(parseFailure(result));
  return parseJson(result.stdout, "controller status");
}

async function readMetadata(root) {
  const metadata = {};
  try {
    const settings = await readRuntimeSettings(root);
    metadata.runtime_variant = runtimeVariantLabel(settings.variant);
  } catch {
    metadata.runtime_variant = "invalid";
  }
  try {
    const manifest = parseJson(await readFile(path.join(root, ".autopilot", "control-plane.json"), "utf8"), "Control Plane manifest");
    metadata.installed_version = manifest.version;
  } catch {}
  try {
    const record = parseJson(await readFile(path.join(root, "blueprints", "current", "record.json"), "utf8"), "blueprint record");
    metadata.blueprint_version = record.version;
  } catch {}
  const skill = await locateInstalledSkill();
  if (skill) {
    try {
      const release = parseJson(await readFile(path.join(skill, "assets", "control-plane-release.json"), "utf8"), "installed release");
      metadata.available_version = release.version;
    } catch {}
  }
  return metadata;
}

async function invokeController(root, action) {
  const result = await runCaptured(
    process.execPath,
    [path.join(root, ".autopilot", "bin", "autopilot.mjs"), ...controllerArguments(action), "--root", root],
    { cwd: root, timeoutMs: action === "preflight" ? 5 * 60_000 : 60_000 },
  );
  let value = null;
  try { value = parseJson(result.stdout, `${action} result`); } catch {}
  if (result.code !== 0 && !(action === "preflight" && value)) throw new Error(parseFailure(result));
  return { ...result, value };
}

async function launchEvolution(root) {
  const config = parseJson(await readFile(path.join(root, ".autopilot", "config.json"), "utf8"), "controller config");
  const command = config.opencode?.command;
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string" || !item)) {
    throw new Error("The configured OpenCode command is invalid");
  }
  const result = await runInherited(command[0], [...command.slice(1), root, "--prompt", "/evolve-project"], { cwd: root });
  if (result.code !== 0) throw new Error(`OpenCode blueprint session exited with code ${result.code ?? "unknown"}`);
}

async function launchProjectUpgrade(root) {
  const skill = await locateInstalledSkill();
  if (!skill) throw new Error("No global OpenCode Control Plane installation was found. Update the framework installation first.");
  const updater = path.join(skill, "bin", "upgrade-project.mjs");
  await access(updater);
  const result = await runCaptured(process.execPath, [updater, "--target", root, "--json"], { cwd: root, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(parseFailure(result));
  return parseJson(result.stdout, "project upgrade result");
}

async function locateInstalledSkill() {
  const candidates = [
    process.env.OPENCODE_CONTROL_PLANE_SKILL,
    path.join(os.homedir(), ".agents", "skills", "init-project"),
  ].filter(Boolean).map((item) => path.resolve(item));
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "assets", "control-plane-release.json"));
      await access(path.join(candidate, "bin", "upgrade-project.mjs"));
      return candidate;
    } catch {}
  }
  return null;
}

function confirmationFor(action) {
  if (action === "stop") return "Stop after the current safe unit finishes? No process will be killed.";
  if (action === "change") return "Drain at a task boundary and open a targeted blueprint-change interview? Existing code will not be rebuilt.";
  if (action === "upgrade") return "Drain at a task boundary, back up managed framework files, validate the update, and create a local rollback commit?";
  if (action === "resume") return "Resume only if you completed the required human action. Continue?";
  return "Continue?";
}

function firstPreflightProblem(value) {
  if (!value) return "Readiness check returned no report.";
  const issue = value.validation?.issues?.[0] ?? value.structure?.error ?? value.git?.error ?? value.opencode?.error ?? value.phases?.find((item) => !item.ok)?.error ?? value.gates?.find((item) => !item.ok)?.error;
  return issue?.message ? `Not ready: ${safeText(issue.message, 600)}` : "Not ready. Review the preflight report in the project terminal.";
}

function parseFailure(result) {
  for (const value of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.error) return safeText(parsed.error, 700);
    } catch {}
  }
  return safeText(result.stderr || result.stdout || `Process exited with code ${result.code ?? "unknown"}`, 700);
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

function runCaptured(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Operation timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_CAP) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error(`Operation output exceeded ${OUTPUT_CAP} bytes`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function runInherited(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

function fatal(error) {
  process.stderr.write(`OpenCode Control Plane: ${safeText(error?.message ?? error, 1000)}\n`);
  process.exitCode = 1;
}

export { parseArgs, readMetadata, readStatus };
