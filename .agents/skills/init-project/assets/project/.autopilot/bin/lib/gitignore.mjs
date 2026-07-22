export const BASE_GITIGNORE_FRAGMENT = [
  "# opencode-autopilot",
  "# Local controller state, artifacts, and test credentials.",
  ".env",
  ".env.*",
  "!.env.example",
  ".env*.local",
  "",
  ".autopilot/credentials.json",
  ".autopilot/state.json",
  ".autopilot/checkpoint.md",
  ".autopilot/blocker.md",
  ".autopilot/STOP",
  ".autopilot/PAUSED",
  ".autopilot/MAINTENANCE",
  ".autopilot/runtime/",
  ".autopilot/artifacts/",
  ".autopilot/evolution/",
  ".autopilot/init/",
].join("\n") + "\n";

export const REQUIRED_IGNORED_PATHS = Object.freeze([
  ".env",
  ".env.test.local",
  ".autopilot/credentials.json",
  ".autopilot/state.json",
  ".autopilot/checkpoint.md",
  ".autopilot/blocker.md",
  ".autopilot/STOP",
  ".autopilot/PAUSED",
  ".autopilot/MAINTENANCE",
  ".autopilot/runtime/ignore-policy-probe.json",
  ".autopilot/artifacts/ignore-policy-probe.json",
  ".autopilot/evolution/ignore-policy-probe.json",
  ".autopilot/init/ignore-policy-probe.json",
]);

export const REQUIRED_VISIBLE_PATHS = Object.freeze([
  ".env.example",
  ".autopilot/config.json",
  ".autopilot/control-plane.json",
  ".autopilot/credentials.example.json",
]);

function normalizedLines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").split("\n");
}

export function hasCanonicalBaseGitignore(value) {
  const lines = normalizedLines(value);
  const required = normalizedLines(BASE_GITIGNORE_FRAGMENT).slice(0, -1);
  for (let index = 0; index <= lines.length - required.length; index += 1) {
    if (required.every((line, offset) => lines[index + offset] === line)) return true;
  }
  return false;
}

export function canonicalBaseGitignoreIsLast(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
  const required = BASE_GITIGNORE_FRAGMENT.trimEnd();
  if (!normalized.endsWith(required)) return false;
  const start = normalized.length - required.length;
  return start === 0 || normalized[start - 1] === "\n";
}
