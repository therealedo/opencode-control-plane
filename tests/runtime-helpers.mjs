import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(testsRoot, "..")
export const scaffoldScript = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "init-project",
  "bin",
  "scaffold.mjs",
)
export const fakeOpenCodeScript = path.join(testsRoot, "fixtures", "fake-opencode.mjs")
export const fixedGateScript = path.join(testsRoot, "fixtures", "fixed-gate.mjs")

export async function createScaffold(t, { ready = false, mode = "success" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-autopilot-runtime-"))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const result = await run([process.execPath, scaffoldScript, "--target", root, "--json"], {
    cwd: repositoryRoot,
  })
  if (result.code !== 0) {
    throw new Error(`Scaffold failed:\n${result.stderr || result.stdout}`)
  }
  if (ready) await makeReady(root, mode)
  return root
}

export async function makeReady(root, mode = "success") {
  await replaceStarterTokens(root)

  await writeJson(path.join(root, ".project", "manifest.json"), {
    schema_version: 2,
    max_context_bytes: 16384,
    review_reserve: {
      candidate_and_gates_bytes: 3072,
      diff_bytes: 3072,
    },
    bundles: {
      task: [".project/brief.md"],
    },
  })
  await writeFile(
    path.join(root, ".project", "plan", "milestones", "M001.md"),
    [
      "# M001 — Runtime acceptance fixture",
      "",
      "## Outcome",
      "",
      "Create `src/result.txt` containing `GOOD`.",
      "",
      "## Acceptance criteria",
      "",
      "- The fixed task gate validates the exact file content.",
      "- An independent fresh review approves the evidence.",
      "- The deterministic final gate observes the complete application result.",
      "",
      "## Non-goals",
      "",
      "- No external side effects.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeJson(path.join(root, ".project", "plan", "queue.json"), {
    schema_version: 2,
    revision: 0,
    project_status: "ready",
    tasks: {
      M001: {
        title: "Prove the autonomous runtime",
        status: "ready",
        priority: 100,
        depends_on: [],
        spec: ".project/plan/milestones/M001.md",
        context: {
          shared: ["task"],
          execute: [],
          repair: [],
          review: [],
        },
        allowed_paths: ["src/**"],
        gates: ["task", "final"],
        tool_grants: { execute: [], repair: [], review: [] },
        risk: "low",
        attempt_limit: 3,
      },
    },
  })
  await writeJson(path.join(root, ".project", "gates.json"), {
    schema_version: 2,
    gates: {
      task: {
        argv: [process.execPath, fixedGateScript, "expect-file", "src/result.txt", "GOOD"],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: true,
      },
      final: {
        argv: [
          process.execPath,
          fixedGateScript,
          "finalize",
          "src/result.txt",
        ],
        timeout_seconds: 30,
        credential_profile: null,
        success_codes: [0],
        max_output_bytes: 8192,
        feedback: false,
      },
    },
    final_gates: ["final"],
  })

  const configFile = path.join(root, ".autopilot", "config.json")
  const config = await readJson(configFile)
  config.opencode = {
    command: [process.execPath, fakeOpenCodeScript],
    agents: {
      execute: "autopilot-worker",
      repair: "autopilot-recovery",
      review: "autopilot-reviewer",
    },
    auto_approve: true,
    attach_url: null,
    model: "test-provider/test-model",
    provider_auth_mode: "none",
    provider_environment: [],
    timeout_seconds: 30,
    max_output_bytes: 1024 * 1024,
  }
  config.budgets = {
    max_tasks_per_run: 5,
    max_attempts_per_task: 3,
    max_elapsed_minutes: 5,
    max_no_progress: 2,
  }
  config.context.max_bytes = 16384
  await writeJson(configFile, config)

  await mkdir(path.join(root, ".autopilot", "runtime"), { recursive: true })
  await writeJson(path.join(root, ".autopilot", "runtime", "fake-config.json"), { mode })

  await git(root, ["config", "user.name", "Autopilot Test"])
  await git(root, ["config", "user.email", "autopilot-test@example.invalid"])
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-m", "test: ready autonomous project"])
}

export async function replaceStarterTokens(root) {
  for (const file of await filesUnder(root)) {
    if (!/\.(?:md|json|jsonc|txt|example)$/i.test(file) && !path.basename(file).startsWith(".env")) continue
    const current = await readFile(file, "utf8")
    const replaced = current
      .replace(/\{\{[^{}\r\n]+\}\}/g, "completed test value")
      .replace(/^Status: initializing\.[^\r\n]*$/gm, "Status: ready.")
    if (replaced !== current) await writeFile(file, replaced, "utf8")
  }
}

export async function filesUnder(root) {
  const output = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const location = path.join(root, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(location)))
    else if (entry.isFile()) output.push(location)
  }
  return output
}

export async function run(argv, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}

export async function git(root, arguments_) {
  const result = await run(["git", ...arguments_], { cwd: root })
  if (result.code !== 0) throw new Error(`git ${arguments_[0]} failed:\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
