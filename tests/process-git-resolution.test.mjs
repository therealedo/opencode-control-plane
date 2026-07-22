import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { resolveExternalGitExecutable } from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/process.mjs"

test("Windows Git resolution bypasses the PATH launcher for the same installation", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Git for Windows launcher layout is Windows-specific")
    return
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "autopilot-git-resolver-"))
  try {
    const project = path.join(temporary, "project")
    const install = path.join(temporary, "outside-project", "Git")
    const launcherDirectory = path.join(install, "cmd")
    const nativeDirectory = path.join(install, "mingw64", "bin")
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(launcherDirectory, { recursive: true }),
      mkdir(nativeDirectory, { recursive: true }),
    ])
    const launcher = path.join(launcherDirectory, "git.exe")
    const native = path.join(nativeDirectory, "git.exe")
    await Promise.all([
      writeFile(launcher, "launcher", "utf8"),
      writeFile(native, "native", "utf8"),
    ])

    const resolved = await resolveExternalGitExecutable(project, { Path: launcherDirectory })
    assert.equal(resolved.toLocaleLowerCase("en-US"), path.resolve(native).toLocaleLowerCase("en-US"))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
