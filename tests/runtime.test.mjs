import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import {
  createScaffold,
  fakeOpenCodeScript,
  fixedGateScript,
  git,
  readJson,
  run,
  writeJson,
} from "./runtime-helpers.mjs"

const REUSE_FLAGS = new Set(["--continue", "-c", "--session", "-s", "--fork"])

async function runAutopilot(root, command = "start", env = undefined) {
  return run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), command],
    { cwd: root, ...(env ? { env } : {}) },
  )
}

async function waitForDetachedCompletion(root, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  const stateFile = path.join(root, ".autopilot", "state.json")
  while (Date.now() < deadline) {
    try {
      const state = await readJson(stateFile)
      if (["complete", "human_required", "failed"].includes(state.status)) return state
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
    }
    await delay(50)
  }
  throw new Error(`Detached controller did not reach a terminal state within ${timeoutMs}ms`)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function terminateDetached(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) return
  if (process.platform === "win32") {
    await run(["taskkill.exe", "/PID", String(pid), "/T", "/F"])
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
}

async function configureTwoTaskRun(root) {
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const configFile = path.join(root, ".autopilot", "config.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.allowed_paths = ["src/M001.txt"]
  queue.tasks.M001.gates = ["task_one"]
  queue.tasks.M002 = {
    title: "Complete the second bounded task",
    status: "pending",
    priority: 90,
    depends_on: ["M001"],
    spec: ".project/plan/milestones/M002.md",
    context: {
      shared: ["task"],
      execute: [],
      repair: [],
      review: [],
    },
    allowed_paths: ["src/M002.txt"],
    gates: ["task_two", "final"],
    tool_grants: { execute: [], repair: [], review: [] },
    risk: "low",
    attempt_limit: 3,
  }
  await writeJson(queueFile, queue)
  await writeFile(
    path.join(root, ".project", "plan", "milestones", "M002.md"),
    "# M002 - Second runtime task\n\nCreate `src/M002.txt` containing `M002`.\n",
    "utf8",
  )
  await writeJson(gatesFile, {
    schema_version: 2,
    gates: {
      task_one: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M001.txt", "M001"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      task_two: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M002.txt", "M002"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      final: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M002.txt", "M002"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: false,
      },
    },
    final_gates: ["final"],
  })
  const config = await readJson(configFile)
  config.budgets.max_tasks_per_run = 1
  await writeJson(configFile, config)
  await git(root, ["add", ".project", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: configure automatic run rollover"])
}

test("strict validation rejects the untouched starter", async (t) => {
  const root = await createScaffold(t)
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
    { cwd: root },
  )

  assert.notEqual(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((issue) => issue.message.includes("Unresolved template expression")))
  assert.ok(report.issues.some((issue) => issue.location === "queue.project_status"))
})

test("controller completes task and project through fresh execute and review sessions", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const baseline = await git(root, ["rev-parse", "HEAD"])
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(state.status, "complete", JSON.stringify({ state, queue, result }, null, 2))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const finalReceipt = await readJson(path.join(root, ".project", "receipts", "__project-final.json"))
  const invocations = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )

  assert.equal(state.phase, "complete")
  assert.equal(queue.project_status, "complete")
  assert.equal(queue.tasks.M001.status, "done")
  assert.equal((await readFile(path.join(root, "src", "result.txt"), "utf8")).trim(), "GOOD")
  assert.equal(receipt.baseline_commit, baseline)
  assert.notEqual(receipt.result_commit, baseline)
  assert.equal(receipt.review.status, "approved")
  assert.deepEqual(Object.keys(receipt.tool_usage), ["execute:a1", "review:a1"])
  assert.equal(receipt.tool_usage["execute:a1"].tool_calls, 0)
  assert.equal(Object.hasOwn(receipt.tool_usage["execute:a1"], "model_usage"), false)
  assert.equal(Object.hasOwn(receipt.tool_usage["review:a1"], "model_usage"), false)
  assert.deepEqual(state.task_tool_usage, {})
  assert.deepEqual(receipt.gates.map(({ gate_id, success }) => ({ gate_id, success })), [
    { gate_id: "task", success: true },
    { gate_id: "final", success: true },
  ])
  assert.equal(finalReceipt.gates[0].gate_id, "final")
  assert.match(finalReceipt.gates[0].gate_definition_sha256, /^[0-9a-f]{64}$/)

  assert.deepEqual(invocations.map((item) => item.stage), ["execute", "review"])
  assert.equal(new Set(invocations.map((item) => item.session_id)).size, 2)
  assert.equal(new Set(invocations.map((item) => item.pid)).size, 2)
  for (const invocation of invocations) {
    assert.equal(invocation.argv.some((value) => REUSE_FLAGS.has(value)), false)
    const agentIndex = invocation.argv.indexOf("--agent")
    assert.notEqual(agentIndex, -1)
    assert.equal(invocation.argv[agentIndex + 1], {
      execute: "autopilot-worker",
      repair: "autopilot-recovery",
      review: "autopilot-reviewer",
    }[invocation.stage])
  }
  const reviewPrompt = invocations.find((item) => item.stage === "review").argv.at(-1)
  assert.match(reviewPrompt, /\+\+\+ b\/src\/result\.txt/)
  assert.match(reviewPrompt, /\+GOOD/)

  const subjects = await git(root, ["log", "--format=%s"])
  assert.match(subjects, /autopilot: M001 Prove the autonomous runtime/)
  assert.match(subjects, /autopilot: record M001/)
  assert.match(subjects, /autopilot: complete project/)
  assert.equal((await git(root, ["status", "--porcelain"])), "")

  const restart = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(restart.code, 0, restart.stderr || restart.stdout)
  const restartedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(restartedState.status, "complete")
})

test("controller uses blueprint-compiled Conventional Commit prefixes without model classification", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.schema_version = 2
  delete config.git.commit_prefix
  config.git.commit_prefixes = { M001: "feat(opportunities)" }
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: configure Conventional Commit map"])

  const result = await runAutopilot(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
  assert.equal(subjects.filter((item) => item === "feat(opportunities): M001 Prove the autonomous runtime").length, 1)
  assert.equal(subjects.filter((item) => item === "chore(control-plane): record M001").length, 1)
  assert.equal(subjects.filter((item) => item === "chore(control-plane): complete project").length, 1)
})

