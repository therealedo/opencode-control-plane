import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scaffold = path.join(root, ".agents", "skills", "init-project", "bin", "scaffold.mjs")
const evolutionSource = path.join(root, ".agents", "skills", "evolve-project", "bin", "evolve-blueprint.mjs")
const fixture = path.join(root, "tests", "fixtures", "insurance-blueprint-v1.json")

function run(command, commandArgs, cwd, { expected = 0 } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 120_000,
  })
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`)
  return result
}

function nodeJson(script, scriptArgs, cwd, options) {
  const result = run(process.execPath, [script, ...scriptArgs, "--json"], cwd, options)
  return JSON.parse(result.stdout || result.stderr)
}

function git(args, cwd) {
  return run("git", args, cwd)
}

function migrationTask({ id, title, outcome, dependsOn, allowedPaths, final = false }) {
  return {
    id,
    title,
    outcome,
    acceptance_criteria: [`${outcome} is verified without regressing the provider-neutral contracts.`],
    required_evidence: ["Focused tests and the assigned deterministic gates pass."],
    non_goals: ["Unrelated authentication, database, AI pipeline, or knowledge-system changes"],
    verification_notes: ["Use isolated provider fixtures and preserve rollback behavior."],
    depends_on: dependsOn,
    priority: 100,
    context: {
      shared: ["invariants"],
      execute: ["implementation", "verification"],
      repair: ["implementation", "verification"],
      review: ["verification"],
    },
    allowed_paths: allowedPaths,
    gates: final ? ["verify", "final"] : ["verify"],
    tool_grants: { execute: [], repair: [], review: [] },
    risk: "medium",
    attempt_limit: 3,
  }
}

test("insurance copilot architecture changes create and safely activate Blueprint v2", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-evolution-insurance-"))
  try {
    nodeJson(scaffold, ["--target", target], root)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    const evolution = path.join(target, ".autopilot", "bin", "evolve-blueprint.mjs")
    const preInitialization = nodeJson(evolution, ["status", "--root", target], target)
    assert.equal(preInitialization.initialization_in_progress, true)
    assert.equal(preInitialization.legacy_adoption_required, false)
    await cp(fixture, blueprintFile, { force: true })
    await mkdir(path.join(target, "src"), { recursive: true })
    await writeFile(path.join(target, "src", "existing.txt"), "preserve-existing-application\n", "utf8")

    const renderer = path.join(target, ".autopilot", "bin", "render-blueprint.mjs")
    nodeJson(renderer, ["--target", target], target)
    const initialized = nodeJson(evolution, ["initialize", "--root", target], target)
    assert.equal(initialized.version, 1)

    git(["config", "user.name", "Autopilot Test"], target)
    git(["config", "user.email", "autopilot@example.invalid"], target)
    git(["add", "-A"], target)
    git(["commit", "-m", "initial blueprint v1"], target)

    const prepared = nodeJson(evolution, ["prepare", "--root", target], target)
    assert.equal(prepared.base_version, 1)
    const draftDirectory = path.join(target, ".autopilot", "evolution")
    const candidatePath = path.join(draftDirectory, "candidate-blueprint.json")
    const requestPath = path.join(draftDirectory, "request.json")
    const answersPath = path.join(draftDirectory, "answers.json")
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"))

    candidate.product.supported_languages = ["en", "es"]
    candidate.product.in_scope = [
      "English and Spanish user experience",
      "Zoho CRM integration",
      "Kixie calling",
    ]
    candidate.product.out_of_scope = ["Production deployment", "Twenty CRM compatibility after migration"]
    const decisions = Object.fromEntries(candidate.architecture.decisions.map((item) => [item.id, item]))
    Object.assign(decisions.localization, {
      choice: "English and Spanish",
      rationale: "Agents and customers require bilingual workflows.",
      rejected_alternatives: ["English only"],
      generated_components: ["EnglishLocaleCatalog", "SpanishLocaleCatalog"],
    })
    Object.assign(decisions["crm-provider"], {
      choice: "Zoho CRM",
      rationale: "The operating CRM is Zoho CRM.",
      rejected_alternatives: ["Twenty CRM"],
      dependencies: ["Zoho CRM API", "Zoho OAuth"],
      generated_components: ["ZohoCRMProvider", "ZohoOAuthFlow"],
      environment_variables: ["ZOHO_CRM_CLIENT_ID", "ZOHO_CRM_CLIENT_SECRET", "ZOHO_CRM_REFRESH_TOKEN"],
    })
    Object.assign(decisions["dialer-provider"], {
      choice: "Kixie",
      rationale: "The calling workflow uses Kixie.",
      rejected_alternatives: ["Generic browser audio"],
      dependencies: ["Kixie API"],
      generated_components: ["KixieDialer"],
      environment_variables: ["KIXIE_API_KEY", "KIXIE_BUSINESS_ID"],
      test_areas: ["Kixie adapter tests", "Dialer integration tests"],
    })
    candidate.tooling.environment_variables = [
      { name: "DATABASE_URL", purpose: "Connect to the isolated test database." },
      { name: "ZOHO_CRM_CLIENT_ID", purpose: "Identify the Zoho CRM test client." },
      { name: "ZOHO_CRM_CLIENT_SECRET", purpose: "Authenticate the Zoho CRM test client." },
      { name: "ZOHO_CRM_REFRESH_TOKEN", purpose: "Refresh the Zoho CRM test session." },
      { name: "KIXIE_API_KEY", purpose: "Authenticate to the Kixie test account." },
      { name: "KIXIE_BUSINESS_ID", purpose: "Select the Kixie test business." },
    ]
    candidate.roadmap.push({
      id: "M2",
      outcome: "Migrate the initialized copilot to bilingual Zoho and Kixie integrations",
      exit_signal: "Migration and final integration gates pass",
    })
    candidate.tasks.push(
      migrationTask({
        id: "M002",
        title: "Add Spanish localization",
        outcome: "Support English and Spanish with an explicit fallback",
        dependsOn: ["M001"],
        allowedPaths: ["src/i18n/**", "tests/i18n/**"],
      }),
      migrationTask({
        id: "M003",
        title: "Replace Twenty CRM with Zoho CRM",
        outcome: "Migrate the CRM adapter and authentication flow to Zoho CRM",
        dependsOn: ["M001"],
        allowedPaths: ["src/integrations/crm/**", "tests/integrations/crm/**"],
      }),
      migrationTask({
        id: "M004",
        title: "Replace browser audio with Kixie",
        outcome: "Migrate the dialer adapter to Kixie",
        dependsOn: ["M001"],
        allowedPaths: ["src/integrations/dialer/**", "tests/integrations/dialer/**"],
      }),
      migrationTask({
        id: "M005",
        title: "Verify the Blueprint v2 migration",
        outcome: "Verify bilingual, Zoho CRM, and Kixie workflows together",
        dependsOn: ["M002", "M003", "M004"],
        allowedPaths: ["src/**", "tests/**"],
        final: true,
      }),
    )
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8")
    await writeFile(requestPath, `${JSON.stringify({
      schema_version: 1,
      base_version: 1,
      summary: "Add Spanish support and migrate CRM and dialer providers",
      motivation: "The finalized assumptions did not match the required bilingual Zoho CRM and Kixie architecture.",
      requested_changes: ["English + Spanish", "Zoho CRM", "Kixie"],
    }, null, 2)}\n`, "utf8")

    const questionResult = nodeJson(evolution, ["questions", "--root", target], target)
    assert.equal(questionResult.changes.C > 0, true)
    assert.equal(questionResult.questions.some((item) => /Zoho CRM.*Twenty CRM.*adapters/.test(item.question)), true)
    assert.equal(questionResult.questions.some((item) => item.area === "Database"), false)
    const answers = Object.fromEntries(questionResult.questions.map((item) => [
      item.id,
      item.area === "Supported languages"
        ? "Keep English as fallback and migrate all user-visible catalogs to English and Spanish."
        : `${item.area}: replace the previous implementation completely while preserving the provider-neutral adapter contract.`,
    ]))
    await writeFile(answersPath, `${JSON.stringify({ schema_version: 1, answers }, null, 2)}\n`, "utf8")

    const planned = nodeJson(evolution, ["plan", "--root", target], target)
    assert.equal(planned.proposed_version, 2)
    assert.equal(planned.classification, "C")
    assert.equal(planned.compatibility, "breaking")
    assert.deepEqual(planned.added_tasks, ["M002", "M003", "M004", "M005"])

    const v2 = path.join(target, "blueprints", "v2")
    const impact = JSON.parse(await readFile(path.join(v2, "impact-report.json"), "utf8"))
    const migration = JSON.parse(await readFile(path.join(v2, "migration-plan.json"), "utf8"))
    assert.deepEqual(impact.affected.architecture_decisions, ["crm-provider", "dialer-provider", "localization"])
    assert.equal(impact.unaffected.includes("Authentication"), true)
    assert.equal(impact.unaffected.includes("Database"), true)
    assert.equal(impact.unaffected.includes("AI pipeline"), true)
    assert.equal(impact.unaffected.includes("Knowledge system"), true)
    assert.equal(migration.operations.remove.includes("TwentyCRMProvider"), true)
    assert.equal(migration.operations.create.includes("ZohoCRMProvider"), true)
    assert.equal(migration.operations.create.includes("KixieDialer"), true)
    assert.equal(migration.environment_variable_changes.remove.includes("TWENTY_CRM_TOKEN"), true)
    assert.equal(migration.environment_variable_changes.add.includes("ZOHO_CRM_CLIENT_ID"), true)

    const brief = path.join(target, ".project", "brief.md")
    const approvedBrief = await readFile(brief, "utf8")
    await writeFile(brief, `${approvedBrief}\nintervening unapproved edit\n`, "utf8")
    const blocked = run(process.execPath, [
      evolution, "apply", "--root", target, "--version", "2", "--approve", planned.approval_token, "--json",
    ], target, { expected: 1 })
    assert.match(blocked.stderr, /worktree must be clean|changed after approval preview/)
    await cp(path.join(v2, "baseline", ".project", "brief.md"), brief, { force: true })

    const applied = nodeJson(evolution, [
      "apply", "--root", target, "--version", "2", "--approve", planned.approval_token,
    ], target)
    assert.equal(applied.activated_version, 2)
    assert.equal(applied.destructive_application_changes_performed, false)
    assert.equal(await readFile(path.join(target, "src", "existing.txt"), "utf8"), "preserve-existing-application\n")

    const currentRecord = JSON.parse(await readFile(path.join(target, "blueprints", "current", "record.json"), "utf8"))
    const currentBlueprint = JSON.parse(await readFile(path.join(target, "blueprints", "current", "blueprint.json"), "utf8"))
    const queue = JSON.parse(await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8"))
    assert.equal(currentRecord.version, 2)
    assert.deepEqual(currentBlueprint.product.supported_languages, ["en", "es"])
    assert.equal(queue.tasks.M001.status, "ready")
    assert.equal(queue.tasks.M003.status, "pending")
    assert.equal(queue.tasks.M005.depends_on.includes("M003"), true)
    assert.equal(JSON.parse(await readFile(path.join(target, "blueprints", "v1", "record.json"), "utf8")).version, 1)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("a legacy initialized project is adopted as Blueprint v1 without rewriting existing files", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-evolution-adoption-"))
  try {
    nodeJson(scaffold, ["--target", target], root)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    await cp(fixture, blueprintFile, { force: true })
    await mkdir(path.join(target, "src"), { recursive: true })
    const applicationFile = path.join(target, "src", "existing.txt")
    await writeFile(applicationFile, "legacy-application-must-not-change\n", "utf8")
    const renderer = path.join(target, ".autopilot", "bin", "render-blueprint.mjs")
    nodeJson(renderer, ["--target", target], target)

    await rm(path.join(target, "blueprints"), { recursive: true, force: true })
    await rm(path.join(target, ".autopilot", "init"), { recursive: true, force: true })
    await rm(path.join(target, ".autopilot", "bin", "render-blueprint.mjs"), { force: true })
    await rm(path.join(target, ".autopilot", "bin", "evolve-blueprint.mjs"), { force: true })
    await rm(path.join(target, ".autopilot", "bin", "control-plane.mjs"), { force: true })
    await rm(path.join(target, ".autopilot", "bin", "lib", "control-plane-ui.mjs"), { force: true })
    await rm(path.join(target, ".autopilot", "control-plane.json"), { force: true })
    await rm(path.join(target, "control-plane"), { force: true })
    await rm(path.join(target, "control-plane.cmd"), { force: true })
    git(["config", "user.name", "Autopilot Test"], target)
    git(["config", "user.email", "autopilot@example.invalid"], target)
    git(["add", "-A"], target)
    git(["commit", "-m", "legacy initialized project"], target)

    const status = nodeJson(evolutionSource, ["status", "--root", target], target)
    assert.equal(status.legacy_adoption_required, true)
    const prepared = nodeJson(evolutionSource, ["adopt-prepare", "--root", target], target)
    assert.equal(prepared.generated_files_modified, false)
    await cp(fixture, path.join(target, ".autopilot", "evolution", "adoption-blueprint.json"), { force: true })

    const originalBrief = await readFile(path.join(target, ".project", "brief.md"), "utf8")
    const originalQueue = await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8")
    const planned = nodeJson(evolutionSource, ["adopt-plan", "--root", target], target)
    assert.equal(planned.proposed_version, 1)
    assert.equal(planned.generated_files_modified, false)
    const applied = nodeJson(evolutionSource, [
      "adopt-apply", "--root", target, "--approve", planned.approval_token,
    ], target)
    assert.equal(applied.adopted_version, 1)
    assert.equal(applied.existing_generated_files_modified, false)
    assert.equal(await readFile(applicationFile, "utf8"), "legacy-application-must-not-change\n")
    assert.equal(await readFile(path.join(target, ".project", "brief.md"), "utf8"), originalBrief)
    assert.equal(await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8"), originalQueue)
    const current = JSON.parse(await readFile(path.join(target, "blueprints", "current", "record.json"), "utf8"))
    assert.equal(current.version, 1)
    assert.equal(current.classification, "legacy_adoption")
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})
