import assert from "node:assert/strict"
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  createScaffold,
  git,
  readJson,
  repositoryRoot,
  run,
  writeJson,
} from "./runtime-helpers.mjs"

const templateRoot = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "assets",
  "project",
)

const ignoredMutationAgent = String.raw`#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("filesystem-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

const arguments_ = process.argv.slice(2)
const directoryIndex = arguments_.indexOf("--dir")
const root = directoryIndex >= 0 && arguments_[directoryIndex + 1]
  ? path.resolve(arguments_[directoryIndex + 1])
  : process.cwd()
const prompt = process.argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const runtime = path.join(root, ".autopilot", "runtime")
await mkdir(runtime, { recursive: true })

const invocationsFile = path.join(runtime, "filesystem-invariant-invocations.json")
let invocations = []
try {
  invocations = JSON.parse(await readFile(invocationsFile, "utf8"))
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
invocations.push({ stage, task_id: taskId, attempt })
await writeFile(invocationsFile, JSON.stringify(invocations, null, 2) + "\n", "utf8")

if (stage === "review") {
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: "approved",
    summary: "The fixture reviewer approved the candidate.",
    findings: [],
  })
} else {
  await writeFile(path.join(root, "ignored-application-state.txt"), "MUTATED\n", "utf8")
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "result.txt"), "GOOD\n", "utf8")
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: "The fixture deliberately mutated an ignored application file.",
    changed_files: ["src/result.txt"],
    environment_variables: [],
    blocker: null,
  })
}

process.stdout.write(JSON.stringify({
  type: "session",
  sessionID: "filesystem-" + stage + "-a" + attempt + "-p" + process.pid,
}) + "\n")

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

const modeIntentAgent = String.raw`#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("mode-intent-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

const arguments_ = process.argv.slice(2)
const directoryIndex = arguments_.indexOf("--dir")
const root = directoryIndex >= 0 && arguments_[directoryIndex + 1]
  ? path.resolve(arguments_[directoryIndex + 1])
  : process.cwd()
const prompt = process.argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const runtime = path.join(root, ".autopilot", "runtime")
await mkdir(runtime, { recursive: true })

if (stage === "review") {
  /* REVIEW_TAMPER */
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: "approved",
    summary: "Mode intent and complete diff evidence are valid.",
    findings: [],
  })
} else {
  await mkdir(path.join(root, "src"), { recursive: true })
  const result = path.join(root, "src", "result.txt")
  await writeFile(result, "GOOD\n", "utf8")
  if (process.platform !== "win32") await chmod(result, 0o755)
  await writeJson(path.join(runtime, "mode-intent.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    intents: [{ path: "src/result.txt", executable: true }],
  })
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: "Created the executable result fixture.",
    changed_files: ["src/result.txt"],
    environment_variables: [],
    blocker: null,
  })
}

process.stdout.write(JSON.stringify({
  type: "session",
  sessionID: "mode-intent-" + stage + "-a" + attempt + "-p" + process.pid,
}) + "\n")

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

const lockReplacementAgent = String.raw`#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("lock-fixture 1.0.0\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: opencode run [message..]\n")
  process.exit(0)
}

const arguments_ = process.argv.slice(2)
const directoryIndex = arguments_.indexOf("--dir")
const root = directoryIndex >= 0 && arguments_[directoryIndex + 1]
  ? path.resolve(arguments_[directoryIndex + 1])
  : process.cwd()
const prompt = process.argv.at(-1) ?? ""
const stage = /^Stage:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const taskId = /^Task:\s*(\S+)/m.exec(prompt)?.[1] ?? "unknown"
const attempt = Number(/^Attempt:\s*(\d+)/m.exec(prompt)?.[1] ?? 0)
const runtime = path.join(root, ".autopilot", "runtime")
await mkdir(runtime, { recursive: true })

if (stage !== "review") {
  const lock = path.join(root, ".git", "autopilot-controller.lock")
  await rm(lock)
  await writeFile(lock, "untrusted controller-lock replacement\n", "utf8")
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "result.txt"), "GOOD\n", "utf8")
  await writeJson(path.join(runtime, "candidate.json"), {
    schema_version: 1,
    task_id: taskId,
    attempt,
    status: "complete",
    summary: "The fixture replaced the controller lock.",
    changed_files: ["src/result.txt"],
    environment_variables: [],
    blocker: null,
  })
} else {
  await writeJson(path.join(runtime, "review.json"), {
    schema_version: 1,
    task_id: taskId,
    status: "approved",
    summary: "The fixture reviewer approved the candidate.",
    findings: [],
  })
}

process.stdout.write(JSON.stringify({
  type: "session",
  sessionID: "lock-replacement-" + stage + "-a" + attempt + "-p" + process.pid,
}) + "\n")

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
`

