#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_PROCESS_BYTES = 2 * 1024 * 1024
const DRAFT = ".autopilot/evolution"
const CURRENT = "blueprints/current"
const HISTORY = "blueprints/history.json"
const GENERATED_PATH = /^(?:\.project\/|\.autopilot\/(?:config\.json|credentials(?:\.example)?\.json)|\.env\.example$|\.gitignore$|opencode\.jsonc$)/
const LEGACY_RENDER_PATHS = [
  ".project/brief.md",
  ".project/architecture/overview.md",
  ".project/architecture/contracts.md",
  ".project/constraints.md",
  ".project/autonomy.md",
  ".project/security.md",
  ".project/quality.md",
  ".project/tooling.md",
  ".project/roadmap.md",
  ".project/manifest.json",
  ".project/gates.json",
  ".project/tools.json",
  ".project/plan/queue.json",
  ".autopilot/credentials.example.json",
  ".autopilot/credentials.json",
  ".autopilot/config.json",
  ".env.example",
  ".gitignore",
  "opencode.jsonc",
]

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root ?? process.cwd())

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${args.json ? JSON.stringify({ ok: false, error: message }) : `Blueprint evolution failed: ${message}`}\n`)
  process.exitCode = 1
})

async function main() {
  await assertRoot(root)
  let result
  if (args.command === "adopt-prepare") result = await prepareLegacyAdoption()
  else if (args.command === "adopt-plan") result = await planLegacyAdoption()
  else if (args.command === "adopt-apply") result = await applyLegacyAdoption()
  else if (args.command === "initialize") result = await initializeLifecycle()
  else if (args.command === "prepare") result = await prepareEvolution()
  else if (args.command === "questions") result = await generateQuestions()
  else if (args.command === "plan") result = await planEvolution()
  else if (args.command === "compare") result = await compareVersions()
  else if (args.command === "apply") result = await applyEvolution()
  else if (args.command === "status") result = await lifecycleStatus()
  else throw new Error(`Unknown command ${args.command}`)
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`)
}

