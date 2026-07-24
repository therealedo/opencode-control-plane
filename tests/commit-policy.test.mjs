import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/commit-policy.mjs";

test("all supported Conventional Commit types and optional scopes produce exact subjects", () => {
  for (const type of policy.CONVENTIONAL_COMMIT_TYPES) {
    const git = { commit_prefixes: { M001: type } };
    assert.equal(
      policy.taskCommitMessage(git, { id: "M001", title: "Deliver bounded behavior" }),
      `${type}: M001 Deliver bounded behavior`,
    );
  }
  const scoped = { commit_prefixes: { M001: "feat(opportunities)" } };
  assert.equal(
    policy.taskCommitMessage(scoped, { id: "M001", title: "Deliver bounded behavior" }),
    "feat(opportunities): M001 Deliver bounded behavior",
  );
  assert.equal(policy.controllerCommitMessage(scoped, "record M001"), "chore(control-plane): record M001");
  assert.equal(policy.controllerCommitMessage(scoped, "complete project"), "chore(control-plane): complete project");
});

test("legacy fixed-prefix messages remain byte-compatible", () => {
  const git = { commit_prefix: "example-autopilot" };
  assert.equal(
    policy.taskCommitMessage(git, { id: "M001", title: "Deliver bounded behavior" }),
    "example-autopilot: M001 Deliver bounded behavior",
  );
  assert.equal(policy.controllerCommitMessage(git, "record M001"), "example-autopilot: record M001");
});

test("the largest accepted blueprint title still produces a bounded commit subject", () => {
  const title = "x".repeat(16 * 1024);
  const subject = policy.taskCommitMessage(
    { commit_prefixes: { M001: "feat(scope)" } },
    { id: "M001", title },
  );
  assert.ok(Buffer.byteLength(subject, "utf8") > 16 * 1024);
  assert.ok(Buffer.byteLength(subject, "utf8") <= 20 * 1024);
});

test("invalid, ambiguous, and incomplete prefix policies fail closed", () => {
  for (const prefix of [
    "Feature",
    "perf",
    "feat: injected",
    "feat (scope)",
    "feat(scope)!",
    "feat(UPPER)",
    "feat(scope)\nfix",
    "feat(scope with space)",
  ]) {
    assert.throws(
      () => policy.normalizeTaskCommitPrefixes({ M001: prefix }),
      /supported Conventional Commit prefix/i,
      prefix,
    );
  }
  assert.throws(
    () => policy.normalizeGitCommitConfig({ commit_prefix: "autopilot", commit_prefixes: { M001: "feat" } }),
    /exactly one/i,
  );
  assert.throws(
    () => policy.assertExactTaskPrefixCoverage({ M001: "feat" }, ["M001", "M002"]),
    /missing: M002/i,
  );
  assert.throws(
    () => policy.assertExactTaskPrefixCoverage({ M001: "feat", M999: "fix" }, ["M001"]),
    /unknown: M999/i,
  );
});
