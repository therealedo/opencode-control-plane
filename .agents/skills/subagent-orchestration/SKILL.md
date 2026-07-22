---
name: subagent-orchestration
description: Delegate a bounded implementation, investigation, or review task to subagents while preserving controller context and shared-worktree safety. Use for isolated work with explicit inputs and acceptance checks.
---

# Delegate bounded work

1. Build a packet containing task ID, attempt, phase, acceptance checks, `allowed_paths`, selected manifest bundles, bounded evidence, and the exact candidate or review schema.
2. Respect both context caps in `.autopilot/config.json` and `.project/manifest.json`. Do not send the whole repository, archive, unrelated architecture, or raw history.
3. Treat every subagent as operating in the same worktree. Inspect existing changes first; run parallel writers only on disjoint reserved paths. Otherwise serialize them. Do not plan a fictional merge or code-extraction step.
4. Keep phases in separate fresh invocations: `autopilot-worker` or `autopilot-recovery` may write only `.autopilot/runtime/candidate.json`; `autopilot-reviewer` may write only `.autopilot/runtime/review.json`.
5. Require workers to preserve unrelated edits; candidate `changed_files` must exactly match the actual Git task diff. No subagent may edit other control, queue, gate, debt, credential, or receipt files.
6. The external controller validates the contract, runs fixed gates, schedules the next fresh phase, writes receipts, and alone advances state.

The controller keeps raw logs in bounded `.autopilot/artifacts/`; subagents return only the evidence needed for controller decisions.
