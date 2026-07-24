import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  aggregateUsage,
  emptyUsage,
  MODEL_USAGE_FIELDS,
  renderUsageColumns,
} from "./evaluation-telemetry.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(moduleDirectory, "..", "..")
const defaultEvaluationRoot = path.join(repositoryRoot, "evaluation")

export const EVALUATOR_OWNER = "opencode-control-plane-evaluator"
export const EVALUATOR_PARENT_NAME = "opencode-control-plane-evaluation-v1"
export const LIVE_CONFIRMATION = "LIVE_EVALUATION_USES_PROVIDER_CREDITS"
export const DEFAULT_CASES = Object.freeze([
  "greenfield",
  "feature",
  "bug-repair",
  "external-integration",
  "blueprint-migration",
  "interruption-recovery",
  "failed-verification",
])
export const DEFAULT_STRATEGIES = Object.freeze(["direct", "fresh_loop", "control_plane"])

const PARENT_MARKER_FILE = ".ocp-evaluation-parent.json"
const RUN_MARKER_FILE = ".ocp-evaluation-run.json"
const WORK_MARKER_FILE = ".ocp-evaluation-work.json"
const RUN_ID_PATTERN = /^eval-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_JSON_BYTES = 256 * 1024
const MAX_CORPUS_FILE_BYTES = 1024 * 1024
const MAX_CORPUS_FILES = 512
const MAX_GATE_OUTPUT_BYTES = 128 * 1024
const PINNED_BOUNDARY_FAILURES = new Set([
  "control_plane_revision_changed",
  "corpus_changed",
  "opencode_preflight_failed",
  "opencode_version_changed",
])
const PARENT_MARKER = Object.freeze({
  schema_version: 1,
  owner: EVALUATOR_OWNER,
  kind: "disposable-evaluation-parent",
})
const USAGE_BUDGET_FIELDS = Object.freeze([
  ["max_input_tokens", "input_tokens"],
  ["max_output_tokens", "output_tokens"],
  ["max_reasoning_tokens", "reasoning_tokens"],
  ["max_cache_read_tokens", "cache_read_tokens"],
  ["max_cache_write_tokens", "cache_write_tokens"],
  ["max_provider_cost", "provider_cost"],
])

export class EvaluationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "EvaluationError"
    this.code = code
  }
}

export function evaluationParentDirectory() {
  return path.join(os.tmpdir(), EVALUATOR_PARENT_NAME)
}

export function defaultEvaluationProfileFile() {
  return path.join(defaultEvaluationRoot, "profile.example.json")
}

export async function loadEvaluationProfile(file = defaultEvaluationProfileFile()) {
  const resolved = path.resolve(file)
  const value = await readBoundedJson(resolved, "evaluation profile")
  return normalizeProfile(value)
}

export async function planEvaluation({
  profile,
  profileFile,
  evaluationRoot = defaultEvaluationRoot,
} = {}) {
  const normalized = profile ? normalizeProfile(profile) : await loadEvaluationProfile(profileFile)
  const corpus = await loadCorpus(normalized, evaluationRoot)
  const trials = buildTrials(normalized, corpus.cases)
  return publicPlan(normalized, corpus, trials)
}

export async function startEvaluation({
  mode,
  profile,
  profileFile,
  confirmation,
  parentDirectory = evaluationParentDirectory(),
  evaluationRoot = defaultEvaluationRoot,
  maxTrialsThisInvocation = Infinity,
} = {}) {
  if (mode !== "simulate" && mode !== "live") {
    throw new EvaluationError("MODE_REQUIRED", "mode must be simulate or live")
  }
  const normalized = profile ? normalizeProfile(profile) : await loadEvaluationProfile(profileFile)
  const controlPlane = await controlPlaneRuntimeMetadata()
  let liveRunner = null
  let liveAdapter = null
  let openCode = null
  if (mode === "live") {
    requireLiveConfirmation(confirmation)
    const adapter = await loadLiveRunner()
    openCode = await preflightLiveRunner(adapter, normalized)
    liveRunner = adapter.runTrial
    liveAdapter = adapter
  }
  const runtimeMetadata = { control_plane: controlPlane, opencode: openCode }
  const corpus = await loadCorpus(normalized, evaluationRoot)
  const trials = buildTrials(normalized, corpus.cases)
  const parent = await ensureEvaluationParent(parentDirectory, { create: true })
  const runId = `eval-${randomUUID()}`
  const runDirectory = path.join(parent, runId)
  await mkdir(runDirectory, { recursive: false, mode: 0o700 })
  const createdAt = new Date().toISOString()
  await writeExclusiveJson(path.join(runDirectory, RUN_MARKER_FILE), {
    schema_version: 1,
    owner: EVALUATOR_OWNER,
    kind: "evaluation-run",
    run_id: runId,
  })
  await mkdir(path.join(runDirectory, "results"), { mode: 0o700 })
  await mkdir(path.join(runDirectory, "work"), { mode: 0o700 })
  await writeExclusiveJson(path.join(runDirectory, "profile.json"), normalized)
  const profileHash = hashCanonical(normalized)
  const state = {
    schema_version: 1,
    owner: EVALUATOR_OWNER,
    run_id: runId,
    mode,
    status: "ready",
    created_at: createdAt,
    updated_at: createdAt,
    corpus_sha256: corpus.sha256,
    profile_sha256: profileHash,
    planned_trial_count: trials.length,
    runtime_metadata: runtimeMetadata,
    completed_trial_ids: [],
    active_trial: null,
    stop_reason: null,
  }
  await writeEvaluationState(runDirectory, state)
  return executeRun({
    parent,
    runDirectory,
    state,
    profile: normalized,
    corpus,
    trials,
    liveRunner,
    liveAdapter,
    maxTrialsThisInvocation,
  })
}

export async function resumeEvaluation(runId, {
  confirmation,
  parentDirectory = evaluationParentDirectory(),
  evaluationRoot = defaultEvaluationRoot,
  maxTrialsThisInvocation = Infinity,
} = {}) {
  assertRunId(runId)
  const parent = await ensureEvaluationParent(parentDirectory, { create: false })
  const runDirectory = path.join(parent, runId)
  const marker = await readBoundedJson(path.join(runDirectory, RUN_MARKER_FILE), "evaluation run marker")
  if (
    marker?.schema_version !== 1 ||
    marker.owner !== EVALUATOR_OWNER ||
    marker.kind !== "evaluation-run" ||
    marker.run_id !== runId
  ) throw new EvaluationError("RUN_NOT_OWNED", "the requested run is not evaluator-owned")
  await assertRealDirectory(runDirectory, "evaluation run")
  const state = await readBoundedJson(path.join(runDirectory, "state.json"), "evaluation state")
  validateState(state, runId)
  if (state.mode === "live") requireLiveConfirmation(confirmation)
  const profile = normalizeProfile(await readBoundedJson(
    path.join(runDirectory, "profile.json"),
    "saved evaluation profile",
  ))
  const profileHash = hashCanonical(profile)
  if (profileHash !== state.profile_sha256) {
    throw new EvaluationError("PROFILE_CHANGED", "the saved profile changed; this run cannot be resumed")
  }
  const controlPlane = await controlPlaneRuntimeMetadata()
  if (canonical(controlPlane) !== canonical(state.runtime_metadata.control_plane)) {
    throw new EvaluationError(
      "CONTROL_PLANE_REVISION_CHANGED",
      "the Control Plane version or source revision changed; start a new evaluation run",
    )
  }
  let liveRunner = null
  let liveAdapter = null
  if (state.mode === "live") {
    const adapter = await loadLiveRunner()
    const openCode = await preflightLiveRunner(adapter, profile)
    if (canonical(openCode) !== canonical(state.runtime_metadata.opencode)) {
      throw new EvaluationError(
        "OPENCODE_VERSION_CHANGED",
        "the sanitized OpenCode version changed; start a new live evaluation run",
      )
    }
    liveRunner = adapter.runTrial
    liveAdapter = adapter
  }
  const corpus = await loadCorpus(profile, evaluationRoot)
  if (corpus.sha256 !== state.corpus_sha256) {
    throw new EvaluationError("CORPUS_CHANGED", "the evaluation corpus changed; start a new run")
  }
  const trials = buildTrials(profile, corpus.cases)
  if (trials.length !== state.planned_trial_count) {
    throw new EvaluationError("PLAN_CHANGED", "the saved trial plan no longer matches this run")
  }
  return executeRun({
    parent,
    runDirectory,
    state,
    profile,
    corpus,
    trials,
    liveRunner,
    liveAdapter,
    maxTrialsThisInvocation,
  })
}

async function pinnedBoundaryFailure(context) {
  let controlPlane
  try { controlPlane = await controlPlaneRuntimeMetadata() }
  catch { return "control_plane_revision_changed" }
  if (canonical(controlPlane) !== canonical(context.state.runtime_metadata.control_plane)) {
    return "control_plane_revision_changed"
  }

  let corpus
  try { corpus = await loadCorpus(context.profile, context.corpus.root) }
  catch { return "corpus_changed" }
  if (corpus.sha256 !== context.state.corpus_sha256) return "corpus_changed"

  if (context.state.mode === "live") {
    if (!context.liveAdapter) return "opencode_preflight_failed"
    let openCode
    try { openCode = await preflightLiveRunner(context.liveAdapter, context.profile) }
    catch { return "opencode_preflight_failed" }
    if (canonical(openCode) !== canonical(context.state.runtime_metadata.opencode)) {
      return "opencode_version_changed"
    }
  }
  return null
}

