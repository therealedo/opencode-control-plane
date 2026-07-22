import { appendFile, lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  appendBoundedTaskToolUsage,
  assertNoIssues,
  validateCandidate,
  validateModeIntentContract,
  validateReview,
  validateTaskToolUsage,
} from "./contracts.mjs";
import {
  acquireLock,
  assertPrivateDirectory,
  assertRealInside,
  atomicWriteFile,
  AutopilotError,
  exists,
  normalizeRelative,
  nowIso,
  readJson,
  readUtf8,
  sha256,
  stableJson,
  truncateUtf8,
  writeImmutableJson,
} from "./core.mjs";
import { buildContextPack } from "./context-pack.mjs";
import {
  credentialEnvironmentForScope,
  gateDefinitionSha256,
  runGates,
  sweepStaleGateRuntimes,
} from "./gate-runner.mjs";
import {
  assertCandidateFiles,
  assertCleanStart,
  assertFilesMatchTree,
  assertGitRepository,
  assertHeadAndIndex,
  assertModeIntentTransitions,
  assertSafeChangedFiles,
  canonicalTreeTransitionHash,
  createCommitObject,
  gitDiffForReview,
  gitDiffHash,
  gitHead,
  gitStatus,
  gitTree,
  ignoredApplicationSnapshot,
  isAncestor,
  moveHead,
  prepareCommitTree,
  readRevisionFile,
  assertIgnoredApplicationUnchanged,
  assertSafeTaskWriteTargets,
  taskChangedFiles,
  validateChangedPaths,
  verifyCommitTransition,
} from "./git.mjs";
import {
  assertPhasePromptHasNoSecrets,
  consumeEphemeralPhaseSecrets,
  preflightFreshOpenCode,
  preflightOpenCodeCommand,
  runFreshOpenCode,
  sweepStaleOpenCodeRuntimes,
} from "./opencode-isolated.mjs";
import {
  assertControlTopology,
  loadContracts,
  loadProject,
  preflightProjectRoot,
  taskEntries,
} from "./project.mjs";
import {
  clearCandidate,
  clearPhaseContracts,
  clearModeIntent,
  clearReview,
  loadState,
  maintenanceRequested,
  pauseRequested,
  readCandidateDocument,
  readModeIntent,
  readReviewDocument,
  writeBlocker,
  writeCheckpoint,
  writeQueue,
  writeState,
} from "./state.mjs";
import { exactSecretMatches } from "./secrets.mjs";
import { scanFilesForSecrets, validateProject } from "./validator.mjs";

function runId() {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
}

const SESSION_LEDGER_ROLLOVER_ENTRIES = 240;
const SESSION_LEDGER_ROLLOVER_BYTES = 48 * 1024;

function contractSecretIssues(name, text, exactSecrets) {
  return exactSecretMatches(text, exactSecrets).map((match) => ({
    severity: "error",
    location: `.autopilot/runtime/${name}:${text.slice(0, match.index).split(/\r?\n/).length}`,
    message: "Exact ephemeral credential value detected; value intentionally omitted",
    code: "EXACT_SECRET",
  }));
}

async function assertCleanPhaseContract(project, name, document, exactSecrets) {
  const issues = contractSecretIssues(name, document.text, exactSecrets);
  if (issues.length === 0) return document.value;
  let removed = false;
  try {
    if (name === "candidate.json") await clearCandidate(project);
    else await clearReview(project);
    removed = true;
  } catch {}
  throw new AutopilotError(
    removed
      ? `Exact secret scan blocked and removed tainted ${name}`
      : `Exact secret scan blocked ${name}, but safe removal failed`,
    {
      code: "SECRET_SCAN_FAILED",
      details: { issues, tainted_contract_removed: removed },
    },
  );
}

function nextReady(queue) {
  const entries = taskEntries(queue);
  const done = new Set(entries.filter(([, task]) => task.status === "done").map(([id]) => id));
  let changed = false;
  for (const [, task] of entries) {
    if (task.status === "pending" && (task.depends_on ?? []).every((id) => done.has(id))) {
      queue.tasks[task.id].status = "ready";
      changed = true;
    }
  }
  const ready = taskEntries(queue)
    .filter(([, task]) => task.status === "ready")
    .sort(([idA, a], [idB, b]) => Number(b.priority) - Number(a.priority) || idA.localeCompare(idB));
  return { entry: ready[0] ?? null, changed };
}

function allDone(queue) {
  const entries = taskEntries(queue);
  return entries.length > 0 && entries.every(([, task]) => task.status === "done");
}

function taskEvidenceHash(taskId, task) {
  return sha256(stableJson({
    id: taskId,
    title: task.title,
    priority: task.priority,
    depends_on: task.depends_on ?? [],
    spec: task.spec,
    context: task.context ?? [],
    allowed_paths: task.allowed_paths ?? [],
    gates: task.gates ?? [],
    tool_grants: task.tool_grants ?? {},
    risk: task.risk,
    attempt_limit: task.attempt_limit,
  }));
}

function plannedTaskCompletionQueue(queue, taskId) {
  return {
    ...queue,
    revision: Number(queue.revision ?? 0) + 1,
    project_status: "running",
    tasks: {
      ...queue.tasks,
      [taskId]: { ...queue.tasks[taskId], status: "done" },
    },
  };
}

function jsonDocumentSha256(value) {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

async function injectPostPrepareRaceForTest(project, label, expectedFileSha256) {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.AUTOPILOT_TEST_POST_PREPARE_RACE_LABEL !== label
  ) return;
  const requested = process.env.AUTOPILOT_TEST_POST_PREPARE_RACE_FILE;
  if (!requested) return;
  const file = normalizeRelative(requested);
  if (!Object.hasOwn(expectedFileSha256, file)) return;
  const absolute = path.resolve(project.root, file);
  await assertRealInside(project.root, absolute, "post-prepare race test file");
  await appendFile(absolute, " ", "utf8");
}

function sameValues(left, right) {
  return stableJson(left) === stableJson(right);
}

function removesOnly(previous, current) {
  return Array.isArray(previous) && Array.isArray(current) &&
    current.every((value) => previous.includes(value));
}

function retainsInOrder(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return false;
  let cursor = 0;
  for (const value of current) {
    if (value === previous[cursor]) cursor += 1;
  }
  return cursor === previous.length;
}

function isMonotonicHighRiskConstraint(previous, current) {
  const contextPhases = ["shared", "execute", "repair", "review"];
  const toolPhases = ["execute", "repair", "review"];
  if (
    previous?.risk !== "high" ||
    !["low", "medium"].includes(current?.risk) ||
    !removesOnly(previous.allowed_paths, current.allowed_paths) ||
    !retainsInOrder(previous.gates, current.gates) ||
    !Number.isInteger(current.attempt_limit) ||
    current.attempt_limit > previous.attempt_limit ||
    !contextPhases.every((phase) => removesOnly(previous.context?.[phase], current.context?.[phase])) ||
    !toolPhases.every((phase) => removesOnly(previous.tool_grants?.[phase], current.tool_grants?.[phase]))
  ) return false;
  const expected = {
    ...previous,
    status: current.status,
    risk: current.risk,
    context: current.context,
    allowed_paths: current.allowed_paths,
    gates: current.gates,
    tool_grants: current.tool_grants,
    attempt_limit: current.attempt_limit,
  };
  return sameValues(expected, current);
}

function assertGateEvidence(gates, gateIds, results, label) {
  if (!Array.isArray(results) || results.length !== gateIds.length) {
    throw new AutopilotError(`${label} does not contain one result per required gate`, {
      code: "GATE_EVIDENCE_INVALID",
    });
  }
  for (const [index, gateId] of gateIds.entries()) {
    const gate = gates.gates?.[gateId];
    const result = results[index];
    if (
      !gate ||
      result?.gate_id !== gateId ||
      result?.success !== true ||
      result?.gate_definition_sha256 !== gateDefinitionSha256(gate)
    ) {
      throw new AutopilotError(`${label} differs from the current fixed definition for gate ${gateId}`, {
        code: "GATE_EVIDENCE_INVALID",
      });
    }
  }
}

const POLICY_ERROR_CODES = new Set([
  "ARCHIVE_REFERENCE",
  "CANDIDATE_DIFF_MISMATCH",
  "COMMIT_FAILED",
  "COMPLETION_CONFLICT",
  "COMPLETED_EVIDENCE_INVALID",
  "CONTEXT_CAP_EXCEEDED",
  "CONTROL_DIRECTORY_UNSAFE",
  "CONTRACT_INVALID",
  "CONTRACT_SECRET",
  "CREDENTIAL_FILE_MISSING",
  "CREDENTIAL_FILE_UNSAFE",
  "CREDENTIAL_GATE_DENIED",
  "CREDENTIAL_INPUT_CHANGED",
  "CREDENTIAL_VALUE_TOO_SHORT",
  "CREDENTIAL_VALUE_TOO_LARGE",
  "CREDENTIAL_VARIABLE_DENIED",
  "DIRTY_WORKTREE",
  "EMPTY_CREDENTIAL_ALLOWLIST",
  "EXECUTABLE_UNTRUSTED",
  "EXECUTION_PATH_UNSAFE",
  "GIT_FAILED",
  "GIT_HEAD_CHANGED",
  "GIT_INDEX_CHANGED",
  "GIT_LAYOUT_UNSUPPORTED",
  "GIT_OUTPUT_TRUNCATED",
  "GIT_REQUIRED",
  "GIT_TOPLEVEL_MISMATCH",
  "GIT_TRANSACTION_CONFLICT",
  "GATE_CLEANUP_FAILED",
  "HIGH_RISK_APPROVAL_INVALID",
  "GATE_EVIDENCE_INVALID",
  "FINALIZATION_CONFLICT",
  "HARDLINK_DENIED",
  "IGNORED_PATH_MUTATION",
  "IMMUTABLE_JSON_CONFLICT",
  "IMMUTABLE_JSON_WRITE_FAILED",
  "INCONSISTENT_REVIEW",
  "INVALID_UTF8",
  "INVALID_ENV_FILE",
  "INVALID_GATE",
  "LOCK_INTEGRITY",
  "MODE_INTENT_INVALID",
  "NO_ALLOWED_CREDENTIALS",
  "OPENCODE_AGENT_MISSING",
  "OPENCODE_CLEANUP_FAILED",
  "OPENCODE_OUTPUT_TRUNCATED",
  "OPENCODE_SESSION_ID_MISSING",
  "OPENCODE_SESSION_ID_INVALID",
  "OPENCODE_TEMP_UNSAFE",
  "PATH_ESCAPE",
  "PATH_POLICY_VIOLATION",
  "PROJECT_INVALID",
  "PROCESS_LIMIT_INVALID",
  "QUEUE_CAP_EXCEEDED",
  "REALPATH_ESCAPE",
  "REVIEW_EVIDENCE_TOO_LARGE",
  "REVIEW_EVIDENCE_UNSUPPORTED",
  "SECRET_SCAN_FAILED",
  "SENSITIVE_CONTEXT_REFERENCE",
  "SESSION_REUSE_DENIED",
  "SESSION_REUSE_DETECTED",
  "STATE_CAPACITY_EXHAUSTED",
  "STAGED_PATH_VIOLATION",
  "STATE_CAP_EXCEEDED",
  "UNKNOWN_CREDENTIAL_PROFILE",
  "UNKNOWN_GATE",
  "UNSAFE_CHANGED_FILE_TYPE",
  "UNTRUSTED_PHASE_MUTATION",
]);

function isPolicyFailure(error) {
  return POLICY_ERROR_CODES.has(error?.code);
}

