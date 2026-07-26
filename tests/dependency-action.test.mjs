import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runner = path.resolve(".agents/skills/init-project/assets/project/.autopilot/bin/run-action.mjs");

test("dependency action rejects credential-bearing project npm configuration before launch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-dependency-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".autopilot"), { recursive: true });
  await writeFile(path.join(root, ".autopilot", "config.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    private: true,
    packageManager: "pnpm@11.14.0",
  }) + "\n", "utf8");
  await writeFile(path.join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n", "utf8");
  await assert.rejects(
    execute(process.execPath, [runner, "dependency-lock", "--root", root]),
    (error) => /credential-free boolean project \.npmrc settings/.test(error.stderr),
  );
});
