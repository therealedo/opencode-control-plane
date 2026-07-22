import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import path from "node:path"

const defineTool = (definition) => definition
const decorateSchema = (value) => {
  const next = (update) => decorateSchema({ ...value, ...update })
  const methods = {
    int: () => next({ type: "integer" }),
    min: (minimum) => next(value.type === "string"
      ? { minLength: minimum }
      : value.type === "array" ? { minItems: minimum } : { minimum }),
    max: (maximum) => next(value.type === "string"
      ? { maxLength: maximum }
      : value.type === "array" ? { maxItems: maximum } : { maximum }),
    optional: () => decorateSchema({ anyOf: [{ ...value }, { type: "null" }] }),
    nullable: () => decorateSchema({ anyOf: [{ ...value }, { type: "null" }] }),
    regex: (expression) => next({ pattern: expression.source }),
  }
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(value, name, { value: method, enumerable: false })
  }
  return value
}
const schema = {
  string: () => decorateSchema({ type: "string" }),
  number: () => decorateSchema({ type: "number" }),
  boolean: () => decorateSchema({ type: "boolean" }),
  enum: (values) => decorateSchema({ type: "string", enum: [...values] }),
  array: (items) => decorateSchema({ type: "array", items: { ...items } }),
  object: (properties) => decorateSchema({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
}

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_SEARCH_FILES = 4000
const MAX_SEARCH_BYTES = 64 * 1024 * 1024
const DEFAULT_READ_LINES = 120
const MAX_READ_LINES = 300
const DEFAULT_LIST_RESULTS = 200
const MAX_LIST_RESULTS = 500
const DEFAULT_SEARCH_RESULTS = 50
const MAX_SEARCH_RESULTS = 100
const DEFAULT_PHASE_RETURNED_BYTES = 64 * 1024
const CONTRACT_RETURN_RESERVE = 2 * 1024
const MAX_FEEDBACK_CALLS = 2
const MAX_MODE_INTENTS = 64
const MAX_PATH_INPUT_BYTES = 4096
const MAX_CURSOR = MAX_SEARCH_BYTES
const MODE_INTENT_PATH = ".autopilot/runtime/mode-intent.json"

function feedbackPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) {
    throw new Error("AUTOPILOT_TOOL_POLICY feedback_gates is invalid")
  }
  const normalized = {}
  for (const [gateId, gate] of Object.entries(value)) {
    exactKeys(gate, ["definition_sha256", "timeout_seconds"], `feedback gate ${gateId}`)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gateId) ||
      typeof gate.definition_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(gate.definition_sha256) ||
      !Number.isSafeInteger(gate.timeout_seconds) ||
      gate.timeout_seconds < 1 || gate.timeout_seconds > 3600
    ) throw new Error("AUTOPILOT_TOOL_POLICY feedback_gates is invalid")
    normalized[gateId] = Object.freeze({ ...gate })
  }
  return Object.freeze(normalized)
}

const policy = (() => {
  const encoded = process.env.AUTOPILOT_TOOL_POLICY
  if (!encoded) throw new Error("AUTOPILOT_TOOL_POLICY is missing")
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  const maxReturnedBytes = value?.max_returned_bytes ?? DEFAULT_PHASE_RETURNED_BYTES
  const normalizedFeedbackGates = feedbackPolicy(value?.feedback_gates)
  if (
    value?.schema_version !== 1 ||
    typeof value.root !== "string" ||
    typeof value.task_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.task_id) ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    typeof value.baseline_head !== "string" ||
    !/^[0-9a-fA-F]{40,64}$/.test(value.baseline_head) ||
    !Array.isArray(value.allowed_paths) ||
    typeof value.contract_path !== "string" ||
    !["execute", "repair", "review"].includes(value.phase) ||
    !Number.isSafeInteger(maxReturnedBytes) ||
    maxReturnedBytes < MAX_OUTPUT_BYTES ||
    maxReturnedBytes > 1024 * 1024 ||
    typeof value.feedback_runner !== "string" ||
    !path.isAbsolute(value.feedback_runner) ||
    value.feedback_runner.includes("\0") ||
    !Number.isSafeInteger(value.max_feedback_calls) ||
    value.max_feedback_calls < 0 || value.max_feedback_calls > MAX_FEEDBACK_CALLS ||
    (value.phase === "review" && (
      value.max_feedback_calls !== 0 || Object.keys(normalizedFeedbackGates).length !== 0
    )) ||
    (Object.keys(normalizedFeedbackGates).length === 0 && value.max_feedback_calls !== 0) ||
    (value.usage_path !== undefined && (
      typeof value.usage_path !== "string" ||
      !path.isAbsolute(value.usage_path) ||
      value.usage_path.includes("\0")
    )) ||
    !Array.isArray(value.git_argv) || value.git_argv.length < 1 || value.git_argv.length > 8 ||
    !path.isAbsolute(value.git_argv[0] ?? "") ||
    value.git_argv.some((argument) =>
      typeof argument !== "string" || !argument || /[\0\r\n]/.test(argument)
    )
  ) throw new Error("AUTOPILOT_TOOL_POLICY is invalid")
  return Object.freeze({
    ...value,
    root: path.resolve(value.root),
    allowed_paths: Object.freeze([...value.allowed_paths]),
    max_returned_bytes: maxReturnedBytes,
    usage_path: value.usage_path ? path.resolve(value.usage_path) : null,
    feedback_runner: path.resolve(value.feedback_runner),
    feedback_gates: normalizedFeedbackGates,
    git_argv: Object.freeze([...value.git_argv]),
  })
})()

