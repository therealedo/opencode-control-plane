#!/usr/bin/env node

import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import {
  assertPrivateFile,
  readJson,
} from "../assets/project/.autopilot/bin/lib/core.mjs"
import {
  assertNoIssues,
  validateConfig,
} from "../assets/project/.autopilot/bin/lib/contracts.mjs"
import {
  PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES,
  PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES,
} from "../assets/project/.autopilot/bin/lib/mcp.mjs"
import {
  runArgv,
  safeBaseEnv,
  sanitizeProcessResult,
} from "../assets/project/.autopilot/bin/lib/process.mjs"
import { exactSecretVariants } from "../assets/project/.autopilot/bin/lib/secrets.mjs"
import {
  readRuntimeSettings,
  runtimeVariantLabel,
  writeRuntimeVariant,
} from "../assets/project/.autopilot/bin/lib/runtime-settings.mjs"
import { registerProject } from "./lib/project-registry.mjs"

const FINALIZE_TIMEOUT_MS = 10 * 60 * 1000
const PREFLIGHT_TIMEOUT_MS = 30 * 60 * 1000
const START_TIMEOUT_MS = 2 * 60 * 1000
const PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024
const ERROR_OUTPUT_BYTES = 8 * 1024
const CONFIG_BYTES = 1024 * 1024
const MAX_AUTH_STRING_VALUES = 1024
const MAX_ENCODED_SECRET_BYTES = 64 * 1024
const MAX_DIAGNOSTIC_SECRET_VALUES = MAX_AUTH_STRING_VALUES + 128

const args = parseArgs(process.argv.slice(2))
const target = path.resolve(args.target ?? process.cwd())
const skillDirectory = path.dirname(fileURLToPath(import.meta.url))
const finalizer = path.join(skillDirectory, "finalize.mjs")
const upgrader = path.join(skillDirectory, "upgrade-project.mjs")
const controller = path.join(target, ".autopilot", "bin", "autopilot.mjs")

const finalized = await runJson(
  process.execPath,
  [finalizer, "--target", target, "--json"],
  target,
  "Project finalization",
  { timeoutMs: FINALIZE_TIMEOUT_MS, env: baseChildEnvironment() },
)
const upgrade = await upgradeFinalizedProject(target)
const runtimeSettings = args.variant === undefined
  ? await readRuntimeSettings(target)
  : await writeRuntimeVariant(target, args.variant)
const registration = await registerFinalizedProject(target)
const controllerChild = await controllerChildContext(target)
const preflight = await runJson(
  process.execPath,
  [controller, "preflight", "--root", target, "--json"],
  target,
  "Execution preflight",
  {
    allowNotReady: true,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    env: controllerChild.env,
    secretValues: controllerChild.secretValues,
  },
)

if (!preflight.ready) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target,
    baseline_commit: finalized.baseline_commit ?? null,
    upgrade,
    runtime_variant: runtimeVariantLabel(runtimeSettings?.variant),
    registration,
    ready: false,
    started: null,
    provisioning: failedChecks(preflight),
  }, null, args.json ? 0 : 2)}\n`)
  process.exit(0)
}

if (!args.start) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target,
    baseline_commit: finalized.baseline_commit ?? null,
    upgrade,
    runtime_variant: runtimeVariantLabel(runtimeSettings?.variant),
    registration,
    ready: true,
    started: null,
    launch_confirmation_required: true,
    next_action: "Open the Control Plane dashboard, choose Worker reasoning if desired, then select Start worker.",
  }, null, args.json ? 0 : 2)}\n`)
  process.exit(0)
}

const started = await runJson(
  process.execPath,
  [controller, "start", "--detach", "--root", target],
  target,
  "Detached controller start",
  {
    timeoutMs: START_TIMEOUT_MS,
    env: controllerChild.env,
    secretValues: controllerChild.secretValues,
    guardProcessTree: false,
  },
)
process.stdout.write(`${JSON.stringify({
  ok: true,
  target,
  baseline_commit: finalized.baseline_commit ?? null,
  upgrade,
  runtime_variant: runtimeVariantLabel(runtimeSettings?.variant),
  registration,
  ready: true,
  started: {
    pid: started.pid ?? null,
    log: started.log ?? null,
  },
}, null, args.json ? 0 : 2)}\n`)