async function controller(root, ...extra) {
  return run(
    [
      process.execPath,
      path.join(root, ".autopilot", "bin", "autopilot.mjs"),
      "start",
      ...extra,
    ],
    { cwd: root },
  )
}

async function configureAgent(t, root, source) {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "autopilot-filesystem-agent-"))
  t.after(async () => rm(agentDirectory, { recursive: true, force: true }))
  const agent = path.join(agentDirectory, "filesystem-agent.mjs")
  await writeFile(agent, source, "utf8")
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode.command = [process.execPath, agent]
  await writeJson(configFile, config)
  await git(root, ["add", ".autopilot/config.json"])
  await git(root, ["commit", "-m", "test: configure filesystem invariant agent"])
}

async function addIgnoreBeforeCanonical(file, pattern) {
  const content = await readFile(file, "utf8")
  const marker = "# opencode-autopilot"
  assert.equal(content.includes(marker), true)
  await writeFile(file, content.replace(marker, `${pattern}\n\n${marker}`), "utf8")
}

async function assertUnavailable(file) {
  await assert.rejects(access(file))
}

function canSkipLink(error) {
  return ["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(error?.code)
}

test("an agent phase cannot silently mutate an ignored application file", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const ignoreFile = path.join(root, ".gitignore")
  await addIgnoreBeforeCanonical(ignoreFile, "/ignored-application-state.txt")
  await writeFile(path.join(root, "ignored-application-state.txt"), "ORIGINAL\n", "utf8")
  await git(root, ["add", ".gitignore"])
  await git(root, ["commit", "-m", "test: ignore bounded application fixture"])
  await configureAgent(t, root, ignoredMutationAgent)

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.match(state.blocker?.message ?? "", /ignored application state/i)
  assert.notEqual(queue.tasks.M001.status, "done")
  await assertUnavailable(path.join(root, ".project", "receipts", "M001.json"))
})

test("declared ephemeral roots are excluded while ignored credential state stays frozen", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.git.ephemeral_roots = ["coverage"]
  await writeJson(configFile, config)
  const ignoreFile = path.join(root, ".gitignore")
  await addIgnoreBeforeCanonical(ignoreFile, "/coverage/")
  await git(root, ["add", ".autopilot/config.json", ".gitignore"])
  await git(root, ["commit", "-m", "test: declare ephemeral coverage root"])

  await mkdir(path.join(root, "coverage", "deep"), { recursive: true })
  const coverageFile = path.join(root, "coverage", "deep", "report.dat")
  const credentialFile = path.join(root, ".env.snapshot.local")
  await writeFile(coverageFile, "A".repeat(128 * 1024), "utf8")
  await writeFile(credentialFile, "TOKEN=ORIGINAL\n", "utf8")

  const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")).href)
  const gitModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "git.mjs")).href)
  const project = await projectModule.loadProject(root)
  const before = await gitModule.ignoredApplicationSnapshot(project)
  await writeFile(coverageFile, "B".repeat(128 * 1024), "utf8")
  assert.equal(await gitModule.ignoredApplicationSnapshot(project), before)
  await writeFile(credentialFile, "TOKEN=CHANGED\n", "utf8")
  assert.notEqual(await gitModule.ignoredApplicationSnapshot(project), before)
})

test("trusted commit preparation applies and verifies executable mode intent on every host", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const script = path.join(root, "src", "mode-intent.sh")
  await mkdir(path.dirname(script), { recursive: true })
  await writeFile(script, "#!/bin/sh\nexit 0\n", "utf8")
  if (process.platform !== "win32") await chmod(script, 0o644)
  await git(root, ["add", "src/mode-intent.sh"])
  await git(root, ["commit", "-m", "test: seed non-executable script"])
  const baseline = await git(root, ["rev-parse", "HEAD"])
  const projectModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "project.mjs")).href)
  const gitModule = await import(pathToFileURL(path.join(root, ".autopilot", "bin", "lib", "git.mjs")).href)
  const project = await projectModule.loadProject(root)
  const modeIntents = [{ path: "src/mode-intent.sh", executable: true }]
  if (process.platform !== "win32") await chmod(script, 0o755)

  const files = await gitModule.taskChangedFiles(project, baseline, { modeIntents })
  assert.deepEqual(files, ["src/mode-intent.sh"])
  await gitModule.assertModeIntentTransitions(project, baseline, modeIntents, files)
  const acceptedHash = await gitModule.gitDiffHash(project, baseline, files, { modeIntents })
  assert.match(
    await gitModule.gitDiffForReview(project, baseline, files, 8192, { modeIntents }),
    /mode-intent\.sh: 100644 -> 100755/,
  )

  const prepared = await gitModule.prepareCommitTree(project, baseline, files, { modeIntents })
  assert.equal(await gitModule.gitDiffHash(project, baseline, files, { modeIntents }), acceptedHash)
  const recovered = await gitModule.prepareCommitTree(project, baseline, files, { modeIntents })
  assert.deepEqual(recovered, prepared)
  const resultCommit = await gitModule.createCommitObject(project, prepared.result_tree, baseline, "test: executable intent")
  await gitModule.verifyCommitTransition(project, {
    baselineCommit: baseline,
    resultCommit,
    expectedFiles: files,
    baselineTree: prepared.baseline_tree,
    resultTree: prepared.result_tree,
    diffSha256: prepared.diff_sha256,
    modeIntents,
  })
  assert.match(await git(root, ["ls-tree", resultCommit, "--", "src/mode-intent.sh"]), /^100755 blob /)

  await assert.rejects(
    gitModule.assertModeIntentTransitions(
      project,
      baseline,
      [{ path: "src/mode-intent.sh", executable: false }],
      ["src/mode-intent.sh"],
    ),
    /no-op against the baseline/,
  )
  await assert.rejects(
    gitModule.assertModeIntentTransitions(
      project,
      baseline,
      [{ path: "src/missing.sh", executable: true }],
      ["src/missing.sh"],
    ),
    /target is missing/,
  )
})

