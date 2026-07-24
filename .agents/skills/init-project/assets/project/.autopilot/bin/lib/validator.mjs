import { lstat, opendir, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CONTEXT_PHASES,
  expandTaskReferences,
  validateConfig,
  validateCredentials,
  validateGates,
  validateManifest,
  validateQueue,
  validateReference,
  validateState,
} from "./contracts.mjs";
import { buildContextSizeReport } from "./context-pack.mjs";
import { assertRealInside, exists, normalizeRelative, readUtf8, stableJson } from "./core.mjs";
import {
  canonicalBaseGitignoreIsLast,
  hasCanonicalBaseGitignore,
  REQUIRED_IGNORED_PATHS,
  REQUIRED_VISIBLE_PATHS,
} from "./gitignore.mjs";
import { loadContracts, loadProject, taskEntries } from "./project.mjs";
import { assertCleanStart, assertGitRepository, gitHead } from "./git.mjs";
import {
  externalExecutionEnv,
  resolveExternalGitExecutable,
  runArgv,
  safeBaseEnv,
} from "./process.mjs";
import { exactSecretMatches, secretMatches } from "./secrets.mjs";
import {
  collectMcpEnvironmentReferences,
  validateMcpDescriptors,
} from "./mcp.mjs";
import {
  PHASES,
  resolveTaskPhaseCapabilities,
  ROLE_NAMES,
  validateRoleToolPolicy,
} from "./tool-grants.mjs";
import {
  assertExactTaskPrefixCoverage,
  normalizeGitCommitConfig,
} from "./commit-policy.mjs";

const PLACEHOLDERS = [
  { name: "bracket placeholder", pattern: /\[(?:insert|replace|describe|choose|todo|tbd|your\b)[^\]]*\]/gi },
  { name: "template expression", pattern: /\{\{[^{}\n]+\}\}/g },
  { name: "change-me marker", pattern: /\b(?:CHANGE[_ -]?ME|TBD|FILL[_ -]?ME)\b/g },
];

const DURABLE_CONTROL_FILE_CAP = 1024 * 1024;
const DURABLE_CONTROL_TOTAL_CAP = 32 * 1024 * 1024;
const GITIGNORE_FILE_CAP = 1024 * 1024;
const ROOT_ENV_FILE_MAX_COUNT = 64;
const ROOT_ENV_FILE_MAX_NAME_BYTES = 512;
const ROOT_ENV_FILE_TOTAL_NAME_BYTES = 16 * 1024;
const CONTROL_PLANE_MANIFEST_CAP = 512 * 1024;
const CONTROL_PLANE_FILE_CAP = 2 * 1024 * 1024;
const ROLE_BEGIN = "# BEGIN AUTOPILOT MANAGED TOOL GRANTS";
const ROLE_END = "# END AUTOPILOT MANAGED TOOL GRANTS";
const IGNORE_BEGIN = "# BEGIN OPENCODE CONTROL PLANE MANAGED";
const IGNORE_END = "# END OPENCODE CONTROL PLANE MANAGED";

async function actualRootEnvironmentPaths(root, issues) {
  const ignored = [];
  const visible = [];
  let totalBytes = 0;
  let invalid = false;
  for await (const entry of await opendir(root)) {
    const name = entry.name;
    if (!name.startsWith(".env")) continue;
    if (/[\0-\x1f\x7f]/.test(name)) {
      issues.push({
        severity: "error",
        location: ".gitignore",
        message: "root environment filenames cannot contain control characters",
      });
      invalid = true;
      continue;
    }
    if (!(name === ".env" || name.startsWith(".env.") || /^\.env.*\.local$/.test(name))) continue;
    const bytes = Buffer.byteLength(name, "utf8");
    if (bytes > ROOT_ENV_FILE_MAX_NAME_BYTES) {
      issues.push({
        severity: "error",
        location: ".gitignore",
        message: `root environment filename exceeds ${ROOT_ENV_FILE_MAX_NAME_BYTES} bytes`,
      });
      invalid = true;
      continue;
    }
    if (ignored.length + visible.length >= ROOT_ENV_FILE_MAX_COUNT) {
      issues.push({
        severity: "error",
        location: ".gitignore",
        message: `root environment files exceed the ${ROOT_ENV_FILE_MAX_COUNT}-entry policy-check cap`,
      });
      return null;
    }
    totalBytes += bytes;
    if (totalBytes > ROOT_ENV_FILE_TOTAL_NAME_BYTES) {
      issues.push({
        severity: "error",
        location: ".gitignore",
        message: `root environment filenames exceed the ${ROOT_ENV_FILE_TOTAL_NAME_BYTES}-byte aggregate cap`,
      });
      return null;
    }
    (name === ".env.example" ? visible : ignored).push(name);
  }
  return invalid ? null : { ignored, visible };
}

