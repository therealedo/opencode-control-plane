import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, assertPrivateFile, AutopilotError, normalizeRelative, sha256, stableJson, truncateUtf8 } from "./core.mjs";
import {
  assertCredentialInputsUnchanged,
  credentialEnvironmentForScope,
  gateDefinitionSha256,
} from "./gate-runner.mjs";
import { readRevisionFile } from "./git.mjs";
import {
  boundedProviderEnvironment,
  isForbiddenCredentialVariable,
  validateMcpDescriptors,
} from "./mcp.mjs";
import { loadContracts } from "./project.mjs";
import {
  assertExternalLaunchArguments,
  externalExecutionEnv,
  resolveExternalExecutable,
  resolveExternalGitExecutable,
  resolveExternalInvocation,
  runArgv,
  sanitizeProcessResult,
} from "./process.mjs";
import {
  renderManagedToolBlock,
  resolveTaskPhaseCapabilities,
  validateRoleToolPolicy,
} from "./tool-grants.mjs";
import { exactSecretMatches } from "./secrets.mjs";

const PHASE_TOOL_RETURNED_BYTES = 64 * 1024;
const MAX_FEEDBACK_CALLS = 2;
const MAX_PHASE_MODEL_COST = 1_000_000;
const MAX_PHASE_EXACT_SECRETS = 128;
const GATE_RUNNER_SNAPSHOT = Object.freeze([
  "run-gate.mjs",
  "process-guard.mjs",
  "windows-job-guard.ps1",
  "lib/commit-policy.mjs",
  "lib/core.mjs",
  "lib/contracts.mjs",
  "lib/gate-runner.mjs",
  "lib/mcp.mjs",
  "lib/process.mjs",
  "lib/project.mjs",
  "lib/runtime-settings.mjs",
  "lib/secrets.mjs",
  "lib/state.mjs",
  "lib/tool-grants.mjs",
]);
const observedSessionIds = new Set();
const ephemeralPhaseSecrets = new WeakMap();
const reusesSession = (argument) => /^(?:--(?:continue|session|fork)(?:=|$)|-[cs](?:=|$))/.test(argument);
const OPEN_CODE_TEMP_TREE_MAX_ENTRIES = 100_000;
const OPEN_CODE_TEMP_TREE_MAX_DEPTH = 64;
const OPEN_CODE_TEMP_PARENT_MAX_ENTRIES = 100_000;
const OPEN_CODE_TEMP_RUNTIME_MAX_CANDIDATES = 64;
const GENERIC_PROJECT_ARGUMENT_EXECUTABLE = new Set([
  "bash", "bun", "bunx", "busybox", "cargo", "cmd", "command", "deno", "direnv", "doas",
  "dotnet", "env", "fish", "go", "java", "mise", "nice", "node", "nodejs", "nohup", "npm",
  "npx", "perl", "php", "pipx", "pnpm", "powershell", "pwsh", "python", "ruby", "rye",
  "setsid", "sh", "sudo", "tsx", "ts-node", "uv", "uvx", "xargs", "yarn", "zsh",
]);

function foldedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isAtOrInside(root, candidate) {
  const rootValue = foldedPath(root);
  const candidateValue = foldedPath(candidate);
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}${path.sep}`);
}

function openCodeRuntimePrefix(project, kind) {
  const rootIdentity = process.platform === "win32"
    ? path.resolve(project.root).toLocaleLowerCase("en-US")
    : path.resolve(project.root);
  return `autopilot-${sha256(rootIdentity).slice(0, 16)}-opencode-${kind}-`;
}

async function trustedOpenCodeTempParent(project) {
  const configured = os.tmpdir();
  if (!path.isAbsolute(configured)) {
    throw new AutopilotError("Operating-system temporary directory must be absolute", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  let parent;
  try { parent = await realpath(configured); }
  catch {
    throw new AutopilotError("Operating-system temporary directory is unavailable", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || isAtOrInside(project.root, parent)) {
    throw new AutopilotError("Operating-system temporary directory is not an external real directory", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  return path.resolve(parent);
}

async function assertPrivateOpenCodeRuntime(project, directory, kind = null) {
  const parent = await trustedOpenCodeTempParent(project);
  const target = path.resolve(directory);
  const name = path.basename(target);
  const kinds = kind ? [kind] : ["phase", "probe"];
  if (
    foldedPath(path.dirname(target)) !== foldedPath(parent) ||
    !kinds.some((candidate) => new RegExp(`^${openCodeRuntimePrefix(project, candidate)}[A-Za-z0-9]{6}$`).test(name))
  ) {
    throw new AutopilotError("OpenCode temporary runtime has an invalid location or name", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  const info = await lstat(target);
  const resolved = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || foldedPath(resolved) !== foldedPath(target)) {
    throw new AutopilotError("OpenCode temporary runtime must be one real directory", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AutopilotError("OpenCode temporary runtime has a different owner", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
    if ((info.mode & 0o077) !== 0) {
      throw new AutopilotError("OpenCode temporary runtime must use private mode 0700", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
  }
  return target;
}

async function createPrivateOpenCodeRuntime(project, kind) {
  const parent = await trustedOpenCodeTempParent(project);
  const directory = await mkdtemp(path.join(parent, openCodeRuntimePrefix(project, kind)));
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return assertPrivateOpenCodeRuntime(project, directory, kind);
}

function staleSecretPath(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const protectedPaths = [
    "phase-secrets",
    "xdg-data/opencode/auth.json",
    "xdg-data/opencode/mcp-auth.json",
  ];
  return protectedPaths.some((candidate) =>
    normalized === candidate || normalized.startsWith(`${candidate}/`) || candidate.startsWith(`${normalized}/`)
  );
}

async function assertSafeStaleTree(root, directory, counter, depth = 0, relative = "") {
  if (depth > OPEN_CODE_TEMP_TREE_MAX_DEPTH) {
    throw new AutopilotError("Stale OpenCode temporary runtime exceeds the safe depth limit", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  const entries = await readdir(directory);
  counter.count += entries.length;
  if (counter.count > OPEN_CODE_TEMP_TREE_MAX_ENTRIES) {
    throw new AutopilotError("Stale OpenCode temporary runtime exceeds the safe entry limit", {
      code: "OPENCODE_TEMP_UNSAFE",
    });
  }
  for (const name of entries) {
    const entry = path.join(directory, name);
    const entryRelative = relative ? `${relative}/${name}` : name;
    const info = await lstat(entry);
    if (info.isSymbolicLink()) {
      if (staleSecretPath(entryRelative)) {
        throw new AutopilotError("Stale OpenCode secret runtime contains a symbolic link", {
          code: "OPENCODE_TEMP_UNSAFE",
        });
      }
      continue;
    }
    if (typeof process.getuid === "function" && process.platform !== "win32" && info.uid !== process.getuid()) {
      throw new AutopilotError("Stale OpenCode temporary runtime contains an entry with a different owner", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
    if (info.isDirectory()) {
      const resolved = await realpath(entry);
      if (!isAtOrInside(root, resolved)) {
        throw new AutopilotError("Stale OpenCode temporary runtime contains an escaping directory", {
          code: "OPENCODE_TEMP_UNSAFE",
        });
      }
      await assertSafeStaleTree(root, entry, counter, depth + 1, entryRelative);
    } else if (!info.isFile() || (Number(info.nlink) > 1 && staleSecretPath(entryRelative))) {
      throw new AutopilotError("Stale OpenCode temporary runtime contains an unsafe file identity", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
  }
}

export async function sweepStaleOpenCodeRuntimes(project) {
  const parent = await trustedOpenCodeTempParent(project);
  const prefixes = [openCodeRuntimePrefix(project, "phase"), openCodeRuntimePrefix(project, "probe")];
  let scanned = 0;
  let candidates = 0;
  const directoryHandle = await opendir(parent);
  for await (const entry of directoryHandle) {
    scanned += 1;
    if (scanned > OPEN_CODE_TEMP_PARENT_MAX_ENTRIES) {
      throw new AutopilotError("Operating-system temporary directory exceeds the bounded sweep limit", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    candidates += 1;
    if (candidates > OPEN_CODE_TEMP_RUNTIME_MAX_CANDIDATES) {
      throw new AutopilotError("Too many stale OpenCode temporary runtimes require cleanup", {
        code: "OPENCODE_TEMP_UNSAFE",
      });
    }
    const directory = path.join(parent, entry.name);
    await assertPrivateOpenCodeRuntime(project, directory);
    await assertSafeStaleTree(directory, directory, { count: 0 });
    await rm(directory, { recursive: true, force: true });
  }
}

function parseSessionId(output) {
  const found = new Set();
  for (const line of output.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (!plainObject(event) || !Object.hasOwn(event, "sessionID")) continue;
    if (typeof event.sessionID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event.sessionID)) {
      throw new AutopilotError("Fresh OpenCode output contained an invalid top-level sessionID", {
        code: "OPENCODE_SESSION_ID_INVALID",
      });
    }
    found.add(event.sessionID);
  }
  if (found.size === 0) {
    throw new AutopilotError("Fresh OpenCode output did not identify its session in a top-level event.sessionID", {
      code: "OPENCODE_SESSION_ID_MISSING",
    });
  }
  if (found.size !== 1) {
    throw new AutopilotError("Fresh OpenCode output identified multiple distinct sessions", {
      code: "OPENCODE_SESSION_ID_INVALID",
    });
  }
  return [...found][0];
}

function parseModelUsage(output, sessionId) {
  const seenParts = new Map();
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
  };
  let observed = false;
  let lineNumber = 0;
  for (const line of output.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch {
      throw new AutopilotError("Fresh OpenCode JSON output contains malformed telemetry", {
        code: "OPENCODE_USAGE_INVALID",
        details: { line: lineNumber },
      });
    }
    if (
      !plainObject(event) || typeof event.type !== "string" || !event.type ||
      typeof event.sessionID !== "string" || event.sessionID !== sessionId
    ) {
      throw new AutopilotError("Fresh OpenCode JSON output has an invalid telemetry envelope", {
        code: "OPENCODE_USAGE_INVALID",
        details: { line: lineNumber },
      });
    }
    if (event.type !== "step_finish") continue;
    const part = event.part;
    if (
      !plainObject(part) || part.type !== "step-finish" || part.sessionID !== sessionId ||
      typeof part.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(part.id) ||
      typeof part.messageID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(part.messageID) ||
      !plainObject(part.tokens) || !plainObject(part.tokens.cache) ||
      typeof part.cost !== "number" || !Number.isFinite(part.cost) ||
      part.cost < 0 || part.cost > MAX_PHASE_MODEL_COST
    ) {
      throw new AutopilotError("Fresh OpenCode step-finish telemetry is invalid", {
        code: "OPENCODE_USAGE_INVALID",
        details: { line: lineNumber },
      });
    }
    const values = {
      input_tokens: part.tokens.input,
      output_tokens: part.tokens.output,
      reasoning_tokens: part.tokens.reasoning,
      cache_read_tokens: part.tokens.cache.read,
      cache_write_tokens: part.tokens.cache.write,
    };
    if (
      Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      (part.tokens.total !== undefined && (!Number.isSafeInteger(part.tokens.total) || part.tokens.total < 0))
    ) {
      throw new AutopilotError("Fresh OpenCode token dimensions are invalid", {
        code: "OPENCODE_USAGE_INVALID",
        details: { line: lineNumber, part_id: part.id },
      });
    }
    const fingerprint = JSON.stringify({
      session_id: sessionId,
      part_id: part.id,
      message_id: part.messageID,
      values,
      cost: part.cost,
      total: part.tokens.total ?? null,
    });
    if (seenParts.has(part.id)) {
      if (seenParts.get(part.id) !== fingerprint) {
        throw new AutopilotError("Fresh OpenCode reused a telemetry part ID with conflicting usage", {
          code: "OPENCODE_USAGE_INVALID",
          details: { line: lineNumber, part_id: part.id },
        });
      }
      continue;
    }
    const nextCost = totals.cost + part.cost;
    const nextTokens = Object.fromEntries(
      Object.keys(values).map((field) => [field, totals[field] + values[field]]),
    );
    if (
      !Number.isFinite(nextCost) || nextCost > MAX_PHASE_MODEL_COST ||
      Object.values(nextTokens).some((value) => !Number.isSafeInteger(value))
    ) {
      throw new AutopilotError("Fresh OpenCode usage aggregation overflowed its phase boundary", {
        code: "OPENCODE_USAGE_INVALID",
        details: { line: lineNumber, part_id: part.id },
      });
    }
    seenParts.set(part.id, fingerprint);
    Object.assign(totals, nextTokens, { cost: nextCost });
    observed = true;
  }
  return observed ? totals : null;
}

function replaceCredentialReferences(value, secretFiles) {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
      const file = secretFiles.get(name);
      if (!file) throw new AutopilotError(`Selected MCP requires unavailable phase credential ${name}`, { code: "CREDENTIAL_VARIABLE_DENIED" });
      return `{file:${file.replaceAll("\\", "/")}}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => replaceCredentialReferences(item, secretFiles));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceCredentialReferences(item, secretFiles)]));
  }
  return value;
}

async function trustedOpenCodeCommand(project) {
  const environment = await externalExecutionEnv(project.root);
  const configured = [...project.config.opencode.command];
  await assertExternalLaunchArguments(project.root, configured.slice(1), {
    label: "OpenCode launch argument",
  });
  configured[0] = await resolveExternalExecutable(
    project.root,
    configured[0],
    environment,
    { label: "OpenCode executable" },
  );
  return { command: configured, environment };
}

const AUTH_SECRET_FIELD = /^(?:key|api[_-]?key|token|access(?:[_-]?token)?|refresh(?:[_-]?token)?|id[_-]?token|client[_-]?secret|password|secret|credential|authorization[_-]?code|code[_-]?verifier|oauth[_-]?state)$/i;
const AUTH_PUBLIC_METADATA_FIELD = /^(?:type|kind|method|status|provider(?:[_-]?id)?|account(?:[_-]?id)?|client[_-]?id|email|name|label|scope|scopes|expires|expires[_-]?(?:at|in)|expiration|server[_-]?url|url|redirect[_-]?uri|resource|audience|token[_-]?type|grant[_-]?type)$/i;

