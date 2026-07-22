#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  externalExecutionEnv,
  resolveExternalGitExecutable,
  safeBaseEnv,
} from "../assets/project/.autopilot/bin/lib/process.mjs";
import { safeText } from "../assets/project/.autopilot/bin/lib/control-plane-ui.mjs";
import {
  canonicalProjectRoot,
  forgetProject,
  readProjectRegistry,
  registerProject,
  selectedHome,
} from "./lib/project-registry.mjs";
import {
  checkForUpdate,
  compareVersions,
  RELEASE_REPOSITORY,
} from "./lib/release-channel.mjs";
import { projectSummary, renderFleet } from "./lib/global-control-plane-ui.mjs";

const POLL_MS = 2_000;
const UPDATE_POLL_MS = 6 * 60 * 60_000;
const OUTPUT_CAP = 2 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const scriptFile = fileURLToPath(import.meta.url);
const skillRoot = path.resolve(path.dirname(scriptFile), "..");
const options = parseArgs(process.argv.slice(2));

if (isMain()) await main().catch(fatal);

async function main() {
  const home = path.resolve(options.home ?? selectedHome());
  if (options.add) return print(await registerProject(options.add, { home }));
  if (options.forget) return print(await forgetProject(options.forget, { home }));
  const installation = await readInstallation(home);
  if (options.checkUpdates) {
    return print(await checkForUpdate({ installedVersion: installation.version, home, force: options.forceCheck }));
  }
  if (options.upgradeAll) {
    if (!options.yes) throw new Error("--upgrade-all requires --yes because workers may drain to maintenance boundaries");
    return print(await updateEverything({ home, installation, remote: await checkForUpdate({ installedVersion: installation.version, home, force: true }) }));
  }
  if (options.snapshot || !process.stdin.isTTY || !process.stdout.isTTY) {
    const projects = await inspectFleet(home, installation.version);
    if (options.json) return print({ installation, projects });
    process.stdout.write(`${renderFleet({ projects, installedVersion: installation.version, update: null, width: process.stdout.columns ?? 100 })}\n`);
    return;
  }
  await interactive(home, installation);
}

