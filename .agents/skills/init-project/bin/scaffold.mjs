#!/usr/bin/env node

import { constants as fsConstants } from "node:fs"
import { createHash } from "node:crypto"
import {
  access,
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  externalExecutionEnv,
  resolveExternalGitExecutable,
  runArgv,
  safeBaseEnv,
  sanitizeProcessResult,
} from "../assets/project/.autopilot/bin/lib/process.mjs"
import {
  BASE_GITIGNORE_FRAGMENT,
  canonicalBaseGitignoreIsLast,
} from "../assets/project/.autopilot/bin/lib/gitignore.mjs"
import { createInstalledManifest } from "./lib/control-plane-files.mjs"

const PROCESS_TIMEOUT_MS = 60_000
const PROCESS_OUTPUT_BYTES = 1024 * 1024
const ERROR_OUTPUT_BYTES = 8 * 1024
const MAX_EXISTING_GITIGNORE_BYTES = 1024 * 1024

const args = parseArgs(process.argv.slice(2))
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const assetRoot = path.join(skillRoot, "assets", "project")
const target = path.resolve(args.target ?? process.cwd())
const created = []

assertDisjoint(assetRoot, target)

await assertDirectory(assetRoot, "Project template assets are missing")
await mkdir(target, { recursive: true })
await assertRealTarget(target)
await assertDisjointReal(assetRoot, target)
await assertSafeTarget(target)

for (const entry of await readdir(assetRoot, { withFileTypes: true })) {
  const source = path.join(assetRoot, entry.name)
  const destination = path.join(target, entry.name)
  await copyEntry(source, destination)
  created.push(path.relative(target, destination) || entry.name)
}

await installLifecycleScripts()

await replaceTemplateTokens(target, {
  "{{PROJECT_NAME}}": path.basename(target),
  "{{CREATED_DATE}}": new Date().toISOString().slice(0, 10),
})
const toolConfiguration = await configureTools(target)
await mergeGitignore(target)
await chmod(path.join(target, "control-plane"), 0o755)
await writeControlPlaneManifest(target)
await writeScaffoldOwnership(target)

let gitInitialized = false
if (!args.noGit && !(await exists(path.join(target, ".git")))) {
  const result = await initializeGit(target)
  gitInitialized = result.status === 0
}