function appendAuthSecret(output, value, field) {
  if (!value) return;
  if (value.length < 4) {
    throw new AutopilotError(
      `OpenCode auth secret-bearing field ${field} is too short for guaranteed redaction`,
      { code: "CREDENTIAL_VALUE_TOO_SHORT" },
    );
  }
  output.push(value);
}

function authSecretValues(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") appendAuthSecret(output, item, "array item");
      else authSecretValues(item, output);
    }
  } else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === "string") {
        if (AUTH_SECRET_FIELD.test(name) || !AUTH_PUBLIC_METADATA_FIELD.test(name)) {
          appendAuthSecret(output, item, name);
        }
      } else if (Array.isArray(item)) {
        if (AUTH_PUBLIC_METADATA_FIELD.test(name)) {
          for (const nested of item) if (nested && typeof nested === "object") authSecretValues(nested, output);
        } else {
          authSecretValues(item, output);
        }
      } else if (item && typeof item === "object") {
        authSecretValues(item, output);
      }
    }
  }
  return output;
}

function exposedPhaseSecretInputs({
  credentials,
  providerSecrets,
  providerAuth,
  sourceMcpAuth,
  selectedNames,
}) {
  const selectedMcpAuth = sourceMcpAuth
    ? Object.fromEntries(
        selectedNames
          .filter((name) => Object.hasOwn(sourceMcpAuth.value, name))
          .map((name) => [name, sourceMcpAuth.value[name]]),
      )
    : {};
  const ordered = [
    ...credentials.secrets,
    ...providerSecrets,
    ...(providerAuth ? authSecretValues(providerAuth.value) : []),
    ...authSecretValues(selectedMcpAuth),
  ].filter((value) => typeof value === "string" && value.length >= 4);
  const secrets = [...new Set(ordered)];
  if (secrets.length > MAX_PHASE_EXACT_SECRETS) {
    throw new AutopilotError(
      `OpenCode phase exposes ${secrets.length} distinct secret-bearing values; cap is ${MAX_PHASE_EXACT_SECRETS}`,
      { code: "CREDENTIAL_VALUE_TOO_LARGE" },
    );
  }
  return { secrets, selectedMcpAuth };
}

export function assertPhasePromptHasNoSecrets(prompt, secrets, phase = "OpenCode") {
  const matches = exactSecretMatches(prompt, secrets);
  if (matches.length === 0) return;
  throw new AutopilotError(
    `${phase} context packet contains an exact phase credential representation and cannot be dispatched`,
    {
      code: "SECRET_SCAN_FAILED",
      details: {
        match_count: matches.length,
        locations: matches.map((match) => match.index),
        values: "intentionally omitted",
      },
    },
  );
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function feedbackGatePolicy(task, gates, phase) {
  const selected = {};
  if (phase === "review") return selected;
  for (const gateId of task.gates ?? []) {
    const gate = gates.gates?.[gateId];
    if (gate?.feedback !== true) continue;
    if (gate.credential_profile != null) {
      throw new AutopilotError(`Credentialed gate ${gateId} cannot be exposed for phase feedback`, {
        code: "PROJECT_INVALID",
      });
    }
    selected[gateId] = {
      definition_sha256: gateDefinitionSha256(gate),
      timeout_seconds: gate.timeout_seconds,
    };
  }
  return selected;
}

function renderFeedbackToolPermission(agentText, allowed) {
  const expression = /^  autopilot_check: (?:allow|deny)$/gm;
  const matches = [...agentText.matchAll(expression)];
  if (matches.length !== 1) {
    throw new AutopilotError("Phase role must declare exactly one autopilot_check permission", {
      code: "PROJECT_INVALID",
    });
  }
  return agentText.replace(expression, `  autopilot_check: ${allowed ? "allow" : "deny"}`);
}

function validateLocalMcpEnvironment(server, serverName, providerNames) {
  const configured = server.environment ?? {};
  if (!plainObject(configured)) {
    throw new AutopilotError(`Local MCP ${serverName} environment must be an object`, {
      code: "PROJECT_INVALID",
    });
  }
  for (const [name, value] of Object.entries(configured)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== "string" ||
      isForbiddenCredentialVariable(name) ||
      providerNames.some((candidate) => candidate.toUpperCase() === name.toUpperCase())
    ) {
      throw new AutopilotError(
        `Local MCP ${serverName} cannot override reserved environment variable ${name}`,
        { code: "PROJECT_INVALID" },
      );
    }
  }
  return configured;
}

