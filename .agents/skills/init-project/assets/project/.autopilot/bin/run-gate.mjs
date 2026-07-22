#!/usr/bin/env node
import path from "node:path";
import { AutopilotError, findProjectRoot } from "./lib/core.mjs";
import { runGate } from "./lib/gate-runner.mjs";

const args = process.argv.slice(2);
const usage = "Usage: run-gate.mjs GATE_ID [--root PATH] [--task ID] [--attempt N] [--feedback --expected-definition-sha256 HASH]";
let gateId = null;
let rootArgument = null;
let taskId = "manual";
let attempt = 0;
let feedback = false;
let expectedDefinitionSha256 = null;
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
if (!result.success) process.exitCode = 1;
