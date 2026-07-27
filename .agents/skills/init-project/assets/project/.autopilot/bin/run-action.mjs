#!/usr/bin/env node
const OPERATION = "dependency-lock";
const usage = "Usage: run-action.mjs dependency-lock --root PATH [--probe]";

class CliError extends Error {
  constructor(message, code = "DEPENDENCY_USAGE_INVALID") {
    super(message);
    this.code = code;
  }
}

function localFailure(error, {
  classification = "task_failure",
  mode = "sync",
  errorCode = null,
} = {}) {
  const message = String(error?.message ?? "Dependency action failed");
  return {
    schema_version: 1,
    operation: OPERATION,
    classification,
    error_code: errorCode ?? (/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? "")
      ? error.code
      : "DEPENDENCY_CONTROLLER_FAILURE"),
    action: OPERATION,
    package_manager: null,
    success: false,
    code: null,
    timed_out: false,
    duration_ms: 0,
    mode,
    changed: false,
    skipped: false,
    lockfile_sha256: null,
    diagnostic: {
      stdout: "",
      stderr: message.slice(0, 2048),
      output_truncated: message.length > 2048,
    },
  };
}

function parseArguments(args) {
  let action = null;
  let root = null;
  let probe = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      const value = args[index + 1];
      if (root !== null || !value || value.startsWith("--") || /[\0\r\n]/.test(value)) {
        throw new CliError(usage);
      }
      root = value;
      index += 1;
    } else if (argument === "--probe") {
      if (probe) throw new CliError(usage);
      probe = true;
    } else if (!argument.startsWith("--") && action === null) action = argument;
    else throw new CliError(usage);
  }
  if (action !== OPERATION || !root) throw new CliError(usage);
  return { root, probe };
}

async function loadDependencyManager() {
  try {
    return await import("./lib/dependency-manager.mjs");
  } catch {
    throw new CliError(
      "Dependency action implementation could not be loaded",
      "DEPENDENCY_RUNNER_IMPORT_FAILED",
    );
  }
}

async function main(args = process.argv.slice(2)) {
  let output;
  try {
    const parsed = parseArguments(args);
    const dependencyManager = await loadDependencyManager();
    output = parsed.probe
      ? await dependencyManager.probeDependencyManager(parsed.root)
      : await dependencyManager.ensureDependencyState(parsed.root, { mode: "if-needed" });
  } catch (error) {
    const taskFailure = error?.code === "DEPENDENCY_USAGE_INVALID";
    output = localFailure(error, {
      classification: taskFailure ? "task_failure" : "controller_failure",
      errorCode: taskFailure ? null : error?.code ?? "DEPENDENCY_CONTROLLER_FAILURE",
    });
  }
  let serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    output = localFailure(new Error("Dependency action result exceeded its output bound"), {
      classification: "controller_failure",
      errorCode: "DEPENDENCY_OUTPUT_LIMIT",
    });
    serialized = JSON.stringify(output);
  }
  process.stdout.write(`${serialized}\n`);
  process.exitCode = output.classification === "success"
    ? 0
    : output.classification === "task_failure" ? 1 : 2;
}

await main();
