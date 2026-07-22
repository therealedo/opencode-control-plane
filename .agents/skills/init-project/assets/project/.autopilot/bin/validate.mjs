#!/usr/bin/env node
import path from "node:path";
import { findProjectRoot } from "./lib/core.mjs";
import { validateProject } from "./lib/validator.mjs";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const root = await findProjectRoot(valueAfter("--root") ? path.resolve(valueAfter("--root")) : process.cwd());
const result = await validateProject(root, {
  strict: args.includes("--strict"),
  checkGit: args.includes("--strict") && !args.includes("--skip-git"),
  taskId: valueAfter("--task"),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
