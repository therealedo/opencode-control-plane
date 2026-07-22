import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  createScaffold,
  filesUnder,
  git,
  makeReady,
  readJson,
  repositoryRoot,
  run,
  scaffoldScript,
  writeJson,
} from "./runtime-helpers.mjs"

const templateRoot = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "assets",
  "project",
)

const hardeningAgentSource = String.raw`#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("hardening-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

const argv = process.argv.slice(2)
const dirIndex = argv.indexOf("--dir")
const root = dirIndex >= 0 ? path.resolve(argv[dirIndex + 1]) : process.cwd()
const runtime = path.join(root, ".autopilot", "runtime")
const prompt = argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const mode = (await readFile(path.join(runtime, "hardening-mode.txt"), "utf8")).trim()

await mkdir(runtime, { recursive: true })
const invocationsFile = path.join(runtime, "hardening-invocations.json")
let invocations = []
try {
  invocations = JSON.parse(await readFile(invocationsFile, "utf8"))
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
const sessionId = "hardening-" + stage + "-a" + attempt + "-p" + process.pid
invocations.push({ stage, task_id: taskId, attempt, session_id: sessionId, argv })
await writeJson(invocationsFile, invocations)

if (stage === "review") {
  const medium = mode === "medium-review"
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: "approved",
    summary: medium
      ? "Approval is inconsistent with the unresolved medium finding."
      : "The deliberately bounded fake reviewer approved the supplied evidence.",
    findings: medium
      ? [{ severity: "medium", file: "src/result.txt", message: "This finding remains unresolved." }]
      : [],
  })
} else {
  const source = path.join(runtime, "link-source.txt")
  const result = path.join(root, "src", "result.txt")
  await mkdir(path.dirname(result), { recursive: true })
  await rm(result, { force: true })
  const changedFiles = ["src/result.txt"]

  if (mode === "hardlink") {
    await writeFile(source, "GOOD\n", "utf8")
    await link(source, result)
  } else if (mode === "symlink") {
    await writeFile(source, "GOOD\n", "utf8")
    await symlink("../.autopilot/runtime/link-source.txt", result, "file")
  } else {
    await writeFile(result, "GOOD\n", "utf8")
  }

  if (mode === "large-review") {
    await writeFile(path.join(root, "src", "large.txt"), "X".repeat(64 * 1024), "utf8")
    changedFiles.push("src/large.txt")
  }
  if (mode === "gitlink") {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
    execFileSync("git", ["update-index", "--add", "--cacheinfo", "160000," + commit + ",src/submodule"], {
      cwd: root,
      stdio: "pipe",
    })
    changedFiles.push("src/submodule")
  }
  if (mode === "git-influence") {
    await mkdir(path.join(root, ".git", "info"), { recursive: true })
    await writeFile(path.join(root, ".git", "info", "grafts"), "# phase mutation\n", "utf8")
  }

  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: "Hardening fixture produced " + mode + ".",
    changed_files: changedFiles,
    environment_variables: [],
    blocker: null,
  })
}

process.stdout.write(JSON.stringify({ type: "session", sessionID: sessionId }) + "\n")

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

const credentialPhaseAgentSource = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("credential-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

const phaseArgv = process.argv.slice(2)
const phaseDirIndex = phaseArgv.indexOf("--dir")
const root = phaseDirIndex >= 0 ? path.resolve(phaseArgv[phaseDirIndex + 1]) : process.cwd()
const runtime = path.join(root, ".autopilot", "runtime")
const prompt = process.argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const workerValue = ["worker", "profile", "secret", "987654"].join("-")
const reviewerValue = ["reviewer", "profile", "secret", "123456"].join("-")
if (process.env.WORKER_MCP_TOKEN !== undefined || process.env.REVIEW_MCP_TOKEN !== undefined) {
  throw new Error("phase credentials leaked into the OpenCode parent environment")
}
if (!process.argv.includes("--pure")) throw new Error("isolated phase omitted --pure")
const isolated = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
const expectedServer = stage === "execute" ? "worker_api" : stage === "review" ? "review_api" : null
const unexpectedServer = stage === "execute" ? "review_api" : "worker_api"
const expectedValue = stage === "execute" ? workerValue : reviewerValue
if (!expectedServer || !isolated.mcp?.[expectedServer] || isolated.mcp?.[unexpectedServer]) {
  throw new Error("isolated phase did not receive exactly its granted MCP server")
}
const authorization = isolated.mcp[expectedServer].headers?.Authorization || ""
const secretPath = /^Bearer \{file:(.+)\}$/.exec(authorization)?.[1]
if (!secretPath) throw new Error("phase credential was not converted to a private file substitution")
const exposed = await readFile(secretPath, "utf8")
if (exposed !== expectedValue) throw new Error("private MCP credential file contained the wrong value")

await mkdir(runtime, { recursive: true })
const observationsFile = path.join(runtime, "credential-phase-observations.json")
let observations = []
try {
  observations = JSON.parse(await readFile(observationsFile, "utf8"))
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
observations.push({
  stage,
  credential_sha256: createHash("sha256").update(exposed).digest("hex"),
  secret_path: secretPath,
  pure: process.argv.includes("--pure"),
  mcp_names: Object.keys(isolated.mcp || {}).sort(),
})
await writeFile(observationsFile, JSON.stringify(observations, null, 2) + "\n", "utf8")

if (stage === "execute") {
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "result.txt"), "GOOD\n", "utf8")
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: "The credential fixture produced the bounded candidate.",
    changed_files: ["src/result.txt"],
    environment_variables: [],
    blocker: null,
  })
} else {
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: "approved",
    summary: "The credential fixture approved the deterministic evidence.",
    findings: [],
  })
}

process.stdout.write("credential-output=" + exposed + "\n")
process.stderr.write("credential-error=" + exposed + "\n")
const sessionId = "credential-" + stage + "-a" + attempt + "-p" + process.pid
process.stdout.write(JSON.stringify({ type: "session", sessionID: sessionId }) + "\n")

if (stage === "review") {
  const replacement = ["mutated", "reviewer", "value", "000000"].join("-")
  await writeFile(
    path.join(root, ".env.review.local"),
    "REVIEW_MCP_TOKEN=" + replacement + "\n",
    "utf8",
  )
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

async function controller(root, { env } = {}) {
  return run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env },
  )
}

async function writeFailingGitShim(directory) {
  await mkdir(directory, { recursive: true })
  if (process.platform === "win32") {
    await writeFile(path.join(directory, "git.cmd"), "@exit /b 97\r\n", "utf8")
    await writeFile(path.join(directory, "git.ps1"), "exit 97\r\n", "utf8")
    return
  }
  const executable = path.join(directory, "git")
  await writeFile(executable, "#!/bin/sh\nexit 97\n", "utf8")
  await chmod(executable, 0o755)
}

function environmentWithPrependedPath(directory) {
  const environment = { ...process.env }
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH"
  for (const name of Object.keys(environment)) {
    if (name !== key && name.toLowerCase() === "path") delete environment[name]
  }
  environment[key] = `${directory}${path.delimiter}${environment[key] ?? ""}`
  return environment
}

async function strictValidation(root) {
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
    { cwd: root },
  )
  return { result, report: JSON.parse(result.stdout) }
}

async function ensureDirectAgents(root) {
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  const agents = {
    execute: "autopilot-worker",
    repair: "autopilot-recovery",
    review: "autopilot-reviewer",
  }
  if (JSON.stringify(config.opencode.agents) === JSON.stringify(agents) && !("agent" in config.opencode)) return
  delete config.opencode.agent
  config.opencode.agents = agents
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: configure direct phase agents"])
}

async function configureHardeningAgent(t, root, mode) {
  const runtime = path.join(root, ".autopilot", "runtime")
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "autopilot-hardening-agent-"))
  t.after(async () => rm(agentDirectory, { recursive: true, force: true }))
  const agent = path.join(agentDirectory, "hardening-opencode.mjs")
  await mkdir(runtime, { recursive: true })
  await writeFile(agent, hardeningAgentSource, "utf8")
  await writeFile(path.join(runtime, "hardening-mode.txt"), `${mode}\n`, "utf8")

  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, agent]
  delete config.opencode.agent
  config.opencode.agents = {
    execute: "autopilot-worker",
    repair: "autopilot-recovery",
    review: "autopilot-reviewer",
  }
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", `test: configure ${mode} hardening agent`])
}

async function assertNoReceipt(root) {
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
}

async function hardeningInvocations(root) {
  try {
    return await readJson(path.join(root, ".autopilot", "runtime", "hardening-invocations.json"))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function assertRejectedCandidate(root, expectedReason, maxAgentInvocations = null) {
  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(state.status, "human_required", JSON.stringify({ state, queue, result }, null, 2))
  assert.notEqual(queue.tasks.M001.status, "done")
  if (expectedReason) {
    assert.match(`${state.blocker?.kind ?? ""} ${state.blocker?.message ?? ""}`, expectedReason)
  }
  if (maxAgentInvocations !== null) {
    const invocations = await hardeningInvocations(root)
    assert.ok(
      invocations.length <= maxAgentInvocations,
      `policy rejection launched ${invocations.length} agent sessions; cap is ${maxAgentInvocations}: ${JSON.stringify(invocations)}`,
    )
  }
  await assertNoReceipt(root)
}

test("strict validation requires the project root to equal the Git top-level", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "opencode-parent-worktree-"))
  const root = path.join(parent, "nested-project")
  t.after(async () => rm(parent, { recursive: true, force: true }))

  await git(parent, ["init"])
  await git(parent, ["config", "user.name", "Autopilot Test"])
  await git(parent, ["config", "user.email", "autopilot-test@example.invalid"])
  const scaffold = await run(
    [process.execPath, scaffoldScript, "--target", root, "--no-git", "--json"],
    { cwd: repositoryRoot },
  )
  assert.equal(scaffold.code, 0, scaffold.stderr || scaffold.stdout)
  await makeReady(root)

  const { result, report } = await strictValidation(root)
  assert.notEqual(result.code, 0)
  assert.ok(
    report.issues.some(
      (issue) => issue.location === "git" && /top[- ]level|repository root|worktree/i.test(issue.message),
    ),
    JSON.stringify(report, null, 2),
  )
})

test("a clean clone bootstraps missing ignored runtime state", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  await rm(path.join(root, ".autopilot", "state.json"), { force: true })

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(state.status, "complete", JSON.stringify({ state, queue, result }, null, 2))
  assert.equal(queue.tasks.M001.status, "done")
})

test("a completed clean clone with missing runtime state does not repeat finalization", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const first = await controller(root)
  assert.equal(first.code, 0, first.stderr || first.stdout)
  const head = await git(root, ["rev-parse", "HEAD"])
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const invocations = await readJson(invocationFile)
  await rm(path.join(root, ".autopilot", "state.json"), { force: true })

  const resumed = await controller(root)
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  assert.equal(await git(root, ["rev-parse", "HEAD"]), head)
  assert.deepEqual(await readJson(invocationFile), invocations)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete")
})

test("an uncommitted complete queue is finalized instead of mistaken for a clean clone", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const once = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "once"],
    { cwd: root },
  )
  assert.equal(once.code, 0, once.stderr || once.stdout)
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  assert.equal(queue.tasks.M001.status, "done")
  queue.project_status = "complete"
  await writeJson(queueFile, queue)
  const headBefore = await git(root, ["rev-parse", "HEAD"])

  const resumed = await controller(root)
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  assert.notEqual(await git(root, ["rev-parse", "HEAD"]), headBefore)
  assert.equal((await git(root, ["status", "--porcelain"])), "")
  const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
  assert.equal(subjects.filter((item) => item === "autopilot: complete project").length, 1)
})

test("credential profiles require explicit gates and reject process-control variables", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const credentialsFile = path.join(root, ".autopilot", "credentials.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task.credential_profile = "test"
  await writeJson(gatesFile, gates)
  await writeJson(credentialsFile, {
    schema_version: 1,
    profiles: {
      test: {
        env_file: ".env.test.local",
        allow: ["SAFE_TEST_TOKEN"],
        allowed_gates: ["task"],
      },
    },
  })
  const feedbackWithCredentials = await strictValidation(root)
  assert.notEqual(feedbackWithCredentials.result.code, 0)
  assert.ok(
    feedbackWithCredentials.report.issues.some(
      (issue) => issue.location === "gates.gates.task.feedback" && /credential/i.test(issue.message),
    ),
    JSON.stringify(feedbackWithCredentials.report, null, 2),
  )
  gates.gates.task.feedback = false
  await writeJson(gatesFile, gates)
  await writeJson(credentialsFile, {
    schema_version: 1,
    profiles: {
      test: {
        env_file: ".env.test.local",
        allow: ["SAFE_TEST_TOKEN"],
      },
    },
  })

  const missingAllowlist = await strictValidation(root)
  assert.notEqual(missingAllowlist.result.code, 0)
  assert.ok(
    missingAllowlist.report.issues.some(
      (issue) => /allowed_gates/.test(issue.location) || /allowed.gates|gate allowlist/i.test(issue.message),
    ),
    JSON.stringify(missingAllowlist.report, null, 2),
  )

  const deniedNames = ["PATH", "NODE_OPTIONS", "GIT_CONFIG_COUNT", "PYTHONPATH", "AUTOPILOT_FAKE_TOKEN"]
  for (const name of deniedNames) {
    await writeJson(credentialsFile, {
      schema_version: 1,
      profiles: {
        test: {
          env_file: ".env.test.local",
          allow: [name],
          allowed_gates: ["task"],
        },
      },
    })
    const unsafeEnvironment = await strictValidation(root)
    assert.notEqual(unsafeEnvironment.result.code, 0)
    assert.ok(
      unsafeEnvironment.report.issues.some(
        (issue) => issue.location.includes("credentials.profiles.test.allow")
          && (issue.message.includes(name) || /process|control|unsafe|reserved/i.test(issue.message)),
      ),
      `${name}: ${JSON.stringify(unsafeEnvironment.report, null, 2)}`,
    )
  }

  await writeJson(credentialsFile, {
    schema_version: 1,
    profiles: {
      test: {
        env_file: "nested/.env.test.local",
        allow: ["SAFE_TEST_TOKEN"],
        allowed_gates: ["task"],
      },
    },
  })
  const nestedCredentialPath = await strictValidation(root)
  assert.notEqual(nestedCredentialPath.result.code, 0)
  assert.ok(
    nestedCredentialPath.report.issues.some(
      (issue) => issue.location.includes("credentials.profiles.test.env_file") && /root-local|env.*local/i.test(issue.message),
    ),
    JSON.stringify(nestedCredentialPath.report, null, 2),
  )
})

test("canonical MCP descriptors reject file injection, unsafe execution fields, and insecure transport", async () => {
  const {
    boundedProviderEnvironment,
    PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES,
    PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES,
    validateMcpDescriptors,
  } = await import(
    pathToFileURL(path.join(templateRoot, ".autopilot", "bin", "lib", "mcp.mjs")).href
  )
  assert.deepEqual(boundedProviderEnvironment(["SHORT_REGION"], { SHORT_REGION: "us" }), {
    SHORT_REGION: "us",
  })
  assert.throws(
    () => boundedProviderEnvironment(["OVERSIZED_PROVIDER"], {
      OVERSIZED_PROVIDER: "x".repeat(PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES + 1),
    }),
    (error) => error?.code === "CREDENTIAL_VALUE_TOO_LARGE" && /exceeds 8192 UTF-8 bytes/i.test(error.message),
  )
  assert.throws(
    () => boundedProviderEnvironment(["PROVIDER_ONE", "PROVIDER_TWO"], {
      PROVIDER_ONE: "x".repeat(PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES),
      PROVIDER_TWO: "y".repeat(PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES),
    }),
    (error) => error?.code === "CREDENTIAL_VALUE_TOO_LARGE" &&
      error.message.includes(String(PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES)),
  )
  assert.deepEqual(validateMcpDescriptors({
    local_docs: {
      type: "local",
      command: [process.execPath, "--version"],
      environment: { DOCS_TOKEN: "{env:DOCS_TOKEN}" },
      enabled: true,
      timeout: 5000,
    },
    remote_docs: {
      type: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer {env:DOCS_TOKEN}" },
      oauth: false,
    },
  }), {
    local_docs: {
      type: "local",
      command: [process.execPath, "--version"],
      environment: { DOCS_TOKEN: "{env:DOCS_TOKEN}" },
      enabled: true,
      timeout: 5000,
    },
    remote_docs: {
      type: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer {env:DOCS_TOKEN}" },
      oauth: false,
    },
  })

  const rejected = [
    [{ remote: { type: "remote", url: "https://example.invalid", headers: { Authorization: "Bearer {file:C:/secret}" } } }, /incoming \{file/i],
    [{ local: { type: "local", command: [process.execPath], cwd: "src" } }, /unknown field cwd/i],
    [{ local: { type: "local", command: [process.execPath, "mcp-server.mjs"] } }, /project-relative path/i],
    [{ local: { type: "local", command: [process.execPath, "{project}"] } }, /cannot expose the project/i],
    [{ local: { type: "local", command: [process.execPath, "bad\nargument"] } }, /safe line/i],
    [{ local: { type: "local", command: [process.execPath], unexpected: true } }, /unknown field unexpected/i],
    [{ remote: { type: "remote", url: "http://example.invalid/mcp" } }, /must use HTTPS/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer literal-value" } } }, /must contain an \{env:NAME\}/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp/{env:DOCS_TOKEN}" } }, /cannot carry credentials or substitutions/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp?opaque={env:DOCS_TOKEN}" } }, /cannot carry credentials or substitutions/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Auth": "opaque-literal-value" } } }, /must contain an \{env:NAME\}/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp", headers: { Cookie: "opaque-literal-value" } } }, /must contain an \{env:NAME\}/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Credential": "opaque-literal-value" } } }, /must contain an \{env:NAME\}/i],
    [{ remote: { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Session": "opaque-literal-value" } } }, /must contain an \{env:NAME\}/i],
  ]
  for (const [descriptor, expected] of rejected) {
    assert.throws(() => validateMcpDescriptors(descriptor), expected)
  }
  assert.throws(
    () => validateMcpDescriptors({
      local: {
        type: "local",
        command: [process.execPath],
        environment: { PROVIDER_TOKEN: "{env:PROVIDER_TOKEN}" },
      },
    }, { providerEnvironment: ["PROVIDER_TOKEN"] }),
    /cannot override a provider environment variable/i,
  )
})

test("fixed autonomous config invariants reject approval prompts and pre-existing allowed-path dirt", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  const contracts = await import(
    pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "contracts.mjs")).href
  )
  assert.match(JSON.stringify(contracts.validateConfig({
    ...config,
    opencode: { ...config.opencode, auto_approve: false },
  })), /auto_approve.*must be true/i)
  assert.match(JSON.stringify(contracts.validateConfig({
    ...config,
    opencode: { ...config.opencode, provider_environment: ["PROVIDER_TOKEN", "provider_token"] },
  })), /provider_environment.*repeats provider_token case-insensitively/i)
  const credentialCaseIssues = JSON.stringify(contracts.validateCredentials({
    schema_version: 1,
    profiles: {
      Worker: {
        env_file: ".env.worker.local",
        allow: ["WORKER_TOKEN", "worker_token"],
        allowed_gates: ["opencode"],
      },
      worker: {
        env_file: ".env.reviewer.local",
        allow: ["REVIEWER_TOKEN"],
        allowed_gates: ["opencode"],
      },
    },
  }))
  assert.match(credentialCaseIssues, /allow.*repeats worker_token case-insensitively/i)
  assert.match(credentialCaseIssues, /case-insensitive duplicate profile worker/i)

  config.git.require_clean_start = false
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: attempt to disable clean task baselines"])
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "preexisting.txt"), "pre-existing work\n", "utf8")

  const result = await controller(root)
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /require_clean_start.*must be true|pre-existing application changes/i)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.attempt, 0)
  assert.deepEqual(await hardeningInvocations(root), [])
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
  await assertNoReceipt(root)
})

test("active task MCP drift blocks before profile loading or model dispatch", async (t) => {
  for (const committed of [false, true]) {
    await t.test(committed ? "committed drift" : "working-tree drift", async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "success" })
      const crash = await run(
        [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "test",
            AUTOPILOT_TEST_CRASH_POINT: "after_attempt_record",
          },
        },
      )
      assert.equal(crash.code, 91, crash.stderr || crash.stdout)
      const interrupted = await readJson(path.join(root, ".autopilot", "state.json"))
      assert.equal(interrupted.active_task, "M001")
      assert.equal(interrupted.attempt, 1)

      const openCodeFile = path.join(root, "opencode.jsonc")
      const openCode = await readJson(openCodeFile)
      openCode.mcp = {
        drifted: {
          type: "local",
          command: [process.execPath, "--version"],
        },
      }
      await writeJson(openCodeFile, openCode)
      if (committed) {
        await git(root, ["add", "opencode.jsonc"])
        await git(root, ["commit", "-m", "test: drift active MCP profile"])
      }

      const resumed = await run(
        [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
        { cwd: root },
      )
      assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
      const blocked = await readJson(path.join(root, ".autopilot", "state.json"))
      assert.equal(blocked.status, "human_required", JSON.stringify(blocked, null, 2))
      assert.equal(blocked.attempt, 1)
      assert.match(blocked.blocker?.message ?? "", committed ? /Git HEAD changed/i : /mcp changed.*baseline/i)
      await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
      await assertNoReceipt(root)
    })
  }
})

test("phase-specific OpenCode credentials are isolated, redacted, frozen, and solely reserved", async (t) => {
  const rejectedRoot = await createScaffold(t, { ready: true, mode: "success" })
  const rejectedCredentials = path.join(rejectedRoot, ".autopilot", "credentials.json")
  await writeJson(rejectedCredentials, {
    schema_version: 1,
    profiles: {
      shared: {
        env_file: ".env.shared.local",
        allow: ["SHARED_MCP_TOKEN"],
        allowed_gates: ["opencode", "task"],
      },
    },
  })
  await writeFile(path.join(rejectedRoot, ".env.shared.local"), "SHARED_MCP_TOKEN=shared-value-987654\n", { encoding: "utf8", mode: 0o600 })
  const rejectedConfigFile = path.join(rejectedRoot, ".autopilot", "config.json")
  const rejectedConfig = await readJson(rejectedConfigFile)
  rejectedConfig.opencode.credential_profiles = {
    execute: "shared",
    repair: "shared",
    review: "shared",
  }
  await writeJson(rejectedConfigFile, rejectedConfig)
  await git(rejectedRoot, ["add", ".autopilot/config.json"])
  await git(rejectedRoot, ["commit", "-m", "test: configure non-reserved OpenCode profile"])

  const rejected = await controller(rejectedRoot)
  assert.notEqual(rejected.code, 0)
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /reserved solely|allowed_gates.*opencode/i)
  await assert.rejects(access(path.join(rejectedRoot, ".autopilot", "runtime", "fake-invocations.json")))

  const root = await createScaffold(t, { ready: true, mode: "success" })
  const runtime = path.join(root, ".autopilot", "runtime")
  const credentialAgentDirectory = await mkdtemp(path.join(os.tmpdir(), "autopilot-credential-agent-"))
  t.after(async () => rm(credentialAgentDirectory, { recursive: true, force: true }))
  const credentialAgent = path.join(credentialAgentDirectory, "credential-phase-opencode.mjs")
  const workerEnv = path.join(root, ".env.worker.local")
  const reviewerEnv = path.join(root, ".env.review.local")
  const workerSecret = "worker-profile-secret-987654"
  const reviewerSecret = "reviewer-profile-secret-123456"
  await writeFile(credentialAgent, credentialPhaseAgentSource, "utf8")
  await writeFile(workerEnv, `WORKER_MCP_TOKEN=${workerSecret}\n`, { encoding: "utf8", mode: 0o600 })
  await writeFile(reviewerEnv, `REVIEW_MCP_TOKEN=${reviewerSecret}\n`, { encoding: "utf8", mode: 0o600 })
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      worker: {
        env_file: ".env.worker.local",
        allow: ["WORKER_MCP_TOKEN"],
        allowed_gates: ["opencode"],
      },
      reviewer: {
        env_file: ".env.review.local",
        allow: ["REVIEW_MCP_TOKEN"],
        allowed_gates: ["opencode"],
      },
    },
  })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, credentialAgent]
  config.opencode.credential_profiles = {
    execute: "worker",
    repair: "worker",
    review: "reviewer",
  }
  await writeJson(configFile, config)
  await writeJson(path.join(root, "opencode.jsonc"), {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      worker_api: {
        type: "remote",
        url: "https://example.invalid/worker-mcp",
        headers: { Authorization: "Bearer {env:WORKER_MCP_TOKEN}" },
        oauth: false,
      },
      review_api: {
        type: "remote",
        url: "https://example.invalid/review-mcp",
        headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" },
        oauth: false,
      },
    },
  })
  await writeJson(path.join(root, ".project", "tools.json"), {
    schema_version: 1,
    roles: {
      worker: ["worker_api_lookup"],
      recovery: ["worker_api_lookup"],
      reviewer: ["review_api_lookup"],
    },
  })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.tool_grants = {
    execute: ["worker_api_lookup"],
    repair: ["worker_api_lookup"],
    review: ["review_api_lookup"],
  }
  await writeJson(queueFile, queue)
  const configured = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "configure-tools.mjs"), "--root", root, "--json"],
    { cwd: root },
  )
  assert.equal(configured.code, 0, configured.stderr || configured.stdout)
  await git(root, ["add", ".autopilot/config.json", "opencode.jsonc", ".project/tools.json", ".project/plan/queue.json", ".opencode/agents"])
  await git(root, ["commit", "-m", "test: configure phase-specific OpenCode credentials"])

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.match(state.blocker?.message ?? "", /credential env file changed/i)
  assert.deepEqual(state.session_ids.length, 1)
  await assertNoReceipt(root)

  const observations = await readJson(path.join(runtime, "credential-phase-observations.json"))
  assert.deepEqual(observations, [
    {
      stage: "execute",
      credential_sha256: createHash("sha256").update(workerSecret).digest("hex"),
      secret_path: observations[0].secret_path,
      pure: true,
      mcp_names: ["worker_api"],
    },
    {
      stage: "review",
      credential_sha256: createHash("sha256").update(reviewerSecret).digest("hex"),
      secret_path: observations[1].secret_path,
      pure: true,
      mcp_names: ["review_api"],
    },
  ])
  await assert.rejects(access(observations[0].secret_path))
  await assert.rejects(access(observations[1].secret_path))

  const excludedCredentialSources = new Set([workerEnv, reviewerEnv].map((file) => path.resolve(file)))
  for (const file of await filesUnder(root)) {
    if (excludedCredentialSources.has(path.resolve(file))) continue
    const durableBytes = await readFile(file)
    assert.equal(durableBytes.includes(workerSecret), false, `worker credential leaked into ${file}`)
    assert.equal(durableBytes.includes(reviewerSecret), false, `review credential leaked into ${file}`)
  }
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(workerSecret), false)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(reviewerSecret), false)
})

test("strict validation scans unreferenced durable control text but not credential value files", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const architectureFile = path.join(root, ".project", "architecture", "unreferenced-secret.md")
  const envFile = path.join(root, ".env.test.local")
  await writeFile(envFile, `SAFE_TEST_TOKEN=${"z".repeat(48)}\n`, "utf8")
  await writeFile(architectureFile, `api_key=${"A".repeat(48)}\n`, "utf8")

  const blocked = await strictValidation(root)
  assert.notEqual(blocked.result.code, 0)
  assert.ok(
    blocked.report.issues.some(
      (issue) => issue.location.includes("unreferenced-secret.md") && /secret|key/i.test(issue.message),
    ),
    JSON.stringify(blocked.report, null, 2),
  )

  await rm(architectureFile, { force: true })
  const clean = await strictValidation(root)
  assert.equal(clean.result.code, 0, JSON.stringify(clean.report, null, 2))
})

test("credential values too short for redaction never reach a gate", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const credentialsFile = path.join(root, ".autopilot", "credentials.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const envFile = path.join(root, ".env.test.local")
  const gates = await readJson(gatesFile)
  gates.gates.task.credential_profile = "test"
  gates.gates.task.feedback = false
  await writeJson(gatesFile, gates)
  await writeJson(credentialsFile, {
    schema_version: 1,
    profiles: {
      test: {
        env_file: ".env.test.local",
        allow: ["SAFE_TEST_TOKEN"],
        allowed_gates: ["task"],
      },
    },
  })
  await writeFile(envFile, "SAFE_TEST_TOKEN=abc\n", { encoding: "utf8", mode: 0o600 })

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "task"],
    { cwd: root },
  )
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /too short|redaction/i)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SAFE_TEST_TOKEN=abc/)
})

test("agent-authored contracts reject secrets, oversized prose, and non-name environment entries", async () => {
  const contracts = await import(pathToFileURL(path.join(templateRoot, ".autopilot", "bin", "lib", "contracts.mjs")).href)
  const secret = `api_key=${"A".repeat(48)}`
  const oversized = "x".repeat(128 * 1024)

  const candidateIssues = contracts.validateCandidate({
    schema_version: 1,
    task_id: "M001",
    attempt: 1,
    status: "complete",
    summary: `${secret} ${oversized}`,
    changed_files: ["src/result.txt"],
    environment_variables: ["TOKEN=value", "TWO WORDS"],
    blocker: null,
  }, "M001", 1)
  const candidateText = JSON.stringify(candidateIssues)
  assert.match(candidateText, /candidate\.summary/)
  assert.match(candidateText, /secret|sensitive/i)
  assert.match(candidateText, /byte|length|long|cap|maximum/i)
  assert.match(candidateText, /candidate\.environment_variables/)

  const blockedIssues = contracts.validateCandidate({
    schema_version: 1,
    task_id: "M001",
    attempt: 1,
    status: "blocked",
    summary: "A bounded blocker.",
    changed_files: [],
    environment_variables: [],
    blocker: {
      kind: "credential",
      message: secret,
      required_action: oversized,
      resume_condition: "Provide an approved disposable test identity.",
    },
  }, "M001", 1)
  assert.match(JSON.stringify(blockedIssues), /candidate\.blocker/)
  assert.match(JSON.stringify(blockedIssues), /secret|sensitive|byte|length|long|cap|maximum/i)

  const reviewIssues = contracts.validateReview({
    schema_version: 1,
    task_id: "M001",
    status: "changes_requested",
    summary: secret,
    findings: [{ severity: "medium", file: "src/result.txt", message: oversized }],
  }, "M001")
  const reviewText = JSON.stringify(reviewIssues)
  assert.match(reviewText, /review\.summary/)
  assert.match(reviewText, /secret|sensitive/i)
  assert.match(reviewText, /review\.findings/)
  assert.match(reviewText, /byte|length|long|cap|maximum/i)

  const config = await readJson(path.join(templateRoot, ".autopilot", "config.json"))
  config.opencode.agents.review = config.opencode.agents.execute
  const configIssues = contracts.validateConfig(config)
  assert.match(JSON.stringify(configIssues), /agent IDs must be unique|phase-specific.*unique/i)

  const state = await readJson(path.join(templateRoot, ".autopilot", "state.json"))
  assert.deepEqual(contracts.validateState(state), [])
  const stateIssues = [
    ...contracts.validateState({ ...state, completed_in_run: -1 }),
    ...contracts.validateState({ ...state, no_progress_count: -1 }),
    ...contracts.validateState({ ...state, status: "running", run_id: "run-test", started_at: "not-a-date" }),
  ]
  assert.match(JSON.stringify(stateIssues), /completed_in_run/)
  assert.match(JSON.stringify(stateIssues), /no_progress_count/)
  assert.match(JSON.stringify(stateIssues), /started_at/)

  const usage = {
    "execute:a1": {
      schema_version: 1,
      phase: "execute",
      task_id: "M001",
      tool_calls: 1,
      returned_bytes: 12,
      by_tool: { read: { calls: 1, returned_bytes: 12 } },
      model_usage: {
        input_tokens: 100,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_read_tokens: 50,
        cache_write_tokens: 10,
        cost: 0.125,
      },
    },
  }
  assert.deepEqual(contracts.validateTaskToolUsage(usage, { taskId: "M001" }), [])
  usage["execute:a1"].model_usage.input_tokens = -1
  usage["execute:a1"].model_usage.cost = Number.POSITIVE_INFINITY
  const modelUsageIssues = JSON.stringify(contracts.validateTaskToolUsage(usage, { taskId: "M001" }))
  assert.match(modelUsageIssues, /input_tokens.*non-negative safe integer/)
  assert.match(modelUsageIssues, /cost.*finite number between 0 and 1000000/)
  usage["execute:a1"].model_usage.input_tokens = 100
  usage["execute:a1"].model_usage.cost = 1_000_001
  assert.match(
    JSON.stringify(contracts.validateTaskToolUsage(usage, { taskId: "M001" })),
    /cost.*finite number between 0 and 1000000/,
  )
  usage["execute:a1"].model_usage.cost = 0.125
  usage["execute:a1"].raw_output = "must not persist"
  usage["execute:a1"].by_tool.read.extra = 1
  usage["execute:a1"].model_usage.extra = 1
  const unknownUsageIssues = JSON.stringify(contracts.validateTaskToolUsage(usage, { taskId: "M001" }))
  assert.match(unknownUsageIssues, /raw_output.*not an allowed contract field/)
  assert.match(unknownUsageIssues, /by_tool\.read\.extra.*not an allowed contract field/)
  assert.match(unknownUsageIssues, /model_usage\.extra.*not an allowed contract field/)
  delete usage["execute:a1"].raw_output
  delete usage["execute:a1"].by_tool.read.extra
  delete usage["execute:a1"].model_usage.extra
  usage["execute:a1"].returned_bytes = 13
  assert.match(JSON.stringify(contracts.validateTaskToolUsage(usage, { taskId: "M001" })), /aggregate counters/)
})

test("optional model telemetry is omitted before the task usage ledger reaches 24 KiB", async () => {
  const contracts = await import(pathToFileURL(path.join(templateRoot, ".autopilot", "bin", "lib", "contracts.mjs")).href)
  const taskId = "M".repeat(128)
  const tools = ["read", "list", "search", "write", "edit", "mutate", "check", "contract"]
  const keys = Array.from({ length: 20 }, (_item, index) => [
    `execute:a${index + 1}`,
    `review:a${index + 1}`,
  ]).flat()
  const phaseUsage = (phase) => ({
    schema_version: 1,
    phase,
    task_id: taskId,
    tool_calls: 0,
    returned_bytes: 0,
    by_tool: Object.fromEntries(tools.map((tool) => [tool, { calls: 0, returned_bytes: 0 }])),
    model_usage: {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: Number.MAX_SAFE_INTEGER,
      reasoning_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_tokens: Number.MAX_SAFE_INTEGER,
      cache_write_tokens: Number.MAX_SAFE_INTEGER,
      cost: 1_000_000,
    },
  })
  const unbounded = Object.fromEntries(keys.map((key) => [key, phaseUsage(key.split(":")[0])]))
  assert.ok(Buffer.byteLength(JSON.stringify(unbounded), "utf8") > 24 * 1024)

  let bounded = {}
  for (const key of keys) {
    bounded = contracts.appendBoundedTaskToolUsage(bounded, key, phaseUsage(key.split(":")[0]))
  }
  assert.equal(Object.keys(bounded).length, 40)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 24 * 1024)
  assert.deepEqual(contracts.validateTaskToolUsage(bounded, { taskId }), [])
  assert.equal(Object.hasOwn(bounded[keys.at(-1)], "model_usage"), false)
  assert.ok(Object.values(bounded).some((entry) => Object.hasOwn(entry, "model_usage")))
  assert.ok(Object.values(bounded).every((entry) => entry.by_tool.contract.returned_bytes === 0))
})

test("an approved review cannot retain a medium finding", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureHardeningAgent(t, root, "medium-review")
  await assertRejectedCandidate(root, /review|medium|finding/i)
})

test("review cannot approve a diff whose evidence exceeds the bounded packet", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureHardeningAgent(t, root, "large-review")
  await assertRejectedCandidate(root, /review.*evidence|evidence.*exceed|too.large/i, 1)
  const invocations = await hardeningInvocations(root)
  assert.equal(invocations.some((item) => item.stage === "review"), false)
})

test("hard-linked task output is rejected before acceptance", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureHardeningAgent(t, root, "hardlink")
  await assertRejectedCandidate(root, /hard.?link|regular file|unsupported changed file type/i, 1)
})

test("symbolic-linked task output is rejected before acceptance", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const runtime = path.join(root, ".autopilot", "runtime")
  const probeTarget = path.join(runtime, "symlink-probe-target.txt")
  const probe = path.join(runtime, "symlink-probe.txt")
  await writeFile(probeTarget, "probe\n", "utf8")
  try {
    await symlink(probeTarget, probe, "file")
    assert.equal((await lstat(probe)).isSymbolicLink(), true)
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`)
      return
    }
    throw error
  } finally {
    await rm(probe, { force: true })
  }

  await configureHardeningAgent(t, root, "symlink")
  await assertRejectedCandidate(root, /symbolic|symlink|link\/directory|regular file|unsupported changed file type/i, 1)
})

