#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerProject } from "../.agents/skills/init-project/bin/lib/project-registry.mjs";

const MANIFEST_RELATIVE = ".opencode-control-plane/install.json";
const PRODUCT_ID = "opencode-control-plane";
const OUTPUT_CAP = 4 * 1024 * 1024;
let compact = false;

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code ?? "PROJECT_INSTALL_FAILED",
    details: error?.details ?? null,
  }, null, compact ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  compact = args.json;
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!args.target) throw failure("Choose a project folder with --target PATH", "TARGET_REQUIRED");
  const target = path.resolve(args.target);
  const sourceSkill = path.join(sourceRoot, ".agents", "skills", "init-project");
  const release = await readJson(path.join(sourceSkill, "assets", "control-plane-release.json"), 128 * 1024);
  if (release.product_id !== PRODUCT_ID || release.version !== (await readJson(path.join(sourceRoot, "package.json"), 128 * 1024)).version) {
    throw failure("The Control Plane source checkout has inconsistent version metadata", "SOURCE_INVALID");
  }
  await assertRealDirectory(sourceRoot, "Control Plane source");
  await mkdir(target, { recursive: true });
  await assertRealDirectory(target, "Project target");
  assertDisjoint(sourceRoot, target);

  const prior = await readPriorManifest(target);
  const project = await inspectProject(target, prior);
  const runtime = await planRuntimeUpgrade(target, sourceSkill, release.version, project);
  const managerHome = path.join(sourceRoot, ".control-plane-home");
  const actions = projectActions(sourceRoot, target, project.kind);
  const sourceHashes = new Map();
  for (const action of actions) sourceHashes.set(action.relative, await treeSha256(action.source));
  await assertOwnership(target, actions, sourceHashes, prior, project);

  const preview = {
    ok: true,
    dry_run: args.dryRun,
    mode: project.kind,
    target,
    source_root: sourceRoot,
    manager_home: managerHome,
    control_plane_version: release.version,
    runtime_upgrade: args.bootstrapOnly && runtime.required ? { ...runtime, skipped: "bootstrap-only migration" } : runtime,
    actions: actions.map((action) => ({ relative: action.relative, destination: action.destination, sha256: sourceHashes.get(action.relative) })),
    manifest: path.join(target, ...MANIFEST_RELATIVE.split("/")),
  };
  if (args.dryRun) return output(preview, args.json);

  let runtimeResult = null;
  if (runtime.required && !args.bootstrapOnly) runtimeResult = await upgradeRuntime(target, sourceSkill, project.kind);
  const installed = await transactionalInstall({
    target, sourceRoot, managerHome, release, actions, sourceHashes, prior,
  });
  await addLocalGitExcludes(target);

  let registration = { registered: false, skipped: "project is not finalized" };
  if (project.kind === "initialized") {
    await mkdir(managerHome, { recursive: true });
    const registered = await registerProject(target, { home: managerHome });
    registration = { registered: true, added: registered.added, id: registered.project.id };
  }
  output({
    ...preview,
    dry_run: false,
    changed: installed.changed || Boolean(runtimeResult?.changed),
    runtime_upgrade: runtimeResult ?? preview.runtime_upgrade,
    registration,
    next: project.kind === "fresh"
      ? ["Open this project folder in OpenCode", "Run /init-project"]
      : project.kind === "interview"
        ? ["Continue the existing /init-project interview"]
        : ["Open control-plane.cmd in this project when you want autonomous mode", "Use manual-mode.cmd on for explicit manual work"],
  }, args.json);
}

function projectActions(sourceRoot, target, kind) {
  const templateCommands = path.join(sourceRoot, ".agents", "skills", "init-project", "assets", "project", ".opencode", "commands");
  const projectTemplate = path.join(sourceRoot, ".agents", "skills", "init-project", "assets", "project");
  const definitions = [
    [".agents/skills/evolve-project", path.join(sourceRoot, ".agents", "skills", "evolve-project")],
    [".agents/skills/init-project", path.join(sourceRoot, ".agents", "skills", "init-project")],
    [".opencode/commands/evolve-project.md", path.join(templateCommands, "evolve-project.md")],
    [".opencode/commands/init-project.md", path.join(templateCommands, "init-project.md")],
  ];
  if (kind !== "fresh") definitions.push(
    [".autopilot/bin/manual-mode.mjs", path.join(projectTemplate, ".autopilot", "bin", "manual-mode.mjs")],
    ["manual-mode", path.join(projectTemplate, "manual-mode")],
    ["manual-mode.cmd", path.join(projectTemplate, "manual-mode.cmd")],
  );
  return definitions.map(([relative, source]) => ({
    relative,
    source,
    destination: path.join(target, ...relative.split("/")),
  }));
}