async function initializeLifecycle() {
  const source = resolveInside(args.input ?? ".autopilot/init/blueprint.json")
  const versionDirectory = resolveInside("blueprints/v1")
  const currentDirectory = resolveInside(CURRENT)
  if (await exists(path.join(versionDirectory, "blueprint.json"))) {
    return validateLifecycle()
  }
  const blueprint = await readJson(source)
  assertBlueprintShape(blueprint)
  const canonical = jsonText(blueprint)
  const blueprintHash = digest(stableJson(blueprint))
  const initializedAt = new Date().toISOString()
  const renderManifest = await readJson(path.join(currentDirectory, "render-manifest.json"))
  if (renderManifest.blueprint_sha256 !== blueprintHash) {
    throw new Error("Rendered control plane does not match the finalized blueprint")
  }
  const record = {
    schema_version: 1,
    version: 1,
    parent_version: null,
    status: "active",
    initialized_at: initializedAt,
    activated_at: initializedAt,
    blueprint_sha256: blueprintHash,
    classification: "initial",
    compatibility: "initial",
  }
  const history = {
    schema_version: 1,
    initialized_at: initializedAt,
    current_version: 1,
    migrations: [],
  }
  const memory = projectMemory(blueprint, record, history, renderManifest)
  const stage = resolveInside(`blueprints/.v1-stage-${process.pid}-${randomBytes(5).toString("hex")}`)
  await mkdir(stage, { recursive: false })
  try {
    await Promise.all([
      writeExclusive(path.join(stage, "blueprint.json"), canonical),
      writeExclusive(path.join(stage, "record.json"), jsonText(record)),
      writeExclusive(path.join(stage, "project-memory.json"), jsonText(memory)),
    ])
    await mkdir(path.dirname(versionDirectory), { recursive: true })
    await rename(stage, versionDirectory)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  await mkdir(currentDirectory, { recursive: true })
  await atomicWrite(path.join(currentDirectory, "blueprint.json"), canonical)
  await atomicWrite(path.join(currentDirectory, "record.json"), jsonText(record))
  await atomicWrite(path.join(currentDirectory, "project-memory.json"), jsonText(memory))
  await atomicWrite(resolveInside(HISTORY), jsonText(history))
  return { ok: true, initialized: true, version: 1, blueprint_sha256: blueprintHash }
}

async function prepareLegacyAdoption() {
  await assertLegacyLifecycleMissing()
  await assertSafeBoundary({ requireCleanGit: true })
  const draft = resolveInside(DRAFT)
  if (await exists(draft)) {
    const entries = await readdir(draft)
    if (entries.length > 0) throw new Error(`Evolution draft already exists in ${DRAFT}; finish or remove it explicitly`)
  }
  await mkdir(draft, { recursive: true })
  const starter = await readJson(bundledBlueprintStarter())
  const detected = await detectInitializationTimestamp()
  const context = {
    schema_version: 1,
    initialization_timestamp: detected.timestamp,
    timestamp_source: detected.source,
    reconstruction_notes: "Reconstruct from the existing durable project files. Ask the user only when a changed-area fact cannot be recovered.",
  }
  await Promise.all([
    atomicWrite(path.join(draft, "adoption-blueprint.json"), jsonText(starter)),
    atomicWrite(path.join(draft, "adoption-context.json"), jsonText(context)),
  ])
  return {
    ok: true,
    mode: "adopt_legacy_initialized_project",
    generated_files_modified: false,
    reconstruct: `${DRAFT}/adoption-blueprint.json`,
    context: `${DRAFT}/adoption-context.json`,
    sources: [
      ".project/",
      ".autopilot/config.json",
      ".project/plan/queue.json",
      ".project/receipts/",
      ".env.example",
      "opencode.jsonc",
    ],
    next: "Reconstruct Blueprint v1 from existing project memory, then run adopt-plan. Do not restart discovery.",
  }
}

async function planLegacyAdoption() {
  await assertLegacyLifecycleMissing()
  await assertSafeBoundary({ requireCleanGit: true, allowPrefixes: [`${DRAFT}/`] })
  if (await exists(resolveInside("blueprints/v1"))) throw new Error("blueprints/v1 already exists; review or finish that adoption proposal")
  const candidatePath = args.input ?? `${DRAFT}/adoption-blueprint.json`
  const candidate = await readJson(resolveInside(candidatePath))
  const context = await readJson(resolveInside(`${DRAFT}/adoption-context.json`))
  assertBlueprintShape(candidate)
  assertAdoptionContext(context)
  const baseline = await captureLegacyBaseline(candidate)
  const baselineRelative = `${DRAFT}/adoption-baseline.json`
  const previewRelative = `${DRAFT}/adoption-render-preview.json`
  await atomicWrite(resolveInside(baselineRelative), jsonText(baseline))
  await runNode(rendererPath({ adoption: true }), [
    "--target", root,
    "--input", candidatePath,
    "--adopt",
    "--baseline", baselineRelative,
    "--preview", previewRelative,
    "--json",
  ])
  const preview = await readJson(resolveInside(previewRelative))
  const blueprintHash = digest(stableJson(candidate))
  const proposedAt = new Date().toISOString()
  const plan = {
    schema_version: 1,
    summary: "Adopt the existing initialized project as Blueprint v1",
    reason: "Add versioned project memory without rebuilding or rewriting the initialized project.",
    risk: "medium",
    existing_generated_files_modified: false,
    application_files_modified: false,
    reconstruction_review_required: true,
    initialization_timestamp: context.initialization_timestamp,
    initialization_timestamp_source: context.timestamp_source,
    current_generated_files_recorded: Object.values(baseline.files).filter((value) => value !== null).length,
    future_normalization_preview: compactPreview(preview),
    rollback_strategy: [
      "Remove only the newly added blueprint lifecycle metadata before any Blueprint v2 activation.",
      "Preserve every existing generated file, application file, receipt, task status, and Git commit.",
    ],
  }
  const approvalPayload = {
    target_version: 1,
    candidate_blueprint_sha256: blueprintHash,
    baseline_sha256: digest(stableJson(baseline)),
    plan_sha256: digest(stableJson(plan)),
  }
  const approvalToken = digest(stableJson(approvalPayload))
  plan.approval = { required: true, token: approvalToken, payload: approvalPayload }
  const record = {
    schema_version: 1,
    version: 1,
    parent_version: null,
    status: "proposed",
    proposed_at: proposedAt,
    initialized_at: context.initialization_timestamp,
    blueprint_sha256: blueprintHash,
    classification: "legacy_adoption",
    compatibility: "existing_project",
    approval_token: approvalToken,
  }
  const versionDirectory = resolveInside("blueprints/v1")
  const stage = resolveInside(`blueprints/.v1-stage-${process.pid}-${randomBytes(5).toString("hex")}`)
  await mkdir(resolveInside("blueprints"), { recursive: true })
  await mkdir(stage, { recursive: false })
  try {
    await Promise.all([
      writeExclusive(path.join(stage, "blueprint.json"), jsonText(candidate)),
      writeExclusive(path.join(stage, "adoption-context.json"), jsonText(context)),
      writeExclusive(path.join(stage, "adoption-plan.json"), jsonText(plan)),
      writeExclusive(path.join(stage, "baseline.json"), jsonText(baseline)),
      writeExclusive(path.join(stage, "generated-diff.json"), jsonText(compactPreview(preview))),
      writeExclusive(path.join(stage, "record.json"), jsonText(record)),
    ])
    await writePreviewCopies(stage, preview)
    await mkdir(path.dirname(versionDirectory), { recursive: true })
    await rename(stage, versionDirectory)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return {
    ok: true,
    proposed_version: 1,
    legacy_adoption: true,
    generated_files_modified: false,
    application_files_modified: false,
    approval_required: true,
    approval_token: approvalToken,
    review: [
      "blueprints/v1/blueprint.json",
      "blueprints/v1/adoption-plan.json",
      "blueprints/v1/generated-diff.json",
    ],
  }
}

async function applyLegacyAdoption() {
  await assertLegacyLifecycleMissing()
  await assertSafeBoundary({
    requireCleanGit: true,
    allowProposedVersion: 1,
    allowPrefixes: [`${DRAFT}/`],
  })
  const suppliedApproval = args.approve
  if (!suppliedApproval) throw new Error("adopt-apply requires --approve TOKEN from the reviewed adoption plan")
  const versionDirectory = resolveInside("blueprints/v1")
  const [candidate, proposedRecord, plan, baseline, context] = await Promise.all([
    readJson(path.join(versionDirectory, "blueprint.json")),
    readJson(path.join(versionDirectory, "record.json")),
    readJson(path.join(versionDirectory, "adoption-plan.json")),
    readJson(path.join(versionDirectory, "baseline.json")),
    readJson(path.join(versionDirectory, "adoption-context.json")),
  ])
  assertBlueprintShape(candidate)
  assertAdoptionContext(context)
  if (proposedRecord.status !== "proposed" || proposedRecord.version !== 1) throw new Error("Blueprint v1 is not an adoption proposal")
  if (proposedRecord.approval_token !== suppliedApproval || plan.approval?.token !== suppliedApproval) {
    throw new Error("Approval token does not match the reviewed adoption plan")
  }
  const { approval: _approval, ...planWithoutApproval } = plan
  const approvalPayload = {
    target_version: 1,
    candidate_blueprint_sha256: digest(stableJson(candidate)),
    baseline_sha256: digest(stableJson(baseline)),
    plan_sha256: digest(stableJson(planWithoutApproval)),
  }
  if (
    stableJson(approvalPayload) !== stableJson(plan.approval.payload) ||
    digest(stableJson(approvalPayload)) !== suppliedApproval
  ) throw new Error("Adoption proposal changed after approval token generation")
  await assertLegacyBaselineUnchanged(baseline)
  const adoptedAt = new Date().toISOString()
  const activeRecord = {
    ...proposedRecord,
    status: "active",
    approved_at: adoptedAt,
    adopted_at: adoptedAt,
    activated_at: adoptedAt,
  }
  const history = {
    schema_version: 1,
    initialized_at: context.initialization_timestamp,
    lifecycle_adopted_at: adoptedAt,
    current_version: 1,
    migrations: [],
  }
  const renderManifest = {
    schema_version: 1,
    status: "complete",
    blueprint_sha256: activeRecord.blueprint_sha256,
    outputs: Object.fromEntries(Object.entries(baseline.files).filter(([, value]) => value !== null)),
  }
  const memory = {
    ...projectMemory(candidate, activeRecord, history, renderManifest),
    lifecycle_origin: "reconstructed_from_legacy_initialized_project",
    lifecycle_adopted_at: adoptedAt,
  }
  const currentDirectory = resolveInside(CURRENT)
  const stage = resolveInside(`blueprints/.current-stage-${process.pid}-${randomBytes(5).toString("hex")}`)
  await mkdir(stage, { recursive: false })
  try {
    await Promise.all([
      writeExclusive(path.join(stage, "blueprint.json"), jsonText(candidate)),
      writeExclusive(path.join(stage, "record.json"), jsonText(activeRecord)),
      writeExclusive(path.join(stage, "project-memory.json"), jsonText(memory)),
      writeExclusive(path.join(stage, "render-manifest.json"), jsonText(renderManifest)),
    ])
    await rename(stage, currentDirectory)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  try {
    await atomicWrite(resolveInside(HISTORY), jsonText(history))
    await atomicWrite(path.join(versionDirectory, "record.json"), jsonText(activeRecord))
    await runNode(resolveInside(".autopilot/bin/validate.mjs"), ["--root", root, "--strict", "--skip-git", "--json"])
  } catch (error) {
    await rm(currentDirectory, { recursive: true, force: true })
    await rm(resolveInside(HISTORY), { force: true })
    await atomicWrite(path.join(versionDirectory, "record.json"), jsonText(proposedRecord))
    throw error
  }
  return {
    ok: true,
    adopted_version: 1,
    initialized_at: context.initialization_timestamp,
    existing_generated_files_modified: false,
    application_files_modified: false,
    validation: "passed",
    commit_required: true,
    next: "Commit the Blueprint v1 adoption metadata. Future changes can now use prepare, questions, plan, and apply.",
  }
}

async function prepareEvolution() {
  await assertSafeBoundary({ requireCleanGit: true })
  const lifecycle = await validateLifecycle()
  const draft = resolveInside(DRAFT)
  if (await exists(draft)) {
    const entries = await readdir(draft)
    if (entries.length > 0) throw new Error(`Evolution draft already exists in ${DRAFT}; finish or remove it explicitly`)
  }
  await mkdir(draft, { recursive: true })
  const blueprint = await readJson(resolveInside(`${CURRENT}/blueprint.json`))
  const baseline = await captureBaseline(lifecycle.record)
  const request = {
    schema_version: 1,
    base_version: lifecycle.record.version,
    summary: "",
    motivation: "",
    requested_changes: [],
  }
  await Promise.all([
    atomicWrite(path.join(draft, "candidate-blueprint.json"), jsonText(blueprint)),
    atomicWrite(path.join(draft, "request.json"), jsonText(request)),
    atomicWrite(path.join(draft, "answers.json"), jsonText({ schema_version: 1, answers: {} })),
    atomicWrite(path.join(draft, "baseline.json"), jsonText(baseline)),
  ])
  return {
    ok: true,
    mode: "update_existing_project",
    base_version: lifecycle.record.version,
    edit: [
      `${DRAFT}/candidate-blueprint.json`,
      `${DRAFT}/request.json`,
    ],
    next: `Run questions after recording only the requested delta`,
  }
}

async function generateQuestions() {
  await assertSafeBoundary()
  const { base, candidate, answers } = await loadDraft()
  const changes = classifyChanges(diffValues(base, candidate))
  if (changes.length === 0) throw new Error("Candidate blueprint contains no changes")
  const questions = targetedQuestions(base, candidate, changes)
  const unanswered = questions.filter((item) => !nonEmpty(answers.answers?.[item.id]))
  await atomicWrite(resolveInside(`${DRAFT}/questions.json`), jsonText({
    schema_version: 1,
    base_version: (await currentRecord()).version,
    questions,
  }))
  return { ok: true, changes: summarizeCategories(changes), questions, unanswered }
}

async function planEvolution() {
  await assertSafeBoundary({ requireCleanGit: true })
  const lifecycle = await validateLifecycle()
  const { base, candidate, request, answers } = await loadDraft()
  if (request.base_version !== lifecycle.record.version) throw new Error("Draft base version is stale")
  if (!nonEmpty(request.summary) || !nonEmpty(request.motivation)) {
    throw new Error("Change request needs a concise summary and motivation")
  }
  const changes = classifyChanges(diffValues(base, candidate))
  if (changes.length === 0) throw new Error("Candidate blueprint contains no changes")
  const questions = targetedQuestions(base, candidate, changes)
  const unanswered = questions.filter((item) => !nonEmpty(answers.answers?.[item.id]))
  if (unanswered.length > 0) throw new Error(`Answer the targeted questions first: ${unanswered.map((item) => item.id).join(", ")}`)
  const oldTasks = new Set((base.tasks ?? []).map((item) => item.id))
  const addedTasks = (candidate.tasks ?? []).filter((item) => !oldTasks.has(item.id)).map((item) => item.id)
  const categories = new Set(changes.map((item) => item.category))
  if ((categories.has("B") || categories.has("C")) && addedTasks.length === 0) {
    throw new Error("Feature or architecture evolution must append bounded implementation or migration tasks")
  }
  const previewRelative = `${DRAFT}/render-preview.json`
  await runNode(rendererPath(), [
    "--target", root,
    "--input", `${DRAFT}/candidate-blueprint.json`,
    "--evolve",
    "--baseline", `${DRAFT}/baseline.json`,
    "--preview", previewRelative,
    "--json",
  ])
  const preview = await readJson(resolveInside(previewRelative))
  const version = lifecycle.record.version + 1
  const impact = buildImpact(base, candidate, changes, preview)
  const migration = buildMigrationPlan({
    version,
    baseVersion: lifecycle.record.version,
    request,
    answers: answers.answers,
    changes,
    impact,
    preview,
    addedTasks,
  })
  const baseline = await readJson(resolveInside(`${DRAFT}/baseline.json`))
  const approvalPayload = {
    base_version: lifecycle.record.version,
    target_version: version,
    base_blueprint_sha256: lifecycle.record.blueprint_sha256,
    candidate_blueprint_sha256: digest(stableJson(candidate)),
    baseline_sha256: digest(stableJson(baseline)),
    impact_sha256: digest(stableJson(impact)),
    migration_sha256: digest(stableJson(migration)),
  }
  const approvalToken = digest(stableJson(approvalPayload))
  migration.approval = {
    required: true,
    token: approvalToken,
    payload: approvalPayload,
  }
  const versionRelative = `blueprints/v${version}`
  const versionDirectory = resolveInside(versionRelative)
  if (await exists(versionDirectory)) throw new Error(`${versionRelative} already exists; version directories are immutable`)
  const stage = resolveInside(`blueprints/.v${version}-stage-${process.pid}-${randomBytes(5).toString("hex")}`)
  await mkdir(stage, { recursive: false })
  try {
    await Promise.all([
      writeExclusive(path.join(stage, "blueprint.json"), jsonText(candidate)),
      writeExclusive(path.join(stage, "change-request.json"), jsonText(request)),
      writeExclusive(path.join(stage, "answers.json"), jsonText(answers)),
      writeExclusive(path.join(stage, "impact-report.json"), jsonText(impact)),
      writeExclusive(path.join(stage, "migration-plan.json"), jsonText(migration)),
      writeExclusive(path.join(stage, "baseline.json"), jsonText(baseline)),
      writeExclusive(path.join(stage, "generated-diff.json"), jsonText(compactPreview(preview))),
      writeExclusive(path.join(stage, "record.json"), jsonText({
        schema_version: 1,
        version,
        parent_version: lifecycle.record.version,
        status: "proposed",
        proposed_at: new Date().toISOString(),
        blueprint_sha256: approvalPayload.candidate_blueprint_sha256,
        classification: highestCategory(changes),
        compatibility: impact.compatibility,
        approval_token: approvalToken,
      })),
    ])
    await writePreviewCopies(stage, preview)
    await rename(stage, versionDirectory)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return {
    ok: true,
    proposed_version: version,
    classification: highestCategory(changes),
    compatibility: impact.compatibility,
    risk: migration.risk,
    affected: impact.affected,
    unaffected: impact.unaffected,
    added_tasks: addedTasks,
    approval_required: true,
    approval_token: approvalToken,
    review: [
      `${versionRelative}/impact-report.json`,
      `${versionRelative}/migration-plan.json`,
      `${versionRelative}/generated-diff.json`,
    ],
  }
}

async function compareVersions() {
  const from = await loadVersionSelector(args.from ?? "current")
  const to = await loadVersionSelector(args.to ?? "draft")
  const changes = classifyChanges(diffValues(from.blueprint, to.blueprint))
  return {
    ok: true,
    from: from.label,
    to: to.label,
    summary: summarizeCategories(changes),
    changes,
  }
}

async function applyEvolution() {
  await assertSafeBoundary({ requireCleanGit: true, allowProposedVersion: Number(args.version) })
  const version = positiveVersion(args.version)
  const suppliedApproval = args.approve
  if (!suppliedApproval) throw new Error("apply requires --approve TOKEN from the reviewed migration plan")
  const lifecycle = await validateLifecycle()
  const versionDirectory = resolveInside(`blueprints/v${version}`)
  const [record, plan, candidate, baseline, impact] = await Promise.all([
    readJson(path.join(versionDirectory, "record.json")),
    readJson(path.join(versionDirectory, "migration-plan.json")),
    readJson(path.join(versionDirectory, "blueprint.json")),
    readJson(path.join(versionDirectory, "baseline.json")),
    readJson(path.join(versionDirectory, "impact-report.json")),
  ])
  if (record.status !== "proposed" || record.parent_version !== lifecycle.record.version) {
    throw new Error("Proposed blueprint no longer follows the active version")
  }
  if (record.approval_token !== suppliedApproval || plan.approval?.token !== suppliedApproval) {
    throw new Error("Approval token does not match the reviewed migration plan")
  }
  assertApprovalPayload(plan, lifecycle.record, candidate, baseline, impact)
  await assertBaselineUnchanged(baseline)
  await runNode(rendererPath(), [
    "--target", root,
    "--input", `blueprints/v${version}/blueprint.json`,
    "--evolve",
    "--baseline", `blueprints/v${version}/baseline.json`,
    "--json",
  ])
  await runNode(resolveInside(".autopilot/bin/configure-tools.mjs"), ["--root", root, "--json"])
  await runNode(resolveInside(".autopilot/bin/validate.mjs"), ["--root", root, "--strict", "--skip-git", "--json"])
  const activatedAt = new Date().toISOString()
  const activeRecord = {
    ...record,
    status: "active",
    approved_at: activatedAt,
    activated_at: activatedAt,
  }
  const history = await readJson(resolveInside(HISTORY))
  history.current_version = version
  history.migrations.push({
    from_version: lifecycle.record.version,
    to_version: version,
    activated_at: activatedAt,
    classification: record.classification,
    compatibility: record.compatibility,
    risk: plan.risk,
    summary: plan.summary,
    approval_token: suppliedApproval,
  })
  const renderManifest = await readJson(resolveInside(`${CURRENT}/render-manifest.json`))
  const memory = projectMemory(candidate, activeRecord, history, renderManifest, lifecycle.memory)
  await atomicWrite(path.join(versionDirectory, "record.json"), jsonText(activeRecord))
  await atomicWrite(resolveInside(`${CURRENT}/blueprint.json`), jsonText(candidate))
  await atomicWrite(resolveInside(`${CURRENT}/record.json`), jsonText(activeRecord))
  await atomicWrite(resolveInside(`${CURRENT}/project-memory.json`), jsonText(memory))
  await atomicWrite(resolveInside(HISTORY), jsonText(history))
  return {
    ok: true,
    activated_version: version,
    migration_tasks: plan.implementation_tasks,
    destructive_application_changes_performed: false,
    validation: "passed",
    commit_required: true,
    next: "Commit the approved control-plane migration, provision any new credentials, run preflight, then resume the controller.",
  }
}

async function lifecycleStatus() {
  if (!(await exists(resolveInside(`${CURRENT}/record.json`)))) {
    if (await exists(resolveInside(".autopilot/init/blueprint.json"))) {
      return {
        ok: true,
        initialized: false,
        initialization_in_progress: true,
        legacy_adoption_required: false,
        mode: "edit_blueprint_before_initialization",
        next: "Update .autopilot/init/blueprint.json and finish /init-project; do not create a new version.",
      }
    }
    return {
      ok: true,
      initialized: false,
      legacy_adoption_required: true,
      next: "Run adopt-prepare to reconstruct Blueprint v1 from the initialized project's existing memory.",
    }
  }
  const lifecycle = await validateLifecycle()
  const versions = (await readdir(resolveInside("blueprints"), { withFileTypes: true }))
    .filter((item) => item.isDirectory() && /^v[1-9][0-9]*$/.test(item.name))
    .map((item) => Number(item.name.slice(1)))
    .sort((left, right) => left - right)
  return {
    ok: true,
    initialized: true,
    current_version: lifecycle.record.version,
    versions,
    migrations: lifecycle.history.migrations.length,
    draft: await exists(resolveInside(`${DRAFT}/candidate-blueprint.json`)),
  }
}

async function assertLegacyLifecycleMissing() {
  if (await exists(resolveInside(`${CURRENT}/record.json`))) {
    throw new Error("Blueprint lifecycle is already initialized; use prepare instead of legacy adoption")
  }
  if (await exists(resolveInside(".autopilot/init/blueprint.json"))) {
    throw new Error("Project initialization is still in progress; edit the initialization blueprint instead of adopting it")
  }
  if (await exists(resolveInside(HISTORY))) {
    throw new Error("Partial blueprint lifecycle metadata exists; inspect it before adoption")
  }
}

function assertAdoptionContext(value) {
  if (
    !isObject(value) || value.schema_version !== 1 ||
    !nonEmpty(value.initialization_timestamp) || Number.isNaN(Date.parse(value.initialization_timestamp)) ||
    !nonEmpty(value.timestamp_source)
  ) throw new Error("Adoption context needs a valid initialization timestamp and source")
}

async function detectInitializationTimestamp() {
  const result = await runProcess("git", ["log", "--reverse", "--format=%cI"], { allowFailure: true })
  const firstCommit = result.code === 0
    ? result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    : null
  if (firstCommit && !Number.isNaN(Date.parse(firstCommit))) {
    return { timestamp: new Date(firstCommit).toISOString(), source: "first_git_commit" }
  }
  const config = await stat(resolveInside(".autopilot/config.json"))
  return { timestamp: config.birthtime.toISOString(), source: "controller_config_creation_time" }
}

async function validateLifecycle() {
  const [blueprint, record, memory, history] = await Promise.all([
    readJson(resolveInside(`${CURRENT}/blueprint.json`)),
    readJson(resolveInside(`${CURRENT}/record.json`)),
    readJson(resolveInside(`${CURRENT}/project-memory.json`)),
    readJson(resolveInside(HISTORY)),
  ])
  assertBlueprintShape(blueprint)
  const expectedHash = digest(stableJson(blueprint))
  if (
    record.status !== "active" || record.version !== history.current_version ||
    record.blueprint_sha256 !== expectedHash || memory.current_blueprint_version !== record.version
  ) throw new Error("Current blueprint lifecycle records are inconsistent")
  const versionBlueprint = await readJson(resolveInside(`blueprints/v${record.version}/blueprint.json`))
  if (stableJson(versionBlueprint) !== stableJson(blueprint)) throw new Error("Current blueprint differs from its immutable version")
  return { ok: true, blueprint, record, memory, history }
}

async function loadDraft() {
  const [base, candidate, request, answers] = await Promise.all([
    readJson(resolveInside(`${CURRENT}/blueprint.json`)),
    readJson(resolveInside(`${DRAFT}/candidate-blueprint.json`)),
    readJson(resolveInside(`${DRAFT}/request.json`)),
    readJson(resolveInside(`${DRAFT}/answers.json`)),
  ])
  assertBlueprintShape(base)
  assertBlueprintShape(candidate)
  if (candidate.schema_version < base.schema_version) {
    throw new Error("Blueprint schema versions cannot move backward")
  }
  if (request.schema_version !== 1 || answers.schema_version !== 1) throw new Error("Evolution draft schemas are invalid")
  return { base, candidate, request, answers }
}

function diffValues(before, after, pointer = "") {
  if (stableJson(before) === stableJson(after)) return []
  if (isObject(before) && isObject(after)) {
    const result = []
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      result.push(...diffValues(before[key], after[key], `${pointer}/${escapePointer(key)}`))
    }
    return result
  }
  return [{
    path: pointer || "/",
    operation: before === undefined ? "add" : after === undefined ? "remove" : "replace",
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  }]
}

function classifyChanges(changes) {
  return changes.map((change) => {
    let category = "B"
    let action = "create_implementation_tasks"
    if (
      change.path === "/schema_version" ||
      change.path.startsWith("/metadata/") ||
      change.path === "/git" ||
      change.path.startsWith("/git/")
    ) {
      category = "A"
      action = "update_blueprint_metadata_only"
    } else if (
      change.path.startsWith("/product/supported_languages") ||
      change.path.startsWith("/architecture/") ||
      /^\/constraints\/(?:runtime|compatibility|compliance|prohibited_changes)/.test(change.path) ||
      /^\/(?:tooling|gates|final_gates|tools|opencode|credentials|mcp|context)\b/.test(change.path)
    ) {
      category = "C"
      action = "revise_blueprint_and_generate_migration"
    }
    const breaking = category === "C" && (
      change.operation === "remove" ||
      change.path.includes("/choice") ||
      /database|authentication|auth|provider|dialer|crm|infrastructure/i.test(`${change.path} ${stableJson(change.before)} ${stableJson(change.after)}`)
    )
    return { ...change, category, action, compatibility: breaking ? "breaking" : "non_breaking" }
  })
}

function targetedQuestions(base, candidate, changes) {
  const questions = []
  const beforeDecisions = decisionMap(base)
  const afterDecisions = decisionMap(candidate)
  for (const id of [...new Set([...beforeDecisions.keys(), ...afterDecisions.keys()])].sort()) {
    const before = beforeDecisions.get(id)
    const after = afterDecisions.get(id)
    if (!before || !after || before.choice === after.choice) continue
    questions.push({
      id: `decision-${id}-compatibility`,
      area: after.area,
      path: `/architecture/decisions/${id}/choice`,
      question: `Should ${after.choice} replace ${before.choice} completely, or should both remain supported through adapters?`,
    })
  }
  if (stableJson(base.product.supported_languages) !== stableJson(candidate.product.supported_languages)) {
    questions.push({
      id: "supported-languages-compatibility",
      area: "localization",
      path: "/product/supported_languages",
      question: "What should remain the default/fallback language, and which existing content or data must be migrated?",
    })
  }
  if (questions.length === 0 && changes.some((item) => item.category === "C")) {
    questions.push({
      id: "architecture-compatibility",
      area: "architecture",
      path: "/architecture",
      question: "What existing compatibility must be preserved while this architecture change is migrated?",
    })
  }
  return questions
}

function buildImpact(base, candidate, changes, preview) {
  const before = decisionMap(base)
  const after = decisionMap(candidate)
  const changed = []
  const unaffected = []
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(id)
    const right = after.get(id)
    if (stableJson(left) === stableJson(right)) unaffected.push(right?.area ?? left?.area ?? id)
    else changed.push({ id, before: left ?? null, after: right ?? null })
  }
  const affectedPaths = new Set(preview.changed.map((item) => item.path))
  const components = new Set()
  const removedComponents = new Set()
  const addedComponents = new Set()
  const tests = new Set()
  for (const item of changed) {
    const beforeComponents = new Set(item.before?.generated_components ?? [])
    const afterComponents = new Set(item.after?.generated_components ?? [])
    for (const value of beforeComponents) if (!afterComponents.has(value)) removedComponents.add(value)
    for (const value of afterComponents) if (!beforeComponents.has(value)) addedComponents.add(value)
    for (const decision of [item.before, item.after]) {
      if (!decision) continue
      for (const value of decision.affected_paths ?? []) affectedPaths.add(value)
      for (const value of decision.generated_components ?? []) components.add(value)
      for (const value of decision.test_areas ?? []) tests.add(value)
    }
  }
  const oldEnv = environmentNames(base)
  const newEnv = environmentNames(candidate)
  const envAdded = [...newEnv].filter((item) => !oldEnv.has(item)).sort()
  const envRemoved = [...oldEnv].filter((item) => !newEnv.has(item)).sort()
  const removed = changes.some((item) => item.operation === "remove") || envRemoved.length > 0 || preview.deleted.length > 0
  const breaking = changes.some((item) => item.compatibility === "breaking")
  return {
    schema_version: 1,
    classification: highestCategory(changes),
    compatibility: breaking ? "breaking" : "non_breaking",
    migration_required: changes.some((item) => item.category === "C") || breaking,
    affected: {
      architecture_decisions: changed.map((item) => item.id),
      files_and_modules: [...affectedPaths].sort(),
      generated_components: [...components].sort(),
      generated_component_changes: {
        remove: [...removedComponents].sort(),
        create: [...addedComponents].sort(),
      },
      environment_variables: { add: envAdded, remove: envRemoved },
      tests: [...tests].sort(),
    },
    unaffected: [...new Set(unaffected)].sort(),
    destructive_indicators: {
      removals: removed,
      generated_files_removed: preview.deleted.map((item) => item.path),
      environment_variables_removed: envRemoved,
    },
  }
}

function buildMigrationPlan({ version, baseVersion, request, answers, changes, impact, preview, addedTasks }) {
  const substantiveChanges = changes.filter((item) => item.category !== "A")
  const riskyText = `${request.summary} ${stableJson(substantiveChanges)}`
  const risk = substantiveChanges.length > 0 && (
    /database|authentication|auth|security|infrastructure|destructive/i.test(riskyText) || preview.deleted.length > 0
  )
    ? "high"
    : changes.some((item) => item.category === "C") ? "medium" : "low"
  return {
    schema_version: 1,
    from_version: baseVersion,
    to_version: version,
    summary: request.summary,
    reason: request.motivation,
    classification: highestCategory(changes),
    compatibility: impact.compatibility,
    risk,
    affected_files_and_modules: impact.affected.files_and_modules,
    database_changes_required: /database|storage|schema/i.test(riskyText)
      ? ["Database migration details must be implemented and verified by the declared migration tasks."]
      : [],
    environment_variable_changes: impact.affected.environment_variables,
    tests_required: impact.affected.tests,
    rollback_strategy: [
      `Preserve Blueprint v${baseVersion} and all accepted receipts.`,
      `Use the baseline/ and staged/ copies in blueprints/v${version} to inspect or restore generated control files.`,
      "Revert the local control-plane activation commit before migration tasks are accepted.",
      "Each application migration task remains independently reversible through its controller-owned Git commit.",
    ],
    operations: {
      remove: impact.affected.generated_component_changes.remove,
      create: impact.affected.generated_component_changes.create,
      update: impact.affected.files_and_modules,
      run: impact.affected.tests,
    },
    implementation_tasks: addedTasks,
    targeted_answers: answers,
    destructive_actions: impact.destructive_indicators,
  }
}

async function captureBaseline(record) {
  const manifest = await readJson(resolveInside(`${CURRENT}/render-manifest.json`))
  const files = {}
  for (const relative of Object.keys(manifest.outputs ?? {}).sort()) {
    if (!GENERATED_PATH.test(relative) && relative !== ".project/plan/queue.json") continue
    const file = resolveInside(relative)
    files[relative] = await exists(file) ? digest(await readFile(file)) : null
  }
  return {
    schema_version: 1,
    current_version: record.version,
    current_blueprint_sha256: record.blueprint_sha256,
    files,
  }
}

async function captureLegacyBaseline(candidate) {
  const paths = new Set(LEGACY_RENDER_PATHS)
  for (const task of candidate.tasks ?? []) paths.add(`.project/plan/milestones/${task.id}.md`)
  const milestoneDirectory = resolveInside(".project/plan/milestones")
  for (const entry of await readdir(milestoneDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(entry.name)) {
      paths.add(`.project/plan/milestones/${entry.name}`)
    }
  }
  const files = {}
  for (const relative of [...paths].sort()) {
    const file = resolveInside(relative)
    files[relative] = await exists(file) ? digest(await readFile(file)) : null
  }
  return { schema_version: 1, legacy_adoption: true, files }
}

async function assertLegacyBaselineUnchanged(baseline) {
  if (baseline.schema_version !== 1 || baseline.legacy_adoption !== true || !isObject(baseline.files)) {
    throw new Error("Legacy adoption baseline is invalid")
  }
  for (const [relative, expected] of Object.entries(baseline.files)) {
    if (!LEGACY_RENDER_PATHS.includes(relative) && !/^\.project\/plan\/milestones\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(relative)) {
      throw new Error(`Legacy adoption baseline contains unsupported path ${relative}`)
    }
    const file = resolveInside(relative)
    const actual = await exists(file) ? digest(await readFile(file)) : null
    if (actual !== expected) throw new Error(`Existing project changed after adoption review: ${relative}`)
  }
}

async function assertBaselineUnchanged(baseline) {
  const record = await currentRecord()
  if (record.version !== baseline.current_version || record.blueprint_sha256 !== baseline.current_blueprint_sha256) {
    throw new Error("Active blueprint changed after the migration plan was generated")
  }
  for (const [relative, expected] of Object.entries(baseline.files)) {
    const file = resolveInside(relative)
    const actual = await exists(file) ? digest(await readFile(file)) : null
    if (actual !== expected) throw new Error(`Generated file changed after approval preview: ${relative}`)
  }
}

async function assertSafeBoundary({ requireCleanGit = false, allowProposedVersion = null, allowPrefixes = [] } = {}) {
  const state = await readJson(resolveInside(".autopilot/state.json"))
  if (
    state.status === "running" || state.pid !== null || state.active_task !== null ||
    state.completion !== null || state.finalization !== null
  ) throw new Error("Blueprint evolution requires a stopped controller at a clean task boundary")
  for (const relative of [
    ".autopilot/runtime/candidate.json",
    ".autopilot/runtime/review.json",
    ".autopilot/runtime/mode-intent.json",
    ".autopilot/runtime/controller.lock",
    ".git/autopilot-controller.lock",
  ]) if (await exists(resolveInside(relative))) throw new Error(`Blueprint evolution is blocked by ${relative}`)
  if (requireCleanGit) {
    const status = await gitStatus()
    const prefixes = [
      ...(allowProposedVersion ? [`blueprints/v${allowProposedVersion}/`] : []),
      ...allowPrefixes,
    ]
    const unexpected = status.filter((item) => !prefixes.some((prefix) => item.path.startsWith(prefix)))
    if (unexpected.length > 0) throw new Error(`Git worktree must be clean before evolution: ${unexpected[0].path}`)
  }
}

async function gitStatus() {
  const result = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], { allowFailure: false })
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3).replaceAll("\\", "/"),
  }))
}