test("a staged gitlink/submodule candidate is rejected", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureHardeningAgent(t, root, "gitlink")
  await assertRejectedCandidate(root, /git.*index|gitlink|link type|staged|protected control|modified protected/i, 1)
})

test("a phase mutation of Git execution-influence files is blocked before acceptance", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureHardeningAgent(t, root, "git-influence")
  await assertRejectedCandidate(root, /protected control|modified protected|path policy|repair_exhausted|fresh OpenCode repair session failed/i, 1)
  const invocations = await hardeningInvocations(root)
  assert.deepEqual(invocations.map((item) => item.stage), ["execute"])
})

test("controller Git ignores project-owned executables prepended to ambient PATH", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const projectBin = path.join(root, ".autopilot", "runtime", "project-bin")
  await writeFailingGitShim(projectBin)

  const result = await controller(root, { env: environmentWithPrependedPath(projectBin) })
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
})

test("controller Git suppresses repository fsmonitor commands", async (t) => {
  if (process.platform === "win32") {
    t.skip("portable executable fsmonitor hook fixture is POSIX-only")
    return
  }
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const hook = path.join(root, ".autopilot", "runtime", "hostile-fsmonitor")
  const marker = path.join(root, ".autopilot", "runtime", "hostile-fsmonitor-ran")
  await writeFile(hook, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 0\n`, "utf8")
  await chmod(hook, 0o755)
  await git(root, ["config", "core.fsmonitor", hook])

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
  await assert.rejects(access(marker))
})

test("repository-local clean filters are rejected before an agent can run", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  await git(root, ["config", "filter.hostile.clean", "definitely-not-a-real-clean-filter"])

  const result = await controller(root)
  assert.notEqual(result.code, 0, result.stderr || result.stdout)
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /repository-local Git filters|diff drivers|exact autonomous staging/i,
  )
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
})

test("assume-unchanged index flags cannot conceal a protected edit", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const agentsFile = path.join(root, "AGENTS.md")
  await git(root, ["update-index", "--assume-unchanged", "AGENTS.md"])
  await writeFile(agentsFile, `${await readFile(agentsFile, "utf8")}\nHidden mutation.\n`, "utf8")

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.match(state.blocker.message, /index|assume-unchanged|nonstandard flag/i)
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
})

test("a preexisting task receipt is never overwritten or treated as completion evidence", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const receiptFile = path.join(root, ".project", "receipts", "M001.json")
  const original = `${JSON.stringify({ schema_version: 1, sentinel: "do-not-overwrite" }, null, 2)}\n`
  await writeFile(receiptFile, original, "utf8")

  await controller(root)
  assert.equal(await readFile(receiptFile, "utf8"), original)
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.notEqual(queue.tasks.M001.status, "done")
})

test("restart after the application commit resumes the completion transaction without another model call", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const crash = await controller(root, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AUTOPILOT_TEST_CRASH_POINT: "after_app_commit",
    },
  })
  assert.equal(crash.code, 86, crash.stderr || crash.stdout)

  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const invocationsAtCrash = await readJson(invocationFile)
  assert.deepEqual(invocationsAtCrash.map((item) => item.stage), ["execute", "review"])

  const resumed = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
    { cwd: root },
  )
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const receiptFile = path.join(root, ".project", "receipts", "M001.json")
  const receiptBytes = await readFile(receiptFile, "utf8")
  const receipt = JSON.parse(receiptBytes)
  assert.equal(state.status, "complete")
  assert.equal(queue.tasks.M001.status, "done")
  assert.deepEqual(await readJson(invocationFile), invocationsAtCrash)

  const baselineTree = await git(root, ["rev-parse", `${receipt.baseline_commit}^{tree}`])
  const resultTree = await git(root, ["rev-parse", `${receipt.result_commit}^{tree}`])
  const canonical = createHash("sha256")
    .update(`autopilot-git-tree-transition-v1\0${baselineTree}\0${resultTree}\0`)
    .digest("hex")
  assert.equal(receipt.diff_sha256, canonical)

  const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
  assert.equal(subjects.filter((item) => item === "autopilot: M001 Prove the autonomous runtime").length, 1)
  assert.equal(subjects.filter((item) => item === "autopilot: record M001").length, 1)
  assert.equal(subjects.filter((item) => item === "autopilot: complete project").length, 1)
  assert.equal(await git(root, ["status", "--porcelain"]), "")

  const head = await git(root, ["rev-parse", "HEAD"])
  const secondRestart = await controller(root)
  assert.equal(secondRestart.code, 0, secondRestart.stderr || secondRestart.stdout)
  assert.equal(await git(root, ["rev-parse", "HEAD"]), head)
  assert.equal(await readFile(receiptFile, "utf8"), receiptBytes)
  assert.deepEqual(await readJson(invocationFile), invocationsAtCrash)
})

test("receipt and queue completion write windows recover without repeated model work", async (t) => {
  for (const scenario of [
    { point: "after_receipt_write", code: 92 },
    { point: "after_completion_queue_write", code: 93 },
  ]) {
    await t.test(scenario.point, async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "success" })
      await ensureDirectAgents(root)
      const crash = await controller(root, {
        env: {
          ...process.env,
          NODE_ENV: "test",
          AUTOPILOT_TEST_CRASH_POINT: scenario.point,
        },
      })
      assert.equal(crash.code, scenario.code, crash.stderr || crash.stdout)
      const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
      const invocationsAtCrash = await readJson(invocationFile)
      assert.deepEqual(invocationsAtCrash.map((item) => item.stage), ["execute", "review"])

      const resumed = await run(
        [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
        { cwd: root },
      )
      assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
      const state = await readJson(path.join(root, ".autopilot", "state.json"))
      const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
      assert.equal(state.status, "complete")
      assert.equal(queue.tasks.M001.status, "done")
      assert.deepEqual(await readJson(invocationFile), invocationsAtCrash)
      assert.equal(await git(root, ["status", "--porcelain"]), "")
    })
  }
})

test("metadata staging binds exact queue and receipt bytes for completion and finalization", async (t) => {
  for (const scenario of [
    {
      name: "completion queue",
      label: "task-metadata",
      file: ".project/plan/queue.json",
      journal: "completion",
    },
    {
      name: "completion receipt",
      label: "task-metadata",
      file: ".project/receipts/M001.json",
      journal: "completion",
    },
    {
      name: "finalization queue",
      label: "project-finalization",
      file: ".project/plan/queue.json",
      journal: "finalization",
    },
    {
      name: "finalization receipt",
      label: "project-finalization",
      file: ".project/receipts/__project-final.json",
      journal: "finalization",
    },
  ]) {
    await t.test(scenario.name, async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "success" })
      await ensureDirectAgents(root)
      const result = await controller(root, {
        env: {
          ...process.env,
          NODE_ENV: "test",
          AUTOPILOT_TEST_PREPARE_RACE_LABEL: scenario.label,
          AUTOPILOT_TEST_PREPARE_RACE_FILE: scenario.file,
        },
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /GIT_TRANSACTION_CONFLICT/)

      const state = await readJson(path.join(root, ".autopilot", "state.json"))
      assert.equal(state.status, "human_required", JSON.stringify({ state, result }, null, 2))
      assert.ok(state[scenario.journal], JSON.stringify(state, null, 2))
      const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
      assert.equal(subjects.includes("autopilot: complete project"), false)

      const committedQueue = JSON.parse(await git(root, ["show", "HEAD:.project/plan/queue.json"]))
      if (scenario.journal === "completion") {
        assert.notEqual(committedQueue.tasks.M001.status, "done")
        assert.equal(subjects.includes("autopilot: record M001"), false)
      } else {
        assert.equal(committedQueue.tasks.M001.status, "done")
        assert.notEqual(committedQueue.project_status, "complete")
        assert.equal(subjects.includes("autopilot: record M001"), true)
      }
      assert.match(await git(root, ["status", "--porcelain"]), new RegExp(
        scenario.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", "[\\\\/]"),
      ))
    })
  }
})

test("finalization cannot report complete after exact metadata bytes change post-prepare", async (t) => {
  for (const file of [
    ".project/plan/queue.json",
    ".project/receipts/__project-final.json",
  ]) {
    await t.test(file, async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "success" })
      await ensureDirectAgents(root)
      const result = await controller(root, {
        env: {
          ...process.env,
          NODE_ENV: "test",
          AUTOPILOT_TEST_POST_PREPARE_RACE_LABEL: "project-finalization",
          AUTOPILOT_TEST_POST_PREPARE_RACE_FILE: file,
        },
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /GIT_TRANSACTION_CONFLICT/)

      const state = await readJson(path.join(root, ".autopilot", "state.json"))
      assert.equal(state.status, "human_required", JSON.stringify({ state, result }, null, 2))
      assert.ok(state.finalization, JSON.stringify(state, null, 2))
      const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
      assert.equal(subjects.filter((item) => item === "autopilot: complete project").length, 1)

      const committed = await git(root, ["show", `HEAD:${file}`])
      const working = await readFile(path.join(root, ...file.split("/")), "utf8")
      assert.notEqual(working, committed)
      assert.match(await git(root, ["status", "--porcelain"]), new RegExp(
        file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", "[\\\\/]"),
      ))
    })
  }
})

test("restart after the finalization commit verifies durable final evidence without repeating work", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  await ensureDirectAgents(root)
  const crash = await controller(root, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AUTOPILOT_TEST_CRASH_POINT: "after_final_commit",
    },
  })
  assert.equal(crash.code, 87, crash.stderr || crash.stdout)

  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const invocationsAtCrash = await readJson(invocationFile)
  const headAtCrash = await git(root, ["rev-parse", "HEAD"])
  const resumed = await controller(root)
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete")
  assert.equal(await git(root, ["rev-parse", "HEAD"]), headAtCrash)
  assert.deepEqual(await readJson(invocationFile), invocationsAtCrash)
  const finalReceipt = await readJson(path.join(root, ".project", "receipts", "__project-final.json"))
  assert.deepEqual(finalReceipt.gates.map((gate) => gate.gate_id), ["final"])
  assert.match(finalReceipt.gates[0].gate_definition_sha256, /^[0-9a-f]{64}$/)
  const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
  assert.equal(subjects.filter((item) => item === "autopilot: complete project").length, 1)
})
