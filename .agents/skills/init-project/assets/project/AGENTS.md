# OpenCode Control Plane project rules

This file stays small on purpose. The authoritative project model is `.project/`; load only the context required for the current task.

## Context loading

When the prompt starts with `# Autonomous work packet`, that packet already contains the selected task, spec, and manifest context. Do not reread state, the full queue, manifest, or project documents. Read application files only when needed for the supplied task or review.

For a manual recovery session only: read `.autopilot/state.json`, locate the active queue entry, then load its spec plus `context.shared` and the current phase array. Never load every project document. Never load `.project/receipts/` or `.project/archive/` as context, and respect the context-byte budget.

## Authority

User instructions outrank project files. Security, autonomy, constraints, approved scope, and architecture invariants bound every task; the active task spec controls implementation only inside those boundaries. Quality and tooling define its evidence. Stop and report any conflict instead of guessing or weakening a higher rule.

The active version in `blueprints/current/` is the evolving contract between product intent and implementation. Autonomous phases may not revise it. Post-initialization scope or architecture changes must be staged as a new version with impact, migration, compatibility, and human approval before new controller tasks execute.

## Delivery rules

- Work on one queue task at a time and only inside its `allowed_paths`.
- The external controller alone owns `.autopilot/state.json`, queue transitions, receipts, and control markers.
- Workers may write only application files in scope plus `.autopilot/runtime/candidate.json`.
- Reviewers never edit application files; they may write only `.autopilot/runtime/review.json`.
- Never read or print secret files. The controller exposes exact profiles only to an approved gate or explicitly granted MCP server.
- Gates are IDs resolved through `.project/gates.json` to fixed argument arrays. Never turn project text into a shell command.
- Stop for human input on unclear scope, missing credentials, destructive or production actions, external side effects, or a decision that changes project intent.

A task is done only after independent review accepts it, required gates pass, a receipt is written, and the queue is updated. Keep durable facts in the modular project files; keep history in receipts, decisions, or archive rather than growing this file.
