import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
export const TRANSIENT_RENAME_RETRY_DELAYS_MS = Object.freeze([
  25,
  50,
  100,
  200,
  400,
  800,
  1200,
  1800,
  2400,
  3000,
]);

export class AutopilotError extends Error {
  constructor(message, { code = "AUTOPILOT_ERROR", details = null } = {}) {
    super(message);
    this.name = "AutopilotError";
    this.code = code;
    this.details = details;
  }
}

export const utf8Bytes = (value) => Buffer.byteLength(String(value), "utf8");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function assertPortableRelative(value, label = "path", { allowGlob = false } = {}) {
  const normalized = normalizeRelative(value);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\0-\x1f\x7f:]/.test(normalized) ||
    (!allowGlob && /[*?\[\]]/.test(normalized)) ||
    (allowGlob && /[?\[\]]/.test(normalized))
  ) {
    throw new AutopilotError(`${label} is not a portable project-relative path: ${value}`, {
      code: "INVALID_PATH",
    });
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part)) {
      throw new AutopilotError(`${label} contains an unsafe path segment: ${value}`, {
        code: "INVALID_PATH",
      });
    }
    const literal = part.replaceAll("*", "");
    if (literal && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(literal)) {
      throw new AutopilotError(`${label} contains a reserved portable filename: ${value}`, {
        code: "INVALID_PATH",
      });
    }
  }
  if (allowGlob && parts[0].includes("*")) {
    throw new AutopilotError(`${label} must begin with a literal top-level path: ${value}`, {
      code: "INVALID_PATH",
    });
  }
  return normalized;
}

export function resolveInside(root, relative, label = "path") {
  if (typeof relative !== "string" || relative.trim() === "") {
    throw new AutopilotError(`${label} must be a non-empty path`, {
      code: "INVALID_PATH",
    });
  }
  const absolute = path.resolve(root, relative);
  const rootWithSep = `${path.resolve(root)}${path.sep}`;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootWithSep)) {
    throw new AutopilotError(`${label} escapes the project root: ${relative}`, {
      code: "PATH_ESCAPE",
    });
  }
  return absolute;
}

export async function assertRealInside(root, absolute, label = "path") {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  const normalizeCase = (value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const rootValue = normalizeCase(path.resolve(realRoot));
  const targetValue = normalizeCase(path.resolve(realTarget));
  if (targetValue !== rootValue && !targetValue.startsWith(`${rootValue}${path.sep}`)) {
    throw new AutopilotError(`${label} resolves outside the project root`, {
      code: "REALPATH_ESCAPE",
    });
  }
  return realTarget;
}

export async function assertPrivateDirectory(root, directory, label = "directory") {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AutopilotError(`${label} must be a real directory, not a link`, {
      code: "CONTROL_DIRECTORY_UNSAFE",
    });
  }
  await assertRealInside(root, directory, label);
  return { dev: String(info.dev), ino: String(info.ino), mode: info.mode };
}

export async function assertPrivateFile(root, file, label = "file", { optional = false } = {}) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
    throw new AutopilotError(`${label} must be one private regular file`, {
      code: Number(info.nlink) > 1 ? "HARDLINK_DENIED" : "CONTROL_FILE_UNSAFE",
    });
  }
  await assertRealInside(root, file, label);
  return { dev: String(info.dev), ino: String(info.ino), mode: info.mode, size: info.size };
}

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(file, { maxBytes = null } = {}) {
  if (maxBytes !== null) {
    const info = await stat(file);
    if (info.size > maxBytes) {
      throw new AutopilotError(
        `${file} is ${info.size} bytes; cap is ${maxBytes}`,
        { code: "BYTE_CAP_EXCEEDED" },
      );
    }
  }
  const bytes = await readFile(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AutopilotError(`File is not valid UTF-8: ${file}`, {
      code: "INVALID_UTF8",
    });
  }
}

export async function readJson(file, options = {}) {
  let text;
  try {
    text = await readUtf8(file, options);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AutopilotError(`Required JSON file is missing: ${file}`, {
        code: "MISSING_FILE",
      });
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AutopilotError(`Invalid JSON in ${file}: ${error.message}`, {
      code: "INVALID_JSON",
    });
  }
}