async function upgradeFinalizedProject(root) {
  const release = await readJson(path.join(skillDirectory, "..", "assets", "control-plane-release.json"), {
    maxBytes: CONFIG_BYTES,
  })
  const installed = await readJson(path.join(root, ".autopilot", "control-plane.json"), {
    maxBytes: CONFIG_BYTES,
  })
  if (installed.version === release.version) {
    return { changed: false, from_version: installed.version, to_version: release.version }
  }
  return runJson(
    process.execPath,
    [upgrader, "--target", root, "--source-skill", path.join(skillDirectory, ".."), "--json"],
    root,
    "Control Plane project upgrade",
    { timeoutMs: FINALIZE_TIMEOUT_MS, env: baseChildEnvironment() },
  )
}

async function registerFinalizedProject(root) {
  const explicitHome = process.env.OPENCODE_CONTROL_PLANE_HOME
  const home = path.resolve(explicitHome || os.homedir())
  const installedBin = path.join(home, ".agents", "skills", "init-project", "bin")
  if (!explicitHome && pathKey(skillDirectory) !== pathKey(installedBin)) {
    return { ok: true, registered: false, skipped: "source checkout finalization" }
  }
  try {
    const result = await registerProject(root, { home })
    return { ok: true, registered: true, added: result.added, id: result.project.id }
  } catch (error) {
    return { ok: false, registered: false, error: boundedDiagnostic(error?.message ?? error).replace(/^: /, "") }
  }
}

function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
}

async function controllerChildContext(root, source = process.env) {
  const configFile = path.join(root, ".autopilot", "config.json")
  await assertPrivateFile(root, configFile, "closeout controller configuration")
  const config = await readJson(configFile, { maxBytes: CONFIG_BYTES })
  assertNoIssues(validateConfig(config), "Closeout controller config")
  const env = baseChildEnvironment(source)
  const rawSecretValues = new Set()
  let providerEnvironmentBytes = 1
  for (const name of config.opencode?.provider_environment ?? []) {
    const value = source[name]
    if (typeof value !== "string") continue
    const valueBytes = Buffer.byteLength(value, "utf8")
    if (valueBytes > PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES) {
      throw new Error(
        `OpenCode provider environment variable ${name} exceeds ${PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES} bytes`,
      )
    }
    providerEnvironmentBytes += Buffer.byteLength(`${name}=${value}\0`, "utf8")
    if (providerEnvironmentBytes > PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES) {
      throw new Error(
        `OpenCode provider environment exceeds the ${PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES}-byte aggregate cap`,
      )
    }
    env[name] = value
    if (value.length >= 4) rawSecretValues.add(value)
  }
  if (typeof source.OPENCODE_AUTH_CONTENT === "string" && source.OPENCODE_AUTH_CONTENT) {
    const raw = source.OPENCODE_AUTH_CONTENT
    if (Buffer.byteLength(raw, "utf8") > CONFIG_BYTES) {
      throw new Error(`OPENCODE_AUTH_CONTENT exceeds ${CONFIG_BYTES} bytes`)
    }
    let auth
    try { auth = JSON.parse(raw) }
    catch { throw new Error("OPENCODE_AUTH_CONTENT is invalid JSON") }
    if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
      throw new Error("OPENCODE_AUTH_CONTENT must contain one top-level JSON object")
    }
    env.OPENCODE_AUTH_CONTENT = raw
    rawSecretValues.add(raw)
    for (const value of nestedStringValues(auth)) {
      if (value.length >= 4) rawSecretValues.add(value)
    }
  }
  if (typeof source.XDG_DATA_HOME === "string" && source.XDG_DATA_HOME) {
    env.XDG_DATA_HOME = source.XDG_DATA_HOME
  }
  return {
    env,
    secretValues: exactSecretVariants([...rawSecretValues], {
      maxSecrets: MAX_DIAGNOSTIC_SECRET_VALUES,
      maxEncodedSecretBytes: MAX_ENCODED_SECRET_BYTES,
    }),
  }
}

