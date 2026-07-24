#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptFile = fileURLToPath(import.meta.url)
const evaluationRoot = path.resolve(path.dirname(scriptFile), "..")
const corpusRoot = path.join(evaluationRoot, "corpus")
const repositoryRoot = path.resolve(evaluationRoot, "..")
const MAX_FILES = 256
const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const TIMEOUT_MS = 15_000

if (process.argv[2] === "--child") {
  await childMain(process.argv.slice(3))
} else {
  await main(process.argv.slice(2))
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
    if (options.help) {
      process.stdout.write("Usage: node evaluation/gates/verify-case.mjs --case <id> --candidate <absolute-path> [--json]\n")
      return
    }
    const candidate = await safeCandidateRoot(options.candidate)
    const config = await readCase(options.caseId)
    await inspectCandidate(candidate)
    const result = await runChild(config.id, candidate)
    if (!result.ok) throw new Error(result.error || "held-out verification failed")
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else process.stdout.write(`verified ${result.case_id} (${result.checks.length} checks)\n`)
  } catch (error) {
    const message = boundedMessage(error?.message ?? error, options?.candidate)
    if (options?.json) process.stdout.write(`${JSON.stringify({ ok: false, case_id: options.caseId ?? null, error: message })}\n`)
    else process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

async function childMain(argv) {
  const [caseId, candidate, ...extra] = argv
  let result
  try {
    if (extra.length || !caseId || !candidate) throw new Error("invalid verifier child arguments")
    const config = await readCase(caseId)
    const root = await safeCandidateRoot(candidate)
    const checks = await verify(config.id, root)
    result = { ok: true, case_id: config.id, checks }
  } catch (error) {
    result = { ok: false, case_id: caseId ?? null, error: boundedMessage(error?.message ?? error, candidate) }
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function parseArgs(argv) {
  const options = { caseId: null, candidate: null, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === "--json") options.json = true
    else if (item === "--help" || item === "-h") options.help = true
    else if (item === "--case" && !options.caseId) options.caseId = argv[++index]
    else if (item === "--candidate" && !options.candidate) options.candidate = argv[++index]
    else throw new Error(`unknown or repeated argument: ${item ?? "<missing>"}`)
  }
  if (options.help) return options
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.caseId ?? "")) throw new Error("a safe --case ID is required")
  if (typeof options.candidate !== "string" || !path.isAbsolute(options.candidate)) {
    throw new Error("--candidate must be an explicit absolute path")
  }
  return options
}

async function readCase(caseId) {
  const directory = path.join(corpusRoot, caseId)
  if (!isWithin(corpusRoot, directory)) throw new Error("case escapes the bundled corpus")
  const file = path.join(directory, "case.json")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_FILE_BYTES) {
    throw new Error("case contract is not one bounded regular file")
  }
  const config = JSON.parse(await readFile(file, "utf8"))
  if (config?.schema_version !== 1 || config.id !== caseId) throw new Error("case contract has an unsupported identity")
  return config
}

async function safeCandidateRoot(value) {
  const resolved = path.resolve(value)
  const info = await lstat(resolved)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("candidate root must be one real directory")
  const actual = path.resolve(await realpath(resolved))
  if (pathKey(actual) !== pathKey(resolved)) throw new Error("candidate root cannot be redirected")
  if (isWithin(repositoryRoot, actual)) throw new Error("candidate root must be disposable and outside the source repository")
  return actual
}