export async function atomicWriteFile(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await renameWithTransientRetry(temporary, file);
    const directoryHandle = await open(path.dirname(file), "r").catch(() => null);
    await directoryHandle?.sync().catch(() => {});
    await directoryHandle?.close().catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function renameWithTransientRetry(source, destination, {
  renameOperation = rename,
  delayOperation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryDelays = TRANSIENT_RENAME_RETRY_DELAYS_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= retryDelays.length) throw error;
      await delayOperation(retryDelays[attempt]);
    }
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeImmutableJson(file, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.pending-${sha256(contents)}`;
  const verifyExisting = async () => {
    let existing;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("destination is not a regular file");
      existing = await readFile(file, "utf8");
    } catch (error) {
      throw new AutopilotError(`Immutable JSON exists but is unreadable: ${file}`, {
        code: "IMMUTABLE_JSON_CONFLICT",
        details: { cause: error.message },
      });
    }
    if (existing !== contents) {
      throw new AutopilotError(`Immutable JSON conflicts with accepted evidence: ${file}`, {
        code: "IMMUTABLE_JSON_CONFLICT",
      });
    }
  };

  try {
    try {
      await access(file);
      await verifyExisting();
      await rm(pending, { force: true }).catch(() => {});
      return { created: false };
    } catch (error) {
      if (error instanceof AutopilotError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }

    let pendingReady = false;
    try {
      const existingPending = await readFile(pending, "utf8");
      pendingReady = existingPending === contents;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!pendingReady) {
      await rm(pending, { force: true });
      const handle = await open(pending, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
    } else {
      const handle = await open(pending, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
    }

    try {
      await link(pending, file);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new AutopilotError(`Could not publish immutable JSON atomically: ${file}`, {
          code: "IMMUTABLE_JSON_WRITE_FAILED",
          details: { cause: error.message },
        });
      }
      await verifyExisting();
    }

    const directoryHandle = await open(path.dirname(file), "r").catch(() => null);
    await directoryHandle?.sync().catch(() => {});
    await directoryHandle?.close().catch(() => {});
    await rm(pending, { force: true });
    return { created: true };
  } finally {
    // A fully written deterministic pending file is intentionally retained on
    // failure so a restart can publish it without regenerating evidence.
  }
}

export async function appendBoundedText(file, text, maxBytes) {
  const suffix = Buffer.from(String(text), "utf8");
  let current = Buffer.alloc(0);
  try {
    current = await readFile(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const combined = Buffer.concat([current, suffix]);
  const bounded =
    combined.length <= maxBytes
      ? combined
      : combined.subarray(combined.length - maxBytes);
  await atomicWriteFile(file, bounded.toString("utf8"));
}

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, ".autopilot", "config.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new AutopilotError(
        `Could not find .autopilot/config.json above ${start}`,
        { code: "PROJECT_ROOT_NOT_FOUND" },
      );
    }
    current = parent;
  }
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern) {
  const normalized = normalizeRelative(pattern);
  let result = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      const isDouble = normalized[index + 1] === "*";
      if (isDouble) {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += escapeRegex(character);
    }
  }
  if (normalized.endsWith("/")) result += ".*";
  result += "$";
  return new RegExp(result);
}

export function matchesGlob(relative, pattern) {
  const target = normalizeRelative(relative);
  const normalizedPattern = normalizeRelative(pattern);
  if (!/[?*]/.test(normalizedPattern)) {
    return (
      target === normalizedPattern ||
      target.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`)
    );
  }
  return globToRegExp(normalizedPattern).test(target);
}

export function isAllowedPath(relative, patterns) {
  return patterns.some((pattern) => matchesGlob(relative, pattern));
}

export function unique(values) {
  return [...new Set(values)];
}

export function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "live";
    return "unknown";
  }
}

const INCOMPLETE_LOCK_GRACE_MS = 30_000;

function incompleteLockStatus(info, record = null) {
  const age = Date.now() - Number(info.mtimeMs ?? Date.now());
  if (!Number.isFinite(age) || age < INCOMPLETE_LOCK_GRACE_MS) {
    return { status: "live", record, indeterminate: true };
  }
  return { status: "stale", record, incomplete: true };
}

