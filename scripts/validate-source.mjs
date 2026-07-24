#!/usr/bin/env node

import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  collectManagedSources,
  loadControlPlaneRelease,
} from "../.agents/skills/init-project/bin/lib/control-plane-files.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skillRoot = path.join(root, ".agents", "skills")
const assetRoot = path.join(skillRoot, "init-project", "assets", "project")
const errors = []
const warnings = []
const skillNames = new Set()
const readmePath = path.join(root, "README.md")
const securityPath = path.join(root, "docs", "security.md")
const releasePath = path.join(skillRoot, "init-project", "assets", "control-plane-release.json")
const packagePath = path.join(root, "package.json")
const evaluationRoot = path.join(root, "evaluation")
const evaluationProfilePath = path.join(evaluationRoot, "profile.example.json")
const evaluationCorpusRoot = path.join(evaluationRoot, "corpus")
const evaluationGatePath = path.join(evaluationRoot, "gates", "verify-case.mjs")

for (const directory of await readdir(skillRoot, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const skillPath = path.join(skillRoot, directory.name, "SKILL.md")
  if (!(await exists(skillPath))) {
    errors.push(`Missing SKILL.md in ${directory.name}`)
    continue
  }
  const content = await readFile(skillPath, "utf8")
  const frontmatter = parseFrontmatter(content)
  if (frontmatter.name !== directory.name) {
    errors.push(`${relative(skillPath)} name must match directory (${directory.name})`)
  }
  if (!frontmatter.description) errors.push(`${relative(skillPath)} needs a description`)
  if (skillNames.has(frontmatter.name)) errors.push(`Duplicate skill name: ${frontmatter.name}`)
  skillNames.add(frontmatter.name)
  if (/SYSTEM\.md|Section\s+[0-9]/i.test(content)) {
    errors.push(`${relative(skillPath)} contains a legacy monolith reference`)
  }
  const bytes = Buffer.byteLength(content)
  if (bytes > 4096) warnings.push(`${relative(skillPath)} is ${bytes} bytes; keep skills focused`)
}

const requiredAssets = [
  "AGENTS.md",
  "opencode.jsonc",
  ".ignore",
  ".env.example",
  ".project/brief.md",
  ".project/constraints.md",
  ".project/autonomy.md",
  ".project/security.md",
  ".project/tooling.md",
  ".project/quality.md",
  ".project/roadmap.md",
  ".project/debt.md",
  ".project/architecture/overview.md",
  ".project/architecture/contracts.md",
  ".project/decisions/README.md",
  ".project/manifest.json",
  ".project/gates.json",
  ".project/tools.json",
  ".project/plan/queue.json",
  ".project/plan/milestones/M001.md",
  ".project/receipts/README.md",
  ".project/archive/README.md",
  ".autopilot/config.json",
  ".autopilot/state.json",
  ".autopilot/credentials.example.json",
  ".autopilot/init/blueprint.json",
  ".autopilot/bin/validate.mjs",
  ".autopilot/bin/configure-tools.mjs",
  ".autopilot/bin/context-pack.mjs",
  ".autopilot/bin/run-gate.mjs",
  ".autopilot/bin/autopilot.mjs",
  ".autopilot/bin/control-plane.mjs",
  ".autopilot/bin/process-guard.mjs",
  ".autopilot/bin/windows-job-guard.ps1",
  ".autopilot/bin/opencode-tools.mjs",
  ".autopilot/bin/lib/context-pack.mjs",
  ".autopilot/bin/lib/contracts.mjs",
  ".autopilot/bin/lib/control-plane-ui.mjs",
  ".autopilot/bin/lib/controller.mjs",
  ".autopilot/bin/lib/core.mjs",
  ".autopilot/bin/lib/gate-runner.mjs",
  ".autopilot/bin/lib/git.mjs",
  ".autopilot/bin/lib/gitignore.mjs",
  ".autopilot/bin/lib/mcp.mjs",
  ".autopilot/bin/lib/opencode.mjs",
  ".autopilot/bin/lib/opencode-isolated.mjs",
  ".autopilot/bin/lib/process.mjs",
  ".autopilot/bin/lib/project.mjs",
  ".autopilot/bin/lib/secrets.mjs",
  ".autopilot/bin/lib/state.mjs",
  ".autopilot/bin/lib/tool-grants.mjs",
  ".autopilot/bin/lib/validator.mjs",
  ".opencode/agents/autopilot-worker.md",
  ".opencode/agents/autopilot-reviewer.md",
  ".opencode/agents/autopilot-recovery.md",
  ".opencode/commands/init-project.md",
  ".opencode/commands/evolve-project.md",
  ".opencode/commands/autopilot-start.md",
  ".opencode/commands/autopilot-status.md",
  ".opencode/commands/autopilot-pause.md",
  ".opencode/commands/autopilot-resume.md",
  ".opencode/commands/autopilot-stop.md",
  "control-plane",
  "control-plane.cmd",
]
for (const item of requiredAssets) {
  if (!(await exists(path.join(assetRoot, ...item.split("/"))))) errors.push(`Missing template asset: ${item}`)
}

if (!(await exists(path.join(skillRoot, "init-project", "bin", "finalize.mjs")))) {
  errors.push("Missing deterministic init finalizer: .agents/skills/init-project/bin/finalize.mjs")
}
if (!(await exists(path.join(skillRoot, "init-project", "bin", "finalize-and-launch.mjs")))) {
  errors.push("Missing deterministic init closeout: .agents/skills/init-project/bin/finalize-and-launch.mjs")
}
if (!(await exists(path.join(skillRoot, "init-project", "bin", "render-blueprint.mjs")))) {
  errors.push("Missing deterministic blueprint renderer: .agents/skills/init-project/bin/render-blueprint.mjs")
}
if (!(await exists(path.join(skillRoot, "evolve-project", "bin", "evolve-blueprint.mjs")))) {
  errors.push("Missing deterministic blueprint evolution engine: .agents/skills/evolve-project/bin/evolve-blueprint.mjs")
}
for (const required of [
  releasePath,
  path.join(skillRoot, "init-project", "bin", "control-plane-global.mjs"),
  path.join(skillRoot, "init-project", "bin", "upgrade-all-projects.mjs"),
  path.join(skillRoot, "init-project", "bin", "lib", "project-registry.mjs"),
  path.join(skillRoot, "init-project", "bin", "lib", "release-channel.mjs"),
  path.join(skillRoot, "init-project", "bin", "lib", "global-control-plane-ui.mjs"),
  path.join(skillRoot, "init-project", "bin", "lib", "directory-picker.mjs"),
  path.join(skillRoot, "init-project", "bin", "upgrade-project.mjs"),
  path.join(skillRoot, "init-project", "bin", "lib", "control-plane-files.mjs"),
  path.join(root, "scripts", "upgrade.mjs"),
]) {
  if (!(await exists(required))) errors.push(`Missing Control Plane release/upgrade source: ${relative(required)}`)
}

try {
  const release = await loadControlPlaneRelease(path.join(skillRoot, "init-project"))
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"))
  const exactDescription = "A high-efficiency, zero-token orchestrator that turns OpenCode into a policy-bounded, self-verifying coding worker."
  const exactIdentity = "a high-efficiency, zero-token orchestrator that turns OpenCode into a policy-bounded, self-verifying coding worker. Keeping it lean, fast, and terminal-native is its superpower"
  if (release.name !== "OpenCode Control Plane" || release.identity !== exactIdentity) {
    errors.push("Control Plane release manifest must preserve the exact public name and identity")
  }
  if (packageMetadata.name !== "opencode-control-plane" || packageMetadata.version !== release.version) {
    errors.push("package.json name/version must match the Control Plane release")
  }
  if (packageMetadata.description !== exactDescription) {
    errors.push("package.json description must preserve the truthful public boundary")
  }
  if (packageMetadata.repository?.url !== "git+https://github.com/therealedo/opencode-control-plane.git") {
    errors.push("package.json repository must point to the public Control Plane repository")
  }
  const managed = await collectManagedSources(path.join(skillRoot, "init-project"))
  if (managed.entries.size < 25) errors.push("Control Plane release classifies too few managed project files")
} catch (error) {
  errors.push(`Invalid Control Plane release ownership: ${error.message}`)
}

await validateEvaluationAssets()

const agentsPath = path.join(assetRoot, "AGENTS.md")
if (await exists(agentsPath)) {
  const bytes = (await stat(agentsPath)).size
  if (bytes > 2560) errors.push(`Template AGENTS.md is ${bytes} bytes; limit is 2560`)
  const content = await readFile(agentsPath, "utf8")
  if (/SYSTEM\.md/i.test(content)) errors.push("Template AGENTS.md references the retired monolith")
  if (!/autonomous packet/i.test(content) || !/do not reread state, queue, manifest/i.test(content)) {
    errors.push("Template AGENTS.md must prevent duplicate control-plane loading in autonomous packets")
  }
  if (/task spec outranks[\s\S]{0,120}security/i.test(content)) {
    errors.push("Template AGENTS.md must not let task text override security boundaries")
  }
  if (!/not an OS sandbox/i.test(content) || !/external isolation/i.test(content)) {
    errors.push("Template AGENTS.md must state the external operating-system isolation boundary")
  }
  for (const contractPath of [".autopilot/runtime/candidate.json", ".autopilot/runtime/review.json"]) {
    if (!content.includes(contractPath)) errors.push(`Template AGENTS.md must name ${contractPath}`)
  }
}

for (const file of await walkFiles(assetRoot)) {
  if (path.extname(file) !== ".json") continue
  try {
    JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    errors.push(`${relative(file)} is invalid JSON: ${error.message}`)
  }
}

const opencodePath = path.join(assetRoot, "opencode.jsonc")
if (await exists(opencodePath)) {
  try {
    const config = JSON.parse(await readFile(opencodePath, "utf8"))
    if (config.share !== "disabled") errors.push("Template OpenCode sharing must be disabled")
    if (config.default_agent !== "build") errors.push("Template default agent must remain build for initialization and manual work")
    if (config.subagent_depth !== 1) errors.push("Template subagent_depth must be 1")
    if (config.instructions) errors.push("Template must not eagerly inject modular files through instructions")
    if (config.model || config.small_model) errors.push("Template must remain model-agnostic")
    if (config.compaction?.auto !== true || config.compaction?.prune !== true) {
      errors.push("Template must keep OpenCode compaction and pruning enabled as a phase-local fallback")
    }
    if (
      Object.hasOwn(config.compaction ?? {}, "reserved") ||
      Object.hasOwn(config.compaction ?? {}, "preserve_recent_tokens")
    ) {
      errors.push("Template compaction must not contain model-size-specific token reserves")
    }
    if (Object.keys(config.compaction ?? {}).some((key) => !["auto", "prune", "tail_turns"].includes(key))) {
      errors.push("Template compaction must use only model-agnostic supported fields")
    }
    if (config.compaction?.tail_turns !== 2) {
      errors.push("Template compaction must retain exactly two recent turns")
    }
    if (config.tool_output?.max_lines !== 300 || config.tool_output?.max_bytes !== 32768) {
      errors.push("Template OpenCode tool output must remain bounded to 300 lines and 32768 bytes")
    }
  } catch (error) {
    errors.push(`Template opencode.jsonc is invalid JSONC-compatible JSON: ${error.message}`)
  }
}

const autopilotConfigPath = path.join(assetRoot, ".autopilot", "config.json")
if (await exists(autopilotConfigPath)) {
  try {
    const config = JSON.parse(await readFile(autopilotConfigPath, "utf8"))
    const expectedAgents = {
      execute: "autopilot-worker",
      repair: "autopilot-recovery",
      review: "autopilot-reviewer",
    }
    if (JSON.stringify(config.opencode?.agents) !== JSON.stringify(expectedAgents)) {
      errors.push("Template controller config must map execute, repair, and review to their primary agents")
    }
    if (Object.hasOwn(config.opencode ?? {}, "agent")) {
      errors.push("Template controller config must not contain the legacy opencode.agent setting")
    }
    if (config.opencode?.timeout_seconds !== 1800 || config.opencode?.max_output_bytes !== 2097152) {
      errors.push("Template controller config must initialize bounded OpenCode phase limits")
    }
    if (JSON.stringify(config.opencode?.credential_profiles) !== JSON.stringify({
      execute: null,
      repair: null,
      review: null,
    })) {
      errors.push("Template controller config must initialize all phase credential profiles explicitly")
    }
    if (JSON.stringify(config.git?.ephemeral_roots) !== "[]") {
      errors.push("Template controller config must initialize ephemeral roots explicitly")
    }
  } catch (error) {
    errors.push(`Template .autopilot/config.json is invalid JSON: ${error.message}`)
  }
}

const blueprintPath = path.join(assetRoot, ".autopilot", "init", "blueprint.json")
if (await exists(blueprintPath)) {
  try {
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8"))
    if (blueprint.schema_version !== 5) errors.push("Template blueprint must use schema_version 5")
    if (!Array.isArray(blueprint.product?.supported_languages)) {
      errors.push("Template blueprint must initialize supported languages")
    }
    if (!Array.isArray(blueprint.architecture?.decisions)) {
      errors.push("Template blueprint must initialize architecture decisions")
    }
    if (JSON.stringify(blueprint.opencode) !== JSON.stringify({
      model: "provider/model",
      provider_auth_mode: "none",
      provider_environment: [],
      timeout_seconds: 1800,
      max_output_bytes: 2097152,
    })) {
      errors.push("Template blueprint must initialize all configurable OpenCode runtime fields")
    }
    if (JSON.stringify(blueprint.credentials?.phase_profiles) !== JSON.stringify({
      execute: null,
      repair: null,
      review: null,
    })) {
      errors.push("Template blueprint must initialize all phase credential profiles explicitly")
    }
    if (JSON.stringify(blueprint.budgets) !== JSON.stringify({
      max_tasks_per_run: 20,
      max_attempts_per_task: 3,
      max_elapsed_minutes: 180,
      max_no_progress: 2,
    })) {
      errors.push("Template blueprint must initialize all bounded controller budgets")
    }
    if (JSON.stringify(blueprint.git) !== JSON.stringify({ commit_prefix: "autopilot" })) {
      errors.push("Template blueprint must expose only the safe Git commit prefix")
    }
    if (JSON.stringify(blueprint.tooling?.gitignore) !== "[]" || JSON.stringify(blueprint.tooling?.ephemeral) !== "[]") {
      errors.push("Template blueprint must initialize stack ignores and ephemeral roots explicitly")
    }
    if (blueprint.gates?.verify?.feedback !== true || blueprint.gates?.final?.feedback !== false) {
      errors.push("Template blueprint must expose only the ordinary verification gate for same-session feedback")
    }
  } catch (error) {
    errors.push(`Template blueprint is invalid JSON: ${error.message}`)
  }
}

const gatesTemplatePath = path.join(assetRoot, ".project", "gates.json")
if (await exists(gatesTemplatePath)) {
  try {
    const gates = JSON.parse(await readFile(gatesTemplatePath, "utf8"))
    if (gates.schema_version !== 2) errors.push("Template gates contract must use schema_version 2")
  } catch (error) {
    errors.push(`Template .project/gates.json is invalid JSON: ${error.message}`)
  }
}

const roleContracts = {
  "autopilot-worker.md": [
    "mode: primary",
    "steps: 32",
    '"*": deny',
    "# BEGIN AUTOPILOT MANAGED TOOL GRANTS",
    "autopilot_read: allow",
    "autopilot_list: allow",
    "autopilot_search: allow",
    "autopilot_write: allow",
    "autopilot_edit: allow",
    "autopilot_mutate: allow",
    "autopilot_check: deny",
    "autopilot_contract: allow",
    "read: deny",
    "edit: deny",
    "write: deny",
    "patch: deny",
    "apply_patch: deny",
    "glob: deny",
    "grep: deny",
    "list: deny",
    "lsp: deny",
    "bash: deny",
    "task: deny",
    "skill: deny",
    "question: deny",
    "webfetch: deny",
    "external_directory: deny",
    "autopilot_contract",
  ],
  "autopilot-recovery.md": [
    "mode: primary",
    "steps: 24",
    '"*": deny',
    "# BEGIN AUTOPILOT MANAGED TOOL GRANTS",
    "autopilot_read: allow",
    "autopilot_list: allow",
    "autopilot_search: allow",
    "autopilot_write: allow",
    "autopilot_edit: allow",
    "autopilot_mutate: allow",
    "autopilot_check: deny",
    "autopilot_contract: allow",
    "read: deny",
    "edit: deny",
    "write: deny",
    "patch: deny",
    "apply_patch: deny",
    "glob: deny",
    "grep: deny",
    "list: deny",
    "lsp: deny",
    "bash: deny",
    "task: deny",
    "skill: deny",
    "question: deny",
    "webfetch: deny",
    "external_directory: deny",
    "autopilot_contract",
  ],
  "autopilot-reviewer.md": [
    "mode: primary",
    "steps: 16",
    '"*": deny',
    "# BEGIN AUTOPILOT MANAGED TOOL GRANTS",
    "autopilot_read: allow",
    "autopilot_list: allow",
    "autopilot_search: allow",
    "autopilot_mutate: deny",
    "autopilot_check: deny",
    "autopilot_contract: allow",
    "read: deny",
    "edit: deny",
    "write: deny",
    "patch: deny",
    "apply_patch: deny",
    "glob: deny",
    "grep: deny",
    "list: deny",
    "lsp: deny",
    "bash: deny",
    "task: deny",
    "skill: deny",
    "question: deny",
    "webfetch: deny",
    "external_directory: deny",
    "autopilot_contract",
  ],
}
const forbiddenRoleText = {
  "autopilot-reviewer.md": ["autopilot_write: allow", "autopilot_edit: allow", "autopilot_mutate: allow", "autopilot_check: allow"],
}
for (const [name, requiredText] of Object.entries(roleContracts)) {
  const file = path.join(assetRoot, ".opencode", "agents", name)
  if (!(await exists(file))) continue
  const content = await readFile(file, "utf8")
  for (const expected of requiredText) {
    if (!content.includes(expected)) errors.push(`${relative(file)} must contain ${expected}`)
  }
  for (const forbidden of forbiddenRoleText[name] ?? []) {
    if (content.includes(forbidden)) errors.push(`${relative(file)} must not contain ${forbidden}`)
  }
}

const toolConfiguratorPath = path.join(assetRoot, ".autopilot", "bin", "configure-tools.mjs")
if (await exists(toolConfiguratorPath)) {
  const checked = spawnSync(
    process.execPath,
    [toolConfiguratorPath, "--root", assetRoot, "--check", "--json"],
    { cwd: root, encoding: "utf8", windowsHide: true, shell: false },
  )
  if (checked.status !== 0) {
    errors.push(`Template role-tool grants are invalid or out of sync: ${(checked.stdout || checked.stderr).trim()}`)
  }
}

const commandContracts = {
  "autopilot-start.md": "node .autopilot/bin/autopilot.mjs start --detach",
  "autopilot-status.md": "node .autopilot/bin/autopilot.mjs status",
  "autopilot-pause.md": "node .autopilot/bin/autopilot.mjs pause",
  "autopilot-resume.md": "node .autopilot/bin/autopilot.mjs resume --detach",
  "autopilot-stop.md": "node .autopilot/bin/autopilot.mjs stop",
}
for (const [name, command] of Object.entries(commandContracts)) {
  const file = path.join(assetRoot, ".opencode", "commands", name)
  if ((await exists(file)) && !(await readFile(file, "utf8")).includes(command)) {
    errors.push(`${relative(file)} must invoke exactly ${command}`)
  }
}

for (const file of await walkFiles(root)) {
  if (path.extname(file) !== ".mjs") continue
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true })
  if (checked.status !== 0) errors.push(`${relative(file)} syntax error: ${checked.stderr.trim()}`)
}

