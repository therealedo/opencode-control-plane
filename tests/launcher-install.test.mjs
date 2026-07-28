import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(source, "scripts", "install-launcher.mjs");

function run(args) {
  return spawnSync(process.execPath, [installer, ...args], { cwd: source, encoding: "utf8", windowsHide: true });
}

test("launcher-only install exposes the fleet command without global OpenCode files", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-launcher-only-"));
  const bin = path.join(home, "bin");
  const manager = path.join(home, "manager");
  t.after(() => rm(home, { recursive: true, force: true }));

  const installed = run(["--home", home, "--bin-home", bin, "--manager-home", manager, "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  const output = JSON.parse(installed.stdout);
  assert.equal(output.global_opencode_files_installed, false);
  assert.equal(output.changed, true);
  await access(output.launcher);
  await assert.rejects(access(path.join(home, ".agents")), /ENOENT/);
  await assert.rejects(access(path.join(home, ".config", "opencode")), /ENOENT/);

  const launched = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", output.launcher, "--snapshot", "--json"], { cwd: home, encoding: "utf8", windowsHide: true })
    : spawnSync(output.launcher, ["--snapshot", "--json"], { cwd: home, encoding: "utf8", windowsHide: true });
  assert.equal(launched.status, 0, launched.stderr || launched.stdout);
  assert.deepEqual(JSON.parse(launched.stdout).projects, []);

  const repeated = run(["--home", home, "--bin-home", bin, "--manager-home", manager, "--json"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed, false);
});

test("launcher-only install refuses drift and removes only its owned shim", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-launcher-owned-"));
  const bin = path.join(home, "bin");
  const manager = path.join(home, "manager");
  const args = ["--home", home, "--bin-home", bin, "--manager-home", manager, "--json"];
  t.after(() => rm(home, { recursive: true, force: true }));

  const installed = run(args);
  assert.equal(installed.status, 0, installed.stderr);
  const launcher = JSON.parse(installed.stdout).launcher;
  await writeFile(launcher, "user-owned command\n", "utf8");
  const rejected = run(args);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unowned command/);
  assert.equal(await readFile(launcher, "utf8"), "user-owned command\n");

  assert.equal(run([...args, "--force"]).status, 0);
  const removed = run([...args, "--remove"]);
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(access(launcher), /ENOENT/);
});
