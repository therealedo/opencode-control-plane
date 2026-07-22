import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const ROLE_BEGIN = "# BEGIN AUTOPILOT MANAGED TOOL GRANTS";
export const ROLE_END = "# END AUTOPILOT MANAGED TOOL GRANTS";
export const IGNORE_BEGIN = "# BEGIN OPENCODE CONTROL PLANE MANAGED";
export const IGNORE_END = "# END OPENCODE CONTROL PLANE MANAGED";
const MAX_MANAGED_FILES = 256;
const MAX_MANAGED_BYTES = 2 * 1024 * 1024;

export async function loadControlPlaneRelease(skillRoot) {
  const file = path.join(skillRoot, "assets", "control-plane-release.json");
  const release = JSON.parse(await readFile(file, "utf8"));
  if (
    release.schema_version !== 1 ||
    release.product_id !== "opencode-control-plane" ||
    typeof release.name !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version ?? "") ||
    release.repository !== "https://github.com/therealedo/opencode-control-plane.git" ||
    typeof release.identity !== "string" ||
    release.project_manifest_schema !== 1
  ) throw new Error(`Invalid Control Plane release manifest: ${file}`);
  return release;
}

export async function collectManagedSources(skillRoot) {
  const release = await loadControlPlaneRelease(skillRoot);
  const template = path.join(skillRoot, "assets", "project");
  const entries = new Map();
  const add = async (relative, source, mode = "exact", transform = null) => {
    assertManagedPath(relative);
    const folded = relative.toLowerCase();
    if ([...entries.keys()].some((item) => item.toLowerCase() === folded)) {
      throw new Error(`Duplicate or case-colliding managed path: ${relative}`);
    }
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_MANAGED_BYTES) {
      throw new Error(`Managed source must be one bounded private regular file: ${source}`);
    }
    let bytes = await readFile(source);
    if (transform) bytes = Buffer.from(transform(bytes.toString("utf8")), "utf8");
    hashManaged(mode, bytes);
    entries.set(relative, { relative, source, mode, bytes });
  };
  const addTree = async (relativeRoot, mode) => {
    const absoluteRoot = path.join(template, ...relativeRoot.split("/"));
    for (const item of await walkFiles(absoluteRoot)) {
      const relative = `${relativeRoot}/${path.relative(absoluteRoot, item).replaceAll(path.sep, "/")}`;
      await add(relative, item, mode);
    }
  };

  for (const relative of release.managed_project.exact_files ?? []) {
    await add(relative, path.join(template, ...relative.split("/")), "exact");
  }
  for (const relative of release.managed_project.managed_block_files ?? []) {
    await add(relative, path.join(template, ...relative.split("/")), "managed-block");
  }
  for (const relative of release.managed_project.exact_trees ?? []) await addTree(relative, "exact");
  await addTree(release.managed_project.normalized_role_tree, "normalized-role");

  await add(
    ".autopilot/bin/render-blueprint.mjs",
    path.join(skillRoot, "bin", "render-blueprint.mjs"),
    "exact",
    (value) => value.replaceAll("../assets/project/.autopilot/bin/lib/", "./lib/"),
  );
  await add(
    ".autopilot/bin/evolve-blueprint.mjs",
    path.join(skillRoot, "..", "evolve-project", "bin", "evolve-blueprint.mjs"),
    "exact",
  );
  if (entries.size > MAX_MANAGED_FILES) throw new Error(`Managed file count exceeds ${MAX_MANAGED_FILES}`);
  return { release, entries };
}

export async function createInstalledManifest(skillRoot, projectRoot, {
  installedAt = new Date().toISOString(),
  previous = null,
  kind = "scaffold",
} = {}) {
  const { release, entries } = await collectManagedSources(skillRoot);
  const managedFiles = {};
  for (const [relative, entry] of entries) {
    const file = path.join(projectRoot, ...relative.split("/"));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_MANAGED_BYTES) {
      throw new Error(`Managed project file must be one bounded private regular file: ${relative}`);
    }
    managedFiles[relative] = {
      mode: entry.mode,
      sha256: hashManaged(entry.mode, await readFile(file)),
    };
  }
  for (const [relative, record] of Object.entries(previous?.managed_files ?? {})) {
    if (!Object.hasOwn(managedFiles, relative)) managedFiles[relative] = { ...record, retired: true };
  }
  const history = [
    ...(Array.isArray(previous?.migration_history) ? previous.migration_history : []),
    {
      from_version: previous?.version ?? null,
      to_version: release.version,
      applied_at: installedAt,
      kind,
    },
  ];
  return {
    schema_version: release.project_manifest_schema,
    product_id: release.product_id,
    name: release.name,
    version: release.version,
    repository: release.repository,
    identity: release.identity,
    installed_at: previous?.installed_at ?? installedAt,
    updated_at: installedAt,
    managed_files: Object.fromEntries(Object.entries(managedFiles).sort(([left], [right]) => left.localeCompare(right, "en"))),
    migration_history: history,
  };
}

