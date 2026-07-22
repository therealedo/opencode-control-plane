---
name: autonomous-loop
description: Coordinate one bounded phase for the controller-selected task. Use when the external controller requests execution, recovery, or independent review for state.active_task.
---

# Run one bounded phase

The deterministic external controller is authoritative. Perform exactly one requested phase in a fresh primary OpenCode session; never recurse, delegate, poll, sleep, reuse a session, or run an internal loop.

1. Obey the controller-supplied phase, task ID, attempt, and budget. Read `.autopilot/state.json`, the active `.project/plan/queue.json` entry, its spec, and only context expanded through `.project/manifest.json`.
2. Return no-op when `.autopilot/STOP` or `.autopilot/PAUSED` exists; runtime status is `idle`, `paused`, `human_required`, `failed`, or `complete`; or task status is `pending`, `blocked`, or `done`.
3. Use only the role selected for this phase: `autopilot-worker`, `autopilot-reviewer`, or `autopilot-recovery`. Do not invoke another agent.
4. Execute/recovery writes only the exact candidate contract at `.autopilot/runtime/candidate.json`; review writes only the exact review contract at `.autopilot/runtime/review.json`.
5. Return one compact phase result. The controller validates contracts, runs gates, owns state/queue/receipts, and starts the next fresh session.

The Node controller owns orchestration and durable state. A phase role may write only its runtime contract plus in-scope application files for execute/recovery.
