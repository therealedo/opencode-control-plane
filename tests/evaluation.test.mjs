import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_CASES,
  DEFAULT_STRATEGIES,
  EVALUATOR_OWNER,
  EvaluationError,
  LIVE_CONFIRMATION,
  __test as evaluationInternals,
  planEvaluation,
  resumeEvaluation,
  startEvaluation,
} from "../scripts/lib/evaluation.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(repositoryRoot, "scripts", "evaluate.mjs")
const profileFile = path.join(repositoryRoot, "evaluation", "profile.example.json")

test("plan and no-argument CLI are read-only", async () => {
  const plan = await planEvaluation({ profileFile })
  assert.equal(plan.trial_count, 21)
  assert.deepEqual(plan.cases.map((item) => item.id), DEFAULT_CASES)
  assert.deepEqual(plan.strategies, DEFAULT_STRATEGIES)
  assert.match(plan.note, /does not create workspaces/i)

  const child = await runCli([])
  assert.equal(child.code, 0)
  assert.match(child.stdout, /--simulate/)
  assert.match(child.stdout, /No command creates or opens an existing project/)
})

test("simulation runs the 7 x 3 matrix in marked disposable workspaces", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-test-"))
  const parent = path.join(temporary, "owned")
  context.after(() => rm(temporary, { recursive: true, force: true }))

  const report = await startEvaluation({ mode: "simulate", profileFile, parentDirectory: parent })
  assert.equal(report.status, "completed")
  assert.equal(report.planned_trial_count, 21)
  assert.equal(report.completed_trial_count, 21)
  assert.equal(report.accepted_trial_count, 19)
  assert.equal(report.failed_trial_count, 2)
  assert.equal(report.review_count, 8)
  assert.equal(report.review_rejection_count, 1)
  assert.equal(report.false_completion_count, 1)
  assert.equal(report.unexpected_changed_file_count, 0)
  assert.equal(report.dependency_addition_count, 0)
  assert.equal(report.common_final_gate_pass_count, 19)
  assert.equal(report.common_final_gate_failed_count, 2)
  assert.equal(report.common_final_gate_not_run_count, 0)
  assert.equal(report.strategy_gate_run_count, 23)
  assert.equal(report.strategy_gate_failed_count, 4)
  assert.equal(report.runtime_metadata.opencode, null)
  assert.match(report.runtime_metadata.control_plane.version, /^\d+\.\d+\.\d+/)
  assert.match(report.runtime_metadata.control_plane.source_revision_sha256, /^[0-9a-f]{64}$/)
  assert.equal(report.usage.status, "unavailable")
  for (const field of [
    "input_tokens", "output_tokens", "reasoning_tokens",
    "cache_read_tokens", "cache_write_tokens", "provider_cost",
  ]) assert.equal(report.usage[field], null)
  assert.deepEqual(report.budgets.checks.map((item) => item.name), [
    "max_trials",
    "max_elapsed_minutes",
    "max_input_tokens",
    "max_output_tokens",
    "max_reasoning_tokens",
    "max_cache_read_tokens",
    "max_cache_write_tokens",
    "max_provider_cost",
  ])

  const directInterruption = trial(report, "interruption-recovery", "direct")
  const directRepair = trial(report, "failed-verification", "direct")
  assert.equal(directInterruption.failure, "interrupted_without_recovery")
  assert.equal(directRepair.failure, "verification_failed_without_repair")
  for (const strategy of ["fresh_loop", "control_plane"]) {
    const recovered = trial(report, "interruption-recovery", strategy)
    assert.equal(recovered.accepted, true)
    assert.equal(recovered.recoveries, 1)
    assert.equal(recovered.attempts, 2)
    const repaired = trial(report, "failed-verification", strategy)
    assert.equal(repaired.accepted, true)
    assert.equal(repaired.repairs, 1)
    assert.equal(repaired.strategy_gates.run_count, 2)
    assert.equal(repaired.strategy_gates.failed_count, 1)
    assert.deepEqual(repaired.strategy_gates.failure_evidence, [
      { attempt: 1, code: "forced_verification_failure" },
    ])
    assert.equal(repaired.common_final_gate.status, "passed")
  }

  const runDirectory = path.join(parent, report.run_id)
  const results = await readdir(path.join(runDirectory, "results"))
  assert.equal(results.length, 21)
  assert.equal((await readdir(path.join(runDirectory, "work"))).length, 0)
  const marker = JSON.parse(await readFile(path.join(parent, ".ocp-evaluation-parent.json"), "utf8"))
  assert.equal(marker.owner, EVALUATOR_OWNER)

  const jsonReport = await readFile(path.join(runDirectory, "report.json"), "utf8")
  const markdownReport = await readFile(path.join(runDirectory, "report.md"), "utf8")
  assert.doesNotMatch(jsonReport, new RegExp(escapeRegex(temporary), "i"))
  assert.doesNotMatch(markdownReport, new RegExp(escapeRegex(temporary), "i"))
  assert.doesNotMatch(jsonReport, /task_file|workspace|prompt|password|api[_-]?key/i)
  assert.doesNotMatch(markdownReport, /total tokens/i)
  assert.match(markdownReport, /interrupted_without_recovery/)
  assert.match(markdownReport, /verification_failed_without_repair/)
})

