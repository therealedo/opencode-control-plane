#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalProjectRoot,
  readProjectRegistry,
  selectedHome,
} from "./lib/project-registry.mjs";

const OUTPUT_CAP = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_WAIT_MS = 24 * 60 * 60_000;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const updater = path.join(skillRoot, "bin", "upgrade-project.mjs");
const args = parseArgs(process.argv.slice(2));

if (isMain()) await main().catch(fatal);

async function main() {
  const home = path.resolve(args.home ?? selectedHome());
  const registry = await readProjectRegistry({ home });
  const results = [];
  for (const project of registry.projects) {
    try { results.push(await upgradeRegisteredProject(project, { dryRun: args.dryRun, waitMs: args.waitMs })); }
    catch (error) {
      results.push({ id: project.id, name: project.name, root: project.root, status: "failed", error: bounded(error.message), code: error.code ?? "PROJECT_UPDATE_FAILED" });
    }
  }
  const pending = results.filter((item) => !["current", "upgraded", "preview"].includes(item.status));
  output({
    ok: true,
    complete: pending.length === 0,
    dry_run: args.dryRun,
    total: results.length,
    updated: results.filter((item) => item.status === "upgraded").length,
    current: results.filter((item) => item.status === "current").length,
    pending: pending.length,
    results,
    note: pending.length ? "Fix the named projects and run Update everything again; completed updates are already safe and current." : "Every registered project is current.",
  });
}

export async function upgradeRegisteredProject(project, { dryRun = false, waitMs = DEFAULT_WAIT_MS } = {}) {
  const root = await canonicalProjectRoot(project.root);
  const manifest = await readJson(path.join(root, ".autopilot", "control-plane.json"), 512 * 1024, { optional: true });
  if (!manifest) {
    return result(project, "legacy", { error: "This project needs a separately confirmed one-time adoption; Update everything never adopts silently." });
  }
  const before = await controllerBoundary(root);
  if (dryRun) {
    if (before.live || before.state.active_task || before.state.completion || before.state.finalization) {
      return result(project, "deferred", { error: "A live or unfinished controller transaction must reach maintenance before preview." });
    }
    const preview = await invokeUpdater(root, { dryRun: true });
    return result(project, preview.changed ? "preview" : "current", { from_version: preview.from_version, to_version: preview.to_version, changed_files: preview.changed_files });
  }

  const wasRunning = before.live;
  if (!wasRunning && (before.state.active_task || before.state.completion || before.state.finalization)) {
    return result(project, "deferred", { error: "An interrupted or paused task must be resolved in the project view before framework files can change." });
  }
  if (wasRunning) {
    await invokeController(root, "maintenance");
    const boundary = await waitForMaintenance(root, waitMs);
    if (!boundary.ready) {
      return result(project, "deferred", { error: boundary.error, was_running: true, resumed: false });
    }
  }

  let upgrade;
  let updateError = null;
  try { upgrade = await invokeUpdater(root); }
  catch (error) { updateError = error; }
  let resumed = false;
  let resumeError = null;
  if (wasRunning) {
    try {
      await invokeController(root, "resume", ["--detach"]);
      resumed = true;
    } catch (error) {
      resumeError = error;
    }
  }
  if (updateError) {
    return result(project, "failed", {
      error: bounded(updateError.message),
      code: updateError.code ?? "PROJECT_UPDATE_FAILED",
      was_running: wasRunning,
      resumed,
      resume_error: resumeError ? bounded(resumeError.message) : null,
    });
  }
  if (resumeError) {
    return result(project, "failed", {
      error: `The framework update succeeded, but the previously running worker could not resume: ${bounded(resumeError.message)}`,
      code: "RESUME_FAILED",
      from_version: upgrade.from_version,
      to_version: upgrade.to_version,
      commit: upgrade.commit ?? null,
      was_running: true,
      resumed: false,
    });
  }
  return result(project, upgrade.changed ? "upgraded" : "current", {
    from_version: upgrade.from_version,
    to_version: upgrade.to_version,
    commit: upgrade.commit ?? null,
    rollback: upgrade.rollback ?? null,
    was_running: wasRunning,
    resumed,
  });
}

async function waitForMaintenance(root, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await wait(1000);
    const boundary = await controllerBoundary(root);
    if (!boundary.live && !boundary.state.active_task && !boundary.state.completion && !boundary.state.finalization) {
      return { ready: true };
    }
    if (!boundary.live && boundary.state.active_task) {
      return { ready: false, error: "The worker stopped with an active task. Open this project, resolve its blocker, and resume it to the maintenance boundary." };
    }
  }
  return { ready: false, error: "Timed out waiting for a safe maintenance boundary; the maintenance request remains queued." };
}

async function controllerBoundary(root) {
  const state = await readJson(path.join(root, ".autopilot", "state.json"), 128 * 1024);
  const lock = await readJson(path.join(root, ".git", "autopilot-controller.lock"), 16 * 1024, { optional: true });
  let live = false;
  if (Number.isInteger(lock?.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); live = true; }
    catch (error) { live = error?.code === "EPERM"; }
  }
  return { state, lock, live };
}

async function invokeUpdater(root, { dryRun = false } = {}) {
  const command = [updater, "--target", root, "--json"];
  if (dryRun) command.push("--dry-run");
  const execution = await run(process.execPath, command, root, PROCESS_TIMEOUT_MS);
  if (execution.code !== 0) throw commandError(execution, "Project updater failed");
  return parseJson(execution.stdout, "project updater");
}

async function invokeController(root, verb, extra = []) {
  const controller = path.join(root, ".autopilot", "bin", "autopilot.mjs");
  const info = await lstat(controller);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 4 * 1024 * 1024) {
    throw new Error("Project controller executable is unsafe");
  }
  const execution = await run(process.execPath, [controller, verb, ...extra, "--root", root], root, PROCESS_TIMEOUT_MS);
  if (execution.code !== 0) throw commandError(execution, `Controller ${verb} failed`);
  return parseJson(execution.stdout, `controller ${verb}`);
}

function run(command, commandArgs, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Operation timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_CAP) {
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

async function readJson(file, maxBytes, { optional = false } = {}) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > maxBytes) throw new Error(`Unsafe or oversized file: ${file}`);
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`); }
}

function result(project, status, details = {}) {
  return { id: project.id, name: project.name, root: project.root, status, ...details };
}

function commandError(execution, label) {
  for (const text of [execution.stderr, execution.stdout]) {
    try {
      const parsed = JSON.parse(text);
      const error = new Error(`${label}: ${bounded(parsed?.error ?? text)}`);
      error.code = parsed?.code ?? "COMMAND_FAILED";
      return error;
    } catch {}
  }
  return new Error(`${label}: ${bounded(execution.stderr || execution.stdout || `exit ${execution.code ?? "unknown"}`)}`);
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

function parseArgs(argv) {
  const result = { home: null, dryRun: false, json: false, waitMs: DEFAULT_WAIT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--home", "--wait-ms"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--home") result.home = selected;
      else {
        result.waitMs = Number(selected);
        if (!Number.isInteger(result.waitMs) || result.waitMs < 1_000 || result.waitMs > DEFAULT_WAIT_MS) throw new Error("--wait-ms must be between 1000 and 86400000");
      }
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") {
      process.stdout.write("Usage: upgrade-all-projects.mjs [--home PATH] [--wait-ms N] [--dry-run] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function bounded(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, args.json ? 0 : 2)}\n`);
}

function fatal(error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: bounded(error.message), code: error.code ?? "UPGRADE_ALL_FAILED" }, null, args.json ? 0 : 2)}\n`);
  process.exitCode = 1;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