async function interactive(home, initialInstallation) {
  const model = {
    installation: initialInstallation,
    projects: [],
    update: null,
    selected: 0,
    message: "Loading registered projects...",
    busy: false,
    confirm: null,
    stopped: false,
  };
  let timer = null;
  let updateTimer = null;
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
    const screen = renderFleet({
      projects: model.projects,
      installedVersion: model.installation.version,
      update: model.update,
      selected: model.selected,
      message: model.confirm?.text ?? model.message,
      busy: model.busy,
      width: process.stdout.columns ?? 100,
      height: process.stdout.rows ?? 30,
    });
    process.stdout.write(`\x1b[H\x1b[2J${screen}${model.confirm ? "\nPress Y to continue or N to cancel." : ""}`);
  };
  const refresh = async () => {
    model.installation = await readInstallation(home);
    model.projects = await inspectFleet(home, model.installation.version);
    if (model.selected >= model.projects.length) model.selected = Math.max(0, model.projects.length - 1);
    if (model.message === "Loading registered projects...") model.message = "Ready.";
    draw();
  };
  const refreshUpdate = async (force = false) => {
    model.update = await checkForUpdate({ installedVersion: model.installation.version, home, force });
    if (model.update.update_available) model.message = `Control Plane v${model.update.latest_version} is available. Press U to update everything safely.`;
    else if (model.update.error) model.message = `Update check unavailable: ${safeText(model.update.error, 500)}. Project control remains available.`;
    else model.message = `Control Plane v${model.installation.version} is current.`;
    draw();
  };
  const cleanup = () => {
    if (model.stopped) return;
    model.stopped = true;
    if (timer) clearInterval(timer);
    if (updateTimer) clearInterval(updateTimer);
    process.stdin.off("keypress", onKey);
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    process.stdout.off("resize", draw);
    leaveScreen();
  };
  const quit = () => { cleanup(); process.exitCode = 0; };
  const selectedProject = () => model.projects[model.selected] ?? null;

  const addProject = async () => {
    leaveScreen();
    const answer = await ask("Project folder: ");
    enterScreen();
    if (!answer.trim()) { model.message = "Add cancelled."; return draw(); }
    try {
      const result = await registerProject(answer.trim(), { home });
      model.message = result.added ? `Added ${result.project.name}.` : `${result.project.name} was already registered.`;
      await refresh();
    } catch (error) {
      model.message = `Could not add project: ${safeText(error.message, 700)}`;
      draw();
    }
  };
  const openProject = async () => {
    const project = selectedProject();
    if (!project?.available) {
      model.message = project ? `Cannot open: ${safeText(project.error, 700)}` : "No project is selected.";
      return draw();
    }
    model.busy = true;
    model.message = `Opening ${project.name}...`;
    draw();
    try {
      const root = await canonicalProjectRoot(project.root);
      const dashboard = path.join(root, ".autopilot", "bin", "control-plane.mjs");
      await assertPrivateFile(dashboard, 4 * 1024 * 1024);
      leaveScreen();
      try {
        const result = await runInherited(process.execPath, [dashboard, "--root", root], { cwd: root });
        if (result.code !== 0) throw new Error(`Project dashboard exited with code ${result.code ?? "unknown"}`);
      } finally {
        enterScreen();
      }
      model.message = `Returned from ${project.name}.`;
    } catch (error) {
      model.message = `Could not open project: ${safeText(error.message, 700)}`;
    } finally {
      model.busy = false;
      await refresh();
    }
  };
  const performUpdate = async () => {
    model.confirm = null;
    model.busy = true;
    model.message = "Updating the global Control Plane and registered projects...";
    draw();
    try {
      const result = await updateEverything({ home, installation: model.installation, remote: model.update });
      const results = result.projects?.results ?? result.project_upgrades?.results ?? [];
      const failed = results.filter((item) => ["failed", "deferred", "legacy", "unavailable"].includes(item.status)).length;
      model.message = failed
        ? `Update finished with ${failed} project(s) needing attention. Open them from this list, then press U again.`
        : `Update complete. Global Control Plane and ${results.length} registered project(s) are current.`;
      model.update = null;
      await refresh();
      await refreshUpdate(true);
    } catch (error) {
      model.message = `Update stopped safely: ${safeText(error.message, 900)}`;
    } finally {
      model.busy = false;
      draw();
    }
  };

  const onKey = (_text, key = {}) => {
    if (key.ctrl && key.name === "c") return quit();
    if (model.confirm) {
      if (key.name === "y") {
        const action = model.confirm.action;
        model.confirm = null;
        if (action === "forget") {
          const project = selectedProject();
          if (project) void forgetProject(project.id, { home }).then(refresh).catch((error) => { model.message = safeText(error.message); draw(); });
        } else if (action === "update") void performUpdate();
      } else if (["n", "escape"].includes(key.name)) {
        model.confirm = null;
        model.message = "Cancelled.";
        draw();
      }
      return;
    }
    if (model.busy) return;
    if (key.name === "up" && model.projects.length) model.selected = (model.selected + model.projects.length - 1) % model.projects.length;
    else if (key.name === "down" && model.projects.length) model.selected = (model.selected + 1) % model.projects.length;
    else if (key.name === "return") void openProject();
    else if (key.name === "a") void addProject();
    else if (key.name === "f" && selectedProject()) model.confirm = { action: "forget", text: `Forget ${selectedProject().name}? The project itself will not be deleted.` };
    else if (key.name === "u") model.confirm = { action: "update", text: "Update the global Control Plane, drain running projects safely, update them, and resume only workers that were running?" };
    else if (key.name === "c") { model.message = "Checking GitHub releases..."; draw(); void refreshUpdate(true); }
    else if (key.name === "r") void refresh();
    else if (key.name === "q") quit();
    draw();
  };

  process.stdin.on("keypress", onKey);
  process.once("SIGINT", quit);
  process.once("SIGTERM", quit);
  process.stdout.on("resize", draw);
  enterScreen();
  await refresh();
  void refreshUpdate(false);
  timer = setInterval(() => { void refresh(); }, POLL_MS);
  timer.unref();
  updateTimer = setInterval(() => { void refreshUpdate(false); }, UPDATE_POLL_MS);
  updateTimer.unref();
  draw();
}

export async function inspectFleet(home = selectedHome(), globalVersion = null) {
  const registry = await readProjectRegistry({ home });
  return Promise.all(registry.projects.map(async (entry) => {
    try {
      const data = await inspectProject(entry.root);
      return projectSummary(entry, {
        ...data,
        update_needed: Boolean(globalVersion && data.control_plane_version && compareVersions(globalVersion, data.control_plane_version) > 0),
      });
    } catch (error) {
      return projectSummary(entry, { available: false, error: safeText(error.message, 700), status: {} });
    }
  }));
}