test("detached controller preserves configured provider environment and selected MCP auth only", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const fakeConfigFile = path.join(root, ".autopilot", "runtime", "fake-config.json")
  const openCodeFile = path.join(root, "opencode.jsonc")
  const toolsFile = path.join(root, ".project", "tools.json")
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const config = await readJson(configFile)
  config.opencode.provider_auth_mode = "environment"
  config.opencode.provider_environment = ["DETACHED_PROVIDER_PROBE"]
  await writeJson(configFile, config)
  const openCode = await readJson(openCodeFile)
  openCode.mcp = {
    detached_probe: {
      type: "remote",
      url: "https://example.invalid/detached-probe",
      oauth: false,
    },
  }
  await writeJson(openCodeFile, openCode)
  await writeJson(toolsFile, {
    schema_version: 1,
    roles: {
      worker: ["detached_probe_lookup"],
      recovery: ["detached_probe_lookup"],
      reviewer: ["detached_probe_lookup"],
    },
  })
  const queue = await readJson(queueFile)
  queue.tasks.M001.tool_grants = {
    execute: ["detached_probe_lookup"],
    repair: ["detached_probe_lookup"],
    review: ["detached_probe_lookup"],
  }
  await writeJson(queueFile, queue)
  const configured = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "configure-tools.mjs"), "--root", root, "--json"],
    { cwd: root },
  )
  assert.equal(configured.code, 0, configured.stderr || configured.stdout)
  await writeJson(fakeConfigFile, {
    mode: "success",
    probe_detached_environment: true,
  })
  await git(root, ["add", ".autopilot/config.json", "opencode.jsonc", ".project/tools.json", ".project/plan/queue.json", ".opencode/agents"])
  await git(root, ["commit", "-m", "test: configure detached provider environment"])

  const sourceData = path.join(root, ".autopilot", "runtime", "custom-source-data")
  const sourceOpenCode = path.join(sourceData, "opencode")
  await mkdir(sourceOpenCode, { recursive: true })
  await writeFile(
    path.join(sourceOpenCode, "auth.json"),
    '{"detached-test-provider":{"type":"api","key":"detached-auth-probe"}}\n',
    { encoding: "utf8", mode: 0o600 },
  )
  await writeFile(
    path.join(sourceOpenCode, "mcp-auth.json"),
    '{"detached_probe":{"accessToken":"detached-mcp-auth-probe"}}\n',
    { encoding: "utf8", mode: 0o600 },
  )
  const oversizedLaunch = await run(
    [
      process.execPath,
      path.join(root, ".autopilot", "bin", "autopilot.mjs"),
      "start",
      "--detach",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_DATA_HOME: sourceData,
        DETACHED_PROVIDER_PROBE: "x".repeat(8193),
      },
    },
  )
  assert.notEqual(oversizedLaunch.code, 0)
  assert.match(`${oversizedLaunch.stdout}\n${oversizedLaunch.stderr}`, /CREDENTIAL_VALUE_TOO_LARGE|exceeds 8192 UTF-8 bytes/i)
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
  const launch = await run(
    [
      process.execPath,
      path.join(root, ".autopilot", "bin", "autopilot.mjs"),
      "start",
      "--detach",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_DATA_HOME: sourceData,
        DETACHED_PROVIDER_PROBE: "detached-provider-probe",
        DETACHED_UNRELATED_PROBE: "detached-unrelated-probe",
      },
    },
  )
  let launched
  try {
    assert.equal(launch.code, 0, launch.stderr || launch.stdout)
    launched = JSON.parse(launch.stdout)
    assert.equal(Number.isInteger(launched.pid) && launched.pid > 0, true)
    const state = await waitForDetachedCompletion(root)
    assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
    const invocations = await readJson(
      path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
    )
    assert.deepEqual(invocations.map((invocation) => invocation.detached_environment_probe), [
      {
        provider_value_preserved: true,
        unrelated_environment_absent: true,
        auth_content_preserved: false,
        auth_is_private_copy: false,
        auth_source_environment_absent: true,
        mcp_auth_content_preserved: true,
        mcp_auth_is_private_copy: true,
        source_data_pointer_absent: true,
      },
      {
        provider_value_preserved: true,
        unrelated_environment_absent: true,
        auth_content_preserved: false,
        auth_is_private_copy: false,
        auth_source_environment_absent: true,
        mcp_auth_content_preserved: true,
        mcp_auth_is_private_copy: true,
        source_data_pointer_absent: true,
      },
    ])
    const persisted = [
      await readFile(path.join(root, ".autopilot", "runtime", "fake-invocations.json"), "utf8"),
      await readFile(path.join(root, ".autopilot", "artifacts", "controller.log"), "utf8"),
    ].join("\n")
    assert.equal(persisted.includes("detached-provider-probe"), false)
    assert.equal(persisted.includes("detached-auth-probe"), false)
    assert.equal(persisted.includes("detached-mcp-auth-probe"), false)
    assert.equal(persisted.includes("detached-unrelated-probe"), false)
  } finally {
    await terminateDetached(launched?.pid)
  }
})

test("task-count budgets roll over automatically and continue with fresh phase ledgers", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "multi-task" })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const gatesFile = path.join(root, ".project", "gates.json")
  const configFile = path.join(root, ".autopilot", "config.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.allowed_paths = ["src/M001.txt"]
  queue.tasks.M001.gates = ["task_one"]
  queue.tasks.M002 = {
    title: "Complete the second bounded task",
    status: "pending",
    priority: 90,
    depends_on: ["M001"],
    spec: ".project/plan/milestones/M002.md",
    context: {
      shared: ["task"],
      execute: [],
      repair: [],
      review: [],
    },
    allowed_paths: ["src/M002.txt"],
    gates: ["task_two", "final"],
    tool_grants: { execute: [], repair: [], review: [] },
    risk: "low",
    attempt_limit: 3,
  }
  await writeJson(queueFile, queue)
  await writeFile(
    path.join(root, ".project", "plan", "milestones", "M002.md"),
    "# M002 — Second runtime task\n\nCreate `src/M002.txt` containing `M002`.\n",
    "utf8",
  )
  await writeJson(gatesFile, {
    schema_version: 2,
    gates: {
      task_one: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M001.txt", "M001"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      task_two: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M002.txt", "M002"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      final: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/M002.txt", "M002"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: false,
      },
    },
    final_gates: ["final"],
  })
  const config = await readJson(configFile)
  config.budgets.max_tasks_per_run = 1
  await writeJson(configFile, config)
  await git(root, ["add", ".project", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: configure automatic run rollover"])

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const completedQueue = await readJson(queueFile)
  const firstReceipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const secondReceipt = await readJson(path.join(root, ".project", "receipts", "M002.json"))
  const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(state.status, "complete", JSON.stringify({ state, completedQueue, result }, null, 2))
  assert.equal(completedQueue.tasks.M001.status, "done")
  assert.equal(completedQueue.tasks.M002.status, "done")
  assert.notEqual(firstReceipt.run_id, secondReceipt.run_id)
  assert.notEqual(state.run_id, secondReceipt.run_id)
  assert.equal(state.completed_in_run, 0)
  assert.deepEqual(state.session_ids, [])
  assert.deepEqual(invocations.map((item) => [item.task_id, item.stage]), [
    ["M001", "execute"], ["M001", "review"],
    ["M002", "execute"], ["M002", "review"],
  ])
})

test("a completion journal cannot advance past a human boundary without explicit resume", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const stateFile = path.join(root, ".autopilot", "state.json")
  const crash = await runAutopilot(root, "start", {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_CRASH_POINT: "after_app_commit",
  })
  assert.equal(crash.code, 86, crash.stderr || crash.stdout)

  const interrupted = await readJson(stateFile)
  assert.ok(interrupted.completion, JSON.stringify(interrupted, null, 2))
  Object.assign(interrupted, {
    status: "human_required",
    phase: "blocked",
    pid: null,
    blocker: {
      kind: "test_completion_boundary",
      message: "Hold the persisted completion transaction for explicit recovery.",
      required_action: "Review the completion journal.",
      resume_condition: "Resume is explicitly requested.",
    },
  })
  await writeJson(stateFile, interrupted)

  const plainStart = await runAutopilot(root)
  assert.notEqual(plainStart.code, 0)
  assert.match(`${plainStart.stderr}\n${plainStart.stdout}`, /RESUME_REQUIRED/)
  const held = await readJson(stateFile)
  assert.equal(held.status, "human_required")
  assert.deepEqual(held.completion, interrupted.completion)

  const resumed = await runAutopilot(root, "resume")
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const completed = await readJson(stateFile)
  assert.equal(completed.status, "complete", JSON.stringify({ completed, resumed }, null, 2))
  assert.equal(completed.completion, null)
})

