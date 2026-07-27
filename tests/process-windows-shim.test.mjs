import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveWindowsInvocation,
  runArgv,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/process.mjs";

test("Windows Corepack cmd shim resolves to its fixed Node entry point", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows shim resolution is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-corepack-shim-"));
  try {
    const script = path.join(root, "node_modules", "corepack", "dist", "corepack.js");
    await mkdir(path.dirname(script), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "corepack.cmd"), "untrusted command text", "utf8"),
      writeFile(path.join(root, "node.exe"), "native fixture", "utf8"),
      writeFile(script, "fixture", "utf8"),
    ]);
    const invocation = resolveWindowsInvocation(
      ["corepack", "pnpm", "run", "check"],
      root,
      { Path: root },
    );
    assert.equal(invocation.command, path.join(root, "node.exe"));
    assert.deepEqual(invocation.args, [script, "pnpm", "run", "check"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows command shims without an approved native mapping remain blocked", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows shim resolution is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-unknown-shim-"));
  try {
    await writeFile(path.join(root, "unknown.cmd"), "untrusted command text", "utf8");
    assert.throws(
      () => resolveWindowsInvocation(["unknown", "arg"], root, { Path: root }),
      (error) => error?.code === "WINDOWS_SHIM_UNSUPPORTED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guarded Windows Corepack shim executes and quiesces descendants before returning", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows Job Object behavior is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-corepack-execution-"));
  const heldDirectory = path.join(root, "held-by-descendant");
  try {
    const script = path.join(root, "node_modules", "corepack", "dist", "corepack.js");
    await mkdir(path.dirname(script), { recursive: true });
    await mkdir(heldDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "corepack.cmd"), "untrusted command text", "utf8"),
      copyFile(process.execPath, path.join(root, "node.exe")),
      writeFile(script, [
        'const { spawn } = require("node:child_process");',
        `const held = ${JSON.stringify(heldDirectory)};`,
        "const child = spawn(process.execPath, [\"-e\", `process.chdir(${JSON.stringify(held)}); setInterval(() => {}, 1000)`], { stdio: \"ignore\", windowsHide: true });",
        "process.stdout.write(JSON.stringify({ child_pid: child.pid, executed: true }) + \"\\n\");",
        "child.unref();",
      ].join("\n"), "utf8"),
    ]);
    const environment = { ...process.env, Path: root };
    delete environment.PATH;
    const result = await runArgv(["corepack", "pnpm", "run", "check"], {
      cwd: root,
      env: environment,
      timeoutMs: 15_000,
      maxOutputBytes: 8192,
      guardProcessTree: true,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const executed = JSON.parse(result.stdout.trim());
    assert.equal(executed.executed, true);
    assert.throws(() => process.kill(executed.child_pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("guarded Windows timeout stops and proves descendant quiescence before returning", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows Job Object behavior is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-guard-timeout-"));
  try {
    const target = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { stdio: "ignore", windowsHide: true });',
      'process.stdout.write(String(child.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join(" ");
    const started = Date.now();
    const result = await runArgv([process.execPath, "-e", target], {
      cwd: root,
      env: process.env,
      timeoutMs: 3_000,
      maxOutputBytes: 8192,
      guardProcessTree: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.equal(result.code, 124, result.stderr || result.stdout);
    assert.ok(elapsed < 12_000, `guarded timeout took ${elapsed} ms`);
    const descendantPid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, result.stdout);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