const usage = {
  schema_version: 1,
  phase: policy.phase,
  task_id: policy.task_id,
  tool_calls: 0,
  returned_bytes: 0,
  by_tool: {},
}
let usageWrite = Promise.resolve()
let contractCommitted = false
const modeIntents = new Map()

function normalize(value, label = "path") {
  const result = String(value).replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !result || path.isAbsolute(result) || result.startsWith("/") || /^[A-Za-z]:/.test(result) ||
    /[\0-\x1f\x7f:*?\[\]<>"|]/.test(result)
  ) throw new Error(`${label} is not a portable project-relative path`)
  for (const part of result.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part)) {
      throw new Error(`${label} contains an unsafe path segment`)
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`${label} contains a reserved filename`)
    }
  }
  return result
}

function sensitive(relative) {
  const normalized = normalize(relative).toLowerCase()
  const parts = normalized.split("/")
  const basename = parts.at(-1)
  if ([".git", ".project", ".autopilot", ".opencode", ".agents"].includes(parts[0])) return true
  if (["agents.md", ".ignore", ".gitignore", ".gitattributes", ".gitmodules", "opencode.json", "opencode.jsonc"].includes(normalized)) return true
  if (parts.some((part) => [".gitignore", ".gitattributes", ".gitmodules"].includes(part))) return true
  if (parts.some((part) => part.startsWith(".env")) && basename !== ".env.example") return true
  return /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(basename)
}

function globRegex(pattern) {
  const source = normalizeGlob(pattern)
  let result = "^"
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "*") {
      if (source[index + 1] === "*") {
        index += 1
        if (source[index + 1] === "/") { index += 1; result += "(?:.*/)?" }
        else result += ".*"
      } else result += "[^/]*"
    } else result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`${result}$`)
}

function normalizeGlob(value) {
  const result = String(value).replaceAll("\\", "/").replace(/^\.\//, "")
  if (!result || path.isAbsolute(result) || result.startsWith("/") || /[\0-\x1f\x7f:?\[\]<>"|]/.test(result)) {
    throw new Error("allowed path policy is invalid")
  }
  return result
}

function allowedWrite(relative) {
  return policy.allowed_paths.some((pattern) => globRegex(pattern).test(relative))
}

function git(args, { maxBuffer = 8 * 1024 * 1024, input } = {}) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null"
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR", "FORCE_COLOR",
  ])
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => allowed.has(name) && typeof value === "string"),
  )
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    SSH_ASKPASS_REQUIRE: "never",
  })
  const hardened = [
    "--no-pager", "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "credential.interactive=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", `core.excludesFile=${nullDevice}`,
  ]
  return spawnSync(policy.git_argv[0], [...policy.git_argv.slice(1), ...hardened, ...args], {
    cwd: policy.root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer,
    ...(input === undefined ? {} : { input }),
  })
}

function ignored(relative) {
  const result = git(["check-ignore", "--no-index", "--quiet", "--", relative])
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error("git check-ignore failed")
}

async function assertInside(absolute, label) {
  const [root, target] = await Promise.all([realpath(policy.root), realpath(absolute)])
  const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value
  const base = fold(path.resolve(root))
  const actual = fold(path.resolve(target))
  if (actual !== base && !actual.startsWith(`${base}${path.sep}`)) throw new Error(`${label} resolves outside the project`)
}

