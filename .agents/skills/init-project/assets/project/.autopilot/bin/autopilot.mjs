#!/usr/bin/env node
import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  atomicWriteFile,
  assertPrivateFile,
  AutopilotError,
  exists,
  findProjectRoot,
  nowIso,
} from "./lib/core.mjs";
import { assertNoIssues, validateConfig } from "./lib/contracts.mjs";
import { Controller } from "./lib/controller.mjs";
import { credentialEnvironmentForScope } from "./lib/gate-runner.mjs";
import {
  assertCleanStart,
  assertGitRepository,
  assertHeadAndIndex,
  gitHead,
} from "./lib/git.mjs";
import {
  preflightFreshOpenCode,
  preflightOpenCodeCommand,
} from "./lib/opencode-isolated.mjs";
import {
  assertControlTopology,
  loadContracts,
  loadProject,
  preflightProjectRoot,
} from "./lib/project.mjs";
import { safeBaseEnv } from "./lib/process.mjs";
import { loadState } from "./lib/state.mjs";
import { validateProject } from "./lib/validator.mjs";
import { boundedProviderEnvironment } from "./lib/mcp.mjs";

const scriptFile = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--detach") options.detach = true;
    else if (value === "--foreground") options.foreground = true;
    else if (value === "--json") options.json = true;
    else if (value === "--root") options.root = argv[++index];
    else options._.push(value);
  }
  return options;
}

async function rootFrom(options) {
  return findProjectRoot(options.root ? path.resolve(options.root) : process.cwd());
}

async function liveLock(project) {
  if (!(await exists(project.paths.lock))) return null;
  try {
    const lock = JSON.parse(await readFile(project.paths.lock, "utf8"));
    process.kill(lock.pid, 0);
    return lock;
  } catch (error) {
    if (error?.code === "EPERM") return { pid: "unknown" };
    return null;
  }
}

function detachedControllerEnvironment(project, source = process.env) {
  assertNoIssues(validateConfig(project.config), "Detached controller config");
  const environment = safeBaseEnv(source);
  try {
    Object.assign(environment, boundedProviderEnvironment(
      project.config.opencode?.provider_environment ?? [],
      source,
    ));
  } catch (error) {
    throw new AutopilotError(error.message, { code: error.code ?? "CREDENTIAL_FILE_UNSAFE" });
  }
  if (typeof source.OPENCODE_AUTH_CONTENT === "string" && source.OPENCODE_AUTH_CONTENT) {
    if (Buffer.byteLength(source.OPENCODE_AUTH_CONTENT, "utf8") > 1024 * 1024) {
      throw new AutopilotError("OPENCODE_AUTH_CONTENT exceeds 1048576 bytes", {
        code: "CREDENTIAL_VALUE_TOO_LARGE",
      });
    }
    try { JSON.parse(source.OPENCODE_AUTH_CONTENT); }
    catch {
      throw new AutopilotError("OPENCODE_AUTH_CONTENT is invalid JSON", {
        code: "CREDENTIAL_FILE_UNSAFE",
      });
    }
    environment.OPENCODE_AUTH_CONTENT = source.OPENCODE_AUTH_CONTENT;
  }
  if (typeof source.XDG_DATA_HOME === "string" && source.XDG_DATA_HOME) {
    if (!path.isAbsolute(source.XDG_DATA_HOME) || source.XDG_DATA_HOME.includes("\0")) {
      throw new AutopilotError("XDG_DATA_HOME must be an absolute path for detached auth discovery", {
        code: "CREDENTIAL_FILE_UNSAFE",
      });
    }
    // This controller-only pointer preserves the exact auth source selected by
    // foreground preflight. safeBaseEnv deliberately keeps it out of phase,
    // gate, and MCP child environments.
    environment.AUTOPILOT_SOURCE_DATA_HOME = path.resolve(source.XDG_DATA_HOME);
  }
  return environment;
}