test("a finalization journal cannot advance past a human boundary without explicit resume", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const stateFile = path.join(root, ".autopilot", "state.json")
  const crash = await runAutopilot(root, "start", {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_CRASH_POINT: "after_final_commit",
  })
  assert.equal(crash.code, 87, crash.stderr || crash.stdout)

  const interrupted = await readJson(stateFile)
  assert.ok(interrupted.finalization, JSON.stringify(interrupted, null, 2))
  Object.assign(interrupted, {
    status: "human_required",
    phase: "blocked",
    pid: null,
    blocker: {
      kind: "test_finalization_boundary",
      message: "Hold the persisted finalization transaction for explicit recovery.",
      required_action: "Review the finalization journal.",
      resume_condition: "Resume is explicitly requested.",
    },
  })
  await writeJson(stateFile, interrupted)

  const plainStart = await runAutopilot(root)
  assert.notEqual(plainStart.code, 0)
  assert.match(`${plainStart.stderr}\n${plainStart.stdout}`, /RESUME_REQUIRED/)
  const held = await readJson(stateFile)
  assert.equal(held.status, "human_required")
  assert.deepEqual(held.finalization, interrupted.finalization)

  const resumed = await runAutopilot(root, "resume")
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const completed = await readJson(stateFile)
  assert.equal(completed.status, "complete", JSON.stringify({ completed, resumed }, null, 2))
  assert.equal(completed.finalization, null)
})

test("completion recovery rejects an unrelated queue-contract edit before metadata commit", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "multi-task" })
  await configureTwoTaskRun(root)
  const queueFile = path.join(root, ".project", "plan", "queue.json")

  const crash = await runAutopilot(root, "start", {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_CRASH_POINT: "after_completion_queue_write",
  })
  assert.equal(crash.code, 93, crash.stderr || crash.stdout)
  const applicationHead = await git(root, ["rev-parse", "HEAD"])
  const interrupted = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(interrupted.completion?.task_id, "M001", JSON.stringify(interrupted, null, 2))

  const editedQueue = await readJson(queueFile)
  assert.equal(editedQueue.tasks.M001.status, "done")
  assert.equal(editedQueue.tasks.M002.status, "pending")
  editedQueue.tasks.M002.title = "Valid independently refined second task"
  await writeJson(queueFile, editedQueue)

  const validation = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
    { cwd: root },
  )
  assert.equal(validation.code, 0, validation.stderr || validation.stdout)

  const resumed = await runAutopilot(root, "resume")
  assert.notEqual(resumed.code, 0)
  assert.match(`${resumed.stdout}\n${resumed.stderr}`, /COMPLETION_CONFLICT/)
  const blocked = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(blocked.status, "human_required", JSON.stringify({ blocked, resumed }, null, 2))
  assert.match(blocked.blocker?.message ?? "", /queue|completion/i)
  assert.equal(await git(root, ["rev-parse", "HEAD"]), applicationHead)

  const committedQueue = JSON.parse(await git(root, ["show", "HEAD:.project/plan/queue.json"]))
  assert.notEqual(committedQueue.tasks.M002.title, editedQueue.tasks.M002.title)
  assert.match(await git(root, ["status", "--porcelain"]), /\.project\/plan\/queue\.json/)
  const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/)
  assert.equal(subjects.includes("autopilot: record M001"), false)
})

test("explicit resume requeues a constrained former high-risk task without a manual status edit", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const stateFile = path.join(root, ".autopilot", "state.json")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  queue.tasks.M001.allowed_paths = ["src/**", "docs/**"]
  queue.tasks.M001.tool_grants.execute = ["unused_api_lookup"]
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.extra = {
    argv: [process.execPath, fixedGateScript, "pass"],
    timeout_seconds: 30,
    credential_profile: null,
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: false,
  }
  await writeJson(gatesFile, gates)
  await writeJson(path.join(root, ".project", "tools.json"), {
    schema_version: 1,
    roles: {
      worker: ["unused_api_lookup"],
      recovery: [],
      reviewer: [],
    },
  })
  await writeJson(path.join(root, "opencode.jsonc"), {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      unused_api: {
        type: "remote",
        url: "https://example.invalid/unused-mcp",
        oauth: false,
      },
    },
  })
  const configured = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "configure-tools.mjs"), "--root", root, "--json"],
    { cwd: root },
  )
  assert.equal(configured.code, 0, configured.stderr || configured.stdout)
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json", ".project/gates.json", ".project/tools.json", "opencode.jsonc", ".opencode/agents"])
  await git(root, ["commit", "-m", "test: require explicit high-risk approval"])

  const stopped = await runAutopilot(root)
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout)
  const blockedState = await readJson(stateFile)
  const blockedQueue = await readJson(queueFile)
  assert.equal(blockedState.status, "human_required", JSON.stringify(blockedState, null, 2))
  assert.equal(blockedState.blocker?.kind, "high_risk_task")
  assert.equal(blockedState.active_task, "M001")
  assert.equal(blockedState.attempt, 0)
  assert.equal(blockedQueue.tasks.M001.status, "blocked")
  assert.equal(blockedQueue.project_status, "blocked")
  await assert.rejects(access(invocationFile))

  // The human changes only the approval-relevant contract field. The
  // controller-owned blocked projections remain untouched for resume recovery.
  blockedQueue.tasks.M001.risk = "medium"
  blockedQueue.tasks.M001.allowed_paths = ["src/**"]
  blockedQueue.tasks.M001.tool_grants.execute = []
  blockedQueue.tasks.M001.gates = ["task", "extra", "final"]
  blockedQueue.tasks.M001.attempt_limit = 2
  await writeJson(queueFile, blockedQueue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: constrain and approve autonomous task"])
  assert.equal((await readJson(queueFile)).tasks.M001.status, "blocked")
  assert.deepEqual(await readJson(stateFile), blockedState)

  const resumed = await runAutopilot(root, "resume")
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const completedState = await readJson(stateFile)
  const completedQueue = await readJson(queueFile)
  assert.equal(completedState.status, "complete", JSON.stringify({ completedState, resumed }, null, 2))
  assert.equal(completedQueue.tasks.M001.status, "done")
  assert.equal(completedQueue.project_status, "complete")
  assert.deepEqual(completedQueue.tasks.M001.allowed_paths, ["src/**"])
  assert.deepEqual(completedQueue.tasks.M001.tool_grants.execute, [])
  assert.deepEqual(completedQueue.tasks.M001.gates, ["task", "extra", "final"])
  assert.equal(completedQueue.tasks.M001.attempt_limit, 2)
  const invocations = await readJson(invocationFile)
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["review", 1],
  ])
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  assert.deepEqual(receipt.gates.map((gate) => gate.gate_id), ["task", "extra", "final"])
})

test("high-risk approval rejects an autonomy-widening queue edit", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const stateFile = path.join(root, ".autopilot", "state.json")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: require constrained high-risk approval"])

  const stopped = await runAutopilot(root)
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout)
  const blockedState = await readJson(stateFile)
  const blockedQueue = await readJson(queueFile)
  blockedQueue.tasks.M001.risk = "medium"
  blockedQueue.tasks.M001.allowed_paths.push("docs/**")
  await writeJson(queueFile, blockedQueue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: attempt to widen approved task paths"])

  const resumed = await runAutopilot(root, "resume")
  assert.notEqual(resumed.code, 0)
  assert.match(`${resumed.stderr}\n${resumed.stdout}`, /HIGH_RISK_APPROVAL_INVALID/)
  const preserved = await readJson(stateFile)
  assert.equal(preserved.status, "human_required")
  assert.equal(preserved.blocker?.kind, "high_risk_task")
  assert.equal(preserved.baseline_head, blockedState.baseline_head)
  await assert.rejects(access(invocationFile))
})

