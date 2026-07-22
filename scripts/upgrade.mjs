#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const result = {
  ok: false,
  name: "OpenCode Control Plane",
  source_updated: false,
  validation: null,
  global_install: null,
  project_upgrade: null,
  project_upgrades: null,
};

await main().catch((error) => {
  result.error = error.message;
  result.code = error.code ?? "UPGRADE_FAILED";
  process.stderr.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  if (!args.local && !args.dryRun) {
    await updateSource();
    result.source_updated = true;
  }

  const validation = await runNode(path.join(root, "scripts", "validate-source.mjs"), [], root);
  if (validation.code !== 0) throw commandError("Source validation failed", validation);
  result.validation = parseJson(validation.stdout, "source validation");

  const installArguments = ["--upgrade", "--json"];
  if (args.home) installArguments.push("--home", path.resolve(args.home));
  if (args.configHome) installArguments.push("--config-home", path.resolve(args.configHome));
  if (args.recordSourceRoot) installArguments.push("--source-root", path.resolve(args.recordSourceRoot));
  if (args.full) installArguments.push("--full");
  if (args.dryRun) installArguments.push("--dry-run");
  const installed = await runNode(path.join(root, "scripts", "install.mjs"), installArguments, root);
  if (installed.code !== 0) throw commandError("Global Control Plane upgrade failed", installed);
  result.global_install = parseJson(installed.stdout, "global upgrade");

  if (args.project) {
    const projectArguments = ["--target", path.resolve(args.project), "--json"];
    if (args.adopt) projectArguments.push("--adopt");
    if (args.dryRun) projectArguments.push("--dry-run");
    const project = await runNode(
      path.join(root, ".agents", "skills", "init-project", "bin", "upgrade-project.mjs"),
      projectArguments,
      path.resolve(args.project),
    );
    if (project.code !== 0) {
      result.project_upgrade = safeJson(project.stderr) ?? { ok: false, error: bounded(project.stderr || project.stdout) };
      const error = commandError("The global upgrade succeeded, but this project is not yet at a safe upgrade boundary", project);
      error.code = "PROJECT_UPGRADE_PENDING";
      throw error;
    }
    result.project_upgrade = parseJson(project.stdout, "project upgrade");
  }

  if (args.allProjects) {
    const batchArguments = ["--home", result.global_install.home, "--json"];
    if (args.dryRun) batchArguments.push("--dry-run");
    const batch = await runNode(
      path.join(result.global_install.home, ".agents", "skills", "init-project", "bin", "upgrade-all-projects.mjs"),
      batchArguments,
      result.global_install.home,
    );
    if (batch.code !== 0) {
      result.project_upgrades = safeJson(batch.stderr) ?? { ok: false, error: bounded(batch.stderr || batch.stdout) };
      const error = commandError("The global upgrade succeeded, but registered-project orchestration failed", batch);
      error.code = "PROJECT_UPGRADES_PENDING";
      throw error;
    }
    result.project_upgrades = parseJson(batch.stdout, "registered project upgrades");
  }

  result.ok = true;
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`);
}

async function updateSource() {
  const gitDirectory = path.join(root, ".git");
  const info = await lstat(gitDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Automatic updates require a normal Git clone. Re-clone the public repository or use --local for an intentional local refactor.");
  }
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.code !== 0) throw commandError("Could not inspect the source repository", status);
  if (status.stdout.trim()) throw new Error("The Control Plane source has local changes. Commit them, or use --local only when intentionally installing a local refactor.");
  const remoteResult = await run("git", ["remote", "get-url", "origin"], root);
  if (remoteResult.code !== 0) throw commandError("Could not identify the source repository", remoteResult);
  const remote = remoteResult.stdout.trim().replace(/\/+$/, "");
  const allowed = new Set([
    "https://github.com/therealedo/opencode-control-plane.git",
    "https://github.com/therealedo/opencode-control-plane",
    "git@github.com:therealedo/opencode-control-plane.git",
    "ssh://git@github.com/therealedo/opencode-control-plane.git",
  ]);
  if (!allowed.has(remote)) throw new Error(`Refusing automatic code execution from unexpected origin: ${bounded(remote)}`);
  const pulled = await run("git", ["pull", "--ff-only", "--no-rebase", "origin"], root, 5 * 60_000);
  if (pulled.code !== 0) throw commandError("Could not fast-forward to the latest public release", pulled);
}

function runNode(script, arguments_, cwd) {
  return run(process.execPath, [script, ...arguments_], cwd, 15 * 60_000);
}

function run(command, arguments_, cwd, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Upgrade step timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error("Upgrade step exceeded its 2 MiB output cap"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function parseArgs(argv) {
  const value = { local: false, dryRun: false, json: false, full: false, adopt: false, allProjects: false, project: null, home: null, configHome: null, recordSourceRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (["--project", "--home", "--config-home", "--record-source-root"].includes(item)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw new Error(`${item} requires a path`);
      if (item === "--project") value.project = selected;
      else if (item === "--home") value.home = selected;
      else if (item === "--config-home") value.configHome = selected;
      else value.recordSourceRoot = selected;
    } else if (item === "--local") value.local = true;
    else if (item === "--dry-run") value.dryRun = true;
    else if (item === "--json") value.json = true;
    else if (item === "--full") value.full = true;
    else if (item === "--adopt") value.adopt = true;
    else if (item === "--all-projects") value.allProjects = true;
    else if (item === "--help") {
      process.stdout.write("Usage: upgrade.mjs [--local] [--project PATH | --all-projects] [--adopt] [--home PATH] [--config-home PATH] [--record-source-root PATH] [--full] [--dry-run] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${item}`);
  }
  if (value.adopt && !value.project) throw new Error("--adopt requires --project")
  if (value.project && value.allProjects) throw new Error("--project and --all-projects are mutually exclusive")
  return value;
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

function safeJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

function commandError(label, command) {
  const parsed = safeJson(command.stderr) ?? safeJson(command.stdout);
  const error = new Error(`${label}: ${bounded(parsed?.error ?? command.stderr ?? command.stdout ?? `exit ${command.code}`)}`);
  error.code = parsed?.code ?? "UPGRADE_STEP_FAILED";
  return error;
}

function bounded(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 4096);
}