export function hashManaged(mode, bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  let value;
  if (mode === "exact") value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(text, "utf8");
  else if (mode === "normalized-role") value = Buffer.from(normalizeSection(text, ROLE_BEGIN, ROLE_END), "utf8");
  else if (mode === "managed-block") value = Buffer.from(extractSection(text, IGNORE_BEGIN, IGNORE_END).whole, "utf8");
  else throw new Error(`Unknown managed-file mode: ${mode}`);
  return createHash("sha256").update(value).digest("hex");
}

export function mergeManagedSource(entry, currentBytes, { adopt = false } = {}) {
  if (entry.mode === "exact") return Buffer.from(entry.bytes);
  const sourceText = entry.bytes.toString("utf8");
  const currentText = Buffer.isBuffer(currentBytes) ? currentBytes.toString("utf8") : String(currentBytes ?? "");
  if (entry.mode === "normalized-role") {
    const current = extractSection(currentText, ROLE_BEGIN, ROLE_END);
    const source = extractSection(sourceText, ROLE_BEGIN, ROLE_END);
    const preservedGrantBlock = current.whole.replace(/\r\n?/g, "\n");
    return Buffer.from(`${sourceText.slice(0, source.start)}${preservedGrantBlock}${sourceText.slice(source.end)}`, "utf8");
  }
  if (entry.mode === "managed-block") {
    const source = extractSection(sourceText, IGNORE_BEGIN, IGNORE_END);
    try {
      const current = extractSection(currentText, IGNORE_BEGIN, IGNORE_END);
      return Buffer.from(`${currentText.slice(0, current.start)}${source.whole}${currentText.slice(current.end)}`, "utf8");
    } catch (error) {
      if (!adopt) throw error;
      const prefix = currentText.trimEnd();
      return Buffer.from(`${prefix ? `${prefix}\n\n` : ""}${source.whole}${sourceText.endsWith("\n") ? "\n" : ""}`, "utf8");
    }
  }
  throw new Error(`Unknown managed-file mode: ${entry.mode}`);
}

export function extractSection(text, begin, end) {
  const first = text.indexOf(begin);
  const last = text.indexOf(end);
  if (first < 0 || last < 0 || last < first || text.indexOf(begin, first + begin.length) >= 0 || text.indexOf(end, last + end.length) >= 0) {
    throw new Error(`Managed markers must occur exactly once and in order: ${begin}`);
  }
  const finish = last + end.length;
  return { start: first, end: finish, whole: text.slice(first, finish), inner: text.slice(first + begin.length, last) };
}

export function normalizeSection(text, begin, end) {
  const section = extractSection(text, begin, end);
  return `${text.slice(0, section.start)}${begin}\n<managed>\n${end}${text.slice(section.end)}`;
}

export function assertManagedPath(relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..") ||
    !(
      [".gitattributes", "AGENTS.md", ".ignore", "control-plane", "control-plane.cmd"].includes(relative) ||
      relative.startsWith(".autopilot/bin/") ||
      relative.startsWith(".opencode/agents/") ||
      relative.startsWith(".opencode/commands/")
    )
  ) throw new Error(`Unsafe or unclassified managed path: ${relative}`);
  return relative;
}

async function walkFiles(root) {
  const output = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const location = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Managed source trees cannot contain links: ${location}`);
    if (entry.isDirectory()) output.push(...(await walkFiles(location)));
    else if (entry.isFile()) output.push(location);
    else throw new Error(`Unsupported managed source entry: ${location}`);
  }
  return output;
}
