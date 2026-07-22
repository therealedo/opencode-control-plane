import path from "node:path";
import {
  assertPortableRelative,
  AutopilotError,
  matchesGlob,
  normalizeRelative,
  resolveInside,
  unique,
  utf8Bytes,
} from "./core.mjs";
import { taskEntries } from "./project.mjs";
import { secretIndicators } from "./secrets.mjs";
import { validateTaskToolGrants } from "./tool-grants.mjs";
import { isForbiddenCredentialVariable } from "./mcp.mjs";

export { isForbiddenCredentialVariable } from "./mcp.mjs";

const TASK_STATUSES = new Set(["pending", "ready", "in_progress", "blocked", "done"]);
const PROJECT_STATUSES = new Set(["initializing", "ready", "running", "blocked", "complete"]);
const RUN_STATUSES = new Set([
  "idle",
  "running",
  "paused",
  "human_required",
  "failed",
  "complete",
]);
const RISKS = new Set(["low", "medium", "high"]);
const CONTRACT_TEXT_CAP = 2 * 1024;
const CONTRACT_PATH_CAP = 512;
const CONTRACT_SUMMARY_CAP = 512;
const CONTRACT_FINDING_CAP = 768;
const CONTRACT_BLOCKER_KIND_CAP = 128;
const CONTRACT_BLOCKER_CAP = 1024;
const CONTRACT_FINDINGS_CAP = 16;
const CONTRACT_ARRAY_CAP = 256;
const CONTRACT_OBJECT_CAP = 24 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_PHASE_MODEL_COST = 1_000_000;
const TASK_TOOL_USAGE_MAX_ENTRIES = 40;
const TASK_TOOL_USAGE_MAX_BYTES = 24 * 1024;
const CONTEXT_PHASES = Object.freeze(["execute", "repair", "review"]);
const TASK_CONTEXT_KEYS = Object.freeze(["shared", ...CONTEXT_PHASES]);
const PROTECTED_PATTERNS = [
  "AGENTS.md",
  "control-plane",
  "control-plane.cmd",
  ".gitignore",
  "**/.gitignore",
  ".gitattributes",
  "**/.gitattributes",
  ".gitmodules",
  "**/.gitmodules",
  ".ignore",
  "opencode.json",
  "opencode.jsonc",
  ".git",
  ".git/**",
  ".env*",
  ".project",
  ".project/**",
  ".autopilot",
  ".autopilot/**",
  ".opencode",
  ".opencode/**",
  ".agents",
  ".agents/**",
  "blueprints",
  "blueprints/**",
];

function issue(issues, location, message, code = undefined) {
  issues.push({ location, message, ...(code ? { code } : {}) });
}

function rejectUnknownKeys(issues, location, value, allowed) {
  if (!object(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${location}.${key}`, "is not an allowed contract field");
  }
}

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function protectedControlPath(value) {
  const normalized = normalizeRelative(value).toLowerCase().replace(/\/+$/, "");
  const parts = normalized.split("/");
  if ([".git", ".project", ".autopilot", ".opencode", ".agents"].includes(parts[0])) return true;
  if (["agents.md", ".ignore", ".gitignore", ".gitattributes", ".gitmodules", "opencode.json", "opencode.jsonc"].includes(normalized)) return true;
  if (parts.some((part) => [".gitignore", ".gitattributes", ".gitmodules"].includes(part))) return true;
  return parts.some((part) => part.startsWith(".env"));
}

function taskPatternOverlapsRoot(pattern, root) {
  try {
    const normalized = normalizeRelative(pattern);
    const normalizedRoot = assertPortableRelative(root, "ephemeral root");
    const literal = normalized.split("*")[0].replace(/\/+$/, "");
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`) ||
      matchesGlob(normalizedRoot, normalized) || matchesGlob(`${normalizedRoot}/sentinel`, normalized) ||
      (literal && (literal === normalizedRoot || literal.startsWith(`${normalizedRoot}/`) || normalizedRoot.startsWith(`${literal}/`)));
  } catch {
    return false;
  }
}

function boundedString(issues, location, value, {
  maxBytes = CONTRACT_TEXT_CAP,
  nonEmpty = true,
  scanSecrets = true,
} = {}) {
  if (typeof value !== "string" || (nonEmpty && !value.trim())) {
    issue(issues, location, nonEmpty ? "must be a non-empty string" : "must be a string");
    return;
  }
  if (utf8Bytes(value) > maxBytes) issue(issues, location, `exceeds ${maxBytes} UTF-8 bytes`);
  if (/[\0-\x1f\x7f]/.test(value)) issue(issues, location, "contains control characters");
  if (scanSecrets && secretIndicators(value).length > 0) {
    issue(issues, location, "contains a possible secret value", "CONTRACT_SECRET");
  }
}

