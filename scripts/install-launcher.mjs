#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_ID = "opencode-control-plane";

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code ?? "LAUNCHER_INSTALL_FAILED",
  }, null, process.argv.includes("--json") ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const home = path.resolve(args.home ?? os.homedir());
  const managerHome = path.resolve(args.managerHome ?? path.join(sourceRoot, ".control-plane-home"));
  const binHome = path.resolve(args.binHome ?? defaultBinHome(home));
  const destination = path.join(binHome, process.platform === "win32" ? "control-plane.cmd" : "control-plane");
  const manifestFile = path.join(managerHome, "launcher-install.json");

  await assertRealDirectory(sourceRoot, "Control Plane source checkout");
  assertInside(home, binHome, "launcher directory");
  const dashboard = path.join(sourceRoot, ".agents", "skills", "init-project", "bin", "control-plane-global.mjs");
  await assertRegularFile(dashboard, "fleet dashboard");
  const release = await readJson(path.join(sourceRoot, ".agents", "skills", "init-project", "assets", "control-plane-release.json"));
  if (release.product_id !== PRODUCT_ID) throw failure("The source checkout is not OpenCode Control Plane", "SOURCE_INVALID");

  const content = launcherContent({ node: process.execPath, dashboard, managerHome, sourceRoot });
  const sha256 = hash(content);
  const prior = await readManifest(manifestFile, { optional: true });
  const current = await readCurrent(destination);
  const owned = prior && pathKey(prior.destination) === pathKey(destination) && prior.sha256 === current?.sha256;
  if (current && current.sha256 !== sha256 && !owned && !args.force) {
    throw failure(`Refusing to replace an unowned command: ${destination}. Re-run with --force only if you intend to replace it.`, "LAUNCHER_CONFLICT");
  }

  const result = {
    ok: true,
    dry_run: args.dryRun,
    remove: args.remove,
    changed: args.remove ? Boolean(current) : current?.sha256 !== sha256,
    launcher: destination,
    source_root: sourceRoot,
    manager_home: managerHome,
    version: release.version,
    path_ready: pathEntries(process.env.PATH ?? process.env.Path ?? "").some((entry) => pathKey(entry) === pathKey(binHome)),
    global_opencode_files_installed: false,
    note: "Only the terminal launcher is global; OpenCode skills, commands, agents, plugins, and project instructions remain project-local.",
  };

  if (args.dryRun) return output(result, args.json);
  if (args.remove) {
    if (!current) {
      await rm(manifestFile, { force: true });
      return output({ ...result, changed: false }, args.json);
    }
    if (!owned && !args.force) throw failure("The launcher is not owned by this checkout and was not removed", "LAUNCHER_DRIFT");
    await transactionalRemove(destination);
    await rm(manifestFile, { force: true });
    return output(result, args.json);
  }

  await mkdir(binHome, { recursive: true });
  await mkdir(managerHome, { recursive: true });
  if (current?.sha256 !== sha256) await transactionalWrite(destination, content, process.platform === "win32" ? 0o600 : 0o755);
  const manifest = {
    schema_version: 1,
    product_id: PRODUCT_ID,
    version: release.version,
    source_root: sourceRoot,
    manager_home: managerHome,
    destination,
    sha256,
    updated_at: new Date().toISOString(),
  };
  await transactionalWrite(manifestFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), 0o600);
  output(result, args.json);
}

function defaultBinHome(home) {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && path.isAbsolute(appData) && (pathKey(appData) === pathKey(home) || inside(home, appData))) return path.join(appData, "npm");
    return path.join(home, ".local", "bin");
  }
  return path.join(home, ".local", "bin");
}

function launcherContent({ node, dashboard, managerHome, sourceRoot }) {
  for (const value of [node, dashboard, managerHome, sourceRoot]) {
    if (/\r|\n|\0/.test(value)) throw failure("Launcher paths contain unsupported control characters", "UNSAFE_PATH");
  }
  if (process.platform === "win32") {
    if ([node, dashboard, managerHome, sourceRoot].some((value) => /[%!]/.test(value))) {
      throw failure("Windows launcher paths cannot contain % or !", "UNSAFE_PATH");
    }
    return Buffer.from(
      `@echo off\r\nsetlocal\r\n"${node}" "${dashboard}" --home "${managerHome}" --source-root "${sourceRoot}" %*\r\nset "control_plane_exit=%errorlevel%"\r\nendlocal & exit /b %control_plane_exit%\r\n`,
      "utf8",
    );
  }
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return Buffer.from(`#!/bin/sh\nexec ${quote(node)} ${quote(dashboard)} --home ${quote(managerHome)} --source-root ${quote(sourceRoot)} "$@"\n`, "utf8");
}