test("live start uses a fake provider and pins runtime compatibility metadata", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-live-core-"))
  const parent = path.join(temporary, "owned")
  const fake = path.join(temporary, "fake-opencode.mjs")
  const solution = path.join(repositoryRoot, "evaluation", "corpus", "greenfield", "solution")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  await writeFile(fake, fakeProviderSource(solution, "fake-opencode 1.0.0"), "utf8")
  const profile = JSON.parse(await readFile(profileFile, "utf8"))
  profile.profile_id = "fake-live-core"
  profile.model = "test-provider/test-model"
  profile.variant = "high"
  profile.opencode_command = [process.execPath, fake]
  profile.provider_auth_mode = "none"
  profile.provider_environment = []
  profile.budgets.max_trials = 1

  const report = await startEvaluation({
    mode: "live",
    profile,
    parentDirectory: parent,
    confirmation: LIVE_CONFIRMATION,
  })
  assert.equal(report.status, "stopped_budget")
  assert.equal(report.completed_trial_count, 1)
  assert.equal(report.accepted_trial_count, 1)
  assert.deepEqual(report.runtime_metadata.opencode, { version: "fake-opencode 1.0.0" })
  assert.match(report.runtime_metadata.control_plane.version, /^\d+\.\d+\.\d+/)
  assert.match(report.runtime_metadata.control_plane.source_revision_sha256, /^[0-9a-f]{64}$/)
  assert.equal(report.trials[0].strategy, "direct")
  assert.deepEqual(report.trials[0].strategy_gates, {
    run_count: 1,
    failed_count: 0,
    failure_evidence: [],
  })
  assert.equal(report.trials[0].common_final_gate.status, "passed")
  assert.equal(report.trials[0].false_completion, false)
  assert.equal(report.trials[0].usage.status, "complete")
  assert.equal(report.trials[0].usage.input_tokens, 10)

  await writeFile(fake, fakeProviderSource(solution, "fake-opencode 2.0.0"), "utf8")
  await assert.rejects(
    resumeEvaluation(report.run_id, { parentDirectory: parent, confirmation: LIVE_CONFIRMATION }),
    (error) => error instanceof EvaluationError && error.code === "OPENCODE_VERSION_CHANGED",
  )

  await writeFile(fake, fakeProviderSource(solution, "fake-opencode 1.0.0"), "utf8")
  const stateFile = path.join(parent, report.run_id, "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.runtime_metadata.control_plane.source_revision_sha256 = "0".repeat(64)
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await assert.rejects(
    resumeEvaluation(report.run_id, { parentDirectory: parent, confirmation: LIVE_CONFIRMATION }),
    (error) => error instanceof EvaluationError && error.code === "CONTROL_PLANE_REVISION_CHANGED",
  )
})

