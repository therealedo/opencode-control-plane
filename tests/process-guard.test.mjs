import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { repositoryRoot } from "./runtime-helpers.mjs"

const guard = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "assets",
  "project",
  ".autopilot",
  "bin",
  "process-guard.mjs",
)

async function runGuard(argv, {
  input = null,
  ownerPid = process.pid,
  timeoutMs = 15_000,
} = {}) {
  const child = spawn(process.execPath, [guard, String(ownerPid), ...argv], {
    windowsHide: true,
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
  })
  const stdout = []
  const stderr = []
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
  if (input !== null) child.stdin.end(input)

  let timer
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          })
        } else {
          child.kill("SIGKILL")
        }
        reject(new Error("process guard test timed out"))
      }, timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))

  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }
}

test("process guard forwards stdin and closes it at EOF", async () => {
  const source = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk });",
    "process.stdin.on('end', () => process.stdout.write(input.toUpperCase()))",
  ].join("")
  const result = await runGuard([process.execPath, "-e", source], {
    input: "guarded input",
    timeoutMs: 5_000,
  })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, "GUARDED INPUT")
})

test("process guard preserves exact argument boundaries", async () => {
  const expected = [
    "plain",
    "with space",
    "embedded\"quote",
    "trailing\\",
    "space trailing\\",
    "L".repeat(16 * 1024),
  ]
  const source = "process.stdout.write(JSON.stringify(process.argv.slice(1)))"
  const result = await runGuard([process.execPath, "-e", source, ...expected])

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), expected)
})

test("Windows process guard kills a detached descendant after its parent exits", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autopilot-process-guard-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const marker = path.join(temporary, "descendant-survived.txt")
  const descendant = [
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 1800)",
  ].join("")
  const parent = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], ",
    "{ detached: true, stdio: 'ignore' }).unref()",
  ].join("")

  const result = await runGuard([process.execPath, "-e", parent, descendant, marker])
  assert.equal(result.code, 0, result.stderr)
  await new Promise((resolve) => setTimeout(resolve, 2600))
  await assert.rejects(access(marker), { code: "ENOENT" })
})

test("Windows process guard kills its job when the controller owner exits", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autopilot-owner-guard-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const ready = path.join(temporary, "target-ready.txt")
  const marker = path.join(temporary, "target-survived.txt")
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  })
  t.after(() => owner.kill())
  const target = [
    "require('node:fs').writeFileSync(process.argv[1], 'ready');",
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'survived'), 2500)",
  ].join("")

  const guarded = runGuard([process.execPath, "-e", target, ready, marker], {
    ownerPid: owner.pid,
    timeoutMs: 8_000,
  })
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await access(ready)
      break
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  owner.kill()

  const result = await guarded
  assert.equal(result.code, 124, result.stderr)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await assert.rejects(access(marker), { code: "ENOENT" })
})
