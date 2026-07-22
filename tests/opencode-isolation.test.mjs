import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  createScaffold,
  fixedGateScript,
  git,
  readJson,
  repositoryRoot,
  run,
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

async function trustedGitArgv(root) {
  const processModule = await import(pathToFileURL(path.join(
    templateRoot,
    ".autopilot",
    "bin",
    "lib",
    "process.mjs",
  )))
  const environment = await processModule.externalExecutionEnv(root)
  return processModule.resolveExternalInvocation(root, "git", environment, {
    label: "test Git executable",
  })
}

const isolatedAgentSource = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const argv = process.argv.slice(2)
const launchCwd = process.cwd()
const runIndex = argv.indexOf("run")
const dirIndex = argv.indexOf("--dir")
const agentIndex = argv.indexOf("--agent")
const neutralCwd = (kind) => {
  const base = path.basename(launchCwd)
  if (kind === "probe" && !base.includes("-opencode-probe-")) {
    throw new Error("probe did not use a fresh neutral cwd")
  }
  if (
    kind === "phase" &&
    !(base === "launch-cwd" && path.basename(path.dirname(launchCwd)).includes("-opencode-phase-"))
  ) throw new Error("phase did not use a fresh neutral cwd")
}
if (process.argv.includes("--version")) {
  neutralCwd("probe")
  if (process.env.BUN_OPTIONS !== "--no-env-file") throw new Error("probe did not disable Bun dotenv loading")
  process.stdout.write("isolation-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  neutralCwd("probe")
  if (!(runIndex >= 0 && dirIndex > runIndex && agentIndex > dirIndex && path.resolve(argv[dirIndex + 1] ?? "") === launchCwd)) {
    throw new Error("capability probe did not place run --dir NEUTRAL before phase options")
  }
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

if (!(runIndex >= 0 && dirIndex > runIndex && agentIndex > dirIndex && path.isAbsolute(argv[dirIndex + 1] ?? ""))) {
  throw new Error("phase did not place run --dir PROJECT before phase options")
}
neutralCwd("phase")
const root = path.resolve(argv[dirIndex + 1])
if (root === launchCwd) throw new Error("phase launched from the project directory")
if (process.env.PROJECT_DOTENV_SENTINEL !== undefined) throw new Error("project dotenv sentinel reached the phase environment")
if (process.env.BUN_OPTIONS !== "--no-env-file") throw new Error("phase did not disable Bun dotenv loading")
try {
  await readFile(path.join(launchCwd, ".env.local"), "utf8")
  throw new Error("phase launch cwd contains a project dotenv file")
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
const runtime = path.join(root, ".autopilot", "runtime")
const prompt = process.argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const worker = stage !== "review"
const expectedServer = worker ? "worker_docs" : "review_docs"
const excludedServer = worker ? "review_docs" : "worker_docs"
const expectedVariable = worker ? "WORKER_MCP_TOKEN" : "REVIEW_MCP_TOKEN"

if (!process.argv.includes("--pure") || process.env.OPENCODE_PURE !== "1") {
  throw new Error("isolated phase did not enable pure mode")
}
if (process.env.WORKER_MCP_TOKEN !== undefined || process.env.REVIEW_MCP_TOKEN !== undefined) {
  throw new Error("phase credentials reached the OpenCode parent environment")
}
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"]) {
  if (!process.env[name]?.includes("opencode-phase-")) throw new Error(name + " is not phase-local")
}

const configText = process.env.OPENCODE_CONFIG_CONTENT ?? ""
const config = JSON.parse(configText)
const toolPolicy = JSON.parse(Buffer.from(process.env.AUTOPILOT_TOOL_POLICY, "base64").toString("utf8"))
if (Object.keys(config.mcp ?? {}).join(",") !== expectedServer || excludedServer in (config.mcp ?? {})) {
  throw new Error("phase received an ungranted MCP server")
}
if (
  toolPolicy.max_returned_bytes !== 64 * 1024 ||
  !toolPolicy.usage_path?.includes("opencode-phase-")
) throw new Error("phase tool accounting policy is missing or not phase-local")
const feedbackIds = Object.keys(toolPolicy.feedback_gates ?? {})
if (
  !toolPolicy.feedback_runner?.includes("opencode-phase-") ||
  (worker && (feedbackIds.join(",") !== "task" || toolPolicy.max_feedback_calls !== 2)) ||
  (!worker && (feedbackIds.length !== 0 || toolPolicy.max_feedback_calls !== 0))
) throw new Error("phase feedback policy is not task- and role-scoped")
const fileReference = /\{file:([^}]+)\}/.exec(JSON.stringify(config.mcp))?.[1]
if (!fileReference) throw new Error("phase credential was not converted to a file reference")
const secret = await readFile(fileReference, "utf8")
if (configText.includes(secret)) throw new Error("phase secret was embedded in inline OpenCode config")

const agent = worker ? (stage === "repair" ? "autopilot-recovery" : "autopilot-worker") : "autopilot-reviewer"
const agentText = await readFile(path.join(process.env.OPENCODE_CONFIG_DIR, "agents", agent + ".md"), "utf8")
if (!agentText.includes('"' + expectedServer + '_query": allow') || agentText.includes('"' + excludedServer + '_query": allow')) {
  throw new Error("sterile agent grants do not match the task phase")
}
if (!agentText.includes("autopilot_check: " + (worker ? "allow" : "deny"))) {
  throw new Error("sterile feedback-tool permission does not match eligibility")
}
await Promise.all([
  access(path.join(process.env.OPENCODE_CONFIG_DIR, "tools", "autopilot.js")),
  access(toolPolicy.feedback_runner),
])

await mkdir(runtime, { recursive: true })
const toolUsage = {
  schema_version: 1,
  phase: stage,
  task_id: taskId,
  tool_calls: 1,
  returned_bytes: 24,
  by_tool: { contract: { calls: 1, returned_bytes: 24 } },
}
try {
  const invalidUsage = (await readFile(path.join(runtime, "invalid-tool-usage.txt"), "utf8")).trim()
  if (invalidUsage === "usage-field") toolUsage.raw_output = "must not persist"
  if (invalidUsage === "counter-field") toolUsage.by_tool.contract.extra = 1
  if (invalidUsage === "model-field") toolUsage.model_usage = { raw_output: "must not persist" }
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
await writeFile(toolPolicy.usage_path, JSON.stringify(toolUsage) + "\n", "utf8")
const observationsFile = path.join(runtime, "isolation-observations.json")
let observations = []
try { observations = JSON.parse(await readFile(observationsFile, "utf8")) }
catch (error) { if (error?.code !== "ENOENT") throw error }
let feedbackRunnerExercised = false
observations.push({
  stage,
  selected_server: expectedServer,
  variable: expectedVariable,
  secret_sha256: createHash("sha256").update(secret).digest("hex"),
  secret_file: fileReference,
  pure_argv: process.argv.includes("--pure"),
  tool_usage_enabled: true,
  feedback_gate_ids: feedbackIds,
  feedback_permission: worker ? "allow" : "deny",
  feedback_runner_exercised: feedbackRunnerExercised,
  launch_cwd_is_sterile: launchCwd.includes("opencode-phase-") && path.basename(launchCwd) === "launch-cwd",
  project_dir_argument: root,
  dotenv_sentinel_absent: process.env.PROJECT_DOTENV_SENTINEL === undefined,
})

let contractLeakMode = ""
try { contractLeakMode = (await readFile(path.join(runtime, "contract-secret-leak-mode.txt"), "utf8")).trim() }
catch (error) { if (error?.code !== "ENOENT") throw error }

if (stage === "review") {
  const review = contractLeakMode === "review"
    ? {
        schema_version: 1,
        task_id: taskId,
        status: "changes_requested",
        summary: secret,
        findings: [{
          severity: "low",
          file: "src/result.txt",
          message: JSON.stringify({
            encoded: Buffer.from(secret, "utf8").toString("base64url"),
            escaped: secret,
          }),
        }],
      }
    : {
        schema_version: 1,
        task_id: taskId,
        status: "approved",
        summary: "The isolated fixture approved the deterministic evidence.",
        findings: [],
      }
  await writeJson(path.join(runtime, "review.json"), review)
} else {
  await mkdir(path.join(root, "src"), { recursive: true })
  let resultText = "GOOD\n"
  try {
    const leakMode = (await readFile(path.join(runtime, "exact-secret-leak-mode.txt"), "utf8")).trim()
    if (leakMode === "json") resultText = JSON.stringify({ opaque_value: secret }) + "\n"
    else if (leakMode === "base64") resultText = Buffer.from(secret, "utf8").toString("base64") + "\n"
    else if (leakMode === "oauth-metadata") resultText = "oauth\n"
    else if (leakMode === "selected-mcp-auth-base64") {
      const auth = JSON.parse(await readFile(path.join(process.env.XDG_DATA_HOME, "opencode", "mcp-auth.json"), "utf8"))
      const selectedAuth = auth[expectedServer]
      const selectedAuthSecret = selectedAuth.codeVerifier ?? selectedAuth.accessToken ?? selectedAuth.sessionBlob
      resultText = Buffer.from(selectedAuthSecret, "utf8").toString("base64") + "\n"
      if (selectedAuth.oauthState) resultText += JSON.stringify({ state: selectedAuth.oauthState }) + "\n"
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await writeFile(path.join(root, "src", "result.txt"), resultText, "utf8")
  if (resultText === "GOOD\n" && contractLeakMode !== "candidate") {
    const authorizedGate = toolPolicy.feedback_gates?.task
    const feedback = spawnSync(process.execPath, [
      toolPolicy.feedback_runner,
      "task",
      "--root", root,
      "--task", taskId,
      "--attempt", String(attempt),
      "--feedback",
      "--expected-definition-sha256", authorizedGate?.definition_sha256 ?? "",
    ], {
      cwd: root,
      env: { ...process.env, AUTOPILOT_INTERNAL_GATE_RUNNER: "1" },
      encoding: "utf8",
    })
    if (feedback.status !== 0) {
      throw new Error("phase-local feedback runner failed: " + (feedback.stderr || feedback.stdout))
    }
    feedbackRunnerExercised = true
  }
  const candidate = contractLeakMode === "candidate"
    ? {
        schema_version: 1,
        task_id: taskId,
        attempt,
        status: "blocked",
        summary: secret,
        changed_files: ["src/result.txt"],
        environment_variables: [expectedVariable],
        blocker: {
          kind: "opaque_fixture",
          message: JSON.stringify({ opaque: secret }),
          required_action: Buffer.from(secret, "utf8").toString("base64url"),
          resume_condition: encodeURIComponent(secret),
        },
      }
    : {
        schema_version: 1,
        task_id: taskId,
        attempt,
        status: "complete",
        summary: "The isolated fixture produced the bounded candidate.",
        changed_files: ["src/result.txt"],
        environment_variables: [expectedVariable],
        blocker: null,
      }
  await writeJson(path.join(runtime, "candidate.json"), candidate)
}

observations.at(-1).feedback_runner_exercised = feedbackRunnerExercised
await writeFile(observationsFile, JSON.stringify(observations, null, 2) + "\n", "utf8")

const sessionID = "isolated-" + stage + "-a" + attempt + "-p" + process.pid
const usagePart = (id, input, output, reasoning, cacheRead, cacheWrite, cost) => ({
  id,
  sessionID,
  messageID: "message-" + stage,
  type: "step-finish",
  reason: "stop",
  cost,
  tokens: {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  },
})
const firstUsage = usagePart("part-1", 100, 20, 5, 50, 10, 0.125)
let sessionOutputMode = "valid"
try { sessionOutputMode = (await readFile(path.join(runtime, "session-output-mode.txt"), "utf8")).trim() }
catch (error) { if (error?.code !== "ENOENT") throw error }
if (sessionOutputMode === "nested") {
  process.stdout.write(JSON.stringify({ type: "session", payload: { sessionID } }) + "\n")
} else {
  process.stdout.write(JSON.stringify({ type: "session", sessionID }) + "\n")
  for (const event of [
    { type: "step_finish", sessionID, part: firstUsage },
    { type: "step_finish", sessionID, part: firstUsage },
    { type: "step_finish", sessionID, part: usagePart("part-2", 30, 4, 1, 20, 0, 0.375) },
    { type: "step_finish", sessionID, part: usagePart("part-malformed", -1, 9, 9, 9, 9, 9) },
    { type: "step_finish", sessionID, part: usagePart("part-over-cost", 9, 9, 9, 9, 9, 1000001) },
    { type: "step_finish", sessionID, part: { ...usagePart("part-mismatch", 999, 999, 999, 999, 999, 999), sessionID: "other-session" } },
    { type: "step_finish", part: usagePart("part-missing-session", 999, 999, 999, 999, 999, 999) },
    { type: "noise", sessionID, payload: { type: "step_finish", part: usagePart("part-nested", 999, 999, 999, 999, 999, 999) } },
  ]) process.stdout.write(JSON.stringify(event) + "\n")
}
process.stdout.write("{malformed-json\n")

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

async function configureIsolationProject(t, root, {
  reservedLocalEnvironment = false,
  workerSecret = "worker-phase-secret-987654",
  reviewSecret = "review-phase-secret-123456",
} = {}) {
  const runtime = path.join(root, ".autopilot", "runtime")
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "autopilot-external-opencode-"))
  const agent = path.join(agentRoot, "isolated-opencode.mjs")
  t.after(() => rm(agentRoot, { recursive: true, force: true }))
  await mkdir(runtime, { recursive: true })
  await writeFile(agent, isolatedAgentSource, "utf8")
  await writeFile(
    path.join(root, ".env.worker.local"),
    `WORKER_MCP_TOKEN=${JSON.stringify(workerSecret)}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  await writeFile(
    path.join(root, ".env.review.local"),
    `REVIEW_MCP_TOKEN=${JSON.stringify(reviewSecret)}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
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

  const openCodeFile = path.join(root, "opencode.jsonc")
  const openCode = await readJson(openCodeFile)
  openCode.mcp = {
    worker_docs: reservedLocalEnvironment
      ? {
        type: "local",
        command: [process.execPath, "--version"],
        environment: { HOME: "{env:WORKER_MCP_TOKEN}" },
      }
      : {
        type: "remote",
        url: "https://worker.example.invalid/mcp",
        headers: { Authorization: "Bearer {env:WORKER_MCP_TOKEN}" },
      },
    review_docs: {
      type: "remote",
      url: "https://review.example.invalid/mcp",
      headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" },
    },
  }
  await writeJson(openCodeFile, openCode)
  await writeJson(path.join(root, ".project", "tools.json"), {
    schema_version: 1,
    roles: {
      worker: ["worker_docs_query", "review_docs_query"],
      recovery: ["worker_docs_query", "review_docs_query"],
      reviewer: ["worker_docs_query", "review_docs_query"],
    },
  })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.tool_grants = {
    execute: ["worker_docs_query"],
    repair: ["worker_docs_query"],
    review: ["review_docs_query"],
  }
  await writeJson(queueFile, queue)

  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, agent]
  config.opencode.credential_profiles = {
    execute: "worker",
    repair: "worker",
    review: "reviewer",
  }
  config.opencode.provider_environment = []
  await writeJson(configFile, config)
  const configured = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "configure-tools.mjs"), "--root", root, "--json"],
    { cwd: root },
  )
  assert.equal(configured.code, 0, configured.stderr || configured.stdout)
  await git(root, ["add", "opencode.jsonc", ".project/tools.json", ".project/plan/queue.json", ".autopilot/config.json", ".opencode/agents"])
  await git(root, ["commit", "-m", "test: configure isolated phase MCPs"])
}

