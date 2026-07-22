---
name: scope-expansion
description: Plan and approve a deliberate product-scope, architecture, or capacity change. Use when a request changes the agreed outcome, boundaries, stack, or milestone graph rather than implementing an existing task.
---

# Evolve scope deliberately

1. Request a Control Plane maintenance boundary and confirm status shows no live controller. Reach a clean boundary with no active task, preserved diff, completion journal, or finalization journal before replanning.
2. Load and follow `evolve-project`. Use `blueprints/current/project-memory.json`, the current blueprint, and only affected durable files; never restart the full questionnaire.
3. Classify the delta as metadata (A), feature (B), or architecture (C). Generate targeted questions, compatibility impact, an exact generated-file comparison, migration tasks, risk, and rollback.
4. Obtain explicit human approval of the digest-bound migration plan before activation. Do not ask an autonomous worker to replan or edit `.autopilot/state.json`, runtime contracts, receipts, locks, or sentinels.
5. Activate through `evolve-blueprint.mjs apply`; never hand-edit generated control files. Commit the approved control-plane delta, validate strictly, provision new credentials, and only then resume.

A completed project may start a new blueprint version and queue while its prior final receipt remains immutable. Never delete or rewrite accepted evidence.

Do not hide ordinary implementation inside a scope amendment or expand scope merely to unblock a failing task.