async function bestEffortAuxiliary(label, operation) {
  try {
    if (
      process.env.NODE_ENV === "test" &&
      String(process.env.AUTOPILOT_TEST_FAIL_AUXILIARY ?? "")
        .split(",")
        .map((item) => item.trim())
        .includes(label)
    ) {
      throw Object.assign(new Error(`Injected ${label} failure`), { code: "EIO" });
    }
    return await operation();
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? ` (${error.code})`
      : "";
    try { process.stderr.write(`Autopilot warning: ${label} could not be updated${code}; canonical state is preserved.\n`); }
    catch {}
    return null;
  }
}

function blockerFrom(error, kind = "runtime") {
  return {
    kind,
    message: error instanceof Error ? error.message : String(error),
    required_action: "Inspect the bounded checkpoint, correct the underlying issue, and do not paste secret values into chat or project files.",
    resume_condition: "The project validates cleanly and the explicit resume command is run.",
  };
}

function failureEvidence(error) {
  return {
    code: error?.code ?? "ERROR",
    message: error?.message ?? String(error),
    details: error?.details ?? null,
  };
}

function conciseFailureEvidence(error) {
  const evidence = failureEvidence(error);
  return {
    message: evidence.message,
    code: evidence.code,
  };
}

function reviewerGateProjection(results) {
  return results.map(({ gate_id, success, code }) => ({ gate_id, success, code }));
}

function boundedRecoveryEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  if (Buffer.byteLength(serialized, "utf8") <= 12 * 1024) return evidence;
  return {
    truncated: true,
    excerpt: truncateUtf8(serialized, 6 * 1024),
  };
}

async function runWithPostflight(operation, protectedBarrier, checks) {
  let result;
  let primary = null;
  try {
    result = await operation();
  } catch (error) {
    primary = error;
  }

  try {
    await protectedBarrier();
  } catch (error) {
    if (primary && typeof error === "object") {
      error.details = {
        primary_phase_failure: failureEvidence(primary),
        protected_postflight: error.details ?? null,
      };
    }
    throw error;
  }

  const postflightFailures = [];
  for (const check of checks) {
    try {
      await check();
    } catch (error) {
      postflightFailures.push(error);
    }
  }
  if (primary) {
    if (postflightFailures.length > 0 && typeof primary === "object") {
      primary.details = {
        primary: primary.details ?? null,
        postflight: postflightFailures.map(failureEvidence),
      };
    }
    throw primary;
  }
  if (postflightFailures.length > 0) {
    const [first, ...additional] = postflightFailures;
    if (additional.length > 0 && typeof first === "object") {
      first.details = {
        primary: first.details ?? null,
        additional_postflight: additional.map(failureEvidence),
      };
    }
    throw first;
  }
  return result;
}

async function protectedSnapshot(project, { durableOnly = false } = {}) {
  return (await protectedSnapshotRecord(project, { durableOnly })).sha256;
}

async function protectedSnapshotRecord(project, { durableOnly = false } = {}) {
  const entries = [];
  const phaseRoots = [
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".ignore",
    "opencode.json",
    "opencode.jsonc",
    ".project",
    ".opencode",
    ".agents",
    "blueprints",
    ".autopilot/config.json",
    ".autopilot/state.json",
    ".autopilot/credentials.json",
    ".autopilot/bin",
    ".autopilot/blocker.md",
    ".git/HEAD",
    ".git/index",
    ".git/config",
    ".git/config.worktree",
    ".git/commondir",
    ".git/packed-refs",
    ".git/shallow",
    ".git/info/attributes",
    ".git/info/exclude",
    ".git/info/grafts",
    ".git/objects/info/alternates",
    ".git/refs/replace",
    ".git/autopilot-controller.lock",
  ];
  const durableRoots = [
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".ignore",
    "opencode.json",
    "opencode.jsonc",
    ".project",
    ".opencode",
    ".agents",
    "blueprints",
    ".autopilot/config.json",
    ".autopilot/bin",
  ];
  const roots = durableOnly ? durableRoots : phaseRoots;
  const skipped = new Set([
    normalizeRelative(project.relative.queue),
  ]);
  const receiptPrefix = `${normalizeRelative(project.relative.receipts).replace(/\/$/, "")}/`;
  const visit = async (absolute, relative) => {
    const normalized = normalizeRelative(relative);
    if (durableOnly && (skipped.has(normalized) || normalized.startsWith(receiptPrefix))) return;
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new AutopilotError(`Protected control path cannot be a symbolic link: ${relative}`, {
        code: "PATH_POLICY_VIOLATION",
      });
    }
    const real = await assertRealInside(project.root, absolute, `protected path ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        await visit(path.join(absolute, name), `${relative}/${name}`);
      }
      return;
    }
    if (!info.isFile() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Protected control path must be a private regular file: ${relative}`, {
        code: Number(info.nlink) > 1 ? "HARDLINK_DENIED" : "PATH_POLICY_VIOLATION",
      });
    }
    entries.push(
      durableOnly
        ? `file:${normalized}:${sha256(await readFile(real))}`
        : `file:${normalized}:${info.mode}:${sha256(await readFile(real))}`,
    );
  };
  for (const relative of roots) await visit(path.resolve(project.root, relative), relative);
  if (!durableOnly) {
    for (const [label, directory] of [
      ["runtime", project.paths.runtime],
      ["artifacts", project.paths.artifacts],
    ]) {
      const identity = await assertPrivateDirectory(project.root, directory, `${label} directory`);
      entries.push(`mutable-dir:${label}:${identity.dev}:${identity.ino}:${identity.mode}`);
    }
  }
  entries.sort();
  return { sha256: sha256(entries.join("\n")), entries };
}

async function assertProtectedUnchanged(project, before) {
  const after = await protectedSnapshotRecord(project);
  const expectedHash = typeof before === "string" ? before : before.sha256;
  if (after.sha256 !== expectedHash) {
    const details = typeof before === "string" ? null : changedSnapshotEntries(before.entries, after.entries);
    const suffix = details?.length ? `: ${details.slice(0, 8).join(", ")}` : "";
    throw new AutopilotError(`A fresh agent session modified protected control/project files${suffix}`, {
      code: "PATH_POLICY_VIOLATION",
      details: details ? { changed_paths: details } : null,
    });
  }
}