async function sterileControllerEnvironment(root) {
  const sourceData = path.join(root, ".autopilot", "runtime", "empty-source-data")
  await mkdir(sourceData, { recursive: true })
  const env = { ...process.env, XDG_DATA_HOME: sourceData }
  delete env.OPENCODE_AUTH_CONTENT
  return env
}

function commonSecretRepresentations(secret) {
  const bytes = Buffer.from(secret, "utf8")
  const base64 = bytes.toString("base64")
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    base64,
    base64.replaceAll("+", "-").replaceAll("/", "_"),
    base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
  ]
}

function assertSecretRepresentationsAbsent(text, secret) {
  for (const representation of commonSecretRepresentations(secret)) {
    assert.equal(text.includes(representation), false, "persisted an exact secret representation")
  }
}

test("controller-owned tools exclude ignored content and reject unsafe file identities", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-tools-test-"))
  const profile = await mkdtemp(path.join(os.tmpdir(), "autopilot-tool-profile-"))
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(profile, { recursive: true, force: true }),
    ])
  })

  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "public.txt"), "PUBLIC NEEDLE\n", "utf8")
  await writeFile(path.join(root, "src", "hidden.txt"), "TOPSECRET NEEDLE\n", "utf8")
  await writeFile(
    path.join(root, "src", "paged.txt"),
    `${Array.from({ length: 150 }, (_item, index) => `line-${index + 1}`).join("\n")}\n`,
    "utf8",
  )
  await writeFile(path.join(root, "src", "matches.txt"), "PUBLIC ALPHA\nPUBLIC BETA\n", "utf8")
  await writeFile(path.join(root, "src", "move.txt"), "MOVE ME\n", "utf8")
  await writeFile(path.join(root, "src", "delete.txt"), "DELETE ME\n", "utf8")
  await writeFile(path.join(root, "src", "script.sh"), "#!/bin/sh\nexit 0\n", "utf8")
  await writeFile(
    path.join(root, "src", "wide.txt"),
    `WIDE ${"x".repeat(40000)}\n`,
    "utf8",
  )
  await git(root, ["init"])
  await git(root, ["config", "user.name", "Isolation Test"])
  await git(root, ["config", "user.email", "isolation@example.invalid"])
  await git(root, ["add", "src/public.txt", "src/hidden.txt", "src/paged.txt", "src/matches.txt", "src/wide.txt", "src/move.txt", "src/delete.txt", "src/script.sh"])
  await git(root, ["commit", "-m", "test: seed application files"])
  await writeFile(path.join(root, ".gitignore"), "src/hidden.txt\n", "utf8")
  await git(root, ["add", ".gitignore"])
  await git(root, ["commit", "-m", "test: ignore a tracked file"])

  const hardlinkSource = path.join(root, "hardlink-source.txt")
  await writeFile(hardlinkSource, "HARDLINK SECRET\n", "utf8")
  await link(hardlinkSource, path.join(root, "src", "hardlink.txt"))
  let symlinkAvailable = true
  try { await symlink("public.txt", path.join(root, "src", "symlink.txt"), "file") }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) symlinkAvailable = false
    else throw error
  }

  const packageRoot = path.join(profile, "node_modules", "@opencode-ai", "plugin")
  const toolsRoot = path.join(profile, "tools")
  await Promise.all([mkdir(packageRoot, { recursive: true }), mkdir(toolsRoot, { recursive: true })])
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }), "utf8")
  await writeFile(
    path.join(packageRoot, "index.js"),
    "const chain = new Proxy({}, { get: () => () => chain });\nexport function tool(value) { return value }\ntool.schema = { string: () => chain, number: () => chain, boolean: () => chain, enum: () => chain, object: () => chain, array: () => chain };\n",
    "utf8",
  )
  const copiedTool = path.join(toolsRoot, "autopilot.mjs")
  const usageFile = path.join(profile, "tool-usage.json")
  await copyFile(path.join(templateRoot, ".autopilot", "bin", "opencode-tools.mjs"), copiedTool)

  const previousPolicy = process.env.AUTOPILOT_TOOL_POLICY
  const baseline = await git(root, ["rev-parse", "HEAD"])
  process.env.AUTOPILOT_TOOL_POLICY = Buffer.from(JSON.stringify({
    schema_version: 1,
    root,
    task_id: "M001",
    phase: "execute",
    attempt: 1,
    baseline_head: baseline,
    allowed_paths: ["src/**"],
    contract_path: ".autopilot/runtime/candidate.json",
    max_returned_bytes: 32768,
    usage_path: usageFile,
    feedback_runner: path.join(root, ".autopilot", "bin", "run-gate.mjs"),
    feedback_gates: {},
    max_feedback_calls: 0,
    git_argv: await trustedGitArgv(root),
  }), "utf8").toString("base64")
  t.after(() => {
    if (previousPolicy === undefined) delete process.env.AUTOPILOT_TOOL_POLICY
    else process.env.AUTOPILOT_TOOL_POLICY = previousPolicy
  })
  const tools = await import(`${pathToFileURL(copiedTool).href}?test=${Date.now()}`)

  await assert.rejects(
    tools.read.execute({ path: "src/public.txt", offset: -1 }),
    /read offset must be an integer between/,
  )
  await assert.rejects(
    tools.read.execute({ path: "src/public.txt", unexpected: true }),
    /read input contains unsupported field/,
  )
  await assert.rejects(
    tools.list.execute({ offset: Number.MAX_SAFE_INTEGER }),
    /list offset must be an integer between/,
  )
  await assert.rejects(
    tools.search.execute({ pattern: "PUBLIC", max_results: 101 }),
    /search max_results must be an integer between/,
  )
  await assert.rejects(
    tools.write.execute({ path: "src/invalid.txt", content: "x".repeat(1024 * 1024 + 1) }),
    /write content must be a bounded string/,
  )
  await assert.rejects(
    tools.edit.execute({ path: "src/public.txt", old_text: "", new_text: "replacement" }),
    /edit old_text must be a bounded non-empty string/,
  )
  await assert.rejects(
    tools.mutate.execute({
      operation: "delete", path: "src/public.txt", destination: null, executable: null, extra: true,
    }),
    /mutation input fields must be exactly/,
  )
  await assert.rejects(
    tools.check.execute({ gate_id: "task", extra: true }),
    /check input fields must be exactly/,
  )
  await assert.rejects(
    tools.contract.execute({
      status: "complete",
      summary: "Invalid extra field.",
      environment_variables: [],
      blocker: null,
      extra: true,
    }),
    /candidate input fields must be exactly/,
  )
  await assert.rejects(access(usageFile))
  await assert.rejects(access(path.join(root, "src", "invalid.txt")))

  const listedPaths = []
  let listOffset = 0
  while (listOffset !== "end") {
    const listed = await tools.list.execute({ prefix: "src", offset: listOffset, max_results: 2 })
    const header = /^\[list offset=(\d+) count=(\d+) total=(\d+) next=(\d+|end)\]/.exec(listed)
    assert.ok(header, listed)
    listedPaths.push(...listed.split("\n").slice(1))
    listOffset = header[4] === "end" ? "end" : Number(header[4])
  }
  assert.ok(listedPaths.includes("src/public.txt"))
  assert.equal(listedPaths.some((item) => item.includes("hidden.txt")), false)
  const hiddenSearch = await tools.search.execute({ pattern: "TOPSECRET" })
  assert.doesNotMatch(hiddenSearch, /TOPSECRET/)
  assert.match(hiddenSearch, /No matches/)
  const firstMatch = await tools.search.execute({ pattern: "PUBLIC", max_results: 1 })
  assert.match(firstMatch, /^\[search offset=0 count=1 next=1 unavailable=\d+\]/)
  assert.match(firstMatch, /src\/matches\.txt:1:PUBLIC ALPHA/)
  const secondMatch = await tools.search.execute({ pattern: "PUBLIC", offset: 1, max_results: 1 })
  assert.match(secondMatch, /^\[search offset=1 count=1 next=2 unavailable=\d+\]/)
  assert.match(secondMatch, /src\/matches\.txt:2:PUBLIC BETA/)
  await assert.rejects(
    tools.search.execute({ pattern: "WIDE", prefix: "src/wide.txt", max_results: 1 }),
    /Match src\/wide\.txt:1 cannot fit.*read that file at offset 1.*line:column cursor/s,
  )
  const paged = await tools.read.execute({ path: "src/paged.txt" })
  assert.match(paged, /^\[read src\/paged\.txt range=1:1-120:\d+ total=151 next=121:1\]\nline-1\n/)
  assert.doesNotMatch(paged, /\n1: line-1/)
  assert.match(await tools.read.execute({ path: "src/paged.txt", offset: 121, limit: 30 }), /line-150/)
  assert.match(await tools.read.execute({ path: "src/public.txt" }), /\nPUBLIC NEEDLE\n?$/)
  await assert.rejects(tools.read.execute({ path: "src/hidden.txt" }), /Protected or ignored path/)
  await assert.rejects(tools.read.execute({ path: "src/hardlink.txt" }), /private regular file/)
  await assert.rejects(tools.read.execute({ path: "src/bad|name.txt" }), /portable project-relative path/)
  await assert.rejects(
    tools.read.execute({ path: "src/wide.txt" }),
    /phase byte budget 32768 would be exceeded.*Scope is too broad.*paginate with offset\/max_results/s,
  )

  assert.equal(
    await tools.mutate.execute({ operation: "move", path: "src/move.txt", destination: "src/moved.txt", executable: null }),
    "Moved src/move.txt to src/moved.txt",
  )
  assert.equal(await readFile(path.join(root, "src", "moved.txt"), "utf8"), "MOVE ME\n")
  await assert.rejects(access(path.join(root, "src", "move.txt")))
  assert.equal(
    await tools.mutate.execute({ operation: "delete", path: "src/delete.txt", destination: null, executable: null }),
    "Deleted src/delete.txt",
  )
  await assert.rejects(access(path.join(root, "src", "delete.txt")))
  await tools.mutate.execute({ operation: "executable", path: "src/script.sh", destination: null, executable: true })
  if (process.platform !== "win32") assert.equal((await stat(path.join(root, "src", "script.sh"))).mode & 0o111, 0o111)
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".autopilot", "runtime", "mode-intent.json"), "utf8")).intents,
    [{ path: "src/script.sh", executable: true }],
  )
  await assert.rejects(
    tools.mutate.execute({ operation: "move", path: "src/moved.txt", destination: "outside.txt", executable: null }),
    /outside the task boundary/,
  )
  await assert.rejects(
    tools.mutate.execute({ operation: "move", path: "src/moved.txt", destination: "src/public.txt", executable: null }),
    /destination already exists/,
  )
  await assert.rejects(
    tools.mutate.execute({ operation: "delete", path: "src/hardlink.txt", destination: null, executable: null }),
    /private regular file/,
  )
  if (symlinkAvailable) {
    await assert.rejects(
      tools.mutate.execute({ operation: "delete", path: "src/symlink.txt", destination: null, executable: null }),
      /private regular file/,
    )
  }

  const usage = JSON.parse(await readFile(usageFile, "utf8"))
  assert.equal(usage.schema_version, 1)
  assert.equal(usage.phase, "execute")
  assert.equal(usage.task_id, "M001")
  assert.ok(usage.tool_calls >= 12)
  assert.ok(usage.returned_bytes > 0 && usage.returned_bytes < 32768)
  assert.equal(usage.by_tool.read.calls >= 6, true)
  assert.equal(usage.by_tool.mutate.calls >= 6, true)
})

