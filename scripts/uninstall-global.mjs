#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRODUCT_ID = "opencode-control-plane";
let compact = false;

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code ?? "GLOBAL_UNINSTALL_FAILED" }, null, compact ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  compact = args.json;
  const home = path.resolve(args.home ?? os.homedir());
  const manifestFile = path.join(home, ".agents", ".autopilot-install-manifest.json");
  const manifest = await readJson(manifestFile, 1024 * 1024);
  validateManifest(manifest, home);
  const sourceRoot = path.resolve(args.sourceRoot ?? manifest.source_root);
  const managerHome = path.join(sourceRoot, ".control-plane-home");
  const stateDirectory = path.join(home, ".agents", "opencode-control-plane");

  for (const output of manifest.outputs) {
    const current = await treeSha256(output.destination);
    if (current !== output.sha256) {
      throw failure(`Global Control Plane output drifted and was not removed: ${output.destination}`, "GLOBAL_INSTALL_DRIFT");
    }
  }
  const state = await inspectGlobalState(stateDirectory);
  const preview = {
    ok: true,
    dry_run: args.dryRun,
    home,
    source_root: sourceRoot,
    manager_home: managerHome,
    remove: [...manifest.outputs.map((item) => item.destination), manifestFile, ...(state.present ? [stateDirectory] : [])],
    migrate_registry: state.registry ? { from: state.registry, to: path.join(managerHome, ".agents", "opencode-control-plane", "projects.json") } : null,
    preserves_unrelated_global_files: true,
  };
  if (args.dryRun) return output(preview, args.json);

  if (state.registry) await migrateRegistry(state.registry, managerHome);
  const targets = [...manifest.outputs.map((item) => item.destination), manifestFile];
  if (state.present) targets.push(stateDirectory);
  await transactionalRemove(targets);
  output({ ...preview, dry_run: false, removed: targets, migrated_registry: Boolean(state.registry) }, args.json);
}

function validateManifest(manifest, home) {
  if (
    manifest?.schema_version !== 2 || manifest?.product_id !== PRODUCT_ID ||
    path.resolve(manifest.home ?? "") !== home || !Array.isArray(manifest.outputs) ||
    typeof manifest.source_root !== "string" || !path.isAbsolute(manifest.source_root)
  ) throw failure("The global Control Plane install manifest is invalid or unsupported", "GLOBAL_MANIFEST_INVALID");
  const allowedRoots = [path.join(home, ".agents"), path.resolve(manifest.config_home), path.resolve(manifest.bin_home)];
  const seen = new Set();
  for (const item of manifest.outputs) {
    if (!item || typeof item.destination !== "string" || !path.isAbsolute(item.destination) || !/^[0-9a-f]{64}$/.test(item.sha256 ?? "")) {
      throw failure("The global Control Plane manifest contains an invalid output", "GLOBAL_MANIFEST_INVALID");
    }
    const destination = path.resolve(item.destination);
    if (!allowedRoots.some((root) => inside(root, destination)) || seen.has(pathKey(destination))) {
      throw failure(`The global Control Plane manifest contains an unsafe output: ${destination}`, "GLOBAL_MANIFEST_INVALID");
    }
    seen.add(pathKey(destination));
  }
}

async function inspectGlobalState(directory) {
  if (!(await exists(directory))) return { present: false, registry: null };
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("The global Control Plane state directory is unsafe and was not removed", "GLOBAL_STATE_UNSAFE");
  const allowed = new Set(["projects.json", "update-cache.json"]);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name)) {
      throw failure(`Unexpected file in the global Control Plane state directory; it was not removed: ${entry.name}`, "GLOBAL_STATE_UNOWNED");
    }
  }
  const registry = path.join(directory, "projects.json");
  return { present: true, registry: await exists(registry) ? registry : null };
}