function nestedStringValues(value) {
  const strings = []
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === "string") {
      strings.push(current)
      if (strings.length > MAX_AUTH_STRING_VALUES) {
        throw new Error(`OPENCODE_AUTH_CONTENT exceeds ${MAX_AUTH_STRING_VALUES} nested string values`)
      }
    }
    else if (Array.isArray(current)) {
      for (const item of current) pending.push(item)
    } else if (current && typeof current === "object") {
      for (const item of Object.values(current)) pending.push(item)
    }
  }
  return strings
}

function baseChildEnvironment(source = process.env) {
  return {
    ...safeBaseEnv(source),
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    SSH_ASKPASS_REQUIRE: "never",
  }
}

async function runJson(command, commandArgs, cwd, label, {
  allowNotReady = false,
  timeoutMs,
  env,
  secretValues = [],
  guardProcessTree = true,
} = {}) {
  let raw
  try {
    raw = await runArgv([command, ...commandArgs], {
      cwd,
      env,
      timeoutMs,
      maxOutputBytes: PROCESS_OUTPUT_BYTES,
      guardProcessTree,
    })
  } catch (error) {
    throw new Error(`${label} could not start${boundedDiagnostic(error?.message ?? error, secretValues)}`)
  }
  const result = sanitizeProcessResult(raw, secretValues, PROCESS_OUTPUT_BYTES)
  if (result.timed_out) {
    throw new Error(`${label} timed out after ${timeoutMs} ms${boundedDiagnostic(result.stderr || result.stdout, secretValues)}`)
  }
  if (result.output_truncated) {
    throw new Error(
      `${label} exceeded the ${PROCESS_OUTPUT_BYTES}-byte output cap${boundedDiagnostic(result.stderr || result.stdout, secretValues)}`,
    )
  }
  let parsed
  try { parsed = JSON.parse(result.stdout) }
  catch {
    throw new Error(`${label} did not return controller JSON${boundedDiagnostic(result.stderr || result.stdout, secretValues)}`)
  }
  if (result.code !== 0 && !(allowNotReady && parsed?.ready === false)) {
    throw new Error(`${label} failed${boundedDiagnostic(parsed?.error ?? result.stderr, secretValues)}`)
  }
  return parsed
}

function failedChecks(report) {
  const result = []
  for (const issue of report.validation?.issues ?? []) {
    result.push({ kind: "validation", location: issue.location ?? null, message: issue.message ?? String(issue) })
  }
  for (const kind of ["structure", "git", "opencode"]) {
    const item = report[kind]
    if (item?.ok === false) result.push({ kind, error: item.error ?? { code: "ERROR", message: "Check failed" } })
  }
  for (const item of report.phases ?? []) {
    if (item.ok) continue
    result.push({
      kind: "phase",
      task_id: item.task_id,
      phase: item.phase,
      agent: item.agent,
      credential_profile: item.credential_profile,
      error: item.error,
    })
  }
  for (const item of report.gates ?? []) {
    if (item.ok) continue
    result.push({
      kind: "gate",
      gate_id: item.gate_id,
      credential_profile: item.credential_profile,
      error: item.error,
    })
  }
  return result
}

function boundedDiagnostic(value, secretValues = []) {
  if (value === undefined || value === null || value === "") return ""
  const sanitized = sanitizeProcessResult(
    { stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", output_truncated: false },
    secretValues,
    ERROR_OUTPUT_BYTES,
  ).stdout
  const normalized = sanitized.replace(/[\r\n]+/g, " ").trim()
  return normalized ? `: ${normalized}` : ""
}

function parseArgs(argv) {
  const result = { target: undefined, json: false, start: false, variant: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--target") {
      const target = argv[++index]
      if (!target || target.startsWith("--")) throw new Error("--target requires a path")
      result.target = target
    } else if (value === "--json") result.json = true
    else if (value === "--start") result.start = true
    else if (value === "--variant") {
      const variant = argv[++index]
      if (!variant || variant.startsWith("--")) throw new Error("--variant requires default or a provider variant ID")
      result.variant = variant
    }
    else if (value === "--help") {
      process.stdout.write("Usage: finalize-and-launch.mjs [--target PATH] [--variant ID|default] [--start] [--json]\n")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  return result
}