test("typed phase contracts derive controller-owned identity and exact changed files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-contract-test-"))
  const profile = await mkdtemp(path.join(os.tmpdir(), "autopilot-contract-profile-"))
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(profile, { recursive: true, force: true }),
  ]))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "tracked.txt"), "before\n", "utf8")
  await writeFile(path.join(root, "src", "delete.txt"), "delete\n", "utf8")
  await writeFile(path.join(root, "src", "move.txt"), "move\n", "utf8")
  await writeFile(path.join(root, "src", "script.sh"), "#!/bin/sh\nexit 0\n", "utf8")
  await git(root, ["init"])
  await git(root, ["config", "user.name", "Contract Test"])
  await git(root, ["config", "user.email", "contract@example.invalid"])
  await git(root, ["add", "src/tracked.txt", "src/delete.txt", "src/move.txt", "src/script.sh"])
  await git(root, ["commit", "-m", "test: seed contract tree"])
  const baseline = await git(root, ["rev-parse", "HEAD"])

  const packageRoot = path.join(profile, "node_modules", "@opencode-ai", "plugin")
  await mkdir(packageRoot, { recursive: true })
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }), "utf8")
  await writeFile(
    path.join(packageRoot, "index.js"),
    "const chain = new Proxy({}, { get: () => () => chain });\nexport function tool(value) { return value }\ntool.schema = { string: () => chain, number: () => chain, boolean: () => chain, enum: () => chain, object: () => chain, array: () => chain };\n",
    "utf8",
  )
  const sourceTool = path.join(templateRoot, ".autopilot", "bin", "opencode-tools.mjs")
  const candidateTool = path.join(profile, "candidate-tools.mjs")
  await copyFile(sourceTool, candidateTool)
  const previousPolicy = process.env.AUTOPILOT_TOOL_POLICY
  const gitArgv = await trustedGitArgv(root)
  const setPolicy = (phase, contractPath, usagePath) => {
    process.env.AUTOPILOT_TOOL_POLICY = Buffer.from(JSON.stringify({
      schema_version: 1,
      root,
      task_id: "M001",
      phase,
      attempt: 2,
      baseline_head: baseline,
      allowed_paths: ["src/**"],
      contract_path: contractPath,
      max_returned_bytes: 32768,
      usage_path: usagePath,
      feedback_runner: path.join(root, ".autopilot", "bin", "run-gate.mjs"),
      feedback_gates: {},
      max_feedback_calls: 0,
      git_argv: gitArgv,
    }), "utf8").toString("base64")
  }
  t.after(() => {
    if (previousPolicy === undefined) delete process.env.AUTOPILOT_TOOL_POLICY
    else process.env.AUTOPILOT_TOOL_POLICY = previousPolicy
  })

  await writeFile(path.join(root, "src", "tracked.txt"), "after\n", "utf8")
  await writeFile(path.join(root, "src", "new.txt"), "new\n", "utf8")
  setPolicy("execute", ".autopilot/runtime/candidate.json", path.join(profile, "candidate-usage.json"))
  const candidateTools = await import(`${pathToFileURL(candidateTool).href}?candidate=${Date.now()}`)
  await candidateTools.mutate.execute({
    operation: "move",
    path: "src/move.txt",
    destination: "src/moved.txt",
    executable: null,
  })
  await candidateTools.mutate.execute({
    operation: "delete",
    path: "src/delete.txt",
    destination: null,
    executable: null,
  })
  await candidateTools.mutate.execute({
    operation: "executable",
    path: "src/script.sh",
    destination: null,
    executable: true,
  })
  await assert.rejects(
    candidateTools.contract.execute({
      status: "complete",
      summary: "Attempted spoof.",
      environment_variables: [],
      blocker: null,
      attempt: 999,
    }),
    /fields must be exactly/,
  )
  await assert.rejects(
    candidateTools.contract.execute({
      status: "complete",
      summary: "Invalid blocker.",
      environment_variables: [],
      blocker: {
        kind: "manual",
        message: "Not applicable.",
        required_action: "None.",
        resume_condition: "None.",
      },
    }),
    /only for blocked status/,
  )
  await candidateTools.contract.execute({
    status: "complete",
    summary: "Implemented the scoped change.",
    environment_variables: [],
    blocker: null,
  })
  const candidate = await readJson(path.join(root, ".autopilot", "runtime", "candidate.json"))
  assert.deepEqual(candidate, {
    schema_version: 1,
    task_id: "M001",
    attempt: 2,
    status: "complete",
    summary: "Implemented the scoped change.",
    changed_files: [
      "src/delete.txt",
      "src/move.txt",
      "src/moved.txt",
      "src/new.txt",
      "src/script.sh",
      "src/tracked.txt",
    ],
    environment_variables: [],
    blocker: null,
  })
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".autopilot", "runtime", "mode-intent.json"), "utf8")),
    {
      schema_version: 1,
      task_id: "M001",
      attempt: 2,
      intents: [{ path: "src/script.sh", executable: true }],
    },
  )
  await assert.rejects(
    candidateTools.contract.execute({
      status: "complete",
      summary: "Duplicate.",
      environment_variables: [],
      blocker: null,
    }),
    /already recorded/,
  )

  const reviewTool = path.join(profile, "review-tools.mjs")
  await copyFile(sourceTool, reviewTool)
  setPolicy("review", ".autopilot/runtime/review.json", path.join(profile, "review-usage.json"))
  const reviewTools = await import(`${pathToFileURL(reviewTool).href}?review=${Date.now()}`)
  await reviewTools.contract.execute({
    status: "approved",
    summary: "Evidence is complete.",
    findings: [],
  })
  assert.deepEqual(await readJson(path.join(root, ".autopilot", "runtime", "review.json")), {
    schema_version: 1,
    task_id: "M001",
    status: "approved",
    summary: "Evidence is complete.",
    findings: [],
  })
})

