import assert from "node:assert/strict"
import { access, copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { git, repositoryRoot } from "./runtime-helpers.mjs"

const templateRoot = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "assets",
  "project",
)

async function trustedGitArgv(root) {
  const processModule = await import(pathToFileURL(path.join(
    templateRoot,
    ".autopilot",
    "bin",
    "lib",
    "process.mjs",
  )))
  const environment = await processModule.externalExecutionEnv(root)
  return processModule.resolveExternalInvocation(root, "git", environment, {
    label: "test Git executable",
  })
}

test("literal allowed directories authorize descendant worker writes only", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-literal-path-"))
  const profile = await mkdtemp(path.join(os.tmpdir(), "autopilot-literal-tool-"))
  const previousPolicy = process.env.AUTOPILOT_TOOL_POLICY
  t.after(async () => {
    if (previousPolicy === undefined) delete process.env.AUTOPILOT_TOOL_POLICY
    else process.env.AUTOPILOT_TOOL_POLICY = previousPolicy
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(profile, { recursive: true, force: true }),
    ])
  })

  await git(root, ["init"])
  await git(root, ["config", "user.name", "Literal Allowlist Test"])
  await git(root, ["config", "user.email", "literal@example.invalid"])
  await git(root, ["commit", "--allow-empty", "-m", "test: establish baseline"])
  const baseline = await git(root, ["rev-parse", "HEAD"])
  const copiedTool = path.join(profile, "autopilot-tools.mjs")
  await copyFile(path.join(templateRoot, ".autopilot", "bin", "opencode-tools.mjs"), copiedTool)

  process.env.AUTOPILOT_TOOL_POLICY = Buffer.from(JSON.stringify({
    schema_version: 1,
    root,
    task_id: "M001",
    phase: "execute",
    attempt: 1,
    baseline_head: baseline,
    allowed_paths: ["apps/web"],
    contract_path: ".autopilot/runtime/candidate.json",
    max_returned_bytes: 32768,
    feedback_runner: path.join(root, "unused-gate-runner.mjs"),
    feedback_gates: {},
    max_feedback_calls: 0,
    git_argv: await trustedGitArgv(root),
  }), "utf8").toString("base64")

  const tools = await import(`${pathToFileURL(copiedTool).href}?test=${Date.now()}`)
  assert.equal(
    await tools.write.execute({ path: "apps/web/package.json", content: "{}\n" }),
    "Wrote apps/web/package.json",
  )
  assert.equal(await readFile(path.join(root, "apps", "web", "package.json"), "utf8"), "{}\n")
  assert.equal(
    await tools.edit.execute({ path: "apps/web/package.json", old_text: "{}", new_text: '{"private":true}' }),
    "Edited apps/web/package.json",
  )
  await assert.rejects(
    tools.write.execute({ path: "apps/api/package.json", content: "{}\n" }),
    /outside the task boundary/,
  )
  await assert.rejects(access(path.join(root, "apps", "api", "package.json")))
})
