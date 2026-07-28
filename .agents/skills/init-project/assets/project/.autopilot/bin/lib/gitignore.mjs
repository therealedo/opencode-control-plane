export const BASE_GITIGNORE_BEGIN = "# BEGIN OPENCODE CONTROL PLANE BASE IGNORES";
export const BASE_GITIGNORE_END = "# END OPENCODE CONTROL PLANE BASE IGNORES";

const PRE_V170_BASE_GITIGNORE_FRAGMENT = [
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

const V170_UNMARKED_BASE_GITIGNORE_FRAGMENT = [
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
  ".autopilot/MANUAL_MODE",
  ".autopilot/runtime/",
  ".autopilot/artifacts/",
  ".autopilot/evolution/",
  ".autopilot/init/",
  ".agents/",
  ".opencode-control-plane/",
].join("\n") + "\n";

export const BASE_GITIGNORE_FRAGMENT = [
  BASE_GITIGNORE_BEGIN,
  V170_UNMARKED_BASE_GITIGNORE_FRAGMENT.trimEnd(),
  BASE_GITIGNORE_END,
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
  ".autopilot/MANUAL_MODE",
  ".autopilot/runtime/ignore-policy-probe.json",
  ".autopilot/artifacts/ignore-policy-probe.json",
  ".autopilot/evolution/ignore-policy-probe.json",
  ".autopilot/init/ignore-policy-probe.json",
  ".agents/skills/init-project/SKILL.md",
  ".opencode-control-plane/install.json",
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

export function upgradeBaseGitignoreFragment(value) {
  const text = String(value ?? "");
  if (canonicalBaseGitignoreIsLast(text)) return text;
  const withoutCrlf = text.replace(/\r\n/g, "");
  if (withoutCrlf.includes("\r") || (text.includes("\r\n") && withoutCrlf.includes("\n"))) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimEnd();
  let start = markedFragmentStart(trimmed);
  if (start === null) {
    for (const legacy of [V170_UNMARKED_BASE_GITIGNORE_FRAGMENT, PRE_V170_BASE_GITIGNORE_FRAGMENT]) {
      const candidate = legacy.trimEnd();
      if (!trimmed.endsWith(candidate)) continue;
      const candidateStart = trimmed.length - candidate.length;
      if (candidateStart !== 0 && trimmed[candidateStart - 1] !== "\n") continue;
      start = candidateStart;
      break;
    }
  }
  if (start === null) return null;
  const migrated = `${trimmed.slice(0, start)}${BASE_GITIGNORE_FRAGMENT}`;
  return eol === "\r\n" ? migrated.replace(/\n/g, "\r\n") : migrated;
}

function markedFragmentStart(value) {
  const start = value.indexOf(BASE_GITIGNORE_BEGIN);
  const end = value.indexOf(BASE_GITIGNORE_END);
  if (
    start < 0 || end < start ||
    value.indexOf(BASE_GITIGNORE_BEGIN, start + BASE_GITIGNORE_BEGIN.length) >= 0 ||
    value.indexOf(BASE_GITIGNORE_END, end + BASE_GITIGNORE_END.length) >= 0 ||
    end + BASE_GITIGNORE_END.length !== value.length ||
    (start !== 0 && value[start - 1] !== "\n")
  ) return null;
  return start;
}
