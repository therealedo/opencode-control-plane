---
name: read-only-query
description: Answer conceptual, educational, status, or architecture questions without changing project or controller state. Use whenever the user requests analysis, explanation, or advice rather than implementation.
---

# Read-only analysis

1. Read only the minimum relevant files. Use `.project/manifest.json` to locate durable context; read `.autopilot/state.json` only when current execution status matters.
2. Use non-mutating inspection commands when evidence is needed.
3. Do not edit source, tests, generated files, `.project/**`, or `.autopilot/**`; do not create receipts, debt entries, gates, checkpoints, or commits.
4. Explain the answer, assumptions, tradeoffs, and any conflict with current constraints clearly. Offer an implementation path without executing it.

If the user changes the request to implementation, leave read-only mode and invoke the appropriate workflow skill before modifying anything.