test("autopilot_check returns bounded gate feedback and enforces the two-call phase cap", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const profile = await mkdtemp(path.join(os.tmpdir(), "autopilot-check-profile-"))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const packageRoot = path.join(profile, "node_modules", "@opencode-ai", "plugin")
  await mkdir(packageRoot, { recursive: true })
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }), "utf8")
  await writeFile(
    path.join(packageRoot, "index.js"),
    "const chain = new Proxy({}, { get: () => () => chain });\nexport function tool(value) { return value }\ntool.schema = { string: () => chain, number: () => chain, boolean: () => chain, enum: () => chain, object: () => chain, array: () => chain };\n",
    "utf8",
  )
  const copiedTool = path.join(profile, "autopilot.mjs")
  await copyFile(path.join(root, ".autopilot", "bin", "opencode-tools.mjs"), copiedTool)
  const gateRuntime = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "gate-runner.mjs")))
  const gates = await readJson(path.join(root, ".project", "gates.json"))
  const definitionSha256 = gateRuntime.gateDefinitionSha256(gates.gates.task)
  await assert.rejects(
    gateRuntime.runGate(root, "task", {
      taskId: "M001",
      attempt: 1,
      feedback: true,
      expectedDefinitionSha256: "0".repeat(64),
    }),
    (error) => error?.code === "GATE_FEEDBACK_DEFINITION_CHANGED",
  )
  await assert.rejects(
    gateRuntime.runGate(root, "task", {
      taskId: "missing-task",
      attempt: 1,
      feedback: true,
      expectedDefinitionSha256: definitionSha256,
    }),
    (error) => error?.code === "GATE_FEEDBACK_TASK_DENIED",
  )
  await assert.rejects(
    gateRuntime.runGate(root, "final", {
      taskId: "M001",
      attempt: 1,
      feedback: true,
      expectedDefinitionSha256: gateRuntime.gateDefinitionSha256(gates.gates.final),
    }),
    (error) => error?.code === "GATE_FEEDBACK_DENIED",
  )
  const usageFile = path.join(profile, "tool-usage.json")
  const previousPolicy = process.env.AUTOPILOT_TOOL_POLICY
  process.env.AUTOPILOT_TOOL_POLICY = Buffer.from(JSON.stringify({
    schema_version: 1,
    root,
    task_id: "M001",
    phase: "execute",
    attempt: 1,
    baseline_head: await git(root, ["rev-parse", "HEAD"]),
    allowed_paths: ["src/**"],
    contract_path: ".autopilot/runtime/candidate.json",
    max_returned_bytes: 32768,
    usage_path: usageFile,
    feedback_runner: path.join(root, ".autopilot", "bin", "run-gate.mjs"),
    feedback_gates: {
      task: { definition_sha256: definitionSha256, timeout_seconds: gates.gates.task.timeout_seconds },
    },
    max_feedback_calls: 2,
    git_argv: await trustedGitArgv(root),
  }), "utf8").toString("base64")
  t.after(() => {
    if (previousPolicy === undefined) delete process.env.AUTOPILOT_TOOL_POLICY
    else process.env.AUTOPILOT_TOOL_POLICY = previousPolicy
  })

  const tools = await import(`${pathToFileURL(copiedTool).href}?check=${Date.now()}`)
  const failed = JSON.parse(await tools.check.execute({ gate_id: "task" }))
  assert.equal(failed.success, false)
  assert.equal(typeof failed.diagnostic.stderr, "string")
  assert.equal(Object.hasOwn(failed, "artifact"), false)

  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "result.txt"), "GOOD\n", "utf8")
  const passed = JSON.parse(await tools.check.execute({ gate_id: "task" }))
  assert.deepEqual(Object.keys(passed), ["gate_id", "success", "code", "timed_out", "duration_ms"])
  assert.equal(passed.success, true)
  await assert.rejects(tools.check.execute({ gate_id: "task" }), /limited to 2 calls/)
  const usage = await readJson(usageFile)
  assert.deepEqual(usage.by_tool.check, {
    calls: 2,
    returned_bytes: usage.returned_bytes,
  })
})