test("high-risk approval rejects a co-committed application change before model execution", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const stateFile = path.join(root, ".autopilot", "state.json")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: require guarded high-risk approval"])

  const stopped = await runAutopilot(root)
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout)
  const blockedState = await readJson(stateFile)
  const blockedQueue = await readJson(queueFile)
  assert.equal(blockedState.status, "human_required")
  assert.equal(blockedState.blocker?.kind, "high_risk_task")
  await assert.rejects(access(invocationFile))

  blockedQueue.tasks.M001.risk = "medium"
  await writeJson(queueFile, blockedQueue)
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "unapproved.txt"), "UNAPPROVED\n", "utf8")
  await git(root, ["add", ".project/plan/queue.json", "src/unapproved.txt"])
  await git(root, ["commit", "-m", "test: mix approval with unreviewed application change"])

  const resumed = await runAutopilot(root, "resume")
  assert.notEqual(resumed.code, 0)
  assert.match(`${resumed.stderr}\n${resumed.stdout}`, /HIGH_RISK_APPROVAL_INVALID/)
  const preserved = await readJson(stateFile)
  assert.equal(preserved.status, "human_required", JSON.stringify({ preserved, resumed }, null, 2))
  assert.equal(preserved.blocker?.kind, "high_risk_task")
  assert.equal(preserved.baseline_head, blockedState.baseline_head)
  await assert.rejects(access(invocationFile))
})

test("high-risk approval rejects source history hidden by a revert", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const stateFile = path.join(root, ".autopilot", "state.json")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: require history-safe high-risk approval"])

  const stopped = await runAutopilot(root)
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout)
  const blockedState = await readJson(stateFile)
  const blockedQueue = await readJson(queueFile)
  await assert.rejects(access(invocationFile))

  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "transient-unapproved.txt"), "UNAPPROVED\n", "utf8")
  await git(root, ["add", "src/transient-unapproved.txt"])
  await git(root, ["commit", "-m", "test: commit transient unapproved source"])
  await git(root, ["revert", "--no-edit", "HEAD"])
  blockedQueue.tasks.M001.risk = "medium"
  await writeJson(queueFile, blockedQueue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: approve queue after hidden source history"])
  assert.equal(await git(root, ["diff", "--name-only", blockedState.baseline_head, "HEAD"]), ".project/plan/queue.json")

  const resumed = await runAutopilot(root, "resume")
  assert.notEqual(resumed.code, 0)
  assert.match(`${resumed.stderr}\n${resumed.stdout}`, /HIGH_RISK_APPROVAL_INVALID/)
  const preserved = await readJson(stateFile)
  assert.equal(preserved.status, "human_required")
  assert.equal(preserved.blocker?.kind, "high_risk_task")
  assert.equal(preserved.baseline_head, blockedState.baseline_head)
  await assert.rejects(access(invocationFile))
})

test("a durable completed-in-run count rolls over before a restarted second task", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "multi-task" })
  await configureTwoTaskRun(root)
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  // Keep the next task selectable across the crash boundary; M001's higher
  // priority still makes it the first task selected before the interruption.
  queue.tasks.M002.status = "ready"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: prepare second task for restart recovery"])
  const stateFile = path.join(root, ".autopilot", "state.json")
  const crash = await runAutopilot(root, "start", {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_CRASH_POINT: "after_task_complete_state",
  })
  assert.equal(crash.code, 94, crash.stderr || crash.stdout)

  const interrupted = await readJson(stateFile)
  const interruptedQueue = await readJson(queueFile)
  const beforeRestart = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(interrupted.status, "running")
  assert.equal(interrupted.completed_in_run, 1)
  assert.equal(interrupted.active_task, null)
  assert.equal(interruptedQueue.tasks.M001.status, "done")
  assert.equal(interruptedQueue.tasks.M002.status, "ready")
  assert.deepEqual(beforeRestart.map((item) => item.task_id), ["M001", "M001"])

  const restarted = await runAutopilot(root)
  assert.equal(restarted.code, 0, restarted.stderr || restarted.stdout)
  const firstReceipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const secondReceipt = await readJson(path.join(root, ".project", "receipts", "M002.json"))
  const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(firstReceipt.run_id, interrupted.run_id)
  assert.notEqual(secondReceipt.run_id, interrupted.run_id)
  assert.deepEqual(invocations.map((item) => item.task_id), ["M001", "M001", "M002", "M002"])
})

test("credential gate injects only allowlisted names and redacts values", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const secret = "allowed-secret-value-987654"
  const denied = "denied-secret-value-123456"
  await writeFile(
    path.join(root, ".env.test.local"),
    `ALLOWED_TOKEN=${secret}\nDENIED_SECRET=${denied}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      test: {
        env_file: ".env.test.local",
        allow: ["ALLOWED_TOKEN"],
        allowed_gates: ["credential"],
      },
    },
  })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.credential = {
    argv: [process.execPath, fixedGateScript, "echo-env", "ALLOWED_TOKEN", "DENIED_SECRET"],
    timeout_seconds: 30,
    credential_profile: "test",
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: false,
  }
  await writeJson(gatesFile, gates)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "credential"],
    { cwd: root },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const returned = JSON.parse(result.stdout)
  assert.equal(Object.hasOwn(returned, "stdout"), false)
  assert.equal(Object.hasOwn(returned, "stderr"), false)

  const artifactNames = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => name.includes("credential") && name.endsWith(".json"))
  assert.equal(artifactNames.length, 1)
  const artifactText = await readFile(
    path.join(root, ".autopilot", "artifacts", artifactNames[0]),
    "utf8",
  )
  const artifact = JSON.parse(artifactText)
  const encodedSecret = Buffer.from(secret, "utf8").toString("base64url")
  assert.deepEqual(artifact.injected_environment_names, ["ALLOWED_TOKEN"])
  assert.equal(Object.hasOwn(artifact, "stdout"), false)
  assert.equal(Object.hasOwn(artifact, "stderr"), false)
  assert.match(artifact.output_sha256, /^[0-9a-f]{64}$/)
  assert.equal(artifactText.includes(secret), false)
  assert.equal(artifactText.includes(encodedSecret), false)
  assert.equal(artifactText.includes(denied), false)

  const secondSecret = "next-secret-value-456789"
  await writeFile(
    path.join(root, ".env.test.local"),
    `ALLOWED_TOKEN=${secondSecret}\nDENIED_SECRET=${denied}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  const secondResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "credential"],
    { cwd: root },
  )
  assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout)
  const secondReturned = JSON.parse(secondResult.stdout)
  const secondArtifactNames = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => name.includes("credential") && name.endsWith(".json"))
  assert.equal(secondArtifactNames.length, 2)
  const secondArtifactName = secondArtifactNames.find((name) => name !== artifactNames[0])
  const secondArtifactText = await readFile(
    path.join(root, ".autopilot", "artifacts", secondArtifactName),
    "utf8",
  )
  const secondArtifact = JSON.parse(secondArtifactText)
  assert.equal(secondArtifact.output_sha256, artifact.output_sha256)
  assert.equal(secondReturned.fingerprint, returned.fingerprint)
  assert.equal(secondArtifactText.includes(secondSecret), false)
  assert.equal(
    secondArtifactText.includes(Buffer.from(secondSecret, "utf8").toString("base64url")),
    false,
  )

  const cleanupFailure = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "credential"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_GATE_CLEANUP_FAILURE: "1",
      },
    },
  )
  assert.notEqual(cleanupFailure.code, 0)
  assert.match(`${cleanupFailure.stdout}\n${cleanupFailure.stderr}`, /GATE_CLEANUP_FAILED|cleanup left a sterile directory/i)
  assert.equal(`${cleanupFailure.stdout}\n${cleanupFailure.stderr}`.includes(secret), false)
  assert.doesNotMatch(`${cleanupFailure.stdout}\n${cleanupFailure.stderr}`, /allowed(?:_base64url)?=.*denied=/)
  assert.equal(
    (await readdir(path.join(root, ".autopilot", "artifacts")))
      .filter((name) => name.includes("credential") && name.endsWith(".json")).length,
    2,
  )

  const credentials = await readJson(path.join(root, ".autopilot", "credentials.json"))
  credentials.profiles.test.allowed_gates = []
  await writeJson(path.join(root, ".autopilot", "credentials.json"), credentials)
  const deniedResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "credential"],
    { cwd: root },
  )
  assert.notEqual(deniedResult.code, 0)
  assert.match(deniedResult.stderr, /CREDENTIAL_GATE_DENIED|not allowlisted/)
})