async function readPrivateJsonOptional(file, maxBytes, label, { requirePrivateMode = false } = {}) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > maxBytes) {
    throw new AutopilotError(`${label} must be one private regular JSON file of at most ${maxBytes} bytes`, { code: "CREDENTIAL_FILE_UNSAFE" });
  }
  if (requirePrivateMode && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new AutopilotError(`${label} must not grant group or other POSIX permissions (use mode 0600)`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  const raw = await readFile(file, "utf8");
  try {
    const value = JSON.parse(raw);
    if (!plainObject(value)) {
      throw new Error("top-level value must be an object");
    }
    return { raw, value };
  }
  catch { throw new AutopilotError(`${label} is invalid JSON`, { code: "CREDENTIAL_FILE_UNSAFE" }); }
}

function emptyToolUsage(phase, taskId) {
  return { schema_version: 1, phase, task_id: taskId, tool_calls: 0, returned_bytes: 0, by_tool: {} };
}

async function readToolUsage(file, phase, taskId) {
  const loaded = await readPrivateJsonOptional(file, 16 * 1024, "OpenCode phase tool usage");
  if (!loaded) return emptyToolUsage(phase, taskId);
  const value = loaded.value;
  const validCounter = (candidate, maximum) => Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum;
  if (
    value?.schema_version !== 1 || value.phase !== phase || value.task_id !== taskId ||
    !hasOnlyKeys(value, ["schema_version", "phase", "task_id", "tool_calls", "returned_bytes", "by_tool"]) ||
    !validCounter(value.tool_calls, 10000) ||
    !validCounter(value.returned_bytes, PHASE_TOOL_RETURNED_BYTES) ||
    !plainObject(value.by_tool) || Object.keys(value.by_tool).length > 8
  ) throw new AutopilotError("OpenCode phase tool usage is invalid", { code: "OPENCODE_TOOL_USAGE_INVALID" });
  for (const [name, counters] of Object.entries(value.by_tool)) {
    if (
      !["read", "list", "search", "write", "edit", "mutate", "check", "contract"].includes(name) ||
      !plainObject(counters) || !hasOnlyKeys(counters, ["calls", "returned_bytes"]) ||
      !validCounter(counters.calls, value.tool_calls) ||
      !validCounter(counters.returned_bytes, value.returned_bytes)
    ) throw new AutopilotError("OpenCode phase tool usage is invalid", { code: "OPENCODE_TOOL_USAGE_INVALID" });
  }
  const totals = Object.values(value.by_tool).reduce(
    (result, counters) => ({ calls: result.calls + counters.calls, bytes: result.bytes + counters.returned_bytes }),
    { calls: 0, bytes: 0 },
  );
  if (totals.calls !== value.tool_calls || totals.bytes !== value.returned_bytes) {
    throw new AutopilotError("OpenCode phase tool usage totals are inconsistent", { code: "OPENCODE_TOOL_USAGE_INVALID" });
  }
  return value;
}

function sourceDataDirectory() {
  const configured = process.env.AUTOPILOT_SOURCE_DATA_HOME ||
    process.env.XDG_DATA_HOME ||
    path.join(os.homedir(), ".local", "share");
  if (!path.isAbsolute(configured)) {
    throw new AutopilotError("The OpenCode source data home must be an absolute path", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  return path.join(path.resolve(configured), "opencode");
}

function providerSelection(settings) {
  const model = settings?.model;
  if (
    typeof model !== "string" ||
    Buffer.byteLength(model, "utf8") > 256 ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@/-]+$/.test(model)
  ) {
    throw new AutopilotError("OpenCode requires one fixed provider/model identifier", {
      code: "PROJECT_INVALID",
    });
  }
  const providerId = model.slice(0, model.indexOf("/"));
  const authMode = settings.provider_auth_mode;
  if (!["auth_file", "environment", "none"].includes(authMode)) {
    throw new AutopilotError("OpenCode provider auth mode must be auth_file, environment, or none", {
      code: "PROJECT_INVALID",
    });
  }
  const providerNames = settings.provider_environment ?? [];
  if (authMode === "environment" && providerNames.length === 0) {
    throw new AutopilotError("Environment provider auth mode requires explicit provider variable names", {
      code: "PROJECT_INVALID",
    });
  }
  if (authMode !== "environment" && providerNames.length !== 0) {
    throw new AutopilotError("Provider variables are allowed only in environment auth mode", {
      code: "PROJECT_INVALID",
    });
  }
  return { model, providerId, authMode };
}

function exactAuthKeys(value, required, optional, label) {
  if (!plainObject(value)) {
    throw new AutopilotError(`${label} must be an object`, { code: "CREDENTIAL_FILE_UNSAFE" });
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new AutopilotError(`${label} does not match the supported exact schema`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
}

function boundedAuthString(value, label, { minimum = 1, maximum = 8192 } = {}) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < minimum ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new AutopilotError(`${label} must be bounded single-line text`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  return value;
}

function validateProviderAuthEntry(value, label) {
  if (!plainObject(value) || typeof value.type !== "string") {
    throw new AutopilotError(`${label} does not match a supported OpenCode auth entry`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  if (value.type === "wellknown") {
    throw new AutopilotError(
      "OpenCode well-known authentication is forbidden because it can inject remote configuration",
      { code: "CREDENTIAL_FILE_UNSAFE" },
    );
  }
  if (value.type === "api") {
    exactAuthKeys(value, ["type", "key"], ["metadata"], label);
    boundedAuthString(value.key, `${label}.key`, { minimum: 4 });
    if (value.metadata !== undefined) {
      if (!plainObject(value.metadata) || Object.keys(value.metadata).length > 64) {
        throw new AutopilotError(`${label}.metadata must be a bounded string map`, {
          code: "CREDENTIAL_FILE_UNSAFE",
        });
      }
      for (const [name, item] of Object.entries(value.metadata)) {
        boundedAuthString(name, `${label}.metadata key`, { maximum: 256 });
        boundedAuthString(item, `${label}.metadata.${name}`, { maximum: 2048 });
      }
    }
    return structuredClone(value);
  }
  if (value.type === "oauth") {
    exactAuthKeys(
      value,
      ["type", "refresh", "access", "expires"],
      ["accountId", "enterpriseUrl"],
      label,
    );
    boundedAuthString(value.refresh, `${label}.refresh`, { minimum: 4 });
    boundedAuthString(value.access, `${label}.access`, { minimum: 4 });
    if (!Number.isSafeInteger(value.expires) || value.expires < 0) {
      throw new AutopilotError(`${label}.expires must be a non-negative safe integer`, {
        code: "CREDENTIAL_FILE_UNSAFE",
      });
    }
    if (value.accountId !== undefined) boundedAuthString(value.accountId, `${label}.accountId`, { maximum: 2048 });
    if (value.enterpriseUrl !== undefined) boundedAuthString(value.enterpriseUrl, `${label}.enterpriseUrl`, { maximum: 2048 });
    return structuredClone(value);
  }
  throw new AutopilotError(`${label} uses an unsupported OpenCode auth type`, {
    code: "CREDENTIAL_FILE_UNSAFE",
  });
}

function validateProviderAuthDocument(value, label = "OpenCode provider auth") {
  if (!plainObject(value) || Object.keys(value).length > 128) {
    throw new AutopilotError(`${label} must map at most 128 provider IDs to auth entries`, {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  const normalized = {};
  for (const [providerId, entry] of Object.entries(value)) {
    boundedAuthString(providerId, `${label} provider ID`, { maximum: 256 });
    normalized[providerId] = validateProviderAuthEntry(entry, `${label}.${providerId}`);
  }
  return normalized;
}

function sameSourceIdentity(left, right) {
  return String(left.ino) === String(right.ino) && (
    process.platform === "win32" || String(left.dev) === String(right.dev)
  );
}

async function readProviderAuthSource(file) {
  let before;
  try { before = await lstat(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (
    !before.isFile() || before.isSymbolicLink() || Number(before.nlink) > 1 ||
    before.size > 1024 * 1024 ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new AutopilotError("OpenCode provider auth must be one private regular JSON file", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  const raw = await readFile(file, "utf8");
  const after = await lstat(file);
  if (!sameSourceIdentity(before, after) || after.size !== Buffer.byteLength(raw, "utf8")) {
    throw new AutopilotError("OpenCode provider auth changed while it was being read", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new AutopilotError("OpenCode provider auth is invalid JSON", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  return {
    file,
    raw,
    value: validateProviderAuthDocument(parsed),
    identity: { dev: String(after.dev), ino: String(after.ino) },
    sha256: sha256(raw),
  };
}

function parseAuthContent(raw) {
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
    throw new AutopilotError("OPENCODE_AUTH_CONTENT exceeds the 1048576-byte cap", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  try {
    return validateProviderAuthDocument(JSON.parse(raw), "OPENCODE_AUTH_CONTENT");
  } catch (error) {
    if (error instanceof AutopilotError) throw error;
    throw new AutopilotError("OPENCODE_AUTH_CONTENT is invalid JSON", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
}

async function resolvePhaseConfiguration(project, phase, taskId, baseline) {
  const contracts = await loadContracts(project, { includeState: false });
  const task = contracts.queue.tasks?.[taskId];
  if (!task) throw new AutopilotError(`Unknown OpenCode task ${taskId}`, { code: "UNKNOWN_TASK" });
  const openCodeFile = path.join(project.root, "opencode.jsonc");
  const toolPolicyFile = path.join(project.root, ".project", "tools.json");
  await Promise.all([
    assertPrivateFile(project.root, openCodeFile, "project OpenCode configuration"),
    assertPrivateFile(project.root, toolPolicyFile, "project OpenCode tool policy"),
  ]);
  let projectOpenCode;
  let toolPolicy;
  try {
    projectOpenCode = JSON.parse(await readFile(openCodeFile, "utf8"));
    toolPolicy = validateRoleToolPolicy(JSON.parse(await readFile(toolPolicyFile, "utf8")));
    const configuredMcp = projectOpenCode.mcp ?? {};
    const canonicalMcp = validateMcpDescriptors(configuredMcp, {
      location: "opencode.jsonc.mcp",
      providerEnvironment: project.config.opencode?.provider_environment ?? [],
    });
    if (stableJson(configuredMcp) !== stableJson(canonicalMcp)) {
      throw new Error("opencode.jsonc.mcp is not in canonical form");
    }
    const baselineOpenCode = JSON.parse(await readRevisionFile(
      project.root,
      baseline,
      "opencode.jsonc",
      256 * 1024,
    ));
    const baselineMcp = validateMcpDescriptors(baselineOpenCode.mcp ?? {}, {
      location: "committed opencode.jsonc.mcp",
      providerEnvironment: project.config.opencode?.provider_environment ?? [],
    });
    if (stableJson(canonicalMcp) !== stableJson(baselineMcp)) {
      throw new Error("opencode.jsonc.mcp changed from the controller task baseline");
    }
    projectOpenCode = { ...projectOpenCode, mcp: canonicalMcp };
  } catch (error) {
    throw new AutopilotError(`OpenCode phase configuration is invalid: ${error.message}`, { code: "PROJECT_INVALID" });
  }
  let capabilities;
  try {
    capabilities = resolveTaskPhaseCapabilities({
      toolPolicy,
      task,
      phase,
      mcp: projectOpenCode.mcp ?? {},
    });
  } catch (error) {
    throw new AutopilotError(`OpenCode task capability policy is invalid: ${error.message}`, { code: "PROJECT_INVALID" });
  }
  return { task, gates: contracts.gates, projectOpenCode, capabilities };
}

async function snapshotGateRunner(project, sterile) {
  const sourceRoot = path.join(project.root, ".autopilot", "bin");
  const targetRoot = path.join(sterile, "gate-runner");
  await mkdir(path.join(targetRoot, "lib"), { recursive: true });
  for (const relative of GATE_RUNNER_SNAPSHOT) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    const target = path.join(targetRoot, ...relative.split("/"));
    await assertPrivateFile(project.root, source, `feedback runner ${relative}`);
    await copyFile(source, target);
    await assertPrivateFile(sterile, target, `feedback runner snapshot ${relative}`);
  }
  return path.join(targetRoot, "run-gate.mjs");
}

async function loadProviderInputs(settings) {
  const selection = providerSelection(settings);
  let providerEnvironment;
  try {
    providerEnvironment = boundedProviderEnvironment(
      selection.authMode === "environment" ? settings.provider_environment : [],
      process.env,
    );
  } catch (error) {
    throw new AutopilotError(error.message, { code: error.code ?? "CREDENTIAL_FILE_UNSAFE" });
  }
  const providerSecrets = Object.values(providerEnvironment)
    .filter((value) => value.length >= 4);

  const sourceData = sourceDataDirectory();
  let providerAuth = null;
  if (selection.authMode === "auth_file") {
    const source = await readProviderAuthSource(path.join(sourceData, "auth.json"));
    const content = process.env.OPENCODE_AUTH_CONTENT
      ? parseAuthContent(process.env.OPENCODE_AUTH_CONTENT)
      : null;
    const selectedDocument = content ?? source?.value ?? null;
    const selectedEntry = selectedDocument?.[selection.providerId];
    if (!selectedEntry) {
      throw new AutopilotError(
        `OpenCode auth_file mode requires the exact ${selection.providerId} provider entry`,
        { code: "CREDENTIAL_FILE_MISSING" },
      );
    }
    if (selectedEntry.type === "oauth") {
      if (!source || stableJson(source.value[selection.providerId]) !== stableJson(selectedEntry)) {
        throw new AutopilotError(
          "OAuth provider auth requires a matching private source auth.json for refresh-token writeback",
          { code: "CREDENTIAL_FILE_UNSAFE" },
        );
      }
    }
    const value = { [selection.providerId]: structuredClone(selectedEntry) };
    providerAuth = {
      raw: `${JSON.stringify(value, null, 2)}\n`,
      value,
      provider_id: selection.providerId,
      selected_entry: structuredClone(selectedEntry),
      source: selectedEntry.type === "oauth" ? source : null,
    };
  }
  const sourceMcpAuth = await readPrivateJsonOptional(
    path.join(sourceData, "mcp-auth.json"),
    1024 * 1024,
    "OpenCode MCP auth",
    { requirePrivateMode: true },
  );
  return { ...selection, providerEnvironment, providerSecrets, providerAuth, sourceMcpAuth };
}

async function assertProviderAuthSourceCas(source) {
  const current = await readProviderAuthSource(source.file);
  if (
    !current ||
    !sameSourceIdentity(source.identity, current.identity) ||
    source.sha256 !== current.sha256
  ) {
    throw new AutopilotError(
      "OpenCode provider auth changed concurrently; OAuth rotation was not merged",
      { code: "CREDENTIAL_FILE_CHANGED" },
    );
  }
  return current;
}

async function reconcileSterileProviderAuth(providerAuth, sterileAuthFile) {
  let sterile;
  try {
    sterile = await readPrivateJsonOptional(
      sterileAuthFile,
      1024 * 1024,
      "sterile OpenCode provider auth",
      { requirePrivateMode: true },
    );
  } catch (error) {
    throw error;
  }
  if (!providerAuth) {
    if (sterile) {
      throw new AutopilotError("OpenCode created unexpected provider auth in a non-file auth mode", {
        code: "CREDENTIAL_FILE_UNSAFE",
      });
    }
    return [];
  }
  if (!sterile) {
    throw new AutopilotError("OpenCode removed the selected provider auth entry during a phase", {
      code: "CREDENTIAL_FILE_CHANGED",
    });
  }
  const document = validateProviderAuthDocument(sterile.value, "sterile OpenCode provider auth");
  const keys = Object.keys(document);
  if (keys.length !== 1 || keys[0] !== providerAuth.provider_id) {
    throw new AutopilotError("OpenCode sterile auth escaped the selected provider boundary", {
      code: "CREDENTIAL_FILE_UNSAFE",
    });
  }
  const rotated = document[providerAuth.provider_id];
  const rotatedSecrets = authSecretValues(rotated);
  if (providerAuth.selected_entry.type !== "oauth") {
    if (stableJson(rotated) !== stableJson(providerAuth.selected_entry)) {
      throw new AutopilotError("OpenCode unexpectedly changed non-OAuth provider auth", {
        code: "CREDENTIAL_FILE_CHANGED",
      });
    }
    return rotatedSecrets;
  }
  if (rotated.type !== "oauth" || !providerAuth.source) {
    throw new AutopilotError("OpenCode OAuth provider auth cannot be safely written back", {
      code: "CREDENTIAL_FILE_CHANGED",
    });
  }
  if (stableJson(rotated) === stableJson(providerAuth.selected_entry)) return rotatedSecrets;

  const current = await assertProviderAuthSourceCas(providerAuth.source);
  const merged = {
    ...current.value,
    [providerAuth.provider_id]: structuredClone(rotated),
  };
  validateProviderAuthDocument(merged);
  const contents = `${JSON.stringify(merged, null, 2)}\n`;
  await assertProviderAuthSourceCas(providerAuth.source);
  await atomicWriteFile(providerAuth.source.file, contents);
  const verified = await readProviderAuthSource(providerAuth.source.file);
  if (!verified || verified.sha256 !== sha256(contents)) {
    throw new AutopilotError("OpenCode OAuth rotation writeback could not be verified", {
      code: "CREDENTIAL_FILE_CHANGED",
    });
  }
  return rotatedSecrets;
}

async function validateSelectedMcp(project, projectOpenCode, capabilities, credentials, providerNames, executionEnvironment) {
  const secretFiles = new Map(
    credentials.names.map((name) => [name, path.join("phase-secrets", name)]),
  );
  const mcp = projectOpenCode.mcp ?? {};
  const localCommands = {};
  for (const name of capabilities.server_names) {
    const replaced = replaceCredentialReferences(mcp[name], secretFiles);
    if (replaced.type === "local") {
      validateLocalMcpEnvironment(replaced, name, providerNames);
      await assertExternalLaunchArguments(project.root, replaced.command.slice(1), {
        label: `Local MCP ${name} launch argument`,
      });
      const executable = await resolveExternalExecutable(
        project.root,
        replaced.command[0],
        executionEnvironment,
        { label: `Local MCP ${name} executable` },
      );
      const executableName = path.basename(executable, path.extname(executable)).toLowerCase();
      if (
        replaced.project_root_argument === true &&
        (
          GENERIC_PROJECT_ARGUMENT_EXECUTABLE.has(executableName) ||
          /^python\d+(?:\.\d+)?$/.test(executableName) ||
          replaced.command.slice(1).some((argument) => !argument.startsWith("-"))
        )
      ) {
        throw new AutopilotError(
          `Local MCP ${name} can append the project root only to a dedicated external MCP executable`,
          { code: "EXECUTABLE_UNTRUSTED" },
        );
      }
      localCommands[name] = [
        ...await resolveExternalInvocation(
          project.root,
          executable,
          executionEnvironment,
          { label: `Local MCP ${name} executable` },
        ),
        ...replaced.command.slice(1),
      ];
    }
  }
  if (JSON.stringify(credentials.names) !== JSON.stringify(capabilities.credential_names)) {
    throw new AutopilotError("Phase credentials do not exactly match the selected task MCP servers", {
      code: "CREDENTIAL_VARIABLE_DENIED",
    });
  }
  return localCommands;
}

export async function preflightFreshOpenCode(project, {
  phase,
  taskId,
  baseline,
} = {}) {
  const settings = project.config.opencode;
  const trustedCommand = await trustedOpenCodeCommand(project);
  if (settings.command.some(reusesSession)) {
    throw new AutopilotError("OpenCode command contains a session-reuse flag", {
      code: "SESSION_REUSE_DENIED",
    });
  }
  if (settings.attach_url) {
    throw new AutopilotError("Attached OpenCode servers cannot provide the required fresh-process phase boundary", {
      code: "PROJECT_INVALID",
    });
  }
  if (!/^[0-9a-fA-F]{40,64}$/.test(baseline ?? "")) {
    throw new AutopilotError("Fresh OpenCode phase requires a controller-supplied Git baseline", {
      code: "PROJECT_INVALID",
    });
  }

  const agentName = settings.agents?.[phase];
  if (typeof agentName !== "string" || !agentName) {
    throw new AutopilotError(`No direct OpenCode agent is configured for phase ${phase}`, {
      code: "OPENCODE_AGENT_MISSING",
    });
  }
  const resolved = await resolvePhaseConfiguration(project, phase, taskId, baseline);
  const credentials = await credentialEnvironmentForScope(
    project,
    "opencode",
    settings.credential_profiles?.[phase],
    { requiredNames: resolved.capabilities.credential_names },
  );
  const agentSource = path.join(project.root, ".opencode", "agents", `${agentName}.md`);
  const toolSource = path.join(project.root, ".autopilot", "bin", "opencode-tools.mjs");
  await Promise.all([
    assertPrivateFile(project.root, agentSource, `OpenCode ${phase} agent`),
    assertPrivateFile(project.root, toolSource, "controller-owned OpenCode tools"),
  ]);
  const agentText = await readFile(agentSource, "utf8");
  const feedbackGates = feedbackGatePolicy(resolved.task, resolved.gates, phase);
  const effectiveAgent = renderFeedbackToolPermission(
    renderManagedToolBlock(
      agentText,
      resolved.capabilities.grants,
      resolved.capabilities.role,
    ),
    Object.keys(feedbackGates).length > 0,
  );
  const localCommands = await validateSelectedMcp(
    project,
    resolved.projectOpenCode,
    resolved.capabilities,
    credentials,
    settings.provider_environment ?? [],
    trustedCommand.environment,
  );
  const providerInputs = await loadProviderInputs(settings);
  const exposedSecrets = exposedPhaseSecretInputs({
    credentials,
    providerSecrets: providerInputs.providerSecrets,
    providerAuth: providerInputs.providerAuth,
    sourceMcpAuth: providerInputs.sourceMcpAuth,
    selectedNames: resolved.capabilities.server_names,
  });
  return {
    ...resolved,
    credentials,
    agentName,
    agentSource,
    toolSource,
    effectiveAgent,
    feedbackGates,
    openCodeCommand: trustedCommand.command,
    executionEnvironment: trustedCommand.environment,
    localCommands,
    ...providerInputs,
    ...exposedSecrets,
  };
}

export async function preflightOpenCodeCommand(project) {
  const trusted = await trustedOpenCodeCommand(project);
  const command = trusted.command;
  const neutral = await createPrivateOpenCodeRuntime(project, "probe");
  try {
    const home = path.join(neutral, "home");
    const config = path.join(neutral, "xdg-config");
    const data = path.join(neutral, "xdg-data");
    const cache = path.join(neutral, "xdg-cache");
    const state = path.join(neutral, "xdg-state");
    const temp = path.join(neutral, "tmp");
    const appData = path.join(home, "AppData", "Roaming");
    const localAppData = path.join(home, "AppData", "Local");
    const moduleCache = path.join(neutral, "powershell", "ModuleAnalysisCache");
    await Promise.all([
      mkdir(home, { recursive: true }), mkdir(config, { recursive: true }),
      mkdir(data, { recursive: true }), mkdir(cache, { recursive: true }),
      mkdir(state, { recursive: true }), mkdir(temp, { recursive: true }),
      mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true }),
      mkdir(path.dirname(moduleCache), { recursive: true }),
    ]);
    const probeEnvironment = {
      ...trusted.environment,
      HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
      TEMP: temp, TMP: temp, TMPDIR: temp,
      PSModuleAnalysisCachePath: moduleCache,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state,
      OPENCODE_CONFIG_DIR: path.join(config, "opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        autoupdate: false,
        plugin: [],
        instructions: [],
        mcp: {},
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PURE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1", BUN_OPTIONS: "--no-env-file",
    };
    const options = {
      cwd: neutral,
      env: probeEnvironment,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      guardProcessTree: true,
    };
    const result = await runArgv(
      [...command, "--version"],
      options,
    );
    const version = truncateUtf8(
      `${result.stdout}\n${result.stderr}`.replace(/[\r\n]+/g, " ").trim(),
      512,
    );
    if (result.code !== 0 || result.timed_out || result.output_truncated || !version) {
      throw new AutopilotError(
        `Configured OpenCode command did not return a bounded version (exit ${result.code ?? "unknown"})`,
        { code: "OPENCODE_PREFLIGHT_FAILED" },
      );
    }
    const capability = await runArgv(
      [
        ...command,
        "--pure",
        "run",
        "--dir",
        neutral,
        "--agent",
        "__autopilot_probe__",
        "--format",
        "json",
        "--title",
        "__autopilot_probe__",
        "--auto",
        "--help",
      ],
      options,
    );
    const help = `${capability.stdout}\n${capability.stderr}`.trim();
    if (
      capability.code !== 0 ||
      capability.timed_out ||
      capability.output_truncated ||
      !help
    ) {
      throw new AutopilotError(
        `Configured OpenCode command did not accept the required zero-model CLI capability probe (exit ${capability.code ?? "unknown"})`,
        { code: "OPENCODE_PREFLIGHT_FAILED" },
      );
    }
    return { command, version, capability_probe: "passed" };
  } finally {
    try {
      await assertPrivateOpenCodeRuntime(project, neutral, "probe");
      await rm(neutral, { recursive: true, force: true });
    } catch {
      throw new AutopilotError("Failed OpenCode command-probe cleanup", {
        code: "OPENCODE_CLEANUP_FAILED",
      });
    }
  }
}

async function prepareSterilePhase(project, {
  phase,
  taskId,
  attempt,
  baseline,
  credentials,
  task,
  projectOpenCode,
  capabilities,
  agentName,
  toolSource,
  effectiveAgent,
  executionEnvironment,
  localCommands,
  providerEnvironment,
  providerAuth,
  selectedMcpAuth,
  secrets,
  feedbackGates,
}) {
  const settings = project.config.opencode;

  const sterile = await createPrivateOpenCodeRuntime(project, "phase");
  const xdgConfig = path.join(sterile, "xdg-config");
  // Make the custom config directory the sterile global config directory too.
  // OpenCode otherwise initializes and installs its tool SDK into both paths.
  const profile = path.join(xdgConfig, "opencode");
  const agents = path.join(profile, "agents");
  const tools = path.join(profile, "tools");
  const secretDirectory = path.join(sterile, "phase-secrets");
  const usageFile = path.join(sterile, "tool-usage.json");
  const home = path.join(sterile, "home");
  const xdgData = path.join(sterile, "xdg-data");
  const xdgCache = path.join(sterile, "xdg-cache");
  const xdgState = path.join(sterile, "xdg-state");
  const launchCwd = path.join(sterile, "launch-cwd");
  const moduleCache = path.join(sterile, "powershell", "ModuleAnalysisCache");
  const removeSterile = async () => {
    await assertPrivateOpenCodeRuntime(project, sterile, "phase");
    await rm(sterile, { recursive: true, force: true });
  };
  try {
  await Promise.all([
    mkdir(agents, { recursive: true }), mkdir(tools, { recursive: true }),
    mkdir(secretDirectory, { recursive: true }), mkdir(home, { recursive: true }),
    mkdir(path.join(xdgConfig, "opencode"), { recursive: true }),
    mkdir(path.join(xdgData, "opencode"), { recursive: true }),
    mkdir(xdgCache, { recursive: true }), mkdir(xdgState, { recursive: true }),
    mkdir(launchCwd, { recursive: true }),
    mkdir(path.dirname(moduleCache), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(agents, `${agentName}.md`), effectiveAgent, { encoding: "utf8", mode: 0o600, flag: "wx" }),
    copyFile(toolSource, path.join(tools, "autopilot.js")),
  ]);
  const feedbackRunner = await snapshotGateRunner(project, sterile);

  const secretFiles = new Map();
  for (const [name, value] of Object.entries(credentials.environment)) {
    const file = path.join(secretDirectory, name);
    await writeFile(file, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    secretFiles.set(name, file);
  }

  const mcp = projectOpenCode.mcp ?? {};
  const selectedNames = capabilities.server_names;

  const selectedMcp = {};
  const providerNames = settings.provider_environment ?? [];
  for (const name of selectedNames) {
    const server = mcp[name];
    const replaced = replaceCredentialReferences(server, secretFiles);
    if (replaced.type === "local") {
      const appendProjectRoot = replaced.project_root_argument === true;
      delete replaced.project_root_argument;
      const configuredEnvironment = validateLocalMcpEnvironment(replaced, name, providerNames);
      const serverHome = path.join(sterile, "mcp-home", name);
      const serverCwd = path.join(serverHome, "cwd");
      const serverData = path.join(serverHome, ".local", "share");
      const serverConfig = path.join(serverHome, ".config");
      const serverCache = path.join(serverHome, ".cache");
      const serverTemp = path.join(serverHome, "tmp");
      const serverState = path.join(serverHome, ".local", "state");
      await Promise.all([
        mkdir(serverCwd, { recursive: true }), mkdir(serverData, { recursive: true }),
        mkdir(serverConfig, { recursive: true }), mkdir(serverCache, { recursive: true }),
        mkdir(serverTemp, { recursive: true }), mkdir(serverState, { recursive: true }),
      ]);
      const scrubbed = {
        HOME: serverHome, USERPROFILE: serverHome, APPDATA: serverConfig, LOCALAPPDATA: serverData,
        TEMP: serverTemp, TMP: serverTemp, TMPDIR: serverTemp,
        XDG_CONFIG_HOME: serverConfig, XDG_DATA_HOME: serverData, XDG_CACHE_HOME: serverCache,
        XDG_STATE_HOME: serverState,
        ...(executionEnvironment.PATH === undefined ? {} : { PATH: executionEnvironment.PATH }),
        ...(executionEnvironment.Path === undefined ? {} : { Path: executionEnvironment.Path }),
        BUN_OPTIONS: "--no-env-file",
        OPENCODE_CONFIG_CONTENT: "", OPENCODE_AUTH_CONTENT: "", AUTOPILOT_TOOL_POLICY: "",
      };
      for (const variable of providerNames) scrubbed[variable] = "";
      // Explicit MCP variables may carry phase credentials through {file:...},
      // but process-control and provider variables are always controller-owned.
      replaced.command = [
        ...localCommands[name],
        ...(appendProjectRoot ? [project.root] : []),
      ];
      replaced.cwd = serverCwd;
      replaced.environment = { ...configuredEnvironment, ...scrubbed };
    }
    selectedMcp[name] = replaced;
  }
  if (providerAuth) await writeFile(path.join(xdgData, "opencode", "auth.json"), providerAuth.raw, { encoding: "utf8", mode: 0o600, flag: "wx" });

  if (Object.keys(selectedMcpAuth).length > 0) {
    await writeFile(path.join(xdgData, "opencode", "mcp-auth.json"), `${JSON.stringify(selectedMcpAuth)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  const contractName = phase === "review" ? "review.json" : "candidate.json";
  const gitArgv = [await resolveExternalGitExecutable(
    project.root,
    executionEnvironment,
    { label: "phase-tool Git executable" },
  )];
  const policy = {
    schema_version: 1, root: project.root, task_id: taskId, phase, attempt,
    baseline_head: baseline,
    allowed_paths: task.allowed_paths,
    contract_path: normalizeRelative(`${project.relative.runtime}/${contractName}`),
    max_returned_bytes: PHASE_TOOL_RETURNED_BYTES,
    usage_path: usageFile,
    feedback_runner: feedbackRunner,
    feedback_gates: feedbackGates,
    max_feedback_calls: phase !== "review" && Object.keys(feedbackGates).length > 0
      ? MAX_FEEDBACK_CALLS
      : 0,
    git_argv: gitArgv,
  };
  const isolatedConfig = {
    $schema: "https://opencode.ai/config.json", share: "disabled", snapshot: false,
    autoupdate: false, plugin: [], instructions: [],
    compaction: { auto: true, prune: true, tail_turns: 2 },
    tool_output: { max_lines: 200, max_bytes: 16384 }, mcp: selectedMcp,
    ...(settings.model ? { model: settings.model } : {}),
  };
  const environment = {
    ...executionEnvironment, ...providerEnvironment,
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"), TMPDIR: path.join(home, "tmp"),
    PSModuleAnalysisCachePath: moduleCache,
    XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData, XDG_CACHE_HOME: xdgCache, XDG_STATE_HOME: xdgState,
    OPENCODE_CONFIG_DIR: profile, OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PURE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    BUN_OPTIONS: "--no-env-file",
    AUTOPILOT_TOOL_POLICY: Buffer.from(JSON.stringify(policy), "utf8").toString("base64"),
  };
  await Promise.all([mkdir(environment.APPDATA, { recursive: true }), mkdir(environment.LOCALAPPDATA, { recursive: true }), mkdir(environment.TEMP, { recursive: true })]);
  return {
    environment,
    cwd: launchCwd,
    usageFile,
    secrets,
    cleanup: removeSterile,
  };
  } catch (error) {
    try {
      await removeSterile();
    } catch (cleanupError) {
      throw new AutopilotError("Failed OpenCode phase setup left a sterile directory that could contain credentials", {
        code: "OPENCODE_CLEANUP_FAILED",
        details: { setup: error.message, cleanup: cleanupError.message },
      });
    }
    throw error;
  }
}

export async function runFreshOpenCode(project, prompt, {
  phase,
  taskId,
  attempt = 0,
  baseline,
  priorSessionIds = [],
  captureEphemeralSecrets = null,
} = {}) {
  const settings = project.config.opencode;
  const preflight = await preflightFreshOpenCode(project, { phase, taskId, baseline });
  assertPhasePromptHasNoSecrets(prompt, preflight.secrets, `OpenCode ${phase}`);
  const agent = preflight.agentName;
  const sterile = await prepareSterilePhase(project, {
    phase,
    taskId,
    attempt,
    baseline,
    ...preflight,
  });
  // Keep OpenCode's project discovery in the sterile launch directory. The
  // packet and role already contain the selected context, while custom tools
  // are independently bound to policy.root. This prevents AGENTS.md and other
  // project-wide instructions from being paid again in every isolated phase.
  const argv = [...preflight.openCodeCommand, "--pure", "run", "--dir", sterile.cwd, "--agent", agent, "--format", "json", "--title", `autopilot ${phase} ${taskId ?? "project"} a${attempt}`];
  if (settings.auto_approve) argv.push("--auto");
  if (settings.variant) argv.push("--variant", settings.variant);
  argv.push(prompt);
  const phaseSecrets = [...new Set(
    sterile.secrets.filter((value) => typeof value === "string" && value.length >= 4),
  )];
  const maxOutputBytes = Number(settings.max_output_bytes ?? 2 * 1024 * 1024);
  let raw;
  let toolUsage = emptyToolUsage(phase, taskId);
  try {
    if (typeof captureEphemeralSecrets === "function") {
      captureEphemeralSecrets([...phaseSecrets]);
    }
    raw = await runArgv(argv, {
      cwd: sterile.cwd, env: sterile.environment,
      timeoutMs: Number(settings.timeout_seconds ?? 1800) * 1000,
      maxOutputBytes, allowMultilineArgs: true, guardProcessTree: true,
    });
    toolUsage = await readToolUsage(sterile.usageFile, phase, taskId);
  } finally {
    let credentialError = null;
    try {
      await assertCredentialInputsUnchanged(project, "opencode", preflight.credentials.freeze);
    } catch (error) {
      credentialError = error;
    }
    try {
      await sterile.cleanup();
    } catch (cleanupError) {
      throw new AutopilotError("Failed OpenCode phase cleanup left a sterile directory that could contain credentials", {
        code: "OPENCODE_CLEANUP_FAILED",
        details: {
          credential_check: credentialError ? String(credentialError.message ?? credentialError) : null,
          cleanup: String(cleanupError.message ?? cleanupError),
        },
      });
    }
    if (credentialError) throw credentialError;
  }
  const result = sanitizeProcessResult(raw, sterile.secrets, maxOutputBytes);
  if (result.output_truncated) throw new AutopilotError(`Fresh OpenCode ${phase} output exceeded its configured byte cap`, { code: "OPENCODE_OUTPUT_TRUNCATED" });
  if (result.timed_out || result.code !== 0) {
    throw new AutopilotError(`Fresh OpenCode ${phase} session failed${result.timed_out ? " (timeout)" : ""}; raw output was not persisted`, {
      code: result.timed_out ? "OPENCODE_TIMEOUT" : "OPENCODE_FAILED",
      details: { code: result.code, output_hash: sha256(`${result.stdout}\n${result.stderr}`) },
    });
  }
  const sessionId = parseSessionId(result.stdout);
  if (observedSessionIds.has(sessionId) || priorSessionIds.includes(sessionId)) throw new AutopilotError(`OpenCode reused a session during ${phase}`, { code: "SESSION_REUSE_DETECTED" });
  observedSessionIds.add(sessionId);
  const modelUsage = parseModelUsage(result.stdout, sessionId);
  const phaseResult = {
    session_id: sessionId,
    output_hash: sha256(`${result.stdout}\n${result.stderr}`),
    tool_usage: { ...toolUsage, ...(modelUsage ? { model_usage: modelUsage } : {}) },
  };
  ephemeralPhaseSecrets.set(phaseResult, phaseSecrets);
  return phaseResult;
}

export function consumeEphemeralPhaseSecrets(phaseResult) {
  const values = ephemeralPhaseSecrets.get(phaseResult) ?? [];
  ephemeralPhaseSecrets.delete(phaseResult);
  return [...values];
}