test("feedback permission stays denied without an eligible gate and for review", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task.feedback = false
  await writeJson(gatesFile, gates)
  const sourceData = await mkdtemp(path.join(os.tmpdir(), "autopilot-empty-opencode-data-"))
  t.after(() => rm(sourceData, { recursive: true, force: true }))
  const previousData = process.env.XDG_DATA_HOME
  const previousAuth = process.env.OPENCODE_AUTH_CONTENT
  process.env.XDG_DATA_HOME = sourceData
  delete process.env.OPENCODE_AUTH_CONTENT
  t.after(() => {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  })
  const isolated = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "opencode-isolated.mjs")))
  const projectRuntime = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
  const project = await projectRuntime.loadProject(root)
  const baseline = await git(root, ["rev-parse", "HEAD"])
  for (const phase of ["execute", "review"]) {
    const preflight = await isolated.preflightFreshOpenCode(project, { phase, taskId: "M001", baseline })
    assert.deepEqual(preflight.feedbackGates, {})
    assert.match(preflight.effectiveAgent, /^  autopilot_check: deny$/m)
    assert.doesNotMatch(preflight.effectiveAgent, /^  autopilot_check: allow$/m)
  }
})

test("phase credential loading returns only the selected MCP names and skips empty subsets", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await writeFile(
    path.join(root, ".env.union.local"),
    "SELECTED_TOKEN=selected-secret-123456\nUNSELECTED_TOKEN=unselected-secret-987654\n",
    { encoding: "utf8", mode: 0o600 },
  )
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      union: {
        env_file: ".env.union.local",
        allow: ["SELECTED_TOKEN", "UNSELECTED_TOKEN"],
        allowed_gates: ["opencode"],
      },
      unused: {
        env_file: ".env.missing.local",
        allow: ["MISSING_TOKEN"],
        allowed_gates: ["opencode"],
      },
    },
  })
  const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
  const gateModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "gate-runner.mjs")))
  const project = await projectModule.loadProject(root)
  const selected = await gateModule.credentialEnvironmentForScope(project, "opencode", "union", {
    requiredNames: ["SELECTED_TOKEN"],
  })
  assert.deepEqual(selected.names, ["SELECTED_TOKEN"])
  assert.deepEqual(selected.environment, { SELECTED_TOKEN: "selected-secret-123456" })
  assert.deepEqual(selected.secrets, ["selected-secret-123456"])
  assert.equal(JSON.stringify(selected).includes("unselected-secret-987654"), false)
  await gateModule.assertCredentialInputsUnchanged(project, "opencode", selected.freeze)

  const empty = await gateModule.credentialEnvironmentForScope(project, "opencode", "unused", {
    requiredNames: [],
  })
  assert.deepEqual(empty, { environment: {}, names: [], secrets: [], freeze: null })
})

