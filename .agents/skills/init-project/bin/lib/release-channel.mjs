import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { selectedHome } from "./project-registry.mjs";

export const RELEASE_API = "https://api.github.com/repos/therealedo/opencode-control-plane/releases/latest";
export const RELEASE_REPOSITORY = "https://github.com/therealedo/opencode-control-plane.git";
const RELEASE_PAGE_PREFIX = "https://github.com/therealedo/opencode-control-plane/releases/tag/";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 64 * 1024;

export function updateCacheFile(home = selectedHome()) {
  return path.join(path.resolve(home), ".agents", "opencode-control-plane", "update-cache.json");
}

export async function checkForUpdate({
  installedVersion,
  home = selectedHome(),
  force = false,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  ttlMs = CACHE_TTL_MS,
} = {}) {
  parseVersion(installedVersion);
  const cached = await readCache(home);
  if (!force && cached && cached.installed_version === installedVersion && now - Date.parse(cached.checked_at) < ttlMs) {
    return { ...cached, cached: true, stale: false };
  }
  if (typeof fetchImpl !== "function") return offlineResult(installedVersion, cached, "Update checks are unavailable in this Node.js runtime");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASE_API, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-control-plane",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response?.ok) throw new Error(`GitHub returned HTTP ${response?.status ?? "unknown"}`);
    const length = Number(response.headers?.get?.("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("Release response is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Release response is too large");
    const release = JSON.parse(text);
    const tag = String(release?.tag_name ?? "");
    const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
    if (!match || release?.draft || release?.prerelease) throw new Error("Latest GitHub release is not a stable vMAJOR.MINOR.PATCH release");
    if (release?.html_url !== `${RELEASE_PAGE_PREFIX}${tag}`) throw new Error("Latest release points outside the trusted repository");
    const latestVersion = match[1];
    const result = {
      schema_version: 1,
      checked_at: new Date(now).toISOString(),
      installed_version: installedVersion,
      latest_version: latestVersion,
      tag,
      url: release.html_url,
      update_available: compareVersions(latestVersion, installedVersion) > 0,
      cached: false,
      stale: false,
      error: null,
    };
    await writeCache(home, result).catch(() => {});
    return result;
  } catch (error) {
    return offlineResult(installedVersion, cached, cleanError(error));
  } finally {
    clearTimeout(timer);
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function releaseTag(version) {
  parseVersion(version);
  return `v${version}`;
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value ?? ""));
  if (!match) throw new Error(`Invalid stable semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function offlineResult(installedVersion, cached, message) {
  if (cached?.latest_version) {
    return {
      ...cached,
      installed_version: installedVersion,
      update_available: compareVersions(cached.latest_version, installedVersion) > 0,
      cached: true,
      stale: true,
      error: message,
    };
  }
  return {
    schema_version: 1,
    checked_at: null,
    installed_version: installedVersion,
    latest_version: null,
    tag: null,
    url: null,
    update_available: false,
    cached: false,
    stale: true,
    error: message,
  };
}

async function readCache(home) {
  const file = updateCacheFile(home);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > MAX_CACHE_BYTES) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    if (
      value?.schema_version !== 1 || typeof value.checked_at !== "string" ||
      typeof value.installed_version !== "string" || typeof value.latest_version !== "string" ||
      !/^v\d+\.\d+\.\d+$/.test(value.tag ?? "") ||
      value.url !== `${RELEASE_PAGE_PREFIX}${value.tag}`
    ) return null;
    parseVersion(value.installed_version);
    parseVersion(value.latest_version);
    return value;
  } catch {
    return null;
  }
}

async function writeCache(home, value) {
  const file = updateCacheFile(home);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CACHE_BYTES) throw new Error("Update cache is too large");
  const stage = path.join(directory, `.${path.basename(file)}.stage-${process.pid}-${randomBytes(5).toString("hex")}`);
  const backup = `${stage}.backup`;
  let moved = false;
  try {
    await writeFile(stage, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1) throw new Error("Update cache is unsafe");
      await rename(file, backup);
      moved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stage, file);
    if (moved) await rm(backup, { force: true });
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    if (moved) {
      await rm(file, { force: true }).catch(() => {});
      await rename(backup, file).catch(() => {});
    }
    throw error;
  }
}

function cleanError(error) {
  const message = error?.name === "AbortError" ? "Update check timed out" : error?.message ?? String(error);
  return String(message).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export const releaseChannelLimits = Object.freeze({
  cache_ttl_ms: CACHE_TTL_MS,
  fetch_timeout_ms: FETCH_TIMEOUT_MS,
  max_response_bytes: MAX_RESPONSE_BYTES,
});
