import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const installer = path.join(root, "scripts", "install.mjs")

function install(args, options = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  })
}

test("global installer dry-run lists only bootstrap-global artifacts without writing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-"))
  try {
    const result = install(["--home", home, "--dry-run", "--json"])
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, true)
    assert.equal(output.dry_run, true)
    assert.ok(output.inspection_warnings.every((item) => /user PATH/.test(item)))
    assert.deepEqual(output.actions.filter((action) => action.kind === "skill").map((action) => path.basename(action.destination)), ["evolve-project", "init-project"])
    assert.deepEqual(output.actions.filter((action) => action.kind === "command").map((action) => path.basename(action.destination)), ["evolve-project.md", "init-project.md"])
    assert.deepEqual(output.actions.filter((action) => action.kind === "launcher").map((action) => path.basename(action.destination)), [process.platform === "win32" ? "control-plane.cmd" : "control-plane"])
    assert.equal(output.actions.some((action) => action.destination.includes(`${path.sep}agents${path.sep}`)), false)
    assert.equal(output.actions.some((action) => /autopilot-(?:start|status|pause|resume|stop)\.md$/.test(action.destination)), false)
    assert.ok(output.actions.every((action) => /^[0-9a-f]{64}$/.test(action.sha256)))
    await assert.rejects(access(path.join(home, ".agents")), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("default installer reports and never removes every prior global workflow artifact", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-legacy-"))
  const configHome = path.join(home, "legacy-config")
  const priorSkills = [
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
  const priorAgents = ["autopilot-worker.md", "autopilot-recovery.md", "autopilot-reviewer.md"]
  const priorCommands = [
    "autopilot-start.md",
    "autopilot-status.md",
    "autopilot-pause.md",
    "autopilot-resume.md",
    "autopilot-stop.md",
  ]
  const sentinels = [
    ...priorSkills.map((name) => path.join(home, ".agents", "skills", name, "SKILL.md")),
    ...priorAgents.map((name) => path.join(configHome, "opencode", "agents", name)),
    ...priorCommands.map((name) => path.join(configHome, "opencode", "commands", name)),
  ]
  const expectedCandidates = [
    ...priorSkills.map((name) => path.join(home, ".agents", "skills", name)),
    ...priorAgents.map((name) => path.join(configHome, "opencode", "agents", name)),
    ...priorCommands.map((name) => path.join(configHome, "opencode", "commands", name)),
  ].sort((left, right) => left.localeCompare(right, "en"))
  try {
    for (const [index, file] of sentinels.entries()) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, `legacy sentinel ${index}\n`, "utf8")
    }

    const dryRun = install(["--home", home, "--config-home", configHome, "--dry-run", "--json"])
    assert.equal(dryRun.status, 0, dryRun.stderr)
    const inspected = JSON.parse(dryRun.stdout)
    assert.deepEqual(inspected.legacy_candidates, expectedCandidates)
    assert.match(inspected.legacy_note, /manual move\/removal only.*never modifies or deletes/i)

    const installed = install(["--home", home, "--config-home", configHome, "--json"])
    assert.equal(installed.status, 0, installed.stderr)
    const forced = install(["--home", home, "--config-home", configHome, "--force", "--json"])
    assert.equal(forced.status, 0, forced.stderr)
    for (const [index, file] of sentinels.entries()) {
      assert.equal(await readFile(file, "utf8"), `legacy sentinel ${index}\n`)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("global installer keeps phase roles and lifecycle commands project-local and writes a hash manifest", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-live-"))
  const configHome = path.join(home, "custom-config")
  try {
    const result = install(["--home", home, "--config-home", configHome, "--json"])
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, true)
    assert.equal(output.config_home, configHome)
    await access(path.join(configHome, "opencode", "commands", "init-project.md"))
    await access(path.join(configHome, "opencode", "commands", "evolve-project.md"))
    await assert.rejects(access(path.join(configHome, "opencode", "agents")), /ENOENT/)
    await assert.rejects(access(path.join(configHome, "opencode", "commands", "autopilot-start.md")), /ENOENT/)

    const installedTemplate = path.join(home, ".agents", "skills", "init-project", "assets", "project")
    for (const role of ["worker", "recovery", "reviewer"]) {
      const content = await readFile(path.join(installedTemplate, ".opencode", "agents", `autopilot-${role}.md`), "utf8")
      assert.match(content, /mode: primary/)
      assert.match(content, /  "\*": deny\r?\n  # BEGIN AUTOPILOT MANAGED TOOL GRANTS/)
      assert.match(content, /bash: deny/)
    }
    await access(path.join(installedTemplate, ".opencode", "commands", "autopilot-start.md"))
    await access(path.join(installedTemplate, ".autopilot", "bin", "configure-tools.mjs"))
    await access(path.join(home, ".agents", "skills", "init-project", "bin", "control-plane-global.mjs"))
    await access(output.launcher)
    const launched = process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", output.launcher, "--home", home, "--snapshot", "--json"], { cwd: root, encoding: "utf8", windowsHide: true })
      : spawnSync(output.launcher, ["--home", home, "--snapshot", "--json"], { cwd: root, encoding: "utf8", windowsHide: true })
    assert.equal(launched.status, 0, launched.stderr || launched.stdout)
    assert.deepEqual(JSON.parse(launched.stdout).projects, [])

    const manifest = JSON.parse(await readFile(path.join(home, ".agents", ".autopilot-install-manifest.json"), "utf8"))
    assert.equal(manifest.schema_version, 2)
    assert.equal(manifest.product_id, "opencode-control-plane")
    assert.equal(manifest.version, "1.4.5")
    assert.equal(manifest.full, false)
    assert.equal(manifest.home, home)
    assert.equal(manifest.config_home, configHome)
    assert.equal(manifest.bin_home, path.join(home, ".agents", "bin"))
    assert.ok(manifest.outputs.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)))
    assert.deepEqual(manifest.outputs.map((entry) => entry.destination), output.actions.map((entry) => entry.destination))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("--full adds every source skill but keeps phase roles and lifecycle commands project-local", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-full-"))
  try {
    const result = install(["--home", home, "--full", "--dry-run", "--json"])
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    const expectedSkills = (await readdir(path.join(root, ".agents", "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.equal(output.full, true)
    assert.deepEqual(
      output.actions.filter((action) => action.kind === "skill").map((action) => path.basename(action.destination)).sort(),
      expectedSkills,
    )
    assert.deepEqual(
      output.actions.filter((action) => action.kind === "command").map((action) => path.basename(action.destination)),
      ["evolve-project.md", "init-project.md"],
    )
    assert.equal(output.actions.some((action) => action.destination.includes(`${path.sep}agents${path.sep}`)), false)
    assert.equal(output.actions.some((action) => /autopilot-(?:start|status|pause|resume|stop)\.md$/.test(action.destination)), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("config-home resolution is explicit, staging-safe, and rejects relative XDG paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-config-"))
  const xdg = path.join(home, "xdg")
  try {
    const staged = install(["--home", home, "--dry-run", "--json"], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    })
    assert.equal(staged.status, 0, staged.stderr)
    assert.equal(JSON.parse(staged.stdout).config_home, path.join(home, ".config"))

    const environmentSelected = install(["--dry-run", "--json"], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    })
    assert.equal(environmentSelected.status, 0, environmentSelected.stderr)
    assert.equal(JSON.parse(environmentSelected.stdout).config_home, xdg)

    const relative = install(["--dry-run"], {
      env: { ...process.env, XDG_CONFIG_HOME: "relative-config" },
    })
    assert.notEqual(relative.status, 0)
    assert.match(relative.stderr, /XDG_CONFIG_HOME must be absolute/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("installer rejects source overlap, overlapping targets, and missing path options without writing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-boundary-"))
  try {
    const sourceHome = install(["--home", root, "--dry-run"])
    assert.notEqual(sourceHome.status, 0)
    assert.match(sourceHome.stderr, /home cannot be the installer source repository/)

    const sourceConfig = install(["--home", home, "--config-home", root, "--dry-run"])
    assert.notEqual(sourceConfig.status, 0)
    assert.match(sourceConfig.stderr, /config home cannot be the installer source repository/)

    const nestedConfig = path.join(home, ".agents", "skills", "init-project", "config")
    const overlap = install(["--home", home, "--config-home", nestedConfig, "--dry-run"])
    assert.notEqual(overlap.status, 0)
    assert.match(overlap.stderr, /Install targets overlap/)

    for (const option of ["--home", "--config-home"]) {
      const missing = install([option, "--dry-run"])
      assert.notEqual(missing.status, 0)
      assert.match(missing.stderr, new RegExp(`${option} requires a path`))
    }
    await assert.rejects(access(path.join(home, ".agents")), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("installer rejects symlink or junction traversal under selected roots", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-link-"))
  const home = path.join(parent, "home")
  const outside = path.join(parent, "outside")
  try {
    await Promise.all([mkdir(home), mkdir(outside)])
    try {
      await symlink(outside, path.join(home, ".agents"), process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`link creation is unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const result = install(["--home", home, "--dry-run"])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /symbolic link or junction/)
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("global installer preflights every conflict before writing anything", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-conflict-"))
  try {
    const conflict = path.join(home, ".agents", "skills", "init-project")
    await mkdir(conflict, { recursive: true })
    await writeFile(path.join(conflict, "owned.txt"), "owned by user", "utf8")
    const result = install(["--home", home])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Refusing to overwrite/)
    assert.equal(await readFile(path.join(conflict, "owned.txt"), "utf8"), "owned by user")
    await assert.rejects(access(path.join(home, ".config")), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("forced installation rolls every destination back after a mid-swap failure", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-rollback-"))
  try {
    const first = install(["--home", home, "--full", "--json"])
    assert.equal(first.status, 0, first.stderr)
    const installed = JSON.parse(first.stdout)
    const touchedFiles = installed.actions.filter((action) => action.kind === "skill").slice(0, 2).map((action) => path.join(action.destination, "SKILL.md"))
    const originals = await Promise.all(touchedFiles.map((file) => readFile(file, "utf8")))
    await Promise.all(touchedFiles.map((file, index) => writeFile(file, `user backup sentinel ${index}\n`, "utf8")))

    const failed = install(["--home", home, "--full", "--force"], {
      env: { ...process.env, NODE_ENV: "test", AUTOPILOT_TEST_INSTALL_FAIL_AFTER: "2" },
    })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /Injected transactional installer failure/)
    for (const [index, file] of touchedFiles.entries()) {
      assert.equal(await readFile(file, "utf8"), `user backup sentinel ${index}\n`)
      assert.notEqual(originals[index], `user backup sentinel ${index}\n`)
    }

    const leftovers = []
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name)
        if (/\.autopilot-(?:stage|backup)-/.test(entry.name)) leftovers.push(location)
        if (entry.isDirectory()) await visit(location)
      }
    }
    await visit(home)
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("upgrade mode preserves the prior install selection and rejects global drift", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-install-upgrade-"))
  try {
    const first = install(["--home", home, "--full", "--json"])
    assert.equal(first.status, 0, first.stderr)
    const preview = install(["--home", home, "--upgrade", "--dry-run", "--json"])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(JSON.parse(preview.stdout).full, true)

    const upgraded = install(["--home", home, "--upgrade", "--json"])
    assert.equal(upgraded.status, 0, upgraded.stderr)
    const manifest = JSON.parse(await readFile(path.join(home, ".agents", ".autopilot-install-manifest.json"), "utf8"))
    assert.equal(manifest.previous_version, "1.4.5")

    const drift = path.join(home, ".agents", "skills", "init-project", "SKILL.md")
    await writeFile(drift, "user-edited global skill\n", "utf8")
    const blocked = install(["--home", home, "--upgrade", "--json"])
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /drifted outside the upgrade system/)
    assert.equal(await readFile(drift, "utf8"), "user-edited global skill\n")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("upgrade mode accepts the prior schema-1 install manifest", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-plane-install-legacy-manifest-"))
  try {
    const first = install(["--home", home, "--json"])
    assert.equal(first.status, 0, first.stderr)
    const manifestFile = path.join(home, ".agents", ".autopilot-install-manifest.json")
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"))
    manifest.schema_version = 1
    for (const key of ["product_id", "name", "version", "repository", "previous_version"]) delete manifest[key]
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    const upgraded = install(["--home", home, "--upgrade", "--json"])
    assert.equal(upgraded.status, 0, upgraded.stderr)
    assert.equal(JSON.parse(await readFile(manifestFile, "utf8")).schema_version, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