export async function inspectProject(rootValue) {
  const root = await canonicalProjectRoot(rootValue);
  const [state, queue, manifest, record, pause, stop, maintenance, lock] = await Promise.all([
    readBoundedJson(path.join(root, ".autopilot", "state.json"), 128 * 1024),
    readBoundedJson(path.join(root, ".project", "plan", "queue.json"), 2 * 1024 * 1024),
    readBoundedJson(path.join(root, ".autopilot", "control-plane.json"), 512 * 1024, { optional: true }),
    readBoundedJson(path.join(root, "blueprints", "current", "record.json"), 128 * 1024, { optional: true }),
    existsPrivate(path.join(root, ".autopilot", "PAUSED")),
    existsPrivate(path.join(root, ".autopilot", "STOP")),
    existsPrivate(path.join(root, ".autopilot", "MAINTENANCE")),
    liveControllerLock(path.join(root, ".git", "autopilot-controller.lock")),
  ]);
  if (!queue?.tasks || typeof queue.tasks !== "object" || Array.isArray(queue.tasks)) throw new Error("Project queue is invalid");
  const counts = {};
  for (const task of Object.values(queue.tasks)) counts[task?.status ?? "unknown"] = (counts[task?.status ?? "unknown"] ?? 0) + 1;
  const activeTask = state.active_task ? queue.tasks[state.active_task] : null;
  const status = {
    ...state,
    controller_lock: lock,
    pause_requested: pause,
    stop_requested: stop,
    maintenance_requested: maintenance,
    project_status: queue.project_status ?? null,
    task_counts: counts,
    total_tasks: Object.keys(queue.tasks).length,
    active_task_title: activeTask?.title ?? null,
    active_task_attempt_limit: activeTask?.attempt_limit ?? null,
  };
  return {
    root,
    available: true,
    status,
    control_plane_version: manifest?.version ?? null,
    blueprint_version: record?.version ?? null,
  };
}

export async function updateEverything({ home = selectedHome(), installation = null, remote = null } = {}) {
  const current = installation ?? await readInstallation(home);
  const source = await localSource(current.source_root);
  if (source && compareVersions(source.version, current.version) > 0) {
    return runSourceUpgrade(source.root, home, current.config_home, { local: true, recordSourceRoot: source.root });
  }
  const checked = remote ?? await checkForUpdate({ installedVersion: current.version, home, force: true });
  if (checked.update_available) return runTaggedUpgrade(checked, home, current.config_home, source?.root ?? null);
  const batch = path.join(skillRoot, "bin", "upgrade-all-projects.mjs");
  await assertPrivateFile(batch, 2 * 1024 * 1024);
  const result = await runCaptured(process.execPath, [batch, "--home", home, "--json"], { cwd: home, timeoutMs: UPDATE_TIMEOUT_MS });
  if (result.code !== 0) throw processError(result);
  return { ok: true, global_install: { changed: false, version: current.version }, projects: parseJson(result.stdout, "project updates") };
}

