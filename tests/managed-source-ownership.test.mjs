import assert from "node:assert/strict"
import test from "node:test"

import { assertManagedPath } from "../.agents/skills/init-project/bin/lib/control-plane-files.mjs"

test("managed release ownership rejects cloud-sync conflict copies", () => {
  assert.throws(
    () => assertManagedPath(".autopilot/bin/lib/controller (# Edit conflict 2026-07-26 abc #).mjs"),
    /Unsafe or unclassified managed path/,
  )
  assert.throws(
    () => assertManagedPath(".autopilot/bin/lib/controller (conflicted copy).mjs"),
    /Unsafe or unclassified managed path/,
  )
  assert.equal(assertManagedPath(".autopilot/bin/lib/controller.mjs"), ".autopilot/bin/lib/controller.mjs")
})
