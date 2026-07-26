#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { AutopilotError, findProjectRoot, truncateUtf8 } from "./lib/core.mjs";
import { runArgv } from "./lib/process.mjs";

const usage = "Usage: run-action.mjs dependency-lock --root PATH";
const args = process.argv.slice(2);
let action = null;
let rootArgument = null;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--root") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new AutopilotError(usage, { code: "USAGE" });
    rootArgument = value;
    index += 1;
  } else if (!argument.startsWith("--") && action === null) action = argument;
  else throw new AutopilotError(usage, { code: "USAGE" });
}
if (action !== "dependency-lock" || !rootArgument) {
  throw new AutopilotError(usage, { code: "USAGE" });
}

const root = await findProjectRoot(path.resolve(rootArgument));
const packageFile = path.join(root, "package.json");
const packageInfo = await lstat(packageFile);
if (!packageInfo.isFile() || packageInfo.isSymbolicLink() || packageInfo.size > 1024 * 1024) {
  throw new AutopilotError("package.json must be one bounded regular file", { code: "DEPENDENCY_POLICY_INVALID" });
}
let manifest;
try { manifest = JSON.parse(await readFile(packageFile, "utf8")); }
catch { throw new AutopilotError("package.json is not valid JSON", { code: "DEPENDENCY_POLICY_INVALID" }); }
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  throw new AutopilotError("package.json must contain one object", { code: "DEPENDENCY_POLICY_INVALID" });
}
const manager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
if (!manager) {
  throw new AutopilotError("packageManager must pin one exact pnpm version", { code: "DEPENDENCY_POLICY_INVALID" });
}

const npmrcFile = path.join(root, ".npmrc");
try {
  const npmrcInfo = await lstat(npmrcFile);
  if (!npmrcInfo.isFile() || npmrcInfo.isSymbolicLink() || npmrcInfo.size > 16 * 1024) {
    throw new AutopilotError(".npmrc must be one bounded regular file", { code: "DEPENDENCY_POLICY_INVALID" });
  }
  const safeKeys = new Set([
    "auto-install-peers", "engine-strict", "package-manager-strict",
    "package-manager-strict-version", "prefer-frozen-lockfile", "save-exact",
    "shared-workspace-lockfile", "strict-peer-dependencies",
  ]);
  for (const rawLine of (await readFile(npmrcFile, "utf8")).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const entry = /^([a-z][a-z0-9-]*)=(true|false)$/i.exec(line);
    if (!entry || !safeKeys.has(entry[1].toLowerCase())) {
      throw new AutopilotError(
        "The dependency action accepts only credential-free boolean project .npmrc settings",
        { code: "DEPENDENCY_POLICY_INVALID" },
      );
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const started = Date.now();
const result = await runArgv([
  "corepack", "pnpm", "install",
  "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile",
  "--frozen-lockfile=false", "--reporter=append-only",
], {
  cwd: root,
  timeoutMs: 10 * 60 * 1000,
  maxOutputBytes: 64 * 1024,
  guardProcessTree: true,
});
const output = {
  action: "dependency-lock",
  package_manager: `pnpm@${manager[1]}`,
  success: result.code === 0 && !result.timed_out,
  code: result.code,
  timed_out: result.timed_out,
  duration_ms: Date.now() - started,
  diagnostic: {
    stdout: truncateUtf8(result.stdout, 4096),
    stderr: truncateUtf8(result.stderr, 4096),
    output_truncated: Boolean(result.output_truncated) ||
      Buffer.byteLength(result.stdout, "utf8") > 4096 || Buffer.byteLength(result.stderr, "utf8") > 4096,
  },
};
process.stdout.write(`${JSON.stringify(output)}\n`);
if (!output.success) process.exitCode = 1;