async function runTaggedUpgrade(update, home, configHome, recordSourceRoot = null) {
  if (!/^v\d+\.\d+\.\d+$/.test(update.tag ?? "") || update.latest_version !== update.tag.slice(1)) {
    throw new Error("The available release tag is invalid");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencode-control-plane-release-"));
  try {
    const checkout = path.join(temporary, "source");
    const environment = await externalExecutionEnv(temporary);
    const git = await resolveExternalGitExecutable(temporary, environment, { label: "Control Plane release Git executable" });
    const cloned = await runCaptured(git, [
      "clone", "--depth", "1", "--branch", update.tag, "--single-branch", RELEASE_REPOSITORY, checkout,
    ], { cwd: temporary, timeoutMs: 10 * 60_000, env: gitEnvironment(environment) });
    if (cloned.code !== 0) throw processError(cloned, "Could not download the signed release tag");
    const tag = await runCaptured(git, ["describe", "--tags", "--exact-match"], { cwd: checkout, timeoutMs: 60_000, env: gitEnvironment(environment) });
    if (tag.code !== 0 || tag.stdout.trim() !== update.tag) throw new Error("Downloaded source is not the requested exact release tag");
    const source = await localSource(checkout);
    if (!source || source.version !== update.latest_version) throw new Error("Release tag and Control Plane version do not match");
    return runSourceUpgrade(checkout, home, configHome, { local: true, recordSourceRoot });
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runSourceUpgrade(sourceRoot, home, configHome, { local, recordSourceRoot = null }) {
  const script = path.join(sourceRoot, "scripts", "upgrade.mjs");
  await assertPrivateFile(script, 2 * 1024 * 1024);
  const args = [script, "--all-projects", "--home", home, "--json"];
  if (configHome) args.push("--config-home", configHome);
  if (recordSourceRoot) args.push("--record-source-root", recordSourceRoot);
  if (local) args.push("--local");
  const result = await runCaptured(process.execPath, args, { cwd: sourceRoot, timeoutMs: UPDATE_TIMEOUT_MS });
  if (result.code !== 0) throw processError(result);
  return parseJson(result.stdout, "system update");
}

async function localSource(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return null;
  try {
    const actual = path.resolve(await realpath(root));
    if (pathKey(actual) !== pathKey(root)) return null;
    const release = await readBoundedJson(path.join(actual, ".agents", "skills", "init-project", "assets", "control-plane-release.json"), 128 * 1024);
    const package_ = await readBoundedJson(path.join(actual, "package.json"), 128 * 1024);
    if (release.product_id !== "opencode-control-plane" || release.version !== package_.version) return null;
    compareVersions(release.version, release.version);
    return { root: actual, version: release.version };
  } catch {
    return null;
  }
}

async function readInstallation(home) {
  const manifest = await readBoundedJson(path.join(home, ".agents", ".autopilot-install-manifest.json"), 1024 * 1024, { optional: true });
  const release = await readBoundedJson(path.join(skillRoot, "assets", "control-plane-release.json"), 128 * 1024);
  const version = manifest?.product_id === "opencode-control-plane" && typeof manifest.version === "string" ? manifest.version : release.version;
  compareVersions(version, version);
  return {
    version,
    source_root: manifest?.source_root ?? null,
    config_home: manifest?.config_home ?? path.join(home, ".config"),
    manifest: manifest ? path.join(home, ".agents", ".autopilot-install-manifest.json") : null,
  };
}

async function readBoundedJson(file, maxBytes, { optional = false } = {}) {
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

async function existsPrivate(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) throw new Error(`Unsafe project marker: ${file}`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function liveControllerLock(file) {
  const value = await readBoundedJson(file, 16 * 1024, { optional: true });
  if (!value) return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  try { process.kill(value.pid, 0); return value; }
  catch (error) { return error?.code === "EPERM" ? { pid: "unknown" } : null; }
}

async function assertPrivateFile(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > maxBytes) throw new Error(`Unsafe Control Plane executable: ${file}`);
  await access(file);
}

function runCaptured(command, args, { cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

function runInherited(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function gitEnvironment(source) {
  return {
    ...safeBaseEnv(source),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_PAGER: "cat",
  };
}

function processError(result, prefix = "Update failed") {
  for (const value of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(value);
      const error = new Error(`${prefix}: ${safeText(parsed?.error ?? value, 1400)}`);
      error.code = parsed?.code ?? "UPDATE_FAILED";
      return error;
    } catch {}
  }
  return new Error(`${prefix}: ${safeText(result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`, 1400)}`);
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

function parseArgs(argv) {
  const result = {
    home: null,
    snapshot: false,
    json: false,
    add: null,
    forget: null,
    checkUpdates: false,
    forceCheck: false,
    upgradeAll: false,
    yes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--home", "--add", "--forget"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--home") result.home = selected;
      else if (value === "--add") result.add = selected;
      else result.forget = selected;
    } else if (value === "--snapshot") result.snapshot = true;
    else if (value === "--json") result.json = true;
    else if (value === "--check-updates") result.checkUpdates = true;
    else if (value === "--force-check") { result.checkUpdates = true; result.forceCheck = true; }
    else if (value === "--upgrade-all") result.upgradeAll = true;
    else if (value === "--yes") result.yes = true;
    else if (value === "--help") {
      process.stdout.write("Usage: control-plane [--snapshot] [--json] [--add PATH | --forget ID | --check-updates | --upgrade-all --yes] [--home PATH]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function ask(prompt) {
  const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => interface_.question(prompt, (answer) => { interface_.close(); resolve(answer); }));
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

function fatal(error) {
  const value = { ok: false, error: safeText(error?.message ?? error, 1800), code: error?.code ?? "CONTROL_PLANE_FAILED" };
  process.stderr.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
  process.exitCode = 1;
}

export { parseArgs, readInstallation };