function assertApprovalPayload(plan, current, candidate, baseline, impact) {
  const { approval: _approval, ...planWithoutApproval } = plan
  const payload = {
    base_version: current.version,
    target_version: plan.to_version,
    base_blueprint_sha256: current.blueprint_sha256,
    candidate_blueprint_sha256: digest(stableJson(candidate)),
    baseline_sha256: digest(stableJson(baseline)),
    impact_sha256: digest(stableJson(impact)),
    migration_sha256: digest(stableJson(planWithoutApproval)),
  }
  const recorded = plan.approval?.payload
  if (stableJson(payload) !== stableJson(recorded)) throw new Error("Migration plan changed after approval token generation")
  if (digest(stableJson(recorded)) !== plan.approval.token) throw new Error("Migration approval token is invalid")
}

function projectMemory(blueprint, record, history, renderManifest, previous = null) {
  const decisions = blueprint.architecture.decisions
  return {
    schema_version: 1,
    initialized_at: previous?.initialized_at ?? record.initialized_at,
    blueprint_version_used_for_initialization: previous?.blueprint_version_used_for_initialization ?? 1,
    current_blueprint_version: record.version,
    original_requirements: previous?.original_requirements ?? {
      outcome: blueprint.product.outcome,
      primary_users: blueprint.product.primary_users,
      in_scope: blueprint.product.in_scope,
      out_of_scope: blueprint.product.out_of_scope,
      supported_languages: blueprint.product.supported_languages,
    },
    current_requirements: {
      outcome: blueprint.product.outcome,
      supported_languages: blueprint.product.supported_languages,
      in_scope: blueprint.product.in_scope,
      out_of_scope: blueprint.product.out_of_scope,
    },
    architecture_decisions: decisions,
    rejected_alternatives: Object.fromEntries(decisions.map((item) => [item.id, item.rejected_alternatives])),
    dependencies: [...new Set(decisions.flatMap((item) => item.dependencies))].sort(),
    generated_components: [...new Set(decisions.flatMap((item) => item.generated_components))].sort(),
    generated_control_files: Object.keys(renderManifest.outputs ?? {}).sort(),
    implementation_state: {
      queue: ".project/plan/queue.json",
      receipts: ".project/receipts/",
      state: ".autopilot/state.json",
    },
    migration_history: history.migrations,
  }
}

