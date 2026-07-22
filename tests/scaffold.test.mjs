import assert from "node:assert/strict"
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scaffoldScript = path.join(root, ".agents", "skills", "init-project", "bin", "scaffold.mjs")
const rendererScript = path.join(root, ".agents", "skills", "init-project", "bin", "render-blueprint.mjs")
const finalizerScript = path.join(root, ".agents", "skills", "init-project", "bin", "finalize.mjs")
const closeoutScript = path.join(root, ".agents", "skills", "init-project", "bin", "finalize-and-launch.mjs")

function validBlueprint() {
  return {
    schema_version: 5,
    metadata: {
      description: "A bounded example project.",
      tags: ["example"],
    },
    product: {
      name: "Example project",
      outcome: "Deliver one independently verified vertical slice.",
      primary_users: ["Local test operators"],
      problem: "The initial workflow needs a deterministic, bounded implementation path.",
      core_journeys: ["Initialize, build, verify, and inspect evidence"],
      success_signals: ["All fixed gates pass", "The acceptance behavior is demonstrated"],
      in_scope: ["One local vertical slice"],
      out_of_scope: ["Production deployment"],
      completion_boundary: "The queued task and final gate complete with immutable evidence.",
      supported_languages: ["en"],
    },
    architecture: {
      components: [{ name: "Application", responsibility: "Own the bounded product behavior." }],
      data_flows: ["Input enters the application and produces a deterministic result."],
      dependency_rules: ["Application code depends only on declared local interfaces."],
      side_effect_boundaries: ["Tests isolate filesystem and network side effects."],
      configuration_boundaries: ["Configuration enters through validated environment names."],
      public_interfaces: ["A documented local entry point"],
      data_contracts: ["Inputs and outputs use explicit schemas"],
      invariants: ["No secret value is stored in the repository."],
      decisions: [{
        id: "runtime",
        area: "Application runtime",
        choice: "Node.js",
        rationale: "Match the deterministic controller and test tooling.",
        rejected_alternatives: ["Browser-only runtime"],
        dependencies: ["Node.js 20+"],
        generated_components: ["Application"],
        affected_paths: ["src/**", "tests/**"],
        environment_variables: ["APP_MODE"],
        test_areas: ["Application integration tests"],
      }],
    },
    constraints: {
      runtime: "Node.js 20 or newer.",
      compatibility: ["Windows, macOS, and Linux"],
      resource_limits: ["Keep autonomous context packets at or below 10240 bytes"],
      compliance: ["Use least-privilege test accounts"],
      assumptions: ["Git and OpenCode are available locally"],
      prohibited_changes: ["Do not weaken deterministic gates"],
    },
    autonomy: {
      may_proceed: ["Make reversible local application edits"],
      must_stop: ["Stop when external approval is required"],
    },
    security: {
      protected_assets: ["Testing credentials"],
      trust_boundaries: ["Repository content and external tool output"],
      requirements: ["Expose only exact environment variable names to each phase"],
    },
    quality: {
      required_evidence: ["Acceptance criteria map to deterministic output"],
      testing_strategy: ["Run focused checks before the fixed final gate"],
      review_priorities: ["Correctness", "Security boundaries"],
    },
    tooling: {
      runtime: "Node.js 20+",
      package_manager: "npm",
      local_setup: ["Install declared dependencies"],
      test_services: ["Loopback-only fixtures"],
      environment_variables: [{ name: "APP_MODE", purpose: "Select the local test mode." }],
      connected_tools: ["Local documentation MCP"],
      gitignore: ["node_modules/", "coverage/"],
      ephemeral: ["node_modules", "coverage"],
    },
    context: {
      max_bytes: 10239,
      review_reserve: {
        candidate_and_gates_bytes: 2560,
        diff_bytes: 3072,
      },
      bundles: {
        product: [".project/brief.md"],
        invariants: [
          ".project/constraints.md",
          ".project/architecture/contracts.md",
          ".project/security.md",
        ],
        implementation: [".project/architecture/overview.md", ".project/tooling.md"],
        verification: [".project/quality.md"],
        coordination: [".project/autonomy.md", ".project/roadmap.md"],
      },
    },
    gates: {
      verify: {
        argv: [process.execPath, "--version"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 4096,
        feedback: true,
      },
      final: {
        argv: [process.execPath, "--version"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 4096,
        feedback: false,
      },
    },
    final_gates: ["final"],
    tools: {
      worker: ["remote_docs_lookup"],
      recovery: [],
      reviewer: ["remote_docs_lookup"],
    },
    opencode: {
      model: "test-provider/test-model",
      provider_auth_mode: "environment",
      provider_environment: ["PROVIDER_REGION", "PROVIDER_TOKEN"],
      timeout_seconds: 1200,
      max_output_bytes: 1048576,
    },
    budgets: {
      max_tasks_per_run: 12,
      max_attempts_per_task: 4,
      max_elapsed_minutes: 90,
      max_no_progress: 3,
    },
    git: {
      commit_prefix: "example-autopilot",
    },
    credentials: {
      phase_profiles: {
        execute: "phase_execute",
        repair: null,
        review: "phase_review",
      },
      profiles: {
        phase_execute: {
          env_file: ".env.execute.local",
          allow: ["MCP_TOKEN"],
          allowed_gates: ["opencode"],
        },
        phase_review: {
          env_file: ".env.review.local",
          allow: ["MCP_TOKEN"],
          allowed_gates: ["opencode"],
        },
      },
    },
    mcp: {
      local_docs: {
        type: "local",
        command: [process.execPath, "--version"],
        timeout: 5000,
      },
      remote_docs: {
        type: "remote",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer {env:MCP_TOKEN}" },
        timeout: 5000,
      },
    },
    roadmap: [{ id: "M1", outcome: "Deliver the first slice", exit_signal: "All fixed evidence is green" }],
    tasks: [{
      id: "M001",
      title: "Build the first verified vertical slice",
      outcome: "Produce a demonstrable local behavior with deterministic evidence.",
      acceptance_criteria: ["The local behavior produces its documented result"],
      required_evidence: ["The verify gate exits successfully"],
      non_goals: ["Production deployment"],
      verification_notes: ["Run the verify gate before independent review"],
      depends_on: [],
      priority: 100,
      context: {
        shared: ["invariants"],
        execute: ["implementation", "verification"],
        repair: ["implementation", "verification"],
        review: ["verification"],
      },
      allowed_paths: ["src/**", "tests/**", ".github/**", ".dockerignore"],
      gates: ["verify", "final"],
      tool_grants: {
        execute: ["remote_docs_lookup"],
        repair: [],
        review: ["remote_docs_lookup"],
      },
      risk: "medium",
      attempt_limit: 3,
    }],
  }
}

function runNode(script, args, cwd, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  })
}

function scaffoldTarget(target) {
  return runNode(scaffoldScript, ["--target", target, "--no-git", "--json"], root)
}