async function assertSafeParents(relative, { create = false } = {}) {
  const parts = relative.split("/").slice(0, -1)
  let cursor = policy.root
  for (const part of parts) {
    cursor = path.join(cursor, part)
    let info
    try { info = await lstat(cursor) }
    catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error
      await mkdir(cursor)
      info = await lstat(cursor)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Path traverses an unsafe directory: ${relative}`)
    await assertInside(cursor, `parent of ${relative}`)
  }
}

async function safeFile(relative, { optional = false } = {}) {
  const normalized = normalize(relative)
  if (sensitive(normalized) || ignored(normalized)) throw new Error(`Protected or ignored path is unavailable: ${normalized}`)
  await assertSafeParents(normalized)
  const absolute = path.join(policy.root, ...normalized.split("/"))
  let info
  try { info = await lstat(absolute) }
  catch (error) {
    if (optional && error?.code === "ENOENT") return { relative: normalized, absolute, info: null }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
    throw new Error(`Path must be one private regular file: ${normalized}`)
  }
  await assertInside(absolute, normalized)
  return { relative: normalized, absolute, info }
}

function sameIdentity(left, right) {
  if (process.platform === "win32") {
    return String(left.ino) !== "0" && String(left.ino) === String(right.ino)
  }
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

async function openSafeFile(relative) {
  const file = await safeFile(relative)
  let handle
  try {
    handle = await open(file.absolute, "r")
    const [opened, current] = await Promise.all([handle.stat(), lstat(file.absolute)])
    if (
      !opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
      Number(opened.nlink) > 1 || Number(current.nlink) > 1 ||
      !sameIdentity(file.info, opened) || !sameIdentity(opened, current)
    ) throw new Error(`Path identity changed while opening: ${file.relative}`)
    await assertInside(file.absolute, file.relative)
    return { ...file, info: opened, handle }
  } catch (error) {
    await handle?.close().catch(() => {})
    throw error
  }
}

async function readOpenedFile(file, maxBytes) {
  if (file.info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
  const bytes = await file.handle.readFile()
  if (bytes.length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
  return bytes
}

function ignoredApplicationPaths(files) {
  if (files.length === 0) return new Set()
  const result = git(
    ["check-ignore", "--no-index", "-z", "--stdin"],
    { maxBuffer: 32 * 1024 * 1024, input: `${files.join("\0")}\0` },
  )
  if (result.error) throw result.error
  if (![0, 1].includes(result.status)) throw new Error("git check-ignore failed")
  return new Set(result.stdout.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/")))
}

function applicationFiles() {
  const result = git(["ls-files", "-c", "-o", "--exclude-standard", "-z"], { maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error("git ls-files failed")
  const files = [...new Set(result.stdout.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/")))]
    .filter((item) => {
      try { return !sensitive(item) } catch { return false }
    })
  const ignoredPaths = ignoredApplicationPaths(files)
  return files.filter((item) => !ignoredPaths.has(item)).sort()
}

function nulPaths(value) {
  return value.split("\0").filter(Boolean).map((item) => normalize(item))
}

function contractChangedFiles() {
  const tracked = git(["diff", "--name-only", "-z", "--no-renames", policy.baseline_head, "--"])
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
  for (const [label, result] of [["tracked diff", tracked], ["untracked files", untracked]]) {
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Cannot derive phase contract ${label}`)
  }
  const files = [...new Set([
    ...nulPaths(tracked.stdout),
    ...nulPaths(untracked.stdout),
    ...modeIntents.keys(),
  ])].filter((file) => file !== MODE_INTENT_PATH).sort()
  if (files.length > 256) throw new Error("Phase changed_files exceeds 256 entries")
  return files
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}`)
  }
}

function argumentKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field: ${key}`)
  }
}

function inputString(value, label, {
  allowEmpty = false,
  maxBytes = MAX_PATH_INPUT_BYTES,
  maxCharacters = null,
} = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    (maxCharacters !== null && value.length > maxCharacters)
  ) throw new Error(`${label} must be a bounded${allowEmpty ? "" : " non-empty"} string`)
  return value
}

function optionalString(args, key, label, options = {}) {
  if (!Object.hasOwn(args, key) || args[key] === null) return null
  return inputString(args[key], label, options)
}

function optionalInteger(args, key, label, {
  minimum,
  maximum,
  fallback,
}) {
  if (!Object.hasOwn(args, key) || args[key] === null) return fallback
  const value = args[key]
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function readInput(args) {
  argumentKeys(args, ["path"], ["offset", "column", "limit"], "read input")
  const relative = normalize(inputString(args.path, "read path"))
  return {
    relative,
    offset: optionalInteger(args, "offset", "read offset", {
      minimum: 1, maximum: MAX_CURSOR, fallback: 1,
    }),
    column: optionalInteger(args, "column", "read column", {
      minimum: 1, maximum: MAX_CURSOR, fallback: 1,
    }),
    limit: optionalInteger(args, "limit", "read limit", {
      minimum: 1, maximum: MAX_READ_LINES, fallback: DEFAULT_READ_LINES,
    }),
  }
}

function listInput(args) {
  argumentKeys(args, [], ["prefix", "offset", "max_results"], "list input")
  const rawPrefix = optionalString(args, "prefix", "list prefix", { allowEmpty: true })
  return {
    prefix: rawPrefix ? normalize(rawPrefix, "prefix") : "",
    offset: optionalInteger(args, "offset", "list offset", {
      minimum: 0, maximum: MAX_CURSOR, fallback: 0,
    }),
    maxResults: optionalInteger(args, "max_results", "list max_results", {
      minimum: 1, maximum: MAX_LIST_RESULTS, fallback: DEFAULT_LIST_RESULTS,
    }),
  }
}

function searchInput(args) {
  argumentKeys(args, ["pattern"], ["prefix", "offset", "max_results"], "search input")
  const rawPrefix = optionalString(args, "prefix", "search prefix", { allowEmpty: true })
  return {
    pattern: inputString(args.pattern, "search pattern", { maxBytes: 2048, maxCharacters: 512 }),
    prefix: rawPrefix ? normalize(rawPrefix, "prefix") : "",
    offset: optionalInteger(args, "offset", "search offset", {
      minimum: 0, maximum: MAX_CURSOR, fallback: 0,
    }),
    maxResults: optionalInteger(args, "max_results", "search max_results", {
      minimum: 1, maximum: MAX_SEARCH_RESULTS, fallback: DEFAULT_SEARCH_RESULTS,
    }),
  }
}

function writeInput(args) {
  argumentKeys(args, ["path", "content"], [], "write input")
  return {
    relative: normalize(inputString(args.path, "write path")),
    content: inputString(args.content, "write content", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES }),
  }
}

