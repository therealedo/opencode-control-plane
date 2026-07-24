#!/usr/bin/env node

import {
  defaultEvaluationProfileFile,
  EvaluationError,
  LIVE_CONFIRMATION,
  planEvaluation,
  resumeEvaluation,
  startEvaluation,
} from "./lib/evaluation.mjs"

const HELP = `OpenCode Control Plane evaluation

Safe commands:
  node scripts/evaluate.mjs
  node scripts/evaluate.mjs --plan [--profile <file>] [--json]
  node scripts/evaluate.mjs --simulate [--profile <file>] [--json]
  node scripts/evaluate.mjs --resume <run-id> [--confirm ${LIVE_CONFIRMATION}] [--json]

Live provider run (uses credits):
  node scripts/evaluate.mjs --live --profile <file> --confirm ${LIVE_CONFIRMATION}

No command creates or opens an existing project. Simulation uses random,
evaluator-owned directories under the operating system temporary folder.
`

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.action === "help") {
    process.stdout.write(HELP)
  } else if (options.action === "plan") {
    const plan = await planEvaluation({ profileFile: options.profileFile })
    output(options.json, plan, renderPlan(plan))
  } else if (options.action === "simulate") {
    const report = await startEvaluation({ mode: "simulate", profileFile: options.profileFile })
    output(options.json, report, renderRun(report))
  } else if (options.action === "live") {
    const report = await startEvaluation({
      mode: "live",
      profileFile: options.profileFile,
      confirmation: options.confirmation,
    })
    output(options.json, report, renderRun(report))
  } else if (options.action === "resume") {
    const report = await resumeEvaluation(options.runId, { confirmation: options.confirmation })
    output(options.json, report, renderRun(report))
  }
} catch (error) {
  const code = error instanceof EvaluationError ? error.code : "EVALUATION_FAILED"
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${code}: ${message}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  if (argv.length === 0) return { action: "help" }
  let action = null
  let profileFile = null
  let confirmation = null
  let runId = null
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === "--help" || item === "-h") setAction("help")
    else if (item === "--plan") setAction("plan")
    else if (item === "--simulate") setAction("simulate")
    else if (item === "--live") setAction("live")
    else if (item === "--resume") {
      setAction("resume")
      if (runId !== null || !argv[index + 1]) throw new EvaluationError("ARGUMENT_INVALID", "--resume requires one run ID")
      runId = argv[++index]
    } else if (item === "--profile") {
      if (profileFile !== null || !argv[index + 1]) throw new EvaluationError("ARGUMENT_INVALID", "--profile requires one file")
      profileFile = argv[++index]
    } else if (item === "--confirm") {
      if (confirmation !== null || !argv[index + 1]) throw new EvaluationError("ARGUMENT_INVALID", "--confirm requires one exact value")
      confirmation = argv[++index]
    } else if (item === "--json") {
      if (json) throw new EvaluationError("ARGUMENT_INVALID", "--json may appear only once")
      json = true
    } else throw new EvaluationError("ARGUMENT_INVALID", `unknown argument: ${item}`)
  }
  if (!action) throw new EvaluationError("ARGUMENT_INVALID", "choose --plan, --simulate, --live, or --resume")
  if (action === "help" && (argv.length !== 1 || json || profileFile || confirmation || runId)) {
    throw new EvaluationError("ARGUMENT_INVALID", "--help cannot be combined with other arguments")
  }
  if (action === "resume") {
    if (!runId || profileFile) throw new EvaluationError("ARGUMENT_INVALID", "resume accepts a run ID, not a profile or path")
  } else if (runId) throw new EvaluationError("ARGUMENT_INVALID", "--resume cannot be combined with another mode")
  if (action === "live") {
    if (!profileFile) throw new EvaluationError("ARGUMENT_INVALID", "live evaluation requires an explicit --profile file")
    if (confirmation !== LIVE_CONFIRMATION) {
      throw new EvaluationError("LIVE_CONFIRMATION_REQUIRED", `use --confirm ${LIVE_CONFIRMATION}`)
    }
  } else if (action !== "resume" && confirmation !== null) {
    throw new EvaluationError("ARGUMENT_INVALID", "--confirm is used only for live evaluation or its resume")
  }
  return { action, profileFile: profileFile ?? defaultEvaluationProfileFile(), confirmation, runId, json }

  function setAction(value) {
    if (action !== null) throw new EvaluationError("ARGUMENT_INVALID", "choose exactly one action")
    action = value
  }
}

function output(json, value, text) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text)
}

function renderPlan(plan) {
  return [
    "Evaluation plan only — nothing was started.",
    `Cases: ${plan.cases.length}`,
    `Strategies: ${plan.strategies.join(", ")}`,
    `Trials: ${plan.trial_count}`,
    "Run deterministic local simulation with: node scripts/evaluate.mjs --simulate",
    "",
  ].join("\n")
}

function renderRun(report) {
  const resume = report.mode === "live"
    ? `node scripts/evaluate.mjs --resume ${report.run_id} --confirm ${LIVE_CONFIRMATION}`
    : `node scripts/evaluate.mjs --resume ${report.run_id}`
  return [
    `Evaluation ${report.status}.`,
    `Run ID: ${report.run_id}`,
    `Completed: ${report.completed_trial_count}/${report.planned_trial_count}`,
    `Accepted: ${report.accepted_trial_count}; failed: ${report.failed_trial_count}`,
    report.status === "completed" ? "" : `Resume: ${resume}\n`,
  ].join("\n")
}
