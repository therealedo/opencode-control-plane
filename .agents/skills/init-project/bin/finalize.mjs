#!/usr/bin/env node

import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  externalExecutionEnv,
  resolveExternalGitExecutable,
  runArgv,
  safeBaseEnv,
  sanitizeProcessResult,
} from "../assets/project/.autopilot/bin/lib/process.mjs"
import { controllerCommitMessage } from "../assets/project/.autopilot/bin/lib/commit-policy.mjs"

const PROCESS_TIMEOUT_MS = 120_000
const PROCESS_OUTPUT_BYTES = 1024 * 1024
const ERROR_OUTPUT_BYTES = 8 * 1024

const args = parseArgs(process.argv.slice(2))
const target = path.resolve(args.target ?? process.cwd())
const renderer = path.join(target, ".autopilot", "bin", "render-blueprint.mjs")
const evolution = path.join(target, ".autopilot", "bin", "evolve-blueprint.mjs")
const blueprint = path.join(target, ".autopilot", "init", "blueprint.json")
const validator = path.join(target, ".autopilot", "bin", "validate.mjs")
const toolConfigurator = path.join(target, ".autopilot", "bin", "configure-tools.mjs")

const noHooksDirectory = await mkdtemp(path.join(os.tmpdir(), "autopilot-finalize-no-hooks-"))
let output
try {
  output = await finalizeProject()
} finally {
  await rm(noHooksDirectory, { recursive: true, force: true })
}
console.log(JSON.stringify(output, null, args.json ? 0 : 2))

async function finalizeProject() {
  await access(renderer)
  await access(evolution)
  await access(validator)
  await access(toolConfigurator)
  const hasBlueprint = await exists(blueprint)
  if (!hasBlueprint) {
    const queue = JSON.parse(await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8"))
    if (!["ready", "complete"].includes(queue.project_status)) {
      throw new Error("blueprint.json is missing and this project is not in a finalized ready or complete state")
    }
  }
  await ensureExactGitRoot(target, { initialize: hasBlueprint })
  if (!hasBlueprint) return verifyExistingFinalization(target, toolConfigurator, validator)

  const rendered = await run(
    process.execPath,
    [renderer, "--target", target, "--json"],
    target,
    "Structured project blueprint rendering",
  )
  if (rendered.status !== 0) {
    throw new Error(`Structured project blueprint rendering failed${boundedDiagnostic(rendered.stderr || rendered.stdout)}`)
  }
  const configured = await run(
    process.execPath,
    [toolConfigurator, "--root", target, "--json"],
    target,
    "Exact role-tool configuration",
  )
  if (configured.status !== 0) {
    throw new Error(`Exact role-tool configuration failed${boundedDiagnostic(configured.stderr || configured.stdout)}`)
  }
  const versioned = await run(
    process.execPath,
    [evolution, "initialize", "--root", target, "--input", ".autopilot/init/blueprint.json", "--json"],
    target,
    "Initial blueprint versioning",
  )
  if (versioned.status !== 0) {
    throw new Error(`Initial blueprint versioning failed${boundedDiagnostic(versioned.stderr || versioned.stdout)}`)
  }
  const validation = await run(
    process.execPath,
    [validator, "--strict", "--skip-git", "--json"],
    target,
    "Strict project validation",
  )
  if (validation.status !== 0) {
    throw new Error(`Strict project validation failed${boundedDiagnostic(validation.stderr || validation.stdout)}`)
  }

  const commit = args.noCommit ? null : await createBaselineCommit(target)
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], target)
  if (status.status !== 0) throw new Error(`git status failed${boundedDiagnostic(status.stderr || status.stdout)}`)
  if (!args.noCommit && status.stdout.trim()) {
    throw new Error(`Project is not clean after baseline commit${boundedDiagnostic(status.stdout)}`)
  }

  if (!args.noCommit) {
    const executionValidation = await run(
      process.execPath,
      [validator, "--strict", "--json"],
      target,
      "Execution-readiness validation",
    )
    if (executionValidation.status !== 0) {
      throw new Error(
        `Project content passed, but execution-readiness validation failed${boundedDiagnostic(executionValidation.stderr || executionValidation.stdout)}`,
      )
    }
  }

  let blueprintCleaned = false
  if (!args.noCommit) {
    const cleanup = await run(
      process.execPath,
      [renderer, "--target", target, "--check", "--cleanup", "--json"],
      target,
      "Rendered blueprint cleanup",
    )
    if (cleanup.status !== 0) {
      throw new Error(`Rendered blueprint cleanup failed${boundedDiagnostic(cleanup.stderr || cleanup.stdout)}`)
    }
    blueprintCleaned = true
  }

  return {
    ok: true,
    target,
    blueprint_rendered: true,
    blueprint_cleaned: blueprintCleaned,
    blueprint_version: 1,
    tools_configured: true,
    baseline_commit: commit,
    clean: status.stdout.trim() === "",
  }
}