async function validateGitignorePolicy(project, issues, { requireGit = false } = {}) {
  const relative = ".gitignore";
  const absolute = path.join(project.root, relative);
  let text;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      throw new Error("must be one private regular file");
    }
    text = await readUtf8(absolute, { maxBytes: GITIGNORE_FILE_CAP });
  } catch (error) {
    issues.push({ severity: "error", location: relative, message: error.message });
    return;
  }
  if (!hasCanonicalBaseGitignore(text)) {
    issues.push({
      severity: "error",
      location: relative,
      message: "canonical OpenCode autopilot base ignore fragment is missing or has drifted",
    });
  } else if (!canonicalBaseGitignoreIsLast(text)) {
    issues.push({
      severity: "error",
      location: relative,
      message: "canonical OpenCode autopilot base ignore fragment must be the final ignore block",
    });
  }

  const actualEnvironment = await actualRootEnvironmentPaths(project.root, issues);
  if (!actualEnvironment) return;

  const localGit = path.join(project.root, ".git");
  if (!(await exists(localGit))) {
    if (requireGit) {
      issues.push({
        severity: "error",
        location: relative,
        message: "effective ignore policy cannot be verified without a local Git repository",
      });
    }
    return;
  }

  const requiredIgnored = [...new Set([...REQUIRED_IGNORED_PATHS, ...actualEnvironment.ignored])];
  const requiredVisible = [...new Set([...REQUIRED_VISIBLE_PATHS, ...actualEnvironment.visible])];
  const candidates = [...requiredIgnored, ...requiredVisible];
  let result;
  try {
    const executionEnv = await externalExecutionEnv(project.root);
    const executable = await resolveExternalGitExecutable(project.root, executionEnv, {
      label: "project validator Git executable",
    });
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    result = await runArgv([
      executable,
      "--no-pager",
      "--no-replace-objects",
      "-c", `core.hooksPath=${nullDevice}`,
      "-c", "core.fsmonitor=false",
      "-c", `core.attributesFile=${nullDevice}`,
      "-c", `core.excludesFile=${nullDevice}`,
      "check-ignore",
      "--no-index",
      "--",
      ...candidates,
    ], {
      cwd: project.root,
      env: {
        ...executionEnv,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: nullDevice,
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
      },
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      guardProcessTree: true,
    });
  } catch (error) {
    issues.push({ severity: "error", location: relative, message: `effective ignore check failed: ${error.message}` });
    return;
  }
  if (result.output_truncated || ![0, 1].includes(result.code)) {
    const detail = String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").trim().slice(0, 2048);
    issues.push({
      severity: "error",
      location: relative,
      message: result.output_truncated
        ? "effective Git ignore check output exceeded its cap"
        : `git check-ignore failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`,
    });
    return;
  }
  const ignored = new Set(result.stdout.split(/\r?\n/).filter(Boolean).map(normalizeRelative));
  const missing = requiredIgnored.filter((candidate) => !ignored.has(candidate));
  const hidden = requiredVisible.filter((candidate) => ignored.has(candidate));
  if (missing.length > 0) {
    issues.push({
      severity: "error",
      location: relative,
      message: `required sensitive/control paths are not effectively ignored: ${missing.join(", ")}`,
    });
  }
  if (hidden.length > 0) {
    issues.push({
      severity: "error",
      location: relative,
      message: `required durable examples/control paths are unexpectedly ignored: ${hidden.join(", ")}`,
    });
  }
}