export function validateConfig(config) {
  const issues = [];
  if (!object(config)) {
    issue(issues, "config", "must be an object with schema_version 1");
    return issues;
  }
  if (config.schema_version !== 1) issue(issues, "config", "schema_version must be 1");
  if (!object(config.opencode) || !stringArray(config.opencode.command) || config.opencode.command.length === 0) {
    issue(issues, "config.opencode.command", "must be a non-empty string array");
  } else {
    if (config.opencode.command.length > 64) issue(issues, "config.opencode.command", "exceeds 64 fixed arguments");
    for (const argument of config.opencode.command) {
      if (!argument || /[\r\n\0]/.test(argument)) issue(issues, "config.opencode.command", "contains an empty or unsafe argument");
      if (utf8Bytes(argument) > 2048) issue(issues, "config.opencode.command", "contains an argument over 2048 bytes");
      if (/^(?:--(?:continue|session|fork)(?:=|$)|-[cs](?:=|$))/.test(argument)) {
        issue(issues, "config.opencode.command", `${argument} would reuse a session; fresh sessions are mandatory`);
      }
    }
  }
  const phaseAgents = config.opencode?.agents;
  if (object(phaseAgents)) {
    const configuredAgents = [];
    for (const phase of ["execute", "repair", "review"]) {
      if (
        typeof phaseAgents[phase] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(phaseAgents[phase])
      ) {
        issue(issues, `config.opencode.agents.${phase}`, "must name the phase-specific agent");
      } else configuredAgents.push(phaseAgents[phase]);
    }
    if (new Set(configuredAgents).size !== configuredAgents.length) issue(issues, "config.opencode.agents", "phase-specific agent IDs must be unique");
  } else {
    issue(issues, "config.opencode.agents", "must define execute, repair, and review agents");
  }
  if (config.opencode?.timeout_seconds !== undefined && !positiveInteger(config.opencode.timeout_seconds)) {
    issue(issues, "config.opencode.timeout_seconds", "must be a positive integer");
  } else if (config.opencode?.timeout_seconds > 7200) {
    issue(issues, "config.opencode.timeout_seconds", "cannot exceed 7200 seconds");
  }
  if (config.opencode?.max_output_bytes !== undefined && !positiveInteger(config.opencode.max_output_bytes)) {
    issue(issues, "config.opencode.max_output_bytes", "must be a positive integer");
  } else if (config.opencode?.max_output_bytes > 4 * 1024 * 1024) {
    issue(issues, "config.opencode.max_output_bytes", "cannot exceed 4194304 bytes");
  }
  if (config.opencode?.credential_profile !== undefined) {
    issue(issues, "config.opencode.credential_profile", "is unsupported; use phase-specific opencode.credential_profiles");
  }
  if (config.opencode?.attach_url !== null && config.opencode?.attach_url !== undefined) {
    issue(issues, "config.opencode.attach_url", "must be null; autonomous phases require an isolated OpenCode process");
  }
  if (config.opencode?.auto_approve !== true) {
    issue(issues, "config.opencode.auto_approve", "must be true so autonomous phases cannot pause inside an unobservable approval prompt");
  }
  if (
    typeof config.opencode?.model !== "string" ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@/-]+$/.test(config.opencode.model)
  ) {
    issue(issues, "config.opencode.model", "must be one fixed provider/model identifier");
  }
  const providerAuthMode = config.opencode?.provider_auth_mode;
  if (!["auth_file", "environment", "none"].includes(providerAuthMode)) {
    issue(issues, "config.opencode.provider_auth_mode", "must be auth_file, environment, or none");
  }
  if (config.opencode?.provider_environment !== undefined) {
    if (!stringArray(config.opencode.provider_environment)) {
      issue(issues, "config.opencode.provider_environment", "must be an environment-variable name array");
    } else {
      const seen = new Set();
      for (const name of config.opencode.provider_environment) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isForbiddenCredentialVariable(name)) {
          issue(issues, "config.opencode.provider_environment", `${name} is not safe for provider injection`);
        }
        const folded = name.toUpperCase();
        if (seen.has(folded)) issue(issues, "config.opencode.provider_environment", `repeats ${name} case-insensitively`);
        seen.add(folded);
      }
    }
  }
  if (providerAuthMode === "environment" && (config.opencode?.provider_environment?.length ?? 0) === 0) {
    issue(issues, "config.opencode.provider_environment", "must be non-empty in environment auth mode");
  }
  if (providerAuthMode !== "environment" && (config.opencode?.provider_environment?.length ?? 0) !== 0) {
    issue(issues, "config.opencode.provider_environment", "is allowed only in environment auth mode");
  }
  const phaseCredentials = config.opencode?.credential_profiles;
  if (phaseCredentials !== undefined) {
    if (!object(phaseCredentials)) {
      issue(issues, "config.opencode.credential_profiles", "must map execute, repair, and review to a profile name or null");
    } else {
      for (const phase of ["execute", "repair", "review"]) {
        const profile = phaseCredentials[phase];
        if (profile !== null && profile !== undefined && (typeof profile !== "string" || !profile)) {
          issue(issues, `config.opencode.credential_profiles.${phase}`, "must be a profile name or null");
        }
      }
      for (const key of Object.keys(phaseCredentials)) {
        if (!["execute", "repair", "review"].includes(key)) issue(issues, `config.opencode.credential_profiles.${key}`, "is not a runtime phase");
      }
    }
  }
  const budgetMaxima = {
    max_tasks_per_run: 100,
    max_attempts_per_task: 20,
    max_elapsed_minutes: 1440,
    max_no_progress: 20,
  };
  for (const key of Object.keys(budgetMaxima)) {
    if (!positiveInteger(config.budgets?.[key])) issue(issues, `config.budgets.${key}`, "must be a positive integer");
    else if (config.budgets[key] > budgetMaxima[key]) issue(issues, `config.budgets.${key}`, `cannot exceed ${budgetMaxima[key]}`);
  }
  if (config.git?.require_clean_start !== true) issue(issues, "config.git.require_clean_start", "must be true so pre-existing application changes cannot be absorbed into a task");
  if (typeof config.git?.local_commits !== "boolean") issue(issues, "config.git.local_commits", "must be boolean");
  if (typeof config.git?.commit_prefix !== "string" || !config.git.commit_prefix.trim()) issue(issues, "config.git.commit_prefix", "must be non-empty");
  if (!stringArray(config.git?.ephemeral_roots)) {
    issue(issues, "config.git.ephemeral_roots", "must be a literal project-relative directory array");
  } else {
    if (config.git.ephemeral_roots.length > 128) issue(issues, "config.git.ephemeral_roots", "exceeds 128 roots");
    const seen = new Set();
    for (const root of config.git.ephemeral_roots) {
      try {
        const portable = assertPortableRelative(root, "config.git.ephemeral_roots");
        if (utf8Bytes(portable) > 512 || /[*?\[\]]/.test(portable) || protectedControlPath(portable)) {
          issue(issues, "config.git.ephemeral_roots", `${root} is not a literal non-control application root`);
        }
        if (seen.has(portable)) issue(issues, "config.git.ephemeral_roots", `repeats ${root}`);
        seen.add(portable);
      } catch (error) {
        issue(issues, "config.git.ephemeral_roots", error.message);
      }
    }
  }
  if (!positiveInteger(config.context?.max_bytes) || config.context.max_bytes > MAX_CONTEXT_BYTES) issue(issues, "config.context.max_bytes", `must be between 1 and ${MAX_CONTEXT_BYTES}`);
  if (config.credential_profiles_file !== ".autopilot/credentials.json") {
    issue(issues, "config.credential_profiles_file", "must be exactly .autopilot/credentials.json");
  }
  return issues;
}

