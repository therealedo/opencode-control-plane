import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutopilotError, truncateUtf8 } from "./core.mjs";

const MAX_EXECUTION_PATH_BYTES = 32 * 1024;
const MAX_EXECUTION_PATH_ENTRIES = 128;
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat", ".ps1", ""];
const PROJECT_SCRIPT_EXTENSION = /\.(?:[cm]?js|jsx|tsx?|py|rb|php|pl|sh|bash|zsh|fish|ps1|cmd|bat|exe|com)$/i;
const gitSafeAmbientConfigCache = new Map();

function foldedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isAtOrInside(root, candidate) {
  const rootValue = foldedPath(root);
  const candidateValue = foldedPath(candidate);
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}${path.sep}`);
}

async function existingRealPath(candidate) {
  try { return await realpath(candidate); }
  catch { return null; }
}

function canonicalPathKey() {
  return process.platform === "win32" ? "Path" : "PATH";
}

export async function externalExecutionEnv(projectRoot, source = process.env) {
  const environment = safeBaseEnv(source);
  const rawPath = String(environment.Path ?? environment.PATH ?? "");
  if (Buffer.byteLength(rawPath, "utf8") > MAX_EXECUTION_PATH_BYTES) {
    throw new AutopilotError(
      `Execution PATH exceeds ${MAX_EXECUTION_PATH_BYTES} UTF-8 bytes`,
      { code: "EXECUTION_PATH_UNSAFE" },
    );
  }
  const entries = rawPath.split(path.delimiter);
  if (entries.length > MAX_EXECUTION_PATH_ENTRIES) {
    throw new AutopilotError(
      `Execution PATH exceeds ${MAX_EXECUTION_PATH_ENTRIES} entries`,
      { code: "EXECUTION_PATH_UNSAFE" },
    );
  }
  const realRoot = await existingRealPath(projectRoot) ?? path.resolve(projectRoot);
  const selected = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const lexical = path.resolve(entry);
    if (isAtOrInside(projectRoot, lexical)) continue;
    const real = await existingRealPath(lexical);
    if (!real || isAtOrInside(realRoot, real)) continue;
    let info;
    try { info = await lstat(real); }
    catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const key = foldedPath(real);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(path.resolve(real));
  }
  delete environment.PATH;
  delete environment.Path;
  environment[canonicalPathKey()] = selected.join(path.delimiter);
  return environment;
}

function executableCandidates(command, environment) {
  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    if (!path.isAbsolute(command)) return [];
    return [path.resolve(command)];
  }
  const search = String(environment.Path ?? environment.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  const suffixes = process.platform === "win32" && !path.extname(command)
    ? WINDOWS_EXECUTABLE_SUFFIXES
    : [""];
  return search.flatMap((directory) => suffixes.map((suffix) => path.join(directory, `${command}${suffix}`)));
}

export async function resolveExternalExecutable(projectRoot, command, environment, {
  label = "command executable",
} = {}) {
  if (typeof command !== "string" || !command || /[\0\r\n]/.test(command)) {
    throw new AutopilotError(`${label} must be one fixed non-empty string`, {
      code: "EXECUTABLE_UNTRUSTED",
    });
  }
  if (/[\\/]/.test(command) && !path.isAbsolute(command)) {
    throw new AutopilotError(`${label} cannot be a relative path`, {
      code: "EXECUTABLE_UNTRUSTED",
    });
  }
  const realRoot = await existingRealPath(projectRoot) ?? path.resolve(projectRoot);
  for (const candidate of executableCandidates(command, environment)) {
    const lexical = path.resolve(candidate);
    if (isAtOrInside(projectRoot, lexical)) continue;
    let real = await existingRealPath(lexical);
    if (!real || isAtOrInside(realRoot, real)) continue;
    if (process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(real).toLowerCase())) {
      const powerShellShim = `${real.slice(0, -path.extname(real).length)}.ps1`;
      real = await existingRealPath(powerShellShim);
      if (!real || isAtOrInside(realRoot, real)) continue;
    }
    let info;
    try { info = await lstat(real); }
    catch { continue; }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (process.platform !== "win32" && (info.mode & 0o111) === 0) continue;
    return path.resolve(real);
  }
  throw new AutopilotError(`${label} did not resolve to a trusted executable outside the project`, {
    code: "EXECUTABLE_UNTRUSTED",
  });
}

// Git for Windows puts a small process-launching shim on PATH (usually
// <install>/cmd/git.exe) and keeps the actual Git executable under
// <install>/mingw{32,64}/bin/git.exe. A shim can outlive a piped parent or
// escape a short-lived Windows Job wrapper, leaving the native child holding
// inherited stdio handles. Prefer the same installation's native executable
// so bounded Git calls have one process lifetime.
export async function resolveExternalGitExecutable(projectRoot, environment, {
  label = "Git executable",
} = {}) {
  const resolved = await resolveExternalExecutable(projectRoot, "git", environment, { label });
  if (process.platform !== "win32" || path.basename(resolved).toLowerCase() !== "git.exe") {
    return resolved;
  }
  const launcherDirectory = path.dirname(resolved);
  const launcherKind = path.basename(launcherDirectory).toLowerCase();
  if (!["cmd", "bin"].includes(launcherKind)) return resolved;
  const installationRoot = path.dirname(launcherDirectory);
  for (const architecture of ["mingw64", "mingw32"]) {
    const nativeCandidate = path.join(installationRoot, architecture, "bin", "git.exe");
    try {
      return await resolveExternalExecutable(projectRoot, nativeCandidate, environment, { label });
    } catch (error) {
      if (error?.code !== "EXECUTABLE_UNTRUSTED") throw error;
    }
  }
  return resolved;
}

// Git for Windows commonly stores core.autocrlf in system or global config.
// Hardened controller calls intentionally disable those config files so hooks,
// filters, aliases, and other ambient behavior cannot affect evidence. Read
// only inert text-normalization and commit-identity values, validate them,
// then pass them back as explicit command-line config. This keeps a normal
// CRLF checkout clean and lets a global-only Git identity create local safety
// commits without re-enabling ambient Git behavior.
export async function gitSafeAmbientConfigArgs(projectRoot, executable, environment) {
  const cacheKey = JSON.stringify([
    foldedPath(projectRoot),
    foldedPath(executable),
    environment.HOME ?? "",
    environment.USERPROFILE ?? "",
  ]);
  if (!gitSafeAmbientConfigCache.has(cacheKey)) {
    gitSafeAmbientConfigCache.set(cacheKey, readSafeAmbientGitConfig(projectRoot, executable, environment));
  }
  return [...await gitSafeAmbientConfigCache.get(cacheKey)];
}

async function readSafeAmbientGitConfig(projectRoot, executable, environment) {
  const result = await runArgv([
    executable,
    "--no-pager",
    "--no-replace-objects",
    "config",
    "--includes",
    "--get-regexp",
    "^(core\\.(autocrlf|eol|safecrlf)|user\\.(name|email))$",
  ], {
    cwd: projectRoot,
    env: {
      ...environment,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      SSH_ASKPASS_REQUIRE: "never",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 16 * 1024,
  });
  if (result.output_truncated || ![0, 1].includes(result.code)) {
    throw new AutopilotError("Could not read bounded Git text-normalization settings", {
      code: "GIT_CONFIG_UNSAFE",
    });
  }
  const allowedCore = new Map([
    ["core.autocrlf", new Set(["true", "false", "input"])],
    ["core.eol", new Set(["lf", "crlf", "native"])],
    ["core.safecrlf", new Set(["true", "false", "warn"])],
  ]);
  const selected = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^([^\s]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const rawValue = match[2].trim();
    const coreValue = rawValue.toLowerCase();
    if (allowedCore.get(key)?.has(coreValue)) {
      selected.set(key, coreValue);
    } else if (
      key === "user.name" &&
      Buffer.byteLength(rawValue, "utf8") <= 256 &&
      !/[\x00-\x1f\x7f]/.test(rawValue)
    ) {
      selected.set(key, rawValue);
    } else if (
      key === "user.email" &&
      Buffer.byteLength(rawValue, "utf8") <= 320 &&
      /^[^<>\s@]+@[^<>\s@]+$/.test(rawValue)
    ) {
      selected.set(key, rawValue);
    }
  }
  return [...selected].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

export async function resolveExternalInvocation(projectRoot, command, environment, {
  label = "command executable",
} = {}) {
  const executable = await resolveExternalExecutable(projectRoot, command, environment, { label });
  if (process.platform !== "win32" || path.extname(executable).toLowerCase() !== ".ps1") {
    return [executable];
  }
  const configuredPowerShell = path.join(
    environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let powerShell;
  try {
    powerShell = await resolveExternalExecutable(
      projectRoot,
      configuredPowerShell,
      environment,
      { label: "system PowerShell executable" },
    );
  } catch {
    powerShell = await resolveExternalExecutable(
      projectRoot,
      "pwsh.exe",
      environment,
      { label: "PowerShell executable" },
    );
  }
  return [
    powerShell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    executable,
  ];
}

function argumentCandidate(argument) {
  const equals = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/.exec(argument);
  return equals ? equals[1] : argument;
}

function looksProjectRelativePath(value) {
  if (!value) return false;
  if (/^(?:https?|npm):/i.test(value) || /^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[^/\\]+)?$/.test(value)) return false;
  return value === "." || value === ".." ||
    /^(?:\.\.?[\\/])/.test(value) ||
    /^[A-Za-z0-9._ -]+(?:[\\/][A-Za-z0-9._ -]+)+$/.test(value) ||
    PROJECT_SCRIPT_EXTENSION.test(value);
}

function containsPathLiteral(text, root) {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(root, offset);
    if (index < 0) return false;
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + root.length] ?? "";
    if (
      (!before || /[\s'"=(:,[]/.test(before)) &&
      (!after || /[\\/\s'"),;\]]/.test(after))
    ) return true;
    offset = index + root.length;
  }
  return false;
}

export async function assertExternalLaunchArguments(projectRoot, args, {
  label = "command argument",
  allowProjectPlaceholder = false,
} = {}) {
  if (!Array.isArray(args)) {
    throw new AutopilotError(`${label}s must be an array`, { code: "EXECUTABLE_UNTRUSTED" });
  }
  const realRoot = await existingRealPath(projectRoot) ?? path.resolve(projectRoot);
  const rootLiteral = foldedPath(projectRoot).replaceAll("\\", "/");
  for (const [index, argument] of args.entries()) {
    if (typeof argument !== "string" || !argument || /[\0\r\n]/.test(argument)) {
      throw new AutopilotError(`${label} ${index} must be one fixed non-empty line`, {
        code: "EXECUTABLE_UNTRUSTED",
      });
    }
    if (argument === "{project}" && !allowProjectPlaceholder) {
      throw new AutopilotError(`${label} ${index} cannot expose the project as an executable argument`, {
        code: "EXECUTABLE_UNTRUSTED",
      });
    }
    if (allowProjectPlaceholder && argument === "{project}") continue;
    const literal = (process.platform === "win32" ? argument.toLocaleLowerCase("en-US") : argument)
      .replaceAll("\\", "/");
    if (rootLiteral && containsPathLiteral(literal, rootLiteral)) {
      throw new AutopilotError(`${label} ${index} references the project workspace`, {
        code: "EXECUTABLE_UNTRUSTED",
      });
    }
    let candidate = argumentCandidate(argument);
    if (candidate.startsWith("file:")) {
      try { candidate = fileURLToPath(candidate); }
      catch {
        throw new AutopilotError(`${label} ${index} contains an invalid file URL`, {
          code: "EXECUTABLE_UNTRUSTED",
        });
      }
    }
    if (allowProjectPlaceholder && candidate === "{project}") continue;
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(projectRoot, candidate);
    const existing = await existingRealPath(absolute);
    if (
      (path.isAbsolute(candidate) && isAtOrInside(projectRoot, absolute)) ||
      (existing && isAtOrInside(realRoot, existing)) ||
      (!path.isAbsolute(candidate) && looksProjectRelativePath(candidate)) ||
      (!path.isAbsolute(candidate) && existing && isAtOrInside(projectRoot, absolute))
    ) {
      throw new AutopilotError(`${label} ${index} cannot launch or load project-owned code`, {
        code: "EXECUTABLE_UNTRUSTED",
      });
    }
  }
}

export function safeBaseEnv(source = process.env) {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PSModuleAnalysisCachePath",
    "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR", "FORCE_COLOR",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => allowed.has(key) && typeof value === "string"),
  );
}

function windowsFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function windowsCandidates(command, cwd, env) {
  const directories = /[\\/]/.test(command)
    ? [path.isAbsolute(command) ? "" : cwd]
    : String(env.Path ?? env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extension = path.extname(command);
  const suffixes = extension ? [""] : [".exe", ".com", ".ps1", ".cmd", ".bat", ""];
  const output = [];
  for (const directory of directories) {
    const base = directory ? path.resolve(directory, command) : path.resolve(command);
    for (const suffix of suffixes) output.push(`${base}${suffix}`);
  }
  return output;
}

function resolveWindowsInvocation(argv, cwd, env) {
  if (process.platform !== "win32") return { command: argv[0], args: argv.slice(1) };
  const resolved = windowsCandidates(argv[0], cwd, env).find(windowsFile);
  if (!resolved) return { command: argv[0], args: argv.slice(1) };
  const extension = path.extname(resolved).toLowerCase();
  if (![".cmd", ".bat", ".ps1"].includes(extension)) {
    return { command: resolved, args: argv.slice(1) };
  }
  const script = extension === ".ps1"
    ? resolved
    : `${resolved.slice(0, -extension.length)}.ps1`;
  if (!windowsFile(script)) {
    throw new AutopilotError(
      `Windows command shim ${resolved} has no matching PowerShell shim; use a native executable or an explicit node script argv`,
      { code: "WINDOWS_SHIM_UNSUPPORTED" },
    );
  }
  const systemPowerShell = path.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powerShell = windowsFile(systemPowerShell)
    ? systemPowerShell
    : windowsCandidates("pwsh.exe", cwd, env).find(windowsFile);
  if (!powerShell) {
    throw new AutopilotError("PowerShell is required to launch this Windows command shim safely", {
      code: "POWERSHELL_REQUIRED",
    });
  }
  return {
    command: powerShell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...argv.slice(1),
    ],
  };
}

function terminateProcessTree(child, signal = "SIGTERM") {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    killer.on("close", (code) => { if (code !== 0) child.kill(); });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function runArgv(argv, {
  cwd,
  env = safeBaseEnv(),
  timeoutMs = 60_000,
  maxOutputBytes = 1024 * 1024,
  input = null,
  allowMultilineArgs = false,
  guardProcessTree = false,
} = {}) {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((part) =>
      typeof part !== "string" ||
      !part ||
      part.includes("\0") ||
      (!allowMultilineArgs && /[\r\n]/.test(part)),
    )
  ) {
    throw new AutopilotError("Process argv must contain fixed, non-empty strings", {
      code: "INVALID_ARGV",
    });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60 * 1000) {
    throw new AutopilotError("Process timeout must be between 1 ms and 24 hours", {
      code: "PROCESS_LIMIT_INVALID",
    });
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 64 * 1024 * 1024) {
    throw new AutopilotError("Process output cap must be between 1 and 67108864 bytes", {
      code: "PROCESS_LIMIT_INVALID",
    });
  }
  if (input !== null && Buffer.byteLength(String(input), "utf8") > 16 * 1024 * 1024) {
    throw new AutopilotError("Process stdin exceeds the 16777216-byte cap", {
      code: "PROCESS_LIMIT_INVALID",
    });
  }
  const invocation = resolveWindowsInvocation(argv, cwd, env);
  const guard = fileURLToPath(new URL("../process-guard.mjs", import.meta.url));
  const guardedInvocation = guardProcessTree
    ? {
      command: process.execPath,
      args: [guard, String(process.pid), invocation.command, ...invocation.args],
    }
    : invocation;
  const child = spawn(guardedInvocation.command, guardedInvocation.args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const collect = (target, chunk, current, markTruncated) => {
    if (current >= maxOutputBytes) {
      markTruncated();
      return current;
    }
    const remaining = maxOutputBytes - current;
    if (chunk.length > remaining) markTruncated();
    target.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
    return current + Math.min(chunk.length, remaining);
  };
  child.stdout.on("data", (chunk) => {
    stdoutBytes = collect(stdout, Buffer.from(chunk), stdoutBytes, () => { stdoutTruncated = true; });
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes = collect(stderr, Buffer.from(chunk), stderrBytes, () => { stderrTruncated = true; });
  });
  if (input !== null) {
    child.stdin.end(input);
  }
  let timedOut = false;
  let escalationTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, "SIGTERM");
    if (process.platform !== "win32") {
      escalationTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2_000);
      escalationTimer.unref();
    }
  }, timeoutMs);
  timer.unref();
  let code;
  let signal;
  try {
    [code, signal] = await once(child, "close");
  } catch (error) {
    throw new AutopilotError(`Could not execute ${argv[0]}: ${error.message}`, {
      code: "PROCESS_START_FAILED",
    });
  } finally {
    clearTimeout(timer);
    if (escalationTimer) clearTimeout(escalationTimer);
  }
  return {
    argv: [...argv],
    code,
    signal,
    timed_out: timedOut,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    output_truncated: stdoutTruncated || stderrTruncated,
  };
}

export function redactText(text, secretValues = []) {
  let output = String(text);
  for (const value of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (typeof value === "string" && value.length >= 4) output = output.split(value).join("[REDACTED]");
  }
  output = output
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]")
    .replace(/(\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return output;
}

export function sanitizeProcessResult(result, secretValues, maxBytes) {
  const stdout = redactText(result.stdout, secretValues);
  const stderr = redactText(result.stderr, secretValues);
  return {
    ...result,
    output_truncated:
      Boolean(result.output_truncated) ||
      Buffer.byteLength(stdout, "utf8") > maxBytes ||
      Buffer.byteLength(stderr, "utf8") > maxBytes,
    stdout: truncateUtf8(stdout, maxBytes),
    stderr: truncateUtf8(stderr, maxBytes),
  };
}

export function commandDisplay(argv) {
  return argv.map((part) => (/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}