async function validatePhaseIsolation(project, queue, credentials, issues) {
  try {
    const [openCodeText, toolsText] = await Promise.all([
      readUtf8(path.join(project.root, "opencode.jsonc"), { maxBytes: 256 * 1024 }),
      readUtf8(path.join(project.root, ".project", "tools.json"), { maxBytes: 64 * 1024 }),
    ]);
    const openCode = JSON.parse(openCodeText);
    const tools = validateRoleToolPolicy(JSON.parse(toolsText));
    const configuredMcp = openCode.mcp ?? {};
    const mcp = validateMcpDescriptors(configuredMcp, {
      location: "opencode.jsonc.mcp",
      providerEnvironment: project.config.opencode?.provider_environment ?? [],
    });
    if (stableJson(configuredMcp) !== stableJson(mcp)) {
      throw new Error("opencode.jsonc.mcp must use the canonical descriptor form produced by /init-project");
    }
    const names = Object.keys(mcp);
    for (const role of ROLE_NAMES) {
      const grants = tools.roles[role];
      for (const grant of grants) {
        const matches = names.filter((name) => grant === name || grant.startsWith(`${name}_`));
        if (matches.length !== 1) {
          issues.push({ severity: "error", location: `.project/tools.json.roles.${role}`, message: `${grant} must map to exactly one MCP server` });
        }
      }
    }
    const requiredByPhase = Object.fromEntries(PHASES.map((phase) => [phase, new Set()]));
    const selectedServers = new Set();
    for (const [taskId, task] of taskEntries(queue)) {
      for (const phase of PHASES) {
        let capabilities;
        try {
          capabilities = resolveTaskPhaseCapabilities({ toolPolicy: tools, task, phase, mcp });
        } catch (error) {
          issues.push({
            severity: "error",
            location: `queue.tasks.${taskId}.tool_grants.${phase}`,
            message: error.message,
          });
          continue;
        }
        for (const variable of capabilities.credential_names) requiredByPhase[phase].add(variable);
        for (const server of capabilities.server_names) selectedServers.add(server);
      }
    }
    for (const phase of PHASES) {
      const profileName = project.config.opencode?.credential_profiles?.[phase];
      if (profileName && !credentials.profiles?.[profileName]) {
        issues.push({
          severity: "error",
          location: `config.opencode.credential_profiles.${phase}`,
          message: `references missing credential profile ${profileName}`,
        });
      }
      const allowed = new Set(profileName ? credentials.profiles?.[profileName]?.allow ?? [] : []);
      if (stableJson([...requiredByPhase[phase]].sort()) !== stableJson([...allowed].sort())) {
        issues.push({
          severity: "error",
          location: `config.opencode.credential_profiles.${phase}`,
          message: "must exactly cover credential references reachable by this phase's task grants",
        });
      }
    }
    for (const [name, server] of Object.entries(mcp)) {
      if (collectMcpEnvironmentReferences(server).size > 0 && !selectedServers.has(name)) {
        issues.push({
          severity: "error",
          location: `opencode.jsonc.mcp.${name}`,
          message: "credential-bearing MCP server is not granted to any task phase",
        });
      }
    }
  } catch (error) {
    issues.push({ severity: "error", location: "phase policy boundary", message: error.message });
  }
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanText(relative, text, { placeholders = true, secrets = true } = {}) {
  const issues = [];
  if (placeholders) {
    for (const scanner of PLACEHOLDERS) {
      scanner.pattern.lastIndex = 0;
      let count = 0;
      for (const match of text.matchAll(scanner.pattern)) {
        issues.push({
          severity: "error",
          location: `${relative}:${lineNumber(text, match.index)}`,
          message: `Unresolved ${scanner.name}`,
        });
        count += 1;
        if (count >= 64) break;
      }
    }
  }
  if (secrets) {
    for (const match of secretMatches(text)) {
      issues.push({
        severity: "error",
        location: `${relative}:${lineNumber(text, match.index)}`,
        message: `Possible ${match.name}; value intentionally omitted`,
      });
    }
  }
  return issues;
}

async function checkFile(project, absolute, relative, maxBytes, issues, options = {}) {
  try {
    const lexical = await lstat(absolute);
    if (!lexical.isFile() || lexical.isSymbolicLink() || Number(lexical.nlink) > 1) {
      issues.push({
        severity: "error",
        location: relative,
        message: Number(lexical.nlink) > 1
          ? "Context references cannot be hard links"
          : "Context references must be regular non-link files",
      });
      return null;
    }
    const real = await assertRealInside(project.root, absolute, relative);
    validateReference(project.root, normalizeRelative(path.relative(project.root, real)));
    const info = await lstat(real);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) {
      issues.push({ severity: "error", location: relative, message: "Reference is not a private regular file" });
      return null;
    }
    if (info.size > maxBytes) {
      issues.push({ severity: "error", location: relative, message: `${info.size} bytes exceeds cap ${maxBytes}` });
      return null;
    }
    const text = await readUtf8(real);
    issues.push(...scanText(relative, text, options));
    return text;
  } catch (error) {
    issues.push({ severity: "error", location: relative, message: error.message });
    return null;
  }
}