export function validateManifest(manifest) {
  const issues = [];
  if (!object(manifest)) {
    issue(issues, "manifest", "must be an object with schema_version 2");
    return issues;
  }
  rejectUnknownKeys(issues, "manifest", manifest, [
    "schema_version", "max_context_bytes", "review_reserve", "bundles",
  ]);
  if (manifest.schema_version !== 2) issue(issues, "manifest", "schema_version must be 2");
  if (!positiveInteger(manifest.max_context_bytes) || manifest.max_context_bytes > MAX_CONTEXT_BYTES) issue(issues, "manifest.max_context_bytes", `must be between 1 and ${MAX_CONTEXT_BYTES}`);
  if (!object(manifest.review_reserve)) {
    issue(issues, "manifest.review_reserve", "must declare candidate_and_gates_bytes and diff_bytes");
  } else {
    rejectUnknownKeys(issues, "manifest.review_reserve", manifest.review_reserve, [
      "candidate_and_gates_bytes", "diff_bytes",
    ]);
    for (const key of ["candidate_and_gates_bytes", "diff_bytes"]) {
      if (!positiveInteger(manifest.review_reserve[key]) || manifest.review_reserve[key] > MAX_CONTEXT_BYTES) {
        issue(issues, `manifest.review_reserve.${key}`, `must be between 1 and ${MAX_CONTEXT_BYTES}`);
      }
    }
    if (
      positiveInteger(manifest.review_reserve.candidate_and_gates_bytes) &&
      positiveInteger(manifest.review_reserve.diff_bytes) &&
      positiveInteger(manifest.max_context_bytes) &&
      manifest.review_reserve.candidate_and_gates_bytes + manifest.review_reserve.diff_bytes >= manifest.max_context_bytes
    ) {
      issue(issues, "manifest.review_reserve", "must leave packet space for the safety header, task contract, spec, and review context");
    }
  }
  if (!object(manifest.bundles)) {
    issue(issues, "manifest.bundles", "must be an object");
  } else {
    for (const [name, refs] of Object.entries(manifest.bundles)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) issue(issues, `manifest.bundles.${name}`, "invalid bundle name");
      if (!stringArray(refs) || refs.length === 0) issue(issues, `manifest.bundles.${name}`, "must be a non-empty path array");
      if (stringArray(refs)) {
        if (refs.length > CONTRACT_ARRAY_CAP) issue(issues, `manifest.bundles.${name}`, `exceeds ${CONTRACT_ARRAY_CAP} entries`);
        if (new Set(refs).size !== refs.length) issue(issues, `manifest.bundles.${name}`, "must not contain duplicate paths");
        for (const [index, reference] of refs.entries()) {
          try {
            validateContextReferenceSyntax(reference);
          } catch (error) {
            issue(issues, `manifest.bundles.${name}.${index}`, error.message);
          }
        }
      }
    }
  }
  return issues;
}

