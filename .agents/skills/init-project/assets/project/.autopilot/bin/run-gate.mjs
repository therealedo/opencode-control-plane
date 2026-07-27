#!/usr/bin/env node
import path from "node:path";
import { AutopilotError, findProjectRoot, truncateUtf8 } from "./lib/core.mjs";
import { GATE_RESULT_SCHEMA_VERSION, runGate } from "./lib/gate-runner.mjs";

const started = Date.now();
const args = process.argv.slice(2);
const usage = "Usage: run-gate.mjs GATE_ID [--root PATH] [--task ID] [--attempt N] [--feedback --expected-definition-sha256 HASH]";
let gateId = null;
let rootArgument = null;
let taskId = "manual";
let attempt = 0;
let feedback = false;
let expectedDefinitionSha256 = null;
function stableErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "GATE_CONTROLLER_FAILURE";
}

async function main() {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--root", "--task", "--attempt", "--expected-definition-sha256"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new AutopilotError(usage, { code: "USAGE" });
      index += 1;
      if (argument === "--root") rootArgument = value;
      else if (argument === "--task") taskId = value;
      else if (argument === "--attempt") attempt = Number(value);
      else expectedDefinitionSha256 = value;
    } else if (argument === "--feedback") feedback = true;
    else if (!argument.startsWith("--") && gateId === null) gateId = argument;
    else throw new AutopilotError(usage, { code: "USAGE" });
  }
  if (!gateId || !Number.isSafeInteger(attempt) || attempt < 0) {
    throw new AutopilotError(usage, { code: "USAGE" });
  }
  const root = await findProjectRoot(rootArgument ? path.resolve(rootArgument) : process.cwd());
  const result = await runGate(root, gateId, {
    taskId,
    attempt,
    feedback,
    expectedDefinitionSha256,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.classification === "success"
    ? 0
    : result.classification === "task_failure"
      ? 1
      : 2;
}

main().catch((error) => {
  const errorCode = stableErrorCode(error);
  const envelope = {
    schema_version: GATE_RESULT_SCHEMA_VERSION,
    operation: "gate",
    classification: "controller_failure",
    error_code: errorCode,
    gate_id: typeof gateId === "string" ? truncateUtf8(gateId, 256) : null,
    success: false,
    code: null,
    timed_out: false,
    duration_ms: Date.now() - started,
    artifact: null,
    gate_definition_sha256: null,
    fingerprint: null,
    primary_gate_outcome: null,
    controller_failure: {
      error_code: errorCode,
      message: truncateUtf8(String(error?.message ?? error), 2048),
    },
    diagnostic: {
      stdout: "",
      stderr: truncateUtf8(`${errorCode}: ${String(error?.message ?? error)}`, 2048),
      output_truncated: false,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.stderr.write(`${envelope.diagnostic.stderr}\n`);
  process.exitCode = 2;
});
