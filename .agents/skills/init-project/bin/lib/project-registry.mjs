import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_BYTES = 256 * 1024;
const MAX_PROJECTS = 256;
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

export function registryFile(home = selectedHome()) {
  return path.join(path.resolve(home), ".agents", "opencode-control-plane", "projects.json");
}

export async function readProjectRegistry({ home = selectedHome() } = {}) {
  const file = registryFile(home);
  const value = await readRegistryFile(file, { optional: true });
  if (!value) return emptyRegistry();
  validateRegistry(value);
  return value;
}

export async function registerProject(projectRoot, {
  home = selectedHome(),
  name = null,
  now = new Date(),
} = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  await assertInitializedProject(root);
  const displayName = cleanName(name ?? await readProjectName(root) ?? path.basename(root));
  const timestamp = new Date(now).toISOString();
  const id = projectId(root);
  return withRegistryLock(home, async () => {
    const registry = await readProjectRegistry({ home });
    const key = pathKey(root);
    const existing = registry.projects.find((item) => pathKey(item.root) === key);
    if (existing) {
      existing.name = displayName;
      existing.last_seen_at = timestamp;
      await writeRegistry(home, registry);
      return { added: false, project: { ...existing }, registry_file: registryFile(home) };
    }
    if (registry.projects.length >= MAX_PROJECTS) {
      throw registryError(`Project registry is limited to ${MAX_PROJECTS} entries`, "REGISTRY_LIMIT");
    }
    const project = {
      id,
      root,
      name: displayName,
      registered_at: timestamp,
      last_seen_at: timestamp,
    };
    registry.projects.push(project);
    registry.projects.sort((left, right) => left.name.localeCompare(right.name, "en") || left.root.localeCompare(right.root, "en"));
    await writeRegistry(home, registry);
    return { added: true, project: { ...project }, registry_file: registryFile(home) };
  });
}

export async function forgetProject(identifier, { home = selectedHome() } = {}) {
  const selected = String(identifier ?? "").trim();
  if (!selected) throw registryError("A project ID or path is required", "PROJECT_REQUIRED");
  return withRegistryLock(home, async () => {
    const registry = await readProjectRegistry({ home });
    const resolved = path.resolve(selected);
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((item) => item.id !== selected && pathKey(item.root) !== pathKey(resolved));
    const removed = before - registry.projects.length;
    if (removed > 0) await writeRegistry(home, registry);
    return { removed, registry_file: registryFile(home) };
  });
}

export async function canonicalProjectRoot(value) {
  const root = path.resolve(String(value ?? ""));
  let info;
  try { info = await lstat(root); }
  catch (error) {
    if (error?.code === "ENOENT") throw registryError(`Project folder does not exist: ${root}`, "PROJECT_MISSING");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw registryError("Project root must be one real directory", "UNSAFE_PROJECT_ROOT");
  }
  const actual = path.resolve(await realpath(root));
  if (pathKey(actual) !== pathKey(root)) {
    throw registryError("Project root cannot be a symbolic link or redirected path", "UNSAFE_PROJECT_ROOT");
  }
  return actual;
}

export function selectedHome(source = process.env) {
  return path.resolve(source.OPENCODE_CONTROL_PLANE_HOME || os.homedir());
}

async function assertInitializedProject(root) {
  for (const relative of [
    ".autopilot/state.json",
    ".autopilot/config.json",
    ".autopilot/bin/autopilot.mjs",
    ".project/plan/queue.json",
  ]) {
    const file = path.join(root, ...relative.split("/"));
    let info;
    try { info = await lstat(file); }
    catch (error) {
      if (error?.code === "ENOENT") throw registryError(`Not an initialized Control Plane project: missing ${relative}`, "NOT_INITIALIZED");
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw registryError(`Unsafe initialized-project marker: ${relative}`, "UNSAFE_PROJECT_FILE");
    }
  }
}

async function readProjectName(root) {
  const file = path.join(root, "blueprints", "current", "blueprint.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 2 * 1024 * 1024) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    return typeof value?.product?.name === "string" ? value.product.name : null;
  } catch {
    return null;
  }
}

