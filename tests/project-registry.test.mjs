import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  forgetProject,
  readProjectRegistry,
  registerProject,
  registryFile,
} from "../.agents/skills/init-project/bin/lib/project-registry.mjs";
import { createScaffold } from "./runtime-helpers.mjs";

test("project registry adds, deduplicates, and forgets initialized projects atomically", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-registry-home-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const root = await createScaffold(t);

  const first = await registerProject(root, { home, name: "Producer Scribe" });
  const second = await registerProject(`${root}${path.sep}`, { home, name: "Producer Scribe" });
  assert.equal(first.added, true);
  assert.equal(second.added, false);
  const registry = await readProjectRegistry({ home });
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].name, "Producer Scribe");
  assert.equal(registry.projects[0].root, path.resolve(root));
  assert.doesNotMatch(await readFile(registryFile(home), "utf8"), /credential|secret|environment/i);

  assert.equal((await forgetProject(first.project.id, { home })).removed, 1);
  assert.deepEqual((await readProjectRegistry({ home })).projects, []);
});

test("concurrent project registrations do not lose either project", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-registry-concurrent-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const [left, right] = await Promise.all([createScaffold(t), createScaffold(t)]);
  await Promise.all([
    registerProject(left, { home, name: "Left" }),
    registerProject(right, { home, name: "Right" }),
  ]);
  assert.deepEqual((await readProjectRegistry({ home })).projects.map((item) => item.name).sort(), ["Left", "Right"]);
});
