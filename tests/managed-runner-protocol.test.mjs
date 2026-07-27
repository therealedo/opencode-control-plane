import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  createScaffold,
  git,
} from "./runtime-helpers.mjs"

async function trustedGitArgv(root) {
  const processModule = await import(pathToFileURL(path.join(
    root,
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

async function exerciseManagedRunners(t, root, { schemaMode, label }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), `ocp-managed-runner-${label}-`))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const usageFile = path.join(profile, "tool-usage.json")
  const gateRunner = path.join(profile, "gate-runner.mjs")
  const actionRunner = path.join(profile, "action-runner.mjs")
  const definitionSha256 = "0".repeat(64)
  await mkdir(profile, { recursive: true })

  const gateEnvelope = schemaMode === "missing" ? "" : `
    schema_version: ${schemaMode === "valid" ? 1 : 2}, operation: "gate",
    classification: "task_failure", error_code: "GATE_EXIT_CODE",`
  const dependencyEnvelope = schemaMode === "missing" ? "" : `
    schema_version: ${schemaMode === "valid" ? 1 : 2}, operation: "dependency-lock",
    classification: "task_failure", error_code: "DEPENDENCY_LOCKFILE_INVALID",`
  await writeFile(gateRunner, `process.stdout.write(JSON.stringify({
    ${gateEnvelope}
    gate_id: "unit", gate_definition_sha256: ${JSON.stringify(definitionSha256)},
    success: false, code: 1, timed_out: false, duration_ms: 1,
    diagnostic: { stdout: "", stderr: "gate failed", output_truncated: false }
  }) + "\\n")
  process.exit(1)
  `, "utf8")
  await writeFile(actionRunner, `process.stdout.write(JSON.stringify({
    ${dependencyEnvelope}
    action: "dependency-lock", package_manager: "pnpm@11.14.0",
    success: false, code: 1, timed_out: false, duration_ms: 1,
    diagnostic: { stdout: "", stderr: "dependency failed", output_truncated: false }
  }) + "\\n")
  process.exit(1)
  `, "utf8")

  const previousPolicy = process.env.AUTOPILOT_TOOL_POLICY
  process.env.AUTOPILOT_TOOL_POLICY = Buffer.from(JSON.stringify({
    schema_version: 1,
    root,
    task_id: "M001",
    phase: "execute",
    attempt: 1,
    baseline_head: await git(root, ["rev-parse", "HEAD"]),
    allowed_paths: ["package.json", "pnpm-lock.yaml"],
    contract_path: ".autopilot/runtime/candidate.json",
    max_returned_bytes: 32768,
    usage_path: usageFile,
    feedback_runner: gateRunner,
    action_runner: actionRunner,
    allow_dependency_lock: true,
    feedback_gates: {
      unit: { definition_sha256: definitionSha256, timeout_seconds: 5 },
    },
    max_feedback_calls: 1,
    controller_node_argv: [process.execPath],
    git_argv: await trustedGitArgv(root),
  }), "utf8").toString("base64")
  let tools
  try {
    tools = await import(`${pathToFileURL(path.join(
      root,
      ".autopilot",
      "bin",
      "opencode-tools.mjs",
    )).href}?managed-runner=${label}-${Date.now()}`)
  } finally {
    if (previousPolicy === undefined) delete process.env.AUTOPILOT_TOOL_POLICY
    else process.env.AUTOPILOT_TOOL_POLICY = previousPolicy
  }

  const gate = JSON.parse(await tools.check.execute({ gate_id: "unit" }))
  const dependency = JSON.parse(await tools.lockfile.execute({}))
  const usage = JSON.parse(await readFile(usageFile, "utf8"))
  return { gate, dependency, usage }
}

test("managed runners require typed v1 envelopes and preserve valid v1 task failures", {
  timeout: 120_000,
}, async (t) => {
  const root = await createScaffold(t, { ready: true })

  const missing = await exerciseManagedRunners(t, root, {
    schemaMode: "missing",
    label: "missing",
  })
  assert.deepEqual(
    {
      classification: missing.gate.classification,
      error_code: missing.gate.error_code,
    },
    {
      classification: "controller_failure",
      error_code: "GATE_RUNNER_PROTOCOL_INVALID",
    },
  )
  assert.deepEqual(
    {
      classification: missing.dependency.classification,
      error_code: missing.dependency.error_code,
    },
    {
      classification: "controller_failure",
      error_code: "DEPENDENCY_RUNNER_PROTOCOL_INVALID",
    },
  )
  assert.deepEqual(missing.usage.controller_faults, [
    { operation: "gate", error_code: "GATE_RUNNER_PROTOCOL_INVALID" },
    { operation: "dependency-lock", error_code: "DEPENDENCY_RUNNER_PROTOCOL_INVALID" },
  ])

  const invalid = await exerciseManagedRunners(t, root, {
    schemaMode: "invalid",
    label: "invalid",
  })
  assert.deepEqual(
    {
      classification: invalid.gate.classification,
      error_code: invalid.gate.error_code,
    },
    {
      classification: "controller_failure",
      error_code: "GATE_RUNNER_PROTOCOL_INVALID",
    },
  )
  assert.deepEqual(
    {
      classification: invalid.dependency.classification,
      error_code: invalid.dependency.error_code,
    },
    {
      classification: "controller_failure",
      error_code: "DEPENDENCY_RUNNER_PROTOCOL_INVALID",
    },
  )

  const valid = await exerciseManagedRunners(t, root, {
    schemaMode: "valid",
    label: "valid",
  })
  assert.deepEqual(
    {
      classification: valid.gate.classification,
      error_code: valid.gate.error_code,
    },
    { classification: "task_failure", error_code: "GATE_EXIT_CODE" },
  )
  assert.deepEqual(
    {
      classification: valid.dependency.classification,
      error_code: valid.dependency.error_code,
    },
    { classification: "task_failure", error_code: "DEPENDENCY_LOCKFILE_INVALID" },
  )
  assert.equal(Object.hasOwn(valid.usage, "controller_faults"), false)
})