async function inspectProject(target, prior) {
  const initialized = await exists(path.join(target, ".autopilot", "control-plane.json"));
  const interview = await exists(path.join(target, ".autopilot", "init", "blueprint.json"));
  if (initialized) return { kind: interview ? "interview" : "initialized" };
  const entries = await readdir(target);
  const allowed = new Set([".git", ".gitignore"]);
  if (prior) {
    allowed.add(".agents");
    allowed.add(".opencode");
    allowed.add(".opencode-control-plane");
  }
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length) {
    throw failure(`The target is not empty (${unexpected.slice(0, 5).join(", ")}) and is not an initialized Control Plane project`, "TARGET_NOT_ELIGIBLE");
  }
  return { kind: "fresh" };
}

async function planRuntimeUpgrade(target, sourceSkill, version, project) {
  if (project.kind === "fresh") return { required: false, reason: "project is not initialized" };
  const installed = await readJson(path.join(target, ".autopilot", "control-plane.json"), 1024 * 1024);
  return installed.version === version
    ? { required: false, from_version: installed.version, to_version: version }
    : { required: true, from_version: installed.version, to_version: version, interview: project.kind === "interview" };
}

async function upgradeRuntime(target, sourceSkill, kind) {
  const script = path.join(sourceSkill, "bin", "upgrade-project.mjs");
  const argv = [script, "--target", target, "--source-skill", sourceSkill, "--json"];
  if (kind === "interview") argv.push("--interview");
  const result = await run(process.execPath, argv, target, 15 * 60_000);
  if (result.code !== 0) throw failure(`Project runtime upgrade stopped safely: ${diagnostic(result)}`, "RUNTIME_UPGRADE_FAILED");
  try { return JSON.parse(result.stdout); }
  catch { throw failure("Project runtime upgrade returned invalid JSON", "RUNTIME_UPGRADE_FAILED"); }
}

async function assertOwnership(target, actions, sourceHashes, prior, project) {
  const priorOutputs = new Map((prior?.outputs ?? []).map((item) => [item.relative, item]));
  for (const action of actions) {
    if (!(await exists(action.destination))) continue;
    const current = await treeSha256(action.destination);
    const owned = priorOutputs.get(action.relative);
    if (owned) {
      if (current !== owned.sha256) throw failure(`Project-local Control Plane file drifted outside the installer: ${action.relative}`, "LOCAL_INSTALL_DRIFT");
      continue;
    }
    if (current === sourceHashes.get(action.relative)) continue;
    if (project.kind !== "fresh" && action.relative.startsWith(".opencode/commands/")) {
      const installed = await readJson(path.join(target, ".autopilot", "control-plane.json"), 1024 * 1024);
      const record = installed.managed_files?.[action.relative];
      if (record?.mode === "exact" && await fileSha256(action.destination) === record.sha256) continue;
    }
    throw failure(`Refusing to replace an unowned project path: ${action.relative}`, "LOCAL_INSTALL_CONFLICT");
  }
}

async function transactionalInstall({ target, sourceRoot, managerHome, release, actions, sourceHashes, prior }) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const staged = [];
  let changed = false;
  const manifestDestination = path.join(target, ...MANIFEST_RELATIVE.split("/"));
  try {
    for (const action of actions) {
      await assertSafeDestination(target, action.destination);
      await mkdir(path.dirname(action.destination), { recursive: true });
      const stage = path.join(path.dirname(action.destination), `.${path.basename(action.destination)}.ocp-stage-${nonce}`);
      const backup = path.join(path.dirname(action.destination), `.${path.basename(action.destination)}.ocp-backup-${nonce}`);
      await assertAbsent(stage);
      await assertAbsent(backup);
      await cp(action.source, stage, { recursive: true, force: false, errorOnExist: true });
      if (await treeSha256(stage) !== sourceHashes.get(action.relative)) throw failure(`Staged copy changed: ${action.relative}`, "STAGE_HASH_MISMATCH");
      staged.push({ ...action, stage, backup, had: await exists(action.destination), moved: false, installed: false });
    }
    await mkdir(path.dirname(manifestDestination), { recursive: true });
    const manifest = {
      schema_version: 1,
      product_id: PRODUCT_ID,
      version: release.version,
      repository: release.repository,
      installed_at: prior?.installed_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      target,
      source_root: sourceRoot,
      manager_home: managerHome,
      outputs: actions.map((action) => ({ relative: action.relative, sha256: sourceHashes.get(action.relative) })),
    };
    const manifestStage = path.join(path.dirname(manifestDestination), `.${path.basename(manifestDestination)}.ocp-stage-${nonce}`);
    const manifestBackup = path.join(path.dirname(manifestDestination), `.${path.basename(manifestDestination)}.ocp-backup-${nonce}`);
    await writeFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    staged.push({ relative: MANIFEST_RELATIVE, destination: manifestDestination, stage: manifestStage, backup: manifestBackup, had: await exists(manifestDestination), moved: false, installed: false });

    for (const action of staged) {
      if (action.had) { await rename(action.destination, action.backup); action.moved = true; }
      await rename(action.stage, action.destination);
      action.installed = true;
      changed = true;
    }
    for (const action of staged) if (action.moved) await rm(action.backup, { recursive: true, force: true });
    return { changed };
  } catch (error) {
    const rollback = [];
    for (const action of [...staged].reverse()) {
      try {
        if (action.installed) await rm(action.destination, { recursive: true, force: true });
        if (action.moved) await rename(action.backup, action.destination);
        await rm(action.stage, { recursive: true, force: true });
      } catch (rollbackError) { rollback.push(`${action.relative}: ${rollbackError.message}`); }
    }
    if (rollback.length) throw failure(`${error.message}; rollback also failed: ${rollback.join("; ")}`, "ROLLBACK_FAILED");
    throw error;
  }
}

