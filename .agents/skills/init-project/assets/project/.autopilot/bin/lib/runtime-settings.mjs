import path from "node:path";
import {
  assertPrivateDirectory,
  assertPrivateFile,
  atomicWriteFile,
  exists,
  readJson,
  stableJson,
} from "./core.mjs";

export const RUNTIME_SETTINGS_PATH = ".autopilot/runtime/settings.json";
export const RUNTIME_VARIANTS = Object.freeze([
  null,
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "minimal",
  "none",
]);

const SETTINGS_BYTES = 4 * 1024;
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeRuntimeVariant(value) {
  if (value === null || value === undefined || value === "" || value === "default") return null;
  if (typeof value !== "string" || !VARIANT_PATTERN.test(value)) {
    throw new Error("Worker reasoning variant must be default or a safe provider variant ID");
  }
  return value;
}

export function runtimeVariantLabel(value) {
  return normalizeRuntimeVariant(value) ?? "default";
}

export function nextRuntimeVariant(value) {
  const normalized = normalizeRuntimeVariant(value);
  const index = RUNTIME_VARIANTS.indexOf(normalized);
  return RUNTIME_VARIANTS[(index < 0 ? 0 : index + 1) % RUNTIME_VARIANTS.length];
}

export async function readRuntimeSettings(root) {
  const file = path.join(path.resolve(root), ...RUNTIME_SETTINGS_PATH.split("/"));
  if (!(await exists(file))) return { schema_version: 1, variant: null };
  await assertPrivateFile(root, file, "runtime settings");
  const value = await readJson(file, { maxBytes: SETTINGS_BYTES });
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.schema_version !== 1 ||
    Object.keys(value).some((key) => !["schema_version", "variant"].includes(key))
  ) throw new Error("Runtime settings must be a schema_version 1 object containing only variant");
  return { schema_version: 1, variant: normalizeRuntimeVariant(value.variant) };
}

export async function writeRuntimeVariant(root, value) {
  const resolved = path.resolve(root);
  const runtime = path.join(resolved, ".autopilot", "runtime");
  const file = path.join(runtime, "settings.json");
  await assertPrivateDirectory(resolved, resolved, "project root");
  await assertPrivateDirectory(resolved, path.join(resolved, ".autopilot"), ".autopilot directory");
  await assertPrivateDirectory(resolved, runtime, "runtime directory");
  await assertPrivateFile(resolved, file, "runtime settings", { optional: true });
  const settings = { schema_version: 1, variant: normalizeRuntimeVariant(value) };
  await atomicWriteFile(file, `${stableJson(settings)}\n`);
  await assertPrivateFile(resolved, file, "runtime settings");
  return settings;
}
