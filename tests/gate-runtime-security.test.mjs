import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
  fixedGateScript,
  readJson,
  repositoryRoot,
  run,
  writeJson,
} from "./runtime-helpers.mjs"

const templateRuntime = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "assets",
  "project",
  ".autopilot",
  "bin",
  "lib",
)
const templateBin = path.dirname(templateRuntime)

function gateRuntimePrefix(root) {
  const rootIdentity = process.platform === "win32"
    ? path.resolve(root).toLocaleLowerCase("en-US")
    : path.resolve(root)
  return `autopilot-${createHash("sha256").update(rootIdentity).digest("hex").slice(0, 16)}-gate-`
}

async function sweepGateResidue(root) {
  const projectModule = await import(pathToFileURL(path.join(templateRuntime, "project.mjs")).href)
  const gateModule = await import(pathToFileURL(path.join(templateRuntime, "gate-runner.mjs")).href)
  const project = await projectModule.loadProject(root)
  await gateModule.sweepStaleGateRuntimes(project)
  const names = await readdir(os.tmpdir())
  assert.equal(names.some((name) => name.startsWith(gateRuntimePrefix(root))), false)
}

function secretVariants(value) {
  const bytes = Buffer.from(value, "utf8")
  return [
    value,
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ]
}

test("run-gate reports usage faults through the bounded controller envelope", async () => {
  const result = await run(
    [process.execPath, path.join(templateBin, "run-gate.mjs"), "--unknown"],
    { cwd: repositoryRoot },
  )
  assert.equal(result.code, 2, result.stderr || result.stdout)
  assert.ok(Buffer.byteLength(result.stdout, "utf8") < 8192)
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.schema_version, 1)
  assert.equal(envelope.operation, "gate")
  assert.equal(envelope.classification, "controller_failure")
  assert.equal(envelope.error_code, "USAGE")
  assert.equal(envelope.gate_id, null)
  assert.equal(envelope.primary_gate_outcome, null)
  assert.equal(envelope.artifact, null)
  assert.match(result.stderr, /USAGE/)
})

test("credential-free gate diagnostics redact every configured profile and use a disposable OS-temp home", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const secret = "arbitrary-unrelated-profile-value-739251"
  const envFile = path.join(root, ".env.unrelated.local")
  await writeFile(envFile, `NONHEURISTIC_VALUE=${secret}\n`, { encoding: "utf8", mode: 0o600 })
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      unrelated: {
        env_file: ".env.unrelated.local",
        allow: ["NONHEURISTIC_VALUE"],
        allowed_gates: ["opencode"],
      },
    },
  })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task = {
    argv: [process.execPath, fixedGateScript, "leak-env-file", ".env.unrelated.local", "NONHEURISTIC_VALUE"],
    timeout_seconds: 30,
    credential_profile: null,
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: false,
  }
  await writeJson(gatesFile, gates)

  const result = await run(
    [process.execPath, path.join(root, ".autopilot", "bin", "run-gate.mjs"), "task"],
    { cwd: root },
  )
  assert.equal(result.code, 1, result.stderr || result.stdout)
  const returned = JSON.parse(result.stdout)
  assert.equal(returned.schema_version, 1)
  assert.equal(returned.operation, "gate")
  assert.equal(returned.classification, "task_failure")
  assert.equal(returned.error_code, "GATE_EXIT_CODE")
  const returnedText = JSON.stringify(returned)
  for (const variant of secretVariants(secret)) assert.equal(returnedText.includes(variant), false)
  assert.match(returned.diagnostic.stdout, /\[REDACTED\]/)
  assert.match(returned.diagnostic.stdout, /bun=--no-env-file/)

  const artifactText = await readFile(path.join(root, returned.artifact), "utf8")
  for (const variant of secretVariants(secret)) assert.equal(artifactText.includes(variant), false)
  const home = /^home=(.*)$/m.exec(returned.diagnostic.stdout)?.[1]
  assert.ok(home && path.isAbsolute(home), returned.diagnostic.stdout)
  assert.equal(path.resolve(home).startsWith(path.resolve(root)), false)
  await assert.rejects(access(home))
})

test("credential-free cleanup faults preserve the primary result in a durable controller envelope", async (t) => {
  const root = await createScaffold(t, { ready: true })
  t.after(async () => { await sweepGateResidue(root).catch(() => {}) })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task = {
    argv: [process.execPath, fixedGateScript, "pass"],
    timeout_seconds: 30,
    credential_profile: null,
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: false,
  }
  await writeJson(gatesFile, gates)

  const result = await run(
    [process.execPath, path.join(templateBin, "run-gate.mjs"), "task", "--root", root],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_GATE_CLEANUP_FAILURE: "1",
      },
    },
  )
  assert.equal(result.code, 2, result.stderr || result.stdout)
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.schema_version, 1)
  assert.equal(envelope.operation, "gate")
  assert.equal(envelope.classification, "controller_failure")
  assert.equal(envelope.error_code, "GATE_CLEANUP_FAILED")
  assert.equal(envelope.success, false)
  assert.equal(envelope.primary_gate_outcome.classification, "success")
  assert.equal(envelope.primary_gate_outcome.error_code, null)
  assert.equal(envelope.controller_failure.cleanup.sweep_required, true)
  assert.equal(envelope.controller_failure.cleanup.credential_residue_possible, false)
  assert.match(envelope.diagnostic.stderr, /GATE_CLEANUP_FAILED/)

  const artifact = await readJson(path.join(root, envelope.artifact))
  assert.equal(artifact.operation, "gate")
  assert.equal(artifact.classification, "controller_failure")
  assert.equal(artifact.error_code, "GATE_CLEANUP_FAILED")
  assert.equal(artifact.primary_gate_outcome.classification, "success")
  assert.match(artifact.stdout, /fixed gate passed/)
  assert.equal(artifact.controller_failure.cleanup.sweep_required, true)

  await sweepGateResidue(root)

  const successEnvironment = { ...process.env }
  delete successEnvironment.AUTOPILOT_TEST_GATE_CLEANUP_FAILURE
  const successResult = await run(
    [process.execPath, path.join(templateBin, "run-gate.mjs"), "task", "--root", root],
    { cwd: root, env: successEnvironment },
  )
  assert.equal(successResult.code, 0, successResult.stderr || successResult.stdout)
  const successEnvelope = JSON.parse(successResult.stdout)
  assert.equal(successEnvelope.schema_version, 1)
  assert.equal(successEnvelope.operation, "gate")
  assert.equal(successEnvelope.classification, "success")
  assert.equal(successEnvelope.error_code, null)
})

