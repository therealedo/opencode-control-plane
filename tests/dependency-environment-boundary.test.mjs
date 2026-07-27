import assert from "node:assert/strict"
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { validatePhaseToolUsage } from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/contracts.mjs"
import { createScaffold, git, readJson, run, writeJson } from "./runtime-helpers.mjs"

const ENGINE_ERROR = "DEPENDENCY_NODE_ENGINE_UNSUPPORTED"
const ENGINE_SECRET = "engine-diagnostic-must-not-persist-7264"

function controllerEnvironment(bin, temporary) {
  const sourcePath = process.env.Path ?? process.env.PATH ?? ""
  const environment = {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  }
  if (process.platform === "win32") {
    environment.Path = [bin, sourcePath].filter(Boolean).join(path.delimiter)
    delete environment.PATH
  } else {
    environment.PATH = [bin, sourcePath].filter(Boolean).join(path.delimiter)
    delete environment.Path
  }
  return environment
}

async function readNdjson(file) {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function createEnvironmentFailureExecutables(t, openCodeMode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocp-environment-boundary-"))
  const bin = path.join(directory, "bin")
  const corepackObservations = path.join(directory, "corepack.ndjson")
  const openCodeObservations = path.join(directory, "opencode.ndjson")
  const fakeCorepack = path.join(directory, "fake-corepack.mjs")
  const fakeOpenCode = path.join(directory, "fake-opencode.mjs")
  await mkdir(bin, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))

  await writeFile(fakeCorepack, [
    "#!/usr/bin/env node",
    'import { appendFile } from "node:fs/promises"',
    `const observations = ${JSON.stringify(corepackObservations)}`,
    "const argv = process.argv.slice(2)",
    'await appendFile(observations, `${JSON.stringify({ argv, cwd: process.cwd() })}\\n`, "utf8")',
    'if (argv[0] !== "pnpm" || !["--version", "install"].includes(argv[1])) {',
    '  process.stderr.write("unexpected fake Corepack invocation\\n")',
    "  process.exit(17)",
    "}",
    'if (argv[1] === "--version") { process.stdout.write("11.14.0\\n"); process.exit(0) }',
    "process.stderr.write(JSON.stringify({",
    '  name: "pnpm:install",',
    `  err: { code: "ERR_PNPM_UNSUPPORTED_ENGINE", message: "Unsupported environment; token=${ENGINE_SECRET}" },`,
    '}) + "\\n")',
    "process.exit(1)",
    "",
  ].join("\n"), "utf8")

  await writeFile(fakeOpenCode, [
    "#!/usr/bin/env node",
    'import { appendFile, writeFile } from "node:fs/promises"',
    'import path from "node:path"',
    'import { pathToFileURL } from "node:url"',
    `const mode = ${JSON.stringify(openCodeMode)}`,
    `const observations = ${JSON.stringify(openCodeObservations)}`,
    "const argv = process.argv.slice(2)",
    'if (argv.includes("--version")) { process.stdout.write("fake-opencode environment-1.0\\n"); process.exit(0) }',
    'if (argv.includes("--help")) { process.stdout.write("Usage: opencode run [message..]\\n"); process.exit(0) }',
    'const prompt = argv.at(-1) ?? ""',
    'const stage = /^Stage:\\s*(\\S+)/m.exec(prompt)?.[1] ?? "unknown"',
    'const taskId = /^Task:\\s*(\\S+)/m.exec(prompt)?.[1] ?? "unknown"',
    'const attempt = Number(/^Attempt:\\s*(\\d+)/m.exec(prompt)?.[1] ?? 0)',
    'const observation = { stage, task_id: taskId, attempt }',
    'if (!["phase-lockfile", "phase-lockfile-exit"].includes(mode)) {',
    '  await appendFile(observations, `${JSON.stringify(observation)}\\n`, "utf8")',
    '  process.stderr.write("OpenCode session must not launch before the environment boundary\\n")',
    "  process.exit(41)",
    "}",
    'const toolsDirectory = path.join(process.env.OPENCODE_CONFIG_DIR, "tools")',
    'await writeFile(path.join(toolsDirectory, "package.json"), "{\\"type\\":\\"module\\"}\\n", "utf8")',
    'const tools = await import(`${pathToFileURL(path.join(toolsDirectory, "autopilot.js")).href}?pid=${process.pid}`)',
    "const manifest = JSON.stringify({",
    '  name: "environment-boundary-fixture", private: true, packageManager: "pnpm@11.14.0",',
    '  engines: { node: ">=24.18.0" }, dependencies: { "left-pad": "1.3.0" },',
    '}, null, 2) + "\\n"',
    'observation.write = await tools.write.execute({ path: "package.json", content: manifest })',
    "observation.lockfile = JSON.parse(await tools.lockfile.execute({}))",
    'await appendFile(observations, `${JSON.stringify(observation)}\\n`, "utf8")',
    'if (mode === "phase-lockfile-exit") {',
    '  process.stderr.write("worker stopped after dependency environment fault\\n")',
    "  process.exit(7)",
    "}",
    'process.stdout.write(`${JSON.stringify({ type: "session", sessionID: `environment-a${attempt}-${process.pid}` })}\\n`)',
    "",
  ].join("\n"), "utf8")

  if (process.platform === "win32") {
    const corepackPackage = path.join(bin, "node_modules", "corepack")
    const distribution = path.join(corepackPackage, "dist")
    await mkdir(distribution, { recursive: true })
    await Promise.all([
      copyFile(process.execPath, path.join(bin, "node.exe")),
      copyFile(fakeCorepack, path.join(distribution, "corepack.js")),
      writeFile(path.join(bin, "corepack.cmd"), "@exit /b 17\r\n", "utf8"),
      writeFile(path.join(corepackPackage, "package.json"), '{"type":"module"}\n', "utf8"),
    ])
  } else {
    const corepack = path.join(bin, "corepack")
    await writeFile(
      corepack,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCorepack)} "$@"\n`,
      "utf8",
    )
    await chmod(corepack, 0o755)
    await chmod(fakeOpenCode, 0o755)
  }
  return { bin, corepackObservations, fakeOpenCode, openCodeObservations }
}

async function configureController(root, fakeOpenCode, { manifestPresent }) {
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const configFile = path.join(root, ".autopilot", "config.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "src/**"]
  queue.tasks.M001.risk = "low"
  await writeJson(queueFile, queue)
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, fakeOpenCode]
  config.opencode.provider_auth_mode = "none"
  config.opencode.provider_environment = []
  config.opencode.timeout_seconds = 60
  await writeJson(configFile, config)
  if (manifestPresent) {
    await writeJson(path.join(root, "package.json"), {
      name: "environment-boundary-fixture",
      private: true,
      packageManager: "pnpm@11.14.0",
      engines: { node: ">=24.18.0" },
      dependencies: { "left-pad": "1.3.0" },
    })
  }
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-m", "test: configure dependency environment boundary"])
}

test("pre-dispatch engine failure stops at an attempt-zero environment boundary", {
  timeout: 120_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-pre-dispatch-environment-"))
  const executables = await createEnvironmentFailureExecutables(t, "must-not-launch")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureController(root, executables.fakeOpenCode, { manifestPresent: true })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: controllerEnvironment(executables.bin, runtimeParent), timeoutMs: 90_000 },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.equal(state.phase, "blocked")
  assert.equal(state.attempt, 0)
  assert.equal(state.blocker?.kind, "environment")
  assert.equal(state.blocker?.error_code, ENGINE_ERROR)
  assert.deepEqual(state.last_failure_evidence?.environment_faults, [{
    operation: "dependency-lock",
    error_code: ENGINE_ERROR,
  }])
  assert.equal(Object.hasOwn(state.last_failure_evidence ?? {}, "controller_faults"), false)
  assert.deepEqual(state.task_tool_usage, {})
  assert.deepEqual(await readNdjson(executables.openCodeObservations), [])
  assert.deepEqual(
    (await readNdjson(executables.corepackObservations)).map((entry) => entry.argv.slice(0, 2)),
    [["pnpm", "--version"], ["pnpm", "install"]],
  )
  assert.doesNotMatch(JSON.stringify(state), new RegExp(ENGINE_SECRET))
})

test("a known failure after dispatch journaling but before process spawn refunds the attempt", {
  timeout: 120_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-process-predispatch-"))
  const executables = await createEnvironmentFailureExecutables(t, "must-not-launch")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureController(root, executables.fakeOpenCode, { manifestPresent: false })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: {
        ...controllerEnvironment(executables.bin, runtimeParent),
        NODE_ENV: "test",
        AUTOPILOT_TEST_FAIL_BEFORE_PHASE_PROCESS: "execute",
      },
      timeoutMs: 90_000,
    },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.equal(state.attempt, 0)
  assert.equal(state.blocker?.kind, "controller_tooling")
  assert.equal(state.blocker?.error_code, "OPENCODE_PREDISPATCH_FAILED")
  assert.deepEqual(state.task_tool_usage, {})
  assert.deepEqual(await readNdjson(executables.openCodeObservations), [])
})

test("a lockfile-reported environment fault is accepted, bounded, and refunds the phase attempt", {
  timeout: 120_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-phase-environment-"))
  const executables = await createEnvironmentFailureExecutables(t, "phase-lockfile")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureController(root, executables.fakeOpenCode, { manifestPresent: false })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: controllerEnvironment(executables.bin, runtimeParent), timeoutMs: 90_000 },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const observations = await readNdjson(executables.openCodeObservations)
  const usage = state.task_tool_usage?.["execute:a1"]
  assert.equal(state.status, "human_required", JSON.stringify({ state, observations }, null, 2))
  assert.equal(state.phase, "blocked")
  assert.equal(state.attempt, 0)
  assert.equal(state.blocker?.kind, "environment")
  assert.equal(state.blocker?.error_code, ENGINE_ERROR)
  assert.deepEqual(observations.map((entry) => [entry.stage, entry.attempt]), [["execute", 1]])
  assert.equal(observations[0].lockfile.classification, "environment_failure")
  assert.equal(observations[0].lockfile.error_code, ENGINE_ERROR)
  assert.deepEqual(usage.environment_faults, [{ operation: "dependency-lock", error_code: ENGINE_ERROR }])
  assert.equal(Object.hasOwn(usage, "controller_faults"), false)
  assert.equal(validatePhaseToolUsage(usage, { phase: "execute", taskId: "M001" }).length, 0)
  assert.deepEqual(state.last_failure_evidence.environment_faults, usage.environment_faults)
  assert.equal(Object.hasOwn(state.last_failure_evidence, "controller_faults"), false)
  assert.equal(usage.by_tool.lockfile.calls, 1)
  assert.doesNotMatch(JSON.stringify({ state, observations }), new RegExp(ENGINE_SECRET))
  await access(path.join(root, "package.json"))

  const oversized = structuredClone(usage)
  oversized.environment_faults = Array.from({ length: 9 }, (_, index) => ({
    operation: `dependency-${index}`,
    error_code: `DEPENDENCY_ENVIRONMENT_${index}`,
  }))
  assert.ok(validatePhaseToolUsage(oversized, { phase: "execute", taskId: "M001" })
    .some((issue) => issue.location.endsWith("environment_faults")))
})

test("a failed OpenCode process retains its environment-fault usage and refunds the attempt", {
  timeout: 120_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-failed-phase-environment-"))
  const executables = await createEnvironmentFailureExecutables(t, "phase-lockfile-exit")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureController(root, executables.fakeOpenCode, { manifestPresent: false })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: controllerEnvironment(executables.bin, runtimeParent), timeoutMs: 90_000 },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const observations = await readNdjson(executables.openCodeObservations)
  const usage = state.task_tool_usage?.["execute:a1"]
  assert.equal(state.status, "human_required", JSON.stringify({ state, observations }, null, 2))
  assert.equal(state.phase, "blocked")
  assert.equal(state.attempt, 0)
  assert.equal(state.blocker?.kind, "environment")
  assert.equal(state.blocker?.error_code, ENGINE_ERROR)
  assert.deepEqual(observations.map((entry) => [entry.stage, entry.attempt]), [["execute", 1]])
  assert.equal(observations[0].lockfile.classification, "environment_failure")
  assert.deepEqual(usage.environment_faults, [{ operation: "dependency-lock", error_code: ENGINE_ERROR }])
  assert.equal(Object.hasOwn(usage, "controller_faults"), false)
  assert.equal(validatePhaseToolUsage(usage, { phase: "execute", taskId: "M001" }).length, 0)
  assert.deepEqual(state.last_failure_evidence.environment_faults, usage.environment_faults)
  assert.equal(Object.hasOwn(state.last_failure_evidence, "controller_faults"), false)
  assert.equal(state.last_session, null)
  assert.deepEqual(state.session_ids, [])

  // Restore the same pre-dispatch shape so the second refunded dispatch reaches
  // the worker again instead of being caught by the new root manifest probe.
  await rm(path.join(root, "package.json"), { force: true })
  const resumed = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
    { cwd: root, env: controllerEnvironment(executables.bin, runtimeParent), timeoutMs: 90_000 },
  )
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const retriedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(retriedState.attempt, 0)
  assert.equal(retriedState.cycle, 2)
  assert.deepEqual(Object.keys(retriedState.task_tool_usage), ["execute:a1", "execute:a1:c2"])
  assert.ok(Object.values(retriedState.task_tool_usage).every((entry) =>
    entry.environment_faults?.[0]?.error_code === ENGINE_ERROR))
  assert.deepEqual(
    (await readNdjson(executables.openCodeObservations)).map((entry) => [entry.stage, entry.attempt]),
    [["execute", 1], ["execute", 1]],
  )
})

test("controller and environment fault ledgers remain independent bounded fields", () => {
  const usage = {
    schema_version: 1,
    phase: "execute",
    task_id: "M001",
    tool_calls: 1,
    returned_bytes: 32,
    by_tool: { lockfile: { calls: 1, returned_bytes: 32 } },
    controller_faults: [{
      operation: "dependency-lock",
      error_code: "DEPENDENCY_RUNNER_PROTOCOL_INVALID",
    }],
    environment_faults: [{
      operation: "dependency-lock",
      error_code: ENGINE_ERROR,
    }],
  }
  assert.deepEqual(validatePhaseToolUsage(usage, { phase: "execute", taskId: "M001" }), [])
  assert.notDeepEqual(usage.controller_faults, usage.environment_faults)

  const controllerOverflow = structuredClone(usage)
  controllerOverflow.controller_faults = Array.from({ length: 9 }, (_, index) => ({
    operation: `controller-${index}`,
    error_code: `CONTROLLER_FAILURE_${index}`,
  }))
  const issues = validatePhaseToolUsage(controllerOverflow, { phase: "execute", taskId: "M001" })
  assert.ok(issues.some((issue) => issue.location.endsWith("controller_faults")))
  assert.equal(issues.some((issue) => issue.location.endsWith("environment_faults")), false)
})