async function createBaselineCommit(root) {
  await stageExactBaseline(root)
  const staged = await git(["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], root)
  if (staged.status === 1) {
    const tree = await git(["write-tree"], root)
    if (tree.status !== 0 || !isObjectId(tree.stdout.trim())) {
      throw new Error(`Could not prepare the baseline Git tree${boundedDiagnostic(tree.stderr || tree.stdout)}`)
    }
    const treeId = tree.stdout.trim()
    await assertExactBaselineTree(root, treeId)
    const stagedConfig = await git(["show", `${treeId}:.autopilot/config.json`], root)
    if (stagedConfig.status !== 0) {
      throw new Error(`Could not read the baseline configuration from the prepared tree${boundedDiagnostic(stagedConfig.stderr || stagedConfig.stdout)}`)
    }
    let config
    try {
      config = JSON.parse(stagedConfig.stdout)
    } catch (error) {
      throw new Error(`Prepared baseline configuration is invalid JSON: ${error.message}`)
    }
    const initialCommitMessage = config.schema_version === 1
      ? "autopilot: initialize project blueprint"
      : controllerCommitMessage(config.git, "initialize project blueprint")
    const parent = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root)
    if (![0, 1].includes(parent.status)) {
      throw new Error(`Could not inspect the baseline parent${boundedDiagnostic(parent.stderr || parent.stdout)}`)
    }
    const parentCommit = parent.status === 0 ? parent.stdout.trim() : null
    if (parentCommit !== null && !isObjectId(parentCommit)) {
      throw new Error("Git returned an invalid baseline parent object ID")
    }
    const commitArgs = ["commit-tree", treeId]
    if (parentCommit !== null) commitArgs.push("-p", parentCommit)
    const committed = await git(commitArgs, root, { input: `${initialCommitMessage}\n` })
    if (committed.status !== 0) {
      throw new Error(
        `Initial local commit failed. Configure a repository Git identity and rerun finalize.mjs${boundedDiagnostic(committed.stderr || committed.stdout)}`,
      )
    }
    const plannedCommit = committed.stdout.trim()
    if (!isObjectId(plannedCommit)) throw new Error("git commit-tree returned an invalid object ID")
    const expectedOld = parentCommit ?? "0".repeat(plannedCommit.length)
    const updated = await git(
      ["update-ref", "-m", initialCommitMessage, "HEAD", plannedCommit, expectedOld],
      root,
    )
    if (updated.status !== 0) {
      throw new Error(`Could not atomically publish the baseline commit${boundedDiagnostic(updated.stderr || updated.stdout)}`)
    }
  } else if (staged.status !== 0) {
    throw new Error(`Could not inspect the Git index${boundedDiagnostic(staged.stderr || staged.stdout)}`)
  }
  const head = await git(["rev-parse", "--verify", "HEAD"], root)
  if (head.status !== 0 || !isObjectId(head.stdout.trim())) {
    throw new Error("A baseline commit is required before autonomous work can start")
  }
  return head.stdout.trim()
}

function baselinePath(value) {
  const normalized = String(value).replaceAll("\\", "/")
  if (
    !normalized || path.isAbsolute(normalized) || normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) || /[\0-\x1f\x7f]/.test(normalized)
  ) throw new Error("Git returned an unsafe baseline path")
  for (const part of normalized.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Git returned an unsafe baseline path")
  }
  return normalized
}