if (!(await exists(readmePath))) {
  errors.push("Missing README.md")
} else {
  const readme = await readFile(readmePath, "utf8")
  if (Buffer.byteLength(readme) > 12 * 1024) errors.push("README.md exceeds the 12 KiB beginner-guide cap")
  for (const required of [
    "# OpenCode Control Plane",
    "a high-efficiency, zero-token orchestrator that turns OpenCode into a policy-bounded, self-verifying coding worker. Keeping it lean, fast, and terminal-native is its superpower",
    "https://github.com/therealedo/opencode-control-plane.git",
    "npm run setup",
    "npm run upgrade",
    "`control-plane`",
    "./control-plane",
    "Change product blueprint",
    "Update everything",
    "Worker reasoning",
    "Start worker",
    "GitHub Release",
  ]) {
    if (!readme.includes(required)) errors.push(`README.md is missing beginner contract text: ${required}`)
  }
}

if (!(await exists(securityPath))) {
  errors.push("Missing docs/security.md")
} else {
  const security = await readFile(securityPath, "utf8")
  for (const required of ["application-level policy boundary", "not an operating-system sandbox"]) {
    if (!security.includes(required)) errors.push(`docs/security.md must state ${required}`)
  }
}

for (const document of ["architecture.md", "blueprints.md", "security.md", "maintenance.md"]) {
  const file = path.join(root, "docs", document)
  if (!(await exists(file))) errors.push(`Missing optional maintainer reference: docs/${document}`)
}