function changedSnapshotEntries(before, after) {
  const key = (entry) => {
    const parts = entry.split(":");
    return parts[0] === "file" ? `${parts[0]}:${parts[1]}` : `${parts[0]}:${parts[1]}`;
  };
  const left = new Map(before.map((entry) => [key(entry), entry]));
  const right = new Map(after.map((entry) => [key(entry), entry]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((item) => left.get(item) !== right.get(item))
    .map((item) => item.replace(/^[^:]+:/, ""))
    .sort();
}

const ABSENT_MODE_INTENT_SHA256 = sha256("autopilot-mode-intent-absent-v1");

function canonicalModeIntentContract(taskId, attempt, intents) {
  return {
    schema_version: 1,
    task_id: taskId,
    attempt,
    intents: [...intents]
      .map((intent) => ({ path: normalizeRelative(intent.path), executable: intent.executable }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
}

async function modeIntentSnapshot(project, taskId, attempt, allowedPaths) {
  const document = await readModeIntent(project);
  if (document === null) {
    return { present: false, sha256: ABSENT_MODE_INTENT_SHA256, intents: [] };
  }
  assertNoIssues(validateModeIntentContract(document.value, { taskId, attempt }), "Mode intent contract");
  const canonical = canonicalModeIntentContract(taskId, attempt, document.value.intents);
  const canonicalText = `${JSON.stringify(canonical, null, 2)}\n`;
  if (document.text !== canonicalText || canonical.intents.length === 0) {
    throw new AutopilotError("Mode intent contract must be canonical and non-empty", {
      code: "MODE_INTENT_INVALID",
    });
  }
  validateChangedPaths(canonical.intents.map((intent) => intent.path), allowedPaths);
  return { present: true, sha256: sha256(canonicalText), intents: canonical.intents };
}

async function assertModeIntentSnapshotUnchanged(project, taskId, attempt, task, expected, phase) {
  const actual = await modeIntentSnapshot(project, taskId, attempt, task.allowed_paths);
  if (
    actual.present !== expected.present || actual.sha256 !== expected.sha256 ||
    stableJson(actual.intents) !== stableJson(expected.intents)
  ) {
    throw new AutopilotError(`${phase} mutated executable mode intent`, {
      code: "UNTRUSTED_PHASE_MUTATION",
    });
  }
}

async function assertTaskDiffUnchanged(
  project,
  baseline,
  expectedFiles,
  expectedHash,
  task,
  candidate,
  modeSnapshot,
  phase,
) {
  await assertHeadAndIndex(project, baseline);
  await assertModeIntentSnapshotUnchanged(
    project,
    candidate.task_id,
    candidate.attempt,
    task,
    modeSnapshot,
    phase,
  );
  const actualFiles = await taskChangedFiles(project, baseline, { modeIntents: modeSnapshot.intents });
  validateChangedPaths(actualFiles, task.allowed_paths);
  assertCandidateFiles(candidate.changed_files, actualFiles);
  await assertSafeChangedFiles(project, baseline, actualFiles);
  await assertModeIntentTransitions(project, baseline, modeSnapshot.intents, actualFiles);
  const actualHash = await gitDiffHash(project, baseline, actualFiles, { modeIntents: modeSnapshot.intents });
  if (stableJson(actualFiles) !== stableJson(expectedFiles) || actualHash !== expectedHash) {
    throw new AutopilotError(`${phase} mutated the candidate worktree`, {
      code: "UNTRUSTED_PHASE_MUTATION",
      details: { expected_files: expectedFiles, actual_files: actualFiles },
    });
  }
}

export class Controller {
  constructor(root, { once = false, resumeRequested = false } = {}) {
    this.root = root;
    this.once = once;
    this.resumeRequested = resumeRequested;
    this.project = null;
    this.state = null;
    this.queue = null;
    this.gates = null;
    this.manifest = null;
    this.credentials = null;
    this.lock = null;
    this.shutdownRequested = false;
    this.openCodeCommandPreflight = null;
  }

  async initialize() {
    await preflightProjectRoot(this.root);
    this.project = await loadProject(this.root);
    await assertControlTopology(this.project, { createMutable: true });
    await assertPrivateDirectory(this.root, path.dirname(this.project.paths.lock), "Git lock directory");
    this.lock = await acquireLock(this.project.paths.lock, {
      pid: process.pid,
      started_at: nowIso(),
      root: this.root,
    });
    await sweepStaleGateRuntimes(this.project);
    await sweepStaleOpenCodeRuntimes(this.project);
    this.state = await loadState(this.project);
    await assertGitRepository(this.root);
    try {
      // Inspect the index before byte-level framework validation so hidden
      // assume-unchanged/skip-worktree flags receive the precise actionable
      // blocker instead of being misreported as ordinary managed-file drift.
      await assertHeadAndIndex(this.project, await gitHead(this.root));
    } catch (error) {
      if (error?.code !== "GIT_INDEX_CHANGED") throw error;
      const blocker = blockerFrom(error, "policy_violation");
      this.state = await writeState(this.project, this.state, {
        status: "human_required",
        phase: "blocked",
        pid: null,
        blocker,
      });
      await bestEffortAuxiliary("human blocker artifact", () => writeBlocker(this.project, blocker));
      await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(this.project, this.state, error.message));
      return false;
    }
    const validation = await validateProject(this.root, { strict: true });
    if (!validation.ok) {
      throw new AutopilotError(
        `Strict project validation failed:\n${validation.issues.map((item) => `- ${item.location}: ${item.message}`).join("\n")}`,
        { code: "PROJECT_INVALID", details: validation.issues },
      );
    }
    const contracts = await loadContracts(this.project);
    this.queue = contracts.queue;
    this.gates = contracts.gates;
    this.manifest = contracts.manifest;
    this.credentials = contracts.credentials;
    this.state = contracts.state;
    if (!this.state.active_task && !this.state.completion) {
      await clearModeIntent(this.project);
    }

    // A plain `start` must never advance a durable transaction while a pause or
    // human boundary is active. Only the explicit `resume` verb authorizes
    // recovery past that boundary.
    if (!this.resumeRequested && await pauseRequested(this.project)) {
      this.state = await writeState(this.project, this.state, {
        status: "paused",
        phase: (await exists(this.project.paths.stop)) ? "stopped" : "paused",
        pid: null,
      });
      await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
        this.project,
        this.state,
        "A STOP or PAUSED sentinel is present.",
      ));
      return false;
    }
    if (!this.resumeRequested && await maintenanceRequested(this.project)) {
      this.state = await writeState(this.project, this.state, {
        status: "paused",
        phase: "maintenance",
        pid: null,
      });
      await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
        this.project,
        this.state,
        "Control Plane maintenance is requested.",
      ));
      return false;
    }
    if (!this.resumeRequested && ["paused", "human_required"].includes(this.state.status)) {
      throw new AutopilotError(`Run is ${this.state.status}; use the explicit resume command after resolving the blocker`, {
        code: "RESUME_REQUIRED",
      });
    }

    if (this.state.completion) {
      await this.finishCompletion();
    }
    if (this.state.finalization) {
      await this.finishFinalization();
    }

    const queueRelative = normalizeRelative(path.relative(this.root, this.project.paths.queue));
    const queueCompletionCommitted = !(await gitStatus(this.root))
      .some((entry) => entry.file === queueRelative);
    if (
      allDone(this.queue) &&
      this.queue.project_status === "complete" &&
      queueCompletionCommitted
    ) {
      await this.assertCompletedProjectEvidence();
      if (this.state.status !== "complete" || this.state.phase !== "complete") {
        this.state = await writeState(this.project, this.state, {
          status: "complete",
          phase: "complete",
          pid: null,
          active_task: null,
          attempt: 0,
          baseline_head: null,
          blocker: null,
          completion: null,
          finalization: null,
        });
      }
      if (this.resumeRequested) {
        await Promise.all([
          rm(this.project.paths.stop, { force: true }),
          rm(this.project.paths.paused, { force: true }),
          rm(this.project.paths.maintenance, { force: true }),
          rm(this.project.paths.blocker, { force: true }),
        ]);
      }
      return false;
    }

    if (
      this.state.status === "complete" &&
      allDone(this.queue) &&
      this.queue.project_status === "complete" &&
      queueCompletionCommitted
    ) return false;
    let approvedHighRiskBaseline = null;
    if (
      this.resumeRequested &&
      this.state.status === "human_required" &&
      this.state.blocker?.kind === "high_risk_task"
    ) {
      const taskId = this.state.active_task;
      if (!taskId || !["low", "medium"].includes(this.queue.tasks[taskId]?.risk)) {
        throw new AutopilotError(
          "The high-risk boundary is unresolved; commit the exact queue-only approval transition before resuming",
          { code: "HIGH_RISK_APPROVAL_REQUIRED" },
        );
      }
      approvedHighRiskBaseline = await this.assertHighRiskApprovalTransition(taskId);
    }
    if (this.project.config.git.require_clean_start && !this.state.active_task) {
      await assertCleanStart(this.project);
    }
    if (this.resumeRequested) {
      await Promise.all([
        rm(this.project.paths.stop, { force: true }),
        rm(this.project.paths.paused, { force: true }),
        ...(!this.state.active_task ? [rm(this.project.paths.maintenance, { force: true })] : []),
      ]);
    }
    const continuing = Boolean(this.state.run_id && this.state.status === "running");
    const carriedSessions = this.state.active_task && this.state.last_session
      ? [this.state.last_session]
      : [];
    const id = continuing ? this.state.run_id : runId();
    this.state = await writeState(this.project, this.state, {
      run_id: id,
      status: "running",
      phase: this.state.active_task ? "recovering" : "selecting",
      pid: process.pid,
      started_at: continuing ? (this.state.started_at ?? nowIso()) : nowIso(),
      session_ids: continuing ? (this.state.session_ids ?? []) : carriedSessions,
      completed_in_run: continuing ? Number(this.state.completed_in_run ?? 0) : 0,
      ...(approvedHighRiskBaseline ? {
        baseline_head: approvedHighRiskBaseline,
        attempt: 0,
        no_progress_count: 0,
        last_progress_hash: null,
        last_failure_fingerprint: null,
        last_failure_evidence: null,
        last_session: null,
        session_ids: [],
        task_tool_usage: {},
      } : {}),
      blocker: null,
    });
    if (this.resumeRequested) await rm(this.project.paths.blocker, { force: true });
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
      this.project,
      this.state,
      "Controller acquired the exclusive lock.",
    ));
    return true;
  }

  async assertHighRiskApprovalTransition(taskId) {
    await assertCleanStart(this.project);
    const queueRelative = normalizeRelative(path.relative(this.root, this.project.paths.queue));
    const dirtyQueue = (await gitStatus(this.root)).find((entry) => entry.file === queueRelative);
    if (dirtyQueue) {
      throw new AutopilotError("High-risk approval must commit the exact approved queue transition", {
        code: "HIGH_RISK_APPROVAL_INVALID",
        details: { dirty_queue: dirtyQueue },
      });
    }

    const baseline = this.state.baseline_head;
    const head = await gitHead(this.root);
    if (!baseline || baseline === head) {
      throw new AutopilotError("High-risk approval must advance the preserved task baseline", {
        code: "HIGH_RISK_APPROVAL_INVALID",
        details: { baseline, head },
      });
    }
    try {
      const [baselineTree, resultTree] = await Promise.all([
        gitTree(this.root, baseline),
        gitTree(this.root, head),
      ]);
      await verifyCommitTransition(this.project, {
        baselineCommit: baseline,
        resultCommit: head,
        expectedFiles: [queueRelative],
        baselineTree,
        resultTree,
        diffSha256: canonicalTreeTransitionHash(baselineTree, resultTree),
      });
    } catch (error) {
      throw new AutopilotError("High-risk approval must be one queue-only, non-merge commit directly after the preserved baseline", {
        code: "HIGH_RISK_APPROVAL_INVALID",
        details: { cause: error.message },
      });
    }

    let previous;
    try {
      previous = JSON.parse(await readRevisionFile(
        this.root,
        baseline,
        queueRelative,
        this.project.caps.queue,
      ));
    } catch (error) {
      if (error instanceof AutopilotError) throw error;
      throw new AutopilotError("Preserved high-risk baseline does not contain a valid task queue", {
        code: "HIGH_RISK_APPROVAL_INVALID",
      });
    }
    const previousTask = previous.tasks?.[taskId];
    const approvedTask = this.queue.tasks?.[taskId];
    if (!isMonotonicHighRiskConstraint(previousTask, approvedTask)) {
      throw new AutopilotError("High-risk approval may only narrow the active task and change its risk to low or medium", {
        code: "HIGH_RISK_APPROVAL_INVALID",
      });
    }

    const projected = JSON.parse(JSON.stringify(previous));
    const done = new Set(Object.entries(projected.tasks ?? {})
      .filter(([, task]) => task.status === "done")
      .map(([id]) => id));
    let readinessChanged = false;
    for (const task of Object.values(projected.tasks ?? {})) {
      if (task.status === "pending" && (task.depends_on ?? []).every((id) => done.has(id))) {
        task.status = "ready";
        readinessChanged = true;
      }
    }
    if (readinessChanged) projected.revision = Number(projected.revision ?? 0) + 1;
    if (!projected.tasks?.[taskId] || projected.tasks[taskId].status !== "ready") {
      throw new AutopilotError("Preserved high-risk task was not the controller's ready task", {
        code: "HIGH_RISK_APPROVAL_INVALID",
      });
    }
    projected.tasks[taskId] = { ...approvedTask, status: "in_progress" };
    projected.project_status = "running";
    projected.revision = Number(projected.revision ?? 0) + 1;
    const claimedProjection = JSON.parse(JSON.stringify(projected));
    projected.tasks[taskId].status = "blocked";
    projected.project_status = "blocked";
    projected.revision = Number(projected.revision ?? 0) + 1;

    if (![claimedProjection, projected].some((expected) => sameValues(expected, this.queue))) {
      throw new AutopilotError("Committed high-risk queue differs from the exact controller metadata and risk approval transition", {
        code: "HIGH_RISK_APPROVAL_INVALID",
      });
    }
    return head;
  }

  budgetExceeded() {
    const elapsed = Date.now() - Date.parse(this.state.started_at ?? nowIso());
    return (
      Number(this.state.completed_in_run ?? 0) >= this.project.config.budgets.max_tasks_per_run ||
      elapsed >= this.project.config.budgets.max_elapsed_minutes * 60_000
    );
  }

  sessionLedgerNeedsRollover(reservedEntries = 1) {
    const sessionIds = this.state.session_ids ?? [];
    const projected = {
      ...this.state,
      session_ids: [
        ...sessionIds,
        ...Array.from({ length: reservedEntries }, (_, index) => `reserved-${index}-${"s".repeat(240)}`),
      ],
    };
    return (
      sessionIds.length + reservedEntries > SESSION_LEDGER_ROLLOVER_ENTRIES ||
      Buffer.byteLength(JSON.stringify(projected, null, 2), "utf8") > SESSION_LEDGER_ROLLOVER_BYTES
    );
  }

  async ensureSessionCapacity(reservedEntries = 1) {
    if (this.sessionLedgerNeedsRollover(reservedEntries)) await this.rolloverBudget();
    if (this.sessionLedgerNeedsRollover(reservedEntries)) {
      throw new AutopilotError("Controller state is too large to reserve another fresh-session ledger entry", {
        code: "STATE_CAPACITY_EXHAUSTED",
      });
    }
  }

  async pauseAtBoundary(reason) {
    if (!this.shutdownRequested && !(await pauseRequested(this.project))) return false;
    await this.checkpointPause(reason);
    return true;
  }

  async rolloverAtBoundary() {
    if (this.budgetExceeded()) await this.rolloverBudget();
  }

  async rolloverBudget() {
    const carriedSessions = this.state.active_task && this.state.last_session
      ? [this.state.last_session]
      : [];
    this.state = await writeState(this.project, this.state, {
      run_id: runId(),
      started_at: nowIso(),
      session_ids: carriedSessions,
      completed_in_run: 0,
      phase: this.state.active_task ? "recovering" : "selecting",
    });
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
      this.project,
      this.state,
      "Automatic controller cycle rollover at a safe boundary; autonomous work continues.",
    ));
  }

  async checkpointPause(reason) {
    this.state = await writeState(this.project, this.state, {
      status: "paused",
      phase: (await exists(this.project.paths.stop)) ? "stopped" : "paused",
      pid: null,
      blocker: { kind: "pause", message: reason },
    });
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(this.project, this.state, reason));
  }

  async humanRequired(blocker, taskId = this.state.active_task) {
    this.state = await writeState(this.project, this.state, {
      status: "human_required",
      phase: "blocked",
      pid: null,
      blocker,
    });
    if (
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_human_required_state"
    ) process.exit(90);
    if (taskId && this.queue.tasks[taskId]) {
      this.queue.tasks[taskId].status = "blocked";
      this.queue.project_status = "blocked";
      const writtenQueue = await bestEffortAuxiliary("blocked queue projection", () => writeQueue(this.project, this.queue));
      if (writtenQueue) this.queue = writtenQueue;
    }
    await bestEffortAuxiliary("human blocker artifact", () => writeBlocker(this.project, blocker));
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(this.project, this.state, blocker.message));
  }

  async recordFailure(error, progressHash, fingerprint, task, baseline, evidence) {
    const same =
      this.state.last_progress_hash === progressHash &&
      this.state.last_failure_fingerprint === fingerprint;
    const noProgress = same ? Number(this.state.no_progress_count ?? 0) + 1 : 0;
    this.state = await writeState(this.project, this.state, {
      phase: "repairing",
      last_progress_hash: progressHash,
      last_failure_fingerprint: fingerprint,
      last_failure_evidence: boundedRecoveryEvidence(evidence),
      no_progress_count: noProgress,
      baseline_head: baseline,
    });
    if (
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_failure_record"
    ) process.exit(88);
    const attemptLimit = Math.min(task.attempt_limit, this.project.config.budgets.max_attempts_per_task);
    if (
      this.state.attempt >= attemptLimit ||
      noProgress >= this.project.config.budgets.max_no_progress
    ) {
      await this.humanRequired({
        ...blockerFrom(error, "repair_exhausted"),
        message: `Repair stopped after attempt ${this.state.attempt}: ${error.message}`,
      });
      return { stop: true, evidence };
    }
    return { stop: false, evidence };
  }

  async completeTask(taskId, task, baseline, files, diffHash, gateResult, review, acceptedModeSnapshot) {
    if (this.state.completion) {
      throw new AutopilotError("A different completion transaction is already active", {
        code: "COMPLETION_CONFLICT",
      });
    }
    await assertHeadAndIndex(this.project, baseline);
    await assertModeIntentSnapshotUnchanged(
      this.project,
      taskId,
      this.state.attempt,
      task,
      acceptedModeSnapshot,
      "Completion acceptance",
    );
    const actualFiles = await taskChangedFiles(this.project, baseline, {
      modeIntents: acceptedModeSnapshot.intents,
    });
    validateChangedPaths(actualFiles, task.allowed_paths);
    assertCandidateFiles(files, actualFiles);
    await assertSafeChangedFiles(this.project, baseline, actualFiles);
    await assertModeIntentTransitions(this.project, baseline, acceptedModeSnapshot.intents, actualFiles);
    const actualEvidenceHash = await gitDiffHash(this.project, baseline, actualFiles, {
      modeIntents: acceptedModeSnapshot.intents,
    });
    if (actualEvidenceHash !== diffHash) {
      throw new AutopilotError("Candidate evidence changed before completion acceptance", {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    assertGateEvidence(this.gates, task.gates, gateResult.results, "Accepted task gate evidence");

    const receiptFile = path.join(this.project.paths.receipts, `${taskId}.json`);
    if (await exists(receiptFile)) {
      throw new AutopilotError(`Immutable receipt already exists for incomplete task ${taskId}`, {
        code: "IMMUTABLE_JSON_CONFLICT",
      });
    }
    const specText = await readUtf8(path.resolve(this.root, task.spec));
    const plannedQueue = plannedTaskCompletionQueue(this.queue, taskId);
    const completion = {
      schema_version: 1,
      step: "accepted",
      run_id: this.state.run_id,
      task_id: taskId,
      attempt: this.state.attempt,
      task_sha256: taskEvidenceHash(taskId, task),
      spec_sha256: sha256(specText),
      baseline_commit: baseline,
      accepted_evidence_sha256: diffHash,
      control_sha256: await protectedSnapshot(this.project, { durableOnly: true }),
      accepted_queue_sha256: sha256(stableJson(this.queue)),
      planned_queue_sha256: sha256(stableJson(plannedQueue)),
      planned_queue_file_sha256: jsonDocumentSha256(plannedQueue),
      changed_files: [...files],
      mode_intent_present: acceptedModeSnapshot.present,
      mode_intent_sha256: acceptedModeSnapshot.sha256,
      mode_intents: acceptedModeSnapshot.intents,
      gates: gateResult.results,
      review,
      tool_usage: this.state.task_tool_usage ?? {},
      completed_at: nowIso(),
      application: null,
      metadata: null,
    };
    this.state = await writeState(this.project, this.state, {
      phase: "completion_accepted",
      completion,
    });
    await this.finishCompletion();
  }

  async assertCompletionContract(completion) {
    if (!completion || completion.schema_version !== 1 || !completion.task_id) {
      throw new AutopilotError("Completion journal is malformed", { code: "COMPLETION_CONFLICT" });
    }
    if (this.state.active_task !== completion.task_id || this.state.run_id !== completion.run_id) {
      throw new AutopilotError("Completion journal does not match the active controller task/run", {
        code: "COMPLETION_CONFLICT",
      });
    }
    const queueSha256 = sha256(stableJson(this.queue));
    if (![completion.accepted_queue_sha256, completion.planned_queue_sha256].includes(queueSha256)) {
      throw new AutopilotError("Project queue changed outside the persisted completion transition", {
        code: "COMPLETION_CONFLICT",
      });
    }
    if (
      !/^[0-9a-f]{64}$/.test(completion.planned_queue_file_sha256 ?? "") ||
      (queueSha256 === completion.planned_queue_sha256 &&
        jsonDocumentSha256(this.queue) !== completion.planned_queue_file_sha256)
    ) {
      throw new AutopilotError("Planned queue bytes differ from the persisted completion transition", {
        code: "COMPLETION_CONFLICT",
      });
    }
    assertNoIssues(validateTaskToolUsage(completion.tool_usage, {
      location: "completion.tool_usage",
      taskId: completion.task_id,
    }), "Completion tool usage");
    if (stableJson(completion.tool_usage) !== stableJson(this.state.task_tool_usage ?? {})) {
      throw new AutopilotError("Completion tool usage differs from the active task ledger", {
        code: "COMPLETION_CONFLICT",
      });
    }
    const task = this.queue.tasks?.[completion.task_id];
    if (!task || taskEvidenceHash(completion.task_id, task) !== completion.task_sha256) {
      throw new AutopilotError("Task contract changed after completion acceptance", {
        code: "COMPLETION_CONFLICT",
      });
    }
    const specText = await readUtf8(path.resolve(this.root, task.spec));
    if (sha256(specText) !== completion.spec_sha256) {
      throw new AutopilotError("Task specification changed after completion acceptance", {
        code: "COMPLETION_CONFLICT",
      });
    }
    if (completion.baseline_commit !== this.state.baseline_head) {
      throw new AutopilotError("Completion baseline differs from controller state", {
        code: "COMPLETION_CONFLICT",
      });
    }
    assertNoIssues(validateModeIntentContract({
      schema_version: 1,
      task_id: completion.task_id,
      attempt: completion.attempt,
      intents: completion.mode_intents,
    }, {
      location: "completion.mode_intents",
      taskId: completion.task_id,
      attempt: completion.attempt,
    }), "Completion mode intents");
    const currentModeSnapshot = await modeIntentSnapshot(
      this.project,
      completion.task_id,
      completion.attempt,
      task.allowed_paths,
    );
    if (
      currentModeSnapshot.present !== completion.mode_intent_present ||
      currentModeSnapshot.sha256 !== completion.mode_intent_sha256 ||
      stableJson(currentModeSnapshot.intents) !== stableJson(completion.mode_intents)
    ) {
      throw new AutopilotError("Executable mode intent changed after completion acceptance", {
        code: "COMPLETION_CONFLICT",
      });
    }
    const currentControlHash = await protectedSnapshot(this.project, { durableOnly: true });
    if (currentControlHash !== completion.control_sha256) {
      throw new AutopilotError("Durable control-plane files changed after completion acceptance", {
        code: "COMPLETION_CONFLICT",
      });
    }
    assertGateEvidence(this.gates, task.gates, completion.gates, "Persisted task gate evidence");
    return { ...task, id: completion.task_id };
  }

  async assertReceiptFileSafe(receiptFile) {
    const info = await lstat(receiptFile);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError("A receipt must be a private regular file, never a link", {
        code: "IMMUTABLE_JSON_CONFLICT",
      });
    }
    await assertRealInside(this.root, receiptFile, "receipt");
  }

  async finishCompletion() {
    let completion = this.state.completion;
    const task = await this.assertCompletionContract(completion);
    const taskId = completion.task_id;
    const prefix = this.project.config.git.commit_prefix;
    const applicationMessage = `${prefix}: ${taskId} ${task.title}`;

    if (!completion.application) {
      const head = await gitHead(this.root);
      if (head !== completion.baseline_commit) {
        throw new AutopilotError("HEAD advanced without a persisted application commit plan", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      const actualFiles = await taskChangedFiles(this.project, completion.baseline_commit, {
        modeIntents: completion.mode_intents,
      });
      validateChangedPaths(actualFiles, task.allowed_paths);
      assertCandidateFiles(completion.changed_files, actualFiles);
      await assertSafeChangedFiles(this.project, completion.baseline_commit, actualFiles);
      await assertModeIntentTransitions(
        this.project,
        completion.baseline_commit,
        completion.mode_intents,
        actualFiles,
      );
      const evidenceHash = await gitDiffHash(this.project, completion.baseline_commit, actualFiles, {
        modeIntents: completion.mode_intents,
      });
      if (evidenceHash !== completion.accepted_evidence_sha256) {
        throw new AutopilotError("Worktree changed after completion acceptance", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }

      const prepared = await prepareCommitTree(
        this.project,
        completion.baseline_commit,
        completion.changed_files,
        { modeIntents: completion.mode_intents },
      );
      const postStageEvidenceHash = await gitDiffHash(
        this.project,
        completion.baseline_commit,
        completion.changed_files,
        { modeIntents: completion.mode_intents },
      );
      if (postStageEvidenceHash !== completion.accepted_evidence_sha256) {
        throw new AutopilotError("Working bytes changed while the application tree was prepared", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      let resultCommit = completion.baseline_commit;
      if (completion.changed_files.length > 0) {
        resultCommit = await createCommitObject(
          this.project,
          prepared.result_tree,
          completion.baseline_commit,
          applicationMessage,
        );
        await verifyCommitTransition(this.project, {
          baselineCommit: completion.baseline_commit,
          resultCommit,
          expectedFiles: completion.changed_files,
          baselineTree: prepared.baseline_tree,
          resultTree: prepared.result_tree,
          diffSha256: prepared.diff_sha256,
          modeIntents: completion.mode_intents,
        });
      }
      completion = {
        ...completion,
        step: "application_planned",
        application: {
          ...prepared,
          result_commit: resultCommit,
          message: applicationMessage,
        },
      };
      this.state = await writeState(this.project, this.state, {
        phase: "completion_application_planned",
        completion,
      });
    }

    completion = this.state.completion;
    const application = completion.application;
    const canonicalApplicationHash = canonicalTreeTransitionHash(
      application.baseline_tree,
      application.result_tree,
    );
    if (
      application.parent_commit !== completion.baseline_commit ||
      application.diff_sha256 !== canonicalApplicationHash
    ) {
      throw new AutopilotError("Persisted application commit plan is inconsistent", {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    if (completion.changed_files.length > 0) {
      await verifyCommitTransition(this.project, {
        baselineCommit: completion.baseline_commit,
        resultCommit: application.result_commit,
        expectedFiles: completion.changed_files,
        baselineTree: application.baseline_tree,
        resultTree: application.result_tree,
        diffSha256: application.diff_sha256,
        modeIntents: completion.mode_intents,
      });
    } else {
      const baselineTree = await gitTree(this.root, completion.baseline_commit);
      if (
        application.result_commit !== completion.baseline_commit ||
        baselineTree !== application.baseline_tree ||
        baselineTree !== application.result_tree
      ) {
        throw new AutopilotError("Empty application transaction changed Git history/tree", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
    }

    let head = await gitHead(this.root);
    let applicationMoved = false;
    if (head === completion.baseline_commit && application.result_commit !== completion.baseline_commit) {
      const actualFiles = await taskChangedFiles(this.project, completion.baseline_commit, {
        modeIntents: completion.mode_intents,
      });
      assertCandidateFiles(completion.changed_files, actualFiles);
      await assertSafeChangedFiles(this.project, completion.baseline_commit, actualFiles);
      await assertModeIntentTransitions(
        this.project,
        completion.baseline_commit,
        completion.mode_intents,
        actualFiles,
      );
      const evidenceHash = await gitDiffHash(this.project, completion.baseline_commit, actualFiles, {
        modeIntents: completion.mode_intents,
      });
      if (evidenceHash !== completion.accepted_evidence_sha256) {
        throw new AutopilotError("Worktree changed before application commit activation", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      const recoveredPlan = await prepareCommitTree(
        this.project,
        completion.baseline_commit,
        completion.changed_files,
        { modeIntents: completion.mode_intents },
      );
      if (!sameValues(recoveredPlan, {
        parent_commit: application.parent_commit,
        baseline_tree: application.baseline_tree,
        result_tree: application.result_tree,
        diff_sha256: application.diff_sha256,
      })) {
        throw new AutopilotError("Staged application tree differs from the persisted plan", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      await moveHead(
        this.project,
        completion.baseline_commit,
        application.result_commit,
        `autopilot application ${taskId}`,
      );
      head = application.result_commit;
      applicationMoved = true;
    }
    if (head !== application.result_commit) {
      throw new AutopilotError("HEAD is outside the persisted completion transaction", {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    await assertHeadAndIndex(this.project, application.result_commit);
    const postCommitFiles = await taskChangedFiles(this.project, application.result_commit, {
      modeIntents: completion.mode_intents,
    });
    if (postCommitFiles.length > 0) {
      throw new AutopilotError(`Application worktree differs from committed result: ${postCommitFiles.join(", ")}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    if (
      applicationMoved &&
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_app_commit"
    ) {
      process.exit(86);
    }

    if (completion.step === "application_planned") {
      completion = { ...completion, step: "application_committed" };
      this.state = await writeState(this.project, this.state, {
        phase: "completion_application_committed",
        completion,
      });
    }

    completion = this.state.completion;
    const receiptFile = path.join(this.project.paths.receipts, `${taskId}.json`);
    const receipt = {
      schema_version: 1,
      run_id: completion.run_id,
      task_id: taskId,
      task_sha256: completion.task_sha256,
      spec_sha256: completion.spec_sha256,
      baseline_commit: completion.baseline_commit,
      result_commit: application.result_commit,
      baseline_tree: application.baseline_tree,
      result_tree: application.result_tree,
      diff_sha256: application.diff_sha256,
      control_sha256: completion.control_sha256,
      accepted_queue_sha256: completion.accepted_queue_sha256,
      planned_queue_sha256: completion.planned_queue_sha256,
      planned_queue_file_sha256: completion.planned_queue_file_sha256,
      changed_files: completion.changed_files,
      mode_intents: completion.mode_intents,
      gates: completion.gates,
      review: completion.review,
      tool_usage: completion.tool_usage,
      completed_at: completion.completed_at,
    };
    await writeImmutableJson(receiptFile, receipt);
    await this.assertReceiptFileSafe(receiptFile);
    if (
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_receipt_write"
    ) process.exit(92);
    if (completion.step === "application_committed") {
      completion = { ...completion, step: "receipt_written" };
      this.state = await writeState(this.project, this.state, {
        phase: "completion_receipt_written",
        completion,
      });
    }

    const queueBeforeTransition = sha256(stableJson(this.queue));
    if (queueBeforeTransition === completion.accepted_queue_sha256) {
      this.queue = {
        ...this.queue,
        project_status: "running",
        tasks: {
          ...this.queue.tasks,
          [taskId]: { ...this.queue.tasks[taskId], status: "done" },
        },
      };
      this.queue = await writeQueue(this.project, this.queue);
    }
    if (sha256(stableJson(this.queue)) !== completion.planned_queue_sha256) {
      throw new AutopilotError("Project queue differs from the persisted completion plan", {
        code: "COMPLETION_CONFLICT",
      });
    }
    if (jsonDocumentSha256(this.queue) !== completion.planned_queue_file_sha256) {
      throw new AutopilotError("Project queue bytes differ from the persisted completion plan", {
        code: "COMPLETION_CONFLICT",
      });
    }
    if (
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_completion_queue_write"
    ) process.exit(93);

    completion = this.state.completion;
    if (sha256(stableJson(this.queue)) !== completion.planned_queue_sha256) {
      throw new AutopilotError("Project queue changed before completion metadata planning", {
        code: "COMPLETION_CONFLICT",
      });
    }
    const metadataFiles = [
      normalizeRelative(path.relative(this.root, this.project.paths.queue)),
      normalizeRelative(path.relative(this.root, receiptFile)),
    ];
    const expectedMetadataFileSha256 = {
      [metadataFiles[0]]: completion.planned_queue_file_sha256,
      [metadataFiles[1]]: jsonDocumentSha256(receipt),
    };
    const metadataMessage = `${prefix}: record ${taskId}`;
    if (!completion.metadata) {
      if (await gitHead(this.root) !== application.result_commit) {
        throw new AutopilotError("HEAD advanced without a persisted metadata commit plan", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      const prepared = await prepareCommitTree(this.project, application.result_commit, metadataFiles, {
        expectedFileSha256: expectedMetadataFileSha256,
        testRaceLabel: "task-metadata",
      });
      const resultCommit = await createCommitObject(
        this.project,
        prepared.result_tree,
        application.result_commit,
        metadataMessage,
      );
      await verifyCommitTransition(this.project, {
        baselineCommit: application.result_commit,
        resultCommit,
        expectedFiles: metadataFiles,
        baselineTree: prepared.baseline_tree,
        resultTree: prepared.result_tree,
        diffSha256: prepared.diff_sha256,
      });
      completion = {
        ...completion,
        step: "metadata_planned",
        metadata: {
          ...prepared,
          result_commit: resultCommit,
          message: metadataMessage,
          changed_files: metadataFiles,
          expected_file_sha256: expectedMetadataFileSha256,
        },
      };
      this.state = await writeState(this.project, this.state, {
        phase: "completion_metadata_planned",
        completion,
      });
    }

    completion = this.state.completion;
    const metadata = completion.metadata;
    if (!sameValues(metadata.expected_file_sha256, expectedMetadataFileSha256)) {
      throw new AutopilotError("Persisted completion metadata hashes differ from the exact queue/receipt bytes", {
        code: "COMPLETION_CONFLICT",
      });
    }
    await verifyCommitTransition(this.project, {
      baselineCommit: application.result_commit,
      resultCommit: metadata.result_commit,
      expectedFiles: metadata.changed_files,
      baselineTree: metadata.baseline_tree,
      resultTree: metadata.result_tree,
      diffSha256: metadata.diff_sha256,
    });
    head = await gitHead(this.root);
    if (head === application.result_commit) {
      const recoveredMetadata = await prepareCommitTree(
        this.project,
        application.result_commit,
        metadata.changed_files,
        {
          expectedFileSha256: metadata.expected_file_sha256,
          testRaceLabel: "task-metadata",
        },
      );
      await injectPostPrepareRaceForTest(
        this.project,
        "task-metadata",
        metadata.expected_file_sha256,
      );
      if (!sameValues(recoveredMetadata, {
        parent_commit: metadata.parent_commit,
        baseline_tree: metadata.baseline_tree,
        result_tree: metadata.result_tree,
        diff_sha256: metadata.diff_sha256,
      })) {
        throw new AutopilotError("Staged metadata tree differs from the persisted plan", {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      await moveHead(
        this.project,
        application.result_commit,
        metadata.result_commit,
        `autopilot metadata ${taskId}`,
      );
      head = metadata.result_commit;
    }
    if (head !== metadata.result_commit) {
      throw new AutopilotError("HEAD is outside the persisted metadata transaction", {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    await assertHeadAndIndex(this.project, metadata.result_commit);
    await assertFilesMatchTree(this.project, metadata.result_commit, metadataFiles);
    const finalTaskWorktree = await taskChangedFiles(this.project, metadata.result_commit);
    if (finalTaskWorktree.length > 0) {
      throw new AutopilotError(`Application changed during task metadata commit: ${finalTaskWorktree.join(", ")}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }

    this.state = await writeState(this.project, this.state, {
      phase: "task_complete",
      active_task: null,
      attempt: 0,
      baseline_head: null,
      no_progress_count: 0,
      last_progress_hash: null,
      last_failure_fingerprint: null,
      last_failure_evidence: null,
      last_session: null,
      task_tool_usage: {},
      completion: null,
      completed_in_run: Number(this.state.completed_in_run ?? 0) + 1,
      last_green: {
        task_id: taskId,
        result_commit: application.result_commit,
        checkpoint_commit: metadata.result_commit,
        receipt: normalizeRelative(path.relative(this.root, receiptFile)),
      },
    });
    if (
      process.env.NODE_ENV === "test" &&
      process.env.AUTOPILOT_TEST_CRASH_POINT === "after_task_complete_state"
    ) process.exit(94);
    await bestEffortAuxiliary("consumed mode intent", () => clearModeIntent(this.project));
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
      this.project,
      this.state,
      `${taskId} completed with green gates and independent approval.`,
    ));
  }

  async assertCompletedProjectEvidence() {
    const head = await gitHead(this.root);
    const queueRelative = normalizeRelative(path.relative(this.root, this.project.paths.queue));
    await assertFilesMatchTree(this.project, head, [queueRelative]);
    const objectId = /^[0-9a-f]{40,64}$/;
    const evidenceHash = /^[0-9a-f]{64}$/;

    for (const [taskId, task] of taskEntries(this.queue)) {
      if (task.status !== "done") {
        throw new AutopilotError(`Completed project contains unfinished task ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
      const receiptFile = path.join(this.project.paths.receipts, `${taskId}.json`);
      await this.assertReceiptFileSafe(receiptFile);
      const receiptRelative = normalizeRelative(path.relative(this.root, receiptFile));
      await assertFilesMatchTree(this.project, head, [receiptRelative]);
      const receipt = await readJson(receiptFile, { maxBytes: 128 * 1024 });
      const specHash = sha256(await readUtf8(path.resolve(this.root, task.spec)));
      if (
        receipt.schema_version !== 1 ||
        receipt.task_id !== taskId ||
        receipt.task_sha256 !== taskEvidenceHash(taskId, task) ||
        receipt.spec_sha256 !== specHash ||
        !objectId.test(receipt.baseline_commit ?? "") ||
        !objectId.test(receipt.result_commit ?? "") ||
        !objectId.test(receipt.baseline_tree ?? "") ||
        !objectId.test(receipt.result_tree ?? "") ||
        !evidenceHash.test(receipt.accepted_queue_sha256 ?? "") ||
        !evidenceHash.test(receipt.planned_queue_sha256 ?? "") ||
        !evidenceHash.test(receipt.planned_queue_file_sha256 ?? "") ||
        !Array.isArray(receipt.changed_files) ||
        !Array.isArray(receipt.mode_intents)
      ) {
        throw new AutopilotError(`Receipt contract is invalid for completed task ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
      validateChangedPaths(receipt.changed_files, task.allowed_paths);
      assertNoIssues(validateModeIntentContract({
        schema_version: 1,
        task_id: taskId,
        attempt: 1,
        intents: receipt.mode_intents,
      }, {
        location: `receipt.${taskId}.mode_intents`,
        taskId,
        attempt: 1,
      }), `Receipt mode intents for ${taskId}`);
      validateChangedPaths(receipt.mode_intents.map((intent) => intent.path), task.allowed_paths);
      if (receipt.mode_intents.some((intent) => !receipt.changed_files.includes(intent.path))) {
        throw new AutopilotError(`Receipt mode intent is outside changed_files for ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
      assertNoIssues(validateReview(receipt.review, taskId), `Receipt review for ${taskId}`);
      assertNoIssues(validateTaskToolUsage(receipt.tool_usage, {
        location: `receipt.${taskId}.tool_usage`,
        taskId,
      }), `Receipt tool usage for ${taskId}`);
      if (receipt.review.status !== "approved") {
        throw new AutopilotError(`Receipt review is not approved for completed task ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
      assertGateEvidence(this.gates, task.gates, receipt.gates, `Receipt gate evidence for ${taskId}`);
      if (receipt.changed_files.length > 0) {
        await verifyCommitTransition(this.project, {
          baselineCommit: receipt.baseline_commit,
          resultCommit: receipt.result_commit,
          expectedFiles: receipt.changed_files,
          baselineTree: receipt.baseline_tree,
          resultTree: receipt.result_tree,
          diffSha256: receipt.diff_sha256,
          modeIntents: receipt.mode_intents,
        });
      } else if (
        receipt.result_commit !== receipt.baseline_commit ||
        receipt.baseline_tree !== receipt.result_tree ||
        receipt.diff_sha256 !== canonicalTreeTransitionHash(receipt.baseline_tree, receipt.result_tree)
      ) {
        throw new AutopilotError(`Empty receipt transition is invalid for completed task ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
      if (!(await isAncestor(this.project, receipt.result_commit, head))) {
        throw new AutopilotError(`Task result commit is not in completed history for ${taskId}`, {
          code: "COMPLETED_EVIDENCE_INVALID",
        });
      }
    }

    const finalReceiptFile = path.join(this.project.paths.receipts, "__project-final.json");
    await this.assertReceiptFileSafe(finalReceiptFile);
    const finalReceiptRelative = normalizeRelative(path.relative(this.root, finalReceiptFile));
    await assertFilesMatchTree(this.project, head, [finalReceiptRelative]);
    const finalReceipt = await readJson(finalReceiptFile, { maxBytes: 128 * 1024 });
    if (
      finalReceipt.schema_version !== 1 ||
      !objectId.test(finalReceipt.baseline_commit ?? "") ||
      !/^[0-9a-f]{64}$/.test(finalReceipt.planned_queue_file_sha256 ?? "") ||
      finalReceipt.planned_queue_file_sha256 !== jsonDocumentSha256(this.queue) ||
      finalReceipt.queue_revision !== this.queue.revision ||
      finalReceipt.control_sha256 !== await protectedSnapshot(this.project, { durableOnly: true })
    ) {
      throw new AutopilotError("Final project receipt is inconsistent with committed project state", {
        code: "COMPLETED_EVIDENCE_INVALID",
      });
    }
    assertGateEvidence(this.gates, this.gates.final_gates, finalReceipt.gates, "Final project receipt");
    const [baselineTree, resultTree] = await Promise.all([
      gitTree(this.root, finalReceipt.baseline_commit),
      gitTree(this.root, head),
    ]);
    await verifyCommitTransition(this.project, {
      baselineCommit: finalReceipt.baseline_commit,
      resultCommit: head,
      expectedFiles: [queueRelative, finalReceiptRelative],
      baselineTree,
      resultTree,
      diffSha256: canonicalTreeTransitionHash(baselineTree, resultTree),
    });
    await assertHeadAndIndex(this.project, head);
    const dirtyApplication = await taskChangedFiles(this.project, head);
    if (dirtyApplication.length > 0) {
      throw new AutopilotError(`Completed project has uncommitted application changes: ${dirtyApplication.join(", ")}`, {
        code: "COMPLETED_EVIDENCE_INVALID",
      });
    }
  }

  async processTask(taskId, task) {
    const recovering = this.state.active_task === taskId;
    const baseline = recovering && this.state.baseline_head
      ? this.state.baseline_head
      : await gitHead(this.root);
    if (!recovering) {
      this.state = await writeState(this.project, this.state, {
        phase: "executing",
        active_task: taskId,
        attempt: 0,
        baseline_head: baseline,
        no_progress_count: 0,
        last_failure_evidence: null,
        task_tool_usage: {},
      });
      if (
        process.env.NODE_ENV === "test" &&
        process.env.AUTOPILOT_TEST_CRASH_POINT === "after_task_claim_state"
      ) process.exit(89);
      this.queue.tasks[taskId].status = "in_progress";
      this.queue.project_status = "running";
      this.queue = await writeQueue(this.project, this.queue);
    }

    if (task.risk === "high") {
      await this.humanRequired({
        kind: "high_risk_task",
        message: `Task ${taskId} is classified high risk and is not auto-approved.`,
        required_action: "Review the task; only remove context, allowed paths, or tool grants, add fixed gates, lower its attempt limit, and record a low/medium risk classification. Commit that queue-only change as one direct child commit before autonomous verification.",
        resume_condition: "The active task is low/medium risk, the Git worktree is clean, and explicit resume is run.",
      }, taskId);
      return false;
    }

    let evidence = recovering && Number(this.state.attempt ?? 0) > 0
      ? this.state.last_failure_evidence ?? { recovery: "Resuming preserved Git diff from a stale controller session." }
      : null;
    const attemptLimit = Math.min(task.attempt_limit, this.project.config.budgets.max_attempts_per_task);
    while (true) {
      if (await this.pauseAtBoundary("Pause/stop requested.")) return false;
      if (this.budgetExceeded()) await this.rolloverBudget();
      if (Number(this.state.attempt ?? 0) >= attemptLimit) {
        await this.humanRequired({
          kind: "attempt_budget_exhausted",
          message: `Task ${taskId} already consumed its ${attemptLimit} allowed phase attempt${attemptLimit === 1 ? "" : "s"}; an interrupted attempt is never replayed beyond the hard limit.`,
          required_action: "Inspect the preserved diff and diagnostics, then explicitly raise the bounded attempt limit or repair the task manually.",
          resume_condition: "The task has a reviewed recovery plan and resume is run.",
        }, taskId);
        return false;
      }
      if (Number(this.state.no_progress_count ?? 0) >= this.project.config.budgets.max_no_progress) {
        await this.humanRequired({
          kind: "no_progress_budget_exhausted",
          message: `Task ${taskId} reached the ${this.project.config.budgets.max_no_progress}-failure no-progress limit; a crash cannot replay another phase past that durable limit.`,
          required_action: "Inspect the preserved diff and diagnostics, then change the recovery plan or repair the task manually.",
          resume_condition: "A reviewed recovery plan can make measurable progress and resume is run.",
        }, taskId);
        return false;
      }
      const attempt = Number(this.state.attempt ?? 0) + 1;
      const executionPhase = attempt === 1 ? "execute" : "repair";
      let packet;
      let packetSecrets = [];
      try {
        // These checks cannot benefit from a model. Complete them before the
        // durable dispatch record so setup/provisioning defects do not consume
        // a semantic attempt or turn the next resume into a repair phase.
        await clearPhaseContracts(this.project);
        await assertHeadAndIndex(this.project, baseline);
        await assertSafeTaskWriteTargets(this.project, task.allowed_paths);
        packet = await buildContextPack(this.root, taskId, {
          stage: executionPhase,
          attempt,
          extra: evidence,
        });
        await this.ensureSessionCapacity(2);
        if (!this.openCodeCommandPreflight) {
          this.openCodeCommandPreflight = await preflightOpenCodeCommand(this.project);
        }
        const executionPreflight = await preflightFreshOpenCode(this.project, {
          phase: executionPhase,
          taskId,
          baseline,
        });
        const reviewPreflight = await preflightFreshOpenCode(this.project, {
          phase: "review",
          taskId,
          baseline,
        });
        packetSecrets.push(...executionPreflight.secrets, ...reviewPreflight.secrets);
        for (const gateId of task.gates) {
          const gate = this.gates.gates?.[gateId];
          if (!gate) {
            throw new AutopilotError(`Unknown gate ${gateId}`, { code: "UNKNOWN_GATE" });
          }
          const gateCredentials = await credentialEnvironmentForScope(
            this.project,
            gateId,
            gate.credential_profile,
          );
          packetSecrets.push(...gateCredentials.secrets);
        }
        packetSecrets = [...new Set(packetSecrets)];
        assertPhasePromptHasNoSecrets(packet.text, packetSecrets, `${executionPhase} context packet`);
      } catch (error) {
        await this.humanRequired(blockerFrom(error, "phase_preflight_failed"), taskId);
        return false;
      }

      // This write is the durable dispatch boundary. A crash or external
      // mutation after it may consume the attempt even if OpenCode never
      // returns, which prevents ambiguous replay after interruption.
      this.state = await writeState(this.project, this.state, {
        status: "running",
        phase: executionPhase === "execute" ? "executing" : "repairing",
        attempt,
        baseline_head: baseline,
        cycle: Number(this.state.cycle ?? 0) + 1,
      });
      if (
        process.env.NODE_ENV === "test" &&
        process.env.AUTOPILOT_TEST_CRASH_POINT === "after_attempt_record"
      ) process.exit(91);

      let candidate;
      let files = [];
      let acceptedModeSnapshot = { present: false, sha256: ABSENT_MODE_INTENT_SHA256, intents: [] };
      let ephemeralSecrets = [];
      let progressHash = this.state.last_progress_hash ?? sha256("no-progress");
      let executeProtected = null;
      try {
        // The protected snapshot must follow the dispatch-state write because
        // state.json itself is protected from phase mutation.
        executeProtected = await protectedSnapshotRecord(this.project);
        const executeIgnored = await ignoredApplicationSnapshot(this.project);
        const session = await runWithPostflight(async () => {
            const signalTimer = (
              process.env.NODE_ENV === "test" &&
              process.env.AUTOPILOT_TEST_SIGNAL_DURING_PHASE === executionPhase
            ) ? setTimeout(() => process.emit("SIGTERM"), 50) : null;
            try {
              return await runFreshOpenCode(this.project, packet.text, {
                phase: executionPhase,
              taskId,
              attempt,
              baseline,
              priorSessionIds: this.state.session_ids ?? [],
              captureEphemeralSecrets: (values) => {
                ephemeralSecrets = [...new Set([...ephemeralSecrets, ...values])];
              },
            });
          } finally {
            if (signalTimer) clearTimeout(signalTimer);
          }
        }, () => assertProtectedUnchanged(this.project, executeProtected), [
          () => assertIgnoredApplicationUnchanged(this.project, executeIgnored, "The fresh execution session"),
          () => assertHeadAndIndex(this.project, baseline),
        ]);
        // The fresh process has ended and its protected-file postflight passed.
        // Do not compare later controller-owned state transitions with this
        // now-stale execution snapshot in the outer recovery path.
        executeProtected = null;
        ephemeralSecrets = [...new Set([
          ...ephemeralSecrets,
          ...consumeEphemeralPhaseSecrets(session),
        ])];
        candidate = await assertCleanPhaseContract(
          this.project,
          "candidate.json",
          await readCandidateDocument(this.project),
          ephemeralSecrets,
        );
        acceptedModeSnapshot = await modeIntentSnapshot(
          this.project,
          taskId,
          attempt,
          task.allowed_paths,
        );
        files = await taskChangedFiles(this.project, baseline, {
          modeIntents: acceptedModeSnapshot.intents,
        });
        const immediateSecretIssues = await scanFilesForSecrets(this.root, files, {
          exactSecrets: ephemeralSecrets,
        });
        if (immediateSecretIssues.length > 0) {
          throw new AutopilotError(
            `Secret scan blocked the candidate: ${immediateSecretIssues.map((item) => `${item.location} ${item.message}`).join("; ")}`,
            { code: "SECRET_SCAN_FAILED", details: immediateSecretIssues },
          );
        }
        this.state = await writeState(this.project, this.state, {
          last_session: session.session_id,
          session_ids: [...(this.state.session_ids ?? []), session.session_id],
          task_tool_usage: appendBoundedTaskToolUsage(
            this.state.task_tool_usage,
            `${executionPhase}:a${attempt}`,
            session.tool_usage,
          ),
          phase: "candidate_validation",
        });
        if (await this.pauseAtBoundary("Pause/stop requested after fresh execution session.")) return false;
        await this.rolloverAtBoundary();

        assertNoIssues(validateCandidate(candidate, taskId, attempt), "Candidate contract");
        validateChangedPaths(files, task.allowed_paths);
        assertCandidateFiles(candidate.changed_files, files);
        await assertSafeChangedFiles(this.project, baseline, files);
        await assertModeIntentTransitions(this.project, baseline, acceptedModeSnapshot.intents, files);
        const secretIssues = await scanFilesForSecrets(this.root, files, {
          exactSecrets: ephemeralSecrets,
        });
        if (secretIssues.length > 0) {
          throw new AutopilotError(
            `Secret scan blocked the candidate: ${secretIssues.map((item) => `${item.location} ${item.message}`).join("; ")}`,
            { code: "SECRET_SCAN_FAILED", details: secretIssues },
          );
        }
        const diffHash = await gitDiffHash(this.project, baseline, files, {
          modeIntents: acceptedModeSnapshot.intents,
        });
        progressHash = sha256(stableJson({ diffHash, status: candidate.status, files }));

        if (candidate.status === "blocked") {
          await this.humanRequired(candidate.blocker, taskId);
          return false;
        }
        if (candidate.status === "failed") {
          throw new AutopilotError(candidate.summary || "Worker reported failure", {
            code: "WORKER_FAILED",
          });
        }

        this.state = await writeState(this.project, this.state, {
          phase: "verifying",
          last_progress_hash: progressHash,
        });
        const gateProtected = await protectedSnapshotRecord(this.project);
        const gateIgnored = await ignoredApplicationSnapshot(this.project);
        const gateResult = await runWithPostflight(
          () => runGates(this.root, task.gates, { taskId, attempt }),
          () => assertProtectedUnchanged(this.project, gateProtected),
          [
            () => assertIgnoredApplicationUnchanged(this.project, gateIgnored, "A deterministic gate"),
            () => assertTaskDiffUnchanged(
              this.project,
              baseline,
              files,
              diffHash,
              task,
              candidate,
              acceptedModeSnapshot,
              "A deterministic gate",
            ),
          ],
        );
        if (await this.pauseAtBoundary("Pause/stop requested after deterministic task gates.")) return false;
        await this.rolloverAtBoundary();
        if (!gateResult.success) {
          const failed = gateResult.results.at(-1);
          const error = new AutopilotError(`Gate ${failed.gate_id} failed; see ${failed.artifact}`, {
            code: "GATE_FAILED",
            details: failed,
          });
          const outcome = await this.recordFailure(error, progressHash, failed.fingerprint, task, baseline, {
            failure: conciseFailureEvidence(error),
            gate: failed,
          });
          if (outcome.stop) return false;
          evidence = outcome.evidence;
          continue;
        }

        await clearReview(this.project);
        const diff = await gitDiffForReview(
          this.project,
          baseline,
          files,
          this.manifest.review_reserve.diff_bytes,
          { modeIntents: acceptedModeSnapshot.intents },
        );
        const reviewPacket = await buildContextPack(this.root, taskId, {
          stage: "review",
          attempt,
          extra: {
            candidate,
            gates: reviewerGateProjection(gateResult.results),
            diff,
          },
        });
        assertPhasePromptHasNoSecrets(reviewPacket.text, packetSecrets, "review context packet");
        this.state = await writeState(this.project, this.state, { phase: "reviewing" });
        await this.ensureSessionCapacity(1);
        const reviewProtected = await protectedSnapshotRecord(this.project);
        const reviewIgnored = await ignoredApplicationSnapshot(this.project);
        const reviewSession = await runWithPostflight(async () => {
          const signalTimer = (
            process.env.NODE_ENV === "test" &&
            process.env.AUTOPILOT_TEST_SIGNAL_DURING_PHASE === "review"
          ) ? setTimeout(() => process.emit("SIGTERM"), 50) : null;
          try {
            return await runFreshOpenCode(this.project, reviewPacket.text, {
              phase: "review",
              taskId,
              attempt,
              baseline,
              priorSessionIds: this.state.session_ids ?? [],
              captureEphemeralSecrets: (values) => {
                ephemeralSecrets = [...new Set([...ephemeralSecrets, ...values])];
              },
            });
          } finally {
            if (signalTimer) clearTimeout(signalTimer);
          }
        }, () => assertProtectedUnchanged(this.project, reviewProtected), [
          () => assertIgnoredApplicationUnchanged(this.project, reviewIgnored, "The independent review"),
          () => assertTaskDiffUnchanged(
            this.project,
            baseline,
            files,
            diffHash,
            task,
            candidate,
            acceptedModeSnapshot,
            "The independent review",
          ),
        ]);
        ephemeralSecrets = [
          ...ephemeralSecrets,
          ...consumeEphemeralPhaseSecrets(reviewSession),
        ];
        const review = await assertCleanPhaseContract(
          this.project,
          "review.json",
          await readReviewDocument(this.project),
          ephemeralSecrets,
        );
        const immediateReviewSecretIssues = await scanFilesForSecrets(this.root, files, {
          exactSecrets: ephemeralSecrets,
        });
        if (immediateReviewSecretIssues.length > 0) {
          throw new AutopilotError(
            `Exact secret scan blocked completion: ${immediateReviewSecretIssues.map((item) => `${item.location} ${item.message}`).join("; ")}`,
            { code: "SECRET_SCAN_FAILED", details: immediateReviewSecretIssues },
          );
        }
        this.state = await writeState(this.project, this.state, {
          last_session: reviewSession.session_id,
          session_ids: [...(this.state.session_ids ?? []), reviewSession.session_id],
          task_tool_usage: appendBoundedTaskToolUsage(
            this.state.task_tool_usage,
            `review:a${attempt}`,
            reviewSession.tool_usage,
          ),
        });
        if (await this.pauseAtBoundary("Pause/stop requested after independent review.")) return false;
        await this.rolloverAtBoundary();
        assertNoIssues(validateReview(review, taskId), "Review contract");
        const postReviewSecretIssues = await scanFilesForSecrets(this.root, files, {
          exactSecrets: ephemeralSecrets,
        });
        if (postReviewSecretIssues.length > 0) {
          throw new AutopilotError(
            `Exact secret scan blocked completion: ${postReviewSecretIssues.map((item) => `${item.location} ${item.message}`).join("; ")}`,
            { code: "SECRET_SCAN_FAILED", details: postReviewSecretIssues },
          );
        }
        if (review.status === "approved" && review.findings.some((finding) => ["medium", "high", "critical"].includes(finding.severity))) {
          throw new AutopilotError("Review cannot approve while medium/high/critical findings remain", {
            code: "INCONSISTENT_REVIEW",
          });
        }
        if (review.status === "blocked") {
          await this.humanRequired({
            kind: "review_blocked",
            message: review.summary,
            required_action: "Resolve the independent review blocker without weakening gates or path policy.",
            resume_condition: "The blocker is resolved and resume is run.",
          }, taskId);
          return false;
        }
        if (review.status === "changes_requested") {
          const fingerprint = sha256(stableJson(review.findings));
          const error = new AutopilotError(review.summary || "Independent review requested changes", {
            code: "REVIEW_CHANGES_REQUESTED",
            details: review.findings,
          });
          const outcome = await this.recordFailure(error, progressHash, fingerprint, task, baseline, {
            failure: conciseFailureEvidence(error),
            review,
          });
          if (outcome.stop) return false;
          evidence = outcome.evidence;
          continue;
        }

        await this.completeTask(
          taskId,
          task,
          baseline,
          files,
          diffHash,
          gateResult,
          review,
          acceptedModeSnapshot,
        );
        return true;
      } catch (error) {
        if (this.state.completion) throw error;
        if (this.state.active_task === null && this.queue.tasks[taskId]?.status === "done") return true;
        let handledError = error;
        if (executeProtected) {
          try {
            await assertProtectedUnchanged(this.project, executeProtected);
          } catch (protectionError) {
            if (typeof protectionError === "object") {
              protectionError.details = {
                primary_phase_failure: failureEvidence(error),
                protected_postflight: protectionError.details ?? null,
              };
            }
            handledError = protectionError;
          }
        }
        if (ephemeralSecrets.length > 0 && error?.code !== "SECRET_SCAN_FAILED") {
          try {
            const changedAtFailure = await taskChangedFiles(this.project, baseline, {
              modeIntents: acceptedModeSnapshot.intents,
            });
            const failureSecretIssues = await scanFilesForSecrets(this.root, changedAtFailure, {
              exactSecrets: ephemeralSecrets,
            });
            if (failureSecretIssues.length > 0) {
              handledError = new AutopilotError(
                `Exact secret scan blocked failed phase output: ${failureSecretIssues.map((item) => `${item.location} ${item.message}`).join("; ")}`,
                { code: "SECRET_SCAN_FAILED", details: failureSecretIssues },
              );
            }
          } catch (scanError) {
            handledError = new AutopilotError(
              `Exact secret scan could not verify failed phase output: ${scanError.message}`,
              { code: "SECRET_SCAN_FAILED" },
            );
          }
        }
        const policyFailure = isPolicyFailure(handledError);
        if (policyFailure) {
          await this.humanRequired(blockerFrom(handledError, "policy_violation"), taskId);
          return false;
        }
        const fingerprint = sha256(stableJson(failureEvidence(handledError)));
        const outcome = await this.recordFailure(
          handledError,
          progressHash,
          fingerprint,
          task,
          baseline,
          { failure: failureEvidence(handledError) },
        );
        if (outcome.stop) return false;
        evidence = outcome.evidence;
      }
    }
  }

  async finishFinalization() {
    let finalization = this.state.finalization;
    if (
      !finalization ||
      finalization.schema_version !== 1 ||
      finalization.run_id !== this.state.run_id ||
      this.state.active_task !== null ||
      !allDone(this.queue)
    ) {
      throw new AutopilotError("Project finalization journal is inconsistent with controller state", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    const controlHash = await protectedSnapshot(this.project, { durableOnly: true });
    if (controlHash !== finalization.control_sha256) {
      throw new AutopilotError("Durable control-plane files changed after final gates", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    assertGateEvidence(this.gates, this.gates.final_gates, finalization.gates, "Final gate evidence");

    const queueHash = sha256(stableJson(this.queue));
    const queueIsAccepted = queueHash === finalization.accepted_queue_sha256;
    const queueIsPlanned = queueHash === finalization.planned_queue_sha256;
    if (!queueIsAccepted && !queueIsPlanned) {
      throw new AutopilotError("Task queue changed after final gates", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    if (
      !/^[0-9a-f]{64}$/.test(finalization.planned_queue_file_sha256 ?? "") ||
      (queueIsPlanned && jsonDocumentSha256(this.queue) !== finalization.planned_queue_file_sha256)
    ) {
      throw new AutopilotError("Completed queue bytes differ from the persisted finalization plan", {
        code: "FINALIZATION_CONFLICT",
      });
    }

    const head = await gitHead(this.root);
    if (!finalization.metadata && head !== finalization.baseline_commit) {
      throw new AutopilotError("HEAD advanced without a persisted finalization commit plan", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    if (queueIsAccepted) {
      if (head !== finalization.baseline_commit) {
        throw new AutopilotError("Queue is incomplete after finalization HEAD advanced", {
          code: "FINALIZATION_CONFLICT",
        });
      }
      this.queue.project_status = "complete";
      this.queue = await writeQueue(this.project, this.queue);
    }
    if (sha256(stableJson(this.queue)) !== finalization.planned_queue_sha256) {
      throw new AutopilotError("Completed queue differs from the finalization plan", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    if (jsonDocumentSha256(this.queue) !== finalization.planned_queue_file_sha256) {
      throw new AutopilotError("Completed queue bytes differ from the finalization plan", {
        code: "FINALIZATION_CONFLICT",
      });
    }

    const receiptFile = path.join(this.project.paths.receipts, "__project-final.json");
    const receipt = {
      schema_version: 1,
      run_id: finalization.run_id,
      baseline_commit: finalization.baseline_commit,
      queue_revision: this.queue.revision,
      gates: finalization.gates,
      completed_at: finalization.completed_at,
      control_sha256: finalization.control_sha256,
      planned_queue_file_sha256: finalization.planned_queue_file_sha256,
    };
    await writeImmutableJson(receiptFile, receipt);
    await this.assertReceiptFileSafe(receiptFile);

    const metadataFiles = [
      normalizeRelative(path.relative(this.root, this.project.paths.queue)),
      normalizeRelative(path.relative(this.root, receiptFile)),
    ];
    const expectedMetadataFileSha256 = {
      [metadataFiles[0]]: finalization.planned_queue_file_sha256,
      [metadataFiles[1]]: jsonDocumentSha256(receipt),
    };
    const message = `${this.project.config.git.commit_prefix}: complete project`;
    if (!finalization.metadata) {
      const prepared = await prepareCommitTree(
        this.project,
        finalization.baseline_commit,
        metadataFiles,
        {
          expectedFileSha256: expectedMetadataFileSha256,
          testRaceLabel: "project-finalization",
        },
      );
      const resultCommit = await createCommitObject(
        this.project,
        prepared.result_tree,
        finalization.baseline_commit,
        message,
      );
      await verifyCommitTransition(this.project, {
        baselineCommit: finalization.baseline_commit,
        resultCommit,
        expectedFiles: metadataFiles,
        baselineTree: prepared.baseline_tree,
        resultTree: prepared.result_tree,
        diffSha256: prepared.diff_sha256,
      });
      finalization = {
        ...finalization,
        step: "metadata_planned",
        metadata: {
          ...prepared,
          result_commit: resultCommit,
          changed_files: metadataFiles,
          expected_file_sha256: expectedMetadataFileSha256,
          message,
        },
      };
      this.state = await writeState(this.project, this.state, {
        phase: "finalization_metadata_planned",
        finalization,
      });
    }

    finalization = this.state.finalization;
    const metadata = finalization.metadata;
    if (!sameValues(metadata.expected_file_sha256, expectedMetadataFileSha256)) {
      throw new AutopilotError("Persisted finalization metadata hashes differ from exact queue/receipt bytes", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    await verifyCommitTransition(this.project, {
      baselineCommit: finalization.baseline_commit,
      resultCommit: metadata.result_commit,
      expectedFiles: metadata.changed_files,
      baselineTree: metadata.baseline_tree,
      resultTree: metadata.result_tree,
      diffSha256: metadata.diff_sha256,
    });
    let currentHead = await gitHead(this.root);
    if (currentHead === finalization.baseline_commit) {
      const recovered = await prepareCommitTree(
        this.project,
        finalization.baseline_commit,
        metadata.changed_files,
        {
          expectedFileSha256: metadata.expected_file_sha256,
          testRaceLabel: "project-finalization",
        },
      );
      await injectPostPrepareRaceForTest(
        this.project,
        "project-finalization",
        metadata.expected_file_sha256,
      );
      if (!sameValues(recovered, {
        parent_commit: metadata.parent_commit,
        baseline_tree: metadata.baseline_tree,
        result_tree: metadata.result_tree,
        diff_sha256: metadata.diff_sha256,
      })) {
        throw new AutopilotError("Finalization tree differs from the persisted plan", {
          code: "FINALIZATION_CONFLICT",
        });
      }
      await moveHead(
        this.project,
        finalization.baseline_commit,
        metadata.result_commit,
        "autopilot project completion",
      );
      currentHead = metadata.result_commit;
      if (
        process.env.NODE_ENV === "test" &&
        process.env.AUTOPILOT_TEST_CRASH_POINT === "after_final_commit"
      ) process.exit(87);
    }
    if (currentHead !== metadata.result_commit) {
      throw new AutopilotError("HEAD is outside the persisted finalization transaction", {
        code: "FINALIZATION_CONFLICT",
      });
    }
    await assertHeadAndIndex(this.project, metadata.result_commit);
    await assertFilesMatchTree(this.project, metadata.result_commit, metadata.changed_files);
    const finalWorktree = await taskChangedFiles(this.project, metadata.result_commit);
    if (finalWorktree.length > 0) {
      throw new AutopilotError(`Application changed during finalization: ${finalWorktree.join(", ")}`, {
        code: "FINALIZATION_CONFLICT",
      });
    }
    this.state = await writeState(this.project, this.state, {
      status: "complete",
      phase: "complete",
      pid: null,
      active_task: null,
      blocker: null,
      finalization: null,
    });
    await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
      this.project,
      this.state,
      "All required tasks and final fixed gates are green. No deployment or push was performed.",
    ));
  }

  async finalizeProject() {
    this.state = await writeState(this.project, this.state, {
      phase: "final_verification",
      active_task: null,
      attempt: 0,
    });
    const finalProtected = await protectedSnapshotRecord(this.project);
    const finalIgnored = await ignoredApplicationSnapshot(this.project);
    const finalBaseline = await gitHead(this.root);
    await assertHeadAndIndex(this.project, finalBaseline);
    let finalResult;
    try {
      finalResult = await runWithPostflight(
        () => runGates(this.root, this.gates.final_gates, {
          taskId: "project-final",
          attempt: 1,
        }),
        () => assertProtectedUnchanged(this.project, finalProtected),
        [
          () => assertIgnoredApplicationUnchanged(this.project, finalIgnored, "Final deterministic gates"),
          () => assertHeadAndIndex(this.project, finalBaseline),
          async () => {
            const finalFiles = await taskChangedFiles(this.project, finalBaseline);
            if (finalFiles.length > 0) {
              throw new AutopilotError(`Final gates mutated application paths: ${finalFiles.join(", ")}`, {
                code: "UNTRUSTED_PHASE_MUTATION",
                details: finalFiles,
              });
            }
          },
        ],
      );
      if (await this.pauseAtBoundary("Pause/stop requested after final deterministic gates.")) return;
      await this.rolloverAtBoundary();
    } catch (error) {
      await this.humanRequired({
        ...blockerFrom(error, "final_verification_error"),
        message: `Final verification stopped safely: ${error.message}`,
      }, null);
      return;
    }
    if (!finalResult.success) {
      const failed = finalResult.results.at(-1);
      await this.humanRequired({
        kind: "final_gate_failed",
        message: `Final gate ${failed?.gate_id ?? "unknown"} failed; see ${failed?.artifact ?? "artifact log"}.`,
        required_action: "Create or reopen a bounded repair milestone; do not mark the project complete.",
        resume_condition: "All final gates are green and resume is run.",
      }, null);
      return;
    }
    const plannedQueue = {
      ...this.queue,
      project_status: "complete",
      revision: Number(this.queue.revision ?? 0) + 1,
    };
    this.state = await writeState(this.project, this.state, {
      phase: "finalization_accepted",
      finalization: {
        schema_version: 1,
        step: "accepted",
        run_id: this.state.run_id,
        baseline_commit: finalBaseline,
        completed_at: nowIso(),
        gates: finalResult.results,
        control_sha256: await protectedSnapshot(this.project, { durableOnly: true }),
        accepted_queue_sha256: sha256(stableJson(this.queue)),
        planned_queue_sha256: sha256(stableJson(plannedQueue)),
        planned_queue_file_sha256: jsonDocumentSha256(plannedQueue),
        metadata: null,
      },
    });
    await this.finishFinalization();
  }

  async run() {
    let initialized = false;
    try {
      initialized = await this.initialize();
      if (!initialized) return this.state;
      const onSignal = () => { this.shutdownRequested = true; };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      while (true) {
        if (this.shutdownRequested || await pauseRequested(this.project)) {
          await this.checkpointPause("Pause/stop requested.");
          break;
        }
        if (!this.state.active_task && await maintenanceRequested(this.project)) {
          this.state = await writeState(this.project, this.state, {
            status: "paused",
            phase: "maintenance",
            pid: null,
            blocker: null,
          });
          await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(
            this.project,
            this.state,
            "Stopped at a task boundary for Control Plane maintenance.",
          ));
          break;
        }
        if (allDone(this.queue)) {
          await this.rolloverAtBoundary();
          await this.finalizeProject();
          break;
        }
        if (this.budgetExceeded()) await this.rolloverBudget();
        if (this.state.active_task && this.queue.tasks[this.state.active_task]) {
          const recoveringId = this.state.active_task;
          this.queue.tasks[recoveringId].status = "in_progress";
          this.queue.project_status = "running";
          this.queue = await writeQueue(this.project, this.queue);
          const recovered = await this.processTask(
            recoveringId,
            { ...this.queue.tasks[recoveringId], id: recoveringId },
          );
          if (!recovered || this.state.status !== "running") break;
          if (this.once) {
            this.state = await writeState(this.project, this.state, {
              status: "idle",
              phase: "idle",
              pid: null,
            });
            break;
          }
          continue;
        }
        const selection = nextReady(this.queue);
        if (selection.changed) this.queue = await writeQueue(this.project, this.queue);
        if (!selection.entry) {
          await this.humanRequired({
            kind: "queue_blocked",
            message: "No task is ready, but required tasks remain incomplete.",
            required_action: "Resolve blocked dependencies or correct the milestone DAG.",
            resume_condition: "At least one valid task is ready and resume is run.",
          }, null);
          break;
        }
        const [taskId, task] = selection.entry;
        const completed = await this.processTask(taskId, task);
        if (!completed || this.state.status !== "running") break;
        if (this.once) {
          this.state = await writeState(this.project, this.state, {
            status: "idle",
            phase: "idle",
            pid: null,
          });
          break;
        }
      }
      return this.state;
    } catch (error) {
      const preserveDurableBoundary = Boolean(
        this.state && (
          ["paused", "human_required", "complete"].includes(this.state.status) ||
          (this.state.phase === "task_complete" && this.state.active_task === null)
        )
      );
      if (this.project && this.state && this.lock && error?.code !== "RESUME_REQUIRED" && !preserveDurableBoundary) {
        const requiresHuman = isPolicyFailure(error);
        const blocker = blockerFrom(error, requiresHuman ? "policy_violation" : "controller_error");
        this.state = await writeState(this.project, this.state, {
          status: requiresHuman ? "human_required" : "failed",
          phase: requiresHuman ? "blocked" : "failed",
          pid: null,
          blocker,
        }).catch(() => this.state);
        if (requiresHuman) await bestEffortAuxiliary("human blocker artifact", () => writeBlocker(this.project, blocker));
        await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(this.project, this.state, error.message));
      } else if (this.project && this.state && this.lock && preserveDurableBoundary) {
        await bestEffortAuxiliary("checkpoint", () => writeCheckpoint(this.project, this.state, error.message));
      }
      throw error;
    } finally {
      if (this.lock) await this.lock.release();
    }
  }
}