async function writePreviewCopies(stage, preview) {
  for (const item of preview.changed) {
    const relative = safeGeneratedPath(item.path)
    if (item.before !== null) await writeNested(stage, `baseline/${relative}`, item.before)
    await writeNested(stage, `staged/${relative}`, item.after)
  }
  for (const item of preview.deleted) {
    const relative = safeGeneratedPath(item.path)
    await writeNested(stage, `baseline/${relative}`, item.before)
  }
}

function compactPreview(preview) {
  return {
    schema_version: 1,
    blueprint_sha256: preview.blueprint_sha256,
    changed: preview.changed.map((item) => ({
      path: item.path,
      before_sha256: item.before_sha256,
      after_sha256: item.after_sha256,
    })),
    deleted: preview.deleted.map((item) => ({ path: item.path, before_sha256: item.before_sha256 })),
  }
}

async function loadVersionSelector(selector) {
  if (selector === "current") return { label: "current", blueprint: await readJson(resolveInside(`${CURRENT}/blueprint.json`)) }
  if (selector === "draft") return { label: "draft", blueprint: await readJson(resolveInside(`${DRAFT}/candidate-blueprint.json`)) }
  const match = /^v?([1-9][0-9]*)$/.exec(String(selector))
  if (!match) throw new Error(`Invalid blueprint selector ${selector}`)
  const version = Number(match[1])
  return { label: `v${version}`, blueprint: await readJson(resolveInside(`blueprints/v${version}/blueprint.json`)) }
}

