import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateEvaluationTelemetry,
  aggregateUsage,
  collectStrictOpenCodeUsage,
  emptyUsage,
} from "./evaluation-telemetry.mjs";
import { runArgv } from "../../.agents/skills/init-project/assets/project/.autopilot/bin/lib/process.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(moduleFile), "../..");
const ALLOWED_STRATEGIES = new Set(["direct", "fresh_loop", "control_plane"]);
const SESSION_REUSE_ARGUMENT = /^(?:--(?:continue|session|fork)(?:=|$)|-[cs](?:=|$))/;
const SAFE_MODEL = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@/-]+$/;
const SAFE_VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_COMMAND_ARGUMENT_BYTES = 4096;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 2000;
const RUNTIME_MARKER = ".ocp-evaluation-runtime.json";
const RUNTIME_OWNER = "opencode-control-plane-evaluation";
const NULL_USAGE = Object.freeze({
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  provider_cost: null,
});

class LiveEvaluationError extends Error {
  constructor(message, code = "LIVE_EVALUATION_INVALID") {
    super(message);
    this.name = "LiveEvaluationError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDescendant(parent, candidate, label, { allowEqual = false } = {}) {
  if (!isWithin(parent, candidate) || (!allowEqual && pathKey(parent) === pathKey(candidate))) {
    throw new LiveEvaluationError(`${label} must be a strict descendant of its disposable boundary`, "EVALUATION_PATH_UNSAFE");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createOwnedRuntime(parent, prefix, kind) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || pathKey(await realpath(parent)) !== pathKey(parent)) {
    throw new LiveEvaluationError("evaluation runtime parent is not one real directory", "EVALUATION_RUNTIME_UNSAFE");
  }
  const root = await mkdtemp(path.join(parent, prefix));
  const marker = {
    schema_version: 1,
    owner: RUNTIME_OWNER,
    kind,
    id: randomUUID(),
  };
  await writeFile(path.join(root, RUNTIME_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  return { root, marker };
}

async function assertOwnedLinkFreeRuntime(root, expected) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || pathKey(await realpath(root)) !== pathKey(root)) {
    throw new LiveEvaluationError("evaluation runtime root identity is unsafe", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
  }
  const markerFile = path.join(root, RUNTIME_MARKER);
  const marker = JSON.parse(await safeRegularFile(markerFile, "evaluation runtime marker", 4096));
  if (
    marker?.schema_version !== expected.schema_version || marker?.owner !== expected.owner ||
    marker?.kind !== expected.kind || marker?.id !== expected.id || Object.keys(marker).length !== 4
  ) throw new LiveEvaluationError("evaluation runtime ownership marker changed", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
  let entries = 0;
  async function visit(directory, depth) {
    if (depth > 32) throw new LiveEvaluationError("evaluation runtime exceeds the safe cleanup depth", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 10_000) throw new LiveEvaluationError("evaluation runtime exceeds the safe cleanup entry limit", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
      const location = path.join(directory, entry.name);
      const info = await lstat(location);
      if (info.isSymbolicLink()) throw new LiveEvaluationError("linked evaluation runtime retained for inspection", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
      if (info.isDirectory()) await visit(location, depth + 1);
      else if (!info.isFile() || Number(info.nlink) !== 1) {
        throw new LiveEvaluationError("non-regular or multiply-linked evaluation runtime retained for inspection", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
      }
    }
  }
  await visit(root, 0);
}

async function removeOwnedRuntime(owned) {
  try {
    await assertOwnedLinkFreeRuntime(owned.root, owned.marker);
    await rm(owned.root, { recursive: true, force: false });
  } catch (error) {
    if (error instanceof LiveEvaluationError && error.code === "EVALUATION_RUNTIME_RETAINED_UNSAFE") throw error;
    throw new LiveEvaluationError("evaluation runtime cleanup failed; the owned tree was retained for inspection", "EVALUATION_RUNTIME_RETAINED_UNSAFE");
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value, replacements = []) {
  let text = String(value ?? "evaluation failed");
  for (const [from, to] of replacements) {
    if (typeof from === "string" && from) text = text.replaceAll(from, to);
  }
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_BYTES) || "evaluation failed";
}

function numberOption(value, fallback, { minimum, maximum, integer = true, label }) {
  const selected = value ?? fallback;
  if (
    typeof selected !== "number" || !Number.isFinite(selected) ||
    (integer && !Number.isSafeInteger(selected)) || selected < minimum || selected > maximum
  ) throw new LiveEvaluationError(`${label} must be between ${minimum} and ${maximum}`);
  return selected;
}

function normalizeProfile(profile) {
  if (!plainObject(profile)) throw new LiveEvaluationError("profile must be an object");
  const command = profile.opencode_command;
  if (
    !Array.isArray(command) || command.length === 0 || command.length > 16 ||
    command.some((item) => typeof item !== "string" || !item || /[\0\r\n]/.test(item) || byteLength(item) > MAX_COMMAND_ARGUMENT_BYTES)
  ) throw new LiveEvaluationError("profile.opencode_command must be one bounded argv array");
  if (command.slice(1).some((argument) => SESSION_REUSE_ARGUMENT.test(argument))) {
    throw new LiveEvaluationError("session-reuse flags are forbidden in live evaluation commands", "SESSION_REUSE_DENIED");
  }
  if (
    typeof profile.model !== "string" || !SAFE_MODEL.test(profile.model) ||
    byteLength(profile.model) > 256 || profile.model === "provider/model"
  ) {
    throw new LiveEvaluationError("profile.model must be one fixed provider/model identifier");
  }
  const variant = profile.variant === null || profile.variant === undefined || profile.variant === "default"
    ? null
    : profile.variant;
  if (variant !== null && (typeof variant !== "string" || !SAFE_VARIANT.test(variant))) {
    throw new LiveEvaluationError("profile.variant must be null, default, or one safe variant ID");
  }
  const authMode = profile.provider_auth_mode ?? "none";
  if (!new Set(["none", "environment", "auth_file"]).has(authMode)) {
    throw new LiveEvaluationError("profile.provider_auth_mode must be none, environment, or auth_file");
  }
  const providerEnvironment = profile.provider_environment ?? [];
  if (
    !Array.isArray(providerEnvironment) || providerEnvironment.length > 32 ||
    providerEnvironment.some((name) => typeof name !== "string" || !SAFE_ENVIRONMENT_NAME.test(name)) ||
    new Set(providerEnvironment).size !== providerEnvironment.length
  ) throw new LiveEvaluationError("profile.provider_environment must contain unique safe variable names");
  if (authMode === "environment" && providerEnvironment.length === 0) {
    throw new LiveEvaluationError("environment provider auth requires explicit variable names");
  }
  if (authMode !== "environment" && providerEnvironment.length !== 0) {
    throw new LiveEvaluationError("provider variables are allowed only with environment auth");
  }
  const strategies = profile.strategies ?? [...ALLOWED_STRATEGIES];
  if (
    !Array.isArray(strategies) || strategies.length === 0 ||
    strategies.some((strategy) => !ALLOWED_STRATEGIES.has(strategy)) ||
    new Set(strategies).size !== strategies.length
  ) throw new LiveEvaluationError("profile.strategies contains an unsupported or duplicate strategy");
  return {
    command: [...command],
    model: profile.model,
    variant,
    authMode,
    providerEnvironment: [...providerEnvironment],
    authFile: profile.auth_file ?? null,
    strategies: [...strategies],
    attemptLimit: numberOption(profile.attempt_limit, 3, {
      minimum: 1, maximum: 10, label: "profile.attempt_limit",
    }),
    timeoutMs: numberOption(profile.timeout_seconds, 1800, {
      minimum: 1, maximum: 7200, label: "profile.timeout_seconds",
    }) * 1000,
    maxOutputBytes: numberOption(profile.max_output_bytes, 2 * 1024 * 1024, {
      minimum: 4096, maximum: MAX_PROCESS_OUTPUT_BYTES, label: "profile.max_output_bytes",
    }),
  };
}

function safeBaseEnvironment(source = process.env) {
  const output = {
    NO_COLOR: "1",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    BUN_OPTIONS: "--no-env-file",
    OCP_EVALUATION_NO_NETWORK_TOOLS: "1",
  };
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (typeof source[name] === "string") output[name] = source[name];
  }
  return output;
}

async function isolatedProcessEnvironment(root, additions = {}) {
  const home = path.join(root, "process-home");
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  const moduleCache = path.join(root, "powershell", "ModuleAnalysisCache");
  const temp = path.join(root, "process-temp");
  await Promise.all([
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(path.dirname(moduleCache), { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  return {
    ...safeBaseEnvironment(),
    ...additions,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PSModuleAnalysisCachePath: moduleCache,
  };
}

async function safeRegularFile(file, label, maximum = MAX_AUTH_BYTES) {
  const before = await lstat(file);
  if (
    !before.isFile() || before.isSymbolicLink() || Number(before.nlink) > 1 ||
    before.size < 1 || before.size > maximum
  ) throw new LiveEvaluationError(`${label} must be one bounded regular file`, "EVALUATION_FILE_UNSAFE");
  const raw = await readFile(file, "utf8");
  const after = await lstat(file);
  if (
    String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) ||
    after.size !== byteLength(raw)
  ) throw new LiveEvaluationError(`${label} changed while it was being read`, "EVALUATION_FILE_UNSAFE");
  return raw;
}

async function authMaterial(settings, source = process.env) {
  const providerId = settings.model.slice(0, settings.model.indexOf("/"));
  if (settings.authMode === "none") return { providerId, raw: null, environment: {} };
  if (settings.authMode === "environment") {
    const environment = {};
    for (const name of settings.providerEnvironment) {
      const value = source[name];
      if (typeof value !== "string" || value.length === 0 || byteLength(value) > 64 * 1024 || value.includes("\0")) {
        throw new LiveEvaluationError(`required provider environment variable ${name} is unavailable or unsafe`, "PROVIDER_AUTH_MISSING");
      }
      environment[name] = value;
    }
    return { providerId, raw: null, environment };
  }

  let raw = typeof source.OPENCODE_AUTH_CONTENT === "string" && source.OPENCODE_AUTH_CONTENT
    ? source.OPENCODE_AUTH_CONTENT
    : null;
  if (raw !== null && byteLength(raw) > MAX_AUTH_BYTES) {
    throw new LiveEvaluationError("OPENCODE_AUTH_CONTENT exceeds the live-evaluation byte cap", "PROVIDER_AUTH_UNSAFE");
  }
  if (raw === null) {
    let sourceFile = settings.authFile;
    if (sourceFile !== null && (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile))) {
      throw new LiveEvaluationError("profile.auth_file must be an explicit absolute path", "PROVIDER_AUTH_UNSAFE");
    }
    if (sourceFile === null) {
      const dataHome = typeof source.XDG_DATA_HOME === "string" && path.isAbsolute(source.XDG_DATA_HOME)
        ? source.XDG_DATA_HOME
        : path.join(os.homedir(), ".local", "share");
      sourceFile = path.join(dataHome, "opencode", "auth.json");
    }
    try { raw = await safeRegularFile(sourceFile, "OpenCode provider auth"); }
    catch (error) {
      if (error?.code === "ENOENT") {
        throw new LiveEvaluationError(`auth_file mode requires an OpenCode auth entry for ${providerId}`, "PROVIDER_AUTH_MISSING");
      }
      throw error;
    }
  }
  let document;
  try { document = JSON.parse(raw); }
  catch { throw new LiveEvaluationError("OpenCode provider auth is invalid JSON", "PROVIDER_AUTH_UNSAFE"); }
  if (!plainObject(document) || !plainObject(document[providerId])) {
    throw new LiveEvaluationError(`OpenCode provider auth has no ${providerId} entry`, "PROVIDER_AUTH_MISSING");
  }
  return {
    providerId,
    raw: `${JSON.stringify({ [providerId]: document[providerId] }, null, 2)}\n`,
    environment: {},
  };
}

function fileAgent() {
  return [
    "---",
    "description: Bounded live-evaluation coding worker",
    "mode: primary",
    "temperature: 0.1",
    "steps: 64",
    "permission:",
    '  "*": deny',
    "  read: allow",
    "  edit: allow",
    "  write: allow",
    "  patch: allow",
    "  apply_patch: allow",
    "  glob: allow",
    "  grep: allow",
    "  list: allow",
    "  lsp: deny",
    "  bash: deny",
    "  task: deny",
    "  skill: deny",
    "  question: deny",
    "  webfetch: deny",
    "  external_directory: deny",
    "---",
    "",
    "Complete only the supplied evaluation task. Work inside the candidate directory with file tools only. Do not use shell, web, skills, subagents, or external paths. Preserve unrelated behavior and finish in this session.",
    "",
  ].join("\n");
}

function isolatedConfig(settings) {
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    snapshot: false,
    autoupdate: false,
    plugin: [],
    instructions: [],
    mcp: {},
    model: settings.model,
    compaction: { auto: true, prune: true, tail_turns: 2 },
    tool_output: { max_lines: 200, max_bytes: 16384 },
    permission: {
      "*": "deny",
      read: "allow",
      edit: "allow",
      write: "allow",
      patch: "allow",
      apply_patch: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "deny",
      bash: "deny",
      task: "deny",
      skill: "deny",
      question: "deny",
      webfetch: "deny",
      external_directory: "deny",
    },
  };
}

async function prepareIsolatedHome(parent, settings, auth, label) {
  const owned = await createOwnedRuntime(parent, `${label}-`, "opencode-home");
  const root = owned.root;
  const home = path.join(root, "home");
  const config = path.join(root, "xdg-config");
  const profile = path.join(config, "opencode");
  const data = path.join(root, "xdg-data");
  const cache = path.join(root, "xdg-cache");
  const state = path.join(root, "xdg-state");
  const temp = path.join(root, "tmp");
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  const moduleCache = path.join(root, "powershell", "ModuleAnalysisCache");
  await Promise.all([
    mkdir(path.join(profile, "agents"), { recursive: true }),
    mkdir(path.join(data, "opencode"), { recursive: true }),
    mkdir(cache, { recursive: true }), mkdir(state, { recursive: true }),
    mkdir(temp, { recursive: true }), mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(path.dirname(moduleCache), { recursive: true }),
  ]);
  await writeFile(path.join(profile, "agents", "evaluation-worker.md"), fileAgent(), { mode: 0o600, flag: "wx" });
  if (auth.raw) {
    await writeFile(path.join(data, "opencode", "auth.json"), auth.raw, { mode: 0o600, flag: "wx" });
  }
  const environment = {
    ...safeBaseEnvironment(),
    ...auth.environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    OPENCODE_CONFIG_DIR: profile,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig(settings)),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    PSModuleAnalysisCachePath: moduleCache,
  };
  return {
    root,
    environment,
    async cleanup() {
      await removeOwnedRuntime(owned);
      await rm(parent, { recursive: false }).catch(() => {});
    },
  };
}

async function boundedProcess(argv, options) {
  const started = Date.now();
  const result = await runArgv(argv, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    allowMultilineArgs: true,
    guardProcessTree: true,
  });
  return {
    ...result,
    elapsed_ms: Date.now() - started,
    output_sha256: sha256(`${result.stdout}\n${result.stderr}`),
  };
}

async function zeroModelProbe(settings) {
  const owned = await createOwnedRuntime(os.tmpdir(), "ocp-live-preflight-", "opencode-preflight");
  const parent = owned.root;
  try {
    const environment = await isolatedProcessEnvironment(parent);
    const options = { cwd: parent, env: environment, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 };
    const version = await boundedProcess([...settings.command, "--version"], options);
    if (version.code !== 0 || version.timed_out || version.output_truncated) {
      throw new LiveEvaluationError("configured OpenCode command failed its bounded version probe", "OPENCODE_PREFLIGHT_FAILED");
    }
    const capabilityArgv = [
      ...settings.command,
      "--pure", "run", "--dir", parent,
      "--agent", "__evaluation_probe__", "--format", "json",
      "--title", "__evaluation_probe__", "--auto",
    ];
    if (settings.variant) capabilityArgv.push("--variant", settings.variant);
    capabilityArgv.push("--help");
    const help = await boundedProcess(capabilityArgv, options);
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (
      help.code !== 0 || help.timed_out || help.output_truncated ||
      !helpText.trim()
    ) {
      throw new LiveEvaluationError("configured OpenCode command failed its zero-model run capability probe", "OPENCODE_PREFLIGHT_FAILED");
    }
    return boundedText(`${version.stdout}\n${version.stderr}`).slice(0, 512);
  } finally {
    await removeOwnedRuntime(owned);
  }
}

/** Validate the live profile and the zero-model OpenCode CLI boundary. */
export async function preflightLiveEvaluation({ profile }) {
  const settings = normalizeProfile(profile);
  const auth = await authMaterial(settings);
  const version = await zeroModelProbe(settings);
  return {
    schema_version: 1,
    ok: true,
    zero_model: true,
    version,
    model: settings.model,
    variant: settings.variant,
    provider_auth_mode: settings.authMode,
    provider_id: auth.providerId,
    provider_environment: [...settings.providerEnvironment],
    strategies: [...settings.strategies],
  };
}

async function validatedTrialInputs(input) {
  const settings = normalizeProfile(input.profile);
  if (!ALLOWED_STRATEGIES.has(input.strategy) || !settings.strategies.includes(input.strategy)) {
    throw new LiveEvaluationError("trial strategy is not enabled by the profile");
  }
  if (!Number.isSafeInteger(input.repetition) || input.repetition < 1 || input.repetition > 100) {
    throw new LiveEvaluationError("repetition must be an integer between 1 and 100");
  }
  if (!plainObject(input.caseRecord) || input.caseRecord.schema_version !== 1 || typeof input.caseRecord.id !== "string") {
    throw new LiveEvaluationError("caseRecord must be a schema-version 1 corpus case");
  }
  if (typeof input.taskText !== "string" || !input.taskText.trim() || byteLength(input.taskText) > MAX_TASK_BYTES) {
    throw new LiveEvaluationError("taskText must be bounded non-empty text");
  }
  for (const [name, value] of Object.entries({
    repositoryRoot: input.repositoryRoot,
    runRoot: input.runRoot,
    workspace: input.workspace,
    candidate: input.candidate,
    caseDirectory: input.caseDirectory,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new LiveEvaluationError(`${name} must be an explicit absolute path`, "EVALUATION_PATH_UNSAFE");
    }
  }
  const repositoryRoot = await realpath(input.repositoryRoot);
  const runRoot = await realpath(input.runRoot);
  const workspace = await realpath(input.workspace);
  const candidate = await realpath(input.candidate);
  const caseDirectory = await realpath(input.caseDirectory);
  if (isWithin(repositoryRoot, runRoot) || isWithin(runRoot, repositoryRoot)) {
    throw new LiveEvaluationError("live run root must not overlap the source repository", "EVALUATION_PATH_UNSAFE");
  }
  assertDescendant(runRoot, workspace, "workspace", { allowEqual: true });
  assertDescendant(workspace, candidate, "candidate");
  const corpusRoot = path.join(repositoryRoot, "evaluation", "corpus");
  const expectedCase = path.join(corpusRoot, input.caseRecord.id);
  if (pathKey(caseDirectory) !== pathKey(await realpath(expectedCase))) {
    throw new LiveEvaluationError("caseDirectory does not match the bundled corpus identity", "EVALUATION_PATH_UNSAFE");
  }
  if (input.caseRecord.verification?.gate !== "evaluation/gates/verify-case.mjs") {
    throw new LiveEvaluationError("caseRecord does not select the common held-out gate");
  }
  const gateFile = path.join(repositoryRoot, input.caseRecord.verification.gate);
  await safeRegularFile(gateFile, "held-out evaluation gate");
  const auth = await authMaterial(settings);
  return {
    settings, auth, repositoryRoot, runRoot, workspace, candidate, caseDirectory,
    caseRecord: structuredClone(input.caseRecord),
    taskText: input.taskText.trim(), strategy: input.strategy, repetition: input.repetition,
    gateFile,
  };
}

function taskPrompt(input, attempt, feedback = null) {
  return [
    "Stage: execute",
    `Task: evaluation-${input.caseRecord.id}`,
    `Attempt: ${attempt}`,
    `Evaluation case: ${input.caseRecord.id}`,
    "",
    input.taskText,
    ...(feedback ? ["", "Held-out verification feedback from the preceding fresh session:", feedback] : []),
    "",
    "Use only bounded file tools inside the candidate. Do not use shell, web, skills, subagents, or external paths.",
  ].join("\n");
}

async function runOpenCodeAttempt(input, attempt, feedback = null) {
  const isolationParent = path.join(input.runRoot, ".evaluation-runtime");
  const isolated = await prepareIsolatedHome(isolationParent, input.settings, input.auth, `${input.strategy}-${input.repetition}-a${attempt}`);
  let processResult;
  try {
    const argv = [
      ...input.settings.command,
      "--pure", "run", "--dir", input.candidate,
      "--agent", "evaluation-worker", "--format", "json",
      "--title", `evaluation ${input.strategy} ${input.caseRecord.id} r${input.repetition} a${attempt}`,
      "--auto",
    ];
    if (input.settings.variant) argv.push("--variant", input.settings.variant);
    argv.push(taskPrompt(input, attempt, feedback));
    processResult = await boundedProcess(argv, {
      cwd: input.candidate,
      env: isolated.environment,
      timeoutMs: input.settings.timeoutMs,
      maxOutputBytes: input.settings.maxOutputBytes,
    });
  } finally {
    await isolated.cleanup();
  }
  const telemetry = collectStrictOpenCodeUsage(processResult.stdout, {
    truncated: processResult.output_truncated,
    maxOutputBytes: input.settings.maxOutputBytes,
  });
  return {
    process: {
      code: processResult.code,
      signal: processResult.signal,
      timed_out: processResult.timed_out,
      output_truncated: processResult.output_truncated,
      elapsed_ms: processResult.elapsed_ms,
      output_sha256: processResult.output_sha256,
    },
    telemetry,
  };
}

async function runHeldOutGate(input, { forceFailure = false } = {}) {
  if (forceFailure) {
    return {
      ok: false,
      forced: true,
      case_id: input.caseRecord.id,
      error: "The evaluation protocol requires the first verification attempt to fail before repair.",
      checks: [],
    };
  }
  const runtimeParent = path.join(input.runRoot, ".evaluation-runtime");
  const owned = await createOwnedRuntime(runtimeParent, "held-out-gate-", "held-out-gate");
  let result;
  try {
    result = await boundedProcess([
      process.execPath, input.gateFile,
      "--case", input.caseRecord.id,
      "--candidate", input.candidate,
      "--json",
    ], {
      cwd: input.candidate,
      env: await isolatedProcessEnvironment(owned.root),
      timeoutMs: Math.min(input.settings.timeoutMs, 60_000),
      maxOutputBytes: 128 * 1024,
    });
  } finally {
    await removeOwnedRuntime(owned);
    await rm(runtimeParent, { recursive: false }).catch(() => {});
  }
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch {}
  if (!plainObject(parsed) || typeof parsed.ok !== "boolean") {
    return {
      ok: false,
      forced: false,
      case_id: input.caseRecord.id,
      error: result.timed_out ? "Held-out verification timed out" : "Held-out verification returned an invalid bounded result",
      checks: [],
    };
  }
  return {
    ok: parsed.ok === true && result.code === 0 && !result.timed_out && !result.output_truncated,
    forced: false,
    case_id: input.caseRecord.id,
    error: parsed.ok === true ? null : boundedText(parsed.error, [[input.candidate, "<candidate>"]]),
    checks: Array.isArray(parsed.checks)
      ? parsed.checks.filter((item) => typeof item === "string").slice(0, 64).map((item) => boundedText(item))
      : [],
  };
}

function invalidTelemetry(code, message) {
  return {
    schema_version: 1,
    status: "invalid",
    comparable: false,
    expected_sessions: [],
    observed_sessions: [],
    session_count: 0,
    step_count: 0,
    usage: { ...NULL_USAGE },
    sessions: {},
    diagnostics: [{ code, message }],
  };
}

function combinedAttemptTelemetry(attempts) {
  if (attempts.length === 0) return invalidTelemetry("NO_SESSIONS", "No OpenCode session completed");
  const ids = attempts.flatMap((attempt) => attempt.telemetry.expected_sessions ?? []);
  if (new Set(ids).size !== ids.length) {
    return invalidTelemetry("SESSION_REUSE_DETECTED", "A supposedly fresh evaluation attempt reused an OpenCode session ID");
  }
  return aggregateEvaluationTelemetry(attempts.map((attempt) => attempt.telemetry));
}

function publicAttempt(attempt, number) {
  return {
    attempt: number,
    session_ids: [...(attempt.telemetry.expected_sessions ?? [])],
    process: attempt.process,
    telemetry_status: attempt.telemetry.status,
  };
}

function outcome(input, { attempts, gate, telemetry, elapsedMs, diagnostics = [], interruption = null }) {
  const processFailed = attempts.some((attempt) =>
    attempt.process.code !== 0 || attempt.process.timed_out || attempt.process.output_truncated
  );
  const accepted = gate?.ok === true && !processFailed;
  const comparable = telemetry?.comparable === true;
  return {
    schema_version: 1,
    strategy: input.strategy,
    case_id: input.caseRecord.id,
    repetition: input.repetition,
    status: processFailed ? "failed" : comparable ? (accepted ? "accepted" : "rejected") : "non_comparable",
    comparable,
    accepted,
    attempt_count: attempts.length,
    attempts: attempts.map((attempt, index) => publicAttempt(attempt, index + 1)),
    telemetry,
    held_out_gate: gate,
    interruption,
    elapsed_ms: elapsedMs,
    diagnostics,
  };
}

async function runDirect(input) {
  const started = Date.now();
  const attempt = await runOpenCodeAttempt(input, 1);
  const processOkay = attempt.process.code === 0 && !attempt.process.timed_out && !attempt.process.output_truncated;
  const interrupted = Boolean(input.caseRecord.simulation?.interrupt_after_phase);
  const forceFailure = Number(input.caseRecord.simulation?.forced_gate_failures ?? 0) > 0;
  const gate = processOkay && !interrupted ? await runHeldOutGate(input, { forceFailure }) : null;
  const result = outcome(input, {
    attempts: [attempt], gate, telemetry: combinedAttemptTelemetry([attempt]), elapsedMs: Date.now() - started,
    interruption: interrupted ? {
      attempted: true,
      boundary: "after_execute",
      recovered: false,
    } : null,
    diagnostics: !processOkay
      ? [{ code: "OPENCODE_PROCESS_FAILED", message: "The bounded direct OpenCode process did not complete successfully; raw output was discarded." }]
      : interrupted
        ? [{ code: "INTERRUPTED_WITHOUT_RECOVERY", message: "The direct strategy has no fresh-session recovery step." }]
        : [],
  });
  const failureCode = gate?.ok === false
    ? (gate.forced ? "forced_verification_failure" : "held_out_gate_failed")
    : null;
  result.strategy_gates = {
    run_count: gate ? 1 : 0,
    failed_count: failureCode ? 1 : 0,
    failure_evidence: failureCode ? [{ attempt: 1, code: failureCode }] : [],
  };
  return result;
}

async function runFreshLoop(input) {
  const started = Date.now();
  const attempts = [];
  let feedback = null;
  let gate = null;
  let recoveries = 0;
  let repairs = 0;
  let interruption = null;
  let gateRuns = 0;
  const gateFailureEvidence = [];
  const forcedFailures = Number(input.caseRecord.simulation?.forced_gate_failures ?? 0);
  for (let attemptNumber = 1; attemptNumber <= input.settings.attemptLimit; attemptNumber += 1) {
    const attempt = await runOpenCodeAttempt(input, attemptNumber, feedback);
    attempts.push(attempt);
    if (attempt.process.code !== 0 || attempt.process.timed_out || attempt.process.output_truncated) break;
    if (attemptNumber === 1 && input.caseRecord.simulation?.interrupt_after_phase) {
      recoveries = 1;
      interruption = { attempted: true, boundary: "after_execute", recovered: true };
      feedback = "The preceding fresh process was interrupted after execution. Re-open the bounded candidate, verify the task, and complete it without relying on prior session state.";
      continue;
    }
    gate = await runHeldOutGate(input, { forceFailure: attemptNumber <= forcedFailures });
    gateRuns += 1;
    if (gate.ok) break;
    gateFailureEvidence.push({
      attempt: attemptNumber,
      code: gate.forced ? "forced_verification_failure" : "held_out_gate_failed",
    });
    repairs += 1;
    feedback = boundedText(gate.error ?? "Held-out verification failed", [[input.candidate, "<candidate>"]]);
  }
  const diagnostics = [];
  if (gate?.ok !== true && attempts.length >= input.settings.attemptLimit) {
    diagnostics.push({ code: "ATTEMPT_LIMIT_REACHED", message: "The fresh-session loop exhausted its bounded attempt limit." });
  }
  const result = outcome(input, {
    attempts, gate, telemetry: combinedAttemptTelemetry(attempts), elapsedMs: Date.now() - started, diagnostics,
    interruption,
  });
  result.repair_count = repairs;
  result.recovery_count = recoveries;
  result.strategy_gates = {
    run_count: gateRuns,
    failed_count: gateFailureEvidence.length,
    failure_evidence: gateFailureEvidence,
  };
  return result;
}

async function copyTemplate(source, destination) {
  const copied = [];
  async function visit(from, to) {
    const entries = await readdir(from, { withFileTypes: true });
    await mkdir(to, { recursive: true });
    for (const entry of entries) {
      const sourcePath = path.join(from, entry.name);
      const destinationPath = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new LiveEvaluationError("Control Plane template contains a symbolic link", "EVALUATION_FILE_UNSAFE");
      if (entry.isDirectory()) await visit(sourcePath, destinationPath);
      else if (entry.isFile()) {
        try { await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL); }
        catch (error) {
          if (error?.code === "EEXIST") {
            throw new LiveEvaluationError(`candidate collides with Control Plane scaffold at ${entry.name}`, "EVALUATION_SCAFFOLD_CONFLICT");
          }
          throw error;
        }
        copied.push(destinationPath);
      } else throw new LiveEvaluationError("Control Plane template contains an unsupported filesystem entry", "EVALUATION_FILE_UNSAFE");
    }
  }
  await visit(source, destination);
  return copied;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function scaffoldControlPlane(input) {
  for (const relative of [".git", ".autopilot", ".project", ".opencode", "AGENTS.md", "opencode.jsonc", "control-plane", "control-plane.cmd"]) {
    try {
      await lstat(path.join(input.candidate, relative));
      throw new LiveEvaluationError(`candidate already contains reserved Control Plane path ${relative}`, "EVALUATION_SCAFFOLD_CONFLICT");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const stagingParent = path.join(input.runRoot, ".evaluation-runtime");
  const stagingOwned = await createOwnedRuntime(stagingParent, "control-plane-scaffold-", "control-plane-scaffold");
  const staging = path.join(stagingOwned.root, "payload");
  await mkdir(staging, { mode: 0o700 });
  let copied;
  try {
    const scaffoldScript = path.join(input.repositoryRoot, ".agents", "skills", "init-project", "bin", "scaffold.mjs");
    const scaffoldEnvironment = await isolatedProcessEnvironment(stagingOwned.root);
    const scaffolded = await boundedProcess([
      process.execPath, scaffoldScript, "--target", staging, "--no-git", "--json",
    ], {
      cwd: input.repositoryRoot,
      env: scaffoldEnvironment,
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (scaffolded.code !== 0 || scaffolded.timed_out || scaffolded.output_truncated) {
      throw new LiveEvaluationError("the real Control Plane scaffolder failed inside its disposable staging root", "EVALUATION_SCAFFOLD_FAILED");
    }
    copied = await copyTemplate(staging, input.candidate);
  } finally {
    await removeOwnedRuntime(stagingOwned);
  }
  for (const file of copied) {
    if (!/\.(?:md|json|jsonc|txt|example)$/i.test(file) && !path.basename(file).startsWith(".env")) continue;
    const current = await readFile(file, "utf8");
    const replaced = current
      .replace(/\{\{[^{}\r\n]+\}\}/g, "completed evaluation value")
      .replace(/^Status: initializing\.[^\r\n]*$/gm, "Status: ready.");
    if (replaced !== current) await writeFile(file, replaced, "utf8");
  }

  await writeJson(path.join(input.candidate, ".project", "manifest.json"), {
    schema_version: 2,
    max_context_bytes: 16384,
    review_reserve: { candidate_and_gates_bytes: 3072, diff_bytes: 3072 },
    bundles: { task: [".project/brief.md"] },
  });
  await writeFile(path.join(input.candidate, ".project", "brief.md"), [
    `# Evaluation case ${input.caseRecord.id}`,
    "",
    input.taskText,
    "",
    "The candidate is disposable. Complete only this task and preserve unrelated seed behavior.",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(input.candidate, ".project", "plan", "milestones", "M001.md"), [
    `# M001 — ${input.caseRecord.title ?? input.caseRecord.id}`,
    "",
    "## Outcome",
    "",
    input.taskText,
    "",
    "## Acceptance criteria",
    "",
    "- The common held-out corpus verifier passes.",
    "- An independent fresh reviewer approves the bounded diff and evidence.",
    "- Only the declared evaluation paths change.",
    "",
  ].join("\n"), "utf8");
  await writeJson(path.join(input.candidate, ".project", "plan", "queue.json"), {
    schema_version: 2,
    revision: 0,
    project_status: "ready",
    tasks: {
      M001: {
        title: input.caseRecord.title ?? input.caseRecord.id,
        status: "ready",
        priority: 100,
        depends_on: [],
        spec: ".project/plan/milestones/M001.md",
        context: { shared: ["task"], execute: [], repair: [], review: [] },
        allowed_paths: [...input.caseRecord.allowed_changed_paths],
        gates: ["evaluation-task", "evaluation-final"],
        tool_grants: { execute: [], repair: [], review: [] },
        risk: "low",
        attempt_limit: input.settings.attemptLimit,
      },
    },
  });
  const gateWrapper = path.join(input.candidate, ".autopilot", "bin", "evaluation-gate.mjs");
  await writeFile(gateWrapper, controlPlaneGateSource(input), "utf8");
  await writeJson(path.join(input.candidate, ".project", "gates.json"), {
    schema_version: 2,
    gates: {
      "evaluation-task": {
        argv: [process.execPath, gateWrapper],
        timeout_seconds: 60,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 128 * 1024,
        feedback: true,
      },
      "evaluation-final": {
        argv: [process.execPath, gateWrapper],
        timeout_seconds: 60,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 128 * 1024,
        feedback: false,
      },
    },
    final_gates: ["evaluation-final"],
  });
  await writeJson(path.join(input.candidate, ".project", "tools.json"), {
    schema_version: 1,
    roles: { worker: [], recovery: [], reviewer: [] },
  });
  const configFile = path.join(input.candidate, ".autopilot", "config.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.opencode = {
    command: [...input.settings.command],
    agents: { execute: "autopilot-worker", repair: "autopilot-recovery", review: "autopilot-reviewer" },
    credential_profiles: { execute: null, repair: null, review: null },
    model: input.settings.model,
    provider_auth_mode: input.settings.authMode,
    provider_environment: [...input.settings.providerEnvironment],
    timeout_seconds: Math.ceil(input.settings.timeoutMs / 1000),
    max_output_bytes: input.settings.maxOutputBytes,
    auto_approve: true,
    attach_url: null,
  };
  config.budgets = {
    max_tasks_per_run: 1,
    max_attempts_per_task: input.settings.attemptLimit,
    max_elapsed_minutes: Math.max(1, Math.ceil(input.settings.timeoutMs / 60_000)),
    max_no_progress: input.settings.attemptLimit,
  };
  config.context.max_bytes = 16384;
  await writeJson(configFile, config);
  await writeJson(path.join(input.candidate, ".autopilot", "runtime", "settings.json"), {
    schema_version: 1,
    variant: input.settings.variant,
  });
  await writeJson(path.join(input.candidate, ".autopilot", "runtime", "evaluation.json"), {
    schema_version: 1,
    case_id: input.caseRecord.id,
    strategy: "control_plane",
    repetition: input.repetition,
  });

  const gitIsolationRoot = path.join(input.candidate, ".autopilot", "runtime", "evaluation-git");
  const hooks = path.join(gitIsolationRoot, "hooks");
  const templates = path.join(gitIsolationRoot, "templates");
  const globalConfig = path.join(gitIsolationRoot, "global-config");
  await Promise.all([mkdir(hooks, { recursive: true }), mkdir(templates, { recursive: true })]);
  await writeFile(globalConfig, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  input.gitIsolation = { root: gitIsolationRoot, hooks, templates, globalConfig };

  await runGit(input, ["init", `--template=${templates}`]);
  await runGit(input, ["config", "user.name", "OpenCode Control Plane Evaluation"]);
  await runGit(input, ["config", "user.email", "evaluation@example.invalid"]);
  await runGit(input, ["config", "core.hooksPath", hooks]);
  await runGit(input, ["config", "commit.gpgSign", "false"]);
  await runGit(input, ["config", "tag.gpgSign", "false"]);
  await runGit(input, ["add", "-A"]);
  await runGit(input, ["commit", "-m", "evaluation: disposable baseline"]);
}

function controlPlaneGateSource(input) {
  const forced = Number(input.caseRecord.simulation?.forced_gate_failures ?? 0);
  return `import { spawn } from "node:child_process";\nimport { readFile, writeFile } from "node:fs/promises";\nimport path from "node:path";\nconst root=${JSON.stringify(input.candidate)};\nconst stateFile=path.join(root,".autopilot","runtime","evaluation-gate-state.json");\nlet count=0;\ntry{count=JSON.parse(await readFile(stateFile,"utf8")).count??0}catch{}\nif(count<${JSON.stringify(forced)}){await writeFile(stateFile,JSON.stringify({count:count+1})+"\\n","utf8");process.stderr.write("Evaluation protocol forced the first verification failure before repair.\\n");process.exit(1)}\nconst child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(input.gateFile)},"--case",${JSON.stringify(input.caseRecord.id)},"--candidate",root,"--json"],{cwd:root,env:{NO_COLOR:"1",OCP_EVALUATION_NO_NETWORK:"1",SystemRoot:process.env.SystemRoot??"",WINDIR:process.env.WINDIR??""},shell:false,windowsHide:true,stdio:["ignore","inherit","inherit"]});\nconst timer=setTimeout(()=>child.kill("SIGKILL"),60000);\nchild.once("error",error=>{clearTimeout(timer);process.stderr.write(String(error.message).slice(0,1000)+"\\n");process.exitCode=1});\nchild.once("close",code=>{clearTimeout(timer);process.exitCode=code===0?0:1});\n`;
}

async function runGit(input, arguments_) {
  if (!plainObject(input.gitIsolation)) {
    throw new LiveEvaluationError("disposable Git isolation is not initialized", "EVALUATION_GIT_FAILED");
  }
  const gitEnvironment = await isolatedProcessEnvironment(input.gitIsolation.root, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: input.gitIsolation.globalConfig,
    GIT_TEMPLATE_DIR: input.gitIsolation.templates,
  });
  const result = await boundedProcess([
    "git",
    "-c", `core.hooksPath=${input.gitIsolation.hooks}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    ...arguments_,
  ], {
    cwd: input.candidate,
    env: gitEnvironment,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.code !== 0 || result.timed_out || result.output_truncated) {
    throw new LiveEvaluationError(`disposable Git setup failed at ${arguments_[0]}`, "EVALUATION_GIT_FAILED");
  }
}

async function prepareControllerEnvironment(input, root) {
  const home = path.join(root, "home");
  const config = path.join(root, "xdg-config");
  const data = path.join(root, "xdg-data");
  const cache = path.join(root, "xdg-cache");
  const state = path.join(root, "xdg-state");
  const temp = path.join(root, "tmp");
  const moduleCache = path.join(root, "powershell", "ModuleAnalysisCache");
  await Promise.all([
    mkdir(home, { recursive: true }), mkdir(config, { recursive: true }),
    mkdir(path.join(data, "opencode"), { recursive: true }), mkdir(cache, { recursive: true }),
    mkdir(state, { recursive: true }), mkdir(temp, { recursive: true }),
    mkdir(path.dirname(moduleCache), { recursive: true }),
  ]);
  if (input.auth.raw) {
    await writeFile(path.join(data, "opencode", "auth.json"), input.auth.raw, { mode: 0o600, flag: "wx" });
  }
  return {
    ...safeBaseEnvironment(),
    ...input.auth.environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: config,
    LOCALAPPDATA: data,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PSModuleAnalysisCachePath: moduleCache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    ...(input.auth.raw ? { OPENCODE_AUTH_CONTENT: input.auth.raw } : {}),
  };
}

function receiptTelemetry(receipt) {
  const entries = Object.entries(receipt?.tool_usage ?? {});
  const sessions = {};
  const usages = [];
  for (const [phase, entry] of entries) {
    const model = entry?.model_usage;
    const usage = model ? {
      status: "complete",
      input_tokens: model.input_tokens,
      output_tokens: model.output_tokens,
      reasoning_tokens: model.reasoning_tokens,
      cache_read_tokens: model.cache_read_tokens,
      cache_write_tokens: model.cache_write_tokens,
      provider_cost: model.cost,
    } : emptyUsage("unavailable");
    sessions[phase] = { phase, status: usage.status, usage: Object.fromEntries(Object.entries(usage).filter(([key]) => key !== "status")) };
    usages.push(usage);
  }
  const aggregate = aggregateUsage(usages);
  const status = entries.length === 0 ? "unavailable" : aggregate.status;
  return {
    schema_version: 1,
    status,
    comparable: status === "complete",
    expected_sessions: entries.map(([phase]) => phase),
    observed_sessions: entries.filter(([, entry]) => plainObject(entry?.model_usage)).map(([phase]) => phase),
    session_count: entries.length,
    step_count: null,
    usage: Object.fromEntries(Object.entries(aggregate).filter(([key]) => key !== "status")),
    sessions,
    diagnostics: status === "complete" ? [] : [{
      code: entries.length === 0 ? "MISSING_RECEIPT_USAGE" : "INCOMPLETE_RECEIPT_USAGE",
      message: "Control Plane receipt lacks complete provider-reported usage for every phase.",
    }],
  };
}

async function runControllerProcess(input, environment, crashPoint = null) {
  return boundedProcess([
    process.execPath,
    path.join(input.candidate, ".autopilot", "bin", "autopilot.mjs"),
    "start", "--foreground", "--root", input.candidate,
  ], {
    cwd: input.candidate,
    env: {
      ...environment,
      ...(crashPoint ? { NODE_ENV: "test", AUTOPILOT_TEST_CRASH_POINT: crashPoint } : {}),
    },
    timeoutMs: input.settings.timeoutMs,
    maxOutputBytes: input.settings.maxOutputBytes,
  });
}

async function runControlPlane(input) {
  const started = Date.now();
  await scaffoldControlPlane(input);
  const runtimeParent = path.join(input.runRoot, ".evaluation-runtime");
  const controllerOwned = await createOwnedRuntime(
    runtimeParent,
    `control-plane-${input.repetition}-`,
    "control-plane-home",
  );
  const controllerRoot = controllerOwned.root;
  let interruption = null;
  let finalProcess;
  try {
    const environment = await prepareControllerEnvironment(input, controllerRoot);
    if (input.caseRecord.simulation?.interrupt_after_phase) {
      const interrupted = await runControllerProcess(input, environment, "after_app_commit");
      interruption = {
        attempted: true,
        boundary: "after_app_commit",
        expected_exit_code: 86,
        observed_exit_code: interrupted.code,
        recovered: false,
        output_sha256: interrupted.output_sha256,
      };
      if (interrupted.code !== 86 || interrupted.timed_out || interrupted.output_truncated) {
        throw new LiveEvaluationError("Control Plane did not stop at the disposable test crash boundary", "INTERRUPTION_BOUNDARY_FAILED");
      }
      finalProcess = await runControllerProcess(input, environment);
      interruption.recovered = finalProcess.code === 0 && !finalProcess.timed_out && !finalProcess.output_truncated;
    } else {
      finalProcess = await runControllerProcess(input, environment);
    }
  } finally {
    await removeOwnedRuntime(controllerOwned);
    await rm(runtimeParent, { recursive: false }).catch(() => {});
  }

  if (finalProcess.code !== 0 || finalProcess.timed_out || finalProcess.output_truncated) {
    let code = finalProcess.timed_out ? "CONTROL_PLANE_TIMEOUT" : "CONTROL_PLANE_FAILED";
    let detail = "";
    try {
      const parsed = JSON.parse(finalProcess.stderr);
      if (typeof parsed?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(parsed.code)) code = parsed.code;
      if (typeof parsed?.error === "string") {
        detail = `: ${boundedText(parsed.error, [[input.candidate, "<candidate>"], [input.runRoot, "<run-root>"]])}`;
      }
    } catch {}
    throw new LiveEvaluationError(`disposable Control Plane controller failed with ${code}${detail}`, code);
  }

  const receiptFile = path.join(input.candidate, ".project", "receipts", "M001.json");
  const finalReceiptFile = path.join(input.candidate, ".project", "receipts", "__project-final.json");
  const stateFile = path.join(input.candidate, ".autopilot", "state.json");
  let receipt = null;
  let finalReceipt = null;
  let controllerState = null;
  try { receipt = JSON.parse(await safeRegularFile(receiptFile, "Control Plane task receipt")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { finalReceipt = JSON.parse(await safeRegularFile(finalReceiptFile, "Control Plane final receipt")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { controllerState = JSON.parse(await safeRegularFile(stateFile, "Control Plane state")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const recordedFailureCode = controllerState?.last_failure_evidence?.failure?.code;
  const blockerErrorCode = controllerState?.blocker?.error_code;
  const preciseFailureCode = [recordedFailureCode, blockerErrorCode]
    .find((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value));
  const missingReceiptCode = preciseFailureCode ?? (typeof controllerState?.blocker?.kind === "string"
    ? controllerState.blocker.kind.toLocaleUpperCase("en-US").replace(/[^A-Z0-9_]/g, "_").slice(0, 128)
    : "MISSING_CONTROL_PLANE_RECEIPT");
  const missingReceiptMessage = controllerState?.blocker?.message
    ? boundedText(controllerState.blocker.message, [[input.candidate, "<candidate>"], [input.runRoot, "<run-root>"]])
    : "Control Plane did not produce a bounded task receipt, so the trial is non-comparable.";
  if (!receipt) {
    throw new LiveEvaluationError(missingReceiptMessage, missingReceiptCode);
  }
  const telemetry = receipt ? receiptTelemetry(receipt) : invalidTelemetry(
    missingReceiptCode,
    missingReceiptMessage,
  );
  const gate = receipt ? await runHeldOutGate(input) : null;
  const attemptNumbers = Object.keys(receipt?.tool_usage ?? {})
    .map((key) => Number(/:a(\d+)$/.exec(key)?.[1] ?? 0))
    .filter((value) => value > 0);
  const attempts = [{
    process: {
      code: finalProcess.code,
      signal: finalProcess.signal,
      timed_out: finalProcess.timed_out,
      output_truncated: finalProcess.output_truncated,
      elapsed_ms: finalProcess.elapsed_ms,
      output_sha256: finalProcess.output_sha256,
    },
    telemetry: {
      status: telemetry.status,
      expected_sessions: telemetry.expected_sessions,
    },
  }];
  const result = outcome(input, {
    attempts, gate, telemetry, elapsedMs: Date.now() - started, interruption,
    diagnostics: receipt ? [] : telemetry.diagnostics,
  });
  result.attempt_count = attemptNumbers.length ? Math.max(...attemptNumbers) : 0;
  result.receipt = receipt ? {
    task_id: receipt.task_id,
    changed_files: Array.isArray(receipt.changed_files) ? receipt.changed_files : [],
    gate_success: Array.isArray(receipt.gates) && receipt.gates.every((item) => item?.success === true),
    review_status: receipt.review?.status ?? null,
  } : null;
  const phaseNames = telemetry.expected_sessions ?? [];
  const repairCount = phaseNames.filter((name) => name.startsWith("repair:")).length;
  const reviewCount = phaseNames.filter((name) => name.startsWith("review:")).length;
  const inferredGateFailures = Math.max(0, repairCount - Math.max(0, reviewCount - 1));
  const strategyGateRuns =
    (Array.isArray(receipt?.gates) ? receipt.gates.length : 0) +
    (Array.isArray(finalReceipt?.gates) ? finalReceipt.gates.length : 0) +
    (gate ? 1 : 0) + inferredGateFailures;
  const failureEvidence = Array.from({ length: inferredGateFailures }, (_item, index) => ({
    attempt: index + 1,
    code: "controller_gate_failed_then_repaired",
  }));
  if (gate?.ok === false) {
    failureEvidence.push({
      attempt: result.attempt_count || 1,
      code: gate.forced ? "forced_verification_failure" : "held_out_gate_failed",
    });
  }
  result.strategy_gates = {
    run_count: strategyGateRuns,
    failed_count: failureEvidence.length,
    failure_evidence: failureEvidence,
  };
  return result;
}

function operationalFailure(input, error, elapsedMs) {
  const replacements = [
    [input.candidate, "<candidate>"],
    [input.runRoot, "<run-root>"],
    [input.repositoryRoot, "<source>"],
  ];
  return {
    schema_version: 1,
    strategy: input.strategy,
    case_id: input.caseRecord.id,
    repetition: input.repetition,
    status: "failed",
    comparable: false,
    accepted: false,
    attempt_count: 0,
    attempts: [],
    telemetry: invalidTelemetry(error?.code ?? "LIVE_EVALUATION_FAILED", "The live trial failed before complete telemetry was available."),
    held_out_gate: null,
    interruption: null,
    elapsed_ms: elapsedMs,
    diagnostics: [{
      code: error?.code ?? "LIVE_EVALUATION_FAILED",
      message: boundedText(error?.message ?? error, replacements),
    }],
    strategy_gates: { run_count: 0, failed_count: 0, failure_evidence: [] },
  };
}

/**
 * Run one explicitly authorized live trial. The caller owns candidate creation
 * and cleanup; this API never discovers, registers, installs, upgrades, or
 * mutates any project outside the supplied disposable run root.
 */
export async function runLiveTrial(input) {
  const validated = await validatedTrialInputs(input);
  const started = Date.now();
  const before = await workspaceSnapshot(validated.candidate);
  const dependenciesBefore = await productionDependencies(validated.candidate);
  let result;
  try {
    if (validated.strategy === "direct") result = await runDirect(validated);
    else if (validated.strategy === "fresh_loop") result = await runFreshLoop(validated);
    else result = await runControlPlane(validated);
  } catch (error) {
    await rm(path.join(validated.runRoot, ".evaluation-runtime"), { recursive: false }).catch(() => {});
    result = operationalFailure(validated, error, Date.now() - started);
  }
  return decorateLiveMetrics(validated, result, before, dependenciesBefore);
}

async function workspaceSnapshot(root) {
  const output = new Map();
  let count = 0;
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!prefix && entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const location = path.join(directory, entry.name);
      const info = await lstat(location);
      if (info.isSymbolicLink()) {
        throw new LiveEvaluationError("live trial created a symbolic link", "EVALUATION_WORKSPACE_UNSAFE");
      }
      if (info.isDirectory()) await visit(location, relative);
      else if (info.isFile() && Number(info.nlink) === 1 && info.size <= 4 * 1024 * 1024) {
        output.set(relative, sha256(await readFile(location)));
        count += 1;
        if (count > 4096) throw new LiveEvaluationError("live workspace exceeds the file-count boundary", "EVALUATION_WORKSPACE_UNSAFE");
      } else {
        throw new LiveEvaluationError("live trial created an unsafe or oversized file", "EVALUATION_WORKSPACE_UNSAFE");
      }
    }
  }
  await visit(root);
  return output;
}

function changedPaths(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function controlPlaneManagedPath(file) {
  return (
    file === "AGENTS.md" || file === "control-plane" || file === "control-plane.cmd" ||
    file === "opencode.jsonc" || file === ".gitattributes" || file === ".gitignore" ||
    file === ".ignore" || file === ".env.example" || file.startsWith(".autopilot/") ||
    file.startsWith(".opencode/") || file.startsWith(".project/")
  );
}

function matchesAllowedPath(file, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return file === prefix || file.startsWith(`${prefix}/`);
    }
    return file === pattern;
  });
}

async function productionDependencies(root) {
  const output = new Set();
  try {
    const value = JSON.parse(await safeRegularFile(path.join(root, "package.json"), "evaluation package.json"));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (!plainObject(value?.[section])) continue;
      for (const name of Object.keys(value[section])) output.add(`npm:${name}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const raw = await safeRegularFile(path.join(root, "requirements.txt"), "evaluation requirements.txt");
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.startsWith("#") && !value.startsWith("-")) {
        output.add(`python:${value.toLocaleLowerCase("en-US")}`);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return output;
}

async function decorateLiveMetrics(input, result, before, dependenciesBefore) {
  const after = await workspaceSnapshot(input.candidate);
  const dependenciesAfter = await productionDependencies(input.candidate);
  const changed = changedPaths(before, after).filter((file) =>
    input.strategy !== "control_plane" || !controlPlaneManagedPath(file)
  );
  const phaseNames = result.telemetry?.expected_sessions ?? [];
  const reviews = input.strategy === "control_plane"
    ? phaseNames.filter((name) => name.startsWith("review:")).length
    : 0;
  const repairs = result.repair_count ?? (input.strategy === "control_plane"
    ? phaseNames.filter((name) => name.startsWith("repair:")).length
    : 0);
  const recoveries = result.recovery_count ?? (result.interruption?.recovered ? 1 : 0);
  const processCompleted = result.attempts?.some((attempt) =>
    attempt.process?.code === 0 && !attempt.process?.timed_out && !attempt.process?.output_truncated
  );
  const claim = result.receipt || processCompleted ? "complete" : "unknown";
  return {
    ...result,
    repair_count: repairs,
    recovery_count: recoveries,
    reviews,
    review_rejections: input.strategy === "control_plane" ? Math.max(0, reviews - 1) : 0,
    claim,
    false_completion: claim === "complete" && result.held_out_gate?.ok === false,
    unexpected_changed_files: changed.filter((file) =>
      !matchesAllowedPath(file, input.caseRecord.allowed_changed_paths ?? [])
    ).length,
    dependency_additions: [...dependenciesAfter].filter((item) => !dependenciesBefore.has(item)).length,
  };
}

export const __test = Object.freeze({ defaultRepositoryRoot });
