#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const arguments_ = process.argv.slice(2)
if (arguments_.includes("--version")) {
  process.stdout.write("fake-opencode 1.0.0\n")
  process.exit(0)
}
if (arguments_.includes("--help")) {
  const actual = [...arguments_]
  if (actual[2] === "--dir" && path.isAbsolute(actual[3] ?? "")) actual[3] = "<neutral>"
  const expected = [
    "--pure",
    "run",
    "--dir",
    "<neutral>",
    "--agent",
    "__autopilot_probe__",
    "--format",
    "json",
    "--title",
    "__autopilot_probe__",
    "--auto",
    "--help",
  ]
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.stderr.write("invalid fake OpenCode capability probe\n")
    process.exit(2)
  }
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}
const directoryIndex = arguments_.indexOf("--dir")
const openCodeRoot = directoryIndex >= 0 && arguments_[directoryIndex + 1]
  ? path.resolve(arguments_[directoryIndex + 1])
  : process.cwd()
let root = openCodeRoot
try {
  const policy = JSON.parse(Buffer.from(process.env.AUTOPILOT_TOOL_POLICY ?? "", "base64").toString("utf8"))
  if (path.isAbsolute(policy.root ?? "")) root = path.resolve(policy.root)
} catch {}
const runtime = path.join(root, ".autopilot", "runtime")
const prompt = arguments_.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const configFile = path.join(runtime, "fake-config.json")

await mkdir(runtime, { recursive: true })

let config = { mode: "success" }
try {
  config = JSON.parse(await readFile(configFile, "utf8"))
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}

const invocationFile = path.join(runtime, "fake-invocations.json")
let invocations = []
try {
  invocations = JSON.parse(await readFile(invocationFile, "utf8"))
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}

const sessionId = `fake-${stage}-a${attempt}-p${process.pid}`
let detached_environment_probe
if (config.probe_detached_environment === true) {
  const authFile = path.join(
    process.env.XDG_DATA_HOME ?? "",
    "opencode",
    "auth.json",
  )
  const mcpAuthFile = path.join(
    process.env.XDG_DATA_HOME ?? "",
    "opencode",
    "mcp-auth.json",
  )
  let auth
  let authStat
  let mcpAuth
  let mcpAuthStat
  try {
    ;[auth, authStat] = await Promise.all([
      readFile(authFile, "utf8").then(JSON.parse),
      stat(authFile),
    ])
  } catch {}
  try {
    ;[mcpAuth, mcpAuthStat] = await Promise.all([
      readFile(mcpAuthFile, "utf8").then(JSON.parse),
      stat(mcpAuthFile),
    ])
  } catch {}
  detached_environment_probe = {
    provider_value_preserved:
      process.env.DETACHED_PROVIDER_PROBE === "detached-provider-probe",
    unrelated_environment_absent:
      process.env.DETACHED_UNRELATED_PROBE === undefined,
    auth_content_preserved:
      auth?.["detached-test-provider"]?.key === "detached-auth-probe",
    auth_is_private_copy:
      authStat?.isFile() === true &&
      Number(authStat.nlink) === 1 &&
      (process.platform === "win32" || (authStat.mode & 0o077) === 0) &&
      path.dirname(authFile) === path.join(process.env.XDG_DATA_HOME ?? "", "opencode"),
    auth_source_environment_absent:
      process.env.OPENCODE_AUTH_CONTENT === undefined,
    mcp_auth_content_preserved:
      mcpAuth?.detached_probe?.accessToken === "detached-mcp-auth-probe",
    mcp_auth_is_private_copy:
      mcpAuthStat?.isFile() === true &&
      Number(mcpAuthStat.nlink) === 1 &&
      (process.platform === "win32" || (mcpAuthStat.mode & 0o077) === 0) &&
      path.dirname(mcpAuthFile) === path.join(process.env.XDG_DATA_HOME ?? "", "opencode"),
    source_data_pointer_absent:
      process.env.AUTOPILOT_SOURCE_DATA_HOME === undefined,
  }
}
invocations.push({
  stage,
  task_id: taskId,
  attempt,
  session_id: sessionId,
  pid: process.pid,
  argv: arguments_,
  ...(detached_environment_probe ? { detached_environment_probe } : {}),
})
await writeFile(invocationFile, `${JSON.stringify(invocations, null, 2)}\n`, "utf8")
if (Number.isInteger(config.delay_ms) && config.delay_ms > 0) await delay(config.delay_ms)

if (stage === "review") {
  const requestChanges = config.mode === "review-repair" && attempt === 1
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: requestChanges ? "changes_requested" : "approved",
    summary: requestChanges
      ? "Fresh fake reviewer requested one bounded correction."
      : "Fresh fake reviewer independently approved the deterministic evidence.",
    findings: requestChanges
      ? [{ severity: "medium", file: "src/result.txt", message: "Exercise the repair loop." }]
      : [],
  })
} else {
  let changedFile = "src/result.txt"
  let contents = "GOOD\n"
  if (config.mode === "path-violation") {
    changedFile = "outside.txt"
    contents = "OUTSIDE\n"
  } else if (config.mode === "multi-task") {
    changedFile = `src/${taskId}.txt`
    contents = `${taskId}\n`
  } else if (
    config.mode === "gate-always-fail" ||
    (config.mode === "gate-repair" && attempt === 1)
  ) {
    contents = "BAD\n"
  }

  const destination = path.join(root, ...changedFile.split("/"))
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, contents, "utf8")
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: `Fake ${stage} session produced the bounded candidate.`,
    changed_files: [changedFile],
    environment_variables: [],
    blocker: null,
  })
}

if (config.session_id_mode === "nested") {
  process.stdout.write(`${JSON.stringify({ type: "session", payload: { sessionID: sessionId } })}\n`)
} else {
  process.stdout.write(`${JSON.stringify({ type: "session", sessionID: sessionId })}\n`)
  if (config.session_id_mode === "multiple") {
    process.stdout.write(`${JSON.stringify({ type: "session", sessionID: `${sessionId}-other` })}\n`)
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