if (await exists(path.join(assetRoot, ".autopilot", "bin", "validate.mjs"))) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autopilot-source-check-"))
  try {
    const scaffold = spawnSync(
      process.execPath,
      [path.join(skillRoot, "init-project", "bin", "scaffold.mjs"), "--target", temporary, "--no-git", "--json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
    if (scaffold.status !== 0) errors.push(`Template scaffold failed: ${scaffold.stderr.trim()}`)
    else {
      try {
        const installed = JSON.parse(await readFile(path.join(temporary, ".autopilot", "control-plane.json"), "utf8"))
        const release = JSON.parse(await readFile(releasePath, "utf8"))
        if (installed.product_id !== release.product_id || installed.version !== release.version) {
          errors.push("Scaffolded project Control Plane manifest does not match the release")
        }
      } catch (error) {
        errors.push(`Scaffolded project has invalid Control Plane ownership: ${error.message}`)
      }
      const validation = spawnSync(
        process.execPath,
        [path.join(temporary, ".autopilot", "bin", "validate.mjs")],
        { cwd: temporary, encoding: "utf8", windowsHide: true },
      )
      if (validation.status !== 0) {
        errors.push(`Scaffolded template validation failed: ${validation.stdout.trim()} ${validation.stderr.trim()}`)
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const output = {
  ok: errors.length === 0,
  skills: skillNames.size,
  errors,
  warnings,
}
console.log(JSON.stringify(output, null, 2))
if (errors.length > 0) process.exitCode = 1

async function validateEvaluationAssets() {
  const requiredCases = new Map([
    ["greenfield", "greenfield"],
    ["feature", "feature"],
    ["bug-repair", "bug_repair"],
    ["external-integration", "external_integration"],
    ["blueprint-migration", "blueprint_migration"],
    ["interruption-recovery", "interruption_recovery"],
    ["failed-verification", "failed_verification"],
  ])
  const requiredStrategies = ["direct", "fresh_loop", "control_plane"]

  if (!(await exists(evaluationProfilePath))) {
    errors.push("Missing evaluation profile: evaluation/profile.example.json")
  } else {
    try {
      const profile = await readBoundedJson(evaluationProfilePath, 64 * 1024, "Evaluation example profile")
      expectExactKeys(profile, [
        "schema_version",
        "profile_id",
        "model",
        "variant",
        "opencode_command",
        "provider_auth_mode",
        "provider_environment",
        "strategies",
        "cases",
        "repetitions",
        "attempt_limit",
        "timeout_seconds",
        "max_output_bytes",
        "keep_test_projects",
        "require_complete_usage",
        "budgets",
      ], "Evaluation example profile")
      if (profile.schema_version !== 1) errors.push("Evaluation example profile must use schema_version 1")
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.profile_id ?? "")) {
        errors.push("Evaluation example profile needs a safe profile_id")
      }
      if (profile.model !== "provider/model" || profile.variant !== null) {
        errors.push("Evaluation example profile must keep model and variant as inert placeholders")
      }
      if (JSON.stringify(profile.opencode_command) !== JSON.stringify(["opencode"])) {
        errors.push("Evaluation example profile must use only the placeholder OpenCode command")
      }
      if (profile.provider_auth_mode !== "auth_file" || JSON.stringify(profile.provider_environment) !== "[]") {
        errors.push("Evaluation example profile must not embed provider credentials or environment names")
      }
      if (JSON.stringify(profile.strategies) !== JSON.stringify(requiredStrategies)) {
        errors.push("Evaluation example profile must contain the three required strategies exactly once")
      }
      if (JSON.stringify(profile.cases) !== JSON.stringify([...requiredCases.keys()])) {
        errors.push("Evaluation example profile must contain the seven required cases exactly once")
      }
      requireInteger(profile.repetitions, 1, 10, "Evaluation repetitions")
      requireInteger(profile.attempt_limit, 1, 10, "Evaluation attempt_limit")
      requireInteger(profile.timeout_seconds, 30, 7200, "Evaluation timeout_seconds")
      requireInteger(profile.max_output_bytes, 64 * 1024, 64 * 1024 * 1024, "Evaluation max_output_bytes")
      if (profile.keep_test_projects !== false) {
        errors.push("Evaluation example profile must remove disposable test projects by default")
      }
      if (profile.require_complete_usage !== true) {
        errors.push("Evaluation example profile must require complete provider usage telemetry")
      }
      expectExactKeys(profile.budgets, [
        "max_trials",
        "max_elapsed_minutes",
        "max_provider_cost",
        "max_input_tokens",
        "max_output_tokens",
        "max_reasoning_tokens",
        "max_cache_read_tokens",
        "max_cache_write_tokens",
      ], "Evaluation budgets")
      requireInteger(profile.budgets?.max_trials, 1, 1000, "Evaluation budget max_trials")
      requireInteger(profile.budgets?.max_elapsed_minutes, 1, 1440, "Evaluation budget max_elapsed_minutes")
      requireNumber(profile.budgets?.max_provider_cost, 0.01, 10000, "Evaluation budget max_provider_cost")
      for (const name of [
        "max_input_tokens",
        "max_output_tokens",
        "max_reasoning_tokens",
        "max_cache_read_tokens",
        "max_cache_write_tokens",
      ]) {
        requireInteger(profile.budgets?.[name], 1, 1_000_000_000, `Evaluation budget ${name}`)
      }
      const plannedTrials = requiredStrategies.length * requiredCases.size * (Number.isInteger(profile.repetitions) ? profile.repetitions : 0)
      if (Number.isInteger(profile.budgets?.max_trials) && profile.budgets.max_trials < plannedTrials) {
        errors.push(`Evaluation budget max_trials must cover the configured ${plannedTrials} trials`)
      }
      if (containsSecretLikeValue(profile)) {
        errors.push("Evaluation example profile must not contain credentials, access tokens, private keys, or provider secrets")
      }
    } catch (error) {
      errors.push(`Invalid evaluation example profile: ${error.message}`)
    }
  }

  if (!(await exists(evaluationCorpusRoot))) {
    errors.push("Missing evaluation corpus: evaluation/corpus")
  } else {
    let entries = []
    try {
      entries = await readdir(evaluationCorpusRoot, { withFileTypes: true })
    } catch (error) {
      errors.push(`Cannot read evaluation corpus: ${error.message}`)
    }
    const actualCaseIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    const expectedCaseIds = [...requiredCases.keys()].sort()
    if (JSON.stringify(actualCaseIds) !== JSON.stringify(expectedCaseIds)) {
      errors.push(`Evaluation corpus must contain exactly these seven case directories: ${expectedCaseIds.join(", ")}`)
    }
    for (const [caseId, scenario] of requiredCases) {
      await validateEvaluationCase(caseId, scenario)
    }
  }

  if (!(await exists(evaluationGatePath))) {
    errors.push("Missing generic evaluation gate: evaluation/gates/verify-case.mjs")
  } else {
    checkModuleSyntax(evaluationGatePath, "Generic evaluation gate")
  }

  const scriptRoot = path.join(root, "scripts")
  if (await exists(scriptRoot)) {
    for (const file of await walkFiles(scriptRoot)) {
      const name = relative(file)
      if (path.extname(file) === ".mjs" && /(?:^|\/)(?:evaluate|evaluation)[^/]*\.mjs$/i.test(name)) {
        checkModuleSyntax(file, "Evaluation script")
      }
    }
  }
}

async function validateEvaluationCase(caseId, expectedScenario) {
  const caseRoot = path.join(evaluationCorpusRoot, caseId)
  const caseFile = path.join(caseRoot, "case.json")
  if (!(await exists(caseFile))) {
    errors.push(`Missing evaluation case contract: evaluation/corpus/${caseId}/case.json`)
    return
  }
  let config
  try {
    config = await readBoundedJson(caseFile, 64 * 1024, `Evaluation case ${caseId}`)
  } catch (error) {
    errors.push(`Invalid evaluation case ${caseId}: ${error.message}`)
    return
  }
  expectExactKeys(config, [
    "schema_version",
    "id",
    "title",
    "scenario",
    "task_file",
    "seed_directory",
    "solution_directory",
    "allowed_changed_paths",
    "simulation",
    "verification",
  ], `Evaluation case ${caseId}`)
  if (config.schema_version !== 1 || config.id !== caseId || config.scenario !== expectedScenario) {
    errors.push(`Evaluation case ${caseId} must use schema_version 1 and its required ID/category`)
  }
  if (
    typeof config.title !== "string" ||
    config.title !== config.title.trim() ||
    config.title.length < 1 ||
    config.title.length > 160 ||
    /[\x00-\x1f\x7f]/.test(config.title)
  ) {
    errors.push(`Evaluation case ${caseId} needs a bounded plain-text title`)
  }
  if (config.task_file !== "task.md" || config.seed_directory !== "seed" || config.solution_directory !== "solution") {
    errors.push(`Evaluation case ${caseId} must use the contained task.md, seed, and solution paths`)
  }
  expectExactKeys(config.simulation, ["interrupt_after_phase", "forced_gate_failures"], `Evaluation case ${caseId} simulation`)
  const expectedInterruption = caseId === "interruption-recovery" ? "execute" : null
  const expectedFailures = caseId === "failed-verification" ? 1 : 0
  if (
    config.simulation?.interrupt_after_phase !== expectedInterruption ||
    config.simulation?.forced_gate_failures !== expectedFailures
  ) {
    errors.push(`Evaluation case ${caseId} must preserve its deterministic interruption/failure simulation`)
  }
  expectExactKeys(config.verification, ["gate"], `Evaluation case ${caseId} verification`)
  if (config.verification?.gate !== "evaluation/gates/verify-case.mjs") {
    errors.push(`Evaluation case ${caseId} must use the one generic held-out gate`)
  }

  const patterns = Array.isArray(config.allowed_changed_paths) ? config.allowed_changed_paths : []
  if (patterns.length === 0 || patterns.length > 64 || new Set(patterns).size !== patterns.length) {
    errors.push(`Evaluation case ${caseId} needs 1-64 unique allowed_changed_paths`)
  }
  const matchers = []
  for (const pattern of patterns) {
    const matcher = evaluationPathMatcher(pattern)
    if (!matcher) errors.push(`Evaluation case ${caseId} has an unsafe allowed path: ${String(pattern)}`)
    else matchers.push({ pattern, matcher })
  }

  const taskPath = containedEvaluationPath(caseRoot, config.task_file)
  if (!taskPath) {
    errors.push(`Evaluation case ${caseId} task path escapes its case directory`)
  } else {
    try {
      const info = await lstat(taskPath)
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size < 1 || info.size > 32 * 1024) {
        throw new Error("task.md must be one non-empty bounded regular file")
      }
      if (!(await readFile(taskPath, "utf8")).trim()) throw new Error("task.md cannot be blank")
    } catch (error) {
      errors.push(`Invalid evaluation task for ${caseId}: ${error.message}`)
    }
  }

  const seedPath = containedEvaluationPath(caseRoot, config.seed_directory)
  const solutionPath = containedEvaluationPath(caseRoot, config.solution_directory)
  const seedFiles = seedPath ? await inspectEvaluationTree(seedPath, `${caseId} seed`) : null
  const solutionFiles = solutionPath ? await inspectEvaluationTree(solutionPath, `${caseId} solution`) : null
  if (!seedPath) errors.push(`Evaluation case ${caseId} seed path escapes its case directory`)
  if (!solutionPath) errors.push(`Evaluation case ${caseId} solution path escapes its case directory`)
  if (seedFiles && seedFiles.length === 0) errors.push(`Evaluation case ${caseId} seed must contain at least one file`)
  if (solutionFiles && solutionFiles.length === 0) errors.push(`Evaluation case ${caseId} solution must contain at least one file`)
  if (solutionFiles && matchers.length) {
    for (const file of solutionFiles) {
      if (!matchers.some(({ matcher }) => matcher.test(file))) {
        errors.push(`Evaluation case ${caseId} solution path is not allowed_changed_paths-covered: ${file}`)
      }
    }
    for (const { pattern, matcher } of matchers) {
      if (!solutionFiles.some((file) => matcher.test(file))) {
        errors.push(`Evaluation case ${caseId} allowed path does not name a solution artifact: ${pattern}`)
      }
    }
  }
}

async function readBoundedJson(file, maxBytes, label) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size < 2 || info.size > maxBytes) {
    throw new Error(`${label} must be one bounded regular JSON file`)
  }
  return JSON.parse(await readFile(file, "utf8"))
}

