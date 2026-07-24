import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  assertPrivateDirectory,
  assertPrivateFile,
  AutopilotError,
  exists,
  readJson,
  resolveInside,
} from "./core.mjs";
import { initialState } from "./state.mjs";
import { readRuntimeSettings } from "./runtime-settings.mjs";

export const DEFAULT_PATHS = Object.freeze({
  config: ".autopilot/config.json",
  state: ".autopilot/state.json",
  manifest: ".project/manifest.json",
  queue: ".project/plan/queue.json",
  gates: ".project/gates.json",
  runtime: ".autopilot/runtime",
  receipts: ".project/receipts",
  artifacts: ".autopilot/artifacts",
  checkpoint: ".autopilot/artifacts/checkpoint.md",
  blocker: ".autopilot/blocker.md",
  stop: ".autopilot/STOP",
  paused: ".autopilot/PAUSED",
  maintenance: ".autopilot/MAINTENANCE",
  lock: ".git/autopilot-controller.lock",
  credentials: ".autopilot/credentials.json",
});

const JSON_CAPS = Object.freeze({
  config: 64 * 1024,
  state: 64 * 1024,
  manifest: 64 * 1024,
  queue: 512 * 1024,
  gates: 128 * 1024,
  credentials: 64 * 1024,
});

export async function loadProject(root) {
  const configFile = resolveInside(root, DEFAULT_PATHS.config, "config path");
  const config = await readJson(configFile, { maxBytes: JSON_CAPS.config });
  const runtimeSettings = await readRuntimeSettings(root);
  config.opencode = { ...config.opencode, variant: runtimeSettings.variant };
  const relative = { ...DEFAULT_PATHS };
  const absolute = Object.fromEntries(
    Object.entries(relative).map(([key, value]) => [
      key,
      resolveInside(root, value, `${key} path`),
    ]),
  );

  const credentialsRelative = config.credential_profiles_file ?? DEFAULT_PATHS.credentials;
  if (credentialsRelative !== DEFAULT_PATHS.credentials) {
    throw new AutopilotError(
      `credential_profiles_file must be exactly ${DEFAULT_PATHS.credentials}`,
      { code: "CREDENTIAL_PATH_DENIED" },
    );
  }

  return {
    root: path.resolve(root),
    config,
    relative,
    paths: absolute,
    caps: JSON_CAPS,
  };
}

export async function preflightProjectRoot(root) {
  const resolved = path.resolve(root);
  await assertPrivateDirectory(resolved, resolved, "project root");
  await assertPrivateDirectory(resolved, path.join(resolved, ".autopilot"), ".autopilot directory");
  await assertPrivateFile(
    resolved,
    path.join(resolved, ...DEFAULT_PATHS.config.split("/")),
    DEFAULT_PATHS.config,
  );
  return resolved;
}

export async function assertControlTopology(project, { createMutable = false } = {}) {
  for (const [label, directory] of [
    ["project root", project.root],
    [".autopilot directory", path.join(project.root, ".autopilot")],
    [".project directory", path.join(project.root, ".project")],
    ["Git directory", path.join(project.root, ".git")],
  ]) await assertPrivateDirectory(project.root, directory, label);

  for (const key of ["config", "manifest", "queue", "gates"]) {
    await assertPrivateFile(project.root, project.paths[key], `${key} control file`);
  }
  // Runtime state is intentionally ignored and may be absent in a clean clone.
  await assertPrivateFile(project.root, project.paths.state, "state control file", { optional: true });
  await assertPrivateFile(project.root, project.paths.credentials, "credential metadata", { optional: true });
  for (const key of ["checkpoint", "blocker", "stop", "paused", "maintenance", "lock"]) {
    await assertPrivateFile(project.root, project.paths[key], `${key} control file`, { optional: true });
  }

  if (createMutable) {
    await Promise.all([
      mkdir(project.paths.runtime, { recursive: true }),
      mkdir(project.paths.artifacts, { recursive: true }),
    ]);
  }
  await Promise.all([
    assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory"),
    assertPrivateDirectory(project.root, project.paths.artifacts, "artifacts directory"),
  ]);
}

export async function loadContracts(project, { includeState = true } = {}) {
  const credentialsPromise = (await exists(project.paths.credentials))
    ? readJson(project.paths.credentials, { maxBytes: project.caps.credentials })
    : Promise.resolve({ schema_version: 1, profiles: {} });
  const [manifest, queue, gates, credentials, state] = await Promise.all([
    readJson(project.paths.manifest, { maxBytes: project.caps.manifest }),
    readJson(project.paths.queue, { maxBytes: project.caps.queue }),
    readJson(project.paths.gates, { maxBytes: project.caps.gates }),
    credentialsPromise,
    includeState
      ? ((await exists(project.paths.state))
        ? readJson(project.paths.state, { maxBytes: project.caps.state })
        : Promise.resolve(initialState()))
      : Promise.resolve(null),
  ]);
  return { manifest, queue, gates, credentials, state };
}

export function taskEntries(queue) {
  if (!queue.tasks || typeof queue.tasks !== "object" || Array.isArray(queue.tasks)) {
    throw new AutopilotError("queue.tasks must be an object keyed by task ID", {
      code: "INVALID_QUEUE",
    });
  }
  return Object.entries(queue.tasks).map(([id, task]) => [id, { ...task, id }]);
}