test("out-of-policy worker change requires a human and creates no receipt", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "path-violation" })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(state.status, "human_required")
  assert.equal(state.blocker.kind, "policy_violation")
  assert.match(state.blocker.message, /outside task allowlist/i)
  assert.equal(queue.project_status, "blocked")
  assert.equal(queue.tasks.M001.status, "blocked")
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("phase preflight preserves attempt zero until exact credentials are provisioned", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const phaseEnv = path.join(root, ".env.worker.local")
  const gateEnv = path.join(root, ".env.gate.local")
  const providerName = "PREFLIGHT_PROVIDER_TOKEN"
  const phaseName = "WORKER_MCP_TOKEN"
  const gateName = "TASK_GATE_TOKEN"
  const provisionedEnvironment = {
    ...process.env,
    [providerName]: "provider-preflight-value-987654",
  }

  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      worker: {
        env_file: ".env.worker.local",
        allow: [phaseName],
        allowed_gates: ["opencode"],
      },
      task_gate: {
        env_file: ".env.gate.local",
        allow: [gateName],
        allowed_gates: ["task"],
      },
    },
  })
  const config = await readJson(configFile)
  config.opencode.provider_auth_mode = "environment"
  config.opencode.provider_environment = [providerName]
  config.opencode.credential_profiles = {
    execute: "worker",
    repair: "worker",
    review: null,
  }
  await writeJson(configFile, config)
  await writeJson(path.join(root, "opencode.jsonc"), {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      worker_api: {
        type: "remote",
        url: "https://example.invalid/worker-mcp",
        headers: { Authorization: `Bearer {env:${phaseName}}` },
        oauth: false,
      },
    },
  })
  await writeJson(path.join(root, ".project", "tools.json"), {
    schema_version: 1,
    roles: {
      worker: ["worker_api_lookup"],
      recovery: ["worker_api_lookup"],
      reviewer: [],
    },
  })
  const queue = await readJson(queueFile)
  queue.tasks.M001.tool_grants = {
    execute: ["worker_api_lookup"],
    repair: ["worker_api_lookup"],
    review: [],
  }
  await writeJson(queueFile, queue)
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task.credential_profile = "task_gate"
  gates.gates.task.feedback = false
  await writeJson(gatesFile, gates)
  const configured = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "configure-tools.mjs"), "--root", root, "--json"],
    { cwd: root },
  )
  assert.equal(configured.code, 0, configured.stderr || configured.stdout)
  await git(root, ["add", ".autopilot/config.json", "opencode.jsonc", ".project/tools.json", ".project/plan/queue.json", ".project/gates.json", ".opencode/agents"])
  await git(root, ["commit", "-m", "test: require preflighted phase credentials"])

  const unprovisionedReport = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "preflight", "--json"],
    { cwd: root },
  )
  assert.equal(unprovisionedReport.code, 1, unprovisionedReport.stderr || unprovisionedReport.stdout)
  const unprovisioned = JSON.parse(unprovisionedReport.stdout)
  assert.equal(unprovisioned.ready, false)
  assert.ok(unprovisioned.phases.some((item) => item.error?.code === "CREDENTIAL_FILE_MISSING"))
  assert.ok(unprovisioned.phases.some((item) => /PREFLIGHT_PROVIDER_TOKEN/.test(item.error?.message ?? "")))
  assert.ok(unprovisioned.gates.some((item) => item.error?.code === "CREDENTIAL_FILE_MISSING"))
  await assert.rejects(access(invocationFile))

  const blocked = await runAutopilot(root, "start", provisionedEnvironment)
  assert.equal(blocked.code, 0, blocked.stderr || blocked.stdout)
  const blockedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(blockedState.status, "human_required", JSON.stringify(blockedState, null, 2))
  assert.equal(blockedState.blocker?.kind, "phase_preflight_failed")
  assert.match(blockedState.blocker?.message ?? "", /credential env file is missing/i)
  assert.equal(blockedState.attempt, 0)
  assert.deepEqual(blockedState.session_ids, [])
  await assert.rejects(access(invocationFile))

  await writeFile(phaseEnv, `${phaseName}=phase-preflight-value-123456\n`, { encoding: "utf8", mode: 0o600 })
  const gateBlocked = await runAutopilot(root, "resume", provisionedEnvironment)
  assert.equal(gateBlocked.code, 0, gateBlocked.stderr || gateBlocked.stdout)
  const gateBlockedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(gateBlockedState.status, "human_required", JSON.stringify(gateBlockedState, null, 2))
  assert.equal(gateBlockedState.blocker?.kind, "phase_preflight_failed")
  assert.match(gateBlockedState.blocker?.message ?? "", /credential env file is missing/i)
  assert.equal(gateBlockedState.attempt, 0)
  assert.deepEqual(gateBlockedState.session_ids, [])
  await assert.rejects(access(invocationFile))

  await writeFile(gateEnv, `${gateName}=gate-preflight-value-456789\n`, { encoding: "utf8", mode: 0o600 })
  const oversizedReportResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "preflight", "--json"],
    {
      cwd: root,
      env: { ...process.env, [providerName]: "x".repeat(8193) },
    },
  )
  assert.equal(oversizedReportResult.code, 1, oversizedReportResult.stderr || oversizedReportResult.stdout)
  const oversizedReport = JSON.parse(oversizedReportResult.stdout)
  assert.ok(oversizedReport.phases.some((item) => item.error?.code === "CREDENTIAL_VALUE_TOO_LARGE"))
  assert.ok(oversizedReport.phases.some((item) => /exceeds 8192 UTF-8 bytes/i.test(item.error?.message ?? "")))
  await assert.rejects(access(invocationFile))
  const readyReport = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "preflight", "--json"],
    { cwd: root, env: provisionedEnvironment },
  )
  assert.equal(readyReport.code, 0, readyReport.stderr || readyReport.stdout)
  const ready = JSON.parse(readyReport.stdout)
  assert.equal(ready.ready, true, JSON.stringify(ready, null, 2))
  assert.equal(ready.zero_model, true)
  assert.equal(ready.opencode.version, "fake-opencode 1.0.0")
  assert.equal(ready.opencode.capability_probe, "passed")
  assert.deepEqual(
    ready.phases.find((item) => item.task_id === "M001" && item.phase === "execute")?.required_environment_names,
    [phaseName],
  )
  assert.deepEqual(
    ready.gates.find((item) => item.gate_id === "task")?.required_environment_names,
    [gateName],
  )
  await assert.rejects(access(invocationFile))

  const resumed = await runAutopilot(root, "resume", provisionedEnvironment)
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const complete = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(complete.status, "complete", JSON.stringify(complete, null, 2))
  const invocations = await readJson(invocationFile)
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["review", 1],
  ])
})

