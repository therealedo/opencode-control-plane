import path from "node:path";
import { secretIndicators } from "./secrets.mjs";

const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "APPDATA", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
  "NODE_OPTIONS", "NODE_PATH", "PATH", "PATHEXT", "PYTHONHOME", "PYTHONPATH",
  "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS", "RUBYOPT", "BUNDLE_GEMFILE",
  "BASH_ENV", "ENV", "CDPATH", "GLOBIGNORE", "SHELLOPTS", "PS4", "PROMPT_COMMAND",
  "PERL5OPT", "PERL5LIB", "RUBYLIB", "GEM_HOME", "GEM_PATH",
  "PYTHONINSPECT", "PYTHONSTARTUP", "SSLKEYLOGFILE", "SSH_AUTH_SOCK",
]);
const FORBIDDEN_ENVIRONMENT_PREFIXES = [
  "DYLD_", "GIT_", "NPM_CONFIG_", "YARN_", "PNPM_", "BUN_",
  "AUTOPILOT_", "OPENCODE_", "XDG_",
];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;
const MAX_SERVERS = 32;
const MAX_FIELDS = 64;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 2048;
const MAX_ARGUMENTS_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const SENSITIVE_HEADER_NAME = /(?:^|[-_])(?:authorization|auth|authentication|api[-_]?key|token|secret|password|credential|cookie|set[-_]?cookie|session)(?:$|[-_])/i;
export const PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES = 8 * 1024;
export const PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES = 16 * 1024;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerEnvironmentError(message, code) {
  return Object.assign(new Error(message), { code });
}

function exactObject(value, required, optional, location) {
  if (!object(value)) throw new Error(`${location} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${location}.${key} is required`);
  }
}

function text(value, location) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) throw new Error(`${location} exceeds ${MAX_TEXT_BYTES} bytes`);
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error(`${location} must be one safe line`);
  if (/\{file:/i.test(value)) throw new Error(`${location} cannot contain an incoming {file:...} reference`);
  if (secretIndicators(value).length > 0) throw new Error(`${location} contains a possible secret value`);
  return value.trim();
}

function boolean(value, location) {
  if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
  return value;
}

function positiveInteger(value, maximum, location) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${location} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function environmentName(value, location) {
  const result = text(value, location);
  if (!ENVIRONMENT_NAME.test(result)) throw new Error(`${location} is not an exact environment-variable name`);
  if (isForbiddenCredentialVariable(result)) throw new Error(`${location} can alter process execution and is forbidden`);
  return result;
}

function environmentReferences(value, location, { exact = false } = {}) {
  const result = text(value, location);
  if (exact) {
    const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(result);
    if (!match) throw new Error(`${location} must use an exact {env:NAME} substitution`);
    environmentName(match[1], location);
    return { value: result, names: [match[1]] };
  }
  const names = [];
  for (const match of result.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    environmentName(match[1], location);
    names.push(match[1]);
  }
  if (result.replace(/\{env:[A-Za-z_][A-Za-z0-9_]*\}/g, "").includes("{env:")) {
    throw new Error(`${location} contains an invalid environment substitution`);
  }
  return { value: result, names };
}

function canonicalEnvironment(value, location, providerNames) {
  if (!object(value)) throw new Error(`${location} must be an object`);
  if (Object.keys(value).length > MAX_FIELDS) throw new Error(`${location} exceeds ${MAX_FIELDS} variables`);
  const output = {};
  const folded = new Set();
  for (const [name, substitution] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    environmentName(name, `${location}.${name}`);
    const upper = name.toUpperCase();
    if (folded.has(upper)) throw new Error(`${location} contains case-insensitive duplicate variable names`);
    if (providerNames.has(upper)) throw new Error(`${location}.${name} cannot override a provider environment variable`);
    folded.add(upper);
    output[name] = environmentReferences(substitution, `${location}.${name}`, { exact: true }).value;
  }
  return output;
}

