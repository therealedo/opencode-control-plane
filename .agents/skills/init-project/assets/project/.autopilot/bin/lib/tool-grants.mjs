export const PHASE_ROLE = Object.freeze({
  execute: "worker",
  repair: "recovery",
  review: "reviewer",
});
export const PHASES = Object.freeze(Object.keys(PHASE_ROLE));
export const ROLE_FILES = Object.freeze({
  worker: ".opencode/agents/autopilot-worker.md",
  recovery: ".opencode/agents/autopilot-recovery.md",
  reviewer: ".opencode/agents/autopilot-reviewer.md",
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_FILES));
export const BEGIN_GRANTS = "  # BEGIN AUTOPILOT MANAGED TOOL GRANTS";
export const END_GRANTS = "  # END AUTOPILOT MANAGED TOOL GRANTS";

const EXACT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MAX_TOOLS_PER_SCOPE = 64;
const CONTROL_BUILTINS = new Set([
  "apply_patch", "bash", "batch", "doom_loop", "edit", "external_directory",
  "glob", "grep", "list", "lsp", "patch", "question", "read", "skill",
  "task", "todoread", "todowrite", "webfetch", "websearch", "write",
]);

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactObject(value, expectedKeys, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  const expected = [...expectedKeys].sort(compareText);
  const actual = Object.keys(value).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

export function validateGrantList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_TOOLS_PER_SCOPE) {
    throw new Error(`${label} exceeds ${MAX_TOOLS_PER_SCOPE} exact grants`);
  }
  const seen = new Set();
  for (const identifier of value) {
    if (typeof identifier !== "string" || !EXACT_IDENTIFIER.test(identifier)) {
      throw new Error(`${label} contains unsafe or non-exact identifier ${JSON.stringify(identifier)}`);
    }
    if (CONTROL_BUILTINS.has(identifier.toLowerCase()) || identifier.toLowerCase().startsWith("autopilot_")) {
      throw new Error(`${label} cannot grant built-in/control tool ${identifier}`);
    }
    if (seen.has(identifier)) throw new Error(`${label} repeats ${identifier}`);
    seen.add(identifier);
  }
  return [...seen].sort(compareText);
}

export function validateRoleToolPolicy(value) {
  assertExactObject(value, ["schema_version", "roles"], ".project/tools.json");
  if (value.schema_version !== 1) throw new Error(".project/tools.json schema_version must be 1");
  assertExactObject(value.roles, ROLE_NAMES, ".project/tools.json roles");
  return {
    schema_version: 1,
    roles: Object.fromEntries(ROLE_NAMES.map((role) => [
      role,
      validateGrantList(value.roles[role], `.project/tools.json roles.${role}`),
    ])),
  };
}

export function validateTaskToolGrants(value, label = "task.tool_grants") {
  assertExactObject(value, PHASES, label);
  return Object.fromEntries(PHASES.map((phase) => [
    phase,
    validateGrantList(value[phase], `${label}.${phase}`),
  ]));
}

function collectEnvReferences(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) output.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, output);
  } else if (object(value)) {
    for (const item of Object.values(value)) collectEnvReferences(item, output);
  }
  return output;
}

function serverForGrant(grant, mcp) {
  const matches = Object.keys(mcp).filter((name) => grant === name || grant.startsWith(`${name}_`));
  if (matches.length !== 1) {
    throw new Error(`MCP tool grant ${grant} must map to exactly one configured MCP server`);
  }
  return matches[0];
}

export function resolveTaskPhaseCapabilities({ toolPolicy, task, phase, mcp }) {
  const role = PHASE_ROLE[phase];
  if (!role) throw new Error(`Unknown tool-grant phase ${phase}`);
  const policy = validateRoleToolPolicy(toolPolicy);
  const taskGrants = validateTaskToolGrants(task?.tool_grants, "task.tool_grants");
  if (!object(mcp)) throw new Error("OpenCode mcp configuration must be an object");

  const ceiling = new Set(policy.roles[role]);
  for (const grant of taskGrants[phase]) {
    if (!ceiling.has(grant)) {
      throw new Error(`Task ${phase} grant ${grant} exceeds the ${role} role ceiling`);
    }
  }
  const grants = policy.roles[role].filter((grant) => taskGrants[phase].includes(grant));
  const serverNames = new Set();
  for (const grant of grants) {
    const serverName = serverForGrant(grant, mcp);
    if (mcp[serverName]?.enabled === false) {
      throw new Error(`Task ${phase} grant ${grant} selects disabled MCP server ${serverName}`);
    }
    serverNames.add(serverName);
  }
  const selectedServers = [...serverNames].sort(compareText);
  const credentialNames = new Set();
  for (const name of selectedServers) collectEnvReferences(mcp[name], credentialNames);
  return {
    phase,
    role,
    grants,
    server_names: selectedServers,
    credential_names: [...credentialNames].sort(compareText),
  };
}

export function renderManagedToolBlock(content, identifiers, role) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const beginIndexes = indexesOf(lines, BEGIN_GRANTS);
  const endIndexes = indexesOf(lines, END_GRANTS);
  if (beginIndexes.length !== 1 || endIndexes.length !== 1) {
    throw new Error(`agent ${role} must contain exactly one managed tool marker pair`);
  }
  const begin = beginIndexes[0];
  const end = endIndexes[0];
  if (end <= begin) throw new Error(`agent ${role} has reversed managed tool markers`);
  if (begin === 0 || lines[begin - 1] !== '  "*": deny') {
    throw new Error(`agent ${role} managed tool block must follow the catch-all deny directly`);
  }
  const grants = validateGrantList(identifiers, `agent ${role} grants`);
  return [
    ...lines.slice(0, begin),
    BEGIN_GRANTS,
    ...grants.map((identifier) => `  "${identifier}": allow`),
    END_GRANTS,
    ...lines.slice(end + 1),
  ].join(newline);
}

function indexesOf(lines, value) {
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === value) output.push(index);
  }
  return output;
}