async function migrateRegistry(source, managerHome) {
  const incoming = await readJson(source, 256 * 1024);
  if (incoming?.schema_version !== 1 || !Array.isArray(incoming.projects)) throw failure("The global project registry is invalid", "GLOBAL_REGISTRY_INVALID");
  const destination = path.join(managerHome, ".agents", "opencode-control-plane", "projects.json");
  let current = { schema_version: 1, projects: [] };
  if (await exists(destination)) current = await readJson(destination, 256 * 1024);
  if (current?.schema_version !== 1 || !Array.isArray(current.projects)) throw failure("The project-local manager registry is invalid", "LOCAL_REGISTRY_INVALID");
  const merged = new Map(current.projects.map((item) => [pathKey(item.root), item]));
  for (const item of incoming.projects) if (!merged.has(pathKey(item.root))) merged.set(pathKey(item.root), item);
  const value = { schema_version: 1, projects: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "en") || a.root.localeCompare(b.root, "en")) };
  await mkdir(path.dirname(destination), { recursive: true });
  const stage = `${destination}.stage-${process.pid}-${randomBytes(5).toString("hex")}`;
  await writeFile(stage, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (await exists(destination)) {
    const backup = `${stage}.backup`;
    await rename(destination, backup);
    try { await rename(stage, destination); await rm(backup, { force: true }); }
    catch (error) { await rm(destination, { force: true }).catch(() => {}); await rename(backup, destination).catch(() => {}); throw error; }
  } else await rename(stage, destination);
}

async function transactionalRemove(targets) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const moved = [];
  try {
    for (const target of targets) {
      if (!(await exists(target))) throw failure(`Global uninstall target disappeared: ${target}`, "GLOBAL_UNINSTALL_RACE");
      const stage = path.join(path.dirname(target), `.${path.basename(target)}.ocp-uninstall-${nonce}`);
      if (await exists(stage)) throw failure(`Global uninstall staging path exists: ${stage}`, "GLOBAL_UNINSTALL_COLLISION");
      await rename(target, stage);
      moved.push({ target, stage });
    }
  } catch (error) {
    for (const item of [...moved].reverse()) await rename(item.stage, item.target).catch(() => {});
    throw error;
  }
  for (const item of moved) await rm(item.stage, { recursive: true, force: true });
}

async function treeSha256(location) {
  const records = [];
  const walk = async (current, relative = "") => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw failure(`Global output contains a link: ${current}`, "GLOBAL_INSTALL_UNSAFE");
    if (info.isFile()) { records.push(`file\0${relative}\0${createHash("sha256").update(await readFile(current)).digest("hex")}\0`); return; }
    if (!info.isDirectory()) throw failure(`Global output has an unsupported type: ${current}`, "GLOBAL_INSTALL_UNSAFE");
    records.push(`dir\0${relative}\0`);
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) await walk(path.join(current, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
  };
  await walk(location);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function readJson(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > maxBytes) throw failure(`Unsafe or oversized JSON file: ${file}`, "UNSAFE_JSON");
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw failure(`Invalid JSON in ${file}: ${error.message}`, "INVALID_JSON"); }
}

function parseArgs(argv) {
  const result = { home: null, sourceRoot: null, dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--home", "--source-root"].includes(value)) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw failure(`${value} requires a path`, "USAGE");
      if (value === "--home") result.home = selected; else result.sourceRoot = selected;
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") { process.stdout.write("Usage: uninstall-global.mjs [--home PATH] [--source-root PATH] [--dry-run] [--json]\n"); process.exit(0); }
    else throw failure(`Unknown argument: ${value}`, "USAGE");
  }
  return result;
}

function inside(root, child) { const relative = path.relative(path.resolve(root), path.resolve(child)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
function pathKey(value) { const resolved = path.resolve(String(value ?? "")); return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved; }
function output(value, json) { process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`); }
function failure(message, code) { const error = new Error(message); error.code = code; return error; }
async function exists(location) { try { await lstat(location); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