test("OpenCode version and CLI capability preflight block before dispatch and resume at execute one", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const provisionedDirectory = await mkdtemp(path.join(os.tmpdir(), "autopilot-provisioned-opencode-"))
  t.after(async () => rm(provisionedDirectory, { recursive: true, force: true }))
  const provisionedAgent = path.join(provisionedDirectory, "provisioned-opencode.mjs")
  const invocationFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
  const capabilitySecret = "CAPABILITY_HELP_SECRET_MUST_NOT_LEAK_24680"
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, provisionedAgent]
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: require provisioned OpenCode executable"])

  const checklist = await runAutopilot(root, "preflight")
  assert.equal(checklist.code, 1, checklist.stderr || checklist.stdout)
  const report = JSON.parse(checklist.stdout)
  assert.equal(report.ready, false)
  assert.equal(report.opencode.error?.code, "OPENCODE_PREFLIGHT_FAILED")
  await assert.rejects(access(invocationFile))

  const blocked = await runAutopilot(root)
  assert.equal(blocked.code, 0, blocked.stderr || blocked.stdout)
  const blockedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(blockedState.status, "human_required", JSON.stringify(blockedState, null, 2))
  assert.equal(blockedState.blocker?.kind, "phase_preflight_failed")
  assert.match(blockedState.blocker?.message ?? "", /did not return a bounded version/i)
  assert.equal(blockedState.attempt, 0)
  assert.deepEqual(blockedState.session_ids, [])
  await assert.rejects(access(invocationFile))

  await writeFile(
    provisionedAgent,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2)",
      "if (args.includes('--version')) { process.stdout.write('version-only-opencode 1.0.0\\n'); process.exit(0) }",
      `if (args.includes('--help')) { process.stderr.write('${capabilitySecret}\\n'); process.exit(2) }`,
      "process.exit(3)",
      "",
    ].join("\n"),
    "utf8",
  )
  const incompatibleChecklist = await runAutopilot(root, "preflight")
  assert.equal(incompatibleChecklist.code, 1, incompatibleChecklist.stderr || incompatibleChecklist.stdout)
  const incompatibleReport = JSON.parse(incompatibleChecklist.stdout)
  assert.equal(incompatibleReport.ready, false)
  assert.equal(incompatibleReport.opencode.error?.code, "OPENCODE_PREFLIGHT_FAILED")
  assert.match(incompatibleReport.opencode.error?.message ?? "", /zero-model CLI capability probe/i)
  assert.ok((incompatibleReport.opencode.error?.message?.length ?? Infinity) <= 256)
  assert.doesNotMatch(JSON.stringify(incompatibleReport), new RegExp(capabilitySecret))
  assert.doesNotMatch(
    `${incompatibleChecklist.stdout}\n${incompatibleChecklist.stderr}`,
    new RegExp(capabilitySecret),
  )

  const capabilityBlocked = await runAutopilot(root, "resume")
  assert.equal(capabilityBlocked.code, 0, capabilityBlocked.stderr || capabilityBlocked.stdout)
  const capabilityBlockedState = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(capabilityBlockedState.status, "human_required", JSON.stringify(capabilityBlockedState, null, 2))
  assert.equal(capabilityBlockedState.blocker?.kind, "phase_preflight_failed")
  assert.match(capabilityBlockedState.blocker?.message ?? "", /zero-model CLI capability probe/i)
  assert.ok((capabilityBlockedState.blocker?.message?.length ?? Infinity) <= 256)
  assert.doesNotMatch(JSON.stringify(capabilityBlockedState.blocker), new RegExp(capabilitySecret))
  assert.doesNotMatch(
    `${capabilityBlocked.stdout}\n${capabilityBlocked.stderr}`,
    new RegExp(capabilitySecret),
  )
  assert.equal(capabilityBlockedState.attempt, 0)
  assert.deepEqual(capabilityBlockedState.session_ids, [])
  await assert.rejects(access(invocationFile))

  await writeFile(provisionedAgent, await readFile(fakeOpenCodeScript, "utf8"), "utf8")
  const compatibleChecklist = await runAutopilot(root, "preflight")
  assert.equal(compatibleChecklist.code, 0, compatibleChecklist.stderr || compatibleChecklist.stdout)
  const compatibleReport = JSON.parse(compatibleChecklist.stdout)
  assert.equal(compatibleReport.ready, true, JSON.stringify(compatibleReport, null, 2))
  assert.equal(compatibleReport.opencode.capability_probe, "passed")
  await assert.rejects(access(invocationFile))

  const resumed = await runAutopilot(root, "resume")
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const complete = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(complete.status, "complete", JSON.stringify(complete, null, 2))
  const invocations = await readJson(invocationFile)
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["review", 1],
  ])
})

test("fresh launcher accepts one safe top-level sessionID and rejects nested-only or multiple identities", async (t) => {
  for (const mode of ["nested", "multiple"]) {
    await t.test(mode, async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "success" })
      const fakeConfigFile = path.join(root, ".autopilot", "runtime", "fake-config.json")
      const fakeConfig = await readJson(fakeConfigFile)
      fakeConfig.session_id_mode = mode
      await writeJson(fakeConfigFile, fakeConfig)
      const sourceData = path.join(root, ".autopilot", "runtime", "empty-source-data")
      await mkdir(sourceData, { recursive: true })
      const result = await runAutopilot(root, "start", {
        ...process.env,
        XDG_DATA_HOME: sourceData,
      })
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const state = await readJson(path.join(root, ".autopilot", "state.json"))
      assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
      assert.equal(state.attempt, 1)
      assert.match(
        state.blocker?.message ?? "",
        mode === "nested" ? /top-level event\.sessionID/i : /multiple distinct sessions/i,
      )
      const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
      assert.deepEqual(invocations.map((item) => item.stage), ["execute"])
      await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
    })
  }
})

test("a failed gate starts a fresh repair session before succeeding", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "gate-repair" })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "complete", JSON.stringify({ state, result }, null, 2))
  const invocations = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["repair", 2],
    ["review", 2],
  ])
  assert.equal(new Set(invocations.map((item) => item.session_id)).size, 3)
  assert.equal(new Set(invocations.map((item) => item.pid)).size, 3)
  const repairPrompt = invocations.find((item) => item.stage === "repair").argv.at(-1)
  assert.match(repairPrompt, /expected \\"GOOD\\", received \\"BAD\\"/)

  const gateArtifacts = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => /-M001-task-a\d+\.json$/.test(name))
    .sort()
  assert.equal(gateArtifacts.length, 2)
  const attempts = await Promise.all(
    gateArtifacts.map((name) => readJson(path.join(root, ".autopilot", "artifacts", name))),
  )
  assert.deepEqual(attempts.map((item) => item.success), [false, true])
})