export function validateGates(gates, credentials) {
  const issues = [];
  if (!object(gates)) {
    issue(issues, "gates", "must be an object with schema_version 2");
    return issues;
  }
  rejectUnknownKeys(issues, "gates", gates, ["schema_version", "gates", "final_gates"]);
  if (gates.schema_version !== 2) issue(issues, "gates", "schema_version must be 2");
  if (!object(gates.gates)) {
    issue(issues, "gates.gates", "must be an object");
    return issues;
  }
  for (const [id, gate] of Object.entries(gates.gates)) {
    const location = `gates.gates.${id}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) issue(issues, location, "invalid gate ID");
    if (id === "opencode") issue(issues, location, "opencode is reserved for phase credential profiles and is not a runnable gate");
    if (!object(gate)) {
      issue(issues, location, "must be an object");
      continue;
    }
    rejectUnknownKeys(issues, location, gate, [
      "argv", "timeout_seconds", "credential_profile", "success_codes", "max_output_bytes", "feedback",
    ]);
    if (!stringArray(gate.argv) || gate.argv.length === 0 || gate.argv.some((part) => !part || /[\r\n\0]/.test(part))) {
      issue(issues, `${location}.argv`, "must be fixed, non-empty argv strings");
    } else if (
      gate.argv.length > 64 ||
      gate.argv.some((part) => utf8Bytes(part) > 2048) ||
      utf8Bytes(JSON.stringify(gate.argv)) > 16 * 1024
    ) {
      issue(issues, `${location}.argv`, "exceeds the 64-argument, 2048-byte-per-argument, or 16384-byte total cap");
    }
    if (!positiveInteger(gate.timeout_seconds) || gate.timeout_seconds > 3600) issue(issues, `${location}.timeout_seconds`, "must be between 1 and 3600 seconds");
    if (!Array.isArray(gate.success_codes) || gate.success_codes.length === 0 || gate.success_codes.some((code) => !Number.isInteger(code))) {
      issue(issues, `${location}.success_codes`, "must be a non-empty integer array");
    }
    if (!positiveInteger(gate.max_output_bytes) || gate.max_output_bytes > 1024 * 1024) issue(issues, `${location}.max_output_bytes`, "must be between 1 and 1048576 bytes");
    if (typeof gate.feedback !== "boolean") issue(issues, `${location}.feedback`, "must be a boolean");
    if (gate.feedback === true && gate.credential_profile != null) {
      issue(issues, `${location}.feedback`, "credentialed gates cannot be exposed for same-session feedback");
    }
    if (gate.credential_profile !== null && gate.credential_profile !== undefined) {
      if (typeof gate.credential_profile !== "string" || !credentials?.profiles?.[gate.credential_profile]) {
        issue(issues, `${location}.credential_profile`, "references an unknown profile");
      } else {
        const profile = credentials.profiles[gate.credential_profile];
        if (Array.isArray(profile.allowed_gates) && !profile.allowed_gates.includes(id)) {
          issue(issues, `${location}.credential_profile`, `profile ${gate.credential_profile} does not allow gate ${id}`);
        }
      }
    }
  }
  const finalGates = stringArray(gates.final_gates) ? gates.final_gates : [];
  if (!stringArray(gates.final_gates)) issue(issues, "gates.final_gates", "must be a string array");
  if (finalGates.length > 32) issue(issues, "gates.final_gates", "exceeds 32 gates");
  for (const id of finalGates) {
    if (!gates.gates[id]) issue(issues, "gates.final_gates", `unknown gate ${id}`);
  }
  for (const [profileName, profile] of Object.entries(credentials?.profiles ?? {})) {
    for (const allowed of Array.isArray(profile?.allowed_gates) ? profile.allowed_gates : []) {
      if (allowed !== "opencode" && !gates.gates[allowed]) {
        issue(issues, `credentials.profiles.${profileName}.allowed_gates`, `unknown gate ${allowed}`);
      }
    }
  }
  return issues;
}

export function validateCredentials(credentials) {
  const issues = [];
  if (!object(credentials)) {
    issue(issues, "credentials", "must be an object with schema_version 1");
    return issues;
  }
  if (credentials.schema_version !== 1) issue(issues, "credentials", "schema_version must be 1");
  if (!object(credentials.profiles)) {
    issue(issues, "credentials.profiles", "must be an object");
    return issues;
  }
  if (Object.keys(credentials.profiles).length > 64) {
    issue(issues, "credentials.profiles", "must contain at most 64 profiles");
  }
  const foldedProfiles = new Set();
  for (const [name, profile] of Object.entries(credentials.profiles)) {
    const location = `credentials.profiles.${name}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      issue(issues, location, "profile name is not a safe identifier");
    }
    const foldedProfile = name.toLowerCase();
    if (foldedProfiles.has(foldedProfile)) {
      issue(issues, "credentials.profiles", `contains case-insensitive duplicate profile ${name}`);
    }
    foldedProfiles.add(foldedProfile);
    if (!object(profile)) {
      issue(issues, location, "must be an object");
      continue;
    }
    if (
      typeof profile.env_file !== "string" ||
      normalizeRelative(profile.env_file) !== profile.env_file ||
      !/^\.env[A-Za-z0-9._-]*\.local$/.test(profile.env_file)
    ) {
      issue(issues, `${location}.env_file`, "must be a root-local ignored .env*.local path");
    }
    if (!stringArray(profile.allow) || profile.allow.length === 0) {
      issue(issues, `${location}.allow`, "must explicitly allow environment names");
    } else {
      const seen = new Set();
      for (const variable of profile.allow) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) issue(issues, `${location}.allow`, `${variable} is not an exact environment variable name`);
        if (isForbiddenCredentialVariable(variable)) issue(issues, `${location}.allow`, `${variable} can alter process execution and cannot be injected`);
        const folded = variable.toUpperCase();
        if (seen.has(folded)) issue(issues, `${location}.allow`, `repeats ${variable} case-insensitively`);
        seen.add(folded);
      }
    }
    if (!stringArray(profile.allowed_gates) || profile.allowed_gates.length === 0) {
      issue(issues, `${location}.allowed_gates`, "must be a non-empty explicit gate-ID array");
    } else if (profile.allowed_gates.some((gate) => !gate.trim())) {
      issue(issues, `${location}.allowed_gates`, "contains an empty gate ID");
    } else if (new Set(profile.allowed_gates).size !== profile.allowed_gates.length) {
      issue(issues, `${location}.allowed_gates`, "must not contain duplicate gate IDs");
    }
    for (const key of Object.keys(profile)) {
      if (!["env_file", "allow", "allowed_gates"].includes(key)) issue(issues, location, `unexpected profile field ${key}; credential values and metadata do not belong here`);
    }
  }
  return issues;
}