async function durableControlFiles(project, issues) {
  const discovered = new Map();
  const addFile = async (absolute, relative, { optional = false } = {}) => {
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (optional && error?.code === "ENOENT") return;
      issues.push({ severity: "error", location: relative, message: error.message });
      return;
    }
    if (info.isSymbolicLink()) {
      issues.push({ severity: "error", location: relative, message: "Durable control files cannot be symbolic links" });
      return;
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        await addFile(path.join(absolute, name), `${normalizeRelative(relative)}/${name}`);
      }
      return;
    }
    if (!info.isFile()) {
      issues.push({ severity: "error", location: relative, message: "Durable control reference is not a regular file" });
      return;
    }
    discovered.set(normalizeRelative(relative), { absolute, size: info.size });
  };

  await addFile(path.join(project.root, "AGENTS.md"), "AGENTS.md", { optional: true });
  await addFile(path.join(project.root, ".ignore"), ".ignore", { optional: true });
  await addFile(path.join(project.root, "opencode.jsonc"), "opencode.jsonc", { optional: true });
  await addFile(path.join(project.root, "opencode.json"), "opencode.json", { optional: true });
  await addFile(project.paths.config, project.relative.config);
  await addFile(path.join(project.root, ".autopilot", "control-plane.json"), ".autopilot/control-plane.json", { optional: true });
  await addFile(path.join(project.root, ".project"), ".project");

  let total = 0;
  for (const [relative, entry] of [...discovered.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (entry.size > DURABLE_CONTROL_FILE_CAP) {
      issues.push({
        severity: "error",
        location: relative,
        message: `${entry.size} bytes exceeds durable control scan cap ${DURABLE_CONTROL_FILE_CAP}`,
      });
      continue;
    }
    total += entry.size;
    if (total > DURABLE_CONTROL_TOTAL_CAP) {
      issues.push({
        severity: "error",
        location: ".project",
        message: `Durable control text exceeds aggregate scan cap ${DURABLE_CONTROL_TOTAL_CAP}`,
      });
      break;
    }
    try {
      const real = await assertRealInside(project.root, entry.absolute, relative);
      const text = await readUtf8(real, { maxBytes: DURABLE_CONTROL_FILE_CAP });
      if (text.includes("\0")) {
        issues.push({ severity: "error", location: relative, message: "Durable control files must be UTF-8 text" });
        continue;
      }
      issues.push(...scanText(relative, text, { placeholders: false, secrets: true }));
    } catch (error) {
      issues.push({ severity: "error", location: relative, message: error.message });
    }
  }
}

