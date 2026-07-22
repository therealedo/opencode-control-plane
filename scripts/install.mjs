#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

let fatalReported = false
process.once("uncaughtException", (error) => {
  if (fatalReported) return
  fatalReported = true
  const compact = process.argv.includes("--json")
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code ?? "INSTALL_FAILED",
    details: error?.details ?? null,
  }, null, compact ? 0 : 2)}\n`)
  process.exitCode = 1
})

const args = parseArgs(process.argv.slice(2))
const inspectionWarnings = new Set()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const home = path.resolve(args.home ?? os.homedir())
const manifestSourceRoot = path.resolve(args.sourceRoot ?? root)
const environmentConfigHome = args.home === undefined && args.configHome === undefined
  ? process.env.XDG_CONFIG_HOME
  : undefined
if (environmentConfigHome && !path.isAbsolute(environmentConfigHome)) {
  throw new Error("XDG_CONFIG_HOME must be absolute; use --config-home with the intended real path")
}
const configHome = path.resolve(
  args.configHome ??
  (environmentConfigHome
    ? environmentConfigHome
    : path.join(home, ".config")),
)
const templateRoot = path.join(root, ".agents", "skills", "init-project", "assets", "project")
const commandRoot = path.join(templateRoot, ".opencode", "commands")
const defaultSkillNames = new Set(["init-project", "evolve-project"])
const manifestDestination = path.join(home, ".agents", ".autopilot-install-manifest.json")
const release = JSON.parse(await readFile(path.join(root, ".agents", "skills", "init-project", "assets", "control-plane-release.json"), "utf8"))
const priorGlobalSkillNames = [
  "autonomous-loop",
  "fix-bug",
  "human-in-the-loop",
  "implement-feature",
  "read-only-query",
  "scope-expansion",
  "session-handoff",
  "session-init",
  "subagent-orchestration",
  "verify-build",
]
const priorGlobalAgentNames = [
  "autopilot-worker.md",
  "autopilot-recovery.md",
  "autopilot-reviewer.md",
]
const priorGlobalCommandNames = [
  "autopilot-start.md",
  "autopilot-status.md",
  "autopilot-pause.md",
  "autopilot-resume.md",
  "autopilot-stop.md",
]

await assertSelectedRoot(home, "home", { required: true })
await assertSelectedRoot(configHome, "OpenCode config home")
if (isWithin(root, home)) throw new Error("Installer home cannot be the installer source repository or a directory inside it")
if (isWithin(root, configHome)) {
  throw new Error("OpenCode config home cannot be the installer source repository or a directory inside it")
}
assertWithin(home, manifestDestination, "install manifest")
await assertSafeTarget(home, manifestDestination, "install manifest")
const previousInstall = args.upgrade
  ? await loadUpgradeManifest(manifestDestination)
  : null
if (previousInstall && !args.fullSpecified) args.full = Boolean(previousInstall.full)
const binHome = path.resolve(args.binHome ?? previousInstall?.bin_home ?? defaultBinHome(home))
assertWithin(home, binHome, "Control Plane command directory")
await assertSelectedRoot(binHome, "Control Plane command directory")
if (isWithin(root, binHome)) throw new Error("Control Plane command directory cannot be the installer source repository or a directory inside it")
const launcherDestination = path.join(binHome, process.platform === "win32" ? "control-plane.cmd" : "control-plane")
const launcherContent = globalLauncher({
  node: process.execPath,
  script: path.join(home, ".agents", "skills", "init-project", "bin", "control-plane-global.mjs"),
})
const launcherOnPath = pathEntries(process.env.PATH ?? process.env.Path ?? "").some((entry) => normalizedPath(entry) === normalizedPath(binHome))
if (!launcherOnPath) inspectionWarnings.add(`Add ${binHome} to your user PATH once to launch control-plane from any folder.`)

const actions = []
const sourceSkillEntries = await readdir(path.join(root, ".agents", "skills"), { withFileTypes: true })
for (const entry of sourceSkillEntries) {
  if (!entry.isDirectory()) throw new Error(`Unexpected non-directory skill source: ${entry.name}`)
  if (!args.full && !defaultSkillNames.has(entry.name)) continue
  actions.push({
    kind: "skill",
    source: path.join(root, ".agents", "skills", entry.name),
    destination: path.join(home, ".agents", "skills", entry.name),
    targetRoot: home,
  })
}
actions.push({
  kind: "command",
  source: path.join(commandRoot, "init-project.md"),
  destination: path.join(configHome, "opencode", "commands", "init-project.md"),
  targetRoot: configHome,
})
actions.push({
  kind: "command",
  source: path.join(commandRoot, "evolve-project.md"),
  destination: path.join(configHome, "opencode", "commands", "evolve-project.md"),
  targetRoot: configHome,
})
actions.push({
  kind: "launcher",
  source: null,
  content: launcherContent,
  destination: launcherDestination,
  targetRoot: home,
})
actions.sort((left, right) => left.destination.localeCompare(right.destination, "en"))

assertDistinctNonOverlappingTargets(actions, manifestDestination)
for (const action of actions) {
  assertWithin(action.targetRoot, action.destination, `${action.kind} destination`)
  for (const source of actions.map((item) => item.source).filter(Boolean)) {
    if (pathsOverlap(action.destination, source)) {
      throw new Error(`Install destination overlaps installer source: ${action.destination} and ${source}`)
    }
  }
  await assertSafeTarget(action.targetRoot, action.destination, `${action.kind} destination`)
}
for (const action of actions) if (action.source) await assertExists(action.source)
const sourceHashes = Object.fromEntries(
  await Promise.all(actions.map(async (action) => [
    action.destination,
    action.source ? await treeSha256(action.source) : treeSha256Bytes(action.content),
  ])),
)
const conflicts = []
for (const action of actions) if (await exists(action.destination)) conflicts.push(action.destination)
if (await exists(manifestDestination)) conflicts.push(manifestDestination)
if (args.upgrade) {
  await assertUpgradeOwnership(actions, sourceHashes, previousInstall)
} else if (conflicts.length > 0 && !args.force && !args.dryRun) {
  throw new Error(
    `Refusing to overwrite ${conflicts.length} existing path(s): ${conflicts.slice(0, 3).join(", ")}. ` +
      "Run --dry-run first, back them up, then use --force only after reviewing the destinations.",
  )
}

const actionDestinations = new Set(actions.map((action) => action.destination))
const legacySkillNames = [...new Set([
  ...priorGlobalSkillNames,
  ...sourceSkillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
])].filter((name) => !defaultSkillNames.has(name)).sort((left, right) => left.localeCompare(right, "en"))
const legacyCandidates = [
  ...legacySkillNames.map((name) => path.join(home, ".agents", "skills", name)),
  ...priorGlobalAgentNames
    .map((name) => path.join(configHome, "opencode", "agents", name)),
  ...priorGlobalCommandNames
    .map((name) => path.join(configHome, "opencode", "commands", name)),
].filter((candidate) => !actionDestinations.has(candidate))
const presentLegacyCandidates = []
for (const candidate of legacyCandidates) if (await exists(candidate)) presentLegacyCandidates.push(candidate)
presentLegacyCandidates.sort((left, right) => left.localeCompare(right, "en"))

const installResult = args.dryRun
  ? { cleanup_warnings: [] }
  : await transactionalInstall(actions, sourceHashes)

console.log(
  JSON.stringify(
    {
      ok: true,
      dry_run: args.dryRun,
      upgrade: args.upgrade,
      full: args.full,
      control_plane_version: release.version,
      home,
      config_home: configHome,
      bin_home: binHome,
      source_root: manifestSourceRoot,
      launcher: launcherDestination,
      launcher_on_path: launcherOnPath,
      actions: actions.map((action) => ({
        kind: action.kind,
        source: action.source ?? "generated launcher",
        destination: action.destination,
        sha256: sourceHashes[action.destination],
      })),
      conflicts: args.upgrade ? [] : conflicts,
      existing_owned_targets: args.upgrade ? conflicts : [],
      legacy_candidates: presentLegacyCandidates,
      legacy_note: "Legacy candidates are reported for manual move/removal only; this installer never modifies or deletes them, including with --force.",
      manifest: manifestDestination,
      cleanup_warnings: installResult.cleanup_warnings,
      inspection_warnings: [...inspectionWarnings].sort((left, right) => left.localeCompare(right, "en")),
      note: args.full
        ? "All source skills, the global control-plane dashboard, /init-project, and /evolve-project are installed. Initialized projects still contain phase agents and lifecycle commands. Global opencode.json is not modified."
        : "The token-minimal install exposes control-plane, init-project, evolve-project, /init-project, and /evolve-project globally; use --full for optional manual/fallback skills. Initialized projects contain deterministic lifecycle scripts. Global opencode.json is not modified.",
    },
    null,
    args.json ? 0 : 2,
  ),
)

async function transactionalInstall(plannedActions, hashes) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`
  const staged = []
  const applied = []
  let manifestStage = null
  try {
    for (const action of plannedActions) {
      const parent = path.dirname(action.destination)
      await assertSafeTarget(action.targetRoot, action.destination, `${action.kind} destination`)
      await mkdir(parent, { recursive: true })
      await assertSafeTarget(action.targetRoot, action.destination, `${action.kind} destination`)
      const stage = path.join(parent, `.${path.basename(action.destination)}.autopilot-stage-${nonce}`)
      const backup = path.join(parent, `.${path.basename(action.destination)}.autopilot-backup-${nonce}`)
      await assertAbsent(stage)
      await assertAbsent(backup)
      const stagedAction = {
        ...action,
        stage,
        backup,
        hadDestination: await exists(action.destination),
        backupMoved: false,
        installed: false,
      }
      staged.push(stagedAction)
      if (action.source) await cp(action.source, stage, { recursive: true, force: false, errorOnExist: true })
      else await writeFile(stage, action.content, { flag: "wx", mode: process.platform === "win32" ? 0o600 : 0o755 })
      const stagedHash = await treeSha256(stage)
      if (stagedHash !== hashes[action.destination]) {
        throw new Error(`Staged install hash differs for ${action.destination}`)
      }
    }

    await assertSafeTarget(home, manifestDestination, "install manifest")
    await mkdir(path.dirname(manifestDestination), { recursive: true })
    await assertSafeTarget(home, manifestDestination, "install manifest")
    manifestStage = path.join(
      path.dirname(manifestDestination),
      `.${path.basename(manifestDestination)}.autopilot-stage-${nonce}`,
    )
    await assertAbsent(manifestStage)
    const manifest = {
      schema_version: 2,
      product_id: release.product_id,
      name: release.name,
      version: release.version,
      repository: release.repository,
      previous_version: previousInstall?.version ?? null,
      installed_at: new Date().toISOString(),
      source_root: manifestSourceRoot,
      home,
      config_home: configHome,
      bin_home: binHome,
      full: args.full,
      outputs: plannedActions.map((action) => ({
        kind: action.kind,
        destination: action.destination,
        sha256: hashes[action.destination],
      })),
    }
    await writeFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    const manifestBackup = path.join(
      path.dirname(manifestDestination),
      `.${path.basename(manifestDestination)}.autopilot-backup-${nonce}`,
    )
    await assertAbsent(manifestBackup)
    staged.push({
      kind: "manifest",
      source: null,
      destination: manifestDestination,
      stage: manifestStage,
      backup: manifestBackup,
      hadDestination: await exists(manifestDestination),
      targetRoot: home,
      backupMoved: false,
      installed: false,
    })

    let installedCount = 0
    for (const action of staged) {
      await assertSafeTarget(action.targetRoot, action.destination, `${action.kind} destination`)
      const existsBeforeSwap = await exists(action.destination)
      if (existsBeforeSwap !== action.hadDestination) {
        throw new Error(`Install destination changed after staging: ${action.destination}`)
      }
      if (action.hadDestination) {
        if (!args.force && !args.upgrade) throw new Error(`Install destination appeared after preflight: ${action.destination}`)
        await rename(action.destination, action.backup)
        action.backupMoved = true
      }
      await rename(action.stage, action.destination)
      action.installed = true
      applied.push(action)
      installedCount += 1
      if (
        process.env.NODE_ENV === "test" &&
        Number(process.env.AUTOPILOT_TEST_INSTALL_FAIL_AFTER ?? 0) === installedCount
      ) throw new Error("Injected transactional installer failure")
    }

    const cleanupWarnings = []
    for (const action of applied) {
      if (!action.hadDestination) continue
      try {
        await rm(action.backup, { recursive: true, force: true })
        action.backupMoved = false
      } catch (error) {
        cleanupWarnings.push(`${action.backup}: ${error.message}`)
      }
    }
    return { cleanup_warnings: cleanupWarnings }
  } catch (error) {
    const rollbackErrors = []
    for (const action of [...staged].reverse()) {
      if (action.installed) {
        try {
          await rm(action.destination, { recursive: true, force: true })
          action.installed = false
        } catch (rollbackError) {
          rollbackErrors.push(`${action.destination}: cannot remove installed output: ${rollbackError.message}`)
        }
      }
      if (action.backupMoved) {
        try {
          if (await exists(action.destination)) {
            throw new Error("destination is occupied")
          }
          await rename(action.backup, action.destination)
          action.backupMoved = false
        } catch (rollbackError) {
          rollbackErrors.push(`${action.destination}: cannot restore original: ${rollbackError.message}`)
        }
      }
      try {
        await rm(action.stage, { recursive: true, force: true })
      } catch (rollbackError) {
        rollbackErrors.push(`${action.stage}: cannot remove staged output: ${rollbackError.message}`)
      }
    }
    if (manifestStage) {
      try {
        await rm(manifestStage, { recursive: true, force: true })
      } catch (rollbackError) {
        rollbackErrors.push(`${manifestStage}: cannot remove staged manifest: ${rollbackError.message}`)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${error.message}; rollback also failed: ${rollbackErrors.join("; ")}`)
    }
    throw error
  }
}

async function treeSha256(location) {
  const records = []
  const walk = async (current, relative = "") => {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`Installer source/stage cannot contain a symbolic link: ${current}`)
    if (info.isFile()) {
      records.push(`file\0${relative}\0${createHash("sha256").update(await readFile(current)).digest("hex")}\0`)
      return
    }
    if (!info.isDirectory()) throw new Error(`Installer source/stage has unsupported type: ${current}`)
    records.push(`dir\0${relative}\0`)
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) await walk(path.join(current, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
  }
  await walk(location)
  return createHash("sha256").update(records.join("\n")).digest("hex")
}

function treeSha256Bytes(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return createHash("sha256").update(`file\0\0${digest}\0`).digest("hex")
}

function defaultBinHome(selectedHome) {
  if (process.platform === "win32" && args.home === undefined) {
    const appData = process.env.APPDATA
    if (appData && path.isAbsolute(appData) && isWithin(selectedHome, appData)) return path.join(appData, "npm")
  }
  if (process.platform !== "win32") return path.join(selectedHome, ".local", "bin")
  return path.join(selectedHome, ".agents", "bin")
}

function globalLauncher({ node, script }) {
  for (const [label, value] of [["Node executable", node], ["global dashboard", script]]) {
    if (/[\r\n\0]/.test(value)) throw new Error(`${label} path contains unsupported control characters`)
  }
  if (process.platform === "win32") {
    if (/[%!]/.test(node) || /[%!]/.test(script)) throw new Error("Windows launcher paths cannot contain % or !")
    return Buffer.from(`@echo off\r\n"${node}" "${script}" %*\r\nexit /b %errorlevel%\r\n`, "utf8")
  }
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`
  return Buffer.from(`#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`, "utf8")
}

function pathEntries(value) {
  return String(value).split(path.delimiter).map((item) => item.trim().replace(/^"|"$/g, "")).filter((item) => path.isAbsolute(item))
}

function parseArgs(argv) {
  const result = { home: undefined, configHome: undefined, binHome: undefined, sourceRoot: undefined, force: false, upgrade: false, dryRun: false, json: false, full: false, fullSpecified: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--home") result.home = optionPathValue(argv, ++index, "--home")
    else if (value === "--config-home") result.configHome = optionPathValue(argv, ++index, "--config-home")
    else if (value === "--bin-home") result.binHome = optionPathValue(argv, ++index, "--bin-home")
    else if (value === "--source-root") result.sourceRoot = optionPathValue(argv, ++index, "--source-root")
    else if (value === "--force") result.force = true
    else if (value === "--upgrade") result.upgrade = true
    else if (value === "--dry-run") result.dryRun = true
    else if (value === "--json") result.json = true
    else if (value === "--full") {
      result.full = true
      result.fullSpecified = true
    }
    else if (value === "--help") {
      console.log("Usage: install.mjs [--home PATH] [--config-home PATH] [--bin-home PATH] [--source-root PATH] [--full] [--dry-run] [--force | --upgrade] [--json]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  if (result.force && result.upgrade) throw new Error("--force and --upgrade are mutually exclusive")
  return result
}

async function loadUpgradeManifest(file) {
  if (!(await exists(file))) throw new Error("No prior Control Plane installation manifest exists; run the normal setup first")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 1024 * 1024) {
    throw new Error("Prior installation manifest must be one bounded private regular file")
  }
  let manifest
  try { manifest = JSON.parse(await readFile(file, "utf8")) }
  catch (error) { throw new Error(`Prior installation manifest is invalid JSON: ${error.message}`) }
  if (
    ![1, 2].includes(manifest.schema_version) ||
    path.resolve(manifest.home ?? "") !== home ||
    path.resolve(manifest.config_home ?? "") !== configHome ||
    !Array.isArray(manifest.outputs) ||
    typeof manifest.full !== "boolean"
  ) throw new Error("Prior installation manifest does not match the selected home/configuration roots")
  if (manifest.schema_version === 2 && manifest.product_id !== release.product_id) {
    throw new Error("Prior installation manifest belongs to a different product")
  }
  if (manifest.bin_home !== undefined) {
    if (typeof manifest.bin_home !== "string" || !path.isAbsolute(manifest.bin_home)) {
      throw new Error("Prior installation manifest has an invalid command directory")
    }
    assertWithin(home, path.resolve(manifest.bin_home), "prior command directory")
  }
  const seen = new Set()
  for (const output of manifest.outputs) {
    if (!output || typeof output.destination !== "string" || !/^[0-9a-f]{64}$/.test(output.sha256 ?? "")) {
      throw new Error("Prior installation manifest contains an invalid output record")
    }
    const destination = path.resolve(output.destination)
    const boundary = output.kind === "command" ? configHome : home
    assertWithin(boundary, destination, "prior install output")
    const folded = process.platform === "win32" ? destination.toLowerCase() : destination
    if (seen.has(folded)) throw new Error(`Prior installation manifest repeats ${destination}`)
    seen.add(folded)
  }
  return manifest
}

async function assertUpgradeOwnership(plannedActions, hashes, manifest) {
  const prior = new Map(manifest.outputs.map((entry) => [normalizedPath(entry.destination), entry]))
  const releaseChangedWithoutVersion = manifest.schema_version === 2 && manifest.version === release.version && plannedActions.some((action) => {
    const record = prior.get(normalizedPath(action.destination))
    return record && record.sha256 !== hashes[action.destination]
  })
  if (releaseChangedWithoutVersion) {
    throw new Error(`Control Plane source changed without a release version bump (${release.version})`)
  }
  for (const action of plannedActions) {
    const key = normalizedPath(action.destination)
    const record = prior.get(key)
    const present = await exists(action.destination)
    if (!present) {
      if (record) throw new Error(`Installed Control Plane output is missing: ${action.destination}`)
      continue
    }
    if (!record) throw new Error(`Existing destination is not owned by the prior Control Plane install: ${action.destination}`)
    const current = await treeSha256(action.destination)
    if (current !== record.sha256 && current !== hashes[action.destination]) {
      const error = new Error(`Installed Control Plane output drifted outside the upgrade system: ${action.destination}`)
      error.code = "GLOBAL_CONTROL_PLANE_DRIFT"
      error.details = { destination: action.destination }
      throw error
    }
  }
}

function optionPathValue(argv, index, option) {
  const value = argv[index]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a path`)
  return value
}

async function assertExists(location) {
  if (!(await exists(location))) throw new Error(`Missing install source: ${location}`)
}

async function assertAbsent(location) {
  if (await exists(location)) throw new Error(`Refusing unsafe installer temporary-path collision: ${location}`)
}

async function exists(location) {
  try {
    await lstat(location)
    return true
  } catch (error) {
    if (args.dryRun && ["EACCES", "EPERM"].includes(error?.code)) {
      inspectionWarnings.add(`Dry-run could not inspect ${location}; a real install will fail closed unless it is accessible.`)
      return true
    }
    if (error?.code !== "ENOENT") throw error
    return false
  }
}

function normalizedPath(location) {
  const resolved = path.resolve(location).replace(/[\\/]+$/, "") || path.parse(path.resolve(location)).root
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isWithin(boundary, candidate) {
  const relative = path.relative(normalizedPath(boundary), normalizedPath(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left)
}

function assertWithin(boundary, candidate, label) {
  if (!isWithin(boundary, candidate)) {
    throw new Error(`${label} escapes its selected root: ${candidate}`)
  }
}

function assertDistinctNonOverlappingTargets(plannedActions, manifest) {
  const targets = [
    ...plannedActions.map((action) => ({ label: `${action.kind} destination`, path: action.destination })),
    { label: "install manifest", path: manifest },
  ]
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (pathsOverlap(targets[left].path, targets[right].path)) {
        throw new Error(
          `Install targets overlap: ${targets[left].label} ${targets[left].path} and ` +
          `${targets[right].label} ${targets[right].path}`,
        )
      }
    }
  }
}

async function assertSelectedRoot(location, label, { required = false } = {}) {
  const result = await assertNoLinkTraversal(location, label)
  if (required && !result.exists) throw new Error(`Installer ${label} must already exist: ${location}`)
  if (result.exists && !result.info.isDirectory()) throw new Error(`Installer ${label} must be a directory: ${location}`)
}

async function assertSafeTarget(boundary, destination, label) {
  assertWithin(boundary, destination, label)
  const rootResult = await assertNoLinkTraversal(boundary, `${label} root`)
  if (rootResult.exists && !rootResult.info.isDirectory()) {
    throw new Error(`${label} root must be a directory: ${boundary}`)
  }
  await assertNoLinkTraversal(destination, label)
}

async function assertNoLinkTraversal(location, label) {
  const absolute = path.resolve(location)
  const parsed = path.parse(absolute)
  const relative = absolute.slice(parsed.root.length)
  const components = relative.split(/[\\/]+/).filter(Boolean)
  let current = parsed.root
  let latest = await lstat(current)
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, info: null }
      if (args.dryRun && ["EACCES", "EPERM"].includes(error?.code)) {
        inspectionWarnings.add(`Dry-run could not inspect ${current}; a real install will fail closed unless it is accessible.`)
        return { exists: false, info: null, uninspectable: true }
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link or junction: ${current}`)
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} traverses a non-directory path: ${current}`)
    }
    latest = info
  }
  return { exists: true, info: latest }
}
