import path from "node:path";
import os from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  AutopilotError,
  assertPrivateDirectory,
  atomicWriteJson,
  normalizeRelative,
  nowIso,
  resolveInside,
  sha256,
  stableJson,
  truncateUtf8,
} from "./core.mjs";
import { isForbiddenCredentialVariable } from "./contracts.mjs";
import {
  assertControlTopology,
  loadContracts,
  loadProject,
  preflightProjectRoot,
} from "./project.mjs";
import { externalExecutionEnv, runArgv, sanitizeProcessResult } from "./process.mjs";
import { exactSecretMatches, exactSecretVariants } from "./secrets.mjs";

const GATE_TEMP_TREE_MAX_ENTRIES = 100_000;
const GATE_TEMP_TREE_MAX_DEPTH = 64;
const GATE_TEMP_PARENT_MAX_ENTRIES = 100_000;
const GATE_TEMP_RUNTIME_MAX_CANDIDATES = 64;
const GATE_OUTPUT_SECRET_MAX_VALUES = 128;
const GATE_OUTPUT_SECRET_MAX_BYTES = 64 * 1024;
const GATE_INJECTED_ENV_MAX_BYTES = 16 * 1024;

function foldedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isAtOrInside(root, candidate) {
  const rootValue = foldedPath(root);
  const candidateValue = foldedPath(candidate);
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}${path.sep}`);
}

function gateRuntimePrefix(project) {
  const rootIdentity = process.platform === "win32"
    ? path.resolve(project.root).toLocaleLowerCase("en-US")
    : path.resolve(project.root);
  return `autopilot-${sha256(rootIdentity).slice(0, 16)}-gate-`;
}

async function trustedGateTempParent(project) {
  const configured = os.tmpdir();
  if (!path.isAbsolute(configured)) {
    throw new AutopilotError("Operating-system temporary directory must be absolute", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  let parent;
  try { parent = await realpath(configured); }
  catch {
    throw new AutopilotError("Operating-system temporary directory is unavailable", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || isAtOrInside(project.root, parent)) {
    throw new AutopilotError("Operating-system temporary directory is not an external real directory", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  return path.resolve(parent);
}

async function assertPrivateGateRuntime(project, directory) {
  const parent = await trustedGateTempParent(project);
  const target = path.resolve(directory);
  const name = path.basename(target);
  if (
    foldedPath(path.dirname(target)) !== foldedPath(parent) ||
    !new RegExp(`^${gateRuntimePrefix(project)}[A-Za-z0-9]{6}$`).test(name)
  ) {
    throw new AutopilotError("Gate temporary runtime has an invalid location or name", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  const info = await lstat(target);
  const resolved = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || foldedPath(resolved) !== foldedPath(target)) {
    throw new AutopilotError("Gate temporary runtime must be one real directory", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AutopilotError("Gate temporary runtime has a different owner", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
    if ((info.mode & 0o077) !== 0) {
      throw new AutopilotError("Gate temporary runtime must use private mode 0700", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
  }
  return target;
}

async function assertSafeStaleGateTree(root, directory, counter, depth = 0) {
  if (depth > GATE_TEMP_TREE_MAX_DEPTH) {
    throw new AutopilotError("Stale gate runtime exceeds the safe depth limit", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  const entries = await readdir(directory);
  counter.count += entries.length;
  if (counter.count > GATE_TEMP_TREE_MAX_ENTRIES) {
    throw new AutopilotError("Stale gate runtime exceeds the safe entry limit", {
      code: "GATE_TEMP_UNSAFE",
    });
  }
  for (const name of entries) {
    const entry = path.join(directory, name);
    const info = await lstat(entry);
    if (info.isSymbolicLink()) {
      throw new AutopilotError("Stale gate runtime contains a link", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
    if (typeof process.getuid === "function" && process.platform !== "win32" && info.uid !== process.getuid()) {
      throw new AutopilotError("Stale gate runtime contains an entry with a different owner", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
    if (info.isDirectory()) {
      const resolved = await realpath(entry);
      if (!isAtOrInside(root, resolved)) {
        throw new AutopilotError("Stale gate runtime contains an escaping directory", {
          code: "GATE_TEMP_UNSAFE",
        });
      }
      await assertSafeStaleGateTree(root, entry, counter, depth + 1);
    } else if (!info.isFile() || Number(info.nlink) > 1) {
      throw new AutopilotError("Stale gate runtime contains an unsafe file type", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
  }
}

async function removePrivateGateRuntime(project, directory) {
  const target = await assertPrivateGateRuntime(project, directory);
  await assertSafeStaleGateTree(target, target, { count: 0 });
  await rm(target, { recursive: true, force: true });
}

export async function sweepStaleGateRuntimes(project) {
  const parent = await trustedGateTempParent(project);
  const prefix = gateRuntimePrefix(project);
  let scanned = 0;
  let candidates = 0;
  const directoryHandle = await opendir(parent);
  for await (const entry of directoryHandle) {
    scanned += 1;
    if (scanned > GATE_TEMP_PARENT_MAX_ENTRIES) {
      throw new AutopilotError("Operating-system temporary directory exceeds the bounded gate sweep limit", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
    if (!entry.name.startsWith(prefix)) continue;
    candidates += 1;
    if (candidates > GATE_TEMP_RUNTIME_MAX_CANDIDATES) {
      throw new AutopilotError("Too many stale gate runtimes require cleanup", {
        code: "GATE_TEMP_UNSAFE",
      });
    }
    await removePrivateGateRuntime(project, path.join(parent, entry.name));
  }
}

async function createPrivateGateRuntime(project) {
  const parent = await trustedGateTempParent(project);
  const directory = await mkdtemp(path.join(parent, gateRuntimePrefix(project)));
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return assertPrivateGateRuntime(project, directory);
}

function parseDotEnv(text, file) {
  const output = {};
  for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      throw new AutopilotError(`Invalid env assignment in ${file}:${index + 1}`, {
        code: "INVALID_ENV_FILE",
      });
    }
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    output[match[1]] = value;
  }
  return output;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
}

async function readCredentialEnvFile(envFile, profileName) {
  let linkInfo;
  try {
    linkInfo = await lstat(envFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AutopilotError(`Credential env file is missing for profile ${profileName}`, {
        code: "CREDENTIAL_FILE_MISSING",
      });
    }
    throw error;
  }
  if (linkInfo.isSymbolicLink()) {
    throw new AutopilotError(`Credential env file must not be a symbolic link for profile ${profileName}`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  const handle = await open(envFile, "r");
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      Number(info.nlink) > 1 ||
      info.size > 64 * 1024 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (
        process.platform !== "win32" &&
        (
          String(info.dev) !== String(linkInfo.dev) ||
          String(info.ino) !== String(linkInfo.ino)
        )
      )
    ) {
      throw new AutopilotError(`Credential env file must be one stable private regular file of at most 65536 bytes for profile ${profileName}`, {
        code: "CREDENTIAL_FILE_UNSAFE",
        details: {
          path_is_file: linkInfo.isFile(),
          handle_is_file: info.isFile(),
          links: Number(info.nlink),
          size: info.size,
          posix_private: process.platform === "win32" || (info.mode & 0o077) === 0,
          identity_matches:
            process.platform === "win32" ||
            String(info.dev) === String(linkInfo.dev) &&
            String(info.ino) === String(linkInfo.ino),
        },
      });
    }
    const bytes = await handle.readFile();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AutopilotError(`Credential env file must contain valid UTF-8 for profile ${profileName}`, {
        code: "CREDENTIAL_FILE_UNSAFE",
      });
    }
    return {
      text,
      identity: {
        dev: String(linkInfo.dev),
        ino: String(linkInfo.ino),
        size: info.size,
        mtime_ms: linkInfo.mtimeMs,
      },
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

export function gateDefinitionSha256(gate) {
  return sha256(stableJson({
    argv: gate.argv,
    timeout_seconds: gate.timeout_seconds,
    max_output_bytes: gate.max_output_bytes,
    success_codes: gate.success_codes,
    credential_profile: gate.credential_profile ?? null,
    feedback: gate.feedback,
  }));
}

function credentialEnvFilePath(project, profile) {
  return path.isAbsolute(profile.env_file)
    ? path.resolve(profile.env_file)
    : resolveInside(project.root, profile.env_file, "credential env file");
}

async function credentialEnvironment(project, credentials, gateId, profileName, { requiredNames = null } = {}) {
  if (!profileName) return { environment: {}, names: [], secrets: [] };
  const profile = credentials.profiles?.[profileName];
  if (!profile) throw new AutopilotError(`Unknown credential profile ${profileName}`, { code: "UNKNOWN_CREDENTIAL_PROFILE" });
  if (!Array.isArray(profile.allowed_gates) || profile.allowed_gates.length === 0 || !profile.allowed_gates.includes(gateId)) {
    throw new AutopilotError(`Credential profile ${profileName} is not allowlisted for gate ${gateId}`, {
      code: "CREDENTIAL_GATE_DENIED",
    });
  }
  if (!Array.isArray(profile.allow) || profile.allow.length === 0) {
    throw new AutopilotError(`Credential profile ${profileName} has no explicit variable allowlist`, {
      code: "EMPTY_CREDENTIAL_ALLOWLIST",
    });
  }
  for (const name of profile.allow) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isForbiddenCredentialVariable(name)) {
      throw new AutopilotError(`Credential variable ${name} is unsafe for process injection`, {
        code: "CREDENTIAL_VARIABLE_DENIED",
      });
    }
  }
  const selected = requiredNames === null ? [...profile.allow] : [...requiredNames];
  if (new Set(selected).size !== selected.length) {
    throw new AutopilotError("Required credential names must be unique", { code: "CREDENTIAL_VARIABLE_DENIED" });
  }
  for (const name of selected) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isForbiddenCredentialVariable(name) || !profile.allow.includes(name)) {
      throw new AutopilotError(`Credential variable ${name} is not allowed by profile ${profileName}`, {
        code: "CREDENTIAL_VARIABLE_DENIED",
      });
    }
  }
  if (selected.length === 0) return { environment: {}, names: [], secrets: [], freeze: null };
  const envFile = credentialEnvFilePath(project, profile);
  const envFileRead = await readCredentialEnvFile(envFile, profileName);
  const envText = envFileRead.text;
  const parsed = parseDotEnv(envText, envFile);
  const environment = {};
  for (const name of selected) {
    const value = parsed[name];
    if (typeof value !== "string") {
      throw new AutopilotError(`Required credential ${name} is missing from ${profile.env_file}`, {
        code: "CREDENTIAL_FILE_MISSING",
      });
    }
    if (value.length < 4) {
      throw new AutopilotError(`Credential value for ${name} is too short for guaranteed output redaction`, {
        code: "CREDENTIAL_VALUE_TOO_SHORT",
      });
    }
    if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
      throw new AutopilotError(`Credential value for ${name} exceeds the 8192-byte injection cap`, {
        code: "CREDENTIAL_VALUE_TOO_LARGE",
      });
    }
    environment[name] = value;
  }
  const injectedBytes = Object.entries(environment).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 2,
    0,
  );
  if (injectedBytes > GATE_INJECTED_ENV_MAX_BYTES) {
    throw new AutopilotError(
      `Gate credential environment exceeds the portable ${GATE_INJECTED_ENV_MAX_BYTES}-byte cap`,
      { code: "CREDENTIAL_VALUE_TOO_LARGE" },
    );
  }
  return {
    environment,
    names: Object.keys(environment).sort(),
    secrets: Object.values(environment).filter((value) => value.length >= 4),
    freeze: {
      credentials_sha256: sha256(stableJson(credentials)),
      profile_sha256: sha256(stableJson(profile)),
      env_sha256: sha256(envText),
      env_file: envFile,
      profile_name: profileName,
      env_identity: envFileRead.identity,
    },
  };
}

async function configuredCredentialSecretInputs(project, credentials) {
  const files = new Map();
  for (const [profileName, profile] of Object.entries(credentials.profiles ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const envFile = credentialEnvFilePath(project, profile);
    const key = foldedPath(envFile);
    const known = files.get(key);
    if (known) {
      known.profiles.push(profileName);
      continue;
    }
    let info;
    try { info = await lstat(envFile); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      files.set(key, {
        env_file: envFile,
        profiles: [profileName],
        missing: true,
        identity: null,
        env_sha256: null,
        values: [],
      });
      continue;
    }
    if (!info) continue;
    const read = await readCredentialEnvFile(envFile, profileName);
    const parsed = parseDotEnv(read.text, envFile);
    const values = [];
    for (const [name, value] of Object.entries(parsed)) {
      if (value === "") continue;
      if (value.length < 4) {
        throw new AutopilotError(
          `Configured credential value ${name} in ${profile.env_file} is too short for exact gate-output redaction`,
          { code: "CREDENTIAL_VALUE_TOO_SHORT" },
        );
      }
      if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
        throw new AutopilotError(
          `Configured credential value ${name} in ${profile.env_file} exceeds the 8192-byte redaction cap`,
          { code: "CREDENTIAL_VALUE_TOO_LARGE" },
        );
      }
      values.push(value);
    }
    files.set(key, {
      env_file: envFile,
      profiles: [profileName],
      missing: false,
      identity: read.identity,
      env_sha256: sha256(read.text),
      values,
    });
  }
  const secrets = [...new Set([...files.values()].flatMap((entry) => entry.values))];
  const totalBytes = secrets.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  if (secrets.length > GATE_OUTPUT_SECRET_MAX_VALUES || totalBytes > GATE_OUTPUT_SECRET_MAX_BYTES) {
    throw new AutopilotError(
      `Configured credential values exceed the gate-output redaction cap (${secrets.length}/${GATE_OUTPUT_SECRET_MAX_VALUES} values, ${totalBytes}/${GATE_OUTPUT_SECRET_MAX_BYTES} bytes)`,
      { code: "CREDENTIAL_VALUE_TOO_LARGE" },
    );
  }
  return {
    secrets,
    freeze: {
      credentials_sha256: sha256(stableJson(credentials)),
      files: [...files.values()].map(({ values: _values, ...entry }) => ({
        ...entry,
        profiles: [...entry.profiles].sort(),
      })),
    },
  };
}

async function assertConfiguredCredentialSecretInputsUnchanged(project, frozen) {
  const { credentials } = await loadContracts(project, { includeState: false });
  if (sha256(stableJson(credentials)) !== frozen.credentials_sha256) {
    throw new AutopilotError("Credential profile metadata changed while a gate was running", {
      code: "CREDENTIAL_INPUT_CHANGED",
    });
  }
  for (const file of frozen.files) {
    if (file.missing) {
      try {
        await lstat(file.env_file);
        throw new AutopilotError("A configured credential env file appeared while a gate was running", {
          code: "CREDENTIAL_INPUT_CHANGED",
        });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    let current;
    try {
      current = await readCredentialEnvFile(file.env_file, file.profiles.join(","));
    } catch (error) {
      throw new AutopilotError(`Configured credential input changed while a gate was running: ${error.message}`, {
        code: "CREDENTIAL_INPUT_CHANGED",
      });
    }
    if (
      sha256(current.text) !== file.env_sha256 ||
      stableJson(current.identity) !== stableJson(file.identity)
    ) {
      throw new AutopilotError("Configured credential env file changed while a gate was running", {
        code: "CREDENTIAL_INPUT_CHANGED",
      });
    }
  }
}

export async function assertCredentialInputsUnchanged(project, gateId, frozen) {
  if (!frozen) return;
  const { credentials } = await loadContracts(project, { includeState: false });
  const profile = credentials.profiles?.[frozen.profile_name];
  if (
    sha256(stableJson(credentials)) !== frozen.credentials_sha256 ||
    !profile ||
    !Array.isArray(profile.allowed_gates) ||
    !profile.allowed_gates.includes(gateId) ||
    sha256(stableJson(profile)) !== frozen.profile_sha256
  ) {
    throw new AutopilotError("Credential profile metadata changed while its gate was running", {
      code: "CREDENTIAL_INPUT_CHANGED",
    });
  }
  let current;
  try {
    current = await readCredentialEnvFile(frozen.env_file, frozen.profile_name);
  } catch (error) {
    throw new AutopilotError(`Credential env file changed while gate ${gateId} was running: ${error.message}`, {
      code: "CREDENTIAL_INPUT_CHANGED",
    });
  }
  if (
    sha256(current.text) !== frozen.env_sha256 ||
    stableJson(current.identity) !== stableJson(frozen.env_identity)
  ) {
    throw new AutopilotError("Credential env file changed while its gate was running", {
      code: "CREDENTIAL_INPUT_CHANGED",
    });
  }
}

export async function credentialEnvironmentForScope(project, scopeId, profileName, options = {}) {
  if (!profileName) return { environment: {}, names: [], secrets: [], freeze: null };
  const { credentials } = await loadContracts(project, { includeState: false });
  return credentialEnvironment(project, credentials, scopeId, profileName, options);
}

async function sterileGateEnvironment(project, injected) {
  const home = await createPrivateGateRuntime(project);
  const baseEnvironment = await externalExecutionEnv(project.root);
  const roaming = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  const temporary = path.join(home, "tmp");
  const config = path.join(home, ".config");
  const cache = path.join(home, ".cache");
  const data = path.join(home, ".local", "share");
  const state = path.join(home, ".local", "state");
  await Promise.all([
    mkdir(roaming, { recursive: true }),
    mkdir(local, { recursive: true }),
    mkdir(temporary, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(cache, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  return {
    home,
    env: {
      ...baseEnvironment,
      HOME: home,
      USERPROFILE: home,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      ...injected,
      BUN_OPTIONS: "--no-env-file",
    },
  };
}

export async function runGate(root, gateId, {
  taskId = "project",
  attempt = 0,
  feedback = false,
  expectedDefinitionSha256 = null,
} = {}) {
  await preflightProjectRoot(root);
  const project = await loadProject(root);
  await assertControlTopology(project, { createMutable: true });
  const directoryIdentity = {
    runtime: await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory"),
    artifacts: await assertPrivateDirectory(project.root, project.paths.artifacts, "artifacts directory"),
  };
  const { queue, gates, credentials } = await loadContracts(project, { includeState: false });
  const gate = gates.gates?.[gateId];
  if (!gate) throw new AutopilotError(`Unknown gate ${gateId}`, { code: "UNKNOWN_GATE" });
  if (!Array.isArray(gate.argv) || gate.argv.length === 0) throw new AutopilotError(`Gate ${gateId} has no fixed argv`, { code: "INVALID_GATE" });
  const definitionSha256 = gateDefinitionSha256(gate);
  if (feedback) {
    if (gate.feedback !== true) {
      throw new AutopilotError(`Gate ${gateId} is not approved for same-session feedback`, {
        code: "GATE_FEEDBACK_DENIED",
      });
    }
    if (gate.credential_profile != null) {
      throw new AutopilotError(`Credentialed gate ${gateId} cannot run as same-session feedback`, {
        code: "GATE_FEEDBACK_CREDENTIAL_DENIED",
      });
    }
    const task = queue.tasks?.[taskId];
    if (!task || !Array.isArray(task.gates) || !task.gates.includes(gateId)) {
      throw new AutopilotError(`Gate ${gateId} is not assigned to active task ${taskId}`, {
        code: "GATE_FEEDBACK_TASK_DENIED",
      });
    }
    if (
      typeof expectedDefinitionSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedDefinitionSha256) ||
      expectedDefinitionSha256 !== definitionSha256
    ) {
      throw new AutopilotError(`Gate ${gateId} changed after feedback authorization`, {
        code: "GATE_FEEDBACK_DEFINITION_CHANGED",
      });
    }
  } else if (expectedDefinitionSha256 !== null) {
    throw new AutopilotError("A gate definition pin is valid only in feedback mode", {
      code: "GATE_FEEDBACK_DENIED",
    });
  }

  const credentialsForGate = await credentialEnvironment(
    project,
    credentials,
    gateId,
    gate.credential_profile,
  );
  const configuredSecrets = await configuredCredentialSecretInputs(project, credentials);
  const redactionValues = exactSecretVariants(configuredSecrets.secrets, {
    maxSecrets: GATE_OUTPUT_SECRET_MAX_VALUES,
    maxEncodedSecretBytes: 8 * 1024,
  });
  const startedAt = nowIso();
  const started = Date.now();
  const sterile = await sterileGateEnvironment(project, credentialsForGate.environment);
  let raw;
  try {
    raw = await runArgv(gate.argv, {
      cwd: project.root,
      env: sterile.env,
      timeoutMs: gate.timeout_seconds * 1000,
      maxOutputBytes: Math.max(gate.max_output_bytes * 2, gate.max_output_bytes),
      guardProcessTree: true,
    });
  } finally {
    const credentialErrors = [];
    let cleanupError = null;
    try {
      await assertCredentialInputsUnchanged(project, gateId, credentialsForGate.freeze);
    } catch (error) {
      credentialErrors.push(error);
    }
    try {
      await assertConfiguredCredentialSecretInputsUnchanged(project, configuredSecrets.freeze);
    } catch (error) {
      credentialErrors.push(error);
    }
    try {
      if (
        process.env.NODE_ENV === "test" &&
        process.env.AUTOPILOT_TEST_GATE_CLEANUP_FAILURE === "1"
      ) throw new Error("Injected gate cleanup failure");
      await removePrivateGateRuntime(project, sterile.home);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new AutopilotError("Failed gate cleanup left a sterile directory that could contain credentials", {
        code: "GATE_CLEANUP_FAILED",
        details: {
          credential_check_failed: credentialErrors.length > 0,
          cleanup_failed: true,
        },
      });
    }
    if (credentialErrors.length > 0) throw credentialErrors[0];
  }
  const sanitized = sanitizeProcessResult(raw, redactionValues, gate.max_output_bytes);
  if (exactSecretMatches(`${sanitized.stdout}\n${sanitized.stderr}`, configuredSecrets.secrets).length > 0) {
    throw new AutopilotError("Exact configured credential remained in sanitized gate output", {
      code: "SECRET_SCAN_FAILED",
    });
  }
  const success =
    !sanitized.timed_out &&
    !sanitized.output_truncated &&
    gate.success_codes.includes(sanitized.code);
  const credentialed = gate.credential_profile != null;
  // Credentialed output is intentionally opaque. Its content must not affect
  // durable hashes, otherwise transformed secrets become an offline oracle.
  const outputSha256 = credentialed
    ? sha256("credentialed-gate-output-discarded-v1")
    : sha256(`${sanitized.stdout}\n${sanitized.stderr}`);
  const artifact = {
    schema_version: 1,
    gate_id: gateId,
    task_id: taskId,
    attempt,
    started_at: startedAt,
    completed_at: nowIso(),
    duration_ms: Date.now() - started,
    argv_sha256: sha256(JSON.stringify(gate.argv)),
    gate_definition_sha256: definitionSha256,
    credential_profile: gate.credential_profile ?? null,
    injected_environment_names: credentialsForGate.names,
    code: sanitized.code,
    signal: sanitized.signal,
    timed_out: sanitized.timed_out,
    success,
    output_truncated: sanitized.output_truncated,
    output_sha256: outputSha256,
    ...(!credentialed ? {
      stdout: sanitized.stdout,
      stderr: sanitized.stderr,
    } : {}),
  };
  const currentDirectoryIdentity = {
    runtime: await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory"),
    artifacts: await assertPrivateDirectory(project.root, project.paths.artifacts, "artifacts directory"),
  };
  if (stableJson(currentDirectoryIdentity) !== stableJson(directoryIdentity)) {
    throw new AutopilotError("Gate changed a mutable control directory identity", {
      code: "CONTROL_DIRECTORY_UNSAFE",
    });
  }
  const filename = `${startedAt.replace(/[:.]/g, "-")}-${safeName(taskId)}-${safeName(gateId)}-a${attempt}.json`;
  const artifactFile = path.join(project.paths.artifacts, filename);
  await atomicWriteJson(artifactFile, artifact);
  return {
    gate_id: gateId,
    success,
    code: sanitized.code,
    timed_out: sanitized.timed_out,
    duration_ms: artifact.duration_ms,
    artifact: normalizeRelative(path.relative(project.root, artifactFile)),
    gate_definition_sha256: definitionSha256,
    fingerprint: sha256(JSON.stringify({
      gateId,
      code: sanitized.code,
      timedOut: sanitized.timed_out,
      outputTruncated: sanitized.output_truncated,
      ...(credentialed ? { output: "discarded" } : {
        stdout: sanitized.stdout,
        stderr: sanitized.stderr,
      }),
    })),
    ...(!success && !credentialed ? {
      diagnostic: {
        stdout: truncateUtf8(sanitized.stdout, 2048),
        stderr: truncateUtf8(sanitized.stderr, 2048),
        output_truncated: sanitized.output_truncated,
      },
    } : {}),
  };
}

export async function runGates(root, gateIds, options = {}) {
  const results = [];
  for (const gateId of gateIds) {
    const result = await runGate(root, gateId, options);
    results.push(result);
    if (!result.success) break;
  }
  return { success: results.length === gateIds.length && results.every((item) => item.success), results };
}