async function inspectEvaluationTree(directory, label) {
  if (!directory) return null
  try {
    const rootInfo = await lstat(directory)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("must be one real directory")
    const files = []
    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const location = path.join(current, entry.name)
        const info = await lstat(location)
        if (info.isSymbolicLink()) throw new Error(`contains a symbolic link: ${relative(location)}`)
        if (info.isDirectory()) await visit(location)
        else if (info.isFile() && Number(info.nlink) === 1 && info.size <= 1024 * 1024) {
          files.push(path.relative(directory, location).split(path.sep).join("/"))
        } else throw new Error(`contains an unsafe or oversized file: ${relative(location)}`)
        if (files.length > 256) throw new Error("exceeds the 256-file corpus limit")
      }
    }
    await visit(directory)
    return files.sort()
  } catch (error) {
    errors.push(`Invalid evaluation ${label}: ${error.message}`)
    return null
  }
}

function containedEvaluationPath(parent, value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) return null
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return null
  const resolved = path.resolve(parent, ...parts)
  const relativePath = path.relative(path.resolve(parent), resolved)
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? resolved : null
}

function evaluationPathMatcher(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) return null
  const parts = value.split("/")
  if (
    parts.some((part) =>
      !part ||
      part === "." ||
      part === ".." ||
      (part !== "*" && part !== "**" && !/^[A-Za-z0-9._-]+$/.test(part)),
    )
  ) return null
  const expression = parts.map((part) => {
    if (part === "**") return ".*"
    if (part === "*") return "[^/]+"
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }).join("/")
  return new RegExp(`^${expression}$`)
}

function expectExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${label} fields must be exactly: ${wanted.join(", ")}`)
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
}

function requireNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be a number from ${minimum} through ${maximum}`)
  }
}

function containsSecretLikeValue(value) {
  if (Array.isArray(value)) return value.some(containsSecretLikeValue)
  if (value && typeof value === "object") return Object.values(value).some(containsSecretLikeValue)
  if (typeof value !== "string") return false
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
    /\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
  )
}

function checkModuleSyntax(file, label) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true, shell: false })
  if (checked.status !== 0) errors.push(`${label} ${relative(file)} syntax error: ${checked.stderr.trim()}`)
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/))
      .filter(Boolean)
      .map((parts) => [parts[1], parts[2].trim()]),
  )
}

async function walkFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "output", "tmp"].includes(entry.name)) continue
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(location)))
    else if (entry.isFile()) files.push(location)
  }
  return files
}

function relative(location) {
  return path.relative(root, location).replaceAll(path.sep, "/")
}

async function exists(location) {
  try {
    await stat(location)
    return true
  } catch {
    return false
  }
}
