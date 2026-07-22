import { appendFile, lstat, readFile, readlink, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AutopilotError,
  assertPortableRelative,
  assertRealInside,
  isAllowedPath,
  matchesGlob,
  normalizeRelative,
  resolveInside,
  sha256,
  stableJson,
  truncateUtf8,
  unique,
  utf8Bytes,
} from "./core.mjs";
import {
  externalExecutionEnv,
  gitSafeAmbientConfigArgs,
  resolveExternalGitExecutable,
  runArgv,
} from "./process.mjs";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const HARDENED_GIT_PREFIX = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "credential.interactive=false",
  "-c", `core.attributesFile=${NULL_DEVICE}`,
  "-c", `core.excludesFile=${NULL_DEVICE}`,
]);

async function git(root, args, {
  allowFailure = false,
  maxOutputBytes = 4 * 1024 * 1024,
  input = null,
  env = {},
} = {}) {
  const executionEnv = await externalExecutionEnv(root);
  const executable = await resolveExternalGitExecutable(root, executionEnv, {
    label: "controller Git executable",
  });
  const safeAmbientConfig = await gitSafeAmbientConfigArgs(root, executable, executionEnv);
  const literalPathspecs = env.GIT_LITERAL_PATHSPECS ?? "1";
  const result = await runArgv([executable, ...HARDENED_GIT_PREFIX, ...safeAmbientConfig, ...args], {
    cwd: root,
    env: {
      ...executionEnv,
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: NULL_DEVICE,
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: literalPathspecs,
      SSH_ASKPASS_REQUIRE: "never",
    },
    timeoutMs: 120_000,
    maxOutputBytes,
    input,
  });
  if (result.output_truncated) {
    throw new AutopilotError(`git ${args[0]} exceeded its ${maxOutputBytes}-byte output cap`, {
      code: "GIT_OUTPUT_TRUNCATED",
    });
  }
  if (!allowFailure && result.code !== 0) {
    throw new AutopilotError(`git ${args[0]} failed: ${truncateUtf8(result.stderr || result.stdout, 8 * 1024)}`, {
      code: "GIT_FAILED",
    });
  }
  return result;
}

