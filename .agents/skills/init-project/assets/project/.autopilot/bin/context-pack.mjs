#!/usr/bin/env node
import path from "node:path";
import { buildContextPack, buildContextSizeReport } from "./lib/context-pack.mjs";
import { AutopilotError, findProjectRoot } from "./lib/core.mjs";

const options = parseArgs(process.argv.slice(2));
const root = await findProjectRoot(options.root ? path.resolve(options.root) : process.cwd());
if (options.report) {
  const report = await buildContextSizeReport(root, {
    taskId: options.taskId,
    attempt: options.attempt,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
} else {
  if (!options.taskId) usage();
  const pack = await buildContextPack(root, options.taskId, {
    stage: options.stage,
    attempt: options.attempt,
  });
  process.stdout.write(pack.text);
}

function parseArgs(args) {
  const result = {
    taskId: null,
    root: null,
    stage: "execute",
    attempt: 1,
    report: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--root") result.root = requiredValue(args, ++index, "--root");
    else if (value === "--stage") result.stage = requiredValue(args, ++index, "--stage");
    else if (value === "--attempt") result.attempt = Number(requiredValue(args, ++index, "--attempt"));
    else if (value === "--report") result.report = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help") usage(0);
    else if (value.startsWith("--")) usage();
    else if (result.taskId) usage();
    else result.taskId = value;
  }
  if (!Number.isInteger(result.attempt) || result.attempt < 1) usage();
  if (!result.report && result.json) usage();
  if (!result.report && !result.taskId) usage();
  return result;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new AutopilotError(`${option} requires a value`, { code: "USAGE" });
  }
  return value;
}

function usage(exitCode = 1) {
  const message = "Usage: context-pack.mjs TASK_ID [--stage execute|repair|review] [--attempt N]\n" +
    "       context-pack.mjs --report [TASK_ID] [--attempt N] [--json]";
  if (exitCode === 0) {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  throw new AutopilotError(message, { code: "USAGE" });
}

function printReport(report) {
  process.stdout.write(`Context cap: ${report.cap_bytes} bytes\n`);
  for (const [taskId, phases] of Object.entries(report.tasks)) {
    for (const [phase, details] of Object.entries(phases)) {
      process.stdout.write(
        `${taskId} ${phase}: static=${details.static_bytes} projected_max=${details.projected_max_bytes} bytes\n`,
      );
    }
  }
}