export function validateState(state) {
  const issues = [];
  if (!object(state)) {
    issue(issues, "state", "must be an object with schema_version 1");
    return issues;
  }
  if (state.schema_version !== 1) issue(issues, "state", "schema_version must be 1");
  if (!Number.isInteger(state.revision) || state.revision < 0) issue(issues, "state.revision", "must be a non-negative integer");
  if (!RUN_STATUSES.has(state.status)) issue(issues, "state.status", "is invalid");
  if (!Number.isInteger(state.cycle) || state.cycle < 0) issue(issues, "state.cycle", "must be a non-negative integer");
  if (!Number.isInteger(state.completed_in_run) || state.completed_in_run < 0 || state.completed_in_run > 100) {
    issue(issues, "state.completed_in_run", "must be an integer between 0 and 100");
  }
  if (!Number.isInteger(state.attempt) || state.attempt < 0) issue(issues, "state.attempt", "must be a non-negative integer");
  if (!Number.isInteger(state.no_progress_count) || state.no_progress_count < 0 || state.no_progress_count > 20) {
    issue(issues, "state.no_progress_count", "must be an integer between 0 and 20");
  }
  const hasValidStartedAt = typeof state.started_at === "string" && Number.isFinite(Date.parse(state.started_at));
  if (state.started_at !== null && state.started_at !== undefined && !hasValidStartedAt) {
    issue(issues, "state.started_at", "must be null or a parseable timestamp");
  } else if ((state.status === "running" || state.run_id != null) && !hasValidStartedAt) {
    issue(issues, "state.started_at", "must be a parseable timestamp once a run exists");
  }
  if (state.session_ids !== undefined && (!stringArray(state.session_ids) || state.session_ids.length > 256)) {
    issue(issues, "state.session_ids", "must contain at most 256 prior session IDs");
  }
  if (stringArray(state.session_ids)) {
    if (new Set(state.session_ids).size !== state.session_ids.length) issue(issues, "state.session_ids", "must not contain duplicate session IDs");
    for (const id of state.session_ids) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) issue(issues, "state.session_ids", "contains an unsafe or oversized session ID");
    }
  }
  issues.push(...validateTaskToolUsage(state.task_tool_usage, {
    location: "state.task_tool_usage",
    taskId: state.active_task,
  }));
  if (state.active_task == null && object(state.task_tool_usage) && Object.keys(state.task_tool_usage).length > 0) {
    issue(issues, "state.task_tool_usage", "must be empty when no task is active");
  }
  if (
    state.last_failure_evidence !== null &&
    state.last_failure_evidence !== undefined &&
    (!object(state.last_failure_evidence) || utf8Bytes(JSON.stringify(state.last_failure_evidence)) > 16 * 1024)
  ) {
    issue(issues, "state.last_failure_evidence", "must be null or a bounded recovery-evidence object");
  }
  return issues;
}

export function validateTaskToolUsage(value, {
  location = "task_tool_usage",
  taskId = null,
} = {}) {
  const issues = [];
  if (!object(value)) {
    issue(issues, location, "must be an object keyed by phase:attempt");
    return issues;
  }
  const entries = Object.entries(value);
  if (entries.length > TASK_TOOL_USAGE_MAX_ENTRIES || utf8Bytes(JSON.stringify(value)) > TASK_TOOL_USAGE_MAX_BYTES) {
    issue(issues, location, `must contain at most ${TASK_TOOL_USAGE_MAX_ENTRIES} bounded phase-usage entries and ${TASK_TOOL_USAGE_MAX_BYTES} bytes`);
    return issues;
  }
  const allowedTools = new Set(["read", "list", "search", "write", "edit", "mutate", "check", "contract"]);
  const validCounter = (candidate, maximum) => Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum;
  const modelTokenFields = [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ];
  for (const [key, usage] of entries) {
    const match = /^(execute|repair|review):a([1-9]|1[0-9]|20)$/.exec(key);
    const itemLocation = `${location}.${key}`;
    if (!match) {
      issue(issues, itemLocation, "key must identify execute, repair, or review attempt 1-20");
      continue;
    }
    if (!object(usage)) {
      issue(issues, itemLocation, "contains invalid phase identity or aggregate counters");
      continue;
    }
    rejectUnknownKeys(issues, itemLocation, usage, [
      "schema_version", "phase", "task_id", "tool_calls", "returned_bytes", "by_tool", "model_usage",
    ]);
    if (
      usage.schema_version !== 1 || usage.phase !== match[1] ||
      (taskId !== null && usage.task_id !== taskId) ||
      !validCounter(usage.tool_calls, 10000) || !validCounter(usage.returned_bytes, 64 * 1024) ||
      !object(usage.by_tool) || Object.keys(usage.by_tool).length > 8
    ) {
      issue(issues, itemLocation, "contains invalid phase identity or aggregate counters");
      continue;
    }
    let calls = 0;
    let bytes = 0;
    for (const [toolName, counters] of Object.entries(usage.by_tool)) {
      if (object(counters)) rejectUnknownKeys(issues, `${itemLocation}.by_tool.${toolName}`, counters, ["calls", "returned_bytes"]);
      if (
        !allowedTools.has(toolName) || !object(counters) ||
        !validCounter(counters.calls, usage.tool_calls) ||
        !validCounter(counters.returned_bytes, usage.returned_bytes)
      ) {
        issue(issues, `${itemLocation}.by_tool.${toolName}`, "contains an invalid tool or counter");
        continue;
      }
      calls += counters.calls;
      bytes += counters.returned_bytes;
    }
    if (calls !== usage.tool_calls || bytes !== usage.returned_bytes) {
      issue(issues, itemLocation, "aggregate counters must equal the per-tool totals");
    }
    if (usage.model_usage !== undefined) {
      const modelUsageLocation = `${itemLocation}.model_usage`;
      if (!object(usage.model_usage)) {
        issue(issues, modelUsageLocation, "must be a bounded model-usage object");
      } else {
        rejectUnknownKeys(issues, modelUsageLocation, usage.model_usage, [...modelTokenFields, "cost"]);
        for (const field of modelTokenFields) {
          if (!Number.isSafeInteger(usage.model_usage[field]) || usage.model_usage[field] < 0) {
            issue(issues, `${modelUsageLocation}.${field}`, "must be a non-negative safe integer");
          }
        }
        if (
          typeof usage.model_usage.cost !== "number" ||
          !Number.isFinite(usage.model_usage.cost) ||
          usage.model_usage.cost < 0 ||
          usage.model_usage.cost > MAX_PHASE_MODEL_COST
        ) issue(issues, `${modelUsageLocation}.cost`, `must be a finite number between 0 and ${MAX_PHASE_MODEL_COST}`);
      }
    }
  }
  return issues;
}