function rendererPath({ adoption = false } = {}) {
  const local = resolveInside(".autopilot/bin/render-blueprint.mjs")
  return adoption || !existsSync(local) ? bundledRendererPath() : local
}

function bundledRendererPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "init-project", "bin", "render-blueprint.mjs")
}

function bundledBlueprintStarter() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "init-project", "assets", "project", ".autopilot", "init", "blueprint.json",
  )
}

async function currentRecord() {
  return readJson(resolveInside(`${CURRENT}/record.json`))
}

function decisionMap(blueprint) {
  return new Map((blueprint.architecture?.decisions ?? []).map((item) => [item.id, item]))
}

function environmentNames(blueprint) {
  return new Set([
    ...(blueprint.tooling?.environment_variables ?? []).map((item) => item.name),
    ...(blueprint.architecture?.decisions ?? []).flatMap((item) => item.environment_variables ?? []),
  ])
}

function summarizeCategories(changes) {
  const counts = { A: 0, B: 0, C: 0 }
  for (const item of changes) counts[item.category] += 1
  return counts
}

function highestCategory(changes) {
  if (changes.some((item) => item.category === "C")) return "C"
  if (changes.some((item) => item.category === "B")) return "B"
  return "A"
}

function assertBlueprintShape(value) {
  if (!isObject(value) || ![5, 6].includes(value.schema_version)) {
    throw new Error("Blueprint must use schema_version 5 or 6")
  }
  if (!isObject(value.metadata) || !isObject(value.product) || !isObject(value.architecture)) {
    throw new Error("Blueprint is missing product or architecture contracts")
  }
  if (!Array.isArray(value.product.supported_languages) || !Array.isArray(value.architecture.decisions)) {
    throw new Error("Blueprint is missing evolution-aware language or architecture decisions")
  }
}