async function readPriorManifest(target) {
  const file = path.join(target, ...MANIFEST_RELATIVE.split("/"));
  if (!(await exists(file))) return null;
  const value = await readJson(file, 1024 * 1024);
  if (value.schema_version !== 1 || value.product_id !== PRODUCT_ID || path.resolve(value.target ?? "") !== target || !Array.isArray(value.outputs)) {
    throw failure("The project-local Control Plane install manifest is invalid", "LOCAL_MANIFEST_INVALID");
  }
  return value;
}

async function addLocalGitExcludes(target) {
  const git = path.join(target, ".git");
  if (!(await exists(git))) return;
  const info = await lstat(git);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("Project-local installation requires a real .git directory", "UNSAFE_GIT_LAYOUT");
  const file = path.join(git, "info", "exclude");
  await mkdir(path.dirname(file), { recursive: true });
  let current = "";
  if (await exists(file)) {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink() || Number(existing.nlink) > 1 || existing.size > 1024 * 1024) throw failure(".git/info/exclude is unsafe", "UNSAFE_GIT_LAYOUT");
    current = await readFile(file, "utf8");
  }
  const begin = "# BEGIN OPENCODE CONTROL PLANE LOCAL";
  const end = "# END OPENCODE CONTROL PLANE LOCAL";
  const block = `${begin}\n/.agents/\n/.opencode-control-plane/\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "g");
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  if (next !== current) await writeFile(file, next, "utf8");
}

async function treeSha256(location) {
  const records = [];
  const walk = async (current, relative = "") => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw failure(`Control Plane files cannot contain links: ${current}`, "UNSAFE_INSTALL_PATH");
    if (info.isFile()) {
      records.push(`file\0${relative}\0${createHash("sha256").update(await readFile(current)).digest("hex")}\0`);
      return;
    }
    if (!info.isDirectory()) throw failure(`Unsupported install path: ${current}`, "UNSAFE_INSTALL_PATH");
    records.push(`dir\0${relative}\0`);
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) await walk(path.join(current, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
  };
  await walk(location);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function assertSafeDestination(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw failure("Install destination escapes the project", "UNSAFE_INSTALL_PATH");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!(await exists(current))) return;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw failure(`Install destination traverses a link: ${current}`, "UNSAFE_INSTALL_PATH");
  }
}

async function assertRealDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(directory)) !== path.resolve(directory)) {
    throw failure(`${label} must be one real directory`, "UNSAFE_DIRECTORY");
  }
}

function assertDisjoint(source, target) {
  const a = path.relative(source, target);
  const b = path.relative(target, source);
  const nested = (value) => value === "" || (!value.startsWith("..") && !path.isAbsolute(value));
  if (nested(a) || nested(b)) throw failure("The project target and Control Plane source checkout must be separate directories", "SOURCE_TARGET_OVERLAP");
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let size = 0; let timer;
    const collect = (kind) => (chunk) => {
      size += chunk.length;
      if (size > OUTPUT_CAP) { child.kill(); return; }
      if (kind === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, output_truncated: size > OUTPUT_CAP }); });
    timer = setTimeout(() => { child.kill(); }, timeoutMs);
  });
}

async function readJson(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > maxBytes) throw failure(`Unsafe or oversized JSON file: ${file}`, "UNSAFE_JSON");
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw failure(`Invalid JSON in ${file}: ${error.message}`, "INVALID_JSON"); }
}

function parseArgs(argv) {
  const result = { target: null, dryRun: false, json: false, bootstrapOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) throw failure("--target requires a path", "USAGE");
      result.target = selected;
    } else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--bootstrap-only") result.bootstrapOnly = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") {
      process.stdout.write("Usage: install-project.mjs --target PATH [--bootstrap-only] [--dry-run] [--json]\n");
      process.exit(0);
    } else throw failure(`Unknown argument: ${value}`, "USAGE");
  }
  return result;
}

function diagnostic(result) { return String(result.stderr || result.stdout || `exit ${result.code}`).replace(/[\r\n]+/g, " ").trim().slice(0, 4096); }
async function fileSha256(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return null; return createHash("sha256").update(await readFile(file)).digest("hex"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function output(value, json) { process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`); }
function failure(message, code) { const error = new Error(message); error.code = code; return error; }
async function exists(location) { try { await lstat(location); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function assertAbsent(location) { if (await exists(location)) throw failure(`Temporary install path already exists: ${location}`, "TEMP_COLLISION"); }