function canonicalHeaders(value, location) {
  if (!object(value)) throw new Error(`${location} must be an object`);
  if (Object.keys(value).length > MAX_FIELDS) throw new Error(`${location} exceeds ${MAX_FIELDS} headers`);
  const output = {};
  const folded = new Set();
  for (const [name, substitution] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    if (!HEADER_NAME.test(name)) throw new Error(`${location}.${name} is not a safe header name`);
    const lower = name.toLowerCase();
    if (folded.has(lower)) throw new Error(`${location} contains case-insensitive duplicate header names`);
    folded.add(lower);
    const rendered = environmentReferences(substitution, `${location}.${name}`);
    if (SENSITIVE_HEADER_NAME.test(name) && rendered.names.length === 0) {
      throw new Error(`${location}.${name} must contain an {env:NAME} substitution`);
    }
    output[name] = rendered.value;
  }
  return output;
}

function canonicalUrl(value, location) {
  const result = text(value, location);
  if (/[{}]/.test(result) || /\{env:/i.test(result)) {
    throw new Error(`${location} cannot carry credentials or substitutions in a URL`);
  }
  let parsed;
  try { parsed = new URL(result); }
  catch { throw new Error(`${location} must be a valid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${location} must be an HTTP(S) URL without embedded credentials`);
  }
  for (const name of parsed.searchParams.keys()) {
    if (/(?:authorization|api[-_]?key|token|secret|password)/i.test(name)) {
      throw new Error(`${location} cannot carry credentials in URL query parameters`);
    }
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error(`${location} must use HTTPS except for an explicit loopback host`);
  }
  return result;
}

function canonicalOauth(value, location) {
  if (value === false) return false;
  if (value === true) throw new Error(`${location} may be an object or false, not true`);
  exactObject(value, [], ["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"], location);
  const output = {};
  if (value.clientId !== undefined) output.clientId = text(value.clientId, `${location}.clientId`);
  if (value.clientSecret !== undefined) {
    output.clientSecret = environmentReferences(value.clientSecret, `${location}.clientSecret`, { exact: true }).value;
  }
  if (value.scope !== undefined) output.scope = text(value.scope, `${location}.scope`);
  if (value.callbackPort !== undefined) {
    output.callbackPort = positiveInteger(value.callbackPort, 65535, `${location}.callbackPort`);
  }
  if (value.redirectUri !== undefined) output.redirectUri = canonicalUrl(value.redirectUri, `${location}.redirectUri`);
  return output;
}

function canonicalCommand(value, location) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGUMENTS) {
    throw new Error(`${location} must contain between 1 and ${MAX_ARGUMENTS} fixed arguments`);
  }
  const command = value.map((argument, index) => {
    const result = text(argument, `${location}[${index}]`);
    if (Buffer.byteLength(result, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new Error(`${location}[${index}] exceeds ${MAX_ARGUMENT_BYTES} bytes`);
    }
    if (/\{env:/i.test(result)) throw new Error(`${location}[${index}] cannot transport credentials in argv`);
    const candidate = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/.exec(result)?.[1] ?? result;
    const absolute = path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
    const packageSpecifier = /^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[^/\\]+)?$/.test(candidate);
    if (candidate === "{project}") {
      throw new Error(`${location}[${index}] cannot expose the project as an executable argument`);
    }
    if (index === 0 && /[\\/]/.test(candidate) && !absolute) {
      throw new Error(`${location}[${index}] cannot be a project-relative executable path`);
    }
    if (
      index > 0 && !absolute && !packageSpecifier &&
      (candidate === "." || candidate === ".." || /^(?:\.\.?[\\/])/.test(candidate) ||
        /^[A-Za-z0-9._ -]+(?:[\\/][A-Za-z0-9._ -]+)+$/.test(candidate) ||
        /\.(?:[cm]?js|jsx|tsx?|py|rb|php|pl|sh|bash|zsh|fish|ps1|cmd|bat|exe|com)$/i.test(candidate))
    ) {
      throw new Error(`${location}[${index}] cannot launch or load a project-relative path`);
    }
    return result;
  });
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > MAX_ARGUMENTS_BYTES) {
    throw new Error(`${location} exceeds ${MAX_ARGUMENTS_BYTES} serialized bytes`);
  }
  return command;
}

