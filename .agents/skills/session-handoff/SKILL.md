---
name: session-handoff
description: Create an automatic bounded recovery checkpoint before compaction, context exhaustion, interruption, or session replacement. Use as a controller fallback, not as a routine user-driven step.
---

# Checkpoint for automatic recovery

1. Stop dispatching new work and let the current atomic operation finish or record why it cannot.
2. Reconcile `.autopilot/state.json`, `.autopilot/runtime/candidate.json`, `.autopilot/runtime/review.json`, the active queue item, `.autopilot/artifacts/`, the latest receipt, and shared worktree.
3. Overwrite `.autopilot/artifacts/checkpoint.md` with only: active task and status, attempt, working set, last accepted evidence, dirty-file ownership, blocker, and exact next action.
4. Only the external controller may write the checkpoint or state. A worker returns this checkpoint payload without mutating either.
5. End cleanly without appending transcript history, relying on line numbers, or requiring user confirmation. `session-init` performs recovery automatically.

Keep the checkpoint bounded and replace-in-place; Git and `.project/receipts/` hold durable history.