test("POSIX credential and OpenCode auth sources must grant no group or other permissions", {
  skip: process.platform === "win32" ? "POSIX mode bits are unavailable on Windows" : false,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })
  const envFile = path.join(root, ".env.private.local")
  await writeFile(envFile, "PRIVATE_TOKEN=opaque-private-value-4826\n", { encoding: "utf8", mode: 0o644 })
  await chmod(envFile, 0o644)
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      private: {
        env_file: ".env.private.local",
        allow: ["PRIVATE_TOKEN"],
        allowed_gates: ["task"],
      },
    },
  })
  const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
  const gateModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "gate-runner.mjs")))
  const isolatedModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "opencode-isolated.mjs")))
  const project = await projectModule.loadProject(root)
  await assert.rejects(
    gateModule.credentialEnvironmentForScope(project, "task", "private"),
    /private regular file|POSIX|0600/i,
  )
  await chmod(envFile, 0o600)
  const loaded = await gateModule.credentialEnvironmentForScope(project, "task", "private")
  assert.deepEqual(loaded.names, ["PRIVATE_TOKEN"])

  const sourceData = path.join(root, ".autopilot", "runtime", "posix-source-data")
  const authFile = path.join(sourceData, "opencode", "auth.json")
  await mkdir(path.dirname(authFile), { recursive: true })
  await writeFile(authFile, '{"test":{"type":"api","key":"opaque-auth-value-5937"}}\n', {
    encoding: "utf8",
    mode: 0o644,
  })
  await chmod(authFile, 0o644)
  const previousData = process.env.XDG_DATA_HOME
  const previousSourceData = process.env.AUTOPILOT_SOURCE_DATA_HOME
  process.env.XDG_DATA_HOME = sourceData
  delete process.env.AUTOPILOT_SOURCE_DATA_HOME
  t.after(() => {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousSourceData === undefined) delete process.env.AUTOPILOT_SOURCE_DATA_HOME
    else process.env.AUTOPILOT_SOURCE_DATA_HOME = previousSourceData
  })
  const baseline = await git(root, ["rev-parse", "HEAD"])
  await assert.rejects(
    isolatedModule.preflightFreshOpenCode(project, { phase: "execute", taskId: "M001", baseline }),
    /must not grant group or other POSIX permissions|0600/i,
  )
  await chmod(authFile, 0o600)
  const preflight = await isolatedModule.preflightFreshOpenCode(project, {
    phase: "execute",
    taskId: "M001",
    baseline,
  })
  assert.equal(preflight.providerAuth?.value?.test?.key, "opaque-auth-value-5937")
})

