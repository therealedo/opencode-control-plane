import assert from "node:assert/strict";
import test from "node:test";

import {
  validatePhaseToolUsage,
  validateTaskToolUsage,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/contracts.mjs";

function usage() {
  return {
    schema_version: 1,
    phase: "execute",
    task_id: "M001",
    tool_calls: 1,
    returned_bytes: 12,
    by_tool: { lockfile: { calls: 1, returned_bytes: 12 } },
    controller_faults: [{
      operation: "dependency-lock",
      error_code: "DEPENDENCY_RUNNER_PROTOCOL_INVALID",
    }],
  };
}

test("one validator accepts typed controller faults in ephemeral and durable usage", () => {
  const value = usage();
  assert.deepEqual(validatePhaseToolUsage(value, {
    phase: "execute",
    taskId: "M001",
  }), []);
  assert.deepEqual(validateTaskToolUsage({ "execute:a1": value }, { taskId: "M001" }), []);
});

test("controller fault identities are bounded and machine coded", () => {
  const value = usage();
  value.controller_faults[0].error_code = "free form model prose";
  const issues = validatePhaseToolUsage(value, { phase: "execute", taskId: "M001" });
  assert.ok(issues.some((issue) => issue.location.endsWith("error_code")));
});