async function transactionalWrite(destination, content, mode) {
  await mkdir(path.dirname(destination), { recursive: true });
  const nonce = `${process.pid}-${randomBytes(5).toString("hex")}`;
  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-stage-${nonce}`);
  const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-backup-${nonce}`);
  let moved = false;
  try {
    await writeFile(stage, content, { flag: "wx", mode });
    if (process.platform !== "win32") await chmod(stage, mode);
    if (await exists(destination)) { await rename(destination, backup); moved = true; }
    await rename(stage, destination);
    if (moved) await rm(backup, { force: true });
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    if (moved) {
      await rm(destination, { force: true }).catch(() => {});
      await rename(backup, destination).catch(() => {});
    }
    throw error;
  }
}

async function transactionalRemove(destination) {
  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.ocp-remove-${process.pid}-${randomBytes(5).toString("hex")}`);
  await rename(destination, stage);
  try { await rm(stage, { force: true }); }
  catch (error) { await rename(stage, destination).catch(() => {}); throw error; }
}

async function readCurrent(file) {
  if (!(await exists(file))) return null;
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 64 * 1024) {
    throw failure(`The launcher destination is unsafe: ${file}`, "LAUNCHER_UNSAFE");
  }
  return { sha256: hash(await readFile(file)) };
}

async function readManifest(file, { optional = false } = {}) {
  if (!(await exists(file))) {
    if (optional) return null;
    throw failure(`Missing launcher manifest: ${file}`, "MANIFEST_MISSING");
  }
  const value = await readJson(file);
  if (value?.schema_version !== 1 || value?.product_id !== PRODUCT_ID || typeof value.destination !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256 ?? "")) {
    throw failure("The launcher manifest is invalid", "MANIFEST_INVALID");
  }
  return value;
}

async function readJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 1024 * 1024) throw failure(`Unsafe JSON file: ${file}`, "UNSAFE_FILE");
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw failure(`Invalid JSON in ${file}: ${error.message}`, "INVALID_JSON"); }
}

async function assertRealDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(`${label} must be one real directory`, "UNSAFE_DIRECTORY");
}

async function assertRegularFile(file, label) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) throw failure(`${label} must be one regular file`, "UNSAFE_FILE");
}

function parseArgs(argv) {
  const result = { home: null, managerHome: null, binHome: null, dryRun: false, remove: false, force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--home", "--manager-home", "--bin-home"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw failure(`${value} requires a path`, "USAGE");
      if (value === "--home") result.home = selected;
      else if (value === "--manager-home") result.managerHome = selected;
      else result.binHome = selected;
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--remove") result.remove = true;
    else if (value === "--force") result.force = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") {
      process.stdout.write("Usage: install-launcher.mjs [--dry-run | --remove] [--force] [--home PATH] [--bin-home PATH] [--manager-home PATH] [--json]\n");
      process.exit(0);
    } else throw failure(`Unknown argument: ${value}`, "USAGE");
  }
  return result;
}

function output(value, json) {
  if (json) return process.stdout.write(`${JSON.stringify(value)}\n`);
  if (value.dry_run) process.stdout.write(`Launcher preview: ${value.launcher}\n${value.note}\n`);
  else if (value.remove) process.stdout.write(`Control Plane terminal launcher removed: ${value.launcher}\n`);
  else {
    process.stdout.write(`Control Plane terminal launcher installed: ${value.launcher}\n${value.note}\n`);
    process.stdout.write(value.path_ready
      ? "Run control-plane from any terminal.\n"
      : `Add ${path.dirname(value.launcher)} to your user PATH, then open a new terminal.\n`);
  }
}

function hash(content) { return createHash("sha256").update(content).digest("hex"); }
function pathKey(value) { const resolved = path.resolve(String(value)); return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved; }
function inside(root, child) { const relative = path.relative(path.resolve(root), path.resolve(child)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
function pathEntries(value) { return String(value).split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter((entry) => path.isAbsolute(entry)); }
function assertInside(root, child, label) { if (!(pathKey(root) === pathKey(child) || inside(root, child))) throw failure(`${label} must stay inside the selected user home`, "UNSAFE_PATH"); }
function failure(message, code) { const error = new Error(message); error.code = code; return error; }
async function exists(location) { try { await lstat(location); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