async function executeRun(context) {
  const release = await acquireRunLock(context.runDirectory)
  try {
    const results = await loadResults(context.runDirectory, context.trials)
    assertCompletedReceiptsPresent(context.state, results)
    await validateSavedReportIfPresent(context)
    const reconciliation = await reconcileActiveTrial(context, results)
    if (!context.profile.keep_test_projects && !reconciliation.had_active_trial) {
      await cleanupOrphanWorkspaces(context.runDirectory)
    }
    if (reconciliation.unsafe_workspace) {
      context.state.status = "stopped_safety"
      context.state.stop_reason = "unsafe_workspace_retained"
      context.state.updated_at = new Date().toISOString()
      await writeEvaluationState(context.runDirectory, context.state)
      return writeReports(context, results, context.state.status, context.state.stop_reason)
    }
    let startedThisInvocation = 0
    let stopReason = null

    for (const trial of context.trials) {
      if (results.has(trial.id)) continue
      if (startedThisInvocation >= normalizeInvocationLimit(context.maxTrialsThisInvocation)) {
        stopReason = "invocation_limit"
        break
      }
      const budget = evaluateBudgets(context.profile, [...results.values()], context.state.mode)
      if (!budget.can_start_next_trial) {
        stopReason = budget.stop_reason
        break
      }
      const boundaryFailure = await pinnedBoundaryFailure(context)
      if (boundaryFailure) {
        stopReason = boundaryFailure
        break
      }
      context.state.status = "running"
      context.state.stop_reason = null
      context.state.active_trial = {
        trial_id: trial.id,
        started_at: new Date().toISOString(),
      }
      context.state.updated_at = new Date().toISOString()
      await writeEvaluationState(context.runDirectory, context.state)

      let result
      try {
        result = await executeTrial(context, trial)
      } catch (error) {
        result = failedTrialResult(trial, error)
      }
      await writeTrialResult(context.runDirectory, result, trial)
      results.set(trial.id, result)
      startedThisInvocation += 1
      context.state.completed_trial_ids = orderedCompletedIds(context.trials, results)
      context.state.active_trial = null
      context.state.updated_at = new Date().toISOString()
      await writeEvaluationState(context.runDirectory, context.state)
      await writeReports(context, results, "running", null)
    }

    const complete = results.size === context.trials.length
    const safetyStop = PINNED_BOUNDARY_FAILURES.has(stopReason)
    context.state.status = complete
      ? "completed"
      : (stopReason === "invocation_limit" ? "paused" : (safetyStop ? "stopped_safety" : "stopped_budget"))
    context.state.stop_reason = complete ? null : stopReason
    context.state.completed_trial_ids = orderedCompletedIds(context.trials, results)
    context.state.updated_at = new Date().toISOString()
    await writeEvaluationState(context.runDirectory, context.state)
    return writeReports(context, results, context.state.status, context.state.stop_reason)
  } finally {
    await release()
  }
}

async function executeTrial(context, trial) {
  const workDirectory = path.join(
    context.runDirectory,
    "work",
    `${trial.id}-${randomUUID()}`,
  )
  await mkdir(workDirectory, { recursive: false, mode: 0o700 })
  await writeExclusiveJson(path.join(workDirectory, WORK_MARKER_FILE), {
    schema_version: 1,
    owner: EVALUATOR_OWNER,
    kind: "evaluation-workspace",
    run_id: context.state.run_id,
    trial_id: trial.id,
  })
  const started = process.hrtime.bigint()
  let result
  try {
    const candidate = path.join(workDirectory, "candidate")
    await mkdir(candidate, { recursive: false, mode: 0o700 })
    await copyTree(trial.case.seed_directory, candidate, { overlay: true })
    let strategy
    try {
      strategy = context.state.mode === "simulate"
        ? await simulateTrial(trial, candidate, context.profile)
        : await executeLiveTrial(context, trial, workDirectory, candidate)
    } catch (error) {
      strategy = failedStrategyOutcome(error)
    }
    let commonGate
    try { commonGate = await runHeldOutGate(trial, candidate, context.profile) }
    catch { commonGate = { passed: false, checks: [], failure: "common_final_gate_error" } }
    result = trialResult(trial, strategy, commonGate)
  } catch (error) {
    result = failedTrialResult(trial, error)
  }
  const elapsedMs = Math.max(0, Number((process.hrtime.bigint() - started) / 1_000_000n))
  result.elapsed_ms = elapsedMs
  result.cleanup = context.profile.keep_test_projects ? "retained_by_profile" : "removed"

  if (!context.profile.keep_test_projects) {
    try {
      await removeOwnedWorkspace(workDirectory, context.state.run_id, trial.id)
    } catch {
      result.status = "failed"
      result.accepted = false
      result.failure = "unsafe_workspace_retained"
      result.cleanup = "retained_unsafe"
    }
  }
  return result
}

async function simulateTrial(trial, workDirectory, profile) {
  const interrupted = trial.case.simulation.interrupt_after_phase !== null
  const forcedFailure = trial.case.simulation.forced_gate_failures > 0
  const canRecover = trial.strategy !== "direct"
  let gateRuns = 0
  let attempts = 1
  let repairs = 0
  let recoveries = 0
  const failureEvidence = []

  const observe = (gate, code = "held_out_gate_failed") => {
    gateRuns += 1
    if (!gate.passed) failureEvidence.push({ attempt: gateRuns, code })
    return gate
  }

  if (forcedFailure) {
    const initial = observe(
      await runHeldOutGate(trial, workDirectory, profile),
      "forced_verification_failure",
    )
    if (initial.passed) {
      return {
        accepted: false,
        failure: "corpus_seed_unexpectedly_passed",
        strategyGates: strategyGateSummary(gateRuns, failureEvidence),
        attempts,
        repairs,
        recoveries,
        usage: emptyUsage(),
      }
    }
    if (!canRecover) {
      return {
        accepted: false,
        failure: "verification_failed_without_repair",
        strategyGates: strategyGateSummary(gateRuns, failureEvidence),
        attempts,
        repairs,
        recoveries,
        falseCompletion: true,
        usage: emptyUsage(),
      }
    }
    attempts += 1
    repairs += 1
  } else if (interrupted) {
    if (!canRecover) {
      observe(await runHeldOutGate(trial, workDirectory, profile), "gate_failed_after_interruption")
      return {
        accepted: false,
        failure: "interrupted_without_recovery",
        strategyGates: strategyGateSummary(gateRuns, failureEvidence),
        attempts,
        repairs,
        recoveries,
        usage: emptyUsage(),
      }
    }
    attempts += 1
    recoveries += 1
  }

  await copyTree(trial.case.solution_directory, workDirectory, { overlay: true })
  const gate = observe(await runHeldOutGate(trial, workDirectory, profile))
  return {
    accepted: gate.passed,
    failure: gate.passed ? null : "held_out_gate_failed",
    strategyGates: strategyGateSummary(gateRuns, failureEvidence),
    attempts,
    repairs,
    recoveries,
    usage: emptyUsage(),
  }
}

async function executeLiveTrial(context, trial, workDirectory, candidate) {
  const response = await context.liveRunner({
    schema_version: 1,
    strategy: trial.strategy,
    repetition: trial.repetition,
    repositoryRoot,
    runRoot: context.runDirectory,
    workspace: workDirectory,
    candidate,
    caseRecord: structuredClone(trial.case.record),
    caseDirectory: trial.case.directory,
    taskText: trial.case.task_text,
    profile: context.profile,
  })
  if (!plainObject(response)) throw new EvaluationError("LIVE_RESULT_INVALID", "the live runner returned no result")
  const usage = normalizeUsage({
    status: response.telemetry?.status ?? response.usage?.status,
    ...(plainObject(response.telemetry?.usage) ? response.telemetry.usage : response.usage),
  })
  const liveFailure = deriveLiveFailure(response, trial.strategy)
  const accepted = response.accepted === true
  return {
    accepted,
    failure: accepted ? null : safeReason(liveFailure, "live_trial_rejected"),
    strategyGates: liveStrategyGateSummary(response, trial),
    attempts: safeCount(response.attempt_count, 1),
    repairs: safeCount(response.repair_count, 0),
    recoveries: safeCount(response.recovery_count, 0),
    reviews: safeCount(response.reviews, 0),
    reviewRejections: safeCount(response.review_rejections, 0),
    falseCompletion: typeof response.false_completion === "boolean"
      ? response.false_completion
      : response.accepted === true && response.held_out_gate?.ok === false,
    unexpectedChangedFiles: safeCount(response.unexpected_changed_files, 0),
    dependencyAdditions: safeCount(response.dependency_additions, 0),
    usage,
  }
}

function strategyGateSummary(runCount, failureEvidence) {
  return {
    run_count: runCount,
    failed_count: failureEvidence.length,
    failure_evidence: failureEvidence.map((item) => ({ attempt: item.attempt, code: item.code })),
  }
}

function liveStrategyGateSummary(response, trial) {
  if (plainObject(response.strategy_gates)) return normalizeStrategyGateSummary(response.strategy_gates)
  const strategy = trial.strategy
  const repairs = safeCount(response.repair_count, 0)
  const observed = plainObject(response.held_out_gate)
  const finalFailed = observed && response.held_out_gate.ok === false
  let runCount = 0
  let failedCount = 0
  if (strategy === "direct") {
    runCount = observed ? 1 : 0
    failedCount = finalFailed ? 1 : 0
  } else if (strategy === "fresh_loop") {
    failedCount = Math.max(repairs, finalFailed ? 1 : 0)
    runCount = failedCount + (response.held_out_gate?.ok === true ? 1 : 0)
  } else {
    failedCount = repairs
    runCount = repairs + (response.receipt ? 2 : 0) + (observed ? 1 : 0)
    if (finalFailed && failedCount === 0) failedCount = 1
  }
  const code = response.held_out_gate?.forced === true || trial.case.simulation.forced_gate_failures > 0
    ? "forced_verification_failure"
    : "held_out_gate_failed"
  return strategyGateSummary(
    runCount,
    Array.from({ length: failedCount }, (_item, index) => ({ attempt: index + 1, code })),
  )
}