test("controller freezes, reviews, commits, and receipts executable mode intent", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureAgent(t, root, modeIntentAgent)

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  const queue = await readJson(path.join(root, ".project", "plan", "queue.json"))
  const receipt = await readJson(path.join(root, ".project", "receipts", "M001.json"))
  assert.equal(state.status, "complete", JSON.stringify(state, null, 2))
  assert.equal(queue.tasks.M001.status, "done")
  assert.deepEqual(receipt.mode_intents, [{ path: "src/result.txt", executable: true }])
  assert.match(await git(root, ["ls-tree", "HEAD", "--", "src/result.txt"]), /^100755 blob /)
  await assertUnavailable(path.join(root, ".autopilot", "runtime", "mode-intent.json"))
})

test("review-side tampering with executable mode intent fails closed", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const tamperingAgent = modeIntentAgent.replace(
    "/* REVIEW_TAMPER */",
    `await writeJson(path.join(runtime, "mode-intent.json"), {
      schema_version: 1,
      task_id: taskId,
      attempt,
      intents: [{ path: "src/result.txt", executable: false }],
    })`,
  )
  await configureAgent(t, root, tamperingAgent)

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.match(state.blocker?.message ?? "", /mode intent|mode-intent|executable/i)
  await assertUnavailable(path.join(root, ".project", "receipts", "M001.json"))
})

test("a pre-existing ignored hardlinked allowed target is rejected before an agent starts", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const outside = await mkdtemp(path.join(os.tmpdir(), "autopilot-hardlink-target-"))
  t.after(async () => rm(outside, { recursive: true, force: true }))
  const externalTarget = path.join(outside, "external.txt")
  const allowedTarget = path.join(root, "src", "result.txt")
  const ignoreFile = path.join(root, ".gitignore")
  await addIgnoreBeforeCanonical(ignoreFile, "/src/result.txt")
  await git(root, ["add", ".gitignore"])
  await git(root, ["commit", "-m", "test: ignore adversarial allowed target"])
  await mkdir(path.dirname(allowedTarget), { recursive: true })
  await writeFile(externalTarget, "DO NOT MODIFY\n", "utf8")
  await link(externalTarget, allowedTarget)

  const result = await controller(root)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify(state, null, 2))
  assert.match(state.blocker?.message ?? "", /hard.?link|private regular file/i)
  assert.equal(await readFile(externalTarget, "utf8"), "DO NOT MODIFY\n")
  await assertUnavailable(path.join(root, ".autopilot", "runtime", "fake-invocations.json"))
  await assertUnavailable(path.join(root, ".project", "receipts", "M001.json"))
})

test("context packing rejects a hardlinked reference", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const source = path.join(root, "context-source.txt")
  const reference = path.join(root, "context-hardlink.txt")
  await writeFile(source, "bounded context\n", "utf8")
  await link(source, reference)
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.context = { shared: [], execute: ["context-hardlink.txt"], repair: [], review: [] }
  await writeJson(queueFile, queue)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /HARDLINK_DENIED|private regular file/i)
})

test("context packing rejects a symbolic-link reference", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const reference = path.join(root, "context-symlink.txt")
  try {
    await symlink(".project/brief.md", reference, "file")
  } catch (error) {
    if (canSkipLink(error)) {
      t.skip(`symbolic links are unavailable: ${error.code}`)
      return
    }
    throw error
  }
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.context = { shared: [], execute: ["context-symlink.txt"], repair: [], review: [] }
  await writeJson(queueFile, queue)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /SENSITIVE_CONTEXT_REFERENCE|private regular file/i)
})

