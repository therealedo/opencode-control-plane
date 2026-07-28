import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createScaffold, readJson, writeJson } from "./runtime-helpers.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(source, "scripts", "install-project.mjs");
const globalInstaller = path.join(source, "scripts", "install.mjs");
const globalUninstaller = path.join(source, "scripts", "uninstall-global.mjs");

const run = (script, args, cwd = source) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", windowsHide: true });

test("project-local bootstrap initializes without global files and manual mode blocks autonomous start", async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "ocp-local-project-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const installed = run(installer, ["--target", target, "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  const manifest = JSON.parse(await readFile(path.join(target, ".opencode-control-plane", "install.json"), "utf8"));
  assert.equal(manifest.version, "1.7.1");
  await access(path.join(target, ".agents", "skills", "init-project", "SKILL.md"));
  assert.match(await readFile(path.join(target, ".opencode", "commands", "init-project.md"), "utf8"), /project-local/);

  const scaffold = path.join(target, ".agents", "skills", "init-project", "bin", "scaffold.mjs");
  const initialized = run(scaffold, ["--target", target, "--json"], target);
  assert.equal(initialized.status, 0, initialized.stderr);
  const manual = path.join(target, ".autopilot", "bin", "manual-mode.mjs");
  assert.equal(run(manual, ["on", "--root", target, "--json"], target).status, 0);
  const blocked = run(path.join(target, ".autopilot", "bin", "autopilot.mjs"), ["start", "--root", target], target);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /MANUAL_MODE/);
  assert.equal(run(manual, ["off", "--root", target, "--json"], target).status, 0);
});

test("project-local installer refuses drift instead of overwriting it", async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "ocp-local-drift-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  assert.equal(run(installer, ["--target", target, "--json"]).status, 0);
  const skill = path.join(target, ".agents", "skills", "init-project", "SKILL.md");
  await writeFile(skill, "user change\n", "utf8");
  const second = run(installer, ["--target", target, "--json"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /drifted outside the installer/);
  assert.equal(await readFile(skill, "utf8"), "user change\n");
});

test("bootstrap-only adoption leaves every older runtime-owned file untouched", async (t) => {
  const target = await createScaffold(t, { ready: true });
  const runtimeFile = path.join(target, ".autopilot", "control-plane.json");
  const runtime = await readJson(runtimeFile);
  runtime.version = "1.6.20";
  await writeJson(runtimeFile, runtime);

  const preview = run(installer, ["--target", target, "--bootstrap-only", "--dry-run", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const output = JSON.parse(preview.stdout);
  assert.equal(output.runtime_upgrade.required, true);
  assert.equal(output.runtime_upgrade.skipped, "bootstrap-only migration");
  assert.deepEqual(output.actions.map((item) => item.relative).sort(), [
    ".agents/skills/evolve-project",
    ".agents/skills/init-project",
  ]);
});

test("global uninstaller removes only manifest-owned outputs", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-global-remove-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = run(globalInstaller, ["--home", home, "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  const unrelated = path.join(home, ".agents", "skills", "unrelated", "SKILL.md");
  await writeFile(unrelated, "keep\n", { encoding: "utf8", flag: "wx" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(unrelated), { recursive: true });
    await writeFile(unrelated, "keep\n", "utf8");
  });
  const removed = run(globalUninstaller, ["--home", home, "--source-root", source, "--json"]);
  assert.equal(removed.status, 0, removed.stderr);
  await access(unrelated);
  await assert.rejects(access(path.join(home, ".agents", ".autopilot-install-manifest.json")), /ENOENT/);
});