test("a final integration gate fails inside the terminal task and repairs autonomously", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "gate-repair" })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task.argv = [process.execPath, fixedGateScript, "pass"]
  gates.gates.final.argv = [process.execPath, fixedGateScript, "expect-file", "src/result.txt", "GOOD"]
  await writeJson(gatesFile, gates)
  await git(root, ["add", ".project/gates.json"])
  await git(root, ["commit", "-m", "test: final integration gate drives repair"])

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(state.status, "complete")
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["repair", 2],
    ["review", 2],
  ])
})

test("a restart after gate failure restores bounded repair diagnostics", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "gate-repair" })
  const first = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_CRASH_POINT: "after_failure_record",
      },
    },
  )
  assert.equal(first.code, 88, first.stderr || first.stdout)
  const interrupted = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(interrupted.phase, "repairing")
  assert.match(JSON.stringify(interrupted.last_failure_evidence), /expected.*GOOD.*received.*BAD/)

  const resumed = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(state.status, "complete", JSON.stringify({ state, resumed }, null, 2))
  assert.deepEqual(invocations.map((item) => item.stage), ["execute", "repair", "review"])
  assert.match(invocations.find((item) => item.stage === "repair").argv.at(-1), /expected \\"GOOD\\", received \\"BAD\\"/)
  assert.equal(state.last_failure_evidence, null)
})

test("a persisted no-progress threshold blocks restart before another phase launches", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "gate-always-fail" })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.budgets.max_no_progress = 1
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: one persisted no-progress failure"])

  const crashEnvironment = {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_CRASH_POINT: "after_failure_record",
  }
  const firstCrash = await runAutopilot(root, "start", crashEnvironment)
  assert.equal(firstCrash.code, 88, firstCrash.stderr || firstCrash.stdout)
  assert.equal((await readJson(path.join(root, ".autopilot", "state.json"))).no_progress_count, 0)

  const thresholdCrash = await runAutopilot(root, "start", crashEnvironment)
  assert.equal(thresholdCrash.code, 88, thresholdCrash.stderr || thresholdCrash.stdout)
  const persisted = await readJson(path.join(root, ".autopilot", "state.json"))
  const invocationsBeforeRestart = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )
  assert.equal(persisted.no_progress_count, 1)
  assert.deepEqual(invocationsBeforeRestart.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["repair", 2],
  ])

  const restart = await runAutopilot(root)
  assert.equal(restart.code, 0, restart.stderr || restart.stdout)
  const blocked = await readJson(path.join(root, ".autopilot", "state.json"))
  const invocationsAfterRestart = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )
  assert.equal(blocked.status, "human_required", JSON.stringify({ blocked, restart }, null, 2))
  assert.equal(blocked.blocker.kind, "no_progress_budget_exhausted")
  assert.deepEqual(invocationsAfterRestart, invocationsBeforeRestart)
})

test("review changes require a fresh repair and a second independent review", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "review-repair" })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const invocations = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )
  assert.equal(state.status, "complete")
  assert.equal(receipt.review.status, "approved")
  assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
    ["execute", 1],
    ["review", 1],
    ["repair", 2],
    ["review", 2],
  ])
  assert.equal(new Set(invocations.map((item) => item.session_id)).size, 4)
})

test("high-risk tasks stop before launching an agent", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: classify task as high risk"])

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required")
  assert.equal(state.blocker.kind, "high_risk_task")
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
})

test("ancillary write failures cannot weaken a high-risk human boundary", async (t) => {
  for (const label of ["checkpoint", "human blocker artifact", "blocked queue projection"]) {
    await t.test(label, async (nested) => {
      const root = await createScaffold(nested, { ready: true })
      const queueFile = path.join(root, ".project", "plan", "queue.json")
      const stateFile = path.join(root, ".autopilot", "state.json")
      const invocationsFile = path.join(root, ".autopilot", "runtime", "fake-invocations.json")
      const queue = await readJson(queueFile)
      queue.tasks.M001.risk = "high"
      await writeJson(queueFile, queue)
      await git(root, ["add", ".project/plan/queue.json"])
      await git(root, ["commit", "-m", `test: fail ancillary ${label}`])

      const stopped = await runAutopilot(root, "start", {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_FAIL_AUXILIARY: label,
      })
      assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout)

      const blocked = await readJson(stateFile)
      assert.equal(blocked.status, "human_required", JSON.stringify({ blocked, stopped }, null, 2))
      assert.equal(blocked.phase, "blocked")
      assert.equal(blocked.blocker.kind, "high_risk_task")
      await assert.rejects(access(invocationsFile))

      const plainRestart = await runAutopilot(root, "start")
      assert.notEqual(plainRestart.code, 0)
      const preserved = await readJson(stateFile)
      assert.equal(preserved.status, "human_required")
      assert.equal(preserved.phase, "blocked")
      assert.equal(preserved.blocker.kind, "high_risk_task")
      await assert.rejects(access(invocationsFile))
    })
  }
})

test("checkpoint write failures do not repair or downgrade a successful task", async (t) => {
  const root = await createScaffold(t, { ready: true, mode: "success" })
  const result = await runAutopilot(root, "start", {
    ...process.env,
    NODE_ENV: "test",
    AUTOPILOT_TEST_FAIL_AUXILIARY: "checkpoint",
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  const invocations = await readJson(
    path.join(root, ".autopilot", "runtime", "fake-invocations.json"),
  )
  assert.equal(state.status, "complete", JSON.stringify({ state, result }, null, 2))
  assert.equal(state.phase, "complete")
  assert.equal(queue.project_status, "complete")
  assert.equal(queue.tasks.M001.status, "done")
  assert.equal(receipt.review.status, "approved")
  assert.deepEqual(invocations.map((item) => item.stage), ["execute", "review"])
})

test("task claiming is recoverable when the controller crashes between state and queue writes", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const crash = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_CRASH_POINT: "after_task_claim_state",
      },
    },
  )
  assert.equal(crash.code, 89, crash.stderr || crash.stdout)
  const interruptedState = await readJson(path.join(root, ".autopilot", "state.json"))
  const interruptedQueue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(interruptedState.active_task, "M001")
  assert.equal(interruptedQueue.tasks.M001.status, "ready")

  const resumed = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout)
  assert.equal((await readJson(path.join(root, ".autopilot", "state.json"))).status, "complete")
})

test("a crash cannot bypass a durable human boundary", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: durable high-risk boundary"])

  const crash = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_CRASH_POINT: "after_human_required_state",
      },
    },
  )
  assert.equal(crash.code, 90, crash.stderr || crash.stdout)
  const interruptedState = await readJson(path.join(root, ".autopilot", "state.json"))
  const interruptedQueue = await readJson(queueFile)
  assert.equal(interruptedState.status, "human_required")
  assert.equal(interruptedState.blocker.kind, "high_risk_task")
  // Task claiming is already durable when runTask reaches the high-risk
  // boundary. A crash between the human-required state write and the blocked
  // queue projection therefore preserves the claimed status; plain start must
  // still refuse to cross the state boundary.
  assert.equal(interruptedQueue.tasks.M001.status, "in_progress")

  const restart = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.notEqual(restart.code, 0)
  assert.match(restart.stderr, /RESUME_REQUIRED/)
  const preserved = await readJson(path.join(root, ".autopilot", "state.json"))
  const preservedQueue = await readJson(queueFile)
  assert.equal(preserved.status, "human_required")
  assert.equal(preserved.blocker.kind, "high_risk_task")
  assert.equal(preservedQueue.tasks.M001.status, "in_progress")
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
})