test("common gate rejects deceptive success output from a failed process", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-gate-exit-"))
  const candidate = path.join(temporary, "candidate")
  const gate = path.join(temporary, "gate.mjs")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  await mkdir(candidate)
  await writeFile(gate, 'process.stdout.write(JSON.stringify({ok:true,checks:["deceptive"]}));process.exitCode=7\n', "utf8")
  const result = await evaluationInternals.runHeldOutGate({
    case: { id: "greenfield", gate_file: gate },
  }, candidate, { timeout_seconds: 2 })
  assert.equal(result.passed, false)
  assert.equal(result.failure, "held_out_gate_process_failed")
})

test("live boundary stops on zero-model version drift before a provider run", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-boundary-"))
  const parent = path.join(temporary, "owned")
  const fake = path.join(temporary, "fake-opencode.mjs")
  const counter = path.join(temporary, "versions.txt")
  const runMarker = path.join(temporary, "provider-run.txt")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  await writeFile(fake, driftingVersionProviderSource(counter, runMarker), "utf8")
  const profile = JSON.parse(await readFile(profileFile, "utf8"))
  profile.profile_id = "boundary-version-drift"
  profile.model = "test-provider/test-model"
  profile.variant = "high"
  profile.opencode_command = [process.execPath, fake]
  profile.provider_auth_mode = "none"
  profile.provider_environment = []
  profile.budgets.max_trials = 1

  const report = await startEvaluation({
    mode: "live",
    profile,
    parentDirectory: parent,
    confirmation: LIVE_CONFIRMATION,
  })
  assert.equal(report.status, "stopped_safety")
  assert.equal(report.stop_reason, "opencode_version_changed")
  assert.equal(report.completed_trial_count, 0)
  await assert.rejects(lstat(runMarker), { code: "ENOENT" })
})

test("saved state, receipts, and reports reject schema and content tampering", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-artifacts-"))
  const parent = path.join(temporary, "owned")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const paused = await startEvaluation({
    mode: "simulate",
    profileFile,
    parentDirectory: parent,
    maxTrialsThisInvocation: 1,
  })
  const run = path.join(parent, paused.run_id)
  const stateFile = path.join(run, "state.json")
  const resultFile = path.join(run, "results", `${paused.trials[0].trial_id}.json`)
  const reportFile = path.join(run, "report.json")
  const originalState = JSON.parse(await readFile(stateFile, "utf8"))
  const originalResult = JSON.parse(await readFile(resultFile, "utf8"))
  const originalReport = JSON.parse(await readFile(reportFile, "utf8"))
  const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")

  await save(stateFile, { ...originalState, unexpected: true })
  await assert.rejects(resumeEvaluation(paused.run_id, { parentDirectory: parent }),
    (error) => error instanceof EvaluationError && error.code === "STATE_INVALID")
  await save(stateFile, originalState)

  const inconsistent = structuredClone(originalResult)
  inconsistent.strategy_gates.failed_count = 1
  await save(resultFile, inconsistent)
  await assert.rejects(resumeEvaluation(paused.run_id, { parentDirectory: parent }),
    (error) => error instanceof EvaluationError && error.code === "RESULT_INVALID")
  await save(resultFile, originalResult)

  const unsafeReports = [
    (() => { const value = structuredClone(originalReport); value.trials[0].common_final_gate.checks[0] = "detail C:\\Users\\victim\\token.txt"; return value })(),
    (() => { const value = structuredClone(originalReport); value.trials[0].common_final_gate.checks[0] = "detail /home/victim/token.txt"; return value })(),
    (() => { const value = structuredClone(originalReport); value.trials[0].common_final_gate.checks[0] = "line one\nline two"; return value })(),
    (() => { const value = structuredClone(originalReport); value.profile.nested = { api_key: "redacted" }; return value })(),
  ]
  for (const unsafe of unsafeReports) {
    await save(reportFile, unsafe)
    await assert.rejects(resumeEvaluation(paused.run_id, { parentDirectory: parent }),
      (error) => error instanceof EvaluationError && error.code === "REPORT_UNSAFE")
  }
  const inconsistentReport = structuredClone(originalReport)
  inconsistentReport.completed_trial_count += 1
  await save(reportFile, inconsistentReport)
  await assert.rejects(resumeEvaluation(paused.run_id, { parentDirectory: parent }),
    (error) => error instanceof EvaluationError && error.code === "REPORT_INVALID")
})