async function validateControlPlaneOwnership(project, issues) {
  const relative = ".autopilot/control-plane.json";
  const absolute = path.join(project.root, ".autopilot", "control-plane.json");
  let manifest;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > CONTROL_PLANE_MANIFEST_CAP) {
      throw new Error("must be one bounded private regular file");
    }
    manifest = JSON.parse(await readUtf8(absolute, { maxBytes: CONTROL_PLANE_MANIFEST_CAP }));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const modernMarkers = [
        path.join(project.root, "control-plane"),
        path.join(project.root, "control-plane.cmd"),
        path.join(project.root, ".autopilot", "bin", "control-plane.mjs"),
      ];
      if (!(await Promise.all(modernMarkers.map((item) => exists(item)))).some(Boolean)) return;
    }
    issues.push({ severity: "error", location: relative, message: error.message });
    return;
  }
  if (
    manifest.schema_version !== 1 ||
    manifest.product_id !== "opencode-control-plane" ||
    manifest.name !== "OpenCode Control Plane" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "") ||
    manifest.repository !== "https://github.com/therealedo/opencode-control-plane.git" ||
    typeof manifest.identity !== "string" ||
    !manifest.managed_files ||
    typeof manifest.managed_files !== "object" ||
    Array.isArray(manifest.managed_files) ||
    Object.keys(manifest.managed_files).length > 256 ||
    !Array.isArray(manifest.migration_history)
  ) {
    issues.push({ severity: "error", location: relative, message: "Control Plane ownership metadata is invalid" });
    return;
  }
  const folded = new Set();
  for (const [managed, record] of Object.entries(manifest.managed_files)) {
    const location = `${relative}.managed_files.${managed}`;
    if (!safeManagedPath(managed)) {
      issues.push({ severity: "error", location, message: "contains an unsafe or unclassified managed path" });
      continue;
    }
    const key = managed.toLowerCase();
    if (folded.has(key)) {
      issues.push({ severity: "error", location, message: "case-collides with another managed path" });
      continue;
    }
    folded.add(key);
    if (!record || !["exact", "normalized-role", "managed-block"].includes(record.mode) || !/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) {
      issues.push({ severity: "error", location, message: "contains an invalid ownership record" });
      continue;
    }
    const file = path.resolve(project.root, ...managed.split("/"));
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > CONTROL_PLANE_FILE_CAP) {
        throw new Error("managed target must be one bounded private regular file");
      }
      await assertRealInside(project.root, file, managed);
      const bytes = await readFile(file);
      if (managedHash(record.mode, bytes) !== record.sha256) {
        issues.push({ severity: "error", location: managed, message: "managed Control Plane file drifted outside the upgrade system" });
      }
    } catch (error) {
      issues.push({ severity: "error", location: managed, message: error.message });
    }
  }
}

function safeManagedPath(relative) {
  return Boolean(
    typeof relative === "string" &&
    relative &&
    !relative.includes("\\") &&
    !relative.includes("\0") &&
    !path.posix.isAbsolute(relative) &&
    !relative.split("/").some((part) => !part || part === "." || part === "..") &&
    (
      [".gitattributes", "AGENTS.md", ".ignore", "control-plane", "control-plane.cmd"].includes(relative) ||
      relative.startsWith(".autopilot/bin/") ||
      relative.startsWith(".opencode/agents/") ||
      relative.startsWith(".opencode/commands/")
    )
  );
}

function managedHash(mode, bytes) {
  const text = bytes.toString("utf8");
  let value = bytes;
  if (mode === "normalized-role") value = Buffer.from(normalizeManagedSection(text, ROLE_BEGIN, ROLE_END), "utf8");
  else if (mode === "managed-block") value = Buffer.from(extractManagedSection(text, IGNORE_BEGIN, IGNORE_END), "utf8");
  return createHash("sha256").update(value).digest("hex");
}

function managedSectionBounds(text, begin, end) {
  const first = text.indexOf(begin);
  const last = text.indexOf(end);
  if (first < 0 || last < first || text.indexOf(begin, first + begin.length) >= 0 || text.indexOf(end, last + end.length) >= 0) {
    throw new Error(`managed markers must occur exactly once and in order: ${begin}`);
  }
  return { first, finish: last + end.length };
}

function normalizeManagedSection(text, begin, end) {
  const { first, finish } = managedSectionBounds(text, begin, end);
  return `${text.slice(0, first)}${begin}\n<managed>\n${end}${text.slice(finish)}`;
}

function extractManagedSection(text, begin, end) {
  const { first, finish } = managedSectionBounds(text, begin, end);
  return text.slice(first, finish);
}