test("a persisted attempt is never replayed beyond the hard task limit", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.attempt_limit = 1
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: one hard attempt"])

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
  assert.equal((await readJson(path.join(root, ".autopilot", "state.json"))).attempt, 1)

  const restart = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(restart.code, 0, restart.stderr || restart.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required")
  assert.equal(state.blocker.kind, "attempt_budget_exhausted")
  await assert.rejects(access(path.join(root, ".autopilot", "runtime", "fake-invocations.json")))
})

test("attempt and no-progress limits stop repeated failing work", async (t) => {
  for (const scenario of [
    { name: "attempt", attemptLimit: 2, maxNoProgress: 20 },
    { name: "no-progress", attemptLimit: 3, maxNoProgress: 1 },
  ]) {
    await t.test(scenario.name, async (nested) => {
      const root = await createScaffold(nested, { ready: true, mode: "gate-always-fail" })
      const queueFile = path.join(root, ".project", "plan", "queue.json")
      const configFile = path.join(root, ".autopilot", "config.json")
      const queue = await readJson(queueFile)
      const config = await readJson(configFile)
      queue.tasks.M001.attempt_limit = scenario.attemptLimit
      config.budgets.max_no_progress = scenario.maxNoProgress
      config.budgets.max_attempts_per_task = scenario.attemptLimit
      await writeJson(queueFile, queue)
      await writeJson(configFile, config)
      await git(root, ["add", ".project/plan/queue.json", ".autopilot/config.json"])
      await git(root, ["commit", "-m", `test: ${scenario.name} exhaustion`])

      const result = await run(
        [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
        { cwd: root },
      )
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const state = await readJson(path.join(root, ".autopilot", "state.json"))
      const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
      assert.equal(state.status, "human_required")
      assert.equal(state.blocker.kind, "repair_exhausted")
      assert.deepEqual(invocations.map((item) => [item.stage, item.attempt]), [
        ["execute", 1],
        ["repair", 2],
      ])
    })
  }
})

test("near-cap phase ledgers roll over automatically during active-task recovery", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const stateFile = path.join(root, ".autopilot", "state.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.status = "in_progress"
  queue.project_status = "running"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: active task with near-cap session ledger"])
  const baseline = await git(root, ["rev-parse", "HEAD"])
  const state = await readJson(stateFile)
  Object.assign(state, {
    run_id: "old-bounded-run",
    status: "running",
    phase: "recovering",
    pid: 999999,
    started_at: new Date().toISOString(),
    active_task: "M001",
    baseline_head: baseline,
    session_ids: Array.from({ length: 240 }, (_, index) => `old-session-${index}`),
  })
  await writeJson(stateFile, state)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const completed = await readJson(stateFile)
  assert.equal(completed.status, "complete", JSON.stringify({ completed, result }, null, 2))
  assert.notEqual(completed.run_id, "old-bounded-run")
  assert.ok(completed.session_ids.length <= 2)
  assert.ok(completed.session_ids.every((id) => !id.startsWith("old-session-")))
})

test("failed resume preserves the exact blocker and human-required state", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.risk = "high"
  await writeJson(queueFile, queue)
  await git(root, ["add", ".project/plan/queue.json"])
  await git(root, ["commit", "-m", "test: unresolved resume boundary"])
  const blocked = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    { cwd: root },
  )
  assert.equal(blocked.code, 0, blocked.stderr || blocked.stdout)
  const stateFile = path.join(root, ".autopilot", "state.json")
  const blockerFile = path.join(root, ".autopilot", "blocker.md")
  const beforeState = await readJson(stateFile)
  const beforeBlocker = await readFile(blockerFile, "utf8")

  const resume = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "resume"],
    { cwd: root },
  )
  assert.notEqual(resume.code, 0)
  const afterState = await readJson(stateFile)
  assert.equal(afterState.status, "human_required")
  assert.deepEqual(afterState.blocker, beforeState.blocker)
  assert.equal(await readFile(blockerFile, "utf8"), beforeBlocker)
})

test("SIGTERM observed during a model phase pauses before gates, review, or commit", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await writeJson(path.join(root, ".autopilot", "runtime", "fake-config.json"), {
    mode: "success",
    delay_ms: 250,
  })
  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "autopilot.mjs"), "start"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_SIGNAL_DURING_PHASE: "execute",
      },
    },
  )
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const invocations = await readJson(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  assert.equal(state.status, "paused")
  assert.equal(queue.tasks.M001.status, "in_progress")
  assert.deepEqual(invocations.map((item) => item.stage), ["execute"])
  await assert.rejects(access(path.join(root, ".project", "receipts", "M001.json")))
  const taskGateArtifacts = (await readdir(path.join(root, ".autopilot", "artifacts")))
    .filter((name) => /-M001-(?:task|final)-a\d+\.json$/.test(name))
  assert.deepEqual(taskGateArtifacts, [])
})

test("strict validation rejects every OpenCode session-reuse flag", async (t) => {
  for (const flag of REUSE_FLAGS) {
    await t.test(flag, async (nested) => {
      const root = await createScaffold(nested, { ready: true })
      const configFile = path.join(root, ".autopilot", "config.json")
      const config = await readJson(configFile)
      config.opencode.command.push(flag)
      await writeJson(configFile, config)
      const result = await run(
        [process.execPath, path.join(root, ".autopilot", "bin", "validate.mjs"), "--strict"],
        { cwd: root },
      )
      assert.notEqual(result.code, 0)
      const report = JSON.parse(result.stdout)
      assert.ok(
        report.issues.some(
          (issue) => issue.location === "config.opencode.command" && issue.message.includes(flag),
        ),
      )
    })
  }
})

test("context packing rejects protected secret paths and hard byte-cap overflow", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.context = { shared: [], execute: [".env.test.local"], repair: [], review: [] }
  await writeJson(queueFile, queue)
  await writeFile(path.join(root, ".env.test.local"), "TOKEN=not-a-real-secret-value\n", "utf8")

  const protectedResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(protectedResult.code, 0)
  assert.match(protectedResult.stderr, /Sensitive\/control content cannot enter a context pack/)

  const secretReference = "context-input.txt"
  await writeFile(path.join(root, secretReference), `api_key=${"sk-" + "a".repeat(24)}\n`, "utf8")
  queue.tasks.M001.context = { shared: [], execute: [secretReference], repair: [], review: [] }
  await writeJson(queueFile, queue)
  const secretResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(secretResult.code, 0)
  assert.match(secretResult.stderr, /contains a possible secret value/)
  assert.doesNotMatch(secretResult.stderr, /sk-a{8}/)

  queue.tasks.M001.context = { shared: [], execute: [".project/brief.md"], repair: [], review: [] }
  await writeJson(queueFile, queue)
  const configFile = path.join(root, ".autopilot", "config.json")
  const manifestFile = path.join(root, ".project", "manifest.json")
  const config = await readJson(configFile)
  const manifest = await readJson(manifestFile)
  config.context.max_bytes = 256
  manifest.max_context_bytes = 256
  await writeJson(configFile, config)
  await writeJson(manifestFile, manifest)

  const cappedResult = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(cappedResult.code, 0)
  assert.match(cappedResult.stderr, /exceeds 256 bytes|No context budget remains|BYTE_CAP_EXCEEDED/)
})