const result = {
  ok: true,
  target,
  created,
  tool_grants: toolConfiguration.grants,
  git_initialized: gitInitialized,
  next: [
    "Complete .autopilot/init/blueprint.json through the init-project interview",
    "Run the init-project finalizer; it renders every durable project file",
    "Open the dashboard with ./control-plane (or control-plane.cmd on Windows)",
  ],
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Initialized autonomous project control files in ${target}`)
  console.log(`Git initialized: ${gitInitialized ? "yes" : "no"}`)
}

function parseArgs(argv) {
  const result = { target: undefined, noGit: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--target") {
      const selected = argv[++index]
      if (!selected || selected.startsWith("--")) throw new Error("--target requires a path")
      result.target = selected
    }
    else if (value === "--force") {
      throw new Error("--force is not supported; scaffold into an empty project directory")
    }
    else if (value === "--no-git") result.noGit = true
    else if (value === "--json") result.json = true
    else if (value === "--help") {
      console.log("Usage: scaffold.mjs [--target PATH] [--no-git] [--json]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  return result
}

async function configureTools(root) {
  const script = path.join(root, ".autopilot", "bin", "configure-tools.mjs")
  const configured = await runScaffoldArgv(
    [process.execPath, script, "--root", root, "--json"],
    root,
    "Initial tool configuration",
  )
  if (configured.status !== 0) {
    throw new Error(`Initial tool configuration failed${boundedDiagnostic(configured.stderr || configured.stdout)}`)
  }
  try {
    return JSON.parse(configured.stdout)
  } catch (error) {
    throw new Error(`Initial tool configuration returned invalid JSON: ${error.message}`)
  }
}

async function installLifecycleScripts() {
  const rendererSource = path.join(skillRoot, "bin", "render-blueprint.mjs")
  const evolutionSource = path.join(skillRoot, "..", "evolve-project", "bin", "evolve-blueprint.mjs")
  const rendererDestination = path.join(target, ".autopilot", "bin", "render-blueprint.mjs")
  const evolutionDestination = path.join(target, ".autopilot", "bin", "evolve-blueprint.mjs")
  const renderer = (await readFile(rendererSource, "utf8"))
    .replaceAll("../assets/project/.autopilot/bin/lib/", "./lib/")
  await writeFile(rendererDestination, renderer, { encoding: "utf8", flag: "wx", mode: 0o700 })
  await cp(evolutionSource, evolutionDestination, { force: false, errorOnExist: true })
  created.push(".autopilot/bin/render-blueprint.mjs", ".autopilot/bin/evolve-blueprint.mjs")
}

async function assertSafeTarget(directory) {
  const allowed = new Set([".git", ".gitignore"])
  const entries = await readdir(directory)
  const unexpected = entries.filter((entry) => !allowed.has(entry))
  if (unexpected.length > 0) {
    throw new Error(
      `Target is not empty (${unexpected.slice(0, 5).join(", ")}). Scaffold into an empty project directory; overwrite mode is intentionally unavailable.`,
    )
  }
  const present = new Set(entries)
  if (present.has(".gitignore")) {
    const ignoreFile = path.join(directory, ".gitignore")
    const info = await lstat(ignoreFile)
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
      throw new Error("Existing .gitignore must be one private regular file, not a link")
    }
    if (info.size > MAX_EXISTING_GITIGNORE_BYTES) {
      throw new Error(`Existing .gitignore exceeds the ${MAX_EXISTING_GITIGNORE_BYTES}-byte initialization cap`)
    }
    if (normalizePath(await realpath(ignoreFile)) !== normalizePath(ignoreFile)) {
      throw new Error("Existing .gitignore must resolve directly inside the scaffold target")
    }
  }
  if (present.has(".git")) {
    const gitDirectory = path.join(directory, ".git")
    const info = await lstat(gitDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Existing .git must be a real local directory, not a link or Git indirection file")
    }
    if (normalizePath(await realpath(gitDirectory)) !== normalizePath(gitDirectory)) {
      throw new Error("Existing .git must resolve directly inside the scaffold target")
    }
    const inside = await runScaffoldGit(["rev-parse", "--is-inside-work-tree"], directory)
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      throw new Error("Existing .git must identify the target as a Git worktree")
    }
    const topLevel = await runScaffoldGit(["rev-parse", "--show-toplevel"], directory)
    if (topLevel.status !== 0 || normalizePath(topLevel.stdout.trim()) !== normalizePath(directory)) {
      throw new Error("Existing .git must belong to the exact scaffold target, not another worktree")
    }
    const head = await runScaffoldGit(["rev-parse", "--verify", "--quiet", "HEAD"], directory)
    if (![0, 1].includes(head.status)) {
      throw new Error("Existing .git could not be validated as a local unborn repository")
    }
    if (head.status === 0) {
      throw new Error("Existing .git already has commit history; initialize in a new empty project directory")
    }
  }
}

function normalizePath(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
}

async function initializeGit(root) {
  const emptyTemplate = await mkdtemp(path.join(os.tmpdir(), "autopilot-empty-git-template-"))
  try {
    return await runScaffoldGit(["init", `--template=${emptyTemplate}`], root, { guardProcessTree: true })
  } catch {
    return { status: null, stdout: "", stderr: "" }
  } finally {
    await rm(emptyTemplate, { recursive: true, force: true })
  }
}

async function runScaffoldGit(commandArgs, cwd, options = {}) {
  const { env: extraEnv = {}, ...runOptions } = options
  const executionEnv = await externalExecutionEnv(cwd)
  const executable = await resolveExternalGitExecutable(cwd, executionEnv, {
    label: "project scaffolder Git executable",
  })
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null"
  return runScaffoldArgv(
    [
      executable,
      "--no-pager",
      "--no-replace-objects",
      "-c", `core.hooksPath=${nullDevice}`,
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "credential.interactive=false",
      "-c", `core.attributesFile=${nullDevice}`,
      "-c", `core.excludesFile=${nullDevice}`,
      ...commandArgs,
    ],
    cwd,
    `git ${commandArgs[0]}`,
    {
      env: {
        ...executionEnv,
        NO_COLOR: "1",
        ...extraEnv,
        GIT_PAGER: "cat",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: nullDevice,
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_LITERAL_PATHSPECS: "1",
        SSH_ASKPASS_REQUIRE: "never",
      },
      ...runOptions,
    },
  )
}

async function runScaffoldArgv(argv, cwd, label, {
  env = baseProcessEnvironment(),
  guardProcessTree = true,
} = {}) {
  let raw
  try {
    raw = await runArgv(argv, {
      cwd,
      env,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: PROCESS_OUTPUT_BYTES,
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

function baseProcessEnvironment(source = process.env) {
  return {
    ...safeBaseEnv(source),
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    SSH_ASKPASS_REQUIRE: "never",
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

function assertDisjoint(source, destination) {
  const sourceRoot = path.resolve(source)
  const targetRoot = path.resolve(destination)
  const targetFromSource = path.relative(sourceRoot, targetRoot)
  const sourceFromTarget = path.relative(targetRoot, sourceRoot)
  const nested = (value) => value === "" || (!value.startsWith("..") && !path.isAbsolute(value))
  if (nested(targetFromSource) || nested(sourceFromTarget)) {
    throw new Error("Scaffold source and target must be disjoint directories")
  }
}

async function assertDisjointReal(source, destination) {
  const [realSource, realTarget] = await Promise.all([
    (await import("node:fs/promises")).realpath(source),
    (await import("node:fs/promises")).realpath(destination),
  ])
  assertDisjoint(realSource, realTarget)
}

async function assertRealTarget(directory) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Scaffold target must be a real directory, not a symbolic link or junction")
  }
}

async function writeScaffoldOwnership(root) {
  const fixed = [
    ".project/brief.md", ".project/architecture/overview.md", ".project/architecture/contracts.md",
    ".project/constraints.md", ".project/autonomy.md", ".project/security.md",
    ".project/quality.md", ".project/tooling.md", ".project/roadmap.md",
    ".project/manifest.json", ".project/gates.json", ".project/tools.json",
    ".project/plan/queue.json", ".autopilot/credentials.example.json",
    ".autopilot/credentials.json", ".autopilot/config.json", ".env.example", ".gitignore", "opencode.jsonc",
  ]
  const outputs = {}
  for (const relative of fixed) {
    const file = path.join(root, ...relative.split("/"))
    if (!(await exists(file))) continue
    outputs[relative] = createHash("sha256").update(await readFile(file)).digest("hex")
  }
  await writeFile(
    path.join(root, ".autopilot", "init", "scaffold-ownership.json"),
    `${JSON.stringify({ schema_version: 1, outputs }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  )
}

async function writeControlPlaneManifest(root) {
  const manifest = await createInstalledManifest(skillRoot, root)
  await writeFile(
    path.join(root, ".autopilot", "control-plane.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  )
  created.push(".autopilot/control-plane.json")
}

async function copyEntry(source, destination) {
  if (await exists(destination)) throw new Error(`Refusing to overwrite ${destination}`)
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  })
}

async function replaceTemplateTokens(root, replacements) {
  const textExtensions = new Set([".md", ".json", ".jsonc", ".txt", ".example", ".mjs"])
  for (const file of await walkFiles(root)) {
    const basename = path.basename(file)
    if (!textExtensions.has(path.extname(file)) && !basename.startsWith(".env")) continue
    let content = await readFile(file, "utf8")
    let changed = false
    for (const [token, replacement] of Object.entries(replacements)) {
      if (!content.includes(token)) continue
      content = content.split(token).join(replacement)
      changed = true
    }
    if (changed) await writeFile(file, content, "utf8")
  }
}

async function mergeGitignore(root) {
  const destination = path.join(root, ".gitignore")
  const current = (await exists(destination)) ? await readFile(destination, "utf8") : ""
  if (canonicalBaseGitignoreIsLast(current)) return
  const fragment = BASE_GITIGNORE_FRAGMENT.trimEnd()
  const prefix = current.length === 0 || /\r?\n$/.test(current) ? "" : "\n"
  const separator = current.length === 0 ? "" : "\n"
  await appendFile(destination, `${prefix}${separator}${fragment}\n`, "utf8")
}

async function walkFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const location = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(location)))
    else if (entry.isFile()) files.push(location)
  }
  return files
}

async function assertDirectory(directory, message) {
  try {
    await access(directory, fsConstants.R_OK)
    if (!(await stat(directory)).isDirectory()) throw new Error(message)
  } catch {
    throw new Error(`${message}: ${directory}`)
  }
}

async function exists(location) {
  try {
    await access(location)
    return true
  } catch {
    return false
  }
}