function nulList(text) {
  return text.split("\0").filter(Boolean).map(normalizeRelative);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertGitRepository(root) {
  const dotGitPath = path.join(root, ".git");
  let dotGit;
  try {
    dotGit = await lstat(dotGitPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AutopilotError("Autopilot requires a Git worktree", { code: "GIT_REQUIRED" });
    }
    throw error;
  }
  if (!dotGit.isDirectory() || dotGit.isSymbolicLink()) {
    throw new AutopilotError("Autopilot requires a standalone Git worktree with a local .git directory", {
      code: "GIT_LAYOUT_UNSUPPORTED",
    });
  }
  for (const relative of [
    "commondir",
    "shallow",
    "info/grafts",
    "objects/info/alternates",
    "refs/replace",
  ]) {
    try {
      await lstat(path.join(dotGitPath, ...relative.split("/")));
      throw new AutopilotError(
        `Git history indirection is incompatible with autonomous evidence: .git/${relative}`,
        { code: "GIT_LAYOUT_UNSUPPORTED", details: [`.git/${relative}`] },
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw new AutopilotError("Autopilot requires a Git worktree", { code: "GIT_REQUIRED" });
  }
  const topLevel = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const [realRoot, realTop] = await Promise.all([realpath(root), realpath(topLevel)]);
  const normalizeCase = (value) =>
    process.platform === "win32" ? path.resolve(value).toLocaleLowerCase("en-US") : path.resolve(value);
  if (normalizeCase(realRoot) !== normalizeCase(realTop)) {
    throw new AutopilotError(
      `Project root must equal the Git worktree root (project: ${root}; Git: ${topLevel})`,
      { code: "GIT_TOPLEVEL_MISMATCH" },
    );
  }
  const includedConfig = await git(root, [
    "config",
    "--no-includes",
    "--name-only",
    "--get-regexp",
    "^(include\\.path|includeif\\..*\\.path)$",
  ], { allowFailure: true, maxOutputBytes: 64 * 1024 });
  if (![0, 1].includes(includedConfig.code)) {
    throw new AutopilotError("Could not inspect repository-local Git include directives", {
      code: "GIT_LAYOUT_UNSUPPORTED",
    });
  }
  const includeKeys = includedConfig.stdout.split(/\r?\n/).filter(Boolean);
  if (includeKeys.length > 0) {
    throw new AutopilotError(
      `Repository-local Git includes are incompatible with bounded configuration evidence: ${includeKeys.join(", ")}`,
      { code: "GIT_LAYOUT_UNSUPPORTED", details: includeKeys },
    );
  }
  const executableConfig = await git(root, [
    "config",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$",
  ], { allowFailure: true, maxOutputBytes: 64 * 1024 });
  if (![0, 1].includes(executableConfig.code)) {
    throw new AutopilotError("Could not inspect repository-local executable Git configuration", {
      code: "GIT_LAYOUT_UNSUPPORTED",
    });
  }
  const executableKeys = executableConfig.stdout.split(/\r?\n/).filter(Boolean);
  if (executableKeys.length > 0) {
    throw new AutopilotError(
      `Repository-local Git filters or diff drivers are incompatible with exact autonomous staging: ${executableKeys.join(", ")}`,
      { code: "GIT_LAYOUT_UNSUPPORTED", details: executableKeys },
    );
  }
  const replacementRefs = await git(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ], { maxOutputBytes: 64 * 1024 });
  const replacementNames = replacementRefs.stdout.split(/\r?\n/).filter(Boolean);
  if (replacementNames.length > 0) {
    throw new AutopilotError(
      `Git replacement refs are incompatible with autonomous evidence: ${replacementNames.join(", ")}`,
      { code: "GIT_LAYOUT_UNSUPPORTED", details: replacementNames },
    );
  }
}

export async function gitHead(root) {
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function gitTree(root, revision) {
  return (await git(root, ["rev-parse", `${revision}^{tree}`])).stdout.trim();
}

export function canonicalTreeTransitionHash(baselineTree, resultTree) {
  return sha256(`autopilot-git-tree-transition-v1\0${baselineTree}\0${resultTree}\0`);
}

export async function gitStatus(root) {
  const result = await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const records = result.stdout.split("\0").filter(Boolean);
  return records.map((record) => {
    const status = record.slice(0, 2);
    const rawPath = record.slice(3);
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    return { status, file: normalizeRelative(file) };
  });
}

async function gitStagedFiles(root, baseline = "HEAD") {
  const result = await git(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    baseline,
    "--",
  ]);
  return unique(nulList(result.stdout)).sort();
}

async function gitUnstagedFiles(root, files) {
  if (files.length === 0) return [];
  const result = await git(root, ["diff", "--name-only", "-z", "--no-renames", "--", ...files]);
  return unique(nulList(result.stdout)).sort();
}

export async function assertHeadAndIndex(project, expectedHead) {
  const actualHead = await gitHead(project.root);
  if (actualHead !== expectedHead) {
    throw new AutopilotError(
      `Git HEAD changed outside the controller (expected ${expectedHead}; received ${actualHead})`,
      { code: "GIT_HEAD_CHANGED", details: { expected: expectedHead, actual: actualHead } },
    );
  }
  const staged = await gitStagedFiles(project.root, expectedHead);
  if (staged.length > 0) {
    throw new AutopilotError(`Git index changed outside the controller: ${staged.join(", ")}`, {
      code: "GIT_INDEX_CHANGED",
      details: staged,
    });
  }
  const [expectedTree, indexTree, tagged] = await Promise.all([
    gitTree(project.root, expectedHead),
    git(project.root, ["write-tree"]),
    git(project.root, ["ls-files", "-v", "-z"], { maxOutputBytes: 16 * 1024 * 1024 }),
  ]);
  if (indexTree.stdout.trim() !== expectedTree) {
    throw new AutopilotError("Git index tree differs from the expected HEAD tree", {
      code: "GIT_INDEX_CHANGED",
    });
  }
  const unsafeFlags = tagged.stdout.split("\0").filter(Boolean).flatMap((record) => {
    if (record.startsWith("H ")) return [];
    return [{ flag: record[0], file: normalizeRelative(record.slice(2)) }];
  });
  if (unsafeFlags.length > 0) {
    throw new AutopilotError(
      `Git index contains nonstandard flags (assume-unchanged, skip-worktree, or conflict): ${unsafeFlags.map((item) => `${item.flag} ${item.file}`).join(", ")}`,
      { code: "GIT_INDEX_CHANGED", details: unsafeFlags },
    );
  }
}

export async function revisionChangedFiles(root, baseline, result) {
  const diff = await git(root, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    baseline,
    result,
    "--",
  ]);
  return unique(nulList(diff.stdout)).sort();
}

export async function readRevisionFile(root, revision, file, maxOutputBytes = 256 * 1024) {
  if (!/^[0-9a-f]{40,64}$/i.test(revision ?? "")) {
    throw new AutopilotError("Git revision for a committed file read is invalid", {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  const normalized = assertPortableRelative(file, "committed file path");
  const result = await git(root, ["show", `${revision}:${normalized}`], { maxOutputBytes });
  return result.stdout;
}

async function baselineEntry(root, baseline, file) {
  const result = await git(root, ["ls-tree", "-z", baseline, "--", file]);
  const record = result.stdout.split("\0").find(Boolean);
  if (!record) return null;
  const match = /^(\d+)\s+(\S+)\s+(\S+)\t/.exec(record);
  return match ? { mode: match[1], type: match[2], object: match[3] } : null;
}

async function stageRawIndexFiles(project, baseline, files, modeIntents = []) {
  const intendedModes = new Map(
    normalizedModeIntents(modeIntents).map((intent) => [intent.path, intent.executable]),
  );
  for (const file of unique(files.map(normalizeRelative)).sort()) {
    const absolute = resolveInside(project.root, file, "raw Git staging file");
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await git(project.root, ["update-index", "--force-remove", "--", file]);
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Raw Git staging source is not a private regular file: ${file}`, {
        code: Number(info.nlink) > 1 ? "HARDLINK_DENIED" : "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    await assertRealInside(project.root, absolute, `raw Git staging file ${file}`);
    const previous = await baselineEntry(project.root, baseline, file);
    if (previous && (previous.type !== "blob" || !["100644", "100755"].includes(previous.mode))) {
      throw new AutopilotError(`Raw Git staging baseline type is unsupported: ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    const object = (await git(project.root, ["hash-object", "-w", "--no-filters", "--", file])).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(object)) {
      throw new AutopilotError(`Git returned an invalid raw object ID for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    const mode = intendedModes.has(file)
      ? intendedModes.get(file) ? "100755" : "100644"
      : process.platform === "win32" && previous
        ? previous.mode
        : (info.mode & 0o111) === 0 ? "100644" : "100755";
    await git(project.root, ["update-index", "--add", "--cacheinfo", mode, object, file]);
  }
}

export async function assertSafeChangedFiles(project, baseline, files) {
  for (const file of files) {
    const previous = await baselineEntry(project.root, baseline, file);
    if (previous && (previous.mode === "120000" || previous.mode === "160000" || previous.type !== "blob")) {
      throw new AutopilotError(`Changed path uses an unsupported Git link type: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
        details: { file, mode: previous.mode, type: previous.type },
      });
    }
    const absolute = resolveInside(project.root, file, "changed file");
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AutopilotError(`Changed path must be a regular file, not a link/directory: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
        details: { file },
      });
    }
    if (Number(info.nlink) > 1) {
      throw new AutopilotError(`Changed hard-linked file is not allowed: ${file}`, {
        code: "HARDLINK_DENIED",
        details: { file, links: Number(info.nlink) },
      });
    }
    await assertRealInside(project.root, absolute, `changed file ${file}`);
  }
}

export function controllerOwned(relative, project) {
  const normalized = normalizeRelative(relative);
  const exact = new Set([
    normalizeRelative(project.relative.state),
    normalizeRelative(project.relative.queue),
    normalizeRelative(project.relative.checkpoint),
    normalizeRelative(project.relative.blocker),
    normalizeRelative(project.relative.stop),
    normalizeRelative(project.relative.paused),
  ]);
  if (exact.has(normalized)) return true;
  for (const directory of [project.relative.runtime, project.relative.artifacts, project.relative.receipts]) {
    const prefix = normalizeRelative(directory).replace(/\/$/, "");
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function configuredEphemeralRoots(project) {
  const roots = project.config.git?.ephemeral_roots ?? [];
  if (!Array.isArray(roots)) {
    throw new AutopilotError("git.ephemeral_roots must be an array", { code: "CONFIG_INVALID" });
  }
  return unique(roots.map((root) => {
    const normalized = assertPortableRelative(root, "ephemeral root").replace(/\/+$/, "");
    if (/[*?\[\]]/.test(normalized)) {
      throw new AutopilotError(`Ephemeral root must be literal: ${root}`, { code: "CONFIG_INVALID" });
    }
    return normalized;
  })).sort();
}

function ephemeralPathspecs(roots) {
  return roots.flatMap((root) => [
    `:(top,exclude)${root}`,
    `:(top,exclude)${root}/**`,
  ]);
}

function withinEphemeralRoot(file, roots) {
  return roots.some((root) => file === root || file.startsWith(`${root}/`));
}

export async function assertCleanStart(project) {
  const dirty = (await gitStatus(project.root)).filter((entry) => !controllerOwned(entry.file, project));
  if (dirty.length > 0) {
    throw new AutopilotError(
      `Working tree contains non-controller changes: ${dirty.map((entry) => `${entry.status} ${entry.file}`).join(", ")}`,
      { code: "DIRTY_WORKTREE", details: dirty },
    );
  }
}

function normalizedModeIntents(modeIntents = []) {
  if (!Array.isArray(modeIntents) || modeIntents.length > 64) {
    throw new AutopilotError("Executable mode intents must contain at most 64 entries", {
      code: "MODE_INTENT_INVALID",
    });
  }
  const normalized = modeIntents.map((intent) => {
    if (!intent || typeof intent !== "object" || Array.isArray(intent) || typeof intent.executable !== "boolean") {
      throw new AutopilotError("Executable mode intent is malformed", { code: "MODE_INTENT_INVALID" });
    }
    return { path: assertPortableRelative(intent.path, "mode intent path"), executable: intent.executable };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(normalized.map((intent) => intent.path)).size !== normalized.length) {
    throw new AutopilotError("Executable mode intent paths must be unique", { code: "MODE_INTENT_INVALID" });
  }
  return normalized;
}

async function modeIntentChangedPaths(root, baseline, modeIntents) {
  const changed = [];
  for (const intent of normalizedModeIntents(modeIntents)) {
    const entry = await baselineEntry(root, baseline, intent.path);
    const desired = intent.executable ? "100755" : "100644";
    if (!entry || entry.mode !== desired) changed.push(intent.path);
  }
  return changed;
}

export async function assertModeIntentTransitions(project, baseline, modeIntents, files) {
  const expectedFiles = new Set(files.map(normalizeRelative));
  for (const intent of normalizedModeIntents(modeIntents)) {
    if (!expectedFiles.has(intent.path)) {
      throw new AutopilotError(`Mode intent path is absent from the exact candidate diff: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
    const entry = await baselineEntry(project.root, baseline, intent.path);
    const desired = intent.executable ? "100755" : "100644";
    if (entry && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
      throw new AutopilotError(`Mode intent baseline type is unsupported: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
    if ((!entry && !intent.executable) || entry?.mode === desired) {
      throw new AutopilotError(`Mode intent is a no-op against the baseline: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
    let info;
    try {
      info = await lstat(resolveInside(project.root, intent.path, "mode intent path"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new AutopilotError(`Mode intent target is missing: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Mode intent target is not a private regular file: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
    await assertRealInside(project.root, resolveInside(project.root, intent.path), `mode intent ${intent.path}`);
    if (process.platform !== "win32") {
      if (((info.mode & 0o111) !== 0) !== intent.executable) {
        throw new AutopilotError(`Working executable mode disagrees with intent: ${intent.path}`, {
          code: "MODE_INTENT_INVALID",
        });
      }
    }
  }
}

export async function taskChangedFiles(project, baseline = "HEAD", { modeIntents = [] } = {}) {
  const tracked = await git(project.root, ["diff", "--name-only", "-z", "--no-renames", baseline, "--"]);
  const untracked = await git(project.root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const intended = await modeIntentChangedPaths(project.root, baseline, modeIntents);
  return unique([...nulList(tracked.stdout), ...nulList(untracked.stdout), ...intended])
    .filter((file) => !controllerOwned(file, project))
    .sort();
}

export async function ignoredApplicationSnapshot(project) {
  const ephemeralRoots = configuredEphemeralRoots(project);
  const listed = await git(project.root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ...ephemeralPathspecs(ephemeralRoots),
  ], {
    maxOutputBytes: 64 * 1024 * 1024,
    env: { GIT_LITERAL_PATHSPECS: "0" },
  });
  const entries = [];
  for (const file of unique(nulList(listed.stdout)).sort()) {
    if (controllerOwned(file, project) || withinEphemeralRoot(file, ephemeralRoots)) continue;
    const normalized = assertPortableRelative(file, "ignored application path");
    const absolute = resolveInside(project.root, normalized, "ignored application path");
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries.push({ file: normalized, type: "missing" });
        continue;
      }
      throw error;
    }
    const common = {
      file: normalized,
      dev: String(info.dev),
      ino: String(info.ino),
      mode: info.mode,
      nlink: Number(info.nlink),
      size: info.size,
      mtime_ms: info.mtimeMs,
      ctime_ms: info.ctimeMs,
    };
    if (info.isSymbolicLink()) {
      entries.push({ ...common, type: "symlink", target: await readlink(absolute) });
    } else if (info.isFile()) {
      entries.push({
        ...common,
        type: "file",
        ...(info.size <= 64 * 1024 ? { sha256: await sha256File(absolute) } : {}),
      });
    } else {
      entries.push({ ...common, type: info.isDirectory() ? "directory" : "other" });
    }
  }
  return sha256(stableJson(entries));
}

export async function assertIgnoredApplicationUnchanged(project, before, phase) {
  const after = await ignoredApplicationSnapshot(project);
  if (after !== before) {
    throw new AutopilotError(`${phase} mutated ignored application state`, {
      code: "IGNORED_PATH_MUTATION",
    });
  }
}

export async function assertSafeTaskWriteTargets(project, allowedPatterns) {
  // Ignored files are still writable filesystem objects. Omitting them here
  // would let a phase overwrite an ignored hardlink and damage its external
  // inode before the post-phase ignored-state snapshot can reject the run.
  const ephemeralRoots = configuredEphemeralRoots(project);
  const exclusions = ephemeralPathspecs(ephemeralRoots);
  const listingOptions = {
    maxOutputBytes: 64 * 1024 * 1024,
    env: { GIT_LITERAL_PATHSPECS: "0" },
  };
  const [visible, ignored] = await Promise.all([
    git(project.root, ["ls-files", "-c", "-o", "--exclude-standard", "-z", "--", ".", ...exclusions], {
      maxOutputBytes: 64 * 1024 * 1024,
      env: listingOptions.env,
    }),
    git(project.root, ["ls-files", "-o", "--ignored", "--exclude-standard", "-z", "--", ".", ...exclusions], {
      maxOutputBytes: 64 * 1024 * 1024,
      env: listingOptions.env,
    }),
  ]);
  const files = unique([...nulList(visible.stdout), ...nulList(ignored.stdout)])
    .filter((file) =>
      !controllerOwned(file, project) && !withinEphemeralRoot(file, ephemeralRoots) &&
      allowedPatterns.some((pattern) => matchesGlob(file, pattern))
    )
    .sort();
  for (const file of files) {
    const absolute = resolveInside(project.root, file, "task write target");
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Task write target must be a private regular file before model execution: ${file}`, {
        code: Number(info.nlink) > 1 ? "HARDLINK_DENIED" : "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    await assertRealInside(project.root, absolute, `task write target ${file}`);
  }
  for (const pattern of allowedPatterns) {
    const literal = normalizeRelative(pattern).split("*")[0].replace(/\/$/, "");
    if (!literal) continue;
    const absolute = resolveInside(project.root, literal, "task write root");
    let cursor = project.root;
    for (const part of normalizeRelative(path.relative(project.root, absolute)).split("/").filter(Boolean)) {
      cursor = path.join(cursor, part);
      let info;
      try {
        info = await lstat(cursor);
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new AutopilotError(`Task write root traverses a symbolic link: ${pattern}`, {
          code: "UNSAFE_CHANGED_FILE_TYPE",
        });
      }
      await assertRealInside(project.root, cursor, `task write root ${pattern}`);
    }
  }
}

export function validateChangedPaths(files, allowedPatterns) {
  for (const file of files) assertPortableRelative(file, "changed path");
  const ambiguous = files.filter((file) => /[\0-\x1f\x7f]/.test(file));
  if (ambiguous.length > 0) {
    throw new AutopilotError(`Changed paths contain control characters: ${ambiguous.map(JSON.stringify).join(", ")}`, {
      code: "PATH_POLICY_VIOLATION",
      details: ambiguous,
    });
  }
  const rejected = files.filter((file) => !isAllowedPath(file, allowedPatterns));
  if (rejected.length > 0) {
    throw new AutopilotError(`Changed paths fall outside task allowlist: ${rejected.join(", ")}`, {
      code: "PATH_POLICY_VIOLATION",
      details: rejected,
    });
  }
}

export function assertCandidateFiles(candidateFiles, actualFiles) {
  const claimed = unique(candidateFiles.map(normalizeRelative)).sort();
  const actual = unique(actualFiles.map(normalizeRelative)).sort();
  if (stableJson(claimed) !== stableJson(actual)) {
    throw new AutopilotError(
      `candidate.changed_files does not match Git (claimed: ${claimed.join(", ") || "none"}; actual: ${actual.join(", ") || "none"})`,
      { code: "CANDIDATE_DIFF_MISMATCH", details: { claimed, actual } },
    );
  }
}

export async function gitDiffHash(project, baseline, files, { modeIntents = [] } = {}) {
  const normalizedIntents = normalizedModeIntents(modeIntents);
  const intendedModes = new Map(normalizedIntents.map((intent) => [intent.path, intent.executable]));
  const records = [];
  for (const file of unique(files.map(normalizeRelative)).sort()) {
    const previous = await baselineEntry(project.root, baseline, file);
    if (previous && (previous.type !== "blob" || !["100644", "100755"].includes(previous.mode))) {
      throw new AutopilotError(`Cannot hash unsupported baseline type: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    let current = null;
    try {
      const absolute = resolveInside(project.root, file, "diff hash file");
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
        throw new AutopilotError(`Cannot hash unsupported changed file type: ${file}`, {
          code: "UNSAFE_CHANGED_FILE_TYPE",
        });
      }
      const digest = await sha256File(absolute);
      const mode = intendedModes.has(file)
        ? intendedModes.get(file) ? "100755" : "100644"
        : process.platform === "win32" && previous
          ? previous.mode
          : (info.mode & 0o111) === 0 ? "100644" : "100755";
      current = { mode, sha256: digest };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    records.push({
      file,
      baseline: previous ? { mode: previous.mode, object: previous.object } : null,
      current,
    });
  }
  return sha256(stableJson({
    files: records,
    mode_intents: normalizedIntents,
  }));
}

export async function gitDiffForReview(project, baseline, files, maxBytes, { modeIntents = [] } = {}) {
  if (files.length === 0) return "No application diff.";
  const normalizedIntents = normalizedModeIntents(modeIntents);
  const intendedModes = new Map(normalizedIntents.map((intent) => [intent.path, intent.executable]));
  const trackedResult = await git(project.root, ["ls-files", "-z", "--", ...files]);
  const tracked = new Set(nulList(trackedResult.stdout));
  const trackedFiles = files.filter((file) => tracked.has(file));
  const result = trackedFiles.length > 0
    ? await git(project.root, [
      ...(normalizedIntents.length > 0 ? ["-c", "core.fileMode=false"] : []),
      "diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "--unified=3", baseline, "--", ...trackedFiles,
    ], {
      maxOutputBytes: maxBytes,
    })
    : { stdout: "" };
  const sections = [result.stdout];
  for (const file of files.filter((item) => !tracked.has(item))) {
    const absolute = path.resolve(project.root, file);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Review evidence cannot include unsupported file type: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    if (info.size > maxBytes) {
      throw new AutopilotError(`Review evidence for ${file} is ${info.size} bytes; cap is ${maxBytes}`, {
        code: "REVIEW_EVIDENCE_TOO_LARGE",
      });
    }
    const contents = await readFile(absolute);
    if (contents.includes(0)) {
      throw new AutopilotError(`New binary file requires a specialized deterministic review gate: ${file}`, {
        code: "REVIEW_EVIDENCE_UNSUPPORTED",
      });
    }
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new AutopilotError(`New non-UTF-8 file requires a specialized deterministic review gate: ${file}`, {
        code: "REVIEW_EVIDENCE_UNSUPPORTED",
      });
    }
    const text = decoded.replace(/\r\n/g, "\n");
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const mode = intendedModes.has(file)
      ? intendedModes.get(file) ? "100755" : "100644"
      : (info.mode & 0o111) === 0 ? "100644" : "100755";
    sections.push([
      `diff --git a/${file} b/${file}`,
      `new file mode ${mode}`,
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      ...(text && !text.endsWith("\n") ? ["\\ No newline at end of file"] : []),
      "",
    ].join("\n"));
    if (utf8Bytes(sections.filter(Boolean).join("\n")) > maxBytes) {
      throw new AutopilotError(`Complete review evidence exceeds ${maxBytes} bytes`, {
        code: "REVIEW_EVIDENCE_TOO_LARGE",
      });
    }
  }
  if (normalizedIntents.length > 0) {
    const modeLines = ["# Controller-validated executable mode intents"];
    for (const intent of normalizedIntents) {
      const entry = await baselineEntry(project.root, baseline, intent.path);
      modeLines.push(`${intent.path}: ${entry?.mode ?? "untracked"} -> ${intent.executable ? "100755" : "100644"}`);
    }
    sections.push(`${modeLines.join("\n")}\n`);
  }
  const evidence = sections.filter(Boolean).join("\n");
  if (utf8Bytes(evidence) > maxBytes) {
    throw new AutopilotError(`Complete review evidence exceeds ${maxBytes} bytes`, {
      code: "REVIEW_EVIDENCE_TOO_LARGE",
    });
  }
  return evidence;
}

function assertExactFiles(actual, expected, label) {
  const left = unique(actual.map(normalizeRelative)).sort();
  const right = unique(expected.map(normalizeRelative)).sort();
  if (stableJson(left) !== stableJson(right)) {
    throw new AutopilotError(
      `${label} paths differ (expected: ${right.join(", ") || "none"}; actual: ${left.join(", ") || "none"})`,
      { code: "GIT_TRANSACTION_CONFLICT", details: { expected: right, actual: left } },
    );
  }
}

export async function assertFilesMatchTree(project, tree, files) {
  for (const file of files) {
    const entry = await baselineEntry(project.root, tree, file);
    const absolute = resolveInside(project.root, file, "prepared working file");
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (entry !== null) {
        throw new AutopilotError(`Prepared tree retained deleted working file ${file}`, {
          code: "GIT_TRANSACTION_CONFLICT",
        });
      }
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Prepared tree source is not a private regular file: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    await assertRealInside(project.root, absolute, `prepared working file ${file}`);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new AutopilotError(`Prepared tree has an unsupported or missing entry for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    const rawBlob = (await git(project.root, ["hash-object", "--no-filters", "--", file])).stdout.trim();
    if (rawBlob !== entry.object) {
      throw new AutopilotError(
        `Prepared Git blob differs from the exact reviewed working bytes for ${file}`,
        { code: "GIT_TRANSACTION_CONFLICT", details: { file } },
      );
    }
  }
}

function normalizedExpectedFileHashes(files, expectedFileSha256) {
  if (expectedFileSha256 === undefined) return null;
  if (!expectedFileSha256 || typeof expectedFileSha256 !== "object" || Array.isArray(expectedFileSha256)) {
    throw new AutopilotError("Expected commit-file hashes must be an object", {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  const expectedFiles = unique(files.map(normalizeRelative)).sort();
  const entries = Object.entries(expectedFileSha256).map(([file, digest]) => [normalizeRelative(file), digest]);
  const normalized = Object.fromEntries(entries);
  assertExactFiles(Object.keys(normalized), expectedFiles, "Hash-bound commit");
  for (const [file, digest] of Object.entries(normalized)) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new AutopilotError(`Expected commit-file hash is invalid for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
  }
  return normalized;
}

async function assertExpectedWorkingFileHashes(project, expectedFileSha256, label) {
  if (!expectedFileSha256) return;
  for (const [file, expectedDigest] of Object.entries(expectedFileSha256)) {
    const absolute = resolveInside(project.root, file, "hash-bound commit file");
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new AutopilotError(`${label} file disappeared before commit staging: ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
        details: { file },
      });
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new AutopilotError(`Hash-bound commit source is not a private regular file: ${file}`, {
        code: "UNSAFE_CHANGED_FILE_TYPE",
      });
    }
    await assertRealInside(project.root, absolute, `hash-bound commit file ${file}`);
    let actualDigest;
    try {
      actualDigest = await sha256File(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new AutopilotError(`${label} file disappeared while it was hashed: ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
        details: { file },
      });
    }
    if (actualDigest !== expectedDigest) {
      throw new AutopilotError(`${label} bytes differ from the persisted hash for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
        details: { file, expected_sha256: expectedDigest, actual_sha256: actualDigest },
      });
    }
  }
}

async function assertTreeMatchesExpectedFileHashes(project, tree, expectedFileSha256) {
  if (!expectedFileSha256) return;
  await assertExpectedWorkingFileHashes(project, expectedFileSha256, "Prepared working");
  for (const file of Object.keys(expectedFileSha256)) {
    const entry = await baselineEntry(project.root, tree, file);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new AutopilotError(`Prepared tree has no supported hash-bound blob for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
      });
    }
    const rawBlob = (await git(project.root, ["hash-object", "--no-filters", "--", file])).stdout.trim();
    if (rawBlob !== entry.object) {
      throw new AutopilotError(`Prepared tree blob differs from the persisted bytes for ${file}`, {
        code: "GIT_TRANSACTION_CONFLICT",
        details: { file },
      });
    }
  }
  await assertExpectedWorkingFileHashes(project, expectedFileSha256, "Post-tree working");
}

async function injectPrepareRaceForTest(project, expectedFileSha256, testRaceLabel) {
  if (process.env.NODE_ENV !== "test" || !expectedFileSha256) return;
  if (!testRaceLabel || process.env.AUTOPILOT_TEST_PREPARE_RACE_LABEL !== testRaceLabel) return;
  const requested = process.env.AUTOPILOT_TEST_PREPARE_RACE_FILE;
  if (!requested) return;
  const file = normalizeRelative(requested);
  if (!Object.hasOwn(expectedFileSha256, file)) return;
  await appendFile(resolveInside(project.root, file, "prepare race test file"), " ", "utf8");
}

async function assertTreeModeIntents(root, tree, modeIntents) {
  for (const intent of normalizedModeIntents(modeIntents)) {
    const entry = await baselineEntry(root, tree, intent.path);
    const expectedMode = intent.executable ? "100755" : "100644";
    if (!entry || entry.type !== "blob" || entry.mode !== expectedMode) {
      throw new AutopilotError(`Prepared tree mode disagrees with intent for ${intent.path}`, {
        code: "GIT_TRANSACTION_CONFLICT",
        details: { path: intent.path, expected_mode: expectedMode, actual_mode: entry?.mode ?? null },
      });
    }
  }
}

export async function prepareCommitTree(project, parentCommit, files, {
  expectedFileSha256,
  testRaceLabel = null,
  modeIntents = [],
} = {}) {
  const head = await gitHead(project.root);
  if (head !== parentCommit) {
    throw new AutopilotError(`Cannot prepare commit: HEAD ${head} is not expected parent ${parentCommit}`, {
      code: "GIT_HEAD_CHANGED",
    });
  }
  const expected = unique(files.map(normalizeRelative)).sort();
  const normalizedIntents = normalizedModeIntents(modeIntents);
  for (const intent of normalizedIntents) {
    if (!expected.includes(intent.path)) {
      throw new AutopilotError(`Prepared mode intent is outside the exact file set: ${intent.path}`, {
        code: "MODE_INTENT_INVALID",
      });
    }
  }
  const expectedHashes = normalizedExpectedFileHashes(expected, expectedFileSha256);
  await assertExpectedWorkingFileHashes(project, expectedHashes, "Pre-stage working");
  const stagedBefore = await gitStagedFiles(project.root, parentCommit);
  if (stagedBefore.length > 0 && normalizedIntents.length === 0) {
    assertExactFiles(stagedBefore, expected, "Recovered staged transaction");
  } else if (stagedBefore.some((file) => !expected.includes(file))) {
    throw new AutopilotError("Recovered staged transaction contains an unexpected path", {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  if ((stagedBefore.length === 0 || normalizedIntents.length > 0) && expected.length > 0) {
    await injectPrepareRaceForTest(project, expectedHashes, testRaceLabel);
    await stageRawIndexFiles(project, parentCommit, expected, normalizedIntents);
  }
  const staged = await gitStagedFiles(project.root, parentCommit);
  assertExactFiles(staged, expected, "Prepared commit");
  await assertExpectedWorkingFileHashes(project, expectedHashes, "Post-stage working");
  const unstaged = await gitUnstagedFiles(project.root, expected);
  if (unstaged.length > 0) {
    throw new AutopilotError(`Prepared files changed after staging: ${unstaged.join(", ")}`, {
      code: "GIT_TRANSACTION_CONFLICT",
      details: unstaged,
    });
  }
  const tree = (await git(project.root, ["write-tree"])).stdout.trim();
  await assertFilesMatchTree(project, tree, expected);
  await assertTreeModeIntents(project.root, tree, normalizedIntents);
  await assertTreeMatchesExpectedFileHashes(project, tree, expectedHashes);
  const baselineTree = await gitTree(project.root, parentCommit);
  return {
    parent_commit: parentCommit,
    baseline_tree: baselineTree,
    result_tree: tree,
    diff_sha256: canonicalTreeTransitionHash(baselineTree, tree),
  };
}

export async function createCommitObject(project, tree, parentCommit, message) {
  const result = await git(project.root, ["commit-tree", tree, "-p", parentCommit], {
    input: `${message}\n`,
    env: {
      GIT_AUTHOR_DATE: new Date().toISOString(),
      GIT_COMMITTER_DATE: new Date().toISOString(),
    },
  });
  return result.stdout.trim();
}

export async function verifyCommitTransition(project, {
  baselineCommit,
  resultCommit,
  expectedFiles,
  baselineTree,
  resultTree,
  diffSha256,
  modeIntents = [],
}) {
  const parentLine = (await git(project.root, ["rev-list", "--parents", "-n", "1", resultCommit])).stdout.trim();
  const parents = parentLine.split(/\s+/).filter(Boolean);
  if (parents.length !== 2 || parents[0] !== resultCommit || parents[1] !== baselineCommit) {
    throw new AutopilotError(`Commit ${resultCommit} is not a single-parent child of ${baselineCommit}`, {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  const actualBaselineTree = await gitTree(project.root, baselineCommit);
  const actualResultTree = await gitTree(project.root, resultCommit);
  if (actualBaselineTree !== baselineTree || actualResultTree !== resultTree) {
    throw new AutopilotError("Committed trees differ from the accepted completion transaction", {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  const actualHash = canonicalTreeTransitionHash(actualBaselineTree, actualResultTree);
  if (actualHash !== diffSha256) {
    throw new AutopilotError("Canonical committed diff hash differs from accepted evidence", {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  const changed = await revisionChangedFiles(project.root, baselineCommit, resultCommit);
  assertExactFiles(changed, expectedFiles, "Committed transition");
  await assertTreeModeIntents(project.root, resultCommit, normalizedModeIntents(modeIntents));
  return { baseline_tree: actualBaselineTree, result_tree: actualResultTree, diff_sha256: actualHash };
}

export async function moveHead(project, expectedCommit, resultCommit, reason) {
  const head = await gitHead(project.root);
  if (head === resultCommit) return resultCommit;
  if (head !== expectedCommit) {
    throw new AutopilotError(`Cannot advance HEAD from unexpected commit ${head}`, {
      code: "GIT_HEAD_CHANGED",
      details: { expected: expectedCommit, actual: head, result: resultCommit },
    });
  }
  await git(project.root, ["update-ref", "-m", reason, "HEAD", resultCommit, expectedCommit]);
  const moved = await gitHead(project.root);
  if (moved !== resultCommit) {
    throw new AutopilotError(`Git HEAD did not advance to planned commit ${resultCommit}`, {
      code: "GIT_TRANSACTION_CONFLICT",
    });
  }
  return moved;
}

export async function isAncestor(project, ancestor, descendant = "HEAD") {
  const result = await git(project.root, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
    maxOutputBytes: 8 * 1024,
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new AutopilotError(`Could not verify Git ancestry for ${ancestor}`, {
    code: "GIT_FAILED",
  });
}

export async function commitFiles(project, files, message) {
  if (files.length === 0) return gitHead(project.root);
  const intended = new Set(files.map(normalizeRelative));
  const stagedBefore = nulList((await git(project.root, ["diff", "--cached", "--name-only", "-z"])).stdout);
  const unexpected = stagedBefore.filter((file) => !intended.has(file));
  if (unexpected.length > 0) {
    throw new AutopilotError(`Git index contains paths outside this commit: ${unexpected.join(", ")}`, {
      code: "STAGED_PATH_VIOLATION",
      details: unexpected,
    });
  }
  await stageRawIndexFiles(project, "HEAD", files);
  const commit = await git(project.root, [
    "commit",
    "-m",
    message,
  ], { allowFailure: true });
  if (commit.code !== 0) {
    await git(project.root, ["reset", "--", ...files], { allowFailure: true });
    throw new AutopilotError(`Local commit failed: ${commit.stderr || commit.stdout}`, {
      code: "COMMIT_FAILED",
    });
  }
  return gitHead(project.root);
}