async function detach(root, verb = "start") {
  const project = await loadProject(root);
  await assertControlTopology(project, { createMutable: true });
  const active = await liveLock(project);
  if (active) throw new AutopilotError(`Controller is already running with PID ${active.pid}`, { code: "LOCKED" });
  const controllerEnvironment = detachedControllerEnvironment(project);
  const logFile = path.join(project.paths.artifacts, "controller.log");
  const logHandle = await openPrivateLog(root, logFile);
  let child;
  try {
    child = spawn(process.execPath, [scriptFile, verb, "--foreground", "--root", root], {
      cwd: root,
      env: controllerEnvironment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  child.unref();
  return { pid: child.pid, log: path.relative(root, logFile).replaceAll("\\", "/") };
}

async function openPrivateLog(root, file) {
  let previous = null;
  try {
    previous = await assertPrivateFile(root, file, "controller log");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(file, previous ? "r+" : "wx", 0o600);
  try {
    const current = await handle.stat();
    const sameIdentity = !previous || (
      String(current.ino) === previous.ino && (
        process.platform === "win32" || String(current.dev) === previous.dev
      )
    );
    if (
      !current.isFile() ||
      Number(current.nlink) > 1 ||
      !sameIdentity
    ) throw new AutopilotError("Controller log identity changed during secure open", { code: "CONTROL_FILE_UNSAFE" });
    await handle.truncate(0);
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function status(root) {
  const project = await loadProject(root);
  await assertControlTopology(project, { createMutable: true });
  const state = await loadState(project);
  let queue = null;
  try {
    queue = JSON.parse(await readFile(project.paths.queue, "utf8"));
  } catch {}
  const counts = {};
  for (const task of Object.values(queue?.tasks ?? {})) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    ...state,
    controller_lock: await liveLock(project),
    pause_requested: await exists(project.paths.paused),
    stop_requested: await exists(project.paths.stop),
    maintenance_requested: await exists(project.paths.maintenance),
    project_status: queue?.project_status ?? null,
    task_counts: counts,
    total_tasks: Object.keys(queue?.tasks ?? {}).length,
    remaining_tasks: Object.values(queue?.tasks ?? {}).filter((task) => task.status !== "done").length,
    active_task_title: state.active_task ? queue?.tasks?.[state.active_task]?.title ?? null : null,
    active_task_attempt_limit: state.active_task ? queue?.tasks?.[state.active_task]?.attempt_limit ?? null : null,
    controller_log: path.relative(root, path.join(project.paths.artifacts, "controller.log")).replaceAll("\\", "/"),
  };
}

function preflightError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function lifecyclePreflight(root) {
  const validation = await validateProject(root, { strict: true, checkGit: true });
  const report = {
    schema_version: 1,
    ready: false,
    zero_model: true,
    validation: {
      ok: validation.ok,
      issues: validation.issues,
    },
    git: { ok: false },
    opencode: { ok: false },
    provider_environment: [],
    phases: [],
    gates: [],
  };

  let project;
  let contracts;
  try {
    project = await loadProject(root);
    contracts = await loadContracts(project);
  } catch (error) {
    report.structure = { ok: false, error: preflightError(error) };
    return report;
  }
  report.structure = { ok: true };
  report.provider_environment = [...(project.config.opencode.provider_environment ?? [])];

  let baseline = null;
  try {
    await assertGitRepository(root);
    const head = await gitHead(root);
    if (contracts.state.active_task) {
      baseline = contracts.state.baseline_head;
      if (!/^[0-9a-fA-F]{40,64}$/.test(baseline ?? "")) {
        throw new AutopilotError("Active controller state has no valid preserved Git baseline", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      await assertHeadAndIndex(project, baseline);
    } else {
      baseline = head;
      await assertCleanStart(project);
    }
    report.git = {
      ok: true,
      baseline,
      clean_start_required: !contracts.state.active_task,
      active_task: contracts.state.active_task ?? null,
    };
  } catch (error) {
    report.git = { ok: false, error: preflightError(error) };
  }

  try {
    const checked = await preflightOpenCodeCommand(project);
    report.opencode = {
      ok: true,
      ...checked,
    };
  } catch (error) {
    report.opencode = {
      ok: false,
      command: [...project.config.opencode.command],
      error: preflightError(error),
    };
  }

  if (baseline) {
    for (const [taskId, task] of Object.entries(contracts.queue.tasks ?? {})) {
      if (task.status === "done") continue;
      for (const phase of ["execute", "repair", "review"]) {
        const requirement = {
          task_id: taskId,
          phase,
          agent: project.config.opencode.agents?.[phase] ?? null,
          credential_profile: project.config.opencode.credential_profiles?.[phase] ?? null,
          ok: false,
        };
        try {
          const checked = await preflightFreshOpenCode(project, { phase, taskId, baseline });
          Object.assign(requirement, {
            ok: true,
            role: checked.capabilities.role,
            mcp_servers: checked.capabilities.server_names,
            required_environment_names: checked.credentials.names,
            provider_auth_available: Boolean(checked.providerAuth),
            selected_mcp_auth_available: Boolean(
              checked.sourceMcpAuth &&
              checked.capabilities.server_names.some((name) => Object.hasOwn(checked.sourceMcpAuth.value, name)),
            ),
          });
        } catch (error) {
          requirement.error = preflightError(error);
        }
        report.phases.push(requirement);
      }
    }
  }

  const referencedGates = new Set(contracts.gates.final_gates ?? []);
  for (const task of Object.values(contracts.queue.tasks ?? {})) {
    if (task.status === "done") continue;
    for (const gateId of task.gates ?? []) referencedGates.add(gateId);
  }
  for (const gateId of [...referencedGates].sort()) {
    const gate = contracts.gates.gates?.[gateId];
    const requirement = {
      gate_id: gateId,
      credential_profile: gate?.credential_profile ?? null,
      ok: false,
    };
    try {
      if (!gate) throw new AutopilotError(`Unknown gate ${gateId}`, { code: "UNKNOWN_GATE" });
      const checked = await credentialEnvironmentForScope(
        project,
        gateId,
        gate.credential_profile,
      );
      requirement.ok = true;
      requirement.required_environment_names = checked.names;
    } catch (error) {
      requirement.error = preflightError(error);
    }
    report.gates.push(requirement);
  }

  report.ready = Boolean(
    report.validation.ok &&
    report.structure.ok &&
    report.git.ok &&
    report.opencode.ok &&
    report.phases.every((item) => item.ok) &&
    report.gates.every((item) => item.ok)
  );
  return report;
}

async function signal(root, kind) {
  const project = await loadProject(root);
  await assertControlTopology(project, { createMutable: true });
  const file = kind === "stop"
    ? project.paths.stop
    : kind === "maintenance"
      ? project.paths.maintenance
      : project.paths.paused;
  await atomicWriteFile(file, `${JSON.stringify({ requested_at: nowIso(), requested_by_pid: process.pid })}\n`);
  return { requested: kind, file: path.relative(root, file) };
}

async function resume(root, shouldDetach) {
  const project = await loadProject(root);
  await assertControlTopology(project, { createMutable: true });
  const active = await liveLock(project);
  if (active) throw new AutopilotError(`Cannot resume while controller PID ${active.pid} is active`, { code: "LOCKED" });
  if (shouldDetach) return { resumed: true, ...(await detach(root, "resume")) };
  const controller = new Controller(root, { resumeRequested: true });
  return controller.run();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const verb = options._[0];
  if (!["start", "once", "status", "preflight", "pause", "resume", "stop", "maintenance"].includes(verb)) {
    throw new AutopilotError(
      "Usage: autopilot.mjs preflight [--json] | start [--detach] | once | status | pause | maintenance | resume [--detach] | stop [--root PATH]",
      { code: "USAGE" },
    );
  }
  const root = await rootFrom(options);
  await preflightProjectRoot(root);
  let result;
  if (verb === "status") result = await status(root);
  else if (verb === "preflight") {
    result = await lifecyclePreflight(root);
    if (!result.ready) process.exitCode = 1;
  }
  else if (["pause", "stop", "maintenance"].includes(verb)) result = await signal(root, verb);
  else if (verb === "resume") result = await resume(root, Boolean(options.detach));
  else if (verb === "start" && options.detach && !options.foreground) result = { started: true, ...(await detach(root, "start")) };
  else result = await new Controller(root, { once: verb === "once" }).run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code ?? "ERROR", details: error.details ?? null }, null, 2)}\n`);
  process.exitCode = 1;
});