export async function scanFilesForSecrets(root, relativeFiles, { exactSecrets = [] } = {}) {
  const issues = [];
  for (const relative of relativeFiles) {
    const normalized = normalizeRelative(relative);
    const absolute = path.resolve(root, normalized);
    if (!(await exists(absolute))) continue;
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      issues.push({ severity: "error", location: normalized, message: "Secret scan requires a regular non-link file" });
      continue;
    }
    if (info.size > 1024 * 1024) {
      issues.push({
        severity: "error",
        location: normalized,
        message: `${info.size} bytes exceeds the 1048576-byte secret-scan cap; split or explicitly classify the file`,
      });
      continue;
    }
    try {
      await assertRealInside(root, absolute, `secret-scan file ${normalized}`);
    } catch (error) {
      issues.push({ severity: "error", location: normalized, message: error.message });
      continue;
    }
    const text = await readUtf8(absolute);
    issues.push(...scanText(normalized, text, { placeholders: false, secrets: true }));
    for (const match of exactSecretMatches(text, exactSecrets)) {
      issues.push({
        severity: "error",
        location: `${normalized}:${lineNumber(text, match.index)}`,
        message: "Exact ephemeral credential value detected; value intentionally omitted",
        code: "EXACT_SECRET",
      });
    }
  }
  return issues;
}

async function validateBlueprintLifecycle(root, issues) {
  const files = {
    blueprint: path.join(root, "blueprints", "current", "blueprint.json"),
    record: path.join(root, "blueprints", "current", "record.json"),
    memory: path.join(root, "blueprints", "current", "project-memory.json"),
    history: path.join(root, "blueprints", "history.json"),
    manifest: path.join(root, "blueprints", "current", "render-manifest.json"),
  };
  let blueprint;
  let record;
  let memory;
  let history;
  let blueprintRaw;
  try {
    for (const [name, file] of Object.entries(files)) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > DURABLE_CONTROL_FILE_CAP) {
        throw new Error(`${name} must be one bounded private regular file`);
      }
    }
    blueprintRaw = await readUtf8(files.blueprint, { maxBytes: DURABLE_CONTROL_FILE_CAP });
    blueprint = JSON.parse(blueprintRaw);
    record = JSON.parse(await readUtf8(files.record, { maxBytes: DURABLE_CONTROL_FILE_CAP }));
    memory = JSON.parse(await readUtf8(files.memory, { maxBytes: DURABLE_CONTROL_FILE_CAP }));
    history = JSON.parse(await readUtf8(files.history, { maxBytes: DURABLE_CONTROL_FILE_CAP }));
  } catch (error) {
    issues.push({ severity: "error", location: "blueprints/current", message: error.message });
    return;
  }
  if (
    ![5, 6].includes(blueprint?.schema_version) || record?.schema_version !== 1 || record.status !== "active" ||
    memory?.schema_version !== 1 || history?.schema_version !== 1 ||
    !Number.isInteger(record.version) || record.version < 1 ||
    history.current_version !== record.version || memory.current_blueprint_version !== record.version
  ) {
    issues.push({ severity: "error", location: "blueprints/current", message: "blueprint lifecycle metadata is inconsistent" });
    return;
  }
  const hash = createHash("sha256").update(stableJson(blueprint)).digest("hex");
  if (record.blueprint_sha256 !== hash) {
    issues.push({ severity: "error", location: "blueprints/current/record.json", message: "blueprint hash does not match the active contract" });
  }
  const versionFile = path.join(root, "blueprints", `v${record.version}`, "blueprint.json");
  try {
    const versionBlueprint = JSON.parse(await readUtf8(versionFile, { maxBytes: DURABLE_CONTROL_FILE_CAP }));
    if (stableJson(versionBlueprint) !== stableJson(blueprint)) {
      issues.push({ severity: "error", location: `blueprints/v${record.version}/blueprint.json`, message: "immutable version differs from current blueprint" });
    }
  } catch (error) {
    issues.push({ severity: "error", location: `blueprints/v${record.version}/blueprint.json`, message: error.message });
  }
  issues.push(...scanText("blueprints/current/blueprint.json", blueprintRaw, { placeholders: false, secrets: true }));
}

