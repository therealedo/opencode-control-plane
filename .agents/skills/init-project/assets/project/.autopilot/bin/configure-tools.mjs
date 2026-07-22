#!/usr/bin/env node

import { access, open, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import {
  renderManagedToolBlock,
  ROLE_FILES,
  ROLE_NAMES,
  validateRoleToolPolicy,
} from "./lib/tool-grants.mjs"

const MAX_FILE_BYTES = 64 * 1024
let temporarySequence = 0

const rawArgs = process.argv.slice(2)
const wantsJson = rawArgs.includes("--json")

main().catch((error) => {
  const output = { ok: false, error: error.message }
  process.stderr.write(`${wantsJson ? JSON.stringify(output) : `Tool configuration failed: ${error.message}`}\n`)
  process.exitCode = 1
})

async function main() {
  const args = parseArgs(rawArgs)
  const root = args.root
    ? await requireProjectRoot(path.resolve(args.root))
    : await findProjectRoot(process.cwd())
  const configuration = await readConfiguration(path.join(root, ".project", "tools.json"))
  const planned = []

  for (const role of ROLE_NAMES) {
    const file = path.join(root, ...ROLE_FILES[role].split("/"))
    const current = await readBounded(file, `agent file for ${role}`)
    const next = renderManagedToolBlock(current, configuration.roles[role], role)
    planned.push({ role, file, relative: ROLE_FILES[role], current, next })
  }

  const changed = planned.filter((item) => item.current !== item.next)
  if (args.check && changed.length > 0) {
    emit({
      ok: false,
      check: true,
      root,
      drift: changed.map((item) => item.relative),
      grants: configuration.roles,
    }, args.json)
    process.exitCode = 1
    return
  }

  if (!args.check) {
    for (const item of changed) await atomicReplace(item.file, item.next)
  }

  emit({
    ok: true,
    check: args.check,
    root,
    changed: args.check ? [] : changed.map((item) => item.relative),
    grants: configuration.roles,
  }, args.json)
}

function parseArgs(argv) {
  const result = { root: null, check: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--root") result.root = argv[++index]
    else if (value === "--check") result.check = true
    else if (value === "--json") result.json = true
    else if (value === "--help") {
      process.stdout.write("Usage: configure-tools.mjs [--root PATH] [--check] [--json]\n")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  if (argv.includes("--root") && !result.root) throw new Error("--root requires a path")
  return result
}

async function requireProjectRoot(root) {
  const tools = path.join(root, ".project", "tools.json")
  const agents = path.join(root, ".opencode", "agents")
  if (!(await exists(tools)) || !(await exists(agents))) {
    throw new Error(`--root is not an initialized project: ${root}`)
  }
  return root
}

async function findProjectRoot(start) {
  let current = path.resolve(start)
  while (true) {
    const tools = path.join(current, ".project", "tools.json")
    const agents = path.join(current, ".opencode", "agents")
    if (await exists(tools) && await exists(agents)) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`Could not find .project/tools.json above ${start}`)
    current = parent
  }
}

async function readConfiguration(file) {
  const text = await readBounded(file, ".project/tools.json")
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid .project/tools.json: ${error.message}`)
  }
  return validateRoleToolPolicy(value)
}

async function readBounded(file, label) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${file}`)
    throw error
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${file}`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds ${MAX_FILE_BYTES} bytes`)
  return readFile(file, "utf8")
}

async function atomicReplace(file, content) {
  const info = await stat(file)
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.autopilot-${process.pid}-${temporarySequence++}.tmp`,
  )
  let handle = null
  let created = false
  try {
    handle = await open(temporary, "wx", info.mode)
    created = true
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, file)
  } finally {
    try {
      if (handle) await handle.close()
    } finally {
      if (created) await rm(temporary, { force: true })
    }
  }
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function emit(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
  else if (value.ok && value.check) process.stdout.write("Tool grants are synchronized.\n")
  else if (value.ok) process.stdout.write(`Configured exact tool grants in ${value.changed.length} agent file(s).\n`)
  else process.stdout.write(`Tool grant drift: ${value.drift.join(", ")}\n`)
}