function parseArgs(argv) {
  const result = {
    command: argv[0] ?? "status",
    root: undefined,
    input: undefined,
    from: undefined,
    to: undefined,
    version: undefined,
    approve: undefined,
    json: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === "--root") result.root = option(argv, ++index, item)
    else if (item === "--input") result.input = option(argv, ++index, item)
    else if (item === "--from") result.from = option(argv, ++index, item)
    else if (item === "--to") result.to = option(argv, ++index, item)
    else if (item === "--version") result.version = option(argv, ++index, item)
    else if (item === "--approve") result.approve = option(argv, ++index, item)
    else if (item === "--json") result.json = true
    else if (item === "--help") {
      process.stdout.write("Usage: evolve-blueprint.mjs <initialize|prepare|questions|plan|compare|apply|status|adopt-prepare|adopt-plan|adopt-apply> [options] [--json]\n")
      process.exit(0)
    } else throw new Error(`Unknown argument ${item}`)
  }
  return result
}

function option(argv, index, name) {
  const value = argv[index]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

async function runNode(script, scriptArgs) {
  const result = await runProcess(process.execPath, [script, ...scriptArgs], { allowFailure: true })
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${path.basename(script)} failed`)
  try { return JSON.parse(result.stdout) }
  catch { throw new Error(`${path.basename(script)} did not return JSON`) }
}

function runProcess(command, commandArgs, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    const collect = (current, chunk) => {
      const next = Buffer.concat([current, chunk])
      if (next.length > MAX_PROCESS_BYTES) child.kill()
      return next.subarray(0, MAX_PROCESS_BYTES)
    }
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk) })
    child.once("error", reject)
    child.once("close", (code) => {
      const result = { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") }
      if (!allowFailure && code !== 0) reject(new Error(result.stderr || result.stdout || `${command} failed`))
      else resolve(result)
    })
  })
}

async function assertRoot(location) {
  const info = await lstat(location)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project root must be a real directory")
  await access(path.join(location, ".autopilot", "config.json"))
}

function resolveInside(relative) {
  const normalized = String(relative).replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe project-relative path ${relative}`)
  }
  const result = path.resolve(root, ...normalized.split("/"))
  const relation = path.relative(root, result)
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Path escapes project root: ${relative}`)
  return result
}

function safeGeneratedPath(relative) {
  const normalized = String(relative).replaceAll("\\", "/")
  resolveInside(normalized)
  if (!GENERATED_PATH.test(normalized) && normalized !== "blueprints/current/render-manifest.json") {
    throw new Error(`Preview contains unsupported generated path ${relative}`)
  }
  return normalized
}

async function readJson(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new Error(`Unsafe or oversized JSON file ${file}`)
  try { return JSON.parse(await readFile(file, "utf8")) }
  catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`) }
}

async function writeNested(base, relative, content) {
  const file = path.join(base, ...relative.split("/"))
  await mkdir(path.dirname(file), { recursive: true })
  await writeExclusive(file, content)
}

async function writeExclusive(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function exists(file) {
  try { await stat(file); return true }
  catch (error) { if (error?.code === "ENOENT") return false; throw error }
}

function positiveVersion(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 2) throw new Error("--version must be an integer of at least 2")
  return number
}

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1")
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function stableJson(value) {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
