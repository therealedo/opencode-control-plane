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

function secretVariants(value) {
  const bytes = Buffer.from(value, "utf8")
  return [
    value,
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ]
}

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

test("controller gate-runtime sweep removes safe crash residue and preserves unsafe links", async (t) => {
  const root = await createScaffold(t, { ready: true })
  const rootIdentity = process.platform === "win32"
    ? path.resolve(root).toLocaleLowerCase("en-US")
    : path.resolve(root)
  const prefix = `autopilot-${createHash("sha256").update(rootIdentity).digest("hex").slice(0, 16)}-gate-`
  const stale = await mkdtemp(path.join(os.tmpdir(), prefix))
  if (process.platform !== "win32") await chmod(stale, 0o700)
  await mkdir(path.join(stale, "cache"), { recursive: true })
  await writeFile(path.join(stale, "cache", "token.txt"), "stale-token-value-1842", "utf8")

  const projectModule = await import(pathToFileURL(path.join(templateRuntime, "project.mjs")).href)
  const gateModule = await import(pathToFileURL(path.join(templateRuntime, "gate-runner.mjs")).href)
  const project = await projectModule.loadProject(root)
  await gateModule.sweepStaleGateRuntimes(project)
  await assert.rejects(access(stale))

  const unsafe = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => { await rm(unsafe, { recursive: true, force: true }) })
  if (process.platform !== "win32") await chmod(unsafe, 0o700)
  const source = path.join(unsafe, "source.txt")
  await writeFile(source, "linked", "utf8")
  await link(source, path.join(unsafe, "linked.txt"))
  await assert.rejects(
    gateModule.sweepStaleGateRuntimes(project),
    /link|unsafe/i,
  )
  const names = await readdir(unsafe)
  assert.deepEqual(names.sort(), ["linked.txt", "source.txt"])

  const controllerSource = await readFile(path.join(templateRuntime, "controller.mjs"), "utf8")
  const lockAt = controllerSource.indexOf("this.lock = await acquireLock")
  const sweepAt = controllerSource.indexOf("await sweepStaleGateRuntimes")
  const validateAt = controllerSource.indexOf("await validateProject", sweepAt)
  assert.ok(lockAt >= 0 && lockAt < sweepAt && sweepAt < validateAt)
})