test("soft trial budget stops before the next isolated trial", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-budget-"))
  const parent = path.join(temporary, "owned")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const profile = JSON.parse(await readFile(profileFile, "utf8"))
  profile.profile_id = "budget-test"
  profile.budgets.max_trials = 2

  const report = await startEvaluation({ mode: "simulate", profile, parentDirectory: parent })
  assert.equal(report.status, "stopped_budget")
  assert.equal(report.completed_trial_count, 2)
  assert.equal(report.stop_reason, "max_trials:reached")
  const check = report.budgets.checks.find((item) => item.name === "max_trials")
  assert.deepEqual(check, { name: "max_trials", limit: 2, spent: 2, status: "reached" })
  assert.equal((await readdir(path.join(parent, report.run_id, "results"))).length, 2)
})

test("run-id resume skips immutable receipts and rejects profile drift", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-resume-"))
  const parent = path.join(temporary, "owned")
  context.after(() => rm(temporary, { recursive: true, force: true }))

  const paused = await startEvaluation({
    mode: "simulate",
    profileFile,
    parentDirectory: parent,
    maxTrialsThisInvocation: 4,
  })
  assert.equal(paused.status, "paused")
  assert.equal(paused.completed_trial_count, 4)
  const firstReceipt = path.join(parent, paused.run_id, "results", `${paused.trials[0].trial_id}.json`)
  const before = await lstat(firstReceipt)

  const stateFile = path.join(parent, paused.run_id, "state.json")
  const interruptedState = JSON.parse(await readFile(stateFile, "utf8"))
  interruptedState.status = "running"
  interruptedState.active_trial = {
    trial_id: "r01-feature-fresh-loop",
    started_at: new Date().toISOString(),
  }
  await writeFile(stateFile, `${JSON.stringify(interruptedState, null, 2)}\n`, "utf8")

  const completed = await resumeEvaluation(paused.run_id, { parentDirectory: parent })
  assert.equal(completed.status, "completed")
  assert.equal(completed.completed_trial_count, 21)
  const after = await lstat(firstReceipt)
  assert.equal(after.mtimeMs, before.mtimeMs, "resume must not rewrite a completed trial")
  assert.equal(new Set(completed.trials.map((item) => item.trial_id)).size, 21)
  const interrupted = completed.trials.find((item) => item.trial_id === "r01-feature-fresh-loop")
  assert.equal(interrupted.failure, "measurement_incomplete_after_interruption")
  assert.equal(interrupted.attempts, 1)
  assert.deepEqual(interrupted.strategy_gates, {
    run_count: null,
    failed_count: null,
    failure_evidence: [],
  })
  assert.equal(interrupted.common_final_gate.status, "not_run")
  assert.equal(interrupted.elapsed_ms, null)
  assert.equal((await readdir(path.join(parent, paused.run_id, "results"))).length, 21)

  const savedProfile = path.join(parent, paused.run_id, "profile.json")
  const changed = JSON.parse(await readFile(savedProfile, "utf8"))
  changed.model = "changed/model"
  await writeFile(savedProfile, `${JSON.stringify(changed, null, 2)}\n`, "utf8")
  await assert.rejects(
    resumeEvaluation(paused.run_id, { parentDirectory: parent }),
    (error) => error instanceof EvaluationError && error.code === "PROFILE_CHANGED",
  )
})

test("resume refuses missing completed receipts but repairs receipt-before-state crashes", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-receipt-invariant-"))
  const parent = path.join(temporary, "owned")
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const paused = await startEvaluation({
    mode: "simulate",
    profileFile,
    parentDirectory: parent,
    maxTrialsThisInvocation: 2,
  })
  const run = path.join(parent, paused.run_id)
  const stateFile = path.join(run, "state.json")
  const missingId = paused.trials[1].trial_id
  const receiptFile = path.join(run, "results", `${missingId}.json`)
  const receipt = await readFile(receiptFile, "utf8")

  await unlink(receiptFile)
  await assert.rejects(
    resumeEvaluation(paused.run_id, { parentDirectory: parent, maxTrialsThisInvocation: 0 }),
    (error) => error instanceof EvaluationError && error.code === "RESULT_MISSING",
  )

  await writeFile(receiptFile, receipt, "utf8")
  const staleState = JSON.parse(await readFile(stateFile, "utf8"))
  staleState.completed_trial_ids = staleState.completed_trial_ids.filter((trialId) => trialId !== missingId)
  await writeFile(stateFile, `${JSON.stringify(staleState, null, 2)}\n`, "utf8")
  const recovered = await resumeEvaluation(paused.run_id, {
    parentDirectory: parent,
    maxTrialsThisInvocation: 0,
  })
  assert.equal(recovered.completed_trial_count, 2)
  const repairedState = JSON.parse(await readFile(stateFile, "utf8"))
  assert.ok(repairedState.completed_trial_ids.includes(missingId))
})