function normalizeStrategyGateSummary(value) {
  const runCount = safeNullableCount(value.run_count)
  const failedCount = safeNullableCount(value.failed_count)
  if (runCount !== null && failedCount !== null && failedCount > runCount) {
    throw new EvaluationError("LIVE_RESULT_INVALID", "strategy gate failures exceed strategy gate runs")
  }
  const evidence = Array.isArray(value.failure_evidence)
    ? value.failure_evidence.slice(0, 100).map((item) => ({
      attempt: safeNullableCount(item?.attempt),
      code: safeReason(item?.code, "strategy_gate_failed"),
    }))
    : []
  return { run_count: runCount, failed_count: failedCount, failure_evidence: evidence }
}

function failedStrategyOutcome(error) {
  return {
    accepted: false,
    failure: error instanceof EvaluationError ? safeReason(error.code, "evaluation_error") : "evaluation_error",
    strategyGates: { run_count: null, failed_count: null, failure_evidence: [] },
    attempts: 0,
    repairs: 0,
    recoveries: 0,
    reviews: 0,
    reviewRejections: 0,
    falseCompletion: false,
    unexpectedChangedFiles: 0,
    dependencyAdditions: 0,
    usage: emptyUsage(error?.code === "USAGE_INVALID" ? "invalid" : "unavailable"),
  }
}

function deriveLiveFailure(response, strategy) {
  if (typeof response.failure === "string") return response.failure
  if (response.interruption?.attempted && !response.interruption?.recovered) {
    return "interrupted_without_recovery"
  }
  if (response.held_out_gate?.ok === false) {
    return strategy === "direct" ? "verification_failed_without_repair" : "held_out_gate_failed"
  }
  if (typeof response.diagnostics?.[0]?.code === "string") {
    return response.diagnostics[0].code.toLocaleLowerCase("en-US")
  }
  return "live_trial_rejected"
}

function trialResult(trial, value, commonGate) {
  const commonFinalGate = {
    status: commonGate.passed ? "passed" : "failed",
    checks: commonGate.passed && Array.isArray(commonGate.checks) ? commonGate.checks : [],
    failure: commonGate.passed ? null : safeReason(commonGate.failure, "held_out_gate_failed"),
  }
  const accepted = value.accepted === true && commonFinalGate.status === "passed"
  return {
    schema_version: 1,
    trial_id: trial.id,
    case_id: trial.case.id,
    strategy: trial.strategy,
    repetition: trial.repetition,
    status: accepted ? "accepted" : "failed",
    accepted,
    failure: accepted ? null : (value.accepted ? commonFinalGate.failure : value.failure),
    attempts: value.attempts,
    repairs: value.repairs,
    recoveries: value.recoveries,
    strategy_gates: value.strategyGates,
    common_final_gate: commonFinalGate,
    reviews: value.reviews ?? (trial.strategy === "control_plane" ? (value.repairs > 0 ? 2 : 1) : 0),
    review_rejections: value.reviewRejections ?? (trial.strategy === "control_plane" && value.repairs > 0 ? 1 : 0),
    false_completion: value.falseCompletion === true ||
      value.failure === "verification_failed_without_repair" ||
      (value.accepted === true && !accepted),
    unexpected_changed_files: value.unexpectedChangedFiles ?? 0,
    dependency_additions: value.dependencyAdditions ?? 0,
    usage: value.usage,
    elapsed_ms: 0,
    cleanup: "pending",
  }
}

function failedTrialResult(trial, error) {
  return {
    schema_version: 1,
    trial_id: trial.id,
    case_id: trial.case.id,
    strategy: trial.strategy,
    repetition: trial.repetition,
    status: "failed",
    accepted: false,
    failure: error instanceof EvaluationError ? safeReason(error.code, "evaluation_error") : "evaluation_error",
    attempts: 0,
    repairs: 0,
    recoveries: 0,
    strategy_gates: { run_count: null, failed_count: null, failure_evidence: [] },
    common_final_gate: { status: "not_run", checks: [], failure: "not_completed" },
    reviews: 0,
    review_rejections: 0,
    false_completion: false,
    unexpected_changed_files: 0,
    dependency_additions: 0,
    usage: emptyUsage(error?.code === "USAGE_INVALID" ? "invalid" : "unavailable"),
    elapsed_ms: 0,
    cleanup: "pending",
  }
}

async function runHeldOutGate(trial, candidate, profile) {
  const timeoutMs = Math.min(profile.timeout_seconds * 1000, 60_000)
  const environment = { NO_COLOR: "1", OCP_EVALUATION_NO_NETWORK: "1" }
  for (const name of ["SystemRoot", "WINDIR"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      trial.case.gate_file,
      "--case",
      trial.case.id,
      "--candidate",
      candidate,
      "--json",
    ], {
      cwd: candidate,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks = []
    let bytes = 0
    let overflow = false
    let timedOut = false
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      callback()
    }
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_GATE_OUTPUT_BYTES) {
        overflow = true
        child.kill("SIGKILL")
      } else chunks.push(Buffer.from(chunk))
    })
    child.stderr.on("data", () => {})
    child.once("error", (error) => finish(() => reject(error)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.once("close", (code, signal) => finish(() => {
      clearTimeout(timer)
      if (overflow || timedOut || code !== 0 || signal !== null) {
        return resolve({ passed: false, checks: [], failure: "held_out_gate_process_failed" })
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8").trim())
        resolve({
          passed: parsed?.ok === true,
          checks: parsed?.ok === true && Array.isArray(parsed.checks)
            ? parsed.checks.filter((item) => typeof item === "string").slice(0, 32)
            : [],
        })
      } catch {
        resolve({ passed: false, checks: [], failure: "held_out_gate_output_invalid" })
      }
    }))
  })
}

async function writeReports(context, resultsMap, status, stopReason) {
  const ordered = context.trials.filter((trial) => resultsMap.has(trial.id)).map((trial) => resultsMap.get(trial.id))
  const usage = summarizedUsage(ordered)
  const budgets = evaluateBudgets(context.profile, ordered, context.state.mode)
  const report = {
    schema_version: 1,
    owner: EVALUATOR_OWNER,
    run_id: context.state.run_id,
    mode: context.state.mode,
    status,
    stop_reason: stopReason,
    profile: {
      id: context.profile.profile_id,
      model: context.profile.model,
      variant: context.profile.variant,
      repetitions: context.profile.repetitions,
    },
    hashes: {
      corpus_sha256: context.corpus.sha256,
      profile_sha256: context.state.profile_sha256,
    },
    runtime_metadata: structuredClone(context.state.runtime_metadata),
    planned_trial_count: context.trials.length,
    completed_trial_count: ordered.length,
    accepted_trial_count: ordered.filter((result) => result.accepted).length,
    failed_trial_count: ordered.filter((result) => !result.accepted).length,
    review_count: ordered.reduce((sum, result) => sum + result.reviews, 0),
    review_rejection_count: ordered.reduce((sum, result) => sum + result.review_rejections, 0),
    false_completion_count: ordered.filter((result) => result.false_completion).length,
    unexpected_changed_file_count: ordered.reduce((sum, result) => sum + result.unexpected_changed_files, 0),
    dependency_addition_count: ordered.reduce((sum, result) => sum + result.dependency_additions, 0),
    strategy_gate_run_count: sumKnown(ordered.map((result) => result.strategy_gates.run_count)),
    strategy_gate_failed_count: sumKnown(ordered.map((result) => result.strategy_gates.failed_count)),
    common_final_gate_pass_count: ordered.filter((result) => result.common_final_gate.status === "passed").length,
    common_final_gate_failed_count: ordered.filter((result) => result.common_final_gate.status === "failed").length,
    common_final_gate_not_run_count: ordered.filter((result) => result.common_final_gate.status === "not_run").length,
    elapsed_ms: ordered.every((result) => typeof result.elapsed_ms === "number")
      ? ordered.reduce((sum, result) => sum + result.elapsed_ms, 0)
      : null,
    usage,
    budgets: {
      can_start_next_trial: budgets.can_start_next_trial,
      stop_reason: budgets.stop_reason,
      checks: budgets.checks,
    },
    trials: ordered,
  }
  validateReport(report, context)
  await writeAtomicJson(path.join(context.runDirectory, "report.json"), report)
  await writeAtomicText(path.join(context.runDirectory, "report.md"), renderReportMarkdown(report))
  return report
}

function sumKnown(values) {
  return values.every((value) => Number.isSafeInteger(value))
    ? values.reduce((sum, value) => sum + value, 0)
    : null
}

function summarizedUsage(results) {
  if (results.length === 0 || results.every((result) => result.usage.status === "unavailable")) {
    return emptyUsage()
  }
  return aggregateUsage(results.map((result) => result.usage))
}