async function withRegistryLock(home, callback) {
  const file = registryFile(home);
  const lock = `${file}.lock`;
  await assertRegistryParents(path.resolve(home), file);
  await mkdir(path.dirname(file), { recursive: true });
  await assertRegistryParents(path.resolve(home), file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle = null;
  while (!handle) {
    try {
      handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await staleLock(lock)) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw registryError("Another Control Plane process is updating the project list", "REGISTRY_BUSY");
      await wait(50);
    }
  }
  try { return await callback(); }
  finally {
    await handle.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
  }
}

async function staleLock(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw registryError("Project registry lock is unsafe", "UNSAFE_REGISTRY");
    }
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return true;
    try { process.kill(value.pid, 0); return false; }
    catch (error) { return error?.code !== "EPERM"; }
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "UNSAFE_REGISTRY") throw error;
    return true;
  }
}

async function writeRegistry(home, registry) {
  validateRegistry(registry);
  const file = registryFile(home);
  await assertRegistryParents(path.resolve(home), file);
  await mkdir(path.dirname(file), { recursive: true });
  await assertRegistryParents(path.resolve(home), file);
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw registryError("Project registry exceeds its size limit", "REGISTRY_LIMIT");
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const stage = path.join(path.dirname(file), `.${path.basename(file)}.stage-${nonce}`);
  const backup = path.join(path.dirname(file), `.${path.basename(file)}.backup-${nonce}`);
  let moved = false;
  try {
    await writeFile(stage, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const existing = await safeExistingFile(file, { optional: true });
    if (existing) {
      await rename(file, backup);
      moved = true;
    }
    await rename(stage, file);
    if (moved) await rm(backup, { force: true });
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    if (moved) {
      await rm(file, { force: true }).catch(() => {});
      await rename(backup, file).catch(() => {});
    }
    throw error;
  }
}

async function readRegistryFile(file, { optional = false } = {}) {
  const info = await safeExistingFile(file, { optional });
  if (!info) return null;
  if (info.size > MAX_BYTES) throw registryError("Project registry exceeds its size limit", "REGISTRY_LIMIT");
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw registryError(`Project registry is invalid JSON: ${error.message}`, "INVALID_REGISTRY"); }
  return value;
}

async function safeExistingFile(file, { optional = false } = {}) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw registryError("Project registry must be one private regular file", "UNSAFE_REGISTRY");
    }
    return info;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRegistryParents(home, file) {
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) {
    throw registryError("Selected Control Plane home must be one real directory", "UNSAFE_REGISTRY");
  }
  const relative = path.relative(home, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw registryError("Project registry escapes the selected home", "UNSAFE_REGISTRY");
  }
  let current = home;
  for (const part of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw registryError(`Unsafe project registry parent: ${current}`, "UNSAFE_REGISTRY");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function validateRegistry(value) {
  if (!value || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) {
    throw registryError("Project registry has an unsupported shape", "INVALID_REGISTRY");
  }
  const ids = new Set();
  const roots = new Set();
  for (const item of value.projects) {
    if (
      !item || !/^[0-9a-f]{16}$/.test(item.id ?? "") ||
      typeof item.root !== "string" || !path.isAbsolute(item.root) || item.root.length > 4096 ||
      typeof item.name !== "string" || item.name.length < 1 || item.name.length > 200 ||
      !validTimestamp(item.registered_at) || !validTimestamp(item.last_seen_at)
    ) throw registryError("Project registry contains an invalid entry", "INVALID_REGISTRY");
    const rootKey = pathKey(item.root);
    if (ids.has(item.id) || roots.has(rootKey)) throw registryError("Project registry contains duplicate entries", "INVALID_REGISTRY");
    ids.add(item.id);
    roots.add(rootKey);
  }
}

function emptyRegistry() {
  return { schema_version: SCHEMA_VERSION, projects: [] };
}

function cleanName(value) {
  const name = String(value ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return name || "Unnamed project";
}

function projectId(root) {
  return createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 16);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function registryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const registryLimits = Object.freeze({ max_bytes: MAX_BYTES, max_projects: MAX_PROJECTS });