function editInput(args) {
  argumentKeys(args, ["path", "old_text", "new_text"], [], "edit input")
  return {
    relative: normalize(inputString(args.path, "edit path")),
    oldText: inputString(args.old_text, "edit old_text", { maxBytes: MAX_WRITE_BYTES }),
    newText: inputString(args.new_text, "edit new_text", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES }),
  }
}

function boundedContractText(value, label, maxBytes = 2048) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be bounded single-line-safe text`)
  }
  return value
}

function candidateValue(args) {
  exactKeys(args, ["status", "summary", "environment_variables", "blocker"], "candidate input")
  if (!["complete", "blocked", "failed"].includes(args.status)) throw new Error("candidate status is invalid")
  const environment = args.environment_variables ?? []
  if (!Array.isArray(environment) || environment.length > 64) throw new Error("environment_variables must contain at most 64 names")
  const normalizedEnvironment = []
  for (const name of environment) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("environment_variables must contain exact names only")
    }
    if (normalizedEnvironment.includes(name)) throw new Error(`environment_variables repeats ${name}`)
    normalizedEnvironment.push(name)
  }
  let blocker = null
  if (args.status === "blocked") {
    exactKeys(args.blocker, ["kind", "message", "required_action", "resume_condition"], "blocker")
    blocker = Object.fromEntries(Object.entries(args.blocker).map(([key, value]) => [
      key,
      boundedContractText(value, `blocker.${key}`),
    ]))
  } else if (args.blocker !== null && args.blocker !== undefined) {
    throw new Error("blocker is allowed only for blocked status")
  }
  return {
    schema_version: 1,
    task_id: policy.task_id,
    attempt: policy.attempt,
    status: args.status,
    summary: boundedContractText(args.summary, "summary"),
    changed_files: contractChangedFiles(),
    environment_variables: normalizedEnvironment.sort(),
    blocker,
  }
}

function reviewValue(args) {
  exactKeys(args, ["status", "summary", "findings"], "review input")
  if (!["approved", "changes_requested", "blocked"].includes(args.status)) throw new Error("review status is invalid")
  if (!Array.isArray(args.findings) || args.findings.length > 64) throw new Error("findings must contain at most 64 entries")
  const findings = args.findings.map((finding, index) => {
    exactKeys(finding, ["severity", "file", "message"], `findings.${index}`)
    if (!["low", "medium", "high", "critical"].includes(finding.severity)) {
      throw new Error(`findings.${index}.severity is invalid`)
    }
    return {
      severity: finding.severity,
      file: boundedContractText(finding.file, `findings.${index}.file`, 512),
      message: boundedContractText(finding.message, `findings.${index}.message`),
    }
  })
  if (args.status === "approved" && findings.some((finding) => finding.severity !== "low")) {
    throw new Error("review cannot approve with medium, high, or critical findings")
  }
  return {
    schema_version: 1,
    task_id: policy.task_id,
    status: args.status,
    summary: boundedContractText(args.summary, "summary"),
    findings,
  }
}

function utf8Prefix(text, maxBytes) {
  const value = String(text)
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const safeMiddle = /[\uD800-\uDBFF]/.test(value[middle - 1] ?? "") ? middle - 1 : middle
    if (Buffer.byteLength(value.slice(0, safeMiddle), "utf8") <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1
  return value.slice(0, end)
}

async function atomicReplace(file, contents, mode = 0o600) {
  const temporary = `${file}.autopilot-${process.pid}-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12)}.tmp`
  const handle = await open(temporary, "wx", mode)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally { await handle.close().catch(() => {}) }
  try { await rename(temporary, file) }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error }
}

async function persistUsage() {
  if (!policy.usage_path) return
  const snapshot = `${JSON.stringify(usage)}\n`
  usageWrite = usageWrite.then(() => atomicReplace(policy.usage_path, snapshot))
  await usageWrite
}

async function beginTool(name) {
  if (name === "check" && (usage.by_tool.check?.calls ?? 0) >= policy.max_feedback_calls) {
    throw new Error(`autopilot_check is limited to ${policy.max_feedback_calls} calls in this phase`)
  }
  usage.tool_calls += 1
  usage.by_tool[name] ??= { calls: 0, returned_bytes: 0 }
  usage.by_tool[name].calls += 1
  await persistUsage()
}

async function returned(name, value, { contract = false } = {}) {
  const output = String(value)
  const bytes = Buffer.byteLength(output, "utf8")
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Tool page exceeds ${MAX_OUTPUT_BYTES} bytes; lower limit/max_results or continue with a narrower range`)
  }
  const available = policy.max_returned_bytes - (contract ? 0 : CONTRACT_RETURN_RESERVE)
  if (usage.returned_bytes + bytes > available) {
    await persistUsage()
    throw new Error(
      `Tool output was not returned: phase byte budget ${policy.max_returned_bytes} would be exceeded ` +
      `(${usage.returned_bytes} used, ${bytes} requested). Scope is too broad; narrow the prefix/range ` +
      "or paginate with offset/max_results. If enough evidence exists, write the phase contract now.",
    )
  }
  usage.returned_bytes += bytes
  usage.by_tool[name].returned_bytes += bytes
  await persistUsage()
  return output
}