function evaluateBudgets(profile, results, mode) {
  const elapsedKnown = results.every((result) => typeof result.elapsed_ms === "number" && Number.isFinite(result.elapsed_ms))
  const elapsedMs = elapsedKnown ? results.reduce((sum, result) => sum + result.elapsed_ms, 0) : null
  const checks = []
  checks.push(budgetCheck("max_trials", profile.budgets.max_trials, results.length))
  checks.push(budgetCheck(
    "max_elapsed_minutes",
    profile.budgets.max_elapsed_minutes,
    elapsedMs === null ? null : elapsedMs / 60_000,
  ))
  for (const [budgetField, usageField] of USAGE_BUDGET_FIELDS) {
    const limit = profile.budgets[budgetField]
    const values = results.map((result) => result.usage?.[usageField])
    const known = values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    const spent = known ? values.reduce((sum, value) => sum + value, 0) : null
    checks.push(budgetCheck(budgetField, limit, spent))
  }
  let stopped = checks.find((check) => check.status === "reached")
  if (!stopped && mode === "live") {
    stopped = checks.find((check) => check.name === "max_elapsed_minutes" && check.status === "unknown" && check.limit !== null)
  }
  if (!stopped && mode === "live" && profile.require_complete_usage && results.length > 0) {
    stopped = checks.find((check) => check.status === "unknown" && check.limit !== null)
  }
  return {
    can_start_next_trial: !stopped,
    stop_reason: stopped ? `${stopped.name}:${stopped.status}` : null,
    checks,
  }
}

function budgetCheck(name, limit, spent) {
  if (limit === null) return { name, limit: null, spent, status: "disabled" }
  if (spent === null) return { name, limit, spent: null, status: "unknown" }
  return { name, limit, spent, status: spent >= limit ? "reached" : "within" }
}

export function renderReportMarkdown(report) {
  const usageRows = renderUsageColumns(report.usage)
  const failureRows = report.trials.filter((trial) => !trial.accepted)
  const lines = [
    "# OpenCode Control Plane evaluation",
    "",
    `Run: \`${markdown(report.run_id)}\``,
    `Mode: ${markdown(report.mode)}`,
    `Status: ${markdown(report.status)}`,
    "",
    "## Runtime identity",
    "",
    `OpenCode: ${report.runtime_metadata.opencode ? markdown(report.runtime_metadata.opencode.version) : "not invoked"}`,
    `Control Plane: ${markdown(report.runtime_metadata.control_plane.version)}`,
    `Control Plane source revision: \`${markdown(report.runtime_metadata.control_plane.source_revision_sha256)}\``,
    "",
    "## Outcome",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Planned trials | ${report.planned_trial_count} |`,
    `| Completed trials | ${report.completed_trial_count} |`,
    `| Accepted | ${report.accepted_trial_count} |`,
    `| Failed | ${report.failed_trial_count} |`,
    `| Reviews | ${report.review_count} |`,
    `| Review rejections | ${report.review_rejection_count} |`,
    `| False completions | ${report.false_completion_count} |`,
    `| Unexpected changed files | ${report.unexpected_changed_file_count} |`,
    `| Dependency additions | ${report.dependency_addition_count} |`,
    `| Strategy gate runs | ${display(report.strategy_gate_run_count)} |`,
    `| Strategy gate failures | ${display(report.strategy_gate_failed_count)} |`,
    `| Common final gate passes | ${report.common_final_gate_pass_count} |`,
    `| Common final gate failures | ${report.common_final_gate_failed_count} |`,
    `| Common final gate not run | ${report.common_final_gate_not_run_count} |`,
    `| Active elapsed (ms) | ${display(report.elapsed_ms)} |`,
    "",
    "## Provider-reported usage",
    "",
    `Status: ${markdown(report.usage.status)}`,
    "",
    "| Dimension | Value |",
    "| --- | ---: |",
    ...usageRows.map((row) => `| ${markdown(row.label)} | ${markdown(row.display)} |`),
    "",
    "Token dimensions remain separate; no universal token sum is synthesized.",
    "",
    "## Budget checks",
    "",
    "| Budget | Limit | Spent | Status |",
    "| --- | ---: | ---: | --- |",
    ...report.budgets.checks.map((check) => `| ${markdown(check.name)} | ${display(check.limit)} | ${display(check.spent)} | ${markdown(check.status)} |`),
    "",
    "## Trials",
    "",
    "| Case | Strategy | Rep | Outcome | Strategy gates failed/run | Common gate | Attempts | Repairs | Recoveries | Reviews/rejected | False completion | Unexpected files | Dependencies | Usage |",
    "| --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ...report.trials.map((trial) => `| ${markdown(trial.case_id)} | ${markdown(trial.strategy)} | ${trial.repetition} | ${markdown(trial.status)} | ${display(trial.strategy_gates.failed_count)}/${display(trial.strategy_gates.run_count)} | ${markdown(trial.common_final_gate.status)} | ${trial.attempts} | ${trial.repairs} | ${trial.recoveries} | ${trial.reviews}/${trial.review_rejections} | ${trial.false_completion ? "yes" : "no"} | ${trial.unexpected_changed_files} | ${trial.dependency_additions} | ${markdown(trial.usage.status)} |`),
    "",
    "## Failures",
    "",
    ...(failureRows.length
      ? failureRows.map((trial) => `- \`${markdown(trial.case_id)} / ${markdown(trial.strategy)}\`: ${markdown(trial.failure)}`)
      : ["None."]),
    "",
    "## Strategy gate failure evidence",
    "",
    ...strategyFailureLines(report.trials),
    "",
  ]
  return lines.join("\n")
}

function strategyFailureLines(trials) {
  const lines = []
  for (const trial of trials) {
    for (const evidence of trial.strategy_gates.failure_evidence) {
      lines.push(`- \`${markdown(trial.case_id)} / ${markdown(trial.strategy)} / attempt ${display(evidence.attempt)}\`: ${markdown(evidence.code)}`)
    }
  }
  return lines.length ? lines : ["None."]
}

function publicPlan(profile, corpus, trials) {
  return {
    schema_version: 1,
    mode: "plan",
    profile: {
      id: profile.profile_id,
      model: profile.model,
      variant: profile.variant,
      repetitions: profile.repetitions,
    },
    corpus_sha256: corpus.sha256,
    trial_count: trials.length,
    cases: DEFAULT_CASES.map((id) => ({ id, title: corpus.cases.get(id).title })),
    strategies: [...DEFAULT_STRATEGIES],
    budgets: profile.budgets,
    note: "Planning does not create workspaces or invoke OpenCode.",
  }
}

function buildTrials(profile, cases) {
  const trials = []
  for (let repetition = 1; repetition <= profile.repetitions; repetition += 1) {
    for (const caseId of DEFAULT_CASES) {
      for (const strategy of DEFAULT_STRATEGIES) {
        trials.push({
          id: `r${String(repetition).padStart(2, "0")}-${caseId}-${strategy.replaceAll("_", "-")}`,
          repetition,
          strategy,
          case: cases.get(caseId),
        })
      }
    }
  }
  return trials
}

async function loadCorpus(profile, evaluationRoot) {
  const root = path.resolve(evaluationRoot)
  await assertRealDirectory(root, "evaluation corpus root")
  const cases = new Map()
  const hashFiles = []
  for (const caseId of DEFAULT_CASES) {
    const directory = path.join(root, "corpus", caseId)
    if (!isWithin(root, directory)) throw new EvaluationError("CORPUS_UNSAFE", "case directory escapes the corpus")
    await assertRealDirectory(directory, `case ${caseId}`)
    const config = await readBoundedJson(path.join(directory, "case.json"), `case ${caseId}`)
    const loaded = await validateCase(config, caseId, directory, root)
    cases.set(caseId, loaded)
    hashFiles.push(...await walkSafeFiles(directory))
  }
  for (const file of new Set([...cases.values()].map((item) => item.gate_file))) hashFiles.push(file)
  const sha256 = await hashFilesDeterministically(hashFiles, root)
  return { root, cases, sha256, profile_id: profile.profile_id }
}