export async function validateProject(root, {
  taskId = null,
  strict = false,
  checkGit = strict,
} = {}) {
  const issues = [];
  let project;
  let contracts;
  try {
    project = await loadProject(root);
    contracts = await loadContracts(project);
  } catch (error) {
    return { ok: false, issues: [{ severity: "error", location: "structure", message: error.message }] };
  }

  const { manifest, queue, gates, credentials, state } = contracts;
  for (const item of [
    ...validateConfig(project.config),
    ...validateManifest(manifest),
    ...validateCredentials(credentials),
    ...validateGates(gates, credentials),
    ...validateQueue(queue, manifest, gates, {
      strict,
      ephemeralRoots: Array.isArray(project.config.git?.ephemeral_roots)
        ? project.config.git.ephemeral_roots
        : [],
    }),
    ...validateState(state),
  ]) {
    issues.push({ severity: "error", ...item });
  }
  const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (
    !record(manifest) ||
    !record(manifest.bundles) ||
    !record(queue) ||
    !record(queue.tasks) ||
    !record(gates) ||
    !record(gates.gates) ||
    !record(credentials) ||
    !record(credentials.profiles) ||
    !record(state)
  ) {
    return {
      ok: false,
      issues,
      context_cap_bytes: null,
    };
  }
  try {
    const commitPolicy = normalizeGitCommitConfig(project.config.git);
    if (commitPolicy.mode === "mapped") {
      assertExactTaskPrefixCoverage(
        commitPolicy.prefixes,
        Object.keys(queue.tasks),
        "config.git.commit_prefixes",
      );
    }
  } catch (error) {
    issues.push({ severity: "error", location: "config.git", message: error.message });
  }
  if (state.active_task !== null && state.active_task !== undefined && !queue.tasks[state.active_task]) {
    issues.push({
      severity: "error",
      location: "state.active_task",
      message: `references unknown queue task ${state.active_task}`,
    });
  }
  if (state.completion && state.completion.task_id !== state.active_task) {
    issues.push({
      severity: "error",
      location: "state.completion",
      message: "must belong to state.active_task",
    });
  }
  if (state.finalization && state.active_task) {
    issues.push({
      severity: "error",
      location: "state.finalization",
      message: "cannot coexist with an active task",
    });
  }
  for (const phase of ["execute", "repair", "review"]) {
    const profileName = project.config.opencode?.credential_profiles?.[phase];
    if (profileName) {
      const profile = credentials.profiles[profileName];
      if (!profile || stableJson(profile.allowed_gates) !== stableJson(["opencode"])) {
        issues.push({
          severity: "error",
          location: `config.opencode.credential_profiles.${phase}`,
          message: "must reference a profile reserved solely with allowed_gates [opencode]",
        });
      }
    }
  }
  if (strict) await validatePhaseIsolation(project, queue, credentials, issues);
  if (strict && queue.project_status === "initializing") {
    issues.push({ severity: "error", location: "queue.project_status", message: "must leave initializing before autonomous execution" });
  }
  if (strict && !project.config.git.local_commits) {
    issues.push({ severity: "error", location: "config.git.local_commits", message: "must be true so every accepted task and controller checkpoint has an independent recoverable baseline" });
  }
  if (strict && (!Array.isArray(gates.final_gates) || gates.final_gates.length === 0)) {
    issues.push({ severity: "error", location: "gates.final_gates", message: "strict execution requires at least one deterministic project-completion gate" });
  }
  if (strict) {
    const lifecycleRecord = path.join(root, "blueprints", "current", "record.json");
    const initializationBlueprint = path.join(root, ".autopilot", "init", "blueprint.json");
    if ((await exists(lifecycleRecord)) || !(await exists(initializationBlueprint))) {
      await validateBlueprintLifecycle(root, issues);
    }
    await validateGitignorePolicy(project, issues, { requireGit: checkGit });
    await validateControlPlaneOwnership(project, issues);
    await durableControlFiles(project, issues);
    issues.push(...scanText(
      "credential metadata",
      JSON.stringify(credentials),
      { placeholders: false, secrets: true },
    ));
    const toolConfigurator = path.join(root, ".autopilot", "bin", "configure-tools.mjs");
    const isolatedTools = path.join(root, ".autopilot", "bin", "opencode-tools.mjs");
    if (!(await exists(isolatedTools))) {
      issues.push({ severity: "error", location: ".autopilot/bin/opencode-tools.mjs", message: "controller-owned bounded OpenCode tools are missing" });
    } else {
      const isolatedToolSource = await readUtf8(isolatedTools, { maxBytes: 256 * 1024 });
      if (/(?:\bfrom\s*|\bimport\s*\()\s*["'](?!node:|[./])/m.test(isolatedToolSource)) {
        issues.push({
          severity: "error",
          location: ".autopilot/bin/opencode-tools.mjs",
          message: "controller-owned OpenCode tools cannot use ambient bare-package imports",
        });
      }
    }
    if (!(await exists(toolConfigurator))) {
      issues.push({ severity: "error", location: ".autopilot/bin/configure-tools.mjs", message: "role-tool drift checker is missing" });
    } else {
      try {
        const toolCheck = await runArgv([
          process.execPath,
          toolConfigurator,
          "--check",
          "--json",
          "--root",
          root,
        ], {
          cwd: root,
          env: safeBaseEnv(),
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        });
        if (toolCheck.output_truncated || toolCheck.code !== 0) {
          issues.push({
            severity: "error",
            location: ".project/tools.json",
            message: toolCheck.output_truncated
              ? "role-tool drift check output exceeded its cap"
              : `role-tool grants differ from the manifest: ${(toolCheck.stderr || toolCheck.stdout).trim()}`,
          });
        }
      } catch (error) {
        issues.push({ severity: "error", location: ".project/tools.json", message: error.message });
      }
    }
  }
  if (
    strict &&
    Object.values(queue.tasks ?? {}).some((task) => task.status !== "done") &&
    !Object.values(queue.tasks ?? {}).some((task) => task.status === "ready") &&
    !state.active_task
  ) {
    issues.push({ severity: "error", location: "queue.tasks", message: "strict execution requires at least one ready task" });
  }

  const contextCap = Math.min(
    Number(project.config.context?.max_bytes) || Number.MAX_SAFE_INTEGER,
    Number(manifest.max_context_bytes) || Number.MAX_SAFE_INTEGER,
  );
  for (const [id, task] of taskEntries(queue)) {
    if (taskId && id !== taskId) continue;
    const references = new Set();
    for (const phase of CONTEXT_PHASES) {
      try {
        for (const reference of expandTaskReferences(task, manifest, phase)) references.add(reference);
      } catch (error) {
        issues.push({
          severity: "error",
          location: `queue.tasks.${id}.context.${phase}`,
          message: error.message,
        });
      }
    }
    for (const reference of references) {
      let absolute;
      try {
        absolute = validateReference(root, reference);
      } catch (error) {
        issues.push({ severity: "error", location: reference, message: error.message });
        continue;
      }
      const text = await checkFile(project, absolute, reference, contextCap, issues, {
        placeholders: strict,
        secrets: true,
      });
      void text;
    }
    try {
      const report = await buildContextSizeReport(root, { taskId: id });
      for (const [phase, details] of Object.entries(report.tasks[id] ?? {})) {
        if (details.projected_max_bytes <= contextCap) continue;
        issues.push({
          severity: "error",
          location: `queue.tasks.${id}.context.${phase}`,
          message: `Projected ${phase} packet is ${details.projected_max_bytes} bytes; cap is ${contextCap}`,
        });
      }
    } catch (error) {
      issues.push({
        severity: "error",
        location: `queue.tasks.${id}.context`,
        message: error.message,
      });
    }
  }

  const requiredArchitecture = path.join(root, ".project", "architecture");
  if (!(await exists(requiredArchitecture))) {
    issues.push({ severity: "error", location: ".project/architecture", message: "Required architecture directory is missing" });
  } else {
    const modules = (await readdir(requiredArchitecture)).filter((name) => name.endsWith(".md"));
    if (modules.length === 0) issues.push({ severity: "error", location: ".project/architecture", message: "At least one architecture Markdown module is required" });
  }

  const milestones = path.join(root, ".project", "plan", "milestones");
  if (!(await exists(milestones))) issues.push({ severity: "error", location: ".project/plan/milestones", message: "Required milestone directory is missing" });

  if (checkGit) {
    try {
      await assertGitRepository(root);
      await gitHead(root);
      if (project.config.git.require_clean_start && !state.active_task) await assertCleanStart(project);
    } catch (error) {
      issues.push({ severity: "error", location: "git", message: error.message });
    }
  }

  return { ok: !issues.some((item) => item.severity === "error"), issues, context_cap_bytes: contextCap };
}
