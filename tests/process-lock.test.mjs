import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  acquireLock,
  inspectProcessLock,
  processStartIdentity,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/core.mjs";
import { acquireProjectLease } from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/git.mjs";
import { git, run } from "./runtime-helpers.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "controller.lock") };
}

test("an exact live process instance owns the controller lock", async (t) => {
  const { root, file } = await fixture(t);
  const lock = await acquireLock(file, { pid: process.pid, root });
  t.after(() => lock.release().catch(() => {}));
  const inspected = await inspectProcessLock(file, { expectedRoot: root });
  assert.equal(inspected.status, "live");
  await assert.rejects(
    acquireLock(file, { pid: process.pid, root }),
    (error) => error?.code === "LOCKED",
  );
});

test("a reused live PID with a different creation identity is stale", async (t) => {
  const { root, file } = await fixture(t);
  const identity = await processStartIdentity(process.pid);
  assert.ok(identity, "the current process must expose an instance identity on supported test platforms");
  await writeFile(file, `${JSON.stringify({
    pid: process.pid,
    root,
    process_start_identity: `${identity}-different-instance`,
  })}\n`, { mode: 0o600 });
  const inspected = await inspectProcessLock(file, { expectedRoot: root });
  assert.equal(inspected.status, "stale");
  const lock = await acquireLock(file, { pid: process.pid, root });
  await lock.release();
});

test("dead owners are stale while legacy live locks stay conservative", async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(file, `${JSON.stringify({ pid: 2147483647, root })}\n`, { mode: 0o600 });
  assert.equal((await inspectProcessLock(file, { expectedRoot: root })).status, "stale");
  await rm(file);
  await writeFile(file, `${JSON.stringify({ pid: process.pid, root })}\n`, { mode: 0o600 });
  const legacy = await inspectProcessLock(file, { expectedRoot: root });
  assert.equal(legacy.status, "live");
  assert.equal(legacy.legacy, true);
});

test("a partially written lock is conservative during acquisition and reclaimable after the grace period", async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(file, "{\"pid\":", { mode: 0o600 });
  const recent = await inspectProcessLock(file, { expectedRoot: root });
  assert.equal(recent.status, "live");
  assert.equal(recent.indeterminate, true);
  await assert.rejects(
    acquireLock(file, { pid: process.pid, root }),
    (error) => error?.code === "LOCKED",
  );

  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  const stale = await inspectProcessLock(file, { expectedRoot: root });
  assert.equal(stale.status, "stale");
  assert.equal(stale.incomplete, true);
  const lock = await acquireLock(file, { pid: process.pid, root });
  await lock.release();
});

test("the Git compare-and-swap lease admits only one concurrent controller", async (t) => {
  const { root } = await fixture(t);
  await git(root, ["init"]);
  const file = path.join(root, ".git", "autopilot-controller.lock");
  const payload = { pid: process.pid, root };
  const results = await Promise.allSettled([
    acquireProjectLease(root, file, payload),
    acquireProjectLease(root, file, payload),
  ]);
  const acquired = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "LOCKED");
  await acquired[0].value.release();
  const ref = await run([
    "git", "show-ref", "--verify", "refs/opencode-control-plane/controller-lock",
  ], { cwd: root });
  assert.notEqual(ref.code, 0);

  const next = await acquireProjectLease(root, file, payload);
  await next.release();
});

test("a crashed controller's Git and file leases are reclaimed together", async (t) => {
  const { root } = await fixture(t);
  await git(root, ["init"]);
  const file = path.join(root, ".git", "autopilot-controller.lock");
  const moduleUrl = pathToFileURL(path.resolve(
    ".agents/skills/init-project/assets/project/.autopilot/bin/lib/git.mjs",
  )).href;
  const child = await run([
    process.execPath,
    "--input-type=module",
    "--eval",
    [
      `import { acquireProjectLease } from ${JSON.stringify(moduleUrl)}`,
      `await acquireProjectLease(${JSON.stringify(root)}, ${JSON.stringify(file)}, { pid: process.pid, root: ${JSON.stringify(root)} })`,
    ].join(";"),
  ], { cwd: root });
  assert.equal(child.code, 0, child.stderr || child.stdout);

  const recovered = await acquireProjectLease(root, file, { pid: process.pid, root });
  await recovered.release();
  const ref = await run([
    "git", "show-ref", "--verify", "refs/opencode-control-plane/controller-lock",
  ], { cwd: root });
  assert.notEqual(ref.code, 0);
});