async function validateCase(config, caseId, directory, evaluationRoot) {
  if (!plainObject(config) || config.schema_version !== 1 || config.id !== caseId) {
    throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has an invalid identity`)
  }
  if (typeof config.title !== "string" || config.title.length < 1 || config.title.length > 200) {
    throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has an invalid title`)
  }
  for (const field of ["task_file", "seed_directory", "solution_directory"]) {
    if (!safeRelativeSegment(config[field])) throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has an invalid ${field}`)
  }
  if (!plainObject(config.simulation)) throw new EvaluationError("CORPUS_INVALID", `case ${caseId} lacks simulation metadata`)
  const forced = config.simulation.forced_gate_failures
  if (!Number.isSafeInteger(forced) || forced < 0 || forced > 3) {
    throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has invalid forced failures`)
  }
  const interrupted = config.simulation.interrupt_after_phase
  if (interrupted !== null && (typeof interrupted !== "string" || interrupted.length > 64)) {
    throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has invalid interruption metadata`)
  }
  const taskFile = containedPath(directory, config.task_file)
  const seedDirectory = containedPath(directory, config.seed_directory)
  const solutionDirectory = containedPath(directory, config.solution_directory)
  await assertSafeRegularFile(taskFile, `case ${caseId} task`)
  const taskText = await readFile(taskFile, "utf8")
  await assertRealDirectory(seedDirectory, `case ${caseId} seed`)
  await assertRealDirectory(solutionDirectory, `case ${caseId} solution`)
  const gateValue = config.verification?.gate
  if (typeof gateValue !== "string" || !gateValue.startsWith("evaluation/")) {
    throw new EvaluationError("CORPUS_INVALID", `case ${caseId} has an invalid gate`)
  }
  const gateFile = path.resolve(repositoryRoot, ...gateValue.split("/"))
  if (!isWithin(evaluationRoot, gateFile)) throw new EvaluationError("CORPUS_INVALID", "gate escapes evaluation root")
  await assertSafeRegularFile(gateFile, `case ${caseId} gate`)
  return {
    id: caseId,
    title: config.title,
    scenario: config.scenario,
    record: structuredClone(config),
    directory,
    task_file: taskFile,
    task_text: taskText,
    seed_directory: seedDirectory,
    solution_directory: solutionDirectory,
    gate_file: gateFile,
    simulation: {
      interrupt_after_phase: interrupted,
      forced_gate_failures: forced,
    },
  }
}

function normalizeProfile(value) {
  if (!plainObject(value) || value.schema_version !== 1) {
    throw new EvaluationError("PROFILE_INVALID", "evaluation profile schema_version must be 1")
  }
  const allowed = new Set([
    "schema_version", "profile_id", "model", "variant", "opencode_command",
    "provider_auth_mode", "provider_environment", "strategies", "cases", "repetitions",
    "attempt_limit", "timeout_seconds", "max_output_bytes", "keep_test_projects",
    "require_complete_usage", "budgets",
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new EvaluationError("PROFILE_INVALID", `unknown profile field: ${key}`)
  }
  if (!PROFILE_ID_PATTERN.test(value.profile_id ?? "")) {
    throw new EvaluationError("PROFILE_INVALID", "profile_id must be a short lowercase identifier")
  }
  if (!safeText(value.model, 200) || isAbsoluteAny(value.model)) {
    throw new EvaluationError("PROFILE_INVALID", "model must be one bounded provider/model identifier")
  }
  if (value.variant !== null && (!safeText(value.variant, 100) || isAbsoluteAny(value.variant))) {
    throw new EvaluationError("PROFILE_INVALID", "variant must be null or a bounded string")
  }
  if (!sameMembers(value.cases, DEFAULT_CASES)) {
    throw new EvaluationError("PROFILE_INVALID", "profile must include each bundled case exactly once")
  }
  if (!sameMembers(value.strategies, DEFAULT_STRATEGIES)) {
    throw new EvaluationError("PROFILE_INVALID", "profile must include all three strategies exactly once")
  }
  if (!Array.isArray(value.opencode_command) || value.opencode_command.length < 1 || value.opencode_command.length > 16 || value.opencode_command.some((item) => !safeText(item, 500))) {
    throw new EvaluationError("PROFILE_INVALID", "opencode_command must be a bounded argument array")
  }
  if (!Array.isArray(value.provider_environment) || value.provider_environment.some((name) => !ENVIRONMENT_NAME_PATTERN.test(name))) {
    throw new EvaluationError("PROFILE_INVALID", "provider_environment may contain environment variable names only")
  }
  if (new Set(value.provider_environment).size !== value.provider_environment.length) {
    throw new EvaluationError("PROFILE_INVALID", "provider_environment contains duplicates")
  }
  const repetitions = boundedInteger(value.repetitions, 1, 10, "repetitions")
  const attemptLimit = boundedInteger(value.attempt_limit, 1, 10, "attempt_limit")
  const timeoutSeconds = boundedInteger(value.timeout_seconds, 1, 7200, "timeout_seconds")
  const maxOutputBytes = boundedInteger(value.max_output_bytes, 1024, 64 * 1024 * 1024, "max_output_bytes")
  if (typeof value.keep_test_projects !== "boolean" || typeof value.require_complete_usage !== "boolean") {
    throw new EvaluationError("PROFILE_INVALID", "profile safety flags must be booleans")
  }
  const budgets = normalizeBudgets(value.budgets)
  return {
    schema_version: 1,
    profile_id: value.profile_id,
    model: value.model,
    variant: value.variant,
    opencode_command: [...value.opencode_command],
    provider_auth_mode: safeText(value.provider_auth_mode, 64) ? value.provider_auth_mode : "unspecified",
    provider_environment: [...value.provider_environment],
    strategies: [...DEFAULT_STRATEGIES],
    cases: [...DEFAULT_CASES],
    repetitions,
    attempt_limit: attemptLimit,
    timeout_seconds: timeoutSeconds,
    max_output_bytes: maxOutputBytes,
    keep_test_projects: value.keep_test_projects,
    require_complete_usage: value.require_complete_usage,
    budgets,
  }
}

function normalizeBudgets(value) {
  if (!plainObject(value)) throw new EvaluationError("PROFILE_INVALID", "budgets must be an object")
  const fields = [
    "max_trials", "max_elapsed_minutes", "max_provider_cost", "max_input_tokens",
    "max_output_tokens", "max_reasoning_tokens", "max_cache_read_tokens", "max_cache_write_tokens",
  ]
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new EvaluationError("PROFILE_INVALID", `unknown budget field: ${key}`)
  }
  const output = {}
  for (const field of fields) {
    const item = value[field]
    if (item === null) output[field] = null
    else if (field === "max_provider_cost" || field === "max_elapsed_minutes") {
      if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) {
        throw new EvaluationError("PROFILE_INVALID", `${field} must be positive or null`)
      }
      output[field] = item
    } else {
      if (!Number.isSafeInteger(item) || item < 1) {
        throw new EvaluationError("PROFILE_INVALID", `${field} must be a positive safe integer or null`)
      }
      output[field] = item
    }
  }
  return output
}

async function ensureEvaluationParent(value, { create }) {
  const parent = path.resolve(value)
  const temporaryRoot = path.resolve(await realpath(os.tmpdir()))
  if (pathKey(parent) === pathKey(temporaryRoot) || !isWithin(temporaryRoot, parent)) {
    throw new EvaluationError("PARENT_UNSAFE", "evaluation storage must be a child of the OS temporary directory")
  }
  let created = false
  if (create) {
    try {
      await mkdir(parent, { recursive: false, mode: 0o700 })
      created = true
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
  }
  try { await assertRealDirectory(parent, "evaluation storage") }
  catch (error) {
    if (!create && error instanceof EvaluationError && error.code === "PATH_MISSING") {
      throw new EvaluationError("RUN_NOT_FOUND", "evaluation storage does not exist")
    }
    throw error
  }
  const markerFile = path.join(parent, PARENT_MARKER_FILE)
  if (created) await writeExclusiveJson(markerFile, PARENT_MARKER)
  let marker
  try { marker = await readBoundedJson(markerFile, "evaluation parent marker") }
  catch (error) {
    if (!create && error?.code === "ENOENT") throw new EvaluationError("RUN_NOT_FOUND", "evaluation storage does not exist")
    throw new EvaluationError("PARENT_NOT_OWNED", "temporary evaluation storage lacks the fixed ownership marker")
  }
  if (canonical(marker) !== canonical(PARENT_MARKER)) {
    throw new EvaluationError("PARENT_NOT_OWNED", "temporary evaluation storage has an invalid ownership marker")
  }
  return parent
}

async function acquireRunLock(runDirectory) {
  const file = path.join(runDirectory, ".active.json")
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusiveJson(file, {
        schema_version: 1,
        owner: EVALUATOR_OWNER,
        pid: process.pid,
        token,
      })
      return async () => {
        try {
          const current = await readBoundedJson(file, "evaluation lock")
          if (current.owner === EVALUATOR_OWNER && current.token === token) await unlink(file)
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const lock = await readBoundedJson(file, "evaluation lock")
      if (lock.owner !== EVALUATOR_OWNER || !Number.isSafeInteger(lock.pid)) {
        throw new EvaluationError("RUN_LOCKED", "the evaluation run has an invalid active lock")
      }
      if (processIsAlive(lock.pid)) throw new EvaluationError("RUN_LOCKED", "the evaluation run is already active")
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
        throw new EvaluationError("RUN_LOCKED", "the stale evaluation lock is unsafe")
      }
      await unlink(file)
    }
  }
  throw new EvaluationError("RUN_LOCKED", "the evaluation run could not acquire its lock")
}

async function reconcileActiveTrial(context, results) {
  const active = context.state.active_trial
  if (active === null || active === undefined) {
    context.state.active_trial = null
    return { had_active_trial: false, unsafe_workspace: false }
  }
  if (!plainObject(active) || typeof active.trial_id !== "string") {
    throw new EvaluationError("STATE_INVALID", "the saved active trial is invalid")
  }
  const trial = context.trials.find((item) => item.id === active.trial_id)
  if (!trial) throw new EvaluationError("STATE_INVALID", "the saved active trial is not in this run")

  let cleanup = context.profile.keep_test_projects ? "retained_by_profile" : "removed"
  let unsafeWorkspace = false
  if (!context.profile.keep_test_projects) {
    try { await cleanupOrphanWorkspaces(context.runDirectory) }
    catch {
      cleanup = "retained_unsafe"
      unsafeWorkspace = true
    }
  }
  if (!results.has(trial.id)) {
    const result = interruptedMeasurementResult(trial, cleanup)
    await writeTrialResult(context.runDirectory, result, trial)
    results.set(trial.id, result)
  }
  context.state.active_trial = null
  context.state.completed_trial_ids = orderedCompletedIds(context.trials, results)
  context.state.updated_at = new Date().toISOString()
  await writeEvaluationState(context.runDirectory, context.state)
  return { had_active_trial: true, unsafe_workspace: unsafeWorkspace }
}

function interruptedMeasurementResult(trial, cleanup) {
  return {
    schema_version: 1,
    trial_id: trial.id,
    case_id: trial.case.id,
    strategy: trial.strategy,
    repetition: trial.repetition,
    status: "failed",
    accepted: false,
    failure: "measurement_incomplete_after_interruption",
    attempts: 1,
    repairs: 0,
    recoveries: 0,
    strategy_gates: { run_count: null, failed_count: null, failure_evidence: [] },
    common_final_gate: { status: "not_run", checks: [], failure: "not_completed" },
    reviews: 0,
    review_rejections: 0,
    false_completion: false,
    unexpected_changed_files: 0,
    dependency_additions: 0,
    usage: emptyUsage(),
    elapsed_ms: null,
    cleanup,
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function loadResults(runDirectory, trials) {
  const planned = new Map(trials.map((trial) => [trial.id, trial]))
  const directory = path.join(runDirectory, "results")
  await assertRealDirectory(directory, "evaluation results")
  const output = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink?.() || !entry.name.endsWith(".json")) {
      throw new EvaluationError("RESULTS_UNSAFE", "evaluation results contain an unexpected entry")
    }
    const trialId = entry.name.slice(0, -5)
    const trial = planned.get(trialId)
    if (!trial) throw new EvaluationError("RESULT_INVALID", "evaluation results contain an unknown trial")
    const result = await readBoundedJson(path.join(directory, entry.name), "trial result")
    validateTrialResult(result, trial)
    if (output.has(trialId)) throw new EvaluationError("RESULT_DUPLICATE", "evaluation results contain a duplicate trial")
    output.set(trialId, result)
  }
  return output
}

function assertCompletedReceiptsPresent(state, results) {
  for (const trialId of state.completed_trial_ids) {
    if (!results.has(trialId)) {
      throw new EvaluationError(
        "RESULT_MISSING",
        "saved state records completed work without its immutable trial receipt",
      )
    }
  }
}

async function writeTrialResult(runDirectory, result, trial) {
  validateTrialResult(result, trial)
  const file = path.join(runDirectory, "results", `${result.trial_id}.json`)
  try {
    await lstat(file)
    throw new EvaluationError("RESULT_DUPLICATE", "refusing to overwrite an existing trial result")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await writeAtomicJson(file, result, { exclusiveDestination: true })
}

function validateTrialResult(result, trial) {
  assertArtifactSafe(result, "RESULT_UNSAFE", "saved trial result")
  if (!trialResultIsValid(result, trial)) {
    throw new EvaluationError("RESULT_INVALID", "a saved trial result is invalid")
  }
}

function validateState(state, runId) {
  assertArtifactSafe(state, "STATE_UNSAFE", "saved evaluation state")
  const keys = [
    "schema_version", "owner", "run_id", "mode", "status", "created_at", "updated_at",
    "corpus_sha256", "profile_sha256", "planned_trial_count", "runtime_metadata",
    "completed_trial_ids", "active_trial", "stop_reason",
  ]
  const activeValid = state?.active_trial === null || (
    exactKeys(state.active_trial, ["trial_id", "started_at"]) &&
    validTrialId(state.active_trial.trial_id) && validIsoTimestamp(state.active_trial.started_at)
  )
  const completedValid = Array.isArray(state?.completed_trial_ids) &&
    state.completed_trial_ids.length <= state.planned_trial_count &&
    new Set(state.completed_trial_ids).size === state.completed_trial_ids.length &&
    state.completed_trial_ids.every(validTrialId)
  const statusValid = ["ready", "running", "completed", "paused", "stopped_budget", "stopped_safety"].includes(state?.status)
  const stopReasonValid = state?.stop_reason === null || (
    typeof state.stop_reason === "string" && safeReason(state.stop_reason, null) === state.stop_reason
  )
  if (
    !exactKeys(state, keys) || state.schema_version !== 1 || state.owner !== EVALUATOR_OWNER ||
    state.run_id !== runId || !RUN_ID_PATTERN.test(state.run_id) || !["simulate", "live"].includes(state.mode) ||
    !statusValid || !validIsoTimestamp(state.created_at) || !validIsoTimestamp(state.updated_at) ||
    Date.parse(state.updated_at) < Date.parse(state.created_at) ||
    !isSha256(state.corpus_sha256) || !isSha256(state.profile_sha256) ||
    !Number.isSafeInteger(state.planned_trial_count) || state.planned_trial_count < 1 || state.planned_trial_count > 300 ||
    !validRuntimeMetadata(state.runtime_metadata, state.mode) || !completedValid || !activeValid || !stopReasonValid ||
    (state.active_trial !== null && state.completed_trial_ids.includes(state.active_trial.trial_id)) ||
    (state.status === "completed" && (state.active_trial !== null || state.completed_trial_ids.length !== state.planned_trial_count)) ||
    (["ready", "completed"].includes(state.status) && state.stop_reason !== null)
  ) throw new EvaluationError("STATE_INVALID", "the saved evaluation state is invalid")
}

function validStrategyGateSummary(value) {
  if (!exactKeys(value, ["run_count", "failed_count", "failure_evidence"])) return false
  const bothUnknown = value.run_count === null && value.failed_count === null
  const bothKnown = safeMetricCount(value.run_count) && safeMetricCount(value.failed_count) &&
    value.failed_count <= value.run_count
  if ((!bothUnknown && !bothKnown) || !Array.isArray(value.failure_evidence)) return false
  if (bothUnknown) return value.failure_evidence.length === 0
  if (value.failure_evidence.length !== value.failed_count) return false
  const attempts = new Set()
  for (const item of value.failure_evidence) {
    if (!exactKeys(item, ["attempt", "code"]) || !Number.isSafeInteger(item.attempt) ||
      item.attempt < 1 || item.attempt > value.run_count || safeReason(item.code, null) !== item.code ||
      attempts.has(item.attempt)) return false
    attempts.add(item.attempt)
  }
  return true
}

function validRuntimeMetadata(value, mode) {
  return exactKeys(value, ["control_plane", "opencode"]) &&
    exactKeys(value.control_plane, ["version", "source_revision_sha256"]) &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.control_plane.version ?? "") &&
    isSha256(value.control_plane.source_revision_sha256) &&
    (mode === "live"
      ? exactKeys(value.opencode, ["version"]) && safeText(value.opencode.version, 256) &&
        !containsEmbeddedAbsolutePath(value.opencode.version)
      : value.opencode === null)
}

function trialResultIsValid(result, trial) {
  const keys = [
    "schema_version", "trial_id", "case_id", "strategy", "repetition", "status", "accepted",
    "failure", "attempts", "repairs", "recoveries", "strategy_gates", "common_final_gate",
    "reviews", "review_rejections", "false_completion", "unexpected_changed_files",
    "dependency_additions", "usage", "elapsed_ms", "cleanup",
  ]
  if (!exactKeys(result, keys) || result.schema_version !== 1 || result.trial_id !== trial.id ||
    result.case_id !== trial.case.id || result.strategy !== trial.strategy ||
    result.repetition !== trial.repetition || !["accepted", "failed"].includes(result.status) ||
    typeof result.accepted !== "boolean" || (result.accepted !== (result.status === "accepted")) ||
    (result.accepted ? result.failure !== null : (
      typeof result.failure !== "string" || safeReason(result.failure, null) !== result.failure
    )) ||
    !safeMetricCount(result.attempts) || !safeMetricCount(result.repairs) || !safeMetricCount(result.recoveries) ||
    result.repairs > result.attempts || result.recoveries > result.attempts ||
    !validStrategyGateSummary(result.strategy_gates) || !validCommonFinalGate(result.common_final_gate) ||
    !safeMetricCount(result.reviews) || !safeMetricCount(result.review_rejections) ||
    result.review_rejections > result.reviews || typeof result.false_completion !== "boolean" ||
    !safeMetricCount(result.unexpected_changed_files) || !safeMetricCount(result.dependency_additions) ||
    !validUsageRecord(result.usage) ||
    (result.elapsed_ms !== null && (!Number.isSafeInteger(result.elapsed_ms) || result.elapsed_ms < 0)) ||
    !["removed", "retained_by_profile", "retained_unsafe"].includes(result.cleanup) ||
    (result.accepted && result.common_final_gate.status !== "passed")) return false
  return true
}

function validCommonFinalGate(value) {
  if (!exactKeys(value, ["status", "checks", "failure"]) ||
    !["passed", "failed", "not_run"].includes(value.status) || !Array.isArray(value.checks) ||
    value.checks.length > 32 || value.checks.some((item) => !safeText(item, 200))) return false
  if (value.status === "passed") return value.failure === null
  return value.checks.length === 0 && typeof value.failure === "string" &&
    safeReason(value.failure, null) === value.failure
}

function validUsageRecord(value) {
  if (!exactKeys(value, ["status", ...MODEL_USAGE_FIELDS, "provider_cost"])) return false
  try { return canonical(normalizeUsage(value)) === canonical(value) }
  catch { return false }
}

async function validateSavedReportIfPresent(context) {
  const file = path.join(context.runDirectory, "report.json")
  try { await lstat(file) }
  catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  const report = await readBoundedJson(file, "saved evaluation report")
  validateReport(report, context)
}

function validateReport(report, context) {
  assertArtifactSafe(report, "REPORT_UNSAFE", "evaluation report")
  const keys = [
    "schema_version", "owner", "run_id", "mode", "status", "stop_reason", "profile", "hashes",
    "runtime_metadata", "planned_trial_count", "completed_trial_count", "accepted_trial_count",
    "failed_trial_count", "review_count", "review_rejection_count", "false_completion_count",
    "unexpected_changed_file_count", "dependency_addition_count", "strategy_gate_run_count",
    "strategy_gate_failed_count", "common_final_gate_pass_count", "common_final_gate_failed_count",
    "common_final_gate_not_run_count", "elapsed_ms", "usage", "budgets", "trials",
  ]
  if (!exactKeys(report, keys) || report.schema_version !== 1 || report.owner !== EVALUATOR_OWNER ||
    report.run_id !== context.state.run_id || report.mode !== context.state.mode ||
    !["running", "completed", "paused", "stopped_budget", "stopped_safety"].includes(report.status) ||
    (report.stop_reason !== null && (typeof report.stop_reason !== "string" || safeReason(report.stop_reason, null) !== report.stop_reason)) ||
    !exactKeys(report.profile, ["id", "model", "variant", "repetitions"]) ||
    canonical(report.profile) !== canonical({
      id: context.profile.profile_id,
      model: context.profile.model,
      variant: context.profile.variant,
      repetitions: context.profile.repetitions,
    }) || !exactKeys(report.hashes, ["corpus_sha256", "profile_sha256"]) ||
    report.hashes.corpus_sha256 !== context.state.corpus_sha256 ||
    report.hashes.profile_sha256 !== context.state.profile_sha256 ||
    canonical(report.runtime_metadata) !== canonical(context.state.runtime_metadata) ||
    report.planned_trial_count !== context.trials.length || !Array.isArray(report.trials)) {
    throw new EvaluationError("REPORT_INVALID", "the evaluation report schema is invalid")
  }

  const planned = new Map(context.trials.map((trial) => [trial.id, trial]))
  const seen = new Set()
  for (const result of report.trials) {
    const trial = planned.get(result?.trial_id)
    if (!trial || seen.has(result.trial_id) || !trialResultIsValid(result, trial)) {
      throw new EvaluationError("REPORT_INVALID", "the evaluation report contains an invalid trial")
    }
    seen.add(result.trial_id)
  }
  const accepted = report.trials.filter((item) => item.accepted).length
  const strategyRuns = sumKnown(report.trials.map((item) => item.strategy_gates.run_count))
  const strategyFailures = sumKnown(report.trials.map((item) => item.strategy_gates.failed_count))
  const elapsed = report.trials.every((item) => typeof item.elapsed_ms === "number")
    ? report.trials.reduce((sum, item) => sum + item.elapsed_ms, 0)
    : null
  const expectedCounts = {
    completed_trial_count: report.trials.length,
    accepted_trial_count: accepted,
    failed_trial_count: report.trials.length - accepted,
    review_count: report.trials.reduce((sum, item) => sum + item.reviews, 0),
    review_rejection_count: report.trials.reduce((sum, item) => sum + item.review_rejections, 0),
    false_completion_count: report.trials.filter((item) => item.false_completion).length,
    unexpected_changed_file_count: report.trials.reduce((sum, item) => sum + item.unexpected_changed_files, 0),
    dependency_addition_count: report.trials.reduce((sum, item) => sum + item.dependency_additions, 0),
    strategy_gate_run_count: strategyRuns,
    strategy_gate_failed_count: strategyFailures,
    common_final_gate_pass_count: report.trials.filter((item) => item.common_final_gate.status === "passed").length,
    common_final_gate_failed_count: report.trials.filter((item) => item.common_final_gate.status === "failed").length,
    common_final_gate_not_run_count: report.trials.filter((item) => item.common_final_gate.status === "not_run").length,
    elapsed_ms: elapsed,
  }
  if (Object.entries(expectedCounts).some(([key, value]) => report[key] !== value) ||
    !validUsageRecord(report.usage) || canonical(report.usage) !== canonical(summarizedUsage(report.trials)) ||
    !validReportBudgets(report.budgets, context.profile, report.trials, context.state.mode) ||
    (report.status === "completed" && report.trials.length !== context.trials.length) ||
    (["running", "completed"].includes(report.status) ? report.stop_reason !== null : report.stop_reason === null)) {
    throw new EvaluationError("REPORT_INVALID", "the evaluation report totals are inconsistent")
  }
}

function validReportBudgets(value, profile, results, mode) {
  if (!exactKeys(value, ["can_start_next_trial", "stop_reason", "checks"]) ||
    typeof value.can_start_next_trial !== "boolean" || !Array.isArray(value.checks)) return false
  const expected = evaluateBudgets(profile, results, mode)
  return canonical(value) === canonical({
    can_start_next_trial: expected.can_start_next_trial,
    stop_reason: expected.stop_reason,
    checks: expected.checks,
  })
}

async function cleanupOrphanWorkspaces(runDirectory) {
  const workRoot = path.join(runDirectory, "work")
  await assertRealDirectory(workRoot, "evaluation work root")
  for (const entry of await readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
      throw new EvaluationError("WORK_UNSAFE", "evaluation work root contains an unexpected entry")
    }
    const workspace = path.join(workRoot, entry.name)
    const marker = await readBoundedJson(path.join(workspace, WORK_MARKER_FILE), "workspace marker")
    if (marker.owner !== EVALUATOR_OWNER || marker.kind !== "evaluation-workspace") {
      throw new EvaluationError("WORK_UNSAFE", "an orphan workspace is not evaluator-owned")
    }
    await removeOwnedWorkspace(workspace, marker.run_id, marker.trial_id)
  }
}

async function removeOwnedWorkspace(workspace, runId, trialId) {
  const marker = await readBoundedJson(path.join(workspace, WORK_MARKER_FILE), "workspace marker")
  if (
    marker?.schema_version !== 1 || marker.owner !== EVALUATOR_OWNER ||
    marker.kind !== "evaluation-workspace" || marker.run_id !== runId || marker.trial_id !== trialId
  ) throw new EvaluationError("WORK_NOT_OWNED", "workspace cleanup requires an exact ownership marker")
  await assertLinkFreeTree(workspace)
  await rm(workspace, { recursive: true, force: false, maxRetries: 2 })
}

async function assertLinkFreeTree(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name)
      const info = await lstat(location)
      if (info.isSymbolicLink()) throw new EvaluationError("WORK_LINKED", "linked workspace entries are never removed")
      if (info.isDirectory()) await visit(location)
      else if (!info.isFile() || Number(info.nlink) !== 1) {
        throw new EvaluationError("WORK_LINKED", "non-regular or multiply-linked workspace entries are never removed")
      }
    }
  }
  await visit(root)
}

async function copyTree(source, destination, { overlay }) {
  await assertRealDirectory(source, "corpus tree")
  async function visit(currentSource, currentDestination) {
    await mkdir(currentDestination, { recursive: true, mode: 0o700 })
    const entries = await readdir(currentSource, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      const from = path.join(currentSource, entry.name)
      const to = path.join(currentDestination, entry.name)
      const info = await lstat(from)
      if (info.isSymbolicLink()) throw new EvaluationError("CORPUS_LINKED", "linked corpus entries are forbidden")
      if (info.isDirectory()) await visit(from, to)
      else if (info.isFile() && Number(info.nlink) === 1 && info.size <= MAX_CORPUS_FILE_BYTES) {
        if (!overlay) {
          try { await lstat(to); throw new EvaluationError("COPY_CONFLICT", "corpus copy would overwrite a file") }
          catch (error) { if (error?.code !== "ENOENT") throw error }
        } else {
          try {
            const target = await lstat(to)
            if (!target.isFile() || target.isSymbolicLink() || Number(target.nlink) !== 1) {
              throw new EvaluationError("COPY_UNSAFE", "corpus overlay target is unsafe")
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error
          }
        }
        await copyFile(from, to)
      } else throw new EvaluationError("CORPUS_UNSAFE", "corpus contains an unsafe or oversized entry")
    }
  }
  await visit(source, destination)
}

async function walkSafeFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      const location = path.join(directory, entry.name)
      const info = await lstat(location)
      if (info.isSymbolicLink()) throw new EvaluationError("CORPUS_LINKED", "linked corpus entries are forbidden")
      if (info.isDirectory()) await visit(location)
      else if (info.isFile() && Number(info.nlink) === 1 && info.size <= MAX_CORPUS_FILE_BYTES) files.push(location)
      else throw new EvaluationError("CORPUS_UNSAFE", "corpus contains an unsafe or oversized entry")
      if (files.length > MAX_CORPUS_FILES) throw new EvaluationError("CORPUS_TOO_LARGE", "evaluation corpus has too many files")
    }
  }
  await visit(root)
  return files
}

async function hashFilesDeterministically(files, root) {
  const unique = [...new Set(files.map((file) => path.resolve(file)))]
  unique.sort((left, right) => relative(root, left).localeCompare(relative(root, right), "en"))
  const hash = createHash("sha256")
  for (const file of unique) {
    await assertSafeRegularFile(file, "corpus file")
    hash.update(relative(root, file))
    hash.update("\0")
    hash.update(await readFile(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function controlPlaneRuntimeMetadata() {
  const packageRecord = await readBoundedJson(path.join(repositoryRoot, "package.json"), "package metadata")
  if (typeof packageRecord.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageRecord.version)) {
    throw new EvaluationError("CONTROL_PLANE_VERSION_INVALID", "Control Plane package version is invalid")
  }
  const sourceRoot = path.join(repositoryRoot, ".agents", "skills", "init-project")
  await assertRealDirectory(sourceRoot, "Control Plane source")
  const files = await walkSafeFiles(sourceRoot)
  const evaluationLibrary = path.join(repositoryRoot, "scripts", "lib")
  await assertRealDirectory(evaluationLibrary, "evaluation library")
  for (const entry of await readdir(evaluationLibrary, { withFileTypes: true })) {
    if (!/^evaluation(?:-[a-z0-9-]+)?\.mjs$/.test(entry.name)) continue
    const location = path.join(evaluationLibrary, entry.name)
    const info = await lstat(location)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new EvaluationError("CONTROL_PLANE_SOURCE_INVALID", "evaluation source must be a regular file")
    }
    files.push(location)
  }
  files.push(
    path.join(repositoryRoot, "package.json"),
    path.join(repositoryRoot, "scripts", "evaluate.mjs"),
  )
  return {
    version: packageRecord.version,
    source_revision_sha256: await hashFilesDeterministically(files, repositoryRoot),
  }
}

async function loadLiveRunner() {
  const url = new URL("./evaluation-live.mjs", import.meta.url)
  try {
    const module = await import(`${url.href}?evaluation=${Date.now()}`)
    if (typeof module.runLiveTrial !== "function" || typeof module.preflightLiveEvaluation !== "function") {
      throw new Error("missing export")
    }
    return { runTrial: module.runLiveTrial, preflight: module.preflightLiveEvaluation }
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    throw new EvaluationError(
      "LIVE_RUNNER_UNAVAILABLE",
      "live evaluation runner could not be loaded; no provider run was started",
    )
  }
}

async function preflightLiveRunner(adapter, profile) {
  try {
    const result = await adapter.preflight({ profile })
    if (result?.ok !== true || result.zero_model !== true) throw new Error("invalid preflight result")
    return { version: sanitizeVersion(result.version) }
  } catch {
    throw new EvaluationError(
      "LIVE_PREFLIGHT_FAILED",
      "live evaluation preflight failed before any provider run was created",
    )
  }
}

function sanitizeVersion(value) {
  if (typeof value !== "string") throw new EvaluationError("OPENCODE_VERSION_INVALID", "OpenCode version is unavailable")
  let output = value
  for (const local of [repositoryRoot, os.homedir(), os.tmpdir()]) {
    if (typeof local === "string" && local) output = output.replaceAll(local, "<path>")
  }
  output = output
    .replace(/[A-Za-z]:[\\/][^\s]+/g, "<path>")
    .replace(/(^|\s)\/(?!\/)[^\s]+/g, "$1<path>")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256)
  if (!output || isAbsoluteAny(output) || /(?:password|secret|api[_-]?key|access[_-]?token|bearer)/i.test(output)) {
    throw new EvaluationError("OPENCODE_VERSION_INVALID", "OpenCode returned no safe version identifier")
  }
  return output
}

function requireLiveConfirmation(value) {
  if (value !== LIVE_CONFIRMATION) {
    throw new EvaluationError(
      "LIVE_CONFIRMATION_REQUIRED",
      `live evaluation requires --confirm ${LIVE_CONFIRMATION}`,
    )
  }
}

function normalizeUsage(value) {
  if (!plainObject(value) || !["complete", "partial", "unavailable", "invalid"].includes(value.status)) {
    throw new EvaluationError("USAGE_INVALID", "live usage has an invalid status")
  }
  const output = { status: value.status }
  for (const field of [...MODEL_USAGE_FIELDS, "provider_cost"]) {
    const item = value[field]
    if (value.status === "complete") {
      const valid = field === "provider_cost"
        ? typeof item === "number" && Number.isFinite(item) && item >= 0
        : Number.isSafeInteger(item) && item >= 0
      if (!valid) throw new EvaluationError("USAGE_INVALID", `complete usage lacks ${field}`)
      output[field] = item
    } else output[field] = null
  }
  return output
}

function normalizeInvocationLimit(value) {
  if (value === Infinity) return Infinity
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvaluationError("INVOCATION_LIMIT_INVALID", "invocation trial limit must be a non-negative integer")
  }
  return value
}

function safeCount(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : fallback
}

function safeMetricCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100
}

function safeNullableCount(value) {
  return value === null || safeMetricCount(value) ? value : null
}

function safeReason(value, fallback) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value) ? value : fallback
}

function orderedCompletedIds(trials, results) {
  return trials.filter((trial) => results.has(trial.id)).map((trial) => trial.id)
}

function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new EvaluationError("RUN_ID_INVALID", "resume requires an evaluator run ID, never a path")
  }
}

async function assertRealDirectory(value, label) {
  let info
  try { info = await lstat(value) }
  catch (error) {
    if (error?.code === "ENOENT") throw new EvaluationError("PATH_MISSING", `${label} does not exist`)
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new EvaluationError("PATH_UNSAFE", `${label} must be one real directory`)
  const actual = path.resolve(await realpath(value))
  if (pathKey(actual) !== pathKey(path.resolve(value))) throw new EvaluationError("PATH_REDIRECTED", `${label} cannot be redirected`)
  return actual
}

async function assertSafeRegularFile(file, label) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > MAX_CORPUS_FILE_BYTES) {
    throw new EvaluationError("FILE_UNSAFE", `${label} must be one bounded regular file`)
  }
}

async function readBoundedJson(file, label) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > MAX_JSON_BYTES) {
    throw new EvaluationError("JSON_UNSAFE", `${label} must be one bounded regular file`)
  }
  try { return JSON.parse(await readFile(file, "utf8")) }
  catch { throw new EvaluationError("JSON_INVALID", `${label} is not valid JSON`) }
}

async function writeExclusiveJson(file, value) {
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeEvaluationState(runDirectory, state) {
  validateState(state, state.run_id)
  await writeAtomicJson(path.join(runDirectory, "state.json"), state)
}

async function writeAtomicJson(file, value, options = {}) {
  return writeAtomicText(file, `${JSON.stringify(value, null, 2)}\n`, options)
}

async function writeAtomicText(file, text, { exclusiveDestination = false } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (exclusiveDestination) {
      try { await lstat(file); throw new EvaluationError("DESTINATION_EXISTS", "atomic destination already exists") }
      catch (error) { if (error?.code !== "ENOENT") throw error }
    }
    await rename(temporary, file)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
}

function hashCanonical(value) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sameMembers(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    new Set(value).size === value.length && expected.every((item) => value.includes(item))
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvaluationError("PROFILE_INVALID", `${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function safeText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
}

function safeRelativeSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !path.isAbsolute(value) && !value.includes("..") && !/[\\/:*?"<>|]/.test(value)
}

function containedPath(root, value) {
  const output = path.resolve(root, value)
  if (!isWithin(root, output)) throw new EvaluationError("PATH_ESCAPE", "corpus path escapes its case")
  return output
}

function isWithin(parent, candidate) {
  const value = path.relative(path.resolve(parent), path.resolve(candidate))
  return value === "" || (!value.startsWith("..") && !path.isAbsolute(value))
}

function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
}

