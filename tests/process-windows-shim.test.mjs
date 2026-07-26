import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWindowsInvocation } from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/process.mjs";

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