export function validateModeIntentContract(value, {
  location = "mode_intent",
  taskId = null,
  attempt = null,
  requireIdentity = true,
} = {}) {
  const issues = [];
  if (!object(value)) {
    issue(issues, location, "must be a schema_version 1 object");
    return issues;
  }
  rejectUnknownKeys(issues, location, value, ["schema_version", "task_id", "attempt", "intents"]);
  if (value.schema_version !== 1) issue(issues, `${location}.schema_version`, "must be 1");
  if (requireIdentity) {
    if (typeof value.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.task_id)) {
      issue(issues, `${location}.task_id`, "must be a safe task ID");
    }
    if (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 20) {
      issue(issues, `${location}.attempt`, "must be between 1 and 20");
    }
    if (taskId !== null && value.task_id !== taskId) issue(issues, `${location}.task_id`, `must equal ${taskId}`);
    if (attempt !== null && value.attempt !== attempt) issue(issues, `${location}.attempt`, `must equal ${attempt}`);
  }
  if (!Array.isArray(value.intents) || value.intents.length > 64) {
    issue(issues, `${location}.intents`, "must contain at most 64 entries");
    return issues;
  }
  const seen = new Set();
  for (let index = 0; index < value.intents.length; index += 1) {
    const intent = value.intents[index];
    const itemLocation = `${location}.intents[${index}]`;
    if (!object(intent)) {
      issue(issues, itemLocation, "must contain path and executable");
      continue;
    }
    rejectUnknownKeys(issues, itemLocation, intent, ["path", "executable"]);
    try {
      const normalized = assertPortableRelative(intent.path, `${itemLocation}.path`);
      if (utf8Bytes(normalized) > 512) issue(issues, `${itemLocation}.path`, "exceeds 512 bytes");
      if (seen.has(normalized)) issue(issues, `${itemLocation}.path`, `repeats ${normalized}`);
      seen.add(normalized);
    } catch (error) {
      issue(issues, `${itemLocation}.path`, error.message);
    }
    if (typeof intent.executable !== "boolean") issue(issues, `${itemLocation}.executable`, "must be boolean");
  }
  return issues;
}

export function appendBoundedTaskToolUsage(value, key, usage) {
  const ledger = { ...(object(value) ? value : {}), [key]: usage };
  if (utf8Bytes(JSON.stringify(ledger)) <= TASK_TOOL_USAGE_MAX_BYTES) return ledger;

  const omissionOrder = [key, ...Object.keys(ledger).filter((candidate) => candidate !== key)];
  for (const entryKey of omissionOrder) {
    const entry = ledger[entryKey];
    if (!object(entry) || entry.model_usage === undefined) continue;
    const { model_usage: _omitted, ...mandatoryUsage } = entry;
    ledger[entryKey] = mandatoryUsage;
    if (utf8Bytes(JSON.stringify(ledger)) <= TASK_TOOL_USAGE_MAX_BYTES) break;
  }
  return ledger;
}

function createsCycle(entries) {
  const graph = new Map(entries.map(([id, task]) => [id, stringArray(task.depends_on) ? task.depends_on : []]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

export function universalTerminalTaskId(entries, finalGates) {
  if (!Array.isArray(entries) || entries.length === 0 || !stringArray(finalGates) || finalGates.length === 0) {
    return null;
  }
  const allTaskIds = new Set(entries.map(([id]) => id));
  const dependencies = new Map(entries.map(([id, task]) => [
    id,
    stringArray(task?.depends_on) ? task.depends_on : [],
  ]));
  for (const [id, task] of entries) {
    const taskGates = new Set(stringArray(task?.gates) ? task.gates : []);
    if (!finalGates.every((gate) => taskGates.has(gate))) continue;
    const covered = new Set([id]);
    const pending = [...(dependencies.get(id) ?? [])];
    while (pending.length > 0) {
      const dependency = pending.pop();
      if (!allTaskIds.has(dependency) || covered.has(dependency)) continue;
      covered.add(dependency);
      pending.push(...(dependencies.get(dependency) ?? []));
    }
    if (covered.size === allTaskIds.size) return id;
  }
  return null;
}

export function validateQueue(queue, manifest, gates, {
  strict = queue?.project_status !== "initializing",
  ephemeralRoots = [],
} = {}) {
  const issues = [];
  if (!object(queue)) {
    issue(issues, "queue", "must be an object with schema_version 2");
    return issues;
  }
  if (queue.schema_version !== 2) issue(issues, "queue", "schema_version must be 2");
  if (!Number.isInteger(queue.revision) || queue.revision < 0) issue(issues, "queue.revision", "must be a non-negative integer");
  if (!PROJECT_STATUSES.has(queue.project_status)) issue(issues, "queue.project_status", "is invalid");
  let entries = [];
  try {
    entries = taskEntries(queue);
  } catch (error) {
    issue(issues, "queue.tasks", error.message);
    return issues;
  }
  const ids = new Set(entries.map(([id]) => id));
  for (const [id, task] of entries) {
    const location = `queue.tasks.${id}`;
    rejectUnknownKeys(issues, location, task, [
      "id", "title", "status", "priority", "depends_on", "spec", "context",
      "allowed_paths", "gates", "tool_grants", "risk", "attempt_limit",
    ]);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) issue(issues, location, "invalid task ID");
    if (typeof task.title !== "string" || !task.title.trim()) issue(issues, `${location}.title`, "must be non-empty");
    if (!TASK_STATUSES.has(task.status)) issue(issues, `${location}.status`, "is invalid");
    if (!Number.isFinite(task.priority)) issue(issues, `${location}.priority`, "must be numeric");
    const dependencies = stringArray(task.depends_on) ? task.depends_on : [];
    if (!stringArray(task.depends_on)) issue(issues, `${location}.depends_on`, "must be a string array");
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) issue(issues, `${location}.depends_on`, `unknown task ${dependency}`);
      if (dependency === id) issue(issues, `${location}.depends_on`, "cannot depend on itself");
    }
    if (typeof task.spec !== "string" || !task.spec) issue(issues, `${location}.spec`, "must be a path");
    validateTaskContext(issues, `${location}.context`, task.context, manifest);
    if (!stringArray(task.allowed_paths) || (strict && task.allowed_paths.length === 0)) {
      issue(issues, `${location}.allowed_paths`, "must be a non-empty path/glob array");
    } else {
      for (const allowed of task.allowed_paths) {
        try {
          assertPortableRelative(allowed, `${location}.allowed_paths`, { allowGlob: true });
        } catch (error) {
          issue(issues, `${location}.allowed_paths`, error.message);
          continue;
        }
        if (["*", "**", "**/*", ".", "./**"].includes(allowed)) issue(issues, `${location}.allowed_paths`, `overly broad pattern ${allowed}`);
        for (const protectedPattern of PROTECTED_PATTERNS) {
          const protectedExample = protectedPattern.replace(/\*\*?.*$/, "sentinel");
          if (matchesGlob(protectedExample, allowed) || matchesGlob(normalizeRelative(allowed).replace(/\*\*?.*$/, "sentinel"), protectedPattern)) {
            issue(issues, `${location}.allowed_paths`, `${allowed} overlaps protected ${protectedPattern}`);
            break;
          }
        }
        if (Array.isArray(ephemeralRoots)) {
          const root = ephemeralRoots.find((candidate) => taskPatternOverlapsRoot(allowed, candidate));
          if (root) issue(issues, `${location}.allowed_paths`, `${allowed} overlaps ephemeral root ${root}`);
        }
      }
    }
    const taskGates = stringArray(task.gates) ? task.gates : [];
    if (!stringArray(task.gates) || (strict && taskGates.length === 0)) issue(issues, `${location}.gates`, "must be a non-empty deterministic gate array for executable tasks");
    if (taskGates.length > 32) issue(issues, `${location}.gates`, "exceeds 32 gates");
    for (const gate of taskGates) if (!gates?.gates?.[gate]) issue(issues, `${location}.gates`, `unknown gate ${gate}`);
    try {
      validateTaskToolGrants(task.tool_grants, `${location}.tool_grants`);
    } catch (error) {
      issue(issues, `${location}.tool_grants`, error.message);
    }
    if (!RISKS.has(task.risk)) issue(issues, `${location}.risk`, "must be low, medium, or high");
    if (!positiveInteger(task.attempt_limit)) issue(issues, `${location}.attempt_limit`, "must be a positive integer");
  }
  if (createsCycle(entries)) issue(issues, "queue.tasks", "dependency graph contains a cycle");
  const finalGates = stringArray(gates?.final_gates) ? gates.final_gates : [];
  if (strict && finalGates.length > 0 && !universalTerminalTaskId(entries, finalGates)) {
    issue(
      issues,
      "queue.tasks",
      "must include one terminal integration task whose gates contain every final gate and whose transitive dependencies cover every task",
      "TERMINAL_INTEGRATION_TASK_REQUIRED",
    );
  }
  return issues;
}