export function isForbiddenCredentialVariable(name) {
  const normalized = String(name).toUpperCase();
  return FORBIDDEN_ENVIRONMENT_NAMES.has(normalized) ||
    FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function boundedProviderEnvironment(names, source = process.env) {
  const output = {};
  let totalBytes = 1;
  for (const name of names ?? []) {
    const value = source[name];
    if (typeof value !== "string" || !value) {
      throw providerEnvironmentError(
        `Required OpenCode provider environment variable ${name} is missing`,
        "CREDENTIAL_FILE_MISSING",
      );
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES) {
      throw providerEnvironmentError(
        `OpenCode provider environment variable ${name} exceeds ${PROVIDER_ENVIRONMENT_VALUE_MAX_BYTES} UTF-8 bytes`,
        "CREDENTIAL_VALUE_TOO_LARGE",
      );
    }
    totalBytes += Buffer.byteLength(name, "utf8") + 1 + valueBytes + 1;
    if (totalBytes > PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES) {
      throw providerEnvironmentError(
        `OpenCode provider environment exceeds the ${PROVIDER_ENVIRONMENT_TOTAL_MAX_BYTES}-byte aggregate limit`,
        "CREDENTIAL_VALUE_TOO_LARGE",
      );
    }
    output[name] = value;
  }
  return output;
}

export function collectMcpEnvironmentReferences(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) output.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMcpEnvironmentReferences(item, output);
  } else if (object(value)) {
    for (const item of Object.values(value)) collectMcpEnvironmentReferences(item, output);
  }
  return output;
}

export function validateMcpDescriptors(value, {
  location = "opencode.jsonc.mcp",
  providerEnvironment = [],
} = {}) {
  if (!object(value)) throw new Error(`${location} must be an object`);
  if (Object.keys(value).length > MAX_SERVERS) throw new Error(`${location} exceeds ${MAX_SERVERS} servers`);
  const providerNames = new Set(providerEnvironment.map((name) => String(name).toUpperCase()));
  const servers = {};
  const foldedNames = new Set();
  for (const [name, server] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    if (!SERVER_NAME.test(name)) throw new Error(`${location}.${name} must be a tool-prefix-safe server name`);
    const foldedName = name.toLowerCase();
    if (foldedNames.has(foldedName)) throw new Error(`${location} contains case-insensitive duplicate names`);
    foldedNames.add(foldedName);
    if (!object(server)) throw new Error(`${location}.${name} must be an object`);
    const serverLocation = `${location}.${name}`;
    if (server.type === "local") {
      exactObject(server, ["type", "command"], ["environment", "enabled", "timeout", "project_root_argument"], serverLocation);
      const environment = canonicalEnvironment(server.environment ?? {}, `${serverLocation}.environment`, providerNames);
      servers[name] = {
        type: "local",
        command: canonicalCommand(server.command, `${serverLocation}.command`),
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        ...(server.enabled === undefined ? {} : { enabled: boolean(server.enabled, `${serverLocation}.enabled`) }),
        ...(server.timeout === undefined ? {} : { timeout: positiveInteger(server.timeout, 3_600_000, `${serverLocation}.timeout`) }),
        ...(server.project_root_argument === undefined
          ? {}
          : { project_root_argument: boolean(server.project_root_argument, `${serverLocation}.project_root_argument`) }),
      };
    } else if (server.type === "remote") {
      exactObject(server, ["type", "url"], ["headers", "oauth", "enabled", "timeout"], serverLocation);
      const headers = canonicalHeaders(server.headers ?? {}, `${serverLocation}.headers`);
      servers[name] = {
        type: "remote",
        url: canonicalUrl(server.url, `${serverLocation}.url`),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(server.oauth === undefined ? {} : { oauth: canonicalOauth(server.oauth, `${serverLocation}.oauth`) }),
        ...(server.enabled === undefined ? {} : { enabled: boolean(server.enabled, `${serverLocation}.enabled`) }),
        ...(server.timeout === undefined ? {} : { timeout: positiveInteger(server.timeout, 3_600_000, `${serverLocation}.timeout`) }),
      };
    } else {
      throw new Error(`${serverLocation}.type must be local or remote`);
    }
  }
  const names = Object.keys(servers);
  for (const [index, left] of names.entries()) {
    for (const right of names.slice(index + 1)) {
      const a = left.toLowerCase();
      const b = right.toLowerCase();
      if (a.startsWith(`${b}_`) || b.startsWith(`${a}_`)) {
        throw new Error(`${location} names ${left} and ${right} create ambiguous tool prefixes`);
      }
    }
  }
  return servers;
}
