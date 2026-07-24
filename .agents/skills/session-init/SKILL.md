---
name: session-init
description: Recover and resume the autonomous controller after a new session, compaction, interruption, or crash. Use automatically when an existing .autopilot/state.json is present.
---

# Recover controller state

1. Read `AGENTS.md`, `.project/manifest.json`, `.project/autonomy.md`, `.project/gates.json`, `.autopilot/config.json`, `.autopilot/state.json`, and `.autopilot/artifacts/checkpoint.md` when present.
2. Resolve `state.active_task` through `.project/plan/queue.json`, then read its milestone specification and only the context files it names. Do not preload all architecture, history, decisions, or receipts.
3. Inspect the shared worktree, `.autopilot/runtime/candidate.json`, `.autopilot/runtime/review.json`, `.autopilot/artifacts/`, and the latest task receipt. Reconcile interrupted evidence without changing controller state.
4. Perform only the controller-requested recovery action. Every recovery runs in a fresh session; never reuse or continue a prior session.
5. Return without work when a `STOP` or `PAUSED` marker exists or runtime status is `idle`, `paused`, `human_required`, `failed`, or `complete`.

If required state files are missing or invalid, return a bounded recovery failure to the controller and never guess state. Require human action only when durable state cannot be restored deterministically.