export function expandTaskReferences(task, manifest, stage) {
  if (!CONTEXT_PHASES.includes(stage)) {
    throw new AutopilotError(`Unknown context phase ${stage}`, { code: "INVALID_CONTEXT_PHASE" });
  }
  const references = [task.spec];
  if (!object(task.context)) {
    throw new AutopilotError("Task context must use the phase-aware shared/execute/repair/review object", {
      code: "INVALID_TASK_CONTEXT",
    });
  }
  for (const context of [...(task.context.shared ?? []), ...(task.context[stage] ?? [])]) {
    if (manifest.bundles?.[context]) references.push(...manifest.bundles[context]);
    else references.push(context);
  }
  return unique(references.map(normalizeRelative));
}

function validateTaskContext(issues, location, context, manifest) {
  if (!object(context)) {
    issue(issues, location, "must be an object with shared, execute, repair, and review arrays; legacy broad arrays are rejected");
    return;
  }
  rejectUnknownKeys(issues, location, context, TASK_CONTEXT_KEYS);
  for (const key of TASK_CONTEXT_KEYS) {
    const references = context[key];
    if (!stringArray(references)) {
      issue(issues, `${location}.${key}`, "must be a string array");
      continue;
    }
    if (references.length > CONTRACT_ARRAY_CAP) issue(issues, `${location}.${key}`, `exceeds ${CONTRACT_ARRAY_CAP} entries`);
    if (new Set(references).size !== references.length) issue(issues, `${location}.${key}`, "must not contain duplicate references");
    for (const [index, reference] of references.entries()) {
      if (manifest?.bundles?.[reference]) continue;
      try {
        validateContextReferenceSyntax(reference);
      } catch (error) {
        issue(issues, `${location}.${key}.${index}`, error.message);
      }
    }
  }
  if (stringArray(context.shared)) {
    const shared = new Set(context.shared);
    for (const phase of CONTEXT_PHASES) {
      if (!stringArray(context[phase])) continue;
      for (const reference of context[phase]) {
        if (shared.has(reference)) issue(issues, `${location}.${phase}`, `${reference} duplicates shared context`);
      }
    }
  }
}

function validateContextReferenceSyntax(reference) {
  const normalized = assertPortableRelative(reference, "context reference");
  const lower = normalized.toLowerCase();
  if (lower === ".project/receipts" || lower.startsWith(".project/receipts/")) {
    throw new AutopilotError(`Receipt content cannot enter a context pack: ${reference}`, {
      code: "RECEIPT_CONTEXT_DENIED",
    });
  }
  if (normalized.split("/").some((part) => part.toLowerCase() === "archive")) {
    throw new AutopilotError(`Archive content cannot enter a context pack: ${reference}`, {
      code: "ARCHIVE_REFERENCE",
    });
  }
  const parts = lower.split("/");
  const basename = parts.at(-1);
  if (
    [".git", ".autopilot", ".opencode", ".agents"].includes(parts[0]) ||
    parts.some((part) => part.startsWith(".env")) ||
    /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(basename)
  ) {
    throw new AutopilotError(`Sensitive/control content cannot enter a context pack: ${reference}`, {
      code: "SENSITIVE_CONTEXT_REFERENCE",
    });
  }
  return normalized;
}

