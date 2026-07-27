import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  AutopilotError,
  atomicWriteFile,
  findProjectRoot,
  sha256,
  truncateUtf8,
} from "./core.mjs";
import { externalExecutionEnv, redactText, runArgv } from "./process.mjs";

const OPERATION = "dependency-lock";
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_NPMRC_BYTES = 16 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_INSTALL_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_MARKER_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2048;
const MAX_DIRECT_DEPENDENCIES = 2048;
const MAX_INSTALL_TREE_ENTRIES = 250_000;
const MAX_INSTALL_TREE_DEPTH = 64;
const MAX_INSTALL_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024;
const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_SCAN_ENTRIES = 100_000;
const MAX_WORKSPACE_SCAN_DEPTH = 32;
const MARKER_SCHEMA_VERSION = 2;
const MARKER_NAME = ".opencode-dependency-state.json";
const SAFE_NPMRC_KEYS = new Set([
  "auto-install-peers",
  "engine-strict",
  "package-manager-strict",
  "package-manager-strict-version",
  "prefer-frozen-lockfile",
  "save-exact",
  "shared-workspace-lockfile",
  "strict-peer-dependencies",
]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const EXACT_PNPM = /^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TASK_PNPM_ERROR_CODES = new Set([
  "ERR_PNPM_BAD_PM_NAME",
  "ERR_PNPM_BAD_PM_VERSION",
  "ERR_PNPM_FETCH_400",
  "ERR_PNPM_FETCH_401",
  "ERR_PNPM_FETCH_403",
  "ERR_PNPM_FETCH_404",
  "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE",
  "ERR_PNPM_INVALID_PACKAGE_NAME",
  "ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
  "ERR_PNPM_MISSING_PACKAGE_NAME",
  "ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND",
  "ERR_PNPM_NO_MATCHING_VERSION",
  "ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE",
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_PEER_DEP_ISSUES",
  "ERR_PNPM_TARBALL_INTEGRITY",
  "ERR_PNPM_WORKSPACE_PKG_NOT_FOUND",
]);
const ENVIRONMENT_PNPM_ERROR_CODES = new Set([
  "ERR_PNPM_UNSUPPORTED_ENGINE",
]);
const OFFLINE_CACHE_ERROR_CODES = new Set([
  "ERR_PNPM_NO_OFFLINE_META",
  "ERR_PNPM_NO_OFFLINE_TARBALL",
]);

export class DependencyManagerError extends AutopilotError {
  constructor(message, {
    code,
    classification = "task_failure",
    processResult = null,
    packageManager = null,
  } = {}) {
    super(message, { code });
    this.classification = classification;
    this.processResult = processResult;
    this.packageManager = packageManager;
  }
}

function dependencyError(message, code, options = {}) {
  return new DependencyManagerError(message, { code, ...options });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalSpecifier(value) {
  return /^(?:workspace|link|file|portal):/i.test(value);
}

function isGitDependencySpecifier(value) {
  if (isLocalSpecifier(value)) return false;
  if (/^(?:git(?:\+[^:]+)?|ssh|github|gitlab|bitbucket|gist):/i.test(value)) return true;
  if (/^(?:git@|[^@\s/]+\/[^/\s#]+(?:#.*)?$)/i.test(value)) return true;
  try {
    const parsed = new URL(value.replace(/^git\+(?=https?:)/i, ""));
    return parsed.pathname.toLowerCase().endsWith(".git");
  } catch {
    return false;
  }
}

function containsCredentialQuery(value) {
  return /[?&](?:_?auth(?:orization)?|access_?token|api[_-]?key|awsaccesskeyid|bearer|client[_-]?secret|credential|googleaccessid|jwt|pass(?:word|wd)?|secret|signature|sig|token|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature))=/i
    .test(value);
}

function containsCredentialReference(value) {
  if (
    /\$\{[^}]+\}/.test(value) ||
    /https?:\/\/[^\s'"}]*\?/i.test(value) ||
    containsCredentialQuery(value)
  ) return true;
  try {
    const normalized = value.replace(/^git\+(?=https?:)/i, "");
    const parsed = new URL(normalized);
    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

async function boundedRegularFile(file, maxBytes, {
  allowMissing = false,
  unsafeCode = "DEPENDENCY_POLICY_INVALID",
  label = path.basename(file),
} = {}) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") {
      throw dependencyError(`${label} is required`, unsafeCode);
    }
    throw dependencyError(`Could not inspect ${label}`, "DEPENDENCY_IO_FAILED", {
      classification: "controller_failure",
    });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw dependencyError(`${label} must be one bounded regular file`, unsafeCode);
  }
  try {
    const contents = await readFile(file);
    if (contents.length > maxBytes) {
      throw dependencyError(`${label} must be one bounded regular file`, unsafeCode);
    }
    return { contents, info };
  } catch (error) {
    if (error instanceof DependencyManagerError) throw error;
    throw dependencyError(`Could not read ${label}`, "DEPENDENCY_IO_FAILED", {
      classification: "controller_failure",
    });
  }
}

function dependencyEntries(manifest, importer = ".") {
  const entries = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    const group = manifest[field];
    if (group === undefined) continue;
    if (!isRecord(group)) {
      throw dependencyError(`${field} must contain one object`, "DEPENDENCY_POLICY_INVALID");
    }
    for (const [name, specifier] of Object.entries(group)) {
      if (!PACKAGE_NAME.test(name) || Buffer.byteLength(name, "utf8") > 214) {
        throw dependencyError(`${field} contains an invalid package name`, "DEPENDENCY_POLICY_INVALID");
      }
      if (
        typeof specifier !== "string" ||
        !specifier ||
        Buffer.byteLength(specifier, "utf8") > 4096 ||
        /[\0\r\n]/.test(specifier)
      ) {
        throw dependencyError(`${field} contains an invalid dependency specifier`, "DEPENDENCY_POLICY_INVALID");
      }
      if (containsCredentialReference(specifier)) {
        throw dependencyError(
          `${field} cannot contain credential-bearing dependency URLs or substitutions`,
          "DEPENDENCY_CONFIG_CREDENTIALS",
        );
      }
      if (isGitDependencySpecifier(specifier)) {
        throw dependencyError(
          `${field} cannot contain Git or SSH dependency sources`,
          "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
        );
      }
      const existing = entries.get(name);
      if (existing && existing.specifier !== specifier) {
        throw dependencyError(
          `Dependency ${name} has conflicting root specifiers`,
          "DEPENDENCY_POLICY_INVALID",
        );
      }
      entries.set(name, {
        importer,
        name,
        specifier,
        external: !isLocalSpecifier(specifier),
        optional: existing?.optional === false ? false : field === "optionalDependencies",
      });
    }
  }
  if (entries.size > MAX_DIRECT_DEPENDENCIES) {
    throw dependencyError("package.json declares too many direct dependencies", "DEPENDENCY_POLICY_INVALID");
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function credentialBearingNpmrc(line) {
  const normalized = line.toLowerCase();
  return /\$\{[^}]+\}/.test(line) ||
    /(?:^|[:._-])(?:_auth|authtoken|auth-token|token|password|username|certfile|keyfile)(?:$|[:._-])/i
      .test(normalized.split("=", 1)[0].trim());
}

async function inspectNpmrc(directory, label) {
  const record = await boundedRegularFile(path.join(directory, ".npmrc"), MAX_NPMRC_BYTES, {
    allowMissing: true,
    label,
  });
  const contents = record?.contents.toString("utf8") ?? "";
  if (contents.includes("\0")) {
    throw dependencyError(`${label} contains invalid data`, "DEPENDENCY_POLICY_INVALID");
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (credentialBearingNpmrc(line)) {
      throw dependencyError(
        "The dependency action rejects credential-bearing project .npmrc settings",
        "DEPENDENCY_CONFIG_CREDENTIALS",
      );
    }
    const entry = /^([a-z][a-z0-9-]*)=(true|false)$/i.exec(line);
    if (!entry || !SAFE_NPMRC_KEYS.has(entry[1].toLowerCase())) {
      throw dependencyError(
        "The dependency action accepts only credential-free boolean project .npmrc settings",
        "DEPENDENCY_CONFIG_UNSAFE",
      );
    }
  }
  return {
    contents: record?.contents ?? Buffer.alloc(0),
    hash: sha256(record?.contents ?? Buffer.alloc(0)),
  };
}

async function inspectManifest(file, label) {
  const record = await boundedRegularFile(file, MAX_PACKAGE_BYTES, { label });
  let manifest;
  try { manifest = JSON.parse(record.contents.toString("utf8")); }
  catch { throw dependencyError(`${label} is not valid JSON`, "DEPENDENCY_POLICY_INVALID"); }
  if (!isRecord(manifest)) {
    throw dependencyError(`${label} must contain one object`, "DEPENDENCY_POLICY_INVALID");
  }
  return { manifest, contents: record.contents, hash: sha256(record.contents) };
}

function inspectDependencyConfiguration(value, label, depth = 0, state = { entries: 0 }) {
  if (value === undefined) return;
  if (depth > 16) {
    throw dependencyError(`${label} exceeds its nesting bound`, "DEPENDENCY_POLICY_INVALID");
  }
  state.entries += 1;
  if (state.entries > 16_384) {
    throw dependencyError(`${label} exceeds its entry bound`, "DEPENDENCY_POLICY_INVALID");
  }
  if (typeof value === "string") {
    if (containsCredentialReference(value)) {
      throw dependencyError(
        `${label} cannot contain credential-bearing dependency sources`,
        "DEPENDENCY_CONFIG_CREDENTIALS",
      );
    }
    if (isGitDependencySpecifier(value)) {
      throw dependencyError(
        `${label} cannot contain Git or SSH dependency sources`,
        "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectDependencyConfiguration(item, label, depth + 1, state);
    return;
  }
  if (!isRecord(value)) return;
  for (const nested of Object.values(value)) {
    inspectDependencyConfiguration(nested, label, depth + 1, state);
  }
}

function workspacePatterns(contents) {
  const lines = contents.toString("utf8").split(/\r?\n/);
  const patterns = [];
  let inPackages = false;
  let sawPackages = false;
  for (const line of lines) {
    if (line.includes("\t")) {
      throw dependencyError("pnpm-workspace.yaml cannot contain tabs", "DEPENDENCY_POLICY_INVALID");
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^packages:\s*(?:\[\s*\])?\s*$/.test(line)) {
      if (sawPackages) {
        throw dependencyError("pnpm-workspace.yaml contains duplicate packages keys", "DEPENDENCY_POLICY_INVALID");
      }
      sawPackages = true;
      inPackages = !line.includes("[");
      continue;
    }
    if (!inPackages || /^\S/.test(line)) {
      throw dependencyError(
        "pnpm-workspace.yaml accepts only one scalar packages list",
        "DEPENDENCY_POLICY_INVALID",
      );
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!item) {
      throw dependencyError("pnpm-workspace.yaml packages must be one scalar list", "DEPENDENCY_POLICY_INVALID");
    }
    const decoded = yamlScalar(item[1]);
    if (typeof decoded !== "string" || !decoded || Buffer.byteLength(decoded, "utf8") > 512) {
      throw dependencyError("pnpm-workspace.yaml contains an invalid package pattern", "DEPENDENCY_POLICY_INVALID");
    }
    const body = decoded.startsWith("!") ? decoded.slice(1) : decoded;
    if (
      !body || path.isAbsolute(body) || body.includes("\\") || body.includes("\0") ||
      /[\r\n]/.test(body) || body.split("/").includes("..") || /[{}\[\]]/.test(body)
    ) {
      throw dependencyError("pnpm-workspace.yaml contains an unsafe package pattern", "DEPENDENCY_POLICY_INVALID");
    }
    patterns.push(decoded.replace(/^!\.\//, "!").replace(/^\.\//, "").replace(/\/$/, ""));
    if (patterns.length > MAX_WORKSPACE_PATTERNS) {
      throw dependencyError("pnpm-workspace.yaml has too many package patterns", "DEPENDENCY_POLICY_INVALID");
    }
  }
  if (!sawPackages) {
    throw dependencyError("pnpm-workspace.yaml requires a packages list", "DEPENDENCY_POLICY_INVALID");
  }
  return patterns;
}

function globPattern(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

async function discoverWorkspaceImporters(root, workspaceRecord) {
  if (!workspaceRecord) return [];
  const patterns = workspacePatterns(workspaceRecord.contents);
  const positive = patterns.filter((item) => !item.startsWith("!")).map(globPattern);
  const negative = patterns.filter((item) => item.startsWith("!")).map((item) => globPattern(item.slice(1)));
  if (positive.length === 0) return [];
  const ignoredDirectories = new Set([".git", ".autopilot", ".project", "node_modules"]);
  const importers = [];
  let entriesSeen = 0;
  const scan = async (directory, relativeDirectory, depth) => {
    if (depth > MAX_WORKSPACE_SCAN_DEPTH) {
      throw dependencyError("Workspace discovery exceeds its depth bound", "DEPENDENCY_POLICY_INVALID");
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch {
      throw dependencyError("Workspace directories could not be inspected", "DEPENDENCY_IO_FAILED", {
        classification: "controller_failure",
      });
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_WORKSPACE_SCAN_ENTRIES) {
        throw dependencyError("Workspace discovery exceeds its entry bound", "DEPENDENCY_POLICY_INVALID");
      }
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await scan(path.join(directory, entry.name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== "package.json" || !relativeDirectory) continue;
      if (
        positive.some((matcher) => matcher.test(relativeDirectory)) &&
        !negative.some((matcher) => matcher.test(relativeDirectory))
      ) importers.push(relativeDirectory);
    }
  };
  await scan(root, "", 0);
  return [...new Set(importers)].sort();
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function validateLocalDependencyTargets(manifests, dependencies) {
  const manifestDirectories = new Set(manifests.map((item) => canonicalPath(item.directory)));
  const directoryByImporter = new Map(manifests.map((item) => [item.importer, item.directory]));
  for (const dependency of dependencies) {
    if (/^workspace:/i.test(dependency.specifier) || !isLocalSpecifier(dependency.specifier)) continue;
    const targetValue = dependency.specifier.slice(dependency.specifier.indexOf(":") + 1);
    if (!targetValue || /[\0\r\n?#]/.test(targetValue)) {
      throw dependencyError("Local dependency sources must name one workspace package", "DEPENDENCY_POLICY_INVALID");
    }
    const importerDirectory = directoryByImporter.get(dependency.importer);
    const target = canonicalPath(path.resolve(importerDirectory, targetValue));
    if (!manifestDirectories.has(target)) {
      throw dependencyError(
        "file, link, and portal dependencies must resolve to a discovered workspace package",
        "DEPENDENCY_POLICY_INVALID",
      );
    }
  }
}

async function inspectProjectPolicy(requestedRoot) {
  let root;
  try {
    root = await findProjectRoot(path.resolve(requestedRoot));
  } catch (error) {
    if (error instanceof AutopilotError) {
      throw dependencyError(error.message, error.code ?? "PROJECT_ROOT_NOT_FOUND");
    }
    throw error;
  }
  const rootManifest = await inspectManifest(path.join(root, "package.json"), "package.json");
  const manifest = rootManifest.manifest;
  const managerValue = manifest.packageManager;
  const manager = typeof managerValue === "string" &&
    Buffer.byteLength(managerValue, "utf8") <= 128
    ? EXACT_PNPM.exec(managerValue)
    : null;
  if (!manager) {
    throw dependencyError(
      "packageManager must pin one exact pnpm version",
      "DEPENDENCY_POLICY_INVALID",
    );
  }

  try {
    const workspaceRecord = await boundedRegularFile(path.join(root, "pnpm-workspace.yaml"), MAX_WORKSPACE_BYTES, {
      allowMissing: true,
      label: "pnpm-workspace.yaml",
    });
    const workspaceImporters = await discoverWorkspaceImporters(root, workspaceRecord);
    const manifests = [{ importer: ".", directory: root, ...rootManifest }];
    for (const importer of workspaceImporters) {
      const directory = path.join(root, ...importer.split("/"));
      const inspected = await inspectManifest(path.join(directory, "package.json"), `${importer}/package.json`);
      if (
        inspected.manifest.packageManager !== undefined &&
        inspected.manifest.packageManager !== manifest.packageManager
      ) {
        throw dependencyError(
          "Workspace packageManager fields must match the root exact pnpm pin",
          "DEPENDENCY_POLICY_INVALID",
        );
      }
      manifests.push({ importer, directory, ...inspected });
    }
    for (const item of manifests) {
      if (item.manifest.pnpm?.patchedDependencies !== undefined) {
        throw dependencyError(
          "pnpm patchedDependencies are outside the controller's immutable dependency policy",
          "DEPENDENCY_PATCHED_DEPENDENCIES_FORBIDDEN",
        );
      }
      inspectDependencyConfiguration(item.manifest.overrides, `${item.importer} overrides`);
      inspectDependencyConfiguration(item.manifest.resolutions, `${item.importer} resolutions`);
      inspectDependencyConfiguration(item.manifest.pnpm?.overrides, `${item.importer} pnpm.overrides`);
      inspectDependencyConfiguration(
        item.manifest.pnpm?.packageExtensions,
        `${item.importer} pnpm.packageExtensions`,
      );
    }
    const dependencies = manifests.flatMap((item) => dependencyEntries(item.manifest, item.importer));
    if (dependencies.length > MAX_DIRECT_DEPENDENCIES) {
      throw dependencyError("The workspace declares too many direct dependencies", "DEPENDENCY_POLICY_INVALID");
    }
    validateLocalDependencyTargets(manifests, dependencies);
    const npmrcHashes = [];
    for (const item of manifests) {
      const npmrc = await inspectNpmrc(
        item.directory,
        item.importer === "." ? ".npmrc" : `${item.importer}/.npmrc`,
      );
      item.npmrcContents = npmrc.contents;
      npmrcHashes.push(`${item.importer}\0${npmrc.hash}`);
    }
    const policyHash = sha256([
      `workspace\0${workspaceRecord ? sha256(workspaceRecord.contents) : "absent"}`,
      ...manifests.map((item) => `${item.importer}\0${item.hash}`),
    ].join("\n"));

    return {
      root,
      manifest,
      manager: manifest.packageManager,
      manifests,
      dependencies,
      workspaceContents: workspaceRecord?.contents ?? null,
      packageHash: policyHash,
      npmrcHash: sha256(npmrcHashes.join("\n")),
    };
  } catch (error) {
    if (error instanceof DependencyManagerError && !error.packageManager) {
      error.packageManager = manifest.packageManager;
    }
    throw error;
  }
}

export async function isPnpmManagedProject(requestedRoot) {
  try {
    const root = await findProjectRoot(path.resolve(requestedRoot));
    const record = await boundedRegularFile(path.join(root, "package.json"), MAX_PACKAGE_BYTES, {
      label: "package.json",
    });
    const manifest = JSON.parse(record.contents.toString("utf8"));
    return isRecord(manifest) && EXACT_PNPM.test(manifest.packageManager ?? "");
  } catch {
    return false;
  }
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); }
    catch { return null; }
  }
  return trimmed;
}

function sourceTextHasCredentials(value) {
  return /\$\{[^}]+\}/.test(value) ||
    /https?:\/\/[^/\s'"}]*@/i.test(value) ||
    /https?:\/\/[^\s'"}]*\?/i.test(value) ||
    containsCredentialQuery(value);
}

function sourceTextHasGit(value) {
  return /(?:git\+(?:https?|ssh)|git|ssh):\/\//i.test(value) ||
    /(?:^|[\s{,'"])(?:github|gitlab|bitbucket|gist):/i.test(value) ||
    /git@[a-z0-9.-]+:/i.test(value) ||
    /https?:\/\/[^\s'"}]+\.git(?:[#?'"}\s,]|$)/i.test(value);
}

function assertLockfileSourcesSafe(text) {
  if (sourceTextHasCredentials(text)) {
    throw dependencyError(
      "pnpm-lock.yaml cannot contain credential-bearing dependency sources",
      "DEPENDENCY_CONFIG_CREDENTIALS",
    );
  }
  if (sourceTextHasGit(text)) {
    throw dependencyError(
      "pnpm-lock.yaml cannot contain Git or SSH dependency sources",
      "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
    );
  }
}

function yamlMappingEntry(line, expectedIndent) {
  if (/^\s*$/.test(line) || line.trimStart().startsWith("#")) return null;
  if (/^\s*/.exec(line)[0].includes("\t")) return null;
  const indent = line.length - line.trimStart().length;
  if (indent !== expectedIndent) return null;
  const content = line.slice(indent);
  let quote = null;
  let escaped = false;
  let colon = -1;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && content[index + 1] === "'") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ":") {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const key = yamlScalar(content.slice(0, colon));
  if (typeof key !== "string" || !key) return null;
  return { key, value: content.slice(colon + 1).trim() };
}

function lineIndent(line) {
  if (/^\s*$/.test(line)) return Number.POSITIVE_INFINITY;
  if (line.includes("\t")) return -1;
  return line.length - line.trimStart().length;
}

function sectionRange(lines, name) {
  for (let index = 0; index < lines.length; index += 1) {
    const entry = yamlMappingEntry(lines[index], 0);
    if (entry?.key !== name) continue;
    let end = index + 1;
    while (end < lines.length && lineIndent(lines[end]) > 0) end += 1;
    return { start: index, end, value: entry.value };
  }
  return null;
}

function parseImporterDependencies(lines, range) {
  const importers = new Map();
  if (!range || range.value === "{}") return importers;
  for (let index = range.start + 1; index < range.end;) {
    const importer = yamlMappingEntry(lines[index], 2);
    if (!importer) {
      index += 1;
      continue;
    }
    let importerEnd = index + 1;
    while (importerEnd < range.end && lineIndent(lines[importerEnd]) > 2) importerEnd += 1;
    const dependencies = new Map();
    for (let categoryIndex = index + 1; categoryIndex < importerEnd;) {
      const category = yamlMappingEntry(lines[categoryIndex], 4);
      if (!category || !DEPENDENCY_FIELDS.includes(category.key)) {
        categoryIndex += 1;
        continue;
      }
      let categoryEnd = categoryIndex + 1;
      while (categoryEnd < importerEnd && lineIndent(lines[categoryEnd]) > 4) categoryEnd += 1;
      for (let dependencyIndex = categoryIndex + 1; dependencyIndex < categoryEnd;) {
        const dependency = yamlMappingEntry(lines[dependencyIndex], 6);
        if (!dependency) {
          dependencyIndex += 1;
          continue;
        }
        let dependencyEnd = dependencyIndex + 1;
        while (dependencyEnd < categoryEnd && lineIndent(lines[dependencyEnd]) > 6) dependencyEnd += 1;
        let specifier = null;
        let version = dependency.value ? yamlScalar(dependency.value) : null;
        for (let propertyIndex = dependencyIndex + 1; propertyIndex < dependencyEnd; propertyIndex += 1) {
          const property = yamlMappingEntry(lines[propertyIndex], 8);
          if (property?.key === "specifier") specifier = yamlScalar(property.value);
          if (property?.key === "version") version = yamlScalar(property.value);
        }
        dependencies.set(dependency.key, { specifier, version });
        dependencyIndex = dependencyEnd;
      }
      categoryIndex = categoryEnd;
    }
    importers.set(importer.key, dependencies);
    index = importerEnd;
  }
  return importers;
}

function validIntegrity(value) {
  const match = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const expectedBytes = { 256: 32, 384: 48, 512: 64 }[match[1]];
  try {
    const decoded = Buffer.from(match[2], "base64");
    return decoded.length === expectedBytes && decoded.toString("base64") === match[2];
  } catch {
    return false;
  }
}

function inlineIntegrity(value) {
  const match = /(?:^|[{,]\s*)integrity\s*:\s*(?:"([^"]+)"|'([^']+)'|([^,}\s]+))/i.exec(value);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function packageResolutionEntries(lines, range) {
  const entries = new Map();
  if (!range || range.value === "{}") return { entries, complete: false };
  for (let index = range.start + 1; index < range.end;) {
    const packageEntry = yamlMappingEntry(lines[index], 2);
    if (!packageEntry) {
      index += 1;
      continue;
    }
    let packageEnd = index + 1;
    while (packageEnd < range.end && lineIndent(lines[packageEnd]) > 2) packageEnd += 1;
    let integrity = null;
    for (let propertyIndex = index + 1; propertyIndex < packageEnd; propertyIndex += 1) {
      const resolution = yamlMappingEntry(lines[propertyIndex], 4);
      if (resolution?.key !== "resolution") continue;
      if (sourceTextHasCredentials(resolution.value)) {
        throw dependencyError(
          "pnpm-lock.yaml contains a credential-bearing package resolution",
          "DEPENDENCY_CONFIG_CREDENTIALS",
        );
      }
      if (sourceTextHasGit(resolution.value) || /(?:commit|repo|repository)\s*:/i.test(resolution.value)) {
        throw dependencyError(
          "pnpm-lock.yaml contains a Git package resolution",
          "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
        );
      }
      if (/(?:^|[{,]\s*)directory\s*:/i.test(resolution.value)) {
        throw dependencyError(
          "pnpm-lock.yaml external packages cannot use directory resolutions",
          "DEPENDENCY_LOCKFILE_INCOMPLETE",
        );
      }
      integrity = inlineIntegrity(resolution.value) ?? integrity;
      let resolutionEnd = propertyIndex + 1;
      while (resolutionEnd < packageEnd && lineIndent(lines[resolutionEnd]) > 4) resolutionEnd += 1;
      for (let detailIndex = propertyIndex + 1; detailIndex < resolutionEnd; detailIndex += 1) {
        const detail = yamlMappingEntry(lines[detailIndex], 6);
        if (!detail) continue;
        if (sourceTextHasCredentials(detail.value)) {
          throw dependencyError(
            "pnpm-lock.yaml contains a credential-bearing package resolution",
            "DEPENDENCY_CONFIG_CREDENTIALS",
          );
        }
        if (
          ["commit", "repo", "repository"].includes(detail.key) ||
          sourceTextHasGit(detail.value)
        ) {
          throw dependencyError(
            "pnpm-lock.yaml contains a Git package resolution",
            "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
          );
        }
        if (detail.key === "directory") {
          throw dependencyError(
            "pnpm-lock.yaml external packages cannot use directory resolutions",
            "DEPENDENCY_LOCKFILE_INCOMPLETE",
          );
        }
        if (detail.key === "integrity") integrity = yamlScalar(detail.value);
      }
    }
    entries.set(packageEntry.key, {
      integrity,
      complete: typeof integrity === "string" && validIntegrity(integrity),
    });
    index = packageEnd;
  }
  return {
    entries,
    complete: entries.size > 0 && [...entries.values()].every((entry) => entry.complete),
  };
}

function assertSerializedLockfileSourcesSafe(contents) {
  const text = contents.toString("utf8");
  assertLockfileSourcesSafe(text);
  const lines = text.split(/\r?\n/);
  packageResolutionEntries(lines, sectionRange(lines, "packages"));
}

function sectionEntryKeys(lines, range) {
  const keys = new Set();
  if (!range || range.value === "{}") return keys;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const entry = yamlMappingEntry(lines[index], 2);
    if (entry) keys.add(entry.key);
  }
  return keys;
}

function parseSnapshotDependencies(lines, range) {
  const snapshots = new Map();
  if (!range || range.value === "{}") return snapshots;
  for (let index = range.start + 1; index < range.end;) {
    const snapshot = yamlMappingEntry(lines[index], 2);
    if (!snapshot) {
      index += 1;
      continue;
    }
    let snapshotEnd = index + 1;
    while (snapshotEnd < range.end && lineIndent(lines[snapshotEnd]) > 2) snapshotEnd += 1;
    const dependencies = [];
    for (let categoryIndex = index + 1; categoryIndex < snapshotEnd;) {
      const category = yamlMappingEntry(lines[categoryIndex], 4);
      if (!category || !["dependencies", "optionalDependencies"].includes(category.key)) {
        categoryIndex += 1;
        continue;
      }
      let categoryEnd = categoryIndex + 1;
      while (categoryEnd < snapshotEnd && lineIndent(lines[categoryEnd]) > 4) categoryEnd += 1;
      for (let dependencyIndex = categoryIndex + 1; dependencyIndex < categoryEnd; dependencyIndex += 1) {
        const dependency = yamlMappingEntry(lines[dependencyIndex], 6);
        if (!dependency) continue;
        const version = yamlScalar(dependency.value);
        if (typeof version !== "string" || !version) {
          throw dependencyError(
            "pnpm-lock.yaml contains an incomplete transitive dependency edge",
            "DEPENDENCY_LOCKFILE_INCOMPLETE",
          );
        }
        dependencies.push({ name: dependency.key, version });
      }
      categoryIndex = categoryEnd;
    }
    snapshots.set(snapshot.key, dependencies);
    index = snapshotEnd;
  }
  return snapshots;
}

function normalizedPackageKey(key) {
  if (typeof key !== "string") return null;
  const separator = key.lastIndexOf("@");
  if (separator <= 0) return null;
  return dependencyLockReference(key.slice(0, separator), key.slice(separator + 1))?.packageKey ?? null;
}

function dependencyLockReference(name, version) {
  let resolvedName = name;
  let resolvedVersion = version;
  if (resolvedVersion.startsWith("npm:")) {
    const alias = resolvedVersion.slice("npm:".length);
    const versionSeparator = alias.lastIndexOf("@");
    if (versionSeparator <= 0) return null;
    resolvedName = alias.slice(0, versionSeparator);
    resolvedVersion = alias.slice(versionSeparator + 1);
  }
  if (!PACKAGE_NAME.test(resolvedName)) return null;
  const peerStart = resolvedVersion.indexOf("(");
  const packageVersion = peerStart === -1 ? resolvedVersion : resolvedVersion.slice(0, peerStart);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    return null;
  }
  return {
    resolvedName,
    packageVersion,
    packageKey: `${resolvedName}@${packageVersion}`,
    snapshotKey: `${resolvedName}@${resolvedVersion}`,
  };
}

export async function validatePnpmLockfile(root, policy = null) {
  const inspectedPolicy = policy ?? await inspectProjectPolicy(root);
  const lockFile = path.join(inspectedPolicy.root, "pnpm-lock.yaml");
  const record = await boundedRegularFile(lockFile, MAX_LOCKFILE_BYTES, {
    allowMissing: true,
    label: "pnpm-lock.yaml",
    unsafeCode: "DEPENDENCY_LOCKFILE_UNSAFE",
  });
  if (!record) {
    throw dependencyError("pnpm-lock.yaml is required", "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
  const text = record.contents.toString("utf8");
  if (text.includes("\0")) {
    throw dependencyError("pnpm-lock.yaml contains invalid data", "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
  assertLockfileSourcesSafe(text);
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => Buffer.byteLength(line, "utf8") > 64 * 1024 || lineIndent(line) < 0)) {
    throw dependencyError("pnpm-lock.yaml is not bounded canonical YAML", "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
  const version = sectionRange(lines, "lockfileVersion");
  const importerRange = sectionRange(lines, "importers");
  if (!version?.value || !importerRange) {
    throw dependencyError("pnpm-lock.yaml lacks required lockfile structure", "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
  const importers = parseImporterDependencies(lines, importerRange);
  const rootImporter = importers.get(".");
  if (!rootImporter) {
    throw dependencyError("pnpm-lock.yaml lacks the root importer", "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
  const expectedImporters = new Set(inspectedPolicy.manifests.map((item) => item.importer));
  if (
    importers.size !== expectedImporters.size ||
    [...expectedImporters].some((importer) => !importers.has(importer))
  ) {
    throw dependencyError(
      "pnpm-lock.yaml importers do not match pnpm-workspace.yaml",
      "DEPENDENCY_LOCKFILE_INCOMPLETE",
    );
  }
  const expectedDependencies = new Map(
    inspectedPolicy.manifests.map((item) => [item.importer, new Map()]),
  );
  for (const dependency of inspectedPolicy.dependencies) {
    expectedDependencies.get(dependency.importer).set(dependency.name, dependency.specifier);
  }
  for (const importer of expectedImporters) {
    const actual = importers.get(importer);
    const expected = expectedDependencies.get(importer);
    if (
      actual.size !== expected.size ||
      [...actual.entries()].some(([name, entry]) => expected.get(name) !== entry.specifier)
    ) {
      throw dependencyError(
        "pnpm-lock.yaml importer dependencies do not exactly match workspace manifests",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
  }
  const directResolutions = [];
  for (const dependency of inspectedPolicy.dependencies) {
    const locked = importers.get(dependency.importer)?.get(dependency.name);
    if (
      !locked ||
      typeof locked.specifier !== "string" ||
      locked.specifier !== dependency.specifier ||
      typeof locked.version !== "string" ||
      !locked.version
    ) {
      throw dependencyError(
        "pnpm-lock.yaml does not completely resolve every workspace manifest",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
    if (dependency.external && isLocalSpecifier(locked.version)) {
      throw dependencyError(
        "pnpm-lock.yaml contains an incomplete external dependency resolution",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
    const reference = dependency.external
      ? dependencyLockReference(dependency.name, locked.version)
      : null;
    if (dependency.external && !reference) {
      throw dependencyError(
        "pnpm-lock.yaml contains an unsupported external direct resolution",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
    directResolutions.push({
      importer: dependency.importer,
      name: dependency.name,
      lockedVersion: locked.version,
      expectedName: reference?.resolvedName ?? dependency.name,
      expectedVersion: reference?.packageVersion ?? null,
    });
  }
  const lockedDependencies = [...importers.entries()].flatMap(([importer, dependencies]) =>
    [...dependencies.entries()].map(([name, entry]) => ({ importer, name, ...entry }))
  );
  if (lockedDependencies.some((entry) =>
    typeof entry.specifier !== "string" || !entry.specifier ||
    typeof entry.version !== "string" || !entry.version
  )) {
    throw dependencyError(
      "pnpm-lock.yaml contains an incomplete workspace importer",
      "DEPENDENCY_LOCKFILE_INCOMPLETE",
    );
  }
  if (lockedDependencies.some((entry) =>
    containsCredentialReference(entry.specifier) || containsCredentialReference(entry.version)
  )) {
    throw dependencyError(
      "pnpm-lock.yaml contains a credential-bearing dependency source",
      "DEPENDENCY_CONFIG_CREDENTIALS",
    );
  }
  if (lockedDependencies.some((entry) =>
    isGitDependencySpecifier(entry.specifier) || isGitDependencySpecifier(entry.version)
  )) {
    throw dependencyError(
      "pnpm-lock.yaml contains a forbidden Git or SSH dependency source",
      "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
    );
  }
  const externalCount = lockedDependencies.filter((entry) =>
    !isLocalSpecifier(entry.specifier)
  ).length;
  if (externalCount > 0) {
    const packages = packageResolutionEntries(lines, sectionRange(lines, "packages"));
    const snapshots = parseSnapshotDependencies(lines, sectionRange(lines, "snapshots"));
    if (!packages.complete) {
      throw dependencyError(
        "pnpm-lock.yaml lacks complete package resolution data",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
    const normalizedSnapshots = new Set();
    for (const snapshotKey of snapshots.keys()) {
      const normalized = normalizedPackageKey(snapshotKey);
      if (!normalized || packages.entries.get(normalized)?.complete !== true) {
        throw dependencyError(
          "pnpm-lock.yaml contains a snapshot without immutable package resolution data",
          "DEPENDENCY_LOCKFILE_INCOMPLETE",
        );
      }
      normalizedSnapshots.add(normalized);
    }
    if ([...packages.entries.keys()].some((packageKey) => !normalizedSnapshots.has(packageKey))) {
      throw dependencyError(
        "pnpm-lock.yaml contains package resolution data without a matching snapshot",
        "DEPENDENCY_LOCKFILE_INCOMPLETE",
      );
    }
    for (const dependency of lockedDependencies.filter((entry) => !isLocalSpecifier(entry.specifier))) {
      const reference = dependencyLockReference(dependency.name, dependency.version);
      if (
        !reference ||
        packages.entries.get(reference.packageKey)?.complete !== true ||
        !snapshots.has(reference.snapshotKey)
      ) {
        throw dependencyError(
          "pnpm-lock.yaml does not link every importer to immutable package and snapshot data",
          "DEPENDENCY_LOCKFILE_INCOMPLETE",
        );
      }
    }
    for (const dependencies of snapshots.values()) {
      for (const dependency of dependencies) {
        if (isLocalSpecifier(dependency.version)) continue;
        const reference = dependencyLockReference(dependency.name, dependency.version);
        if (
          !reference ||
          packages.entries.get(reference.packageKey)?.complete !== true ||
          !snapshots.has(reference.snapshotKey)
        ) {
          throw dependencyError(
            "pnpm-lock.yaml contains an unresolved transitive dependency edge",
            "DEPENDENCY_LOCKFILE_INCOMPLETE",
          );
        }
      }
    }
  }
  return {
    file: lockFile,
    contents: record.contents,
    hash: sha256(record.contents),
    externalDependencies: externalCount,
    lockedDependencies: lockedDependencies.length,
    directResolutions,
  };
}

async function captureLockfile(policy) {
  const file = path.join(policy.root, "pnpm-lock.yaml");
  const record = await boundedRegularFile(file, MAX_LOCKFILE_BYTES, {
    allowMissing: true,
    label: "pnpm-lock.yaml",
    unsafeCode: "DEPENDENCY_LOCKFILE_UNSAFE",
  });
  return {
    file,
    existed: Boolean(record),
    contents: record?.contents ?? null,
    mode: record?.info.mode ?? null,
  };
}

async function restoreLockfile(snapshot) {
  try {
    let current = null;
    try { current = await lstat(snapshot.file); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current && current.isDirectory()) throw new Error("lockfile path became a directory");
    if (!snapshot.existed) {
      await rm(snapshot.file, { force: true });
      return;
    }
    await atomicWriteFile(snapshot.file, snapshot.contents);
    if (process.platform !== "win32" && Number.isInteger(snapshot.mode)) {
      await chmod(snapshot.file, snapshot.mode & 0o777);
    }
  } catch {
    throw dependencyError(
      "Could not restore the prior pnpm lockfile after dependency failure",
      "DEPENDENCY_LOCKFILE_ROLLBACK_FAILED",
      { classification: "controller_failure" },
    );
  }
}

async function controllerDependencyLocations(projectRoot) {
  const rootIdentity = canonicalPath(projectRoot);
  const segments = [".autopilot", "runtime", "dependency"];
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("controller dependency cache has unsafe topology");
    }
    if (process.platform !== "win32") await chmod(current, 0o700);
  }
  const locations = {
    corepack: path.join(current, "corepack"),
    store: path.join(current, "pnpm-store"),
  };
  for (const location of Object.values(locations)) {
    await mkdir(location, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const info = await lstat(location);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("controller dependency cache has unsafe topology");
    }
    if (process.platform !== "win32") await chmod(location, 0o700);
    const resolved = canonicalPath(await realpath(location));
    if (!resolved.startsWith(`${rootIdentity}${path.sep}`)) {
      throw new Error("controller dependency cache escapes the project");
    }
  }
  return locations;
}

async function createPrivateEnvironment(
  projectRoot,
  sourceEnvironment,
  temporaryRoot = os.tmpdir(),
  { persistentStore = false } = {},
) {
  let directory = null;
  try {
    directory = await mkdtemp(path.join(path.resolve(temporaryRoot), "ocp-dependency-"));
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const controllerLocations = await controllerDependencyLocations(projectRoot);
    const locations = {
      directory,
      home: path.join(directory, "home"),
      appData: path.join(directory, "appdata"),
      localAppData: path.join(directory, "localappdata"),
      config: path.join(directory, "config"),
      cache: path.join(directory, "cache"),
      data: path.join(directory, "data"),
      corepack: controllerLocations.corepack,
      pnpmHome: path.join(directory, "pnpm-home"),
      store: persistentStore ? controllerLocations.store : path.join(directory, "pnpm-store"),
    };
    await Promise.all(Object.values(locations).slice(1).map((item) => mkdir(item, { recursive: true })));
    const userConfig = path.join(directory, "user.npmrc");
    const globalConfig = path.join(directory, "global.npmrc");
    const gitConfig = path.join(directory, "gitconfig");
    await Promise.all([
      writeFile(userConfig, "# isolated by OpenCode Control Plane\n", { encoding: "utf8", mode: 0o600 }),
      writeFile(globalConfig, "# isolated by OpenCode Control Plane\n", { encoding: "utf8", mode: 0o600 }),
      writeFile(gitConfig, "# isolated by OpenCode Control Plane\n", { encoding: "utf8", mode: 0o600 }),
    ]);
    const env = {
      ...await externalExecutionEnv(projectRoot, sourceEnvironment),
      HOME: locations.home,
      USERPROFILE: locations.home,
      APPDATA: locations.appData,
      LOCALAPPDATA: locations.localAppData,
      XDG_CONFIG_HOME: locations.config,
      XDG_CACHE_HOME: locations.cache,
      XDG_DATA_HOME: locations.data,
      COREPACK_HOME: locations.corepack,
      PNPM_HOME: locations.pnpmHome,
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: locations.cache,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_ENABLE_STRICT: "1",
      COREPACK_ENV_FILE: "0",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      SSH_ASKPASS_REQUIRE: "never",
      CI: "1",
      NO_COLOR: "1",
    };
    return { ...locations, env };
  } catch (error) {
    if (directory) {
      await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }).catch(() => {});
    }
    throw dependencyError("Could not create a private dependency runtime", "DEPENDENCY_PRIVATE_RUNTIME_FAILED", {
      classification: "controller_failure",
    });
  }
}

async function removePrivateEnvironment(privateEnvironment) {
  try {
    await rm(privateEnvironment.directory, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 25,
    });
    try {
      await lstat(privateEnvironment.directory);
      throw new Error("private directory still exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } catch {
    throw dependencyError("Could not remove the private dependency runtime", "DEPENDENCY_PRIVATE_RUNTIME_FAILED", {
      classification: "controller_failure",
    });
  }
}

function validateProcessResult(result) {
  if (
    !isRecord(result) ||
    !Object.hasOwn(result, "code") ||
    typeof result.timed_out !== "boolean" ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw dependencyError(
      "Dependency process runner returned an invalid result",
      "DEPENDENCY_EXECUTION_PROTOCOL_INVALID",
      { classification: "controller_failure" },
    );
  }
  return result;
}

async function executeBounded(execute, argv, options) {
  try {
    return validateProcessResult(await execute(argv, options));
  } catch (error) {
    if (error instanceof DependencyManagerError) throw error;
    throw dependencyError("Dependency process could not be started", "DEPENDENCY_EXECUTION_UNAVAILABLE", {
      classification: "controller_failure",
    });
  }
}

function collectStructuredErrorCodes(value, output, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 128)) collectStructuredErrorCodes(item, output, depth + 1);
    return;
  }
  for (const [key, nested] of Object.entries(value).slice(0, 128)) {
    if (
      ["code", "errno"].includes(key.toLowerCase()) &&
      typeof nested === "string" &&
      /^[A-Z][A-Z0-9_]{1,95}$/.test(nested)
    ) output.add(nested);
    else collectStructuredErrorCodes(nested, output, depth + 1);
  }
}

function structuredPnpmErrorCodes(result) {
  const codes = new Set();
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).slice(0, 8192)) {
    if (!line.trim().startsWith("{")) continue;
    try { collectStructuredErrorCodes(JSON.parse(line), codes); }
    catch {}
  }
  return codes;
}

function processFailure(result, phase) {
  if (result.timed_out) {
    return dependencyError("Dependency process exceeded its time bound", "DEPENDENCY_EXECUTION_TIMEOUT", {
      classification: "controller_failure",
      processResult: result,
    });
  }
  if (!Number.isInteger(result.code)) {
    return dependencyError("Dependency process terminated without an exit status", "DEPENDENCY_EXECUTION_TERMINATED", {
      classification: "controller_failure",
      processResult: result,
    });
  }
  const structuredCodes = structuredPnpmErrorCodes(result);
  if ([...structuredCodes].some((code) => ENVIRONMENT_PNPM_ERROR_CODES.has(code))) {
    return dependencyError(
      "The current Node.js runtime does not satisfy the project's declared engine requirement",
      "DEPENDENCY_NODE_ENGINE_UNSUPPORTED",
      { classification: "environment_failure", processResult: result },
    );
  }
  if (phase === "manager") {
    return dependencyError(
      "The exactly pinned pnpm runtime could not be provisioned",
      "DEPENDENCY_PINNED_MANAGER_UNAVAILABLE",
      { classification: "controller_failure", processResult: result },
    );
  }
  const taskFailure = structuredCodes.size > 0 &&
    [...structuredCodes].every((code) => TASK_PNPM_ERROR_CODES.has(code));
  const networkFailure = [...structuredCodes].some((code) =>
    /^(?:EAI_AGAIN|ECONN(?:ABORTED|REFUSED|RESET)|ENETUNREACH|ETIMEDOUT|CERT_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_(?:429|5\d\d)|ERR_PNPM_FETCHING_TARBALL|ERR_PNPM_NO_OFFLINE_(?:META|TARBALL))$/.test(code)
  );
  return dependencyError(
    phase === "frozen"
      ? "The frozen dependency validation failed"
      : "The dependency graph could not be resolved",
    taskFailure
      ? phase === "frozen" ? "DEPENDENCY_FROZEN_VALIDATION_FAILED" : "DEPENDENCY_RESOLUTION_FAILED"
      : networkFailure ? "DEPENDENCY_NETWORK_UNAVAILABLE" : "DEPENDENCY_RUNTIME_FAILED",
    {
      classification: taskFailure ? "task_failure" : "controller_failure",
      processResult: result,
    },
  );
}

function pinnedPnpmVersion(policy) {
  return policy.manager.slice("pnpm@".length);
}

async function verifyPinnedManager(execute, policy, options) {
  const result = await executeBounded(execute, ["corepack", "pnpm", "--version"], options);
  if (result.code !== 0 || result.timed_out) throw processFailure(result, "manager");
  if (result.stdout.trim() !== pinnedPnpmVersion(policy)) {
    throw dependencyError(
      "Corepack resolved a pnpm version that differs from packageManager",
      "DEPENDENCY_PINNED_MANAGER_MISMATCH",
      { classification: "controller_failure", processResult: result },
    );
  }
  return result;
}

function packagePath(root, dependency) {
  const importerRoot = dependency.importer === "."
    ? root
    : path.join(root, ...dependency.importer.split("/"));
  return path.join(importerRoot, "node_modules", ...dependency.name.split("/"), "package.json");
}

async function fingerprintInstallTree(root) {
  const hash = createHash("sha256");
  let entryCount = 0;
  let bytesSeen = 0;
  const hashFile = async (file, relative, inspected) => {
    let handle;
    try {
      handle = await open(file, "r");
      const current = await handle.stat();
      if (
        !current.isFile() || current.size !== inspected.size ||
        (Number.isInteger(current.ino) && Number.isInteger(inspected.ino) && current.ino !== inspected.ino)
      ) {
        throw new Error("file identity changed");
      }
      bytesSeen += current.size;
      if (bytesSeen > MAX_INSTALL_TREE_BYTES) {
        throw dependencyError("Installed dependency tree exceeds its byte bound", "DEPENDENCY_INSTALL_INCOMPLETE");
      }
      hash.update(`F\0${relative}\0${current.size}\0${current.mode & 0o777}\0`);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (total < current.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, current.size - total), null);
        if (bytesRead === 0) throw new Error("file truncated while hashing");
        hash.update(buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
      hash.update("\0");
    } catch (error) {
      if (error instanceof DependencyManagerError) throw error;
      throw dependencyError("Installed dependency content changed while inspected", "DEPENDENCY_INSTALL_INCOMPLETE");
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  const walk = async (directory, relativeDirectory, depth) => {
    if (depth > MAX_INSTALL_TREE_DEPTH) {
      throw dependencyError("Installed dependency tree exceeds its depth bound", "DEPENDENCY_INSTALL_INCOMPLETE");
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch {
      throw dependencyError("Installed dependency tree is unreadable", "DEPENDENCY_INSTALL_INCOMPLETE");
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_INSTALL_TREE_ENTRIES) {
        throw dependencyError("Installed dependency tree exceeds its entry bound", "DEPENDENCY_INSTALL_INCOMPLETE");
      }
      const relative = `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/");
      const file = path.join(directory, entry.name);
      let info;
      try { info = await lstat(file); }
      catch {
        throw dependencyError("Installed dependency tree changed while inspected", "DEPENDENCY_INSTALL_INCOMPLETE");
      }
      if (info.isSymbolicLink()) {
        let target;
        try { target = await readlink(file); }
        catch {
          throw dependencyError("Installed dependency link is unreadable", "DEPENDENCY_INSTALL_INCOMPLETE");
        }
        hash.update(`L\0${relative}\0${target}\0`);
      } else if (info.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        await walk(file, relative, depth + 1);
      } else if (info.isFile()) {
        await hashFile(file, relative, info);
      } else {
        throw dependencyError("Installed dependency tree contains a special file", "DEPENDENCY_INSTALL_INCOMPLETE");
      }
    }
  };

  const virtualStore = path.join(root, "node_modules", ".pnpm");
  const virtualStoreInfo = await lstat(virtualStore).catch(() => null);
  if (!virtualStoreInfo?.isDirectory() || virtualStoreInfo.isSymbolicLink()) {
    throw dependencyError("pnpm virtual store is missing", "DEPENDENCY_INSTALL_INCOMPLETE");
  }
  await walk(virtualStore, ".pnpm", 0);
  const binDirectory = path.join(root, "node_modules", ".bin");
  const binInfo = await lstat(binDirectory).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (binInfo) {
    if (!binInfo.isDirectory() || binInfo.isSymbolicLink()) {
      throw dependencyError("pnpm executable links are unsafe", "DEPENDENCY_INSTALL_INCOMPLETE");
    }
    await walk(binDirectory, ".bin", 0);
  }
  return hash.digest("hex");
}

async function captureInstalledState(policy, lock) {
  if (lock.lockedDependencies === 0) {
    return { modulesHash: null, virtualStoreHash: null, packages: [] };
  }
  const modules = await boundedRegularFile(
    path.join(policy.root, "node_modules", ".modules.yaml"),
    MAX_INSTALL_METADATA_BYTES,
    { label: "node_modules/.modules.yaml", unsafeCode: "DEPENDENCY_INSTALL_INCOMPLETE" },
  );
  if (!modules.contents.length) {
    throw dependencyError(
      "pnpm did not materialize dependency installation metadata",
      "DEPENDENCY_INSTALL_INCOMPLETE",
    );
  }
  const virtualStoreLock = await boundedRegularFile(
    path.join(policy.root, "node_modules", ".pnpm", "lock.yaml"),
    MAX_LOCKFILE_BYTES,
    { label: "node_modules/.pnpm/lock.yaml", unsafeCode: "DEPENDENCY_INSTALL_INCOMPLETE" },
  );
  if (!virtualStoreLock.contents.length) {
    throw dependencyError(
      "pnpm did not materialize its installed dependency lock",
      "DEPENDENCY_INSTALL_INCOMPLETE",
    );
  }
  if (sha256(virtualStoreLock.contents) !== lock.hash) {
    throw dependencyError(
      "pnpm installed-state lock does not match pnpm-lock.yaml",
      "DEPENDENCY_INSTALL_INCOMPLETE",
    );
  }
  const packages = [];
  for (const dependency of policy.dependencies.filter((entry) => !entry.optional)) {
    const file = packagePath(policy.root, dependency);
    const record = await boundedRegularFile(file, MAX_PACKAGE_BYTES, {
      label: `installed ${dependency.name} package.json`,
      unsafeCode: "DEPENDENCY_INSTALL_INCOMPLETE",
    });
    let installed;
    try { installed = JSON.parse(record.contents.toString("utf8")); }
    catch {
      throw dependencyError(
        "An installed direct dependency has invalid package metadata",
        "DEPENDENCY_INSTALL_INCOMPLETE",
      );
    }
    const resolution = lock.directResolutions.find((entry) =>
      entry.importer === dependency.importer && entry.name === dependency.name
    );
    if (
      !isRecord(installed) ||
      typeof installed.name !== "string" ||
      typeof installed.version !== "string" ||
      !installed.version ||
      !resolution ||
      installed.name !== resolution.expectedName ||
      (resolution.expectedVersion !== null && installed.version !== resolution.expectedVersion)
    ) {
      throw dependencyError(
        "An installed direct dependency does not match pnpm-lock.yaml",
        "DEPENDENCY_INSTALL_INCOMPLETE",
      );
    }
    packages.push({ importer: dependency.importer, name: dependency.name, hash: sha256(record.contents) });
  }
  return {
    modulesHash: sha256(modules.contents),
    virtualStoreHash: sha256(virtualStoreLock.contents),
    installTreeHash: await fingerprintInstallTree(policy.root),
    packages,
  };
}

function markerFor(policy, lock, installed) {
  return {
    schema_version: MARKER_SCHEMA_VERSION,
    package_manager: policy.manager,
    dependency_policy_sha256: policy.packageHash,
    npmrc_sha256: policy.npmrcHash,
    lockfile_sha256: lock.hash,
    modules_sha256: installed.modulesHash,
    virtual_store_lock_sha256: installed.virtualStoreHash,
    install_tree_sha256: installed.installTreeHash,
    direct_packages: installed.packages,
  };
}

async function writeMarker(policy, marker) {
  const markerFile = path.join(policy.root, "node_modules", MARKER_NAME);
  try {
    await atomicWriteFile(markerFile, `${JSON.stringify(marker)}\n`);
  } catch {
    throw dependencyError("Could not record installed dependency state", "DEPENDENCY_STATE_RECORD_FAILED", {
      classification: "controller_failure",
    });
  }
}

async function installedStateMatches(policy, lock) {
  if (lock.lockedDependencies === 0) return true;
  try {
    const markerRecord = await boundedRegularFile(
      path.join(policy.root, "node_modules", MARKER_NAME),
      MAX_MARKER_BYTES,
      { allowMissing: true, label: MARKER_NAME, unsafeCode: "DEPENDENCY_INSTALL_INCOMPLETE" },
    );
    if (!markerRecord) return false;
    const marker = JSON.parse(markerRecord.contents.toString("utf8"));
    if (!isRecord(marker) || marker.schema_version !== MARKER_SCHEMA_VERSION) return false;
    const installed = await captureInstalledState(policy, lock);
    const expected = markerFor(policy, lock, installed);
    return JSON.stringify(marker) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function diagnosticFromResult(result) {
  if (!result) return { stdout: "", stderr: "", output_truncated: false };
  const stdout = redactText(result.stdout ?? "");
  const stderr = redactText(result.stderr ?? "");
  return {
    stdout: truncateUtf8(stdout, MAX_DIAGNOSTIC_BYTES),
    stderr: truncateUtf8(stderr, MAX_DIAGNOSTIC_BYTES),
    output_truncated: Boolean(result.output_truncated) ||
      Buffer.byteLength(stdout, "utf8") > MAX_DIAGNOSTIC_BYTES ||
      Buffer.byteLength(stderr, "utf8") > MAX_DIAGNOSTIC_BYTES,
  };
}

function successEnvelope({
  mode,
  manager,
  duration,
  changed = false,
  skipped = false,
  lock = null,
  processResult = null,
}) {
  return {
    schema_version: 1,
    operation: OPERATION,
    classification: "success",
    error_code: null,
    action: OPERATION,
    package_manager: manager,
    success: true,
    code: 0,
    timed_out: false,
    duration_ms: duration,
    mode,
    changed,
    skipped,
    lockfile_sha256: lock?.hash ?? null,
    diagnostic: diagnosticFromResult(processResult),
  };
}

export function dependencyFailureEnvelope(error, {
  mode = "sync",
  manager = null,
  duration = 0,
} = {}) {
  const classification = ["task_failure", "environment_failure"].includes(error?.classification)
    ? error.classification
    : "controller_failure";
  const rawCode = typeof error?.code === "string" ? error.code : "DEPENDENCY_CONTROLLER_FAILURE";
  const errorCode = /^[A-Z][A-Z0-9_]{0,95}$/.test(rawCode)
    ? rawCode
    : "DEPENDENCY_CONTROLLER_FAILURE";
  const processResult = error?.processResult ?? null;
  const diagnostic = processResult
    ? diagnosticFromResult(processResult)
    : {
      stdout: "",
      stderr: truncateUtf8(redactText(error?.message ?? "Dependency action failed"), MAX_DIAGNOSTIC_BYTES),
      output_truncated: Buffer.byteLength(String(error?.message ?? ""), "utf8") > MAX_DIAGNOSTIC_BYTES,
    };
  return {
    schema_version: 1,
    operation: OPERATION,
    classification,
    error_code: errorCode,
    action: OPERATION,
    package_manager: manager ?? error?.packageManager ?? null,
    success: false,
    code: Number.isInteger(processResult?.code) ? processResult.code : null,
    timed_out: Boolean(processResult?.timed_out),
    duration_ms: duration,
    mode,
    changed: false,
    skipped: false,
    lockfile_sha256: null,
    diagnostic,
  };
}

async function createResolutionWorkspace(policy, privateEnvironment, snapshot) {
  const stagingRoot = path.join(privateEnvironment.directory, "resolution-workspace");
  await mkdir(stagingRoot, { recursive: true });
  const stagedManifests = [];
  for (const item of policy.manifests) {
    const directory = item.importer === "."
      ? stagingRoot
      : path.join(stagingRoot, ...item.importer.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), item.contents, { mode: 0o600 });
    if (item.npmrcContents.length > 0) {
      await writeFile(path.join(directory, ".npmrc"), item.npmrcContents, { mode: 0o600 });
    }
    stagedManifests.push({ ...item, directory });
  }
  if (policy.workspaceContents) {
    await writeFile(
      path.join(stagingRoot, "pnpm-workspace.yaml"),
      policy.workspaceContents,
      { mode: 0o600 },
    );
  }
  if (snapshot.existed) {
    assertSerializedLockfileSourcesSafe(snapshot.contents);
    await writeFile(path.join(stagingRoot, "pnpm-lock.yaml"), snapshot.contents, { mode: 0o600 });
  }
  return { ...policy, root: stagingRoot, manifests: stagedManifests };
}

async function validateImmutableHydrationInputs(policy, initialLock) {
  let currentLock;
  try { currentLock = await validatePnpmLockfile(policy.root, policy); }
  catch (error) {
    throw dependencyError(error.message, error.code ?? "DEPENDENCY_LOCKFILE_INCOMPLETE", {
      classification: "controller_failure",
    });
  }
  if (currentLock.hash !== initialLock.hash) {
    throw dependencyError(
      "Frozen dependency hydration changed pnpm-lock.yaml",
      "DEPENDENCY_LOCKFILE_UNSTABLE",
      { classification: "controller_failure" },
    );
  }
  const currentPolicy = await inspectProjectPolicy(policy.root);
  if (
    currentPolicy.packageHash !== policy.packageHash ||
    currentPolicy.npmrcHash !== policy.npmrcHash ||
    currentPolicy.manager !== policy.manager
  ) {
    throw dependencyError(
      "Dependency inputs changed while frozen hydration was running",
      "DEPENDENCY_INPUT_CHANGED",
      { classification: "controller_failure" },
    );
  }
  return currentLock;
}

async function hydrateDependencies(policy, initialLock, {
  execute,
  sourceEnvironment,
  temporaryRoot,
}) {
  const snapshot = await captureLockfile(policy);
  let privateEnvironment = null;
  let lastResult = null;
  let outcome = null;
  let failure = null;
  try {
    privateEnvironment = await createPrivateEnvironment(
      policy.root,
      sourceEnvironment,
      temporaryRoot,
      { persistentStore: true },
    );
    const commonArgv = [
      "corepack", "pnpm", "install",
      "--ignore-scripts", "--ignore-pnpmfile", "--reporter=ndjson",
      "--store-dir", privateEnvironment.store,
      "--frozen-lockfile", "--force",
    ];
    const baseOptions = {
      cwd: policy.root,
      env: privateEnvironment.env,
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 64 * 1024,
      guardProcessTree: true,
    };
    const offlineOptions = {
      ...baseOptions,
      env: {
        ...privateEnvironment.env,
        COREPACK_ENABLE_NETWORK: "0",
        NPM_CONFIG_OFFLINE: "true",
      },
    };
    const onlineOptions = {
      ...baseOptions,
      env: {
        ...privateEnvironment.env,
        COREPACK_ENABLE_NETWORK: "1",
        NPM_CONFIG_OFFLINE: "false",
      },
    };

    try {
      lastResult = await verifyPinnedManager(execute, policy, offlineOptions);
    } catch (error) {
      if (error?.code !== "DEPENDENCY_PINNED_MANAGER_UNAVAILABLE") throw error;
      await verifyPinnedManager(execute, policy, onlineOptions);
      lastResult = await verifyPinnedManager(execute, policy, offlineOptions);
    }

    await validateImmutableHydrationInputs(policy, initialLock);
    lastResult = await executeBounded(execute, [...commonArgv, "--offline"], offlineOptions);
    if (lastResult.code !== 0 || lastResult.timed_out) {
      const codes = structuredPnpmErrorCodes(lastResult);
      const cacheMiss = codes.size > 0 && [...codes].every((code) => OFFLINE_CACHE_ERROR_CODES.has(code));
      if (!cacheMiss) throw processFailure(lastResult, "frozen");

      await validateImmutableHydrationInputs(policy, initialLock);
      lastResult = await executeBounded(execute, commonArgv, onlineOptions);
      if (lastResult.code !== 0 || lastResult.timed_out) throw processFailure(lastResult, "frozen");
      await validateImmutableHydrationInputs(policy, initialLock);

      lastResult = await executeBounded(execute, [...commonArgv, "--offline"], offlineOptions);
      if (lastResult.code !== 0 || lastResult.timed_out) {
        throw dependencyError(
          "The controller store could not reproduce the frozen dependency graph offline",
          "DEPENDENCY_OFFLINE_REUSE_FAILED",
          { classification: "controller_failure", processResult: lastResult },
        );
      }
    }

    const frozenLock = await validateImmutableHydrationInputs(policy, initialLock);
    let installed;
    try { installed = await captureInstalledState(policy, frozenLock); }
    catch (error) {
      throw dependencyError(error.message, error.code ?? "DEPENDENCY_INSTALL_INCOMPLETE", {
        classification: "controller_failure",
        processResult: lastResult,
      });
    }
    outcome = { lock: frozenLock, installed };
  } catch (error) {
    failure = error;
  }

  if (privateEnvironment) {
    try { await removePrivateEnvironment(privateEnvironment); }
    catch (error) { failure = error; }
  }
  if (failure) {
    await restoreLockfile(snapshot);
    throw failure;
  }
  if (outcome.lock.lockedDependencies > 0) {
    try { await writeMarker(policy, markerFor(policy, outcome.lock, outcome.installed)); }
    catch (error) {
      await restoreLockfile(snapshot);
      throw error;
    }
  }
  return { ...outcome, processResult: lastResult };
}

async function syncDependencies(policy, {
  execute,
  sourceEnvironment,
  temporaryRoot,
}) {
  const snapshot = await captureLockfile(policy);
  let privateEnvironment = null;
  let lastResult = null;
  let outcome = null;
  let failure = null;
  try {
    privateEnvironment = await createPrivateEnvironment(policy.root, sourceEnvironment, temporaryRoot);
    const stagedPolicy = await createResolutionWorkspace(policy, privateEnvironment, snapshot);
    const commonArgv = [
      "corepack",
      "pnpm",
      "install",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--reporter=ndjson",
      "--store-dir",
      privateEnvironment.store,
    ];
    const processOptions = {
      cwd: policy.root,
      env: privateEnvironment.env,
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 64 * 1024,
      guardProcessTree: true,
    };
    lastResult = await verifyPinnedManager(execute, policy, processOptions);
    lastResult = await executeBounded(
      execute,
      [...commonArgv, "--frozen-lockfile=false"],
      { ...processOptions, cwd: stagedPolicy.root },
    );
    if (lastResult.code !== 0 || lastResult.timed_out) throw processFailure(lastResult, "resolve");
    let firstLock;
    try { firstLock = await validatePnpmLockfile(stagedPolicy.root, stagedPolicy); }
    catch (error) {
      throw dependencyError(error.message, error.code ?? "DEPENDENCY_LOCKFILE_INCOMPLETE", {
        classification: [
          "DEPENDENCY_CONFIG_CREDENTIALS",
          "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
        ].includes(error?.code) ? "task_failure" : "controller_failure",
        processResult: lastResult,
      });
    }

    const beforePromotionPolicy = await inspectProjectPolicy(policy.root);
    if (
      beforePromotionPolicy.packageHash !== policy.packageHash ||
      beforePromotionPolicy.npmrcHash !== policy.npmrcHash ||
      beforePromotionPolicy.manager !== policy.manager
    ) {
      throw dependencyError(
        "Dependency inputs changed while the disposable resolution was running",
        "DEPENDENCY_INPUT_CHANGED",
      );
    }
    await atomicWriteFile(snapshot.file, firstLock.contents);

    lastResult = await executeBounded(
      execute,
      [...commonArgv, "--frozen-lockfile", "--offline", "--force"],
      processOptions,
    );
    if (lastResult.code !== 0 || lastResult.timed_out) throw processFailure(lastResult, "frozen");
    let frozenLock;
    try { frozenLock = await validatePnpmLockfile(policy.root, policy); }
    catch (error) {
      throw dependencyError(error.message, error.code ?? "DEPENDENCY_LOCKFILE_INCOMPLETE", {
        classification: "controller_failure",
        processResult: lastResult,
      });
    }
    if (firstLock.hash !== frozenLock.hash) {
      throw dependencyError(
        "The frozen validation changed pnpm-lock.yaml",
        "DEPENDENCY_LOCKFILE_UNSTABLE",
        { classification: "controller_failure", processResult: lastResult },
      );
    }
    const currentPolicy = await inspectProjectPolicy(policy.root);
    if (
      currentPolicy.packageHash !== policy.packageHash ||
      currentPolicy.npmrcHash !== policy.npmrcHash ||
      currentPolicy.manager !== policy.manager
    ) {
      throw dependencyError(
        "Dependency inputs changed while the controller action was running",
        "DEPENDENCY_INPUT_CHANGED",
      );
    }
    let installed;
    try { installed = await captureInstalledState(policy, frozenLock); }
    catch (error) {
      throw dependencyError(error.message, error.code ?? "DEPENDENCY_INSTALL_INCOMPLETE", {
        classification: "controller_failure",
        processResult: lastResult,
      });
    }
    outcome = { lock: frozenLock, installed };
  } catch (error) {
    failure = error;
  }

  if (privateEnvironment) {
    try { await removePrivateEnvironment(privateEnvironment); }
    catch (error) { failure = error; }
  }
  if (failure) {
    try { await restoreLockfile(snapshot); }
    catch (rollbackError) { throw rollbackError; }
    throw failure;
  }
  try {
    if (outcome.lock.lockedDependencies > 0) {
      await writeMarker(policy, markerFor(policy, outcome.lock, outcome.installed));
    }
  } catch (error) {
    await restoreLockfile(snapshot);
    throw error;
  }
  return { ...outcome, processResult: lastResult };
}

export async function ensureDependencyState(requestedRoot, {
  mode = "if-needed",
  execute = runArgv,
  environment = process.env,
  temporaryRoot = os.tmpdir(),
} = {}) {
  const started = Date.now();
  let policy = null;
  try {
    if (!["if-needed", "force", "hydrate"].includes(mode)) {
      throw dependencyError(
        "Dependency sync mode must be if-needed, force, or hydrate",
        "DEPENDENCY_USAGE_INVALID",
      );
    }
    policy = await inspectProjectPolicy(requestedRoot);
    if (mode === "hydrate") {
      const existing = await validatePnpmLockfile(policy.root, policy);
      if (await installedStateMatches(policy, existing)) {
        return successEnvelope({
          mode,
          manager: policy.manager,
          duration: Date.now() - started,
          skipped: true,
          lock: existing,
        });
      }
      const hydrated = await hydrateDependencies(policy, existing, {
        execute,
        sourceEnvironment: environment,
        temporaryRoot,
      });
      return successEnvelope({
        mode,
        manager: policy.manager,
        duration: Date.now() - started,
        changed: true,
        lock: hydrated.lock,
        processResult: hydrated.processResult,
      });
    }
    if (mode === "if-needed") {
      try {
        const existing = await validatePnpmLockfile(policy.root, policy);
        if (await installedStateMatches(policy, existing)) {
          const confirmedPolicy = await inspectProjectPolicy(policy.root);
          if (
            confirmedPolicy.packageHash === policy.packageHash &&
            confirmedPolicy.npmrcHash === policy.npmrcHash &&
            confirmedPolicy.manager === policy.manager
          ) {
            const confirmedLock = await validatePnpmLockfile(policy.root, confirmedPolicy);
            if (confirmedLock.hash === existing.hash) {
              return successEnvelope({
                mode,
                manager: policy.manager,
                duration: Date.now() - started,
                skipped: true,
                lock: confirmedLock,
              });
            }
          }
          policy = confirmedPolicy;
        }
      } catch (error) {
        if (error?.code !== "DEPENDENCY_LOCKFILE_INCOMPLETE") throw error;
      }
    }
    const result = await syncDependencies(policy, { execute, sourceEnvironment: environment, temporaryRoot });
    return successEnvelope({
      mode,
      manager: policy.manager,
      duration: Date.now() - started,
      changed: true,
      lock: result.lock,
      processResult: result.processResult,
    });
  } catch (error) {
    return dependencyFailureEnvelope(error, {
      mode,
      manager: policy?.manager ?? error?.packageManager ?? null,
      duration: Date.now() - started,
    });
  }
}

async function verifiedNodeExecutable(nodeExecutable) {
  try {
    const resolved = await realpath(nodeExecutable);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw dependencyError("Controller Node executable is unavailable", "DEPENDENCY_NODE_UNAVAILABLE", {
      classification: "controller_failure",
    });
  }
}

export async function probeDependencyManager(requestedRoot, {
  execute = runArgv,
  environment = process.env,
  temporaryRoot = os.tmpdir(),
  nodeExecutable = process.execPath,
} = {}) {
  const started = Date.now();
  let policy = null;
  let privateEnvironment = null;
  try {
    policy = await inspectProjectPolicy(requestedRoot);
    const controllerNode = await verifiedNodeExecutable(nodeExecutable);
    privateEnvironment = await createPrivateEnvironment(policy.root, environment, temporaryRoot);
    const probeEnvironment = {
      ...privateEnvironment.env,
      COREPACK_ENABLE_NETWORK: "0",
      NPM_CONFIG_OFFLINE: "true",
    };
    const options = {
      cwd: policy.root,
      env: probeEnvironment,
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024,
      guardProcessTree: true,
    };
    const nodeResult = await executeBounded(execute, [controllerNode, "--version"], options);
    if (nodeResult.code !== 0 || nodeResult.timed_out) {
      throw dependencyError("Controller Node invocation failed", "DEPENDENCY_NODE_UNAVAILABLE", {
        classification: "controller_failure",
        processResult: nodeResult,
      });
    }
    const corepackResult = await executeBounded(execute, ["corepack", "--version"], options);
    if (corepackResult.code !== 0 || corepackResult.timed_out) {
      throw dependencyError("Corepack invocation failed", "DEPENDENCY_COREPACK_UNAVAILABLE", {
        classification: "controller_failure",
        processResult: corepackResult,
      });
    }
    let pinnedManagerResult;
    try {
      pinnedManagerResult = await verifyPinnedManager(execute, policy, options);
    } catch (error) {
      if (error?.code !== "DEPENDENCY_PINNED_MANAGER_UNAVAILABLE") throw error;
      const provisionOptions = {
        ...options,
        env: {
          ...privateEnvironment.env,
          COREPACK_ENABLE_NETWORK: "1",
          NPM_CONFIG_OFFLINE: "false",
        },
        timeoutMs: 2 * 60 * 1000,
      };
      await verifyPinnedManager(execute, policy, provisionOptions);
      pinnedManagerResult = await verifyPinnedManager(execute, policy, options);
    }
    await removePrivateEnvironment(privateEnvironment);
    privateEnvironment = null;
    return successEnvelope({
      mode: "probe",
      manager: policy.manager,
      duration: Date.now() - started,
      skipped: true,
      processResult: pinnedManagerResult,
    });
  } catch (error) {
    if (privateEnvironment) {
      try { await removePrivateEnvironment(privateEnvironment); }
      catch (cleanupError) { error = cleanupError; }
    }
    return dependencyFailureEnvelope(error, {
      mode: "probe",
      manager: policy?.manager ?? error?.packageManager ?? null,
      duration: Date.now() - started,
    });
  }
}