test("finalizer source fixes process bounds and noninteractive hook-free Git plumbing", async () => {
  const source = await readFile(finalizerScript, "utf8")
  assert.match(source, /runArgv\(\[command, \.\.\.commandArgs\]/)
  assert.match(source, /guardProcessTree = true/)
  assert.match(source, /guardProcessTree: false/)
  assert.match(source, /resolveExternalGitExecutable/)
  assert.match(source, /sanitizeProcessResult/)
  assert.match(source, /PROCESS_TIMEOUT_MS = 120_000/)
  assert.match(source, /PROCESS_OUTPUT_BYTES = 1024 \* 1024/)
  assert.match(source, /"commit-tree"/)
  assert.match(source, /"update-ref"/)
  assert.match(source, /core\.hooksPath=/)
  assert.match(source, /commit\.gpgSign=false/)
  assert.match(source, /GIT_TERMINAL_PROMPT: "0"/)
  assert.doesNotMatch(source, /spawnSync|\["commit",/)

  const closeout = await readFile(closeoutScript, "utf8")
  assert.match(closeout, /runArgv\(\[command, \.\.\.commandArgs\]/)
  assert.match(closeout, /FINALIZE_TIMEOUT_MS = 10 \* 60 \* 1000/)
  assert.match(closeout, /PREFLIGHT_TIMEOUT_MS = 30 \* 60 \* 1000/)
  assert.match(closeout, /START_TIMEOUT_MS = 2 \* 60 \* 1000/)
  assert.match(closeout, /PROCESS_OUTPUT_BYTES = 4 \* 1024 \* 1024/)
  assert.match(closeout, /PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES/)
  assert.match(closeout, /PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES/)
  assert.match(closeout, /exactSecretVariants/)
  assert.doesNotMatch(closeout, /const PROVIDER_ENVIRONMENT_(?:VALUE|TOTAL)_MAX_BYTES/)
  assert.doesNotMatch(closeout, /function diagnosticSecretVariants/)
  assert.match(closeout, /safeBaseEnv\(source\)/)
  assert.match(closeout, /OPENCODE_AUTH_CONTENT/)
  assert.match(closeout, /XDG_DATA_HOME/)
  assert.match(closeout, /guardProcessTree: false/)
  assert.match(closeout, /guardProcessTree = true/)
  assert.doesNotMatch(closeout, /spawnSync/)
})

test("scaffolder creates the bounded project control plane", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-scaffold-"))
  try {
    const result = spawnSync(
      process.execPath,
      [scaffoldScript, "--target", target, "--no-git", "--json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, true)
    assert.deepEqual(output.tool_grants, { worker: [], recovery: [], reviewer: [] })
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8")
    assert.ok(Buffer.byteLength(agents) <= 2560)
    assert.ok(!agents.includes("SYSTEM.md"))
    assert.match(await readFile(path.join(target, ".gitignore"), "utf8"), /opencode-autopilot/)
    assert.deepEqual(JSON.parse(await readFile(path.join(target, ".project", "tools.json"))), {
      schema_version: 1,
      roles: { worker: [], recovery: [], reviewer: [] },
    })
    const config = JSON.parse(await readFile(path.join(target, ".autopilot", "config.json")))
    assert.deepEqual(config.opencode.agents, {
      execute: "autopilot-worker",
      repair: "autopilot-recovery",
      review: "autopilot-reviewer",
    })
    assert.equal(Object.hasOwn(config.opencode, "agent"), false)
    assert.equal(config.opencode.timeout_seconds, 1800)
    assert.equal(config.opencode.max_output_bytes, 2097152)
    const starterBlueprint = JSON.parse(await readFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      "utf8",
    ))
    assert.equal(starterBlueprint.schema_version, 5)
    assert.deepEqual(starterBlueprint.tooling.gitignore, [])
    assert.deepEqual(starterBlueprint.tooling.ephemeral, [])
    assert.deepEqual(starterBlueprint.opencode, {
      model: "provider/model",
      provider_auth_mode: "none",
      provider_environment: [],
      timeout_seconds: 1800,
      max_output_bytes: 2097152,
    })
    assert.deepEqual(starterBlueprint.credentials.phase_profiles, {
      execute: null,
      repair: null,
      review: null,
    })
    const opencode = JSON.parse(await readFile(path.join(target, "opencode.jsonc"), "utf8"))
    assert.equal(opencode.default_agent, "build")
    assert.deepEqual(opencode.compaction, { auto: true, prune: true, tail_turns: 2 })
    assert.deepEqual(opencode.tool_output, { max_lines: 300, max_bytes: 32768 })
    assert.equal(opencode.permission.edit[".autopilot/init/blueprint.json"], "allow")
    assert.equal(Object.hasOwn(opencode.compaction, "reserved"), false)
    assert.equal(Object.hasOwn(opencode.compaction, "preserve_recent_tokens"), false)
    assert.deepEqual((await readdir(path.join(target, ".opencode", "agents"))).sort(), [
      "autopilot-recovery.md",
      "autopilot-reviewer.md",
      "autopilot-worker.md",
    ])
    for (const role of ["worker", "recovery", "reviewer"]) {
      const content = await readFile(path.join(target, ".opencode", "agents", `autopilot-${role}.md`), "utf8")
      assert.match(content, /mode: primary/)
      assert.doesNotMatch(content, /mode: subagent/)
      assert.match(content, /  "\*": deny\r?\n  # BEGIN AUTOPILOT MANAGED TOOL GRANTS/)
      assert.match(content, /bash: deny/)
    }
    const toolCheck = spawnSync(
      process.execPath,
      [path.join(target, ".autopilot", "bin", "configure-tools.mjs"), "--root", target, "--check", "--json"],
      { cwd: target, encoding: "utf8", windowsHide: true },
    )
    assert.equal(toolCheck.status, 0, toolCheck.stderr || toolCheck.stdout)
    assert.equal(JSON.parse(await readFile(path.join(target, ".autopilot", "state.json"))).status, "idle")
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("scaffolder does not trust a marker-only existing Git ignore file", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-marker-ignore-"))
  try {
    await writeFile(path.join(target, ".gitignore"), "# opencode-autopilot\n", "utf8")
    const scaffold = scaffoldTarget(target)
    assert.equal(scaffold.status, 0, scaffold.stderr)
    const gitignore = await readFile(path.join(target, ".gitignore"), "utf8")
    assert.match(gitignore, /\.env\r?\n\.env\.\*\r?\n!\.env\.example\r?\n\.env\*\.local/)
    assert.match(gitignore, /\.autopilot\/credentials\.json/)
    assert.match(gitignore, /\.autopilot\/runtime\//)
    assert.match(gitignore, /\.autopilot\/init\//)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("tool configurator generates deterministic exact grants and check mode detects drift without writing", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-tools-"))
  try {
    const scaffold = spawnSync(
      process.execPath,
      [scaffoldScript, "--target", target, "--no-git", "--json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
    assert.equal(scaffold.status, 0, scaffold.stderr)

    const toolsFile = path.join(target, ".project", "tools.json")
    await writeFile(
      toolsFile,
      `${JSON.stringify({
        schema_version: 1,
        roles: {
          worker: ["zeta_lookup", "acme_search"],
          recovery: ["acme_search"],
          reviewer: ["review_lookup"],
        },
      }, null, 2)}\n`,
      "utf8",
    )
    const configurator = path.join(target, ".autopilot", "bin", "configure-tools.mjs")
    const configured = spawnSync(process.execPath, [configurator, "--root", target, "--json"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    })
    assert.equal(configured.status, 0, configured.stderr)
    assert.deepEqual(JSON.parse(configured.stdout).grants.worker, ["acme_search", "zeta_lookup"])

    const workerFile = path.join(target, ".opencode", "agents", "autopilot-worker.md")
    const generated = await readFile(workerFile, "utf8")
    assert.match(
      generated,
      /  "\*": deny\r?\n  # BEGIN AUTOPILOT MANAGED TOOL GRANTS\r?\n  "acme_search": allow\r?\n  "zeta_lookup": allow\r?\n  # END AUTOPILOT MANAGED TOOL GRANTS/,
    )
    assert.equal(
      (await readdir(path.dirname(workerFile))).some((name) => name.includes(".autopilot-") && name.endsWith(".tmp")),
      false,
    )
    const synchronized = spawnSync(
      process.execPath,
      [configurator, "--root", target, "--check", "--json"],
      { cwd: target, encoding: "utf8", windowsHide: true },
    )
    assert.equal(synchronized.status, 0, synchronized.stderr || synchronized.stdout)

    const tampered = generated.replace(/  "acme_search": allow\r?\n/, "")
    assert.notEqual(tampered, generated)
    await writeFile(workerFile, tampered, "utf8")
    const drift = spawnSync(
      process.execPath,
      [configurator, "--root", target, "--check", "--json"],
      { cwd: target, encoding: "utf8", windowsHide: true },
    )
    assert.notEqual(drift.status, 0)
    assert.deepEqual(JSON.parse(drift.stdout).drift, [".opencode/agents/autopilot-worker.md"])
    assert.equal(await readFile(workerFile, "utf8"), tampered)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("tool configurator rejects wildcard and built-in grants without changing role files", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-tools-invalid-"))
  try {
    const scaffold = spawnSync(
      process.execPath,
      [scaffoldScript, "--target", target, "--no-git", "--json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
    assert.equal(scaffold.status, 0, scaffold.stderr)
    const toolsFile = path.join(target, ".project", "tools.json")
    const workerFile = path.join(target, ".opencode", "agents", "autopilot-worker.md")
    const configurator = path.join(target, ".autopilot", "bin", "configure-tools.mjs")
    const original = await readFile(workerFile, "utf8")

    for (const [identifier, expected] of [
      ["acme_*", /unsafe or non-exact/],
      ["bash", /built-in\/control/],
    ]) {
      await writeFile(
        toolsFile,
        `${JSON.stringify({
          schema_version: 1,
          roles: { worker: [identifier], recovery: [], reviewer: [] },
        }, null, 2)}\n`,
        "utf8",
      )
      const rejected = spawnSync(process.execPath, [configurator, "--root", target, "--json"], {
        cwd: target,
        encoding: "utf8",
        windowsHide: true,
      })
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stderr, expected)
      assert.equal(await readFile(workerFile, "utf8"), original)
    }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("tool configurator preflights every role before any atomic replacement", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-tools-preflight-"))
  try {
    const scaffold = spawnSync(
      process.execPath,
      [scaffoldScript, "--target", target, "--no-git", "--json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
    assert.equal(scaffold.status, 0, scaffold.stderr)
    await writeFile(
      path.join(target, ".project", "tools.json"),
      `${JSON.stringify({
        schema_version: 1,
        roles: { worker: ["acme_search"], recovery: [], reviewer: [] },
      }, null, 2)}\n`,
      "utf8",
    )

    const agentsDirectory = path.join(target, ".opencode", "agents")
    const workerFile = path.join(agentsDirectory, "autopilot-worker.md")
    const reviewerFile = path.join(agentsDirectory, "autopilot-reviewer.md")
    const workerBefore = await readFile(workerFile, "utf8")
    const reviewer = await readFile(reviewerFile, "utf8")
    await writeFile(reviewerFile, reviewer.replace("  # END AUTOPILOT MANAGED TOOL GRANTS", ""), "utf8")

    const rejected = spawnSync(
      process.execPath,
      [path.join(target, ".autopilot", "bin", "configure-tools.mjs"), "--root", target, "--json"],
      { cwd: target, encoding: "utf8", windowsHide: true },
    )
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /exactly one managed tool marker pair/)
    assert.equal(await readFile(workerFile, "utf8"), workerBefore)
    assert.equal(
      (await readdir(agentsDirectory)).some((name) => name.includes(".autopilot-") && name.endsWith(".tmp")),
      false,
    )
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("scaffolder has no overwrite mode and preserves every file in a nonempty target", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-nonempty-"))
  try {
    const existingControl = path.join(target, ".project", "brief.md")
    await mkdir(path.dirname(existingControl), { recursive: true })
    await writeFile(path.join(target, "owned.txt"), "user data", "utf8")
    await writeFile(existingControl, "existing control data", "utf8")

    for (const extra of [[], ["--force"]]) {
      const result = spawnSync(
        process.execPath,
        [scaffoldScript, "--target", target, "--no-git", ...extra],
        { cwd: root, encoding: "utf8", windowsHide: true },
      )
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, extra.length === 0 ? /not empty/i : /--force is not supported/i)
    }
    assert.equal(await readFile(path.join(target, "owned.txt"), "utf8"), "user data")
    assert.equal(await readFile(existingControl, "utf8"), "existing control data")
    await assert.rejects(access(path.join(target, "AGENTS.md")), /ENOENT/)

    const help = runNode(scaffoldScript, ["--help"], root)
    assert.equal(help.status, 0, help.stderr)
    assert.doesNotMatch(help.stdout, /--force/)
    const disguisedForce = runNode(scaffoldScript, ["--target", "--force", "--no-git"], root)
    assert.notEqual(disguisedForce.status, 0)
    assert.match(disguisedForce.stderr, /--target requires a path/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("scaffolder rejects linked optional target entries before writing", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-optional-links-"))
  const outsideIgnore = path.join(parent, "outside.gitignore")
  const hardlinkTarget = path.join(parent, "hardlink-target")
  const symlinkTarget = path.join(parent, "symlink-target")
  const outsideRepository = path.join(parent, "outside-repository")
  const linkedGitTarget = path.join(parent, "linked-git-target")
  const oversizedTarget = path.join(parent, "oversized-target")
  try {
    await Promise.all([
      writeFile(outsideIgnore, "outside must stay unchanged\n", "utf8"),
      mkdir(hardlinkTarget),
      mkdir(symlinkTarget),
      mkdir(outsideRepository),
      mkdir(linkedGitTarget),
      mkdir(oversizedTarget),
    ])

    await link(outsideIgnore, path.join(hardlinkTarget, ".gitignore"))
    const hardlinkRejected = scaffoldTarget(hardlinkTarget)
    assert.notEqual(hardlinkRejected.status, 0)
    assert.match(hardlinkRejected.stderr, /\.gitignore.*private regular file|hard.?link/i)
    assert.equal(await readFile(outsideIgnore, "utf8"), "outside must stay unchanged\n")
    await assert.rejects(access(path.join(hardlinkTarget, "AGENTS.md")), /ENOENT/)

    await writeFile(path.join(oversizedTarget, ".gitignore"), "x".repeat(1024 * 1024 + 1), "utf8")
    const oversizedRejected = scaffoldTarget(oversizedTarget)
    assert.notEqual(oversizedRejected.status, 0)
    assert.match(oversizedRejected.stderr, /\.gitignore exceeds the 1048576-byte initialization cap/i)
    await assert.rejects(access(path.join(oversizedTarget, "AGENTS.md")), /ENOENT/)

    let canCreateLinks = true
    try {
      await symlink(outsideIgnore, path.join(symlinkTarget, ".gitignore"), "file")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        canCreateLinks = false
        context.diagnostic(`optional-entry symlink checks unavailable: ${error.code}`)
      } else throw error
    }
    if (canCreateLinks) {
      const symlinkRejected = scaffoldTarget(symlinkTarget)
      assert.notEqual(symlinkRejected.status, 0)
      assert.match(symlinkRejected.stderr, /\.gitignore.*private regular file|link/i)
      await assert.rejects(access(path.join(symlinkTarget, "AGENTS.md")), /ENOENT/)

      assert.equal(spawnSync("git", ["init"], {
        cwd: outsideRepository,
        encoding: "utf8",
        windowsHide: true,
      }).status, 0)
      await symlink(
        path.join(outsideRepository, ".git"),
        path.join(linkedGitTarget, ".git"),
        process.platform === "win32" ? "junction" : "dir",
      )
      const gitLinkRejected = scaffoldTarget(linkedGitTarget)
      assert.notEqual(gitLinkRejected.status, 0)
      assert.match(gitLinkRejected.stderr, /Existing \.git must be a real local directory|link/i)
      await assert.rejects(access(path.join(linkedGitTarget, "AGENTS.md")), /ENOENT/)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("scaffolder allows an unborn local Git directory but rejects existing commit history", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-optional-git-"))
  const unborn = path.join(parent, "unborn")
  const history = path.join(parent, "history")
  const misdirected = path.join(parent, "misdirected")
  const otherWorktree = path.join(parent, "other-worktree")
  try {
    await Promise.all([mkdir(unborn), mkdir(history), mkdir(misdirected), mkdir(otherWorktree)])
    assert.equal(spawnSync("git", ["init"], { cwd: unborn, encoding: "utf8", windowsHide: true }).status, 0)
    const allowed = scaffoldTarget(unborn)
    assert.equal(allowed.status, 0, allowed.stderr)
    await access(path.join(unborn, "AGENTS.md"))

    assert.equal(spawnSync("git", ["init"], { cwd: history, encoding: "utf8", windowsHide: true }).status, 0)
    const committed = spawnSync(
      "git",
      [
        "-c", "user.name=Autopilot Test",
        "-c", "user.email=autopilot@example.invalid",
        "commit", "--allow-empty", "-m", "existing history",
      ],
      { cwd: history, encoding: "utf8", windowsHide: true },
    )
    assert.equal(committed.status, 0, committed.stderr)
    const rejected = scaffoldTarget(history)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /\.git already has commit history/i)
    await assert.rejects(access(path.join(history, "AGENTS.md")), /ENOENT/)

    assert.equal(spawnSync("git", ["init"], { cwd: misdirected, encoding: "utf8", windowsHide: true }).status, 0)
    assert.equal(spawnSync("git", ["config", "core.worktree", otherWorktree], {
      cwd: misdirected,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
    const misdirectedRejected = scaffoldTarget(misdirected)
    assert.notEqual(misdirectedRejected.status, 0)
    assert.match(misdirectedRejected.stderr, /Git worktree|exact scaffold target|another worktree/i)
    await assert.rejects(access(path.join(misdirected, "AGENTS.md")), /ENOENT/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("scaffolder Git initialization ignores ambient templates and global config", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-git-template-"))
  const target = path.join(parent, "target")
  const template = path.join(parent, "hostile-template")
  const globalConfig = path.join(parent, "hostile-global-config")
  try {
    await Promise.all([mkdir(target), mkdir(path.join(template, "hooks"), { recursive: true })])
    await writeFile(path.join(template, "hooks", "pre-commit"), "hostile template hook\n", "utf8")
    await writeFile(globalConfig, `[init]\n\ttemplateDir = ${template.replaceAll("\\", "/")}\n`, "utf8")
    const initialized = runNode(scaffoldScript, ["--target", target, "--json"], root, {
      env: {
        ...process.env,
        GIT_TEMPLATE_DIR: template,
        GIT_CONFIG_GLOBAL: globalConfig,
      },
      timeout: 30_000,
    })
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(JSON.parse(initialized.stdout).git_initialized, true)
    await assert.rejects(access(path.join(target, ".git", "hooks", "pre-commit")), /ENOENT/)
    assert.equal(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), "true")
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("scaffolder refuses targets that overlap its template source", async () => {
  const assetRoot = path.join(root, ".agents", "skills", "init-project", "assets", "project")
  const nestedTarget = path.join(assetRoot, ".overlap-probe")
  const result = runNode(scaffoldScript, ["--target", nestedTarget, "--no-git", "--json"], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /disjoint/i)
  await assert.rejects(readFile(path.join(nestedTarget, "AGENTS.md"), "utf8"))
})

test("scaffolder and renderer refuse a symbolic-link or junction target root", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-scaffold-root-link-"))
  const realTarget = path.join(parent, "real")
  const linkedTarget = path.join(parent, "linked")
  try {
    await mkdir(realTarget)
    try {
      await symlink(realTarget, linkedTarget, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`links are unavailable on this platform: ${error.code}`)
        return
      }
      throw error
    }
    const result = scaffoldTarget(linkedTarget)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /real directory|symbolic link|junction/i)
    assert.deepEqual(await readdir(realTarget), [])

    assert.equal(scaffoldTarget(realTarget).status, 0)
    await writeFile(
      path.join(realTarget, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    const render = runNode(rendererScript, ["--target", linkedTarget, "--json"], realTarget)
    assert.notEqual(render.status, 0)
    assert.match(render.stderr, /real directory|link|junction/i)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("structured blueprint rendering is deterministic, bounded, and OpenCode-compatible", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-"))
  try {
    await writeFile(path.join(target, ".gitignore"), "custom-cache/\n", "utf8")
    const scaffold = scaffoldTarget(target)
    assert.equal(scaffold.status, 0, scaffold.stderr)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    const blueprint = validBlueprint()
    await writeFile(blueprintFile, `${JSON.stringify(blueprint, null, 2)}\n`, "utf8")

    const rendered = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(rendered.status, 0, rendered.stderr)
    const first = JSON.parse(rendered.stdout)
    assert.equal(first.ok, true)
    assert.deepEqual(first.ready_tasks, ["M001"])

    const queue = JSON.parse(await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8"))
    assert.equal(queue.project_status, "ready")
    assert.equal(queue.tasks.M001.status, "ready")
    assert.deepEqual(queue.tasks.M001.gates, ["verify", "final"])
    assert.deepEqual(queue.tasks.M001.tool_grants, blueprint.tasks[0].tool_grants)
    const openCode = JSON.parse(await readFile(path.join(target, "opencode.jsonc"), "utf8"))
    assert.equal(Object.hasOwn(openCode.mcp.local_docs, "cwd"), false)
    assert.equal(openCode.mcp.local_docs.timeout, 5000)
    assert.equal(openCode.mcp.remote_docs.headers.Authorization, "Bearer {env:MCP_TOKEN}")
    const config = JSON.parse(await readFile(path.join(target, ".autopilot", "config.json"), "utf8"))
    assert.equal(config.opencode.model, blueprint.opencode.model)
    assert.equal(config.opencode.provider_auth_mode, blueprint.opencode.provider_auth_mode)
    assert.deepEqual(config.opencode.provider_environment, blueprint.opencode.provider_environment)
    assert.equal(config.opencode.timeout_seconds, blueprint.opencode.timeout_seconds)
    assert.equal(config.opencode.max_output_bytes, blueprint.opencode.max_output_bytes)
    assert.deepEqual(config.opencode.credential_profiles, blueprint.credentials.phase_profiles)
    assert.deepEqual(config.budgets, blueprint.budgets)
    assert.deepEqual(config.git, {
      require_clean_start: true,
      local_commits: true,
      commit_prefix: blueprint.git.commit_prefix,
      ephemeral_roots: blueprint.tooling.ephemeral,
    })
    assert.deepEqual(config.context, { max_bytes: blueprint.context.max_bytes })
    assert.equal(config.opencode.auto_approve, true)
    assert.equal(config.opencode.attach_url, null)
    const manifest = JSON.parse(
      await readFile(path.join(target, "blueprints", "current", "render-manifest.json"), "utf8"),
    )
    assert.equal(manifest.status, "complete")
    assert.ok(manifest.outputs[".project/brief.md"])
    assert.ok(manifest.outputs[".gitignore"])
    const gitignore = await readFile(path.join(target, ".gitignore"), "utf8")
    assert.match(gitignore, /^custom-cache\//)
    assert.match(gitignore, /# BEGIN OPENCODE AUTOPILOT STACK IGNORES\r?\nnode_modules\/\r?\ncoverage\//)
    assert.match(gitignore, /# END OPENCODE AUTOPILOT STACK IGNORES/)
    assert.match(gitignore, /# END OPENCODE AUTOPILOT STACK IGNORES\r?\n\r?\n# opencode-autopilot\r?\n[\s\S]*\.autopilot\/init\/\r?\n$/)
    const environmentExample = await readFile(path.join(target, ".env.example"), "utf8")
    assert.match(environmentExample, /MCP_TOKEN=/)
    assert.match(environmentExample, /PROVIDER_REGION=/)
    assert.match(environmentExample, /PROVIDER_TOKEN=/)
    assert.doesNotMatch(await readFile(path.join(target, ".project", "brief.md"), "utf8"), /\{\{/)

    const second = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(second.status, 0, second.stderr)
    assert.deepEqual(JSON.parse(second.stdout).changed, [])

    await writeFile(path.join(target, "owned.txt"), "leave me alone\n", "utf8")
    blueprint.product.outcome = "Deliver an updated, independently verified vertical slice."
    await writeFile(blueprintFile, `${JSON.stringify(blueprint, null, 2)}\n`, "utf8")
    const updated = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(updated.status, 0, updated.stderr)
    assert.match(await readFile(path.join(target, ".project", "brief.md"), "utf8"), /updated, independently/)
    assert.equal(await readFile(path.join(target, "owned.txt"), "utf8"), "leave me alone\n")

    const configured = runNode(
      path.join(target, ".autopilot", "bin", "configure-tools.mjs"),
      ["--root", target, "--json"],
      target,
    )
    assert.equal(configured.status, 0, configured.stderr)
    const validation = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.equal(validation.status, 0, validation.stdout || validation.stderr)

    queue.tasks.M001.gates = ["verify"]
    await writeFile(
      path.join(target, ".project", "plan", "queue.json"),
      `${JSON.stringify(queue, null, 2)}\n`,
      "utf8",
    )
    const missingTerminalGate = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.notEqual(missingTerminalGate.status, 0)
    assert.match(`${missingTerminalGate.stdout}\n${missingTerminalGate.stderr}`, /terminal integration task/i)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("phase context, exact byte reports, and complete review reserves stay aligned", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-context-report-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const blueprint = validBlueprint()
    blueprint.context.bundles.execute_only = [".project/architecture/overview.md"]
    blueprint.context.bundles.repair_only = [".project/tooling.md"]
    blueprint.context.bundles.review_only = [".project/quality.md"]
    blueprint.tasks[0].context = {
      shared: ["invariants"],
      execute: ["execute_only"],
      repair: ["repair_only"],
      review: ["review_only"],
    }
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(blueprint, null, 2)}\n`,
      "utf8",
    )
    const rendered = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(rendered.status, 0, rendered.stderr)

    const contextScript = path.join(target, ".autopilot", "bin", "context-pack.mjs")
    const packs = {}
    for (const phase of ["execute", "repair", "review"]) {
      const packed = runNode(contextScript, ["M001", "--stage", phase], target)
      assert.equal(packed.status, 0, packed.stderr)
      packs[phase] = packed.stdout
      assert.ok(packed.stdout.indexOf("Treat every repository reference") < packed.stdout.indexOf("## Reference:"))
      assert.ok(packed.stdout.indexOf("## Reference:") < packed.stdout.indexOf("Task: M001"))
      assert.ok(packed.stdout.indexOf("Task: M001") < packed.stdout.indexOf("## Task specification"))
      const taskContract = packed.stdout.split("## Task contract")[1].split("## Task specification")[0]
      assert.match(taskContract, /\{"risk":/)
      assert.doesNotMatch(taskContract, /"(?:id|title)":/)
      assert.match(packed.stdout, /## Required phase output\nCall autopilot_contract exactly once, then end\./)
    }
    assert.match(packs.execute, /\.project\/architecture\/overview\.md/)
    assert.doesNotMatch(packs.execute, /\.project\/tooling\.md/)
    assert.match(packs.repair, /\.project\/tooling\.md/)
    assert.doesNotMatch(packs.repair, /\.project\/quality\.md/)
    assert.match(packs.review, /\.project\/quality\.md/)
    assert.doesNotMatch(packs.review, /\.project\/architecture\/overview\.md/)

    const reported = runNode(contextScript, ["--report", "M001", "--json"], target)
    assert.equal(reported.status, 0, reported.stderr)
    const report = JSON.parse(reported.stdout)
    for (const phase of ["execute", "repair", "review"]) {
      assert.equal(report.tasks.M001[phase].static_bytes, Buffer.byteLength(packs[phase], "utf8"))
      assert.ok(report.tasks.M001[phase].projected_max_bytes <= report.cap_bytes)
    }
    assert.equal(report.tasks.M001.review.candidate_and_gates_reserve_bytes, 2560)
    assert.equal(report.tasks.M001.review.diff_reserve_bytes, 3072)

    const library = await import(pathToFileURL(path.join(
      target,
      ".autopilot",
      "bin",
      "lib",
      "context-pack.mjs",
    )).href)
    const extra = {
      candidate: { schema_version: 1, task_id: "M001", status: "complete" },
      gates: [],
      diff: "No application diff.",
    }
    const complete = await library.buildContextPack(target, "M001", { stage: "review", extra })
    assert.ok(complete.bytes <= report.cap_bytes)
    assert.match(complete.text, /\{"candidate":\{"schema_version":1/)
    const repair = await library.buildContextPack(target, "M001", {
      stage: "repair",
      extra: { failure: { code: "EXAMPLE", message: "bounded" } },
    })
    assert.match(repair.text, /\{"failure":\{"code":"EXAMPLE","message":"bounded"\}\}/)
    await assert.rejects(
      library.buildContextPack(target, "M001", {
        stage: "review",
        extra: { ...extra, diff: "x".repeat(3073) },
      }),
      (error) => error?.code === "REVIEW_DIFF_RESERVE_EXCEEDED",
    )
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("renderer accepts a terminal integration task with transitive coverage", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-terminal-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const blueprint = validBlueprint()
    blueprint.tasks[0].gates = ["verify"]
    blueprint.tasks.push(
      {
        ...structuredClone(blueprint.tasks[0]),
        id: "M002",
        title: "Build the dependent integration slice",
        depends_on: ["M001"],
      },
      {
        ...structuredClone(blueprint.tasks[0]),
        id: "M003",
        title: "Run universal terminal integration",
        depends_on: ["M002"],
        gates: ["verify", "final"],
      },
    )
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(blueprint, null, 2)}\n`,
      "utf8",
    )

    const rendered = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(rendered.status, 0, rendered.stderr)
    const queue = JSON.parse(await readFile(path.join(target, ".project", "plan", "queue.json"), "utf8"))
    assert.equal(queue.tasks.M001.status, "ready")
    assert.equal(queue.tasks.M002.status, "pending")
    assert.equal(queue.tasks.M003.status, "pending")
    assert.deepEqual(queue.tasks.M003.depends_on, ["M002"])
    assert.deepEqual(queue.tasks.M003.gates, ["verify", "final"])
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("blueprint validation failures make no generated-file changes", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-invalid-"))
  try {
    const scaffold = scaffoldTarget(target)
    assert.equal(scaffold.status, 0, scaffold.stderr)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    const tracked = [
      path.join(target, ".project", "brief.md"),
      path.join(target, ".project", "plan", "queue.json"),
      path.join(target, ".project", "plan", "milestones", "M001.md"),
      path.join(target, "opencode.jsonc"),
    ]
    const before = await Promise.all(tracked.map((file) => readFile(file, "utf8")))

    const invalidCases = []
    const cycle = validBlueprint()
    cycle.tasks[0].depends_on = ["M002"]
    cycle.tasks.push({ ...structuredClone(cycle.tasks[0]), id: "M002", depends_on: ["M001"] })
    invalidCases.push(cycle)
    const overflow = validBlueprint()
    overflow.constraints.runtime = "x".repeat(9500)
    invalidCases.push(overflow)
    const mismatch = validBlueprint()
    mismatch.credentials.profiles.phase_execute.allowed_gates = ["verify"]
    invalidCases.push(mismatch)
    const collision = validBlueprint()
    collision.tasks.push({ ...structuredClone(collision.tasks[0]), id: "m001" })
    invalidCases.push(collision)
    const reserved = validBlueprint()
    reserved.tasks[0].id = "CON"
    invalidCases.push(reserved)
    const reservedPath = validBlueprint()
    reservedPath.tasks[0].allowed_paths = ["src/CON/**"]
    invalidCases.push(reservedPath)
    const trailingAlias = validBlueprint()
    trailingAlias.context.bundles.product = [".project/brief.md."]
    invalidCases.push(trailingAlias)
    const legacyContext = validBlueprint()
    legacyContext.tasks[0].context = ["product"]
    invalidCases.push(legacyContext)
    const receiptContext = validBlueprint()
    receiptContext.tasks[0].context.execute = [".project/receipts/README.md"]
    invalidCases.push(receiptContext)
    const roleCeilingEscape = validBlueprint()
    roleCeilingEscape.tasks[0].tool_grants.repair = ["remote_docs_lookup"]
    invalidCases.push(roleCeilingEscape)
    const reservedControllerPrefix = validBlueprint()
    reservedControllerPrefix.tools.worker = ["autopilot_escape"]
    reservedControllerPrefix.tasks[0].tool_grants.execute = ["autopilot_escape"]
    invalidCases.push(reservedControllerPrefix)
    const impossibleReviewReserve = validBlueprint()
    impossibleReviewReserve.context.review_reserve = {
      candidate_and_gates_bytes: 6000,
      diff_bytes: 5000,
    }
    invalidCases.push(impossibleReviewReserve)
    const unignoredEphemeral = validBlueprint()
    unignoredEphemeral.tooling.ephemeral.push("tmp/cache")
    invalidCases.push(unignoredEphemeral)
    const protectedEphemeral = validBlueprint()
    protectedEphemeral.tooling.gitignore.push(".autopilot/runtime/")
    protectedEphemeral.tooling.ephemeral.push(".autopilot/runtime")
    invalidCases.push(protectedEphemeral)
    const writableEphemeral = validBlueprint()
    writableEphemeral.tasks[0].allowed_paths.push("coverage/**")
    invalidCases.push(writableEphemeral)
    const legacySchema = validBlueprint()
    legacySchema.schema_version = 2
    delete legacySchema.opencode
    delete legacySchema.budgets
    delete legacySchema.git
    invalidCases.push(legacySchema)
    const unsafeModel = validBlueprint()
    unsafeModel.opencode.model = "missing-provider-separator"
    invalidCases.push(unsafeModel)
    const forbiddenProviderEnvironment = validBlueprint()
    forbiddenProviderEnvironment.opencode.provider_environment = ["PATH"]
    invalidCases.push(forbiddenProviderEnvironment)
    const duplicateProviderEnvironment = validBlueprint()
    duplicateProviderEnvironment.opencode.provider_environment = ["PROVIDER_TOKEN", "provider_token"]
    invalidCases.push(duplicateProviderEnvironment)
    const duplicateCredentialAllow = validBlueprint()
    duplicateCredentialAllow.credentials.profiles.phase_execute.allow.push("mcp_token")
    invalidCases.push(duplicateCredentialAllow)
    const duplicateCredentialProfile = validBlueprint()
    duplicateCredentialProfile.credentials.profiles.PHASE_EXECUTE = structuredClone(
      duplicateCredentialProfile.credentials.profiles.phase_execute,
    )
    invalidCases.push(duplicateCredentialProfile)
    const excessivePhaseTimeout = validBlueprint()
    excessivePhaseTimeout.opencode.timeout_seconds = 7201
    invalidCases.push(excessivePhaseTimeout)
    const excessivePhaseOutput = validBlueprint()
    excessivePhaseOutput.opencode.max_output_bytes = 4194305
    invalidCases.push(excessivePhaseOutput)
    const excessiveRunBudget = validBlueprint()
    excessiveRunBudget.budgets.max_tasks_per_run = 101
    invalidCases.push(excessiveRunBudget)
    const multilineCommitPrefix = validBlueprint()
    multilineCommitPrefix.git.commit_prefix = "autopilot\nunsafe"
    invalidCases.push(multilineCommitPrefix)
    const unsafeControllerOverride = validBlueprint()
    unsafeControllerOverride.opencode.attach_url = "http://localhost:4096"
    invalidCases.push(unsafeControllerOverride)
    const uncoveredTask = validBlueprint()
    uncoveredTask.tasks.push({
      ...structuredClone(uncoveredTask.tasks[0]),
      id: "M002",
      title: "Build an independent second slice",
      gates: ["verify"],
    })
    invalidCases.push(uncoveredTask)
    const distributedFinalGates = validBlueprint()
    distributedFinalGates.final_gates = ["verify", "final"]
    distributedFinalGates.tasks[0].gates = ["verify"]
    distributedFinalGates.tasks.push({
      ...structuredClone(distributedFinalGates.tasks[0]),
      id: "M002",
      title: "Run the terminal integration checks",
      depends_on: ["M001"],
      gates: ["final"],
    })
    invalidCases.push(distributedFinalGates)

    for (const blueprint of invalidCases) {
      await writeFile(blueprintFile, `${JSON.stringify(blueprint, null, 2)}\n`, "utf8")
      const rejected = runNode(rendererScript, ["--target", target, "--json"], target)
      assert.notEqual(rejected.status, 0, rejected.stdout)
      if (blueprint === legacySchema) {
        assert.match(rejected.stderr, /schema_version must be 5; older schemas do not contain versioned evolution metadata/)
      }
      const after = await Promise.all(tracked.map((file) => readFile(file, "utf8")))
      assert.deepEqual(after, before)
      assert.equal((await readdir(path.dirname(blueprintFile))).includes("render-manifest.json"), false)
    }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("renderer refuses modified generated outputs and preserves user-owned milestones", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-ownership-"))
  const unrendered = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-user-file-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    const blueprint = validBlueprint()
    await writeFile(blueprintFile, `${JSON.stringify(blueprint, null, 2)}\n`, "utf8")
    assert.equal(runNode(rendererScript, ["--target", target, "--json"], target).status, 0)
    const briefFile = path.join(target, ".project", "brief.md")
    await writeFile(briefFile, "user-authored brief\n", "utf8")
    blueprint.product.outcome = "A changed outcome that would otherwise rerender the brief."
    await writeFile(blueprintFile, `${JSON.stringify(blueprint, null, 2)}\n`, "utf8")
    const drifted = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.notEqual(drifted.status, 0)
    assert.match(drifted.stderr, /drifted|modified/i)
    assert.equal(await readFile(briefFile, "utf8"), "user-authored brief\n")

    assert.equal(scaffoldTarget(unrendered).status, 0)
    const unrenderedBlueprint = path.join(unrendered, ".autopilot", "init", "blueprint.json")
    await writeFile(unrenderedBlueprint, `${JSON.stringify(validBlueprint(), null, 2)}\n`, "utf8")
    const unrenderedBrief = path.join(unrendered, ".project", "brief.md")
    const initialBrief = await readFile(unrenderedBrief, "utf8")
    await writeFile(unrenderedBrief, "pre-render user edit\n", "utf8")
    const preRenderEdit = runNode(rendererScript, ["--target", unrendered, "--json"], unrendered)
    assert.notEqual(preRenderEdit.status, 0)
    assert.match(preRenderEdit.stderr, /modified before its first render/i)
    assert.equal(await readFile(unrenderedBrief, "utf8"), "pre-render user edit\n")
    await writeFile(unrenderedBrief, initialBrief, "utf8")
    const userMilestone = path.join(unrendered, ".project", "plan", "milestones", "M777.md")
    await writeFile(userMilestone, "# User-owned milestone\n", "utf8")
    const refused = runNode(rendererScript, ["--target", unrendered, "--json"], unrendered)
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /user-owned milestone/)
    assert.equal(await readFile(userMilestone, "utf8"), "# User-owned milestone\n")
    assert.equal(await readFile(unrenderedBrief, "utf8"), initialBrief)
    assert.equal((await readdir(path.dirname(unrenderedBlueprint))).includes("render-manifest.json"), false)
  } finally {
    await rm(target, { recursive: true, force: true })
    await rm(unrendered, { recursive: true, force: true })
  }
})

test("an interrupted multi-file render resumes from its applying manifest", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-resume-"))
  const reference = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-resume-reference-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    assert.equal(scaffoldTarget(reference).status, 0)
    const original = validBlueprint()
    const updated = validBlueprint()
    updated.product.outcome = "Deliver the resumed target render without mixed generated state."
    for (const [directory, blueprint] of [[target, original], [reference, updated]]) {
      await writeFile(
        path.join(directory, ".autopilot", "init", "blueprint.json"),
        `${JSON.stringify(blueprint, null, 2)}\n`,
        "utf8",
      )
      assert.equal(runNode(rendererScript, ["--target", directory, "--json"], directory).status, 0)
    }

    const originalManifest = JSON.parse(
      await readFile(path.join(target, "blueprints", "current", "render-manifest.json"), "utf8"),
    )
    const targetManifest = JSON.parse(
      await readFile(path.join(reference, "blueprints", "current", "render-manifest.json"), "utf8"),
    )
    const applying = {
      schema_version: 1,
      status: "applying",
      blueprint_sha256: targetManifest.blueprint_sha256,
      previous_outputs: originalManifest.outputs,
      outputs: targetManifest.outputs,
    }
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8",
    )
    await writeFile(
      path.join(target, "blueprints", "current", "render-manifest.json"),
      `${JSON.stringify(applying, null, 2)}\n`,
      "utf8",
    )
    await writeFile(
      path.join(target, ".project", "brief.md"),
      await readFile(path.join(reference, ".project", "brief.md"), "utf8"),
      "utf8",
    )

    const resumed = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(resumed.status, 0, resumed.stderr)
    const completed = JSON.parse(
      await readFile(path.join(target, "blueprints", "current", "render-manifest.json"), "utf8"),
    )
    assert.equal(completed.status, "complete")
    assert.deepEqual(completed.outputs, targetManifest.outputs)
    assert.equal(
      await readFile(path.join(target, ".project", "brief.md"), "utf8"),
      await readFile(path.join(reference, ".project", "brief.md"), "utf8"),
    )
  } finally {
    await rm(target, { recursive: true, force: true })
    await rm(reference, { recursive: true, force: true })
  }
})

test("renderer rejects hardlinked outputs before writing", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-hardlink-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    await writeFile(blueprintFile, `${JSON.stringify(validBlueprint(), null, 2)}\n`, "utf8")
    const brief = path.join(target, ".project", "brief.md")
    const linked = path.join(target, "linked-brief.md")
    await writeFile(linked, await readFile(brief, "utf8"), "utf8")
    await rm(brief)
    await link(linked, brief)
    const rejected = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /private regular file/)
    assert.equal((await readdir(path.dirname(blueprintFile))).includes("render-manifest.json"), false)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("renderer rejects symlink or junction output parents before writing", async (context) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-blueprint-link-parent-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const blueprintFile = path.join(target, ".autopilot", "init", "blueprint.json")
    await writeFile(blueprintFile, `${JSON.stringify(validBlueprint(), null, 2)}\n`, "utf8")
    const architecture = path.join(target, ".project", "architecture")
    const linkTarget = path.join(target, "linked-architecture")
    await rm(architecture, { recursive: true, force: true })
    await mkdir(linkTarget)
    try {
      await symlink(linkTarget, architecture, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`links are unavailable on this platform: ${error.code}`)
        return
      }
      throw error
    }
    const rejected = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /symbolic link|junction/)
    assert.equal((await readdir(path.dirname(blueprintFile))).includes("render-manifest.json"), false)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("strict validation rejects a later Git ignore negation", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-ignore-drift-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    const rendered = runNode(rendererScript, ["--target", target, "--json"], target)
    assert.equal(rendered.status, 0, rendered.stderr)
    const configured = runNode(
      path.join(target, ".autopilot", "bin", "configure-tools.mjs"),
      ["--root", target, "--json"],
      target,
    )
    assert.equal(configured.status, 0, configured.stderr)
    assert.equal(spawnSync("git", ["init"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
    await writeFile(path.join(target, ".env.production"), "TOKEN=prebaseline-only\n", "utf8")
    const ignoreFile = path.join(target, ".gitignore")
    const canonicalIgnore = await readFile(ignoreFile, "utf8")
    await writeFile(ignoreFile, `${canonicalIgnore}\n!.env.production\n`, "utf8")

    const validation = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.notEqual(validation.status, 0)
    const report = JSON.parse(validation.stdout)
    assert.ok(report.issues.some(
      (issue) => issue.location === ".gitignore" && /not effectively ignored: .*\.env\.production/i.test(issue.message),
    ), validation.stdout)

    await writeFile(ignoreFile, canonicalIgnore.replace(".autopilot/blocker.md\n", ""), "utf8")
    const canonicalDrift = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.notEqual(canonicalDrift.status, 0)
    assert.ok(JSON.parse(canonicalDrift.stdout).issues.some(
      (issue) => issue.location === ".gitignore" && /canonical.*missing|has drifted/i.test(issue.message),
    ), canonicalDrift.stdout)
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("strict validation rejects control characters in root environment filenames", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows filenames cannot contain the control-character probe")
    return
  }
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-env-control-name-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(path.join(target, ".env.bad\nname"), "TOKEN=prebaseline-only\n", "utf8")
    const validation = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.notEqual(validation.status, 0)
    const report = JSON.parse(validation.stdout)
    assert.ok(report.issues.some(
      (issue) => issue.location === ".gitignore" && /control characters/i.test(issue.message),
    ), validation.stdout)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("strict validation rejects a future credential negation after the canonical ignore block", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-future-env-negation-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    const ignoreFile = path.join(target, ".gitignore")
    await writeFile(
      ignoreFile,
      `${await readFile(ignoreFile, "utf8")}\n!.env.staging.local\n`,
      "utf8",
    )
    const validation = runNode(
      path.join(target, ".autopilot", "bin", "validate.mjs"),
      ["--strict", "--skip-git", "--json"],
      target,
    )
    assert.notEqual(validation.status, 0)
    const report = JSON.parse(validation.stdout)
    assert.ok(report.issues.some(
      (issue) => issue.location === ".gitignore" && /must be the final ignore block/i.test(issue.message),
    ), validation.stdout)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("finalizer keeps a pre-provisioned local test environment out of the baseline", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-preprovisioned-env-"))
  try {
    await writeFile(path.join(target, ".gitignore"), "# opencode-autopilot\n", "utf8")
    const scaffold = runNode(scaffoldScript, ["--target", target, "--json"], root)
    assert.equal(scaffold.status, 0, scaffold.stderr)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    const localEnvironment = path.join(target, ".env.test.local")
    await writeFile(localEnvironment, "TOKEN=prebaseline-only\n", "utf8")
    for (const [key, value] of [["user.name", "Autopilot Test"], ["user.email", "autopilot@example.invalid"]]) {
      assert.equal(spawnSync("git", ["config", key, value], {
        cwd: target,
        encoding: "utf8",
        windowsHide: true,
      }).status, 0)
    }

    const finalized = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.equal(finalized.status, 0, finalized.stderr)
    assert.equal(await readFile(localEnvironment, "utf8"), "TOKEN=prebaseline-only\n")
    assert.equal(spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".env.test.local"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), "")
    assert.equal(spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".autopilot/credentials.json"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), "")
    assert.equal(spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), "")
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("finalizer recovers from Git identity failure, commits, cleans init inputs, and reruns", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-finalize-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    assert.equal(spawnSync("git", ["init"], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)
    const identitySecret = "FINALIZER_DIAGNOSTIC_SECRET_123456789"
    assert.equal(spawnSync("git", ["config", "user.name", ""], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)
    assert.equal(spawnSync("git", ["config", "user.email", `token=${identitySecret}`], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)

    const identityFailure = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.notEqual(identityFailure.status, 0)
    assert.match(identityFailure.stderr, /Git identity|empty ident|Author identity/i)
    assert.doesNotMatch(identityFailure.stderr, new RegExp(identitySecret))
    assert.match(identityFailure.stderr, /token=\[REDACTED\]/i)
    assert.ok(Buffer.byteLength(identityFailure.stderr, "utf8") <= 16 * 1024)
    assert.equal(
      JSON.parse(await readFile(path.join(target, "blueprints", "current", "render-manifest.json"), "utf8")).status,
      "complete",
    )

    assert.equal(spawnSync("git", ["config", "user.name", "Autopilot Test"], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)
    assert.equal(spawnSync("git", ["config", "user.email", "autopilot@example.invalid"], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)
    const hostileHooks = path.join(target, ".git", "hostile-hooks")
    const hookMarker = path.join(target, ".git", "hook-ran")
    const preCommit = path.join(hostileHooks, "pre-commit")
    await mkdir(hostileHooks)
    await writeFile(preCommit, `#!/bin/sh\nprintf invoked > "${hookMarker.replaceAll("\\", "/")}"\nexit 1\n`, "utf8")
    await chmod(preCommit, 0o755)
    for (const [key, value] of [
      ["core.hooksPath", hostileHooks],
      ["commit.gpgSign", "true"],
      ["gpg.program", path.join(target, "missing-gpg-program")],
    ]) {
      assert.equal(spawnSync("git", ["config", key, value], {
        cwd: target,
        encoding: "utf8",
        windowsHide: true,
      }).status, 0)
    }
    const finalized = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.equal(finalized.status, 0, finalized.stderr)
    const output = JSON.parse(finalized.stdout)
    assert.equal(output.blueprint_rendered, true)
    assert.equal(output.blueprint_cleaned, true)
    assert.ok(output.baseline_commit)
    await assert.rejects(access(hookMarker), /ENOENT/)
    assert.equal(spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), "autopilot: initialize project blueprint")
    await assert.rejects(readdir(path.join(target, ".autopilot", "init")), { code: "ENOENT" })
    assert.equal(spawnSync("git", ["status", "--porcelain=v1"], { cwd: target, encoding: "utf8" }).stdout.trim(), "")

    const rerun = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.equal(JSON.parse(rerun.stdout).blueprint_rendered, false)
    assert.equal(JSON.parse(rerun.stdout).verification_only, true)

    const commitsBefore = spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim()
    const laterWork = path.join(target, "later-work.txt")
    await writeFile(laterWork, "must not be committed by init finalization\n", "utf8")
    const dirtyRerun = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.notEqual(dirtyRerun.status, 0)
    assert.match(dirtyRerun.stderr, /Refusing to finalize without a blueprint or commit later work/)
    assert.equal(await readFile(laterWork, "utf8"), "must not be committed by init finalization\n")
    assert.equal(spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(), commitsBefore)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("finalizer rejects a nested Git worktree target before rendering", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autopilot-finalize-parent-"))
  const target = path.join(parent, "nested")
  try {
    await mkdir(target)
    assert.equal(spawnSync("git", ["init"], { cwd: parent, encoding: "utf8", windowsHide: true }).status, 0)
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    const brief = path.join(target, ".project", "brief.md")
    const before = await readFile(brief, "utf8")
    const rejected = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /own Git worktree root|Git resolves/)
    assert.equal(await readFile(brief, "utf8"), before)
    assert.equal((await readdir(path.join(target, ".autopilot", "init"))).includes("render-manifest.json"), false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("finalizer rejects repository-local clean filters before rendering or staging", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-finalize-filter-"))
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    assert.equal(spawnSync("git", ["init"], { cwd: target, encoding: "utf8", windowsHide: true }).status, 0)
    assert.equal(spawnSync(
      "git",
      ["config", "filter.hostile.clean", "definitely-not-a-real-clean-filter"],
      { cwd: target, encoding: "utf8", windowsHide: true },
    ).status, 0)
    const brief = path.join(target, ".project", "brief.md")
    const before = await readFile(brief, "utf8")

    const rejected = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /repository-local Git filters|diff drivers|exact project finalization/i)
    assert.equal(await readFile(brief, "utf8"), before)
    assert.equal((await readdir(path.join(target, ".autopilot", "init"))).includes("render-manifest.json"), false)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("single initialization closeout returns only failed provisioning checks when OpenCode is unavailable", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "autopilot-closeout-"))
  let detachedProbePid = null
  try {
    assert.equal(scaffoldTarget(target).status, 0)
    await writeFile(
      path.join(target, ".autopilot", "init", "blueprint.json"),
      `${JSON.stringify(validBlueprint(), null, 2)}\n`,
      "utf8",
    )
    assert.equal(spawnSync("git", ["init"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
    for (const [key, value] of [["user.name", "Autopilot Test"], ["user.email", "autopilot@example.invalid"]]) {
      assert.equal(spawnSync("git", ["config", key, value], {
        cwd: target,
        encoding: "utf8",
        windowsHide: true,
      }).status, 0)
    }
    const finalized = runNode(finalizerScript, ["--target", target, "--json"], target)
    assert.equal(finalized.status, 0, finalized.stderr)

    const configFile = path.join(target, ".autopilot", "config.json")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    config.opencode.command = [path.join(target, "missing-opencode-executable")]
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    assert.equal(spawnSync("git", ["add", ".autopilot/config.json"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
    assert.equal(spawnSync("git", ["commit", "-m", "test: unavailable OpenCode"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)

    const closeout = runNode(closeoutScript, ["--target", target, "--json"], target)
    assert.equal(closeout.status, 0, closeout.stderr)
    const output = JSON.parse(closeout.stdout)
    assert.equal(output.ready, false)
    assert.equal(output.started, null)
    assert.ok(output.provisioning.some((item) => item.kind === "opencode"))
    assert.equal(Object.hasOwn(output, "preflight"), false)
    assert.equal(Object.hasOwn(output, "context_report"), false)

    const controllerFile = path.join(target, ".autopilot", "bin", "autopilot.mjs")
    await writeFile(controllerFile, `#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
const verb = process.argv[2]
const runtime = path.join(process.cwd(), ".autopilot", "runtime")
await mkdir(runtime, { recursive: true })
await writeFile(path.join(runtime, \`closeout-\${verb}-environment.json\`), JSON.stringify({
  provider_region: process.env.PROVIDER_REGION ?? null,
  provider_token: process.env.PROVIDER_TOKEN ?? null,
  auth_content: process.env.OPENCODE_AUTH_CONTENT ?? null,
  xdg_data_home: process.env.XDG_DATA_HOME ?? null,
  path_available: Boolean(process.env.PATH ?? process.env.Path),
  unrelated_absent: process.env.CLOSEOUT_UNRELATED_SECRET === undefined,
  node_options_absent: process.env.NODE_OPTIONS === undefined,
  opencode_config_absent: process.env.OPENCODE_CONFIG_CONTENT === undefined,
  source_data_pointer_absent: process.env.AUTOPILOT_SOURCE_DATA_HOME === undefined,
}) + "\\n", "utf8")
if (verb === "preflight") process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
else if (verb === "start") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    cwd: process.env.TEMP ?? process.env.TMPDIR ?? process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  })
  child.unref()
  const nestedAuth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT).test.key
  const encoded = [
    process.env.PROVIDER_TOKEN,
    nestedAuth,
    process.env.OPENCODE_AUTH_CONTENT,
    encodeURIComponent(nestedAuth),
    Buffer.from(nestedAuth, "utf8").toString("base64"),
    Buffer.from(nestedAuth, "utf8").toString("hex"),
  ]
  process.stdout.write(JSON.stringify({ pid: child.pid, log: \`leak-\${encoded.join("|")}\` }) + "\\n")
}
else { process.stderr.write("unexpected closeout verb\\n"); process.exitCode = 2 }
`, "utf8")
    const ownershipFile = path.join(target, ".autopilot", "control-plane.json")
    const ownership = JSON.parse(await readFile(ownershipFile, "utf8"))
    ownership.managed_files[".autopilot/bin/autopilot.mjs"].sha256 = createHash("sha256")
      .update(await readFile(controllerFile))
      .digest("hex")
    await writeFile(ownershipFile, `${JSON.stringify(ownership, null, 2)}\n`, "utf8")
    assert.equal(spawnSync("git", ["add", ".autopilot/bin/autopilot.mjs", ".autopilot/control-plane.json"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)
    assert.equal(spawnSync("git", ["commit", "-m", "test: capture closeout child environment"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
    }).status, 0)

    const providerRegion = "closeout-provider-region-7391"
    const providerToken = "closeout-provider-\"token\"\\4826"
    const nestedAuthSecret = "closeout-auth-\"quoted\"\\path-1953"
    const authContent = JSON.stringify({ test: { key: nestedAuthSecret } })
    const xdgDataHome = path.join(target, "custom-opencode-data")
    const readyCloseout = runNode(closeoutScript, ["--target", target, "--json"], target, {
      env: {
        ...process.env,
        PROVIDER_REGION: providerRegion,
        PROVIDER_TOKEN: providerToken,
        OPENCODE_AUTH_CONTENT: authContent,
        XDG_DATA_HOME: xdgDataHome,
        CLOSEOUT_UNRELATED_SECRET: "must-not-reach-child-6384",
        NODE_OPTIONS: "--no-warnings",
        OPENCODE_CONFIG_CONTENT: "must-not-reach-child",
        AUTOPILOT_SOURCE_DATA_HOME: path.join(target, "must-not-reach-child"),
      },
      timeout: 120_000,
    })
    assert.equal(readyCloseout.status, 0, readyCloseout.stderr)
    const readyOutput = JSON.parse(readyCloseout.stdout)
    assert.equal(readyOutput.ready, true)
    detachedProbePid = readyOutput.started.pid
    assert.equal(
      readyOutput.started.log,
      "leak-[REDACTED]|[REDACTED]|[REDACTED]|[REDACTED]|[REDACTED]|[REDACTED]",
    )
    assert.doesNotThrow(() => process.kill(detachedProbePid, 0))
    for (const verb of ["preflight", "start"]) {
      const report = JSON.parse(await readFile(
        path.join(target, ".autopilot", "runtime", `closeout-${verb}-environment.json`),
        "utf8",
      ))
      assert.equal(report.provider_region, providerRegion)
      assert.equal(report.provider_token, providerToken)
      assert.equal(report.auth_content, authContent)
      assert.equal(report.xdg_data_home, xdgDataHome)
      assert.equal(report.path_available, true)
      assert.equal(report.unrelated_absent, true)
      assert.equal(report.node_options_absent, true)
      assert.equal(report.opencode_config_absent, true)
      assert.equal(report.source_data_pointer_absent, true)
    }
    const encodedSecrets = [
      JSON.stringify(providerToken).slice(1, -1),
      JSON.stringify(nestedAuthSecret).slice(1, -1),
      encodeURIComponent(nestedAuthSecret),
      Buffer.from(nestedAuthSecret, "utf8").toString("base64"),
      Buffer.from(nestedAuthSecret, "utf8").toString("hex"),
    ]
    for (const secret of [providerRegion, providerToken, nestedAuthSecret, authContent, ...encodedSecrets, "must-not-reach-child-6384"]) {
      assert.doesNotMatch(`${readyCloseout.stdout}\n${readyCloseout.stderr}`, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }

    const preflightReportBeforeCap = await readFile(
      path.join(target, ".autopilot", "runtime", "closeout-preflight-environment.json"),
      "utf8",
    )
    const oversizedProvider = runNode(closeoutScript, ["--target", target, "--json"], target, {
      env: {
        ...process.env,
        PROVIDER_REGION: providerRegion,
        PROVIDER_TOKEN: "x".repeat(8 * 1024 + 1),
        OPENCODE_AUTH_CONTENT: authContent,
        XDG_DATA_HOME: xdgDataHome,
      },
      timeout: 120_000,
    })
    assert.notEqual(oversizedProvider.status, 0)
    assert.match(oversizedProvider.stderr, /PROVIDER_TOKEN exceeds 8192 bytes/)
    assert.equal(
      await readFile(path.join(target, ".autopilot", "runtime", "closeout-preflight-environment.json"), "utf8"),
      preflightReportBeforeCap,
    )

    const oversizedAggregate = runNode(closeoutScript, ["--target", target, "--json"], target, {
      env: {
        ...process.env,
        PROVIDER_REGION: "r".repeat(8180),
        PROVIDER_TOKEN: "t".repeat(8180),
        OPENCODE_AUTH_CONTENT: authContent,
        XDG_DATA_HOME: xdgDataHome,
      },
      timeout: 120_000,
    })
    assert.notEqual(oversizedAggregate.status, 0)
    assert.match(oversizedAggregate.stderr, /provider environment exceeds the 16384-byte aggregate cap/)
    assert.equal(
      await readFile(path.join(target, ".autopilot", "runtime", "closeout-preflight-environment.json"), "utf8"),
      preflightReportBeforeCap,
    )
  } finally {
    if (Number.isInteger(detachedProbePid)) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(detachedProbePid), "/T", "/F"], {
          encoding: "utf8",
          windowsHide: true,
        })
      } else {
        try { process.kill(detachedProbePid, "SIGTERM") } catch {}
      }
    }
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