test("exact ephemeral secret matching covers opaque raw, JSON, URL, base64, base64url, and hex forms", async () => {
  const secrets = await import(
    pathToFileURL(path.join(templateRoot, ".autopilot", "bin", "lib", "secrets.mjs")).href
  )
  const secret = "Orchid\"Fjord\nCobalt\\Quartz-4826"
  assert.deepEqual(secrets.secretMatches(secret), [])
  const bytes = Buffer.from(secret, "utf8")
  const base64 = bytes.toString("base64")
  const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_")
  const samples = [
    secret,
    JSON.stringify({ opaque: secret }),
    encodeURIComponent(secret),
    base64,
    base64.replace(/=+$/, ""),
    base64Url,
    base64Url.replace(/=+$/, ""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
  ]
  for (const sample of samples) {
    const matches = secrets.exactSecretMatches(sample, [secret])
    assert.ok(matches.length > 0, `missed exact secret representation: ${sample}`)
    assert.equal(JSON.stringify(matches).includes(secret), false)
  }
})

test("JSON-escaped opaque phase credentials in candidate bytes block before gates or review", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const workerSecret = "Orchid\"Fjord\nCobalt\\Quartz-4826"
  await configureIsolationProject(t, root, { workerSecret })
  await writeFile(
    path.join(root, ".autopilot", "runtime", "exact-secret-leak-mode.txt"),
    "json\n",
    "utf8",
  )
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: await sterileControllerEnvironment(root) },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.equal(state.blocker?.kind, "policy_violation")
  assert.match(state.blocker?.message ?? "", /exact ephemeral credential|secret scan/i)
  assert.equal(JSON.stringify(state).includes(workerSecret), false)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(workerSecret), false)
  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute"])
  const gateArtifacts = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => /-M001-(?:task|final)-/.test(name))
  assert.deepEqual(gateArtifacts, [])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("failed phase output is exact-secret scanned before repair or gates", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const workerSecret = "Nimbus\"Harbor\nCopper\\Delta-5937"
  await configureIsolationProject(t, root, { workerSecret })
  await Promise.all([
    writeFile(path.join(root, ".autopilot", "runtime", "exact-secret-leak-mode.txt"), "json\n", "utf8"),
    writeFile(path.join(root, ".autopilot", "runtime", "session-output-mode.txt"), "nested\n", "utf8"),
  ])
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: await sterileControllerEnvironment(root) },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.equal(state.attempt, 1)
  assert.equal(state.blocker?.kind, "policy_violation")
  assert.match(state.blocker?.message ?? "", /exact secret scan blocked failed phase output/i)
  assert.equal(JSON.stringify(state).includes(workerSecret), false)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(workerSecret), false)
  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute"])
  const gateArtifacts = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => /-M001-(?:task|final)-/.test(name))
  assert.deepEqual(gateArtifacts, [])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("tainted candidate summary and blocker are removed before state, gates, or review", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const workerSecret = "Candidate\"Opaque\nHarbor\\Token-6419"
  await configureIsolationProject(t, root, { workerSecret })
  await writeFile(
    path.join(root, ".autopilot", "runtime", "contract-secret-leak-mode.txt"),
    "candidate\n",
    "utf8",
  )
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: await sterileControllerEnvironment(root) },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const stateText = await readFile(path.join(root, ".autopilot", "state.json"), "utf8")
  const state = JSON.parse(stateText)
  assert.equal(state.status, "human_required", stateText)
  assert.equal(state.blocker?.kind, "policy_violation")
  assert.match(state.blocker?.message ?? "", /blocked and removed tainted candidate\.json/i)
  assertSecretRepresentationsAbsent(`${stateText}\n${result.stdout}\n${result.stderr}`, workerSecret)
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "candidate.json")))
  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute"])
  const gateArtifacts = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => /-M001-(?:task|final)-/.test(name))
  assert.deepEqual(gateArtifacts, [])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("tainted review summary and finding are removed before state, receipt, or another phase", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const reviewSecret = "Review\"Opaque\nSummit\\Token-7528"
  await configureIsolationProject(t, root, { reviewSecret })
  await writeFile(
    path.join(root, ".autopilot", "runtime", "contract-secret-leak-mode.txt"),
    "review\n",
    "utf8",
  )
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: await sterileControllerEnvironment(root) },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const stateText = await readFile(path.join(root, ".autopilot", "state.json"), "utf8")
  const state = JSON.parse(stateText)
  assert.equal(state.status, "human_required", stateText)
  assert.equal(state.blocker?.kind, "policy_violation")
  assert.match(state.blocker?.message ?? "", /blocked and removed tainted review\.json/i)
  assertSecretRepresentationsAbsent(`${stateText}\n${result.stdout}\n${result.stderr}`, reviewSecret)
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "review.json")))
  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute", "review"])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("provider auth metadata is not treated as a secret in legitimate application text", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureIsolationProject(t, root)
  await writeFile(
    path.join(root, ".autopilot", "runtime", "exact-secret-leak-mode.txt"),
    "oauth-metadata\n",
    "utf8",
  )
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task.argv = [process.execPath, fixedGateScript, "expect-file", "src/result.txt", "oauth"]
  gates.gates.final.argv = [process.execPath, fixedGateScript, "expect-file", "src/result.txt", "oauth"]
  await writeJson(gatesFile, gates)
  await git(root, ["add", ".project/gates.json"])
  await git(root, ["commit", "-m", "test: accept legitimate oauth application text"])

  const sourceData = path.join(root, ".autopilot", "runtime", "oauth-source-data")
  const sourceOpenCode = path.join(sourceData, "opencode")
  await mkdir(sourceOpenCode, { recursive: true })
  await writeFile(
    path.join(sourceOpenCode, "auth.json"),
    '{"fixture":{"type":"oauth","access":"provider-access-secret-8642"}}\n',
    { encoding: "utf8", mode: 0o600 },
  )
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: { ...process.env, XDG_DATA_HOME: sourceData } },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
  assert.equal(await readFile(path.join(root, "src", "result.txt"), "utf8"), "oauth\n")
  await access(path.join(root, ".project", "receipts", "M001.json"))
})

test("unselected MCP auth decoys cannot crowd a selected token out of exact scanning", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const selectedToken = "selected-mcp-access-token-9753"
  const selectedState = "selected-mcp-oauth-state-0864"
  await configureIsolationProject(t, root)
  await writeFile(
    path.join(root, ".autopilot", "runtime", "exact-secret-leak-mode.txt"),
    "selected-mcp-auth-base64\n",
    "utf8",
  )
  const sourceData = path.join(root, ".autopilot", "runtime", "decoy-source-data")
  const sourceOpenCode = path.join(sourceData, "opencode")
  await mkdir(sourceOpenCode, { recursive: true })
  const mcpAuth = Object.fromEntries(
    Array.from({ length: 140 }, (_item, index) => [
      `unselected_${String(index).padStart(3, "0")}`,
      { accessToken: `decoy-access-token-${String(index).padStart(3, "0")}` },
    ]),
  )
  mcpAuth.worker_docs = { codeVerifier: selectedToken, oauthState: selectedState }
  await writeFile(
    path.join(sourceOpenCode, "mcp-auth.json"),
    `${JSON.stringify(mcpAuth)}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root, env: { ...process.env, XDG_DATA_HOME: sourceData } },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const stateText = await readFile(path.join(root, ".autopilot", "state.json"), "utf8")
  const state = JSON.parse(stateText)
  assert.equal(state.status, "human_required", stateText)
  assert.equal(state.blocker?.kind, "policy_violation")
  assert.match(state.blocker?.message ?? "", /exact ephemeral credential|secret scan/i)
  assertSecretRepresentationsAbsent(`${stateText}\n${result.stdout}\n${result.stderr}`, selectedToken)
  assertSecretRepresentationsAbsent(`${stateText}\n${result.stdout}\n${result.stderr}`, selectedState)
  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute"])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("unselected provider auth entries are not exposed to a phase", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureIsolationProject(t, root)
  const sourceData = path.join(root, ".autopilot", "runtime", "overflow-source-data")
  const sourceOpenCode = path.join(sourceData, "opencode")
  await mkdir(sourceOpenCode, { recursive: true })
  const providerAuth = Object.fromEntries(
    Array.from({ length: 129 }, (_item, index) => [
      `provider_${String(index).padStart(3, "0")}`,
      { type: "api", key: `provider-secret-value-${String(index).padStart(3, "0")}` },
    ]),
  )
  await writeFile(
    path.join(sourceOpenCode, "auth.json"),
    `${JSON.stringify(providerAuth)}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  const previousData = process.env.XDG_DATA_HOME
  const previousAuth = process.env.OPENCODE_AUTH_CONTENT
  process.env.XDG_DATA_HOME = sourceData
  delete process.env.OPENCODE_AUTH_CONTENT
  try {
    const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
    const isolatedModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "opencode-isolated.mjs")))
    const project = await projectModule.loadProject(root)
    const preflight = await isolatedModule.preflightFreshOpenCode(project, {
      phase: "execute",
      taskId: "M001",
      baseline: await git(root, ["rev-parse", "HEAD"]),
    })
    assert.equal(preflight.providerAuth, null)
    assert.equal(preflight.secrets.some((value) => value.startsWith("provider-secret-value-")), false)
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  }
  assert.deepEqual(
    (await readdir(path.join(root, ".autopilot", "runtime")))
      .filter((name) => name.startsWith("opencode-phase-")),
    [],
  )
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "isolation-observations.json")))
})

