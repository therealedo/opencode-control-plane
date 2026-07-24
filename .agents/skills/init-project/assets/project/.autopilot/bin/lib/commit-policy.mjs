export const CONVENTIONAL_COMMIT_TYPES = Object.freeze([
  "feat",
  "fix",
  "refactor",
  "test",
  "docs",
  "chore",
  "ci",
  "build",
  "security",
]);

const TYPE_ALTERNATION = CONVENTIONAL_COMMIT_TYPES.join("|");
const PREFIX_PATTERN = new RegExp(`^(?:${TYPE_ALTERNATION})(?:\\([a-z0-9][a-z0-9._/-]{0,63}\\))?$`);
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PREFIX_BYTES = 128;
const MAX_PREFIXES = 256;
// A blueprint task title may itself be 16 KiB. Keep the complete subject
// bounded while leaving room for the validated prefix, task ID, and syntax.
const MAX_SUBJECT_BYTES = 20 * 1024;
const CONTROLLER_PREFIX = "chore(control-plane)";

export function normalizeTaskCommitPrefixes(value, location = "commit_prefixes") {
  if (!plainObject(value)) throw new Error(`${location} must be an object`);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_PREFIXES) {
    throw new Error(`${location} must map between 1 and ${MAX_PREFIXES} task IDs`);
  }
  const normalized = {};
  const folded = new Set();
  for (const [taskId, prefix] of entries.sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`${location} contains invalid task ID ${taskId}`);
    const key = taskId.toLowerCase();
    if (folded.has(key)) throw new Error(`${location} contains case-insensitive duplicate task ID ${taskId}`);
    folded.add(key);
    normalized[taskId] = conventionalPrefix(prefix, `${location}.${taskId}`);
  }
  return normalized;
}

export function assertExactTaskPrefixCoverage(prefixes, taskIds, location = "commit_prefixes") {
  const actual = Object.keys(prefixes).sort(compareText);
  const expected = [...taskIds].sort(compareText);
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    const missing = expected.filter((entry) => !actual.includes(entry));
    const extra = actual.filter((entry) => !expected.includes(entry));
    throw new Error(
      `${location} must map every task ID exactly` +
      `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
      `${extra.length ? `; unknown: ${extra.join(", ")}` : ""}`,
    );
  }
}

export function normalizeGitCommitConfig(git, location = "config.git") {
  if (!plainObject(git)) throw new Error(`${location} must be an object`);
  const hasFixed = Object.hasOwn(git, "commit_prefix");
  const hasMapped = Object.hasOwn(git, "commit_prefixes");
  if (hasFixed === hasMapped) {
    throw new Error(`${location} must define exactly one of commit_prefix or commit_prefixes`);
  }
  if (hasFixed) {
    if (typeof git.commit_prefix !== "string" || !git.commit_prefix.trim()) {
      throw new Error(`${location}.commit_prefix must be non-empty`);
    }
    const prefix = git.commit_prefix.trim();
    if (/[\u0000-\u001f\u007f]/.test(prefix)) throw new Error(`${location}.commit_prefix must be one line`);
    if (Buffer.byteLength(prefix, "utf8") > MAX_PREFIX_BYTES) {
      throw new Error(`${location}.commit_prefix exceeds ${MAX_PREFIX_BYTES} bytes`);
    }
    return { mode: "fixed", prefix };
  }
  return {
    mode: "mapped",
    prefixes: normalizeTaskCommitPrefixes(git.commit_prefixes, `${location}.commit_prefixes`),
  };
}

export function taskCommitMessage(git, task) {
  const policy = normalizeGitCommitConfig(git);
  const id = subjectText(task?.id, "task.id");
  const title = subjectText(task?.title, "task.title");
  const prefix = policy.mode === "fixed"
    ? policy.prefix
    : policy.prefixes[id];
  if (!prefix) throw new Error(`config.git.commit_prefixes has no entry for task ${id}`);
  return boundedSubject(`${prefix}: ${id} ${title}`);
}

export function controllerCommitMessage(git, action) {
  const policy = normalizeGitCommitConfig(git);
  const prefix = policy.mode === "fixed"
    ? policy.prefix
    : CONTROLLER_PREFIX;
  return boundedSubject(`${prefix}: ${subjectText(action, "controller commit action")}`);
}

function conventionalPrefix(value, location) {
  if (typeof value !== "string" || !PREFIX_PATTERN.test(value)) {
    throw new Error(`${location} must be a supported Conventional Commit prefix with an optional scope`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PREFIX_BYTES) {
    throw new Error(`${location} exceeds ${MAX_PREFIX_BYTES} bytes`);
  }
  return value;
}

function subjectText(value, location) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${location} must be non-empty single-line text`);
  }
  return value.trim();
}

function boundedSubject(value) {
  if (Buffer.byteLength(value, "utf8") > MAX_SUBJECT_BYTES) {
    throw new Error(`Git commit subject exceeds ${MAX_SUBJECT_BYTES} bytes`);
  }
  return value;
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