test("runtime context packing always rejects immutable receipts", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const queueFile = path.join(root, ".project", "plan", "queue.json")
  const queue = await readJson(queueFile)
  queue.tasks.M001.context = {
    shared: [],
    execute: [".project/receipts/README.md"],
    repair: [],
    review: [],
  }
  await writeJson(queueFile, queue)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "context-pack.mjs"), "M001"],
    { cwd: root },
  )
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /RECEIPT_CONTEXT_DENIED|receipt content cannot enter/i)
})

test("controller lock release detects deletion and preserves a replacement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-lock-integrity-"))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const core = await import(pathToFileURL(path.join(
    templateRoot,
    ".autopilot",
    "bin",
    "lib",
    "core.mjs",
  )).href)

  const deletedFile = path.join(root, "deleted.lock")
  const deleted = await core.acquireLock(deletedFile, { pid: process.pid })
  await rm(deletedFile)
  await assert.rejects(
    deleted.release(),
    (error) => error?.code === "LOCK_INTEGRITY" && /could not be claimed/i.test(error.message),
  )

  const replacedFile = path.join(root, "replaced.lock")
  const replaced = await core.acquireLock(replacedFile, { pid: process.pid })
  await rm(replacedFile)
  const replacementText = "untrusted replacement must survive\n"
  await writeFile(replacedFile, replacementText, "utf8")
  let replacementError
  try {
    await replaced.release()
  } catch (error) {
    replacementError = error
  }
  assert.equal(replacementError?.code, "LOCK_INTEGRITY")
  const preservedPath = replacementError?.details?.preserved_path
  assert.equal(typeof preservedPath, "string")
  assert.equal(await readFile(preservedPath, "utf8"), replacementText)
  await assertUnavailable(replacedFile)
})

test("a phase that replaces the live controller lock is blocked and its replacement is preserved", async (t) => {
  const root = await createScaffold(t, { ready: true })
  await configureAgent(t, root, lockReplacementAgent)

  const result = await controller(root)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /LOCK_INTEGRITY|ownership changed/i)
  const state = await readJson(path.join(root, ".autopilot", "state.json"))
  assert.equal(state.status, "human_required", JSON.stringify({ state, result }, null, 2))
  assert.match(state.blocker?.message ?? "", /protected control|modified protected|fresh agent/i)

  const gitEntries = await readdir(path.join(root, ".git"))
  const preserved = gitEntries.filter((name) => name.startsWith("autopilot-controller.lock.release-"))
  assert.equal(preserved.length, 1, JSON.stringify(gitEntries, null, 2))
  assert.equal(
    await readFile(path.join(root, ".git", preserved[0]), "utf8"),
    "untrusted controller-lock replacement\n",
  )
  await assertUnavailable(path.join(root, ".git", "autopilot-controller.lock"))
  await assertUnavailable(path.join(root, ".project", "receipts", "M001.json"))
})

test("detached startup refuses a hardlinked log without truncating its target", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const outside = await mkdtemp(path.join(os.tmpdir(), "autopilot-log-target-"))
  t.after(async () => rm(outside, { recursive: true, force: true }))
  const externalTarget = path.join(outside, "external.log")
  const controllerLog = path.join(root, ".autopilot", "artifacts", "controller.log")
  await writeFile(externalTarget, "DO NOT TRUNCATE\n", "utf8")
  await link(externalTarget, controllerLog)

  const result = await controller(root, "--detach")
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /HARDLINK_DENIED|private regular file/i)
  assert.equal(await readFile(externalTarget, "utf8"), "DO NOT TRUNCATE\n")
  await assertUnavailable(path.join(root, ".git", "autopilot-controller.lock"))
})

test("detached startup refuses a symbolic-link log without truncating its target", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const target = path.join(root, ".autopilot", "runtime", "external.log")
  const controllerLog = path.join(root, ".autopilot", "artifacts", "controller.log")
  await writeFile(target, "DO NOT TRUNCATE\n", "utf8")
  try {
    await symlink(target, controllerLog, "file")
  } catch (error) {
    if (canSkipLink(error)) {
      t.skip(`symbolic links are unavailable: ${error.code}`)
      return
    }
    throw error
  }

  const result = await controller(root, "--detach")
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /CONTROL_FILE_UNSAFE|private regular file/i)
  assert.equal(await readFile(target, "utf8"), "DO NOT TRUNCATE\n")
  await assertUnavailable(path.join(root, ".git", "autopilot-controller.lock"))
})