async function inspectCandidate(root) {
  const source = path.join(root, "src")
  let files = []
  try { files = await regularFiles(source) }
  catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  for (const file of files.filter((item) => /\.(?:js|mjs|cjs)$/i.test(item))) {
    const text = await readFile(file, "utf8")
    if (
      /\b(?:fetch|WebSocket|EventSource)\s*\(/.test(text) ||
      /\b(?:from|import\s*\()\s*["'](?:node:)?(?:http|https|net|tls|dgram|dns|undici)(?:["'/])/.test(text)
    ) throw new Error(`network access is forbidden in ${relative(root, file)}`)
  }
  const packageFile = path.join(root, "package.json")
  try {
    const info = await lstat(packageFile)
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_FILE_BYTES) {
      throw new Error("package.json must be one bounded regular file")
    }
    const packageJson = JSON.parse(await readFile(packageFile, "utf8"))
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (packageJson[field] && Object.keys(packageJson[field]).length) throw new Error(`${field} are forbidden in the evaluation corpus`)
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

async function regularFiles(root) {
  const output = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name)
      const info = await lstat(location)
      if (info.isSymbolicLink()) throw new Error(`linked candidate entry is forbidden: ${relative(root, location)}`)
      if (info.isDirectory()) await visit(location)
      else if (info.isFile() && Number(info.nlink) === 1 && info.size <= MAX_FILE_BYTES) output.push(location)
      else throw new Error(`unsafe or oversized candidate file: ${relative(root, location)}`)
      if (output.length > MAX_FILES) throw new Error(`candidate src is limited to ${MAX_FILES} files`)
    }
  }
  await visit(root)
  return output
}

async function runChild(caseId, candidate) {
  return new Promise((resolve, reject) => {
    const environment = { NO_COLOR: "1", OCP_EVALUATION_NO_NETWORK: "1" }
    for (const name of ["SystemRoot", "WINDIR"]) {
      if (typeof process.env[name] === "string") environment[name] = process.env[name]
    }
    const child = spawn(process.execPath, [scriptFile, "--child", caseId, candidate], {
      cwd: candidate,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let overflow = false
    const collect = (target) => (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill("SIGKILL")
      } else target.push(Buffer.from(chunk))
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.once("error", reject)
    const timeout = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (overflow) return reject(new Error("held-out verifier exceeded its output limit"))
      const output = Buffer.concat(stdout).toString("utf8").trim()
      try {
        const result = JSON.parse(output)
        if (code !== 0 && result.ok !== false) throw new Error("verifier child failed without a bounded result")
        resolve(result)
      } catch {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
        reject(new Error(diagnostic || "held-out verifier returned invalid output"))
      }
    })
  })
}

async function verify(caseId, root) {
  switch (caseId) {
    case "greenfield": return verifyGreenfield(root)
    case "feature": return verifyFeature(root)
    case "bug-repair": return verifyBugRepair(root)
    case "external-integration": return verifyExternalIntegration(root)
    case "blueprint-migration": return verifyBlueprintMigration(root)
    case "interruption-recovery": return verifyInterruptionRecovery(root)
    case "failed-verification": return verifyFailedVerification(root)
    default: throw new Error(`unsupported evaluation case: ${caseId}`)
  }
}

async function verifyGreenfield(root) {
  const { normalizePolicyId } = await load(root, "src/normalize-policy-id.mjs")
  assert.equal(normalizePolicyId("  ab_12 policy  "), "AB-12-POLICY")
  assert.equal(normalizePolicyId("POL-9"), "POL-9")
  for (const value of ["", "A--B", "A/B", null, 42]) assert.throws(() => normalizePolicyId(value))
  return ["normalizes segments", "preserves valid IDs", "rejects malformed input"]
}

async function verifyFeature(root) {
  const { activePolicyIds, summarizeActivePremiums } = await load(root, "src/policies.mjs")
  const policies = [
    { id: "A", active: true, premium_cents: 1250 },
    { id: "B", active: false, premium_cents: -1 },
    { id: "C", active: true, premium_cents: 2750 },
  ]
  const before = JSON.stringify(policies)
  assert.deepEqual(activePolicyIds(policies), ["A", "C"])
  assert.deepEqual(summarizeActivePremiums(policies, "USD"), { active_count: 2, total_cents: 4000, currency: "USD" })
  assert.equal(JSON.stringify(policies), before)
  assert.throws(() => summarizeActivePremiums([{ active: true, premium_cents: -1 }], "USD"))
  assert.throws(() => summarizeActivePremiums([], "usd"))
  return ["preserves existing behavior", "summarizes active premiums", "validates without mutation"]
}

async function verifyBugRepair(root) {
  const { shouldNotifyRenewal } = await load(root, "src/renewal-window.mjs")
  for (const value of [0, 1, 29, 30]) assert.equal(shouldNotifyRenewal(value), true)
  for (const value of [-1, 30.5, 31, "30", NaN]) assert.equal(shouldNotifyRenewal(value), false)
  return ["includes both renewal boundaries", "rejects values outside the integer window"]
}

async function verifyExternalIntegration(root) {
  const { createZohoCrmAdapter } = await load(root, "src/crm/zoho.mjs")
  const calls = []
  const adapter = createZohoCrmAdapter({
    request: async (message) => {
      calls.push(message)
      if (message.method === "GET") return { status: 200, body: { data: [{ id: 7, Full_Name: "Ana", Email: "ana@example.invalid" }] } }
      return { status: 201, body: { data: [{ details: { id: "N9" } }] } }
    },
  })
  assert.deepEqual(await adapter.getContact("A/B"), { id: "7", name: "Ana", email: "ana@example.invalid" })
  assert.equal(await adapter.addNote("7", "Call completed"), "N9")
  assert.deepEqual(calls, [
    { method: "GET", path: "/crm/v2/Contacts/A%2FB", body: null },
    { method: "POST", path: "/crm/v2/Notes", body: { data: [{ Parent_Id: { id: "7" }, Note_Content: "Call completed" }] } },
  ])
  const failing = createZohoCrmAdapter({ request: async () => ({ status: 503, body: null }) })
  await assert.rejects(failing.getContact("7"), /503/)
  assert.throws(() => createZohoCrmAdapter())
  return ["uses only the injected transport", "preserves the CRM contract", "maps bounded provider failures"]
}

async function verifyBlueprintMigration(root) {
  const protectedFiles = [
    "blueprints/v1/blueprint.json",
    "blueprints/v2/blueprint.json",
    "blueprints/v2/migration-plan.json",
    "blueprints/current/blueprint.json",
    "blueprints/current/record.json",
  ]
  for (const relativePath of protectedFiles) {
    assert.equal(
      await readFile(await safeFile(root, relativePath), "utf8"),
      await readFile(path.join(corpusRoot, "blueprint-migration", "seed", ...relativePath.split("/")), "utf8"),
      `${relativePath} must preserve the finalized Blueprint v2 contract byte-for-byte`,
    )
  }
  const v1 = await json(root, "blueprints/v1/blueprint.json")
  const v2 = await json(root, "blueprints/v2/blueprint.json")
  const current = await json(root, "blueprints/current/blueprint.json")
  const record = await json(root, "blueprints/current/record.json")
  const plan = await json(root, "blueprints/v2/migration-plan.json")
  assert.equal(v1.version, 1)
  assert.equal(v1.architecture.crm, "Twenty CRM")
  assert.equal(v2.version, 2)
  assert.deepEqual(v2.supported_languages, ["en", "es"])
  assert.equal(v2.architecture.crm, "Zoho CRM")
  assert.equal(v2.architecture.dialer, "Kixie")
  assert.deepEqual(current, v2)
  assert.equal(record.version, 2)
  assert.equal(record.migration_history.at(-1)?.from_version, 1)
  assert.equal(plan.compatibility, "breaking")
  assert.equal(plan.risk, "medium")
  assert.ok(plan.operations.remove.includes("TwentyCRMProvider"))
  assert.ok(plan.operations.create.includes("ZohoCRMProvider"))
  assert.ok(plan.operations.create.includes("KixieDialer"))
  assert.ok(plan.environment.remove.includes("TWENTY_CRM_TOKEN"))
  assert.ok(plan.environment.add.includes("ZOHO_CRM_CLIENT_ID"))
  assert.ok(plan.unaffected.includes("Authentication") && plan.unaffected.includes("Database"))
  assert.equal(typeof plan.rollback, "string")
  assert.ok(plan.rollback.length > 20)
  const { providers, environmentVariables } = await load(root, "src/integrations.mjs")
  assert.deepEqual(providers, { crm: "zoho", dialer: "kixie" })
  assert.ok(environmentVariables.includes("KIXIE_API_KEY"))
  assert.equal(environmentVariables.includes("TWENTY_CRM_TOKEN"), false)
  const { catalogs, translate } = await load(root, "src/i18n.mjs")
  assert.deepEqual(Object.keys(catalogs), ["en", "es"])
  assert.equal(translate("es", "greeting"), "Hola")
  assert.equal(translate("unknown", "follow_up"), "Follow up")
  assert.equal(
    await readFile(path.join(root, "src", "auth.mjs"), "utf8"),
    await readFile(path.join(corpusRoot, "blueprint-migration", "seed", "src", "auth.mjs"), "utf8"),
  )
  assert.equal(
    await readFile(path.join(root, "src", "database.mjs"), "utf8"),
    await readFile(path.join(corpusRoot, "blueprint-migration", "seed", "src", "database.mjs"), "utf8"),
  )
  return ["preserves the finalized Blueprint v2 contract", "keeps Blueprint v1 and rollback history", "updates providers and locales", "preserves unaffected modules"]
}

async function verifyInterruptionRecovery(root) {
  const { appendCallEvent, resumeCallLog } = await load(root, "src/call-log.mjs")
  const log = [{ id: "A", value: "first" }, { id: "A", value: "duplicate" }]
  const events = [{ id: "A", value: "replay" }, { id: "B", value: "new" }, { id: "B", value: "duplicate" }]
  const before = JSON.stringify({ log, events })
  const resumed = resumeCallLog(log, events)
  assert.deepEqual(resumed, [{ id: "A", value: "first" }, { id: "B", value: "new" }])
  assert.deepEqual(resumeCallLog(resumed, events), resumed)
  assert.equal(JSON.stringify({ log, events }), before)
  assert.deepEqual(appendCallEvent([], { id: "C" }), [{ id: "C" }])
  assert.throws(() => resumeCallLog([], [{ value: "missing ID" }]))
  return ["deduplicates replayed events", "is idempotent after resume", "preserves input and validates events"]
}

async function verifyFailedVerification(root) {
  const { commissionCents } = await load(root, "src/commission.mjs")
  assert.equal(commissionCents(10_000, 125), 125)
  assert.equal(commissionCents(1, 5_000), 1)
  assert.equal(commissionCents(1, 4_999), 0)
  assert.equal(commissionCents(Number.MAX_SAFE_INTEGER, 10_000), Number.MAX_SAFE_INTEGER)
  for (const args of [[-1, 100], [1.5, 100], [1, -1], [1, 10_001], [1, 1.5]]) {
    assert.throws(() => commissionCents(...args))
  }
  return ["calculates basis points exactly", "rounds half up", "rejects unsafe inputs"]
}

async function load(root, relativePath) {
  const file = await safeFile(root, relativePath)
  return import(`${pathToFileURL(file).href}?evaluation=${Date.now()}-${Math.random()}`)
}

async function json(root, relativePath) {
  const file = await safeFile(root, relativePath)
  return JSON.parse(await readFile(file, "utf8"))
}

async function safeFile(root, relativePath) {
  const file = path.resolve(root, ...relativePath.split("/"))
  if (!isWithin(root, file)) throw new Error("verification path escapes the candidate")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_FILE_BYTES) {
    throw new Error(`required candidate file is unsafe: ${relativePath}`)
  }
  return file
}

function isWithin(parent, candidate) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate))
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function boundedMessage(value, candidate) {
  let message = String(value ?? "verification failed").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
  if (candidate) message = message.replaceAll(path.resolve(candidate), "<candidate>")
  return message.replace(/\s+/g, " ").trim().slice(0, 2000) || "verification failed"
}