function relative(root, file) {
  const value = path.relative(root, file).split(path.sep).join("/")
  return value.startsWith("../") ? `external/${path.basename(file)}` : value
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !safeText(value, 64)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validTrialId(value) {
  return typeof value === "string" && /^r\d{2}-(?:greenfield|feature|bug-repair|external-integration|blueprint-migration|interruption-recovery|failed-verification)-(?:direct|fresh-loop|control-plane)$/.test(value)
}

function display(value) {
  return value === null || value === undefined ? "unavailable" : markdown(value)
}

function markdown(value) {
  return String(value ?? "").replace(/[\r\n|]/g, " ").slice(0, 500)
}

function assertArtifactSafe(value, code, label) {
  const pending = [value]
  const seen = new Set()
  let visited = 0
  while (pending.length) {
    const current = pending.pop()
    visited += 1
    if (visited > 20_000) throw new EvaluationError(code, `${label} is too deeply nested`)
    if (typeof current === "string") {
      if (/[\x00-\x1f\x7f-\x9f]/.test(current) || containsEmbeddedAbsolutePath(current)) {
        throw new EvaluationError(code, `${label} contains unsafe text`)
      }
      continue
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") continue
    if (!Array.isArray(current) && !plainObject(current)) {
      throw new EvaluationError(code, `${label} contains an unsupported value`)
    }
    if (seen.has(current)) throw new EvaluationError(code, `${label} contains a repeated object reference`)
    seen.add(current)
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item)
      continue
    }
    for (const [key, item] of Object.entries(current)) {
      if (/[\x00-\x1f\x7f-\x9f]/.test(key) || sensitiveArtifactKey(key) || containsEmbeddedAbsolutePath(key)) {
        throw new EvaluationError(code, `${label} contains a forbidden field`)
      }
      pending.push(item)
    }
  }
}

function sensitiveArtifactKey(value) {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "_")
  return /(?:^|_)(?:prompt|secret|password|passphrase|api_?key|access_?token|refresh_?token|authorization|credentials?|private_?key)(?:_|$)/.test(normalized)
}

function containsEmbeddedAbsolutePath(value) {
  if (typeof value !== "string") return false
  const variants = [value, value.replaceAll("\\/", "/").replace(/\\{2,}/g, "\\")]
  return variants.some((item) =>
    /(?:^|[\s"'`=(:,;\[{])file\s*:/i.test(item) || /[A-Za-z]:[\\/]/.test(item) ||
    /(?:^|[\s"'`=(:,;\[{])\\\\[^\\/\s]+[\\/]/.test(item) ||
    /(?:^|[\s"'`=(:,;\[{])\/(?!\/)(?:[^\s"'`<>|]|$)/.test(item))
}

function isAbsoluteAny(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

export const __test = Object.freeze({
  pinnedBoundaryFailure,
  runHeldOutGate,
})