function readPage(relative, lines, offset, limit, column) {
  if (offset > lines.length) {
    return `[read ${relative} range=empty total=${lines.length} next=end]`
  }
  const first = lines[offset - 1]
  if (column > first.length + 1) throw new Error(`column exceeds line ${offset}`)

  const payloadLimit = MAX_OUTPUT_BYTES - 512
  const requestedEnd = Math.min(lines.length, offset - 1 + limit)
  let lineIndex = offset - 1
  let columnIndex = column - 1
  let payload = ""
  let hasLine = false
  let last = `${offset}:${column}`
  let next = "end"

  while (lineIndex < requestedEnd) {
    const source = lines[lineIndex]
    const segment = source.slice(columnIndex)
    const separator = hasLine ? "\n" : ""
    const candidate = `${payload}${separator}${segment}`
    if (Buffer.byteLength(candidate, "utf8") <= payloadLimit) {
      payload = candidate
      hasLine = true
      last = `${lineIndex + 1}:${source.length + 1}`
      lineIndex += 1
      columnIndex = 0
      continue
    }

    const remaining = payloadLimit - Buffer.byteLength(`${payload}${separator}`, "utf8")
    const piece = utf8Prefix(segment, remaining)
    if (!piece && !hasLine) throw new Error("Requested line cannot fit a bounded page; advance column or narrow the range")
    payload = `${payload}${separator}${piece}`
    hasLine = true
    columnIndex += piece.length
    last = `${lineIndex + 1}:${columnIndex}`
    next = `${lineIndex + 1}:${columnIndex + 1}`
    break
  }

  if (next === "end" && lineIndex < lines.length) next = `${lineIndex + 1}:1`
  const header = `[read ${relative} range=${offset}:${column}-${last} total=${lines.length} next=${next}]`
  return payload ? `${header}\n${payload}` : header
}

function pageLines(lines, offset, maxResults) {
  const selected = []
  let bytes = 0
  for (const line of lines.slice(offset, offset + maxResults)) {
    const added = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0)
    if (bytes + added > MAX_OUTPUT_BYTES - 512) break
    selected.push(line)
    bytes += added
  }
  return selected
}

export const read = defineTool({
  description: "Read a raw-text page from one non-ignored application file. Continue with the reported next line:column cursor.",
  args: {
    path: schema.string(),
    offset: schema.number().int().min(1).optional(),
    column: schema.number().int().min(1).optional(),
    limit: schema.number().int().min(1).max(MAX_READ_LINES).optional(),
  },
  async execute(args) {
    const input = readInput(args)
    await beginTool("read")
    const file = await openSafeFile(input.relative)
    try {
      const lines = (await readOpenedFile(file, MAX_READ_BYTES)).toString("utf8").split(/\r?\n/)
      return await returned("read", readPage(file.relative, lines, input.offset, input.limit, input.column))
    } finally { await file.handle.close() }
  },
})

export const list = defineTool({
  description: "List a bounded page of non-ignored application paths; continue with the reported next offset.",
  args: {
    prefix: schema.string().optional(),
    offset: schema.number().int().min(0).optional(),
    max_results: schema.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
  },
  async execute(args) {
    const input = listInput(args)
    await beginTool("list")
    const files = applicationFiles().filter((file) => !input.prefix || file === input.prefix || file.startsWith(`${input.prefix}/`))
    const selected = pageLines(files, input.offset, input.maxResults)
    if (selected.length === 0 && input.offset < files.length) {
      throw new Error("One path cannot fit a bounded list page; provide a narrower prefix")
    }
    const next = input.offset + selected.length < files.length ? input.offset + selected.length : "end"
    const header = `[list offset=${input.offset} count=${selected.length} total=${files.length} next=${next}]`
    return await returned("list", selected.length > 0 ? `${header}\n${selected.join("\n")}` : header)
  },
})