async function baselineFiles(root) {
  const listed = await git(["ls-files", "-c", "-o", "--exclude-standard", "-z"], root)
  if (listed.status !== 0) {
    throw new Error(`Could not enumerate the exact baseline files${boundedDiagnostic(listed.stderr || listed.stdout)}`)
  }
  return [...new Set(listed.stdout.split("\0").filter(Boolean).map(baselinePath))].sort()
}

async function stageExactBaseline(root) {
  for (const relative of await baselineFiles(root)) {
    const absolute = path.join(root, ...relative.split("/"))
    let info
    try {
      info = await lstat(absolute)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const removed = await git(["update-index", "--force-remove", "--", relative], root)
      if (removed.status !== 0) {
        throw new Error(`Could not stage baseline deletion ${relative}${boundedDiagnostic(removed.stderr || removed.stdout)}`)
      }
      continue
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new Error(`Baseline source must be one private regular file: ${relative}`)
    }
    const object = await git(["hash-object", "-w", "--no-filters", "--", relative], root)
    const objectId = object.stdout.trim()
    if (object.status !== 0 || !isObjectId(objectId)) {
      throw new Error(`Could not hash exact baseline bytes for ${relative}${boundedDiagnostic(object.stderr || object.stdout)}`)
    }
    const mode = process.platform === "win32" || (info.mode & 0o111) === 0 ? "100644" : "100755"
    const updated = await git(["update-index", "--add", "--cacheinfo", mode, objectId, relative], root)
    if (updated.status !== 0) {
      throw new Error(`Could not stage exact baseline file ${relative}${boundedDiagnostic(updated.stderr || updated.stdout)}`)
    }
  }
}

async function assertExactBaselineTree(root, tree) {
  for (const relative of await baselineFiles(root)) {
    const absolute = path.join(root, ...relative.split("/"))
    let info
    try { info = await lstat(absolute) }
    catch (error) {
      if (error?.code !== "ENOENT") throw error
      const absent = await git(["ls-tree", "-z", tree, "--", relative], root)
      if (absent.status !== 0 || absent.stdout) throw new Error(`Prepared baseline retained deleted file ${relative}`)
      continue
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new Error(`Baseline source identity changed before commit: ${relative}`)
    }
    const [working, entry] = await Promise.all([
      git(["hash-object", "--no-filters", "--", relative], root),
      git(["ls-tree", "-z", tree, "--", relative], root),
    ])
    const match = /^(100644|100755)\s+blob\s+([0-9a-f]{40,64})\t/.exec(entry.stdout.split("\0").find(Boolean) ?? "")
    if (
      working.status !== 0 || !isObjectId(working.stdout.trim()) ||
      entry.status !== 0 || !match || match[2] !== working.stdout.trim()
    ) throw new Error(`Prepared baseline tree differs from exact working bytes for ${relative}`)
  }
}

async function run(command, commandArgs, cwd, label, {
  input = null,
  env = {},
  baseEnvironment = null,
  guardProcessTree = true,
} = {}) {
  let raw
  try {
    raw = await runArgv([command, ...commandArgs], {
      cwd,
      env: { ...(baseEnvironment ?? safeBaseEnv()), NO_COLOR: "1", ...env },
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: PROCESS_OUTPUT_BYTES,
      input,
      guardProcessTree,
    })
  } catch (error) {
    throw new Error(`${label} could not start${boundedDiagnostic(error?.message ?? error)}`)
  }
  const result = sanitizeProcessResult(raw, [], PROCESS_OUTPUT_BYTES)
  if (result.timed_out) {
    throw new Error(`${label} timed out after ${PROCESS_TIMEOUT_MS} ms${boundedDiagnostic(result.stderr || result.stdout)}`)
  }
  if (result.output_truncated) {
    throw new Error(`${label} exceeded the ${PROCESS_OUTPUT_BYTES}-byte output cap${boundedDiagnostic(result.stderr || result.stdout)}`)
  }
  return { ...result, status: result.code }
}

