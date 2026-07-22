import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteFile,
  assertPrivateDirectory,
  assertPrivateFile,
  assertRealInside,
  AutopilotError,
  exists,
  nowIso,
  readJson,
  readUtf8,
  truncateUtf8,
  utf8Bytes,
} from "./core.mjs";

export function initialState() {
  return {
    schema_version: 1,
    revision: 0,
    run_id: null,
    status: "idle",
    phase: "idle",
    pid: null,
    started_at: null,
    heartbeat_at: null,
    cycle: 0,
    completed_in_run: 0,
    active_task: null,
    attempt: 0,
    no_progress_count: 0,
    last_progress_hash: null,
    last_failure_fingerprint: null,
    last_failure_evidence: null,
    last_session: null,
    session_ids: [],
    task_tool_usage: {},
    blocker: null,
    last_green: null,
    completion: null,
    finalization: null,
  };
}

export async function loadState(project) {
  if (!(await exists(project.paths.state))) return initialState();
  return readJson(project.paths.state, { maxBytes: project.caps.state });
}

export async function writeState(project, previous, patch) {
  const state = {
    ...previous,
    ...patch,
    schema_version: 1,
    revision: Number(previous.revision ?? 0) + 1,
    heartbeat_at: nowIso(),
  };
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  if (utf8Bytes(contents) > project.caps.state) {
    throw new AutopilotError(`Controller state exceeds its ${project.caps.state}-byte recovery cap`, {
      code: "STATE_CAP_EXCEEDED",
    });
  }
  await atomicWriteFile(project.paths.state, contents);
  return state;
}

export async function writeQueue(project, queue) {
  const next = { ...queue, revision: Number(queue.revision ?? 0) + 1 };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (utf8Bytes(contents) > project.caps.queue) {
    throw new AutopilotError(`Task queue exceeds its ${project.caps.queue}-byte recovery cap`, {
      code: "QUEUE_CAP_EXCEEDED",
    });
  }
  await atomicWriteFile(project.paths.queue, contents);
  return next;
}

export async function clearPhaseContracts(project) {
  await mkdir(project.paths.runtime, { recursive: true });
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  await Promise.all([
    rm(path.join(project.paths.runtime, "candidate.json"), { force: true }),
    rm(path.join(project.paths.runtime, "review.json"), { force: true }),
    rm(path.join(project.paths.runtime, "mode-intent.json"), { force: true }),
  ]);
}

export async function clearReview(project) {
  await mkdir(project.paths.runtime, { recursive: true });
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  await rm(path.join(project.paths.runtime, "review.json"), { force: true });
}

export async function clearCandidate(project) {
  await mkdir(project.paths.runtime, { recursive: true });
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  await rm(path.join(project.paths.runtime, "candidate.json"), { force: true });
}

export async function clearModeIntent(project) {
  await mkdir(project.paths.runtime, { recursive: true });
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  await rm(path.join(project.paths.runtime, "mode-intent.json"), { force: true });
}

export async function readCandidate(project) {
  return readPrivateRuntimeJson(project, "candidate.json");
}

export async function readCandidateDocument(project) {
  return readPrivateRuntimeJsonDocument(project, "candidate.json");
}

export async function readReview(project) {
  return readPrivateRuntimeJson(project, "review.json");
}

export async function readReviewDocument(project) {
  return readPrivateRuntimeJsonDocument(project, "review.json");
}

export async function readModeIntent(project) {
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  const file = path.join(project.paths.runtime, "mode-intent.json");
  if (!(await exists(file))) return null;
  await assertPrivateFile(project.root, file, "mode-intent.json");
  const text = await readUtf8(file, { maxBytes: 64 * 1024 });
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AutopilotError(`Invalid mode-intent.json: ${error.message}`, {
      code: "INVALID_JSON",
    });
  }
  return { text, value };
}

async function readPrivateRuntimeJson(project, name) {
  return (await readPrivateRuntimeJsonDocument(project, name)).value;
}

async function readPrivateRuntimeJsonDocument(project, name) {
  await assertPrivateDirectory(project.root, project.paths.runtime, "runtime directory");
  const file = path.join(project.paths.runtime, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
    throw new AutopilotError(`${name} must be a private regular file`, {
      code: "CONTROL_DIRECTORY_UNSAFE",
    });
  }
  await assertRealInside(project.root, file, name);
  const text = await readUtf8(file, { maxBytes: 64 * 1024 });
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new AutopilotError(`Invalid JSON in ${file}: ${error.message}`, {
      code: "INVALID_JSON",
    });
  }
}

export async function writeCheckpoint(project, state, note) {
  const text = [
    "# Autopilot checkpoint",
    "",
    `Run: ${state.run_id ?? "none"}`,
    `State revision: ${state.revision}`,
    `Status: ${state.status}`,
    `Phase: ${state.phase}`,
    `Task: ${state.active_task ?? "none"}`,
    `Attempt: ${state.attempt}`,
    `Heartbeat: ${state.heartbeat_at ?? nowIso()}`,
    "",
    truncateUtf8(note ?? "", 4 * 1024),
    "",
  ].join("\n");
  await atomicWriteFile(project.paths.checkpoint, text);
}

export async function writeBlocker(project, blocker) {
  const text = [
    "# Human action required",
    "",
    `Kind: ${blocker.kind ?? "unspecified"}`,
    "",
    truncateUtf8(blocker.message ?? "", 2 * 1024),
    "",
    "## Required action",
    truncateUtf8(blocker.required_action ?? "Inspect the checkpoint and resolve the blocker.", 2 * 1024),
    "",
    "## Resume condition",
    truncateUtf8(blocker.resume_condition ?? "Run the resume command after the condition is satisfied.", 2 * 1024),
    "",
  ].join("\n");
  await atomicWriteFile(project.paths.blocker, text);
}

export async function pauseRequested(project) {
  return (await exists(project.paths.paused)) || (await exists(project.paths.stop));
}

export async function maintenanceRequested(project) {
  return exists(project.paths.maintenance);
}
