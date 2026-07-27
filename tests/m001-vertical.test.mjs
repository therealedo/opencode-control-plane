import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createScaffold,
  fixedGateScript,
  git,
  readJson,
  run,
  writeJson,
} from "./runtime-helpers.mjs"

function executableEnvironment(bin, temporary) {
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

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function createLocalExecutables(t, mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocp-m001-tools-"))
  const fixtureIntegrity = createHash("sha512")
    .update("offline-vertical-fixture")
    .digest("base64")
  const bin = path.join(directory, "bin")
  const observationFile = path.join(directory, "observations.ndjson")
  const corepackObservationFile = path.join(directory, "corepack.ndjson")
  const fakeOpenCode = path.join(directory, "fake-opencode.mjs")
  const fakeCorepack = path.join(directory, "fake-corepack.mjs")
  await mkdir(bin, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))

  await writeFile(
    fakeCorepack,
    [
      "#!/usr/bin/env node",
      'import { appendFile, mkdir, writeFile } from "node:fs/promises"',
      'import path from "node:path"',
      "",
      `const mode = ${JSON.stringify(mode)}`,
      `const observationFile = ${JSON.stringify(corepackObservationFile)}`,
      "const argv = process.argv.slice(2)",
      'if (argv[0] !== "pnpm" || !["--version", "install"].includes(argv[1])) {',
      '  process.stderr.write("unexpected fake Corepack argv\\n")',
      "  process.exit(17)",
      "}",
      "await appendFile(observationFile, `${JSON.stringify({ argv, cwd: process.cwd() })}\\n`, \"utf8\")",
      'if (argv[1] === "--version") { process.stdout.write("11.14.0\\n"); process.exit(0) }',
      'if (mode === "success") {',
      '  const packageDirectory = path.join(process.cwd(), "apps", "web", "node_modules", "@fixture", "local")',
      '  const virtualStoreDirectory = path.join(process.cwd(), "node_modules", ".pnpm")',
      "  await Promise.all([",
      "    mkdir(packageDirectory, { recursive: true }),",
      "    mkdir(virtualStoreDirectory, { recursive: true }),",
      "  ])",
      "  const lockText = [",
      '    "lockfileVersion: \'9.0\'",',
      '    "settings:",',
      '    "  autoInstallPeers: true",',
      '    "  excludeLinksFromLockfile: false",',
      '    "importers:",',
      '    "  .: {}",',
      '    "  apps/web:",',
      '    "    dependencies:",',
      "    \"      '@fixture/local':\",",
      '    "        specifier: 1.0.0",',
      '    "        version: 1.0.0",',
      '    "packages:",',
      "    \"  '@fixture/local@1.0.0':\",",
      '    "    resolution:",',
      `    "      integrity: sha512-${fixtureIntegrity}",`,
      '    "snapshots:",',
      "    \"  '@fixture/local@1.0.0': {}\",",
      '    "",',
      '  ].join("\\n")',
      "  const writes = [writeFile(path.join(virtualStoreDirectory, \"lock.yaml\"), lockText, \"utf8\")]",
      '  if (argv.includes("--frozen-lockfile=false")) {',
      '    writes.push(writeFile(path.join(process.cwd(), "pnpm-lock.yaml"), lockText, "utf8"))',
      "  }",
      "  await Promise.all(writes)",
      '  await writeFile(path.join(process.cwd(), "node_modules", ".modules.yaml"), "layoutVersion: 5\\n", "utf8")',
      "  await writeFile(path.join(packageDirectory, \"package.json\"), `${JSON.stringify({",
      '    name: "@fixture/local", version: "1.0.0",',
      '  })}\\n`, "utf8")',
      "}",
      'process.stdout.write("offline fake Corepack completed\\n")',
      "",
    ].join("\n"),
    "utf8",
  )

  await writeFile(
    fakeOpenCode,
    [
      "#!/usr/bin/env node",
      'import { appendFile, mkdir, writeFile } from "node:fs/promises"',
      'import path from "node:path"',
      'import { pathToFileURL } from "node:url"',
      "",
      `const observationFile = ${JSON.stringify(observationFile)}`,
      "const argv = process.argv.slice(2)",
      'if (argv.includes("--version")) { process.stdout.write("fake-opencode vertical-1.0\\n"); process.exit(0) }',
      'if (argv.includes("--help")) { process.stdout.write("Usage: opencode run [message..]\\n"); process.exit(0) }',
      'const prompt = argv.at(-1) ?? ""',
      'const stage = /^Stage:\\s*(\\S+)/m.exec(prompt)?.[1] ?? "unknown"',
      'const taskId = /^Task:\\s*(\\S+)/m.exec(prompt)?.[1] ?? "unknown"',
      'const attempt = Number(/^Attempt:\\s*(\\d+)/m.exec(prompt)?.[1] ?? 0)',
      "const sessionID = `vertical-${stage}-a${attempt}-p${process.pid}`",
      'const toolsDirectory = path.join(process.env.OPENCODE_CONFIG_DIR, "tools")',
      'await writeFile(path.join(toolsDirectory, "package.json"), "{\\"type\\":\\"module\\"}\\n", "utf8")',
      'const tools = await import(`${pathToFileURL(path.join(toolsDirectory, "autopilot.js")).href}?pid=${process.pid}`)',
      "const observation = { stage, task_id: taskId, attempt, session_id: sessionID }",
      'if (stage === "review") {',
      "  observation.contract = await tools.contract.execute({",
      '    status: "approved",',
      '    summary: "Offline vertical reviewer approved controller-owned evidence.",',
      "    findings: [],",
      "  })",
      "} else {",
      '  if (taskId === "M001") observation.dependency = JSON.parse(await tools.lockfile.execute({}))',
      '  if (taskId !== "M001" || observation.dependency.classification === "success") {',
      '    const output = taskId === "M002"',
      '      ? { path: "src/m002.txt", content: "M002\\n", gate: "source" }',
      '      : { path: "src/result.txt", content: "GOOD\\n", gate: "feedback" }',
      "    observation.write = await tools.write.execute({ path: output.path, content: output.content })",
      "    observation.feedback = JSON.parse(await tools.check.execute({ gate_id: output.gate }))",
      "    observation.contract = await tools.contract.execute({",
      '      status: "complete",',
      '      summary: `Offline ${taskId} implementation and feedback proof completed.`,',
      "      environment_variables: [],",
      "      blocker: null,",
      "    })",
      "  }",
      "}",
      'await appendFile(observationFile, `${JSON.stringify(observation)}\\n`, "utf8")',
      "process.stdout.write(`${JSON.stringify({ type: \"session\", sessionID })}\\n`)",
      "",
    ].join("\n"),
    "utf8",
  )

  if (process.platform === "win32") {
    const corepackPackage = path.join(bin, "node_modules", "corepack")
    const corepackDistribution = path.join(corepackPackage, "dist")
    await mkdir(corepackDistribution, { recursive: true })
    await Promise.all([
      copyFile(process.execPath, path.join(bin, "node.exe")),
      copyFile(fakeCorepack, path.join(corepackDistribution, "corepack.js")),
      writeFile(path.join(bin, "corepack.cmd"), "@exit /b 17\r\n", "utf8"),
      writeFile(path.join(corepackPackage, "package.json"), '{"type":"module"}\n', "utf8"),
    ])
  } else {
    const corepackExecutable = path.join(bin, "corepack")
    await writeFile(
      corepackExecutable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCorepack)} "$@"\n`,
      "utf8",
    )
    await chmod(corepackExecutable, 0o755)
    await chmod(fakeOpenCode, 0o755)
  }

  return {
    bin,
    corepackObservationFile,
    fakeOpenCode,
    observationFile,
  }
}

async function configureM001(root, fakeOpenCode) {
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const configFile = path.join(root, ".autopilot", "config.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.title = "Establish the pinned offline workspace"
  queue.tasks.M001.allowed_paths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web", "src/**"]
  queue.tasks.M001.gates = ["feedback", "authoritative"]
  queue.tasks.M001.risk = "low"
  await writeJson(queueFile, queue)
  await writeFile(
    path.join(root, ".project", "plan", "milestones", "M001.md"),
    [
      "# M001 - Establish the pinned offline workspace",
      "",
      "Resolve the exactly pinned dependency graph without scripts or credentials,",
      "then create `src/result.txt` containing `GOOD`.",
      "",
      "Acceptance requires same-session feedback, controller-owned authoritative",
      "gates, an independent review, and a durable receipt.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeJson(gatesFile, {
    schema_version: 2,
    gates: {
      feedback: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/result.txt", "GOOD"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      authoritative: {
        argv: [process.execPath, fixedGateScript, "finalize", "src/result.txt"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: false,
      },
    },
    final_gates: ["authoritative"],
  })
  await writeJson(path.join(root, "package.json"), {
    name: "offline-m001",
    private: true,
    type: "module",
    packageManager: "pnpm@11.14.0",
  })
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8")
  await mkdir(path.join(root, "apps", "web"), { recursive: true })
  await writeJson(path.join(root, "apps", "web", "package.json"), {
    name: "@offline/web",
    private: true,
    dependencies: {
      "@fixture/local": "1.0.0",
    },
  })
  await writeFile(path.join(root, ".npmrc"), "save-exact=true\n", "utf8")
  const gitignoreFile = path.join(root, ".gitignore")
  const gitignore = await readFile(gitignoreFile, "utf8")
  await writeFile(
    gitignoreFile,
    `node_modules/\n${gitignore}`,
    "utf8",
  )
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, fakeOpenCode]
  config.opencode.provider_auth_mode = "none"
  config.opencode.provider_environment = []
  config.opencode.timeout_seconds = 60
  await writeJson(configFile, config)
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-m", "test: finalize offline M001 fixture"])
  return git(root, ["rev-parse", "HEAD"])
}

async function configureSourceOnlyM002(root) {
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.gates = ["feedback"]
  queue.tasks.M002 = {
    title: "Complete the source-only follow-up",
    status: "ready",
    priority: 90,
    depends_on: ["M001"],
    spec: ".project/plan/milestones/M002.md",
    context: { shared: ["task"], execute: [], repair: [], review: [] },
    allowed_paths: ["src/m002.txt"],
    gates: ["source", "authoritative"],
    tool_grants: { execute: [], repair: [], review: [] },
    risk: "low",
    attempt_limit: 3,
  }
  await writeJson(queueFile, queue)
  await writeFile(
    path.join(root, ".project", "plan", "milestones", "M002.md"),
    "# M002 - Complete the source-only follow-up\n\nCreate `src/m002.txt` containing `M002`.\n",
    "utf8",
  )
  const gates = await readJson(gatesFile)
  gates.gates.source = {
    argv: [process.execPath, fixedGateScript, "expect-file", "src/m002.txt", "M002"],
    timeout_seconds: 30,
    credential_profile: null,
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: true,
  }
  gates.gates.authoritative.argv = [
    process.execPath,
    fixedGateScript,
    "expect-file",
    "src/m002.txt",
    "M002",
  ]
  await writeJson(gatesFile, gates)
  await git(root, ["add", ".project"])
  await git(root, ["commit", "-m", "test: add source-only follow-up task"])
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

async function assertNoTemporaryRuntime(root, temporary) {
  const identity = process.platform === "win32"
    ? path.resolve(root).toLocaleLowerCase("en-US")
    : path.resolve(root)
  const rootHash = createHash("sha256").update(identity).digest("hex").slice(0, 16)
  const forbiddenPrefixes = [
    `autopilot-${rootHash}-opencode-phase-`,
    `autopilot-${rootHash}-opencode-probe-`,
    `autopilot-${rootHash}-gate-`,
    "ocp-dependency-",
  ]
  const leftovers = (await readdir(temporary))
    .filter((name) => forbiddenPrefixes.some((prefix) => name.startsWith(prefix)))
  assert.deepEqual(leftovers, [], `stale controller runtimes: ${leftovers.join(", ")}`)
}

test("offline initialized M001 completes through dependency, tool, gate, review, and receipt boundaries", {
  timeout: 240_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-m001-runtimes-"))
  const executables = await createLocalExecutables(t, "success")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  const baseline = await configureM001(root, executables.fakeOpenCode)
  const environment = executableEnvironment(executables.bin, runtimeParent)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: environment },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)

  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const earlyCorepackInvocations = await readNdjson(executables.corepackObservationFile)
  let dependencyFiles = []
  let installedPackage = null
  let modulesMetadata = null
  try {
    dependencyFiles = await readdir(path.join(root, "node_modules"), { recursive: true })
    installedPackage = await readFile(
      path.join(root, "node_modules", "@fixture", "local", "package.json"),
      "utf8",
    )
    modulesMetadata = await readFile(path.join(root, "node_modules", ".modules.yaml"), "utf8")
  } catch {}
  assert.equal(state.status, "complete", JSON.stringify({
    state,
    queue,
    result,
    corepack: earlyCorepackInvocations,
    dependency_files: dependencyFiles,
    installed_package: installedPackage,
    modules_metadata: modulesMetadata,
  }, null, 2))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const finalReceipt = await readJson(
    path.join(root, ".project", "receipts", "__project-final.json"),
  )
  const observations = await readNdjson(executables.observationFile)
  const corepackInvocations = await readNdjson(executables.corepackObservationFile)
  const execution = observations.find((entry) => entry.stage === "execute")

  assert.equal(queue.project_status, "complete")
  assert.equal(queue.tasks.M001.status, "done")
  assert.equal(state.attempt, 0)
  assert.equal((await readFile(path.join(root, "src", "result.txt"), "utf8")).trim(), "GOOD")
  assert.equal(execution.dependency.schema_version, 1)
  assert.equal(execution.dependency.operation, "dependency-lock")
  assert.equal(execution.dependency.classification, "success")
  assert.equal(execution.dependency.success, true)
  assert.equal(execution.dependency.package_manager, "pnpm@11.14.0")
  assert.equal(execution.feedback.schema_version, 1)
  assert.equal(execution.feedback.operation, "gate")
  assert.equal(execution.feedback.classification, "success")
  assert.equal(execution.feedback.gate_id, "feedback")
  assert.equal(execution.feedback.success, true)
  assert.deepEqual(
    corepackInvocations.map((entry) => entry.argv.slice(0, 2)),
    [["pnpm", "--version"], ["pnpm", "install"], ["pnpm", "install"]],
  )
  assert.equal(corepackInvocations[1].argv.includes("--frozen-lockfile=false"), true)
  assert.equal(corepackInvocations[2].argv.includes("--frozen-lockfile"), true)
  assert.equal(corepackInvocations[2].argv.includes("--offline"), true)
  await access(path.join(root, "node_modules", ".opencode-dependency-state.json"))
  assert.match(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"), /^packages:/m)

  assert.equal(receipt.baseline_commit, baseline)
  assert.equal(receipt.review.status, "approved")
  assert.deepEqual(Object.keys(receipt.tool_usage), ["execute:a1", "review:a1"])
  assert.deepEqual(receipt.tool_usage["execute:a1"].by_tool, {
    check: { calls: 1, returned_bytes: receipt.tool_usage["execute:a1"].by_tool.check.returned_bytes },
    contract: { calls: 1, returned_bytes: receipt.tool_usage["execute:a1"].by_tool.contract.returned_bytes },
    lockfile: { calls: 1, returned_bytes: receipt.tool_usage["execute:a1"].by_tool.lockfile.returned_bytes },
    write: { calls: 1, returned_bytes: receipt.tool_usage["execute:a1"].by_tool.write.returned_bytes },
  })
  assert.equal(receipt.tool_usage["execute:a1"].tool_calls, 4)
  assert.equal(receipt.tool_usage["review:a1"].tool_calls, 1)
  assert.deepEqual(
    receipt.gates.map(({ gate_id, success }) => ({ gate_id, success })),
    [
      { gate_id: "feedback", success: true },
      { gate_id: "authoritative", success: true },
    ],
  )
  for (const gate of receipt.gates) {
    assert.match(gate.gate_definition_sha256, /^[0-9a-f]{64}$/)
    const artifact = await readJson(path.join(root, ...gate.artifact.split("/")))
    assert.equal(artifact.schema_version, 1)
    assert.equal(artifact.operation, "gate")
    assert.equal(artifact.classification, "success")
    assert.equal(artifact.success, true)
    assert.equal(artifact.cleanup.success, true)
  }
  assert.equal(finalReceipt.gates[0].gate_id, "authoritative")
  assert.equal(finalReceipt.gates[0].success, true)
  assert.deepEqual(observations.map((entry) => entry.stage), ["execute", "review"])
  assert.equal(await git(root, ["status", "--porcelain"]), "")
  await assertNoTemporaryRuntime(root, runtimeParent)
})

test("a source-only later task hydrates the committed dependency graph before dispatch", {
  timeout: 240_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-m002-hydration-runtimes-"))
  const executables = await createLocalExecutables(t, "success")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureM001(root, executables.fakeOpenCode)
  await configureSourceOnlyM002(root)
  const environment = executableEnvironment(executables.bin, runtimeParent)
  const command = [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"]

  const interrupted = await run(command, {
    cwd: root,
    env: {
      ...environment,
      NODE_ENV: "test",
      AUTOPILOT_TEST_CRASH_POINT: "after_task_complete_state",
    },
    timeoutMs: 120_000,
  })
  assert.equal(interrupted.code, 94, interrupted.stderr || interrupted.stdout)
  const interruptedQueue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(interruptedQueue.tasks.M001.status, "done")
  assert.equal(interruptedQueue.tasks.M002.status, "ready")
  assert.deepEqual(interruptedQueue.tasks.M002.allowed_paths, ["src/m002.txt"])

  const manifestBefore = await readFile(path.join(root, "package.json"))
  const importerBefore = await readFile(path.join(root, "apps", "web", "package.json"))
  const lockBefore = await readFile(path.join(root, "pnpm-lock.yaml"))
  const corepackBefore = await readNdjson(executables.corepackObservationFile)
  await Promise.all([
    rm(path.join(root, "node_modules"), { recursive: true, force: true }),
    rm(path.join(root, "apps", "web", "node_modules"), { recursive: true, force: true }),
  ])
  await assert.rejects(access(path.join(root, "node_modules")))
  await assert.rejects(access(path.join(root, "apps", "web", "node_modules")))

  const resumed = await run(command, { cwd: root, env: environment, timeoutMs: 120_000 })
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const completedQueue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const observations = await readNdjson(executables.observationFile)
  const m002Observations = observations.filter((entry) => entry.task_id === "M002")
  const receipt = await readJson(path.join(root, ".project", "receipts", "M002.json"))
  const corepackAfter = await readNdjson(executables.corepackObservationFile)
  const hydrationInvocations = corepackAfter.slice(corepackBefore.length)

  assert.equal(state.status, "complete", JSON.stringify({ state, completedQueue, resumed }, null, 2))
  assert.equal(state.attempt, 0)
  assert.equal(completedQueue.tasks.M002.status, "done")
  assert.equal((await readFile(path.join(root, "src", "m002.txt"), "utf8")).trim(), "M002")
  assert.deepEqual(await readFile(path.join(root, "package.json")), manifestBefore)
  assert.deepEqual(await readFile(path.join(root, "apps", "web", "package.json")), importerBefore)
  assert.deepEqual(await readFile(path.join(root, "pnpm-lock.yaml")), lockBefore)
  assert.deepEqual(
    hydrationInvocations.map((entry) => entry.argv.slice(0, 2)),
    [["pnpm", "--version"], ["pnpm", "install"]],
  )
  assert.equal(hydrationInvocations[1].argv.includes("--frozen-lockfile"), true)
  assert.equal(hydrationInvocations[1].argv.includes("--frozen-lockfile=false"), false)
  assert.equal(hydrationInvocations[1].argv.includes("--offline"), true)
  assert.deepEqual(m002Observations.map((entry) => [entry.stage, entry.attempt]), [
    ["execute", 1],
    ["review", 1],
  ])
  assert.equal(Object.hasOwn(m002Observations[0], "dependency"), false)
  assert.deepEqual(Object.keys(receipt.tool_usage), ["execute:a1", "review:a1"])
  assert.equal(Object.hasOwn(receipt.tool_usage["execute:a1"].by_tool, "lockfile"), false)
  await access(path.join(root, "node_modules", ".opencode-dependency-state.json"))
  await assertNoTemporaryRuntime(root, runtimeParent)
})

test("controller-owned dependency failure is typed, refunded, and never auto-dispatched twice", {
  timeout: 240_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "ocp-m001-fault-runtimes-"))
  const executables = await createLocalExecutables(t, "controller_failure")
  t.after(() => rm(runtimeParent, { recursive: true, force: true }))
  await configureM001(root, executables.fakeOpenCode)
  const environment = executableEnvironment(executables.bin, runtimeParent)
  const command = [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs")]

  const result = await run([...command, "start"], { cwd: root, env: environment })
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const observations = await readNdjson(executables.observationFile)
  const corepackInvocations = await readNdjson(executables.corepackObservationFile)

  assert.equal(state.status, "human_required", JSON.stringify({ state, result }, null, 2))
  assert.equal(state.phase, "blocked")
  assert.equal(state.attempt, 0)
  assert.equal(state.blocker.kind, "controller_tooling")
  assert.match(state.blocker.error_code, /^DEPENDENCY_/)
  assert.deepEqual(observations, [])
  assert.equal(corepackInvocations.length, 2)
  assert.deepEqual(corepackInvocations[0].argv, ["pnpm", "--version"])
  assert.equal(corepackInvocations[1].argv.includes("--frozen-lockfile=false"), true)
  assert.deepEqual(state.task_tool_usage, {})
  assert.equal(state.last_failure_evidence.controller_faults.length, 1)
  assert.equal(state.last_failure_evidence.controller_faults[0].operation, "dependency-lock")
  assert.match(state.last_failure_evidence.controller_faults[0].error_code, /^DEPENDENCY_/)

  const plainRestart = await run([...command, "start"], { cwd: root, env: environment })
  assert.notEqual(plainRestart.code, 0)
  assert.match(`${plainRestart.stdout}\n${plainRestart.stderr}`, /RESUME_REQUIRED/)
  const restarted = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(restarted.status, "human_required")
  assert.equal(restarted.attempt, 0)
  assert.equal((await readNdjson(executables.observationFile)).length, 0)
  assert.equal((await readNdjson(executables.corepackObservationFile)).length, 2)
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
  await assertNoTemporaryRuntime(root, runtimeParent)
})