async function git(commandArgs, cwd, options = {}) {
  const executionEnv = await externalExecutionEnv(cwd)
  const executable = await resolveExternalGitExecutable(cwd, executionEnv, {
    label: "project finalizer Git executable",
  })
  const hooksPath = process.platform === "win32"
    ? noHooksDirectory.replaceAll("\\", "/")
    : noHooksDirectory
  return run(
    executable,
    [
      "--no-pager",
      "--no-replace-objects",
      "-c", `core.hooksPath=${hooksPath}`,
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "credential.interactive=false",
      "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c", `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...commandArgs,
    ],
    cwd,
    `git ${commandArgs[0]}`,
    {
      ...options,
      baseEnvironment: executionEnv,
      // Every finalizer Git operation is fixed plumbing with hooks, filters,
      // signing, credential prompts, and pagers disabled. Running the trusted
      // native executable directly avoids a PowerShell Job per baseline file.
      guardProcessTree: false,
      env: {
        ...(options.env ?? {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_PAGER: "cat",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_LITERAL_PATHSPECS: "1",
        SSH_ASKPASS_REQUIRE: "never",
      },
    },
  )
}

async function ensureExactGitRoot(root, { initialize = true } = {}) {
  let repository = await git(["rev-parse", "--is-inside-work-tree"], root)
  if (repository.status !== 0) {
    if (!initialize) throw new Error("A finalized project must already have its own Git worktree")
    const initialized = await git(["init"], root)
    if (initialized.status !== 0) {
      throw new Error(`git init failed${boundedDiagnostic(initialized.stderr || initialized.stdout)}`)
    }
    repository = await git(["rev-parse", "--is-inside-work-tree"], root)
  }
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    throw new Error("Initialization did not produce a Git worktree")
  }
  const gitDirectory = path.join(root, ".git")
  let gitDirectoryInfo
  try {
    gitDirectoryInfo = await lstat(gitDirectory)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Project root must be its own Git worktree root with a standalone local .git directory")
    }
    throw error
  }
  if (!gitDirectoryInfo.isDirectory() || gitDirectoryInfo.isSymbolicLink()) {
    throw new Error("Project finalization requires a standalone local .git directory")
  }
  for (const relative of ["commondir", "shallow", "info/grafts", "objects/info/alternates", "refs/replace"]) {
    try {
      await lstat(path.join(gitDirectory, ...relative.split("/")))
      throw new Error(`Git history indirection is incompatible with exact project finalization: .git/${relative}`)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
  }
  const topLevel = await git(["rev-parse", "--show-toplevel"], root)
  if (topLevel.status !== 0) {
    throw new Error(`Could not resolve the Git worktree root${boundedDiagnostic(topLevel.stderr || topLevel.stdout)}`)
  }
  const normalizePath = (value) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
  }
  if (normalizePath(topLevel.stdout.trim()) !== normalizePath(root)) {
    throw new Error(
      `Project root must be its own Git worktree root. Target is ${root}, but Git resolves ${topLevel.stdout.trim()}.`,
    )
  }
  const includedConfig = await git([
    "config",
    "--no-includes",
    "--name-only",
    "--get-regexp",
    "^(include\\.path|includeif\\..*\\.path)$",
  ], root)
  if (![0, 1].includes(includedConfig.status)) {
    throw new Error("Could not inspect repository-local Git include directives")
  }
  const includeKeys = includedConfig.stdout.split(/\r?\n/).filter(Boolean)
  if (includeKeys.length > 0) {
    throw new Error(
      `Repository-local Git includes are incompatible with exact project finalization: ${includeKeys.join(", ")}`,
    )
  }
  const executableConfig = await git([
    "config",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$",
  ], root)
  if (![0, 1].includes(executableConfig.status)) {
    throw new Error("Could not inspect repository-local executable Git configuration")
  }
  const executableKeys = executableConfig.stdout.split(/\r?\n/).filter(Boolean)
  if (executableKeys.length > 0) {
    throw new Error(
      `Repository-local Git filters or diff drivers are incompatible with exact project finalization: ${executableKeys.join(", ")}`,
    )
  }
  const replacementRefs = await git(["for-each-ref", "--format=%(refname)", "refs/replace"], root)
  if (replacementRefs.status !== 0) throw new Error("Could not inspect Git replacement refs")
  const replacementNames = replacementRefs.stdout.split(/\r?\n/).filter(Boolean)
  if (replacementNames.length > 0) {
    throw new Error(`Git replacement refs are incompatible with exact project finalization: ${replacementNames.join(", ")}`)
  }
}

async function verifyExistingFinalization(root, configurator, projectValidator) {
  const configured = await run(
    process.execPath,
    [configurator, "--root", root, "--check", "--json"],
    root,
    "Finalized role-tool configuration check",
  )
  if (configured.status !== 0) {
    throw new Error(`Finalized role-tool configuration has drifted${boundedDiagnostic(configured.stderr || configured.stdout)}`)
  }
  const contentValidation = await run(
    process.execPath,
    [projectValidator, "--strict", "--skip-git", "--json"],
    root,
    "Finalized project content validation",
  )
  if (contentValidation.status !== 0) {
    throw new Error(`Finalized project content is invalid${boundedDiagnostic(contentValidation.stderr || contentValidation.stdout)}`)
  }
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], root)
  if (status.status !== 0) throw new Error(`git status failed${boundedDiagnostic(status.stderr || status.stdout)}`)
  if (status.stdout.trim()) {
    throw new Error(`Refusing to finalize without a blueprint or commit later work${boundedDiagnostic(status.stdout)}`)
  }
  const head = await git(["rev-parse", "--verify", "HEAD"], root)
  if (head.status !== 0 || !isObjectId(head.stdout.trim())) {
    throw new Error("A finalized project must already have a baseline commit")
  }
  const executionValidation = await run(
    process.execPath,
    [projectValidator, "--strict", "--json"],
    root,
    "Finalized project execution-readiness validation",
  )
  if (executionValidation.status !== 0) {
    throw new Error(`Finalized project is not execution-ready${boundedDiagnostic(executionValidation.stderr || executionValidation.stdout)}`)
  }
  return {
    ok: true,
    target: root,
    blueprint_rendered: false,
    blueprint_cleaned: false,
    tools_configured: true,
    baseline_commit: head.stdout.trim(),
    clean: true,
    verification_only: true,
  }
}

function boundedDiagnostic(value) {
  if (value === undefined || value === null || value === "") return ""
  const sanitized = sanitizeProcessResult(
    { stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", output_truncated: false },
    [],
    ERROR_OUTPUT_BYTES,
  ).stdout
  const normalized = sanitized.replace(/[\r\n]+/g, " ").trim()
  return normalized ? `: ${normalized}` : ""
}

function isObjectId(value) {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)
}

function parseArgs(argv) {
  const result = { target: undefined, noCommit: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--target") {
      const selected = argv[++index]
      if (!selected || selected.startsWith("--")) throw new Error("--target requires a path")
      result.target = selected
    }
    else if (value === "--no-commit") result.noCommit = true
    else if (value === "--json") result.json = true
    else if (value === "--help") {
      console.log("Usage: finalize.mjs [--target PATH] [--no-commit] [--json]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  return result
}

async function exists(location) {
  try {
    await access(location)
    return true
  } catch {
    return false
  }
}