export async function processStartIdentity(pid) {
  if (probeProcess(pid) === "dead") return null;
  if (process.platform === "linux") {
    try {
      const [statText, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const close = statText.lastIndexOf(")");
      const fields = close >= 0 ? statText.slice(close + 2).trim().split(/\s+/) : [];
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks ?? "") || !/^[0-9a-f-]{36}$/i.test(bootId.trim())) return null;
      return `linux:${bootId.trim().toLowerCase()}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = [
      "$ErrorActionPreference='Stop'",
      `$p=Get-Process -Id ${pid}`,
      "$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    ].join("; ");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    const ticks = String(result.stdout ?? "").trim();
    if (result.status === 0 && /^\d{10,20}$/.test(ticks)) return `windows:${ticks}`;
  }
  return null;
}

export async function inspectProcessRecord(record, { expectedRoot = null } = {}) {
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    !Number.isInteger(record.pid) || record.pid <= 0
  ) {
    throw new AutopilotError("Controller owner record is invalid", { code: "LOCK_INTEGRITY" });
  }
  if (
    expectedRoot !== null &&
    (typeof record.root !== "string" || path.resolve(record.root) !== path.resolve(expectedRoot))
  ) {
    throw new AutopilotError("Controller owner record belongs to a different project root", {
      code: "LOCK_INTEGRITY",
    });
  }
  const liveness = probeProcess(record.pid);
  if (liveness === "dead") return { status: "stale", record };
  const recordedIdentity = typeof record.process_start_identity === "string"
    ? record.process_start_identity
    : null;
  if (!recordedIdentity) return { status: "live", record, legacy: true };
  const actualIdentity = await processStartIdentity(record.pid);
  if (actualIdentity === null) return { status: "live", record, identity_unavailable: true };
  return {
    status: actualIdentity === recordedIdentity ? "live" : "stale",
    record,
    actual_identity: actualIdentity,
  };
}

export async function inspectProcessLock(file, { expectedRoot = null } = {}) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", record: null };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 16 * 1024) {
    throw new AutopilotError(`Controller lock path is unsafe: ${file}`, { code: "LOCK_INTEGRITY" });
  }
  if (info.size <= 1) return incompleteLockStatus(info);
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return incompleteLockStatus(info);
  }
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    !Number.isInteger(record.pid) || record.pid <= 0
  ) return incompleteLockStatus(info, record);
  try {
    return await inspectProcessRecord(record, { expectedRoot });
  } catch (error) {
    if (error?.code === "LOCK_INTEGRITY") {
      throw new AutopilotError(`Controller lock is invalid: ${file}`, {
        code: "LOCK_INTEGRITY",
        details: { cause: error.message },
      });
    }
    throw error;
  }
}

export async function acquireLock(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const ownerToken = randomBytes(24).toString("hex");
      const processStart = await processStartIdentity(payload.pid);
      const record = {
        ...payload,
        ...(processStart ? { process_start_identity: processStart } : {}),
        owner_token: ownerToken,
      };
      const contents = `${JSON.stringify(record)}\n`;
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const identity = await handle.stat({ bigint: true });
      return {
        file,
        handle,
        owner_token: ownerToken,
        async release() {
          const tombstone = `${file}.release-${ownerToken}`;
          try {
            await rename(file, tombstone);
          } catch (error) {
            await handle.close().catch(() => {});
            throw new AutopilotError(`Controller lock could not be claimed for release: ${file}`, {
              code: "LOCK_INTEGRITY",
              details: { cause: error.message },
            });
          }
          let currentInfo;
          let currentContents;
          try {
            currentInfo = await lstat(tombstone, { bigint: true });
            currentContents = await readFile(tombstone, "utf8");
          } catch (error) {
            await handle.close().catch(() => {});
            throw new AutopilotError(`Controller lock became unreadable during release: ${tombstone}`, {
              code: "LOCK_INTEGRITY",
              details: { cause: error.message, preserved_path: tombstone },
            });
          }
          // Node reports a synthetic handle device ID on Windows, while the
          // file index (ino) remains stable across a same-volume rename.
          const sameIdentity = currentInfo.ino === identity.ino && (
            process.platform === "win32" || currentInfo.dev === identity.dev
          );
          if (
            !currentInfo.isFile() ||
            currentInfo.isSymbolicLink() ||
            Number(currentInfo.nlink) > 1 ||
            !sameIdentity ||
            currentContents !== contents
          ) {
            await handle.close().catch(() => {});
            throw new AutopilotError(`Controller lock ownership changed before release; replacement preserved at ${tombstone}`, {
              code: "LOCK_INTEGRITY",
              details: { preserved_path: tombstone },
            });
          }
          try {
            await rm(tombstone);
          } finally {
            await handle.close().catch(() => {});
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const inspection = await inspectProcessLock(file, { expectedRoot: payload.root ?? null });
      if (inspection.status !== "stale" || pass === 1) {
        throw new AutopilotError(`Another controller owns ${file}`, {
          code: "LOCKED",
        });
      }
      await rm(file, { force: true });
    }
  }
  throw new AutopilotError(`Could not acquire ${file}`, { code: "LOCKED" });
}

export function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  const marker = Buffer.from("\n… output truncated …\n", "utf8");
  const available = Math.max(0, maxBytes - marker.length);
  const headLength = Math.floor(available / 2);
  const tailLength = available - headLength;
  return Buffer.concat([
    buffer.subarray(0, headLength),
    marker,
    buffer.subarray(buffer.length - tailLength),
  ]).toString("utf8");
}