export const search = defineTool({
  description: "Search a bounded page of non-ignored application text; continue with the reported next match offset.",
  args: {
    pattern: schema.string().min(1).max(512),
    prefix: schema.string().optional(),
    offset: schema.number().int().min(0).optional(),
    max_results: schema.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  },
  async execute(args) {
    const input = searchInput(args)
    await beginTool("search")
    const files = applicationFiles().filter((file) => !input.prefix || file === input.prefix || file.startsWith(`${input.prefix}/`))
    if (files.length > MAX_SEARCH_FILES) throw new Error(`Search scope exceeds ${MAX_SEARCH_FILES} files; provide a narrower prefix`)
    const output = []
    let scannedBytes = 0
    let outputBytes = 0
    let unavailable = 0
    let matchOffset = 0
    let hasMore = false
    outer:
    for (const relative of files) {
      let file
      try { file = await openSafeFile(relative) }
      catch { unavailable += 1; continue }
      try {
        if (file.info.size > MAX_READ_BYTES) continue
        scannedBytes += file.info.size
        if (scannedBytes > MAX_SEARCH_BYTES) throw new Error(`Search exceeds ${MAX_SEARCH_BYTES} bytes; provide a narrower prefix`)
        const bytes = await readOpenedFile(file, MAX_READ_BYTES)
        if (bytes.includes(0)) continue
        for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
          if (!line.includes(input.pattern)) continue
          if (matchOffset < input.offset) {
            matchOffset += 1
            continue
          }
          if (output.length >= input.maxResults) {
            hasMore = true
            break outer
          }
          const match = `${relative}:${index + 1}:${line}`
          const addedBytes = Buffer.byteLength(match, "utf8") + (output.length > 0 ? 1 : 0)
          if (outputBytes + addedBytes > MAX_OUTPUT_BYTES - 512) {
            if (output.length === 0) {
              throw new Error(
                `Match ${relative}:${index + 1} cannot fit a bounded search page; ` +
                `read that file at offset ${index + 1} and continue with its line:column cursor`,
              )
            }
            hasMore = true
            break outer
          }
          output.push(match)
          outputBytes += addedBytes
          matchOffset += 1
        }
      } finally { await file.handle.close() }
    }
    const next = hasMore ? input.offset + output.length : "end"
    const header = `[search offset=${input.offset} count=${output.length} next=${next} unavailable=${unavailable}]`
    return await returned("search", output.length > 0 ? `${header}\n${output.join("\n")}` : `${header}\nNo matches.`)
  },
})

export const write = defineTool({
  description: "Atomically write one task-allowlisted, non-ignored application file.",
  args: { path: schema.string(), content: schema.string() },
  async execute(args) {
    const input = writeInput(args)
    await beginTool("write")
    const { relative } = input
    if (!allowedWrite(relative) || sensitive(relative) || ignored(relative)) throw new Error(`Write path is outside the task boundary: ${relative}`)
    await assertSafeParents(relative, { create: true })
    const existing = await safeFile(relative, { optional: true })
    await assertSafeParents(relative)
    const response = await returned("write", `Wrote ${relative}`)
    await atomicReplace(existing.absolute, input.content, existing.info?.mode ?? 0o644)
    return response
  },
})

export const edit = defineTool({
  description: "Replace one exact occurrence in a task-allowlisted application file.",
  args: {
    path: schema.string(),
    old_text: schema.string().min(1),
    new_text: schema.string(),
  },
  async execute(args) {
    const input = editInput(args)
    await beginTool("edit")
    const { relative } = input
    if (!allowedWrite(relative)) throw new Error(`Edit path is outside the task boundary: ${relative}`)
    const file = await openSafeFile(relative)
    let current
    try { current = (await readOpenedFile(file, MAX_WRITE_BYTES)).toString("utf8") }
    finally { await file.handle.close() }
    const first = current.indexOf(input.oldText)
    if (first < 0 || current.indexOf(input.oldText, first + input.oldText.length) >= 0) {
      throw new Error("old_text must occur exactly once")
    }
    const next = `${current.slice(0, first)}${input.newText}${current.slice(first + input.oldText.length)}`
    if (Buffer.byteLength(next, "utf8") > MAX_WRITE_BYTES) throw new Error(`Edited file exceeds ${MAX_WRITE_BYTES} bytes`)
    await assertSafeParents(relative)
    const response = await returned("edit", `Edited ${relative}`)
    await atomicReplace(file.absolute, next, file.info.mode)
    return response
  },
})

function assertMutationShape(args) {
  exactKeys(args, ["operation", "path", "destination", "executable"], "mutation input")
  inputString(args.path, "mutation path")
  if (!["delete", "move", "executable"].includes(args.operation)) {
    throw new Error("mutation operation must be delete, move, or executable")
  }
  if (args.operation === "move") {
    if (typeof args.destination !== "string" || args.executable !== null) {
      throw new Error("move requires destination and executable=null")
    }
  } else if (args.operation === "executable") {
    if (args.destination !== null || typeof args.executable !== "boolean") {
      throw new Error("executable requires destination=null and a boolean executable value")
    }
  } else if (args.destination !== null || args.executable !== null) {
    throw new Error("delete requires destination=null and executable=null")
  }
}

function assertMutationPath(relative) {
  if (!allowedWrite(relative) || sensitive(relative) || ignored(relative)) {
    throw new Error(`Mutation path is outside the task boundary: ${relative}`)
  }
}

async function assertOpenedIdentity(file) {
  const current = await lstat(file.absolute)
  if (
    !current.isFile() || current.isSymbolicLink() || Number(current.nlink) > 1 ||
    !sameIdentity(file.info, current)
  ) throw new Error(`Path identity changed before mutation: ${file.relative}`)
  await assertInside(file.absolute, file.relative)
}

async function assertDestinationMissing(relative) {
  const absolute = path.join(policy.root, ...relative.split("/"))
  let info
  try { info = await lstat(absolute) }
  catch (error) { if (error?.code === "ENOENT") return absolute; throw error }
  if (info) throw new Error(`Move destination already exists: ${relative}`)
  return absolute
}