test("credential-injected cleanup residue remains opaque and fail-closed", async (t) => {
  const root = await createScaffold(t, { ready: true })
  t.after(async () => { await sweepGateResidue(root).catch(() => {}) })
  const secret = "credential-cleanup-secret-739251"
  await writeFile(path.join(root, ".env.gate.local"), `ALLOWED_TOKEN=${secret}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await writeJson(path.join(root, ".autopilot", "credentials.json"), {
    schema_version: 1,
    profiles: {
      gate: {
        env_file: ".env.gate.local",
        allow: ["ALLOWED_TOKEN"],
        allowed_gates: ["task"],
      },
    },
  })
  const gatesFile = path.join(root, ".project", "gates.json")
  const gates = await readJson(gatesFile)
  gates.gates.task = {
    argv: [process.execPath, fixedGateScript, "echo-env", "ALLOWED_TOKEN", "DENIED_TOKEN"],
    timeout_seconds: 30,
    credential_profile: "gate",
    success_codes: [0],
    max_output_bytes: 8192,
    feedback: false,
  }
  await writeJson(gatesFile, gates)

  const result = await run(
    [process.execPath, path.join(templateBin, "run-gate.mjs"), "task", "--root", root],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTOPILOT_TEST_GATE_CLEANUP_FAILURE: "1",
      },
    },
  )
  assert.equal(result.code, 2, result.stderr || result.stdout)
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.classification, "controller_failure")
  assert.equal(envelope.error_code, "GATE_CLEANUP_FAILED")
  assert.equal(envelope.primary_gate_outcome.classification, "success")
  assert.equal(envelope.controller_failure.cleanup.credential_residue_possible, true)
  assert.equal(envelope.controller_failure.cleanup.fail_closed, true)
  assert.equal(envelope.diagnostic.stdout, "")
  const artifactText = await readFile(path.join(root, envelope.artifact), "utf8")
  for (const variant of secretVariants(secret)) assert.equal(artifactText.includes(variant), false)
  const artifact = JSON.parse(artifactText)
  assert.equal(Object.hasOwn(artifact, "stdout"), false)
  assert.equal(Object.hasOwn(artifact, "stderr"), false)

  await sweepGateResidue(root)
})

test("controller gate-runtime sweep removes safe residue and unlinks in-root link entries", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const prefix = gateRuntimePrefix(root)
  const stale = await mkdtemp(path.join(os.tmpdir(), prefix))
  if (process.platform !== "win32") await chmod(stale, 0o700)
  await mkdir(path.join(stale, "cache"), { recursive: true })
  await writeFile(path.join(stale, "cache", "token.txt"), "stale-token-value-1842", "utf8")

  const projectModule = await import(pathToFileURL(path.join(templateRuntime, "project.mjs")).href)
  const gateModule = await import(pathToFileURL(path.join(templateRuntime, "gate-runner.mjs")).href)
  const project = await projectModule.loadProject(root)
  await gateModule.sweepStaleGateRuntimes(project)
  await assert.rejects(access(stale))

  const linkedRuntime = await mkdtemp(path.join(os.tmpdir(), prefix))
  const external = await mkdtemp(path.join(os.tmpdir(), "ocp-gate-link-target-"))
  t.after(async () => { await rm(linkedRuntime, { recursive: true, force: true }) })
  t.after(async () => { await rm(external, { recursive: true, force: true }) })
  if (process.platform !== "win32") await chmod(linkedRuntime, 0o700)
  const externalFile = path.join(external, "preserved.txt")
  await writeFile(externalFile, "external target remains", "utf8")
  await link(externalFile, path.join(linkedRuntime, "hard-linked.txt"))
  try {
    await symlink(externalFile, path.join(linkedRuntime, "symbolic-linked.txt"), "file")
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error
  }
  await gateModule.sweepStaleGateRuntimes(project)
  await assert.rejects(access(linkedRuntime))
  assert.equal(await readFile(externalFile, "utf8"), "external target remains")

  const controllerSource = await readFile(path.join(templateRuntime, "controller.mjs"), "utf8")
  const lockAt = controllerSource.indexOf("this.lock = await acquireProjectLease")
  const sweepAt = controllerSource.indexOf("await sweepStaleGateRuntimes")
  const validateAt = controllerSource.indexOf("await validateProject", sweepAt)
  assert.ok(lockAt >= 0 && lockAt < sweepAt && sweepAt < validateAt)
})