test("ownership and live confirmation fail closed before touching projects", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ocp-evaluation-safety-"))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const unowned = path.join(temporary, "unowned")
  await mkdir(unowned)
  await assert.rejects(
    startEvaluation({ mode: "simulate", profileFile, parentDirectory: unowned }),
    (error) => error instanceof EvaluationError && error.code === "PARENT_NOT_OWNED",
  )
  await assert.rejects(
    resumeEvaluation("C:\\personal-project", { parentDirectory: unowned }),
    (error) => error instanceof EvaluationError && error.code === "RUN_ID_INVALID",
  )
  await assert.rejects(
    startEvaluation({ mode: "live", profileFile, parentDirectory: path.join(temporary, "live") }),
    (error) => error instanceof EvaluationError && error.code === "LIVE_CONFIRMATION_REQUIRED",
  )
  await assert.rejects(
    startEvaluation({
      mode: "live",
      profileFile,
      parentDirectory: path.join(temporary, "live"),
      confirmation: LIVE_CONFIRMATION,
    }),
    (error) => error instanceof EvaluationError && error.code === "LIVE_PREFLIGHT_FAILED",
  )
  await assert.rejects(lstat(path.join(temporary, "live")), { code: "ENOENT" })
})

function trial(report, caseId, strategy) {
  const result = report.trials.find((item) => item.case_id === caseId && item.strategy === strategy)
  assert.ok(result, `missing ${caseId}/${strategy}`)
  return result
}

function fakeProviderSource(solution, version) {
  return `import { cp } from "node:fs/promises";\nimport path from "node:path";\nconst argv=process.argv.slice(2);\nif(argv.includes("--version")){process.stdout.write(${JSON.stringify(`${version}\n`)});process.exit(0)}\nif(argv.includes("--help")){process.stdout.write("Usage: opencode run --format json --variant name\\n");process.exit(0)}\nconst index=argv.indexOf("--dir");\nconst root=index>=0?path.resolve(argv[index+1]):process.cwd();\nawait cp(${JSON.stringify(solution)},root,{recursive:true,force:true});\nconst session="ses-fake-"+process.pid;\nconst timestamp=Date.now();\nprocess.stdout.write(JSON.stringify({type:"session",timestamp,sessionID:session})+"\\n");\nprocess.stdout.write(JSON.stringify({type:"step_finish",timestamp:timestamp+1,sessionID:session,part:{id:"part-"+session,messageID:"msg-"+session,sessionID:session,type:"step-finish",reason:"stop",cost:0.01,tokens:{total:19,input:10,output:5,reasoning:2,cache:{read:2,write:1}}}})+"\\n");\n`
}

function driftingVersionProviderSource(counter, runMarker) {
  return `import { readFile, writeFile } from "node:fs/promises";
const argv=process.argv.slice(2);
if(argv.includes("--version")){
  let count=0;try{count=Number(await readFile(${JSON.stringify(counter)},"utf8"))||0}catch{}
  count+=1;await writeFile(${JSON.stringify(counter)},String(count),"utf8");
  process.stdout.write(count===1?"fake-opencode 1.0.0\\n":"fake-opencode 2.0.0\\n");process.exit(0)
}
if(argv.includes("--help")){process.stdout.write("Usage: opencode run --format json --variant name\\n");process.exit(0)}
await writeFile(${JSON.stringify(runMarker)},"called","utf8");process.exit(9);
`
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repositoryRoot,
      env: { NO_COLOR: "1", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}