function baselineExecutable(relative) {
  const result = git(["ls-tree", "-z", policy.baseline_head, "--", relative])
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error("Cannot inspect baseline file mode")
  const record = result.stdout.split("\0").find(Boolean)
  if (!record) return null
  const match = /^(\d+)\s+blob\s+[0-9a-f]+\t/.exec(record)
  if (!match || !["100644", "100755"].includes(match[1])) {
    throw new Error(`Baseline path has an unsupported Git type: ${relative}`)
  }
  return match[1] === "100755"
}

function setModeIntent(relative, executable) {
  const baseline = baselineExecutable(relative)
  if ((baseline === null && executable === false) || baseline === executable) {
    modeIntents.delete(relative)
    return
  }
  if (!modeIntents.has(relative) && modeIntents.size >= MAX_MODE_INTENTS) {
    throw new Error(`Executable mode intent exceeds ${MAX_MODE_INTENTS} files`)
  }
  modeIntents.set(relative, executable)
}

function modeIntentValue() {
  return {
    schema_version: 1,
    task_id: policy.task_id,
    attempt: policy.attempt,
    intents: [...modeIntents.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([intentPath, executable]) => ({ path: intentPath, executable })),
  }
}

async function persistModeIntents() {
  const absolute = path.join(policy.root, ...MODE_INTENT_PATH.split("/"))
  await assertSafeParents(MODE_INTENT_PATH, { create: true })
  let existing = null
  try { existing = await lstat(absolute) } catch (error) { if (error?.code !== "ENOENT") throw error }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || Number(existing.nlink) > 1)) {
    throw new Error("Executable mode intent destination is not a private regular file")
  }
  if (existing) await assertInside(absolute, "executable mode intent")
  if (modeIntents.size === 0) {
    await rm(absolute, { force: true })
    return
  }
  await atomicReplace(absolute, `${JSON.stringify(modeIntentValue(), null, 2)}\n`, 0o600)
}

export const mutate = defineTool({
  description: "Delete, move, or toggle executability for one task-allowlisted private application file.",
  args: {
    operation: schema.enum(["delete", "move", "executable"]),
    path: schema.string(),
    destination: schema.string().nullable(),
    executable: schema.boolean().nullable(),
  },
  async execute(args) {
    assertMutationShape(args)
    const relative = normalize(args.path)
    const destination = args.operation === "move"
      ? normalize(inputString(args.destination, "mutation destination"), "destination")
      : null
    await beginTool("mutate")
    assertMutationPath(relative)
    const file = await openSafeFile(relative)
    let response
    try {
      if (args.operation === "delete") {
        response = await returned("mutate", `Deleted ${relative}`)
        await assertOpenedIdentity(file)
        await file.handle.close()
        file.handle = null
        await assertOpenedIdentity(file)
        await unlink(file.absolute)
        modeIntents.delete(relative)
        await persistModeIntents()
        return response
      }

      if (args.operation === "executable") {
        response = await returned("mutate", `Recorded ${args.executable ? "executable" : "non-executable"} mode for ${relative}`)
        await assertOpenedIdentity(file)
        if (process.platform !== "win32") {
          const nextMode = args.executable ? file.info.mode | 0o111 : file.info.mode & ~0o111
          await file.handle.chmod(nextMode)
          const updated = await file.handle.stat()
          const current = await lstat(file.absolute)
          if (!sameIdentity(updated, current) || Number(current.nlink) > 1 || current.isSymbolicLink()) {
            throw new Error(`Path identity changed while updating mode: ${relative}`)
          }
          if (((updated.mode & 0o111) !== 0) !== args.executable) {
            throw new Error(`Filesystem did not apply the requested executable bit for ${relative}`)
          }
        }
        setModeIntent(relative, args.executable)
        await persistModeIntents()
        return response
      }

      if (destination === relative) throw new Error("Move destination must differ from source")
      assertMutationPath(destination)
      try { await assertSafeParents(destination) }
      catch (error) { if (error?.code !== "ENOENT") throw error }
      await assertDestinationMissing(destination)
      response = await returned("mutate", `Moved ${relative} to ${destination}`)
      await assertOpenedIdentity(file)
      await file.handle.close()
      file.handle = null
      await assertSafeParents(destination, { create: true })
      await assertSafeParents(destination)
      await assertDestinationMissing(destination)
      await assertOpenedIdentity(file)
      await rename(file.absolute, path.join(policy.root, ...destination.split("/")))
      const moved = await safeFile(destination)
      if (!sameIdentity(file.info, moved.info)) throw new Error("Moved file identity did not match its source")
      const desiredExecutable = modeIntents.has(relative)
        ? modeIntents.get(relative)
        : baselineExecutable(relative) ?? ((file.info.mode & 0o111) !== 0)
      modeIntents.delete(relative)
      setModeIntent(destination, desiredExecutable)
      await persistModeIntents()
      return response
    } finally {
      await file.handle?.close().catch(() => {})
    }
  },
})