test("fresh launcher records bounded model usage and ignores malformed or duplicate events", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureIsolationProject(t, root)
  const environment = await sterileControllerEnvironment(root)
  const previousData = process.env.XDG_DATA_HOME
  const previousAuth = process.env.OPENCODE_AUTH_CONTENT
  process.env.XDG_DATA_HOME = environment.XDG_DATA_HOME
  delete process.env.OPENCODE_AUTH_CONTENT
  try {
    const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
    const isolatedModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "opencode-isolated.mjs")))
    const project = await projectModule.loadProject(root)
    const baseline = await git(root, ["rev-parse", "HEAD"])
    const result = await isolatedModule.runFreshOpenCode(
      project,
      "Stage: execute\nTask: M001\nAttempt: 1\n",
      { phase: "execute", taskId: "M001", attempt: 1, baseline },
    )
    assert.deepEqual(result.tool_usage, {
      schema_version: 1,
      phase: "execute",
      task_id: "M001",
      tool_calls: 1,
      returned_bytes: 24,
      by_tool: { contract: { calls: 1, returned_bytes: 24 } },
      model_usage: {
        input_tokens: 130,
        output_tokens: 24,
        reasoning_tokens: 6,
        cache_read_tokens: 70,
        cache_write_tokens: 10,
        cost: 0.5,
      },
    })
    for (const [index, mode] of ["usage-field", "counter-field", "model-field"].entries()) {
      const attempt = index + 2
      await writeFile(path.join(root, ".autopilot", "runtime", "invalid-tool-usage.txt"), `${mode}\n`, "utf8")
      await assert.rejects(
        isolatedModule.runFreshOpenCode(
          project,
          `Stage: execute\nTask: M001\nAttempt: ${attempt}\n`,
          { phase: "execute", taskId: "M001", attempt, baseline },
        ),
        (error) => error?.code === "OPENCODE_TOOL_USAGE_INVALID",
      )
    }
    await assert.rejects(
      isolatedModule.runFreshOpenCode(
        project,
        "Stage: execute\nTask: M001\nAttempt: 5\n",
        {
          phase: "execute",
          taskId: "M001",
          attempt: 5,
          baseline,
          captureEphemeralSecrets: () => { throw new Error("injected capture failure") },
        },
      ),
      /injected capture failure/,
    )
    assert.deepEqual(
      (await readdir(path.join(root, ".autopilot", "runtime")))
        .filter((name) => name.startsWith("opencode-phase-")),
      [],
    )
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  }
  assert.deepEqual(
    (await readdir(path.join(root, ".autopilot", "runtime"))).filter((name) => name.startsWith("opencode-phase-")),
    [],
  )
})

test("fresh phases use pure sterile profiles and file-substituted MCP credentials", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureIsolationProject(t, root)
  const dotenvSentinel = "project-dotenv-must-not-autoload-314159"
  await writeFile(
    path.join(root, ".env.local"),
    `PROJECT_DOTENV_SENTINEL=${dotenvSentinel}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  const controllerEnvironment = await sterileControllerEnvironment(root)
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: { ...controllerEnvironment, PROJECT_DOTENV_SENTINEL: dotenvSentinel },
    },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  assert.deepEqual(receipt.tool_usage["execute:a1"].model_usage, {
    input_tokens: 130,
    output_tokens: 24,
    reasoning_tokens: 6,
    cache_read_tokens: 70,
    cache_write_tokens: 10,
    cost: 0.5,
  })
  assert.deepEqual(receipt.tool_usage["review:a1"].model_usage, receipt.tool_usage["execute:a1"].model_usage)

  const observations = await readJson(path.join(root, ".autopilot", "runtime", "isolation-observations.json"))
  assert.deepEqual(observations.map((item) => item.stage), ["execute", "review"])
  assert.equal(
    observations[0].secret_sha256,
    createHash("sha256").update("worker-phase-secret-987654").digest("hex"),
  )
  assert.equal(
    observations[1].secret_sha256,
    createHash("sha256").update("review-phase-secret-123456").digest("hex"),
  )
  for (const item of observations) {
    assert.equal(item.pure_argv, true)
    assert.equal(item.tool_usage_enabled, true)
    assert.equal(item.launch_cwd_is_sterile, true)
    assert.equal(item.project_dir_argument, root)
    assert.equal(item.dotenv_sentinel_absent, true)
    await assert.rejects(access(item.secret_file))
  }
  assert.equal(observations[0].feedback_runner_exercised, true)
  assert.equal(observations[1].feedback_runner_exercised, false)
  assert.deepEqual(
    (await readdir(path.join(root, ".autopilot", "runtime"))).filter((name) => name.startsWith("opencode-phase-")),
    [],
  )
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("worker-phase-secret-987654"), false)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("review-phase-secret-123456"), false)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(dotenvSentinel), false)
})

test("reserved local MCP environment is rejected twice and failed setup removes phase secrets", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureIsolationProject(t, root, { reservedLocalEnvironment: true })
  const validation = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
    { cwd: root },
  )
  assert.notEqual(validation.code, 0)
  assert.match(validation.stdout, /mcp\.worker_docs\.environment\.HOME/)
  assert.match(validation.stdout, /HOME can alter process execution and is forbidden/)

  const previousData = process.env.XDG_DATA_HOME
  const previousAuth = process.env.OPENCODE_AUTH_CONTENT
  process.env.XDG_DATA_HOME = path.join(root, ".autopilot", "runtime", "empty-source-data")
  delete process.env.OPENCODE_AUTH_CONTENT
  try {
    const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")))
    const isolatedModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "opencode-isolated.mjs")))
    const project = await projectModule.loadProject(root)
    await assert.rejects(
      isolatedModule.runFreshOpenCode(project, "Stage: execute\nTask: M001\nAttempt: 1\n", {
        phase: "execute",
        taskId: "M001",
        attempt: 1,
        baseline: await git(root, ["rev-parse", "HEAD"]),
      }),
      /HOME can alter process execution and is forbidden/,
    )
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  }

  assert.deepEqual(
    (await readdir(path.join(root, ".autopilot", "runtime"))).filter((name) => name.startsWith("opencode-phase-")),
    [],
  )
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "isolation-observations.json")))
})

test("strict phase isolation rejects a missing profile even when no MCP credential is required", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode.credential_profiles = {
    execute: "missing_profile",
    repair: null,
    review: null,
  }
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: reference absent phase profile"])

  const validation = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
    { cwd: root },
  )
  assert.notEqual(validation.code, 0)
  assert.match(validation.stdout, /references missing credential profile missing_profile/)
})