export function validateReference(root, reference) {
  const normalized = validateContextReferenceSyntax(reference);
  return resolveInside(root, normalized, "context reference");
}

export function validateCandidate(candidate, taskId, attempt) {
  const issues = [];
  if (!object(candidate)) {
    issue(issues, "candidate", "must be an object");
    return issues;
  }
  rejectUnknownKeys(issues, "candidate", candidate, [
    "schema_version", "task_id", "attempt", "status", "summary",
    "changed_files", "environment_variables", "blocker",
  ]);
  if (utf8Bytes(JSON.stringify(candidate)) > CONTRACT_OBJECT_CAP) {
    issue(issues, "candidate", `serialized contract exceeds ${CONTRACT_OBJECT_CAP} UTF-8 bytes`);
  }
  if (candidate.schema_version !== 1) issue(issues, "candidate", "schema_version must be 1");
  if (candidate.task_id !== taskId) issue(issues, "candidate.task_id", `must equal ${taskId}`);
  if (candidate.attempt !== attempt) issue(issues, "candidate.attempt", `must equal ${attempt}`);
  if (!["complete", "blocked", "failed"].includes(candidate.status)) issue(issues, "candidate.status", "is invalid");
  boundedString(issues, "candidate.summary", candidate.summary, { maxBytes: CONTRACT_SUMMARY_CAP });
  if (!stringArray(candidate.changed_files)) {
    issue(issues, "candidate.changed_files", "must be a string array");
  } else {
    if (candidate.changed_files.length > CONTRACT_ARRAY_CAP) issue(issues, "candidate.changed_files", `exceeds ${CONTRACT_ARRAY_CAP} entries`);
    for (const [index, file] of candidate.changed_files.entries()) {
      boundedString(issues, `candidate.changed_files.${index}`, file, {
        maxBytes: CONTRACT_PATH_CAP,
      });
    }
  }
  if (!stringArray(candidate.environment_variables)) {
    issue(issues, "candidate.environment_variables", "must be a string array");
  } else {
    if (candidate.environment_variables.length > 64) issue(issues, "candidate.environment_variables", "exceeds 64 entries");
    for (const [index, name] of candidate.environment_variables.entries()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
        issue(issues, `candidate.environment_variables.${index}`, "must contain an exact environment-variable name only");
      }
    }
  }
  if (candidate.status === "blocked") {
    if (!object(candidate.blocker)) issue(issues, "candidate.blocker", "is required when blocked");
    rejectUnknownKeys(issues, "candidate.blocker", candidate.blocker, [
      "kind", "message", "required_action", "resume_condition",
    ]);
    boundedString(issues, "candidate.blocker.kind", candidate.blocker?.kind, { maxBytes: CONTRACT_BLOCKER_KIND_CAP });
    for (const key of ["message", "required_action", "resume_condition"]) {
      boundedString(issues, `candidate.blocker.${key}`, candidate.blocker?.[key], { maxBytes: CONTRACT_BLOCKER_CAP });
    }
  } else if (candidate.blocker !== null) {
    issue(issues, "candidate.blocker", "must be null unless blocked");
  }
  return issues;
}

export function validateReview(review, taskId) {
  const issues = [];
  if (!object(review)) {
    issue(issues, "review", "must be an object");
    return issues;
  }
  rejectUnknownKeys(issues, "review", review, [
    "schema_version", "task_id", "status", "summary", "findings",
  ]);
  if (utf8Bytes(JSON.stringify(review)) > CONTRACT_OBJECT_CAP) {
    issue(issues, "review", `serialized contract exceeds ${CONTRACT_OBJECT_CAP} UTF-8 bytes`);
  }
  if (review.schema_version !== 1) issue(issues, "review", "schema_version must be 1");
  if (review.task_id !== taskId) issue(issues, "review.task_id", `must equal ${taskId}`);
  if (!["approved", "changes_requested", "blocked"].includes(review.status)) issue(issues, "review.status", "is invalid");
  boundedString(issues, "review.summary", review.summary, { maxBytes: CONTRACT_SUMMARY_CAP });
  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (!Array.isArray(review.findings)) issue(issues, "review.findings", "must be an array");
  if (findings.length > CONTRACT_FINDINGS_CAP) issue(issues, "review.findings", `exceeds ${CONTRACT_FINDINGS_CAP} entries`);
  for (const [index, finding] of findings.entries()) {
    if (!object(finding) || !["low", "medium", "high", "critical"].includes(finding.severity)) issue(issues, `review.findings.${index}.severity`, "is invalid");
    rejectUnknownKeys(issues, `review.findings.${index}`, finding, ["severity", "file", "message"]);
    boundedString(issues, `review.findings.${index}.file`, finding?.file, {
      maxBytes: CONTRACT_PATH_CAP,
    });
    boundedString(issues, `review.findings.${index}.message`, finding?.message, {
      maxBytes: CONTRACT_FINDING_CAP,
    });
  }
  if (
    review.status === "approved" &&
    findings.some((finding) => ["medium", "high", "critical"].includes(finding?.severity))
  ) {
    issue(issues, "review.status", "cannot approve while medium, high, or critical findings remain");
  }
  return issues;
}

export function assertNoIssues(issues, label = "Contract validation") {
  if (issues.length > 0) {
    throw new AutopilotError(
      `${label} failed:\n${issues.map((item) => `- ${item.location}: ${item.message}`).join("\n")}`,
      {
        code: issues.some((item) => item.code === "CONTRACT_SECRET")
          ? "CONTRACT_SECRET"
          : "CONTRACT_INVALID",
        details: issues,
      },
    );
  }
}

export { CONTEXT_PHASES, PROTECTED_PATTERNS, TASK_CONTEXT_KEYS };