function feedbackRunnerEnvironment() {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR", "FORCE_COLOR",
  ])
  return Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => allowed.has(name) && typeof value === "string"),
  )
}

function conciseFeedbackResult(value, gateId, definitionSha256) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.gate_id !== gateId || value.gate_definition_sha256 !== definitionSha256 ||
    typeof value.success !== "boolean" ||
    (value.code !== null && !Number.isInteger(value.code)) ||
    typeof value.timed_out !== "boolean" ||
    !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0
  ) throw new Error("Feedback gate returned an invalid controller result")
  const result = {
    gate_id: gateId,
    success: value.success,
    code: value.code,
    timed_out: value.timed_out,
    duration_ms: value.duration_ms,
  }
  if (!value.success) {
    const diagnostic = value.diagnostic
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
      throw new Error("Failed feedback gate omitted its bounded diagnostic")
    }
    result.diagnostic = {
      stdout: utf8Prefix(typeof diagnostic.stdout === "string" ? diagnostic.stdout : "", 2048),
      stderr: utf8Prefix(typeof diagnostic.stderr === "string" ? diagnostic.stderr : "", 2048),
      output_truncated: Boolean(diagnostic.output_truncated),
    }
  }
  return result
}

export const check = defineTool({
  description: `Run one controller-approved, credential-free task gate for bounded feedback (maximum ${policy.max_feedback_calls} calls). Eligible: ${Object.keys(policy.feedback_gates).join(", ") || "none"}. The controller reruns every authoritative gate after the candidate.`,
  args: { gate_id: schema.string() },
  async execute(args) {
    exactKeys(args, ["gate_id"], "check input")
    const gateId = inputString(args.gate_id, "check gate_id", { maxBytes: 128 })
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gateId) ||
      !Object.hasOwn(policy.feedback_gates, gateId)
    ) throw new Error(`Gate is not approved for this task phase: ${gateId}`)
    if (contractCommitted) throw new Error("Feedback checks are unavailable after the phase contract")
    if (policy.phase === "review") throw new Error("autopilot_check is unavailable to the reviewer")
    await beginTool("check")
    const gate = policy.feedback_gates[gateId]
    const execution = spawnSync(process.execPath, [
      policy.feedback_runner,
      gateId,
      "--root", policy.root,
      "--task", policy.task_id,
      "--attempt", String(policy.attempt),
      "--feedback",
      "--expected-definition-sha256", gate.definition_sha256,
    ], {
      cwd: policy.root,
      encoding: "utf8",
      env: feedbackRunnerEnvironment(),
      windowsHide: true,
      shell: false,
      maxBuffer: 128 * 1024,
      timeout: (gate.timeout_seconds + 30) * 1000,
    })
    if (execution.error) throw new Error("Feedback gate runner failed to start or exceeded its outer time bound")
    let parsed
    try { parsed = JSON.parse(execution.stdout) }
    catch { throw new Error("Feedback gate runner did not return bounded controller JSON") }
    const result = conciseFeedbackResult(parsed, gateId, gate.definition_sha256)
    if ((result.success && execution.status !== 0) || (!result.success && execution.status !== 1)) {
      throw new Error("Feedback gate runner exit status disagrees with its result")
    }
    return await returned("check", JSON.stringify(result))
  },
})

const contractText = () => schema.string().min(1).max(2048)
const blockerSchema = schema.object({
  kind: contractText(),
  message: contractText(),
  required_action: contractText(),
  resume_condition: contractText(),
}).nullable()
const findingSchema = schema.object({
  severity: schema.enum(["low", "medium", "high", "critical"]),
  file: schema.string().min(1).max(512),
  message: contractText(),
})
const candidateArgs = {
  status: schema.enum(["complete", "blocked", "failed"]),
  summary: contractText(),
  environment_variables: schema.array(schema.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
  blocker: blockerSchema,
}
const reviewArgs = {
  status: schema.enum(["approved", "changes_requested", "blocked"]),
  summary: contractText(),
  findings: schema.array(findingSchema).max(64),
}

export const contract = defineTool({
  description: policy.phase === "review"
    ? "Submit the independent review. Task identity is controller-derived. Call once, then end."
    : "Submit the phase result. Task identity, attempt, and changed files are controller-derived. Call once, then end.",
  args: policy.phase === "review" ? reviewArgs : candidateArgs,
  async execute(args) {
    if (contractCommitted) throw new Error("Phase contract was already recorded")
    const value = policy.phase === "review" ? reviewValue(args) : candidateValue(args)
    const relative = normalize(policy.contract_path, "contract path")
    await beginTool("contract")
    await assertSafeParents(relative, { create: true })
    const absolute = path.join(policy.root, ...relative.split("/"))
    let existing = null
    try { existing = await lstat(absolute) } catch (error) { if (error?.code !== "ENOENT") throw error }
    if (existing) throw new Error("Phase contract destination already exists")
    const response = await returned("contract", `Recorded ${policy.phase} contract`, { contract: true })
    await atomicReplace(absolute, `${JSON.stringify(value, null, 2)}\n`, 0o600)
    contractCommitted = true
    return response
  },
})
